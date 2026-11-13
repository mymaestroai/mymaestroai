'use strict';
// Voice phase 3 (server): the cloud speech engines (lib/voice/cloud.js), their use by /api/voice/stt and /tts with the free
// local engine as the fallback, the ledger rows, and the privacy rule for agents kept on this computer. Every network call is a
// fake fetch and every key is a fake ('sk-test...'): nothing here reaches a real service.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { Readable, Writable } = require('node:stream');
const cloudMod = require('../lib/voice/cloud');
const routes = require('../lib/voice/routes');
const manifest = require('../lib/voice/manifest');

const KEYS = { openai: 'sk-test-openai-KEY1', google: 'sk-test-google-KEY2', elevenlabs: 'sk-test-eleven-KEY3' };
const ELEVEN_ID = 'abcDEF1234567890xyz';
const wav16 = (seconds = 1.5) => cloudMod.wavFromPcm16(Buffer.alloc(Math.round(16000 * 2 * seconds), 1), 16000);
const pcm24 = (n = 4800) => Buffer.alloc(n * 2, 3);   // 0.2 s of 24 kHz PCM

// A fake fetch: records every call and answers with a real Response built from whatever `respond(url, init)` returns
// ({status, json | bytes | badJson | body (a ReadableStream), headers}) or throws.
function fakeFetch(respond) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = await respond(String(url), init);
    const status = r.status || 200;
    let body;
    if (r.body) body = r.body;
    else if (r.badJson) body = '{not json';
    else if (r.json !== undefined) body = JSON.stringify(r.json);
    else body = r.bytes || Buffer.alloc(0);
    return new Response(status === 204 ? null : body, { status, headers: r.headers || {} });
  };
  fn.calls = calls;
  return fn;
}
function makeCloud({ respond, keys = KEYS, rows = [], openaiUrl = 'http://fake-openai.test/v1', throwLedger = false, timeoutMs } = {}) {
  const fetchImpl = fakeFetch(respond || (() => ({ status: 500, json: {} })));
  const ledger = { record: (r) => { if (throwLedger) throw new Error('db down'); rows.push(r); } };
  let t = 1000;
  const cloud = cloudMod.createCloudVoice({ fetchImpl, getProviderKey: (p) => keys[p] || '', getProviderUrl: (p) => (p === 'openai' ? openaiUrl : ''), getLedger: () => ledger,
    now: () => (t += 25), ...(timeoutMs ? { timeoutMs } : {}), bases: { google: 'http://fake-google.test/v1beta', elevenlabs: 'http://fake-eleven.test/v1' } });
  return { cloud, fetchImpl, rows };
}
const geminiText = (text) => ({ candidates: [{ content: { parts: [{ text }] } }] });
const geminiAudio = (pcm, rate = 24000) => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: `audio/L16;codec=pcm;rate=${rate}`, data: pcm.toString('base64') } }] } }] });

// ── the tables and the WAV wrapper ──
test('cloud tables: models, voices and defaults are in one place at the top of cloud.js', () => {
  assert.strictEqual(cloudMod.MODELS.openai.stt, 'gpt-4o-mini-transcribe');
  assert.strictEqual(cloudMod.MODELS.openai.tts, 'gpt-4o-mini-tts');
  assert.strictEqual(cloudMod.MODELS.google.stt, 'gemini-2.5-flash');
  assert.strictEqual(cloudMod.MODELS.google.tts, 'gemini-2.5-flash-preview-tts');
  assert.strictEqual(cloudMod.MODELS.elevenlabs.tts, 'eleven_flash_v2_5');
  assert.deepStrictEqual(cloudMod.OPENAI_VOICES, ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse']);
  assert.deepStrictEqual(cloudMod.GOOGLE_VOICES, ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr']);
  assert.deepStrictEqual(cloudMod.DEFAULT_CLOUD_VOICE, { openai: 'coral', google: 'Kore' });
  assert.strictEqual(cloudMod.TIMEOUT_MS, 15000);
  assert.ok(cloudMod.PRICES.openai.stt > 0 && cloudMod.PRICES.openai.tts > 0 && cloudMod.PRICES.google.tts > 0 && cloudMod.PRICES.elevenlabs.tts > 0);
});

test('wavFromPcm16 wraps 16-bit mono PCM in a canonical 44-byte WAV header', () => {
  const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
  const w = cloudMod.wavFromPcm16(pcm, 24000);
  assert.strictEqual(w.length, 44 + 8);
  assert.strictEqual(w.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(w.readUInt32LE(4), 36 + 8);
  assert.strictEqual(w.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.strictEqual(w.readUInt16LE(20), 1, 'PCM');
  assert.strictEqual(w.readUInt16LE(22), 1, 'mono');
  assert.strictEqual(w.readUInt32LE(24), 24000);
  assert.strictEqual(w.readUInt32LE(28), 48000, 'byte rate');
  assert.strictEqual(w.readUInt16LE(34), 16);
  assert.strictEqual(w.toString('ascii', 36, 40), 'data');
  assert.strictEqual(w.readUInt32LE(40), 8);
  assert.deepStrictEqual([...w.subarray(44)], [...pcm]);
});

// ── each engine's request shape ──
test('OpenAI STT: multipart POST {openaiBase}/audio/transcriptions with the bearer key, file=audio.wav and the model', async () => {
  const { cloud, fetchImpl } = makeCloud({ respond: () => ({ json: { text: ' turn on the lights ' } }) });
  const r = await cloud.stt('helper', 'openai', wav16());
  assert.deepStrictEqual([r.text, r.engine], ['turn on the lights', 'openai']);
  assert.ok(Number.isFinite(r.ms));
  const c = fetchImpl.calls[0];
  assert.strictEqual(c.url, 'http://fake-openai.test/v1/audio/transcriptions', 'the base comes from getProviderUrl(openai)');
  assert.strictEqual(c.init.method, 'POST');
  assert.strictEqual(c.init.headers.Authorization, `Bearer ${KEYS.openai}`);
  assert.ok(c.init.body instanceof FormData, 'multipart');
  assert.strictEqual(c.init.body.get('model'), 'gpt-4o-mini-transcribe');
  const file = c.init.body.get('file');
  assert.strictEqual(file.name, 'audio.wav');
  assert.strictEqual(file.type, 'audio/wav');
  assert.strictEqual(file.size, wav16().length);
  assert.ok(c.init.signal instanceof AbortSignal, 'a timeout signal is passed');
});

test('OpenAI TTS: POST {openaiBase}/audio/speech {model, voice, input, response_format:wav}; the WAV comes back as is', async () => {
  const reply = cloudMod.wavFromPcm16(pcm24(), 24000);
  const { cloud, fetchImpl } = makeCloud({ respond: () => ({ bytes: reply }) });
  const r = await cloud.tts('helper', 'openai', 'Hello there', 'nova', 1);
  assert.strictEqual(r.engine, 'openai'); assert.strictEqual(r.sampleRate, 24000); assert.deepStrictEqual(r.wav, reply);
  const c = fetchImpl.calls[0];
  assert.strictEqual(c.url, 'http://fake-openai.test/v1/audio/speech');
  assert.strictEqual(c.init.headers.Authorization, `Bearer ${KEYS.openai}`);
  assert.deepStrictEqual(JSON.parse(c.init.body), { model: 'gpt-4o-mini-tts', voice: 'nova', input: 'Hello there', response_format: 'wav' });
  // an unknown cloud voice falls back to the default coral
  await cloud.tts('helper', 'openai', 'Hi', 'not-a-voice', 1);
  assert.strictEqual(JSON.parse(fetchImpl.calls[1].init.body).voice, 'coral');
});

test('Google STT: Gemini generateContent with inline_data audio/wav, the exact instruction and the x-goog-api-key header', async () => {
  const { cloud, fetchImpl } = makeCloud({ respond: () => ({ json: geminiText('  open the door ') }) });
  const input = wav16();
  const r = await cloud.stt('helper', 'google', input);
  assert.deepStrictEqual([r.text, r.engine], ['open the door', 'google']);
  const c = fetchImpl.calls[0];
  assert.strictEqual(c.url, 'http://fake-google.test/v1beta/models/gemini-2.5-flash:generateContent');
  assert.strictEqual(c.init.headers['x-goog-api-key'], KEYS.google);
  assert.ok(!/key=/.test(c.url) && !c.url.includes(KEYS.google), 'the key is a header, never in the URL');
  const body = JSON.parse(c.init.body);
  const parts = body.contents[0].parts;
  assert.ok(parts.some(p => p.text === 'Transcribe this audio exactly. Reply with the words only.'));
  const audio = parts.find(p => p.inline_data).inline_data;
  assert.strictEqual(audio.mime_type, 'audio/wav');
  assert.deepStrictEqual(Buffer.from(audio.data, 'base64'), input);
});

test('Google TTS: gemini-2.5-flash-preview-tts with AUDIO modality and the prebuilt voice; base64 PCM 24 kHz comes back wrapped in a WAV', async () => {
  const pcm = pcm24();
  const { cloud, fetchImpl } = makeCloud({ respond: () => ({ json: geminiAudio(pcm) }) });
  const r = await cloud.tts('helper', 'google', 'Good morning', 'Puck', 1);
  assert.strictEqual(r.engine, 'google'); assert.strictEqual(r.sampleRate, 24000);
  assert.strictEqual(r.wav.toString('ascii', 0, 4), 'RIFF'); assert.strictEqual(r.wav.readUInt32LE(24), 24000);
  assert.deepStrictEqual(r.wav.subarray(44), pcm);
  const c = fetchImpl.calls[0];
  assert.strictEqual(c.url, 'http://fake-google.test/v1beta/models/gemini-2.5-flash-preview-tts:generateContent');
  assert.strictEqual(c.init.headers['x-goog-api-key'], KEYS.google);
  const body = JSON.parse(c.init.body);
  assert.deepStrictEqual(body.generationConfig, { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } } });
  assert.ok(JSON.stringify(body.contents).includes('Good morning'));
  await cloud.tts('helper', 'google', 'Hi', '', 1);
  assert.strictEqual(JSON.parse(fetchImpl.calls[1].init.body).generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore', 'default Kore');
});

test('ElevenLabs TTS: POST /text-to-speech/<voiceId>?output_format=pcm_24000 with xi-api-key and {text, model_id}; raw PCM is wrapped in a WAV', async () => {
  const pcm = pcm24(2400);
  const { cloud, fetchImpl } = makeCloud({ respond: () => ({ bytes: pcm }) });
  const r = await cloud.tts('helper', 'elevenlabs', 'Hello', ELEVEN_ID, 1);
  assert.strictEqual(r.engine, 'elevenlabs'); assert.strictEqual(r.sampleRate, 24000);
  assert.deepStrictEqual(r.wav.subarray(44), pcm); assert.strictEqual(r.wav.readUInt32LE(24), 24000);
  const c = fetchImpl.calls[0];
  assert.strictEqual(c.url, `http://fake-eleven.test/v1/text-to-speech/${ELEVEN_ID}?output_format=pcm_24000`);
  assert.strictEqual(c.init.headers['xi-api-key'], KEYS.elevenlabs);
  assert.deepStrictEqual(JSON.parse(c.init.body), { text: 'Hello', model_id: 'eleven_flash_v2_5' });
  // a malformed voice id is refused before any request
  await assert.rejects(cloud.tts('helper', 'elevenlabs', 'Hello', '../x', 1), (e) => e.reason === 'bad_voice');
  assert.strictEqual(fetchImpl.calls.length, 1);
});

test('speed: OpenAI gets speed (0.25-4) and ElevenLabs voice_settings.speed (0.7-1.2) only when not 1; Gemini never gets one', async () => {
  const bodyOf = async (engine, voice, speed, respond) => {
    const { cloud, fetchImpl } = makeCloud({ respond });
    await cloud.tts('helper', engine, 'Hello there', voice, speed);
    return JSON.parse(fetchImpl.calls[0].init.body);
  };
  const oa = () => ({ bytes: cloudMod.wavFromPcm16(pcm24(), 24000) });
  assert.strictEqual((await bodyOf('openai', 'nova', 1, oa)).speed, undefined, 'speed 1: not sent');
  assert.strictEqual((await bodyOf('openai', 'nova', undefined, oa)).speed, undefined, 'no speed: not sent');
  assert.strictEqual((await bodyOf('openai', 'nova', 1.25, oa)).speed, 1.25);
  assert.strictEqual((await bodyOf('openai', 'nova', 0.75, oa)).speed, 0.75);
  assert.strictEqual((await bodyOf('openai', 'nova', 9, oa)).speed, 4, 'clamped to 4');
  assert.strictEqual((await bodyOf('openai', 'nova', 0.1, oa)).speed, 0.25, 'clamped to 0.25');
  const el = () => ({ bytes: pcm24(2400) });
  assert.deepStrictEqual(await bodyOf('elevenlabs', ELEVEN_ID, 1, el), { text: 'Hello there', model_id: 'eleven_flash_v2_5' });
  assert.deepStrictEqual((await bodyOf('elevenlabs', ELEVEN_ID, 1.1, el)).voice_settings, { speed: 1.1 });
  assert.deepStrictEqual((await bodyOf('elevenlabs', ELEVEN_ID, 1.5, el)).voice_settings, { speed: 1.2 }, 'clamped to 1.2');
  assert.deepStrictEqual((await bodyOf('elevenlabs', ELEVEN_ID, 0.5, el)).voice_settings, { speed: 0.7 }, 'clamped to 0.7');
  const g = await bodyOf('google', 'Kore', 1.5, () => ({ json: geminiAudio(pcm24()) }));
  assert.deepStrictEqual(Object.keys(g).sort(), ['contents', 'generationConfig'], 'Gemini: no speed field anywhere');
  assert.ok(!JSON.stringify(g).includes('speed'));
});

test('the real base URLs are constants (OpenAI follows the provider URL setting)', () => {
  assert.strictEqual(cloudMod.BASES.google, 'https://generativelanguage.googleapis.com/v1beta');
  assert.strictEqual(cloudMod.BASES.elevenlabs, 'https://api.elevenlabs.io/v1');
});

// ── the ledger ──
test('ledger: a successful cloud call records origin voice, provider/model, an estimated cost, a duration and ok:true; no text', async () => {
  const rows = [];
  const { cloud } = makeCloud({ rows, respond: (url) => (url.includes('/audio/speech') ? { bytes: cloudMod.wavFromPcm16(pcm24(), 24000) } : url.includes('transcriptions') ? { json: { text: 'secret words' } } : url.includes('tts:') ? { json: geminiAudio(pcm24()) } : url.includes('text-to-speech') ? { bytes: pcm24() } : { json: geminiText('secret words') }) });
  await cloud.stt('helper', 'openai', wav16(6));
  await cloud.stt('helper', 'google', wav16(6));
  await cloud.tts('helper', 'openai', 'x'.repeat(2000), 'coral', 1);
  await cloud.tts('helper', 'google', 'y'.repeat(1000), 'Kore', 1);
  await cloud.tts('helper', 'elevenlabs', 'z'.repeat(1000), ELEVEN_ID, 1);
  assert.deepStrictEqual(rows.map(r => r.model), ['openai/gpt-4o-mini-transcribe', 'google/gemini-2.5-flash', 'openai/gpt-4o-mini-tts', 'google/gemini-2.5-flash-preview-tts', 'elevenlabs/eleven_flash_v2_5']);
  for (const r of rows) { assert.strictEqual(r.agent, 'helper'); assert.strictEqual(r.origin, 'voice'); assert.strictEqual(r.ok, true); assert.ok(r.costUsd > 0, 'estimate'); assert.ok(Number.isFinite(r.durationMs)); }
  assert.ok(Math.abs(rows[0].costUsd - cloudMod.PRICES.openai.stt * 0.1) < 1e-9, 'STT cost = per-minute price x minutes of audio (6 s = 0.1 min)');
  assert.ok(Math.abs(rows[2].costUsd - cloudMod.PRICES.openai.tts * 2) < 1e-9, 'TTS cost = per-1,000-characters price x thousands of characters');
  assert.ok(!JSON.stringify(rows).includes('secret words') && !JSON.stringify(rows).includes('xxxx'), 'no text in the ledger');
});

test('ledger: a failed cloud call records ok:false with cost 0 and still throws; a ledger that throws never breaks the call', async () => {
  const rows = [];
  const bad = makeCloud({ rows, respond: () => ({ status: 500, json: {} }) });
  await assert.rejects(bad.cloud.tts('helper', 'openai', 'Hi', 'coral', 1), (e) => e.reason === 'http_500');
  assert.deepStrictEqual(rows.map(r => [r.model, r.origin, r.ok, r.costUsd]), [['openai/gpt-4o-mini-tts', 'voice', false, 0]]);
  const flaky = makeCloud({ throwLedger: true, respond: () => ({ json: { text: 'ok' } }) });
  assert.strictEqual((await flaky.cloud.stt('helper', 'openai', wav16())).text, 'ok');
});

test('a missing key throws no_key before any request and records nothing (no call was made)', async () => {
  const rows = [];
  const { cloud, fetchImpl } = makeCloud({ rows, keys: {}, respond: () => ({ json: { text: 'x' } }) });
  await assert.rejects(cloud.stt('helper', 'openai', wav16()), (e) => e.reason === 'no_key');
  await assert.rejects(cloud.tts('helper', 'elevenlabs', 'Hi', ELEVEN_ID, 1), (e) => e.reason === 'no_key');
  assert.strictEqual(fetchImpl.calls.length, 0); assert.strictEqual(rows.length, 0);
  assert.deepStrictEqual(cloud.keys(), { openai: false, google: false, elevenlabs: false });
});

// ── the manifest: the per-agent voice field ──
test('cleanAgentVoice: engines, cloud voice lists and defaults; plain error messages', () => {
  const c = (v) => manifest.cleanAgentVoice(v);
  assert.deepStrictEqual(c({ voice: 'af_heart' }).value, { voice: 'af_heart', stt: 'local', tts: 'local' }, 'default is local');
  assert.deepStrictEqual(c({ stt: 'openai', tts: 'openai' }).value, { voice: '', stt: 'openai', tts: 'openai', cloudVoice: 'coral' });
  assert.deepStrictEqual(c({ stt: 'google', tts: 'google', cloudVoice: 'Puck' }).value, { voice: '', stt: 'google', tts: 'google', cloudVoice: 'Puck' });
  assert.deepStrictEqual(c({ tts: 'google' }).value.cloudVoice, 'Kore');
  assert.deepStrictEqual(c({ tts: 'elevenlabs', cloudVoice: ELEVEN_ID }).value, { voice: '', stt: 'local', tts: 'elevenlabs', cloudVoice: ELEVEN_ID });
  assert.strictEqual(c({ tts: 'local', cloudVoice: 'nova' }).value.cloudVoice, undefined, 'a cloud voice is kept only with its engine');
  assert.strictEqual(c({ tts: 'elevenlabs' }).ok, false, 'an ElevenLabs voice id is required');
  assert.strictEqual(c({ tts: 'elevenlabs', cloudVoice: 'short' }).ok, false);
  assert.strictEqual(c({ tts: 'elevenlabs', cloudVoice: 'has space 1234567' }).ok, false);
  assert.strictEqual(c({ tts: 'openai', cloudVoice: 'Kore' }).ok, false, 'a Google voice is not an OpenAI voice');
  assert.strictEqual(c({ tts: 'google', cloudVoice: 'coral' }).ok, false);
  assert.strictEqual(c({ stt: 'elevenlabs' }).ok, false, 'ElevenLabs does no speech recognition here');
  assert.strictEqual(c({ stt: 'azure' }).ok, false);
  assert.strictEqual(c({ tts: 'azure' }).ok, false);
  assert.ok(!/cloud engines come later/.test(c({ stt: 'azure' }).error));
  assert.strictEqual(c(null).value, null);
  // the confirmation fields are carried only with a cloud engine
  assert.strictEqual(c({ tts: 'local', cloudConfirmedBy: 'u1' }).value.cloudConfirmedBy, undefined);
  assert.strictEqual(c({ tts: 'openai', cloudConfirmedBy: 'u1', cloudConfirmedAt: '2026-01-01T00:00:00.000Z' }).value.cloudConfirmedBy, 'u1');
});

// ── the routes ──
function fakeRes() {
  const chunks = [];
  const r = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  r.writeHead = (code, headers) => { r.statusCode = code; r.headers = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v])); r.headersSent = true; };
  r.finished = new Promise((resolve) => r.on('finish', resolve));
  r.body = () => Buffer.concat(chunks);
  r.json = () => JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return r;
}
function fakeReq(method, url, { headers = {}, body, user = { id: 'u_owner', role: 'admin' } } = {}) {
  const r = Readable.from(body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)]);
  Object.assign(r, { method, url, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), hubUser: user, hubService: false });
  return r;
}
const HOME = require('../lib/hub-home').HUB_HOME;
const CLOUD_OPENAI = { voice: '', stt: 'openai', tts: 'openai', cloudVoice: 'coral' };

function setup({ agents, ready = true, respond, keys = KEYS, keepOnBox = [], rows = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-cloud-'));
  fs.mkdirSync(path.join(dir, 'web'), { recursive: true });
  const settings = { voice: { enabled: true, defaultVoice: '', sttModel: '' }, autoClassifier: { keepOnBox } };
  const local = { stt: 0, tts: 0 };
  const engine = {
    paths: { web: path.join(dir, 'web'), dir, worker: path.join(dir, 'worker.js') },
    status: () => ({ enabled: true, ready, installing: false, step: ready ? 'ready' : '', progress: ready ? 1 : 0, error: '', platformSupported: true, stt: { engine: 'local', model: 'tiny.en' }, tts: { engine: 'local', defaultVoice: 'af_heart' }, voices: ready ? manifest.VOICES.map(v => ({ id: v.id, label: v.label, engine: v.engine, accent: v.accent })) : [] }),
    install: () => Promise.resolve(),
  };
  const client = {
    stt: async () => { local.stt++; return { text: 'local words', ms: 5 }; },
    tts: async () => { local.tts++; return { wav: Buffer.from('RIFF....WAVE-local'), sampleRate: 24000, ms: 6 }; },
    stop() {}, resume() {},
  };
  const mk = makeCloud({ respond, keys, rows });
  const deps = {
    jsonResponse: (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); },
    readBody: (req) => new Promise((resolve) => { let s = ''; req.on('data', c => { s += c; }); req.on('end', () => resolve(s)); }),
    getSetting: (k, d) => (settings[k] !== undefined ? settings[k] : d),
    updateSettings: () => {}, getAgents: async () => agents, getVoice: () => ({ engine, client }), cloud: mk.cloud,
  };
  const call = async (req) => { const res = fakeRes(); const u = new URL(req.url, 'http://x'); await routes.handle(u.pathname, req, res, deps); if (!res.writableEnded) await new Promise(r => setTimeout(r, 5)); await res.finished; return res; };
  const stt = (agent = 'helper', user) => call(fakeReq('POST', `/api/voice/stt?agent=${agent}`, { headers: { 'Content-Type': 'audio/wav' }, body: wav16(), user }));
  const tts = (agent = 'helper', extra = {}) => call(fakeReq('POST', '/api/voice/tts', { body: JSON.stringify({ agent, text: 'Hello secret sentence', ...extra }) }));
  return { call, stt, tts, local, mk, rows, settings, deps, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
// Collects console.log / console.error lines while fn runs.
async function withLogs(fn) {
  const lines = []; const ol = console.log, oe = console.error;
  console.log = (...a) => lines.push(a.join(' ')); console.error = (...a) => lines.push(a.join(' '));
  try { return { value: await fn(), lines }; } finally { console.log = ol; console.error = oe; }
}
const okResponder = (url) => (url.includes('transcriptions') ? { json: { text: 'cloud words' } } : url.includes('/audio/speech') ? { bytes: cloudMod.wavFromPcm16(pcm24(), 24000) } : url.includes('tts:') ? { json: geminiAudio(pcm24()) } : url.includes('text-to-speech') ? { bytes: pcm24() } : { json: geminiText('cloud words') });

test('routes: an agent on the default (local) engines never calls the cloud and says so in X-Voice-Engine', async () => {
  const t = setup({ agents: [{ name: 'helper' }], respond: okResponder });
  try {
    const s = await t.stt(); assert.strictEqual(s.statusCode, 200);
    assert.deepStrictEqual(s.json(), { text: 'local words', ms: 5, engine: 'local' }); assert.strictEqual(s.headers['x-voice-engine'], 'local'); assert.strictEqual(s.headers['x-voice-fallback'], undefined);
    const v = await t.tts(); assert.strictEqual(v.statusCode, 200); assert.strictEqual(v.headers['x-voice-engine'], 'local');
    assert.strictEqual(t.mk.fetchImpl.calls.length, 0); assert.strictEqual(t.rows.length, 0);
  } finally { t.cleanup(); }
});

test('routes: stt with a cloud engine is answered by the cloud (engine in JSON and header), the local engine is not used', async () => {
  const t = setup({ agents: [{ name: 'helper', voice: CLOUD_OPENAI }], respond: okResponder });
  try {
    const s = await t.stt(); assert.strictEqual(s.statusCode, 200);
    assert.deepStrictEqual([s.json().text, s.json().engine], ['cloud words', 'openai']); assert.strictEqual(s.headers['x-voice-engine'], 'openai');
    assert.strictEqual(t.local.stt, 0); assert.strictEqual(t.rows.length, 1); assert.strictEqual(t.rows[0].origin, 'voice');
  } finally { t.cleanup(); }
});

test('routes: tts with a cloud engine and the agent cloudVoice is answered by the cloud', async () => {
  const t = setup({ agents: [{ name: 'helper', voice: { voice: '', stt: 'local', tts: 'google', cloudVoice: 'Fenrir' } }], respond: okResponder });
  try {
    const v = await t.tts(); assert.strictEqual(v.statusCode, 200);
    assert.strictEqual(v.headers['x-voice-engine'], 'google'); assert.strictEqual(v.body().toString('ascii', 0, 4), 'RIFF'); assert.strictEqual(t.local.tts, 0);
    assert.strictEqual(JSON.parse(t.mk.fetchImpl.calls[0].init.body).generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Fenrir');
  } finally { t.cleanup(); }
});

test('routes: the cloud path does not need the local engine to be ready (but still needs voice enabled)', async () => {
  const t = setup({ agents: [{ name: 'helper', voice: CLOUD_OPENAI }], ready: false, respond: okResponder });
  try {
    assert.strictEqual((await t.stt()).statusCode, 200); assert.strictEqual((await t.tts()).statusCode, 200);
    t.settings.voice.enabled = false;
    assert.strictEqual((await t.stt()).statusCode, 409); assert.strictEqual((await t.tts()).statusCode, 409);
  } finally { t.cleanup(); }
});

for (const [name, responder] of [
  ['HTTP 500', () => ({ status: 500, json: {} })],
  ['bad JSON', () => ({ badJson: true })],
  ['a reply with no transcript', () => ({ json: {} })],
  ['a timeout', () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }],
]) {
  test(`routes: a cloud failure (${name}) is answered by the local engine with X-Voice-Fallback and one log line without audio or text`, async () => {
    const t = setup({ agents: [{ name: 'helper', voice: CLOUD_OPENAI }], respond: responder });
    try {
      const { value: s, lines } = await withLogs(() => t.stt());
      assert.strictEqual(s.statusCode, 200); assert.deepStrictEqual([s.json().text, s.json().engine], ['local words', 'local']);
      assert.strictEqual(s.headers['x-voice-engine'], 'local'); assert.ok(s.headers['x-voice-fallback'], 'reason header');
      const fail = lines.filter(l => /\[voice\] openai stt failed \(.+\): using the local engine/.test(l));
      assert.strictEqual(fail.length, 1, lines.join('\n'));
      const { value: v, lines: l2 } = await withLogs(() => t.tts('helper'));
      assert.strictEqual(v.statusCode, 200); assert.strictEqual(v.headers['x-voice-engine'], 'local'); assert.ok(v.headers['x-voice-fallback']);
      assert.strictEqual(l2.filter(l => /\[voice\] openai tts failed \(.+\): using the local engine/.test(l)).length, 1);
      assert.ok(!lines.concat(l2).some(l => l.includes('secret sentence') || l.includes('cloud words')), 'no text in the log');
      assert.ok(t.rows.every(r => r.ok === false), 'failed calls are ledgered ok:false (an unusable answer the provider billed keeps its estimated cost)');
    } finally { t.cleanup(); }
  });
}

test('routes: the fallback reason names the cause (http_500, timeout, no_key, bad_response)', async () => {
  const reasons = async (responder, keys) => { const t = setup({ agents: [{ name: 'helper', voice: CLOUD_OPENAI }], respond: responder, keys }); try { return (await t.stt()).headers['x-voice-fallback']; } finally { t.cleanup(); } };
  assert.strictEqual(await reasons(() => ({ status: 500, json: {} })), 'http_500');
  assert.strictEqual(await reasons(() => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }), 'timeout');
  assert.strictEqual(await reasons(() => ({ json: { text: 'x' } }), {}), 'no_key');
  assert.strictEqual(await reasons(() => ({ badJson: true })), 'bad_response');
});

test('routes: a missing key falls back to local and makes no request', async () => {
  const t = setup({ agents: [{ name: 'helper', voice: { voice: '', stt: 'google', tts: 'elevenlabs', cloudVoice: ELEVEN_ID } }], keys: {}, respond: okResponder });
  try {
    const s = await t.stt(); assert.strictEqual(s.json().engine, 'local'); assert.strictEqual(s.headers['x-voice-fallback'], 'no_key');
    const v = await t.tts(); assert.strictEqual(v.headers['x-voice-engine'], 'local'); assert.strictEqual(v.headers['x-voice-fallback'], 'no_key');
    assert.strictEqual(t.mk.fetchImpl.calls.length, 0);
  } finally { t.cleanup(); }
});

test('routes: cloud fails and the local engine is not usable either -> 503 voice_unavailable', async () => {
  const t = setup({ agents: [{ name: 'helper', voice: CLOUD_OPENAI }], ready: false, respond: () => ({ status: 500, json: {} }) });
  try {
    const s = await t.stt(); assert.strictEqual(s.statusCode, 503); assert.deepStrictEqual(s.json(), { error: 'voice_unavailable' });
    const v = await t.tts(); assert.strictEqual(v.statusCode, 503); assert.deepStrictEqual(v.json(), { error: 'voice_unavailable' });
    assert.strictEqual(t.local.stt + t.local.tts, 0);
  } finally { t.cleanup(); }
});

test('routes: keys never appear in responses or log lines', async () => {
  for (const responder of [okResponder, () => ({ status: 401, json: { error: { message: 'bad key sk-test-openai-KEY1' } } })]) {
    const t = setup({ agents: [{ name: 'helper', voice: { voice: '', stt: 'openai', tts: 'openai', cloudVoice: 'coral' } }], respond: responder });
    try {
      const { value, lines } = await withLogs(async () => [await t.stt(), await t.tts(), await t.call(fakeReq('GET', '/api/voice/status'))]);
      const everything = value.map(r => JSON.stringify(r.headers) + r.body().toString('latin1')).join('\n') + lines.join('\n');
      for (const k of Object.values(KEYS)) assert.ok(!everything.includes(k), `a key leaked: ${k}`);
    } finally { t.cleanup(); }
  }
});

test('GET /api/voice/status: cloud = { openai, google, elevenlabs } booleans for an admin; {} for a member; never a key', async () => {
  const t = setup({ agents: [{ name: 'helper' }], keys: { openai: KEYS.openai, elevenlabs: KEYS.elevenlabs } });
  try {
    const a = (await t.call(fakeReq('GET', '/api/voice/status'))).json();
    assert.deepStrictEqual(a.cloud, { openai: true, google: false, elevenlabs: true });
    const m = (await t.call(fakeReq('GET', '/api/voice/status', { user: { id: 'u_sam', role: 'member' } }))).json();
    assert.deepStrictEqual(m.cloud, {});
    assert.ok(!JSON.stringify([a, m]).includes('sk-test'));
  } finally { t.cleanup(); }
});

// ── privacy: agents kept on this computer ──
test('request-time defence: a kept agent (keepOnBox, or a medical/ folder) without a confirmation is served locally even when its setting says cloud', async () => {
  const kept = [
    { name: 'helper', voice: CLOUD_OPENAI },
    { name: 'doc', voice: CLOUD_OPENAI, policy: { roots: [path.join(HOME, 'medical')] } },
  ];
  const t = setup({ agents: kept, keepOnBox: ['helper'], respond: okResponder });
  try {
    for (const name of ['helper', 'doc']) {
      const s = await t.stt(name); assert.strictEqual(s.json().engine, 'local', name); const v = await t.tts(name); assert.strictEqual(v.headers['x-voice-engine'], 'local', name);
    }
    assert.strictEqual(t.mk.fetchImpl.calls.length, 0, 'nothing left the computer');
    // with the owner's confirmation stored, the same agent uses the cloud
    kept[0].voice = { ...CLOUD_OPENAI, cloudConfirmedBy: 'u_owner', cloudConfirmedAt: '2026-01-01T00:00:00.000Z' };
    assert.strictEqual((await t.stt('helper')).json().engine, 'openai');
  } finally { t.cleanup(); }
});

// agents.js has fixed paths: run a copy of lib/ in a temp hub (as test/unit-agents.test.js does).
const REAL_LIB = path.join(__dirname, '..', 'lib');
const REAL_ROOT = path.join(__dirname, '..');
const roots = [];
const saved = { mem: process.env.HUB_MEMORY_DB, auth: process.env.HUB_AUTH_DIR };
function loadHub({ agents, settings } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-cloud-hub-'));
  roots.push(root);
  const hub = path.join(root, 'hub');
  fs.mkdirSync(path.join(root, 'share'));
  fs.cpSync(REAL_LIB, path.join(hub, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(REAL_ROOT, 'package.json'), path.join(hub, 'package.json'));
  fs.symlinkSync(path.join(REAL_ROOT, 'node_modules'), path.join(hub, 'node_modules'));
  fs.mkdirSync(path.join(hub, 'data'), { recursive: true });
  fs.writeFileSync(path.join(hub, 'data', 'agents.json'), JSON.stringify(agents));
  if (settings) fs.writeFileSync(path.join(hub, 'data', 'settings.json'), JSON.stringify(settings));
  process.env.HUB_MEMORY_DB = path.join(hub, 'data', 'memory.db');
  process.env.HUB_AUTH_DIR = path.join(hub, 'data');
  const gw = new Module(path.join(hub, 'lib', 'gateway-client.js'));
  gw.filename = gw.id; gw.loaded = true; gw.exports = { listModels: async () => [], chatCompletion: async () => ({}) };
  require.cache[gw.id] = gw;
  const ag = require(path.join(hub, 'lib', 'agents.js'));
  const auth = require(path.join(hub, 'lib', 'auth.js')).getAuth();
  const readJson = () => JSON.parse(fs.readFileSync(path.join(hub, 'data', 'agents.json'), 'utf8'));
  return { ag, auth, root, hub, readJson };
}
test.after(() => {
  for (const [k, v] of [['HUB_MEMORY_DB', saved.mem], ['HUB_AUTH_DIR', saved.auth]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});
// What server.js hands the PATCH: the signed-in user's owner flag and id.
const ctxFor = (h, user) => ({ isOwner: h.auth.isOwner(user), userId: user.id });
function twoAdmins(h) {
  const owner = h.auth.createUser({ login: 'owner@example.com', role: 'admin' }).user;
  const sam = h.auth.createUser({ login: 'sam@example.com', role: 'admin' }).user;
  const member = h.auth.createUser({ login: 'kid@example.com', role: 'member' }).user;
  return { owner, sam, member };
}

test('auth.isOwner: the earliest-created active admin only', () => {
  const h = loadHub({ agents: [{ name: 'helper' }] });
  const { owner, sam, member } = twoAdmins(h);
  assert.strictEqual(h.auth.isOwner(owner), true);
  assert.strictEqual(h.auth.isOwner(sam), false, 'a later admin is not the owner');
  assert.strictEqual(h.auth.isOwner(member), false);
  assert.strictEqual(h.auth.isOwner(null), false);
  assert.strictEqual(h.auth.isOwner({ id: 'nobody' }), false);
});

test('PATCH voice, kept agent: cloud is refused without confirmation (403 owner_confirmation_required), nothing is saved', async () => {
  const h = loadHub({ agents: [{ name: 'helper' }], settings: { autoClassifier: { keepOnBox: ['helper'] } } });
  const { owner } = twoAdmins(h);
  const r = await h.ag.updateAgentField('helper', { voice: { voice: 'af_heart', stt: 'openai', tts: 'local' } }, ctxFor(h, owner));
  assert.deepStrictEqual([r.success, r.status, r.error], [false, 403, 'owner_confirmation_required']);
  const r2 = await h.ag.updateAgentField('helper', { voice: { stt: 'local', tts: 'openai' } });   // no context at all
  assert.deepStrictEqual([r2.success, r2.status, r2.error], [false, 403, 'owner_confirmation_required']);
  assert.strictEqual(h.readJson().find(a => a.name === 'helper').voice, undefined);
  // local stays allowed without any confirmation
  assert.strictEqual((await h.ag.updateAgentField('helper', { voice: { voice: 'bm_george', stt: 'local', tts: 'local' } }, ctxFor(h, owner))).success, true);
});

test('PATCH voice, kept agent: a non-owner admin is refused even with cloudConfirm:true', async () => {
  const h = loadHub({ agents: [{ name: 'helper' }], settings: { autoClassifier: { keepOnBox: ['helper'] } } });
  const { sam } = twoAdmins(h);
  const r = await h.ag.updateAgentField('helper', { voice: { stt: 'openai', tts: 'openai', cloudConfirm: true } }, ctxFor(h, sam));
  assert.deepStrictEqual([r.success, r.status, r.error], [false, 403, 'owner_confirmation_required']);
  assert.strictEqual(h.readJson().find(a => a.name === 'helper').voice, undefined);
});

test('PATCH voice, kept agent: the owner with cloudConfirm:true is accepted; cloudConfirmedBy and cloudConfirmedAt are stored, cloudConfirm is not', async () => {
  const h = loadHub({ agents: [{ name: 'helper' }], settings: { autoClassifier: { keepOnBox: ['helper'] } } });
  const { owner } = twoAdmins(h);
  const r = await h.ag.updateAgentField('helper', { voice: { voice: 'af_heart', stt: 'openai', tts: 'google', cloudVoice: 'Puck', cloudConfirm: true } }, ctxFor(h, owner));
  assert.strictEqual(r.success, true);
  const v = h.readJson().find(a => a.name === 'helper').voice;
  assert.strictEqual(v.cloudConfirmedBy, owner.id);
  assert.ok(!Number.isNaN(Date.parse(v.cloudConfirmedAt)));
  assert.ok(!('cloudConfirm' in v));
  assert.deepStrictEqual([v.stt, v.tts, v.cloudVoice], ['openai', 'google', 'Puck']);
  // and the stored record is normalised with the confirmation intact
  assert.strictEqual(h.ag.getAgentsSync().find(a => a.name === 'helper').voice.cloudConfirmedBy, owner.id);
});

test('PATCH voice, kept agent: cloudConfirmedBy sent in the body is ignored (it cannot be forged), and a medical/ folder counts as kept', async () => {
  const h = loadHub({ agents: [{ name: 'doc' }] });
  const { owner, sam } = twoAdmins(h);
  assert.strictEqual((await h.ag.updateAgentField('doc', { policy: { roots: [path.join(h.root, 'medical')] } })).success, true);
  const forged = await h.ag.updateAgentField('doc', { voice: { stt: 'openai', tts: 'local', cloudConfirmedBy: owner.id, cloudConfirmedAt: '2020-01-01T00:00:00.000Z' } }, ctxFor(h, sam));
  assert.deepStrictEqual([forged.success, forged.error], [false, 'owner_confirmation_required']);
  const ok = await h.ag.updateAgentField('doc', { voice: { stt: 'openai', tts: 'local', cloudConfirmedBy: 'u_forged', cloudConfirm: true } }, ctxFor(h, owner));
  assert.strictEqual(ok.success, true);
  assert.strictEqual(h.readJson().find(a => a.name === 'doc').voice.cloudConfirmedBy, owner.id, 'set by the server from the signed-in owner');
});

test('PATCH voice, kept agent: switching back to local clears the confirmation; an unchanged cloud choice keeps it; a changed engine needs it again', async () => {
  const h = loadHub({ agents: [{ name: 'helper' }], settings: { autoClassifier: { keepOnBox: ['helper'] } } });
  const { owner, sam } = twoAdmins(h);
  await h.ag.updateAgentField('helper', { voice: { stt: 'openai', tts: 'openai', cloudConfirm: true } }, ctxFor(h, owner));
  // a non-owner admin changes only the cloud voice: same engines, still confirmed
  assert.strictEqual((await h.ag.updateAgentField('helper', { voice: { stt: 'openai', tts: 'openai', cloudVoice: 'nova' } }, ctxFor(h, sam))).success, true);
  assert.strictEqual(h.readJson().find(a => a.name === 'helper').voice.cloudConfirmedBy, owner.id);
  // switching an engine to another provider is a new decision
  const sw = await h.ag.updateAgentField('helper', { voice: { stt: 'google', tts: 'openai', cloudVoice: 'nova' } }, ctxFor(h, sam));
  assert.strictEqual(sw.error, 'owner_confirmation_required');
  // back to local clears both fields
  assert.strictEqual((await h.ag.updateAgentField('helper', { voice: { stt: 'local', tts: 'local' } }, ctxFor(h, sam))).success, true);
  const v = h.readJson().find(a => a.name === 'helper').voice;
  assert.deepStrictEqual([v.stt, v.tts, v.cloudConfirmedBy, v.cloudConfirmedAt, v.cloudVoice], ['local', 'local', undefined, undefined, undefined]);
  // and clearing the whole voice drops it too
  await h.ag.updateAgentField('helper', { voice: { stt: 'openai', tts: 'local', cloudConfirm: true } }, ctxFor(h, owner));
  await h.ag.updateAgentField('helper', { voice: null }, ctxFor(h, sam));
  assert.strictEqual(h.readJson().find(a => a.name === 'helper').voice, undefined);
});

test('PATCH voice, agent not kept on this computer: any admin may choose a cloud engine, no confirmation stored', async () => {
  const h = loadHub({ agents: [{ name: 'helper' }] });
  const { sam } = twoAdmins(h);
  assert.strictEqual((await h.ag.updateAgentField('helper', { voice: { stt: 'google', tts: 'elevenlabs', cloudVoice: ELEVEN_ID } }, ctxFor(h, sam))).success, true);
  const v = h.readJson().find(a => a.name === 'helper').voice;
  assert.deepStrictEqual(v, { voice: '', stt: 'google', tts: 'elevenlabs', cloudVoice: ELEVEN_ID });
  const bad = await h.ag.updateAgentField('helper', { voice: { stt: 'openai', tts: 'elevenlabs', cloudVoice: 'bad' } }, ctxFor(h, sam));
  assert.strictEqual(bad.success, false); assert.ok(/ElevenLabs/.test(bad.error));
});

test('cloud.keptOnBox: medical/legal folder grants or the keep-on-box list', () => {
  const gs = (list) => (k) => (k === 'autoClassifier' ? { keepOnBox: list } : undefined);
  assert.strictEqual(cloudMod.keptOnBox({ name: 'a' }, gs([])), false);
  assert.strictEqual(cloudMod.keptOnBox({ name: 'a' }, gs(['a'])), true);
  assert.strictEqual(cloudMod.keptOnBox({ name: 'a', policy: { roots: [path.join(HOME, 'legal')] } }, gs([])), true);
  assert.strictEqual(cloudMod.keptOnBox({ name: 'a', policy: { roots: [path.join(HOME, 'share')] } }, gs([])), false);
  assert.strictEqual(cloudMod.keptOnBox(null, gs(['a'])), false);
});

test('settings: ElevenLabs has an environment key name and reports its key source like the other providers', () => {
  const s = require('../lib/settings');
  assert.strictEqual(s.ENV_KEY_MAP.elevenlabs, 'ELEVENLABS_API_KEY');
  assert.ok(s.PROVIDER_DEFAULTS.elevenlabs, 'listed in the providers the Settings page shows');
  const before = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = 'sk-test-eleven-env';
  try {
    assert.strictEqual(s.getProviderKey('elevenlabs'), s.get().providers?.elevenlabs?.apiKey || 'sk-test-eleven-env');
    if (!s.get().providers?.elevenlabs?.apiKey) assert.strictEqual(s.keySource('elevenlabs'), 'environment');
    assert.ok(!JSON.stringify(s.getForUI().providers.elevenlabs).includes('sk-test-eleven-env'), 'the page sees a hint, never the key');
  } finally { if (before === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = before; }
});

// ── review round 1: response caps, audio validation, STT pricing, abort mapping, downgrades, owner, privacy ──
const MB = 1024 * 1024;
// A streamed body of n bytes in 256 KiB chunks (counts what was pulled; a cancel is recorded).
function bigBody(n) {
  const st = { pulled: 0, cancelled: false };
  let sent = 0;
  const body = new ReadableStream({ pull(c) { if (sent >= n) return c.close(); const k = Math.min(262144, n - sent); sent += k; st.pulled += k; c.enqueue(new Uint8Array(k)); }, cancel() { st.cancelled = true; } });
  return { body, st };
}
const hangingBody = (init) => new ReadableStream({ start(c) { init.signal.addEventListener('abort', () => c.error(init.signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' }))); } });
function wavWith({ format = 1, channels = 1, rate = 24000, bits = 16, data = Buffer.alloc(4800, 1), declared } = {}) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'ascii'); h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16); h.writeUInt16LE(format, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * bits / 8, 28);
  h.writeUInt16LE(channels * bits / 8, 32); h.writeUInt16LE(bits, 34); h.write('data', 36, 'ascii'); h.writeUInt32LE(declared === undefined ? data.length : declared, 40);
  return Buffer.concat([h, data]);
}
const reasonOf = async (p) => { try { await p; return 'resolved'; } catch (e) { return e.reason; } };

test('too_large: a cloud audio answer over 8 MB is stopped while streaming (aborted, ledgered ok:false)', async () => {
  const rows = []; const big = bigBody(9 * MB);
  const { cloud, fetchImpl } = makeCloud({ rows, respond: () => ({ body: big.body }) });
  assert.strictEqual(await reasonOf(cloud.tts('helper', 'openai', 'hi', 'coral')), 'too_large');
  assert.ok(big.st.pulled < 9 * MB, 'it did not read the whole body');
  assert.strictEqual(fetchImpl.calls[0].init.signal.aborted, true, 'the request was aborted');
  assert.deepStrictEqual([rows.length, rows[0].ok], [1, false]);
  assert.ok(rows[0].costUsd > 0, 'the provider answered and billed: the estimate counts');
  const e = makeCloud({ respond: () => ({ bytes: Buffer.alloc(9 * MB) }) });
  assert.strictEqual(await reasonOf(e.cloud.tts('helper', 'elevenlabs', 'hi', ELEVEN_ID)), 'too_large');
});

test('too_large: a content-length over the cap is refused before any byte is read; JSON answers are capped at 1 MB', async () => {
  const big = bigBody(1);
  const a = makeCloud({ respond: () => ({ body: big.body, headers: { 'content-length': String(20 * MB) } }) });
  assert.strictEqual(await reasonOf(a.cloud.tts('helper', 'openai', 'hi', 'coral')), 'too_large');
  assert.ok(big.st.pulled <= 1, 'the body was not read');
  const j = makeCloud({ respond: () => ({ body: bigBody(2 * MB).body }) });
  assert.strictEqual(await reasonOf(j.cloud.stt('helper', 'openai', wav16())), 'too_large');
  const g = makeCloud({ respond: () => ({ body: bigBody(2 * MB).body }) });
  assert.strictEqual(await reasonOf(g.cloud.stt('helper', 'google', wav16())), 'too_large');
});

test('bad_audio: OpenAI WAV must be 16-bit PCM, 1-2 channels, 8-48 kHz, a data chunk that fits, at least 0.05 s', async () => {
  const cases = {
    'float format': wavWith({ format: 3 }), '8-bit': wavWith({ bits: 8 }), 'three channels': wavWith({ channels: 3 }), 'rate 4000': wavWith({ rate: 4000 }), 'rate 96000': wavWith({ rate: 96000 }),
    'shorter than 0.05 s': wavWith({ data: Buffer.alloc(1000) }), 'data size beyond the buffer (cut short)': wavWith({ declared: 99999 }), 'no data chunk': wavWith().subarray(0, 36), 'not RIFF': Buffer.concat([Buffer.from('JUNK'), wavWith().subarray(4)]),
    'junk text': Buffer.from('<html>error page that is long enough to pass the old check</html>'),
  };
  for (const [name, wav] of Object.entries(cases)) {
    const rows = []; const { cloud } = makeCloud({ rows, respond: () => ({ bytes: wav }) });
    assert.strictEqual(await reasonOf(cloud.tts('helper', 'openai', 'hi', 'coral')), 'bad_audio', name);
    assert.strictEqual(rows[0].ok, false, name);
    assert.ok(rows[0].costUsd > 0, 'billed answer, estimated cost kept: ' + name);
  }
  const good = makeCloud({ respond: () => ({ bytes: wavWith({ rate: 24000, channels: 2, data: Buffer.alloc(9600) }) }) });
  assert.strictEqual((await good.cloud.tts('helper', 'openai', 'hi', 'coral')).sampleRate, 24000);
});

test('bad_audio: Google inline data must be audio, valid base64, even length, at least 0.05 s; ElevenLabs PCM even and long enough', async () => {
  const inline = (data, mimeType = 'audio/L16;codec=pcm;rate=24000') => ({ json: { candidates: [{ content: { parts: [{ inlineData: { mimeType, data } }] } }] } });
  const b64 = (n) => Buffer.alloc(n, 2).toString('base64');
  const g = {
    'not audio': inline(b64(4800), 'text/plain'), 'bad base64': inline('!!!not-base64!!!'), 'odd length': inline(Buffer.alloc(4801, 2).toString('base64')),
    'too short': inline(b64(2000)), 'empty': inline(''), 'no mime at all': inline(b64(4800), ''),
    'mp3 payload': inline(b64(4800), 'audio/mpeg'), 'wav payload': inline(b64(4800), 'audio/wav'),
    'pcm subtype suffix': inline(b64(4800), 'audio/pcm-float'), 'l16 subtype suffix': inline(b64(4800), 'audio/L16-other'),
  };
  for (const [name, r] of Object.entries(g)) {
    const rows = []; const { cloud } = makeCloud({ rows, respond: () => r });
    assert.strictEqual(await reasonOf(cloud.tts('helper', 'google', 'hi', 'Kore')), 'bad_audio', name);
    assert.strictEqual(rows[0].ok, false, name);
  }
  assert.strictEqual((await makeCloud({ respond: () => inline(b64(4800), 'audio/pcm') }).cloud.tts('helper', 'google', 'hi', 'Kore')).sampleRate, 24000);
  for (const [name, bytes] of Object.entries({ odd: Buffer.alloc(4801), short: Buffer.alloc(2000), empty: Buffer.alloc(0) })) {
    const rows = []; const { cloud } = makeCloud({ rows, respond: () => ({ bytes }) });
    assert.strictEqual(await reasonOf(cloud.tts('helper', 'elevenlabs', 'hi', ELEVEN_ID)), 'bad_audio', 'eleven ' + name);
    assert.strictEqual(rows[0].ok, false);
  }
});

test('routes: bad cloud audio falls back to the local engine (X-Voice-Fallback: bad_audio) and the ledger row is ok:false', async () => {
  const t = setup({ agents: [{ name: 'helper', voice: CLOUD_OPENAI }], respond: () => ({ bytes: Buffer.from('RIFF....WAVEnotreallyawavbutlongenoughtopassthenaivecheck!!!!!!') }) });
  try {
    const v = await withLogs(() => t.tts()); assert.strictEqual(v.value.statusCode, 200);
    assert.strictEqual(v.value.headers['x-voice-engine'], 'local'); assert.strictEqual(v.value.headers['x-voice-fallback'], 'bad_audio');
    assert.deepStrictEqual([t.rows.length, t.rows[0].ok], [1, false]);
  } finally { t.cleanup(); }
});

test('STT cost: priced by the real audio (a lying header rate cannot inflate it) and capped at the 10 MB maximum duration', async () => {
  const price = cloudMod.PRICES.openai.stt;
  const lie = wav16(1.5); lie.writeUInt32LE(1, 24);   // claims 1 Hz: the old maths gave about 6.7 hours
  const rows = []; const a = makeCloud({ rows, respond: () => ({ json: { text: 'x' } }) });
  await a.cloud.stt('helper', 'openai', lie);
  assert.ok(rows[0].costUsd <= price * (3 / 60) + 1e-12, 'clamped to 8 kHz at worst: ' + rows[0].costUsd);
  const lie2 = wav16(1.5); lie2.writeUInt16LE(60000, 22);   // claims 60000 channels
  await a.cloud.stt('helper', 'openai', lie2);
  assert.ok(rows[1].costUsd <= price * (3 / 60) + 1e-12 && rows[1].costUsd > 0, String(rows[1].costUsd));
  const real = await (async () => { await a.cloud.stt('helper', 'openai', wav16(1.5)); return rows[2].costUsd; })();
  assert.ok(Math.abs(real - price * (1.5 / 60)) < 1e-9, 'an honest 16 kHz file is priced by its length');
  const huge = cloudMod.wavFromPcm16(Buffer.alloc(10 * MB - 44), 8000);   // 10 MB claiming 8 kHz: 655 s
  await a.cloud.stt('helper', 'openai', huge);
  assert.ok(rows[3].costUsd <= price * (10 * MB / 32000 / 60) + 1e-9, 'capped at the 10 MB maximum (16 kHz) duration: ' + rows[3].costUsd);
  const g = makeCloud({ rows, respond: () => ({ json: geminiText('x') }) });
  await g.cloud.stt('helper', 'google', lie);
  assert.ok(rows[4].costUsd <= cloudMod.PRICES.google.stt * (3 / 60) + 1e-12);
});

test('a timeout while the body is being read is "timeout", not "bad_response"', async () => {
  const rows = [];
  const { cloud } = makeCloud({ rows, timeoutMs: 40, respond: (url, init) => ({ body: hangingBody(init) }) });
  assert.strictEqual(await reasonOf(cloud.stt('helper', 'openai', wav16())), 'timeout');
  assert.strictEqual(await reasonOf(cloud.tts('helper', 'openai', 'hi', 'coral')), 'timeout');
  assert.ok(rows.every(r => r.ok === false));
  const thrower = makeCloud({ respond: () => ({ body: new ReadableStream({ pull() { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); } }) }) });
  assert.strictEqual(await reasonOf(thrower.cloud.tts('helper', 'openai', 'hi', 'coral')), 'timeout');
});

test('a caller that left (isCancelled) aborts the cloud request; one that left before the call sends nothing', async () => {
  let gone = false;
  const rows = [];
  const { cloud, fetchImpl } = makeCloud({ rows, respond: (url, init) => { setTimeout(() => { gone = true; }, 20); return { body: hangingBody(init) }; } });
  assert.strictEqual(await reasonOf(cloud.tts('helper', 'openai', 'hi', 'coral', 1, { isCancelled: () => gone })), 'cancelled');
  assert.strictEqual(fetchImpl.calls[0].init.signal.aborted, true);
  assert.strictEqual(rows[0].ok, false);
  const early = makeCloud({ respond: () => ({ json: { text: 'x' } }) });
  assert.strictEqual(await reasonOf(early.cloud.stt('helper', 'openai', wav16(), { isCancelled: () => true })), 'cancelled');
  assert.strictEqual(early.fetchImpl.calls.length, 0);
});

test('routes: stt and tts hand the route isCancelled to the cloud call', async () => {
  const t = setup({ agents: [{ name: 'helper', voice: CLOUD_OPENAI }], respond: okResponder });
  try {
    const seen = {};
    t.deps.cloud = { stt: async (a, e, au, o) => { seen.stt = o; return { text: 't', ms: 1, engine: e }; }, tts: async (a, e, tx, v, sp, o) => { seen.tts = o; return { wav: Buffer.from('RIFFxxxxWAVE'), ms: 1, engine: e }; }, keys: () => ({}) };
    await t.stt(); await t.tts();
    assert.strictEqual(typeof (seen.stt || {}).isCancelled, 'function', 'stt');
    assert.strictEqual(typeof (seen.tts || {}).isCancelled, 'function', 'tts');
    assert.strictEqual(seen.stt.isCancelled(), false);
  } finally { t.cleanup(); }
});

test('PATCH voice, kept agent: a downgrade (each engine local or the confirmed one) keeps the confirmation without the owner; a new cloud engine needs the owner', async () => {
  const h = loadHub({ agents: [{ name: 'helper' }], settings: { autoClassifier: { keepOnBox: ['helper'] } } });
  const { owner, sam } = twoAdmins(h);
  await h.ag.updateAgentField('helper', { voice: { stt: 'openai', tts: 'google', cloudVoice: 'Puck', cloudConfirm: true } }, ctxFor(h, owner));
  const first = h.readJson().find(a => a.name === 'helper').voice;
  const down = await h.ag.updateAgentField('helper', { voice: { stt: 'local', tts: 'google', cloudVoice: 'Puck' } }, ctxFor(h, sam));
  assert.strictEqual(down.success, true, down.error);
  let v = h.readJson().find(a => a.name === 'helper').voice;
  assert.deepStrictEqual([v.stt, v.tts, v.cloudConfirmedBy, v.cloudConfirmedAt], ['local', 'google', owner.id, first.cloudConfirmedAt]);
  // the confirmation now covers only google for tts: another provider is a new decision, and so is re-adding openai
  assert.strictEqual((await h.ag.updateAgentField('helper', { voice: { stt: 'local', tts: 'openai' } }, ctxFor(h, sam))).error, 'owner_confirmation_required');
  assert.strictEqual((await h.ag.updateAgentField('helper', { voice: { stt: 'openai', tts: 'local' } }, ctxFor(h, sam))).error, 'owner_confirmation_required');
  // both local clears it
  assert.strictEqual((await h.ag.updateAgentField('helper', { voice: { stt: 'local', tts: 'local' } }, ctxFor(h, sam))).success, true);
  v = h.readJson().find(a => a.name === 'helper').voice;
  assert.deepStrictEqual([v.cloudConfirmedBy, v.cloudConfirmedAt], [undefined, undefined]);
});
test('auth.isOwner: in a hub without accounts the signed-in person is the owner; with accounts it is unchanged', () => {
  const h = loadHub({ agents: [{ name: 'helper' }] });
  assert.strictEqual(h.auth.hasUsers(), false);
  assert.strictEqual(h.auth.isOwner({ id: 'legacy', role: 'admin' }), true);
  assert.strictEqual(h.auth.isOwner(null), false, 'nobody signed in');
  const { owner, sam } = twoAdmins(h);
  assert.deepStrictEqual([h.auth.isOwner(owner), h.auth.isOwner(sam), h.auth.isOwner({ id: 'legacy' })], [true, false, false]);
});

test('PATCH voice, no accounts: the legacy signed-in person (ctx.isOwner) may confirm a cloud engine for a kept agent', async () => {
  const h = loadHub({ agents: [{ name: 'helper' }], settings: { autoClassifier: { keepOnBox: ['helper'] } } });
  const legacy = { id: 'legacy', role: 'admin' };
  const r = await h.ag.updateAgentField('helper', { voice: { stt: 'openai', tts: 'local', cloudConfirm: true } }, ctxFor(h, legacy));
  assert.strictEqual(r.success, true, r.error);
  assert.strictEqual(h.readJson().find(a => a.name === 'helper').voice.cloudConfirmedBy, 'legacy');
});

test('GET /api/agents: cloudConfirmedBy and cloudConfirmedAt are stripped for non-admins, kept for admins', () => {
  const a = { name: 'helper', voice: { voice: '', stt: 'openai', tts: 'local', cloudConfirmedBy: 'u_owner', cloudConfirmedAt: '2026-01-01T00:00:00.000Z' } };
  const m = cloudMod.publicAgentVoice(a, false);
  assert.deepStrictEqual(m.voice, { voice: '', stt: 'openai', tts: 'local' });
  assert.strictEqual(a.voice.cloudConfirmedBy, 'u_owner', 'the stored agent is not mutated');
  assert.strictEqual(cloudMod.publicAgentVoice(a, true).voice.cloudConfirmedBy, 'u_owner');
  assert.deepStrictEqual(cloudMod.publicAgentVoice({ name: 'x' }, false), { name: 'x' });
  // server.js applies it to GET /api/agents
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf("pathname === '/api/agents' && req.method === 'GET'");
  assert.ok(src.slice(i, i + 1800).includes('publicAgentVoice(a, isAdm)'));
});

test('OpenAI streamed WAV (RIFF and data sizes 0xFFFFFFFF) is accepted and handed on with the real sizes', async () => {
  const data = Buffer.alloc(24000 * 2 * 0.2, 1);   // 0.2 s at 24 kHz mono
  const streamed = wavWith({ rate: 24000, channels: 1, data, declared: 0xFFFFFFFF });
  streamed.writeUInt32LE(0xFFFFFFFF, 4);
  const rows = []; const { cloud } = makeCloud({ rows, respond: () => ({ bytes: streamed }) });
  const out = await cloud.tts('helper', 'openai', 'hi', 'coral');
  assert.strictEqual(out.sampleRate, 24000);
  assert.strictEqual(out.wav.readUInt32LE(4), out.wav.length - 8, 'RIFF size repaired');
  const w = cloudMod.parseWav(out.wav);
  assert.strictEqual(w.dataSize, data.length, 'data size repaired');
  assert.strictEqual(rows[0].ok, true);
});

test('an HTTP error answer aborts its request (a hanging error body is not kept open)', async () => {
  const { cloud, fetchImpl } = makeCloud({ respond: () => ({ status: 500, body: bigBody(1).body }) });
  assert.strictEqual(await reasonOf(cloud.tts('helper', 'openai', 'hi', 'coral')), 'http_500');
  assert.strictEqual(fetchImpl.calls[0].init.signal.aborted, true);
});
