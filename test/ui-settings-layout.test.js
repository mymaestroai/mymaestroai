'use strict';
// P4-7 coder B: layout and wording of Settings (Easel's pass): the group list without the fixed sub-line, a 200 px label column,
// Models and money in the order subscriptions, spend and caps, keys, the phone's group page, "I'll ask again on <date>.", "your Maestro"
// for "the hub", and a search that lists a matching group first and only the matching rows elsewhere.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/ui-settings-groups.js');
const R = require('../lib/ui-review.js');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js'), idx = read('index.html');
function fnSrc(src, head) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, head);
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}
const BAD_CHARS = new RegExp(`[${String.fromCharCode(0xFE0F, 0x200B, 0x200C, 0x200D, 0x2060)}]`);

test('1. the group list shows a title and the live summary only: no fixed sub-line, and the summary wraps', () => {
  const draw = app.slice(app.indexOf('function groupSettings(data) {'), app.indexOf('const body = (id) => wrap.querySelector'));
  assert.ok(draw.includes('class="st-group-title"') && draw.includes('class="st-group-sum" id="st-sum-${g.id}"'), 'title and summary stay');
  assert.ok(!draw.includes('st-gsub') && !draw.includes('${esc(g.sub)}'), 'the fixed sub-line under each title is gone');
  assert.ok(!idx.includes('.st-gsub'), 'and its CSS');
  const sum = idx.match(/\.st-group-sum \{([^}]*)\}/);
  assert.ok(sum, 'the summary rule');
  assert.match(sum[1], /white-space:\s*normal/, 'the summary wraps');
  assert.doesNotMatch(sum[1], /text-overflow|nowrap|overflow:\s*hidden/, 'nothing cuts it to "pus…"');
  assert.ok(G.GROUPS.every((g) => g.title && g.icon), 'every group still has a title and an icon');
});

test('2. a row label in the two-pane dialog is about 200 px (the inline 150 px does not win) and the phone keeps its column', () => {
  const m = idx.match(/@media \(min-width: 721px\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'a wide-window rule block');
  assert.match(m[1], /\.st-modal:has\(\.st-panes\) \.st-row[^{]*> label[^{]*\{ flex: 0 0 200px !important;/, 'labels get a 200 px column, over the inline flex-basis');
  assert.match(m[1], /html:not\(\.mm-settings-only\)/, 'not in the phone frame (its labels stack above the control)');
  assert.match(m[1], /:not\(:has\(input\)\)/, 'a label that wraps a checkbox keeps its own width');
  assert.match(m[1], /\.st-hint \{ margin-left: 208px; \}/, 'hints line up under the controls');
  assert.match(m[1], /\.st-row > \.st-info \{[^}]*align-self: center/, 'the ⓘ stays on its label\'s line');
  assert.match(idx, /html\.mm-settings-only \.st-row > label \{ flex: 1 0 100% !important;/, 'the phone rule is untouched');
});

test('3. Models and money: subscriptions and plan usage, spend and caps, then the keys; local server addresses go under More', () => {
  const money = G.byId('money');
  const at = (id) => money.sections.indexOf(id);
  assert.ok(at('st-subs-section') >= 0 && at('st-subs-section') < at('st-plan-section') && at('st-plan-section') < at('st-spend-section'), 'subscriptions, plan usage, spend');
  assert.ok(at('st-spend-section') < at('st-prov-section') && at('st-prov-section') < at('st-or-section'), 'spend, then the provider keys, then OpenRouter');
  for (const p of ['lmstudio', 'ollama', 'omlx']) {
    const to = G.groupOfRow(`#st-url-${p}`);
    assert.ok(to && to.group === 'money' && to.more === true, `${p}: its server address sits under More in Models and money`);
    assert.ok(app.includes('id="st-url-${p.id}"'), 'the url inputs keep their ids');
  }
  assert.deepStrictEqual(G.groupOfSection(G.movedId(G.ROWS.find((r) => r.selector === '#st-url-ollama'))), { group: 'money', more: true });
  // the monthly cap rows come with Spend: the slot is put just above it
  const slots = fnSrc(app, 'function groupSettings(data) {');
  assert.match(slots, /gid === 'money' \? b\.querySelector\('#st-spend-section'\) : null/);
});

// ---- 4. the phone group page ---------------------------------------------------------------------------------------------
test('4. the phone group page hides the dialog title and sentence and shows Save only where the shared Save has something to write', () => {
  assert.match(idx, /\.st-modal:has\(#st-groups\[data-page="group"\]\) > h3, \.st-modal:has\(#st-groups\[data-page="group"\]\) > \.st-sub \{ display: none; \}/);
  assert.match(idx, /\.st-modal\[data-save-here="no"\] \.st-actions \.st-save-main \{ display: none; \}/);
  assert.match(idx, /\.st-phone-title::before \{ content: "\\00b7\\00a0";/, '"‹ Settings · Group title"');
  assert.ok(app.includes('<button class="st-btn st-save-main" onclick="saveSettings()">Save</button>'), 'the shared Save is findable');
  assert.deepStrictEqual(G.SHARED_SAVE_GROUPS.slice().sort(), ['agents', 'money'], 'provider keys and limits (money), workers at once (agents)');
  for (const g of G.GROUPS) assert.strictEqual(G.usesSharedSave(g.id), g.id === 'money' || g.id === 'agents', g.id);
  // the fields the shared Save writes really sit in those groups
  assert.ok(G.groupOfSection('st-prov-section').group === 'money' && G.groupOfRow('#st-maxTokens').group === 'money' && G.groupOfSection('st-workers-section').group === 'agents');
  const run = (page, searching, phone, single) => {
    const modal = { dataset: {} }, wrap = { closest: () => modal };
    const f = new Function('document', 'window', 'STG', 'pageId', 'searching', 'single',
      `let stPhonePage = pageId; let stSearching = searching; let stSingle = single; ${fnSrc(app, 'function stPhoneOn()')}\n${fnSrc(app, 'function stPhoneSaveMark()')}\nstPhoneSaveMark();`);
    f({ documentElement: { classList: { contains: () => phone } }, getElementById: () => wrap }, { matchMedia: () => ({ matches: phone }) }, G, page, searching, single);
    return modal.dataset.saveHere;
  };
  assert.strictEqual(run('money', false, true, false), 'yes');
  assert.strictEqual(run('agents', false, true, false), 'yes');
  assert.strictEqual(run('voice', false, true, false), 'no');
  assert.strictEqual(run('you', false, true, false), 'no');
  assert.strictEqual(run(null, false, true, false), 'no', 'the list of groups has no Save');
  assert.strictEqual(run(null, true, true, false), 'yes', 'a search may show any group');
  assert.strictEqual(run('voice', false, false, false), 'yes', 'the desktop always has Save');
  assert.strictEqual(run('you', false, true, true), 'yes', 'a member\'s one group keeps it');
  assert.match(fnSrc(app, 'function stPhoneGo(groupId)'), /stPhoneSaveMark\(\);/);
  assert.match(fnSrc(app, 'function stPhoneList()'), /stPhoneSaveMark\(\);/);
});

test('5. a snoozed feature keeps Turn on and Leave off; one wording: "I\'ll ask again on <date>."', () => {
  const at = Date.UTC(2026, 11, 3, 12);
  assert.strictEqual(R.decisionLine('snooze', new Date(at).toISOString(), 'en-US'), "I'll ask again on December 3.");
  assert.strictEqual(R.decisionLine('snooze', undefined, 'en-US'), "I'll ask again in a week.");
  assert.strictEqual(R.askedAgainLine(at, 'en-US'), "I'll ask again on December 3.");
  assert.ok(!/We'll ask again|Asked again on/.test(read('lib/ui-review.js').replace(/\/\*[\s\S]*?\*\//, '')), 'no other wording is left in the module');
  // no other module words it
  for (const f of ['app.js', 'mobile.js', 'lib/behaviour-changes.js']) assert.ok(!/ask again next week|We'll ask again/.test(read(f)), f);
  const row = app.slice(app.indexOf('<div class="rv-row rv-feature"'), app.indexOf('<div class="rv-row rv-feature"') + 900);
  assert.ok(row.includes("d && d.decision !== 'snooze' ? ''"), 'a snoozed row still has its buttons');
  assert.ok(row.includes("[['on', 'Turn on'], ['off', 'Leave off'], ...(d || f.snoozedUntil ? [] : [['snooze', 'Ask me in a week']])]"), 'Turn on / Leave off stay; the snooze button goes once asked');
  assert.match(app, /reviewDecided\[id\] = \{ title: \(f && f\.title\) \|\| id, decision,/, 'the choice is kept so the row knows it was snoozed');
});

test('6. "the hub" on screen becomes "your Maestro" in exactly the three named places', () => {
  assert.ok(app.includes('A key typed into <code>.env</code> moves here when your Maestro starts.'));
  assert.ok(app.includes('Once a day your Maestro checks GitHub for a new version'));
  assert.ok(!app.includes('moves here when the hub starts') && !app.includes('Once a day the hub checks GitHub'));
  const sec = read('lib/security-check.js');
  assert.ok(sec.includes('"Your Maestro\'s user can become root"') && !sec.includes('"The hub\'s user can become root"'));
});

// ---- 7. search -------------------------------------------------------------------------------------------------------------
test('7. search: a group whose title matches comes first; the rest show only matching rows', () => {
  const entries = [
    { id: 'st-notify-section', text: 'notifications spoken voice alert' }, { id: 'st-voice-section', text: 'voices microphone' },
    { id: 'st-backups-section', text: 'nightly backup' }, { id: 'st-looks-section', text: 'voice size' },
  ];
  const r = G.search('voice', entries);
  assert.deepStrictEqual(r.map((f) => f.group), ['voice', 'you'], 'Voice and calls first although You and this device comes earlier in the list');
  assert.strictEqual(r[0].whole, true);
  assert.strictEqual(r[1].whole, false);
  assert.deepStrictEqual(r[1].ids, ['st-notify-section', 'st-looks-section']);
  // rows of a hit section
  const units = [{ text: 'Spoken alerts' }, { text: 'Play a sound for each reply', follows: true }, { text: 'Voice for answers' }, { text: 'Which voice speaks', follows: true }, { text: 'Quiet hours' }, { text: 'From 22:00', follows: true }];
  assert.deepStrictEqual(G.searchRows('voice', units), [false, false, true, true, false, false], 'only the matching row and its hint');
  assert.deepStrictEqual(G.searchRows('sound', units), [true, true, false, false, false, false], 'a matching hint keeps its row');
  assert.deepStrictEqual(G.searchRows('zzz', units), units.map(() => true), 'no row of its own: nothing is hidden for no reason');
  assert.deepStrictEqual(G.searchRows('', []), []);
  // the page wiring
  const body = fnSrc(app, 'function stSearch(q)');
  assert.ok(body.includes('STG.searchRows(q,') && body.includes("u.classList.add('st-row-off')") && body.includes('ge.style.order = String(i)'));
  assert.ok(body.includes("for (const r of document.querySelectorAll('#st-groups .st-row-off')) r.classList.remove('st-row-off');"), 'clearing brings the rows back');
  assert.match(idx, /#st-groups\.st-searching \.st-gpane \{ display: flex; flex-direction: column; \}/);
  assert.match(idx, /#st-groups \.st-row-off \{ display: none !important; \}/);
  assert.match(idx, /#st-groups\[data-page="list"\]\.st-searching \.st-gpane \{ display: flex; \}/);
});

test('the new CSS and text use no colour literals, font stacks or invisible characters', () => {
  const css = idx.slice(idx.indexOf('/* The label column of a row in the two-pane dialog'), idx.indexOf('/* The phone (the Settings frame'));
  assert.ok(css.length > 300);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, 'no colour literals');
  assert.doesNotMatch(css, /font-family/, 'no font stacks');
  for (const [n, s] of [['index.html', idx], ['app.js', app], ['lib/ui-settings-groups.js', read('lib/ui-settings-groups.js')], ['this file', read('test/ui-settings-layout.test.js')]]) {
    if (n === 'index.html' || n === 'app.js') continue;   // those carry older characters of their own; the added lines are checked below
    assert.doesNotMatch(s, BAD_CHARS, n);
  }
  for (const line of [...idx.split('\n'), ...app.split('\n')]) if (/st-save-main|stPhoneSaveMark|st-row-off|data-save-here|local-servers/.test(line)) assert.doesNotMatch(line, BAD_CHARS, line.slice(0, 80));
});
