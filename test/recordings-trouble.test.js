'use strict';
// The "Recording stopped" notice: one web push per call to the agent's allowed users (lib/recordings/trouble.js, push.notifyUsers),
// reached by POST /api/recordings/trouble, by a start failure in /api/voice/call and by a segment the store could not save.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const routes = require('../lib/recordings/routes');
const voiceRoutes = require('../lib/voice/routes');
const trouble = require('../lib/recordings/trouble');
const recIndex = require('../lib/recordings');
const access = require('../lib/access');
const { createPush } = require('../lib/push');
const { createStore } = require('../lib/recordings/store');
const { deriveKey } = require('../lib/recordings/crypt');
const { createVoiceCalls } = require('../lib/voice/call');

const KEY = deriveKey(Buffer.alloc(32, 7));
const T0 = Date.UTC(2026, 10, 13, 22, 0, 0);
const sam = { id: 'u_0000000000b2', role: 'member', name: 'Sam' };           // on the list
const owner = { id: 'u_0000000000a1', role: 'admin', name: 'Owner' };        // not on the list
const patientA = { id: 'u_0000000000c3', role: 'member', name: 'Patient A' };  // the person on the call
const other = { id: 'u_0000000000d4', role: 'member', name: 'Other' };

function fakeRes() {
  const chunks = [];
  const r = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  r.writeHead = (code, headers) => { r.statusCode = code; r.headers = headers || {}; r.headersSent = true; };
  r.finished = new Promise((resolve) => r.on('finish', resolve));
  r.json = () => JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return r;
}
function fakeReq(method, url, { headers = {}, body, user = patientA } = {}) {
  const r = Readable.from(body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(r, { method, url, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), hubUser: user, hubService: false });
  return r;
}
const jsonReq = (url, body, user = patientA) => fakeReq('POST', url, { headers: { 'content-type': 'application/json' }, body, user });
const wavHead = () => { const b = Buffer.alloc(44 + 64); b.write('RIFF', 0); b.write('WAVE', 8); return b; };

// A push with a fake sender and three devices: Sam's, the owner's and Other's.
function fakePush() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-trouble-push-'));
  const sent = [];
  const push = createPush({ dir, webpush: { generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }) }, sender: async (sub, body) => { sent.push({ endpoint: sub.endpoint, payload: JSON.parse(body) }); }, log: () => {} });
  const dev = (n, user) => push.subscribe({ endpoint: `https://push.example/${n}`, keys: { p256dh: 'k', auth: 'a' } }, null, user);
  dev('sam', sam); dev('owner', owner); dev('other', other);
  return { push, sent };
}

function fx({ failStore = false } = {}) {
  trouble.resetForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-trouble-'));
  const clock = { t: T0 };
  const real = createStore({ root: path.join(dir, 'call-recordings'), key: KEY, now: () => clock.t });
  const store = failStore ? Object.assign(Object.create(real), { addSegment: async () => { const e = new Error('disk full'); e.code = 'EIO'; throw e; } }) : real;
  const calls = createVoiceCalls({ now: () => clock.t, bus: { publish() {} } });
  const { push, sent } = fakePush();
  const agents = [{ name: 'biographer', display: 'Biographer', recordings: { keep: true, allowed: [sam.id], keepReplies: false, consentLine: 'x', mic: 'processed' } }];
  const deps = {
    jsonResponse: (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); },
    readBody: (req) => new Promise((resolve) => { let s = ''; req.on('data', c => { s += c; }); req.on('end', () => resolve(s)); }),
    getAgents: async () => agents, voiceCall: calls, store, now: () => clock.t, push, audit: () => {},
  };
  const call = async (req) => {
    const res = fakeRes(); const u = new URL(req.url, 'http://x');
    await routes.handle(u.pathname, req, res, deps);
    if (!res.writableEnded && !res.destroyed) await new Promise(r => setTimeout(r, 5));
    if (res.writableEnded) await res.finished;
    return res;
  };
  const startCall = async () => {
    const c = calls.start('biographer', { userId: patientA.id, person: 'Patient A' });
    const { sessionId } = await real.createSession('biographer', { userId: patientA.id, callId: c.callId, consentLine: 'x' });
    calls.setRecording('biographer', c.callId, { sessionId, paused: false, keepReplies: false, mic: 'processed' });
    return { callId: c.callId, sessionId };
  };
  return { call, startCall, sent, calls, agents, deps };
}

test('access: trouble is an agent route read from the body', () => {
  assert.deepStrictEqual(access.classifyRoute('/api/recordings/trouble', 'POST'), { kind: 'agent', from: 'body' });
});

test('trouble: one notice per call, to the allowed users only, in the right words', async () => {
  const t = fx();
  const { callId } = await t.startCall();
  let r = await t.call(jsonReq('/api/recordings/trouble', { agent: 'biographer', callId, reason: 'upload_failed' }));
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(r.json(), { ok: true, sent: true });
  assert.strictEqual(t.sent.length, 1);
  assert.strictEqual(t.sent[0].endpoint, 'https://push.example/sam', 'only the allowed user\'s device: not the admin\'s, not another member\'s');
  const p = t.sent[0].payload;
  assert.strictEqual(p.title, 'Recording delayed');
  assert.match(p.body, /^Biographer: part of the call at \d\d:\d\d could not be saved yet\. Recording goes on, and the page keeps trying to send what it missed\.$/);
  assert.strictEqual(p.tag, 'rec-biographer');
  r = await t.call(jsonReq('/api/recordings/trouble', { agent: 'biographer', callId, reason: 'upload_failed' }));
  assert.deepStrictEqual(r.json(), { ok: true, sent: false }, 'a second report of the same reason for the same call');
  assert.strictEqual(t.sent.length, 1);
  // the other reason is its own notice, in its own words, once
  r = await t.call(jsonReq('/api/recordings/trouble', { agent: 'biographer', callId, reason: 'start_failed' }));
  assert.deepStrictEqual(r.json(), { ok: true, sent: true });
  assert.strictEqual(t.sent.length, 2);
  assert.match(t.sent[1].payload.body, /^Biographer: the call at \d\d:\d\d is not being recorded\. The conversation text is still saved in the chat\.$/);
  r = await t.call(jsonReq('/api/recordings/trouble', { agent: 'biographer', callId, reason: 'start_failed' }));
  assert.deepStrictEqual(r.json(), { ok: true, sent: false });
  assert.strictEqual(t.sent.length, 2);
});

test('trouble: a caller who is not on the call is refused, an unknown reason is a bad request', async () => {
  const t = fx();
  const { callId } = await t.startCall();
  let r = await t.call(jsonReq('/api/recordings/trouble', { agent: 'biographer', callId, reason: 'upload_failed' }, other));
  assert.strictEqual(r.statusCode, 409);
  assert.deepStrictEqual(r.json(), { error: 'not_recording' });
  r = await t.call(jsonReq('/api/recordings/trouble', { agent: 'biographer', callId: 'not-this-call', reason: 'upload_failed' }));
  assert.strictEqual(r.statusCode, 409);
  r = await t.call(jsonReq('/api/recordings/trouble', { agent: 'biographer', callId, reason: 'because' }));
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(t.sent.length, 0, 'nothing was sent');
});

test('a segment the store could not save is trouble: the route sends the notice once per call', async () => {
  const t = fx({ failStore: true });
  const { callId } = await t.startCall();
  const q = `/api/recordings/segment?agent=biographer&callId=${callId}&speaker=person&startedAt=${new Date(T0).toISOString()}&endedAt=${new Date(T0 + 500).toISOString()}`;
  for (let i = 0; i < 2; i++) {
    const r = await t.call(fakeReq('POST', q, { headers: { 'content-type': 'audio/wav' }, body: wavHead() }));
    assert.strictEqual(r.statusCode, 500);
  }
  assert.strictEqual(t.sent.length, 1);
  assert.strictEqual(t.sent[0].payload.title, 'Recording delayed');
  const again = await t.call(jsonReq('/api/recordings/trouble', { agent: 'biographer', callId, reason: 'upload_failed' }));
  assert.deepStrictEqual(again.json(), { ok: true, sent: false }, 'the page\'s own report adds nothing');
});

test('start_failed: the notice goes out at call start, and a later trouble report for that call sends nothing more', async () => {
  trouble.resetForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-trouble-start-'));
  const clock = { t: T0 };
  recIndex.setStoreForTests({ createSession: async () => { throw new Error('no disk'); }, finish: async () => {} });
  try {
    const calls = createVoiceCalls({ now: () => clock.t, bus: { publish() {} } });
    const { push, sent } = fakePush();
    const agents = [{ name: 'biographer', display: 'Biographer', voice: { voice: 'bm_george', stt: 'local', tts: 'local' }, recordings: { keep: true, allowed: [sam.id], keepReplies: false, consentLine: 'x', mic: 'processed' } }];
    const engine = { paths: { web: dir, dir, worker: path.join(dir, 'w.js') }, status: () => ({ enabled: true, ready: true, installing: false, step: 'ready', progress: 1, error: '', platformSupported: true, stt: {}, tts: { defaultVoice: 'af_heart' }, voices: [] }) };
    const deps = {
      jsonResponse: (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); },
      readBody: (req) => new Promise((resolve) => { let s = ''; req.on('data', c => { s += c; }); req.on('end', () => resolve(s)); }),
      getSetting: (k, d) => (k === 'voice' ? { enabled: true } : d), updateSettings() {}, getAgents: async () => agents,
      getVoice: () => ({ engine, client: { stop() {}, resume() {} } }), voiceCall: calls, push,
    };
    const res = fakeRes();
    await voiceRoutes.handle('/api/voice/call', jsonReq('/api/voice/call', { action: 'start', agent: 'biographer' }), res, deps);
    await res.finished;
    assert.strictEqual(res.statusCode, 200);
    const a = res.json();
    assert.deepStrictEqual(a.recording, { error: 'recording_unavailable' });
    assert.strictEqual(sent.length, 1, 'sent right away');
    assert.strictEqual(sent[0].endpoint, 'https://push.example/sam');
    assert.strictEqual(sent[0].payload.title, 'Not recording');
    assert.match(sent[0].payload.body, /^Biographer: the call at \d\d:\d\d is not being recorded\. The conversation text is still saved in the chat\.$/);
    const again = await trouble.notifyTrouble({ agent: 'biographer', callId: a.call.callId, rec: agents[0], push, reason: 'start_failed' });
    assert.deepStrictEqual(again, { ok: true, sent: false });
    assert.strictEqual(sent.length, 1);
  } finally { recIndex.setStoreForTests(null); }
});

test('push.notifyUsers: only subscriptions of the named user ids; a device with no account is left out', async () => {
  const { push, sent } = fakePush();
  push.subscribe({ endpoint: 'https://push.example/legacy', keys: { p256dh: 'k', auth: 'a' } });
  const r = await push.notifyUsers({ title: 'T', body: 'B', tag: 't' }, [sam.id, 'u_nobody0000000']);
  assert.strictEqual(r.sent, 1);
  assert.deepStrictEqual(sent.map(s => s.endpoint), ['https://push.example/sam']);
  assert.deepStrictEqual(await push.notifyUsers({ title: 'T' }, []), { sent: 0, failed: 0, removed: 0 });
});
