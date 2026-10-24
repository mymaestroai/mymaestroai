'use strict';
// Worker cards on the desktop page: a named agent called again while its card is open re-activates that card (the
// new call's prompt and reply follow the earlier ones) instead of opening a second card for the same agent. One-off
// workers (temporary workers, the Claude client's sub-agents) keep a card per call; overlapping calls to one agent
// stream into their own replies; closing a card frees the agent's slot; a page catching up from the hub's turn view
// folds into the same card; labels go in as text. The page code runs here against a stand-in page.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function extract(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} present`);
  let p = src.indexOf('(', at); let pd = 0;
  for (; p < src.length; p++) { if (src[p] === '(') pd++; else if (src[p] === ')' && --pd === 0) break; }
  let i = src.indexOf('{', p); let depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}

const NAMES = ['workerCardKey', 'workerRunOf', 'workerRunsActive', 'settleWorkerCard', 'startWorkerRun', 'handleWorkerEvent',
  'workerCallerLabel', 'paintWorkerCaller', 'cleanupWorkerTabs', 'forgetWorkerCard', 'cancelWorkerCard', 'cancelWorker',
  'turnWorkerUpsert', 'paintWorkerRun', 'markWorkerRunCancelled', 'closeWorkerCardsOf'];

// A stand-in page: each chat's messages area is an ordered list of elements; tabs exist once rendered.
function page() {
  const els = new Map(); const order = {}; let seq = 0;
  const env = { chats: {}, tabs: [], panels: [], statuses: [], rendered: {}, posts: [], flashes: [], timers: new Set() };
  const el = (chatId, props) => {
    const e = { id: `m${++seq}`, chatId, ...props,
      after(other) { const list = order[chatId]; list.splice(list.indexOf(other.id), 1); list.splice(list.indexOf(e.id) + 1, 0, other.id); },
      get nextElementSibling() { const list = order[chatId]; return els.get(list[list.indexOf(e.id) + 1]) || null; } };
    els.set(e.id, e); (order[chatId] = order[chatId] || []).push(e.id);
    return e;
  };
  Object.assign(env, {
    document: { getElementById: (id) => els.get(id) || null },
    appendMessage: (chatId, role, content) => el(chatId, { role, content }).id,
    appendSystemNotice: (chatId, text, variant) => el(chatId, { role: 'notice', textContent: text, className: `system-notice notice-${variant}` }),
    setStatus: (chatId, status, text) => { env.chats[chatId].status = status; env.statuses.push([chatId, status, text || null]); },
    updateMessageWithTools: (msgId, content, tools, images, streaming) => { env.rendered[msgId] = { content, tools: JSON.parse(JSON.stringify(tools)), streaming }; },
    renderWorkerChatTab: (id) => { env.tabs.push(id); els.set(`tab-${id}`, { id: `tab-${id}`, remove: () => els.delete(`tab-${id}`) }); },
    renderWorkerChatPanel: (id) => { env.panels.push(id); },
    updateWorkerTabTimer: () => {}, flashTab: (id) => env.flashes.push(id),
    setInterval: () => { const t = { timer: true }; env.timers.add(t); return t; }, clearInterval: (t) => env.timers.delete(t),
    fetch: (url, opts) => { env.posts.push([url, JSON.parse(opts.body)]); return Promise.resolve(); },
    switchToChat: () => {}, closeChat: () => {},
    updateMessage: (msgId, content) => { const e = els.get(msgId); if (e) e.content = content; },
    // what a chat's messages area shows, in order: [role, text]
    shown: (chatId) => (order[chatId] || []).map(id => els.get(id)).map(e => [e.role, e.role === 'notice' ? e.textContent : (env.rendered[e.id]?.content ?? e.content)]),
    closeTab: (id) => els.delete(`tab-${id}`),
  });
  env.chats.c1 = { id: 'c1', agent: 'maestro', display: 'Maestro' };
  env.chats.c2 = { id: 'c2', agent: 'counsel', display: 'Counsel' };
  const body = `const { chats, document, appendMessage, appendSystemNotice, setStatus, updateMessageWithTools, renderWorkerChatTab,
      renderWorkerChatPanel, updateWorkerTabTimer, flashTab, setInterval, clearInterval, fetch, switchToChat, closeChat, updateMessage } = env;
    const workerTabMap = new Map(); const workerParentMap = new Map(); const workerCardByKey = new Map(); const closedWorkerRuns = new Set();
    ${NAMES.map(n => extract(app, n)).join('\n')}
    return { ${NAMES.join(', ')}, workerTabMap, workerParentMap, workerCardByKey, closedWorkerRuns };`;
  return { env, api: new Function('env', body)(env) };
}

const consult = (id, agent, prompt, display) => ({ type: 'worker_started', worker_id: id, agent_type: agent, description: `Worker: Agent ${display || agent}`, model: 'codex-cli/gpt-6-astra', prompt });

test('the page declares the open-card registry next to the worker maps', () => {
  assert.match(app, /const workerTabMap = new Map\(\);[\s\S]{0,200}const workerParentMap = new Map\(\);[\s\S]{0,200}const workerCardByKey = new Map\(\);[\s\S]{0,200}const closedWorkerRuns = new Set\(\);/);
  // closeChat hands a closed worker card and a closed coordinator to them
  const close = extract(app, 'closeChat');
  assert.match(close, /if \(chat\.isWorker\) forgetWorkerCard\(chatId, true\);/);
  assert.match(close, /if \(!chat\.isWorker\) closeWorkerCardsOf\(chatId\);/);
});

test('card key: a named agent shares one card; temporary workers, sub-agents and unnamed workers never do', () => {
  const { api } = page();
  assert.strictEqual(api.workerCardKey({ agent_type: 'openchallenger' }), 'agent:openchallenger');
  assert.strictEqual(api.workerCardKey({ agent_type: ' doc ' }), 'agent:doc');
  assert.strictEqual(api.workerCardKey({ agent_type: 'doc', tiger_team: true }), 'tt:doc');
  for (const agent_type of ['temporal', 'sdk-agent', '', '   ', undefined, null, 42]) assert.strictEqual(api.workerCardKey({ agent_type }), null, String(agent_type));
});

test('a named agent called again re-activates its open card: one card, the new call under the earlier one', () => {
  const { env, api } = page();
  api.handleWorkerEvent('c1', consult('w1', 'openchallenger', 'Review round 1', 'Openchallenger'));
  api.handleWorkerEvent('c1', { type: 'worker_text_delta', worker_id: 'w1', text: 'ACCEPT WITH CHANGES' });
  api.handleWorkerEvent('c1', { type: 'worker_completed', worker_id: 'w1' });
  const card = 'worker-w1';
  assert.strictEqual(env.chats[card].status, 'idle');
  api.handleWorkerEvent('c1', consult('w2', 'openchallenger', 'Review round 2', 'Openchallenger'));
  assert.deepStrictEqual(env.tabs, [card], 'no second card for the same agent');
  assert.strictEqual(env.chats['worker-w2'], undefined);
  assert.strictEqual(env.chats[card].status, 'thinking', 'the card is working again');
  assert.deepStrictEqual(env.statuses.at(-1), [card, 'thinking', 'Working...']);
  assert.strictEqual(env.chats[card].workerId, 'w2', 'the card follows the newest call');
  assert.deepStrictEqual(env.flashes, [card, card]);
  api.handleWorkerEvent('c1', { type: 'worker_text_delta', worker_id: 'w2', text: 'ACCEPT' });
  const shown = env.shown(card);
  assert.deepStrictEqual(shown.map(s => s[0]), ['user', 'assistant', 'notice', 'user', 'assistant']);
  assert.deepStrictEqual([shown[0][1], shown[1][1], shown[3][1], shown[4][1]], ['Review round 1', 'ACCEPT WITH CHANGES', 'Review round 2', 'ACCEPT']);
  assert.match(shown[2][1], /^↻ Called again by Maestro · /);
  api.handleWorkerEvent('c1', { type: 'worker_completed', worker_id: 'w2' });
  assert.deepStrictEqual(env.statuses.at(-1), [card, 'idle', 'Completed']);
  // the caller's chat: one notice per call, each finished in place
  assert.deepStrictEqual(env.shown('c1').map(s => s[1]), ['✅ Agent Openchallenger is Complete', '✅ Agent Openchallenger is Complete']);
});

test('different agents get their own cards; one-off workers keep a card per call', () => {
  const { env, api } = page();
  api.handleWorkerEvent('c1', consult('a1', 'openchallenger', 'p'));
  api.handleWorkerEvent('c1', consult('b1', 'gemini', 'p'));
  api.handleWorkerEvent('c1', consult('a2', 'openchallenger', 'p'));
  api.handleWorkerEvent('c1', { type: 'worker_started', worker_id: 't1', agent_type: 'temporal', description: 'Worker: grok · openrouter/x-ai/grok-4.7', prompt: 'p' });
  api.handleWorkerEvent('c1', { type: 'worker_started', worker_id: 't2', agent_type: 'temporal', description: 'Worker: grok · openrouter/x-ai/grok-4.7', prompt: 'p' });
  api.handleWorkerEvent('c1', { type: 'worker_started', worker_id: 's1', agent_type: 'sdk-agent', description: 'SDK Worker: search', prompt: 'p' });
  api.handleWorkerEvent('c1', { type: 'worker_started', worker_id: 's2', agent_type: 'sdk-agent', description: 'SDK Worker: search', prompt: 'p' });
  api.handleWorkerEvent('c1', { type: 'worker_started', worker_id: 'u1', description: 'Worker', prompt: 'p' });
  api.handleWorkerEvent('c1', { type: 'worker_started', worker_id: 'u2', description: 'Worker', prompt: 'p' });
  assert.deepStrictEqual(env.tabs, ['worker-a1', 'worker-b1', 'worker-t1', 'worker-t2', 'worker-s1', 'worker-s2', 'worker-u1', 'worker-u2']);
  assert.deepStrictEqual(Object.keys(env.chats['worker-a1'].runs), ['a1', 'a2']);
});

test('a replayed start shows nothing new; overlapping calls to one agent stream into their own replies', () => {
  const { env, api } = page();
  const card = 'worker-r1';
  api.handleWorkerEvent('c1', consult('r1', 'legalreview', 'first'));
  api.handleWorkerEvent('c1', consult('r2', 'legalreview', 'second'));   // the first is still running
  api.handleWorkerEvent('c1', consult('r1', 'legalreview', 'first'));    // replayed
  assert.deepStrictEqual(Object.keys(env.chats[card].runs), ['r1', 'r2']);
  api.handleWorkerEvent('c1', { type: 'worker_text_delta', worker_id: 'r1', text: 'one ' });
  api.handleWorkerEvent('c1', { type: 'worker_text_delta', worker_id: 'r2', text: 'two ' });
  api.handleWorkerEvent('c1', { type: 'worker_tool_start', worker_id: 'r1', tool: 'Read' });
  api.handleWorkerEvent('c1', { type: 'worker_tool_use', worker_id: 'r1', tool: 'Read', input: 'brief.md' });
  api.handleWorkerEvent('c1', { type: 'worker_text_delta', worker_id: 'r1', text: 'done' });
  const { msgId: m1 } = env.chats[card].runs.r1; const { msgId: m2 } = env.chats[card].runs.r2;
  assert.strictEqual(env.rendered[m1].content, 'one done');
  assert.deepStrictEqual(env.rendered[m1].tools, [{ type: 'call', tool: 'Read', input: 'brief.md' }]);
  assert.strictEqual(env.rendered[m2].content, 'two ');
  assert.deepStrictEqual(env.rendered[m2].tools, []);
  api.handleWorkerEvent('c1', { type: 'worker_completed', worker_id: 'r2' });
  assert.strictEqual(env.chats[card].status, 'thinking', 'still working: the first call has not ended');
  assert.ok(!env.statuses.some(s => s[0] === card && s[1] !== 'thinking'), 'the card does not settle while a call still runs');
  // the first call fails after the second showed: its error goes under its own reply
  api.handleWorkerEvent('c1', { type: 'worker_failed', worker_id: 'r1', error: 'model at capacity' });
  const shown = env.shown(card);
  assert.deepStrictEqual(shown.map(s => s[1]), ['first', 'one done', 'Worker failed: model at capacity', shown[3][1], 'second', 'two ']);
  assert.match(shown[3][1], /^↻ Called again by Maestro/);
  assert.deepStrictEqual(env.statuses.at(-1), [card, 'error', 'Failed']);
  assert.deepStrictEqual(env.shown('c1').map(s => s[1]), ['❌ Agent legalreview Failed', '✅ Agent legalreview is Complete']);
});

test('a closed card frees its agent: the next call opens a new card, and the old calls\' events are dropped', () => {
  const { env, api } = page();
  api.handleWorkerEvent('c1', consult('x1', 'pharm', 'p1'));
  api.forgetWorkerCard('worker-x1'); env.closeTab('worker-x1'); delete env.chats['worker-x1'];   // as closeChat does
  assert.strictEqual(api.handleWorkerEvent('c1', { type: 'worker_text_delta', worker_id: 'x1', text: 'late' }), false);
  assert.strictEqual(api.handleWorkerEvent('c1', { type: 'worker_completed', worker_id: 'x1' }), false);
  api.handleWorkerEvent('c1', consult('x2', 'pharm', 'p2'));
  assert.deepStrictEqual(env.tabs, ['worker-x1', 'worker-x2']);
  assert.strictEqual(api.workerCardByKey.get('agent:pharm'), 'worker-x2');
  assert.strictEqual(api.workerTabMap.has('x1'), false);
  // a card whose tab is gone is not re-used even if the registry still names it
  api.workerCardByKey.set('agent:pharm', 'worker-x2'); env.closeTab('worker-x2');
  api.handleWorkerEvent('c1', consult('x3', 'pharm', 'p3'));
  assert.deepStrictEqual(env.tabs.at(-1), 'worker-x3');
});

test('the hub\'s turn view folds into the agent\'s card, once, with each call\'s own text', () => {
  const { env, api } = page();
  const t = { workers: new Set() };
  const recs = [
    { id: 'h1', agent: 'openchallenger', description: 'Worker: Agent Openchallenger', prompt: 'round 1', status: 'completed', text: 'R1 TEXT', tools: [{ id: 'h1-t1', tool: 'Read', summary: 'a.md' }] },
    { id: 'h2', agent: 'openchallenger', description: 'Worker: Agent Openchallenger', prompt: 'round 2', status: 'started', text: 'R2 SO FAR', tools: [] },
    { id: 'h3', agent: null, description: 'Worker', prompt: 'unnamed', status: 'started', text: '' },
  ];
  for (let pass = 0; pass < 2; pass++) for (const w of recs) api.turnWorkerUpsert('c1', t, w);
  assert.deepStrictEqual(env.tabs, ['worker-h1', 'worker-h3'], 'one card for the named agent; the unnamed worker keeps its own');
  assert.strictEqual(env.chats['worker-h3'].agent, 'worker');
  const card = env.chats['worker-h1'];
  assert.deepStrictEqual(Object.keys(card.runs), ['h1', 'h2']);
  assert.strictEqual(env.rendered[card.runs.h1.msgId].content, 'R1 TEXT');
  assert.deepStrictEqual(env.rendered[card.runs.h1.msgId].tools, [{ type: 'call', tool: 'Read', input: 'a.md' }, { type: 'result', output: '' }]);
  assert.strictEqual(env.rendered[card.runs.h2.msgId].content, 'R2 SO FAR');
  assert.strictEqual(card.runs.h1.status, 'completed');
  assert.strictEqual(card.runs.h2.status, 'running');
  assert.strictEqual(card.status, 'thinking');
  assert.strictEqual(env.shown('worker-h1').length, 5, 'the second pass added nothing');
  assert.deepStrictEqual([...t.workers], ['h1', 'h2', 'h3']);
  // a start from the activity list has no prompt (the label shows); the worker record that follows fills it in
  api.turnWorkerUpsert('c1', t, { workerId: 'h4', kind: 'worker', agent: 'openchallenger', description: 'Worker: Agent Openchallenger', status: 'started' });
  assert.strictEqual(env.shown('worker-h1').at(-2)[1], 'Worker: Agent Openchallenger');
  api.turnWorkerUpsert('c1', t, { id: 'h4', agent: 'openchallenger', description: 'Worker: Agent Openchallenger', prompt: 'round 4', status: 'started', text: '' });
  assert.strictEqual(env.shown('worker-h1').at(-2)[1], 'round 4');
  assert.strictEqual(card.runs.h4.promptShown, true);
});

test('a stopped coordinator ends only its own calls; Stop on a card ends every call still running in it', () => {
  const { env, api } = page();
  api.handleWorkerEvent('c1', consult('k1', 'gemini', 'from maestro'));
  api.handleWorkerEvent('c2', consult('k2', 'gemini', 'from counsel'));
  const card = 'worker-k1';
  assert.strictEqual(env.chats[card].parentChatId, 'c2', 'the card follows its newest caller');
  assert.match(env.shown(card)[2][1], /^↻ Called again by Counsel/);
  api.cleanupWorkerTabs('c1');
  assert.strictEqual(env.chats[card].runs.k1.status, 'cancelled');
  assert.strictEqual(env.chats[card].status, 'thinking', 'Counsel\'s call still runs');
  api.cleanupWorkerTabs('c2');
  assert.deepStrictEqual(env.statuses.at(-1), [card, 'error', 'Stopped following']);
  api.handleWorkerEvent('c1', consult('k3', 'gemini', 'again'));
  api.handleWorkerEvent('c1', consult('k4', 'gemini', 'and again'));
  api.cancelWorkerCard(card);
  assert.deepStrictEqual(env.posts.map(p => p[1].worker_id), ['k3', 'k4']);
  assert.deepStrictEqual(env.statuses.at(-1), [card, 'error', 'Stopped following']);
  api.cancelWorkerCard(card);
  assert.strictEqual(env.posts.length, 2, 'nothing left to stop');
});

test('labels go in as text and the buttons read the card when clicked', () => {
  const tab = extract(app, 'renderWorkerChatTab'), panel = extract(app, 'renderWorkerChatPanel'), caller = extract(app, 'paintWorkerCaller');
  assert.doesNotMatch(tab, /\$\{(shortDesc|desc|chat\.display)\}/);
  assert.match(tab, /querySelector\('\.name'\)\.textContent = /);
  assert.doesNotMatch(tab + panel, /onclick=/);
  assert.doesNotMatch(panel, /\$\{(chat\.display|parentLabel|modelShort|chat\.workerId|chat\.parentChatId)\}/);
  assert.match(panel, /addEventListener\('click', \(\) => \{ const c = chats\[workerChatId\]; if \(c\) switchToChat\(c\.parentChatId\); \}\)/);
  assert.match(panel, /addEventListener\('click', \(\) => cancelWorkerCard\(workerChatId\)\)/);
  assert.match(caller, /back\.textContent = /);
  assert.match(caller, /from\.textContent = /);
});

test('the elapsed timer runs while any call runs, follows the newest one still running, and stops with the last', () => {
  const { env, api } = page();
  const card = 'worker-q1';
  api.handleWorkerEvent('c1', consult('q1', 'gemini', 'one'));
  assert.strictEqual(env.timers.size, 1);
  api.handleWorkerEvent('c1', { type: 'worker_completed', worker_id: 'q1' });
  assert.strictEqual(env.timers.size, 0, 'stopped with the last call');
  api.handleWorkerEvent('c1', consult('q2', 'gemini', 'two'));
  assert.strictEqual(env.timers.size, 1, 're-armed when the card re-activates');
  api.handleWorkerEvent('c2', consult('q3', 'gemini', 'three'));
  assert.strictEqual(env.timers.size, 1, 'one timer per card');
  const { q2, q3 } = env.chats[card].runs;
  q2.startedAt = 1000; q3.startedAt = 2000; env.chats[card].startedAt = 2000;
  api.handleWorkerEvent('c2', { type: 'worker_completed', worker_id: 'q3' });
  assert.strictEqual(env.chats[card].startedAt, 1000, 'the clock now shows the call still running');
  assert.strictEqual(env.chats[card].status, 'thinking');
  api.handleWorkerEvent('c1', { type: 'worker_completed', worker_id: 'q2' });
  assert.strictEqual(env.timers.size, 0);
  assert.strictEqual(env.chats[card].status, 'idle');
});

test('closing the chat that called a card last keeps the card while another open chat called it too', () => {
  const { env, api } = page();
  const card = 'worker-v1';
  api.handleWorkerEvent('c1', consult('v1', 'helper', 'from maestro'));     // still running
  api.handleWorkerEvent('c2', consult('v2', 'helper', 'from counsel'));
  assert.strictEqual(env.chats[card].parentChatId, 'c2');
  api.closeWorkerCardsOf('c2'); delete env.chats.c2;                       // as closeChat does
  assert.ok(env.chats[card], 'the card stays: Maestro\'s call is in it');
  assert.strictEqual(env.chats[card].parentChatId, 'c1');
  assert.strictEqual(api.workerParentMap.get(card), 'c1');
  assert.strictEqual(env.chats[card].runs.v2.status, 'cancelled');
  assert.strictEqual(env.chats[card].runs.v1.status, 'running');
  assert.strictEqual(env.chats[card].status, 'thinking');
  api.handleWorkerEvent('c1', { type: 'worker_text_delta', worker_id: 'v1', text: 'still arriving' });
  assert.strictEqual(env.rendered[env.chats[card].runs.v1.msgId].content, 'still arriving');
  api.closeWorkerCardsOf('c1'); delete env.chats.c1;
  assert.strictEqual(env.chats[card], undefined, 'no other caller left: the card closes');
  assert.strictEqual(env.document.getElementById(`tab-${card}`), null);
  assert.strictEqual(api.workerCardByKey.has('agent:helper'), false);
});

test('a card the user closed never comes back from a replay or a catch-up; a new call opens a new card', () => {
  const { env, api } = page();
  api.handleWorkerEvent('c1', consult('d1', 'pharm', 'p1'));
  api.forgetWorkerCard('worker-d1', true); env.closeTab('worker-d1'); delete env.chats['worker-d1'];
  api.handleWorkerEvent('c1', consult('d1', 'pharm', 'p1'));
  api.turnWorkerUpsert('c1', { workers: new Set() }, { id: 'd1', agent: 'pharm', description: 'Worker: Agent pharm', prompt: 'p1', status: 'started', text: 'x' });
  assert.deepStrictEqual(env.tabs, ['worker-d1'], 'nothing reopened');
  api.handleWorkerEvent('c1', consult('d2', 'pharm', 'p2'));
  assert.deepStrictEqual(env.tabs, ['worker-d1', 'worker-d2']);
  // a coordinator closing (not the user dismissing the card) leaves its runs free to come back
  api.closeWorkerCardsOf('c1');
  assert.strictEqual(api.closedWorkerRuns.has('d2'), false);
});

test('an ended call ignores repeated end events; a call this page stopped still shows how it really ended', () => {
  const { env, api } = page();
  const card = 'worker-e1';
  api.handleWorkerEvent('c1', consult('e1', 'legalreview', 'p'));
  api.handleWorkerEvent('c1', { type: 'worker_failed', worker_id: 'e1', error: 'at capacity' });
  api.handleWorkerEvent('c1', { type: 'worker_failed', worker_id: 'e1', error: 'at capacity' });
  api.handleWorkerEvent('c1', { type: 'worker_completed', worker_id: 'e1' });
  assert.strictEqual(env.shown(card).filter(s => s[0] === 'system').length, 1, 'one error line');
  assert.strictEqual(env.chats[card].runs.e1.status, 'failed');
  assert.deepStrictEqual(env.shown('c1').map(s => s[1]), ['❌ Agent legalreview Failed']);
  api.handleWorkerEvent('c1', consult('e2', 'legalreview', 'p2'));
  api.handleWorkerEvent('c1', { type: 'worker_text_delta', worker_id: 'e2', text: 'partial' });
  api.cancelWorkerCard(card);
  assert.deepStrictEqual(env.shown('c1').map(s => s[1]), ['❌ Agent legalreview Failed', '⏹ Agent legalreview: stopped following (it may still finish)']);
  assert.strictEqual(env.rendered[env.chats[card].runs.e2.msgId].streaming, false, 'the reply is no longer drawn as streaming');
  api.handleWorkerEvent('c1', { type: 'worker_completed', worker_id: 'e2' });   // the hub kept it going
  assert.deepStrictEqual(env.shown('c1').map(s => s[1]), ['❌ Agent legalreview Failed', '✅ Agent legalreview is Complete']);
  assert.deepStrictEqual(env.statuses.at(-1), [card, 'idle', 'Completed']);
});

test('a stopped coordinator\'s calls say so in its chat; an empty reply keeps its placeholder', () => {
  const { env, api } = page();
  api.handleWorkerEvent('c1', consult('f1', 'gemini', 'p'));
  api.cleanupWorkerTabs('c1');
  assert.deepStrictEqual(env.shown('c1').map(s => s[1]), ['⏹ Agent gemini: stopped following (it may still finish)']);
  assert.strictEqual(env.rendered[env.chats['worker-f1'].runs.f1.msgId], undefined, 'nothing to repaint: the "..." stays');
  assert.deepStrictEqual(env.statuses.at(-1), ['worker-f1', 'error', 'Stopped following']);
});

test('a call this page stopped following takes its real outcome from the hub\'s turn view; a running caller is followed first', () => {
  const { env, api } = page();
  const card = 'worker-g1';
  api.handleWorkerEvent('c1', consult('g1', 'helper', 'p'));
  api.cancelWorkerCard(card);
  assert.strictEqual(env.chats[card].runs.g1.status, 'cancelled');
  api.turnWorkerUpsert('c1', { workers: new Set() }, { id: 'g1', agent: 'helper', description: 'Worker: Agent helper', prompt: 'p', status: 'completed', text: 'FINAL' });
  assert.strictEqual(env.chats[card].runs.g1.status, 'completed');
  assert.deepStrictEqual(env.shown('c1').map(s => s[1]), ['✅ Agent helper is Complete']);
  assert.deepStrictEqual(env.statuses.at(-1), [card, 'idle', 'Completed']);
  // three callers: Maestro's call still runs, Counsel's and a third chat's ended; closing the third follows Maestro
  env.chats.c3 = { id: 'c3', agent: 'foreman', display: 'Foreman' };
  api.handleWorkerEvent('c1', consult('g2', 'helper', 'maestro'));
  api.handleWorkerEvent('c2', consult('g3', 'helper', 'counsel'));
  api.handleWorkerEvent('c3', consult('g4', 'helper', 'third'));
  api.handleWorkerEvent('c2', { type: 'worker_completed', worker_id: 'g3' });
  api.handleWorkerEvent('c3', { type: 'worker_completed', worker_id: 'g4' });
  api.closeWorkerCardsOf('c3'); delete env.chats.c3;
  assert.strictEqual(env.chats[card].parentChatId, 'c1');
  assert.strictEqual(env.chats[card].status, 'thinking');
});
