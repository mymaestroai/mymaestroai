'use strict';
// P4-6b: Simple's settings dialogs carry the report's four groups: For your review (admins), You and this device, Voice and calls,
// Models and money (admins), then More settings. The review line, the two buttons and the group door (#settings-group=review|money).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const mob = fs.readFileSync(path.join(ROOT, 'mobile.js'), 'utf8');
const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const mhtml = fs.readFileSync(path.join(ROOT, 'mobile.html'), 'utf8');
const RV = require(path.join(ROOT, 'lib/ui-review.js'));

function fnSrc(src, head) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, head);
  let i = src.indexOf('{', at + head.length - 1), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}

function desktopHtml(isAdmin) {
  const src = fnSrc(app, 'function openSimpleSettings() {');
  let html = '';
  const stub = () => ({ set textContent(v) {}, style: {}, focus() {}, classList: { toggle() {} }, querySelectorAll: () => [] });
  const el = { set innerHTML(h) { html = h; }, get innerHTML() { return html; }, querySelector: stub, querySelectorAll: () => [], addEventListener() {}, className: '', id: '', isConnected: true };
  const doc = { createElement: () => el, body: { appendChild() {} }, addEventListener() {}, removeEventListener() {} };
  new Function('document', 'window', 'simpleCloseSettings', 'simpleStyleLabel', 'lookPickerBuild', 'simpleReviewText', 'reviewRefresh', `let simpleLookOff = null; ${src}; openSimpleSettings();`)(doc, { hubMe: { isAdmin, user: { name: 'Sam' } } }, () => {}, () => '', () => {}, () => '', () => Promise.resolve());
  return html;
}
const heads = (html) => [...html.matchAll(/<h3 class="sm-gh"[^>]*>([^<]+)<\/h3>/g)].map((m) => m[1]);

test('Simple desktop: an admin sees four groups then More settings; a member sees two groups then More settings', () => {
  assert.deepStrictEqual(heads(desktopHtml(true)), ['For your review', 'You and this device', 'Voice and calls', 'Models and money', 'More settings']);
  assert.deepStrictEqual(heads(desktopHtml(false)), ['You and this device', 'Voice and calls', 'More settings']);
  const member = desktopHtml(false);
  for (const k of ['data-act="review"', 'data-act="money"', 'sm-review-line']) assert.ok(!member.includes(k), `a member has no ${k}`);
});

test('Simple desktop: Switch to Advanced and Sign out end the You group; the Notifications line sits in it; nothing is lost', () => {
  for (const admin of [true, false]) {
    const h = desktopHtml(admin);
    const at = (s) => h.indexOf(s);
    assert.ok(at('You and this device') < at('Appearance') && at('Appearance') < at('Interface style') && at('Interface style') < at('>Name<'), 'appearance, style, name');
    assert.ok(at('>Name<') < at("Each agent's notifications are on its card") && at("Each agent's notifications") < at('data-act="advanced"'), 'the Notifications pointer line is in the You group');
    assert.ok(at('data-act="advanced"') < at('data-act="signout"') && at('data-act="signout"') < at('Voice and calls'), 'Switch to Advanced and Sign out close the You group');
    assert.ok(!/>Notifications</.test(h) && !/>Account</.test(h), 'the old Notifications and Account headings are gone');
    assert.ok(at('Voice and calls') < at('data-act="settings"'), 'More settings after the groups');
    assert.ok(h.includes('data-act="voice"') === admin, 'the voice row for an admin; a member reads the hint');
  }
});

test('Simple desktop: the review line and Models and money line, with a button each', () => {
  const h = desktopHtml(true);
  assert.match(h, /id="sm-review-line"[^>]*>Checking…<\/span><button type="button" class="sm-plain" data-act="review"><div><b>Review<\/b>/);
  assert.match(h, /id="sm-money-line">Subscriptions, keys and spending<\/span><button type="button" class="sm-plain" data-act="money"><div><b>Open<\/b>/);
  const src = fnSrc(app, 'function openSimpleSettings() {');
  assert.match(src, /act === 'review'\) \{ simpleCloseSettings\(\); openSettingsGroup\('review'\); \}/);
  assert.match(src, /act === 'money'\) \{ simpleCloseSettings\(\); openSettingsGroup\('money'\); \}/);
  assert.match(fnSrc(app, 'async function openSettingsGroup(groupId) {'), /await openSettings\(\);\s+stShowGroup\(groupId, false\);/);
});

test('Simple desktop: the review line says what the review build says, warning colour only for problems', () => {
  const text = new Function('window', `${fnSrc(app, 'function simpleReviewText(r) {')}; return simpleReviewText;`)({ hubReview: RV });
  assert.equal(text(null), 'Checking…');
  const none = RV.build({ now: 1000 });
  assert.equal(none.count, 0);
  assert.equal(text(none), 'Nothing to fix');
  const some = { problems: [{ id: 'a' }, { id: 'b' }], features: [{ id: 'f', snoozed: false }], suggestions: [], count: 3 };
  assert.equal(text(some), '3 to fix · 1 new feature');
  // only suggestions and new features (no red item): "Nothing to fix" first, never "Nothing needs your review"
  const calm = { problems: [{ id: 's' }], features: [{ id: 'f', snoozed: false }], suggestions: [{ id: 's' }], count: 0 };
  assert.equal(text(calm), 'Nothing to fix · 1 suggestion · 1 new feature');
  const src = fnSrc(app, 'function openSimpleSettings() {');
  assert.match(src, /classList\.toggle\('sm-warn', !!\(r && r\.count > 0\)\)/, 'warning colour follows the red count only');
  assert.ok(!fnSrc(app, 'function simpleReviewText(r) {').includes('Nothing needs your review'));
  assert.match(idx, /\.sm-lab\.sm-warn \{ color: var\(--status-warn\); \}/);
});

test('Simple phone: the same groups, a review line, Review and Open buttons that open Settings at the group', () => {
  const src = fnSrc(mob, 'function simpleSettingsOpen() {');
  const hs = [...src.matchAll(/<h4 class="ss-gh" id="([^"]+)">([^<]+)<\/h4>/g)].map((m) => m[2]);
  assert.deepStrictEqual(hs, ['For your review', 'You and this device', 'Voice and calls', 'Models and money', 'More settings']);
  assert.match(src, /hubMe\.isAdmin === true \? '<h4 class="ss-gh" id="ss-g-review">For your review<\/h4>'/);
  assert.match(src, /hubMe\.isAdmin === true \? '<h4 class="ss-gh" id="ss-g-money">Models and money<\/h4>'/);
  assert.ok(src.indexOf('id="ss-notes-sec"') > src.indexOf('ss-val') && src.indexOf('id="ss-notes-sec"') < src.indexOf('id="ss-adv"') && src.indexOf('id="ss-out"') < src.indexOf('ss-g-voice'), 'notifications line, Switch to Advanced, Sign out in the You group');
  assert.match(src, /\$\('ss-review'\)\?\.addEventListener\('click', \(\) => \{ d\.close\(\); settingsSheetOpen\('', 'review'\); \}\)/);
  assert.match(src, /\$\('ss-money'\)\?\.addEventListener\('click', \(\) => \{ d\.close\(\); settingsSheetOpen\('', 'money'\); \}\)/);
  assert.ok(!/Nothing needs your review/.test(src), 'the line is the review build summary, not a second wording');
  assert.match(src, /summaryText\(r\)/);
  assert.match(src, /classList\.toggle\('ss-warn', !!\(r && r\.count > 0\)\)/, 'red only');
  assert.match(mhtml, /html\.mm-simple \.ss-rhint\.ss-warn \{ color: var\(--warning\); \}/);
});

test('the group door: the sheet puts #settings-group=review|money on the frame; the frame shows that group (admins)', () => {
  const sheet = fnSrc(mob, 'function settingsSheetOpen(doorId, groupId) {');
  assert.match(sheet, /\(review\|money\)/);
  assert.match(sheet, /group: groupId/);
  assert.match(fnSrc(mob, 'function settingsSheetLoad() {'), /s\.group \? '#settings-group=' \+ s\.group/);
  const start = fnSrc(app, 'async function settingsOnlyStart() {');
  assert.match(start, /#settings-group=\(review\|money\)\$/);
  assert.match(start, /isHubAdmin\(\)/);
  assert.match(start, /stShowGroup\(gm\[1\], false\)/);
  assert.ok(start.indexOf('await openSettings();') < start.indexOf('stShowGroup(gm[1], false)'), 'the dialog is open first');
});
