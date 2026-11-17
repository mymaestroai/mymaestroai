'use strict';
// Simple mode wording: a saved question and its answer in plain words, and plain words while a reply runs.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const S = require('../lib/ui-simple.js');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('askText: a saved question loses its glyph, its choices in brackets and the model note', () => {
  assert.strictEqual(S.askText('assistant', '❓ Which do you prefer? [Mountains / Beach / City]'), 'Which do you prefer?');
  assert.strictEqual(S.askText('assistant', '❓ Which model? [A / B] (or any model from the list)'), 'Which model?');
  assert.strictEqual(S.askText('assistant', '❓ What should I call it?'), 'What should I call it?');
});

test('askText: a saved answer reads "You chose: …", and skipped / no answer read as sentences', () => {
  assert.strictEqual(S.askText('user', '↳ Beach'), 'You chose: Beach');
  assert.strictEqual(S.askText('user', '↳ (skipped)'), 'You skipped this question.');
  assert.strictEqual(S.askText('user', '↳ (no answer)'), 'No answer was given.');
});

test('askText: everything else is unchanged (other roles, other text, non-strings)', () => {
  assert.strictEqual(S.askText('user', '❓ my own question [x]'), '❓ my own question [x]');
  assert.strictEqual(S.askText('assistant', '↳ Beach'), '↳ Beach');
  assert.strictEqual(S.askText('assistant', 'A plain reply [with brackets]'), 'A plain reply [with brackets]');
  assert.strictEqual(S.askText('user', 'hello'), 'hello');
  assert.strictEqual(S.askText('assistant', null), null);
});

test('desktop: the busy state calls the Simple look (Send, plain placeholder, Stop) and messages pass through askText', () => {
  const app = read('app.js');
  assert.match(app, /input\.placeholder = 'Type to interject new info into the running agent\.\.\.';\n\s+if \(typeof simpleBusyLook === 'function'\) simpleBusyLook\(sendBtn, input, cancelBtn\);/);
  assert.match(app, /function simpleBusyLook\(sendBtn, input, cancelBtn\) \{\n\s+if \(!simpleOn\(\)\) return;/);
  assert.ok(app.includes("input.placeholder = 'Add something while it works…'") && app.includes("cancelBtn.textContent = 'Stop'"));
  assert.match(app, /function appendMessage\(chatId, role, content, into\) \{\n\s+if \(typeof simpleAskText === 'function'\) content = simpleAskText\(role, content\);/);
});

test('phone: setSendMode calls the Simple look and both bubbles pass through askText', () => {
  const m = read('mobile.js');
  assert.match(m, /if \(typeof simpleSendLook === 'function'\) simpleSendLook\(b, input, interject\);/);
  assert.match(m, /function simpleSendLook\(b, input, interject\) \{\n\s+if \(!simpleOn\(\) \|\| !interject\) return;/);
  assert.match(m, /function addUserBubble\(text, images\) \{\n\s+if \(typeof simpleAskText === 'function'\) text = simpleAskText\('user', text\);/);
  assert.match(m, /function addAssistantBubble\(content\) \{\n\s+if \(typeof simpleAskText === 'function'\) content = simpleAskText\('assistant', content\);/);
});
