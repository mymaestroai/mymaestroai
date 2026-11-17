'use strict';
// Simple's desktop message box: the text on its own full-width row, the controls on a row underneath
// (attach and the reasoning level left; mic, call and Send right). Advanced's rules are untouched.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const css = html.slice(html.indexOf('<style id="simple-mode-css">'), html.indexOf('</style>', html.indexOf('<style id="simple-mode-css">')));

test('the box wraps: the text row is full width and comes first', () => {
  assert.match(css, /html\.mm-simple \.input-area \{[^}]*flex-wrap: wrap;/);
  assert.match(css, /html\.mm-simple \.input-area > \* \{ order: 5; \}/);
  assert.match(css, /html\.mm-simple \.input-wrapper \{[^}]*order: 0; flex: 1 1 100%; width: 100%;/);
});

test('controls row: attach then the reasoning level on the left, the rest pushed right', () => {
  assert.match(css, /html\.mm-simple \.input-area > button\[title\^="Attach"\] \{ order: 1; \}/);
  assert.match(css, /html\.mm-simple \.input-area > \.simple-lvl \{ order: 2; margin-right: auto; \}/);
  assert.match(css, /html\.mm-simple \.input-area:not\(:has\(> \.simple-lvl\.on\)\) > button\[title\^="Attach"\] \{ margin-right: auto; \}/);
});

test('the text grows a few lines, then scrolls', () => {
  assert.match(css, /html\.mm-simple \.input-area textarea \{ width: 100%; min-height: 44px; max-height: 168px; overflow-y: auto;/);
});

test('every new rule is scoped to Simple', () => {
  for (const line of css.split('\n').filter((l) => /input-area|input-wrapper/.test(l) && /\{/.test(l))) {
    assert.ok(line.trim().startsWith('html.mm-simple') || line.trim().startsWith('@media') || line.trim().startsWith('/*'), line.trim().slice(0, 80));
  }
});
