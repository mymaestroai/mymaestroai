'use strict';
// The Quiet Page look stylesheet (looks/quiet.css): scoped, complete, nothing hidden, offline, readable.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CSS_PATH = path.join(__dirname, '..', 'looks', 'quiet.css');
// the variables each page defines in :root (the source of truth the vars-*.md notes were written from)
const PAGE_OF = { 'vars-desktop.md': 'index.html', 'vars-phone.md': 'mobile.html' };
const css = fs.readFileSync(CSS_PATH, 'utf8');
const SCOPE = 'html[data-look="quiet"]';

// the css without comments (the header comment lists colours and must not count as rules)
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');

// split a block of css into top-level pieces: { head, body|null }; at-rules with a block are recursed by the caller
function pieces(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (i >= src.length) break;
    let j = i, depth = 0, paren = 0, quote = null;
    for (; j < src.length; j++) {
      const c = src[j];
      if (quote) { if (c === quote && src[j - 1] !== '\\') quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '(') paren++;
      else if (c === ')') paren--;
      else if (c === '{' && paren === 0) break;
      else if (c === ';' && paren === 0) break;
    }
    if (j >= src.length) throw new Error('unterminated css near: ' + src.slice(i, i + 60));
    if (src[j] === ';') { out.push({ head: src.slice(i, j).trim(), body: null }); i = j + 1; continue; }
    const head = src.slice(i, j).trim();
    let k = j + 1; depth = 1; quote = null;
    for (; k < src.length && depth > 0; k++) {
      const c = src[k];
      if (quote) { if (c === quote && src[k - 1] !== '\\') quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    if (depth !== 0) throw new Error('unbalanced braces near: ' + head);
    out.push({ head, body: src.slice(j + 1, k - 1) });
    i = k;
  }
  return out;
}

function splitSelectors(head) {
  const parts = []; let cur = '', paren = 0, bracket = 0;
  for (const c of head) {
    if (c === '(') paren++; else if (c === ')') paren--; else if (c === '[') bracket++; else if (c === ']') bracket--;
    if (c === ',' && paren === 0 && bracket === 0) { parts.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function collectRules(src, into) {
  for (const p of pieces(src)) {
    if (p.head.startsWith('@')) {
      assert.ok(/^@(media|supports)\b/.test(p.head), 'only @media and @supports blocks are allowed, found: ' + p.head);
      assert.ok(p.body !== null, 'an at-rule without a block is not allowed: ' + p.head);
      collectRules(p.body, into);
    } else {
      assert.ok(p.body !== null, 'stray text outside a rule: ' + p.head);
      into.push({ selectors: splitSelectors(p.head), body: p.body });
    }
  }
  return into;
}

test('every rule is scoped to html[data-look="quiet"]', () => {
  const rules = collectRules(bare, []);
  assert.ok(rules.length > 25, 'expected a real stylesheet, found ' + rules.length + ' rules');
  for (const r of rules) {
    for (const sel of r.selectors) {
      assert.ok(sel.startsWith(SCOPE), 'selector not scoped: ' + sel);
      // the scope must be the html element itself: the next character ends the compound or continues it
      assert.ok(/^html\[data-look="quiet"\](?=$|[\s.:#\[>+~])/.test(sel), 'bad scope: ' + sel);
    }
  }
  // no keyframes (their selectors cannot be scoped), no :root rule
  assert.ok(!/@keyframes/.test(bare), 'no @keyframes');
});

function varNames(file) {
  const page = fs.readFileSync(path.join(__dirname, '..', PAGE_OF[file]), 'utf8');
  const names = new Set();
  for (const block of page.matchAll(/:root\s*\{([^}]*)\}/g)) for (const m of block[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]*)/gi)) if (!/env\(/.test(m[2])) names.add(m[1]);   // safe-area insets come from the device, not the look
  return names;
}

test('it sets every variable named in vars-desktop.md and vars-phone.md', () => {
  const wanted = new Set([...varNames('vars-desktop.md'), ...varNames('vars-phone.md')]);
  assert.ok(wanted.size > 300, 'parsed too few variable names: ' + wanted.size);
  const set = new Set();
  for (const r of collectRules(bare, [])) for (const m of r.body.matchAll(/(?:^|[;\s])(--[a-z0-9-]+)\s*:/g)) set.add(m[1]);
  const missing = [...wanted].filter((n) => !set.has(n));
  assert.deepStrictEqual(missing, [], 'variables not set: ' + missing.join(', '));
});

test('the small pages\' own variables are set too', () => {
  const extra = ['--bg', '--card', '--soft', '--input', '--dim', '--warn', '--bg-soft', '--tiger',
    '--bg-dark', '--bg-card', '--bg-input', '--border', '--border-strong', '--text', '--text-dim', '--text-tertiary',
    '--accent', '--accent-hover', '--error', '--warning', '--success', '--radius'];
  for (const n of extra) assert.ok(new RegExp('(^|[;\\s{])' + n + '\\s*:').test(bare), n + ' not set');
});

test('nothing is hidden', () => {
  const bad = [
    [/display\s*:\s*none/i, 'display: none'],
    [/visibility\s*:\s*hidden/i, 'visibility: hidden'],
    [/(^|[^-\w])opacity\s*:\s*0(\.0+)?\s*(;|}|!|$)/im, 'opacity: 0'],
    [/(^|[^-\w])(min-|max-)?height\s*:\s*0(px|em|rem|%)?\s*(;|}|!|$)/im, 'height: 0'],
    [/font-size\s*:\s*0(px|em|rem|%)?\s*(;|}|!|$)/im, 'font-size: 0'],
    [/(left|right|top|bottom)\s*:\s*-\s*\d{3,}/i, 'off-screen position'],
    [/text-indent\s*:\s*-\s*\d{3,}/i, 'off-screen text-indent'],
    [/clip\s*:\s*rect\(\s*0/i, 'clip: rect(0'],
    [/clip-path\s*:\s*inset\(\s*(50|100)%/i, 'clip-path inset hiding'],
    [/(^|[^-\w])(width)\s*:\s*0(px)?\s*(;|}|!|$)/im, 'width: 0'],
  ];
  for (const [re, label] of bad) assert.ok(!re.test(bare), 'hiding declaration found: ' + label);
});

test('offline: no url( to the network, no @import, no @font-face', () => {
  assert.ok(!/@import/i.test(bare), '@import');
  assert.ok(!/@font-face/i.test(bare), '@font-face');
  for (const m of bare.matchAll(/url\(\s*([^)]*)\)/gi)) {
    const u = m[1].replace(/^['"]|['"]$/g, '').trim();
    assert.ok(!/^(https?:)?\/\//i.test(u), 'network url: ' + u);
    assert.ok(/^data:/i.test(u), 'only data: urls may be used, found: ' + u);
  }
  assert.ok(!/https?:\/\//i.test(bare), 'no http(s) address anywhere in the rules');
});

test('no emoji with a variation selector', () => {
  assert.ok(!css.includes('\uFE0F'));
});

// ---- contrast ----
function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test('the contrast pairs in the header comment are each at least 4.5 (UI borders: 3), and the stated ratios are right', () => {
  const header = css.match(/^\s*\/\*[\s\S]*?\*\//);
  assert.ok(header, 'a header comment is required');
  const pairs = [];
  for (const line of header[0].split('\n')) {
    const m = line.match(/(#[0-9A-Fa-f]{6})\s+on\s+(#[0-9A-Fa-f]{6})\s+([\d.]+)/);
    if (m) pairs.push({ fg: m[1], bg: m[2], stated: parseFloat(m[3]), min: /\(UI\b/.test(line) ? 3 : 4.5, line: line.trim() });
  }
  assert.ok(pairs.length >= 30, 'expected at least 30 listed pairs, found ' + pairs.length);
  const problems = [];
  for (const p of pairs) {
    const r = ratio(p.fg, p.bg);
    if (r < p.min) problems.push('contrast ' + r.toFixed(2) + ' < ' + p.min + ' for: ' + p.line);
    if (Math.abs(r - p.stated) > 0.06) problems.push('stated ' + p.stated + ' but computed ' + r.toFixed(2) + ' for: ' + p.line);
  }
  assert.deepStrictEqual(problems, []);
});

test('the variables that carry text and their backgrounds agree with the header (text, accent, status)', () => {
  const get = (n) => {
    const m = bare.match(new RegExp('(?:^|[;\\s{])' + n + '\\s*:\\s*(#[0-9A-Fa-f]{6})\\s*;'));
    assert.ok(m, n + ' should be a plain hex colour');
    return m[1];
  };
  const paper = get('--bg-dark'), sheet = get('--bg-card'), input = get('--bg-input');
  for (const bg of [paper, sheet, input]) {
    for (const n of ['--text', '--text-dim', '--text-tertiary', '--accent', '--accent-hover', '--success', '--warning', '--error', '--link', '--code-text']) {
      assert.ok(ratio(get(n), bg) >= 4.5, n + ' on ' + bg + ' = ' + ratio(get(n), bg).toFixed(2));
    }
  }
  for (const n of ['--accent', '--success', '--warning', '--error']) {
    assert.ok(ratio(get('--on-color-text'), get(n)) >= 4.5, 'on-color-text on ' + n);
  }
  assert.ok(ratio(get('--msg-user-text'), '#EEF2E6') >= 4.5, 'user text on the tinted box');
  for (const n of ['--banner-backup-bg', '--banner-critical-bg', '--banner-info-bg', '--banner-pending-bg', '--banner-setup-bg', '--banner-warn-bg',
    '--halt-banner-bg', '--health-notice-bg', '--pacing-bar-bg', '--st-btn-bk-danger-bg', '--call-bg']) {
    assert.ok(ratio('#FFFFFF', get(n)) >= 4.5, 'white text on ' + n + ' = ' + ratio('#FFFFFF', get(n)).toFixed(2));
  }
});
