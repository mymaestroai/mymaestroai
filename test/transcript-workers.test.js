'use strict';
// A worker's run (a temporary worker, an agent consulted, a sub-agent) is kept in the caller's conversation archive,
// tagged with its worker_id: its instructions, each step, its answer and how it ended. Its own turn keeps nothing.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { createTranscript } = require('../lib/transcript');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-workers-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sse = (ev) => `data: ${JSON.stringify({ gateway: ev })}\n\n`;
function fakeRes() { return { write() { return true; } }; }
function workerRows(tr, agent, wid) {
  const db = new Database(tr.fileFor(agent), { readonly: true });
  try {
    return db.prepare("SELECT kind, tool, text, meta FROM entries WHERE agent = ? AND json_extract(meta, '$.worker_id') = ? ORDER BY id").all(agent, wid)
      .map(r => ({ ...r, meta: JSON.parse(r.meta) }));
  } finally { db.close(); }
}

test('a worker run is kept: instructions, steps, answer and how it ended, with its model and time', () => {
  let clock = 1000;
  const tr = createTranscript({ file: path.join(tmp, 'a.db'), now: () => clock });
  const res = fakeRes();
  const t = tr.tap(res, { agent: 'zz_caller', turnId: 'turn-1' });
  res.write(sse({ type: 'worker_started', worker_id: 'tw-1', agent_type: 'temporal', description: 'Worker: Fable review · claude-fable-5-1', model: 'claude-fable-5-1', prompt: 'Review the packet at share/x.md and end with ACCEPT or REJECT.' }));
  res.write(sse({ type: 'worker_tool_use', worker_id: 'tw-1', tool: 'Read', input: { file_path: 'share/x.md' }, tool_call_id: 'w1c1' }));
  res.write(sse({ type: 'worker_tool_result', worker_id: 'tw-1', output: 'the packet text', tool_call_id: 'w1c1' }));
  res.write(sse({ type: 'worker_text_delta', worker_id: 'tw-1', text: 'Verdict: ' }));
  res.write(sse({ type: 'worker_text_delta', worker_id: 'tw-1', text: 'ACCEPT.' }));
  clock += 42000;
  res.write(sse({ type: 'worker_completed', worker_id: 'tw-1' }));
  t.finish(true);
  const rows = workerRows(tr, 'zz_caller', 'tw-1');
  assert.deepStrictEqual(rows.map(r => [r.kind, r.meta.worker_event || null]), [['system', 'started'], ['tool_use', null], ['tool_result', null], ['tool_result', 'answer'], ['system', 'finished']]);
  assert.match(rows[0].text, /Fable review[\s\S]*Review the packet at share\/x\.md/, 'the instructions, in full');
  assert.deepStrictEqual([rows[0].meta.model, rows[0].meta.agent_type], ['claude-fable-5-1', 'temporal']);
  assert.strictEqual(rows[3].text, 'Verdict: ACCEPT.', 'the answer as streamed');
  assert.deepStrictEqual([rows[4].meta.outcome, rows[4].meta.duration_ms], ['done', 42000]);
  tr.close();
});

test('two workers running the same step each keep it; failures, stops and runs cut off by the turn are told apart', () => {
  const tr = createTranscript({ file: path.join(tmp, 'b.db') });
  const res = fakeRes();
  const t = tr.tap(res, { agent: 'zz_caller2' });
  for (const wid of ['tw-a', 'tw-b', 'tw-c', 'tw-d']) {
    res.write(sse({ type: 'worker_started', worker_id: wid, description: `Worker: ${wid}` }));
    res.write(sse({ type: 'worker_tool_use', worker_id: wid, tool: 'Bash', input: { command: 'ls' }, tool_call_id: 'same-step' }));
    res.write(sse({ type: 'worker_tool_result', worker_id: wid, output: 'a b c', tool_call_id: 'same-step' }));
  }
  res.write(sse({ type: 'worker_completed', worker_id: 'tw-a' }));
  res.write(sse({ type: 'worker_failed', worker_id: 'tw-b', error: 'Gemini 402: out of credit' }));
  res.write(sse({ type: 'worker_failed', worker_id: 'tw-c', cancelled: true, error: 'Stopped' }));
  t.finish(true);   // tw-d never finished
  const steps = (wid) => workerRows(tr, 'zz_caller2', wid).filter(r => r.kind !== 'system').length;
  assert.deepStrictEqual(['tw-a', 'tw-b', 'tw-c', 'tw-d'].map(steps), [2, 2, 2, 2], 'every worker kept its own identical step');
  const outcome = (wid) => workerRows(tr, 'zz_caller2', wid).find(r => r.meta.worker_event === 'finished');
  assert.strictEqual(outcome('tw-a').meta.outcome, 'done');
  assert.strictEqual(outcome('tw-b').meta.outcome, 'failed');
  assert.match(outcome('tw-b').text, /out of credit/);
  assert.strictEqual(outcome('tw-c').meta.outcome, 'stopped');
  assert.strictEqual(outcome('tw-d').meta.outcome, 'unfinished');
  tr.close();
});

test('Claude sub-agents answer through the caller\'s tool result: one answer row each, even when two answer alike', () => {
  const tr = createTranscript({ file: path.join(tmp, 'c.db') });
  const res = fakeRes();
  const t = tr.tap(res, { agent: 'zz_caller3' });
  for (const [wid, call] of [['sdk-w1', 'toolu_a1'], ['sdk-w2', 'toolu_a2']]) {
    res.write(sse({ type: 'worker_started', worker_id: wid, agent_type: 'sdk-agent', description: `SDK Worker: review ${wid}` }));
    res.write(sse({ type: 'worker_text_delta', worker_id: wid, text: 'Looking at the diff... PASS' }));   // the sub-agent's streamed text
  }
  for (const [wid, call] of [['sdk-w1', 'toolu_a1'], ['sdk-w2', 'toolu_a2']]) {
    // the order the Claude route sends them: the worker ends, then its Agent result is handed over and sent
    res.write(sse({ type: 'worker_completed', worker_id: wid }));
    res.archiveToolOutput(call, 'PASS', { worker_id: wid, worker_event: 'answer' });
    res.write(sse({ type: 'tool_result', tool_call_id: call, output: 'PASS' }));
  }
  t.finish(true);
  for (const wid of ['sdk-w1', 'sdk-w2']) {
    const answers = workerRows(tr, 'zz_caller3', wid).filter(r => r.meta.worker_event === 'answer');
    assert.deepStrictEqual(answers.map(a => a.text), ['PASS'], `${wid}: exactly one answer, the final result`);
  }
  tr.close();
});

test('identical steps inside one sub-agent each keep their row, and a run that failed keeps its partial answer, marked', () => {
  const tr = createTranscript({ file: path.join(tmp, 'e.db') });
  const res = fakeRes();
  const t = tr.tap(res, { agent: 'zz_caller5' });
  res.write(sse({ type: 'worker_started', worker_id: 'sdk-s', agent_type: 'sdk-agent', description: 'SDK Worker: poll' }));
  for (let i = 0; i < 3; i++) {   // the same check three times, no call ids (as sub-agent steps arrive)
    res.write(sse({ type: 'worker_tool_use', worker_id: 'sdk-s', tool: 'Bash', input: { command: 'curl -s localhost:9966/health' } }));
    res.write(sse({ type: 'worker_tool_result', worker_id: 'sdk-s', output: 'ok' }));
  }
  res.write(sse({ type: 'worker_text_delta', worker_id: 'sdk-s', text: 'The migration succeeded so far' }));
  res.write(sse({ type: 'worker_failed', worker_id: 'sdk-s', error: 'turn ended' }));
  t.finish(true);
  const rows = workerRows(tr, 'zz_caller5', 'sdk-s');
  assert.strictEqual(rows.filter(r => r.kind === 'tool_use').length, 3);
  assert.strictEqual(rows.filter(r => r.kind === 'tool_result' && r.meta.worker_event !== 'answer').length, 3);
  const answer = rows.find(r => r.meta.worker_event === 'answer');
  assert.deepStrictEqual([answer.text, answer.meta.outcome, answer.meta.partial], ['The migration succeeded so far', 'failed', true]);
  tr.close();
});

test('worker rows never look like the caller\'s own conversation (the seed after a reset reads user and assistant rows only)', () => {
  const tr = createTranscript({ file: path.join(tmp, 'd.db') });
  const res = fakeRes();
  const t = tr.tap(res, { agent: 'zz_caller4' });
  res.write(sse({ type: 'worker_started', worker_id: 'tw-x', description: 'Worker: x', prompt: 'do x' }));
  res.write(sse({ type: 'worker_text_delta', worker_id: 'tw-x', text: 'x done' }));
  res.write(sse({ type: 'worker_completed', worker_id: 'tw-x' }));
  t.finish(true);
  assert.deepStrictEqual(tr.search('zz_caller4', '', { kinds: ['user', 'assistant'], limit: 50 }), []);
  assert.ok(tr.search('zz_caller4', 'done', { limit: 10 }).length >= 1, 'but recall finds the worker\'s answer');
  tr.close();
});

test('parallel steps inside a sub-agent: identical results without ids both survive; with ids, out of order, each keeps its own', () => {
  const tr = createTranscript({ file: path.join(tmp, 'f.db') });
  const res = fakeRes();
  const t = tr.tap(res, { agent: 'zz_caller6' });
  res.write(sse({ type: 'worker_started', worker_id: 'sdk-p', agent_type: 'sdk-agent', description: 'SDK Worker: parallel' }));
  // two calls start before either returns, both return "ok", no ids
  res.write(sse({ type: 'worker_tool_use', worker_id: 'sdk-p', tool: 'Bash', input: { command: 'check A' } }));
  res.write(sse({ type: 'worker_tool_use', worker_id: 'sdk-p', tool: 'Bash', input: { command: 'check B' } }));
  res.write(sse({ type: 'worker_tool_result', worker_id: 'sdk-p', output: 'ok' }));
  res.write(sse({ type: 'worker_tool_result', worker_id: 'sdk-p', output: 'ok' }));
  // with ids, the second call returns first
  res.write(sse({ type: 'worker_tool_use', worker_id: 'sdk-p', tool: 'Bash', input: { command: 'check C' }, tool_call_id: 'tu_c' }));
  res.write(sse({ type: 'worker_tool_use', worker_id: 'sdk-p', tool: 'Bash', input: { command: 'check D' }, tool_call_id: 'tu_d' }));
  res.write(sse({ type: 'worker_tool_result', worker_id: 'sdk-p', output: 'D done', tool_call_id: 'tu_d' }));
  res.write(sse({ type: 'worker_tool_result', worker_id: 'sdk-p', output: 'C done', tool_call_id: 'tu_c' }));
  t.finish(true);
  const results = workerRows(tr, 'zz_caller6', 'sdk-p').filter(r => r.kind === 'tool_result' && r.meta.worker_event !== 'answer');
  assert.deepStrictEqual(results.map(r => [r.text, r.meta.tool_call_id]), [['ok', null], ['ok', null], ['D done', 'tu_d'], ['C done', 'tu_c']]);
  tr.close();
});

test('a sub-agent message carrying several results is split into one result per call, each with its id', () => {
  const { SdkWorkerTracker } = require('../lib/sdk-workers');
  const tracker = new SdkWorkerTracker();
  tracker.register({ id: 'toolu_agent', input: { description: 'check', prompt: 'p' } });
  const msg = { type: 'user', parent_tool_use_id: 'toolu_agent', tool_use_result: [{ type: 'text', text: 'x' }],
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'first output' }, { type: 'tool_result', tool_use_id: 'tu_2', content: 'second output' }] } };
  const r = tracker.resolveResult(msg);
  assert.strictEqual(r.kind, 'inner');
  assert.deepStrictEqual(r.results, [{ id: 'tu_1', output: 'first output' }, { id: 'tu_2', output: 'second output' }]);
});

test('a sub-agent step that returned nothing stays empty, and a single step is kept as the text the model read', () => {
  const { SdkWorkerTracker } = require('../lib/sdk-workers');
  const tracker = new SdkWorkerTracker();
  tracker.register({ id: 'toolu_ag2', input: { description: 'check', prompt: 'p' } });
  const two = { type: 'user', parent_tool_use_id: 'toolu_ag2', tool_use_result: { stdout: 'second output' },
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu_e', content: '' }, { type: 'tool_result', tool_use_id: 'tu_f', content: 'second output' }] } };
  assert.deepStrictEqual(tracker.resolveResult(two).results, [{ id: 'tu_e', output: '' }, { id: 'tu_f', output: 'second output' }]);
  const one = { type: 'user', parent_tool_use_id: 'toolu_ag2', tool_use_result: { stdout: 'line one\nline two' },
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu_g', content: 'line one\nline two' }] } };
  assert.deepStrictEqual(tracker.resolveResult(one).results, [{ id: 'tu_g', output: 'line one\nline two' }]);
});
