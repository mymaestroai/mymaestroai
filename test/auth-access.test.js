'use strict';
// Accounts, passwords, sessions, TOTP, invites, rate limit; route classification and agent access.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const authMod = require('../lib/auth');
const access = require('../lib/access');

function fresh(now) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-'));
  process.env.HUB_AUTH_DIR = dir;
  return { dir, auth: authMod.createAuth({ dataDir: dir, now: now || Date.now, log: () => {} }) };
}
const req = (cookie = '', extra = {}) => ({ headers: { cookie, 'user-agent': 'test', ...extra }, socket: { remoteAddress: '10.0.0.5' } });

test('passwords: scrypt hash verifies, wrong password fails, policy enforced', () => {
  const h = authMod.hashPassword('correct horse battery');
  assert.ok(h.startsWith('scrypt$'));
  assert.ok(authMod.verifyPassword('correct horse battery', h));
  assert.ok(!authMod.verifyPassword('wrong', h));
  assert.match(authMod.passwordPolicy('short'), /12 characters/);
  assert.strictEqual(authMod.passwordPolicy('a decent passphrase'), null);
});

test('TOTP: RFC 6238 test vector, window, replay protection, base32 round trip', () => {
  // RFC 6238 SHA-1 test secret "12345678901234567890" at T=59 -> 287082 (8 digits 94287082)
  const secret = authMod.base32Encode(Buffer.from('12345678901234567890'));
  assert.strictEqual(authMod.totpCode(secret, { now: 59 * 1000 }), '287082');
  assert.strictEqual(authMod.totpCode(secret, { now: 1111111109 * 1000 }), '081804');
  const now = 1111111109 * 1000;
  const code = authMod.totpCode(secret, { now });
  const counter = authMod.totpVerify(secret, code, { now });
  assert.ok(counter !== null);
  assert.strictEqual(authMod.totpVerify(secret, code, { now, lastCounter: counter }), null, 'same code cannot be replayed');
  assert.ok(authMod.totpVerify(secret, authMod.totpCode(secret, { now: now - 30000 }), { now }) !== null, 'previous step accepted');
  assert.strictEqual(authMod.totpVerify(secret, authMod.totpCode(secret, { now: now - 90000 }), { now }), null, 'three steps back rejected');
  assert.strictEqual(authMod.totpVerify(secret, '12345', { now }), null);
  assert.deepStrictEqual(authMod.base32Decode(authMod.base32Encode(Buffer.from('hello'))), Buffer.from('hello'));
  assert.match(authMod.otpauthUri(secret, 'owner@example.com'), /^otpauth:\/\/totp\/My%20Maestro%20AI:owner%40example\.com\?secret=/);
});

test('users: create, login, sessions, TOTP enrolment + verify + recovery, trusted device, invites, last-admin guard', () => {
  let t = 1_700_000_000_000;
  const { auth } = fresh(() => t);
  assert.strictEqual(auth.hasUsers(), false);
  assert.strictEqual(auth.createUser({ login: 'bad', role: 'admin', password: 'a decent passphrase' }).ok, false);
  const a = auth.createUser({ login: 'Owner@Example.com', name: 'Owner', role: 'admin', password: 'a decent passphrase' });
  assert.ok(a.ok); assert.strictEqual(a.user.login, 'owner@example.com');
  assert.strictEqual(auth.createUser({ login: 'owner@example.com', role: 'member', password: 'a decent passphrase' }).ok, false, 'duplicate login');
  assert.strictEqual(auth.login('owner@example.com', 'nope').ok, false);
  const l = auth.login('owner@example.com', 'a decent passphrase', { ip: '1.2.3.4' });
  assert.ok(l.ok); assert.strictEqual(l.needsTotp, false);
  // session
  const s = auth.createSession(l.user, { req: req(), totpOk: true });
  assert.match(s.cookie, /^hub_sid=.*HttpOnly/);
  assert.ok(!/Secure/.test(s.cookie), 'plain http request: no Secure flag');
  const id = auth.identify(req(`hub_sid=${s.token}`));
  assert.strictEqual(id.kind, 'user'); assert.strictEqual(id.user.id, l.user.id); assert.strictEqual(id.pendingTotp, false);
  assert.strictEqual(auth.identify(req('hub_sid=garbage')), null);
  // TOTP enrol
  const b = auth.totpBegin(l.user.id);
  assert.ok(b.ok && b.secret && b.uri.includes('otpauth://'));
  assert.strictEqual(auth.totpConfirm(l.user.id, '000000').ok, false);
  const c = auth.totpConfirm(l.user.id, authMod.totpCode(b.secret, { now: t }));
  assert.ok(c.ok); assert.strictEqual(c.recoveryCodes.length, 10);
  assert.strictEqual(auth.login('owner@example.com', 'a decent passphrase').needsTotp, true);
  // a new session owes a code until verified
  const s2 = auth.createSession(l.user, { req: req() });
  assert.strictEqual(auth.identify(req(`hub_sid=${s2.token}`)).pendingTotp, true);
  t += 60000;
  assert.strictEqual(auth.totpCheck(l.user.id, '123456').ok, false);
  assert.ok(auth.totpCheck(l.user.id, authMod.totpCode(b.secret, { now: t })).ok);
  auth.markTotpOk(auth.getSession(s2.token).id);
  assert.strictEqual(auth.identify(req(`hub_sid=${s2.token}`)).pendingTotp, false);
  // recovery code works once
  const rc = c.recoveryCodes[0];
  assert.ok(auth.totpCheck(l.user.id, rc).ok);
  assert.strictEqual(auth.totpCheck(l.user.id, rc).ok, false);
  // trusted device
  const tr = auth.trustDevice(l.user, req());
  assert.ok(auth.isTrusted(l.user, tr.token));
  t += 31 * 24 * 3600 * 1000;
  assert.ok(!auth.isTrusted(l.user, tr.token), 'trust expires after 30 days');
  assert.strictEqual(auth.identify(req(`hub_sid=${s.token}`)), null, 'session expired too');
  // invites
  const inv = auth.createInvite({ login: 'sam@example.com', name: 'Sam', role: 'member', by: l.user.id });
  assert.ok(inv.ok);
  assert.strictEqual(auth.getInvite(inv.token).login, 'sam@example.com');
  assert.strictEqual(auth.acceptInvite(inv.token, { password: 'short' }).ok, false);
  const acc = auth.acceptInvite(inv.token, { password: 'another good passphrase' });
  assert.ok(acc.ok); assert.strictEqual(acc.user.role, 'member');
  assert.strictEqual(auth.getInvite(inv.token), null, 'single use');
  assert.strictEqual(auth.listUsers().length, 2);
  // last admin guard
  assert.strictEqual(auth.updateUser(l.user.id, { role: 'member' }).ok, false);
  assert.strictEqual(auth.deleteUser(l.user.id).ok, false);
  assert.ok(auth.updateUser(acc.user.id, { disabled: true }).ok);
  assert.strictEqual(auth.login('sam@example.com', 'another good passphrase').ok, false, 'disabled users cannot log in');
  assert.ok(auth.auditRecent(5).length > 0);
});

test('login rate limit: ten failures lock the login for 15 minutes', () => {
  let t = 1_700_000_000_000;
  const { auth } = fresh(() => t);
  auth.createUser({ login: 'x@example.com', role: 'admin', password: 'a decent passphrase' });
  for (let i = 0; i < 10; i++) assert.strictEqual(auth.login('x@example.com', 'wrong').ok, false);
  assert.strictEqual(auth.login('x@example.com', 'a decent passphrase').locked, true);
  t += 16 * 60 * 1000;
  assert.ok(auth.login('x@example.com', 'a decent passphrase').ok);
});

test('service token identifies the hub itself only from loopback', () => {
  const { auth } = fresh();
  const h = { [authMod.SERVICE_HEADER]: authMod.SERVICE_TOKEN };
  assert.strictEqual(auth.identify({ headers: h, socket: { remoteAddress: '127.0.0.1' } }).kind, 'service');
  assert.strictEqual(auth.identify({ headers: h, socket: { remoteAddress: '10.0.0.9' } }), null);
  assert.strictEqual(auth.identify({ headers: { authorization: 'Basic x' }, socket: { remoteAddress: '10.0.0.9' } }, { legacyCheck: () => true }).kind, 'legacy');
});

test('route classification: public, session, agent-scoped (path and body), admin', () => {
  const c = (p, m) => access.classifyRoute(p, m);
  assert.strictEqual(c('/login').kind, 'public');
  assert.strictEqual(c('/api/auth/login', 'POST').kind, 'public');
  assert.strictEqual(c('/icons/hub-192.png').kind, 'public');
  assert.strictEqual(c('/api/me').kind, 'session');
  assert.strictEqual(c('/api/agents').kind, 'session');
  assert.strictEqual(c('/api/events').kind, 'session');
  assert.deepStrictEqual(c('/api/chat', 'POST'), { kind: 'agent', from: 'body' });
  assert.deepStrictEqual(c('/api/history/gp'), { kind: 'agent', from: 'path', agent: 'gp' });
  assert.deepStrictEqual(c('/api/agents/gp/files'), { kind: 'agent', from: 'path', agent: 'gp' });
  assert.deepStrictEqual(c('/api/agents/gp', 'PATCH'), { kind: 'agent', from: 'path', agent: 'gp' });
  assert.strictEqual(c('/api/settings').kind, 'admin');
  assert.strictEqual(c('/api/agents/create', 'POST').kind, 'admin');
  assert.strictEqual(c('/api/approvals').kind, 'admin');
  assert.strictEqual(c('/api/users').kind, 'admin');
  assert.deepStrictEqual(c('/tiger-team'), { kind: 'admin', page: true });
  assert.deepStrictEqual(c('/agent-settings.html'), { kind: 'admin', page: true });
  assert.deepStrictEqual(c('/some.css'), { kind: 'session', page: true });
});

test('agent access: members see only their own agents; admins see all and can filter by owner; peers stay within an owner', () => {
  const admin = { id: 'u_admin', role: 'admin' };
  const sam = { id: 'u_sam', role: 'member' };
  const agents = [
    { name: 'maestro' }, { name: 'haiku' },
    { name: 'gp', owner: 'u_admin' }, { name: 'labs', owner: 'u_admin' },
    { name: 'sam_doc', owner: 'u_sam' }, { name: 'sam_labs', owner: 'u_sam' },
    { name: 'counsel', owner: 'u_admin', sharedWith: ['u_sam'] }, { name: 'fable', sharedWith: ['u_sam'] },
  ];
  const virt = (n) => (n === 'tw-samdoc-1' ? { parent: 'sam_doc' } : null);
  assert.ok(access.canAccessAgent(admin, 'sam_doc', { agents }));
  assert.ok(access.canAccessAgent(sam, 'sam_doc', { agents }));
  assert.ok(!access.canAccessAgent(sam, 'gp', { agents }));
  assert.ok(!access.canAccessAgent(sam, 'maestro', { agents }));
  assert.ok(access.canAccessAgent(sam, 'tw-samdoc-1', { agents, resolveVirtual: virt }), 'temporary workers follow their parent');
  assert.ok(!access.canAccessAgent(null, 'gp', { agents }));
  assert.deepStrictEqual(access.visibleAgents(sam, agents).map(a => a.name), ['sam_doc', 'sam_labs', 'counsel', 'fable'], 'owned plus shared, including a shared infrastructure agent');
  assert.ok(access.canAccessAgent(sam, 'counsel', { agents }) && access.canAccessAgent(sam, 'fable', { agents }));
  assert.strictEqual(access.visibleAgents(admin, agents).length, 8);
  assert.deepStrictEqual(access.visibleAgents(admin, agents, { ownerFilter: 'u_sam' }).map(a => a.name), ['sam_doc', 'sam_labs']);
  assert.deepStrictEqual(access.visibleAgents(admin, agents, { ownerFilter: 'mine' }).map(a => a.name), ['maestro', 'haiku', 'gp', 'labs', 'counsel', 'fable']);
  assert.deepStrictEqual(access.visibleAgents(admin, agents, { ownerFilter: 'infra' }).map(a => a.name), ['maestro', 'haiku', 'fable']);
  assert.ok(!access.sameOwner('sam_doc', 'counsel', agents, { adminIds: new Set(['u_admin']) }), 'sharing is for the person, not for agent-to-agent consults');
  const adminIds = new Set(['u_admin']);
  assert.ok(access.sameOwner('sam_doc', 'sam_labs', agents, { adminIds }));
  assert.ok(!access.sameOwner('sam_doc', 'haiku', agents, { adminIds }), 'member agents cannot reach the infrastructure pool');
  assert.ok(!access.sameOwner('sam_doc', 'gp', agents, { adminIds }));
  assert.ok(access.sameOwner('gp', 'haiku', agents, { adminIds }), 'admin-owned agents may use the pool');
  assert.ok(access.sameOwner('maestro', 'gp', agents, { adminIds }), 'infrastructure may reach admin-owned agents');
  assert.ok(!access.sameOwner('maestro', 'sam_doc', agents, { adminIds }), 'but not a member\'s agents by consult');
  assert.ok(access.sameOwner('tw-samdoc-1', 'sam_labs', agents, { resolveVirtual: virt, adminIds }));
  assert.strictEqual(access.classifyRoute('/api/agents/create', 'POST').kind, 'admin');
  assert.strictEqual(access.classifyRoute('/api/agents/reload', 'POST').kind, 'admin');
  const oe = access.ownerEntries(agents, [{ id: 'u_admin', name: 'the owner', role: 'admin' }, { id: 'u_sam', name: 'Sam', role: 'member' }]);
  assert.strictEqual(oe.infraCount, 3);
  assert.deepStrictEqual(oe.owners.map(o => `${o.name}:${o.count}`), ['the owner:3', 'Sam:2']);
});
