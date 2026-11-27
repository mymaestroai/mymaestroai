'use strict';
// The command lockbox's settings: the per-agent record fields and their validation (lib/agents.js), the hub default's check
// (lib/lockbox/settings.js, used by POST /api/settings), the two admin-only routes, the audit line and the admin notice,
// and the source of the two pages. Runs on a throwaway install (test/helpers/isolated-install.js).
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Writable } = require('node:stream');
const { makeIsolatedInstall } = require('./helpers/isolated-install');

const ISO = makeIsolatedInstall('lockbox-settings-');
const INST = ISO.inst;
const AGENTS_FILE = path.join(INST, 'data', 'agents.json');
const agentsLib = require(path.join(INST, 'lib', 'agents.js'));
const ls = require(path.join(INST, 'lib', 'lockbox', 'settings.js'));
const lockbox = require(path.join(INST, 'lib', 'lockbox', 'index.js'));
const REAL = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(REAL, f), 'utf8');

const seed = (agents) => fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2));
const onDisk = (name) => JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')).find(a => a.name === name);
const listed = async (name) => (await agentsLib.getAgents(true)).find(a => a.name === name);
const base = (extra = {}) => ({ name: 'sam', model: 'claude-sdk/default', display: 'Sam', category: 'specialist', ...extra });
beforeEach(() => seed([base(), base({ name: 'agent-a', display: 'Agent A' })]));

// ── the agent record ──
test('the record shows inherit and an empty list by default', async () => {
  const a = await listed('sam');
  assert.strictEqual(a.lockbox, 'inherit');
  assert.deepStrictEqual(a.lockboxEnv, []);
});

test('a stored bad value reads as inherit, a stored bad list as empty', async () => {
  seed([base({ lockbox: 'strict', lockboxEnv: ['OK_NAME', '1bad', 5] })]);
  const a = await listed('sam');
  assert.strictEqual(a.lockbox, 'inherit');
  assert.deepStrictEqual(a.lockboxEnv, []);
});

test('inherit, off, watch and enforce are accepted and stored', async () => {
  for (const v of ['off', 'watch', 'enforce', 'inherit']) {
    assert.deepStrictEqual(await agentsLib.updateAgentField('sam', { lockbox: v }), { success: true }, v);
    assert.strictEqual(onDisk('sam').lockbox, v);
    assert.strictEqual((await listed('sam')).lockbox, v);
  }
});

test('any other value is refused with a clear error and nothing is stored', async () => {
  for (const v of ['container', 'ON', 'enforce ', 7, true, {}, ['watch']]) {
    const r = await agentsLib.updateAgentField('sam', { lockbox: v });
    assert.strictEqual(r.success, false, JSON.stringify(v));
    assert.match(r.error, /lockbox must be inherit, off, watch or enforce/);
  }
  assert.ok(!('lockbox' in onDisk('sam')));
});

test('lockboxEnv: valid names are stored (an array or comma text); bad names, non-strings and more than 32 are refused', async () => {
  assert.deepStrictEqual(await agentsLib.updateAgentField('sam', { lockboxEnv: ['NPM_TOKEN', '_x1', 'a_b'] }), { success: true });
  assert.deepStrictEqual(onDisk('sam').lockboxEnv, ['NPM_TOKEN', '_x1', 'a_b']);
  assert.deepStrictEqual(await agentsLib.updateAgentField('sam', { lockboxEnv: ' ONE, TWO ,ONE' }), { success: true });
  assert.deepStrictEqual(onDisk('sam').lockboxEnv, ['ONE', 'TWO']);
  for (const bad of [['1ABC'], ['A-B'], ['A B'], ['A=1'], [''.padEnd(65, 'A')], [5], [null], { A: 1 }, 7]) {
    const r = await agentsLib.updateAgentField('sam', { lockboxEnv: bad });
    assert.strictEqual(r.success, false, JSON.stringify(bad));
    assert.match(r.error, /lockboxEnv|environment variable/);
  }
  const many = Array.from({ length: 33 }, (_, i) => 'V' + i);
  assert.match((await agentsLib.updateAgentField('sam', { lockboxEnv: many })).error, /at most 32/);
  assert.strictEqual((await agentsLib.updateAgentField('sam', { lockboxEnv: many.slice(0, 32) })).success, true);
  assert.deepStrictEqual(onDisk('sam').lockboxEnv, many.slice(0, 32));
  assert.deepStrictEqual(await agentsLib.updateAgentField('sam', { lockboxEnv: [] }), { success: true });
  assert.deepStrictEqual(onDisk('sam').lockboxEnv, []);
});

test('the values and the name pattern match lib/lockbox/index.js', () => {
  assert.deepStrictEqual(ls.AGENT_VALUES, lockbox.AGENT_VALUES);
  assert.deepStrictEqual(ls.DEFAULT_VALUES, lockbox.MODES);
  assert.strictEqual(ls.ENV_NAME_RE.source, lockbox.ENV_NAME_RE.source);
  assert.strictEqual(ls.AGENT_NAME_RE.source, lockbox.NAME_RE.source);
});

// ── audit line and admin notice ──
test('a change writes one audit line and sends one admin notice, in plain words, with who', async () => {
  const audits = [], notices = [];
  const ctx = { userName: 'owner', userId: 'u_1', audit: (a, d) => audits.push([a, d]), notifyAdmins: (t) => { notices.push(t); return Promise.resolve(); } };
  await agentsLib.updateAgentField('sam', { lockbox: 'off' }, ctx);
  audits.length = 0; notices.length = 0;
  assert.deepStrictEqual(await agentsLib.updateAgentField('sam', { lockbox: 'enforce' }, ctx), { success: true });
  assert.deepStrictEqual(audits, [['agent.lockbox', 'Command lockbox for sam: off -> enforce (by owner)']]);
  assert.deepStrictEqual(notices, ['Command lockbox for sam: off -> enforce (by owner)']);
});

test('no change, no audit line and no notice; a refused value neither', async () => {
  const audits = [], notices = [];
  const ctx = { userName: 'owner', audit: (a, d) => audits.push([a, d]), notifyAdmins: (t) => notices.push(t) };
  await agentsLib.updateAgentField('sam', { lockbox: 'watch' }, ctx);
  audits.length = 0; notices.length = 0;
  await agentsLib.updateAgentField('sam', { lockbox: 'watch' }, ctx);
  await agentsLib.updateAgentField('sam', { lockbox: 'nonsense' }, ctx);
  assert.deepStrictEqual([audits, notices], [[], []]);
});

test('a change of the variables is audited and told the same way, names only', async () => {
  const audits = [], notices = [];
  const ctx = { userName: 'owner', audit: (a, d) => audits.push([a, d]), notifyAdmins: (t) => notices.push(t) };
  await agentsLib.updateAgentField('agent-a', { lockboxEnv: ['TOKEN_A', 'TOKEN_B'] }, ctx);
  assert.deepStrictEqual(audits, [['agent.lockbox.env', 'Command lockbox environment variables kept for agent-a: none -> TOKEN_A, TOKEN_B (by owner)']]);
  assert.deepStrictEqual(notices, [audits[0][1]]);
});

test('going back to the hub default is worded as the hub default', () => {
  assert.strictEqual(ls.describeAgentChange('sam', 'enforce', 'inherit', 'owner'), 'Command lockbox for sam: enforce -> hub default (by owner)');
});

test('a notifier that throws or rejects never fails the save', async () => {
  const bad = { notifyAdmins: () => { throw new Error('push down'); }, audit: () => { throw new Error('audit down'); } };
  assert.deepStrictEqual(await agentsLib.updateAgentField('sam', { lockbox: 'watch' }, bad), { success: true });
  const rej = { notifyAdmins: () => Promise.reject(new Error('later')) };
  assert.deepStrictEqual(await agentsLib.updateAgentField('sam', { lockbox: 'off' }, rej), { success: true });
});

// ── the hub default (POST /api/settings) ──
const admin = { id: 'u_admin', role: 'admin', name: 'owner' };
const member = { id: 'u_member', role: 'member', name: 'member-a' };
const sess = (user, extra = {}) => ({ hubIdentKind: 'user', hubUser: user, ...extra });

test('lockboxDefault: off, watch and enforce pass; inherit and anything else is refused with 400', () => {
  for (const v of ['off', 'watch', 'enforce']) {
    const patch = { lockboxDefault: v };
    const r = ls.checkDefaultPatch(patch, sess(admin), () => undefined);
    assert.strictEqual(r.ok, true, v);
    assert.strictEqual(patch.lockboxDefault, v);
  }
  for (const v of ['inherit', 'ON', '', null, 1, true, ['watch']]) {
    const r = ls.checkDefaultPatch({ lockboxDefault: v }, sess(admin), () => undefined);
    assert.deepStrictEqual([r.ok, r.status], [false, 400], JSON.stringify(v));
    assert.match(r.error, /lockboxDefault must be off, watch or enforce/);
  }
});

test('lockboxDefault: only a signed-in admin browser session (403 for a member, a token, the service, a half-signed-in session)', () => {
  const cases = [sess(member), sess(admin, { hubToken: 't' }), sess(admin, { hubService: true }), sess(admin, { hubPendingTotp: true }), { hubUser: admin }, { hubIdentKind: 'user' }];
  for (const req of cases) {
    const r = ls.checkDefaultPatch({ lockboxDefault: 'enforce' }, req, () => undefined);
    assert.deepStrictEqual([r.ok, r.status], [false, 403]);
  }
});

test('lockboxDefault: a patch without it passes untouched; a change yields the plain-words line, no change yields none', () => {
  assert.deepStrictEqual(ls.checkDefaultPatch({ other: 1 }, sess(member), () => undefined), { ok: true, change: null });
  assert.strictEqual(ls.checkDefaultPatch({ lockboxDefault: 'enforce' }, sess(admin), () => undefined).change, 'Command lockbox hub default: off -> enforce (by owner)');
  assert.strictEqual(ls.checkDefaultPatch({ lockboxDefault: 'watch' }, sess(admin), (k) => (k === 'lockboxDefault' ? 'enforce' : undefined)).change, 'Command lockbox hub default: enforce -> watch (by owner)');
  assert.strictEqual(ls.checkDefaultPatch({ lockboxDefault: 'watch' }, sess(admin), () => 'watch').change, null);
});

test('server.js wires the default check, its audit line, the notice, the PATCH guard and the routes', () => {
  const s = read('server.js');
  const a = read('lib/settings-apply.js');   // the guards and the notice builders moved from server.js into lib/settings-apply
  assert.match(a, /require\('\.\/lockbox\/settings'\)\.checkDefaultPatchFor\(patch, \{ ownSession: !!ctx\.ownSession/);
  assert.match(s, /require\('\.\/lib\/settings-apply'\)\.cleanSettingsPatch\(patch, \{ ownSession: access\.isAdminSession\(req\)/);
  assert.match(s, /hubAuth\.audit\(String\(req\.hubUser\.id\), 'settings\.lockboxDefault', lockboxChange/);
  assert.match(a, /\('lockbox' in body \|\| 'lockboxEnv' in body\) && !ctx\.ownSession\) return \{ ok: false, status: 403/);
  assert.match(s, /ownSession: require\('\.\/lib\/lockbox\/settings'\)\.isAdminSession\(req\)/);
  assert.match(a, /notifyAdmins: \(text\) => require\('\.\/push'\)\.getPush\(\)\.notify\(\{[^}]*\}, \{ adminsOnly: true, kind: 'security' \}\)/);
  assert.match(s, /pathname\.startsWith\('\/api\/lockbox\/'\)/);
});

// ── the routes ──
function fakeRes() {
  const chunks = [];
  const r = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  return Object.assign(r, { code: null, json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')) });
}
const jsonResponse = (res, code, data) => { res.code = code; res.end(JSON.stringify(data)); };
const HOST = { ok: true, landlockAbi: 8, seccomp: true, strace: '/usr/bin/strace', tiocsti: 0, reason: null };
function deps(over = {}) {
  const real = lockbox;
  const fake = {
    probe: () => HOST,
    statusFor: real.statusFor,
    readLog: (o) => real.readLog({ ...o, hubRoot: INST }),
  };
  return {
    jsonResponse, lockbox: fake,
    getAgents: async () => [
      { name: 'sam', model: 'claude-sdk/default', lockbox: 'enforce' },
      { name: 'agent-a', model: 'codex-cli/x', lockbox: 'inherit' },
      { name: 'agent-b', model: 'gpt-x' },
    ],
    getSetting: (k) => (k === 'lockboxDefault' ? 'watch' : undefined),
    sandboxedOf: (a) => a.name === 'agent-b',
    handsOf: (a) => (a.name === 'agent-a' ? 'client' : 'hub'),
    ...over,
  };
}
async function call(urlStr, req, d = deps()) {
  const res = fakeRes();
  const u = new URL(urlStr, 'http://x');
  const handled = await ls.handle(u.pathname, { method: 'GET', url: urlStr, ...req }, res, d);
  return { handled, res };
}

test('both routes refuse everyone but a signed-in admin session with 403', async () => {
  for (const url of ['/api/lockbox/status', '/api/lockbox/watch?agent=sam']) {
    for (const req of [sess(member), sess(admin, { hubToken: 't' }), sess(admin, { hubService: true }), sess(admin, { hubPendingTotp: true }), {}]) {
      const { handled, res } = await call(url, req);
      assert.strictEqual(handled, true);
      assert.strictEqual(res.code, 403, url);
      assert.deepStrictEqual(res.json(), { error: 'admin_only' });
    }
  }
});

test('GET /api/lockbox/status: host, default, each agent, and tiocsti as the probe gave it', async () => {
  const { res } = await call('/api/lockbox/status', sess(admin));
  assert.strictEqual(res.code, 200);
  const b = res.json();
  assert.strictEqual(b.ok, true);
  assert.deepStrictEqual(b.host, HOST);
  assert.strictEqual(b.tiocsti, 0);
  assert.strictEqual(b.default, 'watch');
  assert.deepStrictEqual(b.agents, [
    { name: 'sam', setting: 'enforce', mode: 'enforce', coverage: 'covered' },
    { name: 'agent-a', setting: 'inherit', mode: 'watch', coverage: 'codex-client' },
    { name: 'agent-b', setting: 'inherit', mode: 'watch', coverage: 'container' },
  ]);
});

test('status on a computer without Landlock: unavailable coverage and the reason', async () => {
  const d = deps(); d.lockbox.probe = () => ({ ok: false, reason: 'Landlock not available', tiocsti: 1 });
  const b = (await call('/api/lockbox/status', sess(admin), d)).res.json();
  assert.strictEqual(b.agents[0].coverage, 'unavailable');
  assert.strictEqual(b.host.reason, 'Landlock not available');
  assert.strictEqual(b.tiocsti, 1);
});

test('GET /api/lockbox/watch: the latest lines, newest first, filtered by agent, limited', async () => {
  for (let i = 0; i < 12; i++) lockbox.appendLog({ ts: new Date(Date.UTC(2026, 10, 17, 5, i)).toISOString(), agent: i % 2 ? 'sam' : 'agent-a', tool: 'Bash', cmd: 'echo ' + i, op: 'open', path: '/x/' + i, rule: 'write-outside' }, { hubRoot: INST });
  let r = await call('/api/lockbox/watch?agent=sam&limit=3', sess(admin));
  assert.strictEqual(r.res.code, 200);
  let e = r.res.json().entries;
  assert.strictEqual(e.length, 3);
  assert.ok(e.every(x => x.agent === 'sam'));
  assert.deepStrictEqual(e.map(x => x.path), ['/x/11', '/x/9', '/x/7']);
  r = await call('/api/lockbox/watch', sess(admin));
  assert.strictEqual(r.res.json().entries.length, 12);
  r = await call('/api/lockbox/watch?limit=9999', sess(admin));
  assert.strictEqual(r.res.code, 200);
});

test('GET /api/lockbox/watch: a bad agent name or limit is a 400; other methods and paths are not taken', async () => {
  for (const q of ['agent=Sam', 'agent=..%2Fx', 'agent=', 'agent=' + 'a'.repeat(65), 'agent=sam&limit=abc', 'agent=sam&limit=0']) {
    const { res } = await call('/api/lockbox/watch?' + q, sess(admin));
    assert.strictEqual(res.code, 400, q);
  }
  assert.strictEqual((await call('/api/lockbox/status', sess(admin, { method: 'POST' }))).res.code, 405);
  assert.strictEqual((await call('/api/lockbox/other', sess(admin))).handled, false);
});

test('the limit is capped at 500 when it reaches the reader', async () => {
  let seen;
  const d = deps(); d.lockbox.readLog = (o) => { seen = o; return []; };
  await call('/api/lockbox/watch?agent=sam&limit=9999', sess(admin), d);
  assert.deepStrictEqual(seen, { agent: 'sam', limit: 500 });
  await call('/api/lockbox/watch', sess(admin), d);
  assert.deepStrictEqual(seen, { agent: undefined, limit: 100 });
});

// The old agent page's lockbox tests ('agent page: ...') went with the page; the card's versions are in
// test/ui-agent-card-access.test.js (the lockbox: ..., recently blocked: ... and kept variables: ... tests).

test('settings page: the section, the select, the one line, the host state and the save', () => {
  const app = read('app.js');
  assert.match(app, /id="st-lb-section"><h4>Command lockbox<\/h4>/);
  assert.match(app, /Applies to every agent set to Hub default\. Off runs commands as they do today\./);
  assert.match(app, /selSb\('st-lb-default', \[\['off', 'Off'\], \['watch', 'Watch'\], \['enforce', 'Enforce'\]\], lbd\)/);
  assert.match(app, /body: JSON\.stringify\(\{ lockboxDefault: sel\.value \}\)/);
  assert.match(app, /Available: Landlock ABI \$\{/);
  assert.match(app, /Not available on this computer: \$\{/);
  assert.match(app, /fetch\('\/api\/lockbox\/status'/);
  const g = require('../lib/ui-settings-groups.js').GROUPS.find((x) => x.id === 'safety').sections.join(',');   // sandboxes then the lockbox, in People and safety
  assert.ok(g.indexOf('st-sb-section') < g.indexOf('st-lb-section') && g.includes('st-lb-section'));
  // the host reason comes from the status route, so it is written with textContent
  const a = app.indexOf('async function loadLockboxHost()'), b = app.indexOf('async function saveMemberPolicy(');
  assert.doesNotMatch(app.slice(a, b), /innerHTML/);
});

test('isAdminSession is lib/access\'s own check, re-exported (the owner-only routes and the lockbox use the same one)', () => {
  const access = require(path.join(INST, 'lib', 'access.js'));
  assert.strictEqual(ls.isAdminSession, access.isAdminSession);
  assert.strictEqual(ls.isAdminSession({ hubIdentKind: 'user', hubUser: { role: 'admin' } }), true);
  assert.strictEqual(ls.isAdminSession({ hubIdentKind: 'user', hubUser: { role: 'admin' }, hubToken: 't' }), false);
});

