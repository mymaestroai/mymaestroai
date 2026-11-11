'use strict';
// The phone page's message box and Chrome's spell-check menu (2026-11): a tap on an underlined word, or Backspace with
// the menu open, makes Chrome hide the soft keyboard while the box keeps focus. The page blurs and refocuses the box
// when the keyboard goes away right after a tap or an edit, once per tap or edit, and never after a send, Escape, a tap
// elsewhere, the page going hidden, a dialog or a rotation.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { keyboardWentAway, shouldReopenKeyboard, createKeepKeyboard } = require('../lib/ui-keep-keyboard');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const BEGIN = '// ── keep-keyboard helpers (begin) ──';
const END = '// ── keep-keyboard helpers (end) ──';
function helperBlock(src, indent) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  assert.ok(a > 0 && b > a, 'helper markers present');
  return src.slice(a + BEGIN.length, b).split('\n').map(l => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n').trim();
}

test('the keep-keyboard helpers are byte-identical in lib/ui-keep-keyboard.js and mobile.js', () => {
  assert.strictEqual(helperBlock(read('mobile.js'), ''), helperBlock(read('lib/ui-keep-keyboard.js'), ''), 'mobile.js copy differs from lib/ui-keep-keyboard.js');
});

test('keyboardWentAway: 100 px taller at the same width', () => {
  const base = { w: 400, h: 500 };
  assert.strictEqual(keyboardWentAway(base, { w: 400, h: 600 }), true);
  assert.strictEqual(keyboardWentAway(base, { w: 400, h: 599 }), false);
  assert.strictEqual(keyboardWentAway(base, { w: 403, h: 820 }), false, 'a width change of 3 is a rotation');
  assert.strictEqual(keyboardWentAway(base, { w: 402, h: 820 }), true, 'a width change of 2 is not');
  assert.strictEqual(keyboardWentAway(base, { w: 398, h: 820 }), true);
  assert.strictEqual(keyboardWentAway(null, { w: 400, h: 820 }), false);
  assert.strictEqual(keyboardWentAway(base, null), false);
  assert.strictEqual(keyboardWentAway(base, { w: NaN, h: 820 }), false);
  assert.strictEqual(keyboardWentAway({ w: 400, h: NaN }, { w: 400, h: 820 }), false);
  assert.strictEqual(keyboardWentAway(base, { w: 400, h: 300 }), false, 'a shrinking page is the keyboard opening');
});

const state = (o = {}) => ({
  touchAt: 1000, touchChat: 'sam', chat: 'sam', base: { w: 400, h: 520 }, view: { w: 400, h: 820 },
  focused: true, elsewhereAt: 0, sentAt: 0, escapeAt: 0, hiddenAt: 0, reopenedAt: 0, hidden: false, dialogOpen: false, ...o,
});

test('shouldReopenKeyboard: the base case, and each thing that stops it', () => {
  assert.strictEqual(shouldReopenKeyboard(state(), 1400), true);
  assert.strictEqual(shouldReopenKeyboard(state(), 2000), true, 'exactly one second after');
  assert.strictEqual(shouldReopenKeyboard(state(), 2001), false, 'too long after the tap');
  assert.strictEqual(shouldReopenKeyboard(state({ touchAt: 0 }), 1400), false);
  assert.strictEqual(shouldReopenKeyboard(state({ focused: false }), 1400), false);
  assert.strictEqual(shouldReopenKeyboard(state({ hidden: true }), 1400), false);
  assert.strictEqual(shouldReopenKeyboard(state({ dialogOpen: true }), 1400), false);
  assert.strictEqual(shouldReopenKeyboard(state({ chat: 'other' }), 1400), false);
  assert.strictEqual(shouldReopenKeyboard(state({ view: { w: 400, h: 619 } }), 1400), false);
  assert.strictEqual(shouldReopenKeyboard(state({ view: { w: 400, h: 620 } }), 1400), true);
  assert.strictEqual(shouldReopenKeyboard(state({ view: { w: 700, h: 820 } }), 1400), false);
  assert.strictEqual(shouldReopenKeyboard(null, 1400), false);
});

test('shouldReopenKeyboard: a tap elsewhere, a send, Escape or the page going hidden at or after the tap stops it', () => {
  for (const k of ['elsewhereAt', 'sentAt', 'escapeAt', 'hiddenAt']) {
    assert.strictEqual(shouldReopenKeyboard(state({ [k]: 1000 }), 1400), false, `${k} equal to the tap`);
    assert.strictEqual(shouldReopenKeyboard(state({ [k]: 1200 }), 1400), false, `${k} after the tap`);
    assert.strictEqual(shouldReopenKeyboard(state({ [k]: 999 }), 1400), true, `${k} before the tap does not`);
  }
});

test('shouldReopenKeyboard: once per tap or edit; a new tap or edit allows it again', () => {
  assert.strictEqual(shouldReopenKeyboard(state({ reopenedAt: 1400 }), 1500), false);
  assert.strictEqual(shouldReopenKeyboard(state({ reopenedAt: 1000 }), 1500), false);
  assert.strictEqual(shouldReopenKeyboard(state({ reopenedAt: 1400, touchAt: 1600 }), 1900), true);
});

test('shouldReopenKeyboard: a clock that went backwards, and missing or odd fields', () => {
  assert.strictEqual(shouldReopenKeyboard(state(), 999), false);
  assert.strictEqual(shouldReopenKeyboard(state(), NaN), false);
  const bare = { touchAt: 1000, touchChat: 'sam', chat: 'sam', base: { w: 400, h: 520 }, view: { w: 400, h: 820 }, focused: true };
  assert.strictEqual(shouldReopenKeyboard(bare, 1400), true, 'missing timestamps count as 0');
  assert.strictEqual(shouldReopenKeyboard({ ...bare, elsewhereAt: NaN, sentAt: 'x', escapeAt: undefined, hiddenAt: null, reopenedAt: NaN }, 1400), true);
  assert.strictEqual(shouldReopenKeyboard({ ...bare, touchAt: NaN }, 1400), false);
});

function rig() {
  const r = { clock: 1000, view: { w: 400, h: 500 }, reopens: 0 };
  r.k = createKeepKeyboard({ now: () => r.clock, viewport: () => ({ ...r.view }), reopen: () => { r.reopens++; } });
  r.ctx = (o = {}) => ({ chat: 'sam', focused: true, hidden: false, dialogOpen: false, ...o });
  return r;
}

test('createKeepKeyboard: a keyboard that goes away after a tap is brought back once per tap', () => {
  const r = rig();
  r.k.touch('sam');                                  // keyboard open: base h 500
  r.clock = 1150; r.view = { w: 400, h: 560 };
  assert.strictEqual(r.k.resized(r.ctx()), false, 'the animation has not got far enough yet');
  r.clock = 1300; r.view = { w: 400, h: 820 };
  assert.strictEqual(r.k.resized(r.ctx()), true);
  assert.strictEqual(r.reopens, 1);
  r.clock = 1320;
  assert.strictEqual(r.k.resized(r.ctx()), false, 'the rest of the same animation does not reopen again');
  // the reopened keyboard is closed with Back, without a new tap or edit: it stays closed
  r.clock = 1500; r.view = { w: 400, h: 500 };
  assert.strictEqual(r.k.resized(r.ctx()), false);
  r.clock = 1700; r.view = { w: 400, h: 820 };
  assert.strictEqual(r.k.resized(r.ctx()), false);
  assert.strictEqual(r.reopens, 1);
  // a new edit makes it work once more
  r.clock = 2000; r.view = { w: 400, h: 500 }; r.k.touch('sam');
  r.clock = 2200; r.view = { w: 400, h: 820 };
  assert.strictEqual(r.k.resized(r.ctx()), true);
  assert.strictEqual(r.reopens, 2);
});

test('createKeepKeyboard: a send, Escape, a tap elsewhere or the page going hidden after the tap blocks it', () => {
  for (const ev of ['elsewhere', 'sent', 'escape', 'hidden']) {
    const r = rig();
    r.k.touch('sam');
    r.clock = 1100; r.k[ev]();
    r.clock = 1300; r.view = { w: 400, h: 820 };
    assert.strictEqual(r.k.resized(r.ctx()), false, ev);
    assert.strictEqual(r.reopens, 0, ev);
  }
  const r = rig();                                     // an event before the tap does not block
  r.k.elsewhere(); r.clock = 1100; r.k.touch('sam');
  r.clock = 1300; r.view = { w: 400, h: 820 };
  assert.strictEqual(r.k.resized(r.ctx()), true);
});

test('createKeepKeyboard: not when the box lost focus, the page is hidden, a dialog is open or the chat changed', () => {
  for (const o of [{ focused: false }, { hidden: true }, { dialogOpen: true }, { chat: 'other' }]) {
    const r = rig();
    r.k.touch('sam');
    r.clock = 1300; r.view = { w: 400, h: 820 };
    assert.strictEqual(r.k.resized(r.ctx(o)), false, JSON.stringify(o));
  }
});

test('createKeepKeyboard: a tap made while the keyboard is closed, then it opening and closing, is not a keyboard that went away', () => {
  const r = rig();
  r.view = { w: 400, h: 820 };                         // keyboard closed: the base is the tall page
  r.k.touch('sam');
  r.clock = 1200; r.view = { w: 400, h: 500 };         // the keyboard opens
  assert.strictEqual(r.k.resized(r.ctx()), false);
  r.clock = 1700; r.view = { w: 400, h: 820 };         // and closes again: grew only back to the base
  assert.strictEqual(r.k.resized(r.ctx()), false);
  assert.strictEqual(r.reopens, 0);
});

test('a key or an edit arms the guard for 400 ms only, a tap for 1000 ms (Back pressed just after typing stays a close)', () => {
  const s = (o) => ({ touchAt: 1000, touchChat: 'sam', chat: 'sam', base: { w: 400, h: 520 }, view: { w: 400, h: 820 }, focused: true, ...o });
  assert.strictEqual(shouldReopenKeyboard(s({ touchKind: 'edit' }), 1400), true);
  assert.strictEqual(shouldReopenKeyboard(s({ touchKind: 'edit' }), 1401), false);
  assert.strictEqual(shouldReopenKeyboard(s({ touchKind: 'tap' }), 2000), true);
  assert.strictEqual(shouldReopenKeyboard(s({}), 2000), true, 'no kind counts as a tap');
  const r = rig();
  r.k.touch('sam', 'edit');                            // typing, then Back 600 ms later
  r.clock = 1600; r.view = { w: 400, h: 820 };
  assert.strictEqual(r.k.resized(r.ctx()), false);
  r.clock = 2000; r.view = { w: 400, h: 500 }; r.k.touch('sam', 'edit');   // Backspace with the menu open: hides at once
  r.clock = 2250; r.view = { w: 400, h: 820 };
  assert.strictEqual(r.k.resized(r.ctx()), true);
});

test('mobile.js wires the guard to the message box, the document and the viewport', () => {
  const m = read('mobile.js');
  assert.match(m, /^let keepKeyboard = null;/m);
  assert.match(m, /keepKeyboard = createKeepKeyboard\(\{ viewport: viewSize, reopen: /);
  assert.match(m, /const viewSize = \(\) => \(vv \? \{ w: vv\.width, h: vv\.height \} : \{ w: window\.innerWidth, h: window\.innerHeight \}\);/);
  assert.match(m, /input\.addEventListener\('pointerdown', \(\) => keepKeyboard\.touch\(current\)\);/);
  assert.match(m, /input\.addEventListener\('keydown', \(e\) => \{ if \(e\.key === 'Escape'\) keepKeyboard\.escape\(\); else keepKeyboard\.touch\(current, 'edit'\); \}\);/);
  assert.match(m, /input\.addEventListener\('beforeinput', \(\) => keepKeyboard\.touch\(current, 'edit'\)\);/);
  assert.match(m, /input\.addEventListener\('input', \(\) => keepKeyboard\.touch\(current, 'edit'\)\);/);
  assert.match(m, /document\.addEventListener\('pointerdown', \(e\) => \{[^}]*keepKeyboard\.elsewhere\(\);[^}]*\}, \{ capture: true, passive: true \}\);/);
  assert.match(m, /document\.addEventListener\('visibilitychange', \(\) => \{ if \(document\.hidden\) keepKeyboard\.hidden\(\); \}\);/);
  assert.match(m, /const onView = \(\) => keepKeyboard\.resized\(\{[^]*?\}\);\n\s*if \(vv\) vv\.addEventListener\('resize', onView\); else window\.addEventListener\('resize', onView\);/);
  assert.match(m, /dialog\[open\], \.rsn-sheet\.open, \[role="dialog"\]\.open/);
  const send = m.slice(m.indexOf('function sendAndClose() {'));
  const body = send.slice(0, send.indexOf('\n}\n'));
  assert.ok(body.indexOf('keepKeyboard && keepKeyboard.sent();') > 0 && body.indexOf('keepKeyboard && keepKeyboard.sent();') < body.indexOf('sendMessage();'), 'sent() comes before sendMessage()');
  assert.match(m, /input\.blur\(\); input\.focus\(\{ preventScroll: true \}\); try \{ input\.setSelectionRange\(s, e, d \|\| 'none'\); \}/);
});
