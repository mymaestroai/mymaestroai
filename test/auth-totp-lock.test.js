'use strict';
// Two-factor lockout (lib/auth totpCheck): 5 wrong codes refuse every code for that account for 60 s.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('auth-totp-lock-iso-');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-totp-lock-'));
process.env.HUB_AUTH_DIR = TMP;
const A = require(path.join(ISO.lib, 'auth'));
const { createAdmin2fa } = require(path.join(ISO.lib, 'admin-2fa'));

const T0 = Date.parse('2026-01-01T00:00:00Z');
const PW = 'correct horse battery staple';
const MSG = 'Too many wrong codes. Try again in a minute.';

function fresh() {
  const dir = fs.mkdtempSync(path.join(TMP, 'a-'));
  const clock = { t: T0 };
  const locks = [];
  const mk = () => A.createAuth({ dataDir: dir, now: () => clock.t, log: () => {}, onTotpLock: (x) => locks.push(x) });
  return { auth: mk(), mk, clock, locks, dir };
}
// An account with two-factor on; returns the secret and the recovery codes. The clock moves on so the enrolment code is spent.
function enrol(auth, clock, login) {
  const u = auth.createUser({ login, password: PW }).user;
  const b = auth.totpBegin(u.id);
  const c = auth.totpConfirm(u.id, A.totpCode(b.secret, { now: clock.t }));
  assert.ok(c.ok);
  return { id: u.id, secret: b.secret, recovery: c.recoveryCodes };
}
const wrong = (auth, id, n) => { let r; for (let i = 0; i < n; i++) r = auth.totpCheck(id, '000000'); return r; };
const good = (a, clock) => A.totpCode(a.secret, { now: clock.t });
const countAudit = (auth, action) => auth.auditRecent(1000).filter(r => r.action === action).length;

test('constants', () => {
  assert.strictEqual(A.TOTP_MAX_FAILS, 5);
  assert.strictEqual(A.TOTP_LOCK_MS, 60000);
});

test('5 wrong codes lock; the 5th answers locked; the right code is then refused', () => {
  const { auth, clock } = fresh();
  const a = enrol(auth, clock, 'owner@example.com');
  clock.t += 30000;
  for (let i = 0; i < 4; i++) { const r = auth.totpCheck(a.id, '000000'); assert.strictEqual(r.locked, undefined); assert.strictEqual(r.error, 'Wrong code'); }
  const r5 = auth.totpCheck(a.id, '000000');
  assert.strictEqual(r5.ok, false);
  assert.strictEqual(r5.locked, true);
  assert.strictEqual(r5.error, MSG);
  const r6 = auth.totpCheck(a.id, good(a, clock));
  assert.strictEqual(r6.ok, false);
  assert.strictEqual(r6.locked, true);
  assert.strictEqual(r6.error, MSG);
  assert.ok(r6.retryAfterMs > 0 && r6.retryAfterMs <= 60000);
});

test('after 60 s the right code works and the count restarted', () => {
  const { auth, clock } = fresh();
  const a = enrol(auth, clock, 'owner@example.com');
  clock.t += 30000;
  wrong(auth, a.id, 5);
  clock.t += 60001;
  assert.ok(auth.totpCheck(a.id, good(a, clock)).ok);
  const r = wrong(auth, a.id, 4);
  assert.strictEqual(r.locked, undefined, '4 wrong after a success do not lock');
  assert.strictEqual(r.error, 'Wrong code');
});

test('lock ends by time even when the next attempt is wrong, and the count restarts', () => {
  const { auth, clock } = fresh();
  const a = enrol(auth, clock, 'owner@example.com');
  clock.t += 30000;
  wrong(auth, a.id, 5);
  clock.t += 60001;
  const r = wrong(auth, a.id, 4);
  assert.strictEqual(r.locked, undefined);
  assert.strictEqual(auth.totpCheck(a.id, '000000').locked, true, 'the 5th wrong since the lock ended locks again');
});

test('4 wrong, right, 4 wrong: success resets the count', () => {
  const { auth, clock } = fresh();
  const a = enrol(auth, clock, 'owner@example.com');
  clock.t += 30000;
  wrong(auth, a.id, 4);
  assert.ok(auth.totpCheck(a.id, good(a, clock)).ok);
  const r = wrong(auth, a.id, 4);
  assert.strictEqual(r.locked, undefined);
});

test('input that is not a code (empty, letters) counts as a failure', () => {
  const { auth, clock } = fresh();
  const a = enrol(auth, clock, 'owner@example.com');
  clock.t += 30000;
  for (const bad of ['', 'abcdef', 'hello', '   ']) assert.strictEqual(auth.totpCheck(a.id, bad).locked, undefined);
  assert.strictEqual(auth.totpCheck(a.id, 'zzzz').locked, true);
});

test('recovery codes share the counter; a valid one is refused and not consumed while locked', () => {
  const { auth, clock } = fresh();
  const a = enrol(auth, clock, 'owner@example.com');
  clock.t += 30000;
  let r;
  for (let i = 0; i < 5; i++) r = auth.totpCheck(a.id, 'abcd-1234');
  assert.strictEqual(r.locked, true);
  assert.strictEqual(r.error, MSG);
  const valid = a.recovery[0];
  const refused = auth.totpCheck(a.id, valid);
  assert.strictEqual(refused.locked, true);
  assert.strictEqual(auth.getUser(a.id).recovery.length, 10, 'not consumed');
  clock.t += 60001;
  assert.deepStrictEqual(auth.totpCheck(a.id, valid), { ok: true, recovery: true, remaining: 9 });
});

test('mixed wrong TOTP and wrong recovery codes count together', () => {
  const { auth, clock } = fresh();
  const a = enrol(auth, clock, 'owner@example.com');
  clock.t += 30000;
  auth.totpCheck(a.id, '000000'); auth.totpCheck(a.id, 'abcd-1234'); auth.totpCheck(a.id, '111111'); auth.totpCheck(a.id, 'abcd-1235');
  assert.strictEqual(auth.totpCheck(a.id, '222222').locked, true);
});

test('one totp.locked audit line and one notifier call per lock; refused attempts add nothing', () => {
  const { auth, clock, locks } = fresh();
  const a = enrol(auth, clock, 'owner@example.com');
  clock.t += 30000;
  wrong(auth, a.id, 5);
  const fails = countAudit(auth, 'totp.fail');
  for (let i = 0; i < 4; i++) auth.totpCheck(a.id, '000000');
  auth.totpCheck(a.id, good(a, clock));
  assert.strictEqual(countAudit(auth, 'totp.locked'), 1);
  assert.strictEqual(countAudit(auth, 'totp.fail'), fails, 'no extra audit lines while locked');
  assert.strictEqual(locks.length, 1);
  assert.strictEqual(locks[0].user.login, 'owner@example.com');
  assert.strictEqual(locks[0].lockedUntil, T0 + 30000 + 60000);
  const row = auth.auditRecent(1000).find(r => r.action === 'totp.locked');
  assert.strictEqual(row.detail, '5 wrong codes; 60 s');
  // a second lock gives a second line and call
  clock.t += 60001;
  wrong(auth, a.id, 5);
  assert.strictEqual(countAudit(auth, 'totp.locked'), 2);
  assert.strictEqual(locks.length, 2);
});

test('a notifier that throws does not change the answer; setTotpLockNotifier replaces it', () => {
  const { auth, clock } = fresh();
  const a = enrol(auth, clock, 'owner@example.com');
  clock.t += 30000;
  auth.setTotpLockNotifier(() => { throw new Error('boom'); });
  const r = wrong(auth, a.id, 5);
  assert.strictEqual(r.locked, true);
  assert.strictEqual(r.error, MSG);
  const seen = [];
  clock.t += 60001;
  auth.setTotpLockNotifier((x) => seen.push(x));
  wrong(auth, a.id, 5);
  assert.strictEqual(seen.length, 1);
});

test('two accounts are independent', () => {
  const { auth, clock } = fresh();
  const a = enrol(auth, clock, 'owner@example.com');
  const b = enrol(auth, clock, 'sam@example.com');
  clock.t += 30000;
  assert.strictEqual(wrong(auth, a.id, 5).locked, true);
  assert.ok(auth.totpCheck(b.id, good(b, clock)).ok);
  assert.strictEqual(auth.totpCheck(a.id, good(a, clock)).locked, true);
});

test('the lock survives a new createAuth on the same dataDir', () => {
  const { auth, mk, clock } = fresh();
  const a = enrol(auth, clock, 'owner@example.com');
  clock.t += 30000;
  wrong(auth, a.id, 5);
  const again = mk();
  const r = again.totpCheck(a.id, good(a, clock));
  assert.strictEqual(r.locked, true);
  assert.strictEqual(r.error, MSG);
});

test('admin-2fa setRequired passes the lock through as 429', () => {
  const calls = [];
  const user = { id: 'u1', login: 'owner@example.com', role: 'admin' };
  const auth = {
    getUser: () => user, login: () => ({ ok: true, needsTotp: true }),
    totpCheck: () => ({ ok: false, locked: true, error: MSG }), audit: () => {},
  };
  const a = createAdmin2fa({ getSetting: () => true, updateSettings: (p) => calls.push(p), auth });
  const r = a.setRequired({ actorId: 'u1', isAdmin: true, want: false, password: 'pw', code: '000000' });
  assert.deepStrictEqual(r, { ok: false, status: 429, error: MSG });
  assert.strictEqual(calls.length, 0, 'setting not changed');
});

test('server.js: route, step-up, disable and notifier wiring (source pins; no harness drives these routes)', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(s.includes("if (!r.ok && r.locked) return jsonResponse(res, 429, { ok: false, locked: true, error: r.error });"));
  assert.ok(s.includes("if (!t || !t.ok) return (t && t.locked) ? t.error : 'That two-factor code is not right.';"));
  assert.ok(s.includes("jsonResponse(res, (t && t.locked) ? 429 : 403, { error: (t && t.locked) ? t.error : 'That two-factor code is not right.' })"));
  assert.ok(s.includes('hubAuth.setTotpLockNotifier('));
  assert.ok(/notifyUsers\(\{[\s\S]*?tag: 'totp-lock',[\s\S]*?\}, ids, \{ kind: 'security' \}\)/.test(s));
  assert.ok(s.includes('[auth] two-factor locked for a minute: ${user.login}'));
  const login = fs.readFileSync(path.join(__dirname, '..', 'login.html'), 'utf8');
  assert.ok(/if \(res\.body && res\.body\.error\) return res\.body\.error;/.test(login), 'sign-in page shows the server error text');
});
