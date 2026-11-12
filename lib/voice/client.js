'use strict';

// lib/voice/client.js: talks to the speech worker (lib/voice/worker.js) over JSON lines.
// Spawns the worker on first use, sends one request at a time (the worker is synchronous), restarts it once if it
// dies mid-request, and kills it after idleMs without work so the models give their memory back.
// Never logs audio or text.

const { spawn } = require('child_process');

const TARGET_RATE = 16000;
const MAX_SECONDS = 120;                         // longest audio accepted (pages record up to 60 s)
const MIN_RATE = 8000, MAX_RATE = 192000;
const MAX_OUT_SAMPLES = TARGET_RATE * MAX_SECONDS;
const CHUNK_MAX_S = 28;                          // Whisper reads 30 s; longer audio is cut at pauses
const CHUNK_SEARCH_FROM_S = 20;
const CHUNK_FRAME = TARGET_RATE / 10;            // 100 ms
const MIN_TAIL_S = 0.3, MIN_TAIL_RMS = 1e-4;
const MAX_WAITING = 4;                           // queued requests besides the running one

function bad(message) { const e = new Error(message); e.badAudio = true; return e; }
function coded(message, code) { const e = new Error(message); e.code = code; return e; }

/** Parses a RIFF/WAVE buffer (16-bit PCM, mono or stereo, 8-192 kHz, up to 120 s; stereo is averaged) -> { samples: Float32Array, sampleRate }. */
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
  if (!fmt || !data) throw bad('WAV has no audio');
  if (fmt.format !== 1 || fmt.bits !== 16) throw bad('WAV must be 16-bit PCM');
  if (fmt.channels < 1 || fmt.channels > 2) throw bad('WAV must be mono or stereo');
  if (fmt.rate < MIN_RATE || fmt.rate > MAX_RATE) throw bad('WAV sample rate must be 8000 to 192000 Hz');
  const frames = Math.floor(data.length / (2 * fmt.channels));
  if (frames / fmt.rate > MAX_SECONDS) throw bad(`audio is longer than ${MAX_SECONDS} seconds`);
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
  if (!(n <= MAX_OUT_SAMPLES)) throw bad(`audio is longer than ${MAX_SECONDS} seconds`);
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

const rms = (a, from, to) => { let s = 0; for (let i = from; i < to; i++) s += a[i] * a[i]; return to > from ? Math.sqrt(s / (to - from)) : 0; };

/** Splits 16 kHz samples into pieces of at most 28 s, each cut at the quietest 100 ms window 20-28 s after the piece start. */
function splitForWhisper(pcm) {
  const max = CHUNK_MAX_S * TARGET_RATE;
  if (pcm.length <= max) return [pcm];
  const out = []; let start = 0;
  while (pcm.length - start > max) {
    let bestAt = -1, best = Infinity;
    for (let w = start + CHUNK_SEARCH_FROM_S * TARGET_RATE; w + CHUNK_FRAME <= start + max; w += CHUNK_FRAME) {
      const r = rms(pcm, w, w + CHUNK_FRAME);
      if (r < best) { best = r; bestAt = w; }
    }
    const cut = bestAt + CHUNK_FRAME / 2;
    out.push(pcm.subarray(start, cut)); start = cut;
  }
  const tail = pcm.subarray(start);
  if (tail.length >= MIN_TAIL_S * TARGET_RATE && rms(tail, 0, tail.length) >= MIN_TAIL_RMS) out.push(tail);
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
  let gen = 0;                   // bumped by stop(): requests made before it never run
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
    // One idempotent failure path for every way the child can break (exit, spawn error, EPIPE on stdin, stdout error);
    // events from a child that is no longer the current one are ignored.
    const fail = () => { if (child !== c) return; killChild(); onCrash(); };
    c.on('exit', fail);
    c.on('error', fail);
    if (c.stdin && typeof c.stdin.on === 'function') c.stdin.on('error', fail);
    if (typeof c.stdout.on === 'function') c.stdout.on('error', fail);
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
      if (r.attempts < 2 && !stopped && r.gen === gen) { r.attempts++; queue.unshift(r); }   // one restart, one retry of the request that was running
      else r.reject(new Error('voice engine crashed'));
    }
    pump();
  }

  function pump() {
    if (inflight) return;
    let r;
    for (;;) {
      r = queue.shift();
      if (!r) { armIdle(); return; }
      if (r.gen !== gen) { r.reject(coded('voice engine stopped', 'voice_off')); continue; }
      if (r.isCancelled && r.isCancelled()) { r.reject(coded('request cancelled', 'voice_cancelled')); continue; }
      break;
    }
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

  function request(msg, isCancelled) {
    if (stopped) return Promise.reject(coded('voice is off', 'voice_off'));
    if (isCancelled && isCancelled()) return Promise.reject(coded('request cancelled', 'voice_cancelled'));
    if (inflight && queue.length >= MAX_WAITING) return Promise.reject(coded('voice engine is busy', 'voice_busy'));
    return new Promise((resolve, reject) => { queue.push({ id: nextId++, msg, attempts: 1, resolve, reject, timer: null, gen, isCancelled: typeof isCancelled === 'function' ? isCancelled : null }); pump(); });
  }

  /** stt(wavBuffer | Float32Array, sampleRate?, { model, isCancelled }) -> { text, ms }. A WAV is parsed and resampled to 16 kHz here;
   *  audio over 28 s is sent in pieces cut at pauses (Whisper reads 30 s) and the texts are joined. */
  async function stt(input, rate, { model, isCancelled } = {}) {
    let samples, sr;
    if (Buffer.isBuffer(input)) {
      try { ({ samples, sampleRate: sr } = parseWav(input)); } catch (e) { e.badAudio = true; throw e; }
    } else if (input instanceof Float32Array) {
      samples = input; sr = Number(rate) || TARGET_RATE;
      if (sr < MIN_RATE || sr > MAX_RATE) throw bad('sample rate must be 8000 to 192000 Hz');
      if (samples.length / sr > MAX_SECONDS) throw bad(`audio is longer than ${MAX_SECONDS} seconds`);
    }
    else throw new Error('stt wants a WAV buffer or Float32Array samples');
    if (!samples.length) throw bad('no audio');
    const pcm = resample(samples, sr, TARGET_RATE);
    const model2 = model || (engine && engine.status && engine.status().stt.model) || undefined;
    const texts = []; let ms = 0;
    for (const part of splitForWhisper(pcm)) {
      const r = await request({ op: 'stt', pcmBase64: Buffer.from(part.buffer, part.byteOffset, part.byteLength).toString('base64'), sampleRate: TARGET_RATE, model: model2 }, isCancelled);
      texts.push(String(r.text == null ? '' : r.text).trim()); ms += Number(r.ms) || 0;
    }
    return { text: texts.join(' '), ms };
  }

  /** tts(text, voice, speed?) -> { wav: Buffer, sampleRate, ms } */
  async function tts(text, voice, speed, { isCancelled } = {}) {
    const r = await request({ op: 'tts', text: String(text || ''), voice, speed }, isCancelled);
    return { wav: Buffer.from(r.wavBase64, 'base64'), sampleRate: r.sampleRate, ms: r.ms };
  }

  function ping() { return request({ op: 'ping' }); }

  /** Kills the worker, fails whatever is waiting with code 'voice_off', and refuses new requests until resume(). */
  function stop() {
    stopped = true; gen++; clearIdle();
    const waiting = queue.splice(0);
    if (inflight) { clearTimeout(inflight.timer); waiting.push(inflight); inflight = null; }
    for (const r of waiting) r.reject(coded('voice engine stopped', 'voice_off'));
    killChild();
  }

  /** Lets requests run again after stop() (the enable route calls this). */
  function resume() { stopped = false; }

  return { stt, tts, ping, stop, resume, start: resume, _running: () => !!child };
}

module.exports = { createVoiceClient, parseWav, resample, splitForWhisper, TARGET_RATE, MAX_WAITING };
