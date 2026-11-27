'use strict';
// The Settings dialog in eight groups (P4-3): the pure module lib/ui-settings-groups.js (which section is where, the moved rows,
// the first group to open, what a search shows) and its wiring in app.js / index.html (source-level checks plus a small fake DOM
// for opening a section's group). The page itself is not run here.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/ui-settings-groups.js');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function settingsSource(app) {
  const start = app.indexOf('async function openSettings() {');
  const end = app.indexOf('// Auto model classifier (lib/classifier): settings', start);
  assert.ok(start > 0 && end > start, 'openSettings() found');
  return app.slice(start, end);
}
function drawnSections(app) {
  // The Voices section is drawn by voiceSettingsHtml(data), called from openSettings.
  const vAt = app.indexOf('function voiceSettingsHtml(data) {');
  assert.ok(vAt > 0 && settingsSource(app).includes('html += voiceSettingsHtml(data);'), 'Voices is drawn by openSettings');
  const src = settingsSource(app) + app.slice(vAt, app.indexOf('function voicePaintSettings(', vAt));
  assert.doesNotMatch(src, /class="st-section">/, 'no section without an id');
  return [...src.matchAll(/class="st-section" id="(st-[a-z0-9-]+-section)"/g)].map((m) => m[1]);
}

// U+FE0F (emoji variation selector) and the zero-width characters, built from their numbers so this file has none of them itself
const BAD_CHARS = new RegExp(`[${String.fromCharCode(0xFE0F, 0x200B, 0x200C, 0x200D, 0x2060)}]`);
const TITLES = ['For your review', 'You and this device', 'Agents and teams', 'Models and money', 'Voice and calls', 'Tools and connections', 'People and safety', 'Upkeep'];

test('eight groups in the designed order, titles, icons and sub-lines as in words.json (Needs you is For your review)', () => {
  assert.deepStrictEqual(G.GROUPS.map((g) => g.title), TITLES);
  assert.deepStrictEqual(G.GROUPS.map((g) => g.id), ['review', 'you', 'agents', 'money', 'voice', 'tools', 'safety', 'upkeep']);
  for (const g of G.GROUPS) {
    assert.ok(g.icon && g.sub, `${g.id}: icon and sub-line`);
    assert.doesNotMatch(JSON.stringify(g), BAD_CHARS, `${g.id}: no variation selector or zero-width character`);
  }
  assert.doesNotMatch(read('lib/ui-settings-groups.js'), BAD_CHARS, 'the module has no variation selector or zero-width character');
});

test('every section openSettings draws is in exactly one group (or its More); nothing is lost', () => {
  const app = read('app.js');
  const drawn = drawnSections(app);
  assert.strictEqual(drawn.length, 37, 'all 37 sections carry an id (33 + This Maestro in Upkeep + the Users door in People + Expert values + New agent in Agents and teams)');
  const listed = G.allSectionIds();
  assert.strictEqual(new Set(listed).size, listed.length, 'no section in two groups');
  assert.deepStrictEqual([...listed].sort(), [...drawn].sort(), 'the groups name exactly the sections drawn');
  assert.deepStrictEqual(G.groupOfSection('st-brand-new-section'), { group: 'upkeep', more: true }, 'an unknown section lands in Upkeep > More');
  assert.ok(app.includes('STG.groupOfSection(s.id)'), 'groupSettings places by the module');
});

test('where the sections go (P4-3 mapping)', () => {
  const by = Object.fromEntries(G.GROUPS.map((g) => [g.id, g]));
  assert.deepStrictEqual(by.review.sections, ['st-emergency-section', 'st-recent-section']);
  assert.deepStrictEqual(by.review.more, ['st-ready-section', 'st-health-section'], 'the full Setup and Health checks sit under More (P4-4B)');
  assert.strictEqual(by.safety.sections[by.safety.sections.length - 1], 'st-sec-section', 'the security check is in People and safety, last (phase 6 walkthrough: its subtitle names it)');
  assert.deepStrictEqual(by.you.sections, ['st-looks-section', 'st-notify-section', 'st-chat-section']);
  assert.deepStrictEqual(by.agents.sections, ['st-newagent-section', 'st-workers-section']);
  assert.deepStrictEqual(by.money.sections, ['st-subs-section', 'st-plan-section', 'st-spend-section', 'st-local-models-section', 'st-prov-section', 'st-or-section'], 'P4-14: subscriptions and plan usage, spend and caps, then the keys');
  assert.deepStrictEqual(by.money.more, ['st-classifier-section', 'st-tuning-section']);
  assert.deepStrictEqual(by.voice.sections, ['st-voice-section']);
  assert.deepStrictEqual(by.tools.sections, ['st-ws-section', 'st-comms-section', 'st-cx-section', 'st-modules-section']);
  assert.deepStrictEqual(by.safety.sections, ['st-users-section', 'st-sb-section', 'st-lb-section', 'st-mp-section', 'st-approvals-section', 'st-security-section', 'st-sec-section']);
  assert.deepStrictEqual(by.upkeep.sections, ['st-maestro-section', 'st-backups-section', 'st-memory-section', 'st-selfcheck-section', 'st-components-section', 'st-updates-section']);
  assert.deepStrictEqual(G.groupOfSection('st-emergency-section'), { group: 'review', more: false }, 'Stop all agents is at the top of For your review');
  assert.strictEqual(by.review.sections[0], 'st-emergency-section');
  assert.deepStrictEqual(G.groupOfSection('st-classifier-section'), { group: 'money', more: true });
});

test('moved rows: Agent Defaults dissolves; every row keeps an element id that openSettings draws', () => {
  const app = read('app.js'), idx = read('index.html'), src = app;
  const to = (sel) => G.groupOfRow(sel);
  assert.deepStrictEqual([to('#st-maxTokens').group, to('#st-maxTokens').more, to('#st-maxContext').group, to('#st-maxContext').more], ['money', true, 'money', true]);
  assert.deepStrictEqual([to('#st-reasoning').group, to('#st-reasoning').more], ['you', false]);
  assert.strictEqual(to('#st-model-offers').group, 'money');
  for (const s of ['#st-research-remind', '#st-research-ownwork', '#st-research-thorough']) assert.strictEqual(to(s).group, 'tools', s);
  for (const s of ['#st-sidebar-teams', '#st-sidebar-tiger', '#st-notify-agent']) assert.strictEqual(to(s).group, 'agents', s);
  assert.strictEqual(to('#st-look-new').group, 'safety');
  assert.strictEqual(to('#st-sidebar-guide'), null, 'the Guide tab switch stays in You and this device');
  for (const r of G.ROWS) {
    assert.ok(G.isGroup(r.to), `${r.selector}: a real group`);
    const id = r.selector.slice(1);
    assert.ok(src.includes(`id="${id}"`) || src.includes(`id = '${id}'`) || src.includes(`sel.id = '${id}'`) || idx.includes(`id="${id}"`) || src.includes(`id="st-\${`), `${r.selector} is drawn somewhere`);
    assert.ok(r.part && r.partTitle, `${r.selector}: names its small section`);
    assert.ok(G.groupOfSection(G.movedId(r)).group === r.to, `${r.selector}: its small section follows the table`);
  }
  assert.ok(app.includes("id=\"st-research-ownwork\"") && app.includes('id="st-research-thorough"') && app.includes('id="st-reasoning"') && app.includes('id="st-maxTokens"'));
  assert.ok(app.includes('function stPlaceRows()') && app.includes('setTimeout(stPlaceRows, 0)'), 'rows are placed after drawing, and again for the one painted a tick later');
});

test('the group that opens first: the first with a red summary, else the last one opened, else You and this device', () => {
  assert.strictEqual(G.defaultGroup({}), 'you');
  assert.strictEqual(G.defaultGroup({ crit: {}, last: null }), 'you');
  assert.strictEqual(G.defaultGroup({ last: 'voice' }), 'voice');
  assert.strictEqual(G.defaultGroup({ last: 'no-such-group' }), 'you', 'a stale remembered group is ignored');
  assert.strictEqual(G.defaultGroup({ crit: { upkeep: true, safety: true }, last: 'voice' }), 'safety', 'the first red one in display order wins over the last opened');
  assert.strictEqual(G.defaultGroup({ crit: ['review'], last: 'voice' }), 'review');
  assert.strictEqual(G.STORE_KEY, 'hub-settings-group');
  const app = read('app.js');
  assert.ok(app.includes('STG.defaultGroup({ crit: {}, last })') && app.includes('localStorage.getItem(STG.STORE_KEY)') && app.includes('localStorage.setItem(STG.STORE_KEY, groupId)'));
  assert.doesNotMatch(app, /hub-settings-open/, 'the old per-group open state is gone');
  assert.match(app, /if \(stPicked \|\| stSearching \|\| !document\.getElementById\(`st-group-\$\{id\}`\)\) return;/, 'a red finding switches the pane only before they have chosen');
});

test('a search covers every group and shows the matches under their group names; a group title shows the whole group', () => {
  const entries = [
    { id: 'st-sb-section', text: 'agent sandboxes container' }, { id: 'st-lb-section', text: 'command lockbox' },
    { id: 'st-voice-section', text: 'voices and the microphone' }, { id: 'st-backups-section', text: 'nightly backup' },
    { id: 'st-moved-research', text: 'deep research reminder' },
  ];
  assert.deepStrictEqual(G.search('sandbox', entries).map((f) => [f.group, f.ids]), [['safety', ['st-sb-section']]]);
  assert.deepStrictEqual(G.search('  ', entries), []);
  const r = G.search('research', entries);
  assert.deepStrictEqual(r.map((f) => [f.group, f.ids]), [['tools', ['st-moved-research']]], 'a moved row is found under the group it moved to');
  const whole = G.search('upkeep', entries);
  assert.deepStrictEqual(whole.map((f) => [f.group, f.ids, f.whole]), [['upkeep', ['st-backups-section'], true]]);
  assert.deepStrictEqual(G.search('microphone', entries).map((f) => f.group), ['voice']);
  assert.deepStrictEqual(G.search('zzzz', entries), []);
  assert.deepStrictEqual(G.search('x', [{ id: 'st-sb-section', group: 'upkeep', text: 'x' }]).map((f) => f.group), ['upkeep'], 'the group the page really put it in wins');
  const app = read('app.js');
  assert.match(app, /input\.addEventListener\('input', \(\) => stSearch\(input\.value\)\);/);
  assert.match(app, /<input type="search" id="st-search"/);
  assert.match(app, /const found = STG\.search\(q, entries\);/);
  const html = read('index.html');
  assert.match(html, /#st-groups\.st-searching \.st-ghead \{ display: block; \}/, 'the group name shows over its matches');
  assert.match(html, /#st-groups\.st-searching \.st-more-body\[hidden\] \{ display: block; \}/, 'a match under More is shown');
});

// ---- a small fake DOM for stShowGroup / stSetMore / stReveal / openSettingsAt -------------------------------------------------
function fakePage() {
  const make = (cls, parent) => {
    const n = { cls: new Set(cls.split(' ')), parent, hidden: false, dataset: {}, attrs: {}, children: [], textContent: '' };
    n.setAttribute = (k, v) => { n.attrs[k] = String(v); }; n.removeAttribute = (k) => { delete n.attrs[k]; }; n.getAttribute = (k) => n.attrs[k];
    n.closest = (sel) => {
      const want = sel.trim().split(/\s+/).pop().replace(/^\./, '');
      for (let x = n; x; x = x.parent) if (x.cls.has(want)) return x;
      return null;
    };
    if (parent) parent.children.push(n);
    return n;
  };
  const root = make('st-groups', null);
  const groups = {}, btns = {};
  for (const id of ['review', 'you', 'money']) {
    const g = make('st-group', root); g.dataset.group = id; g.hidden = true; g.id = `st-group-${id}`;
    g.body = make('st-group-body', g); g.more = make('st-more-body', g); g.more.hidden = true; g.moreBtn = make('st-more-btn', g); g.moreBtn.dataset.label = 'More: Tuning'; g.moreBtn.attrs['aria-expanded'] = 'false';
    g.querySelector = (s) => (s === '.st-more-btn' ? g.moreBtn : s === '.st-more-body' ? g.more : null);
    groups[id] = g;
    const b = make('st-gbtn', root); b.dataset.group = id; btns[id] = b;
  }
  const secPlain = make('st-section', groups.review.body); secPlain.id = 'st-ready-section';
  const secMore = make('st-section', groups.money.more); secMore.id = 'st-tuning-section';
  const lookNew = make('st-row', make('st-section st-moved', groups.you.body)); lookNew.id = 'st-look-new';
  const doc = {
    getElementById: (id) => Object.values(groups).find((g) => g.id === id) || ({ 'st-ready-section': secPlain, 'st-tuning-section': secMore, 'st-look-new': lookNew })[id] || null,
    querySelectorAll: (s) => (s === '#st-groups .st-group' ? Object.values(groups) : s === '#st-groups .st-gbtn' ? Object.values(btns) : []),
  };
  return { doc, groups, btns, secPlain, secMore, lookNew };
}
function loadShell(doc) {
  const app = read('app.js');
  const a = app.indexOf('let stPhonePage = null;'), b = app.indexOf('// A critical finding in some group', a);
  assert.ok(a > 0 && b > a);
  const store = {};
  const make = new Function('document', 'STG', 'localStorage', 'stSearch', `let stCurGroup = null; let stPicked = false; let stSearching = false; ${app.slice(a, b)}; return { stShowGroup, stSetMore, stReveal, state: () => ({ cur: stCurGroup, picked: stPicked }) };`);
  return { api: make(doc, G, { setItem: (k, v) => { store[k] = v; }, getItem: (k) => store[k] || null }, () => {}), store };
}

test('showing a group hides the others, marks it current and remembers it only when they chose it', () => {
  const p = fakePage(); const { api, store } = loadShell(p.doc);
  api.stShowGroup('money', true);
  assert.deepStrictEqual(Object.fromEntries(Object.entries(p.groups).map(([k, g]) => [k, g.hidden])), { review: true, you: true, money: false });
  assert.strictEqual(p.btns.money.getAttribute('aria-current'), 'true'); assert.strictEqual(p.btns.you.getAttribute('aria-current'), undefined);
  assert.strictEqual(store['hub-settings-group'], 'money');
  api.stShowGroup('review', false);
  assert.strictEqual(store['hub-settings-group'], 'money', 'a link does not change which group is remembered');
  assert.strictEqual(api.state().cur, 'review');
});

test('openSettingsAt and the #settings-for door reveal the group that holds the section, and its More when it sits there', () => {
  const p = fakePage(); const { api } = loadShell(p.doc);
  api.stReveal(p.secPlain);
  assert.strictEqual(p.groups.review.hidden, false); assert.strictEqual(p.groups.money.hidden, true);
  assert.strictEqual(p.groups.review.moreBtn.getAttribute('aria-expanded'), 'false', 'More stays closed for a section outside it');
  api.stReveal(p.secMore);   // the Tuning section is under Models and money > More
  assert.strictEqual(p.groups.money.hidden, false); assert.strictEqual(p.groups.review.hidden, true);
  assert.strictEqual(p.groups.money.more.hidden, false); assert.strictEqual(p.groups.money.moreBtn.getAttribute('aria-expanded'), 'true');
  assert.strictEqual(p.groups.money.moreBtn.textContent, '▾ More: Tuning');
  api.stReveal(p.lookNew);   // a moved row: its small section is inside the group
  assert.strictEqual(p.groups.you.hidden, false);
  const app = read('app.js');
  assert.match(app, /async function openSettingsAt\(sectionId\) \{\s*await openSettings\(\);[\s\S]{0,120}stReveal\(s\);/);
  assert.ok(app.includes('open: (f) => stReveal(f.row)'), 'the door opens through the record anchor\'s row');
  assert.ok(app.includes('stReveal(el) {') || app.includes('function stReveal(el) {'));
});

test('the panel is grouped right after it is drawn: a list of eight group buttons, one open group with its More', () => {
  const app = read('app.js');
  assert.match(settingsSource(app), /stModal\(html\);\s*stTuningMount\(\); stNotifyAgentFill\(\);[^\n]*\n\s*groupSettings\(data\);/);
  assert.match(app, /<nav class="st-glist" aria-label="Settings groups"\$\{stSingle \? ' hidden' : ''\}>/, 'a member has one group and no list');
  assert.match(app, /<button type="button" class="st-gbtn" id="st-gbtn-\$\{g\.id\}" data-group="\$\{g\.id\}">/);
  assert.match(app, /class="st-group-sum" id="st-sum-\$\{g\.id\}"/, 'each group row keeps its summary slot');
  assert.match(app, /aria-current/);
  assert.match(app, /e\.key === 'ArrowDown'/);
  assert.ok(app.includes('<button type="button" class="st-more-btn" aria-expanded="false">▸ More</button>') && app.includes('`${open ? \'▾\' : \'▸\'} ${btn.dataset.label'), 'a closed More button, opening in place');
  assert.ok(!app.includes('stQuick') && !app.includes('id="st-quick-links"'), 'the Go to links are gone: doors replace them (P4-3)');
  // every summary the loaders set lands in a real group
  const homes = new Set(G.GROUPS.map((g) => g.id));
  // the Setup/Security/Health summaries no longer sit on the first group's row (P4-4B: it says "2 problems · 1 new feature"); 'review-checks' has no row
  const SUM = { status: { setup: 'review-checks', security: 'review-checks', health: 'review-checks', memory: 'upkeep', selfcheck: 'upkeep', updates: 'upkeep' }, security: 'safety', backups: 'upkeep', models: 'money', notify: 'you', agents: { sb: 'safety', appr: 'safety' }, tools: 'tools', money: 'money', voice: 'voice' };
  for (const h of Object.values(SUM).flatMap((v) => (typeof v === 'object' ? Object.values(v) : [v]))) assert.ok(homes.has(h) || h === 'review-checks', h);
  assert.ok(app.includes("const ST_SUM_HOME = { status: { setup: 'review-checks', security: 'review-checks', health: 'review-checks', memory: 'upkeep', selfcheck: 'upkeep', updates: 'upkeep' }, security: 'safety', backups: 'upkeep', models: 'money', notify: 'you', agents: { sb: 'safety', appr: 'safety' }, tools: 'tools', money: 'money', voice: 'voice' };"));
  // summaries still follow changes made inside Settings
  assert.match(app, /stSum\('agents', 'appr', `approval cards \$\{on \? 'on' : 'off'\}`\);/);
  assert.match(app, /if \(r\.ok\) stSum\('notify', 'q', stQuestionsText\(questionAfterMinutes\)\);/);
  assert.match(app, /el\.classList\.toggle\('st-sum-crit', allCrit\);/);   // the whole line is red only when every part of it is (p7 design fix; see ui-settings-p7-design.test.js)
  assert.match(app, /stSum\('status', 'setup', d\.critical \? `Setup: \$\{d\.critical\} to fix`[^\n]*, !!d\.critical\);\s*if \(d\.critical\) stOpenGroup\('status'\);/);
});

test('links into Settings open the group that holds their section', () => {
  const app = read('app.js');
  assert.match(app, /async function openPlanSettings\(\) \{\s*await openSettingsAt\('st-plan-section'\);/);
  assert.ok(app.includes(`openReviewAt('fix');`) && app.includes('data-rv="open-fix"'), 'the one banner opens For your review at Fix now');
  assert.ok(app.includes(`"openReviewAt('fix')" : 'openSettings()'`), 'the gear with something to fix opens For your review at Fix now');
  assert.ok(app.includes(`onclick="openSettingsAt('st-updates-section'); return false">Update settings`), 'the update card opens Upkeep');
  assert.deepStrictEqual(G.groupOfSection('st-updates-section'), { group: 'upkeep', more: false });
  assert.ok(read('index.html').includes(`id="spend-today" onclick="openSettingsAt('st-spend-section')"`), "today's spend chip");
  assert.deepStrictEqual(G.groupOfSection('st-plan-section'), { group: 'money', more: false });
  assert.deepStrictEqual(G.groupOfSection('st-spend-section'), { group: 'money', more: false });
  assert.deepStrictEqual(G.groupOfSection('st-voice-section'), { group: 'voice', more: false });
  assert.deepStrictEqual(G.groupOfSection('st-modules-section'), { group: 'tools', more: false });
  assert.deepStrictEqual(G.groupOfSection('st-ready-section'), { group: 'review', more: true });
});

test('the module is served and loaded before app.js; the two panes fit 1024 px and the phone frame keeps one column', () => {
  const { ALIASES } = require('../lib/static-files');
  assert.strictEqual(ALIASES.get('ui-settings-groups.js'), 'lib/ui-settings-groups.js');
  const idx = read('index.html');
  const tag = '<script src="/ui-settings-groups.js"></script>';
  assert.ok(idx.includes(tag) && idx.indexOf(tag) < idx.indexOf('<script src="app.js">'));
  assert.match(idx, /\.st-panes \{ display: grid; grid-template-columns: 220px minmax\(0, 1fr\);/);
  assert.match(idx, /\.st-modal:has\(\.st-panes\) \{ max-width: 1040px; width: min\(96vw, 1040px\); \}/);
  assert.match(idx, /html\.mm-settings-only \.st-panes \{ display: block; \}/);
  assert.match(idx, /\.st-more-btn \{[^}]*color: var\(--accent\)/);
  assert.match(idx, /\.st-group-sum\.st-sum-crit \{ color: var\(--error\); font-weight: 600; \}/);
  assert.doesNotMatch(idx, /details\.st-group/, 'the old accordion is gone');
});
