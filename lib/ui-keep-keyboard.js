'use strict';
/**
 * ui-keep-keyboard.js — the phone page's message box and Chrome's spell-check menu (Android, Gboard). Tapping a
 * red-underlined word, or pressing Backspace while the menu for it is open, makes Chrome hide the soft keyboard while
 * the box keeps focus (the caret stays, the page still thinks the keyboard is up). Android only opens the keyboard
 * again on a new focus, so when the keyboard goes away right after a tap on the box or an edit in it, while the box is
 * still focused, the page blurs and refocuses the box with its selection kept. mobile.js carries a byte-identical copy
 * between the markers below; test/ui-keep-keyboard.test.js proves the copy matches and tests the behaviour here.
 *
 *   keyboardWentAway(base, now)       true when the visible page ({ w, h } in CSS px) got at least KBD_MIN_PX taller at
 *                                     the same width (a width change is a rotation, not a keyboard).
 *   shouldReopenKeyboard(s, now)      the decision from what the page recorded; pure.
 *   createKeepKeyboard({ now, viewport, reopen })
 *                                     returns { touch(chat), elsewhere(), sent(), escape(), hidden(), resized(ctx) }.
 *                                     The page reports taps and edits in the box and the things that end the guard;
 *                                     resized(ctx) runs on each visual viewport resize and calls reopen() at most once
 *                                     per tap or edit.
 */
// ── keep-keyboard helpers (begin) ──
const KEEP_KBD_MS = 1000;       // how long after a tap on the box a keyboard that goes away is brought back
const KEEP_KBD_EDIT_MS = 400;   // ... and after a key or an edit in it (shorter: Back pressed just after typing must stay a close)
const KBD_MIN_PX = 100;     // how much taller the visible page must get to count as the keyboard going away (more than the address bar or the suggestion strip)
function keyboardWentAway(base, now) {
  if (!base || !now || typeof base !== 'object' || typeof now !== 'object') return false;
  if (!Number.isFinite(base.w) || !Number.isFinite(base.h) || !Number.isFinite(now.w) || !Number.isFinite(now.h)) return false;
  return Math.abs(now.w - base.w) <= 2 && now.h - base.h >= KBD_MIN_PX;
}
function shouldReopenKeyboard(s, now) {
  if (!s) return false;
  const t = (v) => (Number.isFinite(v) ? v : 0);
  const touchAt = t(s.touchAt);
  if (touchAt <= 0 || !Number.isFinite(now)) return false;
  const age = now - touchAt;
  if (age < 0 || age > (s.touchKind === 'edit' ? KEEP_KBD_EDIT_MS : KEEP_KBD_MS)) return false;
  if (!s.focused || s.hidden || s.dialogOpen) return false;
  if (s.touchChat !== s.chat) return false;
  if (!keyboardWentAway(s.base, s.view)) return false;
  if (t(s.elsewhereAt) >= touchAt || t(s.sentAt) >= touchAt || t(s.escapeAt) >= touchAt || t(s.hiddenAt) >= touchAt) return false;
  return t(s.reopenedAt) < touchAt;   // once per tap or edit: a keyboard closed again with Back stays closed
}
function createKeepKeyboard({ now = () => Date.now(), viewport, reopen }) {
  // base is the visible page size at the tap or edit. While the keyboard is open that is the small height, so a later
  // growth of 100 px or more means it went away. A tap on the box while the keyboard is closed (the box is not focused,
  // the keyboard is about to open) records a base taken with the keyboard closed: the page then shrinks as the keyboard
  // opens and grows only back to that base, which is 0 px more, so it is not read as the keyboard going away.
  const s = { touchAt: 0, touchKind: 'tap', touchChat: null, chat: null, base: null, view: null, focused: false, elsewhereAt: 0, sentAt: 0, escapeAt: 0, hiddenAt: 0, reopenedAt: 0, hidden: false, dialogOpen: false };
  return {
    touch(chat, kind = 'tap') { s.touchAt = now(); s.touchKind = kind === 'edit' ? 'edit' : 'tap'; s.touchChat = chat; s.base = viewport(); },
    elsewhere() { s.elsewhereAt = now(); },
    sent() { s.sentAt = now(); },
    escape() { s.escapeAt = now(); },
    hidden() { s.hiddenAt = now(); },
    resized(ctx) {
      s.view = viewport();
      s.chat = ctx.chat; s.focused = !!ctx.focused; s.hidden = !!ctx.hidden; s.dialogOpen = !!ctx.dialogOpen;
      const at = now();
      if (!shouldReopenKeyboard(s, at)) return false;
      s.reopenedAt = at;
      reopen();
      return true;
    },
  };
}
// ── keep-keyboard helpers (end) ──

if (typeof module !== 'undefined' && module.exports) module.exports = { KEEP_KBD_MS, KEEP_KBD_EDIT_MS, KBD_MIN_PX, keyboardWentAway, shouldReopenKeyboard, createKeepKeyboard };
