// Optimize team on the pages: the desktop row menu entry, the phone ⋮ menu entry, the status key, the main-view exemption, and the
// shipped playbook section. Functions are cut out of app.js / mobile.js and run on fakes; no hub data is read and no model is called.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const app = read('app.js');
const mob = read('mobile.js');
const mobHtml = read('mobile.html');
const hubTeams = require(path.join(ROOT, 'lib', 'ui-teams.js'));

function cut(src, name) {
  const a = src.search(new RegExp(`function ${name}\\(`));
  assert.ok(a >= 0, `${name} exists`);
  let depth = 0;
  for (let i = src.indexOf('{', src.indexOf(')', a)); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(a, i + 1);
  }
  throw new Error('unbalanced');
}

const A = (name, over) => Object.assign({ name, display: name[0].toUpperCase() + name.slice(1), category: 'specialist' }, over);
const MAIN = (n, over) => A(n, Object.assign({ category: 'primary' }, over));
const AGENTS = () => [MAIN('studio'), MAIN('atlas'), A('writer', { reportsTo: 'studio', category: 'worker' }), A('critic')];

// ---- desktop
function desktop({ admin = true, simple = false, status = {}, fetchImpl } = {}) {
  const started = []; const alerts = []; const fetched = [];
  const ctx = {
    AGENTS: AGENTS(), agentStatus: status, hubTeams, isHubAdmin: () => admin, simpleOn: () => simple,
    hubEsc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    startSoloChat: (n, m) => started.push([n, m]), alerts, started, fetched,
    alert: (m) => alerts.push(m),
    fetch: fetchImpl || (async (url, o) => { fetched.push([url, (o && o.method) || 'GET']); return { status: 404, ok: false, json: async () => ({}) }; }),
    teamsRepaintSoon() {},
  };
  const src = ['const optimizeTeamPending = new Set(); const optimizeEstimates = {};', 'const buildTeamPending = new Set();',
    cut(app, 'teamBuilding'), cut(app, 'agentCanBuildTeam'), cut(app, 'teamReviewing'), cut(app, 'agentCanOptimizeTeam'), cut(app, 'optimizeSubText'),
    cut(app, 'agentMenuEntries'), 'async ' + cut(app, 'optimizeTeamStart'), cut(app, 'optimizeEstimateLoad'),
    'this.api = { agentMenuEntries, optimizeTeamStart, optimizeEstimateLoad, optimizeSubText, optimizeEstimates, optimizeTeamPending };'].join('\n');
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}
const labels = (w, name) => w.api.agentMenuEntries(w.AGENTS.find((a) => a.name === name)).map((e) => e.label);

test('menu entries: Optimize team on a main agent WITH a team, Build team on one without, never both', () => {
  const w = desktop();
  assert.deepStrictEqual([...labels(w, 'studio')], ['Settings', 'Optimize team']);
  assert.deepStrictEqual([...labels(w, 'atlas')], ['Settings', 'Build team']);
  assert.deepStrictEqual([...labels(w, 'writer')], ['Settings'], 'a worker is not a main agent');
  assert.deepStrictEqual([...labels(w, 'critic')], ['Settings']);
  for (const n of ['studio', 'atlas']) assert.ok(!(labels(w, n).includes('Optimize team') && labels(w, n).includes('Build team')));
});

test('menu entries: admins only, and Simple mode shows none', () => {
  const m = desktop({ admin: false });
  assert.strictEqual(m.api.agentMenuEntries(m.AGENTS[0]).length, 0);
  const s = desktop({ simple: true });
  assert.strictEqual(s.api.agentMenuEntries(s.AGENTS[0]).length, 0);
});

test('the entry\'s sublabel: "reads the last 30 days" while loading, then the estimate text', () => {
  const w = desktop();
  const e = w.api.agentMenuEntries(w.AGENTS[0]).find((x) => x.key === 'optimize');
  assert.strictEqual(e.sub, 'reads the last 30 days');
  w.api.optimizeEstimates.studio = { days: 30, turns: 214, handOffs: 19 };
  assert.strictEqual(w.api.agentMenuEntries(w.AGENTS[0]).find((x) => x.key === 'optimize').sub, 'reads 30 days: 214 turns, 19 hand-offs');
  assert.strictEqual(w.api.optimizeSubText('studio'), 'reads 30 days: 214 turns, 19 hand-offs');
});

test('the estimate is fetched from GET .../optimize-team/estimate and written into the open menu', async () => {
  const urls = [];
  const w = desktop({ fetchImpl: async (url, o) => { urls.push([url, o && o.method]); return { ok: true, json: async () => ({ days: 30, turns: 12, handOffs: 3 }) }; } });
  const sub = { textContent: '' };
  const menu = { querySelector: (sel) => (sel === '[data-act="optimize"] .agent-menu-sub' ? sub : null) };
  w.api.optimizeEstimateLoad('studio', menu);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepStrictEqual(urls, [['/api/agents/studio/optimize-team/estimate', undefined]]);
  assert.strictEqual(sub.textContent, 'reads 30 days: 12 turns, 3 hand-offs');
  // a failing estimate leaves the loading text alone
  const f = desktop({ fetchImpl: async () => ({ ok: false }) });
  const sub2 = { textContent: 'reads the last 30 days' };
  f.api.optimizeEstimateLoad('studio', { querySelector: () => sub2 });
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(sub2.textContent, 'reads the last 30 days');
});

test('Reviewing…: a status entry with reviewingTeamFor === name (or a request in flight) disables the entry', () => {
  const w = desktop({ status: { lead: { busy: true, reviewingTeamFor: 'studio' } } });
  assert.strictEqual(JSON.stringify(w.api.agentMenuEntries(w.AGENTS[0]).map((x) => [x.label, !!x.disabled])), '[["Settings",false],["Reviewing…",true]]');
  const p = desktop();
  p.api.optimizeTeamPending.add('studio');
  assert.strictEqual(p.api.agentMenuEntries(p.AGENTS[0])[1].label, 'Reviewing…');
});

test('optimizeTeamStart: POST the route; 202 opens the reviewer\'s chat; an error alerts the server\'s text; no second request while reviewing', async () => {
  const calls = [];
  const w = desktop({ fetchImpl: async (url, o) => { calls.push([url, o.method]); return { status: 202, ok: true, json: async () => ({ ok: true, reviewer: 'lead', turnId: 't1' }) }; } });
  w.AGENTS.push(MAIN('lead', { model: 'x/lead-model' }));
  await w.api.optimizeTeamStart('studio');
  assert.deepStrictEqual(calls, [['/api/agents/studio/optimize-team', 'POST']]);
  assert.deepStrictEqual(w.started, [['lead', 'x/lead-model']]);
  assert.strictEqual(w.api.optimizeTeamPending.size, 0, 'the pending mark is cleared');
  const e = desktop({ fetchImpl: async () => ({ status: 400, ok: false, json: async () => ({ error: 'build a team first' }) }) });
  await e.api.optimizeTeamStart('studio');
  assert.deepStrictEqual(e.alerts, ['build a team first']);
  assert.strictEqual(e.started.length, 0);
  let n = 0;
  const r = desktop({ status: { lead: { reviewingTeamFor: 'studio' } }, fetchImpl: async () => { n++; return { ok: false }; } });
  await r.api.optimizeTeamStart('studio');
  assert.strictEqual(n, 0);
});

test('app.js wiring: the status key, idle clear, the turn start and the main-view exemption, the menu click', () => {
  assert.match(app, /'consultedBy', 'buildingTeamFor', 'reviewingTeamFor', 'offerPending', 'settingUpTeams'\]\) if \(k in s\)/);
  assert.match(app, /buildingTeamFor: a\.buildingTeamFor \|\| null, reviewingTeamFor: a\.reviewingTeamFor \|\| null/);
  assert.match(app, /next\.buildingTeamFor = null; next\.reviewingTeamFor = null;/);
  assert.match(app, /ev\.origin\.kind === 'optimize_team' && ev\.origin\.for\) \? \{ reviewingTeamFor: ev\.reviewingTeamFor \|\| ev\.origin\.for \}/);
  assert.match(app, /chatViewIsHubOrigin\(ev\.origin\) && ev\.origin\.kind !== 'build_team' && ev\.origin\.kind !== 'team_setup' && ev\.origin\.kind !== 'optimize_team';/);
  assert.match(app, /else if \(act === 'optimize'\) optimizeTeamStart\(name\);/);
  assert.match(app, /<small class="agent-menu-sub">/);
});

// ---- phone
function phone({ admin = true, simple = false, cur = 'studio', live = {}, pending = [], estimates = {} } = {}) {
  const els = {};
  for (const id of ['menu-agent-settings', 'menu-build-team', 'menu-optimize-team', 'menu-optimize-label', 'menu-optimize-sub']) els[id] = { hidden: false, disabled: false, href: '', textContent: '' };
  const agents = AGENTS();
  const e = {
    $: (id) => els[id], current: cur, live, agents, window: { hubTeams }, isAdmin: () => admin, simpleOn: () => simple,
    agentByName: (n) => agents.find((a) => a.name === n),
    buildingTeam: () => false, buildTeamPending: new Set(),
  };
  const src = [cut(mob, 'buildNoTeam'), cut(mob, 'reviewingTeam'), 'const optimizeTeamPending = new Set(' + JSON.stringify(pending) + '); const optimizeEstimates = ' + JSON.stringify(estimates) + ';',
    cut(mob, 'optimizeHasTeam'), cut(mob, 'optimizeSubText'), cut(mob, 'menuTeamSync'), 'menuTeamSync();'].join('\n');
  const names = Object.keys(e);
  new Function(...names, src)(...names.map((n) => e[n]));
  return els;
}

test('phone ⋮ menu: Optimize team for a main agent with a team (admins), Build team for one without, never both', () => {
  let m = phone();
  assert.strictEqual(m['menu-optimize-team'].hidden, false);
  assert.strictEqual(m['menu-build-team'].hidden, true);
  assert.strictEqual(m['menu-optimize-label'].textContent, '🔍 Optimize team');
  assert.strictEqual(m['menu-optimize-sub'].textContent, 'reads the last 30 days');
  m = phone({ cur: 'atlas' });
  assert.strictEqual(m['menu-optimize-team'].hidden, true);
  assert.strictEqual(m['menu-build-team'].hidden, false);
  m = phone({ cur: 'writer' });
  assert.ok(m['menu-optimize-team'].hidden && m['menu-build-team'].hidden, 'a worker: neither');
  m = phone({ admin: false });
  assert.ok(m['menu-optimize-team'].hidden && m['menu-agent-settings'].hidden, 'members: none');
  m = phone({ simple: true });
  assert.ok(m['menu-optimize-team'].hidden, 'Simple: none');
});

test('phone ⋮ menu: the estimate text, and Reviewing… while the status says so or a request is in flight', () => {
  let m = phone({ estimates: { studio: { days: 30, turns: 214, handOffs: 19 } } });
  assert.strictEqual(m['menu-optimize-sub'].textContent, 'reads 30 days: 214 turns, 19 hand-offs');
  m = phone({ live: { lead: { reviewingTeamFor: 'studio' } } });
  assert.strictEqual(m['menu-optimize-team'].disabled, true);
  assert.strictEqual(m['menu-optimize-label'].textContent, 'Reviewing…');
  m = phone({ pending: ['studio'] });
  assert.strictEqual(m['menu-optimize-team'].disabled, true);
  m = phone({ live: { lead: { reviewingTeamFor: 'atlas' } } });
  assert.strictEqual(m['menu-optimize-team'].disabled, false, 'another agent is being reviewed');
});

test('phone wiring: the button in mobile.html, the click, the POST route and estimate route, the status key, the hide exemption', () => {
  assert.match(mobHtml, /<button id="menu-optimize-team" class="chat-only" hidden>/);
  assert.match(mobHtml, /id="menu-optimize-sub"/);
  assert.match(mob, /\$\('menu-optimize-team'\)\?\.addEventListener\('click'/);
  assert.match(mob, /'\/api\/agents\/' \+ encodeURIComponent\(name\) \+ '\/optimize-team', \{ method: 'POST'/);
  assert.match(mob, /'\/optimize-team\/estimate'/);
  assert.match(mob, /navigate\('chat', d\.reviewer \|\| name\)/);
  assert.match(mob, /'consultedBy', 'buildingTeamFor', 'reviewingTeamFor', 'offerPending', 'settingUpTeams'\]/);
  assert.match(mob, /next\.buildingTeamFor = null; next\.reviewingTeamFor = null;/);
  assert.match(mob, /ev\.origin\.kind !== 'build_team' && ev\.origin\.kind !== 'team_setup' && ev\.origin\.kind !== 'optimize_team'\) \{/);
});

test('phone optimizeTeamStart: 202 navigates to the reviewer, an error toasts the server text', async () => {
  const run = async (status, body) => {
    const navs = []; const toasts = []; const calls = [];
    const e = {
      live: {}, api: async (url, o) => { calls.push([url, o && o.method]); return { status, json: async () => body }; },
      navigate: (...a) => navs.push(a), toast: (m) => toasts.push(m), menuTeamSync() {},
    };
    const src = 'const optimizeTeamPending = new Set();' + cut(mob, 'reviewingTeam') + 'async ' + cut(mob, 'optimizeTeamStart') + '\nreturn optimizeTeamStart;';
    const names = Object.keys(e);
    await new Function(...names, src)(...names.map((n) => e[n]))('studio');
    return { navs, toasts, calls };
  };
  let r = await run(202, { ok: true, reviewer: 'lead', turnId: 't' });
  assert.deepStrictEqual(r.calls, [['/api/agents/studio/optimize-team', 'POST']]);
  assert.deepStrictEqual(r.navs, [['chat', 'lead']]);
  r = await run(409, { error: 'already reviewing' });
  assert.deepStrictEqual(r.toasts, ['already reviewing']);
  assert.strictEqual(r.navs.length, 0);
});

// ---- the playbook
test('TEAM-PLAYBOOK.md has an Optimize team section with the method, and the manifest sha matches the file', () => {
  const file = path.join(ROOT, 'templates', 'workspaces', 'maestro', 'TEAM-PLAYBOOK.md');
  const text = fs.readFileSync(file, 'utf8');
  const i = text.indexOf('\n## Optimize team\n');
  assert.ok(i > 0, 'the section exists');
  const sec = text.slice(i);
  for (const re of [/Name what works first/, /long or repeated jobs/, /uniquely suited/, /strongest at the top/, /Challenge before work goes out/,
    /"No change" is a valid answer/, /Too little history/, /team-practice\.md/, /keep-on-box/, /never model ids/, /No colour, no emoji/]) assert.match(sec, re);
  assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(sec), 'no emoji in the playbook section');
  const m = JSON.parse(read('templates/workspace-updates.json'))['maestro/TEAM-PLAYBOOK.md'];
  assert.strictEqual(m.current, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  assert.deepStrictEqual(m.previous, ['758602a0772948e76162f5c4ed102e5f13dd3918200cb9ac27707be69534fed3', '59ec7edc513a3435897aa8a8e63cbfc45b732680c99fa6a0be74205b56550f45'], 'the Teams view and Set up teams versions have shipped');
});
