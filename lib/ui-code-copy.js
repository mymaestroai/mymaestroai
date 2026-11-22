'use strict';
/**
 * ui-code-copy.js — a copy button on every code box in a chat message (served as /ui-code-copy.js; index.html and
 * mobile.html load it before app.js / mobile.js; Node tests load it with fakes).
 *
 *   CodeCopy.blockHtml(innerHtml)  the box: <div class="code-box"><button class="code-copy">…</button><pre><code>…</code></pre></div>
 *   CodeCopy.wrap(preEl)           the same box around a <pre> built with DOM calls (idempotent)
 *   CodeCopy.copy(text)            Promise<boolean>; the clipboard API, else a hidden textarea; never throws
 *
 * One delegated click listener on the document copies the box's code text as it is AT THE CLICK (a streamed reply copies
 * what is there; the text is the source byte for byte, the browser normalising line endings to LF), shows Copied (or Could not copy), and stops the click so the whole-message copy does not also fire.
 * The button holds no text nodes (only SVG), so it adds nothing to a message's innerText / textContent.
 */
(function () {
  const ICON = '<svg class="cc-ico cc-ico-copy" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>' +
    '<svg class="cc-ico cc-ico-tick" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>';
  const BUTTON = '<button type="button" class="code-copy" aria-label="Copy" title="Copy">' + ICON + '</button>';

  /** innerHtml is already-escaped HTML supplied by the page. */
  function blockHtml(innerHtml) {
    return '<div class="code-box">' + BUTTON + '<pre><code>' + innerHtml + '</code></pre></div>';
  }

  /** Wrap a <pre> built with DOM calls. Does nothing if it is already in a box or already has its button. */
  function wrap(pre, doc) {
    try {
      const d = doc || (typeof document !== 'undefined' ? document : null);
      if (!pre || !pre.parentNode || !d) return pre;
      if (pre.closest && pre.closest('.code-box')) return pre;
      if (pre.parentNode.querySelector && pre.parentNode.querySelector(':scope > .code-copy')) return pre;
      const box = d.createElement('div');
      box.className = 'code-box';
      const tpl = d.createElement('div');
      tpl.innerHTML = BUTTON;
      pre.parentNode.insertBefore(box, pre);
      box.appendChild(tpl.firstChild);
      box.appendChild(pre);
    } catch { /* never break the page for a button */ }
    return pre;
  }

  /** The hidden-textarea method (http:// origins have no navigator.clipboard). */
  function legacyCopy(text, env) {
    const doc = env.document;
    if (!doc || !doc.body || !doc.createElement) return false;
    let ta = null, ok = false;
    // The textarea's select() replaces the page's selection and focus: keep both and put them back afterwards.
    let prevFocus = null, prevRanges = [], sel = null;
    try {
      prevFocus = doc.activeElement || null;
      const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
      sel = win && win.getSelection ? win.getSelection() : null;
      if (sel) for (let i = 0; i < sel.rangeCount; i++) prevRanges.push(sel.getRangeAt(i));
    } catch { /* ignore */ }
    try {
      ta = doc.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '-9999px';
      ta.style.opacity = '0';
      // Inside an open modal dialog if there is one: everything outside it is inert and cannot be selected.
      let host = null;
      try { host = doc.querySelector && doc.querySelector('dialog:modal'); } catch { /* a browser without :modal */ }
      (host || doc.body).appendChild(ta);
      ta.select();
      ok = !!doc.execCommand('copy');
    } catch { ok = false; }
    try { if (ta && ta.parentNode) ta.parentNode.removeChild(ta); } catch { /* ignore */ }
    try {
      if (sel && prevRanges.length) {
        if (sel.removeAllRanges) sel.removeAllRanges();
        for (const r of prevRanges) sel.addRange(r);
      }
    } catch { /* ignore */ }
    try { if (prevFocus && prevFocus !== doc.body && typeof prevFocus.focus === 'function') prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
    return ok;
  }

  /** Promise<boolean>. env = { navigator, document, isSecureContext } (the page's own by default). */
  function copy(text, env) {
    const e = env || {
      navigator: typeof navigator !== 'undefined' ? navigator : null,
      document: typeof document !== 'undefined' ? document : null,
      isSecureContext: typeof window !== 'undefined' ? window.isSecureContext : false,
    };
    const str = String(text == null ? '' : text);
    const viaTextarea = () => { try { return legacyCopy(str, e); } catch { return false; } };
    try {
      if (e.navigator && e.navigator.clipboard && typeof e.navigator.clipboard.writeText === 'function' && e.isSecureContext !== false) {
        return Promise.resolve(e.navigator.clipboard.writeText(str)).then(() => true, () => viaTextarea());
      }
    } catch { /* fall through to the textarea */ }
    return Promise.resolve(viaTextarea());
  }

  /** The click handler. env = { document, copy, setTimeout, clearTimeout } so tests can pass fakes. */
  function makeClickHandler(env) {
    const e = env || {};
    const doc = () => e.document || document;
    const doCopy = e.copy || copy;
    const setT = e.setTimeout || ((f, ms) => setTimeout(f, ms));
    const clearT = e.clearTimeout || ((t) => clearTimeout(t));
    const timers = new WeakMap();
    const now = e.now || (() => Date.now());
    let live = null, liveTimer = null;
    function announce(msg) {
      try {
        const d = doc();
        // Inside the open modal dialog when there is one (the rest of the page is inert), else the body.
        let host = null;
        try { host = d.querySelector && d.querySelector('dialog:modal'); } catch { /* a browser without :modal */ }
        host = host || d.body;
        if (!live) {
          live = d.createElement('span');
          live.className = 'code-copy-live';
          live.setAttribute('aria-live', 'polite');
          live.setAttribute('role', 'status');
        }
        if (!live.isConnected || live.parentNode !== host) host.appendChild(live);
        // Empty first, then the text a moment later: the same words again ("Copied" twice) are announced again.
        live.textContent = '';
        if (liveTimer) clearT(liveTimer);
        const el = live;
        liveTimer = setT(() => { liveTimer = null; el.textContent = msg; }, 60);
      } catch { /* ignore */ }
    }
    const MO = e.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    // Where a button is: its message (or the body) and its position among that message's code buttons.
    function locate(b) {
      const host = (b.closest && (b.closest('.message, .msg'))) || (b.ownerDocument && b.ownerDocument.body) || doc().body;
      const list = host && host.querySelectorAll ? Array.from(host.querySelectorAll('.code-copy')) : [];
      return { host, index: list.indexOf(b) };
    }
    function buttonAt(host, index) {
      try { return (host && host.querySelectorAll && index >= 0 && host.querySelectorAll('.code-copy')[index]) || null; } catch { return null; }
    }
    function paint(btn, state) {
      btn.classList.remove('copied', 'copy-failed');
      let label = 'Copy';
      if (state === 'copied') { btn.classList.add('copied'); label = 'Copied'; }
      else if (state === 'failed') { btn.classList.add('copy-failed'); label = 'Could not copy'; }
      btn.setAttribute('aria-label', label);
      btn.title = label;
    }
    // A streamed reply rebuilds the message HTML on every chunk, which wipes the state set on the clicked button. For the
    // state's duration a MutationObserver on the message paints it again on the button at the same position after each redraw.
    let keep = null;   // { btn, host, index, state, until, obs }
    // The button that currently shows a kept state: the replacement the observer painted, else the original.
    function resetKept(k) {
      try {
        const b = buttonAt(k.host, k.index) || k.btn;
        if (b) paint(b, 'idle');
        if (k.btn && k.btn !== b) paint(k.btn, 'idle');
      } catch { /* ignore */ }
    }
    // reset=true: the state is cut short by a new copy, so the earlier box's painted button goes back to idle right now.
    function stopKeep(reset) {
      const k = keep; keep = null;
      try { if (k && k.obs) k.obs.disconnect(); } catch { /* ignore */ }
      if (k && reset) resetKept(k);
    }
    function reapply() {
      try {
        const k = keep;
        if (!k) return;
        if (now() >= k.until) { stopKeep(); return; }
        const b = buttonAt(k.host, k.index);
        if (b) paint(b, k.state);
      } catch { /* ignore */ }
    }
    function startKeep(btn, loc, state, ms) {
      try {
        if (!loc || !loc.host || !(loc.index >= 0) || !MO) return;
        const obs = new MO(reapply);
        obs.observe(loc.host, { childList: true, subtree: true });
        keep = { btn, host: loc.host, index: loc.index, state, until: now() + ms, obs };
        if (btn.isConnected === false) reapply();   // the box was redrawn while the copy was running
      } catch { /* never break the page for a tick */ }
    }
    function setState(btn, state, loc) {
      const prev = timers.get(btn);
      if (prev) clearT(prev);
      if (state !== 'idle') stopKeep(true);
      paint(btn, state);
      const ms = state === 'copied' ? 1500 : state === 'failed' ? 2000 : 0;
      if (state !== 'idle') announce(state === 'copied' ? 'Copied' : 'Could not copy');
      if (ms) startKeep(btn, loc, state, ms);
      const mine = ms && keep && keep.btn === btn ? keep : null;   // this state's own watch
      if (ms) timers.set(btn, setT(() => {
        timers.delete(btn);
        setState(btn, 'idle');
        if (!mine) return;
        if (keep === mine) { stopKeep(true); return; }
        // A later copy took over: reset whichever button still shows this box's state, unless that spot is the later copy's now.
        if (keep && keep.host === mine.host && keep.index === mine.index) return;
        resetKept(mine);
      }, ms));
    }
    // A streamed reply rebuilds the message HTML on every chunk, so a press can end on a rebuilt node: the click's target is
    // then not inside a .code-copy. The press (pointerdown) is remembered by button + message + position; the click uses
    // it only when that very button was replaced since.
    let press = null;
    let up = null;   // the release (pointerup) of the same gesture: on which .code-copy it ended (null: elsewhere), and with which pointer
    function onPointerDown(ev) {
      up = null;   // a new gesture starts: the last release belongs to the one before
      try {
        const t = ev && ev.target;
        const b = t && t.closest ? t.closest('.code-copy') : null;
        if (!b) { press = null; return; }
        const loc = locate(b);
        press = { btn: b, host: loc.host, index: loc.index, t: now(), pointerId: ev.pointerId };
      } catch { press = null; }
    }
    // The release (pointerup) of the same gesture: on which .code-copy it ended (null: elsewhere).
    // (Declared above onPointerDown's first use at run time: both are only called after makeClickHandler returns.)
    function onPointerUp(ev) {
      try {
        const t = ev && ev.target;
        up = { btn: t && t.closest ? t.closest('.code-copy') : null, t: now(), pointerId: ev.pointerId };
      } catch { up = null; }
    }
    function onPointerCancel() { press = null; up = null; }
    function onClick(ev) {
      const t = ev && ev.target;
      let btn = t && t.closest ? t.closest('.code-copy') : null;
      const rec = press, rel = up; press = null; up = null;
      let loc = null;
      // Strict redraw fallback: the click is not on a button. It counts only when the press was on a button that has since been
      // replaced AND the release of the same gesture was on the replacement at the same position in the same message.
      if (!btn && rec && rec.btn && !rec.btn.isConnected && rec.index >= 0 && now() - rec.t < 1500 && rec.host && rec.host.isConnected &&
          rel && rel.btn && rel.t >= rec.t && now() - rel.t < 1500 && rel.btn.isConnected &&
          rel.pointerId === rec.pointerId) {
        try {
          const l = locate(rel.btn);
          if (l.host === rec.host && l.index === rec.index) { btn = rel.btn; loc = l; }
        } catch { /* no copy */ }
      }
      if (!btn) return undefined;
      if (!loc) { try { loc = locate(btn); } catch { loc = null; } }
      ev.preventDefault();   // (no stopPropagation: other document listeners close menus on an outside click)
      stopKeep(true);   // a new click ends the previous tick's watch; that box's painted button goes back to Copy
      const box = btn.closest('.code-box');
      const code = box && (box.querySelector('pre code') || box.querySelector('pre'));   // (a wrapped DOM <pre> has no <code>)
      const text = code ? code.textContent : '';   // read now: a streamed reply copies what is there at the click
      let p;
      try { p = Promise.resolve(doCopy(text)); } catch { p = Promise.resolve(false); }
      return p.catch(() => false).then((ok) => { setState(btn, ok ? 'copied' : 'failed', loc); return ok; });
    }
    onClick.pointerDown = onPointerDown;
    onClick.pointerUp = onPointerUp;
    onClick.pointerCancel = onPointerCancel;
    return onClick;
  }

  const api = { blockHtml, wrap, copy, makeClickHandler, ICON };
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.CodeCopy = api;
    if (!window.__codeCopyInstalled) {
      window.__codeCopyInstalled = true;
      // Capture phase: it runs before any click handler on the message or its bubble. The click is NOT stopped (other
      // document listeners close menus on an outside click); the whole-message copy ignores clicks inside a .code-copy.
      const handler = makeClickHandler();
      document.addEventListener('pointerdown', handler.pointerDown, true);
      document.addEventListener('pointerup', handler.pointerUp, true);
      document.addEventListener('pointercancel', handler.pointerCancel, true);
      document.addEventListener('click', handler, true);
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
