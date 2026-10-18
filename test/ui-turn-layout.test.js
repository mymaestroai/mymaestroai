'use strict';
// A turn followed after a reload, a reopened chat or from another device reads like the own stream: the reply text
// split where each tool call or worker started (the hub's item.at), with those rows between the text before and after.
// The layout functions are pure and are run here as they are in the pages.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const app = read('app.js');
const mjs = read('mobile.js');

function extract(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} present`);
  let i = src.indexOf('{', at); let depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}
const turnSteps = new Function(`${extract(app, 'turnSteps')}; return turnSteps;`)();
const replyBlocks = new Function(`${extract(mjs, 'replyBlocks')}; return replyBlocks;`)();

const TEXT = 'Checking the logs. Found it. Now the config. Done.';
const A = 'Checking the logs.'.length; const B = 'Checking the logs. Found it. Now the config.'.length;

test('desktop: steps from the hub view interleave text and tool calls like the own stream', () => {
  const items = new Map([
    ['a1', { tool: 'Bash', input: 'tail log', output: 'ok', done: true, at: A, ts: '2026-10-17T10:00:00Z', doneTs: '2026-10-17T10:00:02Z' }],
    ['a2', { tool: 'Read', input: '/x.js', output: '', done: false, at: B }],
    ['a3', { tool: 'Grep', input: 'TODO', output: 'Error: no match', done: true, at: B }],
  ]);
  const steps = turnSteps({ items }, TEXT);
  assert.deepStrictEqual(steps.map(s => [s.text, s.tools.map(t => t.tool)]), [
    ['Checking the logs.', ['Bash']],
    [' Found it. Now the config.', ['Read', 'Grep']],
    [' Done.', []],
  ]);
  assert.deepStrictEqual(steps[0].tools[0], { tool: 'Bash', input: 'tail log', result: 'ok', status: 'done', startedAt: Date.parse('2026-10-17T10:00:00Z'), durationMs: 2000 });
  assert.deepStrictEqual([steps[1].tools[0].status, steps[1].tools[1].status], ['running', 'error']);
  // an older hub (no offsets): the tool calls go first, then the text, as before
  assert.deepStrictEqual(turnSteps({ items: new Map([['x', { tool: 'Bash', done: true, output: '' }]]) }, 'Hi.').map(s => [s.text, s.tools.length]), [['', 1], ['Hi.', 0]]);
  // offsets beyond the text so far (it is still streaming) are clamped
  assert.deepStrictEqual(turnSteps({ items: new Map([['x', { tool: 'Bash', done: false, at: 99 }]]) }, 'Hi.').map(s => [s.text, s.tools.length]), [['Hi.', 1]]);
});

test('desktop: every catch-up path paints through the steps layout', () => {
  assert.match(app, /function paintTurn\(chatId, t, text, streaming = true\) \{[\s\S]{0,300}renderSteps\(t\.msgId, turnSteps\(t, text\), turnToolActivity\(t\), \[\], streaming\);/, 'a turn started elsewhere');
  assert.match(app, /function paintReattach\(chatId, line\) \{[\s\S]{0,500}renderSteps\(ra\.msgId, steps, turnToolActivity\(ra\), \[\], true\);/, 're-attach (the status line after it)');
  assert.ok(app.includes('if (ra.items && ra.items.size) renderSteps(ra.msgId, turnSteps(ra, text), turnToolActivity(ra), [], false);'), 'a finished re-attach keeps the layout');
  assert.ok(app.includes('if (Number.isFinite(item.at) && it.at === undefined) it.at = item.at;'), 'the place of each call is kept from the hub');
});

test('phone: blocks interleave the text and the activity rows; the own stream and every catch-up use them', () => {
  const holder = { feed: { items: new Map([
    ['a1', { id: 'a1', kind: 'tool', at: A }],
    ['a2', { id: 'a2', kind: 'tool', at: B }],
    ['w', { id: 'w', kind: 'worker', at: B }],
  ]) } };
  const blocks = replyBlocks(holder, TEXT);
  assert.deepStrictEqual(blocks.map(b => (b.type === 'text' ? ['text', TEXT.slice(b.from, b.to)] : ['group', b.items.map(i => i.id)])), [
    ['text', 'Checking the logs.'], ['group', ['a1']], ['text', ' Found it. Now the config.'], ['group', ['a2', 'w']], ['text', ' Done.'],
  ]);
  assert.deepStrictEqual(replyBlocks({ feed: { items: new Map() } }, 'Hi.').map(b => b.type), ['text'], 'no activity: one text block');
  assert.deepStrictEqual(replyBlocks({ feed: { items: new Map([['x', { id: 'x' }]]) } }, 'Hi.').map(b => b.type), ['group', 'text'], 'an older hub (no offsets): rows first');
  assert.ok(mjs.includes('function setReplyText(holder, text) {\n  paintReply(holder, text);'), 'reply text paints the layout');
  assert.match(mjs, /function paintFeed\(holder, it\) \{\n  paintReply\(holder, undefined, it \|\| null\);/, 'activity rows paint the layout');
  assert.match(mjs, /const paint = \(\) => \{[\s\S]{0,120}paintReply\(rec, rec\.full\);/, 'the own stream paints the layout');
  assert.ok(!/afterTool/.test(mjs), 'the stream text is no longer altered after a tool call (offsets match the hub\'s)');
  assert.ok(mjs.includes('return feed.local ? String(typeof holder.full === \'string\' ? holder.full : (holder.replyText || \'\')).length : 0;'), 'own-stream rows are placed at the text so far');
});

test('history: a saved reply with its tool calls is laid out like the live stream on both pages', () => {
  assert.ok(app.includes('if (msg.role === \'assistant\' && Array.isArray(msg.activity) && msg.activity.length) paintSavedActivity(hid, msg);'), 'desktop history');
  assert.match(app, /function paintSavedActivity\(msgId, msg\) \{[\s\S]{0,600}renderSteps\(msgId, turnSteps\(t, msg\.content\), turnToolActivity\(t\), \[\], false\);/, 'desktop: the steps layout');
  assert.match(mjs, /const saved = Array\.isArray\(m\.activity\) && m\.activity\.length;[\s\S]{0,160}if \(saved\) paintSaved\(b, m\);/, 'phone history');
  assert.match(mjs, /function paintSaved\(bubble, m\) \{[\s\S]{0,1400}paintReply\(holder, m\.content\);/, 'phone: the same layout');
  assert.ok(app.includes("formatContent(step.text.replace(/^\\s*\\n/, ''))") && mjs.includes("formatContent(piece.replace(/^\\s*\\n/, ''))"), 'the paragraph break after a call is not drawn as blank lines');
});
