'use strict';
// Broadsheet House look stylesheet (looks/broadsheet.css): scope, variable coverage, nothing hidden, no network, contrast.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CSS_FILE = path.join(__dirname, '..', 'looks', 'broadsheet.css');
// the variables each page defines in :root (the source of truth the vars-*.md notes were written from)
const PAGE_OF = { 'vars-desktop.md': 'index.html', 'vars-phone.md': 'mobile.html' };
const SCOPE = 'html[data-look="broadsheet"]';
const css = fs.readFileSync(CSS_FILE, 'utf8');
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');

// Split a stylesheet into top-level rules; recurse into @media / @supports.
function rules(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    const sel = src.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (j < src.length && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
    const body = src.slice(open + 1, j - 1);
    if (/^@(media|supports)/.test(sel)) out.push(...rules(body)); else out.push({ sel, body });
    i = j;
  }
  return out;
}

function varNames(file) {
  const page = fs.readFileSync(path.join(__dirname, '..', PAGE_OF[file]), 'utf8');
  const names = new Set();
  for (const block of page.matchAll(/:root\s*\{([^}]*)\}/g)) for (const m of block[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]*)/gi)) if (!/env\(/.test(m[2])) names.add(m[1]);   // safe-area insets come from the device, not the look
  return [...names];
}

function lum(hex) {
  const h = hex.replace('#', '');
  const c = [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
function declared(name) {
  const m = css.match(new RegExp('^\\s*' + name.replace(/[-]/g, '\\-') + '\\s*:\\s*(#[0-9a-fA-F]{6})\\s*;', 'm'));
  return m ? m[1].toUpperCase() : null;
}

test('every rule is scoped to html[data-look="broadsheet"]', () => {
  const all = rules(stripped);
  assert.ok(all.length > 10, 'stylesheet has rules');
  const bad = [];
  for (const r of all) {
    for (const s of r.sel.split(',').map((x) => x.trim())) if (!s.startsWith(SCOPE)) bad.push(s);
  }
  assert.deepStrictEqual(bad, []);
});

test('sets every variable named in vars-desktop.md and vars-phone.md', () => {
  const names = [...new Set([...varNames('vars-desktop.md'), ...varNames('vars-phone.md')])];
  assert.ok(names.length > 250, 'parsed the variable lists (' + names.length + ')');
  const missing = names.filter((n) => !new RegExp('^\\s*' + n + '\\s*:', 'm').test(stripped));
  assert.deepStrictEqual(missing, []);
});

test('sets the variable names of the small pages too', () => {
  for (const n of ['--bg', '--card', '--soft', '--input', '--dim', '--warn', '--bg-soft', '--tiger']) {
    assert.ok(new RegExp('^\\s*' + n + '\\s*:', 'm').test(stripped), n);
  }
});

test('nothing is hidden', () => {
  const banned = [
    /display\s*:\s*none/i, /visibility\s*:\s*hidden/i, /opacity\s*:\s*0(?:\.0+)?\s*(?:;|!|\}|$)/im,
    /(?:^|[;{\s])height\s*:\s*0(?:px)?\s*(?:;|!|\}|$)/im, /font-size\s*:\s*0(?:px|rem|em)?\s*(?:;|!|\}|$)/im,
    /(?:left|right|top|bottom|text-indent)\s*:\s*-\d{3,}/i, /clip-path\s*:/i, /\bclip\s*:\s*rect/i,
  ];
  for (const re of banned) assert.ok(!re.test(stripped), 'found ' + re);
});

test('no network url(), @import or @font-face', () => {
  assert.ok(!/@import/i.test(stripped));
  assert.ok(!/@font-face/i.test(stripped));
  assert.ok(!/url\(/i.test(stripped), 'no url() at all');
  assert.ok(!/https?:\/\//i.test(stripped));
  assert.ok(!/\uFE0F/.test(css), 'no variation selector');
});

test('Simple mode keeps its palette: the colour block excludes html.mm-simple', () => {
  const colourRule = rules(stripped).find((r) => /--bg-dark\s*:/.test(r.body));
  assert.ok(colourRule && /:not\(\.mm-simple\)/.test(colourRule.sel));
  const simple = rules(stripped).filter((r) => /\.mm-simple\s*$/.test(r.sel) && !/:not/.test(r.sel));
  assert.ok(simple.length >= 1);
  for (const r of simple) assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(r.body), 'Simple rule carries fonts only');
});

test('contrast pairs listed in the header are each >= 4.5 and match the hex values in the file', () => {
  const head = css.slice(0, css.indexOf('*/'));
  const pairs = [...head.matchAll(/PAIR\s+(\S+)\s+(#[0-9A-Fa-f]{6})\s+on\s+(\S+)\s+(#[0-9A-Fa-f]{6})\s*=\s*([\d.]+)/g)];
  assert.ok(pairs.length >= 30, 'header lists the main pairs (' + pairs.length + ')');
  const problems = [];
  for (const [, fn, fh, bn, bh, stated] of pairs) {
    for (const [n, h] of [[fn, fh], [bn, bh]]) {
      const d = n.startsWith('--') ? declared(n) : null;
      if (n.startsWith('--') && d !== h.toUpperCase() && !(n === '--ochre' && h.toUpperCase() === '#E6D9BE')) problems.push(`${n} is ${d}, header says ${h}`);
    }
    const r = ratio(fh, bh);
    if (r < 4.5) problems.push(`${fn} on ${bn}: ${r.toFixed(2)} < 4.5`);
    if (Math.abs(r - parseFloat(stated)) > 0.06) problems.push(`${fn} on ${bn}: header says ${stated}, computed ${r.toFixed(2)}`);
  }
  assert.deepStrictEqual(problems, []);
});

test('full width: the reading column and the message box are not capped (desktop and phone)', () => {
  assert.match(stripped, /--chat-max-width:\s*none;/, 'the desktop column keeps Engineering\'s --chat-max-width (none)');
  assert.deepStrictEqual([...stripped.matchAll(/--chat-max-width\s*:\s*([^;]+);/g)].map(m => m[1].trim()), ['none'], 'set once, to none');
  const phoneList = stripped.match(/#messages\s*\{([^}]*)\}/);
  assert.ok(phoneList, 'the phone message list rule exists');
  assert.doesNotMatch(phoneList[1], /max-width|margin\s*:\s*0 auto/, 'the phone message list fills the screen');
});
