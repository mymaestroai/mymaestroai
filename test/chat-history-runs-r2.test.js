'use strict';
// Review round 2 of the run lines (server): a run is named by its first prompt's turn id; the backward scan checks every
// row of a batch; the forward read walks on until the run is complete; a run over the cap returns whole turns.
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

test('r2 R1: each hidden_run carries the turn id of its first prompt; absent when that prompt has none', () => {
  const log = [hubU(t(1), 'scout', 'tA'), plain(t(2), 'assistant', 'a'), hubU(t(3), 'scout', 'tB'), plain(t(4), 'assistant', 'b'),
    plain(t(5), 'user', 'owner'), plain(t(6), 'assistant', 'ok'), hubU(t(7), 'scout'), plain(t(8), 'assistant', 'c')];
  const rs = runs(historyPage({ logEntries: log, archive: none, view: 'main', limit: 20 }).history);
  assert.strictEqual(rs.length, 2);
  assert.strictEqual(rs[0].turn, 'tA');
  assert.ok(!('turn' in rs[1]));
});

test('r2 R1: same-ms runs on two pages (Load earlier) each fetch their own block by turn', () => {
  const X = t(10);
  const log = [hubU(X, 'scout', 'tOld', '[Consultation from agent "scout"] first'), plain(t(11), 'assistant', 'first answer'),
    plain(t(12), 'user', 'owner says'), plain(t(13), 'assistant', 'owner reply'),
    hubU(X, 'sam', 'tNew', '[Consultation from agent "sam"] second'), plain(t(14), 'assistant', 'second answer'),
    plain(t(15), 'user', 'owner again'), plain(t(16), 'assistant', 'fine')];
  const p1 = historyPage({ logEntries: log, archive: none, view: 'main', limit: 3 });   // the newest page: the sam run and three kept entries
  const p2 = historyPage({ logEntries: log, archive: none, view: 'main', before: p1.next, limit: 10 });
  const newer = runs(p1.history)[0], older = runs(p2.history)[0];
  assert.ok(newer && older, 'a run on each page');
  assert.strictEqual(newer.turn, 'tNew'); assert.strictEqual(older.turn, 'tOld');
  const a = runPage({ logEntries: log, archive: none, from: older.ts, to: older.last_ts, turn: older.turn });
  const b = runPage({ logEntries: log, archive: none, from: newer.ts, to: newer.last_ts, turn: newer.turn });
  assert.deepStrictEqual(a.history.map(e => e.content), ['[Consultation from agent "scout"] first', 'first answer']);
  assert.deepStrictEqual(b.history.map(e => e.content), ['[Consultation from agent "sam"] second', 'second answer']);
});

test('r2 R1: a live line (previous run started 1 s earlier) fetches only its own block by turn, without any widening', () => {
  const log = [hubU(t(10), 'scout', 'tPrev'), plain(t(10.4), 'assistant', 'prev answer'), plain(t(10.6), 'user', 'owner'), plain(t(10.8), 'assistant', 'ok'),
    hubU(t(11), 'sam', 'tLive', '[Consultation from agent "sam"] live'), plain(t(11.5), 'assistant', 'live answer')];
  const p = runPage({ logEntries: log, archive: none, from: t(9), to: t(12), turn: 'tLive' });
  assert.deepStrictEqual(p.history.map(e => e.content), ['[Consultation from agent "sam"] live', 'live answer']);
  // and it still grows: to = now takes a second turn of the same block
  const grown = [...log, hubU(t(12), 'sam', 'tLive2', '[Consultation from agent "sam"] live two'), plain(t(12.5), 'assistant', 'live answer two')];
  assert.strictEqual(runPage({ logEntries: grown, archive: none, from: t(11), to: t(13), turn: 'tLive' }).history.length, 4);
});

test('r2 R1: a turn id with odd characters or over 100 characters is bad_turn', () => {
  const bad = (turn) => assert.throws(() => runPage({ logEntries: [], archive: none, from: t(1), to: t(2), turn }), /bad_turn/);
  bad('a b'); bad('a/b'); bad('x'.repeat(101)); bad('é');
  assert.doesNotThrow(() => runPage({ logEntries: [], archive: none, from: t(1), to: t(2), turn: 'ok-1_A'.padEnd(100, 'z') }));
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/bad_turn/.test(src) && /hq\.get\('turn'\)/.test(src), 'the route passes turn on and answers 400 bad_turn');
});

test('r2 R2: alternating prompt/reply rows where every 500-row batch ends on an assistant row still stop at the run\'s boundary', () => {
  // older rows alternate owner/reply; the run (a prompt and two replies) is the newest: newest first, a batch of 500 ends on an assistant row
  const rows = [];
  for (let i = 0; i < 3000; i++) { rows.push(row(t(i * 2), 'user', `owner ${i}`, `o${i}`)); rows.push(row(t(i * 2 + 1), 'assistant', `r${i}`, `o${i}`)); }
  rows.push(row(t(7000), 'user', '[Consultation from agent "scout"] q', 'c1', 'consultation'), row(t(7001), 'assistant', 'a1', 'c1'), row(t(7002), 'assistant', 'a1b', 'c1'));
  const p = runPage({ logEntries: [plain(t(9000), 'user', 'owner now')], archive: fakeArchive(rows), from: t(7000), to: t(7002), turn: 'c1' });
  assert.notStrictEqual(p.incomplete, true);
  assert.deepStrictEqual(p.history.map(e => e.content), ['[Consultation from agent "scout"] q', 'a1', 'a1b']);
});

test('r2 R2: the scan stops once ANY row of a batch is a user row older than `from`', () => {
  // the user row older than `from` sits in the MIDDLE of the first batch; the old check only looked at the batch's oldest row
  const rows = [];
  for (let i = 0; i < 1200; i++) rows.push(row(t(i), 'assistant', `old${i}`, 'z'));        // only replies older than the user row
  rows.push(row(t(1300), 'user', 'owner', 'o1'));
  rows.push(row(t(1400), 'user', '[Consultation from agent "scout"] q', 'c1', 'consultation'), row(t(1401), 'assistant', 'a1', 'c1'));
  rows.push(row(t(1450), 'user', 'owner next', 'o2'));
  for (let i = 0; i < 200; i++) rows.push(row(t(1500 + i), 'assistant', `newer${i}`, 'z2'));
  const calls = [];
  const arch = fakeArchive(rows); const orig = arch.rowsBefore.bind(arch);
  arch.rowsBefore = (o) => { calls.push(o); return orig(o); };
  const p = runPage({ logEntries: [plain(t(9000), 'user', 'owner now')], archive: arch, from: t(1400), to: t(1401), turn: 'c1' });
  assert.deepStrictEqual(p.history.map(e => e.content), ['[Consultation from agent "scout"] q', 'a1']);
  const back = calls.filter(c => !c.oldestFirst && c.afterId == null);
  assert.strictEqual(back.length, 1, `backward reads: ${back.length}`);
});

test('r2 R3: a prompt with replies at +10 s and +90 s both come back (the forward read keeps going)', () => {
  const rows = [row(t(3), 'user', '[Consultation from agent "scout"] q1', 'c1', 'consultation'), row(t(13), 'assistant', 'first reply', 'c1'), row(t(93), 'assistant', 'second reply', 'c1'),
    row(t(200), 'user', 'owner', 'o'), row(t(201), 'assistant', 'ok', 'o')];
  const p = runPage({ logEntries: [plain(t(500), 'user', 'owner now')], archive: fakeArchive(rows), from: t(3), to: t(3), turn: 'c1' });
  assert.deepStrictEqual(p.history.map(e => e.content), ['[Consultation from agent "scout"] q1', 'first reply', 'second reply']);
});

test('r2 R3: a forward walk over thousands of rows stops at RUN_CAP (more), never reads on to SCAN_MAX and never answers incomplete', () => {
  const rows = [row(t(3), 'user', '[Consultation from agent "scout"] q1', 'c1', 'consultation')];
  for (let i = 0; i < 4600; i++) rows.push(row(t(10 + i), 'assistant', `x${i}`, 'c1'));
  let reads = 0;
  const arch = fakeArchive(rows); const orig = arch.rowsBefore.bind(arch);
  arch.rowsBefore = (o) => { reads++; return orig(o); };
  const p = runPage({ logEntries: [plain(t(9000), 'user', 'owner now')], archive: arch, from: t(3), to: t(3), turn: 'c1' });
  assert.notStrictEqual(p.incomplete, true);
  assert.strictEqual(p.history.length, 200);
  assert.strictEqual(p.more, true);
  assert.ok(reads <= 4, 'the walk stopped after the first batch');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'chat-history.js'), 'utf8');
  assert.ok(/seen >= SCAN_MAX\) return \{ history: \[\], more: false, incomplete: true/.test(src), 'a forward walk that cannot finish within SCAN_MAX still answers incomplete');
});

test('r2 R7: a run bigger than the cap returns whole turns only (never a prompt without its replies)', () => {
  const log = [];
  for (let i = 0; i < 111; i++) { log.push(hubU(t(i * 2), 'scout', i === 0 ? 'tBig' : `t${i}`, `[Consultation from agent "scout"] q${i}`)); log.push(plain(t(i * 2 + 1), 'assistant', `a${i}`)); }
  const p = runPage({ logEntries: log, archive: none, from: t(0), to: t(222), turn: 'tBig' });
  assert.strictEqual(p.more, true);
  assert.strictEqual(p.history.length, 200);
  assert.strictEqual(p.history.filter(e => e.role === 'user').length, 100);
  // a cap that falls between a prompt and its reply gives the turn up whole
  const odd = [plain(t(0), 'user', 'x')];
  const log2 = [];
  for (let i = 0; i < 100; i++) { log2.push(hubU(t(i * 3), 'scout', i === 0 ? 'tOdd' : `u${i}`, `[Consultation from agent "scout"] q${i}`)); log2.push(plain(t(i * 3 + 1), 'assistant', `a${i}`)); log2.push(plain(t(i * 3 + 1.5), 'assistant', `b${i}`)); }
  const q = runPage({ logEntries: log2, archive: none, from: t(0), to: t(400), turn: 'tOdd' });
  assert.strictEqual(q.more, true);
  assert.ok(q.history.length <= 200);
  assert.strictEqual(q.history[q.history.length - 1].role, 'assistant');
  assert.strictEqual(q.history[q.history.length - 1].content.charAt(0), 'b', 'ends on a turn\'s last reply');
  assert.ok(odd.length === 1);
});

test('r2 R1: a hub-started prompt is saved to the chat log with its turn id (the line names the run by it)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(src, /\.\.\.\(logOrigin \? \{ turn_id: turnId \} : \{\}\)/);
  assert.ok(src.indexOf('const turnId = ephemeral ? null') < src.indexOf('...(logOrigin ? { turn_id: turnId }'), 'the id exists before the prompt is logged');
});
