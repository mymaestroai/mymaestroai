'use strict';
// API tokens for programs (lib/auth createToken / tokenFromRequest / identify; lib/access tokenAllows and the
// OpenAI-compatible routes as "api"), the retired legacy login (server.js: honoured only without accounts, constant-time
// compare, no Basic header on the hub's own calls), the exposure rule (lib/bind-host: with accounts, an admin with
// two-factor), the setup-checklist item, the Users page section and the offline CLI. Everything in temp dirs.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'api-tokens-'));
process.env.HUB_AUTH_DIR = TMP;
const A = require('../lib/auth');
const access = require('../lib/access');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const T0 = Date.parse('2026-01-01T00:00:00Z');
function fresh() {
  const dir = fs.mkdtempSync(path.join(TMP, 'a-'));
  const clock = { t: T0 };
  return { auth: A.createAuth({ dataDir: dir, now: () => clock.t, log: () => {} }), clock, dir };
}
const req = (headers = {}, ip = '127.0.0.1') => ({ headers, socket: { remoteAddress: ip } });
const bearer = (t, extra = {}, ip) => req({ authorization: `Bearer ${t}`, ...extra }, ip);
const PW = 'correct horse battery staple';

test('createToken: secret shown once and never stored, validation, listing without secrets, audit without the secret', () => {
  const { auth, dir } = fresh();
  const r = auth.createToken({ name: 'bots', scopes: 'chat,status', agents: 'Trader, scout', by: 'u1' });
  assert.match(r.token, /^hub_[a-f0-9]{12}_[A-Za-z0-9_-]{40,}$/);
  assert.strictEqual(r.record.id, r.token.slice(4, 16), 'the id is part of the secret, for support without revealing it');
  assert.deepStrictEqual(r.record.scopes, ['chat', 'status']);
  assert.deepStrictEqual(r.record.agents, ['trader', 'scout'], 'agent names lower-cased');
  assert.strictEqual(r.record.loopbackOnly, true, 'this machine only by default');
  assert.strictEqual(r.record.expiresAt, null);
  assert.strictEqual(r.record.createdBy, 'u1');
  const random = r.token.slice(17);
  for (const f of ['auth.db', 'auth.db-wal']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) assert.ok(!fs.readFileSync(p).includes(random), `${f} must not contain the secret`);
  }
  const list = auth.listTokens();
  assert.strictEqual(list.length, 1);
  assert.ok(!('token' in list[0]) && !('hash' in list[0]), 'list carries neither the secret nor its hash');
  assert.deepStrictEqual(auth.getToken(r.record.id), list[0]);
  assert.strictEqual(auth.getToken('nope'), null);
  assert.throws(() => auth.createToken({ name: '', scopes: 'status' }), /name/);
  assert.throws(() => auth.createToken({ name: 'x'.repeat(61), scopes: 'status' }), /name/);
  assert.throws(() => auth.createToken({ name: 'x', scopes: '' }), /scope/);
  assert.throws(() => auth.createToken({ name: 'x', scopes: 'admin' }), /unknown scope "admin"/);
  assert.throws(() => auth.createToken({ name: 'x', scopes: 'chat' }), /agents list/);
  assert.throws(() => auth.createToken({ name: 'x', scopes: 'interject', agents: '' }), /agents list/);
  assert.throws(() => auth.createToken({ name: 'x', scopes: 'status', agents: 'bad name!' }), /agents/);
  assert.throws(() => auth.createToken({ name: 'x', scopes: 'status', expiresDays: 0 }), /expiresDays/);
  assert.throws(() => auth.createToken({ name: 'x', scopes: 'status', expiresDays: 99999 }), /expiresDays/);
  assert.strictEqual(auth.listTokens().length, 1, 'refused creations leave nothing behind');
  const a = auth.auditRecent(5);
  const row = a.find(x => x.action === 'token.create');
  assert.ok(row && row.user_id === 'u1' && /"bots"/.test(row.detail) && /scopes=chat\+status/.test(row.detail) && /agents=trader\+scout/.test(row.detail), JSON.stringify(row));
  assert.ok(!row.detail.includes(random), 'audit never carries the secret');
});

test('identify: valid token, unknown / one-char-off / foreign bearer, loopback-only vs network and proxies, last used, expiry, revoke, any-host', () => {
  const { auth, clock } = fresh();
  const { token, record } = auth.createToken({ name: 'bots', scopes: 'status' });
  assert.strictEqual(auth.identify(req()), null, 'no header: nothing');
  assert.strictEqual(auth.tokenFromRequest(req({ authorization: 'Basic abc' })), null, 'Basic is not a bearer');
  assert.strictEqual(auth.getToken(record.id).lastUsed, null);
  const id = auth.identify(bearer(token));
  assert.strictEqual(id.kind, 'token');
  assert.strictEqual(id.token.id, record.id);
  assert.deepStrictEqual(id.user, { id: `token:${record.id}`, login: 'bots', name: 'bots', role: 'token' }, 'never an admin or member');
  assert.strictEqual(auth.getToken(record.id).lastUsed, new Date(T0).toISOString(), 'use is stamped');
  clock.t = T0 + 30000; auth.identify(bearer(token));
  assert.strictEqual(auth.getToken(record.id).lastUsed, new Date(T0).toISOString(), 'throttled to once a minute');
  clock.t = T0 + 61000; auth.identify(bearer(token));
  assert.strictEqual(auth.getToken(record.id).lastUsed, new Date(T0 + 61000).toISOString());
  assert.deepStrictEqual(auth.identify(bearer('hub_000000000000_nope')), { kind: 'bad-token', reason: 'unknown token' });
  assert.deepStrictEqual(auth.identify(bearer('sk-other-vendor')), { kind: 'bad-token', reason: 'not a hub token' });
  assert.strictEqual(auth.identify(bearer(token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a'))).kind, 'bad-token', 'one character off');
  assert.strictEqual(auth.identify(bearer(token, {}, '10.0.0.5')).reason, 'this token works from the hub machine only');
  assert.strictEqual(auth.identify(bearer(token, { 'x-forwarded-for': '100.64.0.2' })).reason, 'this token works from the hub machine only', 'through a proxy: refused');
  assert.strictEqual(auth.identify(bearer(token, { 'tailscale-user-login': 'x@example.com' })).reason, 'this token works from the hub machine only', 'through Tailscale Serve: refused');
  assert.strictEqual(auth.identify(bearer(token, {}, '::ffff:127.0.0.1')).kind, 'token', 'ipv4-mapped loopback');
  // a bad bearer never falls through to a session cookie; a good one wins over the cookie
  const u = auth.getUser(auth.createUser({ login: 's@x.com', password: PW, role: 'admin' }).user.id);
  const s = auth.createSession(u, { req: req() });
  assert.strictEqual(auth.identify(req({ cookie: `${A.SESSION_COOKIE}=${s.token}` })).kind, 'user', 'cookie alone works');
  assert.strictEqual(auth.identify(req({ cookie: `${A.SESSION_COOKIE}=${s.token}`, authorization: 'Bearer hub_000000000000_x' })).kind, 'bad-token');
  assert.strictEqual(auth.identify(req({ cookie: `${A.SESSION_COOKIE}=${s.token}`, authorization: `Bearer ${token}` })).kind, 'token');
  // the hub's own service header still comes first
  assert.strictEqual(auth.identify(req({ [A.SERVICE_HEADER]: A.SERVICE_TOKEN, authorization: 'Bearer hub_000000000000_x' })).kind, 'service');
  // expiry
  const e = auth.createToken({ name: 'short', scopes: 'status', expiresDays: 1 });
  assert.strictEqual(e.record.expiresAt, new Date(clock.t + 86400000).toISOString());
  clock.t += 86400000 - 1; assert.strictEqual(auth.identify(bearer(e.token)).kind, 'token');
  clock.t += 1; assert.strictEqual(auth.identify(bearer(e.token)).reason, 'token expired');
  // revoke
  const rv = auth.revokeToken(record.id, { by: 'u1' });
  assert.ok(rv.revokedAt);
  assert.strictEqual(auth.identify(bearer(token)).reason, 'token revoked');
  assert.throws(() => auth.revokeToken(record.id), /no such active token/);
  assert.throws(() => auth.revokeToken('nope'), /no such active token/);
  assert.ok(auth.auditRecent(10).some(x => x.action === 'token.revoke' && x.detail === record.id && x.user_id === 'u1'));
  // any-host token: accepted from the network and through proxies
  const any = auth.createToken({ name: 'remote', scopes: 'openai-api', loopbackOnly: false });
  assert.strictEqual(any.record.loopbackOnly, false);
  assert.strictEqual(auth.identify(bearer(any.token, { 'x-forwarded-for': '100.64.0.2' }, '10.0.0.5')).kind, 'token');
});

test('tokenAllows: scopes map to routes, chat/interject only for the token\'s agents, everything else refused', () => {
  const t = { scopes: ['chat', 'interject', 'status', 'wallet-executor'], agents: ['trader'] };
  const ok = (p, m, agent) => access.tokenAllows(t, p, m, { agent }).ok;
  for (const p of ['/api/chat', '/api/chat/stream', '/api/chat/interject', '/api/chat/stop']) assert.ok(ok(p, 'POST', 'trader'), p);
  assert.ok(!ok('/api/chat', 'POST', 'doc'), 'another agent');
  assert.ok(!ok('/api/chat', 'POST', null), 'no agent named');
  assert.match(access.tokenAllows(t, '/api/chat', 'POST', { agent: 'doc' }).reason, /may not address agent "doc"/);
  for (const p of ['/api/health', '/api/hub/status', '/api/agents/status', '/api/agents/trader/turn', '/api/agents/doc/turn']) assert.ok(ok(p, 'GET'), p);
  assert.ok(ok('/api/wallet/execute', 'POST')); assert.ok(ok('/api/wallet/executor', 'GET'));
  for (const [p, m] of [['/api/agents', 'GET'], ['/api/wallet/executor/token', 'POST'], ['/api/wallet/executor', 'POST'], ['/api/users', 'GET'], ['/api/tokens', 'GET'], ['/api/tokens', 'POST'], ['/api/settings', 'POST'], ['/v1/models', 'GET'], ['/api/chat', 'GET'], ['/api/agents/trader', 'PATCH'], ['/api/agents/trader/turn/x', 'GET'], ['/api/restart', 'POST']]) {
    const r = access.tokenAllows(t, p, m, { agent: 'trader' });
    assert.ok(!r.ok, `${m} ${p}`); assert.match(r.reason, /outside the token's scopes/);
  }
  assert.ok(access.tokenAllows({ scopes: ['openai-api'] }, '/v1/models', 'GET').ok);
  assert.ok(access.tokenAllows({ scopes: ['openai-api'] }, '/v1/chat/completions', 'POST').ok);
  assert.ok(!access.tokenAllows({ scopes: ['openai-api'] }, '/api/chat', 'POST', { agent: 'x' }).ok);
  assert.ok(!access.tokenAllows(null, '/api/health', 'GET').ok);
  assert.ok(!access.tokenAllows({ scopes: [] }, '/api/health', 'GET').ok);
  assert.deepStrictEqual(Object.keys(A.TOKEN_SCOPES).sort(), Object.keys(access.TOKEN_ROUTES).sort(), 'every scope has routes and vice versa');
});

test('classifyRoute: the OpenAI-compatible endpoints are "api" (token with openai-api, or an admin), no longer public', () => {
  for (const p of ['/v1/models', '/v1/chat/completions', '/v1', '/v1/']) assert.strictEqual(access.classifyRoute(p, 'GET').kind, 'api', p);
  assert.strictEqual(access.classifyRoute('/health', 'GET').kind, 'public');
  assert.notStrictEqual(access.classifyRoute('/v10/x', 'GET').kind, 'api', 'only the /v1 prefix');
});

test('server.js: legacy pair only without accounts and in constant time; token gate; /api/tokens routes; hub self-calls carry no Basic header', () => {
  const server = read('server.js');
  assert.ok(server.includes("legacyCheck: (r) => !!AUTH_USERNAME && !hubAuth.hasUsers() && checkAuth(r)"), 'legacy pair ignored once accounts exist');
  assert.match(server, /function checkAuth\(req\) \{[\s\S]*?timingSafeEqual[\s\S]*?\n\}/, 'constant-time compare');
  assert.ok(!server.includes('user === AUTH_USERNAME && pass === AUTH_PASSWORD'), 'plain === compare gone');
  assert.ok(server.includes("ident.kind === 'bad-token'") && server.includes("{ error: 'token_scope', detail: allow.reason }"), 'token gate: bad token 401, out of scope 403');
  assert.ok(server.includes("route.kind === 'api'") && server.includes("access.tokenAllows(req.hubToken, pathname, req.method).ok"), '/v1 gate');
  assert.ok(server.includes("req.hubToken = ident && ident.kind === 'token' ? ident.token : null"), 'token identity never becomes hubUser');
  assert.ok(server.includes("pathname === '/api/tokens' && req.method === 'POST'") && server.includes('hubAuth.createToken({ ...b, by: req.hubUser && req.hubUser.id })'), 'create route');
  assert.ok(server.includes('hubAuth.revokeToken(m[1], { by: req.hubUser && req.hubUser.id })'), 'revoke route');
  assert.ok(server.includes("if (req.hubService) return jsonResponse(res, 403, { error: 'Tokens are created by a signed-in admin.' })"), 'never from the service identity');
  assert.ok(server.includes('hasSecuredAdmin: () => hubAuth.admins().some(u => u.totp && u.totp.enabled)'), 'exposure rule wired');
  assert.ok(server.includes('the old password login is ignored'), 'startup warning');
  const sdk = read('lib/sdk-chat.js');
  assert.ok(!sdk.includes('HUB_AUTH_USERNAME') && !sdk.includes("'Basic ' + Buffer.from"), 'self-calls use the service header only');
});

test('bind-host: with accounts, exposure needs an admin with two-factor; the legacy pair alone no longer opens the door', () => {
  const { resolveBindHost } = require('../lib/bind-host');
  const PAIR = { HUB_BIND_HOST: '0.0.0.0', HUB_AUTH_USERNAME: 'admin', HUB_AUTH_PASSWORD: 'secret' };
  assert.strictEqual(resolveBindHost(PAIR, { hasUsers: () => false }).exposed, true, 'no accounts: the pair still counts');
  const r = resolveBindHost(PAIR, { hasUsers: () => true, hasSecuredAdmin: () => false });
  assert.strictEqual(r.host, '127.0.0.1'); assert.strictEqual(r.exposed, false); assert.match(r.warning, /admin account with two-factor/);
  const ok = resolveBindHost({ HUB_BIND_HOST: '0.0.0.0' }, { hasUsers: () => true, hasSecuredAdmin: () => true });
  assert.strictEqual(ok.host, '0.0.0.0'); assert.strictEqual(ok.exposed, true); assert.match(ok.warning, /two-factor/);
  assert.strictEqual(resolveBindHost({ HUB_BIND_HOST: '192.168.1.5' }, { hasUsers: () => true, hasSecuredAdmin: () => false }).exposed, false);
  assert.strictEqual(resolveBindHost({ ...PAIR, HUB_BIND_HOST: 'localhost' }, { hasUsers: () => true, hasSecuredAdmin: () => true }).exposed, false, 'loopback is never exposure');
});

test('readiness: warns about the old password login once accounts exist, not before', async () => {
  const { createReadiness } = require('../lib/readiness');
  const base = {
    platform: 'linux', setupNeeded: () => false, hasSdkCredentials: () => true,
    agents: async () => [{ name: 'maestro', model: 'claude-sdk/claude-fable-5-1' }],
    sandboxStatus: async () => ({ docker: true, imageReady: true }), fetchStatus: async () => ({ renderer: true, pdftotext: true }),
    searchChain: () => ['brave'], supervisor: () => 'systemd', exposed: () => false,
    listUsers: () => [{ login: 'owner', role: 'admin', totpEnabled: true }],
  };
  const with_ = await createReadiness({ ...base, hasUsers: () => true, legacyAuth: () => true }).check();
  const item = with_.items.find(i => i.id === 'legacy-auth');
  assert.ok(item, 'item present'); assert.strictEqual(item.level, 'warn'); assert.match(item.fix, /Remove the two lines/); assert.match(item.fix, /API tokens/);
  const without = await createReadiness({ ...base, hasUsers: () => false, legacyAuth: () => true }).check();
  assert.strictEqual(without.items.find(i => i.id === 'legacy-auth'), undefined, 'no accounts yet: the pair is the login, not a leftover');
  const clean = await createReadiness({ ...base, hasUsers: () => true, legacyAuth: () => false }).check();
  assert.strictEqual(clean.items.find(i => i.id === 'legacy-auth'), undefined);
});

test('users.html: API tokens section (list, create with scope boxes and agents, show once with Copy, revoke)', () => {
  const html = read('users.html');
  for (const s of ['id="tokens-section"', "api('/api/tokens')", "api('/api/tokens', { method: 'POST', body })", "api(`/api/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })",
    'id="token-secret"', 'id="token-copy"', 'name="scope"', 'id="token-local"', 'id="token-agents"', 'await loadTokens();', 'Copy it now: it is not shown again']) assert.ok(html.includes(s), s);
  assert.ok(html.indexOf('id="tokens-section"') < html.indexOf('id="audit-section"'), 'above the audit log');
});

test('scripts/hub-token.js: creates (to a 600 file), lists and revokes against a data dir the hub then reads', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'cli-'));
  const cli = path.join(ROOT, 'scripts', 'hub-token.js');
  const run = (...args) => execFileSync(process.execPath, [cli, ...args, '--data-dir', dir], { env: { ...process.env, HUB_AUTH_DIR: dir }, encoding: 'utf8' });
  const out = path.join(dir, 'tok');
  const made = run('create', '--name', 'bots', '--scopes', 'chat,status', '--agents', 'trader', '--out', out);
  assert.match(made, /Written to .*tok \(mode 600\)/);
  assert.ok(!made.includes('hub_'), 'the secret is not printed when written to a file');
  assert.strictEqual(fs.statSync(out).mode & 0o777, 0o600);
  const token = fs.readFileSync(out, 'utf8').trim();
  assert.match(token, /^hub_[a-f0-9]{12}_/);
  const id = token.slice(4, 16);
  assert.match(run('list'), new RegExp(`${id}\\s+bots\\s+chat,status\\s+agents=trader\\s+local`));
  const printed = run('create', '--name', 'shown', '--scopes', 'status', '--any-host', '--expires-days', '2');
  assert.match(printed, /Copy it now; it is not shown again:\n\nhub_[a-f0-9]{12}_/);
  assert.match(printed, /any host; expires 20/);
  assert.throws(() => run('create', '--name', 'x', '--scopes', 'nope'), /unknown scope "nope"/);
  // the hub's own auth module sees the CLI's token
  const auth = A.createAuth({ dataDir: dir, log: () => {} });
  assert.strictEqual(auth.identify(bearer(token)).kind, 'token');
  assert.match(run('revoke', id), /Revoked .*"bots"/);
  assert.match(run('list'), /REVOKED/);
  assert.strictEqual(auth.identify(bearer(token)).reason, 'token revoked');
  assert.throws(() => run('revoke', id), /no such active token/);
});
