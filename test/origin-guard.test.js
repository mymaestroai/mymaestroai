'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { crossOriginRefusal } = require('../lib/origin-guard');

const TS = 'hub.example.ts.net';
const req = (method, headers) => ({ method, headers });
const env = {};

test('own UI over the tailnet and on localhost is allowed', () => {
  assert.equal(crossOriginRefusal(req('POST', { host: TS, origin: `https://${TS}`, 'sec-fetch-site': 'same-origin' }), '/api/chat', env), null);
  assert.equal(crossOriginRefusal(req('GET', { host: TS, 'sec-fetch-site': 'same-origin' }), '/api/agents', env), null);
  assert.equal(crossOriginRefusal(req('POST', { host: '127.0.0.1:9999', origin: 'http://127.0.0.1:9999' }), '/api/chat', env), null);
  assert.equal(crossOriginRefusal(req('POST', { host: 'localhost:9999', origin: 'http://localhost:9999' }), '/v1/chat/completions', env), null);
});

test('non-browser callers (curl, agents, bots) are allowed', () => {
  assert.equal(crossOriginRefusal(req('POST', { host: '127.0.0.1:9999' }), '/api/chat/alert', env), null);
  assert.equal(crossOriginRefusal(req('POST', { host: 'anything' }), '/api/codex-bridge/rpc', env), null);
});

test('another website is refused on API routes', () => {
  assert.ok(crossOriginRefusal(req('POST', { host: TS, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }), '/api/chat', env));
  assert.ok(crossOriginRefusal(req('POST', { host: TS, origin: 'https://evil.example' }), '/api/chat', env));
  assert.ok(crossOriginRefusal(req('GET', { host: TS, origin: 'https://evil.example' }), '/api/agents', env));
  assert.ok(crossOriginRefusal(req('OPTIONS', { host: TS, origin: 'https://evil.example' }), '/api/chat', env));
  assert.ok(crossOriginRefusal(req('POST', { host: TS, origin: 'null' }), '/v1/chat/completions', env));
  assert.ok(crossOriginRefusal(req('GET', { host: TS, 'sec-fetch-site': 'cross-site' }), '/api/agents', env));
});

test('another port on the same machine counts as another site', () => {
  assert.ok(crossOriginRefusal(req('POST', { host: TS, origin: `https://${TS}:9777`, 'sec-fetch-site': 'same-site' }), '/api/chat', env));
  assert.ok(crossOriginRefusal(req('POST', { host: '127.0.0.1:9999', origin: 'http://127.0.0.1:9777' }), '/api/chat', env));
});

test('DNS rebinding: a matching Origin on an unknown Host is refused', () => {
  assert.ok(crossOriginRefusal(req('POST', { host: 'evil.example:9999', origin: 'http://evil.example:9999' }), '/api/chat', env));
  assert.equal(crossOriginRefusal(req('POST', { host: 'hub.lan:9999', origin: 'http://hub.lan:9999' }), '/api/chat', { HUB_ALLOWED_HOSTS: 'hub.lan:9999' }), null);
});

test('page navigations from links stay allowed; cross-site non-GET is refused anywhere', () => {
  assert.equal(crossOriginRefusal(req('GET', { host: TS, 'sec-fetch-site': 'cross-site' }), '/', env), null);
  assert.equal(crossOriginRefusal(req('GET', { host: TS, 'sec-fetch-site': 'none' }), '/setup', env), null);
  assert.ok(crossOriginRefusal(req('POST', { host: TS, origin: 'https://evil.example' }), '/setup', env));
});

test('server.js sends no wildcard CORS and runs the guard before any route', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(!/Access-Control-Allow-Origin', '\*'/.test(src), 'wildcard CORS header is back');
  const guard = src.indexOf('crossOriginRefusal(req, pathname)');
  assert.ok(guard > 0, 'guard not called');
  assert.ok(guard < src.indexOf("pathname === '/api/codex-bridge/rpc'"), 'guard must run before the first route');
});
