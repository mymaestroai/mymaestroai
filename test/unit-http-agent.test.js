'use strict';
// Behavioural tests for lib/http-agent.js. undici is replaced by a recording fake Agent, child_process.execFile and
// os.networkInterfaces are injected, events are published on diagnostics_channel by hand: no sockets are opened.
const test = require('node:test');
const assert = require('node:assert');
const dc = require('diagnostics_channel');
const os = require('os');
const cp = require('child_process');
const path = require('path');

const LIB = path.join(__dirname, '..', 'lib', 'http-agent.js');
const UNDICI = require.resolve('undici');
const realUndici = require.cache[UNDICI];
const realExecFile = cp.execFile;
const realNetIfs = os.networkInterfaces;
const gwKeys = () => Object.keys(process.env).filter(k => k.startsWith('GATEWAY_'));
const savedEnv = Object.fromEntries(gwKeys().map(k => [k, process.env[k]]));

const quiet = () => { const l = console.log, w = console.warn; console.log = console.warn = () => {}; return () => { console.log = l; console.warn = w; }; };

let created;   // fake Agent instances in creation order
let opts;      // options of each
function load(env = {}, { agentCtor } = {}) {
  for (const k of gwKeys()) delete process.env[k];
  Object.assign(process.env, { GATEWAY_NETWATCH: '0' }, env);
  created = []; opts = [];
  class FakeAgent {
    constructor(o) { if (agentCtor) agentCtor(created.length); opts.push(o); created.push(this); this.calls = []; this.closeImpl = () => Promise.resolve(); }
    close() { this.calls.push('close'); return this.closeImpl(); }
    destroy() { this.calls.push('destroy'); return Promise.resolve(); }
  }
  require.cache[UNDICI] = { id: UNDICI, filename: UNDICI, loaded: true, exports: { Agent: FakeAgent } };
  delete require.cache[LIB];
  return require(LIB);
}
test.afterEach(() => { os.networkInterfaces = realNetIfs; cp.execFile = realExecFile; });
test.after(() => {
  if (realUndici) require.cache[UNDICI] = realUndici; else delete require.cache[UNDICI];
  delete require.cache[LIB];
  for (const k of gwKeys()) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

const pub = (name, msg) => dc.channel(name).publish(msg);
const flush = () => new Promise(r => setImmediate(r));

test('pool options: bounded keep-alive pool, pipelining 1, streaming-safe body timeout', async () => {
  const done = quiet();
  const h = load();
  assert.deepStrictEqual(h.init(), { enabled: true });
  done();
  assert.deepStrictEqual(opts[0], { connections: 16, keepAliveTimeout: 60000, keepAliveMaxTimeout: 300000, headersTimeout: 600000,
    bodyTimeout: 0, connect: { timeout: 20000 }, pipelining: 1 });
  assert.strictEqual(h.dispatcherOption().dispatcher, created[0]);
  assert.deepStrictEqual(h.stats().config, { connections: 16, keepAliveTimeoutMs: 60000, keepAliveMaxMs: 300000 });
});

test('env overrides are honoured; non-numeric values fall back to defaults', () => {
  const done = quiet();
  const h = load({ GATEWAY_MAX_CONNECTIONS: '4', GATEWAY_KEEPALIVE_MS: 'abc', GATEWAY_BODY_TIMEOUT_MS: '9000' });
  h.init(); done();
  assert.strictEqual(opts[0].connections, 4);
  assert.strictEqual(opts[0].keepAliveTimeout, 60000);
  assert.strictEqual(opts[0].bodyTimeout, 9000);
});

test('GATEWAY_KEEPALIVE=0 is a kill switch: no Agent, empty dispatcher option', () => {
  const done = quiet();
  const h = load({ GATEWAY_KEEPALIVE: '0' });
  assert.deepStrictEqual(h.init(), { enabled: false });
  done();
  assert.deepStrictEqual(h.dispatcherOption(), {});
  assert.strictEqual(created.length, 0);
  assert.strictEqual(h.enabled, false);
});

test('init is idempotent; a throwing Agent constructor falls back to bare fetch', () => {
  const done = quiet();
  const h = load();
  h.init(); h.init(); h.dispatcherOption();
  assert.strictEqual(created.length, 1);
  const h2 = load({}, { agentCtor: () => { throw new Error('boom'); } });
  assert.deepStrictEqual(h2.init(), { enabled: false });
  done();
  assert.deepStrictEqual(h2.dispatcherOption(), {});
});

test('recycle rotates (new agent for new requests, old one close()d, not destroyed) and records why', async () => {
  const done = quiet();
  const h = load(); h.init();
  assert.strictEqual(h.recycle('test reason'), true);
  const st = h.stats();
  assert.notStrictEqual(h.dispatcherOption().dispatcher, created[0]);
  assert.strictEqual(h.dispatcherOption().dispatcher, created[1]);
  assert.deepStrictEqual(created[0].calls, ['close']);
  assert.strictEqual(st.recycles, 1);
  assert.strictEqual(st.netWatch.lastRecycleReason, 'test reason');
  assert.strictEqual(st.netWatch.draining, 1);
  await flush();
  assert.strictEqual(h.stats().netWatch.draining, 0);
  done();
});

test('recycle: undrained old pool is destroyed after the 90s grace; close() rejection destroys immediately; no-op when disabled', async (t) => {
  const done = quiet();
  const h = load(); h.init();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  created[0].closeImpl = () => new Promise(() => {});
  h.recycle('wedged');
  t.mock.timers.tick(89999); await flush();
  assert.deepStrictEqual(created[0].calls, ['close']);
  t.mock.timers.tick(1); await flush();
  assert.deepStrictEqual(created[0].calls, ['close', 'destroy']);
  assert.strictEqual(h.stats().netWatch.draining, 0);
  created[1].closeImpl = () => Promise.reject(new Error('x'));
  h.recycle('rejected'); await flush();
  assert.deepStrictEqual(created[1].calls, ['close', 'destroy']);
  t.mock.timers.reset();
  assert.strictEqual(load({ GATEWAY_KEEPALIVE: '0' }).recycle('x'), false);
  done();
});

test('recycle keeps the existing pool when building a replacement fails', () => {
  const done = quiet();
  const h = load({}, { agentCtor: (n) => { if (n >= 1) throw new Error('no more'); } });
  h.init();
  assert.strictEqual(h.recycle('r'), false);
  assert.strictEqual(h.dispatcherOption().dispatcher, created[0]);
  assert.strictEqual(h.stats().recycles, 0);
  done();
});

test('3 consecutive connect errors recycle once; a successful connect resets the count; 15s floor between recycles', async () => {
  const done = quiet();
  const h = load(); h.init();
  pub('undici:client:connectError', {}); pub('undici:client:connectError', {});
  pub('undici:client:connected', { socket: {} });
  pub('undici:client:connectError', {}); pub('undici:client:connectError', {});
  assert.strictEqual(h.stats().recycles, 0);
  pub('undici:client:connectionError', {});
  assert.strictEqual(h.stats().recycles, 1);
  assert.match(h.stats().netWatch.lastRecycleReason, /3 consecutive connect errors/);
  for (let i = 0; i < 6; i++) pub('undici:client:connectError', {});
  assert.strictEqual(h.stats().recycles, 1);
  assert.ok(h.stats().connectionErrors >= 8);
  done();
});

test('telemetry: new vs reused socket attribution via x-hub-req-id (string, array and object header forms)', () => {
  const done = quiet();
  const h = load(); h.init(); done();
  const sock = { alpnProtocol: 'http/1.1', getProtocol: () => 'TLSv1.3', isSessionReused: () => false };
  pub('undici:client:beforeConnect', {});
  pub('undici:client:connected', { socket: sock });
  pub('undici:client:sendHeaders', { socket: sock, headers: 'POST /v1 HTTP/1.1\r\nHost: x\r\nx-hub-req-id: ha1\r\n\r\n' });
  const a = h.takeConnInfo('ha1');
  assert.strictEqual(a.reused, false);
  assert.strictEqual(a.alpn, 'http/1.1');
  assert.strictEqual(a.tls, 'TLSv1.3');
  assert.ok(a.connectMs >= 0 && a.connectMs < 5000);
  assert.strictEqual(h.takeConnInfo('ha1'), null);
  pub('undici:client:sendHeaders', { socket: sock, headers: ['host', 'x', 'X-Hub-Req-Id', 'hb2'] });
  const b = h.takeConnInfo('hb2');
  assert.deepStrictEqual([b.reused, b.socketId, b.connectMs], [true, a.socketId, 0]);
  pub('undici:client:sendHeaders', { socket: sock, headers: { 'x-hub-req-id': 'hc3' } });
  assert.strictEqual(h.takeConnInfo('hc3').reused, true);
  pub('undici:client:sendHeaders', { socket: sock, headers: 'GET / HTTP/1.1\r\n\r\n' });   // no id: ignored
  const st = h.stats();
  assert.deepStrictEqual([st.newHits, st.reusedHits, st.reusePct, st.pendingTracked], [1, 2, 66.7, 0]);
  assert.strictEqual(h.takeConnInfo(null), null);
});

test('request ids are unique and noteRequest counts', () => {
  const h = load();
  const ids = new Set(Array.from({ length: 50 }, () => h.newRequestId()));
  assert.strictEqual(ids.size, 50);
  for (const id of ids) assert.match(id, /^h[0-9a-z]+$/);
  h.noteRequest(); h.noteRequest();
  assert.strictEqual(h.stats().requests, 2);
});

const IFACES = { lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  utun3: [{ address: '10.1.1.2', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
  eth0: [{ address: '192.168.1.5', family: 4, internal: false }] };
const fakeRoute = (impl) => { cp.execFile = (cmd, args, o, cb) => { fakeRoute.last = [cmd, args]; impl(cb); }; };

const asPlatform = async (p, fn) => {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: p });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', orig); }
};

test('fingerprint (macOS): external IPv4 only, sorted by interface name, route part parsed from `route -n get default`', async () => {
  os.networkInterfaces = () => IFACES;
  fakeRoute((cb) => cb(null, '   route to: default\n    gateway: 10.1.1.1\n  interface: utun3\n'));
  const h = load();
  await asPlatform('darwin', async () => {
    assert.strictEqual(await h.fingerprint(), 'route:utun3/10.1.1.1|eth0=192.168.1.5,utun3=10.1.1.2');
    assert.deepStrictEqual(fakeRoute.last, ['route', ['-n', 'get', 'default']]);
  });
});

test('fingerprint (Linux): uses `ip route show default`, so a VPN swapping the default route changes the fingerprint', async () => {
  os.networkInterfaces = () => IFACES;
  let impl;   // execFile is captured at load, so install the fake first and swap behaviour through `impl`
  fakeRoute((cb) => impl(cb));
  const h = load();
  await asPlatform('linux', async () => {
    impl = (cb) => cb(null, 'default via 192.168.1.1 dev eth0 proto dhcp metric 100\ndefault via 10.1.1.1 dev utun3 metric 600\n');
    const before = await h.fingerprint();
    assert.strictEqual(before, 'route:eth0/192.168.1.1|eth0=192.168.1.5,utun3=10.1.1.2');   // first (preferred) default route only
    assert.deepStrictEqual(fakeRoute.last, ['ip', ['route', 'show', 'default']]);
    impl = (cb) => cb(null, 'default via 10.1.1.1 dev utun3 metric 50\n');   // VPN takes over the default route
    assert.notStrictEqual(await h.fingerprint(), before);
    impl = (cb) => cb(null, 'default dev wg0 scope link\n');   // no gateway
    assert.match(await h.fingerprint(), /^route:wg0\/\?\|/);
    impl = (cb) => cb(new Error('ENOENT'), '');
    assert.match(await h.fingerprint(), /^route:\?\|/);
  });
});

test('netwatch: address change rotates the pool, an unchanged fingerprint does not', async (t) => {
  const done = quiet();
  fakeRoute((cb) => cb(new Error('exit 1'), ''));
  os.networkInterfaces = () => IFACES;
  const h = load({ GATEWAY_NETWATCH: '1', GATEWAY_NETWATCH_MS: '1000' });
  t.mock.timers.enable({ apis: ['setInterval'] });
  h.init(); await flush();
  assert.ok(h.stats().netWatch.fingerprint.startsWith('route:?|'));
  t.mock.timers.tick(1000); await flush();
  assert.strictEqual(h.stats().recycles, 0);
  os.networkInterfaces = () => ({ eth0: IFACES.eth0 });   // VPN utun3 went away
  t.mock.timers.tick(1000); await flush();
  assert.strictEqual(h.stats().recycles, 1);
  assert.strictEqual(h.stats().netWatch.lastRecycleReason, 'network change');
  assert.strictEqual(h.stats().netWatch.enabled, true);
  h.stopNetWatch();
  assert.strictEqual(h.stats().netWatch.enabled, false);
  t.mock.timers.reset();
  done();
});

test('close() stops the watcher, closes the live agent and destroys draining ones', async () => {
  const done = quiet();
  const h = load(); h.init();
  created[0].closeImpl = () => new Promise(() => {});
  h.recycle('r');
  await h.close();
  assert.ok(created[1].calls.includes('close'));
  assert.ok(created[0].calls.includes('destroy'));
  assert.strictEqual(h.stats().netWatch.draining, 0);
  done();
});
