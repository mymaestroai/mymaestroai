// A boxed job's cancel gives up after boxCancelSeconds when Docker never answers (lib/jobs.js, the wrapper's term()), with and
// without `timeout`, and a timed-out boxed job waits for its wrapper and says when the box did not answer.
// Real JobRunner in setsid mode and a fake `docker` that behaves by a scenario file.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JobRunner, cancelledNote, cancelVerdict, DEFAULT_BOX_CANCEL_SECONDS } = require('../lib/jobs.js');

const sleep = (ms) => new Promise(x => setTimeout(x, ms));
const BOUND = 4;   // boxCancelSeconds for most jobs here
const LIMIT_MS = (BOUND + 4) * 1000;

// The fake docker: `exec -i` is the job itself (a client that lives until the file "cancelled" appears, at most 30 s);
// every other call follows the scenario named in the file "scenario". "token" is a unique sleep length, so a leftover is ours.
function fakeDocker(dir, token) {
  return `#!/bin/bash
DIR=${dir}
if [ "$1" = exec ] && [ "$2" = -i ]; then
  : > "$DIR/job-started"
  for i in $(seq 150); do [ -e "$DIR/cancelled" ] && exit 143; sleep 0.2; done
  exit 0
fi
case "$(cat "$DIR/scenario")" in
  unreachable) echo "Cannot connect to the Docker daemon" >&2; exit 1;;
  hanging) exec sleep ${token};;
  ignoreterm) trap '' TERM; exec sleep ${token};;
  missing) echo "Error: No such container: box-test" >&2; : > "$DIR/cancelled"; exit 1;;
  answers) : > "$DIR/cancelled"; exit 0;;
esac
exit 1
`;
}

// 'gone' only on proof: no such process, a zombie, or a pid now running something else; any other read error is not proof
function wrapperState(pid) {
  let cmd, stat;
  try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); }
  catch (e) { return e && e.code === 'ENOENT' ? 'gone' : 'unknown'; }
  if (!cmd.includes('wrapper.sh')) return 'gone';
  return (stat.slice(stat.lastIndexOf(')') + 2)[0] === 'Z') ? 'gone' : 'alive';
}

// live (non-zombie) processes whose command line holds one of the needles
function leftovers(needles) {
  const out = [];
  for (const e of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(e) || Number(e) === process.pid) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${e}/cmdline`, 'utf8').replace(/\0/g, ' ');
      const stat = fs.readFileSync(`/proc/${e}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2)[0] === 'Z') continue;
      if (needles.some(n => cmd.includes(n))) out.push(`${e}: ${cmd}`);
    } catch { /* gone meanwhile */ }
  }
  return out;
}

// A bin folder with the tools the wrapper and the fake need, and no `timeout`.
// With perl (the default) lim() uses the lim.pl supervisor; without it, lim() makes no call at all.
function noTimeoutBin(bin, { perl = true } = {}) {
  for (const name of ['bash', 'sh', 'sleep', 'cat', 'mv', 'rm', 'touch', 'seq', 'mkdir', 'dirname', 'env', 'setsid', 'cut', 'sed', 'true', 'date', ...(perl ? ['perl'] : [])]) {
    for (const d of ['/usr/bin', '/bin']) {
      if (fs.existsSync(path.join(d, name))) { try { fs.symlinkSync(path.join(d, name), path.join(bin, name)); } catch { /* exists */ } break; }
    }
  }
  assert.ok(!fs.existsSync(path.join(bin, 'timeout')));
  assert.strictEqual(fs.existsSync(path.join(bin, 'perl')), perl);
}

// opts: { noTimeout, bound, timeoutMinutes }. ctx.r is the current runner; ctx.restart() stops it and starts a second on the same data.
async function withJob(scenario, opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobcancel-'));
  const token = `1000.${Math.floor(100000 + Math.random() * 899999)}`;
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const envPath = opts.noTimeout ? bin : `${bin}:${process.env.PATH}`;
  if (opts.noTimeout) noTimeoutBin(bin, { perl: !opts.noPerl });
  fs.writeFileSync(path.join(dir, 'scenario'), scenario);
  fs.writeFileSync(path.join(bin, 'docker'), fakeDocker(dir, token), { mode: 0o755 });
  let r = null, job = null, jobDir = null, skew = 0;
  const bound = opts.bound || BOUND;
  const mk = () => { const x = new JobRunner({ dataDir: path.join(dir, 'a'), spawnMode: 'setsid', pollMs: 50, log: () => {}, defaultCwd: async () => dir, notify: async () => {}, agentExists: async () => true,
    now: () => Date.now() + skew, boxCancelSeconds: bound, boxFor: async () => ({ name: 'box-test', mounts: [dir] }), envFor: () => ({ PATH: envPath }) }); x.start(); return x; };
  const wrapperPid = () => { try { return parseInt(fs.readFileSync(path.join(jobDir, 'pid'), 'utf8'), 10) || null; } catch { return null; } };
  const terminal = () => { try { return !['running', 'cancelling', 'stopping'].includes(r.status(job.id, 'sam').status); } catch { return false; } };
  const ctx = {
    get r() { return r; }, get job() { return job; }, get jobDir() { return jobDir; }, dir, token, wrapperPid, terminal,
    jump: (ms) => { skew += ms; },
    restart: () => { r.stop(); r = mk(); return r; },
    noStrays: async () => {   // nothing of this test's folder or its fake sleep is left (zombies ignored)
      let left = [];
      for (let i = 0; i < 50; i++) { left = leftovers([dir, token]); if (!left.length) break; await sleep(100); }
      assert.deepStrictEqual(left, [], 'no process of this test is left');
    },
  };
  try {
    r = mk();
    job = await r.run({ owner: 'sam', name: 'b', command: 'sleep 30', cwd: dir, ...(opts.timeoutMinutes ? { timeoutMinutes: opts.timeoutMinutes } : {}) });
    jobDir = path.join(dir, 'a', 'jobs', job.id);
    // the wrapper has its pid file and the job's docker client is up: the cancel trap is installed
    for (let i = 0; i < 200 && !(wrapperPid() && fs.existsSync(path.join(dir, 'job-started'))); i++) await sleep(50);
    assert.ok(wrapperPid(), 'the wrapper wrote its pid file');
    await fn(ctx);
  } finally {
    // Cancel first; the fake docker (in `dir`) must stay until the wrapper is gone, or its cancel would run the real docker.
    try { fs.writeFileSync(path.join(dir, 'cancelled'), ''); } catch { /* ignore */ }   // the fake job client may end now
    try { if (r && job && !terminal()) r.cancel(job.id, 'sam'); } catch { /* ignore */ }
    try { r && r.cancelAll && r.cancelAll(); } catch { /* ignore */ }
    let confirmed = !job;
    if (job) {
      const ended = () => { const pid = wrapperPid(); return pid ? wrapperState(pid) === 'gone' && terminal() : terminal(); };
      for (let i = 0; i < 150 && !ended(); i++) await sleep(100);   // up to 15 s
      const wpid = wrapperPid();
      let cmd = ''; try { cmd = fs.readFileSync(`/proc/${wpid}/cmdline`, 'utf8'); } catch { /* gone */ }
      if (wpid && wpid > 1 && cmd.includes('wrapper.sh') && wrapperState(wpid) === 'alive') { try { process.kill(-wpid, 'SIGKILL'); } catch { /* gone */ } await sleep(300); }
      confirmed = (!wpid && terminal()) || (!!wpid && wrapperState(wpid) === 'gone');
      if (confirmed) await sleep(500);   // the fake job client sees "cancelled" and leaves
    }
    // Without proof the wrapper is gone, the folder (and its fake docker) is kept.
    try { r && r.stop(); } catch { /* ignore */ }
    if (confirmed) fs.rmSync(dir, { recursive: true, force: true });
  }
}

const NON_TERMINAL = ['running', 'cancelling', 'stopping'];
async function waitTerminal(ctx, limitMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < limitMs && NON_TERMINAL.includes(ctx.r.status(ctx.job.id, 'sam').status)) await sleep(50);
  return { st: ctx.r.status(ctx.job.id, 'sam'), ms: Date.now() - t0 };
}
// cancel, then wait until the job is terminal; returns { st, ms }
async function cancelAndWait(ctx, limitMs) {
  const t0 = Date.now();
  ctx.r.cancel(ctx.job.id, 'sam');
  const { st } = await waitTerminal(ctx, limitMs);
  return { st, ms: Date.now() - t0 };
}

async function assertWrapperGone(ctx) {
  const pid = ctx.wrapperPid();
  for (let i = 0; i < 40 && wrapperState(pid) !== 'gone'; i++) await sleep(50);
  assert.strictEqual(wrapperState(pid), 'gone', 'the wrapper process is gone');
}

for (const noTimeout of [false, true]) {
  const how = noTimeout ? 'no timeout command' : 'with timeout';
  for (const [scenario, label] of [['unreachable', 'Docker unreachable'], ['hanging', 'Docker hanging'], ['ignoreterm', 'Docker client ignoring TERM']]) {
    test(`boxed cancel: ${label} (${how}) - gives up after the bound, says the box did not answer`, async () => {
      await withJob(scenario, { noTimeout }, async (ctx) => {
        const { st, ms } = await cancelAndWait(ctx, LIMIT_MS + 3000);
        assert.strictEqual(st.status, 'cancelled');
        assert.ok(ms <= LIMIT_MS, `took ${ms} ms`);
        // (the 3 s kill grace is inside the 4 s budget, so a call gets 1 s: giving up comes early, by design)
        assert.strictEqual(st.note, cancelledNote(true, BOUND));
        assert.match(st.note, /did not answer for 4 seconds/);
        assert.ok(fs.existsSync(path.join(ctx.jobDir, 'box-noanswer')));
        await assertWrapperGone(ctx);
        await ctx.noStrays();
      });
    });
  }

  for (const [scenario, label] of [['missing', 'the box is gone (no such container)'], ['answers', 'Docker answers']]) {
    test(`boxed cancel: ${label} (${how}) - cancelled at once, plain note`, async () => {
      await withJob(scenario, { noTimeout }, async (ctx) => {
        const { st, ms } = await cancelAndWait(ctx, 8000);
        assert.strictEqual(st.status, 'cancelled');
        assert.ok(ms <= BOUND * 1000, `took ${ms} ms`);
        assert.strictEqual(st.note, 'Cancelled on request.');
        assert.ok(!fs.existsSync(path.join(ctx.jobDir, 'box-noanswer')));
        await assertWrapperGone(ctx);
        await ctx.noStrays();
      });
    });
  }
}

// Neither `timeout` nor perl: lim() makes no docker call it could not bound, so even an answering Docker gives no proof and the
// cancel gives up when its time is over, saying the command may still be running.
test('boxed cancel: no timeout and no perl - no unbounded docker call; gives up after the bound and says so', async () => {
  await withJob('answers', { noTimeout: true, noPerl: true }, async (ctx) => {
    const { st, ms } = await cancelAndWait(ctx, LIMIT_MS + 3000);
    assert.strictEqual(st.status, 'cancelled');
    assert.ok(ms <= LIMIT_MS, `took ${ms} ms`);
    assert.strictEqual(st.note, cancelledNote(true, BOUND));
    assert.ok(fs.existsSync(path.join(ctx.jobDir, 'box-noanswer')));
    await assertWrapperGone(ctx);
    await ctx.noStrays();
  });
});

test('a boxed job folder holds the lim.pl supervisor; it passes the status through and stops a call past its limit', () => {
  const { execFileSync, spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobcancel-limpl-'));
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'jobs.js'), 'utf8');
    assert.match(src, /fs\.writeFileSync\(path\.join\(dir, 'lim\.pl'\), LIM_PL/);
    const m = /const LIM_PL = \[([\s\S]*?)\]\.join\('\\n'\) \+ '\\n';/.exec(src);
    assert.ok(m, 'LIM_PL found');
    const lines = eval('[' + m[1] + ']');   // the array literal of plain strings, as written in lib/jobs.js
    const pl = path.join(dir, 'lim.pl'); fs.writeFileSync(pl, lines.join('\n') + '\n');
    assert.strictEqual(spawnSync('perl', [pl, '5', '/bin/sh', '-c', 'echo out; exit 7'], { encoding: 'utf8' }).status, 7);
    assert.strictEqual(execFileSync('perl', [pl, '5', '/bin/sh', '-c', 'echo out'], { encoding: 'utf8' }), 'out\n', 'output passes through');
    const t0 = Date.now();
    const r = spawnSync('perl', [pl, '1', '/bin/sh', '-c', "trap '' TERM; exec /bin/sleep 30"], { encoding: 'utf8' });
    assert.strictEqual(r.status, 124, 'stopped past its limit');
    assert.ok(Date.now() - t0 < 4500, `took ${Date.now() - t0} ms (1 s limit + 2 s kill grace)`);
    // a call that leaves a writer behind (here a 2 s sleep holding its output) cannot hold the caller's pipe open
    const t1 = Date.now();
    const bg = spawnSync('perl', [pl, '5', '/bin/sh', '-c', '(exec /bin/sleep 2 &); echo started; exit 3'], { encoding: 'utf8' });
    assert.strictEqual(bg.status, 3);
    assert.strictEqual(bg.stdout, 'started\n');
    assert.ok(Date.now() - t1 < 1500, `took ${Date.now() - t1} ms: the leftover writer held the output`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── a timed-out boxed job waits for its wrapper ─────────────────────────────────────────────────────────────────
const TIMEOUT_NOTE = 'Killed by the hub after the 1-minute limit.';
const WARNING = " The agent's box did not answer the stop for 4 seconds, so the command may still be running inside it.";

test('boxed timeout: Docker unreachable - timed_out with the limit note plus the box warning', async () => {
  await withJob('unreachable', { timeoutMinutes: 1 }, async (ctx) => {
    ctx.jump(2 * 60000);
    const t0 = Date.now();
    await sleep(400);
    assert.strictEqual(ctx.r.status(ctx.job.id, 'sam').status, 'cancelling', 'not finished while the wrapper is stopping the command');
    const { st } = await waitTerminal(ctx, LIMIT_MS + 3000);
    assert.ok(Date.now() - t0 <= LIMIT_MS, 'within the bound');
    assert.strictEqual(st.status, 'timed_out');
    assert.strictEqual(st.note, TIMEOUT_NOTE + WARNING);
    assert.ok(fs.existsSync(path.join(ctx.jobDir, 'box-noanswer')));
    await assertWrapperGone(ctx);
    await ctx.noStrays();
  });
});

test('boxed timeout: Docker answers - timed_out with the plain limit note', async () => {
  await withJob('answers', { timeoutMinutes: 1 }, async (ctx) => {
    ctx.jump(2 * 60000);
    const { st, ms } = await waitTerminal(ctx, 8000);
    assert.strictEqual(st.status, 'timed_out');
    assert.ok(ms <= BOUND * 1000, `took ${ms} ms`);
    assert.strictEqual(st.note, TIMEOUT_NOTE);
    assert.ok(!fs.existsSync(path.join(ctx.jobDir, 'box-noanswer')));
    await assertWrapperGone(ctx);
    await ctx.noStrays();
  });
});

test('boxed timeout: a user cancel while the timeout stop is pending stays a timeout', async () => {
  await withJob('unreachable', { timeoutMinutes: 1 }, async (ctx) => {
    ctx.jump(2 * 60000);
    for (let i = 0; i < 100 && ctx.r.status(ctx.job.id, 'sam').status !== 'cancelling'; i++) await sleep(50);
    ctx.r.cancel(ctx.job.id, 'sam');
    const { st } = await waitTerminal(ctx, LIMIT_MS + 3000);
    assert.strictEqual(st.status, 'timed_out');
    assert.strictEqual(st.note, TIMEOUT_NOTE + WARNING);
    await assertWrapperGone(ctx);
    await ctx.noStrays();
  });
});

test('boxed timeout: a hub restart while the timeout stop is pending - the new runner finishes it timed_out with the warning', async () => {
  await withJob('unreachable', { timeoutMinutes: 1, bound: 6 }, async (ctx) => {
    ctx.jump(2 * 60000);
    for (let i = 0; i < 100 && ctx.r.status(ctx.job.id, 'sam').status !== 'cancelling'; i++) await sleep(50);
    assert.strictEqual(ctx.r.status(ctx.job.id, 'sam').status, 'cancelling');
    const saved = JSON.parse(fs.readFileSync(path.join(ctx.dir, 'a', 'jobs', 'index.json'), 'utf8').toString());
    const rec = saved.jobs.find(j => j.id === ctx.job.id);
    assert.strictEqual(rec.endReason, 'timeout', 'endReason is on the saved record');
    ctx.restart();   // the first runner's poller is stopped; the second loads the record
    assert.strictEqual(ctx.r.status(ctx.job.id, 'sam').status, 'cancelling');
    const { st } = await waitTerminal(ctx, (6 + 4) * 1000 + 3000);
    assert.strictEqual(st.status, 'timed_out');
    assert.strictEqual(st.note, TIMEOUT_NOTE + WARNING.replace('4 seconds', '6 seconds'));
    assert.ok(fs.existsSync(path.join(ctx.jobDir, 'box-noanswer')));
    await assertWrapperGone(ctx);
    await ctx.noStrays();
  });
});

// ── source and helpers ──────────────────────────────────────────────────────────────────────────────────────────
test('boxed cancel: the wrapper text is bounded (t_end, box-noanswer, no deadline-less loop, own client only)', async () => {
  await withJob('answers', async (ctx) => {
    const text = fs.readFileSync(path.join(ctx.jobDir, 'wrapper.sh'), 'utf8');
    assert.ok(text.includes(`t_end=$((SECONDS + ${BOUND}))`), 'the bound is baked in');
    assert.ok(text.includes('l=$((rem - 3))'), 'the kill grace (3 s with lim.pl) is kept inside the budget');
    assert.ok(text.includes('box-noanswer'));
    assert.ok(!text.includes('while :; do lim 20'), 'no loop without a deadline');
    assert.ok(text.includes('timeout -k 2 "$t"'), 'the kill grace is 2 s');
    assert.ok(!text.includes('timeout -k 5'));
    assert.ok(text.includes('/proc/$w/stat') && text.includes('"$2" = "$$"'), 'only a docker child of this wrapper is killed');
    assert.ok(text.indexOf('w=\n') < text.indexOf('trap term TERM'), 'w is set before the trap can run term()');
    await cancelAndWait(ctx, 8000);
    await assertWrapperGone(ctx);
    await ctx.noStrays();
  });
});

test('cancelledNote, cancelVerdict and the bound clamp', () => {
  assert.strictEqual(cancelledNote(false, 60), 'Cancelled on request.');
  assert.strictEqual(cancelledNote(true, 7), "Cancelled, but the agent's box did not answer for 7 seconds, so the command may still be running inside it.");
  assert.deepStrictEqual(cancelVerdict({ timeoutMinutes: 5 }, false, 9), { status: 'cancelled', note: 'Cancelled on request.' });
  assert.deepStrictEqual(cancelVerdict({ endReason: 'timeout', timeoutMinutes: 5 }, false, 9), { status: 'timed_out', note: 'Killed by the hub after the 5-minute limit.' });
  assert.deepStrictEqual(cancelVerdict({ endReason: 'timeout', timeoutMinutes: 5 }, true, 9),
    { status: 'timed_out', note: "Killed by the hub after the 5-minute limit. The agent's box did not answer the stop for 9 seconds, so the command may still be running inside it." });
  const mk = (extra) => new JobRunner({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'jobcancel-d-')), spawnMode: 'setsid', log: () => {}, ...extra });
  const bound = (v) => { const r = mk(v === undefined ? {} : { boxCancelSeconds: v }); r.stop(); return r.boxCancelSeconds; };
  assert.strictEqual(bound(), DEFAULT_BOX_CANCEL_SECONDS);
  assert.strictEqual(bound(-5), 60);
  assert.strictEqual(bound(0), 60);
  assert.strictEqual(bound('9'), 60);
  assert.strictEqual(bound(NaN), 60);
  assert.strictEqual(bound(0.2), 4, 'at least 4 s: under that term() would give up before its first docker call');
  assert.strictEqual(bound(2.5), 4);
  assert.strictEqual(bound(4.2), 5);
  assert.strictEqual(bound(1e21), 86400);
  assert.strictEqual(bound(Infinity), 60);
});
