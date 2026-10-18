'use strict';
// Hub-wide kill switch: persistent flag, turn/job/worker abort, 503 on new turns, scheduler skip, delegation refusal, resume.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-halt-'));
const FLAG = path.join(tmp, 'hub-halt.json');
process.env.HUB_HALT_FILE = FLAG;

const hubHaltMod = require('../lib/hub-halt');
const sdkChat = require('../lib/sdk-chat');
const hubEvents = require('../lib/hub-events');
const { turnRegistry, setTestStreamer } = sdkChat.__turn;
const { buildHubMcpServer } = sdkChat.__askUser;

const convDir = path.join(__dirname, '..', 'data', 'conversations');
fs.mkdirSync(convDir, { recursive: true });
const AGENTS = ['zz_halt_a', 'zz_halt_b', 'zz_halt_c'];
after(() => {
  setTestStreamer(null);
  try { sdkChat.resumeHub(); } catch {}
  for (const a of AGENTS) try { fs.unlinkSync(path.join(convDir, `${a}.jsonl`)); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const events = [];
hubEvents.events.onPublish(ev => events.push(ev));
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const fakeRes = () => { const r = { code: null, headers: null, body: '', writableEnded: false, destroyed: false, on() {}, writeHead(c, h) { r.code = c; r.headers = h; }, write(s) { r.body += s; return true; }, end(s) { if (s) r.body += s; r.writableEnded = true; } }; return r; };

test('halt writes the flag file; status/refusal reflect it; resume clears it', () => {
  const h = hubHaltMod.getHubHalt();
  assert.strictEqual(h.file, FLAG);
  assert.strictEqual(h.isHalted(), false);
  assert.strictEqual(h.refusal(), null);
  const r = h.halt('testing');
  assert.strictEqual(r.halted, true);
  assert.strictEqual(r.already, false);
  const onDisk = JSON.parse(fs.readFileSync(FLAG, 'utf8'));
  assert.strictEqual(onDisk.halted, true);
  assert.strictEqual(onDisk.reason, 'testing');
  assert.ok(Date.parse(onDisk.at));
  assert.match(h.refusal(), /^hub is halted \(testing\)/);
  assert.strictEqual(h.halt('again').already, true, 'a second halt keeps the first reason');
  assert.strictEqual(h.status().reason, 'testing');
  assert.deepStrictEqual(h.resume(), { halted: false, was: true });
  assert.strictEqual(fs.existsSync(FLAG), false);
  assert.strictEqual(h.isHalted(), false);
  assert.deepStrictEqual(h.resume(), { halted: false, was: false });
});

test('the flag survives a module reload (a hub restart), and deleting the file resumes', () => {
  const a = hubHaltMod.createHubHalt({ file: FLAG });
  a.halt('restart me');
  const b = hubHaltMod.createHubHalt({ file: FLAG });            // a fresh instance = a fresh process
  assert.strictEqual(b.isHalted(), true);
  assert.strictEqual(b.status().reason, 'restart me');
  delete require.cache[require.resolve('../lib/hub-halt')];
  const reloaded = require('../lib/hub-halt');
  assert.strictEqual(reloaded.getHubHalt().isHalted(), true);
  fs.unlinkSync(FLAG);                                           // hand-deleting the file resumes
  assert.strictEqual(a.isHalted(), false);
  assert.strictEqual(reloaded.getHubHalt().isHalted(), false);
});

test('haltHub aborts registered turns, ephemeral workers, tiger teams and jobs, then publishes hub_halted', async () => {
  const stopped = [];
  const jobs = { cancelAll: () => ['job-1', 'job-2'] };
  const tt = [];
  const ac = new AbortController();
  turnRegistry.set('zz_halt_a', { turnId: 't1', origin: { kind: 'user' }, startedAt: 'x', detached: false, abortController: ac });
  const r = sdkChat.haltHub('stop it', {
    stopAgentTurn: (a) => { stopped.push(a); return { ok: true }; },
    stopTigerTeam: (id, why) => { tt.push([id, why]); },
    jobRunner: jobs,
  });
  turnRegistry.delete('zz_halt_a');
  assert.deepStrictEqual(stopped, ['zz_halt_a']);
  assert.deepStrictEqual(tt, [[null, 'halt']]);
  assert.deepStrictEqual(r.cancelledJobs, ['job-1', 'job-2']);
  assert.strictEqual(r.halted, true);
  assert.strictEqual(hubHaltMod.getHubHalt().isHalted(), true);
  const ev = events.find(e => e.type === 'hub_halted');
  assert.ok(ev, 'hub_halted published');
  assert.strictEqual(ev.reason, 'stop it');
  assert.ok(ev.at);
  assert.strictEqual(sdkChat.haltHub('twice', { stopAgentTurn: () => ({ ok: true }), stopTigerTeam() {}, jobRunner: jobs }).already, true);
  assert.strictEqual(events.filter(e => e.type === 'hub_halted').length, 1, 'a repeat halt does not re-announce');
  sdkChat.resumeHub();
});

test('a running turn really is aborted by haltHub (real stopAgentTurn) and an ephemeral worker turn too', async () => {
  let aborted = null, workerAborted = null;
  setTestStreamer(async ({ agent, signal, res }) => {
    await new Promise(r => signal.addEventListener('abort', r, { once: true }));
    if (agent === AGENTS[1]) workerAborted = signal.aborted; else aborted = signal.aborted;
  });
  const turn = sdkChat.handleChatStream({ agent: AGENTS[0], message: 'work' }, fakeRes());
  const worker = sdkChat.handleChatStream({ agent: AGENTS[1], message: 'work', ephemeral: true }, fakeRes());
  await tick(30);
  assert.ok(turnRegistry.get(AGENTS[0]));
  assert.strictEqual(turnRegistry.has(AGENTS[1]), false, 'ephemeral turns are not in turnRegistry');
  const r = sdkChat.haltHub('abort test', { jobRunner: { cancelAll: () => [] } });
  await Promise.all([turn, worker]);
  assert.strictEqual(aborted, true);
  assert.strictEqual(workerAborted, true);
  assert.deepStrictEqual(r.stoppedAgents, [AGENTS[0]]);
  assert.strictEqual(r.stoppedWorkers, 1);
  setTestStreamer(null);
  sdkChat.resumeHub();
});

test('while halted /api/chat/stream is refused with 503 {error, reason}; override:true passes; resume reopens it', async () => {
  let ran = 0;
  setTestStreamer(async () => { ran++; });
  sdkChat.haltHub('closed', { jobRunner: { cancelAll: () => [] } });
  const r1 = fakeRes();
  await sdkChat.handleChatStream({ agent: AGENTS[2], message: 'hi' }, r1);
  assert.strictEqual(r1.code, 503);
  assert.deepStrictEqual({ error: JSON.parse(r1.body).error, reason: JSON.parse(r1.body).reason }, { error: 'hub halted', reason: 'closed' });
  assert.strictEqual(ran, 0);
  const r2 = fakeRes();
  await sdkChat.handleChatStream({ agent: AGENTS[2], message: 'hi', override: true }, r2);
  assert.notStrictEqual(r2.code, 503);
  assert.strictEqual(ran, 1, 'override runs the turn');
  // the non-streaming route passes the 503 through
  const r3 = fakeRes();
  await sdkChat.handleChat({ agent: AGENTS[2], message: 'hi' }, r3);
  assert.strictEqual(r3.code, 503);
  const res = sdkChat.resumeHub();
  assert.deepStrictEqual(res, { halted: false, was: true });
  assert.ok(events.find(e => e.type === 'hub_resumed'), 'hub_resumed published');
  const r4 = fakeRes();
  await sdkChat.handleChatStream({ agent: AGENTS[2], message: 'hi' }, r4);
  assert.notStrictEqual(r4.code, 503);
  assert.strictEqual(ran, 2);
  setTestStreamer(null);
});

test('status_snapshot carries halted and the halt provider is wired', () => {
  sdkChat.haltHub('snap', { jobRunner: { cancelAll: () => [] } });
  const out = [];
  const client = { write: (s) => { out.push(s); return true; }, on() {}, writeHead() {}, end() {}, destroy() {}, writableEnded: false, destroyed: false };
  hubEvents.events.subscribe({ headers: {} }, client);
  const snap = out.join('').split('\n\n').find(f => f.startsWith('event: status_snapshot'));
  assert.ok(snap, 'snapshot sent');
  const data = JSON.parse(snap.split('\n').find(l => l.startsWith('data: ')).slice(6));
  assert.strictEqual(data.halted, true);
  assert.strictEqual(data.haltReason, 'snap');
  sdkChat.resumeHub();
});

test('delegation tools (consult_agent, spawn_workers) and run_job refuse while halted', async () => {
  const sdk = { tool: (name, description, shape, handler, opts) => ({ name, description, shape, handler, opts }), createSdkMcpServer: (cfg) => cfg };
  const server = await buildHubMcpServer('zz_halt_a', fakeRes(), sdk, {});
  sdkChat.haltHub('no delegation', { jobRunner: { cancelAll: () => [] } });
  const call = (name, args) => server.tools.find(t => t.name === name).handler(args);
  const c = await call('consult_agent', { agent: 'haiku', prompt: 'hi' });
  assert.match(c.content[0].text, /hub is halted \(no delegation\)/);
  const s = await call('spawn_workers', { workers: [{ task: 'x' }] });
  assert.match(s.content[0].text, /hub is halted/);
  const runJob = server.tools.find(t => t.name === 'run_job');
  assert.ok(runJob, 'run_job tool present');
  const j = await runJob.handler({ name: 'x', command: 'true' });
  assert.match(JSON.stringify(j), /hub is halted \(no delegation\)/);
  sdkChat.resumeHub();
});

test('job runner: run() refuses while halted, cancelAll stops only running jobs', async () => {
  const { JobRunner } = require('../lib/jobs');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-halt-jobs-'));
  let refusal = null;
  const runner = new JobRunner({ dataDir, spawnMode: 'setsid', pollMs: 100, log: () => {}, notify: async () => {}, isAgentActive: () => false, agentExists: async () => true, defaultCwd: async () => dataDir, haltRefusal: () => refusal });
  try {
    const j = await runner.run({ owner: 'maestro', name: 'sleeper', command: 'sleep 30' });
    assert.strictEqual(j.status, 'running');
    refusal = 'hub is halted (x)';
    await assert.rejects(runner.run({ owner: 'maestro', name: 'late', command: 'true' }), /hub is halted/);
    assert.deepStrictEqual(runner.cancelAll(), [j.id]);
    assert.strictEqual(runner.status(j.id).status, 'cancelling');
    assert.deepStrictEqual(runner.cancelAll(), [], 'already cancelling: nothing more to stop');
  } finally { runner.stop(); fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test('scheduler: a halted hub fires no TASKS.md task and logs "skipped: hub halted"', async () => {
  const sched = require('../lib/scheduler');
  assert.strictEqual(typeof sched.executeAgentTask, 'function');
  const logs = [];
  const orig = console.log; console.log = (...a) => { logs.push(a.join(' ')); };
  try {
    sdkChat.haltHub('sched', { jobRunner: { cancelAll: () => [] } });
    await sched.executeAgentTask('zz_halt_c', 'nightly', 'do the thing');
  } finally { console.log = orig; sdkChat.resumeHub(); }
  assert.ok(logs.some(l => /skipped: hub halted/.test(l)), logs.join('\n'));
});

test('schedule_task: due tasks are not delivered while halted (dropped as missed, recurring keeps its next run)', async () => {
  const st = require('../lib/scheduled-tasks');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-halt-sched-'));
  const T0 = Date.parse('2026-09-29T18:00:00Z');
  const clock = { t: T0 }; const woken = []; let refusal = null;
  const inst = new st.ScheduledTasks({
    dataDir, now: () => clock.t, log: () => {}, retryMs: 1000, pollMs: 60000,
    agentExists: async () => true, isAgentActive: () => false,
    haltRefusal: () => refusal,
    notify: async (agent, message) => { woken.push({ agent, message }); },
  });
  try {
    await inst.create({ requester: 'trader', when: 'in 1 hour', prompt: 'one-off' });
    await inst.create({ requester: 'trader', when: 'every 4 hours', prompt: 'recurring' });
    clock.t = T0 + 5 * 3600000; refusal = 'hub is halted';
    await inst.tick();
    assert.strictEqual(woken.length, 0, 'nothing fired while halted');
    const list = inst.list('trader');
    const once = list.find(t => t.type === 'once');
    assert.notStrictEqual(once.status, 'pending', 'the one-off is not left pending to fire after resume');
    assert.match(JSON.stringify(once), /skipped: hub halted/);
    const rec = list.find(t => t.type === 'recurring');
    assert.ok(Date.parse(rec.nextRunAt) > clock.t, 'the recurring task moves on to its next run');
  } finally { inst.stop(); fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});
