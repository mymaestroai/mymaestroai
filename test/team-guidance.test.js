'use strict';
// Team guidance: the "how to run a team" section of an agent's prompt (lib/team-guidance.js), its place in the three model
// paths (lib/sdk-chat.js), the roster and ninfer text in lib/worker-policy.js, the two agent fields (lib/agents.js
// updateAgentField), the one-time migration, and the admin-only route. Runs on throwaway installs and temp folders
// (test/helpers/isolated-install.js): nothing under the real data/ is read or written.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { makeIsolatedInstall } = require('./helpers/isolated-install');

const ISO = makeIsolatedInstall('team-guidance-');
const INST = ISO.inst;
const AGENTS_FILE = path.join(INST, 'data', 'agents.json');
const L = (p) => require(path.join(INST, 'lib', p));
const tg = L('team-guidance');
const wp = L('worker-policy');
const access = L('access.js');
const agentsLib = L('agents.js');
const REAL = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(REAL, f), 'utf8');

const seed = (agents) => fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2));
const onDisk = (name) => JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')).find(a => a.name === name);
const base = (extra = {}) => ({ name: 'sam', model: 'claude-sdk/default', display: 'Sam', category: 'specialist', ...extra });

const temps = [];
const tempDir = () => { const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'team-guidance-mig-')); temps.push(d); return d; };
after(() => { for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

// ── textFor ──
test('a lead gets the full text, another agent the core text without the offer bullet', () => {
  assert.strictEqual(tg.textFor({ agent: { name: 'maestro', model: 'claude-sdk/default' }, isLead: true, level: 'full' }), tg.FULL_TEXT);
  const core = tg.textFor({ agent: { name: 'sam', model: 'claude-sdk/default' }, isLead: false, level: 'full' });
  assert.strictEqual(core, tg.CORE_TEXT);
  assert.doesNotMatch(core, /splits into parts/);
  assert.match(tg.FULL_TEXT, /splits into parts/);
  assert.match(core, /^\n\n## RUNNING A TEAM\nWhen a job is bigger than a few tool calls, work as a lead:/);
  assert.match(tg.FULL_TEXT, /^\n\n## RUNNING A TEAM\nYou lead; your workers do the volume\./);
  // the shared bullets are one copy: everything but the intro and the offer bullet is identical
  const bullets = (t) => t.split('\n').filter(l => l.startsWith('- ') && !l.startsWith('- When the person you work for asks for something that splits'));
  assert.deepStrictEqual(bullets(core), bullets(tg.FULL_TEXT));
});

test('level light, minimal context and every small-model prefix give the light text', () => {
  const sam = { name: 'sam', model: 'claude-sdk/default' };
  assert.strictEqual(tg.textFor({ agent: sam, isLead: true, level: 'light' }), tg.LIGHT_TEXT);
  assert.strictEqual(tg.textFor({ agent: { ...sam, minimalContext: true }, isLead: true, level: 'full' }), tg.LIGHT_TEXT);
  for (const p of ['local/', 'lmstudio/', 'ollama/', 'omlx/', 'ninfer/']) {
    assert.strictEqual(tg.isSmallModel(`${p}qwen`), true, p);
    assert.strictEqual(tg.textFor({ agent: { ...sam, model: `${p}qwen` }, isLead: true, level: 'full' }), tg.LIGHT_TEXT, p);
  }
  assert.strictEqual(tg.isSmallModel('claude-sdk/default'), false);
  assert.strictEqual(tg.isSmallModel(undefined), false);
  assert.match(tg.LIGHT_TEXT, /^\n\n## RUNNING A TEAM\nDo small jobs yourself; hand off big, parallel or long work\./);
});

test('an agent set to off gets nothing at any level; level off gives nothing unless the agent says on', () => {
  const sam = { name: 'sam', model: 'claude-sdk/default' };
  for (const level of ['full', 'light', 'off']) assert.strictEqual(tg.textFor({ agent: { ...sam, teamGuidance: 'off' }, isLead: true, level }), '', level);
  assert.strictEqual(tg.textFor({ agent: sam, isLead: true, level: 'off' }), '');
  assert.strictEqual(tg.textFor({ agent: { ...sam, teamGuidance: 'inherit' }, isLead: true, level: 'off' }), '');
  assert.strictEqual(tg.textFor({ agent: { ...sam, teamGuidance: 'on' }, isLead: true, level: 'off' }), tg.FULL_TEXT);
  assert.strictEqual(tg.textFor({ agent: { ...sam, teamGuidance: 'on' }, isLead: false, level: 'off' }), tg.CORE_TEXT);
});

test('a missing agent works, the level defaults to the hub setting, and unknown levels read as full', () => {
  assert.strictEqual(tg.textFor({ agent: null, isLead: true, level: 'full' }), tg.FULL_TEXT);
  assert.strictEqual(tg.textFor({ isLead: false, level: 'full' }), tg.CORE_TEXT);
  assert.strictEqual(tg.textFor(), tg.CORE_TEXT, 'throwaway install, no setting: full level, not a lead');
  assert.strictEqual(tg.normalizeLevel('nonsense'), 'full');
  assert.strictEqual(tg.normalizeLevel(' OFF '), 'off');
  assert.strictEqual(tg.getLevel(), 'full');
  assert.deepStrictEqual(tg.LEVELS, ['full', 'light', 'off']);
  assert.deepStrictEqual(tg.AGENT_VALUES, ['inherit', 'on', 'off']);
});

test('the full text carries the second-opinion advice and names the challenger', () => {
  for (const phrase of ['give the reviewer the work, not your conclusion', 'Judge models by their results', 'should differ from yours when the point is a second opinion', 'challenger']) {
    assert.ok(tg.FULL_TEXT.includes(phrase), phrase);
  }
  assert.doesNotMatch(tg.FULL_TEXT + tg.CORE_TEXT + tg.LIGHT_TEXT, /\uFE0F/u, 'no emoji variation selector');
});

// ── worker-policy ──
test('the roster lists a challenger that is not a worker, and its line says so', () => {
  const agents = [
    { name: 'maestro', model: 'claude-sdk/claude-fable-5-1', category: 'primary' },
    { name: 'helper-a', model: 'claude-sdk/claude-sonnet-5', category: 'worker' },
    { name: 'critic', model: 'openai/gpt-5.5', category: 'specialist', teamRole: 'challenger' },
    { name: 'other', model: 'claude-sdk/claude-sonnet-5', category: 'specialist' },
  ];
  const r = wp.buildRoster(agents, { selfName: 'maestro' });
  assert.deepStrictEqual(r.map(w => w.name), ['helper-a', 'critic']);
  assert.strictEqual(r.find(w => w.name === 'critic').teamRole, 'challenger');
  assert.strictEqual(r.find(w => w.name === 'helper-a').teamRole, null);
  const lines = wp.platformPolicyText(r).split('\n');
  const critic = lines.find(l => l.startsWith('- `critic`'));
  assert.match(critic, /second-vendor perspective — challenger: adversarial review and second opinions$/);
  assert.doesNotMatch(lines.find(l => l.startsWith('- `helper-a`')), /challenger/);
  const busy = wp.buildRoster(agents, { selfName: 'maestro', isActive: n => n === 'critic' });
  assert.match(wp.platformPolicyText(busy), /challenger: adversarial review and second opinions — \*\*busy right now\*\*/);
  assert.deepStrictEqual(wp.buildRoster(agents, { selfName: 'critic' }).map(w => w.name), ['helper-a'], 'never the caller');
});

test('the ninfer hint is generic', () => {
  // The old text named one machine ("on the 5090") and "fast"; a shared template cannot know either.
  assert.strictEqual(wp.strengthsFor('ninfer/qwen'), 'local model (NInfer): private and free to run; good for bulk, drafts and sensitive text work');
});

// ── updateAgentField ──
beforeEach(() => seed([base(), base({ name: 'helper-a', display: 'Helper A' })]));

test('teamGuidance: on and off are stored, inherit and empty delete it, anything else is refused', async () => {
  assert.deepStrictEqual(await agentsLib.updateAgentField('sam', { teamGuidance: 'off' }), { success: true });
  assert.strictEqual(onDisk('sam').teamGuidance, 'off');
  assert.strictEqual((await agentsLib.getAgents(true)).find(a => a.name === 'sam').teamGuidance, 'off');
  assert.deepStrictEqual(await agentsLib.updateAgentField('sam', { teamGuidance: ' ON ' }), { success: true });
  assert.strictEqual(onDisk('sam').teamGuidance, 'on');
  for (const v of ['inherit', '', null]) {
    await agentsLib.updateAgentField('sam', { teamGuidance: 'on' });
    assert.deepStrictEqual(await agentsLib.updateAgentField('sam', { teamGuidance: v }), { success: true }, String(v));
    assert.ok(!('teamGuidance' in onDisk('sam')), String(v));
  }
  await agentsLib.updateAgentField('sam', { teamGuidance: 'on' });
  for (const v of ['full', 'maybe', 5, true]) {
    assert.deepStrictEqual(await agentsLib.updateAgentField('sam', { teamGuidance: v }), { success: false, error: 'teamGuidance must be inherit, on or off' }, String(v));
    assert.strictEqual(onDisk('sam').teamGuidance, 'on', 'a refused value changes nothing');
  }
  assert.strictEqual((await agentsLib.getAgents(true)).find(a => a.name === 'helper-a').teamGuidance, undefined);
});

test('teamRole: challenger and worker are stored, null and empty delete it, anything else is refused', async () => {
  assert.deepStrictEqual(await agentsLib.updateAgentField('sam', { teamRole: 'challenger' }), { success: true });
  assert.strictEqual(onDisk('sam').teamRole, 'challenger');
  assert.strictEqual((await agentsLib.getAgents(true)).find(a => a.name === 'sam').teamRole, 'challenger');
  assert.deepStrictEqual(await agentsLib.updateAgentField('sam', { teamRole: 'worker' }), { success: true });
  assert.strictEqual(onDisk('sam').teamRole, 'worker');
  for (const v of [null, '']) {
    await agentsLib.updateAgentField('sam', { teamRole: 'challenger' });
    assert.deepStrictEqual(await agentsLib.updateAgentField('sam', { teamRole: v }), { success: true }, String(v));
    assert.ok(!('teamRole' in onDisk('sam')), String(v));
  }
  for (const v of ['boss', 'inherit', 7]) {
    assert.deepStrictEqual(await agentsLib.updateAgentField('sam', { teamRole: v }), { success: false, error: 'teamRole must be challenger or worker' }, String(v));
  }
  assert.ok(!('teamRole' in onDisk('sam')));
});

// ── the server boundary ──
test('a member cannot PATCH teamGuidance or teamRole: the server guard, run on the real source, refuses both', () => {
  const src = read('server.js');
  const start = src.indexOf("if (!req.hubService && !access.isAdmin(req.hubUser)) {\n        const MEMBER_EDITABLE");
  assert.ok(start > 0, 'the member guard is in server.js');
  const open = src.indexOf('{', start);
  let depth = 0, end = open;
  for (let i = open; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (!depth) { end = i; break; } } }
  const guard = src.slice(start, end + 1);
  assert.doesNotMatch(guard, /teamGuidance|teamRole/, 'neither is in the member allowlist');
  const run = (user, body, hubService = false) => {
    let sent = null;
    const jsonResponse = (res, code, obj) => { sent = { code, obj }; return 'sent'; };
    const fn = vm.runInNewContext(`(function (req, body, access, jsonResponse, res) { ${guard}\n return 'continued'; })`, {});
    return { out: fn({ hubService, hubUser: user }, body, access, jsonResponse, {}), sent };
  };
  const member = { id: 'u2', role: 'member' }, admin = { id: 'u1', role: 'admin' };
  for (const body of [{ teamGuidance: 'on' }, { teamRole: 'challenger' }, { teamGuidance: null }, { blurb: 'x', teamRole: null }]) {
    const r = run(member, body);
    assert.strictEqual(r.out, 'sent', JSON.stringify(body));
    assert.strictEqual(r.sent.code, 403);
    assert.match(r.sent.obj.error, /teamGuidance|teamRole/);
  }
  assert.strictEqual(run(member, { blurb: 'x' }).out, 'continued');
  assert.strictEqual(run(admin, { teamGuidance: 'on', teamRole: 'challenger' }).out, 'continued');
});

test('/api/team_guidance is admin-only like /api/sdk_workers, and the route validates against LEVELS', () => {
  for (const m of ['GET', 'POST']) {
    assert.deepStrictEqual(access.classifyRoute('/api/team_guidance', m), { kind: 'admin' });
    assert.deepStrictEqual(access.classifyRoute('/api/team_guidance', m), access.classifyRoute('/api/sdk_workers', m));
  }
  const src = read('server.js');
  assert.match(src, /pathname === '\/api\/team_guidance' && req\.method === 'GET'/);
  assert.match(src, /pathname === '\/api\/team_guidance' && req\.method === 'POST'/);
  assert.match(src, /if \(!tg\.LEVELS\.includes\(requested\)\) return jsonResponse\(res, 400/);
  assert.match(src, /hubSettings\.updateSettings\(\{ teamGuidance: requested \}\)/);
  assert.match(src, /require\('\.\/lib\/agents'\)\.migrateTeamGuidance\(\)/);
});

// ── sdk-chat: the text reaches all three paths ──
test('sdk-chat appends the team guidance at the gateway, SDK and Codex sites (source-level: the prompt builders run inside whole model turns)', () => {
  // The three builders sit in the middle of full turns (sign-ins, sessions, a model call), so they cannot be called in isolation;
  // this pins that each site appends teamGuidanceTextFor(agentName), and that the helper skips temporary workers.
  const src = read('lib/sdk-chat.js');
  assert.match(src, /async function teamGuidanceTextFor\(agentName\) \{[\s\S]*?temporalWorkers\.isVirtual\(agentName\)\) return '';[\s\S]*?require\('\.\/team-guidance'\)\.textFor\(\{ agent: rec, isLead: isLeadAgent\(agentName, agents\), member \}\)[\s\S]*?catch \{ return ''; \}/);
  // each site appends the team guidance, then the independent "need a worker?" line (askLeadTextFor, its own gate),
  // then check-ins and suggestions (workPracticesTextFor, their own gates)
  assert.match(src, /systemPrompt \+= workerPolicy\.platformPolicyText\(gwRoster\) \+ \(await teamGuidanceTextFor\(agentName\)\) \+ \(await askLeadTextFor\(agentName\)\) \+ \(await workPracticesTextFor\(agentName\)\);/, 'gateway');
  assert.match(src, /const workerPolicyText = ephemeral \? '' : workerPolicy\.policyText\(workerMode, workerRoster\) \+ \(await teamGuidanceTextFor\(agentName\)\) \+ \(await askLeadTextFor\(agentName\)\) \+ \(await workPracticesTextFor\(agentName\)\);/, 'SDK: also when policyText is empty (sdkWorkers allow)');
  assert.match(src, /const workerPolicyText = ephemeral \? '' : workerPolicy\.platformPolicyText\(workerRoster\) \+ \(await teamGuidanceTextFor\(agentName\)\) \+ \(await askLeadTextFor\(agentName\)\) \+ \(await workPracticesTextFor\(agentName\)\);/, 'Codex');
  assert.strictEqual((src.match(/await teamGuidanceTextFor\(agentName\)/g) || []).length, 3);
  assert.strictEqual(wp.policyText('allow', []), '', 'sdkWorkers allow: the delegation text is empty, so the guidance is all that is added');
});

// ── the migration ──
const paths = () => { const d = tempDir(); return { d, agentsFile: path.join(d, 'agents.json'), markerFile: path.join(d, 'team-guidance-migrated.json') }; };
const ADMINS = new Set(['u1']);
const install = () => [
  { name: 'maestro', model: 'claude-sdk/default', category: 'primary', lead: true },
  { name: 'sam', model: 'claude-sdk/default', category: 'specialist' },
  { name: 'helper-a', model: 'claude-sdk/default', category: 'worker', teamGuidance: 'on' },
  { name: 'rae', model: 'claude-sdk/default', category: 'primary', owner: 'u2' },
];

test('migration: non-leads get off, the lead and an explicit on stay, the marker is written 0600; a second run changes nothing', () => {
  const p = paths();
  fs.writeFileSync(p.agentsFile, JSON.stringify(install(), null, 2));
  const r = agentsLib.migrateTeamGuidance({ agentsFile: p.agentsFile, markerFile: p.markerFile, adminIds: ADMINS });
  assert.deepStrictEqual(r, { changed: 2 });
  const after = JSON.parse(fs.readFileSync(p.agentsFile, 'utf8'));
  const by = (n) => after.find(a => a.name === n);
  assert.strictEqual(by('sam').teamGuidance, 'off');
  assert.strictEqual(by('rae').teamGuidance, 'off', "a member's assistant is not a lead");
  assert.ok(!('teamGuidance' in by('maestro')), 'the lead is untouched');
  assert.strictEqual(by('helper-a').teamGuidance, 'on', 'an explicit setting is untouched');
  const marker = JSON.parse(fs.readFileSync(p.markerFile, 'utf8'));
  assert.strictEqual(marker.changed, 2);
  assert.ok(Date.parse(marker.migratedAt));
  assert.strictEqual(fs.statSync(p.markerFile).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(p.d).sort(), ['agents.json', 'team-guidance-migrated.json'], 'no temp files left');
  // second run
  const bytes = fs.readFileSync(p.agentsFile, 'utf8');
  assert.deepStrictEqual(agentsLib.migrateTeamGuidance({ agentsFile: p.agentsFile, markerFile: p.markerFile, adminIds: ADMINS }), { changed: 0, reason: 'already migrated' });
  assert.strictEqual(fs.readFileSync(p.agentsFile, 'utf8'), bytes);
});

test('migration: an install that marks no lead keeps the admin-side primary agents as leads', () => {
  const p = paths();
  fs.writeFileSync(p.agentsFile, JSON.stringify([
    { name: 'maestro', category: 'primary' }, { name: 'sam', category: 'specialist' }, { name: 'rae', category: 'primary', owner: 'u2' }], null, 2));
  assert.deepStrictEqual(agentsLib.migrateTeamGuidance({ agentsFile: p.agentsFile, markerFile: p.markerFile, adminIds: ADMINS }), { changed: 2 });
  const after = JSON.parse(fs.readFileSync(p.agentsFile, 'utf8'));
  assert.ok(!('teamGuidance' in after.find(a => a.name === 'maestro')));
});

test('migration: no agents.json means no marker; an unreadable or non-list file means no marker either', () => {
  const p = paths();
  assert.deepStrictEqual(agentsLib.migrateTeamGuidance({ agentsFile: p.agentsFile, markerFile: p.markerFile, adminIds: ADMINS }), { changed: 0, reason: 'first run' });
  assert.ok(!fs.existsSync(p.markerFile));
  fs.writeFileSync(p.agentsFile, '{ not json');
  assert.strictEqual(agentsLib.migrateTeamGuidance({ agentsFile: p.agentsFile, markerFile: p.markerFile, adminIds: ADMINS }).changed, 0);
  assert.ok(!fs.existsSync(p.markerFile));
  fs.writeFileSync(p.agentsFile, '{"a":1}');
  assert.strictEqual(agentsLib.migrateTeamGuidance({ agentsFile: p.agentsFile, markerFile: p.markerFile, adminIds: ADMINS }).changed, 0);
  assert.ok(!fs.existsSync(p.markerFile));
  assert.strictEqual(fs.readFileSync(p.agentsFile, 'utf8'), '{"a":1}', 'the file is left alone');
});

test('migration: an agent added after the marker keeps no field', () => {
  const p = paths();
  fs.writeFileSync(p.agentsFile, JSON.stringify(install(), null, 2));
  agentsLib.migrateTeamGuidance({ agentsFile: p.agentsFile, markerFile: p.markerFile, adminIds: ADMINS });
  const list = JSON.parse(fs.readFileSync(p.agentsFile, 'utf8'));
  list.push({ name: 'new-one', model: 'claude-sdk/default', category: 'specialist' });
  fs.writeFileSync(p.agentsFile, JSON.stringify(list, null, 2));
  assert.deepStrictEqual(agentsLib.migrateTeamGuidance({ agentsFile: p.agentsFile, markerFile: p.markerFile, adminIds: ADMINS }), { changed: 0, reason: 'already migrated' });
  assert.ok(!('teamGuidance' in JSON.parse(fs.readFileSync(p.agentsFile, 'utf8')).find(a => a.name === 'new-one')));
});

test('migration: nothing to change still writes the marker with changed 0, and does not rewrite agents.json', () => {
  const p = paths();
  const text = JSON.stringify([{ name: 'maestro', lead: true }], null, 2);
  fs.writeFileSync(p.agentsFile, text);
  assert.deepStrictEqual(agentsLib.migrateTeamGuidance({ agentsFile: p.agentsFile, markerFile: p.markerFile, adminIds: ADMINS }), { changed: 0 });
  assert.strictEqual(JSON.parse(fs.readFileSync(p.markerFile, 'utf8')).changed, 0);
  assert.strictEqual(fs.readFileSync(p.agentsFile, 'utf8'), text);
});

test('first-run seeding writes the marker, so a fresh install is never migrated', () => {
  const iso2 = makeIsolatedInstall('team-guidance-seed-');
  const marker = path.join(iso2.data, 'team-guidance-migrated.json');
  assert.ok(!fs.existsSync(path.join(iso2.data, 'agents.json')) && !fs.existsSync(marker));
  const fresh = require(path.join(iso2.inst, 'lib', 'agents.js'));
  assert.ok(fresh.getAgentsSync(true).length > 0, 'seeded from the example list');
  assert.ok(fs.existsSync(path.join(iso2.data, 'agents.json')));
  assert.strictEqual(JSON.parse(fs.readFileSync(marker, 'utf8')).changed, 0);
  assert.strictEqual(fs.statSync(marker).mode & 0o777, 0o600);
  assert.strictEqual(fresh.TEAM_GUIDANCE_MARKER, marker);
  assert.deepStrictEqual(fresh.migrateTeamGuidance({ adminIds: new Set() }), { changed: 0, reason: 'already migrated' });
});

// ── pages ──
test('the pages carry the controls: the more-menu select, and the two agent-settings rows', () => {
  const idx = read('index.html'), app = read('app.js'), as = read('agent-settings.html');
  assert.match(idx, /id="sdk-workers-select"[\s\S]*?<\/div>\s*<div class="more-row">\s*<label class="toggle-switch"[^>]*title="How agents are told to run a team:[\s\S]*?id="team-guidance-select"[\s\S]*?value="full">Full<[\s\S]*?value="light">Light<[\s\S]*?value="off">Off</);
  // Review r1: the save moved into bindTeamGuidanceSelect (one save at a time, the stored value put back on failure); its behaviour is tested below.
  assert.match(app, /doFetch\('\/api\/team_guidance', \{ method: 'POST'[^}]*\}[^)]*body: JSON\.stringify\(\{ level: want \}\)/);
  assert.match(app, /if \(teamGuidanceSelect\) bindTeamGuidanceSelect\(teamGuidanceSelect, /);
  assert.match(as, /<select id="team-guidance-mode" onchange="saveTeamGuidance\(\)"[\s\S]*?value="inherit">Use the hub setting<[\s\S]*?value="on">On<[\s\S]*?value="off">Off</);
  assert.match(as, /<select id="team-role" onchange="saveTeamRole\(\)"[\s\S]*?value="">None<[\s\S]*?value="worker">Worker<[\s\S]*?value="challenger">Challenger</);
  assert.match(as, /id="team-guidance-status"/);
  assert.match(as, /JSON\.stringify\(\{ teamGuidance: v \}\)/);
  assert.match(as, /JSON\.stringify\(\{ teamRole: v \|\| null \}\)/);
  assert.match(as, /agent\?\.teamGuidance \|\| 'inherit'/);
  assert.match(as, /agent\?\.teamRole \|\| ''/);
  assert.ok(as.indexOf('id="effort-row"') < as.indexOf('id="team-guidance-row"'), 'after the effort row');
});

// Review r1 (Sonnet): teamRole 'worker' must list the agent like a worker; the light text names the spawn_workers fallback.
test('teamRole worker lists an agent outside category worker; the light text has the spawn_workers fallback', () => {
  const r = wp.buildRoster([
    { name: 'maestro', model: 'claude-sdk/x', category: 'primary' },
    { name: 'helper-b', model: 'claude-sdk/claude-haiku-5', category: 'specialist', teamRole: 'worker' },
  ], { selfName: 'maestro' });
  assert.deepStrictEqual(r.map(w => [w.name, w.teamRole]), [['helper-b', 'worker']]);
  assert.match(tg.LIGHT_TEXT, /spawn_workers/);
  assert.match(tg.FULL_TEXT, /among the agents you may consult/);
  assert.match(tg.LIGHT_TEXT, /among the agents you may consult/);
});

// Review r1 (GPT-6 BLOCK): the More-menu select must end on the stored value: a failed save puts it back, a first load that
// answers after a change is ignored, and two quick changes are saved one after the other. Runs the page's own handler
// (app.js between the team-guidance-select markers) with a stand-in select and fetch.
function pageHandler() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const a = src.indexOf('// team-guidance-select:begin'), b = src.indexOf('// team-guidance-select:end');
  assert.ok(a > 0 && b > a, 'markers in app.js');
  const ctx = {};
  vm.runInNewContext(src.slice(a, b) + '\nthis.bind = bindTeamGuidanceSelect;', ctx);
  return ctx.bind;
}
function standIns(stored) {
  const select = { value: 'full', title: '', listeners: [], addEventListener(t, f) { this.listeners.push(f); }, choose(v) { this.value = v; this.listeners.forEach(f => f()); } };
  const calls = [];
  const fetch = (url, opts = {}) => new Promise((resolve) => calls.push({ opts, resolve }));
  const answer = (i, status, body) => calls[i].resolve({ ok: status < 400, status, json: async () => body });
  return { select, calls, fetch, answer, stored };
}
const tick = () => new Promise(r => setImmediate(r));
test('menu select: a failed save puts back the stored value and says why', async () => {
  const s = standIns(); pageHandler()(s.select, s.fetch);
  s.answer(0, 200, { level: 'full' }); await tick();
  s.select.choose('off'); await tick();
  assert.strictEqual(JSON.parse(s.calls[1].opts.body).level, 'off');
  s.answer(1, 500, { error: 'disk full' }); await tick();
  s.answer(2, 200, { level: 'full' }); await tick(); await tick();
  assert.strictEqual(s.select.value, 'full');
  assert.match(s.select.title, /Not saved: disk full/);
});
test('menu select: a first load that answers after a saved change does not undo it', async () => {
  const s = standIns(); pageHandler()(s.select, s.fetch);
  s.select.choose('off'); await tick();
  s.answer(1, 200, { level: 'off' }); await tick(); await tick();
  s.answer(0, 200, { level: 'full' }); await tick();
  assert.strictEqual(s.select.value, 'off');
});
test('menu select: two quick changes are saved in order and the select ends on the last stored one', async () => {
  const s = standIns(); pageHandler()(s.select, s.fetch);
  s.answer(0, 200, { level: 'full' }); await tick();
  s.select.choose('off'); s.select.choose('light'); await tick();
  assert.strictEqual(s.calls.length, 2, 'the second save waits for the first');
  s.answer(1, 200, { level: 'off' }); await tick(); await tick();
  assert.strictEqual(s.select.value, 'light', 'a newer choice is still on screen while it is being saved');
  assert.strictEqual(JSON.parse(s.calls[2].opts.body).level, 'light');
  s.answer(2, 200, { level: 'light' }); await tick(); await tick();
  assert.strictEqual(s.select.value, 'light');
});
