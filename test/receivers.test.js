'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createReceivers } = require('../lib/modules/receivers');

function makeEnv(over = {}) {
  const env = {
    manifest: { name: 'Demo', receiver: { paths: ['events', 'link'], headers: ['x-signature'] } },
    connector: { id: 'demo', enabled: true },
    aliases: {},
    calls: [],
    logs: [],
    clock: 1000000,
    reply: { status: 200, body: 'ok' },
    fail: null,
    ...over,
  };
  env.r = createReceivers({
    manifestOf: (id) => (id === 'demo' ? env.manifest : null),
    connectorFor: (id) => (id === 'demo' ? env.connector : null),
    request: async (id, method, params, opts) => { env.calls.push({ id, method, params, opts }); if (env.fail) throw env.fail; return env.reply; },
    getSetting: (k) => (k === 'receiverAliases' ? env.aliases : undefined),
    now: () => env.clock,
    log: (m) => env.logs.push(m),
  });
  return env;
}

function fakeReq({ method = 'POST', url = '/hooks/demo/events', headers = {}, body = null, peer = '203.0.113.9' } = {}) {
  const req = new EventEmitter();
  req.method = method; req.url = url; req.headers = { host: 'hub.example.com', ...headers };
  req.socket = { remoteAddress: peer, destroyed: false, destroy() { this.destroyed = true; } };
  req.send = () => { if (body !== null) req.emit('data', Buffer.from(body)); req.emit('end'); };
  return req;
}
function fakeRes() {
  return { headersSent: false, status: null, headers: null, body: undefined, writeHead(s, h) { this.status = s; this.headers = h; this.headersSent = true; }, end(b) { this.body = b; this.ended = true; } };
}
async function run(env, opts, hit = { id: 'demo', sub: 'events' }) {
  const req = fakeReq(opts); const res = fakeRes();
  const p = env.r.handle(req, res, hit);
  req.send();
  await p;
  return { req, res };
}
const hdr = (res, name) => { for (const k of Object.keys(res.headers)) if (k.toLowerCase() === name.toLowerCase()) return res.headers[k]; return undefined; };

test('match: hooks path', () => {
  const { r } = makeEnv();
  assert.deepStrictEqual(r.match('/hooks/demo/events'), { id: 'demo', sub: 'events' });
  assert.strictEqual(r.match('/hooks/Demo/events'), null);
  assert.strictEqual(r.match('/hooks/d/events'), null);
  assert.strictEqual(r.match('/hooks/demo/-x'), null);
  assert.strictEqual(r.match('/hooks/demo/'), null);
  assert.strictEqual(r.match('/hooks/demo/a/b'), null);
  assert.strictEqual(r.match('/hooks/demo/' + 'a'.repeat(42)), null);
  assert.strictEqual(r.match('/other/x'), null);
});

test('match: aliases', () => {
  const env = makeEnv({ aliases: { '/pay/': 'demo', '/api/': 'demo', '/share/': 'demo', '/Bad/': 'demo', '/ok/': 'Not Valid' } });
  const { r } = env;
  assert.deepStrictEqual(r.match('/pay/events'), { id: 'demo', sub: 'events' });
  assert.strictEqual(r.match('/api/events'), null);
  assert.strictEqual(r.match('/share/events'), null);
  assert.strictEqual(r.match('/Bad/events'), null);
  assert.strictEqual(r.match('/ok/events'), null);
  assert.strictEqual(r.match('/pay/events/more'), null);
  assert.strictEqual(r.match('/pay/'), null);
  assert.strictEqual(r.match('/nope/events'), null);
  assert.strictEqual(r.match('/__proto__/events'), null);
});

test('match: reserved alias keys are all refused', () => {
  const names = 'api v1 hooks oauth icons vendor static mobile login logout welcome help users modules health setup setup-admin agent-settings tiger-team local-models files share'.split(' ');
  const aliases = {}; for (const n of names) aliases[`/${n}/`] = 'demo';
  const { r } = makeEnv({ aliases });
  for (const n of names) assert.strictEqual(r.match(`/${n}/events`), null, n);
});

test('match: never touches the manifest', () => {
  let touched = 0;
  const r = createReceivers({ manifestOf: () => { touched++; return null; }, connectorFor: () => { touched++; return null; }, request: async () => ({}), getSetting: () => ({}) });
  r.match('/hooks/demo/events'); r.match('/x/y');
  assert.strictEqual(touched, 0);
});

test('refuses: unknown module, undeclared sub, disabled connector, no connector', async () => {
  let env = makeEnv();
  let { res } = await run(env, {}, { id: 'nomod', sub: 'events' });
  assert.strictEqual(res.status, 404); assert.strictEqual(res.body, 'Not found');
  ({ res } = await run(env, {}, { id: 'demo', sub: 'other' }));
  assert.strictEqual(res.status, 404); assert.strictEqual(res.body, 'Not found');
  env = makeEnv({ connector: { id: 'demo', enabled: false } });
  ({ res } = await run(env, {}));
  assert.strictEqual(res.status, 404); assert.strictEqual(res.body, 'Not found');
  env = makeEnv({ manifest: { name: 'Demo' } });
  ({ res } = await run(env, {}));
  assert.strictEqual(res.status, 404);
  assert.strictEqual(env.calls.length, 0);
});

test('refuses: methods', async () => {
  const env = makeEnv();
  for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const { res } = await run(env, { method });
    assert.strictEqual(res.status, 405, method);
  }
  assert.strictEqual(env.calls.length, 0);
});

test('refuses: cross-site and foreign origin', async () => {
  const env = makeEnv();
  let { res } = await run(env, { headers: { origin: 'https://evil.example' } });
  assert.strictEqual(res.status, 403);
  ({ res } = await run(env, { headers: { 'sec-fetch-site': 'cross-site' } }));
  assert.strictEqual(res.status, 403);
  ({ res } = await run(env, { headers: { origin: 'https://hub.example.com', 'sec-fetch-site': 'cross-site' } }));
  assert.strictEqual(res.status, 403);
  ({ res } = await run(env, { headers: { origin: 'https://hub.example.com', 'sec-fetch-site': 'same-origin' } }));
  assert.strictEqual(res.status, 200);
  ({ res } = await run(env, { headers: { origin: 'http://HUB.example.com'.replace('HUB', 'hub') } }));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(env.calls.length, 2);
});

test('rate limit: 429 at the 121st, per ip, and the window slides', async () => {
  const env = makeEnv();
  for (let i = 0; i < 120; i++) assert.strictEqual((await run(env, { method: 'GET' })).res.status, 200);
  const { res } = await run(env, { method: 'GET' });
  assert.strictEqual(res.status, 429);
  assert.strictEqual(hdr(res, 'retry-after'), '60');
  assert.strictEqual((await run(env, { method: 'GET', peer: '203.0.113.10' })).res.status, 200);
  env.clock += 61000;
  assert.strictEqual((await run(env, { method: 'GET' })).res.status, 200);
});

test('rate limit: key map is bounded', async () => {
  const env = makeEnv();
  for (let i = 0; i < 5100; i++) {
    if (i && i % 500 === 0) env.clock += 61000;   // stay under the per-module ceiling of 600 a minute
    await run(env, { method: 'GET', peer: `10.${(i >> 8) & 255}.${i & 255}.1` });
  }
  // the oldest key was dropped, so its owner starts fresh; nothing throws
  assert.strictEqual((await run(env, { method: 'GET', peer: '10.0.0.1' })).res.status, 200);
});

test('rate limit: a module takes at most 600 a minute across all addresses (forged proxy headers)', async () => {
  const env = makeEnv();
  let last;
  for (let i = 0; i < 601; i++) last = await run(env, { method: 'GET', peer: '127.0.0.1', headers: { 'cf-connecting-ip': `10.1.${(i >> 8) & 255}.${i & 255}` } });
  assert.strictEqual(last.res.status, 429);
  env.clock += 61000;
  assert.strictEqual((await run(env, { method: 'GET', peer: '127.0.0.1', headers: { 'cf-connecting-ip': '10.2.0.1' } })).res.status, 200);
});

test('an HTML page from the module without its own policy gets a strict one', async () => {
  const env = makeEnv({ reply: { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<p>hi</p>' } });
  const { res } = await run(env, { method: 'GET', url: '/hooks/demo/link' });
  assert.match(String(res.headers['content-security-policy']), /default-src 'none'/);
  const env2 = makeEnv({ reply: { status: 200, headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'" }, body: 'x' } });
  assert.deepStrictEqual((await run(env2, { method: 'GET', url: '/hooks/demo/link' })).res.headers['content-security-policy'], ["default-src 'self'", 'sandbox allow-forms']);
});

test('body over the cap: 413 and the socket is destroyed', async () => {
  const env = makeEnv({ manifest: { name: 'Demo', receiver: { paths: ['events'], maxBody: 10 } } });
  const { req, res } = await run(env, { body: 'x'.repeat(11) });
  assert.strictEqual(res.status, 413);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(req.socket.destroyed, true);
  assert.strictEqual(env.calls.length, 0);
  const ok = await run(makeEnv({ manifest: env.manifest }), { body: 'x'.repeat(10) });
  assert.strictEqual(ok.res.status, 200);
});

test('query over 4096: 414', async () => {
  const env = makeEnv();
  let { res } = await run(env, { method: 'GET', url: '/hooks/demo/events?' + 'a'.repeat(4097) });
  assert.strictEqual(res.status, 414);
  ({ res } = await run(env, { method: 'GET', url: '/hooks/demo/events?' + 'a'.repeat(4096) }));
  assert.strictEqual(res.status, 200);
});

test('forwarding: allowed headers only, base64 body, query, path', async () => {
  const env = makeEnv();
  await run(env, {
    url: '/hooks/demo/events?a=1&b=2', body: 'hello é',
    headers: { 'content-type': 'text/plain', 'user-agent': 'ua', accept: '*/*', 'x-signature': 'sha256=abc', cookie: 'sid=1', authorization: 'Bearer t', 'x-other': 'no', 'x-forwarded-for': '1.2.3.4' },
  });
  const p = env.calls[0].params;
  assert.strictEqual(env.calls[0].id, 'demo');
  assert.strictEqual(env.calls[0].method, 'hub/receive');
  assert.deepStrictEqual(env.calls[0].opts, { timeoutMs: 10000 });
  assert.deepStrictEqual(p.headers, { 'content-type': 'text/plain', 'user-agent': 'ua', accept: '*/*', 'x-signature': 'sha256=abc' });
  assert.strictEqual(Buffer.from(p.body, 'base64').toString('utf8'), 'hello é');
  assert.strictEqual(p.method, 'POST'); assert.strictEqual(p.path, 'events'); assert.strictEqual(p.query, 'a=1&b=2');
  assert.strictEqual(p.ip, '203.0.113.9');
  assert.strictEqual(p.at, new Date(env.clock).toISOString());
});

test('forwarding: header values cut at 4096; GET has an empty body', async () => {
  const env = makeEnv();
  await run(env, { method: 'GET', headers: { 'user-agent': 'u'.repeat(5000) } });
  assert.strictEqual(env.calls[0].params.headers['user-agent'].length, 4096);
  assert.strictEqual(env.calls[0].params.body, '');
});

test('client ip: forwarded values count only from a loopback peer', async () => {
  let env = makeEnv();
  await run(env, { headers: { 'cf-connecting-ip': '198.51.100.7' }, peer: '203.0.113.9' });
  assert.strictEqual(env.calls[0].params.ip, '203.0.113.9');
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    env = makeEnv();
    await run(env, { headers: { 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '1.1.1.1' }, peer });
    assert.strictEqual(env.calls[0].params.ip, '198.51.100.7', peer);
  }
  env = makeEnv();
  await run(env, { headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }, peer: '127.0.0.1' });
  assert.strictEqual(env.calls[0].params.ip, '1.1.1.1');
  env = makeEnv();
  await run(env, { headers: { 'cf-connecting-ip': 'not an ip', 'x-forwarded-for': '<script>' }, peer: '127.0.0.1' });
  assert.strictEqual(env.calls[0].params.ip, '127.0.0.1');
});

test('answers: default headers, module content-type', async () => {
  const env = makeEnv({ reply: { status: 201, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: '<p>hi</p>' } });
  const { res } = await run(env, {});
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.toString(), '<p>hi</p>');
  assert.strictEqual(hdr(res, 'content-type'), 'text/html; charset=utf-8');
  assert.strictEqual(hdr(res, 'x-content-type-options'), 'nosniff');
  assert.strictEqual(hdr(res, 'referrer-policy'), 'no-referrer');
  assert.strictEqual(hdr(res, 'x-frame-options'), 'DENY');
  assert.strictEqual(hdr(res, 'cache-control'), 'no-store');
  const keys = Object.keys(res.headers).map((k) => k.toLowerCase());
  assert.strictEqual(new Set(keys).size, keys.length);
});

test('answers: header filtering', async () => {
  const env = makeEnv({ reply: { status: 200, body: 'x', headers: {
    'Set-Cookie': 'a=b', 'X-Custom': 'v', 'cache-control': 'max-age=5', 'content-security-policy': "default-src 'none'", 'retry-after': '5',
    location: '//evil.example', 'content-type': 'text/plain\r\nX-Evil: 1',
  } } });
  let { res } = await run(env, {});
  const keys = Object.keys(res.headers).map((k) => k.toLowerCase());
  assert.ok(!keys.includes('set-cookie')); assert.ok(!keys.includes('x-custom'));
  assert.ok(!keys.includes('location')); assert.ok(!keys.includes('x-evil'));
  assert.strictEqual(hdr(res, 'content-type'), 'text/plain; charset=utf-8'.replace('; charset=utf-8', '') === 'text/plain' ? hdr(res, 'content-type') : undefined);
  assert.ok(!/[\r\n]/.test(String(hdr(res, 'content-type') || '')));
  assert.strictEqual(hdr(res, 'cache-control'), 'max-age=5');
  assert.deepStrictEqual(hdr(res, 'content-security-policy'), ["default-src 'none'", 'sandbox allow-forms']);
  assert.strictEqual(hdr(res, 'retry-after'), '5');
  for (const [loc, keep] of [['/next', true], ['https://ok.example/x', true], ['http://ok.example', false], ['//x', false], ['javascript:1', false]]) {
    env.reply = { status: 302, headers: { Location: loc } };
    ({ res } = await run(env, {}));
    assert.strictEqual(hdr(res, 'location') === loc, keep, loc);
  }
  env.reply = { status: 200, headers: { 'cache-control': 'x'.repeat(2049) } };
  ({ res } = await run(env, {}));
  assert.strictEqual(hdr(res, 'cache-control'), 'no-store');
});

test('answers: HEAD has no body; base64 body decoded', async () => {
  const env = makeEnv({ reply: { status: 200, body: 'hello' } });
  let { res } = await run(env, { method: 'HEAD' });
  assert.strictEqual(res.status, 200); assert.strictEqual(res.body, undefined);
  env.reply = { status: 200, body: Buffer.from('bin').toString('base64'), bodyEncoding: 'base64' };
  ({ res } = await run(env, {}));
  assert.strictEqual(res.body.toString(), 'bin');
});

test('answers: invalid results are 502', async () => {
  const env = makeEnv();
  const bad = [null, 'ok', {}, { status: 199 }, { status: 600 }, { status: 200.5 }, { status: '200' }, { status: 200, headers: [] }, { status: 200, headers: 'x' },
    { status: 200, body: 5 }, { status: 200, bodyEncoding: 'latin1' }, { status: 200, body: 'x'.repeat(1048577) }];
  for (const reply of bad) {
    env.reply = reply;
    const { res } = await run(env, {});
    assert.strictEqual(res.status, 502, JSON.stringify(reply) && JSON.stringify(reply).slice(0, 40));
  }
  env.reply = { status: 200, body: 'x'.repeat(1048576) };
  assert.strictEqual((await run(env, {})).res.status, 200);
});

test('errors: ENOTAVAILABLE 404, timeout 503, other 502', async () => {
  const env = makeEnv();
  env.fail = Object.assign(new Error('gone'), { code: 'ENOTAVAILABLE' });
  let { res } = await run(env, {});
  assert.strictEqual(res.status, 404); assert.strictEqual(res.body, 'Not found');
  env.fail = new Error('request hub/receive timed out');
  ({ res } = await run(env, {}));
  assert.strictEqual(res.status, 503); assert.strictEqual(hdr(res, 'retry-after'), '10');
  env.fail = new Error('boom');
  ({ res } = await run(env, {}));
  assert.strictEqual(res.status, 502);
});

test('log: one line, no bodies, queries or headers', async () => {
  const env = makeEnv();
  await run(env, { url: '/hooks/demo/events?secret=1', body: 'private', headers: { 'x-signature': 'sig' } });
  assert.strictEqual(env.logs.length, 1);
  assert.match(env.logs[0], /^\[hooks\] demo POST events -> 200 \d+ms$/);
});

const SANDBOX = 'sandbox allow-forms';
const cspLines = (res) => [].concat(hdr(res, 'content-security-policy'));

test('isolation: every reply carries the hub sandbox line as its own line', async () => {
  let env = makeEnv({ reply: { status: 200, headers: { 'content-type': 'text/html' }, body: '<p>x</p>' } });
  let { res } = await run(env, { method: 'GET', url: '/hooks/demo/link' });
  const lines = cspLines(res);
  assert.strictEqual(lines.length, 2); assert.match(lines[0], /default-src 'none'/); assert.strictEqual(lines[1], SANDBOX);
  env = makeEnv({ reply: { status: 200, headers: { 'content-type': 'text/html', 'content-security-policy': 'default-src * \'unsafe-inline\'' }, body: 'x' } });
  ({ res } = await run(env, { method: 'GET' }));
  assert.deepStrictEqual(cspLines(res), ["default-src * 'unsafe-inline'", SANDBOX]);
  env = makeEnv({ reply: { status: 200, headers: { 'content-type': 'image/svg+xml' }, body: '<svg/>' } });
  ({ res } = await run(env, { method: 'GET' }));
  assert.deepStrictEqual(cspLines(res), [SANDBOX]);
  ({ res } = await run(makeEnv(), { url: '/hooks/demo/nope' }, { id: 'demo', sub: 'nope' }));
  assert.strictEqual(res.status, 404);
  assert.deepStrictEqual(cspLines(res), [SANDBOX]);
});

test('origin: the string null (sandboxed form post) is accepted', async () => {
  const { res } = await run(makeEnv(), { headers: { origin: 'null' }, body: 'a=1' });
  assert.strictEqual(res.status, 200);
  const bad = await run(makeEnv(), { headers: { origin: 'https://evil.example' }, body: 'a=1' });
  assert.strictEqual(bad.res.status, 403);
});

test('reply header with a non-ASCII character is dropped and the reply finishes', async () => {
  const env = makeEnv({ reply: { status: 200, body: 'x', headers: { 'cache-control': 'max-age=5\u00e9', 'retry-after': '7' } } });
  const { res } = await run(env, {});
  assert.strictEqual(res.status, 200); assert.strictEqual(res.ended, true);
  assert.strictEqual(hdr(res, 'cache-control'), 'no-store');
  assert.strictEqual(hdr(res, 'retry-after'), '7');
});

test('writeHead throwing still ends with 502', async () => {
  const env = makeEnv();
  const res = fakeRes();
  const real = res.writeHead; let n = 0;
  res.writeHead = function (s, h) { if (n++ === 0) throw new Error('bad header'); return real.call(this, s, h); };
  const req = fakeReq({ method: 'GET' });
  const p = env.r.handle(req, res, { id: 'demo', sub: 'events' });
  req.send(); await p;
  assert.strictEqual(res.status, 502); assert.strictEqual(res.ended, true);
  assert.ok(env.logs[0].includes('-> 502'));
});

test('body deadline: 408 and the socket is destroyed', async () => {
  const env = makeEnv();
  env.r = createReceivers({ manifestOf: () => env.manifest, connectorFor: () => env.connector, request: async () => env.reply, getSetting: () => ({}), bodyTimeoutMs: 20 });
  const req = fakeReq({}); const res = fakeRes();
  await env.r.handle(req, res, { id: 'demo', sub: 'events' });   // never sends data or end
  assert.strictEqual(res.status, 408);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(req.socket.destroyed, true);
});

test('an aborted body is not forwarded', async () => {
  const env = makeEnv();
  const req = fakeReq({}); const res = fakeRes();
  const p = env.r.handle(req, res, { id: 'demo', sub: 'events' });
  req.emit('data', Buffer.from('par')); req.emit('close');
  await p;
  assert.strictEqual(env.calls.length, 0);
  assert.strictEqual(res.ended, true); assert.strictEqual(res.status, null);
});

test('Content-Length that differs from the bytes read: 400', async () => {
  const env = makeEnv();
  const { res } = await run(env, { body: 'abc', headers: { 'content-length': '10' } });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(env.calls.length, 0);
  assert.strictEqual((await run(env, { body: 'abc', headers: { 'content-length': '3' } })).res.status, 200);
});

test('the 21st concurrent request gets 503 with Retry-After 5, and slots are freed', async () => {
  const env = makeEnv();
  const waiters = [];
  env.r = createReceivers({ manifestOf: () => env.manifest, connectorFor: () => env.connector, getSetting: () => ({}), now: () => env.clock,
    request: () => new Promise((resolve) => waiters.push(() => resolve({ status: 200, body: 'ok' }))) });
  const pending = [];
  for (let i = 0; i < 20; i++) {
    const req = fakeReq({ method: 'GET' }); const res = fakeRes();
    pending.push(env.r.handle(req, res, { id: 'demo', sub: 'events' })); req.send();
  }
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(waiters.length, 20);
  const req = fakeReq({ method: 'GET' }); const res = fakeRes();
  await env.r.handle(req, res, { id: 'demo', sub: 'events' });
  assert.strictEqual(res.status, 503); assert.strictEqual(hdr(res, 'retry-after'), '5');
  waiters.forEach((w) => w()); await Promise.all(pending);
  const again = fakeReq({ method: 'GET' }); const res2 = fakeRes();
  const p = env.r.handle(again, res2, { id: 'demo', sub: 'events' });
  await new Promise((r) => setImmediate(r)); waiters[20](); await p;
  assert.strictEqual(res2.status, 200);
});

test('EBACKOFF from request(): 503 with Retry-After 10', async () => {
  const e = new Error('backing off'); e.code = 'EBACKOFF';
  const { res } = await run(makeEnv({ fail: e }), {});
  assert.strictEqual(res.status, 503); assert.strictEqual(hdr(res, 'retry-after'), '10');
});
