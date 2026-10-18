'use strict';
// lib/context-refresh: a resumed Claude-client session keeps its original system prompt, so the hub sends what
// changed since the session last saw it at the top of the next message.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { createContextRefresh, splitSections, DIVIDER } = require('../lib/context-refresh');

const ctx = ({ soul = 'Be careful.', records = { 'a.md': 'alpha' }, memory = 'mem 1' } = {}) => [
  '# Identity\nI am Test.',
  `# Soul\n${soul}`,
  `# Records (source of truth, loaded in full every turn)\nThese are your own documents.\n\n${Object.entries(records).map(([n, t]) => `### ${n}\n${t}`).join('\n\n')}`,
  `# Long-Term Memory\n${memory}`,
].join(DIVIDER);

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cref-'));
  return { cr: createContextRefresh({ dir }), dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('sections are split on the divider, Records per record, with stable keys', () => {
  const keys = splitSections(ctx({ records: { 'a.md': 'A', 'b.md': 'B' } })).map(([k]) => k);
  assert.deepStrictEqual(keys, ['# Identity', '# Soul', 'Records', 'Records › a.md', 'Records › b.md', '# Long-Term Memory']);
});

test('fresh session: no block, baseline kept; resumed and unchanged: no block', (t) => {
  const { cr, done } = rig(); t.after(done);
  const p = cr.plan({ agent: 'x', resumed: false, context: ctx() });
  assert.strictEqual(p.block, null);
  p.commit('s1');
  const q = cr.plan({ agent: 'x', sessionId: 's1', resumed: true, context: ctx() });
  assert.strictEqual(q.block, null);
  assert.strictEqual(q.summary, 'unchanged');
});

test('resumed: only changed, new, appended and removed sections are sent', (t) => {
  const { cr, done } = rig(); t.after(done);
  cr.plan({ agent: 'x', resumed: false, context: ctx({ records: { 'a.md': 'alpha', 'gone.md': 'old' } }) }).commit('s1');
  const q = cr.plan({ agent: 'x', sessionId: 's1', resumed: true, context: ctx({ soul: 'Anchor 1: authorized only. Be careful.', records: { 'a.md': 'alpha\nline two', 'canary.md': 'PELICAN-7' } }) });
  assert.match(q.block, /^<hub_context_update>\n/);
  assert.match(q.block, /## # Soul \(changed; full current text\)\n# Soul\nAnchor 1: authorized only\. Be careful/);
  assert.match(q.block, /## Records › a\.md \(appended since you last saw it\)\nline two/);
  assert.ok(!/\nalpha\n/.test(q.block.split('Records › a.md')[1].split('##')[0]), 'the old part of an appended record is not resent');
  assert.match(q.block, /## Records › canary\.md \(new\)\n### canary\.md\nPELICAN-7/);
  assert.match(q.block, /## Removed since you last saw them\n- Records › gone\.md/);
  assert.ok(!q.block.includes('# Identity'), 'unchanged sections are not resent');
  assert.ok(!q.block.includes('mem 1'));
  q.commit('s1');
  assert.strictEqual(cr.plan({ agent: 'x', sessionId: 's1', resumed: true, context: ctx({ soul: 'Anchor 1: authorized only. Be careful.', records: { 'a.md': 'alpha\nline two', 'canary.md': 'PELICAN-7' } }) }).block, null, 'once committed, nothing to send');
});

test('a session the module has no baseline for (or a different session) gets the full current context once', (t) => {
  const { cr, done } = rig(); t.after(done);
  const q = cr.plan({ agent: 'doc', sessionId: 'old-session', resumed: true, context: ctx() });
  assert.match(q.block, /CURRENT version of your full instructions/);
  for (const k of ['# Identity', '# Soul', 'Records › a.md', '# Long-Term Memory']) assert.ok(q.block.includes(`## ${k}`), k);
  q.commit('old-session');
  cr.plan({ agent: 'doc', resumed: false, context: ctx() }).commit('new-session');
  assert.match(cr.plan({ agent: 'doc', sessionId: 'old-session', resumed: true, context: ctx() }).block, /CURRENT version/, 'baseline belongs to another session');
});

test('size cap: oversized sections are named with an instruction to read the files instead', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cref-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cr = createContextRefresh({ dir, maxChars: 200 });
  const q = cr.plan({ agent: 'x', sessionId: 's', resumed: true, context: ctx({ records: { 'big.md': 'x'.repeat(5000) } }) });
  assert.match(q.block, /## Too large to include here\n[\s\S]*- Records › big\.md/);
  assert.match(q.block, /Read those files from your workspace/);
});

test('forget(): after the client compacts, the next resumed turn gets everything again', (t) => {
  const { cr, done } = rig(); t.after(done);
  cr.plan({ agent: 'x', resumed: false, context: ctx() }).commit('s1');
  cr.forget('x');
  assert.match(cr.plan({ agent: 'x', sessionId: 's1', resumed: true, context: ctx() }).block, /CURRENT version/);
});

test('wired into the Claude-client path: plan before the query, prefix on the message, commit on success, forget on compaction, hits with the message', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(src, /contextRefresh\.getContextRefresh\(\)\.plan\(\{ agent: agentName, sessionId: resumeSessionId, resumed: !!resumeSessionId, context: queryOptions\.systemPrompt\.append \}\)/);
  assert.match(src, /const cleanMsg = \(contextPrefix \+ effectiveMessage/);
  assert.match(src, /if \(contextRefreshPlan && !msg\.is_error\) \{ try \{ contextRefreshPlan\.commit\(sessionIdSeen \|\| msg\.session_id\); \}/);
  assert.match(src, /msg\.subtype === 'compact_boundary'\) \{\s*try \{ contextRefresh\.getContextRefresh\(\)\.forget\(agentName\)/);
  assert.match(src, /loadAgentContext\(agentName, 'hub', \{ recallQuery: userMessage, hitsOut: sdkHits \}\)/);
});
