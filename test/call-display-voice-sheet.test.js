'use strict';
// The phone's Voice sheet (Levels in the call panel, the menu's Voice) must open ABOVE the full-screen call view (orb or character):
// it used to open at z-index 25 under the view's 9999, so a tap on Levels during a call seemed to do nothing.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const z = (css, sel) => {
  const i = css.indexOf(sel + ' {');
  assert.ok(i >= 0, sel);
  const m = css.slice(i, css.indexOf('}', i)).match(/z-index:\s*(\d+)/);
  assert.ok(m, sel + ' has a z-index');
  return Number(m[1]);
};

test('the open Voice sheet sits above the full-screen call view, below the toast', () => {
  const css = read('lib/ui-call-display.css');
  const overlay = z(css, '.ucd-overlay'), sheet = z(css, 'body:has(> .ucd-overlay) .voice-sheet.open'), toast = z(css, '#toast.on');
  assert.ok(sheet > overlay, `sheet ${sheet} > view ${overlay}`);
  assert.ok(toast > sheet, `toast ${toast} > sheet ${sheet}`);
  assert.ok(!/(^|\n)\.voice-sheet\.open \{/.test(css), 'only while the view is in the page: outside a call the other sheets (approvals) keep their order');
  assert.match(read('lib/ui-call-display.js'), /const root = el\('div', 'ucd-overlay'\);/, 'the view\'s root is .ucd-overlay');
  assert.match(read('lib/ui-call-display.js'), /doc\.body\.appendChild\(ui\.root\)/, 'and it is a child of body while shown');
});

test('the phone page loads that stylesheet and its Levels button opens the Voice sheet', () => {
  const html = read('mobile.html'), js = read('mobile.js');
  assert.ok(/<link[^>]+href="\/?(lib\/)?ui-call-display\.css/.test(html) || html.includes('ui-call-display.css'), 'mobile.html loads ui-call-display.css');
  assert.ok(js.includes("$('cp-levels')?.addEventListener('click', () => openVoiceSheet());"));
  assert.match(html, /\.rsn-sheet \{[^}]*z-index: 25;/, 'the sheets\' own z-index (under the view without the rule above)');
});
