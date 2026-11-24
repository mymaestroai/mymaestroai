// A Build Team turn (origin kind build_team) is one the person pressed: unlike other hub-started turns it is not hidden
// in the main view. Hidden, the lead's chat was blank after the turn (the proposal and the reply never showed).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { filterMainView, historyPage } = require(path.join(ROOT, 'lib', 'chat-history.js'));
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const mobile = fs.readFileSync(path.join(ROOT, 'mobile.js'), 'utf8');

const T = (n) => new Date(Date.UTC(2026, 10, 23, 12, 0, n)).toISOString();
const turn = (kind) => [
  { ts: T(1), role: 'user', content: 'Follow TEAM-PLAYBOOK.md in your workspace', origin: { kind, for: 'maestro' } },
  { ts: T(2), role: 'assistant', content: 'Maestro needs no team.' },
];

test('main view: a build_team turn stays, another hub-started turn without a for_owner mark goes', () => {
  assert.deepStrictEqual(filterMainView(turn('build_team')), [true, true]);
  assert.deepStrictEqual(filterMainView(turn('task')), [false, false]);
});

test('main view history page of a chat holding only a build_team turn is not empty', () => {
  const page = historyPage({ logEntries: turn('build_team'), archive: null, view: 'main' });
  assert.strictEqual(page.history.length, 2);
  assert.strictEqual(historyPage({ logEntries: turn('task'), archive: null, view: 'main' }).history.length, 0);
});

test('the pages do not hide a followed build_team turn in the main view', () => {
  const d = app.slice(app.indexOf('async function onHubTurnStart('), app.indexOf('function onHubTurnDelta('));
  assert.match(d, /const hubMain = chatViewGet\(localStorage\) === 'main' && chatViewIsHubOrigin\(ev\.origin\) && ev\.origin\.kind !== 'build_team';/);
  const m = mobile.slice(mobile.indexOf('function onTurnStart('), mobile.indexOf('function onTurnDelta('));
  assert.match(m, /viewNow\(\) === 'main' && chatViewIsHubOrigin\(ev\.origin\) && ev\.origin\.kind !== 'build_team'/);
});

test('a Build Team prompt starts its own turn: an earlier hidden hub prompt with no reply yet stays hidden', () => {
  const { filterMainView } = require('../lib/chat-history');
  const keep = filterMainView([
    { role: 'user', content: 'scheduled', origin: { kind: 'schedule' } },
    { role: 'user', content: 'build', origin: { kind: 'build_team' } },
    { role: 'assistant', content: 'plan' },
  ]);
  assert.deepEqual(keep, [false, true, true]);
});

test('a Build Team prompt that stopped before replying lends nothing: the next hub prompt and its reply stay hidden', () => {
  const { filterMainView } = require('../lib/chat-history');
  const keep = filterMainView([
    { role: 'user', content: 'build', origin: { kind: 'build_team' } },
    { role: 'user', content: 'scheduled', origin: { kind: 'schedule' } },
    { role: 'assistant', content: 'reply' },
  ]);
  assert.deepEqual(keep, [true, false, false]);
});
