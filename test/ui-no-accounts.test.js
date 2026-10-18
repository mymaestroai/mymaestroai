'use strict';
// A hub with no admin account yet (updated from before multi-user): /api/me says accounts:false, the page shows the
// banner linking to /setup, and the account chip hides instead of throwing. Source-string tests.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js');
const server = read('server.js');

test('/api/me reports whether any account exists', () => {
  assert.match(server, /const out = \{ user: u, isAdmin, accounts: hubAuth\.hasUsers\(\) \};/);
});

test('the page paints the no-accounts banner after loading /api/me, only when accounts is false', () => {
  assert.match(app, /paintSetupNotice\(\);\s*\n\s*paintNoAccountsNotice\(\);/);
  const at = app.indexOf('function paintNoAccountsNotice()');
  const body = app.slice(at, at + 1200);
  assert.match(body, /const none = \(me && me\.accounts === false\) \|\| \(!me && window\.hubNoAccounts === true\);/);
  // /api/me answers 401 on a hub with no accounts, so the page asks the public auth status instead
  assert.match(app, /else if \(r\.status === 401\) \{[\s\S]*?fetch\('\/api\/auth\/status', \{ credentials: 'include' \}\)[\s\S]*?window\.hubNoAccounts = a && a\.setupNeeded === true && !a\.signedIn;/);
  assert.match(body, /id = 'hub-no-accounts-notice'/);
  assert.match(body, /multi-user features \(members, sharing, the account menu, member sandboxes\) stay off until an admin account exists/);
  assert.match(body, /<a href="\/welcome"[^>]*>Create the admin account<\/a> \(you will need the setup link: run mymaestro setup-link\)/);
});

test('the account chip hides when there is no user', () => {
  const at = app.indexOf('function renderUserChip()');
  const body = app.slice(at, at + 600);
  assert.match(body, /if \(!me\.user\) \{ chip\.style\.display = 'none'; document\.getElementById\('user-chip-wrap'\)\.style\.display = 'none'; return; \}/);
});
