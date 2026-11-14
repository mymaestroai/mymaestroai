'use strict';
// lib/voice/routes.js with a fake engine and a fake worker client (nothing is downloaded or started), plus the access
// table entries in lib/access.js that decide who reaches which /api/voice route.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const routes = require('../lib/voice/routes');
const access = require('../lib/access');
const manifest = require('../lib/voice/manifest');

const owner = { id: 'u_owner', role: 'admin', name: 'Owner' };
const sam = { id: 'u_sam', role: 'member', name: 'Sam' };
const agents = [{ name: 'maestro' }, { name: 'sam_assistant', owner: 'u_sam', voice: { voice: 'bm_george', stt: 'local', tts: 'local' } }, { name: 'owner_only', owner: 'u_owner' }];

function fakeRes() {
  const chunks = [];
  const r = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  r.writeHead = (code, headers) => { r.statusCode = code; r.headers = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v])); r.headersSent = true; };
  const done = new Promise((resolve) => r.on('finish', resolve));
  r.finished = done;
  r.body = () => Buffer.concat(chunks);
  r.json = () => JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return r;
}
function fakeReq(method, url, { headers = {}, body, user = owner, service = false } = {}) {
  const r = Readable.from(body === undefined ? [] : Array.isArray(body) ? body : [Buffer.isBuffer(body) ? body : Buffer.from(body)]);
  Object.assign(r, { method, url, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), hubUser: user, hubService: service });
  return r;
}

function setup({ enabled = true, ready = true, voices, defaultVoice = 'af_heart', platformSupported = true, error = '', installing = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-routes-'));
  fs.mkdirSync(path.join(dir, 'web'), { recursive: true });
  const settings = { voice: { enabled, defaultVoice: '', sttModel: '' } };
  const calls = { install: [], stt: [], tts: [], stop: 0, resume: 0, update: [] };
  const vs = (voices || manifest.VOICES.map(v => v.id)).map(id => { const v = manifest.VOICES.find(x => x.id === id); return { id, label: v.label, engine: v.engine, accent: v.accent }; });
  const engine = {
    paths: { web: path.join(dir, 'web'), dir, worker: path.join(dir, 'worker.js') },
    status: () => ({ enabled: false, ready, installing, step: ready ? 'ready' : '', progress: ready ? 1 : 0, error, platformSupported, stt: { engine: 'local', model: 'tiny.en' }, tts: { engine: 'local', defaultVoice }, voices: ready ? vs : [] }),
    install: (o) => { calls.install.push(o); return Promise.resolve(); },
  };
  const client = {
    stt: async (buf) => { calls.stt.push(buf.length); return { text: 'turn on the lights', ms: 21 }; },
    tts: async (text, voice, speed) => { calls.tts.push({ text, voice, speed }); return { wav: Buffer.from('RIFF....WAVE'), sampleRate: 24000, ms: 42 }; },
    stop: () => { calls.stop++; },
    resume: () => { calls.resume++; },
  };
  const deps = {
    jsonResponse: (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); },
    readBody: (req) => new Promise((resolve) => { let s = ''; req.on('data', c => { s += c; }); req.on('end', () => resolve(s)); }),
    getSetting: (k, d) => (settings[k] !== undefined ? settings[k] : d),
    updateSettings: (p) => { calls.update.push(p); Object.assign(settings, p); },
    getAgents: async () => agents,
    getVoice: () => ({ engine, client }),
    cloud: { keys: () => ({ openai: false, google: false, elevenlabs: false }) },   // no real settings are read in these tests
  };
  const call = async (req) => { const res = fakeRes(); const u = new URL(req.url, 'http://x'); await routes.handle(u.pathname, req, res, deps); if (!res.writableEnded) await new Promise(r => setTimeout(r, 5)); await res.finished; return res; };
  return { dir, settings, calls, deps, call, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const wavBytes = (n = 64) => { const b = Buffer.alloc(44 + n); b.write('RIFF', 0); b.write('WAVE', 8); return b; };

// ── access table ──
test('access: status and web files are session routes; stt/tts are agent routes (agent from query / body); enable/disable are admin-only', () => {
  const c = (p, m = 'GET') => access.classifyRoute(p, m);
  assert.deepStrictEqual(c('/api/voice/status'), { kind: 'session' });
  assert.deepStrictEqual(c('/api/voice/web/bundle.min.js'), { kind: 'session' });
  assert.deepStrictEqual(c('/api/voice/stt', 'POST'), { kind: 'agent', from: 'query' });
  assert.deepStrictEqual(c('/api/voice/tts', 'POST'), { kind: 'agent', from: 'body' });
  assert.deepStrictEqual(c('/api/voice/enable', 'POST'), { kind: 'admin' });
  assert.deepStrictEqual(c('/api/voice/disable', 'POST'), { kind: 'admin' });
  assert.deepStrictEqual(c('/api/voice/anything-else'), { kind: 'admin' }, 'unknown voice routes stay admin-only');
  assert.deepStrictEqual(c('/api/voice/web/a/b'), { kind: 'admin' }, 'only one path segment is a web file');
  assert.deepStrictEqual(c('/api/voice/stt/'), { kind: 'agent', from: 'query' }, 'trailing slash does not skip the agent check');
});

test('access: a member reaches stt/tts only for agents they may open; an admin for any; a token is not let in', () => {
  const ctx = { agents };
  assert.ok(access.canAccessAgent(sam, 'sam_assistant', ctx));
  assert.ok(!access.canAccessAgent(sam, 'owner_only', ctx));
  assert.ok(access.canAccessAgent(owner, 'owner_only', ctx));
  assert.ok(!access.tokenAllows({ scopes: ['chat', 'interject'], agents: ['sam_assistant'] }, '/api/voice/stt', 'POST', { agent: 'sam_assistant' }).ok);
  assert.ok(!access.tokenAllows({ scopes: ['chat'], agents: ['sam_assistant'] }, '/api/voice/tts', 'POST', { agent: 'sam_assistant' }).ok);
});

// ── status / enable / disable ──
test('GET status: engine status with enabled taken from the voice setting', async () => {
  const t = setup({ enabled: true });
  const r = await t.call(fakeReq('GET', '/api/voice/status', { user: sam }));
  assert.strictEqual(r.statusCode, 200);
  const j = r.json();
  assert.strictEqual(j.enabled, true); assert.strictEqual(j.ready, true); assert.strictEqual(j.voices.length, 6);
  assert.deepStrictEqual(Object.keys(j).sort(), ['cloud', 'enabled', 'error', 'failed', 'installing', 'platformSupported', 'progress', 'ready', 'step', 'stt', 'tts', 'voices']);
  const off = setup({ enabled: false });
  assert.strictEqual((await off.call(fakeReq('GET', '/api/voice/status'))).json().enabled, false);
  t.cleanup(); off.cleanup();
});

test('POST enable (admin): sets the setting, starts the install without waiting for it; disable stops the worker and keeps files', async () => {
  const t = setup({ enabled: false, ready: false });
  t.settings.voice.sttModel = 'small.en';
  const r = await t.call(fakeReq('POST', '/api/voice/enable'));
  assert.strictEqual(r.statusCode, 200); assert.strictEqual(r.json().ok, true); assert.strictEqual(r.json().status.enabled, true);
  assert.strictEqual(t.settings.voice.enabled, true); assert.deepStrictEqual(t.calls.install, [{ sttModel: 'small.en' }]);
  assert.strictEqual(t.settings.voice.sttModel, 'small.en', 'other voice settings survive');
  const d = await t.call(fakeReq('POST', '/api/voice/disable'));
  assert.strictEqual(d.statusCode, 200); assert.strictEqual(t.settings.voice.enabled, false); assert.strictEqual(t.calls.stop, 1);
  assert.strictEqual(t.calls.install.length, 1);
  t.cleanup();
});

test('enable/disable: a member is refused (403) and nothing changes; the hub itself (service) is allowed; unsupported platform is a 400', async () => {
  const t = setup({ enabled: false, ready: false });
  for (const p of ['enable', 'disable']) {
    const r = await t.call(fakeReq('POST', `/api/voice/${p}`, { user: sam }));
    assert.strictEqual(r.statusCode, 403); assert.deepStrictEqual(r.json(), { error: 'admin_only' });
  }
  assert.strictEqual(t.settings.voice.enabled, false); assert.strictEqual(t.calls.install.length, 0); assert.strictEqual(t.calls.stop, 0);
  assert.strictEqual((await t.call(fakeReq('POST', '/api/voice/enable', { user: null, service: true }))).statusCode, 200);
  const u = setup({ enabled: false, ready: false, platformSupported: false });
  const r = await u.call(fakeReq('POST', '/api/voice/enable'));
  assert.strictEqual(r.statusCode, 400); assert.strictEqual(r.json().error, 'platform_unsupported'); assert.strictEqual(u.calls.install.length, 0);
  t.cleanup(); u.cleanup();
});

// ── stt ──
test('POST stt: audio/wav body is read in chunks and answered with { text, ms }; the agent comes from the query or X-Agent', async () => {
  const t = setup();
  const body = wavBytes(1000);
  const r = await t.call(fakeReq('POST', '/api/voice/stt?agent=sam_assistant', { headers: { 'content-type': 'audio/wav', 'content-length': String(body.length) }, body: [body.subarray(0, 300), body.subarray(300)], user: sam }));
  assert.strictEqual(r.statusCode, 200); assert.deepStrictEqual(r.json(), { text: 'turn on the lights', ms: 21, engine: 'local' });   // phase 3: the answer says which engine spoke
  assert.deepStrictEqual(t.calls.stt, [body.length], 'all chunks reassembled');
  const h = await t.call(fakeReq('POST', '/api/voice/stt', { headers: { 'content-type': 'audio/x-wav; charset=binary', 'x-agent': 'maestro' }, body }));
  assert.strictEqual(h.statusCode, 200);
  t.cleanup();
});

test('POST stt: 400 without an agent, 415 for other content types, 409 voice_off when disabled or not ready, 413 over the cap', async () => {
  const t = setup();
  const send = (url, headers, body, over) => t.call(fakeReq('POST', url, { headers, body }));
  let r = await send('/api/voice/stt', { 'content-type': 'audio/wav' }, wavBytes());
  assert.strictEqual(r.statusCode, 400); assert.strictEqual(r.json().error, 'agent_required');
  for (const ct of ['application/json', 'audio/webm', 'text/plain', '']) {
    r = await send('/api/voice/stt?agent=maestro', ct ? { 'content-type': ct } : {}, wavBytes());
    assert.strictEqual(r.statusCode, 415, ct || '(none)'); assert.ok(r.json().error);
  }
  assert.strictEqual(t.calls.stt.length, 0);
  const off = setup({ enabled: false });
  r = await off.call(fakeReq('POST', '/api/voice/stt?agent=maestro', { headers: { 'content-type': 'audio/wav' }, body: wavBytes() }));
  assert.strictEqual(r.statusCode, 409); assert.deepStrictEqual(r.json(), { error: 'voice_off' });
  const notReady = setup({ enabled: true, ready: false });
  r = await notReady.call(fakeReq('POST', '/api/voice/stt?agent=maestro', { headers: { 'content-type': 'audio/wav' }, body: wavBytes() }));
  assert.strictEqual(r.statusCode, 409); assert.strictEqual(r.json().error, 'voice_off');
  assert.strictEqual(off.calls.stt.length + notReady.calls.stt.length, 0);
  // the cap: declared length, and a body that lies about its length
  t.deps.maxAudioBytes = 1000;
  r = await send('/api/voice/stt?agent=maestro', { 'content-type': 'audio/wav', 'content-length': '5000' }, wavBytes(10));
  assert.strictEqual(r.statusCode, 413);
  r = await send('/api/voice/stt?agent=maestro', { 'content-type': 'audio/wav' }, [Buffer.alloc(600), Buffer.alloc(600)]);
  assert.strictEqual(r.statusCode, 413); assert.strictEqual(t.calls.stt.length, 0);
  r = await send('/api/voice/stt?agent=maestro', { 'content-type': 'audio/wav' }, []);
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(routes.MAX_AUDIO_BYTES, 10 * 1024 * 1024, 'default cap is 10 MB');
  t.cleanup(); off.cleanup(); notReady.cleanup();
});

test('POST stt: unreadable audio is a 400 with the reason; an engine failure is a 500 that does not leak details', async () => {
  const t = setup();
  const { engine, client } = t.deps.getVoice();
  client.stt = async () => { const e = new Error('not a WAV file'); e.badAudio = true; throw e; };
  let r = await t.call(fakeReq('POST', '/api/voice/stt?agent=maestro', { headers: { 'content-type': 'audio/wav' }, body: wavBytes() }));
  assert.strictEqual(r.statusCode, 400); assert.strictEqual(r.json().error, 'not a WAV file');
  client.stt = async () => { throw new Error('/secret/path/model.onnx exploded'); };
  const err = console.error; console.error = () => {};
  try { r = await t.call(fakeReq('POST', '/api/voice/stt?agent=maestro', { headers: { 'content-type': 'audio/wav' }, body: wavBytes() })); } finally { console.error = err; }
  assert.strictEqual(r.statusCode, 500); assert.ok(!JSON.stringify(r.json()).includes('secret')); void engine;
  t.cleanup();
});

// ── tts ──
test('POST tts: audio/wav with X-Voice-Ms; voice = given, else the agent\'s, else the setting, else the engine default', async () => {
  const t = setup();
  const post = (b, user = owner) => t.call(fakeReq('POST', '/api/voice/tts', { headers: { 'content-type': 'application/json' }, body: JSON.stringify(b), user }));
  let r = await post({ agent: 'maestro', text: 'Hello there.', voice: 'bf_emma', speed: 1.25 });
  assert.strictEqual(r.statusCode, 200); assert.strictEqual(r.headers['content-type'], 'audio/wav'); assert.strictEqual(r.headers['x-voice-ms'], '42');
  assert.strictEqual(r.body().toString(), 'RIFF....WAVE');
  assert.deepStrictEqual(t.calls.tts[0], { text: 'Hello there.', voice: 'bf_emma', speed: 1.25 });
  await post({ agent: 'sam_assistant', text: 'Hi' }, sam); assert.strictEqual(t.calls.tts[1].voice, 'bm_george', "the agent's own voice");
  await post({ agent: 'maestro', text: 'Hi' }); assert.strictEqual(t.calls.tts[2].voice, 'af_heart', 'engine default');
  t.settings.voice.defaultVoice = 'alba';
  await post({ agent: 'maestro', text: 'Hi' }); assert.strictEqual(t.calls.tts[3].voice, 'alba', 'hub default setting');
  await post({ agent: 'sam_assistant', text: 'Hi' }); assert.strictEqual(t.calls.tts[4].voice, 'bm_george', 'agent voice beats the hub default');
  await post({ agent: 'maestro', text: 'Hi', voice: 'lessac', speed: 9 }); assert.strictEqual(t.calls.tts[5].speed, 2, 'speed is clamped');
  t.cleanup();
});

test('POST tts: the text is cleaned before the engine (markdown and symbols out); text that is only code or symbols is a 400 nothing_to_say', async () => {
  const t = setup();
  const post = (b) => t.call(fakeReq('POST', '/api/voice/tts', { headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }));
  const r = await post({ agent: 'maestro', text: '## Done\n\n- **Fixed** the `bug`, see https://example.com/x\n\n```js\nconst a = 1;\n```' });
  assert.strictEqual(r.statusCode, 200);
  const spoken = t.calls.tts[0].text;
  assert.ok(!/[*`#]|https?:|const a/.test(spoken), spoken);
  assert.ok(spoken.includes('Fixed the bug'), spoken);
  const n = t.calls.tts.length;
  const e = await post({ agent: 'maestro', text: '**' }); assert.strictEqual(e.statusCode, 400); assert.deepStrictEqual(e.json(), { error: 'nothing_to_say' });
  const e2 = await post({ agent: 'maestro', text: '\u{1F600}\u{1F600}' }); assert.strictEqual(e2.statusCode, 400); assert.deepStrictEqual(e2.json(), { error: 'nothing_to_say' });
  assert.strictEqual(t.calls.tts.length, n, 'no engine call for either');
  t.cleanup();
});

test('POST tts: a clean sentence the page already cleaned is passed on as it is (not cut as a list item)', async () => {
  const t = setup();
  const post = (b) => t.call(fakeReq('POST', '/api/voice/tts', { headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }));
  const r = await post({ agent: 'maestro', text: '42. That is the answer.' });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(t.calls.tts[0].text, '42. That is the answer.');
  t.cleanup();
});

test('POST tts: a cleaned sentence with an in-word hyphen keeps its number; a flag emoji is still cleaned', async () => {
  const t = setup();
  const post = (b) => t.call(fakeReq('POST', '/api/voice/tts', { headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }));
  assert.strictEqual((await post({ agent: 'maestro', text: '42. A non‐issue.' })).statusCode, 200);
  assert.strictEqual(t.calls.tts[0].text, '42. A non‐issue.');
  assert.strictEqual((await post({ agent: 'maestro', text: 'Hello \u{1F1FA}\u{1F1F8} there.' })).statusCode, 200);
  assert.ok(!/[\u{1F1E6}-\u{1F1FF}]/u.test(t.calls.tts[1].text), t.calls.tts[1].text);
  t.cleanup();
});

test('voiceSpeechText is idempotent: cleaning already cleaned text gives the same text (so the server may clean what the page cleaned)', () => {
  const { voiceSpeechText } = require('../lib/ui-voice');
  const replies = [
    '## Summary\n\n- **Fixed** the `bug` in [the docs](https://example.com/a), see https://example.com/b.\n- Done.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```',
    'Plain sentence. Another one, with a comma!',
    'I did it \u{1F389} and it worked.',
    '> quoted line\n1. first\n2) second',
    '',
  ];
  for (const md of replies) {
    const once = voiceSpeechText(md);
    assert.strictEqual(voiceSpeechText(once), once, JSON.stringify(md));
  }
});

test('POST tts: a voice that is not installed falls back to the default; an unknown voice id is a 400', async () => {
  const t = setup({ voices: ['lessac', 'alba'], defaultVoice: 'lessac' });
  const post = (b) => t.call(fakeReq('POST', '/api/voice/tts', { headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }));
  await post({ agent: 'sam_assistant', text: 'Hi' });   // the agent wants bm_george, which this machine has not installed
  assert.strictEqual(t.calls.tts[0].voice, 'lessac');
  const r = await post({ agent: 'maestro', text: 'Hi', voice: 'nobody' });
  assert.strictEqual(r.statusCode, 400); assert.strictEqual(r.json().error, 'unknown_voice');
  t.cleanup();
});

test('POST tts: 2000 characters is the limit (413 above), text and agent are required, 409 voice_off, bad JSON is a 400', async () => {
  const t = setup();
  const post = (b, raw) => t.call(fakeReq('POST', '/api/voice/tts', { headers: { 'content-type': 'application/json' }, body: raw !== undefined ? raw : JSON.stringify(b) }));
  assert.strictEqual((await post({ agent: 'maestro', text: 'a'.repeat(2000) })).statusCode, 200);
  const big = await post({ agent: 'maestro', text: 'a'.repeat(2001) });
  assert.strictEqual(big.statusCode, 413); assert.match(big.json().error, /2000/);
  assert.strictEqual((await post({ agent: 'maestro', text: '   ' })).statusCode, 400);
  assert.strictEqual((await post({ agent: 'maestro' })).statusCode, 400);
  assert.strictEqual((await post({ text: 'hi' })).statusCode, 400);
  assert.strictEqual((await post(null, '{nope')).statusCode, 400);
  assert.strictEqual(t.calls.tts.length, 1, 'only the first call reached the voice');
  const off = setup({ enabled: false });
  const r = await off.call(fakeReq('POST', '/api/voice/tts', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'maestro', text: 'hi' }) }));
  assert.strictEqual(r.statusCode, 409); assert.deepStrictEqual(r.json(), { error: 'voice_off' });
  t.cleanup(); off.cleanup();
});

test('POST tts: an engine failure is a 500 without details; the text is never logged', async () => {
  const t = setup();
  t.deps.getVoice().client.tts = async () => { throw new Error('boom at /secret/model'); };
  const logs = [];
  const ol = console.log, oe = console.error; console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' '));
  let r;
  try {
    r = await t.call(fakeReq('POST', '/api/voice/tts', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'maestro', text: 'my private sentence' }) }));
    t.deps.getVoice().client.tts = async () => ({ wav: Buffer.from('RIFF'), sampleRate: 1, ms: 1 });
    await t.call(fakeReq('POST', '/api/voice/tts', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'maestro', text: 'my private sentence' }) }));
    t.deps.getVoice().client.stt = async () => ({ text: 'my private transcript', ms: 1 });
    await t.call(fakeReq('POST', '/api/voice/stt?agent=maestro', { headers: { 'content-type': 'audio/wav' }, body: wavBytes() }));
  } finally { console.log = ol; console.error = oe; }
  assert.strictEqual(r.statusCode, 500); assert.ok(!JSON.stringify(r.json()).includes('secret'));
  assert.ok(logs.length > 0 && !logs.join('\n').match(/private/), 'metadata only');
  t.cleanup();
});

// ── status: default voice, errors ──
test('GET status: the default voice is the saved one when installed, else the installer\'s; installDefaultVoice is always the installer\'s', async () => {
  const t = setup({ defaultVoice: 'af_heart' });
  let j = (await t.call(fakeReq('GET', '/api/voice/status', { user: sam }))).json();
  assert.strictEqual(j.tts.defaultVoice, 'af_heart'); assert.strictEqual(j.tts.installDefaultVoice, 'af_heart');
  t.settings.voice.defaultVoice = 'alba';   // an admin saved another default
  j = (await t.call(fakeReq('GET', '/api/voice/status', { user: sam }))).json();
  assert.strictEqual(j.tts.defaultVoice, 'alba'); assert.strictEqual(j.tts.installDefaultVoice, 'af_heart');
  const few = setup({ voices: ['lessac'], defaultVoice: 'lessac' });
  few.settings.voice.defaultVoice = 'alba';   // saved but not installed here
  j = (await few.call(fakeReq('GET', '/api/voice/status'))).json();
  assert.strictEqual(j.tts.defaultVoice, 'lessac');
  // the voice that speaks is the same one the picker shows
  const r = await t.call(fakeReq('POST', '/api/voice/tts', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'maestro', text: 'Hi' }) }));
  assert.strictEqual(r.headers['x-voice'], 'alba');
  t.cleanup(); few.cleanup();
});

test('GET status: the error text goes to admins only; members get error null and failed true', async () => {
  const t = setup({ ready: false, error: 'download failed at /srv/app/data/voice/x from https://host.invalid/a' });
  const m = (await t.call(fakeReq('GET', '/api/voice/status', { user: sam }))).json();
  assert.strictEqual(m.error, null); assert.strictEqual(m.failed, true);
  assert.ok(!JSON.stringify(m).includes('/srv/app'));
  const a = (await t.call(fakeReq('GET', '/api/voice/status', { user: owner }))).json();
  assert.match(a.error, /download failed/); assert.strictEqual(a.failed, true);
  const svc = (await t.call(fakeReq('GET', '/api/voice/status', { user: null, service: true }))).json();
  assert.match(svc.error, /download failed/);
  const ok = setup({});
  const j = (await ok.call(fakeReq('GET', '/api/voice/status', { user: sam }))).json();
  assert.strictEqual(j.failed, false); assert.strictEqual(j.error, '');
  t.cleanup(); ok.cleanup();
});

// ── disable while a request is in flight ──
const wavOf = (n = 1600, rate = 16000) => { const b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(3000 * Math.sin(i / 5)), 44 + i * 2); return b; };
/** A request whose body arrives when the test says so. */
function slowReq(method, url, headers, user = owner) {
  const r = new Readable({ read() {} });
  Object.assign(r, { method, url, headers, hubUser: user, hubService: false });
  return r;
}

test('disable while an upload is still arriving: the finished upload is answered 409 voice_off and never reaches the worker', async () => {
  const { createVoiceClient } = require('../lib/voice/client');
  const t = setup();
  let spawned = 0;
  const eng = t.deps.getVoice().engine;
  const real = createVoiceClient({ engine: eng, idleMs: 0, spawnImpl: () => { spawned++; throw new Error('must not start'); } });
  t.deps.getVoice = () => ({ engine: eng, client: real });
  const wav = wavOf();
  const req = slowReq('POST', '/api/voice/stt?agent=maestro', { 'content-type': 'audio/wav' });
  const res = fakeRes();
  const done = routes.handle('/api/voice/stt', req, res, t.deps);
  req.push(wav.subarray(0, 100));
  await new Promise(r => setTimeout(r, 10));
  const d = await t.call(fakeReq('POST', '/api/voice/disable'));   // the admin turns voice off mid-upload
  assert.strictEqual(d.statusCode, 200);
  req.push(wav.subarray(100)); req.push(null);
  await done; await res.finished;
  assert.strictEqual(res.statusCode, 409); assert.deepStrictEqual(res.json(), { error: 'voice_off' });
  assert.strictEqual(spawned, 0, 'no worker was started');
  assert.strictEqual(t.calls.stt.length, 0);
  real.stop();
});

test('disable then enable while an upload is still arriving: the finished upload is still answered 409 voice_off and the worker is never asked', async () => {
  const { createVoiceClient } = require('../lib/voice/client');
  const t = setup();
  let spawned = 0;
  const eng = t.deps.getVoice().engine;
  const real = createVoiceClient({ engine: eng, idleMs: 0, spawnImpl: () => { spawned++; throw new Error('must not start'); } });
  t.deps.getVoice = () => ({ engine: eng, client: real });
  const wav = wavOf();
  const req = slowReq('POST', '/api/voice/stt?agent=maestro', { 'content-type': 'audio/wav' });
  const res = fakeRes();
  const done = routes.handle('/api/voice/stt', req, res, t.deps);
  req.push(wav.subarray(0, 100));
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual((await t.call(fakeReq('POST', '/api/voice/disable'))).statusCode, 200);
  assert.strictEqual((await t.call(fakeReq('POST', '/api/voice/enable'))).statusCode, 200);
  assert.strictEqual(t.settings.voice.enabled, true, 'voice is on again when the upload finishes');
  req.push(wav.subarray(100)); req.push(null);
  await done; await res.finished;
  assert.strictEqual(res.statusCode, 409); assert.deepStrictEqual(res.json(), { error: 'voice_off' });
  assert.strictEqual(spawned, 0, 'no worker was started');
  assert.strictEqual(t.calls.stt.length, 0);
  real.stop();
});

test('disable then enable while the agent list is being read: tts is still answered 409 voice_off and the worker is never asked', async () => {
  const { createVoiceClient } = require('../lib/voice/client');
  const t = setup();
  let spawned = 0;
  const eng = t.deps.getVoice().engine;
  const real = createVoiceClient({ engine: eng, idleMs: 0, spawnImpl: () => { spawned++; throw new Error('must not start'); } });
  t.deps.getVoice = () => ({ engine: eng, client: real });
  let release; const gate = new Promise(r => { release = r; });
  t.deps.getAgents = async () => { await gate; return agents; };
  const res = fakeRes();
  const done = routes.handle('/api/voice/tts', fakeReq('POST', '/api/voice/tts', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'maestro', text: 'Hi' }) }), res, t.deps);
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual((await t.call(fakeReq('POST', '/api/voice/disable'))).statusCode, 200);
  assert.strictEqual((await t.call(fakeReq('POST', '/api/voice/enable'))).statusCode, 200);
  assert.strictEqual(t.settings.voice.enabled, true);
  release(); await done; await res.finished;
  assert.strictEqual(res.statusCode, 409); assert.deepStrictEqual(res.json(), { error: 'voice_off' });
  assert.strictEqual(spawned, 0, 'no worker was started');
  assert.strictEqual(t.calls.tts.length, 0);
  real.stop();
});

test('disable while the agent list is being read: tts is answered 409 and does not run', async () => {
  const t = setup();
  let release; const gate = new Promise(r => { release = r; });
  t.deps.getAgents = async () => { await gate; return agents; };
  const res = fakeRes();
  const done = routes.handle('/api/voice/tts', fakeReq('POST', '/api/voice/tts', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'maestro', text: 'Hi' }) }), res, t.deps);
  await new Promise(r => setTimeout(r, 10));
  t.settings.voice.enabled = false;
  release(); await done; await res.finished;
  assert.strictEqual(res.statusCode, 409); assert.strictEqual(t.calls.tts.length, 0);
  t.cleanup();
});

test('a voice_off rejection from the client is a 409 on both stt and tts', async () => {
  const t = setup();
  const c = t.deps.getVoice().client;
  const off = async () => { throw Object.assign(new Error('voice engine stopped'), { code: 'voice_off' }); };
  c.stt = off; c.tts = off;
  let r = await t.call(fakeReq('POST', '/api/voice/stt?agent=maestro', { headers: { 'content-type': 'audio/wav' }, body: wavBytes() }));
  assert.strictEqual(r.statusCode, 409); assert.deepStrictEqual(r.json(), { error: 'voice_off' });
  r = await t.call(fakeReq('POST', '/api/voice/tts', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'maestro', text: 'Hi' }) }));
  assert.strictEqual(r.statusCode, 409); assert.deepStrictEqual(r.json(), { error: 'voice_off' });
  t.cleanup();
});

test('enable after disable resumes the client: requests run again (real client, fake worker)', async () => {
  const { createVoiceClient } = require('../lib/voice/client');
  const { EventEmitter } = require('node:events');
  const t = setup({ enabled: true });
  const spawns = [];
  const spawnImpl = () => {
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.kill = () => {}; spawns.push(c);
    c.stdin = new EventEmitter();
    c.stdin.write = (s) => { const m = JSON.parse(s); setImmediate(() => c.stdout.emit('data', Buffer.from(JSON.stringify({ id: m.id, ok: true, text: 'hello', ms: 3 }) + '\n'))); };
    return c;
  };
  const eng = t.deps.getVoice().engine;
  const real = createVoiceClient({ engine: eng, idleMs: 0, spawnImpl });
  t.deps.getVoice = () => ({ engine: eng, client: real });
  const stt = () => t.call(fakeReq('POST', '/api/voice/stt?agent=maestro', { headers: { 'content-type': 'audio/wav' }, body: wavOf() }));
  assert.strictEqual((await stt()).statusCode, 200);
  await t.call(fakeReq('POST', '/api/voice/disable'));
  assert.strictEqual((await stt()).statusCode, 409);
  const n = spawns.length;
  await t.call(fakeReq('POST', '/api/voice/enable'));
  const r = await stt();
  assert.strictEqual(r.statusCode, 200); assert.strictEqual(r.json().text, 'hello'); assert.strictEqual(spawns.length, n + 1);
  real.stop(); t.cleanup();
});

// ── busy / cancelled ──
test('voice_busy from the client is a 503 with Retry-After: 5, on stt and tts', async () => {
  const t = setup();
  const c = t.deps.getVoice().client;
  const busy = async () => { throw Object.assign(new Error('voice engine is busy'), { code: 'voice_busy' }); };
  c.stt = busy; c.tts = busy;
  let r = await t.call(fakeReq('POST', '/api/voice/stt?agent=maestro', { headers: { 'content-type': 'audio/wav' }, body: wavBytes() }));
  assert.strictEqual(r.statusCode, 503); assert.deepStrictEqual(r.json(), { error: 'voice_busy' }); assert.strictEqual(r.headers['retry-after'], '5');
  r = await t.call(fakeReq('POST', '/api/voice/tts', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'maestro', text: 'Hi' }) }));
  assert.strictEqual(r.statusCode, 503); assert.strictEqual(r.headers['retry-after'], '5');
  t.cleanup();
});

test('the routes hand the client a cancellation check that turns true when the caller disconnects before the answer', async () => {
  const t = setup();
  const c = t.deps.getVoice().client;
  const seen = [];
  c.stt = async (buf, rate, opts) => { seen.push(opts.isCancelled()); res.emit('close'); seen.push(opts.isCancelled()); return { text: 'x', ms: 1 }; };
  c.tts = async (text, voice, speed, opts) => { seen.push(typeof opts.isCancelled === 'function' && opts.isCancelled()); return { wav: Buffer.from('RIFF'), sampleRate: 1, ms: 1 }; };
  const res = fakeRes();
  await routes.handle('/api/voice/stt', fakeReq('POST', '/api/voice/stt?agent=maestro', { headers: { 'content-type': 'audio/wav' }, body: wavBytes() }), res, t.deps);
  assert.deepStrictEqual(seen, [false, true], 'false while connected, true after the connection closed unanswered');
  await t.call(fakeReq('POST', '/api/voice/tts', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'maestro', text: 'Hi' }) }));
  assert.strictEqual(seen[2], false);
  // a request the client dropped as cancelled gets no answer body and does not throw
  c.stt = async () => { throw Object.assign(new Error('request cancelled'), { code: 'voice_cancelled' }); };
  const r = await t.call(fakeReq('POST', '/api/voice/stt?agent=maestro', { headers: { 'content-type': 'audio/wav' }, body: wavBytes() }));
  assert.strictEqual(r.body().length, 0);
  t.cleanup();
});

// ── resume an interrupted install ──
test('resumeIfNeeded: installs when enabled and not ready; does nothing when disabled, ready or already installing; never throws', async () => {
  const mk = (settingsVoice, st) => { const calls = []; const logs = []; return { calls, logs, deps: { getSetting: () => settingsVoice, getVoice: () => ({ engine: { status: () => st, install: (o) => { calls.push(o); return Promise.resolve(); } } }), log: (m) => logs.push(m) } }; };
  let x = mk({ enabled: true, sttModel: 'small.en' }, { ready: false, installing: false });
  assert.strictEqual(routes.resumeIfNeeded(x.deps), true); assert.deepStrictEqual(x.calls, [{ sttModel: 'small.en' }]);
  x = mk({ enabled: true }, { ready: false, installing: false }); routes.resumeIfNeeded(x.deps); assert.deepStrictEqual(x.calls, [{ sttModel: undefined }]);
  for (const [sv, st] of [[{ enabled: false }, { ready: false, installing: false }], [undefined, { ready: false, installing: false }], [{ enabled: true }, { ready: true, installing: false }], [{ enabled: true }, { ready: false, installing: true }]]) {
    x = mk(sv, st); assert.strictEqual(routes.resumeIfNeeded(x.deps), false); assert.strictEqual(x.calls.length, 0);
  }
  // a failing install is logged on one line, not thrown (sync or async)
  const logs = [];
  const bad = { getSetting: () => ({ enabled: true }), getVoice: () => ({ engine: { status: () => ({ ready: false, installing: false }), install: () => Promise.reject(new Error('no network')) } }), log: (m) => logs.push(m) };
  routes.resumeIfNeeded(bad); await new Promise(r => setTimeout(r, 5));
  assert.ok(logs.some(l => /no network/.test(l)));
  const bad2 = { getSetting: () => ({ enabled: true }), getVoice: () => { throw new Error('boom'); }, log: (m) => logs.push(m) };
  assert.doesNotThrow(() => routes.resumeIfNeeded(bad2));
  assert.doesNotThrow(() => routes.resumeIfNeeded());
});

test('enable calls the client resume before installing', async () => {
  const t = setup({ enabled: false, ready: false });
  await t.call(fakeReq('POST', '/api/voice/enable'));
  assert.strictEqual(t.calls.resume, 1); assert.strictEqual(t.calls.install.length, 1);
  t.cleanup();
});

// ── web files ──
test('GET web: only the six listed files, with the right content types; anything else is a 404; no path traversal', async () => {
  const t = setup();
  const types = { 'bundle.min.js': 'text/javascript', 'vad.worklet.bundle.min.js': 'text/javascript', 'ort.wasm.min.js': 'text/javascript', 'ort-wasm-simd-threaded.mjs': 'text/javascript', 'ort-wasm-simd-threaded.wasm': 'application/wasm', 'silero_vad_v5.onnx': 'application/octet-stream' };
  assert.deepStrictEqual(Object.keys(types).sort(), Object.keys(manifest.WEB_FILES).sort());
  for (const [n, ct] of Object.entries(types)) {
    fs.writeFileSync(path.join(t.dir, 'web', n), 'content of ' + n);
    const r = await t.call(fakeReq('GET', `/api/voice/web/${n}`, { user: sam }));
    assert.strictEqual(r.statusCode, 200, n); assert.ok(r.headers['content-type'].startsWith(ct), `${n}: ${r.headers['content-type']}`);
    assert.strictEqual(r.body().toString(), 'content of ' + n); assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
  }
  fs.writeFileSync(path.join(t.dir, 'web', 'extra.js'), 'x'); fs.writeFileSync(path.join(t.dir, 'secret.txt'), 'top secret');
  for (const bad of ['extra.js', '..%2Fsecret.txt', '%2e%2e%2fsecret.txt', '../secret.txt', 'bundle.min.js%00.png', 'BUNDLE.MIN.JS', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '%E0%A4%A']) {
    const r = await t.call(fakeReq('GET', `/api/voice/web/${bad}`));
    assert.strictEqual(r.statusCode, 404, bad); assert.ok(!r.body().toString().includes('secret'), bad);
  }
  const sub = await t.call(fakeReq('GET', '/api/voice/web/a/bundle.min.js')); assert.strictEqual(sub.statusCode, 404);
  fs.rmSync(path.join(t.dir, 'web', 'bundle.min.js'));
  assert.strictEqual((await t.call(fakeReq('GET', '/api/voice/web/bundle.min.js'))).statusCode, 404, 'listed but not installed');
  t.cleanup();
});

test('unknown voice routes are 404, wrong methods 405; every answer is JSON {error}', async () => {
  const t = setup();
  let r = await t.call(fakeReq('GET', '/api/voice/nothing')); assert.strictEqual(r.statusCode, 404); assert.ok(r.json().error);
  r = await t.call(fakeReq('GET', '/api/voice/stt')); assert.strictEqual(r.statusCode, 405); assert.ok(r.json().error);
  r = await t.call(fakeReq('POST', '/api/voice/status')); assert.strictEqual(r.statusCode, 405);
  r = await t.call(fakeReq('POST', '/api/voice/web/bundle.min.js')); assert.strictEqual(r.statusCode, 404);
  t.cleanup();
});
