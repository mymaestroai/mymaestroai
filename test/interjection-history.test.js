'use strict';
// A message sent while the agent is mid-reply (POST /api/chat/interject) stays in the chat history, in its place.
// Before: the Claude and Codex routes wrote it only at turn end (so a page that redrew from history mid-turn lost it),
// and the gateway route wrote it at drain time but the next progress save then wrote the whole reply again.
// Now queueInterjection writes the one line when it is sent; the reply goes on after it as a new piece; nothing at the
// turn's end writes it again. Each route is driven for real (the real handleChatStream), with the model stood in for:
// a fake Claude SDK (sdk-live), a fake gateway stream (tool loop) and a fake Codex app-server session (steer, follow-up).
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// lib/ comes from a throwaway install, so nothing under the real data/ is touched.
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('interjection-history-iso-');
const L = (p) => require(path.join(ISO.lib, p));
// No model discovery (it would start the real Claude client and call out): an empty answer, at once.
L('model-discovery').runDiscovery = async () => ({});
// The model stand-ins go in before sdk-chat is loaded (it takes these functions by name when it loads).
const loader = L('sdk-loader');
let sdkScript = null;
loader.loadSdk = async () => ({
  query: ({ prompt }) => sdkScript(prompt),
  tool: (name, desc, schema, fn) => ({ name, fn }),
  createSdkMcpServer: (o) => ({ type: 'sdk', name: o.name, instance: {} }),
});
const gw = L('gateway-client');
let gwScripts = [];
let gwCalls = 0;
gw.chatCompletionStream = async () => ({ fake: gwScripts[gwCalls++] });
gw.parseSSEStream = (resp) => resp.fake();
const appServer = L(path.join('codex-cli', 'app-server'));
let codexSession = null;
appServer.CodexAppSession.open = async () => codexSession;

const sdkChat = L('sdk-chat');
const sdkInterject = L('sdk-interject');
const hubEvents = L('hub-events');

const A = { sdk: 'zz_ij_sdk', sdk2: 'zz_ij_sdk_late', eph: 'zz_ij_eph', gw: 'zz_ij_gw', gw2: 'zz_ij_gw_last', cx: 'zz_ij_cx', cx2: 'zz_ij_cx_follow', cx3: 'zz_ij_cx_late' };
const convDir = path.join(ISO.data, 'conversations');
fs.mkdirSync(convDir, { recursive: true });
fs.writeFileSync(path.join(ISO.data, 'agents.json'), JSON.stringify([
  ...[A.sdk, A.sdk2, A.eph].map(name => ({ name, model: 'claude-sdk/claude-sonnet-5-5', displayName: name })),
  ...[A.gw, A.gw2].map(name => ({ name, model: 'openai/gpt-5.5', displayName: name })),
  ...[A.cx, A.cx2, A.cx3].map(name => ({ name, model: 'codex-cli/gpt-5.6-sol', displayName: name })),
]));
after(() => { for (const a of Object.values(A)) try { fs.unlinkSync(path.join(convDir, `${a}.jsonl`)); } catch {} });

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
function browserRes() { return { writableEnded: false, destroyed: false, written: [], on() {}, writeHead() {}, write(s) { this.written.push(s); return true; }, end() { this.writableEnded = true; } }; }
const gatewayEvents = (res) => res.written.join('').split('\n').filter(l => l.startsWith('data: {')).map(l => { try { return JSON.parse(l.slice(6)).gateway; } catch { return null; } }).filter(Boolean);
const history = (agent) => sdkChat.loadConversationLog(agent, 100);
const ijLines = (agent) => history(agent).filter(e => e.role === 'user' && /INTERJECTION/.test(e.content));
const joined = (agent) => history(agent).filter(e => e.role === 'assistant').map(e => e.content).join('');
const shape = (agent) => history(agent).map(e => [e.role, e.content]);
const send = (agent, message) => sdkChat.handleInterjection({ agent, message });

// ── the Claude route (sdk-live) ──────────────────────────────────────────────────────────────────────────────
const delta = (t) => ({ type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });

test('sdk-live: the interjection is in the history the moment it is sent, in its place, once; the turn end writes nothing more', async () => {
  const agent = A.sdk;
  let during = null;
  sdkScript = async function* (prompt) {
    const it = prompt[Symbol.asyncIterator]();
    await it.next();
    yield delta('Hello. ');
    await tick(30);
    const r = send(agent, 'hurry');
    assert.strictEqual(r.transport, 'sdk-live');
    // mid-turn: what GET /api/history/<agent> would answer, and the hub's view of the running turn
    const h = sdkChat.loadConversationLog(agent);
    hubEvents.markInProgress(h, hubEvents.events.turnFor(agent));
    during = { h, turn: hubEvents.events.turnFor(agent) };
    const m = await it.next();
    yield { type: 'user', isReplay: true, uuid: m.value.uuid, session_id: 's1' };
    yield delta('Faster.');
    yield { type: 'result', subtype: 'success', session_id: 's1', usage: {} };
  };
  const res = browserRes();
  await sdkChat.handleChatStream({ agent, message: 'go' }, res);

  assert.ok(during, 'the script ran');
  assert.deepStrictEqual(during.h.map(e => [e.role, e.content]), [['user', 'go'], ['assistant', 'Hello. '], ['user', '[OPERATOR INTERJECTION]: hurry']], 'in the file while the turn runs');
  assert.strictEqual(during.h[2].interjection.transport, 'sdk-live');
  assert.match(during.h[2].interjection.id, /^ij-/);
  assert.deepStrictEqual(during.h.map(e => !!e.inProgress), [false, true, true], 'the turn\'s lines are flagged while it runs: the reply piece and the interjection');
  const item = during.turn.activity.find(a => a.kind === 'interjection');
  assert.ok(item, 'the hub\'s turn view holds the interjection for a page that re-attaches');
  assert.strictEqual(item.message, 'hurry');
  assert.strictEqual(item.at, 'Hello. '.length, 'at the point of the reply where it came');

  assert.deepStrictEqual(shape(agent), [['user', 'go'], ['assistant', 'Hello. '], ['user', '[OPERATOR INTERJECTION]: hurry'], ['assistant', 'Faster.']]);
  assert.strictEqual(history(agent)[3].base, 7);
  assert.strictEqual(joined(agent), 'Hello. Faster.', 'no text twice');
  assert.strictEqual(ijLines(agent).length, 1, 'one line for the interjection: nothing at the turn end');
  assert.ok(!history(agent).some(e => /delivered mid-session/.test(e.content)));
  assert.ok(gatewayEvents(res).some(e => e.type === 'interjection_received' && e.message === 'hurry'), 'the page still hears it was received');
  assert.strictEqual(hubEvents.markInProgress(sdkChat.loadConversationLog(agent), hubEvents.events.turnFor(agent)).some(e => e.inProgress), false, 'nothing is flagged once the turn is over');
});

test('sdk-live: an interjection not delivered in time keeps its line, is stashed for the next turn, and the page is told', async () => {
  const agent = A.sdk2;
  sdkScript = async function* (prompt) {
    const it = prompt[Symbol.asyncIterator]();
    await it.next();
    yield delta('All done.');
    send(agent, 'one more thing');   // too late: the SDK never takes it before the stream ends
    yield { type: 'result', subtype: 'success', session_id: 's2', usage: {} };
  };
  const res = browserRes();
  await sdkChat.handleChatStream({ agent, message: 'go' }, res);
  assert.deepStrictEqual(shape(agent), [['user', 'go'], ['assistant', 'All done.'], ['user', '[OPERATOR INTERJECTION]: one more thing']], 'the one line is there, after the reply it came too late for');
  assert.ok(!history(agent).some(e => /not delivered in time/.test(e.content)), 'no second line at the turn end');
  assert.ok(gatewayEvents(res).some(e => e.type === 'interjection_deferred' && e.count === 1), 'the page is told as before');
  const carried = sdkInterject.takeUndelivered(agent);
  assert.deepStrictEqual(carried.map(c => c.message), ['one more thing'], 'the next turn carries it as before');
});

test('an interjection to an ephemeral (consulted) turn is not logged, as before', async () => {
  const agent = A.eph;
  sdkScript = async function* (prompt) {
    const it = prompt[Symbol.asyncIterator]();
    await it.next();
    yield delta('Answer. ');
    await tick(30);
    send(agent, 'side note');
    const m = await it.next();
    yield { type: 'user', isReplay: true, uuid: m.value.uuid, session_id: 's3' };
    yield delta('More.');
    yield { type: 'result', subtype: 'success', session_id: 's3', usage: {} };
  };
  const res = browserRes();
  await sdkChat.handleChatStream({ agent, message: 'go', ephemeral: true }, res);
  assert.deepStrictEqual(history(agent), [], 'an ephemeral turn keeps no history, interjection included');
});

// ── the gateway route (tool loop) ───────────────────────────────────────────────────────────────────────────
const txt = (t) => ({ choices: [{ delta: { content: t } }] });
const readMemoryCall = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_memory', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] };
const stop = { choices: [{ delta: {}, finish_reason: 'stop' }] };

test('gateway: an interjection drained into the tool loop stays in place, and the reply continues after it without repeating text', async () => {
  const agent = A.gw;
  let during = null;
  gwCalls = 0;
  gwScripts = [
    async function* () {
      yield txt('Checking. ');
      await tick(30);
      const r = send(agent, 'hurry');
      assert.strictEqual(r.transport, 'gateway-loop');
      during = sdkChat.loadConversationLog(agent);
      yield readMemoryCall;
    },
    async function* () { yield txt('Done.'); yield stop; },
  ];
  const res = browserRes();
  await sdkChat.handleChatStream({ agent, message: 'go' }, res);
  assert.deepStrictEqual(during.map(e => [e.role, e.content]), [['user', 'go'], ['assistant', 'Checking. '], ['user', '[OPERATOR INTERJECTION]: hurry']], 'in the file the moment it is sent, after the text it interrupted');
  const h = history(agent);
  assert.deepStrictEqual(h.map(e => e.role), ['user', 'assistant', 'user', 'assistant']);
  assert.strictEqual(h[1].content, 'Checking. ');
  assert.strictEqual(h[3].base, 'Checking. '.length);
  assert.strictEqual(joined(agent), 'Checking. \n\nDone.', 'the whole reply once: the text before the interjection is not written again');
  assert.strictEqual(ijLines(agent).length, 1);
  assert.ok(gatewayEvents(res).some(e => e.type === 'interjection_received' && e.message === 'hurry'));
});

test('gateway: an interjection that arrives after the last model call is logged once, in place, and not again at the turn end', async () => {
  const agent = A.gw2;
  gwCalls = 0;
  gwScripts = [async function* () {
    yield txt('Final answer.');
    await tick(30);
    send(agent, 'too late for the loop');
    yield stop;
  }];
  const res = browserRes();
  await sdkChat.handleChatStream({ agent, message: 'go' }, res);
  assert.deepStrictEqual(shape(agent), [['user', 'go'], ['assistant', 'Final answer.'], ['user', '[OPERATOR INTERJECTION]: too late for the loop']]);
  assert.ok(!history(agent).some(e => /delivered after turn ended/.test(e.content)), 'the leftover write at the turn end is gone');
});

// ── the Codex route (app-server: steer, follow-up turn) ─────────────────────────────────────────────────────
function fakeCodex({ steer, turns }) {
  let n = 0, round = 0;
  return {
    steerable: true,
    openThread: async () => ({ threadId: 'th1', resumed: false }),
    steer: async (text) => steer(text, ++n),
    close() {},
    runTurn: async (o) => turns[round++](o),
  };
}

test('codex steer: the interjection is in the history when sent, in its place, once', async () => {
  const agent = A.cx;
  let during = null;
  codexSession = fakeCodex({
    steer: async (text, n) => ({ ok: true, clientId: `c${n}` }),
    turns: [async ({ onAction, onStarted }) => {
      onStarted && onStarted();
      onAction({ kind: 'text_begin', id: 'm1' });
      onAction({ kind: 'text', text: 'Working. ', delta: true });
      await tick(30);
      const r = send(agent, 'hurry');
      assert.strictEqual(r.transport, 'codex-steer');
      during = sdkChat.loadConversationLog(agent);
      await tick(30);
      onAction({ kind: 'user_message', id: 'u1', clientId: 'c1', text: '[OPERATOR INTERJECTION]: hurry' });
      onAction({ kind: 'text', text: 'Faster.', delta: true });
      return { status: 'completed' };
    }],
  });
  const res = browserRes();
  await sdkChat.handleChatStream({ agent, message: 'go' }, res);
  assert.deepStrictEqual(during.map(e => [e.role, e.content]), [['user', 'go'], ['assistant', 'Working. '], ['user', '[OPERATOR INTERJECTION]: hurry']]);
  assert.deepStrictEqual(shape(agent), [['user', 'go'], ['assistant', 'Working. '], ['user', '[OPERATOR INTERJECTION]: hurry'], ['assistant', 'Faster.']]);
  assert.strictEqual(history(agent)[3].base, 9);
  assert.strictEqual(joined(agent), 'Working. Faster.');
  assert.strictEqual(ijLines(agent).length, 1);
  assert.ok(!history(agent).some(e => /delivered mid-turn/.test(e.content)), 'no second line at the turn end');
  assert.ok(gatewayEvents(res).some(e => e.type === 'interjection_received' && e.message === 'hurry'));
});

test('codex follow-up turn: a steer that is refused runs as a follow-up turn; the interjection is logged once, in place', async () => {
  const agent = A.cx2;
  codexSession = fakeCodex({
    steer: async () => ({ ok: false, refused: true, error: 'expected active turn id' }),
    turns: [
      async ({ onAction, onStarted }) => {
        onStarted && onStarted();
        onAction({ kind: 'text_begin', id: 'm1' });
        onAction({ kind: 'text', text: 'Working. ', delta: true });
        await tick(30);
        send(agent, 'also check the logs');
        await tick(30);
        return { status: 'completed' };
      },
      async ({ onAction }) => {
        onAction({ kind: 'text_begin', id: 'm2' });
        onAction({ kind: 'text', text: 'Checked the logs.', delta: true });
        return { status: 'completed' };
      },
    ],
  });
  const res = browserRes();
  await sdkChat.handleChatStream({ agent, message: 'go' }, res);
  const h = history(agent);
  assert.deepStrictEqual(h.map(e => e.role), ['user', 'assistant', 'user', 'assistant']);
  assert.strictEqual(h[2].content, '[OPERATOR INTERJECTION]: also check the logs');
  assert.strictEqual(h[1].content, 'Working. ');
  assert.strictEqual(h[3].base, 'Working. '.length);
  assert.ok(joined(agent).startsWith('Working. ') && joined(agent).endsWith('Checked the logs.'));
  assert.strictEqual(joined(agent).split('Working. ').length, 2, 'the first text once');
  assert.strictEqual(ijLines(agent).length, 1);
  assert.ok(!history(agent).some(e => /delivered as a follow-up turn/.test(e.content)));
  assert.ok(gatewayEvents(res).some(e => e.type === 'interjection_received' && e.message === 'also check the logs'));
});

test('codex: an interjection that never reached the turn keeps its one line, is stashed, and the page is told', async () => {
  const agent = A.cx3;
  codexSession = fakeCodex({
    steer: async () => ({ ok: false, refused: true, error: 'expected active turn id' }),
    turns: [async ({ onAction, onStarted }) => {
      onStarted && onStarted();
      onAction({ kind: 'text_begin', id: 'm1' });
      onAction({ kind: 'text', text: 'Stopping.', delta: true });
      await tick(30);
      send(agent, 'wait, one thing');
      await tick(30);
      return { status: 'interrupted' };   // the turn was stopped: no follow-up round
    }],
  });
  const res = browserRes();
  await sdkChat.handleChatStream({ agent, message: 'go' }, res);
  assert.deepStrictEqual(shape(agent), [['user', 'go'], ['assistant', 'Stopping.'], ['user', '[OPERATOR INTERJECTION]: wait, one thing']]);
  assert.ok(!history(agent).some(e => /not delivered in time/.test(e.content)), 'no second line at the turn end');
  assert.ok(gatewayEvents(res).some(e => e.type === 'interjection_deferred' && e.count === 1));
  assert.deepStrictEqual(sdkInterject.takeUndelivered(agent).map(c => c.message), ['wait, one thing']);
});
