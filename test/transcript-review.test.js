'use strict';
// Build Team: the transcript reader for consult_agent targets (lib/transcript consultTargetsSince). A temp archive only; nothing under
// the install's data/ is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTranscript } = require('../lib/transcript');

const MIN = 60000;
const T0 = Date.now() - 3 * 86400000;
const at = (min) => new Date(T0 + min * MIN).toISOString();
const SINCE = new Date(T0 - 86400000).toISOString();

function make() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-review-'));
  return { tr: createTranscript({ file: path.join(dir, 'x.db'), log: () => {} }), dir };
}
const tool = (tr, agent, name, text, min) => tr.record({ agent, kind: 'tool_use', tool: name, text, turnId: 't1', origin: 'user', ts: at(min) });

test('consultTargetsSince: consult_agent calls counted per target, from the call\'s JSON, inside the window only', () => {
  const { tr, dir } = make();
  try {
    tool(tr, 'studio', 'mcp__agent-hub__consult_agent', 'consult_agent {"agent":"atlas","message":"hello"}', 1);
    tool(tr, 'studio', 'consult_agent', 'consult_agent {"agent":"atlas"}', 2);
    tool(tr, 'studio', 'mcp__agent-hub__consult_agent', 'consult_agent {"agent":" critic "}', 3);
    tool(tr, 'studio', 'Read', 'Read {"agent":"atlas"}', 4);
    tool(tr, 'studio', 'mcp__agent-hub__consult_agent', 'consult_agent not json', 5);
    tool(tr, 'studio', 'mcp__agent-hub__consult_agent', 'consult_agent {"agent":42}', 6);
    tool(tr, 'writer', 'consult_agent', 'consult_agent {"agent":"atlas"}', 7);
    assert.deepEqual(tr.consultTargetsSince('studio', SINCE), { atlas: 2, critic: 1 });
    assert.deepEqual(tr.consultTargetsSince('studio', at(2.5)), { critic: 1 }, 'a call before the window is not counted');
    assert.deepEqual(tr.consultTargetsSince('writer', SINCE), { atlas: 1 }, 'each agent has its own archive rows');
  } finally { tr.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('consultTargetsSince: an agent with no archive gives none', () => {
  const { tr, dir } = make();
  try { assert.deepEqual(tr.consultTargetsSince('nobody', SINCE), {}); } finally { tr.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
