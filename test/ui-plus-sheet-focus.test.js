'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const js = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
const cut = (from, to) => { const a = js.indexOf(from); const b = js.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return js.slice(a, b); };

// A tiny fake DOM: elements with listeners, contains(), hidden, focus() that moves document.activeElement.
function build() {
  const doc = { activeElement: null, body: { tag: 'body' }, listeners: {} };
  doc.activeElement = doc.body;
  doc.addEventListener = (t, f) => { (doc.listeners[t] = doc.listeners[t] || []).push(f); };
  const mk = (id, extra = {}) => {
    const el = { id, hidden: false, children: [], attrs: {}, listeners: {}, parent: null, ...extra };
    el.addEventListener = (t, f) => { (el.listeners[t] = el.listeners[t] || []).push(f); };
    el.fire = (t, e = {}) => { const ev = { target: el, preventDefault() {}, stopPropagation() {}, ...e }; for (const f of el.listeners[t] || []) f(ev); if (t === 'focusout' && el.parent) el.parent.fire(t, { ...e, target: el }); return ev; };   // focusout bubbles
    el.setAttribute = (k, v) => { el.attrs[k] = v; };
    el.contains = (o) => { for (let n = o; n; n = n.parent) if (n === el) return true; return false; };
    el.focus = () => { const prev = doc.activeElement; doc.activeElement = el; if (prev && prev !== el && prev.fire) prev.fire('focusout', { relatedTarget: el }); };
    el.closest = (sel) => (sel === '[hidden]' ? (el.hidden ? el : null) : null);
    return el;
  };
  const add = (p, c) => { c.parent = p; p.children.push(c); return c; };
  const sheet = mk('plus-sheet', { hidden: true });
  const btn = mk('plus-btn');
  const attach = add(sheet, mk('attach-btn', { role: 'menuitem' }));
  const voiceBtn = add(sheet, mk('voice-settings-btn'));
  sheet.querySelectorAll = () => [attach, voiceBtn];
  const panel = mk('voice-panel', { hidden: true });
  const hiddenFirst = add(panel, mk('vp-hidden', { hidden: true }));
  const firstCtl = add(panel, mk('vp-mode-a'));
  const second = add(panel, mk('vp-speed'));
  panel.querySelectorAll = () => [hiddenFirst, firstCtl, second];
  const outside = mk('msg-input');
  const els = { 'plus-sheet': sheet, 'plus-btn': btn, 'voice-panel': panel, 'voice-settings-btn': voiceBtn, 'msg-input': outside };
  const src = cut('function plusSheetOpen()', 'function voiceStripPaint()') + cut('function voicePanelFocusFirst()', 'function voicePanelWire()');
  const rafs = [];
  const f = new Function('$', 'document', 'voicePanelOpen', 'voicePanelShow', 'requestAnimationFrame',
    src + '\nreturn { plusSheetWire, plusSheetShow, plusSheetOpen, voicePanelFocusFirst };')(
    (id) => els[id] || null, doc, () => !panel.hidden, (show) => { panel.hidden = !show; }, (fn) => rafs.push(fn));
  f.plusSheetWire();
  return { f, doc, sheet, btn, attach, voiceBtn, panel, firstCtl, outside, rafs };
}
const flush = () => new Promise((r) => setTimeout(r, 5));

test('wiring: the voice-settings click handler focuses the panel after it is shown (source)', () => {
  assert.match(js, /voicePanelShow\(open\);\s*\n\s*if \(open\) requestAnimationFrame\(voicePanelFocusFirst\)/);
});

test('choosing Voice settings: the first visible control of the panel gets focus', () => {
  const t = build();
  t.f.plusSheetShow(true);
  assert.equal(t.doc.activeElement, t.attach);
  t.f.plusSheetShow(false);          // the sheet's capture handler closes it, then the panel opens
  t.panel.hidden = false;
  t.doc.activeElement = t.doc.body;  // the focused item was hidden with the sheet
  t.f.voicePanelFocusFirst();
  assert.equal(t.doc.activeElement, t.firstCtl);   // skips the hidden control
});

test('voicePanelFocusFirst does nothing while the panel is hidden', () => {
  const t = build();
  t.f.voicePanelFocusFirst();
  assert.equal(t.doc.activeElement, t.doc.body);
});

test('focusout to an element outside the sheet closes it and resets aria-expanded', () => {
  const t = build();
  t.f.plusSheetShow(true);
  assert.equal(t.btn.attrs['aria-expanded'], 'true');
  t.outside.focus();   // Tab past the last item
  assert.equal(t.f.plusSheetOpen(), false);
  assert.equal(t.btn.attrs['aria-expanded'], 'false');
});

test('Shift+Tab from the first item back to the + button closes the sheet', () => {
  const t = build();
  t.f.plusSheetShow(true);
  t.sheet.fire('keydown', { key: 'Tab' });
  t.btn.focus();
  assert.equal(t.f.plusSheetOpen(), false);
  assert.equal(t.btn.attrs['aria-expanded'], 'false');
});

test('focusout to another sheet item keeps it open', () => {
  const t = build();
  t.f.plusSheetShow(true);
  t.voiceBtn.focus();
  assert.equal(t.f.plusSheetOpen(), true);
  assert.equal(t.btn.attrs['aria-expanded'], 'true');
});

test('focusout with relatedTarget null then focus landing inside stays open', async () => {
  const t = build();
  t.f.plusSheetShow(true);
  t.sheet.fire('focusout', { relatedTarget: null });
  t.doc.activeElement = t.voiceBtn;
  await flush();
  assert.equal(t.f.plusSheetOpen(), true);
});

test('focusout with relatedTarget null and focus on body (a tap) stays open; landing outside closes', async () => {
  const t = build();
  t.f.plusSheetShow(true);
  t.doc.activeElement = t.doc.body;
  t.sheet.fire('focusout', { relatedTarget: null });
  await flush();
  assert.equal(t.f.plusSheetOpen(), true);
  t.doc.activeElement = t.outside;
  t.sheet.fire('focusout', { relatedTarget: null });
  await flush();
  assert.equal(t.f.plusSheetOpen(), false);
  assert.equal(t.btn.attrs['aria-expanded'], 'false');
});
