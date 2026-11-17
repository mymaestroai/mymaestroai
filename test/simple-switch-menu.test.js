'use strict';
// "Switch to Simple" is easy to find: in the desktop account menu (beside Profile and Security) and near the top of the
// phone's menu, shown only for a real account (simpleAccountOk). Settings keeps its own copy on the desktop.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('desktop: the account menu has "Switch to Simple" right after Security, hidden until the account is known', () => {
  const html = read('index.html');
  const menu = html.slice(html.indexOf('<div id="account-menu"'), html.indexOf('</div>', html.indexOf('onclick="signOut()"')));
  const sec = menu.indexOf('onclick="openSecurityDialog()">Security</button>');
  const item = menu.indexOf('id="account-simple"');
  assert.ok(sec > 0 && item > sec && item < menu.indexOf('id="account-users"'), 'after Security, before Users');
  assert.match(menu, /<button class="account-item" role="menuitem" id="account-simple" style="display:none" onclick="toggleAccountMenu\(false\); simpleSwitchMode\('simple'\)">Switch to Simple<\/button>/);
});

test('desktop: renderUserChip shows the item only for a real account (simpleAccountOk), and Settings keeps its item', () => {
  const app = read('app.js');
  const fn = app.slice(app.indexOf('function renderUserChip()'), app.indexOf('function toggleAccountMenu('));
  assert.match(fn, /document\.getElementById\('account-simple'\)/);
  assert.match(fn, /simpleItem\.style\.display = typeof simpleAccountOk === 'function' && simpleAccountOk\(me\) \? '' : 'none';/);
  assert.ok(app.includes('id="st-switch-simple" onclick="simpleSwitchMode(\'simple\')"'), 'the Settings item stays');
});

test('desktop: simpleAccountOk accepts a real account and refuses the legacy login and no account', () => {
  const app = read('app.js');
  const src = app.slice(app.indexOf('function simpleAccountOk('), app.indexOf('\n', app.indexOf('function simpleAccountOk(')));
  const ok = new Function(src + '; return simpleAccountOk;')();
  assert.strictEqual(ok({ user: { id: 'u_1' } }), true);
  assert.strictEqual(ok({ user: { id: 'legacy' } }), false);
  assert.strictEqual(ok({ user: null }), false);
  assert.strictEqual(ok(null), false);
});

test('phone: "Switch to Simple" sits right after About, near the top of the menu, once', () => {
  const html = read('mobile.html');
  const menu = html.slice(html.indexOf('<div id="menu">'), html.indexOf('id="menu-restart"'));
  assert.strictEqual(menu.split('id="menu-simple"').length - 1, 1);
  const about = menu.indexOf('id="menu-about"');
  const item = menu.indexOf('<button id="menu-simple">Switch to Simple</button>');
  assert.ok(about > 0 && item > about && item < menu.indexOf('href="/?desktop=once"'), 'right after About');
});
