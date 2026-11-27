'use strict';
// The Call display pickers paint readable text on Linux WebKit (explicit colour, background and colour-scheme, light and dark), and the control is
// called "Call display" everywhere outside the agent card (never just "Display").
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const idx = read('index.html'), mob = read('mobile.html'), app = read('app.js'), cd = read('lib/ui-call-display.js');

test('index.html: the call bar, voice pop and drawer pickers set colour, background and colour-scheme (dark, light under html.mm-light)', () => {
  assert.match(idx, /\.voice-pop select\[data-vp="display"\][^{]*\{[^}]*color: var\(--text\);[^}]*background-color: var\(--bg-input\);[^}]*color-scheme: dark;/);
  assert.match(idx, /\.voice-callbar select\[data-vcb="display"\][^{]*\{[^}]*color: var\(--text\)/);
  assert.match(idx, /select\.ucd-display\s*\{[^}]*color-scheme: dark/);
  assert.match(idx, /html\.mm-light \.voice-pop select\[data-vp="display"\][^{]*\{[^}]*color-scheme: light;/);
  assert.match(idx, /select\[data-vp="display"\] option[^{]*\{[^}]*color: var\(--text\);[^}]*background-color: var\(--bg-input\)/);
});

test('mobile.html: #cp-display, #vp-display and the drawer picker set colour, background and colour-scheme (dark, light under html.mm-light)', () => {
  assert.match(mob, /select#cp-display, select#vp-display, select\.ucd-display\s*\{[^}]*color: var\(--text\);[^}]*background-color: var\(--bg-input\);[^}]*color-scheme: dark;/);
  assert.match(mob, /html\.mm-light select#cp-display, html\.mm-light select#vp-display[^{]*\{[^}]*color-scheme: light;/);
  assert.match(mob, /select#cp-display option[^{]*\{[^}]*color: var\(--text\);[^}]*background-color: var\(--bg-input\)/);
});

test('no label, aria-label or title of the Call display control reads just "Display"', () => {
  assert.ok(!/<span>Display<\/span>/.test(mob), 'mobile.html label');
  assert.ok(!/ucd-dup">Display </.test(app), 'app.js call bar label');
  assert.ok(!/aria-label="Display"/.test(app + mob + idx), 'aria-label');
  assert.ok(!/'ucd-disp-text', 'Display'/.test(cd), 'drawer label');
  assert.ok(!/setAttribute\('aria-label', 'Display'\)/.test(cd), 'drawer aria-label');
  assert.match(cd, /'ucd-disp-text', 'Call display'/);
  assert.match(app, /aria-label="Call display"/);
  assert.match(mob, /<span>Call display<\/span><select id="cp-display">/);
});
