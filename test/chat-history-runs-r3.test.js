'use strict';
// Review round 3 of the run lines (server): a legacy run's rank counts the whole equal-time group; a live line is fetched by
// turn id whatever its `to` says; a first turn alone over the cap comes back cut and marked partial; only hub-started user
// rows of the archive carry a turn id.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { historyPage, runPage } = require('../lib/chat-history');

const T0 = Date.parse('2026-07-01T00:00:00Z');
const t = (n) => new Date(T0 + n * 1000).toISOString();
const none = { rowsBefore: () => [], forOwnerTurns: () => new Set(), lastMarkTs: () => null };
const runs = (h) => h.filter(e => e.role === 'hidden_run');
const hubU = (ts, from, turn, content = `[Consultation from agent "${from}"] q`) => ({ ts, role: 'user', content, origin: { kind: 'consultation', from }, ...(turn ? { turn_id: turn } : {}) });
const plain = (ts, role, content, extra = {}) => ({ ts, role, content, ...extra });

function fakeArchive(rows, { cleared = null } = {}) {
  return {
    rowsBefore({ beforeId = null, beforeTs = null, afterTs = null, afterId = null, oldestFirst = false, kinds = ['user', 'assistant'], limit }) {
      const list = rows.filter(r => (beforeId == null || r.id < beforeId) && (afterId == null || r.id > afterId) && (!beforeTs || r.ts < beforeTs) && (!afterTs || r.ts > afterTs) && kinds.includes(r.kind));
      return list.sort((a, b) => (oldestFirst ? a.id - b.id : b.id - a.id)).slice(0, limit);
    },
    forOwnerTurns: () => new Set(),
    lastMarkTs: (tool) => (tool === 'chat_cleared' ? cleared : null),
  };
}
let rid = 0;
const row = (ts, kind, text, turn, origin = 'user') => ({ id: ++rid, ts, kind, text, origin, turn_id: turn, meta: {} });

test('r3 F2: two same-ms hub prompts without turn ids on two pages: the newer page\'s line has rank 1 and opens ITS prompt', () => {
  const log = [hubU(t(5), 'scout', null, '[Consultation from agent "scout"] first'), plain(t(5), 'user', 'owner says hi'),
    hubU(t(5), 'scout', null, '[Consultation from agent "scout"] second'), plain(t(6), 'assistant', 'second answer')];
  const newer = historyPage({ logEntries: log, archive: none, view: 'main', limit: 1 });
  const lineB = runs(newer.history)[0];
  assert.ok(lineB, 'the newer page has the second prompt\'s line');
  assert.strictEqual(lineB.rank, 1, 'one hidden prompt at the same ms comes earlier in the log');
  const older = historyPage({ logEntries: log, archive: none, view: 'main', limit: 5, before: newer.next });
  assert.strictEqual(runs(older.history)[0].rank, 0);
  const opened = runPage({ logEntries: log, archive: none, from: lineB.ts, to: lineB.last_ts, rank: lineB.rank });
  assert.strictEqual(opened.history[0].content, '[Consultation from agent "scout"] second');
  assert.strictEqual(opened.history.length, 2);
});

test('r3 F2: archive pages count the rank within their batch (an equal-ms pair split across batches is out of scope)', () => {
  const rows = [row(t(5), 'user', '[Consultation from agent "scout"] a1', null, 'consultation'), row(t(5), 'user', 'owner', null),
    row(t(5), 'user', '[Consultation from agent "scout"] b1', null, 'consultation'), row(t(6), 'assistant', 'b answer', null)];
  const p = historyPage({ logEntries: [], archive: fakeArchive(rows), view: 'main', limit: 20 });
  assert.deepStrictEqual(runs(p.history).map(r => r.rank), [0, 1]);
});

test('r3 F3: a live-style request (to a minute before from) with a turn id returns the run', () => {
  const log = [plain(t(1), 'user', 'owner'), plain(t(2), 'assistant', 'ok'), hubU(t(300), 'scout', 'tLive'), plain(t(310), 'assistant', 'live answer')];
  const p = runPage({ logEntries: log, archive: none, from: t(300), to: t(240), turn: 'tLive' });
  assert.deepStrictEqual(p.history.map(e => e.content), ['[Consultation from agent "scout"] q', 'live answer']);
  assert.throws(() => runPage({ logEntries: log, archive: none, from: t(300), to: t(240) }), /bad_range/, 'without a turn id a backwards range is still bad');
  assert.throws(() => runPage({ logEntries: log, archive: none, from: 'nope', to: t(240), turn: 'tLive' }), /bad_range/);
});

test('r3 F3: a run with turns after `to` returns them all when fetched by turn (log)', () => {
  const log = [hubU(t(1), 'scout', 'tA'), plain(t(2), 'assistant', 'a'), hubU(t(3), 'scout', 'tB'), plain(t(4), 'assistant', 'b'),
    hubU(t(5), 'scout', 'tC'), plain(t(6), 'assistant', 'c'), plain(t(9), 'user', 'owner')];
  const p = runPage({ logEntries: log, archive: none, from: t(1), to: t(1), turn: 'tA' });
  assert.strictEqual(p.history.length, 6);
  assert.strictEqual(p.more, false);
});

test('r3 F3: a run with turns after `to` returns them all when fetched by turn (archive, going on into the log)', () => {
  const rows = [row(t(1), 'user', '[Consultation from agent "scout"] qA', 'tA', 'consultation'), row(t(2), 'assistant', 'a', 'tA'),
    row(t(3), 'user', '[Consultation from agent "scout"] qB', 'tB', 'consultation'), row(t(4), 'assistant', 'b', 'tB')];
  const log = [hubU(t(5), 'scout', 'tC'), plain(t(6), 'assistant', 'c', { turn_id: 'tC' }), plain(t(9), 'user', 'owner')];
  const p = runPage({ logEntries: log, archive: fakeArchive(rows), from: t(1), to: t(1), turn: 'tA' });
  assert.deepStrictEqual(p.history.map(e => e.content).filter(c => !c.startsWith('[')), ['a', 'b', 'c']);
  assert.strictEqual(p.history.length, 6);
});

test('r3 F3: the backward archive scan stops once it has the turn\'s row and an older user row (no scan to the bound when from is early)', () => {
  const rows = [];
  for (let i = 1; i <= 4100; i++) {
    if (i === 4001) rows.push(row(t(i), 'user', '[Consultation from agent "scout"] deep', 'tZ', 'consultation'));
    else rows.push(row(t(i), i % 2 ? 'user' : 'assistant', i % 2 ? `owner ${i}` : `reply ${i}`));
  }
  const p = runPage({ logEntries: [plain(t(9000), 'user', 'owner now')], archive: fakeArchive(rows), from: t(0), to: t(4001), turn: 'tZ' });
  assert.ok(!p.incomplete, 'not incomplete');
  assert.deepStrictEqual(p.history.map(e => e.content), ['[Consultation from agent "scout"] deep', 'reply 4002']);
});

test('r3 F4: a first turn alone over the cap comes back cut with more and partial; a cut between turns is not partial', () => {
  const big = [hubU(t(0), 'scout', 'tBig')];
  for (let i = 1; i <= 250; i++) big.push(plain(t(i), 'assistant', `r${i}`));
  big.push(plain(t(400), 'user', 'owner'));
  const p = runPage({ logEntries: big, archive: none, from: t(0), to: t(0), turn: 'tBig' });
  assert.strictEqual(p.history.length, 200); assert.strictEqual(p.more, true); assert.strictEqual(p.partial, true);
  const many = [];
  for (let i = 0; i < 150; i++) many.push(hubU(t(i * 2), 'scout', `t${i}`), plain(t(i * 2 + 1), 'assistant', `a${i}`));
  const q = runPage({ logEntries: many, archive: none, from: t(0), to: t(300), turn: 't0' });
  assert.strictEqual(q.more, true); assert.ok(!q.partial, 'whole turns: not partial');
  assert.ok(/partial/.test(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')), 'the route passes partial on');
});

test('r3 F4: only hub-started user rows of the archive carry a turn id', () => {
  const rows = [row(t(1), 'user', 'owner asks', 'tO'), row(t(2), 'assistant', 'owner answer', 'tO'),
    row(t(3), 'user', '[Consultation from agent "scout"] q', 'tH', 'consultation'), row(t(4), 'assistant', 'hub answer', 'tH')];
  const h = historyPage({ logEntries: [], archive: fakeArchive(rows), view: 'all', limit: 20 }).history;
  assert.deepStrictEqual(h.map(e => e.turn_id), [undefined, undefined, 'tH', undefined]);
});
