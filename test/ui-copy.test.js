'use strict';
// Desktop copy button: every function that (re)builds a message bubble's HTML must put the copy button back,
// otherwise streamed replies (renderSteps / updateMessageWithTools) show no copy control. Source-string tests.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function body(name) {
  const at = app.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} exists`);
  const next = app.indexOf('\n    function ', at + 10);
  return app.slice(at, next > 0 ? next : undefined);
}

test('every message render path adds the copy button', () => {
  for (const fn of ['appendMessage', 'appendMessageWithImages', 'appendGroupMessage', 'appendSynthesisMessage',
    'updateMessage', 'renderSteps', 'updateMessageWithTools', 'updateGroupMessage', 'updateSynthesisMessage']) {
    const b = body(fn);
    if (!/innerHTML = /.test(b)) continue;
    assert.match(b, /decorateMessage\(/, `${fn} re-adds the copy button after setting innerHTML`);
  }
});

test('the copy button stays faintly visible and copies the message source', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(css, /\.message > \.msg-copy \{[\s\S]*?opacity: 0\.45;/);
  assert.match(app, /const text = rawMessageText\.get\(el\) \?\? el\.innerText;/);
});
