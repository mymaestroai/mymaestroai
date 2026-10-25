'use strict';
// Stop always stops. A stopped turn takes every turn it started with it (consultations, temporary workers, stand-ins,
// and theirs); Stop on a worker card stops that one call; a call still waiting for its agent never starts; a call whose
// caller was stopped while it was on its way stops at once; the requests a stopped turn queued for busy agents are
// dropped. Unrelated turns keep running.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sdkChat = require('../lib/sdk-chat');
const { ConsultQueue } = require('../lib/consult-queue');
const { sendSSE, makeChunk, turnRegistry, setTestStreamer, turnLinks, createTurnLink, pendingConsults, stoppedWorkers, isStoppedResult } = sdkChat.__turn;

const AGENTS = ['zz_stop_p', 'zz_stop_c', 'zz_stop_g', 'zz_stop_u', 'zz_stop_q'];
const [P, C, G, U, Q] = AGENTS;
const convDir = path.join(__dirname, '..', 'data', 'conversations');
fs.mkdirSync(convDir, { recursive: true });
after(() => { setTestStreamer(null); for (const a of AGENTS) try { fs.unlinkSync(path.join(convDir, `${a}.jsonl`)); } catch {} });
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const res = () => ({ writableEnded: false, destroyed: false, on() {}, writeHead() {}, write() { return true; }, end() { this.writableEnded = true; } });

// Every turn works until it is stopped; the test sees which ones were.
const live = new Map();
setTestStreamer(async ({ agent, res: r, signal }) => {
  live.set(agent, signal);
  sendSSE(r, makeChunk('working ', 'm'));
  await new Promise(done => { if (signal.aborted) done(); else signal.addEventListener('abort', done, { once: true }); });
});
const start = (body) => sdkChat.handleChatStream(body, res());
const linkTo = (parent, workerId) => createTurnLink({ workerId, parentAgent: parent, parentTurnId: turnRegistry.get(parent).turnId });

test('a stopped turn takes every turn it started with it, and theirs; other turns keep running', async () => {
  const runs = [start({ agent: P, message: 'parent' })];
  await tick(20);
  runs.push(start({ agent: C, message: 'child', turn_link: linkTo(P, 'consult-c-1') }));
  await tick(20);
  runs.push(start({ agent: G, message: 'grandchild', ephemeral: true, turn_link: linkTo(C, 'tw-g-1') }));
  runs.push(start({ agent: U, message: 'unrelated' }));
  await tick(20);
  assert.strictEqual(turnLinks.size, 2);
  const r = sdkChat.stopAgentTurn(P);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.children, 2, 'the consultation and the worker it started');
  for (const a of [P, C, G]) assert.strictEqual(live.get(a).aborted, true, `${a} stopped`);
  assert.strictEqual(live.get(U).aborted, false, 'an unrelated turn keeps running');
  assert.ok(stoppedWorkers.has('consult-c-1') && stoppedWorkers.has('tw-g-1'), 'their callers hear they were stopped');
  await Promise.all(runs.slice(0, 3));
  assert.strictEqual(turnLinks.size, 0, 'links go with their turns');
  sdkChat.stopAgentTurn(U);
  await runs[3];
});

test('Stop on a worker card stops that call only; a member may stop only calls of their own agents', async () => {
  const pRun = start({ agent: P, message: 'parent 2' });
  await tick(20);
  const cRun = start({ agent: C, message: 'child 2', turn_link: linkTo(P, 'consult-c-2') });
  await tick(20);
  assert.deepStrictEqual(sdkChat.cancelWorker('consult-c-2', { agent: 'someone_else' }), { success: false, status: 403, error: 'not a call of your agent' });
  assert.strictEqual(live.get(C).aborted, false);
  assert.deepStrictEqual(sdkChat.cancelWorker('consult-c-2', { agent: P }), { success: true, stopped: 'running', turns: 1 });
  assert.strictEqual(live.get(C).aborted, true);
  assert.strictEqual(live.get(P).aborted, false, 'the caller carries on');
  await cRun;
  assert.deepStrictEqual(sdkChat.cancelWorker('consult-c-2', { admin: true }), { success: false, status: 404, error: 'not running' });
  assert.deepStrictEqual(sdkChat.cancelWorker('', { admin: true }).status, 400);
  // stopping the consulted agent's own turn also tells its caller it was stopped
  const c3 = start({ agent: C, message: 'child 3', turn_link: linkTo(P, 'consult-c-3') });
  await tick(20);
  sdkChat.stopAgentTurn(C);
  await c3;
  assert.ok(stoppedWorkers.has('consult-c-3'));
  sdkChat.stopAgentTurn(P);
  await pRun;
});

test('a call still waiting for its agent never starts once stopped; a stand-in running it is stopped too', async () => {
  pendingConsults.set('consult-q-1', { agent: Q, parentAgent: P, delegates: [] });
  assert.deepStrictEqual(sdkChat.cancelWorker('consult-q-1', { agent: 'someone_else' }).status, 403);
  assert.deepStrictEqual(sdkChat.cancelWorker('consult-q-1', { agent: P }), { success: true, stopped: 'waiting', turns: 0 });
  assert.ok(stoppedWorkers.has('consult-q-1'));
  pendingConsults.delete('consult-q-1');
  // the waiting call returns at once, without starting its agent's turn
  stoppedWorkers.set('consult-q-2', Date.now());
  const out = await sdkChat.consultViaHub(Q, 'do it', 'consult-q-2', null, null, { temporal: true });
  assert.ok(isStoppedResult(out), out);
  assert.strictEqual(live.has(Q), false, 'no turn ran');
  // a busy capacity agent's call is run by a stand-in: Stop on the call reaches the stand-in
  const pRun = start({ agent: P, message: 'parent 3' });
  await tick(20);
  const dRun = start({ agent: G, message: 'stand-in', ephemeral: true, turn_link: linkTo(P, 'tw-d-1') });
  await tick(20);
  pendingConsults.set('consult-q-3', { agent: Q, parentAgent: P, delegates: ['tw-d-1'] });
  assert.deepStrictEqual(sdkChat.cancelWorker('consult-q-3', { agent: P }), { success: true, stopped: 'waiting', turns: 1 });
  assert.strictEqual(live.get(G).aborted, true);
  pendingConsults.delete('consult-q-3');
  await dRun;
  sdkChat.stopAgentTurn(P);
  await pRun;
});

test('a call whose caller was stopped while it was on its way stops at once', async () => {
  const pRun = start({ agent: P, message: 'parent 4' });
  await tick(20);
  const link = linkTo(P, 'consult-c-4');
  sdkChat.stopAgentTurn(P);
  await pRun;
  await start({ agent: C, message: 'child 4', turn_link: link });
  assert.strictEqual(live.get(C).aborted, true);
  // a link is used once, and only the hub makes them: an unknown one links nothing
  const uRun = start({ agent: U, message: 'unlinked', turn_link: link });
  await tick(20);
  assert.strictEqual(live.get(U).aborted, false);
  assert.strictEqual(turnLinks.size, 0);
  sdkChat.stopAgentTurn(U);
  await uRun;
});

test('stopping a turn drops the requests that turn queued for busy agents, but not one already running', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cq-stop-')), 'q.json');
  let now = 1000;
  const q = new ConsultQueue({ file, now: () => now });
  q.enqueue({ from: 'a', to: 'x', prompt: 'an earlier turn', turnId: 'T1' });
  q.enqueue({ from: 'a', to: 'w', prompt: 'old job, no turn, before' });
  now = 2000;
  q.enqueue({ from: 'a', to: 'y', prompt: 'queued in the turn', turnId: 'T2' });
  q.enqueue({ from: 'a', to: 'v', prompt: 'old job, no turn, during' });
  q.enqueue({ from: 'a', to: 'z', prompt: 'running now', turnId: 'T2' });
  q.enqueue({ from: 'b', to: 'y', prompt: 'another caller', turnId: 'T2' });
  q.running.add('z');
  assert.strictEqual(q.state.jobs[2].turnId, 'T2', 'a job names the turn that queued it');
  assert.strictEqual(q.cancelFrom('a', { turnId: 'T2', sinceTs: 1500 }), 2);
  assert.deepStrictEqual(q.state.jobs.map(j => j.prompt), ['an earlier turn', 'old job, no turn, before', 'running now', 'another caller']);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).jobs.length, 4, 'saved');
  assert.strictEqual(q.cancelFrom('nobody', { turnId: 'T2' }), 0);
  const heard = [];
  q.enqueue({ from: 'a', to: 'u', prompt: 'queued in T3', turnId: 'T3' });
  q.running.add('y'); q.enqueue({ from: 'c', to: 'y', prompt: 'c in T3', turnId: 'T3' });
  assert.strictEqual(q.cancelFrom('a', { turnId: 'T2', sinceTs: 1500, onCancel: (j) => heard.push(j.prompt) }), 0, 'nothing pending left in T2');
  assert.deepStrictEqual(heard, ['running now'], 'the one in flight is still reported, so its run is marked stopped');
  assert.strictEqual(q.cancelFrom('a', {}), 1, 'no turn named: only a job that names no turn can match (from time 0)');
  assert.deepStrictEqual(q.state.jobs.map(j => j.prompt), ['an earlier turn', 'running now', 'another caller', 'queued in T3', 'c in T3'], 'jobs that name a turn are kept');
});

test('a call whose caller\'s turn has already ended and left the registry still counts as stopped', async () => {
  const gone = { turnId: 'zz-gone', abortController: new AbortController() };
  gone.abortController.abort();
  const out = await sdkChat.consultViaHub(Q, 'late call', 'consult-q-9', null, P, { callerTurn: gone, temporal: true });
  assert.ok(isStoppedResult(out), out);
  assert.strictEqual(live.has(Q), false, 'no turn ran');
});

test('a queued request runs although the turn that queued it ended, and is stopped with that turn', async () => {
  const pRun = start({ agent: P, message: 'parent 5' });
  await tick(20);
  const ended = createTurnLink({ workerId: 'queued-cq-1', parentAgent: P, parentTurnId: 'zz-long-ended', queued: true });
  const qRun = start({ agent: Q, message: 'queued earlier', turn_link: ended });
  await tick(20);
  assert.strictEqual(live.get(Q).aborted, false, 'not stopped for its caller having moved on');
  sdkChat.stopAgentTurn(P);
  await pRun;
  assert.strictEqual(live.get(Q).aborted, false, 'another turn of the caller does not stop it');
  sdkChat.stopAgentTurn(Q);
  await qRun;
  const p2 = start({ agent: P, message: 'parent 6' });
  await tick(20);
  const q2 = start({ agent: Q, message: 'queued now', turn_link: createTurnLink({ workerId: 'queued-cq-2', parentAgent: P, parentTurnId: turnRegistry.get(P).turnId, queued: true }) });
  await tick(20);
  sdkChat.stopAgentTurn(P);
  await Promise.all([p2, q2]);
  assert.strictEqual(live.get(Q).aborted, true, 'stopped with the turn that queued it');
  assert.ok(stoppedWorkers.has('queued-cq-2'), 'its reply says it was stopped');
});

test('a call still on its way when its turn is stopped (link not picked up yet) starts stopped, queued or not', async () => {
  const pRun = start({ agent: P, message: 'parent 7' });
  await tick(20);
  const pt = turnRegistry.get(P).turnId;
  const queued = createTurnLink({ workerId: 'queued-cq-7', parentAgent: P, parentTurnId: pt, queued: true });
  const direct = createTurnLink({ workerId: 'consult-c-7', parentAgent: P, parentTurnId: pt });
  sdkChat.stopAgentTurn(P);
  await pRun;
  assert.ok(stoppedWorkers.has('queued-cq-7') && stoppedWorkers.has('consult-c-7'), 'their callers hear they were stopped');
  await start({ agent: Q, message: 'queued, on its way', turn_link: queued });
  assert.strictEqual(live.get(Q).aborted, true, 'the queued run starts stopped');
  await start({ agent: C, message: 'direct, on its way', turn_link: direct });
  assert.strictEqual(live.get(C).aborted, true);
});

test('the hub\'s turn view remembers a stop, so a reloaded page shows Stopped, not Failed', () => {
  const { createHubEvents } = require('../lib/hub-events');
  const hub = createHubEvents();
  const items = [];
  hub.onPublish(ev => { if (ev.type === 'turn_activity' && ev.item && ev.item.kind === 'worker') items.push(ev.item); });
  const r = { write: () => true };
  const tap = hub.tapTurn(r, { agent: 'zz_stop_view', origin: { kind: 'user' }, message: 'go', turnId: 'v1' });
  const gw = (g) => r.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], gateway: g })}\n\n`);
  gw({ type: 'worker_started', worker_id: 'consult-x-1', agent_type: 'helper', description: 'Worker: Agent Helper', prompt: 'p' });
  gw({ type: 'worker_failed', worker_id: 'consult-x-1', cancelled: true, error: 'Stopped' });
  gw({ type: 'worker_started', worker_id: 'consult-x-2', agent_type: 'helper', description: 'Worker: Agent Helper', prompt: 'p' });
  gw({ type: 'worker_failed', worker_id: 'consult-x-2', error: 'at capacity' });
  const ws = hub.turnFor('zz_stop_view').workers;
  assert.deepStrictEqual(ws.map(w => [w.status, !!w.cancelled]), [['failed', true], ['failed', false]]);
  assert.deepStrictEqual(items.filter(i => i.status === 'failed').map(i => !!i.cancelled), [true, false]);
  tap.finish(true);
});

test('the hub wires it: unique consultation ids, stopped calls end as cancelled, the route names worker and agent', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.strictEqual((src.match(/const workerId = newConsultId\(agent\);/g) || []).length, 2, 'both consult_agent paths');
  assert.doesNotMatch(src, /const workerId = `consult-\$\{agent\}-\$\{Date\.now\(\)\}`/);
  assert.strictEqual((src.match(/isStoppedResult\(result\)\s*\? \{ type: 'worker_failed', worker_id: workerId, cancelled: true, error: 'Stopped' \}/g) || []).length, 2);
  assert.strictEqual((src.match(/r\.ok && !isStoppedResult\(r\.text\)/g) || []).length, 2, 'temporary workers and stand-ins');
  assert.match(src, /bodyObj\.turn_link = linkId;/);
  assert.strictEqual((src.match(/onCancel: \(job\) => noteStoppedWorker\(`queued-\$\{job\.id\}`\)/g) || []).length, 2, 'both stops mark queued runs, in flight included');
  assert.match(src, /if \(callStopped\(\)\) \{ pendingTurnLinks\.delete\(linkId\); return resolve\(stoppedText\(agentName, ''\)\); \}/, 'every attempt checks before it sends');
  assert.match(src, /standInFor\(agentName, prompt, sseCtx, coordinatorName, \{ \.\.\.opts, callerTurn, outerWorkerId: workerId \}\)/, 'a stand-in started after a busy answer is linked to its call');
  assert.match(src, /: \{ \.\.\.imageOpts, callerTurn \}/, 'gateway consult passes the turn it was built for');
  assert.match(src, /consultViaHub\(agent, prompt, workerId, sseRes, agentName, \{ \.\.\.\(imgPrep\.paths\.length \? \{ imageFiles: imgPrep\.paths \} : \{\}\), callerTurn \}\)/, 'SDK consult too');
  assert.strictEqual((src.match(/runSpawnWorkers\(agentName, workers, sseRes, (signal|null), callerTurn\)/g) || []).length, 2, 'both spawn_workers paths');
  assert.match(src, /const children = stopChildTurns\(agent, t\.turnId\);/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /cancelWorker\(body\.worker_id \|\| body\.workerId, \{ agent: String\(body\.agent \|\| ''\), admin: !!req\.hubService \|\| access\.isAdmin\(req\.hubUser\) \}\)/);
});
