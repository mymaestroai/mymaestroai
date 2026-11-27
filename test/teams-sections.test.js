// Teams list sections, pills and rows (redesign): headers with counts from hubTeams.sections(), the pill as the fold control, one-line members, ranks, Simple, Build team placement.
// Same fake page as teams-desktop.test.js: functions pulled out of app.js and run in a vm. Reads no hub data.
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
    "const TEAMS_OPEN_KEY = 'hub-teams-open'; let teamsLastHtml = null; let teamsTimer = 0; let teamsOpenMem = null; const TEAMS_SOLO_KEYS = ['@sec:solo', '@sec:none', '@sec:alone'];",
    fnSrc('capName'), fnSrc('sidebarViewStored'), fnSrc('sidebarViewOk'), fnSrc('sidebarViewSet'), fnSrc('sidebarTabsApply'),
    'async ' + fnSrc('sidebarTabsLoad'), fnSrc('setupTabs'), fnSrc('teamsOpenGet'), fnSrc('teamsSecFolded'), fnSrc('teamsOpenToggle'), fnSrc('teamsClick'),
    fnSrc('agentStateWords'), fnSrc('agentLiveState'), fnSrc('bgCountOf'), "const buildTeamPending = new Set();",
    "const optimizeTeamPending = new Set();",
    fnSrc('teamBuilding'), fnSrc('agentCanBuildTeam'), fnSrc('teamReviewing'), fnSrc('agentCanOptimizeTeam'), fnSrc('agentRowNameAttrs'),
    'async ' + fnSrc('optimizeTeamStart'), fnSrc('buildTeamCtlHtml'), fnSrc('buildLineHtml'),
    fnSrc('paintBuildControls'), 'async ' + fnSrc('buildTeamStart'), fnSrc('agentButton'),
    fnSrc('questionChecklistOf'), fnSrc('questionChecklistHtml'), fnSrc('questionCheckedIds'), fnSrc('askResponseBody'),
    fnSrc('teamsPillText'), fnSrc('teamsPillLabel'), fnSrc('teamsPillHtml'), fnSrc('teamsRowHtml'), fnSrc('teamsBlockHtml'), fnSrc('teamsSubtreeHtml'), fnSrc('renderTeams'), fnSrc('teamsRepaintSoon'),
    // Set up teams (renderTeams, setupTabs and teamsClick call these): the harness carries them so the pinned Teams tests keep running as before.
    "let teamSetup = { offer: null, lead: null, setups: [], alone: {} }; let teamSetupStarting = false; const teamSetupRecent = new Set(); let teamSetupLoadTimer = 0; const chats = {};",
    fnSrc('agentWorksAlone'), fnSrc('teamSetupLeadDisplay'), fnSrc('teamSetupBusy'), fnSrc('teamSetupLines'), fnSrc('teamSetupDate'), fnSrc('teamSetupLineHtml'), fnSrc('teamSetupApply'),
    'async ' + fnSrc('teamSetupLoad'), fnSrc('teamSetupLoadSoon'), fnSrc('teamSetupPaint'), fnSrc('teamSetupOfferHtml'), fnSrc('teamSetupUndoRows'), fnSrc('teamSetupChatPaint'),
    'async ' + fnSrc('teamSetupStart'), 'async ' + fnSrc('teamSetupUndo'), 'function setAgentLive() {} function loadAgents() { return Promise.resolve(); }',
    'this.api = { setupTabs, sidebarViewSet, sidebarTabsApply, renderTeams, teamsClick, teamsRepaintSoon, teamsOpenToggle, agentRowNameAttrs, buildLineHtml, agentButton, buildTeamStart, optimizeTeamStart, paintBuildControls, questionChecklistOf, questionChecklistHtml, askResponseBody };'].join('\n');
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { ctx, api: ctx.api, store, tabs, panels, switchBtns, list, started, opened, document };
}
const A = (name, over) => Object.assign({ name, display: name[0].toUpperCase() + name.slice(1), model: 'm/' + name, icon: '🤖', category: 'specialist' }, over);
const active = (w) => w.tabs.filter((t) => t.classList.contains('active')).map((t) => t.dataset.tab);

const MAIN = (n, over) => A(n, Object.assign({ category: 'primary' }, over));
const rowOf = (h, n) => { const i = h.indexOf(`data-agent="${n}"`); return i < 0 ? '' : h.slice(i, h.indexOf('</div></div>', i)); };
const titles = (h) => [...h.matchAll(/class="teams-title[^"]*"[^>]*><span>([^<]*)<\/span>/g)].map((m) => m[1]);   // changed (the owner 2026-11-24 07:48): the label is its own span at the left, the arrow at the right
// teams, solo agents (no team yet, or recorded as working alone), shared specialists and one other, in the made-up install's spirit
function company() {
  return [
    MAIN('owner', { lead: true, icon: '🎼' }),
    MAIN('harbor'), A('tide', { reportsTo: 'harbor' }), A('cargo', { reportsTo: 'harbor' }),
    MAIN('studio'), A('foreman', { reportsTo: 'studio' }), A('draft', { reportsTo: 'foreman' }), A('layout', { reportsTo: 'foreman' }), A('archive', { reportsTo: 'studio' }),
    MAIN('sam'), MAIN('cedar'), MAIN('maple'),
    A('scout'), A('proof'), A('lab', { category: 'experimental' }),
  ];
}
const alone = (w, names) => vm.runInContext('teamSetup = { offer: null, lead: null, setups: [], alone: ' + JSON.stringify(Object.fromEntries(names.map((n) => [n, { at: 'x' }]))) + ' }', w.ctx);

// ---- hubTeams.sections (the shared module; the desktop and the phone list both draw from it)
// Owner 2026-11-24 07:32: "Create a classification of solo agents" / "Instead of 'no team'": ONE section 'Solo agents' (key 'solo') holds every main agent with no team, decided (works alone) or not; 'No team yet' and 'Working alone' are gone.
test('hubTeams.sections: Teams, Solo agents, Shared specialists, Other, in that order, empty ones left out, counts = rows', () => {
  const t = hubTeams.tree(company(), {});
  const s = hubTeams.sections(t, (n) => n === 'cedar');
  assert.deepStrictEqual(s.map((x) => [x.key, x.title, x.count]), [['teams', 'Teams', 2], ['solo', 'Solo agents', 4], ['shared', 'Shared specialists', 2], ['other', 'Other', 1]]);
  assert.strictEqual(s[1].rows[0].agent.name, 'owner', 'the lead stays first inside its section');
  assert.deepStrictEqual(s[1].rows.map((r) => r.agent.name), ['owner', 'cedar', 'maple', 'sam'], 'works-alone and undecided together, in tree order (the lead first, then by shown name)');
  assert.strictEqual(hubTeams.sections(t).find((x) => x.key === 'solo').count, 4, 'with no isAlone every main without a team is there');
  const none = hubTeams.sections(hubTeams.tree([MAIN('a'), MAIN('b')], {}), () => false);
  assert.deepStrictEqual(none.map((x) => x.key), ['solo'], 'empty sections are not returned');
  assert.deepStrictEqual(hubTeams.sections(hubTeams.tree([], {})), []);
});

// ---- headers with counts
test('renderTeams: four headers with counts, each once, in order; no "Your agents"', () => {
  const w = world();
  w.ctx.AGENTS = company();
  alone(w, ['cedar']);
  w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.deepStrictEqual(titles(h), ['Teams · 2', 'Solo agents · 4', 'Shared specialists · 2', 'Other · 1']);
  assert.doesNotMatch(h, /Your agents|No team yet|Working alone/);
  assert.match(h, /<div class="teams-section" data-section="solo"><button type="button" class="teams-title teams-title-fold" data-fold="@sec:solo" aria-expanded="true"><span>Solo agents · 4<\/span><span class="teams-glyph" aria-hidden="true">&#x25BE;<\/span><\/button>/);
  for (const [n, key] of [['harbor', 'teams'], ['sam', 'solo'], ['cedar', 'solo'], ['scout', 'shared']]) {
    const sec = h.indexOf(`data-section="${key}"`), end = h.indexOf('<div class="teams-section"', sec + 10);
    const at = h.indexOf(`data-agent="${n}"`);
    assert.ok(at > sec && (end < 0 || at < end), `${n} sits under its own header`);
  }
});
test('renderTeams: an empty section has no header (no specialists, no Other)', () => {
  const w = world();
  w.ctx.AGENTS = [MAIN('harbor'), A('tide', { reportsTo: 'harbor' }), MAIN('sam')];
  w.api.renderTeams();
  assert.deepStrictEqual(titles(w.list.innerHTML), ['Teams · 1', 'Solo agents · 1']);
  assert.doesNotMatch(w.list.innerHTML, /No team yet|Working alone|Shared specialists|Other/);
});
test('renderTeams: the lead is first in its own section, with its crown', () => {
  const w = world();
  w.ctx.AGENTS = company();
  w.api.renderTeams();
  const h = w.list.innerHTML;
  const none = h.slice(h.indexOf('data-section="solo"'));
  assert.ok(none.indexOf('data-agent="owner"') < none.indexOf('data-agent="cedar"') && none.indexOf('data-agent="owner"') < none.indexOf('data-agent="maple"'));
  assert.match(rowOf(h, 'owner'), /<span class="lead-badge" title="Lead agent">👑<\/span>/);
  assert.doesNotMatch(html, /lead-badge \{ display: none/, 'the crown shows in Simple too (the mock-up has it)');
});
test('renderTeams: Other keeps its fold on the header ("Other · N", stored = open); the other four headers are fold buttons too (@sec:<key>, stored = folded)', () => {
  const w = world();
  w.ctx.AGENTS = company();
  w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.match(h, /<button type="button" class="teams-title teams-title-fold" data-fold="@other" aria-expanded="false"><span>Other · 1<\/span><span class="teams-glyph" aria-hidden="true">&#x25B8;<\/span><\/button>/);
  assert.doesNotMatch(h, /data-agent="lab"/);
  assert.strictEqual((h.match(/class="teams-title"/g) || []).length, 0, 'no header is plain text any more (changed: design review, they fold like the phone\'s)');
  assert.deepStrictEqual([...h.matchAll(/data-fold="(@sec:[a-z]+)" aria-expanded="true"/g)].map((m) => m[1]), ['@sec:teams', '@sec:solo', '@sec:shared'], 'the sections start open (changed 2026-11-24 07:32, "Solo agents" replaces No team yet and Working alone)');
  w.api.teamsClick({ stopPropagation() {}, target: { closest: (s) => (s === '[data-fold]' ? { dataset: { fold: '@other' } } : null) } });
  assert.match(w.list.innerHTML, /data-agent="lab"/);
});

// ---- the pill
test('pill: a button after the boss\'s name (and crown) with aria-expanded and an "N agents, show team" label; no arrow column', () => {
  const w = world();
  w.ctx.AGENTS = company();
  w.api.renderTeams();
  const h = w.list.innerHTML;
  const r = rowOf(h, 'harbor');
  assert.match(r, /<span class="name-text"[^>]*>Harbor<\/span><button type="button" class="teams-pill-btn" data-fold="harbor" aria-expanded="false" aria-label="Unfold [^"]*: 2 agents"[^>]*><span class="teams-pill">2 agents &#x25B8;<\/span><\/button><\/span>/);
  assert.strictEqual((h.match(/class="teams-pill-btn/g) || []).length, 2, 'one pill per team (folded: no leader rows drawn)');
  assert.doesNotMatch(h, /teams-fold/);
  const l = world();
  l.ctx.AGENTS = [MAIN('owner', { lead: true }), A('tide', { reportsTo: 'owner' })];
  l.api.renderTeams();
  assert.match(rowOf(l.list.innerHTML, 'owner'), /<span class="name-text"[^>]*>Owner<\/span><span class="lead-badge"[^>]*>👑<\/span><button type="button" class="teams-pill-btn"/);
});
test('pill: the native button click folds, keeps the fold memory and does NOT open the chat; the rest of the row opens it; Enter on the pill is not a row activation', () => {
  const w = world();
  w.ctx.AGENTS = company();
  w.api.renderTeams();
  const pill = { dataset: { fold: 'harbor' }, tagName: 'BUTTON' };
  const row = { dataset: { agent: 'harbor', model: 'm/harbor' } };
  let stopped = 0;
  w.api.teamsClick({ stopPropagation: () => { stopped++; }, target: { closest: (s) => (s === '[data-fold]' ? pill : s === '.teams-row' ? row : null) } });   // a click on the pill inside the row
  assert.strictEqual(stopped, 1, 'stopPropagation');
  assert.deepStrictEqual(w.started, [], 'the chat did not open');
  assert.deepStrictEqual(JSON.parse(w.store.get('hub-teams-open')), { harbor: true });
  const h = w.list.innerHTML;
  assert.match(h, /data-fold="harbor" aria-expanded="true" aria-label="Fold [^"]*: 2 agents"/);
  assert.match(h, /data-agent="tide"/, 'the team shows');
  w.api.teamsClick({ stopPropagation() {}, target: { closest: (s) => (s === '.teams-row' ? row : null) } });   // elsewhere on the row
  assert.deepStrictEqual(w.started, [['harbor', 'm/harbor']]);
  w.api.setupTabs();
  w.list.listeners.keydown({ key: 'Enter', target: { classList: { contains: (c) => c === 'teams-pill-btn' }, closest: (s) => (s === '[data-fold]' ? pill : null) } });
  assert.strictEqual(w.started.length, 1, 'Enter on the pill is the button\'s own click, not a row activation');
  w.list.listeners.keydown({ key: 'Enter', target: { classList: { contains: (c) => c === 'teams-row' }, closest: (s) => (s === '.teams-row' ? row : null) } });
  assert.strictEqual(w.started.length, 2, 'Enter on the row opens the chat');
});
test('pill: the tap area is >= 36 x 36 (CSS), the pill looks small, never shrinks, the name truncates first, focus is visible', () => {
  assert.match(html, /html \{ --tms-fold: 36px; \}/);
  assert.match(html, /\.teams-pill-btn::before \{[^}]*width: max\(calc\(100% \+ 6px\), var\(--tms-fold\)\); height: var\(--tms-fold\)/);
  assert.match(html, /\.teams-pill-btn \{[^}]*flex: none;/);
  assert.match(html, /\.teams-pill \{[^}]*height: 18px;[^}]*white-space: nowrap;/);
  assert.match(html, /\.teams-row \.name-text \{ flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
  assert.match(html, /\.teams-title:focus-visible, \.teams-pill-btn:focus-visible \{ outline: 2px solid var\(--accent\)/);
});
test('pill: a leader folds its workers with its own pill; workers start open and follow @fold:<leader> in hub-teams-open', () => {
  const w = world({ stored: [['hub-teams-open', JSON.stringify({ studio: true })]] });
  w.ctx.AGENTS = company();
  w.api.renderTeams();
  let h = w.list.innerHTML;
  // changed (the owner's request 2026-11-24 07:30: opening a team shows the whole team): leaders start open, the pill folds under '@fold:<name>'
  assert.match(rowOf(h, 'foreman'), /aria-expanded="true" aria-label="Fold [^"]*: 2 agents"/);
  assert.match(h, /data-agent="draft"/);
  w.api.teamsClick({ stopPropagation() {}, target: { closest: (s) => (s === '[data-fold]' ? { dataset: { fold: '@fold:foreman' } } : null) } });
  h = w.list.innerHTML;
  assert.doesNotMatch(h, /data-agent="draft"/);
  assert.deepStrictEqual(JSON.parse(w.store.get('hub-teams-open')), { studio: true, '@fold:foreman': true });
});

// ---- one-line members
test('members (leaders and workers) are one line: no "Reports to", no second line; a replying member shows what it does after its name', () => {
  const w = world({ stored: [['hub-teams-open', JSON.stringify({ studio: true, foreman: true, harbor: true })]] });
  w.ctx.AGENTS = company();
  w.ctx.agentStatus = { draft: { busy: true, busySince: 'x', activity: 'working' }, tide: { busy: false, background: 2 } };
  w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.doesNotMatch(h, /Reports to/);
  for (const n of ['foreman', 'draft', 'layout', 'archive', 'tide', 'cargo']) assert.doesNotMatch(rowOf(h, n), /teams-sub|Team leader|Worker</, n);
  assert.match(rowOf(h, 'draft'), /<span class="name-text"[^>]*>Draft<\/span><span class="teams-live" title="working · 3m">· working · 3m<\/span>/);
  assert.match(html, /\.teams-live \{[^}]*color: var\(--warning\)/, 'orange');
  assert.match(rowOf(h, 'tide'), /teams-dot live-idle bg-work/, 'a member keeps the ring');
});
test('rank classes: main / leader / worker in the sidebar and in Simple, with the three sizes', () => {
  for (const simple of [false, true]) {
    const w = world({ simple, stored: [['hub-teams-open', JSON.stringify({ studio: true, foreman: true })]] });
    w.ctx.AGENTS = company();
    w.api.renderTeams();
    const h = w.list.innerHTML;
    assert.match(h, /<div class="teams-row rank-main[^"]*"[^>]*data-agent="studio"/, 'simple=' + simple);
    assert.match(h, /<div class="teams-row rank-leader"[^>]*data-agent="foreman"/);
    assert.match(h, /<div class="teams-row rank-worker"[^>]*data-agent="archive"/);
    assert.match(h, /<div class="teams-row rank-worker deep"[^>]*data-agent="draft"/);
  }
  const hgt = (re) => parseFloat(re.exec(html)[1]);
  assert.deepStrictEqual([hgt(/\n    \.teams-row \{[^}]*?height: (\d+)px/), hgt(/\.teams-row\.rank-leader \{ height: (\d+)px/), hgt(/\.teams-row\.rank-worker \{ height: (\d+)px/)], [46, 34, 26]);
  assert.deepStrictEqual([hgt(/html\.mm-simple #teams-list \.teams-row \{ height: (\d+)px/), hgt(/html\.mm-simple #teams-list \.teams-row\.rank-leader \{ height: (\d+)px/), hgt(/html\.mm-simple #teams-list \.teams-row\.rank-worker \{ height: (\d+)px/)], [48, 40, 30]);
});
test('main rows keep one height with or without a second line (fixed height, name centred in the column)', () => {
  assert.match(html, /\n    \.teams-row \{[^}]*height: 46px/);
  assert.match(html, /\.teams-info \{[^}]*flex-direction: column; justify-content: center;/);
  const w = world();
  w.ctx.AGENTS = company();
  w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.doesNotMatch(rowOf(h, 'harbor'), /teams-sub/, 'a team main with nothing to say has no second line');
  assert.match(h.slice(h.indexOf('data-agent="sam"') - 120, h.indexOf('data-agent="sam"')), /teams-row rank-main has-l2/, 'a row with a second line is marked, with the same fixed height');
  assert.match(rowOf(h, 'sam'), /teams-sub-build/);
});

// ---- Simple
test('Simple: shows a leader\'s workers (no "Simple: no workers" rule), open at start, folded by the leader\'s pill', () => {
  assert.doesNotMatch(html, /Simple: no workers/);
  const w = world({ simple: true, stored: [['hub-teams-open', JSON.stringify({ studio: true })]] });
  w.ctx.AGENTS = company();
  w.api.renderTeams();
  let h = w.list.innerHTML;
  assert.match(h, /data-agent="foreman"/);
  assert.match(h, /data-agent="archive"/);
  // changed (the owner's request 2026-11-24 07:30: opening a team shows the whole team): open at start, folded by hand
  assert.match(h, /data-agent="draft"/, 'open at start');
  assert.match(rowOf(h, 'foreman'), /class="teams-pill-btn open"[^>]*aria-expanded="true" aria-label="Fold [^"]*: 2 agents"/);
  w.api.teamsClick({ stopPropagation() {}, target: { closest: (s) => (s === '[data-fold]' ? { dataset: { fold: '@fold:foreman' } } : null) } });
  h = w.list.innerHTML;
  assert.doesNotMatch(h, /data-agent="draft"|data-agent="layout"/);
  assert.match(html, /html\.mm-simple #teams-list \.teams-helpers \{ display: none !important; \}/);
});
test('Simple: every fold control keeps the 36 px tap area (--tms-fold is no longer 16 px) and member names are one line with an ellipsis', () => {
  assert.match(html, /html \{ --tms-fold: 36px; \}/);
  assert.doesNotMatch(html, /--tms-fold: 16px/);
  const simple = html.split('\n').filter((l) => /^\s*html\.mm-simple #teams-list/.test(l)).join('\n');
  assert.doesNotMatch(simple, /teams-pill-btn[^{]*\{[^}]*(?:width|height|min-width): (?:1\d|2\d|3[0-5])px/, 'Simple never shrinks the tap area');
  assert.doesNotMatch(simple, /line-clamp|white-space: normal|overflow-wrap/);
});

// ---- Build team and Working alone
test('Build team: the link is on the second line of an undecided main in "Solo agents" for admins; not for a works-alone one, not in Teams, Shared or Other', () => {
  const w = world();
  w.ctx.AGENTS = company();
  alone(w, ['cedar']);
  w.api.renderTeams();
  const h = w.list.innerHTML;
  const links = [...h.matchAll(/data-build-team="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(links.sort(), ['maple', 'owner', 'sam']);
  assert.strictEqual((h.match(/Build team</g) || []).length, 3);
  assert.doesNotMatch(rowOf(h, 'cedar'), /build-team|teams-sub/, 'a works-alone solo agent: no second line, no Build team prompt and no "Works alone" words');
  assert.doesNotMatch(h, /Works alone|Working alone|No team yet/);
  assert.doesNotMatch(rowOf(h, 'cedar'), /agent-menu-btn|⋯/, 'no ⋯ on the row any more (P4-2); Build team is the card\'s row');
  assert.match(rowOf(h, 'cedar'), /data-card-agent="cedar"/, 'the name opens the card');
  const m = world({ member: true });
  m.ctx.AGENTS = company();
  m.api.renderTeams();
  assert.doesNotMatch(m.list.innerHTML, /build-team|agent-menu-btn/, 'members never see Build team');
  assert.match(m.list.innerHTML, /Solo agents · 4</, 'and for a member nothing is recorded as working alone');
});
test('second line priority on a main: replying (orange), else the blue background line (clickable), else Build team, else nothing', () => {
  const w = world();
  w.ctx.AGENTS = [MAIN('sam'), MAIN('maple'), MAIN('cedar'), MAIN('pine')];
  w.ctx.agentStatus = { sam: { busy: true, busySince: 'x', activity: 'working', background: 2 }, maple: { busy: false, background: 2 } };
  alone(w, ['pine']);
  w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.match(rowOf(h, 'sam'), /<span class="teams-sub busy">working · 3m<\/span>/);
  assert.doesNotMatch(rowOf(h, 'sam'), /bg-work|teams-bg-line|build-team/);
  assert.match(rowOf(h, 'maple'), /teams-bg-line/);
  assert.doesNotMatch(rowOf(h, 'maple'), /build-team/);
  assert.match(rowOf(h, 'cedar'), /teams-sub-build/);
  assert.doesNotMatch(rowOf(h, 'pine'), /teams-sub/, 'nothing to say: no second line, the name is centred');
});
test('status dot stays at the left of the row with its three meanings', () => {
  const w = world();
  w.ctx.AGENTS = [MAIN('sam'), MAIN('maple'), MAIN('cedar'), MAIN('pine')];
  w.ctx.agentStatus = { sam: { busy: true, busySince: 'x' }, maple: { busy: false, background: 1 }, cedar: { pendingQuestion: true } };
  w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.match(rowOf(h, 'sam'), /^[^>]*>\s*<span class="teams-dot live-busy"/);
  assert.match(rowOf(h, 'maple'), /^[^>]*>\s*<span class="teams-dot live-idle bg-work"/);
  assert.match(rowOf(h, 'cedar'), /^[^>]*>\s*<span class="teams-dot live-question"/);
  assert.match(rowOf(h, 'pine'), /^[^>]*>\s*<span class="teams-dot live-idle"/);
});
test('the empty state and the Undo line still show with the sections; Simple hides an empty setup line', () => {
  const w = world();
  w.ctx.AGENTS = [MAIN('sam'), MAIN('maple')];
  vm.runInContext('teamSetup = { offer: null, lead: null, setups: [{ id: "a", at: "2026-01-02T00:00:00.000Z", main: "sam", count: 2 }], alone: {} }', w.ctx);
  w.api.renderTeams();
  const h = w.list.innerHTML;
  assert.match(h, /<strong>Agents can work as teams\.<\/strong>/);
  assert.match(h, /Solo agents · 2/);
  assert.match(h, /Team setup: 1 team recorded[^<]*· <button type="button" class="teams-setup-undo" data-team-undo>Undo<\/button>/);
  assert.ok(h.indexOf('Solo agents · 2') > h.indexOf('Agents can work as teams') && h.indexOf('Team setup:') > h.indexOf('data-agent="maple"'), 'box first, sections, Undo line last');
  assert.match(html, /html\.mm-simple #teams-list \.teams-setup-line:empty/);
});
test('the All Agents tab is untouched by the redesign: its list code and CSS still use #agent-list rules', () => {
  assert.match(html, /#agent-list \{ container-type: inline-size; \}/);
  assert.match(html, /@container \(min-width: 200px\) \{ #agent-list \.agent-build-line \.tbs-prefix \{ display: inline; \} \}/);
  assert.doesNotMatch(fnSrc('renderAgents'), /hubTeams\.sections/);
});
