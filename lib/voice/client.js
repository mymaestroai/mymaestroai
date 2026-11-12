'use strict';

// lib/voice/client.js: talks to the speech worker (lib/voice/worker.js) over JSON lines.
// Spawns the worker on first use, sends one request at a time (the worker is synchronous), restarts it once if it
// dies mid-request, and kills it after idleMs without work so the models give their memory back.
// Never logs audio or text.

const { spawn } = require('child_process');

const TARGET_RATE = 16000;

/** Parses a RIFF/WAVE buffer (16-bit PCM, any rate; several channels are averaged) -> { samples: Float32Array, sampleRate }. */
function parseWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const start = off + 8;
    if (start + size > buf.length) size = buf.length - start;   // streamed files carry 0 or 0xFFFFFFFF; take what is there
    if (id === 'fmt ' && size >= 16) fmt = { format: buf.readUInt16LE(start), channels: buf.readUInt16LE(start + 2), rate: buf.readUInt32LE(start + 4), bits: buf.readUInt16LE(start + 14) };
    else if (id === 'data') { data = buf.subarray(start, start + size); break; }
    off = start + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV has no audio');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('WAV must be 16-bit PCM');
  if (!fmt.channels || !fmt.rate) throw new Error('bad WAV header');
  const frames = Math.floor(data.length / (2 * fmt.channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < fmt.channels; c++) s += data.readInt16LE((i * fmt.channels + c) * 2);
    samples[i] = s / fmt.channels / 32768;
  }
  return { samples, sampleRate: fmt.rate };
}

/** Resamples mono float samples (linear interpolation; averaged over the window when going down, to limit aliasing). */
function resample(samples, from, to) {
  if (from === to || !samples.length) return samples;
  const ratio = from / to;
  const n = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    if (ratio > 1) {
      const a = Math.floor(pos), b = Math.min(samples.length, Math.max(a + 1, Math.ceil(pos + ratio)));
      let s = 0; for (let k = a; k < b; k++) s += samples[k];
      out[i] = s / (b - a);
    } else {
      const a = Math.floor(pos), f = pos - a, b = Math.min(samples.length - 1, a + 1);
      out[i] = samples[a] * (1 - f) + samples[b] * f;
    }
  }
  return out;
}

function createVoiceClient({ engine, spawnImpl, idleMs = 600000, timeoutMs = 120000 } = {}) {
  const spawnWorker = spawnImpl || ((file, args) => spawn(process.execPath, [file, ...args], { stdio: ['pipe', 'pipe', 'ignore'] }));
  let child = null;
  let nextId = 1;
  let inflight = null;           // { id, msg, attempts, resolve, reject, timer }
  const queue = [];
  let idleTimer = null;
  let stopped = false;
  let buf = '';

  function clearIdle() { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } }
  function armIdle() {
    clearIdle();
    if (!idleMs || inflight || queue.length) return;
    idleTimer = setTimeout(() => { idleTimer = null; killChild(); }, idleMs);
    if (idleTimer.unref) idleTimer.unref();
  }
  function killChild() {
    const c = child; child = null; buf = '';
    if (c) { c.removeAllListeners && c.removeAllListeners('exit'); try { c.kill(); } catch {} }
  }

  function ensureChild() {
    if (child) return child;
    const c = spawnWorker(engine.paths.worker, [engine.paths.dir]);
    child = c; buf = '';
    c.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }   // native library chatter is not ours
        onMessage(m);
      }
    });
    c.on('exit', () => { if (child === c) { child = null; buf = ''; onCrash(); } });
    c.on('error', () => { if (child === c) { child = null; buf = ''; onCrash(); } });
    return c;
  }

  function onMessage(m) {
    if (!inflight || m.id !== inflight.id) return;
    const r = inflight; inflight = null; clearTimeout(r.timer);
    if (m.ok) r.resolve(m); else r.reject(new Error(m.error || 'voice engine error'));
    pump();
  }

  function onCrash() {
    const r = inflight; inflight = null;
    if (r) {
      clearTimeout(r.timer);
      if (r.attempts < 2 && !stopped) { r.attempts++; queue.unshift(r); }   // one restart, one retry of the request that was running
      else r.reject(new Error('voice engine crashed'));
    }
    pump();
  }

  function pump() {
    if (inflight) return;
    const r = queue.shift();
    if (!r) { armIdle(); return; }
    clearIdle();
    inflight = r;
    try {
      const c = ensureChild();
      r.timer = setTimeout(() => { if (inflight === r) { inflight = null; r.reject(new Error('voice engine timed out')); killChild(); pump(); } }, timeoutMs);
      c.stdin.write(JSON.stringify({ ...r.msg, id: r.id }) + '\n');
    } catch (e) {
      inflight = null; clearTimeout(r.timer);
      r.reject(new Error(`voice engine could not start: ${e.message}`));
      killChild(); pump();
    }
  }

  function request(msg) {
    if (stopped) stopped = false;
    return new Promise((resolve, reject) => { queue.push({ id: nextId++, msg, attempts: 1, resolve, reject, timer: null }); pump(); });
  }

  /** stt(wavBuffer | Float32Array, sampleRate?) -> { text, ms }. A WAV is parsed and resampled to 16 kHz here. */
  async function stt(input, rate, { model } = {}) {
    let samples, sr;
    if (Buffer.isBuffer(input)) {
      try { ({ samples, sampleRate: sr } = parseWav(input)); } catch (e) { e.badAudio = true; throw e; }
    } else if (input instanceof Float32Array) { samples = input; sr = Number(rate) || TARGET_RATE; }
    else throw new Error('stt wants a WAV buffer or Float32Array samples');
    if (!samples.length) { const e = new Error('no audio'); e.badAudio = true; throw e; }
    const pcm = resample(samples, sr, TARGET_RATE);
    const model2 = model || (engine && engine.status && engine.status().stt.model) || undefined;
    const r = await request({ op: 'stt', pcmBase64: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64'), sampleRate: TARGET_RATE, model: model2 });
    return { text: r.text, ms: r.ms };
  }

  /** tts(text, voice, speed?) -> { wav: Buffer, sampleRate, ms } */
  async function tts(text, voice, speed) {
    const r = await request({ op: 'tts', text: String(text || ''), voice, speed });
    return { wav: Buffer.from(r.wavBase64, 'base64'), sampleRate: r.sampleRate, ms: r.ms };
  }

  function ping() { return request({ op: 'ping' }); }

  /** Kills the worker and fails whatever is waiting. */
  function stop() {
    stopped = true; clearIdle();
    const waiting = queue.splice(0);
    if (inflight) { clearTimeout(inflight.timer); waiting.push(inflight); inflight = null; }
    for (const r of waiting) r.reject(new Error('voice engine stopped'));
    killChild();
  }

  return { stt, tts, ping, stop, _running: () => !!child };
}

module.exports = { createVoiceClient, parseWav, resample, TARGET_RATE };
