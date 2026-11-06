'use strict';
const test = require('node:test');
const assert = require('node:assert');
const od = require('../lib/oauth-device');

const HIDDEN_VALUE = 'hidden-value-distinctive-xyzzy';
const DEVICE = 'DEVCODE-distinctive-123';
const REFRESH = 'REFRESH-distinctive-456';
const NOW = 1_700_000_000_000;
const now = () => NOW;

function stub(body, { status = 200, calls } = {}) {
  return async (url, opts) => {
    if (calls) calls.push({ url, opts });
    return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
}
const startArgs = (fetch, extra = {}) => ({ deviceUrl: 'https://oauth2.example/device/code', clientId: 'cid', scopes: ['a', 'b'], fetch, now, ...extra });
const tokArgs = (fetch, extra = {}) => ({ tokenUrl: 'https://oauth2.example/token', clientId: 'cid', clientSecret: HIDDEN_VALUE, deviceCode: DEVICE, refreshToken: REFRESH, fetch, now, ...extra });
const rejectsCode = (p, code) => assert.rejects(p, (e) => { assert.strictEqual(e.code, code); return true; });

test('start: Google field names', async () => {
  const calls = [];
  const r = await od.start(startArgs(stub({ device_code: 'd', user_code: 'ABCD-EFGH', verification_url: 'https://google.com/device', interval: 7, expires_in: 1800 }, { calls })));
  assert.deepStrictEqual(r, { deviceCode: 'd', userCode: 'ABCD-EFGH', verificationUrl: 'https://google.com/device', intervalSec: 7, expiresAt: NOW + 1800000 });
  assert.strictEqual(calls[0].opts.method, 'POST');
  assert.strictEqual(calls[0].opts.headers.Accept, 'application/json');
  const form = new URLSearchParams(calls[0].opts.body);
  assert.strictEqual(form.get('client_id'), 'cid');
  assert.strictEqual(form.get('scope'), 'a b');
});

test('start: RFC names and default interval', async () => {
  const r = await od.start(startArgs(stub({ device_code: 'd', user_code: 'WXYZ1234', verification_uri: 'https://example.com/activate', expires_in: 600 })));
  assert.strictEqual(r.verificationUrl, 'https://example.com/activate');
  assert.strictEqual(r.intervalSec, 5);
});

test('https enforced; local http only with allowInsecureLocal', async () => {
  const ok = stub({ device_code: 'd', user_code: 'ABCD', verification_url: 'https://x.example/d', expires_in: 600 });
  await rejectsCode(od.start(startArgs(ok, { deviceUrl: 'http://example.com/d' })), 'EBADURL');
  await rejectsCode(od.start(startArgs(ok, { deviceUrl: 'http://127.0.0.1:9/d' })), 'EBADURL');
  await od.start(startArgs(ok, { deviceUrl: 'http://127.0.0.1:9/d', allowInsecureLocal: true }));
  await od.start(startArgs(ok, { deviceUrl: 'http://localhost:9/d', allowInsecureLocal: true }));
  await rejectsCode(od.start(startArgs(ok, { deviceUrl: 'http://example.com/d', allowInsecureLocal: true })), 'EBADURL');
  await rejectsCode(od.start(startArgs(stub({ device_code: 'd', user_code: 'ABCD', verification_url: 'http://evil.example/d', expires_in: 600 }))), 'EBADRESPONSE');
  await rejectsCode(od.poll(tokArgs(ok, { tokenUrl: 'http://example.com/t' })), 'EBADURL');
});

test('start: bad interval, expires_in, userCode rejected', async () => {
  const base = { device_code: 'd', user_code: 'ABCD', verification_url: 'https://x.example/d', interval: 5, expires_in: 600 };
  for (const patch of [{ interval: 0 }, { interval: 61 }, { interval: 2.5 }, { interval: '5' }, { expires_in: 59 }, { expires_in: 3601 }, { expires_in: undefined }, { expires_in: '600' },
    { user_code: 'abc' }, { user_code: 'x'.repeat(33) }, { user_code: 'AB\nCD' }, { user_code: 'ÄBCD' }, { user_code: 1234 }, { device_code: undefined }]) {
    await rejectsCode(od.start(startArgs(stub({ ...base, ...patch }))), 'EBADRESPONSE');
  }
});

test('poll: pending, slow_down, denied, expired', async () => {
  for (const [err, status] of [['authorization_pending', 'pending'], ['slow_down', 'slow_down'], ['access_denied', 'denied'], ['expired_token', 'expired']]) {
    assert.deepStrictEqual(await od.poll(tokArgs(stub({ error: err }, { status: 400 }))), { status });
  }
});

test('poll: ok maps tokens and computes expiresAt', async () => {
  const calls = [];
  const r = await od.poll(tokArgs(stub({ access_token: 'at', refresh_token: 'rt', expires_in: 3599, scope: 'a b', token_type: 'Bearer' }, { calls })));
  assert.deepStrictEqual(r, { status: 'ok', tokens: { refreshToken: 'rt', accessToken: 'at', expiresAt: NOW + 3599000, scope: 'a b' } });
  const form = new URLSearchParams(calls[0].opts.body);
  assert.strictEqual(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
  assert.strictEqual(form.get('device_code'), DEVICE);
  assert.strictEqual(form.get('client_secret'), HIDDEN_VALUE);
});

test('poll: missing refresh_token', async () => {
  await assert.rejects(od.poll(tokArgs(stub({ access_token: 'at', expires_in: 3600 }))), (e) => {
    assert.strictEqual(e.code, 'ENOREFRESH');
    assert.strictEqual(e.message, "Google didn't return a lasting sign-in. Try again and approve the request.");
    return true;
  });
});

test('poll: invalid_client and other errors', async () => {
  await assert.rejects(od.poll(tokArgs(stub({ error: 'invalid_client' }, { status: 401 }))), (e) => {
    assert.strictEqual(e.code, 'EOAUTH');
    assert.match(e.message, /client ID or secret is wrong/);
    return true;
  });
  await assert.rejects(od.poll(tokArgs(stub({ error: 'invalid_scope' }, { status: 400 }))), (e) => {
    assert.strictEqual(e.code, 'EOAUTH');
    assert.match(e.message, /invalid_scope/);
    return true;
  });
});

test('timeout -> ETIMEDOUT', async () => {
  const hang = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  await rejectsCode(od.poll(tokArgs(hang, { timeoutMs: 20 })), 'ETIMEDOUT');
  await rejectsCode(od.start(startArgs(hang, { timeoutMs: 20 })), 'ETIMEDOUT');
});

test('refresh: ok, rotated token, invalid_grant', async () => {
  const a = await od.refresh(tokArgs(stub({ access_token: 'at2', expires_in: 3000 })));
  assert.deepStrictEqual(a, { accessToken: 'at2', expiresAt: NOW + 3000000 });
  assert.ok(!('refreshToken' in a));
  const b = await od.refresh(tokArgs(stub({ access_token: 'at3', expires_in: 3000, refresh_token: 'rt2' })));
  assert.strictEqual(b.refreshToken, 'rt2');
  await assert.rejects(od.refresh(tokArgs(stub({ error: 'invalid_grant' }, { status: 400 }))), (e) => {
    assert.strictEqual(e.code, 'EREVOKED');
    assert.strictEqual(e.message, 'The sign-in was revoked or has expired. Sign in again.');
    return true;
  });
});

test('oversize and non-JSON bodies -> EBADRESPONSE', async () => {
  await rejectsCode(od.poll(tokArgs(stub('x'.repeat(64 * 1024 + 1)))), 'EBADRESPONSE');
  await rejectsCode(od.poll(tokArgs(stub(JSON.stringify({ pad: 'x'.repeat(64 * 1024) })))), 'EBADRESPONSE');
  await rejectsCode(od.poll(tokArgs(stub('<html>nope</html>'))), 'EBADRESPONSE');
  await rejectsCode(od.refresh(tokArgs(stub('[]'))), 'EBADRESPONSE');
});

test('secrets never appear in error messages', async () => {
  const cases = [
    () => od.poll(tokArgs(stub({ error: 'invalid_client' }))),
    () => od.poll(tokArgs(stub({ error: 'weird_error' }))),
    () => od.poll(tokArgs(stub({ access_token: 'at' }))),
    () => od.poll(tokArgs(stub('garbage'))),
    () => od.poll(tokArgs(stub('x'.repeat(70000)))),
    () => od.poll(tokArgs(stub({}), { tokenUrl: 'http://example.com/t' })),
    () => od.poll(tokArgs(async () => { throw new Error(`network ${HIDDEN_VALUE} ${DEVICE}`); })),
    () => od.refresh(tokArgs(stub({ error: 'invalid_grant' }))),
    () => od.refresh(tokArgs(stub({ error: 'invalid_request' }))),
  ];
  for (const c of cases) {
    await assert.rejects(c(), (e) => {
      for (const s of [HIDDEN_VALUE, DEVICE, REFRESH]) assert.ok(!e.message.includes(s), e.message);
      return true;
    });
  }
});

test('fetch is told never to follow a redirect; a redirect failure is EREDIRECT', async () => {
  let seen = null;
  await od.poll({ tokenUrl: 'https://x.example/t', clientId: 'c', clientSecret: 's', deviceCode: 'd', fetch: async (u, o) => { seen = o; return { status: 200, text: async () => JSON.stringify({ error: 'authorization_pending' }) }; } });
  assert.equal(seen.redirect, 'error');
  await assert.rejects(() => od.poll({ tokenUrl: 'https://x.example/t', clientId: 'c', clientSecret: 's', deviceCode: 'd', fetch: async () => { throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') }); } }),
    (e) => e.code === 'EREDIRECT' && e.message === 'The sign-in service tried to redirect the request, so it was stopped.');
});

test('a streamed oversize body is cut off', async () => {
  let cancelled = false, reads = 0;
  const body = { getReader: () => ({
    read: async () => { reads++; return { done: false, value: new Uint8Array(20 * 1024) }; },
    cancel: async () => { cancelled = true; },
  }) };
  await assert.rejects(() => od.poll({ tokenUrl: 'https://x.example/t', clientId: 'c', clientSecret: 's', deviceCode: 'd', fetch: async () => ({ status: 200, body }) }),
    (e) => e.code === 'EBADRESPONSE' && /too large/.test(e.message));
  assert.equal(cancelled, true);
  assert.ok(reads <= 4, 'stopped reading soon after the limit');
});

test('an unknown error code is not echoed; known ones are', async () => {
  const mk = (error) => ({ tokenUrl: 'https://x.example/t', clientId: 'c', clientSecret: 's', deviceCode: 'd', fetch: async () => ({ status: 400, text: async () => JSON.stringify({ error }) }) });
  await assert.rejects(() => od.poll(mk('please_visit_evil.example')), (e) => e.code === 'EOAUTH' && e.message === 'The sign-in was refused by the service.');
  await assert.rejects(() => od.poll(mk('invalid_scope')), (e) => /invalid_scope/.test(e.message));
});
