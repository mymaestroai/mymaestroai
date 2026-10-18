'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const realRecovery = require('../lib/tiger-team-recovery');
const source = fs.readFileSync(path.join(__dirname, '../lib/sdk-chat.js'), 'utf8');

function harness(respond, toolHandlers = {}) {
  const events = [], requests = [], saves = [];
  const state = { id: 'tt', status: 'running', calls: {} };
  const recovery = { ...realRecovery, retry: (op, opts) => realRecovery.retry(op, { ...opts, wait: async () => {}, random: () => 0.5 }) };
  const ctx = {
    console: { log() {}, error() {}, warn() {} }, Buffer, Date, AbortController, Map, Set, global: { __lazyToolsEnabled: false },
    process: { cwd: () => '/tmp/harness', env: {} },   // the gate call passes the hands' working directory (review F23)
    getAgentModel: async () => 'test-model', isAutoModel: async () => false,
    getAgents: async () => [{ name: 'coord', model: 'test-model', minimalContext: true }],
    loadAgentContext: async () => 'Test system', isMythosModel: () => false,
    ALWAYS_INCLUDE: [], TOOL_CATEGORIES: {},
    buildAllTools: async () => ({ openaiTools: [], handlers: new Map(Object.entries(toolHandlers)) }),
    activeResponses: new Map(), activeTigerTeams: new Map([['tt', state]]),
    setInterval: () => 1, clearInterval() {}, setTimeout: cb => { cb(); return 1; },
    INCREMENTAL_SAVE_INTERVAL_MS: 3000, HEARTBEAT_INTERVAL_MS: 15000,
    makeProgressTicker: () => 1, sendSSEHeartbeat() {},
    contextBudget: require('../lib/context-budget'), records: { maxBytesFor: () => 262144 }, compaction: { compactedAt: () => null, noteUsage: () => null, settingsFor: () => ({ mode: 'off' }) },   // elastic context + compression are no-ops here
    trimConversation: x => x, annotateForContext: x => x, capOutputTokens: () => 500,
    gate: { check: async () => ({ allowed: true }) }, ledger: { record() {} },   // tool policy + ledger are no-ops in this sandbox
    sendSSE: (res, event) => events.push(event), makeChunk: (content, model, gateway) => ({ content, model, gateway }),
    MAX_TOOL_TURNS: 12, MAX_TRUNCATION_RESUMES: 3, MAX_LENGTH_CONTINUATIONS: 3, REASON_FLUSH_MS: 250,
    drainInterjections: () => [], interjectionQueues: new Map(),
    providerPacing: require('../lib/provider-pacing'),   // the gateway catch emits a typed turn_error for the pacing layer
    errorHelp: require('../lib/error-help'),   // ...and the error in plain words for the reply text
    modelHealth: { record() {} },   // model health marks are a no-op in this sandbox
    chatCompletionStream: async (messages, opts) => {
      requests.push(structuredClone(messages));
      assert.equal(opts.noRetries, true);
      return respond(requests.length, messages);
    },
    parseSSEStream: async function* (response, state) {
      for (const event of response.events || []) yield event;
      if (response.error) throw response.error;
      state.sawDone = response.done !== false;
    },
    modelTelemetry: { recordRequest() {}, recordToolCall() {} },
    executeToolCallsBatched: require('../lib/tool-concurrency').executeToolCallsBatched, isReadOnlyTool: () => false,
    queryCache: { get: () => null, put() {} }, recordToolError() {}, getInlineErrorGuidance: () => '', getToolGuidance: () => '',
    temporalWorkers: { isVirtual: () => false }, jobs: { policyText: () => '' }, scheduledTasks: { policyText: () => '' },
    checkpointTeam: () => saves.push(structuredClone(state)), ttRecovery: recovery,
    ttArtifacts: require('../lib/tiger-team-artifacts'),
    accumulateToolCallDelta: require('../lib/tool-call-deltas').accumulateToolCallDelta,
    ttStore: { append(id, st, ev) { (st.events ||= []).push(ev); }, artifact() { return { hash: 'test-artifact' }; } },
    sendSSEDone() {}, safeEnd: res => res.end(),
    pendingToolConfirms: new Map(),
    // a saved reply's paragraph break after a tool call and its activity (lib/sdk-chat), as the module defines them
    paragraphAfterTool: (t) => (t && !/\n\s*$/.test(t) ? '\n\n' : ''), activityMeta: (agent, text, extra) => extra,
  };
  vm.createContext(ctx);
  const start = source.indexOf('async function streamViaGateway('), end = source.indexOf('// ── Auto Memory', start);
  vm.runInContext(source.slice(start, end), ctx);
  const call = state.calls['coord-call'] = { key: 'coord-call', tools: {} };
  const controller = new AbortController();
  const run = () => ctx.streamViaGateway('coord', 'Test prompt', [], { writeHead() {}, end() {}, writableEnded: false, destroyed: false }, {
    ephemeral: true, tigerTeam: true, tigerTeamId: 'tt', recoveryCall: call, signal: controller.signal,
  });
  return { run, call, requests, events, saves, ctx, controller };
}
const tool = (id, name) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: '{}' } }] }, finish_reason: 'tool_calls' }] });
const text = content => ({ choices: [{ delta: { content }, finish_reason: 'stop' }] });

test('model failure after a completed tool retries generation, not the tool', async () => {
  let writes = 0;
  const h = harness(n => {
    if (n === 1) return { events: [tool('write-1', 'Write')] };
    if (n === 2) throw new Error('fetch failed');
    return { events: [text('Done')] };
  }, { Write: async () => { writes++; return 'saved'; } });
  assert.equal(await h.run(), 'Done');
  assert.equal(writes, 1);
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2].some(m => m.role === 'tool' && m.content === 'saved'), true);
  assert.equal(h.call.tools['write-1'].result, 'saved');
  assert.equal(h.events.some(e => e.gateway?.type === 'tt_retry'), true);
});

test('mid-stream reset discards incomplete tool calls and preserves partial text', async () => {
  let writes = 0;
  const h = harness(n => n === 1 ? {
    events: [{ choices: [{ delta: { content: 'Partial' } }] }, tool('unsafe', 'Write')], error: new Error('terminated'),
  } : { events: [text(' finished')] }, { Write: async () => { writes++; return 'saved'; } });
  assert.equal(await h.run(), 'Partial finished');
  assert.equal(writes, 0);
  assert.equal(h.requests[1].some(m => m.content === 'Partial'), true);
});

test('resume restores completed tool results without invoking tool again', async () => {
  let writes = 0;
  const h = harness(() => ({ events: [text('Recovered')] }), { Write: async () => { writes++; return 'bad'; } });
  h.call.messages = [{ role: 'user', content: 'original' }, { role: 'assistant', content: null,
    tool_calls: [{ id: 'write-1', type: 'function', function: { name: 'Write', arguments: '{}' } }] }];
  h.call.tools['write-1'] = { name: 'Write', status: 'completed', result: 'already saved' };
  await h.run();
  assert.equal(writes, 0);
  assert.equal(h.requests[0].some(m => m.content === 'already saved'), true);
});

test('unknown mutating tool outcome is not replayed after restart', async () => {
  let writes = 0;
  const h = harness(() => ({ events: [text('Needs verification')] }), { Write: async () => { writes++; } });
  h.call.messages = [{ role: 'user', content: 'original' }, { role: 'assistant', content: null,
    tool_calls: [{ id: 'write-1', type: 'function', function: { name: 'Write', arguments: '{}' } }] }];
  h.call.tools['write-1'] = { name: 'Write', status: 'in_flight' };
  await assert.rejects(h.run(), { code: 'TT_RECONCILIATION_REQUIRED' });
  assert.equal(writes, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.call.tools['write-1'].status, 'in_flight');
});

test('required source outage halts without another model call', async () => {
  const h = harness(() => ({ events: [tool('source-1', 'warehouse__query')] }), {
    warehouse__query: async () => 'Error: connection failed',
  });
  await assert.rejects(h.run(), { code: 'TT_SOURCE_BLOCKED' });
  assert.equal(h.requests.length, 1);
});

test('exhausted network budget throws to orchestrator instead of returning successful text', async () => {
  const h = harness(() => { throw new Error('fetch failed'); });
  await assert.rejects(h.run(), /fetch failed/);
  assert.equal(h.requests.length, 4);
  assert.equal(h.ctx.activeResponses.size, 0);
});

test('text is committed before UI delivery, not on a periodic timer', async () => {
  const h = harness(() => ({ events: [text('Durable now')] }));
  const send = h.ctx.sendSSE;
  h.ctx.sendSSE = (res, event) => {
    if (event.content === 'Durable now') {
      const events = h.ctx.activeTigerTeams.get('tt').events;
      assert.equal(events.at(-1).chunk.choices[0].delta.content, 'Durable now');
    }
    send(res, event);
  };
  await h.run();
});

test('failed stream persistence displays no uncommitted text and blocks the turn', async () => {
  const h = harness(() => ({ events: [text('Must not display')] }));
  h.ctx.ttStore.append = (id, state, event) => {
    if (event.type === 'model_chunk') throw Object.assign(new Error('disk full'), { code: 'TT_PERSISTENCE_FAILED' });
  };
  await assert.rejects(h.run(), { code: 'TT_PERSISTENCE_FAILED' });
  assert.equal(h.events.some(e => e.content === 'Must not display'), false);
  assert.notEqual(h.call.status, 'completed');
});

test('full large tool result reaches Tiger Team UI and archive', async () => {
  const full = 'Z'.repeat(100000);
  const h = harness(n => ({ events: [n === 1 ? tool('read-long', 'Read') : text('Done')] }), { Read: async () => full });
  await h.run();
  assert.equal(h.call.tools['read-long'].result, full);
  assert.equal(h.events.find(e => e.gateway?.type === 'tool_result').gateway.output, full);
});

test('throwing tool leaves unknown outcome and never generates speculative follow-up', async () => {
  let count = 0;
  const h = harness(() => ({ events: [tool('write-unknown', 'Write')] }), { Write: async () => { count++; throw new Error('connection lost after sending'); } });
  await assert.rejects(h.run(), { code: 'TT_RECONCILIATION_REQUIRED' });
  assert.equal(count, 1); assert.equal(h.requests.length, 1);
  assert.equal(h.call.tools['write-unknown'].status, 'unknown');
});
