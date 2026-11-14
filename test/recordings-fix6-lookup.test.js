'use strict';
// Call recordings, fix round 6: an inconclusive call lookup is remembered 30 s (503 try_later, no rescan), and a createSession
// that fails after its folder exists leaves no half-made session behind.
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
const T0 = Date.UTC(2026, 10, 13, 20, 0, 0);
const owner = { id: 'u_0000000000c3', role: 'member', name: 'Owner' };

function fakeRes() {
  const chunks = [];
  const r = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  r.writeHead = (code, headers) => { r.statusCode = code; r.headers = headers || {}; r.headersSent = true; };
  r.finished = new Promise((resolve) => r.on('finish', resolve));
  r.json = () => JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return r;
}
function jsonReq(url, body, user = owner) {
  const r = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(r, { method: 'POST', url, headers: { 'content-type': 'application/json' }, hubUser: user, hubService: false, hubToken: null, hubPendingTotp: false });
  return r;
}

function fx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-fix6-'));
  const clock = { t: T0 };
  const real = createStore({ root: path.join(dir, 'call-recordings'), key: KEY, now: () => clock.t });
  const scans = { n: 0 };
  const store = Object.assign(Object.create(real), { findSessionByCall: async (...a) => { scans.n++; return real.findSessionByCall(...a); } });
  const calls = createVoiceCalls({ now: () => clock.t, bus: { publish() {} } });
  const agents = [{ name: 'biographer', display: 'Biographer', recordings: { keep: true, allowed: ['u_x'], keepReplies: false, consentLine: 'x', mic: 'processed' } }];
  const deps = {
    jsonResponse: (res, code, data) => { res.writeHead(code); res.end(JSON.stringify(data)); },
    readBody: (req) => new Promise((resolve) => { let s = ''; req.on('data', c => { s += c; }); req.on('end', () => resolve(s)); }),
    getAgents: async () => agents, store, now: () => clock.t, audit() {}, voiceCall: calls,
  };
  const call = async (req) => {
    const res = fakeRes(); const u = new URL(req.url, 'http://x');
    await routes.handle(u.pathname, req, res, deps);
    if (res.writableEnded) await res.finished;
    return res;
  };
  routes.resetForTests();
  return { dir, clock, real, scans, call };
}
const upload = (callId) => jsonReq('/api/recordings/transcript', { agent: 'biographer', callId, seq: 1, text: 'hi' });
const sessionDir = (t, sid) => path.join(t.dir, 'call-recordings', 'biographer', sid);

test('6: an inconclusive lookup is remembered 30 s: two uploads scan once and both get 503; after 31 s it scans again and finds the repaired session', async () => {
  const t = fx();
  const callId = 'call-damaged-1';
  const { sessionId } = await t.real.createSession('biographer', { userId: owner.id, callId, keepReplies: false, consentLine: 'x' });
  const manifest = path.join(sessionDir(t, sessionId), 'manifest.json.enc');
  const good = fs.readFileSync(manifest);
  fs.writeFileSync(manifest, Buffer.from('not a sealed file'));
  for (let i = 0; i < 2; i++) {
    const r = await t.call(upload(callId));
    assert.strictEqual(r.statusCode, 503);
    assert.deepStrictEqual(r.json(), { error: 'try_later' });
  }
  assert.strictEqual(t.scans.n, 1, 'the second upload did not rescan');
  t.clock.t += 29 * 1000;
  assert.strictEqual((await t.call(upload(callId))).statusCode, 503);
  assert.strictEqual(t.scans.n, 1, 'still within 30 s');
  t.clock.t += 2 * 1000;   // 31 s after the first
  fs.writeFileSync(manifest, good);   // repaired
  // the manifest has no segment yet: the transcript upload is a 404 no_segment, i.e. the call WAS found (not 409 / 503)
  const r = await t.call(upload(callId));
  assert.strictEqual(t.scans.n, 2, 'scanned again after 30 s');
  assert.strictEqual(r.statusCode, 404, 'found: the session answers for itself (no such segment yet), not 409 or 503');
  assert.deepStrictEqual(r.json(), { error: 'no_segment' });
});

test('6: an inconclusive entry counts in the 500-entry cap (oldest dropped)', async () => {
  const t = fx();
  const { sessionId } = await t.real.createSession('biographer', { userId: owner.id, callId: 'call-cap-0', keepReplies: false, consentLine: 'x' });
  fs.writeFileSync(path.join(sessionDir(t, sessionId), 'manifest.json.enc'), Buffer.from('not a sealed file'));
  assert.strictEqual((await t.call(upload('call-cap-0'))).statusCode, 503);
  assert.strictEqual((await t.call(upload('call-cap-0'))).statusCode, 503);
  assert.strictEqual(t.scans.n, 1, 'remembered: no rescan');
  for (let i = 1; i <= 500; i++) await t.call(upload(`call-miss-${i}`));   // confirmed misses, newer than the first entry
  const before = t.scans.n;
  assert.strictEqual((await t.call(upload('call-cap-0'))).statusCode, 503);
  assert.strictEqual(t.scans.n, before + 1, 'the oldest entry was dropped, so it is scanned again');
});

test('6: createSession that fails after the folder exists removes the folder, rethrows, and the call id is a clean miss', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-fix6-'));
  const root = path.join(dir, 'call-recordings');
  const st = createStore({ root, key: KEY, now: () => T0, _failFirstSave: true });
  await assert.rejects(st.createSession('biographer', { userId: owner.id, callId: 'call-fail-1', keepReplies: false, consentLine: 'x' }), (e) => e.code === 'ENOSPC');
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'biographer')), [], 'no session folder is left');
  assert.strictEqual(await st.findSessionByCall('biographer', 'call-fail-1'), null);
  // the hook fires once: the next session is made normally
  const ok = await st.createSession('biographer', { userId: owner.id, callId: 'call-fail-1', keepReplies: false, consentLine: 'x' });
  assert.strictEqual((await st.findSessionByCall('biographer', 'call-fail-1')).sessionId, ok.sessionId);
});
