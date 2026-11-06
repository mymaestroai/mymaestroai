'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const oc = require('../lib/oauth-code');

const SECRET = 'client-secret-distinctive-xyzzy';
const CODE = 'AUTHCODE-distinctive-123';
const VERIFIER = 'verifier-distinctive-789';
const REFRESH = 'REFRESH-distinctive-456';
const NOW = 1_700_000_000_000;
const now = () => NOW;

function stub(body, { status = 200, calls } = {}) {
  return async (url, opts) => {
    if (calls) calls.push({ url, opts });
    return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
}
const exArgs = (fetch, extra = {}) => ({ tokenUrl: 'https://auth.example/token', clientId: 'cid', clientSecret: SECRET, code: CODE, redirectUri: 'https://hub.example/oauth/callback/fake', codeVerifier: VERIFIER, fetch, now, ...extra });
const reArgs = (fetch, extra = {}) => ({ tokenUrl: 'https://auth.example/token', clientId: 'cid', clientSecret: SECRET, refreshToken: REFRESH, fetch, now, ...extra });
const rejectsCode = (p, code) => assert.rejects(p, (e) => { assert.strictEqual(e.code, code); return true; });

test('authorizeUrl: code flow parameters, with and without a PKCE challenge', () => {
  const u = new URL(oc.authorizeUrl({ authorizeUrl: 'https://auth.example/authorize?x=1', clientId: 'cid', redirectUri: 'https://hub.example/oauth/callback/fake', scopes: ['a', 'b'], state: 'st', codeChallenge: 'chal' }));
  assert.strictEqual(u.origin + u.pathname, 'https://auth.example/authorize');
  assert.strictEqual(u.searchParams.get('x'), '1');
  assert.strictEqual(u.searchParams.get('response_type'), 'code');
  assert.strictEqual(u.searchParams.get('client_id'), 'cid');
  assert.strictEqual(u.searchParams.get('redirect_uri'), 'https://hub.example/oauth/callback/fake');
  assert.strictEqual(u.searchParams.get('scope'), 'a b');
  assert.strictEqual(u.searchParams.get('state'), 'st');
  assert.strictEqual(u.searchParams.get('code_challenge'), 'chal');
  assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
  const n = new URL(oc.authorizeUrl({ authorizeUrl: 'https://auth.example/authorize', clientId: 'cid', redirectUri: 'https://h/x', scopes: ['a'], state: 's' }));
  assert.strictEqual(n.searchParams.get('code_challenge'), null);
  assert.strictEqual(n.searchParams.get('code_challenge_method'), null);
  assert.throws(() => oc.authorizeUrl({ authorizeUrl: 'http://auth.example/authorize', clientId: 'c', redirectUri: 'x', scopes: [], state: 's' }), { code: 'EBADURL' });
});

test('pkce: an unreserved 43-128 character verifier and the base64url sha256 challenge; fresh each time', () => {
  const a = oc.pkce(), b = oc.pkce();
  assert.match(a.verifier, /^[A-Za-z0-9._~-]{43,128}$/);
  assert.strictEqual(a.challenge, crypto.createHash('sha256').update(a.verifier).digest('base64url'));
  assert.match(a.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.notStrictEqual(a.verifier, b.verifier);
});

test('exchange: form fields, User-Agent, no redirects, tokens parsed', async () => {
  const calls = [];
  const r = await oc.exchange(exArgs(stub({ access_token: 'acc', refresh_token: 'ref', expires_in: 600 }, { calls })));
  assert.deepStrictEqual(r, { accessToken: 'acc', refreshToken: 'ref', expiresAt: NOW + 600000 });
  const { opts } = calls[0];
  assert.strictEqual(opts.method, 'POST');
  assert.strictEqual(opts.redirect, 'error');
  assert.strictEqual(opts.headers['User-Agent'], 'MyMaestroAI');
  const f = new URLSearchParams(opts.body);
  assert.strictEqual(f.get('grant_type'), 'authorization_code');
  assert.strictEqual(f.get('code'), CODE);
  assert.strictEqual(f.get('redirect_uri'), 'https://hub.example/oauth/callback/fake');
  assert.strictEqual(f.get('code_verifier'), VERIFIER);
  assert.strictEqual(f.get('client_secret'), SECRET);
  const noPkce = [];
  await oc.exchange(exArgs(stub({ access_token: 'a' }, { calls: noPkce }), { codeVerifier: null }));
  assert.strictEqual(new URLSearchParams(noPkce[0].opts.body).has('code_verifier'), false);
});

test('refresh: a rotated refresh token is returned when sent, left out when not', async () => {
  const calls = [];
  const r = await oc.refresh(reArgs(stub({ access_token: 'acc2', refresh_token: 'ROTATED-1', expires_in: 100 }, { calls })));
  assert.deepStrictEqual(r, { accessToken: 'acc2', refreshToken: 'ROTATED-1', expiresAt: NOW + 100000 });
  const f = new URLSearchParams(calls[0].opts.body);
  assert.strictEqual(f.get('grant_type'), 'refresh_token');
  assert.strictEqual(f.get('refresh_token'), REFRESH);
  const same = await oc.refresh(reArgs(stub({ access_token: 'acc3' })));
  assert.strictEqual('refreshToken' in same, false);
  assert.strictEqual(same.expiresAt, NOW + 3600000);
});

test('invalid_grant is EREVOKED; other known codes are echoed, unknown text is not', async () => {
  await rejectsCode(oc.refresh(reArgs(stub({ error: 'invalid_grant' }, { status: 400 }))), 'EREVOKED');
  await rejectsCode(oc.exchange(exArgs(stub({ error: 'invalid_grant' }, { status: 400 }))), 'EREVOKED');
  await assert.rejects(oc.exchange(exArgs(stub({ error: 'invalid_client' }))), /invalid_client/);
  await assert.rejects(oc.exchange(exArgs(stub({ error: 'access_denied' }))), /access_denied/);
  await assert.rejects(oc.exchange(exArgs(stub({ error: `leak ${SECRET} ${CODE}`, error_description: SECRET }))), (e) => {
    assert.strictEqual(e.code, 'EOAUTH');
    assert.ok(!e.message.includes(SECRET) && !e.message.includes(CODE));
    return true;
  });
});

test('https only (http local allowed for tests), redirects refused, caps and time limit', async () => {
  await rejectsCode(oc.exchange(exArgs(stub({}), { tokenUrl: 'http://auth.example/token' })), 'EBADURL');
  await rejectsCode(oc.exchange(exArgs(stub({}), { tokenUrl: 'http://evil.example/token', allowInsecureLocal: true })), 'EBADURL');
  const ok = await oc.exchange(exArgs(stub({ access_token: 'a' }), { tokenUrl: 'http://127.0.0.1:9/token', allowInsecureLocal: true }));
  assert.strictEqual(ok.accessToken, 'a');
  const redirecting = async () => { const e = new TypeError('fetch failed'); e.cause = new Error('unexpected redirect'); throw e; };
  await rejectsCode(oc.exchange(exArgs(redirecting)), 'EREDIRECT');
  await rejectsCode(oc.exchange(exArgs(async () => { throw new Error(`boom ${SECRET}`); })), 'ENETWORK');
  await rejectsCode(oc.exchange(exArgs(stub('x'.repeat(oc.MAX_BODY + 1)))), 'EBADRESPONSE');
  await rejectsCode(oc.exchange(exArgs(stub('not json'))), 'EBADRESPONSE');
  await rejectsCode(oc.exchange(exArgs(stub({ expires_in: 5 }))), 'EBADRESPONSE');
  // a streamed reply is cut off at the cap
  let cancelled = false;
  const chunk = new Uint8Array(40 * 1024);
  const streaming = async () => ({ status: 200, body: { getReader: () => ({ read: async () => ({ done: false, value: chunk }), cancel: async () => { cancelled = true; } }) } });
  await rejectsCode(oc.exchange(exArgs(streaming)), 'EBADRESPONSE');
  assert.ok(cancelled);
  const hang = (url, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }));
  await rejectsCode(oc.exchange(exArgs(hang, { timeoutMs: 20 })), 'ETIMEDOUT');
});

test('no message ever carries a token, code, verifier or secret', async () => {
  const bad = [stub({ error: 'invalid_request', error_description: SECRET }), stub('oops ' + SECRET), async () => { throw new Error(SECRET + CODE + VERIFIER); }, stub({ access_token: '' })];
  for (const f of bad) {
    for (const call of [() => oc.exchange(exArgs(f)), () => oc.refresh(reArgs(f))]) {
      await assert.rejects(call(), (e) => { for (const s of [SECRET, CODE, VERIFIER, REFRESH]) assert.ok(!String(e.message).includes(s)); return true; });
    }
  }
});
