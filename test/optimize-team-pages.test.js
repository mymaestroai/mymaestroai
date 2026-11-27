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
  const src = ['const optimizeTeamPending = new Set();', 'const buildTeamPending = new Set();',
    cut(app, 'teamBuilding'), cut(app, 'agentCanBuildTeam'), cut(app, 'teamReviewing'), cut(app, 'agentCanOptimizeTeam'),
    'async ' + cut(app, 'optimizeTeamStart'),
    'this.api = { agentCanOptimizeTeam, agentCanBuildTeam, optimizeTeamStart, optimizeTeamPending };'].join('\n');
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}
// changed (P4-2): the row ⋯ menu entries (Optimize team / Build team, their sublabel, the estimate fetch) became rows of the card's Role and team section:
// the card's own checks (who gets which, the estimate line, the POST) are in test/ui-agent-card-basics.test.js; the page keeps the functions the rows call.
test('Optimize team belongs to a main agent WITH a team, Build team to one without, never both; admins only, never in Simple', () => {
  const w = desktop();
  const get = (n) => w.AGENTS.find((a) => a.name === n);
  assert.strictEqual(w.api.agentCanOptimizeTeam(get('studio')), true);
  assert.strictEqual(w.api.agentCanBuildTeam(get('studio')), false);
  assert.strictEqual(w.api.agentCanOptimizeTeam(get('atlas')), false);
  assert.strictEqual(w.api.agentCanBuildTeam(get('atlas')), true);
  for (const n of ['writer', 'critic']) assert.ok(!w.api.agentCanOptimizeTeam(get(n)) && !w.api.agentCanBuildTeam(get(n)), n + ' is not a main agent');
  const m = desktop({ admin: false });
  assert.ok(!m.api.agentCanOptimizeTeam(m.AGENTS[0]) && !m.api.agentCanBuildTeam(m.AGENTS[1]));
  const s = desktop({ simple: true });
  assert.ok(!s.api.agentCanOptimizeTeam(s.AGENTS[0]) && !s.api.agentCanBuildTeam(s.AGENTS[1]));
});

test('Reviewing…: a status entry with reviewingTeamFor === name (or a request in flight) stops a second review', async () => {
  let n = 0;
  const w = desktop({ status: { lead: { busy: true, reviewingTeamFor: 'studio' } }, fetchImpl: async () => { n++; return { ok: false }; } });
  await w.api.optimizeTeamStart('studio');
  assert.strictEqual(n, 0, 'busy by status: nothing is sent');
  const p = desktop({ fetchImpl: async () => { n++; return { ok: false }; } });
  p.api.optimizeTeamPending.add('studio');
  await p.api.optimizeTeamStart('studio');
  assert.strictEqual(n, 0, 'busy by a request in flight: nothing is sent');
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

test('app.js wiring: the status key, idle clear, the turn start and the main-view exemption, the functions the card row calls', () => {
  assert.match(app, /'consultedBy', 'buildingTeamFor', 'reviewingTeamFor', 'offerPending', 'settingUpTeams'\]\) if \(k in s\)/);
  assert.match(app, /buildingTeamFor: a\.buildingTeamFor \|\| null, reviewingTeamFor: a\.reviewingTeamFor \|\| null/);
  assert.match(app, /next\.buildingTeamFor = null; next\.reviewingTeamFor = null;/);
  assert.match(app, /ev\.origin\.kind === 'optimize_team' && ev\.origin\.for\) \? \{ reviewingTeamFor: ev\.reviewingTeamFor \|\| ev\.origin\.for \}/);
  assert.match(app, /chatViewIsHubOrigin\(ev\.origin\) && ev\.origin\.kind !== 'build_team' && ev\.origin\.kind !== 'team_setup' && ev\.origin\.kind !== 'optimize_team';/);
  assert.match(app, /window\.optimizeTeamStart = optimizeTeamStart;/);
  assert.doesNotMatch(app, /agent-menu-sub|act === 'optimize'/, 'the row menu is gone');
});

// ---- phone
// changed (P4-2): the ⋮ menu has no Agent settings, Build team or Optimize team items; the card's Role and team rows start the work.
test('phone wiring: no Agent settings / Build team / Optimize team in the ⋮ menu, the POST route, the status key, the hide exemption', () => {
  for (const id of ['menu-agent-settings', 'menu-build-team', 'menu-optimize-team', 'menu-optimize-label', 'menu-optimize-sub']) {
    assert.ok(!mobHtml.includes(id) && !mob.includes(id), id + ' is gone');
  }
  assert.doesNotMatch(mob, /menuTeamSync|optimizeEstimateLoad|optimizeSubText|optimizeHasTeam/);
  assert.match(mob, /'\/api\/agents\/' \+ encodeURIComponent\(name\) \+ '\/optimize-team', \{ method: 'POST'/);
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
  assert.deepStrictEqual(m.previous, ['758602a0772948e76162f5c4ed102e5f13dd3918200cb9ac27707be69534fed3', '59ec7edc513a3435897aa8a8e63cbfc45b732680c99fa6a0be74205b56550f45', '69d03c6b4614fd13985f0cf67872d9c097b14f5ae8eb3067adb46ad5951d1f22', '150e38b4c8c1480f75c8b3bef484e8e324b5fa72a198e10b93a2e5bd4c81629a', '9129e4765d0d6f2d156c5c550a022bc0b63b44454bbe0625cc5e0f7603581067'], 'the Teams view, Set up teams and Optimize team versions have shipped');
});
