'use strict';
// lib/mem-watch.js: the best-effort memory watchdog for computers with no systemd. A fake ps table and fake signals; nothing real runs.
// Identity is a platform birth identifier as an exact string: Linux /proc/<pid>/stat field 22, elsewhere ps's lstart (5 tokens).
const test = require('node:test');
const assert = require('node:assert');
const mw = require('../lib/mem-watch');
const GB = require('../lib/mem-limit').GB;

// identities in these tables are ps lstart-style strings (platform 'darwin'): the seconds field is the variable part
const L = (s) => `Mon Jan 1 00:00:${String(s).padStart(2, '0')} 2026`;
const row = (pid, ppid, pgid, kb, id = L(20)) => ({ pid, ppid, pgid, rssKb: kb, start: id });
const line = (pid, ppid, pgid, kb, s = 20) => `${pid} ${ppid} ${pgid} ${kb} ${L(s)}`;

test('parseTable reads pid ppid pgid rss and keeps what follows as the identity (single spaces)', () => {
  assert.deepStrictEqual(mw.parseTable('  10     1    10   2048\n 11 10 10 100\nnot a row\n'), [row(10, 1, 10, 2048, null), row(11, 10, 10, 100, null)]);
  assert.deepStrictEqual(mw.parseTable('10 1 10 2048   Mon  Jan  1 00:00:30 2026\n'), [row(10, 1, 10, 2048, 'Mon Jan 1 00:00:30 2026')]);
});

test('procStartTime: field 22 of /proc/<pid>/stat, with spaces and parentheses inside the comm field', () => {
  const tail = 'S 1 100 100 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 100 18446744073709551615';   // fields 3..: starttime is the 20th
  assert.strictEqual(mw.procStartTime(`100 (bash) ${tail}`), '987654');
  assert.strictEqual(mw.procStartTime(`100 (my (weird) name) ${tail}`), '987654', 'split after the LAST )');
  assert.strictEqual(mw.procStartTime(`100 (x) y) ${tail}`), '987654', 'everything up to the last ) is the name');
  assert.strictEqual(mw.procStartTime('garbage'), null);
  assert.strictEqual(mw.procStartTime('100 (x) S 1 2'), null);
});

// a /proc/<pid>/stat: after the name come state(3) ppid(4) pgid(5) ... starttime(22) ... rss(24, pages)
const pstat = (ppid, pgid, start, pages) => `1 (c d) S ${ppid} ${pgid} 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 1 ${pages} 1`;

test('readTable on Linux: ps only lists pids; every row (ppid, pgid, start, rss) comes from ONE stat read; a vanished pid is dropped; any other read problem drops that pid only', async () => {
  const exec = (cmd, args, o, cb) => { exec.args = args; cb(null, '100 999 999 999999\n101 999 999 999999\n102 999 999 999999\n'); };   // ps's own numbers are never used
  const reads = [];
  const read = async (pid) => { reads.push(pid); if (pid === 102) { const e = new Error('gone'); e.code = 'ENOENT'; throw e; } return pid === 100 ? pstat(1, 100, 1000, 1024) : pstat(100, 100, 1010, 2048); };
  const t = await mw.readTable(exec, { platform: 'linux', pageSize: 4096, readStat: read });
  assert.deepStrictEqual(exec.args, ['-A', '-o', 'pid=,ppid=,pgid=,rss=']);
  assert.deepStrictEqual(t, [row(100, 1, 100, 4096, '1000'), row(101, 100, 100, 8192, '1010')], 'rss pages x page size / 1024');
  assert.deepStrictEqual(reads.sort(), [100, 101, 102], 'one read per pid');
  const eacces = async (pid) => { if (pid === 101) { const e = new Error('no'); e.code = 'EACCES'; throw e; } return pstat(1, 100, 1000 + pid, 10); };
  const t2 = await mw.readTable(exec, { platform: 'linux', pageSize: 4096, readStat: eacces });
  assert.deepStrictEqual(t2.map(r => r.pid), [100, 102], 'EACCES on one pid: only that pid is dropped, the sample stays usable');
  const t3 = await mw.readTable(exec, { platform: 'linux', pageSize: 4096, readStat: async (pid) => (pid === 100 ? 'no parens here' : pstat(1, 100, 5, 1)) });
  assert.deepStrictEqual(t3.map(r => r.pid), [101, 102], 'an unparsable stat drops that pid only');
});

test('readTable on Linux: stat reads are bounded to 32 at a time', async () => {
  const lines = []; for (let p = 200; p < 300; p++) lines.push(`${p} 1 1 1`);
  const exec = (cmd, args, o, cb) => cb(null, lines.join('\n') + '\n');
  let active = 0, peak = 0;
  const t = await mw.readTable(exec, { platform: 'linux', pageSize: 4096, readStat: async (pid) => { active++; peak = Math.max(peak, active); await new Promise(r => setImmediate(r)); active--; return pstat(1, 1, pid, 1); } });
  assert.strictEqual(t.length, 100);
  assert.ok(peak <= 32 && peak > 1, `peak ${peak}`);
});

test('readTable on Linux reads this very process: a real /proc starttime', async () => {
  if (process.platform !== 'linux') return;
  const { execFile } = require('child_process');
  const t = await mw.readTable(execFile, { platform: 'linux' });
  const me = t.find(r => r.pid === process.pid);
  assert.ok(me && /^\d+$/.test(me.start), 'a numeric starttime for our own pid');
});

test('readTable elsewhere: ps lstart is the identity (5 tokens); a ps error, or a row without one, makes the sample unusable', async () => {
  const mk = (out, err = null) => (cmd, args, o, cb) => { mk.args = args; cb(err, out); };
  const t = await mw.readTable(mk(`${line(100, 1, 100, 5)}\n`), { platform: 'darwin' });
  assert.deepStrictEqual(mk.args, ['-A', '-o', 'pid=,ppid=,pgid=,rss=,lstart=']);
  assert.deepStrictEqual(t, [row(100, 1, 100, 5, L(20))]);
  assert.strictEqual(await mw.readTable(mk(`${line(100, 1, 100, 5)}\n101 100 100 5\n`), { platform: 'darwin' }), null, 'a row with no identity');
  assert.strictEqual(await mw.readTable(mk('101 100 100 5 Mon Jan 1\n'), { platform: 'darwin' }), null, 'a short lstart');
  assert.strictEqual(await mw.readTable(mk(`${line(100, 1, 100, 5)}\n`, new Error('ps failed')), { platform: 'darwin' }), null, 'an error from ps, even with output');
});

test('measure: the process, its descendants and its group; a reparented process stays counted', () => {
  const seen = new Map();
  let t = [row(100, 1, 100, 1000), row(101, 100, 100, 2000), row(102, 101, 102, 4000), row(200, 1, 200, 99999)];
  assert.strictEqual(mw.measure(t, 100, 100, seen), 7000 * 1024);
  // 102 is handed to init and leaves the group: still counted, it was seen
  t = [row(100, 1, 100, 1000), row(102, 1, 102, 4000), row(200, 1, 200, 99999)];
  assert.strictEqual(mw.measure(t, 100, 100, seen), 5000 * 1024);
  t = [row(100, 1, 100, 1000), row(200, 1, 200, 99999)];
  assert.strictEqual(mw.measure(t, 100, 100, seen), 1000 * 1024);
  t = [row(100, 1, 100, 1000), row(102, 1, 102, 77, L(40)), row(200, 1, 200, 5)];
  assert.strictEqual(mw.measure(t, 100, 100, seen), 1000 * 1024, 'a reused pid under init is not counted');
});

test('measure: descendants are walked from every verified member, so a renderer started by a reparented helper counts', () => {
  const seen = new Map();
  let t = [row(100, 1, 100, 1000), row(102, 100, 102, 2000)];
  assert.strictEqual(mw.measure(t, 100, 0, seen), 3000 * 1024);
  // the helper 102 is handed to init (and leaves the tree), then starts a renderer 300
  t = [row(100, 1, 100, 1000), row(102, 1, 102, 2000), row(300, 102, 300, 8000), row(301, 300, 300, 1000)];
  assert.strictEqual(mw.measure(t, 100, 0, seen), 12000 * 1024, 'the renderer below the reparented helper is counted');
});

test('identity is an exact match: any difference (even 1 s) is a different process; a missing identity is never the same', () => {
  const seen = new Map();
  let t = [row(100, 1, 100, 1000, L(50)), row(102, 100, 100, 2000, L(51))];
  assert.strictEqual(mw.measure(t, 100, 100, seen), 3000 * 1024);
  // 102 has the same pid, one second later: the old ±2 s tolerance would have called it the same process
  t = [row(100, 1, 100, 1000, L(50)), row(102, 1, 102, 9000, L(52))];
  assert.strictEqual(mw.measure(t, 100, 100, seen), 1000 * 1024);
  assert.deepStrictEqual([...seen.keys()], [100]);
  assert.strictEqual(mw.sameProcess(L(50), row(100, 1, 100, 1, L(50))), true);
  assert.strictEqual(mw.sameProcess(L(50), row(100, 1, 100, 1, L(51))), false);
  assert.strictEqual(mw.sameProcess(null, row(100, 1, 100, 1, null)), false, 'unknown on both sides is NOT the same');
  assert.strictEqual(mw.sameProcess('', row(100, 1, 100, 1, '')), false);
  assert.strictEqual(mw.measure([row(100, 1, 100, 1000, null)], 100, 100, new Map()), 0, 'a row with no identity is never counted');
});

function watchWith(table, extra = {}) {
  const sent = [], stops = [], timers = [], execs = [];
  const exec = (cmd, args, o, cb) => { execs.push(args); cb(null, typeof table.v === 'function' ? table.v() : table.v); };
  const w = mw.watch(100, {
    limitBytes: 3 * GB, group: 100, exec, platform: 'darwin', kill: (p, s) => sent.push([p, s]), onStop: (t) => stops.push(t),
    setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {},
    setTimeoutImpl: (f, ms) => { const t = { f, ms, cleared: false, unref() {} }; timers.push(t); return t; },
    clearTimeoutImpl: (t) => { t.cleared = true; }, ...extra,
  });
  return { w, sent, stops, timers, execs };
}
const T = (...rows) => rows.join('\n') + '\n';

test('watch: past the limit the group gets SIGTERM, SIGKILL after 3 s, one notice; under the limit nothing happens', async () => {
  const table = { v: T(line(100, 1, 100, 1048576), line(101, 100, 100, 1048576)) };   // 2 GB
  const { w, sent, stops, timers, execs } = watchWith(table);
  await w.tick();
  assert.deepStrictEqual(execs[0], ['-A', '-o', 'pid=,ppid=,pgid=,rss=,lstart=']);
  assert.deepStrictEqual(sent, []); assert.deepStrictEqual(stops, []);
  table.v = T(line(100, 1, 100, 3145728), line(101, 100, 100, 1048576));       // 3 GB + 1 GB
  await w.tick();
  assert.deepStrictEqual(sent.filter(k => k[0] === -100), [[-100, 'SIGTERM']]);
  assert.ok(sent.some(k => k[0] === 101 && k[1] === 'SIGTERM'));
  assert.strictEqual(timers[0].ms, 3000);
  await timers[0].f();
  assert.ok(sent.some(k => k[0] === -100 && k[1] === 'SIGKILL'));
  assert.deepStrictEqual(stops, ['stopped: it used more than 3 GB of memory (best effort, checked every 2 s)']);
  await w.tick();
  assert.strictEqual(stops.length, 1, 'once');
});

test('watch: before SIGKILL ps is read again; a member that is gone or is a different process is never signalled', async () => {
  const table = { v: T(line(100, 1, 100, 3145728), line(101, 100, 100, 1048576), line(102, 100, 100, 1024)) };
  const { w, sent, timers } = watchWith(table);
  await w.tick();
  assert.ok(timers.length === 1);
  sent.length = 0;
  // during the grace: 101 exited and its pid was reused by an unrelated process (a different start), 102 is the same process, 100 is the same
  table.v = T(line(100, 1, 100, 3145728), line(101, 1, 500, 10, 59), line(102, 100, 100, 1024));
  await timers[0].f();
  assert.ok(sent.some(k => k[0] === 102 && k[1] === 'SIGKILL'));
  assert.ok(sent.some(k => k[0] === -100 && k[1] === 'SIGKILL'));
  assert.ok(!sent.some(k => k[0] === 101), 'a reused pid is never signalled');
});

test('watch: a start one second off is a different process at the SIGKILL stage (exact identity)', async () => {
  const table = { v: T(line(100, 1, 100, 3145728), line(101, 100, 100, 1024)) };
  const { w, sent, timers } = watchWith(table);
  await w.tick();
  sent.length = 0;
  table.v = T(line(100, 1, 100, 3145728), line(101, 100, 100, 1024, 21));
  await timers[0].f();
  assert.ok(!sent.some(k => k[0] === 101), '1 s apart is somebody else');
});

test('watch: an unusable sample at the SIGKILL stage signals nothing', async () => {
  const table = { v: T(line(100, 1, 100, 3145800)) };
  const { w, sent, timers } = watchWith(table);
  await w.tick();
  sent.length = 0;
  table.v = '100 1 100 3145728\n';   // no identity
  await timers[0].f();
  assert.deepStrictEqual(sent, []);
});

test('watch: an unusable sample (ps without identity) is never measured: nothing trips, nothing is signalled', async () => {
  const table = { v: '100 1 100 9999999\n' };
  const { w, sent, stops, timers } = watchWith(table);
  await w.tick();
  assert.deepStrictEqual(sent, []); assert.deepStrictEqual(stops, []); assert.strictEqual(timers.length, 0);
});

test('watch: the group is not signalled when its leader is no longer the same process', async () => {
  const table = { v: T(line(100, 1, 100, 3145728), line(101, 100, 100, 1024)) };
  const { w, sent, timers } = watchWith(table);
  await w.tick();
  sent.length = 0;
  table.v = T(line(100, 1, 100, 10, 58), line(101, 100, 100, 1024));   // 100 was reused by something that started later
  await timers[0].f();
  assert.ok(!sent.some(k => k[0] === -100), 'the leader is someone else now: no group signal');
  assert.ok(!sent.some(k => k[0] === 100), 'and no signal to the reused pid');
  assert.ok(sent.some(k => k[0] === 101 && k[1] === 'SIGKILL'));
});

test('watch: stop() before the limit is reached cancels nothing it never started; after a trip stop() does NOT cancel the SIGKILL stage', async () => {
  const table = { v: T(line(100, 1, 100, 3145800), line(101, 100, 100, 1024)) };
  const { w, sent, timers } = watchWith(table);
  await w.tick();
  assert.strictEqual(timers.length, 1); assert.strictEqual(timers[0].cleared, false);
  w.stop();
  assert.strictEqual(timers[0].cleared, false, 'the escalation finishes on its own');
  sent.length = 0;
  await timers[0].f();   // the grace ends after stop(): the still-verified members get SIGKILL
  assert.ok(sent.some(k => k[0] === 101 && k[1] === 'SIGKILL'));
  assert.ok(sent.some(k => k[0] === -100 && k[1] === 'SIGKILL'));
});

test('watch on Linux: the identity comes from /proc, and a reused pid (a different starttime) is not signalled', async () => {
  const sent = [], timers = [];
  let ticks = { 100: 5000, 101: 5001 };
  const stat = (n, p) => (p === 100 ? pstat(1, 100, n, 786432) : pstat(100, 100, n, 256));   // 786432 pages x 4 KB = 3 GB
  const exec = (cmd, args, o, cb) => cb(null, '100 1 100 1\n101 100 100 1\n');
  const w = mw.watch(100, { limitBytes: 2 * GB, group: 100, exec, platform: 'linux', pageSize: 4096, readStat: async (p) => stat(ticks[p], p), kill: (p, s) => sent.push([p, s]),
    setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {}, setTimeoutImpl: (f, ms) => { const t = { f, ms, unref() {} }; timers.push(t); return t; } });
  await w.tick();
  assert.ok(sent.some(k => k[0] === 101 && k[1] === 'SIGTERM'));
  sent.length = 0;
  ticks = { 100: 5000, 101: 5002 };   // 101 is a different process now (one clock tick later)
  await timers[0].f();
  assert.ok(!sent.some(k => k[0] === 101), 'a different starttime: not signalled');
  assert.ok(sent.some(k => k[0] === 100 && k[1] === 'SIGKILL'));
});

test('one shared sampler: a single ps run per interval for every watcher; it starts with the first and stops with the last', async () => {
  let runs = 0, ticker = null, cleared = 0;
  const exec = (cmd, args, o, cb) => { runs++; cb(null, `${line(100, 1, 100, 1024)}\n${line(200, 1, 200, 1024)}\n`); };
  const sampler = mw.createSampler({ exec, platform: 'darwin', setIntervalImpl: (f) => { ticker = f; return { unref() {} }; }, clearIntervalImpl: () => { cleared++; } });
  assert.strictEqual(sampler.running(), false);
  const stops = [];
  const a = mw.watch(100, { limitBytes: GB, sampler, kill: () => {}, onStop: (t) => stops.push(['a', t]) });
  const b = mw.watch(200, { limitBytes: 1, sampler, kill: () => {}, onStop: (t) => stops.push(['b', t]), setTimeoutImpl: () => ({ unref() {} }) });
  assert.strictEqual(sampler.running(), true); assert.strictEqual(sampler.size(), 2);
  assert.ok(ticker);
  await sampler.tick();
  assert.strictEqual(runs, 1, 'two watchers, one ps');
  assert.deepStrictEqual(stops.map(s => s[0]), ['b'], 'the interval table reaches every watcher');
  a.stop();
  assert.strictEqual(sampler.size(), 0, 'b stopped itself at the limit; a was the last');
  assert.strictEqual(sampler.running(), false);
  assert.strictEqual(cleared, 1, 'stopped with the last watcher');
  b.stop();
});

test('the sampler takes `now` before the read starts (a slow ps never makes a table look fresher)', async () => {
  let t = 1000, runs = 0, release = null;
  const exec = (cmd, args, o, cb) => { runs++; release = () => cb(null, `${line(100, 1, 100, 1)}\n`); };
  const s = mw.createSampler({ exec, platform: 'darwin', now: () => t, setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {} });
  const p = s.read({ fresh: true });
  t = 1900; release(); await p;   // the read started at 1000 and ended at 1900
  t = 2050;                        // 1050 ms after it started (150 ms after it ended): too old to share
  const q = s.read();
  release(); await q;
  assert.strictEqual(runs, 2, 'the table is as old as its start; stamped at its end it would have been shared');
});

test('the default interval is 2 s', () => {
  let ms = null;
  const w = mw.watch(1, { limitBytes: GB, setIntervalImpl: (f, n) => { ms = n; return { unref() {} }; }, clearIntervalImpl: () => {} });
  assert.strictEqual(ms, 2000);
  w.stop();
});

test('stoppedText says best effort', () => {
  assert.strictEqual(mw.stoppedText(48 * GB), 'stopped: it used more than 48 GB of memory (best effort, checked every 2 s)');
});

// ── round 7: unreadable is not vanished ──
test('readTable: ENOENT/ESRCH = vanished (dropped); any other read error = unreadable (table.unreadable), kept out of the rows', async () => {
  const exec = (cmd, args, o, cb) => cb(null, '100 1 100 1\n101 1 100 1\n102 1 100 1\n');
  const t = await mw.readTable(exec, { platform: 'linux', pageSize: 4096, readStat: async (pid) => {
    if (pid === 101) { const e = new Error('gone'); e.code = 'ESRCH'; throw e; }
    if (pid === 102) { const e = new Error('fds'); e.code = 'EMFILE'; throw e; }
    return pstat(1, 100, 5, 1); } });
  assert.deepStrictEqual(t.map(r => r.pid), [100]);
  assert.deepStrictEqual([...t.unreadable], [102]);
});

test('counted / liveMembers: an unreadable member keeps its identity in `seen`, is not counted or signalled, and the live count is unknown (null) until it reads again', async () => {
  const seen = new Map([[100, '5'], [101, '6']]); seen.rootAdded = true;
  let fail = true;
  const exec = (cmd, args, o, cb) => cb(null, '100 1 100 1\n101 100 100 1\n');
  const o = { platform: 'linux', pageSize: 4096, readStat: async (pid) => { if (pid === 101 && fail) { const e = new Error('x'); e.code = 'EMFILE'; throw e; } return pid === 100 ? pstat(1, 100, 5, 256) : pstat(100, 100, 6, 256); } };
  assert.strictEqual(await mw.liveMembers(100, 100, seen, exec, o), null, 'unknown, never 1 or 0');
  assert.strictEqual(seen.get(101), '6', 'the saved identity is kept');
  assert.deepStrictEqual(await mw.memberPids(100, 100, seen, exec, o), [100], 'never signalled this sample');
  const table = await mw.readTable(exec, o);
  assert.strictEqual(mw.measure(table, 100, 100, seen), 256 * 4096, 'its memory is not counted this sample');
  fail = false;
  assert.strictEqual(await mw.liveMembers(100, 100, seen, exec, o), 2, 'the next poll retries');
  // a vanished member (ENOENT) is dropped and the count is known
  const gone = { ...o, readStat: async (pid) => { if (pid === 101) { const e = new Error('x'); e.code = 'ENOENT'; throw e; } return pstat(1, 100, 5, 1); } };
  assert.strictEqual(await mw.liveMembers(100, 100, seen, exec, gone), 1);
  assert.strictEqual(seen.has(101), false);
});

test('page size: getconf, else AT_PAGESZ from auxv, else null (no guess, nothing cached): the sample is unusable and the next one retries', async () => {
  const bad = () => { throw new Error('no getconf'); };
  assert.strictEqual(mw.getPageSize({ getconf: () => '16384\n', auxv: bad }), 16384);
  const pair = (type, val) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(BigInt(type), 0); b.writeBigUInt64LE(BigInt(val), 8); return b; };
  if (process.arch.endsWith('64') && require('os').endianness() === 'LE') {
    const auxv = Buffer.concat([pair(33, 123), pair(6, 65536), pair(0, 0)]);
    assert.strictEqual(mw.getPageSize({ getconf: bad, auxv: () => auxv }), 65536, 'AT_PAGESZ (type 6)');
    assert.strictEqual(mw.getPageSize({ getconf: bad, auxv: () => Buffer.concat([pair(33, 1), pair(0, 0)]) }), null, 'no AT_PAGESZ entry');
  }
  assert.strictEqual(mw.getPageSize({ getconf: bad, auxv: bad }), null);
  // readTable: no page size -> null; once a reader works, the very next sample succeeds (nothing was cached)
  const exec = (cmd, args, o, cb) => cb(null, '100 1 100 1\n');
  let ok = false;
  const readers = { getconf: () => { if (!ok) throw new Error('x'); return '4096'; }, auxv: bad };
  const base = { platform: 'linux', readStat: async () => pstat(1, 100, 5, 2), pageReaders: readers };
  assert.strictEqual(await mw.readTable(exec, base), null);
  ok = true;
  const t = await mw.readTable(exec, base);
  assert.strictEqual(t[0].rssKb, 8);
});

// ── round 8: trust only what is verified in the CURRENT sample ──
const unreadableTable = (rows, pids) => { Object.defineProperty(rows, 'unreadable', { value: new Set(pids), enumerable: false }); return rows; };
const EMFILE = () => { const e = new Error('too many open files'); e.code = 'EMFILE'; return e; };

test('round 8: an unreadable member (identity kept in seen) never anchors the descendant walk', () => {
  const seen = new Map();
  assert.strictEqual(mw.measure([row(100, 1, 100, 1000), row(102, 100, 102, 2000)], 100, 0, seen), 3000 * 1024);
  // 102 can't be read now; 300 (a child of pid 102) is new: it is not a verified member's child, so it is not counted
  const t = unreadableTable([row(100, 1, 100, 1000), row(300, 102, 300, 8000)], [102]);
  assert.strictEqual(mw.measure(t, 100, 0, seen), 1000 * 1024);
  assert.ok(seen.has(102), 'its saved identity is kept for the retry');
  assert.strictEqual(seen.has(300), false);
});

test('round 8: the group is signalled only when its leader is verified in the tripping sample', async () => {
  const sent = [], timers = [];
  let second = false;
  const exec = (cmd, args, o, cb) => cb(null, '100 1 100 1\n101 100 100 1\n');
  const readStat = async (p) => {
    if (p === 100 && second) throw EMFILE();
    return p === 100 ? pstat(1, 100, 5000, 256) : pstat(100, 100, 5001, second ? 786432 : 256);   // 3 GB on the second sample
  };
  const w = mw.watch(100, { limitBytes: 2 * GB, group: 100, exec, platform: 'linux', pageSize: 4096, readStat, kill: (p, s) => sent.push([p, s]),
    setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {}, setTimeoutImpl: (f, ms) => { const t = { f, ms, unref() {} }; timers.push(t); return t; } });
  await w.tick();   // under the limit: 100 and 101 are remembered
  assert.deepStrictEqual(sent, []);
  second = true;    // the leader can't be read now, 101 is over the limit
  await w.tick();
  assert.ok(sent.some(k => k[0] === 101 && k[1] === 'SIGTERM'));
  assert.ok(!sent.some(k => k[0] === -100), 'an unreadable leader: no group signal');
  assert.ok(!sent.some(k => k[0] === 100), 'and no signal to the unreadable pid');
});

function escalationWatch(failFor) {
  const sent = [], timers = [];
  const st = { phase: 0, fails: 0 };
  const exec = (cmd, args, o, cb) => cb(null, '100 1 100 1\n101 100 100 1\n');
  const readStat = async (p) => {
    if (p === 101 && st.phase === 1 && st.fails < failFor) { st.fails++; throw EMFILE(); }
    return p === 100 ? pstat(1, 100, 5000, 786432) : pstat(100, 100, 5001, 256);   // 100 alone is over 2 GB
  };
  const w = mw.watch(100, { limitBytes: 2 * GB, group: 100, exec, platform: 'linux', pageSize: 4096, readStat, kill: (p, s) => sent.push([p, s]),
    setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {}, setTimeoutImpl: (f, ms) => { const t = { f, ms, unref() {} }; timers.push(t); return t; } });
  return { w, sent, timers, st };
}

test('round 8: the SIGKILL read fails for the helper once (EMFILE): it is retried after 1 s and then gets SIGKILL', async () => {
  const { w, sent, timers, st } = escalationWatch(1);
  await w.tick();
  assert.ok(sent.some(k => k[0] === 101 && k[1] === 'SIGTERM'));
  assert.strictEqual(timers.length, 1); assert.strictEqual(timers[0].ms, 3000);
  sent.length = 0; st.phase = 1;
  await timers[0].f();   // the helper is unreadable: only the readable members get SIGKILL, and a retry is scheduled
  assert.ok(!sent.some(k => k[0] === 101), 'an unreadable member is never signalled');
  assert.strictEqual(timers.length, 2); assert.strictEqual(timers[1].ms, 1000);
  sent.length = 0;
  await timers[1].f();
  assert.ok(sent.some(k => k[0] === 101 && k[1] === 'SIGKILL'), 'its saved identity matched once readable');
  assert.strictEqual(timers.length, 2, 'nothing unaccounted for: no further retry');
});

test('round 8: the SIGKILL retry is bounded (10 reads in all) and stops when the helper has vanished', async () => {
  const a = escalationWatch(1000);
  await a.w.tick(); a.st.phase = 1;
  for (let i = 0; i < 20 && a.timers[i]; i++) await a.timers[i].f();
  assert.strictEqual(a.timers.length, 10, 'the grace timer plus 9 retries: 10 reads');
  // a helper that is gone (ENOENT) is not retried
  const sent = [], timers = [];
  let gone = false;
  const exec = (cmd, args, o, cb) => cb(null, '100 1 100 1\n101 100 100 1\n');
  const readStat = async (p) => { if (p === 101 && gone) { const e = new Error('gone'); e.code = 'ENOENT'; throw e; } return p === 100 ? pstat(1, 100, 5000, 786432) : pstat(100, 100, 5001, 256); };
  const w = mw.watch(100, { limitBytes: 2 * GB, group: 100, exec, platform: 'linux', pageSize: 4096, readStat, kill: (p, s) => sent.push([p, s]),
    setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {}, setTimeoutImpl: (f, ms) => { const t = { f, ms, unref() {} }; timers.push(t); return t; } });
  await w.tick(); gone = true;
  await timers[0].f();
  assert.strictEqual(timers.length, 1, 'vanished: no retry');
});

test('round 8: a stat that reads but does not parse is unreadable (kept), not vanished', async () => {
  const exec = (cmd, args, o, cb) => cb(null, '100 1 100 1\n101 1 100 1\n102 1 100 1\n');
  const t = await mw.readTable(exec, { platform: 'linux', pageSize: 4096, readStat: async (pid) => {
    if (pid === 101) return 'no parens here';
    if (pid === 102) return '1 (c) S x y 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 nope 1 10 1';   // NaN pgid and a non-numeric start
    return pstat(1, 100, 5, 1); } });
  assert.deepStrictEqual(t.map(r => r.pid), [100]);
  assert.deepStrictEqual([...t.unreadable].sort(), [101, 102]);
  const seen = new Map([[100, '5'], [101, '6']]); seen.rootAdded = true;
  assert.strictEqual(await mw.liveMembers(100, 100, seen, exec, { platform: 'linux', pageSize: 4096, readStat: async (pid) => (pid === 101 ? 'garbage' : pstat(1, 100, 5, 1)) }), null);
  assert.strictEqual(seen.get(101), '6', 'kept for the retry');
});

test('round 8: memberState: the live count and the pids come from ONE table read', async () => {
  let reads = 0;
  const exec = (cmd, args, o, cb) => { reads++; cb(null, '100 1 100 1\n101 100 100 1\n'); };
  const o = { platform: 'linux', pageSize: 4096, readStat: async (pid) => (pid === 100 ? pstat(1, 100, 5, 1) : pstat(100, 100, 6, 1)) };
  const seen = new Map([[100, '5'], [101, '6']]); seen.rootAdded = true;
  assert.deepStrictEqual(await mw.memberState(100, 100, seen, exec, o), { count: 2, pids: [100, 101] });
  assert.strictEqual(reads, 1);
});
