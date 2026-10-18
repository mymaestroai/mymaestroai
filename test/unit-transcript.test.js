'use strict';
// Transcript archive: capture via the SSE tap, full-text search, context around a hit, importers, dedupe.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTranscript, ftsQuery } = require('../lib/transcript');

const dirs = [];
function make() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-')); dirs.push(dir);
  let t = Date.parse('2026-10-01T12:00:00Z');
  const tr = createTranscript({ file: path.join(dir, 't.db'), now: () => (t += 1000), log: () => {} });
  return { tr, dir };
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function fakeRes() {
  const r = { chunks: [], write(s) { this.chunks.push(s); return true; } };
  return r;
}
const chunk = (content, gateway) => `data: ${JSON.stringify({ choices: [{ delta: content ? { content } : {} }], ...(gateway ? { gateway } : {}) })}\n\n`;

test('tap collects assistant text, tool_use and tool_result from the stream, also after the browser is gone', () => {
  const { tr } = make();
  const res = fakeRes();
  res.observeClosed = () => {};   // hub-events' hook for a detached turn
  const tap = tr.tap(res, { agent: 'helper', turnId: 't1', origin: 'user' });
  tr.record({ agent: 'helper', kind: 'user', text: 'What was the score on the fifth?', turnId: 't1' });
  res.write(chunk('Checking the scoreboard.'));
  res.write(chunk('', { type: 'tool_use', tool: 'Read', input: { file_path: '/x/results.pdf' }, tool_call_id: 'c1' }));
  res.write(chunk('', { type: 'tool_result', output: 'Final score 4.1 points (2026-10-05)', tool_call_id: 'c1' }));
  res.observeClosed(JSON.parse(chunk(' The score was 4.1.').slice(6)));   // detached: no write, but observed
  tap.finish(true);
  assert.strictEqual(res.write !== fakeRes().write, true);
  const s = tr.stats('helper');
  assert.deepStrictEqual(s.byKind, { user: 1, assistant: 1, tool_use: 1, tool_result: 1 });
  const hits = tr.search('helper', 'score');
  assert.ok(hits.length >= 2);
  assert.ok(hits.some(h => h.kind === 'tool_result' && /4\.1/.test(h.text)));
  const a = hits.find(h => h.kind === 'assistant');
  assert.strictEqual(a.text, 'Checking the scoreboard. The score was 4.1.');
  assert.ok(res.chunks.length === 3, 'the original write still happened');
});

test('search: scoped to the agents given, date range, kinds; ranked; context around a hit; FTS query is safe', () => {
  const { tr } = make();
  tr.record({ agent: 'helper', kind: 'user', text: 'Sam kayak and roof rack', ts: '2026-09-20T10:00:00Z' });
  tr.record({ agent: 'helper', kind: 'assistant', text: 'The kayak was ordered on the twentieth.', ts: '2026-09-20T10:00:05Z' });
  tr.record({ agent: 'helper', kind: 'assistant', text: 'Roof rack delivered.', ts: '2026-09-28T10:00:00Z' });
  tr.record({ agent: 'planner', kind: 'assistant', text: 'The kayak clause in the rental terms.', ts: '2026-09-21T10:00:00Z' });
  assert.deepStrictEqual(tr.search('helper', 'kayak').map(h => h.kind), ['assistant', 'user']);
  assert.strictEqual(tr.search(['helper', 'planner'], 'kayak').length, 3);
  assert.strictEqual(tr.search('helper', 'kayak', { from: '2026-09-21' }).length, 0);
  assert.strictEqual(tr.search('helper', 'rack', { kinds: ['assistant'] }).length, 1);
  assert.strictEqual(tr.search('nobody', 'kayak').length, 0);
  assert.strictEqual(tr.search([], 'kayak').length, 0);
  // operators / quotes in the query cannot break the match expression
  assert.doesNotThrow(() => tr.search('helper', 'kayak OR "rack NEAR(x' ));
  assert.strictEqual(ftsQuery(''), null);
  assert.strictEqual(ftsQuery('roof rack'), '"roof" "rack"*');
  const hit = tr.search('helper', 'ordered')[0];
  const ctx = tr.context(hit.id, { before: 1, after: 1 });
  assert.deepStrictEqual(ctx.map(r => [r.kind, !!r.hit]), [['user', false], ['assistant', true], ['assistant', false]]);
  assert.deepStrictEqual(tr.context(hit.id, { agents: ['planner'] }), [], 'context respects the allowed agents');
  // no query: newest first
  assert.strictEqual(tr.search('helper', '')[0].text, 'Roof rack delivered.');
});

test('importers: hub chat log and Claude session file, deduped against each other and on re-import; big outputs clipped', () => {
  const { tr, dir } = make();
  const conv = path.join(dir, 'helper.jsonl');
  fs.writeFileSync(conv, [
    JSON.stringify({ ts: '2026-10-05T11:00:00Z', role: 'user', content: 'Sam packing list please' }),
    JSON.stringify({ ts: '2026-10-05T11:00:30Z', role: 'assistant', content: 'Here is the one-page list.' }),
  ].join('\n') + '\n');
  const sess = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(sess, [
    JSON.stringify({ type: 'user', timestamp: '2026-10-05T11:00:00Z', message: { content: 'Sam packing list please' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-05T11:00:10Z', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/m/packing.md' } }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-10-05T11:00:12Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x'.repeat(200000) }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-05T11:00:30Z', message: { content: [{ type: 'text', text: 'Here is the one-page list.' }] } }),
    JSON.stringify({ type: 'progress', timestamp: '2026-10-05T11:00:31Z' }),
  ].join('\n') + '\n');
  assert.strictEqual(tr.importConversation('helper', conv), 2);
  assert.strictEqual(tr.importClaudeSession('helper', sess), 2, 'user + assistant text deduped; tool_use and tool_result are new');
  assert.strictEqual(tr.importClaudeSession('helper', sess), 0, 're-import adds nothing');
  const s = tr.stats('helper');
  assert.deepStrictEqual(s.byKind, { user: 1, assistant: 1, tool_use: 1, tool_result: 1 });
  const big = tr.search('helper', '', { kinds: ['tool_result'] })[0];
  assert.ok(big.text.includes('chars omitted'));
  assert.ok(s.bytes < 70000, 'clipped on the way in');
  assert.strictEqual(tr.importConversation('helper', path.join(dir, 'missing.jsonl')), 0);
});
