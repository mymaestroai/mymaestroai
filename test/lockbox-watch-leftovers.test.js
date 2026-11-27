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
function run(fx, script, extraEnv, outer) {
  const b64 = Buffer.from(JSON.stringify(profile(fx))).toString('base64');
  const env = Object.assign({}, process.env, { FX_A: fx.A, FX_B: fx.B }, extraEnv || {});
  const args = ['-I', '-S', HELPER, '--profile-b64', b64, '--', 'sh', '-c', script];
  const t0 = Date.now();
  const cmd = outer ? STRACE : PY;
  const full = outer ? ['-f', '-qq', '-e', 'trace=none', '-o', '/dev/null', '--', PY].concat(args) : args;
  return new Promise((resolve) => {
    const c = cp.spawn(cmd, full, { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
const watchDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('lockbox-watch-'));
const rules = (fx) => readLog(fx).map((e) => e.rule);

describe('lockbox-run watch leftovers', { skip }, () => {
  it('T1. a leftover is reported, still watched, and the folder goes when it ends', async () => {
    const fx = fixture();
    const before = new Set(watchDirs());
    const r = await run(fx, 'sleep 6 & exit 4', { LOCKBOX_TEST_GRACE_MS: '1500' });
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
    assert.ok(await until(() => watchDirs().every((n) => before.has(n)), 3000), 'a lockbox-watch folder remains');
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
    let r = await run(fx, 'exit 5', {}, true);   // the probe itself fails under a tracer: the old unavailable path
    assert.strictEqual(r.code, 5, r.err);
    assert.deepStrictEqual(rules(fx).filter((x) => /^watch-/.test(x)), ['watch-unavailable']);
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
});
