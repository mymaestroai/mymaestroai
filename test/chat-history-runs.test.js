'use strict';
// Hub-started turns in the main view: each run of consecutive hidden turns is ONE summary entry (role 'hidden_run'),
// and view=run fetches the entries behind one. Pure functions with injected deps (a fake archive).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { historyPage, runPage } = require('../lib/chat-history');

const T0 = Date.parse('2026-07-01T00:00:00Z');
const t = (n) => new Date(T0 + n * 1000).toISOString();
let n = 0;
const next = () => t(++n);
const user = (content, extra = {}) => ({ ts: next(), role: 'user', content, ...extra });
const asst = (content, extra = {}) => ({ ts: next(), role: 'assistant', content, ...extra });
const consult = (from, i) => [user(`[Consultation from agent "${from}"] q${i}`, { origin: { kind: 'consultation', from } }), asst(`a${i}`)];
const check = (name) => [user(`[Scheduled task — started by the hub scheduler] "${name}"`, { origin: { kind: 'schedule', from: name } }), asst('done')];
const none = { rowsBefore: () => [], forOwnerTurns: () => new Set(), lastMarkTs: () => null };
const runs = (h) => h.filter(e => e.role === 'hidden_run');

function fakeArchive(rows, owner = [], { cleared = null } = {}) {
  return {
    rowsBefore({ beforeId = null, beforeTs = null, afterTs = null, afterId = null, oldestFirst = false, kinds = ['user', 'assistant'], limit }) {
      return rows.filter(r => (beforeId == null || r.id < beforeId) && (afterId == null || r.id > afterId) && (!beforeTs || r.ts < beforeTs) && (!afterTs || r.ts > afterTs) && kinds.includes(r.kind))
        .sort((a, b) => (oldestFirst ? a.id - b.id : b.id - a.id)).slice(0, limit);
    },
    forOwnerTurns: (ids) => new Set(ids.filter(i => owner.includes(i))),
    lastMarkTs: (tool) => (tool === 'chat_cleared' ? cleared : null),
  };
}
let rid = 0;
const row = (ts, kind, text, turn, origin = 'user') => ({ id: ++rid, ts, kind, text, origin, turn_id: turn, meta: {} });

test('an all-hidden log is one summary entry with counts and from-names and no kept entries', () => {
  const log = [...consult('beacon', 1), ...consult('beacon', 2), ...consult('maestro', 3), ...check('nightly'),
    user('[Job finished] Job "build" done', { origin: { kind: 'job_notice', jobName: 'build' } }), asst('noted'),
    user('x', { origin: { kind: 'hand_off', from: 'scout' } }), asst('ok'), user('y', { origin: { kind: 'alert' } }), asst('ok')];
  const p = historyPage({ logEntries: log, archive: none, view: 'main', limit: 10 });
  assert.strictEqual(p.history.length, 1);
  const r = p.history[0];
  assert.strictEqual(r.role, 'hidden_run');
  assert.strictEqual(r.content, '');
  assert.strictEqual(r.ts, log[0].ts);
  assert.strictEqual(r.last_ts, log[log.length - 1].ts);
  assert.strictEqual(r.turns, 7);
  assert.deepStrictEqual(r.kinds, [
    { kind: 'consultation', from: 'beacon', n: 2 }, { kind: 'consultation', from: 'maestro', n: 1 }, { kind: 'schedule', from: null, n: 1 },
    { kind: 'job_notice', from: null, n: 1 }, { kind: 'hand_off', from: 'scout', n: 1 }, { kind: 'other', from: null, n: 1 }]);
  assert.strictEqual(p.next, null);
});

test('owner entries between consultations: summaries in place, in order; a for_owner turn splits two runs and is shown', () => {
  const log = [user('owner one'), asst('hi'), ...consult('beacon', 1), user('owner two'), asst('yes'),
    ...consult('beacon', 2), ...consult('sam', 3),
    user('[Scheduled task — started by the hub scheduler] "poll"', { origin: { kind: 'schedule', from: 'poll' } }), asst('please look', { for_owner: true }),
    ...consult('scout', 4)];
  const h = historyPage({ logEntries: log, archive: none, view: 'main', limit: 50 }).history;
  assert.deepStrictEqual(h.map(e => e.role === 'hidden_run' ? `run:${e.turns}` : e.content), [
    'owner one', 'hi', 'run:1', 'owner two', 'yes', 'run:2', '[Scheduled task — started by the hub scheduler] "poll"', 'please look', 'run:1']);
  assert.strictEqual(runs(h).length, 3);
  assert.deepStrictEqual(runs(h)[1].kinds, [{ kind: 'consultation', from: 'beacon', n: 1 }, { kind: 'consultation', from: 'sam', n: 1 }]);
});

test('limit counts kept entries only; hidden ones between them come along', () => {
  const log = [user('o1'), asst('r1'), ...consult('beacon', 1), ...consult('beacon', 2), user('o2'), asst('r2'), ...consult('sam', 3), user('o3'), asst('r3')];
  const p1 = historyPage({ logEntries: log, archive: none, view: 'main', limit: 2 });
  assert.deepStrictEqual(p1.history.map(e => e.content), ['o3', 'r3'], 'no run after o3: the page ends at its oldest kept entry');
  const p2 = historyPage({ logEntries: log, archive: none, view: 'main', limit: 2, before: p1.next });
  assert.deepStrictEqual(p2.history.map(e => e.role === 'hidden_run' ? 'run' : e.content), ['o2', 'r2', 'run'], 'two kept entries plus the run behind them');
  assert.strictEqual(p2.history.length - runs(p2.history).length, 2);
  const p3 = historyPage({ logEntries: log, archive: none, view: 'main', limit: 2, before: p2.next });
  assert.deepStrictEqual(p3.history.map(e => e.role === 'hidden_run' ? `run${e.turns}` : e.content), ['o1', 'r1', 'run2']);
  assert.strictEqual(p3.next, null);
});

test('a page with no kept entries still returns the summary, and next carries on', () => {
  const log = [user('owner'), asst('reply'), ...consult('beacon', 1), ...consult('beacon', 2)];
  const p = historyPage({ logEntries: log, archive: none, view: 'main', limit: 40 });
  assert.deepStrictEqual(p.history.map(e => e.role), ['user', 'assistant', 'hidden_run']);
  // a cursor placed at the owner entry: the page before it is empty, no summary and no next
  const q = historyPage({ logEntries: log, archive: none, view: 'main', limit: 5, before: `log:${log[0].ts}` });
  assert.deepStrictEqual(q.history, []);
  assert.strictEqual(q.next, null);
});

test('adjacent runs across the log/archive seam are one summary', () => {
  const rows = [row(t(1), 'user', 'owner early', 'o'), row(t(2), 'assistant', 'early reply', 'o'),
    row(t(3), 'user', '[Consultation from agent "beacon"] q', 'c1', 'consultation'), row(t(4), 'assistant', 'a', 'c1'),
    row(t(5), 'user', '[Scheduled task — started by the hub scheduler] "nightly"', 'c2', 'schedule'), row(t(6), 'assistant', 'done', 'c2')];
  const log = [...[user('[Consultation from agent "beacon"] q9', { origin: { kind: 'consultation', from: 'beacon' } }), asst('a9')].map(e => ({ ...e, ts: t(100 + (e.role === 'user' ? 0 : 1)) })),
    { ts: t(110), role: 'user', content: 'owner now' }, { ts: t(111), role: 'assistant', content: 'reply now' }];
  const h = historyPage({ logEntries: log, archive: fakeArchive(rows), view: 'main', limit: 20 }).history;
  assert.deepStrictEqual(h.map(e => e.role === 'hidden_run' ? 'run' : e.content), ['owner early', 'early reply', 'run', 'owner now', 'reply now']);
  const r = runs(h)[0];
  assert.strictEqual(r.turns, 3);
  assert.strictEqual(r.ts, t(3));
  assert.strictEqual(r.last_ts, t(101));
  assert.deepStrictEqual(r.kinds, [{ kind: 'consultation', from: 'beacon', n: 2 }, { kind: 'schedule', from: null, n: 1 }],
    'archive rows know no origin.from, but the text marker names the agent');
});

test('a page cut inside the archive keeps one run whole within the page', () => {
  const rows = [];
  rows.push(row(t(1), 'user', 'owner a', 'oa'), row(t(2), 'assistant', 'ra', 'oa'));
  for (let i = 0; i < 4; i++) rows.push(row(t(10 + i * 2), 'user', `[Consultation from agent "sam"] q${i}`, `c${i}`, 'consultation'), row(t(11 + i * 2), 'assistant', 'a', `c${i}`));
  rows.push(row(t(30), 'user', 'owner b', 'ob'), row(t(31), 'assistant', 'rb', 'ob'));
  const p1 = historyPage({ logEntries: [], archive: fakeArchive(rows), view: 'main', limit: 2 });
  assert.deepStrictEqual(p1.history.map(e => e.content), ['owner b', 'rb']);
  const p2 = historyPage({ logEntries: [], archive: fakeArchive(rows), view: 'main', limit: 2, before: p1.next });
  assert.deepStrictEqual(p2.history.map(e => e.role === 'hidden_run' ? `run${e.turns}` : e.content), ['owner a', 'ra', 'run4']);
});

test('view=all is unchanged: no summary entries, everything', () => {
  const log = [user('o'), asst('r'), ...consult('beacon', 1), ...consult('sam', 2)];
  const p = historyPage({ logEntries: log, archive: none, view: 'all', limit: 50 });
  assert.deepStrictEqual(p.history, log);
});

test('Clear hides older runs', () => {
  const rows = [row(t(1), 'user', '[Consultation from agent "beacon"] before', 'c1', 'consultation'), row(t(2), 'assistant', 'a', 'c1'),
    row(t(20), 'user', '[Consultation from agent "sam"] after', 'c2', 'consultation'), row(t(21), 'assistant', 'a', 'c2')];
  const h = historyPage({ logEntries: [], archive: fakeArchive(rows, [], { cleared: t(10) }), view: 'main', limit: 20 }).history;
  assert.strictEqual(h.length, 1);
  assert.deepStrictEqual(h[0].kinds, [{ kind: 'consultation', from: 'sam', n: 1 }]);
  assert.strictEqual(h[0].ts, t(20));
  const r = runPage({ logEntries: [], archive: fakeArchive(rows, [], { cleared: t(10) }), from: t(0), to: t(30) });
  assert.deepStrictEqual(r.history.map(e => e.content), ['[Consultation from agent "sam"] after', 'a']);
});

test('view=run returns exactly the run entries from the log', () => {
  const log = [user('owner'), asst('hi'), ...consult('beacon', 1), ...consult('sam', 2), user('owner two'), asst('yes'), ...consult('scout', 3)];
  const main = historyPage({ logEntries: log, archive: none, view: 'main', limit: 20 }).history;
  const [r1, r2] = runs(main);
  const a = runPage({ logEntries: log, archive: none, from: r1.ts, to: r1.last_ts });
  assert.deepStrictEqual(a.history, log.slice(2, 6));
  assert.strictEqual(a.more, false);
  const b = runPage({ logEntries: log, archive: none, from: r2.ts, to: r2.last_ts });
  assert.deepStrictEqual(b.history, log.slice(8));
  // the same entries view=all returns for that time
  const all = historyPage({ logEntries: log, archive: none, view: 'all', limit: 50 }).history;
  assert.deepStrictEqual(a.history, all.filter(e => e.ts >= r1.ts && e.ts <= r1.last_ts));
});

test('view=run reads the archive for times older than the log, and both', () => {
  const rows = [row(t(1), 'user', 'owner', 'o'), row(t(2), 'assistant', 'reply', 'o'),
    row(t(3), 'user', '[Consultation from agent "beacon"] q1', 'c1', 'consultation'), row(t(4), 'assistant', 'a1', 'c1'),
    row(t(5), 'user', '[Consultation from agent "beacon"] q2', 'c2', 'consultation'), row(t(6), 'assistant', 'a2', 'c2')];
  const log = [{ ts: t(7), role: 'assistant', content: 'a2 again' }, { ts: t(8), role: 'user', content: '[Consultation from agent "sam"] q3', origin: { kind: 'consultation', from: 'sam' } }, { ts: t(9), role: 'assistant', content: 'a3' },
    { ts: t(20), role: 'user', content: 'owner now' }];
  // only archive
  const a = runPage({ logEntries: log, archive: fakeArchive(rows), from: t(3), to: t(4) });
  assert.deepStrictEqual(a.history.map(e => e.content), ['[Consultation from agent "beacon"] q1', 'a1']);
  assert.ok(a.history.every(e => e.archived === true));
  // both
  const b = runPage({ logEntries: log, archive: fakeArchive(rows), from: t(5), to: t(9) });
  assert.deepStrictEqual(b.history.map(e => e.content), ['[Consultation from agent "beacon"] q2', 'a2', 'a2 again', '[Consultation from agent "sam"] q3', 'a3']);
  // the owner's own entries are never part of a run
  const none2 = runPage({ logEntries: log, archive: fakeArchive(rows), from: t(1), to: t(2) });
  assert.deepStrictEqual(none2.history, []);
});

test('a run after the log was trimmed still fetches, from the archive', () => {
  const rows = [row(t(3), 'user', '[Consultation from agent "beacon"] q1', 'c1', 'consultation'), row(t(4), 'assistant', 'a1', 'c1')];
  const full = [{ ts: t(3), role: 'user', content: '[Consultation from agent "beacon"] q1', origin: { kind: 'consultation', from: 'beacon' } }, { ts: t(4), role: 'assistant', content: 'a1' }, { ts: t(50), role: 'user', content: 'owner' }];
  const before = runPage({ logEntries: full, archive: fakeArchive(rows), from: t(3), to: t(4) });
  const trimmed = runPage({ logEntries: full.slice(2), archive: fakeArchive(rows), from: t(3), to: t(4) });
  assert.deepStrictEqual(before.history.map(e => e.content), trimmed.history.map(e => e.content));
  assert.strictEqual(trimmed.history.length, 2);
  assert.ok(trimmed.history.every(e => e.archived));
});

test('view=run caps at 200 entries and says more', () => {
  const log = [];
  for (let i = 0; i < 150; i++) log.push(...consult('beacon', i));   // 300 entries
  const p = runPage({ logEntries: log, archive: none, from: log[0].ts, to: log[log.length - 1].ts });
  assert.strictEqual(p.history.length, 200);
  assert.strictEqual(p.more, true);
  assert.deepStrictEqual(p.history, log.slice(0, 200));
  const q = runPage({ logEntries: log.slice(0, 200), archive: none, from: log[0].ts, to: log[199].ts });
  assert.strictEqual(q.more, false);
});

test('view=run: missing or non-time from/to is bad_range', () => {
  for (const [from, to] of [[undefined, t(1)], [t(1), undefined], ['x', t(1)], [t(1), 'soon'], [null, null], [t(5), t(1)]]) {
    assert.throws(() => runPage({ logEntries: [], archive: none, from, to }), /bad_range/);
  }
});

test('route: view=run is answered inside the query branch with bad_range 400, and the access check covers it (same agent path)', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const at = server.indexOf("if (/^\\/api\\/history\\/([^/]+)$/.test(pathname) && req.method === 'GET') {");
  const block = server.slice(at, server.indexOf("/api\\/session", at));
  assert.match(block, /hq\.get\('view'\) === 'run'/);
  assert.match(block, /runPage\(/);
  assert.match(block, /400, \{ error: 'bad_range' \}/);
  assert.ok(block.indexOf("=== 'run'") < block.indexOf('historyPage('));
  const access = require('../lib/access');
  // the route kind does not look at the query: a member's access check is the one every history view goes through
  const a = access.classifyRoute('/api/history/forge', 'GET');
  assert.strictEqual(a.kind, 'agent');
  assert.strictEqual(a.agent, 'forge');
  const gate = server.indexOf('canAccessAgent(');
  assert.ok(gate > 0 && gate < at, 'the agent access check runs before the history route');
});

// ── review r1 ──
const hubU = (ts, from, content = `[Consultation from agent "${from}"] q`) => ({ ts, role: 'user', content, origin: { kind: 'consultation', from } });
const plain = (ts, role, content) => ({ ts, role, content });

test('r1 B1: a two-turn run behind more than SCAN_MAX newer archive rows opens with both turns', () => {
  const rows = [row(t(1), 'user', 'owner', 'o'), row(t(2), 'assistant', 'reply', 'o'),
    row(t(3), 'user', '[Consultation from agent "beacon"] q1', 'c1', 'consultation'), row(t(4), 'assistant', 'a1', 'c1'),
    row(t(5), 'user', '[Consultation from agent "beacon"] q2', 'c2', 'consultation'), row(t(6), 'assistant', 'a2', 'c2')];
  for (let i = 0; i < 4600; i++) { rows.push(row(t(100 + i * 2), 'user', `owner ${i}`, `n${i}`)); rows.push(row(t(101 + i * 2), 'assistant', `r${i}`, `n${i}`)); }
  const log = [plain(t(20000), 'user', 'owner now')];
  const p = runPage({ logEntries: log, archive: fakeArchive(rows), from: t(3), to: t(5) });
  assert.deepStrictEqual(p.history.map(e => e.content), ['[Consultation from agent "beacon"] q1', 'a1', '[Consultation from agent "beacon"] q2', 'a2']);
  assert.notStrictEqual(p.incomplete, true);
});

test('r1 B1: the reply of the last turn saved after `to` comes along (archive read forward)', () => {
  const rows = [row(t(3), 'user', '[Consultation from agent "beacon"] q1', 'c1', 'consultation'), row(t(9), 'assistant', 'late answer', 'c1'),
    row(t(12), 'user', 'owner', 'o'), row(t(13), 'assistant', 'reply', 'o')];
  const log = [plain(t(50), 'user', 'owner now')];
  const p = runPage({ logEntries: log, archive: fakeArchive(rows), from: t(3), to: t(3) });
  assert.deepStrictEqual(p.history.map(e => e.content), ['[Consultation from agent "beacon"] q1', 'late answer']);
});

test('r1 B1: a read that gives up before reaching `from` says incomplete, not an empty run', () => {
  const rows = [row(t(3), 'user', '[Consultation from agent "beacon"] q1', 'c1', 'consultation'), row(t(4), 'assistant', 'a1', 'c1')];
  for (let i = 0; i < 4600; i++) rows.push(row(t(10 + i), 'assistant', `x${i}`, 'z'));   // 4600 rows (no user row) between the run and `to`
  const p = runPage({ logEntries: [plain(t(9000), 'user', 'owner now')], archive: fakeArchive(rows), from: t(3), to: t(5000) });
  assert.strictEqual(p.incomplete, true);
  assert.deepStrictEqual(p.history, []);
  assert.strictEqual(p.more, false);
});

test('r1 B2: two hidden turns at the same ms split by a kept owner message are two lines; each fetches only its own turn', () => {
  const X = t(10);
  const log = [hubU(X, 'beacon', '[Consultation from agent "beacon"] first'), plain(t(11), 'assistant', 'first answer'),
    plain(t(12), 'user', 'owner says'), plain(t(13), 'assistant', 'owner reply'),
    hubU(X, 'sam', '[Consultation from agent "sam"] second'), plain(t(14), 'assistant', 'second answer')];
  const h = historyPage({ logEntries: log, archive: none, view: 'main', limit: 20 }).history;
  const rs = runs(h);
  assert.strictEqual(rs.length, 2);
  assert.strictEqual(rs[0].ts, X); assert.strictEqual(rs[1].ts, X);
  assert.strictEqual(rs[0].rank, 0);
  assert.strictEqual(rs[1].rank, 1);
  const a = runPage({ logEntries: log, archive: none, from: rs[0].ts, to: rs[0].last_ts, rank: rs[0].rank });
  assert.deepStrictEqual(a.history.map(e => e.content), ['[Consultation from agent "beacon"] first', 'first answer']);
  const b = runPage({ logEntries: log, archive: none, from: rs[1].ts, to: rs[1].last_ts, rank: rs[1].rank });
  assert.deepStrictEqual(b.history.map(e => e.content), ['[Consultation from agent "sam"] second', 'second answer']);
  // a request without rank is rank 0
  assert.deepStrictEqual(runPage({ logEntries: log, archive: none, from: X, to: t(14) }).history.map(e => e.content), a.history.map(e => e.content));
});

test('r1 B2: a kept owner message inside [from, to] stops the block; a neighbouring block is never mixed in', () => {
  const log = [hubU(t(10), 'beacon'), plain(t(11), 'assistant', 'a1'), plain(t(12), 'user', 'owner'), plain(t(13), 'assistant', 'ok'),
    hubU(t(14), 'sam'), plain(t(15), 'assistant', 'a2')];
  const p = runPage({ logEntries: log, archive: none, from: t(10), to: t(15) });
  assert.deepStrictEqual(p.history, log.slice(0, 2));
  // the live path's widened range (start 2 s early) still gets one block
  const q = runPage({ logEntries: log, archive: none, from: t(8), to: t(17) });
  assert.deepStrictEqual(q.history, log.slice(0, 2));
});

test('r1 B2: a hidden prompt later than `to` ends the block; the rank parameter skips earlier prompts at exactly `from`', () => {
  const log = [hubU(t(10), 'beacon'), plain(t(11), 'assistant', 'a1'), hubU(t(20), 'sam'), plain(t(21), 'assistant', 'a2')];
  assert.deepStrictEqual(runPage({ logEntries: log, archive: none, from: t(10), to: t(11) }).history, log.slice(0, 2));
  const same = [hubU(t(10), 'beacon'), hubU(t(10), 'sam'), plain(t(11), 'assistant', 'a')];
  assert.deepStrictEqual(runPage({ logEntries: same, archive: none, from: t(10), to: t(11), rank: 1 }).history, same.slice(1));
  assert.deepStrictEqual(runPage({ logEntries: same, archive: none, from: t(10), to: t(11), rank: 0 }).history, same);
});
