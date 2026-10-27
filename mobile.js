'use strict';
// My Maestro AI phone UI: Agents / Chat / Activity. Same-origin calls to the existing hub APIs only.

const HISTORY_PAGE = 40;
const ACTIVITY_MAX = 50;
const GROUPS = [
  { key: 'primary', title: 'Primary' },
  { key: 'specialist', title: 'Specialist' },
  { key: 'worker', title: 'Worker' },
  { key: 'experimental', title: 'Experimental' },
];

let agents = [];
let screen = 'agents';
let current = null;            // agent name whose chat is loaded
let chatHistory = [];              // full history array of the open chat
let histGen = 0;                   // bumped whenever chatHistory is replaced (a fetch, a clear)
let histReadSeq = 0;               // the newest history re-read wins (rereadHistory)
let shown = 0;                 // how many trailing history entries are rendered
// Replies this phone is streaming, one per agent: several chats can run at once and each one
// keeps running in the background while another chat is open.
const streams = new Map();     // agent -> { controller, agent, text, bubble, userEl, full, tools, startedAt, ... }
const recentOwn = new Map();   // agent -> time our own stream for it ended (dedupes the hub's turn_end)
let pendingImages = [];
let stick = true;
const live = {};               // name -> { busy, busySince, activity, pendingQuestion } from the hub
let statusKnown = false;       // true once the hub told us anything about busy state (older hubs never do)
let workingFilter = false;     // Agents list shows only working agents
const reattaches = new Map();  // agent -> { agent, text, bubble, line, partial, startedAt } after a dropped stream
const rawText = new WeakMap(); // bubble element -> the message's plain text / markdown source (for Copy)
let es = null;                 // the /api/events EventSource
const STATUS_POLL_MS = 20000;
const TURN_POLL_MS = 4000;       // a followed turn's view, while the live event stream is down
const STATUS_TICK_MS = 30000;
const REATTACH_GIVE_UP_MS = 30 * 60 * 1000;
let unread = loadJson('hub-mobile-unread', {});
let activity = loadJson('hub-mobile-activity', []);
let actUnseen = 0;
const hubTurns = {};           // turnId -> { agent, el, body }
let collapsed = loadJson('hub-mobile-collapsed', { experimental: true });

const $ = (id) => document.getElementById(id);

function loadJson(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
}
function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// The password-check endpoints answer 401 for a wrong password; every other 401 means the login session is gone.
const OWN_401 = ['/api/auth/totp/disable', '/api/auth/password'];
let redirectingToLogin = false;
async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'include', ...opts });
  if (res.status === 401 && !redirectingToLogin && !OWN_401.includes(String(path).split('?')[0])) {
    redirectingToLogin = true;
    location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
  }
  return res;
}

// ── Multi-user: who am I, owner view, member gating ─────────────────────────
const OWNER_VIEW_KEY = 'hub-owner-view';
let hubMe = null;
function isAdmin() { return !hubMe || hubMe.isAdmin !== false; }
function ownerView() { return localStorage.getItem(OWNER_VIEW_KEY) || 'mine'; }

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(text, ms = 3000, onTap = null) {
  const t = $('toast');
  t.textContent = text;
  t.onclick = onTap ? () => { t.classList.remove('on'); onTap(); } : null;   // a notice that leads somewhere
  t.style.cursor = onTap ? 'pointer' : '';
  t.classList.add('on');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('on'), ms);
}

// ── Formatting (same escape-first approach as app.js formatContent) ──────────

function parseThinking(content) {
  let thinking = '';
  let cleaned = String(content || '');
  const closed = [/<think>([\s\S]*?)<\/think>/gi, /<thinking>([\s\S]*?)<\/thinking>/gi, /<reasoning>([\s\S]*?)<\/reasoning>/gi, /\[think\]([\s\S]*?)\[\/think\]/gi, /\[thinking\]([\s\S]*?)\[\/thinking\]/gi];
  for (const re of closed) {
    for (const m of cleaned.matchAll(re)) thinking += (thinking ? '\n' : '') + m[1].trim();
    cleaned = cleaned.replace(re, '');
  }
  const open = [/<think>([\s\S]*)$/i, /<thinking>([\s\S]*)$/i, /<reasoning>([\s\S]*)$/i, /\[think\]([\s\S]*)$/i, /\[thinking\]([\s\S]*)$/i];
  for (const re of open) {
    const m = cleaned.match(re);
    if (m) { thinking += (thinking ? '\n' : '') + m[1].trim(); cleaned = cleaned.replace(re, ''); }
  }
  return { thinking, response: cleaned.trim() };
}

function safeUrl(url) {
  const u = String(url).replace(/&amp;/g, '&').trim();
  return /^(https?:|mailto:|\/(?!\/))/i.test(u) ? u : null;
}

// Shared verbatim with lib/ui-safe-text.js and app.js (test/ui-escaping.test.js keeps the three in step).
// ── safe-text helpers (begin) ──
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function autolinkEscaped(text, attrs) {
  // Runs on text that is already HTML-escaped, so a quote can only appear as &quot; / &#39; and never raw.
  return String(text).replace(/(^|[^"=])(https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+)/g, (m, lead, url) => {
    const cut = url.search(/&quot;|&#39;|&lt;|&gt;/);
    const u = cut >= 0 ? url.slice(0, cut) : url;
    const rest = cut >= 0 ? url.slice(cut) : '';
    // Sentence punctuation after a URL is text, not part of it: trailing . , ; : ! ? and a ) or ] with no
    // opening partner inside the URL ("see https://x.y/a, then", "(https://x.y/a)"); a balanced (...) stays.
    // A bare trailing & arrives escaped as &amp; and goes as one unit. Bracket counts are taken once (linear time).
    let href = u;
    const n = { '(': 0, ')': 0, '[': 0, ']': 0 };
    for (const c of href) if (c in n) n[c]++;
    for (;;) {
      if (href.endsWith('&amp;')) { href = href.slice(0, -5); continue; }
      const last = href.slice(-1);
      const open = last === ')' ? '(' : last === ']' ? '[' : '';
      if (open && n[open] < n[last]) { n[last]--; href = href.slice(0, -1); }
      else if (/[.,;:!?]/.test(last)) href = href.slice(0, -1);
      else break;
    }
    if (!/^https?:\/\/[A-Za-z0-9]/.test(href)) return m;
    return `${lead}<a href="${href}" target="_blank" rel="noopener noreferrer"${attrs || ''}>${href}</a>${u.slice(href.length)}${rest}`;
  });
}
function safeLinkUrl(url) {
  const u = String(url ?? '').replace(/&amp;/g, '&').replace(/[\u0000- \u007f-\u009f\s]/g, '');
  if (!u) return null;
  if (/^https?:\/\//i.test(u) || /^mailto:/i.test(u)) return u;
  if (/^\/\//.test(u)) return null;                       // protocol-relative: another host
  if (/^[/#?]/.test(u)) return u;                         // same-origin path, fragment or query
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;          // relative path (no scheme at all)
  return null;                                            // javascript:, data:, vbscript:, file:, ...
}
function imageSrcKind(src, origin) {
  const s = String(src ?? '').replace(/[\u0000- \u007f-\u009f\s]/g, '');
  if (/^data:image\//i.test(s)) return { kind: 'data', url: s };
  if (/^blob:/i.test(s)) return { kind: 'blob', url: s };
  const u = safeLinkUrl(s);
  if (!u || /^mailto:/i.test(u)) return null;
  if (!/^https?:\/\//i.test(u)) return { kind: 'same', url: u };
  try { return { kind: new URL(u).origin === String(origin || '') ? 'same' : 'external', url: u }; } catch { return null; }
}
// ── safe-text helpers (end) ──

// Shared verbatim with lib/ui-version-label.js and app.js (test/ui-version-label.test.js keeps the three in step).
// ── version-label helpers (begin) ──
function versionLabel(v) {
  if (!v || !v.version) return null;
  const sha = v.commit ? String(v.commit).slice(0, 12) : '';
  if (v.channel === 'stable') return { text: `v${v.version} · stable`, kind: 'stable', title: `My Maestro AI ${v.version}, stable channel` };
  if (v.channel === 'experimental') return { text: `v${v.version}-dev${sha ? ` · ${sha}` : ''}`, kind: 'experimental', title: `My Maestro AI ${v.version}, experimental channel (branch ${v.branch || 'dev'})${sha ? `, commit ${sha}` : ''}` };
  const where = v.branch || 'no branch';
  return { text: `v${v.version} · ${where}${sha ? ` · ${sha}` : ''}`, kind: 'other', title: `My Maestro AI ${v.version}, branch ${where}${sha ? `, commit ${sha}` : ''}` };
}
function updateStatusText(s) {
  if (!s || typeof s !== 'object') return null;
  if (s.enabled === false) return 'Check off';
  if (s.available) {
    if (s.latestVersion && s.latestVersion !== s.currentVersion) return `${s.latestVersion} available`;
    const n = Number(s.behind) || 0;
    return n > 0 ? `${n} new change${n === 1 ? '' : 's'} available` : 'Update available';
  }
  if (s.error) return `Check failed: ${s.error}`;
  if (s.checking) return 'Checking…';
  return s.checkedAt ? 'Up to date' : 'Not checked yet';
}
function versionDetailsText(v, u, ua) {
  v = v || {};
  const when = (t) => { const d = new Date(t); return t && !isNaN(d) ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'unknown'; };
  const channel = v.channel ? `${v.channel}${v.branch ? ` (branch ${v.branch})` : ''}` : (v.branch ? `branch ${v.branch}` : 'unknown');
  const lines = [
    `My Maestro AI ${v.version || 'unknown'}`,
    `Channel: ${channel}`,
    `Commit: ${v.commit || 'unknown'}${v.commitDate ? ` (${v.commitDate})` : ''}`,
    `Hub started: ${when(v.startedAt)}`,
    `Node.js: ${v.node || 'unknown'}`,
    `Restart pending: ${v.restartPending == null ? 'unknown' : v.restartPending ? 'yes (code on disk is newer than the running hub)' : 'no'}`,
  ];
  const up = updateStatusText(u);
  if (up) lines.push(`Update: ${up}`);
  if (ua) lines.push(`Browser: ${ua}`);
  return lines.join('\n');
}
// ── version-label helpers (end) ──

// Shared verbatim with lib/ui-dialog.js and app.js (test/ui-dialog.test.js keeps the three in step).
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

// One way out of every sheet on the phone: Esc, Close / Cancel, a tap on the backdrop and the Back gesture (each open
// sheet owns a history entry) all ask the sheet first (lib/ui-dialog.js). The <dialog> sheets are found when they open;
// the reasoning and tool sheets register themselves.
const dialogGuard = createDialogGuard({ useHistory: true });
function dialogRequestClose(el, how) { return dialogGuard.requestClose(el, how || 'close'); }

// A markdown image: same-origin, data: and blob: sources are shown inline; any other host becomes a link
// with the alt text and the host, never fetched (an off-site image is a zero-click beacon). Unsafe: blocked.
function imageHtml(src, alt) {
  const eAlt = escapeHtml(alt || '');
  const im = imageSrcKind(src, location.origin);
  if (!im) return `<code>[blocked image: ${eAlt}]</code>`;
  if (im.kind === 'external') {
    let host = ''; try { host = new URL(im.url).host; } catch {}
    return `<a href="${escapeHtml(im.url)}" target="_blank" rel="noopener noreferrer" class="external-image">🖼 ${eAlt || 'image'} <span class="external-host">(${escapeHtml(host)})</span></a>`;
  }
  return `<img src="${escapeHtml(im.url)}" alt="${eAlt}">`;
}

// ── Visual blocks ─────────────────────────────────────────────────────────────────────────────
// Four fenced block types are DRAWN instead of shown as source (lib/visuals-policy.js promises
// this to every agent): ```svg (inline, sanitized), ```mermaid (diagram), ```chart (Chart.js
// config as JSON) and ```html (a sealed sandboxed iframe). formatContent turns a closed fence into
// a placeholder <div class="visual" data-kind=...> whose only child is the escaped source in a
// <pre><code>; nothing in it is ever interpreted as HTML. renderVisualBlocks() then draws every
// placeholder it finds (idempotent: data-rendered marks the ones done) once the library it needs
// has been lazy-loaded from /vendor/. An unclosed fence (still streaming) is left as plain text,
// so a block is only drawn once it is complete. Any failure keeps the source visible as a normal
// code block and adds a one-line note; nothing throws out of the renderer.
const VISUAL_KINDS = { svg: 'svg', mermaid: 'mermaid', chart: 'chart', html: 'html' };
const VISUAL_PALETTE = ['#3987e5', '#d95926', '#199e70', '#8b6fd6', '#c9a227', '#d4588b'];
const VISUAL_TEXT = '#c3c2b7';
const VISUAL_GRID = 'rgba(255,255,255,.12)';
const VISUAL_SURFACE = '#1a1a19';
const VISUAL_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;";
const VISUAL_SCRIPTS = { purify: '/vendor/purify.min.js', mermaid: '/vendor/mermaid.min.js', chart: '/vendor/chart.umd.min.js' };

function visualKind(lang) { return VISUAL_KINDS[String(lang || '').toLowerCase()] || null; }
// escapedSource is already HTML-escaped (& < >); reading the <pre> back through textContent restores it.
function visualPlaceholder(kind, escapedSource) {
  return `<div class="visual visual-${kind}" data-kind="${kind}"><pre class="visual-src"><code>${escapedSource}</code></pre></div>`;
}

// Lazy script loader: one <script src> per file, shared promise; a failed load can be retried.
const visualScriptLoads = new Map();
function loadScriptOnce(src) {
  if (visualScriptLoads.has(src)) return visualScriptLoads.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { visualScriptLoads.delete(src); s.remove(); reject(new Error(`could not load ${src}`)); };
    document.head.appendChild(s);
  });
  visualScriptLoads.set(src, p);
  return p;
}

// Rendered svg/mermaid markup by source: a streaming paint repaints the whole message many times
// after a fence has closed, and a diagram must not be re-parsed on every delta.
const visualCache = new Map();
function visualCachePut(key, html) {
  if (visualCache.size >= 40) visualCache.delete(visualCache.keys().next().value);
  visualCache.set(key, html);
}
let visualSeq = 0;
const visualCharts = new Set();   // live Chart.js instances; destroyed once their canvas is repainted away

function visualFail(el, note) {
  if (!el || !el.isConnected) return;
  el.classList.add('visual-failed');
  el.classList.remove('rendered');
  el.querySelectorAll(':scope > .visual-body, :scope > .visual-bar, :scope > .visual-note').forEach(n => n.remove());
  const n = document.createElement('div');
  n.className = 'visual-note';
  n.textContent = note;
  el.insertBefore(n, el.firstChild);
}
function visualMount(el, kind, body, withExpand) {
  const bar = document.createElement('div');
  bar.className = 'visual-bar';
  bar.innerHTML = `<span class="visual-kind">${kind}</span>`
    + (withExpand ? '<button type="button" class="visual-btn" data-act="expand">expand</button>' : '')
    + '<button type="button" class="visual-btn" data-act="source">source</button>';
  el.insertBefore(body, el.firstChild);
  el.insertBefore(bar, el.firstChild);
  el.classList.add('rendered');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('.visual-btn');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  const v = b.closest('.visual');
  if (!v) return;
  if (b.dataset.act === 'expand') { const on = v.classList.toggle('expanded'); b.textContent = on ? 'shrink' : 'expand'; }
  else if (b.dataset.act === 'source') { const on = v.classList.toggle('show-source'); b.textContent = on ? 'hide source' : 'source'; }
});

// SVG: DOMPurify's svg profile, then a second pass of our own. Scripts, foreignObject, embeds,
// on* handlers, javascript: and every external reference go; href/xlink:href may only be a
// #fragment or a data:image URI, and CSS url() may only point at a #fragment.
function sanitizeSvg(source) {
  const DP = window.DOMPurify;
  if (!DP || typeof DP.sanitize !== 'function') throw new Error('sanitizer unavailable');
  const clean = DP.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'object', 'embed', 'audio', 'video', 'style', 'animate', 'set', 'animateMotion', 'animateTransform'],   // SMIL could retarget an href at runtime
    FORBID_ATTR: ['style'],
    // No ALLOWED_URI_REGEXP here: DOMPurify applies it to EVERY attribute value (width, viewBox, x...),
    // which emptied sized drawings. The href rule is enforced by the second pass below.
  });
  const tpl = document.createElement('template');   // inert: nothing loads or runs while parsing
  tpl.innerHTML = clean;
  const svg = tpl.content.querySelector('svg');
  if (!svg) return '';
  // No CSS at all (a <style> or style attribute can overlay the page, and @import / url() reach out);
  // href / xlink:href / src may only be a #fragment or a data:image URI (no external reference, no
  // javascript:); presentation attributes stay, but url() in them may only point at a #fragment.
  const externalUrl = /url\(\s*['"]?\s*(?!#)|@import/i;
  for (const n of [svg, ...svg.querySelectorAll('*')]) {
    if (n.tagName.toLowerCase() === 'style') { n.remove(); continue; }
    for (const a of [...n.attributes]) {
      const name = a.name.toLowerCase();
      if (name.startsWith('on') || name === 'style') n.removeAttribute(a.name);
      else if ((name === 'href' || name === 'xlink:href' || name === 'src') && !/^\s*(#|data:image\/)/i.test(a.value)) n.removeAttribute(a.name);
      else if (/javascript:/i.test(a.value)) n.removeAttribute(a.name);
      else if (externalUrl.test(a.value)) n.removeAttribute(a.name);
    }
  }
  return svg.outerHTML;
}
async function renderSvgBlock(el, source) {
  const key = 'svg\n' + source;
  let html = visualCache.get(key);
  if (html === undefined) {
    await loadScriptOnce(VISUAL_SCRIPTS.purify);
    html = sanitizeSvg(source);
    visualCachePut(key, html);
  }
  if (!html) throw new Error('no <svg> element in the block');
  if (!el.isConnected) return;
  const body = document.createElement('div');
  body.className = 'visual-body';
  body.innerHTML = html;
  visualMount(el, 'svg', body, false);
}

// Mermaid: strict security level (its own sanitizer, no click handlers or html labels), dark theme.
let mermaidReady = null;
function mermaidInit() {
  if (!mermaidReady) {
    mermaidReady = loadScriptOnce(VISUAL_SCRIPTS.mermaid).then(() => {
      if (!window.mermaid) throw new Error('mermaid unavailable');
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark', suppressErrorRendering: true });
    }).catch(e => { mermaidReady = null; throw e; });
  }
  return mermaidReady;
}
async function renderMermaidBlock(el, source) {
  const key = 'mermaid\n' + source;
  let html = visualCache.get(key);
  if (html === undefined) {
    await mermaidInit();
    const id = `mmd-${Date.now().toString(36)}-${++visualSeq}`;
    try {
      const out = await window.mermaid.render(id, source.trim());
      html = out && out.svg ? out.svg : '';
    } catch (e) {
      const stray = document.getElementById('d' + id);   // mermaid's scratch element, if it left one
      if (stray) stray.remove();
      const why = e && e.message ? String(e.message).split('\n')[0].slice(0, 140) : '';
      throw new Error('diagram did not parse' + (why ? `: ${why}` : ''));
    }
    if (!html) throw new Error('empty diagram');
    visualCachePut(key, html);
  }
  if (!el.isConnected) return;
  const body = document.createElement('div');
  body.className = 'visual-body';
  body.innerHTML = html;
  visualMount(el, 'mermaid', body, false);
}

// Chart.js: the block is a JSON config {type, data, options}. JSON.parse only: no functions, no
// eval. Dark palette and layout defaults are filled in only where the config says nothing.
let chartReady = null;
function chartInit() {
  if (!chartReady) {
    chartReady = loadScriptOnce(VISUAL_SCRIPTS.chart).then(() => {
      const C = window.Chart;
      if (!C) throw new Error('Chart.js unavailable');
      C.defaults.color = VISUAL_TEXT;
      C.defaults.borderColor = VISUAL_GRID;
    }).catch(e => { chartReady = null; throw e; });
  }
  return chartReady;
}
function chartConfig(source) {
  let cfg;
  try { cfg = JSON.parse(source); } catch { throw new Error('config is not valid JSON'); }
  const obj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!obj(cfg)) throw new Error('config must be a JSON object');
  if (typeof cfg.type !== 'string' || !cfg.type) throw new Error('config needs a "type"');
  if (!obj(cfg.data) || !Array.isArray(cfg.data.datasets)) throw new Error('config needs data.datasets');
  const sliced = (t) => t === 'pie' || t === 'doughnut' || t === 'polarArea';
  const radial = sliced(cfg.type) || cfg.type === 'radar';
  cfg.data.datasets.forEach((ds, i) => {
    if (!obj(ds)) return;
    const type = typeof ds.type === 'string' ? ds.type : cfg.type;
    const c = VISUAL_PALETTE[i % VISUAL_PALETTE.length];
    if (sliced(type)) {
      if (ds.backgroundColor === undefined) ds.backgroundColor = (Array.isArray(ds.data) ? ds.data : []).map((_, j) => VISUAL_PALETTE[j % VISUAL_PALETTE.length]);
      if (ds.borderColor === undefined) ds.borderColor = VISUAL_SURFACE;
    } else {
      if (ds.borderColor === undefined) ds.borderColor = c;
      if (ds.backgroundColor === undefined) ds.backgroundColor = (type === 'line' || type === 'radar') ? c + '33' : c;
    }
  });
  const o = cfg.options = obj(cfg.options) ? cfg.options : {};
  o.responsive = true;
  o.maintainAspectRatio = false;
  o.plugins = obj(o.plugins) ? o.plugins : {};
  o.plugins.legend = obj(o.plugins.legend) ? o.plugins.legend : {};
  if (o.plugins.legend.display === undefined) o.plugins.legend.display = sliced(cfg.type) || cfg.data.datasets.length > 1;
  o.plugins.tooltip = obj(o.plugins.tooltip) ? o.plugins.tooltip : {};
  if (o.plugins.tooltip.enabled === undefined) o.plugins.tooltip.enabled = true;
  if (!radial) {
    o.scales = obj(o.scales) ? o.scales : {};
    for (const ax of ['x', 'y']) {
      const s = o.scales[ax] = obj(o.scales[ax]) ? o.scales[ax] : {};
      s.grid = obj(s.grid) ? s.grid : {};
      if (s.grid.color === undefined) s.grid.color = VISUAL_GRID;
      s.ticks = obj(s.ticks) ? s.ticks : {};
      if (s.ticks.color === undefined) s.ticks.color = VISUAL_TEXT;
    }
    const valueAxis = o.indexAxis === 'y' ? 'x' : 'y';
    if (cfg.type === 'bar' && o.scales[valueAxis].beginAtZero === undefined) o.scales[valueAxis].beginAtZero = true;
  }
  return cfg;
}
async function renderChartBlock(el, source) {
  const cfg = chartConfig(source);   // a bad config fails before any library loads
  await chartInit();
  if (!el.isConnected) return;
  const body = document.createElement('div');
  body.className = 'visual-body';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  body.appendChild(canvas);
  visualMount(el, 'chart', body, false);
  try { visualCharts.add(new window.Chart(canvas, cfg)); }
  catch (e) { throw new Error('chart could not be built' + (e && e.message ? `: ${String(e.message).slice(0, 140)}` : '')); }
}

// HTML: a sealed frame. sandbox="allow-scripts" only (no same-origin, forms, popups or top
// navigation), no referrer, and a CSP at the top of the document that allows nothing from the
// network: inline script and style, data:/blob: images, data: fonts.
function sealedHtmlDocument(source) {
  // The hub's own document: the CSP meta is the first thing in a <head> the hub wrote, so nothing in
  // the author's markup (a comment holding "<head>", its own <head>, a doctype) can come before it.
  // The author's content goes in the body; stray <html>/<head>/<body> tags in it are merged by the parser.
  return '<!DOCTYPE html><html><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${VISUAL_CSP}">`
    + `<style>html{background:${VISUAL_SURFACE};color:#ffffff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}body{margin:8px}</style>`
    + `</head><body>${String(source ?? '')}</body></html>`;
}
async function renderHtmlBlock(el, source) {
  if (!el.isConnected) return;
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-scripts');
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.setAttribute('loading', 'lazy');
  f.setAttribute('title', 'html block');
  f.className = 'visual-frame';
  f.srcdoc = sealedHtmlDocument(source);
  const body = document.createElement('div');
  body.className = 'visual-body';
  body.appendChild(f);
  visualMount(el, 'html', body, true);
}

const VISUAL_RENDERERS = { svg: renderSvgBlock, mermaid: renderMermaidBlock, chart: renderChartBlock, html: renderHtmlBlock };
// The shared post-render pass: call after any message HTML is inserted or updated. Safe to call
// again on the same element (rendered placeholders are skipped) and never throws.
function renderVisualBlocks(root) {
  const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
  for (const c of visualCharts) {
    if (!c.canvas || !c.canvas.isConnected) { try { c.destroy(); } catch {} visualCharts.delete(c); }
  }
  let list;
  try { list = scope.querySelectorAll('.visual[data-kind]:not([data-rendered])'); } catch { return; }
  list.forEach(el => {
    el.dataset.rendered = '1';
    const kind = el.dataset.kind;
    const run = VISUAL_RENDERERS[kind];
    const src = el.querySelector(':scope > .visual-src');
    if (!run || !src) return;
    const source = src.textContent;
    Promise.resolve().then(() => run(el, source)).catch(err => {
      visualFail(el, `${kind}: ${err && err.message ? err.message : 'could not render'}`);
    });
  });
}
// Safety net: any message painted by a path that forgot the explicit call still gets drawn.
if (window.MutationObserver && document.body) {
  let visualPassPending = false;
  new MutationObserver(() => {
    if (visualPassPending) return;
    visualPassPending = true;
    requestAnimationFrame(() => { visualPassPending = false; renderVisualBlocks(document); });
  }).observe(document.body, { childList: true, subtree: true });
}

function formatContent(content) {
  const { thinking, response } = parseThinking(content);
  const thinkHtml = thinking ? `<div class="thinking">${esc(thinking)}</div>` : '';
  if (!response) return thinkHtml || '<span style="opacity:.5">...</span>';

  // Closed ```svg / ```mermaid / ```chart / ```html fences become visual placeholders (drawn by
  // renderVisualBlocks). They are held out first, before the image/link/table passes and the
  // inline formatting, so their source reaches the renderer byte for byte (escaped here, inside
  // <pre><code>; never parsed as markup). Other fences take the usual code-block path below.
  // R3: per-render, unguessable markers (same approach as app.js formatContent). Model or user text cannot
  // predict one, so a marker for one kind cannot be smuggled inside another kind's content (e.g. a table
  // marker inside image alt text) and then be substituted. The ~ terminates the index; markers are plain
  // [a-z0-9~], untouched by escaping and inline formatting.
  const MARK = 'm' + ((window.crypto && crypto.getRandomValues) ? Array.from(crypto.getRandomValues(new Uint8Array(16)), b => (b % 36).toString(36)).join('') : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
  const mk = (kind, i) => `${MARK}${kind}${i}~`;
  const visuals = [];
  const withVisuals = response.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => {
    const kind = visualKind(lang);
    if (!kind) return m;
    visuals.push(visualPlaceholder(kind, esc(code)));
    return mk('V', visuals.length - 1);
  });

  const images = [];
  let text = withVisuals.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, src) => {
    let imgSrc = src;
    if (src.startsWith('/') && !src.startsWith('/api/')) {
      try { imgSrc = '/api/image/' + btoa(src); } catch { imgSrc = null; }
    }
    images.push({ alt, src: imgSrc });
    return mk('I', images.length - 1);
  });
  const links = [];
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, url) => {
    links.push({ label, url });
    return mk('L', links.length - 1);
  });
  const tables = [];
  text = text.replace(/(^|\n)(\|[^\n]+\|\s*\n\|(?:\s*:?-+:?\s*\|)+\s*\n(?:\|[^\n]+\|\s*\n?)+)/g, (m, lead, body) => {
    const lines = body.trim().split('\n');
    const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    const cell = (c) => esc(c.trim()).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
    let html = '<table><thead><tr>' + cells(lines[0]).map(h => `<th>${cell(h)}</th>`).join('') + '</tr></thead><tbody>';
    for (const row of lines.slice(2)) html += '<tr>' + cells(row).map(c => `<td>${cell(c)}</td>`).join('') + '</tr>';
    tables.push(html + '</tbody></table>');
    return lead + mk('T', tables.length - 1);
  });

  let out = escapeHtml(text)   // all five characters: the autolinker below relies on quotes being entities, never raw
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    // A whole line in underscores is italic: the hub's one-line notices (same rule as app.js formatContent).
    .replace(/(^|\n)_(?=[^\s_])([^\n]*?[^\s_])_(?=\n|$)/g, '$1<em>$2</em>');
  // Bare URLs: strict charset, cut before any quote or angle bracket (the text is already escaped).
  out = autolinkEscaped(out).replace(/\n/g, '<br>');

  visuals.forEach((v, i) => { out = out.replace(mk('V', i), () => v); });
  images.forEach((im, i) => {
    const tag = imageHtml(im.src, im.alt);
    out = out.replace(mk('I', i), () => tag);
  });
  links.forEach((l, i) => {
    const u = safeLinkUrl(l.url);
    const tag = u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>` : `<code>[blocked link: ${esc(l.label)}]</code>`;
    out = out.replace(mk('L', i), () => tag);
  });
  tables.forEach((t, i) => { out = out.replace(mk('T', i), () => t); });
  return thinkHtml + out;
}

function originLabel(origin) {
  switch (origin?.kind) {
    case 'user': return origin.label || 'replying to you';
    case 'consultation': return `consulted by ${origin.from || 'another agent'}`;
    case 'job_notice': return `job finished${origin.jobName ? `: ${origin.jobName}` : ''}`;
    case 'job_report': return `job report from ${origin.from || 'a worker'}${origin.jobName ? ` (${origin.jobName})` : ''}`;
    case 'schedule': return `scheduled task${origin.from ? `: ${origin.from}` : ''}`;
    case 'consult_reply': return 'queued consultation reply delivered';
    case 'comms': return 'message from a messaging channel';
    default: return 'hub turn';
  }
}

function timeLabel(ts) {
  const d = ts ? new Date(ts) : new Date();
  if (isNaN(d)) return '';
  return d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ── Agents ───────────────────────────────────────────────────────────────────

function shortModel(model) {
  return String(model || '').split('/').pop().slice(0, 28);
}

function agentByName(name) {
  return agents.find(a => a.name === name);
}

// ── Model picker (chat header) ───────────────────────────────────────────────
// Tap the model line under the agent's name: the phone's own picker lists every model the hub can reach, grouped
// like the desktop picker (vendor + who pays: "Anthropic · Subscription (Claude sign-in)", "OpenAI · API $", "Local").
// Same route as the desktop (/api/agents/:name/model); the hub's agent_updated event relabels the header. Admins only.
const MP_VENDOR = { 'claude-sdk': 'Anthropic', anthropic: 'Anthropic', 'codex-cli': 'OpenAI', codex: 'OpenAI', openai: 'OpenAI', google: 'Google', perplexity: 'Perplexity', openrouter: 'OpenRouter', lmstudio: 'Local', ollama: 'Local', omlx: 'Local', ninfer: 'Local', local: 'Local' };
const MP_VENDOR_ORDER = ['Anthropic', 'OpenAI', 'Google', 'Perplexity', 'OpenRouter', 'Local'];
const MP_ROUTE_ORDER = ['Subscription', 'API', 'Local', '?'];
function mpRoute(model, full = false) {
  const p = String(model || '').split('/')[0];
  if (p === 'claude-sdk') return full ? 'Subscription (Claude sign-in)' : 'Subscription';
  if (p === 'codex-cli' || p === 'codex') return full ? 'Subscription (ChatGPT)' : 'Subscription';
  if (['anthropic', 'openai', 'google', 'perplexity', 'openrouter'].includes(p)) return full ? 'API $' : 'API';
  if (['lmstudio', 'ollama', 'omlx', 'ninfer', 'local'].includes(p)) return 'Local';
  return '?';
}
function mpLabel(model) { const m = String(model || ''); const name = m.includes('/') ? m.slice(m.indexOf('/') + 1) : m; const r = mpRoute(m, true); return `${name} · ${r === 'API $' ? 'API $' : r.startsWith('Subscription') ? 'Subscription' : r}`; }
function mpGroups(models) {
  const groups = new Map();
  for (const m of models) {
    const p = String(m).split('/')[0]; const v = MP_VENDOR[p] || (p ? p.charAt(0).toUpperCase() + p.slice(1) : 'Other');
    const key = v === 'Local' ? 'Local' : `${v} · ${mpRoute(m, true)}`;
    const vi = MP_VENDOR_ORDER.indexOf(v);
    const rank = (vi < 0 ? MP_VENDOR_ORDER.length : vi) * 10 + MP_ROUTE_ORDER.indexOf(mpRoute(m));
    if (!groups.has(key)) groups.set(key, { rank, models: [] });
    groups.get(key).models.push(m);
  }
  return [...groups.entries()].sort((a, b) => a[1].rank - b[1].rank || a[0].localeCompare(b[0])).map(([k, g]) => [k, g.models.slice().sort((x, y) => mpLabel(x).localeCompare(mpLabel(y)))]);
}
let _modelListCache = null;
let _modelHealth = {};   // what the hub has seen each model do (lib/model-health), from /api/models
async function mpModelList() {
  if (_modelListCache && Date.now() - _modelListCache.at < 5 * 60000) return _modelListCache.models;
  const r = await api('/api/models');
  const d = await r.json();
  _modelListCache = { at: Date.now(), models: d.models || [] };
  _modelHealth = d.health || {};
  return _modelListCache.models;
}
// " — ⚠ blocked by the privacy setting" after a model's name when its last reply or test failed for a reason that
// belongs to the model; nothing otherwise.
function healthNote(h) { return h && (h.state === 'fail' || h.state === 'warn') && h.short ? ` — ⚠ ${h.short}` : ''; }
// Before an agent moves to a model this hub hasn't seen answer, one tiny test request (POST /api/models/test): a
// refusal or a model that can't use tools is caught here, with the reason and what to do, not in the agent's next
// reply. Subscription models (Claude, Codex) are not tested per request.
async function testBeforeSwitch(model) {
  if (!String(model).includes('/') || /^(claude-sdk|codex-cli|codex)\//.test(model)) return true;
  const h = _modelHealth[model];
  if (h && h.state === 'ok') return true;   // it has answered here
  const name = String(model).split('/').pop();
  toast(`Testing ${name} before switching…`, 90000);
  let r = null;
  try {
    const resp = await api('/api/models/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
    r = await resp.json().catch(() => null);
    if (!resp.ok || !r) throw new Error((r && r.error) || `HTTP ${resp.status}`);
  } catch (e) { $('toast').classList.remove('on'); return confirm(`Couldn't test ${name}: ${e.message}\n\nSwitch anyway?`); }
  _modelListCache = null;   // the picker picks up the new mark (or its absence) when it refills
  const passed = r.ok !== undefined ? r.ok : r.success;   // r.success: the answer of a hub not yet restarted
  if (passed && r.toolCall !== false) { toast(`✓ ${name} works here${r.ms != null ? ` (${(r.ms / 1000).toFixed(1)} s)` : ''}`); return true; }
  $('toast').classList.remove('on');
  return confirm(`${r.title || `${name} may not work here.`} ${r.what || r.error || ''}\n\nWhat to do: ${r.fix || 'pick another model.'}\n\nSwitch anyway?`);
}
async function fillModelPick() {
  const sel = $('chat-model-pick'); const wrap = sel && sel.parentElement;
  if (!sel) return;
  const a = agentByName(current);
  if (!a || !isAdmin()) { sel.hidden = true; wrap && wrap.classList.remove('pickable'); return; }
  try {
    const models = await mpModelList();
    if (agentByName(current) !== a) return;   // the user moved on while the list loaded
    const cur = String(a.model || '');
    let html = '';
    if (cur && !models.includes(cur)) html += `<option value="${esc(cur)}">${esc(mpLabel(cur))} (current)</option>`;
    // The OpenRouter group ends with a search over OpenRouter's whole catalogue (the picker lists only the ticked models).
    for (const [label, rows] of mpGroups(models)) html += `<optgroup label="${esc(label)}">` + rows.map(m => `<option value="${esc(m)}">${esc(mpLabel(m) + healthNote(_modelHealth[m]))}</option>`).join('') + (label.startsWith('OpenRouter') ? `<option value="${OR_MORE}">🔎 More OpenRouter models…</option>` : '') + '</optgroup>';
    sel.innerHTML = html; sel.value = cur; sel.dataset.agent = a.name;
    sel.hidden = !html; wrap && wrap.classList.toggle('pickable', !!html);
  } catch (e) { sel.hidden = true; wrap && wrap.classList.remove('pickable'); }
}
// Reasoning effort next to the model (lib/effort): admins pick it for any agent, members see what their admin set.
const EFFORT_LABEL = { default: 'Default effort', low: 'Low effort', medium: 'Medium effort', high: 'High effort', xhigh: 'Extra high effort', max: 'Max effort' };
function effortSupported(model) {
  const m = String(model || ''); const p = m.split('/')[0]; const n = m.slice(m.indexOf('/') + 1).toLowerCase();
  if (p === 'claude-sdk' || p === 'codex-cli' || p === 'anthropic') return true;
  if (p === 'openai') return /^(gpt-5|gpt-6|o[1-9])/.test(n);
  if (p === 'google') return /gemini-(2\.5|[3-9])|gemini-(pro|flash)(-lite)?-latest/.test(n);
  if (p === 'openrouter') return orReasons(n);
  return false;
}
// OpenRouter: its catalogue says which models take a reasoning level (lib/effort reads the same flag). The app learns
// it from GET /api/openrouter (admins only, the same list the "More OpenRouter models" sheet uses); until it has
// arrived, or for members, the effort picker stays hidden, and it repaints once the list is in.
let orCatalogueTriedAt = 0;
function orReasons(id) {
  const v = orSheetView && orSheetView.view;
  if (!v) { orLoadCatalogue(); return false; }
  const m = (v.models || []).find(x => x.id === id);
  return !!(m && m.reasoning);
}
function orLoadCatalogue() {
  if (!isAdmin() || Date.now() - orCatalogueTriedAt < 60000) return;   // one try a minute, also after a failure
  orCatalogueTriedAt = Date.now();
  (async () => {
    try {
      const r = await api('/api/openrouter'); const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok !== false) orSheetView = { at: Date.now(), view: d };
    } catch { /* stays unknown: no effort picker for OpenRouter models */ }
    if (orSheetView) fillEffortPick();
  })();
}
function fillEffortPick() {
  const wrap = $('chat-effort-wrap'); const sel = $('chat-effort-pick'); const txt = $('chat-effort');
  if (!wrap || !sel) return;
  const a = agentByName(current);
  if (!a || !effortSupported(a.model) || a.autoModel) { wrap.hidden = true; return; }
  const level = a.effort || 'default';
  if (!sel.options.length) sel.innerHTML = Object.entries(EFFORT_LABEL).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  sel.value = level; sel.dataset.agent = a.name; sel.disabled = !isAdmin();
  txt.textContent = EFFORT_LABEL[level] || level;
  wrap.classList.toggle('pickable', isAdmin());
  wrap.hidden = false;
}
async function changeEffortFromPick() {
  const sel = $('chat-effort-pick'); const name = sel.dataset.agent; const a = agentByName(name); const level = sel.value;
  if (!a || level === (a.effort || 'default')) return;
  try {
    const r = await api(`/api/agents/${encodeURIComponent(name)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ effort: level }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.success === false) { sel.value = a.effort || 'default'; toast(`Could not change the effort: ${d.error || r.status}`); return; }
    a.effort = level; fillEffortPick();
    toast(`${a.display || name}: ${EFFORT_LABEL[level]}${isBusy(name) || streams.has(name) ? ' from the next reply' : ''}`);
  } catch (e) { sel.value = a.effort || 'default'; toast(`Could not change the effort: ${e.message}`); }
}

// The open chat's context size, in the header next to the model: GET .../compaction on open and after each
// turn, and the stream's live context_health readings in between. Shown from the first reading on.
const ctxByAgent = new Map();   // agent -> { tokens, limit, pct, mode, at }
function paintCtx() {
  const el = $('chat-ctx'); if (!el) return;
  const d = ctxByAgent.get(current);
  const pct = Math.round(Number(d && d.pct) || 0);
  if (!d || (!pct && !Number(d.tokens))) { el.hidden = true; el.textContent = ''; return; }
  const at = Math.round((Number(d.at) || 0.75) * 100);
  el.textContent = `${pct}% context`;
  el.title = `${Number(d.tokens || 0).toLocaleString()} of ${Number(d.limit || 0).toLocaleString()} tokens${d.mode ? ` · compression: ${d.mode === 'off' ? 'off' : `${compactionModeLabel(d.mode)} at ${at}%`}` : ''}`;
  el.classList.toggle('hot', !!d.mode && d.mode !== 'off' && pct >= at);
  el.hidden = false;
}
async function refreshCtx(name) {
  try {
    const r = await api(`/api/agents/${encodeURIComponent(name)}/compaction`);
    if (!r.ok) return;
    ctxByAgent.set(name, await r.json());
    if (name === current) paintCtx();
  } catch {}
}
function noteCtxReading(name, g) {
  if (!name || !(Number(g.input_tokens) > 0)) return;
  const prev = ctxByAgent.get(name) || {};
  ctxByAgent.set(name, { ...prev, tokens: Number(g.input_tokens), limit: Number(g.context_limit) || prev.limit || 0, pct: Number(g.usage_percent) || 0 });
  if (name === current) paintCtx();
}

// Claude plan usage in the chat header for agents on the Claude subscription (admins; GET /api/plan-usage on load,
// every 10 minutes and on plan events): the weekly window that governs the open agent's model.
let planUsageLast = null;
async function refreshPlanUsage() {
  if (!isAdmin()) return;
  clearTimeout(refreshPlanUsage.timer);
  let next = 10 * 60000;
  try {
    const r = await api('/api/plan-usage');
    if (r.status === 403) return;
    if (r.ok) planUsageLast = await r.json(); else next = 30000;
  } catch { next = 30000; }
  // No reading yet (the hub just started): ask again every 15 s for up to 2 minutes.
  if (!planUsageLast || !planUsageLast.fetchedAt) { refreshPlanUsage.tries = (refreshPlanUsage.tries || 0) + 1; if (refreshPlanUsage.tries <= 8) next = Math.min(next, 15000); }
  else refreshPlanUsage.tries = 0;
  paintPlan();
  refreshPlanUsage.timer = setTimeout(refreshPlanUsage, next);
}
function planFamilyOf(model) {
  const id = String(model || '').replace(/^claude-sdk\//, '').replace(/\[1m\]$/i, '').replace(/^claude-/, '').toLowerCase();
  if (!id) return null;
  if (id === 'default') return 'opus';
  if (/^(fable|mythos)/.test(id)) return 'fable';
  if (/^opus/.test(id)) return 'opus';
  if (/^sonnet/.test(id)) return 'sonnet';
  if (/^haiku/.test(id)) return 'haiku';
  return null;
}
function paintPlan() {
  const el = $('chat-plan'); if (!el) return;
  const d = planUsageLast; const a = agentByName(current); const model = String((a && a.model) || '');
  const fam = planFamilyOf(model);
  const wins = d && /^claude-sdk\//.test(model) ? (d.weekly || []).filter(w => w.utilization != null && (w.family == null || (fam && w.family === fam))) : [];
  if (!wins.length) { el.hidden = true; el.textContent = ''; return; }
  const w = wins.reduce((x, y) => (Number(y.utilization) > Number(x.utilization) ? y : x));
  const pct = Math.round(Number(w.utilization));
  const levels = (d.warn && Array.isArray(d.warn.at)) ? d.warn.at : [];
  const passed = levels.filter(l => pct >= l);
  el.textContent = `${w.family ? w.label : 'Plan'} ${pct}%`;
  el.className = 'sub' + (w.rejected || pct >= 100 ? ' refused' : passed.length && passed.length === levels.length ? ' hot' : passed.length ? ' warn' : '');
  el.title = `${w.family ? w.label : 'All models'}: ${pct}% of this week's Claude plan allowance`;
  el.hidden = false;
}

async function changeModelFromPick() {
  const sel = $('chat-model-pick');
  const name = sel.dataset.agent; const a = agentByName(name); const model = sel.value;
  if (model === OR_MORE) { sel.value = a ? a.model : ''; if (a) openOrSheet(name); return; }
  if (!a || !model || model === a.model) return;
  if (!(await testBeforeSwitch(model))) { sel.value = a.model; return; }
  try {
    const r = await api(`/api/agents/${encodeURIComponent(name)}/model`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.success) { sel.value = a.model; toast(`Could not change the model: ${d.error || r.status}`); return; }
    modelChanged(a, name, model);
  } catch (e) { sel.value = a.model; toast(`Could not change the model: ${e.message}`); }
}
function modelChanged(a, name, model, note = '') {
  toast((isBusy(name) || streams.has(name) ? `${a.display || name} switches to ${mpLabel(model)} after this reply` : `${a.display || name} now runs on ${mpLabel(model)}`) + note);
  if (!isBusy(name) && !streams.has(name)) { a.model = model; if (current === name) { paintChatStatus(); fillEffortPick(); } }
}

// ── OpenRouter: every model, from the chat header's picker ───────────────────────────────────────────────────────
// The picker offers only the OpenRouter models ticked in Settings → OpenRouter (8 by default, out of ~400). The last
// line of its OpenRouter group, "🔎 More OpenRouter models…", opens this sheet: a search over the whole catalogue
// (GET /api/openrouter, admins only). Tapping a model adds it to that list (POST /api/openrouter), so every picker
// offers it from then on, and switches the agent to it through the usual route.
const OR_MORE = '__or_more__';
let orSheetView = null;   // { at, view }: the catalogue and the current list, reused for 10 minutes
/** The rows the search shows: tool-capable models unless `all`, every word of `q` in the id or name, newest first. */
function orSheetList(models, q, all) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  return (models || []).filter(m => (all || m.tools) && !/:batch/.test(m.id))
    .filter(m => { const hay = `${m.id} ${m.name || ''}`.toLowerCase(); return words.every(w => hay.includes(w)); })
    .sort((a, b) => (b.created || 0) - (a.created || 0));
}
/** Warnings for one OpenRouter row: from the catalogue, the privacy setting and what the hub has seen (model health). */
function orWarnings(m, { privacy, ids, health } = {}) {
  const out = []; const free = /:free$/.test(m.id);
  const paid = free && ids && ids.has(m.id.replace(/:free$/, '')) ? m.id.replace(/:free$/, '') : null;
  if (free && privacy) out.push({ level: 'block', text: `⛔ Blocked by your privacy setting${paid ? `; paid version: ${paid}` : ''}` });
  else if (free) out.push({ level: 'warn', text: 'Free version: may train on your prompts; low rate limits' });
  if (!m.tools) out.push({ level: 'warn', text: "⚠ Can't use tools" });
  if (m.context && m.context < 32000) out.push({ level: 'warn', text: `⚠ Small context window (${Math.round(m.context / 1000)}K): the hub's instructions alone take about 18K tokens` });
  const h = health && health[`openrouter/${m.id}`];
  if (h && (h.state === 'fail' || h.state === 'warn') && h.short) out.push({ level: 'warn', text: `⚠ Last check here: ${h.short}` });
  else if (h && h.okAt) out.push({ level: 'ok', text: '✓ Works here' });
  return out;
}
/** The offered list after adding `id`: the current one (the default offer until a list is saved), without repeats. */
function orOfferWith(chosen, id) { const list = Array.isArray(chosen) ? chosen.slice() : []; if (!list.includes(id)) list.push(id); return list; }
/** One model's line under its name: what it can do, its context window, its price per million tokens in / out. */
function orMeta(m) {
  const ctx = !m.context ? '' : m.context >= 1e6 ? `${(m.context / 1e6).toFixed(m.context % 1e6 ? 1 : 0)}M context` : `${Math.round(m.context / 1000)}K context`;
  const f = (x) => { const v = Number((x * 1e6).toPrecision(12)); return v === 0 ? '0' : v < 0.1 ? v.toFixed(3) : v < 10 ? v.toFixed(2) : v.toFixed(0); };
  const price = m.prompt == null || m.completion == null ? '' : `$${f(m.prompt)} / $${f(m.completion)} per M`;
  const can = `${m.tools ? '🛠' : ''}${m.reasoning ? ' 🧠' : ''}${m.images ? ' 🖼' : ''}`.trim();
  return [can, ctx, price].filter(Boolean).join(' · ');
}
async function openOrSheet(name) {
  const sheet = $('or-sheet'); const a = agentByName(name);
  if (!sheet || !a) return;
  if (!sheet.dataset.ready) {
    sheet.innerHTML = `
      <h3 id="ors-title">OpenRouter models</h3>
      <div class="ors-hint">Tap a model to switch to it. It's also added to your OpenRouter list, so every model picker offers it from now on.</div>
      <input type="search" id="ors-q" placeholder="grok, deepseek, kimi, qwen, llama…" autocomplete="off" enterkeyhint="search">
      <label class="ors-all"><input type="checkbox" id="ors-all"> Show models without tools</label>
      <div class="ors-msg" id="ors-msg"></div>
      <div class="ors-list" id="ors-list"></div>
      <div class="ors-legend">🛠 can use tools (agents need this) · 🧠 takes a reasoning level · 🖼 reads images · price in / out per million tokens</div>
      <div class="ors-close"><button id="ors-close">Close</button></div>`;
    $('ors-q').addEventListener('input', orSheetRender);
    $('ors-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
    $('ors-all').addEventListener('change', orSheetRender);
    $('ors-close').addEventListener('click', () => sheet.close());
    $('ors-list').addEventListener('click', onOrSheetClick);
    sheet.dataset.ready = '1';
  }
  sheet.dataset.agent = name;
  $('ors-title').textContent = `OpenRouter models · ${a.display || name}`;
  $('ors-q').value = '';
  if (!sheet.open) sheet.showModal();
  try { await mpModelList(); } catch { /* no marks, the rows still show */ }
  if (!orSheetView || Date.now() - orSheetView.at > 10 * 60000) {
    $('ors-msg').textContent = 'Loading the OpenRouter list…'; $('ors-list').innerHTML = '';
    try {
      const r = await api('/api/openrouter'); const d = await r.json().catch(() => ({}));
      if (!r.ok || d.ok === false) throw new Error(d.error || `HTTP ${r.status}`);
      orSheetView = { at: Date.now(), view: d };
    } catch (e) { $('ors-msg').textContent = `Could not load the OpenRouter list: ${e.message}`; return; }
  }
  orSheetRender();
}
function orSheetRender() {
  const sheet = $('or-sheet'); const list = $('ors-list'); const msg = $('ors-msg');
  if (!sheet || !list || !orSheetView) return;
  const v = orSheetView.view; const a = agentByName(sheet.dataset.agent);
  const cur = String(a?.model || ''); const offered = new Set(v.chosen || []);
  const ids = new Set((v.models || []).map(m => m.id));
  const warn = (m) => orWarnings(m, { privacy: v.privacy, ids, health: _modelHealth });
  const blocked = (m) => (warn(m).some(w => w.level === 'block') ? 1 : 0);
  const rows = orSheetList(v.models, $('ors-q').value, $('ors-all').checked).sort((a, b) => blocked(a) - blocked(b));   // blocked ones last
  const shown = rows.slice(0, 150);
  msg.textContent = !v.hasKey ? 'No OpenRouter key yet: add one in Settings → LLM Providers on the full page.'
    : rows.length ? `${rows.length} model${rows.length === 1 ? '' : 's'}, newest first${rows.length > shown.length ? `. Showing ${shown.length}: type to narrow it down.` : '.'}` : 'No model matches.';
  list.innerHTML = shown.map(m => {
    const isCur = `openrouter/${m.id}` === cur;
    const tag = isCur ? '<small>current</small>' : offered.has(m.id) ? '<small>✓ in your list</small>' : '';
    const notes = warn(m).map(w => `<span class="ors-warn ${w.level}">${esc(w.text)}</span>`).join('');
    return `<button type="button" class="ors-row${isCur ? ' cur' : ''}" data-id="${esc(m.id)}"><span class="ors-name">${esc(m.name || m.id)} ${tag}</span><span class="ors-id">${esc(m.id)}</span><span class="ors-meta">${esc(orMeta(m))}</span>${notes}</button>`;
  }).join('');
}
async function onOrSheetClick(e) {
  const btn = e.target.closest('.ors-row'); if (!btn) return;
  const sheet = $('or-sheet'); const name = sheet.dataset.agent; const a = agentByName(name);
  const id = btn.dataset.id; const model = `openrouter/${id}`;
  if (!a) return;
  if (model === a.model) { sheet.close(); return; }
  const v = orSheetView ? orSheetView.view : {};
  btn.disabled = true; $('ors-msg').textContent = `Testing ${id}…`;
  if (!(await testBeforeSwitch(model))) { btn.disabled = false; $('ors-msg').textContent = `Not switched: ${a.display || name} stays on ${shortModel(a.model)}.`; return; }
  $('ors-msg').textContent = `Switching ${a.display || name} to ${id}…`;
  let note = '';
  if (!(v.chosen || []).includes(id)) {   // add it to the offer first, so the picker lists it from now on
    note = '. It could not be added to the OpenRouter list';
    try {
      const r = await api('/api/openrouter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ models: orOfferWith(v.chosen, id) }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok !== false) { orSheetView = { at: Date.now(), view: d }; if ((d.chosen || []).includes(id)) note = ''; }
    } catch { /* the note says so */ }
    _modelListCache = null;
  }
  try {
    const r = await api(`/api/agents/${encodeURIComponent(name)}/model`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.success) { btn.disabled = false; $('ors-msg').textContent = `Could not change the model: ${d.error || r.status}`; return; }
  } catch (err) { btn.disabled = false; $('ors-msg').textContent = `Could not change the model: ${err.message}`; return; }
  sheet.close();
  modelChanged(a, name, model, note);
  if (current === name) fillModelPick();
}

function displayName(name) {
  const a = agentByName(name);
  return a?.display || name;
}

async function loadAgents() {
  try {
    const r = await api('/api/agents' + (hubMe && hubMe.isAdmin ? `?owner=${encodeURIComponent(ownerView())}` : ''));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    agents = (await r.json()).agents || [];
    if (agents.some(a => 'busy' in a)) {
      const map = {};
      for (const a of agents) map[a.name] = { busy: a.busy, busySince: a.busySince, activity: a.activity, pendingQuestion: a.pendingQuestion };
      applySnapshot(map, false);
    }
  } catch (e) {
    toast(`Could not load agents: ${e.message}`);
  }
  renderAgents();
}

// ── Live status (hub events, with /api/agents/status as the fallback) ────────

function elapsed(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!(ms >= 0)) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return `${Math.max(1, Math.floor(ms / 1000))}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

function setLive(name, patch) {
  if (!name) return;
  const cur = live[name] || { busy: false, busySince: null, activity: null, pendingQuestion: false };
  const next = { ...cur, ...patch };
  if (!next.busy) { next.busySince = null; next.activity = null; next.pendingQuestion = false; }
  else if (!next.busySince) next.busySince = cur.busySince || new Date().toISOString();
  live[name] = next;
}

function applySnapshot(map, repaint = true) {
  if (!map || typeof map !== 'object') return;
  statusKnown = true;
  for (const [name, s] of Object.entries(map)) setLive(name, { busy: !!s.busy, busySince: s.busySince || null, activity: s.activity || null, pendingQuestion: !!s.pendingQuestion });
  for (const name of Object.keys(live)) if (!(name in map)) setLive(name, { busy: false });
  if (repaint) paintStatus();
  // Woke up (or just loaded) while the open chat's agent is mid-turn: follow that turn.
  if (current && map[current] && map[current].busy && !Object.values(hubTurns).some(t => t.agent === current)) reattachIfIdle(current);
}

async function pollStatus() {
  try {
    const r = await api('/api/agents/status', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return;   // 404 on an older hub: nothing to show
    const d = await r.json();
    if (d && d.agents) applySnapshot(d.agents);
  } catch {}
  pollApprovals();
}

function isBusy(name) {
  const s = live[name];
  return streams.has(name) || !!(s && (s.busy || s.pendingQuestion));
}

// True while this device is running or re-attaching a reply for the agent: the send button
// is Stop for that chat only.
function ownTurnFor(name) {
  return !!name && (streams.has(name) || reattaches.has(name));
}

function busyNames() {
  return agents.map(a => a.name).filter(isBusy);
}

function busyText(name) {
  const s = live[name];
  const since = (s && s.busySince) || null;
  const e = elapsed(since);
  if (s && s.pendingQuestion) return `❓ waiting for your answer${e ? ` · ${e}` : ''}`;
  const activity = (s && s.activity) || (streams.has(name) ? 'replying to you' : 'working');
  return `⏳ ${activity}${e ? ` · ${e}` : ''}`;
}

function paintStatus() {
  if (screen === 'agents') renderAgents();
  paintChatStatus();
}

// Agent settings changed elsewhere (the settings page, another device): refresh the list and the open chat's
// header without a reload. The server uses the new model from the next turn; a busy chat relabels at turn end.
let _agentUpdateTimer = null;
async function onAgentUpdated(ev) {
  if (!ev || !ev.agent) return;
  await loadAgents();
  if (screen === 'agents') renderAgents();
  const idle = () => !isBusy(current) && !streams.has(current) && !reattaches.has(current);
  const apply = () => { const a = agentByName(current); if (!a) return; $('chat-icon').textContent = a.icon || '🤖'; $('chat-name').textContent = a.display || current; paintChatStatus(); fillModelPick(); fillEffortPick(); paintPlan(); };
  if (current !== ev.agent) return;
  if (idle()) { apply(); return; }
  if (_agentUpdateTimer) clearInterval(_agentUpdateTimer);
  _agentUpdateTimer = setInterval(() => {
    if (current !== ev.agent) { clearInterval(_agentUpdateTimer); _agentUpdateTimer = null; return; }
    if (idle()) { clearInterval(_agentUpdateTimer); _agentUpdateTimer = null; apply(); }
  }, 1000);
}

function paintChatStatus() {
  const sub = $('chat-model');
  if (!current || !sub) return;
  const a = agentByName(current);
  const own = ownTurnFor(current);
  const working = isBusy(current) && !own;
  sub.textContent = working ? busyText(current) : shortModel(a?.model);
  sub.classList.toggle('working', working);
  // Stop lives in the header whenever the agent is busy: for a turn this device did not start
  // (e.g. launched on the laptop; the hub keeps turns running through disconnects) and for one
  // this device is streaming. The send button is then Interject rather than Stop.
  const stopBtn = $('chat-stop-btn');
  if (stopBtn) stopBtn.hidden = !working && !own;
  // "Notify me when done": next to the Interject button, shown exactly while a reply runs (gone when it is done).
  const bell = $('chat-notify-btn');
  if (bell) { bell.hidden = !working && !own; paintNotifyBtn(); }
  setSendMode(own);
}

// ── "Notify me when done" (the 🔔 next to Interject while a reply runs): the hub keeps who asked on the running turn and
// sends one notification to that person's devices when it ends (lib/push); turn_notify keeps every page in step. ──
const notifyArmed = {};   // agent -> turnId this person asked to be notified about
function myNotifyId() { return (hubMe && hubMe.user && hubMe.user.id) ? String(hubMe.user.id) : '*'; }
function paintNotifyBtn() {
  const bell = $('chat-notify-btn');
  if (!bell) return;
  const on = !!(current && notifyArmed[current]);
  bell.classList.toggle('on', on);
  bell.setAttribute('aria-pressed', on ? 'true' : 'false');
  bell.title = on ? 'You will get a notification when this reply is done. Tap to cancel.' : 'Get a notification when this reply is done';
}
function applyTurnNotify(agent, turn) {
  if (!agent || !turn) return;
  notifyArmed[agent] = (turn.active !== false && !turn.ended && Array.isArray(turn.notify) && turn.notify.includes(myNotifyId())) ? turn.turnId : null;
  if (agent === current) paintNotifyBtn();
}
async function toggleNotifyDone() {
  const agent = current;
  if (!agent) return;
  const on = !notifyArmed[agent];
  let r, d = {};
  try {
    r = await api(`/api/agents/${encodeURIComponent(agent)}/notify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on }) });
    d = await r.json().catch(() => ({}));
  } catch { toast('Could not reach the hub'); return; }
  if (r.status === 409) { notifyArmed[agent] = null; paintNotifyBtn(); toast(`${displayName(agent)} is not working on a reply right now`); return; }
  if (!r.ok) { toast(d.detail || d.error || 'Could not change the notification'); return; }
  notifyArmed[agent] = d.on ? d.turnId : null;
  paintNotifyBtn();
  if (d.on && !d.devices) toast('Notifications are off on this phone: turn them on in the ⋮ menu first', 6000);
  else toast(d.on ? `🔔 You will get a notification when ${displayName(agent)} is done` : 'Notification cancelled');
}
function onTurnNotify(ev) {
  if (!ev || !ev.agent || String(ev.userId) !== myNotifyId()) return;   // someone else's bell
  notifyArmed[ev.agent] = ev.on ? ev.turnId : null;
  if (ev.agent === current) paintNotifyBtn();
}

// Stop for a reply this device is streaming (or re-attaching) for the given agent only;
// other agents' streams keep running in their own chats.
function stopOwnTurn(agent) {
  const running = streams.get(agent);
  if (running) { stopTurn(agent); running.controller.abort(); return; }
  const ra = reattaches.get(agent);
  if (ra) stopReattach(ra);
}

async function stopRemoteTurn() {
  if (!current) return;
  if (ownTurnFor(current)) { stopOwnTurn(current); return; }
  if (!confirm(`Stop ${displayName(current)}'s current turn?`)) return;
  const r = await stopTurn(current);
  toast(r && r.ok ? `${displayName(current)} stopped` : `${displayName(current)} was not running`);
  setLive(current, { busy: false });
  paintStatus();
  paintChatStatus();
}

// ── Provider pacing: slim amber bar under the header of every screen while a provider runs
// one call at a time (rate limit / outage) or ramps back up. status_snapshot gives the whole
// picture, provider_paced / provider_ramp upsert, provider_recovered deletes; /api/hub/status
// is polled while the event stream is down. Older hubs send no `pacing`: the map stays empty.
const PACING_REASONS = { rate_limit: 'rate limit', overloaded: 'provider overloaded', timeout: 'network timeouts' };
const PACING_PROVIDERS = { 'claude-sdk': 'Claude', anthropic: 'Claude API', openai: 'OpenAI', google: 'Gemini', 'codex-cli': 'Codex', codex: 'Codex', lmstudio: 'LM Studio', perplexity: 'Perplexity' };
const pacing = new Map();      // provider -> { provider, limit, cap, reason, until, mode }
let pacingTimer = null;
let pacingTarget = null;       // provider the confirm dialog is about
const HUB_POLL_MS = 30000;

function pacingName(p) { return PACING_PROVIDERS[p] || String(p || 'provider'); }
function pacingReason(r) { return PACING_REASONS[r] || (r ? String(r).replace(/_/g, ' ') : 'slowing down'); }
function pacingLeft(until) {
  const ms = until ? Date.parse(until) - Date.now() : 0;
  if (!(ms > 0)) return null;
  const s = Math.ceil(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}
function pacingLine(e) {
  const who = pacingName(e.provider);
  if (e.mode === 'ramping') return `⚠ ${who} ramping ${e.limit}/${e.cap}`;
  return `⚠ ${who} one at a time · ${pacingReason(e.reason)} · ${pacingLeft(e.until) || 'cooling off done'}`;
}
function pacingSummary() {
  if (pacing.size === 1) return pacingLine(pacing.values().next().value);
  const names = [...pacing.values()].map(e => pacingName(e.provider)).join(', ');
  return `⚠ ${pacing.size} providers slowed: ${names} · tap for details`;
}
function applyPacing(list) {
  if (!Array.isArray(list)) return;
  pacing.clear();
  for (const e of list) if (e && e.provider) pacing.set(e.provider, { ...e, mode: e.mode === 'ramping' ? 'ramping' : 'paced' });
  paintPacing();
}
function upsertPacing(e, mode) {
  if (!e || !e.provider) return;
  pacing.set(e.provider, { ...(pacing.get(e.provider) || {}), ...e, mode });
  paintPacing();
}
function clearPacing(provider) {
  if (provider) pacing.delete(provider); else pacing.clear();
  paintPacing();
}
async function pollHubStatus() {
  try {
    const r = await api('/api/hub/status', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return;
    const d = await r.json();
    if (d && d.pacing) applyPacing(d.pacing.paced);
  } catch {}
}
function paintPacing() {
  const bars = document.querySelectorAll('.pacing-bar');
  if (!pacing.size) {
    for (const b of bars) { b.classList.remove('on'); b.innerHTML = ''; }
    if (pacingTimer) { clearInterval(pacingTimer); pacingTimer = null; }
    return;
  }
  // One line, always: a single slowed provider shows its own state; several collapse to a count
  // (four stacked lines under the header on every screen was far too much space).
  const summary = pacingSummary();
  for (const b of bars) { if (b.textContent !== summary) b.textContent = summary; b.classList.add('on'); }
  if (!pacingTimer) pacingTimer = setInterval(paintPacing, 1000);   // the countdown ticks
}
function confirmPacingReset() {
  if (!pacing.size || !isAdmin()) return;
  const entries = [...pacing.values()];
  const all = entries.length > 1;
  pacingTarget = all ? null : entries[0].provider;
  const detail = entries.map(e => pacingLine(e).replace(/^⚠ /, '')).join('\n');
  const slowed = entries.filter(e => e.mode !== 'ramping');
  const why = slowed.length ? ` The hub slowed ${all ? 'them' : 'it'} down after ${slowed.length === 1 ? `a ${pacingReason(slowed[0].reason)}` : 'failures'}; going early may hit it again.` : '';
  $('pacing-text').textContent = `${detail}\n\nResume full parallel for ${all ? 'all of them' : pacingName(pacingTarget)} now?${why}`;
  $('pacing-yes').textContent = all ? 'Resume all' : 'Resume';
  $('pacing-confirm').showModal();
}
async function resetPacing() {
  $('pacing-confirm').close();
  const provider = pacingTarget;
  pacingTarget = null;
  try {
    const r = await api('/api/hub/pacing/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(provider ? { provider } : {}),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json().catch(() => null);
    if (d && Array.isArray(d.paced)) applyPacing(d.paced);
    else if (d && d.pacing && Array.isArray(d.pacing.paced)) applyPacing(d.pacing.paced);
    else clearPacing(provider);
    toast(provider ? `${pacingName(provider)} back to full speed` : 'All providers back to full speed');
  } catch (err) {
    toast(`Could not resume: ${err.message}`);
  }
}

function renderWorkingChip() {
  const chip = $('working-chip');
  if (!chip) return;
  const names = busyNames();
  if (!names.length) { workingFilter = false; chip.classList.remove('on', 'filtering'); chip.textContent = ''; return; }
  const label = names.map(displayName).join(', ');
  chip.textContent = workingFilter ? `Showing only ${label} ✕` : `${label} working…`;
  chip.classList.add('on');
  chip.classList.toggle('filtering', workingFilter);
}

function renderAgents() {
  const list = $('agents-list');
  renderWorkingChip();
  if (!agents.length) { list.innerHTML = '<div class="empty">No agents found.</div>'; return; }
  const known = new Set(GROUPS.map(g => g.key));
  const groups = GROUPS.map(g => ({ ...g, items: agents.filter(a => (a.category || 'worker') === g.key) }));
  const extra = [...new Set(agents.map(a => a.category || 'worker'))].filter(c => !known.has(c));
  for (const c of extra) groups.push({ key: c, title: c, items: agents.filter(a => a.category === c) });
  let html = '';
  for (const g of groups) {
    if (workingFilter) g.items = g.items.filter(a => isBusy(a.name));
    if (!g.items.length) continue;
    const isCollapsed = !workingFilter && !!collapsed[g.key];
    html += `<button class="group-title" data-group="${esc(g.key)}"><span>${esc(g.title)} (${g.items.length})</span><span>${isCollapsed ? '&#x25B8;' : '&#x25BE;'}</span></button>`;
    if (isCollapsed) continue;
    for (const a of g.items.slice().sort((x, y) => (!!x.lead !== !!y.lead) ? (x.lead ? -1 : 1) : (x.display || x.name).localeCompare(y.display || y.name))) {
      const n = unread[a.name] || 0;
      const s = live[a.name];
      const question = !!(s && s.pendingQuestion);
      const working = isBusy(a.name);
      const dotCls = question ? ' question' : working ? ' busy' : statusKnown ? ' idle' : '';
      const sub = working
        ? `<div class="agent-model working${question ? ' question' : ''}">${esc(busyText(a.name))}</div>`
        : `<div class="agent-model" title="${esc(a.blurb || '')}">${esc(a.blurb || shortModel(a.model))}</div>`;
      html += `<button class="agent-row${working ? ' is-busy' : ''}" data-agent="${esc(a.name)}">` +
        `<span class="agent-icon">${esc(a.icon || '🤖')}</span>` +
        `<span class="agent-meta"><div class="agent-name">${esc(a.display || a.name)}${a.lead ? ' <span class="lead-badge" title="Lead agent">👑</span>' : ''}</div>${sub}</span>` +
        `<span class="dot${dotCls}" title="${esc(working ? busyText(a.name) : '')}">${question ? '?' : ''}</span>` +
        (n ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : '') +
        '</button>';
    }
  }
  if (!html) html = '<div class="empty">No agent is working right now.</div>';
  list.innerHTML = html;
}

function updateDots() {
  const total = Object.values(unread).reduce((s, n) => s + n, 0);
  const c = $('chat-unread');
  c.textContent = total > 99 ? '99+' : String(total);
  c.classList.toggle('on', total > 0);
  const a = $('act-unread');
  a.textContent = actUnseen > 99 ? '99+' : String(actUnseen);
  a.classList.toggle('on', actUnseen > 0 && screen !== 'activity');
  // Actions waiting for approval (any agent): amber count on the Agents tab.
  const ap = $('agents-approvals');
  if (ap) { ap.textContent = String(approvals.size); ap.classList.toggle('on', approvals.size > 0); }
}

// ── Navigation ───────────────────────────────────────────────────────────────

function show(name) {
  screen = name;
  for (const s of ['agents', 'chat', 'activity']) {
    $(`screen-${s}`).classList.toggle('active', s === name);
    $(`tab-${s}`).classList.toggle('active', s === name);
  }
  $('menu').classList.remove('open');
  if (name === 'agents') renderAgents();
  if (name === 'activity') { actUnseen = 0; renderActivity(); loadActivityExtras(); }
  updateDots();
}

function hashFor(name, agent) {
  if (name === 'chat' && agent) return `#chat=${encodeURIComponent(agent)}`;
  if (name === 'activity') return '#activity';
  return location.pathname + location.search;
}

// Chat opens on top of Agents (pushState) so Android back returns to the list.
function navigate(name, agent) {
  if (name === 'chat') {
    agent = agent || current || localStorage.getItem('hub-mobile-last');
    if (!agent || !agentByName(agent)) { toast('Pick an agent first'); name = 'agents'; agent = null; }
  }
  if (name === 'agents' && screen === 'chat' && window.history.state?.pushed) { window.history.back(); return; }
  const state = { screen: name, agent: agent || null };
  const url = hashFor(name, agent);
  if (name === 'chat' && screen !== 'chat') pushRoute(state, url);
  else replaceRoute(state, url);
  applyRoute(state);
}

function pushRoute(state, url) { window.history.pushState({ ...state, pushed: true }, '', url); }
function replaceRoute(state, url) { window.history.replaceState(state, '', url); }

function applyRoute(state) {
  if (state.screen === 'chat' && state.agent) {
    if (screen === 'chat' && current === state.agent) return;
    show('chat');
    openChat(state.agent);
  }
  else show(state.screen === 'activity' ? 'activity' : 'agents');
}

function routeFromHash() {
  const h = location.hash || '';
  const m = h.match(/^#chat=(.+)$/);
  if (m) return { screen: 'chat', agent: decodeURIComponent(m[1]) };
  if (h === '#activity') return { screen: 'activity', agent: null };
  return { screen: 'agents', agent: null };
}

function goBackFromChat() {
  if (window.history.state?.pushed) window.history.back();
  else navigate('agents');
}

// ── Chat ─────────────────────────────────────────────────────────────────────

function chatEl() { return $('messages'); }

function scrollChat(force) {
  const s = $('chat-scroll');
  if (force || stick) s.scrollTop = s.scrollHeight;
}

function addNote(text) {
  const d = document.createElement('div');
  d.className = 'note';
  d.textContent = text;
  chatEl().appendChild(d);
  return d;
}

// Every bubble carries a small copy control; the text it copies is the message source
// (markdown, not the rendered HTML), kept in rawText and updated as a reply streams in.
function addCopyButton(el) {
  const b = document.createElement('button');
  b.className = 'copy';
  b.type = 'button';
  b.textContent = '⧉';
  b.setAttribute('aria-label', 'Copy message');
  b.title = 'Copy message';
  el.appendChild(b);
}

function setRaw(el, text) {
  rawText.set(el, String(text ?? ''));
}

function addUserBubble(text, images) {
  const d = document.createElement('div');
  d.className = 'msg user';
  for (const src of images || []) {
    const img = document.createElement('img');
    img.className = 'att';
    img.src = src;
    d.appendChild(img);
  }
  if (text) d.appendChild(document.createTextNode(text));
  setRaw(d, text);
  addCopyButton(d);
  chatEl().appendChild(d);
  return d;
}

function addAssistantBubble(content) {
  const d = document.createElement('div');
  d.className = 'msg assistant';
  const body = document.createElement('div');
  body.className = 'body';
  body.innerHTML = content === undefined ? '' : formatContent(content);
  d.appendChild(body);
  setRaw(d, content === undefined ? '' : content);
  addCopyButton(d);
  chatEl().appendChild(d);
  renderVisualBlocks(body);
  return { el: d, body };
}

function copyText(text) {
  const done = () => toast('Copied');
  const fail = () => toast('Could not copy');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => legacyCopy(text) ? done() : fail());
  } else {
    legacyCopy(text) ? done() : fail();
  }
}

// http:// origins on the LAN have no navigator.clipboard; a hidden textarea still works there.
function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  // Inside the open dialog, if any: while a dialog is modal, everything outside it is inert and cannot be selected.
  let host = null;
  try { host = document.querySelector('dialog:modal'); } catch { /* a browser without :modal */ }
  (host || document.querySelector('dialog[open]') || document.body).appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

// ── Reasoning panel ─────────────────────────────────────────────────────────
// The model's reasoning (Claude's summarized thinking, Codex's reasoning summary, the reasoning field of OpenRouter and
// local models) in a panel at the top of its reply bubble, outside the reply body (which repaints). Tap the header to
// open or close it, drag the grip under it for any height, ⤢ for the whole screen. Every panel starts closed, live or
// saved: the header (word count, "thinking…") shows, and a tap opens it. Text only (textContent), never markup.
// State lives on the holder (own stream, re-attach, followed turn, saved reply): holder.rsn = { text, total, live, v }.
const RSN_KEEP = 200000;   // chars kept per reply (the newest)
const RSN_HEIGHT_KEY = 'hub-mobile-reasoning-height';
const rsnHeightPref = () => { const h = Number(localStorage.getItem(RSN_HEIGHT_KEY)); return Number.isFinite(h) && h >= 60 ? h : 180; };
const rsnWords = (t) => { let n = 0; const re = /\S+/g; while (re.exec(t)) n++; return n; };
const rsnHolders = new WeakMap();   // panel element -> its holder
let rsnSheetFor = null;             // the holder shown full screen

function rsnOf(holder) {
  if (!holder.rsn) holder.rsn = { text: '', total: 0, live: false, v: 0, raf: 0 };
  return holder.rsn;
}
function rsnAdd(r, text) {
  r.text += text; r.total += text.length; r.v++;
  if (r.text.length > RSN_KEEP) r.text = r.text.slice(-RSN_KEEP);
}
// The own stream's 'reasoning' event, or a followed turn's turn_reasoning { at, text }: false when text is missing
// before it (then the hub's turn view is fetched, which has the reasoning so far).
function reasoningAdd(holder, text, at) {
  if (!holder || typeof text !== 'string' || !text) return true;
  const r = rsnOf(holder);
  r.live = true;
  if (Number.isFinite(at)) {
    if (at > r.total) return false;
    if (at + text.length <= r.total) return true;   // already shown (a replay)
    text = text.slice(r.total - at);
  }
  rsnAdd(r, text);
  reasoningSchedule(holder);
  return true;
}
// The hub's copy (turn view, saved reply). total = the turn's whole length (the text may be its newest part only).
// onlyIfLonger: keep what is shown when it already has as much (live events can be ahead of a saved copy).
function reasoningSet(holder, text, { live = false, total, onlyIfLonger = false } = {}) {
  if (!holder || typeof text !== 'string' || !text) return;
  const r = rsnOf(holder);
  const tot = Number.isFinite(total) && total >= text.length ? total : text.length;
  if (!(onlyIfLonger && r.total >= tot)) { r.text = text.length > RSN_KEEP ? text.slice(-RSN_KEEP) : text; r.total = tot; }
  r.live = live; r.v++;
  reasoningSchedule(holder);
}
// A reply in the open chat has finished (this phone's own, a re-attached one, one followed from another device): read
// the chat's history back from the hub, which saved the exchange (with its reasoning and tool calls) before the stream
// ended or turn_end went out. The local history that "Load earlier" and "Copy chat" rebuild from then holds exactly
// what the hub holds; it used to miss this phone's own exchanges and could hold a reply twice. The newest read wins;
// a read is dropped when the chat moved on meanwhile (another chat, a newer read, a new turn); the next open reads it.
async function rereadHistory(agent, attempt = 0) {
  const seq = ++histReadSeq;
  const gen = histGen;
  let hist = null;
  try {
    const r = await api(`/api/history/${encodeURIComponent(agent)}`);
    if (r.ok) { const d = await r.json(); if (Array.isArray(d.history)) hist = d.history; }
  } catch { /* tried again below */ }
  if (seq !== histReadSeq || gen !== histGen || current !== agent || streams.has(agent) || reattaches.has(agent)) return;
  if (!hist) {   // the hub did not answer: again in 1, 2, 4 s (a newer read, or the chat moving on, cancels it)
    if (attempt < 3) setTimeout(() => { if (seq === histReadSeq && gen === histGen) rereadHistory(agent, attempt + 1); }, 1000 * 2 ** attempt);
    return;
  }
  if (hist.length && hist[hist.length - 1].inProgress) hist.pop();   // a new turn's reply so far (the live turn shows it)
  chatHistory = hist; histGen++;
}
function reasoningEnd(holder) {
  const r = holder && holder.rsn;
  if (!r || !r.live) return;
  r.live = false; r.v++;
  reasoningSchedule(holder);
}
function reasoningSchedule(holder) {
  const r = holder.rsn;
  if (r && !r.raf) r.raf = requestAnimationFrame(() => { r.raf = 0; paintReasoning(holder); });
}
// Shown as plain text: a summary's **headings** (Codex writes them) lose their asterisks; a cut start is marked.
function rsnText(r) {
  return (r.total > r.text.length ? '… (the start is not kept)\n\n' : '') + r.text.replace(/\*\*([^*\n]+)\*\*/g, '$1');
}
function rsnCount(r) {
  const n = rsnWords(r.text);
  return `${n.toLocaleString()} word${n === 1 ? '' : 's'}`;
}

function paintReasoning(holder) {
  const r = holder && holder.rsn;
  const el = holder && holder.bubble && holder.bubble.el;
  if (!r || !el || !el.isConnected) return;
  let box = el.querySelector(':scope > .rsn');
  if (!box) {
    box = document.createElement('div');
    box.className = 'rsn';
    box.innerHTML =
      '<div class="rsn-head" role="button" tabindex="0">' +
        '<span class="rsn-dot"></span><span class="rsn-label">Reasoning</span><span class="rsn-count"></span>' +
        '<button type="button" class="rsn-full" aria-label="Show reasoning full screen">⤢</button><span class="rsn-chev"></span>' +
      '</div>' +
      '<div class="rsn-body"></div>' +
      '<div class="rsn-grip" aria-hidden="true"></div>';
    box.querySelector('.rsn-body').style.height = `${rsnHeightPref()}px`;
    box.classList.add('closed');   // closed until the reader opens it
    el.insertBefore(box, el.querySelector(':scope > .tsn') || (holder.bubble.body && holder.bubble.body.parentNode === el ? holder.bubble.body : el.firstChild));
  }
  rsnHolders.set(box, holder);
  box.classList.toggle('live', r.live);
  const open = !box.classList.contains('closed');
  box.querySelector('.rsn-head').setAttribute('aria-expanded', String(open));
  box.querySelector('.rsn-chev').textContent = open ? '▾' : '▸';
  box.querySelector('.rsn-count').textContent = `· ${rsnCount(r)}${r.live ? ' · thinking…' : ''}`;
  const body = box.querySelector('.rsn-body');
  if (body.dataset.v !== String(r.v)) {
    const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    body.textContent = rsnText(r);
    body.dataset.v = String(r.v);
    if (atEnd && r.live) body.scrollTop = body.scrollHeight;
  }
  if (r.live && current === holder.agent) scrollChat();   // keep a growing live panel in view (unless scrolled up)
  if (rsnSheetFor === holder) paintReasoningSheet();
}

function toggleReasoning(box) {
  const open = box.classList.contains('closed');
  box.classList.toggle('closed', !open);
  box.querySelector('.rsn-head').setAttribute('aria-expanded', String(open));
  box.querySelector('.rsn-chev').textContent = open ? '▾' : '▸';
  if (open && box.classList.contains('live')) { const body = box.querySelector('.rsn-body'); body.scrollTop = body.scrollHeight; }
}

// ⤢: the whole screen, live while the turn runs.
function openReasoningSheet(holder) {
  if (!holder || !holder.rsn) return;
  let sh = $('rsn-sheet');
  if (!sh) {
    sh = document.createElement('div');
    sh.id = 'rsn-sheet';
    sh.className = 'rsn-sheet';
    sh.setAttribute('role', 'dialog');
    sh.setAttribute('aria-modal', 'true');
    sh.setAttribute('aria-label', 'Reasoning');
    sh.innerHTML =
      '<div class="rsn-sheet-head"><span class="rsn-dot"></span><span class="rsn-sheet-title"></span><span class="rsn-sheet-count"></span>' +
      '<button type="button" class="rsn-sheet-close" aria-label="Close">✕</button></div>' +
      '<div class="rsn-sheet-body" tabindex="-1"></div>';
    sh.querySelector('.rsn-sheet-close').addEventListener('click', closeReasoningSheet);
    sh.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeReasoningSheet(); } });
    document.body.appendChild(sh);
  }
  rsnSheetFor = holder;
  const who = holder.agent ? displayName(holder.agent) : '';
  sh.querySelector('.rsn-sheet-title').textContent = who ? `Reasoning · ${who}` : 'Reasoning';
  sh.querySelector('.rsn-sheet-body').dataset.v = '';
  sh.classList.add('open');
  dialogGuard.open(sh, { close: closeReasoningSheet });   // Back and Esc close it first
  paintReasoningSheet();
  const body = sh.querySelector('.rsn-sheet-body');
  body.scrollTop = body.scrollHeight;
  body.focus({ preventScroll: true });
}
function paintReasoningSheet() {
  const sh = $('rsn-sheet');
  const r = rsnSheetFor && rsnSheetFor.rsn;
  if (!sh || !r) return;
  sh.classList.toggle('live', r.live);
  sh.querySelector('.rsn-sheet-count').textContent = `${rsnCount(r)}${r.live ? ' · thinking…' : ''}`;
  const body = sh.querySelector('.rsn-sheet-body');
  if (body.dataset.v !== String(r.v)) {
    const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    body.textContent = rsnText(r);
    body.dataset.v = String(r.v);
    if (atEnd) body.scrollTop = body.scrollHeight;
  }
}
function closeReasoningSheet() {
  const sh = $('rsn-sheet');
  if (sh) sh.classList.remove('open');
  if (sh) dialogGuard.closed(sh);
  rsnSheetFor = null;
}

// Taps on a panel (from the chat's click handler): ⤢ or the header. True when the tap was the panel's.
function onReasoningClick(e) {
  const box = e.target.closest('.rsn');
  if (!box) return false;
  if (e.target.closest('.rsn-full')) { e.stopPropagation(); openReasoningSheet(rsnHolders.get(box)); return true; }
  if (e.target.closest('.rsn-head')) { e.stopPropagation(); toggleReasoning(box); return true; }
  return true;   // a tap inside the text: nothing (and not a feed row)
}
// The grip: drag for any height (60 px to most of the screen); the size is kept for the next panels.
function onReasoningGrip(e) {
  const grip = e.target.closest && e.target.closest('.rsn .rsn-grip');
  if (!grip) return;
  e.preventDefault();
  const body = grip.closest('.rsn').querySelector('.rsn-body');
  const y0 = e.clientY, h0 = body.getBoundingClientRect().height;
  const move = (ev) => { body.style.height = `${Math.round(Math.max(60, Math.min(window.innerHeight * 0.8, h0 + ev.clientY - y0)))}px`; };
  const up = () => {
    grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
    localStorage.setItem(RSN_HEIGHT_KEY, String(parseInt(body.style.height, 10) || rsnHeightPref()));
  };
  try { grip.setPointerCapture(e.pointerId); } catch {}
  grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
}

function onMessagesClick(e) {
  if (onReasoningClick(e)) return;
  if (onToolsClick(e)) return;
  const b = e.target.closest('.copy');
  if (!b) { onFeedClick(e); return; }
  e.stopPropagation();
  const msg = b.closest('.msg');
  const text = msg ? rawText.get(msg) : undefined;
  if (text === undefined || text === '') { toast('Nothing to copy yet'); return; }
  copyText(text);
}

function chatAsMarkdown() {
  const who = displayName(current);
  const parts = [];
  for (const m of chatHistory) {
    if (m.role === 'user') parts.push(`**You:** ${m.content || ''}`);
    else if (m.role === 'assistant') parts.push(`**${who}:** ${m.content || ''}`);
  }
  const rec = streams.get(current);
  if (rec) {
    parts.push(`**You:** ${rec.text || ''}`);
    if (rec.full) parts.push(`**${who}:** ${rec.full}`);
  }
  const ra = reattaches.get(current);
  if (ra) {
    parts.push(`**You:** ${ra.text || ''}`);
    if (ra.partial) parts.push(`**${who}:** ${ra.partial}`);
  }
  return parts.join('\n\n');
}

function copyWholeChat() {
  $('menu').classList.remove('open');
  if (!current) return;
  const md = chatAsMarkdown();
  if (!md) { toast('Nothing to copy yet'); return; }
  copyText(md);
}

function renderEntry(m) {
  if (m.role === 'user') {
    if (m.origin?.kind) addNote(`⚡ ${originLabel(m.origin)} — ${timeLabel(m.ts)}`);
    addUserBubble(m.content, null);
  } else if (m.role === 'assistant') {
    const saved = Array.isArray(m.activity) && m.activity.length;
    const b = addAssistantBubble(saved ? undefined : m.content);
    if (saved) paintSaved(b, m);
    if (typeof m.reasoning === 'string' && m.reasoning) reasoningSet({ agent: current, bubble: b }, m.reasoning, { total: Number(m.reasoningChars) });
  }
}

// A saved reply with the tool calls and workers of its turn: the same layout as the live stream (paintReply).
function paintSaved(bubble, m) {
  const feed = newFeed(false);
  feed.ended = true;
  for (const a of m.activity) {
    if (!a || !a.id) continue;
    if (a.kind === 'tool') feed.items.set(a.id, { kind: 'tool', id: a.id, tool: a.tool || 'tool', status: 'done', summary: a.summary || '', output: a.output || '', open: false, el: null, at: a.at, t0: Date.parse(a.ts) || null, t1: Date.parse(a.doneTs) || null });
    else if (a.kind === 'worker') {
      const w = { kind: 'worker', id: a.id, workerId: String(a.workerId || a.id), status: a.status === 'failed' ? 'failed' : 'completed', description: a.description || '', model: a.model || '', agent: a.agent || null, error: a.error || null, text: '', tools: [], last: null, open: false, el: null, at: a.at, t0: Date.parse(a.ts) || null, t1: Date.parse(a.doneTs) || null };
      feed.items.set(a.id, w); feed.byWorker.set(w.workerId, w);
    }
  }
  const holder = { agent: current, bubble, feed };
  feed.holder = holder;
  paintReply(holder, m.content);
}

function renderHistory() {
  const box = chatEl();
  box.innerHTML = '';
  const start = Math.max(0, chatHistory.length - shown);
  if (start > 0) {
    const b = document.createElement('button');
    b.className = 'more';
    b.textContent = `Load earlier (${start} more)`;
    b.addEventListener('click', loadEarlier);
    box.appendChild(b);
  }
  for (const m of chatHistory.slice(start)) renderEntry(m);
  if (!chatHistory.length) addNote('No messages yet');
}

function loadEarlier() {
  const s = $('chat-scroll');
  const prevHeight = s.scrollHeight;
  shown = Math.min(chatHistory.length, shown + HISTORY_PAGE);
  renderHistory();
  s.scrollTop = s.scrollHeight - prevHeight;
}

// A stream or re-attach paints only while its own chat is open and its bubble is still in the page.
function bubbleLive(rec) {
  return current === rec.agent && !!rec.bubble && rec.bubble.el.isConnected;
}

async function openChat(name) {
  const a = agentByName(name);
  const same = current === name;
  if (!same && tsnSheetFor) closeToolsSheet();   // the full screen of another chat's calls
  current = name;
  localStorage.setItem('hub-mobile-last', name);
  if (!same && $('files-sheet')?.open) filesRefresh(); // the Files sheet follows the open agent
  $('chat-icon').textContent = a?.icon || '🤖';
  $('chat-name').textContent = a?.display || name;
  $('chat-model').textContent = shortModel(a?.model);
  fillModelPick(); fillEffortPick();
  paintCtx(); refreshCtx(name); paintPlan();
  if (unread[name]) { delete unread[name]; saveJson('hub-mobile-unread', unread); updateDots(); }
  // Back from another tab while this chat's own reply is still painting into the page: keep it.
  const rec = streams.get(name);
  const ra = reattaches.get(name);
  if (same && ((rec && bubbleLive(rec)) || (ra && bubbleLive(ra)))) { paintChatStatus(); return; }
  pendingImages = [];
  renderPreviews();
  if (!same) restoreDraft(name);   // each chat keeps its own draft; the box no longer carries text from another agent
  chatEl().innerHTML = '';
  addNote('Loading…');
  stick = true;
  try {
    const r = await api(`/api/history/${encodeURIComponent(name)}`);
    chatHistory = r.ok ? ((await r.json()).history || []) : [];
  } catch { chatHistory = []; }
  histGen++;
  if (current !== name) return;
  // The running turn's reply so far (saved as plain text every 5 s): the live turn is drawn in its place, with its
  // tool calls, so it is not shown twice. The hub flags it only while that turn runs.
  const inProgress = chatHistory.length && chatHistory[chatHistory.length - 1].inProgress ? chatHistory.pop() : null;
  if (inProgress && !isBusy(name)) setLive(name, { busy: true });
  shown = Math.min(chatHistory.length, HISTORY_PAGE);
  renderHistory();
  if (streams.has(name)) {
    // Back in a chat whose reply is still streaming on this device: a fresh live bubble with
    // what has arrived so far, which keeps receiving the stream.
    attachStreamBubble(streams.get(name));
  }
  if (reattaches.has(name)) {
    // Back in the chat whose reply we lost: draw a fresh waiting bubble, then check history.
    const r = reattaches.get(name);
    r.bubble = addAssistantBubble();
    r.line = null;
    r._blocks = null; r._sig = null;
    r.painted = null;
    if (r.rsn) paintReasoning(r);
    paintReattach(r, reattachLine(r));
    reattachCheck(r);
    catchUpReattach(r);
  }
  // Opened the chat of an agent that is mid-turn on the server (sent from another device, or this
  // page just loaded): follow that turn so the reply lands here without a refresh. Before the first
  // status snapshot the hub's turn endpoint says whether there is a turn to follow.
  if (!statusKnown && !streams.has(name) && !reattaches.has(name) && !inProgress) probeTurn(name);
  reattachIfIdle(name, inProgress ? String(inProgress.content || '') : '');
  // A question this agent asked while its chat was closed (parked by the ask_user event) is shown now; one the hub
  // still holds for a running turn comes with the turn view (catchUpReattach / catchUpOpenAgent).
  const parked = pendingQuestionsByAgent.get(name);
  if (parked) { pendingQuestionsByAgent.delete(name); showQuestion(parked); }
  paintChatStatus();
  scrollChat(true);
}

function attachStreamBubble(rec) {
  const last = chatHistory[chatHistory.length - 1];
  if (!(last && last.role === 'user' && last.content === rec.text)) rec.userEl = addUserBubble(rec.text, rec.images);
  const b = addAssistantBubble();
  rec.bubble = b;
  rec._blocks = null; rec._sig = null;
  if (rec.rsn) paintReasoning(rec);
  if (!rec.gotAny) { b.body.innerHTML = '<span style="opacity:.6">⏳ Thinking…</span>'; return; }
  paintReply(rec, rec.full);   // text and activity rows in the order they happened
  if (rec.question) showQuestion(rec.question, () => { rec.question = null; });
  const pq = pendingQuestionsByAgent.get(rec.agent);
  if (pq) { pendingQuestionsByAgent.delete(rec.agent); showQuestion(pq); }
}

// ── Turn activity feed: tool calls and workers inside the in-progress bubble ─────────────────
// One feed per turn holder: the own stream record (rec), a re-attach record (ra) or a turn started
// elsewhere (hubTurns entry). Every holder has { agent, bubble, seg, feed }. Rows are keyed by the
// hub's activity item id (tool_start / tool_use / tool_result share one; a worker's started and
// finished items share its workerId), so replaying GET /api/agents/<name>/turn on top of live
// events updates rows in place and never duplicates them. Rows the own stream made up locally
// (feed.local) give way to the hub's view when a turn is fetched.
const feedEls = new WeakMap();   // feed root element -> feed (tap handling)

function newFeed(local = false) {
  return { items: new Map(), byWorker: new Map(), local, seq: 0, ended: false, open: false, holder: null, el: null, head: null, list: null };
}

function holderFeed(holder) {
  if (!holder.feed) holder.feed = newFeed(false);
  holder.feed.holder = holder;
  return holder.feed;
}

function clipText(s, n) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function tailText(s, n) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `…${s.slice(-(n - 1))}` : s;
}

// One-line summary of a tool's input for rows the own stream builds (the hub does the same for
// the rows it serves).
function toolSummary(input) {
  if (input == null) return '';
  if (typeof input !== 'object') return clipText(String(input), 160);
  for (const k of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'agent', 'prompt', 'message', 'content']) {
    if (typeof input[k] === 'string' && input[k]) return clipText(input[k], 160);
  }
  try { return clipText(JSON.stringify(input), 160); } catch { return ''; }
}

function workerName(it) {
  return it.agent && agentByName(it.agent) ? displayName(it.agent) : (it.agent || it.description || 'worker');
}

// Removes the placeholder ('⏳ Thinking…', '…') or anything else that is neither the feed, the
// reply segment nor an attached image.
function clearPlaceholder(body) {
  for (const n of [...body.childNodes]) {
    if (n.nodeType === 1 && (n.classList.contains('feed') || n.classList.contains('seg') || n.tagName === 'IMG')) continue;
    n.remove();
  }
}

// ── Reply layout: text and activity in the order they happened ──────────────────────────────────
// The reply text is split where each tool call or worker started (item.at: the reply's length at that moment; from
// the hub for a fetched or followed turn, counted here for the own stream), with that group of rows between the text
// before and after it. The own stream and every catch-up (re-attach, a turn started elsewhere, a reopened chat) paint
// through paintReply, so a reconnected turn reads like one watched live. Items without a place (an older hub) go first.
function replyBlocks(holder, text) {
  const items = holder.feed ? [...holder.feed.items.values()] : [];
  const blocks = [];
  let pos = 0; let group = null;
  for (const it of items) {
    const at = Math.max(pos, Math.min(Number.isFinite(it.at) ? it.at : 0, text.length));
    if (at > pos) {
      if (group) { blocks.push(group); group = null; }
      blocks.push({ type: 'text', from: pos, to: at });
      pos = at;
    }
    if (!group) group = { type: 'group', items: [] };
    group.items.push(it);
  }
  if (group) blocks.push(group);
  if (pos < text.length || !blocks.length) blocks.push({ type: 'text', from: pos, to: text.length });
  return blocks;
}

function resetLayout(holder) {
  for (const b of holder._blocks || []) b.el?.remove();
  holder._blocks = null; holder._sig = null;
}

function paintReply(holder, text, changed = null) {
  if (!holder) return;
  if (text !== undefined) holder.replyText = String(text || '');
  else if (holder.feed && holder.feed.local && typeof holder.full === 'string') holder.replyText = holder.full;
  if (!bubbleLive(holder)) return;
  const body = holder.bubble.body;
  const full = holder.replyText || '';
  const blocks = replyBlocks(holder, full);
  const sig = blocks.map(b => (b.type === 'text' ? `t${b.from}` : `g${b.items.map(i => i.id).join(',')}`)).join('|');
  const intact = holder._blocks && holder._sig === sig && holder._blocks.every(b => b.type !== 'text' || (b.el && b.el.parentNode === body));
  if (!intact) {
    resetLayout(holder);
    for (const n of [...body.children]) if (n.classList.contains('seg') || n.classList.contains('feed')) n.remove();
    clearPlaceholder(body);
    const before = [...body.children].find(n => n.tagName === 'IMG') || null;   // attached images stay last
    for (const b of blocks) {
      if (b.type !== 'text') continue;   // the calls go into the tool panel (paintTools)
      b.el = document.createElement('div');
      b.el.className = 'seg';
      body.insertBefore(b.el, before);
    }
    holder._blocks = blocks; holder._sig = sig;
  } else {
    // Same structure: keep the elements; the last text block grows with the stream.
    blocks.forEach((b, i) => { const old = holder._blocks[i]; b.el = old.el; b.raw = old.raw; });
    holder._blocks = blocks;
  }
  paintTools(holder, blocks, changed);
  for (const b of holder._blocks) {
    if (b.type !== 'text') continue;
    const piece = full.slice(b.from, b.to);
    if (b.raw !== piece) { b.raw = piece; b.el.innerHTML = formatContent(piece.replace(/^\s*\n/, '')); renderVisualBlocks(b.el); b.el.hidden = !piece.trim(); }
  }
  setRaw(holder.bubble.el, full);
  scrollChat();
}

function setReplyText(holder, text) {
  paintReply(holder, text);   // the layout calls renderVisualBlocks( for each text block
}

// Upserts one activity item into the holder's feed and paints its row. Item shapes are the hub's:
// { kind:'tool', id, tool, status:'running'|'done', summary, output? }
// { kind:'worker', id, workerId, status:'started'|'running'|'completed'|'failed', description, model, agent, error? }
// { kind:'worker_tool', id, workerId, tool, summary }
// Where an item sits in the reply: the hub's offset, else (own stream) the length of the text so far.
function placeOf(holder, feed, item) {
  if (Number.isFinite(item.at)) return item.at;
  return feed.local ? String(typeof holder.full === 'string' ? holder.full : (holder.replyText || '')).length : 0;
}

function feedUpsert(holder, item) {
  if (!item || typeof item !== 'object' || !item.id) return null;
  const feed = holderFeed(holder);
  let it = null;
  if (item.kind === 'worker_tool') {
    const w = feed.byWorker.get(String(item.workerId));
    if (!w) return null;
    let t = w.tools.find(x => x.id === item.id);
    if (!t) { t = { id: item.id, tool: 'tool', summary: '' }; w.tools.push(t); }
    if (item.tool) t.tool = String(item.tool);
    if (item.summary) t.summary = String(item.summary);
    w.last = 'tool';
    it = w;
  } else if (item.kind === 'tool') {
    it = feed.items.get(item.id);
    if (!it) { it = { kind: 'tool', id: item.id, tool: 'tool', status: 'running', summary: '', output: '', open: false, el: null, at: placeOf(holder, feed, item), t0: Date.parse(item.ts) || Date.now(), t1: null }; feed.items.set(item.id, it); }
    if (item.tool) it.tool = String(item.tool);
    it.status = item.status === 'done' ? 'done' : 'running';
    if (it.status === 'done' && !it.t1) it.t1 = Date.parse(item.doneTs) || Date.now();
    if (item.summary) it.summary = String(item.summary);
    if (item.output != null) it.output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
  } else if (item.kind === 'worker') {
    const wid = String(item.workerId || item.id);
    it = feed.byWorker.get(wid);
    if (!it) {
      it = { kind: 'worker', id: item.id, workerId: wid, status: 'running', description: '', model: '', agent: null, error: null, text: '', tools: [], last: null, open: false, el: null, at: placeOf(holder, feed, item), t0: Date.parse(item.ts) || Date.now(), t1: null };
      feed.items.set(item.id, it);
      feed.byWorker.set(wid, it);
    }
    it.status = item.status === 'completed' ? 'completed' : item.status === 'failed' ? 'failed' : 'running';
    if (it.status !== 'running' && !it.t1) it.t1 = Date.parse(item.doneTs) || Date.now();
    if (item.description) it.description = String(item.description);
    if (item.model) it.model = String(item.model);
    if (item.agent) it.agent = String(item.agent);
    if (item.error) it.error = String(item.error);
  } else {
    return null;
  }
  paintFeed(holder, it);
  return it;
}

// Worker text: the own stream sends increments, the hub's turn_worker_delta the text so far.
function feedWorkerText(holder, workerId, text, append) {
  const feed = holderFeed(holder);
  const w = feed.byWorker.get(String(workerId));
  if (!w || typeof text !== 'string') return;
  w.text = append ? w.text + text : text;
  if (w.text.length > 16000) w.text = w.text.slice(-16000);
  w.last = 'text';
  paintFeed(holder, w);
}

function feedSummary(feed) {
  let tools = 0, workers = 0;
  for (const x of feed.items.values()) { if (x.kind === 'tool') tools++; else workers++; }
  const parts = [];
  if (tools) parts.push(`${tools} tool call${tools === 1 ? '' : 's'}`);
  if (workers) parts.push(`${workers} worker${workers === 1 ? '' : 's'}`);
  return parts.join(' · ') || 'activity';
}

// Text for the re-attach status line: the newest running row, else the newest row.
function feedStatus(feed) {
  if (!feed || !feed.items.size) return '';
  const items = [...feed.items.values()];
  const x = items.filter(r => r.status === 'running').pop() || items[items.length - 1];
  if (x.kind === 'tool') return x.status === 'running' ? `running ${x.tool}${x.summary ? `: ${clipText(x.summary, 60)}` : ''}` : `${x.tool} done`;
  const who = workerName(x);
  if (x.status === 'running') {
    const t = x.last === 'tool' ? x.tools[x.tools.length - 1] : null;
    return `worker ${who} ${t ? `running ${t.tool}` : 'working…'}`;
  }
  return `worker ${who} ${x.status === 'failed' ? 'failed' : 'finished'}`;
}

// Mounts the feed at the top of the holder's bubble (once per bubble) and paints one row, or
// every row when `it` is omitted (a bubble that was just built or rebuilt).
function paintFeed(holder, it) {
  paintReply(holder, undefined, it || null);
}

// ── Tool panel: every tool call and worker of a reply in one panel under its reasoning panel ──────────────────────
// Closed until tapped, so a reply that runs many tools no longer grows a row per call. The header updates in place:
// the calls done, a red count of the failed ones, the time; while the reply works, a second line says what runs now.
// Opened, one line per call (a tap shows its output); ⤢ shows every call with its output on the whole screen, and the
// grip sets the height. The text the agent writes between calls stays in the reply (paintReply).
const TSN_HEIGHT_KEY = 'hub-mobile-tools-height';
const tsnHeightPref = () => { const h = Number(localStorage.getItem(TSN_HEIGHT_KEY)); return Number.isFinite(h) && h >= 60 ? h : 300; };
const tsnHolders = new WeakMap();   // panel element -> holder
let tsnTimer = 0;
let tsnSheetFor = null;
let tsnSheetReturn = null;

function tsnDur(ms) {
  if (ms < 1000) return ms < 100 ? '<0.1s' : `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
function tsnFailed(it) {
  return it.kind === 'worker' ? it.status === 'failed' : it.status === 'done' && /^(Error|⚠|✗)/.test(it.output || '');
}
// The time the calls took: the union of their intervals (calls side by side count once). Null unless every call has a
// start and an end (a call cut off when the reply ended, or a reply saved by an older version, shows no total).
function tsnSpan(items) {
  if (!items.length || items.some(x => !x.t0 || !x.t1 || x.t1 < x.t0)) return null;
  const iv = items.map(x => [x.t0, x.t1]).sort((a, b) => a[0] - b[0]);
  let total = 0; let [s, e] = iv[0];
  for (const [a, b] of iv.slice(1)) { if (a > e) { total += e - s; s = a; e = b; } else if (b > e) e = b; }
  return total + (e - s);
}
function tsnModel(feed) {
  const items = [...feed.items.values()];
  const live = !feed.ended;
  const running = live ? items.filter(x => x.status === 'running') : [];
  return { items, live, running, done: items.filter(x => x.status !== 'running').length, failed: items.filter(tsnFailed).length, spanMs: tsnSpan(items) };
}
// The header's words: calls done (or running) while the reply works, the number of calls once it is over.
function tsnSummary(m) {
  const n = m.items.length;
  if (!m.live) return `${n} call${n === 1 ? '' : 's'}`;
  return m.done ? `${m.done} done` : `${m.running.length || n} running`;
}
function paintTsnHead(box, m) {
  const q = (s) => box.querySelector(s);
  const open = !box.classList.contains('closed');
  q('.tsn-head').setAttribute('aria-expanded', String(open));
  q('.tsn-chev').textContent = open ? '▾' : '▸';
  const k = m.running.length ? 'run' : m.live ? 'wait' : 'done';
  const st = q('.tsn-state');
  if (st.dataset.k !== k) { st.dataset.k = k; st.className = `tsn-state ${k}`; st.textContent = k === 'done' ? '✓' : ''; }
  q('.tsn-count').textContent = tsnSummary(m);
  const f = q('.tsn-fail');
  f.textContent = m.failed ? `${m.failed} failed` : '';
  f.hidden = !m.failed;
  const now = q('.tsn-now'), t = q('.tsn-time');
  const cur = m.running[m.running.length - 1];
  if (cur) {
    const name = document.createElement('b');
    let what;
    if (cur.kind === 'tool') { name.textContent = cur.tool; what = cur.summary ? ` · ${clipText(cur.summary, 120)}` : ''; }
    else {
      name.textContent = `👷 ${workerName(cur)}`;
      const lt = cur.tools[cur.tools.length - 1];
      what = cur.last === 'tool' && lt ? ` · ${lt.tool}${lt.summary ? ` ${clipText(lt.summary, 80)}` : ''}` : ' · working…';
    }
    now.replaceChildren('now: ', name, `${what}${m.running.length > 1 ? `  +${m.running.length - 1}` : ''}`);
    now.hidden = false;
    if (cur.t0) {
      t.dataset.started = String(cur.t0); t.textContent = tsnDur(Date.now() - cur.t0);
      if (!tsnTimer) tsnTimer = setInterval(tsnTick, 1000);
    } else { delete t.dataset.started; t.textContent = ''; }
  } else {
    now.hidden = true; now.textContent = '';
    delete t.dataset.started;
    t.textContent = !m.live && m.spanMs != null ? tsnDur(m.spanMs) : '';
  }
}
function paintTools(holder, blocks, changed) {
  const feed = holder.feed;
  const el = holder.bubble.el;
  let box = el.querySelector(':scope > .tsn');
  if (!feed || !feed.items.size) { if (box) box.remove(); return; }
  holderFeed(holder);
  if (!box) {
    box = document.createElement('div');
    box.className = 'tsn closed';   // closed until the reader opens it
    box.innerHTML =
      '<div class="tsn-head" role="button" tabindex="0">' +
        '<span class="tsn-state"></span><span class="tsn-label">Tools</span><span class="tsn-count"></span>' +
        '<span class="tsn-fail" hidden></span><span class="tsn-time"></span>' +
        '<button type="button" class="tsn-full" aria-label="Show every tool call full screen">⤢</button><span class="tsn-chev"></span>' +
      '</div>' +
      '<div class="tsn-now" hidden></div>' +
      '<div class="tsn-body"></div>' +
      '<div class="tsn-grip" aria-hidden="true"></div>';
    box.querySelector('.tsn-body').style.maxHeight = `${tsnHeightPref()}px`;
    const rsn = el.querySelector(':scope > .rsn');
    el.insertBefore(box, rsn ? rsn.nextSibling : (holder.bubble.body && holder.bubble.body.parentNode === el ? holder.bubble.body : el.firstChild));
  }
  tsnHolders.set(box, holder);
  feedEls.set(box, feed);   // a tap on a row opens that call's output (onFeedClick)
  const m = tsnModel(feed);
  box.classList.toggle('live', m.live);
  paintTsnHead(box, m);
  // The rows: rebuilt when a call starts (a thin line between the groups of calls), else updated in place.
  const list = box.querySelector('.tsn-body');
  const groups = blocks.filter(b => b.type === 'group');
  const gsig = groups.map(g => g.items.map(i => i.id).join(',')).join('|');
  if (list.dataset.sig !== gsig) {
    const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    const top = list.scrollTop;
    list.textContent = '';
    groups.forEach((g, gi) => {
      if (gi) { const s = document.createElement('div'); s.className = 'tsn-sep'; list.appendChild(s); }
      for (const it of g.items) { it.el = null; paintFeedRow(feed, it, list); }
    });
    list.dataset.sig = gsig;
    list.scrollTop = atEnd && m.live ? list.scrollHeight : top;
  } else if (changed) paintFeedRow(feed, changed);
  else for (const it of feed.items.values()) paintFeedRow(feed, it, list);
  if (m.live && !tsnTimer) tsnTimer = setInterval(tsnTick, 1000);
  if (tsnSheetFor === holder) paintToolsSheet();
}
// The time of the call running now ticks while a reply works; the timer stops when nothing runs.
function tsnTick() {
  const els = document.querySelectorAll('.tsn.live .tsn-time[data-started]');
  if (!els.length) { clearInterval(tsnTimer); tsnTimer = 0; return; }
  const now = Date.now();
  for (const t of els) { const s = Number(t.dataset.started); if (s) t.textContent = tsnDur(now - s); }
}
function toggleTools(box) {
  box.classList.toggle('closed');
  const h = tsnHolders.get(box);
  if (h && h.feed) paintTsnHead(box, tsnModel(h.feed));
  if (!box.classList.contains('closed') && box.classList.contains('live')) { const b = box.querySelector('.tsn-body'); b.scrollTop = b.scrollHeight; }
}
// Taps on a tool panel (from the chat's click handler): ⤢, the header or the "now" line. A tap on a row is the feed's.
function onToolsClick(e) {
  const box = e.target.closest('.tsn');
  if (!box) return false;
  if (e.target.closest('.tsn-full')) { e.stopPropagation(); openToolsSheet(tsnHolders.get(box)); return true; }
  if (e.target.closest('.tsn-head, .tsn-now')) { e.stopPropagation(); toggleTools(box); return true; }
  return false;
}
// The grip: drag for any height (60 px to most of the screen); the size is kept for the next panels.
function onToolsGrip(e) {
  const grip = e.target.closest && e.target.closest('.tsn .tsn-grip');
  if (!grip) return;
  e.preventDefault();
  const body = grip.closest('.tsn').querySelector('.tsn-body');
  const y0 = e.clientY, h0 = body.getBoundingClientRect().height;
  const move = (ev) => { body.style.maxHeight = `${Math.round(Math.max(60, Math.min(window.innerHeight * 0.8, h0 + ev.clientY - y0)))}px`; };
  const up = () => {
    grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
    localStorage.setItem(TSN_HEIGHT_KEY, String(parseInt(body.style.maxHeight, 10) || tsnHeightPref()));
  };
  try { grip.setPointerCapture(e.pointerId); } catch {}
  grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
}
// ⤢: every call with its output on the whole screen, live while the reply works.
function openToolsSheet(holder) {
  if (!holder || !holder.feed) return;
  let sh = $('tsn-sheet');
  if (!sh) {
    sh = document.createElement('div');
    sh.id = 'tsn-sheet';
    sh.className = 'rsn-sheet tsn-sheet';
    sh.setAttribute('role', 'dialog');
    sh.setAttribute('aria-modal', 'true');
    sh.setAttribute('aria-label', 'Tool calls');
    sh.innerHTML =
      '<div class="rsn-sheet-head"><span class="rsn-sheet-title"></span><span class="rsn-sheet-count"></span>' +
      '<button type="button" class="rsn-sheet-close" aria-label="Close">✕</button></div>' +
      '<div class="rsn-sheet-body" tabindex="0"></div>';
    sh.querySelector('.rsn-sheet-close').addEventListener('click', closeToolsSheet);
    // Esc closes it and Tab stays inside (the list, then ✕): the dialog guard does both, once (lib/ui-dialog.js).
    document.body.appendChild(sh);
  }
  tsnSheetFor = holder;
  tsnSheetReturn = document.activeElement;
  const who = holder.agent ? displayName(holder.agent) : '';
  sh.querySelector('.rsn-sheet-title').textContent = who ? `Tools · ${who}` : 'Tools';
  sh.querySelector('.rsn-sheet-body')._text = null;
  sh.classList.add('open');
  dialogGuard.open(sh, { close: closeToolsSheet });   // Back and Esc close it first
  paintToolsSheet();
  const body = sh.querySelector('.rsn-sheet-body');
  body.scrollTop = body.scrollHeight;
  body.focus({ preventScroll: true });
}
function tsnEntryText(it) {
  if (it.kind === 'tool') {
    const mark = it.status === 'running' ? '⚙' : tsnFailed(it) ? '✗' : '✓';
    return `${mark} ${it.tool}${it.summary ? ` · ${it.summary}` : ''}\n${it.status === 'running' ? 'Running…' : (it.output ? String(it.output) : '(no output)')}`;
  }
  const mark = it.status === 'completed' ? '✓' : it.status === 'failed' ? '✗' : '👷';
  const tools = it.tools.map(t => `  ⚙ ${t.tool}${t.summary ? ` · ${clipText(t.summary, 160)}` : ''}`).join('\n');
  return `${mark} ${workerName(it)}${it.model ? ` · ${shortModel(it.model)}` : ''}${it.error ? `\n⚠ ${it.error}` : ''}${tools ? `\n${tools}` : ''}${it.text ? `\n${it.text}` : ''}`;
}
function paintToolsSheet() {
  const sh = $('tsn-sheet');
  const feed = tsnSheetFor && tsnSheetFor.feed;
  if (!sh || !feed) return;
  if (!tsnSheetFor.bubble || !tsnSheetFor.bubble.el.isConnected) { closeToolsSheet(); return; }
  const m = tsnModel(feed);
  sh.classList.toggle('live', m.live);
  sh.querySelector('.rsn-sheet-count').textContent = `${tsnSummary(m)}${m.failed ? ` · ${m.failed} failed` : ''}${!m.live && m.spanMs != null ? ` · ${tsnDur(m.spanMs)}` : ''}`;
  const text = m.items.map(tsnEntryText).join('\n\n');
  const body = sh.querySelector('.rsn-sheet-body');
  if (body._text !== text) {
    const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    body.textContent = text;
    body._text = text;
    if (atEnd) body.scrollTop = body.scrollHeight;
  }
}
function closeToolsSheet() {
  const sh = $('tsn-sheet');
  if (sh) sh.classList.remove('open');
  if (sh) dialogGuard.closed(sh);
  tsnSheetFor = null;
  const back = tsnSheetReturn; tsnSheetReturn = null;
  if (back && back.isConnected && typeof back.focus === 'function') { try { back.focus({ preventScroll: true }); } catch {} }
}

function paintFeedRow(feed, it, list = null) {
  if (!it) return;
  const parent = list || (it.el && it.el.parentNode) || null;
  if (!parent) return;
  if (!it.el || it.el.parentNode !== parent) {
    it.el = document.createElement('div');
    it.el.dataset.id = it.id;
    it.el.innerHTML = '<div class="fline"></div><div class="fsub"></div><div class="fdet"></div>';
    parent.appendChild(it.el);
  }
  it.el.className = `frow ${it.kind} ${it.status}${it.open ? ' open' : ''}`;
  const [line, sub, det] = it.el.children;
  if (it.kind === 'tool') {
    const failed = it.status === 'done' && /^(Error|⚠|✗)/.test(it.output || '');
    const mark = it.status === 'done' ? (failed ? '✗' : '✓') : '⚙';
    // The tool's name in bold, then what it did: tool calls read apart from the reply (light blue, mobile.html .frow.tool).
    const name = document.createElement('span');
    name.className = 'ftname';
    name.textContent = it.tool;
    line.replaceChildren(`${mark} `, name, it.summary ? ` · ${clipText(it.summary, 80)}` : '');
    if (failed) it.el.classList.add('failed');
    sub.textContent = '';
    det.textContent = it.open ? [it.summary, it.output ? String(it.output).slice(0, 3000) : ''].filter(Boolean).join('\n\n') : '';
    return;
  }
  const mark = it.status === 'completed' ? '✓' : it.status === 'failed' ? '✗' : '👷';
  line.textContent = `${mark} ${workerName(it)}${it.model ? ` · ${shortModel(it.model)}` : ''}`;
  const lastTool = it.tools[it.tools.length - 1];
  sub.textContent = it.error ? `⚠ ${clipText(it.error, 120)}`
    : (it.status === 'running' && it.last === 'tool' && lastTool) ? `⚙ ${lastTool.tool}${lastTool.summary ? ` · ${clipText(lastTool.summary, 70)}` : ''}`
      : it.text ? tailText(it.text, 80)
        : lastTool ? `⚙ ${lastTool.tool}${lastTool.summary ? ` · ${clipText(lastTool.summary, 70)}` : ''}`
          : clipText(it.description, 80);
  det.innerHTML = it.open
    ? it.tools.map(t => `<div class="ftool">⚙ ${esc(t.tool)}${t.summary ? ` · ${esc(clipText(t.summary, 160))}` : ''}</div>`).join('')
      + (it.text ? `<div class="ftext">${formatContent(it.text)}</div>` : '')
    : '';
  if (it.open && it.text) renderVisualBlocks(det);
}

// The turn is over: rows stop spinning; each group stays between the text before and after it.
function feedEnd(holder) {
  const feed = holder && holder.feed;
  if (!feed) return;
  feed.ended = true;
  for (const x of feed.items.values()) {
    if (x.kind === 'tool' && x.status === 'running') x.status = 'done';
    if (x.kind === 'worker' && x.status === 'running') x.status = 'completed';
  }
  paintFeed(holder);
}

// Tap on the folded summary toggles the list; tap on a row toggles its detail.
function onFeedClick(e) {
  if (e.target.closest('a')) return;
  const root = e.target.closest('.feed, .tsn');
  const feed = root && feedEls.get(root);
  if (!feed) return;
  if (e.target.closest('.feed-head')) {
    feed.open = !feed.open;
    if (feed.holder) paintFeed(feed.holder);
    return;
  }
  const row = e.target.closest('.frow');
  const it = row && feed.items.get(row.dataset.id);
  if (!it) return;
  it.open = !it.open;
  paintFeedRow(feed, it);
}

// ── Catch-up: the hub's view of a running turn (GET /api/agents/<name>/turn) ────────────────────
// { ok, active, turn: null | { turnId, origin, activityLabel, startedAt, message, text, activity[],
//   workers[], ended } }. null on 403 (a member without access to the agent), 404 (older hub) or
// a network error: callers fall back to history polling.
async function fetchTurn(agent) {
  try {
    const r = await api(`/api/agents/${encodeURIComponent(agent)}/turn`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d = await r.json();
    return d && d.ok ? d : null;
  } catch { return null; }
}

// Replays a fetched turn into a holder's feed: activity rows, then each worker's text and tool lines.
function applyTurnFeed(holder, turn) {
  const feed = holderFeed(holder);
  if (feed.local) {   // rows the own stream built have other ids: the hub's rows replace them
    feed.items.clear();
    feed.byWorker.clear();
    feed.local = false;
    resetLayout(holder);
  }
  for (const item of turn.activity || []) feedUpsert(holder, item);
  for (const w of turn.workers || []) {
    if (!w || !w.id) continue;
    const it = feedUpsert(holder, { kind: 'worker', id: `w:${w.id}`, workerId: w.id, status: w.status, description: w.description, model: w.model, agent: w.agent, error: w.error });
    if (!it) continue;
    for (const t of w.tools || []) feedUpsert(holder, { kind: 'worker_tool', id: t.id, workerId: w.id, tool: t.tool, summary: t.summary });
    if (typeof w.text === 'string' && w.text) { it.text = w.text; if (!(w.status === 'running' && it.tools.length)) it.last = 'text'; }
    paintFeed(holder, it);
  }
  if (turn.ended) feedEnd(holder); else paintFeed(holder);
}

// Does a fetched turn belong to the re-attach? Our own message must be the turn's message; a
// re-attach without one (turn started elsewhere) goes by the start time the status gave us.
function turnMatches(ra, turn) {
  if (ra.turnId) return ra.turnId === turn.turnId;
  if (ra.text) return turn.message === ra.text;
  if (ra.since && turn.startedAt) return Math.abs(Date.parse(turn.startedAt) - Date.parse(ra.since)) < 5000;
  return true;
}

// First step of every re-attach, and again on wake / reconnect: paint what the hub has of the turn
// (message, activity, workers, partial text), then the live events keep it moving. A turn that has
// already ended is finished right away from its text.
async function catchUpReattach(ra) {
  if (!ra || reattaches.get(ra.agent) !== ra) return;
  const d = await fetchTurn(ra.agent);
  if (!d || !d.turn || reattaches.get(ra.agent) !== ra) return;   // history polling takes it from here
  const turn = d.turn;
  if (!turnMatches(ra, turn)) return;
  applyTurnNotify(ra.agent, turn);
  ra.turnId = turn.turnId || ra.turnId;
  if (!ra.since && turn.startedAt) ra.since = turn.startedAt;
  if (!ra.text && !ra.msgShown && typeof turn.message === 'string' && turn.message && bubbleLive(ra)) {
    // The message that started the turn (another device, a consultation, a job...) above the bubble.
    ra.msgShown = true;
    const last = chatHistory[chatHistory.length - 1];
    if (!(last && last.role === 'user' && last.content === turn.message)) {
      const note = addNote(`⚡ ${turn.origin?.kind === 'user' ? 'sent from another device' : originLabel(turn.origin)} — ${timeLabel(turn.startedAt)}`);
      const u = addUserBubble(turn.message, null);
      ra.bubble.el.before(note, u);
    }
  }
  applyTurnFeed(ra, turn);
  if (typeof turn.reasoning === 'string' && turn.reasoning) reasoningSet(ra, turn.reasoning, { live: !turn.ended, total: Number(turn.reasoningChars), onlyIfLonger: true });
  if (!turn.ended) applyTurnProgress(ra.agent, turn, ra);
  // The turn is waiting on a question asked before this phone joined (the app was closed, or opened mid-turn).
  if (!turn.ended && turn.question && turn.question.request_id) {
    if (chatOpenFor(ra.agent)) showQuestion(turn.question); else pendingQuestionsByAgent.set(ra.agent, turn.question);
  }
  if (typeof turn.text === 'string' && turn.text.length >= (ra.partial || '').length) ra.partial = turn.text;
  if (turn.ended) {
    const ok = turn.ended.ok !== false;
    finishReattach(ra, ok ? (turn.text || '(no reply)') : `${turn.text ? turn.text + '\n\n' : ''}⚠ turn failed: ${turn.ended.error || 'unknown error'}`, ok);
    return;
  }
  paintReattach(ra, reattachLine(ra));
}

// Live status line under a re-attached bubble: the newest activity row plus the elapsed time.
function reattachLine(ra) {
  const s = live[ra.agent];
  const running = ra.feed && [...ra.feed.items.values()].some(x => x.status === 'running');
  const phase = ra.progress && Date.now() - ra.progress.at < 10000 ? phaseText(ra.progress) : '';
  const what = (!running && phase) || feedStatus(ra.feed) || (s && s.activity) || 'working';
  const e = elapsed(ra.since || (s && s.busySince) || new Date(ra.startedAt).toISOString());
  return `⟳ ${displayName(ra.agent)}: ${what}${e ? ` · ${e}` : ''}`;
}

// Page woke, came to the front or its event stream reconnected while the open chat's agent is
// mid-turn: fetch the hub's view of the turn again so nothing missed while asleep is lost.
async function catchUpOpenAgent() {
  const agent = current;
  if (!agent || screen !== 'chat' || streams.has(agent)) return;
  const ra = reattaches.get(agent);
  if (ra) { catchUpReattach(ra); return; }
  const entry = Object.entries(hubTurns).find(([, t]) => t.agent === agent);
  if (entry) {
    const d = await fetchTurn(agent);
    if (!d || !d.turn || d.turn.turnId !== entry[0] || !hubTurns[entry[0]] || !chatOpenFor(agent)) return;
    applyTurnNotify(agent, d.turn);
    applyTurnFeed(entry[1], d.turn);
    if (typeof d.turn.reasoning === 'string' && d.turn.reasoning) reasoningSet(entry[1], d.turn.reasoning, { live: !d.turn.ended, total: Number(d.turn.reasoningChars), onlyIfLonger: true });
    if (d.turn.text) setReplyText(entry[1], d.turn.text);
    if (!d.turn.ended) applyTurnProgress(agent, d.turn, entry[1]);
    if (d.turn.question && d.turn.question.request_id && !d.turn.ended) showQuestion(d.turn.question);
    return;
  }
  if (isBusy(agent)) reattachIfIdle(agent);
  else if (!statusKnown) probeTurn(agent);
}

// Before any status arrived (page just loaded): is the open agent mid-turn? Then follow it.
async function probeTurn(agent) {
  const d = await fetchTurn(agent);
  if (!d || !d.turn || d.turn.ended || !chatOpenFor(agent) || streams.has(agent) || reattaches.has(agent)) return;
  setLive(agent, { busy: true, busySince: d.turn.startedAt || null, activity: d.turn.activityLabel || originLabel(d.turn.origin) });
  paintStatus();
  reattachIfIdle(agent);
}

function renderPreviews() {
  const box = $('previews');
  box.innerHTML = '';
  pendingImages.forEach((src, i) => {
    const d = document.createElement('div');
    d.className = 'prev';
    const img = document.createElement('img');
    img.src = src;
    const x = document.createElement('button');
    x.textContent = '×';
    x.setAttribute('aria-label', 'Remove image');
    x.addEventListener('click', () => { pendingImages.splice(i, 1); renderPreviews(); });
    d.append(img, x);
    box.appendChild(d);
  });
}

function addImageFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const MAX_DIM = 1600;
    let { width, height } = img;
    if (width > MAX_DIM || height > MAX_DIM) {
      const scale = MAX_DIM / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    pendingImages.push(canvas.toDataURL('image/jpeg', 0.85));
    URL.revokeObjectURL(url);
    renderPreviews();
  };
  img.onerror = () => { URL.revokeObjectURL(url); toast('Could not read that image'); };
  img.src = url;
}

// The send button is Send, or Interject while the open chat's agent is busy (a turn this
// phone is streaming / re-attaching, or one started elsewhere). Stop is in the header.
function setSendMode(own) {
  const b = $('send-btn');
  const interject = !!current && (own || isBusy(current));
  b.classList.remove('stop');
  b.classList.toggle('interject', interject);
  b.innerHTML = interject ? '&#x2935;' : '&#x27A4;';
  b.setAttribute('aria-label', interject ? 'Interject' : 'Send');
  b.title = interject ? 'Interject into the running turn' : 'Send';
  const input = $('msg-input');
  if (input) input.placeholder = interject ? 'Interject into the running turn…' : 'Message';
}

// Interject: the text is injected into the agent's running turn (same POST /api/chat/interject
// the desktop uses) instead of waiting for it to finish. If the turn ended in the meantime the
// hub says so and the message goes out as a normal send instead.
async function sendInterjection(agent) {
  const input = $('msg-input');
  const text = input.value.trim();
  if (!text) { if (pendingImages.length) toast('Images cannot be interjected; send them when the turn ends'); return; }
  input.value = '';
  input.style.height = 'auto';
  saveDraft(agent, '');
  stick = true;
  const userEl = addUserBubble(text, null);
  const noteEl = addNote('⤵ delivering mid-turn…');
  noteEl.classList.add('interject');
  scrollChat(true);
  let result;
  try {
    const r = await api('/api/chat/interject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent, message: text }),
    });
    result = await r.json().catch(() => ({ success: false, error: `HTTP ${r.status}` }));
  } catch (e) {
    result = { success: false, error: e.message || 'request failed' };
  }
  if (result && result.success) { noteEl.textContent = 'delivered mid-turn'; return; }
  const error = String((result && result.error) || 'request failed');
  if (/not currently processing/i.test(error)) {
    noteEl.textContent = 'turn had already ended, sent as a new message';
    // A stream record this phone still holds for the agent is stale (the hub just said the
    // turn is over): drop it so the new send owns the chat.
    const stale = streams.get(agent);
    if (stale) { stale.stale = true; stale.controller.abort(); }
    setLive(agent, { busy: false, pendingQuestion: false });
    paintStatus();
    await sendMessage({ agent, text, userEl, noteEl });
    return;
  }
  noteEl.textContent = `⚠ not delivered: ${error}`;
  if (current === agent && !input.value) { input.value = text; saveDraft(agent, text); }
}

// The hub no longer stops a turn when the browser goes away, so Stop has to say so explicitly.
function stopTurn(agent) {
  return api('/api/chat/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent }),
  }).then(r => r.json().catch(() => ({ ok: r.ok }))).catch(() => null);
}

function markUnread(agent) {
  unread[agent] = (unread[agent] || 0) + 1;
  saveJson('hub-mobile-unread', unread);
  updateDots();
}

// The buttons beside the message box act on the touch itself. A plain click handler needed two taps on
// phones: the first tap moved focus off the textarea, the keyboard collapsed, the page re-laid out and the
// button slid out from under the finger before the click fired. So:
// - pointerdown preventDefault keeps the textarea focused (the keyboard stays) and pointerup acts;
// - touchstart is cancelled too (the two taps came back on a phone on 2026-10-20 with only the above), which
//   takes the browser's own tap handling (focus change, scroll start, the click) out of the way;
// - so the browser no longer cancels a drag: a release more than a finger's width from where the button was
//   at the press does nothing, as on a native button; and only the primary button counts (no right-click);
// - click stays for the keyboard and screen readers (TalkBack), ignored within 700 ms of a press that acted.
function onComposerTap(btn, act) {
  let down = null, actedAt = 0;
  btn.addEventListener('touchstart', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (e.button === 0 && e.isPrimary) down = { id: e.pointerId, r: btn.getBoundingClientRect() };   // a second finger changes nothing
  });
  btn.addEventListener('pointercancel', (e) => { if (down && e.pointerId === down.id) down = null; });
  btn.addEventListener('pointerup', (e) => {
    e.preventDefault();
    const d = down;
    if (!d || e.pointerId !== d.id) return;
    down = null;
    const slop = 16;
    if (e.clientX < d.r.left - slop || e.clientX > d.r.right + slop || e.clientY < d.r.top - slop || e.clientY > d.r.bottom + slop) return;
    actedAt = Date.now(); act();
  });
  btn.addEventListener('click', () => { if (Date.now() - actedAt < 700) return; act(); });
}

// A tap on Send sends, then the keyboard goes away (2026-10-21: the owner wants the box let go after a
// send). The box keeps focus until sendMessage has taken its text, which happens before its first await,
// and only lets go if the text or images really went: a tap with nothing to send keeps the keyboard up.
function sendAndClose() {
  const input = $('msg-input');
  const hadText = !!input.value.trim();
  const hadImages = pendingImages.length > 0;
  sendMessage();
  if ((hadText && !input.value.trim()) || (hadImages && !pendingImages.length)) input.blur();
}

// The message box keeps a draft per agent in localStorage (2026-10-21: a half-typed message vanished when the app
// reloaded itself for a new version as a reply finished). So a reload, a hub restart or switching chats never loses
// what was being typed; a send clears it. Text only: pasted images are not kept.
const DRAFTS_KEY = 'hub-mobile-drafts';
function draftsAll() { try { return JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}') || {}; } catch { return {}; } }
function saveDraft(agent, text) {
  if (!agent) return;
  const all = draftsAll();
  if (text && text.trim()) all[agent] = { text, at: Date.now() }; else delete all[agent];
  try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(all)); } catch {}
}
function restoreDraft(agent) {
  const input = $('msg-input'); if (!input) return;
  const d = draftsAll()[agent];
  input.value = d && typeof d.text === 'string' ? d.text : '';
  input.style.height = 'auto';
  if (input.value) input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}
// A reload the app wants (a new version, a hub restart) waits while the message box is in use: focused or holding
// text. At most 10 minutes; the draft is saved either way, so even a reload that has to happen brings the text back.
function typingNow() { const i = $('msg-input'); return !!i && (document.activeElement === i || !!i.value.trim()); }

// `fallback` is set when an interjection found the turn already over: the text and its user
// bubble are reused instead of being read from the composer again.
async function sendMessage(fallback) {
  if (!current) { toast('Pick an agent first'); return; }
  const agent = fallback ? fallback.agent : current;
  // While the agent is busy (a turn this phone is streaming or one started elsewhere) the
  // composer interjects into that turn; Stop is in the header.
  if (!fallback && (isBusy(agent) || ownTurnFor(agent))) { await sendInterjection(agent); return; }
  const input = $('msg-input');
  const text = fallback ? fallback.text : input.value.trim();
  const images = fallback ? [] : pendingImages.slice();
  if (!text && !images.length) return;

  if (!fallback) {
    input.value = '';
    input.style.height = 'auto';
    saveDraft(agent, '');
    pendingImages = [];
    renderPreviews();
  }
  stick = true;
  const s = live[agent];
  if (s && s.busy) {
    const e = elapsed(s.busySince);
    addNote(`⏳ ${displayName(agent)} is still working on the previous message (${s.activity || 'working'}${e ? `, ${e}` : ''}). Your message will queue or be refused until it finishes.`);
  }
  const userEl = fallback ? fallback.userEl : addUserBubble(text, images);
  const bubble = addAssistantBubble();
  bubble.body.innerHTML = '<span style="opacity:.6">⏳ Thinking…</span>';
  scrollChat(true);

  const controller = new AbortController();
  const rec = { controller, agent, text, images, bubble, userEl, startedAt: Date.now(), full: '', gotAny: false, feed: newFeed(true), question: null };
  streams.set(agent, rec);
  paintChatStatus();

  let lost = false;
  let sent = true;
  try {
    const r = await api('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ agent, message: text, images, confirm_tools: false }),
    });
    if (r.status === 409) {
      sent = false;
      rec.bubble.el.remove();
      rec.userEl?.remove();
      fallback?.noteEl?.remove();
      if (current === agent) {
        input.value = text;
        saveDraft(agent, text);
        pendingImages = images;
        renderPreviews();
        toast('Agent is busy; it will finish first');
      } else {
        toast(`${displayName(agent)} is busy; your message was not sent`);
      }
    } else if (!r.ok) {
      throw new Error(`HTTP ${r.status}`);
    } else {
      await readStream(r, rec);
      if (!rec.gotAny && bubbleLive(rec)) rec.bubble.body.innerHTML = '<span style="opacity:.6">[No response]</span>';
      if (current === agent) rereadHistory(agent);   // the finished exchange, as the hub saved it
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      if (bubbleLive(rec) && !rec.stale) {
        if (!rec.gotAny) rec.bubble.body.innerHTML = '<span style="opacity:.6">(stopped)</span>';
        else addNote('(stopped)');
      }
    } else if (e.name === 'TypeError' || /HTTP 50[234]/.test(e.message || '') || /network|fetch|stream|socket/i.test(e.message || '')) {
      // Connection dropped (phone slept, network changed, hub restarted). Never resend:
      // the hub keeps running the turn and the reply lands in history.
      lost = true;
      enterReattach(agent, text, rec.bubble, rec.gotAny ? rec.bubble.body.innerHTML : '', rec.full, null, rec.startedAt);
    } else if (bubbleLive(rec)) {
      rec.bubble.el.classList.add('error');
      const msg = document.createElement('div');
      msg.textContent = `⚠ ${e.message || 'request failed'}`;
      rec.bubble.el.appendChild(msg);
    } else {
      toast(`${displayName(agent)}: ${e.message || 'request failed'}`);
    }
  } finally {
    if (!lost) { feedEnd(rec); reasoningEnd(rec); }   // fold the activity feed under the finished reply; the reasoning is done
    if (streams.get(agent) === rec) streams.delete(agent);
    recentOwn.set(agent, Date.now());
    // Finished while another chat was open: the reply is in history; flag the agent.
    if (sent && !lost && !chatOpenFor(agent)) markUnread(agent);
    paintStatus();
    if (current === agent) scrollChat();
  }
}

// ── Re-attach after a lost connection (one per agent) ───────────────────────

function enterReattach(agent, text, bubble, partialHtml, partial, since = null, sentAt = null) {
  // text: the message this phone sent (null when the turn started elsewhere, or before this page
  // loaded / woke from a blank screen); since: when the hub says the turn began; sentAt: when this
  // phone sent text (its own clock).
  const ra = { agent, text, sentAt, bubble, line: null, partial: partial || '', partialHtml, since, startedAt: Date.now(), turnId: null, feed: null, painted: null };
  // A stream this phone lost: its bubble keeps the text and activity rows painted so far.
  const rec = streams.get(agent);
  if (rec && rec.bubble === bubble) { ra.feed = rec.feed; ra._blocks = rec._blocks; ra._sig = rec._sig; ra.replyText = rec.full; ra.rsn = rec.rsn; if (!ra.partial) ra.partial = rec.full; }
  reattaches.set(agent, ra);
  if (!partialHtml && bubbleLive(ra)) clearPlaceholder(bubble.body);
  paintReattach(ra, text ? `⟳ Connection lost; ${displayName(agent)} is still working on the server…` : `⟳ ${displayName(agent)} is working on the server; the reply will appear here…`);
  paintChatStatus();
  catchUpReattach(ra);   // the hub's view first: message, activity, workers, partial text
  setTimeout(() => reattachCheck(ra), 1500);
  return ra;
}

// The open chat's agent is mid-turn on the server and this phone has no stream to it (page just
// loaded, woke from sleep, or the turn was started from another device): follow it.
function reattachIfIdle(agent, partial = '') {
  if (!agent || !chatOpenFor(agent) || streams.has(agent) || reattaches.has(agent)) return;
  const s = live[agent];
  if (!s || !s.busy) return;
  enterReattach(agent, null, addAssistantBubble(), '', partial, s.busySince || null);
}

function paintReattach(ra, line) {
  if (!ra || !bubbleLive(ra)) return;
  const { bubble } = ra;
  const laidOut = !!ra._blocks && ra._blocks.every(b => b.el && b.el.parentNode === bubble.body);
  if (ra.partial) {
    if (ra.painted !== ra.partial || !laidOut) { setReplyText(ra, ra.partial); ra.painted = ra.partial; }
  } else if (ra.feed && ra.feed.items.size) {
    if (!laidOut) paintReply(ra, '');
  } else if (ra.partialHtml && !bubble.body.innerHTML) {
    bubble.body.innerHTML = ra.partialHtml;
    setRaw(bubble.el, '');
  } else {
    setRaw(bubble.el, '');
  }
  if (line !== undefined) {
    if (!ra.line) { ra.line = document.createElement('div'); ra.line.className = 'reattach'; bubble.el.appendChild(ra.line); }
    ra.line.textContent = line;
  }
  scrollChat();
}

function finishReattach(ra, reply, ok = true) {
  if (!ra || reattaches.get(ra.agent) !== ra) return;
  reattaches.delete(ra.agent);
  reasoningEnd(ra);
  if (bubbleLive(ra)) {
    ra.line?.remove();
    setReplyText(ra, reply);
    feedEnd(ra);
    ra.bubble.el.classList.toggle('error', !ok);
    if (ok) rereadHistory(ra.agent);   // the finished exchange, as the hub saved it
  } else if (!chatOpenFor(ra.agent)) {
    markUnread(ra.agent);
  }
  updateDots();
  paintStatus();
  if (current === ra.agent) scrollChat();
}

// Which history entry is the message this phone sent before its connection dropped? The hub stamps a user
// entry when it receives it, so that entry can't be older than the send. An identical earlier message (an
// earlier "Build it") must never be taken for it, or that message's old reply is shown as the answer to a
// message the hub never got. The send time is moved onto the hub's clock with the history response's Date
// header, so a phone clock that is off doesn't matter; ten seconds cover the header's whole seconds.
function ownEntryIndex(hist, text, sentAt, hubDate, now = Date.now()) {
  const hubNow = Date.parse(hubDate || '');
  const floor = (Number.isFinite(hubNow) ? hubNow - (now - sentAt) : sentAt) - 10000;
  for (let i = hist.length - 1; i >= 0; i--) {
    const m = hist[i];
    if (m.role === 'user' && m.content === text && Date.parse(m.ts) >= floor) return i;
  }
  return -1;
}

function stopReattach(ra) {
  if (!ra) return;
  stopTurn(ra.agent);
  const partial = ra.partial || '';
  finishReattach(ra, partial ? `${partial}\n\n(stopped)` : '(stopped)', true);
}

function reattachCheckAll() {
  for (const ra of reattaches.values()) reattachCheck(ra);
}

async function reattachCheck(ra) {
  if (!ra || ra.checking || reattaches.get(ra.agent) !== ra) return;
  ra.checking = true;
  try {
    const r = await api(`/api/history/${encodeURIComponent(ra.agent)}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const hist = (await r.json()).history || [];
    if (reattaches.get(ra.agent) !== ra) return;
    const ui = ra.text ? ownEntryIndex(hist, ra.text, ra.sentAt || ra.startedAt, r.headers.get('Date')) : -1;
    let reply = null;
    if (ui >= 0) {
      const uts = hist[ui].ts ? new Date(hist[ui].ts).getTime() : 0;
      reply = hist.slice(ui + 1).find(m => m.role === 'assistant' && (!m.ts || !uts || new Date(m.ts).getTime() >= uts));
    } else if (!ra.text && ra.since) {
      // No user entry to anchor on: the newest assistant entry written since the turn began.
      const sinceTs = new Date(ra.since).getTime() - 2000;
      for (let i = hist.length - 1; i >= 0; i--) { const m = hist[i]; if (m.role === 'assistant' && m.ts && new Date(m.ts).getTime() >= sinceTs) { reply = m; break; } }
    }
    const s = live[ra.agent];
    const stillBusy = statusKnown ? !!(s && s.busy) : null;
    if (reply && typeof reply.content === 'string') {
      if (stillBusy === true || reply.inProgress) {   // inProgress: the hub says that turn is still running
        // Still working: what is in history is the incremental partial save (text only, every 5 s). The hub's turn
        // view and live events are fresher: take it only when it holds more text. Keep waiting for turn_end.
        if (reply.content.length > (ra.partial || '').length) ra.partial = reply.content;
      } else {
        if (chatOpenFor(ra.agent)) { chatHistory = hist; histGen++; }
        if (typeof reply.reasoning === 'string' && reply.reasoning) reasoningSet(ra, reply.reasoning, { total: Number(reply.reasoningChars), onlyIfLonger: true });
        finishReattach(ra, reply.content, true);
        return;
      }
    }
    const waited = Date.now() - ra.startedAt;
    if (stillBusy === false && waited > 15000) {
      if (ui < 0 && ra.text) {
        const input = $('msg-input');
        if (input && !input.value && current === ra.agent) input.value = ra.text;
        finishReattach(ra, '⚠ The hub has no record of this message, so it is back in the input box. If you are not sure it was lost, reload the chat before sending it again.', false);
      } else {
        finishReattach(ra, `${ra.partial ? ra.partial + '\n\n' : ''}⚠ ${displayName(ra.agent)} stopped without a reply (the hub may have restarted).`, false);
      }
      return;
    }
    if (waited > REATTACH_GIVE_UP_MS) {
      finishReattach(ra, `${ra.partial ? ra.partial + '\n\n' : ''}⚠ Gave up waiting after 30 minutes. Pull to refresh to see the reply if it arrived.`, false);
      return;
    }
    paintReattach(ra, reattachLine(ra));
  } catch {
    if (reattaches.get(ra.agent) === ra) paintReattach(ra, `⟳ Hub unreachable; will retry when the connection is back…`);
  } finally {
    ra.checking = false;
  }
}

// Back in the foreground (sleep, another app, back/forward cache, network back): the event stream
// may be a zombie, so a wake always gets a fresh one plus status and turn catch-up.
async function onForeground() {
  if (document.hidden) return;
  resync();
}

// Parses the /api/chat/stream SSE the same way app.js streamResponseSolo does. All paint
// state lives on the stream record so the bubble can be swapped (chat closed, then reopened)
// while the stream keeps running; nothing is painted while the chat is not open.
async function readStream(response, rec) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let raf = 0;

  const visible = () => bubbleLive(rec);
  const body = () => rec.bubble.body;
  const paint = () => {
    raf = 0;
    if (!visible()) return;
    paintReply(rec, rec.full);   // text and activity rows in order; the layout calls renderVisualBlocks(
  };
  const schedulePaint = () => { if (!raf) raf = requestAnimationFrame(paint); };

  // Tool calls and workers go into the activity feed above the reply text. The stream's events
  // carry no item ids, so rows are keyed by tool_call_id when there is one, else made up here
  // (feed.local: a later fetch of the hub's view replaces them).
  const feed = holderFeed(rec);
  const tools = () => [...feed.items.values()].filter(x => x.kind === 'tool');
  const byCall = (g) => (g.tool_call_id ? feed.items.get(`c:${g.tool_call_id}`) : null) || null;
  const newToolId = (g) => (g.tool_call_id ? `c:${g.tool_call_id}` : `t${++feed.seq}`);
  const outText = (o) => (typeof o === 'string' ? o : (o == null ? '' : JSON.stringify(o)));

  const handleGateway = (g) => {
    switch (g.type) {
      case 'context_health': noteCtxReading(rec.agent, g); break;
      case 'ask_user_question':
        rec.question = g;
        if (visible()) showQuestion(g, () => { rec.question = null; });
        break;
      case 'approval_request':
      case 'approval_resolved':
        onApprovalEvent(g);   // the card is global, not tied to this chat's bubble
        break;
      case 'tool_start':
        rec.gotAny = true;
        if (!byCall(g)) feedUpsert(rec, { kind: 'tool', id: newToolId(g), tool: g.tool || 'tool', status: 'running', summary: toolSummary(g.input) });
        break;
      case 'tool_use': {
        rec.gotAny = true;
        const existing = byCall(g) || tools().reverse().find(x => x.status === 'running' && x.tool === (g.tool || 'tool') && !x.summary);
        feedUpsert(rec, { kind: 'tool', id: existing ? existing.id : newToolId(g), tool: g.tool || 'tool', status: 'running', summary: toolSummary(g.input) });
        break;
      }
      case 'tool_result': {
        const existing = byCall(g) || tools().reverse().find(x => x.status === 'running');
        feedUpsert(rec, { kind: 'tool', id: existing ? existing.id : newToolId(g), tool: existing ? existing.tool : (g.tool || 'tool'), status: 'done', output: outText(g.output).slice(0, 4000) });
        break;
      }
      case 'worker_started':
        rec.gotAny = true;
        feedUpsert(rec, { kind: 'worker', id: `w:${g.worker_id}`, workerId: g.worker_id, status: 'started', description: g.description, model: g.model, agent: g.agent_type });
        break;
      case 'worker_text_delta': feedWorkerText(rec, g.worker_id, g.text, true); break;
      case 'worker_tool_start':
      case 'worker_tool_use': {
        const w = feed.byWorker.get(String(g.worker_id));
        if (!w) break;
        const tool = g.tool || 'tool';
        const summary = toolSummary(g.input);
        const last = w.tools[w.tools.length - 1];
        const merge = g.type === 'worker_tool_use' && last && last.tool === tool && (!last.summary || !summary);   // start + use of one call
        feedUpsert(rec, { kind: 'worker_tool', id: merge ? last.id : `${w.workerId}-t${++feed.seq}`, workerId: w.workerId, tool, summary });
        break;
      }
      case 'worker_tool_result': break;   // a worker's tool lines carry no status; its next line or text takes over
      case 'worker_completed':
      case 'worker_failed':
        feedUpsert(rec, { kind: 'worker', id: `w:${g.worker_id}`, workerId: g.worker_id, status: g.type === 'worker_completed' ? 'completed' : 'failed', error: g.error });
        break;
      case 'reasoning': reasoningAdd(rec, g.text); break;   // the panel above the reply (painted only while the chat is open)
      case 'session_interrupted': if (visible()) addNote('⚠ Session interrupted'); break;
      case 'context_exhausted': if (visible()) addNote('⚠ Context is full; use Clear chat / new session'); break;
      default: break;   // session_id, context_health, token_usage, expression_change, auto_model, progress, ...
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n');
    buffer = parts.pop();
    for (const line of parts) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      if (parsed.type === 'meta') {
        for (const src of parsed.images || []) {
          const u = typeof src === 'string' && (safeUrl(src) || (/^data:image\//i.test(src) ? src : null));
          if (u && visible()) { const img = document.createElement('img'); img.src = u; body().appendChild(img); }
        }
        continue;
      }
      if (parsed.context_size) continue;
      if (parsed.type === 'ask_user_question') { handleGateway(parsed); continue; }
      if (parsed.gateway) { handleGateway(parsed.gateway); continue; }
      if (parsed.type === 'tool_start' || parsed.type === 'tool_use' || parsed.type === 'tool_result') { handleGateway(parsed); continue; }
      const delta = parsed.choices?.[0]?.delta?.content;
      if (delta) {
        rec.gotAny = true;
        rec.full += delta;
        schedulePaint();
      }
    }
  }
  if (raf) { cancelAnimationFrame(raf); paint(); }
  return { text: rec.full, gotAny: rec.gotAny };
}

// One box per question: it can arrive on the chat stream, on the hub event stream (chat stream dropped: phone in the
// background, reload) and from a turn catch-up. Request ids are remembered; a question answered elsewhere is closed.
const shownQuestions = new Set();
const questionBoxes = new Map();   // request_id -> box
const pendingQuestionsByAgent = new Map();   // agent -> { request_id, questions } waiting for its chat to open
function closeQuestion(requestId, how) {
  const box = questionBoxes.get(requestId);
  if (box) { box.innerHTML = `<div class="done">${how === 'no_answer' ? 'No answer in time; the agent carried on' : how === 'skipped' ? 'Skipped' : 'Answered elsewhere'}</div>`; questionBoxes.delete(requestId); }
}
function showQuestion(data, onAnswered) {
  const { request_id, questions } = data;
  if (!request_id || !Array.isArray(questions)) return;
  if (shownQuestions.has(request_id)) {
    // Shown before and still unanswered, but the chat was redrawn since (closed and reopened): put the same box back.
    const old = questionBoxes.get(request_id);
    if (old && !old.isConnected) { chatEl().appendChild(old); scrollChat(); }
    return;
  }
  shownQuestions.add(request_id);
  const box = document.createElement('div');
  box.className = 'question';
  questionBoxes.set(request_id, box);
  const submit = (answers, label) => {
    if (onAnswered) onAnswered();
    api('/api/ask_response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id, answers }),
    }).catch(err => toast(`Could not send answer: ${err.message}`));
    box.innerHTML = `<div class="done">Answered: ${esc(label)}</div>`;
    questionBoxes.delete(request_id);
  };
  // A tap only selects (highlighted); nothing is sent until Submit, so a mis-tap cannot answer the agent.
  const selected = {};
  const groups = {};
  questions.forEach((q, i) => {
    if (q.header) { const h = document.createElement('div'); h.className = 'qh'; h.textContent = q.header; box.appendChild(h); }
    const t = document.createElement('div');
    t.className = 'qt';
    t.textContent = q.question || '';
    box.appendChild(t);
    groups[i] = [];
    for (const opt of q.options || []) {
      const b = document.createElement('button');
      b.className = 'opt';
      b.innerHTML = `<strong>${esc(opt.label)}</strong>${opt.description ? `<small>${esc(opt.description)}</small>` : ''}`;
      b.addEventListener('click', () => {
        const was = b.classList.contains('selected');
        groups[i].forEach(x => x.classList.remove('selected'));
        if (was) delete selected[i];                            // tapping the highlighted option again clears it
        else { b.classList.add('selected'); selected[i] = opt.label; }
        refresh();
      });
      groups[i].push(b);
      box.appendChild(b);
    }
  });
  const custom = document.createElement('div');
  custom.className = 'qcustom';
  custom.innerHTML = '<input type="text" placeholder="Or type an answer" enterkeyhint="done">';
  const actions = document.createElement('div');
  actions.className = 'qactions';
  actions.innerHTML = '<span class="qhint"></span><button class="qsubmit" disabled>Submit</button>';
  const input = custom.querySelector('input');
  const submitBtn = actions.querySelector('.qsubmit');
  const hint = actions.querySelector('.qhint');
  const refresh = () => {
    const typed = input.value.trim();
    const complete = typed || questions.every((q, i) => selected[i] !== undefined);
    submitBtn.disabled = !complete;
    hint.textContent = typed ? 'Your typed answer will be sent.' : complete ? 'Press Submit to send.' : (questions.length > 1 ? 'Pick an answer for each question.' : 'Pick an answer, then press Submit.');
  };
  const send = () => {
    const v = input.value.trim();
    const answers = {};
    if (v) { questions.forEach((q, i) => { answers[String(i)] = v; }); submit(answers, v); return; }
    if (!questions.every((q, i) => selected[i] !== undefined)) return;
    questions.forEach((q, i) => { answers[String(i)] = selected[i]; });
    submit(answers, questions.map((q, i) => selected[i]).join(' / '));
  };
  submitBtn.addEventListener('click', send);
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && input.value.trim()) send(); });
  box.appendChild(custom);
  box.appendChild(actions);
  refresh();
  chatEl().appendChild(box);
  scrollChat();
}

// ── Action approvals: tool calls the agent's policy marks "ask" ─────────────
// Requests come on the chat stream (gateway approval_request / approval_resolved), on
// /api/events (same names) and in every status_snapshot (`approvals`: the whole pending list).
// One bottom sheet shows the newest pending card on whichever screen is open (the waiting
// agent is often not the open chat); the Agents tab badge counts them all. "Later" hides the
// sheet until the next request or a tap on the Agents tab. Answers: POST /api/approvals/<id>.
const approvals = new Map();   // id -> card data, in arrival order
let approvalsTimer = null;
let approvalsHidden = false;
const APPROVAL_CLASS_LABELS = { write_outside: 'write outside its folders', send: 'send off this machine', admin: 'change hub data / another agent', destroy: 'destructive action', money: 'move money' };
const APPROVAL_DETAIL_LABELS = { command: 'Command', path: 'Path', paths: 'Paths', to: 'To', channel: 'Channel', text: 'Text', reason: 'Why flagged', tool: 'Tool', input: 'Arguments', name: 'Name', model: 'Model' };

function approvalWants(ev) {
  const label = APPROVAL_CLASS_LABELS[ev.cls] || String(ev.cls || 'do something that needs approval');
  return `${displayName(ev.agent)} wants to ${ev.cls === 'destroy' ? 'take a ' : ''}${label}`;
}
function approvalCountdown(expiresAt) {
  const ms = expiresAt ? Date.parse(expiresAt) - Date.now() : NaN;
  if (!(ms > 0)) return Number.isNaN(ms) ? '' : 'expired: not done';
  const s = Math.ceil(ms / 1000);
  return `expires in ${s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`}`;
}
function approvalDetailRows(ev) {
  const d = ev.detail && typeof ev.detail === 'object' ? ev.detail : {};
  const rows = [];
  if (ev.tool && !d.tool) rows.push(['Tool', String(ev.tool)]);
  for (const [k, v] of Object.entries(d)) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
    let text;
    if (k === 'input') { try { text = JSON.stringify(JSON.parse(v), null, 2); } catch { text = String(v); } }
    else text = Array.isArray(v) ? v.map(String).join('\n') : typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
    rows.push([APPROVAL_DETAIL_LABELS[k] || k.replace(/_/g, ' '), text]);
  }
  return rows;
}
function upsertApproval(ev) {
  if (!ev || !ev.id) return;
  const had = approvals.has(ev.id);
  approvals.set(ev.id, { ...(approvals.get(ev.id) || {}), ...ev });
  if (!had) approvalsHidden = false;
  paintApprovals();
}
function removeApproval(id) {
  if (!approvals.delete(id)) return;
  paintApprovals();
}
function applyApprovals(list) {
  if (!Array.isArray(list)) return;
  if (!isAdmin()) return;   // members never see approval cards
  const ids = new Set(list.map(a => a && a.id).filter(Boolean));
  for (const id of [...approvals.keys()]) if (!ids.has(id)) approvals.delete(id);
  for (const a of list) if (a && a.id && !approvals.has(a.id)) { approvals.set(a.id, a); approvalsHidden = false; }
  paintApprovals();
}
function onApprovalEvent(ev) {
  if (!ev || !ev.id || !isAdmin()) return;
  if (ev.type === 'approval_request') upsertApproval(ev);
  else if (ev.type === 'approval_resolved') {
    if (approvals.has(ev.id) && ev.by && ev.by !== 'owner') toast(ev.by === 'timeout' ? `Approval timed out: ${displayName(ev.agent)} did not do it` : `${ev.decision === 'allow' ? 'Approved' : 'Denied'} (${ev.by})`);
    removeApproval(ev.id);
  }
}
async function pollApprovals() {
  if (!isAdmin()) return;
  try {
    const r = await api('/api/approvals', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return;   // 404 on an older hub
    const d = await r.json();
    if (d && Array.isArray(d.pending)) applyApprovals(d.pending);
  } catch {}
}
function paintApprovals() {
  updateDots();
  const sheet = $('approval-sheet');
  if (!sheet) return;
  if (!approvals.size || approvalsHidden) {
    if (sheet.open) sheet.close();
    sheet.dataset.id = '';
    if (approvalsTimer) { clearInterval(approvalsTimer); approvalsTimer = null; }
    return;
  }
  const list = [...approvals.values()];
  const ev = list[list.length - 1];   // newest first; the rest follow once this one is answered
  if (sheet.dataset.id !== ev.id) renderApprovalSheet(sheet, ev, list.length - 1);
  else {
    const c = sheet.querySelector('.acountdown');
    if (c) c.textContent = approvalCountdown(ev.expiresAt);
    const n = sheet.querySelector('.acount');
    if (n) n.textContent = list.length > 1 ? `+${list.length - 1} more` : '';
  }
  if (!sheet.open) sheet.show();
  if (!approvalsTimer) approvalsTimer = setInterval(paintApprovals, 1000);   // the countdown ticks
}
function renderApprovalSheet(sheet, ev, more) {
  sheet.dataset.id = ev.id;
  const rows = approvalDetailRows(ev);
  sheet.innerHTML = `<div class="ah"><span>&#x1F510;</span><b>${esc(approvalWants(ev))}</b><span class="acount">${more ? `+${more} more` : ''}</span></div>` +
    (ev.capReason ? `<div class="acap">Over a spend cap: ${esc(ev.capReason)}</div>` : '') +
    `<div class="as">${esc(ev.summary || '(no summary)')}</div>` +
    (rows.length ? `<details><summary>Details</summary><div class="kv">${rows.map(([k, v]) => `<b>${esc(k)}</b><span>${esc(v)}</span>`).join('')}</div></details>` : '') +
    `<div class="ameta"><span class="acountdown">${esc(approvalCountdown(ev.expiresAt))}</span><span class="anote"></span></div>` +
    '<div class="abtns">' +
    '<button class="ok" data-decision="allow">Approve</button>' +
    '<button class="ok1h" data-decision="allow" data-remember="1h">Approve this kind for 1 hour</button>' +
    '<button class="deny" data-decision="deny">Deny</button>' +
    '<button class="later">Later</button>' +
    '</div>';
  for (const b of sheet.querySelectorAll('button[data-decision]')) b.addEventListener('click', () => answerApproval(ev.id, b.dataset.decision, b.dataset.remember || null));
  sheet.querySelector('.later').addEventListener('click', () => { approvalsHidden = true; paintApprovals(); });
}
async function answerApproval(id, decision, remember) {
  const sheet = $('approval-sheet');
  const buttons = sheet.dataset.id === id ? [...sheet.querySelectorAll('button')] : [];
  for (const b of buttons) b.disabled = true;
  const note = sheet.querySelector('.anote');
  if (note) note.textContent = 'Sending…';
  try {
    const r = await api(`/api/approvals/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision, remember: remember || null }),
    });
    if (r.status === 404) { toast('Already answered'); approvals.delete(id); sheet.dataset.id = ''; paintApprovals(); return; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    toast(decision === 'allow' ? (remember === '1h' ? 'Approved for 1 hour' : 'Approved') : 'Denied');
    approvals.delete(id);
    sheet.dataset.id = '';
    paintApprovals();
  } catch (e) {
    toast(`Could not send: ${e.message}`);
    if (note) note.textContent = '';
    for (const b of buttons) b.disabled = false;
  }
}

function confirmClear() {
  if (!current) return;
  $('menu').classList.remove('open');
  $('confirm-text').textContent = `Clear the chat with ${displayName(current)} and start a new session? This deletes the saved history.`;
  $('confirm').showModal();
}

// ── Update from GitHub (the same /api/git-sync routes as the desktop dialog). The channel question is asked every
// time: stable (main) or experimental (dev), the current one preselected; choosing the other switches and updates. ──
async function openUpdateSheet() {
  $('menu').classList.remove('open');
  const d = $('update-sheet');
  d.innerHTML = '<p>Checking GitHub…</p>';
  if (!d.open) d.showModal();
  let s;
  try { const r = await api('/api/git-sync/status'); s = await r.json(); } catch (e) { s = { ok: false, error: e.message }; }
  const closeOnly = (msg) => { d.innerHTML = `<p class="upd-err">${esc(msg)}</p><div class="btns"><button id="upd-close">Close</button></div>`; $('upd-close').addEventListener('click', () => d.close()); };
  if (!s || !s.ok) { closeOnly((s && s.error) || 'Could not check for updates'); return; }
  const ch = s.channels || { current: s.channel || null, channels: [] };
  const radios = ch.channels.map(c => {
    const note = !c.available ? (c.error || 'not on GitHub')
      : c.current ? (s.behind > 0 ? `${s.behind} new commit${s.behind === 1 ? '' : 's'}` : 'up to date')
      : `${c.adds ? `adds ${c.adds} commit${c.adds === 1 ? '' : 's'}` : 'adds nothing'}${c.drops ? `, leaves ${c.drops} behind` : ''}`;
    return `<label class="upd-ch"><input type="radio" data-no-dirty name="upd-channel" value="${esc(c.id)}" ${c.current ? 'checked' : ''} ${c.available ? '' : 'disabled'}> <b>${esc(c.label)}</b> (${esc(c.branch)})${c.current ? ' — current' : ''}<br><small>${esc(c.blurb)}; ${esc(note)}</small></label>`;
  }).join('');
  const blockers = s.blockers && s.blockers.length ? `<p class="upd-err">Update blocked: ${esc(s.blockers.join('; '))}</p>` : '';
  const incoming = s.commits && s.commits.length ? `<details><summary>${s.commits.length} incoming commit${s.commits.length === 1 ? '' : 's'}</summary>${s.commits.map(c => `<div>${esc(c)}</div>`).join('')}</details>` : '';
  const stayLabel = s.canUpdate ? 'Update & restart' : (s.upToDate ? 'Up to date' : 'Blocked');
  const force = s.canForce ? `<p><small>The changed files are application files, not your data: they can be discarded.</small></p>` : '';
  d.innerHTML = `<h3>Update hub</h3><p>Branch <b>${esc(s.branch)}</b>${s.upToDate ? ' — up to date on this channel' : ''}</p><div>${radios}</div>${blockers}${force}${incoming}<div class="btns"><button id="upd-close">Cancel</button>${s.canForce ? '<button id="upd-force">Discard changes &amp; update</button>' : ''}<button id="upd-go" class="go accent" ${s.canUpdate ? '' : 'disabled'}>${stayLabel}</button></div>`;
  // Discarding updates the current channel only, so it is off while another channel is chosen.
  if (s.canForce) $('upd-force').addEventListener('click', () => { if (chosen()) return; if (confirm(`Discard ${s.dirty.length} changed application file${s.dirty.length === 1 ? '' : 's'} and update ${s.branch}? Your chats, agents and data are not touched.`)) runUpdateFromPhone(null, true); });
  const go = $('upd-go');
  const chosen = () => { const sel = d.querySelector('input[name="upd-channel"]:checked'); return sel && sel.value !== ch.current ? sel.value : null; };
  const refresh = () => {
    const other = chosen() ? ch.channels.find(c => c.id === chosen()) : null;
    if (other) { go.disabled = false; go.textContent = `Switch to ${other.label} & restart`; }
    else { go.disabled = !s.canUpdate; go.textContent = stayLabel; }
    if ($('upd-force')) $('upd-force').disabled = !!other;
  };
  for (const r of d.querySelectorAll('input[name="upd-channel"]')) r.addEventListener('change', refresh);
  $('upd-close').addEventListener('click', () => d.close());
  go.addEventListener('click', () => runUpdateFromPhone(chosen()));
}

async function runUpdateFromPhone(channel, force = false) {
  const d = $('update-sheet');
  const go = $('upd-go');
  if (go) { go.disabled = true; go.textContent = channel ? 'Switching…' : 'Updating…'; }
  let r;
  try {
    const resp = await api(force ? '/api/git-sync/force-update' : '/api/git-sync/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(channel && !force ? { channel } : {}) });
    r = await resp.json();
  } catch (e) { r = { success: false, error: e.message }; }
  if (!r || !r.success) {
    d.innerHTML = `<p class="upd-err">Update failed: ${esc((r && r.error) || 'unknown error')}</p><div class="btns"><button id="upd-close">Close</button><button id="upd-details" class="go">Details</button></div>`;
    $('upd-close').addEventListener('click', () => d.close());
    $('upd-details').addEventListener('click', () => openUpdateSheet());
    return;
  }
  d.innerHTML = `<p>Updated to ${esc(r.head)}.</p>${(r.steps || []).map(st => `<div><small>• ${esc(st)}</small></div>`).join('')}<p>Restarting…</p>`;
  setTimeout(() => { d.close(); restartHub(); }, 800);   // the same restart-and-wait path as the Restart button
}

// ── Update available (lib/update-check): the server looks at GitHub once a day. While an update waits, admins see a
// card on the agent list (Update now / Later) and a note on the ⋮ menu's Update item; the push notification opens
// /mobile?update=1, which shows the same choice as a sheet. "Update now" is the Update sheet's own update and restart. ──
let ucState = null;
async function refreshUpdateCheck() {
  if (!hubMe || !isAdmin()) { paintUpdateCard(); return null; }
  try { const r = await api('/api/update-check'); if (!r.ok) return null; ucState = await r.json(); } catch { return null; }
  paintUpdateCard();
  return ucState;
}
function ucBody(s) {
  const busy = agents.map(a => a.name).filter(n => isBusy(n));
  const notes = (s.titles || []).map(t => `<li>${esc(t)}</li>`).join('') + (s.more ? `<li class="uc-more">and ${s.more} more</li>` : '');
  const have = s.latestVersion && s.latestVersion !== s.currentVersion && s.currentVersion ? `You have ${esc(s.currentVersion)}.` : `You're on ${esc(s.channel || s.branch || 'this channel')}.`;
  const warn = s.blocked
    ? `<p class="uc-warn">This hub has ${s.ahead ? `${s.ahead} commit${s.ahead === 1 ? '' : 's'} of its own that GitHub doesn't have` : `${s.dirty} changed file${s.dirty === 1 ? '' : 's'} that ${s.dirty === 1 ? "isn't" : "aren't"} committed`}, so it can't update by itself. Open Details to choose.</p>`
    : busy.length ? `<p class="uc-warn">${busy.length === 1 ? `${esc(displayName(busy[0]))} is` : `${busy.length} agents are`} working. Updating restarts the hub and cuts ${busy.length === 1 ? 'that reply' : 'those replies'} short.</p>` : '';
  return `<div class="uc-head">⬇️ ${esc(s.headline || 'An update is ready')}</div><div class="uc-sub">${have}${s.security ? ' <b class="uc-sec">Includes a security fix.</b>' : ''}</div>${notes ? `<ul class="uc-notes">${notes}</ul>` : ''}${warn}`;
}
function paintUpdateCard() {
  const card = $('update-card'), note = $('menu-update-note');
  const s = isAdmin() ? ucState : null;
  const avail = !!(s && s.enabled && s.available);
  if (note) note.textContent = avail ? ` · ${s.latestVersion && s.latestVersion !== s.currentVersion ? s.latestVersion : 'new version'} ready` : '';
  if (!card) return;
  if (!avail || s.snoozed) { card.hidden = true; card.innerHTML = ''; return; }
  card.classList.toggle('sec', !!s.security);
  card.dataset.remote = s.remote || '';   // Later names the version this card shows
  card.innerHTML = `${ucBody(s)}<div class="uc-actions">${s.blocked
    ? '<button class="uc-btn" data-uc="later">Later</button><button class="uc-btn uc-primary" data-uc="details">Details</button>'
    : '<button class="uc-btn" data-uc="details">Details</button><button class="uc-btn" data-uc="later">Later</button><button class="uc-btn uc-primary" data-uc="now">Update now</button>'}</div>`;
  card.hidden = false;
}
// The notification's tap lands here (/mobile?update=1): the card's choice, as a sheet.
async function openUpdatePrompt() {
  const s = ucState || await refreshUpdateCheck();
  if (!s || !s.available) { openUpdateSheet(); return; }
  const d = $('update-sheet');
  d.dataset.uc = '1';
  d.dataset.remote = s.remote || '';
  d.innerHTML = `${ucBody(s)}<div class="btns">${s.blocked
    ? '<button data-uc="later">Later</button><button class="go accent" data-uc="details">Details</button>'
    : '<button data-uc="later">Later</button><button class="go accent" id="upd-go" data-uc="now">Update now</button>'}</div>`;
  if (!d.open) d.showModal();
}
async function updateLater(shown) {
  const d = $('update-sheet');
  if (d.open && d.dataset.uc === '1') d.close();
  if ($('update-card')) $('update-card').hidden = true;
  // Later names the version on the card: a newer one found meanwhile still shows.
  try { const r = await api('/api/update-check/later', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remote: shown || (ucState && ucState.remote) || null }) }); if (r.ok) ucState = await r.json(); } catch { /* back on the next look */ }
  paintUpdateCard();
}
function updateNowFromPhone() {
  // Who is working now, not when the card was drawn: the restart cuts their replies short.
  const busy = agents.map(a => a.name).filter(n => isBusy(n));
  if (busy.length && !confirm(`${busy.map(displayName).join(', ')} ${busy.length === 1 ? 'is' : 'are'} working. Updating restarts the hub and cuts ${busy.length === 1 ? 'that reply' : 'those replies'} short. Update now anyway?`)) return;
  const d = $('update-sheet');
  d.dataset.uc = '';
  d.innerHTML = '<h3>Updating…</h3><p>Getting the new version ready. The hub restarts when it is done.</p><div class="btns"><button id="upd-go" class="go accent" disabled>Updating…</button></div>';
  if (!d.open) d.showModal();
  runUpdateFromPhone(null);
}
function onUpdateChoice(e) {
  const b = e.target.closest('[data-uc]');
  if (!b) return;
  if (b.dataset.uc === 'later') updateLater((b.closest('#update-sheet, #update-card') || {}).dataset?.remote || '');
  else if (b.dataset.uc === 'now') updateNowFromPhone();
  else if (b.dataset.uc === 'details') { const d = $('update-sheet'); d.dataset.uc = ''; openUpdateSheet(); }
}

// ── Version label and About (GET /api/version, lib/hub-map versionInfo): the ⋮ menu's first item carries the label
// (experimental and other branches in their own colour, a dot while a restart is pending) and opens the About sheet. ──
let hubVersion = null;
async function paintVersionLabel() {
  try { const r = await api('/api/version'); if (r.ok) hubVersion = await r.json(); } catch { /* keep the last one */ }
  const el = $('menu-version'), l = versionLabel(hubVersion);
  if (!el) return hubVersion;
  el.className = l ? `menu-version ${l.kind}` : 'menu-version';
  el.innerHTML = l ? `${esc(l.text)}${hubVersion.restartPending ? ' <span class="hv-dot" title="Restart pending: code on disk is newer than the running hub"></span>' : ''}` : '';
  return hubVersion;
}
async function openAboutSheet() {
  $('menu').classList.remove('open');
  const d = $('about-sheet');
  const opening = {};   // this opening: one still loading from an earlier opening must not fill it
  d._opening = opening;
  d.innerHTML = '<h3>About My Maestro AI</h3><p>Loading…</p><div class="btns"><button data-ab="close">Close</button></div>';
  if (!d.open) d.showModal();
  const [v, u] = await Promise.all([paintVersionLabel(), isAdmin() ? refreshUpdateCheck() : Promise.resolve(null)]);
  if (!d.open || d._opening !== opening) return;
  if (!v) { d.innerHTML = '<h3>About My Maestro AI</h3><p>Could not read the version from the hub.</p><div class="btns"><button data-ab="close">Close</button></div>'; return; }
  const l = versionLabel(v) || { kind: 'other' };
  const started = v.startedAt ? new Date(v.startedAt) : null;
  const up = updateStatusText(u);
  const row = (k, val) => `<dt>${k}</dt><dd>${val}</dd>`;
  d.innerHTML = `<h3>About My Maestro AI</h3><dl class="about-grid">
    ${row('Version', `${esc(v.version || 'unknown')} <span class="menu-version ${l.kind} about-chip">${esc(v.channel || v.branch || 'no branch')}</span>`)}
    ${row('Branch', esc(v.branch || '—'))}
    ${row('Commit', `<code>${esc(v.commit || '—')}</code>${v.commitDate ? ` · ${esc(v.commitDate)}` : ''}`)}
    ${row('Started', started && !isNaN(started) ? esc(started.toLocaleString()) : '—')}
    ${v.restartPending ? row('Restart', '<span class="about-warn"><span class="hv-dot"></span> pending: code on disk is newer than the running hub</span>') : ''}
    ${row('Node.js', esc(v.node || '—'))}
    ${up ? row('Updates', esc(up)) : ''}
  </dl><div class="btns">${u && u.available ? '<button data-ab="update">Update…</button>' : ''}<button data-ab="copy">Copy details</button><button class="go accent" data-ab="close">Close</button></div>`;
  d._about = { v, u };
}
function onAboutClick(e) {
  const d = $('about-sheet');
  const b = e.target.closest('[data-ab]');
  if (!b) return;
  const { v, u } = d._about || {};
  if (b.dataset.ab === 'copy') copyText(versionDetailsText(v, u, navigator.userAgent));
  else if (b.dataset.ab === 'update') { d.close(); openUpdatePrompt(); }
  else d.close();
}

// ── Restart the hub (same POST /api/restart the desktop button uses; the
// service manager brings the hub back, so the page only has to wait) ─────────
function confirmRestart() {
  $('menu').classList.remove('open');
  const busy = agents.map(a => a.name).filter(n => isBusy(n));
  let text = 'Restart My Maestro AI? Saved chats, memory and notes are kept. The hub is unavailable for about 15 seconds.';
  if (busy.length) text = `${busy.length} agent${busy.length > 1 ? 's are' : ' is'} still working (${busy.map(displayName).join(', ')}). Restarting now cuts ${busy.length > 1 ? 'those turns' : 'that turn'} short. ` + text;
  $('restart-text').textContent = text;
  $('restart-confirm').showModal();
}

async function restartHub() {
  $('restart-confirm').close();
  try {
    const r = await api('/api/restart', { method: 'POST' });
    if (!r.ok) { toast(`Restart refused: HTTP ${r.status}`); return; }
  } catch {
    // The connection dropping here is the server going down, which is expected.
  }
  const t = $('toast');
  clearTimeout(toast.timer);
  t.textContent = 'Restarting hub…';
  t.classList.add('on');
  const started = Date.now();
  const poll = async () => {
    if (Date.now() - started > 120000) { toast('Hub did not come back; check the server'); return; }
    try {
      const r = await api('/api/health', { signal: AbortSignal.timeout(4000) });
      if (r.ok) { t.textContent = 'Hub is back'; setTimeout(() => location.reload(), 600); return; }
    } catch {}
    setTimeout(poll, 2000);
  };
  setTimeout(poll, 6000);
}

async function clearSession() {
  const name = current;
  $('confirm').close();
  if (!name) return;
  try {
    const r = await api(`/api/session/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    chatHistory = []; histGen++;
    shown = 0;
    renderHistory();
    toast('New session started');
  } catch (e) {
    toast(`Could not clear: ${e.message}`);
  }
}

// ── Hub events (/api/events) and Activity ───────────────────────────────────

let esLastEventAt = 0;   // when the last event of any kind (the hub's 15 s ping included) arrived
let esLastSeq = 0;       // sequence of the last ring event seen: a deliberate reconnect asks for ?since= it, so nothing is lost
function connectEvents() {
  if (es) { try { es.close(); } catch {} }   // one stream alive at a time
  const source = new EventSource('/api/events' + (esLastSeq > 0 ? `?since=${esLastSeq}` : ''), { withCredentials: true });
  es = source;
  esLastEventAt = Date.now();
  const on = (type, fn) => source.addEventListener(type, (e) => { esLastEventAt = Date.now(); let ev; try { ev = JSON.parse(e.data); } catch { return; } if (ev && Number(ev.seq) > esLastSeq) esLastSeq = Number(ev.seq); fn(ev); });
  on('hello', (ev) => {
    if (!ev) return;
    if (Number(ev.lastId) > esLastSeq) esLastSeq = Number(ev.lastId);
    // The hub restarted since this page loaded (different boot id): reload once nothing is streaming here and no
    // open sheet holds unsaved changes (phones don't warn before a reload, so they would be lost).
    if (ev.boot) {
      if (!window.__hubBoot) window.__hubBoot = ev.boot;
      else if (ev.boot !== window.__hubBoot && !window.__hubReloading) {
        window.__hubReloading = true;
        toast('The hub restarted. Reloading to the new version…');
        const since = Date.now();
        const busy = () => streams.size || (typingNow() && Date.now() - since < 600000) || dialogGuard.hasChanges();
        const go = () => { if (busy()) { setTimeout(go, 2000); return; } setTimeout(() => { if (busy()) go(); else location.reload(); }, 800); };   // checked again just before
        go();
      }
    }
  });
  on('ping', () => {});
  on('status_snapshot', (ev) => { applySnapshot(ev.agents); if (ev.pacing) applyPacing(ev.pacing.paced); if (ev.approvals) applyApprovals(ev.approvals); });
  on('approval_request', (ev) => onApprovalEvent({ ...ev, type: 'approval_request' }));
  on('approval_resolved', (ev) => onApprovalEvent({ ...ev, type: 'approval_resolved' }));
  on('provider_paced', (ev) => upsertPacing(ev, 'paced'));
  on('provider_ramp', (ev) => upsertPacing(ev, 'ramping'));
  on('provider_recovered', (ev) => { if (ev && ev.provider) clearPacing(ev.provider); });
  on('turn_start', onTurnStart);
  on('turn_delta', onTurnDelta);
  on('turn_reasoning', onTurnReasoning);
  on('turn_activity', onTurnActivity);
  on('turn_progress', onTurnProgress);
  on('turn_worker_delta', onTurnWorkerDelta);
  on('turn_end', onTurnEnd);
  on('turn_notify', onTurnNotify);
  on('ask_user', (ev) => {
    setLive(ev.agent, { busy: true, pendingQuestion: true }); paintStatus();
    // The question itself: shown now if that chat is open, else kept until it is (dedup by request id in showQuestion).
    if (ev.request_id && Array.isArray(ev.questions)) {
      const q = { request_id: ev.request_id, questions: ev.questions };
      if (chatOpenFor(ev.agent)) showQuestion(q);
      else {
        pendingQuestionsByAgent.set(ev.agent, q);
        toast(`❓ ${displayName(ev.agent)} is asking you something. Tap to answer.`, 8000, () => navigate('chat', ev.agent));
      }
    }
  });
  on('ask_user_done', (ev) => { if (!ev) return; pendingQuestionsByAgent.delete(ev.agent); if (ev.request_id) closeQuestion(ev.request_id, ev.result); });
  on('ask_user_done', (ev) => { setLive(ev.agent, { pendingQuestion: false }); paintStatus(); });
  on('compaction_start', onCompactionStart);
  on('compaction_progress', onCompactionProgress);
  on('compaction_end', onCompactionEnd);
  on('agent_updated', onAgentUpdated);
  $('chat-model-pick')?.addEventListener('change', changeModelFromPick);
  $('chat-effort-pick')?.addEventListener('change', changeEffortFromPick);
  on('model_fallback', (ev) => toast(`${displayName(ev.agent)}: ${String(ev.from || '').split('/').pop()} at its weekly limit; running on ${String(ev.to || '').split('/').pop()} until ${ev.resetsAt ? new Date(ev.resetsAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'it resets'}`));
  // Plan warnings and refusals (lib/plan-usage): no pop-up over the input; the usage in the chat header updates.
  on('plan_limit', () => refreshPlanUsage());
  on('plan_warning', () => refreshPlanUsage());
  // (Re)connected: whatever happened to the open chat's turn meanwhile comes from the hub's turn view.
  source.onopen = () => { esLastEventAt = Date.now(); reattachCheckAll(); catchUpOpenAgent(); };
  // A dead session closes the stream with no status code: probe an API call, which redirects to /login on 401.
  source.onerror = () => { if (source.readyState === EventSource.CLOSED && es === source) { api('/api/me').catch(() => {}); setTimeout(() => { if (es === source) connectEvents(); }, 3000); } };
}

// Dead-connection watchdog. After the phone or laptop sleeps the EventSource often still reports
// OPEN while its TCP connection is gone, so nothing arrives again, not even the hub's ping every
// 15 s. Three missed pings and the stream is replaced; onopen then catches up on the open turn.
const ES_STALE_MS = 45000;
function eventsWatchdog() {
  if (!es || !esLastEventAt || Date.now() - esLastEventAt <= ES_STALE_MS) return;
  console.warn(`[events] no event for ${Math.round((Date.now() - esLastEventAt) / 1000)}s: reconnecting`);
  connectEvents();
}

// Full recovery without a reload: a fresh event stream, fresh agents and status, then the open
// chat's turn catches up from the hub's turn view. Debounced: focus, visibilitychange and pageshow
// all fire together on a wake.
let resyncAt = Date.now();
async function resync(force = false) {
  if (Date.now() - resyncAt < 2000) return false;
  resyncAt = Date.now();
  // Replace the event stream only when it is missing, not open, or silent past the ping cadence (the
  // phone was asleep or in another app), or on an explicit request: a healthy stream stays, so no event
  // falls in a reconnect gap. (A replaced stream asks for a replay since the last seq anyway.)
  const stale = !es || es.readyState !== EventSource.OPEN || (esLastEventAt && Date.now() - esLastEventAt > ES_STALE_MS);
  if (force || stale) connectEvents();
  await loadAgents();
  pollStatus();
  pollHubStatus();
  pollApprovals();   // a push tap brought us here: the card may predate this page's snapshot
  if (screen === 'activity') loadActivityExtras();
  reattachCheckAll();
  catchUpOpenAgent();   // the open chat's agent is mid-turn: refresh the hub's view of that turn
  return true;
}

// The ↻ button in the chat topbar: always acts, spins for a second, and says what it did.
function resyncClick() {
  const btn = $('chat-resync');
  if (btn) { btn.classList.add('spinning'); btn.disabled = true; setTimeout(() => { btn.classList.remove('spinning'); btn.disabled = false; }, 1000); }
  resyncAt = 0;
  resync(true);
  const busy = current && (streams.has(current) || reattaches.has(current) || isBusy(current));
  toast(busy ? `Re-synced with the hub, following ${displayName(current)}'s turn` : 'Re-synced with the hub');
}

function chatOpenFor(agent) {
  return screen === 'chat' && current === agent;
}

// ── Context compression (agent-authored working brief) ──────────────────────
// The hub's compaction_start / compaction_end events become notes in the open chat; the ⋮ menu's
// "Compress now" asks, then POSTs /api/agents/<name>/compaction/run (the turn itself streams in
// like any hub-started turn).
const COMPACTION_MODE_LABEL = { off: 'off', dry: 'dry run', on: 'on', assisted: 'assisted' };
function compactionModeLabel(mode) { return COMPACTION_MODE_LABEL[mode] || String(mode || 'off'); }
let compactionNote = null;   // the notice line of the compression in progress, updated in place
function onCompactionStart(ev) {
  if (!ev || !chatOpenFor(ev.agent)) return;
  compactionNote = addNote(`⚙ ${displayName(ev.agent)} is writing its working brief (${compactionModeLabel(ev.mode)})…`);
  compactionNote.dataset.agent = ev.agent;
  scrollChat();
}
// compaction_progress { agent, part, parts } (assisted mode)
function onCompactionProgress(ev) {
  if (!ev || !chatOpenFor(ev.agent)) return;
  const text = `⚙ ${displayName(ev.agent)} is extracting slice ${ev.part} of ${ev.parts}…`;
  if (compactionNote && compactionNote.isConnected && compactionNote.dataset.agent === ev.agent) compactionNote.textContent = text;
  else { compactionNote = addNote(text); compactionNote.dataset.agent = ev.agent; }
  scrollChat();
}
function onCompactionEnd(ev) {
  if (!ev || !chatOpenFor(ev.agent)) return;
  compactionNote = null;
  if (ev.ok === false || ev.error) addNote(`⚠ compression failed: ${ev.error || 'unknown error'}`);
  else addNote(ev.reset ? '✓ brief written, fresh session started' : '✓ brief written');
  scrollChat();
}
async function compressNow() {
  if (!current) { toast('Open an agent\'s chat first'); return; }
  $('menu').classList.remove('open');
  const agent = current;
  let mode = 'off';
  try {
    const r = await api(`/api/agents/${encodeURIComponent(agent)}/compaction`);
    const d = await r.json();
    if (d && d.ok) mode = d.mode || 'off';
  } catch {}
  const what = mode === 'on'
    ? `${displayName(agent)} writes its working brief, then its session is reset and seeded from Records, recent turns and recall.`
    : mode === 'dry'
      ? `${displayName(agent)} writes its working brief; the session goes on unchanged (dry run).`
      : `Compression is off for ${displayName(agent)}: this runs a dry run, the brief only.`;
  if (!confirm(`Compress now?\n\n${what}\n\nThis takes a turn of the agent (it can run for minutes).`)) return;
  let r, d = {};
  try { r = await api(`/api/agents/${encodeURIComponent(agent)}/compaction/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
  catch (e) { toast(`Could not start: ${e.message}`); return; }
  try { d = await r.json(); } catch {}
  if (!r.ok || !d || d.ok === false) { toast(`Could not start: ${(d && d.error) || `HTTP ${r.status}`}`); return; }
  toast(`Compression started (${compactionModeLabel(d.mode || mode)})`);
}

function onTurnStart(ev) {
  if (ev.turnId && hubTurns[ev.turnId]) return;   // replayed after a reconnect (?since=): the turn is already followed
  setLive(ev.agent, { busy: true, busySince: ev.startedAt || null, activity: ev.activity || originLabel(ev.origin) });
  const own = ev.origin?.kind === 'user' && ownTurnFor(ev.agent);
  if (chatOpenFor(ev.agent) && !streams.has(ev.agent) && !own) {
    const last = chatHistory[chatHistory.length - 1];
    if (typeof ev.message === 'string' && !(last && last.role === 'user' && last.content === ev.message)) {
      addNote(`⚡ ${ev.origin?.kind === 'user' ? 'sent from another device' : originLabel(ev.origin)} — ${timeLabel()}`);
      addUserBubble(ev.message, null);
    }
    const b = addAssistantBubble('…');
    hubTurns[ev.turnId] = { agent: ev.agent, bubble: b, el: b.el, body: b.body, feed: null, startedAt: ev.startedAt || null };
    scrollChat();
  }
  paintStatus();
}

function onTurnDelta(ev) {
  const t = hubTurns[ev.turnId];
  if (!t) {
    const ra = reattaches.get(ev.agent);
    if (ra && ev.text && (!ra.turnId || ra.turnId === ev.turnId)) { ra.turnId = ra.turnId || ev.turnId; ra.partial = ev.text; paintReattach(ra); }
    return;
  }
  if (!chatOpenFor(t.agent) || !t.el.isConnected || !ev.text) return;
  setReplyText(t, ev.text);
  scrollChat();
}

// The holder following a turn: the bubble turn_start made, else the re-attach for that agent (which
// adopts the turn id from the first event it sees).
function turnHolder(ev) {
  const t = hubTurns[ev.turnId];
  if (t) return t;
  const ra = reattaches.get(ev.agent);
  if (ra && (!ra.turnId || ra.turnId === ev.turnId)) { ra.turnId = ra.turnId || ev.turnId; return ra; }
  return null;
}

// turn_activity { turnId, agent, item }: a tool call, a worker, or a worker's tool line (upsert by item.id).
function onTurnActivity(ev) {
  const h = ev && turnHolder(ev);
  if (!h || !ev.item) return;
  feedUpsert(h, ev.item);
  if (reattaches.get(ev.agent) === h) paintReattach(h, reattachLine(h));
}

// turn_reasoning { turnId, agent, at, text }: the next piece of the turn's reasoning. A piece this phone never got (the
// hub does not replay them) brings the hub's turn view, which has the reasoning so far.
let rsnCatchUp = 0;
function onTurnReasoning(ev) {
  const h = ev && turnHolder(ev);
  if (!h || reasoningAdd(h, typeof ev.text === 'string' ? ev.text : '', Number(ev.at)) || rsnCatchUp) return;
  rsnCatchUp = setTimeout(() => { rsnCatchUp = 0; catchUpOpenAgent(); }, 400);
}

// turn_worker_delta { turnId, agent, workerId, text }: the worker's text so far.
function onTurnWorkerDelta(ev) {
  const h = ev && turnHolder(ev);
  if (h) feedWorkerText(h, ev.workerId, ev.text, false);
}

// turn_progress { turnId, agent, progress, usage, context } (also in the turn view): what the agent is doing right now
// ("running Bash", "thinking") for the header and the status line of a followed turn, and the context size.
function phaseText(p) {
  if (!p) return '';
  if (p.phase === 'tool') return `running ${p.detail || 'a tool'}`;
  if (p.phase === 'stream') return 'writing';
  if (p.phase === 'reasoning') return 'reasoning';
  return 'thinking';
}
function applyTurnProgress(agent, p, holder = null) {
  if (!agent || !p) return;
  if (p.context) noteCtxReading(agent, p.context);
  if (!p.progress || streams.has(agent)) return;
  if (isBusy(agent)) { setLive(agent, { busy: true, activity: phaseText(p.progress) }); if (agent === current) paintChatStatus(); }
  if (holder) holder.progress = { ...p.progress, at: Date.now() };
  if (holder && reattaches.get(agent) === holder) paintReattach(holder, reattachLine(holder));
}
function onTurnProgress(ev) {
  if (!ev || !ev.agent) return;
  applyTurnProgress(ev.agent, ev, turnHolder(ev));
}

function onTurnEnd(ev) {
  setLive(ev.agent, { busy: false });
  if (ev.agent && notifyArmed[ev.agent]) { notifyArmed[ev.agent] = null; if (ev.agent === current) paintNotifyBtn(); }
  if (ev.agent && ev.agent === current) setTimeout(() => refreshCtx(ev.agent), 3500);   // the hub records the size 2.5 s after the turn
  const reply = ev.reply || (ev.ok ? '(no reply)' : `⚠ turn failed: ${ev.error || 'unknown error'}`);
  const t = hubTurns[ev.turnId];
  delete hubTurns[ev.turnId];
  const ownTurn = ev.origin?.kind === 'user';
  // A turn this device streamed itself: sendMessage paints and flags it; the hub's event is a duplicate.
  const ownStream = streams.has(ev.agent) || (Date.now() - (recentOwn.get(ev.agent) || 0) < 15000);
  const ra = reattaches.get(ev.agent);
  if (t) reasoningEnd(t);
  if (t && chatOpenFor(t.agent) && t.el.isConnected) {
    setReplyText(t, reply);
    feedEnd(t);
    rereadHistory(t.agent);   // the finished exchange (its message came from elsewhere), as the hub saved it
    scrollChat();
  } else if (ra) {
    if (ev.reply) finishReattach(ra, ev.reply, true);
    else if (ev.ok === false) finishReattach(ra, `${ra.partial ? ra.partial + '\n\n' : ''}${reply}`, false);
    else reattachCheck(ra);
  } else if (chatOpenFor(ev.agent) && !streams.has(ev.agent) && !ownTurn) {
    addAssistantBubble(reply);
    rereadHistory(ev.agent);
    scrollChat();
  } else if (!chatOpenFor(ev.agent) && !ownStream) {
    markUnread(ev.agent);
  }
  if (!ownTurn) {
    activity.unshift({ id: ev.turnId, ts: ev.ts || ev.endedAt || new Date().toISOString(), agent: ev.agent, origin: ev.origin, ok: ev.ok !== false, text: ev.ok === false ? (ev.error || 'turn failed') : (ev.reply || '') });
    activity.length = Math.min(activity.length, ACTIVITY_MAX);
    saveJson('hub-mobile-activity', activity);
    if (screen !== 'activity') actUnseen++;
    if (screen === 'activity') renderActivity();
  }
  paintStatus();
  updateDots();
}

function plain(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function renderActivity() {
  const list = $('activity-list');
  let html = '<div class="section-h">Recent</div>';
  if (!activity.length) html += '<div class="empty">Nothing yet. Turns the hub starts on its own (consultations, jobs, scheduled tasks) show up here.</div>';
  for (const a of activity) {
    html += `<button class="act-row" data-agent="${esc(a.agent)}"><div class="act-top"><b>${esc(displayName(a.agent))}</b><span>${esc(timeLabel(a.ts))}</span></div>` +
      `<div class="act-origin">${esc(originLabel(a.origin))}</div>` +
      `<div class="act-text${a.ok ? '' : ' err'}">${esc(plain(a.text).slice(0, 120))}</div></button>`;
  }
  html += '<div id="act-sched"></div><div id="act-jobs"></div>';
  list.innerHTML = html;
  paintExtras();
}

let extras = { tasks: null, jobs: null };

function paintExtras() {
  const sched = $('act-sched');
  const jobs = $('act-jobs');
  if (!sched || !jobs) return;
  if (extras.tasks) {
    sched.innerHTML = '<div class="section-h">Scheduled</div>' + (extras.tasks.length
      ? extras.tasks.map(t => `<div class="info-row"><b>${esc(t.label || t.id)}</b> · ${esc(displayName(t.agent))}<small>next: ${esc(t.nextRunLocal || '—')}</small></div>`).join('')
      : '<div class="empty">No active scheduled tasks.</div>');
  }
  if (extras.jobs) {
    jobs.innerHTML = '<div class="section-h">Jobs</div>' + (extras.jobs.length
      ? extras.jobs.map(j => `<div class="info-row"><b>${esc(j.name)}</b><small>${esc(j.status)}${j.runningFor ? ` · running ${esc(j.runningFor)}` : ''}</small></div>`).join('')
      : '<div class="empty">No jobs.</div>');
  }
}

async function loadActivityExtras() {
  try {
    const [t, j] = await Promise.all([api('/api/scheduled-tasks'), api('/api/jobs')]);
    if (t.ok) extras.tasks = ((await t.json()).tasks || []).filter(x => x.status === 'active');
    if (j.ok) extras.jobs = ((await j.json()).jobs || []).slice(0, 15);
  } catch (e) {
    toast(`Could not refresh: ${e.message}`);
  }
  paintExtras();
}

// ── Push notifications (Web Push through /sw.js) ────────────────────────────
// Only a preference flag lives in localStorage; the subscription itself is held by the
// browser and the hub.  Payloads carry a title/short body/url, never message content.

const PUSH_PREF = 'hub-mobile-push';   // 'on' | 'off' | 'later'

function pushSupport() {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) return 'unsupported';
  if (!('PushManager' in window)) {
    const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    return ios && !standalone ? 'install' : 'unsupported';
  }
  return 'ok';
}

function vapidKeyBytes(key) {
  const pad = '='.repeat((4 - key.length % 4) % 4);
  const raw = atob((key + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function pushSubscription() {
  if (pushSupport() !== 'ok') return null;
  try { return await (await navigator.serviceWorker.ready).pushManager.getSubscription(); } catch { return null; }
}

// 'on' means the browser holds a subscription AND the hub has it on file. The two drift (the hub's file lost, or the
// registration call failed after the browser subscribed): then the phone re-registers on its own, and if that fails
// too the state is 'lost' so the menu says so instead of a false "on".
let pushKnownByHub = null;
async function pushState() {
  const support = pushSupport();
  if (support !== 'ok') return support;
  if (Notification.permission === 'denied') return 'denied';
  const sub = await pushSubscription();
  if (!sub) return 'off';
  try {
    const r = await api('/api/push/status?endpoint=' + encodeURIComponent(sub.endpoint));
    if (r.status === 404) { pushKnownByHub = null; return 'on'; }   // older hub without the status route
    if (!r.ok) return 'on';
    const d = await r.json();
    if (d.known) { pushKnownByHub = true; return 'on'; }
    const again = await api('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON(), agents: null }) });
    pushKnownByHub = again.ok;
    return again.ok ? 'on' : 'lost';
  } catch { return 'on'; }
}

async function testPush() {
  $('menu').classList.remove('open');
  try {
    const r = await api('/api/push/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = r.ok ? await r.json() : {};
    if (!r.ok) { toast(`Test failed (HTTP ${r.status})`); return; }
    if (!d.sent && !d.failed) { toast('The hub has no phone registered. Turn notifications off and on again.'); return; }
    toast(`Test sent to ${d.sent} device${d.sent === 1 ? '' : 's'}${d.failed ? `, ${d.failed} failed` : ''}. A banner should pop up within seconds, even with the app open. If it does not, check the phone's notification settings for this app.`);
  } catch (e) { toast(`Test failed: ${e.message}`); }
}

async function enablePush() {
  const support = pushSupport();
  if (support === 'install') { toast('Install to home screen first (Share → Add to Home Screen), then turn on notifications'); return; }
  if (support !== 'ok') { toast('Notifications are not supported in this browser'); return; }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications are blocked for this site'); await paintPush(); return; }
    const kr = await api('/api/push/vapid-public-key');
    if (!kr.ok) { toast(kr.status === 404 ? 'This hub does not support push yet' : `Could not get push key (HTTP ${kr.status})`); return; }
    const { key } = await kr.json();
    if (!key) { toast('Push is not configured on the hub'); return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKeyBytes(key) });
    const r = await api('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), agents: null }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    saveJson(PUSH_PREF, 'on');
    toast('Notifications on');
  } catch (e) {
    toast(`Could not turn on notifications: ${e.message}`);
  }
  await paintPush();
}

async function disablePush() {
  try {
    const sub = await pushSubscription();
    if (sub) {
      await api('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
      await sub.unsubscribe();
    }
    toast('Notifications off');
  } catch (e) {
    toast(`Could not turn off notifications: ${e.message}`);
  }
  saveJson(PUSH_PREF, 'off');
  await paintPush();
}

async function togglePush() {
  $('menu').classList.remove('open');
  const state = await pushState();
  if (state === 'on' || state === 'lost') await disablePush();
  else await enablePush();
}

async function paintPush() {
  const state = await pushState();
  const item = $('menu-notify');
  if (item) {
    item.textContent = {
      on: '🔔 Notifications: on (tap to turn off)',
      lost: '🔕 Notifications: the hub lost this phone (tap to turn off, then on)',
      off: '🔕 Notifications: off (tap to turn on)',
      denied: '🔕 Notifications blocked in browser settings',
      install: '🔔 Notifications: install to home screen first',
      unsupported: '🔕 Notifications not supported here',
    }[state] || '🔔 Notifications';
  }
  const t = $('menu-notify-test');
  if (t) t.hidden = state !== 'on';
  const banner = $('push-banner');
  if (banner) {
    const pref = loadJson(PUSH_PREF, null);
    const show = (state === 'off' || state === 'install') && pref !== 'later' && pref !== 'off';
    banner.classList.toggle('on', show);
    if (show) {
      $('push-banner-text').textContent = state === 'install'
        ? 'Get notified when an agent finishes or asks you something: install My Maestro AI to your home screen first.'
        : 'Get notified when an agent finishes or asks you something.';
      $('push-banner-on').style.display = state === 'install' ? 'none' : '';
    }
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────────

function wire() {
  $('tab-agents').addEventListener('click', () => { navigate('agents'); if (approvals.size && approvalsHidden) { approvalsHidden = false; paintApprovals(); } });
  $('tab-chat').addEventListener('click', () => navigate('chat'));
  $('tab-activity').addEventListener('click', () => navigate('activity'));
  $('chat-back').addEventListener('click', goBackFromChat);
  $('agents-refresh').addEventListener('click', loadAgents);
  $('activity-refresh').addEventListener('click', loadActivityExtras);

  $('agents-list').addEventListener('click', (e) => {
    const g = e.target.closest('.group-title');
    if (g) { collapsed[g.dataset.group] = !collapsed[g.dataset.group]; saveJson('hub-mobile-collapsed', collapsed); renderAgents(); return; }
    const r = e.target.closest('.agent-row');
    if (r) navigate('chat', r.dataset.agent);
  });
  $('activity-list').addEventListener('click', (e) => {
    const r = e.target.closest('.act-row');
    if (r) navigate('chat', r.dataset.agent);
  });

  $('chat-menu-btn').addEventListener('click', toggleMenu);
  $('agents-menu-btn').addEventListener('click', toggleMenu);
  $('menu-about').addEventListener('click', (e) => { e.stopPropagation(); openAboutSheet(); });
  $('about-sheet').addEventListener('click', onAboutClick);
  // Esc, Back or a tap outside the approval sheet is Later: hidden until a new request comes, never answered.
  $('approval-sheet').__dialogClose = () => { approvalsHidden = true; paintApprovals(); };
  $('menu-security').addEventListener('click', openSecuritySheet);
  $('menu-files').addEventListener('click', openFilesSheet);
  $('menu-recall').addEventListener('click', openRecallSheet);
  $('menu-compact').addEventListener('click', compressNow);
  $('files-upload-input').addEventListener('change', (e) => { filesUpload(e.target.files); e.target.value = ''; });
  $('menu-signout').addEventListener('click', signOut);
  $('chat-stop-btn')?.addEventListener('click', stopRemoteTurn);
  $('chat-resync')?.addEventListener('click', resyncClick);
  document.addEventListener('click', () => $('menu').classList.remove('open'));
  $('menu-clear').addEventListener('click', confirmClear);
  $('menu-copy').addEventListener('click', copyWholeChat);
  $('menu-notify').addEventListener('click', togglePush);
  $('menu-notify-test')?.addEventListener('click', testPush);
  $('messages').addEventListener('click', onMessagesClick);
  $('messages').addEventListener('pointerdown', onReasoningGrip);
  $('messages').addEventListener('pointerdown', onToolsGrip);
  $('messages').addEventListener('keydown', (e) => {   // Enter or Space on a reasoning panel's header opens or closes it
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const head = e.target.closest && e.target.closest('.rsn-head');
    if (!head || e.target.closest('.rsn-full')) return;
    e.preventDefault();
    toggleReasoning(head.closest('.rsn'));
  });
  $('messages').addEventListener('keydown', (e) => {   // the same for a tool panel's header
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const head = e.target.closest && e.target.closest('.tsn-head');
    if (!head || e.target.closest('.tsn-full')) return;
    e.preventDefault();
    toggleTools(head.closest('.tsn'));
  });
  $('push-banner-on').addEventListener('click', enablePush);
  $('push-banner-later').addEventListener('click', () => { saveJson(PUSH_PREF, 'later'); paintPush(); });
  $('working-chip').addEventListener('click', () => { workingFilter = !workingFilter; renderAgents(); });
  $('confirm-no').addEventListener('click', () => $('confirm').close());
  $('confirm-yes').addEventListener('click', clearSession);
  $('menu-restart').addEventListener('click', confirmRestart);
  $('menu-update').addEventListener('click', openUpdateSheet);
  $('update-card').addEventListener('click', onUpdateChoice);
  $('update-sheet').addEventListener('click', onUpdateChoice);
  $('restart-no').addEventListener('click', () => $('restart-confirm').close());
  $('restart-yes').addEventListener('click', restartHub);
  for (const b of document.querySelectorAll('.pacing-bar')) b.addEventListener('click', confirmPacingReset);
  $('pacing-no').addEventListener('click', () => { pacingTarget = null; $('pacing-confirm').close(); });
  $('pacing-yes').addEventListener('click', resetPacing);

  const input = $('msg-input');
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 140)}px`; saveDraft(current, input.value); });
  input.addEventListener('focus', () => document.body.classList.add('kbd'));
  input.addEventListener('blur', () => document.body.classList.remove('kbd'));
  // Send, and the 🔔 beside it, act on the touch itself (onComposerTap). Once a send has taken the text,
  // sendAndClose lets go of the box so the keyboard goes away.
  onComposerTap($('send-btn'), sendAndClose);
  onComposerTap($('chat-notify-btn'), toggleNotifyDone);

  $('attach-btn').addEventListener('click', () => $('file-input').click());
  $('camera-btn').addEventListener('click', () => $('camera-input').click());
  // Images ride along with the message; any other file from the paperclip is uploaded to the
  // files root and "[file: <path>]" goes into the composer so the agent can read it.
  $('file-input').addEventListener('change', (e) => {
    for (const f of e.target.files) { if (f.type.startsWith('image/')) addImageFile(f); else uploadFileForChat(f); }
    e.target.value = '';
  });
  $('camera-input').addEventListener('change', (e) => { for (const f of e.target.files) addImageFile(f); e.target.value = ''; });

  $('chat-scroll').addEventListener('scroll', () => {
    const s = $('chat-scroll');
    stick = s.scrollHeight - s.scrollTop - s.clientHeight < 80;
  });

  window.addEventListener('popstate', (e) => applyRoute(e.state || routeFromHash()));
  // Coming back from sleep or another app: refresh status, the Activity feed and any lost reply.
  document.addEventListener('visibilitychange', onForeground);
  window.addEventListener('focus', onForeground);
  window.addEventListener('pageshow', onForeground);   // restored from the back/forward cache
  window.addEventListener('online', onForeground);
  // Elapsed times tick without re-fetching; polling only runs while the event stream is down.
  setInterval(() => { if (busyNames().length) paintStatus(); reattachCheckAll(); }, STATUS_TICK_MS);
  // The re-attach status line's elapsed time ticks on its own (cheap: only the line is repainted).
  setInterval(() => { for (const ra of reattaches.values()) if (!ra.checking && bubbleLive(ra)) paintReattach(ra, reattachLine(ra)); }, 5000);
  setInterval(() => { if (!es || es.readyState !== EventSource.OPEN) pollStatus(); }, STATUS_POLL_MS);
  // No live event stream (refused, asleep, a proxy that buffers): a followed turn in the open chat is fetched every
  // few seconds instead, so its text and tool calls keep coming (history alone has only the text).
  setInterval(() => {
    if (es && es.readyState === EventSource.OPEN && esLastEventAt && Date.now() - esLastEventAt <= ES_STALE_MS) return;
    if (current && screen === 'chat' && !streams.has(current) && (reattaches.has(current) || Object.values(hubTurns).some(t => t.agent === current))) catchUpOpenAgent();
  }, TURN_POLL_MS);
  setInterval(() => { if (!es || es.readyState !== EventSource.OPEN) pollHubStatus(); }, HUB_POLL_MS);
  setInterval(eventsWatchdog, 10000);
  // Sleep detector: a 5 s tick that lands 20 s late means the device slept or the tab was frozen.
  let lastTickAt = Date.now();
  setInterval(() => {
    const now = Date.now(), gap = now - lastTickAt;
    lastTickAt = now;
    if (gap > 20000) { console.warn(`[events] woke after ${Math.round(gap / 1000)}s: re-syncing`); resync(true); }
  }, 5000);
}

// ── Multi-user: owner switcher, account menu, Security sheet ────────────────

async function loadMe() {
  try {
    const r = await api('/api/me');
    if (r.ok) hubMe = await r.json();
  } catch {}
  return hubMe;
}

function applyMultiUser() {
  const sel = $('owner-view');
  if (hubMe && hubMe.isAdmin) {
    const opts = [['mine', 'Mine'], ['infra', 'Infrastructure']];
    for (const o of (hubMe.owners || [])) if (o.id !== hubMe.user.id) opts.push([o.id, `${o.name} (${o.count})`]);
    if (!opts.some(o => o[0] === ownerView())) localStorage.setItem(OWNER_VIEW_KEY, 'mine');
    sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
    sel.value = ownerView();
    sel.hidden = false;
    sel.addEventListener('change', () => { localStorage.setItem(OWNER_VIEW_KEY, sel.value); loadAgents(); if ($('files-sheet').open) openFilesSheet(''); });
  }
  if (hubMe && !hubMe.isAdmin) { $('menu-restart').hidden = true; $('menu-update').hidden = true; }
  if (hubMe) {
    $('menu-users').hidden = !hubMe.isAdmin;
    $('menu-2fa-note').hidden = !(hubMe.isAdmin && !hubMe.user.totpEnabled);
    $('menu-signout').textContent = `Sign out (${hubMe.user.name || hubMe.user.login})`;
  }
}

function toggleMenu(e) {
  e.stopPropagation();
  const menu = $('menu');
  menu.classList.toggle('no-chat', !$('screen-chat').classList.contains('active'));
  menu.classList.toggle('open');
  if (menu.classList.contains('open')) paintMenuCredit();
  if (menu.classList.contains('open')) paintVersionLabel();
}

// Monthly API credit (set on the desktop, Settings → Spend): this period's spend through the hub against it.
async function paintMenuCredit() {
  const el = $('menu-credit');
  if (!el) return;
  if (!isAdmin()) { el.hidden = true; return; }
  let list = [];
  try { const r = await api('/api/ledger/today'); if (r.ok) list = (await r.json()).credits || []; } catch { /* keep it hidden */ }
  el.hidden = !list.length;
  if (!list.length) return;
  const names = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', openrouter: 'OpenRouter', perplexity: 'Perplexity' };
  const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
  const cap = (n) => Number.isInteger(Number(n)) ? `$${Number(n)}` : usd(n);
  const period = (c) => c.resetDay === 1 ? 'this month' : `since ${new Date(`${c.since}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  el.textContent = list.map(c => `${names[c.provider] || c.provider} API credit: ${usd(c.spent)} of ${cap(c.monthlyUsd)} ${period(c)}${c.unpriced ? ` (+${c.unpriced} unpriced)` : ''}`).join('\n');
  const worst = Math.max(...list.map(c => c.spent / c.monthlyUsd));
  el.classList.toggle('hot', worst >= 0.9);
  el.classList.toggle('warn', worst >= 0.75 && worst < 0.9);
}

async function signOut() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  location.href = '/login';
}

async function authPost(url, body) {
  const r = await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok || data.ok === false || data.error) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function loadQrScript() {
  if (window.qrcode) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/qrcode.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('QR script failed to load'));
    document.head.appendChild(s);
  });
}

function secMsg(id, text, ok) {
  const el = $(id);
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('ok', !!ok);
}

function openSecuritySheet() {
  $('menu').classList.remove('open');
  const sheet = $('security-sheet');
  sheet.innerHTML = `
    <h3>Security</h3>
    <div id="sec-2fa" class="sec-section"></div>
    <div class="sec-section">
      <div class="sec-title">Change password</div>
      <input type="password" id="sec-pw-current" placeholder="Current password" autocomplete="current-password">
      <input type="password" id="sec-pw-new" placeholder="New password (12+ characters)" autocomplete="new-password">
      <input type="password" id="sec-pw-new2" placeholder="New password again" autocomplete="new-password">
      <div class="sec-actions"><button id="sec-pw-go" class="go">Change password</button></div>
      <div class="sec-msg" id="sec-pw-msg"></div>
    </div>
    <div class="sec-section">
      <div class="sec-title">Sessions</div>
      <div class="sec-actions"><button id="sec-revoke" class="danger">Sign out everywhere</button></div>
    </div>
    <div class="sec-actions" style="margin-top:10px"><button id="sec-close">Close</button></div>`;
  $('sec-pw-go').addEventListener('click', changePassword);
  $('sec-revoke').addEventListener('click', signOutEverywhere);
  $('sec-close').addEventListener('click', () => dialogRequestClose(sheet));
  paintTwoFactor();
  if (!sheet.open) sheet.showModal();
}

// ── Files: upload, download and browse the files agents can read (server: /api/files*) ──
// The sheet is rooted on the files folder of the agent whose chat is open (`current`, sent as agent=);
// with no chat open it falls back to the owner's general folder. `owner` is who the owner switcher
// shows (admins, infra mapped to mine); members omit it.
const filesState = { path: '', root: null, entries: [], maxUploadBytes: 0, openRow: -1, agent: '' };
function filesOwner() {
  if (!hubMe || !hubMe.isAdmin) return null;
  const v = ownerView();
  return v === 'infra' ? 'mine' : v;
}
function filesUrl(route, params, agent = filesState.agent) {
  const q = new URLSearchParams();
  const owner = filesOwner();
  if (owner) q.set('owner', owner);
  if (agent) q.set('agent', agent);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') q.set(k, v);
  return `/api/files${route}?${q.toString()}`;
}
async function filesApi(url, opts = {}) {
  let r;
  try { r = await api(url, opts); } catch { throw new Error('Could not reach the hub'); }
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
function filesJson(url, body) {
  return filesApi(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(filesOwner() ? { owner: filesOwner() } : {}), ...(filesState.agent ? { agent: filesState.agent } : {}), ...body }) });
}
function humanSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}
function filesJoin(dir, name) { return dir ? `${dir}/${name}` : name; }
function filesAbs(rel) { const root = filesState.root ? filesState.root.absPath : ''; return rel ? `${root}/${rel}` : root; }
function filesMsg(text, kind) {
  const el = $('fs-msg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'fs-msg' + (kind ? ' ' + kind : '');
}
// One request per file, raw bytes in the body. Resolves { entry, path, absPath }.
function uploadFileToHub(file, dir, overwrite, agent = filesState.agent) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', filesUrl('/upload', { path: dir, name: file.name, overwrite: overwrite ? '1' : '' }, agent));
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.onerror = () => reject(new Error('Upload failed: could not reach the hub'));
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch {}
      if (xhr.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); return reject(new Error('Signed out')); }
      if (xhr.status >= 200 && xhr.status < 300 && data.ok !== false) return resolve(data);
      const err = new Error(data.error || (xhr.status === 413 ? 'That file is too large' : xhr.status === 409 ? 'A file with that name already exists' : `HTTP ${xhr.status}`));
      err.status = xhr.status;
      reject(err);
    };
    xhr.send(file);
  });
}
function insertFileTag(absPath, isDir) {
  const input = $('msg-input');
  const tag = isDir ? `[folder: ${absPath}]` : `[file: ${absPath}]`;
  input.value = (input.value && !/\s$/.test(input.value) ? input.value + ' ' : input.value) + tag + ' ';
  input.dispatchEvent(new Event('input'));
}
// Paperclip: a non-image file goes to the files root and its server path lands in the composer.
async function uploadFileForChat(file) {
  toast(`Uploading ${file.name}…`);
  const agent = current || ''; // this chat's agent folder
  try {
    let out;
    try { out = await uploadFileToHub(file, '', false, agent); }
    catch (e) {
      if (e.status !== 409 || !confirm(`"${file.name}" is already in your files. Replace it?`)) throw e;
      out = await uploadFileToHub(file, '', true, agent);
    }
    insertFileTag(out.absPath || filesAbs(out.path || file.name), false);
    toast(`Uploaded ${file.name}: its path is in your message`);
  } catch (e) {
    if (e.message === 'Signed out') return;
    toast(`Could not upload ${file.name}: ${e.message}`);
  }
}
function openFilesSheet(path) {
  $('menu').classList.remove('open');
  if (typeof path === 'string') filesState.path = path;
  filesState.openRow = -1;
  const sheet = $('files-sheet');
  if (!sheet.dataset.ready) {
    sheet.innerHTML = `
      <h3 id="fs-title">Files</h3>
      <div class="fs-root" id="fs-root"></div>
      <div class="fs-crumbs" id="fs-crumbs"></div>
      <div class="fs-tools">
        <button class="go" id="fs-upload">&#x2B06; Upload</button>
        <button id="fs-mkdir">New folder</button>
        <button id="fs-refresh">&#x21BB;</button>
      </div>
      <div class="fs-msg" id="fs-msg"></div>
      <div class="fs-list" id="fs-list"><div class="fs-empty">Loading…</div></div>
      <div class="fs-close"><button id="fs-close">Close</button></div>`;
    $('fs-upload').addEventListener('click', () => $('files-upload-input').click());
    $('fs-mkdir').addEventListener('click', filesMkdir);
    $('fs-refresh').addEventListener('click', () => filesRefresh());
    $('fs-close').addEventListener('click', () => sheet.close());
    $('fs-list').addEventListener('click', onFilesListClick);
    $('fs-crumbs').addEventListener('click', (e) => { const b = e.target.closest('button[data-path]'); if (b) openFilesSheet(b.dataset.path); });
    sheet.dataset.ready = '1';
  }
  if (!sheet.open) sheet.showModal();
  filesRefresh();
}
// ── Recall sheet: search the open agent's transcript archive (server: /api/recall, /api/recall/context) ──
// Hits come newest-first with [brackets] around matched words; they become <mark> after escaping.
const recallState = { agent: '', q: '', hits: [], stats: null };
const RECALL_KINDS = [['user', 'user'], ['assistant', 'assistant'], ['tool_result', 'tool results'], ['tool_use', 'tool calls']];
function recallFmtTime(ts) { const d = new Date(ts); return isNaN(d) ? String(ts || '') : d.toLocaleString(); }
function recallFmtDate(ts) { const d = new Date(ts); return isNaN(d) ? String(ts || '') : d.toLocaleDateString(); }
function recallKindLabel(kind, tool) {
  const k = { user: 'user', assistant: 'assistant', tool_use: 'tool call', tool_result: 'tool result' }[kind] || String(kind || '');
  return tool ? `${k} · ${tool}` : k;
}
function recallSnippetHtml(snippet) { return esc(snippet || '').replace(/\[([^\[\]\n]+)\]/g, '<mark>$1</mark>'); }
function recallMsg(text, kind) { const el = $('rc-msg'); if (el) { el.textContent = text || ''; el.className = 'rc-msg' + (kind ? ' ' + kind : ''); } }
async function recallApi(path) {
  let r; try { r = await api(path); } catch { throw new Error('Could not reach the hub.'); }
  let data = {}; try { data = await r.json(); } catch { /* no body */ }
  if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
function openRecallSheet() {
  $('menu').classList.remove('open');
  if (!current) { toast('Open an agent\'s chat first'); return; }
  const sheet = $('recall-sheet');
  if (!sheet.dataset.ready) {
    sheet.innerHTML = `
      <h3 id="rc-title">Recall</h3>
      <div class="rc-hint">Search everything this agent has said, heard and done.</div>
      <div class="rc-tools">
        <input type="search" id="rc-q" placeholder="Search words…" autocomplete="off" enterkeyhint="search">
        <button class="go" id="rc-go">&#x1F50E;</button>
      </div>
      <div class="rc-kinds" id="rc-kinds">${RECALL_KINDS.map(([v, label]) => `<label><input type="checkbox" class="rc-kind" value="${v}" checked> ${label}</label>`).join('')}</div>
      <div class="rc-archive" id="rc-archive"></div>
      <div class="rc-msg" id="rc-msg"></div>
      <div class="rc-list" id="rc-list"><div class="rc-empty">Type a few words and search.</div></div>
      <div class="rc-close"><button id="rc-close">Close</button></div>`;
    $('rc-go').addEventListener('click', recallSearch);
    $('rc-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); recallSearch(); } });
    $('rc-close').addEventListener('click', () => sheet.close());
    $('rc-list').addEventListener('click', onRecallListClick);
    sheet.dataset.ready = '1';
  }
  if (current !== recallState.agent) { recallState.agent = current; recallState.q = ''; recallState.hits = []; recallState.stats = null; $('rc-q').value = ''; recallRender(); recallLoadStats(); }
  const a = agentByName(current);
  $('rc-title').textContent = `Recall · ${a?.display || current}`;
  if (!sheet.open) sheet.showModal();
  $('rc-q').focus();
}
async function recallLoadStats() {
  try {
    const data = await recallApi(`/api/recall?agent=${encodeURIComponent(recallState.agent)}&q=&limit=1`);
    recallState.stats = data.stats || null; recallRenderArchive();
  } catch { /* the archive line just stays empty */ }
}
function recallRenderArchive() {
  const el = $('rc-archive'); if (!el) return;
  const s = recallState.stats;
  if (!s || !s.entries) { el.textContent = s ? 'Archive: no entries yet.' : ''; return; }
  el.textContent = `Archive: ${s.entries} entries from ${recallFmtDate(s.first)} to ${recallFmtDate(s.last)}`;
}
async function recallSearch() {
  const q = ($('rc-q').value || '').trim();
  const kinds = Array.from(document.querySelectorAll('#rc-kinds .rc-kind:checked')).map(b => b.value);
  recallState.q = q;
  if (!q) { recallMsg('Type one or more words to search.'); return; }
  if (!kinds.length) { recallMsg('Tick at least one kind of entry.'); return; }
  const params = new URLSearchParams({ agent: recallState.agent, q, kinds: kinds.join(','), limit: '30' });
  recallMsg('Searching…');
  let data;
  try { data = await recallApi(`/api/recall?${params.toString()}`); }
  catch (e) { recallMsg(`Search failed: ${e.message}`, 'err'); return; }
  recallState.hits = Array.isArray(data.hits) ? data.hits : [];
  recallState.stats = data.stats || recallState.stats;
  recallMsg(recallState.hits.length ? `${recallState.hits.length} hit${recallState.hits.length === 1 ? '' : 's'}, newest first. Tap one for context.` : '');
  recallRender();
}
function recallRender() {
  recallRenderArchive();
  const list = $('rc-list'); if (!list) return;
  const hits = recallState.hits;
  if (!hits.length) {
    list.innerHTML = `<div class="rc-empty">${recallState.q ? `No entries match "${esc(recallState.q)}".` : 'Type a few words and search.'}</div>`;
    return;
  }
  list.innerHTML = hits.map((h, i) => `<div class="rc-hit" data-i="${i}">
    <button class="rc-head" data-i="${i}">
      <div class="rc-meta"><span>${esc(recallFmtTime(h.ts))}</span><span class="rc-kind">${esc(recallKindLabel(h.kind, h.tool))}</span></div>
      <div class="rc-snippet">${recallSnippetHtml(h.snippet || h.text || '')}</div>
    </button>
    <div class="rc-ctx" id="rc-ctx-${i}" hidden></div>
  </div>`).join('');
}
// Tap a hit: the rows around it unfold under it (oldest first, the hit highlighted); tap again to fold.
function onRecallListClick(e) {
  const head = e.target.closest('button.rc-head');
  if (head) recallToggleContext(Number(head.dataset.i));
}
async function recallToggleContext(i) {
  const h = recallState.hits[i]; const box = $(`rc-ctx-${i}`);
  if (!h || !box) return;
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false; box.innerHTML = '<div class="rc-empty">Loading context…</div>';
  let data;
  try { data = await recallApi(`/api/recall/context?agent=${encodeURIComponent(recallState.agent)}&id=${encodeURIComponent(h.id)}&before=6&after=6`); }
  catch (err) { box.innerHTML = `<div class="rc-msg err">Could not load context: ${esc(err.message)}</div>`; return; }
  const rows = Array.isArray(data.rows) ? data.rows : [];
  box.innerHTML = rows.length ? rows.map(r => `<div class="rc-row${r.hit ? ' hit' : ''}">
    <div class="rc-meta"><span>${esc(recallFmtTime(r.ts))}</span><span class="rc-kind">${esc(recallKindLabel(r.kind, r.tool))}</span></div>
    <div class="rc-text">${esc(r.text || '')}</div>
  </div>`).join('') : '<div class="rc-empty">No surrounding entries.</div>';
}

// Also called when another agent's chat is opened: a different agent means a different root, so start at its top.
async function filesRefresh() {
  const list = $('fs-list');
  if (!list) return;
  const agent = current || '';
  if (agent !== filesState.agent) { filesState.agent = agent; filesState.path = ''; filesState.openRow = -1; }
  filesMsg('');
  let data;
  try { data = await filesApi(filesUrl('', { path: filesState.path })); }
  catch (e) {
    if (filesState.path && /not found|no such|404/i.test(e.message)) { filesState.path = ''; return filesRefresh(); }
    list.innerHTML = `<div class="fs-empty">${esc(e.message)}</div>`;
    return;
  }
  filesState.root = data.root || null;
  filesState.path = data.path || '';
  filesState.maxUploadBytes = data.maxUploadBytes || 0;
  filesState.entries = (data.entries || []).slice().sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  const root = filesState.root || {};
  $('fs-title').textContent = `${root.label || 'Files'}${filesState.agent ? '' : ' (no chat open)'}`;
  $('fs-root').innerHTML = `${filesState.agent ? 'Only this agent sees these files.' : 'General folder: open an agent\'s chat to see its files.'}<br><code>${esc(root.absPath || '')}</code>${filesState.maxUploadBytes ? ` · up to ${humanSize(filesState.maxUploadBytes)} per file` : ''}`;
  const parts = filesState.path ? filesState.path.split('/') : [];
  let acc = '';
  $('fs-crumbs').innerHTML = `<button data-path="">Top</button>` + parts.map((p, i) => {
    acc = filesJoin(acc, p);
    return `<span class="sep">/</span>` + (i === parts.length - 1 ? `<span>${esc(p)}</span>` : `<button data-path="${esc(acc)}">${esc(p)}</button>`);
  }).join('');
  filesRenderList();
}
function filesRenderList() {
  const list = $('fs-list');
  const entries = filesState.entries;
  if (!entries.length) { list.innerHTML = `<div class="fs-empty">${filesState.path ? 'This folder is empty.' : 'No files yet.'} Use Upload to add some.</div>`; return; }
  const when = (t) => { if (!t) return ''; const d = new Date(t); return isNaN(d) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
  list.innerHTML = entries.map((e, i) => {
    const isDir = e.type === 'dir';
    const row = `<div class="fs-row" data-i="${i}">
      <button class="fs-name" data-act="${isDir ? 'open' : 'more'}"><span>${isDir ? '&#x1F4C1;' : '&#x1F4C4;'} ${esc(e.name)}</span><small>${isDir ? 'Folder' : humanSize(e.size)}${e.mtime ? ` · ${when(e.mtime)}` : ''}</small></button>
      <button class="fs-more" data-act="more" aria-label="Actions">&#x22EF;</button>
    </div>`;
    if (filesState.openRow !== i) return row;
    return row + `<div class="fs-acts" data-i="${i}">
      ${isDir ? '' : `<button data-act="download">Download</button>`}
      <button data-act="use">Use in chat</button>
      <button data-act="rename">Rename</button>
      <button data-act="delete" class="danger">Delete</button>
    </div>`;
  }).join('');
}
async function onFilesListClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const holder = btn.closest('[data-i]');
  const i = Number(holder.dataset.i);
  const entry = filesState.entries[i];
  if (!entry) return;
  const rel = filesJoin(filesState.path, entry.name);
  const act = btn.dataset.act;
  if (act === 'open') return openFilesSheet(rel);
  if (act === 'more') { filesState.openRow = filesState.openRow === i ? -1 : i; return filesRenderList(); }
  if (act === 'download') { window.open(filesUrl('/download', { path: rel }), '_blank'); return; }
  if (act === 'use') {
    insertFileTag(filesAbs(rel), entry.type === 'dir');
    $('files-sheet').close();
    if (!$('screen-chat').classList.contains('active')) toast('Path added to the message box in Chat');
    return;
  }
  if (act === 'rename') {
    const name = prompt(`New name for "${entry.name}":`, entry.name);
    if (name === null) return;
    const n = name.trim();
    if (!n || n === entry.name) return;
    try { await filesJson('/api/files/rename', { path: rel, newName: n }); filesMsg(`Renamed to "${n}"`, 'ok'); await filesRefresh(); }
    catch (err) { filesMsg(err.message, 'err'); }
    return;
  }
  if (act === 'delete') {
    const q = entry.type === 'dir' ? `Delete the folder "${entry.name}" and everything inside it? This cannot be undone.` : `Delete "${entry.name}"? This cannot be undone.`;
    if (!confirm(q)) return;
    try { await filesApi(filesUrl('', { path: rel }), { method: 'DELETE' }); filesMsg(`Deleted "${entry.name}"`, 'ok'); await filesRefresh(); }
    catch (err) { filesMsg(err.message, 'err'); }
  }
}
async function filesMkdir() {
  const name = prompt('Name of the new folder:');
  if (name === null) return;
  const n = name.trim();
  if (!n) return;
  try { await filesJson('/api/files/mkdir', { path: filesState.path, name: n }); filesMsg(`Folder "${n}" created`, 'ok'); await filesRefresh(); }
  catch (err) { filesMsg(err.message, 'err'); }
}
async function filesUpload(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const existing = new Set(filesState.entries.filter(e => e.type === 'file').map(e => e.name));
  let done = 0; const failed = [];
  for (let k = 0; k < files.length; k++) {
    const file = files[k];
    if (filesState.maxUploadBytes && file.size > filesState.maxUploadBytes) { failed.push(`${file.name}: too large (limit ${humanSize(filesState.maxUploadBytes)})`); continue; }
    let overwrite = false;
    if (existing.has(file.name)) { if (!confirm(`"${file.name}" already exists here. Replace it?`)) continue; overwrite = true; }
    filesMsg(`Uploading ${file.name} (${k + 1} of ${files.length})…`);
    try {
      try { await uploadFileToHub(file, filesState.path, overwrite); }
      catch (e) {
        if (e.status !== 409 || overwrite || !confirm(`"${file.name}" already exists here. Replace it?`)) throw e;
        await uploadFileToHub(file, filesState.path, true);
      }
      done++;
    } catch (e) {
      if (e.message === 'Signed out') return;
      failed.push(`${file.name}: ${e.message}`);
    }
  }
  await filesRefresh();
  if (failed.length) filesMsg((done ? `Uploaded ${done}. ` : '') + failed.join('\n'), 'err');
  else filesMsg(done === 1 ? `Uploaded ${files[0].name}` : `Uploaded ${done} files`, 'ok');
}

function paintTwoFactor() {
  const box = $('sec-2fa');
  if (!box || !hubMe) return;
  if (hubMe.user.totpEnabled) {
    box.innerHTML = `
      <div class="sec-title">Two-factor authentication: on</div>
      <input type="password" id="sec-2fa-password" placeholder="Password (to turn it off)" autocomplete="current-password">
      <div class="sec-actions"><button id="sec-2fa-disable" class="danger">Disable 2FA</button></div>
      <div class="sec-msg" id="sec-2fa-msg"></div>`;
    $('sec-2fa-disable').addEventListener('click', disableTwoFactor);
  } else {
    box.innerHTML = `
      <div class="sec-title">Two-factor authentication: off</div>
      <div class="sec-hint">${hubMe.isAdmin ? 'Required for admins.' : 'Adds a 6-digit code from an authenticator app at sign-in.'}</div>
      <div class="sec-actions"><button id="sec-2fa-begin" class="go">Set up 2FA</button></div>
      <div class="sec-msg" id="sec-2fa-msg"></div>`;
    $('sec-2fa-begin').addEventListener('click', beginTwoFactor);
  }
}

async function beginTwoFactor() {
  try {
    const d = await authPost('/api/auth/totp/begin');
    await loadQrScript();
    $('sec-2fa').innerHTML = `
      <div class="sec-title">Scan with your authenticator app</div>
      <div class="sec-qr">${window.qrcode.svg(d.uri, { size: 180, margin: 2, dark: '#000', light: '#fff' })}</div>
      <div class="sec-hint">Or enter this key by hand:</div>
      <code class="sec-secret">${esc(d.secret)}</code>
      <input type="text" id="sec-2fa-code" inputmode="numeric" maxlength="6" placeholder="6-digit code" autocomplete="one-time-code">
      <div class="sec-actions"><button id="sec-2fa-cancel">Cancel</button><button id="sec-2fa-confirm" class="go">Confirm</button></div>
      <div class="sec-msg" id="sec-2fa-msg"></div>`;
    $('sec-2fa-cancel').addEventListener('click', paintTwoFactor);
    $('sec-2fa-confirm').addEventListener('click', confirmTwoFactor);
  } catch (e) { secMsg('sec-2fa-msg', e.message); }
}

async function confirmTwoFactor() {
  const code = ($('sec-2fa-code').value || '').trim();
  try {
    const d = await authPost('/api/auth/totp/confirm', { code });
    hubMe.user.totpEnabled = true;
    applyMultiUserNote();
    $('sec-2fa').innerHTML = `
      <div class="sec-title">Two-factor is on. Save your recovery codes</div>
      <div class="sec-hint">Each code works once if you lose your phone. They are shown only now.</div>
      <pre class="sec-codes" id="sec-recovery">${esc((d.recoveryCodes || []).join('\n'))}</pre>
      <div class="sec-actions"><button id="sec-copy">Copy</button><button id="sec-2fa-done" class="go">Done</button></div>`;
    $('sec-copy').addEventListener('click', copyRecoveryCodes);
    $('sec-2fa-done').addEventListener('click', paintTwoFactor);
  } catch (e) { secMsg('sec-2fa-msg', e.message); }
}

function applyMultiUserNote() {
  if (hubMe) $('menu-2fa-note').hidden = !(hubMe.isAdmin && !hubMe.user.totpEnabled);
}

async function copyRecoveryCodes() {
  const text = $('sec-recovery').textContent;
  try { await navigator.clipboard.writeText(text); toast('Recovery codes copied'); }
  catch { toast('Copy failed: select the codes and copy by hand'); }
}

async function disableTwoFactor() {
  const password = $('sec-2fa-password').value;
  if (!password) return secMsg('sec-2fa-msg', 'Enter your password to turn 2FA off.');
  try {
    await authPost('/api/auth/totp/disable', { password });
    hubMe.user.totpEnabled = false;
    applyMultiUserNote();
    paintTwoFactor();
  } catch (e) { secMsg('sec-2fa-msg', e.message); }
}

async function changePassword() {
  const current = $('sec-pw-current').value;
  const next = $('sec-pw-new').value;
  if (next.length < 12) return secMsg('sec-pw-msg', 'The new password needs at least 12 characters.');
  if (next !== $('sec-pw-new2').value) return secMsg('sec-pw-msg', 'The two new passwords do not match.');
  try {
    await authPost('/api/auth/password', { current, next });
    for (const id of ['sec-pw-current', 'sec-pw-new', 'sec-pw-new2']) $(id).value = '';
    dialogGuard.markLoaded(['sec-pw-current', 'sec-pw-new', 'sec-pw-new2'].map($));   // done: nothing left to lose
    secMsg('sec-pw-msg', 'Password changed.', true);
  } catch (e) { secMsg('sec-pw-msg', e.message); }
}

async function signOutEverywhere() {
  try { await authPost('/api/auth/sessions/revoke'); } catch {}
  location.href = '/login';
}

async function init() {
  wire();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/mobile', updateViaCache: 'none' }).catch(() => {});
  // A new build's service worker takes control (skipWaiting + clients.claim) while this page
  // still runs the old JavaScript; the installed app would keep the stale code until someone
  // reloaded it by hand. Reload once as soon as no reply is streaming on this device and no open sheet holds unsaved
  // changes.
  if ('serviceWorker' in navigator) {
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading || !navigator.serviceWorker.controller) return;
      reloading = true;
      const since = Date.now();
      const busy = () => streams.size || reattaches.size || (typingNow() && Date.now() - since < 600000) || dialogGuard.hasChanges();
      const go = () => { if (busy()) { setTimeout(go, 2000); return; } toast('Updating to the new version…'); setTimeout(() => { if (busy()) go(); else location.reload(); }, 800); };   // checked again just before
      go();
    });
  }
  await loadMe();
  applyMultiUser();
  refreshPlanUsage();
  if (new URLSearchParams(location.search).get('security') === '1') openSecuritySheet();
  await loadAgents();
  const route = routeFromHash();
  window.history.replaceState({ screen: route.screen, agent: route.agent }, '');
  applyRoute(route);
  updateDots();
  connectEvents();
  paintPush();
  // Update available: look now and every 30 minutes; a tap on the update notification arrives as ?update=1, which
  // opens the choice once and is then dropped from the address (so the next notification opens it again).
  const fromUpdatePush = new URLSearchParams(location.search).get('update') === '1';
  if (fromUpdatePush) { const u = new URL(location.href); u.searchParams.delete('update'); window.history.replaceState(window.history.state, '', u.pathname + u.search + u.hash); }
  refreshUpdateCheck().then(() => { if (fromUpdatePush) openUpdatePrompt(); });
  paintVersionLabel();
  setInterval(refreshUpdateCheck, 30 * 60 * 1000);
}

init();
