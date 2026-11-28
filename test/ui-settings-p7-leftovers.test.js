'use strict';
// Settings phase 7 leftovers, part A: the Expert values right column, the switch rows' label, the build-partner checkbox line,
// names that repeat their unit, dark selects and the narrow boxes. String checks of app.js / index.html plus the real row function.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/ui-settings-groups.js');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fnSrc(name) {
  const i = app.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} is in app.js`);
  let d = 0, j = app.indexOf(') {', i) + 2;
  for (; j < app.length; j++) { if (app[j] === '{') d++; else if (app[j] === '}' && --d === 0) break; }
  return app.slice(i, j + 1);
}
const rowHtml = (r) => new Function('STG', 'esc', `${fnSrc('p5cPlaceholder')}\n${fnSrc('p5cRowHtml')}\nreturn p5cRowHtml;`)(G, esc)(r, {});
const rule = (sel) => { const m = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(html); assert.ok(m, `rule ${sel}`); return m[1]; };

test('A1: the right column of an Expert values row is a fixed track, so every box starts at the same x', () => {
  const body = rule('.st-row.st-xrow');
  assert.match(body, /grid-template-columns: minmax\(0, 1fr\) 340px;/);
  assert.ok(!/minmax\(0, 340px\)/.test(body), 'not a track that follows its own content');
  assert.match(rule('.st-xrow .st-xr'), /justify-self: start/);
  // the phone and narrow stacking is kept
  assert.match(html, /@media \(max-width: 720px\) \{\s*\.st-row\.st-xrow \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(html, /html\.mm-settings-only \.st-row\.st-xrow \{ grid-template-columns: minmax\(0, 1fr\); \}/);
});

test('A2: a switch row\'s name label points at the switch, so its ⓘ lands after the name', () => {
  const sw = G.P5C.filter((r) => r.kind === 'switch');
  assert.ok(sw.length > 0);
  for (const r of sw) {
    const h = rowHtml(r);
    assert.ok(h.includes(`<label for="${r.id}">${esc(r.name)}</label>`), `${r.key}: label for the switch`);
    assert.ok(h.includes(`<input type="checkbox" id="${r.id}" data-setting="${r.opt}"`), `${r.key}: the switch carries the id and data-setting`);
  }
});

test('A3: the build-partner checkbox and its words share one line, the info button after the words', () => {
  const at = app.indexOf('id="st-hw-notice"');
  assert.ok(at > 0);
  const line = app.slice(app.lastIndexOf('<label', at), app.indexOf('</label>', at) + 8);
  assert.match(line, /^<label class="gs-sub st-check"[^>]*><input type="checkbox" id="st-hw-notice"[^>]*> Tell the lead when an agent has no build partner<\/label>$/);
  assert.match(rule('.st-row label.st-check'), /display: inline-flex/);
  assert.match(rule('.st-row label.st-check'), /align-items: flex-start/);
  assert.match(rule('.st-row label.st-check > input[type="checkbox"]'), /flex: none/);
  // the words take the row's width and the ⓘ sits at the row's right edge, level with the first line (Easel: it covered "lead")
  assert.match(html, /\.st-row > label\.st-check \+ \.st-info \{ margin-left: auto; align-self: flex-start; \}/);
  assert.match(html, /html\.mm-settings-only \.st-row > label\.st-check \{[^}]*flex: 1 1 auto !important/);
});

test('A4: no Expert values name repeats the unit shown after its box', () => {
  assert.strictEqual(G.P5C.find((r) => r.key === 'filesMaxUploadMb').name, 'Biggest upload');
  assert.strictEqual(G.P5C.find((r) => r.key === 'filesZipMaxMb').name, 'Biggest zip download');
  for (const r of G.P5C.filter((x) => x.kind === 'num' && x.unit)) {
    const m = /\(([^)]*)\)\s*$/.exec(r.name);
    if (m) assert.ok(m[1].toLowerCase() !== String(r.unit).toLowerCase(), `${r.key}: "${r.name}" repeats ${r.unit}`);
    assert.ok(!new RegExp(`\\(${String(r.unit).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`, 'i').test(r.name), `${r.key}: no "(${r.unit})" in its name`);
  }
});

test('A5: a select in a Settings row is a dark field like the inputs', () => {
  const body = rule('.st-row select');
  assert.match(body, /background: var\(--bg-input\)/);
  assert.match(body, /border: 1px solid var\(--border\)/);
  assert.match(body, /color: var\(--text\)/);
  assert.ok(html.indexOf('.st-row select {') > 0 && !/\n\s*select \{/.test(html), 'scoped to Settings rows; no bare select rule');
});

test('A6: the narrow day boxes keep room for 4 digits', () => {
  // border-box: the box is max-width wide with its padding and border inside; a character of the 0.8rem field is about 7.7px
  for (const id of ['st-cap-month-day', 'st-credit-day']) {
    const at = app.indexOf(`id="${id}"`);
    const tag = app.slice(app.lastIndexOf('<input', at), app.indexOf('>', at));
    assert.match(tag, /class="st-narrow"/, id);
    const w = Number(/max-width:(\d+)px/.exec(tag)[1]);
    const pad = /padding-left: (\d+)px; padding-right: (\d+)px/.exec(rule('.st-row input.st-narrow'));
    const room = w - 2 - Number(pad[1]) - Number(pad[2]);
    assert.ok(room >= 4 * 7.7 + 2, `${id}: ${room}px inside for 4 digits`);
  }
  // the other narrow boxes: number boxes of 90 px keep 4 digits even with the spin buttons (90 - 2 - 20 - 16 = 52)
  assert.ok(90 - 2 - 20 - 16 >= 4 * 7.7);
});

test('the Expert values grid wins over the general .st-row flex rule (same weight, later in the file), on desktop and stacked on narrow screens', () => {
  const idx = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(idx, /\n\s*\.st-row\.st-xrow \{ display: grid; grid-template-columns: minmax\(0, 1fr\) 340px;/);
  assert.ok(!/\n\s*\.st-xrow \{ display: grid/.test(idx), 'a lone .st-xrow display rule loses to .st-row { display: flex }');
  assert.match(idx, /@media \(max-width: 720px\) \{\s*\n\s*\.st-row\.st-xrow \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(idx, /html\.mm-settings-only \.st-row\.st-xrow \{ grid-template-columns: minmax\(0, 1fr\); \}/);
});
