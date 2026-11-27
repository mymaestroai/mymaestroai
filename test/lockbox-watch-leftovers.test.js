'use strict';
// Tests for the strace "watch" mode of lib/lockbox/lockbox-run.py: leftovers, fallback, refused attach (real strace).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const HELPER = path.join(__dirname, '..', 'lib', 'lockbox', 'lockbox-run.py');
const PY = '/usr/bin/python3';
const STRACE = '/usr/bin/strace';
const DEV = ['/dev/null', '/dev/zero', '/dev/full', '/dev/tty', '/dev/pts', '/dev/shm'];

let skip = false;
if (process.platform !== 'linux') skip = 'the box only exists on Linux';
else if (!fs.existsSync(STRACE)) skip = STRACE + ' is missing, so the watch tests cannot run';
else {
  const m = /^TracerPid:\s*(\d+)/m.exec(fs.readFileSync('/proc/self/status', 'utf8'));
  if (m && m[1] !== '0') skip = 'this test runs strace and cannot run inside a traced process (TracerPid ' + m[1] + ')';
}
if (!skip) {
  // a quick real probe: can strace trace here at all?
  const pr = cp.spawnSync(STRACE, ['-f', '-qq', '-o', '/dev/null', '-e', 'trace=none', '--', '/bin/true'],
    { stdio: 'ignore', timeout: 10000 });
  if (pr.status !== 0) skip = 'strace cannot trace here (' + (pr.error ? pr.error.message : 'exit ' + pr.status + (pr.signal ? ' ' + pr.signal : '')) + ')';
}
// can the file system free parts of a file (hole punching)? Probed through the same call the helper makes.
let punchSkip = false;
if (!skip) {
  const probeDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'lockbox-punch-'));
  const probe = 'import ctypes,os,sys\nfd=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT)\nos.write(fd,b"x"*65536)\n' +
    'f=ctypes.CDLL(None,use_errno=True).fallocate\nf.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_int64,ctypes.c_int64]\n' +
    'sys.exit(0 if f(fd,3,0,4096)==0 else 1)\n';
  const pp = cp.spawnSync(PY, ['-I', '-c', probe, path.join(probeDir, 'p')], { stdio: 'ignore' });
  if (pp.status !== 0) punchSkip = 'this file system cannot punch holes';
  try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
// the same for /dev/shm (the helper uses it when the temp dir cannot punch holes)
let shmSkip = false;
if (!skip) {
  let d = null;
  try {
    d = fs.mkdtempSync('/dev/shm/lockbox-punch-');
    const probe = 'import ctypes,os,sys\nfd=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT)\nos.write(fd,b"x"*8192)\n' +
      'f=ctypes.CDLL(None,use_errno=True).fallocate\nf.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_int64,ctypes.c_int64]\n' +
      'sys.exit(0 if f(fd,3,0,4096)==0 else 1)\n';
    if (cp.spawnSync(PY, ['-I', '-c', probe, path.join(d, 'p')], { stdio: 'ignore' }).status !== 0) shmSkip = '/dev/shm cannot punch holes';
  } catch (e) { shmSkip = '/dev/shm is not usable'; }
  if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
}

const cleanup = [];
process.on('exit', () => { for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } } });

function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'lockbox-test-'));
  cleanup.push(root);
  const fx = { root, A: path.join(root, 'A'), B: path.join(root, 'B'), log: path.join(root, 'logs', 'watch.jsonl') };
  fs.mkdirSync(fx.A); fs.mkdirSync(fx.B);
  return fx;
}
function profile(fx, over) {
  return Object.assign({
    v: 1, mode: 'watch', agent: 'sam', tool: 'Bash', writes: [fx.A], writeHoles: [], readHoles: [], devWrites: DEV,
    env: null, cwdFile: null, blockUnixSockets: true, blockIoUring: true,
    log: { path: fx.log, max: 50 }, label: 'sh -c test',
  }, over || {});
}
// Run `sh -c script` through the helper (optionally under an outer strace), async so leftovers can be observed.
function run(fx, script, extraEnv, outer, opts) {
  const b64 = Buffer.from(JSON.stringify(profile(fx))).toString('base64');
  const env = Object.assign({}, process.env, { FX_A: fx.A, FX_B: fx.B }, extraEnv || {});
  const args = ['-I', '-S', HELPER, '--profile-b64', b64, '--'].concat(opts && opts.argv ? opts.argv : ['sh', '-c', script]);
  const t0 = Date.now();
  const cmd = outer ? STRACE : PY;
  const full = outer ? ['-f', '-qq', '-e', 'trace=none', '-o', '/dev/null', '--', PY].concat(args) : args;
  return new Promise((resolve) => {
    const c = cp.spawn(cmd, full, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: !!(opts && opts.detached) });
    if (opts && opts.onStart) opts.onStart(c);
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    // 'exit', not 'close': a leftover may hold the output pipes
    c.on('exit', (code, sig) => resolve({ code, sig, out, err, ms: Date.now() - t0 }));
  });
}
function readLog(fx) {
  if (!fs.existsSync(fx.log)) return [];
  return fs.readFileSync(fx.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) return false; await sleep(50); }
  return true;
}
// trace folders live in a private lockbox-watch-<uid> folder under the temp dir; names are returned relative to the base
const PARENT = 'lockbox-watch-' + process.getuid();
const watchDirsIn = (base) => { try { return fs.readdirSync(path.join(base, PARENT)).filter((n) => n.startsWith('w-')).map((n) => path.join(PARENT, n)); } catch (e) { return []; } };
const watchDirs = (d) => watchDirsIn(d || os.tmpdir());
// a private temp dir for a run (TMPDIR): watching its few entries is quick however crowded the shared /tmp is
function privTmp(fx) { const d = path.join(fx.root, 'tmp'); fs.mkdirSync(d, { recursive: true }); return d; }
const rules = (fx) => readLog(fx).map((e) => e.rule);

describe('lockbox-run watch leftovers', { skip }, () => {
  it('T1. a leftover is reported, still watched, and the folder goes when it ends', async () => {
    const fx = fixture();
    const td = privTmp(fx);
    const before = new Set(watchDirs(td));
    const r = await run(fx, 'sleep 6 & exit 4', { LOCKBOX_TEST_GRACE_MS: '1500', TMPDIR: td });
    assert.strictEqual(r.code, 4, r.err);
    assert.ok(r.ms < 5000, 'took ' + r.ms);
    const lo = readLog(fx).filter((e) => e.rule === 'watch-leftovers');
    assert.strictEqual(lo.length, 1);
    assert.strictEqual(lo[0].count, 1);
    assert.deepStrictEqual(lo[0].names, ['sleep']);
    assert.match(lo[0].note, /still running and are still being watched/);
    assert.ok(!rules(fx).includes('watch-leftovers-ended'), 'not ended yet');
    assert.ok(await until(() => rules(fx).includes('watch-leftovers-ended'), 12000), 'no watch-leftovers-ended');
    const ended = readLog(fx).filter((e) => e.rule === 'watch-leftovers-ended');
    assert.strictEqual(ended.length, 1);
    assert.strictEqual(ended[0].count, 1);
    assert.ok(await until(() => watchDirs(td).every((n) => before.has(n)), 3000), 'a lockbox-watch folder remains');
  });

  it('T2. a normal command ends with its own status and nothing extra is logged', async () => {
    const fx = fixture();
    let r = await run(fx, 'exit 3');
    assert.strictEqual(r.code, 3, r.err);
    r = await run(fx, 'kill -TERM $$');
    assert.strictEqual(r.sig, 'SIGTERM', JSON.stringify(r));
    assert.deepStrictEqual(rules(fx).filter((x) => /^watch-/.test(x)), []);
  });

  it('T3. an attach that is refused: the command runs unwatched, one watch-failed entry', async () => {
    const fx = fixture();
    // the probe now uses the real run's options (-DDD): under a tracer it still exits 0 (the command runs unwatched), so
    // the helper goes on and the real attach is refused: the same single watch-failed entry
    let r = await run(fx, 'exit 5', {}, true);
    assert.strictEqual(r.code, 5, r.err);
    assert.deepStrictEqual(rules(fx).filter((x) => /^watch-/.test(x)), ['watch-failed']);
    const fx2 = fixture();
    r = await run(fx2, 'exit 5', { LOCKBOX_TEST_FORCE_PROBE: '1' }, true);   // probe skipped: the -D attach is refused
    assert.strictEqual(r.code, 5, r.err);
    assert.deepStrictEqual(rules(fx2).filter((x) => /^watch-/.test(x)), ['watch-failed']);
  });

  it('T4. without seccomp-bpf the slower mode is used, said once, and still watches', async () => {
    const fx = fixture();
    const r = await run(fx, 'echo hi > "$FX_B/x.txt"', { LOCKBOX_TEST_NO_SECCOMP: '1' });
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(fs.readFileSync(path.join(fx.B, 'x.txt'), 'utf8'), 'hi\n');
    const log = readLog(fx);
    assert.strictEqual(log.filter((e) => e.rule === 'watch-fallback').length, 1);
    assert.ok(log.some((e) => e.rule === 'write-outside' && e.path === path.join(fx.B, 'x.txt')), JSON.stringify(log));
  });

  it('T5. a leftover is not broken by the helper exiting', async () => {
    const fx = fixture();
    const r = await run(fx, '(sleep 1; echo hi > "$FX_A/late.txt") & exit 0', { LOCKBOX_TEST_GRACE_MS: '300' });
    assert.strictEqual(r.code, 0, r.err);
    assert.ok(r.ms < 3000, 'took ' + r.ms);
    const f = path.join(fx.A, 'late.txt');
    assert.ok(await until(() => fs.existsSync(f) && fs.readFileSync(f, 'utf8') === 'hi\n', 5000), 'late.txt missing');
  });

  it('T6. the continuation judges a leftover\'s later refused write exactly once', async () => {
    const fx = fixture();
    const r = await run(fx, '(sleep 1; echo x > "$FX_B/late-refused.txt") & exit 0', { LOCKBOX_TEST_GRACE_MS: '300' });
    assert.strictEqual(r.code, 0, r.err);
    const done = () => rules(fx).includes('watch-leftovers-ended');
    assert.ok(await until(done, 6000), 'no watch-leftovers-ended: ' + JSON.stringify(readLog(fx)));
    const log = readLog(fx);
    const late = log.filter((e) => e.rule === 'write-outside' && e.path === path.join(fx.B, 'late-refused.txt'));
    assert.strictEqual(late.length, 1, JSON.stringify(log));
    assert.ok(log.indexOf(late[0]) < log.findIndex((e) => e.rule === 'watch-leftovers-ended'), 'wrong order');
    assert.ok(log.findIndex((e) => e.rule === 'watch-leftovers') < log.indexOf(late[0]), 'leftovers line must come first');
  });

  it('T7. a command killed by SIGKILL makes the helper end by SIGKILL', async () => {
    const fx = fixture();
    const r = await run(fx, 'kill -KILL $$');
    assert.strictEqual(r.sig, 'SIGKILL', JSON.stringify(r));
    assert.ok(!/could not build the box/.test(r.err), r.err);
  });

  it('T8. a cancel that signals the command\'s group does not reach strace: a session-detached leftover goes on', async () => {
    const fx = fixture();
    let helper;
    const p = run(fx, "setsid sh -c 'sleep 1.5; echo done > \"$FX_A/sess.txt\"' & sleep 30",
      { LOCKBOX_TEST_GRACE_MS: '500' }, false, { detached: true, onStart: (c) => { helper = c; } });
    await sleep(300);
    process.kill(-helper.pid, 'SIGTERM');   // the helper leads its own group: command, sleep and helper get it
    const r = await p;
    assert.ok(r.ms < 6000, 'took ' + r.ms);
    const f = path.join(fx.A, 'sess.txt');
    assert.ok(await until(() => fs.existsSync(f) && fs.readFileSync(f, 'utf8') === 'done\n', 5000), 'sess.txt missing');
  });

  it('T9. the trace file does not grow without bound while a long-lived leftover runs', { skip: punchSkip }, async () => {
    const fx = fixture();
    fs.writeFileSync(path.join(fx.A, 'f'), 'x');
    const td = privTmp(fx);
    const before = new Set(watchDirs(td));
    // a counted loop of traced opens (about 125 bytes of trace each); a stop file ends it early in a failed run
    const script = '(i=0; while [ $i -lt 90000 ] && [ ! -e "$FX_B/stop" ]; do : < "$FX_A/f"; i=$((i+1)); done) & exit 0';
    const p = run(fx, script, { LOCKBOX_TEST_GRACE_MS: '300', TMPDIR: td });
    let maxApparent = 0, maxAllocated = 0, trace = null;
    const sample = () => {
      if (!trace) {
        const d = watchDirs(td).find((n) => !before.has(n));
        if (d) trace = path.join(td, d, 'trace');
      }
      if (!trace) return;
      try {
        const st = fs.statSync(trace);
        maxApparent = Math.max(maxApparent, st.size);
        maxAllocated = Math.max(maxAllocated, st.blocks * 512);
      } catch (e) { /* gone */ }
    };
    const timer = setInterval(sample, 20);   // sampled from the start: the helper is back after about half a second
    const r = await p;
    assert.strictEqual(r.code, 0, r.err);
    const t0 = Date.now();
    while (!rules(fx).includes('watch-leftovers-ended') && Date.now() - t0 < 60000) { sample(); await sleep(20); }
    clearInterval(timer);
    fs.writeFileSync(path.join(fx.B, 'stop'), '');
    assert.ok(rules(fx).includes('watch-leftovers-ended'), 'no watch-leftovers-ended');
    assert.ok(trace, 'trace file never seen');
    process.stderr.write('# T9 trace file: apparent max ' + maxApparent + ' B, allocated max ' + maxAllocated + ' B\n');
    assert.ok(maxApparent > 2 * 1024 * 1024, 'the loop was too small: apparent ' + maxApparent);
    // sampled from the start now, so the lag of the reader behind a fast loop shows: bounded means well under the whole file
    assert.ok(maxAllocated < 0.5 * maxApparent, 'allocated ' + maxAllocated + ' apparent ' + maxApparent);
    assert.ok(maxAllocated < maxApparent);
  });

  it('T10. the helper exits within grace + 1.5 s even when a leftover keeps writing traced events', async () => {
    const fx = fixture();
    fs.writeFileSync(path.join(fx.A, 'f'), 'x');
    const script = '(while [ ! -e "$FX_B/stop" ]; do : < "$FX_A/f"; done) & exit 0';
    try {
      const r = await run(fx, script, { LOCKBOX_TEST_GRACE_MS: '500' });
      assert.strictEqual(r.code, 0, r.err);
      assert.ok(r.ms < 500 + 1500 + 500, 'took ' + r.ms);   // 500 ms for starting python, strace and the shell
      assert.ok(readLog(fx).some((e) => e.rule === 'watch-leftovers'), JSON.stringify(readLog(fx)));
    } finally {
      fs.writeFileSync(path.join(fx.B, 'stop'), '');
    }
    assert.ok(await until(() => rules(fx).includes('watch-leftovers-ended'), 10000), 'no watch-leftovers-ended');
  });

  it('T11. a cancel that arrives between the fork and the publishing of the target reaches the command', async () => {
    const fx = fixture();
    let helper;
    const p = run(fx, '', { LOCKBOX_TEST_PAUSE_PUBLISH_MS: '800' }, false,
      { argv: ['sleep', '30'], onStart: (c) => { helper = c; } });
    // wait until the helper has forked its child (it then sits in the 800 ms pause), then ~300 ms into it send the cancel
    const forked = await until(() => {
      try {
        return fs.readFileSync('/proc/' + helper.pid + '/task/' + helper.pid + '/children', 'utf8').trim().split(/\s+/).some((c) => {
          try { return /lockbox-watch-|sleep/.test(fs.readFileSync('/proc/' + c + '/cmdline', 'utf8')); } catch (e) { return false; }
        });
      } catch (e) { return false; }
    }, 4000);
    assert.ok(forked, 'the helper never forked the command');
    await sleep(300);
    helper.kill('SIGTERM');
    const r = await p;
    assert.ok(r.ms < 5000, 'took ' + r.ms);
    assert.strictEqual(r.sig, 'SIGTERM', JSON.stringify(r));
  });

  it('T12. a slow judge: the helper still returns on time and the continuation finishes the backlog', async () => {
    const fx = fixture();
    fs.writeFileSync(path.join(fx.A, 'f'), 'x');
    const td = privTmp(fx);
    const script = 'i=0; while [ $i -lt 40 ]; do : < "$FX_A/f"; i=$((i+1)); done; echo x > "$FX_B/last-refused.txt"; exit 0';
    const r = await run(fx, script, { LOCKBOX_TEST_GRACE_MS: '500', LOCKBOX_TEST_SLOW_JUDGE_MS: '100', TMPDIR: td });
    assert.strictEqual(r.code, 0, r.err);
    assert.ok(r.ms < 500 + 3000, 'took ' + r.ms);
    const last = path.join(fx.B, 'last-refused.txt');
    const has = () => readLog(fx).some((e) => e.rule === 'write-outside' && e.path === last);
    assert.ok(await until(has, 15000), 'the last write was not logged: ' + JSON.stringify(readLog(fx)));
    assert.strictEqual(readLog(fx).filter((e) => e.path === last).length, 1);
    assert.ok(!rules(fx).includes('watch-incomplete'), JSON.stringify(readLog(fx)));
    assert.ok(!rules(fx).includes('watch-leftovers'), JSON.stringify(readLog(fx)));
    assert.ok(await until(() => watchDirs(td).every((n) => !fs.existsSync(path.join(td, n, 'trace'))), 5000), 'a trace file remains');
  });

  it('T13. without hole punching in the temp dir the trace goes to /dev/shm; with none anywhere the note says so', { skip: shmSkip }, async () => {
    const fx = fixture();
    const shmDirs = () => watchDirsIn('/dev/shm');
    const before = new Set(shmDirs());
    const p = run(fx, 'sleep 3 & exit 0', { LOCKBOX_TEST_GRACE_MS: '300', LOCKBOX_TEST_NO_PUNCH: '1' });
    let seen = false;
    const t0 = Date.now();
    while (!seen && Date.now() - t0 < 4000) {
      seen = shmDirs().some((n) => !before.has(n) && fs.existsSync(path.join('/dev/shm', n, 'trace')));
      if (!seen) await sleep(20);
    }
    const r = await p;
    assert.strictEqual(r.code, 0, r.err);
    assert.ok(seen, 'no trace folder under /dev/shm');
    const lo = readLog(fx).filter((e) => e.rule === 'watch-leftovers');
    assert.strictEqual(lo.length, 1, JSON.stringify(readLog(fx)));
    assert.match(lo[0].note, /still being watched/);
    assert.ok(await until(() => rules(fx).includes('watch-leftovers-ended'), 8000), 'no watch-leftovers-ended');
    assert.ok(await until(() => shmDirs().every((n) => before.has(n)), 3000), 'a /dev/shm folder remains');

    const fx2 = fixture();
    const r2 = await run(fx2, 'sleep 3 & exit 0', { LOCKBOX_TEST_GRACE_MS: '300', LOCKBOX_TEST_NO_PUNCH: 'all' });
    assert.strictEqual(r2.code, 0, r2.err);
    const lo2 = readLog(fx2).filter((e) => e.rule === 'watch-leftovers');
    assert.strictEqual(lo2.length, 1, JSON.stringify(readLog(fx2)));
    assert.match(lo2[0].note, /disk use is not bounded/);
    assert.match(lo2[0].note, /still watched/);
    assert.ok(await until(() => rules(fx2).includes('watch-leftovers-ended'), 8000), 'no watch-leftovers-ended');
  });

  it('T14. an strace that rejects -DDD fails the probe: watch-unavailable, the command still runs', async () => {
    const fx = fixture();
    const fake = path.join(fx.root, 'fake-strace');
    fs.writeFileSync(fake, '#!/bin/sh\nfor a in "$@"; do [ "$a" = "-DDD" ] && exit 1; done\nexit 0\n', { mode: 0o755 });
    const r = await run(fx, 'echo ran > "$FX_A/ran.txt"; exit 7', { LOCKBOX_TEST_STRACE: fake });
    assert.strictEqual(r.code, 7, r.err);
    assert.strictEqual(fs.readFileSync(path.join(fx.A, 'ran.txt'), 'utf8'), 'ran\n');
    assert.deepStrictEqual(rules(fx).filter((x) => /^watch-/.test(x)), ['watch-unavailable']);
  });

  it('T15. the sweep removes an old lockbox-watch folder and leaves a fresh one alone', async () => {
    const fx = fixture();
    const tmp = fs.realpathSync(os.tmpdir());
    fs.mkdirSync(path.join(tmp, PARENT), { recursive: true, mode: 0o700 });
    const oldDir = fs.mkdtempSync(path.join(tmp, PARENT, 'w-test-old-'));
    const freshDir = fs.mkdtempSync(path.join(tmp, PARENT, 'w-test-fresh-'));
    cleanup.push(oldDir, freshDir);
    fs.writeFileSync(path.join(oldDir, 'trace'), 'old trace');
    fs.writeFileSync(path.join(freshDir, 'trace'), 'fresh trace');
    const twoDays = new Date(Date.now() - 2 * 86400 * 1000);
    fs.utimesSync(oldDir, twoDays, twoDays);
    const r = await run(fx, 'exit 0');
    assert.strictEqual(r.code, 0, r.err);
    assert.ok(!fs.existsSync(oldDir), 'the old folder remains');
    assert.ok(fs.existsSync(path.join(freshDir, 'trace')), 'the fresh folder was removed');
  });
});
