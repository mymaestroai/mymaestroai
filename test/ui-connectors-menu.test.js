'use strict';
// Data connectors and Remote computers one tap away: the desktop page's ⋯ menu, account menu and Settings, and the phone page's menu.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const index = read('index.html');
const app = read('app.js');
const mobileHtml = read('mobile.html');
const mobileJs = read('mobile.js');
const settle = () => new Promise((res) => setImmediate(res));

// Reload stays right after About (test/ui-reload-desktop.test.js pins that); the two new items follow it.
test('index.html: ⋯ menu has Data connectors (→ /modules) right after About and Reload, then Remote computers hidden by default', () => {
  assert.match(index, /id="about-btn"[^>]*>[^<]*About My Maestro AI<\/button>\s*<button id="reload-app-item"[^>]*>↻ Reload<\/button>\s*<button id="more-modules-item" class="more-item" role="menuitem"[^>]*onclick="closeMoreMenu\(\); location\.href = '\/modules'">🔌 Data connectors<\/button>\s*<button id="more-remote-item" class="more-item" role="menuitem"[^>]*style="display:none"[^>]*onclick="closeMoreMenu\(\); location\.href = '\/modules#remote-computers'">💻 Remote computers<\/button>/);
});

test('index.html: the account menu has Remote computers right after Data connectors, hidden by default', () => {
  assert.ok(index.includes('<a class="account-item" role="menuitem" id="account-modules" href="/modules" style="display:none">Data connectors</a>\n        <a class="account-item" role="menuitem" id="account-remote" href="/modules#remote-computers" style="display:none">Remote computers</a>'));
});

function loadMenus(me, answer) {
  const start = app.indexOf('    function applyMemberView() {');
  const end = app.indexOf('    function toggleAccountMenu(force)');
  assert.ok(start > 0 && end > start);
  const els = {};
  const mk = (id) => ({ id, style: {}, textContent: '', classList: { add() {}, remove() {} }, closest: () => null, querySelector: () => ({ textContent: '' }) });
  const el = (id) => els[id] || (els[id] = mk(id));
  const fetches = [];
  const sandbox = {
    window: { hubMe: me }, document: { getElementById: el, body: { classList: { add() {} } }, querySelector: () => null },
    fetch: (u, o) => { fetches.push(u); return answer === 'throw' ? Promise.reject(new Error('down')) : Promise.resolve({ status: answer, ok: answer === 200 }); },
  };
  vm.createContext(sandbox);
  vm.runInContext(app.slice(start, end) + '\n;this.__t = { applyMemberView, renderUserChip, checkRemoteComputers };', sandbox);
  return { t: sandbox.__t, els, fetches, sandbox };
}
const ADMIN = { isAdmin: true, user: { name: 'owner', role: 'admin', totpEnabled: true } };

test('app.js: the Remote computers items show only for an admin when /api/remote-desktop answers 200', async () => {
  const a = loadMenus(ADMIN, 200);
  a.t.renderUserChip(); a.t.renderUserChip();
  assert.deepStrictEqual(a.fetches, ['/api/remote-desktop'], 'checked once');
  assert.notStrictEqual(a.els['more-remote-item'].style.display, '', 'not shown before the answer');
  await settle();
  for (const id of ['more-remote-item', 'account-remote']) assert.strictEqual(a.els[id].style.display, '', id);
  assert.strictEqual(a.els['account-modules'].style.display, '');
  for (const answer of [404, 409, 500, 'throw']) {
    const b = loadMenus(ADMIN, answer);
    b.t.renderUserChip(); await settle();
    for (const id of ['more-remote-item', 'account-remote']) assert.strictEqual(b.els[id].style.display, 'none', `${id} after ${answer}`);
  }
  const m = loadMenus({ isAdmin: false, user: { name: 'sam', role: 'member' } }, 200);
  m.t.renderUserChip(); await settle();
  assert.deepStrictEqual(m.fetches, [], 'a member never asks');
  assert.ok(!m.els['more-remote-item'] || m.els['more-remote-item'].style.display !== '');
});

test('app.js: applyMemberView hides the two new ⋯ items', () => {
  const m = loadMenus({ isAdmin: false, user: { name: 'sam', role: 'member' } }, 200);
  m.t.applyMemberView();
  assert.strictEqual(m.els['more-modules-item'].style.display, 'none');
  assert.strictEqual(m.els['more-remote-item'].style.display, 'none');
});

test('app.js: Settings has the Go to line for admins (Data connectors always, Remote computers when the check passed); the old section stays', () => {
  assert.match(app, /window\.hubMe && window\.hubMe\.isAdmin \? `<div id="st-quick-links"[^`]*Go to: <a href="\/modules"[^>]*>🔌 Data connectors<\/a><a href="\/modules#remote-computers" id="st-remote-link"[^>]*display:\$\{remoteComputersOk === true \? '' : 'none'\}[^>]*>💻 Remote computers<\/a>(?:<a href="\/changes" id="st-changes-link"[^>]*>Changes to how agents behave<\/a>)?<\/div>` : ''\)\s*\+ `<div class="st-panes">/);
  assert.ok(app.indexOf('st-quick-links') < app.indexOf('STG.GROUPS.map(g =>'), 'above the groups');
  assert.match(app, /id="st-connectors-link"/);
  assert.ok(require('../lib/ui-settings-groups.js').groupOfSection('st-modules-section').group === 'tools', 'the Data connectors section is still there, in Tools and connections');
});

test('mobile.html: menu-remote follows menu-connectors, hidden by default, no variation selector', () => {
  assert.ok(mobileHtml.includes('<a id="menu-connectors" href="/modules" hidden>&#x1F50C; Data connectors</a>\n      <a id="menu-remote" href="/modules#remote-computers" hidden>&#x1F4BB; Remote computers</a>'));
  assert.ok(!/menu-remote[^\n]*&#xFE0F;/.test(mobileHtml));
});

test('mobile.js: menu-remote is shown only for an admin when /api/remote-desktop answers 200', async () => {
  const a = mobileJs.indexOf("    if ($('menu-remote')) {");
  const b = mobileJs.indexOf("    if ($('menu-wallet'))", a);
  assert.ok(a > 0 && b > a);
  const code = mobileJs.slice(a, b);
  const run = async (isAdmin, answer) => {
    const el = { hidden: false }; const f = [];
    const sb = { $: (id) => (id === 'menu-remote' ? el : null), hubMe: { isAdmin }, fetch: (u, o) => { f.push(u); return answer === 'throw' ? Promise.reject(new Error('x')) : Promise.resolve({ status: answer }); } };
    vm.createContext(sb); vm.runInContext(code, sb); await settle();
    return { hidden: el.hidden, f };
  };
  assert.deepStrictEqual(await run(true, 200), { hidden: false, f: ['/api/remote-desktop'] });
  assert.strictEqual((await run(true, 404)).hidden, true);
  assert.strictEqual((await run(true, 'throw')).hidden, true);
  assert.deepStrictEqual(await run(false, 200), { hidden: true, f: [] });
});
