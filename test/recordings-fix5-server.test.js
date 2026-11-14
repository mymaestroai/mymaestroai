'use strict';
// Call recordings, fix round 5 (server): an inconclusive lookup is not a refusal, a server clock (aliveAt) for a call cut by a
// restart, a restore that repairs broken segment files from the backup, and bounded lookups.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const routes = require('../lib/recordings/routes');
const voiceRoutes = require('../lib/voice/routes');
const { createStore } = require('../lib/recordings/store');
const { deriveKey, open } = require('../lib/recordings/crypt');
const { createVoiceCalls } = require('../lib/voice/call');
const { mergeRecordings } = require('../lib/backup/recordings-merge');

const INSTALL = Buffer.alloc(32, 9);
const KEY = deriveKey(INSTALL);
const T0 = Date.UTC(2026, 10, 13, 20, 0, 0);
const MIN = 60 * 1000;
const patientA = { id: 'u_0000000000c3', role: 'member', name: 'Patient A' };

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
  r.writeHead = (code, headers) => { r.statusCode = code; r.headers = headers || {}; r.headersSent = true; };
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
const seg = (agent, callId, extra = '') => `/api/recordings/segment?agent=${agent}&callId=${callId}&speaker=person${extra}`;
const tr = (callId, agent = 'biographer') => jsonReq('/api/recordings/transcript', { agent, callId, seq: 1, text: 'hello' });

function fx({ wrap } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-fix5-'));
  const clock = { t: T0 };
  const real = createStore({ root: path.join(dir, 'call-recordings'), key: KEY, now: () => clock.t });
  const store = wrap ? wrap(real) : real;
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
  // a recorded call that the hub then forgets (a restart)
  const startCall = async ({ endedAt } = {}) => {
    const c = state.calls.start('biographer', { userId: patientA.id, person: 'Patient A' });
    const { sessionId } = await store.createSession('biographer', { userId: patientA.id, callId: c.callId, keepReplies: false, consentLine: 'x' });
    state.calls.setRecording('biographer', c.callId, { sessionId, paused: false, keepReplies: false, mic: 'processed' });
    return { callId: c.callId, sessionId, endedAt };
  };
  routes.resetForTests();
  return { dir, clock, store, real, state, call, startCall, restart: () => { state.calls = mkCalls(); routes.resetForTests(); } };
}
const manifestFile = (t, sid) => path.join(t.dir, 'call-recordings', 'biographer', sid, 'manifest.json.enc');

// ── 1. an inconclusive lookup is not a refusal ──
test('1: a lookup that fails with an I/O error answers 503 try_later with Retry-After 30 and caches nothing', async () => {
  let fail = true; let scans = 0;
  const t = fx({ wrap: (s) => Object.assign(Object.create(s), { findSessionByCall: async (...a) => { scans++; if (fail) throw Object.assign(new Error('x'), { code: 'EIO' }); return s.findSessionByCall(...a); } }) });
  const { callId, sessionId } = await t.startCall();
  t.restart();
  const r = await t.call(jsonReq('/api/recordings/transcript', { agent: 'biographer', callId, seq: 1, text: 'hi' }));
  assert.strictEqual(r.statusCode, 503);
  assert.deepStrictEqual(r.json(), { error: 'try_later' });
  assert.strictEqual(r.headers['Retry-After'], '30');
  // nothing was remembered: the next try scans again and, now that the disk answers, finds the session
  fail = false;
  await t.real.addSegment('biographer', sessionId, { speaker: 'person', wav: wav(tone(800)) });
  const r2 = await t.call(jsonReq('/api/recordings/transcript', { agent: 'biographer', callId, seq: 1, text: 'hi' }));
  assert.strictEqual(r2.statusCode, 200);
  assert.strictEqual(scans, 2);
});

test('1: the store lets a real I/O error on the agent folder through, and treats a missing folder as no session', async () => {
  const t = fx();
  assert.strictEqual(await t.real.findSessionByCall('biographer', 'call-none'), null);
  const root = path.join(t.dir, 'call-recordings');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'biographer'), 'a file where the folder should be');   // ENOTDIR: still just "none"
  assert.strictEqual(await t.real.findSessionByCall('biographer', 'call-none'), null);
  const broken = createStore({ root, key: KEY, now: () => T0 });
  const orig = fs.promises.readdir;
  fs.promises.readdir = async () => { throw Object.assign(new Error('x'), { code: 'EIO' }); };
  try { await assert.rejects(broken.findSessionByCall('biographer', 'call-none'), (e) => e.code === 'EIO'); } finally { fs.promises.readdir = orig; }
});

function captureLog(fn) {
  const lines = []; const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  return Promise.resolve().then(fn).then((r) => { console.log = orig; return { r, lines }; }, (e) => { console.log = orig; throw e; });
}

test('1: a damaged session is skipped: an unknown call id is a miss, logged once per hour', async () => {
  const t = fx();
  const a = await t.startCall();
  await t.startCall();
  fs.writeFileSync(manifestFile(t, a.sessionId), Buffer.from('not a sealed file'));
  const { r, lines } = await captureLog(async () => [
    await t.real.findSessionByCall('biographer', 'call-unknown-x'),
    await t.real.findSessionByCall('biographer', 'call-unknown-y'),
  ]);
  assert.deepStrictEqual(r, [null, null]);
  assert.deepStrictEqual(lines, [`[recordings] skipped a session that does not open: biographer/${a.sessionId}`]);
  t.clock.t += 61 * MIN;
  const again = await captureLog(() => t.real.findSessionByCall('biographer', 'call-unknown-x'));
  assert.strictEqual(again.lines.length, 1);
});

test('1: a damaged manifest in the window is skipped (409, logged once); a match elsewhere still wins', async () => {
  const t = fx();
  const a = await t.startCall();
  const b = await t.startCall();   // another call, a later session
  t.restart();
  // a clean miss: 409
  const miss = await t.call(tr('call-unknown-1'));
  assert.strictEqual(miss.statusCode, 409);
  assert.deepStrictEqual(miss.json(), { error: 'not_recording' });
  // damage the first session's manifest
  fs.writeFileSync(manifestFile(t, a.sessionId), Buffer.from('not a sealed file'));
  routes.resetForTests();
  const { r: bad, lines } = await captureLog(() => t.call(tr('call-unknown-2')));
  assert.strictEqual(bad.statusCode, 409);
  assert.deepStrictEqual(bad.json(), { error: 'not_recording' });
  assert.deepStrictEqual(lines, [`[recordings] skipped a session that does not open: biographer/${a.sessionId}`]);
  // the other session is found even though one in the window is damaged
  await t.real.addSegment('biographer', b.sessionId, { speaker: 'person', wav: wav(tone(800)) });
  const ok = await t.call(tr(b.callId));
  assert.strictEqual(ok.statusCode, 200);
});

// ── 2. the server clock ──
test('2: createSession sets aliveAt = startedAt; touch sets it from the hub clock at most once per 60 s, through the serialized update', async () => {
  const t = fx();
  const { sessionId } = await t.startCall();
  let m = await t.real.readManifest('biographer', sessionId);
  assert.strictEqual(m.aliveAt, m.startedAt);
  t.clock.t += 30 * 1000;
  assert.strictEqual(await t.real.touch('biographer', sessionId), true);
  m = await t.real.readManifest('biographer', sessionId);
  assert.strictEqual(m.aliveAt, new Date(T0 + 30000).toISOString());
  t.clock.t += 20 * 1000;   // 20 s after the last stamp: nothing
  assert.strictEqual(await t.real.touch('biographer', sessionId), false);
  assert.strictEqual((await t.real.readManifest('biographer', sessionId)).aliveAt, new Date(T0 + 30000).toISOString());
  t.clock.t += 41 * 1000;   // 61 s: stamped again
  await t.real.touch('biographer', sessionId);
  assert.strictEqual((await t.real.readManifest('biographer', sessionId)).aliveAt, new Date(T0 + 91000).toISOString());
  // a finished session is not stamped
  await t.real.finish('biographer', sessionId, {});
  t.clock.t += 5 * MIN;
  await t.real.touch('biographer', sessionId);
  assert.strictEqual((await t.real.readManifest('biographer', sessionId)).aliveAt, new Date(T0 + 91000).toISOString());
});

test('2: the call heartbeat of a recorded call stamps the session (and a call without a recording touches nothing)', async () => {
  const t = fx();
  const touches = [];
  const store = Object.assign(Object.create(t.real), { touch: (...a) => { const p = t.real.touch(...a); touches.push(p); return p; } });
  const { callId, sessionId } = await t.startCall();
  t.state.calls.start('planner', { userId: patientA.id, person: 'Patient A' });
  const post = async (body) => {
    const res = fakeRes();
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: '/api/voice/call', headers: {}, hubUser: patientA, hubService: false });
    await voiceRoutes.handle('/api/voice/call', req, res, { ...t_deps(t, store) });
    if (!res.writableEnded) res.end();
    return res;
  };
  t.clock.t += 30 * 1000;
  const r = await post({ agent: 'biographer', action: 'heartbeat', callId });
  assert.strictEqual(r.statusCode, 200);
  await Promise.all(touches);
  assert.strictEqual((await t.real.readManifest('biographer', sessionId)).aliveAt, new Date(T0 + 30 * 1000).toISOString());
  await post({ agent: 'planner', action: 'heartbeat' });
  assert.strictEqual(touches.length, 1);
});
function t_deps(t, store) {
  return {
    jsonResponse: (res, code, data) => { res.writeHead(code); res.end(JSON.stringify(data)); },
    readBody: (req) => new Promise((resolve) => { let s = ''; req.on('data', c => { s += c; }); req.on('end', () => resolve(s)); }),
    getSetting: () => undefined, updateSettings: () => {}, getAgents: async () => [],
    getVoice: () => ({ engine: { status: () => ({}), paths: {} }, client: {} }),
    voiceCall: t.state.calls, store,
  };
}

test('2: after a restart the window is 60 minutes from aliveAt, not from the last entry', async () => {
  const t = fx();
  const { callId, sessionId } = await t.startCall();
  await t.real.addSegment('biographer', sessionId, { speaker: 'person', wav: wav(tone(800)) });   // last entry at T0
  t.clock.t += 21 * MIN;
  await t.real.touch('biographer', sessionId);              // aliveAt = T0 + 21 min
  t.clock.t += 40 * MIN;                                    // the entry is 61 min old, aliveAt 40 min old
  t.restart();
  const ok = await t.call(wavReq(seg('biographer', callId), wav(tone(800))));
  assert.strictEqual(ok.statusCode, 200);
});

test('2: after a restart a session whose aliveAt is 61 minutes old is refused, and a client-sent far-future time does not extend it', async () => {
  const t = fx();
  const { callId, sessionId } = await t.startCall();
  const future = new Date(T0 + 10 * 3600 * 1000).toISOString();
  const first = await t.call(wavReq(seg('biographer', callId, `&startedAt=${future}&endedAt=${future}`), wav(tone(800))));
  assert.strictEqual(first.statusCode, 200);
  await t.real.addText('biographer', sessionId, { speaker: 'agent', text: 'x', at: future }).catch(() => {});
  t.clock.t += 61 * MIN;                                    // aliveAt (= startedAt) is 61 min old
  t.restart();
  const late = await t.call(wavReq(seg('biographer', callId), wav(tone(800))));
  assert.strictEqual(late.statusCode, 409);
  assert.deepStrictEqual(late.json(), { error: 'not_recording' });
});

// ── 4. bounded lookups ──
function spyStore(t, { delay = 0 } = {}) {
  const log = { scans: 0, folder: 0 };
  const s = Object.assign(Object.create(t.real), {
    findSessionByCall: async (...a) => { log.scans++; if (delay) await new Promise((r) => setTimeout(r, delay)); return t.real.findSessionByCall(...a); },
    hasAgentFolder: async (...a) => { log.folder++; return t.real.hasAgentFolder(...a); },
  });
  return { s, log };
}

test('4: a call id that is too long or has other characters is refused as not_recording before any lookup', async () => {
  const log = { scans: 0 };
  const t = fx({ wrap: (s) => Object.assign(Object.create(s), { findSessionByCall: async () => { log.scans++; return null; } }) });
  await t.startCall();
  t.restart();
  for (const id of ['x'.repeat(65), 'call/../x', 'call id', 'call.1', 'café']) {
    const r = await t.call(tr(id));
    assert.strictEqual(r.statusCode, 409, id);
    assert.deepStrictEqual(r.json(), { error: 'not_recording' });
  }
  assert.strictEqual(log.scans, 0);
  assert.strictEqual((await t.call(tr('x'.repeat(64)))).statusCode, 409);   // valid shape: the lookup runs
  assert.strictEqual(log.scans, 1);
});

test('4: an agent without a recordings folder is not scanned', async () => {
  const t = fx();
  const { s, log } = spyStore(t);
  const t2 = fx({ wrap: () => s });
  // t2 has its own (empty) root; s looks at t's root: make it an agent without a folder
  const r = await t2.call(tr('call-nothing-here'));
  assert.strictEqual(r.statusCode, 409);
  assert.strictEqual(log.folder, 1);
  assert.strictEqual(log.scans, 0);
  await t.startCall();   // now the agent has a folder in t's root
  routes.resetForTests();
  assert.strictEqual((await t2.call(tr('call-nothing-here'))).statusCode, 409);
  assert.strictEqual(log.scans, 1);
});

test('4: concurrent lookups of the same (agent, callId) share one scan', async () => {
  const t = fx();
  const { s, log } = spyStore(t, { delay: 40 });
  const t2 = fx({ wrap: () => s });
  await t.startCall();
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => t2.call(tr('call-same-one'))));
  assert.ok(rs.every((r) => r.statusCode === 409));
  assert.strictEqual(log.scans, 1);
});

test('4: the lookup cache holds 500 entries and drops the oldest', async () => {
  const t = fx();
  const { s, log } = spyStore(t);
  const t2 = fx({ wrap: () => s });
  await t.startCall();
  for (let i = 0; i < 502; i++) await t2.call(tr(`call-miss-${i}`));
  assert.strictEqual(log.scans, 502);
  await t2.call(tr('call-miss-501'));   // newest: still remembered
  assert.strictEqual(log.scans, 502);
  await t2.call(tr('call-miss-0'));     // oldest: dropped, scanned again
  assert.strictEqual(log.scans, 503);
});

// ── 3. restore repairs from the backup ──
function twoSides({ incomingTone = 300, otherKey = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-fix5-merge-'));
  const liveRoot = path.join(base, 'live'); const stagedRoot = path.join(base, 'staged');
  const skeyInstall = otherKey ? Buffer.alloc(32, 5) : INSTALL;
  const mk = (root, key) => createStore({ root, key, now: () => T0, randomHex: () => 'abcdef' });
  const live = mk(liveRoot, KEY); const inc = mk(stagedRoot, deriveKey(skeyInstall));
  return { base, liveRoot, stagedRoot, live, inc, skeyInstall, displaced: path.join(base, 'displaced') };
}
async function mergeCase(opts, breakIt) {
  const s = twoSides(opts);
  const a = await s.live.createSession('biographer', { userId: 'u1', callId: 'call-1' });
  const b = await s.inc.createSession('biographer', { userId: 'u1', callId: 'call-1' });
  assert.strictEqual(a.sessionId, b.sessionId);
  await s.live.addSegment('biographer', a.sessionId, { speaker: 'person', wav: wav(tone(1600)) });
  await s.live.addSegment('biographer', a.sessionId, { speaker: 'person', wav: wav(tone(1600, 500)) });
  await s.inc.addSegment('biographer', b.sessionId, { speaker: 'person', wav: wav(tone(1600, opts && opts.incomingTone ? opts.incomingTone : 300)) });
  const livef = (n) => path.join(s.liveRoot, 'biographer', a.sessionId, n);
  breakIt(livef);
  const out = mergeRecordings({ live: s.liveRoot, staged: s.stagedRoot, displaced: s.displaced, liveInstallKey: INSTALL, stagedInstallKey: s.skeyInstall });
  const key = deriveKey(s.skeyInstall);
  const placed = path.join(s.stagedRoot, 'biographer', a.sessionId);
  const rel = (n) => `biographer/${a.sessionId}/${n}`;
  const sha = (n) => { try { return crypto.createHash('sha256').update(open(key, fs.readFileSync(path.join(placed, n)), rel(n))).digest('hex'); } catch { return null; } };
  const man = await s.live.readManifest('biographer', a.sessionId);
  return { out, sha, man, rel, s, a, placed };
}

test('3: today\'s copy with a missing segment file is repaired from the backup', async () => {
  const r = await mergeCase({}, (f) => fs.renameSync(f('0001-person.flac.enc'), f('0001-person.gone')));
  const e1 = r.man.entries[0];
  assert.deepStrictEqual(r.out.repairedFiles, [r.rel('0001-person.flac.enc')]);
  assert.deepStrictEqual(r.out.stillBroken, []);
  assert.strictEqual(r.out.replacedByLive, 1);
  assert.strictEqual(r.sha('0001-person.flac.enc'), e1.sha256);
  assert.strictEqual(r.sha('0002-person.flac.enc'), r.man.entries[1].sha256);   // the healthy one is today's
  assert.ok(fs.existsSync(path.join(r.s.displaced, 'biographer', r.a.sessionId)), 'the incoming copy is still set aside');
});

test('3: a corrupted segment file is repaired from the backup, also across different keys (re-sealed to the placed key)', async () => {
  for (const otherKey of [false, true]) {
    const r = await mergeCase({ otherKey }, (f) => { const p = f('0001-person.flac.enc'); const b = fs.readFileSync(p); b[b.length - 3] ^= 0xff; fs.writeFileSync(p, b); });
    assert.deepStrictEqual(r.out.repairedFiles, [r.rel('0001-person.flac.enc')], `otherKey=${otherKey}`);
    assert.deepStrictEqual(r.out.stillBroken, []);
    assert.strictEqual(r.sha('0001-person.flac.enc'), r.man.entries[0].sha256);
    assert.ok(!r.out.unopened.includes(r.rel('0001-person.flac.enc')));
  }
});

test('3: a backup file with another sha256 is not used: the broken one is listed in stillBroken', async () => {
  const r = await mergeCase({ incomingTone: 700 }, (f) => fs.renameSync(f('0001-person.flac.enc'), f('0001-person.gone')));
  assert.deepStrictEqual(r.out.repairedFiles, []);
  assert.deepStrictEqual(r.out.stillBroken, [r.rel('0001-person.flac.enc')]);
  assert.strictEqual(r.sha('0001-person.flac.enc'), null);
});
