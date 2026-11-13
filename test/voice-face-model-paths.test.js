'use strict';
// Face view: the leading mood tag must never be shown, spoken, saved or published on any of the three model paths
// (gateway, Claude SDK, Codex). These tests run the REAL streamViaGateway / streamViaSdk / streamViaCodex source text
// (sliced out of lib/sdk-chat.js, as test/tiger-team-tool-loop.test.js does) and the real voice helpers, in a vm sandbox
// where every provider (gateway stream, Claude SDK, Codex app-server / exec), the conversation log and the transcript are
// injected fakes. No network, no real provider, no real agent data, no files written.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createMoodFilter, FACE_MOOD_NOTE, MOODS } = require('../lib/voice/mood');

const SRC = fs.readFileSync(path.join(__dirname, '../lib/sdk-chat.js'), 'utf8');

// ── slicing the real source ──────────────────────────────────────────────────────────────────────────────────
function sliceFn(startMarker) {
  const a = SRC.indexOf(startMarker);
  assert.ok(a >= 0, `source has ${startMarker}`);
  const b = SRC.indexOf('\n}\n', a);
  return SRC.slice(a, b + 3);
}
const MAKE_CHUNK = sliceFn('function makeChunk(');
const PARAGRAPH = sliceFn('function paragraphAfterTool(');
const VOICE_NOTE_SRC = SRC.slice(SRC.indexOf('const VOICE_NOTE ='), SRC.indexOf('\n', SRC.indexOf('const VOICE_NOTE =')) + 1);
const FACE_HELPERS = (() => {   // faceMoodFor, voiceNoteFor, createVoiceMood
  const a = SRC.indexOf('function faceMoodFor(');
  const c = SRC.indexOf('function createVoiceMood(');
  const b = SRC.indexOf('\n}\n', c);
  assert.ok(a > 0 && c > a && b > c);
  return SRC.slice(a, b + 3);
})();
const GATEWAY = sliceFn('async function streamViaGateway(');
const SDK = sliceFn('async function streamViaSdk(');
const CODEX = sliceFn('async function streamViaCodex(');

// ── the sandbox ──────────────────────────────────────────────────────────────────────────────────────────────
// Anything the slice touches that the test does not define is a harmless stub (a function that returns undefined and
// can be chained). The pieces that decide what these tests prove are defined explicitly below.
function stub() {
  const f = function () { return undefined; };
  return new Proxy(f, {
    get: (t, k) => (k === 'then' ? undefined : (k === Symbol.toPrimitive ? () => '' : (typeof k === 'symbol' ? undefined : stub()))),
    apply: () => undefined,
    construct: () => ({}),
  });
}
// The names of the face-view code itself must always resolve to the real thing, never to a stub: a name used outside its
// scope (a ReferenceError in production) would otherwise be hidden by the stub.
const VOICE_NAMES = ['voiceMood', 'emitText', 'emitReplyText', 'emitCodexText', 'flushMood', 'moodRound', 'createVoiceMood', 'voiceNoteFor', 'faceMoodFor', 'createMoodFilter', 'FACE_MOOD_NOTE'];
const stubbed = new Set();
function makeSandbox(explicit) {
  const store = Object.assign(Object.create(null), explicit);
  const px = new Proxy(store, {
    has: () => true,
    get: (t, k) => {
      if (typeof k === 'symbol') return undefined;
      if (k in t) return t[k];
      if (k in globalThis) return globalThis[k];
      stubbed.add(k);
      t[k] = stub();
      return t[k];
    },
    set: (t, k, v) => { t[k] = v; return true; },
  });
  vm.createContext(px);
  return px;
}
// Every run goes through this: the turn, then a check that no face-view name fell through to a stub.
async function runChecked(fn) {
  const r = await fn();
  assert.deepEqual(VOICE_NAMES.filter(n => stubbed.has(n)), [], 'a face-view name resolved to a stub (out of scope in the real code?)');
  return r;
}

// One recorder per turn: every chunk the adapter sends, every conversation-log write, every history push.
function newRun() {
  const events = [];      // the chunk objects passed to sendSSE
  const logs = [];        // appendConversationLog(agent, role, text)
  const published = [];   // what hubEvents-style observers would see as reply text
  return { events, logs, published };
}
const textOf = events => events.map(e => (e && e.choices && e.choices[0] && e.choices[0].delta && e.choices[0].delta.content) || '').join('');
const moodsOf = events => events.filter(e => e && e.gateway && e.gateway.type === 'voice_mood').map(e => e.gateway.mood);

const TAGGED = /^\s*\[(?:delighted|laughing|sympathetic|surprised|proud|curious|encouraging)\]/i;
function assertNoTag(label, ...texts) {
  for (const t of texts) assert.ok(!TAGGED.test(t), `${label}: no valid leading tag in ${JSON.stringify(t)}`);
}

function baseExplicit(run, extra) {
  return Object.assign({
    console: { log() {}, error: (...a) => { if (process.env.FACE_TEST_DEBUG) console.error(...a); }, warn() {}, info() {} },
    process: { cwd: () => '/tmp/none', env: {}, on() {}, platform: 'linux' },
    sendSSE: (res, ev) => { run.events.push(ev); return true; },
    sendSSEDone() {}, sendSSEHeartbeat() {}, safeEnd(res) { res.writableEnded = true; },
    appendConversationLog: (agent, role, text) => { run.logs.push({ agent, role, text }); return true; },
    writeAutoMemory: async () => {}, autoDistill: async () => {},
    guardedSave: (a, fn) => { try { fn(); } catch {} },
    setInterval: () => 1, clearInterval() {}, setTimeout: (cb) => { try { cb(); } catch {} return 1; }, clearTimeout() {},
    makeProgressTicker: () => 1,
    HEARTBEAT_INTERVAL_MS: 15000, INCREMENTAL_SAVE_INTERVAL_MS: 3000,
    activeResponses: new Map(), turnRegistry: new Map(),
    ledger: { record() {} }, modelHealth: { record() {} },
  }, extra);
}
function loadInto(ctx, ...sources) {
  for (const s of sources) vm.runInContext(s, ctx);
}
function fakeRes() {
  return { writableEnded: false, destroyed: false, writeHead() {}, write() { return true; }, end() { this.writableEnded = true; }, on() {} };
}
function loadHelpers(ctx, { calls, packs } = {}) {
  ctx.createMoodFilter = createMoodFilter;
  ctx.FACE_MOOD_NOTE = FACE_MOOD_NOTE;
  ctx.voiceCall = calls || { onCall: () => true };
  ctx.facePacks = packs || { getPack: () => ({ manifest: { clips: [{ name: 'a', state: 'reaction' }] } }) };
  loadInto(ctx, VOICE_NOTE_SRC, MAKE_CHUNK, PARAGRAPH, FACE_HELPERS);
}

// ═════════════════════════════ the server's own check ══════════════════════════════════════════════════════
// faceMoodFor (the real source) decides whether a turn asks for the tag. The client's request is only a hint.
function faceCtx({ onCall = () => true, getPack, home = '/hub-home-for-test' } = {}) {
  const seen = [];
  const ctx = makeSandbox({
    console: { log() {}, error() {}, warn() {} },
    require: (m) => (m === './hub-home' ? { HUB_HOME: home } : stub()),
  });
  loadHelpers(ctx, {
    calls: { onCall: (a) => onCall(a), caller: () => ({ kind: 'none', id: null }) },
    packs: { getPack: (id, o) => { seen.push({ id, home: o && o.home }); return getPack ? getPack(id, o) : { manifest: { clips: [{ name: 'a', state: 'idle' }, { name: 'r', state: 'reaction' }] } }; } },
  });
  return { ok: (body, extra) => ctx.faceMoodFor(body, { agent: 'ada', turnOrigin: { kind: 'user' }, ephemeral: false, tigerTeam: false, consultedBy: null, accounts: false, service: false, ...extra }), seen };
}
const VOICE_BODY = { voice: true, facePack: 'owl' };

test('faceMoodFor: true only for a live call, the person\'s own non-ephemeral turn and an installed pack with reaction clips; the pack is read from the hub home', () => {
  const f = faceCtx();
  assert.strictEqual(f.ok(VOICE_BODY), true);
  assert.deepEqual(f.seen, [{ id: 'owl', home: '/hub-home-for-test' }], 'getPack(slug, { home: HUB_HOME })');
  assert.strictEqual(f.ok({ ...VOICE_BODY, origin: { kind: 'user' } }), true);
});

test('faceMoodFor: every missing or wrong part turns it off (and always answers a plain boolean)', () => {
  const f = faceCtx();
  const off = (body, extra, why) => assert.strictEqual(f.ok(body, extra), false, why);
  off({ facePack: 'owl' }, {}, 'not a voice turn');
  off({ voice: false, facePack: 'owl' }, {}, 'voice false');
  off({ voice: 'true', facePack: 'owl' }, {}, 'voice must be exactly true');
  off({ voice: 1, facePack: 'owl' }, {}, 'voice 1');
  off({ voice: true }, {}, 'no pack asked for');
  for (const bad of ['', null, 0, 7, true, {}, [], ['owl'], { id: 'owl' }]) off({ voice: true, facePack: bad }, {}, `facePack ${JSON.stringify(bad)}`);
  off(null, {}, 'no body'); off('x', {}, 'string body'); off(undefined, {}, 'undefined body');
  off(VOICE_BODY, { ephemeral: true }, 'ephemeral');
  off(VOICE_BODY, { tigerTeam: true }, 'tiger team');
  off(VOICE_BODY, { consultedBy: 'maestro' }, 'a consulted turn');
  for (const kind of ['consultation', 'schedule', 'task', 'job_notice', 'job_report', 'consult_reply', 'alert']) off(VOICE_BODY, { turnOrigin: { kind } }, `origin ${kind} (a hidden hub turn)`);
  off(VOICE_BODY, { turnOrigin: null }, 'no origin');
  off({ ...VOICE_BODY, origin: { kind: 'task' } }, {}, 'the body itself says it is a hub task');
  off({ ...VOICE_BODY, origin: { kind: 'schedule', label: 'x' } }, {}, 'a scheduled task');
});

test('faceMoodFor: the call must be live for this agent; a failing check is off, never an error', () => {
  assert.strictEqual(faceCtx({ onCall: () => false }).ok(VOICE_BODY), false);
  const asked = [];
  assert.strictEqual(faceCtx({ onCall: (a) => { asked.push(a); return a === 'ada'; } }).ok(VOICE_BODY), true);
  assert.deepEqual(asked, ['ada']);
  assert.strictEqual(faceCtx({ onCall: () => { throw new Error('boom'); } }).ok(VOICE_BODY), false);
});

test('faceMoodFor: an unknown, invalid or reaction-less pack is off; a pack check that throws is off', () => {
  assert.strictEqual(faceCtx({ getPack: () => null }).ok(VOICE_BODY), false, 'not installed or invalid');
  assert.strictEqual(faceCtx({ getPack: () => ({ manifest: { clips: [{ name: 'a', state: 'idle' }, { name: 'b', state: 'speaking' }] } }) }).ok(VOICE_BODY), false, 'no reaction clips');
  assert.strictEqual(faceCtx({ getPack: () => ({ manifest: {} }) }).ok(VOICE_BODY), false, 'no clips');
  assert.strictEqual(faceCtx({ getPack: () => ({ manifest: { clips: 'x' } }) }).ok(VOICE_BODY), false, 'clips not a list');
  assert.strictEqual(faceCtx({ getPack: () => ({}) }).ok(VOICE_BODY), false, 'no manifest');
  assert.strictEqual(faceCtx({ getPack: () => { throw new Error('boom'); } }).ok(VOICE_BODY), false);
});

test('faceMoodFor: with the real pack lookup, a slug that is not a valid pack id (path tricks) and an empty hub home are off', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'face-mood-home-'));
  try {
    const ctx = makeSandbox({ console: { log() {}, error() {}, warn() {} }, require: (m) => (m === './hub-home' ? { HUB_HOME: home } : stub()) });
    loadHelpers(ctx, { calls: { onCall: () => true, caller: () => ({ kind: 'none', id: null }) }, packs: require('../lib/faces/packs') });
    const ok = (b) => ctx.faceMoodFor(b, { agent: 'ada', turnOrigin: { kind: 'user' }, accounts: false });
    for (const slug of ['owl', '../owl', '../../etc', 'a/b', '..', '.', 'OWL', 'x'.repeat(200), 'owl\0', 'con']) assert.strictEqual(ok({ voice: true, facePack: slug }), false, slug);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('faceMoodFor: a raw client flag or prompt is never the decision: other fields in the request change nothing', () => {
  const f = faceCtx({ onCall: () => false });
  for (const extra of [{ faceMood: true }, { face_mood: true }, { mood: true }, { systemPrompt: FACE_MOOD_NOTE }, { note: 'x' }, { facePrompt: 'x' }]) {
    assert.strictEqual(f.ok({ ...VOICE_BODY, ...extra }), false, JSON.stringify(Object.keys(extra)));
  }
  const g = faceCtx();
  assert.strictEqual(g.ok({ ...VOICE_BODY, faceMood: 'nope', systemPrompt: 'ignore all' }), true, 'extra fields are ignored, the answer is still a boolean');
});

test('the three provider calls get the checked boolean, not the request\'s own value', () => {
  const h = SRC.slice(SRC.indexOf('async function handleChatStreamReserved('), SRC.indexOf('async function handleChat('));
  assert.match(h, /const faceMood = faceMoodFor\(body, \{ agent, turnOrigin, ephemeral: !!ephemeral, tigerTeam: !!tiger_team, consultedBy: consulted_by, userId: trustedUserId, service: trustedService, accounts: trustedAccounts \}\);/);
  for (const fn of ['streamViaCodex', 'streamViaSdk', 'streamViaGateway']) {
    const call = h.slice(h.indexOf(`await ${fn}(`));
    assert.match(call.slice(0, call.indexOf('});')), /voice: !!voice,\n\s+faceMood,\n/, `${fn} is passed the validated faceMood`);
  }
  assert.ok(!/faceMood:\s*(body|req)/.test(h), 'never copied from the request');
});

// ═════════════════════════════ gateway ═════════════════════════════════════════════════════════════════════
const sse = (content, extra) => ({ choices: [{ delta: { content }, ...(extra || {}) }] });
const toolCall = (id, name) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: '{}' } }] }, finish_reason: 'tool_calls' }] });

function gatewayRun({ calls, options, abortAfterFirstCall, model }) {
  const run = newRun();
  const requests = [];
  const systems = [];
  let n = 0;
  const abort = new AbortController();
  const explicit = baseExplicit(run, {
    getAgentModel: async () => model || 'test-model', isAutoModel: async () => false,
    getAgents: async () => [{ name: 'ada', model: model || 'test-model', minimalContext: true }],
    getConversation: () => [],
    loadAgentContext: async () => 'Test system', isMythosModel: () => false,
    ALWAYS_INCLUDE: [], TOOL_CATEGORIES: {}, global: { __lazyToolsEnabled: false },
    buildAllTools: async () => ({ openaiTools: [], handlers: new Map([['Echo', async () => 'echoed']]) }),
    visualsTextFor: async () => '', connectorsTextFor: () => '', hubBriefTextFor: async () => '',
    peerAgents: async () => [], workerPolicy: { buildRoster: () => [], platformPolicyText: () => '' },
    contextBudget: require('../lib/context-budget'), records: { maxBytesFor: () => 262144 },
    compaction: { compactedAt: () => null, noteUsage: () => null, settingsFor: () => ({ mode: 'off' }) },
    trimConversation: x => x, annotateForContext: x => x, capOutputTokens: () => 500, stableTrim: x => x,
    gate: { check: async () => ({ allowed: true }) },
    providerPacing: require('../lib/provider-pacing'), errorHelp: require('../lib/error-help'),
    modelTelemetry: { recordRequest() {}, recordToolCall() {} },
    executeToolCallsBatched: require('../lib/tool-concurrency').executeToolCallsBatched, isReadOnlyTool: () => false,
    queryCache: { get: () => null, put() {} }, recordToolError() {}, getInlineErrorGuidance: () => '', getToolGuidance: () => '',
    temporalWorkers: { isVirtual: () => false, getVirtual: () => null }, jobs: { policyText: () => '' }, scheduledTasks: { policyText: () => '' },
    timeZoneLib: { zoneForAgent: () => 'UTC', policyText: () => '', localTimeTag: () => '[time]' },
    accumulateToolCallDelta: require('../lib/tool-call-deltas').accumulateToolCallDelta,
    activityMeta: (agent, text, extra) => extra, history: [], interjectionQueues: new Map(), drainInterjections: () => [],
    MAX_TOOL_TURNS: 12, MAX_TRUNCATION_RESUMES: 3, MAX_LENGTH_CONTINUATIONS: 3, REASON_FLUSH_MS: 250,
    pendingToolConfirms: new Map(), isStoppedResult: () => false, raceStop: (p) => p,
    chatCompletionStream: async (messages, opts) => {
      requests.push(structuredClone(messages));
      systems.push(opts.system);
      return { call: n++ };
    },
    parseSSEStream: async function* (response, state) {
      const plan = calls[response.call] || [];
      for (const item of plan) {
        if (item instanceof Error) throw item;
        if (item === 'ABORT') { abort.abort(); continue; }
        yield item;
      }
      state.sawDone = true;
    },
  });
  const ctx = makeSandbox(explicit);
  loadHelpers(ctx);
  loadInto(ctx, GATEWAY);
  const exec = () => runChecked(() => ctx.streamViaGateway('ada', 'hello there', [], fakeRes(), { voice: true, faceMood: false, ...options, signal: abort.signal }));
  return { exec, run, requests, systems, ctx, abort };
}

function chunksOf(parts) { return parts.map((p, i) => sse(p, i === parts.length - 1 ? { finish_reason: 'stop' } : undefined)); }

test('gateway: a leading tag split at every chunk boundary is removed, announced once, and never reaches the reply, the log or the model history', async () => {
  const reply = '[proud] Well done. That is lovely.';
  for (let cut1 = 0; cut1 <= reply.length; cut1++) {
    for (const cut2 of [cut1, Math.min(reply.length, cut1 + 3)]) {
      const parts = [reply.slice(0, cut1), reply.slice(cut1, cut2), reply.slice(cut2)].filter(Boolean);
      const g = gatewayRun({ calls: [chunksOf(parts)], options: { faceMood: true } });
      await g.exec();
      const shown = textOf(g.run.events);
      assert.equal(shown, 'Well done. That is lovely.', `cuts ${cut1}/${cut2}`);
      assert.deepEqual(moodsOf(g.run.events), ['proud'], `announced once at cuts ${cut1}/${cut2}`);
      const saved = g.run.logs.filter(l => l.role === 'assistant').map(l => l.text);
      assert.deepEqual(saved, ['Well done. That is lovely.']);
      assertNoTag('log', ...saved);
    }
  }
});

test('gateway: one chunk per character, and a tag in one single chunk', async () => {
  const reply = '[Curious]  Why do you ask?';
  for (const parts of [reply.split(''), [reply]]) {
    const g = gatewayRun({ calls: [chunksOf(parts)], options: { faceMood: true } });
    await g.exec();
    assert.equal(textOf(g.run.events), 'Why do you ask?');
    assert.deepEqual(moodsOf(g.run.events), ['curious']);
  }
});

test('gateway: the mood event comes before the first visible text', async () => {
  const g = gatewayRun({ calls: [chunksOf(['[delighted]', ' Hooray'])], options: { faceMood: true } });
  await g.exec();
  const firstText = g.run.events.findIndex(e => textOf([e]));
  const mood = g.run.events.findIndex(e => e.gateway && e.gateway.type === 'voice_mood');
  assert.ok(mood >= 0 && mood < firstText, 'mood first');
});

test('gateway: unknown word, plain text, markdown link, a second tag and a mid-reply tag pass through; unknown words are stripped without an event', async () => {
  const cases = [
    ['[whatever] Hello', '[whatever] Hello', []],            // unknown word: ordinary text, no event
    ['[Summary] The plan is ready.', '[Summary] The plan is ready.', []],
    ['[x] done', '[x] done', []],
    ['[OK]', '[OK]', []],
    ['Hello [proud] there', 'Hello [proud] there', []],      // not leading
    ['[proud] Hello [curious] there', 'Hello [curious] there', ['proud']],   // a second tag is ordinary text
    ['[Title](http://x) rest', '[Title](http://x) rest', []],   // a link
    ['[1] item', '[1] item', []],
    ['Plain reply.', 'Plain reply.', []],
  ];
  for (const [input, shown, moods] of cases) {
    for (const parts of [[input], input.split('')]) {
      const g = gatewayRun({ calls: [chunksOf(parts)], options: { faceMood: true } });
      await g.exec();
      assert.equal(textOf(g.run.events), shown, JSON.stringify(input));
      assert.deepEqual(moodsOf(g.run.events), moods, JSON.stringify(input));
    }
  }
});

test('gateway: a tag-only reply ends cleanly: the mood is announced, nothing is shown or saved', async () => {
  const g = gatewayRun({ calls: [chunksOf(['[proud]'])], options: { faceMood: true } });
  await g.exec();
  assert.equal(textOf(g.run.events), '');
  assert.deepEqual(moodsOf(g.run.events), ['proud']);
  assert.deepEqual(g.run.logs.filter(l => l.role === 'assistant'), []);
});

test('gateway: held text is flushed at the end of the call (an unclosed "[prou") and nothing is lost', async () => {
  const g = gatewayRun({ calls: [chunksOf(['[prou'])], options: { faceMood: true } });
  await g.exec();
  assert.equal(textOf(g.run.events), '[prou');
  assert.deepEqual(moodsOf(g.run.events), []);
  assert.deepEqual(g.run.logs.filter(l => l.role === 'assistant').map(l => l.text), ['[prou']);
});

test('gateway: tool calls: the tag before a tool call is stripped; text after the tool keeps its paragraph break and is not filtered again', async () => {
  const g = gatewayRun({
    calls: [[...chunksOf(['[sympathetic] Let me look.']), toolCall('c1', 'Echo')], chunksOf(['[proud] Found it.'])],
    options: { faceMood: true },
  });
  await g.exec();
  assert.equal(textOf(g.run.events), 'Let me look.\n\n[proud] Found it.', 'the later [proud] is not leading: ordinary text');
  assert.deepEqual(moodsOf(g.run.events), ['sympathetic']);
  assert.equal(g.requests.length, 2);
  const assistantMsgs = g.requests[1].filter(m => m.role === 'assistant').map(m => m.content);
  assert.deepEqual(assistantMsgs, ['Let me look.'], 'the model never sees the tag it wrote');
});

test('gateway: a silent tool call first, then a tagged reply: the tag is still leading and is removed', async () => {
  const g = gatewayRun({ calls: [[toolCall('c1', 'Echo')], chunksOf(['[encouraging] You can do it.'])], options: { faceMood: true } });
  await g.exec();
  assert.equal(textOf(g.run.events), 'You can do it.');
  assert.deepEqual(moodsOf(g.run.events), ['encouraging']);
});

test('gateway: held text before a tool call is released before the tool starts', async () => {
  const g = gatewayRun({ calls: [[...chunksOf(['[curi']), toolCall('c1', 'Echo')], chunksOf(['done'])], options: { faceMood: true } });
  await g.exec();
  assert.equal(textOf(g.run.events), '[curi\n\ndone');
  const iHeld = g.run.events.findIndex(e => textOf([e]) === '[curi');
  const iTool = g.run.events.findIndex(e => e.gateway && e.gateway.type === 'tool_start');
  assert.ok(iHeld >= 0 && iHeld < iTool);
});

test('gateway: an error mid-stream flushes held text before the error notice', async () => {
  const g = gatewayRun({ calls: [[...chunksOf(['[prou']), new Error('fetch failed')]], options: { faceMood: true } });
  await g.exec();
  const text = textOf(g.run.events);
  assert.ok(text.startsWith('[prou'), text);
  assert.ok(text.indexOf('[prou') < text.indexOf('\n\n'), 'held text first, then the notice');
  assert.deepEqual(moodsOf(g.run.events), []);
});

test('gateway: a stop while a complete tag is held: no mood is announced, and held plain text is kept', async () => {
  const g = gatewayRun({ calls: [[...chunksOf(['[proud]']), 'ABORT', new Error('aborted')]], options: { faceMood: true } });
  await g.exec();
  assert.deepEqual(moodsOf(g.run.events), [], 'a stopped reply shows no reaction');
  assert.equal(textOf(g.run.events).includes('[proud]'), false, 'and never prints the tag');
  const g2 = gatewayRun({ calls: [[...chunksOf(['[pro']), 'ABORT', new Error('aborted')]], options: { faceMood: true } });
  await g2.exec();
  assert.equal(textOf(g2.run.events).startsWith('[pro'), true, 'held text is not lost on a stop');
});

test('gateway: prompt: the mood note is added to the voice note per turn only when faceMood is true', async () => {
  const on = gatewayRun({ calls: [chunksOf(['Hi'])], options: { faceMood: true } });
  await on.exec();
  assert.ok(on.systems[0].includes('This is a voice conversation'), 'voice note');
  assert.ok(on.systems[0].includes(FACE_MOOD_NOTE), 'mood note');
  for (const m of MOODS) assert.ok(on.systems[0].includes(`[${m}]`));
  const off = gatewayRun({ calls: [chunksOf(['[proud] Hi'])], options: { faceMood: false } });
  await off.exec();
  assert.ok(off.systems[0].includes('This is a voice conversation'));
  assert.ok(!off.systems[0].includes(FACE_MOOD_NOTE), 'no mood note');
  assert.equal(textOf(off.run.events), '[proud] Hi', 'filter off: text byte for byte');
  assert.deepEqual(moodsOf(off.run.events), []);
  const typed = gatewayRun({ calls: [chunksOf(['Hi'])], options: { voice: false, faceMood: true } });
  await typed.exec();
  assert.ok(!typed.systems[0].includes('This is a voice conversation'), 'no voice note on a typed turn');
  assert.ok(!typed.systems[0].includes(FACE_MOOD_NOTE));
  const eph = gatewayRun({ calls: [chunksOf(['[proud] Hi'])], options: { ephemeral: true, faceMood: true } });
  await eph.exec();
  assert.ok(!eph.systems[0].includes(FACE_MOOD_NOTE), 'ephemeral: never');
  assert.equal(textOf(eph.run.events), '[proud] Hi');
});

test('gateway: EMPTY STREAM guard is per model call: text+tool first, then an empty call is still an error (non-local) or retried twice (local), mood on or off', async () => {
  const empty = [];
  for (const faceMood of [false, true]) {
    // non-local: the empty second call is an error the owner sees, not a blank end of turn
    const g = gatewayRun({ calls: [[...chunksOf(['Let me look.']).map(c => ({ choices: [{ delta: c.choices[0].delta }] })), toolCall('c1', 'Echo')], empty], options: { faceMood } });
    await g.exec();
    assert.equal(g.requests.length, 2, `faceMood=${faceMood}: no retry for a non-local provider`);
    assert.ok(textOf(g.run.events).includes('The model returned nothing'), `faceMood=${faceMood}: error shown: ${textOf(g.run.events)}`);
    // local: two retries (3 calls after the first = 1 + 3 requests in total), then the error
    const l = gatewayRun({ calls: [[...chunksOf(['Let me look.']).map(c => ({ choices: [{ delta: c.choices[0].delta }] })), toolCall('c1', 'Echo')], empty, empty, empty], options: { faceMood }, model: 'local/m' });
    await l.exec();
    assert.equal(l.requests.length, 4, `faceMood=${faceMood}: local: first call + empty + 2 retries`);
    assert.ok(textOf(l.run.events).includes('The model returned nothing'), `faceMood=${faceMood}: local error after two retries`);
  }
});

test('gateway: a mood-only first call (the tag emptied by the filter, no finish reason) is not an empty stream: no retry, no error', async () => {
  for (const model of [undefined, 'local/m']) {
    const g = gatewayRun({ calls: [[sse('[proud]')], [], []], options: { faceMood: true }, model });
    await g.exec();
    assert.equal(g.requests.length, 1, `${model}: no extra request`);
    assert.ok(!textOf(g.run.events).includes('The model returned nothing'));
    assert.deepEqual(moodsOf(g.run.events), ['proud']);
  }
});

test('gateway: truthy-but-not-true faceMood values do nothing (a raw client flag is never trusted)', async () => {
  for (const v of ['true', 1, 'yes', {}, [], 'proud']) {
    const g = gatewayRun({ calls: [chunksOf(['[proud] Hi'])], options: { faceMood: v } });
    await g.exec();
    assert.ok(!g.systems[0].includes(FACE_MOOD_NOTE), String(v));
    assert.equal(textOf(g.run.events), '[proud] Hi');
  }
});

// ═════════════════════════════ Claude SDK ══════════════════════════════════════════════════════════════════
const sdkDelta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const sdkTool = (id, name) => ({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name, id } } });
const sdkResult = (result) => ({ type: 'result', subtype: 'success', is_error: false, result, usage: {}, total_cost_usd: 0 });

function sdkRun({ messages, options, throwAfter, abortAt }) {
  const run = newRun();
  const prompts = [];
  const abort = new AbortController();
  let systemAppend = '';
  const fakeSdk = {
    query({ prompt, options: qo }) {
      systemAppend = (qo && qo.systemPrompt && qo.systemPrompt.append) || '';
      const it = (async function* () {
        // the first user message the hub gives the client (its per-turn prefix carries the voice note)
        const first = await prompt.next();
        if (first && first.value) prompts.push(JSON.stringify(first.value));
        for (let i = 0; i < messages.length; i++) {
          if (abortAt === i) abort.abort();
          yield messages[i];
        }
        if (throwAfter) throw new Error('process exited');
      })();
      it.getContextUsage = async () => null;
      it.interrupt = async () => {};
      return it;
    },
  };
  const explicit = baseExplicit(run, {
    loadSdk: async () => fakeSdk, cliOptions: () => ({}),
    getAgentModel: async () => 'claude-sdk/claude-sonnet-5-5',
    getAgents: async () => [{ name: 'ada', model: 'claude-sdk/claude-sonnet-5-5', minimalContext: true }],
    loadAgentContext: async () => 'Test system',
    timeZoneLib: { zoneForAgent: () => 'UTC', policyText: () => '', localTimeTag: () => '[time]' },
    workerPolicy: { buildRoster: () => [], platformPolicyText: () => '', disallowedToolsFor: () => [], getMode: () => 'off', policyText: () => '' },
    require: (m) => (m === './claude-auth' ? require('../lib/claude-auth') : stub()),   // anything else the slice requires inline (billing, ...) does nothing
    peerAgents: async () => [], visualsTextFor: async () => '', connectorsTextFor: () => '', hubBriefTextFor: async () => '',
    ownerOfAgent: async () => null, adminIdSet: () => new Set(),
    temporalWorkers: { isVirtual: () => false, getVirtual: () => null, sdkDisallowedFor: () => [] },
    records: { maxBytesFor: () => 262144 },
    contextRefresh: { getContextRefresh: () => ({ plan: () => ({ block: '', summary: '', commit() {} }), forget() {} }) },
    promptCounts: new Map(), sdkInterjectChannels: new Map(),
    providerPacing: require('../lib/provider-pacing'), errorHelp: require('../lib/error-help'),
    paragraphAfterTool: (t) => (t && !/\n\s*$/.test(t) ? '\n\n' : ''),
    activityMeta: (agent, text, extra) => extra,
    SdkWorkerTracker: class { constructor() { this.size = 0; } workerFor() { return null; } drain() { return []; } completeByIds() { return []; } },
    drainInterjections: () => [], interjectionQueues: new Map(),
    getAgentSessionId: () => null, setAgentSessionId() {},
    sdkInterject: { ...require('../lib/sdk-interject'), takeUndelivered: () => [], stashUndelivered() {} },   // the stash lives on disk: faked
    contextWindow: require('../lib/context-window'),
    compaction: { compactedAt: () => null, noteUsage: () => null, settingsFor: () => ({ mode: 'off' }) },
    handsForTurn: async () => ({ mode: 'client', withheld: false, agent: null }),
    sandboxLib: { getSandbox: () => ({ isSandboxed: () => false }) },
    clientWatch: { forTurn: () => ({ spawn: undefined, expectExit() {}, clear() {} }) },
    gate: { sdkHook: () => async () => ({}) },
  });
  const ctx = makeSandbox(explicit);
  loadHelpers(ctx);
  loadInto(ctx, SDK);
  const exec = () => runChecked(() => ctx.streamViaSdk('ada', 'hello there', [], fakeRes(), { voice: true, faceMood: false, ...options, signal: abort.signal }));
  return { exec, run, prompts, systemAppend: () => systemAppend, ctx };
}

const savedOf = run => run.logs.filter(l => l.role === 'assistant').map(l => l.text);

test('sdk: a streamed leading tag split at every chunk boundary is removed, announced once, and absent from the reply and the saved log (the result text still carries it)', async () => {
  const reply = '[delighted] What a lovely idea. Shall we?';
  for (let cut = 0; cut <= reply.length; cut++) {
    const deltas = [reply.slice(0, cut), reply.slice(cut)].filter(Boolean).map(sdkDelta);
    const s = sdkRun({ messages: [...deltas, sdkResult(reply)], options: { faceMood: true } });
    await s.exec();
    assert.equal(textOf(s.run.events), 'What a lovely idea. Shall we?', `cut ${cut}`);
    assert.deepEqual(moodsOf(s.run.events), ['delighted'], `cut ${cut}`);
    assert.deepEqual(savedOf(s.run), ['What a lovely idea. Shall we?']);
    assertNoTag('saved', ...savedOf(s.run));
  }
});

test('sdk: a non-mood bracket at the start, split at every chunk boundary, is kept whole with no mood', async () => {
  for (const reply of ['[Summary] The plan is ready.', '[x] done', '[OK]']) {
    for (let cut = 0; cut <= reply.length; cut++) {
      const deltas = [reply.slice(0, cut), reply.slice(cut)].filter(Boolean).map(sdkDelta);
      const s = sdkRun({ messages: [...deltas, sdkResult(reply)], options: { faceMood: true } });
      await s.exec();
      assert.equal(textOf(s.run.events), reply, `${reply} cut ${cut}`);
      assert.deepEqual(moodsOf(s.run.events), [], `${reply} cut ${cut}`);
      assert.deepEqual(savedOf(s.run), [reply]);
    }
  }
});

test('gateway: a non-mood bracket at the start, split at every chunk boundary, is kept whole with no mood', async () => {
  for (const reply of ['[Summary] The plan is ready.', '[x] done', '[OK]']) {
    for (let cut = 0; cut <= reply.length; cut++) {
      const parts = [reply.slice(0, cut), reply.slice(cut)].filter(Boolean);
      const g = gatewayRun({ calls: [chunksOf(parts)], options: { faceMood: true } });
      await g.exec();
      assert.equal(textOf(g.run.events), reply, `${reply} cut ${cut}`);
      assert.deepEqual(moodsOf(g.run.events), [], `${reply} cut ${cut}`);
      assert.deepEqual(g.run.logs.filter(l => l.role === 'assistant').map(l => l.text), [reply]);
    }
  }
});

test('codex: a non-mood bracket at the start, split at every chunk boundary (app-server deltas), is kept whole with no mood', async () => {
  for (const reply of ['[Summary] The plan is ready.', '[x] done', '[OK]']) {
    for (let cut = 0; cut <= reply.length; cut++) {
      const pieces = [reply.slice(0, cut), reply.slice(cut)].filter(Boolean);
      const c = codexRun({ transport: 'app-server', items: codexReply('app-server', pieces), options: { faceMood: true } });
      await c.exec();
      assert.equal(textOf(c.run.events), reply, `${reply} cut ${cut}`);
      assert.deepEqual(moodsOf(c.run.events), [], `${reply} cut ${cut}`);
      assert.deepEqual(savedOf(c.run), [reply]);
    }
  }
});

test('sdk: one chunk per character, and the tag in a single chunk', async () => {
  const reply = '[Surprised] Oh! Really?';
  for (const parts of [reply.split(''), [reply]]) {
    const s = sdkRun({ messages: [...parts.map(sdkDelta), sdkResult(reply)], options: { faceMood: true } });
    await s.exec();
    assert.equal(textOf(s.run.events), 'Oh! Really?');
    assert.deepEqual(moodsOf(s.run.events), ['surprised']);
  }
});

test('sdk: result-only mode (nothing streamed): the result text goes through the same filter', async () => {
  const cases = [
    ['[proud] You did it.', 'You did it.', ['proud']],
    ['[nonsense] Hello', '[nonsense] Hello', []],
    ['[Summary] The plan is ready.', '[Summary] The plan is ready.', []],
    ['[x] done', '[x] done', []],
    ['[OK]', '[OK]', []],
    ['Hello [proud] there', 'Hello [proud] there', []],
    ['[Title](http://x) rest', '[Title](http://x) rest', []],
    ['Plain.', 'Plain.', []],
  ];
  for (const [result, shown, moods] of cases) {
    const s = sdkRun({ messages: [sdkResult(result)], options: { faceMood: true } });
    await s.exec();
    assert.equal(textOf(s.run.events), shown, result);
    assert.deepEqual(moodsOf(s.run.events), moods, result);
    assertNoTag('saved', ...savedOf(s.run));
    if (shown) assert.deepEqual(savedOf(s.run), [shown]);
  }
});

test('sdk: a tag-only reply (streamed or result-only) shows nothing, saves nothing, announces once, and the result fallback does not print the tag', async () => {
  for (const messages of [[sdkDelta('[proud]'), sdkResult('[proud]')], [sdkResult('[proud]')], [sdkDelta('[pro'), sdkDelta('ud]'), sdkResult('[proud]')]]) {
    const s = sdkRun({ messages, options: { faceMood: true } });
    await s.exec();
    assert.equal(textOf(s.run.events), '');
    assert.deepEqual(moodsOf(s.run.events), ['proud']);
    assert.deepEqual(savedOf(s.run), []);
  }
});

test('sdk: with the filter off the text is byte for byte (no tag stripping, no event)', async () => {
  const s = sdkRun({ messages: [sdkDelta('[proud] Hi'), sdkResult('[proud] Hi')], options: { faceMood: false } });
  await s.exec();
  assert.equal(textOf(s.run.events), '[proud] Hi');
  assert.deepEqual(moodsOf(s.run.events), []);
});

test('sdk: tool calls: held text goes out before the tool, the paragraph break after the tool is kept, a later tag is ordinary text', async () => {
  const s = sdkRun({ messages: [sdkDelta('[curious] Let me look.'), sdkTool('t1', 'Read'), sdkDelta('[proud] Found it.'), sdkResult('x')], options: { faceMood: true } });
  await s.exec();
  assert.equal(textOf(s.run.events), 'Let me look.\n\n[proud] Found it.');
  assert.deepEqual(moodsOf(s.run.events), ['curious']);
  const held = sdkRun({ messages: [sdkDelta('[curi'), sdkTool('t1', 'Read'), sdkDelta('Done.'), sdkResult('x')], options: { faceMood: true } });
  await held.exec();
  assert.equal(textOf(held.run.events), '[curi\n\nDone.');
  const silent = sdkRun({ messages: [sdkTool('t1', 'Read'), sdkDelta('[encouraging] Keep going.'), sdkResult('x')], options: { faceMood: true } });
  await silent.exec();
  assert.equal(textOf(silent.run.events), 'Keep going.', 'a tool call before any text does not use up the leading position');
  assert.deepEqual(moodsOf(silent.run.events), ['encouraging']);
});

test('sdk: a process error flushes held text first; a stop announces no mood', async () => {
  const err = sdkRun({ messages: [sdkDelta('[prou')], throwAfter: true, options: { faceMood: true } });
  await err.exec();
  const t = textOf(err.run.events);
  assert.ok(t.startsWith('[prou'), t);
  assert.deepEqual(moodsOf(err.run.events), []);
  const stop = sdkRun({ messages: [sdkDelta('[proud]'), sdkDelta('more')], abortAt: 1, options: { faceMood: true } });
  await stop.exec();
  assert.deepEqual(moodsOf(stop.run.events), [], 'no reaction for a stopped reply');
  assert.ok(!textOf(stop.run.events).includes('[proud]'));
  const stop2 = sdkRun({ messages: [sdkDelta('[pro'), sdkDelta('x')], abortAt: 1, options: { faceMood: true } });
  await stop2.exec();
  assert.ok(textOf(stop2.run.events).startsWith('[pro'), 'held plain text survives a stop');
});

// ═════════════════════════════ Codex ═══════════════════════════════════════════════════════════════════════
// app-server transport: actions as lib/codex-cli/app-server.js emits them (text_begin, then deltas).
// exec transport: raw `codex exec --json` events through the REAL codexCli.eventToActions (whole messages).
const cxBegin = () => ({ kind: 'text_begin', id: 'm' });
const cxDelta = text => ({ kind: 'text', text, delta: true });
const cxTool = () => ({ kind: 'tool_start', id: 'x1', tool: 'shell', input: 'ls' });
const execMsg = text => ({ type: 'item.completed', item: { id: 'i' + Math.random(), type: 'agent_message', text } });
const execTool = () => ({ type: 'item.started', item: { id: 'x1', type: 'command_execution', command: 'ls' } });

function codexRun({ transport, items, options, throwAfter, abortAt, status }) {
  const run = newRun();
  const prompts = [];
  const abort = new AbortController();
  const feed = (emit) => {
    for (let i = 0; i < items.length; i++) {
      if (abortAt === i) abort.abort();
      emit(items[i]);
    }
    if (throwAfter) throw new Error('codex process exited');
  };
  const fakeSession = {
    async openThread() { return { threadId: 'th1', resumed: false }; },
    async runTurn({ input, onAction, onStarted }) {
      prompts.push(String(input));
      if (onStarted) onStarted();
      feed(onAction);
      return { status: status || 'completed' };
    },
    close() {},
  };
  const codexCli = {
    ...require('../lib/codex-cli'),
    modelId: (m) => String(m).replace(/^codex-cli\//, ''), resolveBinary: () => '/fake/codex', getSession: () => null, setSession() {}, clearSession() {},
    sandboxFor: () => 'read-only', buildArgs: () => [], approvalPolicyFor: () => 'never', MAX_INSTRUCTIONS_ARG: 1e9,
  };
  const explicit = baseExplicit(run, {
    getAgentModel: async () => 'codex-cli/gpt-test', agentEffort: async () => 'medium', effortLib: { forModel: () => 'medium' },
    getAgents: async () => [{ name: 'ada', model: 'codex-cli/gpt-test' }], loadAgentContext: async () => 'Test system',
    getAgentWorkspace: async () => '/tmp/none', HUB_PKG_VERSION: 'test', HUB_PORT: 0,
    codexCli,
    appServer: {
      transportFor: () => (transport === 'app-server' ? 'app-server' : 'exec'),
      CodexAppSession: { open: async () => fakeSession },
      SteerPump: class { start() {} async finish() { return []; } onUserMessage() {} undelivered() { return []; } },
      turnInput: (p) => p,
    },
    codexBridge: { register: () => ({ file: '/none', release() {} }), collectingSdk: {} },
    runCodexProcess: async ({ input, onEvent }) => {
      prompts.push(String(input));
      feed(onEvent);
      return { code: 0, stderrTail: '' };
    },
    codexTurns: new Set(), codexSteerChannels: new Map(), buildHubMcpServer: async () => ({ tools: [] }),
    workerPolicy: { buildRoster: () => [], platformPolicyText: () => '', disallowedToolsFor: () => [], getMode: () => 'off', policyText: () => '' },
    peerAgents: async () => [], visualsTextFor: async () => '', connectorsTextFor: () => '', hubBriefTextFor: async () => '',
    temporalWorkers: { isVirtual: () => false, getVirtual: () => null, gatewayExcludesFor: () => [], sdkDisallowedFor: () => [] },
    jobs: { policyText: () => '' }, scheduledTasks: { policyText: () => '' },
    timeZoneLib: { zoneForAgent: () => 'UTC', policyText: () => '', localTimeTag: () => '[time]' },
    handsForTurn: async () => ({ mode: 'client', withheld: false, agent: null }),
    sdkInterject: { ...require('../lib/sdk-interject'), takeUndelivered: () => [], stashUndelivered() {}, formatCarried: () => '' },
    drainInterjections: () => [], requeueInterjections() {}, ownerOfAgent: async () => null, adminIdSet: () => new Set(),
    providerPacing: require('../lib/provider-pacing'), errorHelp: require('../lib/error-help'),
    reasoningForSave: () => undefined, showReasoning: () => false, sendReasoning() {},
    setPhase() {}, progressTicker: 1,
  });
  const ctx = makeSandbox(explicit);
  loadHelpers(ctx);
  loadInto(ctx, CODEX);
  const exec = () => runChecked(() => ctx.streamViaCodex('ada', 'hello there', [], fakeRes(), { voice: true, faceMood: false, ...options, signal: abort.signal }));
  return { exec, run, prompts };
}
const TRANSPORTS = ['app-server', 'exec'];
// A reply as the transport sends it: app-server = text_begin + the pieces as deltas; exec = whole messages.
const codexReply = (transport, pieces) => (transport === 'app-server' ? [cxBegin(), ...pieces.map(cxDelta)] : [execMsg(pieces.join(''))]);
const codexTool = transport => (transport === 'app-server' ? cxTool() : execTool());

test('codex: smoke: a plain reply reaches the reply on both transports', async () => {
  for (const transport of TRANSPORTS) {
    const c = codexRun({ transport, items: codexReply(transport, ['Hello', ' there']), options: { faceMood: true } });
    await c.exec();
    assert.equal(textOf(c.run.events), 'Hello there', transport);
  }
});

test('codex: a leading tag split at every chunk boundary (app-server deltas) is removed, announced once, and absent from the reply and the saved log', async () => {
  const reply = '[sympathetic] I am sorry to hear that. Tell me more.';
  for (let cut1 = 0; cut1 <= reply.length; cut1++) {
    const cut2 = Math.min(reply.length, cut1 + 2);
    const pieces = [reply.slice(0, cut1), reply.slice(cut1, cut2), reply.slice(cut2)].filter(Boolean);
    const c = codexRun({ transport: 'app-server', items: codexReply('app-server', pieces), options: { faceMood: true } });
    await c.exec();
    assert.equal(textOf(c.run.events), 'I am sorry to hear that. Tell me more.', `cuts ${cut1}/${cut2}`);
    assert.deepEqual(moodsOf(c.run.events), ['sympathetic'], `cuts ${cut1}/${cut2}`);
    assert.deepEqual(savedOf(c.run), ['I am sorry to hear that. Tell me more.']);
    assertNoTag('saved', ...savedOf(c.run));
  }
});

test('codex: one delta per character (app-server) and a whole message (exec)', async () => {
  const reply = '[Encouraging] You can do this.';
  for (const [transport, pieces] of [['app-server', reply.split('')], ['app-server', [reply]], ['exec', [reply]]]) {
    const c = codexRun({ transport, items: codexReply(transport, pieces), options: { faceMood: true } });
    await c.exec();
    assert.equal(textOf(c.run.events), 'You can do this.', transport);
    assert.deepEqual(moodsOf(c.run.events), ['encouraging'], transport);
    assert.deepEqual(savedOf(c.run), ['You can do this.'], transport);
  }
});

test('codex: unknown word is stripped without an event; plain text, a link, a mid-reply and a second tag pass through (both transports)', async () => {
  const cases = [
    ['[whatever] Hello', '[whatever] Hello', []],
    ['[Summary] The plan is ready.', '[Summary] The plan is ready.', []],
    ['[x] done', '[x] done', []],
    ['[OK]', '[OK]', []],
    ['Hello [proud] there', 'Hello [proud] there', []],
    ['[proud] Hello [curious] there', 'Hello [curious] there', ['proud']],
    ['[Title](http://x) rest', '[Title](http://x) rest', []],
    ['Plain.', 'Plain.', []],
  ];
  for (const transport of TRANSPORTS) {
    for (const [input, shown, moods] of cases) {
      for (const pieces of transport === 'app-server' ? [[input], input.split('')] : [[input]]) {
        const c = codexRun({ transport, items: codexReply(transport, pieces), options: { faceMood: true } });
        await c.exec();
        assert.equal(textOf(c.run.events), shown, `${transport} ${input}`);
        assert.deepEqual(moodsOf(c.run.events), moods, `${transport} ${input}`);
      }
    }
  }
});

test('codex: a tag-only reply shows and saves nothing and announces once (both transports)', async () => {
  for (const transport of TRANSPORTS) {
    const c = codexRun({ transport, items: codexReply(transport, ['[pro', 'ud]']), options: { faceMood: true } });
    await c.exec();
    assert.equal(textOf(c.run.events), '', transport);
    assert.deepEqual(moodsOf(c.run.events), ['proud'], transport);
    assert.deepEqual(savedOf(c.run), [], transport);
  }
});

test('codex: whole text and delta are told apart: whole messages are separated by a blank line, deltas of one message are not; only the first message can carry the tag', async () => {
  const a = codexRun({ transport: 'exec', items: [execMsg('[proud] First.'), execMsg('Second.'), execMsg('[curious] Third.')], options: { faceMood: true } });
  await a.exec();
  assert.equal(textOf(a.run.events), 'First.\n\nSecond.\n\n[curious] Third.');
  assert.deepEqual(moodsOf(a.run.events), ['proud']);
  const b = codexRun({ transport: 'app-server', items: [cxBegin(), cxDelta('[proud] Fir'), cxDelta('st.'), cxBegin(), cxDelta('Sec'), cxDelta('ond.')], options: { faceMood: true } });
  await b.exec();
  assert.equal(textOf(b.run.events), 'First.\n\nSecond.');
  assert.deepEqual(moodsOf(b.run.events), ['proud']);
  // a whole message ends where it ends: a tag-only first message is decided there, not glued to the next message
  const glue = codexRun({ transport: 'exec', items: [execMsg('[proud]'), execMsg('(a note) and more')], options: { faceMood: true } });
  await glue.exec();
  assert.equal(textOf(glue.run.events), '(a note) and more');
  assert.deepEqual(moodsOf(glue.run.events), ['proud']);
  const off = codexRun({ transport: 'exec', items: [execMsg('[proud] First.'), execMsg('Second.')], options: { faceMood: false } });
  await off.exec();
  assert.equal(textOf(off.run.events), '[proud] First.\n\nSecond.', 'filter off: unchanged');
});

test('codex: tool calls: held text goes out before the tool, a message after a tool keeps its separator, a silent tool first leaves the tag leading', async () => {
  for (const transport of TRANSPORTS) {
    const c = codexRun({ transport, items: [...codexReply(transport, ['[curious] Let me look.']), codexTool(transport), ...codexReply(transport, ['[proud] Found it.'])], options: { faceMood: true } });
    await c.exec();
    assert.equal(textOf(c.run.events), 'Let me look.\n\n[proud] Found it.', transport);
    assert.deepEqual(moodsOf(c.run.events), ['curious'], transport);
    const silent = codexRun({ transport, items: [codexTool(transport), ...codexReply(transport, ['[encouraging] Keep going.'])], options: { faceMood: true } });
    await silent.exec();
    assert.equal(textOf(silent.run.events), 'Keep going.', transport);
    assert.deepEqual(moodsOf(silent.run.events), ['encouraging'], transport);
  }
  const held = codexRun({ transport: 'app-server', items: [cxBegin(), cxDelta('[curi'), cxTool(), cxBegin(), cxDelta('Done.')], options: { faceMood: true } });
  await held.exec();
  assert.equal(textOf(held.run.events), '[curi\n\nDone.');
  const nextMsg = codexRun({ transport: 'app-server', items: [cxBegin(), cxDelta('[curi'), cxBegin(), cxDelta('ous')], options: { faceMood: true } });
  await nextMsg.exec();
  assert.equal(textOf(nextMsg.run.events), '[curi\n\nous', 'a new message releases what the filter held');
});

test('codex: a process error flushes held text first; a stop announces no mood and keeps held plain text', async () => {
  for (const transport of TRANSPORTS) {
    const err = codexRun({ transport, items: codexReply(transport, ['[prou']), throwAfter: true, options: { faceMood: true } });
    await err.exec();
    const t = textOf(err.run.events);
    assert.ok(t.startsWith('[prou'), `${transport}: ${t}`);
    assert.deepEqual(moodsOf(err.run.events), [], transport);
  }
  const stop = codexRun({ transport: 'app-server', items: [cxBegin(), cxDelta('[proud]'), cxDelta('x')], abortAt: 2, options: { faceMood: true } });
  await stop.exec();
  assert.deepEqual(moodsOf(stop.run.events), [], 'no reaction for a stopped reply');
  assert.ok(!textOf(stop.run.events).includes('[proud]'));
  const stop2 = codexRun({ transport: 'app-server', items: [cxBegin(), cxDelta('[pro'), cxDelta('x')], abortAt: 2, options: { faceMood: true } });
  await stop2.exec();
  assert.ok(textOf(stop2.run.events).startsWith('[pro'), 'held plain text survives a stop');
});

test('codex: prompt: the mood note rides the voice note only when faceMood is true (both transports); off for typed, ephemeral and non-true values', async () => {
  const note = FACE_MOOD_NOTE;
  for (const transport of TRANSPORTS) {
    const on = codexRun({ transport, items: codexReply(transport, ['Hi']), options: { faceMood: true } });
    await on.exec();
    assert.ok(on.prompts[0].includes('This is a voice conversation') && on.prompts[0].includes(note), `${transport}: voice + mood note`);
    for (const [label, options] of [['faceMood false', { faceMood: false }], ['typed turn', { voice: false, faceMood: true }], ['ephemeral', { ephemeral: true, faceMood: true }], ['string', { faceMood: 'true' }], ['number', { faceMood: 1 }]]) {
      const off = codexRun({ transport, items: codexReply(transport, ['[proud] Hi']), options });
      await off.exec();
      assert.ok(!off.prompts[0].includes(note), `${transport} ${label}`);
      assert.equal(textOf(off.run.events), '[proud] Hi', `${transport} ${label}`);
      assert.deepEqual(moodsOf(off.run.events), [], `${transport} ${label}`);
    }
  }
});

// ═════════════════ Orb / None: every server-verified live voice call strips a recognised tag, with no mood prompt ═════════
test('voiceStripFor: true for any live voice call on the person\'s own turn (no pack needed); every other turn is false', () => {
  const ctx = makeSandbox({ console: { log() {}, error() {}, warn() {} }, require: () => stub() });
  let live = true;
  loadHelpers(ctx, { calls: { onCall: () => live, caller: () => (live ? { kind: 'none', id: null } : null) } });
  const base = { agent: 'ada', turnOrigin: { kind: 'user' }, ephemeral: false, tigerTeam: false, consultedBy: null, accounts: false, service: false };
  const f = (body, extra) => ctx.voiceStripFor(body, { ...base, ...extra });
  assert.strictEqual(f({ voice: true }), true, 'None / Orb: no facePack');
  assert.strictEqual(f({ voice: true, facePack: 'owl' }), true);
  assert.strictEqual(f({ voice: true, origin: { kind: 'user' } }), true);
  assert.strictEqual(f({}), false);
  assert.strictEqual(f({ voice: 'true' }), false);
  assert.strictEqual(f({ voice: true }, { ephemeral: true }), false);
  assert.strictEqual(f({ voice: true }, { tigerTeam: true }), false);
  assert.strictEqual(f({ voice: true }, { consultedBy: 'bob' }), false);
  assert.strictEqual(f({ voice: true }, { turnOrigin: { kind: 'schedule' } }), false);
  assert.strictEqual(f({ voice: true, origin: { kind: 'job' } }), false);
  live = false;
  assert.strictEqual(f({ voice: true }), false, 'no live call');
  assert.strictEqual(ctx.voiceStripFor({ voice: true }, { ...base, calls: { onCall() { throw new Error('x'); } } }), false);
});

// ═════════════════ the call must be the signed-in account's own (stable id, never the display name) ═════════════════
test('voiceStripFor / faceMoodFor: stable account id: own call and second tab pass; another account, one-sided absence, and every non-user turn fail', async () => {
  const { createVoiceCalls } = require('../lib/voice/call');
  const reg = createVoiceCalls({ bus: { publish() {} }, log() {} });
  const ctx = makeSandbox({ console: { log() {}, error() {}, warn() {} }, require: () => stub() });
  loadHelpers(ctx, { calls: reg, packs: { getPack: () => ({ manifest: { clips: [{ state: 'reaction' }] } }) } });
  const base = { agent: 'ada', turnOrigin: { kind: 'user' }, ephemeral: false, tigerTeam: false, consultedBy: null };
  // accounts: true = the install has accounts (server capability, hubAuth.hasUsers()); service = the hub's service token
  const strip = (userId, extra, body = { voice: true }) => ctx.voiceStripFor(body, { ...base, userId, accounts: true, service: false, calls: reg, ...extra });
  const mood = (userId, extra) => ctx.faceMoodFor({ voice: true, facePack: 'owl' }, { ...base, userId, accounts: true, service: false, calls: reg, ...extra });

  // personId is internal: the stored id of a live call only; info() / statusOf() (the API views) are unchanged
  assert.strictEqual(reg.personId('ada'), null, 'no call');
  reg.start('ada', { userId: 'u1', person: 'Sam', mode: 'announce' });
  assert.strictEqual(reg.personId('ada'), 'u1');
  assert.deepStrictEqual(Object.keys(reg.info('ada')).sort(), ['mode', 'person', 'since']);
  assert.ok(!('userId' in reg.statusOf('ada')) && !JSON.stringify(reg.statusOf('ada')).includes('u1'));
  assert.strictEqual(strip('u1'), true, 'own call');
  assert.strictEqual(strip('u1'), true, 'second tab of the same account (same stable id)');
  assert.strictEqual(mood('u1'), true);
  // a second account sharing the agent, even with the same display name, is not the call's person
  reg.end('ada', 'u1');
  reg.start('ada', { userId: 'u1', person: 'Sam' });
  assert.strictEqual(strip('u2'), false);
  assert.strictEqual(mood('u2'), false);
  assert.strictEqual(strip('u2', {}, { voice: true, person: 'Sam', userId: 'u1' }), false, 'a userId or person in the body is never trusted');
  assert.strictEqual(strip(null), false, 'call has an account, the caller has none');
  assert.strictEqual(strip(''), false);
  assert.strictEqual(strip(undefined), false);
  // no accounts: the call has no account (routes store owner) and the caller has none
  reg.end('ada', 'u1');
  reg.start('ada', { userId: 'owner', person: 'the owner' });
  assert.strictEqual(reg.personId('ada'), null);
  const NOACC = { accounts: false };
  assert.strictEqual(strip(null, NOACC), true, 'both absent, install has no accounts');
  assert.strictEqual(strip(undefined, NOACC), true);
  assert.strictEqual(strip('', NOACC), true);
  assert.strictEqual(mood(null, NOACC), true);
  assert.strictEqual(strip(null), false, 'accounts exist: an owner/empty call never matches a caller with no account');
  assert.strictEqual(strip(null, { accounts: undefined }), false, 'accounts capability missing: fail closed');
  assert.strictEqual(strip('u1', NOACC), false, 'the call has no account but the caller does');
  assert.strictEqual(strip(null, { ...NOACC, service: true }), false, 'a service caller never matches a no-account call');
  reg.end('ada', 'owner');
  reg.start('ada', { userId: '', person: 'the owner' });
  assert.strictEqual(strip(null, NOACC), true, "'' also means no account, only when the install has none");
  assert.strictEqual(strip(null), false);
  reg.end('ada', '');
  reg.start('ada', { userId: 'owner', person: 'the owner' });
  // no token identity is stored, so a service caller cannot be told from another service caller: service === true fails closed everywhere
  reg.end('ada', 'owner');
  reg.start('ada', { userId: 'service', person: 'the owner' });
  const SVC = { service: true };
  assert.strictEqual(strip(null, SVC), false, 'service-to-service: fail closed (another service caller is indistinguishable)');
  assert.strictEqual(mood(null, SVC), false, 'service-to-service mood: fail closed');
  assert.strictEqual(strip(null, { ...SVC, ...NOACC }), false, 'service-to-service, no accounts: still false');
  assert.strictEqual(strip(null), false, 'with accounts: a caller with no account (/api/chat, no ctx) does not match a service call');
  assert.strictEqual(strip(null, NOACC), false, 'no accounts: no-account caller still does not match a service call');
  assert.strictEqual(strip('u1'), false, 'a signed-in person on a service-started call');
  assert.strictEqual(mood('u1'), false);
  assert.strictEqual(strip('service'), false, 'an account whose id is literally service is not the service token');
  assert.strictEqual(strip('u1', { service: true }), false, 'a service flag never matches an account call');
  assert.ok(!('caller' in reg.info('ada')) && !('caller' in reg.statusOf('ada')) && !('userId' in reg.statusOf('ada')), 'identity is not in the API views');
  assert.deepStrictEqual(Object.keys(reg.info('ada')).sort(), ['mode', 'person', 'since']);
  reg.end('ada', 'service');
  reg.start('ada', { userId: 'u1', person: 'Sam' });
  assert.strictEqual(strip(null, SVC), false, 'service-to-user: a service caller on a signed-in person\'s call');
  assert.strictEqual(mood(null, SVC), false);
  assert.strictEqual(strip('u1'), true, 'the same person');
  assert.strictEqual(mood('u1'), true, 'the same person, with a reaction pack');
  reg.end('ada', 'u1');
  reg.start('ada', { userId: 'owner', person: 'the owner' });
  // hub-started, ephemeral, tiger team and consult turns are never stripped, whoever is calling
  reg.end('ada', 'owner');
  reg.start('ada', { userId: 'u1', person: 'Sam' });
  assert.strictEqual(strip('u1', { turnOrigin: { kind: 'schedule' } }), false);
  assert.strictEqual(strip('u1', { turnOrigin: { kind: 'consultation', from: 'bob' } }), false);
  assert.strictEqual(strip('u1', { ephemeral: true }), false);
  assert.strictEqual(strip('u1', { tigerTeam: true }), false);
  assert.strictEqual(strip('u1', { consultedBy: 'bob' }), false);
  assert.strictEqual(strip('u1', {}, { voice: true, origin: { kind: 'job' } }), false);
  assert.strictEqual(mood('u1', { consultedBy: 'bob' }), false);
  reg.reset();
});

test('handleChatStream takes the account id only from the route\'s own argument, never the body', () => {
  assert.match(SRC, /async function handleChatStream\(body, res, ctx\)/);
  assert.match(SRC, /const trustedUserId = ctx && typeof ctx === 'object' && ctx\.userId != null/);
  assert.ok(!/body\??\.(userId|person)/.test(SRC.slice(SRC.indexOf('async function handleChatStreamReserved('), SRC.indexOf('async function handleChat('))));
});

test('the three provider calls also get the checked moodStrip boolean; the mood prompt still follows faceMood alone', () => {
  const h = SRC.slice(SRC.indexOf('async function handleChatStreamReserved('), SRC.indexOf('async function handleChat('));
  assert.match(h, /const moodStrip = faceMood \|\| voiceStripFor\(body, \{ agent, turnOrigin, ephemeral: !!ephemeral, tigerTeam: !!tiger_team, consultedBy: consulted_by, userId: trustedUserId, service: trustedService, accounts: trustedAccounts \}\);/);
  for (const fn of ['streamViaCodex', 'streamViaSdk', 'streamViaGateway']) {
    const call = h.slice(h.indexOf(`await ${fn}(`));
    assert.match(call.slice(0, call.indexOf('});')), /faceMood,\n\s+moodStrip,\n/, `${fn} is passed moodStrip`);
  }
  assert.ok(!/moodStrip:\s*(body|req)/.test(h), 'never copied from the request');
  assert.match(SRC, /function voiceNoteFor\(options, ephemeral\) \{[^}]*options\.faceMood === true/, 'the prompt note still depends on faceMood only');
  assert.ok(!/voiceNoteFor[^\n]*moodStrip/.test(SRC), 'moodStrip never reaches the prompt');
});

const STRIP_OPTS = { faceMood: false, moodStrip: true };

test('Orb / None (moodStrip, no faceMood): gateway strips an unsolicited tag at every split, adds no mood prompt, keeps unknown brackets', async () => {
  const reply = '[proud] Well done. That is lovely.';
  for (let cut = 0; cut <= reply.length; cut++) {
    const parts = [reply.slice(0, cut), reply.slice(cut)].filter(Boolean);
    const g = gatewayRun({ calls: [chunksOf(parts)], options: STRIP_OPTS });
    await g.exec();
    assert.equal(textOf(g.run.events), 'Well done. That is lovely.', `cut ${cut}`);
    assert.deepEqual(g.run.logs.filter(l => l.role === 'assistant').map(l => l.text), ['Well done. That is lovely.']);
    assert.ok(g.systems[0].includes('This is a voice conversation'));
    assert.ok(!g.systems[0].includes(FACE_MOOD_NOTE), 'no mood prompt');
  }
  for (const text of ['[Summary] The plan is ready.', '[x] done', '[OK]']) {
    for (let cut = 0; cut <= text.length; cut++) {
      const parts = [text.slice(0, cut), text.slice(cut)].filter(Boolean);
      const g = gatewayRun({ calls: [chunksOf(parts)], options: STRIP_OPTS });
      await g.exec();
      assert.equal(textOf(g.run.events), text, `${text} cut ${cut}`);
      assert.deepEqual(moodsOf(g.run.events), []);
    }
  }
  const typed = gatewayRun({ calls: [chunksOf(['[proud] Hi'])], options: { voice: false, ...STRIP_OPTS } });
  await typed.exec();
  assert.equal(textOf(typed.run.events), '[proud] Hi', 'a typed turn is never stripped');
  const eph = gatewayRun({ calls: [chunksOf(['[proud] Hi'])], options: { ephemeral: true, ...STRIP_OPTS } });
  await eph.exec();
  assert.equal(textOf(eph.run.events), '[proud] Hi', 'ephemeral is never stripped');
});

test('Orb / None (moodStrip, no faceMood): SDK strips an unsolicited tag at every split (stream and result), adds no mood prompt, keeps unknown brackets', async () => {
  const reply = '[delighted] What a lovely idea. Shall we?';
  for (let cut = 0; cut <= reply.length; cut++) {
    const deltas = [reply.slice(0, cut), reply.slice(cut)].filter(Boolean).map(sdkDelta);
    const s = sdkRun({ messages: [...deltas, sdkResult(reply)], options: STRIP_OPTS });
    await s.exec();
    assert.equal(textOf(s.run.events), 'What a lovely idea. Shall we?', `cut ${cut}`);
    assert.deepEqual(savedOf(s.run), ['What a lovely idea. Shall we?']);
    assert.ok(!s.prompts[0].includes(JSON.stringify(FACE_MOOD_NOTE).slice(1, -1)), 'no mood prompt');
    assert.ok(s.prompts[0].includes('This is a voice conversation'));
  }
  const only = sdkRun({ messages: [sdkResult('[curious] Why?')], options: STRIP_OPTS });
  await only.exec();
  assert.equal(textOf(only.run.events), 'Why?', 'result-only text is stripped too');
  for (const text of ['[Summary] The plan is ready.', '[x] done', '[OK]']) {
    for (let cut = 0; cut <= text.length; cut++) {
      const deltas = [text.slice(0, cut), text.slice(cut)].filter(Boolean).map(sdkDelta);
      const s = sdkRun({ messages: [...deltas, sdkResult(text)], options: STRIP_OPTS });
      await s.exec();
      assert.equal(textOf(s.run.events), text, `${text} cut ${cut}`);
      assert.deepEqual(savedOf(s.run), [text]);
    }
  }
  const typed = sdkRun({ messages: [sdkResult('[proud] Hi')], options: { voice: false, ...STRIP_OPTS } });
  await typed.exec();
  assert.equal(textOf(typed.run.events), '[proud] Hi', 'a typed turn is never stripped');
});

test('Orb / None (moodStrip, no faceMood): Codex strips an unsolicited tag at every split on both transports, adds no mood prompt, keeps unknown brackets', async () => {
  const reply = '[sympathetic] I am sorry to hear that. Tell me more.';
  for (const transport of TRANSPORTS) {
    for (let cut = 0; cut <= reply.length; cut++) {
      const pieces = [reply.slice(0, cut), reply.slice(cut)].filter(Boolean);
      const c = codexRun({ transport, items: codexReply(transport, pieces), options: STRIP_OPTS });
      await c.exec();
      assert.equal(textOf(c.run.events), 'I am sorry to hear that. Tell me more.', `${transport} cut ${cut}`);
      assert.deepEqual(savedOf(c.run), ['I am sorry to hear that. Tell me more.']);
      assert.ok(c.prompts[0].includes('This is a voice conversation') && !c.prompts[0].includes(FACE_MOOD_NOTE), `${transport}: no mood prompt`);
    }
    for (const text of ['[Summary] The plan is ready.', '[x] done', '[OK]']) {
      for (let cut = 0; cut <= text.length; cut++) {
        const pieces = [text.slice(0, cut), text.slice(cut)].filter(Boolean);
        const c = codexRun({ transport, items: codexReply(transport, pieces), options: STRIP_OPTS });
        await c.exec();
        assert.equal(textOf(c.run.events), text, `${transport} ${text} cut ${cut}`);
        assert.deepEqual(savedOf(c.run), [text]);
      }
    }
    const typed = codexRun({ transport, items: codexReply(transport, ['[proud] Hi']), options: { voice: false, ...STRIP_OPTS } });
    await typed.exec();
    assert.equal(textOf(typed.run.events), '[proud] Hi', `${transport}: a typed turn is never stripped`);
  }
});

test('sdk: prompt: the mood note rides the per-turn voice note only when faceMood is true; off for typed, ephemeral and non-true values', async () => {
  const on = sdkRun({ messages: [sdkResult('Hi')], options: { faceMood: true } });
  await on.exec();
  assert.ok(on.prompts[0].includes('This is a voice conversation') && on.prompts[0].includes(JSON.stringify(FACE_MOOD_NOTE).slice(1, -1)), 'voice + mood note');
  for (const [label, options] of [['faceMood false', { faceMood: false }], ['typed turn', { voice: false, faceMood: true }], ['ephemeral', { ephemeral: true, faceMood: true }], ['string', { faceMood: 'true' }], ['number', { faceMood: 1 }]]) {
    const off = sdkRun({ messages: [sdkResult('[proud] Hi')], options });
    await off.exec();
    assert.ok(!off.prompts[0].includes(JSON.stringify(FACE_MOOD_NOTE).slice(1, -1)), label);
    assert.equal(textOf(off.run.events), '[proud] Hi', label);
    assert.deepEqual(moodsOf(off.run.events), [], label);
  }
});
