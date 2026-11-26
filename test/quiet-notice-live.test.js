'use strict';
// The one-time Quiet Page notice follows the open page (desktop #hub-theme-notice, phone #theme-notice): a look change or a change of
// the resolved colours shows or hides it; seen is final; a theme chosen in the Settings Appearance control settles it too.
// The page functions are run from the real source (app.js, mobile.js) with the real lib/ui-simple.js on a small fake DOM.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const mob = fs.readFileSync(path.join(ROOT, 'mobile.js'), 'utf8');
const S = require(path.join(ROOT, 'lib/ui-simple.js'));

function fnSrc(src, name, optional) {
  const m = new RegExp('^[ \\t]*(async )?function ' + name + '\\(', 'm').exec(src);
  if (!m) { assert.ok(optional, name + ' exists'); return ''; }
  let i = src.indexOf('{', m.index + m[0].length), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(m.index, i + 1);
}
const lineSrc = (src, re) => { const m = re.exec(src); return m ? m[0] : ''; };

function fakeStorage(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, m };
}
// elements keep a parent and children; getElementById walks the document
function makeDoc(classes) {
  const set = new Set(classes); const ls = {}; const root = { id: '', children: [] };
  const mk = (tag) => {
    const el = { tag, id: '', children: [], dataset: {}, style: {}, attrs: {}, listeners: {}, parentNode: null, hidden: false, textContent: '', className: '', offsetHeight: 40,
      get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === root; },
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      prepend(c) { c.parentNode = this; this.children.unshift(c); },
      insertBefore(c, ref) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; },
      get nextSibling() { const a = this.parentNode.children; return a[a.indexOf(this) + 1] || null; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
      click() { return Promise.all((this.listeners.click || []).map((f) => f())); } };
    return el;
  };
  const find = (n, f) => { if (f(n)) return n; for (const c of n.children) { const r = find(c, f); if (r) return r; } return null; };
  const all = (n, out = []) => { out.push(n); n.children.forEach((c) => all(c, out)); return out; };
  const props = {}; const banner = [];
  const doc = { set, root, all, banner,
    body: Object.assign(mk('body'), { parentNode: root }),
    documentElement: { dataset: {}, classList: { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) }, style: { setProperty: (k, v) => { props[k] = v; banner.push(v); } } },
    createElement: mk,
    getElementById: (id) => find(doc.body, (n) => n.id === id),
    addEventListener(t, f) { (ls[t] ||= []).push(f); },
    removeEventListener(t, f) { ls[t] = (ls[t] || []).filter((x) => x !== f); },
    dispatchEvent(e) { for (const f of [...(ls[e.type] || [])]) f(e); return true; } };
  root.children.push(doc.body);
  return doc;
}

// ── desktop ──
function desktop({ look, theme, classes, seen }) {
  const doc = makeDoc(classes);
  const st = fakeStorage(seen ? { 'mm-theme-notice:u1': '1' } : {});
  const state = { look };
  const me = { user: { id: 'u1' }, theme };
  const win = { hubSimple: S, hubMe: me, localStorage: st, HubLooks: { applied: () => state.look, singleSetLine: () => null } };
  global.window = win;   // lib/ui-simple.js reads window.HubLooks / window.localStorage
  const ctx = { window: win, document: doc, simplePrefs: async () => ({}), hubToast() {} };
  vm.createContext(ctx);
  const names = ['themeNoticeShow', 'themeNoticeSync', 'defaultNoticeStorage', 'layoutBanners'].map((n) => fnSrc(app, n, true)).join('\n');
  const wire = lineSrc(app, /^.*for \(const ev of \['mm-look-change'.*$/m);
  vm.runInContext(names + '\n' + wire + '\nthis.__h = { themeNoticeShow, layoutBanners };', ctx);
  return { doc, st, state, me, win, ctx, h: ctx.__h, notice: () => doc.getElementById('hub-theme-notice') };
}
const setDark = (doc, dark) => { doc.set.delete(dark ? 'mm-light' : 'mm-dark'); doc.set.add(dark ? 'mm-dark' : 'mm-light'); };

test('desktop notice: shown on load for Quiet dark (unseen), then switching to Broadsheet hides it and recalculates the banners', () => {
  const d = desktop({ look: 'quiet', theme: 'dark', classes: ['mm-dark'] });
  try {
    d.h.themeNoticeShow();
    assert.ok(d.notice(), 'shown on load');
    const before = d.doc.banner.length;
    d.state.look = 'broadsheet'; d.doc.dispatchEvent({ type: 'mm-look-change' });
    assert.strictEqual(d.notice(), null, 'Broadsheet hides it');
    assert.ok(d.doc.banner.length > before, 'layoutBanners ran after it was removed');
    assert.strictEqual(d.doc.banner[d.doc.banner.length - 1], '0px');
    d.state.look = 'quiet'; d.doc.dispatchEvent({ type: 'mm-look-change' });
    assert.ok(d.notice(), 'back on Quiet while dark and unseen: shown again');
    assert.strictEqual(d.doc.banner[d.doc.banner.length - 1], '40px', 'and the spacing counts it');
  } finally { delete global.window; }
});

test('desktop notice: Match device flipping to dark shows it (unseen), flipping to light hides it', () => {
  const d = desktop({ look: 'quiet', theme: 'auto', classes: ['mm-light'] });
  try {
    d.h.themeNoticeShow();
    assert.strictEqual(d.notice(), null, 'light: nothing');
    setDark(d.doc, true); d.doc.dispatchEvent({ type: 'mm-theme-resolved' });
    assert.ok(d.notice(), 'the device went dark: shown');
    assert.strictEqual(d.doc.banner[d.doc.banner.length - 1], '40px');
    setDark(d.doc, false); d.doc.dispatchEvent({ type: 'mm-theme-resolved' });
    assert.strictEqual(d.notice(), null, 'the device went light: hidden');
    assert.strictEqual(d.doc.banner[d.doc.banner.length - 1], '0px');
  } finally { delete global.window; }
});

test('desktop notice: a theme chosen elsewhere (mm-theme-change) re-evaluates it too; one notice at most', () => {
  const d = desktop({ look: 'quiet', theme: 'light', classes: ['mm-light'] });
  try {
    d.h.themeNoticeShow();
    assert.strictEqual(d.notice(), null);
    setDark(d.doc, true); d.doc.dispatchEvent({ type: 'mm-theme-change' }); d.doc.dispatchEvent({ type: 'mm-theme-resolved' });
    assert.strictEqual(d.doc.all(d.doc.body).filter((n) => n.id === 'hub-theme-notice').length, 1);
  } finally { delete global.window; }
});

test('desktop notice: once seen it never shows again, whatever the page does', () => {
  const d = desktop({ look: 'quiet', theme: 'auto', classes: ['mm-light'], seen: true });
  try {
    d.h.themeNoticeShow();
    for (const [look, dark, ev] of [['quiet', true, 'mm-theme-resolved'], ['broadsheet', true, 'mm-look-change'], ['quiet', true, 'mm-look-change'], ['quiet', false, 'mm-theme-resolved'], ['quiet', true, 'mm-theme-resolved']]) {
      d.state.look = look; setDark(d.doc, dark); d.doc.dispatchEvent({ type: ev });
      assert.strictEqual(d.notice(), null, look + ' ' + dark + ' ' + ev);
    }
    // seen while it is up (its own close): the next flip does not bring it back
    const d2 = desktop({ look: 'quiet', theme: 'dark', classes: ['mm-dark'] });
    d2.h.themeNoticeShow(); assert.ok(d2.notice());
    assert.strictEqual(d2.st.m.get('mm-theme-notice:u1'), undefined, 'not marked yet');
    S.markNoticeSeen(d2.me, d2.st); assert.strictEqual(d2.st.m.get('mm-theme-notice:u1'), '1', 'now marked');
    d2.doc.dispatchEvent({ type: 'mm-look-change' });
    assert.strictEqual(d2.notice(), null, 'seen: an open notice goes at the next check');
    setDark(d2.doc, false); d2.doc.dispatchEvent({ type: 'mm-theme-resolved' }); setDark(d2.doc, true); d2.doc.dispatchEvent({ type: 'mm-theme-resolved' });
    assert.strictEqual(d2.notice(), null);
  } finally { delete global.window; }
});

test('desktop notice: Simple mode never shows it, on any event', () => {
  const d = desktop({ look: 'quiet', theme: 'dark', classes: ['mm-dark', 'mm-simple'] });
  try { d.h.themeNoticeShow(); d.doc.dispatchEvent({ type: 'mm-look-change' }); d.doc.dispatchEvent({ type: 'mm-theme-resolved' }); assert.strictEqual(d.notice(), null); }
  finally { delete global.window; }
});

// ── phone ──
function phone({ look, theme, classes, seen }) {
  const doc = makeDoc(classes);
  const screen = doc.createElement('div'); screen.id = 'screen-agents'; doc.body.appendChild(screen);
  const st = fakeStorage(seen ? { 'mm-theme-notice:u1': '1' } : {});
  const state = { look };
  const hubMe = { user: { id: 'u1' }, theme };
  const win = { hubSimple: S, localStorage: st, HubLooks: { applied: () => state.look, singleSetLine: () => null } };
  global.window = win;
  const ctx = { window: win, document: doc, hubMe, $: (id) => doc.getElementById(id), simplePrefsPost: async () => true, toast() {} };
  vm.createContext(ctx);
  const names = ['themeNoticeGone', 'themeNoticeChosen', 'themeNoticeShow', 'themeNoticeSync'].map((n) => fnSrc(mob, n, true)).join('\n');
  const wire = lineSrc(mob, /^.*for \(const ev of \['mm-look-change'.*$/m);
  vm.runInContext(names + '\n' + wire + '\nthis.__h = { themeNoticeShow, themeNoticeGone };', ctx);
  return { doc, st, state, hubMe, ctx, h: ctx.__h, notice: () => doc.getElementById('theme-notice') };
}

test('phone notice: Broadsheet hides it; Quiet again shows it (unseen); Match device flipping follows', () => {
  const p = phone({ look: 'quiet', theme: 'auto', classes: ['mm-dark'] });
  try {
    p.h.themeNoticeShow(); assert.ok(p.notice());
    p.state.look = 'broadsheet'; p.doc.dispatchEvent({ type: 'mm-look-change' });
    assert.strictEqual(p.notice(), null);
    p.state.look = 'quiet'; p.doc.dispatchEvent({ type: 'mm-look-change' });
    assert.ok(p.notice());
    setDark(p.doc, false); p.doc.dispatchEvent({ type: 'mm-theme-resolved' });
    assert.strictEqual(p.notice(), null, 'device went light');
    setDark(p.doc, true); p.doc.dispatchEvent({ type: 'mm-theme-resolved' });
    assert.ok(p.notice(), 'device went dark');
  } finally { delete global.window; }
});

test('phone notice: seen never shows again', () => {
  const p = phone({ look: 'quiet', theme: 'auto', classes: ['mm-light'], seen: true });
  try {
    p.h.themeNoticeShow();
    setDark(p.doc, true); p.doc.dispatchEvent({ type: 'mm-theme-resolved' }); p.doc.dispatchEvent({ type: 'mm-look-change' });
    assert.strictEqual(p.notice(), null);
  } finally { delete global.window; }
});

// ── a choice in the Settings Appearance control settles the notice for good ──
test('desktop: choosing a theme in Settings marks the notice seen and removes it (a reload does not bring it back)', () => {
  const doc = makeDoc(['mm-dark']);
  const st = fakeStorage();
  const me = { user: { id: 'u1' }, theme: 'dark' };
  let opts = null;
  const hubSimple = Object.assign({}, S, { themeControl: (d, o) => { opts = o; return { el: { style: {} } }; } });
  const host = { firstChild: null, appendChild() {}, insertBefore() {} };
  const win = { hubSimple, hubMe: me, localStorage: st, HubLooks: { byId: () => null } };
  global.window = win;
  try {
    const gdoc = Object.assign(Object.create(doc), { getElementById: (id) => (id === 'st-looks-body' ? host : doc.getElementById(id)), createElement: () => ({ style: {}, appendChild() {} }) });
    const ctx = { window: win, document: gdoc, lookPickerBuild() {}, isHubAdmin: () => false, simplePrefs: async () => ({}), hubToast() {} };
    vm.createContext(ctx);
    vm.runInContext([fnSrc(app, 'lookSectionPaint'), fnSrc(app, 'layoutBanners'), fnSrc(app, 'defaultNoticeStorage', true)].join('\n') + '\nthis.__paint = lookSectionPaint;', ctx);
    const el = doc.createElement('div'); el.id = 'hub-theme-notice'; doc.body.appendChild(el);
    ctx.__paint({});
    assert.ok(opts && typeof opts.onChosen === 'function', 'the Appearance control was built');
    opts.onChosen('light', true);   // the notice was up when the button was pressed
    assert.strictEqual(st.m.get('mm-theme-notice:u1'), '1', 'marked seen');
    assert.strictEqual(doc.getElementById('hub-theme-notice'), null, 'removed');
  } finally { delete global.window; }
});

test('phone: choosing a theme in Settings marks the notice seen (the handler given to the Appearance control)', () => {
  const m = /simpleThemeCtl\((\w+)\)/.exec(mob);
  assert.ok(m, 'the profile sheet builds the control');
  const p = phone({ look: 'quiet', theme: 'dark', classes: ['mm-dark'] });
  try {
    p.h.themeNoticeShow(); assert.ok(p.notice());
    vm.runInContext(fnSrc(mob, m[1]) + '\nthis.__chosen = ' + m[1] + ';', p.ctx);
    p.ctx.__chosen('light', true);   // the notice was up when the button was pressed
    assert.strictEqual(p.st.m.get('mm-theme-notice:u1'), '1', 'marked seen');
    assert.strictEqual(p.notice(), null, 'removed');
  } finally { delete global.window; }
});

// ── the control driven for real: the notice is dismissed for good only when it was up at the press ──
// The real themeControl (lib/ui-simple.js) is built by the real page code; its buttons are pressed on the fake DOM.
const pressTheme = async (ctl, value) => { const b = ctl.el.children.find((c) => c.attrs && c.attrs.role === 'group').children.find((x) => x.dataset.theme === value); await b.click(); };

function desktopLive({ look, theme, classes, saveOk }) {
  const base = makeDoc(classes);
  const st = fakeStorage();
  const state = { look };
  const me = { user: { id: 'u1' }, theme, uiMode: 'advanced' };
  const host = { firstChild: null, appendChild() {}, insertBefore() {} };
  let ctl = null;
  const hubSimple = Object.assign({}, S, { themeControl: (d, o) => (ctl = S.themeControl(d, o)) });
  const win = { hubSimple, hubMe: me, localStorage: st, HubLooks: { applied: () => state.look, singleSetLine: () => null, byId: () => null } };
  global.window = win;
  const doc = Object.assign(Object.create(base), { getElementById: (id) => (id === 'st-looks-body' ? host : base.getElementById(id)) });
  const makeEl = base.createElement;
  doc.createElement = (t) => { const e = makeEl(t); e.firstChild = null; return e; };
  const ctx = { window: win, document: doc, lookPickerBuild() {}, isHubAdmin: () => false, hubToast() {}, simplePrefs: async () => { if (!saveOk()) throw new Error('nope'); return {}; } };
  vm.createContext(ctx);
  const names = ['themeNoticeShow', 'themeNoticeSync', 'defaultNoticeStorage', 'layoutBanners', 'lookSectionPaint'].map((n) => fnSrc(app, n)).join('\n');
  vm.runInContext(names + '\n' + lineSrc(app, /^.*for \(const ev of \['mm-look-change'.*$/m) + '\nthis.__h = { themeNoticeShow, lookSectionPaint };', ctx);
  const d = { doc: base, st, state, me, h: ctx.__h, notice: () => base.getElementById('hub-theme-notice'), ctl: () => ctl };
  return d;
}

function phoneLive({ look, theme, classes, saveOk }) {
  const p = phone({ look, theme, classes });
  p.hubMe.uiMode = 'advanced';
  p.ctx.simplePrefsPost = async () => saveOk();
  vm.runInContext(fnSrc(mob, 'simpleThemeCtl') + '\nthis.__ctl = () => simpleThemeCtl(themeNoticeChosen);', p.ctx);
  return p;
}

for (const kind of ['desktop', 'phone']) {
  const build = (o) => (kind === 'desktop' ? desktopLive(o) : phoneLive(o));
  const open = (x) => { if (kind === 'desktop') { x.h.lookSectionPaint({}); return x.ctl(); } return x.ctx.__ctl(); };
  const marked = (x) => x.st.m.get('mm-theme-notice:u1');

  test(kind + ': Engineering + Dark chosen in Settings does not mark the never-shown notice seen; switching to Quiet then shows it', async () => {
    let ok = true;
    const x = build({ look: 'engineering', theme: 'light', classes: ['mm-light'], saveOk: () => ok });
    try {
      x.h.themeNoticeShow();
      assert.strictEqual(x.notice(), null, 'Engineering: no notice');
      const ctl = open(x);
      await pressTheme(ctl, 'dark');
      assert.ok(x.doc.set.has('mm-dark'), 'dark is in force');
      assert.strictEqual(marked(x), undefined, 'never shown, so not marked seen');
      x.state.look = 'quiet'; x.doc.dispatchEvent({ type: 'mm-look-change' });
      assert.ok(x.notice(), 'Quiet, dark, normal mode: the notice shows');
    } finally { delete global.window; }
  });

  test(kind + ': Quiet dark with the notice up + Light chosen in Settings: marked seen after a good save, nothing marked when the save fails', async () => {
    let ok = false;
    const x = build({ look: 'quiet', theme: 'dark', classes: ['mm-dark'], saveOk: () => ok });
    try {
      x.h.themeNoticeShow(); assert.ok(x.notice(), 'notice is up');
      const ctl = open(x);
      await pressTheme(ctl, 'light');
      assert.strictEqual(marked(x), undefined, 'failed save marks nothing');
      assert.ok(x.notice(), 'and the notice is still up after the rollback');
      ok = true;
      await pressTheme(ctl, 'light');
      assert.strictEqual(marked(x), '1', 'a good save marks it seen though Light hid it at once');
      assert.strictEqual(x.notice(), null);
    } finally { delete global.window; }
  });
}
