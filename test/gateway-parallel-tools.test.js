'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { executeToolCallsBatched } = require('../lib/tool-concurrency');

const call = (id, name) => ({ id, function: { name, arguments: '{}' } });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function harness({ delays = {}, abortAfter = null, deny = new Set(), fail = new Set() } = {}) {
  const t0 = Date.now();
  const events = [];      // start/end/denied as they happen
  const appended = [];    // tool_result messages, in append order
  let live = 0, peak = 0, started = 0;
  const ctx = {
    nameOf: (tc) => tc.function.name,
    isAborted: () => abortAfter !== null && started >= abortAfter,
    abortError: () => Object.assign(new Error('aborted'), { code: 'ABORTED' }),
    begin: async (tc) => { events.push({ e: 'begin', id: tc.id }); return deny.has(tc.id) ? 'denied' : undefined; },
    finishDenied: async (tc) => { events.push({ e: 'denied', id: tc.id }); },
    execute: async (tc) => {
      started++; live++; peak = Math.max(peak, live);
      events.push({ e: 'start', id: tc.id, t: Date.now() - t0 });
      await sleep(delays[tc.id] ?? 40);
      live--;
      events.push({ e: 'end', id: tc.id, t: Date.now() - t0 });
      if (fail.has(tc.id)) throw new Error('fail ' + tc.id);
      return 'result-' + tc.id;
    },
    onResult: (tc, result) => { appended.push({ id: tc.id, result }); },
  };
  return { ctx, events, appended, peak: () => peak, elapsed: () => Date.now() - t0 };
}

test('three consult_agent calls in one message overlap', async () => {
  const h = harness({ delays: { a: 80, b: 80, c: 80 } });
  await executeToolCallsBatched([call('a', 'consult_agent'), call('b', 'consult_agent'), call('c', 'consult_agent')], h.ctx);
  assert.ok(h.peak() >= 2, 'peak concurrency ' + h.peak());
  assert.strictEqual(h.peak(), 3);
  assert.ok(h.elapsed() < 200, 'took ' + h.elapsed() + 'ms, one call is 80ms, three serial would be 240ms');
  assert.deepStrictEqual(h.appended.map(a => a.id), ['a', 'b', 'c']);
});

test('MCP-prefixed names are recognised too', async () => {
  const h = harness({ delays: { a: 60, b: 60 } });
  await executeToolCallsBatched([call('a', 'mcp__agent-hub__consult_agent'), call('b', 'mcp__agent-hub__consult_agent')], h.ctx);
  assert.strictEqual(h.peak(), 2);
});

test('a write between two safe tools splits the batches and runs in order', async () => {
  const h = harness({ delays: { a: 60, b: 60, w: 20, c: 30, d: 30 } });
  await executeToolCallsBatched([call('a', 'consult_agent'), call('b', 'read_memory'), call('w', 'write_memory'), call('c', 'consult_agent'), call('d', 'list_agents')], h.ctx);
  const at = (e, id) => h.events.find(x => x.e === e && x.id === id).t;
  assert.ok(at('start', 'w') >= Math.max(at('end', 'a'), at('end', 'b')), 'write waits for the first batch');
  assert.ok(at('start', 'c') >= at('end', 'w') && at('start', 'd') >= at('end', 'w'), 'second batch waits for the write');
  assert.ok(at('start', 'b') < at('end', 'a'), 'first batch overlapped');
  assert.ok(at('start', 'd') < at('end', 'c'), 'second batch overlapped');
  assert.deepStrictEqual(h.appended.map(a => a.id), ['a', 'b', 'w', 'c', 'd']);
});

test('tool_result messages keep call order even when a later call finishes first', async () => {
  const h = harness({ delays: { a: 90, b: 10, c: 40 } });
  await executeToolCallsBatched([call('a', 'consult_agent'), call('b', 'consult_agent'), call('c', 'consult_agent')], h.ctx);
  const ends = h.events.filter(e => e.e === 'end').map(e => e.id);
  assert.deepStrictEqual(ends, ['b', 'c', 'a'], 'completion order differs');
  assert.deepStrictEqual(h.appended.map(a => a.id), ['a', 'b', 'c']);
  assert.deepStrictEqual(h.appended.map(a => a.result), ['result-a', 'result-b', 'result-c']);
});

test('unsafe calls alone run strictly serially in order', async () => {
  const h = harness({ delays: { a: 20, b: 20 } });
  await executeToolCallsBatched([call('a', 'write_memory'), call('b', 'append_memory')], h.ctx);
  assert.strictEqual(h.peak(), 1);
  assert.deepStrictEqual(h.appended.map(a => a.id), ['a', 'b']);
});

test('abort before the second batch stops it; the first batch finishes', async () => {
  const h = harness({ delays: { a: 40, b: 40, w: 10 }, abortAfter: 2 });
  await assert.rejects(executeToolCallsBatched([call('a', 'consult_agent'), call('b', 'consult_agent'), call('w', 'write_memory')], h.ctx), (e) => e.code === 'ABORTED');
  assert.ok(!h.events.some(e => e.id === 'w' && e.e === 'start'), 'the write never started');
  assert.deepStrictEqual(h.appended.map(a => a.id), ['a', 'b'], 'in-flight calls finished and were recorded');
});

test('confirmation runs call by call before any execution of the batch; a denial short-circuits that call only', async () => {
  const h = harness({ delays: { a: 30, b: 30, c: 30 }, deny: new Set(['b']) });
  await executeToolCallsBatched([call('a', 'consult_agent'), call('b', 'consult_agent'), call('c', 'consult_agent')], h.ctx);
  const order = h.events.map(e => e.e + ':' + e.id);
  assert.deepStrictEqual(order.slice(0, 3), ['begin:a', 'begin:b', 'begin:c']);
  assert.ok(order.includes('denied:b') && !order.includes('start:b'));
  assert.deepStrictEqual(h.appended, [{ id: 'a', result: 'result-a' }, { id: 'b', result: 'denied' }, { id: 'c', result: 'result-c' }]);
});

test('a failing call lets its siblings settle, records the ones before it, then rethrows', async () => {
  const h = harness({ delays: { a: 20, b: 20, c: 50 }, fail: new Set(['b']) });
  await assert.rejects(executeToolCallsBatched([call('a', 'consult_agent'), call('b', 'consult_agent'), call('c', 'consult_agent')], h.ctx), /fail b/);
  assert.ok(h.events.some(e => e.e === 'end' && e.id === 'c'), 'c was allowed to finish');
  assert.deepStrictEqual(h.appended.map(a => a.id), ['a']);
});

test('the gateway loop hands its tool calls to the batched executor', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(src, /await executeToolCallsBatched\(assistantMsg\.tool_calls, \{/);
  assert.doesNotMatch(src, /for \(const tc of assistantMsg\.tool_calls\)/);
});
