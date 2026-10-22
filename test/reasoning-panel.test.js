'use strict';
// The reasoning panel: a model's reasoning travels apart from its reply (its own stream event, the hub's turn view in
// pieces with offsets, the saved reply's metadata) from every route that has it (Claude's summarized thinking on the
// client and on the API, Codex's reasoning summary, OpenRouter's `reasoning`, `reasoning_content` from local servers and
// OpenAI's Responses), and the pages show it in a panel above the reply that opens, closes, resizes and goes full size.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createHubEvents, events: shared } = require('../lib/hub-events');
const sdkChat = require('../lib/sdk-chat');
const gw = require('../lib/gateway-client');
const as = require('../lib/codex-cli/app-server');
const codexCli = require('../lib/codex-cli');
const { wrapResponsesStream } = require('../lib/openai-responses');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function fakeRes() { const r = { chunks: [], write: (s) => { r.chunks.push(s); return true; } }; return r; }
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const text = (res, t) => sse(res, { choices: [{ delta: { content: t } }] });
const gwEv = (res, g) => sse(res, { choices: [{ delta: {} }], gateway: g });

test('turn view: reasoning is kept apart from the reply and sent in pieces with offsets, never replayed', async () => {
  const hub = createHubEvents();
  const seen = [];
  hub.onPublish(ev => seen.push(ev));
  const res = fakeRes();
  const tap = hub.tapTurn(res, { agent: 'rz', origin: { kind: 'user' }, message: 'go', turnId: 'r1' });
  gwEv(res, { type: 'reasoning', text: 'First, ' });
  gwEv(res, { type: 'reasoning', text: 'check the log.' });
  await sleep(380);   // one throttle window: the first piece goes out
  gwEv(res, { type: 'reasoning', text: ' Then answer.' });
  text(res, 'Done.');
  const turn = hub.turnFor('rz');
  assert.strictEqual(turn.reasoning, 'First, check the log. Then answer.');
  assert.strictEqual(turn.reasoningChars, 34);
  assert.strictEqual(turn.text, 'Done.', 'the reply text never holds reasoning');
  tap.finish(true);   // the last piece goes out before turn_end
  const pieces = seen.filter(e => e.type === 'turn_reasoning');
  assert.deepStrictEqual(pieces.map(p => [p.agent, p.at, p.text]), [['rz', 0, 'First, check the log.'], ['rz', 21, ' Then answer.']]);
  assert.ok(seen.findIndex(e => e.type === 'turn_reasoning' && e.at === 21) < seen.findIndex(e => e.type === 'turn_end'));
  assert.ok(!hub.recent().some(e => e.type === 'turn_reasoning'), 'pieces are not kept for replay');
  assert.ok(hub.recent().some(e => e.type === 'turn_end'), 'turn events still are');
  gwEv(res, { type: 'reasoning', text: 'late' });
  assert.strictEqual(hub.turnFor('rz').reasoning, 'First, check the log. Then answer.', 'nothing after the end');
});

test('turn view: a long think keeps its newest 120,000 characters and counts the whole', () => {
  const hub = createHubEvents();
  const res = fakeRes();
  const tap = hub.tapTurn(res, { agent: 'rlong', origin: { kind: 'user' }, message: 'go', turnId: 'r2' });
  gwEv(res, { type: 'reasoning', text: 'a'.repeat(70000) });
  gwEv(res, { type: 'reasoning', text: 'b'.repeat(60000) });
  const turn = hub.turnFor('rlong');
  assert.strictEqual(turn.reasoning.length, 120000);
  assert.ok(turn.reasoning.endsWith('b'.repeat(60000)) && turn.reasoning.startsWith('a'));
  assert.strictEqual(turn.reasoningChars, 130000);
  tap.finish(true);
});

test('saved reply: its turn\'s reasoning goes with it as metadata (newest part when long), never from a finished turn', () => {
  const res = fakeRes();
  const tap = shared.tapTurn(res, { agent: 'rsave', origin: { kind: 'user' }, message: 'go', turnId: 'r3' });
  gwEv(res, { type: 'reasoning', text: 'Short think.' });
  text(res, 'Answer.');
  assert.deepStrictEqual(sdkChat.activityMeta('rsave', 'Answer.'), { reasoning: 'Short think.', reasoningChars: 12 });
  assert.deepStrictEqual(sdkChat.activityMeta('rsave', 'Answer.', { tiger_team: true }), { tiger_team: true, reasoning: 'Short think.', reasoningChars: 12 });
  gwEv(res, { type: 'reasoning', text: 'x'.repeat(50000) });
  const long = sdkChat.activityMeta('rsave', 'Answer.');
  assert.strictEqual(long.reasoning, 'x'.repeat(40000), 'the newest part, no marker inside the text');
  assert.strictEqual(long.reasoningChars, 50012, 'with the whole length, so a page can tell the start is cut and which copy is newer');
  tap.finish(true);
  // A save outside a tapped turn (a Tiger Team member) a moment later must not pick up the finished turn's reasoning
  // or its tool calls.
  assert.strictEqual(sdkChat.activityMeta('rsave', 'Other reply.'), undefined);
  assert.strictEqual(sdkChat.activityForSave('rsave', 'Other reply.'), null);
});

test('Claude client: summarized thinking is asked for on the models that think adaptively only', () => {
  const yes = ['claude-opus-5-5', 'claude-fable-5-1[1m]', 'claude-fable-5', 'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-4-6', 'claude-sonnet-4-7', 'opus', 'default', 'claude-sdk/claude-opus-5-5'];
  const no = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5', 'claude-opus-4-5', 'claude-3-7-sonnet', '', null];
  for (const m of yes) assert.strictEqual(sdkChat.adaptiveThinking(m), true, m);
  for (const m of no) assert.strictEqual(sdkChat.adaptiveThinking(m), false, String(m));
  const src = read('lib/sdk-chat.js');
  assert.match(src, /showReasoning\(\) && adaptiveThinking\(sdkModel\) \? \{ thinking: \{ type: 'adaptive', display: 'summarized' \} \}/);
  // its thinking deltas reach the page as reasoning events, a sub-agent's never
  assert.match(src, /evt\.delta\?\.type === 'thinking_delta'\) \{\s*if \(evt\.delta\.thinking && !sdkWorkers\.workerFor\(msg\)\)/);
  // the setting turns all of it off (no request, no events)
  assert.match(src, /function sendReasoning\(res, model, text\) \{ if \(typeof text === 'string' && text && showReasoning\(\)\)/);
});

test('Claude on the API: the adapter passes thinking on as reasoning, never as reply text', async () => {
  const enc = new TextEncoder();
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Weighing it.' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Yes.' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
    { type: 'message_stop' },
  ];
  const up = new Response(new ReadableStream({ start(c) { for (const ev of events) c.enqueue(enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)); c.close(); } }), { status: 200 });
  let reply = ''; let reasoning = '';
  for await (const c of gw.parseSSEStream(gw.createAnthropicStreamAdapter(up), {})) {
    const d = c.choices?.[0]?.delta || {};
    if (d.content) reply += d.content;
    if (d.reasoning) reasoning += d.reasoning;
  }
  assert.strictEqual(reply, 'Yes.');
  assert.strictEqual(reasoning, 'Weighing it.');
});

test('gateway turn: reasoning / reasoning_content become reasoning events; a later model call starts a new paragraph; not for Tiger Team members', () => {
  const src = read('lib/sdk-chat.js');
  assert.match(src, /const rsn = !tigerTeam && choice\.delta && \(typeof choice\.delta\.reasoning === 'string' \? choice\.delta\.reasoning : typeof choice\.delta\.reasoning_content === 'string' \? choice\.delta\.reasoning_content : ''\);/);
  assert.match(src, /if \(!callReasoned && gwReasoningSent\) sendReasoning\(res, model, '\\n\\n'\);/);
  assert.match(src, /let callReasoned = false;/);
  // the Codex routes too
  assert.match(src, /\} else if \(a\.kind === 'reasoning'\) \{[\s\S]{0,400}?if \(a\.item\) codexReasoningItem = a\.item;\s*sendReasoning\(res, agentModel, a\.text\);/);
});

test('OpenAI Responses: reasoning summaries come through, each new summary part a new paragraph', async () => {
  const body = [
    { type: 'response.created', response: { id: 'r', model: 'm' } },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs1', summary_index: 0, delta: 'Plan A.' },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs1', summary_index: 0, delta: ' Still A.' },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs1', summary_index: 1, delta: 'Plan B.' },
    { type: 'response.output_text.delta', delta: 'Done' },
    { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } } },
  ].map(e => `data: ${JSON.stringify(e)}`).join('\n') + '\n';
  const enc = new TextEncoder();
  const wrapped = wrapResponsesStream({ body: new ReadableStream({ start(c) { c.enqueue(enc.encode(body)); c.close(); } }) }, 'm');
  const frames = (await wrapped.text()).split('\n\n').filter(f => f.startsWith('data: {')).map(f => JSON.parse(f.slice(6)));
  const r = frames.map(f => f.choices?.[0]?.delta?.reasoning_content).filter(x => x !== undefined).join('');
  assert.strictEqual(r, 'Plan A. Still A.\n\nPlan B.');
});

test('Codex: reasoning summaries stream as reasoning actions; a summary only seen at the end comes whole', () => {
  const st = as.newMapperState();
  const m = (method, params) => as.notificationToActions(method, params, st);
  assert.deepStrictEqual(m('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: 'Look at ', summaryIndex: 0 }), [{ kind: 'reasoning', text: 'Look at ', item: 'r1' }]);
  assert.deepStrictEqual(m('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: 'the tests.', summaryIndex: 0 }), [{ kind: 'reasoning', text: 'the tests.', item: 'r1' }]);
  assert.deepStrictEqual(m('item/reasoning/summaryPartAdded', { itemId: 'r1', summaryIndex: 1 }), [{ kind: 'reasoning', text: '\n\n', item: 'r1' }]);
  assert.deepStrictEqual(m('item/reasoning/summaryPartAdded', { itemId: 'r9', summaryIndex: 0 }), [], 'a first part adds no break');
  assert.deepStrictEqual(m('item/completed', { item: { type: 'reasoning', id: 'r1', summary: ['Look at the tests.'], content: [] } }), [], 'streamed: nothing twice');
  assert.deepStrictEqual(m('item/completed', { item: { type: 'reasoning', id: 'r2', summary: ['One.', 'Two.'], content: [] } }), [{ kind: 'reasoning', text: 'One.\n\nTwo.', item: 'r2' }]);
  assert.deepStrictEqual(m('item/completed', { item: { type: 'reasoning', id: 'r4', summary: [{ text: 'As objects.' }], content: [] } }), [{ kind: 'reasoning', text: 'As objects.', item: 'r4' }], '{ text } parts are read too');
  assert.deepStrictEqual(m('item/completed', { item: { type: 'reasoning', id: 'r3', summary: [], content: [] } }), []);
  // codex exec (the older bridge): the reasoning item's text
  assert.deepStrictEqual(codexCli.eventToActions({ type: 'item.completed', item: { type: 'reasoning', id: 'x', text: 'Thought.' } }), [{ kind: 'reasoning', text: 'Thought.', item: 'x' }]);
  // a new reasoning item (after a tool call) starts a new paragraph in the turn
  const src = read('lib/sdk-chat.js');
  assert.match(src, /if \(a\.item && codexReasoningItem && a\.item !== codexReasoningItem && a\.text && !\/\^\\s\/\.test\(a\.text\)\) sendReasoning\(res, agentModel, '\\n\\n'\);/);
  // the reasoning summary is asked for while the panel is on (app-server thread config, codex exec args)
  assert.deepStrictEqual(as.threadParams({ model: 'm', cwd: '/w', sandbox: 'read-only', reasoningSummary: 'auto' }).config, { model_reasoning_summary: 'auto' });
  assert.strictEqual(as.threadParams({ model: 'm', cwd: '/w', sandbox: 'read-only' }).config, undefined);
  const args = codexCli.buildArgs({ model: 'm', cwd: '/w', sandbox: 'read-only', reasoningSummary: 'auto' });
  assert.ok(args.includes('model_reasoning_summary="auto"'), args.join(' '));
  assert.ok(!codexCli.buildArgs({ model: 'm', cwd: '/w', sandbox: 'read-only' }).some(a => a.startsWith('model_reasoning_summary')));
});

test('settings: showReasoning is a plain on/off, on unless turned off', () => {
  const server = read('server.js');
  assert.match(server, /if \(patch && patch\.showReasoning !== undefined\) patch\.showReasoning = patch\.showReasoning !== false;/);
  const app = read('app.js');
  assert.match(app, /id="st-reasoning" \$\{data\.showReasoning !== false \? 'checked' : ''\} onchange="saveReasoningToggle\(this\.checked\)"/);
  assert.match(app, /body: JSON\.stringify\(\{ showReasoning: !!on \}\)/);
});

test('desktop page: the panel survives message rewrites, follows turns from anywhere and shows saved reasoning', () => {
  const app = read('app.js');
  // every rewrite of a message keeps the panel node
  const body = (name) => { const i = app.indexOf(`function ${name}(`); return app.slice(i, app.indexOf('\n    }\n', i)); };
  for (const fn of ['updateMessage', 'renderSteps', 'updateMessageWithTools', 'updateGroupMessage', 'updateSynthesisMessage']) {
    assert.match(body(fn), /setMessageHtml\(el, /, fn);
    assert.doesNotMatch(body(fn), /\bel\.innerHTML = /, fn);
  }
  assert.match(body('setMessageHtml'), /const box = el\.querySelector\(':scope > \.reason-stream'\);\s*el\.innerHTML = html;\s*if \(box\) placeReasoningPanel\(el, box\);/);
  // text only
  assert.match(body('paintReasoning'), /body\.textContent = /);
  assert.doesNotMatch(body('paintReasoning'), /\.innerHTML = [^'`]*st\.text/);
  // own streams (single chat, rounds, group), turns followed through hub events, catch-up, saved replies, re-attach
  assert.strictEqual((app.match(/appendReasoning\(msgId, chatId, oc\d?\)/g) || []).length, 3);
  assert.match(app, /source\.addEventListener\('turn_reasoning', e => \{ const ev = parse\(e\); if \(ev\) onHubTurnReasoning\(ev\); \}\);/);
  assert.match(app, /if \(!msgId \|\| addReasoningAt\(msgId, Number\(ev\.at\), typeof ev\.text === 'string' \? ev\.text : ''\)\) return;/);
  assert.match(app, /setReasoning\(ra \? ra\.msgId : t\.msgId, turn\.reasoning, \{ live: !turn\.ended, total: Number\(turn\.reasoningChars\), onlyIfLonger: true \}\);/);
  assert.match(app, /if \(msg\.role === 'assistant' && typeof msg\.reasoning === 'string' && msg\.reasoning\) setReasoning\(hid, msg\.reasoning, \{ total: Number\(msg\.reasoningChars\) \}\);/);
  assert.match(app, /if \(typeof reply\.reasoning === 'string' && reply\.reasoning\) setReasoning\(ra\.msgId, reply\.reasoning, \{ total: Number\(reply\.reasoningChars\), onlyIfLonger: true \}\);/);
  // a closed chat takes its messages' reasoning state with it
  assert.match(body('closeChat'), /delete chats\[chatId\];\s*rsnSweep\(\);/);
  // the turn's end stops "thinking…": the stream's end, a chat leaving 'thinking', a followed turn's end
  assert.match(body('clearLiveActivity'), /finishReasoning\(msgId\);/);
  assert.match(app, /for \(const \[mid, st\] of reasonState\) if \(st\.live && st\.chatId === chatId\) finishReasoning\(mid\);/);
  // open, close, size, full size; Esc in the full view never reaches the chat box (where it pauses the reply)
  // every panel starts minimized, live or saved, and opening one is never carried over to the next
  assert.match(body('paintReasoning'), /box\.classList\.add\('collapsed'\);/);
  assert.doesNotMatch(body('paintReasoning'), /classList\.toggle\('collapsed'/);
  assert.doesNotMatch(body('toggleReasoningPanel'), /localStorage/);
  assert.doesNotMatch(app, /hub-reasoning-open|RSN_OPEN_KEY|rsnOpenPref/);
  assert.match(app, /const RSN_HEIGHT_KEY = 'hub-reasoning-height';/);
  assert.match(app, /if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); closeReasoningFull\(\); return; \}/);
  assert.match(app, /ov\.querySelector\('\.rsn-full-body'\)\.focus\(\{ preventScroll: true \}\);/);
  assert.match(app, /\(document\.activeElement === close \? body : close\)\.focus\(\);/, 'Tab stays inside the full view');
  assert.match(body('handleKeyDown'), /if \(event\.key === 'Escape'\) \{\s*if \(rsnFullFor\) \{ event\.preventDefault\(\); closeReasoningFull\(\); return; \}/, 'Esc in the chat box closes the full view before it could pause the reply');
  assert.doesNotMatch(app, /ov\.addEventListener\('focusout'/, 'no focus pulling against dialogs above the full view');
  const css = read('index.html');
  for (const sel of ['.reason-stream .rs-grip', '.reason-stream.collapsed .rs-body', '.rsn-full-overlay.open', '.rsn-full-body']) assert.ok(css.includes(sel), sel);
});

test('phone: the panel sits outside the reply body, follows every holder and shows saved reasoning', () => {
  const m = read('mobile.js');
  assert.match(m, /case 'reasoning': reasoningAdd\(rec, g\.text\); break;/);
  assert.match(m, /on\('turn_reasoning', onTurnReasoning\);/);
  assert.match(m, /el\.insertBefore\(box, holder\.bubble\.body && holder\.bubble\.body\.parentNode === el \? holder\.bubble\.body : el\.firstChild\);/);
  assert.match(m, /body\.textContent = rsnText\(r\);/);
  assert.match(m, /ra\.rsn = rec\.rsn;/, 'a lost stream\'s reasoning carries over to the re-attach');
  assert.match(m, /if \(rec\.rsn\) paintReasoning\(rec\);/, 'a reopened chat repaints its stream\'s panel');
  assert.match(m, /if \(r\.rsn\) paintReasoning\(r\);/, 'and its re-attach\'s');
  assert.match(m, /reasoningSet\(ra, turn\.reasoning, \{ live: !turn\.ended, total: Number\(turn\.reasoningChars\), onlyIfLonger: true \}\);/);
  assert.match(m, /reasoningSet\(entry\[1\], d\.turn\.reasoning, \{ live: !d\.turn\.ended, total: Number\(d\.turn\.reasoningChars\), onlyIfLonger: true \}\);/);
  assert.match(m, /if \(typeof m\.reasoning === 'string' && m\.reasoning\) reasoningSet\(\{ agent: current, bubble: b \}, m\.reasoning, \{ total: Number\(m\.reasoningChars\) \}\);/);
  // a finished reply in the open chat: the local history ("Load earlier", "Copy chat") is read back from the hub, which
  // saved the exchange with its reasoning; nothing patches it by hand any more
  assert.match(m, /if \(current === agent\) rereadHistory\(agent\);/);
  assert.match(m, /if \(ok\) rereadHistory\(ra\.agent\);/);
  assert.match(m, /rereadHistory\(t\.agent\);/);
  assert.match(m, /if \(seq !== histReadSeq \|\| gen !== histGen \|\| current !== agent \|\| streams\.has\(agent\) \|\| reattaches\.has\(agent\)\) return;/, 'the newest read wins, and only while the chat is still where it was');
  assert.doesNotMatch(m, /chatHistory\.push\(/);
  assert.match(m, /if \(attempt < 3\) setTimeout\(\(\) => \{ if \(seq === histReadSeq && gen === histGen\) rereadHistory\(agent, attempt \+ 1\); \}, 1000 \* 2 \*\* attempt\);/, 'a read the hub did not answer is tried again');
  assert.match(m, /if \(!lost\) \{ feedEnd\(rec\); reasoningEnd\(rec\); \}/);
  assert.match(m, /reattaches\.delete\(ra\.agent\);\s*reasoningEnd\(ra\);/);
  assert.match(m, /if \(t\) reasoningEnd\(t\);/);
  assert.match(m, /if \(onReasoningClick\(e\)\) return;/);
  assert.match(m, /\$\('messages'\)\.addEventListener\('pointerdown', onReasoningGrip\);/);
  // every panel starts closed, live or saved; a tap opens it, and that is never carried over to the next panel
  const mfn = (name) => { const i = m.indexOf(`function ${name}(`); return m.slice(i, m.indexOf('\n}\n', i)); };
  assert.match(mfn('paintReasoning'), /box\.classList\.add\('closed'\);/);
  assert.doesNotMatch(mfn('paintReasoning'), /classList\.toggle\('closed'/);
  assert.doesNotMatch(mfn('toggleReasoning'), /localStorage/);
  assert.doesNotMatch(m, /hub-mobile-reasoning-open|RSN_OPEN_KEY|rsnOpenPref/);
  const html = read('mobile.html');
  for (const sel of ['.rsn-grip', '.rsn.closed .rsn-body', '.rsn-sheet.open', '.rsn-sheet-body']) assert.ok(html.includes(sel), sel);
});
