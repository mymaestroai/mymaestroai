'use strict';
// Review round 1 fixes for interjections in the history (BF1): a failed history write is retried, never lost (2);
// the POST answer and the turn-view item carry the interjection id (4); a tool row is not saved twice around an
// interjection (5); the tools that follow an interjection with no more text are still saved (6).
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// lib/ comes from a throwaway install, so nothing under the real data/ is touched.
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('interjection-bf1-iso-');
const L = (p) => require(path.join(ISO.lib, p));
L('model-discovery').runDiscovery = async () => ({});
const loader = L('sdk-loader');
let sdkScript = null;
loader.loadSdk = async () => ({
  query: ({ prompt }) => sdkScript(prompt),
  tool: (name, desc, schema, fn) => ({ name, fn }),
  createSdkMcpServer: (o) => ({ type: 'sdk', name: o.name, instance: {} }),
});
// a fake gateway stream (the tool loop), set before sdk-chat is loaded (it takes these functions by name when it loads)
const gwClient = L('gateway-client');
let gwScripts = [];
let gwCalls = 0;
gwClient.chatCompletionStream = async () => ({ fake: gwScripts[gwCalls++] });
gwClient.parseSSEStream = (resp) => resp.fake();
const sdkChat = L('sdk-chat');
const hubEvents = L('hub-events');

const A = { retryNext: 'zz_bf1_retry_next', retryEnd: 'zz_bf1_retry_end', pieces: 'zz_bf1_pieces', tail: 'zz_bf1_tail', idAgent: 'zz_bf1_id', toolSdk: 'zz_bf1_tool_sdk', toolPlain: 'zz_bf1_tool_plain', toolGw: 'zz_bf1_tool_gw', runOne: 'zz_bf1_run_one', runTwo: 'zz_bf1_run_two', runGw: 'zz_bf1_run_gw' };
const convDir = path.join(ISO.data, 'conversations');
fs.mkdirSync(convDir, { recursive: true });
fs.writeFileSync(path.join(ISO.data, 'agents.json'), JSON.stringify([
  ...[A.retryNext, A.retryEnd, A.idAgent, A.toolSdk, A.toolPlain, A.runOne, A.runTwo].map(name => ({ name, model: 'claude-sdk/claude-sonnet-5-5', displayName: name })),
  { name: A.toolGw, model: 'openai/gpt-5.5', displayName: A.toolGw },
  { name: A.runGw, model: 'openai/gpt-5.5', displayName: A.runGw },
]));
after(() => { for (const a of Object.values(A)) try { fs.writeFileSync(path.join(convDir, `${a}.jsonl`), ''); } catch {} });

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
function browserRes() { return { writableEnded: false, destroyed: false, written: [], on() {}, writeHead() {}, write(s) { this.written.push(s); return true; }, end() { this.writableEnded = true; } }; }
const delta = (t) => ({ type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
const history = (agent) => sdkChat.loadConversationLog(agent, 100);
const ijLines = (agent) => history(agent).filter(e => e.role === 'user' && e.interjection);
const PNG_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// fs.writeSync throws once (a full disk that clears) for the first chat line holding an interjection's text; the
// chat code is the only caller of fs.writeSync directly for chat lines.
function failOneWrite() {
  const orig = fs.writeSync;
  let failed = false;
  fs.writeSync = function (fd, buf, off, len, pos) {
    if (!failed && Buffer.isBuffer(buf) && buf.toString('utf8').includes('OPERATOR INTERJECTION')) { failed = true; const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e; }
    return orig.call(this, fd, buf, off, len, pos);
  };
  return { restore: () => { fs.writeSync = orig; } };
}

test('BF1-2: an interjection whose history write failed is written at the next save, once, with its id and pictures', async () => {
  const agent = A.retryNext;
  let first = null, second = null, failed = null;
  sdkScript = async function* (prompt) {
    const it = prompt[Symbol.asyncIterator]();
    await it.next();
    yield delta('Hello. ');
    await tick(30);
    // the reply so far is saved by the flush; the interjection's own write fails
    const flaky = failOneWrite();
    try { first = sdkChat.handleInterjection({ agent, message: 'hurry', images: [PNG_URL] }); } finally { flaky.restore(); }
    failed = ijLines(agent).length;
    const m1 = await it.next();
    yield { type: 'user', isReplay: true, uuid: m1.value.uuid, session_id: 's1' };
    yield delta('Faster.');
    await tick(30);
    second = sdkChat.handleInterjection({ agent, message: 'again' });   // its flush is a progress save: the retry happens there
    const m2 = await it.next();
    yield { type: 'user', isReplay: true, uuid: m2.value.uuid, session_id: 's1' };
    yield { type: 'result', subtype: 'success', session_id: 's1', usage: {} };
  };
  await sdkChat.handleChatStream({ agent, message: 'go' }, browserRes());
  assert.ok(first && first.success && /^ij-/.test(first.id), 'the POST answer carries the interjection id');
  assert.strictEqual(failed, 0, 'the write really failed');
  const lines = ijLines(agent);
  assert.strictEqual(lines.length, 2, 'the failed one was written once, and the later one');
  const one = lines.find(e => e.interjection.id === first.id);
  assert.ok(one, 'with the right id');
  assert.strictEqual(one.content, '[OPERATOR INTERJECTION]: hurry');
  assert.strictEqual(one.images.length, 1, 'with its picture');
  assert.ok(fs.existsSync(one.images[0]) && one.images[0].startsWith(path.join(ISO.data, 'uploads')));
  assert.ok(lines.some(e => e.interjection.id === second.id));
  assert.strictEqual(history(agent).filter(e => e.role === 'assistant').map(e => e.content).join(''), 'Hello. Faster.', 'no reply text lost or doubled');
});

test('BF1-2: with no later progress save, the turn\'s end writes it (after the final assistant save)', async () => {
  const agent = A.retryEnd;
  let sent = null;
  sdkScript = async function* (prompt) {
    const it = prompt[Symbol.asyncIterator]();
    await it.next();
    yield delta('Hello. ');
    await tick(30);
    const flaky = failOneWrite();
    try { sent = sdkChat.handleInterjection({ agent, message: 'hurry' }); } finally { flaky.restore(); }
    const m = await it.next();
    yield { type: 'user', isReplay: true, uuid: m.value.uuid, session_id: 's1' };
    yield delta('Faster.');
    yield { type: 'result', subtype: 'success', session_id: 's1', usage: {} };
  };
  await sdkChat.handleChatStream({ agent, message: 'go' }, browserRes());
  const lines = ijLines(agent);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].interjection.id, sent.id);
  const h = history(agent);
  assert.strictEqual(h.filter(e => e.role === 'assistant').map(e => e.content).join(''), 'Hello. Faster.');
  assert.strictEqual(h[h.length - 1].interjection.id, sent.id, 'it lands after the final save: later than its place, never dropped');
});

test('BF1-4: the turn view\'s interjection item carries the interjection id (ijId)', async () => {
  const agent = A.idAgent;
  let sent = null, item = null;
  sdkScript = async function* (prompt) {
    const it = prompt[Symbol.asyncIterator]();
    await it.next();
    yield delta('Hello. ');
    await tick(30);
    sent = sdkChat.handleInterjection({ agent, message: 'hurry' });
    item = hubEvents.events.turnFor(agent).activity.find(a => a.kind === 'interjection');
    const m = await it.next();
    yield { type: 'user', isReplay: true, uuid: m.value.uuid, session_id: 's1' };
    yield { type: 'result', subtype: 'success', session_id: 's1', usage: {} };
  };
  await sdkChat.handleChatStream({ agent, message: 'go' }, browserRes());
  assert.ok(sent.id && item);
  assert.strictEqual(item.ijId, sent.id);
});

// ── pieces: saved straight through appendConversationLog ─────────────────────────────────────────────────────
const ijMeta = (id) => ({ interjection: { id, transport: 'sdk-live' } });

test('BF1-5: a tool row at the piece boundary is saved once (piece 1); one that starts right after the flush stays in piece 2', () => {
  const agent = A.pieces;
  const t1 = { id: 'a1', kind: 'tool', tool: 'Bash', status: 'done', at: 5 };      // at == the length of piece 1: saved with piece 1
  const t2 = { id: 'a2', kind: 'tool', tool: 'Read', status: 'done', at: 5 };      // started after the flush at the same length: piece 2's
  const t3 = { id: 'a3', kind: 'tool', tool: 'Grep', status: 'done', at: 9 };
  sdkChat.appendConversationLog(agent, 'user', 'go');
  sdkChat.appendConversationLog(agent, 'assistant', 'Hello', false, { activity: [t1] });
  sdkChat.appendConversationLog(agent, 'user', '[OPERATOR INTERJECTION]: hurry', false, ijMeta('ij-p'));
  sdkChat.appendConversationLog(agent, 'assistant', 'HelloMore!', true, { activity: [t1, t2, t3] });
  let h = history(agent);
  assert.strictEqual(h.length, 4);
  assert.deepStrictEqual(h[1].activity.map(a => a.id), ['a1']);
  assert.strictEqual(h[3].base, 5);
  assert.deepStrictEqual(h[3].activity.map(a => [a.id, a.at]), [['a2', 0], ['a3', 4]], 'a1 is not saved again');
  // a progress save that replaced piece 2 first, then the final save: the same result
  sdkChat.appendConversationLog(agent, 'assistant', 'HelloMore! And', true);
  sdkChat.appendConversationLog(agent, 'assistant', 'HelloMore! And on.', true, { activity: [t1, t2, t3] });
  h = history(agent);
  assert.strictEqual(h.length, 4);
  assert.strictEqual(h[3].content, 'More! And on.');
  assert.deepStrictEqual(h[3].activity.map(a => a.id), ['a2', 'a3']);
});

test('BF1-6: tools after an interjection with no more text are saved with an empty-text piece; nothing new writes nothing', () => {
  const agent = A.tail;
  const t1 = { id: 'b1', kind: 'tool', tool: 'Bash', status: 'done', at: 5 };
  const t2 = { id: 'b2', kind: 'tool', tool: 'Read', status: 'done', at: 5 };
  sdkChat.appendConversationLog(agent, 'user', 'go');
  sdkChat.appendConversationLog(agent, 'assistant', 'Hello', false, { activity: [t1] });
  sdkChat.appendConversationLog(agent, 'user', '[OPERATOR INTERJECTION]: hurry', false, ijMeta('ij-t'));
  // the text did not grow; only a tool ran after the interjection
  sdkChat.appendConversationLog(agent, 'assistant', 'Hello', true, { activity: [t1, t2] });
  let h = history(agent);
  assert.strictEqual(h.length, 4, 'the tool row is not lost');
  assert.strictEqual(h[3].role, 'assistant');
  assert.strictEqual(h[3].content, '');
  assert.strictEqual(h[3].base, 5);
  assert.deepStrictEqual(h[3].activity.map(a => [a.id, a.at]), [['b2', 0]]);
  // no text and no new tool rows (everything already in the previous piece): still nothing written
  const agent2 = A.tail + '_2';
  sdkChat.appendConversationLog(agent2, 'user', 'go');
  sdkChat.appendConversationLog(agent2, 'assistant', 'Hello', false, { activity: [t1] });
  sdkChat.appendConversationLog(agent2, 'user', '[OPERATOR INTERJECTION]: hurry', false, ijMeta('ij-u'));
  sdkChat.appendConversationLog(agent2, 'assistant', 'Hello', true, { activity: [t1] });
  assert.strictEqual(history(agent2).length, 3);
  fs.writeFileSync(path.join(convDir, `${agent2}.jsonl`), '');
});

// ── tool rows that ran before an interjection are saved with piece 1 (BF2) ───────────────────────────────────
const toolStart = (id, name) => ({ type: 'stream_event', session_id: 's1', event: { type: 'content_block_start', content_block: { type: 'tool_use', id, name } } });
const toolRows = (e) => (e && Array.isArray(e.activity) ? e.activity.filter(a => a.kind === 'tool').map(a => a.tool) : []);
const assistantPieces = (agent) => history(agent).filter(e => e.role === 'assistant');

test('BF2 sdk-live: the tool that ran before the interjection is in piece 1, the one after it in piece 2, neither twice', async () => {
  const agent = A.toolSdk;
  sdkScript = async function* (prompt) {
    const it = prompt[Symbol.asyncIterator]();
    await it.next();
    yield delta('First. ');
    yield toolStart('tu1', 'Bash');
    yield { type: 'tool_use_summary', preceding_tool_use_ids: ['tu1'], summary: 'ok' };   // finished before the interjection
    yield delta('Second. ');
    await tick(30);
    sdkChat.handleInterjection({ agent, message: 'hurry' });
    const m = await it.next();
    yield { type: 'user', isReplay: true, uuid: m.value.uuid, session_id: 's1' };
    yield toolStart('tu2', 'Read');
    yield delta('Third.');
    yield { type: 'result', subtype: 'success', session_id: 's1', usage: {} };
  };
  await sdkChat.handleChatStream({ agent, message: 'go' }, browserRes());
  const h = history(agent);
  assert.deepStrictEqual(h.map(e => e.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepStrictEqual(toolRows(h[1]), ['Bash'], 'piece 1 holds the first tool row');
  assert.deepStrictEqual(toolRows(h[3]), ['Read'], 'piece 2 holds the second, not the first again');
  assert.ok(h[1].activity[0].at <= h[1].content.length);
  assert.strictEqual(assistantPieces(agent).map(e => e.content).join(''), 'First. \n\nSecond. \n\nThird.', 'the text is whole');
});

test('BF2 gateway: the tool that ran before the interjection is in piece 1, the one after it in piece 2, neither twice', async () => {
  const agent = A.toolGw;
  const call = (id) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'read_memory', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] });
  const txt = (t) => ({ choices: [{ delta: { content: t } }] });
  gwCalls = 0;
  gwScripts = [
    async function* () { yield txt('Checking. '); yield call('call_1'); },
    async function* () {
      yield txt('Found it. ');
      await tick(30);
      sdkChat.handleInterjection({ agent, message: 'hurry' });
      yield call('call_2');
    },
    async function* () { yield txt('Done.'); yield { choices: [{ delta: {}, finish_reason: 'stop' }] }; },
  ];
  await sdkChat.handleChatStream({ agent, message: 'go' }, browserRes());
  const h = history(agent);
  assert.deepStrictEqual(h.map(e => e.role), ['user', 'assistant', 'user', 'assistant'], JSON.stringify(h.map(e => [e.role, e.content])));
  assert.deepStrictEqual(toolRows(h[1]), ['read_memory'], 'piece 1 holds the first tool row');
  assert.deepStrictEqual(toolRows(h[3]), ['read_memory'], 'piece 2 holds the second, not the first again');
});

// ── a tool still running at an interjection is saved once, finished, with a later piece (F3 item 2) ──────────
const toolDone = (id, summary) => ({ type: 'tool_use_summary', preceding_tool_use_ids: [id], summary });
const allRows = (agent) => assistantPieces(agent).flatMap(e => (Array.isArray(e.activity) ? e.activity.filter(a => a.kind === 'tool') : []));

test('F3-2 sdk-live: an interjection during a running tool; the tool completes; more text; final save, reload: one row, done, with its result', async () => {
  const agent = A.runOne;
  sdkScript = async function* (prompt) {
    const it = prompt[Symbol.asyncIterator]();
    await it.next();
    yield delta('First. ');
    yield toolStart('tr1', 'Bash');   // still running when the interjection comes
    await tick(30);
    sdkChat.handleInterjection({ agent, message: 'hurry' });
    const m = await it.next();
    yield { type: 'user', isReplay: true, uuid: m.value.uuid, session_id: 's1' };
    yield delta('Second. ');
    yield toolDone('tr1', 'result-of-tr1');
    yield delta('Third.');
    yield { type: 'result', subtype: 'success', session_id: 's1', usage: {} };
  };
  await sdkChat.handleChatStream({ agent, message: 'go' }, browserRes());
  const h = history(agent);   // reloaded from the file
  assert.deepStrictEqual(h.map(e => e.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepStrictEqual(toolRows(h[1]), [], 'piece 1 was saved while the tool ran: no row left "running" in it');
  const rows = allRows(agent);
  assert.strictEqual(rows.length, 1, 'the row is saved once');
  assert.strictEqual(rows[0].status, 'done');
  assert.match(rows[0].output, /result-of-tr1/, 'with its result');
  assert.deepStrictEqual(toolRows(h[3]), ['Bash']);
  assert.ok(Number.isFinite(rows[0].at) && rows[0].at >= 0 && rows[0].at <= h[3].content.length, 'its offset is inside its own piece');
  assert.ok(!allRows(agent).some(a => a.status === 'running'), 'nothing saved as running');
});

test('F3-2 sdk-live: two interjections in one reply: no tool row twice, none lost, none left running', async () => {
  const agent = A.runTwo;
  sdkScript = async function* (prompt) {
    const it = prompt[Symbol.asyncIterator]();
    await it.next();
    yield delta('A. ');
    yield toolStart('r1', 'Bash'); yield toolDone('r1', 'one');   // done before the first interjection
    yield delta('B. ');
    yield toolStart('r2', 'Read');   // running over the first interjection
    await tick(30);
    sdkChat.handleInterjection({ agent, message: 'first' });
    let m = await it.next();
    yield { type: 'user', isReplay: true, uuid: m.value.uuid, session_id: 's1' };
    yield delta('C. ');
    yield toolDone('r2', 'two');
    yield toolStart('r3', 'Glob');   // running over the second one
    await tick(30);
    sdkChat.handleInterjection({ agent, message: 'second' });
    m = await it.next();
    yield { type: 'user', isReplay: true, uuid: m.value.uuid, session_id: 's1' };
    yield delta('D. ');
    yield toolDone('r3', 'three');
    yield delta('E.');
    yield { type: 'result', subtype: 'success', session_id: 's1', usage: {} };
  };
  await sdkChat.handleChatStream({ agent, message: 'go' }, browserRes());
  const rows = allRows(agent);
  assert.deepStrictEqual(rows.map(a => a.tool).sort(), ['Bash', 'Glob', 'Read'], 'each tool once: none twice, none lost');
  assert.ok(rows.every(a => a.status === 'done'), 'every row saved as done');
  assert.ok(rows.every(a => /one|two|three/.test(a.output)), 'with their results');
  assert.strictEqual(assistantPieces(agent).length, 3);
  assert.strictEqual(assistantPieces(agent).map(e => e.content).join(''), 'A. \n\nB. \n\nC. \n\nD. E.', 'the text is whole');
});

test('F3-2 gateway: an interjection during a running tool is saved once, finished', async () => {
  const agent = A.runGw;
  const call = (id) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'read_memory', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] });
  const txt = (t) => ({ choices: [{ delta: { content: t } }] });
  gwCalls = 0;
  gwScripts = [
    async function* () { yield txt('Checking. '); yield call('call_a'); },
    async function* () { yield txt('Found it. '); await tick(30); sdkChat.handleInterjection({ agent, message: 'hurry' }); yield txt('More. '); yield call('call_b'); },
    async function* () { yield txt('Done.'); yield { choices: [{ delta: {}, finish_reason: 'stop' }] }; },
  ];
  await sdkChat.handleChatStream({ agent, message: 'go' }, browserRes());
  const rows = allRows(agent);
  assert.strictEqual(rows.length, 2, 'two tools, each saved once');
  assert.ok(rows.every(a => a.status === 'done'), 'all saved as done: ' + JSON.stringify(rows.map(a => a.status)));
});

test('BF2: a turn without an interjection saves the same activity as before (one line, every tool row, no flush)', async () => {
  const agent = A.toolPlain;
  sdkScript = async function* (prompt) {
    const it = prompt[Symbol.asyncIterator]();
    await it.next();
    yield delta('First. ');
    yield toolStart('tp1', 'Bash');
    yield delta('Second. ');
    yield toolStart('tp2', 'Read');
    yield delta('Third.');
    yield { type: 'result', subtype: 'success', session_id: 's1', usage: {} };
  };
  await sdkChat.handleChatStream({ agent, message: 'go' }, browserRes());
  const h = history(agent);
  assert.deepStrictEqual(h.map(e => e.role), ['user', 'assistant']);
  assert.deepStrictEqual(toolRows(h[1]), ['Bash', 'Read']);
  assert.strictEqual(h[1].base, undefined);
});

// ── the phone page (mobile.js), its functions run in a vm with the page's other parts stood in for ───────────
const MOBILE = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
function fnSource(src, name) {
  let start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is in the page`);
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(start, i + 1);
}
const load = (names, ctx = {}) => { const c = vm.createContext({ ...ctx }); vm.runInContext(names.map(n => fnSource(MOBILE, n)).join('\n') + `\nthis.__fns = { ${names.join(', ')} };`, c); return c.__fns; };
const plain = (v) => JSON.parse(JSON.stringify(v));

function sendHarness({ streams, respond }) {
  const input = { value: 'look', style: {} };
  const ctx = {
    pendingImages: [], current: 'agent_x', stick: false, streams,
    $: () => input, saveDraft() {}, composerTypingPaint() {}, renderPreviews() {}, scrollChat() {}, setBubbleTime() {}, msgTimeLabel: () => 't',
    toast() {}, paintStatus() {}, setLive() {}, addUserBubble: () => ({}), addNote: () => ({ textContent: '', classList: { add() {} } }),
    api: async () => ({ json: async () => respond() }), sendMessage: async () => {},
  };
  return load(['sendInterjection'], ctx).sendInterjection;
}

test('BF1-3 phone: the interjection\'s place is taken before the request; text that arrives meanwhile comes after it', async () => {
  const rec = { full: 'Hello', stale: false, controller: { abort() {} } };
  const streams = new Map([['agent_x', rec]]);
  const send = sendHarness({ streams, respond: () => { rec.full = 'Hello world, and on'; return { success: true, id: 'ij-1' }; } });   // text came in while the request was out
  await send('agent_x');
  assert.strictEqual(rec.sentIjs.length, 1);
  assert.strictEqual(rec.sentIjs[0].at, 5, 'placed at the text length when it was sent');
  assert.strictEqual(rec.sentIjs[0].ijId, 'ij-1', 'with the hub\'s id');
});

test('BF1-3 phone: a stream replaced (or stale) before the reply came back gets nothing attached', async () => {
  const oldRec = { full: 'Hello', stale: false, controller: { abort() {} } };
  const newRec = { full: '', stale: false, controller: { abort() {} } };
  const streams = new Map([['agent_x', oldRec]]);
  await sendHarness({ streams, respond: () => { streams.set('agent_x', newRec); return { success: true, id: 'ij-2' }; } })('agent_x');
  assert.strictEqual(oldRec.sentIjs, undefined);
  assert.strictEqual(newRec.sentIjs, undefined, 'the new turn does not get the old turn\'s interjection');
  const staleRec = { full: 'Hello', stale: false, controller: { abort() {} } };
  const streams2 = new Map([['agent_x', staleRec]]);
  await sendHarness({ streams: streams2, respond: () => { staleRec.stale = true; return { success: true, id: 'ij-3' }; } })('agent_x');
  assert.strictEqual(staleRec.sentIjs, undefined);
  const none = new Map();
  await sendHarness({ streams: none, respond: () => ({ success: true, id: 'ij-4' }) })('agent_x');   // no stream at all: nothing, no crash
});

function attachHarness({ turn, replaceDuring = false }) {
  const started = Date.now();
  const rec = { agent: 'agent_x', text: 'go', images: [], startedAt: started, full: 'Hello world', gotAny: true, feed: null, question: null, stale: false, controller: { abort() {} } };
  const streams = new Map([['agent_x', rec]]);
  const painted = [];
  let ctx;
  ctx = {
    streams, chatHistory: [], pendingQuestionsByAgent: new Map(),
    addUserBubble: () => ({}), setBubbleTime() {}, msgTimeLabel: () => 't', paintReasoning() {}, showQuestion() {},
    addAssistantBubble: () => ({ el: {}, body: { innerHTML: '' } }),
    bubbleLive: () => true, paintReply: (h) => painted.push([...(h.feed.ijs ? h.feed.ijs.values() : [])].map(x => x.text)),
    savedImageUrls: (a) => a || [],
    fetchTurn: async () => { if (replaceDuring) streams.set('agent_x', { agent: 'agent_x' }); return { ok: true, active: true, turn: { message: 'go', startedAt: new Date(started).toISOString(), ended: false, activity: turn } }; },
  };
  const f = load(['attachStreamBubble', 'catchUpOwnInterjections', 'feedUpsert', 'placeOf', 'holderFeed', 'newFeed'], ctx);
  rec.feed = f.newFeed(true);
  return { rec, f, painted, ijTexts: () => [...rec.feed.ijs.values()].map(x => x.text) };
}
const settle = () => new Promise(r => setTimeout(r, 5));

test('BF1-4 phone: after a chat switch back, an interjection sent from another device is drawn from the turn view; this phone\'s own is not drawn twice', async () => {
  const h = attachHarness({ turn: [
    { id: 'a1', kind: 'interjection', message: 'mine', at: 3, ijId: 'ij-own' },
    { id: 'a2', kind: 'interjection', message: 'from the desktop', at: 6, ijId: 'ij-desk' },
    { id: 'a3', kind: 'tool', tool: 'Bash', status: 'done', at: 8 },
  ] });
  h.rec.sentIjs = [{ id: 'local-ij-1', ijId: 'ij-own', text: 'mine', images: [], at: 3 }];
  h.f.attachStreamBubble(h.rec);
  await settle();
  assert.deepStrictEqual(plain(h.ijTexts()), ['mine', 'from the desktop'], 'each once');
  h.f.attachStreamBubble(h.rec);   // switched away and back again
  await settle();
  assert.deepStrictEqual(plain(h.ijTexts()), ['mine', 'from the desktop'], 'still each once');
  assert.strictEqual(h.rec.feed.ijs.size, 2);
});

test('BF1-4 phone: the turn view\'s copy of an own interjection drawn first is not drawn again when the local one is attached later; a hub without ids matches by text', async () => {
  const h = attachHarness({ turn: [{ id: 'a1', kind: 'interjection', message: 'mine', at: 3, ijId: 'ij-own' }] });
  h.f.attachStreamBubble(h.rec);   // the POST had not been answered yet: nothing local
  await settle();
  assert.deepStrictEqual(plain(h.ijTexts()), ['mine']);
  h.rec.sentIjs = [{ id: 'local-ij-1', ijId: 'ij-own', text: 'mine', images: [], at: 3 }];   // the answer came after
  h.f.attachStreamBubble(h.rec);
  await settle();
  assert.deepStrictEqual(plain(h.ijTexts()), ['mine'], 'one, not two');

  const old = attachHarness({ turn: [{ id: 'a1', kind: 'interjection', message: 'same words', at: 3 }, { id: 'a2', kind: 'interjection', message: 'other', at: 4 }] });
  old.rec.sentIjs = [{ id: 'local-ij-1', text: 'same words', images: [], at: 3 }];
  old.f.attachStreamBubble(old.rec);
  await settle();
  assert.deepStrictEqual(plain(old.ijTexts()), ['same words', 'other']);
});

test('BF1-4 phone: a stream replaced while the turn view was fetched gets nothing', async () => {
  const h = attachHarness({ turn: [{ id: 'a2', kind: 'interjection', message: 'from the desktop', at: 6, ijId: 'ij-desk' }], replaceDuring: true });
  h.f.attachStreamBubble(h.rec);
  await settle();
  assert.strictEqual(h.rec.feed.ijs, undefined);
});
