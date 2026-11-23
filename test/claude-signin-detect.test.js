'use strict';
// A signed-out Claude client: the hub recognises it (text or the SDK's 'authentication_failed' mark), shows plain help instead of
// the client's own sentence, says so once per turn, and saves the row with claudeSignin. The turn tests run the REAL streamViaSdk
// source (sliced out of lib/sdk-chat.js, as test/voice-face-model-paths.test.js does) in a vm sandbox with a fake SDK: no network,
// no real client, no real data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('claude-signin-detect-');
const L = (p) => require(path.join(ISO.lib, p));
const auth = L('claude-auth');

const SENTENCE = 'Failed to authenticate: this login reached its time limit and cannot be renewed. Run claude auth login to sign in again, or use claude setup-token and set CLAUDE_CODE_OAUTH_TOKEN for unattended jobs';
const RELATIVES = [
  'Failed to authenticate: OAuth session expired and could not be refreshed',
  'Login expired · Please run /login',
  'Login reached its time limit · Please run /login',
  'Not logged in · Please run /login',
  'Authentication required · Sign in again to continue',
  'Failed to authenticate: your claude.ai login expired',
];

test('the literal sentence and every relative are recognised as a sign-in failure (the Claude client\'s own sentences)', () => {
  assert.match(SENTENCE, auth.CLAUDE_SIGNIN_RE);
  assert.equal(auth.signInFixText(SENTENCE), auth.SIGN_IN_HELP);
  assert.equal(auth.isSignInFailure(SENTENCE), true);
  for (const t of RELATIVES) { assert.match(t, auth.CLAUDE_SIGNIN_RE, t); assert.equal(auth.signInFixText(t), auth.SIGN_IN_HELP, t); assert.equal(auth.isSignInFailure(t), true, t); }
  for (const t of ['Invalid API key · Please run /login', 'Run claude auth login to sign in', 'OAuth session expired and could not be refreshed']) assert.match(t, auth.CLAUDE_SIGNIN_RE, t);
});

test('other failures are not sign-in failures', () => {
  for (const t of ['API Error: 529 overloaded', 'Claude AI usage limit reached', 'context window exceeded', 'Your account is on hold',
    'Could not refresh your login because another Claude Code process is refreshing it', '']) {
    assert.doesNotMatch(t, auth.CLAUDE_SIGNIN_RE, t);
    assert.equal(auth.signInFixText(t), '', t);
  }
});

test('generic words other providers and MCP servers use are NOT a Claude sign-in failure', () => {
  for (const t of ['Invalid API key', 'invalid api key provided', 'Incorrect API key provided: sk-xxxx', 'Unauthorized', '401 Unauthorized from MCP server notes',
    'Error: request failed with status 401 Unauthorized', 'request reached its time limit', 'The operation reached its time limit', 'OAuth token has expired', 'token expired',
    'credentials invalid', 'authentication_error', 'Authentication error', 'Not logged in', 'Please sign in again to the dashboard', 'run setup-token', 'cannot be renewed']) {
    assert.doesNotMatch(t, auth.CLAUDE_SIGNIN_RE, t);
    assert.equal(auth.isSignInFailure(t), false, t);
    assert.equal(auth.signInFixText(t), '', t);
  }
  assert.equal(auth.isSignInFailure('Unauthorized', 'authentication_failed'), true, 'the SDK\'s own mark still counts');
});

test('sanitizeSignInDetail: no link, no address, no long token; whitespace collapsed; at most 300', () => {
  const raw = 'Failed to authenticate: please visit https://claude.example/oauth/authorize?code=abc&state=xyz or ask sam.example@mail.example about  \n  token sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 now';
  const clean = auth.sanitizeSignInDetail(raw);
  assert.doesNotMatch(clean, /https?:|@|oauth|sk-ant|AbCdEf/);
  assert.match(clean, /^Failed to authenticate: please visit or ask about token now$/);
  assert.equal(auth.sanitizeSignInDetail('x '.repeat(400)).length, 300);
  assert.equal(auth.sanitizeSignInDetail(null), '');
});

test('isSignInFailure: the SDK mark counts, so does the text, ordinary text does not', () => {
  assert.equal(auth.isSignInFailure('anything', 'authentication_failed'), true);
  assert.equal(auth.isSignInFailure('Please run /login', 'rate_limit'), true);
  assert.equal(auth.isSignInFailure('ordinary text', 'rate_limit'), false);
  assert.equal(auth.isSignInFailure('ordinary text'), false);
  assert.equal(auth.isSignInFailure(undefined), false);
});

test('the help words: plain, no token or /exit instructions', () => {
  assert.match(auth.SIGN_IN_HELP, /Claude is signed out on the computer that runs your Maestro/);
  assert.match(auth.SIGN_IN_HELP, /mymaestro connect claude/);
  assert.doesNotMatch(auth.SIGN_IN_HELP, /CLAUDE_CODE_OAUTH_TOKEN|setup-token|\/exit|type `claude`/);
});

test('the credentials file follows CLAUDE_CONFIG_DIR; clearTokenCache forgets a cached token', () => {
  const saved = { dir: process.env.CLAUDE_CONFIG_DIR, home: process.env.HOME };
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'csd-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'csd-b-'));
  try {
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'csd-home-'));   // nothing under it
    fs.writeFileSync(path.join(dirA, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'dummy-token-a' } }));
    fs.writeFileSync(path.join(dirB, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'dummy-token-b' } }));
    process.env.CLAUDE_CONFIG_DIR = dirA;
    auth.clearTokenCache();
    assert.equal(auth.hasSignIn(), true);
    assert.equal(auth.getOauthToken(), 'dummy-token-a');
    process.env.CLAUDE_CONFIG_DIR = dirB;
    assert.equal(auth.getOauthToken(), 'dummy-token-a', 'cached for a minute');
    auth.clearTokenCache();
    assert.equal(auth.getOauthToken(), 'dummy-token-b', 'a new sign-in is seen at once after clearTokenCache');
    fs.rmSync(path.join(dirB, '.credentials.json'));
    auth.clearTokenCache();
    if (process.platform !== 'darwin') assert.equal(auth.hasSignIn(), false, 'a folder without the file is signed out');
  } finally {
    if (saved.dir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.dir;
    process.env.HOME = saved.home;
    auth.clearTokenCache();
  }
});

// ═════════════ the Claude SDK turn (real streamViaSdk source, fake SDK) ═════════════
const SRC = fs.readFileSync(path.join(__dirname, '../lib/sdk-chat.js'), 'utf8');
const sliceFn = (startMarker) => { const a = SRC.indexOf(startMarker); assert.ok(a >= 0, startMarker); return SRC.slice(a, SRC.indexOf('\n}\n', a) + 3); };
const MAKE_CHUNK = sliceFn('function makeChunk(');
const SDK = sliceFn('async function streamViaSdk(');
const VOICE_NOTE_SRC = (name) => SRC.slice(SRC.indexOf(`const ${name} =`), SRC.indexOf('\n', SRC.indexOf(`const ${name} =`)) + 1);
const FACE_HELPERS = SRC.slice(SRC.indexOf('function faceMoodFor('), SRC.indexOf('\n}\n', SRC.indexOf('function createVoiceMood(')) + 3);
const { createMoodFilter, createReadTagFilter, FACE_MOOD_NOTE } = L('voice/mood');

function stub() {
  const f = function () { return undefined; };
  return new Proxy(f, { get: (t, k) => (k === 'then' ? undefined : (k === Symbol.toPrimitive ? () => '' : (typeof k === 'symbol' ? undefined : stub()))), apply: () => undefined, construct: () => ({}) });
}
function makeSandbox(explicit) {
  const store = Object.assign(Object.create(null), explicit);
  const px = new Proxy(store, {
    has: () => true,
    get: (t, k) => { if (typeof k === 'symbol') return undefined; if (k in t) return t[k]; if (k in globalThis) return globalThis[k]; t[k] = stub(); return t[k]; },
    set: (t, k, v) => { t[k] = v; return true; },
  });
  vm.createContext(px);
  return px;
}
const fakeRes = () => ({ writableEnded: false, destroyed: false, writeHead() {}, write() { return true; }, end() { this.writableEnded = true; }, on() {} });

function sdkRun({ messages, throwMessage }) {
  const events = [], logs = [];
  const fakeSdk = {
    query({ prompt }) {
      const it = (async function* () {
        await prompt.next();
        for (const m of messages) yield m;
        if (throwMessage) throw new Error(throwMessage);
      })();
      it.getContextUsage = async () => null;
      it.interrupt = async () => {};
      return it;
    },
  };
  const explicit = {
    console: { log() {}, error() {}, warn() {}, info() {} },
    process: { cwd: () => '/tmp/none', env: {}, on() {}, platform: 'linux' },
    sendSSE: (res, ev) => { events.push(ev); return true; },
    sendSSEDone() {}, sendSSEHeartbeat() {}, safeEnd(res) { res.writableEnded = true; },
    appendConversationLog: (agent, role, text, overwrite, meta) => { logs.push({ agent, role, text, meta }); return true; },
    writeAutoMemory: async () => {}, autoDistill: async () => {},
    guardedSave: (a, fn) => { try { fn(); } catch {} },
    setInterval: () => 1, clearInterval() {}, setTimeout: (cb) => { try { cb(); } catch {} return 1; }, clearTimeout() {},
    makeProgressTicker: () => 1,
    HEARTBEAT_INTERVAL_MS: 15000, INCREMENTAL_SAVE_INTERVAL_MS: 3000,
    activeResponses: new Map(), turnRegistry: new Map(),
    ledger: { record() {} }, modelHealth: { record() {} },
    loadSdk: async () => fakeSdk, cliOptions: () => ({}),
    getAgentModel: async () => 'claude-sdk/claude-sonnet-5-5',
    getAgents: async () => [{ name: 'ada', model: 'claude-sdk/claude-sonnet-5-5', minimalContext: true }],
    loadAgentContext: async () => 'Test system',
    timeZoneLib: { zoneForAgent: () => 'UTC', policyText: () => '', localTimeTag: () => '[time]' },
    workerPolicy: { buildRoster: () => [], platformPolicyText: () => '', disallowedToolsFor: () => [], getMode: () => 'off', policyText: () => '' },
    require: (m) => (m === './claude-auth' ? auth : stub()),
    peerAgents: async () => [], visualsTextFor: async () => '', connectorsTextFor: () => '', hubBriefTextFor: async () => '',
    ownerOfAgent: async () => null, adminIdSet: () => new Set(),
    temporalWorkers: { isVirtual: () => false, getVirtual: () => null, sdkDisallowedFor: () => [] },
    records: { maxBytesFor: () => 262144 },
    contextRefresh: { getContextRefresh: () => ({ plan: () => ({ block: '', summary: '', commit() {} }), forget() {} }) },
    promptCounts: new Map(), sdkInterjectChannels: new Map(),
    providerPacing: L('provider-pacing'), errorHelp: L('error-help'),
    paragraphAfterTool: (t) => (t && !/\n\s*$/.test(t) ? '\n\n' : ''),
    activityMeta: (agent, text, extra) => extra,
    SdkWorkerTracker: class { constructor() { this.size = 0; } workerFor() { return null; } drain() { return []; } completeByIds() { return []; } },
    drainInterjections: () => [], interjectionQueues: new Map(),
    getAgentSessionId: () => null, setAgentSessionId() {},
    sdkInterject: { ...L('sdk-interject'), takeUndelivered: () => [], stashUndelivered() {} },
    contextWindow: L('context-window'),
    compaction: { compactedAt: () => null, noteUsage: () => null, settingsFor: () => ({ mode: 'off' }) },
    handsForTurn: async () => ({ mode: 'client', withheld: false, agent: null }),
    sandboxLib: { getSandbox: () => ({ isSandboxed: () => false }) },
    clientWatch: { forTurn: () => ({ spawn: undefined, expectExit() {}, clear() {} }) },
    gate: { sdkHook: () => async () => ({}) },
  };
  const ctx = makeSandbox(explicit);
  ctx.createMoodFilter = createMoodFilter; ctx.createReadTagFilter = createReadTagFilter; ctx.FACE_MOOD_NOTE = FACE_MOOD_NOTE;
  ctx.voiceCall = { onCall: () => true }; ctx.facePacks = { getPack: () => ({ manifest: { clips: [] } }) };
  for (const s of [VOICE_NOTE_SRC('VOICE_NOTE'), VOICE_NOTE_SRC('VOICE_CALL_NOTE'), MAKE_CHUNK, 'function paragraphAfterTool(t){return t&&!/\\n\\s*$/.test(t)?"\\n\\n":"";}', FACE_HELPERS, SDK]) vm.runInContext(s, ctx);
  const abort = new AbortController();
  return { events, logs, exec: () => ctx.streamViaSdk('ada', 'hello there', [], fakeRes(), { signal: abort.signal }) };
}
const textOf = events => events.map(e => (e && e.choices && e.choices[0] && e.choices[0].delta && e.choices[0].delta.content) || '').join('');
const gw = (events, type) => events.filter(e => e && e.gateway && e.gateway.type === type).map(e => e.gateway);
const authAssistant = { type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: SENTENCE }] } };
const errResult = { type: 'result', subtype: 'success', is_error: true, result: SENTENCE, usage: {}, total_cost_usd: 0 };
const assistantRows = s => s.logs.filter(l => l.role === 'assistant');

function assertSignedOutTurn(s, label) {
  const text = textOf(s.events);
  assert.ok(!text.includes('Failed to authenticate'), `${label}: the client's sentence is not shown: ${text}`);
  assert.equal(text.split('Claude is signed out on the computer that runs your Maestro').length - 1, 1, `${label}: the help once`);
  assert.equal(text, auth.SIGN_IN_HELP, `${label}: the help is the whole reply`);
  const ev = gw(s.events, 'claude_signin');
  assert.equal(ev.length, 1, `${label}: one claude_signin event`);
  assert.ok(ev[0].detail.length > 0 && ev[0].detail.length <= 300, label);
  const rows = assistantRows(s);
  assert.ok(rows.length >= 1, label);
  const last = rows[rows.length - 1];
  assert.equal(last.text, auth.SIGN_IN_HELP, `${label}: the saved reply is the help`);
  assert.ok(!last.text.includes('Failed to authenticate'), label);
  assert.equal(last.meta.claudeSignin, true, label);
  assert.ok(last.meta.claudeSigninDetail.length > 0, label);
}

test('turn: a synthetic authentication_failed message then an error result: help once, one event, row marked, the sentence nowhere', async () => {
  const s = sdkRun({ messages: [authAssistant, errResult] });
  await s.exec();
  assertSignedOutTurn(s, 'assistant+result');
  assert.match(gw(s.events, 'claude_signin')[0].detail, /^Failed to authenticate/);
  assert.equal(gw(s.events, 'turn_error').length, 1, 'the typed turn_error is unchanged');
});

test('turn: only the error result (no marked assistant message, the case of the sentence reaching the page): help, not the sentence', async () => {
  const s = sdkRun({ messages: [errResult] });
  await s.exec();
  assertSignedOutTurn(s, 'result only');
});

test('turn: only the marked assistant message (no result follows): the help still comes, once, and the saved row is marked', async () => {
  const s = sdkRun({ messages: [authAssistant] });
  await s.exec();
  assertSignedOutTurn(s, 'assistant only');
});

test('turn: the client crashes after the sign-in sentence: help (saved), no "stopped unexpectedly", still one event', async () => {
  for (const messages of [[authAssistant], []]) {
    const s = sdkRun({ messages, throwMessage: messages.length ? 'Claude Code process exited with code 1' : SENTENCE });
    await s.exec();
    assertSignedOutTurn(s, 'crash');
    assert.ok(!/stopped unexpectedly/.test(textOf(s.events)));
  }
});

test('turn: a sign-in crash sends the claude_signin event and the help only (no turn_error, no session_interrupted)', async () => {
  const s = sdkRun({ messages: [], throwMessage: SENTENCE });
  await s.exec();
  assertSignedOutTurn(s, 'crash only');
  assert.equal(gw(s.events, 'turn_error').length, 0);
  assert.equal(gw(s.events, 'session_interrupted').length, 0);
});

test('turn: the detail in the event and the saved row carries no link, address or long token', async () => {
  const text = 'Failed to authenticate: sign in at https://claude.example/oauth/authorize?code=true&state=abcdefghijklmnopqrstuvwxyz as sam.example@mail.example';
  const msg = { type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text }] } };
  const s = sdkRun({ messages: [msg] });
  await s.exec();
  const ev = gw(s.events, 'claude_signin');
  assert.equal(ev.length, 1);
  assert.match(ev[0].detail, /^Failed to authenticate: sign in at as$/);
  const meta = assistantRows(s).at(-1).meta;
  assert.equal(meta.claudeSigninDetail, ev[0].detail);
  assert.doesNotMatch(JSON.stringify([ev, meta]), /https?:|@|oauth|abcdefghijklmnopqrstuvwxyz/);
});

test('turn: an MCP server\'s 401 in a thrown error is not a Claude sign-in failure', async () => {
  const s = sdkRun({ messages: [], throwMessage: 'MCP server notes failed: 401 Unauthorized (invalid API key)' });
  await s.exec();
  assert.equal(gw(s.events, 'claude_signin').length, 0);
  assert.match(textOf(s.events), /stopped unexpectedly/);
  assert.equal(gw(s.events, 'turn_error').length, 1);
  assert.equal(gw(s.events, 'session_interrupted').length, 1);
  const r = sdkRun({ messages: [{ type: 'result', subtype: 'success', is_error: true, result: '401 Unauthorized from MCP server notes', usage: {} }] });
  await r.exec();
  assert.equal(gw(r.events, 'claude_signin').length, 0);
});

test('turn: any other failure is unchanged (no help, no event, the usual crash sentence)', async () => {
  const s = sdkRun({ messages: [], throwMessage: 'API Error: 529 overloaded' });
  await s.exec();
  assert.match(textOf(s.events), /stopped unexpectedly/);
  assert.equal(gw(s.events, 'claude_signin').length, 0);
  assert.ok(!textOf(s.events).includes('signed out'));
  const r = sdkRun({ messages: [{ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached', usage: {} }] });
  await r.exec();
  assert.equal(gw(r.events, 'claude_signin').length, 0);
});

test('turn: an assistant message without msg.error is never suppressed, even if its text talks about signing in', async () => {
  const ok = { type: 'assistant', message: { content: [{ type: 'text', text: 'Please run /login to try it.' }] } };
  const deltas = [{ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Please run /login to try it.' } } }];
  const s = sdkRun({ messages: [...deltas, ok, { type: 'result', subtype: 'success', is_error: false, result: 'Please run /login to try it.', usage: {} }] });
  await s.exec();
  assert.equal(textOf(s.events), 'Please run /login to try it.');
  assert.equal(gw(s.events, 'claude_signin').length, 0);
  assert.equal(assistantRows(s).at(-1).meta, undefined);
});
