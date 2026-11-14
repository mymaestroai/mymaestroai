'use strict';
// Paged, filtered chat history: the main-view rule, paging over the chat log and the archive behind it, the archive's
// two new reads (rowsBefore, forOwnerTurns) and the route wiring. Pure functions with injected deps; the archive test
// uses a temporary transcript folder only.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { filterMainView, historyPage, parseCursor } = require('../lib/chat-history');
const { createTranscript } = require('../lib/transcript');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-history-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let clock = Date.parse('2026-01-01T00:00:00Z');
const stamp = () => new Date((clock += 1000)).toISOString();
const user = (content, extra = {}) => ({ ts: stamp(), role: 'user', content, ...extra });
const asst = (content, extra = {}) => ({ ts: stamp(), role: 'assistant', content, ...extra });
const consult = (n) => [user(`[Consultation from agent "sam"] question ${n}`, { origin: { kind: 'consultation', from: 'sam' } }), asst(`answer ${n}`)];

test('filterMainView: the owner conversation stays, hub-started turns go unless marked for the owner', () => {
  const log = [
    user('owner hello'),                                                           // 0 kept
    asst('hi'),                                                                    // 1 kept
    ...consult(1), ...consult(2), ...consult(3),                                   // 2..7 hidden
    user('[Scheduled task — started by the hub scheduler] "nightly"', { origin: { kind: 'schedule', from: 'nightly' } }), // 8 kept (marked)
    asst('needs your decision', { for_owner: true }),                              // 9 kept
    user('mid-turn note', { origin: 'interjection' }),                             // 10 kept (the person's own)
    asst('noted'),                                                                 // 11 kept
    asst('Which one?', { ask: true }), user('the first', { ask: true }),           // 12, 13 kept
    user('[Job finished] Job "build" done', { origin: { kind: 'job_notice', jobName: 'build' } }), // 14 hidden
    asst('ok, noted the job'),                                                     // 15 hidden
    user('robin here again'),                                                      // 16 kept
    asst('welcome'),                                                               // 17 kept
    user('[Scheduled task — started by the hub scheduler] "poll"', { origin: { kind: 'schedule', from: 'poll' } }), // 18 running
    asst('working...', { inProgress: true }),                                      // 19 left out with its turn
  ];
  const keep = filterMainView(log);
  assert.deepStrictEqual(keep, [true, true, false, false, false, false, false, false, true, true, true, true, true, true, false, false, true, true, false, false]);
});

test('filterMainView: two hub user entries before the first reply are one turn; a hub entry after a reply starts the next', () => {
  const hub = (n) => user(`[Job finished] Job "j${n}" done`, { origin: { kind: 'job_notice' } });
  const keep = filterMainView([hub(1), hub(2), asst('one reply'), hub(3), asst('marked', { for_owner: true })]);
  assert.deepStrictEqual(keep, [false, false, false, true, true]);
});

test('historyPage: the main view reaches the earlier owner message in two requests over 500 hidden entries; all pages through everything', () => {
  const log = [user('owner one'), asst('reply one')];
  for (let i = 0; i < 250; i++) log.push(...consult(i));
  log.push(user('owner two'), asst('reply two'));
  assert.strictEqual(log.length, 504);
  const none = { rowsBefore: () => [], forOwnerTurns: () => new Set() };

  const p1 = historyPage({ logEntries: log, archive: none, view: 'main', limit: 2 });
  assert.deepStrictEqual(p1.history.map(e => e.content), ['owner two', 'reply two']);
  assert.ok(p1.next && p1.next.startsWith('log:'));
  const p2 = historyPage({ logEntries: log, archive: none, view: 'main', limit: 2, before: p1.next });
  assert.deepStrictEqual(p2.history.map(e => e.content), ['owner one', 'reply one']);
  assert.strictEqual(p2.next, null);

  const seen = [];
  let cursor = null, pages = 0;
  do {
    const p = historyPage({ logEntries: log, archive: none, view: 'all', limit: 200, before: cursor });
    seen.unshift(...p.history);
    cursor = p.next; pages++;
  } while (cursor);
  assert.strictEqual(pages, 3);
  assert.deepStrictEqual(seen.map(e => e.ts), log.map(e => e.ts));
});

test('historyPage: bad cursors throw, the newest page is the default, limit is clamped', () => {
  const none = { rowsBefore: () => [], forOwnerTurns: () => new Set() };
  const log = [user('a'), asst('b')];
  // changed (review r1): a chat-log cursor is a time, not a position, so a trim between two pages cannot shift it
  for (const bad of ['nope', 'log:-1', 'arc:x', 'log:1.5', 'log:3', 'log:2026-13-45T99:99:99Z']) assert.throws(() => historyPage({ logEntries: log, archive: none, before: bad }), /bad_cursor/);
  assert.deepStrictEqual(parseCursor('log:2026-01-01T00:00:03.000Z'), { kind: 'log', ts: '2026-01-01T00:00:03.000Z' });
  assert.deepStrictEqual(parseCursor('arc:top'), { kind: 'arc', id: null });
  assert.strictEqual(historyPage({ logEntries: log, archive: none, limit: 9999 }).history.length, 2);
  assert.strictEqual(historyPage({ logEntries: log, archive: none, limit: 0 }).history.length, 2);   // 0 -> default
  assert.strictEqual(historyPage({ logEntries: log, archive: none, limit: 1 }).history.length, 1);
});

// A fake archive over plain rows (oldest first, ids ascending).
function fakeArchive(rows, owner = [], { cleared = null } = {}) {
  const calls = [];
  return {
    calls,
    rowsBefore({ beforeId = null, beforeTs = null, afterTs = null, kinds = ['user', 'assistant'], limit }) {
      calls.push({ beforeId, beforeTs, afterTs, limit });
      return rows.filter(r => (beforeId == null || r.id < beforeId) && (!beforeTs || r.ts < beforeTs) && (!afterTs || r.ts > afterTs) && kinds.includes(r.kind))
        .sort((a, b) => b.id - a.id).slice(0, limit);
    },
    forOwnerTurns: (ids) => new Set(ids.filter(i => owner.includes(i))),
    lastMarkTs: (tool) => (tool === 'chat_cleared' ? cleared : null),
  };
}

// review r1 (GPT-6 BLOCK 1): the seam dedupe compared every archive row's text with the log's oldest entries, so an older
// "Yes" vanished whenever the log began with a "Yes"
test('historyPage: an older message with the same words as one at the start of the chat log is not dropped', () => {
  const t = (n) => new Date(Date.parse('2026-03-01T00:00:00Z') + n * 60000).toISOString();
  let id = 0;
  const row = (n, kind, text, turn) => ({ id: ++id, ts: t(n), kind, text, origin: 'user', turn_id: turn, meta: {} });
  const rows = [row(1, 'user', 'Yes', 'a'), row(2, 'assistant', 'Done.', 'a'), row(500, 'user', 'Yes', 'b'), row(500.5, 'assistant', 'Done.', 'b')];
  const log = [{ ts: t(500.6), role: 'user', content: 'Yes' }, { ts: t(500.7), role: 'assistant', content: 'Done.' }, { ts: t(600), role: 'user', content: 'later' }, { ts: t(601), role: 'assistant', content: 'ok' }];
  const p = historyPage({ logEntries: log, archive: fakeArchive(rows), view: 'all', limit: 50 });
  assert.deepStrictEqual(p.history.map(e => `${e.archived ? 'A' : 'L'}:${e.content}`), ['A:Yes', 'A:Done.', 'L:Yes', 'L:Done.', 'L:later', 'L:ok'],
    'the hours-old "Yes" stays; the copy within two minutes of the log (the same message kept twice) is dropped');
});

// review r1 (GPT-6 BLOCK 2): a position cursor shifted when the log was trimmed between two pages
test('historyPage: the chat-log cursor survives a trim of the log between two pages', () => {
  const t = (n) => new Date(Date.parse('2026-04-01T00:00:00Z') + n * 1000).toISOString();
  const full = Array.from({ length: 300 }, (_, i) => ({ ts: t(i), role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
  const archive = fakeArchive(full.map((e, i) => ({ id: i + 1, ts: e.ts, kind: e.role, text: e.content, origin: 'user', turn_id: `t${i >> 1}`, meta: {} })));
  const p1 = historyPage({ logEntries: full, archive, view: 'all', limit: 40 });
  assert.deepStrictEqual([p1.history[0].content, p1.history[39].content], ['m260', 'm299']);
  const trimmed = full.slice(-199).concat([{ ts: t(300), role: 'user', content: 'm300' }]);   // one new entry, the log cut to its newest 200
  const p2 = historyPage({ logEntries: trimmed, archive, view: 'all', limit: 40, before: p1.next });
  assert.deepStrictEqual([p2.history[0].content, p2.history[39].content], ['m220', 'm259'], 'the page just before m260, whatever the trim did');
  // a cursor older than everything left in the log goes on in the archive from that time
  const tiny = full.slice(-10);
  const p3 = historyPage({ logEntries: tiny, archive, view: 'all', limit: 5, before: `log:${t(100)}` });
  assert.deepStrictEqual(p3.history.map(e => e.content), ['m95', 'm96', 'm97', 'm98', 'm99']);
  assert.ok(p3.history.every(e => e.archived));
});

// review r1 (GPT-6 BLOCK 3): the log can start with the reply of a hub turn whose prompt was trimmed away
test('historyPage: a hub turn cut by the log trim (prompt only in the archive) stays out of the main view', () => {
  const t = (n) => new Date(Date.parse('2026-05-01T00:00:00Z') + n * 1000).toISOString();
  const rows = [
    { id: 1, ts: t(1), kind: 'user', text: 'owner earlier', origin: 'user', turn_id: 'o1', meta: {} },
    { id: 2, ts: t(2), kind: 'assistant', text: 'earlier answer', origin: 'user', turn_id: 'o1', meta: {} },
    { id: 3, ts: t(3), kind: 'user', text: '[Scheduled task — started by the hub scheduler] "x"', origin: 'schedule', turn_id: 's1', meta: {} },
  ];
  const log = [{ ts: t(4), role: 'assistant', content: 'scheduled answer, not for the owner' }, { ts: t(9), role: 'user', content: 'owner now' }, { ts: t(10), role: 'assistant', content: 'reply now' }];
  const p = historyPage({ logEntries: log, archive: fakeArchive(rows), view: 'main', limit: 50 });
  assert.ok(!p.history.some(e => /scheduled answer/.test(e.content)), 'the orphaned scheduled reply stays hidden');
  assert.deepStrictEqual(p.history.map(e => e.content), ['owner earlier', 'earlier answer', 'owner now', 'reply now']);
  // the same turn marked for the owner: its reply stays
  const q = historyPage({ logEntries: log, archive: fakeArchive(rows, ['s1']), view: 'main', limit: 50 });
  assert.ok(q.history.some(e => /scheduled answer/.test(e.content)));
  // an owner prompt before the cut: the reply is theirs
  const r = historyPage({ logEntries: log, archive: fakeArchive(rows.slice(0, 2)), view: 'main', limit: 50 });
  assert.ok(r.history.some(e => /scheduled answer/.test(e.content)));
});

// review r1 (Sonnet BLOCK 2): Clear deleted only the chat log, and the archive brought the cleared chat back
test('historyPage: nothing from before the last Clear comes back from the archive', () => {
  const t = (n) => new Date(Date.parse('2026-06-01T00:00:00Z') + n * 1000).toISOString();
  const rows = [
    { id: 1, ts: t(1), kind: 'user', text: 'before clear', origin: 'user', turn_id: 'a', meta: {} },
    { id: 2, ts: t(2), kind: 'assistant', text: 'old answer', origin: 'user', turn_id: 'a', meta: {} },
    { id: 3, ts: t(10), kind: 'user', text: 'after clear', origin: 'user', turn_id: 'b', meta: {} },
  ];
  const empty = historyPage({ logEntries: [], archive: fakeArchive(rows, [], { cleared: t(5) }), view: 'main' });
  assert.deepStrictEqual(empty.history.map(e => e.content), ['after clear']);
  assert.strictEqual(empty.next, null);
  const log = [{ ts: t(20), role: 'user', content: 'new chat' }];
  const p = historyPage({ logEntries: log, archive: fakeArchive(rows, [], { cleared: t(5) }), view: 'all', limit: 50 });
  assert.deepStrictEqual(p.history.map(e => e.content), ['after clear', 'new chat']);
  const never = historyPage({ logEntries: log, archive: fakeArchive(rows), view: 'all', limit: 50 });
  assert.strictEqual(never.history.length, 4, 'without a clear mark the archive goes all the way back');
});

test('historyPage: the archive continues behind the chat log, no duplicate at the seam, hidden turns hidden, for_owner kept, next null at the start', () => {
  clock = Date.parse('2026-02-01T00:00:00Z');
  const t = (n) => new Date(Date.parse('2026-01-01T00:00:00Z') + n * 1000).toISOString();
  let id = 0;
  const row = (n, kind, text, turn, origin = 'user') => ({ id: ++id, ts: t(n), kind, text, origin, turn_id: turn, meta: {} });
  const rows = [
    row(1, 'user', 'early owner question', 't1'),
    row(2, 'assistant', 'early answer', 't1'),
    row(3, 'user', '[Consultation from agent "sam"] hidden ask', 't2', 'consultation'),
    row(4, 'assistant', 'hidden answer', 't2'),
    row(5, 'user', '[Scheduled task — started by the hub scheduler] "nightly"', 't3', 'schedule'),
    row(6, 'assistant', 'please decide', 't3'),
    row(7, 'user', 'robin follows up', 't4', 'interjection'),
    row(8, 'user', 'owner message at the seam', 't5'),       // also in the chat log
    row(9, 'assistant', 'reply at the seam', 't5'),          // also in the chat log
  ];
  const log = [
    { ts: t(8.5), role: 'user', content: 'owner message at the seam' },
    { ts: t(8.9), role: 'assistant', content: 'reply at the seam' },
    { ts: t(20), role: 'user', content: 'owner now' },
    { ts: t(21), role: 'assistant', content: 'reply now' },
  ];
  const archive = fakeArchive(rows, ['t3']);
  const main = historyPage({ logEntries: log, archive, view: 'main', limit: 10 });
  assert.deepStrictEqual(main.history.map(e => e.content), [
    'early owner question', 'early answer', '[Scheduled task — started by the hub scheduler] "nightly"', 'please decide', 'robin follows up',
    'owner message at the seam', 'reply at the seam', 'owner now', 'reply now']);
  assert.strictEqual(main.next, null, 'the very start of the archive: nothing older');
  const arch = main.history.filter(e => e.archived);
  assert.strictEqual(arch.length, 5);
  assert.deepStrictEqual(main.history.slice(5).map(e => e.archived), [undefined, undefined, undefined, undefined]);
  assert.strictEqual(arch[3].for_owner, true);
  assert.deepStrictEqual(arch[2].origin, { kind: 'schedule' });
  assert.ok(!('origin' in arch[4]) && !('origin' in arch[0]), 'user and interjection rows carry no origin');
  assert.strictEqual(main.history.filter(e => e.content === 'owner message at the seam').length, 1, 'no duplicate at the seam');

  // the all view shows the hidden turn too
  const all = historyPage({ logEntries: log, archive: fakeArchive(rows, ['t3']), view: 'all', limit: 50 });
  assert.strictEqual(all.history.length, 11);
  assert.ok(all.history.some(e => e.content === 'hidden answer'));
  assert.strictEqual(all.next, null);

  // paging with the cut falling inside a marked turn: both halves stay
  const pages = [];
  let cursor = null;
  do {
    const p = historyPage({ logEntries: log, archive: fakeArchive(rows, ['t3']), view: 'main', limit: 2, before: cursor });
    pages.push(p);
    cursor = p.next;
  } while (cursor);
  assert.deepStrictEqual(pages.map(p => p.history.map(e => e.content)), [
    ['owner now', 'reply now'],
    ['owner message at the seam', 'reply at the seam'],
    ['please decide', 'robin follows up'],
    ['early answer', '[Scheduled task — started by the hub scheduler] "nightly"'],   // the cut fell between the marked turn's two rows
    ['early owner question'],
  ]);
  assert.strictEqual(pages[4].next, null);
});

test('historyPage: the archive scan is bounded: a short page comes back with next set', () => {
  // 30000 hidden consultation rows, no owner row: nothing is shown, the scan stops at its bound and `next` carries on
  const rows = [];
  for (let i = 1; i <= 30000; i++) rows.push({ id: i, ts: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 1000).toISOString(), kind: i % 2 ? 'user' : 'assistant', text: `t${i}`, origin: i % 2 ? 'consultation' : 'user', turn_id: `x${Math.ceil(i / 2)}`, meta: {} });
  const archive = fakeArchive(rows);
  const p = historyPage({ logEntries: [], archive, view: 'main', limit: 5 });
  assert.deepStrictEqual(p.history, []);
  assert.match(p.next, /^arc:\d+$/);
  assert.ok(Number(p.next.slice(4)) > 9000, 'the cursor moved back past the scanned rows');
  const reads = archive.calls.reduce((n, c) => n + c.limit, 0);
  assert.ok(reads <= 20000 + 1000, `reads bounded (${reads})`);
});

test('transcript.rowsBefore and forOwnerTurns read a real archive; unknown agent gives nothing', () => {
  const tr = createTranscript({ file: path.join(tmp, 'x.db'), now: () => (clock += 1000) });
  const a = tr.record({ agent: 'sam', kind: 'user', text: 'one', turnId: 'u1', origin: 'user' });
  tr.record({ agent: 'sam', kind: 'tool_use', tool: 'x', text: 'tool', turnId: 'u1' });
  const b = tr.record({ agent: 'sam', kind: 'assistant', text: 'two', turnId: 'u1', origin: 'user', meta: { k: 1 } });
  const c = tr.record({ agent: 'sam', kind: 'user', text: 'three', turnId: 'u2', origin: 'schedule' });
  tr.record({ agent: 'sam', kind: 'system', tool: 'for_owner', text: 'why', turnId: 'u2', origin: 'schedule', meta: { for_owner: true } });
  tr.record({ agent: 'robin', kind: 'user', text: 'other agent', turnId: 'u9' });
  const all = tr.rowsBefore('sam', { limit: 10 });
  assert.deepStrictEqual(all.map(r => r.text), ['three', 'two', 'one']);
  assert.deepStrictEqual(Object.keys(all[0]).sort(), ['id', 'kind', 'meta', 'origin', 'text', 'ts', 'turn_id']);
  assert.deepStrictEqual(all[1].meta, { k: 1 });
  assert.deepStrictEqual(tr.rowsBefore('sam', { beforeId: c, limit: 10 }).map(r => r.id), [b, a]);
  assert.deepStrictEqual(tr.rowsBefore('sam', { beforeId: c, limit: 1 }).map(r => r.id), [b]);
  assert.deepStrictEqual(tr.rowsBefore('sam', { beforeTs: all[1].ts, limit: 10 }).map(r => r.id), [a]);
  assert.deepStrictEqual(tr.rowsBefore('sam', { kinds: ['system'], limit: 10 }).map(r => r.kind), ['system']);
  assert.deepStrictEqual(tr.rowsBefore('nobody', { limit: 5 }), []);
  assert.deepStrictEqual([...tr.forOwnerTurns('sam', ['u1', 'u2', 'zz'])], ['u2']);
  assert.strictEqual(tr.forOwnerTurns('nobody', ['u2']).size, 0);
  assert.strictEqual(tr.forOwnerTurns('sam', []).size, 0);
  // and the pages read it end to end
  const p = historyPage({ logEntries: [], view: 'main', limit: 10, archive: { rowsBefore: (o) => tr.rowsBefore('sam', o), forOwnerTurns: (ids) => tr.forOwnerTurns('sam', ids) } });
  assert.deepStrictEqual(p.history.map(e => e.content), ['one', 'two', 'three']);
  assert.strictEqual(p.history[2].for_owner, undefined);   // a user row of a marked turn is kept, only the reply carries the flag
  assert.strictEqual(p.next, null);
  // review r1: Clear's mark (two the same day stay two rows) bounds what the pages read
  assert.strictEqual(tr.lastMarkTs('sam', 'chat_cleared'), null);
  const late = new Date(Date.now() + 60000).toISOString();
  tr.record({ agent: 'sam', kind: 'system', tool: 'chat_cleared', text: 'chat cleared', ts: late, dedupeKey: late });
  tr.record({ agent: 'sam', kind: 'system', tool: 'chat_cleared', text: 'chat cleared', ts: late, dedupeKey: late + 'x' });
  assert.strictEqual(tr.lastMarkTs('sam', 'chat_cleared'), late);
  assert.strictEqual(tr.rowsBefore('sam', { afterTs: late }).length, 0, 'nothing newer than the clear');
  const q = historyPage({ logEntries: [], view: 'main', limit: 10, archive: { rowsBefore: (o) => tr.rowsBefore('sam', o), forOwnerTurns: (ids) => tr.forOwnerTurns('sam', ids), lastMarkTs: (k) => tr.lastMarkTs('sam', k) } });
  assert.deepStrictEqual(q.history, []);
  assert.strictEqual(q.next, null);
  tr.close();
});

test('route and sdk-chat wiring: the no-query branch is the old code, the query branch answers historyPage, handleForOwner records the mark', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const at = server.indexOf("if (/^\\/api\\/history\\/([^/]+)$/.test(pathname) && req.method === 'GET') {");
  assert.ok(at > 0);
  const block = server.slice(at, server.indexOf("/api\\/session", at));
  const queryAt = block.indexOf("hq.has('view') || hq.has('limit') || hq.has('before')");
  assert.ok(queryAt > 0, 'the query branch is guarded by the three params');
  const old = block.indexOf('const history = loadConversationLog(name);');
  assert.ok(old > queryAt, 'the old code follows the guarded branch untouched');
  assert.match(block.slice(old), /^const history = loadConversationLog\(name\);[\s\S]*hubEv\.markInProgress\(history, hubEv\.events\.turnFor\(name\)\);\s*return jsonResponse\(res, 200, \{ history \}\);/);
  const branch = block.slice(queryAt, old);
  assert.match(branch, /historyPage\(/);
  assert.match(branch, /loadConversationLog\(name, 0\)/);
  assert.match(branch, /400, \{ error: 'bad_cursor' \}/);
  const sdk = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(sdk, /transcript\.record\(\{ agent: agentName, kind: 'system', tool: 'for_owner'[^\n]*meta: \{ for_owner: true \}, dedupeKey: turn\.turnId \}\)/);
  assert.match(sdk, /function clearConversation\(agentName\) \{[\s\S]{0,400}transcript\.record\(\{ agent: agentName, kind: 'system', tool: 'chat_cleared'[^\n]*dedupeKey: new Date\(\)\.toISOString\(\) \}\)/, 'Clear leaves a mark the paging honours');
  assert.match(branch, /lastMarkTs: \(tool\) => tr\.lastMarkTs\(name, tool\)/);
  const access = require('../lib/access');
  assert.ok(access, 'access module loads');
});
