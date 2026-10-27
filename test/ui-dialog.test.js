'use strict';
// One way out of every dialog (lib/ui-dialog.js, carried verbatim by app.js and mobile.js): Escape, Close / Cancel,
// the backdrop and the phone's Back gesture close a dialog with nothing changed and ask "Discard changes?" when
// something changed; Keep editing is the default; the innermost layer goes first; Escape during IME composition is
// ignored; a save in flight keeps the dialog open; Tab stays inside; the focus goes back to the opener. The helper runs
// here against a small fake DOM (no browser), then the pages' wiring is pinned in their source.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ui = require('../lib/ui-dialog');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ── A small DOM: elements with attributes, a selector matcher good for the helper's selectors, events with capture
// and bubble, focus, <dialog> showModal/close, and innerHTML for simple markup. ──
function matchesSimple(el, sel) {
  sel = sel.trim();
  const nots = [];
  sel = sel.replace(/:not\(([^)]*)\)/g, (_, x) => { nots.push(x); return ''; });
  const m = sel.match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[^\]]+\])*)$/);
  if (!m) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const part of (m[2].match(/[.#][\w-]+|\[[^\]]+\]/g) || [])) {
    if (part[0] === '.') { if (!el.classList.contains(part.slice(1))) return false; }
    else if (part[0] === '#') { if (el.getAttribute('id') !== part.slice(1)) return false; }
    else {
      const a = part.slice(1, -1).match(/^([\w-]+)(?:="([^"]*)")?$/);
      if (!el.hasAttribute(a[1])) return false;
      if (a[2] !== undefined && el.getAttribute(a[1]) !== a[2]) return false;
    }
  }
  return nots.every(n => !matchesSimple(el, n));
}
const splitSel = (s) => s.split(',').map(x => x.trim()).filter(Boolean);

function makeDom() {
  const doc = { listeners: { capture: {}, bubble: {} }, activeElement: null };
  class El {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.parent = null; this.attrs = {}; this.listeners = {};
      this.value = ''; this.checked = false; this.open = false; this.hidden = false;
      const self = this;
      this.dataset = new Proxy({}, {
        get: (_, k) => self.attrs['data-' + String(k).replace(/[A-Z]/g, c => '-' + c.toLowerCase())],
        set: (_, k, v) => { self.attrs['data-' + String(k).replace(/[A-Z]/g, c => '-' + c.toLowerCase())] = String(v); return true; },
      });
      this.classList = { contains: (c) => (self.attrs.class || '').split(/\s+/).includes(c), add: (c) => { if (!self.classList.contains(c)) self.attrs.class = ((self.attrs.class || '') + ' ' + c).trim(); } };
    }
    get type() { return this.attrs.type || (this.tagName === 'INPUT' ? 'text' : ''); }
    set type(v) { this.attrs.type = v; }
    get name() { return this.attrs.name || ''; }
    get id() { return this.attrs.id || ''; }
    set id(v) { this.attrs.id = String(v); }
    set className(v) { this.attrs.class = v; }
    get isConnected() { let n = this; while (n) { if (n === doc.body || n === doc.head) return true; n = n.parent; } return false; }
    get firstElementChild() { return this.children[0] || null; }
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    hasAttribute(k) { return this.attrs[k] !== undefined; }
    appendChild(c) { if (c.parent) c.remove(); c.parent = this; this.children.push(c); return c; }
    remove() { if (!this.parent) return; this.parent.children = this.parent.children.filter(x => x !== this); this.parent = null; }
    contains(n) { while (n) { if (n === this) return true; n = n.parent; } return false; }
    matches(sel) { return splitSel(sel).some(s => matchesSimple(this, s)); }
    closest(sel) { let n = this; while (n && n.tagName) { if (n.matches(sel)) return n; n = n.parent; } return null; }
    querySelectorAll(sel) { const out = []; const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } }; walk(this); return out; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    getClientRects() { return this.hidden ? [] : [1]; }
    getBoundingClientRect() { return { left: 100, right: 300, top: 100, bottom: 300 }; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    focus() { doc.activeElement = this; dispatch(this, 'focusin', {}); }
    showModal() { this.open = true; }
    close() { this.open = false; }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text || ''; }
    set innerHTML(html) {
      this.children = [];
      const stack = [this];
      for (const m of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g)) {
        if (m[1]) { stack.pop(); continue; }
        const e = new El(m[2]);
        for (const a of m[3].matchAll(/([\w-]+)="([^"]*)"/g)) e.attrs[a[1]] = a[2];
        stack[stack.length - 1].appendChild(e);
        if (!['input', 'br'].includes(m[2])) stack.push(e);
      }
    }
  }
  function dispatch(target, type, init = {}) {
    const ev = { type, target, defaultPrevented: false, stopped: false, immediate: false, ...init,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; this.immediate = true; } };
    for (const fn of doc.listeners.capture[type] || []) { fn(ev); if (ev.immediate) return ev; }
    let n = target;
    while (n && !ev.stopped) { for (const fn of (n.listeners && n.listeners[type]) || []) { fn(ev); if (ev.immediate) break; } n = n.parent; }
    if (!ev.stopped) for (const fn of doc.listeners.bubble[type] || []) { fn(ev); if (ev.immediate) break; }
    return ev;
  }
  doc.body = new El('body'); doc.head = new El('head');
  doc.createElement = (t) => new El(t);
  doc.getElementById = (id) => { const f = (n) => { for (const c of n.children) { if (c.getAttribute('id') === id) return c; const r = f(c); if (r) return r; } return null; }; return f(doc.head) || f(doc.body); };
  doc.addEventListener = (t, fn, capture) => { const k = capture ? 'capture' : 'bubble'; (doc.listeners[k][t] = doc.listeners[k][t] || []).push(fn); };
  doc.querySelectorAll = (sel) => doc.body.querySelectorAll(sel);
  doc.activeElement = doc.body;
  const winListeners = {};
  const hist = { entries: [{ state: null }], i: 0 };
  const win = {
    location: { href: 'http://hub.test/' },
    addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); },
    history: {
      get state() { return hist.entries[hist.i].state; },
      pushState(state) { hist.entries = hist.entries.slice(0, hist.i + 1); hist.entries.push({ state }); hist.i++; },
      back() { if (hist.i > 0) { hist.i--; const st = hist.entries[hist.i].state; Promise.resolve().then(() => fire('popstate', { state: st })); } },
    },
    fetch: null,
  };
  function fire(t, init = {}) {
    const ev = { type: t, defaultPrevented: false, immediate: false, ...init, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.immediate = true; } };
    for (const fn of winListeners[t] || []) { fn(ev); if (ev.immediate) break; }
    return ev;
  }
  const el = (tag, attrs = {}, parent = doc.body) => { const e = new El(tag); Object.assign(e.attrs, attrs); parent.appendChild(e); return e; };
  const key = (target, k, extra = {}) => { const t = target || doc.activeElement || doc.body; dispatch(t, 'keydown', { key: k, ...extra }); };
  const typeInto = (f, v) => { dispatch(f, 'pointerdown'); f.focus(); dispatch(f, 'keydown', { key: 'x' }); f.value = v; dispatch(f, 'input'); };
  return { doc, win, el, key, dispatch, fire, hist, typeInto, El };
}
function dialogPage(opts = {}) {
  const d = makeDom();
  const g = ui.createDialogGuard({ doc: d.doc, win: d.win, ...opts });
  // An editable dialog: an overlay with a box, a name field, a notes field and Save / Cancel.
  const opener = d.el('button', { id: 'opener' });
  opener.focus();
  const ov = d.el('div', { class: 'question-overlay' });
  const box = d.el('div', { class: 'question-modal' }, ov);
  const name = d.el('input', { id: 'name' }, box); name.value = 'Maestro';
  const notes = d.el('textarea', { id: 'notes' }, box); notes.value = '';
  const save = d.el('button', { id: 'save' }, box);
  const cancel = d.el('button', { id: 'cancel' }, box);
  const layer = g.open(ov);
  return { ...d, g, ov, box, name, notes, save, cancel, opener, layer };
}
const flush = () => new Promise(r => setImmediate(r));

test('labels: one DIALOG_TEXT object, the helper block byte-identical in lib/ui-dialog.js, app.js and mobile.js', () => {
  assert.deepStrictEqual(Object.keys(ui.DIALOG_TEXT), ['discardTitle', 'discardBody', 'discard', 'keepEditing', 'close', 'closeAria', 'saving']);
  assert.strictEqual(ui.DIALOG_TEXT.discardTitle, 'Discard changes?');
  assert.strictEqual(ui.DIALOG_TEXT.discard, 'Discard');
  assert.strictEqual(ui.DIALOG_TEXT.keepEditing, 'Keep editing');
  const B = '// ── dialog helpers (begin) ──', E = '// ── dialog helpers (end) ──';
  const block = (src, ind) => { const a = src.indexOf(B), b = src.indexOf(E); assert.ok(a >= 0 && b > a, 'markers'); return src.slice(a, b).split('\n').map(l => (ind && l.startsWith(ind) ? l.slice(ind.length) : l)).join('\n'); };
  const lib = block(read('lib/ui-dialog.js'), '');
  assert.strictEqual(block(read('app.js'), '    '), lib, 'app.js copy differs from lib/ui-dialog.js');
  assert.strictEqual(block(read('mobile.js'), ''), lib, 'mobile.js copy differs from lib/ui-dialog.js');
  assert.ok(!/'Discard changes\?'|'Keep editing'/.test(read('app.js').replace(block(read('app.js'), ''), '').split(B)[0]), 'no label outside the object');
});

test('changed = differs from what the field showed: typing then deleting is unchanged; search and [data-no-dirty] never count', () => {
  const { doc, el, typeInto } = makeDom();
  const f = el('input'); f.value = 'a';
  const base = new Map([[f, ui.dialogFieldValue(f)]]);
  f.value = 'ab'; assert.strictEqual(ui.dialogIsDirty(base), true);
  f.value = 'a'; assert.strictEqual(ui.dialogIsDirty(base), false, 'typed and deleted: unchanged');
  const cb = el('input', { type: 'checkbox' }); const b2 = new Map([[cb, ui.dialogFieldValue(cb)]]);
  cb.checked = true; assert.strictEqual(ui.dialogIsDirty(b2), true); cb.checked = false; assert.strictEqual(ui.dialogIsDirty(b2), false);
  const gone = el('input'); const b3 = new Map([[gone, '']]); gone.value = 'x'; gone.remove();
  assert.strictEqual(ui.dialogIsDirty(b3), false, 'a field no longer on the page does not count');
  assert.strictEqual(ui.dialogField(el('input', { type: 'search' })), false);
  const wrap = el('div', { 'data-no-dirty': '' }); assert.strictEqual(ui.dialogField(el('input', {}, wrap)), false);
  assert.strictEqual(ui.dialogField(el('button')), false);
  assert.strictEqual(ui.dialogField(el('select')), true);
  void doc; void typeInto;
});

test('Escape: an unchanged dialog closes; focus goes back to what opened it', async () => {
  const p = dialogPage();
  await flush();
  p.name.focus();   // looked at, not changed
  p.key(p.name, 'Escape');
  assert.strictEqual(p.ov.isConnected, false, 'closed');
  assert.strictEqual(p.doc.activeElement, p.opener, 'focus back on the opener');
  const q = dialogPage();
  q.typeInto(q.notes, 'hello'); q.typeInto(q.notes, '');
  q.key(q.notes, 'Escape');
  assert.strictEqual(q.ov.isConnected, false, 'typed then deleted: closes without asking');
});

test('Escape with changes: "Discard changes?" with Keep editing focused; Escape and Enter keep editing; Discard closes', () => {
  const p = dialogPage();
  p.typeInto(p.name, 'Maestro 2');
  p.key(p.name, 'Escape');
  const c = p.g._confirm();
  assert.ok(c && c.open, 'the question is open');
  assert.strictEqual(c.querySelector('#dlg-discard-title').textContent, 'Discard changes?');
  assert.strictEqual(c.querySelector('.dlg-discard-go').textContent, 'Discard');
  assert.strictEqual(c.querySelector('.dlg-discard-keep').textContent, 'Keep editing');
  assert.strictEqual(p.doc.activeElement, c.querySelector('.dlg-discard-keep'), 'Keep editing has the focus');
  p.dispatch(c.querySelector('.dlg-discard-keep'), 'keydown', { key: 'Escape' });
  assert.strictEqual(p.g._confirm(), null, 'Escape on the question = keep editing');
  assert.ok(p.ov.isConnected, 'dialog still open'); assert.strictEqual(p.name.value, 'Maestro 2', 'nothing lost');
  p.key(p.name, 'Escape');
  p.dispatch(p.g._confirm().querySelector('.dlg-discard-go'), 'keydown', { key: 'Enter' });
  assert.ok(p.ov.isConnected, 'Enter never discards, even on Discard');
  p.key(p.name, 'Escape');
  const cancelEv = p.dispatch(p.g._confirm(), 'cancel');
  assert.ok(cancelEv.defaultPrevented && p.ov.isConnected, 'the browser cancel (Escape / Back) keeps editing too');
  p.key(p.name, 'Escape');
  p.dispatch(p.g._confirm().querySelector('.dlg-discard-go'), 'click');
  assert.strictEqual(p.ov.isConnected, false, 'Discard closes and drops the changes');
});

test('every way out follows the same rule: Close button, backdrop click', () => {
  const p = dialogPage();
  p.typeInto(p.notes, 'draft');
  assert.strictEqual(p.g.requestClose(p.cancel, 'close'), 'confirm', 'Cancel asks');
  p.dispatch(p.g._confirm().querySelector('.dlg-discard-keep'), 'click');
  const bd = p.dispatch(p.ov, 'click');
  assert.ok(bd.immediate && p.g._confirm(), 'a click on the backdrop asks too, and the page handler is not reached');
  p.dispatch(p.g._confirm().querySelector('.dlg-discard-keep'), 'click');
  p.dispatch(p.box, 'click');
  assert.ok(p.ov.isConnected && !p.g._confirm(), 'a click inside the box is not the backdrop');
});

test('innermost first: a lightbox over a dialog closes before it; an open dropdown, IME composition and handled keys are left alone', () => {
  const p = dialogPage();
  const lb = p.el('div', { id: 'image-modal' });
  let lbClosed = 0;
  p.g.open(lb, { close: () => { lbClosed++; lb.remove(); } });
  p.key(p.doc.body, 'Escape');
  assert.strictEqual(lbClosed, 1); assert.ok(p.ov.isConnected, 'the dialog under it stays');
  const combo = p.el('input', { 'aria-expanded': 'true' }, p.box);
  p.key(combo, 'Escape');
  assert.ok(p.ov.isConnected, 'an expanded dropdown gets the Escape');
  p.key(p.name, 'Escape', { isComposing: true });
  p.key(p.name, 'Escape', { keyCode: 229 });
  assert.ok(p.ov.isConnected, 'IME composition: ignored');
  assert.strictEqual(ui.dialogEscapeIgnored({ key: 'Escape', defaultPrevented: true }), true);
  p.key(p.name, 'Escape');
  assert.strictEqual(p.ov.isConnected, false);
});

test('a dialog that needs an answer stays on Escape and the backdrop; a docked panel answers Escape only from inside', () => {
  const d = makeDom();
  const g = ui.createDialogGuard({ doc: d.doc, win: d.win });
  const ask = d.el('div', { class: 'question-overlay', 'data-dialog-persistent': '1' });
  g.open(ask);
  d.key(d.doc.body, 'Escape'); d.dispatch(ask, 'click');
  assert.ok(ask.isConnected, 'persistent');
  ask.remove(); g.closed(ask);
  const dock = d.el('div', { class: 'gs-overlay gs-dock' });
  const inside = d.el('input', {}, dock);
  const chat = d.el('textarea');
  g.open(dock);
  d.key(chat, 'Escape');
  assert.ok(dock.isConnected, 'Escape in the chat box is the chat\'s');
  d.key(inside, 'Escape');
  assert.strictEqual(dock.isConnected, false);
});

test('a save in flight: Escape does not close; after a successful save the saved part is the new baseline', async () => {
  const d = makeDom();
  let release;
  d.win.fetch = () => new Promise(r => { release = r; });
  const g = ui.createDialogGuard({ doc: d.doc, win: d.win });
  const ov = d.el('div', { class: 'st-overlay' });
  const sec = d.el('div', { class: 'st-section' }, ov);
  const key = d.el('input', {}, sec);
  const btn = d.el('button', {}, sec);
  g.open(ov);
  d.typeInto(key, 'sk-new');
  d.dispatch(btn, 'pointerdown');
  const pending = d.win.fetch('/api/settings', { method: 'POST' });
  d.key(key, 'Escape');
  assert.ok(ov.isConnected && !g._confirm(), 'saving: stays open, no question');
  assert.match(ov.querySelector('.dlg-saving').textContent, /Still saving/);
  release({ ok: true });
  await pending; await flush();
  d.key(key, 'Escape');
  assert.strictEqual(ov.isConnected, false, 'saved: closes without asking');
  // A failed save keeps the changes counted.
  const ov2 = d.el('div', { class: 'st-overlay' }); const f2 = d.el('input', {}, ov2); const b2 = d.el('button', {}, ov2);
  g.open(ov2); d.typeInto(f2, 'x'); d.dispatch(b2, 'pointerdown');
  const p2 = d.win.fetch('/api/settings', { method: 'POST' }); release({ ok: false }); await p2; await flush();
  d.key(f2, 'Escape');
  assert.ok(g._confirm(), 'failed save: still asks');
});

test('Tab stays inside a modal dialog', async () => {
  const p = dialogPage();
  await flush();
  p.cancel.focus();
  p.key(p.cancel, 'Tab');
  assert.strictEqual(p.doc.activeElement, p.name, 'from the last field to the first');
  p.key(p.name, 'Tab', { shiftKey: true });
  assert.strictEqual(p.doc.activeElement, p.cancel, 'Shift+Tab from the first to the last');
});

test('phone Back: an open sheet owns a history entry; Back closes an unchanged sheet, asks for a changed one and keeps the entry', async () => {
  const d = makeDom();
  const g = ui.createDialogGuard({ doc: d.doc, win: d.win, useHistory: true });
  let routed = 0;
  d.win.addEventListener('popstate', () => { routed++; });   // the page's own router
  const sheet = d.el('dialog'); sheet.showModal();
  const pw = d.el('input', { type: 'password' }, sheet);
  g.open(sheet);
  assert.strictEqual(d.hist.i, 1, 'one entry for the sheet');
  d.typeInto(pw, 'secret');
  d.win.history.back(); await flush();
  assert.ok(sheet.open && g._confirm(), 'Back asks; the sheet stays');
  assert.strictEqual(routed, 0, 'the router did not move');
  d.dispatch(g._confirm().querySelector('.dlg-discard-keep'), 'click');
  assert.strictEqual(d.hist.i, 1, 'Keep editing takes the entry back');
  pw.value = ''; d.dispatch(pw, 'input');
  d.win.history.back(); await flush();
  assert.strictEqual(sheet.open, false, 'unchanged: Back closes it');
  const s2 = d.el('dialog'); s2.showModal(); g.open(s2);
  assert.strictEqual(d.hist.i, 1);
  d.dispatch(s2, 'cancel', { key: 'Escape' });   // the browser's own close request (Android Back via a close watcher)
  await flush();
  assert.strictEqual(s2.open, false); assert.strictEqual(d.hist.i, 0, 'closing removes the entry');
  assert.strictEqual(routed, 0);
});

test('leaving the page with a changed dialog (or edits on an editing page) makes the browser warn', () => {
  const p = dialogPage();
  let ev = p.fire('beforeunload'); assert.strictEqual(ev.defaultPrevented, false);
  p.typeInto(p.name, 'changed');
  ev = p.fire('beforeunload'); assert.strictEqual(ev.defaultPrevented, true);
  const d = makeDom();
  const g = ui.createDialogGuard({ doc: d.doc, win: d.win, pageDirty: true });
  const ta = d.el('textarea');
  d.typeInto(ta, 'personality');
  assert.strictEqual(d.fire('beforeunload').defaultPrevented, true, 'agent settings: an unsaved field');
  g.markLoaded(ta); ta.focus();
  assert.strictEqual(d.fire('beforeunload').defaultPrevented, false, 'content the page loaded is not an edit');
});

test('wiring: desktop dialogs close through the guard; old ad-hoc Escape handlers are gone', () => {
  const app = read('app.js');
  assert.match(app, /const dialogGuard = createDialogGuard\(\{ auto: '\.question-overlay, \.gs-overlay, \.st-overlay, \.dream-overlay, #restart-notify-overlay, #resume-popup-overlay' \}\);/);
  for (const gone of ["overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') overlay.remove(); });", "ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOrPicker(); });",
    "document.addEventListener('keydown', onKey, true);", "onclick=\"this.closest('.question-overlay').remove()\"", "onclick=\"document.getElementById('st-overlay').remove()\""]) assert.ok(!app.includes(gone), gone);
  assert.ok((app.match(/onclick="dialogRequestClose\(this\)"/g) || []).length >= 6, 'Close / Cancel buttons ask the guard');
  assert.match(app, /overlay\.dataset\.dialogPersistent = '1';   \/\/ the agent waits for an answer/);
  assert.match(app, /dialogGuard\.open\(modal, \{ close: closeImageModal \}\)/);
  assert.match(app, /<div id="recall-panel" data-no-dirty>/);
});

test('wiring: phone sheets, the Back gesture, agent settings and tiger team', () => {
  const m = read('mobile.js');
  assert.match(m, /const dialogGuard = createDialogGuard\(\{ useHistory: true \}\);/);
  assert.match(m, /\$\('sec-close'\)\.addEventListener\('click', \(\) => dialogRequestClose\(sheet\)\);/);
  assert.match(m, /dialogGuard\.open\(sh, \{ close: closeReasoningSheet \}\)/);
  assert.match(m, /dialogGuard\.open\(sh, \{ close: closeToolsSheet \}\)/);
  assert.ok(m.indexOf('const dialogGuard = createDialogGuard') < m.indexOf("window.addEventListener('popstate'"), 'the guard sees Back before the router');
  assert.match(read('mobile.html'), /<dialog id="recall-sheet" data-no-dirty>/);
  const as = read('agent-settings.html');
  assert.match(as, /<script src="\/ui-dialog\.js"><\/script>/);
  assert.match(as, /const pageGuard = createDialogGuard\(\{ pageDirty: true \}\);/);
  assert.match(read('tiger-team.html'), /dialogGuard\.open\(panel, \{ close: toggleSavedPanel \}\)/);
  const sf = require('../lib/static-files');
  assert.strictEqual(sf.resolve('/ui-dialog.js'), fs.realpathSync(path.join(ROOT, 'lib', 'ui-dialog.js')));
  assert.strictEqual(sf.resolve('/lib/ui-dialog.js'), null, 'lib/ itself is still not served');
  assert.match(read('docs/HUB-MAP.md'), /Dialogs/);
});
