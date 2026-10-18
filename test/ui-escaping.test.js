'use strict';
// XSS hardening of the pages (2026-10-16 security review): autolinker and markdown link/image rendering,
// no inline handlers carrying agent data, agent fields escaped in the sidebar and headers, server-side
// validation of display/icon/blurb, tiger-team.html vendored and fail-closed, svg blocks without CSS,
// the sealed html document built by the hub, off-site images rendered as links.
// Source-string pins in the ui-*.test.js pattern, plus behaviour tests of the pure helpers (lib/ui-safe-text.js
// is the same code the pages carry; the first test proves the copies are identical).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js');
const mobile = read('mobile.js');
const index = read('index.html');
const mobileHtml = read('mobile.html');
const tiger = read('tiger-team.html');
const sw = read('sw.js');
const libSrc = read('lib/ui-safe-text.js');
const safe = require('../lib/ui-safe-text');
const agents = require('../lib/agents');

const BEGIN = '// ── safe-text helpers (begin) ──';
const END = '// ── safe-text helpers (end) ──';
function helperBlock(src, indent) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  assert.ok(a > 0 && b > a, 'helper markers present');
  const body = src.slice(a + BEGIN.length, b);
  return body.split('\n').map(l => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n').trim();
}

test('the four safe-text helpers are byte-identical in lib/ui-safe-text.js, app.js and mobile.js', () => {
  const lib = helperBlock(libSrc, '');
  assert.strictEqual(helperBlock(app, '    '), lib, 'app.js copy differs from lib/ui-safe-text.js');
  assert.strictEqual(helperBlock(mobile, ''), lib, 'mobile.js copy differs from lib/ui-safe-text.js');
  for (const fn of ['escapeHtml', 'autolinkEscaped', 'safeLinkUrl', 'imageSrcKind']) assert.ok(lib.includes(`function ${fn}(`), fn);
});

test('escapeHtml covers all five characters', () => {
  assert.strictEqual(safe.escapeHtml(`<a href="x" onclick='y'>&`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
  assert.strictEqual(safe.escapeHtml(null), '');
});

test('autolinker: strict charset, a quote never reaches the href, the rest stays text', () => {
  const out = safe.autolinkEscaped(safe.escapeHtml('see https://example.com/a"onmouseover="alert(1) now'));
  assert.ok(out.includes('<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">https://example.com/a</a>&quot;onmouseover=&quot;alert(1) now'), out);
  assert.ok(!/onmouseover="/.test(out), 'no attribute injected');
  const amp = safe.autolinkEscaped(safe.escapeHtml('https://x.y/p?q=1&r=2 end'));
  assert.ok(amp.includes('href="https://x.y/p?q=1&amp;r=2"'), amp);
  assert.strictEqual(safe.autolinkEscaped('x="https://in.attr/"'), 'x="https://in.attr/"', 'a URL already inside an attribute is left alone');
  assert.ok(safe.autolinkEscaped(safe.escapeHtml('https://a.b/<script>')).includes('</a>&lt;script&gt;'));
  assert.strictEqual(safe.autolinkEscaped('https://'), 'https://', 'no host, no link');
});

test('markdown link targets: controls and whitespace stripped before the scheme check; only http(s), mailto, same-origin paths', () => {
  assert.strictEqual(safe.safeLinkUrl('java\u0000script:alert(1)'), null);
  assert.strictEqual(safe.safeLinkUrl(' \tJavaScript:alert(1)'), null);
  assert.strictEqual(safe.safeLinkUrl('data:text/html,<script>'), null);
  assert.strictEqual(safe.safeLinkUrl('vbscript:x'), null);
  assert.strictEqual(safe.safeLinkUrl('//evil.example/x'), null);
  assert.strictEqual(safe.safeLinkUrl('https://ok.example/p?a=1&amp;b=2'), 'https://ok.example/p?a=1&b=2');
  assert.strictEqual(safe.safeLinkUrl('mailto:a@b.c'), 'mailto:a@b.c');
  assert.strictEqual(safe.safeLinkUrl('/api/image/abc'), '/api/image/abc');
  assert.strictEqual(safe.safeLinkUrl('#section'), '#section');
  assert.strictEqual(safe.safeLinkUrl('docs/readme.md'), 'docs/readme.md');
});

test('image sources: same-origin, data: and blob: inline; any other host is external; unsafe is null', () => {
  const o = 'http://localhost:9966';
  assert.deepStrictEqual(safe.imageSrcKind('https://evil.example/p.png', o), { kind: 'external', url: 'https://evil.example/p.png' });
  assert.deepStrictEqual(safe.imageSrcKind('http://localhost:9966/api/image/abc', o), { kind: 'same', url: 'http://localhost:9966/api/image/abc' });
  assert.deepStrictEqual(safe.imageSrcKind('/api/image/abc', o), { kind: 'same', url: '/api/image/abc' });
  assert.deepStrictEqual(safe.imageSrcKind('data:image/png;base64,AAAA', o), { kind: 'data', url: 'data:image/png;base64,AAAA' });
  assert.strictEqual(safe.imageSrcKind('data:text/html,x', o), null);
  assert.strictEqual(safe.imageSrcKind('javascript:alert(1)', o), null);
  assert.strictEqual(safe.imageSrcKind('//evil.example/p.png', o), null);
});

test('both pages render links, bare URLs and images through the helpers', () => {
  for (const [name, src] of Object.entries({ 'app.js': app, 'mobile.js': mobile })) {
    assert.ok(!/https\?:\\\/\\\/\[\^\\s<&\]\+/.test(src), `${name}: old autolinker regex is gone`);
    assert.match(src, /autolinkEscaped\((?:formatted|out)/, `${name}: formatContent autolinks through the helper`);
    assert.match(src, /const u = safeLinkUrl\((?:url|l\.url)\)/, `${name}: markdown links go through safeLinkUrl`);
    assert.match(src, /function imageHtml\(src, alt/, `${name}: imageHtml`);
    assert.match(src, /im\.kind === 'external'/, `${name}: external images handled`);
    assert.match(src, /class="external-image"/, `${name}: external image renders as a link`);
    assert.ok(!src.includes("javascript\\s*:/i.test(src)"), `${name}: the old javascript: test is gone`);
  }
  assert.match(index, /\.image-gallery a\.external-image \{/);
  assert.match(mobileHtml, /\.msg\.assistant a\.external-image \{/);
});

test('no inline handler carries an agent- or user-supplied image URL; the click is delegated', () => {
  assert.ok(!app.includes("openImageModal('${"), 'no onclick="openImageModal(\'${...}\')" left in app.js');
  assert.match(app, /e\.target\.closest\('img\.generated-image'\)/, 'delegated listener');
  assert.match(app, /openImageModal\(img\.currentSrc \|\| img\.src\)/);
  assert.match(app, /function imageGalleryHtml\(images, inlineStyle\)/);
  assert.ok(!/onclick="openImageModal/.test(app));
});

test('sidebar, tabs, headers and pickers escape every agent field', () => {
  assert.match(app, /const displayName = hubEsc\(agent\.display \|\| capName\(agent\.name\)\);/);
  assert.match(app, /const subtitle = hubEsc\(agent\.specialty \|\| shortModel\);/);
  assert.match(app, /const tip = hubEsc\(agent\.blurb \|\|/);
  assert.match(app, /<span class="agent-icon">\$\{hubEsc\(agent\.icon \|\| '🤖'\)\}<\/span>/);
  assert.match(app, /data-agent="\$\{safeName\}" data-model="\$\{safeModel\}"/);
  assert.match(app, /const display = hubEsc\(a\.display \|\| capName\(a\.name\)\);\s*const icon = hubEsc\(a\.icon \|\| '🤖'\);/, 'agent picker');
  assert.match(app, /const display = hubEsc\(AGENTS\.find\(ag => ag\.name === a\.name\)\?\.display \|\| capName\(a\.name\)\);/, 'group builder');
  assert.match(app, /<span class="name">👥 \$\{hubEsc\(shortNames\)\}<\/span>/, 'group tab');
  assert.match(app, /<span class="agent-name-text">\$\{hubEsc\(chat\.display \|\| capName\(chat\.agent\)\)\}<\/span>/, 'chat header');
  assert.match(app, /const display = hubEsc\(agent\?\.display \|\| capName\(name\)\);/, 'orchestration chips');
  // mobile already uses textContent / esc() for these fields
  assert.match(mobile, /<span class="agent-icon">\$\{esc\(a\.icon \|\| '🤖'\)\}<\/span>/);
  assert.match(mobile, /\$\('chat-name'\)\.textContent = a\.display \|\| current/);
});

test('server side: display refuses markup, icon is one grapheme, blurb is stripped and capped at 200', () => {
  assert.deepStrictEqual(agents.validateDisplayName('<img src=x onerror=document.title=1>').ok, false);
  assert.deepStrictEqual(agents.validateDisplayName('Doc "the" Doctor').ok, false);
  assert.deepStrictEqual(agents.validateDisplayName(`tick\`s`).ok, false);
  assert.deepStrictEqual(agents.validateDisplayName('  Plain\u0007 Name  '), { ok: true, display: 'Plain Name' });
  assert.strictEqual(agents.validateDisplayName('x'.repeat(60)).display.length, 40);
  assert.deepStrictEqual(agents.validateIcon('🧑🏽‍💻'), { ok: true, icon: '🧑🏽‍💻' });
  assert.deepStrictEqual(agents.validateIcon('👨‍👩‍👧'), { ok: true, icon: '👨‍👩‍👧' });
  assert.strictEqual(agents.validateIcon('ab').ok, false);
  assert.strictEqual(agents.validateIcon('<b>').ok, false);
  assert.strictEqual(agents.validateIcon('🤖🤖').ok, false);
  assert.strictEqual(agents.validateIcon('👨‍👩‍👧‍👦').ok, false, 'over 8 UTF-16 units');
  assert.deepStrictEqual(agents.validateIcon(''), { ok: true, icon: '' });
  assert.strictEqual(agents.cleanText('<b>hi</b> & "x" `y` \u0000z', 200), 'bhi/b  x y z');
  assert.strictEqual(agents.cleanText('a'.repeat(300), 200).length, 200);
  const src = read('lib/agents.js');
  assert.match(src, /const v = validateDisplayName\(display\);\s*if \(!v\.ok\) return \{ success: false, error: v\.error \};/, 'setAgentDisplay validates');
  assert.match(src, /const v = validateIcon\(icon\);\s*if \(!v\.ok\) return \{ success: false, error: v\.error \};/, 'setAgentIcon validates');
  assert.match(src, /key === 'blurb'\) \{\s*const b = cleanText\(value, BLURB_MAX\);/, 'PATCH blurb is cleaned');
  assert.match(src, /blurb: typeof a\.blurb === 'string' \? a\.blurb\.slice\(0, BLURB_MAX\)/);
  // rename_me goes through setAgentDisplay, so it is covered.
  assert.match(read('lib/sdk-chat.js'), /async function handleRenameMe\(agentName, \{ display \}\) \{[\s\S]*?require\('\.\/agents'\)\.setAgentDisplay\(agentName, d\)/);
});

test('tiger-team.html: vendored pinned libraries, fail-closed markdown, no onclick re-inserted from saved transcripts', () => {
  assert.ok(!tiger.includes('cdn.jsdelivr.net'), 'no CDN script');
  assert.match(tiger, /<script src="\/vendor\/marked\.umd\.js"><\/script>\s*<script src="\/vendor\/purify\.min\.js"><\/script>/);
  assert.match(tiger, /if \(!purifyReady\(\)\) return esc\(text\)\.replace\(\/\\n\/g, '<br>'\);/, 'md() fails closed');
  assert.ok(!/ADD_ATTR: \[[^\]]*'onclick'/.test(tiger), 'no ADD_ATTR onclick');
  assert.match(tiger, /timeline\.textContent = rawTranscript;\s*\/\/ fail closed/);
  assert.match(tiger, /data-call-id="\$\{esc\(callId\)\}"/, 'toggle carries a data attribute');
  assert.match(tiger, /e\.target\.closest\('\.tool-call-toggle'\)/, 'delegated toggle listener');
  assert.ok(!tiger.includes("approveAdditionalRounds('${"), 'justification is not inside an inline handler');
  assert.match(tiger, /<p><strong>Justification:<\/strong> \$\{esc\(justification\)\}<\/p>/);
  assert.match(tiger, /<span class="agent-icon">\$\{esc\(a\.icon \|\| '🤖'\)\}<\/span>/);
  assert.match(tiger, /<div class="agent-name">\$\{esc\(a\.display \|\| slug\)\}<\/div>/);
  const marked = read('vendor/marked.umd.js');
  assert.match(marked.slice(0, 300), /marked v18\.1\.1/);
  assert.match(marked.slice(0, 300), /MIT License/);
  assert.ok(fs.statSync(path.join(__dirname, '..', 'vendor/LICENSE-marked.txt')).size > 500);
  assert.match(read('NOTICE'), /marked 18\.1\.1 \(MIT, vendor\/marked\.umd\.js/);
});

test('svg blocks carry no CSS; the sealed html document is built by the hub with the CSP first', () => {
  for (const [name, src] of Object.entries({ 'app.js': app, 'mobile.js': mobile })) {
    const fn = src.slice(src.indexOf('function sanitizeSvg(source)'), src.indexOf('async function renderSvgBlock'));
    assert.match(fn, /FORBID_TAGS: \['script', 'foreignObject', 'iframe', 'object', 'embed', 'audio', 'video', 'style', 'animate', 'set', 'animateMotion', 'animateTransform'\]/, `${name}: style and SMIL animation tags forbidden`);
    assert.match(fn, /FORBID_ATTR: \['style'\]/, `${name}: style attribute forbidden`);
    assert.match(fn, /if \(n\.tagName\.toLowerCase\(\) === 'style'\) \{ n\.remove\(\); continue; \}/, `${name}: second pass removes <style>`);
    assert.match(fn, /if \(name\.startsWith\('on'\) \|\| name === 'style'\) n\.removeAttribute\(a\.name\);/, `${name}: second pass removes style attributes`);
    assert.match(fn, /const externalUrl = \/url\\\(\\s\*\['"\]\?\\s\*\(\?!#\)\|@import\/i;/, `${name}: url( and @import`);
    assert.match(fn, /else if \(externalUrl\.test\(a\.value\)\) n\.removeAttribute\(a\.name\);/, `${name}: any attribute with an external url() goes`);
    const sealed = src.slice(src.indexOf('function sealedHtmlDocument(source)'), src.indexOf('async function renderHtmlBlock'));
    assert.match(sealed, /return '<!DOCTYPE html><html><head><meta charset="utf-8">'\s*\+ `<meta http-equiv="Content-Security-Policy" content="\$\{VISUAL_CSP\}">`/, `${name}: hub-built head, CSP first`);
    assert.match(sealed, /<\/head><body>\$\{String\(source \?\? ''\)\}<\/body><\/html>/, `${name}: author content in the body`);
    assert.ok(!/<head\[\^>\]\*>\/i\.exec/.test(sealed), `${name}: no search of the author's markup`);
  }
});

test('service worker cache bumped so phones pick up the new page', () => {
  assert.ok(sw.includes("const VERSION = 'hub-mobile-v44';"));
});
