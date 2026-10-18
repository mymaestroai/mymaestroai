'use strict';
// Elastic context for gateway/local models (lib/context-budget): window discovery, the per-prompt plan,
// fitting the newest turns into a token budget, and slicing archive rows for assisted compression.
const { test } = require('node:test');
const assert = require('node:assert');
const cb = require('../lib/context-budget');

test('windows: explicit agent setting > LM Studio loaded context > table > defaults', async () => {
  assert.strictEqual(cb.knownWindow('google/gemini-pro-latest'), 1000000);
  assert.strictEqual(cb.knownWindow('openai/gpt-5.4-mini'), 400000);
  assert.strictEqual(cb.knownWindow('lmstudio/qwen/qwen3.6-27b'), 128000);
  assert.strictEqual(cb.knownWindow('lmstudio/some/unknown-7b'), cb.DEFAULT_LOCAL);
  assert.strictEqual(cb.knownWindow('openai/unknown'), cb.DEFAULT_CLOUD);
  assert.deepStrictEqual(await cb.windowForAgent({ contextWindow: 16384 }, 'lmstudio/x'), { window: 16384, source: 'agent' });
  const probe = async () => new Map([['qwen/qwen3.6-27b', 40960]]);
  assert.deepStrictEqual(await cb.windowForAgent({}, 'lmstudio/qwen/qwen3.6-27b', { probe }), { window: 40960, source: 'lmstudio' });
  assert.deepStrictEqual(await cb.windowForAgent({}, 'lmstudio/qwen/qwen3.6-27b', { probe: async () => new Map() }), { window: 128000, source: 'table' });
  assert.deepStrictEqual(await cb.windowForAgent({}, 'openai/gpt-5', { probe: async () => { throw new Error('never called'); } }), { window: 400000, source: 'table' });
  // probe parses LM Studio's shape and tolerates a dead server
  const models = await cb.probeLmStudio('http://127.0.0.1:1/v1', { now: () => 1, fetchImpl: async () => JSON.stringify({ data: [{ id: 'm', loaded_context_length: 8192, max_context_length: 32768 }, { id: 'n', max_context_length: 4096 }] }) });
  assert.deepStrictEqual([...models.entries()], [['m', 8192], ['n', 4096]]);
  assert.deepStrictEqual([...(await cb.probeLmStudio('http://127.0.0.1:2/v1', { now: () => 1, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } })).entries()], []);
});

test('plan: proportions of the window, records never above the agent cap, reply reserve clamped', () => {
  const p = cb.plan(32768, { recordsCapBytes: 256 * 1024 });
  assert.strictEqual(p.window, 32768);
  assert.strictEqual(p.replyTokens, 3932);
  assert.strictEqual(p.recentTokens, 14746);
  assert.ok(p.recordsBytes < 40000 && p.recordsBytes > 30000, 'records ~30% of a 32K window in chars');
  assert.strictEqual(cb.plan(1000000, { recordsCapBytes: 1000 }).recordsBytes, 1000, 'agent cap wins when smaller');
  assert.strictEqual(cb.plan(1000000).replyTokens, 32000);
  assert.strictEqual(cb.plan(8000).replyTokens, 2000);
  assert.strictEqual(cb.plan(10).window, 4096, 'floor');
});

test('fitMessages: newest first within budget, oldest dropped, no orphaned tool pairs, sinceTs cuts older turns, last message always kept', () => {
  const big = 'w'.repeat(3600);   // ~1000 tokens
  const msgs = [
    { role: 'user', content: 'old', ts: '2026-10-01T00:00:00Z' },
    { role: 'assistant', content: big, ts: '2026-10-02T00:00:00Z' },
    { role: 'assistant', content: 'calling', tool_calls: [{ id: 't1' }], ts: '2026-10-03T00:00:00Z' },
    { role: 'tool', content: 'result', ts: '2026-10-03T00:00:01Z' },
    { role: 'user', content: 'now', ts: '2026-10-04T00:00:00Z' },
  ];
  const all = cb.fitMessages(msgs, 100000);
  assert.strictEqual(all.messages.length, 5); assert.strictEqual(all.dropped, 0);
  const tight = cb.fitMessages(msgs, 60);
  assert.deepStrictEqual(tight.messages.map(m => m.content), ['calling', 'result', 'now']);
  assert.strictEqual(tight.dropped, 2);
  const tighter = cb.fitMessages(msgs, 20);
  assert.deepStrictEqual(tighter.messages.map(m => m.content), ['now'], 'a lone tool result is never the first message');
  const since = cb.fitMessages(msgs, 100000, { sinceTs: '2026-10-03T00:00:00Z' });
  assert.deepStrictEqual(since.messages.map(m => m.content), ['calling', 'result', 'now']);
  assert.deepStrictEqual(cb.fitMessages(msgs, 1, { keepLast: 1 }).messages.map(m => m.content), ['now']);
  assert.deepStrictEqual(cb.fitMessages([], 100).messages, []);
});

test('chunkRows: slices by characters, keeps lines whole, truncates a single oversize line; token estimate', () => {
  const rows = [
    { ts: '2026-10-09T10:00:00Z', kind: 'user', text: 'a'.repeat(100) },
    { ts: '2026-10-09T10:01:00Z', kind: 'assistant', text: 'b'.repeat(100) },
    { ts: '2026-10-09T10:02:00Z', kind: 'user', text: 'c'.repeat(100) },
    { ts: '2026-10-09T10:03:00Z', kind: 'user', text: 'd'.repeat(1000) },
  ];
  const chunks = cb.chunkRows(rows, 260);
  assert.strictEqual(chunks.length, 3);
  assert.ok(chunks[0].includes('Owner: aaa') && chunks[0].includes('You: bbb'));
  assert.ok(chunks[1].includes('Owner: ccc') && !chunks[1].includes('ddd'), 'a pending slice is flushed before an oversize line');
  assert.strictEqual(chunks[2].length, 260, 'oversize line truncated to the slice size');
  assert.strictEqual(cb.estimateTokens('x'.repeat(360)), 100);
  assert.strictEqual(cb.tokensToChars(100), 360);
});
