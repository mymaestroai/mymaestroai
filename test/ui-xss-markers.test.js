'use strict';
// R3: the chat renderers (app.js formatContent, mobile.js formatContent) extract images, links, tables and
// visual blocks to placeholders, escape the rest, then re-insert. The placeholders used to be fixed strings
// (__IMG_TOKEN_n__ etc.) re-inserted in a fixed order (images before tables) with plain string .replace, and
// table cells did not escape quotes. Model or user text could therefore smuggle a table placeholder into an
// image's alt text, so table HTML (with raw quotes) landed inside an attribute and formed an event handler
// that ran on render. These tests lock the fix: per-render random markers, quote-safe table cells, and
// function-form re-insertion, in both renderers, with no fixed placeholder strings left.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.resolve(__dirname, '..', 'app.js'), 'utf8');
const mjs = fs.readFileSync(path.resolve(__dirname, '..', 'mobile.js'), 'utf8');
const pages = { 'app.js': app, 'mobile.js': mjs };

test('placeholder markers are per-render random and unforgeable in both renderers', () => {
  for (const [name, src] of Object.entries(pages)) {
    assert.match(src, /const MARK = 'm' \+ \(\(window\.crypto && crypto\.getRandomValues\) \? Array\.from\(crypto\.getRandomValues\(new Uint8Array\(16\)\), b => \(b % 36\)\.toString\(36\)\)\.join\(''\) : Math\.random\(\)/, `${name}: crypto-random marker per render`);
    assert.match(src, /const mk = \(kind, i\) => `\$\{MARK\}\$\{kind\}\$\{i\}~`/, `${name}: marker builder`);
    // Every extraction returns a mk(...) marker, and every re-insertion targets one.
    for (const kind of ['V', 'I', 'L', 'T']) {
      assert.ok(src.includes(`mk('${kind}',`), `${name}: marker used for kind ${kind}`);
    }
    // No fixed placeholder strings survive (those were the forgeable ones).
    assert.ok(!/__(IMG|LINK|TABLE|VIS)_TOKEN_/.test(src), `${name}: no fixed __*_TOKEN_ placeholders remain`);
  }
});

test('tables are re-inserted with a function replacer so table HTML cannot expand $-sequences', () => {
  for (const [name, src] of Object.entries(pages)) {
    assert.match(src, /replace\(mk\('T', i\), \(\) => /, `${name}: table re-insert uses a function replacer`);
    assert.match(src, /replace\(mk\('I', i\), \(\) => /, `${name}: image re-insert uses a function replacer`);
  }
});

test('table cells escape quotes, so table content can never break out of an HTML attribute', () => {
  // Desktop builds cells with fmtCell; the phone uses esc(), which already escapes both quote characters.
  assert.match(app, /const fmtCell = \(c\) => c\.trim\(\)\s*\n\s*\.replace\(\/&\/g, '&amp;'\)\.replace\(\/<\/g, '&lt;'\)\.replace\(\/>\/g, '&gt;'\)\.replace\(\/"\/g, '&quot;'\)\.replace\(\/'\/g, '&#39;'\)/, 'app.js fmtCell escapes quotes');
  assert.match(mjs, /function esc\(s\)[\s\S]{0,160}?replace\(\/"\/g, '&quot;'\)\.replace\(\/'\/g, '&#39;'\)/, 'mobile.js esc escapes quotes (used for table cells)');
});
