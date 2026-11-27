'use strict';
// Tests for lib/lockbox/lockbox-run.py (Landlock + seccomp box, and the strace "watch" mode).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const HELPER = path.join(__dirname, '..', 'lib', 'lockbox', 'lockbox-run.py');
const PY = '/usr/bin/python3';
const DEV = ['/dev/null', '/dev/zero', '/dev/full', '/dev/tty', '/dev/pts', '/dev/shm'];

function probe() {
  const r = cp.spawnSync(PY, ['-I', '-S', HELPER, '--probe'], { encoding: 'utf8', timeout: 30000 });
  try { return JSON.parse(r.stdout.trim().split('\n')[0]); } catch (e) { return null; }
}
const PROBE = process.platform === 'linux' ? probe() : null;
let skip = false;
if (process.platform !== 'linux') skip = 'the box only exists on Linux';
else if (PROBE && PROBE.ok === false) skip = 'the box is not available here: ' + PROBE.reason;

// strace cannot trace a process that is already traced (a watched shell runs this suite under strace): the watch tests
// skip then, and run wherever the suite itself is not traced (CI). TracerPid in /proc/self/status is non-zero when traced.
function isTraced() {
  try { const m = /^TracerPid:\s*(\d+)/m.exec(fs.readFileSync('/proc/self/status', 'utf8')); return !!m && m[1] !== '0'; } catch (e) { return false; }
}
const TRACED = isTraced() ? 'this process is itself traced (TracerPid is not 0), so strace cannot trace the box here' : false;

const cleanup = [];
process.on('exit', () => { for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } } });

// A write root (with a sub folder and a hole), B outside every root, H a read hole, S its sibling.
// The read rules list every entry of each folder that holds a hole, so a crowded temp folder (the box
// refuses more than 20000 rules) is skipped in favour of the first roomy one.
function fixtureBase() {
  for (const d of [os.tmpdir(), '/var/tmp']) {
    try { const real = fs.realpathSync(d); if (fs.readdirSync(real).length <= 2000) return real; } catch (e) { /* next */ }
  }
  return fs.realpathSync(os.tmpdir());
}

function fixture() {
  const root = fs.mkdtempSync(path.join(fixtureBase(), 'lockbox-test-'));
  cleanup.push(root);
  const fx = { root, A: path.join(root, 'A'), B: path.join(root, 'B'), H: path.join(root, 'H'), S: path.join(root, 'S'),
    log: path.join(root, 'logs', 'watch.jsonl') };
  for (const d of [fx.A, path.join(fx.A, 'sub'), path.join(fx.A, 'hole'), fx.B, fx.H, path.join(fx.H, 'own'), fx.S]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(fx.H, 'secret.txt'), 'top secret\n');
  fs.writeFileSync(path.join(fx.S, 'plain.txt'), 'plain text\n');
  return fx;
}

function profile(fx, over) {
  return Object.assign({
    v: 1, mode: 'enforce', agent: 'sam', tool: 'Bash',
    writes: [fx.A], writeHoles: [path.join(fx.A, 'hole')], readHoles: [fx.H], devWrites: DEV,
    env: null, cwdFile: null, blockUnixSockets: true, blockIoUring: true,
    log: { path: fx.log, max: 50 }, label: 'bash -c test',
  }, over || {});
}

// Run `bash -c script` through the helper; fixture paths reach the script as FX_* variables.
function box(fx, prof, script, extraEnv) {
  const b64 = Buffer.from(JSON.stringify(prof)).toString('base64');
  const env = Object.assign({}, process.env, { FX_A: fx.A, FX_B: fx.B, FX_H: fx.H, FX_S: fx.S }, extraEnv || {});
  return cp.spawnSync(PY, ['-I', '-S', HELPER, '--profile-b64', b64, '--', 'bash', '-c', script],
    { env, encoding: 'utf8', timeout: 30000 });
}

function waitFor(cond) {
  const end = Date.now() + 10000;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

// A unix socket server in a separate process (spawnSync blocks this one's event loop).
function withServer(sockPath, fn) {
  const srv = cp.spawn(process.execPath, ['-e', 'require("net").createServer((c) => c.end()).listen(process.argv[1]);', sockPath],
    { stdio: 'ignore' });
  try {
    waitFor(() => fs.existsSync(sockPath));
    return fn();
  } finally { srv.kill(); }
}

const PY_CONNECT = 'import socket, sys\ns = socket.socket(socket.AF_UNIX)\ns.connect(sys.argv[1])\nprint("connected")\n';
const PY_URING = 'import ctypes\nl = ctypes.CDLL(None, use_errno=True)\nr = l.syscall(425, 1, ctypes.create_string_buffer(120))\nprint(r, ctypes.get_errno())\n';

function readLog(fx) {
  if (!fs.existsSync(fx.log)) return [];
  return fs.readFileSync(fx.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('lockbox-run', { skip }, () => {
  it('1. writes land only inside the write roots and outside the holes', () => {
    const fx = fixture();
    let r = box(fx, profile(fx), 'echo hi > "$FX_A/sub/f.txt"');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(fs.readFileSync(path.join(fx.A, 'sub', 'f.txt'), 'utf8'), 'hi\n');
    r = box(fx, profile(fx), 'echo hi > "$FX_B/x.txt"');
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /Permission denied/);
    assert.ok(!fs.existsSync(path.join(fx.B, 'x.txt')));
    r = box(fx, profile(fx), 'echo hi > "$FX_A/hole/x.txt"');
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /Permission denied/);
    r = box(fx, profile(fx), 'mkdir "$FX_A/sub/newdir"');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(fs.statSync(path.join(fx.A, 'sub', 'newdir')).isDirectory());
  });

  it('2. reads: plain files yes, secret no, listing the hole yes', () => {
    const fx = fixture();
    let r = box(fx, profile(fx), 'cat "$FX_S/plain.txt"');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, 'plain text\n');
    r = box(fx, profile(fx), 'cat "$FX_H/secret.txt"');
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /Permission denied/);
    assert.ok(!r.stdout.includes('top secret'));
    r = box(fx, profile(fx), 'ls "$FX_H"');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /secret\.txt/);
  });

  it('3. a symlink in a write root pointing at a secret does not open it', () => {
    const fx = fixture();
    fs.symlinkSync(path.join(fx.H, 'secret.txt'), path.join(fx.A, 'link'));
    const r = box(fx, profile(fx), 'cat "$FX_A/link"');
    assert.notStrictEqual(r.status, 0);
    assert.ok(!r.stdout.includes('top secret'));
  });

  it('4. a secret cannot be moved or hard-linked into a write root', () => {
    const fx = fixture();
    let r = box(fx, profile(fx), 'mv "$FX_H/secret.txt" "$FX_A/sub/moved.txt"');
    assert.notStrictEqual(r.status, 0);
    assert.ok(fs.existsSync(path.join(fx.H, 'secret.txt')));
    assert.ok(!fs.existsSync(path.join(fx.A, 'sub', 'moved.txt')));
    r = box(fx, profile(fx), 'ln "$FX_H/secret.txt" "$FX_A/sub/hard.txt"');
    assert.notStrictEqual(r.status, 0);
    assert.ok(!fs.existsSync(path.join(fx.A, 'sub', 'hard.txt')));
  });

  it('5. a write root inside a read hole is usable while the rest of the hole stays closed', () => {
    const fx = fixture();
    const own = path.join(fx.H, 'own');
    const prof = profile(fx, { writes: [fx.A, own] });
    let r = box(fx, prof, 'echo mine > "$FX_H/own/n.txt" && cat "$FX_H/own/n.txt"');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, 'mine\n');
    r = box(fx, prof, 'cat "$FX_H/secret.txt"');
    assert.notStrictEqual(r.status, 0);
    assert.ok(!r.stdout.includes('top secret'));
  });

  it('6. a unix socket served outside cannot be reached from inside', () => {
    const fx = fixture();
    const sock = path.join(fx.A, 'sock');
    withServer(sock, () => {
      const outside = cp.spawnSync(PY, ['-c', PY_CONNECT, sock], { encoding: 'utf8', timeout: 30000 });
      assert.strictEqual(outside.status, 0, outside.stderr);
      const r = box(fx, profile(fx), 'python3 -c "$FX_PY" "$FX_A/sock"', { FX_PY: PY_CONNECT });
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /PermissionError/);
    });
  });

  it('7. a process outside the box cannot be signalled from inside', () => {
    const fx = fixture();
    const sleeper = cp.spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      assert.strictEqual(cp.spawnSync('kill', ['-0', String(sleeper.pid)]).status, 0);
      const r = box(fx, profile(fx), 'kill -0 ' + sleeper.pid);
      assert.notStrictEqual(r.status, 0);
    } finally { sleeper.kill(); }
  });

  it('8. io_uring_setup answers ENOSYS inside the box', () => {
    const fx = fixture();
    const r = box(fx, profile(fx), 'python3 -c "$FX_PY"', { FX_PY: PY_URING });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout.trim(), '-1 38');
  });

  it('9. the environment is rebuilt from keep and set; null passes it all', () => {
    const fx = fixture();
    const tmp = path.join(fx.A, 'sub');
    const secretEnv = { LOCKBOX_TEST_SECRET: 's3cr3t' };
    const prof = profile(fx, { env: { keep: ['PATH', 'HOME', 'LC_*'], set: { TMPDIR: tmp } }, cwdFile: path.join(fx.A, 'cwd.txt') });
    let r = box(fx, prof, 'env', secretEnv);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes('LOCKBOX_TEST_SECRET'));
    assert.ok(r.stdout.split('\n').includes('TMPDIR=' + tmp));
    assert.ok(r.stdout.split('\n').includes('LOCKBOX_CWD_FILE=' + path.join(fx.A, 'cwd.txt')));
    r = box(fx, profile(fx), 'env', secretEnv);
    assert.ok(r.stdout.includes('LOCKBOX_TEST_SECRET=s3cr3t'));
  });

  it('10. exit codes and death by signal pass through', () => {
    const fx = fixture();
    assert.strictEqual(box(fx, profile(fx), 'exit 7').status, 7);
    const r = box(fx, profile(fx), 'kill -TERM $$');
    assert.strictEqual(r.signal, 'SIGTERM');
  });

  it('11. a bad profile stops with 126 and the command does not run', () => {
    const fx = fixture();
    const marker = path.join(fx.A, 'sub', 'marker');
    for (const bad of [{ v: 2 }, { writes: ['relative/dir'] }, { mode: 'other' }, { log: { path: fx.log, max: 0 } },
      { env: { keep: 'PATH', set: {} } }, { readHoles: ['/ok', 'no\u0000nul'] }]) {
      const r = box(fx, profile(fx, bad), 'touch "$FX_A/sub/marker"');
      assert.strictEqual(r.status, 126, JSON.stringify(bad));
      assert.match(r.stderr, /^lockbox: could not build the box \(.+\); the command was not run\.\n$/);
      assert.ok(!fs.existsSync(marker));
    }
    const garbage = cp.spawnSync(PY, ['-I', '-S', HELPER, '--profile-b64', '!!notbase64!!', '--', 'true'], { encoding: 'utf8' });
    assert.strictEqual(garbage.status, 126);
  });

  it('12. sudo gains nothing inside the box', () => {
    const fx = fixture();
    const r = box(fx, profile(fx), 'sudo -n true');
    assert.notStrictEqual(r.status, 0);
  });

  it('13. watch mode lets everything run and logs what enforce would refuse', { skip: TRACED }, () => {
    const fx = fixture();
    const prof = profile(fx, { mode: 'watch' });
    const sock = path.join(fx.A, 'sock');
    const runs = [
      'echo hi > "$FX_A/sub/f.txt" && echo hi > "$FX_B/x.txt" && mkdir "$FX_A/sub/d"',
      'cat "$FX_S/plain.txt" && cat "$FX_H/secret.txt"',
      'python3 -c "$FX_PY" "$FX_A/sock"',
    ];
    withServer(sock, () => {
      const r1 = box(fx, prof, runs[0]);
      assert.strictEqual(r1.status, 0, r1.stderr);
      const r2 = box(fx, prof, runs[1]);
      assert.strictEqual(r2.status, 0, r2.stderr);
      assert.match(r2.stdout, /top secret/);
      const r3 = box(fx, prof, runs[2], { FX_PY: PY_CONNECT });
      assert.strictEqual(r3.status, 0, r3.stderr);
    });
    const r4 = box(fx, prof, 'python3 -c "$FX_PY"', { FX_PY: PY_URING });
    assert.strictEqual(r4.status, 0, r4.stderr);
    assert.ok(fs.existsSync(path.join(fx.B, 'x.txt')));
    const log = readLog(fx);
    const has = (rule, p) => log.some((e) => e.rule === rule && (p === undefined || e.path === p));
    assert.ok(has('write-outside', path.join(fx.B, 'x.txt')), JSON.stringify(log));
    assert.ok(has('secret-read', path.join(fx.H, 'secret.txt')), JSON.stringify(log));
    assert.ok(has('unix-socket'), JSON.stringify(log));
    assert.ok(!has('io_uring'), 'io_uring is refused in enforce but not logged in watch: every Node program probes it and falls back');
    assert.ok(!log.some((e) => e.path.startsWith(fx.A + path.sep) && e.rule !== 'unix-socket'), 'A writes are not logged');
    assert.ok(!log.some((e) => e.path.startsWith(fx.S)), 'S reads are not logged');
    for (const e of log) {
      assert.deepStrictEqual([e.agent, e.tool, e.mode, e.cmd], ['sam', 'Bash', 'watch', 'bash -c test']);
      assert.match(e.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
    }
    assert.strictEqual(fs.statSync(fx.log).mode & 0o777, 0o600);
    // watch runs the command as today: the helper's own environment comes through (plus UV_USE_IO_URING=0), even with an env profile
    const envRun = box(fx, profile(fx, { mode: 'watch', env: { keep: ['PATH'], set: {} } }), 'env', { LOCKBOX_TEST_SECRET: 's3cr3t' });
    assert.strictEqual(envRun.status, 0, envRun.stderr);
    assert.ok(envRun.stdout.split('\n').includes('LOCKBOX_TEST_SECRET=s3cr3t'), 'watch passes today\'s environment');
    assert.ok(envRun.stdout.includes('UV_USE_IO_URING=0'));
    // enforce with an env profile still hides it
    const enfEnv = box(fx, profile(fx, { env: { keep: ['PATH'], set: {} } }), 'env', { LOCKBOX_TEST_SECRET: 's3cr3t' });
    assert.strictEqual(enfEnv.status, 0, enfEnv.stderr);
    assert.ok(!enfEnv.stdout.includes('LOCKBOX_TEST_SECRET'));
    assert.strictEqual(box(fx, prof, 'exit 7').status, 7);
    assert.strictEqual(box(fx, prof, 'kill -TERM $$').signal, 'SIGTERM');
  });

  it('14. watch keeps log.max entries and counts the rest', { skip: TRACED }, () => {
    const fx = fixture();
    const prof = profile(fx, { mode: 'watch', log: { path: fx.log, max: 2 } });
    const r = box(fx, prof, 'for i in 1 2 3 4 5; do echo x > "$FX_B/f$i"; done');
    assert.strictEqual(r.status, 0, r.stderr);
    const log = readLog(fx);
    assert.strictEqual(log.length, 3, JSON.stringify(log));
    assert.strictEqual(log.filter((e) => e.rule === 'write-outside').length, 2);
    const more = log[2];
    assert.strictEqual(more.op, 'more');
    assert.strictEqual(more.count, 3);
  });

  it('14b. watch writes nothing when nothing would be refused', { skip: TRACED }, () => {
    const fx = fixture();
    const r = box(fx, profile(fx, { mode: 'watch' }), 'echo ok > "$FX_A/sub/ok.txt"; cat "$FX_S/plain.txt"');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(fx.log));
  });

  it('16. SIGPIPE has its default action inside the box (enforce and watch)', () => {
    const fx = fixture();
    for (const mode of ['enforce', 'watch']) {
      const r = box(fx, profile(fx, { mode }), 'yes | head -1 > /dev/null; echo "${PIPESTATUS[0]}"');
      assert.strictEqual(r.status, 0, mode + ': ' + r.stderr);
      assert.strictEqual(r.stdout.trim(), '141', mode);
      assert.ok(!/Broken pipe/.test(r.stderr), mode + ': ' + r.stderr);
    }
  });

  it('17. a writes entry that is a symlink is not granted', () => {
    const fx = fixture();
    const link = path.join(fx.A, 'link');
    fs.symlinkSync(fx.B, link);
    const r = box(fx, profile(fx, { writes: [link] }), 'echo hi > "$FX_A/link/x.txt"');
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /Permission denied/);
    assert.deepStrictEqual(fs.readdirSync(fx.B), []);
    assert.ok(!fs.existsSync(path.join(fx.B, 'x.txt')));
  });

  it('18. readAllow opens one folder pattern inside a read hole, read-only', () => {
    const fx = fixture();
    const tr = path.join(fx.H, 'proj', 'tool-results');
    fs.mkdirSync(tr, { recursive: true });
    fs.writeFileSync(path.join(tr, 'out.txt'), 'long output\n');
    const prof = profile(fx, { readAllow: [path.join(fx.H, '*', 'tool-results')] });
    let r = box(fx, prof, 'cat "$FX_H/proj/tool-results/out.txt"');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, 'long output\n');
    r = box(fx, prof, 'cat "$FX_H/secret.txt"');
    assert.notStrictEqual(r.status, 0, 'the rest of the hole stays closed');
    r = box(fx, prof, 'echo x > "$FX_H/proj/tool-results/new.txt"');
    assert.notStrictEqual(r.status, 0, 'read-only');
    const w = box(fx, { ...prof, mode: 'watch' }, 'cat "$FX_H/proj/tool-results/out.txt" > /dev/null');
    assert.strictEqual(w.status, 0, w.stderr);
    assert.ok(!fs.existsSync(fx.log) || !readLog(fx).some(e => e.rule === 'secret-read'), 'watch does not flag an allowed read');
  });

  it('15. --probe reports what the machine can do', () => {
    assert.ok(PROBE, 'the helper printed a JSON line');
    assert.strictEqual(PROBE.ok, true);
    assert.ok(PROBE.landlockAbi >= 6);
    assert.strictEqual(PROBE.platform, 'linux');
    assert.strictEqual(PROBE.reason, null);
  });
});
