'use strict';
// Build Team: the transcript reader for consult_agent targets (lib/transcript consultTargetsSince). A temp archive only; nothing under
// the install's data/ is touched.
// Optimize team adds longTurnsSince, firstLineOf and more consultTargetsSince cases (below).
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

// Optimize team helpers: a handle without the temp dir (closed by tr.close(); the file lives in the OS temp dir), and row writers that take a turn id.
function makeTr() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-review-'));
  return createTranscript({ file: path.join(dir, 'x.db'), log: () => {} });
}
const userRow = (tr, agent, turnId, text, min, origin = 'user') => tr.record({ agent, kind: 'user', text, turnId, origin, ts: at(min) });
const toolRow = (tr, agent, turnId, name, text, min) => tr.record({ agent, kind: 'tool_use', tool: name, text: `${name} ${text}`, turnId, origin: 'user', ts: at(min) });
const replyRow = (tr, agent, turnId, text, min) => tr.record({ agent, kind: 'assistant', text, turnId, origin: 'user', ts: at(min) });

test('longTurnsSince: a person-started turn over the minutes, or over the tool calls, newest first; counts and timings only', () => {
  const tr = makeTr();
  try {
    userRow(tr, 'studio', 't-short', 'quick question', 0); replyRow(tr, 'studio', 't-short', 'answer', 2);
    userRow(tr, 'studio', 't-long', 'Draft the whole quarterly report\nwith charts', 10); replyRow(tr, 'studio', 't-long', 'done', 45);
    userRow(tr, 'studio', 't-tools', 'Tidy the files', 100);
    for (let i = 0; i < 41; i++) toolRow(tr, 'studio', 't-tools', 'Read', `{"n":${i}}`, 100 + i * 0.01);
    replyRow(tr, 'studio', 't-tools', 'tidy', 101);
    const got = tr.longTurnsSince('studio', SINCE, { minMinutes: 20, minTools: 40 });
    assert.deepEqual(got.map(g => g.turnId), ['t-tools', 't-long'], 'newest first; the short turn is not listed');
    assert.equal(got[1].minutes, 35);
    assert.equal(got[1].tools, 0);
    assert.equal(got[0].tools, 41);
    assert.equal(got[1].origin, 'user');
    assert.equal(got[1].start, at(10));
    for (const g of got) assert.deepEqual(Object.keys(g).sort(), ['minutes', 'origin', 'start', 'tools', 'turnId'], 'no text in the rows');
    assert.deepEqual(tr.longTurnsSince('studio', SINCE, { minMinutes: 20, minTools: 40, limit: 1 }).map(g => g.turnId), ['t-tools']);
    assert.deepEqual(tr.longTurnsSince('studio', at(50), { minMinutes: 20, minTools: 40 }).map(g => g.turnId), ['t-tools'], 'a turn that began before the window is not counted');
  } finally { tr.close(); }
});

test('longTurnsSince: turns the hub started (hand-off, schedule, build_team) never count, and an agent with no archive gives none', () => {
  const tr = makeTr();
  try {
    userRow(tr, 'studio', 't-ho', 'a hand-off brief', 0, 'hand_off'); replyRow(tr, 'studio', 't-ho', 'finished the hand-off', 90);
    userRow(tr, 'studio', 't-null', 'no origin recorded', 200, null); replyRow(tr, 'studio', 't-null', 'finished the request', 240);
    const got = tr.longTurnsSince('studio', SINCE, { minMinutes: 20, minTools: 40 });
    assert.deepEqual(got.map(g => g.turnId), ['t-null'], 'a user row with no origin is the person');
    assert.deepEqual(tr.longTurnsSince('nobody', SINCE, { minMinutes: 20, minTools: 40 }), []);
  } finally { tr.close(); }
});

test('firstLineOf: the first non-empty line of that turn\'s user text, cut to max', () => {
  const tr = makeTr();
  try {
    userRow(tr, 'studio', 't1', '\n  Write the launch post for the new studio line  \nsecond line with more', 0);
    assert.equal(tr.firstLineOf('studio', 't1'), 'Write the launch post for the new studio line');
    assert.equal(tr.firstLineOf('studio', 't1', 10), 'Write the ');
    assert.equal(tr.firstLineOf('studio', 'missing'), '');
    assert.equal(tr.firstLineOf('studio', null), '');
    assert.equal(tr.firstLineOf('nobody', 't1'), '');
  } finally { tr.close(); }
});

test('consultTargetsSince: counts consult_agent calls by target (an mcp prefix dropped); unreadable rows and other tools are skipped', () => {
  const tr = makeTr();
  try {
    toolRow(tr, 'studio', 'a', 'consult_agent', '{"agent":"critic","message":"check this draft"}', 1);
    toolRow(tr, 'studio', 'b', 'mcp__hub__consult_agent', '{"agent":"critic","message":"again"}', 2);
    toolRow(tr, 'studio', 'c', 'consult_agent', '{"agent":"atlas","message":"where is it"}', 3);
    toolRow(tr, 'studio', 'd', 'consult_agent', '{"agent":"cri', 4);                          // cut off: unreadable
    toolRow(tr, 'studio', 'e', 'consult_agent', 'not json at all', 5);
    toolRow(tr, 'studio', 'f', 'consult_agent', '{"message":"no target"}', 6);
    toolRow(tr, 'studio', 'g', 'Read', '{"agent":"critic"}', 7);                              // another tool
    toolRow(tr, 'studio', 'h', 'consult_agent', '{"agent":"writer","message":"old"}', -60 * 24 * 10);   // before the window
    assert.deepEqual(tr.consultTargetsSince('studio', SINCE), { critic: 2, atlas: 1 });
    assert.deepEqual(tr.consultTargetsSince('nobody', SINCE), {});
  } finally { tr.close(); }
});
