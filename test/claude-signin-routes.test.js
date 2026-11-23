'use strict';
// The Claude sign-in routes (lib/claude-signin-routes + server.js + lib/access.js), the health item for a signed-out client,
// the setup-checklist words and the lead's help text. No real `claude` program: the engine is given a fake spawn. The lib is
// loaded from a throwaway install (the suite's data guard); temp folders are removed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('claude-signin-routes-');
const L = (n) => require(path.join(ISO.inst, 'lib', n));
const access = L('access');
const R = L('claude-signin-routes');
const S = L('claude-signin');
const { createSystemHealth } = L('system-health');
const { createReadiness } = L('readiness');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'claude-signin-routes-t-')));
test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); fs.rmSync(ISO.root, { recursive: true, force: true }); });
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// ── who is asking ──
const ADMIN = { id: 'a1', login: 'owner-login', name: 'Owner Display', role: 'admin' };
const MEMBER = { id: 'm1', login: 'sam-login', name: 'Sam', role: 'member' };
const asks = {
  admin: { hubIdentKind: 'user', hubUser: ADMIN },
  member: { hubIdentKind: 'user', hubUser: MEMBER },
  token: { hubIdentKind: 'user', hubUser: ADMIN, hubToken: { id: 't1' } },
  service: { hubIdentKind: 'service', hubService: true },
  pending: { hubIdentKind: 'user', hubUser: ADMIN, hubPendingTotp: true },
  nobody: {},
};
const AUTH = { admins: () => [
  { id: 'a2', login: 'later-login@example.com', name: 'Second Admin', createdAt: '2026-03-01T00:00:00Z' },
  { id: 'a1', login: 'owner-login@example.com', name: 'Owner Display', createdAt: '2026-01-01T00:00:00Z' },
] };

// A fake client: a child whose output the test drives; what is written to its input is recorded.
function fakeEngine() {
  const kids = [];
  const spawn = () => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    c.stdin = Object.assign(new EventEmitter(), { written: [], write(s) { this.written.push(String(s)); } });
    c.killed = false; c.kill = () => { c.killed = true; };
    kids.push(c);
    return c;
  };
  const si = S.createSignIn({
    spawn, env: () => ({}), findClient: () => ({ bin: '/nonexistent/fake-claude', source: 'test' }), installClient: async () => false,
    authStatus: async () => ({ loggedIn: true }), verify: async () => ({ ok: true, state: 'ready' }),
  });
  return { si, kids };
}

function setup() {
  const { si, kids } = fakeEngine();
  const done = [];
  const readBodies = [];
  const call = (who, method, pathname, body) => R.handle({
    method, pathname, req: asks[who], isAdminSession: access.isAdminSession,
    readBody: async () => { readBodies.push(true); return typeof body === 'string' ? body : JSON.stringify(body || {}); },
    auth: AUTH, signIn: () => si, words: S.WORDS, hasSignIn: () => false, onDone: () => done.push(1),
  });
  return { si, kids, done, call, readBodies };
}
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };

const POSTS = ['/api/claude-signin/start', '/api/claude-signin/code', '/api/claude-signin/cancel'];

test('every POST refuses with 403 for no session, a member, a token, the service identity and a half-signed-in admin', async () => {
  for (const who of ['nobody', 'member', 'token', 'service', 'pending']) {
    for (const p of POSTS) {
      const t = setup();
      const r = await t.call(who, 'POST', p, { code: 'ABCDEFGH12345' });
      assert.strictEqual(r.status, 403, `${who} ${p}`);
      assert.strictEqual(r.body.ok, false);
      assert.strictEqual(r.body.error, 'Sign in with an admin account in your browser to do this.');
      assert.strictEqual(t.si.state().state, 'idle', `${who} ${p} changed nothing`);
      assert.strictEqual(t.kids.length, 0, `${who} ${p} started no client`);
      assert.strictEqual(t.readBodies.length, 0, `${who} ${p}: the body is not even read`);
    }
  }
});

test('an admin session starts, submits a code, and cancels; the code never comes back in a response', async () => {
  const t = setup();
  const CODE = 'SECRET-CODE-abc123XYZ';
  const logged = [];
  const orig = {};
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) { orig[k] = console[k]; console[k] = (...a) => logged.push(a.map(String).join(' ')); }
  const writes = [];
  const ow = process.stdout.write, ew = process.stderr.write;
  process.stdout.write = (c, ...a) => { writes.push(String(c)); return true; };
  process.stderr.write = (c, ...a) => { writes.push(String(c)); return true; };
  const bodies = [];
  try {
    let r = await t.call('admin', 'POST', '/api/claude-signin/start'); bodies.push(r.body);
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.ok, true);
    await until(() => t.kids.length === 1);
    t.kids[0].stdout.emit('data', 'Opening browser. If it does not open, visit: https://claude.ai/oauth/authorize?x=1 \n');
    await until(() => t.si.state().state === 'link');
    r = await t.call('admin', 'POST', '/api/claude-signin/code', { code: 'short' }); bodies.push(r.body);
    assert.deepStrictEqual([r.body.ok, r.body.reason], [false, 'format']);
    r = await t.call('admin', 'POST', '/api/claude-signin/code', { code: CODE }); bodies.push(r.body);
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.ok, true);
    assert.deepStrictEqual(t.kids[0].stdin.written, [CODE + '\n'], 'the code went to the client and nowhere else');
    r = await t.call('admin', 'POST', '/api/claude-signin/code', '{not json'); bodies.push(r.body);
    assert.strictEqual(r.status, 400);
    t.kids[0].stdout.emit('data', 'Login successful.\n');
    await until(() => t.si.state().state === 'done');
    r = await t.call('admin', 'GET', '/api/claude-signin'); bodies.push(r.body);
    assert.strictEqual(r.body.attempt.state, 'done');
    r = await t.call('admin', 'POST', '/api/claude-signin/cancel'); bodies.push(r.body);
    assert.strictEqual(r.body.ok, true);
  } finally {
    for (const k of Object.keys(orig)) console[k] = orig[k];
    process.stdout.write = ow; process.stderr.write = ew;
  }
  assert.ok(!JSON.stringify(bodies).includes(CODE), 'the code is not in any response');
  assert.ok(!logged.join('\n').includes(CODE) && !writes.join('\n').includes(CODE), 'the code is not in console or stream output');
  assert.ok(!logged.join('\n').includes('oauth') && !writes.join('\n').includes('oauth'), 'the link is not logged');
});

test('a code body over 8 KB is refused before it reaches the client', async () => {
  const t = setup();
  await t.call('admin', 'POST', '/api/claude-signin/start');
  await until(() => t.kids.length === 1);
  t.kids[0].stdout.emit('data', 'visit: https://claude.ai/oauth/authorize?x=1 \n');
  await until(() => t.si.state().state === 'link');
  const r = await t.call('admin', 'POST', '/api/claude-signin/code', JSON.stringify({ code: 'A'.repeat(9000) }));
  assert.strictEqual(r.status, 413);
  assert.deepStrictEqual(t.kids[0].stdin.written, []);
});

test('the hub\'s own view is refreshed once when an attempt reaches done', async () => {
  const t = setup();
  await t.call('admin', 'POST', '/api/claude-signin/start');
  await until(() => t.kids.length === 1);
  t.kids[0].stdout.emit('data', 'Login successful.\n');
  await until(() => t.si.state().state === 'done');
  await t.call('admin', 'GET', '/api/claude-signin');
  await t.call('admin', 'GET', '/api/claude-signin');
  assert.strictEqual(t.done.length, 1);
});

test('GET: a member gets canSignIn false, the admin\'s display name (never a login), no attempt, no link', async () => {
  const t = setup();
  await t.call('admin', 'POST', '/api/claude-signin/start');
  await until(() => t.kids.length === 1);
  t.kids[0].stdout.emit('data', 'visit: https://claude.ai/oauth/authorize?x=1 \n');
  await until(() => t.si.state().state === 'link');
  const r = await t.call('member', 'GET', '/api/claude-signin');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.canSignIn, false);
  assert.strictEqual(r.body.adminName, 'Owner Display', 'the earliest admin, by display name');
  assert.strictEqual(r.body.signedIn, null);
  assert.ok(!('attempt' in r.body));
  assert.deepStrictEqual(r.body.words, S.WORDS);
  const text = JSON.stringify(r.body);
  assert.ok(!/oauth|owner-login|later-login/.test(text) && !/"link"/.test(text) && !text.includes('claude.ai/oauth'), 'no link and no login in a member\'s answer');
  const a = await t.call('admin', 'GET', '/api/claude-signin');
  assert.strictEqual(a.body.canSignIn, true);
  assert.strictEqual(a.body.adminName, null);
  assert.strictEqual(a.body.attempt.state, 'link');
  assert.match(a.body.attempt.link, /^https:\/\/claude\.ai\/oauth/);
  // a token or the service identity is not an admin session: they read like a member
  for (const who of ['token', 'service']) assert.strictEqual((await t.call(who, 'GET', '/api/claude-signin')).body.canSignIn, false, who);
});

test('signedIn is true or null, never false', async () => {
  const { si } = fakeEngine();
  const r = await R.handle({ method: 'GET', pathname: '/api/claude-signin', req: asks.member, isAdminSession: access.isAdminSession, auth: AUTH, signIn: () => si, words: S.WORDS, hasSignIn: () => true });
  assert.strictEqual(r.body.signedIn, true);
});

test('wiring: GET is a session route, the POSTs are admin routes, and server.js calls the handler', () => {
  assert.deepStrictEqual(access.classifyRoute('/api/claude-signin', 'GET'), { kind: 'session' });
  for (const p of POSTS) assert.deepStrictEqual(access.classifyRoute(p, 'POST'), { kind: 'admin' }, p);
  const src = read('server.js');
  assert.ok(src.includes("require('./lib/claude-signin-routes').handle"));
  assert.ok(src.includes("pathname.startsWith('/api/claude-signin/')"));
  assert.ok(read('lib/claude-signin-routes.js').includes("if (post && !admin) return { status: 403"));
});

// ── health ──
const HOUR = 3600000, T0 = Date.parse('2026-11-17T12:00:00Z');
let seq = 0;
function health({ sc, signIns } = {}) {
  const dir = path.join(TMP, `h${++seq}`); fs.mkdirSync(dir, { recursive: true });
  const o = {
    probes: {}, stateFile: path.join(dir, 'system-health.json'), now: () => T0, zone: () => 'America/New_York', settings: () => undefined, limitMs: 1000,
    codeChanges: async () => ({ ok: true, files: [] }), selfCheckState: () => sc, notify: async () => ({ sent: 1 }),
  };
  if (signIns) o.signIns = signIns;
  return createSystemHealth(o);
}
const run = (id, classes) => ({ id, finishedAt: new Date(T0).toISOString(), classes: Object.fromEntries(Object.entries(classes).map(([k, note]) => [k, { status: 'error', threw: true, note: `Couldn't run: ${note}`, actions: {} }])) });
const EXPIRED = 'Failed to authenticate: this login reached its time limit and cannot be renewed. Please run /login.';

test('health: a sign-in failure in the self-check is the signed-out item with the action, not the self-check item', async () => {
  const h = health({ sc: run('sc-1', { lead: EXPIRED }) });
  await h.run({ trigger: 'manual', full: false });
  const b = h.bannerItems();
  const it = b.find(i => i.id === 'health-claude-signedout');
  assert.ok(it, 'the banner shows it');
  assert.strictEqual(it.action, 'claude-signin');
  assert.strictEqual(it.level, 'critical');
  assert.strictEqual(it.title, "Claude is signed out on this computer: agents on Claude can't answer");
  assert.ok(it.detail.startsWith('Failed to authenticate') && it.detail.length <= 200);
  assert.match(it.fix, /Sign in again.*`mymaestro connect claude`.*No restart is needed\./);
  assert.ok(!b.some(i => /Agents couldn't run in the self-check/.test(i.title)));
  assert.ok(h.readinessItems().some(i => i.id === 'health-claude-signedout' && i.action === 'claude-signin'));
  assert.strictEqual(h.view().items.find(i => i.id === 'health-claude-signedout').action, 'claude-signin');
});

test('health: an ordinary failure still gives the self-check item; mixed failures keep it for the other class', async () => {
  let h = health({ sc: run('sc-2', { lead: 'model unreachable' }) });
  await h.run({ trigger: 'manual', full: false });
  assert.strictEqual(h.bannerItems().find(i => i.id === 'health-selfcheck').title, "Agents couldn't run in the self-check: model unreachable");
  assert.ok(!h.bannerItems().some(i => i.id === 'health-claude-signedout'));
  h = health({ sc: run('sc-3', { lead: EXPIRED, host: 'disk full' }) });
  await h.run({ trigger: 'manual', full: false });
  const b = h.bannerItems();
  assert.ok(b.some(i => i.id === 'health-claude-signedout'));
  const sc = b.find(i => i.id === 'health-selfcheck');
  assert.strictEqual(sc.title, "Agents couldn't run in the self-check: disk full");
  assert.ok(!/time limit/.test(sc.detail), 'the sign-in class is not repeated in the self-check item');
});

test('health: the sign-in probe saying Claude is signed out also puts the banner item up, once', async () => {
  const h = health({ sc: run('sc-4', { lead: EXPIRED }), signIns: async () => [{ id: 'claude', name: 'Claude', agents: 2, signedIn: false }] });
  await h.run({ trigger: 'manual', full: false });
  assert.strictEqual(h.bannerItems().filter(i => i.id === 'health-claude-signedout').length, 1);
  assert.ok(!h.bannerItems().some(i => i.id === 'health-signin-claude'), 'the old item stays out of banners');
  assert.ok(h.view().items.some(i => i.id === 'health-signin-claude'), 'but it is still kept');
  const only = health({ sc: null, signIns: async () => [{ id: 'claude', name: 'Claude', agents: 2, signedIn: false }] });
  await only.run({ trigger: 'manual', full: false });
  assert.ok(only.bannerItems().some(i => i.id === 'health-claude-signedout' && i.action === 'claude-signin'));
  const ok = health({ sc: null, signIns: async () => [{ id: 'claude', name: 'Claude', agents: 2, signedIn: true }] });
  await ok.run({ trigger: 'manual', full: false });
  assert.ok(!ok.bannerItems().some(i => i.id === 'health-claude-signedout'));
});

// ── readiness and the lead's help ──
test('readiness: the claude-signin fix names the button and `mymaestro connect claude`, and does not say to restart', async () => {
  for (const platform of ['darwin', 'linux']) {
    const r = await createReadiness({
      platform, hasUsers: () => true, setupNeeded: () => false, hasSdkCredentials: () => false,
      agents: async () => [{ name: 'maestro', model: 'claude-sdk/claude-sonnet-5-5' }],
      sandboxStatus: async () => ({ docker: true, imageReady: true }), fetchStatus: async () => ({ renderer: true, pdftotext: true }),
      searchChain: () => ['brave'], supervisor: () => 'none', exposed: () => false,
    }).check();
    const it = r.items.find(i => i.id === 'claude-signin');
    assert.ok(it, platform);
    assert.ok(!/restart the hub/i.test(it.fix), platform);
    assert.match(it.fix, /Sign in again in Settings → Status/);
    assert.match(it.fix, /`mymaestro connect claude`/);
    assert.match(it.fix, /No restart is needed\./);
    assert.match(it.fix, platform === 'darwin' ? /in Terminal on this Mac/ : /as the user that runs your Maestro/);
  }
});

test('the lead\'s setup help tells how to sign Claude in again', () => {
  const t = read('templates/workspaces/maestro/SETUP-INTERVIEW.md');
  assert.match(t, /Claude is signed out/);
  assert.match(t, /Sign in again/);
  assert.match(t, /`mymaestro connect claude`/);
  assert.match(t, /Members ask an admin/);
  assert.match(t, /No restart is needed/);
});
