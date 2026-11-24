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
  // changed (Set up teams): a set-up turn stays in view like build_team
  assert.match(d, /const hubMain = chatViewGet\(localStorage\) === 'main' && chatViewIsHubOrigin\(ev\.origin\) && ev\.origin\.kind !== 'build_team' && ev\.origin\.kind !== 'team_setup';/);
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

// Build Team / Set up teams: the person pressed it, so the card does not fold the reply away (live and saved history).
const { autoGroupHistory, autoOwnOrigin } = require('../lib/ui-auto-turns');
for (const kind of ['build_team', 'team_setup']) {
  test(`a ${kind} turn's replies open under its card, not folded (autoGroupHistory)`, () => {
    const h = [
      { role: 'user', content: 'Follow the playbook', origin: { kind } },
      { role: 'assistant', content: 'plan note and the reply' },
    ];
    const items = autoGroupHistory(h);
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'card');
    assert.deepStrictEqual(items[0].open, [1]);
    assert.equal(items[0].firstLine, 'Follow the playbook');
    // another hub turn's reply stays folded
    const other = autoGroupHistory([{ role: 'user', content: 'x', origin: { kind: 'task' } }, { role: 'assistant', content: 'y' }]);
    assert.deepStrictEqual(other[0].open, []);
  });
}
for (const kind of ['build_team', 'team_setup']) {
  test(`a ${kind} prompt with no reply does not swallow the next schedule turn`, () => {
    const h = [
      { role: 'user', content: 'Follow the playbook', origin: { kind } },
      { role: 'user', content: 'Nightly run', origin: { kind: 'schedule' } },
      { role: 'assistant', content: 'the nightly reply' },
    ];
    const items = autoGroupHistory(h);
    assert.equal(items.length, 2);
    assert.deepStrictEqual(items.map((c) => c.indexes), [[0], [1, 2]]);
    assert.deepStrictEqual(items.map((c) => c.open), [[], []]);
    const solo = autoGroupHistory([h[0], { role: 'assistant', content: 'reply' }]);
    assert.equal(solo.length, 1);
    assert.deepStrictEqual(solo[0].open, [1]);
  });
}
test('autoOwnOrigin: only build_team and team_setup', () => {
  assert.equal(autoOwnOrigin({ kind: 'build_team' }), true);
  assert.equal(autoOwnOrigin({ kind: 'team_setup' }), true);
  assert.equal(autoOwnOrigin({ kind: 'schedule' }), false);
  assert.equal(autoOwnOrigin(null), false);
});
test('the pages move a build_team / team_setup reply out of its live card at once', () => {
  const d = require('fs').readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');
  const m = require('fs').readFileSync(require('path').join(__dirname, '..', 'mobile.js'), 'utf8');
  assert.match(d, /if \(ev\.origin && \(ev\.origin\.kind === 'build_team' \|\| ev\.origin\.kind === 'team_setup'\)\) hubForOwnerPending\[ev\.turnId\] = /);
  assert.match(m, /if \(card && ev\.origin && \(ev\.origin\.kind === 'build_team' \|\| ev\.origin\.kind === 'team_setup'\)\) forOwnerPending\[ev\.turnId\] = /);
});
