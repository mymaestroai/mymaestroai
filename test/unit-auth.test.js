'use strict';
// Behavioural unit tests for lib/auth.js: users, passwords, login lockout, sessions, TOTP, recovery
// codes, trusted devices, invites, request identification. Everything lives in a temp dir: the
// encryption key file is read from HUB_AUTH_DIR, so it is set before the module is loaded.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-auth-'));
process.env.HUB_AUTH_DIR = TMP;
const A = require('../lib/auth');

const T0 = Date.parse('2026-01-01T00:00:00Z');
function fresh() {
  const dir = fs.mkdtempSync(path.join(TMP, 'a-'));
  const clock = { t: T0 };
  const auth = A.createAuth({ dataDir: dir, now: () => clock.t, log: () => {} });
  return { auth, clock, dir };
}
const req = (cookie = '', extra = {}, ip = '10.0.0.5') => ({ headers: { cookie, 'user-agent': 'ua', ...extra }, socket: { remoteAddress: ip } });
const PW = 'correct horse battery staple';

test('hashPassword / verifyPassword / passwordPolicy', () => {
  const h = A.hashPassword(PW);
  assert.match(h, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.notStrictEqual(A.hashPassword(PW), h, 'fresh salt each time');
  assert.ok(A.verifyPassword(PW, h));
  assert.ok(!A.verifyPassword(PW + 'x', h));
  assert.ok(!A.verifyPassword(PW, 'garbage'), 'malformed stored hash is false, not a throw');
  assert.ok(!A.verifyPassword(PW, ''));
  assert.strictEqual(A.passwordPolicy(PW), null);
  assert.match(A.passwordPolicy('elevenchars'), /at least 12/);
  assert.match(A.passwordPolicy('x'.repeat(201)), /too long/);
  assert.strictEqual(A.passwordPolicy('x'.repeat(200)), null);
});

test('createUser validation: email login, roles, password rules, duplicates, defaults', () => {
  const { auth } = fresh();
  assert.strictEqual(auth.hasUsers(), false);
  for (const login of ['nope', 'a b@x.com', '', 'a@b']) assert.strictEqual(auth.createUser({ login, password: PW }).error, 'login must be an email address');
  assert.strictEqual(auth.createUser({ login: 'a@x.com', role: 'root', password: PW }).error, 'role must be admin or member');
  assert.match(auth.createUser({ login: 'a@x.com', password: 'short' }).error, /12 characters/);
  const r = auth.createUser({ login: '  Ann.Lee@X.com ', password: PW });
  assert.ok(r.ok);
  assert.strictEqual(r.user.login, 'ann.lee@x.com', 'login normalised');
  assert.strictEqual(r.user.name, 'ann.lee', 'name defaults to the (normalised) local part');
  assert.strictEqual(r.user.role, 'member');
  assert.match(r.user.id, /^u_[0-9a-f]{12}$/);
  assert.strictEqual(auth.createUser({ login: 'ann.lee@x.com', password: PW }).error, 'a user with that login exists');
  const long = auth.createUser({ login: 'b@x.com', name: 'n'.repeat(100), role: 'admin' });
  assert.strictEqual(long.user.name.length, 80);
  assert.ok(auth.hasUsers());
  assert.deepStrictEqual(auth.admins().map(u => u.login), ['b@x.com']);
  assert.strictEqual(auth.findByLogin('ANN.LEE@x.com').id, r.user.id);
  assert.strictEqual(auth.getUser('u_nope'), null);
});

test('publicUser never leaks hashes, secrets or recovery codes', () => {
  const { auth } = fresh();
  const u = auth.createUser({ login: 'p@x.com', password: PW }).user;
  auth.totpBegin(u.id);
  const raw = auth.getUser(u.id);
  assert.ok(raw.passwordHash && raw.totpPending, 'raw record has secrets');
  const forbidden = ['passwordHash', 'totpPending', 'totp', 'recovery'];
  for (const u2 of [auth.publicUser(raw), ...auth.listUsers()]) {
    for (const k of forbidden) assert.ok(!(k in u2), `${k} must not be exposed`);
    assert.deepStrictEqual(Object.keys(u2).sort(), ['createdAt', 'disabled', 'grants', 'id', 'lastLoginAt', 'login', 'name', 'role', 'totpEnabled']);
  }
});

test('updateUser / deleteUser / setPassword guard the last admin and revoke sessions', () => {
  const { auth } = fresh();
  const admin = auth.createUser({ login: 'adm@x.com', role: 'admin', password: PW }).user;
  const m = auth.createUser({ login: 'm@x.com', password: PW }).user;
  assert.strictEqual(auth.updateUser('u_x', { name: 'z' }).error, 'no such user'); assert.strictEqual(auth.updateUser(m.id, { role: 'god' }).error, 'bad role');
  assert.strictEqual(auth.updateUser(admin.id, { role: 'member' }).error, 'cannot demote the last admin');
  assert.strictEqual(auth.updateUser(admin.id, { disabled: true }).error, 'cannot disable the last admin');
  assert.strictEqual(auth.deleteUser(admin.id).error, 'cannot delete the last admin');
  assert.strictEqual(auth.updateUser(m.id, { name: 'Em', grants: { web: true } }).user.name, 'Em');
  const s = auth.createSession(auth.getUser(m.id));
  assert.ok(auth.getSession(s.token));
  assert.ok(auth.updateUser(m.id, { disabled: true }).ok);
  assert.strictEqual(auth.getSession(s.token), null, 'disabling revokes sessions');
  assert.strictEqual(auth.login('m@x.com', PW).error, 'Wrong login or password', 'disabled user cannot log in');
  assert.match(auth.setPassword(m.id, 'short').error, /12 characters/);
  const s2 = auth.createSession(auth.getUser(admin.id));
  assert.ok(auth.setPassword(admin.id, PW + '2', { by: admin.id }).ok);
  assert.ok(auth.getSession(s2.token), 'changing your own password keeps your session');
  assert.ok(auth.setPassword(admin.id, PW + '3', { by: 'someone-else' }).ok);
  assert.strictEqual(auth.getSession(s2.token), null, 'a reset by someone else revokes sessions');
  assert.ok(auth.deleteUser(m.id).ok);
  assert.strictEqual(auth.getUser(m.id), null);
});

test('login: success, wrong password, lockout after MAX_FAILURES, 15-minute window', () => {
  const { auth, clock } = fresh();
  auth.createUser({ login: 'l@x.com', password: PW });
  const ok = auth.login('L@x.com', PW, { ip: '1.2.3.4' });
  assert.ok(ok.ok && ok.needsTotp === false && ok.user.login === 'l@x.com');
  assert.strictEqual(auth.login('l@x.com', 'wrong password!!').error, 'Wrong login or password');
  assert.strictEqual(auth.login('ghost@x.com', PW).error, 'Wrong login or password', 'unknown login gets the same message');
  for (let i = 0; i < 9; i++) auth.login('l@x.com', 'wrong password!!');
  const locked = auth.login('l@x.com', PW);
  assert.strictEqual(locked.locked, true, 'the right password is refused after 10 failures');
  assert.match(locked.error, /15 minutes/);
  clock.t = T0 + 15 * 60 * 1000 - 1;
  assert.strictEqual(auth.login('l@x.com', PW).locked, true, 'still locked just inside the window');
  clock.t = T0 + 15 * 60 * 1000 + 1;
  assert.ok(auth.login('l@x.com', PW).ok, 'window elapsed: login works again');
  assert.ok(auth.auditRecent(50).some(e => e.action === 'login.locked'));
  // Note: a successful login does not clear earlier failures; only the window does.
});

test('sessions: create, identify from cookie, expiry, revoke one, revoke all, list, totp flag', () => {
  const { auth, clock } = fresh();
  const u = auth.getUser(auth.createUser({ login: 's@x.com', password: PW }).user.id);
  const s = auth.createSession(u, { req: req('', { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }) });
  assert.strictEqual(s.id, crypto.createHash('sha256').update(s.token).digest('hex'));
  assert.match(s.cookie, /^hub_sid=[A-Za-z0-9_-]+; Path=\/; SameSite=Lax; HttpOnly; Max-Age=2592000$/);
  assert.ok(!s.cookie.includes('Secure'), 'plain http request: no Secure flag');
  const id = auth.identify(req(`other=1; ${A.SESSION_COOKIE}=${s.token}`));
  assert.strictEqual(id.kind, 'user');
  assert.strictEqual(id.user.id, u.id);
  assert.strictEqual(id.pendingTotp, false);
  assert.strictEqual(auth.identify(req('hub_sid=bogus')), null);
  const rows = auth.listSessions(u.id);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].ip, '9.9.9.9', 'first x-forwarded-for hop recorded');
  assert.strictEqual(rows[0].totp_ok, 0);
  auth.markTotpOk(s.id);
  assert.strictEqual(auth.listSessions(u.id)[0].totp_ok, 1);
  const s2 = auth.createSession(u);
  auth.destroySession(s.token);
  assert.ok(auth.getSession(s.token) === null && auth.getSession(s2.token), 'destroy hits one session only');
  clock.t = T0 + 31 * 24 * 3600 * 1000;
  assert.strictEqual(auth.getSession(s2.token), null, 'expired after 30 days');
  clock.t = T0;
  const s3 = auth.createSession(u); const s4 = auth.createSession(u);
  auth.revokeSessions(u.id);
  assert.ok(auth.getSession(s3.token) === null && auth.getSession(s4.token) === null && auth.listSessions(u.id).length === 0);
});

test('TOTP: enrol, confirm with a code computed from the secret, replay, recovery codes single-use, disable', () => {
  const { auth, clock } = fresh();
  const u = auth.createUser({ login: 't@x.com', password: PW }).user;
  assert.strictEqual(auth.totpConfirm(u.id, '000000').error, 'no enrolment in progress');
  assert.strictEqual(auth.totpBegin('u_nope').error, 'no such user');
  const b = auth.totpBegin(u.id);
  assert.ok(b.ok && /^[A-Z2-7]{32}$/.test(b.secret));
  assert.ok(b.uri.startsWith('otpauth://totp/') && b.uri.includes(`secret=${b.secret}`));
  assert.ok(!fs.readFileSync(auth.usersFile, 'utf8').includes(b.secret), 'secret stored encrypted, not in clear');
  assert.match(auth.totpConfirm(u.id, '123456').error, /did not match/);
  const code = A.totpCode(b.secret, { now: clock.t });
  const c = auth.totpConfirm(u.id, code);
  assert.ok(c.ok);
  assert.strictEqual(c.recoveryCodes.length, 10);
  for (const rc of c.recoveryCodes) assert.match(rc, /^[0-9a-f]{4}-[0-9a-f]{4}$/);
  assert.strictEqual(auth.publicUser(auth.getUser(u.id)).totpEnabled, true);
  assert.ok(auth.login('t@x.com', PW).needsTotp);
  assert.strictEqual(auth.totpCheck(u.id, code).error, 'Wrong code', 'the enrolment code cannot be replayed');
  clock.t += 30000;
  assert.ok(auth.totpCheck(u.id, A.totpCode(b.secret, { now: clock.t })).ok);
  assert.strictEqual(auth.totpCheck(u.id, A.totpCode(b.secret, { now: clock.t })).error, 'Wrong code', 'replay within the same step');
  clock.t += 30000;
  assert.strictEqual(auth.totpCheck(u.id, '12345').error, 'Wrong code', 'five digits');
  const rc = c.recoveryCodes[3];
  const r1 = auth.totpCheck(u.id, rc.toUpperCase());
  assert.deepStrictEqual(r1, { ok: true, recovery: true, remaining: 9 });
  assert.strictEqual(auth.totpCheck(u.id, rc).error, 'Wrong code', 'recovery code is single-use');
  assert.ok(auth.totpDisable(u.id).ok);
  assert.strictEqual(auth.totpCheck(u.id, A.totpCode(b.secret, { now: clock.t })).error, 'two-factor is not enabled');
  assert.strictEqual(auth.totpDisable('u_nope').error, 'no such user');
});

test('pendingTotp on a session until markTotpOk; trusted device cookie honours user and expiry', () => {
  const { auth, clock } = fresh();
  const u = auth.getUser(auth.createUser({ login: 'd@x.com', password: PW }).user.id);
  const b = auth.totpBegin(u.id); auth.totpConfirm(u.id, A.totpCode(b.secret, { now: clock.t }));
  const s = auth.createSession(auth.getUser(u.id));
  assert.strictEqual(auth.identify(req(`hub_sid=${s.token}`)).pendingTotp, true);
  auth.markTotpOk(s.id);
  assert.strictEqual(auth.identify(req(`hub_sid=${s.token}`)).pendingTotp, false);
  const tr = auth.trustDevice(u, req());
  assert.match(tr.cookie, /^hub_trust=[A-Za-z0-9_-]+; Path=\/; SameSite=Lax; HttpOnly; Max-Age=2592000$/);
  assert.ok(auth.isTrusted(u, tr.token));
  assert.ok(!auth.isTrusted(u, 'nope') && !auth.isTrusted(u, ''));
  assert.ok(!auth.isTrusted({ id: 'u_other' }, tr.token), 'trust is per user');
  clock.t = T0 + 31 * 24 * 3600 * 1000;
  assert.ok(!auth.isTrusted(u, tr.token), 'expired after 30 days');
  clock.t = T0;
  const tr2 = auth.trustDevice(u, req());
  auth.revokeSessions(u.id);
  assert.ok(!auth.isTrusted(u, tr2.token), 'revoke all also forgets trusted devices');
});

test('invites: create, get, accept, expiry, revoke, listing', () => {
  const { auth, clock } = fresh();
  auth.createUser({ login: 'x@x.com', password: PW });
  assert.strictEqual(auth.createInvite({ login: 'bad' }).error, 'login must be an email address');
  assert.strictEqual(auth.createInvite({ login: 'x@x.com' }).error, 'a user with that login exists');
  const i = auth.createInvite({ login: 'New@y.com', name: 'Newbie', role: 'admin', by: 'u_adm' });
  assert.ok(i.ok && i.login === 'new@y.com');
  assert.strictEqual(Date.parse(i.expiresAt), T0 + 7 * 24 * 3600 * 1000);
  assert.ok(!fs.readFileSync(auth.usersFile, 'utf8').includes(i.token), 'only a hash of the token is stored');
  assert.deepStrictEqual(auth.getInvite(i.token), { login: 'new@y.com', name: 'Newbie', role: 'admin', expiresAt: i.expiresAt });
  assert.strictEqual(auth.getInvite('nope'), null); assert.strictEqual(auth.getInvite(undefined), null);
  const again = auth.createInvite({ login: 'new@y.com', name: 'N2' });
  assert.strictEqual(auth.getInvite(i.token), null, 're-inviting the same login replaces the earlier invite');
  assert.strictEqual(auth.listInvites().length, 1);
  assert.strictEqual(auth.acceptInvite(again.token, { password: 'short' }).error, 'Password must be at least 12 characters');
  assert.ok(auth.getInvite(again.token), 'a failed accept keeps the invite');
  const acc = auth.acceptInvite(again.token, { password: PW, name: 'Chosen' });
  assert.ok(acc.ok && acc.user.login === 'new@y.com' && acc.user.name === 'Chosen' && acc.user.role === 'member');
  assert.ok(!('passwordHash' in acc.user) && !('totp' in acc.user), 'acceptInvite returns the public shape, never the raw record');
  assert.strictEqual(acc.user.login, 'new@y.com');
  assert.strictEqual(auth.acceptInvite(again.token, { password: PW }).error, 'This invite link is invalid or has expired', 'single-use');
  assert.ok(auth.login('new@y.com', PW).ok);
  const e = auth.createInvite({ login: 'late@y.com' });
  clock.t = T0 + 7 * 24 * 3600 * 1000 + 1;
  assert.strictEqual(auth.getInvite(e.token), null, 'expired');
  assert.strictEqual(auth.acceptInvite(e.token, { password: PW }).error, 'This invite link is invalid or has expired');
  assert.strictEqual(auth.listInvites().length, 0);
  clock.t = T0;
  auth.createInvite({ login: 'r@y.com' });
  assert.deepStrictEqual(auth.revokeInvite('R@y.com'), { ok: true, removed: 1 });
  assert.deepStrictEqual(auth.revokeInvite('r@y.com'), { ok: true, removed: 0 });
});

test('identify: service token only from loopback, legacy fallback, disabled users, cookie helpers', () => {
  const { auth } = fresh();
  const svc = { [A.SERVICE_HEADER]: A.SERVICE_TOKEN };
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.deepStrictEqual(auth.identify(req('', svc, ip)), { kind: 'service' });
  assert.strictEqual(auth.identify(req('', svc, '10.0.0.5')), null, 'service token from the network is ignored');
  for (const bad of ['f'.repeat(64), 'short']) assert.strictEqual(auth.identify(req('', { [A.SERVICE_HEADER]: bad }, '127.0.0.1')), null, 'wrong token');
  assert.strictEqual(auth.identify(req(), { legacyCheck: () => true }).user.role, 'admin', 'legacy basic auth acts as an admin');
  assert.strictEqual(auth.identify(req(), { legacyCheck: () => false }), null);
  const u = auth.getUser(auth.createUser({ login: 'i@x.com', password: PW }).user.id);
  const s = auth.createSession(u);
  auth.updateUser(u.id, { disabled: true });
  assert.strictEqual(auth.identify(req(`hub_sid=${s.token}`)), null, 'disabled user is nobody');
  assert.deepStrictEqual(A.parseCookies(req('a=1; b=x%20y;c=3')), { a: '1', b: 'x y', c: '3' });
  assert.deepStrictEqual(A.parseCookies(req('a=%E0%A4%A; b=ok')), { a: '%E0%A4%A', b: 'ok' }, 'a malformed escape is kept raw, never thrown (review F07)');
  assert.deepStrictEqual(A.parseCookies({ headers: {} }), {});
  assert.ok(A.isSecureRequest({ headers: { 'x-forwarded-proto': 'https' }, socket: {} }) && A.isSecureRequest({ headers: {}, socket: { encrypted: true } }) && !A.isSecureRequest(req()));
  assert.strictEqual(A.cookieHeader('n', 'v', { req: { headers: { 'x-forwarded-proto': 'https' }, socket: {} }, maxAgeMs: 5000 }), 'n=v; Path=/; SameSite=Lax; HttpOnly; Secure; Max-Age=5');
  assert.strictEqual(A.cookieHeader('n', '', { req: req(), maxAgeMs: 0 }), 'n=; Path=/; SameSite=Lax; HttpOnly; Max-Age=0');
  assert.strictEqual(auth.clientIp(req('', { 'x-forwarded-for': ' 8.8.8.8 ,1.1.1.1' })), '8.8.8.8');
  assert.strictEqual(auth.clientIp(req()), '10.0.0.5');
  assert.strictEqual(A.getAuth({ dataDir: auth.usersFile.replace(/users\.json$/, ''), log: () => {} }), A.getAuth(), 'getAuth is a singleton');
});
