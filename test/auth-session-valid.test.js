'use strict';
// sessionStillValid(sessionId, userId): a held message asks, when it is released, whether the browser sign-in it was sent from still stands.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('auth-session-valid-iso-');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-session-valid-'));
process.env.HUB_AUTH_DIR = TMP;
const A = require(path.join(ISO.lib, 'auth'));

const T0 = Date.parse('2026-01-01T00:00:00Z');
const PW = 'a decent passphrase';
const req = () => ({ headers: { 'user-agent': 'test' }, socket: { remoteAddress: '127.0.0.1' } });

function fresh() {
  const dir = fs.mkdtempSync(path.join(TMP, 'a-'));
  const clock = { t: T0 };
  const auth = A.createAuth({ dataDir: dir, now: () => clock.t, log: () => {} });
  return { auth, clock };
}
function signedIn(auth, login, opts = {}) {
  const u = auth.createUser({ login, password: PW }).user;
  const s = auth.createSession(auth.getUser(u.id), { req: req(), ...opts });
  return { id: u.id, session: s };
}

test('a live session is valid for its own account only', () => {
  const { auth } = fresh();
  const a = signedIn(auth, 'sam@example.com'), b = signedIn(auth, 'lee@example.com');
  assert.strictEqual(auth.sessionStillValid(a.session.id, a.id), true);
  assert.strictEqual(auth.sessionStillValid(a.session.id, b.id), false, 'another account');
  assert.strictEqual(auth.sessionStillValid('', a.id), false);
  assert.strictEqual(auth.sessionStillValid(null, a.id), false);
  assert.strictEqual(auth.sessionStillValid('nope', a.id), false);
});

test('signed out, revoked and expired each end it', () => {
  const { auth, clock } = fresh();
  const a = signedIn(auth, 'sam@example.com');
  auth.destroySession(a.session.token);
  assert.strictEqual(auth.sessionStillValid(a.session.id, a.id), false, 'signed out');
  const b = signedIn(auth, 'lee@example.com');
  auth.revokeSessions(b.id);
  assert.strictEqual(auth.sessionStillValid(b.session.id, b.id), false, 'revoked');
  const c = signedIn(auth, 'kim@example.com');
  clock.t += 31 * 24 * 3600 * 1000;
  assert.strictEqual(auth.sessionStillValid(c.session.id, c.id), false, 'expired');
});

test('a session that still owes a two-factor code is not valid until it is verified', () => {
  const { auth, clock } = fresh();
  const u = auth.createUser({ login: 'pat@example.com', password: PW }).user;
  const b = auth.totpBegin(u.id);
  assert.ok(auth.totpConfirm(u.id, A.totpCode(b.secret, { now: clock.t })).ok);
  const s = auth.createSession(auth.getUser(u.id), { req: req() });
  assert.strictEqual(auth.sessionStillValid(s.id, u.id), false, 'pending code');
  auth.markTotpOk(s.id);
  assert.strictEqual(auth.sessionStillValid(s.id, u.id), true);
});
