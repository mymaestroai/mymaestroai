// Teams view on the desktop page: tabs, view memory, renderTeams, Simple switch, Settings toggles, Help entry.
// Source-text checks plus functions pulled out of app.js and run in a vm with a small fake page. Reads no hub data.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const help = fs.readFileSync(path.join(ROOT, 'help.html'), 'utf8');
const hubTeams = require(path.join(ROOT, 'lib', 'ui-teams.js'));

function fnSrc(name) {
  const a = app.indexOf(`function ${name}(`);
  assert.ok(a > 0, `${name} exists`);
  const open = app.indexOf('{', app.indexOf(')', a));
  let depth = 0;
  for (let i = open; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}' && --depth === 0) return app.slice(a, i + 1);
  }
  throw new Error('unbalanced');
}
const hubEscLine = app.split('\n').find((l) => l.trim().startsWith('const hubEsc = '));

// ---- the fake page
function fakeEl(over) {
  const classes = new Set();
  const el = {
    dataset: {}, hidden: false, style: {}, attrs: {}, listeners: {}, children: [], innerHTML: '', firstChild: null,
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(t, f) { this.listeners[t] = f; },
  };
  return Object.assign(el, over || {});
}
function world({ stored, storageThrows, simple, member } = {}) {
  const store = new Map(stored || []);
  const tab = (view, hidden) => { const t = fakeEl({ hidden: !!hidden }); t.dataset.tab = view; return t; };
  const tabs = [tab('agents'), tab('teams'), tab('group-chat', true), tab('guide', true)];
  tabs[0].classList.add('active');
  const panel = (id, active) => { const p = fakeEl({ id }); if (active) p.classList.add('active'); return p; };
  const panels = ['agents', 'teams', 'group-chat', 'guide'].map((v, i) => panel(`${v}-panel`, i === 0));
  const switchBtns = ['agents', 'teams'].map((v) => { const b = fakeEl(); b.dataset.view = v; return b; });
  const list = fakeEl();
  Object.defineProperty(list, 'innerHTML', { get() { return this._h || ''; }, set(v) { this._h = v; this.firstChild = v ? {} : null; } });
  const body = fakeEl();
  if (member) body.classList.add('member-view');
  const document = {
    body,
    querySelectorAll(sel) {
      if (sel === '.tab') return tabs;
      if (sel === '.tab-panel') return panels;
      if (sel === '#simple-view-switch button') return switchBtns;
      if (sel === '[data-build-team]') return ctx.buildEls || [];   // paintBuildControls (Build team controls on the page)
      throw new Error('unexpected selector ' + sel);
    },
    querySelector(sel) {
      if (sel === '.tab.active') return tabs.find((t) => t.classList.contains('active')) || null;
      const m = /^\.tab\[data-tab="([\w-]+)"\]$/.exec(sel);
      if (m) return tabs.find((t) => t.dataset.tab === m[1]) || null;
      throw new Error('unexpected selector ' + sel);
    },
    docListeners: [], createElement: () => menuEl(), addEventListener(t, f, c) { document.docListeners.push([t, f, c]); }, removeEventListener(t, f) { document.docListeners = document.docListeners.filter((x) => x[1] !== f); },
    getElementById(id) {
      if (id === 'teams-list') return list;
      if (id === 'teams-panel') return panels[1];
      return null;
    },
  };
  const started = [];
  const opened = [];
  // A menu element for agentMenuOpenAt: records items, listeners and removal.
  function menuEl() {
    const e = fakeEl({ offsetWidth: 150, offsetHeight: 60, removed: false, contains: (t) => t === e, remove() { e.removed = true; } });
    let html = '';
    Object.defineProperty(e, 'innerHTML', { get() { return html; }, set(v) { html = v; } });
    e.querySelectorAll = () => (html.match(/class="agent-menu-item"/g) || []).map(() => fakeEl({ focus() {} }));
    e.querySelector = () => fakeEl({ focus() {} });
    return e;
  }
  document.body.appendChild = (el) => { document.body.menu = el; };
  const ctx = {
    document, console, setTimeout: (f) => { ctx.timers.push(f); return ctx.timers.length; }, timers: [],
    localStorage: {
      getItem(k) { if (storageThrows) throw new Error('denied'); return store.has(k) ? store.get(k) : null; },
      setItem(k, v) { if (storageThrows) throw new Error('denied'); store.set(k, String(v)); },
    },
    simpleOn: () => !!simple, isHubAdmin: () => !member,
    hubTeams, AGENTS: [], agentStatus: {}, localBusy: new Map(), statusKnown: true,
    elapsedLabel: (iso, short) => (iso ? (short ? '3m' : '3 min') : ''),
    chatViewActivityWord: (a) => a || '',
    agentDoingNow: (n) => ({ words: 'working', detail: '' }), busyRun: {},   // agentLiveState (shared with All Agents) reads these
    AgentDot: require('../lib/ui-agent-dot.js'),   // the background-work ring (the "Working on" change), as in All Agents
    startSoloChat: (n, m) => started.push([n, m]),
    fetch: async () => ({ ok: false }),
    openAgentSettings: (n) => opened.push(n), alerts: [], alert: (m) => ctx.alerts.push(m), window: null,
    selectedGroupAgents: [], selectedSummarizer: null,
  };
  const src = [hubEscLine, "const SIDEBAR_VIEW_KEY = 'hub-sidebar-view'; let sidebarViewTouched = false; let sidebarTabsCfg = {};",
    "const TEAMS_OPEN_KEY = 'hub-teams-open'; let teamsLastHtml = null; let teamsTimer = 0; let teamsOpenMem = null;",
    fnSrc('capName'), fnSrc('sidebarViewStored'), fnSrc('sidebarViewOk'), fnSrc('sidebarViewSet'), fnSrc('sidebarTabsApply'),
    'async ' + fnSrc('sidebarTabsLoad'), fnSrc('setupTabs'), fnSrc('teamsOpenGet'), fnSrc('teamsOpenToggle'), fnSrc('teamsClick'),
    fnSrc('agentLiveState'), fnSrc('bgCountOf'), "const buildTeamPending = new Set(); let agentMenuEl = null, agentMenuOpener = null, agentMenuOff = null;",
    fnSrc('teamBuilding'), fnSrc('agentCanBuildTeam'), fnSrc('agentMenuEntries'), fnSrc('agentMenuBtnHtml'), fnSrc('buildTeamCtlHtml'), fnSrc('buildLineHtml'),
    fnSrc('paintBuildControls'), 'async ' + fnSrc('buildTeamStart'), fnSrc('agentMenuClose'), fnSrc('agentMenuOpenAt'), fnSrc('agentMenuToggle'), fnSrc('agentButton'),
    fnSrc('questionChecklistOf'), fnSrc('questionChecklistHtml'), fnSrc('questionCheckedIds'), fnSrc('askResponseBody'),
    fnSrc('teamsRowHtml'), fnSrc('teamsBlockHtml'), fnSrc('teamsSubtreeHtml'), fnSrc('renderTeams'), fnSrc('teamsRepaintSoon'),
    // Set up teams (renderTeams, setupTabs and teamsClick call these): the harness carries them so the pinned Teams tests keep running as before.
    "let teamSetup = { offer: null, lead: null, setups: [] }; let teamSetupStarting = false; const teamSetupRecent = new Set(); let teamSetupLoadTimer = 0; const chats = {};",
    fnSrc('teamSetupLeadDisplay'), fnSrc('teamSetupBusy'), fnSrc('teamSetupLines'), fnSrc('teamSetupDate'), fnSrc('teamSetupLineHtml'), fnSrc('teamSetupApply'),
    'async ' + fnSrc('teamSetupLoad'), fnSrc('teamSetupLoadSoon'), fnSrc('teamSetupPaint'), fnSrc('teamSetupOfferHtml'), fnSrc('teamSetupUndoRows'), fnSrc('teamSetupChatPaint'),
    'async ' + fnSrc('teamSetupStart'), 'async ' + fnSrc('teamSetupUndo'), 'function setAgentLive() {} function loadAgents() { return Promise.resolve(); }',
    'this.api = { setupTabs, sidebarViewSet, sidebarTabsApply, renderTeams, teamsClick, teamsRepaintSoon, teamsOpenToggle, agentMenuEntries, agentMenuBtnHtml, buildLineHtml, agentButton, buildTeamStart, agentMenuOpenAt, agentMenuClose, paintBuildControls, questionChecklistOf, questionChecklistHtml, askResponseBody };'].join('\n');
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { ctx, api: ctx.api, store, tabs, panels, switchBtns, list, started, opened, document };
}
const A = (name, over) => Object.assign({ name, display: name[0].toUpperCase() + name.slice(1), model: 'm/' + name, icon: '🤖', category: 'specialist' }, over);
const active = (w) => w.tabs.filter((t) => t.classList.contains('active')).map((t) => t.dataset.tab);

// ---- index.html
test('tabs: All Agents, Teams, then Tiger Team and Guide hidden by default; panels kept', () => {
  assert.match(html, /<button class="tab active" data-tab="agents">All Agents<\/button>\s*<button class="tab" data-tab="teams">Teams<\/button>/);
  assert.match(html, /<button class="tab" data-tab="group-chat" hidden>Tiger Team<\/button>/);
  assert.match(html, /<button class="tab" data-tab="guide" hidden>Guide<\/button>/);
  assert.match(html, /<div class="tab-panel" id="teams-panel"><div id="teams-list"><\/div><\/div>/);
  assert.ok(html.includes('id="group-chat-panel"') && html.includes('id="guide-panel"'));
  assert.doesNotMatch(html, /data-tab="agents">Agents</);
});
test('the ui-teams.js script tag sits before app.js, next to ui-simple.js', () => {
  const a = html.indexOf('<script src="/ui-simple.js"></script>');
  const b = html.indexOf('<script src="/ui-teams.js"></script>');
  const c = html.indexOf('<script src="app.js"></script>');
  assert.ok(a > 0 && b > a && c > b);
});
test('Simple: two-part switch is hidden in Advanced, shown in Simple; Teams view hides workers (deep rows and the workers wrapper) and helper lines', () => {
  assert.match(html, /<div class="simple-view-switch"[^>]*>\s*<button type="button" data-view="agents" aria-pressed="true">All Agents<\/button>\s*<button type="button" data-view="teams" aria-pressed="false">Teams<\/button>/);
  assert.match(html, /html\.mm-simple #teams-list \.teams-line\.deep,/, 'the wrapper of a hidden deep row goes too, so no gap is left');
  assert.match(fnSrc('teamsRowHtml'), /class="teams-line rank-\$\{rank\}\$\{n\.depth >= 2 \? ' deep' : ''\}"/);
  assert.match(html, /\n\s*\.simple-view-switch \{ display: none; \}/);
  assert.match(html, /html\.mm-simple \.simple-view-switch \{ display: flex;/);
  assert.match(html, /html\.mm-simple #teams-list \.teams-row\.deep, html\.mm-simple #teams-list \.teams-kids, html\.mm-simple #teams-list \.teams-helpers \{ display: none !important; \}/);
  assert.match(html, /\.teams-sub-simple \{ display: none; \}/);
});
test('Teams CSS: indent steps, amber helpers, dashed empty box, no colour literals', () => {
  const a = html.indexOf('/* Teams view (renderTeams');
  const css = html.slice(a, html.indexOf('/* Multi-user', a));
  assert.match(css, /margin-left: calc\(var\(--d\) \* 18px\)/);
  assert.match(css, /\.teams-helpers \{[^}]*color: var\(--warning\)/);
  assert.match(css, /\.teams-empty \{[^}]*border: 1px dashed/);
  assert.doesNotMatch(css, /teams-label/, 'the Team leaders / Workers headings are gone');
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
});
test('simpleAgentsSync works on #agent-list only', () => {
  const s = fnSrc('simpleAgentsSync');
  assert.doesNotMatch(s.replace(/\/\/.*$/gm, ''), /teams-(list|panel)/);
  assert.match(s, /getElementById\('agent-list'\)/);
});

// ---- setupTabs and the stored view
test('setupTabs: a click stores the view, a reload restores it', () => {
  const w = world();
  w.api.setupTabs();
  w.tabs[1].listeners.click();
  assert.deepStrictEqual(active(w), ['teams']);
  assert.strictEqual(w.store.get('hub-sidebar-view'), 'teams');
  assert.ok(w.panels[1].classList.contains('active') && !w.panels[0].classList.contains('active'));
  const w2 = world({ stored: [['hub-sidebar-view', 'teams']] });
  w2.api.setupTabs();
  assert.deepStrictEqual(active(w2), ['teams']);
  assert.strictEqual(w2.switchBtns[1].attrs['aria-pressed'], 'true');
  assert.strictEqual(w2.switchBtns[0].attrs['aria-pressed'], 'false');
});
test('setupTabs: a stored hidden tab falls back to All Agents; a stored visible one is kept', () => {
  const w = world({ stored: [['hub-sidebar-view', 'guide']] });
  w.api.setupTabs();
  assert.deepStrictEqual(active(w), ['agents']);
  const w2 = world({ stored: [['hub-sidebar-view', 'guide']] });
  w2.tabs[3].hidden = false;
  w2.api.setupTabs();
  assert.deepStrictEqual(active(w2), ['guide']);
  const w3 = world({ stored: [['hub-sidebar-view', 'nonsense']] });
  w3.api.setupTabs();
  assert.deepStrictEqual(active(w3), ['agents']);
});
test('setupTabs: storage that throws is survived', () => {
  const w = world({ storageThrows: true });
  w.api.setupTabs();
  w.tabs[1].listeners.click();
  assert.deepStrictEqual(active(w), ['teams']);
});
test('the Simple switch changes the view with the same key; Simple never lands on Tiger Team or Guide', () => {
  const w = world({ simple: true });
  w.api.setupTabs();
  w.switchBtns[1].listeners.click();
  assert.deepStrictEqual(active(w), ['teams']);
  assert.strictEqual(w.store.get('hub-sidebar-view'), 'teams');
  w.tabs[3].hidden = false;
  w.api.sidebarViewSet('guide', true);
  assert.deepStrictEqual(active(w), ['agents']);
});
test('settings: Tiger Team and Guide tabs show only for admins that turned them on; a hidden active tab falls back', () => {
  const w = world({ stored: [['hub-sidebar-view', 'guide']] });
  w.api.setupTabs();
  assert.deepStrictEqual(active(w), ['agents']);
  w.api.sidebarTabsApply({ sidebarTigerTeam: true, sidebarGuide: true });
  assert.strictEqual(w.tabs[2].hidden, false);
  assert.strictEqual(w.tabs[3].hidden, false);
  assert.deepStrictEqual(active(w), ['guide'], 'the stored view returns once its tab may show');
  w.api.sidebarTabsApply({ sidebarGuide: false });
  assert.strictEqual(w.tabs[3].hidden, true);
  assert.deepStrictEqual(active(w), ['agents']);
  const m = world({ member: true });
  m.api.sidebarTabsApply({ sidebarTigerTeam: true, sidebarGuide: true });
  assert.ok(m.tabs[2].hidden && m.tabs[3].hidden, 'members never see them');
});

// ---- renderTeams
function sample() {
  return [
    A('lead', { category: 'primary', lead: true, icon: '🧭' }),
    A('sam', { category: 'primary' }),
    A('builder', { category: 'worker', reportsTo: 'lead' }),
    A('coder', { category: 'worker', reportsTo: 'builder' }),
    A('writer', { category: 'worker', reportsTo: 'coder' }),
    A('scout', { category: 'specialist' }),
    A('tester', { category: 'experimental' }),
  ];
}
test('renderTeams: every agent once, team sublines, No team yet, helpers line, no empty box when a team exists', () => {
  const w = world({ stored: [['hub-teams-open', JSON.stringify({ lead: true })]] });
  w.ctx.AGENTS = sample();
  w.ctx.agentStatus = {
    writer: { busy: true, busySince: 'x', activity: 'working' },
    h1: { busy: true, worker: true, parent: 'builder' },
    h2: { busy: true, worker: true, parent: 'builder' },
  };
  w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.match(h, /team of 3 · 3 working/);        // builder, coder, writer below lead; coder busy + 2 helpers
  assert.match(h, /leads 2 · 3 working/);          // the leader builder: writer busy + 2 helpers (helper rows are not agents)
  assert.match(h, /No team yet/);                  // sam
  assert.doesNotMatch(h, /Team leaders|Workers|teams-label/);
  assert.match(h, /⚡ 2 helpers under Builder/);
  assert.match(h, /Shared specialists/);
  assert.match(h, /Other \(1\)/);
  assert.doesNotMatch(h, /Agents can work as teams/);
  // tester is folded away in Other; every other agent shows exactly once
  for (const n of ['lead', 'sam', 'builder', 'coder', 'writer', 'scout']) {
    assert.strictEqual((h.match(new RegExp(`data-agent="${n}"`, 'g')) || []).length, 1, n);
  }
  assert.doesNotMatch(h, /data-agent="tester"/);
  assert.match(h, /data-agent="writer"[^>]*data-depth="3"/);   // deeper than a worker: indented further, not dropped
  assert.match(h, /style="--d:3"/);
  assert.match(h, /👑/);
  // writer is busy with no team subline: the short working text
  assert.match(h, /working · 3m/);
  assert.match(h, /class="teams-dot live-busy"/);
});
test('renderTeams: a team of one busy main shows no ", 0 working"; main agents are folded by default', () => {
  const w = world();
  w.ctx.AGENTS = sample();
  w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.match(h, /team of 3</);
  assert.doesNotMatch(h, /0 working/);
  assert.doesNotMatch(h, /data-agent="builder"/);
  assert.match(h, /data-fold="lead"/);
});
test('renderTeams: Other opens from the stored fold state', () => {
  const w = world({ stored: [['hub-teams-open', JSON.stringify({ '@other': true })]] });
  w.ctx.AGENTS = sample();
  w.api.renderTeams();
  assert.match(w.list.innerHTML, /data-agent="tester"/);
});
test('renderTeams: nobody has a team: the empty-state box says how to start', () => {
  const w = world();
  w.ctx.AGENTS = [A('lead', { category: 'primary', lead: true }), A('sam', { category: 'primary' }), A('scout')];
  w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.match(h, /<strong>Agents can work as teams\.<\/strong>/);
  // changed (Set up teams): an admin's box now names the lead and offers "Set up teams" in place of the Build Team sentence
  assert.ok(h.includes('Your main agents plan, decide and review. Short or personal tasks they usually do themselves; long work they can hand to team leaders, who run workers. Lead can look at how your agents already work together and propose teams. Nothing changes until you approve a team.'));
  // changed: the Build Team button sits under each "No team yet" row (admins); the empty-state box itself has only the Set up teams button
  assert.doesNotMatch(h.slice(0, h.indexOf('</div>')), /data-build-team/, 'the empty-state box has no Build Team button (those sit on the rows)');
  assert.strictEqual((h.slice(0, h.indexOf('</div>')).match(/<button/g) || []).length, 1, 'the box has one button: Set up teams');
  assert.strictEqual((h.match(/No team yet/g) || []).length, 2);
  assert.strictEqual((h.match(/<button type="button" class="build-team-btn"/g) || []).length, 2, 'one Build Team button per main agent without a team');
  assert.strictEqual((h.match(/<button/g) || []).length, 6, 'Set up teams, two Build Team buttons and a ⋯ on each of the three rows');
});
test('renderTeams: names are escaped, the dot follows idle / busy / question, leaders get the Simple subline', () => {
  const w = world({ stored: [['hub-teams-open', JSON.stringify({ lead: true })]] });
  w.ctx.AGENTS = [A('lead', { category: 'primary', display: '<img src=x onerror=1>' }), A('builder', { reportsTo: 'lead', display: 'B"><b>' })];
  w.ctx.agentStatus = { lead: { busy: false, pendingQuestion: true } };
  w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.doesNotMatch(h, /<img|<b>/);
  assert.match(h, /&lt;img src=x onerror=1&gt;/);
  assert.match(h, /teams-dot live-question/);
  assert.match(h, /teams-dot live-idle/);
  assert.match(h, /teams-sub teams-sub-simple">Team leader</);
});
// The outer HTML of the div (class starting `cls`) whose first agent row is `name`.
function blockOf(h, cls, name) {
  const re = new RegExp(`<div class="${cls}[^"]*"[^>]*>`, 'g'); let m;
  while ((m = re.exec(h))) {
    const head = h.slice(m.index + m[0].length, m.index + m[0].length + 1200);
    const first = /data-agent="([^"]+)"/.exec(head);
    if (!first || first[1] !== name) continue;
    let depth = 0; const tag = /<(\/?)div\b/g; tag.lastIndex = m.index; let t;
    while ((t = tag.exec(h))) { depth += t[1] ? -1 : 1; if (!depth) return h.slice(m.index, h.indexOf('>', tag.lastIndex) + 1); }
  }
  return null;
}
test('renderTeams: each leader is one block; a worker sits only in its own leader\'s .teams-kids (leaders without workers above and below); no headings', () => {
  const w = world({ stored: [['hub-teams-open', JSON.stringify({ boss: true })]] });
  w.ctx.AGENTS = [A('boss', { category: 'primary' }), A('l1', { reportsTo: 'boss' }), A('l2', { reportsTo: 'boss' }), A('l3', { reportsTo: 'boss' }), A('w1', { reportsTo: 'l2' }), A('w2', { reportsTo: 'l2' })];
  w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.doesNotMatch(h, /Team leaders|Workers|teams-label/);
  assert.match(h, /3 teams · 5 agents/);
  const [b1, b2, b3] = ['l1', 'l2', 'l3'].map((n) => blockOf(h, 'teams-block rank-leader', n));
  assert.ok(b1 && b2 && b3);
  assert.ok(!/w1|w2|teams-kids/.test(b1) && !/w1|w2|teams-kids/.test(b3), 'a leader with no workers is one row, no connector');
  const kids = blockOf(b2, 'teams-kids', 'w1');
  assert.ok(kids && kids.includes('data-agent="w1"') && kids.includes('data-agent="w2"') && !kids.includes('data-agent="l2"'), 'the wrapper holds only that leader\'s workers');
  assert.ok(b2.indexOf('data-agent="l2"') < b2.indexOf('<div class="teams-kids">'), 'the leader row comes first, the workers directly beneath');
  assert.strictEqual((h.match(/data-agent="w1"/g) || []).length, 1);
  assert.ok(h.indexOf(b1) + b1.length <= h.indexOf(b2) && h.indexOf(b2) + b2.length <= h.indexOf(b3), 'blocks follow one another, never nest');
  assert.match(h, /<div class="teams-leaders">/);
});
test('renderTeams: ranks and sublines: main row, leader row, worker row; busy shows its line; K teams · N agents', () => {
  const w = world({ stored: [['hub-teams-open', JSON.stringify({ boss: true, one: true })]] });
  const P = (n) => A(n, { category: 'primary' });
  w.ctx.AGENTS = [P('boss'), P('one'), A('l1', { reportsTo: 'boss' }), A('l2', { reportsTo: 'boss' }), A('w1', { reportsTo: 'l1' }), A('w2', { reportsTo: 'l1' }), A('l9', { reportsTo: 'one' })];
  w.ctx.agentStatus = { w2: { busy: true, busySince: 'x', activity: 'working' } };
  w.api.renderTeams();
  const h = w.list.innerHTML;
  const row = (n) => h.slice(h.indexOf(`data-agent="${n}"`), h.indexOf('</div></div>', h.indexOf(`data-agent="${n}"`)));
  assert.match(h, /<div class="teams-line rank-main"[^>]*>[\s\S]*?<div class="teams-row rank-main"[^>]*data-agent="boss"/);
  assert.match(h, /<div class="teams-line rank-leader"[^>]*>[\s\S]*?<div class="teams-row rank-leader"[^>]*data-agent="l1"/);
  assert.match(h, /<div class="teams-line rank-worker deep"[^>]*>[\s\S]*?<div class="teams-row rank-worker deep"[^>]*data-agent="w1"/);
  assert.match(row('boss'), /2 teams · 4 agents · 1 working</);
  assert.match(row('one'), />team of 1</, 'one leader: team of N');
  assert.match(row('l1'), /Team leader · leads 2 · 1 working</);
  assert.match(row('l2'), />Team leader</);
  assert.doesNotMatch(row('l2'), /leads/);
  assert.match(row('w1'), />Worker</);
  assert.doesNotMatch(row('w2'), />Worker</, 'a busy worker shows its busy line instead');
  assert.match(row('w2'), /teams-sub teams-sub-adv busy/);
});
test('Teams CSS: connector border on the workers wrapper, 8px between leader blocks, three ranks, variables only', () => {
  assert.match(html, /\.teams-kids \{[^}]*border-left: 1px solid var\(--border-strong\)/);
  assert.match(html, /\.teams-block\.rank-leader \{ margin-bottom: 8px; \}/);
  assert.match(html, /\.teams-row\.rank-worker \{[^}]*background: none; border-color: transparent/);
  assert.match(html, /\.teams-row\.rank-worker \.name \{[^}]*color: var\(--text-dim\)/);
  const a = html.indexOf('.teams-leaders {'), css = html.slice(a, html.indexOf('.teams-sub-simple', a));
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
});
test('renderTeams: a row click opens the chat, the fold arrow only folds', () => {
  const w = world();
  w.ctx.AGENTS = sample();
  w.api.renderTeams();
  const row = { dataset: { agent: 'sam', model: 'm/sam' } };
  w.api.teamsClick({ target: { closest: (s) => (s === '.teams-row' ? row : null) } });
  assert.deepStrictEqual(w.started, [['sam', 'm/sam']]);
  const fold = { dataset: { fold: 'lead' } };
  let stopped = false;
  w.api.teamsClick({ stopPropagation: () => { stopped = true; }, target: { closest: (s) => (s === '[data-fold]' ? fold : row) } });
  assert.ok(stopped);
  assert.strictEqual(w.started.length, 1);
  assert.deepStrictEqual(JSON.parse(w.store.get('hub-teams-open')), { lead: true });
  assert.match(w.list.innerHTML, /data-agent="builder"/, 'the team is open now');
});
test('repaint: debounced, and only while the Teams panel is showing', () => {
  const w = world();
  w.ctx.AGENTS = sample();
  w.api.teamsRepaintSoon(); w.api.teamsRepaintSoon();
  assert.strictEqual(w.ctx.timers.length, 1);
  w.ctx.timers[0]();
  assert.strictEqual(w.list.innerHTML, '', 'All Agents is showing: nothing is drawn');
  w.api.sidebarViewSet('teams', false);   // opening the tab draws at once
  assert.match(w.list.innerHTML, /Your agents/);
  w.list.innerHTML = '';
  w.api.teamsRepaintSoon();
  w.ctx.timers[1]();
  assert.match(w.list.innerHTML, /Your agents/);
});
test('repaint hooks: renderAgents, setAgentLive, applyStatusSnapshot and the busy tick call teamsRepaintSoon', () => {
  for (const f of ['renderAgents', 'setAgentLive', 'applyStatusSnapshot', 'agentRowTick']) assert.match(fnSrc(f), /teamsRepaintSoon\(\)/, f);
});

// ---- Settings and Help
test('Settings: two save-at-once checkboxes in Appearance, admins only, ignored by the unsaved-changes check', () => {
  assert.match(app, /<h4>Appearance<\/h4><div id="st-looks-body"><\/div>\$\{isHubAdmin\(\) \? sidebarTabsToggleHtml\(data\) : ''\}<\/div>/);
  const s = fnSrc('sidebarTabsToggleHtml');
  assert.match(s, /'sidebarTigerTeam', 'Show the Tiger Team tab', data\.sidebarTigerTeam === true/);
  assert.match(s, /'sidebarGuide', 'Show the Guide tab', data\.sidebarGuide === true/);
  assert.match(s, /type="checkbox" id="st-\$\{id\}" data-no-dirty/);
  assert.match(s, /onchange="saveSidebarTabToggle\('\$\{key\}', this\.checked\)"/);
  const save = fnSrc('saveSidebarTabToggle');
  assert.match(save, /fetch\('\/api\/settings', \{ method: 'POST'/);
  assert.match(save, /JSON\.stringify\(\{ \[key\]: !!on \}\)/);
  assert.match(save, /sidebarTabsApply\(\{ \[key\]: !!on \}\)/);
  const html2 = vm.runInNewContext(`${hubEscLine}\n${s}\nsidebarTabsToggleHtml({ sidebarGuide: true })`);
  assert.match(html2, /id="st-sidebar-guide" data-no-dirty checked/);
  assert.doesNotMatch(html2, /id="st-sidebar-tiger" data-no-dirty checked/);
});
test('Help: "Using the sidebar" carries the Guide text and the two new sentences', () => {
  assert.match(help, /<h3>Using the sidebar<\/h3>/);
  assert.ok(help.includes('All Agents lists every agent you can use. Teams shows who reports to whom: your main agents, their team leaders and the workers under each leader, with shared specialists below.'));
  for (const t of ['Click an agent', 'Gear icon', 'Free-flowing', 'Autonomous', 'Moderated', 'Full history', 'Summary only', 'Last N', 'Roundtable', 'Led']) assert.ok(help.includes(t), t);
});

test('renderTeams: with storage blocked a fold click still opens the team, and a second click folds it', () => {
  const w = world({ storageThrows: true });
  w.ctx.AGENTS = sample();
  w.api.renderTeams();
  assert.doesNotMatch(w.list.innerHTML, /data-agent="builder"/);
  const click = () => w.api.teamsClick({ stopPropagation() {}, target: { closest: (s) => (s === '[data-fold]' ? { dataset: { fold: 'lead' } } : null) } });
  click();
  assert.match(w.list.innerHTML, /data-agent="builder"/, 'open in page memory');
  click();
  assert.doesNotMatch(w.list.innerHTML, /data-agent="builder"/, 'folded again');
});

test('renderTeams: keyboard focus on a row or a fold button survives a repaint', () => {
  const w = world();
  w.ctx.AGENTS = sample();
  w.api.renderTeams();
  const focused = [], scrolled = [];   // scrolled: restores that did not pass { preventScroll: true }
  const mk = (data) => ({ dataset: data, focus(o) { if (!o || o.preventScroll !== true) scrolled.push(Object.keys(data)[0]); focused.push(Object.keys(data)[0] + ':' + Object.values(data)[0]); } });
  const rows = [mk({ agent: 'sam' }), mk({ agent: 'scout' })], folds = [mk({ fold: 'lead' })];
  w.list.contains = (el) => rows.includes(el) || folds.includes(el);
  w.list.querySelectorAll = (sel) => (sel === '[data-fold]' ? folds : sel === '.teams-row' ? rows : []);
  w.ctx.document.activeElement = rows[1];
  w.ctx.AGENTS = sample().concat([A('zed')]);   // a change: the list is replaced
  w.api.renderTeams();
  assert.deepStrictEqual(focused, ['agent:scout']);
  w.ctx.document.activeElement = folds[0];
  w.ctx.AGENTS = sample().concat([A('zed'), A('yan')]);
  w.api.renderTeams();
  assert.deepStrictEqual(focused, ['agent:scout', 'fold:lead']);
  w.ctx.document.activeElement = null;   // focus elsewhere: nothing is grabbed
  w.ctx.AGENTS = sample();
  w.api.renderTeams();
  assert.strictEqual(focused.length, 2);
  assert.deepStrictEqual(scrolled, [], 'every restored focus passes { preventScroll: true }');
});

test('renderTeams: a member\'s empty state does not offer Build Team', () => {
  const w = world({ member: true });
  w.ctx.AGENTS = [A('assistant', { category: 'primary' })];
  w.api.renderTeams();
  assert.match(w.list.innerHTML, /An admin can set who reports to whom\./);
  assert.doesNotMatch(w.list.innerHTML, /Reports to|Build Team/);
});
test('renderTeams: the fold control is a real button outside the row; the Other header is a button', () => {
  const w = world();
  w.ctx.AGENTS = sample();
  w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.match(h, /<button type="button" class="teams-fold" data-fold="lead" aria-expanded="false" aria-label="Open [^"]*'s team"><span aria-hidden="true">▶<\/span><\/button><div class="teams-row/);
  const row = h.slice(h.indexOf('<div class="teams-row'), h.indexOf('</div></div>', h.indexOf('<div class="teams-row')));
  // changed: the row now holds the ⋯ menu button (always visible); the fold control must still stay outside it
  assert.doesNotMatch(row.replace(/<button type="button" class="agent-menu-btn"[^>]*>⋯<\/button>/, ''), /data-fold|<button/, 'nothing foldable inside the role=button row');
  assert.match(h, /<span class="teams-fold none" aria-hidden="true"><\/span><div class="teams-row[^>]*data-agent="sam"/, 'rows that cannot fold keep a spacer');
  assert.match(h, /<button type="button" class="teams-title teams-title-fold" data-fold="@other" aria-expanded="false">/);
  w.api.teamsClick({ stopPropagation() {}, target: { closest: (s) => (s === '[data-fold]' ? { dataset: { fold: 'lead' }, tagName: 'BUTTON' } : null) } });
  assert.match(w.list.innerHTML, /data-fold="lead" aria-expanded="true" aria-label="Fold /);
  assert.deepStrictEqual(w.started, [], 'folding never starts a chat');
  w.api.teamsClick({ stopPropagation() {}, target: { closest: (s) => (s === '[data-fold]' ? { dataset: { fold: '@other' } } : null) } });
  assert.match(w.list.innerHTML, /data-fold="@other" aria-expanded="true"/);
  assert.deepStrictEqual(w.started, []);
});


// ---- Build team: row menu, Build line, Teams button, Building… state, plan card
const MAIN = (n, over) => A(n, Object.assign({ category: 'primary' }, over));
test('row menu entries: admin gets Settings, a main agent with no team also Build team; a member gets none', () => {
  const w = world();
  w.ctx.AGENTS = [MAIN('boss'), MAIN('solo'), A('sam', { reportsTo: 'boss' })];
  const e = (n) => w.api.agentMenuEntries(w.ctx.AGENTS.find((a) => a.name === n)).map((x) => x.label);
  assert.deepStrictEqual([...e('solo')], ['Settings', 'Build team']);
  assert.deepStrictEqual([...e('boss')], ['Settings'], 'a main agent with a team has no Build team entry');
  assert.deepStrictEqual([...e('sam')], ['Settings'], 'a worker is not a main agent');
  const m = world({ member: true });
  m.ctx.AGENTS = [MAIN('solo')];
  assert.strictEqual(m.api.agentMenuEntries(m.ctx.AGENTS[0]).length, 0);
  assert.strictEqual(m.api.agentMenuBtnHtml(m.ctx.AGENTS[0], 'span'), '', 'no entries, no button');
  const s = world({ simple: true });
  s.ctx.AGENTS = [MAIN('solo')];
  assert.strictEqual(s.api.agentMenuEntries(s.ctx.AGENTS[0]).length, 0, 'Simple shows no controls');
  assert.strictEqual(s.api.buildLineHtml(s.ctx.AGENTS[0]), '');
});
test('the ⋯ button: aria-label, menu popup, always present for an admin; span in the All Agents row, button in Teams', () => {
  const w = world();
  w.ctx.AGENTS = [MAIN('solo', { display: 'Solo' })];
  const sp = w.api.agentMenuBtnHtml(w.ctx.AGENTS[0], 'span');
  assert.match(sp, /^<span role="button" tabindex="0" class="agent-menu-btn" data-menu-agent="solo" aria-haspopup="menu" aria-expanded="false" aria-label="More for Solo"/);
  assert.match(w.api.agentMenuBtnHtml(w.ctx.AGENTS[0], 'button'), /^<button type="button" class="agent-menu-btn"/);
  const row = w.api.agentButton(w.ctx.AGENTS[0]);
  assert.doesNotMatch(row, /gear-btn|&#9881;/, 'the hover gear is gone');
  assert.match(row, /class="agent-menu-btn"/);
  assert.strictEqual((row.match(/<button/g) || []).length, 1, 'only the row itself is a button; the ⋯ is a span role=button inside it');
});
test('Build line: admins see "No team yet · Build team" on a main agent with no team; rows with a team and other agents do not', () => {
  const w = world();
  w.ctx.AGENTS = [MAIN('boss'), MAIN('solo'), A('sam', { reportsTo: 'boss' }), A('spec')];
  const line = (n) => w.api.buildLineHtml(w.ctx.AGENTS.find((a) => a.name === n));
  assert.match(line('solo'), /^<span class="agent-build-line">No team yet · <span role="button" tabindex="0" class="build-team-link" data-build-team="solo"[^>]*>Build team<\/span><\/span>$/);
  assert.strictEqual(line('boss'), '', 'a row with a team keeps today\'s height');
  assert.strictEqual(line('spec'), '');
  assert.match(w.api.agentButton(w.ctx.AGENTS[1]), /agent-build-line/);
  assert.doesNotMatch(w.api.agentButton(w.ctx.AGENTS[0]), /agent-build-line/);
  const m = world({ member: true });
  m.ctx.AGENTS = [MAIN('solo')];
  assert.strictEqual(m.api.buildLineHtml(m.ctx.AGENTS[0]), '', 'members never see it');
});
test('Teams tab: a labelled Build Team button under "No team yet" for admins only; a ⋯ on every row', () => {
  const w = world();
  w.ctx.AGENTS = [MAIN('boss'), MAIN('solo'), A('sam', { reportsTo: 'boss' })];
  w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.match(h, /No team yet<\/span><button type="button" class="build-team-btn" data-build-team="solo"[^>]*>Build Team<\/button>/);
  assert.strictEqual((h.match(/build-team-btn"/g) || []).length, 1, 'only the main agent without a team');
  assert.ok((h.match(/class="agent-menu-btn"/g) || []).length >= 2, 'the ⋯ is on the Teams rows');
  const m = world({ member: true });
  m.ctx.AGENTS = [MAIN('solo')];
  m.api.renderTeams();
  assert.doesNotMatch(m.list.innerHTML, /build-team-btn|agent-menu-btn/);
});
test('Building…: any status entry with buildingTeamFor === name disables all three controls and the menu entry', () => {
  const w = world();
  w.ctx.AGENTS = [MAIN('solo'), MAIN('lead')];
  w.ctx.agentStatus = { lead: { busy: true, buildingTeamFor: 'solo' } };
  assert.match(w.api.buildLineHtml(w.ctx.AGENTS[0]), /class="build-team-link is-building"[^>]*aria-disabled="true"[^>]*>Building…</);
  assert.strictEqual(JSON.stringify(w.api.agentMenuEntries(w.ctx.AGENTS[0]).map((x) => [x.label, !!x.disabled])), '[["Settings",false],["Building…",true]]');
  w.api.renderTeams();
  assert.match(w.list.innerHTML, /<button type="button" class="build-team-btn is-building"[^>]*aria-disabled="true"[^>]*disabled>Building…<\/button>/);
  assert.match(w.api.buildLineHtml(w.ctx.AGENTS[1]), />Build team</, 'another agent is not building');
  // paintBuildControls retitles live controls when the field arrives or goes
  const el = fakeEl({ tagName: 'SPAN', dataset: { buildTeam: 'solo', idle: 'Build team' }, textContent: 'Build team' });
  w.ctx.buildEls = [el];
  w.api.paintBuildControls();
  assert.strictEqual(el.textContent, 'Building…');
  assert.strictEqual(el.attrs['aria-disabled'], 'true');
  w.ctx.agentStatus = {};
  w.api.paintBuildControls();
  assert.strictEqual(el.textContent, 'Build team');
});
test('buildTeamStart: 202 opens the lead\'s chat with its model; an error alerts the server\'s text; a second click while building does nothing', async () => {
  const w = world();
  w.ctx.AGENTS = [MAIN('solo'), MAIN('lead', { model: 'x/lead-model' })];
  const calls = [];
  w.ctx.fetch = async (url, o) => { calls.push([url, o.method]); return { status: 202, ok: true, json: async () => ({ ok: true, lead: 'lead', turnId: 't1' }) }; };
  await w.api.buildTeamStart('solo');
  assert.deepStrictEqual(calls, [['/api/agents/solo/build-team', 'POST']]);
  assert.deepStrictEqual(w.started, [['lead', 'x/lead-model']]);
  w.ctx.fetch = async () => ({ status: 409, ok: false, json: async () => ({ error: 'already building a team for Solo' }) });
  await w.api.buildTeamStart('solo');
  assert.deepStrictEqual(w.ctx.alerts, ['already building a team for Solo']);
  assert.strictEqual(w.started.length, 1, 'an error opens no chat');
  w.ctx.agentStatus = { lead: { busy: true, buildingTeamFor: 'solo' } };
  let n = 0; w.ctx.fetch = async () => { n++; return { ok: false }; };
  await w.api.buildTeamStart('solo');
  assert.strictEqual(n, 0, 'disabled while building');
});
test('the shared menu: right-click path opens it, Escape closes it, a row with no entries opens nothing, Settings opens the settings window', () => {
  const w = world();
  w.ctx.AGENTS = [MAIN('solo')];
  w.ctx.window = { innerWidth: 1000, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
  assert.strictEqual(w.api.agentMenuOpenAt('solo', 10, 20, null), true);
  const menu = w.document.body.menu;
  assert.strictEqual(menu.attrs.role, 'menu');
  assert.match(menu.innerHTML, /role="menuitem" class="agent-menu-item" data-act="settings">Settings<\/button><button type="button" role="menuitem" class="agent-menu-item" data-act="build">Build team</);
  const esc = w.document.docListeners.find((x) => x[0] === 'keydown');
  assert.ok(esc, 'Escape is listened for');
  esc[1]({ key: 'Escape' });
  assert.ok(menu.removed, 'Escape closes it');
  assert.strictEqual(w.document.docListeners.length, 0, 'its listeners go with it');
  assert.strictEqual(w.api.agentMenuOpenAt('solo', 1, 1, null), true);
  const down = w.document.docListeners.find((x) => x[0] === 'mousedown');
  down[1]({ target: {} });
  assert.ok(w.document.body.menu.removed, 'an outside click closes it');
  const m = world({ member: true });
  m.ctx.AGENTS = [MAIN('solo')]; m.ctx.window = w.ctx.window;
  assert.strictEqual(m.api.agentMenuOpenAt('solo', 1, 1, null), false);
  assert.strictEqual(m.document.body.menu, undefined);
  // Settings entry: click handler calls openAgentSettings
  assert.strictEqual(w.api.agentMenuOpenAt('solo', 1, 1, null), true);
  const live = w.document.body.menu;
  live.listeners.click({ target: { closest: () => ({ dataset: { act: 'settings' }, disabled: false }) }, stopPropagation() {} });
  assert.deepStrictEqual(w.opened, ['solo']);
  assert.ok(live.removed);
});
test('app.js wiring: right-click on a row, keyboard, status copy points carry buildingTeamFor, Simple and CSS pins', () => {
  assert.match(app, /document\.addEventListener\('contextmenu'[\s\S]{0,300}#agent-list \.agent-btn\[data-agent\], #teams-list \.teams-row\[data-agent\]/);
  // changed (Set up teams): the same key list also carries offerPending and settingUpTeams
  assert.match(app, /for \(const k of \['worker', 'parent', 'label', 'model', 'consultedBy', 'buildingTeamFor', 'offerPending', 'settingUpTeams'\]\)/, 'applyStatusSnapshot copies it');
  assert.match(app, /pendingQuestion: a\.pendingQuestion, buildingTeamFor: a\.buildingTeamFor \|\| null/, 'loadAgents copies it');
  assert.match(app, /next\.consultedBy = null; next\.buildingTeamFor = null;/, 'idle clears it');
  assert.match(html, /\.agent-btn:has\(\.agent-menu-btn\) \.agent-info \{ padding-right: 18px; \}/);
  assert.match(html, /\.agent-btn \.name-text \{ overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; \}/, 'long names truncate (160px and 240px sidebars)');
  assert.match(html, /html\.mm-simple \.agent-menu-btn, html\.mm-simple \.agent-build-line, html\.mm-simple \.build-team-btn \{ display: none !important; \}/);
  assert.doesNotMatch(html, /\.gear-btn/, 'the hover gear CSS is gone');
  const css = html.slice(html.indexOf('.agent-menu-btn {'), html.indexOf('.agent-btn .add-btn'));
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'existing variables only');
  assert.match(css, /width: 24px; height: 24px/);
});
test('plan card: checklist rows (all ticked, label bold, detail small), checked ids in the body, no Skip or typed answer', () => {
  const w = world();
  const q = [{ question: 'Plan?', options: [{ label: 'Do it' }, { label: 'Change something' }, { label: 'Not now' }], checklist: [{ id: 'a1', label: 'New agent <b>x</b>', detail: 'why' }, { id: 'l2', label: 'Line' }, { id: '', label: 'bad' }, null] }];
  const list = w.api.questionChecklistOf(q);
  assert.deepStrictEqual(list.map((x) => x.id), ['a1', 'l2'], 'malformed items are dropped');
  const h = w.api.questionChecklistHtml(list, (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  assert.strictEqual((h.match(/type="checkbox" checked/g) || []).length, 2, 'all ticked at first');
  assert.match(h, /<strong>New agent &lt;b&gt;x&lt;\/b&gt;<\/strong><small>why<\/small>/);
  assert.strictEqual(w.api.questionChecklistOf([{ question: 'q', options: [] }]), null);
  assert.strictEqual(w.api.questionChecklistOf([{ question: 'q', checklist: [] }]), null);
  assert.strictEqual(w.api.askResponseBody('r1', { 0: 'Do it' }, 'lead', ['a1']), '{"request_id":"r1","answers":{"0":"Do it"},"agent":"lead","checked":["a1"]}');
  assert.strictEqual(w.api.askResponseBody('r1', { 0: 'Do it' }, '', null), '{"request_id":"r1","answers":{"0":"Do it"}}', 'a plain card sends no checked field');
  assert.strictEqual(w.api.askResponseBody('r1', { 0: 'Not now' }, 'lead', []), '{"request_id":"r1","answers":{"0":"Not now"},"agent":"lead","checked":[]}', 'nothing ticked is an empty list');
  const body = fnSrc('showQuestionModal');
  assert.match(body, /const canSkip = !checklist && /);
  assert.match(body, /if \(!textOnly && !checklist\) html \+= '<div class="question-divider">/);
  assert.match(body, /if \(!checklist\) html \+= `<textarea/);
  assert.match(body, /checklist \? questionCheckedIds\(overlay\) : null/);
});
test('hubTeams.hasTeam: true only for a main agent with someone under it', () => {
  const list = [MAIN('boss'), MAIN('solo'), A('sam', { reportsTo: 'boss' }), A('spec')];
  assert.strictEqual(hubTeams.hasTeam('boss', list), true);
  assert.strictEqual(hubTeams.hasTeam('solo', list), false);
  assert.strictEqual(hubTeams.hasTeam('sam', list), false, 'a worker is not a main agent');
  assert.strictEqual(hubTeams.hasTeam('nobody', list), false);
  assert.strictEqual(hubTeams.hasTeam('solo', null), false);
});

test('Teams rows show the background-work ring and line (lib/ui-agent-dot.js), only when the agent is free', () => {
  const w = world({ stored: [['hub-teams-open', JSON.stringify({ lead: true })]] });
  w.ctx.AGENTS = sample();
  w.ctx.agentStatus = { builder: { busy: false, background: 2 }, writer: { busy: true, background: 3, busySince: 'x', activity: 'working' } };
  w.api.renderTeams();
  const h = w.list.innerHTML;
  const row = (n) => { const i = h.indexOf(`data-agent="${n}"`); return h.slice(i, h.indexOf('</div></div>', i)); };
  assert.match(row('builder'), /class="teams-dot[^"]*\bbg-work\b/);
  assert.match(row('builder'), /Free · 2 things in the background/);
  assert.doesNotMatch(row('writer'), /bg-work|in the background/, 'replying: no ring');
  assert.match(html, /\.teams-dot\.bg-work:not\(\.live-busy\):not\(\.live-question\)/);
});
