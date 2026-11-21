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
  assert.match(s, /require\('\.\/lib\/lockbox\/settings'\)\.checkDefaultPatch\(patch, req,/);
  assert.match(s, /hubAuth\.audit\(String\(req\.hubUser\.id\), 'settings\.lockboxDefault', lockboxChange/);
  assert.match(s, /'lockbox' in body \|\| 'lockboxEnv' in body\) && !require\('\.\/lib\/lockbox\/settings'\)\.isAdminSession\(req\)\) return jsonResponse\(res, 403/);
  assert.match(s, /notifyAdmins: \(text\) => require\('\.\/lib\/push'\)\.getPush\(\)\.notify\(\{[^}]*\}, \{ adminsOnly: true, kind: 'security' \}\)/);
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

// ── the pages ──
function lockboxPart() {
  const html = read('agent-settings.html');
  const a = html.indexOf('// lockbox:begin'), b = html.indexOf('// lockbox:end');
  assert.ok(a > 0 && b > a, 'the marked part is there');
  const ctx = vm.createContext({});
  vm.runInContext(html.slice(a, b) + '\nthis.f = { lockboxLine, lockboxRuleWords, lockboxEffective, lockboxEnvNames, lockboxCap };', ctx);
  return ctx.f;
}

test('agent page: the line under the select for each mode, the lead, and the coverage that replaces it', () => {
  const f = lockboxPart();
  const host = { ok: true, landlockAbi: 8 };
  assert.strictEqual(f.lockboxLine('off', 'covered', host, false), 'Commands run as they do today.');
  assert.strictEqual(f.lockboxLine('watch', 'covered', host, false), 'Commands run as today; anything the lockbox would have blocked is listed below.');
  const enforce = 'Commands can write only in this agent\'s folders, can\'t read secret files, and can\'t use docker, systemd or other local services. Git over SSH and signed commits fail inside it.';
  assert.strictEqual(f.lockboxLine('enforce', 'covered', host, false), enforce);
  assert.strictEqual(f.lockboxLine('enforce', 'covered', host, true), enforce + ' The lead needs sudo for crontab, systemctl --user and docker.');
  assert.strictEqual(f.lockboxLine('watch', 'covered', host, true), 'Commands run as today; anything the lockbox would have blocked is listed below.');
  assert.strictEqual(f.lockboxLine('enforce', 'container', host, true), 'This agent\'s commands already run in its own container.');
  assert.strictEqual(f.lockboxLine('enforce', 'codex-client', host, false), 'This agent uses Codex\'s own tools, which the lockbox can\'t box; switch it to the hub\'s hands.');
  assert.strictEqual(f.lockboxLine('enforce', 'unavailable', { ok: false, reason: 'Landlock not available' }, false), 'Not available on this computer: Landlock not available.');
  assert.strictEqual(f.lockboxEffective('inherit', 'watch'), 'watch');
  assert.strictEqual(f.lockboxEffective('off', 'watch'), 'off');
  assert.strictEqual(f.lockboxCap('watch'), 'Watch');
});

test('agent page: each rule in words, unknown rules shown as they are, names split on commas', () => {
  const f = lockboxPart();
  assert.deepStrictEqual(['write-outside', 'secret-read', 'unix-socket', 'io_uring', 'sudo-unconfined', 'watch-unavailable'].map(f.lockboxRuleWords),
    ['write outside its folders', 'read a secret file', 'local socket', 'io_uring', 'ran with sudo, outside the box', 'watch not possible']);
  assert.strictEqual(f.lockboxRuleWords('toString'), 'toString');
  assert.deepStrictEqual(Array.from(f.lockboxEnvNames(' A, B ,,C ')), ['A', 'B', 'C']);
});

// The page's loader, run against a stand-in page: the status check's answer decides what the admin sees.
function lockboxPage() {
  const els = {};
  const el = () => ({ style: { display: '' }, textContent: '', value: '', disabled: false, checked: false, options: [{ textContent: '' }], children: [], appendChild(c) { this.children.push(c); }, querySelector: () => null, addEventListener() {} });
  for (const id of ['lockbox-block', 'lockbox-mode', 'lockbox-help', 'lockbox-env', 'lockbox-env-row', 'lockbox-log-title', 'lockbox-log']) els[id] = el();
  els['lockbox-block'].style.display = 'none';   // as the page starts
  return { els, el, document: { getElementById: (id) => els[id] || (els[id] = el()), createElement: () => el(), querySelector: () => null, querySelectorAll: () => [] } };
}
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new SyntaxError('not JSON'); return body; } });
const okStatus = { ok: true, host: { ok: true, landlockAbi: 8 }, default: 'off', agents: [{ name: 'sam', setting: 'inherit', mode: 'off', coverage: 'covered' }] };
const memberMe = { user: { id: 'u_sam', role: 'member' }, isAdmin: false };

/** routes: url prefix -> () => reply | throw. calls: every url asked for. */
function lockboxLoader(routes, page = lockboxPage(), extra = '') {
  const html = read('agent-settings.html');
  const a = html.indexOf('// lockbox:begin'), b = html.indexOf('async function saveLockbox()');
  assert.ok(a > 0 && b > a, 'the loader is there');
  const calls = [];
  const answer = async (url) => {
    calls.push(url);
    const key = Object.keys(routes).find(k => url.startsWith(k));
    if (!key) throw new Error('unexpected ' + url);
    return routes[key]();
  };
  const ctx = vm.createContext({
    agentName: 'sam', document: page.document, encodeURIComponent,
    fetch: answer,
    apiFetch: async (url) => (await answer(url)).json(),
  });
  vm.runInContext(html.slice(a, b) + extra + '\nthis.load = loadLockbox; this.alone = loadLockboxRow;', ctx);
  return { ctx, load: ctx.load, alone: ctx.alone, els: page.els, calls };
}
const watchOk = () => reply(200, { entries: [] });

test('agent page: an admin always sees the lockbox row; a failed check says why instead of hiding it', async () => {
  let t = lockboxLoader({ '/api/lockbox/status': () => reply(200, okStatus), '/api/lockbox/watch': watchOk });
  await t.load({ name: 'sam' });
  assert.strictEqual(t.els['lockbox-block'].style.display, '');
  assert.strictEqual(t.els['lockbox-mode'].disabled, false);
  assert.strictEqual(t.els['lockbox-help'].textContent, 'Commands run as they do today.');
  assert.ok(t.calls.some(u => u.startsWith('/api/lockbox/watch')));

  const cases = [
    [() => reply(500, { error: 'boom' }), null, /your Maestro answered 500 \(boom\)\. Reload this page\./],
    [() => reply(502, undefined), null, /your Maestro answered 502\. Reload this page\./],
    [() => { throw new Error('network down'); }, null, /no answer from your Maestro/],
    [() => reply(200, undefined), null, /answer could not be read/],
    [() => reply(200, {}), null, /answer could not be read/],
    [() => reply(401, { error: 'totp_required' }), null, /still needs its two-factor code/],
    [() => reply(401, { error: 'unauthorized' }), null, /you are signed out/],
    [() => reply(403, { error: 'forbidden_origin' }), null, /refused the request \(forbidden_origin\)/],
    [() => reply(403, undefined), null, /only an admin's own browser sign-in/],
    [() => reply(403, { error: 'admin_only' }), () => reply(200, { user: { id: 'u1' }, isAdmin: true }), /only an admin's own browser sign-in/],
    [() => reply(403, { error: 'admin_only' }), () => { throw new Error('down'); }, /only an admin's own browser sign-in/],
    [() => reply(403, { error: 'admin_only' }), () => reply(401, { error: 'unauthorized' }), /only an admin's own browser sign-in/],
    [() => reply(403, { error: 'admin_only' }), () => reply(500, undefined), /only an admin's own browser sign-in/],
    [() => reply(404, { error: 'not found' }), null, /older version without it\. A restart loads it\./],
  ];
  for (const [status, me, why] of cases) {
    const routes = { '/api/lockbox/status': status, '/api/lockbox/watch': watchOk };
    if (me) routes['/api/me'] = me;
    t = lockboxLoader(routes);
    await t.load({ name: 'sam' });
    const label = String(why);
    assert.strictEqual(t.els['lockbox-block'].style.display, '', label + ': the row shows');
    assert.strictEqual(t.els['lockbox-mode'].disabled, true, label + ': nothing to change');
    assert.match(t.els['lockbox-help'].textContent, why);
    assert.strictEqual(t.els['lockbox-env-row'].style.display, 'none');
    assert.strictEqual(t.els['lockbox-log-title'].style.display, 'none');
    assert.ok(!t.calls.some(u => u.startsWith('/api/lockbox/watch')), label + ': no log is asked for');
  }
});

test('agent page: a member gets no lockbox row; a later good check brings the control back', async () => {
  const page = lockboxPage();
  let t = lockboxLoader({ '/api/lockbox/status': () => reply(403, { error: 'admin_only' }), '/api/me': () => reply(200, memberMe) }, page);
  await t.load({ name: 'sam' });
  assert.strictEqual(t.els['lockbox-block'].style.display, 'none');
  assert.ok(t.calls.includes('/api/me'));
  // the same page: a failed check, then a good one
  t = lockboxLoader({ '/api/lockbox/status': () => reply(500, { error: 'boom' }) }, page);
  await t.load({ name: 'sam', lockbox: 'watch' });
  assert.strictEqual(page.els['lockbox-mode'].disabled, true);
  t = lockboxLoader({ '/api/lockbox/status': () => reply(200, okStatus), '/api/lockbox/watch': watchOk }, page);
  await t.load({ name: 'sam', lockbox: 'watch' });
  assert.strictEqual(page.els['lockbox-block'].style.display, '');
  assert.strictEqual(page.els['lockbox-mode'].disabled, false);
  assert.strictEqual(page.els['lockbox-log-title'].style.display, '');
  assert.strictEqual(page.els['lockbox-mode'].value, 'watch');
  assert.strictEqual(page.els['lockbox-env-row'].style.display, '');
});

test('agent page: an answer for an older load never overwrites a newer one', async () => {
  let release;
  const slow = new Promise(r => { release = r; });
  let n = 0;
  const t = lockboxLoader({
    '/api/lockbox/status': () => (++n === 1 ? slow.then(() => reply(500, { error: 'old' })) : reply(200, okStatus)),
    '/api/lockbox/watch': watchOk,
  });
  const first = t.load({ name: 'sam' });
  await t.load({ name: 'sam', lockbox: 'watch' });
  release();
  await first;
  assert.strictEqual(t.els['lockbox-mode'].disabled, false);
  assert.strictEqual(t.els['lockbox-mode'].value, 'watch');
  assert.doesNotMatch(t.els['lockbox-help'].textContent, /old/);
});

test('agent page: the lockbox row loads at page start on its own, never from the model list', () => {
  const html = read('agent-settings.html');
  const lm = html.slice(html.indexOf('  async function loadModels() {'), html.indexOf('  // Vendor from the model id prefix'));
  assert.ok(lm.length > 500, 'loadModels is there');
  assert.doesNotMatch(lm, /loadLockbox/, 'the model list never decides the lockbox row');
  const init = html.slice(html.indexOf('  // ── Init ──'));
  assert.match(init, /\n  loadLockboxRow\(\);/, 'the row is loaded at page start, not after await loadModels()');
  assert.ok(init.indexOf('loadLockboxRow();') < init.indexOf('loadFiles();'));
});

test('agent page: the row takes the setting from a good agent answer, and says so when there is none', async () => {
  const record = { name: 'sam', lockbox: 'enforce' };
  let t = lockboxLoader({ '/api/agents': () => reply(200, { agents: [record] }), '/api/lockbox/status': () => reply(200, okStatus), '/api/lockbox/watch': watchOk });
  await t.alone();
  assert.strictEqual(t.els['lockbox-block'].style.display, '');
  assert.strictEqual(t.els['lockbox-mode'].disabled, false);
  assert.strictEqual(t.els['lockbox-mode'].value, 'enforce');
  for (const agents of [() => reply(503, { error: 'unavailable' }), () => reply(502, undefined), () => reply(200, { agents: [] }), () => { throw new Error('down'); }]) {
    t = lockboxLoader({ '/api/agents': agents, '/api/lockbox/status': () => reply(200, okStatus), '/api/lockbox/watch': watchOk });
    await t.alone();
    assert.strictEqual(t.els['lockbox-block'].style.display, '');
    assert.strictEqual(t.els['lockbox-mode'].disabled, true, 'never a guessed setting');
    assert.match(t.els['lockbox-help'].textContent, /this agent's settings could not be loaded/);
    assert.ok(!t.calls.includes('/api/lockbox/status'));
  }
});

test('agent page: while the answers are on their way the row says it is checking, with nothing to change', async () => {
  let release;
  const t = lockboxLoader({ '/api/agents': () => new Promise(r => { release = r; }), '/api/lockbox/status': () => reply(200, okStatus), '/api/lockbox/watch': watchOk });
  const p = t.alone();
  await new Promise(r => setImmediate(r));
  assert.strictEqual(t.els['lockbox-block'].style.display, '');
  assert.strictEqual(t.els['lockbox-mode'].disabled, true);
  assert.strictEqual(t.els['lockbox-help'].textContent, 'Checking the command lockbox…');
  release(reply(200, { agents: [{ name: 'sam', lockbox: 'watch' }] }));
  await p;
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  assert.strictEqual(t.els['lockbox-mode'].disabled, false);
  assert.strictEqual(t.els['lockbox-mode'].value, 'watch');
});

test('agent page: a late agent answer, a late /api/me answer and a late log never undo a newer load', async () => {
  // the page-start lookup answers after a newer load finished
  let releaseAgents;
  let t = lockboxLoader({ '/api/agents': () => new Promise(r => { releaseAgents = r; }), '/api/lockbox/status': () => reply(200, okStatus), '/api/lockbox/watch': watchOk });
  const row = t.alone();
  await t.load({ name: 'sam', lockbox: 'watch' });
  releaseAgents(reply(503, { error: 'unavailable' }));
  await row;
  assert.strictEqual(t.els['lockbox-mode'].disabled, false);
  assert.strictEqual(t.els['lockbox-mode'].value, 'watch');
  // a member check that answers after a newer good load
  let releaseMe, n = 0;
  t = lockboxLoader({ '/api/lockbox/status': () => (++n === 1 ? reply(403, { error: 'admin_only' }) : reply(200, okStatus)),
    '/api/me': () => new Promise(r => { releaseMe = r; }), '/api/lockbox/watch': watchOk });
  const first = t.load({ name: 'sam' });
  for (let i = 0; i < 5 && !releaseMe; i++) await new Promise(r => setImmediate(r));
  await t.load({ name: 'sam', lockbox: 'watch' });
  releaseMe(reply(200, memberMe));
  await first;
  assert.strictEqual(t.els['lockbox-block'].style.display, '');
  assert.strictEqual(t.els['lockbox-mode'].disabled, false);
  // an older load's log that answers after a newer load's log
  let releaseLog, m = 0;
  t = lockboxLoader({ '/api/lockbox/status': () => reply(200, okStatus),
    '/api/lockbox/watch': () => (++m === 1 ? new Promise(r => { releaseLog = r; }) : reply(200, { entries: [] })) });
  await t.load({ name: 'sam' });
  await t.load({ name: 'sam' });
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  const before = t.els['lockbox-log'].children.length;
  releaseLog(reply(200, { entries: [] }));
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.strictEqual(t.els['lockbox-log'].children.length, before, 'the older log adds nothing');
});

test('agent page: the control, the log and the save are wired, nothing from the log goes in as HTML, and it wraps at 360 px', () => {
  const html = read('agent-settings.html');
  assert.match(html, /<select id="lockbox-mode" onchange="saveLockbox\(\)">/);
  for (const v of ['inherit', 'off', 'watch', 'enforce']) assert.match(html, new RegExp('<option value="' + v + '">'));
  assert.match(html, /\['saveLockbox', 'lockbox-status', byId\('lockbox-mode'\)\]/);
  assert.match(html, /\['saveLockboxEnv', 'lockbox-env-status', byId\('lockbox-env'\)\]/);
  assert.match(html, /SAVES_ON_CHANGE = new Set\([^)]*'saveLockbox', 'saveLockboxEnv'/);
  assert.match(html, /body: JSON\.stringify\(\{ lockbox: v \}\)/);
  assert.match(html, /body: JSON\.stringify\(\{ lockboxEnv: names \}\)/);
  assert.match(html, /\/api\/lockbox\/watch\?agent=' \+ encodeURIComponent\(agentName\) \+ '&limit=10/);
  assert.match(html, /Nothing yet\./);
  assert.match(html, /Recently blocked \(watch\)/);
  assert.match(html, /Environment variables kept/);
  const a = html.indexOf('async function loadLockbox('), b = html.indexOf('async function saveEffort()');
  const js = html.slice(a, b);
  assert.ok(js.length > 500);
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.match(js, /\.slice\(0, 80\)/);
  const css = html.slice(html.indexOf('/* Command lockbox'), html.indexOf('</style>'));
  assert.match(css, /flex-wrap: wrap/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /\.lb-row select \{[^}]*max-width: 100%/);
});

test('settings page: the section, the select, the one line, the host state and the save', () => {
  const app = read('app.js');
  assert.match(app, /id="st-lb-section"><h4>Command lockbox<\/h4>/);
  assert.match(app, /Applies to every agent set to Hub default\. Off runs commands as they do today\./);
  assert.match(app, /selSb\('st-lb-default', \[\['off', 'Off'\], \['watch', 'Watch'\], \['enforce', 'Enforce'\]\], lbd\)/);
  assert.match(app, /body: JSON\.stringify\(\{ lockboxDefault: sel\.value \}\)/);
  assert.match(app, /Available: Landlock ABI \$\{/);
  assert.match(app, /Not available on this computer: \$\{/);
  assert.match(app, /fetch\('\/api\/lockbox\/status'/);
  const g = app.match(/id: 'agents', title: '[^']+', sections: \[([^\]]*)\]/)[1];
  assert.ok(g.indexOf('st-sb-section') < g.indexOf('st-lb-section') && g.includes('st-lb-section'));
  // the host reason comes from the status route, so it is written with textContent
  const a = app.indexOf('async function loadLockboxHost()'), b = app.indexOf('async function saveMemberPolicy()');
  assert.doesNotMatch(app.slice(a, b), /innerHTML/);
});

test('isAdminSession is lib/access\'s own check, re-exported (the owner-only routes and the lockbox use the same one)', () => {
  const access = require(path.join(INST, 'lib', 'access.js'));
  assert.strictEqual(ls.isAdminSession, access.isAdminSession);
  assert.strictEqual(ls.isAdminSession({ hubIdentKind: 'user', hubUser: { role: 'admin' } }), true);
  assert.strictEqual(ls.isAdminSession({ hubIdentKind: 'user', hubUser: { role: 'admin' }, hubToken: 't' }), false);
});

