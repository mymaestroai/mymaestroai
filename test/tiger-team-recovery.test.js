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
    // The team folder is not created on disk here; member failures are explained as in production.
    ttLive: { ...require('../lib/tiger-team-live'), ensureTeamFolder: id => '/hub/share/common/tiger-teams/' + id },
    errorHelp: require('../lib/error-help'),
    pacing: { failureText: (e, target) => `[FAILED] "${target}": ${e.message}` },
  };
  ctx.require = m => m === './settings' ? { getProviderKey: p => (p === 'anthropic' ? ctx.anthropicKey || '' : '') } : require(m);
  vm.createContext(ctx);
  vm.runInContext(source.match(/^function ttBindStream\(.*$/m)[0], ctx);
  { const s = source.indexOf('function ttClaudeApiNote('); vm.runInContext(source.slice(s, source.indexOf('\n}\n', s) + 2), ctx); }
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

test('a challenger that cannot review leaves the report standing; a resume reruns only the review', async () => {
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
  // A challenger that cannot review leaves the report standing, says so, and marks its own card failed.
  assert.equal(ctx.activeTigerTeams.get(id).status, 'completed');
  assert.match(ctx.activeTigerTeams.get(id).finalResult, /NOT REVIEWED[\s\S]*critic/);
  const failedEv = ctx.res.events.find(e => e.gateway?.type === 'tt_dispatch_failed');
  assert.equal(failedEv.gateway.call_key, id + '-challenger');
  assert.equal(ctx.activeTigerTeams.get(id).calls[id + '-challenger'].status, 'failed');
  // A resume runs only the review that failed (and the coordinator's answer to it), never the finished report.
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

test('a roundtable participant that cannot speak is skipped with a note; the others carry on', async () => {
  const calls = [], prompts = [];
  const ctx = harness(async (agent, prompt) => {
    calls.push(agent); prompts.push(prompt);
    if (agent === 'part') throw new Error('fetch failed');
    return 'complete';
  });
  await ctx.runRoundtable({ objective: 'test', coordinator: 'coord', participants: ['part'], max_rounds: 2 }, ctx.res);
  const id = [...ctx.activeTigerTeams.keys()][0];
  const st = ctx.activeTigerTeams.get(id);
  assert.equal(st.status, 'completed');
  assert.deepEqual(calls, ['coord', 'part', 'coord', 'part']);
  assert.equal(st.discussion.filter(d => d.failed).length, 2);
  assert.match(prompts[2], /part:\*\* \(Could not contribute this round\./, 'the next speaker hears why');
  assert.equal(ctx.res.events.filter(e => e.gateway?.type === 'tt_dispatch_failed').length, 2);
  assert.equal(ctx.res.events.filter(e => e.gateway?.type === 'tt_dispatch' && e.gateway.call_key).length, 4, 'every turn names its card');
});

test('a stopped roundtable resumes without rerunning finished contributions', async () => {
  const calls = []; let stopped = false; let ctx;
  ctx = harness(async agent => {
    calls.push(agent);
    if (agent === 'part' && !stopped) { stopped = true; ctx.stopTigerTeam([...ctx.activeTigerTeams.keys()][0]); throw recovery.abortError(); }
    return 'complete';
  });
  await ctx.runRoundtable({ objective: 'test', coordinator: 'coord', participants: ['part'], max_rounds: 1 }, ctx.res);
  const id = [...ctx.activeTigerTeams.keys()][0];
  assert.equal(ctx.activeTigerTeams.get(id).status, 'stopped');
  await ctx.resumeTigerTeam(id, ctx.res, {});
  assert.deepEqual(calls, ['coord', 'part', 'part']);
  assert.equal(ctx.activeTigerTeams.get(id).status, 'completed');
});

test('every frame of a member names its dispatch; a nested frame keeps its own tag', async () => {
  const ctx = harness(async (agent, prompt, images, res) => {
    res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    res.write('data: {"tt_call":"inner","tt_agent":"x","tt_role":"participant","choices":[{"delta":{"content":"nested"}}]}\n\n');
    res.write(': heartbeat\n\n');
    res.write('data: {"gateway":{"type":"turn_outcome","status":"completed"}}\n\n');
    return 'done';
  });
  const writes = []; ctx.res.write = s => writes.push(s);
  ctx.reconstituteTigerTeam('old', { objective: 'test', coordinator: 'coord', participants: ['part'], findings: [] });
  assert.equal(await ctx.consultTigerTeam('part', 'task', 'dispatch-a', ctx.res, 'coord', { tigerTeamId: 'old', ttRole: 'participant' }), 'done');
  const data = writes.filter(w => w.startsWith('data: ')).map(w => JSON.parse(w.slice(6)));
  assert.deepEqual([data[0].tt_call, data[0].tt_agent, data[0].tt_role], ['dispatch-a', 'part', 'participant']);
  assert.equal(data[1].tt_call, 'inner', 'the innermost call keeps its tag');
  assert.equal(writes.includes(': heartbeat\n\n'), true, 'comments pass through unchanged');
  assert.equal(data.some(d => d.gateway?.type === 'turn_outcome'), false, 'a member turn outcome is not the team\'s');
});

test('a member that is mid-turn elsewhere is waited for, then does the work', async () => {
  const ctx = harness(async () => 'worked');
  const real = require('../lib/tiger-team-live');
  ctx.ttLive = { ...ctx.ttLive, waitUntilFree: (isActive, o) => real.waitUntilFree(isActive, { ...o, stepMs: 5 }) };
  const writes = []; ctx.res.write = s => writes.push(s);
  ctx.reconstituteTigerTeam('old', { objective: 'test', coordinator: 'coord', participants: ['part'], findings: [] });
  ctx.pendingChatRequests.add('part');   // a chat with "part" is running
  setTimeout(() => ctx.pendingChatRequests.delete('part'), 40);
  assert.equal(await ctx.consultTigerTeam('part', 'task', 'dispatch-b', ctx.res, 'coord', { tigerTeamId: 'old' }), 'worked');
  const notice = writes.map(w => w.startsWith('data: ') ? JSON.parse(w.slice(6)) : null).find(d => d?.gateway?.type === 'tt_member_notice');
  assert.match(notice.gateway.message, /part is busy with another conversation/);
  assert.equal(notice.tt_call, 'dispatch-b');
  assert.equal(ctx.pendingChatRequests.has('part'), false);
});

test('a member that stays busy fails with TT_BUSY, its call marked failed and the other turn untouched', async () => {
  const ctx = harness(async () => 'never');
  const real = require('../lib/tiger-team-live');
  ctx.ttLive = { ...ctx.ttLive, waitUntilFree: (isActive, o) => real.waitUntilFree(isActive, { ...o, stepMs: 5, maxMs: 30 }) };
  ctx.reconstituteTigerTeam('old', { objective: 'test', coordinator: 'coord', participants: ['part'], findings: [] });
  ctx.pendingChatRequests.add('part');
  await assert.rejects(ctx.consultTigerTeam('part', 'task', 'dispatch-c', ctx.res, 'coord', { tigerTeamId: 'old' }), { code: 'TT_BUSY' });
  assert.equal(ctx.activeTigerTeams.get('old').calls['dispatch-c'].status, 'failed');
  assert.equal(ctx.pendingChatRequests.has('part'), true, 'the other turn still owns the agent');
  assert.match(ctx.ttMemberFailureText(Object.assign(new Error('x'), { code: 'TT_BUSY' }), 'part', 'Part'), /^\[TEAM MEMBER BUSY\] Part \(part\)/);
  assert.match(ctx.ttMemberFailureText(new Error('fetch failed'), 'part', 'Part', 'google/gemini-x'), /^\[TEAM MEMBER FAILED\] Part \(part\) could not finish this task\. .*What to do:/);
  assert.match(ctx.ttMemberFailureText(new Error('Tool result unavailable'), 'part', 'part'), /could not finish this task\. Tool result unavailable\nThe rest of the team is not affected/);
});

test('the coordinator is told about the team folder and that dispatches run at the same time', async () => {
  const prompts = [];
  const ctx = harness(async (agent, prompt) => { prompts.push(prompt); return 'Report.  '.repeat(20); });
  await ctx.runTigerTeam({ coordinator: 'coord', participants: ['part'], objective: 'Test' }, ctx.res, 'test');
  const [id, state] = [...ctx.activeTigerTeams][0];
  assert.equal(state.teamFolder, '/hub/share/common/tiger-teams/' + id);
  assert.match(prompts[0], new RegExp('\\*\\*TEAM FOLDER:\\*\\* /hub/share/common/tiger-teams/' + id));
  assert.match(prompts[0], /cannot see your own Files folder or workspace/);
  assert.match(prompts[0], /Several consult_agent calls in one message run at the same time/);
  assert.doesNotMatch(prompts[0], /execute one at a time/);
});

test('same prompt in two different dispatches is not incorrectly cached', async () => {
  let calls = 0; const ctx = harness(async () => 'result-' + ++calls);
  ctx.reconstituteTigerTeam('old', { objective: 'test', coordinator: 'coord', participants: [], findings: [] });
  const opts = { tigerTeamId: 'old' };
  assert.equal(await ctx.consultTigerTeam('part', 'same prompt', 'dispatch1', ctx.res, 'coord', opts), 'result-1');
  assert.equal(await ctx.consultTigerTeam('part', 'same prompt', 'dispatch1', ctx.res, 'coord', opts), 'result-1');
  assert.equal(await ctx.consultTigerTeam('part', 'same prompt', 'dispatch2', ctx.res, 'coord', opts), 'result-2');
});

test('a team with Claude-subscription members says they run on the API key, or that they will fail without one', async () => {
  const ctx = harness(async () => 'Report.  '.repeat(20));
  ctx.getAgents = async () => [
    { name: 'coord', display: 'Sonnet', model: 'claude-sdk/claude-sonnet-5-5' },
    { name: 'part', display: 'Gemini', model: 'google/gemini-4-argon' },
    { name: 'critic', display: 'Haiku', model: 'claude-sdk/claude-haiku-4-5' },
  ];
  const notes = () => ctx.res.events.filter(e => e.gateway?.type === 'tt_notice').map(e => e.gateway.message);
  ctx.anthropicKey = 'test-anthropic-key-not-real';
  await ctx.runTigerTeam({ coordinator: 'coord', participants: ['part'], challenger: 'critic', objective: 'Test' }, ctx.res, 'test');
  assert.deepEqual(notes(), ['Claude agents in this team (Sonnet, Haiku) are answered through your Anthropic API key, not your Claude subscription. Their use counts as API spend (Settings → Spend).']);
  ctx.res.events.length = 0; ctx.anthropicKey = '';
  await ctx.runRoundtable({ objective: 'test', coordinator: 'coord', participants: ['part'], max_rounds: 1 }, ctx.res);
  assert.match(notes()[0], /^Sonnet is set to your Claude subscription, but a Tiger Team answers Claude agents through the Anthropic API and this hub has no Anthropic API key, so it will fail\./);
  ctx.res.events.length = 0;
  ctx.getAgents = async () => [{ name: 'coord', display: 'Gemini', model: 'google/gemini-4-argon' }, { name: 'part', display: 'Qwen', model: 'local/qwen' }];
  await ctx.runTigerTeam({ coordinator: 'coord', participants: ['part'], objective: 'Test' }, ctx.res, 'test');
  assert.deepEqual(notes(), [], 'nothing to say when no member is on the subscription');
});
