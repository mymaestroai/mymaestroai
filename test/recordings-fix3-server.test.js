'use strict';
// Call recordings, fix round 3 (server): idempotent pieces, pause never refuses audio, late pieces after a hub restart,
// the consent "spoken" flag, and /api/me isOwner. (Restore, rename/delete and the notice title are in their own tests.)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const routes = require('../lib/recordings/routes');
const { createStore } = require('../lib/recordings/store');
const { deriveKey } = require('../lib/recordings/crypt');
const { createVoiceCalls } = require('../lib/voice/call');

const KEY = deriveKey(Buffer.alloc(32, 9));
const T0 = Date.UTC(2026, 10, 13, 22, 0, 0);
const DAY = 24 * 3600 * 1000;
const patientA = { id: 'u_0000000000c3', role: 'member', name: 'Patient A' };
const other = { id: 'u_0000000000d4', role: 'member', name: 'Other' };
const PIECE = 'piece-abcdef01';

function wav(samples, rate = 16000) {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const tone = (n, hz = 300) => Int16Array.from({ length: n }, (_, i) => Math.round(9000 * Math.sin(2 * Math.PI * hz * i / 16000)));
function fakeRes() {
  const chunks = [];
  const r = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  r.writeHead = (code) => { r.statusCode = code; r.headersSent = true; };
  r.finished = new Promise((resolve) => r.on('finish', resolve));
  r.json = () => JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return r;
}
function fakeReq(method, url, { headers = {}, body, user = null } = {}) {
  const r = Readable.from(body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(r, { method, url, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), hubUser: user, hubService: false, hubToken: null, hubPendingTotp: false });
  return r;
}
const wavReq = (url, body, user = patientA) => fakeReq('POST', url, { headers: { 'content-type': 'audio/wav' }, body, user });
const jsonReq = (url, body, user = patientA) => fakeReq('POST', url, { headers: { 'content-type': 'application/json' }, body, user });
const seg = (agent, callId, extra = '') => `/api/recordings/segment?agent=${agent}&callId=${callId}&speaker=person&startedAt=${new Date(T0).toISOString()}&endedAt=${new Date(T0 + 500).toISOString()}${extra}`;

function fx({ storeWrap } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-fix3-'));
  const clock = { t: T0 };
  const real = createStore({ root: path.join(dir, 'call-recordings'), key: KEY, now: () => clock.t });
  const store = storeWrap ? storeWrap(real) : real;
  const mkCalls = () => createVoiceCalls({ now: () => clock.t, bus: { publish() {} } });
  const state = { calls: mkCalls() };
  const agents = [{ name: 'biographer', display: 'Biographer', recordings: { keep: true, allowed: ['u_x'], keepReplies: false, consentLine: 'x', mic: 'processed' } }];
  const deps = {
    jsonResponse: (res, code, data) => { res.writeHead(code); res.end(JSON.stringify(data)); },
    readBody: (req) => new Promise((resolve) => { let s = ''; req.on('data', c => { s += c; }); req.on('end', () => resolve(s)); }),
    getAgents: async () => agents, store, now: () => clock.t, audit() {},
    get voiceCall() { return state.calls; },
  };
  const call = async (req) => {
    const res = fakeRes(); const u = new URL(req.url, 'http://x');
    await routes.handle(u.pathname, req, res, deps);
    if (res.writableEnded) await res.finished;
    return res;
  };
  const startCall = async ({ userId = patientA.id } = {}) => {
    const c = state.calls.start('biographer', { userId, person: 'Patient A' });
    const { sessionId } = await store.createSession('biographer', { userId, callId: c.callId, keepReplies: false, consentLine: 'x' });
    state.calls.setRecording('biographer', c.callId, { sessionId, paused: false, keepReplies: false, mic: 'processed' });
    return { callId: c.callId, sessionId };
  };
  routes.resetForTests();
  return { dir, clock, store, real, state, call, startCall, restart: () => { state.calls = mkCalls(); routes.resetForTests(); } };
}
const segments = async (store, sid) => (await store.readManifest('biographer', sid)).entries.filter(e => e.kind === 'segment');

// ── 1. idempotent pieces ──
test('piece: the same piece id twice gives one entry and the same seq (store and route); the entry keeps the piece', async () => {
  const t = fx();
  const { callId, sessionId } = await t.startCall();
  const q = seg('biographer', callId, `&piece=${PIECE}`);
  const a = await t.call(wavReq(q, wav(tone(3200))));
  const b = await t.call(wavReq(q, wav(tone(3200))));
  assert.deepStrictEqual([a.statusCode, a.json()], [200, { seq: 1 }]);
  assert.deepStrictEqual([b.statusCode, b.json()], [200, { seq: 1 }]);
  const segs = await segments(t.store, sessionId);
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].piece, PIECE);
  assert.ok(!fs.existsSync(path.join(t.dir, 'call-recordings', 'biographer', sessionId, '0002-person.flac.enc')), 'nothing written for the duplicate');
  // a piece without an id still adds a new entry; another id too
  assert.deepStrictEqual((await t.call(wavReq(seg('biographer', callId), wav(tone(3200))))).json(), { seq: 2 });
  assert.deepStrictEqual((await t.call(wavReq(seg('biographer', callId, '&piece=piece-other-02'), wav(tone(3200, 500))))).json(), { seq: 3 });
  // the store itself
  const s1 = await t.store.addSegment('biographer', sessionId, { speaker: 'person', piece: 'store-piece-1', wav: wav(tone(800)) });
  const s2 = await t.store.addSegment('biographer', sessionId, { speaker: 'person', piece: 'store-piece-1', wav: wav(tone(800)) });
  assert.strictEqual(s1.seq, s2.seq);
  // the zip export's manifest shows the piece
  const files = {}; for await (const e of t.store.exportEntries('biographer', sessionId)) files[e.name] = e.data;
  assert.match(files[`${sessionId}/manifest.json`].toString('utf8'), /"piece": "piece-abcdef01"/);
});

test('piece: a different body under the same piece id is refused with 409 piece_conflict and changes nothing', async () => {
  const t = fx();
  const { callId, sessionId } = await t.startCall();
  const q = seg('biographer', callId, `&piece=${PIECE}`);
  assert.strictEqual((await t.call(wavReq(q, wav(tone(3200))))).statusCode, 200);
  const r = await t.call(wavReq(q, wav(tone(3200, 700))));
  assert.strictEqual(r.statusCode, 409);
  assert.deepStrictEqual(r.json(), { error: 'piece_conflict' });
  assert.strictEqual((await segments(t.store, sessionId)).length, 1);
  await assert.rejects(t.store.addSegment('biographer', sessionId, { speaker: 'person', piece: PIECE, wav: wav(tone(3200, 700)) }), (e) => e.code === 'piece_conflict');
});

test('piece: concurrent duplicates give one entry', async () => {
  const t = fx();
  const { callId, sessionId } = await t.startCall();
  const q = seg('biographer', callId, `&piece=${PIECE}`);
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => t.call(wavReq(q, wav(tone(3200))))));
  assert.deepStrictEqual(rs.map(r => r.statusCode), [200, 200, 200, 200, 200]);
  assert.deepStrictEqual([...new Set(rs.map(r => r.json().seq))], [1]);
  assert.strictEqual((await segments(t.store, sessionId)).length, 1);
});

test('piece: anything that is not 8 to 64 of letters, digits, _ and - is 400 bad_request', async () => {
  const t = fx();
  const { callId, sessionId } = await t.startCall();
  for (const bad of ['short', 'has space1234', 'semi;colon123', 'x'.repeat(65), '']) {
    const r = await t.call(wavReq(seg('biographer', callId, `&piece=${encodeURIComponent(bad)}`), wav(tone(800))));
    assert.strictEqual(r.statusCode, 400, JSON.stringify(bad));
    assert.deepStrictEqual(r.json(), { error: 'bad_request' });
  }
  assert.strictEqual((await segments(t.store, sessionId)).length, 0);
});

// ── 2. pause never refuses audio ──
test('pause: a paused call still takes uploads; the pause route writes the event first, so a failed event leaves the state as it was', async () => {
  const t = fx({ storeWrap: (real) => Object.assign(Object.create(real), { addEvent: async (...a) => { if (t.failEvent) throw Object.assign(new Error('x'), { code: 'io' }); return real.addEvent(...a); } }) });
  const { callId, sessionId } = await t.startCall();
  assert.strictEqual((await t.call(jsonReq('/api/recordings/pause', { agent: 'biographer', callId, paused: true }))).statusCode, 200);
  assert.strictEqual(t.state.calls.recordingOf('biographer').paused, true);
  const r = await t.call(wavReq(seg('biographer', callId), wav(tone(800))));
  assert.deepStrictEqual([r.statusCode, r.json()], [200, { seq: 1 }]);
  t.failEvent = true;
  const f = await t.call(jsonReq('/api/recordings/pause', { agent: 'biographer', callId, paused: false }));
  assert.strictEqual(f.statusCode, 500);
  assert.strictEqual(t.state.calls.recordingOf('biographer').paused, true, 'the event failed: the flag was not changed');
  t.failEvent = false;
  assert.strictEqual((await t.call(jsonReq('/api/recordings/pause', { agent: 'biographer', callId, paused: false }))).statusCode, 200);
  assert.strictEqual(t.state.calls.recordingOf('biographer').paused, false);
  assert.ok(sessionId);
});

// ── 3. late pieces survive a hub restart ──
test('restart: a fresh call registry with the session on disk: the right user\'s late piece is kept, another user\'s is refused', async () => {
  const t = fx();
  const { callId, sessionId } = await t.startCall();
  assert.strictEqual((await t.call(wavReq(seg('biographer', callId), wav(tone(800))))).statusCode, 200);
  t.restart();   // the hub restarted: no call registry remembers it; the session is not finished
  t.clock.t += 5 * 60 * 1000;
  let r = await t.call(wavReq(seg('biographer', callId, `&piece=${PIECE}`), wav(tone(900))));
  assert.deepStrictEqual([r.statusCode, r.json()], [200, { seq: 2 }]);
  r = await t.call(wavReq(seg('biographer', callId), wav(tone(900)), other));
  assert.strictEqual(r.statusCode, 409);
  assert.deepStrictEqual(r.json(), { error: 'not_recording' });
  assert.strictEqual((await segments(t.store, sessionId)).length, 2);
  // a transcript for it is kept as well; a wrong call id is not found
  assert.strictEqual((await t.call(jsonReq('/api/recordings/transcript', { agent: 'biographer', callId, seq: 2, text: 'late words' }))).statusCode, 200);
  assert.strictEqual((await t.call(wavReq(seg('biographer', 'call-nope'), wav(tone(900))))).statusCode, 409);
  // pause and consent are for a live call only
  assert.strictEqual((await t.call(jsonReq('/api/recordings/pause', { agent: 'biographer', callId, paused: true }))).statusCode, 409);
});

test('restart: an unfinished session whose last entry is over an hour old is refused', async () => {
  const t = fx();
  const { callId } = await t.startCall();
  t.restart();
  t.clock.t += 61 * 60 * 1000;
  assert.strictEqual((await t.call(wavReq(seg('biographer', callId), wav(tone(800))))).statusCode, 409);
});

test('restart: an ended session is taken for 60 minutes after its end; an hour-old one is refused', async () => {
  const t = fx();
  const { callId, sessionId } = await t.startCall();
  await t.store.finish('biographer', sessionId, { endedAt: T0 });
  t.restart();
  t.clock.t += 30 * 60 * 1000;
  assert.strictEqual((await t.call(wavReq(seg('biographer', callId), wav(tone(800))))).statusCode, 200);
  t.clock.t = T0 + 61 * 60 * 1000;
  routes.resetForTests();   // the 5-minute memory of the lookup is not what this checks
  assert.strictEqual((await t.call(wavReq(seg('biographer', callId, '&piece=another-piece-1'), wav(tone(800))))).statusCode, 409);
});

test('restart: a session 3 days old is never scanned (store), and the route refuses its piece', async () => {
  const t = fx();
  const { callId, sessionId } = await t.startCall();
  assert.ok(await t.real.findSessionByCall('biographer', callId), 'found while recent');
  t.restart();
  t.clock.t += 3 * DAY;
  assert.strictEqual(await t.real.findSessionByCall('biographer', callId), null, 'the id date is 3 days back: not opened');
  assert.strictEqual((await t.call(wavReq(seg('biographer', callId), wav(tone(800))))).statusCode, 409);
  // 2 days back is still scanned (and found), newest session first
  const u = fx();
  const first = await u.startCall();
  u.clock.t += 2 * DAY;
  assert.strictEqual((await u.real.findSessionByCall('biographer', first.callId)).sessionId, first.sessionId);
  assert.ok(sessionId);
});

test('restart: hits and misses are remembered for 5 minutes, so a flood of uploads scans once', async () => {
  let scans = 0;
  const t = fx({ storeWrap: (real) => Object.assign(Object.create(real), { findSessionByCall: async (...a) => { scans++; return real.findSessionByCall(...a); } }) });
  const { callId } = await t.startCall();
  t.restart();
  for (let i = 0; i < 4; i++) await t.call(wavReq(seg('biographer', callId, `&piece=flood-piece-${i}`), wav(tone(800 + i * 10))));
  for (let i = 0; i < 3; i++) await t.call(wavReq(seg('biographer', 'call-unknown'), wav(tone(800))));
  assert.strictEqual(scans, 2, 'one for the known call, one for the unknown');
  t.clock.t += 6 * 60 * 1000;
  await t.call(wavReq(seg('biographer', callId, '&piece=flood-piece-9'), wav(tone(1000))));
  assert.strictEqual(scans, 3, 'after 5 minutes it looks again');
});

// ── 6. consent "spoken" ──
test('consent: spoken false is kept on the event and the transcript says the line was not spoken; the default stays unmarked', async () => {
  const t = fx();
  const { callId, sessionId } = await t.startCall();
  assert.strictEqual((await t.call(jsonReq('/api/recordings/consent', { agent: 'biographer', callId }))).statusCode, 200);
  assert.strictEqual((await t.call(jsonReq('/api/recordings/consent', { agent: 'biographer', callId, spoken: true }))).statusCode, 200);
  assert.strictEqual((await t.call(jsonReq('/api/recordings/consent', { agent: 'biographer', callId, spoken: false }))).statusCode, 200);
  assert.strictEqual((await t.call(jsonReq('/api/recordings/consent', { agent: 'biographer', callId, spoken: 'no' }))).statusCode, 400);
  const ev = (await t.store.readManifest('biographer', sessionId)).entries.filter(e => e.kind === 'event');
  assert.deepStrictEqual(ev.map(e => e.spoken), [undefined, undefined, false]);
  const files = {}; for await (const e of t.store.exportEntries('biographer', sessionId)) files[e.name] = e.data;
  const lines = files[`${sessionId}/transcript.txt`].toString('utf8').trim().split('\n');
  assert.deepStrictEqual(lines.map(l => l.replace(/^\[[\d:]+\] /, '')), ['(consent)', '(consent)', '(consent line not spoken)']);
  // the store alone
  await t.store.addEvent('biographer', sessionId, { type: 'pause', spoken: false });
  assert.ok(!('spoken' in (await t.store.readManifest('biographer', sessionId)).entries.at(-1)), 'only a consent event carries it');
});

// ── 8. /api/me isOwner (the route lives in server.js, which can't be loaded in a test: its source is read) ──
test('server: GET /api/me adds isOwner from hubAuth.isOwner, false for service calls and pending two-factor sessions', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = src.indexOf("pathname === '/api/me' && req.method === 'GET'");
  assert.ok(i > 0);
  const body = src.slice(i, src.indexOf('return jsonResponse(res, 200, out);', i));
  assert.match(body, /out\.isOwner = !!\(req\.hubUser && !req\.hubService && !req\.hubPendingTotp && hubAuth\.isOwner\(req\.hubUser\)\)/);
});
