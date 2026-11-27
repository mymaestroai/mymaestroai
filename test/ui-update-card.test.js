'use strict';
// The "Update available" card (lib/update-check): the desktop card and sidebar chip, the phone card, the ⋮ menu note
// and the sheet the push notification opens. Text from GitHub (the changelog titles) is always escaped.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js'), index = read('index.html'), mobile = read('mobile.js'), mhtml = read('mobile.html');
const NOTES_ESCAPED = /\(s\.titles \|\| \[\]\)\.map\(t => `<li>\$\{esc\(t\)\}<\/li>`\)/;

test('desktop: a card with Update now and Later, a chip, escaped notes, for admins only', () => {
  assert.match(app, /async function paintUpdateCard\(\)/);
  assert.match(app, /if \(!me \|\| !me\.isAdmin\) \{ document\.getElementById\('hub-update-card'\)\?\.remove\(\)/);
  assert.match(app, /id="uc-now" onclick="updateNow\(\)">Update now</);
  assert.match(app, /id="uc-later" onclick="updateLater\(\)">Later</);
  assert.match(app, NOTES_ESCAPED);
  assert.match(app, /'halt-btn', 'update-chip'\]/, 'the chip is hidden for members');
  assert.match(app, /id="uc-settings" onclick="openSettingsAt\('st-updates-section'\); return false">Update settings</, 'the card opens Settings at Upkeep');
  assert.match(index, /<span id="update-chip" onclick="showUpdateCard\(\)"/);
  assert.match(index, /#hub-update-card \{/);
});

test('desktop: Update now is the Update dialog\'s own update, then its restart; Later is kept on the hub', () => {
  const body = app.slice(app.indexOf('async function updateNow()'), app.indexOf('// Settings → Status → Updates.'));
  assert.ok(body.length > 100);
  assert.match(body, /fetch\('\/api\/git-sync\/update'/);
  // the restart goes through postRestart(), which asks first when running jobs would stop
  assert.match(body, /fetch\('\/api\/restart'|await postRestart\(\)/);
  const restartAt = body.search(/fetch\('\/api\/restart'|await postRestart\(\)/);
  assert.ok(restartAt > 0 && body.indexOf('/api/git-sync/update') < restartAt, 'restart only after the update');
  assert.match(body, /if \(!r \|\| !r\.success\) \{[\s\S]*?return;\s*\}/, 'a failed update does not restart');
  assert.match(app, /fetch\('\/api\/update-check\/later', \{ method: 'POST'/);
});

test('desktop: Settings → Status → Updates has the switch and Check now', () => {
  // the Self-check section sits between Memory and Updates (Settings → Status → Self-check)
  assert.deepStrictEqual(require('../lib/ui-settings-groups.js').GROUPS.find((g) => g.id === 'upkeep').sections.slice(2, 6), ['st-memory-section', 'st-selfcheck-section', 'st-components-section', 'st-updates-section']);
  assert.match(app, /id="st-updates-section"/);
  assert.match(app, /onchange="saveUpdateCheck\(this\.checked\)"/);
  assert.match(app, /fetch\('\/api\/update-check\/settings'/);
  assert.match(app, /fetch\('\/api\/update-check\/now'/);
});

test('phone: a card on the agent list, a note on the menu, and the notification opens the choice once', () => {
  assert.match(mhtml, /<div id="update-card" hidden><\/div>/);
  assert.match(mhtml, /<button id="menu-update">[^<]*Update hub<span id="menu-update-note"><\/span><\/button>/);
  assert.match(mobile, /data-uc="now">Update now</);
  assert.match(mobile, /data-uc="later">Later</);
  assert.match(mobile, NOTES_ESCAPED);
  assert.match(mobile, /get\('update'\) === '1'/);
  assert.match(mobile, /u\.searchParams\.delete\('update'\)/);
  assert.match(mobile, /if \(fromUpdatePush\) openUpdatePrompt\(\)/);
  assert.match(mobile, /function updateNowFromPhone\(\)[\s\S]*?runUpdateFromPhone\(null\)/);
  assert.match(mobile, /\$\('update-card'\)\.addEventListener\('click', onUpdateChoice\)/);
  assert.match(mobile, /\$\('update-sheet'\)\.addEventListener\('click', onUpdateChoice\)/);
});

test('review fixes: Later names its version, busy agents are confirmed at the click, a refused restart is reported', () => {
  assert.match(app, /card\.dataset\.remote = s\.remote \|\| ''/);
  assert.match(app, /remote: shown \|\| \(ucLast && ucLast\.remote\) \|\| null/);
  assert.match(mobile, /card\.dataset\.remote = s\.remote \|\| ''/);
  assert.match(mobile, /d\.dataset\.remote = s\.remote \|\| ''/);
  assert.match(mobile, /updateLater\(\(b\.closest\('#update-sheet, #update-card'\) \|\| \{\}\)\.dataset\?\.remote \|\| ''\)/);
  // Changed on purpose (local-edits change): nothing is discarded any more. The phone offers "Put my changes aside" (git stash,
  // never put back), with a confirm, using the chosen channel; the desktop dialog does the same.
  assert.match(mobile, /Put my changes aside and update/);
  // review r1: put-aside-only also when a rewritten history is blocked by the changed files (asideOnly), not only when up to date
  assert.match(mobile, /if \(confirm\(`Put these \$\{lc\.length\} change[\s\S]*?runUpdateFromPhone\(asideOnly \? null : chosen\(\), true, asideOnly\)/);
  assert.match(mobile, /asideOnly \? '\/api\/git-sync\/put-aside' : force \? '\/api\/git-sync\/force-update' : '\/api\/git-sync\/update'/);
  assert.match(app, /Put my changes aside and update/);
  assert.match(app, /Put these \$\{n\} change/, 'desktop: the same confirm');
  const now = app.slice(app.indexOf('async function updateNow()'), app.indexOf('// Settings → Status → Updates.'));
  assert.ok(now.indexOf('busyAgentNames()') < now.indexOf("/api/git-sync/update"), 'desktop asks before updating');
  assert.match(now, /if \(refused\)/);
  const phoneNow = mobile.slice(mobile.indexOf('function updateNowFromPhone()'), mobile.indexOf('function onUpdateChoice('));
  assert.ok(phoneNow.indexOf('isBusy(n)') < phoneNow.indexOf('runUpdateFromPhone(null)'), 'phone asks before updating');
  assert.match(app, /else document\.getElementById\('hub-update-card'\)\?\.remove\(\);   \/\/ also when Later was pressed on another device/);
});

test('the push goes to admins and opens the phone prompt', () => {
  const uc = read('lib/update-check.js');
  assert.match(uc, /url: '\/mobile\?update=1'/);
  assert.match(uc, /adminsOnly: true/);
});
