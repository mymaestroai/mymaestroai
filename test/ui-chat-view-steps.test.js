'use strict';
// lib/ui-chat-view.js step helpers: the running tool calls of one agent.
const { test } = require('node:test');
const assert = require('node:assert');
const V = require('../lib/ui-chat-view.js');

const tool = (name, status, callId, extra = {}) => ({ kind: 'tool', tool: name, status, ...(callId != null ? { callId } : {}), ...extra });
const newest = (st) => { const i = V.chatViewStepsNewest(st); return i ? i.callId : null; };

test('parallel calls: the newest running call is the step; the first one shows again when it finishes', () => {
  const st = V.chatViewStepsNew();
  assert.strictEqual(V.chatViewStepsNewest(st), null);
  assert.strictEqual(V.chatViewStepsOn(st, 't1', tool('Bash', 'running', 'b')), true);
  assert.strictEqual(V.chatViewStepsOn(st, 't1', tool('Read', 'running', 'r')), true);
  assert.strictEqual(newest(st), 'r');
  assert.strictEqual(V.chatViewStepsOn(st, 't1', tool('Read', 'done', 'r')), true);
  assert.strictEqual(newest(st), 'b');
  assert.strictEqual(V.chatViewStepsOn(st, 't1', tool('Bash', 'done', 'b')), true);
  assert.strictEqual(V.chatViewStepsNewest(st), null);
});

test('a running item with the same turn and callId replaces the old one; non-tool items and unknown statuses change nothing', () => {
  const st = V.chatViewStepsNew();
  V.chatViewStepsOn(st, 't1', tool('Bash', 'running', 'b', { summary: 'one' }));
  V.chatViewStepsOn(st, 't1', tool('Bash', 'running', 'b', { summary: 'two' }));
  assert.strictEqual(st.calls.length, 1);
  assert.strictEqual(V.chatViewStepsNewest(st).summary, 'two');
  assert.strictEqual(V.chatViewStepsOn(st, 't1', { kind: 'worker', status: 'running' }), false);
  assert.strictEqual(V.chatViewStepsOn(st, 't1', tool('Bash', 'weird', 'b')), false);
  assert.strictEqual(V.chatViewStepsOn(null, 't1', tool('Bash', 'running', 'b')), false);
});

test('done without a callId closes the newest call of that turn only', () => {
  const st = V.chatViewStepsNew();
  V.chatViewStepsOn(st, 'A', tool('Bash', 'running', null));
  V.chatViewStepsOn(st, 'B', tool('Read', 'running', null));
  assert.strictEqual(V.chatViewStepsOn(st, 'A', tool('Bash', 'done', null)), true);
  assert.deepStrictEqual(st.calls.map(c => c.turnId), ['B']);
  assert.strictEqual(V.chatViewStepsOn(st, 'A', tool('Bash', 'done', null)), false, 'nothing of A left');
  assert.strictEqual(st.done.length, 0, 'no callId: nothing is remembered');
});

test('a done for an unknown callId changes nothing but is remembered', () => {
  const st = V.chatViewStepsNew();
  V.chatViewStepsOn(st, 't1', tool('Bash', 'running', 'b'));
  assert.strictEqual(V.chatViewStepsOn(st, 't1', tool('Bash', 'done', 'zzz')), false);
  assert.strictEqual(newest(st), 'b');
  assert.ok(st.done.includes('t1|zzz'));
});

test('same callId in two turns are two calls; ending a turn removes only its calls', () => {
  const st = V.chatViewStepsNew();
  V.chatViewStepsOn(st, 'A', tool('Bash', 'running', 'x'));
  V.chatViewStepsOn(st, 'B', tool('Read', 'running', 'x'));
  assert.strictEqual(st.calls.length, 2);
  assert.strictEqual(V.chatViewStepsEndTurn(st, 'B'), true);
  assert.strictEqual(newest(st), 'x');
  assert.strictEqual(V.chatViewStepsNewest(st).tool, 'Bash');
  assert.strictEqual(V.chatViewStepsEndTurn(st, 'B'), false, 'already gone');
  assert.strictEqual(V.chatViewStepsEndTurn(st), true, 'no turnId: all go');
  assert.strictEqual(V.chatViewStepsNewest(st), null);
  assert.strictEqual(V.chatViewStepsEndTurn(undefined, 'A'), false);
});

test('a running item already seen done is ignored', () => {
  const st = V.chatViewStepsNew();
  V.chatViewStepsOn(st, 't1', tool('Bash', 'running', 'b'));
  V.chatViewStepsOn(st, 't1', tool('Bash', 'done', 'b'));
  assert.strictEqual(V.chatViewStepsOn(st, 't1', tool('Bash', 'running', 'b')), false);
  assert.strictEqual(V.chatViewStepsNewest(st), null);
});

test('snapshot: still-running calls of a fetched turn join; finished and already-listed ones do not', () => {
  const st = V.chatViewStepsNew();
  V.chatViewStepsOn(st, 't9', tool('Read', 'running', 'live'));
  const activity = [tool('Read', 'running', 'a'), tool('Read', 'done', 'a'), tool('Bash', 'running', 'b', { summary: 'npm test' }), tool('Read', 'running', 'live')];
  assert.strictEqual(V.chatViewStepsSnapshot(st, 't9', activity), true);
  assert.deepStrictEqual(st.calls.map(c => c.item.callId), ['live', 'b']);
  assert.strictEqual(V.chatViewStepsSnapshot(st, 't9', activity), false, 'a second merge adds nothing');
  assert.strictEqual(V.chatViewStepsSnapshot(st, 't9', 'nope'), false);
});

test('snapshot: a call seen done before the snapshot arrives is never brought back; a done in the snapshot removes a live call', () => {
  const st = V.chatViewStepsNew();
  V.chatViewStepsOn(st, 't9', tool('Bash', 'running', 'k1'));
  V.chatViewStepsOn(st, 't9', tool('Bash', 'done', 'k1'));
  assert.strictEqual(V.chatViewStepsSnapshot(st, 't9', [tool('Bash', 'running', 'k1')]), false);
  assert.strictEqual(V.chatViewStepsNewest(st), null);
  V.chatViewStepsOn(st, 't9', tool('Read', 'running', 'k2'));
  assert.strictEqual(V.chatViewStepsSnapshot(st, 't9', [tool('Read', 'running', 'k2'), tool('Read', 'done', 'k2')]), true);
  assert.strictEqual(V.chatViewStepsNewest(st), null);
});

test('the done list keeps at most 50 keys, the oldest go first', () => {
  const st = V.chatViewStepsNew();
  for (let i = 0; i < 60; i++) V.chatViewStepsOn(st, 't', tool('Read', 'done', 'c' + i));
  assert.strictEqual(st.done.length, 50);
  assert.strictEqual(st.done[0], 't|c10');
  assert.strictEqual(st.done[49], 't|c59');
  // the oldest forgotten key is no longer guarded; a recent one is
  assert.strictEqual(V.chatViewStepsOn(st, 't', tool('Read', 'running', 'c0')), true);
  assert.strictEqual(V.chatViewStepsOn(st, 't', tool('Read', 'running', 'c59')), false);
  const st2 = V.chatViewStepsNew();
  V.chatViewStepsSnapshot(st2, 't', Array.from({ length: 60 }, (_, i) => tool('Read', 'done', 'c' + i)));
  assert.strictEqual(st2.done.length, 50);
});
