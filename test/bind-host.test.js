'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { resolveBindHost, isLoopbackHost, isSameOriginStreamRequest } = require('../lib/bind-host');

const AUTH = { HUB_AUTH_USERNAME: 'admin', HUB_AUTH_PASSWORD: 'secret' };

describe('bind host', () => {
  it('defaults to loopback with no configuration', () => {
    assert.deepStrictEqual(resolveBindHost({}), { host: '127.0.0.1', exposed: false, warning: null });
  });

  it('stays on loopback even when auth is configured but no bind host is requested', () => {
    assert.strictEqual(resolveBindHost({ ...AUTH }).host, '127.0.0.1');
  });

  it('normalises loopback spellings', () => {
    assert.strictEqual(resolveBindHost({ HUB_BIND_HOST: 'localhost' }).host, '127.0.0.1');
    assert.strictEqual(resolveBindHost({ HUB_BIND_HOST: '127.0.0.1' }).host, '127.0.0.1');
    assert.strictEqual(resolveBindHost({ HUB_BIND_HOST: '::1' }).host, '::1');
    assert.strictEqual(resolveBindHost({ HUB_BIND_HOST: '[::1]' }).host, '::1');
    assert.strictEqual(resolveBindHost({ HUB_BIND_HOST: ' LOCALHOST ' }).exposed, false);
  });

  it('REFUSES network exposure without auth', () => {
    for (const h of ['0.0.0.0', '192.168.1.50', '::']) {
      const r = resolveBindHost({ HUB_BIND_HOST: h });
      assert.strictEqual(r.host, '127.0.0.1', `${h} must fall back to loopback`);
      assert.strictEqual(r.exposed, false);
      assert.match(r.warning, /IGNORED/);
    }
  });

  it('refuses exposure when auth is only half configured', () => {
    assert.strictEqual(resolveBindHost({ HUB_BIND_HOST: '0.0.0.0', HUB_AUTH_USERNAME: 'admin' }).host, '127.0.0.1');
    assert.strictEqual(resolveBindHost({ HUB_BIND_HOST: '0.0.0.0', HUB_AUTH_PASSWORD: 'x' }).host, '127.0.0.1');
    assert.strictEqual(resolveBindHost({ HUB_BIND_HOST: '0.0.0.0', HUB_AUTH_USERNAME: '  ', HUB_AUTH_PASSWORD: 'x' }).host, '127.0.0.1');
  });

  it('allows explicit exposure only with full auth, and says so', () => {
    const r = resolveBindHost({ HUB_BIND_HOST: '0.0.0.0', ...AUTH });
    assert.strictEqual(r.host, '0.0.0.0');
    assert.strictEqual(r.exposed, true);
    assert.match(r.warning, /reachable from the network/);
  });

  it('classifies loopback hosts', () => {
    for (const h of ['127.0.0.1', '127.5.5.5', 'localhost', '::1']) assert.ok(isLoopbackHost(h), h);
    for (const h of ['0.0.0.0', '192.168.1.1', '10.0.0.1', '', null, '1270.0.0.1']) assert.ok(!isLoopbackHost(h), String(h));
  });
});

describe('stream same-origin guard', () => {
  const TS = 'mac.tail1234.ts.net';
  const req = (host, origin, peer = '127.0.0.1', site) => ({
    socket: { remoteAddress: peer },
    headers: { host, ...(origin ? { origin } : {}), ...(site ? { 'sec-fetch-site': site } : {}) },
  });
  it('allows the loopback origin', () => {
    assert.ok(isSameOriginStreamRequest(req('127.0.0.1:8888', 'http://127.0.0.1:8888'), 8888, {}));
    assert.ok(isSameOriginStreamRequest(req('localhost:8888'), 8888, {}));
  });
  it('rejects a non-loopback peer or cross-site fetch', () => {
    assert.ok(!isSameOriginStreamRequest(req('127.0.0.1:8888', null, '100.64.0.2'), 8888, {}));
    assert.ok(!isSameOriginStreamRequest(req('127.0.0.1:8888', null, '127.0.0.1', 'cross-site'), 8888, {}));
  });
  it('accepts the Tailscale Serve name without HUB_ALLOWED_HOSTS (phones and other computers on the tailnet)', () => {
    assert.ok(isSameOriginStreamRequest(req(TS, `https://${TS}`), 8888, {}));
    assert.ok(isSameOriginStreamRequest(req(TS.toUpperCase(), `https://${TS.toUpperCase()}`), 8888, {}));
    assert.ok(isSameOriginStreamRequest(req(TS), 8888, {}));
    assert.ok(!isSameOriginStreamRequest(req(TS, `https://${TS}`, '100.64.0.2'), 8888, {}), 'only through Serve (loopback peer)');
  });
  it('rejects any other proxied host unless listed in HUB_ALLOWED_HOSTS', () => {
    assert.ok(!isSameOriginStreamRequest(req('hub.example.com', 'https://hub.example.com'), 8888, {}));
    assert.ok(!isSameOriginStreamRequest(req('ts.net', 'https://ts.net'), 8888, {}));
    assert.ok(!isSameOriginStreamRequest(req('box.ts.net.evil.example', 'https://box.ts.net.evil.example'), 8888, {}));
    assert.ok(isSameOriginStreamRequest(req('hub.example.com', 'https://hub.example.com'), 8888, { HUB_ALLOWED_HOSTS: 'other.example, hub.example.com' }));
  });
  it('requires the origin to match an allowed host over https', () => {
    const env = { HUB_ALLOWED_HOSTS: 'hub.example.com' };
    assert.ok(!isSameOriginStreamRequest(req(TS, `http://${TS}`), 8888, env));
    assert.ok(!isSameOriginStreamRequest(req(TS, 'https://evil.example'), 8888, env));
    assert.ok(!isSameOriginStreamRequest(req('hub.example.com', 'http://hub.example.com'), 8888, env));
    assert.ok(!isSameOriginStreamRequest(req('evil.example', 'https://evil.example'), 8888, env));
  });
});

describe('isTailnetUserAllowed', () => {
  const { isTailnetUserAllowed } = require('../lib/bind-host');
  const req = (host, login, peer = '127.0.0.1') => ({ socket: { remoteAddress: peer }, headers: Object.assign({ host }, login ? { 'tailscale-user-login': login } : {}) });
  const env = { HUB_TAILNET_USERS: 'tester@example.com' };
  it('allows everything when unset', () => { assert.ok(isTailnetUserAllowed(req('box.ts.net'), 8888, {})); });
  it('always allows loopback', () => { assert.ok(isTailnetUserAllowed(req('127.0.0.1:8888'), 8888, env)); assert.ok(isTailnetUserAllowed(req('localhost:8888'), 8888, env)); });
  it('allows a listed tailnet login', () => { assert.ok(isTailnetUserAllowed(req('box.ts.net', 'Tester@Example.com'), 8888, env)); });
  it('rejects off-box peers even with forged loopback Host or a listed login', () => {
    assert.ok(!isTailnetUserAllowed(req('127.0.0.1:8888', null, '192.168.1.50'), 8888, env));
    assert.ok(!isTailnetUserAllowed(req('box.ts.net', 'tester@example.com', '192.168.1.50'), 8888, env));
  });
  it('rejects unlisted or missing logins', () => { assert.ok(!isTailnetUserAllowed(req('box.ts.net', 'mallory@example.com'), 8888, env)); assert.ok(!isTailnetUserAllowed(req('box.ts.net'), 8888, env)); });
});
