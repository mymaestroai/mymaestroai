'use strict';
// The chat header of an Auto-model agent (app.js): each turn's gateway auto_model event names the model Auto picked.
// It used to rewrite the header's textContent ("Name (model)"), which flattened the model picker, the effort picker and
// the plan badge into one long line of every option's text. Now only a small "→ model" note changes.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('no auto_model handler rewrites the header text; both call noteAutoModel', () => {
  assert.ok(!/headerSpan\.textContent\s*=/.test(app), 'the old "Name (model)" rewrite is gone');
  assert.ok(!/\.agent-name`\);\s*\n\s*if \(headerSpan\)/.test(app));
  assert.strictEqual((app.match(/noteAutoModel\(chatId, modelShort\);/g) || []).length, 2, 'both stream readers use the helper');
});

test('noteAutoModel adds one note after the picker, updates it on the next turn, and leaves the controls alone', () => {
  const src = app.match(/function noteAutoModel\(chatId, modelShort\) \{[\s\S]*?\n    \}\n/)[0];
  // A stand-in header: name, model picker, effort picker, plan badge.
  const mk = (cls) => ({ className: cls, textContent: '', title: '', after(n) { kids.splice(kids.indexOf(this) + 1, 0, n); }, appendChild(n) { kids.push(n); } });
  const kids = [mk('agent-name-text'), mk('model-pick'), mk('effort-pick'), mk('plan-badge')];
  kids[0].textContent = 'Compass'; kids[3].textContent = 'Plan 8% this week';
  const header = { querySelector: (q) => kids.find(k => '.' + k.className === q) || null, appendChild: (n) => kids.push(n) };
  const document = { querySelector: (q) => (q === '#panel-c1 .chat-actions .agent-name' ? header : null), createElement: () => mk('') };
  const ctx = { document }; vm.runInNewContext(src + '\nthis.noteAutoModel = noteAutoModel;', ctx);
  ctx.noteAutoModel('c1', 'claude-sonnet-5-5');
  assert.deepStrictEqual(kids.map(k => k.className), ['agent-name-text', 'model-pick', 'auto-model-note', 'effort-pick', 'plan-badge']);
  assert.strictEqual(kids[2].textContent, '→ claude-sonnet-5-5');
  ctx.noteAutoModel('c1', 'claude-opus-5-5');
  assert.strictEqual(kids.filter(k => k.className === 'auto-model-note').length, 1, 'one note, updated');
  assert.strictEqual(kids[2].textContent, '→ claude-opus-5-5');
  const by = (c) => kids.find(k => k.className === c);
  assert.strictEqual(by('agent-name-text').textContent, 'Compass'); assert.strictEqual(by('plan-badge').textContent, 'Plan 8% this week');
  ctx.noteAutoModel('nope', 'x');   // no such chat: nothing happens, no throw
});
