'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { SdkWorkerTracker, toolResultIds, toolResultText } = require('../lib/sdk-workers');

// Message shapes follow @anthropic-ai/claude-agent-sdk sdk.d.ts (0.3.270):
// parent_tool_use_id is set only on messages produced inside a sub-agent; the
// Agent tool's own result is a top-level user message whose tool_result block
// answers the Agent tool_use id.
const AGENT_ID = 'toolu_agent_1';
const agentBlock = { type: 'tool_use', id: AGENT_ID, name: 'Agent', input: { description: 'Extract findings', prompt: 'Read /tmp/x and summarise', model: 'sonnet' } };
const innerResult = { type: 'user', parent_tool_use_id: AGENT_ID, tool_use_result: { type: 'text', file: { filePath: '/tmp/x' } },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_inner_read', content: 'file body' }] } };
const agentResult = { type: 'user', parent_tool_use_id: null, tool_use_result: { content: [{ type: 'text', text: 'Findings: three items' }], totalDurationMs: 1234 },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: AGENT_ID, content: [{ type: 'text', text: 'Findings: three items' }] }] } };
const plainResult = { type: 'user', parent_tool_use_id: null, tool_use_result: 'ok',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash_9', content: 'ok' }] } };

function tracker() {
  let t = 1000;
  return new SdkWorkerTracker({ now: () => (t += 10) });
}

describe('sdk-workers: helpers', () => {
  it('reads tool_use ids and text out of tool_result blocks', () => {
    assert.deepStrictEqual(toolResultIds(agentResult), [AGENT_ID]);
    assert.deepStrictEqual(toolResultIds({ type: 'user', message: { content: 'just text' } }), []);
    assert.strictEqual(toolResultText(agentResult, AGENT_ID), 'Findings: three items');
    assert.strictEqual(toolResultText(innerResult, 'toolu_inner_read'), 'file body');
    assert.strictEqual(toolResultText(agentResult, 'nope'), '');
  });
});

describe('sdk-workers: lifecycle', () => {
  it('registers an Agent tool_use with description, model and prompt', () => {
    const t = tracker();
    const w = t.register(agentBlock);
    assert.match(w.workerId, /^sdk-worker-\d+-1$/);
    assert.strictEqual(w.description, 'Extract findings');
    assert.strictEqual(w.model, 'sonnet');
    assert.strictEqual(w.prompt, 'Read /tmp/x and summarise');
    assert.strictEqual(t.size, 1);
  });

  it('attributes messages with parent_tool_use_id to the running sub-agent', () => {
    const t = tracker();
    const w = t.register(agentBlock);
    assert.strictEqual(t.workerFor({ parent_tool_use_id: AGENT_ID }), w);
    assert.strictEqual(t.workerFor({ parent_tool_use_id: null }), null);
    assert.strictEqual(t.workerFor({ parent_tool_use_id: 'toolu_other' }), null);
  });

  it("an inner tool result is worker activity, NOT the sub-agent's completion (the old bug)", () => {
    const t = tracker();
    const w = t.register(agentBlock);
    const r = t.resolveResult(innerResult);
    assert.strictEqual(r.kind, 'inner');
    assert.strictEqual(r.worker, w);
    assert.strictEqual(t.size, 1, 'worker must still be registered');
  });

  it("the Agent tool's top-level result completes the sub-agent and carries its report", () => {
    const t = tracker();
    const w = t.register(agentBlock);
    t.resolveResult(innerResult);
    const r = t.resolveResult(agentResult);
    assert.strictEqual(r.kind, 'completed');
    assert.strictEqual(r.completed.length, 1);
    assert.strictEqual(r.completed[0].worker, w);
    assert.strictEqual(r.completed[0].toolUseId, AGENT_ID);
    assert.strictEqual(r.completed[0].output, 'Findings: three items');
    assert.ok(r.completed[0].elapsedMs > 0);
    assert.strictEqual(t.size, 0, 'worker released');
    assert.deepStrictEqual(t.drain(), [], 'nothing left to report as orphaned at turn end');
  });

  it('an ordinary top-level tool result is neither inner nor completion, and keeps its tool_use id', () => {
    const t = tracker();
    t.register(agentBlock);
    const r = t.resolveResult(plainResult);
    assert.strictEqual(r.kind, 'top');
    assert.deepStrictEqual(r.toolUseIds, ['toolu_bash_9']);
    assert.strictEqual(r.output, 'ok');
    assert.strictEqual(t.size, 1);
  });

  it('two parallel sub-agents are told apart by parent_tool_use_id and finish independently', () => {
    const t = tracker();
    const a = t.register(agentBlock);
    const b = t.register({ ...agentBlock, id: 'toolu_agent_2', input: { description: 'Second' } });
    assert.strictEqual(t.workerFor({ parent_tool_use_id: 'toolu_agent_2' }), b);
    assert.strictEqual(t.workerFor({ parent_tool_use_id: AGENT_ID }), a);
    const r = t.resolveResult({ ...agentResult, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_agent_2', content: 'done B' }] } });
    assert.strictEqual(r.kind, 'completed');
    assert.strictEqual(r.completed[0].worker, b);
    assert.strictEqual(t.size, 1);
    assert.deepStrictEqual(t.drain(), [a]);
  });

  it('a tool_use_summary naming the Agent call also completes it', () => {
    const t = tracker();
    const w = t.register(agentBlock);
    const done = t.completeByIds(['toolu_other', AGENT_ID]);
    assert.strictEqual(done.length, 1);
    assert.strictEqual(done[0].worker, w);
    assert.deepStrictEqual(t.completeByIds(undefined), []);
    assert.strictEqual(t.size, 0);
  });

  it('drain returns what is still running so the turn end can report it, then empties', () => {
    const t = tracker();
    const w = t.register(agentBlock);
    assert.deepStrictEqual(t.drain(), [w]);
    assert.strictEqual(t.size, 0);
  });
});
