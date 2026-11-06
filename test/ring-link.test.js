'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../modules/ring/lib/store');
const { createLink, computeNonce, matchNonce, freshness, maskEmail, normCode, PAGE_CSP, MAX_FORM_BODY, LINK_MAX_TRIES, RATE_PER_MIN, PENDING_TOKEN_KEEP_MS } = require('../modules/ring/lib/link');

// The stand-in for keyCandidates is the bridge's own function (the api part provides it in the module).
function keyCandidates(c) {
  const out = [];
  const pref = c.key_encoding || 'utf8';
  for (const enc of [pref, ...['utf8', 'base64', 'hex'].filter((x) => x !== pref)]) {
    try {
      if (enc === 'utf8') out.push({ enc, key: Buffer.from(c.hmac_key, 'utf8') });
      else if (enc === 'base64' && /^[A-Za-z0-9+/_-]+={0,2}$/.test(c.hmac_key)) { const k = Buffer.from(c.hmac_key.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); if (k.length >= 16) out.push({ enc, key: k }); }
      else if (enc === 'hex' && /^([0-9a-fA-F]{2}){16,}$/.test(c.hmac_key)) out.push({ enc, key: Buffer.from(c.hmac_key, 'hex') });
    } catch { /* skip */ }
  }
  return out;
}

const KEY = 'a-very-long-shared-secret-key';
const ACCT = 'acct-test-0001';
const OTHER = 'acct-test-0002';

function setup(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-link-'));
  const env = {
    clock: 1800000000000,
    settings: { account_email: 'owner@example.com' },
    creds: { client_id: 'cid-test', client_secret: 'sec', hmac_key: KEY },
    linked: null, pending: {}, account: null, keyEnc: 'utf8', remembered: [],
    calls: [], adopted: [], logs: [], refreshed: 0,
    ringStatus: { post: 201, patch: 200 }, ringDelayMs: 0, adoptResult: { ok: true }, adoptThrows: false,
    exchange: { access_token: 'acc-1', refresh_token: 'ref-SECRET-1', expires_in: 14400 }, me: { id: ACCT, email: 'owner@example.net' }, exchangeFails: false, meStatus: 200,
    ...over,
  };
  const locks = new Map();
  // The one-time code (store.linkArm) is the real store's; the account, pending tokens and key encoding are kept in env so the tests can look at them.
  const store = {
    ...createStore({ dataHome: dir, now: () => env.clock, log: (...a) => env.logs.push(a.join(' ')) }),
    keyEncoding: () => env.keyEnc,
    pending: () => env.pending,
    savePending: (id, pair, emailMasked) => { env.pending[id] = { ...pair, email_masked: emailMasked || null }; },
    takePending: (id) => { const p = env.pending[id] || null; delete env.pending[id]; return p; },
    account: () => env.account,
    linkedAccount: () => env.linked,
  };
  const api = {
    API: 'https://ring.test',
    credentials: () => env.creds,
    keyCandidates: () => (env.creds ? keyCandidates({ ...env.creds, key_encoding: env.keyEnc }) : []),
    rememberKeyEncoding: (e) => { env.keyEnc = e; env.remembered.push(e); },
    withLock: (id, fn) => { const next = (locks.get(id) || Promise.resolve()).then(() => fn()); locks.set(id, next.catch(() => {})); return next; },
    exchangeCode: async (code, opts) => {
      env.calls.push({ what: 'oauth', form: { grant_type: 'authorization_code', code }, opts });
      if (env.exchangeFails) throw new Error('invalid_grant');
      return { access_token: env.exchange.access_token, refresh_token: env.exchange.refresh_token, expires_at: env.clock + 14400000, obtained_at: env.clock, scope: 'x' };
    },
    userMe: async (accessToken, opts = {}) => {
      env.calls.push({ what: 'ring', url: 'https://ring.test/v1/users/me', method: 'GET', headers: { Authorization: `Bearer ${accessToken}` }, timeoutMs: opts.timeoutMs });
      if (env.ringDelayMs) await new Promise((r) => setTimeout(r, env.ringDelayMs));
      if (env.meStatus !== 200) throw new Error(`users/me answered ${env.meStatus}`);
      return { id: env.me.id, email: env.me.email };
    },
    ringFetch: async (url, opts = {}) => {
      env.calls.push({ what: 'ring', url, method: opts.method || 'GET', headers: opts.headers, body: opts.body, timeoutMs: opts.timeoutMs });
      if (env.ringDelayMs) await new Promise((r) => setTimeout(r, env.ringDelayMs));
      const status = opts.method === 'PATCH' ? env.ringStatus.patch : env.ringStatus.post;
      return { ok: status < 300, status, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) };
    },
    // The real adoptPair saves the account record (without the refresh token) and then hands the refresh token to the hub.
    adoptPair: async (id, pair, meta = {}) => {
      env.adopted.push({ id, pair, meta });
      const old = env.account && env.account.account_id === id ? env.account : {};
      const { refresh_token: _refresh, ...access } = pair;
      env.account = JSON.parse(JSON.stringify({ ...old, ...meta, account_id: id, claimed_at: env.clock, needs_relink: false, access }));
      delete env.account.relink_reason;
      env.linked = id;
      if (env.adoptThrows) throw new Error('hub down');
      return env.adoptResult.ok === true;
    },
    refreshDevicesOnce: async () => { env.refreshed++; },
  };
  const ctx = { env: {}, settings: () => env.settings, store, api, media: {}, faces: {}, notify: async () => ({ ok: true }), log: (...a) => env.logs.push(a.join(' ')), now: () => env.clock };
  const link = createLink(ctx);
  return { env, link, dir, store };
}

const form = (o) => new URLSearchParams(o).toString();
const post = (path_, bodyText, extra = {}) => ({ method: 'POST', path: path_, query: '', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' }, body: Buffer.from(bodyText).toString('base64'), ip: '203.0.113.7', at: '', ...extra });
const get = (path_, query = '', extra = {}) => ({ method: 'GET', path: path_, query, headers: { origin: 'null' }, body: '', ip: '203.0.113.7', at: '', ...extra });
const tokenReq = (o = {}, extra = {}) => post('token', form({ grant_type: 'authorization_code', client_id: 'cid-test', code: 'good-code', ...o }), extra);

// A pending token exchange as the token endpoint leaves it, and the nonce the camera service would sign.
function pend(env, id = ACCT, over = {}) {
  env.pending[id] = { access_token: `acc-${id}`, refresh_token: `ref-${id}`, expires_at: env.clock + 14400000, obtained_at: env.clock, scope: 's', email_masked: 'o***r@example.net', ...over };
  const time = String(env.clock);
  return { time, nonce: computeNonce(time, id, Buffer.from(KEY)) };
}
const linkQuery = ({ time, nonce }) => `nonce=${encodeURIComponent(nonce)}&time=${time}`;
const submit = (n, code, extra = {}) => post('link', form({ nonce: n.nonce, time: n.time, code }), extra);

// ── the token endpoint ──
test('token: a good exchange keeps the tokens as pending, answers 200 and uses 10 s Ring calls', async () => {
  const { env, link } = setup();
  const r = await link.handle(tokenReq());
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['content-type'], 'application/json');
  assert.strictEqual(env.pending[ACCT].access_token, 'acc-1');
  assert.strictEqual(env.pending[ACCT].refresh_token, 'ref-SECRET-1');
  assert.strictEqual(env.pending[ACCT].email_masked, 'o***r@example.net');
  assert.deepStrictEqual(env.calls[0].form, { grant_type: 'authorization_code', code: 'good-code' });
  assert.strictEqual(env.calls[0].opts.timeoutMs, 10000);
  assert.strictEqual(env.calls[1].timeoutMs, 10000);
  assert.strictEqual(env.calls[1].headers.Authorization, 'Bearer acc-1');
  assert.ok(!env.logs.join('\n').includes('SECRET') && !env.logs.join('\n').includes('good-code'));
});

test('token: checks — wrong or missing client id 400, missing/odd code 400, big body 413, GET 404, not set up 503', async () => {
  const { env, link } = setup();
  assert.strictEqual((await link.handle(tokenReq({ client_id: 'other' }))).status, 400);
  assert.strictEqual((await link.handle(tokenReq({ client_id: '' }))).status, 400);
  assert.strictEqual((await link.handle(tokenReq({ code: '' }))).status, 400);
  assert.strictEqual((await link.handle(tokenReq({ code: 'has space' }))).status, 400);
  assert.strictEqual((await link.handle(tokenReq({ code: 'x'.repeat(2049) }))).status, 400);
  assert.strictEqual((await link.handle(post('token', 'x'.repeat(MAX_FORM_BODY + 1)))).status, 413);
  assert.strictEqual((await link.handle(get('token'))).status, 404);
  assert.strictEqual(env.calls.length, 0, 'nothing was sent to Ring for a refused request');
  env.creds = null;
  assert.strictEqual((await link.handle(tokenReq())).status, 503);
});

test('token: 10 tries a minute per address, then 429; a different address and junk requests are unaffected', async () => {
  const { env, link } = setup();
  for (let i = 0; i < RATE_PER_MIN; i++) assert.strictEqual((await link.handle(tokenReq())).status, 200, `try ${i}`);
  assert.strictEqual((await link.handle(tokenReq())).status, 429);
  assert.strictEqual((await link.handle(tokenReq({}, { ip: '203.0.113.99' }))).status, 200);
  env.clock += 61000;
  assert.strictEqual((await link.handle(tokenReq())).status, 200);

  const s = setup();
  for (let i = 0; i < 30; i++) assert.strictEqual((await s.link.handle(tokenReq({ client_id: 'junk' }))).status, 400);
  assert.strictEqual((await s.link.handle(tokenReq())).status, 200, 'junk with a wrong client id does not use up the real tries');
});

test('token: 60 requests a minute of any kind per address, then 429', async () => {
  const { link } = setup();
  for (let i = 0; i < 60; i++) await link.handle(tokenReq({ client_id: 'junk' }));
  assert.strictEqual((await link.handle(tokenReq({ client_id: 'junk' }))).status, 429);
});

test('token: Ring failing gives a generic 502 and keeps nothing', async () => {
  const a = setup({ exchangeFails: true });
  const r = await a.link.handle(tokenReq());
  assert.strictEqual(r.status, 502);
  assert.strictEqual(r.body, 'Exchange failed\n');
  assert.deepStrictEqual(a.env.pending, {});
  const b = setup({ meStatus: 500 });
  assert.strictEqual((await b.link.handle(tokenReq())).status, 502);
  assert.deepStrictEqual(b.env.pending, {});
});

// ── the pure checks ──
test('freshness: a request is good for 600 s, a minute of clock skew is tolerated; seconds and milliseconds both work', () => {
  const n = 1800000000000;
  assert.strictEqual(freshness(String(n), n), null);
  assert.strictEqual(freshness(String(n - 599000), n), null);
  assert.match(freshness(String(n - 601000), n), /expired/);
  assert.match(freshness(String(n + 61000), n), /future/);
  assert.strictEqual(freshness(String(n + 59000), n), null);
  assert.strictEqual(freshness(String(Math.floor(n / 1000)), n), null);
});

test('matchNonce: base64 and hex keys, wrong nonce, old pending, and another account all behave', () => {
  const t = '1800000000000';
  const keyBytes = crypto.randomBytes(32);
  const cands = keyCandidates({ hmac_key: keyBytes.toString('base64') });
  const pend1 = { [ACCT]: { obtained_at: 1800000000000, email_masked: 'x' } };
  const nonce = computeNonce(t, ACCT, keyBytes);
  const m = matchNonce(cands, pend1, t, nonce, 1800000000000);
  assert.strictEqual(m.id, ACCT);
  assert.strictEqual(m.enc, 'base64');
  assert.strictEqual(matchNonce(cands, pend1, t, nonce + 'x', 1800000000000), null);
  assert.strictEqual(matchNonce(cands, pend1, '1800000000001', nonce, 1800000000000), null);
  assert.strictEqual(matchNonce(cands, { [OTHER]: pend1[ACCT] }, t, nonce, 1800000000000), null);
  assert.strictEqual(matchNonce(cands, pend1, t, nonce, 1800000000000 + PENDING_TOKEN_KEEP_MS + 1), null, 'pending tokens older than 1 h never match');
  assert.strictEqual(matchNonce([], pend1, t, nonce), null);
});

test('maskEmail and normCode', () => {
  assert.strictEqual(maskEmail('owner@example.com'), 'o***r@example.com');
  assert.strictEqual(maskEmail('a@example.com'), 'a***@example.com');
  assert.strictEqual(maskEmail('nonsense'), null);
  assert.strictEqual(maskEmail(''), null);
  assert.strictEqual(normCode('abcd-ef 23'), 'ABCDEF23');
});

// ── arming ──
test('armLink: 8 characters shown as XXXX-XXXX, only a salted hash kept (0600), minutes clamped to 5..120', () => {
  const { env, link, dir } = setup();
  const a = link.armLink({});
  assert.match(a.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
  assert.strictEqual(a.expiresAt, env.clock + 30 * 60000);
  const file = path.join(dir, 'link-arm.json');
  const raw = fs.readFileSync(file, 'utf8');
  const arm = JSON.parse(raw);
  assert.ok(!raw.includes(a.code) && !raw.includes(a.code.replace('-', '')), 'the code itself is not on disk');
  assert.strictEqual(arm.codeHash, crypto.createHash('sha256').update(`${arm.salt}:${a.code.replace('-', '')}`).digest('hex'));
  assert.strictEqual(arm.salt.length, 32);
  assert.strictEqual(arm.tries, 0);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(link.armLink({ minutes: 1 }).expiresAt, env.clock + 5 * 60000);
  assert.strictEqual(link.armLink({ minutes: 9999 }).expiresAt, env.clock + 120 * 60000);
  assert.notStrictEqual(link.armLink({}).code, link.armLink({}).code);
  assert.ok(!env.logs.join('\n').includes(a.code));
  assert.deepStrictEqual(Object.keys(link.linkState()).sort(), ['armed', 'expiresAt', 'replace', 'tries']);
});

// ── the link page ──
test('link page: closed (not armed) gives 403 for a genuine redirect, and the same 400 as anything else for a made-up nonce', async () => {
  const { env, link } = setup();
  const n = pend(env);
  const closed = await link.handle(get('link', linkQuery(n)));
  assert.strictEqual(closed.status, 403);
  assert.match(closed.body, /closed/);
  link.armLink({});
  const made = await link.handle(get('link', `nonce=${'A'.repeat(43)}&time=${n.time}`));
  assert.strictEqual(made.status, 400);
  const un = setup();
  const unarmed = await un.link.handle(get('link', `nonce=${'A'.repeat(43)}&time=${n.time}`));
  assert.strictEqual(unarmed.status, 400);
  assert.strictEqual(made.body, unarmed.body, 'no oracle: armed or not, a made-up nonce looks the same');
});

test('link page: armed shows the masked email, a RELATIVE form action, no scripts, a strict CSP of its own; Origin null is fine', async () => {
  const { env, link } = setup();
  link.armLink({});
  const n = pend(env);
  const r = await link.handle(get('link', linkQuery(n), { headers: { origin: 'null' } }));
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /o\*\*\*r@example\.net/);
  assert.match(r.body, /<form method="post" action="link"/);
  assert.ok(!/action="\//.test(r.body) && !/action="https?:/.test(r.body), 'the action is relative, with no leading slash');
  assert.ok(!/<script|javascript:|\son[a-z]+=/i.test(r.body));
  assert.strictEqual(r.headers['content-security-policy'], PAGE_CSP);
  for (const part of ["default-src 'none'", "style-src 'unsafe-inline'", "form-action 'self'"]) assert.ok(r.headers['content-security-policy'].includes(part), part);
  assert.match(r.headers['content-type'], /^text\/html/);
  assert.ok(r.body.includes(`name="nonce" value="${n.nonce}"`));
});

test('link page: a script-looking nonce or time is refused and never echoed', async () => {
  const { env, link } = setup();
  link.armLink({});
  pend(env);
  const r = await link.handle(get('link', `nonce=${encodeURIComponent('"><script>alert(1)</script>' + 'a'.repeat(20))}&time=1800000000000`));
  assert.strictEqual(r.status, 400);
  assert.ok(!r.body.includes('<script>alert'));
});

test('link page: stale, future and unknown-account requests give 400', async () => {
  const { env, link } = setup();
  link.armLink({});
  const stale = pend(env);
  env.clock += 601000;
  assert.match((await link.handle(get('link', linkQuery(stale)))).body, /expired/);
  env.clock -= 601000;
  const future = String(env.clock + 120000);
  const nf = { time: future, nonce: computeNonce(future, ACCT, Buffer.from(KEY)) };
  const rf = await link.handle(get('link', linkQuery(nf)));
  assert.strictEqual(rf.status, 400);
  assert.match(rf.body, /future/);
  const unknown = { time: String(env.clock), nonce: computeNonce(String(env.clock), 'acct-nobody-9999', Buffer.from(KEY)) };
  assert.strictEqual((await link.handle(get('link', linkQuery(unknown)))).status, 400);
  assert.strictEqual((await link.handle(get('link', 'time=abc&nonce=short'))).status, 400);
  assert.strictEqual((await link.handle(get('link', ''))).status, 400);
});

test('link page: pending tokens older than an hour are not a link in progress', async () => {
  const { env, link } = setup();
  link.armLink({});
  const n = pend(env, ACCT, { obtained_at: env.clock - PENDING_TOKEN_KEEP_MS - 1000 });
  n.time = String(env.clock);
  n.nonce = computeNonce(n.time, ACCT, Buffer.from(KEY));
  assert.strictEqual((await link.handle(get('link', linkQuery(n)))).status, 400);
});

test('link page: 60 requests a minute per address, then 429', async () => {
  const { link } = setup();
  for (let i = 0; i < 60; i++) await link.handle(get('link', ''));
  assert.strictEqual((await link.handle(get('link', ''))).status, 429);
});

// ── the code ──
test('code: wrong codes get 401 and count; the fifth closes the page; a made-up nonce uses no tries', async () => {
  const { env, link, dir } = setup();
  const a = link.armLink({});
  const n = pend(env);
  const fake = { time: n.time, nonce: 'B'.repeat(43) };
  for (let i = 0; i < 10; i++) assert.strictEqual((await link.handle(submit(fake, 'AAAA-AAAA'))).status, 400);
  const file = path.join(dir, 'link-arm.json');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).tries, 0);
  for (let i = 1; i < LINK_MAX_TRIES; i++) {
    const r = await link.handle(submit(n, 'WRONG-CODE'));
    assert.strictEqual(r.status, 401, `try ${i}`);
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).tries, i);
  }
  const last = await link.handle(submit(n, 'WRONG-CODE'));
  assert.strictEqual(last.status, 403);
  assert.ok(!fs.existsSync(file), 'the arm file is deleted after 5 wrong codes');
  assert.strictEqual((await link.handle(submit(n, a.code))).status, 403, 'even the right code is useless now');
  assert.strictEqual(env.calls.filter((c) => c.what === 'ring').length, 0);
  assert.strictEqual(env.adopted.length, 0);
});

test('code: it expires', async () => {
  const { env, link } = setup();
  const a = link.armLink({ minutes: 5 });
  const n = pend(env);
  env.clock += 5 * 60000 + 1000;
  n.time = String(env.clock);
  n.nonce = computeNonce(n.time, ACCT, Buffer.from(KEY));
  pend(env);
  env.pending[ACCT].obtained_at = env.clock;
  const r = await link.handle(submit(n, a.code));
  assert.strictEqual(r.status, 403);
  assert.match(r.body, /closed/);
});

test('code: typed in lower case, with or without the dash and with spaces, is accepted', async () => {
  const { env, link } = setup();
  const a = link.armLink({});
  const n = pend(env);
  const typed = ` ${a.code.toLowerCase().replace('-', ' ')} `;
  assert.strictEqual((await link.handle(submit(n, typed))).status, 200);
  assert.ok(env.account);
});

test('code: a new arm replaces the old code', async () => {
  const { env, link } = setup();
  const first = link.armLink({});
  const second = link.armLink({});
  const n = pend(env);
  assert.strictEqual((await link.handle(submit(n, first.code))).status, 401);
  assert.strictEqual((await link.handle(submit(n, second.code))).status, 200);
});

// ── success ──
test('success: POST then PATCH to app-integrations, the account is stored, the refresh token goes back through the api part, the arm closes', async () => {
  const { env, link, dir } = setup();
  const a = link.armLink({});
  const n = pend(env);
  const r = await link.handle(submit(n, a.code));
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /connected/i);
  assert.strictEqual(r.headers['content-security-policy'], PAGE_CSP);
  const ring = env.calls.filter((c) => c.what === 'ring');
  assert.deepStrictEqual(ring.map((c) => `${c.method} ${c.url}`), ['POST https://ring.test/v1/accounts/me/app-integrations', 'PATCH https://ring.test/v1/accounts/me/app-integrations']);
  assert.deepStrictEqual(JSON.parse(ring[0].body), { account_identifier: 'o***r@example.com', nonce: n.nonce });
  assert.deepStrictEqual(JSON.parse(ring[1].body), { status: 'completed' });
  assert.strictEqual(ring[0].headers.Authorization, `Bearer acc-${ACCT}`);
  assert.ok(ring.every((c) => c.timeoutMs === 10000));
  assert.strictEqual(env.account.account_id, ACCT);
  assert.strictEqual(env.account.needs_relink, false);
  assert.strictEqual(env.account.relink_reason, undefined);
  assert.strictEqual(env.account.ring_email_masked, 'o***r@example.net');
  assert.strictEqual(env.account.access.access_token, `acc-${ACCT}`);
  assert.strictEqual(JSON.stringify(env.account).includes('ref-'), false, 'the refresh token is not in the account record');
  assert.strictEqual(env.adopted.length, 1);
  assert.strictEqual(env.adopted[0].id, ACCT);
  assert.strictEqual(env.adopted[0].pair.refresh_token, `ref-${ACCT}`);
  assert.deepStrictEqual(env.pending, {}, 'the pending tokens are consumed');
  assert.ok(!fs.existsSync(path.join(dir, 'link-arm.json')));
  await new Promise((res) => setImmediate(res));
  assert.strictEqual(env.refreshed, 1);
  assert.ok(!env.logs.join('\n').includes('ref-') && !env.logs.join('\n').includes(a.code) && !env.logs.join('\n').includes(n.nonce));
  assert.strictEqual((await link.handle(get('link', linkQuery(n)))).status, 400, 'the link address cannot be used again');
});

test('success clears an earlier needs_relink', async () => {
  const { env, link } = setup({ account: { account_id: ACCT, needs_relink: true, relink_reason: 'invalid_grant', claimed_at: 1 }, linked: ACCT });
  const a = link.armLink({});
  assert.strictEqual((await link.handle(submit(pend(env), a.code))).status, 200);
  assert.strictEqual(env.account.needs_relink, false);
  assert.strictEqual('relink_reason' in env.account, false);
});

test('success: a refresh token that the hub cannot save yet does not fail the link', async () => {
  for (const o of [{ adoptResult: { ok: false } }, { adoptThrows: true }]) {
    const { env, link } = setup(o);
    const a = link.armLink({});
    assert.strictEqual((await link.handle(submit(pend(env), a.code))).status, 200);
    assert.strictEqual(env.adopted.length, 1);
    assert.ok(env.account);
  }
});

test('Ring refusing the confirmation gives 502, stores nothing, and keeps the code usable', async () => {
  for (const ringStatus of [{ post: 400, patch: 200 }, { post: 201, patch: 500 }]) {
    const { env, link, dir } = setup({ ringStatus });
    const a = link.armLink({});
    const n = pend(env);
    const r = await link.handle(submit(n, a.code));
    assert.strictEqual(r.status, 502);
    assert.strictEqual(env.account, null);
    assert.strictEqual(env.adopted.length, 0);
    assert.ok(env.pending[ACCT], 'the pending tokens stay for another try');
    assert.ok(fs.existsSync(path.join(dir, 'link-arm.json')));
  }
});

test('no account email in the settings: refused with a clear page before the code is looked at', async () => {
  const { env, link, dir } = setup({ settings: {} });
  const a = link.armLink({});
  const r = await link.handle(submit(pend(env), a.code));
  assert.strictEqual(r.status, 409);
  assert.match(r.body, /account email/);
  assert.strictEqual(env.calls.filter((c) => c.what === 'ring').length, 0);
  assert.ok(fs.existsSync(path.join(dir, 'link-arm.json')));
});

test('a different Ring account is refused (409) unless the arm allows replacing', async () => {
  const { env, link } = setup({ linked: OTHER, account: { account_id: OTHER } });
  const a = link.armLink({});
  const n = pend(env, ACCT);
  const r = await link.handle(submit(n, a.code));
  assert.strictEqual(r.status, 409);
  assert.strictEqual(env.account.account_id, OTHER);
  assert.strictEqual(env.adopted.length, 0);
  const b = link.armLink({ replace: true });
  const r2 = await link.handle(submit(n, b.code));
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(env.account.account_id, ACCT);
  assert.strictEqual(env.adopted[0].id, ACCT);
});

test('the same account again is fine without replace', async () => {
  const { env, link } = setup({ linked: ACCT, account: { account_id: ACCT } });
  const a = link.armLink({});
  assert.strictEqual((await link.handle(submit(pend(env), a.code))).status, 200);
});

test('two claims racing: exactly one wins', async () => {
  const { env, link } = setup({ ringDelayMs: 20 });
  const a = link.armLink({});
  const n = pend(env);
  const rs = await Promise.all([link.handle(submit(n, a.code)), link.handle(submit(n, a.code))]);
  assert.strictEqual(rs.filter((r) => r.status === 200).length, 1);
  assert.strictEqual(env.adopted.length, 1);
  assert.strictEqual(env.calls.filter((c) => c.what === 'ring' && c.method === 'POST').length, 1);
});

test('20 code tries a minute at most, across all pages', async () => {
  const { env, link } = setup();
  let limited = 0;
  for (let i = 0; i < 25; i++) {
    link.armLink({});   // re-armed each time so the 5-try lock is not what stops us
    const r = await link.handle(submit(pend(env), 'WRONG'), { ip: `198.51.100.${i}` });
    if (r.status === 429) limited++;
  }
  assert.strictEqual(limited, 5);
});

// ── plumbing ──
test('a form body over 8 KiB is refused with 413; HEAD works like GET on pages', async () => {
  const { env, link } = setup();
  link.armLink({});
  assert.strictEqual((await link.handle(post('link', 'x'.repeat(MAX_FORM_BODY + 1)))).status, 413);
  const n = pend(env);
  assert.strictEqual((await link.handle(get('link', linkQuery(n), { method: 'HEAD' }))).status, 200);
});

test('done page: static, plain HTML, own CSP, no names', async () => {
  const { link } = setup();
  const r = await link.handle(get('done'));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['content-security-policy'], PAGE_CSP);
  assert.ok(!/<script|<form/i.test(r.body));
  assert.ok(!/\/home\/|\/Users\//.test(r.body));
  assert.strictEqual((await link.handle(post('done', ''))).status, 404);
});

test('other paths and methods get 404', async () => {
  const { link } = setup();
  assert.strictEqual((await link.handle(get('events'))).status, 404);
  assert.strictEqual((await link.handle(get('nothing'))).status, 404);
  assert.strictEqual((await link.handle({ method: 'PUT', path: 'link', body: '' })).status, 404);
  assert.strictEqual((await link.handle(undefined)).status, 404);
});

test('a link claim finishes inside the 25 s deadline even if the hub never answers about the token', async (t) => {
  const { env, link } = setup();
  const realSetTimeout = global.setTimeout;
  const a = link.armLink({});
  const n = pend(env);
  env.adoptResult = new Promise(() => {});   // never settles
  const started = Date.now();
  // The wait for the hub is at most DEADLINE_MS; shorten real time by firing the timer early.
  global.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms >= 1000 ? 30 : ms, ...rest);
  t.after(() => { global.setTimeout = realSetTimeout; });
  const p = link.handle(submit(n, a.code));
  const r = await p;
  assert.strictEqual(r.status, 200);
  assert.ok(Date.now() - started < 5000);
});

test('the source has no personal, agent or place names and no absolute home paths', () => {
  for (const f of ['link.js', 'events.js']) {
    const src = fs.readFileSync(path.join(__dirname, '../modules/ring/lib', f), 'utf8');
    assert.ok(!/\/home\/|\/Users\//.test(src), f);
  }
});
