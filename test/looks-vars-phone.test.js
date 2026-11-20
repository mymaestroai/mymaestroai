'use strict';
// The phone page (mobile.html + mobile.js) takes every colour and font stack from CSS variables,
// so one "look" stylesheet can restyle it. These tests pin that.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'mobile.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'mobile.js'), 'utf8');

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => stripComments(m[1]));
const css = styleBlocks.join('\n');

// Not defined anywhere on purpose: both are always used with a fallback
// (var(--bg-secondary, var(--bg-input)) and var(--text-secondary, inherit)); a look may define them.
const RUNTIME_VARS = new Set(['--bg-secondary', '--text-secondary']);

function rootDefinitions() {
  const m = css.match(/:root\s*\{([\s\S]*?)\n\s{4}\}/);
  assert.ok(m, ':root block found');
  return new Set([...m[1].matchAll(/(--[\w-]+)\s*:/g)].map((x) => x[1]));
}

test('every var(--x) used in mobile.html and mobile.js is defined in :root', () => {
  const defined = rootDefinitions();
  // custom properties declared anywhere in the style blocks (the Simple view re-declares some) count too
  for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
  const used = new Set();
  for (const text of [html, js]) for (const m of text.matchAll(/var\((--[\w-]+)/g)) used.add(m[1]);
  const missing = [...used].filter((v) => !defined.has(v) && !RUNTIME_VARS.has(v));
  assert.deepStrictEqual(missing.sort(), [], 'undefined variables: ' + missing.join(', '));
});

test('mobile.html styles carry no colour literal outside custom-property declarations', () => {
  // Allow-list (each entry: reason).
  //  - '#000' inside the mask-image gradient: an alpha mask, not a visible colour.
  const ALLOW = [/mask-image:\s*linear-gradient\(to bottom, transparent 0, #000 60%\)/];
  const lit = /(?<![\w-])(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|(?:white|black)(?![\w-]))/g;
  const offenders = [];
  for (const line of css.split('\n')) {
    if (/^\s*--[\w-]+\s*:/.test(line)) continue; // a variable declaration (:root or the Simple view's theme blocks)
    if (ALLOW.some((re) => re.test(line))) continue;
    for (const m of line.matchAll(lit)) offenders.push(line.trim().slice(0, 80) + ' => ' + m[0]);
  }
  assert.deepStrictEqual(offenders, []);
});

test('mobile.html inline style attributes carry no colour literal', () => {
  const bad = [];
  for (const m of html.matchAll(/style="([^"]*)"/g)) {
    if (/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(m[1])) bad.push(m[1]);
  }
  assert.deepStrictEqual(bad, []);
});

test('mobile.html uses the font variables, with no font stack left inline', () => {
  const defined = rootDefinitions();
  for (const v of ['--font-ui', '--font-mono', '--font-heading', '--font-reading']) assert.ok(defined.has(v), v);
  const rules = css.split('\n').filter((l) => !/^\s*--[\w-]+\s*:/.test(l));
  const stacks = rules.filter((l) => /(font-family|font)\s*:[^;}]*(monospace|sans-serif|apple-system)/.test(l));
  assert.deepStrictEqual(stacks, []);
});

test('mobile.js: inline hex/rgb colours are limited to the palette/chart/QR/iframe allow-list', () => {
  // The dialog-helpers block is skipped whole: it must stay byte-identical in lib/ui-dialog.js, app.js and mobile.js
  // (test/ui-dialog.test.js); its CSS keeps var(--x, #fallback) pairs and rgba() literals that never change per page.
  const dFrom = js.indexOf('// ── dialog helpers (begin) ──'), dTo = js.indexOf('// ── dialog helpers (end) ──');
  assert.ok(dFrom > 0 && dTo > dFrom, 'dialog helpers block present');
  const dFirst = js.slice(0, dFrom).split('\n').length, dLast = js.slice(0, dTo).split('\n').length;
  const lines = js.split('\n').map((l, i) => ({ l, n: i + 1 })).filter(({ n }) => n < dFirst || n > dLast).filter(({ l }) => /#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(l));
  const allowed = [
    /^const VISUAL_PALETTE = /, // chart series colours (inside a generated iframe document, no page variables there)
    /^const VISUAL_TEXT = /, // same iframe
    /^const VISUAL_GRID = /, // same iframe
    /^const VISUAL_SURFACE = /, // same iframe
    /VISUAL_SURFACE\};color:#ffffff;font-family:system-ui/, // the chart iframe's own document
    /reached \|\| pct >= 100 \? '#d4588b'/, // subscription bar level colours picked by code (threshold palette)
    /window\.qrcode\.svg\(d\.uri, \{ size: 180, margin: 2, dark: '#000', light: '#fff' \}\)/, // QR code needs real colours
  ];
  const offenders = lines.filter(({ l }) => !allowed.some((re) => re.test(l.trim())) ).map(({ l, n }) => n + ': ' + l.trim().slice(0, 90));
  assert.deepStrictEqual(offenders, []);
  assert.ok(lines.length <= allowed.length, 'no more literal lines than the allow-list');
});

test('mobile.js inline styles reference variables for the converted places', () => {
  // the dialog block is byte-identical with lib/ui-dialog.js, so the backdrop keeps its literal (same value as --overlay-bg-discard)
  assert.match(js, /\.dlg-discard::backdrop\{background:rgba\(0,0,0,\.55\)\}/);
  assert.match(html, /--overlay-bg-discard:\s*rgba\(0,0,0,\.55\);/);
  assert.match(js, /'var\(--accent\)' : 'transparent'/);
  assert.match(js, /style="color:var\(--error\)"/);
});
