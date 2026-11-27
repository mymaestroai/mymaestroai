'use strict';
// lib/mem-watch.js: the best-effort memory watchdog for computers with no systemd. A fake ps table and fake signals; nothing real runs.
const test = require('node:test');
const assert = require('node:assert');
const mw = require('../lib/mem-watch');
const GB = require('../lib/mem-limit').GB;

const row = (pid, ppid, pgid, kb, start = null) => ({ pid, ppid, pgid, rssKb: kb, start });

test('parseTable reads pid ppid pgid rss (and the start time from etimes when there is one)', () => {
  assert.deepStrictEqual(mw.parseTable('  10     1    10   2048\n 11 10 10 100\nnot a row\n'), [row(10, 1, 10, 2048), row(11, 10, 10, 100)]);
  assert.deepStrictEqual(mw.parseTable(' 10 1 10 2048 30\n', 100000), [row(10, 1, 10, 2048, 70000)]);
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
  t = [row(100, 1, 100, 1000), row(102, 1, 102, 77), row(200, 1, 200, 5)];
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

test('identity: a member whose start time changed is a different process: dropped, not counted', () => {
  const seen = new Map();
  let t = [row(100, 1, 100, 1000, 50000), row(102, 100, 100, 2000, 51000)];
  assert.strictEqual(mw.measure(t, 100, 100, seen), 3000 * 1024);
  // 102 is the same pid but started 40 s later (the pid was reused); 1 s of jitter on 100 is still the same process
  t = [row(100, 1, 100, 1000, 51000), row(102, 1, 102, 9000, 91000)];
  assert.strictEqual(mw.measure(t, 100, 100, seen), 1000 * 1024);
  assert.deepStrictEqual([...seen.keys()], [100]);
});

function watchWith(table, extra = {}) {
  const sent = [], stops = [], timers = [], execs = [];
  const exec = (cmd, args, o, cb) => { execs.push(args); cb(null, typeof table.v === 'function' ? table.v() : table.v); };
  const w = mw.watch(100, {
    limitBytes: 3 * GB, group: 100, exec, kill: (p, s) => sent.push([p, s]), onStop: (t) => stops.push(t),
    setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl: () => {},
    setTimeoutImpl: (f, ms) => { const t = { f, ms, cleared: false, unref() {} }; timers.push(t); return t; },
    clearTimeoutImpl: (t) => { t.cleared = true; }, ...extra,
  });
  return { w, sent, stops, timers, execs };
}

test('watch: past the limit the group gets SIGTERM, SIGKILL after 3 s, one notice; under the limit nothing happens', async () => {
  const table = { v: '100 1 100 1048576 20\n101 100 100 1048576 20\n' };   // 2 GB
  const { w, sent, stops, timers, execs } = watchWith(table);
  await w.tick();
  assert.deepStrictEqual(execs[0], ['-A', '-o', 'pid=,ppid=,pgid=,rss=,etimes=']);
  assert.deepStrictEqual(sent, []); assert.deepStrictEqual(stops, []);
  table.v = '100 1 100 3145728 22\n101 100 100 1048576 22\n';       // 3 GB + 1 GB
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
  const table = { v: '100 1 100 3145728 20\n101 100 100 1048576 20\n102 100 100 1024 20\n' };
  const { w, sent, timers } = watchWith(table);
  await w.tick();
  assert.ok(timers.length === 1);
  sent.length = 0;
  // during the grace: 101 exited and its pid was reused by an unrelated process (started 1 s ago), 102 is the same process, 100 is the same
  table.v = '100 1 100 3145728 20\n101 1 500 10 1\n102 100 100 1024 20\n';
  await timers[0].f();
  assert.ok(sent.some(k => k[0] === 102 && k[1] === 'SIGKILL'));
  assert.ok(sent.some(k => k[0] === -100 && k[1] === 'SIGKILL'));
  assert.ok(!sent.some(k => k[0] === 101), 'a reused pid is never signalled');
});

test('watch: the group is not signalled when its leader is no longer the same process', async () => {
  const table = { v: '100 1 100 3145728 20\n101 100 100 1024 20\n' };
  const { w, sent, timers } = watchWith(table);
  await w.tick();
  sent.length = 0;
  table.v = '100 1 100 10 1\n101 100 100 1024 20\n';   // 100 was reused by something that started a second ago
  await timers[0].f();
  assert.ok(!sent.some(k => k[0] === -100), 'the leader is someone else now: no group signal');
  assert.ok(!sent.some(k => k[0] === 100), 'and no signal to the reused pid');
  assert.ok(sent.some(k => k[0] === 101 && k[1] === 'SIGKILL'));
});

test('watch: stop() cancels the pending SIGKILL escalation', async () => {
  const table = { v: '100 1 100 3145800 20\n' };
  const { w, timers } = watchWith(table);
  await w.tick();
  assert.strictEqual(timers.length, 1); assert.strictEqual(timers[0].cleared, false);
  w.stop();
  assert.strictEqual(timers[0].cleared, true);
});

test('one shared sampler: a single ps run per interval for every watcher; it starts with the first and stops with the last', async () => {
  let runs = 0, ticker = null, cleared = 0;
  const exec = (cmd, args, o, cb) => { runs++; cb(null, '100 1 100 1024 20\n200 1 200 1024 20\n'); };
  const sampler = mw.createSampler({ exec, setIntervalImpl: (f) => { ticker = f; return { unref() {} }; }, clearIntervalImpl: () => { cleared++; } });
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

test('the default interval is 2 s', () => {
  let ms = null;
  const w = mw.watch(1, { limitBytes: GB, setIntervalImpl: (f, n) => { ms = n; return { unref() {} }; }, clearIntervalImpl: () => {} });
  assert.strictEqual(ms, 2000);
  w.stop();
});

test('stoppedText says best effort', () => {
  assert.strictEqual(mw.stoppedText(48 * GB), 'stopped: it used more than 48 GB of memory (best effort, checked every 2 s)');
});
