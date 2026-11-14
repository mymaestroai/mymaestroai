'use strict';
// Call recordings and the voice routes (lib/voice/routes.js, lib/voice/call.js): the start hook, the finish hooks, the local-recognizer
// rule and the speech-to-text guard. A fake engine and client (nothing is downloaded), a real store in a temp folder, a real call registry.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Every lib/ module is loaded from a throwaway copy of the install (test/helpers/isolated-install.js), so nothing it reads or
// writes under data/ (users.json, settings.json, push subscriptions ...) is the real install's.
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('rec-call-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const { Readable, Writable } = require('node:stream');
const routes = L('voice/routes');
const recIndex = L('recordings');
const { createStore } = L('recordings/store');
const { deriveKey } = L('recordings/crypt');
const { createVoiceCalls } = L('voice/call');
const manifest = L('voice/manifest');

const KEY = deriveKey(Buffer.alloc(32, 9));
const sam = { id: 'u_0000000000b2', role: 'member', name: 'Sam' };
const patientA = { id: 'u_0000000000c3', role: 'member', name: 'Patient A' };
const REC = { keep: true, allowed: [sam.id], keepReplies: true, consentLine: 'This is being recorded for the family.', mic: 'unprocessed' };

function fakeRes() {
  const chunks = [];
  const r = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  r.writeHead = (code, headers) => { r.statusCode = code; r.headers = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v])); r.headersSent = true; };
  r.finished = new Promise((resolve) => r.on('finish', resolve));
  r.json = () => JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return r;
}
function fakeReq(method, url, { headers = {}, body, user = patientA } = {}) {
  const r = Readable.from(body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(r, { method, url, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), hubUser: user, hubService: false });
  return r;
}
const wavBytes = (n = 64) => { const b = Buffer.alloc(44 + n); b.write('RIFF', 0); b.write('WAVE', 8); return b; };

function setup({ agentExtra = {}, ready = true, storeOverride = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-call-'));
  const clock = { t: Date.UTC(2026, 10, 13, 22, 0, 0) };
  const store = storeOverride || createStore({ root: path.join(dir, 'call-recordings'), key: KEY, now: () => clock.t });
  recIndex.setStoreForTests(store);
  const events = [];
  const calls = createVoiceCalls({ now: () => clock.t, bus: { publish: (type, data) => events.push([type, data]) } });
  const settings = { voice: { enabled: true, defaultVoice: '', sttModel: '' } };
  const cloudCalls = []; const localCalls = [];
  const agents = [{ name: 'biographer', owner: sam.id, voice: { voice: 'bm_george', stt: 'local', tts: 'local' }, recordings: REC, ...agentExtra }];
  const engine = {
    paths: { web: dir, dir, worker: path.join(dir, 'w.js') },
    status: () => ({ enabled: true, ready, installing: false, step: 'ready', progress: 1, error: '', platformSupported: true, stt: { engine: 'local', model: 'tiny.en' }, tts: { engine: 'local', defaultVoice: 'af_heart' }, voices: [] }),
    install: () => Promise.resolve(),
  };
  const client = { stt: async (buf) => { localCalls.push(buf.length); return { text: 'hello from the local engine', ms: 5 }; }, tts: async () => ({ wav: Buffer.from('RIFF'), ms: 1 }), stop() {}, resume() {} };
  const deps = {
    jsonResponse: (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); },
    readBody: (req) => new Promise((resolve) => { let s = ''; req.on('data', c => { s += c; }); req.on('end', () => resolve(s)); }),
    getSetting: (k, d) => (settings[k] !== undefined ? settings[k] : d),
    updateSettings: () => {},
    getAgents: async () => agents,
    getVoice: () => ({ engine, client }),
    voiceCall: calls,
    cloud: { keys: () => ({}), stt: async (agent, eng) => { cloudCalls.push([agent, eng]); return { text: 'from the cloud', ms: 1, engine: eng }; } },
  };
  const call = async (req) => { const res = fakeRes(); const u = new URL(req.url, 'http://x'); await routes.handle(u.pathname, req, res, deps); if (!res.writableEnded) await new Promise(r => setTimeout(r, 5)); await res.finished; return res; };
  const start = (extra = {}, user = patientA) => call(fakeReq('POST', '/api/voice/call', { user, headers: { 'content-type': 'application/json' }, body: { action: 'start', agent: 'biographer', ...extra } }));
  const act = (action, callId, user = patientA) => call(fakeReq('POST', '/api/voice/call', { user, headers: { 'content-type': 'application/json' }, body: { action, agent: 'biographer', callId } }));
  const stt = (query = 'agent=biographer') => call(fakeReq('POST', `/api/voice/stt?${query}`, { user: patientA, headers: { 'content-type': 'audio/wav' }, body: wavBytes() }));
  return { dir, clock, store, calls, events, agents, settings, cloudCalls, localCalls, call, start, act, stt, cleanup: () => { recIndex.setStoreForTests(null); } };
}
const settle = () => new Promise(r => setTimeout(r, 25));
const sessions = async (store) => (await store.listAgents()).length ? store.listSessions('biographer') : [];

test('keep on with a cloud recognizer: 409 recording_needs_local_stt and no call is started', async () => {
  for (const stt of ['openai', 'google']) {
    const t = setup({ agentExtra: { voice: { voice: 'bm_george', stt, tts: 'local' } } });
    const r = await t.start();
    assert.strictEqual(r.statusCode, 409);
    assert.deepStrictEqual(r.json(), { error: 'recording_needs_local_stt' });
    assert.strictEqual(t.calls.statusOf('biographer'), null, 'no call');
    assert.deepStrictEqual(t.events, [], 'nothing was published');
    assert.deepStrictEqual(await sessions(t.store), [], 'no session');
    t.cleanup();
  }
});

test('keep on with the local recognizer: the session is created and the answer carries the recording', async () => {
  const t = setup();
  const r = await t.start({ device: { userAgent: 'TestAgent/1.0', micLabel: 'Test mic', sampleRate: 48000 } });
  assert.strictEqual(r.statusCode, 200);
  const a = r.json();
  assert.strictEqual(a.ok, true);
  assert.ok(a.call.callId);
  assert.deepStrictEqual(Object.keys(a.recording).sort(), ['consentLine', 'keepReplies', 'mic', 'sessionId']);
  assert.strictEqual(a.recording.consentLine, REC.consentLine);
  assert.strictEqual(a.recording.keepReplies, true);
  assert.strictEqual(a.recording.mic, 'unprocessed');
  const m = await t.store.readManifest('biographer', a.recording.sessionId);
  assert.strictEqual(m.userId, patientA.id);
  assert.strictEqual(m.callId, a.call.callId);
  assert.strictEqual(m.keepReplies, true);
  assert.strictEqual(m.consentLine, REC.consentLine);
  assert.deepStrictEqual(m.device, { userAgent: 'TestAgent/1.0', micLabel: 'Test mic', sampleRate: 48000 });
  assert.strictEqual(m.endedAt, null);
  const live = t.calls.recordingOf('biographer');
  assert.deepStrictEqual(live, { callId: a.call.callId, userId: patientA.id, sessionId: a.recording.sessionId, paused: false, keepReplies: true, mic: 'unprocessed' });
  // the recording state is internal: not in the view, the heartbeat, the status or any published event
  const hb = await t.act('heartbeat', a.call.callId);
  for (const [label, text] of [['start call', JSON.stringify(a.call)], ['heartbeat', JSON.stringify(hb.json())], ['statusOf', JSON.stringify(t.calls.statusOf('biographer'))], ['events', JSON.stringify(t.events)], ['info', JSON.stringify(t.calls.info('biographer'))]]) {
    assert.ok(!/sessionId|recording|paused|consent/i.test(text), label + ' has no recording state');
  }
  assert.ok(!('recording' in hb.json()), 'a heartbeat answer has no recording key');
  t.cleanup();
});

test('a failing store keeps the call, answers recording_unavailable and logs one line without text', async () => {
  const boom = Object.assign(new Error('disk says: secret words'), { code: 'EACCES' });
  const t = setup({ storeOverride: { createSession: async () => { throw boom; }, finish: async () => {} } });
  const lines = []; const orig = console.log; console.log = (...a) => lines.push(a.join(' '));
  let r;
  try { r = await t.start(); } finally { console.log = orig; }
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(r.json().recording, { error: 'recording_unavailable' });
  assert.ok(r.json().call.callId);
  assert.ok(t.calls.statusOf('biographer'), 'the call stays');
  assert.strictEqual(t.calls.recordingOf('biographer'), null);
  assert.deepStrictEqual(lines.filter(l => l.startsWith('[recordings]')), ['[recordings] could not start a session for biographer: EACCES']);
  assert.ok(!lines.join('\n').includes('secret words'));
  t.cleanup();
});

test('ending the call finishes its session; so does expiry; a reload start finishes the previous one', async () => {
  const t = setup();
  // end
  let a = (await t.start()).json();
  assert.strictEqual((await t.store.readManifest('biographer', a.recording.sessionId)).endedAt, null);
  const ended = await t.act('end', a.call.callId);
  assert.strictEqual(ended.statusCode, 200);
  await settle();
  const m1 = await t.store.readManifest('biographer', a.recording.sessionId);
  assert.strictEqual(m1.endedAt, new Date(t.clock.t).toISOString());
  assert.strictEqual(t.calls.recordingOf('biographer'), null);
  assert.deepStrictEqual(t.calls.recentRecording('biographer', a.call.callId), { agent: 'biographer', userId: patientA.id, sessionId: a.recording.sessionId, keepReplies: true, endedAt: m1.endedAt }, 'kept in memory for a transcript that arrives just after');
  assert.strictEqual(t.calls.recentRecording('biographer', 'call-other'), null);
  assert.strictEqual(t.calls.recentRecording('helper', a.call.callId), null);
  t.clock.t += 59 * 60 * 1000;
  assert.ok(t.calls.recentRecording('biographer', a.call.callId), 'still kept after 59 minutes');
  t.clock.t += 60 * 1000 + 1;
  assert.strictEqual(t.calls.recentRecording('biographer', a.call.callId), null, 'forgotten after 60 minutes');

  // expiry (no heartbeat for a minute)
  t.clock.t += 1000;
  a = (await t.start()).json();
  t.clock.t += 61 * 1000;
  assert.deepStrictEqual(t.calls.sweep(), ['biographer']);
  await settle();
  assert.notStrictEqual((await t.store.readManifest('biographer', a.recording.sessionId)).endedAt, null, 'expiry finished the session');

  // a reload: the same person starts again
  t.clock.t += 1000;
  const first = (await t.start()).json();
  t.clock.t += 5000;
  const second = (await t.start()).json();
  await settle();
  assert.notStrictEqual(first.call.callId, second.call.callId);
  assert.notStrictEqual(first.recording.sessionId, second.recording.sessionId);
  const m = await t.store.readManifest('biographer', first.recording.sessionId);
  assert.notStrictEqual(m.endedAt, null, 'the earlier call\'s session is finished');
  assert.strictEqual((await t.store.readManifest('biographer', second.recording.sessionId)).endedAt, null, 'the new one is open');
  assert.strictEqual(t.calls.recordingOf('biographer').sessionId, second.recording.sessionId);
  t.cleanup();
});

test('someone else starting while a call is on is refused and records nothing', async () => {
  const t = setup();
  const a = (await t.start()).json();
  const r = await t.start({}, sam);
  assert.strictEqual(r.statusCode, 403);
  assert.strictEqual((await t.store.listSessions('biographer')).length, 1, 'no second session');
  assert.strictEqual(t.calls.recordingOf('biographer').sessionId, a.recording.sessionId);
  t.cleanup();
});

test('keep off: the answer has no recording key and no session is created', async () => {
  for (const rec of [undefined, { ...REC, keep: false }]) {
    const t = setup({ agentExtra: { recordings: rec } });
    const r = await t.start();
    assert.strictEqual(r.statusCode, 200);
    const a = r.json();
    assert.deepStrictEqual(Object.keys(a).sort(), ['call', 'ok']);
    assert.ok(!('recording' in a));
    assert.deepStrictEqual(Object.keys(a.call).sort(), ['callId', 'held', 'mode', 'person', 'since']);
    assert.deepStrictEqual(await t.store.listAgents(), [], 'no session, no folder content');
    assert.strictEqual(t.calls.recordingOf('biographer'), null);
    const hb = (await t.act('heartbeat', a.call.callId)).json();
    assert.deepStrictEqual(Object.keys(hb).sort(), ['call', 'ok']);
    const end = (await t.act('end', a.call.callId)).json();
    assert.deepStrictEqual(end, { ok: true, held: [] });
    // keep off with a cloud recognizer starts as always
    t.cleanup();
  }
  const t = setup({ agentExtra: { recordings: { ...REC, keep: false }, voice: { voice: 'bm_george', stt: 'openai', tts: 'local' } } });
  const r = await t.start();
  assert.strictEqual(r.statusCode, 200);
  assert.ok(!('recording' in r.json()));
  t.cleanup();
});

test('a start with a bad mode is still refused first, and an unrecorded call finishing touches no store', async () => {
  const t = setup({ agentExtra: { recordings: undefined }, storeOverride: new Proxy({}, { get() { throw new Error('the store must not be used'); } }) });
  const r = await t.start({ mode: 'weird' });
  assert.strictEqual(r.statusCode, 400);
  const a = (await t.start()).json();
  assert.strictEqual((await t.act('end', a.call.callId)).statusCode, 200);
  await settle();
  t.cleanup();
});

// ── the speech-to-text guard ──
test('stt: an agent whose calls are recorded never reaches a cloud engine, even a confirmed one', async () => {
  const t = setup({ agentExtra: { voice: { voice: 'bm_george', stt: 'openai', tts: 'local', cloudConfirmedBy: sam.id } } });
  let r = await t.stt();
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.json().engine, 'local');
  assert.strictEqual(r.json().text, 'hello from the local engine');
  assert.strictEqual(r.headers['x-voice-engine'], 'local');
  assert.ok(!r.headers['x-voice-fallback'], 'no fallback: the cloud branch was never entered');
  assert.deepStrictEqual(t.cloudCalls, []);
  assert.strictEqual(t.localCalls.length, 1);
  // the same with Google
  t.agents[0].voice = { voice: 'bm_george', stt: 'google', tts: 'local' };
  r = await t.stt();
  assert.strictEqual(r.json().engine, 'local');
  assert.deepStrictEqual(t.cloudCalls, []);
  t.cleanup();
});

test('stt: when the local engine is not usable a recorded agent gets 409 voice_off, never the cloud', async () => {
  const t = setup({ ready: false, agentExtra: { voice: { voice: 'bm_george', stt: 'openai', tts: 'local' } } });
  const r = await t.stt();
  assert.strictEqual(r.statusCode, 409);
  assert.deepStrictEqual(r.json(), { error: 'voice_off' });
  assert.deepStrictEqual(t.cloudCalls, []);
  t.cleanup();
});

test('stt: a recorded call in progress keeps the engine local even after the setting is switched off and a cloud engine chosen', async () => {
  const t = setup({ agentExtra: { voice: { voice: 'bm_george', stt: 'local', tts: 'local' } } });
  const a = (await t.start()).json();
  assert.ok(a.recording.sessionId, 'a recorded call');
  // the admin switches keeping off and picks a cloud engine while the call goes on
  t.agents[0].recordings = undefined;
  t.agents[0].voice = { voice: 'bm_george', stt: 'openai', tts: 'local', cloudConfirmedBy: sam.id };
  let r = await t.stt();
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.json().engine, 'local', 'still local while the recorded call lasts');
  assert.deepStrictEqual(t.cloudCalls, []);
  // after hang-up the setting rules again
  await t.act('end', a.call.callId);
  r = await t.stt();
  assert.strictEqual(r.json().engine, 'openai');
  assert.deepStrictEqual(t.cloudCalls, [['biographer', 'openai']]);
  t.cleanup();
});

test('start: a service call or an API token never starts a recorded call (403 recording_needs_person), and nothing is created', async () => {
  const t = setup();
  for (const who of [{ hubService: true, user: null }, { hubToken: { id: 'tok1' }, user: null }]) {
    const req = fakeReq('POST', '/api/voice/call', { user: who.user, headers: { 'content-type': 'application/json' }, body: { action: 'start', agent: 'biographer' } });
    Object.assign(req, { hubService: !!who.hubService, hubToken: who.hubToken || null });
    const res = await t.call(req);
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(res.json(), { error: 'recording_needs_person' });
  }
  assert.strictEqual(t.calls.statusOf('biographer'), null, 'no call was started');
  assert.deepStrictEqual(await sessions(t.store), [], 'no session');
  // an agent with recordings off is unchanged for a service call
  const t2 = setup({ agentExtra: { recordings: undefined } });
  const req2 = fakeReq('POST', '/api/voice/call', { user: null, headers: { 'content-type': 'application/json' }, body: { action: 'start', agent: 'biographer' } });
  req2.hubService = true;
  assert.strictEqual((await t2.call(req2)).statusCode, 200);
  t.cleanup(); t2.cleanup();
});

test('stt: with recordings off the same agent still uses its cloud engine (the stub is reachable)', async () => {
  const t = setup({ agentExtra: { recordings: undefined, voice: { voice: 'bm_george', stt: 'openai', tts: 'local' } } });
  const r = await t.stt();
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.json().engine, 'openai');
  assert.deepStrictEqual(t.cloudCalls, [['biographer', 'openai']]);
  t.cleanup();
});
