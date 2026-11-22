/*
 * password-eye.js — a show/hide "eye" button inside every typed-password field.
 *
 * One helper for every page (login, Welcome, Users, Modules, the main page and the phone page). A field opts in with the
 * attribute `data-eye` on its <input type="password">; API-key / token / provider-secret fields do not carry it and
 * are never touched.
 *
 *   PasswordEye.attach(root = document)   add an eye to every input[data-eye] under root that has none yet
 *   PasswordEye.hideAll(root = document)  put every shown field under root back to type="password" (custom modals call
 *                                         this where they close)
 *   PasswordEye.watch()                   attach now, and to every field added later (dialogs built in script); once
 *
 * The input stays the same element in the same place (name, id, autocomplete untouched, password managers keep working).
 * The button is the input's next sibling, pulled over the input's right end with a negative margin, so the input keeps its
 * width and its row keeps its layout. A field goes back to hidden on its form's submit and reset, when its <dialog>
 * closes, through hideAll(), when the person presses any other button, on Enter in the field, and when the page is
 * hidden (pagehide, visibilitychange). A freshly created field always starts hidden.
 */
(function (global) {
  'use strict';

  var STYLE_ID = 'pw-eye-style';
  var LISTEN_FLAG = '__pwEyeListening';
  var EYE = '<svg class="pw-eye-icon pw-eye-icon-show" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF = '<svg class="pw-eye-icon pw-eye-icon-hide" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a19.8 19.8 0 0 1 5.06-5.94"/><path d="M9.9 4.24A10.9 10.9 0 0 1 12 5c7 0 11 7 11 7a19.9 19.9 0 0 1-3.17 4.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  var CSS = [
    'input[data-eye] { padding-right: 40px !important; }',
    'input[data-eye]::-ms-reveal, input[data-eye]::-ms-clear { display: none; }',
    '.pw-eye.pw-eye { all: unset; box-sizing: border-box; --pw-eye-w: 28px; width: var(--pw-eye-w); height: var(--pw-eye-w); min-width: var(--pw-eye-w); flex: 0 0 var(--pw-eye-w);',
    '  margin: -10px 0 -10px calc(-1 * var(--pw-eye-w) - var(--pw-eye-gap, 0px)); display: inline-flex; align-items: center; justify-content: center; align-self: center; vertical-align: middle;',
    '  position: relative; cursor: pointer; border-radius: 6px; color: var(--text-dim, var(--text-tertiary, currentColor)); -webkit-tap-highlight-color: transparent; }',
    '.pw-eye-wrap { position: relative; display: block; align-self: stretch; min-width: 0; }',
    '.pw-eye-wrap > input[data-eye] { display: block; width: 100%; max-width: none; min-width: 0; margin: 0; box-sizing: border-box; }',
    '.pw-eye.pw-eye.pw-eye-float { position: absolute; right: 4px; top: 50%; margin: 0; transform: translateY(-50%); }',
    '.pw-eye.pw-eye:hover { color: var(--text, currentColor); }',
    '.pw-eye.pw-eye:focus-visible { outline: 2px solid var(--accent, currentColor); outline-offset: -2px; }',
    '.pw-eye.pw-eye[aria-pressed="true"] { color: var(--accent, currentColor); }',
    '@media (max-width: 800px), (pointer: coarse) { input[data-eye] { padding-right: 44px !important; } .pw-eye.pw-eye { --pw-eye-w: 36px; } }',
  ].join('\n');

  var buttons = typeof WeakMap === 'function' ? new WeakMap() : null;   // input -> its eye button
  var observing = false;

  function doc() { return global.document || (typeof document !== 'undefined' ? document : null); }

  function ensureStyle(d) {
    if (!d || !d.head || !d.createElement) return;
    if (d.getElementById && d.getElementById(STYLE_ID)) return;
    var st = d.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    d.head.appendChild(st);
  }

  function eyeOf(input) {
    if (buttons) return buttons.get(input) || null;
    return input.__pwEyeBtn || null;
  }
  function setEye(input, btn) {
    if (buttons) buttons.set(input, btn); else input.__pwEyeBtn = btn;
  }

  function paint(btn, shown) {
    btn.setAttribute('aria-label', shown ? 'Hide password' : 'Show password');
    btn.setAttribute('aria-pressed', shown ? 'true' : 'false');
    btn.innerHTML = shown ? EYE_OFF : EYE;
  }

  function setShown(input, shown) {
    var btn = eyeOf(input);
    var d = doc();
    var hadFocus = !!d && d.activeElement === input;
    var start = null, end = null, dir = null;
    if (hadFocus) { try { start = input.selectionStart; end = input.selectionEnd; dir = input.selectionDirection; } catch (e) { /* some types refuse */ } }
    input.type = shown ? 'text' : 'password';
    if (btn) paint(btn, shown);
    if (hadFocus) {
      try { input.focus({ preventScroll: true }); } catch (e) { try { input.focus(); } catch (e2) { /* ignore */ } }
      if (start !== null) { try { input.setSelectionRange(start, end, dir || undefined); } catch (e) { /* ignore */ } }
    }
  }

  function isShown(input) { return input.type === 'text'; }

  function hideAll(root) {
    var r = root || doc();
    if (!r) return;
    var list = [];
    if (r.querySelectorAll) list = Array.prototype.slice.call(r.querySelectorAll('input[data-eye]'));
    if (r.getAttribute && r.getAttribute('data-eye') !== null && r.getAttribute('data-eye') !== undefined && r.tagName && String(r.tagName).toLowerCase() === 'input') list.push(r);
    for (var i = 0; i < list.length; i++) if (isShown(list[i])) setShown(list[i], false);
  }

  // How the page lays the input out decides how the eye sits over it. In a row (flex row, inline flow) the eye follows
  // the input with a negative margin and takes no room. When the input is a block of its own (a column flex or grid
  // parent, or display:block) a following inline button would land on the next line, so the input goes into a small
  // positioned wrapper and the eye floats over its right end. { stacked, gap }.
  function layoutOf(input) {
    var out = { stacked: false, gap: 0 };
    try {
      if (typeof global.getComputedStyle !== 'function' || !input.parentNode) return out;
      var pcs = global.getComputedStyle(input.parentNode);
      var pd = pcs.display || '';
      // The parent decides first: a flex or grid item's own computed display is always blockified, so it says nothing.
      if (/grid/.test(pd)) out.stacked = true;
      else if (/flex/.test(pd)) {
        if (/^column/.test(pcs.flexDirection || '')) out.stacked = true;
        else { var g = parseFloat(pcs.columnGap); out.gap = isFinite(g) && g > 0 ? g : 0; }   // a row: never wrapped
      } else if ((global.getComputedStyle(input).display || '') === 'block') out.stacked = true;
    } catch (e) { /* no layout information: the row form */ }
    return out;
  }

  // A wrapped input hands its sizing in the parent to the wrapper (the wrapper is the item the parent lays out); the input
  // then fills the wrapper.
  function carrySizing(input, wrap) {
    if (!wrap.style || !wrap.style.setProperty) return;
    try {
      var cs = global.getComputedStyle(input);
      var put = function (prop, v) { if (v !== undefined && v !== null && v !== '') wrap.style.setProperty(prop, String(v)); };
      if (cs.flexGrow !== undefined && cs.flexGrow !== '' && cs.flexShrink !== undefined && cs.flexShrink !== '' && cs.flexBasis) {
        put('flex', cs.flexGrow + ' ' + cs.flexShrink + ' ' + cs.flexBasis);
      }
      if (input.style && input.style.width) put('width', input.style.width);
      if (cs.maxWidth && cs.maxWidth !== 'none') put('max-width', cs.maxWidth);
      if (cs.minWidth && cs.minWidth !== 'auto') put('min-width', cs.minWidth);
      var margin = cs.margin || (cs.marginTop !== undefined ? [cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft].join(' ') : '');
      if (margin && !/^(0(px)?\s*)+$/.test(margin)) {
        put('margin', margin);
        // the wrapper now carries the margin: an inline margin on the input would double the gap
        var st = input.style;
        if (st && (st.margin || st.marginTop || st.marginRight || st.marginBottom || st.marginLeft)) st.margin = '0';
      }
      if (cs.gridColumn && cs.gridColumn !== 'auto' && cs.gridColumn !== 'auto / auto') put('grid-column', cs.gridColumn);
      if (cs.gridRow && cs.gridRow !== 'auto' && cs.gridRow !== 'auto / auto') put('grid-row', cs.gridRow);
    } catch (e) { /* no layout information: the wrapper keeps its stylesheet sizing */ }
  }

  function attachOne(input) {
    var d = doc();
    if (!d || eyeOf(input) || !input.parentNode) return;
    var next = input.nextSibling;
    if (next && next.className && String(next.className).split(/\s+/).indexOf('pw-eye') >= 0) { setEye(input, next); return; }
    if (input.type !== 'password') input.type = 'password';   // a field that is new on the page always starts hidden
    // A shown field is type text: keep spell checkers (the browser's cloud spelling, grammar add-ons) and the phone
    // keyboard's autocorrect and suggestions from reading or learning the password.
    if (input.setAttribute) {
      input.setAttribute('spellcheck', 'false');
      input.setAttribute('autocorrect', 'off');
      input.setAttribute('autocapitalize', 'off');
      input.setAttribute('data-gramm', 'false');
      input.setAttribute('data-gramm_editor', 'false');
      input.setAttribute('data-enable-grammarly', 'false');
    }
    var btn = d.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-eye';
    btn.setAttribute('type', 'button');
    paint(btn, false);
    var lay = layoutOf(input);
    if (lay.gap && btn.style) btn.style.setProperty('--pw-eye-gap', lay.gap + 'px');
    // The input keeps focus (and the phone keyboard stays open) when the eye is pressed.
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    btn.addEventListener('pointerdown', function (e) { e.preventDefault(); });
    btn.addEventListener('click', function (e) {
      if (e && e.preventDefault) e.preventDefault();
      setShown(input, !isShown(input));
    });
    setEye(input, btn);
    if (lay.stacked) {
      // Moving a focused input blurs it (and closes the phone keyboard): put focus, caret and selection back.
      var focused = d.activeElement === input, s0 = null, s1 = null, sd = null;
      if (focused) { try { s0 = input.selectionStart; s1 = input.selectionEnd; sd = input.selectionDirection; } catch (e) { /* ignore */ } }
      var wrap = d.createElement('span');
      wrap.className = 'pw-eye-wrap';
      carrySizing(input, wrap);
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
      wrap.appendChild(btn);
      btn.className = 'pw-eye pw-eye-float';
      if (focused && d.activeElement !== input) {
        try { input.focus({ preventScroll: true }); } catch (e) { try { input.focus(); } catch (e2) { /* ignore */ } }
        if (s0 !== null) { try { input.setSelectionRange(s0, s1, sd || undefined); } catch (e) { /* ignore */ } }
      }
    } else {
      input.parentNode.insertBefore(btn, input.nextSibling);
    }
  }

  function listen(d) {
    if (!d || d[LISTEN_FLAG] || !d.addEventListener) return;
    d[LISTEN_FLAG] = true;
    // Capture phase: runs before the page's own handler, and the value is the same either way.
    d.addEventListener('submit', function (e) { hideAll(e && e.target); }, true);
    d.addEventListener('reset', function (e) { hideAll(e && e.target); }, true);
    d.addEventListener('close', function (e) { hideAll(e && e.target); }, true);   // <dialog> close does not bubble
    // Button-driven pages (no <form>): any other button the person presses hides every shown field first. The values stay,
    // so the page's own handler reads the same text.
    d.addEventListener('click', function (e) {
      var el = e && e.target;
      while (el && el.nodeType !== 9) {
        var tag = String(el.tagName || '').toLowerCase();
        var cls = el.className && typeof el.className === 'string' ? el.className : '';
        if (/(^|\s)pw-eye(\s|$)/.test(cls)) return;
        var role = el.getAttribute ? el.getAttribute('role') : null;
        var ty = String(el.type || (el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
        if (tag === 'button' || role === 'button' || (tag === 'input' && (ty === 'submit' || ty === 'button'))) { hideAll(d); return; }
        el = el.parentNode;
      }
    }, true);
    d.addEventListener('keydown', function (e) {
      var t = e && e.target;
      if (e && e.key === 'Enter' && t && String(t.tagName || '').toLowerCase() === 'input' && t.getAttribute && t.getAttribute('data-eye') !== null && isShown(t)) setShown(t, false);
    }, true);
    d.addEventListener('pagehide', function () { hideAll(d); }, true);
    d.addEventListener('visibilitychange', function () { if (d.visibilityState === 'hidden') hideAll(d); }, true);
    if (global !== d && typeof global.addEventListener === 'function') global.addEventListener('pagehide', function () { hideAll(d); }, true);
  }

  function attach(root) {
    var d = doc();
    var r = root || d;
    if (!d || !r) return;
    ensureStyle(d);
    listen(d);
    var list = r.querySelectorAll ? Array.prototype.slice.call(r.querySelectorAll('input[data-eye]')) : [];
    if (r.tagName && String(r.tagName).toLowerCase() === 'input' && r.getAttribute && r.getAttribute('data-eye') !== null) list.push(r);
    for (var i = 0; i < list.length; i++) attachOne(list[i]);
  }

  function watch() {
    var d = doc();
    if (!d) return;
    attach(d);
    if (observing || typeof global.MutationObserver !== 'function') return;
    observing = true;
    var mo = new global.MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes || [];
        for (var j = 0; j < added.length; j++) if (added[j].nodeType === 1) attach(added[j]);
      }
    });
    mo.observe(d.documentElement || d, { childList: true, subtree: true });
  }

  var api = { attach: attach, hideAll: hideAll, watch: watch, _css: CSS };
  global.PasswordEye = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
