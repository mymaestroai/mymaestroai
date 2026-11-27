'use strict';
// Settings phase 7: layout and words of the P5C rows and the Startup values module (string/regex checks of the HTML, CSS and pure functions).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/ui-settings-groups.js');
const X = require('../lib/ui-settings-expert.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const row = (k) => G.P5C.find((r) => r.key === k);

test('the Reuse earlier text switch and its box wrap inside the right column; Default: ... is in the help paragraph', () => {
  // (was: the "-def" span sat on its own full-width line; it now ends the help paragraph, see ui-settings-p7-design.test.js)
  assert.match(html, /span\[id\^="st-p5c-"\]\[data-setting\]:has\(> select\) \{[^}]*flex-wrap: wrap/);
});

test('number boxes are wide enough for the placeholder and 7 digits', () => {
  assert.match(html, /\.st-row input\[type="number"\]\[data-setting\], \.st-row input\.st-numbox \{[^}]*min-width: calc\(9ch \+ 34px\)/);
  assert.match(html, /\.st-row input\[type="number"\]\[data-setting\][^{]*\{[^}]*max-width: 100% !important/);   // outranks the inline 110px
  const mod = X.models([{ key: 'HUB_UPDATE_CHECK_HOURS', value: null, set: false, writable: true, readonly: false, danger: false, running: null, pending: false }], [], null);
  const out = X.expertHtml(mod);
  assert.match(out, /type="number"[^>]*class="st-numbox" style="width:12ch;min-width:calc\(9ch \+ 34px\)"/);
  assert.ok(!/width:9em/.test(out));
  assert.match(X.memoryHtml({ name: 'Memory limit', value: '', shown: 'Automatic' }), /class="st-numbox" style="width:13ch;min-width:calc\(9ch \+ 34px\)"/);
});

test('the module block is Startup values, not a second Expert values', () => {
  const mod = X.models([{ key: 'HUB_UPDATE_CHECK_HOURS', value: null, set: false, writable: true, readonly: false, danger: false, running: null, pending: false }], [], null);
  const out = X.expertHtml(mod);
  assert.ok(out.includes('>Startup values<') && !out.includes('Expert values'));
});

test('no row or module word says hub', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ui-settings-groups.js'), 'utf8');
  for (const r of G.P5C) assert.ok(!/\bhub\b/i.test(`${r.name} ${r.hint} ${r.def || ''}`), r.key);
  assert.strictEqual(row('hubBrief').name, 'Briefing for your lead');
  assert.ok(!/(toast|Error)\([^\n]*\bthe hub\b/.test(src), 'no toast or error says "the hub"');
  const mod = X.models([{ key: 'HUB_UPDATE_CHECK_HOURS', value: null, set: false, writable: true, readonly: false, danger: false, running: null, pending: false }], [], null);
  assert.ok(!/\bhub\b/i.test(X.expertHtml(mod).replace(/HUB_[A-Z_]+/g, '')));
});

test('a row that ends in a toggle shows its info button right after the label', () => {
  assert.match(html, /\.st-row:has\(> \.toggle-switch, > span > \.toggle-switch\) > label:first-child \{ order: -2; \}/);
  assert.match(html, /\.st-row:has\(> \.toggle-switch, > span > \.toggle-switch\) > \.st-info \{ order: -1; \}/);
  assert.match(html, /html\.mm-settings-only \.st-row:has\(> \.toggle-switch, > span > \.toggle-switch\) > label:first-child \{[^}]*calc\(100% - 44px\) !important/);
});

test('Create New Agent fits a narrow desktop window', () => {
  assert.match(html, /@media \(max-width: 720px\) \{\s*\.question-modal \{ min-width: 0 !important; width: calc\(100vw - 24px\); \}/);
});
