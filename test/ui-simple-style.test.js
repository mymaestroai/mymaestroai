'use strict';
// Simple mode under an interface style (Broadsheet House / Quiet Page): the settings sheet swaps Light/Dark/Auto for one line
// and carries the style picker; the top-bar theme button hides; the stored theme is never touched. The page functions are
// run from the real source (app.js, mobile.js) against a small fake DOM built on cheerio.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cheerio = require('cheerio');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const mob = fs.readFileSync(path.join(ROOT, 'mobile.js'), 'utf8');
const L = require(path.join(ROOT, 'lib/ui-looks'));
const hubSimple = require(path.join(ROOT, 'lib/ui-simple.js'));

// ── source extraction ──
function fnSrc(src, name) {
  const m = new RegExp('^[ \\t]*(async )?function ' + name + '\\(', 'm').exec(src);
  assert.ok(m, name + ' exists');
  let i = src.indexOf('{', m.index + m[0].length), depth = 0;
  const from = m.index;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(from, i + 1);
}

// ── a small fake DOM: cheerio underneath, the element surface the sheets use on top ──
function makeDom() {
  const $ = cheerio.load('<body><div class="main"></div></body>');
  const cache = new WeakMap();
  const wrap = (n) => { if (!n) return null; if (!cache.has(n)) cache.set(n, new El(n)); return cache.get(n); };
  class El {
    constructor(node) { this.node = node; this.style = {}; this.ls = {}; this.open = false; }
    get hidden() { return $(this.node).attr('hidden') !== undefined; }
    set hidden(v) { if (v) $(this.node).attr('hidden', ''); else $(this.node).removeAttr('hidden'); }
    get textContent() { return $(this.node).text(); }
    set textContent(v) { $(this.node).text(String(v)); }
    set innerHTML(v) { $(this.node).html(v); }
    get innerHTML() { return $(this.node).html(); }
    get id() { return $(this.node).attr('id') || ''; }
    set id(v) { $(this.node).attr('id', v); }
    get className() { return $(this.node).attr('class') || ''; }
    set className(v) { $(this.node).attr('class', v); }
    get dataset() { const o = {}; for (const [k, v] of Object.entries(this.node.attribs || {})) if (k.startsWith('data-')) o[k.slice(5)] = v; return o; }
    get classList() { const n = this.node; return { toggle: (c, on) => { $(n).toggleClass(c, on); }, contains: (c) => $(n).hasClass(c) }; }
    get parentNode() { return wrap(this.node.parent && this.node.parent.type === 'tag' ? this.node.parent : null); }
    get isConnected() { let n = this.node; while (n) { if (n.name === 'body') return true; n = n.parent; } return false; }
    setAttribute(k, v) { $(this.node).attr(k, String(v)); }
    getAttribute(k) { const v = $(this.node).attr(k); return v === undefined ? null : v; }
    querySelector(s) { return wrap($(this.node).find(s).first()[0]); }
    querySelectorAll(s) { return $(this.node).find(s).toArray().map(wrap); }
    closest(s) { return wrap($(this.node).closest(s)[0]); }
    appendChild(c) { $(this.node).append(c.node); return c; }
    append(...cs) { cs.forEach((c) => this.appendChild(c)); }
    remove() { $(this.node).remove(); }
    focus() {}
    addEventListener(t, f) { (this.ls[t] = this.ls[t] || []).push(f); }
    removeEventListener(t, f) { this.ls[t] = (this.ls[t] || []).filter((x) => x !== f); }
    showModal() { this.open = true; }
    close() { this.open = false; this.remove(); (this.ls.close || []).slice().forEach((f) => f()); }
    // a tap: the element's own listeners, then every ancestor's, the target kept
    async click() {
      const ev = { target: this, type: 'click', preventDefault() {}, stopPropagation() {} };
      for (let el = this; el; el = el.parentNode) for (const f of (el.ls.click || []).slice()) await f(ev);
    }
  }
  const head = { children: [], appendChild(n) { n.parentNode = head; head.children.push(n); return n; }, removeChild(n) { head.children = head.children.filter((c) => c !== n); n.parentNode = null; return n; } };
  const dls = {};
  const html = { dataset: {}, classList: { contains: () => true, toggle() {}, add() {}, remove() {} } };
  const doc = {
    documentElement: html, head,
    get body() { return wrap($('body')[0]); },
    createElement(tag) {
      if (tag === 'link') { const a = {}; return { tag, setAttribute(k, v) { a[k] = v; }, getAttribute(k) { return k === 'href' ? this.href : a[k]; }, parentNode: null }; }
      return wrap($('<' + tag + '></' + tag + '>')[0]);
    },
    getElementById(id) { return head.children.find((c) => c.id === id) || wrap($('#' + id)[0]); },
    getElementsByTagName() { return [head]; },
    querySelector(s) { return wrap($('body').find(s).first()[0]); },
    querySelectorAll(s) { return $('body').find(s).toArray().map(wrap); },
    addEventListener(t, f) { (dls[t] = dls[t] || []).push(f); },
    removeEventListener(t, f) { dls[t] = (dls[t] || []).filter((x) => x !== f); },
    dispatchEvent(e) { (dls[e.type] || []).slice().forEach((f) => f(e)); return true; },
    _count: (t) => (dls[t] || []).length,
    _html: html,
  };
  return { $, wrap, doc };
}

// ── (a) apply() dispatches mm-look-change once per real change ──
test('apply(): mm-look-change fires once when the look changes, not when it stays, and carries the id', () => {
  const { doc } = makeDom();
  const seen = [];
  doc.addEventListener('mm-look-change', (e) => seen.push(e.detail.id));
  L.apply(doc, 'engineering');              // already Engineering: no change
  assert.deepStrictEqual(seen, []);
  L.apply(doc, 'broadsheet');
  assert.deepStrictEqual(seen, ['broadsheet']);
  L.apply(doc, 'broadsheet');               // same look again
  assert.deepStrictEqual(seen, ['broadsheet']);
  L.apply(doc, 'quiet');
  L.apply(doc, 'engineering');
  assert.deepStrictEqual(seen, ['broadsheet', 'quiet', 'engineering']);
  L.apply(doc, 'no-such-look');              // unknown id resolves to Engineering, already in force
  assert.deepStrictEqual(seen, ['broadsheet', 'quiet', 'engineering']);
});

test('apply(): a document without dispatchEvent, or a listener that throws, changes the look all the same', () => {
  const bare = { documentElement: { dataset: {} }, head: { appendChild() {}, removeChild() {} }, createElement: () => ({ setAttribute() {}, getAttribute() {} }), getElementById: () => null };
  assert.strictEqual(L.apply(bare, 'quiet'), 'quiet');
  assert.strictEqual(L.applied(bare), 'quiet');
  const { doc } = makeDom();
  doc.dispatchEvent = () => { throw new Error('listener blew up'); };
  assert.strictEqual(L.apply(doc, 'broadsheet'), 'broadsheet');
  assert.strictEqual(L.applied(doc), 'broadsheet');
});

// ── desktop harness ──
function desktop(theme) {
  const { doc, wrap, $ } = makeDom();
  const calls = { fetch: [], toasts: [], applies: [], pickers: [] };
  const me = { user: { id: 'u1', name: 'Sam' }, theme };
  const lead = 'let simpleThemeSaving = false;\nlet simpleLookOnce = false;\nlet simpleLookOff = null;\n';
  const names = ['simpleThemeBtnPaint', 'simpleTopSync', 'simplePrefs', 'simpleStyleLabel', 'simpleThemeBtnVisible', 'simpleLookListen', 'simpleCloseSettings', 'openSimpleSettings'];
  const ctx = {
    window: { hubSimple: Object.assign({}, hubSimple, { apply: (m) => calls.applies.push(m.theme) }), HubLooks: L, hubMe: me },
    document: doc,
    fetch: async (u, o) => { calls.fetch.push([u, o && o.body]); return { ok: true, json: async () => ({}) }; },
    hubToast: (m) => calls.toasts.push(m),
    signOut() {}, simpleSwitchMode() {},
    simpleOn: () => true, simpleAccountOk: () => true,
    lookPickerBuild: (host) => calls.pickers.push(host),
    simpleThemeNext() {},
    location: { reload() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(lead + names.map((n) => fnSrc(app, n)).join('\n') + '\nthis.__h = { simpleTopSync, openSimpleSettings, simpleCloseSettings };', ctx);
  return { ctx, doc, wrap, $, calls, me, h: ctx.__h };
}
const setLook = (doc, id) => L.apply(doc, id);
const sheetOf = (doc) => doc.getElementById('simple-settings');

test('desktop source: the picker section follows Appearance, the line has its class, one listener on the document', () => {
  const src = fnSrc(app, 'openSimpleSettings');
  const a = src.indexOf('sm-lab">Appearance'), p = src.indexOf('sm-lab">Interface style'), n = src.indexOf('sm-lab">Name');
  assert.ok(a > 0 && p > a && n > p, 'Appearance, then Interface style, then Name');
  assert.match(src, /class="sm-follow"/);
  assert.match(src, /lookPickerBuild\(overlay\.querySelector\('\.sm-style'\)\)/);
  assert.match(src, /'Colours follow your interface style \(' \+ label \+ '\)\.'/);
  assert.match(fnSrc(app, 'simpleLookListen'), /document\.addEventListener\('mm-look-change'/);
});

test('desktop sheet: Engineering shows the buttons and no line; Broadsheet House swaps them for the line', async () => {
  const d = desktop('light');
  d.h.openSimpleSettings();
  const sheet = sheetOf(d.doc);
  const seg = sheet.querySelector('.sm-seg'), line = sheet.querySelector('.sm-follow');
  assert.strictEqual(seg.style.display, '');
  assert.strictEqual(line.hidden, true);
  assert.strictEqual(d.calls.pickers.length, 1, 'the style picker was built');
  assert.ok(d.calls.pickers[0].node === sheet.querySelector('.sm-style').node, 'into the Interface style section');
  setLook(d.doc, 'broadsheet');
  assert.strictEqual(seg.style.display, 'none');
  assert.strictEqual(line.hidden, false);
  assert.strictEqual(line.textContent, 'Colours follow your interface style (Broadsheet House).');
  setLook(d.doc, 'quiet');   // Quiet Page has a light and a dark set: the choices are back (see the Quiet tests below)
  assert.strictEqual(seg.style.display, '');
  assert.strictEqual(line.hidden, true);
  setLook(d.doc, 'engineering');
  assert.strictEqual(seg.style.display, '');
  assert.strictEqual(line.hidden, true);
});

test('desktop sheet: opened while a light style is already in force, it paints the line at once', () => {
  const d = desktop('dark');
  setLook(d.doc, 'broadsheet');
  d.h.openSimpleSettings();
  const sheet = sheetOf(d.doc);
  assert.strictEqual(sheet.querySelector('.sm-seg').style.display, 'none');
  assert.strictEqual(sheet.querySelector('.sm-follow').textContent, 'Colours follow your interface style (Broadsheet House).');
});

test('desktop round trip: Dark in Engineering -> Broadsheet -> Engineering keeps Dark, saves nothing', () => {
  const d = desktop('dark');
  d.h.openSimpleSettings();
  const sheet = sheetOf(d.doc);
  const on = () => sheet.querySelectorAll('.sm-seg button').filter((b) => b.classList.contains('on')).map((b) => b.dataset.theme);
  assert.deepStrictEqual(on(), ['dark']);
  setLook(d.doc, 'broadsheet');
  setLook(d.doc, 'engineering');
  assert.strictEqual(d.me.theme, 'dark');
  assert.deepStrictEqual(on(), ['dark']);
  assert.strictEqual(sheet.querySelector('.sm-seg').style.display, '');
  assert.deepStrictEqual(d.calls.fetch, [], 'no prefs call');
  assert.deepStrictEqual(d.calls.applies, [], 'hubSimple.apply not called by a style switch');
});

test('desktop: the sheet\'s listener goes when it closes (and a closed sheet is never repainted)', () => {
  const d = desktop('auto');
  const before = d.doc._count('mm-look-change');
  d.h.openSimpleSettings();
  assert.strictEqual(d.doc._count('mm-look-change'), before + 1);
  d.h.simpleCloseSettings();
  assert.strictEqual(d.doc._count('mm-look-change'), before);
  d.h.openSimpleSettings(); d.h.openSimpleSettings();   // reopened: still one
  assert.strictEqual(d.doc._count('mm-look-change'), before + 1);
});

test('desktop: the top-bar theme button hides under a light style and returns in Engineering', () => {
  const d = desktop('light');
  d.h.simpleTopSync();
  const btn = d.doc.querySelector('.simple-theme-btn');
  assert.ok(btn, 'the button exists in Simple');
  assert.strictEqual(btn.hidden, false); assert.strictEqual(btn.style.display, '');
  setLook(d.doc, 'broadsheet');
  assert.strictEqual(btn.hidden, true); assert.strictEqual(btn.style.display, 'none');
  setLook(d.doc, 'engineering');
  assert.strictEqual(btn.hidden, false); assert.strictEqual(btn.style.display, '');
  d.h.simpleTopSync(); d.h.simpleTopSync();
  assert.strictEqual(d.doc._count('mm-look-change'), 1, 'one document listener, added once');
  setLook(d.doc, 'broadsheet');
  d.h.simpleTopSync();                      // a re-sync under a light style keeps it hidden
  assert.strictEqual(d.doc.querySelector('.simple-theme-btn').hidden, true);
});

// ── phone harness ──
function phone(theme) {
  const { doc, wrap, $ } = makeDom();
  $('body').append('<div id="simple-top"><button class="simple-theme-btn"><span class="stb-ic"></span><span class="stb-lab"></span></button></div>');
  const calls = { posts: [], toasts: [], applies: [], pickers: [] };
  const hubMe = { user: { id: 'u1', name: 'Sam' }, theme };
  const ctx = {
    window: { hubSimple: Object.assign({}, hubSimple, { apply: (m) => calls.applies.push(m.theme) }), HubLooks: L },
    document: doc, hubMe,
    simpleOn: () => true, simpleAccountOk: () => true,
    simplePrefsPost: async (b) => { calls.posts.push(b); return true; },
    simpleReload() {}, signOut() {}, toast: (m) => calls.toasts.push(m),
    $: (id) => doc.getElementById(id),
    simpleDialog: (id) => { let d = doc.getElementById(id); if (!d) { d = doc.createElement('dialog'); d.id = id; doc.body.appendChild(d); } return d; },
    lookPickerPaint: (host) => calls.pickers.push(host),
  };
  vm.createContext(ctx);
  const listener = mob.slice(mob.indexOf('// The top-bar theme button follows the style on its own too'), mob.indexOf('// The Simple view switch (Advanced top bars'));
  assert.ok(listener.includes("addEventListener('mm-look-change'"));
  vm.runInContext('let simpleThemeSaving = false;\n' + ['simpleStyleLabel'].map((n) => fnSrc(mob, n)).join('\n') + '\nlet simpleLookSheetOff = null;\n' +
    fnSrc(mob, 'simpleToggleSync') + '\n' + listener + '\n' + fnSrc(mob, 'simpleSettingsOpen') + '\nthis.__h = { simpleToggleSync, simpleSettingsOpen };', ctx);
  return { ctx, doc, wrap, calls, hubMe, h: ctx.__h };
}

test('phone source: the style section sits right after Appearance, with the line', () => {
  const src = fnSrc(mob, 'simpleSettingsOpen');
  const a = src.indexOf('>Appearance<'), p = src.indexOf('>Interface style<'), n = src.indexOf('>Name<');
  assert.ok(a > 0 && p > a && n > p, 'Appearance, then Interface style, then Name');
  assert.match(src, /class="ss-follow"/);
  assert.match(src, /'Colours follow your interface style \(' \+ label \+ '\)\.'/);
});

test('phone sheet: Engineering shows the buttons and no line; Broadsheet House swaps them for the line', () => {
  const p = phone('light');
  p.h.simpleSettingsOpen();
  const sheet = p.doc.getElementById('simple-settings-sheet');
  const seg = sheet.querySelector('.ss-seg'), line = sheet.querySelector('.ss-follow');
  assert.strictEqual(seg.style.display, '');
  assert.strictEqual(line.hidden, true);
  assert.strictEqual(p.calls.pickers.length, 1);
  assert.ok(p.calls.pickers[0].node === sheet.querySelector('#ss-style').node);
  setLook(p.doc, 'broadsheet');
  assert.strictEqual(seg.style.display, 'none');
  assert.strictEqual(line.hidden, false);
  assert.strictEqual(line.textContent, 'Colours follow your interface style (Broadsheet House).');
  setLook(p.doc, 'engineering');
  assert.strictEqual(seg.style.display, '');
  assert.strictEqual(line.hidden, true);
});

test('phone round trip: Dark in Engineering -> Broadsheet -> Engineering keeps Dark, saves nothing', () => {
  const p = phone('dark');
  p.h.simpleSettingsOpen();
  const sheet = p.doc.getElementById('simple-settings-sheet');
  const on = () => sheet.querySelectorAll('.ss-seg button').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.theme);
  assert.deepStrictEqual(on(), ['dark']);
  setLook(p.doc, 'broadsheet');
  setLook(p.doc, 'engineering');
  assert.strictEqual(p.hubMe.theme, 'dark');
  assert.deepStrictEqual(on(), ['dark']);
  assert.deepStrictEqual(p.calls.posts, [], 'no prefs call');
  assert.deepStrictEqual(p.calls.applies, []);
});

test('phone: the sheet\'s listener goes when it closes', () => {
  const p = phone('auto');
  const base = p.doc._count('mm-look-change');   // the page's own top-bar listener
  p.h.simpleSettingsOpen();
  assert.strictEqual(p.doc._count('mm-look-change'), base + 1);
  p.doc.getElementById('simple-settings-sheet').close();
  assert.strictEqual(p.doc._count('mm-look-change'), base);
});

test('phone: the top-bar theme button hides under a light style and returns in Engineering', () => {
  const p = phone('light');
  p.h.simpleToggleSync();
  const btn = p.doc.querySelector('#simple-top .simple-theme-btn');
  assert.strictEqual(btn.hidden, false);
  setLook(p.doc, 'broadsheet');
  assert.strictEqual(btn.hidden, true);
  setLook(p.doc, 'engineering');
  assert.strictEqual(btn.hidden, false);
  assert.strictEqual(p.hubMe.theme, 'light');
});

// ── Quiet Page (sets: 'both') in Simple: the same Light / Dark / Match device choices and top-bar button as Engineering ──
test('Simple + Quiet Page, desktop: the Appearance choices and the top-bar theme button show; no "colours follow" line', () => {
  const d = desktop('dark');
  setLook(d.doc, 'quiet');
  d.h.simpleTopSync();
  const btn = d.doc.querySelector('.simple-theme-btn');
  assert.strictEqual(btn.hidden, false); assert.strictEqual(btn.style.display, '');
  d.h.openSimpleSettings();
  const sheet = sheetOf(d.doc);
  assert.strictEqual(sheet.querySelector('.sm-seg').style.display, '', 'the Light / Dark / Match device choices');
  assert.strictEqual(sheet.querySelector('.sm-follow').hidden, true);
  assert.deepStrictEqual(sheet.querySelectorAll('.sm-seg button').map((b) => b.textContent), ['Light', 'Dark', 'Match device']);
  // a single-set look keeps today's behaviour, and Quiet brings it all back
  setLook(d.doc, 'broadsheet');
  assert.strictEqual(sheet.querySelector('.sm-seg').style.display, 'none'); assert.strictEqual(btn.hidden, true);
  setLook(d.doc, 'quiet');
  assert.strictEqual(sheet.querySelector('.sm-seg').style.display, ''); assert.strictEqual(btn.hidden, false);
});

test('Simple + Quiet Page, desktop: Light from dark Quiet switches the theme and stays in Simple', async () => {
  const d = desktop('dark');
  setLook(d.doc, 'quiet');
  d.h.openSimpleSettings();
  const sheet = sheetOf(d.doc);
  const light = sheet.querySelectorAll('.sm-seg button').find((b) => b.dataset.theme === 'light');
  await light.click();
  assert.strictEqual(d.me.theme, 'light');
  assert.deepStrictEqual(d.calls.applies, ['light'], 'hubSimple.apply ran with Light');
  assert.strictEqual(JSON.parse(d.calls.fetch[0][1]).theme, 'light', 'saved');
  assert.strictEqual(JSON.stringify(Object.keys(JSON.parse(d.calls.fetch[0][1]))), '["theme"]', 'no uiMode change: Simple stays');
  assert.strictEqual(L.applied(d.doc), 'quiet');
});

test('Simple + Quiet Page, phone: the Appearance choices and the top-bar theme button show', () => {
  const p = phone('dark');
  setLook(p.doc, 'quiet');
  p.h.simpleToggleSync();
  assert.strictEqual(p.doc.querySelector('#simple-top .simple-theme-btn').hidden, false);
  p.h.simpleSettingsOpen();
  const sheet = p.doc.getElementById('simple-settings-sheet');
  assert.strictEqual(sheet.querySelector('.ss-seg').style.display, '');
  assert.strictEqual(sheet.querySelector('.ss-follow').hidden, true);
  setLook(p.doc, 'broadsheet');
  assert.strictEqual(sheet.querySelector('.ss-seg').style.display, 'none');
  assert.strictEqual(p.doc.querySelector('#simple-top .simple-theme-btn').hidden, true);
  setLook(p.doc, 'quiet');
  assert.strictEqual(sheet.querySelector('.ss-seg').style.display, '');
  assert.strictEqual(p.doc.querySelector('#simple-top .simple-theme-btn').hidden, false);
});

test('Simple + Quiet Page, phone: Light from dark Quiet switches the theme and stays in Simple', async () => {
  const p = phone('dark');
  setLook(p.doc, 'quiet');
  p.h.simpleSettingsOpen();
  const sheet = p.doc.getElementById('simple-settings-sheet');
  await sheet.querySelectorAll('.ss-seg button').find((b) => b.dataset.theme === 'light').click();
  assert.strictEqual(p.hubMe.theme, 'light');
  assert.strictEqual(JSON.stringify(p.calls.posts), '[{"theme":"light"}]', 'saved the theme only, no mode change');
  assert.deepStrictEqual(p.calls.applies, ['light']);
});

test('Simple + Quiet Page, phone: the theme button taps through the themes (simpleThemeTap)', async () => {
  const p = phone('dark');
  setLook(p.doc, 'quiet');
  p.ctx.simpleOn = () => true;
  vm.runInContext(fnSrc(mob, 'simpleThemeTap') + '\nthis.__tap = simpleThemeTap;', p.ctx);
  p.h.simpleToggleSync();
  assert.strictEqual(p.doc.querySelector('#simple-top .simple-theme-btn').hidden, false, 'the button a person taps is there');
  await p.ctx.__tap();
  assert.strictEqual(p.hubMe.theme, 'auto');
  assert.strictEqual(JSON.stringify(p.calls.posts), '[{"theme":"auto"}]');
});
