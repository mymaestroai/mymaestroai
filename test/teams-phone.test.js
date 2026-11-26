'use strict';
// The phone page's Teams view of the agent list: switch markup, stored choice, the Teams rows, Simple's Teams list.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const js = read('mobile.js');
const html = read('mobile.html');
const hubTeams = require('../lib/ui-teams.js');
const slice = (a, b) => { const i = js.indexOf(a), j = js.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, a + ' .. ' + b); return js.slice(i, j); };
const TEAMS = () => slice('// ── Teams view of the agent list', '// One row of the agent list');
const ROW = () => slice('function agentRowHtml(', '// The Active section at the top');
const RENDER = () => slice('function renderAgents() {', 'function updateDots()');
const fnSource = (name) => {
  const i = js.search(new RegExp('function ' + name + '\\('));
  assert.ok(i >= 0, name);
  let depth = 0; let j = js.indexOf('{', i);
  for (; j < js.length; j++) { if (js[j] === '{') depth++; else if (js[j] === '}') { depth--; if (!depth) break; } }
  return js.slice(i, j + 1);
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── a small company: two main agents, two leaders, three workers, a specialist, an experiment ──
const AGENTS = [
  { name: 'ann', display: 'Ann', category: 'primary', lead: true },
  { name: 'bea', display: 'Bea <b>', category: 'primary' },
  { name: 'lia', display: 'Lia', category: 'specialist', reportsTo: 'ann' },
  { name: 'lou', display: 'Lou', category: 'specialist', reportsTo: 'ann' },
  { name: 'wes', display: 'Wes', category: 'worker', reportsTo: 'lia' },
  { name: 'wil', display: 'Wil', category: 'worker', reportsTo: 'lia' },
  { name: 'wyn', display: 'Wyn', category: 'worker', reportsTo: 'lou' },
  { name: 'sam', display: 'Sam', category: 'specialist' },
  { name: 'xan', display: 'Xan', category: 'experimental' },
];

function env(over) {
  const store = Object.assign({}, (over && over.store) || {});
  const e = {
    esc, hubTeams, window: { hubTeams }, isAdmin: () => true, agents: AGENTS, live: {}, unread: {}, statusKnown: true,
    isBusy: (n) => !!(e.live[n] && e.live[n].busy), busyText: (n) => n + ' is working', shortModel: (m) => 'm:' + m,
    activeJobTitle: () => '', activeJobLead: () => '', activeJobTail: () => '', workingFilter: false,
    screen: 'agents', document: { querySelectorAll: () => [] },
    // the row's background-work ring (lib/ui-agent-dot.js, the "Working on" change): nobody here has background work
    AgentDot: require('../lib/ui-agent-dot.js'), bgStateOf: () => 'free', bgCountOf: () => 0, renderBgChip: () => {},
    loadJson: (k, d) => { try { const v = JSON.parse(store[k]); return v ?? d; } catch { return d; } },
    saveJson: (k, v) => { store[k] = JSON.stringify(v); },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    store,
    // the Works alone record (mobile.js worksAlone): names the lead recorded, admins only
    aloneNames: (over && over.alone) || [],
  };
  e.worksAlone = (n) => !!e.isAdmin() && e.aloneNames.includes(n);
  return Object.assign(e, (over && over.env) || {});
}
function load(e, src, ret) {
  const names = Object.keys(e);
  return new Function(...names, src + '\nreturn ' + ret + ';')(...names.map((n) => e[n]));
}
// ROW() runs on to the page's own Works alone state (let teamSetup, worksAlone), so the record is set on that state
const teamsApi = (e) => load(e, TEAMS() + '\n' + ROW() + '\nteamSetup.alone = ' + JSON.stringify(Object.fromEntries((e.aloneNames || []).map((n) => [n, {}]))) + ';', '{ teamsView, teamsViewSet, teamsListHtml, agentRowHtml, teamsToggle, teamsRows, teamsLinesHtml }');
const names = (h) => (h.match(/data-agent="([^"]+)"/g) || []).map((s) => s.slice(12, -1));

test('mobile.html: the two-part switch above the list, its script tag, the stylesheet uses variables only', () => {
  const screen = html.slice(html.indexOf('<section id="screen-agents"'), html.indexOf('<section id="screen-chat"'));
  assert.match(screen, /<div class="view-switch" role="tablist"[^>]*><button[^>]*data-view="all"[^>]*role="tab"[^>]*>All Agents<\/button><button[^>]*data-view="teams"[^>]*role="tab"[^>]*>Teams<\/button><\/div>/);
  assert.ok(screen.indexOf('view-switch') < screen.indexOf('id="agents-list"'));
  assert.ok(html.indexOf('<script src="/ui-teams.js"></script>') > html.indexOf('<script src="/ui-simple.js"></script>'));
  const css = html.split('\n').filter((l) => /view-switch|sa-switch|\.tm-/.test(l)).join('\n');
  assert.match(css, /min-height: 40px/);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(css), 'no colour literals in the Teams rules');
});

test('the chosen view: stored under hub-sidebar-view, "teams" or "agents", All Agents when absent or odd', () => {
  assert.strictEqual(teamsApi(env()).teamsView(), 'agents');
  assert.strictEqual(teamsApi(env({ store: { 'hub-sidebar-view': 'teams' } })).teamsView(), 'teams');
  assert.strictEqual(teamsApi(env({ store: { 'hub-sidebar-view': 'junk' } })).teamsView(), 'agents');
  const e = env(); const api = teamsApi(e);
  api.teamsViewSet('teams');
  assert.strictEqual(e.store['hub-sidebar-view'], 'teams');
  assert.strictEqual(api.teamsView(), 'teams');
  api.teamsViewSet('agents');
  assert.strictEqual(e.store['hub-sidebar-view'], 'agents');
  // storage that refuses: the choice still holds for this page
  const bad = env({ env: { localStorage: { getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); } } } });
  const b = teamsApi(bad); b.teamsViewSet('teams');
  assert.strictEqual(b.teamsView(), 'teams');
});

test('All Agents: agentRowHtml without options is unchanged; renderAgents keeps its groups and never calls the tree', () => {
  const api = teamsApi(env());
  const a = AGENTS[7];
  const row = api.agentRowHtml(a);
  assert.strictEqual(row, api.agentRowHtml(a, {}));
  assert.strictEqual(row, '<button class="agent-row" data-agent="sam"><span class="agent-icon">🤖</span><span class="agent-meta"><div class="agent-name">Sam</div><div class="agent-model" title="">m:undefined</div></span><span class="dot idle" title=""></span></button>');
  // the sub option only replaces the second line
  assert.match(api.agentRowHtml(a, { sub: 'team of 2 · 1 working' }), /<div class="agent-model" title="team of 2 · 1 working">team of 2 · 1 working<\/div>/);
  const list = { innerHTML: '', querySelector: () => null, addEventListener() {}, firstChild: null };
  let treeCalls = 0;
  const e = env({ env: {
    $: () => list, renderWorkingChip() {}, GROUPS: [{ key: 'primary', title: 'Primary' }, { key: 'specialist', title: 'Specialists' }], collapsed: {},
    streams: new Map(), matchMedia: () => ({ matches: true }), setInterval: () => 1, clearInterval() {},
    activeInitial: () => ({ rows: [] }), activeBusyFrom: () => ({}), activeStep: () => ({ rows: [] }), activeTitle: () => '', activeTopOn: () => true,
    activeHeld: false, activeMissed: false, activeLastH: 0, activeLastCount: 0, activeTicker: null,
    activeJobsFrom: () => ({}), activeJobsNow: () => ({}), activeJobsRelabel() {}, activeJobs: {}, activeJobsTick: null, activeJobsSync() {},
    teamsView: () => 'agents', teamsPaintSwitch() {}, teamsListHtml: () => { treeCalls++; return ''; },
  } });
  const names2 = Object.keys(e);
  const fn = new Function(...names2, ROW() + '\nlet activeState = activeInitial();\nfunction activeWireHold() {}\n' + slice('function activeBusyNow()', '// The finger left') + RENDER() + '\nreturn renderAgents;')(...names2.map((n) => e[n]));
  fn();
  assert.strictEqual(treeCalls, 0);
  assert.match(list.innerHTML, /data-group="primary"><span>Primary \(2\)/);
  assert.match(list.innerHTML, /data-group="specialist"><span>Specialists \(3\)/);
  assert.ok(!/tm-line/.test(list.innerHTML));
});


// The outer HTML of the block (a div with the given class prefix) whose first agent row is `name`.
function blockOf(h, cls, name) {
  const re = new RegExp(`<div class="${cls}[^"]*">`, 'g'); let m;
  while ((m = re.exec(h))) {
    if (new RegExp('^(?:(?!<div class="tm-block)[\\s\\S])*?data-agent="' + name + '"').test(h.slice(m.index + m[0].length, m.index + m[0].length + 900)) === false) continue;
    let depth = 0; const tag = /<(\/?)div\b/g; tag.lastIndex = m.index; let t;
    while ((t = tag.exec(h))) { depth += t[1] ? -1 : 1; if (!depth) return h.slice(m.index, h.indexOf('>', tag.lastIndex) + 1); }
  }
  return null;
}
test('Simple CSS (phone): worker < leader < main in name, icon and row height; sublines >= 0.7rem or 12px; tap targets >= 36px', () => {
  const rule = (sel, prop) => {   // the last rule for this exact selector that sets prop (the sheet and the wide sidebar both restyle .sa-row)
    const re = new RegExp('^\\s*' + sel.replace(/[.#]/g, '\\$&').replace(/ /g, '\\s+') + ' \\{([^}]*)\\}', 'gm');
    const all = [...html.matchAll(re)].map((m) => m[1]).filter((d) => !prop || d.includes(prop + ':'));
    assert.ok(all.length, sel); return all[all.length - 1];
  };
  const num = (decl, prop) => { const m = decl.match(new RegExp(prop + ': ([\\d.]+)(px|rem)')); assert.ok(m, prop + ' in ' + decl); return m[2] === 'rem' ? parseFloat(m[1]) * 16 : parseFloat(m[1]); };
  const sheet = {
    main: [num(rule('html.mm-simple .sa-txt b', 'font-size'), 'font-size'), num(rule('html.mm-simple .sa-ic', 'font-size'), 'font-size'), num(rule('html.mm-simple .sa-row', 'min-height'), 'min-height'), num(rule('html.mm-simple .sa-rank-main .sa-txt small', 'font-size'), 'font-size')],
    leader: [num(rule('html.mm-simple .sa-rank-leader .sa-txt b', 'font-size'), 'font-size'), num(rule('html.mm-simple .sa-rank-leader .sa-ic', 'font-size'), 'font-size'), num(rule('html.mm-simple .sa-rank-leader', 'min-height'), 'min-height'), num(rule('html.mm-simple .sa-rank-leader .sa-txt small', 'font-size'), 'font-size')],
    worker: [num(rule('html.mm-simple .sa-rank-worker .sa-txt b', 'font-size'), 'font-size'), num(rule('html.mm-simple .sa-rank-worker .sa-ic', 'font-size'), 'font-size'), num(rule('html.mm-simple .sa-rank-worker', 'min-height'), 'min-height'), num(rule('html.mm-simple .sa-rank-worker .sa-txt small', 'font-size'), 'font-size')],
  };
  for (let i = 0; i < 3; i++) assert.ok(sheet.worker[i] < sheet.leader[i] && sheet.leader[i] < sheet.main[i], 'sheet column ' + i + ' ' + JSON.stringify(sheet));
  assert.ok(sheet.worker[3] >= 11.2 && sheet.worker[2] >= 36);
  assert.match(rule('html.mm-simple .sa-rank-worker .sa-txt b'), /color: var\(--text-dim\)/);
  const side = (r) => [num(rule('html.mm-simple #simple-side .sa-rank-' + r + ' .sa-txt b', 'font-size'), 'font-size'), num(rule('html.mm-simple #simple-side .sa-rank-' + r + ' .sa-ic', 'font-size'), 'font-size'), num(rule('html.mm-simple #simple-side .sa-row.sa-rank-' + r, 'min-height'), 'min-height')];
  const sl = side('leader'), sw = side('worker');
  const sm = [num(rule('html.mm-simple #simple-side .sa-txt b', 'font-size'), 'font-size'), num(rule('html.mm-simple #simple-side .sa-ic', 'font-size'), 'font-size'), num(rule('html.mm-simple #simple-side .sa-row', 'min-height'), 'min-height')];
  for (let i = 0; i < 3; i++) assert.ok(sw[i] < sl[i] && sl[i] < sm[i], 'side column ' + i);
  assert.ok(sw[2] >= 36);
});



test('renderAgents: the Teams branch and the repaint wiring are in the source', () => {
  assert.match(RENDER(), /teamsPaintSwitch\(\);\n\s+if \(teamsView\(\) === 'teams' && window\.hubTeams\) \{ list\.innerHTML = teamsListHtml\(\); return; \}/);
  assert.match(js, /querySelector\('#screen-agents \.view-switch'\)\?\.addEventListener\('click'/);
  assert.match(fnSource('simpleSidePaint'), /teamsView\(\)/, 'the sidebar repaints when the view changes');
});

// ── Simple mode ──
function simpleRun(view, busy, open, alone, extra) {
  const e = env({ alone, store: { 'hub-sidebar-view': view, 'hub-teams-open': JSON.stringify(open || {}) } });
  e.live = {}; for (const n of busy || []) e.live[n] = { busy: true };
  const mk = (tag) => {
    const x = { tag, children: [], dataset: {}, className: '', style: { props: {}, setProperty(k, v) { this.props[k] = v; } }, attrs: {}, _h: '', _t: '',
      classList: { add(c) { x.className += ' ' + c; } }, setAttribute(k, v) { x.attrs[k] = v; }, appendChild(c) { x.children.push(c); return c; }, ls: {}, addEventListener(t, fn) { x.ls[t] = fn; }, click(ev) { const e = Object.assign({ target: { closest: () => null }, stopPropagation() { this.stopped = true; } }, ev || {}); if (x.ls.click) x.ls.click(e); return e; },
      querySelector(sel) { return x.parts[sel] || (x.parts[sel] = mk('part')); }, parts: {},
      set textContent(v) { x._t = v; if (v === '') x.children = []; }, get textContent() { return x._t; },
      set innerHTML(v) { x._h = v; }, get innerHTML() { return x._h; } };
    return x;
  };
  e.document = { createElement: mk, querySelectorAll: () => [], getElementById: () => null };
  e.displayName = (n) => ((AGENTS.find((a) => a.name === n) || {}).display || n);
  e.agents = AGENTS; e.current = 'ann'; e.navigate = () => {}; e.simpleAgentListsRepaint = () => {};
  e.buildTeamStart = () => {}; e.buildTeamPending = new Set(); e.simpleMoreGet = () => false; e.simpleMoreSet = () => {}; e.simpleDotClass = () => '';
  e.simpleDotPaint = (el, n) => { if (el) el.className = 'sa-dot ' + e.simpleDotClass(n); };   // the "Working on" change paints Simple dots through this
  e.window = { hubTeams, hubSimple: { agentGroups: () => ({ primary: [], more: [] }) } };
  e.simpleAgentSheetModel = () => ({ primary: [], groups: [], hasMore: false, open: false });
  Object.assign(e, extra || {});
  const names2 = Object.keys(e);
  const src = TEAMS() + ['simpleTmLine', 'simpleTmPaint', 'simpleTeamsModel', 'buildingTeam', 'buildTeamBtnHtml', 'buildTeamActivate', 'simpleSwitch', 'simpleTeamsFill', 'simpleFoldFocus', 'simpleAgentRow', 'simpleAgentListFill'].map(fnSource).join('\n');
  const fill = new Function(...names2, src + '\nreturn { simpleAgentListFill, simpleTeamsModel };')(...names2.map((n) => e[n]));
  const box = mk('div');
  fill.simpleAgentListFill(box, { blurb: true });
  return { box, fill, e };
}

test('Simple: the sheet and the sidebar fill start with the same two-part switch', () => {
  assert.match(fnSource('simpleAgentListFill'), /if \(window\.hubTeams\) simpleSwitch\(list\);/);
  const { box } = simpleRun('agents');
  assert.strictEqual(box.children[0].className, 'sa-switch');
  assert.match(box.children[0].innerHTML, /data-view="all"[^>]*>All Agents<\/button><button[^>]*data-view="teams"[^>]*>Teams</);
  assert.match(fnSource('simpleAgentsFill'), /simpleAgentListFill\(d\.querySelector\('\.sa-list'\)/);
  assert.match(fnSource('simpleSideEnsure'), /ssd-list sa-list/);
});




// ── Build Team (phone) ──
const BUILD = () => ROW() + '\n' + fnSource('menuTeamSync');
// changed (Owner 2026-11-24 07:32: "Create a classification of solo agents" / "Instead of 'no team'"): the All Agents second line reads "Solo · Build team"
test('Build line: an admin sees "Solo · Build team" under a main agent with no team in All Agents; rows with a team and non-admins do not', () => {
  const e = env();
  const api = load(e, BUILD(), '{ agentRowHtml, buildNoTeam }');
  assert.deepStrictEqual([...api.buildNoTeam()], ['bea'], 'ann has a team, the rest are not main agents');
  const row = api.agentRowHtml(AGENTS[1], { build: true });
  // item 1: the words are the row's own second line (replacing the model name), never a line under the row
  assert.match(row, /<div class="agent-name">Bea &lt;b&gt;<\/div><div class="agent-model agent-build-sub">Solo · <span role="button" tabindex="0" class="build-team-link" data-build-team="bea">Build team<\/span><\/div><\/span>/);
  assert.ok(row.endsWith('</button>') && !/build-line/.test(row), 'nothing after the row button: no separate build-line');
  assert.strictEqual((row.match(/class="agent-model/g) || []).length, 1, 'one second line: the model name is replaced');
  assert.ok(!/build-line/.test(api.agentRowHtml(AGENTS[1])) && !/agent-build-sub/.test(api.agentRowHtml(AGENTS[1])), 'no option: the row is as before');
  assert.ok(!/agent-build-sub/.test(api.agentRowHtml(AGENTS[1], { build: true, done: true })), 'a done row keeps its own line');
  const m = load(env({ env: { isAdmin: () => false } }), BUILD(), 'buildNoTeam');
  assert.strictEqual(m().size, 0, 'a member sees no Build controls');
  // inside the row button the link is a span (a button cannot hold a button)
  assert.ok(!/<button type="button" class="build-team-link/.test(row));
});
test('Build line: renderAgents passes build only for the group rows (the source)', () => {
  assert.match(RENDER(), /const noTeam = buildNoTeam\(\);/);
  assert.match(RENDER(), /agentRowHtml\(a, \{ job: activeJobs\[a\.name\], build: noTeam\.has\(a\.name\) \}\)/);   // the loop only calls agentRowHtml; the works-alone decision is inside it
  assert.ok(!/active: true, job: activeJobs\[a\.name\], build/.test(RENDER()), 'not in the Active section: no duplicate line');
});

function fakeEl(over) { return Object.assign({ hidden: false, disabled: false, href: '', textContent: '' }, over); }
function menuRun({ admin = true, simple = false, cur = 'bea', live = {}, pending = [], alone = [] } = {}) {
  const els = { 'menu-agent-settings': fakeEl(), 'menu-build-team': fakeEl() };
  const e = env({ alone, env: { $: (id) => els[id], current: cur, live, isAdmin: () => admin, simpleOn: () => simple, agentByName: (n) => AGENTS.find((a) => a.name === n) } });
  const api = load(e, BUILD() + '\nfor (const p of ' + JSON.stringify(pending) + ') buildTeamPending.add(p);', '{ menuTeamSync }');
  api.menuTeamSync();
  return els;
}
test('chat ⋮ menu: Agent settings (admins) points at the agent settings page; Build team only for a main agent with no team', () => {
  let m = menuRun();
  assert.strictEqual(m['menu-agent-settings'].hidden, false);
  assert.strictEqual(m['menu-agent-settings'].href, '/agent-settings.html?agent=bea');
  assert.strictEqual(m['menu-build-team'].hidden, false);
  assert.strictEqual(m['menu-build-team'].disabled, false);
  m = menuRun({ cur: 'ann' });   // has a team
  assert.strictEqual(m['menu-build-team'].hidden, true);
  assert.strictEqual(m['menu-agent-settings'].hidden, false);
  m = menuRun({ cur: 'lia' });   // not a main agent
  assert.strictEqual(m['menu-build-team'].hidden, true);
  m = menuRun({ admin: false });
  assert.ok(m['menu-agent-settings'].hidden && m['menu-build-team'].hidden, 'members: neither');
  m = menuRun({ simple: true });
  assert.ok(m['menu-agent-settings'].hidden && m['menu-build-team'].hidden, 'Simple: neither');
  m = menuRun({ live: { ann: { buildingTeamFor: 'bea' } } });
  assert.strictEqual(m['menu-build-team'].disabled, true);
  assert.strictEqual(m['menu-build-team'].textContent, 'Building…');
  m = menuRun({ pending: ['bea'] });
  assert.strictEqual(m['menu-build-team'].disabled, true);
  assert.match(html, /<a id="menu-agent-settings" class="chat-only"[^>]*hidden>[^<]*Agent settings<\/a>/);
  assert.match(html, /<button id="menu-build-team" class="chat-only" hidden>/);
});

test('buildTeamStart: POST the route, 202 opens the lead chat, an error shows the server text; one request at a time', async () => {
  const run = async (status, body, over) => {
    const calls = [], nav = [], toasts = [];
    const e = env({ env: Object.assign({
      api: async (url, o) => { calls.push([url, o]); return { status, json: async () => body }; },
      navigate: (...a) => nav.push(a), toast: (t) => toasts.push(t), paintStatus() {},
    }, over || {}) });
    const api = load(e, BUILD(), '{ buildTeamStart }');
    await api.buildTeamStart('bea');
    return { calls, nav, toasts };
  };
  let r = await run(202, { ok: true, lead: 'ann', turnId: 't1' });
  assert.strictEqual(r.calls.length, 1);
  assert.strictEqual(r.calls[0][0], '/api/agents/bea/build-team');
  assert.strictEqual(r.calls[0][1].method, 'POST');
  assert.deepStrictEqual(r.nav, [['chat', 'ann']]);
  assert.deepStrictEqual(r.toasts, []);
  r = await run(409, { error: 'already building a team for Bea' });
  assert.deepStrictEqual(r.nav, []);
  assert.deepStrictEqual(r.toasts, ['already building a team for Bea']);
  r = await run(503, null);
  assert.match(r.toasts[0], /503/);
  r = await run(0, null, { api: async () => { throw new Error('offline'); } });
  assert.match(r.toasts[0], /offline/);
  // already building: no request
  const e = env({ env: { api: async () => { throw new Error('no call expected'); }, navigate() {}, toast() {}, paintStatus() {} } });
  e.live = { ann: { buildingTeamFor: 'bea' } };
  await load(e, BUILD(), 'buildTeamStart')('bea');
});

test('applySnapshot keeps buildingTeamFor in live entries, setLive clears it when idle, the list click starts a build', () => {
  // changed (Set up teams): the same key list also carries offerPending and settingUpTeams
  assert.match(slice('function applySnapshot(', 'let wkGoneState'), /'consultedBy', 'buildingTeamFor', 'reviewingTeamFor', 'offerPending', 'settingUpTeams'\]/);
  assert.match(slice('function setLive(', 'function paintStatus'), /next\.consultedBy = null; next\.buildingTeamFor = null; next\.reviewingTeamFor = null;/);
  assert.match(js, /const bt = e\.target\.closest\('\[data-build-team\]'\);\n\s+if \(bt\) \{ buildTeamActivate\(bt\); return; \}/);
  assert.match(js, /function buildTeamActivate\(bt\) \{ if \(!bt\.disabled && bt\.getAttribute\('aria-disabled'\) !== 'true'\) buildTeamStart\(bt\.dataset\.buildTeam\); \}/);
});

// ── the plan card ──
class El {
  constructor(tag) { this.tag = tag; this.kids = []; this.ls = {}; this.className = ''; this.value = ''; this.checked = false; this.disabled = false; this.textContent = ''; this.dataset = {}; this._h = ''; this.parsed = []; }
  set innerHTML(h) {
    this._h = h; this.parsed = [];
    for (const m of String(h).matchAll(/<(button|span|textarea|input)\b([^>]*)>/g)) {
      const c = new El(m[1]); c.className = (/class="([^"]+)"/.exec(m[2]) || [, ''])[1];
      if (m[1] === 'input') { c.value = (/value="([^"]*)"/.exec(m[2]) || [, ''])[1]; c.checked = /\bchecked\b/.test(m[2]); }
      this.parsed.push(c);
    }
  }
  get innerHTML() { return this._h; }
  get classList() { const o = this; return { add: (c) => { if (!o.className.split(' ').includes(c)) o.className += ' ' + c; }, remove: (c) => { o.className = o.className.split(' ').filter((x) => x && x !== c).join(' '); }, contains: (c) => o.className.split(' ').includes(c) }; }
  appendChild(c) { this.kids.push(c); return c; }
  addEventListener(t, f) { (this.ls[t] = this.ls[t] || []).push(f); }
  click() { for (const f of this.ls.click || []) f(); }
  all() { return [...this.parsed, ...this.kids.flatMap((k) => [k, ...k.all()])]; }
  querySelectorAll(sel) {
    if (sel === '.qcheck input') return this.all().filter((n) => n.tag === 'label' && n.className === 'qcheck').flatMap((n) => n.parsed.filter((p) => p.tag === 'input'));
    const last = sel.split(' ').pop();
    return this.all().filter((n) => (last[0] === '.' ? n.className.split(' ').includes(last.slice(1)) : n.tag === last));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
function questionRun(data) {
  const root = new El('div'); const calls = [];
  const e = {
    esc, shownQuestions: new Set(), questionBoxes: new Map(), questionTexts: new Map(), chatEl: () => root, scrollChat() {}, retireSoon() {}, toast() {}, current: 'ann',
    api: (url, o) => { calls.push([url, JSON.parse(o.body)]); return Promise.resolve({ ok: true }); },
    document: { createElement: (t) => new El(t) },
  };
  const names2 = Object.keys(e);
  new Function(...names2, fnSource('showQuestion') + '\nshowQuestion(' + JSON.stringify(data) + ');')(...names2.map((n) => e[n]));
  return { box: root.kids[0], calls };
}
const PLAN = { request_id: 'r1', agent: 'ann', questions: [{ question: 'Build a team for Bea?', options: [{ label: 'Do it' }, { label: 'Change something' }, { label: 'Not now' }], checklist: [{ id: 'c1', label: 'Add Lia', detail: 'a researcher' }, { id: 'c2', label: 'Bea reports to nobody' }, { id: 'c3', label: 'Model: cheaper' }] }] };
test('plan card: checkbox rows all ticked, no Skip and no typed answer, submit sends checked with the chosen option', () => {
  const { box, calls } = questionRun(PLAN);
  const rows = box.kids.find((k) => k.className === 'qchecks').kids;
  assert.strictEqual(rows.length, 3);
  assert.match(rows[0].innerHTML, /<input type="checkbox" value="c1" checked><span><strong>Add Lia<\/strong><small>a researcher<\/small><\/span>/);
  assert.ok(box.querySelectorAll('.qcheck input').every((i) => i.checked), 'all ticked at first');
  assert.ok(!box.kids.some((k) => k.className === 'qcustom'), 'no typed answer');
  const actions = box.kids[box.kids.length - 1];
  assert.ok(!/qskip/.test(actions.innerHTML), 'no Skip');
  const opts = box.kids.filter((k) => k.className.split(' ').includes('opt'));
  assert.strictEqual(opts.length, 3);
  const submit = actions.querySelector('.qsubmit');
  assert.strictEqual(submit.disabled, true, 'an option is needed first');
  box.querySelectorAll('.qcheck input')[1].checked = false;   // untick the second line
  opts[0].click(); submit.click();
  assert.deepStrictEqual(calls, [['/api/ask_response', { request_id: 'r1', answers: { 0: 'Do it' }, checked: ['c1', 'c3'], agent: 'ann' }]]);
});
test('plan card: a question without a checklist keeps the typed answer and Skip, and sends no checked', () => {
  const { box, calls } = questionRun({ request_id: 'r2', agent: 'ann', questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'Skip' }, { label: 'B' }] }] });
  assert.ok(box.kids.some((k) => k.className === 'qcustom'));
  assert.ok(/qskip/.test(box.kids[box.kids.length - 1].innerHTML));
  box.kids.find((k) => k.className.split(' ').includes('opt')).click();
  box.kids[box.kids.length - 1].querySelector('.qsubmit').click();
  assert.deepStrictEqual(calls[0][1], { request_id: 'r2', answers: { 0: 'A' }, agent: 'ann' });
});
test('mobile.html: Build/plan-card CSS uses variables only and gives 44px+ touch targets', () => {
  const css = html.split('\n').filter((l) => /build-line|build-team|tm-build|\.qcheck/.test(l)).join('\n');
  assert.ok(css.length > 100);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(css), 'no colour literals');
  assert.match(css, /\.build-team-btn \{[^}]*min-height: 44px/);
  assert.match(css, /\.build-team-link \{[^}]*min-height: 44px/);
  assert.match(css, /\.question \.qcheck input \{[^}]*width: 24px/);
});

// ── Works alone: the lead recorded that a main agent with no team needs none ──
test('works alone (phone All Agents): the group row passes build only without the record, so the line is gone (source)', () => {
  assert.ok(!/build: noTeam\.has\(a\.name\) && /.test(RENDER()), 'the loop stays plain');
  assert.match(js, /opts\.buildSub \|\| \(opts\.build && !worksAlone\(a\.name\) && !working && !bgN\)/);
  assert.match(js, /opts && opts\.build && worksAlone\(a\.name\) && !working && !bgN\n\s+\? '<div class="agent-model agent-build-sub agent-solo-sub">Solo<\/div>'/, 'a works-alone solo agent reads just Solo');
  assert.ok(!/buildLineHtml|class="build-line/.test(js), 'no build-line element any more');
  assert.match(js, /function worksAlone\(name\) \{\n  return isAdmin\(\) && !!\(teamSetup\.alone && Object\.prototype\.hasOwnProperty\.call\(teamSetup\.alone, name\)\) && !!window\.hubTeams && !window\.hubTeams\.hasTeam\(name, agents\);/);
  assert.match(js, /alone: d\.alone && typeof d\.alone === 'object' && !Array\.isArray\(d\.alone\) \? d\.alone : \{\}/);
});
test('works alone (phone ⋮ menu): Build team stays in the chat menu so it can be asked again', () => {
  const m = menuRun({ alone: ['bea'] });
  assert.strictEqual(m['menu-build-team'].hidden, false);
  assert.strictEqual(m['menu-build-team'].disabled, false);
});
test('works alone (phone): a team under the agent ends it at once (the record no longer counts)', () => {
  const real = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
  assert.match(real, /!window\.hubTeams\.hasTeam\(name, agents\)/);
});

// ── Simple says what is shown and what exists ──

test('Build team sub-line (phone): one line, never wrapped (the row keeps its height); Build team stays whole', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'mobile.html'), 'utf8');
  assert.match(css, /\.agent-build-sub \{[^}]*overflow: visible;[^}]*white-space: nowrap;[^}]*text-overflow: clip;/);
});

// ── an old server: GET /api/team-setup has no 'alone' ──

// ── phone All Agents: the Build line for an admin's no-team main agent that is NOT marked works alone (the page's real worksAlone / teamSetup state) ──
test('All Agents (phone): an admin sees "Solo · Build team" under every no-team main not marked works alone, whatever the number of mains; a works-alone one and a member see none', () => {
  const many = [];
  for (let i = 1; i <= 20; i++) many.push({ name: 'main' + i, display: 'Main ' + i, category: 'primary' });
  many.push({ name: 'w1', display: 'W1', category: 'worker', reportsTo: 'main1' });   // main1 has a team
  const e = env({ env: { agents: many } });
  const api = load(e, BUILD(), '{ agentRowHtml, buildNoTeam, teamSetup }');
  const noTeam = api.buildNoTeam();
  assert.strictEqual(noTeam.size, 19);
  const line = (a, set = noTeam) => /<div class="agent-model agent-build-sub">Solo · <span role="button" tabindex="0" class="build-team-link" data-build-team="main17">Build team<\/span><\/div>/.test(api.agentRowHtml(a, { build: set.has(a.name) }));
  const m17 = many.find((a) => a.name === 'main17');
  assert.ok(line(m17), 'not marked works alone: the line shows (the real worksAlone state, no stub)');
  assert.ok(!/agent-build-sub/.test(api.agentRowHtml(many[0], { build: noTeam.has('main1') })), 'main1 has a team');
  api.teamSetup.alone = { main17: { at: null, reason: 'r' } };
  // changed (design lead + Maestro): every solo agent's second line starts with 'Solo'; a works-alone one reads just 'Solo', with no Build team link
  assert.match(api.agentRowHtml(m17, { build: noTeam.has('main17') }), /<div class="agent-model agent-build-sub agent-solo-sub">Solo<\/div>/, 'marked works alone: just Solo');
  assert.ok(!/build-team-link/.test(api.agentRowHtml(m17, { build: noTeam.has('main17') })), 'works alone: no link');
  assert.ok(/agent-build-sub/.test(api.agentRowHtml(many.find((a) => a.name === 'main16'), { build: noTeam.has('main16') })), 'the others still show it');
  const mem = load(env({ env: { agents: many, isAdmin: () => false } }), BUILD(), '{ agentRowHtml, buildNoTeam }');
  assert.ok(!/agent-build-sub/.test(mem.agentRowHtml(m17, { build: mem.buildNoTeam().has('main17') })));
});

// ── design review item 1: All Agents rows keep their height ──
test('item 1 (All Agents): no .build-line CSS; the build sub-line is one nowrap line with a tap area of at least 36px made by padding and negative margin', () => {
  assert.ok(!/\.build-line\b/.test(html), 'the line-under-the-row rule is gone');
  const sub = html.match(/\.agent-build-sub \{([^}]*)\}/)[1];
  assert.match(sub, /white-space: nowrap/);
  const link = html.match(/\.agent-build-sub \.build-team-link \{([^}]*)\}/)[1];
  assert.match(link, /padding: 10px 8px/);
  assert.match(link, /margin: -10px -8px -10px -2px/);
  // font 14px (Simple) .. 0.85rem: line-height 1.25 plus 2 x 10px of padding is at least 36px
  assert.ok(14 * 1.25 + 20 >= 36);
});

// ── design review items 2, 3, 6 (phone Simple) ──
test('item 3 (phone Simple): the build link is styled with a 37px tap area and the small words do not clip it', () => {
  assert.match(html, /html\.mm-simple \.sa-txt small\.sa-sub\.sa-build-sub \{ overflow: visible; \}/);
  const link = html.match(/html\.mm-simple \.sa-sub \.build-team-link \{([^}]*)\}/)[1];
  assert.match(link, /padding: 10px 8px/);
  assert.match(link, /margin: -10px -8px -10px -2px/);
});

// ── item 1 (phone Simple): a leader's workers behind the leader's own fold arrow ──

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The Teams list redesign (teams-list-design.md): section headers with counts, the size pill as the fold control, one-line members,
// Build team only in "Solo agents" (changed Owner 2026-11-24 07:32: "Create a classification of solo agents" / "Instead of 'no team'"), Simple shows the whole tree. (Replaces the tests of the fold-arrow column, the 'Reports to'
// lines, 'Works alone' words and Simple's hidden workers; what they guarded is kept below under the new markup.)
// ════════════════════════════════════════════════════════════════════════════════════════════════
const OPEN_ALL = JSON.stringify({ ann: true, lia: true, lou: true, '@other': true });
const rowOf = (h, name) => { const i = h.indexOf('data-agent="' + name + '"'); assert.ok(i >= 0, name); const s = h.lastIndexOf('<div class="tm-line', i); const j = h.indexOf('<div class="tm-line', i); return h.slice(s, j < 0 ? h.length : j); };
const cssRule = (sel) => { const m = html.match(new RegExp('^\\s*' + sel.replace(/[.#>:()[\]="\-, ]/g, (c) => '\\' + c) + ' \\{([^}]*)\\}', 'm')); assert.ok(m, sel); return m[1]; };
const px = (decl, prop) => { const m = decl.match(new RegExp('(?:^|[ ;])' + prop + ': ([\\d.]+)px')); assert.ok(m, prop + ' in ' + decl); return parseFloat(m[1]); };

test('Teams: headers with counts in order, empty sections left out, every agent exactly once', () => {
  const e = env({ store: { 'hub-teams-open': OPEN_ALL } });
  const h = teamsApi(e).teamsListHtml();
  assert.deepStrictEqual([...h.matchAll(/class="group-title tm-sec-h"[^>]*><span>([^<]+)</g)].map((m) => m[1]), ['Teams · 1', 'Solo agents · 1', 'Shared specialists · 1', 'Other · 1']);   // changed (Owner 2026-11-24 07:32: "Create a classification of solo agents" / "Instead of 'no team'"): "Solo agents" replaces "No team yet"
  assert.deepStrictEqual(names(h).sort(), AGENTS.map((a) => a.name).sort());
  assert.ok(h.indexOf('Teams · 1') < h.indexOf('data-agent="ann"') && h.indexOf('data-agent="wyn"') < h.indexOf('Solo agents · 1') && h.indexOf('data-agent="bea"') < h.indexOf('Shared specialists · 1'));
  assert.doesNotMatch(h, /Your agents|Working alone|No team yet/, 'old headings gone; an empty section is not shown');
  // only mains with nobody under them: two no-team mains, one recorded as working alone: ONE section holds both (changed Owner 2026-11-24 07:32: "Create a classification of solo agents" / "Instead of 'no team'")
  const e2 = env({ alone: ['bea'] }); e2.agents = [...AGENTS, { name: 'cy', display: 'Cy', category: 'primary' }];
  const h2 = teamsApi(e2).teamsListHtml();
  assert.deepStrictEqual([...h2.matchAll(/class="group-title tm-sec-h"[^>]*><span>([^<]+)</g)].map((m) => m[1]), ['Teams · 1', 'Solo agents · 2', 'Shared specialists · 1', 'Other · 1']);
  assert.doesNotMatch(h2, /Working alone|No team yet/);
  // the lead stays first in its own section, with its crown
  assert.ok(h.indexOf('data-agent="ann"') < h.indexOf('data-agent="bea"') && /Ann<\/span> <span class="lead-badge"/.test(h));
  const lone = env(); lone.agents = [AGENTS[0]];
  const hl = teamsApi(lone).teamsListHtml();
  assert.doesNotMatch(hl, /Teams · |Shared|Other · /, 'no team, no shared, no other: only "Solo agents"');
  assert.match(hl, /Solo agents · 1/);
});

test('Teams: section headers are 44px buttons pinned to the top of the list (sticky), with aria-expanded', () => {
  const h = teamsApi(env()).teamsListHtml();
  assert.match(h, /<button type="button" class="group-title tm-sec-h" data-fold="@sec:teams" data-tm-sec="teams" aria-expanded="true">/);
  assert.match(h, /data-fold="@other" data-tm-sec="other" aria-expanded="false"/, 'Other keeps its key and starts folded');
  const rule = cssRule('.tm-sec-h');
  assert.match(rule, /position: sticky/);
  assert.match(rule, /top: 0/);
  assert.strictEqual(px(rule, 'height'), 44);
  assert.ok(px(rule, 'min-height') >= 44);
  assert.match(rule, /z-index: \d+/);
  assert.match(rule, /background: var\(--bg-dark\)/, 'opaque, so rows scroll under it');
  assert.match(html, /<div class="scroll" id="agents-list">/, 'the list itself is the scroll container the header sticks in');
});

test('Teams: a header folds its section and remembers it in hub-teams-open under @sec:<key> (sections start open); Other keeps @other', () => {
  const e = env({ store: { 'hub-teams-open': '{"ann":true}' } });
  const api = teamsApi(e);
  assert.ok(api.teamsListHtml().includes('data-agent="lia"'));
  api.teamsToggle('@sec:teams');
  assert.strictEqual(e.store['hub-teams-open'], '{"ann":true,"@sec:teams":true}');
  let h = api.teamsListHtml();
  assert.match(h, /data-fold="@sec:teams" data-tm-sec="teams" aria-expanded="false"><span>Teams · 1<\/span><span aria-hidden="true">&#x25B8;/);
  assert.ok(!h.includes('data-agent="ann"') && h.includes('data-agent="bea"'), 'the folded section shows its header only; the others stay');
  api.teamsToggle('@sec:teams');
  assert.ok(teamsApi(e).teamsListHtml().includes('data-agent="ann"'));
  // Other: folded at start, stored true = open (as before)
  assert.ok(!h.includes('data-agent="xan"'));
  api.teamsToggle('@other');
  assert.ok(api.teamsListHtml().includes('data-agent="xan"'));
  // the working filter shows everything: the headers are plain text then
  const f = env(); f.workingFilter = true; f.live = { wyn: { busy: true } };
  h = teamsApi(f).teamsListHtml();
  assert.match(h, /<div class="group-title tm-sec-h"><span>Teams · 1<\/span><\/div>/);
  assert.deepStrictEqual(names(h), ['ann', 'lou', 'wyn']);
});

test('Teams: the size pill is a button (aria-expanded, aria-label) after the boss\'s name; the left fold arrow column is gone; mains start folded, leaders start open', () => {
  const e = env();
  let h = teamsApi(e).teamsListHtml();
  assert.match(h, /Ann<\/span> <span class="lead-badge" title="Lead agent">👑<\/span><button type="button" class="tm-pill-btn" data-fold="ann" aria-expanded="false" aria-label="Unfold Ann: 5 agents" title="Unfold Ann: 5 agents"><span class="tm-pill">5 agents &#x25B8;<\/span><\/button>/);
  assert.doesNotMatch(h, /tm-fold|tm-block|tm-kids|tm-leaders/);
  assert.deepStrictEqual(names(h).sort(), ['ann', 'bea', 'sam'], 'mains and shared only: folded at start, Other folded');
  e.store['hub-teams-open'] = JSON.stringify({ ann: true });
  h = teamsApi(e).teamsListHtml();
  assert.match(h, /data-fold="ann" aria-expanded="true" aria-label="Fold Ann: 5 agents" title="Fold Ann: 5 agents"><span class="tm-pill">5 agents &#x25BE;/);
  // changed (the owner's request 2026-11-24 07:30: opening a team shows the whole team): a leader's pill reads like a main's ('2 agents'), its workers are open at start, its key is '@fold:<name>'
  assert.match(h, /data-fold="@fold:lia" aria-expanded="true" aria-label="Fold Lia: 2 agents" title="Fold Lia: 2 agents"><span class="tm-pill">2 agents &#x25BE;/);
  assert.doesNotMatch(h, /leads/);
  assert.ok(h.includes('data-agent="lia"') && h.includes('data-agent="lou"') && h.includes('data-agent="wes"') && h.includes('data-agent="wyn"'), 'a leader open: its workers shown');
  assert.ok(!/data-fold="wes"|data-fold="sam"|data-fold="bea"/.test(h), 'rows with nobody under them have no pill');
  assert.match(teamsApi(env({ store: { 'hub-teams-open': '{"@fold:lou":true,"ann":true}' } })).teamsListHtml(), /Fold Lia: 2 agents[^>]*>[\s\S]*Unfold Lou: 1 agent"/);
  const one = env({ store: { 'hub-teams-open': '{}' } }); one.agents = [{ name: 'a', display: 'A', category: 'primary' }, { name: 'b', display: 'B', category: 'worker', reportsTo: 'a' }];
  assert.match(teamsApi(one).teamsListHtml(), /1 agent &#x25B8;/, 'one agent, not "1 agents"');
});

test('Teams: rows with a pill are divs (a button may not hold a button) with role=button and tabindex; rows without stay buttons', () => {
  const h = teamsApi(env({ store: { 'hub-teams-open': OPEN_ALL } })).teamsListHtml();
  assert.match(rowOf(h, 'ann'), /<div role="button" tabindex="0" class="agent-row" data-agent="ann">[\s\S]*<\/div><\/div>$/);
  assert.match(rowOf(h, 'wes'), /<button class="agent-row" data-agent="wes">/);
  assert.match(rowOf(h, 'lia'), /<div role="button" tabindex="0" class="agent-row" data-agent="lia">/);
  // no <button> nested in a <button>
  for (const m of h.matchAll(/<button class="agent-row"[^>]*>([\s\S]*?)<\/button>/g)) assert.ok(!/<button/.test(m[1]), 'nested button');
  // Enter / Space on the row itself opens the chat (the keydown wiring)
  assert.match(js, /e\.target\.matches\('div\.agent-row\[role="button"\]'\)/);
  assert.match(js, /if \(dr && \(e\.key === 'Enter' \|\| e\.key === ' '\)\) \{ e\.preventDefault\(\); navigate\('chat', dr\.dataset\.agent\); \}/);
});

// The list's own click handler, run on fake targets: closest(selector) answers from a map.
function clickRun() {
  const src = slice("$('agents-list').addEventListener('click', (e) => {", "$('bg-chip')?.addEventListener");
  const calls = [];
  let handler = null;
  const list = { addEventListener: (t, fn) => { if (t === 'click') handler = fn; }, querySelectorAll: () => [] };
  const e = env({ env: { $: () => list, navigate: (...a) => calls.push(['navigate', ...a]), teamSetupStart: () => calls.push(['setup']), teamSetupUndo: () => calls.push(['undo']), buildTeamActivate: (bt) => calls.push(['build', bt.dataset.buildTeam]), bgOpenChat: (n) => calls.push(['bg', n]), renderAgents: () => calls.push(['render']), collapsed: {} } });
  const api = teamsApi(e);
  load(Object.assign(e, { teamsToggle: (k) => { calls.push(['toggle', k]); api.teamsToggle(k); } }), src, 'null');
  const fire = (map) => { const ev = { target: { closest: (sel) => map[sel] || null }, stopped: false, stopPropagation() { this.stopped = true; } }; handler(ev); return ev; };
  return { calls, fire, e };
}
test('Teams click: the pill folds, stops the click and never opens the chat; the rest of the row opens the chat; a header folds', () => {
  const { calls, fire } = clickRun();
  const pill = { dataset: { fold: 'ann' }, focus() {} };
  const row = { dataset: { agent: 'ann' } };
  const ev = fire({ '[data-fold]': pill, '.agent-row': row });   // a tap on the pill is inside the row too
  assert.ok(ev.stopped, 'stopPropagation');
  assert.deepStrictEqual(calls, [['toggle', 'ann'], ['render']], 'folds, repaints, no navigate');
  calls.length = 0;
  fire({ '.agent-row': row });
  assert.deepStrictEqual(calls, [['navigate', 'chat', 'ann']]);
  calls.length = 0;
  fire({ '[data-fold]': { dataset: { fold: '@sec:solo' }, focus() {} } });
  assert.deepStrictEqual(calls, [['toggle', '@sec:solo'], ['render']]);
  calls.length = 0;
  fire({ '.dot.bg-work, .agent-bg-line': {}, '.agent-row': row });   // the ring / blue line: the chat with Working on open (as before)
  assert.deepStrictEqual(calls, [['bg', 'ann']]);
  calls.length = 0;
  fire({ '[data-build-team]': { dataset: { buildTeam: 'bea' } }, '.agent-row': { dataset: { agent: 'bea' } } });   // the Build team link: before the row, never opens the chat
  assert.deepStrictEqual(calls, [['build', 'bea']]);
  calls.length = 0;
  fire({ '[data-team-setup]': { disabled: false } });
  fire({ '[data-team-undo]': {} });
  assert.deepStrictEqual(calls, [['setup'], ['undo']], 'Set up teams and Undo keep their handlers');
  assert.match(js, /'\[data-fold\]'\);   \/\/ the size pill and the section headers/);
});

test('Teams CSS (phone): the pill looks 20px tall but is a button at least 36px tall and wide; the negative margin keeps row heights', () => {
  const btn = cssRule('.tm-pill-btn'), pill = cssRule('.tm-pill');
  assert.ok(px(btn, 'height') >= 36 && px(btn, 'min-width') >= 36);
  assert.strictEqual(px(pill, 'height'), 20);
  assert.match(btn, /flex: none/, 'the pill never shrinks');
  assert.match(btn, /margin: -8px 0 -8px 6px/, '6px after the name, 36 - 16 = 20px of layout height');
  assert.match(pill, /white-space: nowrap/);
  assert.match(cssRule('.tm-l1 .agent-name'), /flex: 0 1 auto; min-width: 0/, 'the name truncates first');
  assert.match(cssRule('.tm-live'), /flex: 0 1000 auto/, 'the busy words give way before the name does');
});

test('Teams CSS (phone): ranks 60/48/36px with 16/14/13px names and the design\'s x positions; the dot stays at the right (centre at 366 of 390)', () => {
  const main = cssRule('.tm-line.tm-r-main > .agent-row'), leader = cssRule('.tm-line.tm-r-leader > .agent-row'), worker = cssRule('.tm-line.tm-r-worker > .agent-row');
  assert.deepStrictEqual([px(main, 'height'), px(leader, 'height'), px(worker, 'height')], [60, 48, 36]);
  assert.deepStrictEqual([px(main, 'min-height'), px(leader, 'min-height'), px(worker, 'min-height')], [60, 48, 36]);
  assert.strictEqual(px(cssRule('.tm-line.tm-r-main .agent-name'), 'font-size'), 16);
  assert.strictEqual(px(cssRule('.tm-line.tm-r-spec .agent-name, .tm-line.tm-r-leader .agent-name'), 'font-size'), 14);
  assert.strictEqual(px(cssRule('.tm-line.tm-r-worker .agent-name'), 'font-size'), 13);
  assert.match(cssRule('.tm-line.tm-r-worker .agent-name'), /color: var\(--text-dim\)/);
  // main: padding 14 + icon 36 (14-50) + gap 12 -> name 62; the dot (10px) ends 19px from the right edge: centre 390 - 19 - 5 = 366
  assert.strictEqual(14 + px(cssRule('.agent-icon'), 'width') + px(main, 'gap'), 62);
  assert.match(main, /padding: 0 19px 0 14px/);
  // leader: icon at 64, 28 wide -> 92, gap 10 -> name 102; member: 64, 22 -> 86, gap 8 -> 94; leader's workers: icon 104 -> name 134
  assert.match(leader, /padding: 0 19\.5px 0 64px/); assert.strictEqual(64 + 28 + px(leader, 'gap'), 102);
  assert.match(worker, /padding: 0 20px 0 64px/); assert.strictEqual(64 + 22 + px(worker, 'gap'), 94);
  assert.strictEqual(px(cssRule('.tm-line.tm-r-worker.tm-lv2 > .agent-row'), 'padding-left') + 22 + 8, 134);
  assert.strictEqual(px(cssRule('.tm-line.tm-r-leader .dot, .tm-line.tm-r-spec .dot'), 'width'), 9);
  assert.strictEqual(px(cssRule('.tm-line.tm-r-worker .dot'), 'width'), 8);
  // joining lines at 32 and 78, starting under the boss's icon
  assert.match(cssRule('.tm-line'), /--tm-x1: 32px; --tm-x2: 78px/);
  assert.match(cssRule('.tm-line'), /--tm-from: 48px/);
  assert.match(cssRule('.tm-line.tm-r-leader, .tm-line.tm-r-spec'), /--tm-from: 38px/);
  assert.match(cssRule('.tm-v'), /width: 1px; background: var\(--border-strong\)/);
  assert.match(cssRule('.tm-v.tm-end'), /height: calc\(var\(--tm-h\) \/ 2\)/, 'the line stops at the middle of the last row');
  // every colour from a variable
  const css = html.split('\n').filter((l) => /\.tm-|sa-tm|sa-sec-h|sa-l1|sa-live/.test(l)).join('\n');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(css));
  // the left fold column and the wrappers are gone
  assert.ok(!/\.tm-fold|\.tm-kids|\.tm-leaders|\.tm-block|--tm-bar|--tm-kid/.test(html));
});

test('Teams rows: members one line each, no "Reports to", no "Team leader" or "team of N" lines; the lines join each group', () => {
  const h = teamsApi(env({ store: { 'hub-teams-open': OPEN_ALL } })).teamsListHtml();
  assert.doesNotMatch(h, /Reports to|Team leader|team of|teams · |Worker</);
  for (const n of ['lia', 'lou', 'wes', 'wil', 'wyn', 'sam']) assert.ok(!/class="agent-model/.test(rowOf(h, n)), n + ': one line');
  assert.match(rowOf(h, 'wes'), /^<div class="tm-line tm-r-worker tm-lv2">/);
  assert.match(rowOf(h, 'lia'), /^<div class="tm-line tm-r-leader tm-lv1"><i class="tm-v tm-x1"[^>]*><\/i><i class="tm-tk tm-x1"[^>]*><\/i><i class="tm-v tm-x2 tm-from"/, 'a leader with workers: line at 32 through it, its own line from under its icon');
  assert.match(rowOf(h, 'lou'), /<i class="tm-v tm-x1 tm-end"/, 'the last one under the main: its line ends at its middle');
  assert.match(rowOf(h, 'ann'), /<i class="tm-v tm-x1 tm-from"/, 'the main row starts the line under its icon');
  assert.match(rowOf(h, 'wil'), /<i class="tm-v tm-x1"[^>]*><\/i><i class="tm-v tm-x2 tm-end"[^>]*><\/i><i class="tm-tk tm-x2"/, 'lia is not last: the 32 line goes on through her workers; the last worker ends the 78 line');
  assert.match(rowOf(h, 'wyn'), /^<div class="tm-line tm-r-worker tm-lv2"><i class="tm-v tm-x2 tm-end"/, 'lou is the last: no 32 line beside her worker');
  // every member starts right of its boss's name: levels give the padding (64 / 104 against names at 62 / 102 / 94)
  assert.ok(64 >= 62 && 104 >= 102 && 104 >= 94);
});

test('Teams rows: second line only when there is something (replying, else Free with background work, else Build team in Solo agents); the row keeps 60px', () => {
  const bg = { bgStateOf: (n) => (n === 'bea' ? 'background' : 'free'), bgCountOf: (n) => (n === 'bea' ? 2 : 0) };
  const hb = teamsApi(env({ env: bg })).teamsListHtml();
  assert.match(rowOf(hb, 'bea'), /<div class="agent-bg-line" role="button"[^>]*>[^<]*<\/div>/);
  assert.ok(!/build-team/.test(rowOf(hb, 'bea')), 'background work wins over Build team');
  assert.match(rowOf(hb, 'bea'), /dot idle bg-work|bg-work/);
  const e = env(); e.live = { bea: { busy: true } };
  assert.match(rowOf(teamsApi(e).teamsListHtml(), 'bea'), /<div class="agent-model working">bea is working<\/div>/, 'replying wins');
  assert.ok(!/build-team/.test(rowOf(teamsApi(e).teamsListHtml(), 'bea')));
  const plain = rowOf(teamsApi(env()).teamsListHtml(), 'ann');
  assert.ok(!/agent-model|agent-bg-line|build-team/.test(plain), 'a main with nothing to say has no second line (the name is centred)');
  assert.match(cssRule('.tm-line.tm-r-main > .agent-row'), /height: 60px/);
  assert.match(cssRule('.tm-line .agent-meta'), /justify-content: center/);
  assert.match(cssRule('.tm-line.tm-r-main .agent-model.working'), /white-space: nowrap/, 'one line');
  // a working member: no second line; its words follow the name on the same line
  const e2 = env({ store: { 'hub-teams-open': OPEN_ALL } }); e2.live = { wes: { busy: true } };
  const w = rowOf(teamsApi(e2).teamsListHtml(), 'wes');
  assert.match(w, /<span class="agent-name">Wes<\/span><span class="tm-live">· wes is working<\/span><\/div><\/span>/);
  assert.ok(!/agent-model/.test(w));
  assert.match(cssRule('.tm-live'), /color: var\(--warning\)/);
});

test('Teams: Build team only for an undecided main in Solo agents, for admins; none and no "Works alone" words on a works-alone one (same section, same row height); Building… disabled; the handler is unchanged', () => {
  const h = teamsApi(env({ store: { 'hub-teams-open': OPEN_ALL } })).teamsListHtml();
  assert.strictEqual((h.match(/data-build-team=/g) || []).length, 1);
  assert.match(rowOf(h, 'bea'), /<div class="agent-model agent-build-sub agent-build-only"><span role="button" tabindex="0" class="build-team-link" data-build-team="bea">Build team<\/span><\/div>/, 'just "Build team", the header already says Solo agents');
  assert.doesNotMatch(h, /Solo ·\s*<span|No team yet|Solo<\//, 'the words are not repeated on the row');
  assert.ok(!/build-team-btn|class="tm-build"|build-line/.test(h));
  const alone = teamsApi(env({ alone: ['bea'] })).teamsListHtml();
  assert.match(alone, /Solo agents · 1/);
  assert.doesNotMatch(alone, /Works alone|Working alone|build-team|No team yet/);
  assert.ok(!/agent-model/.test(rowOf(alone, 'bea')), 'a working-alone row is one name, nothing under it');
  const member = teamsApi(env({ alone: ['bea'], env: { isAdmin: () => false } })).teamsListHtml();
  assert.match(member, /Solo agents · 1/, 'a member has no works-alone record: bea is under Solo agents');
  assert.doesNotMatch(member, /build-team|Working alone|No team yet/);
  const e = env({ store: { 'hub-teams-open': OPEN_ALL } }); e.live = { ann: { busy: true, buildingTeamFor: 'bea' } };
  assert.match(teamsApi(e).teamsListHtml(), /<span role="button" tabindex="0" class="build-team-link" data-build-team="bea" aria-disabled="true">Building…<\/span>/);
  // an old server (no alone in GET /api/team-setup): the normal Build team line, nothing throws
  const old = load(env({ store: { 'hub-teams-open': '{}' } }), TEAMS() + '\n' + ROW() + "\nteamSetup = { offer: null, lead: null, setups: [] };", '{ teamsListHtml, worksAlone }');
  assert.match(old.teamsListHtml(), /data-build-team="bea"/);
  assert.strictEqual(old.worksAlone('bea'), false);
  // the chat menu keeps Build team (also for a working-alone agent), see "works alone (phone ⋮ menu)"
  assert.match(js, /const bt = e\.target\.closest\('\[data-build-team\]'\);\n\s+if \(bt\) \{ buildTeamActivate\(bt\); return; \}/);
});

test('Teams: the helpers line, the working filter and the empty state keep working under the new rows', () => {
  const e = env({ store: { 'hub-teams-open': JSON.stringify({ ann: true }) } });
  e.live = { h1: { busy: true, worker: true, parent: 'ann' }, h2: { busy: true, worker: true, parent: 'ann' }, h3: { busy: true, worker: true, parent: 'bea' } };
  const h = teamsApi(e).teamsListHtml();
  assert.match(h, /⚡ 2 helpers under Ann/);
  assert.match(h, /⚡ 1 helper under Bea &lt;b&gt;/);
  assert.ok(h.indexOf('data-agent="lou"') < h.indexOf('2 helpers under Ann'), 'after the node\'s children');
  const f = env(); f.workingFilter = true; f.live = { wyn: { busy: true } };
  assert.deepStrictEqual(names(teamsApi(f).teamsListHtml()), ['ann', 'lou', 'wyn'], 'busy rows and their bosses, everything open');
  f.live = {};
  assert.match(teamsApi(f).teamsListHtml(), /No agent is working right now\./);
  const nt = env(); nt.workingFilter = true; nt.agents = [AGENTS[0], AGENTS[1], AGENTS[7]];
  assert.doesNotMatch(teamsApi(nt).teamsListHtml(), /Agents can work as teams/);
  const lone = env(); lone.agents = [AGENTS[0], AGENTS[1], AGENTS[7]];
  const hl = teamsApi(lone).teamsListHtml();
  assert.ok(hl.startsWith('<div class="tm-empty"><b>Agents can work as teams.</b> Your main agents plan, decide and review. Short or personal tasks they usually do themselves; long work they can hand to team leaders, who run workers. Ann can look at how your agents already work together and propose teams. Nothing changes until you approve a team. <button type="button" class="tm-setup-btn" data-team-setup>Set up teams</button></div>'));
  assert.match(hl, /Solo agents · 2/);
  assert.match(teamsApi(Object.assign(env({ env: { isAdmin: () => false } }), { agents: lone.agents })).teamsListHtml(), /An admin can set who reports to whom\./);
  // the Undo line closes the list
  const u = env({ store: { 'hub-teams-open': '{}' } });
  const api = load(u, TEAMS() + '\n' + ROW() + "\nteamSetup.setups = [{ id: 's1', at: '2026-11-20T10:00:00Z', main: 'ann', count: 2 }];", '{ teamsListHtml }');
  assert.match(api.teamsListHtml(), /<div class="tm-setup-line">Team setup: 1 team recorded [^<]*· <button type="button" class="tm-setup-undo" data-team-undo>Undo<\/button><\/div>$/);
});

test('Teams: a shared specialist with agents under it gets the pill and its people like a team (nothing unreachable)', () => {
  const e = env({ store: { 'hub-teams-open': JSON.stringify({ sam: true }) } });
  e.agents = [...AGENTS, { name: 'tia', display: 'Tia', category: 'worker', reportsTo: 'sam' }];
  const h = teamsApi(e).teamsListHtml();
  assert.match(rowOf(h, 'sam'), /^<div class="tm-line tm-r-spec tm-lv0">/);
  assert.match(h, /data-fold="sam" aria-expanded="true"/);
  assert.ok(h.includes('data-agent="tia"') && h.indexOf('data-agent="sam"') < h.indexOf('data-agent="tia"'));
});

// ── Simple (phone sheet): the whole tree, same headers, pills, Build team link ──
const simpleRows = (box) => box.children.filter((c) => c.dataset && c.dataset.agent);
const simpleHeads = (box) => box.children.filter((c) => /sa-sec-h/.test(c.className));
test('Simple: the sheet and the sidebar fill start with the two-part switch; All Agents has no Teams rows', () => {
  assert.match(fnSource('simpleAgentListFill'), /if \(window\.hubTeams\) simpleSwitch\(list\);/);
  const { box } = simpleRun('agents');
  assert.strictEqual(box.children[0].className, 'sa-switch');
  assert.match(box.children[0].innerHTML, /data-view="all"[^>]*>All Agents<\/button><button[^>]*data-view="teams"[^>]*>Teams</);
  assert.strictEqual(box.children.length, 1, 'only the switch: the stubbed model has no rows');
  assert.match(fnSource('simpleAgentsFill'), /simpleAgentListFill\(d\.querySelector\('\.sa-list'\)/);
  assert.match(fnSource('simpleSideEnsure'), /ssd-list sa-list/);
});
test('Simple Teams: headers with counts; a leader\'s workers are in the tree and open at start; \'@fold:<leader>\' folds them', () => {
  const { box } = simpleRun('teams');
  assert.deepStrictEqual(simpleHeads(box).map((h) => h.parts['.sa-sec-t'].textContent), ['Teams · 1', 'Solo agents · 1', 'Shared specialists · 1', 'Other · 1']);
  assert.deepStrictEqual(simpleHeads(box).map((h) => h.attrs['aria-expanded']), ['true', 'true', 'true', 'false']);
  assert.deepStrictEqual(simpleRows(box).map((r) => r.dataset.agent), ['ann', 'bea', 'sam'], 'the main with a pill, folded; shared; Other folded');
  const open = simpleRun('teams', [], { ann: true }).box;
  // changed (the owner's request 2026-11-24 07:30: opening a team shows the whole team): the whole team shows, each leader's workers under it
  assert.deepStrictEqual(simpleRows(open).map((r) => r.dataset.agent), ['ann', 'lia', 'wes', 'wil', 'lou', 'wyn', 'bea', 'sam']);
  const folded = simpleRun('teams', [], { ann: true, '@fold:lia': true }).box;
  assert.deepStrictEqual(simpleRows(folded).map((r) => r.dataset.agent), ['ann', 'lia', 'lou', 'wyn', 'bea', 'sam'], 'lia folded by hand: its workers are not listed');
  const both = simpleRun('teams', [], { ann: true, lia: true }).box;   // an old stored lia -> true (meant open) does not fold
  assert.deepStrictEqual(simpleRows(both).map((r) => r.dataset.agent), ['ann', 'lia', 'wes', 'wil', 'lou', 'wyn', 'bea', 'sam']);
  const rows = simpleRows(both);
  assert.deepStrictEqual(rows.slice(0, 5).map((r) => (r.className.match(/sa-rank-(\w+)/) || [])[1]), ['main', 'leader', 'worker', 'worker', 'leader']);
  assert.deepStrictEqual(rows.slice(0, 5).map((r) => r.style.props['--d'] || ''), ['', '1', '2', '2', '1']);
  const lia = rows[1].parts['.sa-l1'].children.find((c) => c.className === 'tm-pill-btn');
  assert.strictEqual(lia.dataset.fold, '@fold:lia'); assert.strictEqual(lia.attrs['aria-expanded'], 'true'); assert.strictEqual(lia.attrs['aria-label'], 'Fold Lia: 2 agents');
  assert.match(lia.innerHTML, /^<span class="tm-pill">2 agents &#x25BE;<\/span>$/);
  assert.match(rows[2].className, /sa-kid2/);
  assert.ok(rows.every((r) => /sa-tm/.test(r.className)));
  const other = simpleRun('teams', [], { '@other': true }).box;
  assert.deepStrictEqual(simpleRows(other).map((r) => r.dataset.agent), ['ann', 'bea', 'sam', 'xan']);
});
test('Simple Teams: the pill is a button with aria-expanded and a label; a tap on it folds and never opens the chat; the row div takes Enter / Space', () => {
  const nav = [];
  const e = { navigate: (...a) => nav.push(a) };
  const { box } = simpleRun('teams', [], { ann: true }, [], e);
  const ann = box.children.find((c) => c.dataset && c.dataset.agent === 'ann');
  assert.strictEqual(ann.tag, 'div'); assert.strictEqual(ann.attrs.role, 'button'); assert.strictEqual(ann.attrs.tabindex, '0');
  const l1 = ann.parts['.sa-l1'];
  const pill = l1.children.find((c) => c.className === 'tm-pill-btn');
  assert.ok(pill, 'the pill sits in the name line, after the name');
  assert.strictEqual(pill.tag, 'button'); assert.strictEqual(pill.attrs.type === undefined ? pill.type : pill.attrs.type, 'button');
  assert.strictEqual(pill.attrs['aria-expanded'], 'true');
  assert.strictEqual(pill.attrs['aria-label'], 'Fold Ann: 5 agents');
  assert.match(pill.innerHTML, /^<span class="tm-pill">5 agents &#x25BE;<\/span>$/);
  const ev = pill.click();
  assert.ok(ev.stopped, 'stopPropagation');
  assert.deepStrictEqual(nav, [], 'the chat did not open');
  assert.match(fnSource('simpleAgentRow'), /pb\.addEventListener\('click', \(e\) => \{ if \(e && e\.stopPropagation\) e\.stopPropagation\(\); teamsToggle\(tm\.fold\); simpleAgentListsRepaint\(\); simpleFoldFocus\(tm\.fold\); \}\);/);
  // the row itself opens the chat
  ann.click({ target: { closest: () => null } });
  assert.deepStrictEqual(nav, [['chat', 'ann']]);
  // a member row is one line: no pill, one name
  const bea = box.children.find((c) => c.dataset && c.dataset.agent === 'bea');
  assert.strictEqual(bea.tag, 'button');
  assert.ok(!bea.parts['.sa-l1'].children.some((c) => c.className === 'tm-pill-btn'));
  assert.match(fnSource('simpleAgentRow'), /e\.target === b && \(e\.key === 'Enter' \|\| e\.key === ' '\)/);
});
test('Simple Teams: a header folds its section under @sec:<key> (Other keeps @other)', () => {
  const calls = [];
  const { box, e } = simpleRun('teams', [], {}, [], { simpleAgentListsRepaint: () => calls.push('repaint') });
  const heads = simpleHeads(box);
  heads[0].click();
  assert.strictEqual(e.store['hub-teams-open'], '{"@sec:teams":true}');
  heads[3].click();
  assert.strictEqual(e.store['hub-teams-open'], '{"@sec:teams":true,"@other":true}');
  assert.deepStrictEqual(calls, ['repaint', 'repaint']);
  const folded = simpleRun('teams', [], { '@sec:teams': true, '@sec:shared': true }).box;
  assert.deepStrictEqual(simpleRows(folded).map((r) => r.dataset.agent), ['bea']);
  assert.strictEqual(simpleHeads(folded)[0].attrs['aria-expanded'], 'false');
});
test('Simple Teams: Build team only for an undecided main in Solo agents for admins (the link; the row does not open the chat); a works-alone one has none; members see none', () => {
  const nav = [], built = [];
  const { box } = simpleRun('teams', [], {}, [], { navigate: (...a) => nav.push(a), buildTeamStart: (n) => built.push(n) });
  const bea = box.children.find((c) => c.dataset && c.dataset.agent === 'bea');
  assert.match(bea.parts['small'].innerHTML, /^<span role="button" tabindex="0" class="build-team-link" data-build-team="bea">Build team<\/span>$/);
  assert.match(bea.parts['small'].className, /sa-sub sa-build-sub/);
  const link = { dataset: { buildTeam: 'bea' }, disabled: false, getAttribute: () => null };
  const ev = bea.click({ target: { closest: (sel) => (sel === '[data-build-team]' ? link : null) } });
  assert.ok(ev.stopped); assert.deepStrictEqual(nav, [], 'the row did not open the chat'); assert.deepStrictEqual(built, ['bea']);
  const ann = box.children.find((c) => c.dataset && c.dataset.agent === 'ann');
  assert.ok(!/build-team/.test(ann.parts['small'].innerHTML || ''));
  const alone = simpleRun('teams', [], {}, ['bea']).box;
  assert.deepStrictEqual(simpleHeads(alone).map((h) => h.parts['.sa-sec-t'].textContent).slice(0, 3), ['Teams · 1', 'Solo agents · 1', 'Shared specialists · 1']);
  const ab = alone.children.find((c) => c.dataset && c.dataset.agent === 'bea');
  assert.ok(!/build-team|Works alone/.test((ab.parts['small'].innerHTML || '') + (ab.parts['small'].textContent || '')));
  const mem = simpleRun('teams', [], {}, [], { isAdmin: () => false }).box;
  const mb = mem.children.find((c) => c.dataset && c.dataset.agent === 'bea');
  assert.ok(!/build-team/.test(mb.parts['small'].innerHTML || '') && !/No team yet|Solo/.test(mb.parts['small'].textContent || ''));
  assert.match(fnSource('simpleTeamsModel'), /build: sec\.key === 'solo' && r\.level === 0 && r\.rank === 'main' && isAdmin\(\) && !r\.node\.size && !worksAlone\(r\.node\.agent\.name\)/);
});
test('Simple Teams: the status lines: replying (orange) beats background work beats Build team; a member\'s words follow its name; repainted in place', () => {
  const run = (busy, extra) => simpleRun('teams', busy, { ann: true, lia: true }, [], extra).box;
  const box = run(['bea']);
  const bea = box.children.find((c) => c.dataset && c.dataset.agent === 'bea');
  assert.strictEqual(bea.parts['small'].textContent, 'bea is working');
  assert.match(bea.parts['small'].className, /sa-sub sa-sub-busy/);
  const bg = run([], { bgCountOf: (n) => (n === 'bea' ? 2 : 0) }).children.find((c) => c.dataset && c.dataset.agent === 'bea');
  assert.match(bg.parts['small'].className, /sa-sub-bg/);
  assert.ok(!/build-team/.test(bg.parts['small'].innerHTML || ''));
  const wes = run(['wes']).children.find((c) => c.dataset && c.dataset.agent === 'wes');
  assert.strictEqual(wes.parts['.sa-live'].textContent, '· wes is working');
  assert.strictEqual(wes.parts['small'].textContent, '', 'a member has one line');
  assert.match(fnSource('simpleDotsIn'), /simpleTmPaint\(b, simpleTmLine\(b\.dataset\.agent, b\.dataset\.tmRank, b\.dataset\.tmBuild === '1'\)\)/);
  assert.match(fnSource('simpleAgentRow'), /\.sa-dot\.bg-work, \.sa-sub-bg/, 'the blue line opens the work like the ring does');
  assert.match(fnSource('simpleTeamsSig'), /!!r\.build, !!r\.tm\.pill, !!r\.tm\.open/);
});
test('Simple CSS (phone sheet): ranks 60/50/40px, sheet x positions (page 54/101, 103/137, 139/169, 103/133, dot 346), pill hit area >= 36px, sticky headers, 36px+ targets', () => {
  const v = (name, scope) => { const m = html.match(new RegExp(scope.replace(/[.#]/g, '\\$&') + ' \\{ --sa-pl0: ([^}]*)\\}', 'm')); assert.ok(m, scope); const d = '--sa-pl0: ' + m[1]; const g = (k) => parseFloat(new RegExp(k + ': ([\\d.]+)px').exec(d)[1]); return g(name); };
  const sheet = 'html.mm-simple';
  // the list starts at page x 36 in the sheet: padding-left + 36 = the design's icon x (within 4px)
  assert.ok(Math.abs(v('--sa-pl0', sheet) + 36 - 54) <= 4 && Math.abs(v('--sa-pl1', sheet) + 36 - 103) <= 4 && Math.abs(v('--sa-pl2', sheet) + 36 - 139) <= 4);
  assert.deepStrictEqual([v('--sa-hm', sheet), v('--sa-hl', sheet), v('--sa-hw', sheet)], [60, 50, 40]);
  assert.ok(v('--sa-pl1', sheet) >= v('--sa-pl0', sheet) + 32 + 15, 'members start right of the main name');
  assert.ok(v('--sa-pl2', sheet) >= v('--sa-pl1', sheet) + 26 + 8, 'workers start right of the leader name');
  assert.match(html, /html\.mm-simple #simple-agents-sheet \.sa-row\.sa-tm \{ gap: 15px; \}/);
  const head = html.match(/^html\.mm-simple \.sa-sec-h \{([^}]*)\}/m)[1];
  assert.match(head, /position: sticky/); assert.match(head, /top: 0/); assert.strictEqual(px(head, 'height'), 44);
  const pill = html.match(/\.tm-pill-btn \{([^}]*)\}/)[1];
  assert.ok(px(pill, 'height') >= 36 && px(pill, 'min-width') >= 36);
  // changed (the owner 2026-11-24 07:48: "On the mobile I see \"3 agents\". desktop website I see \"3\". Everything should alwasy be consistent."): the sidebar keeps the words; the NAME gives way
  assert.doesNotMatch(html, /\.tm-pw/, 'no rule hides or even names the pill words (the narrow sidebar keeps "N agents")');
  assert.match(html, /\.sa-row\.sa-tm\.sa-kid::before/, 'the old pseudo lines are switched off for these rows');
});

// ── design review fixes (phone) ──
test('Build team link alone on a main row\'s second line starts at the name\'s x: phone and Simple sheet (the 8px tap padding is taken back by a -8px margin)', () => {
  // Fails before: margin-left was -2px, so the visible text started 6 px right of the name (phone 62 -> 68, Simple sheet 107 -> 112).
  assert.match(html, /\.agent-build-only \.build-team-link \{ margin-left: -8px; \}/, 'phone: padding-left 8 + margin-left -8 = the text at the name x');
  assert.ok(html.indexOf('.agent-build-only .build-team-link') > html.indexOf('.agent-build-sub .build-team-link {'), 'after the general rule (same specificity: later wins)');
  assert.match(html, /html\.mm-simple \.sa-build-sub \.build-team-link \{ margin-left: -8px; \}/, 'Simple sheet');
  assert.ok(html.indexOf('html.mm-simple .sa-build-sub .build-team-link {') > html.indexOf('html.mm-simple .sa-sub .build-team-link {'));
  // the tap box keeps its height (10px padding top and bottom, taken back by the margins) and its 8px left padding
  assert.match(html, /html\.mm-simple \.sa-sub \.build-team-link \{[^}]*padding: 10px 8px;/);
  // only where the link is alone on the line: the phone's own markup carries the class; the All Agents 'Solo · Build team' line does not (changed Owner 2026-11-24 07:32: "Create a classification of solo agents" / "Instead of 'no team'")
  const h = teamsApi(env({ store: { 'hub-teams-open': OPEN_ALL } })).teamsListHtml();
  assert.match(rowOf(h, 'bea'), /agent-build-sub agent-build-only"><span role="button"[^>]*class="build-team-link"/);
  assert.match(js, /Solo · \$\{buildTeamBtnHtml\(name, 'build-team-link', 'Build team', true\)\}<\/div>/);
});
test('Simple sheet: the lead\'s crown shows on its row (the general Simple rule that hides .lead-badge does not win in .sa-l1)', () => {
  // Fails before: html.mm-simple .lead-badge { display: none } hid the crown the code adds to the lead's .sa-l1.
  // The general hide rule is !important, so the crown's rule must be too (a browser run showed it still hidden without it).
  assert.match(html, /html\.mm-simple \.sa-l1 \.lead-badge \{ display: inline-block !important; flex: none;/);
  const hide = html.match(/html\.mm-simple \.group-title, html\.mm-simple \.agent-job, html\.mm-simple \.lead-badge,/);
  assert.ok(hide, 'the general hiding rule is still there (All Agents in Simple shows no crown)');
  assert.match(js, /if \(a\.lead\) \{ const k = document\.createElement\('span'\); k\.className = 'lead-badge'; k\.textContent = '👑'/);
});

// ── review round 1: the working filter keeps the real team; its pill is plain text; Simple gives the focus back; a main agent's words ──
test('Teams (working filter): a busy boss whose whole team is idle stays under Teams with its pill; the header counts the visible rows', () => {
  const f = env(); f.workingFilter = true; f.live = { ann: { busy: true } };
  const h = teamsApi(f).teamsListHtml();
  assert.deepStrictEqual(names(h), ['ann'], 'only the busy boss; its idle people are cut');
  assert.match(h, /<span>Teams · 1<\/span>/);
  assert.doesNotMatch(h, /No team yet|Solo agents/);
  assert.match(rowOf(h, 'ann'), /<span class="tm-pill">5 agents<\/span>/, 'the pill shows the real team size');
  // a busy worker keeps its boss: the header count is the visible rows (1 of the 2 mains with a team... here only ann)
  const g = env(); g.workingFilter = true; g.live = { wyn: { busy: true }, bea: { busy: true } };
  const hg = teamsApi(g).teamsListHtml();
  assert.match(hg, /<span>Teams · 1<\/span>/);
  assert.match(hg, /<span>Solo agents · 1<\/span>/);
  assert.deepStrictEqual(names(hg), ['ann', 'lou', 'wyn', 'bea']);
  // a section with nothing busy is dropped
  const s = env(); s.workingFilter = true; s.live = { sam: { busy: true } };
  const hs = teamsApi(s).teamsListHtml();
  assert.match(hs, /Shared specialists · 1/);
  assert.doesNotMatch(hs, /Teams · |No team yet|Solo agents/);
});
test('Teams (working filter): everything is open, so the size is a plain pill (no button, no data-fold); off, the pill is the fold button again', () => {
  const f = env(); f.workingFilter = true; f.live = { wyn: { busy: true } };
  const h = teamsApi(f).teamsListHtml();
  assert.doesNotMatch(h, /data-fold|tm-pill-btn|type="button"/, 'no fold control anywhere');
  assert.match(rowOf(h, 'lou'), /<span class="tm-pill">/);
  assert.match(h, /^<div class="group-title tm-sec-h">/);
  const o = env(); o.live = { wyn: { busy: true } };
  assert.match(teamsApi(o).teamsListHtml(), /<button type="button" class="tm-pill-btn" data-fold="ann"/);
});
test('Teams: a main agent\'s replying line has no leading hourglass (as on desktop and in Simple)', () => {
  const e = env(); e.live = { bea: { busy: true } }; e.busyText = (n) => '⏳ ' + n + ' is working';
  const h = teamsApi(e).teamsListHtml();
  assert.match(h, />bea is working</);
  assert.doesNotMatch(h.match(/<div class="agent-model working[^>]*>[^<]*<\/div>/)[0], /⏳/);
});
test('Simple: after a fold the repaint replaced the control, so the one with the same data-fold gets the focus back (sheet and sidebar)', () => {
  const mkBtn = (k) => ({ dataset: { fold: k }, focused: 0, focus() { this.focused++; } });
  const sheetBtns = [mkBtn('ann'), mkBtn('@sec:teams')], sideBtns = [mkBtn('ann'), mkBtn('@sec:teams')];
  const els = { 'simple-agents-sheet': { open: false, querySelectorAll: () => sheetBtns }, 'simple-side': { querySelectorAll: () => sideBtns } };
  const doc = { getElementById: (id) => els[id] || null };
  const run = (key) => new Function('document', fnSource('simpleFoldFocus') + '\nreturn simpleFoldFocus;')(doc)(key);
  run('@sec:teams');
  assert.strictEqual(sideBtns[1].focused, 1, 'a closed sheet is skipped: the sidebar control');
  assert.strictEqual(sheetBtns[1].focused, 0);
  els['simple-agents-sheet'].open = true; run('ann');
  assert.strictEqual(sheetBtns[0].focused, 1);
  run('nobody'); assert.strictEqual(sheetBtns[0].focused + sideBtns[0].focused, 1, 'no match: nothing');
  // the pill and the section header call it after the repaint (source pin: the fake DOM of simpleRun repaints nothing)
  assert.match(fnSource('simpleAgentRow'), /simpleAgentListsRepaint\(\); simpleFoldFocus\(tm\.fold\);/);
  assert.match(fnSource('simpleTeamsFill'), /simpleAgentListsRepaint\(\); simpleFoldFocus\(teamsSecKey\(s\.key\)\);/);
  assert.match(fnSource('simpleTeamsFill'), /h\.dataset\.fold = teamsSecKey\(s\.key\);/);
  // Simple has no working filter: its Teams model never reads it
  assert.doesNotMatch(fnSource('simpleTeamsModel') + fnSource('simpleTeamsFill'), /workingFilter/);
});

// ── the whole team shows on opening (the owner's request 2026-11-24 07:30) ──
const CNC = [
  { name: 'cnc', display: 'Cnc', category: 'primary' },
  { name: 'gantry', display: 'Gantry', category: 'specialist', reportsTo: 'cnc' },
  { name: 'toolpath', display: 'Toolpath', category: 'worker', reportsTo: 'gantry' },
  { name: 'feeds', display: 'Feeds', category: 'worker', reportsTo: 'gantry' },
];
const cncEnv = (open) => { const e = env({ store: { 'hub-teams-open': JSON.stringify(open) } }); e.agents = CNC; return e; };
test('whole team (phone): opening cnc shows leader gantry and both workers; the leader pill reads "2 agents ▾"; no "leads"', () => {
  const h = teamsApi(cncEnv({ cnc: true })).teamsListHtml();
  assert.deepStrictEqual(names(h), ['cnc', 'gantry', 'feeds', 'toolpath'], 'all three member rows (workers by shown name)');
  assert.match(h, /data-fold="@fold:gantry" aria-expanded="true" aria-label="Fold Gantry: 2 agents" title="Fold Gantry: 2 agents"><span class="tm-pill">2 agents &#x25BE;<\/span>/);
  assert.match(h, /data-fold="cnc" aria-expanded="true" aria-label="Fold Cnc: 3 agents" title="Fold Cnc: 3 agents"><span class="tm-pill">3 agents &#x25BE;/);
  assert.doesNotMatch(h, /leads/i);
  assert.strictEqual(names(h).length - 1, 3, 'the main pill count equals the member rows under it');
  assert.match(rowOf(h, 'toolpath'), /tm-lv2/, 'the workers sit one step deeper, under the leader');
});
test('whole team (phone): "@fold:gantry" hides the two workers and shows ▸; an old stored gantry:true does not fold; the pill toggles @fold:<name>', () => {
  const folded = teamsApi(cncEnv({ cnc: true, '@fold:gantry': true })).teamsListHtml();
  assert.deepStrictEqual(names(folded), ['cnc', 'gantry']);
  assert.match(folded, /data-fold="@fold:gantry" aria-expanded="false" aria-label="Unfold Gantry: 2 agents" title="Unfold Gantry: 2 agents"><span class="tm-pill">2 agents &#x25B8;/);
  assert.deepStrictEqual(names(teamsApi(cncEnv({ cnc: true, gantry: true })).teamsListHtml()), ['cnc', 'gantry', 'feeds', 'toolpath'], 'an old name -> true is harmless');
  const e = cncEnv({ cnc: true }); const api = teamsApi(e);
  api.teamsToggle('@fold:gantry');
  assert.strictEqual(e.store['hub-teams-open'], '{"cnc":true,"@fold:gantry":true}');
  assert.deepStrictEqual(names(api.teamsListHtml()), ['cnc', 'gantry']);
  api.teamsToggle('@fold:gantry');
  assert.strictEqual(e.store['hub-teams-open'], '{"cnc":true}');
  // the Working filter shows everything open with plain-text sizes, even with a leader folded by hand
  const f = cncEnv({ cnc: true, '@fold:gantry': true }); f.workingFilter = true; f.live = { toolpath: { busy: true } };
  const hf = teamsApi(f).teamsListHtml();
  assert.deepStrictEqual(names(hf), ['cnc', 'gantry', 'toolpath']);
  assert.doesNotMatch(hf, /tm-pill-btn|data-fold="@fold:gantry"/);
  assert.match(hf, /<span class="tm-pill">2 agents<\/span>/);
});
test('whole team (Simple sheet and sidebar): cnc open lists gantry and both workers; the leader pill folds under @fold:gantry; the main count equals the rows under it', () => {
  const run = (open) => simpleRun('teams', [], open, [], { agents: CNC });
  const r = run({ cnc: true });
  const rows = simpleRows(r.box);
  assert.deepStrictEqual(rows.map((x) => x.dataset.agent), ['cnc', 'gantry', 'feeds', 'toolpath']);
  const pillOf = (row) => row.parts['.sa-l1'].children.find((c) => c.className === 'tm-pill-btn');
  assert.strictEqual(pillOf(rows[0]).attrs['aria-label'], 'Fold Cnc: 3 agents');
  assert.strictEqual(rows.length - 1, 3);
  const gp = pillOf(rows[1]);
  assert.strictEqual(gp.dataset.fold, '@fold:gantry'); assert.strictEqual(gp.attrs['aria-label'], 'Fold Gantry: 2 agents');
  assert.match(gp.innerHTML, /^<span class="tm-pill">2 agents &#x25BE;<\/span>$/, 'the sidebar shows the words too: "2 agents ▾"');
  assert.doesNotMatch(r.box.children.map((c) => c.innerHTML).join(''), /leads/);
  assert.deepStrictEqual(simpleRows(run({ cnc: true, '@fold:gantry': true }).box).map((x) => x.dataset.agent), ['cnc', 'gantry']);
  assert.deepStrictEqual(simpleRows(run({ cnc: true, gantry: true }).box).map((x) => x.dataset.agent), ['cnc', 'gantry', 'feeds', 'toolpath'], 'an old gantry -> true does not fold');
  gp.click();
  assert.strictEqual(r.e.store['hub-teams-open'], '{"cnc":true,"@fold:gantry":true}', 'a tap on the leader pill stores @fold:gantry');
  assert.doesNotMatch(html, /\.tm-pw/, 'narrow sidebar: the words stay');
});

// ── the fold of the old sections carries over to "Solo agents" (owner 2026-11-24 07:32: "Create a classification of solo agents" / "Instead of 'no team'") ──
test('Solo agents fold (phone): an old stored @sec:none or @sec:alone keeps the section folded; unfolding deletes all three keys; folding stores @sec:solo', () => {
  for (const old of ['@sec:none', '@sec:alone', '@sec:solo']) {
    const e = env({ store: { 'hub-teams-open': JSON.stringify({ [old]: true, '@sec:shared': true }) } });
    const api = teamsApi(e);
    let h = api.teamsListHtml();
    assert.match(h, /data-fold="@sec:solo" data-tm-sec="solo" aria-expanded="false"/, `${old}: folded at start`);
    assert.ok(!h.includes('data-agent="bea"'), `${old}: its rows are hidden`);
    api.teamsToggle('@sec:solo');
    h = api.teamsListHtml();
    assert.match(h, /data-fold="@sec:solo" data-tm-sec="solo" aria-expanded="true"/, `${old}: one tap opens it`);
    assert.ok(h.includes('data-agent="bea"'));
    assert.deepStrictEqual(Object.keys(JSON.parse(e.store['hub-teams-open'])), ['@sec:shared'], `${old}: all three Solo keys are gone, other folds stay`);
    api.teamsToggle('@sec:solo');
    assert.strictEqual(JSON.parse(e.store['hub-teams-open'])['@sec:solo'], true, 'folding stores @sec:solo');
    assert.match(api.teamsListHtml(), /data-fold="@sec:solo" data-tm-sec="solo" aria-expanded="false"/);
  }
});
test('Solo agents fold (Simple sheet): the same keys; the header tap folds and unfolds through the same helper', () => {
  const { box } = simpleRun('teams', [], { '@sec:none': true });
  const solo = simpleHeads(box).find((h) => /^Solo agents/.test(h.parts['.sa-sec-t'].textContent));
  assert.strictEqual(solo.attrs['aria-expanded'], 'false', 'an old @sec:none keeps it folded in Simple too');
  const r = simpleRun('teams', [], { '@sec:none': true }, [], {});
  const s2 = simpleHeads(r.box).find((h) => /^Solo agents/.test(h.parts['.sa-sec-t'].textContent));
  s2.click();
  assert.deepStrictEqual(JSON.parse(r.e.store['hub-teams-open']), {}, 'unfolding deletes the old key');
});

// ── Never a stub of status (design lead + Maestro): the row's title and aria-label carry the full words; a recorded works-alone agent reads 'Solo' in All Agents ──
test('phone Teams rows: title and aria-label carry the full status words when replying or with background work; idle rows and All Agents rows have none', () => {
  const e = env({ env: { bgCountOf: (n) => (n === 'bea' ? 2 : 0), bgStateOf: (n, working) => (!working && n === 'bea' ? 'background' : 'free') } });
  e.live = { ann: { busy: true } };
  const api = teamsApi(e);
  const head = (h) => h.slice(0, h.indexOf('>'));
  assert.doesNotMatch(head(api.agentRowHtml(AGENTS[0])), /title=|aria-label=/, 'All Agents rows are unchanged');
  const t = (a, rank) => api.agentRowHtml(a, { tm: { rank, pill: '', hasPill: false, build: false } });
  assert.match(head(t(AGENTS[0], 'main')), /data-agent="ann" title="Ann: ann is working" aria-label="Ann: ann is working"/);
  assert.match(head(t(AGENTS[1], 'main')), /data-agent="bea" title="Bea &lt;b&gt;: Free · 2 things in the background" aria-label="Bea &lt;b&gt;: Free · 2 things in the background"/);
  assert.doesNotMatch(head(t(AGENTS[7], 'main')), /title=|aria-label=/, 'idle: unchanged');
  assert.match(api.teamsListHtml(), /data-agent="ann" title="Ann: ann is working" aria-label="Ann: ann is working"/);
});
test('Simple phone rows: simpleTmLine carries the full words as tip and simpleTmPaint keeps the row title / aria-label current', () => {
  const fns = ['simpleTmLine', 'simpleTmPaint'].map(fnSource).join('\n');
  assert.match(fnSource('simpleTmLine'), /const tip = full \? displayName\(name\) \+ ': ' \+ full : ''/);
  const live = { ann: { busy: true } };
  const api = new Function('live', 'isBusy', 'busyText', 'bgCountOf', 'AgentDot', 'displayName', 'buildTeamBtnHtml', fns + '\nreturn { simpleTmLine, simpleTmPaint };')(
    live, (n) => !!(live[n] && live[n].busy), (n) => '⏳ checking the berth list', (n) => (n === 'bea' ? 2 : 0), require('../lib/ui-agent-dot.js'), (n) => n[0].toUpperCase() + n.slice(1), () => '');
  assert.strictEqual(api.simpleTmLine('ann', 'main', false).tip, 'Ann: checking the berth list');
  assert.strictEqual(api.simpleTmLine('wes', 'worker', false).tip, '');
  assert.strictEqual(api.simpleTmLine('bea', 'main', false).tip, 'Bea: Free · 2 things in the background');
  const attrs = {};
  const b = { title: '', setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; if (k === 'title') b.title = ''; },
    querySelector: () => null };
  api.simpleTmPaint(b, api.simpleTmLine('ann', 'main', false));
  assert.strictEqual(b.title, 'Ann: checking the berth list');
  assert.strictEqual(attrs['aria-label'], 'Ann: checking the berth list');
  live.ann.busy = false;
  api.simpleTmPaint(b, api.simpleTmLine('ann', 'main', false));
  assert.strictEqual(b.title, '', 'back to idle: the words go from the title');
  assert.strictEqual(attrs['aria-label'], undefined);
});
test('All Agents (phone): a recorded works-alone main agent reads Solo, an undecided one Solo · Build team', () => {
  const e = env({ alone: ['bea'] });
  const api = teamsApi(e);
  assert.match(api.agentRowHtml(AGENTS[1], { build: true }), /<div class="agent-model agent-build-sub agent-solo-sub">Solo<\/div>/);
  const open = env({ alone: [] });
  assert.match(teamsApi(open).agentRowHtml(AGENTS[1], { build: true }), /<div class="agent-model agent-build-sub">Solo · <span role="button"/);
});
