'use strict';
// Visual blocks in the chat: ```svg ```mermaid ```chart ```html fences are drawn by both pages
// (app.js / index.html and mobile.js / mobile.html) with vendored libraries under vendor/.
// Source-string tests in the ui-*.test.js pattern: the pages are not executed here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const size = (f) => fs.statSync(path.join(__dirname, '..', f)).size;
const app = read('app.js');
const mobile = read('mobile.js');
const index = read('index.html');
const mobileHtml = read('mobile.html');
const sw = read('sw.js');
const pages = { 'app.js': app, 'mobile.js': mobile };

test('both pages detect the four fence types and emit a placeholder, never raw HTML', () => {
  for (const [name, src] of Object.entries(pages)) {
    assert.match(src, /const VISUAL_KINDS = \{ svg: 'svg', mermaid: 'mermaid', chart: 'chart', html: 'html' \}/, `${name}: kinds`);
    assert.match(src, /function visualKind\(lang\)/, `${name}: visualKind`);
    // The fence regex hands the language to visualKind; non-visual fences are left for the usual path.
    assert.match(src, /response\.replace\(\/```\(\\w\*\)\\n\(\[\\s\\S\]\*\?\)```\/g, \((?:match|m), lang, code\) => \{\s*const kind = visualKind\(lang\);\s*if \(!kind\) return (?:match|m);/, `${name}: fence tokenizer`);
    // The placeholder holds the escaped source inside <pre><code>, in a data-kind element.
    assert.match(src, /<div class="visual visual-\$\{kind\}" data-kind="\$\{kind\}"><pre class="visual-src"><code>\$\{escapedSource\}<\/code><\/pre><\/div>/, `${name}: placeholder`);
    assert.match(src, /visualPlaceholder\(kind, (?:esc\(code\)|code\.replace\(\/&\/g, '&amp;'\)\.replace\(\/<\/g, '&lt;'\)\.replace\(\/>\/g, '&gt;'\))\)/, `${name}: source escaped`);
    // Tokens are re-inserted with a function replacer so `$&` / `$'` in source cannot expand.
    assert.match(src, /__VIS_TOKEN_\$\{i\}__`, \(\) => /, `${name}: function replacer`);
    // Visual fences are held out before the image/link/table passes, so `[a](b)` or `![a](b)`
    // inside an svg/html block cannot be rewritten into the source.
    const fence = src.indexOf('const kind = visualKind(lang);');
    const images = src.indexOf('.replace(/!\\[([^\\]]*)\\]\\(([^)]+)\\)/g');
    assert.ok(fence > 0 && images > fence, `${name}: fences held out before image/link extraction`);
    // The regular fence path is unchanged for every other language.
    assert.match(src, /\.replace\(\/```\(\\w\*\)\\n\(\[\\s\\S\]\*\?\)```\/g, '<pre><code>\$2<\/code><\/pre>'\)/, `${name}: plain fences unchanged`);
  }
});

test('one shared post-render pass per page, idempotent, called after message paints', () => {
  for (const [name, src] of Object.entries(pages)) {
    assert.match(src, /function renderVisualBlocks\(root\)/, `${name}: renderVisualBlocks`);
    assert.match(src, /querySelectorAll\('\.visual\[data-kind\]:not\(\[data-rendered\]\)'\)/, `${name}: skips rendered`);
    assert.match(src, /el\.dataset\.rendered = '1'/, `${name}: marks rendered`);
    assert.match(src, /new MutationObserver\(/, `${name}: safety-net observer`);
    assert.match(src, /function loadScriptOnce\(src\)/, `${name}: lazy loader`);
    assert.match(src, /'\/vendor\/purify\.min\.js'/, `${name}: purify path`);
    assert.match(src, /'\/vendor\/mermaid\.min\.js'/, `${name}: mermaid path`);
    assert.match(src, /'\/vendor\/chart\.umd\.min\.js'/, `${name}: chart path`);
  }
  // Desktop: history/own-stream/hub-turn/reattach paints all go through these functions.
  for (const fn of ['function appendMessage(', 'function updateMessage(', 'function updateMessageWithTools(', 'function updateGroupMessage(', 'function appendGroupMessage(', 'function updateSynthesisMessage(', 'function appendSynthesisMessage(', 'function updateOrchContent(']) {
    const at = app.indexOf(fn);
    assert.ok(at > 0, `app.js: ${fn}`);
    const body = app.slice(at, at + 2200);
    assert.ok(body.includes('renderVisualBlocks('), `app.js: ${fn} calls renderVisualBlocks`);
  }
  // Mobile: bubbles (history), reply text (hub turn / re-attach), own stream paint, worker feed text.
  for (const fn of ['function addAssistantBubble(', 'function setReplyText(', 'async function readStream(']) {
    const at = mobile.indexOf(fn);
    assert.ok(at > 0, `mobile.js: ${fn}`);
    assert.ok(mobile.slice(at, at + 1400).includes('renderVisualBlocks('), `mobile.js: ${fn} calls renderVisualBlocks`);
  }
  assert.match(mobile, /if \(it\.open && it\.text\) renderVisualBlocks\(det\);/, 'mobile.js: worker feed text');
});

test('html blocks are a sealed iframe: sandbox exactly allow-scripts, no referrer, CSP meta injected', () => {
  const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;";
  for (const [name, src] of Object.entries(pages)) {
    assert.match(src, /f\.setAttribute\('sandbox', 'allow-scripts'\)/, `${name}: sandbox`);
    assert.ok(!/allow-same-origin|allow-forms|allow-popups|allow-top-navigation|allow-modals/.test(src), `${name}: no extra sandbox grants`);
    assert.match(src, /f\.setAttribute\('referrerpolicy', 'no-referrer'\)/, `${name}: referrerpolicy`);
    assert.ok(src.includes(`const VISUAL_CSP = "${csp}"`), `${name}: CSP string`);
    assert.match(src, /<meta http-equiv="Content-Security-Policy" content="\$\{VISUAL_CSP\}">/, `${name}: CSP meta`);
    assert.match(src, /f\.srcdoc = sealedHtmlDocument\(source\)/, `${name}: srcdoc`);
    assert.match(src, /data-act="expand"/, `${name}: expand toggle`);
    assert.match(src, /data-act="source"/, `${name}: source toggle`);
  }
  assert.match(index, /\.visual-html iframe\.visual-frame \{[^}]*height: 360px/, 'desktop frame height');
  assert.match(mobileHtml, /\.visual-html iframe\.visual-frame \{[^}]*height: 280px/, 'mobile frame height');
  assert.match(index, /\.visual-html\.expanded iframe\.visual-frame \{ height: 80vh; \}/);
  assert.match(mobileHtml, /\.visual-html\.expanded iframe\.visual-frame \{ height: 80vh; \}/);
});

test('mermaid: strict security level, dark theme, no auto start, parse errors fall back to source', () => {
  for (const [name, src] of Object.entries(pages)) {
    assert.match(src, /mermaid\.initialize\(\{ startOnLoad: false, securityLevel: 'strict', theme: 'dark', suppressErrorRendering: true \}\)/, `${name}: initialize`);
    assert.match(src, /throw new Error\('diagram did not parse'/, `${name}: parse failure`);
    assert.match(src, /function visualFail\(el, note\)/, `${name}: failure keeps source`);
    assert.match(src, /visualFail\(el, `\$\{kind\}: \$\{err && err\.message \? err\.message : 'could not render'\}`\)/, `${name}: note`);
  }
  assert.match(index, /\.visual \.visual-note \{[^}]*color: var\(--error\)/);
  assert.match(mobileHtml, /\.visual \.visual-note \{[^}]*color: var\(--error\)/);
});

test('chart: config comes from JSON.parse only, dark palette defaults, fixed heights', () => {
  for (const [name, src] of Object.entries(pages)) {
    assert.match(src, /try \{ cfg = JSON\.parse\(source\); \} catch \{ throw new Error\('config is not valid JSON'\); \}/, `${name}: JSON.parse`);
    assert.ok(!/new Function\(|\beval\(/.test(src.slice(src.indexOf('function chartConfig'), src.indexOf('async function renderChartBlock'))), `${name}: no eval in chart config`);
    assert.match(src, /const VISUAL_PALETTE = \['#3987e5', '#d95926', '#199e70', '#8b6fd6', '#c9a227', '#d4588b'\]/, `${name}: palette`);
    assert.match(src, /o\.responsive = true;\s*o\.maintainAspectRatio = false;/, `${name}: responsive`);
    assert.match(src, /legend\.display = sliced\(cfg\.type\) \|\| cfg\.data\.datasets\.length > 1/, `${name}: legend rule`);
    assert.match(src, /beginAtZero === undefined\) o\.scales\[valueAxis\]\.beginAtZero = true/, `${name}: bars from zero`);
    assert.match(src, /new window\.Chart\(canvas, cfg\)/, `${name}: Chart.js`);
  }
  assert.match(index, /\.visual-chart \.visual-body \{ height: 280px; \}/);
  assert.match(mobileHtml, /\.visual-chart \.visual-body \{ height: 220px; \}/);
});

test('svg: DOMPurify svg profile plus a second pass forbids script, foreignObject, on*, javascript: and external refs', () => {
  for (const [name, src] of Object.entries(pages)) {
    const fn = src.slice(src.indexOf('function sanitizeSvg(source)'), src.indexOf('async function renderSvgBlock'));
    assert.ok(fn.length > 200, `${name}: sanitizeSvg`);
    assert.match(fn, /USE_PROFILES: \{ svg: true, svgFilters: true \}/, `${name}: svg profile`);
    assert.match(fn, /FORBID_TAGS: \['script', 'foreignObject', 'iframe', 'object', 'embed'/, `${name}: forbidden tags`);
    // ALLOWED_URI_REGEXP is deliberately absent: DOMPurify applies it to every attribute value (it emptied
    // width/height/viewBox); the fragment-or-data:image rule for href/xlink:href/src is the second pass below.
    assert.ok(!fn.includes('ALLOWED_URI_REGEXP:'), `${name}: no ALLOWED_URI_REGEXP option`);
    assert.match(fn, /\(name === 'href' \|\| name === 'xlink:href' \|\| name === 'src'\) && !\/\^\\s\*\(#\|data:image\\\/\)\/i\.test\(a\.value\)\) n\.removeAttribute\(a\.name\)/, `${name}: fragment or data:image only`);
    assert.match(fn, /if \(name\.startsWith\('on'\) \|\| name === 'style'\) n\.removeAttribute\(a\.name\)/, `${name}: on* and style attributes`);
    assert.match(fn, /\/javascript:\/i\.test\(a\.value\)\) n\.removeAttribute/, `${name}: javascript:`);
    assert.match(fn, /name === 'xlink:href'/, `${name}: xlink:href`);
    assert.match(fn, /createElement\('template'\)/, `${name}: inert parse`);
    assert.match(fn, /return svg\.outerHTML/, `${name}: only the svg element is kept`);
  }
  assert.match(index, /\.visual-svg \.visual-body svg, \.visual-mermaid \.visual-body svg \{ max-width: 100%; height: auto;/);
  assert.match(mobileHtml, /\.visual-svg \.visual-body svg, \.visual-mermaid \.visual-body svg \{ max-width: 100%; height: auto;/);
});

test('vendored libraries exist with plausible sizes and license headers', () => {
  const purify = read('vendor/purify.min.js');
  assert.ok(size('vendor/purify.min.js') > 15000 && size('vendor/purify.min.js') < 200000, 'purify size');
  assert.match(purify.slice(0, 400), /DOMPurify 3\.\d+\.\d+/);
  assert.match(purify.slice(0, 400), /Apache license 2\.0 and Mozilla Public License 2\.0/);
  const chart = read('vendor/chart.umd.min.js');
  assert.ok(size('vendor/chart.umd.min.js') > 100000 && size('vendor/chart.umd.min.js') < 1000000, 'chart size');
  assert.match(chart.slice(0, 400), /Chart\.js v4\.\d+\.\d+/);
  assert.match(chart.slice(0, 400), /MIT License/);
  const mermaid = fs.openSync(path.join(__dirname, '..', 'vendor/mermaid.min.js'), 'r');
  const head = Buffer.alloc(400); fs.readSync(mermaid, head, 0, 400, 0); fs.closeSync(mermaid);
  assert.ok(size('vendor/mermaid.min.js') > 1000000 && size('vendor/mermaid.min.js') < 20000000, 'mermaid size');
  assert.match(head.toString('utf8'), /mermaid v12\.\d+\.\d+/);
  assert.match(head.toString('utf8'), /MIT License/);
  for (const f of ['vendor/LICENSE-dompurify.txt', 'vendor/LICENSE-mermaid.txt', 'vendor/LICENSE-chart.js.txt']) assert.ok(size(f) > 500, f);
});

test('service worker: v21, vendor scripts cached on first use (network-first), not pre-cached at install', () => {
  assert.ok(sw.includes("const VERSION = 'hub-mobile-v46';"));
  assert.match(sw, /const VENDOR = \['\/vendor\/purify\.min\.js', '\/vendor\/mermaid\.min\.js', '\/vendor\/chart\.umd\.min\.js'\]/);
  assert.match(sw, /const RUNTIME = \[\.\.\.SHELL, '\/mobile', \.\.\.VENDOR\]/);
  assert.match(sw, /const SHELL = \['\/mobile\.html', '\/mobile\.js'\];/, 'install list unchanged');
  assert.match(sw, /caches\.open\(VERSION\)\.then\(c => c\.addAll\(SHELL\)\)/);
});
