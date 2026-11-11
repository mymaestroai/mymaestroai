'use strict';
// "Require two-factor sign-in for admins" (lib/admin-2fa): the rule, the switch, and source pins on the routes in server.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { REQUIRED_MESSAGE, requiredFrom, createAdmin2fa } = require('../lib/admin-2fa');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function rig({ settings = {}, user = { id: 'u1', login: 'owner@example.com', name: 'Owner', role: 'admin' }, login = { ok: true, needsTotp: false }, totp = { ok: true }, notify } = {}) {
  const calls = { writes: [], audits: [], logins: [], totps: [], notices: [], logs: [] };
  const auth = {
    getUser: (id) => (user && id === user.id ? user : null),
    login: (l, p, o) => { calls.logins.push([l, p, o]); return typeof login === 'function' ? login(p) : login; },
    totpCheck: (id, code) => { calls.totps.push([id, code]); return typeof totp === 'function' ? totp(code) : totp; },
    audit: (...a) => calls.audits.push(a),
  };
  const a = createAdmin2fa({
    getSetting: (k, d) => (k in settings ? settings[k] : d),
    updateSettings: (p) => { calls.writes.push(p); Object.assign(settings, p); },
    auth, notify: notify || ((p) => calls.notices.push(p)), log: (m) => calls.logs.push(m),
  });
  return { a, calls, settings };
}
const off = (r, extra = {}) => r.a.setRequired({ actorId: 'u1', isAdmin: true, want: false, password: 'pw', ip: '10.0.0.1', ...extra });

test('requiredFrom: on unless exactly false', () => {
  for (const v of [undefined, true, 'false', 0, null]) assert.strictEqual(requiredFrom(v), true);
  assert.strictEqual(requiredFrom(false), false);
  assert.match(REQUIRED_MESSAGE, /Require two-factor sign-in for admins/);
});

test('required() reads the setting, defaulting to on', () => {
  assert.strictEqual(rig().a.required(), true);
  assert.strictEqual(rig({ settings: { requireAdmin2fa: false } }).a.required(), false);
});

test('setRequired: bad input and non-admins are refused', () => {
  const r = rig();
  for (const want of [undefined, 'false', 0, null]) assert.deepStrictEqual(r.a.setRequired({ actorId: 'u1', isAdmin: true, want }), { ok: false, status: 400, error: 'Send required: true or false.' });
  const denied = { ok: false, status: 403, error: 'Only an admin can change this.' };
  assert.deepStrictEqual(r.a.setRequired({ actorId: 'u1', isAdmin: false, want: false }), denied);
  assert.deepStrictEqual(rig({ user: { id: 'u1', login: 'sam@example.com', role: 'member' } }).a.setRequired({ actorId: 'u1', isAdmin: true, want: false }), denied);
  assert.deepStrictEqual(rig({ user: { id: 'u1', login: 'sam@example.com', role: 'admin', disabled: true } }).a.setRequired({ actorId: 'u1', isAdmin: true, want: false }), denied);
  assert.deepStrictEqual(r.a.setRequired({ actorId: 'nobody', isAdmin: true, want: false }), denied);
  assert.strictEqual(r.calls.writes.length, 0);
});

test('setRequired: the same value changes nothing', () => {
  const r = rig();
  assert.deepStrictEqual(r.a.setRequired({ actorId: 'u1', isAdmin: true, want: true }), { ok: true, required: true, changed: false });
  const o = rig({ settings: { requireAdmin2fa: false } });
  assert.deepStrictEqual(off(o), { ok: true, required: false, changed: false });
  for (const x of [r, o]) assert.deepStrictEqual([x.calls.writes, x.calls.audits, x.calls.notices, x.calls.logins], [[], [], [], []]);
});

test('turning off needs the password', () => {
  const r = rig({ login: { ok: false } });
  assert.deepStrictEqual(off(r), { ok: false, status: 403, error: 'That password is not right.' });
  assert.deepStrictEqual(r.calls.writes, []);
  assert.deepStrictEqual(r.calls.logins[0], ['owner@example.com', 'pw', { ip: '10.0.0.1' }]);
  const l = rig({ login: { ok: false, locked: true, error: 'Too many failed attempts. Try again in 15 minutes.' } });
  assert.deepStrictEqual(off(l), { ok: false, status: 403, error: 'Too many failed attempts. Try again in 15 minutes.' });
  assert.strictEqual(rig({ login: null }).a.setRequired({ actorId: 'u1', isAdmin: true, want: false }).error, 'That password is not right.');
});

test('turning off with two-factor on the account needs a current code', () => {
  const r = rig({ login: { ok: true, needsTotp: true }, totp: (c) => ({ ok: c === '123456' }) });
  const bad = { ok: false, status: 403, error: 'That two-factor code is not right.' };
  assert.deepStrictEqual(off(r), bad);
  assert.deepStrictEqual(off(r, { code: '000000' }), bad);
  assert.deepStrictEqual(r.calls.writes, []);
  assert.deepStrictEqual(off(r, { code: '123 456' }), { ok: true, required: false, changed: true });
  assert.deepStrictEqual(r.calls.writes, [{ requireAdmin2fa: false }]);
  assert.deepStrictEqual(r.calls.audits, [['u1', 'security.admin2fa', 'optional', '10.0.0.1']]);
  assert.strictEqual(r.calls.notices.length, 1);
  assert.match(r.calls.notices[0].title, /now optional/);
  assert.strictEqual(r.a.required(), false);
});

test('an admin without two-factor turns it off with the password alone', () => {
  const r = rig();
  assert.deepStrictEqual(off(r), { ok: true, required: false, changed: true });
  assert.deepStrictEqual(r.calls.totps, []);
});

test('turning on needs no password, and is audited as required', () => {
  const r = rig({ settings: { requireAdmin2fa: false } });
  assert.deepStrictEqual(r.a.setRequired({ actorId: 'u1', isAdmin: true, want: true, ip: '10.0.0.1' }), { ok: true, required: true, changed: true });
  assert.deepStrictEqual(r.calls.logins, []);
  assert.deepStrictEqual(r.calls.writes, [{ requireAdmin2fa: true }]);
  assert.deepStrictEqual(r.calls.audits, [['u1', 'security.admin2fa', 'required', '10.0.0.1']]);
  assert.match(r.calls.notices[0].title, /required for admins again/);
});

test('a failing notice never fails the call', async () => {
  assert.strictEqual(off(rig({ notify: () => { throw new Error('push down'); } })).ok, true);
  assert.strictEqual(off(rig({ notify: () => Promise.reject(new Error('push down')) })).ok, true);
  await new Promise(r => setImmediate(r));   // an unhandled rejection would fail the run
});

// ── source pins: server.js ──
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, a); const j = s.indexOf(b, i + a.length); return s.slice(i, j < 0 ? undefined : j); };

test('server: POST /api/settings can never change requireAdmin2fa', () => {
  const route = between(server, "pathname === '/api/settings' && req.method === 'POST'", 'hubSettings.updateSettings(patch)');
  assert.ok(route.includes("'requireAdmin2fa' in patch") && route.includes('delete patch.requireAdmin2fa'));
});

test('server: /api/security/admin-2fa is for a signed-in admin only, checked before setRequired', () => {
  const route = between(server, "pathname === '/api/security/admin-2fa' && req.method === 'POST'", "pathname === '/api/settings' && req.method === 'POST'");
  const gate = route.indexOf('if (!(');
  const call = route.indexOf('admin2fa.setRequired(');
  assert.ok(gate >= 0 && call > gate);
  const g = route.slice(gate, call);
  for (const t of ["req.hubIdentKind === 'user'", '!req.hubPendingTotp', '!req.hubToken', '!req.hubService', 'access.isAdmin(req.hubUser)', "error: 'admin_only'"]) assert.ok(g.includes(t), t);
});

test('server: totp/disable refuses admins while required, before the password; admins also give a code', () => {
  const route = between(server, "pathname === '/api/auth/totp/disable'", "pathname === '/api/auth/password'");
  const req2 = route.indexOf('admin2fa.required()');
  const login = route.indexOf('hubAuth.login(');
  const check = route.indexOf('hubAuth.totpCheck(');
  assert.ok(req2 > 0 && login > req2 && check > login);
  assert.ok(route.includes("code: 'admin_2fa_required'"));
  assert.ok(route.includes('adminAccount && u.totp && u.totp.enabled'));
  assert.ok(route.includes('const adminAccount = access.isAdmin(u);'), 'the role comes from the account read after the body arrived');
});

test('server: the users totp reset route refuses the caller\'s own id; /api/me and invite accept report the rule', () => {
  const route = between(server, '/totp\\/reset$/.test(pathname)', '/team$/.test(pathname)');
  const own = route.indexOf('String(id) === String(req.hubUser.id)');
  assert.ok(own > 0 && own < route.indexOf('hubAuth.totpDisable('));
  assert.ok(server.includes('out.admin2faRequired = admin2fa.required();'));
  assert.ok(server.includes("needsTotpEnrol: r.user.role === 'admin' && admin2fa.required()"));
});

test('server: opening the hub to the network still needs an admin with two-factor', () => {
  assert.ok(server.includes('hasSecuredAdmin: () => hubAuth.admins().some(u => u.totp && u.totp.enabled),'));
});
