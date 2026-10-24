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
  assert.match(app, /'more-wrap', 'update-chip'\]/, 'the chip is hidden for members');
  assert.match(index, /<span id="update-chip" onclick="showUpdateCard\(\)"/);
  assert.match(index, /#hub-update-card \{/);
});

test('desktop: Update now is the Update dialog\'s own update, then its restart; Later is kept on the hub', () => {
  const body = app.slice(app.indexOf('async function updateNow()'), app.indexOf('// Settings → Status → Updates.'));
  assert.ok(body.length > 100);
  assert.match(body, /fetch\('\/api\/git-sync\/update'/);
  assert.match(body, /fetch\('\/api\/restart'/);
  assert.ok(body.indexOf('/api/git-sync/update') < body.indexOf('/api/restart'), 'restart only after the update');
  assert.match(body, /if \(!r \|\| !r\.success\) \{[\s\S]*?return;\s*\}/, 'a failed update does not restart');
  assert.match(app, /fetch\('\/api\/update-check\/later', \{ method: 'POST'/);
});

test('desktop: Settings → Status → Updates has the switch and Check now', () => {
  assert.match(app, /sections: \['st-ready-section', 'st-sec-section', 'st-updates-section'\]/);
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
  assert.match(mobile, /<button id="upd-force">Discard changes &amp; update<\/button>/);
  assert.match(mobile, /if \(confirm\(`Discard \$\{s\.dirty\.length\}[\s\S]*?runUpdateFromPhone\(null, true\)/);
  assert.match(mobile, /force \? '\/api\/git-sync\/force-update' : '\/api\/git-sync\/update'/);
  assert.match(mobile, /if \(\$\('upd-force'\)\) \$\('upd-force'\)\.disabled = !!other;/, 'phone: no discard while another channel is chosen');
  assert.match(mobile, /'click', \(\) => \{ if \(chosen\(\)\) return;/);
  assert.match(app, /const force = document\.getElementById\('gs-force'\); if \(force\) force\.disabled = !!c;/, 'desktop: the same');
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
