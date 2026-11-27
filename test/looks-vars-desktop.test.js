'use strict';
// The desktop page's colours and fonts go through CSS variables, so a "look" stylesheet can restyle it.
// index.html defines every variable in :root with the exact value of the literal it replaced; this test
// keeps the page from growing new hard-coded colours.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

// ---- helpers
function blockAt(text, startRe) {
  const m = startRe.exec(text);
  assert.ok(m, 'block not found: ' + startRe);
  const open = text.indexOf('{', m.index);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return { start: m.index, end: i + 1, body: text.slice(open + 1, i) }; }
  }
  throw new Error('unclosed block');
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
const allCss = styleBlocks.join('\n');
const rootBlock = blockAt(allCss, /(^|\n)\s*:root\s*\{/);
const rootDefs = new Map([...stripComments(rootBlock.body).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
// every custom property declared anywhere in index.html (the Simple-mode blocks, rule-local ones such as --auto-color)
const declaredAnywhere = new Set([...stripComments(html).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

// Variables that are not defined in :root on purpose.
//  - set at run time (style.setProperty in app.js / layoutBanners): --banner-h, --gs-dock-width
//  - never defined by the page, only ever used with a fallback or left invalid (so the property falls back
//    to its inherited value). Defining them would CHANGE today's look, so they stay undefined:
//    --bg-hover, --bg-secondary, --bg-primary, --text-muted, --danger, --green, --border-color
//  - defined only by the Simple-mode blocks (html.mm-simple): --text-primary, --text-secondary, --bg-tertiary, --sm-*
const RUNTIME_OR_UNDEFINED = new Set(['--banner-h', '--gs-dock-width', '--mm-rvb-text', '--mm-rvb-h', '--mm-rvb-top', '--bg-hover', '--bg-secondary', '--bg-primary',
  '--text-muted', '--danger', '--green', '--border-color']);

// ---- 1. every var(--x) has a definition
test('every var(--x) used in index.html has a definition', () => {
  const used = new Set([...stripComments(html).matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((n) => !declaredAnywhere.has(n) && !RUNTIME_OR_UNDEFINED.has(n));
  assert.deepStrictEqual(missing, []);
});

test('every var(--x) used in app.js is defined in :root (or is in the known list)', () => {
  const used = new Set([...app.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
  const bad = [...used].filter((n) => !rootDefs.has(n) && !RUNTIME_OR_UNDEFINED.has(n)
    && !['--text-primary', '--text-secondary', '--bg-tertiary'].includes(n)); // Simple-mode-only, always used with a fallback
  assert.deepStrictEqual(bad, []);
});

test(':root defines the look variables with literal or var() values', () => {
  for (const [name, val] of rootDefs) assert.ok(val.length > 0, name + ' is empty');
  for (const n of ['--font-ui', '--font-mono', '--font-heading', '--font-reading', '--sidebar-bg', '--panel-bg', '--msg-user-bg',
    '--msg-user-text', '--msg-agent-bg', '--msg-agent-text', '--tool-bg', '--tool-border', '--code-bg', '--code-text', '--link',
    '--overlay-bg', '--shadow-color', '--hover-tint', '--focus-ring']) {
    assert.ok(rootDefs.has(n), n + ' missing from :root');
  }
  assert.strictEqual(rootDefs.get('--font-heading'), 'var(--font-ui)');
  assert.strictEqual(rootDefs.get('--font-reading'), 'var(--font-ui)');
  assert.strictEqual(rootDefs.get('--font-ui'), "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif");
  assert.strictEqual(rootDefs.get('--font-mono'), "'Geist Mono', monospace");
  // Engineering's values: spot checks of the look's most visible ones (they must equal today's literals)
  assert.strictEqual(rootDefs.get('--msg-user-bg'), 'rgba(61,123,255,0.04)');
  assert.strictEqual(rootDefs.get('--code-text'), '#7eb3ff');
  assert.strictEqual(rootDefs.get('--link'), '#6ea8fe');
  assert.strictEqual(rootDefs.get('--accent'), '#3D7BFF');
});

// ---- 2. no colour literal in the <style> blocks outside the variable definitions
// Allow-list: none. (The :root block and the two Simple-mode definition blocks (html.mm-simple,
// html.mm-simple.mm-light) are variable DEFINITIONS and are skipped, as the spec allows.)
const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(|(?<![\w-])(?:white|black|red|green|blue|yellow|orange|gray|grey)(?![\w-])/g;
function cssWithoutDefinitionBlocks() {
  let css = stripComments(allCss);
  for (const re of [/(^|\n)\s*:root\s*\{/, /(^|\n)\s*html\.mm-simple\s*\{/, /(^|\n)\s*html\.mm-simple\.mm-light\s*\{/]) {
    const b = blockAt(css, re);
    css = css.slice(0, b.start) + css.slice(b.end);
  }
  return css;
}
test('index.html <style> blocks hold no hex/rgb/rgba/hsl/named colour literal outside variable definitions', () => {
  // Allow-list: `mask-image: linear-gradient(.., #000 ..)` (Simple thinking box). A mask reads only the ALPHA of its
  // colour, so black is not a theme colour there and must not follow a look.
  const css = cssWithoutDefinitionBlocks().replace(/(-webkit-)?mask-image:[^;}]*/g, '').replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""'); // ignore string contents (content:'...')
  const hits = [...css.matchAll(COLOUR)].map((m) => css.slice(Math.max(0, m.index - 30), m.index + 30).replace(/\s+/g, ' '));
  assert.deepStrictEqual(hits, []);
});

test('index.html inline style attributes hold no colour literal', () => {
  const body = html.slice(html.lastIndexOf('</style>'));
  const hits = [];
  for (const m of body.matchAll(/style="([^"]*)"/g)) if (COLOUR.test(m[1])) hits.push(m[1].slice(0, 80)); else COLOUR.lastIndex = 0;
  COLOUR.lastIndex = 0;
  assert.deepStrictEqual(hits, []);
});

test('the Simple-mode definition blocks keep their own values (not turned into variables of themselves)', () => {
  const s = stripComments(allCss);
  const dark = blockAt(s, /(^|\n)\s*html\.mm-simple\s*\{/).body;
  assert.match(dark, /--accent:\s*#8b6fd6/);
  assert.match(dark, /--sm-user-bg:\s*#5b46a8/);
  assert.match(dark, /--font-ui:\s*var\(--font-simple\)/);
  const light = blockAt(s, /(^|\n)\s*html\.mm-simple\.mm-light\s*\{/).body;
  assert.match(light, /--bg-dark:\s*#ffffff/);
});

test('font stacks are variables in the CSS', () => {
  const css = stripComments(allCss);
  const literal = [...css.matchAll(/font-family:\s*([^;}\n]+)/g)].map((m) => m[1].trim())
    .filter((v) => !/^(var\(|inherit$)/.test(v));
  // plain `monospace` (one rule, no stack) is the only generic family left
  assert.deepStrictEqual([...new Set(literal)].filter((v) => v !== 'monospace' && !/^-apple-system.*Arial, sans-serif$/.test(v)), []);
});

// ---- 3. app.js: inline colours
// Allow-list of literals deliberately kept in app.js (each: reason).
const APP_ALLOWED = [
  { marker: "dark: '#000', light: '#fff'", why: 'QR code SVG: needs real black on white to stay scannable in every look' },
  { marker: 'const AGENT_COLORS = [', why: 'per-agent avatar/label palette chosen by code (identity colours)' },
  { marker: "if (agentSlug === chat.coordinator) return '#a78bfa'", why: 'coordinator identity colour from the same palette (index 4)' },
  { marker: '// Coordinator gets purple (index 4 = #a78bfa)', why: 'comment about the line above' },
  { marker: 'const VISUAL_PALETTE = [', why: 'chart series colours' },
  { marker: "const VISUAL_TEXT = '", why: 'chart text colour: the chart runs in a sandboxed iframe that cannot see page variables' },
  { marker: "const VISUAL_GRID = '", why: 'chart grid colour (same iframe)' },
  { marker: "const VISUAL_SURFACE = '", why: 'chart surface colour (same iframe)' },
  { marker: '<style>html{background:${VISUAL_SURFACE};color:#ffffff', why: 'the chart iframe document: separate page, no access to the look variables' },
  { marker: '&#9881;', why: 'HTML entity (gear), not a colour' },
];
// Shared helper blocks: other tests pin them byte-identical between app.js, mobile.js and lib/ (ui-dialog.js,
// ui-subscriptions.test.js), so their literals stay. They are skipped whole.
const SHARED_BLOCKS = [
  { begin: '// ── dialog helpers (begin) ──', end: '// ── dialog helpers (end) ──', why: 'byte-identical in lib/ui-dialog.js, app.js and mobile.js (test/ui-dialog.test.js); its CSS keeps var(--x, #fallback) pairs that never apply because those variables exist on every page' },
  { begin: '// ── subscriptions helpers (begin) ──', end: '// ── subscriptions helpers (end) ──', why: 'the same code in app.js and mobile.js (test/ui-subscriptions.test.js): the meter colours subsColor() returns' },
];
const HEX = /(?<![&\w])#[0-9a-fA-F]{3,8}\b(?![0-9a-fA-F])/g;
test('app.js has no inline colour literals except the allow-list', () => {
  const lines = app.split('\n');
  const leftovers = [];
  let allowedHexCount = 0;
  const skipLines = new Set();
  for (const b of SHARED_BLOCKS) {
    const from = app.indexOf(b.begin), to = app.indexOf(b.end);
    assert.ok(from > 0 && to > from, b.begin + ' present');
    const first = app.slice(0, from).split('\n').length - 1, last = app.slice(0, to).split('\n').length - 1;
    for (let k = first; k <= last; k++) skipLines.add(k);
  }
  lines.forEach((l, i) => {
    if (skipLines.has(i)) { allowedHexCount += (l.match(HEX) || []).length; return; }
    const hexes = l.match(HEX) || [];
    const rgb = l.match(/\brgba?\s*\(/g) || [];
    if (!hexes.length && !rgb.length) return;
    if (APP_ALLOWED.some((a) => l.includes(a.marker))) { allowedHexCount += hexes.length; return; }
    leftovers.push((i + 1) + ': ' + l.trim().slice(0, 100));
  });
  assert.deepStrictEqual(leftovers, []);
  assert.ok(allowedHexCount <= 40, 'the allow-list grew: ' + allowedHexCount);
});

test('app.js does not set a named colour (white/black) on an element', () => {
  assert.doesNotMatch(app, /style\.color\s*=\s*'(black|white)'/);
  assert.doesNotMatch(app, /color:\s*(black|white)[;"'`]/);
  assert.doesNotMatch(app, /\? 'white' :/);
});

// ---- 4. every :root colour variable used by app.js has the literal it replaced (spot checks)
test('values of variables used by app.js equal the literals they replaced', () => {
  const want = {
    '--on-color-text': '#ffffff', '--on-light-text': '#000000', '--halt-banner-bg': '#b71c1c', '--job-status-run': '#2e7d32',
    '--job-status-bad': '#c62828', '--banner-setup-bg': '#7a3b12', '--banner-critical-bg': '#7a1212', '--banner-warn-bg': '#8a6a00',
    '--usage-critical': '#f85149', '--usage-critical-tint': '#f8514922', '--orch-banner-title': '#e94560', '--interject-bg': 'rgba(128,128,128,0.12)',
    '--notice-bar-bg': '#14171f', '--notice-bar-link': '#5a93ff',
  };
  for (const [k, v] of Object.entries(want)) assert.strictEqual(rootDefs.get(k), v, k);
});
