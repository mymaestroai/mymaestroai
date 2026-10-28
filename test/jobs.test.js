'use strict';
// Detached jobs (run_job): the hub runs commands that outlive an agent's turn and wakes the
// agent when they end. Runs with the setsid launcher so it works without a systemd user bus.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JobRunner, policyText, TOOL_SPECS, jsonSchema, zodShape, runTool, tailFile, MAX_RUNNING_PER_OWNER } = require('../lib/jobs');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000, step = 50) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(step); } return false; }

function rig(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-jobs-'));
  const state = { notes: [], busy: new Set(), agents: new Set(['trader', 'auditor', 'maestro']), failNotify: 0, reply: 'VERDICT: fine', repliesSeen: 0 };
  const runner = new JobRunner({
    dataDir, spawnMode: 'setsid', pollMs: 100, retryMs: 150, log: () => {},
    notify: async (agent, message, onReply) => {
      if (state.failNotify > 0) { state.failNotify--; throw new Error('hub down'); }
      state.notes.push({ agent, message, withReply: !!onReply });
      if (onReply && state.reply !== null) setTimeout(() => { state.repliesSeen++; onReply(state.reply); }, 20);   // the woken agent's turn ends
    },
    isAgentActive: (a) => state.busy.has(a),
    agentExists: async (a) => state.agents.has(a),
    defaultCwd: async () => dataDir,
    ...extra,
  });
  return { runner, state, dataDir };
}

describe('run_job: a job outlives the caller and the owner is woken with the result', () => {
  let r;
  before(() => { r = rig(); r.runner.start(); });
  after(() => { r.runner.stop(); fs.rmSync(r.dataDir, { recursive: true, force: true }); });

  it('runs to completion, records exit 0, and delivers a notice with the output tail', async () => {
    const j = await r.runner.run({ owner: 'trader', name: 'hello', command: 'echo one; echo two; echo three' });
    assert.match(j.id, /^[0-9a-f]{8}$/); assert.equal(j.status, 'running'); assert.equal(j.reportTo, null); assert.equal(j.mode, 'setsid');
    assert.ok(await until(() => r.runner.status(j.id, 'trader').status === 'finished'), 'job finished');
    assert.ok(await until(() => r.state.notes.length === 1), 'owner notified');
    const { agent, message, withReply } = r.state.notes[0];
    assert.equal(agent, 'trader'); assert.equal(withReply, false, 'no master to report to');
    assert.match(message, /^\[Job finished\] Job "hello" \(id [0-9a-f]{8}\), which you started at /);
    assert.match(message, /finished \(exit 0\) after \d+s/);
    assert.match(message, /Output \(last 40 lines\):\n```\none\ntwo\nthree\n```/);
    assert.match(message, /Full output: .*out\.log/);
    assert.match(message, /report to the user in this chat/);
    const st = r.runner.status(j.id, 'trader', { tailLines: 2 });
    assert.equal(st.exitCode, 0); assert.equal(st.outputTail, 'two\nthree'); assert.ok(st.endedAt); assert.ok(st.notifiedAt);
    assert.ok(fs.existsSync(path.join(r.dataDir, 'jobs', j.id, 'job.sh')));
  });

  it('a non-zero exit is reported as FAILED with the code; stderr is in the log', async () => {
    const j = await r.runner.run({ owner: 'trader', name: 'boom', command: 'echo oops >&2; exit 3' });
    assert.ok(await until(() => r.state.notes.length === 2));
    assert.equal(r.runner.status(j.id, 'trader').status, 'failed');
    assert.match(r.state.notes[1].message, /FAILED \(exit 3\)/); assert.match(r.state.notes[1].message, /oops/);
  });

  it('a job run for a master: the owner is woken with the result, then its reply is forwarded to the master', async () => {
    const j = await r.runner.run({ owner: 'auditor', name: 'audit-07 run', command: 'echo result', reportTo: 'trader' });
    assert.ok(await until(() => r.state.notes.length === 4));
    const [wake, report] = r.state.notes.slice(2);
    assert.equal(wake.agent, 'auditor'); assert.equal(wake.withReply, true);
    assert.match(wake.message, /You ran this job for agent "trader"[\s\S]*AS YOUR REPORT TO trader[\s\S]*do not consult it yourself/);
    assert.equal(report.agent, 'trader'); assert.equal(report.withReply, false);
    assert.match(report.message, /^\[Job report\] Agent "auditor" ran job "audit-07 run" \(id [0-9a-f]{8}\) for you; it finished \(exit 0\) at /);
    assert.match(report.message, /Here is auditor's report:\n\nVERDICT: fine/); assert.match(report.message, /Raw output: .*out\.log/);
    const st = r.runner.status(j.id, 'trader');
    assert.ok(st.notifiedAt && st.replyAt && st.reportedAt, 'all three stamps set');
    assert.equal(st.id, j.id, 'the master can see it');
    assert.equal(r.runner.status(j.id, 'auditor').id, j.id, 'so can the owner');
    assert.throws(() => r.runner.status(j.id, 'maestro'), /no job with id/);
    assert.equal(r.runner.list('maestro').length, 0); assert.equal(r.runner.list(null).length, 3, 'the hub owner sees all');
    assert.equal(r.runner.list(null)[0].reportTo, 'trader');
  });

  it('report_to equal to the owner means no hand-back', async () => {
    const j = await r.runner.run({ owner: 'trader', name: 'self', command: 'true', reportTo: 'trader' });
    assert.equal(j.reportTo, null);
    assert.ok(await until(() => r.runner.status(j.id, 'trader').status === 'finished'));
    assert.ok(await until(() => r.state.notes.length === 5));
  });

  it('delivery waits while the agent is busy, then happens once', async () => {
    r.state.busy.add('trader');
    const j = await r.runner.run({ owner: 'trader', name: 'busy', command: 'true' });
    assert.ok(await until(() => r.runner.status(j.id, 'trader').status === 'finished'));
    await sleep(400);
    assert.equal(r.state.notes.length, 5, 'nothing delivered while busy');
    r.state.busy.delete('trader');
    assert.ok(await until(() => r.state.notes.length === 6));
    await sleep(300); assert.equal(r.state.notes.length, 6, 'delivered exactly once');
  });

  it('a failed wake-up is retried later, not dropped', async () => {
    r.state.failNotify = 2;
    await r.runner.run({ owner: 'trader', name: 'retry', command: 'true' });
    assert.ok(await until(() => r.state.notes.length === 7, 5000));
    assert.equal(r.state.failNotify, 0);
  });

  it('runs in the given cwd and the default cwd is the owner workspace', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-jobs-cwd-')); fs.writeFileSync(path.join(d, 'marker'), '');
    const j = await r.runner.run({ owner: 'trader', name: 'cwd', command: 'pwd -P; ls', cwd: d });
    assert.ok(await until(() => r.runner.status(j.id, 'trader').status === 'finished'));
    assert.match(r.runner.status(j.id, 'trader').outputTail, new RegExp(`${fs.realpathSync(d)}\\nmarker`));
    const k = await r.runner.run({ owner: 'trader', name: 'cwd2', command: 'pwd -P' });
    assert.ok(await until(() => r.runner.status(k.id, 'trader').status === 'finished'));
    assert.equal(r.runner.status(k.id, 'trader').outputTail, fs.realpathSync(r.dataDir));
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('cancel kills the process (and its children) and reports "cancelled"', async () => {
    const j = await r.runner.run({ owner: 'trader', name: 'long', command: 'sleep 60 & wait' });
    assert.ok(await until(() => fs.existsSync(path.join(r.dataDir, 'jobs', j.id, 'pid'))));
    const c = r.runner.cancel(j.id, 'trader');
    assert.equal(c.status, 'cancelling');
    assert.ok(await until(() => r.runner.status(j.id, 'trader').status === 'cancelled', 5000), 'cancelled');
    assert.ok(await until(() => r.state.notes.some(n => /"long".*was cancelled/.test(n.message))));
    assert.throws(() => r.runner.cancel(j.id, 'maestro'), /no job/);
    assert.equal(r.runner.cancel(j.id, 'trader').status, 'cancelled', 'cancelling a finished job is a no-op');
  });

  it('a cancel issued before the process has even written its pid still kills it', async () => {
    const j = await r.runner.run({ owner: 'trader', name: 'instant-cancel', command: 'sleep 60' });
    r.runner.cancel(j.id, 'trader');
    assert.ok(await until(() => r.runner.status(j.id, 'trader').status === 'cancelled', 6000), 'cancelled without waiting for the sleep');
  });

  it('a job past its timeout is killed and reported as timed out', async () => {
    const base = Date.now(); let offset = 0;
    const t = rig({ now: () => base + offset }); t.runner.start();
    try {
      const j = await t.runner.run({ owner: 'trader', name: 'slow', command: 'sleep 60', timeoutMinutes: 1 });
      await sleep(300);
      assert.equal(t.runner.status(j.id, 'trader').status, 'running');
      offset = 61000;
      assert.ok(await until(() => t.runner.status(j.id, 'trader').status === 'timed_out', 5000));
      assert.match(t.state.notes[0].message, /TIMED OUT.*\n.*1-minute limit/);
    } finally { t.runner.stop(); fs.rmSync(t.dataDir, { recursive: true, force: true }); }
  });

  it('validates input so bad calls fail loudly before anything runs', async () => {
    const run = (o) => r.runner.run({ owner: 'trader', name: 'ok', command: 'true', ...o });
    await assert.rejects(run({ name: '' }), /name:/);
    await assert.rejects(run({ name: 'bad;name' }), /name:/);
    await assert.rejects(run({ command: '  ' }), /command is empty/);
    await assert.rejects(run({ command: 'x'.repeat(20001) }), /longer than 20000/);
    await assert.rejects(run({ reportTo: 'nobody' }), /report_to: no agent named "nobody"/);
    await assert.rejects(run({ cwd: '/nonexistent/dir' }), /cwd does not exist/);
    await assert.rejects(run({ timeoutMinutes: 0 }), /timeout_minutes/);
    await assert.rejects(run({ timeoutMinutes: 100000 }), /timeout_minutes/);
    await assert.rejects(r.runner.run({ name: 'x', command: 'true' }), /owner is required/);
  });

  it('caps running jobs per owner', async () => {
    const ids = [];
    for (let i = 0; i < MAX_RUNNING_PER_OWNER; i++) ids.push((await r.runner.run({ owner: 'maestro', name: `cap${i}`, command: 'sleep 30' })).id);
    await assert.rejects(r.runner.run({ owner: 'maestro', name: 'one-too-many', command: 'true' }), /already have 4 running jobs/);
    for (const id of ids) r.runner.cancel(id, 'maestro');
    assert.ok(await until(() => ids.every(id => r.runner.status(id, 'maestro').status === 'cancelled'), 5000));
  });
});

describe('run_job: hub restarts', () => {
  it('a job that ended while the hub was down is announced on start-up', async () => {
    const a = rig();
    const j = await a.runner.run({ owner: 'trader', name: 'survivor', command: 'sleep 0.4; echo survived' });
    // no start(): the "old hub" never polled. Wait for the process itself to end.
    assert.ok(await until(() => fs.existsSync(path.join(a.dataDir, 'jobs', j.id, 'exit'))));
    const b = rig({ dataDir: a.dataDir }); b.runner.start();
    try {
      assert.ok(await until(() => b.state.notes.length === 1));
      assert.match(b.state.notes[0].message, /"survivor".*finished \(exit 0\)/); assert.match(b.state.notes[0].message, /survived/);
      assert.equal(b.runner.status(j.id, 'trader').status, 'finished');
    } finally { b.runner.stop(); fs.rmSync(a.dataDir, { recursive: true, force: true }); }
  });

  it('a job whose process vanished without an exit code is reported as LOST, never forgotten', async () => {
    const a = rig();
    const j = await a.runner.run({ owner: 'trader', name: 'victim', command: 'sleep 60' });
    assert.ok(await until(() => fs.existsSync(path.join(a.dataDir, 'jobs', j.id, 'pid'))));
    const pid = parseInt(fs.readFileSync(path.join(a.dataDir, 'jobs', j.id, 'pid'), 'utf8'), 10);
    process.kill(-pid, 'SIGKILL'); // what a hub restart does to a setsid job (same cgroup)
    assert.ok(await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }));
    const b = rig({ dataDir: a.dataDir }); b.runner.start();
    try {
      assert.ok(await until(() => b.state.notes.length === 1));
      assert.match(b.state.notes[0].message, /"victim".*was LOST/); assert.match(b.state.notes[0].message, /disappeared without an exit code/);
    } finally { b.runner.stop(); fs.rmSync(a.dataDir, { recursive: true, force: true }); }
  });

  it('an undelivered notice survives a restart', async () => {
    const a = rig(); a.state.busy.add('trader'); a.runner.start();
    const j = await a.runner.run({ owner: 'trader', name: 'held', command: 'true' });
    assert.ok(await until(() => a.runner.status(j.id, 'trader').status === 'finished'));
    await sleep(200); a.runner.stop();
    assert.equal(a.state.notes.length, 0);
    const b = rig({ dataDir: a.dataDir }); b.runner.start();
    try { assert.ok(await until(() => b.state.notes.length === 1)); assert.match(b.state.notes[0].message, /"held"/); }
    finally { b.runner.stop(); fs.rmSync(a.dataDir, { recursive: true, force: true }); }
  });

  it('a wake-up turn cut by a restart still reaches the master with a notice', async () => {
    const a = rig(); a.state.reply = null; a.runner.start();   // the owner is woken but its reply never comes (hub dies mid-turn)
    const j = await a.runner.run({ owner: 'auditor', name: 'cut', command: 'echo x', reportTo: 'trader' });
    assert.ok(await until(() => a.state.notes.length === 1)); await sleep(300); a.runner.stop();
    assert.equal(a.state.notes.length, 1);
    const b = rig({ dataDir: a.dataDir }); b.runner.start();
    try {
      assert.ok(await until(() => b.state.notes.length === 1));
      assert.equal(b.state.notes[0].agent, 'trader');
      assert.match(b.state.notes[0].message, /\[Job report\] Agent "auditor" ran job "cut"[\s\S]*report did not come back/);
      assert.ok(b.runner.status(j.id, 'trader').reportedAt);
      const c = rig({ dataDir: a.dataDir }); c.runner.start(); await sleep(300); c.runner.stop();
      assert.equal(c.state.notes.length, 0, 'not repeated on the next restart');
    } finally { b.runner.stop(); fs.rmSync(a.dataDir, { recursive: true, force: true }); }
  });

  it('prune drops old finished jobs and their directories', async () => {
    const base = Date.now(); let offset = 0;
    const a = rig({ now: () => base + offset }); a.runner.start();
    try {
      const j = await a.runner.run({ owner: 'trader', name: 'old', command: 'true' });
      assert.ok(await until(() => a.state.notes.length === 1));
      assert.equal(a.runner.prune(14), 0);
      offset = 15 * 86400000;
      assert.equal(a.runner.prune(14), 1);
      assert.ok(!fs.existsSync(path.join(a.dataDir, 'jobs', j.id)));
    } finally { a.runner.stop(); fs.rmSync(a.dataDir, { recursive: true, force: true }); }
  });
});

describe('run_job: tool surface and prompt', () => {
  it('the four tools have matching JSON schema and zod shapes', () => {
    assert.deepEqual(TOOL_SPECS.map(t => t.name), ['run_job', 'job_status', 'job_cancel', 'list_jobs']);
    const rj = jsonSchema(TOOL_SPECS[0]);
    assert.deepEqual(rj.required, ['name', 'command']); assert.equal(rj.properties.timeout_minutes.type, 'number');
    const calls = [];
    const z = { string: () => ({ describe(d) { calls.push(['string', d]); return this; }, optional() { calls.push(['opt']); return this; } }), number: () => ({ describe(d) { calls.push(['number', d]); return this; }, optional() { calls.push(['opt']); return this; } }) };
    const shape = zodShape(TOOL_SPECS[0], z);
    assert.deepEqual(Object.keys(shape), ['name', 'command', 'cwd', 'report_to', 'timeout_minutes']);
    assert.equal(calls.filter(c => c[0] === 'opt').length, 3);
  });

  it('runTool returns JSON on success and a plain error line on failure', async () => {
    const a = rig(); a.runner.start();
    try {
      const out = JSON.parse(await runTool(a.runner, TOOL_SPECS[0], 'trader', { name: 'via tool', command: 'echo hi', timeout_minutes: 5 }));
      assert.equal(out.status, 'running'); assert.equal(out.timeoutMinutes, 5); assert.equal(out.reportTo, null);
      const viaConsult = JSON.parse(await runTool(a.runner, TOOL_SPECS[0], 'auditor', { name: 'for trader', command: 'true' }, { consultedBy: 'trader' }));
      assert.equal(viaConsult.reportTo, 'trader', 'the consulting agent is the default master');
      const explicit = JSON.parse(await runTool(a.runner, TOOL_SPECS[0], 'auditor', { name: 'for maestro', command: 'true', report_to: 'maestro' }, { consultedBy: 'trader' }));
      assert.equal(explicit.reportTo, 'maestro');
      assert.ok(await until(() => a.runner.status(out.id, 'trader').status === 'finished' && a.state.notes.some(n => /"via tool"/.test(n.message))));
      const st = JSON.parse(await runTool(a.runner, TOOL_SPECS[1], 'trader', { id: out.id, tail_lines: 5 }));
      assert.equal(st.outputTail, 'hi');
      assert.match(await runTool(a.runner, TOOL_SPECS[1], 'maestro', { id: out.id }), /^\[job_status error\] no job with id/);
      assert.equal(JSON.parse(await runTool(a.runner, TOOL_SPECS[3], 'trader', {})).length, 2, 'own job plus the one reporting to it');
    } finally { a.runner.stop(); fs.rmSync(a.dataDir, { recursive: true, force: true }); }
  });

  it('the prompt text tells every agent that its shell dies with the turn', () => {
    const t = policyText();
    for (const s of ['run_in_background', 'nohup', 'dies with your turn', 'run_job', 'job_status', 'job_cancel', 'I will report when it completes', 'Do not poll', 'report_to']) assert.ok(t.includes(s), s);
  });

  it('tailFile returns the last lines of a large file without loading it all', () => {
    const f = path.join(os.tmpdir(), `hub-jobs-tail-${process.pid}`);
    fs.writeFileSync(f, Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(50)}`).join('\n') + '\n');
    assert.equal(tailFile(f, 3, 400).split('\n').length, 3);
    assert.match(tailFile(f, 3), /^line 4997 x+\nline 4998 x+\nline 4999 x+$/);
    assert.equal(tailFile('/nonexistent'), '');
    fs.unlinkSync(f);
  });
});

describe('run_job: hub wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/sdk-chat.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  it('both tool paths expose the tools, temporal workers get none, and both prompts carry the policy', () => {
    assert.match(src, /jobs\.TOOL_SPECS\.map\(spec => \(\{\s*name: spec\.name, description: spec\.description, parameters: jobs\.jsonSchema\(spec\)/, 'gateway tools');
    assert.match(src, /jobs\.TOOL_SPECS\.map\(spec => sdk\.tool\(spec\.name, spec\.description, jobs\.zodShape\(spec, z\)/, 'SDK MCP tools');
    assert.match(src, /temporalWorkers\.isVirtual\(agentName\) \? \[\] : jobs\.TOOL_SPECS/);
    assert.match(src, /'write_shared_memory', 'run_job', 'job_status', 'job_cancel', 'list_jobs'(, 'schedule_task', 'list_scheduled_tasks', 'cancel_scheduled_task')?\]/);
    assert.match(src, /const jobsPolicyText = \(temporalWorkers\.isVirtual\(agentName\) \? '' : jobs\.policyText\(\)( \+ scheduledTasks\.policyText\(\))?\) \+ timeZoneLib\.policyText\(\);/);
    assert.match(src, /append: agentContext \+ workerPolicyText \+ jobsPolicyText \+/);
    assert.match(src, /if \(!temporalWorkers\.isVirtual\(agentName\)\) systemPrompt \+= jobs\.policyText\(\)( \+ scheduledTasks\.policyText\(\))?;\n\s*systemPrompt \+= timeZoneLib\.policyText\(\);/);
  });
  it('the wake-up is a real saved turn for the notified agent, and the runner starts with the server', () => {
    assert.match(src, /handleChatStream\(\{ agent: agentName, message, origin(, [a-z_]+: [^}]+)? \}, sink\)/);
    assert.match(src, /notify: wakeAgent,\s*isAgentActive,/);
    assert.match(src, /if \(onReply\) onReply\(chunks\.join\(''\)\)/, 'the woken agent\'s reply is captured for the hand-back');
    assert.match(src, /consulted_by: coordinatorName \|\| undefined/, 'consultations carry the master');
    assert.equal((src.match(/consultedBy: consulted_by \|\| null/g) || []).length, 3, 'threaded to all three stream paths (gateway, Claude SDK, Codex CLI)');
    assert.equal((src.match(/jobs\.runTool\(getJobRunner\(\), spec, agentName, args, \{ consultedBy \}\)/g) || []).length, 2, 'both tool paths pass it');
    assert.match(server, /getJobRunner\(\)\.start\(\)/);
    assert.match(server, /pathname === '\/api\/jobs' && req\.method === 'GET'/);
    assert.match(server, /pathname === '\/api\/jobs\/cancel' && req\.method === 'POST'/);
  });
});

describe('run_job for a sandboxed owner runs inside the container (review F05)', () => {
  // A stand-in `docker` on PATH: "docker exec [-i] [-w dir] <name> cmd..." runs cmd locally in dir, so the wrapper's
  // shape (stdin-fed script, pid file in /tmp, cancel through docker exec) is exercised without Docker.
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-docker-'));
  fs.writeFileSync(path.join(fakeBin, 'docker'), [
    '#!/bin/bash',
    '[ "$1" = exec ] || { echo "fake docker: $*" >&2; exit 1; }',
    'shift; dir=; while [ $# -gt 0 ]; do case "$1" in -i) shift;; -w) dir=$2; shift 2;; *) break;; esac; done',
    'shift',   // the container name
    'cd "${dir:-.}" && exec "$@"',
  ].join('\n') + '\n', { mode: 0o755 });
  const withFakeDocker = async (fn) => { const old = process.env.PATH; process.env.PATH = `${fakeBin}:${old}`; try { return await fn(); } finally { process.env.PATH = old; } };
  let r, box;
  before(() => {
    box = { name: 'hub-agent-trader', mounts: [] };
    r = rig({ boxFor: async (owner) => owner === 'trader' ? { ...box, mounts: [r.dataDir] } : null });
    r.runner.start();
  });
  after(() => { r.runner.stop(); fs.rmSync(r.dataDir, { recursive: true, force: true }); fs.rmSync(fakeBin, { recursive: true, force: true }); });

  it('runs the script inside the box, records the box on the job, and finishes with the output', async () => {
    const j = await withFakeDocker(() => r.runner.run({ owner: 'trader', name: 'boxed', command: 'echo inside; pwd' }));
    assert.equal(j.box, 'hub-agent-trader');
    const wrapper = fs.readFileSync(path.join(r.dataDir, 'jobs', j.id, 'wrapper.sh'), 'utf8');
    assert.match(wrapper, /docker exec -i -w '[^']+' "\$C" bash -c "echo \\\$\\\$ > \$P; exec bash -s" < "\$D\/job\.sh"/);
    assert.match(wrapper, /trap term TERM/);
    assert.ok(await until(() => r.runner.status(j.id, 'trader').status === 'finished'), 'finished');
    const st = r.runner.status(j.id, 'trader', { tailLines: 5 });
    assert.equal(st.exitCode, 0);
    assert.match(st.outputTail, /inside/);
    assert.match(st.outputTail, new RegExp(fs.realpathSync(r.dataDir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'ran in the job cwd inside the box');
  });

  it('refuses a working directory outside the box\'s folders', async () => {
    await assert.rejects(withFakeDocker(() => r.runner.run({ owner: 'trader', name: 'outside', command: 'ls', cwd: os.tmpdir() })), /outside your folders/);
  });

  it('a host owner is unaffected (no docker, plain wrapper)', async () => {
    const j = await r.runner.run({ owner: 'auditor', name: 'host', command: 'echo host' });
    assert.equal(j.box, null);
    assert.ok(!fs.readFileSync(path.join(r.dataDir, 'jobs', j.id, 'wrapper.sh'), 'utf8').includes('docker exec'));
    assert.ok(await until(() => r.runner.status(j.id, 'auditor').status === 'finished'));
  });

  it('cancel reaches into the box', async () => {
    const j = await withFakeDocker(() => r.runner.run({ owner: 'trader', name: 'long', command: 'sleep 30' }));
    assert.ok(await until(() => fs.existsSync(`/tmp/hub-job-${j.id}.pid`), 4000), 'the inner shell recorded its pid');
    const c = await withFakeDocker(async () => r.runner.cancel(j.id, 'trader'));
    assert.equal(c.status, 'cancelling');
    assert.ok(await until(() => r.runner.status(j.id, 'trader').status === 'cancelled', 8000), 'cancelled');
    fs.rmSync(`/tmp/hub-job-${j.id}.pid`, { force: true });
  });
});
