'use strict';
// Voice calls: a sentence written before a tool call is spoken when the tool starts, not after it finishes.
// Server: the text waiting for its throttled turn_delta goes out before the tool's turn_activity.
// Controller: when a tool of the running reply starts, a finished last sentence is spoken at once; an unfinished one stays held,
// and the same text arriving again does not take it back or read the reply again.
const { test } = require('node:test');
const assert = require('node:assert');
const { createHubEvents } = require('../lib/hub-events');
Object.assign(globalThis, require('../lib/ui-voice'), require('../lib/ui-voice-thinking'));   // the call file uses these helpers as globals, like the pages
const { voiceCreateCall } = require('../lib/ui-voice-call');

const tick = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- server: event order ----

function fakeRes() { const r = { chunks: [], write: (s) => { r.chunks.push(s); return true; } }; return r; }
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const text = (res, content) => sse(res, { choices: [{ delta: { content } }] });
const gw = (res, gateway) => sse(res, { choices: [{ delta: {} }], gateway });

test('server: the text written just before a tool reaches the page before the tool activity', async () => {
  const hub = createHubEvents();
  const events = []; hub.onPublish(ev => events.push(ev));
  const res = fakeRes();
  const tap = hub.tapTurn(res, { agent: 'sam', origin: { kind: 'user' }, message: 'weather?', turnId: 'tE1' });
  text(res, 'Let me check that for you.');
  gw(res, { type: 'tool_start', tool: 'WebSearch', tool_call_id: 'c1' });
  const order = events.filter(e => e.type === 'turn_delta' || e.type === 'turn_activity').map(e => e.type === 'turn_delta' ? 'delta:' + e.text : 'activity');
  assert.deepStrictEqual(order, ['delta:Let me check that for you.', 'activity'], 'the text first, at once, then the tool');
  await sleep(400);
  assert.strictEqual(events.filter(e => e.type === 'turn_delta').length, 1, 'no second update of the same text once the timer fired early');
  text(res, '\n\nIt is sunny.');
  await sleep(400);
  const deltas = events.filter(e => e.type === 'turn_delta').map(e => e.text);
  assert.deepStrictEqual(deltas, ['Let me check that for you.', 'Let me check that for you.\n\nIt is sunny.'], 'text after the tool is throttled as before');
  tap.finish(true);
});

test('server: with no text waiting, a tool activity sends no text update', () => {
  const hub = createHubEvents();
  const events = []; hub.onPublish(ev => events.push(ev));
  const res = fakeRes();
  const tap = hub.tapTurn(res, { agent: 'sam', origin: { kind: 'user' }, message: 'go', turnId: 'tE2' });
  gw(res, { type: 'tool_start', tool: 'Bash', tool_call_id: 'c1' });
  assert.deepStrictEqual(events.filter(e => e.type === 'turn_delta'), []);
  assert.strictEqual(events.filter(e => e.type === 'turn_activity').length, 1);
  tap.finish(true);
});

// ---- controller ----

function harness() {
  const h = { t: 0, timers: [], nextId: 1, spoken: [], pend: [], sent: [], running: false };
  h.setTimer = (fn, ms) => { const id = h.nextId++; h.timers.push({ id, at: h.t + ms, fn }); return id; };
  h.clearTimer = (id) => { h.timers = h.timers.filter(x => x.id !== id); };
  h.speak = (t) => new Promise((resolve) => { h.spoken.push(t); h.pend.push(resolve); });
  h.finish = async (ok = true) => { const r = h.pend.shift(); if (r) r(ok); await tick(); };
  h.deps = {
    agent: 'sam', now: () => h.t, setTimer: h.setTimer, clearTimer: h.clearTimer, prefs: () => ({ continueWait: 0 }),
    vad: { start: async (hd) => { h.handlers = hd; }, stop() {}, setPlaybackActive() {} },
    stt: async (audio) => audio.text, isTurnRunning: () => h.running,
    send: async (t) => { h.sent.push(t); h.running = true; }, interject: async () => {},
    stop: () => {}, speak: h.speak, cancelSpeech: () => { const r = h.pend.shift(); if (r) r(false); }, answerAsk: () => {},
    server: { start: async () => ({ callId: 'c1', held: [] }), heartbeat: async () => ({ held: [] }), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} },
    ui: { state() {}, heard() {}, held() {}, toast() {}, summary() {}, level() {}, activity() {} },
  };
  h.call = voiceCreateCall(h.deps);
  h.say = async (t) => { h.handlers.onSpeechStart(); h.handlers.onSpeechEnd({ text: t }); await tick(); };
  return h;
}
async function asked() {
  const h = harness();
  assert.strictEqual(await h.call.start(), true);
  await h.say('What is the weather today?');
  assert.deepStrictEqual(h.sent, ['What is the weather today?']);
  return h;
}
const TOOL = { kind: 'tool', tool: 'WebSearch', status: 'running', summary: 'weather' };

test('a finished sentence written before a tool is spoken when the tool starts', async () => {
  const h = await asked();
  h.call.onReplyText('Let me check that for you.', false);
  await tick();
  assert.deepStrictEqual(h.spoken, [], 'while streaming, the last sentence waits for what follows it');
  h.call.onActivity(TOOL);
  await tick();
  assert.deepStrictEqual(h.spoken, ['Let me check that for you.'], 'spoken as soon as the tool starts');
});

test('an unfinished sentence before a tool stays held; so does a lone list number', async () => {
  let h = await asked();
  h.call.onReplyText('Let me check', false);
  h.call.onActivity(TOOL);
  await tick();
  assert.deepStrictEqual(h.spoken, []);
  h = await asked();
  h.call.onReplyText('Here are the steps:\n1.', false);
  h.call.onActivity(TOOL);
  await tick();
  assert.deepStrictEqual(h.spoken, []);
});

test('the reply after the tool goes on from there: nothing is repeated, even when the same text arrives again', async () => {
  const h = await asked();
  h.call.onReplyText('Sure. Let me check that for you.', false);
  await tick();
  assert.deepStrictEqual(h.spoken, ['Sure.']);
  h.call.onActivity(TOOL);
  h.call.onActivity(Object.assign({}, TOOL, { status: 'done' }));   // more activity: no second release
  await h.finish();
  assert.deepStrictEqual(h.spoken, ['Sure.', 'Let me check that for you.']);
  h.call.onReplyText('Sure. Let me check that for you.', false);   // a late or repeated update of the same text
  await h.finish();
  assert.deepStrictEqual(h.spoken, ['Sure.', 'Let me check that for you.'], 'not read again from the start');
  h.call.onReplyText('Sure. Let me check that for you.\n\nIt is sunny and warm. ', false);
  await tick();
  assert.deepStrictEqual(h.spoken, ['Sure.', 'Let me check that for you.', 'It is sunny and warm.']);
  h.call.onReplyText('Sure. Let me check that for you.\n\nIt is sunny and warm. Enjoy the day.', true);
  await h.finish();
  assert.deepStrictEqual(h.spoken, ['Sure.', 'Let me check that for you.', 'It is sunny and warm.', 'Enjoy the day.']);
});

test('a reply that ends with the sentence before the tool is spoken once, at the tool, not again at the end', async () => {
  const h = await asked();
  h.call.onReplyText('Let me check that for you.', false);
  h.call.onActivity(TOOL);
  await tick();
  h.call.onReplyText('Let me check that for you.', true);
  await h.finish();
  assert.deepStrictEqual(h.spoken, ['Let me check that for you.']);
});

test('a new turn forgets the released text of the last one', async () => {
  const h = await asked();
  h.call.onReplyText('Let me check that for you.', false);
  h.call.onActivity(TOOL);
  await tick();
  h.call.onReplyText('Let me check that for you.', true);
  await h.finish();
  h.running = false;
  await h.say('And tomorrow?');
  h.call.onReplyText('Let me check that for you.', false);   // the same words in the next reply: held until a tool or more text
  await tick();
  assert.deepStrictEqual(h.spoken, ['Let me check that for you.']);
});

test('both pages carry the same controller code', () => {
  const fs = require('fs');
  const path = require('path');
  for (const page of ['app.js', 'mobile.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', page), 'utf8');
    assert.ok(src.includes('function speakBeforeTool()') && src.includes('speakBeforeTool();') && src.includes('toolBreakText = null;'), page);
  }
});
