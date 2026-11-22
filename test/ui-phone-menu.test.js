'use strict';
// The phone menu order: Look on top, everyday items, Advanced (folded) in groups, Sign out last.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const html = read('mobile.html');
const js = read('mobile.js');
const menu = html.slice(html.indexOf('<div id="menu">'), html.indexOf('<div id="toast">'));
const at = (needle) => { const i = menu.indexOf(needle); assert.ok(i >= 0, 'missing ' + needle); return i; };
const idAt = (id) => at('id="' + id + '"');

// menu split (gear = what you set, ⋯ = what you do): Interface style and Notifications left the top list for the "This device" group
// (right after Settings, before Advanced), which also takes Send a test notification, Fold and Active at the top from their old groups.
const TOP = ['menu-simple', 'menu-files', 'menu-reload', 'menu-profile', 'menu-settings'];
const DEVICE = ['menu-look', 'menu-look-pick', 'menu-notify', 'menu-notify-test', 'menu-fold', 'menu-active-top'];
const GROUPS = {
  chat: ['menu-agentwork', 'menu-recall', 'menu-copy', 'menu-notify-agent', 'menu-compact', 'menu-clear'],
  tools: ['menu-activity', 'menu-workers', 'menu-memory', 'menu-subs', 'menu-recordings', 'menu-tiger', 'menu-voice', 'menu-wallet'],
  notify: ['menu-notify-prefs'],
  account: ['menu-security', 'menu-help', 'menu-about'],
  admin: ['menu-users', 'menu-connectors', 'menu-remote', 'menu-update', 'menu-restart'],
  views: ['HREF:/?desktop=once', 'use-full-site'],
};
const pos = (k) => (k.startsWith('HREF:') ? at('href="' + k.slice(5) + '"') : idAt(k));

test('notices come first, then the top group in order, then Advanced, then Sign out last', () => {
  assert.ok(idAt('menu-credit') < idAt('menu-2fa-note'));
  assert.ok(idAt('menu-2fa-note') < idAt('menu-simple'));
  let prev = -1;
  for (const id of TOP) { const p = idAt(id); assert.ok(p > prev, id + ' out of order'); prev = p; }
  // menu split: then the This device group in order, then Advanced
  const dg = at('data-group="device"');
  assert.ok(dg > idAt('menu-settings') && dg < idAt('menu-adv-toggle'), 'This device sits after Settings and before Advanced');
  assert.match(menu, /<div class="menu-group-title" id="menu-gt-device">This device<\/div>/);
  assert.ok(menu.includes('data-group="device" role="group" aria-labelledby="menu-gt-device"'));
  prev = dg;
  for (const id of DEVICE) { const p = idAt(id); assert.ok(p > prev && p < idAt('menu-adv-toggle'), id + ' out of order in This device'); prev = p; }
  assert.ok(idAt('menu-fold') > 0 && /id="menu-fold" class="chat-only"/.test(menu), 'Fold is still chat-only');
  assert.ok(idAt('menu-adv-toggle') > idAt('menu-active-top') && idAt('menu-adv') > idAt('menu-adv-toggle'));
  assert.ok(idAt('menu-signout') > at('id="use-full-site"'));
  assert.ok(idAt('menu-signout') > menu.lastIndexOf('menu-group'));
});

test('Advanced holds every other item, in its group and order', () => {
  const signout = idAt('menu-signout');
  const groups = Object.keys(GROUPS);
  let prevGroup = idAt('menu-adv');
  for (const g of groups) {
    const gs = at('data-group="' + g + '"');
    assert.ok(gs > prevGroup, g + ' group order');
    const next = groups[groups.indexOf(g) + 1];
    const ge = next ? at('data-group="' + next + '"') : signout;
    let prev = gs;
    for (const k of GROUPS[g]) { const p = pos(k); assert.ok(p > prev && p < ge, k + ' in ' + g + ' in order'); prev = p; }
    prevGroup = gs;
  }
  for (const t of ['This chat', 'Tools', 'Your notifications', 'Account and help', 'Admin', 'Other views']) assert.match(menu, new RegExp('<div class="menu-group-title" id="menu-gt-[a-z]+">' + t + '</div>'), t);
  for (const g of ['chat', 'tools', 'notify', 'account', 'admin', 'views']) assert.ok(menu.includes(`data-group="${g}" role="group" aria-labelledby="menu-gt-${g}"`), g);   // named groups for screen readers (review r1)
});

test('all 36 inventory items appear exactly once, plus the new ones', () => {
  const ids = [...TOP.filter(i => i !== 'menu-settings'), ...DEVICE.filter(i => i !== 'menu-look' && i !== 'menu-look-pick'), 'menu-credit', 'menu-2fa-note', 'menu-signout', ...Object.values(GROUPS).flat().filter(k => !k.startsWith('HREF:'))];
  assert.strictEqual(ids.length + 1, 36);   // the "Open full UI" link has no id: counted by its href
  for (const id of ids) assert.strictEqual(menu.split('id="' + id + '"').length - 1, 1, id);
  assert.strictEqual(menu.split('href="/?desktop=once"').length - 1, 1);
  for (const id of ['menu-look', 'menu-look-pick', 'menu-look-name', 'menu-adv-toggle', 'menu-adv']) assert.strictEqual(menu.split('id="' + id + '"').length - 1, 1, id);
  assert.match(menu, /<div id="menu-look-pick" hidden><\/div>/);
  // review r1: progressive: the HTML shows every Advanced item and hides the row, so an older cached mobile.js (which
  // never folds them) still reaches everything; mobile.js reveals the row and applies the saved fold state.
  assert.match(menu, /<button id="menu-adv-toggle" aria-expanded="true" aria-controls="menu-adv" hidden>/);
  assert.match(menu, /<div id="menu-adv">/);
  assert.doesNotMatch(menu, /<div id="menu-adv" hidden>/);
  const blk = js.slice(js.indexOf('// \u2500\u2500 phone menu (begin)'), js.indexOf('// \u2500\u2500 phone menu (end)'));
  assert.ok(blk.length > 100, 'phone menu block found');
  assert.match(blk, /tg\.hidden = false;[^\n]*\n\s*menuAdvApply\(menuAdvRead\(store\)\);/);
  assert.match(blk, /setAttribute\('aria-label', 'Advanced, something inside needs attention'\)/);
  assert.match(menu, /class="menu-adv-end" aria-hidden="true"/);
  assert.match(menu, /<button id="menu-look" aria-expanded="false" aria-controls="menu-look-pick" hidden>/);   // the Look row too: shown by the script
  assert.match(blk, /if \(look\) look\.hidden = !window\.HubLooks;/);
  assert.ok(menu.includes('class="menu-adv-dot" hidden'));
});

// pure helpers, sliced out of mobile.js
const block = js.slice(js.indexOf('// ── phone menu (begin) ──'), js.indexOf('// ── phone menu (end) ──'));
const helpers = block.slice(0, block.indexOf('function menuGroupsSync'));
const H = new Function(helpers + '; return { menuAdvRead, menuAdvWrite, menuGroupVisible };')();

test('menuAdvRead / menuAdvWrite: folded by default, "1" is open, a throwing storage never throws', () => {
  const m = {};
  const s = { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } };
  assert.strictEqual(H.menuAdvRead(s), false);
  H.menuAdvWrite(s, true);
  assert.strictEqual(m['mm-menu-advanced'], '1');
  assert.strictEqual(H.menuAdvRead(s), true);
  H.menuAdvWrite(s, false);
  assert.strictEqual(H.menuAdvRead(s), false);
  m['mm-menu-advanced'] = 'yes';
  assert.strictEqual(H.menuAdvRead(s), false);
  const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
  assert.strictEqual(H.menuAdvRead(bad), false);
  assert.doesNotThrow(() => H.menuAdvWrite(bad, true));
  assert.strictEqual(H.menuAdvRead(null), false);
  assert.doesNotThrow(() => H.menuAdvWrite(undefined, true));
});

test('menuGroupVisible: all hidden, only chat-only with no chat, one visible', () => {
  assert.strictEqual(H.menuGroupVisible([{ hidden: true }, { hidden: true, chatOnly: true }], false), false);
  assert.strictEqual(H.menuGroupVisible([{ chatOnly: true }, { chatOnly: true }], true), false);
  assert.strictEqual(H.menuGroupVisible([{ chatOnly: true }, { chatOnly: true }], false), true);
  assert.strictEqual(H.menuGroupVisible([{ hidden: true }, { hidden: false }], true), true);
  assert.strictEqual(H.menuGroupVisible([], false), false);
});

test('source: the toggle saves and keeps the menu open; groups and dot sync on open', () => {
  assert.match(block, /tg\.addEventListener\('click', \(e\) => \{\s*e\.stopPropagation\(\);[\s\S]*?menuAdvWrite\(store, open\);/);
  assert.ok(!/classList\.remove\('open'\)/.test(block), 'the block never closes the menu');
  assert.match(block, /pick\.addEventListener\('click', \(e\) => e\.stopPropagation\(\)\)/);
  assert.match(block, /closest\('\.menu-group-title'\)\) e\.stopPropagation\(\)/);
  const open = js.slice(js.indexOf('function toggleMenu('), js.indexOf('async function refreshMemoryHealth'));
  assert.match(open, /menuOnOpen\(\)/);
  const onOpen = block.slice(block.indexOf('function menuOnOpen'));
  assert.match(onOpen, /menuGroupsSync\(\);\s*menuAdvDotSync\(\);/);
  for (const f of ['function updateDots', 'function paintUpdateCard', 'async function refreshMemoryHealth']) {
    const i = js.indexOf(f); assert.ok(i > 0, f);
    assert.match(js.slice(i, i + 2600), /typeof menuAdvDotSync === 'function' && menuAdvDotSync\(\)/, f);
  }
  assert.match(js, /canDownload === true\); typeof menuGroupsSync === 'function' && menuGroupsSync\(\)/);
});

test('source: simpleSettingsOpen puts the interface style at the top, beside Appearance; the Profile sheet keeps its section', () => {
  // Simple follows the interface style (2026-11-20): the picker sits right after the Appearance row, which says which
  // style the colours follow; both are the first two sections of the sheet.
  const i = js.indexOf('function simpleSettingsOpen()');
  const fn = js.slice(i, i + 3500);
  const app = fn.indexOf('<div class="ss-title">Appearance</div>'), sty = fn.indexOf('<div class="ss-title">Interface style</div>'), name = fn.indexOf('<div class="ss-title">Name</div>');
  assert.ok(app > 0 && sty > app && name > sty, 'Appearance, then Interface style, then the rest');
  assert.ok(!fn.includes("querySelector('.ss-row')"));
  assert.match(js, /lookPickerPaint\(\$\('prof-looks'\)\);/);
});
