'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const sdkChat = require('../lib/sdk-chat');
const { runAskUser, buildHubMcpServer, pendingQuestions, ASK_USER_TIMEOUT_MS, ASK_USER_UNAVAILABLE, appendConversationLog } = sdkChat.__askUser;

const AGENT = 'zz_ask_user_test';
const convFile = path.join(__dirname, '..', 'data', 'conversations', `${AGENT}.jsonl`);
fs.mkdirSync(path.dirname(convFile), { recursive: true });
after(() => { try { fs.unlinkSync(convFile); } catch {} });
const readLog = () => fs.existsSync(convFile) ? fs.readFileSync(convFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

function fakeRes() {
  const events = [];
  return {
    events, writableEnded: false, destroyed: false,
    on() {},
    write(s) { if (s.startsWith('data: ')) { try { events.push(JSON.parse(s.slice(6))); } catch {} } return true; },
  };
}
const questionEvents = (res) => res.events.map(e => e.gateway).filter(g => g && g.type === 'ask_user_question');
const tick = () => new Promise(r => setImmediate(r));

test('ask_user is in the SDK tool list, always loaded, with the right parameters', async () => {
  const sdk = {
    tool: (name, description, shape, handler, opts) => ({ name, description, shape, handler, opts }),
    createSdkMcpServer: (cfg) => cfg,
  };
  const server = await buildHubMcpServer(AGENT, fakeRes(), sdk, {});
  const tool = server.tools.find(t => t.name === 'ask_user');
  assert.ok(tool, 'ask_user registered');
  assert.deepStrictEqual(tool.opts, { alwaysLoad: true });
  assert.deepStrictEqual(Object.keys(tool.shape).sort(), ['allow_skip', 'header', 'options', 'question']);
  assert.ok(!tool.shape.question.isOptional(), 'question is required');
  assert.ok(tool.shape.options.isOptional() && tool.shape.header.isOptional() && tool.shape.allow_skip.isOptional());
  assert.match(tool.description, /ONE question/);

  const consulted = await buildHubMcpServer(AGENT, fakeRes(), sdk, { consultationDepth: 1 });
  const out = await consulted.tools.find(t => t.name === 'ask_user').handler({ question: 'x' });
  assert.strictEqual(out.content[0].text, ASK_USER_UNAVAILABLE);
});

test('emits an ask_user_question gateway event and returns the typed answer', async () => {
  const res = fakeRes();
  const p = runAskUser(AGENT, res, { question: 'Which color?', options: ['Green', 'Blue'], header: 'Shed' });
  await tick();
  const [ev] = questionEvents(res);
  assert.ok(ev, 'event emitted');
  assert.match(ev.request_id, /^[0-9a-f-]{36}$/);
  assert.strictEqual(ev.questions.length, 1);
  const q = ev.questions[0];
  assert.strictEqual(q.header, 'Shed');
  assert.strictEqual(q.question, 'Which color?');
  assert.deepStrictEqual(q.options.map(o => o.label), ['Green', 'Blue', 'Skip']);
  assert.ok(pendingQuestions.has(ev.request_id));

  assert.deepStrictEqual(sdkChat.handleAskResponse({ request_id: ev.request_id, answers: { 0: 'Forest green' } }), { success: true });
  assert.strictEqual(await p, 'Forest green');
  assert.ok(!pendingQuestions.has(ev.request_id), 'pending entry cleaned up');
  assert.deepStrictEqual(sdkChat.handleAskResponse({ request_id: ev.request_id, answers: { 0: 'again' } }), { success: false, error: 'No pending question' });
});

test('Skip is returned as SKIPPED; allow_skip:false omits the option and keeps the literal text', async () => {
  const res = fakeRes();
  const p = runAskUser(AGENT, res, { question: 'Q1' });
  await tick();
  sdkChat.handleAskResponse({ request_id: questionEvents(res)[0].request_id, answers: { 0: 'Skip' } });
  assert.strictEqual(await p, 'SKIPPED');

  const res2 = fakeRes();
  const p2 = runAskUser(AGENT, res2, { question: 'Q2', options: ['a', 'b'], allow_skip: false });
  await tick();
  const ev = questionEvents(res2)[0];
  assert.deepStrictEqual(ev.questions[0].options.map(o => o.label), ['a', 'b']);
  sdkChat.handleAskResponse({ request_id: ev.request_id, answers: { 0: 'skip' } });
  assert.strictEqual(await p2, 'skip');
});

test('times out with NO_ANSWER and leaves nothing pending', async () => {
  assert.strictEqual(ASK_USER_TIMEOUT_MS, 10 * 60 * 1000);
  const before = pendingQuestions.size;
  const res = fakeRes();
  const out = await runAskUser(AGENT, res, { question: 'Anyone?' }, { timeoutMs: 20 });
  assert.strictEqual(out, 'NO_ANSWER');
  assert.strictEqual(pendingQuestions.size, before);
});

test('an aborted turn resolves NO_ANSWER immediately', async () => {
  const ac = new AbortController();
  const res = fakeRes();
  const p = runAskUser(AGENT, res, { question: 'Still there?' }, { signal: ac.signal });
  await tick();
  const before = pendingQuestions.size;
  ac.abort();
  assert.strictEqual(await p, 'NO_ANSWER');
  assert.strictEqual(pendingQuestions.size, before - 1);
  assert.strictEqual(await runAskUser(AGENT, fakeRes(), { question: 'late' }, { signal: ac.signal }), 'NO_ANSWER');
});

test('unavailable without blocking when consulted or when there is no live stream', async () => {
  const res = fakeRes();
  assert.strictEqual(await runAskUser(AGENT, res, { question: 'x' }, { consultationDepth: 1 }), ASK_USER_UNAVAILABLE);
  assert.strictEqual(questionEvents(res).length, 0);
  assert.strictEqual(await runAskUser(AGENT, null, { question: 'x' }), ASK_USER_UNAVAILABLE);
  const ended = fakeRes(); ended.writableEnded = true;
  assert.strictEqual(await runAskUser(AGENT, ended, { question: 'x' }), ASK_USER_UNAVAILABLE);
  const headless = { write() {}, writableEnded: false, destroyed: false };
  assert.strictEqual(await runAskUser(AGENT, headless, { question: 'x' }), ASK_USER_UNAVAILABLE);
});

test('the conversation log gets the question and the answer, and incremental saves do not clobber the question', async () => {
  try { fs.unlinkSync(convFile); } catch {}
  const res = fakeRes();
  const p = runAskUser(AGENT, res, { question: 'Do you own the house?', options: ['Yes', 'No'] });
  await tick();
  // an incremental assistant save while the question is open must append, not overwrite
  sdkChat.appendConversationLog(AGENT, 'assistant', 'partial text', true);
  sdkChat.handleAskResponse({ request_id: questionEvents(res)[0].request_id, answers: { 0: 'Yes' } });
  await p;
  const log = readLog();
  assert.strictEqual(log[0].role, 'assistant');
  assert.strictEqual(log[0].content, '❓ Do you own the house? [Yes / No]');
  assert.strictEqual(log[0].ask, true);
  assert.strictEqual(log[1].content, 'partial text');
  assert.deepStrictEqual([log[2].role, log[2].content], ['user', '↳ Yes']);
});

test('progress saves after a question append only the new text, never the whole reply again', () => {
  try { fs.unlinkSync(convFile); } catch {}
  appendConversationLog(AGENT, 'user', 'Tell me about the shed.');
  appendConversationLog(AGENT, 'assistant', 'Let me ask a few things first.', false);           // first partial save (append)
  appendConversationLog(AGENT, 'assistant', 'Let me ask a few things first. ', true);           // incremental overwrite
  appendConversationLog(AGENT, 'assistant', '❓ Which color should the shed be? [Green / Blue]', false, { ask: true });
  appendConversationLog(AGENT, 'user', '↳ Green', false, { ask: true });
  const full = 'Let me ask a few things first. Green, good. Next: should the door face the garden?';
  appendConversationLog(AGENT, 'assistant', full, true);                                        // save after the answer
  let log = readLog();
  assert.strictEqual(log.length, 5, JSON.stringify(log.map(e => e.content)));
  assert.strictEqual(log[4].content, 'Green, good. Next: should the door face the garden?');
  assert.strictEqual(log[4].base, 'Let me ask a few things first. '.length);
  const longer = full + ' And who keeps the spare key?';
  appendConversationLog(AGENT, 'assistant', longer, true);                                      // further incremental save
  log = readLog();
  assert.strictEqual(log.length, 5);
  assert.strictEqual(log[4].content, 'Green, good. Next: should the door face the garden? And who keeps the spare key?');
  assert.strictEqual(log.map(e => e.content).join('').includes('Let me ask a few things first. Let me ask'), false);
  appendConversationLog(AGENT, 'assistant', 'unrelated new reply', true);                       // last entry is a base entry: still overwrites by delta rule
  assert.strictEqual(readLog().length, 5);
});

test('consult_agent, spawn_workers and the read/list tools are marked concurrency-safe; ask_user and writers are not', async () => {
  const sdk = { tool: (name, description, shape, handler, opts) => ({ name, description, shape, handler, opts }), createSdkMcpServer: (o) => o };
  const server = await buildHubMcpServer('zz_test_agent', fakeRes(), sdk, { consultationDepth: 0 });
  const by = Object.fromEntries(server.tools.map(t => [t.name, t]));
  for (const n of ['consult_agent', 'spawn_workers', 'list_agents', 'read_memory', 'read_shared_memory', 'search_shared_memory', 'job_status', 'list_jobs'])
    assert.strictEqual(by[n]?.opts?.annotations?.readOnlyHint, true, n + ' should be concurrency-safe');
  for (const n of ['ask_user', 'write_memory', 'append_memory', 'create_agent'])
    assert.notStrictEqual(by[n]?.opts?.annotations?.readOnlyHint, true, n + ' must stay serial');
  // wallet tools are registered only for the wallet agent; make sure that map line carries no hint
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  const walletLine = src.split('\n').find(l => l.includes('walletTools.toolSpecs().map(spec => sdk.tool('));
  assert.ok(walletLine && !walletLine.includes('readOnlyHint'), 'wallet tools must never be marked concurrency-safe');
});
