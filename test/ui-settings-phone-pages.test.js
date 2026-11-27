'use strict';
// P4-5a: the phone's Settings in eight pages (a list of groups, then one group as a page, Back popping a page before it
// closes), and Simple's settings in four headings with "More settings" last.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js'), mob = read('mobile.js'), idx = read('index.html'), mhtml = read('mobile.html');
function fnSrc(src, head) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, head);
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}

// A small page: #st-groups with a title span, the modal around it, and the group buttons.
function pageHarness(settingsOnly) {
  const els = {};
  const mk = (id) => (els[id] = { id, dataset: {}, textContent: '', scrollTop: 5, focused: false, focus() { this.focused = true; } });
  const wrap = mk('st-groups'), modal = mk('modal'), title = mk('title');
  wrap.closest = (sel) => (sel === '.st-modal' ? modal : null);
  wrap.querySelector = (sel) => (sel === '.st-phone-title' ? title : null);
  mk('st-gbtn-money'); mk('st-gbtn-voice');
  const doc = { documentElement: { classList: { contains: (c) => settingsOnly && c === 'mm-settings-only' } }, getElementById: (id) => els[id] || null };
  const STG = { GROUPS: [{ id: 'money', title: 'Models and money' }, { id: 'voice', title: 'Voice and calls' }] };
  const src = ['function stPhoneOn()', 'function stPhoneList()', 'function stPhoneGo(groupId)', 'function stPhoneBack()'].map((h) => fnSrc(app, h)).join('\n');
  const api = new Function('document', 'window', 'STG', `let stPhonePage = null;\n${src}\nreturn { stPhoneOn, stPhoneList, stPhoneGo, stPhoneBack, page: () => stPhonePage };`)(doc, { matchMedia: () => ({ matches: false }) }, STG);
  return { api, els, wrap, modal, title };
}

test('phone pages: the frame starts on the list, a group opens as a page with its title, Back returns to the list', () => {
  const h = pageHarness(true);
  assert.strictEqual(h.api.stPhoneOn(), true);
  h.api.stPhoneList();
  assert.strictEqual(h.wrap.dataset.page, 'list');
  assert.strictEqual(h.api.page(), null);
  assert.strictEqual(h.api.stPhoneBack(), false, 'Back on the list is not handled here: the caller closes Settings');
  h.api.stPhoneGo('voice');
  assert.strictEqual(h.wrap.dataset.page, 'group');
  assert.strictEqual(h.api.page(), 'voice');
  assert.strictEqual(h.title.textContent, 'Voice and calls');
  assert.strictEqual(h.modal.scrollTop, 0);
  assert.strictEqual(h.api.stPhoneBack(), true);
  assert.strictEqual(h.wrap.dataset.page, 'list');
  assert.strictEqual(h.els['st-gbtn-voice'].focused, true, 'focus returns to the row that was opened');
  assert.strictEqual(h.api.stPhoneBack(), false, 'the second Back finds the list');
});

test('phone pages: a wide window outside the frame has no pages at all (the desktop is unchanged)', () => {
  const h = pageHarness(false);
  assert.strictEqual(h.api.stPhoneOn(), false);
  h.api.stPhoneList();
  assert.strictEqual(h.wrap.dataset.page, undefined);
  h.api.stPhoneGo('money');
  assert.strictEqual(h.wrap.dataset.page, undefined);
  assert.strictEqual(h.api.stPhoneBack(), false);
});

test('phone pages: stShowGroup opens the page (doors, links, taps); the pane\'s own switches keep the list', () => {
  const show = fnSrc(app, 'function stShowGroup(groupId, remember, keepPage)');
  assert.match(show, /if \(!keepPage\) stPhoneGo\(groupId\);/);
  assert.match(fnSrc(app, 'function stOpenGroup(groupId)'), /stShowGroup\(STG\.defaultGroup\(\{ crit, last: null \}\), false, true\)/);
  assert.match(fnSrc(app, 'function stReveal(el)'), /stShowGroup\(g\.dataset\.group, false\);/, 'doors and openSettingsAt open the group page');
  assert.match(fnSrc(app, 'function stSearch(q)'), /stShowGroup\(stCurGroup \|\| STG\.DEFAULT_GROUP, false, true\)/, 'clearing a search goes back to the list');
  const group = fnSrc(app, 'function groupSettings(data)');
  assert.match(group, /stShowGroup\(STG\.defaultGroup\(\{ crit: \{\}, last \}\), false, true\);\n\s+stPhoneList\(\);/, 'the phone starts on the list');
  assert.match(group, /<button type="button" class="st-phone-back" id="st-phone-back">‹ Settings<\/button><span class="st-phone-title">/);
  assert.match(group, /stShowGroup\(b\.dataset\.group, true\)/, 'tapping a row opens its page');
  assert.match(group, /if \(!stSearching \|\| !stPhoneOn\(\)\) return;[\s\S]*stShowGroup\(id, false\);/, 'tapping a search match opens its group page');
});

test('phone pages: the frame answers mm-settings-back with popped, or as a close request on the list; the old close still works', () => {
  const msg = fnSrc(app, 'function settingsOnlyMessage(e)');
  assert.match(msg, /e\.source !== window\.parent \|\| e\.origin !== location\.origin/, 'same origin, that window');
  assert.match(msg, /type !== 'mm-settings-close' && type !== 'mm-settings-back'\) return;/);
  assert.match(msg, /stPhoneBack\(\)\) \{ settingsOnlyPost\('mm-settings-popped'\); return; \}/);
  assert.ok(msg.indexOf("settingsOnlyPost('mm-settings-popped')") < msg.indexOf('dialogGuard.requestClose'), 'the pop comes before the close request');
  assert.match(msg, /bt === document\.getElementById\('st-overlay'\)/, 'a box open over Settings is closed first, not the page');
});

test('phone pages: the sheet\'s Back posts mm-settings-back (type only), popped counts as the frame answering', () => {
  assert.match(mob, /el\.__dialogClose = \(\) => settingsSheetRequestClose\(true\);/);
  const rc = fnSrc(mob, 'function settingsSheetRequestClose(back)');
  assert.match(rc, /postMessage\(\{ type: back === true \? 'mm-settings-back' : 'mm-settings-close' \}, location\.origin\)/);
  assert.match(fnSrc(mob, 'function settingsSheetMessage(e)'), /type === 'mm-settings-popped'\) \{ clearTimeout\(s\.closeTimer\)/);
});

test('phone pages: CSS shows full-width rows of at least 56 px on the list and a "‹ Settings" header on a page', () => {
  assert.match(idx, /#st-groups\[data-page\] \.st-gbtn \{ min-height: 56px;/);
  assert.match(idx, /#st-groups\[data-page="list"\] \.st-gpane, #st-groups\[data-page="list"\]\.st-searching \.st-glist \{ display: none; \}/);
  assert.match(idx, /#st-groups\[data-page="group"\] \.st-phone-head \{ display: flex;/);
  assert.match(idx, /\.st-phone-head \{ display: none; \}/, 'hidden unless a page is open');
  const css = idx.slice(idx.indexOf('.st-phone-head { display: none; }'), idx.indexOf('.st-section.st-match > h4'));
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css) && !/font-family/.test(css), 'no colour literals or font stacks');
});

// Simple: four headings, More settings last, every control still there
test('Simple (desktop): four headings, every old control kept, More settings is the last control and only for admins', () => {
  const src = fnSrc(app, 'function openSimpleSettings() {');
  const heads = [...src.matchAll(/<h3 class="sm-gh"[^>]*>([^<]+)<\/h3>/g)].map((m) => m[1]);
  assert.deepStrictEqual(heads, ['You and this device', 'Voice and calls', 'Notifications', 'Account']);
  for (const k of ['sm-seg', 'data-theme="light"', 'data-theme="auto"', 'sm-style', 'sm-name', 'data-act="advanced"', 'Switch to Advanced', 'data-act="signout"', 'Sign out', 'data-act="settings"']) assert.ok(src.includes(k), k);
  assert.ok(src.indexOf('You and this device') < src.indexOf('sm-seg') && src.indexOf('sm-name') < src.indexOf('Voice and calls'), 'appearance, style and name sit under the first heading');
  assert.ok(src.indexOf('data-act="signout"') < src.indexOf('data-act="settings"'), 'More settings is last');
  assert.match(src, /\(me\.isAdmin === false \? '' : '<div class="sm-set"><button type="button" class="sm-plain" data-act="settings"><div><b>More settings<\/b>/);
  assert.ok(!src.includes('All settings'));
  assert.match(src, /dataset\.act === 'voice'\) \{ simpleCloseSettings\(\); openVoiceSettings\(\); \}/);
});

test('Simple (phone): four headings, every old control kept, deep research under Notifications, More settings last and admin-only', () => {
  const src = fnSrc(mob, 'function simpleSettingsOpen() {');
  const heads = [...src.matchAll(/<h4 class="ss-gh" id="[^"]+">([^<]+)<\/h4>/g)].map((m) => m[1]);
  assert.deepStrictEqual(heads, ['You and this device', 'Voice and calls', 'Notifications', 'Account']);
  for (const k of ['ss-seg', 'ss-style-sec', 'ss-val', 'id="ss-adv"', 'id="ss-out"', 'id="ss-all"', 'Switch to Advanced', 'Sign out', "$('ss-adv')", "$('ss-out')", "$('ss-all')"]) assert.ok(src.includes(k), k);
  assert.ok(src.indexOf('id="ss-out"') < src.indexOf('id="ss-all"') && src.indexOf('id="ss-all"') < src.indexOf('ss-close'), 'More settings is the last row');
  assert.ok(!src.includes('All settings'));
  assert.match(fnSrc(mob, 'function researchSimplePaint(d)'), /d\.querySelector\('#ss-notes-sec'\) \|\| d\.querySelector\('#ss-style-sec'\)/);
  assert.match(mhtml, /html\.mm-simple \.ss-gh \{/);
  assert.match(idx, /html\.mm-simple \.simple-modal \.sm-gh \{/);
});
