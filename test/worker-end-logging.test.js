'use strict';
// Two log lines for finding where a temporary worker's end gets lost: the hub's turn tap logs an end for a worker it
// never saw start (lib/hub-events.js), and runSpawnWorkers logs the caller's stream state at each worker end
// (lib/sdk-chat.js workerEndLogLine). Ids and flags only, never a worker's label or task.
const { test } = require('node:test');
const assert = require('node:assert');
const { createHubEvents } = require('../lib/hub-events');

const sse = (gateway) => 'data: ' + JSON.stringify({ choices: [{ delta: {} }], gateway }) + '\n\n';

test('the turn tap logs nothing for an end of a worker it saw start', () => {
  const lines = [];
  const hub = createHubEvents({ log: (l) => lines.push(l) });
  const res = { write: () => true };
  const tap = hub.tapTurn(res, { agent: 'sam', origin: { kind: 'user' }, message: 'hi' });
  res.write(sse({ type: 'worker_started', worker_id: 'tw-sam-1-abcd', agent_type: 'temporal', description: 'Worker: secret label', prompt: 'secret task' }));
  res.write(sse({ type: 'worker_completed', worker_id: 'tw-sam-1-abcd' }));
  tap.finish(true);
  assert.deepStrictEqual(lines, []);
});

test('the turn tap logs one line, ids only, for an end of a worker it never saw start', () => {
  const lines = [];
  const hub = createHubEvents({ log: (l) => lines.push(l) });
  const res = { write: () => true };
  const tap = hub.tapTurn(res, { agent: 'sam', origin: { kind: 'user' }, message: 'hi', turnId: 'sam-t1' });
  res.write(sse({ type: 'worker_failed', worker_id: 'tw-sam-2-beef', error: 'secret error text' }));
  tap.finish(true);
  assert.deepStrictEqual(lines, ['[hub-events] sam turn sam-t1: end of unknown worker tw-sam-2-beef']);
  assert.ok(!/secret/.test(lines[0]), 'no worker text in the line');
});

test('a logger that throws never breaks the turn tap', () => {
  const hub = createHubEvents({ log: () => { throw new Error('log down'); } });
  const res = { write: () => true };
  const tap = hub.tapTurn(res, { agent: 'sam', origin: { kind: 'user' }, message: 'hi' });
  assert.doesNotThrow(() => res.write(sse({ type: 'worker_completed', worker_id: 'tw-sam-3-cafe' })));
  tap.finish(true);
});

test('workerEndLogLine: the caller stream state at a worker end (live and tapped, ended, none)', () => {
  const { workerEndLogLine } = require('../lib/sdk-chat');
  const hub = createHubEvents({ log: () => {} });
  const res = { write: () => true, writableEnded: false, destroyed: false };
  const tap = hub.tapTurn(res, { agent: 'sam', origin: { kind: 'user' }, message: 'hi' });
  assert.strictEqual(workerEndLogLine('tw-sam-1-abcd', res), '[workers] tw-sam-1-abcd end -> caller stream ended=false destroyed=false tapped=true');
  tap.finish(true);
  res.writableEnded = true;
  assert.strictEqual(workerEndLogLine('tw-sam-1-abcd', res), '[workers] tw-sam-1-abcd end -> caller stream ended=true destroyed=false tapped=false');
  assert.strictEqual(workerEndLogLine('tw-sam-1-abcd', null), '[workers] tw-sam-1-abcd end -> caller stream none');
});

test('runSpawnWorkers logs that line at every worker end', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  const at = src.indexOf('async function runSpawnWorkers(');
  const body = src.slice(at, src.indexOf('\nfunction consultViaHubNow(', at));
  assert.match(body, /onDone: \(r, v\) => \{[\s\S]*console\.log\(workerEndLogLine\(v\.id, sseRes\)\);/);
});

test('a tap that finished reads as not tapped even when another wrapper restores observeClosed (the transcript tap does)', () => {
  const { workerEndLogLine } = require('../lib/sdk-chat');
  const hub = createHubEvents({ log: () => {} });
  const res = { write: () => true, writableEnded: false, destroyed: false };
  const tap = hub.tapTurn(res, { agent: 'sam', origin: { kind: 'user' }, message: 'hi' });
  // a second wrapper installed after the hub tap, the way lib/transcript.js tapTurn does it, finished after it
  const prevObserve = res.observeClosed;
  res.observeClosed = (d) => prevObserve(d);
  tap.finish(true);
  res.observeClosed = prevObserve;   // the second wrapper's finish restores what it found
  assert.strictEqual(typeof res.observeClosed, 'function');
  assert.match(workerEndLogLine('tw-sam-1-abcd', res), /tapped=false$/);
});

test('the unknown-worker line clips and cleans the id', () => {
  const lines = [];
  const hub = createHubEvents({ log: (l) => lines.push(l) });
  const res = { write: () => true };
  const tap = hub.tapTurn(res, { agent: 'sam', origin: { kind: 'user' }, message: 'hi', turnId: 'sam-t2' });
  res.write(sse({ type: 'worker_completed', worker_id: 'tw-x\n[forged] line' + 'z'.repeat(200) }));
  tap.finish(true);
  assert.strictEqual(lines.length, 1);
  assert.ok(!/\n/.test(lines[0]), 'no newline');
  assert.ok(lines[0].length < 130, 'clipped');
});
