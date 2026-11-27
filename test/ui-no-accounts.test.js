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

test('no login at all is a Fix now item (id accounts) in the one banner, read after /api/me; a hub with no /api/me answer asks the public auth status', () => {
  // the old banner is gone (P4-15); the condition lives in lib/ui-review.js and the page feeds it
  assert.doesNotMatch(app, /paintNoAccountsNotice|hub-no-accounts-notice/);
  const review = require('../lib/ui-review.js');
  const r = review.build({ accounts: { none: true } });
  assert.deepStrictEqual(r.fix.map((p) => [p.id, p.title, p.fix.label, p.fix.href]), [['accounts', 'This hub has no login yet', 'Create the admin account', '/welcome']]);
  const at = app.indexOf('async function reviewRefresh()');
  const body = app.slice(at, at + 900);
  assert.match(body, /if \(RV && \(\(!me && window\.hubNoAccounts === true\) \|\| \(me && me\.accounts === false && !me\.user\)\)\)/);   // no session and no accounts, or accounts:false with no user: the banner still says so
  assert.match(body, /RV\.build\(\{ accounts: \{ none: true \}/);
  assert.match(app, /accounts: \{ none: me\.accounts === false \}/, 'a signed-in admin: /api/me says accounts is false');
  // /api/me answers 401 on a hub with no accounts, so the page asks the public auth status instead
  assert.match(app, /else if \(r\.status === 401\) \{[\s\S]*?fetch\('\/api\/auth\/status', \{ credentials: 'include' \}\)[\s\S]*?window\.hubNoAccounts = a && a\.setupNeeded === true && !a\.signedIn;/);
  assert.match(app, /reviewRefresh\(\)\.catch\(\(\) => \{\}\);   \/\/ the count on the gear/);
});

test('the account chip hides when there is no user', () => {
  const at = app.indexOf('function renderUserChip()');
  const body = app.slice(at, at + 600);
  assert.match(body, /if \(!me\.user\) \{ chip\.style\.display = 'none'; document\.getElementById\('user-chip-wrap'\)\.style\.display = 'none'; return; \}/);
});
