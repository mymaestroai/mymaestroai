// Set up teams and Undo team setup on the pages (app.js, mobile.js, index.html, mobile.html): the lead's offer card,
// the Teams tab button, the Undo line and per-team Undo, the "Show the Teams tab" setting, the plan card's four options.
// Functions are pulled out of the page sources and run with injected fetch / document; no hub data is read.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const mjs = fs.readFileSync(path.join(ROOT, 'mobile.js'), 'utf8');
const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const mhtml = fs.readFileSync(path.join(ROOT, 'mobile.html'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const settingsSrc = fs.readFileSync(path.join(ROOT, 'lib', 'settings.js'), 'utf8');

function fnFrom(src, name) {
  const a = src.search(new RegExp(`function ${name}\\(`));
  assert.ok(a >= 0, `${name} exists`);
  const open = src.indexOf('{', src.indexOf(')', a));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(a, i + 1);
  }
  throw new Error('unbalanced ' + name);
}
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const settle = () => new Promise((r) => setImmediate(r));

const LEAD = { name: 'lead', display: 'Lead' };
const SETUPS = [
  { id: 's1', at: '2026-11-20T12:00:00Z', main: 'atlas', count: 3 },
  { id: 's2', at: '2026-11-19T12:00:00Z', main: 'studio', count: 2 },
];

// ───────────────────────── desktop page (app.js) ─────────────────────────
const hubEscLine = app.split('\n').find((l) => l.trim().startsWith('const hubEsc = '));
const slotEl = () => ({ dataset: {}, innerHTML: '', hidden: true });

function desk(over = {}) {
  const calls = [];
  const slots = { c1: slotEl(), c2: slotEl() };
  const routes = over.routes || {};
  const ctx = {
    console, timers: [], started: [], alerts: [], confirms: [], statusSets: [], repaints: 0, agentLoads: 0,
    store: {}, localStorage: { getItem: (k) => (k in ctx.store ? ctx.store[k] : null), setItem: (k, v) => { ctx.store[k] = String(v); } },
    setTimeout: (f) => { ctx.timers.push(f); return ctx.timers.length; },
    document: { getElementById: (id) => { const m = /^team-offer-slot-(.+)$/.exec(id); return m ? slots[m[1]] || null : null; } },
    isHubAdmin: () => over.member !== true,
    AGENTS: [{ name: 'atlas', display: 'Atlas' }, { name: 'lead', display: over.leadDisplay || 'Lead', lead: true }],
    agentStatus: over.status || {},
    chats: { c1: { id: 'c1', agent: 'lead' }, c2: { id: 'c2', agent: 'atlas' } },
    teamsRepaintSoon: () => { ctx.repaints++; },
    fetch: async (url, init) => {
      const method = (init && init.method) || 'GET';
      calls.push({ url, method, body: init && init.body });
      const r = routes[`${method} ${url}`];
      if (r) return typeof r === 'function' ? r(init) : r;
      return res(200, {});
    },
    confirm: (m) => { ctx.confirms.push(m); return over.confirm !== false; },
    alert: (m) => ctx.alerts.push(m),
    startSoloChat: (n) => ctx.started.push(n),
    loadAgents: async () => { ctx.agentLoads++; },
    setAgentLive: (n, p) => { ctx.statusSets.push([n, p]); if (ctx.agentStatus[n]) Object.assign(ctx.agentStatus[n], p); },
  };
  const src = [hubEscLine, fnFrom(app, 'capName'),
    "let teamSetup = { offer: null, lead: null, setups: [] }; let teamSetupStarting = false; const teamSetupRecent = new Set(); let teamSetupLoadTimer = 0; let teamSetupListOpen = false; const TEAM_UNDO_DISMISS_KEY = 'hub-team-undo-dismissed';",
    ...['teamSetupLeadDisplay', 'teamSetupBusy', 'teamSetupLines', 'teamSetupDate', 'teamSetupLineHtml', 'teamSetupApply', 'teamSetupPaint',
      'teamSetupOfferHtml', 'teamSetupUndoRows', 'teamSetupDismissedId', 'teamSetupDismiss', 'teamSetupToggleList', 'teamSetupUndoHtml', 'teamSetupChatPaint', 'teamSetupLoadSoon'].map((n) => fnFrom(app, n)),
    ...['teamSetupLoad', 'teamSetupAnswer', 'teamSetupStart', 'teamSetupUndo', 'teamSetupUndoAll'].map((n) => 'async ' + fnFrom(app, n)),
    'this.api = { teamSetupApply, teamSetupLoad, teamSetupAnswer, teamSetupStart, teamSetupUndo, teamSetupUndoAll, teamSetupDismiss, teamSetupToggleList, teamSetupLineHtml, teamSetupBusy, teamSetupRecent, get state() { return teamSetup; } };'].join('\n');
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { ctx, api: ctx.api, calls, slots };
}

test('offer card: an admin sees it in the lead\'s chat only, headed by the lead\'s own display name, with the three answers', () => {
  const w = desk();
  w.api.teamSetupApply({ offer: 'pending', lead: LEAD, setups: [] });
  const h = w.slots.c1.innerHTML;
  assert.match(h, /<h3>Lead has a suggestion<\/h3>/);
  assert.ok(h.includes('Lead can look at how your agents already work together and suggest teams for the Teams tab. Nothing changes in how your agents work unless you approve a team.'));
  for (const [choice, label] of [['show', 'Show me the proposal'], ['not_now', 'Not now'], ['never', "Don't ask again"]]) {
    assert.ok(h.includes(`data-team-offer="${choice}"><strong>${label}</strong>`), label);
  }
  assert.strictEqual(w.slots.c1.hidden, false);
  assert.strictEqual(w.slots.c2.innerHTML, '', 'another agent\'s chat has no card');
  assert.strictEqual(w.slots.c2.hidden, true);
});
test('offer card: the lead\'s display name is used as renamed, and "Maestro" is not hard-coded', () => {
  const w = desk({ leadDisplay: 'Sam' });
  w.api.teamSetupApply({ offer: 'pending', lead: { name: 'lead', display: 'Sam' }, setups: [] });
  assert.match(w.slots.c1.innerHTML, /<h3>Sam has a suggestion<\/h3>/);
  assert.doesNotMatch(w.slots.c1.innerHTML, /Maestro/);
  const ctxSrc = app.slice(app.indexOf('function teamSetupOfferHtml('), app.indexOf('function teamSetupUndoRows('));
  assert.doesNotMatch(ctxSrc, /Maestro/);
});
test('offer card: never for a member, and not when the offer is anything but pending', () => {
  const m = desk({ member: true });
  m.api.teamSetupApply({ offer: 'pending', lead: LEAD, setups: SETUPS });
  assert.strictEqual(m.slots.c1.innerHTML, '');
  assert.strictEqual(m.api.teamSetupLineHtml(), '', 'no Undo line for a member either');
  for (const offer of ['not_now', 'never', 'accepted', null]) {
    const w = desk();
    w.api.teamSetupApply({ offer, lead: LEAD, setups: [] });
    assert.strictEqual(w.slots.c1.innerHTML, '', String(offer));
  }
});
test('offer card: each answer POSTs its choice; the card is gone at once; "Show me the proposal" opens the lead\'s chat', async () => {
  for (const choice of ['show', 'not_now', 'never']) {
    const w = desk({ routes: { 'POST /api/team-setup/offer': res(200, { offer: choice === 'show' ? 'accepted' : choice, lead: LEAD }) } });
    w.api.teamSetupApply({ offer: 'pending', lead: LEAD, setups: [] });
    assert.ok(w.slots.c1.innerHTML);
    await w.api.teamSetupAnswer(choice);
    const post = w.calls.find((c) => c.method === 'POST');
    assert.strictEqual(post.url, '/api/team-setup/offer');
    assert.deepStrictEqual(JSON.parse(post.body), { choice });
    assert.strictEqual(w.slots.c1.innerHTML, '', 'the card disappears after the answer');
    assert.deepStrictEqual(w.ctx.started, choice === 'show' ? ['lead'] : []);
  }
});
test('offer card: an answer made on another device removes it on the next status refresh or page load (GET /api/team-setup)', async () => {
  const w = desk({ status: { lead: { busy: false, offerPending: true } }, routes: { 'GET /api/team-setup': res(200, { offer: 'never', lead: LEAD, setups: [], anyTeam: false }) } });
  w.api.teamSetupApply({ offer: 'pending', lead: LEAD, setups: [] });
  assert.ok(w.slots.c1.innerHTML);
  await w.api.teamSetupLoad();
  assert.strictEqual(w.slots.c1.innerHTML, '');
  assert.strictEqual(JSON.stringify(w.ctx.statusSets), JSON.stringify([['lead', { offerPending: false }]]), 'the lead row\'s waiting marker goes with the card');
  // and the status feed drives the reload: a change of offerPending on any entry asks for the state again
  assert.match(app, /if \(!!cur\.offerPending !== !!next\.offerPending\) teamSetupLoadSoon\(\);/);
});
test('the lead row shows the existing waiting marker while offerPending (admins only); offerPending survives the lead going idle', () => {
  const live = app.slice(app.indexOf('function agentLiveState('), app.indexOf('function paintAgentStatus('));
  assert.match(live, /const offer = !!\(s && s\.offerPending && isHubAdmin\(\)\);/);
  assert.match(live, /const question = !!\(s && s\.pendingQuestion\) \|\| offer;/, 'the same question path (live-question dot, "waiting for your answer" line)');
  assert.match(app, /next\.buildingTeamFor = null; next\.reviewingTeamFor = null; next\.settingUpTeams = false; \}/, 'idle clears settingUpTeams only (and the review key beside buildingTeamFor)');
  const idleLine = app.slice(app.indexOf('function setAgentLive('), app.indexOf('function dropGoneWorker(')).split('\n').find((l) => /if \(!next\.busy\) \{ next\.busySince/.test(l));
  assert.doesNotMatch(idleLine.replace(/\/\/.*$/, ''), /offerPending/, 'the idle reset (code, not its comment) leaves offerPending alone');
  assert.match(app, /'buildingTeamFor', 'reviewingTeamFor', 'offerPending', 'settingUpTeams'\]\) if \(k in s\)/, 'both keys ride the status patch');
});
test('empty state (admins): the lead named, a "Set up teams" button, "Setting up…" while the turn runs; members keep the old text', () => {
  const r = fnFrom(app, 'renderTeams');
  assert.match(r, /hubEsc\(`\$\{teamSetupLeadDisplay\(\)\} can look at how your agents already work together and propose teams\. Nothing changes until you approve a team\.`\)/);
  assert.match(r, /data-team-setup\$\{settingUp \? ' disabled aria-disabled="true"' : ''\}>\$\{settingUp \? 'Setting up…' : 'Set up teams'\}<\/button>/);
  assert.match(r, /: 'An admin can set who reports to whom\.'/);
  assert.match(r, /h \+= teamSetupLineHtml\(\);/);
  const w = desk({ status: { lead: { busy: true, settingUpTeams: true } } });
  assert.strictEqual(w.api.teamSetupBusy(), true);
  assert.strictEqual(desk().api.teamSetupBusy(), false);
});
test('empty state: the button POSTs /api/team-setup/start and opens the lead\'s chat; a 409 shows the server text', async () => {
  const ok = desk({ routes: { 'POST /api/team-setup/start': res(202, { lead: 'lead', turnId: 't1' }) } });
  await ok.api.teamSetupStart();
  assert.strictEqual(ok.calls[0].url, '/api/team-setup/start');
  assert.deepStrictEqual(ok.ctx.started, ['lead']);
  const obj = desk({ routes: { 'POST /api/team-setup/start': res(202, { lead: { name: 'lead', display: 'Lead' }, turnId: 't1' }) } });
  await obj.api.teamSetupStart();
  assert.deepStrictEqual(obj.ctx.started, ['lead'], 'the lead as an object works too');
  const busy = desk({ routes: { 'POST /api/team-setup/start': res(409, { error: 'A set-up pass is already running.' }) } });
  await busy.api.teamSetupStart();
  assert.deepStrictEqual(busy.ctx.started, []);
  assert.deepStrictEqual(busy.ctx.alerts, ['A set-up pass is already running.']);
  assert.match(fnFrom(app, 'teamsClick'), /\[data-team-setup\]'\)\) \{ e\.stopPropagation\(\); teamSetupStart\(\); return; \}/);
});
test('Undo line: "Team setup: N teams recorded <date> · Undo" at the bottom of the Teams tab, admins only, only with setups', () => {
  const w = desk();
  assert.strictEqual(w.api.teamSetupLineHtml(), '');
  w.api.teamSetupApply({ offer: null, lead: LEAD, setups: SETUPS });
  const h = w.api.teamSetupLineHtml();
  assert.match(h, /^<div class="teams-setup-line">Team setup: 2 teams recorded [^<]+ · <button type="button" class="teams-setup-undo" data-team-undo>Undo<\/button><\/div>$/);
  w.api.teamSetupApply({ offer: null, lead: LEAD, setups: [SETUPS[0]] });
  assert.match(w.api.teamSetupLineHtml(), /Team setup: 1 team recorded /);
  assert.match(fnFrom(app, 'teamsClick'), /\[data-team-undo\]'\)\) \{ e\.stopPropagation\(\); teamSetupUndo\(\{ all: true \}\); return; \}/);
});
test('Undo line: asks "Remove these N reporting lines?" (N = all lines of all setups), then POSTs { all: true } and redraws', async () => {
  const w = desk({ routes: { 'POST /api/team-setup/undo': res(200, { removed: 2, keptChanged: 0 }), 'GET /api/team-setup': res(200, { offer: 'never', lead: LEAD, setups: [], anyTeam: false }) } });
  w.api.teamSetupApply({ offer: 'never', lead: LEAD, setups: SETUPS });
  await w.api.teamSetupUndo({ all: true });
  assert.deepStrictEqual(w.ctx.confirms, ['Remove these 5 reporting lines?']);
  const post = w.calls.find((c) => c.method === 'POST');
  assert.strictEqual(post.url, '/api/team-setup/undo');
  assert.deepStrictEqual(JSON.parse(post.body), { all: true });
  assert.strictEqual(w.ctx.agentLoads, 1, 'the agent list is read again (the lines changed)');
  assert.strictEqual(w.api.state.setups.length, 0, 'the setups are read again: the line is gone, the tab shows the empty state');
  assert.strictEqual(w.api.teamSetupLineHtml(), '');
});
test('Undo line: a "no" in the confirm sends nothing; lines changed by hand since are reported', async () => {
  const no = desk({ confirm: false });
  no.api.teamSetupApply({ offer: null, lead: LEAD, setups: SETUPS });
  await no.api.teamSetupUndo({ all: true });
  assert.strictEqual(no.calls.filter((c) => c.method === 'POST').length, 0);
  const kept = desk({ routes: { 'POST /api/team-setup/undo': res(200, { removed: 1, keptChanged: 2 }) } });
  kept.api.teamSetupApply({ offer: null, lead: LEAD, setups: SETUPS });
  await kept.api.teamSetupUndo({ all: true });
  assert.match(kept.ctx.alerts[0], /2 reporting lines were changed by hand since and stayed as set\./);
});
test('per-setup Undo: "Undo this team" under the lead\'s confirmation (event or GET), confirm with that setup\'s N, POST { id }', async () => {
  const w = desk({ routes: { 'POST /api/team-setup/undo': res(200, { removed: 2, keptChanged: 0 }) } });
  w.api.teamSetupApply({ offer: 'accepted', lead: LEAD, setups: SETUPS });
  assert.strictEqual(w.slots.c1.innerHTML, '', 'old setups (a day ago) are not offered as chat Undo rows');
  w.api.teamSetupRecent.add('s2');   // what the 'team_setup_recorded' event does
  w.api.teamSetupApply({ offer: 'accepted', lead: LEAD, setups: SETUPS });
  const h = w.slots.c1.innerHTML;
  assert.match(h, /Studio|studio/i);
  assert.ok(h.includes('data-team-undo-id="s2"') && h.includes('>Undo</button>'));
  assert.ok(!h.includes('Undo this team'));
  assert.ok(!h.includes('data-team-undo-id="s1"'));
  assert.strictEqual(w.slots.c2.innerHTML, '', 'only in the lead\'s chat');
  await w.api.teamSetupUndo({ id: 's2' });
  assert.deepStrictEqual(w.ctx.confirms, ['Remove these 2 reporting lines?']);
  assert.deepStrictEqual(JSON.parse(w.calls.find((c) => c.method === 'POST').body), { id: 's2' });
  // a setup written within the last half hour shows after a page load as well (GET /api/team-setup)
  const fresh = desk();
  fresh.api.teamSetupApply({ offer: 'accepted', lead: LEAD, setups: [{ id: 'f1', at: new Date().toISOString(), main: 'atlas', count: 1 }] });
  assert.match(fresh.slots.c1.innerHTML, /team recorded<[^]*data-team-undo-id="f1"/);
});
test('the hub event team_setup_recorded is wired (remembers the id, reloads the agent list and the state)', () => {
  assert.match(app, /source\.addEventListener\('team_setup_recorded', e => \{[\s\S]{0,80}teamSetupRecent\.add\(String\(ev\.id\)\);[\s\S]{0,120}loadAgents\(\)[\s\S]{0,60}teamSetupLoadSoon\(\);/);
  assert.match(app, /<div class="team-offer-slot" id="team-offer-slot-\$\{chatId\}" hidden><\/div>\n\s*<div class="handoff-cards" id="handoff-cards-\$\{chatId\}" hidden><\/div>/, 'the slot sits above the hand-off cards, the pinned pair intact');
  assert.match(app, /soloViewPaint\(\);[^\n]*\n\s*try \{ teamSetupChatPaint\(chats\[chatId\]\); \}/, 'after the pinned compactionRefresh / paintPlanBadges lines');
  assert.match(app, /teamSetupLoad\(\);   \/\/ admins: the one-time offer/);
  assert.match(app, /const HUB_AUTO_OPEN = new Set\(\['job_notice', 'job_report', 'schedule'\]\);/, 'a set-up turn is the owner\'s, never auto-opened');
});

// "Show the Teams tab"
function tabsWorld(admin) {
  const mk = (view, hidden) => ({ dataset: { tab: view }, hidden: !!hidden, classList: { contains: () => false } });
  const tabs = { agents: mk('agents'), teams: mk('teams'), 'group-chat': mk('group-chat', true), guide: mk('guide', true) };
  const sw = [{ dataset: { view: 'agents' }, hidden: false }, { dataset: { view: 'teams' }, hidden: false }];
  const ctx = {
    isHubAdmin: () => admin, sidebarViewSet() {}, sidebarViewOk: () => false, sidebarViewStored: () => 'agents', sidebarViewTouched: true,
    document: {
      querySelector(sel) { const m = /^\.tab\[data-tab="([\w-]+)"\]$/.exec(sel); return m ? tabs[m[1]] : null; },
      querySelectorAll(sel) { assert.strictEqual(sel, '#simple-view-switch button'); return sw; },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`let sidebarTabsCfg = {}; ${fnFrom(app, 'sidebarTabsApply')}; ${fnFrom(app, 'sidebarTabsToggleHtml')}; this.api = { sidebarTabsApply, sidebarTabsToggleHtml };`, ctx);
  return { api: ctx.api, tabs, sw };
}
test('setting "Show the Teams tab": on by default; off hides the tab and its Simple button for an admin; Tiger Team and Guide stay as they were', () => {
  const w = tabsWorld(true);
  w.api.sidebarTabsApply({});
  assert.strictEqual(w.tabs.teams.hidden, false);
  w.api.sidebarTabsApply({ sidebarTeams: false });
  assert.strictEqual(w.tabs.teams.hidden, true);
  assert.strictEqual(w.sw[1].hidden, true);
  assert.strictEqual(w.sw[0].hidden, false, 'All Agents stays');
  w.api.sidebarTabsApply({ sidebarTeams: true, sidebarGuide: true });
  assert.strictEqual(w.tabs.teams.hidden, false);
  assert.strictEqual(w.sw[1].hidden, false);
  assert.strictEqual(w.tabs.guide.hidden, false);
  assert.strictEqual(w.tabs['group-chat'].hidden, true);
});
test('setting "Show the Teams tab": sits beside the Tiger Team and Guide switches in Settings → Appearance, checked unless off', () => {
  const w = tabsWorld(true);
  const on = w.api.sidebarTabsToggleHtml({});
  const tiger = on.indexOf('Show the Tiger Team tab'), guide = on.indexOf('Show the Guide tab'), teams = on.indexOf('Show the Teams tab');
  assert.ok(tiger > 0 && guide > tiger && teams > guide);
  assert.match(on, /id="st-sidebar-teams" data-no-dirty checked onchange="saveSidebarTabToggle\('sidebarTeams', this\.checked\)"/);
  assert.doesNotMatch(w.api.sidebarTabsToggleHtml({ sidebarTeams: false }), /id="st-sidebar-teams" data-no-dirty checked/);
  assert.match(app, /sidebarTabsApply\(\{ sidebarTigerTeam: d\.sidebarTigerTeam === true, sidebarGuide: d\.sidebarGuide === true, sidebarTeams: d\.sidebarTeams !== false \}\)/);
  assert.match(app, /key === 'sidebarTeams' \? 'st-sidebar-teams-state'/);
});
test('setting "Show the Teams tab": a member never has it hidden by the setting', () => {
  const w = tabsWorld(false);
  w.api.sidebarTabsApply({ sidebarTeams: false });
  assert.strictEqual(w.tabs.teams.hidden, false);
});
test('setting "Show the Teams tab": stored server-side beside the other two (server.js and lib/settings.js), on unless false', () => {
  assert.match(server, /if \(patch && patch\.sidebarGuide !== undefined\) patch\.sidebarGuide = patch\.sidebarGuide === true;\n\s*if \(patch && patch\.sidebarTeams !== undefined\) patch\.sidebarTeams = patch\.sidebarTeams !== false;/);
  assert.match(settingsSrc, /result\.sidebarGuide = s\.sidebarGuide === true;\n\s*result\.sidebarTeams = s\.sidebarTeams !== false;/);
});

// plan card: four options
test('plan card: every option the server sends is drawn (desktop and phone): four buttons for Do it / Approve all remaining teams / Change something / Not now', () => {
  const from = app.indexOf('const shownOptions = (q) =>');
  const dsk = app.slice(from, app.indexOf('const textOnly = ', from));
  assert.match(dsk, /\(q\.options \|\| \[\]\)\.filter\(o => !\(isSkip\(o\) && questions\.length === 1\)\)/, 'only Skip is ever filtered');
  assert.match(app, /for \(const opt of shownOptions\(q\)\) \{\n\s*const safeLabel/, 'one button per option, no cap');
  const ph = mjs.slice(mjs.indexOf('function showQuestion('), mjs.indexOf('function showQuestion(') + 9000);
  assert.doesNotMatch(ph, /options\.slice\(|options\.length > [0-9]|\.slice\(0, [0-9]\)/, 'no cap on the options');
  // the checklist rows of a set-up card render as for Build Team
  const fn = new Function('hubEsc', `${fnFrom(app, 'questionChecklistHtml')}; return questionChecklistHtml;`);
  const html = fn((s) => String(s))([{ id: 'a', label: 'Writer reports to Atlas', detail: '14 hand-offs' }, { id: 'b', label: 'Editor reports to Writer' }], (s) => String(s));
  assert.strictEqual((html.match(/<input type="checkbox" checked/g) || []).length, 2, 'the per-line checkboxes render as before');
});

// ───────────────────────── phone page (mobile.js) ─────────────────────────
function phone(over = {}) {
  const calls = [];
  const slot = { dataset: {}, innerHTML: '', hidden: true, addEventListener() {} };
  const env = {
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    isAdmin: () => over.member !== true, agents: [{ name: 'atlas', display: 'Atlas' }, { name: 'lead', display: over.leadDisplay || 'Lead', lead: true }],
    store: {}, localStorage: { getItem: (k) => (k in env.store ? env.store[k] : null), setItem: (k, v) => { env.store[k] = String(v); } },
    live: over.live || {}, current: over.current === undefined ? 'lead' : over.current, screen: over.screen || 'chat',
    $: (id) => (id === 'team-offer-slot' ? slot : null), displayName: (n) => (n === 'atlas' ? 'Atlas' : n === 'studio' ? 'Studio' : n),
    toasts: [], toast: (m) => env.toasts.push(m), confirms: [], confirm: (m) => { env.confirms.push(m); return over.confirm !== false; },
    navigated: [], navigate: (...a) => env.navigated.push(a), renders: 0, renderAgents: () => { env.renders++; }, agentLoads: 0, loadAgents: async () => { env.agentLoads++; },
    statusSets: [], setLive: (n, p) => { env.statusSets.push([n, p]); },
    teamsView: () => 'teams', setTimeout: (f) => { env.timers.push(f); return env.timers.length; }, timers: [],
    api: async (url, init) => {
      const method = (init && init.method) || 'GET';
      calls.push({ url, method, body: init && init.body });
      const r = (over.routes || {})[`${method} ${url}`];
      return typeof r === 'function' ? r(init) : (r || res(200, {}));
    },
  };
  const block = mjs.slice(mjs.indexOf('// ── Set up teams and Undo team setup'), mjs.indexOf('// The Active section at the top of the agent list'));
  assert.ok(block.length > 500);
  const names = Object.keys(env);
  const api = new Function(...names, block + '\nreturn { teamSetupApply, teamSetupLoad, teamSetupAnswer, teamSetupStart, teamSetupUndo, teamSetupLineHtml, teamSetupEmptyHtml, teamSetupBusy, teamSetupRecent, teamSetupSlotPaint, teamSetupWire, teamSetupUndoAll, teamSetupDismiss, teamSetupToggleList, teamSetupTight, get state() { return teamSetup; } };')(...names.map((n) => env[n]));
  return { env, api, calls, slot };
}
test('phone: the offer card shows in the lead\'s chat for an admin, with the lead\'s display name, the sentence and the three answers', () => {
  const w = phone();
  w.api.teamSetupApply({ offer: 'pending', lead: LEAD, setups: [] });
  const h = w.slot.innerHTML;
  assert.ok(h.includes('Lead has a suggestion'));
  assert.ok(h.includes('Lead can look at how your agents already work together and suggest teams for the Teams tab. Nothing changes in how your agents work unless you approve a team.'));
  for (const [choice, label] of [['show', 'Show me the proposal'], ['not_now', 'Not now'], ['never', "Don't ask again"]]) assert.ok(h.includes(`data-team-offer="${choice}"><strong>${label}</strong>`), label);
  assert.strictEqual(w.slot.hidden, false);
  assert.match(phone({ leadDisplay: 'Sam' }).env.esc('x') && (() => { const p = phone({ leadDisplay: 'Sam' }); p.api.teamSetupApply({ offer: 'pending', lead: { name: 'lead', display: 'Sam' }, setups: [] }); return p.slot.innerHTML; })(), /Sam has a suggestion/);
});
test('phone: no card for a member, in another agent\'s chat, outside the chat screen, or when the offer is not pending', () => {
  for (const o of [{ member: true }, { current: 'atlas' }, { screen: 'agents' }]) {
    const w = phone(o);
    w.api.teamSetupApply({ offer: 'pending', lead: LEAD, setups: SETUPS });
    assert.strictEqual(w.slot.innerHTML, '', JSON.stringify(o));
  }
  for (const offer of ['not_now', 'never', 'accepted', null]) {
    const w = phone();
    w.api.teamSetupApply({ offer, lead: LEAD, setups: [] });
    assert.strictEqual(w.slot.innerHTML, '', String(offer));
  }
});
test('phone: an answer POSTs the choice and the card goes; an answer elsewhere clears it on the next state read and the row marker with it', async () => {
  const w = phone({ routes: { 'POST /api/team-setup/offer': res(200, { offer: 'not_now', lead: LEAD }) } });
  w.api.teamSetupApply({ offer: 'pending', lead: LEAD, setups: [] });
  await w.api.teamSetupAnswer('not_now');
  assert.deepStrictEqual(JSON.parse(w.calls.find((c) => c.method === 'POST').body), { choice: 'not_now' });
  assert.strictEqual(w.slot.innerHTML, '');
  const o = phone({ live: { lead: { offerPending: true } }, routes: { 'GET /api/team-setup': res(200, { offer: 'never', lead: LEAD, setups: [] }) } });
  o.api.teamSetupApply({ offer: 'pending', lead: LEAD, setups: [] });
  assert.ok(o.slot.innerHTML);
  await o.api.teamSetupLoad();
  assert.strictEqual(o.slot.innerHTML, '');
  assert.deepStrictEqual(o.env.statusSets, [['lead', { offerPending: false }]]);
  assert.match(mjs, /if \(!!cur\.offerPending !== !!next\.offerPending && typeof teamSetupLoadSoon === 'function'\) teamSetupLoadSoon\(\);/);
});
test('phone: the lead row gets the existing question marker while offerPending (admins only); the status keys ride the snapshot', () => {
  assert.match(mjs, /const question = !done && !!\(s && \(s\.pendingQuestion \|\| \(s\.offerPending && isAdmin\(\)\)\)\);/);
  assert.match(mjs, /'consultedBy', 'buildingTeamFor', 'reviewingTeamFor', 'offerPending', 'settingUpTeams'\]\) \{/);
  assert.match(mjs, /next\.buildingTeamFor = null; next\.reviewingTeamFor = null; next\.settingUpTeams = null; \}/);
  assert.match(mjs, /ev\.origin\.kind !== 'build_team' && ev\.origin\.kind !== 'team_setup' && ev\.origin\.kind !== 'optimize_team'\) \{/, 'a set-up turn stays in the main view');
});
test('phone: Teams list empty state has the lead named and a "Set up teams" button (admins); Setting up… while the turn runs; start POSTs and opens the lead\'s chat', async () => {
  const w = phone();
  w.api.teamSetupApply({ offer: null, lead: LEAD, setups: [] });
  assert.ok(w.api.teamSetupEmptyHtml().includes('Lead can look at how your agents already work together and propose teams. Nothing changes until you approve a team. '));
  assert.match(w.api.teamSetupEmptyHtml(), /<button type="button" class="tm-setup-btn" data-team-setup>Set up teams<\/button>/);
  const busy = phone({ live: { lead: { settingUpTeams: true } } });
  assert.match(busy.api.teamSetupEmptyHtml(), /data-team-setup disabled aria-disabled="true">Setting up…<\/button>/);
  assert.match(mjs, /\(isAdmin\(\) \? teamSetupEmptyHtml\(\) : 'An admin can set who reports to whom\.'\)/, 'members keep the old text');
  const s = phone({ routes: { 'POST /api/team-setup/start': res(202, { lead: 'lead', turnId: 't' }) } });
  await s.api.teamSetupStart();
  assert.strictEqual(s.calls[0].url, '/api/team-setup/start');
  assert.deepStrictEqual(s.env.navigated, [['chat', 'lead']]);
  const nope = phone({ routes: { 'POST /api/team-setup/start': res(409, { error: 'Already running.' }) } });
  await nope.api.teamSetupStart();
  assert.deepStrictEqual(nope.env.navigated, []);
  assert.deepStrictEqual(nope.env.toasts, ['Already running.']);
});
test('phone: Undo line text, the confirm with N, POST { all: true }, redraw; and the per-team Undo with { id }', async () => {
  const w = phone({ routes: { 'POST /api/team-setup/undo': res(200, { removed: 5, keptChanged: 1 }), 'GET /api/team-setup': res(200, { offer: 'never', lead: LEAD, setups: [] }) } });
  assert.strictEqual(w.api.teamSetupLineHtml(), '');
  w.api.teamSetupApply({ offer: 'never', lead: LEAD, setups: SETUPS });
  assert.match(w.api.teamSetupLineHtml(), /^<div class="tm-setup-line">Team setup: 2 teams recorded [^<]+ · <button type="button" class="tm-setup-undo" data-team-undo>Undo<\/button><\/div>$/);
  await w.api.teamSetupUndo({ all: true });
  assert.deepStrictEqual(w.env.confirms, ['Remove these 5 reporting lines?']);
  assert.deepStrictEqual(JSON.parse(w.calls.find((c) => c.method === 'POST').body), { all: true });
  assert.strictEqual(w.env.agentLoads, 1);
  assert.strictEqual(w.api.state.setups.length, 0);
  assert.match(w.env.toasts[0], /1 reporting line was changed by hand since and stayed as set\./);
  // per team
  const t = phone({ routes: { 'POST /api/team-setup/undo': res(200, { removed: 2, keptChanged: 0 }) } });
  t.api.teamSetupRecent.add('s2');
  t.api.teamSetupApply({ offer: 'accepted', lead: LEAD, setups: SETUPS });
  assert.ok(t.slot.innerHTML.includes('data-team-undo-id="s2"') && !t.slot.innerHTML.includes('Undo this team'));
  assert.ok(!t.slot.innerHTML.includes('data-team-undo-id="s1"'));
  await t.api.teamSetupUndo({ id: 's2' });
  assert.deepStrictEqual(t.env.confirms, ['Remove these 2 reporting lines?']);
  assert.deepStrictEqual(JSON.parse(t.calls.find((c) => c.method === 'POST').body), { id: 's2' });
  const no = phone({ confirm: false });
  no.api.teamSetupApply({ offer: null, lead: LEAD, setups: SETUPS });
  await no.api.teamSetupUndo({ all: true });
  assert.strictEqual(no.calls.filter((c) => c.method === 'POST').length, 0);
});
test('phone: wiring: taps on the list and slot, the event, openChat, the slot in mobile.html above the hand-off cards (pair intact)', () => {
  assert.match(mjs, /if \(e\.target\.closest\('\[data-team-setup\]'\)\)[^\n]*teamSetupStart\(\); return; \}/);
  assert.match(mjs, /if \(e\.target\.closest\('\[data-team-undo\]'\)\) \{ teamSetupUndo\(\{ all: true \}\); return; \}/);
  assert.match(mjs, /on\('team_setup_recorded', \(ev\) => \{ if \(!ev\) return; if \(ev\.id\) teamSetupRecent\.add\(String\(ev\.id\)\); loadAgents\(\); teamSetupLoadSoon\(\); \}\);/);
  assert.match(mjs, /HandOffCard\.follow\(\); \} catch[^\n]*\n\s*teamSetupSlotPaint\(\);/, 'after the pinned current = name .. HandOffCard.follow() pair');
  assert.match(mjs, /teamsPaintSwitch\(\);\n\s*teamSetupWire\(\);/);
  assert.match(mjs, /if \(isAdmin\(\)\) \{ teamsTabLoad\(\); teamSetupLoad\(\); \}/);
  assert.match(mhtml, /<div id="team-offer-slot" class="team-offer-slot" hidden><\/div>\n\s*<div id="handoff-cards" class="handoff-cards" hidden><\/div>\n\s*<div id="research-lines"/);
  const css = mhtml.split('\n').filter((l) => /tm-setup|team-offer|team-undo/.test(l)).join('\n');
  assert.ok(css && !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(css), 'variables only, no colour literals');
  assert.match(css, /\.tm-setup-btn \{[^}]*min-height: 44px/);
  const dcss = idx.split('\n').filter((l) => /teams-setup|team-offer|team-undo/.test(l)).join('\n');
  assert.ok(dcss && !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(dcss), 'desktop: variables only');
});
test('phone: setting "Show the Teams tab" off hides the Teams switch and the view falls back to All Agents', async () => {
  const sw = [{ dataset: { view: 'agents' }, classList: { toggle() {} }, setAttribute() {}, parentElement: { style: {} } }, { dataset: { view: 'teams' }, classList: { toggle() {} }, setAttribute() {}, parentElement: null }];
  sw[1].parentElement = sw[0].parentElement;
  const store = { 'hub-sidebar-view': 'teams' };
  const env = {
    document: { querySelectorAll: () => sw }, localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    isAdmin: () => true, screen: 'chat', renderAgents() {},
    api: async () => res(200, { sidebarTeams: false }),
    loadJson: () => ({}), saveJson() {},
  };
  const names = Object.keys(env);
  const teams = mjs.slice(mjs.indexOf('// ── Teams view of the agent list'), mjs.indexOf('function teamsPick('));
  const tabLoad = 'async ' + fnFrom(mjs, 'teamsTabLoad');
  const api = new Function(...names, `${teams}\n${tabLoad}\nreturn { teamsView, teamsTabLoad, teamsPaintSwitch };`)(...names.map((n) => env[n]));
  assert.strictEqual(api.teamsView(), 'teams');
  await api.teamsTabLoad();
  assert.strictEqual(api.teamsView(), 'agents');
  assert.strictEqual(sw[0].parentElement.style.display, 'none', 'the switch has one choice left: it goes');
  const member = { ...env, isAdmin: () => false };
  const names2 = Object.keys(member);
  const api2 = new Function(...names2, `${teams}\n${tabLoad}\nreturn { teamsView, teamsTabLoad };`)(...names2.map((n) => member[n]));
  await api2.teamsTabLoad();
  assert.strictEqual(api2.teamsView(), 'teams', 'a member is not affected');
});
test('phone: the plan card draws every option the server sends (four for a set-up card)', () => {
  const body = mjs.slice(mjs.indexOf('function showQuestion('), mjs.indexOf('function showQuestion(') + 12000);
  assert.doesNotMatch(body, /\.slice\(0, [0-9]\)|opts?\.length > [0-9]|options\.length > [0-9]/);
  assert.match(body, /isSkip/);
});

// ───────────────────────── the one compact Undo line (desktop and phone) ─────────────────────────
const MAINS = ['atlas', 'studio', 'ember', 'north', 'maestro', 'quill'];
const recentSetups = (k) => MAINS.slice(0, k).map((main, i) => ({ id: `u${i + 1}`, at: new Date(Date.now() - (k - i) * 60 * 1000).toISOString(), main, count: 3 }));
const textOf = (h) => h.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const pages = [
  ['desktop', () => { const w = desk(); return { w, html: () => w.slots.c1.innerHTML, apply: (setups) => w.api.teamSetupApply({ offer: 'accepted', lead: LEAD, setups }), confirms: () => w.ctx.confirms, store: () => w.ctx.store }; }],
  ['phone', () => { const w = phone(); return { w, html: () => w.slot.innerHTML, apply: (setups) => w.api.teamSetupApply({ offer: 'accepted', lead: LEAD, setups }), confirms: () => w.env.confirms, store: () => w.env.store }; }],
];
for (const [label, mk] of pages) {
  test(`${label}: one recent setup is one line with the single wording and Undo, no stacked cards`, () => {
    const p = mk();
    p.apply(recentSetups(1));
    const h = p.html();
    assert.strictEqual((h.match(/class="team-undo-line"/g) || []).length, 1);
    assert.doesNotMatch(h, /Undo this team|team-undo-row|team-undo-list/);
    assert.match(textOf(h), /^Atlas team recorded · Undo ×$/);
    assert.ok(h.includes('data-team-undo-id="u1"') && h.includes('data-team-undo-dismiss'));
  });
  test(`${label}: six recent setups are exactly one line "6 teams recorded · Undo"; the list opens with 6 rows and Undo all`, async () => {
    const p = mk();
    p.apply(recentSetups(6));
    let h = p.html();
    assert.strictEqual((h.match(/team-undo-line/g) || []).length, 1, 'one line element');
    assert.strictEqual((h.match(/team recorded \(/g) || []).length, 0, 'no per-team cards');
    assert.strictEqual(textOf(h), '6 teams recorded · Undo ×');
    assert.doesNotMatch(h, /team-undo-list/);
    p.w.api.teamSetupToggleList();
    h = p.html();
    assert.strictEqual((h.match(/class="team-undo-item"/g) || []).length, 7, '6 team rows + the Undo all row');
    assert.strictEqual((h.match(/data-team-undo-id="/g) || []).length, 6);
    assert.strictEqual((h.match(/data-team-undo-all/g) || []).length, 1);
    assert.ok(/Atlas team \(3 lines\)/i.test(h) && /Quill team \(3 lines\)/i.test(h));
    assert.ok(h.indexOf('data-team-undo-id="u6"') < h.indexOf('data-team-undo-id="u1"'), 'newest first');
    assert.strictEqual((h.match(/team-undo-line/g) || []).length, 1, 'still one line above the list');
    p.w.api.teamSetupToggleList();
    assert.doesNotMatch(p.html(), /team-undo-list/, 'the line toggles the list closed');
  });
  test(`${label}: a row's Undo asks "Remove these N reporting lines?" and POSTs its id; Undo all asks once and undoes each, newest first`, async () => {
    const p = mk();
    p.apply(recentSetups(6));
    await p.w.api.teamSetupUndo({ id: 'u3' });
    assert.deepStrictEqual(p.confirms(), ['Remove these 3 reporting lines?']);
    assert.deepStrictEqual(p.w.calls.filter((c) => c.method === 'POST').map((c) => JSON.parse(c.body)), [{ id: 'u3' }]);
    const q = mk();
    q.apply(recentSetups(6));
    await q.w.api.teamSetupUndoAll();
    assert.deepStrictEqual(q.confirms(), ['Remove all 18 reporting lines from these 6 teams?']);
    // changed: one request carries every listed setup, newest first (the server undoes them in that order)
    assert.deepStrictEqual(q.w.calls.filter((c) => c.method === 'POST').map((c) => JSON.parse(c.body)), [{ ids: ['u6', 'u5', 'u4', 'u3', 'u2', 'u1'] }]);
  });
  test(`${label}: × hides the line and it stays hidden on re-render until a newer setup id appears; the Teams tab line is unchanged`, () => {
    const p = mk();
    const six = recentSetups(6);
    p.apply(six);
    assert.ok(p.html());
    p.w.api.teamSetupDismiss();
    assert.strictEqual(p.html(), '');
    assert.strictEqual(p.store()['hub-team-undo-dismissed'], 'u6');
    p.apply(six);                                   // re-render with the same data
    assert.strictEqual(p.html(), '');
    p.apply([...six].reverse());                    // another order, same newest
    assert.strictEqual(p.html(), '');
    p.apply([...six, { id: 'u7', at: new Date().toISOString(), main: 'atlas', count: 2 }]);
    assert.strictEqual(textOf(p.html()), '7 teams recorded · Undo ×', 'a NEW setup brings it back');
    // dismissing loses nothing: the Teams tab line still offers Undo for every setup
    assert.match(p.w.api.teamSetupLineHtml(), /Team setup: 7 teams recorded [^<]+ · <button type="button" class="(teams-setup-undo|tm-setup-undo)" data-team-undo>Undo<\/button>/);
  });
  test(`${label}: setups older than 30 minutes show no chat line (existing limit), controls are plain buttons without hover`, () => {
    const p = mk();
    p.apply(recentSetups(6).map((s) => ({ ...s, at: new Date(Date.now() - 31 * 60 * 1000).toISOString() })));
    assert.strictEqual(p.html(), '');
    assert.match(label === 'desktop' ? app : mjs, /\.sort\(\(a, b\) => \(Date\.parse\(b\.at\) \|\| 0\) - \(Date\.parse\(a\.at\) \|\| 0\)\)/);
  });
}
test('the line and list styles: one line (nowrap, ellipsis), no hover rules, no colour literals, the slot stays above the Working on cards', () => {
  for (const [name, html] of [['index.html', idx], ['mobile.html', mhtml]]) {
    const css = html.split('\n').filter((l) => /\.team-undo-(line|text|x|list|item|sep)/.test(l)).join('\n');
    assert.match(css, /\.team-undo-line \{[^}]*white-space: nowrap/, name);
    assert.match(css, /\.team-undo-text \{[^}]*text-overflow: ellipsis/, name);
    assert.doesNotMatch(css, /:hover/, name);
    assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(css), name);
  }
  assert.match(app, /t\.closest\('\[data-team-undo-dismiss\]'\)\) \{ e\.preventDefault\(\); teamSetupDismiss\(\); return; \}/);
  assert.match(mjs, /t\.closest\('\[data-team-undo-all\]'\)\) \{ e\.preventDefault\(\); teamSetupUndoAll\(\); return; \}/);
  assert.match(app, /t\.closest\('\[data-team-undo-toggle\]'\)\) \{ e\.preventDefault\(\); teamSetupToggleList\(\); \}/);
});

// Owner, 2026-11-24: the offer card and the Undo line pushed the message box under the keyboard. Tight mode (box focused / short screen): one line.
test('phone tight mode: the offer card is its one-line title with a tap to open; opening shows the card and the answers still work; leaving tight closes it again', async () => {
  const w = phone({ routes: { 'POST /api/team-setup/offer': res(200, { offer: 'not_now', lead: LEAD }) } });
  w.api.teamSetupApply({ offer: 'pending', lead: LEAD, setups: [] });
  assert.ok(w.slot.innerHTML.includes('Nothing changes in how your agents work'), 'normal: the full card');
  w.api.teamSetupTight(true);
  let h = w.slot.innerHTML;
  assert.ok(h.includes('Lead has a suggestion') && h.includes('data-team-offer-expand'), 'tight: the title and the tap target');
  assert.ok(!h.includes('data-team-offer="') && !h.includes('Nothing changes'), 'tight: no answers, no sentence');
  assert.strictEqual(h.split('<div class="question').length - 1, 1, 'one card');
  // wire the real click handler on the phone's slot and open the card
  let handler; w.slot.addEventListener = (ev, f) => { handler = f; }; w.api.teamSetupWire();
  handler({ preventDefault() {}, target: { closest: (q) => (q === '[data-team-offer-expand]' ? {} : null) } });
  h = w.slot.innerHTML;
  assert.ok(h.includes('data-team-offer="show"') && h.includes('Nothing changes'), 'opened: the card and its answers');
  handler({ preventDefault() {}, target: { closest: (q) => (q === '[data-team-offer]' ? { dataset: { teamOffer: 'not_now' } } : null) } });
  await settle();
  assert.strictEqual(w.calls.filter((c) => c.method === 'POST' && c.url === '/api/team-setup/offer').length, 1, 'an answer works in tight mode');
  const w2 = phone();
  w2.api.teamSetupApply({ offer: 'pending', lead: LEAD, setups: [] });
  w2.api.teamSetupTight(true); w2.api.teamSetupTight(false);
  assert.ok(w2.slot.innerHTML.includes('Nothing changes'), 'leaving tight mode brings the full card back');
});
test('phone tight mode: the Undo line stays one line and its list stays closed', () => {
  const w = phone();
  w.api.teamSetupApply({ offer: 'accepted', lead: LEAD, setups: [{ ...SETUPS[0], at: new Date().toISOString() }, { ...SETUPS[1], at: new Date().toISOString() }] });
  w.api.teamSetupToggleList();
  assert.ok(w.slot.innerHTML.includes('team-undo-list'), 'normal: the list is open');
  w.api.teamSetupTight(true);
  assert.ok(w.slot.innerHTML.includes('team-undo-line') && !w.slot.innerHTML.includes('team-undo-list'), 'tight: the line only');
});
test('phone: #team-offer-slot is capped to a quarter of the visible height (--vvh) and scrolls inside; the msg box has a max-height and scrolls', () => {
  const rule = mhtml.match(/\.team-offer-slot \{([^}]*)\}/)[1];
  assert.match(rule, /max-height: calc\(var\(--vvh, 100dvh\) \* 0\.25\)/);
  assert.match(rule, /overflow-y: auto/);
  const box = mhtml.match(/#msg-input \{ flex: 1;([^}]*)\}/)[1];
  assert.match(box, /max-height: min\(140px, calc\(var\(--vvh, 100dvh\) \* 0\.4\)\)/);
  assert.match(box, /overflow-y: auto/);
  assert.match(mhtml, /#composer\.composer-tight \.handoff-cards \{[^}]*max-height: calc\(var\(--vvh, 100dvh\) \* 0\.2\); overflow-y: auto/);
  assert.match(mhtml, /body \{[^}]*height: var\(--vvh, 100dvh\)/);
});

// ───────────────────────── setup fixes r1 ─────────────────────────
test('phone tight mode: an explicit tap on Undo opens the list (aria-expanded true and the list shown); gaining focus (tight turns on) closes it again', () => {
  const w = phone();
  w.api.teamSetupApply({ offer: 'accepted', lead: LEAD, setups: recentSetups(3) });
  w.api.teamSetupTight(true);
  assert.ok(!w.slot.innerHTML.includes('team-undo-list') && /aria-expanded="false"/.test(w.slot.innerHTML));
  w.api.teamSetupToggleList();
  assert.ok(w.slot.innerHTML.includes('team-undo-list'), 'tight: the tap opens the list');
  assert.match(w.slot.innerHTML, /aria-expanded="true"/);
  assert.ok(w.slot.innerHTML.includes('data-team-undo-all'));
  w.api.teamSetupToggleList();
  assert.ok(!w.slot.innerHTML.includes('team-undo-list') && /aria-expanded="false"/.test(w.slot.innerHTML), 'tapping again closes it');
  const v = phone();
  v.api.teamSetupApply({ offer: 'accepted', lead: LEAD, setups: recentSetups(3) });
  v.api.teamSetupToggleList(); v.api.teamSetupTight(true);
  assert.ok(!v.slot.innerHTML.includes('team-undo-list') && /aria-expanded="false"/.test(v.slot.innerHTML), 'tight turning on closes an open list');
  assert.doesNotMatch(app.slice(app.indexOf('function teamSetupUndoHtml()'), app.indexOf('function teamSetupChatPaint')), /composerTight/, 'desktop has no tight condition');
});
// an old server: it knows { id } and { all } only and answers 400 to { ids }, so the pages fall back to one request per team
const undoRoutes = (byId) => ({ 'POST /api/team-setup/undo': (init) => { const b = JSON.parse(init.body); if (b.ids) return res(400, { error: 'give { id } or { all: true }' }); return byId[b.id] || res(200, { removed: 3 }); } });
for (const [label, mk] of [
  ['desktop', (routes) => { const w = desk({ routes }); return { w, msgs: () => w.ctx.alerts, apply: (s) => w.api.teamSetupApply({ offer: 'accepted', lead: LEAD, setups: s }) }; }],
  ['phone', (routes) => { const w = phone({ routes }); return { w, msgs: () => w.env.toasts, apply: (s) => w.api.teamSetupApply({ offer: 'accepted', lead: LEAD, setups: s }) }; }],
]) {
  test(`${label}: Undo all stops at the first team whose response has failed[] and says what failed`, async () => {
    const p = mk(undoRoutes({ u5: res(200, { removed: 1, failed: [{ agent: 'wes', error: 'refused' }, { agent: 'wil', error: 'busy' }] }) }));
    p.apply(recentSetups(6));
    await p.w.api.teamSetupUndoAll();
    assert.deepStrictEqual(p.w.calls.filter((c) => c.method === 'POST' && !JSON.parse(c.body).ids).map((c) => JSON.parse(c.body).id), ['u6', 'u5'], 'u4..u1 not tried');
    const m = p.msgs().find((x) => /Could not undo/.test(x));
    assert.ok(m, 'reported: ' + JSON.stringify(p.msgs()));
    assert.match(m, /^Could not undo \w+: /);
    assert.ok(m.includes('wes (refused)') && m.includes('wil (busy)'), m);
  });
  test(`${label}: Undo all stops at a non-2xx with its error; a 404 (already undone) counts as done and goes on`, async () => {
    const a = mk(undoRoutes({ u4: res(500, { error: 'disk full' }) }));
    a.apply(recentSetups(6));
    await a.w.api.teamSetupUndoAll();
    assert.deepStrictEqual(a.w.calls.filter((c) => c.method === 'POST' && !JSON.parse(c.body).ids).map((c) => JSON.parse(c.body).id), ['u6', 'u5', 'u4']);
    assert.ok(a.msgs().some((x) => /^Could not undo \w+: disk full$/.test(x)), JSON.stringify(a.msgs()));
    const b = mk(undoRoutes({ u5: res(404, { error: 'No such setup' }), u3: res(404, {}) }));
    b.apply(recentSetups(6));
    await b.w.api.teamSetupUndoAll();
    assert.deepStrictEqual(b.w.calls.filter((c) => c.method === 'POST' && !JSON.parse(c.body).ids).map((c) => JSON.parse(c.body).id), ['u6', 'u5', 'u4', 'u3', 'u2', 'u1'], 'all six tried');
    assert.ok(!b.msgs().some((x) => /Could not undo/.test(x)), JSON.stringify(b.msgs()));
  });
}

// ── Undo all in one request ──
for (const [label, mk] of [
  ['desktop', (routes) => { const w = desk({ routes }); return { w, msgs: () => w.ctx.alerts, apply: (s) => w.api.teamSetupApply({ offer: 'accepted', lead: LEAD, setups: s }) }; }],
  ['phone', (routes) => { const w = phone({ routes }); return { w, msgs: () => w.env.toasts, apply: (s) => w.api.teamSetupApply({ offer: 'accepted', lead: LEAD, setups: s }) }; }],
]) {
  test(`${label}: Undo all in the chat is ONE POST { ids } (newest first, as listed); failed[] and kept lines are reported as before`, async () => {
    const p = mk({ 'POST /api/team-setup/undo': res(200, { removed: 4, keptChanged: [{ agent: 'x' }], failed: [{ agent: 'wes', error: 'refused' }] }) });
    p.apply(recentSetups(6));
    await p.w.api.teamSetupUndoAll();
    const posts = p.w.calls.filter((c) => c.method === 'POST');
    assert.strictEqual(posts.length, 1, 'one request');
    assert.deepStrictEqual(JSON.parse(posts[0].body), { ids: ['u6', 'u5', 'u4', 'u3', 'u2', 'u1'] });
    assert.ok(p.msgs().some((x) => /^Could not undo these teams: could not restore wes \(refused\)$/.test(x)), JSON.stringify(p.msgs()));
    assert.ok(p.msgs().some((x) => /1 reporting line was changed by hand/.test(x)));
  });
  test(`${label}: Undo all falls back to one request per team when the server answers 400 to { ids } (an old server)`, async () => {
    const p = mk({ 'POST /api/team-setup/undo': (init) => (JSON.parse(init.body).ids ? res(400, { error: 'give { id } or { all: true }' }) : res(200, { removed: 3 })) });
    p.apply(recentSetups(3));
    await p.w.api.teamSetupUndoAll();
    assert.deepStrictEqual(p.w.calls.filter((c) => c.method === 'POST').map((c) => JSON.parse(c.body)), [{ ids: ['u3', 'u2', 'u1'] }, { id: 'u3' }, { id: 'u2' }, { id: 'u1' }]);
    assert.ok(!p.msgs().some((x) => /Could not undo/.test(x)), JSON.stringify(p.msgs()));
  });
}

test('old server: a GET /api/team-setup without alone leaves state.alone an empty object on both pages', () => {
  const d = desk(); d.api.teamSetupApply({ offer: 'never', lead: LEAD, setups: [] });
  assert.strictEqual(JSON.stringify(d.api.state.alone), '{}');
  const p = phone(); p.api.teamSetupApply({ offer: 'never', lead: LEAD, setups: [] });
  assert.strictEqual(JSON.stringify(p.api.state.alone), '{}');
});
