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
    matches(sel) { return splitSel(sel).some(s => (s === ':modal' ? !!this.modal : matchesSimple(this, s))); }
    closest(sel) { let n = this; while (n && n.tagName) { if (n.matches(sel)) return n; n = n.parent; } return null; }
    querySelectorAll(sel) { const out = []; const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } }; walk(this); return out; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    getClientRects() { return this.hidden ? [] : [1]; }
    getBoundingClientRect() { return { left: 100, right: 300, top: 100, bottom: 300 }; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    focus() { doc.activeElement = this; dispatch(this, 'focusin', {}); }
    showModal() { this.open = true; this.modal = true; }
    show() { this.open = true; this.modal = false; }
    close() { this.open = false; this.modal = false; }
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

test('a save in flight: Escape does not close; only an explicit savePoint commit settles, with the values that were sent', async () => {
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
  const saved = g.savePoint(key);
  d.dispatch(btn, 'pointerdown');
  const pending = d.win.fetch('/api/settings', { method: 'POST' });
  d.key(key, 'Escape');
  assert.ok(ov.isConnected && !g._confirm(), 'saving: stays open, no question');
  assert.match(ov.querySelector('.dlg-saving').textContent, /Still saving/);
  release({ ok: true });
  await pending; await flush();
  saved();
  d.key(key, 'Escape');
  assert.strictEqual(ov.isConnected, false, 'saved and committed: closes without asking');
});

test('review: a successful POST that is not a save (Test provider) leaves the typed key unsaved', async () => {
  const d = makeDom();
  d.win.fetch = async () => ({ ok: true });   // test-provider answers 200 even for a failed check, and stores nothing
  const g = ui.createDialogGuard({ doc: d.doc, win: d.win });
  const ov = d.el('div', { class: 'st-overlay' }); const key = d.el('input', { type: 'password' }, ov); const test = d.el('button', {}, ov);
  g.open(ov);
  d.typeInto(key, 'sk-typed');
  d.dispatch(test, 'pointerdown');
  await d.win.fetch('/api/settings/test-provider', { method: 'POST' }); await flush();
  d.key(key, 'Escape');
  assert.ok(g._confirm(), 'still asks: nothing was saved');
});

test('review: an edit made while a save runs stays unsaved when that save succeeds', async () => {
  const d = makeDom();
  const g = ui.createDialogGuard({ doc: d.doc, win: d.win });
  const ov = d.el('div', { class: 'st-overlay' }); const f = d.el('input', {}, ov);
  g.open(ov);
  d.typeInto(f, 'first');
  const saved = g.savePoint(f);           // Save pressed with "first"
  d.typeInto(f, 'second');                // typed again while the request runs
  saved();                                // the save of "first" succeeded
  d.key(f, 'Escape');
  assert.ok(g._confirm(), '"second" was never saved');
  d.dispatch(g._confirm().querySelector('.dlg-discard-keep'), 'click');
  f.value = 'first'; d.dispatch(f, 'input');
  d.key(f, 'Escape');
  assert.strictEqual(ov.isConnected, false, 'back to the saved value: unchanged');
});

test('review: a save settles only the fields it names, never the rest of the dialog', () => {
  const d = makeDom();
  const g = ui.createDialogGuard({ doc: d.doc, win: d.win });
  const ov = d.el('div', { class: 'st-overlay' });
  const a = d.el('input', {}, d.el('div', { class: 'st-section' }, ov));
  const b = d.el('input', {}, d.el('div', { class: 'st-section' }, ov));
  g.open(ov);
  d.typeInto(a, 'saved here'); d.typeInto(b, 'not saved');
  g.savePoint(a)();
  d.key(b, 'Escape');
  assert.ok(g._confirm(), 'the other section is still unsaved');
  const box = d.el('div', {}, ov); const c1 = d.el('input', {}, box); const c2 = d.el('textarea', {}, box);
  d.typeInto(c1, 'x'); d.typeInto(c2, 'y');
  d.dispatch(g._confirm().querySelector('.dlg-discard-keep'), 'click');
  g.savePoint(box)(); g.savePoint(b)();
  d.key(b, 'Escape');
  assert.strictEqual(ov.isConnected, false, 'a container names all of its fields');
});

test('review: fields the page clears after a finished action (password changed) are not edits', () => {
  const p = dialogPage();
  p.typeInto(p.notes, 'old-and-new-passwords');
  p.notes.value = '';
  p.g.markLoaded([p.notes, null]);
  p.key(p.notes, 'Escape');
  assert.strictEqual(p.ov.isConnected, false);
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

test('review: Tab and Shift+Tab from the dialog box itself (focused, not a control) stay inside', async () => {
  const p = dialogPage();
  await flush();
  assert.strictEqual(p.doc.activeElement, p.box, 'the box took the focus when it opened');
  p.key(p.box, 'Tab', { shiftKey: true });
  assert.strictEqual(p.doc.activeElement, p.cancel, 'Shift+Tab from the box: the last control');
  p.box.focus();
  p.key(p.box, 'Tab');
  assert.strictEqual(p.doc.activeElement, p.name, 'Tab from the box: the first control');
});

test('review: Back while "Discard changes?" is open keeps editing and keeps the sheet\'s history entry', async () => {
  const d = makeDom();
  const g = ui.createDialogGuard({ doc: d.doc, win: d.win, useHistory: true });
  let routed = 0;
  d.win.addEventListener('popstate', () => { routed++; });
  const sheet = d.el('dialog'); sheet.showModal();
  const f = d.el('input', {}, sheet);
  g.open(sheet);
  d.typeInto(f, 'draft');
  d.win.history.back(); await flush();            // Back: the question
  assert.ok(g._confirm());
  assert.strictEqual(d.hist.i, 1, 'the sheet keeps its entry while the question is up');
  d.win.history.back(); await flush();            // Back again, on the question
  assert.strictEqual(g._confirm(), null, 'Back on the question = Keep editing');
  assert.ok(sheet.open); assert.strictEqual(f.value, 'draft');
  assert.strictEqual(d.hist.i, 1, 'and the entry is back');
  d.key(f, 'Escape');                              // the question from Escape
  d.win.history.back(); await flush();
  assert.strictEqual(g._confirm(), null); assert.ok(sheet.open, 'Back on a question opened by Escape keeps editing too');
  assert.strictEqual(d.hist.i, 1);
  assert.strictEqual(routed, 0, 'the page router never moved');
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
  const tt = read('tiger-team.html');
  assert.match(tt, /dialogGuard\.open\(panel, \{ close: closeSavedPanel \}\)/);
  assert.match(tt, /function closeSavedPanel\(\) \{[\s\S]*?dialogGuard\.closed\(panel\);/);
  assert.ok(!/getElementById\('saved-panel'\)\.style\.display = 'none'/.test(tt), 'review: every hide path goes through closeSavedPanel');
  const sf = require('../lib/static-files');
  assert.strictEqual(sf.resolve('/ui-dialog.js'), fs.realpathSync(path.join(ROOT, 'lib', 'ui-dialog.js')));
  assert.strictEqual(sf.resolve('/lib/ui-dialog.js'), null, 'lib/ itself is still not served');
  assert.match(read('docs/HUB-MAP.md'), /Dialogs/);
});

test('review fixes wired in the pages', () => {
  const app = read('app.js'), m = read('mobile.js'), as = read('agent-settings.html');
  assert.match(app, /const gsClose = `<button class="gs-btn secondary" onclick="dialogRequestClose\(this\)">Close<\/button>`;/, 'footer Close = header ✕');
  assert.match(app, /dialogGuard\.markLoaded\(\['sec-pw-current', 'sec-pw-new', 'sec-pw-new2'\]\.map\(id => document\.getElementById\(id\)\)\);/, 'desktop: password changed');
  assert.match(m, /dialogGuard\.markLoaded\(\['sec-pw-current', 'sec-pw-new', 'sec-pw-new2'\]\.map\(\$\)\);/, 'phone: password changed');
  assert.match(m, /\$\('approval-sheet'\)\.__dialogClose = \(\) => \{ approvalsHidden = true; paintApprovals\(\); \};/, 'approval sheet: dismiss = Later');
  const tools = m.slice(m.indexOf("sh.id = 'tsn-sheet';"), m.indexOf("tsnSheetFor = holder;"));
  assert.ok(!/addEventListener\('keydown'/.test(tools), 'Tools sheet: no key handler of its own (the guard handles Esc and Tab once)');
  const save = app.slice(app.indexOf('    async function saveSettings() {'), app.indexOf('    async function testProvider('));
  assert.match(save, /const saved = dialogGuard\.savePoint\(/);
  assert.match(save, /if \(!r\.ok\) throw new Error\(`HTTP \$\{r\.status\}`\);\n\s*saved\(\);/, 'settles only after the hub confirmed it');
  assert.ok(!/savePoint/.test(app.slice(app.indexOf('    async function testProvider('), app.indexOf('    async function testProvider(') + 1500)), 'Test settles nothing');
  for (const fn of ['saveWebSearch', 'saveSpendCaps', 'saveSandboxDefaults', 'savePlanWarn', 'saveMemberPolicy', 'saveClassifier']) {
    const body = app.slice(app.indexOf(`    async function ${fn}(`), app.indexOf('\n    }\n', app.indexOf(`    async function ${fn}(`)));
    assert.match(body, /const saved = dialogGuard\.savePoint\(/, fn);
    assert.match(body, /saved\(\);/, fn);
  }
  assert.match(as, /const SAVES = \[/);
  assert.match(as, /\['saveCurrentFile', 'file-status', \(\) => \[document\.getElementById\(`editor-\$\{currentFile\}`\)\]\],/, 'Save File settles only its own file');
  assert.match(as, /function showStatus\(id, type, msg\) \{\n\s*settleSave\(id, type\);/);
  const lib = read('lib/ui-dialog.js');
  assert.ok(!/function rebase\(|res\.ok\) rebase/.test(lib), 'no automatic settling from a response');
});

// ── Review round 2: one history entry for all open sheets, the pages' own reloads, and saves that overlap ──

test('review 2: a sheet that closes under another one leaves no history entry behind; the next Back is the page\'s', async () => {
  const d = makeDom();
  const g = ui.createDialogGuard({ doc: d.doc, win: d.win, useHistory: true });
  let routed = 0;
  d.win.addEventListener('popstate', () => { routed++; });   // the page's own router
  d.win.history.pushState({ screen: 'chat' });               // the page's route
  const a = d.el('dialog'); a.showModal(); g.open(a);         // About
  const b = d.el('dialog'); b.showModal(); g.open(b);         // a second sheet over it
  assert.strictEqual(d.hist.i, 2, 'one entry while sheets are open');
  a.close(); g.closed(a);                                     // the sheet underneath closes by itself
  assert.strictEqual(d.hist.i, 2, 'the sheet still open keeps the entry');
  assert.strictEqual(g.requestClose(b, 'close'), 'closed');
  await flush();
  assert.strictEqual(d.hist.i, 1, 'no entry left behind');
  assert.deepStrictEqual(d.win.history.state, { screen: 'chat' });
  assert.strictEqual(routed, 0, 'the guard\'s own back() never reached the router');
  d.win.history.back(); await flush();
  assert.strictEqual(routed, 1, 'one Back leaves the chat');
});

test('review 2: Back closes the innermost sheet first; the entry comes back while a sheet is still open', async () => {
  const d = makeDom();
  const g = ui.createDialogGuard({ doc: d.doc, win: d.win, useHistory: true });
  let routed = 0;
  d.win.addEventListener('popstate', () => { routed++; });
  d.win.history.pushState({ screen: 'chat' });
  const a = d.el('dialog'); a.showModal(); g.open(a);
  const b = d.el('dialog'); b.showModal(); g.open(b);
  d.win.history.back(); await flush();
  assert.strictEqual(b.open, false); assert.strictEqual(a.open, true);
  assert.strictEqual(d.hist.i, 2, 'the entry is back for the sheet underneath');
  d.win.history.back(); await flush();
  assert.strictEqual(a.open, false); assert.strictEqual(d.hist.i, 1);
  assert.strictEqual(routed, 0);
  d.win.history.back(); await flush();
  assert.strictEqual(routed, 1);
});

test('review 2: a sheet that opens while the guard\'s own back() is on its way still gets its entry', async () => {
  const d = makeDom();
  const g = ui.createDialogGuard({ doc: d.doc, win: d.win, useHistory: true });
  let routed = 0;
  d.win.addEventListener('popstate', () => { routed++; });
  d.win.history.pushState({ screen: 'chat' });
  const a = d.el('dialog'); a.showModal(); g.open(a);
  g.requestClose(a, 'close');                                 // back() queued, its popstate not yet here
  const b = d.el('dialog'); b.showModal(); g.open(b);
  await flush();
  assert.strictEqual(d.hist.i, 2, 'the new sheet has its entry');
  d.win.history.back(); await flush();
  assert.strictEqual(b.open, false); assert.strictEqual(routed, 0, 'Back closed the sheet, the chat stayed');
});

test('review 2: the pages\' own reloads (hub restarted, new version) wait while a dialog holds unsaved changes', () => {
  const p = dialogPage();
  assert.strictEqual(p.g.hasChanges(), false);
  p.typeInto(p.name, 'changed');
  assert.strictEqual(p.g.hasChanges(), true);
  const d = makeDom();
  const g = ui.createDialogGuard({ doc: d.doc, win: d.win, pageDirty: true });
  d.typeInto(d.el('textarea'), 'personality');
  assert.strictEqual(g.hasChanges(), true, 'an editing page counts too');
  const app = read('app.js'), m = read('mobile.js');
  // each loop waits while busy, and checks once more just before reloading (an edit may start in those 800 ms)
  const busyGo = /\{ if \(busy\(\)\) \{ setTimeout\(go, 2000\); return; \}(?: toast\('Updating to the new version…'\);)? setTimeout\(\(\) => \{ if \(busy\(\)\) go\(\); else location\.reload\(\); \}, 800\); \}/g;
  assert.match(app, /const busy = \(\) => Object\.values\(chats\)\.some\(c => c && c\.controller\) \|\| dialogGuard\.hasChanges\(\);/, 'desktop: hub restarted');
  assert.strictEqual((app.match(busyGo) || []).length, 1);
  assert.match(m, /const busy = \(\) => streams\.size \|\| \(typingNow\(\) && Date\.now\(\) - since < 600000\) \|\| dialogGuard\.hasChanges\(\);/, 'phone: hub restarted');
  assert.match(m, /const busy = \(\) => streams\.size \|\| reattaches\.size \|\| \(typingNow\(\) && Date\.now\(\) - since < 600000\) \|\| dialogGuard\.hasChanges\(\);/, 'phone: new version');
  assert.strictEqual((m.match(busyGo) || []).length, 2);
});

test('review 2: web search keys: only a key saved as typed is cleared; a newer one and a failed save keep what was typed', async () => {
  const app = read('app.js');
  const a = app.indexOf('    async function saveWebSearch() {'), b = app.indexOf('    async function tryWebSearch(');
  const src = app.slice(a, b);
  const run = async (answer, during) => {
    const els = {};
    for (const id of ['st-ws-key-brave', 'st-ws-key-serper', 'st-ws-key-tavily', 'st-ws-order', 'st-ws-searxng', 'st-wf-private', 'st-wf-render', 'st-ws-state']) els[id] = { id, value: '', placeholder: '', textContent: '' };
    els['st-wf-jina'] = { id: 'st-wf-jina', checked: false };
    els['st-ws-key-brave'].value = 'brave-1'; els['st-ws-key-tavily'].value = 'tavily-1';
    const log = [];
    const doc = { getElementById: (id) => els[id] || null };
    const guard = { savePoint: () => () => log.push('commit'), markLoaded: (el) => log.push('loaded ' + el.id) };
    const fetch = async () => { if (during) during(els); return { json: async () => answer }; };
    const fn = new Function('document', 'fetch', 'dialogGuard', 'loadWebSearchStatus', src + '\nreturn saveWebSearch;')(doc, fetch, guard, () => {});
    await fn();
    return { els, log };
  };
  let r = await run({ ok: true });
  assert.strictEqual(r.els['st-ws-key-brave'].value, ''); assert.strictEqual(r.els['st-ws-key-brave'].placeholder, 'set');
  assert.deepStrictEqual(r.log, ['commit', 'loaded st-ws-key-brave', 'loaded st-ws-key-tavily']);
  r = await run({ ok: true }, (els) => { els['st-ws-key-brave'].value = 'brave-2'; });   // typed again while it saved
  assert.strictEqual(r.els['st-ws-key-brave'].value, 'brave-2', 'the newer key stays');
  assert.strictEqual(r.els['st-ws-key-brave'].placeholder, '');
  assert.ok(!r.log.includes('loaded st-ws-key-brave'), 'and stays unsaved');
  assert.strictEqual(r.els['st-ws-key-tavily'].value, '', 'the key saved as typed is cleared');
  r = await run({ ok: false, error: 'nope' });
  assert.strictEqual(r.els['st-ws-key-brave'].value, 'brave-1', 'a failed save keeps the typed key');
  assert.strictEqual(r.els['st-ws-key-brave'].placeholder, '', 'and does not claim it is set');
  assert.deepStrictEqual(r.log, []);
  assert.strictEqual(r.els['st-ws-state'].textContent, 'nope');
});

test('review 2: a panel beside the page (a <dialog> opened with show(), the phone\'s approvals) leaves Back to the page', async () => {
  const d = makeDom();
  const g = ui.createDialogGuard({ doc: d.doc, win: d.win, useHistory: true });
  let routed = 0;
  d.win.addEventListener('popstate', () => { routed++; });
  d.win.history.pushState({ screen: 'chat' });
  const panel = d.el('dialog'); panel.show(); g.open(panel);
  assert.strictEqual(d.hist.i, 1, 'no history entry for the panel');
  d.win.history.back(); await flush();
  assert.strictEqual(routed, 1, 'Back is the page\'s'); assert.ok(panel.open, 'the panel stays');
  d.win.history.pushState({ screen: 'chat' });
  const sheet = d.el('dialog'); sheet.showModal(); g.open(sheet);   // a sheet over the page and the panel
  assert.strictEqual(d.hist.i, 2);
  d.win.history.back(); await flush();
  assert.strictEqual(sheet.open, false, 'Back closes the sheet'); assert.ok(panel.open, 'not the panel under it');
  assert.strictEqual(routed, 1); assert.strictEqual(d.hist.i, 1, 'no entry left behind');
  d.key(d.doc.body, 'Escape');
  assert.strictEqual(panel.open, false, 'Escape still dismisses the panel');
  assert.strictEqual(ui.dialogIsModal({ matches() { throw new SyntaxError(':modal'); } }), true, 'no :modal support: covering');
});

test('review 2: agent settings: one save per section at a time; a change during a save goes next, a Save button press is refused', async () => {
  const as = read('agent-settings.html');
  const a = as.indexOf('  const SAVES_ON_CHANGE = new Set(['), b = as.indexOf('\n  }\n', as.indexOf('  function settleSave(')) + 4;
  assert.ok(a > 0 && b > a);
  const src = as.slice(a, b);
  const onChange = [...new Set([...as.matchAll(/onchange="(save[A-Za-z]+)\(\)"/g)].map(m => m[1]))].sort();
  assert.deepStrictEqual([...new Function('window', 'SAVES', 'pageGuard', 'showStatus', src + '\nreturn SAVES_ON_CHANGE;')({}, [], null, null)].sort(), onChange, 'the list matches the page\'s onchange saves');
  const make = (fn) => {
    const log = [], waiting = [], sent = [], shown = [];
    let running = 0, most = 0, settle = null;
    const field = { value: 'v0' };
    const pageGuard = { savePoint: () => { const snap = field.value; return () => log.push('commit ' + snap); }, markLoaded: () => log.push('loaded') };
    const win = { [fn]: () => { sent.push(field.value); most = Math.max(most, ++running); return new Promise((ok, no) => waiting.push((fail) => { running--; if (fail) no(new Error('network')); else ok(); })); } };
    const showStatus = (id, type, msg) => { shown.push(type + ': ' + msg); if (settle) settle(id, type); };
    const api = new Function('window', 'SAVES', 'pageGuard', 'showStatus', src + '\nreturn { settleSave };')(win, [[fn, 's-status', () => [field]]], pageGuard, showStatus);
    settle = api.settleSave;
    return { log, field, sent, shown, most: () => most, press: () => win[fn](), status: (t) => showStatus('s-status', t, t), answer: async (fail) => { waiting.shift()(fail); await flush(); } };
  };
  let t = make('saveSandbox');                       // alone: its first verdict settles it, once
  t.field.value = 'one'; t.press();
  t.status('success'); t.status('error');
  await t.answer();
  assert.deepStrictEqual(t.log, ['commit one'], 'the first verdict is the save\'s');
  t = make('saveSandbox');                           // a failure, then a later success message: still a failure
  t.field.value = 'one'; t.press();
  t.status('error'); t.status('success');
  await t.answer();
  assert.deepStrictEqual(t.log, []);
  t = make('saveSandbox');                           // changed again while it runs: saved after it, with the newest value
  t.field.value = 'one'; t.press();
  t.field.value = 'two'; t.press();
  t.field.value = 'three'; t.press();
  assert.deepStrictEqual(t.sent, ['one'], 'nothing overlaps');
  t.status('success'); await t.answer();
  assert.deepStrictEqual(t.sent, ['one', 'three'], 'one more save, with the newest value');
  t.status('success'); await t.answer();
  assert.deepStrictEqual(t.log, ['commit one', 'commit three']);
  assert.strictEqual(t.most(), 1);
  t = make('saveSandbox');                           // the first saved, the one after it failed: only "one" counts as saved
  t.field.value = 'one'; t.press();
  t.field.value = 'two'; t.press();
  t.status('success'); await t.answer();
  t.status('error'); await t.answer();
  assert.deepStrictEqual(t.log, ['commit one']);
  t = make('saveSandbox');                           // a save that fails without a message settles nothing; the next one works
  t.field.value = 'one'; t.press();
  await t.answer(true);
  t.field.value = 'two'; t.press();
  t.status('success'); await t.answer();
  assert.deepStrictEqual(t.log, ['commit two']);
  t = make('saveBlurb');                             // a Save button pressed during its save: refused, later edits stay unsaved
  t.field.value = 'A'; t.press();
  t.field.value = 'B'; t.press();
  assert.deepStrictEqual(t.sent, ['A']);
  assert.ok(t.shown.includes('info: Still saving. Press Save again when it is done.'), t.shown.join('|'));
  t.field.value = 'C';                               // typed, Save not pressed
  t.status('success'); await t.answer();
  assert.deepStrictEqual(t.sent, ['A'], 'nothing else was sent');
  assert.deepStrictEqual(t.log, ['commit A'], 'C was never saved, so it stays a change');
  t.press(); t.status('success'); await t.answer();
  assert.deepStrictEqual(t.sent, ['A', 'C']); assert.deepStrictEqual(t.log, ['commit A', 'commit C']);
  assert.strictEqual(t.most(), 1);
  t = make('saveBlurb');                             // the hub answered, the page still finishing its own work: a press starts at once
  t.field.value = 'A'; t.press();
  t.status('success');
  t.field.value = 'B'; t.press();
  assert.deepStrictEqual(t.sent, ['A', 'B']);
  assert.ok(!t.shown.some(m => m.startsWith('info:')), 'no "Still saving" over a save that already answered');
  await t.answer();                                  // A's own work ends: it must not end B's slot
  t.field.value = 'B2'; t.press();
  assert.deepStrictEqual(t.sent, ['A', 'B'], 'B is still running: refused');
  t.status('success'); await t.answer();
  assert.deepStrictEqual(t.log, ['commit A', 'commit B']);
});

test('review 2: agent settings: a wrapped save never writes its status after it reported success (a press may start the next save then)', () => {
  const as = read('agent-settings.html');
  const fnBody = (name) => { const m = as.match(new RegExp(`\\n  (?:async )?function ${name}\\(`)); if (!m) return null; const a = m.index; return as.slice(a, as.indexOf('\n  }\n', a)); };
  const HELPERS = ['showStatus', 'recordsStatus', 'compactionStatus'];
  const statusCall = /\b(?:showStatus|recordsStatus|compactionStatus)\(/;
  const saves = [...as.matchAll(/\['(save[A-Za-z]+)', '[\w-]+-status',/g)].map(m => m[1]);
  assert.strictEqual(saves.length, 18);
  for (const fn of saves) {
    let body = fnBody(fn);
    const own = fn === 'savePolicy' ? ['patchPolicy'] : [];   // savePolicy reports through patchPolicy
    for (const h of own) body += fnBody(h);
    // 1. Status lines are written only by the save itself: no page function it calls (awaited or not) writes one.
    for (const m of body.matchAll(/\b([a-zA-Z]\w*)\(/g)) {
      if (HELPERS.includes(m[1]) || own.includes(m[1]) || m[1] === fn) continue;
      const callee = fnBody(m[1]);
      if (callee) assert.ok(!statusCall.test(callee), `${fn} calls ${m[1]}, which writes a status line`);
    }
    // 2. In the save itself, nothing awaited after the success message is followed by another status.
    const i = body.search(/\b(?:showStatus\('[\w-]+', 'success'|recordsStatus\('success'|compactionStatus\('success')/);
    assert.ok(i > 0, fn + ': reports success');
    //    That includes else and catch branches: a rejected await after success would report through its catch.
    const rest = body.slice(i).replace(/^[^;]*;/, '');
    assert.ok(!/\bawait\b[\s\S]*\b(?:showStatus|recordsStatus|compactionStatus)\(/.test(rest), fn + ': a status after an await that follows success');
    assert.ok(!/\.then\(/.test(body.slice(i)), fn + ': no callbacks after success');
  }
});
