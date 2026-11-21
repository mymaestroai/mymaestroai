'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// lib/ comes from a throwaway install, so nothing under the real data/ is touched.
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('ask-user-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const sdkChat = L('sdk-chat');
const { runAskUser, buildHubMcpServer, pendingQuestions, ASK_USER_TIMEOUT_MS, ASK_USER_UNAVAILABLE, appendConversationLog } = sdkChat.__askUser;

const AGENT = 'zz_ask_user_test';
const convFile = path.join(ISO.data, 'conversations', `${AGENT}.jsonl`);
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
  assert.deepStrictEqual(Object.keys(tool.shape).sort(), ['allow_skip', 'choose_model', 'descriptions', 'header', 'options', 'question']);
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

test('each option can carry a line (descriptions), and choose_model adds a drop-down of every model the hub can use, grouped by maker and how it is paid', async () => {
  const agentsMod = L('agents');
  const healthMod = L('model-health');
  const real = { list: agentsMod.availableModelsNow, health: healthMod.getModelHealth };
  agentsMod.availableModelsNow = async () => ['local/qwen-x', 'openai/gpt-x', 'claude-sdk/claude-sonnet-5-5', 'codex-cli/gpt-6-astra', 'anthropic/claude-opus-5-5', 'google/gemini-y'];
  healthMod.getModelHealth = () => ({ view: () => ({ 'openai/gpt-x': { state: 'fail' }, 'google/gemini-y': { state: 'warn' } }) });
  const settle = () => new Promise(r => setTimeout(r, 20));
  try {
    const res = fakeRes();
    const p = runAskUser(AGENT, res, { question: 'Which AI should run it?', options: ['Claude Sonnet 5.5', 'Skip', 'GPT-6 Astra', 'You choose'],
      descriptions: ['Quick, strong writer; your Claude plan', 'ignored with its option', 'Careful reasoner; your ChatGPT plan'], choose_model: true });
    await settle();
    const [ev] = questionEvents(res);
    const q = ev.questions[0];
    assert.deepStrictEqual(q.options, [{ label: 'Claude Sonnet 5.5', description: 'Quick, strong writer; your Claude plan' },
      { label: 'GPT-6 Astra', description: 'Careful reasoner; your ChatGPT plan' }, { label: 'You choose' }, { label: 'Skip', description: 'Leave this for later' }],
      'each line stays with its own option, even when one before it is dropped');
    assert.deepStrictEqual(q.models.map(m => [m.group, m.id]), [
      ['Anthropic · Subscription', 'claude-sdk/claude-sonnet-5-5'], ['Anthropic · API $', 'anthropic/claude-opus-5-5'],
      ['OpenAI · Subscription', 'codex-cli/gpt-6-astra'], ['OpenAI · API $', 'openai/gpt-x'],
      ['Google · API $', 'google/gemini-y'], ['Local (free)', 'local/qwen-x']]);
    assert.match(q.models.find(m => m.id === 'openai/gpt-x').label, /^gpt-x · API · failing lately$/);
    assert.doesNotMatch(q.models.find(m => m.id === 'google/gemini-y').label, /failing/, 'only a failure is marked');
    assert.match(readLog().slice(-1)[0].content, /\(or any model from the list\)$/);
    // A pick in the drop-down comes back as the model id.
    sdkChat.handleAskResponse({ request_id: ev.request_id, answers: { 0: 'codex-cli/gpt-6-astra' } });
    assert.strictEqual(await p, 'codex-cli/gpt-6-astra');
    // The list can't be read: the question still goes out, with its buttons and typing, and no drop-down.
    agentsMod.availableModelsNow = async () => { throw new Error('discovery down'); };
    const res2 = fakeRes();
    const p2 = runAskUser(AGENT, res2, { question: 'Which one?', options: ['A'], choose_model: true });
    await settle();
    const ev2 = questionEvents(res2)[0];
    assert.ok(ev2 && !('models' in ev2.questions[0]));
    sdkChat.handleAskResponse({ request_id: ev2.request_id, answers: { 0: 'A' } });
    assert.strictEqual(await p2, 'A');
    // A long list is never cut short: every model the hub can use is in it, once.
    const many = Array.from({ length: 450 }, (_, i) => `openrouter/vendor/model-${String(i).padStart(3, '0')}`);
    agentsMod.availableModelsNow = async () => [...many, many[0]];
    const res4 = fakeRes();
    const p4 = runAskUser(AGENT, res4, { question: 'Which of many?', choose_model: true });
    await settle();
    const ev4 = questionEvents(res4)[0];
    assert.deepStrictEqual(ev4.questions[0].models.map(m => m.id).sort(), many.slice().sort());
    sdkChat.handleAskResponse({ request_id: ev4.request_id, answers: { 0: many[449] } });
    assert.strictEqual(await p4, many[449]);
    // A slow list doesn't hold the question: past modelListMs it goes out without the drop-down.
    agentsMod.availableModelsNow = () => new Promise(() => {});
    const res5 = fakeRes();
    const p5 = runAskUser(AGENT, res5, { question: 'Slow list?', options: ['A'], choose_model: true }, { modelListMs: 60 });
    await new Promise(r => setTimeout(r, 150));
    const ev5 = questionEvents(res5)[0];
    assert.ok(ev5 && !('models' in ev5.questions[0]), 'asked without the drop-down');
    sdkChat.handleAskResponse({ request_id: ev5.request_id, answers: { 0: 'A' } });
    assert.strictEqual(await p5, 'A');
    // A Stop while the list is being read: no card, and the turn is not held for the 10-minute timeout.
    agentsMod.availableModelsNow = () => new Promise(r => setTimeout(() => r(['openai/gpt-x']), 120));
    const ac = new AbortController();
    const res6 = fakeRes();
    const started = Date.now();
    const p6 = runAskUser(AGENT, res6, { question: 'Stopped?', choose_model: true }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    assert.strictEqual(await p6, 'NO_ANSWER');
    assert.ok(Date.now() - started < 2000, 'answered at once');
    assert.strictEqual(questionEvents(res6).length, 0, 'no question went out');
    // And when the list never comes at all, the Stop still ends the wait at once (not after modelListMs).
    agentsMod.availableModelsNow = () => new Promise(() => {});
    const ac2 = new AbortController();
    const res7 = fakeRes();
    const t7 = Date.now();
    const p7 = runAskUser(AGENT, res7, { question: 'Stopped again?', choose_model: true }, { signal: ac2.signal, modelListMs: 60000 });
    setTimeout(() => ac2.abort(), 20);
    assert.strictEqual(await p7, 'NO_ANSWER');
    assert.ok(Date.now() - t7 < 1000, 'the Stop ended the wait');
    assert.strictEqual(questionEvents(res7).length, 0);
    // Without choose_model there is never a list.
    const res3 = fakeRes();
    const p3 = runAskUser(AGENT, res3, { question: 'Plain?', options: ['Yes'] });
    await tick();
    assert.ok(!('models' in questionEvents(res3)[0].questions[0]));
    sdkChat.handleAskResponse({ request_id: questionEvents(res3)[0].request_id, answers: { 0: 'Yes' } });
    await p3;
  } finally { agentsMod.availableModelsNow = real.list; healthMod.getModelHealth = real.health; }
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

test('an answer that names a different agent than the one that asked is refused and leaves the question open', async () => {
  const res = fakeRes();
  const p = runAskUser(AGENT, res, { question: 'Which color?', options: ['Green', 'Blue'] });
  await tick();
  const [ev] = questionEvents(res);
  assert.deepStrictEqual(sdkChat.handleAskResponse({ request_id: ev.request_id, agent: 'someone_else', answers: { 0: 'Blue' } }), { success: false, error: 'No pending question' });
  assert.ok(pendingQuestions.has(ev.request_id), 'still waiting for the right answer');
  assert.deepStrictEqual(sdkChat.handleAskResponse({ request_id: ev.request_id, agent: AGENT, answers: { 0: 'Green' } }), { success: true });
  assert.strictEqual(await p, 'Green');
});

test('an adminOnly question is answered only by an admin; other questions are unchanged', async () => {
  const res = fakeRes();
  const p = runAskUser(AGENT, res, { question: 'Allow it?', options: ['Allow', "Don't allow"], adminOnly: true });
  await tick();
  const id = questionEvents(res)[0].request_id;
  const refused = { success: false, error: 'No pending question' };
  assert.deepStrictEqual(sdkChat.handleAskResponse({ request_id: id, answers: { 0: 'Allow' } }), refused, 'no flag');
  assert.deepStrictEqual(sdkChat.handleAskResponse({ request_id: id, answers: { 0: 'Allow' } }, { isAdmin: false }), refused);
  assert.deepStrictEqual(sdkChat.handleAskResponse({ request_id: id, answers: { 0: 'Allow' } }, { isAdmin: 'yes' }), refused, 'only true counts');
  assert.ok(pendingQuestions.has(id), 'still waiting');
  assert.deepStrictEqual(sdkChat.handleAskResponse({ request_id: id, answers: { 0: 'Allow' } }, { isAdmin: true }), { success: true });
  assert.strictEqual(await p, 'Allow');
  const res2 = fakeRes();
  const p2 = runAskUser(AGENT, res2, { question: 'Plain?', options: ['A'] });
  await tick();
  assert.deepStrictEqual(sdkChat.handleAskResponse({ request_id: questionEvents(res2)[0].request_id, answers: { 0: 'A' } }, { isAdmin: false }), { success: true });
  assert.strictEqual(await p2, 'A');
});

test('the data connector access question is asked adminOnly', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(src, /header: 'Data connector access', adminOnly: true \}/);
});
