'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const hubEvents = require('../lib/hub-events');
const sdkChat = require('../lib/sdk-chat');
const { sendSSE, makeChunk, setTestStreamer } = sdkChat.__turn;
const { runAskUser, questionAgents } = sdkChat.__askUser;

const AGENT = 'zz_allturns_a';
after(() => { setTestStreamer(null); try { fs.unlinkSync(path.join(__dirname, '..', 'data', 'conversations', `${AGENT}.jsonl`)); } catch {} });
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

function sseClient(headers = {}) {
  const out = [];
  return {
    out, headers, writableLength: 0, destroyed: false,
    writeHead() {}, on() {}, destroy() { this.destroyed = true; },
    write(s) { out.push(s); return true; },
    frames() { return out.join('').split('\n\n').filter(f => f && !f.startsWith(':')).map(f => { const m = {}; for (const l of f.split('\n')) { const i = l.indexOf(': '); if (i > 0) m[l.slice(0, i)] = l.slice(i + 2); } return { event: m.event, id: m.id, data: m.data ? JSON.parse(m.data) : null }; }); },
  };
}

test('a user-origin turn is published: turn_start (startedAt, activity), throttled turn_delta, turn_end (endedAt)', async () => {
  const seen = [];
  const off = hubEvents.events.onPublish(ev => { if (ev.agent === AGENT) seen.push(ev); });
  setTestStreamer(async ({ res }) => { sendSSE(res, makeChunk('Hello ', 'm')); await tick(350); sendSSE(res, makeChunk('there', 'm')); });
  await sdkChat.handleChatStream({ agent: AGENT, message: 'hi' }, { writableEnded: false, destroyed: false, on() {}, writeHead() {}, write() { return true; }, end() { this.writableEnded = true; } });
  off();
  const types = seen.map(e => e.type);
  assert.strictEqual(types[0], 'turn_start');
  assert.ok(types.includes('turn_delta'));
  assert.strictEqual(types[types.length - 1], 'turn_end');
  const [start] = seen;
  assert.deepStrictEqual(start.origin, { kind: 'user' });
  assert.strictEqual(start.activity, 'replying to you');
  assert.ok(!isNaN(Date.parse(start.startedAt)));
  assert.strictEqual(start.agent, AGENT);
  const end = seen.at(-1);
  assert.strictEqual(end.turnId, start.turnId);
  assert.strictEqual(end.ok, true);
  assert.strictEqual(end.error, null);
  assert.strictEqual(end.reply, 'Hello there');
  assert.ok(!isNaN(Date.parse(end.endedAt)));
  assert.ok(seen.filter(e => e.type === 'turn_delta').length <= 2, 'deltas are throttled');
});

test('ephemeral turns are not published', async () => {
  const seen = [];
  const off = hubEvents.events.onPublish(ev => { if (ev.agent === AGENT) seen.push(ev); });
  setTestStreamer(async ({ res }) => { sendSSE(res, makeChunk('quiet', 'm')); });
  await sdkChat.handleChatStream({ agent: AGENT, message: 'hi', ephemeral: true }, { writableEnded: false, destroyed: false, on() {}, writeHead() {}, write() { return true; }, end() {} });
  off();
  assert.deepStrictEqual(seen, []);
});

test('hub origins keep their kind and gain a label for scheduled tasks', () => {
  const ev = hubEvents.createHubEvents();
  const seen = [];
  ev.onPublish(e => seen.push(e));
  const res = { write() { return true; } };
  const tap = ev.tapTurn(res, { agent: 'a', origin: { kind: 'schedule', from: 'Nightly' }, message: 'm' });
  tap.finish();
  assert.deepStrictEqual(seen[0].origin, { kind: 'schedule', from: 'Nightly', label: 'Nightly' });
  assert.strictEqual(seen[0].activity, 'scheduled task: Nightly');
});

test('a new subscriber gets hello then status_snapshot; Last-Event-ID replay still works', () => {
  const ev = hubEvents.createHubEvents();
  ev.setStatusProvider(() => ({ a: { busy: true, busySince: '2026-01-01T00:00:00.000Z', activity: 'replying to you', pendingQuestion: false } }));
  ev.publish('turn_start', { turnId: 't1', agent: 'a' });
  ev.publish('turn_end', { turnId: 't1', agent: 'a' });

  const fresh = sseClient({});
  ev.subscribe({ headers: {} }, fresh);
  let frames = fresh.frames();
  assert.deepStrictEqual(frames.map(f => f.event), ['hello', 'status_snapshot']);
  assert.deepStrictEqual(frames[1].data.agents.a, { busy: true, busySince: '2026-01-01T00:00:00.000Z', activity: 'replying to you', pendingQuestion: false });

  const back = sseClient();
  ev.subscribe({ headers: { 'last-event-id': '1' } }, back);
  frames = back.frames();
  assert.deepStrictEqual(frames.map(f => f.event), ['turn_end', 'hello', 'status_snapshot']);
});

test('the hub-wide snapshot comes from the live registry', () => {
  const client = sseClient();
  hubEvents.events.subscribe({ headers: {} }, client);
  const snap = client.frames().find(f => f.event === 'status_snapshot');
  assert.ok(snap && typeof snap.data.agents === 'object');
});

test('runAskUser emits ask_user and ask_user_done (answered, and timed out)', async () => {
  const seen = [];
  const off = hubEvents.events.onPublish(ev => { if (ev.agent === AGENT && ev.type.startsWith('ask_user')) seen.push(ev); });
  const res = { writableEnded: false, destroyed: false, on() {}, write() { return true; } };

  const p = runAskUser(AGENT, res, { question: 'Which?', options: ['A', 'B'] });
  await tick();
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].type, 'ask_user');
  assert.strictEqual(seen[0].question, 'Which?');
  assert.deepStrictEqual(seen[0].options, ['A', 'B', 'Skip']);
  assert.ok(questionAgents.has(seen[0].request_id));
  sdkChat.handleAskResponse({ request_id: seen[0].request_id, answers: { 0: 'A' } });
  await p;
  assert.strictEqual(seen[1].type, 'ask_user_done');
  assert.strictEqual(seen[1].request_id, seen[0].request_id);
  assert.strictEqual(questionAgents.has(seen[0].request_id), false);

  assert.strictEqual(await runAskUser(AGENT, res, { question: 'Anyone?' }, { timeoutMs: 15 }), 'NO_ANSWER');
  assert.deepStrictEqual(seen.slice(2).map(e => e.type), ['ask_user', 'ask_user_done']);
  off();
});
