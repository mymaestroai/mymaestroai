'use strict';
// Background module connectors (lib/connectors): request(), hub/notify, exit + restart with backoff, startBackground,
// CONNECTOR_MEDIA_DIR. Also McpStdioClient.request() and its 'exit' event against test/fixtures/stdio-echo.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createConnectors } = require('../lib/connectors');
const McpStdioClient = require('../lib/skills/mcp-stdio');
const ECHO = path.join(__dirname, 'fixtures', 'stdio-echo.js');

// A stand-in client: records what it is given, answers requests with a canned result.
function makeFake() {
  const all = [];
  class FakeClient extends EventEmitter {
    constructor(command, args, opts) { super(); this.command = command; this.opts = opts; this.sent = []; this.responses = []; this.errors = []; this.disconnected = false; all.push(this); }
    async connect() { if (FakeClient.failNext) { FakeClient.failNext--; throw new Error('boom'); } }
    async listTools() { return [{ name: 'one' }]; }
    async request(method, params, o) { this.sent.push({ method, params, o }); return { echoed: method }; }
    respond(id, result) { this.responses.push({ id, result }); }
    respondError(id, code, message) { this.errors.push({ id, code, message }); }
    async disconnect() { this.disconnected = true; }
  }
  FakeClient.failNext = 0;
  return { FakeClient, all };
}

function rig(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connbg-'));
  const { FakeClient, all } = makeFake();
  const timers = []; const logs = []; let t = 1_700_000_000_000;
  const cx = createConnectors({
    file: path.join(dir, 'connectors.json'), keyFile: path.join(dir, '.auth-key'),
    McpClient: o.McpClient || FakeClient, now: () => t, log: (...a) => logs.push(a.join(' ')), unlockTtlMs: 0,
    setTimer: (fn, ms) => { const x = { fn, ms, cleared: false }; timers.push(x); return x; }, clearTimer: (x) => { x.cleared = true; },
    baseEnv: { PATH: process.env.PATH }, leadNames: () => ['owner'], ...(o.opts || {}),
  });
  const mod = (extra = {}) => ({ id: 'bg', label: 'Background', kind: 'mcp', command: process.execPath, args: ['x'], module: 'bgmod', enabled: true, ...extra });
  const pending = () => timers.filter(x => !x.cleared && !x.fired);
  const fire = (x) => { x.fired = true; x.fn(); };
  const tick = () => new Promise((r) => setImmediate(r));
  return { cx, dir, all, FakeClient, timers, logs, mod, pending, fire, tick, advance: (ms) => { t += ms; } };
}
const up = (cx, spec) => cx.upsert(spec, { byModule: true });
const flush = async (r) => { for (let i = 0; i < 5; i++) await r.tick(); };

test('request(): refuses non-module, disabled and locked connectors with ENOTAVAILABLE', async () => {
  const r = rig();
  await assert.rejects(() => r.cx.request('nope', 'm'), { code: 'ENOTAVAILABLE' });
  r.cx.upsert({ id: 'plain', kind: 'mcp', command: process.execPath, args: ['x'], enabled: true });
  await assert.rejects(() => r.cx.request('plain', 'm'), { code: 'ENOTAVAILABLE' });
  up(r.cx, r.mod({ enabled: false }));
  await assert.rejects(() => r.cx.request('bg', 'm'), { code: 'ENOTAVAILABLE' });
  up(r.cx, r.mod());
  r.cx.upsert({ id: 'bg', protect: 'own' }, { byModule: true, newPassphrase: 'correct horse battery' });
  r.cx.lock('bg');
  await assert.rejects(() => r.cx.request('bg', 'm'), { code: 'ENOTAVAILABLE' });
  assert.equal(r.all.length, 0, 'nothing was started');
});

test('request(): starts the server when needed and passes method, params and timeout', async (t) => {
  const r = rig(); t.after(() => r.cx.shutdown());
  up(r.cx, r.mod());
  assert.equal(r.all.length, 0);
  const res = await r.cx.request('bg', 'echo/back', { a: 1 }, { timeoutMs: 1234 });
  assert.deepEqual(res, { echoed: 'echo/back' });
  assert.equal(r.all.length, 1);
  assert.deepEqual(r.all[0].sent[0], { method: 'echo/back', params: { a: 1 }, o: { timeout: 1234 } });
  await r.cx.request('bg', 'x');
  assert.equal(r.all.length, 1, 'the running server is reused');
  assert.equal(r.all[0].sent[1].o.timeout, 10000, 'default timeout');
});

test('module-managed fields: background, notify and mediaDir are locked against edits that are not from the module', () => {
  const r = rig();
  up(r.cx, r.mod());
  for (const k of ['background', 'notify', 'mediaDir']) assert.throws(() => r.cx.upsert({ id: 'bg', [k]: k === 'mediaDir' ? '/tmp/x' : true }), /belongs to the/, k);
});

test('hub/notify: the handler is called only when notify is set; setNotifyHandler replaces it', async (t) => {
  const r = rig(); t.after(() => r.cx.shutdown());
  up(r.cx, r.mod({ notify: true }));
  await r.cx.request('bg', 'x');
  const c = r.all[0];
  c.emit('request', { id: 1, method: 'hub/notify', params: { text: 'hi' } });
  await flush(r);
  assert.deepEqual(c.responses, [{ id: 1, result: { ok: false, error: 'Notices are not set up.' } }], 'default handler');
  const calls = [];
  r.cx.setNotifyHandler(async (id, p) => { calls.push([id, p]); return { ok: true }; });
  c.emit('request', { id: 2, method: 'hub/notify', params: { text: 'yo' } });
  c.emit('request', { id: 3, method: 'hub/notify' });
  await flush(r);
  assert.deepEqual(calls, [['bg', { text: 'yo' }], ['bg', {}]]);
  assert.deepEqual(c.responses.slice(1), [{ id: 2, result: { ok: true } }, { id: 3, result: { ok: true } }]);
  r.cx.setNotifyHandler(async () => { throw new Error('secret detail'); });
  c.emit('request', { id: 4, method: 'hub/notify', params: {} });
  await flush(r);
  assert.deepEqual(c.errors, [{ id: 4, code: -32000, message: 'The notice could not be delivered.' }]);

  // a connector without notify gets -32601 and the handler is never called
  up(r.cx, r.mod({ id: 'quiet', notify: false }));
  await r.cx.request('quiet', 'x');
  const q = r.all[1];
  calls.length = 0; r.cx.setNotifyHandler(async (id, p) => { calls.push(id); return { ok: true }; });
  q.emit('request', { id: 9, method: 'hub/notify', params: {} });
  await flush(r);
  assert.deepEqual(q.errors, [{ id: 9, code: -32601, message: 'Method not found.' }]);
  assert.deepEqual(calls, []);
});

test('hub/refresh_token: saved with rotatingSecret, refused (-32601) without; unknown methods get -32601; a stale client gets -32000', async (t) => {
  const r = rig(); t.after(() => r.cx.shutdown());
  up(r.cx, r.mod({ rotatingSecret: 'REFRESH', secrets: { REFRESH: 'old-value-123456' } }));
  await r.cx.request('bg', 'x');
  const c = r.all[0];
  c.emit('request', { id: 1, method: 'hub/refresh_token', params: { value: 'new-value-abcdef' } });
  assert.deepEqual(c.responses, [{ id: 1, result: { ok: true } }]);
  assert.equal(r.cx.readSecrets('bg', ['REFRESH'], { byModule: true }).REFRESH, 'new-value-abcdef');
  c.emit('request', { id: 2, method: 'something/else', params: {} });
  assert.deepEqual(c.errors, [{ id: 2, code: -32601, message: 'Method not found.' }]);

  up(r.cx, r.mod({ id: 'norot' }));
  await r.cx.request('norot', 'x');
  const n = r.all[1];
  n.emit('request', { id: 5, method: 'hub/refresh_token', params: { value: 'new-value-abcdef' } });
  assert.deepEqual(n.errors, [{ id: 5, code: -32601, message: 'Method not found.' }]);

  r.cx.stop('bg');
  c.emit('request', { id: 7, method: 'hub/refresh_token', params: { value: 'zzzzzzzzzzzzzz' } });
  assert.equal(c.errors.at(-1).code, -32000);
});

test('exit: the client is removed and restarts come at 5 s, 30 s, 2 min, then 10 min; 10 minutes up resets the backoff', async (t) => {
  const r = rig(); t.after(() => r.cx.shutdown());
  up(r.cx, r.mod({ background: true }));
  await flush(r);
  assert.equal(r.all.length, 1, 'enabling a background connector starts it');
  assert.equal(r.cx.list().connectors[0].running, true);
  const delays = [];
  for (let i = 0; i < 5; i++) {
    const c = r.all[r.all.length - 1];
    c.emit('exit', { code: 7, signal: null });
    assert.equal(r.cx.list().connectors[0].running, false, 'removed from the running set');
    assert.equal(r.cx.list().connectors[0].lastError, 'It stopped unexpectedly (exit code 7).');
    const p = r.pending(); assert.equal(p.length, 1);
    delays.push(p[0].ms);
    r.fire(p[0]); await flush(r);
    assert.equal(r.all.length, i + 2, 'restarted');
  }
  assert.deepEqual(delays, [5000, 30000, 120000, 600000, 600000]);
  assert.ok(r.logs.filter(l => /restarting/.test(l)).length >= 5, 'one log line per attempt');
  // stays up 10 minutes, then dies: back to the start
  r.advance(10 * 60 * 1000);
  r.all.at(-1).emit('exit', { code: 1, signal: null });
  assert.equal(r.pending()[0].ms, 5000);
});

test('a failed start sets lastError and enters the backoff', async (t) => {
  const r = rig(); t.after(() => r.cx.shutdown());
  r.FakeClient.failNext = 2;
  up(r.cx, r.mod({ background: true }));
  await flush(r);
  assert.match(r.cx.list().connectors[0].lastError, /boom/);
  let p = r.pending(); assert.equal(p.length, 1); assert.equal(p[0].ms, 5000);
  r.fire(p[0]); await flush(r);
  p = r.pending(); assert.equal(p.length, 1); assert.equal(p[0].ms, 30000);
  r.fire(p[0]); await flush(r);
  assert.equal(r.cx.list().connectors[0].running, true);
  assert.equal(r.cx.list().connectors[0].lastError, null);
});

test('stop() cancels a pending restart; an exit after stop schedules nothing; a disabled connector is not restarted', async () => {
  const r = rig();
  up(r.cx, r.mod({ background: true }));
  await flush(r);
  const c = r.all[0];
  c.emit('exit', { code: 1 });
  const p = r.pending(); assert.equal(p.length, 1);
  r.cx.stop('bg');
  assert.ok(p[0].cleared, 'the restart timer was cancelled');
  assert.equal(r.pending().length, 0);

  r.cx.startBackground(); await flush(r);
  const d = r.all.at(-1);
  r.cx.stop('bg');
  d.emit('exit', { code: 1 });
  assert.equal(r.pending().length, 0, 'an exit after stop schedules nothing');

  r.cx.startBackground(); await flush(r);
  const e = r.all.at(-1);
  up(r.cx, r.mod({ background: true, enabled: false }));
  assert.equal(e.disconnected, true, 'disabling stops it');
  assert.equal(r.pending().length, 0);
  r.cx.remove('bg', { byModule: true });
});

test('startBackground(): only background + enabled + unlocked module connectors that are not running', async (t) => {
  const r = rig(); t.after(() => r.cx.shutdown());
  r.cx.upsert({ id: 'plain', kind: 'mcp', command: process.execPath, args: ['x'], enabled: true });
  up(r.cx, r.mod({ id: 'idle', background: false }));
  up(r.cx, r.mod({ id: 'off', background: true, enabled: false }));
  up(r.cx, r.mod({ id: 'locked', background: true }));
  r.cx.upsert({ id: 'locked', protect: 'own' }, { byModule: true, newPassphrase: 'correct horse battery' });
  r.cx.lock('locked');
  await flush(r);
  up(r.cx, r.mod({ id: 'run1', background: true }));
  await flush(r);
  r.cx.stop('run1');
  const before = r.all.length;
  const tried = r.cx.startBackground();
  assert.deepEqual(tried, ['run1']);
  await flush(r);
  assert.equal(r.all.length, before + 1);
  assert.deepEqual(r.cx.startBackground(), [], 'already running');
});

test('CONNECTOR_MEDIA_DIR reaches the child env only when mediaDir is set, and the folder is made', async (t) => {
  const r = rig(); t.after(() => r.cx.shutdown());
  const media = path.join(r.dir, 'media', 'deep');
  up(r.cx, r.mod({ id: 'withmedia', mediaDir: media }));
  up(r.cx, r.mod({ id: 'nomedia' }));
  await r.cx.request('withmedia', 'x'); await r.cx.request('nomedia', 'x');
  assert.equal(r.all[0].opts.env.CONNECTOR_MEDIA_DIR, media);
  assert.ok(fs.statSync(media).isDirectory());
  assert.equal('CONNECTOR_MEDIA_DIR' in r.all[1].opts.env, false);
});

test('mediaDir that cannot be made: lastError and the server is not started', async () => {
  const r = rig();
  const blocker = path.join(r.dir, 'file'); fs.writeFileSync(blocker, 'x');
  up(r.cx, r.mod({ mediaDir: path.join(blocker, 'sub') }));
  await assert.rejects(() => r.cx.request('bg', 'x'), /Could not make its folder/);
  assert.equal(r.cx.list().connectors[0].lastError, 'Could not make its folder');
  assert.equal(r.all.length, 0);
});

// ── McpStdioClient against a real child ──
test('McpStdioClient.request(): round trip, JSON-RPC error, timeout; "exit" fires with the exit code', async (t) => {
  const c = new McpStdioClient(process.execPath, [ECHO], { minTools: 1, timeout: 5000 });
  t.after(() => c.disconnect());
  const res = await c.request('echo/back', { a: [1, 2] });
  assert.deepEqual(res, { params: { a: [1, 2] } });
  await assert.rejects(() => c.request('nope'), /MCP error -32601: unknown method/);
  await assert.rejects(() => c.request('die-not', {}, { timeout: 50 }).then(() => { throw new Error('should reject'); }), /MCP error -32601/);
  const exited = new Promise((resolve) => c.once('exit', resolve));
  c.request('die', {}).catch(() => {});
  assert.deepEqual(await exited, { code: 3, signal: null });
});

test('McpStdioClient: a request that is never answered times out with the given timeout', async (t) => {
  const c = new McpStdioClient(process.execPath, ['-e', "process.stdin.on('data', d => { for (const l of String(d).split('\\n')) { try { const m = JSON.parse(l); if (m.method === 'initialize') console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} })); } catch {} } })"], { timeout: 5000 });
  t.after(() => c.disconnect());
  await assert.rejects(() => c.request('silent', {}, { timeout: 80 }), /timed out after 80ms: silent/);
});
