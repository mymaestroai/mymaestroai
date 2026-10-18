'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const recovery = require('../lib/tiger-team-recovery');
const source = fs.readFileSync(path.join(__dirname, '../lib/sdk-chat.js'), 'utf8');

test('retry budget is bounded across model turns and reports backoff', async () => {
  const budget = { used: 0, max: 3, maxWaitMs: 90000, waitedMs: 0 };
  let calls = 0; const delays = [];
  await assert.rejects(recovery.retry(async () => { calls++; throw new Error('fetch failed'); }, {
    budget, wait: async n => delays.push(n), random: () => 0.5,
  }), /fetch failed/);
  assert.equal(calls, 4); assert.deepEqual(delays, [2000, 4000, 8000]);
  await assert.rejects(recovery.retry(async () => { calls++; throw new Error('fetch failed'); }, { budget }), /fetch failed/);
  assert.equal(calls, 5);
});

test('auth, permission, configuration and source failures do not retry', async () => {
  for (const message of ['Gateway 401', 'Gateway 403', 'Gateway 400', 'context length exceeded', 'bad config']) {
    let n = 0;
    await assert.rejects(recovery.retry(async () => { n++; throw new Error(message); }));
    assert.equal(n, 1);
  }
  assert.equal(recovery.classify({ code: 'TT_SOURCE_BLOCKED', message: 'network error' }), 'blocked');
});

test('transient network codes and throttling retry; Retry-After over budget pauses', async () => {
  for (const message of ['Gateway 429', 'Gateway 503', 'ECONNRESET', 'terminated', 'Model stream truncated']) {
    assert.equal(recovery.classify(new Error(message)), 'transient');
  }
  let n = 0;
  await assert.rejects(recovery.retry(async () => { n++; throw Object.assign(new Error('Gateway 429'), { retryAfterMs: 120000 }); }));
  assert.equal(n, 1);
});

test('stop cancels retry sleep without another request', async () => {
  const controller = new AbortController(); let n = 0;
  await assert.rejects(recovery.retry(async () => { n++; throw new Error('network error'); }, {
    signal: controller.signal, onRetry: () => controller.abort(),
  }), { name: 'AbortError' });
  assert.equal(n, 1);
});

test('atomic private checkpoints roundtrip journals and exclude runtime objects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-recovery-'));
  try {
    const store = new recovery.CheckpointStore(dir);
    const state = { status: 'running', objective: 'test', calls: { a: { tools: { x: { result: 'retained' } } } }, session: { circular: null }, abortController: new AbortController(), executing: true };
    state.session.circular = state.session;
    store.save('tt-1', state);
    const data = store.read('tt-1');
    assert.equal(data.calls.a.tools.x.result, 'retained'); assert.equal(data.session, undefined);
    assert.equal(data.executing, undefined);
    assert.equal(fs.statSync(path.join(dir, 'tt-1.json')).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ['tt-1.json']);
    assert.equal(recovery.restore(data).status, 'interrupted');
    assert.equal(recovery.restore(data).abortController.signal.aborted, false);
    assert.throws(() => store.save('../escape', state), /Invalid/);
    assert.equal(store.read('../escape'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function harness(run = async () => 'A confirmed result.  '.repeat(20)) {
  const ctx = {
    require, console: { log() {}, warn() {}, error() {} }, AbortController, Date, Map, Set,
    setInterval: () => 1, clearInterval() {},
    ttRecovery: recovery, activeTigerTeams: new Map(), coordinatorToTigerTeam: new Map(), pendingChatRequests: new Set(),
    ttStore: { read: () => null, list: () => [] },
    checkpointTeam() {},
    getAgents: async () => ['coord', 'part', 'critic'].map(name => ({ name, display: name })),
    resolveAgentRef: async name => ['coord', 'part', 'critic'].includes(name) ? ({ name }) : null,
    suggestAgents: async () => [],
    sendSSE: (res, chunk) => res.events.push(chunk),
    makeChunk: (content, model, gateway) => ({ content, model, gateway }),
    streamViaGateway: run,
    isAgentActive: name => ctx.pendingChatRequests.has(name),
  };
  vm.createContext(ctx);
  let start = source.indexOf('async function consultTigerTeam('), end = source.indexOf('\nfunction consultViaHub', start);
  vm.runInContext(source.slice(start, end), ctx);
  start = source.indexOf('async function runTigerTeam('); end = source.indexOf('// Prune completed Tiger Teams', start);
  vm.runInContext(source.slice(start, end), ctx);
  start = source.indexOf('async function runRoundtable('); end = source.indexOf('// ── Flush Active Responses', start);
  vm.runInContext(source.slice(start, end), ctx);
  ctx.consultViaHub = ctx.consultTigerTeam;
  ctx.res = { events: [], write() {} };
  return ctx;
}

test('failed model turn pauses rather than falsely completing; same call resumes', async () => {
  let attempts = 0;
  const ctx = harness(async () => { if (++attempts === 1) throw new Error('fetch failed'); return 'Success'; });
  await ctx.runTigerTeam({ coordinator: 'coord', participants: [], objective: 'Test' }, ctx.res, 'test');
  const [id, state] = [...ctx.activeTigerTeams][0];
  assert.equal(state.status, 'interrupted');
  assert.equal(ctx.res.events.some(e => e.gateway?.type === 'tt_complete'), false);
  await ctx.resumeTigerTeam(id, ctx.res, {});
  assert.equal(ctx.activeTigerTeams.get(id).status, 'completed');
  assert.equal(attempts, 2);
});

test('challenger failure resumes without rerunning completed coordinator', async () => {
  const calls = []; let failed = false;
  const ctx = harness(async (agent) => {
    calls.push(agent);
    if (agent === 'critic' && !failed) { failed = true; throw new Error('ECONNRESET'); }
    // This repo only sends the critique back to the coordinator when the challenger
    // rates the report INSUFFICIENT (the fork does it unconditionally), so the mock
    // challenger returns that verdict to exercise the final address round on resume.
    if (agent === 'critic') return 'Overall: INSUFFICIENT. 1. Cite evidence for finding A.  '.repeat(8);
    return 'Verified findings with evidence.  '.repeat(20);
  });
  await ctx.runTigerTeam({ coordinator: 'coord', participants: [], challenger: 'critic', objective: 'Test' }, ctx.res, 'test');
  const id = [...ctx.activeTigerTeams.keys()][0];
  assert.deepEqual(calls, ['coord', 'critic']);
  await ctx.resumeTigerTeam(id, ctx.res, {});
  assert.deepEqual(calls, ['coord', 'critic', 'critic', 'coord']);
  assert.equal(ctx.activeTigerTeams.get(id).status, 'completed');
});

test('stop is targeted and does not release running reservation prematurely', async () => {
  let started;
  const ready = new Promise(r => started = r);
  const ctx = harness(async (agent, prompt, images, res, opts) => {
    started();
    return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(recovery.abortError()), { once: true }));
  });
  const running = ctx.runTigerTeam({ coordinator: 'coord', participants: [], objective: 'Test' }, ctx.res, 'test');
  await ready;
  const id = [...ctx.activeTigerTeams.keys()][0];
  const other = { abortController: new AbortController(), completedAt: null, executing: true };
  ctx.activeTigerTeams.set('other', other);
  ctx.stopTigerTeam(id);
  assert.equal(ctx.activeTigerTeams.get(id).completedAt, null);
  assert.equal(other.abortController.signal.aborted, false);
  await running;
  assert.equal(ctx.activeTigerTeams.get(id).status, 'stopped');
  assert.equal(ctx.res.events.some(e => e.gateway?.type === 'tt_complete'), false);
});

test('two Resume clicks cannot launch two coordinators', async () => {
  let calls = 0; let release;
  const ctx = harness(async () => { calls++; await new Promise(r => release = r); return 'done'; });
  ctx.reconstituteTigerTeam('old', { objective: 'test', coordinator: 'coord', participants: [], findings: [] });
  const first = ctx.resumeTigerTeam('old', ctx.res, {});
  await assert.rejects(ctx.resumeTigerTeam('old', ctx.res, {}), /already resuming|still running/);
  while (!release) await new Promise(r => setImmediate(r));
  release(); await first;
  assert.equal(calls, 1);
});

test('continuation stop uses a fresh signal and remains resumable', async () => {
  let shouldStop = true; let seenSignal;
  const ctx = harness(async (agent, prompt, images, res, opts) => {
    seenSignal = opts.signal;
    if (shouldStop) { ctx.stopTigerTeam('old'); throw recovery.abortError(); }
    return 'finished';
  });
  ctx.reconstituteTigerTeam('old', { objective: 'test', coordinator: 'coord', participants: [], findings: [] });
  await ctx.continueTigerTeam('old', 'Continue work', ctx.res);
  assert.equal(seenSignal.aborted, true);
  assert.equal(ctx.activeTigerTeams.get('old').status, 'stopped');
  shouldStop = false;
  await ctx.resumeTigerTeam('old', ctx.res, {});
  assert.equal(seenSignal.aborted, false);
  assert.equal(ctx.activeTigerTeams.get('old').status, 'completed');
});

test('roundtable resumes completed contributions without rerunning them', async () => {
  const calls = []; let failed = false;
  const ctx = harness(async agent => {
    calls.push(agent);
    if (agent === 'part' && !failed) { failed = true; throw new Error('fetch failed'); }
    return 'complete';
  });
  await ctx.runRoundtable({ objective: 'test', coordinator: 'coord', participants: ['part'], max_rounds: 1 }, ctx.res);
  const id = [...ctx.activeTigerTeams.keys()][0];
  assert.equal(ctx.activeTigerTeams.get(id).status, 'interrupted');
  await ctx.resumeTigerTeam(id, ctx.res, {});
  assert.deepEqual(calls, ['coord', 'part', 'part']);
  assert.equal(ctx.activeTigerTeams.get(id).status, 'completed');
});

test('same prompt in two different dispatches is not incorrectly cached', async () => {
  let calls = 0; const ctx = harness(async () => 'result-' + ++calls);
  ctx.reconstituteTigerTeam('old', { objective: 'test', coordinator: 'coord', participants: [], findings: [] });
  const opts = { tigerTeamId: 'old' };
  assert.equal(await ctx.consultTigerTeam('part', 'same prompt', 'dispatch1', ctx.res, 'coord', opts), 'result-1');
  assert.equal(await ctx.consultTigerTeam('part', 'same prompt', 'dispatch1', ctx.res, 'coord', opts), 'result-1');
  assert.equal(await ctx.consultTigerTeam('part', 'same prompt', 'dispatch2', ctx.res, 'coord', opts), 'result-2');
});
