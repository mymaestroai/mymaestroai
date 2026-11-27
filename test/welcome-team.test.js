'use strict';
// The starter team on the Welcome page: the three /api/welcome/team routes (lib/welcome-team, called by server.js), the
// access rule for them, the team box in welcome.html, `mymaestro team`, and the Help section. Runs on a throwaway install
// (test/helpers/isolated-install.js); nothing under the real data/ or workspaces/ is read or written.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeIsolatedInstall, REAL } = require('./helpers/isolated-install');

const ISO = makeIsolatedInstall('welcome-team-', { copy: ['templates/starter-team', 'scripts'] });
const INST = ISO.inst;
const AGENTS_FILE = path.join(INST, 'data', 'agents.json');
const LEDGER = path.join(INST, 'data', 'team.json');
const L = (p) => require(path.join(INST, 'lib', p));
const wt = L('welcome-team');
const st = L('starter-team');
const agentsLib = L('agents.js');
const access = L('access');

const AVAILABLE = ['claude-sdk/claude-opus-5-5', 'claude-sdk/claude-sonnet-5-5', 'claude-sdk/claude-haiku-5-5'];
const LEAD = 'claude-sdk/claude-opus-5-5';
const ROLE_NAMES = ['challenger', 'scout', 'builder', 'researcher'];
const deps = (over = {}) => ({ getAgents: (f) => agentsLib.getAgents(f), getAvailableModels: async () => AVAILABLE, providerSummary: () => ({ claude: true, chatgpt: true }), team: st, ...over });
const onDisk = () => JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
const seed = (agents) => fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2));
const maestro = { name: 'maestro', model: LEAD, display: 'Maestro', category: 'primary', lead: true };
const sam = { name: 'sam', model: 'claude-sdk/default', display: 'Sam', category: 'specialist' };
const quiet = () => {};

beforeEach(() => {
  seed([maestro]);
  try { fs.unlinkSync(LEDGER); } catch {}
  fs.rmSync(path.join(INST, 'workspaces'), { recursive: true, force: true });
  agentsLib.getAgents(true);
});
after(() => { try { fs.rmSync(path.dirname(INST), { recursive: true, force: true }); } catch {} });

test('GET plan: four entries from the ledger and the agents, the lead being the query value or else the lead agent\'s model', async () => {
  const r = await wt.plan({}, deps());
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.deepStrictEqual(r.body.plan.map(e => e.role), ROLE_NAMES);
  assert.ok(r.body.plan.every(e => e.action === 'create' && e.model), JSON.stringify(r.body.plan));
  assert.strictEqual(r.body.skippedAt, undefined);
  // the lead model reaches pickTeam: the lead given in the query is the one used, not the agent's
  const seen = [];
  const spy = { ...st, planTeam: (a) => { seen.push(a.lead); return st.planTeam(a); } };
  await wt.plan({}, deps({ team: spy }));
  await wt.plan({ lead: 'claude-sdk/claude-sonnet-5-5' }, deps({ team: spy }));
  assert.deepStrictEqual(seen, [LEAD, 'claude-sdk/claude-sonnet-5-5']);
  // no maestro: the first agent is the lead
  seed([sam]); agentsLib.getAgents(true);
  seen.length = 0; await wt.plan({}, deps({ team: spy }));
  assert.deepStrictEqual(seen, ['claude-sdk/default']);
});

test('POST creates the four on a Claude-subscription model list; a second POST creates nothing', async () => {
  const lines = [];
  const r = await wt.create({ lead: LEAD }, deps(), (l) => lines.push(l));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.deepStrictEqual(r.body.created.map(e => e.role), ROLE_NAMES);
  assert.deepStrictEqual(r.body.skipped, []);
  const names = onDisk().map(a => a.name);
  for (const n of ROLE_NAMES) assert.ok(names.includes(n), n);
  assert.strictEqual(lines.length, 1, 'one log line per create');
  assert.match(lines[0], /^\[team\] created challenger \(claude-sdk\/[^)]+\), scout \(/);
  const again = await wt.create({ lead: LEAD }, deps(), (l) => lines.push(l));
  assert.deepStrictEqual(again.body.created, []);
  assert.deepStrictEqual(again.body.skipped.map(e => e.reason), ['created before', 'created before', 'created before', 'created before']);
  assert.strictEqual(onDisk().length, 5, 'no agent was added twice');
  assert.match(lines[1], /^\[team\] created nothing$/);
  // the plan now says so, too
  const p = await wt.plan({}, deps());
  assert.ok(p.body.plan.every(e => e.action === 'skip' && e.reason === 'created before'));
});

test('a taken name is skipped and kept as it is; the others are created', async () => {
  seed([maestro, { ...sam, name: 'scout', display: 'My own scout' }]); agentsLib.getAgents(true);
  const r = await wt.create({ lead: LEAD }, deps(), quiet);
  assert.deepStrictEqual(r.body.created.map(e => e.role), ['challenger', 'builder', 'researcher']);
  assert.deepStrictEqual(r.body.skipped.map(e => [e.role, e.reason]), [['scout', 'name taken']]);
  assert.strictEqual(onDisk().find(a => a.name === 'scout').display, 'My own scout');
  assert.match(wt.logLine(r.body), /; skipped scout: name taken$/);
});

test('models: the page\'s list is validated (bad ids are dropped, not an error) and joined with the hub\'s own list', async () => {
  const good = ['claude-sdk/claude-opus-5-5', 'codex-cli/gpt-5.5', 'openrouter/vendor/model:free', 'local/qwen3.8-27b[q4]'];
  const bad = ['', 'nomodel', '/x', 'Upper/x', 'a b/c', 'x/', 'x/y z', 'x/' + 'a'.repeat(200), 42, null, {}, ['a/b']];
  assert.deepStrictEqual(wt.validModels([...good, ...bad, good[0]]), good, 'valid ones kept, once, in order');
  assert.deepStrictEqual(wt.validModels('claude-sdk/x'), []);
  assert.deepStrictEqual(wt.validModels(Array(301).fill('a/b')), [], 'more than 300 entries: all dropped');
  assert.strictEqual(wt.validModels(Array(300).fill('a/b')).length, 1);
  // union with the hub's list; a failing hub list counts as empty
  assert.deepStrictEqual(await wt.availableModels(['codex-cli/gpt-5.5', 'bad id'], deps({ getAvailableModels: async () => ['claude-sdk/claude-opus-5-5'] })), ['claude-sdk/claude-opus-5-5', 'codex-cli/gpt-5.5']);
  assert.deepStrictEqual(await wt.availableModels(AVAILABLE, deps({ getAvailableModels: async () => { throw new Error('still filling in'); } })), AVAILABLE);
  assert.deepStrictEqual(await wt.availableModels(undefined, deps({ getAvailableModels: async () => { throw new Error('x'); } })), []);
  // end to end: the hub's own list is empty, the page's models make the team possible
  const none = deps({ getAvailableModels: async () => [] });
  const r = await wt.create({ lead: LEAD, models: [...AVAILABLE, 'not a model'] }, none, quiet);
  assert.deepStrictEqual(r.body.created.map(e => e.role), ROLE_NAMES);
});

test('skip writes skippedAt (the plan reports it); an unreadable ledger answers 409 and is not overwritten', async () => {
  const r = await wt.skip(deps());
  assert.deepStrictEqual(r, { status: 200, body: { ok: true } });
  const led = st.readLedger(LEDGER);
  assert.ok(Date.parse(led.skippedAt), 'an ISO time');
  assert.strictEqual((await wt.plan({}, deps())).body.skippedAt, led.skippedAt);
  fs.writeFileSync(LEDGER, '{ not json');
  const bad = await wt.skip(deps());
  assert.strictEqual(bad.status, 409);
  assert.strictEqual(bad.body.ok, false);
  assert.match(bad.body.error, /can't be read/);
  assert.strictEqual(fs.readFileSync(LEDGER, 'utf8'), '{ not json', 'left as it was');
  const made = await wt.create({ lead: LEAD }, deps(), quiet);
  assert.deepStrictEqual(made.body.created, [], 'nothing is created while the ledger is unreadable');
});

test('the routes in server.js call these handlers, read the body like the neighbours, and sit before the other welcome routes', () => {
  const server = fs.readFileSync(path.join(REAL, 'server.js'), 'utf8');
  assert.match(server, /pathname === '\/api\/welcome\/team' && req\.method === 'GET'\) \{\n\s+const out = await require\('\.\/lib\/welcome-team'\)\.plan\(\{ lead: new URL\(req\.url, 'http:\/\/x'\)\.searchParams\.get\('lead'\) \|\| '' \}\)/);
  assert.match(server, /pathname === '\/api\/welcome\/team' && req\.method === 'POST'\) \{\n\s+const b = \(await authJson\(\)\) \|\| \{\};\n\s+const out = await require\('\.\/lib\/welcome-team'\)\.create\(b\)/);
  assert.match(server, /pathname === '\/api\/welcome\/team\/skip' && req\.method === 'POST'\) \{\n\s+const out = await require\('\.\/lib\/welcome-team'\)\.skip\(\)/);
});

test('member and signed-out requests are refused: the three routes are admin routes behind the gate', () => {
  for (const [p, m] of [['/api/welcome/team', 'GET'], ['/api/welcome/team', 'POST'], ['/api/welcome/team/skip', 'POST']]) {
    assert.deepStrictEqual(access.classifyRoute(p, m), { kind: 'admin' }, `${m} ${p}`);
  }
  assert.strictEqual(access.isAdmin({ id: 'u_member', role: 'member', name: 'Sam' }), false);
  assert.strictEqual(access.isAdmin(null), false);
  assert.strictEqual(access.isAdmin({ id: 'u_owner', role: 'admin', name: 'Owner' }), true);
  const server = fs.readFileSync(path.join(REAL, 'server.js'), 'utf8');
  const gate = server.indexOf("if (route.kind === 'admin' && !access.isAdmin(req.hubUser)) {");
  assert.ok(gate > 0 && server.indexOf("return jsonResponse(res, 403, { error: 'admin_only' });", gate) - gate < 300, 'a member is refused with 403');
  assert.match(server, /\(!req\.hubService && !req\.hubUser\) \|\| req\.hubPendingTotp\)[^]*?return jsonResponse\(res, 401/);
  assert.ok(!/api\/welcome\/team/.test(fs.readFileSync(path.join(REAL, 'lib', 'access.js'), 'utf8')), 'not listed as public anywhere');
});

// ── the team box on the Welcome page (the page's logic does not run in Node: source-level checks) ──
const welcome = fs.readFileSync(path.join(REAL, 'welcome.html'), 'utf8');
const boxCode = welcome.slice(welcome.indexOf('// <team-box>'), welcome.indexOf('// </team-box>'));

test('welcome.html: the team box has its heading, rows, tick box and skip link between the model hint and the start button', () => {
  assert.ok(boxCode.length > 500, 'the team-box code is marked');
  for (const id of ['team-box', 'team-rows', 'team-create', 'team-skip', 'team-result']) assert.ok(welcome.includes(`id="${id}"`), id);
  assert.match(welcome, /<input type="checkbox" id="team-create" checked>/, 'ticked by default');
  assert.match(welcome, /<h3>Your team<\/h3>/);
  assert.match(welcome, /works with a small team: a Challenger that checks important work, and three helpers on cheaper models for the volume\. You can rename, change or delete any of them later\./);
  assert.match(welcome, /Create this team when I start/);
  assert.match(welcome, /<button class="link" type="button" id="team-skip">Skip the team<\/button>/);
  const at = (s) => welcome.indexOf(s);
  assert.ok(at('id="m-change"') < at('id="team-box"') && at('id="team-box"') < at('id="hello"'));
  for (const job of ['Checks important work and finds what is wrong', 'Lookups, searches and summaries', 'Coding and multi-step work', 'Research and writing']) assert.ok(boxCode.includes(job), job);
  for (const s of ['billed per use', "'local'", "'subscription'", 'it is kept as it is', 'Already set up', 'An earlier setup of this agent stopped halfway: add it yourself if you want it', 'Nothing to set up here.']) assert.ok(boxCode.includes(s), s);
  assert.match(welcome, /\.team \.trow \.pay\.per-use \{ color: var\(--warning\)/, 'billed per use in the warning colour');
  // Review r1: the plan now comes from POST /api/welcome/team/plan with the offered models (the same list the create
  // sends); its behaviour (waiting at Start, a saved skip, a changed plan, a late plan) is tested in
  // test/welcome-team-page.test.js, which runs this code.
  assert.match(boxCode, /api\('POST', '\/api\/welcome\/team\/plan', body\)/);
  assert.match(boxCode, /\$\('m-model'\)\.addEventListener\('change', \(\) => \{ loadTeam\(\); \}\)/, 'refetched when the model changes');
  assert.match(welcome, /show\('s-meet', 3\);\n\s+loadTeam\(\)/);
  assert.match(boxCode, /\$\('team-opt'\)\.hidden = !any \|\| teamStarted/, 'no role to create: the tick box is hidden');
});

test('welcome.html: the box is built from text nodes only; the Change link is encoded; skip is called when unticked', () => {
  assert.ok(!/innerHTML/.test(boxCode), 'no innerHTML in the team box');
  assert.ok(!/insertAdjacentHTML|outerHTML|document\.write/.test(boxCode));
  assert.match(boxCode, /e\.textContent = text/);
  assert.match(boxCode, /a\.href = '\/#agent-card=' \+ encodeURIComponent\(e\.name\); a\.target = '_blank'/, 'the Change link opens the card, in a new tab so the welcome flow stays');
  assert.doesNotMatch(boxCode, /agent-settings\.html/);
  assert.match(boxCode, /if \(!\$\('team-create'\)\.checked\) \{\n\s+const r = await api\('POST', '\/api\/welcome\/team\/skip'\)/);
  assert.match(boxCode, /api\('POST', '\/api\/welcome\/team', body\)/);
  // Review r1: the create sends what was shown (expect) and the offered models.
  assert.match(boxCode, /const body = \{ expect: teamToCreate\(\)\.map\(e => \(\{ role: e\.role, model: e\.model \}\)\) \};\n\s+const ids = offeredModelIds\(\); if \(ids\) body\.models = ids;/);
  assert.match(boxCode, /for \(const g of offered\.values\(\)\) for \(const m of g\.models\)/);
  // the start button: after the lead's model is set, before the interview; a failure never stops it
  const hello = welcome.slice(welcome.indexOf("$('hello').addEventListener('click'"));
  assert.ok(hello.indexOf("/model`, { model }") < hello.indexOf('await setUpTeam()') && hello.indexOf('await setUpTeam()') < hello.indexOf("'/api/chat'"));
  assert.match(hello, /try \{ await setUpTeam\(\); \} catch \{/);
  assert.match(boxCode, /out\.textContent = 'The team could not be created just now/);
});

test('help.html: the "Your team" section sits under Agents after "Create an agent"', () => {
  const help = fs.readFileSync(path.join(REAL, 'help.html'), 'utf8');
  const at = (s) => help.indexOf(s);
  assert.ok(at('<h3>Create an agent</h3>') < at('<h3>Your team</h3>') && at('<h3>Your team</h3>') < at('<h3>Change an agent</h3>') && at('<h3>Change an agent</h3>') < at('id="models"'));
  const sec = help.slice(at('<h3>Your team</h3>'), at('<h3>Change an agent</h3>'));
  // Part 5: the Set up your team card sentence is part of the first paragraph, so the count stays 4.
  assert.strictEqual((sec.match(/<p>/g) || []).length, 4);
  assert.ok(sec.includes('shows a one-time Set up your team card; to see it again, open your Maestro with ?team=setup at the end of its address.'));
  for (const s of ['starter team', 'Challenger', 'Scout', 'Builder', 'Researcher', 'asks the Challenger to check important work', 'A starter you delete is not set up again', 'Full, Light or Off in Settings → Agents → Tuning (Team guidance)']) assert.ok(sec.includes(s), s);   // menu split (gear = what you set, ⋯ = what you do): was "in the More menu (Team guidance)"
  assert.doesNotMatch(welcome + help, /\uFE0F/u);
});

// ── mymaestro team: read-only status ──
const CLI = path.join(INST, 'scripts', 'hub-cli.js');
const runTeam = () => spawnSync(process.execPath, [CLI, 'team'], { encoding: 'utf8', env: { ...process.env, HOME: ISO.home, PORT: '18999' } });
const snapshot = (dir) => fs.readdirSync(dir, { recursive: true }).sort().map(f => { const p = path.join(dir, f); const s = fs.statSync(p); return `${f}:${s.isFile() ? fs.readFileSync(p, 'utf8') : 'dir'}`; });

test('mymaestro team prints the four roles from the data folder and writes nothing', () => {
  const data = path.join(INST, 'data');
  seed([maestro, { ...sam, name: 'builder', display: 'My builder' }, { name: 'challenger2', model: 'codex-cli/gpt-x', display: 'Reviewer' }, { name: 'challenger', model: 'codex-cli/gpt-x', display: 'Challenger' }]);
  fs.writeFileSync(LEDGER, JSON.stringify({ roles: { challenger: { name: 'challenger', status: 'created' }, scout: { name: 'scout', status: 'created' }, researcher: { name: 'researcher', status: 'reserved' } } }));
  fs.writeFileSync(path.join(data, 'welcome.json'), JSON.stringify({ startedAt: '2026-01-01T00:00:00Z' }));
  const before = snapshot(data);
  const r = runTeam();
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Challenger: created \(agent challenger, model codex-cli\/gpt-x\)/);
  assert.match(r.stdout, /Scout: set up earlier, since removed or renamed/);
  assert.match(r.stdout, /Builder: name taken by your own agent/);
  assert.match(r.stdout, /Researcher: stopped halfway \(interrupted\)/);
  // None of the four can still be set up by the hub (created, removed, taken, interrupted): no hint line (proof review).
  assert.doesNotMatch(r.stdout, /To create the missing ones|To add them/);
  assert.deepStrictEqual(snapshot(data), before, 'nothing in data/ was written, created or removed');
  // a finished setup, no ledger: "not set up" for all and the other closing line
  fs.unlinkSync(LEDGER); seed([maestro]);
  fs.writeFileSync(path.join(data, 'welcome.json'), JSON.stringify({ startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T01:00:00Z' }));
  const before2 = snapshot(data);
  const r2 = runTeam();
  assert.strictEqual(r2.status, 0, r2.stderr);
  for (const n of ['Challenger', 'Scout', 'Builder', 'Researcher']) assert.match(r2.stdout, new RegExp(`${n}: not set up`));
  // Part 5: a finished setup with roles missing points at the Set up your team card (/?team=setup), not at the lead agent.
  assert.match(r2.stdout, /To add them, open http:\/\/localhost:18999\/\?team=setup on this computer and choose Set up your team\./);
  assert.deepStrictEqual(snapshot(data), before2);
  assert.ok(!fs.existsSync(LEDGER), 'no ledger was made');
});

test('mymaestro team: an unreadable ledger is said so, nothing is written, and the help text lists the command', () => {
  fs.writeFileSync(LEDGER, '[]');
  const before = snapshot(path.join(INST, 'data'));
  const r = runTeam();
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /team ledger \(data\/team\.json\) could not be read, so nothing is created while it is unreadable/);
  assert.doesNotMatch(r.stdout, /Challenger:/);
  assert.deepStrictEqual(snapshot(path.join(INST, 'data')), before);
  const help = spawnSync(process.execPath, [CLI, 'help'], { encoding: 'utf8' }).stdout;
  assert.match(help, /mymaestro team {19}the starter team/);
  // the help is a slice of the comment block at the top of hub-cli.js; it must still end with "version", not the comment's closing line
  assert.ok(help.trimEnd().endsWith('mymaestro version'), help.slice(-80));
  assert.ok(!help.includes('*/'));
});

// Review (own): a create always uses the lead agent's stored model, never one the request names; a preview takes only a
// model-shaped id.
test('POST uses the lead agent\'s own model, whatever the body says; GET ignores a lead that is not a model id', async () => {
  const seen = [];
  const spy = { ...st, createTeam: async (a) => { seen.push(a.lead); return { created: [], skipped: [] }; }, planTeam: (a) => { seen.push(a.lead); return st.planTeam(a); } };
  await wt.create({ lead: 'openai/gpt-6' }, deps({ team: spy }), quiet);
  await wt.plan({ lead: '<b>not a model</b>' }, deps({ team: spy }));
  assert.deepStrictEqual(seen, [LEAD, LEAD]);
});

// Review r1 (GPT-6 BLOCK 1, Sentinel follow-up): the create carries what the page showed; a plan that differs now creates
// nothing (409 with the new plan); page-reported models count only for providers this hub has connected.
test('r1: a create whose shown plan no longer matches creates nothing and returns the new plan', async () => {
  const shown = (await wt.plan({}, deps())).body.plan.filter(e => e.action === 'create').map(e => ({ role: e.role, model: e.model }));
  const stale = shown.map(x => (x.role === 'scout' ? { ...x, model: 'claude-sdk/claude-haiku-4-5' } : x));
  const r = await wt.create({ expect: stale }, deps(), quiet);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.changed, true);
  assert.deepStrictEqual(r.body.plan.map(e => e.role), ROLE_NAMES);
  assert.ok(!onDisk().some(a => ROLE_NAMES.includes(a.name)), 'nothing created');
  assert.ok(!fs.existsSync(LEDGER) || Object.keys(st.readLedger(LEDGER).roles).length === 0);
  const ok = await wt.create({ expect: shown }, deps(), quiet);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.created.length, 4);
});
test('r1: page-reported models count only for providers the hub has connected; the plan route takes them too', async () => {
  const d = deps({ getAvailableModels: async () => [], providerSummary: () => ({ claude: true, chatgpt: false, openai: false, local: false }) });
  const got = await wt.availableModels(['claude-sdk/claude-haiku-5-5', 'openai/gpt-6', 'codex-cli/gpt-6', 'lmstudio/qwen-3'], d);
  assert.deepStrictEqual(got, ['claude-sdk/claude-haiku-5-5']);
  assert.deepStrictEqual(wt.connectedPrefixes({ chatgpt: true, openrouter: true, local: true }), ['codex-cli', 'openrouter', 'local', 'lmstudio', 'ollama', 'omlx', 'ninfer']);
  const p = await wt.plan({ models: ['claude-sdk/claude-haiku-5-5', 'openai/gpt-6'] }, d);
  assert.ok(p.body.plan.every(e => !String(e.model || '').startsWith('openai/')));
  const src = fs.readFileSync(path.join(REAL, 'server.js'), 'utf8');
  assert.match(src, /pathname === '\/api\/welcome\/team\/plan' && req\.method === 'POST'/);
  assert.deepStrictEqual(access.classifyRoute('/api/welcome/team/plan', 'POST'), { kind: 'admin' });
});
