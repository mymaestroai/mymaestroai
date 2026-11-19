'use strict';
// Simple mode keeps the full-width chat: the messages and the composer follow --chat-max-width (none: the whole window)
// like the main view, on the desktop page and the phone page. Only the greeting, the starters and menus stay narrow.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('desktop Simple mode: no fixed width for the chat column; the composer shares the messages\' column', () => {
  const html = read('index.html');
  const css = html.slice(html.indexOf('<style id="simple-mode-css">'));
  assert.ok(css.length > 100, 'the Simple mode styles exist');
  assert.match(html, /:root \{[\s\S]*?--chat-max-width: none;/, 'the main view is full width');
  assert.doesNotMatch(css, /--chat-max-width:\s*\d/, 'Simple mode does not narrow the chat column');
  const composer = css.match(/html\.mm-simple \.input-area \{[^}]*\}/)[0];
  assert.match(composer, /max-width: var\(--chat-max-width\)/);
  assert.match(composer, /width: calc\(100% - 2 \* var\(--chat-pad-x\)\)/, 'same edges as the messages\' text');
  assert.match(css, /html\.mm-simple \.simple-empty \{[^}]*max-width: 720px/, 'the greeting stays narrow');
  assert.match(css, /html\.mm-simple \.message\.assistant > \.msg-time \{ left: 64px; right: auto; \}/, 'a reply\'s time sits under its text, on the left, after the Copy and Play buttons');
  const speak = css.match(/html\.mm-simple \.message > \.msg-speak \{ left: (\d+)px; \}/);
  assert.ok(speak, 'the Play button keeps its fixed place below a reply');
  assert.ok(64 >= Number(speak[1]) + 30, 'the time starts after the Play button (about 26px wide), so the two never overlap');
});

test('phone Simple mode: the messages and the composer are not capped at a fixed width', () => {
  const html = read('mobile.html');
  const css = html.slice(html.indexOf('<style id="simple-css">'));
  assert.doesNotMatch(css.match(/html\.mm-simple #messages \{[^}]*\}/)[0], /max-width/);
  assert.doesNotMatch(css.match(/html\.mm-simple #composer \.row \{[^}]*\}/)[0], /max-width/);
  assert.doesNotMatch(css, /html\.mm-simple (#messages|#composer \.row) \{[^}]*max-width: \d+px/, 'not in the wide (sidebar) layout either');
});
