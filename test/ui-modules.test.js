'use strict';
// Modules page (modules.html) and its routes: source-string tests in the ui-*.test.js pattern.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const page = read('modules.html'), server = read('server.js'), access = read('lib/access.js'), app = read('app.js'), index = read('index.html');

test('the page is admin-only and served at /modules; the API sits under /api/modules (admin by default)', () => {
  assert.match(access, /'\/modules', '\/modules\.html'/);
  assert.match(server, /else if \(pathname === '\/modules'\) \{\s*filePath = path\.join\(__dirname, 'modules\.html'\);/);
  for (const r of ['step', 'check', 'settings', 'enable', 'disable', 'audit']) assert.match(server, new RegExp(`\\(step\\|check\\|settings\\|enable\\|disable\\|audit\\)`), r);
  assert.match(server, /mods\.runStep\(id, String\(b\.step \|\| ''\), b\.input \|\| \{\}\)/);
});

test('every step type has a renderer; text is escaped; secrets are password fields and never echoed', () => {
  for (const t of ['explain', 'outside', 'install', 'secrets', 'check', 'settings', 'grant', 'finish']) assert.ok(page.includes(`s.type === '${t}'`), t);
  assert.match(page, /const esc = \(s\) =>/);
  assert.match(page, /<input type="password" id="sec-\$\{esc\(x\.name\)\}" autocomplete="off"/);
  assert.match(page, /rel="noopener noreferrer"/);
  assert.match(page, /await f\.files\[0\]\.text\(\)/, 'the key file is read in the browser');
});

test('the hub links to it: account menu for admins and a Settings box', () => {
  assert.match(index, /id="account-modules" href="\/modules"/);
  assert.match(app, /modulesItem\.style\.display = me\.isAdmin \? '' : 'none';/);
  assert.match(app, /<a href="\/modules" style="color:var\(--accent\)">Open the Modules page →<\/a>/);
});
