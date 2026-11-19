'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const realRecovery = require('../lib/tiger-team-recovery');
const source = fs.readFileSync(path.join(__dirname, '../lib/sdk-chat.js'), 'utf8');

function harness(respond, toolHandlers = {}, team = {}) {
  const events = [], requests = [], saves = [];
  const state = { id: 'tt', status: 'running', calls: {}, coordinator: 'coord', mode: 'led', maxRounds: 3, ...team };
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
    contextBudget: require('../lib/context-budget'), effectiveOutputTokens: require('../lib/output-cap').effectiveOutputTokens, records: { maxBytesFor: () => 262144 }, compaction: { compactedAt: () => null, noteUsage: () => null, settingsFor: () => ({ mode: 'off' }) },   // elastic context + compression are no-ops here
    trimConversation: x => x, annotateForContext: x => x, capOutputTokens: () => 500,
    gate: { check: async () => ({ allowed: true }) }, ledger: { record() {} },   // tool policy + ledger are no-ops in this sandbox
    sendSSE: (res, event) => events.push(event), makeChunk: (content, model, gateway) => ({ content, model, gateway }),
    MAX_TOOL_TURNS: 12, MAX_TRUNCATION_RESUMES: 3, MAX_LENGTH_CONTINUATIONS: 3, REASON_FLUSH_MS: 250,
    drainInterjections: () => [], interjectionQueues: new Map(),
    retryUnloggedInterjections() {}, activityForFlush: () => undefined,   // interjection history helpers (lib/sdk-chat): no-ops here
    sdkInterject: { takeUndelivered: () => [], formatCarried: () => '', carriedImages: () => [], stashUndelivered() {} },   // no carried interjections in this sandbox
    providerPacing: require('../lib/provider-pacing'),   // the gateway catch emits a typed turn_error for the pacing layer
    errorHelp: require('../lib/error-help'),   // ...and the error in plain words for the reply text
    modelHealth: { record() {} },   // model health marks are a no-op in this sandbox
    tierLib: require('../lib/tier'),   // speed/price tier: pure
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
    timeZoneLib: { zoneForAgent: () => 'UTC', policyText: () => '' },   // lib/timezone: the person's zone and the TIME section
    checkpointTeam: () => saves.push(structuredClone(state)), ttRecovery: recovery,
    ttArtifacts: require('../lib/tiger-team-artifacts'), ttLive: require('../lib/tiger-team-live'),
    accumulateToolCallDelta: require('../lib/tool-call-deltas').accumulateToolCallDelta,
    ttStore: { append(id, st, ev) { (st.events ||= []).push(ev); }, artifact() { return { hash: 'test-artifact' }; } },
    sendSSEDone() {}, safeEnd: res => res.end(),
    pendingToolConfirms: new Map(),
    // a saved reply's paragraph break after a tool call and its activity (lib/sdk-chat), as the module defines them
    paragraphAfterTool: (t) => (t && !/\n\s*$/.test(t) ? '\n\n' : ''), activityMeta: (agent, text, extra) => extra,
  };
  vm.createContext(ctx);
  const start = source.indexOf('async function streamViaGateway('), end = source.indexOf('// ── Auto Memory', start);
  // the face view's real helpers (voiceNoteFor, createVoiceMood), not stubs: with faceMood off they leave the reply unchanged
  const hStart = source.indexOf('/** The note(s) a voice turn adds to the prompt'), hEnd = source.indexOf('/**\n * raceStop(', hStart);
  assert.ok(hStart > 0 && hEnd > hStart, 'voice helpers found');
  Object.assign(ctx, { VOICE_NOTE: 'voice note', ...require('../lib/voice/mood') });
  vm.runInContext(source.slice(hStart, hEnd), ctx);
  vm.runInContext(source.slice(start, end), ctx);
  const call = state.calls['coord-call'] = { key: 'coord-call', tools: {} };
  const controller = new AbortController();
  const run = () => ctx.streamViaGateway('coord', 'Test prompt', [], { writeHead() {}, end() {}, writableEnded: false, destroyed: false }, {
    ephemeral: true, tigerTeam: true, tigerTeamId: 'tt', recoveryCall: call, signal: controller.signal,
  });
  return { run, call, requests, events, saves, ctx, controller };
}
const tools = (...specs) => ({ choices: [{ delta: { tool_calls: specs.map(([id, name, args], index) => ({ index, id, function: { name, arguments: JSON.stringify(args || {}) } })) }, finish_reason: 'tool_calls' }] });
const text = content => ({ choices: [{ delta: { content }, finish_reason: 'stop' }] });
const REFUSAL = n => `Round limit reached (${n} of ${n}). Finish with what you have: write your final answer now.`;

test('a round is one coordinator message with consult_agent calls: three dispatches in one message are round 1', async () => {
  const dispatched = [];
  const h = harness(n => n === 1 ? { events: [tools(['c1', 'consult_agent'], ['c2', 'consult_agent'], ['c3', 'consult_agent'])] }
    : n === 2 ? { events: [tools(['c4', 'consult_agent'])] } : n === 3 ? { events: [tools(['r1', 'Read'])] } : { events: [text('Final')] },
  { consult_agent: async (a) => { dispatched.push(h.ctx.activeTigerTeams.get('tt').curRound); return 'done'; }, Read: async () => 'file' });
  assert.equal(await h.run(), 'Final');
  assert.deepEqual(dispatched, [1, 1, 1, 2], 'the three dispatches of one message share round 1; the next message is round 2');
  assert.equal(h.ctx.activeTigerTeams.get('tt').round, 2, 'a message without consult_agent is not a round');
});

test('past maxRounds the consult_agent calls are refused with the exact sentence, nothing is dispatched, other tools still run', async () => {
  let consults = 0, reads = 0;
  const h = harness(n => n === 1 ? { events: [tools(['c1', 'consult_agent'], ['c2', 'consult_agent'], ['r1', 'Read'])] } : { events: [text('Final from what I have')] },
  { consult_agent: async () => { consults++; return 'done'; }, Read: async () => { reads++; return 'file'; } }, { maxRounds: 3, round: 3, curRound: 3 });
  assert.equal(await h.run(), 'Final from what I have');
  assert.equal(consults, 0, 'no dispatch');
  assert.equal(reads, 1, 'the Read ran as normal');
  const results = h.requests[1].filter(m => m.role === 'tool');
  assert.equal(results.find(m => m.tool_call_id === 'c1').content, REFUSAL(3));
  assert.equal(results.find(m => m.tool_call_id === 'c2').content, REFUSAL(3));
  assert.equal(results.find(m => m.tool_call_id === 'r1').content, 'file');
  assert.equal(h.ctx.activeTigerTeams.get('tt').round, 3, 'a refused message does not count as a round');
});

test('the 4th round with maxRounds 3 is the one refused', async () => {
  let consults = 0;
  const h = harness(n => n <= 4 ? { events: [tools([`c${n}`, 'consult_agent'])] } : { events: [text('Final')] },
    { consult_agent: async () => { consults++; return 'done'; } }, { maxRounds: 3 });
  await h.run();
  assert.equal(consults, 3);
  assert.equal(h.requests[4].filter(m => m.role === 'tool').pop().content, REFUSAL(3));
});

test('a participant (not the coordinator) never counts a round', async () => {
  const h = harness(n => n === 1 ? { events: [tools(['c1', 'consult_agent'])] } : { events: [text('x')] }, { consult_agent: async () => 'ok' }, { coordinator: 'someone-else' });
  await h.run();
  assert.equal(h.ctx.activeTigerTeams.get('tt').round || 0, 0);
});

/** The consult_agent handler exactly as lib/sdk-chat.js defines it, with its collaborators faked. */
function consultHandler(calls, { tigerTeamId = 'tt' } = {}) {
  const start = source.indexOf('handler: async ({ agent, prompt: rawPrompt, images }, recoveryMeta = {}) => {');
  const endMark = 'return pacing.failureText(e, agent);\n        }\n      }';
  const end = source.indexOf(endMark, start) + endMark.length;
  assert.ok(start > 0 && end > start, 'consult_agent handler found');
  const events = [];
  const state = { id: 'tt', coordinator: 'coord', maxRounds: 3, round: 2, curRound: 2, calls, findings: [] };
  const ctx = {
    console: { log() {} }, Date, Math, consultationDepth: 0, agentName: 'coord', tigerTeam: true, tigerTeamId, signal: null, callerTurn: null,
    sseRes: {}, sendSSE: (r, e) => events.push(e), makeChunk: (c, m, gateway) => ({ gateway }),
    hubHalt: { getHubHalt: () => ({ refusal: () => '' }) }, prepareConsultImages: () => ({ paths: [] }),
    newConsultId: a => 'w-' + a, getAgentModel: async () => 'm', getAgents: async () => [{ name: 'sam', display: 'Sam' }],
    activeTigerTeams: new Map([['tt', state]]), coordinatorToTigerTeam: new Map(), checkpointTeam() {},
    consultViaHub: async () => 'sam result', ttMustStop: () => false, ttMemberFailureText: () => 'failed', ttMemberFailureWhy: () => 'why',
    isStoppedResult: () => false, pacing: { failureText: () => 'x' },
  };
  vm.createContext(ctx);
  const handler = vm.runInContext('(' + source.slice(start + 'handler: '.length, end) + ')', ctx);
  return { handler, events, state };
}

test('a dispatch carries the round and max_rounds (and turn = round for old pages)', async () => {
  const h = consultHandler({});
  await h.handler({ agent: 'sam', prompt: 'look' }, { recoveryKey: 'coord-call:c1' });
  const d = h.events.find(e => e.gateway.type === 'tt_dispatch').gateway;
  assert.equal(d.round, 2); assert.equal(d.turn, 2); assert.equal(d.max_rounds, 3);
  assert.equal(h.state.dispatchCount || 0, 0, 'dispatches are no longer counted');
});

test('a call already completed (Resume replay) emits no tt_dispatch card', async () => {
  const h = consultHandler({ 'coord-call:c1': { key: 'coord-call:c1', status: 'completed', result: 'sam result' } });
  await h.handler({ agent: 'sam', prompt: 'look' }, { recoveryKey: 'coord-call:c1' });
  assert.equal(h.events.filter(e => e.gateway.type === 'tt_dispatch').length, 0);
  assert.equal(h.events.filter(e => e.gateway.type === 'tt_dispatch_complete').length, 0);
});

test('Continue starts from round 0 and its tt_started carries max_rounds; the page shows "Round N of M"', () => {
  const cont = source.slice(source.indexOf('async function continueTigerTeam('), source.indexOf('async function resumeTigerTeam('));
  assert.match(cont, /if \(!resuming\) \{\s*ttState\.round = 0; ttState\.curRound = 0;/);
  assert.match(cont, /continued_from: tigerTeamId,\s*max_rounds: ttState\.maxRounds/);
  const page = fs.readFileSync(path.join(__dirname, '../tiger-team.html'), 'utf8');
  assert.match(page, /'Round ' \+ \(gw\.round \|\| gw\.turn\) \+ ' of ' \+ dMax/);
  assert.match(page, /'Round 0 of ' \+ displayMax/);
  assert.doesNotMatch(page, /'Turn '/);
});

// ── A failed member's card shows what happened, not the chat's advice ──
const fail400 = () => { const e = new Error('Provider 400: bad request'); e.status = 400; throw e; };
const sayText = events => events.map(e => (e.content || '') + ((e.choices && e.choices[0] && e.choices[0].delta && e.choices[0].delta.content) || '')).join('');

test('a team member that fails shows the first line and the Details, but no "What to do" advice', async () => {
  const h = harness(fail400, {}, { coordinator: 'owner' });   // agent "coord" is a member here
  await h.run().catch(() => {});
  const shown = sayText(h.events);
  assert.match(shown, /couldn't reply\./);
  assert.match(shown, /Details: /);
  assert.doesNotMatch(shown, /What to do/);
  assert.doesNotMatch(shown, /Send again/);
});

// ── Review round 1: Until Complete, Resume admission, the challenger's bonus round ──
const consultCall = (id) => ({ id, type: 'function', function: { name: 'consult_agent', arguments: JSON.stringify({ agent: 'sam', prompt: 'p' }) } });

test('max rounds: 0 (Until Complete) is carried through, 20 stays 20, missing or invalid becomes 5', () => {
  const { normalizeMaxRounds } = require('../lib/tiger-team-max-rounds');
  assert.equal(normalizeMaxRounds(0, 5, 20), 0);
  assert.equal(normalizeMaxRounds('0', 5, 20), 0);
  assert.equal(normalizeMaxRounds(20, 5, 20), 20);
  assert.equal(normalizeMaxRounds(3, 5, 20), 3);
  assert.equal(normalizeMaxRounds(99, 5, 20), 20);
  for (const bad of [undefined, null, '', 'abc', -1, NaN]) assert.equal(normalizeMaxRounds(bad, 5, 20), 5, String(bad));
  assert.match(source, /maxRounds = args\.resumeId \? args\.maxRounds : normalizeMaxRounds\(args\.max_rounds, 5, 20\)/);
  assert.doesNotMatch(source, /Math\.min\(args\.max_rounds \|\| 5, 15\)/);
  assert.match(source, /There is no fixed number of rounds: you decide when the work is done; finish as soon as the objective is met/);
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.doesNotMatch(server, /max_rounds: max_rounds \|\| 5/);
});

test('maxRounds 0 never refuses a round, however many have run', async () => {
  let consults = 0;
  const h = harness(n => n <= 3 ? { events: [tools([`c${n}`, 'consult_agent'])] } : { events: [text('Final')] },
    { consult_agent: async () => { consults++; return 'done'; } }, { maxRounds: 0, round: 40, curRound: 40 });
  await h.run();
  assert.equal(consults, 3);
  assert.equal(h.ctx.activeTigerTeams.get('tt').round, 43);
});

test('Resume repair: an unanswered NEW consult call past the limit is refused, not dispatched', async () => {
  let consults = 0;
  const h = harness(() => ({ events: [text('Final')] }), { consult_agent: async () => { consults++; return 'done'; } }, { maxRounds: 1, round: 1, curRound: 1 });
  h.call.messages = [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', tool_calls: [consultCall('n1')] }];
  assert.equal(await h.run(), 'Final');
  assert.equal(consults, 0, 'not dispatched');
  assert.equal(h.requests[0].find(m => m.role === 'tool' && m.tool_call_id === 'n1').content, REFUSAL(1));
  assert.equal(h.call.tools.n1.status, 'completed', 'recorded like a completed result');
  assert.equal(h.call.tools.n1.result, REFUSAL(1));
  assert.equal(h.ctx.activeTigerTeams.get('tt').round, 1);
});

test('Resume repair: an already-admitted call is dispatched and the round is unchanged', async () => {
  let consults = 0;
  const h = harness(() => ({ events: [text('Final')] }), { consult_agent: async () => { consults++; return 'done'; } }, { maxRounds: 1, round: 1, curRound: 1, roundCallIds: ['a1'] });
  h.call.messages = [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', tool_calls: [consultCall('a1')] }];
  await h.run();
  assert.equal(consults, 1);
  assert.equal(h.ctx.activeTigerTeams.get('tt').round, 1);
});

test('Resume repair: a new call within the limit is admitted once and counts the round', async () => {
  let consults = 0;
  const h = harness(() => ({ events: [text('Final')] }), { consult_agent: async () => { consults++; return 'done'; } }, { maxRounds: 3, round: 1, curRound: 1 });
  h.call.messages = [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', tool_calls: [consultCall('n1'), consultCall('n2')] }];
  await h.run();
  assert.equal(consults, 2);
  const team = h.ctx.activeTigerTeams.get('tt');
  assert.equal(team.round, 2, 'two calls of one message are one round');
  assert.deepEqual(Array.from(team.roundCallIds), ['n1', 'n2']);
});

test('the challenger bonus round: at the limit one more round is admitted, the next is refused', async () => {
  let consults = 0;
  const h = harness(n => n <= 2 ? { events: [tools([`c${n}`, 'consult_agent'])] } : { events: [text('Final')] },
    { consult_agent: async () => { consults++; return 'done'; } }, { maxRounds: 1, round: 1, curRound: 1, bonusRounds: 1 });
  await h.run();
  assert.equal(consults, 1, 'the bonus round ran');
  assert.equal(h.requests[2].filter(m => m.role === 'tool').pop().content, REFUSAL(2), 'the one after it is refused');
  assert.match(source, /t\.bonusRounds = \(t\.bonusRounds \|\| 0\) \+ 1/);
});

test('a normal chat error keeps the "What to do" advice; the member format drops only that line', () => {
  const eh = require('../lib/error-help');
  const info = eh.explain(Object.assign(new Error('Provider 400: bad request'), { status: 400 }), { model: 'openai/gpt-5' });
  assert.match(eh.format(info), /What to do:/);
  const member = eh.formatMember(info);
  assert.doesNotMatch(member, /What to do/);
  assert.equal(member.split('\n')[0], eh.format(info).split('\n')[0], 'the first line is the chat\'s own first line');
  assert.ok(member.split('\n')[0].includes(info.title) && member.split('\n')[0].includes(info.what));
  assert.match(member, /\n\nDetails: /);
  assert.match(source, /const explained = ttMember \? errorHelp\.formatMember\(turnErrorInfo\) : errorHelp\.format\(turnErrorInfo\);/);
});

test('review r2: the challenger bonus round is granted once per challenge (a Resume of the step adds none); Continue clears it', () => {
  // the grant: guarded by the challenge it belongs to, saved with the team
  const grant = source.match(/\{ const t = activeTigerTeams\.get\(tigerTeamId\); if \(t && t\.bonusFor !== challengerWorkerId\) \{ t\.bonusRounds = \(t\.bonusRounds \|\| 0\) \+ 1; t\.bonusFor = challengerWorkerId; checkpointTeam\(tigerTeamId\); \} \}/);
  assert.ok(grant, 'the bonus grant is keyed to the challenge');
  const run = (t, challengerWorkerId) => { const activeTigerTeams = new Map([['tt', t]]); const tigerTeamId = 'tt'; const checkpointTeam = () => {}; eval(grant[0]); return t; };
  const t = { bonusRounds: 0 };
  run(t, 'tt-challenger'); run(t, 'tt-challenger'); run(t, 'tt-challenger');   // the first time, then two Resumes replaying the step
  assert.equal(t.bonusRounds, 1);
  run(t, 'tt2-challenger');
  assert.equal(t.bonusRounds, 2, 'a different challenge earns its own round');
  assert.match(source, /ttState\.round = 0; ttState\.curRound = 0; ttState\.bonusRounds = 0; ttState\.bonusFor = null;/);
});

test('review r2: Max Rounds 0 survives agent-started and staged launches (?? instead of ||)', () => {
  const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '../tiger-team.html'), 'utf8');
  assert.equal((app.match(/max_rounds \?\? 5\)\.toString\(\)/g) || []).length, 4);
  assert.ok(!/max_rounds \|\| 5\)\.toString\(\)/.test(app));
  assert.match(page, /maxRounds = data\.max_rounds \?\? maxRounds;/);
});

test('review r2: a note whose team finished or restarted elsewhere is put back in the box, never cleared unsent', () => {
  const page = fs.readFileSync(path.join(__dirname, '../tiger-team.html'), 'utf8');
  const fn = page.slice(page.indexOf('async function resumeInterruptedTeam(note)'), page.indexOf("continuationInFlight = true;\n      resumeBtn.textContent = '⏳ Resuming...'"));
  assert.match(fn, /if \(note\) \{ draftBox\.disabled = true; draftBtn\.disabled = true; \}/, 'the box is locked while the status is checked');
  assert.match(fn, /await loadSaved\(tigerTeamId\);\n\s*keepDraft\('This team finished in another window, so your note was not sent\./);
  // review r3: with a note waiting, a team running again is NOT followed (following redraws the page and only returns when the
  // team ends): the note stays in the box, unlocked, with a line saying so; and a put-back never overwrites text typed since.
  const running = fn.slice(fn.indexOf("if (note && statusData.has_stream) {"), fn.indexOf("if (statusData.has_stream && await loadTeam(tigerTeamId)) return;"));
  assert.ok(running.length > 0, 'the note branch comes before following the team');
  assert.match(running, /unlockDraft\(\); draftBox\.value = note;/);
  assert.match(running, /so your note was not sent\. It is still in the box/);
  assert.ok(!/loadTeam/.test(running), 'no following while a note waits');
  assert.match(fn, /const keepDraft = \(why\) => \{ if \(!note\) return; if \(!draftBox\.value\.trim\(\)\) draftBox\.value = note;/);
  assert.equal((fn.match(/unlockDraft\(\);/g) || []).length, 4, '404, a note waiting while the team runs, running elsewhere, status failure');
});
