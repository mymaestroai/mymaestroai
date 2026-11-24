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
    "const optimizeTeamPending = new Set(); const optimizeEstimates = {};",
    fnSrc('teamBuilding'), fnSrc('agentCanBuildTeam'), fnSrc('teamReviewing'), fnSrc('agentCanOptimizeTeam'), fnSrc('optimizeSubText'), fnSrc('agentMenuEntries'),
    'async ' + fnSrc('optimizeTeamStart'), fnSrc('optimizeEstimateLoad'), fnSrc('agentMenuBtnHtml'), fnSrc('buildTeamCtlHtml'), fnSrc('buildLineHtml'),
    fnSrc('paintBuildControls'), 'async ' + fnSrc('buildTeamStart'), fnSrc('agentMenuClose'), fnSrc('agentMenuOpenAt'), fnSrc('agentMenuToggle'), fnSrc('agentButton'),
    fnSrc('questionChecklistOf'), fnSrc('questionChecklistHtml'), fnSrc('questionCheckedIds'), fnSrc('askResponseBody'),
    fnSrc('teamsPillHtml'), fnSrc('teamsRowHtml'), fnSrc('teamsBlockHtml'), fnSrc('teamsSubtreeHtml'), fnSrc('renderTeams'), fnSrc('teamsRepaintSoon'),
    // Set up teams (renderTeams, setupTabs and teamsClick call these): the harness carries them so the pinned Teams tests keep running as before.
    "let teamSetup = { offer: null, lead: null, setups: [], alone: {} }; let teamSetupStarting = false; const teamSetupRecent = new Set(); let teamSetupLoadTimer = 0; const chats = {};",
    fnSrc('agentWorksAlone'), fnSrc('teamSetupLeadDisplay'), fnSrc('teamSetupBusy'), fnSrc('teamSetupLines'), fnSrc('teamSetupDate'), fnSrc('teamSetupLineHtml'), fnSrc('teamSetupApply'),
    'async ' + fnSrc('teamSetupLoad'), fnSrc('teamSetupLoadSoon'), fnSrc('teamSetupPaint'), fnSrc('teamSetupOfferHtml'), fnSrc('teamSetupUndoRows'), fnSrc('teamSetupChatPaint'),
    'async ' + fnSrc('teamSetupStart'), 'async ' + fnSrc('teamSetupUndo'), 'function setAgentLive() {} function loadAgents() { return Promise.resolve(); }',
    'this.api = { setupTabs, sidebarViewSet, sidebarTabsApply, renderTeams, teamsClick, teamsRepaintSoon, teamsOpenToggle, agentMenuEntries, agentMenuBtnHtml, buildLineHtml, agentButton, buildTeamStart, optimizeTeamStart, agentMenuOpenAt, agentMenuClose, paintBuildControls, questionChecklistOf, questionChecklistHtml, askResponseBody };'].join('\n');
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
test('Simple: two-part switch is hidden in Advanced, shown in Simple; Teams view no longer hides workers (only helper lines); no deep-row hide rule', () => {
  assert.match(html, /<div class="simple-view-switch"[^>]*>\s*<button type="button" data-view="agents" aria-pressed="true">All Agents<\/button>\s*<button type="button" data-view="teams" aria-pressed="false">Teams<\/button>/);
  // changed (Teams redesign, spec 'Simple shows workers'): the "Simple: no workers" rule is gone; a leader's workers are not rendered while its pill is folded
  assert.doesNotMatch(html, /Simple: no workers/);
  assert.doesNotMatch(html, /html\.mm-simple #teams-list \.teams-line\.deep|html\.mm-simple #teams-list \.teams-row\.deep|html\.mm-simple #teams-list \.teams-kids \{ display: none/);
  assert.match(html, /html\.mm-simple #teams-list \.teams-helpers \{ display: none !important; \}/, 'helper lines stay out of Simple');
  assert.match(fnSrc('teamsRowHtml'), /class="teams-line rank-\$\{rank\}\$\{deep \? ' deep' : ''\}/);
  assert.match(fnSrc('teamsRowHtml'), /const deep = n\.depth >= 2;/);
  assert.match(html, /\n\s*\.simple-view-switch \{ display: none; \}/);
  assert.match(html, /html\.mm-simple \.simple-view-switch \{ display: flex;/);
});
test('Teams CSS: wrapper indent, amber helpers, dashed empty box, no colour literals', () => {
  const a = html.indexOf('/* Teams view (renderTeams');
  const css = html.slice(a, html.indexOf('/* Multi-user', a));
  // changed (Teams redesign): the old --d depth indent is replaced by one joining-line wrapper per group (.teams-leaders / .teams-kids), see teams-indent.test.js
  assert.match(css, /\.teams-leaders \{ margin-left: 36px; padding-left: 1px; \}/);
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
// A row's markup: from its data-agent to the end of the row (the ⋯ button, if any, ends it).
const rowOf = (h, n) => { const i = h.indexOf(`data-agent="${n}"`); return i < 0 ? '' : h.slice(i, h.indexOf('</div></div>', i)); };
test('renderTeams: every agent once, section headers with counts, pills, helpers line, no empty box when a team exists', () => {
  const w = world({ stored: [['hub-teams-open', JSON.stringify({ lead: true, builder: true })]] });
  w.ctx.AGENTS = sample();
  w.ctx.agentStatus = {
    writer: { busy: true, busySince: 'x', activity: 'working' },
    h1: { busy: true, worker: true, parent: 'builder' },
    h2: { busy: true, worker: true, parent: 'builder' },
  };
  w.api.renderTeams();
  const h = w.list.innerHTML;
  // changed (Teams redesign): four counted headers plus Other replace "Your agents"; the size moved into the pill ("3 ▾") and the "· N working" role lines are gone
  assert.match(h, /class="teams-title teams-title-fold" data-fold="@sec:teams" aria-expanded="true"><span class="teams-glyph open" aria-hidden="true">▶<\/span>Teams · 1</);
  assert.match(h, /class="teams-title teams-title-fold" data-fold="@sec:none" aria-expanded="true"><span class="teams-glyph open" aria-hidden="true">▶<\/span>No team yet · 1</);                 // sam
  assert.match(h, /class="teams-title teams-title-fold" data-fold="@sec:shared" aria-expanded="true"><span class="teams-glyph open" aria-hidden="true">▶<\/span>Shared specialists · 1</);
  assert.match(h, /Other · 1/);
  assert.doesNotMatch(h, /Your agents|Team leaders|Workers|teams-label|team of|working</);
  assert.match(h, /data-fold="lead" aria-expanded="true" aria-label="3 agents, hide team"[^>]*><span class="teams-pill">3&#x2009;<span aria-hidden="true">▾<\/span>/);
  assert.match(h, /data-fold="builder" aria-expanded="true" aria-label="2 workers, hide workers"/);   // the leader's own pill
  assert.match(h, /⚡ 2 helpers under Builder/);
  assert.doesNotMatch(h, /Agents can work as teams/);
  // tester is folded away in Other; every other agent shows exactly once
  for (const n of ['lead', 'sam', 'builder', 'coder', 'writer', 'scout']) {
    assert.strictEqual((h.match(new RegExp(`data-agent="${n}"`, 'g')) || []).length, 1, n);
  }
  assert.doesNotMatch(h, /data-agent="tester"/);
  assert.match(h, /data-agent="writer"[^>]*data-depth="3"/);   // deeper than a worker: indented further, not dropped
  assert.match(h, /👑/);
  // writer is replying: what it is doing follows its name on the same line, in orange (no second line)
  assert.match(rowOf(h, 'writer'), /<span class="teams-live" title="working · 3m">· working · 3m<\/span>/);
  assert.doesNotMatch(rowOf(h, 'writer'), /teams-sub/);
  assert.match(h, /class="teams-dot live-busy"/);
});
test('renderTeams: a team is folded by default (pill "3 ▸", aria-expanded false), no ", 0 working"', () => {
  const w = world();
  w.ctx.AGENTS = sample();
  w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.match(h, /data-fold="lead" aria-expanded="false" aria-label="3 agents, show team"[^>]*><span class="teams-pill">3&#x2009;<span aria-hidden="true">▸<\/span>/);
  assert.doesNotMatch(h, /0 working/);
  assert.doesNotMatch(h, /data-agent="builder"/);
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
  // changed (Teams redesign): the words "No team yet" are the section header (with its count), not on each row; the link is just "Build team" on the row's second line
  assert.strictEqual((h.match(/No team yet/g) || []).length, 1);
  assert.match(h, /No team yet · 2</);
  assert.strictEqual((h.match(/<span class="teams-sub teams-sub-build"><span role="button"[^>]*class="build-team-link"/g) || []).length, 2, 'one Build team link per main agent without a team, inside its second line');
  assert.strictEqual((h.match(/<button/g) || []).length, 6, 'Set up teams, a ⋯ on each of the three rows (no Build Team buttons) and the two section header buttons (the headers are fold buttons now)');
});
test('renderTeams: names are escaped, the dot follows idle / busy / question, no "Reports to" or role lines', () => {
  const w = world({ stored: [['hub-teams-open', JSON.stringify({ lead: true })]] });
  w.ctx.AGENTS = [A('lead', { category: 'primary', display: '<img src=x onerror=1>' }), A('builder', { reportsTo: 'lead', display: 'B"><b>' }), A('coder', { reportsTo: 'builder' })];
  w.ctx.agentStatus = { lead: { busy: false, pendingQuestion: true } };
  w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.doesNotMatch(h, /<img|<b>/);
  assert.match(h, /&lt;img src=x onerror=1&gt;/);
  assert.match(h, /teams-dot live-question/);
  assert.match(h, /teams-dot live-idle/);
  assert.doesNotMatch(h, /Team leader|Reports to|teams-sub-simple/);
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
  const w = world({ stored: [['hub-teams-open', JSON.stringify({ boss: true, l2: true })]] });   // l2's own pill is open (a leader's workers start folded)
  w.ctx.AGENTS = [A('boss', { category: 'primary' }), A('l1', { reportsTo: 'boss' }), A('l2', { reportsTo: 'boss' }), A('l3', { reportsTo: 'boss' }), A('w1', { reportsTo: 'l2' }), A('w2', { reportsTo: 'l2' })];
  w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.doesNotMatch(h, /Team leaders|Workers|teams-label/);
  assert.match(h, /aria-label="5 agents, hide team"/, 'the main\'s pill says the whole team');
  const b2 = blockOf(h, 'teams-block rank-leader', 'l2');
  const [b1, b3] = ['l1', 'l3'].map((n) => blockOf(h, 'teams-block rank-worker', n));   // direct reports with nobody under them are workers
  assert.ok(b1 && b2 && b3);
  assert.ok(!/w1|w2|teams-kids/.test(b1) && !/w1|w2|teams-kids/.test(b3), 'a leader with no workers is one row, no connector');
  const kids = blockOf(b2, 'teams-kids', 'w1');
  assert.ok(kids && kids.includes('data-agent="w1"') && kids.includes('data-agent="w2"') && !kids.includes('data-agent="l2"'), 'the wrapper holds only that leader\'s workers');
  assert.ok(b2.indexOf('data-agent="l2"') < b2.indexOf('<div class="teams-kids">'), 'the leader row comes first, the workers directly beneath');
  assert.strictEqual((h.match(/data-agent="w1"/g) || []).length, 1);
  assert.ok(h.indexOf(b1) + b1.length <= h.indexOf(b2) && h.indexOf(b2) + b2.length <= h.indexOf(b3), 'blocks follow one another, never nest');
  assert.match(h, /<div class="teams-leaders">/);
});
test('renderTeams: ranks: main row, leader row, worker row; replying shows after the name; each fold control is a pill', () => {
  const w = world({ stored: [['hub-teams-open', JSON.stringify({ boss: true, one: true, l1: true })]] });
  const P = (n) => A(n, { category: 'primary' });
  w.ctx.AGENTS = [P('boss'), P('one'), A('l1', { reportsTo: 'boss' }), A('l2', { reportsTo: 'boss' }), A('w1', { reportsTo: 'l1' }), A('w2', { reportsTo: 'l1' }), A('w3', { reportsTo: 'l2' }), A('l9', { reportsTo: 'one' })];
  w.ctx.agentStatus = { w2: { busy: true, busySince: 'x', activity: 'working' } };
  w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.match(h, /<div class="teams-line rank-main has-kids"[^>]*>[\s\S]*?<div class="teams-row rank-main"[^>]*data-agent="boss"/);
  assert.match(h, /<div class="teams-line rank-leader has-kids"[^>]*>[\s\S]*?<div class="teams-row rank-leader"[^>]*data-agent="l1"/);
  assert.match(h, /<div class="teams-line rank-leader"[^>]*>[\s\S]*?<div class="teams-row rank-leader"[^>]*data-agent="l2"/, 'a folded leader: no has-kids');
  assert.match(h, /<div class="teams-line rank-worker deep"[^>]*>[\s\S]*?<div class="teams-row rank-worker deep"[^>]*data-agent="w1"/);
  assert.match(rowOf(h, 'boss'), /aria-label="5 agents, hide team"/);
  assert.match(rowOf(h, 'one'), /aria-label="1 agent, hide team"/, 'one direct report: singular');
  assert.match(rowOf(h, 'l1'), /aria-label="2 workers, hide workers"/);
  assert.match(rowOf(h, 'l2'), /aria-label="1 worker, show workers"/);
  assert.doesNotMatch(h, /data-agent="w3"/, 'l2 is folded: its worker is not drawn');
  assert.doesNotMatch(h, /Team leader|Worker<|Reports to|leads \d/, 'one line per member: no role line, no Reports to');
  assert.match(rowOf(h, 'w2'), /teams-live/);
  assert.doesNotMatch(rowOf(h, 'w2'), /teams-sub/);
});
test('renderTeams: a main with three direct reports who lead nobody: worker look, one pill "3", no role lines', () => {
  const w = world({ stored: [['hub-teams-open', JSON.stringify({ atlas: true })]] });
  w.ctx.AGENTS = [A('atlas', { category: 'primary' }), A('editor', { reportsTo: 'atlas' }), A('scout', { reportsTo: 'atlas' }), A('writer', { reportsTo: 'atlas' })];
  w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.match(h, /aria-label="3 agents, hide team"/);
  assert.doesNotMatch(h, /team of|Team leader|rank-leader|sub-narrow|Leads |Reports to/);
  for (const n of ['editor', 'scout', 'writer']) {
    assert.match(h, new RegExp(`<div class="teams-row rank-worker"[^>]*data-agent="${n}"`));
  }
  assert.strictEqual((h.match(/class="teams-pill-btn/g) || []).length, 1, 'only the main has a pill');
});
test('renderTeams: two real leaders and one direct report with nobody under it: three pills, leaders folded', () => {
  const w = world({ stored: [['hub-teams-open', JSON.stringify({ atlas: true })]] });
  w.ctx.AGENTS = [A('atlas', { category: 'primary' }), A('editor', { reportsTo: 'atlas' }), A('builder', { reportsTo: 'atlas' }), A('scout', { reportsTo: 'atlas' }),
    A('writer', { reportsTo: 'editor' }), A('coder', { reportsTo: 'builder' })];
  w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.match(rowOf(h, 'atlas'), /aria-label="5 agents, hide team"/);
  assert.match(h, /<div class="teams-row rank-leader"[^>]*data-agent="editor"/);
  assert.match(h, /<div class="teams-row rank-leader"[^>]*data-agent="builder"/);
  assert.match(h, /<div class="teams-row rank-worker"[^>]*data-agent="scout"/);
  assert.strictEqual((h.match(/aria-label="1 worker, show workers"/g) || []).length, 2);
  assert.doesNotMatch(h, /data-agent="writer"|data-agent="coder"/, 'a leader\'s workers start folded');
  assert.doesNotMatch(h, /Team leader|Reports to/);
});
test('Teams: a direct worker is not deep; a worker under a leader is deep and drawn only while the leader\'s pill is open', () => {
  const w = world({ stored: [['hub-teams-open', JSON.stringify({ atlas: true, editor: true })]] });
  w.ctx.AGENTS = [A('atlas', { category: 'primary' }), A('editor', { reportsTo: 'atlas' }), A('scout', { reportsTo: 'atlas' }), A('writer', { reportsTo: 'editor' })];
  w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.match(h, /<div class="teams-line rank-worker"><div class="teams-row rank-worker" [^>]*data-agent="scout"[^>]*data-depth="1"/, 'worker look, not deep');
  assert.doesNotMatch(rowOf(h, 'scout'), /Reports to/);
  assert.match(h, /<div class="teams-row rank-worker deep"[^>]*data-agent="writer"[^>]*data-depth="2"/, 'a worker under a leader stays deep');
  w.api.teamsOpenToggle('editor'); w.api.renderTeams();
  assert.doesNotMatch(w.list.innerHTML, /data-agent="writer"/, 'folded again');
});
test('Teams (Simple): rows carry the three rank classes, and Simple CSS sizes worker < leader < main', () => {
  const w = world({ stored: [['hub-teams-open', JSON.stringify({ atlas: true })]], simple: true });
  w.ctx.AGENTS = [A('atlas', { category: 'primary' }), A('editor', { reportsTo: 'atlas' }), A('scout', { reportsTo: 'atlas' }), A('writer', { reportsTo: 'editor' })];
  w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.match(h, /<div class="teams-row rank-main"[^>]*data-agent="atlas"/);
  assert.match(h, /<div class="teams-row rank-leader"[^>]*data-agent="editor"/);
  assert.match(h, /<div class="teams-row rank-worker"[^>]*data-agent="scout"/);
  const simple = html.split('\n').filter((l) => /html\.mm-simple #teams-list/.test(l)).join('\n');
  const px = (re) => { const m = simple.match(re); assert.ok(m, String(re)); return parseFloat(m[1]); };
  // changed (Teams redesign): the rules now also set the line height, so the pattern reads font-size anywhere inside the rule
  const main = px(/\.teams-row \.name \{[^}]*?font-size: ([\d.]+)px/);
  const leader = px(/\.teams-row\.rank-leader \.name \{[^}]*?font-size: ([\d.]+)px/);
  const worker = px(/\.teams-row\.rank-worker \.name \{[^}]*?font-size: ([\d.]+)px/);
  assert.ok(worker < leader && leader < main, `name sizes ${worker} < ${leader} < ${main}`);
  assert.match(simple, /\.teams-row\.rank-worker \.name \{[^}]*color: var\(--text-dim\)/);
  const icon = (r) => px(new RegExp(`\\.teams-row\\.${r} \\.agent-icon \\{[^}]*?font-size: ([\\d.]+)px`));
  assert.ok(icon('rank-worker') < icon('rank-leader'));
  const hgt = (r) => px(new RegExp(`\\.teams-row${r} \\{ height: ([\\d.]+)px`));
  assert.deepStrictEqual([hgt(''), hgt('\\.rank-leader'), hgt('\\.rank-worker')], [48, 40, 30], 'Simple rows: main 48, leader 40, member 30');
  // no Teams sub-line below 12px in Simple
  assert.ok(px(/\.teams-sub \{[^}]*?font-size: ([\d.]+)px/) >= 12);
});
test('Teams CSS: joining line on every group, 2px between leader blocks, three ranks, variables only', () => {
  assert.match(html, /\.teams-block::before \{[^}]*width: 1px; background: var\(--tm-line\)/);
  assert.match(html, /html \{ --tm-line: var\(--border-strong\); \}/);
  assert.match(html, /\.teams-block > \.teams-line::before \{[^}]*height: 1px; background: var\(--tm-line\)/, 'a tick to every row');
  assert.match(html, /\.teams-block\.rank-leader \{ padding-bottom: 2px; \}/);
  assert.match(html, /\.teams-row\.rank-worker \{[^}]*background: none; border-color: transparent/);
  assert.match(html, /\.teams-row\.rank-worker \.name \{[^}]*color: var\(--text-dim\)/);
  const a = html.indexOf('.teams-leaders {'), css = html.slice(a, html.indexOf('/* A narrow sidebar', a));
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
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
  assert.match(w.list.innerHTML, /Teams · 1/);
  w.list.innerHTML = '';
  w.api.teamsRepaintSoon();
  w.ctx.timers[1]();
  assert.match(w.list.innerHTML, /Teams · 1/);
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
test('renderTeams: the fold control is the pill, a real button with aria-expanded; the Other header is a button', () => {
  const w = world();
  w.ctx.AGENTS = sample();
  w.api.renderTeams();
  const h = w.list.innerHTML;
  // changed (Teams redesign): the left fold-arrow column is gone; the pill after the boss's name is the fold control (inside the row, a button, it stops the click)
  assert.doesNotMatch(h, /teams-fold|▶<\/span><\/button><div class="teams-row/);
  assert.match(h, /<button type="button" class="teams-pill-btn" data-fold="lead" aria-expanded="false" aria-label="3 agents, show team" title="Show Lead's team">/);
  assert.match(h, /<button type="button" class="teams-title teams-title-fold" data-fold="@other" aria-expanded="false">/);
  assert.match(h, /<div class="teams-row rank-main[^>]*data-agent="sam"/, 'a main without a team has no pill');
  assert.doesNotMatch(rowOf(h, 'sam'), /data-fold/);
  let stopped = false;
  w.api.teamsClick({ stopPropagation: () => { stopped = true; }, target: { closest: (s) => (s === '[data-fold]' ? { dataset: { fold: 'lead' }, tagName: 'BUTTON' } : s === '.teams-row' ? { dataset: { agent: 'lead', model: 'm' } } : null) } });
  assert.ok(stopped, 'the click stops here');
  assert.match(w.list.innerHTML, /data-fold="lead" aria-expanded="true" aria-label="3 agents, hide team"/);
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
  assert.deepStrictEqual([...e('boss')], ['Settings', 'Optimize team'], 'a main agent with a team has Optimize team, never Build team');
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
  assert.match(line('solo'), /^<span class="agent-build-line"><span class="tbs-prefix">No team yet · <\/span><span role="button" tabindex="0" class="build-team-link" data-build-team="solo"[^>]*>Build team<\/span><\/span>$/);
  assert.strictEqual(line('boss'), '', 'a row with a team keeps today\'s height');
  assert.strictEqual(line('spec'), '');
  assert.match(w.api.agentButton(w.ctx.AGENTS[1]), /agent-build-line/);
  assert.doesNotMatch(w.api.agentButton(w.ctx.AGENTS[0]), /agent-build-line/);
  const m = world({ member: true });
  m.ctx.AGENTS = [MAIN('solo')];
  assert.strictEqual(m.api.buildLineHtml(m.ctx.AGENTS[0]), '', 'members never see it');
});
test('Teams tab: the Build team link on the second line of a "No team yet" main for admins only; a ⋯ on every row', () => {
  const w = world();
  w.ctx.AGENTS = [MAIN('boss'), MAIN('solo'), A('sam', { reportsTo: 'boss' })];
  w.api.renderTeams();
  const h = w.list.innerHTML;
  // changed (Teams redesign): the section header says "No team yet", so the second line is just the link (no words before it)
  assert.match(h, /<span class="teams-sub teams-sub-build"><span role="button"[^>]*class="build-team-link" data-build-team="solo"[^>]*>Build team<\/span><\/span>/);
  assert.strictEqual((h.match(/data-build-team="/g) || []).length, 1, 'only the main agent without a team');
  assert.doesNotMatch(h, /build-team-btn|tbs-prefix/, 'no separate button, no words before the link');
  assert.ok((h.match(/class="agent-menu-btn"/g) || []).length >= 2, 'the ⋯ is on the Teams rows');
  const m = world({ member: true });
  m.ctx.AGENTS = [MAIN('solo')];
  m.api.renderTeams();
  assert.doesNotMatch(m.list.innerHTML, /build-team-btn|build-team-link|agent-menu-btn/);
});
test('Building…: any status entry with buildingTeamFor === name disables the Build team link, the line and the menu entry', () => {
  const w = world();
  w.ctx.AGENTS = [MAIN('solo'), MAIN('lead')];
  w.ctx.agentStatus = { lead: { busy: true, buildingTeamFor: 'solo' } };
  assert.match(w.api.buildLineHtml(w.ctx.AGENTS[0]), /class="build-team-link is-building"[^>]*aria-disabled="true"[^>]*>Building…</);
  assert.strictEqual(JSON.stringify(w.api.agentMenuEntries(w.ctx.AGENTS[0]).map((x) => [x.label, !!x.disabled])), '[["Settings",false],["Building…",true]]');
  w.api.renderTeams();
  // changed (tonight): the Teams row's control is the in-row link (a span), disabled through aria-disabled; changed (Teams redesign): no words before it
  assert.match(w.list.innerHTML, /teams-sub-build"><span role="button"[^>]*class="build-team-link is-building"[^>]*aria-disabled="true"[^>]*>Building…<\/span>/);
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
  assert.match(app, /for \(const k of \['worker', 'parent', 'label', 'model', 'consultedBy', 'buildingTeamFor', 'reviewingTeamFor', 'offerPending', 'settingUpTeams'\]\)/, 'applyStatusSnapshot copies it');
  assert.match(app, /pendingQuestion: a\.pendingQuestion, buildingTeamFor: a\.buildingTeamFor \|\| null/, 'loadAgents copies it');
  assert.match(app, /next\.consultedBy = null; next\.buildingTeamFor = null; next\.reviewingTeamFor = null;/, 'idle clears it');
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

test('Teams rows show the background-work ring (any row) and the blue line (main rows), only when the agent is free', () => {
  const w = world({ stored: [['hub-teams-open', JSON.stringify({ lead: true })]] });
  w.ctx.AGENTS = sample();
  w.ctx.agentStatus = { builder: { busy: false, background: 2 }, sam: { busy: false, background: 2 }, writer: { busy: true, background: 3, busySince: 'x', activity: 'working' } };
  w.api.renderTeams();
  const h = w.list.innerHTML;
  const row = (n) => { const i = h.indexOf(`data-agent="${n}"`); return h.slice(i, h.indexOf('</div></div>', i)); };
  assert.match(row('builder'), /class="teams-dot[^"]*\bbg-work\b/, 'the ring on a leader');
  assert.doesNotMatch(row('builder'), /teams-sub|teams-bg-line/, 'a member is one line: no blue second line');
  assert.match(row('sam'), /class="teams-dot[^"]*\bbg-work\b/);
  // Short wording in the sidebar (design review: the long sentence was cut at 240 px); the full sentence stays in the tooltip.
  assert.match(row('sam'), /<span class="teams-sub teams-bg-line" title="[^"]*">Free · 2 in background<\/span>/, 'a main row keeps the blue line (clickable: opens the chat with Working on expanded)');
  assert.doesNotMatch(row('sam'), /build-team-link/, 'background work comes before Build team');
  assert.doesNotMatch(row('writer'), /bg-work|in the background/, 'replying: no ring');
  assert.match(html, /\.teams-dot\.bg-work:not\(\.live-busy\):not\(\.live-question\)/);
  assert.match(app, /\.teams-row \.teams-dot\.bg-work, \.teams-row \.teams-bg-line/, 'the ring and the blue line still open the chat with the panel');
});
// ---- Works alone: the lead recorded that a main agent with no team needs none
const aloneWorld = (aloneNames, o) => {
  const w = world(o);
  w.ctx.AGENTS = sample();
  const alone = {}; for (const n of aloneNames) alone[n] = { at: '2026-01-01T00:00:00.000Z', reason: 'short personal tasks' };
  w.set = (a) => vm.runInContext('teamSetup = { offer: null, lead: null, setups: [], alone: ' + JSON.stringify(a) + ' }', w.ctx);
  w.set(alone);
  return w;
};
test('works alone: the All Agents line "No team yet · Build team" is gone for that agent and stays for another', () => {
  const sam = A('sam', { category: 'primary' });
  const w = aloneWorld(['sam']);
  assert.strictEqual(w.api.buildLineHtml(sam), '');
  w.set({});
  assert.match(w.api.buildLineHtml(sam), /No team yet · .*Build team/);
});
test('works alone: Teams lists it under "Working alone · N", with no "Works alone" words and no Build team link; another main agent sits in "No team yet" with its link', () => {
  const w = aloneWorld(['sam']);
  w.ctx.AGENTS.push(A('solo', { category: 'primary' }));
  w.api.renderTeams();
  const h = w.list.innerHTML;
  // changed (Teams redesign): the section header says it once ("Working alone · 1"); no row repeats "Works alone", none carries a Build team prompt
  assert.match(h, /data-section="alone"><button type="button" class="teams-title teams-title-fold" data-fold="@sec:alone" aria-expanded="true"><span class="teams-glyph open" aria-hidden="true">▶<\/span>Working alone · 1<\/button>/);
  assert.doesNotMatch(h, /Works alone/);
  assert.doesNotMatch(rowOf(h, 'sam'), /No team yet|data-build-team|teams-sub/);
  assert.ok(h.indexOf('Working alone · 1') < h.indexOf('data-agent="sam"') && h.indexOf('data-agent="sam"') < h.indexOf('Shared specialists'), 'sam is inside its section');
  assert.match(h, /data-section="none"><button type="button" class="teams-title teams-title-fold" data-fold="@sec:none" aria-expanded="true"><span class="teams-glyph open" aria-hidden="true">▶<\/span>No team yet · 1</);   // solo (lead has a team)
  assert.match(rowOf(h, 'solo'), /teams-sub-build"><span[^>]*data-build-team="solo"/);
});
test('works alone: Simple Teams has the same section, and a member never sees it', () => {
  const w = aloneWorld(['sam'], { simple: true });
  w.api.renderTeams();
  assert.match(w.list.innerHTML, /Working alone · 1/);
  assert.doesNotMatch(w.list.innerHTML, /Works alone/);
  const m = aloneWorld(['sam'], { member: true });
  m.api.renderTeams();
  assert.doesNotMatch(m.list.innerHTML, /Working alone/);
  assert.match(m.list.innerHTML, /No team yet · 1/);
});
test('works alone: the row menu still offers Build team, so it can be asked again', () => {
  const w = aloneWorld(['sam']);
  const entries = w.api.agentMenuEntries(A('sam', { category: 'primary' }));
  assert.ok(entries.some((e) => e.key === 'build' && e.label === 'Build team'));
});
test('works alone: once somebody reports to the agent the entry no longer counts', () => {
  const w = aloneWorld(['sam']);
  w.ctx.AGENTS.find((a) => a.name === 'scout').reportsTo = 'sam';
  w.api.renderTeams();
  assert.doesNotMatch(w.list.innerHTML, /Working alone/);
  assert.match(w.list.innerHTML, /aria-label="1 agent, show team"/);
  assert.match(w.list.innerHTML, /Teams · 2/);
});
test('works alone: GET /api/team-setup carries it to teamSetup (source)', () => {
  assert.match(app, /alone: d\.alone && typeof d\.alone === 'object' && !Array\.isArray\(d\.alone\) \? d\.alone : \{\}/);
  assert.match(app, /if \(Object\.keys\(teamSetup\.alone\)\.sort\(\)\.join\('\\n'\) !== aloneWas\) \{ try \{ renderAgents\(\)/);
});

// ── Simple says what is shown and what exists ──
test('Simple Teams (desktop): the same pills as the sidebar (number only); a leader\'s workers are drawn, folded at start, and open with the leader\'s pill', () => {
  const w = world({ simple: true, stored: [['hub-teams-open', JSON.stringify({ atlas: true })]] });
  w.ctx.AGENTS = [A('atlas', { category: 'primary' }), A('editor', { reportsTo: 'atlas' }), A('writer', { reportsTo: 'editor' }), A('scout', { reportsTo: 'atlas' })];
  w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.match(rowOf(h, 'atlas'), /<span class="teams-pill">3&#x2009;<span aria-hidden="true">▾<\/span><\/span>/);
  assert.doesNotMatch(h, /team of|1 leader|Team leader|Reports to/, 'no role lines in Simple either');
  assert.match(h, /data-agent="scout"/, 'Simple shows the members');
  assert.doesNotMatch(h, /data-agent="writer"/, 'a leader\'s workers start folded');
  assert.match(rowOf(h, 'editor'), /aria-expanded="false" aria-label="1 worker, show workers"/);
  w.api.teamsOpenToggle('editor'); w.api.renderTeams();
  assert.match(w.list.innerHTML, /data-agent="writer"/, 'the leader\'s pill opens its workers');
  assert.strictEqual(w.store.get('hub-teams-open'), JSON.stringify({ atlas: true, editor: true }), 'same store, same key as the mains');
});
test('Build team second line is ONE line, never wrapped or split; only on a main in the "No team yet" section', () => {
  assert.doesNotMatch(html, /\.teams-sub\.teams-sub-build \{[^}]*white-space: normal/);
  assert.match(html, /\.teams-sub\.teams-sub-build \.build-team-link \{ white-space: nowrap; \}/);
  const w = world();
  w.ctx.AGENTS = [A('solo', { category: 'primary' }), A('boss', { category: 'primary' }), A('sam', { reportsTo: 'boss' })];
  w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.match(h, /<span class="teams-sub teams-sub-build"><span role="button"[^>]*data-build-team="solo"/);
  assert.doesNotMatch(rowOf(h, 'boss'), /teams-sub-build|data-build-team/);
});
// ── an old server: GET /api/team-setup has no 'alone' ──
test('old server (no alone in GET /api/team-setup): the desktop rows show the normal build line, nothing throws', () => {
  const w = aloneWorld([]);
  vm.runInContext('teamSetup = { offer: null, lead: null, setups: [] }', w.ctx);
  const sam = A('sam', { category: 'primary' });
  assert.match(w.api.buildLineHtml(sam), /No team yet · .*Build team/);
  w.api.renderTeams();
  assert.match(w.list.innerHTML, /teams-sub-build"><span[^>]*data-build-team="sam"/);
  assert.doesNotMatch(w.list.innerHTML, /Working alone/);
  assert.strictEqual(vm.runInContext("agentWorksAlone('sam')", w.ctx), false);
});
// ── design review items 3-6, 8 (desktop) ──
test('item 3 (Simple, desktop): an admin\'s main agent with no team carries the small Build team link in Simple; members and works-alone do not get the link', () => {
  const w = world({ simple: true });
  w.ctx.AGENTS = [A('solo', { category: 'primary' }), A('boss', { category: 'primary' }), A('sam', { reportsTo: 'boss' })];
  w.api.renderTeams();
  assert.match(w.list.innerHTML, /<span class="teams-sub teams-sub-build"><span role="button"[^>]*class="build-team-link"[^>]*data-build-team="solo"[^>]*onclick="buildTeamStart\('solo', event\)"/, 'the same handler and data attribute as the Teams link');
  const m = world({ simple: true, member: true });
  m.ctx.AGENTS = [A('solo', { category: 'primary' })];
  m.api.renderTeams();
  assert.match(m.list.innerHTML, /No team yet · 1</);
  assert.doesNotMatch(m.list.innerHTML, /build-team-link|data-build-team/);
  const a = aloneWorld(['sam'], { simple: true });
  a.api.renderTeams();
  const h = a.list.innerHTML;
  assert.doesNotMatch(rowOf(h, 'sam'), /data-build-team|Works alone/);
  // the menu and the All Agents line still stay out of Simple
  assert.strictEqual(w.api.buildLineHtml(w.ctx.AGENTS[0]), '');
  assert.doesNotMatch(html, /html\.mm-simple #teams-list[^{]*\.build-team-link[^{]*\{[^}]*display: none/);
});
test('item 4: the link is never split, no words before it in Teams; the container query for All Agents\' words stays', () => {
  const w = world();
  w.ctx.AGENTS = [A('solo', { category: 'primary' })];
  w.api.renderTeams();
  assert.match(w.list.innerHTML, /teams-sub-build"><span role="button"[^>]*>Build team<\/span><\/span>/);
  assert.doesNotMatch(html, /teams-sub-build \{[^}]*white-space: normal/);
  assert.match(html, /\.teams-sub\.teams-sub-build \.build-team-link \{ white-space: nowrap; \}/);
  // the 219px rule is the All Agents row's (#agent-list shares it); measured in Chrome: its whole line needs a list of 218px
  const m = html.match(/@container \(max-width: (\d+)px\) \{ \.tbs-prefix \{ display: none; \} \}/);
  assert.ok(m, 'the prefix hides in a container query');
  assert.ok(Number(m[1]) >= 217 && Number(m[1]) <= 224, 'threshold ' + m[1]);
  assert.match(html, /#teams-list \{ container-type: inline-size; \}/);
});
test('item 5: at the narrow width one rule hides the icon of every rank, nothing shows it again', () => {
  const a = html.indexOf('@container (max-width: 186px)'), blk = html.slice(a, html.indexOf('\n    }\n', a));
  assert.ok(a > 0, 'the narrow container query (list content 186px = sidebar about 211px)');
  assert.match(blk, /\.teams-row \.agent-icon, \.teams-row\.rank-leader \.agent-icon, \.teams-row\.rank-worker \.agent-icon, \.teams-row\.is-spec \.agent-icon \{ display: none !important; \}/);
  assert.ok(!/\.agent-icon \{[^}]*display: (?!none)/.test(blk));
});
test('item 6 (desktop Simple): the pill shows only the number ("5 ▸"), never "N agents" as words on the row', () => {
  const w = world({ simple: true, stored: [['hub-teams-open', JSON.stringify({ atlas: true })]] });
  w.ctx.AGENTS = [A('atlas', { category: 'primary' }), A('e1', { reportsTo: 'atlas' }), A('e2', { reportsTo: 'atlas' }), A('w1', { reportsTo: 'e1' }), A('w2', { reportsTo: 'e2' }), A('w3', { reportsTo: 'e2' })];
  w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.match(rowOf(h, 'atlas'), /<span class="teams-pill">5&#x2009;<span aria-hidden="true">▾<\/span><\/span>/);
  assert.match(rowOf(h, 'e1'), /<span class="teams-pill">1&#x2009;<span aria-hidden="true">▸<\/span><\/span>/);
  assert.match(rowOf(h, 'e2'), /<span class="teams-pill">2&#x2009;<span aria-hidden="true">▸<\/span><\/span>/);
  assert.doesNotMatch(h.replace(/<[^>]*>/g, ' '), /\d+ agents|leader/, 'the visible text has no words');
});
test('item 7 (desktop): one Undo wording, "<Agent> team recorded" / "N teams recorded", no reporting-line count', () => {
  assert.doesNotMatch(app, /team recorded \(\$\{n\} reporting line/);
  assert.match(app, /\$\{whoOf\(s\)\} team recorded<\/span>/);
});
test('item 8 (desktop Simple): the voice tip sits above the stacked slots over the composer (Undo line, Working on), not on them', () => {
  const src = fnSrc('voiceHintPlace');
  assert.match(src, /team-offer-slot[^]*handoff-cards/);
  const mk = (top, over) => Object.assign({ hidden: false, offsetHeight: 20, classList: { contains: () => false }, getBoundingClientRect: () => ({ top, left: 0, right: 0, width: 0 }) }, over);
  const run = (slots) => {
    const style = { props: {}, setProperty(k, v) { this.props[k] = v; } };
    const row = mk(800, { previousElementSibling: null });
    let prev = row;
    // slots: [class, top, hidden] listed from the one nearest the composer upward
    const els = slots.map(([cls, top, hidden]) => mk(top, { hidden: !!hidden, classList: { contains: (c) => c === cls }, previousElementSibling: null }));
    row.previousElementSibling = els[0] || null; els.forEach((e, i) => { e.previousElementSibling = els[i + 1] || null; });
    const mic = { getBoundingClientRect: () => ({ top: 800, left: 900, right: 940, width: 40 }), closest: () => row };
    const el = { style, offsetWidth: 200 };
    style.setProperty = (k, v) => { style.props[k] = v; };
    new Function('voiceHint', 'voiceHintTarget', 'document', 'window', src + '\nvoiceHintPlace();')({ el }, () => mic, { documentElement: { clientWidth: 1543 } }, { innerHeight: 900 });
    return style.bottom;
  };
  assert.strictEqual(run([]), '110px', 'nothing above the composer: 10px over it as before');
  assert.strictEqual(run([['handoff-cards', 770], ['team-offer-slot', 740]]), '170px', 'above the Undo line (top 740: 900 - 740 + 10)');
  assert.strictEqual(run([['handoff-cards', 770, true], ['team-offer-slot', 740, true]]), '110px', 'hidden slots do not count');
});
test('item 8 (Simple): a no-team main shows just the whole "Build team" link on its second line, never cut', () => {
  assert.doesNotMatch(app, /tbs-prefix">No team yet · <\/span>' \+ buildBtn/, 'no words before the link in Teams any more');
  assert.match(html, /\.teams-sub\.teams-sub-build \.build-team-link \{ white-space: nowrap; \}/);
  assert.match(html, /\.teams-sub\.teams-sub-build \{ overflow: visible; text-overflow: clip; \}/);
});
test('item 8 (Simple): a group box with no agent in it and an empty setup line are not drawn', () => {
  assert.match(html, /html\.mm-simple #agent-list \.agent-group:not\(:has\(\.agent-btn\)\), html\.mm-simple #teams-list \.teams-setup-line:empty, html\.mm-simple #teams-list:empty \{ display: none; \}/);
});

// ── Page fixes after the design review (works-alone branch) ──
const AGS = () => [A('boss', { category: 'primary' }), A('lead', { reportsTo: 'boss' }), A('w1', { reportsTo: 'lead' }), A('w2', { reportsTo: 'lead' }), A('other', { category: 'primary' }), A('o1', { reportsTo: 'other' }), A('o2', { reportsTo: 'o1' })];
test('item 1 (desktop Simple): a leader has its own pill (both modes); its workers are drawn only while it is open, from hub-teams-open', () => {
  const w = world({ stored: [['hub-teams-open', JSON.stringify({ boss: true })]] });
  w.ctx.AGENTS = AGS(); w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.match(h, /<button type="button" class="teams-pill-btn" data-fold="lead" aria-expanded="false" aria-label="2 workers, show workers" title="Show Lead's workers">/);
  assert.doesNotMatch(h, /teams-fold|leader-open/, 'the old arrow column and open marker are gone');
  assert.doesNotMatch(h, /data-agent="w1"|data-agent="w2"/, 'folded: the workers are not drawn');
  assert.ok(!/data-fold="w1"|data-fold="o1"/.test(h), 'a worker has no pill; nor does a direct worker');
  // the click: the same handler, the same key store as the mains
  w.api.teamsOpenToggle('lead'); w.api.renderTeams();
  const h2 = w.list.innerHTML;
  assert.match(h2, /class="teams-pill-btn open" data-fold="lead" aria-expanded="true" aria-label="2 workers, hide workers"/);
  assert.strictEqual(w.store.get('hub-teams-open'), JSON.stringify({ boss: true, lead: true }));
  assert.ok(h2.indexOf('data-agent="lead"') < h2.indexOf('data-agent="w1"') && h2.indexOf('data-agent="w2"') < h2.indexOf('</div></div>', h2.indexOf('data-agent="w2"')), 'the workers stay inside the leader\'s block, in .teams-kids');
});
test('item 1 (desktop Simple): nothing in the CSS hides workers any more; helper lines stay hidden in Simple', () => {
  assert.doesNotMatch(html, /leader-open|teams-fold-leader/);
  assert.doesNotMatch(html, /html\.mm-simple #teams-list \.teams-row\.deep/);
  assert.match(html, /html\.mm-simple #teams-list \.teams-helpers \{ display: none !important; \}/);
});
test('item 2 (desktop All Agents): "No team yet · Build team" REPLACES the model line on that row (one height for every row); other rows keep the model line', () => {
  const w = world();
  w.ctx.AGENTS = [A('solo', { category: 'primary' }), A('boss', { category: 'primary' }), A('sam', { reportsTo: 'boss' })];
  const solo = w.api.agentButton(w.ctx.AGENTS[0]), boss = w.api.agentButton(w.ctx.AGENTS[1]);
  assert.doesNotMatch(solo, /class="model"/, 'no model line: the link took its place');
  assert.match(solo, /<span class="agent-build-line"><span class="tbs-prefix">No team yet · <\/span><span role="button"[^>]*data-build-team="solo"/);
  assert.match(solo, /<\/span><\/span>\s*<\/span>\s*<span role="button"[^>]*class="agent-menu-btn"/, 'two lines in the info block: the name, then the link');
  assert.match(boss, /class="model"/);
  assert.doesNotMatch(boss, /agent-build-line/);
  vm.runInContext("teamSetup = { offer: null, lead: null, setups: [], alone: { solo: { at: 'x' } } }", w.ctx);
  assert.match(w.api.agentButton(w.ctx.AGENTS[0]), /class="model"/, 'Works alone keeps the model line and shows no link');
  assert.doesNotMatch(w.api.agentButton(w.ctx.AGENTS[0]), /agent-build-line/);
  // CSS: the same line height for both lines, the link whole, the words before it hidden below the width where the line does not fit
  const lh = (sel) => new RegExp('(?:^|\\n)\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{[^}]*?line-height: ([\\d.]+)').exec(html);
  assert.strictEqual(lh('.agent-build-line')[1], lh('.agent-btn .model')[1], 'one line height: one row height');
  assert.match(html, /\.agent-btn \.agent-build-line \.build-team-link \{ white-space: nowrap; \}/);
  assert.match(html, /#agent-list \{ container-type: inline-size; \}/);
  assert.match(html, /@container \(min-width: 200px\) \{ #agent-list \.agent-build-line \.tbs-prefix \{ display: inline; \} \}/);
  assert.match(html, /html\.mm-simple \.agent-menu-btn, html\.mm-simple \.agent-build-line,/, 'Simple still shows no build line');
});
test('item 3 (desktop Simple): member names sit on ONE line with the whole remaining width and an ellipsis (no wrapping, no two-line clamp)', () => {
  const simple = html.split('\n').filter((l) => /^\s*html\.mm-simple #teams-list/.test(l)).join('\n');
  assert.doesNotMatch(simple, /line-clamp|overflow-wrap: anywhere|white-space: normal/);
  assert.match(html, /\.teams-row \.name-text \{ flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
  assert.match(html, /\.teams-pill-btn \{[^}]*flex: none;/, 'the pill never shrinks');
});
test('pill gap: the name truncates first so the pill keeps >= 10 px before the row menu button, and its tap area is centred and never reaches the menu button', () => {
  // WHY: a long name ("Household Operations Coordinator") left the "2▸" pill flush against the ⋯ button, and the pill's invisible 36 x 36 tap
  // area (::before) overlapped the ⋯, so a tap just right of the pill's centre hit the menu instead of the fold. The gap rule lives on .teams-info
  // (which holds the name and so is what shrinks), once for every rank, narrow container and Simple alike (no Simple override resets it).
  assert.match(html, /html \{ --tms-pill-gap: 10px; \}/);
  const gap = /\.teams-info:has\(\.teams-pill-btn\) \{ padding-right: var\(--tms-pill-gap\); \}/;
  assert.match(html, gap, 'a row with a pill keeps the gap right of the pill, so the name gives way first');
  // changed (design review): 10 px is the default; a leader's row (its name needs the room) 6 px; the 160 px container 4 px - nothing else goes below 10
  assert.doesNotMatch(html.replace(/(\.teams-row\.rank-leader \{ height: 34px;[^}]*)--tms-pill-gap: 5px;/, '$1').replace(/\.teams-row, \.teams-row\.rank-leader \{ --tms-pill-gap: 4px; \}/, ''), /--tms-pill-gap: (?:[0-9]|[0-9]\.\d+)px/, 'no other rule goes below 10 px');
  assert.doesNotMatch(html, /\.teams-info[^{]*\{[^}]*padding(?:-right)?: 0/, 'no rule takes the gap away');
  // the tap area: >= 36 x 36, centred on the pill (not offset to the right), the pill itself never shrinks
  assert.match(html, /\.teams-pill-btn::before \{[^}]*left: 50%;[^}]*top: 50%;[^}]*width: max\(calc\(100% \+ 6px\), var\(--tms-fold\)\);[^}]*height: var\(--tms-fold\);[^}]*transform: translate\(-50%, -50%\);/);
  assert.match(html, /html \{ --tms-fold: 36px; \}/);
  assert.match(html, /\.teams-pill-btn \{[^}]*flex: none;/);
  assert.match(html, /\.teams-pill-btn \{[^}]*z-index: 1;/, 'the tap area paints above a neighbouring row, so a tap 17 px above or below the pill still folds');
  assert.match(html, /\.teams-pill \{[^}]*white-space: nowrap;/);
});

// ---- design review fixes (desktop): narrow sidebar room, leader name room, thin space, folding section headers
const containerBlock = () => { const i = html.indexOf('@container (max-width: 186px)'); return html.slice(i, html.indexOf('@container (max-width: 219px)', i)); };
test('160 px sidebar: gap name -> pill 4 px, pill -> ⋯ 4 px, the tap box keeps 36 px tall and grows towards the name only, never over the ⋯', () => {
  const c = containerBlock();
  assert.match(c, /\.teams-row, \.teams-row\.rank-leader \{ --tms-pill-gap: 4px; \}/, 'the gap is 4 px in the narrow container (leader rows too)');
  assert.match(c, /\.teams-pill-btn \{ margin-left: 4px; \}/, 'the name -> pill gap is 4 px');
  // anchored on the pill's right edge: right = -gap (it reaches the ⋯'s edge, no further), left grows to make the box --tms-fold wide
  assert.match(c, /\.teams-pill-btn::before \{ left: auto; right: calc\(var\(--tms-pill-gap\) \* -1\); transform: translateY\(-50%\); width: max\(calc\(100% \+ var\(--tms-pill-gap\) \+ 4px\), var\(--tms-fold\)\); \}/);
  assert.doesNotMatch(c, /--tms-pill-gap: (?:[5-9]|\d\d)px/, 'nothing in the narrow query widens the gap again');
});
test('240 px sidebar: a leader row gets 6 px (not 10) between the pill and the ⋯, name 12.5px, so "Studio Lead" is not cut', () => {
  assert.match(html, /\.teams-row\.rank-leader \{ height: 34px;[^}]*--tms-pill-gap: 5px; \}/);
  assert.match(html, /\.teams-row\.rank-leader \.name \{ height: 16px; font-size: 12\.5px;/);
  assert.match(html, /\.teams-pill-btn \{[^}]*margin: 0 0 0 6px;/, 'name -> pill stays 6 px');
});
test('pill text: a thin space before the arrow (desktop and Simple desktop)', () => {
  for (const simple of [false, true]) {
    const w = world({ simple, stored: [['hub-teams-open', JSON.stringify({ lead: true })]] });
    w.ctx.AGENTS = sample();
    w.api.renderTeams();
    assert.match(w.list.innerHTML, /<span class="teams-pill">3&#x2009;<span aria-hidden="true">▾<\/span>/, `thin space, simple=${simple}`);
    assert.doesNotMatch(w.list.innerHTML, /teams-pill">\d+ </, 'no ordinary space');
  }
});
test('section headers are fold buttons: aria-expanded, arrow, key @sec:<key> (stored = FOLDED, sections start open); Other keeps @other (stored = open)', () => {
  const w = world();
  w.ctx.AGENTS = sample();
  w.api.renderTeams();
  let h = w.list.innerHTML;
  for (const k of ['teams', 'none', 'shared']) assert.match(h, new RegExp(`<button type="button" class="teams-title teams-title-fold" data-fold="@sec:${k}" aria-expanded="true"><span class="teams-glyph open" aria-hidden="true">▶</span>`), `${k}: open at start`);
  assert.match(h, /data-agent="sam"/);
  const click = (key) => w.api.teamsClick({ stopPropagation() {}, target: { closest: (s) => (s === '[data-fold]' ? { dataset: { fold: key } } : null) } });
  click('@sec:none');
  h = w.list.innerHTML;
  assert.match(h, /data-fold="@sec:none" aria-expanded="false"><span class="teams-glyph" aria-hidden="true">/, 'folded: aria-expanded false, arrow not rotated');
  assert.doesNotMatch(h, /data-agent="sam"/, 'the folded section hides its rows');
  assert.match(h, /Teams · 1/); assert.match(h, /data-agent="lead"/, 'other sections stay');
  assert.deepStrictEqual(JSON.parse(w.store.get('hub-teams-open'))['@sec:none'], true, 'stored = FOLDED (true), like the phone');
  click('@sec:none');
  assert.match(w.list.innerHTML, /data-agent="sam"/, 'second click opens it again');
  assert.strictEqual(JSON.parse(w.store.get('hub-teams-open'))['@sec:none'], undefined, 'open again = nothing stored');
  // Other is the other way round: stored = open
  assert.match(w.list.innerHTML, /data-fold="@other" aria-expanded="false"/);
});

// ---- keyboard: Enter and Space on the row itself open the chat; the pill and the menu inside the row keep their own keys
test('Teams list keydown: Enter and Space on the row open the chat (Space does not scroll); the pill or the menu button inside does not', () => {
  const w = world();
  w.api.setupTabs();
  const kd = w.list.listeners.keydown;
  assert.ok(kd, 'the list listens for keydown');
  const row = { classList: { contains: (c) => c === 'teams-row' }, dataset: { agent: 'ann', model: 'm/ann' }, closest: (s) => (s === '.teams-row' ? row : null) };
  const ev = (key, target) => ({ key, target, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} });
  const enter = ev('Enter', row); kd(enter);
  assert.deepStrictEqual(w.started, [['ann', 'm/ann']]);
  assert.strictEqual(enter.prevented, false, 'Enter was never prevented');
  const space = ev(' ', row); kd(space);
  assert.deepStrictEqual(w.started, [['ann', 'm/ann'], ['ann', 'm/ann']]);
  assert.strictEqual(space.prevented, true, 'Space does not scroll the list');
  const pill = { classList: { contains: () => false }, dataset: { fold: 'ann' }, closest: (s) => (s === '.teams-row' ? row : null) };
  const sp = ev(' ', pill); kd(sp); kd(ev('Enter', pill));
  assert.strictEqual(w.started.length, 2, 'a key on the pill or the menu button is not the row');
  assert.strictEqual(sp.prevented, false);
  kd(ev('a', row)); assert.strictEqual(w.started.length, 2);
});
