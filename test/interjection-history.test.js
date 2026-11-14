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
const gwSeen = [];   // a copy of the messages each model call was given
gw.chatCompletionStream = async (messages) => { gwSeen.push(JSON.parse(JSON.stringify(messages))); return { fake: gwScripts[gwCalls++] }; };
gw.parseSSEStream = (resp) => resp.fake();
const appServer = L(path.join('codex-cli', 'app-server'));
let codexSession = null;
appServer.CodexAppSession.open = async () => codexSession;

const sdkChat = L('sdk-chat');
const sdkInterject = L('sdk-interject');
const hubEvents = L('hub-events');

const A = { sdk: 'zz_ij_sdk', sdk2: 'zz_ij_sdk_late', eph: 'zz_ij_eph', gw: 'zz_ij_gw', gw2: 'zz_ij_gw_last', cx: 'zz_ij_cx', cx2: 'zz_ij_cx_follow', cx3: 'zz_ij_cx_late',
  img: 'zz_ij_img', imgCarry: 'zz_ij_img_carry', gwv: 'zz_ij_gw_vision', gwn: 'zz_ij_gw_novision', cxi: 'zz_ij_cx_img', cxc: 'zz_ij_cx_carry', hist: 'zz_ij_hist' };
const convDir = path.join(ISO.data, 'conversations');
fs.mkdirSync(convDir, { recursive: true });
fs.writeFileSync(path.join(ISO.data, 'agents.json'), JSON.stringify([
  ...[A.sdk, A.sdk2, A.eph, A.img, A.imgCarry, A.hist].map(name => ({ name, model: 'claude-sdk/claude-sonnet-5-5', displayName: name })),
  ...[A.gw, A.gw2, A.gwv].map(name => ({ name, model: 'openai/gpt-5.5', displayName: name })),
  { name: A.gwn, model: 'perplexity/sonar', displayName: A.gwn },
  ...[A.cx, A.cx2, A.cx3, A.cxi, A.cxc].map(name => ({ name, model: 'codex-cli/gpt-5.6-sol', displayName: name })),
]));
after(() => { for (const a of Object.values(A)) try { fs.unlinkSync(path.join(convDir, `${a}.jsonl`)); } catch {} });

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
function browserRes() { return { writableEnded: false, destroyed: false, written: [], on() {}, writeHead() {}, write(s) { this.written.push(s); return true; }, end() { this.writableEnded = true; } }; }
const gatewayEvents = (res) => res.written.join('').split('\n').filter(l => l.startsWith('data: {')).map(l => { try { return JSON.parse(l.slice(6)).gateway; } catch { return null; } }).filter(Boolean);
const history = (agent) => sdkChat.loadConversationLog(agent, 100);
const ijLines = (agent) => history(agent).filter(e => e.role === 'user' && /INTERJECTION/.test(e.content));
const joined = (agent) => history(agent).filter(e => e.role === 'assistant').map(e => e.content).join('');
const shape = (agent) => history(agent).map(e => [e.role, e.content]);
const send = (agent, message, images) => sdkChat.handleInterjection({ agent, message, ...(images !== undefined ? { images } : {}) });

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

// ── pictures in interjections ────────────────────────────────────────────────────────────────────────────────
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_URL = `data:image/png;base64,${PNG_B64}`;
const JPG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0]).toString('base64');
const JPG_URL = `data:image/jpeg;base64,${JPG_B64}`;
const uploadDir = path.join(ISO.data, 'uploads');
const uploads = () => { try { return fs.readdirSync(uploadDir).sort(); } catch { return []; } };
const underUploads = (p) => typeof p === 'string' && p.startsWith(uploadDir + path.sep) && fs.existsSync(p);

test('handleInterjection: valid pictures are saved and queued with the item; pictures without text are accepted; any invalid one refuses the whole interjection', async () => {
  const agent = A.img;
  let seen = null;
  sdkScript = async function* (prompt) {
    const it = prompt[Symbol.asyncIterator]();
    await it.next();
    yield delta('Looking. ');
    await tick(30);
    const before = uploads();
    const bad = {
      'wrong type': ['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
      'bad bytes': ['data:image/png;base64,' + Buffer.from('this is not an image at all, sorry').toString('base64')],
      'too big': ['data:image/png;base64,iVBORw0KGgo' + 'A'.repeat(14 * 1024 * 1024)],
      'nine pictures': Array(9).fill(PNG_URL),
      'a good one then a bad one': [PNG_URL, 'data:image/png;base64,bm90IGFuIGltYWdl'],
      'not an array': 'oops',
    };
    const refused = {};
    for (const [why, imgs] of Object.entries(bad)) refused[why] = send(agent, 'x', imgs);
    const afterRefused = { files: uploads(), lines: ijLines(agent).length };
    const r1 = send(agent, 'look', [PNG_URL, JPG_URL]);
    const r2 = send(agent, '', [PNG_URL]);
    const noText = sdkChat.handleInterjection({ agent, message: '' });   // neither words nor pictures
    const h = sdkChat.loadConversationLog(agent);
    const turn = hubEvents.events.turnFor(agent);
    const m1 = await it.next();
    yield { type: 'user', isReplay: true, uuid: m1.value.uuid, session_id: 's9' };
    const m2 = await it.next();
    yield { type: 'user', isReplay: true, uuid: m2.value.uuid, session_id: 's9' };
    seen = { before, refused, afterRefused, r1, r2, noText, h, turn, m1: m1.value.message.content, m2: m2.value.message.content };
    yield delta('Seen.');
    yield { type: 'result', subtype: 'success', session_id: 's9', usage: {} };
  };
  await sdkChat.handleChatStream({ agent, message: 'go' }, browserRes());

  assert.ok(seen, 'the script ran');
  for (const [why, r] of Object.entries(seen.refused)) {
    assert.strictEqual(r.success, false, `${why}: refused`);
    assert.match(r.error, /^Interjection not sent: /, `${why}: a clear message`);
  }
  assert.match(seen.refused['wrong type'].error, /interjection\[0\]: data URL must be base64 image\/png/);
  assert.match(seen.refused['bad bytes'].error, /does not contain an image/);
  assert.match(seen.refused['too big'].error, /the limit is 10 MB/);
  assert.match(seen.refused['nine pictures'].error, /too many images: 9 given, at most 8/);
  assert.match(seen.refused['a good one then a bad one'].error, /interjection\[1\]/);
  assert.deepStrictEqual(seen.afterRefused, { files: seen.before, lines: 0 }, 'a refused interjection saves nothing, not even its good pictures, and queues nothing');
  assert.strictEqual(seen.noText.success, false, 'no words and no pictures is still refused');
  assert.strictEqual(seen.r1.success, true);
  assert.strictEqual(seen.r2.success, true, 'pictures without text are accepted');

  const lines = ijLines(agent);
  assert.strictEqual(lines.length, 2, 'only the two accepted interjections have a history line');
  assert.strictEqual(lines[0].images.length, 2);
  assert.ok(lines[0].images.every(underUploads), 'saved in the isolated install\'s data/uploads');
  assert.deepStrictEqual(lines[0].images.map(p => path.extname(p)), ['.png', '.jpg']);
  assert.strictEqual(lines[0].content, '[OPERATOR INTERJECTION]: look');
  assert.strictEqual(lines[1].content, '[OPERATOR INTERJECTION]: ', 'the label line still has content when the words are empty');
  assert.strictEqual(lines[1].images.length, 1);
  assert.ok(seen.h.slice(-2).every(e => Array.isArray(e.images)), 'in the file the moment each is sent');
  const items = seen.turn.activity.filter(a => a.kind === 'interjection');
  assert.strictEqual(items.length, 2, 'the hub\'s turn view holds both, the one without words too');
  assert.deepStrictEqual(items[0].images, lines[0].images);
  assert.strictEqual(items[1].message, '');
  assert.deepStrictEqual(items[1].images, lines[1].images);

  // The Claude route: block content, the image blocks first, then the text.
  assert.ok(Array.isArray(seen.m1));
  assert.deepStrictEqual(seen.m1.map(b => b.type), ['image', 'image', 'text']);
  assert.strictEqual(seen.m1[0].source.media_type, 'image/png');
  assert.strictEqual(seen.m1[0].source.data, PNG_B64);
  assert.strictEqual(seen.m1[1].source.media_type, 'image/jpeg');
  assert.strictEqual(seen.m1[2].text, sdkInterject.INTERJECTION_PREFIX + 'look');
  assert.deepStrictEqual(seen.m2.map(b => b.type), ['image', 'text']);
  assert.strictEqual(seen.m2[1].text, sdkInterject.INTERJECTION_PREFIX);
});

test('history: a normal message sent with pictures keeps their paths on its line; one without has no images key', async () => {
  const agent = A.hist;
  sdkScript = async function* (prompt) {
    const it = prompt[Symbol.asyncIterator]();
    await it.next();
    yield delta('Ok.');
    yield { type: 'result', subtype: 'success', session_id: 's10', usage: {} };
  };
  await sdkChat.handleChatStream({ agent, message: 'see this', images: [PNG_URL] }, browserRes());
  await sdkChat.handleChatStream({ agent, message: 'and no picture' }, browserRes());
  const users = history(agent).filter(e => e.role === 'user');
  assert.strictEqual(users[0].content, 'see this');
  assert.strictEqual(users[0].images.length, 1);
  assert.ok(underUploads(users[0].images[0]));
  assert.ok(!('images' in users[1]));
});

test('sdk-live carry: a picture sent as the turn ended is added to the next turn\'s pictures, and the carried text names it', async () => {
  const agent = A.imgCarry;
  sdkScript = async function* (prompt) {
    const it = prompt[Symbol.asyncIterator]();
    await it.next();
    yield delta('All done.');
    send(agent, 'one more thing', [PNG_URL]);   // too late: the SDK never takes it before the stream ends
    yield { type: 'result', subtype: 'success', session_id: 's11', usage: {} };
  };
  await sdkChat.handleChatStream({ agent, message: 'go' }, browserRes());
  const stashed = sdkInterject.peekUndelivered(agent);
  assert.strictEqual(stashed.length, 1);
  assert.ok(underUploads(stashed[0].images[0]), 'the stash keeps the picture path');
  let first = null;
  sdkScript = async function* (prompt) {
    const it = prompt[Symbol.asyncIterator]();
    first = (await it.next()).value.message.content;
    yield delta('Got it.');
    yield { type: 'result', subtype: 'success', session_id: 's12', usage: {} };
  };
  await sdkChat.handleChatStream({ agent, message: 'next question' }, browserRes());
  assert.ok(Array.isArray(first), 'the next turn goes as blocks');
  assert.strictEqual(first[0].type, 'image');
  assert.strictEqual(first[0].source.data, PNG_B64);
  assert.match(first[first.length - 1].text, /one more thing \[1 picture attached/);
  assert.match(first[first.length - 1].text, /next question$/);
  assert.deepStrictEqual(sdkInterject.takeUndelivered(agent), [], 'taken');
});

// ── gateway: image_url parts for a vision model, a notice for one without ───────────────────────────────────
test('gateway: an interjection with pictures is pushed as image_url parts then the text when the model can see', async () => {
  const agent = A.gwv;
  gwCalls = 0; gwSeen.length = 0;
  gwScripts = [
    async function* () { yield txt('Checking. '); await tick(30); send(agent, 'hurry', [PNG_URL]); yield readMemoryCall; },
    async function* () { yield txt('Done.'); yield stop; },
  ];
  const res = browserRes();
  await sdkChat.handleChatStream({ agent, message: 'go' }, res);
  assert.strictEqual(gwSeen.length, 2);
  const m = gwSeen[1].filter(x => x.role === 'user').pop();
  assert.ok(Array.isArray(m.content), 'block content');
  assert.deepStrictEqual(m.content.map(p => p.type), ['image_url', 'text']);
  assert.strictEqual(m.content[0].image_url.url, PNG_URL);
  assert.strictEqual(m.content[1].text, '[OPERATOR INTERJECTION]: hurry');
  assert.ok(ijLines(agent)[0].images.every(underUploads), 'the history line has the pictures');
  assert.ok(gatewayEvents(res).some(e => e.type === 'interjection_received' && e.message === 'hurry'));
});

test('gateway: a model without vision gets the text with a line about the pictures, and the page gets the usual notice', async () => {
  const agent = A.gwn;
  gwCalls = 0; gwSeen.length = 0;
  gwScripts = [
    async function* () { yield txt('Checking. '); await tick(30); send(agent, 'hurry', [PNG_URL, JPG_URL]); yield readMemoryCall; },
    async function* () { yield txt('Done.'); yield stop; },
  ];
  const res = browserRes();
  await sdkChat.handleChatStream({ agent, message: 'go' }, res);
  const m = gwSeen[1].filter(x => x.role === 'user').pop();
  assert.strictEqual(typeof m.content, 'string', 'plain text: no picture parts for a model that cannot see');
  assert.match(m.content, /^\[OPERATOR INTERJECTION\]: hurry\n\(The operator attached 2 pictures that this model cannot see\.\)$/);
  assert.match(res.written.join(''), /2 image\(s\) removed — model `[^`]*perplexity\/sonar[^`]*` does not support vision/);
});

// ── Codex: a picture is not steered; it runs in the follow-up round as a turn image ─────────────────────────
test('codex steer: an interjection with a picture stays queued for the follow-up round (turnImages), the text one is steered, the page is told', async () => {
  const agent = A.cxi;
  const steered = [];
  let round2 = null;
  codexSession = fakeCodex({
    steer: async (text, n) => { steered.push(text); return { ok: true, clientId: `c${n}` }; },
    turns: [
      async ({ onAction, onStarted }) => {
        onStarted && onStarted();
        onAction({ kind: 'text_begin', id: 'm1' });
        onAction({ kind: 'text', text: 'Working. ', delta: true });
        await tick(30);
        send(agent, 'what is in this', [PNG_URL]);
        await tick(30);
        send(agent, 'and hurry');
        await tick(30);
        onAction({ kind: 'user_message', id: 'u1', clientId: 'c1', text: '[OPERATOR INTERJECTION]: and hurry' });
        return { status: 'completed' };
      },
      async (o) => { round2 = o.input; o.onAction({ kind: 'text_begin', id: 'm2' }); o.onAction({ kind: 'text', text: 'A cat.', delta: true }); return { status: 'completed' }; },
    ],
  });
  const res = browserRes();
  await sdkChat.handleChatStream({ agent, message: 'go' }, res);
  assert.deepStrictEqual(steered, ['[OPERATOR INTERJECTION]: and hurry'], 'only the text interjection was steered');
  assert.ok(round2, 'a follow-up round ran');
  assert.deepStrictEqual(round2.map(i => i.type), ['text', 'localImage']);
  assert.match(round2[0].text, /\[OPERATOR INTERJECTION\]: what is in this/);
  assert.ok(underUploads(round2[1].path), 'the saved picture path is the follow-up turn\'s image');
  const ev = gatewayEvents(res);
  const note = ev.find(e => e.type === 'interjection_deferred' && e.note);
  assert.ok(note, 'the page is told');
  assert.match(note.note, /the picture reaches the agent right after its current step/);
  assert.strictEqual(note.count, 1);
  assert.ok(ev.some(e => e.type === 'interjection_received' && e.message === 'what is in this'), 'and later that it was received');
  const lines = ijLines(agent);
  assert.strictEqual(lines.length, 2);
  assert.ok(lines.find(l => l.content.endsWith('what is in this')).images.every(underUploads), 'the history line carries the pictures');
  assert.ok(!('images' in lines.find(l => l.content.endsWith('and hurry'))));
});

test('codex carry: a picture sent as the turn was stopped goes with the next turn\'s images', async () => {
  const agent = A.cxc;
  codexSession = fakeCodex({
    steer: async () => ({ ok: true, clientId: 'c' }),
    turns: [async ({ onAction, onStarted }) => {
      onStarted && onStarted();
      onAction({ kind: 'text_begin', id: 'm1' });
      onAction({ kind: 'text', text: 'Stopping.', delta: true });
      await tick(30);
      send(agent, 'wait, this picture', [PNG_URL]);
      await tick(30);
      return { status: 'interrupted' };
    }],
  });
  await sdkChat.handleChatStream({ agent, message: 'go' }, browserRes());
  const stashed = sdkInterject.peekUndelivered(agent);
  assert.strictEqual(stashed.length, 1);
  assert.ok(underUploads(stashed[0].images[0]));
  let input = null;
  codexSession = fakeCodex({ steer: async () => ({ ok: true, clientId: 'c' }), turns: [async (o) => { input = o.input; return { status: 'completed' }; }] });
  await sdkChat.handleChatStream({ agent, message: 'next one' }, browserRes());
  assert.deepStrictEqual(input.map(i => i.type), ['text', 'localImage']);
  assert.match(input[0].text, /wait, this picture \[1 picture attached/);
  assert.strictEqual(input[1].path, stashed[0].images[0]);
});
