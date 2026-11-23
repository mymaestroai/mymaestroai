'use strict';
// Voice is ready only when it works: download size, failure reason, automatic retry with back-off, POST /api/voice/retry,
// the working check after an install, adminName for members. Nothing is downloaded and no engine is started.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const M = require('../lib/voice/manifest');
const access = require('../lib/access');
const routes = require('../lib/voice/routes');
const { createVoiceEngine, failReasonOf } = require('../lib/voice/engine');

const tmps = [];
const mkdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-ready-')); tmps.push(d); return d; };
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const tick = () => new Promise((r) => setTimeout(r, 5));

const mkEngine = (extra = {}) => createVoiceEngine({ dir: mkdir(), platform: 'linux', arch: 'x64', isEnabled: () => true, ...extra });
const CHOICE = { sttModel: M.DEFAULT_STT, tts: 'kokoro', defaultVoice: M.DEFAULT_VOICE };
const writeChoice = (e) => fs.writeFileSync(e.paths.state, JSON.stringify({ choice: CHOICE }));
/** Makes one plan item look installed (marker with its sha256 plus the files isDone looks for). */
function finish(e, item) {
  fs.mkdirSync(e.paths.done, { recursive: true });
  fs.writeFileSync(path.join(e.paths.done, item.id.replace(/[^A-Za-z0-9._-]/g, '_') + '.json'), JSON.stringify({ sha256: item.sha256 }));
  if (item.kind === 'npm') { fs.mkdirSync(path.join(e.paths.nodeModules, item.def.name), { recursive: true }); fs.writeFileSync(path.join(e.paths.nodeModules, item.def.name, 'package.json'), '{}'); }
  if (item.kind === 'model') fs.mkdirSync(e.paths.model(item.def.id), { recursive: true });
  if (item.kind === 'web') { fs.mkdirSync(e.paths.web, { recursive: true }); for (const [n, f] of Object.entries(M.WEB_FILES)) if (f.pkg === item.def.id) fs.writeFileSync(path.join(e.paths.web, n), 'x'); }
}
const finishAll = (e) => { writeChoice(e); for (const it of e.plan(CHOICE)) finish(e, it); };

// ── 1. downloadBytes ──
test('status().downloadBytes: the bytes of the plan items not done yet; 0 when ready', () => {
  const e = mkEngine();
  const items = e.plan(CHOICE);
  const total = items.reduce((n, i) => n + i.bytes, 0);
  assert.ok(total > 0);
  assert.strictEqual(e.status().downloadBytes, total, 'before the speed check: the defaults');
  writeChoice(e); finish(e, items[0]);
  assert.strictEqual(e.status().downloadBytes, total - items[0].bytes, 'one item done: its bytes leave the sum');
  for (const it of items) finish(e, it);
  assert.strictEqual(e.status().ready, true);
  assert.strictEqual(e.status().downloadBytes, 0);
});

// ── 2. failReason ──
test('failReasonOf maps the error text: network, disk, damaged, other, null', () => {
  for (const m of ['getaddrinfo ENOTFOUND github.com', 'EAI_AGAIN', 'connect ECONNREFUSED', 'read ECONNRESET', 'ETIMEDOUT', 'fetch failed', 'network down', 'socket hang up', 'timed out', 'timeout', 'took longer than 20 minutes: deadline']) assert.strictEqual(failReasonOf(m), 'network', m);
  for (const m of ['ENOSPC: no space left on device', 'No space left']) assert.strictEqual(failReasonOf(m), 'disk', m);
  for (const m of ['checksum mismatch for x', 'sha256 differs', 'corrupt archive']) assert.strictEqual(failReasonOf(m), 'damaged', m);
  assert.strictEqual(failReasonOf('extract failed: tar exited 2'), 'other');
  assert.strictEqual(failReasonOf(''), null);
});

test('status().failReason follows a real failed install; null without an error', async () => {
  assert.strictEqual(mkEngine().status().failReason, null);
  const cases = [
    [async () => { throw new Error('fetch failed'); }, 'network'],
    [async () => { throw new Error('ENOSPC: no space left on device'); }, 'disk'],
    [async () => new Response(Buffer.from('not what was promised'), { status: 200 }), 'damaged'],
    [async () => ({ ok: false, status: 404 }), 'other'],
  ];
  for (const [fetchImpl, want] of cases) {
    const e = mkEngine({ fetchImpl });
    await assert.rejects(e.install());
    const s = e.status();
    assert.ok(s.error, 'an error is kept');
    assert.strictEqual(s.failReason, want);
  }
});

// ── 3. the working check ──
test('working check: a failure keeps ready false with the error; a success makes it ready', async () => {
  let calls = 0; let fail = true;
  const e = mkEngine({ check: async () => { calls++; if (fail) throw new Error('worker would not start'); } });
  finishAll(e);
  assert.strictEqual(e.status().ready, true, 'complete at start: ready, no check');
  e.setCheckError('worker would not start');
  let s = e.status();
  assert.strictEqual(s.ready, false);
  assert.strictEqual(s.error, 'voice engines did not start: worker would not start');
  assert.strictEqual(s.failReason, 'other');
  await e.install();   // nothing to download, but the earlier check failed: the check runs again
  assert.strictEqual(calls, 1);
  s = e.status();
  assert.strictEqual(s.ready, false); assert.match(s.error, /^voice engines did not start: worker would not start/); assert.strictEqual(s.failReason, 'other');
  fail = false;
  await e.install();
  s = e.status();
  assert.strictEqual(calls, 2);
  assert.strictEqual(s.ready, true); assert.strictEqual(s.error, ''); assert.strictEqual(s.failReason, null);
});

test('working check: a complete install at start is ready and never checked; a check that never answers fails after its limit', async () => {
  let calls = 0;
  const e = mkEngine({ check: async () => { calls++; }, checkTimeoutMs: 20 });
  finishAll(e);
  await e.install();
  assert.strictEqual(calls, 0); assert.strictEqual(e.status().ready, true);
  const hang = mkEngine({ check: () => new Promise(() => {}), checkTimeoutMs: 20 });
  finishAll(hang); hang.setCheckError('x');
  await hang.install();
  assert.strictEqual(hang.status().ready, false); assert.match(hang.status().error, /voice engines did not start: no answer within/);
});

test('working check: not ready while it runs; no check engine given means no check', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const e = mkEngine({ check: () => gate });
  finishAll(e); e.setCheckError('earlier');
  const p = e.install(); await tick();
  assert.strictEqual(e.status().ready, false, 'the files are there but voice is not shown to work yet');
  release(); await p;
  assert.strictEqual(e.status().ready, true);
  const plain = mkEngine(); finishAll(plain); plain.setCheckError('x'); await plain.install();
  assert.strictEqual(plain.status().ready, false, 'without a check function a recorded check error stays');
});

// ── 4. retry with back-off ──
function fakeTimers() {
  const list = []; let id = 1;
  return { list, setTimer: (fn, delay) => { const t = { id: id++, fn, delay, live: true }; list.push(t); return t.id; }, clearTimer: (i) => { const t = list.find((x) => x.id === i); if (t) t.live = false; }, live: () => list.filter((t) => t.live), fire: (t) => { t.live = false; t.fn(); } };
}
function failingEngine() {
  const st = { ready: false, installing: false, error: '', platformSupported: true }; const installs = [];
  return { installs, st, status: () => ({ ...st }), install: (o) => { installs.push(o); if (st.willFail === false) { st.ready = true; st.error = ''; return Promise.resolve(); } st.error = 'fetch failed'; return Promise.reject(new Error('fetch failed')); } };
}
const ctxFor = (eng, ft, stored, clock) => ({ engine: eng, getSetting: () => stored.v, now: () => clock.t, setTimer: ft.setTimer, clearTimer: ft.clearTimer });

test('back-off: 2 min, 10 min, 30 min, then every 2 h; one timer at most; the 10-minute gap does not block a scheduled try', async () => {
  routes.resetEnsureForTests();
  const ft = fakeTimers(); const eng = failingEngine(); const stored = { v: undefined }; const clock = { t: 1000 };
  const ctx = ctxFor(eng, ft, stored, clock);
  assert.strictEqual(routes.ensureEngines(ctx), true); await tick();
  assert.strictEqual(ft.live().length, 1); assert.strictEqual(ft.live()[0].delay, 2 * 60 * 1000);
  assert.strictEqual(routes.ensureEngines({ ...ctx }), false, 'a second call while a timer waits starts nothing');
  assert.strictEqual(ft.live().length, 1);
  const want = [10, 30, 120, 120].map((m) => m * 60 * 1000);
  for (const w of want) {
    clock.t += 1000;   // far less than the 10-minute gap: the scheduled try must still go
    const before = eng.installs.length; ft.fire(ft.live()[0]); await tick();
    assert.strictEqual(eng.installs.length, before + 1, 'the scheduled try installs');
    assert.strictEqual(ft.live().length, 1); assert.strictEqual(ft.live()[0].delay, w);
  }
  assert.deepStrictEqual(routes.BACKOFF_MS, [120000, 600000, 1800000, 7200000]);
});

test('back-off: an install that succeeds clears the timer and starts the schedule over', async () => {
  routes.resetEnsureForTests();
  const ft = fakeTimers(); const eng = failingEngine(); const stored = { v: undefined }; const clock = { t: 0 };
  const ctx = ctxFor(eng, ft, stored, clock);
  routes.ensureEngines(ctx); await tick();
  ft.fire(ft.live()[0]); await tick();
  assert.strictEqual(ft.live()[0].delay, 10 * 60 * 1000);
  eng.st.willFail = false;
  ft.fire(ft.live()[0]); await tick();
  assert.strictEqual(eng.st.ready, true); assert.strictEqual(ft.live().length, 0, 'success: no timer left');
  eng.st.ready = false; eng.st.willFail = undefined; routes.resetEnsureForTests();
  routes.ensureEngines(ctx); await tick();
  assert.strictEqual(ft.live()[0].delay, 2 * 60 * 1000, 'after a success the next failure waits 2 minutes again');
});

test('back-off: a pending timer is cleared when voice is turned off; a timer that fires after the switch installs nothing; never scheduled when off', async () => {
  routes.resetEnsureForTests();
  const ft = fakeTimers(); const eng = failingEngine(); const stored = { v: undefined }; const clock = { t: 0 };
  const ctx = ctxFor(eng, ft, stored, clock);
  routes.ensureEngines(ctx); await tick();
  const t = ft.live()[0]; assert.ok(t);
  stored.v = { enabled: false };
  const before = eng.installs.length;
  ft.fire(t); await tick();
  assert.strictEqual(eng.installs.length, before, 'off: the fired timer starts nothing');
  assert.strictEqual(ft.live().length, 0);
  routes.resetEnsureForTests();
  assert.strictEqual(routes.scheduleRetry(ctx), false, 'voice off: nothing is scheduled');
  assert.strictEqual(ft.live().length, 0);
  // the disable route clears a waiting timer
  stored.v = undefined; routes.resetEnsureForTests();
  routes.ensureEngines(ctx); await tick(); assert.strictEqual(ft.live().length, 1);
  const t2 = routes_setup({ stored, ft, eng, clock });
  await t2.call('POST', '/api/voice/disable');
  assert.strictEqual(ft.live().length, 0, 'disable clears the timer');
});

test('back-off: never under the test variables unless a test passes its own timer', async () => {
  routes.resetEnsureForTests();
  const eng = failingEngine(); const stored = { v: undefined };
  assert.strictEqual(routes.scheduleRetry({ engine: eng, getSetting: () => stored.v }), false);
  routes.ensureEngines({ engine: eng, getSetting: () => stored.v, now: () => 1 }); await tick();
  const t = routes_setup({ stored, eng, ft: fakeTimers(), clock: { t: 0 }, noTimers: true });
  assert.strictEqual((await t.call('GET', '/api/voice/status')).json().nextRetryAt, null);
});

// ── routes ──
function fakeRes() {
  const chunks = [];
  const r = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  r.writeHead = (code) => { r.statusCode = code; r.headersSent = true; };
  r.finished = new Promise((resolve) => r.on('finish', resolve));
  r.json = () => JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return r;
}
function routes_setup({ stored, ft, eng, clock, noTimers, adminName }) {
  const client = { stt: async () => ({ text: 'hi', ms: 1 }), tts: async () => ({ wav: Buffer.alloc(4), sampleRate: 24000, ms: 1 }), stop() {}, resume() {} };
  const baseStatus = eng.status;
  const engine = { ...eng, status: () => ({ stt: { engine: 'local', model: 'tiny.en' }, tts: { engine: 'local', defaultVoice: 'af_heart' }, voices: [], progress: 0, step: '', ...baseStatus() }), install: eng.install };
  const deps = {
    jsonResponse: (res, code, data) => { res.writeHead(code); res.end(JSON.stringify(data)); },
    readBody: async () => '', getSetting: (k) => (k === 'voice' ? stored.v : undefined),
    updateSettings: (patch) => { if (patch.voice !== undefined) stored.v = patch.voice; },
    getAgents: async () => [{ name: 'maestro' }], getVoice: () => ({ engine, client }), cloud: { keys: () => ({}) },
    now: () => clock.t, adminName: () => adminName || null,
    ...(noTimers ? {} : { setTimer: ft.setTimer, clearTimer: ft.clearTimer }),
  };
  const call = async (method, url, role = 'admin') => {
    const req = Readable.from([]);
    Object.assign(req, { method, url, headers: {}, hubUser: { id: 'u', role } });
    const res = fakeRes(); await routes.handle(new URL(url, 'http://x').pathname, req, res, deps);
    if (!res.writableEnded) await tick();
    await res.finished; return res;
  };
  return { call };
}

test('status carries nextRetryAt after a failed install', async () => {
  routes.resetEnsureForTests();
  const ft = fakeTimers(); const eng = failingEngine(); const stored = { v: undefined }; const clock = { t: 50000 };
  const t = routes_setup({ stored, ft, eng, clock });
  const first = (await t.call('GET', '/api/voice/status')).json();   // starts the install (voice on by default); it fails
  assert.strictEqual(first.nextRetryAt, null);
  await tick();
  const s = (await t.call('GET', '/api/voice/status')).json();
  assert.strictEqual(s.nextRetryAt, 50000 + 120000);
  assert.strictEqual(eng.installs.length, 1, 'a status read while a timer waits does not start another install');
});

test('POST /api/voice/retry: admin starts a forced try, a member gets 403 admin_only, voice off gets 409 voice_off', async () => {
  routes.resetEnsureForTests();
  const ft = fakeTimers(); const eng = failingEngine(); const stored = { v: undefined }; const clock = { t: 1 };
  const t = routes_setup({ stored, ft, eng, clock });
  await t.call('GET', '/api/voice/status'); await tick();   // first try (fails): the 10-minute gap and a 2-minute timer are now in force
  assert.strictEqual(eng.installs.length, 1);
  const r = await t.call('POST', '/api/voice/retry');
  assert.strictEqual(r.statusCode, 200);
  const body = r.json(); assert.strictEqual(body.ok, true); assert.ok(body.status && 'ready' in body.status);
  assert.strictEqual(eng.installs.length, 2, 'forced: not held back by the gap or the timer');
  await tick(); assert.strictEqual(ft.live().length, 1, 'still one pending timer at most');
  const m = await t.call('POST', '/api/voice/retry', 'member');
  assert.strictEqual(m.statusCode, 403); assert.strictEqual(m.json().error, 'admin_only'); assert.strictEqual(eng.installs.length, 2);
  stored.v = { enabled: false };
  const off = await t.call('POST', '/api/voice/retry');
  assert.strictEqual(off.statusCode, 409); assert.strictEqual(off.json().error, 'voice_off'); assert.strictEqual(eng.installs.length, 2);
  const g = await t.call('GET', '/api/voice/retry'); assert.strictEqual(g.statusCode, 405);
});

test('access: /api/voice/retry is admin-only, like enable', () => {
  assert.deepStrictEqual(access.classifyRoute('/api/voice/retry', 'POST'), { kind: 'admin' });
  assert.deepStrictEqual(access.classifyRoute('/api/voice/enable', 'POST'), { kind: 'admin' });
});

test('status: members see failReason but never the raw error; admins see both', async () => {
  routes.resetEnsureForTests();
  const eng = { status: () => ({ ready: false, installing: false, error: 'connect ECONNREFUSED 10.0.0.1:443 /home/x/data', failReason: 'network', platformSupported: true }), install: () => Promise.resolve() };
  const stored = { v: { enabled: false } };
  const t = routes_setup({ stored, ft: fakeTimers(), eng, clock: { t: 0 }, adminName: 'Pat' });
  const adm = (await t.call('GET', '/api/voice/status', 'admin')).json();
  assert.strictEqual(adm.failReason, 'network'); assert.match(adm.error, /ECONNREFUSED/);
  const mem = (await t.call('GET', '/api/voice/status', 'member')).json();
  assert.strictEqual(mem.failReason, 'network'); assert.strictEqual(mem.error, null); assert.strictEqual(mem.failed, true);
  assert.ok(!JSON.stringify(mem).includes('/home/x'));
});

test('status: adminName is the admin\'s name for a member and null for an admin', async () => {
  routes.resetEnsureForTests();
  const eng = { status: () => ({ ready: true, installing: false, error: '', platformSupported: true }), install: () => Promise.resolve() };
  const t = routes_setup({ stored: { v: undefined }, ft: fakeTimers(), eng, clock: { t: 0 }, adminName: 'Pat' });
  assert.strictEqual((await t.call('GET', '/api/voice/status', 'member')).json().adminName, 'Pat');
  assert.strictEqual((await t.call('GET', '/api/voice/status', 'admin')).json().adminName, null);
});
