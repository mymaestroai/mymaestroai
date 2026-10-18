'use strict';
// Gap-filling tests for lib/jobs.js (test/jobs.test.js covers the happy paths): tail_lines clamping, job files, report_to scoping,
// cancelAll, lost/exit-file edge cases, delivery-attempt cap, halt, prune vs pending, message builders, tailFile edges.
// The runner is driven by hand via _tick() with injected clocks; only quick `true`/`sleep` children are really spawned, in a temp dir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { JobRunner, TOOL_SPECS, runTool, tailFile, MAX_RUNNING_PER_OWNER } = require('../lib/jobs.js');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unit-jobs-')));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const TERMINAL = new Set(['finished', 'failed', 'cancelled', 'timed_out', 'lost']);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(30); } return false; }
const clk = (t0 = Date.parse('2026-10-08T12:00:00Z')) => { const c = { t: t0 }; c.now = () => c.t; return c; };

function rig(extra = {}) {
  const dataDir = extra.dataDir || fs.mkdtempSync(path.join(TMP, 'r'));
  const state = { notes: [], busy: new Set(), reply: 'VERDICT: fine' };
  const runner = new JobRunner({
    dataDir, spawnMode: 'setsid', pollMs: 50, retryMs: 20, log: () => {}, defaultCwd: async () => dataDir,
    notify: async (agent, message, onReply, meta) => { state.notes.push({ agent, message, withReply: !!onReply, meta }); if (onReply) setTimeout(() => onReply(state.reply), 20); },
    isAgentActive: (a) => state.busy.has(a), agentExists: async (a) => ['trader', 'auditor', 'maestro'].includes(a), ...extra,
  });
  return { runner, state, dataDir };
}
const settle = (r) => until(async () => { await r.runner._tick(); return [...r.runner.jobs.values()].every(j => TERMINAL.has(j.status)) && r.runner.pending.length === 0; });
const jf = (r, id, f) => path.join(r.dataDir, 'jobs', id, f);
function fake(r, over = {}) {   // a registry entry with a directory but no process
  const id = crypto.randomBytes(4).toString('hex'); fs.mkdirSync(path.join(r.dataDir, 'jobs', id), { recursive: true });
  const j = { id, name: 'fake', owner: 'trader', reportTo: null, command: 'true', cwd: r.dataDir, timeoutMinutes: 360, status: 'running', startedAt: new Date(r.runner.now()).toISOString(),
    endedAt: null, exitCode: null, notifiedAt: null, replyAt: null, reportedAt: null, mode: 'setsid', unit: `hub-job-${id}`, ...over };
  r.runner.jobs.set(id, j); return j;
}
const deadPid = () => spawnSync('true').pid;

test('status tail_lines: default 20, clamp to 400, 0/negative/NaN -> no tail; log path, job files and index; quote-safe cwd', async () => {
  const r = rig(), cwd = path.join(r.dataDir, "it's here"); fs.mkdirSync(cwd);
  const j = await r.runner.run({ owner: 'trader', name: 'seq', command: 'seq 1 500\npwd -P', cwd });
  assert.ok(await settle(r));
  const tail = (n) => r.runner.status(j.id, 'trader', n === undefined ? undefined : { tailLines: n }).outputTail;
  const lines = (n) => tail(n).split('\n');
  assert.deepStrictEqual([lines().length, lines()[18], lines()[19]], [20, '500', cwd]);   // job ran in the quoted directory
  assert.deepStrictEqual(lines(3), ['499', '500', cwd]);
  assert.deepStrictEqual(lines('2'), ['500', cwd]);
  assert.deepStrictEqual([lines(1000).length, lines(1000)[0]], [400, '102']);
  for (const n of [0, -5, 'abc', NaN]) assert.strictEqual(tail(n), undefined, String(n));
  assert.strictEqual(r.runner.status(j.id, 'trader').log, jf(r, j.id, 'out.log'));
  assert.strictEqual(fs.readFileSync(jf(r, j.id, 'job.sh'), 'utf8'), 'seq 1 500\npwd -P\n');
  assert.strictEqual(fs.statSync(jf(r, j.id, 'job.sh')).mode & 0o777, 0o700);
  assert.deepStrictEqual([fs.readFileSync(jf(r, j.id, 'exit'), 'utf8'), parseInt(fs.readFileSync(jf(r, j.id, 'pid'), 'utf8'), 10) > 0, fs.existsSync(jf(r, j.id, 'wrapper.sh'))], ['0\n', true, true]);
  const idx = JSON.parse(fs.readFileSync(path.join(r.dataDir, 'jobs', 'index.json'), 'utf8'));
  assert.deepStrictEqual([idx.jobs[0].status, idx.pending, fs.existsSync(path.join(r.dataDir, 'jobs', 'index.json.tmp'))], ['finished', [], false]);
  const viaTool = (a) => runTool(r.runner, TOOL_SPECS[1], 'trader', { id: j.id, ...a });
  assert.strictEqual(JSON.parse(await viaTool({})).outputTail.split('\n').length, 20);
  assert.strictEqual(JSON.parse(await viaTool({ tail_lines: 0 })).outputTail, undefined);
});

test('run(): name/timeout/cwd/command normalisation', async () => {
  const r = rig(), go = async (o) => { const j = await r.runner.run({ owner: 'trader', name: 'n', command: 'true', ...o }); assert.ok(await settle(r)); return j; };
  assert.strictEqual((await go({ name: 'a' + 'b'.repeat(79) })).name.length, 80);
  await assert.rejects(r.runner.run({ owner: 'trader', name: 'a' + 'b'.repeat(80), command: 'true' }), /name:/);
  for (const n of ['-x', '.x', '_x']) await assert.rejects(r.runner.run({ owner: 'trader', name: n, command: 'true' }), /name:/, n);
  assert.strictEqual((await go({ name: '  padded  ' })).name, 'padded');
  for (const [given, want] of [['5', 5], ['', 360], [null, 360], [1.5, 1.5], [1440, 1440]]) assert.strictEqual((await go({ timeoutMinutes: given })).timeoutMinutes, want, String(given));
  for (const bad of [0.5, 1441, 'abc', -1]) await assert.rejects(r.runner.run({ owner: 'trader', name: 'n', command: 'true', timeoutMinutes: bad }), /timeout_minutes must be 1-1440/, String(bad));
  const file = path.join(r.dataDir, 'afile'); fs.writeFileSync(file, '');
  await assert.rejects(r.runner.run({ owner: 'trader', name: 'n', command: 'true', cwd: file }), /cwd does not exist/);
  const j = await go({ command: 'echo a\n' });
  assert.strictEqual(fs.readFileSync(jf(r, j.id, 'job.sh'), 'utf8'), 'echo a\n');   // trailing newline not doubled
  assert.strictEqual((await go({})).reportTo, null);
});

test('report_to is trimmed/recorded and scopes list/status/cancel; the master can cancel; notices vs reports are tagged', async () => {
  const c = clk(), r = rig({ now: c.now });
  const a = await r.runner.run({ owner: 'auditor', name: 'a', command: 'sleep 30', reportTo: ' trader ' }); c.t += 1000;
  const b = await r.runner.run({ owner: 'auditor', name: 'b', command: 'echo ' + 'y'.repeat(200), reportTo: '  ' }); c.t += 1000;
  assert.deepStrictEqual([a.reportTo, b.reportTo], ['trader', null]);
  assert.ok(await until(async () => { await r.runner._tick(); return r.runner.jobs.get(b.id).status === 'finished' && fs.existsSync(jf(r, a.id, 'pid')); }));
  assert.deepStrictEqual(r.runner.list('auditor').map(x => x.name), ['b', 'a']);   // newest first
  assert.deepStrictEqual(r.runner.list('trader').map(x => x.name), ['a']);             // the master sees only what reports to it
  assert.deepStrictEqual([r.runner.list('maestro').length, r.runner.list().length], [0, 2]);
  const lb = r.runner.list('auditor')[0];
  assert.deepStrictEqual([lb.command.length, lb.command.endsWith('…'), lb.runningFor], [121, true, undefined]);
  c.t += 63000; assert.strictEqual(r.runner.list('trader')[0].runningFor, '1m 5s');
  assert.throws(() => r.runner.cancel(a.id, 'maestro'), /no job with id/);
  assert.strictEqual(r.runner.cancel(a.id, 'trader').status, 'cancelling');
  assert.ok(await until(async () => { await r.runner._tick(); return r.runner.jobs.get(a.id).status === 'cancelled' && r.state.notes.length === 3; }));
  const report = r.state.notes.find(n => n.agent === 'trader');
  assert.deepStrictEqual(report.meta, { kind: 'job_report', jobId: a.id, jobName: 'a', from: 'auditor' });
  assert.deepStrictEqual(r.state.notes.filter(n => n.agent === 'auditor').map(n => [n.meta.kind, n.meta.from, n.withReply]).sort(), [['job_notice', null, false], ['job_notice', null, true]]);
  const self = JSON.parse(await runTool(r.runner, TOOL_SPECS[0], 'trader', { name: 'self', command: 'true' }, { consultedBy: 'trader' }));
  assert.strictEqual(self.reportTo, null);
  assert.ok(await settle(r));
});

test('cancelAll stops each running job once and leaves finished jobs alone', async () => {
  const r = rig();
  const x = await r.runner.run({ owner: 'trader', name: 'x', command: 'sleep 30' }), y = await r.runner.run({ owner: 'maestro', name: 'y', command: 'sleep 30' });
  const z = await r.runner.run({ owner: 'trader', name: 'z', command: 'true' });
  assert.ok(await until(async () => { await r.runner._tick(); return r.runner.jobs.get(z.id).status === 'finished' && fs.existsSync(jf(r, x.id, 'pid')) && fs.existsSync(jf(r, y.id, 'pid')); }));
  assert.deepStrictEqual(r.runner.cancelAll().sort(), [x.id, y.id].sort());
  assert.deepStrictEqual(r.runner.cancelAll(), []);   // now 'cancelling', not 'running'
  assert.ok(await settle(r));
  assert.deepStrictEqual([x, y, z].map(j => r.runner.jobs.get(j.id).status), ['cancelled', 'cancelled', 'finished']);
});

test('tick edge cases: dead pid gets one poll of grace, late exit file wins, unparsable exit ignored, cancelling resolves', async () => {
  const c = clk(), r = rig({ now: c.now, pollMs: 1000 });
  const w = (j, f, s) => fs.writeFileSync(jf(r, j.id, f), s);
  const dead = fake(r, { name: 'dead' }), nopid = fake(r, { name: 'nopid' }), failed = fake(r, { name: 'failed' }), junk = fake(r, { name: 'junk' }), cx = fake(r, { name: 'cx', status: 'cancelling' }), cx2 = fake(r, { name: 'cx2', status: 'cancelling' });
  w(dead, 'pid', String(deadPid())); w(failed, 'exit', '7'); w(junk, 'exit', 'garbage'); w(junk, 'pid', String(process.pid)); w(cx, 'exit', '143'); w(cx2, 'pid', String(deadPid()));
  await r.runner._tick();
  const st = (j) => r.runner.jobs.get(j.id).status;
  assert.deepStrictEqual([dead, nopid, failed, junk, cx, cx2].map(st), ['running', 'running', 'failed', 'running', 'cancelled', 'cancelling']);
  assert.strictEqual(r.runner.jobs.get(cx.id).exitCode, 143);
  assert.match(r.state.notes.find(n => /"failed"/.test(n.message)).message, /FAILED \(exit 7\)/);
  w(nopid, 'exit', '0'); c.t += 1001;
  await r.runner._tick();
  assert.deepStrictEqual([dead, nopid, junk, cx2].map(st), ['lost', 'finished', 'running', 'cancelled']);
  assert.match(r.runner.jobs.get(dead.id).note, /disappeared without an exit code/);
  assert.ok(r.state.notes.some(n => /"dead".*was LOST/.test(n.message)) && r.state.notes.some(n => /"cx2".*was cancelled/.test(n.message)));
});

test('restart reconcile: a job left "cancelling" whose process is gone is finalized as cancelled and announced', async () => {
  const a = rig(); const j = fake(a, { name: 'half-cancelled', status: 'cancelling' }); fs.writeFileSync(jf(a, j.id, 'pid'), String(deadPid())); a.runner._save();
  const b = rig({ dataDir: a.dataDir }); b.runner.start();
  try {
    assert.ok(await until(() => b.state.notes.length === 1));
    assert.deepStrictEqual([b.runner.jobs.get(j.id).status, b.runner.jobs.get(j.id).note], ['cancelled', 'Cancelled on request.']);
  } finally { b.runner.stop(); }
});

test('delivery gives up after 240 failed attempts and records why; halt blocks run() and notices until resumed', async () => {
  const c = clk(); let calls = 0, halted = 'the hub is halted';
  const r = rig({ now: c.now, retryMs: 100, notify: async () => { calls++; if (calls <= 240) throw new Error('down'); }, haltRefusal: () => halted });
  await assert.rejects(r.runner.run({ owner: 'trader', name: 'x', command: 'true' }), /^Error: the hub is halted$/);
  const j = fake(r); fs.writeFileSync(jf(r, j.id, 'exit'), '0');
  await r.runner._tick(); await r.runner._tick();
  assert.deepStrictEqual([r.runner.jobs.get(j.id).status, calls, r.runner.pending.length], ['finished', 0, 1]);   // finalized, but held while halted
  halted = null;
  for (let i = 0; i < 239; i++) { await r.runner._tick(); c.t += 101; }
  assert.deepStrictEqual([calls, r.runner.pending.length], [239, 1]);
  await r.runner._tick();
  assert.deepStrictEqual([calls, r.runner.pending.length], [240, 0]);
  assert.match(r.runner.jobs.get(j.id).note, /Could not wake trader after 240 attempts: down/);
});

test('prune keeps a finished job until its notice is delivered; run cap counts only "running" jobs', async () => {
  const c = clk(), r = rig({ now: c.now, retryMs: 100 });
  const j = fake(r); fs.writeFileSync(jf(r, j.id, 'exit'), '0'); r.state.busy.add('trader');
  await r.runner._tick(); c.t += 15 * 86400000;
  assert.strictEqual(r.runner.prune(14), 0);   // old enough, but the notice is still pending
  r.state.busy.delete('trader'); await r.runner._tick(); c.t += 200; await r.runner._tick();
  assert.strictEqual(r.state.notes.length, 1);
  assert.strictEqual(r.runner.prune(14), 1);
  assert.ok(!fs.existsSync(path.join(r.dataDir, 'jobs', j.id)));
  const four = Array.from({ length: MAX_RUNNING_PER_OWNER }, () => fake(r, { owner: 'maestro' }));
  await assert.rejects(r.runner.run({ owner: 'maestro', name: 'n', command: 'true' }), (e) => four.every(f => e.message.includes(f.id)));
  r.runner.jobs.get(four[0].id).status = 'cancelling';
  // OBSERVATION: a job in 'cancelling' may still have a live process but no longer counts against the cap, so a 5th job is accepted.
  const fifth = await r.runner.run({ owner: 'maestro', name: 'n', command: 'true' });
  assert.ok(await until(async () => { await r.runner._tick(); return r.runner.jobs.get(fifth.id).status === 'finished'; }));
});

test('message builders: command truncation, note, empty output, duration, report truncation and wording per status', () => {
  const r = rig(), t0 = Date.parse('2026-10-08T12:00:00Z');
  const j = fake(r, { status: 'failed', exitCode: 3, command: 'c'.repeat(400), note: 'N note', reportTo: 'auditor', startedAt: new Date(t0).toISOString(), endedAt: new Date(t0 + 3900000).toISOString() });
  let m = r.runner.completionMessage(j);
  assert.match(m, /FAILED \(exit 3\) after 1h 5m\./);
  assert.ok(m.includes('\nN note\n') && m.includes(`Command: ${'c'.repeat(300)}…\n`) && m.includes('Output: (empty)'));
  assert.match(m, /You ran this job for agent "auditor"/);
  fs.writeFileSync(jf(r, j.id, 'out.log'), 'hi\n');
  assert.match(r.runner.completionMessage(j), /Output \(last 40 lines\):\n```\nhi\n```/);
  m = r.runner.reportMessage(j, 'x'.repeat(13000));
  assert.ok(m.includes('it failed (exit 3) at ') && m.includes('x'.repeat(12000) + '\n…(truncated; the full reply is in trader\'s chat)') && !m.includes('x'.repeat(12001)));
  for (const empty of [null, '   ']) assert.match(r.runner.reportMessage(j, empty), /trader was woken with the result but its report did not come back/);
  assert.match(r.runner.reportMessage({ ...j, status: 'timed_out', exitCode: null }, 'ok'), /it timed out at /);
  assert.match(r.runner.reportMessage({ ...j, status: 'finished', exitCode: 0 }, 'ok'), /it finished \(exit 0\) at /);
});

test('tailFile edges (0 lines -> ""), and tool errors are prefixed with the tool that failed', async () => {
  const f = path.join(TMP, 'tail.txt');
  fs.writeFileSync(f, ''); assert.strictEqual(tailFile(f), '');
  fs.writeFileSync(f, 'a\nb\nc'); assert.strictEqual(tailFile(f, 2), 'b\nc');                       // no trailing newline
  fs.writeFileSync(f, 'a\nb\n\n\n'); assert.strictEqual(tailFile(f, 5), 'a\nb');                    // trailing blank lines trimmed
  fs.writeFileSync(f, 'aaaa\nbbbb\ncccc\n'); assert.strictEqual(tailFile(f, 10, 8), 'cccc');         // partial first line of the window dropped
  fs.writeFileSync(f, 'z'.repeat(1000)); assert.strictEqual(tailFile(f, 5, 100).length, 100);       // one huge line: kept (partial)
  fs.writeFileSync(f, 'a\nb\nc\n');
  for (const n of [0, -1, NaN]) assert.strictEqual(tailFile(f, n), '', String(n));
  const r = rig();
  assert.match(await runTool(r.runner, TOOL_SPECS[1], 'trader', { id: 'nope' }), /^\[job_status error\] no job with id "nope"/);
  assert.match(await runTool(r.runner, TOOL_SPECS[2], 'trader', { id: 'nope' }), /^\[job_cancel error\] no job with id "nope"/);
  assert.match(await runTool(r.runner, TOOL_SPECS[0], 'trader', { name: '', command: 'true' }), /^\[run_job error\] /);
  assert.strictEqual(await runTool(r.runner, TOOL_SPECS[3], 'trader', {}), '[]');
});
