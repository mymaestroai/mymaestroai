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
 * what is there), shows Copied (or Could not copy), and stops the click so the whole-message copy does not also fire.
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
    let live = null;
    function announce(msg) {
      try {
        const d = doc();
        if (!live || !live.isConnected) {
          live = d.createElement('span');
          live.className = 'code-copy-live';
          live.setAttribute('aria-live', 'polite');
          live.setAttribute('role', 'status');
          d.body.appendChild(live);
        }
        live.textContent = msg;
      } catch { /* ignore */ }
    }
    function setState(btn, state) {
      const prev = timers.get(btn);
      if (prev) clearT(prev);
      btn.classList.remove('copied', 'copy-failed');
      let label = 'Copy', ms = 0;
      if (state === 'copied') { btn.classList.add('copied'); label = 'Copied'; ms = 1500; }
      else if (state === 'failed') { btn.classList.add('copy-failed'); label = 'Could not copy'; ms = 2000; }
      btn.setAttribute('aria-label', label);
      btn.title = label;
      if (state !== 'idle') announce(label);
      if (ms) timers.set(btn, setT(() => { timers.delete(btn); setState(btn, 'idle'); }, ms));
    }
    return function onClick(ev) {
      const t = ev && ev.target;
      const btn = t && t.closest ? t.closest('.code-copy') : null;
      if (!btn) return undefined;
      ev.preventDefault();
      if (ev.stopPropagation) ev.stopPropagation();
      const box = btn.closest('.code-box');
      const code = box && (box.querySelector('pre code') || box.querySelector('pre'));   // (a wrapped DOM <pre> has no <code>)
      const text = code ? code.textContent : '';   // read now: a streamed reply copies what is there at the click
      let p;
      try { p = Promise.resolve(doCopy(text)); } catch { p = Promise.resolve(false); }
      return p.catch(() => false).then((ok) => { setState(btn, ok ? 'copied' : 'failed'); return ok; });
    };
  }

  const api = { blockHtml, wrap, copy, makeClickHandler, ICON };
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.CodeCopy = api;
    if (!window.__codeCopyInstalled) {
      window.__codeCopyInstalled = true;
      // Capture phase: it runs before any click handler on the message or its bubble, and stopPropagation keeps them out.
      document.addEventListener('click', makeClickHandler(), true);
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
