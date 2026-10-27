'use strict';
/**
 * ui-dialog.js — one way to leave every dialog, on every page: Escape, X / Close / Cancel, a click on the backdrop and
 * the phone's Back gesture all go through requestClose(), which follows the same rules everywhere:
 *
 *   - nothing changed (a dialog with no fields, or fields back to what they showed) → it closes;
 *   - something changed → "Discard changes?" with Discard / Keep editing; Keep editing has the focus, and Escape or
 *     Enter on that question keeps editing: it never discards by default;
 *   - a save still running (a POST/PUT/PATCH/DELETE the user started in that dialog) → it stays open and says so;
 *   - the innermost layer goes first (a dropdown or picker inside, then a lightbox over a dialog, then the dialog);
 *     Escape while an input method is composing text is ignored;
 *   - Tab stays inside an open modal dialog, and the focus goes back to what opened it when it closes;
 *   - leaving or reloading the page with changes in an open dialog (or on an editing page) asks the browser to warn.
 *
 * "Changed" is a comparison, not "was touched": the first time a field is focused, clicked or typed in, its value is
 * kept as its baseline (that is the value the dialog showed, even one loaded after the dialog opened); the dialog is
 * changed while any field differs from its baseline. Typing and then deleting is unchanged. Fields that only filter or
 * search (type=search, or inside [data-no-dirty]) never count. Saving is explicit: a save takes savePoint(fields) when
 * it starts and calls the returned commit() once the hub confirmed it, so exactly those fields, with the values that
 * were sent, become the new baselines; edits made while it ran, other sections and Test buttons stay counted.
 * markLoaded(field) is for content the page put in itself (another record loaded, a field cleared after a save).
 *
 * Layers: overlays the pages already build (the selector in `auto`) and native <dialog>s are found by themselves when
 * they appear; anything else registers with open(el, { close }) / closed(el). A layer closes through el.__dialogClose
 * when the page set one (to clean up its own state), else <dialog>.close() or el.remove(). [data-dialog-persistent]
 * marks a dialog that needs an answer (an agent's question): Escape and the backdrop leave it open.
 *
 * Labels: every text the helper shows is in DIALOG_TEXT; change a label there (and the copies, see below).
 *
 * The block between the markers is carried byte-identically by app.js and mobile.js (test/ui-dialog.test.js); the
 * other pages load this file as /ui-dialog.js (lib/static-files ALIASES).
 */

// ── dialog helpers (begin) ──
const DIALOG_TEXT = {
  discardTitle: 'Discard changes?',
  discardBody: "You changed something here that isn't saved. If you close it now, those changes are lost.",
  discard: 'Discard',
  keepEditing: 'Keep editing',
  close: 'Close',
  closeAria: 'Close dialog',
  saving: 'Still saving. Wait until it is done, then close.',
};
const DIALOG_SKIP_TYPES = ['button', 'submit', 'reset', 'image', 'hidden', 'search'];
const DIALOG_FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Is this element a field whose value counts as an edit? */
function dialogField(el) {
  if (!el || !el.tagName) return false;
  const tag = String(el.tagName).toUpperCase();
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return false;
  if (tag === 'INPUT' && DIALOG_SKIP_TYPES.includes(String(el.type || 'text').toLowerCase())) return false;
  if (el.closest && el.closest('[data-no-dirty]')) return false;
  return true;
}
/** The value a field shows, as one comparable string. */
function dialogFieldValue(el) {
  const type = String(el.type || '').toLowerCase();
  if (type === 'checkbox' || type === 'radio') return el.checked ? '1' : '0';
  if (el.multiple && el.options) return Array.from(el.options).filter(o => o.selected).map(o => o.value).join('\u0001');
  return String(el.value == null ? '' : el.value);
}
/** Changed: a field still on the page differs from its baseline. */
function dialogIsDirty(baselines) {
  for (const [el, v] of baselines) if (el.isConnected !== false && dialogFieldValue(el) !== v) return true;
  return false;
}
/** An Escape the dialog layer must leave alone: text being composed, already handled by an inner widget, or meant for
 *  an open dropdown / combobox / date picker (aria-expanded). */
function dialogEscapeIgnored(e) {
  if (!e) return true;
  if (e.isComposing || e.keyCode === 229) return true;
  if (e.defaultPrevented) return true;
  const t = e.target;
  return !!(t && t.getAttribute && t.getAttribute('aria-expanded') === 'true');
}
/** A <dialog> opened with showModal(); one opened with show() sits beside the page, which stays usable. */
function dialogIsModal(el) {
  try { return el.matches(':modal'); } catch { return true; }   // no :modal support: treat it as covering the page
}

function createDialogGuard({ doc = document, win = window, auto = '', useHistory = false, trackSaves = true, pageDirty = false } = {}) {
  const layers = [];   // innermost last
  let confirmOpen = null, confirmFinish = null, seq = 0, lastAct = { t: 0, el: null }, escIgnoredAt = 0, popping = false, histId = 0, histSeq = 0, lastOutside = null;
  const page = pageDirty ? { el: doc.body, page: true, baselines: new Map() } : null;
  const now = () => Date.now();

  function layerOf(el) {
    if (!el) return null;
    for (let i = layers.length - 1; i >= 0; i--) if (layers[i].el === el || (layers[i].el.contains && layers[i].el.contains(el))) return layers[i];
    return null;
  }
  const top = () => layers[layers.length - 1] || null;
  // Layers that cover the page: all but a <dialog> opened with show() (the phone's approvals panel), which leaves the
  // page and its tabs usable, so Back stays the page's while only such a panel is open.
  const covering = () => layers.filter(l => !(l.isDialog && l.el.open && !dialogIsModal(l.el)));
  const scopeOf = (el) => layerOf(el) || (page && el && page.el.contains && page.el.contains(el) ? page : null);

  // Baselines: the first time a field is focused, pressed or typed in. A radio notes its whole group (keyboard arrows
  // move the choice without focusing the old one); a label notes the field it controls.
  function note(target) {
    let el = target;
    if (el && el.tagName && String(el.tagName).toUpperCase() === 'LABEL' && el.control) el = el.control;
    if (!dialogField(el)) return;
    const s = scopeOf(el);
    if (!s) return;
    const group = String(el.type || '').toLowerCase() === 'radio' && el.name && s.el.querySelectorAll
      ? Array.from(s.el.querySelectorAll('input[type="radio"]')).filter(r => r.name === el.name) : [el];
    for (const f of group) if (!s.baselines.has(f)) s.baselines.set(f, dialogFieldValue(f));
  }
  // A change on a field never noted (changed by a path the listeners above missed): its old value is unknown, so it
  // counts as changed rather than as unchanged.
  function noteChange(e) {
    const el = e.target;
    if (!dialogField(el)) return;
    const s = scopeOf(el);
    if (s && !s.baselines.has(el)) s.baselines.set(el, '\u0000unknown');
  }
  function dirty(l) { return !!l && !l.persistent && dialogIsDirty(l.baselines); }

  function focusables(el) {
    if (!el.querySelectorAll) return [];
    return Array.from(el.querySelectorAll(DIALOG_FOCUSABLE)).filter(n => !n.hidden && !(n.closest && n.closest('[hidden]')) && (!n.getClientRects || n.getClientRects().length > 0));
  }

  function register(el, opts = {}) {
    if (!el) return null;
    const had = layers.find(l => l.el === el);
    if (had) return had;
    const isDialog = String(el.tagName || '').toUpperCase() === 'DIALOG';
    const l = {
      id: ++seq, el, isDialog, baselines: new Map(), saving: 0,
      modal: opts.modal !== undefined ? !!opts.modal : !(el.classList && el.classList.contains('gs-dock')),
      persistent: !!(el.dataset && el.dataset.dialogPersistent),
      close: opts.close || null,
      // What opened it: the focused element, unless the dialog already took the focus; then the last one outside.
      opener: (() => { const a = doc.activeElement; return a && a !== doc.body && !(el.contains && el.contains(a)) ? a : lastOutside; })(),
    };
    layers.push(l);
    if (isDialog && el.addEventListener && !el.__dialogCancel) {
      el.__dialogCancel = (e) => {
        e.preventDefault();   // the guard decides, never the browser
        if (now() - escIgnoredAt < 200) return;
        const lay = layers.find(x => x.el === el);
        if (lay) requestClose(lay, 'cancel');
      };
      el.addEventListener('cancel', el.__dialogCancel);
    }
    if (l.modal && !isDialog) Promise.resolve().then(() => {
      if (!l.el.isConnected || layers.indexOf(l) < 0) return;
      const a = doc.activeElement;
      if (a && l.el.contains(a)) return;
      const box = (l.el.firstElementChild && l.el.firstElementChild.focus) ? l.el.firstElementChild : l.el;
      if (box.setAttribute && !box.hasAttribute('tabindex')) box.setAttribute('tabindex', '-1');
      try { box.focus({ preventScroll: true }); } catch {}
    });
    syncHistory();
    return l;
  }

  function unregister(el) {
    const i = layers.findIndex(l => l.el === el);
    if (i < 0) return;
    const [l] = layers.splice(i, 1);
    syncHistory();
    const a = doc.activeElement;
    if (l.opener && l.opener.isConnected !== false && (!a || a === doc.body || a.isConnected === false || (l.el.contains && l.el.contains(a)))) {
      try { l.opener.focus({ preventScroll: true }); } catch {}
    }
  }

  function closeNow(l) {
    if (l.el.__dialogClose) l.el.__dialogClose();
    else if (l.close) l.close();
    else if (l.isDialog) { if (l.el.open) l.el.close(); }
    else if (l.el.remove) l.el.remove();
    unregister(l.el);
  }

  function flashSaving(l) {
    const host = l.el.querySelector && (l.el.querySelector('dialog, .question-modal, .gs-modal, .st-modal') || l.el);
    if (!host || !host.appendChild) return;
    let n = host.querySelector('.dlg-saving');
    if (!n) { n = doc.createElement('div'); n.className = 'dlg-saving'; n.setAttribute('role', 'status'); host.appendChild(n); }
    n.textContent = DIALOG_TEXT.saving;
    clearTimeout(n.__t); n.__t = setTimeout(() => n.remove && n.remove(), 2500);
  }

  /** The one way out. how: 'escape' | 'close' | 'backdrop' | 'back' | 'cancel'. Returns what happened. */
  function requestClose(l, how = 'close') {
    if (!l) return 'none';
    if (confirmOpen) return 'confirm';
    if (l.persistent && how !== 'close') return 'kept';
    if (l.saving > 0) { flashSaving(l); return 'busy'; }
    if (dirty(l)) { askDiscard(l); return 'confirm'; }
    closeNow(l);
    return 'closed';
  }

  function askDiscard(l) {
    const d = doc.createElement('dialog');
    d.className = 'dlg-discard';
    d.setAttribute('role', 'alertdialog');
    d.setAttribute('aria-labelledby', 'dlg-discard-title');
    d.setAttribute('aria-describedby', 'dlg-discard-body');
    d.innerHTML = '<h3 id="dlg-discard-title"></h3><p id="dlg-discard-body"></p><div class="dlg-discard-btns"><button type="button" class="dlg-discard-go"></button><button type="button" class="dlg-discard-keep"></button></div>';
    d.querySelector('#dlg-discard-title').textContent = DIALOG_TEXT.discardTitle;
    d.querySelector('#dlg-discard-body').textContent = DIALOG_TEXT.discardBody;
    const go = d.querySelector('.dlg-discard-go'), keep = d.querySelector('.dlg-discard-keep');
    go.textContent = DIALOG_TEXT.discard;
    keep.textContent = DIALOG_TEXT.keepEditing;
    const back = doc.activeElement;
    const finish = (discard) => {
      if (confirmOpen !== d) return;
      confirmOpen = null; confirmFinish = null;
      try { d.close(); } catch {}
      if (d.remove) d.remove();
      if (discard) { l.baselines.clear(); closeNow(l); }
      else {
        syncHistory();   // Back took the entry while the question was up: it comes back
        try { (back && back.isConnected !== false ? back : l.el).focus({ preventScroll: true }); } catch {}
      }
    };
    go.addEventListener('click', () => finish(true));
    keep.addEventListener('click', () => finish(false));
    d.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); });   // Escape on the question = keep editing
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(false); }   // Enter never discards
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    confirmOpen = d; confirmFinish = finish;
    doc.body.appendChild(d);
    if (d.showModal) d.showModal();
    keep.focus();
    return d;
  }

  // ── Keys: Escape for the innermost layer, Tab kept inside a modal one ──
  function onKeydown(e) {
    if (e.key === 'Escape' || e.key === 'Esc') {
      if (confirmOpen) return;   // the question handles its own keys
      if (dialogEscapeIgnored(e)) { escIgnoredAt = now(); return; }
      const l = top();
      if (!l) return;
      if (!l.modal && !(l.el.contains && l.el.contains(e.target))) return;   // a docked panel answers only from inside
      e.preventDefault();
      requestClose(l, 'escape');
      return;
    }
    if (e.key === 'Tab') {
      if (confirmOpen) return;
      const l = top();
      if (!l || !l.modal || l.isDialog) return;   // native modal dialogs keep the focus themselves
      const f = focusables(l.el);
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1], a = doc.activeElement;
      // Focus on something that is not one of the controls (the dialog box itself, a scroll area, or outside):
      // Tab goes to the first control, Shift+Tab to the last, never out of the dialog.
      if (!l.el.contains(a) || f.indexOf(a) < 0) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
    }
  }

  // ── The phone's Back gesture: while any layer covers the page, the guard keeps ONE history entry on top of the
  // page's own. Back takes that entry: the innermost covering layer is asked to close, and the entry comes back while
  // one is still open (a layer under it, the question, a save running, an answer needed), so the next Back comes here
  // again. Closing the last one any other way removes the entry, so the next Back reaches the page's router; a layer
  // that closes under another one leaves no entry behind. ──
  function syncHistory() {
    if (!useHistory || popping) return;   // our own back() is on its way: its popstate syncs again
    const open = covering().length;
    if (open && !histId) {
      const id = ++histSeq;
      try { win.history.pushState({ ...(win.history.state || {}), dialog: id }, ''); histId = id; } catch {}
    } else if (!open && histId) {
      const id = histId;
      histId = 0;
      const st = win.history.state;
      if (!st || st.dialog !== id) return;   // the page moved history on since: its entries are left alone
      popping = true;
      try { win.history.back(); } catch { popping = false; }
    }
  }
  function onPopstate(e) {
    if (popping) {   // our own back() after the last layer closed
      popping = false;
      e.stopImmediatePropagation();
      syncHistory();   // a layer that opened meanwhile gets its entry now
      return;
    }
    if (!histId || (e.state || {}).dialog === histId) return;
    e.stopImmediatePropagation();   // the page's own router must not move while a layer is open
    histId = 0;
    if (confirmOpen) confirmFinish(false);   // Back on "Discard changes?" = Keep editing
    else requestClose(covering().pop(), 'back');
    syncHistory();
  }

  // ── Saves in flight: a POST/PUT/PATCH/DELETE to the hub's /api/ that follows a click or key in a layer keeps that
  // layer open until the hub answers (the response headers; the page reads the answer and commits right after). It
  // settles nothing by itself (a Test button posts too): see savePoint. ──
  function wrapFetch() {
    const orig = win.fetch && win.fetch.bind(win);
    if (!orig || win.fetch.__dialogGuard) return;
    const wrapped = function (input, init) {
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      let l = null;
      if (method !== 'GET' && method !== 'HEAD' && now() - lastAct.t < 1500) {
        let url = ''; try { url = new URL(typeof input === 'string' ? input : input.url, win.location.href).pathname; } catch {}
        if (url.startsWith('/api/')) l = scopeOf(lastAct.el);
      }
      if (!l) return orig(input, init);
      l.saving = (l.saving || 0) + 1;
      return Promise.resolve(orig(input, init)).finally(() => { l.saving--; });
    };
    wrapped.__dialogGuard = true;
    win.fetch = wrapped;
  }
  /** savePoint(fields): the fields a save writes (an element, a container of them, or a list), with the values they
   *  have now, as the save starts. The returned commit(), called once the hub confirmed the save, makes exactly those
   *  values the fields' baselines: an edit made while the save ran stays changed, and nothing else is touched. */
  function savePoint(scope) {
    const list = [];
    const add = (el) => {
      if (!el) return;
      if (dialogField(el)) list.push(el);
      else if (el.querySelectorAll) for (const f of el.querySelectorAll('input, textarea, select')) if (dialogField(f)) list.push(f);
    };
    if (Array.isArray(scope) || (scope && typeof scope.length === 'number' && !scope.tagName)) for (const el of scope) add(el); else add(scope);
    const snap = list.map(el => [el, dialogFieldValue(el)]);
    return function commit() {
      for (const [el, v] of snap) { if (el.isConnected === false) continue; const s = scopeOf(el); if (s) s.baselines.set(el, v); }
    };
  }

  // ── Wiring ──
  const act = (e) => { lastAct = { t: now(), el: e.target }; note(e.target); };
  doc.addEventListener('keydown', onKeydown);
  doc.addEventListener('focusin', (e) => { if (!layerOf(e.target) && e.target !== confirmOpen) lastOutside = e.target; note(e.target); }, true);
  doc.addEventListener('pointerdown', act, true);
  doc.addEventListener('keydown', act, true);
  doc.addEventListener('change', (e) => { noteChange(e); lastAct = { t: now(), el: e.target }; }, true);
  doc.addEventListener('input', noteChange, true);
  // A click on an overlay's own backdrop (not on its box) is a way out too.
  doc.addEventListener('click', (e) => {
    const l = top();
    if (!l || !l.modal || e.target !== l.el || confirmOpen) return;
    if (l.isDialog) {
      const r = l.el.getBoundingClientRect && l.el.getBoundingClientRect();
      if (!r || (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom)) return;
    }
    if (l.el.dataset && l.el.dataset.dialogNoBackdrop) return;
    e.stopImmediatePropagation();
    requestClose(l, 'backdrop');
  }, true);
  if (useHistory && win.addEventListener) win.addEventListener('popstate', onPopstate);
  // Unsaved changes anywhere: an open layer, or the editing page itself. The pages' own reloads wait while this is true.
  const hasChanges = () => layers.some(dirty) || (!!page && dialogIsDirty(page.baselines));
  if (win.addEventListener) win.addEventListener('beforeunload', (e) => {
    if (hasChanges()) { e.preventDefault(); e.returnValue = ''; return ''; }
  });
  if (trackSaves) wrapFetch();
  if (typeof MutationObserver !== 'undefined' && doc.body) {
    const consider = (n) => {
      if (!n || n.nodeType !== 1) return;
      if (auto && n.matches && n.matches(auto)) register(n);
      if (String(n.tagName).toUpperCase() === 'DIALOG' && n.open && n !== confirmOpen) register(n);
    };
    new MutationObserver((recs) => {
      for (const r of recs) {
        if (r.type === 'attributes') {
          const n = r.target;
          if (n === confirmOpen || String(n.tagName).toUpperCase() !== 'DIALOG') continue;
          if (n.open) register(n); else unregister(n);
          continue;
        }
        for (const n of r.removedNodes) if (n.nodeType === 1) for (const l of layers.slice()) if (l.el === n || (n.contains && n.contains(l.el))) unregister(l.el);
        for (const n of r.addedNodes) consider(n);
      }
    }).observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
    if (auto && doc.querySelectorAll) for (const n of doc.querySelectorAll(auto)) register(n);
  }
  if (!doc.getElementById('dlg-style') && doc.head) {
    const s = doc.createElement('style');
    s.id = 'dlg-style';
    s.textContent = '.dlg-discard{margin:auto;max-width:min(92vw,380px);padding:20px;border:1px solid var(--border-strong,#333846);border-radius:12px;background:var(--bg-card,#14171F);color:var(--text,#F3F4F6);font:inherit}'
      + '.dlg-discard::backdrop{background:rgba(0,0,0,.55)}.dlg-discard h3{margin:0 0 8px;font-size:1.05rem}.dlg-discard p{margin:0 0 16px;color:var(--text-dim,#9CA3AF);line-height:1.4}'
      + '.dlg-discard-btns{display:flex;gap:8px;justify-content:flex-end}.dlg-discard-btns button{min-height:36px;padding:0 16px;border-radius:8px;border:1px solid var(--border-strong,#333846);background:var(--bg-input,#040507);color:var(--text,#F3F4F6);font:inherit;cursor:pointer}'
      + '.dlg-discard-btns .dlg-discard-go{color:var(--error,#FF4C4C)}.dlg-discard-btns .dlg-discard-keep{background:var(--accent,#3D7BFF);border-color:var(--accent,#3D7BFF);color:#fff}'
      + '.dlg-discard-btns button:focus-visible{outline:2px solid var(--accent-hover,#5A93FF);outline-offset:2px}'
      + '.dlg-saving{margin-top:10px;font-size:.8rem;color:var(--warning,#F5A623)}';
    doc.head.appendChild(s);
  }

  return {
    open: (el, opts) => register(el, opts),
    closed: (el) => unregister(el),
    requestClose: (elOrChild, how) => requestClose(layerOf(elOrChild), how),
    isDirty: (elOrChild) => dirty(layerOf(elOrChild)) || (!layerOf(elOrChild) && !!page && dialogIsDirty(page.baselines)),
    hasChanges,
    savePoint,
    markLoaded: (els) => { for (const el of (Array.isArray(els) ? els : [els])) { const l = el && scopeOf(el); if (l) l.baselines.delete(el); } },   // put in by the page, not typed
    layers: () => layers.slice(),
    _confirm: () => confirmOpen,
  };
}
// ── dialog helpers (end) ──

if (typeof module !== 'undefined' && module.exports) module.exports = { DIALOG_TEXT, dialogField, dialogFieldValue, dialogIsDirty, dialogEscapeIgnored, dialogIsModal, createDialogGuard };
