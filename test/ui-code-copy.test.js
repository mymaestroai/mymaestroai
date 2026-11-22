'use strict';
// A copy button on every code box in a chat message (lib/ui-code-copy.js; app.js and mobile.js formatContent).
// Both renderers hold closed non-visual fences out in their first pass (C tokens) and build the box from the raw text,
// so the copied text is the source byte for byte. The renderer tests run each page's real formatContent in a Node vm
// (the function and its helpers cut out of the page source).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const appSrc = read('app.js');
const mobSrc = read('mobile.js');
const CC = require(path.join(ROOT, 'lib', 'ui-code-copy.js'));

// Cut `function name(...) {...}` out of a page: from its start to the first following line that is just the closing
// brace at the same indent and parses on its own.
function extractFn(src, name) {
  const m = new RegExp(`^( *)(?:async )?function ${name}\\(`, 'm').exec(src);
  assert.ok(m, `function ${name} found`);
  const indent = m[1];
  const close = '\n' + indent + '}\n';
  let from = m.index;
  let end = src.indexOf(close, from);
  while (end >= 0) {
    const text = src.slice(from, end + close.length - 1);
    try { new vm.Script(text); return text; } catch { /* a nested brace line: take the next one */ }
    end = src.indexOf(close, end + 1);
  }
  throw new Error(`could not cut ${name}`);
}

function renderer(src, withCodeCopy = true) {
  const names = ['parseThinking', 'visualPlaceholder', 'escapeHtml', 'autolinkEscaped', 'safeLinkUrl', 'imageSrcKind', 'imageHtml', 'visualKind', 'formatContent'];
  const parts = ["const VISUAL_KINDS = { svg: 'svg', mermaid: 'mermaid', chart: 'chart', html: 'html' };"];
  for (const n of names) {
    // visualKind is one line in both pages
    if (n === 'visualKind') { parts.push("function visualKind(lang) { return VISUAL_KINDS[String(lang || '').toLowerCase()] || null; }"); continue; }
    parts.push(extractFn(src, n));
  }
  const win = { crypto: require('node:crypto').webcrypto };
  if (withCodeCopy) win.CodeCopy = CC;
  const ctx = vm.createContext({
    window: win, crypto: win.crypto, btoa: (s) => Buffer.from(s, 'binary').toString('base64'), location: { origin: 'https://hub.test' },
    esc: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    console, document: { createElement: () => ({}) },
  });
  vm.runInContext(parts.join('\n') + '\nthis.formatContent = formatContent;', ctx);
  return ctx.formatContent;
}

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const stripTags = (s) => s.replace(/<[^>]*>/g, '');
const codeTexts = (html) => [...html.matchAll(/<div class="code-box">[\s\S]*?<pre><code>([\s\S]*?)<\/code><\/pre><\/div>/g)].map(m => decode(stripTags(m[1])));
const buttons = (html) => (html.match(/class="code-copy"/g) || []).length;

const MULTI = '<a href="x">&amp; "quoted" \'single\'</a>\nsee https://example.com/a?b=1&c=2 now\n**not bold** and `tick` and [l](http://x.y)\n$ echo "$HOME" && ls\n';
const MSG = 'Run this:\n```bash\n$ npm test\n```\nThen this:\n```\n' + MULTI + '```\nDone **bold**.';

const PAGES = { 'app.js': appSrc, 'mobile.js': mobSrc };

for (const [name, src] of Object.entries(PAGES)) {
  test(`${name}: one copy button per fence; the code text equals the source byte for byte`, () => {
    const html = renderer(src)(MSG);
    assert.strictEqual(buttons(html), 2, 'one button per fence');
    assert.deepStrictEqual(codeTexts(html), ['$ npm test\n', MULTI]);
    for (const m of html.matchAll(/<div class="code-box">([\s\S]*?)<\/div>/g)) {
      assert.ok(!/<br>|<strong>|<em>|<code>[^<]*<code>/.test(m[1]), 'no <br>/<strong> inside a code box: ' + m[1]);
    }
    assert.ok(html.includes('<strong>bold</strong>'), 'the text outside the boxes is formatted as before');
    assert.ok(html.includes('<br>'), 'and still gets its line breaks');
    assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2"/, 'a URL in a code box stays clickable');
    assert.ok(!/m[a-z0-9]{10,}C\d+~/.test(html), 'no code marker left over');
  });

  test(`${name}: no button for chart, mermaid, svg, html fences or inline code`, () => {
    const f = renderer(src);
    for (const k of ['chart', 'mermaid', 'svg', 'html']) {
      const html = f('```' + k + '\n<b>x</b>\n```');
      assert.strictEqual(buttons(html), 0, k);
      assert.ok(html.includes('visual-' + k), k + ' is still a visual');
    }
    assert.strictEqual(buttons(f('use `npm test` now')), 0);
  });

  test(`${name}: re-rendering gives the same single button; an unclosed fence gives none`, () => {
    const f = renderer(src);
    const a = f('```bash\n$ ls\n```');
    const b = f('```bash\n$ ls\n```');
    assert.strictEqual(buttons(a), 1);
    assert.strictEqual(buttons(b), 1);
    assert.deepStrictEqual(codeTexts(a), codeTexts(b));
    assert.strictEqual(buttons(f('```bash\n$ ls -l')), 0, 'unclosed: no box yet');
    assert.strictEqual(buttons(f('```bash\n$ ls -l\n``')), 0);
  });

  test(`${name}: $-sequences in code stay literal, and without the helper the plain <pre><code> of before is built`, () => {
    const code = "echo '$&' \"$1\" $$ $`\n";
    const html = renderer(src)('```sh\n' + code + '```');
    assert.deepStrictEqual(codeTexts(html), [code]);
    const plain = renderer(src, false)('```sh\n$ ls\n```');
    assert.ok(plain.includes('<pre><code>$ ls\n</code></pre>'), plain);
    assert.strictEqual(buttons(plain), 0);
  });
}

test('lib/ui-code-copy.js blockHtml: a real button with Copy label and no text node', () => {
  const html = CC.blockHtml('a &lt; b');
  assert.match(html, /^<div class="code-box"><button type="button" class="code-copy" aria-label="Copy" title="Copy">/);
  assert.ok(html.endsWith('<pre><code>a &lt; b</code></pre></div>'));
  const btn = html.match(/<button[\s\S]*?<\/button>/)[0];
  assert.strictEqual(btn.replace(/<[^>]*>/g, '').trim(), '', 'no text inside the button');
  assert.ok(!/>[^<\s][^<]*</.test(btn.replace(/^<button[^>]*>/, '')), 'no text nodes between tags');
  assert.match(btn, /aria-hidden="true"/);
  assert.match(btn, /focusable="false"/);
});

// A tiny DOM for the click handler.
function fakeDom(codeText) {
  const mkEl = (tag) => {
    const el = {
      tag, children: [], classes: new Set(), attrs: {}, style: {}, title: '', textContent: '', parentNode: null, isConnected: true,
      classList: { add: (...c) => c.forEach(x => el.classes.add(x)), remove: (...c) => c.forEach(x => el.classes.delete(x)), contains: (c) => el.classes.has(c) },
      setAttribute(k, v) { el.attrs[k] = String(v); }, getAttribute(k) { return el.attrs[k]; },
      appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
      removeChild(c) { el.children = el.children.filter(x => x !== c); c.parentNode = null; },
      select() {},
    };
    Object.defineProperty(el, 'className', { get: () => [...el.classes].join(' '), set: (v) => { el.classes = new Set(String(v).split(/\s+/).filter(Boolean)); } });
    return el;
  };
  const body = mkEl('body');
  const code = mkEl('code'); code.textContent = codeText;
  const box = mkEl('div');
  const btn = mkEl('button'); btn.classes.add('code-copy'); btn.attrs['aria-label'] = 'Copy'; btn.title = 'Copy';
  btn.closest = (sel) => (sel === '.code-copy' ? btn : sel === '.code-box' ? box : null);
  box.querySelector = (sel) => (sel === 'pre code' ? code : null);
  const doc = { body, createElement: mkEl, execCommand: () => false, querySelector: () => null };
  body.querySelector = () => null;
  return { doc, btn, code, box, body };
}
function fakeTimers() {
  const q = []; let id = 0;
  return { setTimeout: (f, ms) => { q.push({ id: ++id, f, ms }); return id; }, clearTimeout: (i) => { const k = q.findIndex(x => x.id === i); if (k >= 0) q.splice(k, 1); }, q,
    fire: () => { const t = q.shift(); if (t) t.f(); return t; } };
}
function fakeEvent(btn) {
  const ev = { target: { closest: (sel) => (sel === '.code-copy' ? btn : null) }, prevented: false, stopped: false, preventDefault() { ev.prevented = true; }, stopPropagation() { ev.stopped = true; } };
  return ev;
}

test('click handler: copies exactly the code text, says Copied, returns to Copy after 1500 ms, stops the click', async () => {
  const d = fakeDom('$ npm test\nline two <&>\n');
  const T = fakeTimers();
  let copied = null;
  const h = CC.makeClickHandler({ document: d.doc, copy: async (t) => { copied = t; return true; }, setTimeout: T.setTimeout, clearTimeout: T.clearTimeout });
  const ev = fakeEvent(d.btn);
  await h(ev);
  assert.strictEqual(copied, '$ npm test\nline two <&>\n');
  assert.ok(ev.prevented, 'preventDefault');
  assert.ok(!ev.stopped, 'stopPropagation is NOT called (other document listeners close menus on outside clicks)');
  assert.ok(d.btn.classes.has('copied'));
  assert.strictEqual(d.btn.attrs['aria-label'], 'Copied');
  assert.strictEqual(d.btn.title, 'Copied');
  assert.ok(T.q.some(x => x.ms === 1500), 'the 1500 ms reset timer');
  assert.strictEqual(d.body.children.filter(c => c.className.includes('code-copy-live')).length, 1, 'one live region');
  T.fire();   // the 60 ms live-region timer
  assert.strictEqual(d.body.children[0].textContent, 'Copied');
  T.fire();   // the reset timer
  assert.ok(!d.btn.classes.has('copied'));
  assert.strictEqual(d.btn.attrs['aria-label'], 'Copy');
  assert.strictEqual(d.btn.title, 'Copy');
  // a repeated click restarts the timers; still one live region
  await h(fakeEvent(d.btn)); await h(fakeEvent(d.btn));
  assert.strictEqual(T.q.length, 2, 'the earlier timers were cleared (one live, one reset)');
  assert.strictEqual(d.body.children.filter(c => c.className.includes('code-copy-live')).length, 1);
});

test('click handler reads the text at click time (a streamed reply copies what is there)', async () => {
  const d = fakeDom('first');
  const got = [];
  const h = CC.makeClickHandler({ document: d.doc, copy: async (t) => { got.push(t); return true; }, setTimeout: () => 1, clearTimeout() {} });
  await h(fakeEvent(d.btn)); d.code.textContent = 'first and more'; await h(fakeEvent(d.btn));
  assert.deepStrictEqual(got, ['first', 'first and more']);
});

test('click handler: both methods failing shows Could not copy for 2000 ms; clicks elsewhere are ignored', async () => {
  const d = fakeDom('x');
  const T = fakeTimers();
  const h = CC.makeClickHandler({ document: d.doc, copy: async () => false, setTimeout: T.setTimeout, clearTimeout: T.clearTimeout });
  await h(fakeEvent(d.btn));
  assert.ok(d.btn.classes.has('copy-failed'));
  assert.strictEqual(d.btn.attrs['aria-label'], 'Could not copy');
  assert.ok(T.q.some(x => x.ms === 2000));
  T.fire(); T.fire();
  assert.strictEqual(d.btn.attrs['aria-label'], 'Copy');
  const other = { target: { closest: () => null }, preventDefault() { throw new Error('no'); }, stopPropagation() { throw new Error('no'); } };
  assert.strictEqual(h(other), undefined);
});

test('copy(): clipboard API first; the textarea method when it is missing, rejects, or the page is not secure; false when both fail', async () => {
  const doc = (ok, log) => {
    const ta = { style: {}, setAttribute(k, v) { log.attrs[k] = v; }, select() { log.selected = true; }, parentNode: null };
    return { body: { appendChild(c) { c.parentNode = this; log.added = c; }, removeChild(c) { log.removed = c; c.parentNode = null; } }, createElement: () => ta, execCommand: (c) => { log.cmd = c; return ok; }, querySelector: () => null };
  };
  let l = { attrs: {} };
  let written = null;
  assert.strictEqual(await CC.copy('a\nb', { navigator: { clipboard: { writeText: async (t) => { written = t; } } }, document: doc(true, l), isSecureContext: true }), true);
  assert.strictEqual(written, 'a\nb'); assert.strictEqual(l.cmd, undefined, 'textarea not used');
  l = { attrs: {} };
  assert.strictEqual(await CC.copy('t1', { navigator: {}, document: doc(true, l), isSecureContext: true }), true);
  assert.strictEqual(l.cmd, 'copy'); assert.strictEqual(l.added.value, 't1'); assert.strictEqual(l.attrs.readonly, ''); assert.strictEqual(l.added.style.position, 'fixed'); assert.ok(l.selected && l.removed, 'selected and removed');
  l = { attrs: {} };
  assert.strictEqual(await CC.copy('t2', { navigator: { clipboard: { writeText: () => Promise.reject(new Error('denied')) } }, document: doc(true, l), isSecureContext: true }), true);
  assert.strictEqual(l.cmd, 'copy');
  l = { attrs: {} };
  assert.strictEqual(await CC.copy('t3', { navigator: { clipboard: { writeText: async () => { throw new Error('no'); } } }, document: doc(true, l), isSecureContext: false }), true, 'insecure context: textarea');
  assert.strictEqual(l.cmd, 'copy');
  assert.strictEqual(await CC.copy('t4', { navigator: {}, document: doc(false, { attrs: {} }), isSecureContext: true }), false);
  assert.strictEqual(await CC.copy('t5', { navigator: null, document: null }), false, 'never throws');
});

test('whole-message copy is unchanged: still prefers rawMessageText; the button adds no text', () => {
  const app = appSrc;
  assert.match(app, /const text = rawMessageText\.get\(el\) \?\? el\.innerText;/);
  assert.match(mobSrc, /rawText\.get\(/);
  const html = CC.blockHtml('x');
  assert.strictEqual(html.replace(/<[^>]*>/g, ''), 'x', 'the whole box has the code as its only text');
  // the file-card / own-text scans drop the button
  assert.match(app, /\.msg-copy, \.code-copy, \.msg-speak, \.msg-time, \.live-activity/);
  assert.match(app, /\.inline-thinking, \.msg-copy, \.code-copy, \.msg-speak'\)/);
  assert.match(mobSrc, /\.reattach, \.copy, \.code-copy, \.note/);
});

test('pages: script served, loaded before app.js / mobile.js; CSS present with print rule', () => {
  const sf = read('lib/static-files.js');
  assert.match(sf, /\['ui-code-copy\.js', 'lib\/ui-code-copy\.js'\]/);
  for (const [page, js] of [['index.html', 'app.js'], ['mobile.html', 'mobile.js']]) {
    const h = read(page);
    const a = h.indexOf('<script src="/ui-code-copy.js"></script>');
    assert.ok(a > 0 && a < h.indexOf(`<script src="${js}"></script>`), `${page}: loaded before ${js}`);
    assert.match(h, /\.code-box \{ position: relative/);
    assert.match(h, /\.code-copy\.copied \.cc-ico-copy \{ display: none; \}/);
    assert.match(h, /@media print \{ \.code-copy/);
    assert.match(h, /\.code-copy-live \{[^}]*clip: rect/);
  }
  assert.match(read('index.html'), /\.code-box:hover > \.code-copy, \.code-box:focus-within > \.code-copy, \.code-copy:focus-visible \{ opacity/);
  assert.match(read('index.html'), /@media \(hover: none\) \{ \.code-copy/);
});

test('worker output <pre> on the phone is wrapped; wrap() is idempotent', () => {
  assert.match(mobSrc, /window\.CodeCopy\.wrap\(pre\)/);
  const mk = () => {
    const parent = { children: [], querySelector: (s) => (s === ':scope > .code-copy' ? parent.children.find(c => c.cls === 'code-copy') || null : null),
      insertBefore(n, ref) { parent.children.splice(parent.children.indexOf(ref), 0, n); n.parentNode = parent; } };
    const pre = { parentNode: parent, closest: () => null };
    parent.children.push(pre);
    const doc = { createElement: () => { const e = { children: [], cls: '', parentNode: null, appendChild(c) { if (c.parentNode) c.parentNode.children = c.parentNode.children.filter(x => x !== c); c.parentNode = e; e.children.push(c); }, set className(v) { e.cls = v; }, set innerHTML(v) { e.firstChild = { cls: 'code-copy' }; } }; return e; } };
    return { parent, pre, doc };
  };
  const t = mk();
  CC.wrap(t.pre, t.doc);
  assert.strictEqual(t.parent.children.length, 1);
  assert.strictEqual(t.parent.children[0].cls, 'code-box');
  assert.strictEqual(t.pre.parentNode, t.parent.children[0]);
  const again = { ...t.pre, closest: (s) => (s === '.code-box' ? {} : null) };
  const before = JSON.stringify(t.parent.children.length);
  CC.wrap(again, t.doc);
  assert.strictEqual(JSON.stringify(t.parent.children.length), before, 'already in a box: untouched');
});


test('click handler: a box around a DOM-built <pre> with no <code> (phone worker output) copies the <pre> text', async () => {
  const d = fakeDom('unused');
  const pre = { textContent: 'worker output\n$ ls -la\n' };
  d.box.querySelector = (sel) => (sel === 'pre' ? pre : null);
  const T = fakeTimers();
  let copied = null;
  const onClick = CC.makeClickHandler({ document: d.doc, copy: (t) => { copied = t; return Promise.resolve(true); }, setTimeout: T.setTimeout, clearTimeout: T.clearTimeout });
  await onClick(fakeEvent(d.btn));
  assert.strictEqual(copied, 'worker output\n$ ls -la\n');
});

test('the page listener is installed once, in the capture phase (before click handlers on the message)', () => {
  const src = read('lib/ui-code-copy.js');
  assert.match(src, /if \(!window\.__codeCopyInstalled\) \{/);
  assert.match(src, /document\.addEventListener\('click', handler, true\)/);
  assert.match(src, /document\.addEventListener\('pointerdown', handler\.pointerDown, true\)/);
  assert.ok(!/stopPropagation\(\)/.test(src.replace(/\/\/.*$/gm, '')), 'the click is never stopped');
});

// ---- review fixes ----

for (const [name, src] of Object.entries(PAGES)) {
  test(`${name}: a URL directly before a fence gives one box, no marker text, no box inside an href`, () => {
    const html = renderer(src)('see https://x.y/```bash\nls\n```');
    assert.strictEqual(buttons(html), 1);
    assert.deepStrictEqual(codeTexts(html), ['ls\n']);
    assert.ok(!/m[a-z0-9]{8,}C\d+~/.test(html), 'no marker left: ' + html);
    for (const m of html.matchAll(/href="([^"]*)"/g)) assert.ok(!m[1].includes('<div') && !m[1].includes('code-box'), 'href clean: ' + m[1]);
    assert.match(html, /<a href="https:\/\/x\.y\/"/, 'the URL itself still links');
  });

  test(`${name}: a fence inside markdown link text or image alt text leaves no marker (and no HTML in an attribute)`, () => {
    const f = renderer(src);
    const a = f('[see ```sh\nls\n``` here](https://x.y/p)');
    assert.ok(!/m[a-z0-9]{8,}C\d+~/.test(a), 'link text: ' + a);
    assert.strictEqual(buttons(a), 1, 'link text: the box is there');
    const b = f('![pic ```sh\nls\n``` x](/api/image/abc)');
    assert.ok(!/m[a-z0-9]{8,}C\d+~/.test(b), 'alt text: ' + b);
    assert.strictEqual(buttons(b), 1, 'alt text: the box is there');
    for (const m of b.matchAll(/\balt="([^"]*)"/g)) assert.ok(!m[1].includes('<'), 'alt stays plain text');
    const c = f('[t](https://x.y/```sh\nls\n```)');
    assert.ok(!/m[a-z0-9]{8,}C\d+~/.test(c), 'link url: ' + c);
    for (const m of c.matchAll(/href="([^"]*)"/g)) assert.ok(!m[1].includes('<'), 'href plain');
  });

  test(`${name}: a CRLF line ending after the opening fence still gives a box with the body as its code`, () => {
    const html = renderer(src)('a\n```bash\r\n$ ls\r\n```\nb');
    assert.strictEqual(buttons(html), 1);
    assert.deepStrictEqual(codeTexts(html), ['$ ls\r\n']);
    const v = renderer(src)('```chart\r\n{"a":1}\r\n```');
    assert.ok(v.includes('visual-chart'), 'visual kinds still work with CRLF');
  });
}

// A fake page for the press / click-on-rebuilt-node tests.
function fakeHost(texts) {
  const host = { isConnected: true, boxes: [] };
  const mkBtn = (txt) => {
    const code = { textContent: txt };
    const box = { querySelector: (s) => (s === 'pre code' ? code : null) };
    const btn = { classes: new Set(['code-copy']), attrs: {}, title: '', ownerDocument: null, classList: { add() {}, remove() {}, contains: () => true }, setAttribute(k, v) { btn.attrs[k] = v; },
      closest: (s) => (s === '.code-copy' ? btn : s === '.code-box' ? box : s === '.message, .msg' ? host : null) };
    return btn;
  };
  host.rebuild = () => { host.buttons = texts.map(mkBtn); };
  host.querySelectorAll = (s) => (s === '.code-copy' ? host.buttons : []);
  host.rebuild();
  return host;
}
const evOn = (target) => ({ target, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } });

test('press on a code button, rebuilt before the click: the click on the host copies the box at the same index', async () => {
  const d = fakeDom('unused');
  const host = redrawHost(['one', 'two', 'three']);
  let clock = 1000;
  const got = [];
  const h = CC.makeClickHandler({ document: d.doc, now: () => clock, copy: async (t) => { got.push(t); return true; }, setTimeout: () => 1, clearTimeout() {} });
  h.pointerDown(evOn({ closest: (s) => (s === '.code-copy' ? host.buttons[1] : null) }));
  host.redraw();   // the streamed chunk replaced every node
  clock += 200;
  h.pointerUp(evOn({ closest: (s) => (s === '.code-copy' ? host.buttons[1] : null) }));   // released on the replacement at the same index
  const ev = evOn({ closest: () => null });   // the click lands on the rebuilt, now unrelated target
  await h(ev);
  assert.deepStrictEqual(got, ['two']);
  assert.ok(ev.prevented && !ev.stopped);
  assert.ok(host.buttons[1].classes.size >= 1);
  // the record is cleared after use
  assert.strictEqual(h(evOn({ closest: () => null })), undefined);
  assert.deepStrictEqual(got, ['two']);
});

test('an old press record (over 1500 ms) or a disconnected host is ignored; a keyboard click (no press) still works', async () => {
  const d = fakeDom('unused');
  const host = redrawHost(['one', 'two']);
  let clock = 0;
  const got = [];
  const h = CC.makeClickHandler({ document: d.doc, now: () => clock, copy: async (t) => { got.push(t); return true; }, setTimeout: () => 1, clearTimeout() {} });
  const on = (b) => evOn({ closest: (s) => (s === '.code-copy' ? b : null) });
  h.pointerDown(on(host.buttons[0]));
  host.redraw();
  h.pointerUp(on(host.buttons[0]));
  clock = 1600;
  assert.strictEqual(h(evOn({ closest: () => null })), undefined);
  clock = 0;
  h.pointerDown(on(host.buttons[0]));
  host.redraw();
  h.pointerUp(on(host.buttons[0]));
  host.isConnected = false;
  assert.strictEqual(h(evOn({ closest: () => null })), undefined);
  assert.deepStrictEqual(got, []);
  host.isConnected = true;
  await h(evOn({ closest: (s) => (s === '.code-copy' ? host.buttons[1] : null) }));   // keyboard: target is the button itself
  assert.deepStrictEqual(got, ['two']);
});

test('live region: emptied first, the text set 60 ms later (a repeated Copied is announced again); inside the open modal dialog', async () => {
  const d = fakeDom('x');
  const T = fakeTimers();
  const h = CC.makeClickHandler({ document: d.doc, copy: async () => true, setTimeout: T.setTimeout, clearTimeout: T.clearTimeout });
  await h(fakeEvent(d.btn));
  const live = d.body.children.find(c => c.className.includes('code-copy-live'));
  assert.strictEqual(live.textContent, '', 'cleared right away');
  const t60 = T.q.find(x => x.ms === 60);
  assert.ok(t60, 'a 60 ms timer');
  t60.f(); T.q.splice(T.q.indexOf(t60), 1);
  assert.strictEqual(live.textContent, 'Copied');
  await h(fakeEvent(d.btn));   // the same words again
  assert.strictEqual(live.textContent, '', 'cleared again before the new text');
  T.q.find(x => x.ms === 60).f();
  assert.strictEqual(live.textContent, 'Copied');
  // a modal dialog on the page: the region moves into it
  const dlg = d.doc.createElement('dialog');
  d.doc.querySelector = (s) => (s === 'dialog:modal' ? dlg : null);
  await h(fakeEvent(d.btn));
  assert.strictEqual(live.parentNode, dlg);
  d.doc.querySelector = () => { throw new Error('no :modal here'); };
  await h(fakeEvent(d.btn));   // a browser without :modal: falls back to the body, never throws
  assert.strictEqual(live.parentNode, d.body);
});

test('textarea fallback: the previous selection ranges and the focused element are put back', async () => {
  const log = { focus: [], added: [] };
  const prev = { focus: (o) => log.focus.push(o) };
  const ranges = ['r1', 'r2'];
  const sel = { rangeCount: 2, getRangeAt: (i) => ranges[i], removeAllRanges() { log.removed = true; }, addRange: (r) => log.added.push(r) };
  const ta = { style: {}, setAttribute() {}, select() {}, parentNode: null };
  const doc = { activeElement: prev, defaultView: { getSelection: () => sel }, querySelector: () => null,
    body: { appendChild(c) { c.parentNode = this; }, removeChild(c) { c.parentNode = null; } }, createElement: () => ta, execCommand: () => true };
  assert.strictEqual(await CC.copy('hi', { navigator: {}, document: doc, isSecureContext: true }), true);
  assert.ok(log.removed);
  assert.deepStrictEqual(log.added, ['r1', 'r2']);
  assert.deepStrictEqual(log.focus, [{ preventScroll: true }]);
  // broken selection / focus APIs never break the copy
  const bad = { ...doc, activeElement: { focus() { throw new Error('x'); } }, defaultView: { getSelection() { throw new Error('y'); } } };
  assert.strictEqual(await CC.copy('hi', { navigator: {}, document: bad, isSecureContext: true }), true);
});

// ---- review round 2 ----

for (const [name, src] of Object.entries(PAGES)) {
  test(`${name}: a fence inside a local image path gives one box and no marker (the path is not encoded before the marker is pulled out)`, () => {
    const html = renderer(src)('![photo](/img/```\nx\n```.png)');
    assert.strictEqual(buttons(html), 1, html);
    assert.deepStrictEqual(codeTexts(html), ['x\n']);
    assert.ok(!/m[a-z0-9]{8,}C\d+~/.test(html), 'no marker left: ' + html);
    assert.ok(html.indexOf('<img') < html.indexOf('code-box'), 'the box follows the image');
    for (const m of html.matchAll(/\b(?:src|alt|href)="([^"]*)"/g)) assert.ok(!m[1].includes('<') && !m[1].includes('code-box'), 'attribute plain: ' + m[1]);
  });

  test(`${name}: a link inside a table cell resolves; a fence in a cell's link URL gives one box and no marker`, () => {
    const f = renderer(src);
    const plain = f('| Name |\n|---|\n| [go](https://x.y/p) |\n');
    assert.match(plain, /<td><a href="https:\/\/x\.y\/p"[^>]*>go<\/a><\/td>/, plain);
    assert.ok(!/m[a-z0-9]{8,}[LIT]\d+~/.test(plain), 'no marker left: ' + plain);
    const withFence = f('| Name |\n|---|\n| [go](/img/```\nx\n```) |\n');
    assert.strictEqual(buttons(withFence), 1, withFence);
    assert.deepStrictEqual(codeTexts(withFence), ['x\n']);
    assert.ok(!/m[a-z0-9]{8,}[A-Z]\d+~/.test(withFence), 'no marker left: ' + withFence);
    const img = f('| Pic |\n|---|\n| ![a](/api/image/abc) |\n');
    assert.match(img, /<td>[\s\S]*<img/, 'an image in a cell resolves');
    assert.ok(!/m[a-z0-9]{8,}[A-Z]\d+~/.test(img), 'no marker left: ' + img);
  });
}

// A page with a message host whose code buttons can be redrawn (replaced), and a fake MutationObserver.
function redrawHost(texts) {
  const host = { isConnected: true, buttons: [] };
  const mkBtn = (txt) => {
    const code = { textContent: txt };
    const box = { querySelector: (s) => (s === 'pre code' ? code : null) };
    const btn = { isConnected: true, classes: new Set(['code-copy']), attrs: { 'aria-label': 'Copy' }, title: 'Copy',
      classList: { add: (...c) => c.forEach(x => btn.classes.add(x)), remove: (...c) => c.forEach(x => btn.classes.delete(x)), contains: (c) => btn.classes.has(c) },
      setAttribute(k, v) { btn.attrs[k] = String(v); },
      closest: (s) => (s === '.code-copy' ? btn : s === '.code-box' ? box : s === '.message, .msg' ? host : null) };
    return btn;
  };
  host.redraw = () => { for (const b of host.buttons) b.isConnected = false; host.buttons = texts.map(mkBtn); };
  host.querySelectorAll = (s) => (s === '.code-copy' ? host.buttons : []);
  host.buttons = texts.map(mkBtn);
  return host;
}
function fakeMO() {
  const list = [];
  class MO { constructor(cb) { this.cb = cb; this.disconnected = false; this.opts = null; list.push(this); } observe(t, o) { this.target = t; this.opts = o; } disconnect() { this.disconnected = true; } }
  return { MO, list };
}

test('a copied tick survives a redraw of the message: the observer paints it on the button at the same index until the timer ends it', async () => {
  const d = fakeDom('unused');
  const host = redrawHost(['one', 'two']);
  const T = fakeTimers();
  const { MO, list } = fakeMO();
  let clock = 0;
  const h = CC.makeClickHandler({ document: d.doc, now: () => clock, MutationObserver: MO, copy: async () => true, setTimeout: T.setTimeout, clearTimeout: T.clearTimeout });
  const old = host.buttons[1];
  await h(evOn({ closest: (s) => (s === '.code-copy' ? old : null) }));
  assert.ok(old.classes.has('copied'));
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].target, host);
  assert.deepStrictEqual(list[0].opts, { childList: true, subtree: true });
  host.redraw();   // a streamed chunk rebuilt the message
  const fresh = host.buttons[1];
  assert.ok(!fresh.classes.has('copied'));
  clock = 400;
  list[0].cb([]);
  assert.ok(fresh.classes.has('copied'), 'the new button shows the tick');
  assert.strictEqual(fresh.attrs['aria-label'], 'Copied');
  assert.strictEqual(fresh.title, 'Copied');
  assert.ok(!host.buttons[0].classes.has('copied'), 'only the clicked index');
  assert.strictEqual(list[0].disconnected, false);
  clock = 1500;
  T.fire();   // the 60 ms live-region timer
  T.fire();   // the 1500 ms reset
  assert.strictEqual(list[0].disconnected, true, 'observer disconnected when the state ends');
  assert.ok(!fresh.classes.has('copied'));
  assert.strictEqual(fresh.attrs['aria-label'], 'Copy');
  // a redraw that finishes after the state's time is not painted
  host.redraw(); list[0].cb([]);
  assert.ok(!host.buttons[1].classes.has('copied'));
  // the next click also disconnects the earlier watch
  clock = 5000;
  await h(evOn({ closest: (s) => (s === '.code-copy' ? host.buttons[0] : null) }));
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[1].disconnected, false);
  await h(evOn({ closest: (s) => (s === '.code-copy' ? host.buttons[1] : null) }));
  assert.strictEqual(list[1].disconnected, true, 'a new click ends the previous watch');
});

test('a redraw while the copy is still running: the tick lands on the new button at once; no MutationObserver is fine', async () => {
  const d = fakeDom('unused');
  const host = redrawHost(['one']);
  const { MO, list } = fakeMO();
  let resolve; const gate = new Promise(r => { resolve = r; });
  const h = CC.makeClickHandler({ document: d.doc, now: () => 0, MutationObserver: MO, copy: () => gate, setTimeout: () => 1, clearTimeout() {} });
  const p = h(evOn({ closest: (s) => (s === '.code-copy' ? host.buttons[0] : null) }));
  host.redraw();
  resolve(true); await p;
  assert.ok(host.buttons[0].classes.has('copied'));
  const host2 = redrawHost(['a']);
  const h2 = CC.makeClickHandler({ document: d.doc, now: () => 0, MutationObserver: null, copy: async () => true, setTimeout: () => 1, clearTimeout() {} });
  const saved = global.MutationObserver; delete global.MutationObserver;
  try { await h2(evOn({ closest: (s) => (s === '.code-copy' ? host2.buttons[0] : null) })); } finally { if (saved) global.MutationObserver = saved; }
  assert.ok(host2.buttons[0].classes.has('copied'), 'still ticks without an observer');
  assert.strictEqual(list.length, 1);
});

test('a press that is dragged off its button: the click on the host copies nothing while the pressed button is still there', async () => {
  const d = fakeDom('unused');
  const host = redrawHost(['one', 'two']);
  let clock = 0;
  const got = [];
  const h = CC.makeClickHandler({ document: d.doc, now: () => clock, copy: async (t) => { got.push(t); return true; }, setTimeout: () => 1, clearTimeout() {} });
  const pressOn = (b) => h.pointerDown(evOn({ closest: (s) => (s === '.code-copy' ? b : null) }));
  pressOn(host.buttons[0]);
  clock = 100;
  assert.strictEqual(h(evOn({ closest: () => null })), undefined, 'released on the host, button still connected');
  assert.deepStrictEqual(got, []);
  // the pressed button was replaced by a redraw: the click is used
  pressOn(host.buttons[1]);
  host.redraw();
  clock = 200;
  h.pointerUp(evOn({ closest: (s) => (s === '.code-copy' ? host.buttons[1] : null) }));
  await h(evOn({ closest: () => null }));
  assert.deepStrictEqual(got, ['two']);
  // the record is cleared after the click
  assert.strictEqual(h(evOn({ closest: () => null })), undefined);
  // pointercancel clears the record
  pressOn(host.buttons[0]);
  host.redraw();
  h.pointerCancel();
  assert.strictEqual(h(evOn({ closest: () => null })), undefined);
  assert.deepStrictEqual(got, ['two']);
});

test('the pointercancel listener is installed with the others, in the capture phase', () => {
  assert.match(read('lib/ui-code-copy.js'), /document\.addEventListener\('pointercancel', handler\.pointerCancel, true\)/);
});

// ---- review round 3 ----

test('strict redraw fallback: only a release on the replacement at the same index copies; elsewhere, other index, old records copy nothing; keyboard works', async () => {
  const d = fakeDom('unused');
  const host = redrawHost(['one', 'two', 'three']);
  let clock = 0;
  const got = [];
  const h = CC.makeClickHandler({ document: d.doc, now: () => clock, copy: async (t) => { got.push(t); return true; }, setTimeout: () => 1, clearTimeout() {} });
  const on = (b) => evOn({ closest: (s) => (s === '.code-copy' ? b : null) });
  const nowhere = () => evOn({ closest: () => null });
  // press, redraw, release on the replacement at the same index: copies
  h.pointerDown(on(host.buttons[1])); host.redraw(); clock = 100; h.pointerUp(on(host.buttons[1]));
  const ev = nowhere(); await h(ev);
  assert.deepStrictEqual(got, ['two']); assert.ok(ev.prevented);
  // press, redraw, release elsewhere (up.btn null): no copy, no preventDefault
  h.pointerDown(on(host.buttons[1])); host.redraw(); h.pointerUp(nowhere());
  const e2 = nowhere(); assert.strictEqual(h(e2), undefined);
  assert.ok(!e2.prevented); assert.deepStrictEqual(got, ['two']);
  // release on a different index: no copy
  h.pointerDown(on(host.buttons[1])); host.redraw(); h.pointerUp(on(host.buttons[2]));
  const e3 = nowhere(); assert.strictEqual(h(e3), undefined);
  assert.ok(!e3.prevented); assert.deepStrictEqual(got, ['two']);
  // an old release record: no copy
  clock = 1000;
  h.pointerDown(on(host.buttons[1])); host.redraw(); h.pointerUp(on(host.buttons[1])); clock = 2600;
  assert.strictEqual(h(nowhere()), undefined);
  // a release with no press: no copy
  h.pointerUp(on(host.buttons[1]));
  assert.strictEqual(h(nowhere()), undefined);
  // pointercancel clears both
  clock = 3000;
  h.pointerDown(on(host.buttons[1])); host.redraw(); h.pointerUp(on(host.buttons[1])); h.pointerCancel();
  assert.strictEqual(h(nowhere()), undefined);
  assert.deepStrictEqual(got, ['two']);
  // keyboard click: no pointer records, the target is the button
  await h(on(host.buttons[0]));
  assert.deepStrictEqual(got, ['two', 'one']);
});

test('stale tick: copy A, redraw A, copy B before A ends: A shows Copy at once; B shows Copied then Copy', async () => {
  const d = fakeDom('unused');
  const host = redrawHost(['A', 'B']);
  const T = fakeTimers();
  const { MO, list } = fakeMO();
  let clock = 0;
  const h = CC.makeClickHandler({ document: d.doc, now: () => clock, MutationObserver: MO, copy: async () => true, setTimeout: T.setTimeout, clearTimeout: T.clearTimeout });
  const on = (b) => evOn({ closest: (s) => (s === '.code-copy' ? b : null) });
  await h(on(host.buttons[0]));
  host.redraw(); clock = 200; list[0].cb([]);
  assert.ok(host.buttons[0].classes.has('copied'), 'A repainted on the replacement');
  clock = 300;
  await h(on(host.buttons[1]));
  assert.ok(!host.buttons[0].classes.has('copied'), 'A reset when B starts');
  assert.strictEqual(host.buttons[0].attrs['aria-label'], 'Copy');
  assert.ok(host.buttons[1].classes.has('copied'));
  assert.strictEqual(host.buttons[1].attrs['aria-label'], 'Copied');
  // a redraw while A's old timer is pending, then all timers: nothing is left on A, B ends on Copy
  while (T.q.length) { clock += 2000; if (!T.fire()) break; }
  assert.ok(!host.buttons[0].classes.has('copied') && host.buttons[0].attrs['aria-label'] === 'Copy');
  assert.ok(!host.buttons[1].classes.has('copied') && host.buttons[1].attrs['aria-label'] === 'Copy');
});

test("stale tick: an earlier box's own expiry timer resets the button that shows its state", async () => {
  const d = fakeDom('unused');
  const host = redrawHost(['A', 'B']);
  const T = fakeTimers();
  const { MO, list } = fakeMO();
  let clock = 0;
  const h = CC.makeClickHandler({ document: d.doc, now: () => clock, MutationObserver: MO, copy: async () => true, setTimeout: T.setTimeout, clearTimeout: T.clearTimeout });
  await h(evOn({ closest: (s) => (s === '.code-copy' ? host.buttons[0] : null) }));
  host.redraw(); clock = 100; list[0].cb([]);
  const shown = host.buttons[0];
  assert.ok(shown.classes.has('copied'));
  const t = T.q.find(x => x.ms === 1500);
  clock = 1500; T.q.splice(T.q.indexOf(t), 1); t.f();
  assert.ok(!shown.classes.has('copied') && shown.attrs['aria-label'] === 'Copy');
});

for (const [name, src] of Object.entries(PAGES)) {
  test(`${name}: a linked image renders an <img> inside the <a> with no marker; with a fence in its path, exactly one button`, () => {
    const f = renderer(src);
    const a = f('[![badge](/b.png)](/x)');
    assert.match(a, /<a [^>]*href="\/x"[^>]*>[\s\S]*<img[\s\S]*<\/a>/, a);
    assert.ok(!/m[a-z0-9]{8,}[A-Z]\d+~/.test(a), 'no marker left: ' + a);
    const b = f('[![photo](/img/```\nx\n```.png)](/gallery)');
    assert.strictEqual(buttons(b), 1, b);
    assert.deepStrictEqual(codeTexts(b), ['x\n']);
    assert.ok(!/m[a-z0-9]{8,}[A-Z]\d+~/.test(b), 'no marker left: ' + b);
    assert.match(b, /<a [^>]*href="\/gallery"[^>]*>[\s\S]*<img[\s\S]*<\/a>/, 'img inside the link: ' + b);
    assert.ok(!/<a [^>]*>(?:(?!<\/a>)[\s\S])*code-box/.test(b), 'box not inside the link: ' + b);
    assert.match(b, /<\/a><div class="code-box">/, 'box follows the link: ' + b);
  });
}

// ---- review round 4 ----

for (const [name, src] of Object.entries(PAGES)) {
  test(`${name}: a code box is never inside a link (fence in link text, or in an image inside the link text)`, () => {
    const f = renderer(src);
    const inLink = (h) => /<a [^>]*>(?:(?!<\/a>)[\s\S])*code-box/.test(h);
    const a = f('[see ```\nls\n``` here](/x)');
    assert.strictEqual(buttons(a), 1, a);
    assert.ok(!inLink(a), a);
    assert.match(a, /<\/a>\s*<div class="code-box">/, a);
    assert.deepStrictEqual(codeTexts(a), ['ls\n']);
    assert.ok(!/m[a-z0-9]{8,}[A-Z]\d+~/.test(a), 'no marker left: ' + a);
    const b = f('[![photo](/img/```\nx\n```.png)](/gallery)');
    assert.strictEqual(buttons(b), 1, b);
    assert.ok(!inLink(b), b);
    assert.match(b, /<a [^>]*><[^>]*img[^>]*><\/a>(?:<[^>]*>)*\s*<div class="code-box">|<a [^>]*>[\s\S]*<img[\s\S]*<\/a>\s*<div class="code-box">/, b);
  });

  test(`${name}: an image marker in a link URL is pulled out: no '<' in any href, no marker left, the images render`, () => {
    const f = renderer(src);
    for (const md of ['[t](![a](/b.png))', '[![a](/b.png)](![c](/d.png))']) {
      const h = f(md);
      for (const m of h.matchAll(/href="([^"]*)"/g)) assert.ok(!m[1].includes('<'), 'no < in href: ' + h);
      assert.ok(!/m[a-z0-9]{8,}[A-Z]\d+~/.test(h), 'no marker left: ' + h);
      assert.ok(/<img /.test(h), 'image rendered: ' + h);
      assert.strictEqual((h.match(/<img /g) || []).length, (md.match(/!\[/g) || []).length, h);
    }
  });
}

test('pointer ids: a release by another pointer on the replacement does not copy; the same pointer does', async () => {
  const d = fakeDom('unused');
  const host = redrawHost(['one', 'two', 'three']);
  let clock = 0;
  const got = [];
  const h = CC.makeClickHandler({ document: d.doc, now: () => clock, copy: async (t) => { got.push(t); return true; }, setTimeout: () => 1, clearTimeout() {} });
  const on = (b, pointerId) => Object.assign(evOn({ closest: (s) => (s === '.code-copy' ? b : null) }), { pointerId });
  const nowhere = () => evOn({ closest: () => null });
  h.pointerDown(on(host.buttons[1], 1)); host.redraw(); clock = 100; h.pointerUp(on(host.buttons[1], 2));
  const e1 = nowhere();
  assert.strictEqual(h(e1), undefined);
  assert.ok(!e1.prevented); assert.deepStrictEqual(got, []);
  // a new press clears the earlier release record: a lone press with no release copies nothing
  h.pointerDown(on(host.buttons[1], 1)); h.pointerUp(on(host.buttons[1], 1));
  h.pointerDown(on(host.buttons[1], 3)); host.redraw();
  assert.strictEqual(h(nowhere()), undefined);
  assert.deepStrictEqual(got, []);
  // the same pointer: copies
  clock = 200;
  h.pointerDown(on(host.buttons[1], 5)); host.redraw(); clock = 300; h.pointerUp(on(host.buttons[1], 5));
  const e2 = nowhere(); await h(e2);
  assert.deepStrictEqual(got, ['two']); assert.ok(e2.prevented);
});
