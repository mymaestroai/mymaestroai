'use strict';
// lib/voice/client.js with a fake worker (no engine, no download): ids, queueing, crash restart once, idle kill,
// WAV parsing and resampling; plus the worker's own message handler with a fake sherpa.
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createVoiceClient, parseWav, resample } = require('../lib/voice/client');
const { createWorker, wavFromFloat32 } = require('../lib/voice/worker');

const engine = { paths: { worker: '/x/worker.js', dir: '/x/dir' }, status: () => ({ stt: { model: 'tiny.en' } }) };

/** A fake child process. onLine(line, child, n) decides what the "worker" answers; n = how many children were spawned so far. */
function fakeSpawner(onLine) {
  const children = [];
  const spawnImpl = (file, args) => {
    const c = new EventEmitter();
    c.file = file; c.args = args; c.killed = false; c.lines = [];
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    c.stdin = { write: (s) => { for (const l of s.split('\n').filter(Boolean)) { const m = JSON.parse(l); c.lines.push(m); setImmediate(() => onLine(m, c, children.length)); } } };
    c.reply = (obj) => c.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));
    c.kill = () => { c.killed = true; };
    c.crash = () => c.emit('exit', 1, null);
    children.push(c);
    return c;
  };
  spawnImpl.children = children;
  return spawnImpl;
}

function wav16(samples, rate, channels = 1) {
  const n = samples.length; const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2 * channels, 28); b.writeUInt16LE(2 * channels, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  samples.forEach((s, i) => b.writeInt16LE(s, 44 + i * 2));
  return b;
}

test('requests carry ids and get their own answers; the worker is spawned on first use with the dir', async () => {
  const sp = fakeSpawner((m, c) => c.reply(m.op === 'stt' ? { id: m.id, ok: true, text: 'hello there', ms: 12 } : { id: m.id, ok: true, wavBase64: Buffer.from('RIFFxxxx').toString('base64'), sampleRate: 24000, ms: 30 }));
  const cl = createVoiceClient({ engine, spawnImpl: sp, idleMs: 0 });
  assert.strictEqual(sp.children.length, 0, 'nothing spawned before use');
  const wav = wav16([0, 1000, -1000, 500], 16000);
  const r = await cl.stt(wav);
  assert.deepStrictEqual(r, { text: 'hello there', ms: 12 });
  assert.deepStrictEqual([sp.children[0].file, sp.children[0].args], ['/x/worker.js', ['/x/dir']]);
  const sent = sp.children[0].lines[0];
  assert.strictEqual(sent.op, 'stt'); assert.strictEqual(sent.sampleRate, 16000); assert.strictEqual(sent.model, 'tiny.en');
  assert.strictEqual(Buffer.from(sent.pcmBase64, 'base64').length, 4 * 4, 'float32 samples');
  const t = await cl.tts('Hi there.', 'af_heart', 1.1);
  assert.strictEqual(t.sampleRate, 24000); assert.strictEqual(t.ms, 30); assert.ok(Buffer.isBuffer(t.wav));
  assert.deepStrictEqual(sp.children[0].lines[1], { op: 'tts', text: 'Hi there.', voice: 'af_heart', speed: 1.1, id: sp.children[0].lines[1].id });
  assert.notStrictEqual(sent.id, sp.children[0].lines[1].id);
  assert.strictEqual(sp.children.length, 1, 'one worker serves both');
  cl.stop();
});

test('queueing: one request at a time, answered in order even when the worker answers out of habit slowly', async () => {
  const order = [];
  const sp = fakeSpawner((m, c) => { order.push(m.text); setTimeout(() => c.reply({ id: m.id, ok: true, wavBase64: '', sampleRate: 1, ms: 1 }), 15); });
  const cl = createVoiceClient({ engine, spawnImpl: sp, idleMs: 0 });
  const ps = ['a', 'b', 'c'].map(t => cl.tts(t, 'af_heart'));
  await new Promise(r => setTimeout(r, 5));
  assert.strictEqual(sp.children[0].lines.length, 1, 'the others wait their turn');
  await Promise.all(ps);
  assert.deepStrictEqual(order, ['a', 'b', 'c']);
  cl.stop();
});

test('an error answer rejects that request only; chatter lines from the native library are ignored', async () => {
  const sp = fakeSpawner((m, c) => {
    c.stdout.emit('data', Buffer.from('some native log line\n'));
    c.reply(m.text === 'bad' ? { id: m.id, ok: false, error: 'unknown voice' } : { id: m.id, ok: true, wavBase64: '', sampleRate: 1, ms: 1 });
  });
  const cl = createVoiceClient({ engine, spawnImpl: sp, idleMs: 0 });
  await assert.rejects(() => cl.tts('bad', 'x'), /unknown voice/);
  await cl.tts('fine', 'af_heart');
  cl.stop();
});

test('a crash restarts the worker once and retries the request; a second crash rejects', async () => {
  const sp = fakeSpawner((m, c, n) => { if (n === 1) return c.crash(); c.reply({ id: m.id, ok: true, text: 'second life', ms: 3 }); });
  const cl = createVoiceClient({ engine, spawnImpl: sp, idleMs: 0 });
  const r = await cl.stt(wav16([1, 2, 3], 16000));
  assert.strictEqual(r.text, 'second life'); assert.strictEqual(sp.children.length, 2);

  const always = fakeSpawner((m, c) => c.crash());
  const cl2 = createVoiceClient({ engine, spawnImpl: always, idleMs: 0 });
  await assert.rejects(() => cl2.tts('x', 'af_heart'), /crashed/);
  assert.strictEqual(always.children.length, 2, 'one restart, no loop');
  // the client is still usable afterwards
  const ok = fakeSpawner((m, c) => c.reply({ id: m.id, ok: true, wavBase64: '', sampleRate: 1, ms: 1 }));
  const cl3 = createVoiceClient({ engine, spawnImpl: ok, idleMs: 0 });
  await cl3.tts('x', 'af_heart');
  cl.stop(); cl2.stop(); cl3.stop();
});

test('idle: the worker is killed after idleMs without work and started again on the next request', async () => {
  const sp = fakeSpawner((m, c) => c.reply({ id: m.id, ok: true, text: 't', ms: 1 }));
  const cl = createVoiceClient({ engine, spawnImpl: sp, idleMs: 40 });
  await cl.stt(wav16([1, 2], 16000));
  assert.strictEqual(sp.children[0].killed, false);
  await new Promise(r => setTimeout(r, 90));
  assert.strictEqual(sp.children[0].killed, true, 'killed when idle');
  assert.strictEqual(cl._running(), false);
  await cl.stt(wav16([1, 2], 16000));
  assert.strictEqual(sp.children.length, 2, 'a fresh worker');
  // work in flight keeps it alive
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(sp.children[1].killed, false);
  cl.stop();
  assert.strictEqual(sp.children[1].killed, true);
});

test('stop() rejects what is waiting; the client works again after it', async () => {
  const sp = fakeSpawner(() => {});   // never answers
  const cl = createVoiceClient({ engine, spawnImpl: sp, idleMs: 0 });
  const p = cl.tts('x', 'af_heart'); const q = cl.tts('y', 'af_heart');
  await new Promise(r => setTimeout(r, 5));
  cl.stop();
  await assert.rejects(p, /stopped/); await assert.rejects(q, /stopped/);
  assert.strictEqual(sp.children[0].killed, true);
});

test('a request that gets no answer times out and kills the worker', async () => {
  const sp = fakeSpawner(() => {});
  const cl = createVoiceClient({ engine, spawnImpl: sp, idleMs: 0, timeoutMs: 30 });
  await assert.rejects(() => cl.tts('x', 'af_heart'), /timed out/);
  assert.strictEqual(sp.children[0].killed, true);
});

test('parseWav: 16-bit PCM mono, stereo averaged, odd chunks skipped, bad input refused', () => {
  const w = parseWav(wav16([0, 16384, -16384, 32767], 22050));
  assert.strictEqual(w.sampleRate, 22050); assert.strictEqual(w.samples.length, 4);
  assert.ok(Math.abs(w.samples[1] - 0.5) < 1e-6); assert.ok(Math.abs(w.samples[2] + 0.5) < 1e-6);
  const st = parseWav(wav16([1000, 3000, -2000, -4000], 8000, 2));   // two frames: (1000+3000)/2, (-2000-4000)/2
  assert.strictEqual(st.samples.length, 2); assert.ok(Math.abs(st.samples[0] - 2000 / 32768) < 1e-6); assert.ok(Math.abs(st.samples[1] + 3000 / 32768) < 1e-6);
  // a LIST chunk before data, and a data size that claims more than is there (streamed files)
  const base = wav16([100, 200, 300], 16000);
  const list = Buffer.concat([base.subarray(0, 36), Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('abcd'), base.subarray(36)]);
  list.writeUInt32LE(0xffffffff, 36 + 12 + 4);
  assert.strictEqual(parseWav(list).samples.length, 3);
  assert.throws(() => parseWav(Buffer.from('hello, this is not a wav file at all, nope nope nope')), /not a WAV/);
  const f32 = wav16([1, 2], 16000); f32.writeUInt16LE(3, 20);
  assert.throws(() => parseWav(f32), /16-bit PCM/);
  assert.throws(() => parseWav(Buffer.alloc(10)), /not a WAV/);
});

test('resample: 48 kHz and 44.1 kHz down to 16 kHz keep length and level; same rate is untouched; up-sampling interpolates', () => {
  const sine = (rate, secs, hz) => Float32Array.from({ length: Math.round(rate * secs) }, (_, i) => 0.5 * Math.sin(2 * Math.PI * hz * i / rate));
  for (const rate of [48000, 44100, 22050]) {
    const out = resample(sine(rate, 1, 440), rate, 16000);
    assert.ok(Math.abs(out.length - 16000) <= 1, `${rate}: ${out.length}`);
    const peak = Math.max(...out.map(Math.abs)); assert.ok(peak > 0.4 && peak <= 0.51, `${rate}: peak ${peak}`);
  }
  const same = sine(16000, 0.1, 300); assert.strictEqual(resample(same, 16000, 16000), same);
  const up = resample(Float32Array.from([0, 1]), 8000, 16000); assert.strictEqual(up.length, 4); assert.ok(Math.abs(up[1] - 0.5) < 1e-6);
  assert.strictEqual(resample(new Float32Array(0), 8000, 16000).length, 0);
});

test('stt resamples a 48 kHz WAV to 16 kHz before sending, and accepts raw Float32Array samples with a rate', async () => {
  const sent = [];
  const sp = fakeSpawner((m, c) => { sent.push(m); c.reply({ id: m.id, ok: true, text: 'ok', ms: 1 }); });
  const cl = createVoiceClient({ engine, spawnImpl: sp, idleMs: 0 });
  const wav = wav16(Array.from({ length: 4800 }, (_, i) => Math.round(8000 * Math.sin(i / 10))), 48000);
  await cl.stt(wav);
  assert.strictEqual(sent[0].sampleRate, 16000); assert.strictEqual(Buffer.from(sent[0].pcmBase64, 'base64').length / 4, 1600);
  await cl.stt(new Float32Array(8000).fill(0.1), 8000);
  assert.strictEqual(Buffer.from(sent[1].pcmBase64, 'base64').length / 4, 16000);
  await assert.rejects(() => cl.stt(Buffer.from('nope nope nope nope nope nope nope nope nope nope nope nope')), (e) => e.badAudio === true);
  await assert.rejects(() => cl.stt('string'), /WAV buffer/);
  cl.stop();
});

// ── the worker's message handler (fake sherpa, no models) ──
function fakeSherpa(log) {
  class OfflineRecognizer { constructor(cfg) { log.push(['rec', cfg.modelConfig.whisper.encoder, cfg.modelConfig.numThreads]); }
    createStream() { return { acceptWaveform: (a) => { log.push(['wave', a.samples.length, a.sampleRate]); } }; }
    decode() {} getResult() { return { text: '  hello world  ' }; } }
  class OfflineTts { constructor(cfg) { this.cfg = cfg; log.push(['tts', Object.keys(cfg.model)[0], cfg.model.kokoro && path.basename(cfg.model.kokoro.lexicon)]); }
    generate({ text, sid, speed }) { log.push(['gen', text, sid, speed]); return { samples: new Float32Array([0, 0.5, -0.5]), sampleRate: 24000 }; } }
  return { OfflineRecognizer, OfflineTts };
}

test('worker protocol: ping, stt, tts (Kokoro accent switch loads the other lexicon, Piper), unknown op and bad voice give ok:false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-worker-'));
  try {
    for (const m of ['whisper-tiny.en', 'kokoro-multi-lang-v1_0', 'piper-en_GB-alba-medium']) fs.mkdirSync(path.join(dir, 'models', m), { recursive: true });
    const log = []; const out = [];
    const w = createWorker(dir, { sherpa: fakeSherpa(log), write: (l) => out.push(JSON.parse(l)) });
    w.handle(JSON.stringify({ id: 1, op: 'ping' }));
    const pcm = Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer).toString('base64');
    w.handle(JSON.stringify({ id: 2, op: 'stt', pcmBase64: pcm, sampleRate: 16000, model: 'tiny.en' }));
    w.handle(JSON.stringify({ id: 3, op: 'tts', text: 'Hello.', voice: 'af_heart', speed: 1 }));
    w.handle(JSON.stringify({ id: 4, op: 'tts', text: 'Hello.', voice: 'bm_george', speed: 1 }));
    w.handle(JSON.stringify({ id: 5, op: 'tts', text: 'Hello.', voice: 'alba', speed: 1.2 }));
    w.handle(JSON.stringify({ id: 6, op: 'tts', text: 'Hello.', voice: 'nobody' }));
    w.handle(JSON.stringify({ id: 7, op: 'stt', pcmBase64: pcm, model: 'small.en' }));
    w.handle(JSON.stringify({ id: 8, op: 'fly' }));
    w.handle('not json');
    assert.deepStrictEqual(out.map(o => [o.id, o.ok]), [[1, true], [2, true], [3, true], [4, true], [5, true], [6, false], [7, false], [8, false]]);
    assert.strictEqual(out[1].text, 'hello world'); assert.ok(out[1].ms >= 0);
    const wav = Buffer.from(out[2].wavBase64, 'base64'); assert.strictEqual(out[2].sampleRate, 24000);
    assert.strictEqual(wav.toString('latin1', 0, 4), 'RIFF'); assert.strictEqual(parseWav(wav).samples.length, 3);
    assert.deepStrictEqual(log.filter(l => l[0] === 'tts').map(l => [l[1], l[2]]), [['kokoro', 'lexicon-us-en.txt'], ['kokoro', 'lexicon-gb-en.txt'], ['vits', undefined]]);
    assert.deepStrictEqual(log.find(l => l[0] === 'gen' && l[2] === 26), ['gen', 'Hello.', 26, 1], 'bm_george = speaker 26');
    assert.match(out[6].error, /not installed/);
    assert.ok(!JSON.stringify(out).includes('hello world') || out[1].text === 'hello world');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.strictEqual(wavFromFloat32(new Float32Array([1, -1]), 8000).length, 48);
});
