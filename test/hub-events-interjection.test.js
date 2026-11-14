'use strict';
// While an agent's turn runs, its conversation lines are not yet a finished reply. A reply that was interrupted by the
// person's interjection is saved in pieces around the interjection line ([piece 1][interjection][piece 2]), so
// markInProgress flags every line of the running turn (not only a last assistant line), and the hub's turn view
// journals the interjection (activity item kind 'interjection') at the point of the reply where it came.
const { test } = require('node:test');
const assert = require('node:assert');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const path = require('path');
const ISO = makeIsolatedInstall('hub-events-ij-iso-');
const { createHubEvents, markInProgress } = require(path.join(ISO.lib, 'hub-events'));

const T0 = '2026-11-14T12:00:00.000Z';
const at = (s) => new Date(Date.parse(T0) + s * 1000).toISOString();
const running = { active: true, startedAt: T0 };
const flags = (h) => h.map(e => !!e.inProgress);

test('markInProgress flags every line of the running turn: the reply pieces and the interjection lines between them', () => {
  const h = [
    { ts: at(-60), role: 'user', content: 'earlier question' },
    { ts: at(-55), role: 'assistant', content: 'earlier answer' },
    { ts: at(0), role: 'user', content: 'go' },
    { ts: at(5), role: 'assistant', content: 'Part one. ' },
    { ts: at(6), role: 'user', content: '[OPERATOR INTERJECTION]: hurry', interjection: { id: 'ij-1', transport: 'sdk-live' } },
    { ts: at(9), role: 'assistant', content: 'Part two. ', base: 10 },
    { ts: at(10), role: 'user', content: '[EMERGENCY INTERJECTION]: stop', interjection: { id: 'ij-2', transport: 'sdk-live', priority: 'emergency' } },
    { ts: at(12), role: 'assistant', content: 'Part three.', base: 20 },
  ];
  markInProgress(h, running);
  assert.deepStrictEqual(flags(h), [false, false, false, true, true, true, true, true], 'the earlier turn and the person\'s own message are not flagged; everything of the running turn is');
});

test('markInProgress flags a turn whose last line is an interjection (the reply has not gone on yet)', () => {
  const h = [
    { ts: at(0), role: 'user', content: 'go' },
    { ts: at(5), role: 'assistant', content: 'Part one. ' },
    { ts: at(6), role: 'user', content: '[OPERATOR INTERJECTION]: hurry', interjection: { id: 'ij-1' } },
  ];
  markInProgress(h, running);
  assert.deepStrictEqual(flags(h), [false, true, true]);
});

test('markInProgress flags nothing once the turn is over, or with no turn', () => {
  const mk = () => [
    { ts: at(0), role: 'user', content: 'go' },
    { ts: at(5), role: 'assistant', content: 'Part one. ' },
    { ts: at(6), role: 'user', content: '[OPERATOR INTERJECTION]: hurry', interjection: { id: 'ij-1' } },
    { ts: at(9), role: 'assistant', content: 'Part two. ', base: 10 },
  ];
  for (const turn of [null, undefined, { active: false, startedAt: T0 }]) {
    const h = mk();
    markInProgress(h, turn);
    assert.deepStrictEqual(flags(h), [false, false, false, false]);
  }
  assert.doesNotThrow(() => markInProgress(undefined, running));
});

test('markInProgress keeps its old rules: a question line is flagged only as the last line, an older turn\'s lines never', () => {
  const h = [
    { ts: at(-30), role: 'assistant', content: 'old reply' },
    { ts: at(0), role: 'user', content: 'go' },
    { ts: at(2), role: 'assistant', content: '❓ Which one? [A / B]', ask: true },
    { ts: at(8), role: 'user', content: '↳ A', ask: true },
    { ts: at(9), role: 'assistant', content: 'Going with A.' },
    { ts: at(10), role: 'assistant', content: '❓ Sure? [Yes / No]', ask: true },
  ];
  markInProgress(h, running);
  assert.deepStrictEqual(flags(h), [false, false, false, false, true, true]);
});

test('BF1-1: a turn that ended 0.5 s before this one began is not flagged; only this turn\'s pieces and interjection are', () => {
  const h = [
    { ts: at(-5), role: 'user', content: 'first prompt' },
    { ts: at(-0.001), role: 'assistant', content: 'first answer' },
    { ts: at(0.5), role: 'user', content: 'second prompt' },
    { ts: at(2), role: 'assistant', content: 'piece one' },
    { ts: at(3), role: 'user', content: '[OPERATOR INTERJECTION]: hurry', interjection: { id: 'ij-1' } },
    { ts: at(4), role: 'assistant', content: 'piece two', base: 9 },
  ];
  markInProgress(h, { active: true, startedAt: at(0.5) });
  assert.deepStrictEqual(flags(h), [false, false, false, true, true, true]);
});

test('the hub\'s turn view journals an interjection with the turn\'s activity, at the point of the reply where it came, and publishes it', () => {
  const hub = createHubEvents();
  const out = [];
  hub.onPublish(ev => out.push(ev));
  const res = { write: () => true };
  const tap = hub.tapTurn(res, { agent: 'maestro', origin: { kind: 'user' }, message: 'go' });
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Part one. ' } }] }) + '\n\n');
  const item = hub.noteInterjection('maestro', { message: 'hurry', priority: 'emergency', ts: '2026-11-14T12:00:07.000Z' });
  assert.ok(item && item.id);
  assert.strictEqual(item.kind, 'interjection');
  assert.strictEqual(item.at, 'Part one. '.length);
  const view = hub.turnFor('maestro');
  const j = view.activity.find(a => a.kind === 'interjection');
  assert.deepStrictEqual([j.message, j.priority, j.at, j.ts], ['hurry', 'emergency', 10, '2026-11-14T12:00:07.000Z']);
  const pub = out.find(e => e.type === 'turn_activity' && e.item.kind === 'interjection');
  assert.ok(pub && pub.agent === 'maestro' && pub.item.id === item.id, 'a page following the turn gets it as a turn_activity event');
  // the same journal is replayed by the turn start's activity list and the turn view for a page that attaches later
  assert.strictEqual(hub.noteInterjection('nobody', { message: 'x' }), null, 'no running turn: nothing to journal');
  assert.strictEqual(hub.noteInterjection('maestro', { message: '' }), null);
  tap.finish(true);
  assert.strictEqual(hub.noteInterjection('maestro', { message: 'late' }), null, 'a finished turn takes no more');
});
