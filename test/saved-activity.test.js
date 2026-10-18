'use strict';
// A saved reply keeps the tool calls of its turn with their place in the saved text (history then reads like the live
// stream), and text that resumes after a tool call starts a new paragraph.
const { test } = require('node:test');
const assert = require('node:assert');
const hubEvents = require('../lib/hub-events');
const { activityForSave, paragraphAfterTool, metaForPiece } = require('../lib/sdk-chat');

function fakeRes() { const r = { chunks: [], write: (s) => { r.chunks.push(s); return true; } }; return r; }
const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const text = (res, t) => sse(res, { choices: [{ delta: { content: t } }] });
const gw = (res, g) => sse(res, { choices: [{ delta: {} }], gateway: g });

test('paragraphAfterTool: a break unless the text already ends a line', () => {
  assert.strictEqual(paragraphAfterTool('Checked.'), '\n\n');
  assert.strictEqual(paragraphAfterTool('Checked.\n'), '');
  assert.strictEqual(paragraphAfterTool(''), '');
});

test('activityForSave: tool calls and workers with their offsets in the saved text, compact and capped', () => {
  const res = fakeRes();
  const tap = hubEvents.events.tapTurn(res, { agent: 'savetest', origin: { kind: 'user' }, message: 'go', turnId: 'ts1' });
  text(res, 'Checking.');
  gw(res, { type: 'tool_start', tool: 'Bash', tool_call_id: 'c1' });
  gw(res, { type: 'tool_use', tool: 'Bash', tool_call_id: 'c1', input: { command: 'tail log' } });
  gw(res, { type: 'tool_result', tool_call_id: 'c1', output: 'x'.repeat(2000) });
  text(res, '\n\nFound it.');
  gw(res, { type: 'worker_started', worker_id: 'w1', description: 'second look', model: 'm1' });
  text(res, ' Done.');
  const streamed = 'Checking.\n\nFound it. Done.';
  const same = activityForSave('savetest', streamed);
  assert.deepStrictEqual(same.map(a => [a.kind, a.tool || a.description, a.at]), [['tool', 'Bash', 'Checking.'.length], ['worker', 'second look', 'Checking.\n\nFound it.'.length]]);
  assert.strictEqual(same[0].summary, 'tail log');
  assert.ok(same[0].output.length <= 401, 'output clipped');
  // the saved text has a notice line in front: offsets follow the text before each call
  const saved = '_⚠️ a notice line._\n\n' + streamed;
  const moved = activityForSave('savetest', saved);
  assert.deepStrictEqual(moved.map(a => saved.slice(0, a.at).endsWith(a.kind === 'tool' ? 'Checking.' : 'Found it.')), [true, true]);
  tap.finish(true);
  assert.strictEqual(activityForSave('nobody-here', 'x'), null, 'no turn: nothing');
});

test('metaForPiece: a piece saved after a question keeps only its own calls, offsets from its start', () => {
  const meta = { activity: [{ id: 'a', at: 5 }, { id: 'b', at: 30 }, { id: 'c' }] };
  assert.deepStrictEqual(metaForPiece(meta, 20).activity, [{ id: 'b', at: 10 }, { id: 'c' }]);
  assert.deepStrictEqual(metaForPiece(meta, 0), meta);
  assert.deepStrictEqual(metaForPiece(undefined, 4), {});
});
