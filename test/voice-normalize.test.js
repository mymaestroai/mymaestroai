'use strict';
// lib/voice/normalize.js on real voice recordings (test/fixtures/voice, Kokoro voices, Apache-2.0; 16-bit mono 24 kHz) and on
// synthetic buffers, plus the X-Voice-Normalized header on the local tts route.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { normalizeSpeech, speechLevelDb } = require('../lib/voice/normalize');
const { wavFromFloat32 } = require('../lib/voice/worker');
const routes = require('../lib/voice/routes');
const manifest = require('../lib/voice/manifest');

const CEIL = Math.pow(10, -1 / 20);
const FIX = path.join(__dirname, 'fixtures', 'voice');
const FILES = ['af_heart-0.wav', 'am_michael-1.wav', 'bf_emma-2.wav'];

function readWav(file) {
  const b = fs.readFileSync(file);
  let p = 12, rate = 0, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') { assert.strictEqual(b.readUInt16LE(p + 8), 1); assert.strictEqual(b.readUInt16LE(p + 10), 1); assert.strictEqual(b.readUInt16LE(p + 22), 16); rate = b.readUInt32LE(p + 12); }
    if (id === 'data') { data = b.subarray(p + 8, p + 8 + Math.min(size, b.length - p - 8)); break; }
    p += 8 + size + (size & 1);
  }
  const s = new Float32Array(data.length >> 1);
  for (let i = 0; i < s.length; i++) s[i] = data.readInt16LE(i * 2) / 32768;
  return { samples: s, sampleRate: rate };
}
const peakDb = (s) => { let m = 0; for (const v of s) m = Math.max(m, Math.abs(v)); return 20 * Math.log10(m); };
const maxAbs = (s) => { let m = 0; for (const v of s) m = Math.max(m, Math.abs(v)); return m; };

for (const f of FILES) {
  test(`real voice ${f}: speech at -16 dBFS (±0.5), peak under -1 dBFS, barely any limiting, even after 16-bit encoding`, () => {
    const { samples, sampleRate } = readWav(path.join(FIX, f));
    const before = speechLevelDb(samples, sampleRate);
    assert.ok(before < -20, `fixture is quiet (${before})`);
    const r = normalizeSpeech(samples, sampleRate);
    assert.strictEqual(r.normalized, true);
    const after = speechLevelDb(r.samples, sampleRate);
    assert.ok(Math.abs(after - -16) <= 0.5, `speech ${after}`);
    assert.ok(maxAbs(r.samples) <= CEIL, 'float peak');
    // `needed` = samples that would have passed the ceiling; `touched` (spec: limiter gain < 0.9999) includes the 50 ms release tails
    assert.ok(r.needed / samples.length < 0.0025, `needed ${r.needed / samples.length}`);
    assert.ok(r.touched / samples.length < 0.5, `touched ${r.touched / samples.length}`);
    assert.strictEqual(r.clamped, 0);
    const wav = wavFromFloat32(r.samples, sampleRate);
    const back = (() => { const s = new Float32Array((wav.length - 44) >> 1); for (let i = 0; i < s.length; i++) s[i] = wav.readInt16LE(44 + i * 2) / 32768; return s; })();
    assert.ok(maxAbs(back) <= CEIL + 1 / 32768, `encoded peak ${peakDb(back)}`);
    assert.ok(peakDb(back) <= -0.99, 'encoded peak at or under -1 dBFS (within one 16-bit step)');
  });
}

test('silence (all zeros) and -60 dBFS noise come back unchanged with gainDb 0', () => {
  const z = new Float32Array(24000);
  let r = normalizeSpeech(z, 24000);
  assert.strictEqual(r.gainDb, 0); assert.strictEqual(r.speechDb, null); assert.strictEqual(r.touched, 0); assert.ok(r.samples.every(v => v === 0));
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const noise = new Float32Array(24000).map(() => rnd() * 0.001 * Math.sqrt(3));   // RMS 0.001 = -60 dBFS
  r = normalizeSpeech(noise, 24000);
  assert.strictEqual(r.gainDb, 0); assert.strictEqual(r.normalized, true);
  assert.deepStrictEqual(Array.from(r.samples), Array.from(noise));
});

test('digital zeros inside speech stay exactly zero', () => {
  const { samples, sampleRate } = readWav(path.join(FIX, FILES[0]));
  const s = Float32Array.from(samples);
  for (let i = 5000; i < 5600; i++) s[i] = 0;
  const r = normalizeSpeech(s, sampleRate);
  for (let i = 5000; i < 5600; i++) assert.strictEqual(r.samples[i], 0);
});

test('an empty array works and is returned unchanged', () => {
  const r = normalizeSpeech(new Float32Array(0), 24000);
  assert.strictEqual(r.samples.length, 0); assert.strictEqual(r.gainDb, 0); assert.strictEqual(r.normalized, true);
});

test('NaN and Infinity input samples become 0', () => {
  const s = new Float32Array(24000); for (let i = 0; i < s.length; i++) s[i] = 0.05 * Math.sin(i / 10);
  s[100] = NaN; s[101] = Infinity; s[102] = -Infinity;
  const r = normalizeSpeech(s, 24000);
  assert.strictEqual(r.samples[100], 0); assert.strictEqual(r.samples[101], 0); assert.strictEqual(r.samples[102], 0);
  assert.ok(r.samples.every(Number.isFinite));
});

test('a loud sine (peak 0.99, RMS -3 dBFS) is turned down toward -16 and never passes the ceiling', () => {
  const s = new Float32Array(48000); for (let i = 0; i < s.length; i++) s[i] = 0.99 * Math.sin(2 * Math.PI * 220 * i / 24000);
  const r = normalizeSpeech(s, 24000);
  assert.ok(r.gainDb < -10, `gain ${r.gainDb}`);
  const after = speechLevelDb(r.samples, 24000);
  assert.ok(Math.abs(after - -16) <= 0.5, `speech ${after}`);
  assert.ok(maxAbs(r.samples) <= CEIL);
});

test('one isolated full-scale spike in quiet speech keeps the ceiling and leaves the rest near the target', () => {
  const { samples, sampleRate } = readWav(path.join(FIX, FILES[1]));
  const s = Float32Array.from(samples); s[20000] = 1; s[20001] = -1;
  const r = normalizeSpeech(s, sampleRate);
  assert.ok(maxAbs(r.samples) <= CEIL, `peak ${peakDb(r.samples)}`);
  assert.strictEqual(r.clamped, 0);
  assert.ok(r.needed / s.length < 0.002, `needed ${r.needed / s.length}`);
});

// ── route header ──
function fakeRes() {
  const chunks = [];
  const r = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  r.writeHead = (code, headers) => { r.statusCode = code; r.headers = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v])); r.headersSent = true; };
  r.finished = new Promise((resolve) => r.on('finish', resolve));
  return r;
}
function ttsRoute({ normalized, cloud = false }) {
  const agent = cloud ? { name: 'maestro', voice: { voice: '', stt: 'local', tts: 'openai', cloudVoice: 'nova' } } : { name: 'maestro' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-norm-'));
  const engine = { paths: { web: dir, dir, worker: path.join(dir, 'w.js') }, status: () => ({ ready: true, platformSupported: true, voices: manifest.VOICES.map(v => ({ id: v.id, engine: v.engine })), tts: { engine: 'local', defaultVoice: 'af_heart' }, stt: { engine: 'local' } }) };
  const client = { tts: async () => ({ wav: Buffer.from('RIFF....WAVE'), sampleRate: 24000, ms: 5, ...(normalized === undefined ? {} : { normalized }) }) };
  const deps = {
    jsonResponse: (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); },
    readBody: (req) => new Promise((resolve) => { let s = ''; req.on('data', c => { s += c; }); req.on('end', () => resolve(s)); }),
    getSetting: (k, d) => (k === 'voice' ? { enabled: true, defaultVoice: '', sttModel: '' } : d),
    updateSettings: () => {}, getAgents: async () => [agent], getVoice: () => ({ engine, client }),
    cloud: { keys: () => ({ openai: true }), tts: async () => ({ wav: Buffer.from('RIFF....WAVE'), ms: 5, engine: 'openai' }) },
  };
  const req = Readable.from([Buffer.from(JSON.stringify({ agent: 'maestro', text: 'Hello there.' }))]);
  Object.assign(req, { method: 'POST', url: '/api/voice/tts', headers: { 'content-type': 'application/json' }, hubUser: { id: 'u', role: 'admin', name: 'O' }, hubService: false });
  return (async () => { const res = fakeRes(); await routes.handle('/api/voice/tts', req, res, deps); if (!res.writableEnded) await new Promise(r => setTimeout(r, 5)); await res.finished; fs.rmSync(dir, { recursive: true, force: true }); return res; })();
}
test('local tts response carries X-Voice-Normalized: 1 when the worker normalised it', async () => {
  const r = await ttsRoute({ normalized: true });
  assert.strictEqual(r.statusCode, 200); assert.strictEqual(r.headers['x-voice-engine'], 'local'); assert.strictEqual(r.headers['x-voice-normalized'], '1');
});
test('local tts response has no X-Voice-Normalized when normalized is false or missing', async () => {
  assert.strictEqual((await ttsRoute({ normalized: false })).headers['x-voice-normalized'], undefined);
  const r = await ttsRoute({}); assert.strictEqual(r.statusCode, 200); assert.strictEqual(r.headers['x-voice-normalized'], undefined);
});
test('a cloud tts response never carries X-Voice-Normalized', async () => {
  const r = await ttsRoute({ normalized: true, cloud: true });
  assert.strictEqual(r.statusCode, 200); assert.strictEqual(r.headers['x-voice-engine'], 'openai'); assert.strictEqual(r.headers['x-voice-normalized'], undefined);
});
