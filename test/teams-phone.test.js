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
  };
  return Object.assign(e, (over && over.env) || {});
}
function load(e, src, ret) {
  const names = Object.keys(e);
  return new Function(...names, src + '\nreturn ' + ret + ';')(...names.map((n) => e[n]));
}
const teamsApi = (e) => load(e, TEAMS() + '\n' + ROW(), '{ teamsView, teamsViewSet, teamsListHtml, agentRowHtml, teamsToggle, teamsSub }');
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

test('Teams: every agent exactly once, with the right sections, sublines, labels and indents', () => {
  const e = env({ store: { 'hub-teams-open': JSON.stringify({ ann: true, lia: true, lou: true, '@other': true }) } });
  e.live = { wes: { busy: true }, wyn: { busy: true } };
  const h = teamsApi(e).teamsListHtml();
  assert.deepStrictEqual(names(h).sort(), AGENTS.map((a) => a.name).sort());
  assert.strictEqual(h.indexOf('Your agents') < h.indexOf('Shared specialists') && h.indexOf('Shared specialists') < h.indexOf('Other (1)'), true);
  assert.match(h, /<div class="agent-model" title="2 teams · 5 agents · 2 working">2 teams · 5 agents · 2 working</);
  assert.match(h, /Bea &lt;b&gt;<\/div><div class="agent-model" title="No team yet">No team yet</);
  assert.match(h, /Lia<\/div><div class="agent-model" title="Team leader · leads 2 · 1 working">Team leader · leads 2 · 1 working</);
  assert.match(h, /Lou<\/div><div class="agent-model" title="Team leader · leads 1 · 1 working">/);
  assert.match(h, /Wil<\/div><div class="agent-model" title="Worker">Worker</);
  assert.ok(h.includes('data-agent="wes"'));
  assert.doesNotMatch(h, /Team leaders|Workers|tm-lab/, 'no headings in the tree');
  assert.match(h, /tm-line tm-d1" style="--d:1"><button type="button" class="tm-fold" data-fold="lia"/);
  assert.match(h, /tm-line tm-d2" style="--d:2"><span class="tm-fold-sp"><\/span><button class="agent-row is-busy" data-agent="wes"/);
  assert.match(h, /<div class="tm-block tm-r-worker"><div class="tm-line tm-d2"/, 'worker rows carry the worker rank');
  assert.match(h, /<div class="tm-block tm-r-leader"><div class="tm-line tm-d1"/, 'leader rows carry the leader rank');
  assert.ok(!h.includes('<b>'), 'names are escaped');
  assert.ok(!/tm-empty/.test(h), 'a team exists: no empty-state box');
  // worker rows keep agentRowHtml's own busy text
  assert.match(h, /wes is working/);
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
test('Teams: each leader is one block; a worker sits only inside its own leader\'s wrapper (leaders with no workers above and below); no headings', () => {
  const e = env({ store: { 'hub-teams-open': JSON.stringify({ ann: true, l2: true }) } });
  e.agents = [
    { name: 'ann', display: 'Ann', category: 'primary' },
    { name: 'l1', display: 'L1', category: 'specialist', reportsTo: 'ann' },
    { name: 'l2', display: 'L2', category: 'specialist', reportsTo: 'ann' },
    { name: 'l3', display: 'L3', category: 'specialist', reportsTo: 'ann' },
    { name: 'w1', display: 'W1', category: 'worker', reportsTo: 'l2' },
  ];
  const h = teamsApi(e).teamsListHtml();
  assert.doesNotMatch(h, /Team leaders|Workers|tm-lab/);
  assert.match(h, /team of 4</, 'one real leader: team of N');
  const b = (n) => blockOf(h, 'tm-block tm-r-', n);
  const [b1, b2, b3] = [b('l1'), b('l2'), b('l3')];
  assert.ok(b1 && b2 && b3);
  assert.ok(/^<div class="tm-block tm-r-worker"/.test(b1) && /^<div class="tm-block tm-r-worker"/.test(b3) && /^<div class="tm-block tm-r-leader"/.test(b2), 'direct reports with nobody under them are workers');
  assert.ok(!b1.includes('w1') && !b3.includes('w1') && !/tm-kids/.test(b1) && !/tm-kids/.test(b3), 'leaders without workers are a block of one row, no connector');
  assert.match(b2, /<div class="tm-kids"><div class="tm-block tm-r-worker">[\s\S]*data-agent="w1"[\s\S]*<\/div><\/div>$/);
  assert.strictEqual((h.match(/data-agent="w1"/g) || []).length, 1);
  assert.ok(h.indexOf(b1) + b1.length <= h.indexOf(b2) && h.indexOf(b2) + b2.length <= h.indexOf(b3), 'blocks follow one another, never nest');
  assert.match(h, /<div class="tm-leaders">/);
});
test('Teams: a main with three direct reports who lead nobody: no Team leader, worker look, "team of 3"', () => {
  const e = env({ store: { 'hub-teams-open': JSON.stringify({ atlas: true }) } });
  e.agents = [{ name: 'atlas', display: 'Atlas', category: 'primary' }, ...['editor', 'scout', 'writer'].map((n) => ({ name: n, display: n[0].toUpperCase() + n.slice(1), category: 'specialist', reportsTo: 'atlas' }))];
  const h = teamsApi(e).teamsListHtml();
  assert.match(h, /title="team of 3">team of 3</);
  assert.doesNotMatch(h, /Team leader|tm-r-leader|teams? · 3 agents/);
  assert.strictEqual((h.match(/<div class="tm-block tm-r-worker">/g) || []).length, 3);
  assert.strictEqual((h.match(/title="Reports to Atlas">Reports to Atlas</g) || []).length, 3);
});
test('Teams: two real leaders and one direct report with nobody under it: "2 teams · 5 agents"', () => {
  const e = env({ store: { 'hub-teams-open': JSON.stringify({ atlas: true }) } });
  const S = (n, r) => ({ name: n, display: n[0].toUpperCase() + n.slice(1), category: 'specialist', reportsTo: r });
  e.agents = [{ name: 'atlas', display: 'Atlas', category: 'primary' }, S('editor', 'atlas'), S('builder', 'atlas'), S('scout', 'atlas'), S('writer', 'editor'), S('coder', 'builder')];
  const h = teamsApi(e).teamsListHtml();
  assert.match(h, /title="2 teams · 5 agents">2 teams · 5 agents</);
  assert.strictEqual((h.match(/Team leader · leads 1</g) || []).length, 2);
  assert.match(h, /<div class="tm-block tm-r-leader"><div class="tm-line tm-d1"[^>]*>[\s\S]*?data-agent="editor"/);
  assert.match(h, /<div class="tm-block tm-r-worker"><div class="tm-line tm-d2" style="--d:2"><span class="tm-fold-sp"><\/span><button class="agent-row" data-agent="scout"/);
  assert.match(h, /Scout<\/div><div class="agent-model" title="Reports to Atlas">/);
});
test('Teams CSS (phone): connector border on the workers wrapper, spaced blocks, 36px worker rows, no .tm-lab, variables only', () => {
  const css = html.split('\n').filter((l) => /\.tm-|sa-leader/.test(l)).join('\n');
  assert.doesNotMatch(css, /tm-lab/);
  assert.match(css, /\.tm-kids \{[^}]*border-left: 1px solid var\(--border-strong\)/);
  assert.match(css, /\.tm-block\.tm-r-leader \{ margin-bottom: 10px; \}/);
  assert.match(css, /\.tm-r-worker > \.tm-line > \.agent-row \{ min-height: 36px;/);
  assert.match(css, /\.tm-r-worker > \.tm-line \.agent-name \{[^}]*color: var\(--text-dim\)/);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(css));
});

test('Teams: folded by default, a fold button saves hub-teams-open, Other is folded by default', () => {
  const e = env();
  const api = teamsApi(e);
  let h = api.teamsListHtml();
  assert.deepStrictEqual(names(h).sort(), ['ann', 'bea', 'sam'], 'mains and shared only; leaders folded, Other folded');
  assert.match(h, /data-fold="ann" aria-expanded="false"/);
  assert.match(h, /data-tm-sec="other"><span>Other \(1\)/);
  api.teamsToggle('ann');
  assert.strictEqual(e.store['hub-teams-open'], '{"ann":true}');
  h = api.teamsListHtml();
  assert.ok(h.includes('data-agent="lia"') && h.includes('data-agent="lou"') && !h.includes('data-agent="wes"'));
  api.teamsToggle('ann');
  assert.strictEqual(e.store['hub-teams-open'], '{}');
  // the click handler: fold buttons only fold, they never open a chat
  assert.match(js, /const f = e\.target\.closest\('\.tm-fold, \[data-tm-sec\]'\);\n\s+if \(f\) \{ teamsToggle\(f\.dataset\.fold \|\| '@' \+ f\.dataset\.tmSec\); renderAgents\(\); return; \}/);
});

test('Teams: the helpers line, the working filter, and the empty state', () => {
  const e = env({ store: { 'hub-teams-open': JSON.stringify({ ann: true }) } });
  e.live = { h1: { busy: true, worker: true, parent: 'ann' }, h2: { busy: true, worker: true, parent: 'ann' }, h3: { busy: true, worker: true, parent: 'bea' } };
  let h = teamsApi(e).teamsListHtml();
  assert.match(h, /⚡ 2 helpers under Ann/);
  assert.match(h, /⚡ 1 helper under Bea &lt;b&gt;/);
  assert.ok(h.indexOf('data-agent="lou"') < h.indexOf('2 helpers under Ann'), 'after the node\'s children');
  // the working filter: busy rows and their ancestors, everything open
  const f = env(); f.workingFilter = true; f.live = { wyn: { busy: true } };
  h = teamsApi(f).teamsListHtml();
  assert.deepStrictEqual(names(h), ['ann', 'lou', 'wyn']);
  f.live = {};
  assert.match(teamsApi(f).teamsListHtml(), /No agent is working right now\./);
  // the working filter never shows the how-to blurb, even when no team exists
  const nt = env(); nt.workingFilter = true; nt.agents = [AGENTS[0], AGENTS[1], AGENTS[7]];
  assert.doesNotMatch(teamsApi(nt).teamsListHtml(), /Agents can work as teams/);
  assert.match(teamsApi(nt).teamsListHtml(), /No agent is working right now\./);
  // Other (N) counts the whole subtree, as the desktop does
  const ot = env(); ot.agents = [AGENTS[0], { name: 'exa', display: 'Exa', category: 'experimental' }, { name: 'exb', display: 'Exb', category: 'worker', reportsTo: 'exa' }];
  assert.match(teamsApi(ot).teamsListHtml(), /Other \(2\)/);
  // empty state: no main agent has anyone under it
  const lone = env(); lone.agents = [AGENTS[0], AGENTS[1], AGENTS[7]];
  h = teamsApi(lone).teamsListHtml();
  // changed (Set up teams): an admin's box names the lead and offers "Set up teams" in place of the Build Team sentence
  assert.ok(h.startsWith('<div class="tm-empty"><b>Agents can work as teams.</b> Your main agents plan, decide and review. Short or personal tasks they usually do themselves; long work they can hand to team leaders, who run workers. Ann can look at how your agents already work together and propose teams. Nothing changes until you approve a team. <button type="button" class="tm-setup-btn" data-team-setup>Set up teams</button></div>'));
  assert.match(h, /No team yet/);
});

test('renderAgents: the Teams branch and the repaint wiring are in the source', () => {
  assert.match(RENDER(), /teamsPaintSwitch\(\);\n\s+if \(teamsView\(\) === 'teams' && window\.hubTeams\) \{ list\.innerHTML = teamsListHtml\(\); return; \}/);
  assert.match(js, /querySelector\('#screen-agents \.view-switch'\)\?\.addEventListener\('click'/);
  assert.match(fnSource('simpleSidePaint'), /teamsView\(\)/, 'the sidebar repaints when the view changes');
});

// ── Simple mode ──
function simpleRun(view, busy, open) {
  const e = env({ store: { 'hub-sidebar-view': view, 'hub-teams-open': JSON.stringify(open || {}) } });
  e.live = {}; for (const n of busy || []) e.live[n] = { busy: true };
  const mk = (tag) => {
    const x = { tag, children: [], dataset: {}, className: '', style: { props: {}, setProperty(k, v) { this.props[k] = v; } }, attrs: {}, _h: '', _t: '',
      classList: { add(c) { x.className += ' ' + c; } }, setAttribute(k, v) { x.attrs[k] = v; }, appendChild(c) { x.children.push(c); return c; }, addEventListener() {},
      querySelector(sel) { return x.parts[sel] || (x.parts[sel] = mk('part')); }, parts: {},
      set textContent(v) { x._t = v; if (v === '') x.children = []; }, get textContent() { return x._t; },
      set innerHTML(v) { x._h = v; }, get innerHTML() { return x._h; } };
    return x;
  };
  e.document = { createElement: mk, querySelectorAll: () => [] };
  e.agents = AGENTS; e.current = 'ann'; e.navigate = () => {}; e.simpleAgentListsRepaint = () => {};
  e.simpleMoreGet = () => false; e.simpleMoreSet = () => {}; e.simpleDotClass = () => '';
  e.simpleDotPaint = (el, n) => { if (el) el.className = 'sa-dot ' + e.simpleDotClass(n); };   // the "Working on" change paints Simple dots through this
  e.window = { hubTeams, hubSimple: { agentGroups: () => ({ primary: [], more: [] }) } };
  e.simpleAgentSheetModel = () => ({ primary: [], groups: [], hasMore: false, open: false });
  const names2 = Object.keys(e);
  const src = TEAMS() + ['simpleTeamsModel', 'simpleSwitch', 'simpleTeamsFill', 'simpleAgentRow', 'simpleAgentListFill'].map(fnSource).join('\n');
  const fill = new Function(...names2, src + '\nreturn { simpleAgentListFill, simpleTeamsModel };')(...names2.map((n) => e[n]));
  const box = mk('div');
  fill.simpleAgentListFill(box, { blurb: true });
  return { box, fill };
}

test('Simple: the sheet and the sidebar fill start with the same two-part switch', () => {
  assert.match(fnSource('simpleAgentListFill'), /if \(window\.hubTeams\) simpleSwitch\(list\);/);
  const { box } = simpleRun('agents');
  assert.strictEqual(box.children[0].className, 'sa-switch');
  assert.match(box.children[0].innerHTML, /data-view="all"[^>]*>All Agents<\/button><button[^>]*data-view="teams"[^>]*>Teams</);
  assert.match(fnSource('simpleAgentsFill'), /simpleAgentListFill\(d\.querySelector\('\.sa-list'\)/);
  assert.match(fnSource('simpleSideEnsure'), /ssd-list sa-list/);
});

test('Simple Teams: a direct report with nobody under it is not shown as a leader, but the main still counts it', () => {
  const S = (n, r) => ({ name: n, display: n, category: 'specialist', reportsTo: r });
  const e2 = env({ store: { 'hub-sidebar-view': 'teams' } });
  e2.agents = [{ name: 'atlas', display: 'Atlas', category: 'primary' }, S('editor', 'atlas'), S('scout', 'atlas'), S('writer', 'editor')];
  const model = load(e2, TEAMS() + fnSource('simpleTeamsModel'), 'simpleTeamsModel')();
  // Simple lists every direct report of a main (the direct worker as 'Reports to ...'); only the third level (writer) is left out.
  assert.deepStrictEqual(model.rows.map((r) => [r.a.name, r.depth, r.sub]), [['atlas', 0, 'team of 3'], ['editor', 1, 'Team leader'], ['scout', 1, 'Reports to Atlas']]);
});

test('Teams: a phone direct worker line uses the worker indent (--d:2, tm-d2), like the desktop; a leader keeps d1', () => {
  const e = env({ store: { 'hub-teams-open': JSON.stringify({ atlas: true }) } });
  const S = (n, r) => ({ name: n, display: n[0].toUpperCase() + n.slice(1), category: 'specialist', reportsTo: r });
  e.agents = [{ name: 'atlas', display: 'Atlas', category: 'primary' }, S('editor', 'atlas'), S('scout', 'atlas'), S('writer', 'editor')];
  const h = teamsApi(e).teamsListHtml();
  assert.match(h, /<div class="tm-line tm-d2" style="--d:2"><span class="tm-fold-sp"><\/span><button class="agent-row" data-agent="scout"/);
  assert.match(h, /<div class="tm-line tm-d1" style="--d:1">[\s\S]*?data-agent="editor"/);
});
test('Simple Teams: a main with a leader (and its worker) and a direct worker lists both direct reports, not the third level', () => {
  const S = (n, r) => ({ name: n, display: n[0].toUpperCase() + n.slice(1), category: 'specialist', reportsTo: r });
  const e2 = env({ store: { 'hub-sidebar-view': 'teams' } });
  e2.agents = [{ name: 'atlas', display: 'Atlas', category: 'primary' }, S('editor', 'atlas'), S('writer', 'editor'), S('scout', 'atlas')];
  const model = load(e2, TEAMS() + fnSource('simpleTeamsModel'), 'simpleTeamsModel')();
  const names = model.rows.map((r) => r.a.name);
  assert.deepStrictEqual(names, ['atlas', 'editor', 'scout']);
  assert.strictEqual(model.rows[1].sub, 'Team leader');
  assert.strictEqual(model.rows[2].sub, 'Reports to Atlas');
  assert.ok(!names.includes('writer'));
});
test('Simple Teams: main agents with their leaders, no workers, shared specialists folded', () => {
  const { box } = simpleRun('teams', ['wes']);
  const rows = box.children.filter((c) => c.dataset && c.dataset.agent);
  assert.deepStrictEqual(rows.map((r) => r.dataset.agent), ['ann', 'lia', 'lou', 'bea']);
  const sub = (r) => r.parts['small'].textContent;
  assert.deepStrictEqual(rows.map(sub), ['2 teams · 5 agents · 1 working', 'Team leader', 'Team leader', 'No team yet']);
  assert.deepStrictEqual(rows.map((r) => / sa-leader/.test(r.className)), [false, true, true, false], 'leaders get the leader rank class');
  assert.deepStrictEqual(rows.map((r) => r.style.props['--d'] || ''), ['', '1', '1', '']);
  const folds = box.children.filter((c) => /sa-fold/.test(c.className));
  assert.deepStrictEqual(folds.map((f) => f.dataset.grp), ['@shared', '@other']);
  assert.ok(!rows.some((r) => ['wes', 'wil', 'wyn', 'sam'].includes(r.dataset.agent)), 'no workers; the specialist is in the folded group');
  const open = simpleRun('teams', [], { '@shared': true }).box.children.filter((c) => c.dataset && c.dataset.agent).map((c) => c.dataset.agent);
  assert.deepStrictEqual(open, ['ann', 'lia', 'lou', 'bea', 'sam']);
});

test('Simple All Agents: no Teams rows, the current list is kept', () => {
  const { box } = simpleRun('agents');
  assert.ok(!box.children.some((c) => /sa-fold/.test(c.className)));
  assert.strictEqual(box.children.length, 1, 'only the switch: the stubbed model has no rows');
});

// ── Build Team (phone) ──
const BUILD = () => ROW() + '\n' + fnSource('menuTeamSync');
test('Build line: an admin sees "No team yet · Build team" under a main agent with no team in All Agents; rows with a team and non-admins do not', () => {
  const e = env();
  const api = load(e, BUILD(), '{ agentRowHtml, buildNoTeam, buildLineHtml }');
  assert.deepStrictEqual([...api.buildNoTeam()], ['bea'], 'ann has a team, the rest are not main agents');
  const row = api.agentRowHtml(AGENTS[1], { build: true });
  assert.match(row, /<\/button><div class="build-line">No team yet · <button type="button" class="build-team-link" data-build-team="bea">Build team<\/button><\/div>$/);
  assert.ok(!/build-line/.test(api.agentRowHtml(AGENTS[1])), 'no option, no line: the row is as before');
  const m = load(env({ env: { isAdmin: () => false } }), BUILD(), 'buildNoTeam');
  assert.strictEqual(m().size, 0, 'a member sees no Build controls');
  // the line is a sibling of the row button, never inside it
  assert.ok(!/<button class="agent-row[^>]*>(?:(?!<\/button>).)*build-team-link/.test(row));
});
test('Build line: renderAgents passes build only for the group rows (the source)', () => {
  assert.match(RENDER(), /const noTeam = buildNoTeam\(\);/);
  assert.match(RENDER(), /agentRowHtml\(a, \{ job: activeJobs\[a\.name\], build: noTeam\.has\(a\.name\) \}\)/);
  assert.ok(!/active: true, job: activeJobs\[a\.name\], build/.test(RENDER()), 'not in the Active section: no duplicate line');
});
test('Teams: Build Team button under "No team yet" for admins only; Building… disabled while a live entry says so', () => {
  const e = env({ store: { 'hub-teams-open': JSON.stringify({ ann: true }) } });
  const h = teamsApi(e).teamsListHtml();
  assert.strictEqual((h.match(/class="build-team-btn"/g) || []).length, 1);
  assert.match(h, /<div class="tm-build" style="--d:0"><button type="button" class="build-team-btn" data-build-team="bea">Build Team<\/button><\/div>/);
  assert.ok(h.indexOf('data-agent="bea"') < h.indexOf('build-team-btn'), 'under bea');
  e.live = { ann: { busy: true, buildingTeamFor: 'bea' } };
  const h2 = teamsApi(e).teamsListHtml();
  assert.match(h2, /<button type="button" class="build-team-btn" data-build-team="bea" disabled aria-disabled="true">Building…<\/button>/);
  const m = teamsApi(env({ env: { isAdmin: () => false } })).teamsListHtml();
  assert.ok(!/build-team/.test(m), 'a member sees none');
  const row = load(e, BUILD(), 'agentRowHtml')(AGENTS[1], { build: true });
  assert.match(row, /class="build-team-link" data-build-team="bea" disabled aria-disabled="true">Building…</);
});

function fakeEl(over) { return Object.assign({ hidden: false, disabled: false, href: '', textContent: '' }, over); }
function menuRun({ admin = true, simple = false, cur = 'bea', live = {}, pending = [] } = {}) {
  const els = { 'menu-agent-settings': fakeEl(), 'menu-build-team': fakeEl() };
  const e = env({ env: { $: (id) => els[id], current: cur, live, isAdmin: () => admin, simpleOn: () => simple, agentByName: (n) => AGENTS.find((a) => a.name === n) } });
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
  assert.match(slice('function applySnapshot(', 'let wkGoneState'), /'consultedBy', 'buildingTeamFor', 'offerPending', 'settingUpTeams'\]/);
  assert.match(slice('function setLive(', 'function paintStatus'), /next\.consultedBy = null; next\.buildingTeamFor = null;/);
  assert.match(js, /const bt = e\.target\.closest\('\[data-build-team\]'\);\n\s+if \(bt\) \{ if \(!bt\.disabled\) buildTeamStart\(bt\.dataset\.buildTeam\); return; \}/);
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
    esc, shownQuestions: new Set(), questionBoxes: new Map(), chatEl: () => root, scrollChat() {}, retireSoon() {}, toast() {}, current: 'ann',
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
