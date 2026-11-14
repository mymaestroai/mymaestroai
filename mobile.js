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
const forOwnerPending = {};    // turnId -> { reason, at }: a for_owner that came before its live card existed
let lastHistoryCard = null;    // { wrap, body, line, label, prompt, agent }: the last card renderHistory drew
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
// ── app reload (begin) ──
const APP_RELOAD_STASH_KEY = 'hub-reload-stash';
const APP_RELOAD_CALL_QUESTION = 'Reloading ends the call. Reload?';
const APP_RELOAD_GROUP_QUESTION = 'Text typed in a group chat will be lost. Reload?';
const APP_RELOAD_OFFLINE_QUESTION = 'This device seems to be offline, so the page may not come back until it is online again. Reload anyway?';
function appIsInstalled(win) {
  try {
    if (win && win.navigator && win.navigator.standalone === true) return true;
    if (!win || typeof win.matchMedia !== 'function') return false;
    return ['standalone', 'minimal-ui', 'window-controls-overlay'].some(m => !!win.matchMedia(`(display-mode: ${m})`).matches);
  } catch { return false; }
}
function appReloadUrls(doc, origin) {
  const out = [], seen = new Set();
  const add = (u) => {
    if (!u) return;
    let url;
    try { url = new URL(u, origin + '/'); } catch { return; }
    if (url.origin !== origin || url.pathname.startsWith('/vendor/')) return;
    url.hash = '';
    const s = url.href;
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  };
  try { add(doc.location && doc.location.href); } catch { /* no address */ }
  const list = (sel) => { try { return Array.from(doc.querySelectorAll(sel) || []); } catch { return []; } };
  for (const s of list('script[src]')) add(s.getAttribute('src'));
  for (const l of list('link[rel="stylesheet"][href]')) add(l.getAttribute('href'));
  return out;
}
function appFreshFetch({ urls = [], fetch: f, swUpdate, timeoutMs = 4000, setTimer = setTimeout } = {}) {
  const jobs = [];
  const body = (r) => (r && r.ok && typeof r.arrayBuffer === 'function' ? r.arrayBuffer() : null);
  for (const u of urls) { try { jobs.push(Promise.resolve(f(u, { cache: 'reload', credentials: 'same-origin' })).then(body).catch(() => null)); } catch { /* skipped */ } }
  if (typeof swUpdate === 'function') { try { jobs.push(Promise.resolve(swUpdate()).catch(() => null)); } catch { /* skipped */ } }
  const all = Promise.all(jobs).then(() => 'done');
  const late = new Promise(r => setTimer(() => r('timeout'), timeoutMs));
  return Promise.race([all, late]);
}
function appNavigationWasReload(perf) {
  try {
    const nav = perf && typeof perf.getEntriesByType === 'function' ? perf.getEntriesByType('navigation') : null;
    if (nav && nav[0] && typeof nav[0].type === 'string') return nav[0].type === 'reload';
  } catch { /* try the older API */ }
  try {
    if (perf && perf.navigation && typeof perf.navigation.type === 'number') return perf.navigation.type === 1;
  } catch { /* cannot tell */ }
  return false;
}
function appReloadStashClear(storage) {
  try { storage.removeItem(APP_RELOAD_STASH_KEY); } catch { /* nothing to clear */ }
}
function appReloadStashSave(storage, chats, now) {
  const list = (Array.isArray(chats) ? chats : []).filter(c => c && c.agent).map(c => ({ agent: String(c.agent), text: String(c.text || ''), front: !!c.front }));
  if (!list.length) { appReloadStashClear(storage); return true; }
  try { storage.setItem(APP_RELOAD_STASH_KEY, JSON.stringify({ chats: list, at: now })); return true; } catch { return false; }
}
function appReloadStashTake(storage, now, maxAgeMs = 60000) {
  let raw = null;
  try { raw = storage.getItem(APP_RELOAD_STASH_KEY); storage.removeItem(APP_RELOAD_STASH_KEY); } catch { return null; }
  if (!raw) return null;
  let e;
  try { e = JSON.parse(raw); } catch { return null; }
  if (!e || !Array.isArray(e.chats) || typeof e.at !== 'number' || !(now - e.at >= 0 && now - e.at <= maxAgeMs)) return null;
  const list = e.chats.filter(c => c && typeof c.agent === 'string' && c.agent).map(c => ({ agent: c.agent, text: typeof c.text === 'string' ? c.text : '', front: c.front === true }));
  return list.length ? list : null;
}
function createAppReloader({ questions = () => [], confirm: ask = () => true, prepare = () => null, go, onBusy = () => {}, setTimer = setTimeout, busyMs = 8000 } = {}) {
  let busy = false, attempt = 0;
  const qsNow = () => { try { return questions() || []; } catch { return []; } };
  const yes = (q) => { try { return !!ask(q); } catch { return false; } };   // a dialog that cannot open counts as Cancel
  const end = (my) => { if (my !== attempt || !busy) return; busy = false; try { onBusy(false); } catch { /* paint only */ } };
  function reload() {
    if (busy) return false;
    const asked = new Set();
    for (const q of qsNow()) { if (!yes(q)) return false; asked.add(q); }
    busy = true;
    const my = ++attempt;
    try { onBusy(true); } catch { /* paint only */ }
    Promise.resolve().then(prepare).catch(() => null).then(() => {
      for (const q of qsNow()) if (!asked.has(q) && !yes(q)) { end(my); return; }
      try { go(); } catch { /* the page stays */ }
      setTimer(() => end(my), busyMs);
    });
    return true;
  }
  return { reload, busy: () => busy };
}
// ── app reload (end) ──
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
// ── plan state helpers (begin) ──
function planState(w, levels) {
  const pct = Math.round(Number(w.utilization) || 0);
  const extra = !!w.extraUsage && !w.rejected;
  const passed = (levels || []).filter(l => pct >= l);
  const cls = w.rejected || (pct >= 100 && !extra) ? 'refused' : extra ? 'warn' : passed.length && passed.length === (levels || []).length ? 'hot' : passed.length ? 'warn' : '';
  return { pct, extra, cls };
}
function planPctText(w, levels) {
  const s = planState(w, levels);
  return s.extra ? `${s.pct}% · extra usage` : `${s.pct}%`;
}
// ── plan state helpers (end) ──
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
  const levels = (d.warn && Array.isArray(d.warn.at)) ? d.warn.at : [];
  const { pct, extra, cls } = planState(w, levels);
  el.textContent = `${w.family ? w.label : 'Plan'} ${planPctText(w, levels)}`;
  el.className = 'sub' + (cls ? ' ' + cls : '');
  el.title = extra
    ? `${w.family ? w.label : 'All models'}: the weekly Claude plan is used up until ${Number.isFinite(Date.parse(w.resetsAt || '')) ? new Date(w.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'the reset'}; extra usage is paying`
    : `${w.family ? w.label : 'All models'}: ${pct}% of this week's Claude plan allowance`;
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
    if (typeof voiceWakeRecheck === 'function') voiceWakeRecheck();   // an agent's recognizer can have changed
    if (agents.some(a => 'busy' in a)) {
      const map = {};
      for (const a of agents) map[a.name] = { busy: a.busy, busySince: a.busySince, activity: a.activity, pendingQuestion: a.pendingQuestion };
      applySnapshot(map, false, { namedOnly: true });
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
  if (!next.busy) { next.busySince = null; next.activity = null; next.pendingQuestion = false; next.consultedBy = null; }
  else if (!next.busySince) next.busySince = cur.busySince || new Date().toISOString();
  live[name] = next;
}

// opts.namedOnly: the map lists named agents only (/api/agents): workers missing from it stay, and the worker/consult keys it lacks are not touched.
function applySnapshot(map, repaint = true, opts = {}) {
  if (!map || typeof map !== 'object') return;
  statusKnown = true;
  const namedOnly = !!(opts && opts.namedOnly);
  for (const [name, s] of Object.entries(map)) {
    const patch = { busy: !!s.busy, busySince: s.busySince || null, activity: s.activity || null, pendingQuestion: !!s.pendingQuestion };
    for (const k of ['worker', 'parent', 'label', 'model', 'consultedBy']) {
      if (namedOnly && !(k in s)) continue;
      patch[k] = k === 'worker' ? busyIsWorker(name, s) : (s[k] || null);
    }
    setLive(name, patch);
  }
  for (const name of Object.keys(live)) {
    if (name in map) continue;
    if (busyIsWorker(name, live[name])) { if (!namedOnly) delete live[name]; }   // a worker that is gone, not an agent gone idle
    else setLive(name, { busy: false });
  }
  if (repaint) paintStatus();
  // Woke up (or just loaded) while the open chat's agent is mid-turn: follow that turn.
  if (current && map[current] && map[current].busy && !followedHubTurn(current)) reattachIfIdle(current);
  // A full feed that no longer lists a running temporary worker: its end never reached this page.
  if (!namedOnly) {
    const running = [...wkSeen.values()].filter(e => e.it && e.it.status === 'running' && !e.it.inferred).map(e => ({ id: e.id, startedAt: e.it.t0 }));
    const step = workerGoneStep(wkGoneState, { running, statusMap: map, now: Date.now() });
    wkGoneState = step.next;
    for (const id of step.gone) wkInferEnd(wkSeen.get(id), 0, 'gone');
  }
}
let wkGoneState = {};

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

// One row of the agent list. opts.done: a row of the Active section whose agent just finished (shows "✓ done", idle dot).
// opts.active: a row of the Active section; when only the agent's temporary workers run it still reads as working.
function agentRowHtml(a, opts) {
  const done = !!(opts && opts.done);
  const jobOnly = !!(opts && opts.jobOnly) && !done;   // working only through a background job: hollow dot, the job line instead of the status
  const viaWorkers = !!(opts && opts.active) && !done && !jobOnly && !isBusy(a.name);
  const n = unread[a.name] || 0;
  const s = live[a.name];
  const question = !done && !jobOnly && !!(s && s.pendingQuestion);
  const working = !done && !jobOnly && (isBusy(a.name) || viaWorkers);
  const dotCls = question ? ' question' : working ? ' busy' : jobOnly ? ' joby' : statusKnown ? ' idle' : '';
  const job = !done && opts && opts.job ? opts.job : null;
  // the name may be cut short (ellipsis); the tail (' + N more · 4 min') never shrinks, so the time always shows
  const jobHtml = job ? `<div class="agent-job" title="${esc(activeJobTitle(job))}"><span class="ajl-name">⏳ ${esc(job.names[0])}</span><span class="ajl-tail">${esc(activeJobTail(job, Date.now()))}</span></div>` : '';
  const sub = (done
    ? '<div class="agent-model working">✓ done</div>'
    : jobOnly
      ? ''
      : viaWorkers
        ? '<div class="agent-model working">⏳ working</div>'
        : working
          ? `<div class="agent-model working${question ? ' question' : ''}">${esc(busyText(a.name))}</div>`
          : `<div class="agent-model" title="${esc(a.blurb || '')}">${esc(a.blurb || shortModel(a.model))}</div>`) + jobHtml;
  return `<button class="agent-row${working ? ' is-busy' : ''}${jobOnly ? ' active-joby' : ''}${done ? ' active-done' : ''}" data-agent="${esc(a.name)}">` +
    `<span class="agent-icon">${esc(a.icon || '🤖')}</span>` +
    `<span class="agent-meta"><div class="agent-name">${esc(a.display || a.name)}${a.lead ? ' <span class="lead-badge" title="Lead agent">👑</span>' : ''}</div>${sub}</span>` +
    `<span class="dot${dotCls}" title="${esc(working && !viaWorkers ? busyText(a.name) : '')}">${question ? '?' : ''}</span>` +
    (n ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : '') +
    '</button>';
}

// The Active section at the top of the agent list: state, the setting, the hold while a finger is on the list.
let activeState = activeInitial();
let activeHeld = false;
let activeHoldTimer = null;
let activeTicker = null;
let activeLastH = 0;
let activeLastCount = 0;
let activeMissed = false;   // a redraw skipped while a finger was on the list; done after release
let activeHoldWired = false;
function activeTopOn() {
  try { return localStorage.getItem('hub-active-top') !== 'off'; } catch { return true; }
}
function paintActiveMenu() {
  const b = $('menu-active-top');
  if (b) b.textContent = `⬆ Active agents at the top: ${activeTopOn() ? 'On' : 'Off'}`;
}
function toggleActiveTop() {
  $('menu').classList.remove('open');
  try { localStorage.setItem('hub-active-top', activeTopOn() ? 'off' : 'on'); } catch { /* storage refused */ }
  paintActiveMenu();
  activeJobsSync();
  if (screen === 'agents') renderAgents();
}
function activeBusyNow() {
  return activeBusyFrom(live, new Map([...streams.keys()].map(n => [n, null])), agents.map(a => a.name));
}
// The finger left the list (or rested 2 s): let held changes through, but only redraw when the section's rows would
// actually change, and only after the tap's click has been delivered (a redraw inside touchend can swallow the click).
function activeRelease() {
  clearTimeout(activeHoldTimer);
  activeHoldTimer = null;
  if (!activeHeld) return;
  activeHeld = false;
  const next = activeStep(activeState, { busy: activeBusyNow(), jobs: activeJobsNow(), now: Date.now(), held: false, enabled: activeTopOn() });
  if (!activeMissed && !activeMembersChanged(activeState, next)) return;
  setTimeout(() => { if (!activeHeld && screen === 'agents') renderAgents(); }, 400);
}
function activeWireHold(list) {
  if (activeHoldWired || !list) return;
  activeHoldWired = true;
  const restart = () => { clearTimeout(activeHoldTimer); activeHoldTimer = setTimeout(activeRelease, 2000); };
  // With the switch off nothing is held and nothing is redrawn: the list behaves exactly as before.
  list.addEventListener('touchstart', () => { if (!activeTopOn()) return; activeHeld = true; restart(); }, { passive: true });
  list.addEventListener('touchmove', () => { if (activeHeld) restart(); }, { passive: true });
  list.addEventListener('touchend', activeRelease, { passive: true });
  list.addEventListener('touchcancel', activeRelease, { passive: true });
}

// Agents' detached background jobs in the Active section (GET /api/jobs, admins only). Polled every 15 s while the
// switch is on and the page is visible; 401/403 (not an admin) stops it for good; after other errors the last good
// list is kept for at most 60 s. A changed list redraws through renderAgents (so the hold rules apply).
const ACTIVE_JOBS_MS = 15000;
const ACTIVE_JOBS_STALE_MS = 60000;
let activeJobList = [];
let activeJobs = {};          // activeJobsFrom(activeJobList, agents) as last drawn
let activeJobsOkAt = 0;
let activeJobsSig = '';
let activeJobsStopped = false;
let activeJobsTimer = null;
let activeJobsSeq = 0;
const ACTIVE_JOBS_TIMEOUT_MS = 10000;
function activeJobsFresh() { return Date.now() - activeJobsOkAt <= ACTIVE_JOBS_STALE_MS; }
let activeJobsTick = null;
function activeJobsWanted() {
  return !activeJobsStopped && activeTopOn() && document.visibilityState === 'visible';
}
function activeJobsSync() {
  const want = activeJobsWanted();
  if (want && !activeJobsTimer) { activeJobsPoll(); activeJobsTimer = setInterval(activeJobsPoll, ACTIVE_JOBS_MS); }
  else if (!want && activeJobsTimer) { clearInterval(activeJobsTimer); activeJobsTimer = null; }
}
async function activeJobsPoll() {
  if (!activeJobsWanted()) return;
  const seq = ++activeJobsSeq;   // only the newest request may change the list (an older answer arriving late is dropped)
  let list = null, good = false, wasFresh = true;
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const to = ac ? setTimeout(() => ac.abort(), ACTIVE_JOBS_TIMEOUT_MS) : null;   // a stalled request ends; the list also expires by itself
  try {
    const res = await api('/api/jobs', ac ? { signal: ac.signal } : {});
    if (seq !== activeJobsSeq) return;
    if (res.status === 401 || res.status === 403) {
      activeJobsStopped = true;
      if (activeJobsTimer) { clearInterval(activeJobsTimer); activeJobsTimer = null; }
      list = [];
    } else if (!res.ok) throw new Error('HTTP ' + res.status);
    else { const d = await res.json(); if (seq !== activeJobsSeq) return; list = Array.isArray(d && d.jobs) ? d.jobs : []; wasFresh = activeJobsFresh(); activeJobsOkAt = Date.now(); good = true; }   // freshness as the answer arrives
  } catch {
    if (seq !== activeJobsSeq) return;
    if (!activeJobsFresh()) list = [];
  } finally {
    if (to) clearTimeout(to);
  }
  if (!list) return;
  const sig = JSON.stringify(list.map(j => [j && j.id, j && j.name, j && j.owner, j && j.status, j && j.startedAt]));
  if (sig === activeJobsSig && !(good && !wasFresh)) return;   // a good answer after the list expired is drawn even when it is the same
  activeJobsSig = sig;
  activeJobList = list;
  if (screen === 'agents') renderAgents();
}
function activeJobsNow() {
  return activeJobsFrom(activeJobsFresh() ? activeJobList : [], agents.map(a => a.name));   // a list older than 60 s is not shown
}
// The elapsed time changes between polls: relabel the drawn rows in place (no redraw).
function activeJobsRelabel() {
  const list = $('agents-list');
  if (screen !== 'agents' || !list || !Object.keys(activeJobs).length) { clearInterval(activeJobsTick); activeJobsTick = null; return; }
  for (const el of list.querySelectorAll('.active-sec .agent-row')) {
    const info = activeJobs[el.dataset.agent];
    const j = el.querySelector('.agent-job');
    if (info && j) {
      const nm = j.querySelector('.ajl-name'), tl = j.querySelector('.ajl-tail');
      if (nm) nm.textContent = '⏳ ' + info.names[0];
      if (tl) tl.textContent = activeJobTail(info, Date.now());
      j.title = activeJobTitle(info);
    }
  }
}
document.addEventListener('visibilitychange', activeJobsSync);

function renderAgents() {
  const list = $('agents-list');
  // While a finger is on the list (switch on), no redraw from any source (status events, the linger ticker): it would
  // replace the touched row before its click. The redraw happens after release (activeRelease).
  if (activeHeld && list && list.firstChild) { activeMissed = true; return; }
  activeMissed = false;
  renderWorkingChip();
  if (!agents.length) { list.innerHTML = '<div class="empty">No agents found.</div>'; return; }
  activeWireHold(list);
  activeJobs = activeJobsNow();
  activeState = activeStep(activeState, { busy: activeBusyNow(), jobs: activeJobs, now: Date.now(), held: activeHeld, enabled: activeTopOn() });
  let activeHtml = '';
  const activeRows = activeState.rows.map(row => ({ row, a: agents.find(x => x.name === row.name) })).filter(r => r.a);
  if (activeRows.length) {
    const activeCollapsed = !workingFilter && !!collapsed.active;
    activeHtml = `<div class="active-sec"><button class="group-title" data-group="active"><span>⚡ ${esc(activeTitle({ rows: activeRows }))}</span><span>${activeCollapsed ? '&#x25B8;' : '&#x25BE;'}</span></button>`;
    if (!activeCollapsed) for (const { row, a } of activeRows) activeHtml += agentRowHtml(a, { done: row.doneAt != null, active: true, jobOnly: !!row.jobOnly, job: activeJobs[a.name] });
    activeHtml += '</div>';
  }
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
      html += agentRowHtml(a);
    }
  }
  if (!html) html = '<div class="empty">No agent is working right now.</div>';
  list.innerHTML = activeHtml + html;
  const sec = list.querySelector('.active-sec');
  const h = sec ? sec.offsetHeight : 0;
  // animate only when rows joined or left (not on every status redraw, nor when coming back to this screen)
  if (sec && activeRows.length !== activeLastCount && h !== activeLastH && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    sec.animate([{ height: activeLastH + 'px', overflow: 'hidden' }, { height: h + 'px', overflow: 'hidden' }], { duration: 150, easing: 'ease-out' });
  }
  activeLastH = h;
  activeLastCount = activeRows.length;
  if (!activeJobsTick && activeRows.some(r => activeJobs[r.row.name])) activeJobsTick = setInterval(activeJobsRelabel, 30000);
  if (!activeTicker && activeState.rows.some(r => r.doneAt != null)) {
    activeTicker = setInterval(() => {
      // stops when nothing lingers or this screen is left (renderAgents steps the state again on the way back)
      if (screen !== 'agents' || !agents.length || !activeState.rows.some(r => r.doneAt != null)) { clearInterval(activeTicker); activeTicker = null; return; }
      renderAgents();
    }, 1000);
  }
}

function updateDots() {
  const total = Object.values(unread).reduce((s, n) => s + n, 0);
  const c = $('chat-unread');
  c.textContent = total > 99 ? '99+' : String(total);
  c.classList.toggle('on', total > 0);
  const a = $('act-unread');   // the count next to Activity in the ⋮ menu
  if (a) {
    a.textContent = actUnseen > 99 ? '99+' : String(actUnseen);
    a.classList.toggle('on', actUnseen > 0 && screen !== 'activity');
  }
  // Actions waiting for approval (any agent): amber count on the Agents tab.
  const ap = $('agents-approvals');
  if (ap) { ap.textContent = String(approvals.size); ap.classList.toggle('on', approvals.size > 0); }
}

// ── Navigation ───────────────────────────────────────────────────────────────

function show(name) {
  if (name !== 'chat' && typeof voiceCall !== 'undefined' && voiceCall) voiceCallHangUp();   // leaving the chat view ends a hands-free call
  screen = name;
  for (const s of ['agents', 'chat', 'activity']) {
    $(`screen-${s}`).classList.toggle('active', s === name);
    $(`tab-${s}`)?.classList.toggle('active', s === name);   // Activity has no tab: it opens from the ⋮ menu
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

// Where new notes and bubbles are appended: the chat, or the body of a folded automatic-turn card while one is painted.
let renderTarget = null;
function bubbleHost() { return renderTarget || chatEl(); }
function withRenderTarget(el, fn) {
  const prev = renderTarget;
  renderTarget = el;
  try { return fn(); } finally { renderTarget = prev; }
}

function scrollChat(force) {
  const s = $('chat-scroll');
  if (force || stick) s.scrollTop = s.scrollHeight;
}

function addNote(text) {
  const d = document.createElement('div');
  d.className = 'note';
  d.textContent = text;
  bubbleHost().appendChild(d);
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
  if (el.classList && el.classList.contains('assistant') && typeof addSpeakButton === 'function') addSpeakButton(el);   // read aloud, beside copy
}

function setRaw(el, text) {
  rawText.set(el, String(text ?? ''));
}

// Shared verbatim with lib/ui-keep-keyboard.js (test/ui-keep-keyboard.test.js keeps the two in step): bring the keyboard back when Chrome's spell-check hides it.
// ── keep-keyboard helpers (begin) ──
const KEEP_KBD_MS = 1000;       // how long after a tap on the box a keyboard that goes away is brought back
const KEEP_KBD_EDIT_MS = 400;   // ... and after a key or an edit in it (shorter, so Back pressed more than 400 ms after a key stays a close)
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

// Shared verbatim with lib/ui-auto-turns.js (test/ui-auto-turns-phone.test.js keeps the two in step): turns the hub starts by itself fold into closed cards.
// ── auto-turn helpers (begin) ──
const AUTO_STACK_MIN = 3;   // this many closed cards in a row fold into one stack
function autoKindOfOrigin(origin) {
  const k = origin && typeof origin === 'object' ? origin.kind : '';
  if (!k || typeof k !== 'string') return null;
  if (k === 'consultation') return 'consultation';
  if (k === 'schedule') return 'schedule';
  if (k === 'user' || k === 'comms') return null;
  return 'notice';
}
function autoQuoted(s) {
  const m = /"([^"\n]*)"/.exec(s || '');
  return m ? m[1] : null;
}
function autoInfoOf(entry) {
  if (!entry || entry.role !== 'user' || entry.ask === true) return null;
  const o = entry.origin;
  if (o && typeof o === 'object' && o.kind) {
    const kind = autoKindOfOrigin(o);
    if (!kind) return null;
    const from = o.from || o.jobName || null;
    let label;
    if (kind === 'consultation') label = `Consultation from ${from || 'another agent'}`;
    else if (kind === 'schedule') label = `Scheduled task${o.from ? ': ' + o.from : ''}`;
    else if (o.kind === 'job_notice') label = `Job finished${from ? ': ' + from : ''}`;
    else if (o.kind === 'job_report') label = `Job report${o.jobName ? ': ' + o.jobName : ''}`;
    else if (o.kind === 'task') label = o.label === 'context compression' ? 'Resumed after compression' : `Hub task${o.label ? ': ' + o.label : ''}`;
    else if (o.kind === 'consult_reply') label = 'Consultation replies delivered';
    else if (o.kind === 'alert') label = 'Monitor alert';
    else label = 'Hub turn';
    return { kind, from, label };
  }
  const text = typeof entry.content === 'string' ? entry.content.trimStart() : '';
  let m = /^\[Consultation from agent "([^"\n]*)"/.exec(text);
  if (m) return { kind: 'consultation', from: m[1], label: `Consultation from ${m[1] || 'another agent'}` };
  if (entry.tiger_team === true) return { kind: 'consultation', from: null, label: 'Consultation from another agent' };
  if (text.startsWith('[Scheduled task — started by the hub scheduler')) {
    const close = text.indexOf(']');
    const from = close >= 0 ? (/^\s*"([^"\n]*)"/.exec(text.slice(close + 1)) || [])[1] ?? null : null;
    return { kind: 'schedule', from, label: `Scheduled task${from ? ': ' + from : ''}` };
  }
  if (text.startsWith('[Job finished]') || text.startsWith('[Job ended]')) {
    const finished = text.startsWith('[Job finished]');
    const jm = /\bJob\s+"([^"\n]*)"/.exec(text);
    const name = jm ? jm[1] : null;
    return { kind: 'notice', from: name, label: `${finished ? 'Job finished' : 'Job ended'}${name ? ': ' + name : ''}` };
  }
  if (text.startsWith('[Resumed after compression, from the hub]')) return { kind: 'notice', from: null, label: 'Resumed after compression' };
  if (text.startsWith('[Delivery turn started by the hub')) return { kind: 'notice', from: null, label: 'Consultation replies delivered' };
  m = /^\[Queued consultation reply from agent "([^"\n]*)"/.exec(text);
  if (m) return { kind: 'notice', from: m[1], label: 'Consultation replies delivered' };
  return null;
}
function autoFirstLine(text, max = 140) {
  if (typeof text !== 'string') return '';
  for (const raw of text.split(/\r?\n/)) {
    let s = raw.trim().replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+)+/, '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
    if (!s || /^[-*_=\s]*$/.test(s)) continue;
    return s.length > max ? s.slice(0, Math.max(0, max - 1)).trimEnd() + '…' : s;
  }
  return '';
}
function autoCardKind(kind) {
  return kind === 'consultation' ? 'consult' : kind === 'schedule' ? 'schedule' : 'notice';
}
function autoSummaryOf(cards) {
  const n = (cards || []).length;
  const count = (k) => cards.filter((c) => c.kind === k).length;
  const parts = [];
  const c = count('consultation'), s = count('schedule'), h = n - c - s;
  if (c) parts.push(`${c} ${c === 1 ? 'consultation' : 'consultations'}`);
  if (s) parts.push(`${s} ${s === 1 ? 'scheduled task' : 'scheduled tasks'}`);
  if (h) parts.push(`${h} ${h === 1 ? 'hub notice' : 'hub notices'}`);
  return `${n} automatic ${n === 1 ? 'turn' : 'turns'}: ${parts.join(', ')}`;
}
function autoCardLine(history, indexes, kindsInfoLabel) {
  const isAsst = (i) => history[i].role === 'assistant';
  const asst = indexes.filter(isAsst);
  const pick = [...asst].reverse().find((i) => !history[i].for_owner);   // a reply shown open below the card is not repeated in it
  if (pick !== undefined) return autoFirstLine(history[pick].content);
  for (const i of [...indexes].reverse()) {
    if (isAsst(i)) continue;
    let c = typeof history[i].content === 'string' ? history[i].content : '';
    const task = c.indexOf('\nTask:\n');
    c = task >= 0 ? c.slice(task + 7) : c.trimStart().replace(/^\[[^\]]*\]:?/, '');
    const line = autoFirstLine(c);
    if (line) return line;
  }
  return kindsInfoLabel || '';
}
function autoGroupHistory(history, from = 0, { stackMin = AUTO_STACK_MIN } = {}) {
  const items = [];
  const n = Array.isArray(history) ? history.length : 0;
  let i = Math.max(0, from | 0);
  while (i < n) {
    const e = history[i];
    if (!e || e.inProgress) { i++; continue; }
    const info = autoInfoOf(e);
    if (!info) { items.push({ type: 'entry', index: i }); i++; continue; }
    let last = info, firstTs = e.ts, hasAsst = false;
    const indexes = [i];
    let j = i + 1;
    for (; j < n; j++) {
      const x = history[j];
      if (!x) break;
      if (x.inProgress) continue;
      if (x.ask === true) break;
      if (x.role === 'assistant') { hasAsst = true; indexes.push(j); continue; }
      if (x.role !== 'user' || hasAsst) break;
      const xi = autoInfoOf(x);
      if (!xi) break;
      last = xi; indexes.push(j);
    }
    const open = indexes.filter((k) => history[k].role === 'assistant' && history[k].for_owner === true);
    items.push({ type: 'card', kind: last.kind, from: last.from, label: last.label, ts: firstTs, indexes, open, firstLine: autoCardLine(history, indexes, last.label) });
    i = j;
  }
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= stackMin && run.length > 0) out.push({ type: 'stack', cards: run, summary: autoSummaryOf(run) });
    else out.push(...run);
    run = [];
  };
  for (const it of items) {
    if (it.type === 'card' && it.open.length === 0) run.push(it);
    else { flush(); out.push(it); }
  }
  flush();
  return out;
}
// ── auto-turn helpers (end) ──

// Voice helpers: shared with lib/ui-voice.js, kept in step by test/ui-voice.test.js.
// ── voice helpers (begin) ──
const VOICE_STORE_KEY = 'hub-voice';
const VOICE_DETAILS_NOTE = ' I have put the details in the chat.';
const VOICE_ABBREVIATIONS = new Set(['e.g', 'i.e', 'mr', 'mrs', 'ms', 'dr', 'st', 'prof', 'jr', 'sr', 'vs']);
const VOICE_STOP_COMMANDS = new Set(['stop', 'cancel', 'stop stop', 'stop it', 'stop that', 'cancel that', 'never mind', 'nevermind']);
const VOICE_END_PAUSES = [800, 1200, 2000];   // 'Pause before I'm done': short / normal / long, in ms
const VOICE_CONTINUE_WAITS = [1500, 3000, 5000];   // 'Wait for me to go on': how long a sentence that sounds unfinished waits for more, in ms
const VOICE_ECHO_HOLDS = [0, 600, 1000, 1500];   // 'Echo guard': how long the raised barge-in thresholds stay after playback stops, in ms (0 = off)
const VOICE_WAKE_QUIET_MS = [10000, 20000, 45000];   // 'Go back to standby after': how long a quiet call stays awake (default 20000)
const VOICE_DEFAULT_PREFS = { micLevel: 50, interruptSensitivity: 50, mode: 'handsfree', readAloud: true, deviceVoiceFallback: true, endPause: 1200, voiceSpeed: 1, speakActivity: false, continueWait: 3000, thinkingSound: true, thinkingVolume: 0.5, echoHold: 600, keepAlive: true, loudness: 'louder', loudnessBt: 'normal' };
function voiceCleanSpeed(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(Math.max(0.75, Math.min(1.5, n)) * 20) / 20 : 1;
}
function voiceSpeedLabel(v) { return voiceCleanSpeed(v).toFixed(2) + 'x'; }
// The spoken-text cleaner's pieces (see voiceSpeechText).
const VOICE_SYMBOLS_RE = new RegExp('[\\u2190-\\u2BFF\\u2022\\u00B7]', 'g');
const VOICE_NUM_EN_DASH_RE = new RegExp('(\\d)\\s*\\u2013\\s*(?=\\d)', 'g');
const VOICE_DASH_RE = new RegExp('\\s*[\\u2013\\u2014\\u2015]\\s*', 'g');
const VOICE_DQUOTE_RE = new RegExp('[\\u201C\\u201D"]', 'g');
const VOICE_SQUOTE_RE = new RegExp('[\\u2018\\u2019]', 'g');
const VOICE_ELLIPSIS_RE = new RegExp('\\u2026', 'g');
const VOICE_SEG = '\\/[\\w.@+~-]*[\\w@+~-]';
function voicePathsToWords(t) {
  const isPath = (m) => (m.match(/\//g) || []).length >= 2 || /\.[A-Za-z0-9]{1,8}$/.test(m);
  t = t.replace(/(^|[^\w/.~@-])[A-Za-z]:\\[^\s]*[^\s.,;:!?)\]'"]/g, '$1a file path');
  t = t.replace(new RegExp('(^|[^\\w/.~@-])((?:~|\\.{1,2})(?:' + VOICE_SEG + ')+|(?:' + VOICE_SEG + '){2,}|' + VOICE_SEG + '(?=\\.[A-Za-z0-9]{1,8}\\b)(?:\\.[A-Za-z0-9]{1,8})?)', 'g'),
    (m, lead, p) => lead + (isPath(p) || /^\/[\w@+~-]*\.\w/.test(p) ? 'a file path' : p));
  t = t.replace(new RegExp('(^|[^\\w/.~@-])((?=[\\w.-]*[A-Za-z])[\\w.-]+(?:' + VOICE_SEG + ')+)', 'g'), (m, lead, p) => lead + (isPath(p) ? 'a file path' : p));
  return t;
}
function voiceCleanInline(s) {
  s = s.replace(/\u2212\s*(?=\d)/g, 'minus ').replace(/\u2212/g, ' minus ');   // the minus sign is read, before the math-sign strip drops it
  s = s.replace(/[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\p{Extended_Pictographic}\p{Cf}\u{FE0E}\u{FE0F}\u{20E3}]/gu, '')   // emoji and zero-width marks
    .replace(VOICE_SYMBOLS_RE, ' ');                                    // arrows, math signs, boxes, dingbats, bullets
  s = s.replace(/[-=]+>|<[-=]+/g, ' ');                                 // -> => <-
  s = s.replace(VOICE_NUM_EN_DASH_RE, '$1 to ');                        // 5 en dash 10
  s = s.replace(VOICE_DASH_RE, ', ');                                   // en/em dash as a separator: a pause
  s = s.replace(/(^|[\s(])-{1,2}(?=[A-Za-z])/g, '$1');                  // a command-line flag: -x --force
  s = s.replace(/(^|[\s(])-(?=\d)/g, '$1minus ');
  s = s.replace(/\s*-{2,}\s*/g, ', ').replace(/\s+-(?=\s|$)/g, ', ');   // -- or a lone dash between spaces
  s = s.replace(/(^|\s)-+(?=\S)/g, '$1').replace(/(\S)-+(?=\s|$)/g, '$1');   // a dash stuck to the edge of a word (hyphens inside words stay)
  s = s.replace(/&/g, ' and ').replace(/%/g, ' percent').replace(/@/g, ' at ').replace(/=+/g, ' equals ');
  s = s.replace(/(\d)\s*\+\s*(?=\d)/g, '$1 plus ').replace(/(\d)\+(?=\W|$)/g, '$1 plus');
  s = s.replace(/<\/?[A-Za-z][^<>]*>/g, ' ');
  s = s.replace(/[*`#~^|\\<>+{}\[\]()]/g, ' ').replace(/\//g, ' ');
  s = s.replace(/\b_+|_+\b/g, '').replace(/_/g, ' ');
  s = s.replace(VOICE_DQUOTE_RE, '').replace(VOICE_SQUOTE_RE, '\'').replace(VOICE_ELLIPSIS_RE, '...');
  s = s.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) s = s.replace(/\s+([,.;:!?])/g, '$1').replace(/([,;:])(?:\s*[,;:])+/g, '$1').replace(/([.!?])\s*,/g, '$1').replace(/,\s*([.!?])/g, '$1');
  return s.replace(/^[,;:\s]+/, '').replace(/,$/, '').trim();
}
function voiceSpeechText(markdown, open) {
  let t = String(markdown == null ? '' : markdown).replace(/\r\n?/g, '\n');
  let hadDetails = false;
  t = t.replace(/(^|\n)[ \t]*(```|~~~)[\s\S]*?(\n[ \t]*(```|~~~)[^\n]*|$)/g, (m, lead) => { hadDetails = true; return lead; });
  t = t.split('\n').filter(l => { if (/^\s*\|/.test(l)) { hadDetails = true; return false; } return true; }).join('\n');
  t = t.replace(/!?\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1');
  t = t.replace(/(?:https?:\/\/|www\.)[^\s<>)\]]*[^\s<>)\].,;:!?'"]/gi, 'a link');
  t = voicePathsToWords(t);
  // Lines -> blocks: a heading, a list item or a bold-only line is a block of its own, a blank line or a rule ends one,
  // other lines of a paragraph join. Each block is cleaned and ends with a full stop, so lines never run together.
  const blocks = [];
  let cur = '', curOwn = false;
  const flush = () => { if (cur.trim()) blocks.push(cur.trim()); cur = ''; curOwn = false; };
  for (const raw of t.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || /^\s*([-*_=~])(?:\s*\1){2,}\s*$/.test(line)) { flush(); continue; }
    let s = line.replace(/^[ \t]*(?:>[ \t]?)+/, '');
    const head = /^[ \t]*#{1,6}[ \t]+/.test(s), item = /^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+/.test(s);
    s = s.replace(/^[ \t]*#{1,6}[ \t]+/, '').replace(/^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+/, '');
    const bold = /^\s*(\*\*|__)[^*_]+\1\s*:?\s*$/.test(s);
    if (head || item || bold) { flush(); cur = s; curOwn = true; }
    else if (!cur) cur = s;
    else if (curOwn && !/^(?:[ \t]{2,}|\t)/.test(raw)) { flush(); cur = s; }   // text under a heading or item starts its own block
    else cur += ' ' + s;
  }
  flush();
  const done = [];
  blocks.forEach((raw, i) => {
    const b = voiceCleanInline(raw);
    if (!b) return;
    // open: the text is still being written, so its last block is not finished and gets no full stop yet
    done.push(/[.!?:;]["')’\]]*$/.test(b) || (open && i === blocks.length - 1) ? b : b + '.');
  });
  t = done.join(' ').replace(/\s+/g, ' ').trim();
  return hadDetails ? (t + VOICE_DETAILS_NOTE).trim() : t;
}
function voiceSplitLong(s, max) {
  const out = [];
  let rest = s.trim();
  while (rest.length > max) {
    const win = rest.slice(0, max);
    let cut = Math.max(win.lastIndexOf(';'), win.lastIndexOf(',')) + 1;
    if (cut < max * 0.3) cut = win.lastIndexOf(' ') + 1;
    if (cut < max * 0.3) cut = win.lastIndexOf(' ') > 0 ? win.lastIndexOf(' ') + 1 : max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}
function voiceSentences(text, max = 220) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  const limit = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 220;
  const parts = [];
  let start = 0;
  const re = /[.!?]+["')\]]*(?=\s|$)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[0].replace(/["')\]]/g, '') === '.') {
      const before = s.slice(start, m.index).split(' ').pop().replace(/^[("'\[]+/, '').toLowerCase();
      if (VOICE_ABBREVIATIONS.has(before)) continue;
    }
    parts.push(s.slice(start, m.index + m[0].length));
    start = m.index + m[0].length;
  }
  parts.push(s.slice(start));
  const out = [];
  for (const p of parts) for (const q of voiceSplitLong(p, limit)) out.push(q);
  return out;
}
function voiceResample(float32, fromRate, toRate) {
  const src = float32 instanceof Float32Array ? float32 : Float32Array.from(float32 || []);
  if (fromRate === toRate || !(fromRate > 0) || !(toRate > 0)) return new Float32Array(src);
  const n = Math.max(0, Math.round(src.length * toRate / fromRate));
  const out = new Float32Array(n);
  const step = fromRate / toRate;
  for (let i = 0; i < n; i++) {
    const pos = i * step, i0 = Math.floor(pos), frac = pos - i0;
    const a = src[Math.min(i0, src.length - 1)], b = src[Math.min(i0 + 1, src.length - 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}
function voiceEncodeWav(float32, sampleRate) {
  const n = float32.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const tag = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const x = Math.max(-1, Math.min(1, float32[i] || 0));
    v.setInt16(44 + i * 2, Math.round(x < 0 ? x * 32768 : x * 32767), true);
  }
  return buf;
}
function voiceDecodeWav(arrayBuffer) {
  const v = new DataView(arrayBuffer), len = arrayBuffer.byteLength;
  const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (len < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let channels = 0, sampleRate = 0, bits = 0, dataAt = -1, dataLen = 0, o = 12;
  while (o + 8 <= len) {
    const id = tag(o), size = v.getUint32(o + 4, true);
    if (id === 'fmt ' && o + 24 <= len) {
      if (v.getUint16(o + 8, true) !== 1) throw new Error('only PCM WAV is supported');
      channels = v.getUint16(o + 10, true); sampleRate = v.getUint32(o + 12, true); bits = v.getUint16(o + 22, true);
    } else if (id === 'data') {
      dataAt = o + 8; dataLen = Math.min(size, len - dataAt); break;
    }
    o += 8 + size + (size % 2);
  }
  if (!channels || dataAt < 0) throw new Error('WAV has no audio');
  if (bits !== 16 || channels > 2) throw new Error('only 16-bit mono or stereo WAV is supported');
  const frames = Math.floor(dataLen / (2 * channels)), samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += v.getInt16(dataAt + (i * channels + c) * 2, true);
    samples[i] = sum / channels / 32768;
  }
  return { sampleRate, samples };
}
function voiceLevelDb(float32) {
  if (!float32 || !float32.length) return -100;
  let sum = 0;
  for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
  const rms = Math.sqrt(sum / float32.length);
  if (!(rms > 0)) return -100;
  return Math.max(-100, 20 * Math.log10(rms));
}
function voiceGainFromSlider(v) {
  const x = Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Number(v))) : 50;
  return Math.pow(10, ((x - 50) / 50 * 12) / 20);
}
function voiceSliderFromGain(g) {
  if (!(g > 0)) return 0;
  return Math.max(0, Math.min(100, 50 + 20 * Math.log10(g) / 12 * 50));
}
function voiceMeterPercent(db) {
  if (!Number.isFinite(db)) return db === Infinity ? 100 : 0;
  return Math.max(0, Math.min(100, (db + 60) / 60 * 100));
}
function voiceCleanPrefs(raw) {
  const p = Object.assign({}, VOICE_DEFAULT_PREFS);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return p;
  for (const k of ['micLevel', 'interruptSensitivity']) {
    if (typeof raw[k] === 'number' && Number.isFinite(raw[k])) p[k] = Math.max(0, Math.min(100, raw[k]));
  }
  if (raw.mode === 'handsfree' || raw.mode === 'tap') p.mode = raw.mode;
  if (VOICE_END_PAUSES.includes(raw.endPause)) p.endPause = raw.endPause;
  if (typeof raw.voiceSpeed === 'number' && Number.isFinite(raw.voiceSpeed)) p.voiceSpeed = voiceCleanSpeed(raw.voiceSpeed);
  if (VOICE_CONTINUE_WAITS.includes(raw.continueWait)) p.continueWait = raw.continueWait;
  if (VOICE_ECHO_HOLDS.includes(raw.echoHold)) p.echoHold = raw.echoHold;
  if (typeof raw.thinkingVolume === 'number' && Number.isFinite(raw.thinkingVolume)) p.thinkingVolume = Math.round(Math.max(0, Math.min(1, raw.thinkingVolume)) * 100) / 100;
  for (const k of ['readAloud', 'deviceVoiceFallback', 'speakActivity', 'thinkingSound', 'keepAlive']) if (typeof raw[k] === 'boolean') p[k] = raw[k];
  if (typeof raw.loudness === 'string' && Object.prototype.hasOwnProperty.call(VOICE_LOUDNESS, raw.loudness)) p.loudness = raw.loudness;
  if (typeof raw.loudnessBt === 'string' && Object.prototype.hasOwnProperty.call(VOICE_LOUDNESS, raw.loudnessBt)) p.loudnessBt = raw.loudnessBt;
  // wake: per agent { on, phrase, quietMs }; the key exists only when the raw prefs carried an object (the defaults have none)
  if (raw.wake && typeof raw.wake === 'object' && !Array.isArray(raw.wake)) {
    const wake = {};
    let n = 0;
    for (const name of Object.keys(raw.wake)) {
      if (n >= 50) break;
      const e = raw.wake[name];
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name) || !e || typeof e !== 'object' || Array.isArray(e)) continue;
      wake[name] = { on: e.on === true, phrase: voiceCleanWakePhrase(e.phrase), quietMs: VOICE_WAKE_QUIET_MS.includes(e.quietMs) ? e.quietMs : 20000 };
      n++;
    }
    p.wake = wake;
  }
  return p;
}
// The wake phrase of an agent from the cleaned prefs: { on, phrase, quietMs } or null.
function voiceWakeForAgent(prefs, agent) {
  try {
    const w = prefs && prefs.wake;
    if (!w || typeof w !== 'object' || typeof agent !== 'string' || !Object.prototype.hasOwnProperty.call(w, agent)) return null;
    const e = w[agent];
    if (!e || typeof e !== 'object') return null;
    return { on: e.on === true, phrase: typeof e.phrase === 'string' ? e.phrase : '', quietMs: VOICE_WAKE_QUIET_MS.includes(e.quietMs) ? e.quietMs : 20000 };
  } catch { return null; }
}
const VOICE_WAKE_GREETINGS = new Set(['hey', 'hi', 'hello', 'hay', 'ok', 'okay', 'yo', 'oh', 'um', 'uh', 'so', 'well']);
// The phrase tidied for display, '' when it is not usable: 1-4 words of letters, digits or apostrophes (1-20 characters each), at most
// 60 characters, and at least one word of 3+ characters that is not a greeting or filler.
function voiceCleanWakePhrase(text) {
  if (typeof text !== 'string') return '';
  const s = text.replace(/\s+/g, ' ').trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (!s || s.length > 60) return '';
  const words = s.split(' ').map(w => w.replace(/[,.]/g, '')).filter(Boolean);
  if (words.length < 1 || words.length > 4) return '';
  if (!words.every(w => /^[\p{L}\p{N}'’]{1,20}$/u.test(w))) return '';
  if (!words.some(w => w.replace(/['’]/g, '').length >= 3 && !VOICE_WAKE_GREETINGS.has(w.toLowerCase().replace(/['’]/g, '')))) return '';
  return words.join(' ');
}
// Tokens for matching: lowercase, apostrophes removed, everything else that is not a letter or digit separates; each token keeps the
// offset just after its last character in the original text.
function voiceWakeTokens(text) {
  const s = String(text), out = [];
  let cur = '', end = 0;
  for (let i = 0; i < s.length;) {
    const ch = String.fromCodePoint(s.codePointAt(i)), at = i;
    i += ch.length;
    if (ch === '\'' || ch === '’' || ch === '‘' || ch === 'ʼ') continue;
    if (/[\p{L}\p{N}]/u.test(ch)) { cur += ch.toLowerCase(); end = at + ch.length; }
    else if (cur) { out.push({ t: cur, end }); cur = ''; }
  }
  if (cur) out.push({ t: cur, end });
  return out;
}
function voiceWakeDistance(a, b) {
  let prev = []; for (let j = 0; j <= b.length; j++) prev.push(j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[b.length];
}
const VOICE_WAKE_FILLERS = new Set(['um', 'uh', 'umm', 'uhh', 'er', 'erm', 'ah', 'hmm', 'hm', 'mm', 'oh', 'so', 'ok', 'okay', 'well', 'and', 'yeah']);
// Does the utterance start with the wake phrase? -> { match, rest }: rest is the original text after the phrase without the pause
// punctuation. Leading fillers are skipped (not one that is the phrase's own first word); the first 1..words+2 tokens are joined and
// compared to the phrase without spaces by edit distance (0 up to 6 letters, 1 up to 12, 2 above), the first letters must agree.
function voiceWakeMatch(text, phrase) {
  const none = { match: false, rest: '' };
  try {
    if (typeof text !== 'string' || !text) return none;
    const clean = voiceCleanWakePhrase(phrase);
    if (!clean) return none;
    const pt = voiceWakeTokens(clean).map(x => x.t);
    if (!pt.length) return none;
    const ut = voiceWakeTokens(text);
    let i = 0;
    while (i < ut.length && VOICE_WAKE_FILLERS.has(ut[i].t) && ut[i].t !== pt[0]) i++;
    if (i >= ut.length || ut[i].t[0] !== pt[0][0]) return none;
    const P = pt.join(''), tol = P.length <= 6 ? 0 : P.length <= 12 ? 1 : 2;
    // Every span of 1 .. k+2 words is tried and the closest one wins (fewest edits, then the word count nearest the phrase's), so
    // "Hey Watchman AI" heard in full is never taken as "Hey Watchman" plus a message starting "AI".
    let U = '', best = null;
    for (let n = 1; n <= pt.length + 2 && i + n <= ut.length; n++) {
      U += ut[i + n - 1].t;
      if (Math.abs(U.length - P.length) > tol) continue;
      const dist = voiceWakeDistance(U, P);
      if (dist > tol) continue;
      const off = Math.abs(n - pt.length);
      if (!best || dist < best.dist || (dist === best.dist && off < best.off)) best = { dist, off, end: ut[i + n - 1].end };
    }
    if (!best) return none;
    return { match: true, rest: text.slice(best.end).replace(/^[\s,.!?;:\-–—…"'“”‘’()\[\]]+/, '').trimEnd() };
  } catch { return none; }
}
function voiceLoadPrefs(storage) {
  try { return voiceCleanPrefs(JSON.parse(storage.getItem(VOICE_STORE_KEY))); } catch { return voiceCleanPrefs(null); }
}
function voiceSavePrefs(storage, prefs) {
  const merged = voiceCleanPrefs(Object.assign({}, voiceLoadPrefs(storage), prefs));
  try { storage.setItem(VOICE_STORE_KEY, JSON.stringify(merged)); } catch { /* storage full or blocked: keep going */ }
  return merged;
}
function voiceIsStopCommand(text) {
  const t = String(text == null ? '' : text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return VOICE_STOP_COMMANDS.has(t);
}
// The words that put an awake call back to standby: 'that's all', 'that is all', 'go to sleep', each with 'thanks' or 'thank you' after.
const VOICE_SLEEP_COMMANDS = new Set(['thats all', 'that is all', 'go to sleep'].flatMap(c => [c, c + ' thanks', c + ' thank you']));
function voiceIsSleepCommand(text) {
  const t = String(text == null ? '' : text).toLowerCase().replace(/['’]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return VOICE_SLEEP_COMMANDS.has(t);
}
// Does what was said sound unfinished? True when it ends on a joining word (and, but, to, the, ...), ends with a comma, a
// dash or an ellipsis, or is a fragment of one or two words without final punctuation. A whole sentence or a question is
// finished, and so are stop commands and short answers (now, later, skip, yes, no, ok). A final full stop does not make a
// fragment finished ("... difficult to."): Whisper puts one on a cut-off piece, so it is stripped before the last word is checked.
// Strong joining words leave a thought open even with a final full stop ("... difficult to."); weak ones (pronouns, "is",
// "that"...) end plenty of whole sentences ("Do it.", "That is what it is."), so they count only without final punctuation.
const VOICE_JOINING_WORDS = new Set(['and', 'also', 'but', 'or', 'because', 'to', 'the', 'a', 'an', 'of', 'when', 'if', 'with', 'from', 'about', 'like',
  'my', 'your', 'our', 'their', 'very', 'um', 'uh', 'er', 'hmm']);
const VOICE_WEAK_JOINING_WORDS = new Set(['that', 'which', 'who', 'i', 'you', 'we', 'it', 'is', 'are', 'was', 'this', 'these', 'then', 'just', 'really', 'so', 'as', 'at', 'in', 'on', 'by', 'than', 'for']);
const VOICE_JOINING_PHRASES = ['you know', 'i mean'];
const VOICE_COMPLETE_SHORT = new Set(['stop', 'cancel', 'now', 'later', 'skip', 'yes', 'no', 'yeah', 'yep', 'nope', 'ok', 'okay', 'sure', 'thanks', 'hello', 'hi', 'go ahead', 'thank you', 'never mind', 'nevermind']);
function voiceSoundsUnfinished(text) {
  const raw = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!raw) return false;
  if (/[,–—…-]["')\]]*$/.test(raw) || /\.{3}["')\]]*$/.test(raw)) return true;   // a comma, a dash, an ellipsis: more is coming
  if (/[!?\uFF01\uFF1F]["')\]]*$/.test(raw)) return false;                                                    // a question or an exclamation is whole
  const body = raw.replace(/[.\u3002\s]+$/, '');
  const words = body.toLowerCase().replace(/[^\p{L}\p{N}'’\s]/gu, ' ').replace(/’/g, '\'').split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  if (voiceIsStopCommand(raw) || VOICE_COMPLETE_SHORT.has(words.join(' '))) return false;
  const last = words[words.length - 1].replace(/^'+|'+$/g, '');
  if (VOICE_JOINING_WORDS.has(last) || (words.length >= 2 && VOICE_JOINING_PHRASES.includes(words.slice(-2).join(' ')))) return true;
  if (VOICE_WEAK_JOINING_WORDS.has(last) && !/[.\u3002]['")\]]*$/.test(raw)) return true;                         // weak: only without a full stop
  return words.length <= 2 && !/[.\u3002]["')\]]*$/.test(raw);                                        // one or two words and no full stop
}
function voicePickLocalVoice(voices, lang) {
  const pre = String(lang || 'en').toLowerCase();
  const local = Array.from(voices || []).filter(v => v && v.localService === true && String(v.lang || '').toLowerCase().startsWith(pre));
  return local.find(v => v.default === true) || local[0] || null;
}
async function voiceWaitLocalVoice(synth, lang, waitMs = 1000) {
  if (!synth || typeof synth.getVoices !== 'function') return null;
  let list = synth.getVoices() || [];
  if (!list.length && typeof synth.addEventListener === 'function') {
    list = await new Promise((resolve) => {
      let done = false, timer = null;
      const fin = () => {
        if (done) return;
        done = true; clearTimeout(timer);
        try { synth.removeEventListener('voiceschanged', fin); } catch { /* gone */ }
        resolve(synth.getVoices() || []);
      };
      timer = setTimeout(fin, waitMs);
      synth.addEventListener('voiceschanged', fin);
    });
  }
  return voicePickLocalVoice(list, lang);
}
function voiceMicGuard() {
  const g = { pending: false, gen: 0 };
  g.begin = () => { if (g.pending) return -1; g.pending = true; return g.gen; };
  g.cancel = () => { g.gen++; };
  g.fail = () => { g.pending = false; };
  g.settle = (token, mic) => {
    g.pending = false;
    if (token === g.gen) return true;
    try { if (mic && mic.close) mic.close(); } catch { /* already closed */ }
    return false;
  };
  return g;
}
// The test sound of the 'Car or Bluetooth check': a 120 ms linear sweep from 500 Hz to 3000 Hz (inside narrowband car audio, 300-3400 Hz),
// Hann-windowed so it does not click, peak 0.5.
function voiceCarChirp(rate) {
  const r = Number(rate) > 0 ? Number(rate) : 16000, n = Math.max(2, Math.round(r * 0.12)), dur = n / r, f0 = 500, f1 = 3000;
  const out = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / r, phase = 2 * Math.PI * (f0 * t + (f1 - f0) * t * t / (2 * dur));
    out[i] = Math.sin(phase) * 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
    peak = Math.max(peak, Math.abs(out[i]));
  }
  if (peak > 0) for (let i = 0; i < n; i++) out[i] = out[i] * 0.5 / peak;
  return out;
}
// Where does the test sound come back? ref = the chirp, rec = microphone samples that start when the chirp was scheduled to start, both at
// `rate`. Searches the lags 0..opts.maxDelayMs (default 1500) for the peak of the NORMALISED cross-correlation (divided by
// sqrt(energy of ref x energy of the recorded window)): a coarse pass over every few samples (so 48 kHz input stays fast), then the exact
// values around the best one. -> { delayMs, echoDb, confidence }: confidence is the normalised peak (0..1), delayMs the lag in ms (null when
// confidence < 0.3: no echo found), echoDb the RMS level of the recorded window at that lag (-Infinity for silence).
function voiceEchoAnalysis(ref, rec, rate, opts) {
  const o = opts || {}, none = { delayMs: null, echoDb: -Infinity, confidence: 0 };
  const n = ref ? ref.length : 0, m = rec ? rec.length : 0;
  if (!(n > 0) || !(Number(rate) > 0)) return none;
  const maxMs = Number.isFinite(Number(o.maxDelayMs)) && Number(o.maxDelayMs) >= 0 ? Number(o.maxDelayMs) : 1500;
  const maxLag = Math.min(Math.floor(maxMs * rate / 1000), m - n);
  if (maxLag < 0) return none;
  let eref = 0;
  for (let i = 0; i < n; i++) eref += ref[i] * ref[i];
  if (!(eref > 0)) return none;
  const pre = new Float64Array(m + 1);   // running sums of rec squared: the energy of any window in O(1)
  for (let i = 0; i < m; i++) pre[i + 1] = pre[i] + rec[i] * rec[i];
  const energy = (lag) => pre[lag + n] - pre[lag];
  const step = Math.max(1, Math.round(rate / 12000));   // 48 kHz: every 4th sample; 16 kHz and 8 kHz: every sample
  const cols = Math.ceil(n / step), refD = new Float32Array(cols);
  for (let j = 0; j < cols; j++) refD[j] = ref[j * step];
  let bestLag = 0, best = -Infinity;
  for (let lag = 0; lag <= maxLag; lag += step) {
    const e = energy(lag);
    if (!(e > 0)) continue;
    let s = 0;
    for (let j = 0; j < cols; j++) s += refD[j] * rec[lag + j * step];
    const score = s * step / Math.sqrt(eref * e);
    if (score > best) { best = score; bestLag = lag; }
  }
  let conf = 0;
  const lo = Math.max(0, bestLag - Math.max(4, step)), hi = Math.min(maxLag, bestLag + Math.max(4, step));
  for (let lag = lo; lag <= hi; lag++) {
    const e = energy(lag);
    if (!(e > 0)) continue;
    let s = 0;
    for (let i = 0; i < n; i++) s += ref[i] * rec[lag + i];
    const score = s / Math.sqrt(eref * e);
    if (score > conf) { conf = score; bestLag = lag; }
  }
  conf = Math.max(0, Math.min(1, conf));
  const rms = Math.sqrt(Math.max(0, energy(bestLag)) / n);
  const echoDb = rms > 0 ? Math.round(20 * Math.log10(rms) * 10) / 10 : -Infinity;
  return { delayMs: conf < 0.3 ? null : Math.round(bestLag / rate * 1000), echoDb, confidence: conf, lag: bestLag };   // lag: the same in samples (exact)
}
function voiceEchoHoldLabel(ms) { return ms === 0 ? 'off' : (ms / 1000) + ' s'; }   // 'off', '0.6 s', '1 s', '1.5 s'
function voiceCarMedian(list) {
  const a = list.slice().sort((x, y) => x - y), k = a.length >> 1;
  return a.length % 2 ? a[k] : (a[k - 1] + a[k]) / 2;
}
// What the car test decides. analyses = voiceEchoAnalysis results (usually 3), current = { echoHold, interruptSensitivity }. The sound was heard
// when at least two analyses found an echo. Then the Echo guard becomes the smallest hold (0 is not a candidate) of at least the median delay
// + 300 ms (else the longest), and a loud echo lowers the interrupt sensitivity (never raises it): echo above -30 dB: at most 30; above -45 dB: at most 40.
// -> { echoHold, interruptSensitivity, delayMs, echoDb, heard, line } (line: what is said and shown).
function voiceCarCheckResult(analyses, current) {
  const cur = current || {};
  const curHold = VOICE_ECHO_HOLDS.includes(cur.echoHold) ? cur.echoHold : 600;
  const curSens = Number.isFinite(Number(cur.interruptSensitivity)) ? Number(cur.interruptSensitivity) : 50;
  const found = Array.from(analyses || []).filter(a => a && typeof a === 'object' && a.delayMs !== null && Number.isFinite(Number(a.delayMs)));
  if (found.length < 2) {
    return { echoHold: curHold, interruptSensitivity: curSens, delayMs: null, echoDb: null, heard: false,
      line: 'No echo of the test sound reached the microphone. Echo guard stays at ' + voiceEchoHoldLabel(curHold) + '.' };
  }
  const delayMs = Math.round(voiceCarMedian(found.map(a => Number(a.delayMs))));
  const echoDb = Math.round(voiceCarMedian(found.map(a => (Number.isNaN(Number(a.echoDb)) ? -Infinity : Number(a.echoDb)))) * 10) / 10;
  const echoHold = VOICE_ECHO_HOLDS.filter(h => h > 0).find(h => h >= delayMs + 300) || 1500;
  const interruptSensitivity = echoDb > -30 ? Math.min(curSens, 30) : echoDb > -45 ? Math.min(curSens, 40) : curSens;
  const lowered = interruptSensitivity < curSens;
  return { echoHold, interruptSensitivity, delayMs, echoDb, heard: true,
    line: 'The echo comes back after ' + delayMs + ' ms. Echo guard set to ' + voiceEchoHoldLabel(echoHold) + (lowered ? ', interrupt sensitivity lowered to ' + interruptSensitivity + '.' : '.') };
}
// The Car or Bluetooth check plays the chirp three times, VOICE_CAR_AT seconds after the start, and records until VOICE_CAR_END. The chirps are 1.5 s
// apart and the search for an echo stops at VOICE_CAR_MAX_DELAY_MS (1.2 s), so the window of one chirp never holds the echo of the next.
const VOICE_CAR_AT = [0.5, 2.0, 3.5], VOICE_CAR_END = 5.2, VOICE_CAR_MAX_DELAY_MS = 1200;
// The analysis of one check recording. mic = the microphone samples and ref = a copy of the chirp (silence elsewhere) from the SAME buffers of the SAME
// audio processor, so both share one clock and index i of one is the same instant as index i of the other. The chirp onsets are found in ref
// (confidence > 0.9, in samples): the first in a window shorter than the spacing (so it can only be the first chirp), each next one within
// +-200 ms of where the spacing puts it. Then for each onset the microphone slice [onset, onset + VOICE_CAR_MAX_DELAY_MS + chirp length] is
// analysed. -> always VOICE_CAR_AT.length voiceEchoAnalysis results; a chirp whose onset was not found gives { delayMs: null, echoDb: -Infinity, confidence: 0 }.
function voiceCarAnalyse(mic, ref, chirp, rate) {
  const count = VOICE_CAR_AT.length, none = () => ({ delayMs: null, echoDb: -Infinity, confidence: 0 }), out = [];
  const n = chirp ? chirp.length : 0, r = Number(rate);
  const onsets = [];   // null where a chirp was not found
  if (ref && n > 0 && r > 0) {
    const firstMs = Math.max(200, ((VOICE_CAR_AT[1] - VOICE_CAR_AT[0]) || 1.5) * 1000 - 100);
    const a0 = voiceEchoAnalysis(chirp, ref, r, { maxDelayMs: firstMs });
    let prev = a0.delayMs !== null && a0.confidence > 0.9 ? a0.lag : null;
    onsets.push(prev);
    for (let i = 1; i < count; i++) {
      if (prev === null) { onsets.push(null); continue; }
      const from = Math.max(0, prev + Math.round((VOICE_CAR_AT[i] - VOICE_CAR_AT[i - 1]) * r) - Math.round(0.2 * r));
      const a = voiceEchoAnalysis(chirp, ref.subarray(from), r, { maxDelayMs: 400 });
      prev = a.delayMs !== null && a.confidence > 0.9 ? from + a.lag : null;
      onsets.push(prev);
    }
  }
  const span = Math.round(VOICE_CAR_MAX_DELAY_MS / 1000 * r) + n;
  for (let i = 0; i < count; i++) {
    if (i >= onsets.length || onsets[i] === null || !mic) { out.push(none()); continue; }
    out.push(voiceEchoAnalysis(chirp, mic.subarray(onsets[i], onsets[i] + span), r, { maxDelayMs: VOICE_CAR_MAX_DELAY_MS }));
  }
  return out;
}
// A very quiet, looping WAV (white noise near -60 dBFS, never silence). Played through a media element it makes Chrome for Android take full audio focus.
function voiceFocusWav(seconds = 6, sampleRate = 8000) {
  const n = Math.max(1, Math.round(seconds * sampleRate)), bytes = n * 2;
  const out = new Uint8Array(44 + bytes), dv = new DataView(out.buffer);
  const tag = (o, s) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + bytes, true); tag(8, 'WAVE'); tag(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); tag(36, 'data'); dv.setUint32(40, bytes, true);
  let s = 123456789;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    let v = Math.round(((s >>> 8) / 8388607.5 - 1) * 33);
    if (v === 0) v = (i & 1) ? 1 : -1;
    dv.setInt16(44 + i * 2, v, true);
  }
  return out;
}
// A hidden looping <audio> element playing that noise for the length of a call, so other apps pause instead of just ducking. start() must run inside the user's tap.
function voiceCreateAudioFocus(opts) {
  const o = opts || {};
  const doc = o.doc, urlApi = o.URL, BlobCtor = o.Blob;
  let el = null, src = null, running = false, gen = 0;   // gen: a play() of an earlier start never changes a later one's state
  function make() {
    if (el) return el;
    if (!doc || typeof doc.createElement !== 'function') return null;
    if (!src) {
      if (!urlApi || typeof urlApi.createObjectURL !== 'function' || typeof BlobCtor !== 'function') return null;
      src = urlApi.createObjectURL(new BlobCtor([voiceFocusWav()], { type: 'audio/wav' }));
    }
    const a = doc.createElement('audio');
    if (!a) return null;
    a.loop = true; a.preload = 'auto'; a.playsInline = true;
    if (typeof a.setAttribute === 'function') { a.setAttribute('playsinline', ''); a.setAttribute('aria-hidden', 'true'); }
    a.muted = false; a.volume = 1;
    if (a.style) a.style.display = 'none';
    a.src = src;
    if (doc.body && typeof doc.body.appendChild === 'function') doc.body.appendChild(a);
    el = a;
    return el;
  }
  return {
    start() {
      if (running) return Promise.resolve(true);
      try {
        const a = make();
        if (!a || typeof a.play !== 'function') return Promise.resolve(false);
        const my = ++gen;
        const p = a.play();
        running = true;
        return Promise.resolve(p).then(() => my === gen, () => { if (my === gen) running = false; return false; });
      } catch { running = false; return Promise.resolve(false); }
    },
    stop() {
      gen++;
      running = false;
      if (!el) return;
      try { if (typeof el.pause === 'function') el.pause(); } catch {}
      try { el.currentTime = 0; } catch {}
    },
    get running() { return running; },
  };
}
// Loudness boost for call replies (dB): the speech engine leaves headroom, and Android's call mode lowers the output further.
const VOICE_LOUDNESS = { normal: 0, louder: 9, loudest: 14 };
// The same levels when the hub already sent the voice normalised to -16 dBFS (header X-Voice-Normalized: 1): less boost is needed.
const VOICE_LOUDNESS_NORMALIZED = { normal: 0, louder: 4, loudest: 8 };
function voiceLoudnessDb(name, normalized) {
  const t = normalized ? VOICE_LOUDNESS_NORMALIZED : VOICE_LOUDNESS;
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(t, name) ? t[name] : t.louder;
}
// Which output a call's sound goes to, from the open microphone's label (the output follows the input route during a call): 'bluetooth' for
// a Bluetooth headset, hands-free or car input, else 'speaker' (the phone or computer speaker; a wired headset counts as speaker). Android's
// Chrome names inputs "Bluetooth headset", "Speakerphone", "Wired headset", "Headset earpiece", "USB audio".
function voiceOutputKind(label) {
  return typeof label === 'string' && /bluetooth|hands[- ]?free|\bhfp\b|airpods|\bcar\b|car audio/i.test(label) ? 'bluetooth' : 'speaker';
}
// The loudness level name for an output kind: the speaker pref, or the Bluetooth / car pref.
function voiceLoudnessFor(prefs, kind) {
  const p = prefs && typeof prefs === 'object' ? prefs : {};
  const v = kind === 'bluetooth' ? p.loudnessBt : p.loudness;
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(VOICE_LOUDNESS, v) ? v : (kind === 'bluetooth' ? 'normal' : 'louder');
}
// The output ceiling: no sample leaves the call chain louder than this (-1 dBFS).
const VOICE_CEILING = Math.pow(10, -1 / 20);
// The compressor's automatic makeup gain at threshold -3 dB, ratio 20, knee 0 is (3 - 3/20) * 0.6 = 1.71 dB; the trim takes it back off,
// so speech below the threshold plays at exactly the chosen loudness. (At -6 dB the compressor held speech near -18.5 dBFS with peaks
// near -4 and left the headroom to the ceiling unused; the curve below is what guarantees the ceiling.)
const VOICE_LIMIT_THRESHOLD_DB = -3;
const VOICE_LIMIT_TRIM_DB = -1.71;
// A fixed safety curve after the compressor: straight up to 0.7 (-3.1 dBFS), then a smooth bend that never reaches the ceiling,
// even for inputs past full scale (a WaveShaper holds its last value there). This is what makes the limit hard: the compressor
// alone lets the first milliseconds of a peak through.
function voiceCeilingCurve(n) {
  const len = Math.max(3, n | 0), k = 0.7, room = VOICE_CEILING - k;
  const curve = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const x = (i / (len - 1)) * 2 - 1, a = Math.abs(x);
    const y = a <= k ? a : k + room * Math.tanh((a - k) / room);
    curve[i] = x < 0 ? -y : y;
  }
  return curve;
}
// One chain per AudioContext: gain -> compressor -> trim -> ceiling curve -> analyser -> destination. Returns null when the context cannot build it.
function voiceCreateLoudness(ctx) {
  if (!ctx) return null;
  try { if (ctx.__voiceLoudness) return ctx.__voiceLoudness; } catch {}
  if (typeof ctx.createGain !== 'function' || typeof ctx.createDynamicsCompressor !== 'function') return null;
  let gain, comp, trim, shaper = null, an = null, db = voiceLoudnessDb('louder'), buf = null;
  try {
    gain = ctx.createGain();
    comp = ctx.createDynamicsCompressor();
    const set = (prm, v) => { try { if (prm && typeof prm === 'object') prm.value = v; } catch {} };
    set(comp.threshold, VOICE_LIMIT_THRESHOLD_DB); set(comp.knee, 0); set(comp.ratio, 20); set(comp.attack, 0.001); set(comp.release, 0.1);
    trim = ctx.createGain();
    set(trim.gain, Math.pow(10, VOICE_LIMIT_TRIM_DB / 20));
    if (typeof ctx.createWaveShaper === 'function') {
      try { shaper = ctx.createWaveShaper(); shaper.curve = voiceCeilingCurve(4097); shaper.oversample = 'none'; } catch { shaper = null; }
    }
    if (typeof ctx.createAnalyser === 'function') { try { an = ctx.createAnalyser(); an.fftSize = 2048; } catch { an = null; } }
    gain.connect(comp);
    comp.connect(trim);
    let last = trim;
    if (shaper) { last.connect(shaper); last = shaper; }
    if (an) { last.connect(an); an.connect(ctx.destination); } else last.connect(ctx.destination);
  } catch { return null; }
  let levelName = 'louder', normalized = false;
  const apply = () => { db = voiceLoudnessDb(levelName, normalized); try { gain.gain.value = Math.pow(10, db / 20); } catch {} };
  apply();
  const chain = {
    input: gain,
    setLevel(name) { levelName = name; apply(); },
    setNormalized(flag) { normalized = !!flag; apply(); },
    get normalized() { return normalized; },
    get gainDb() { return db; },
    meter() {
      try {
        if (!an || typeof an.getFloatTimeDomainData !== 'function') return null;
        if (!buf || buf.length !== (an.fftSize || 2048)) buf = new Float32Array(an.fftSize || 2048);
        an.getFloatTimeDomainData(buf);
        let sum = 0, peak = 0;
        for (let i = 0; i < buf.length; i++) { const v = buf[i]; sum += v * v; const a = Math.abs(v); if (a > peak) peak = a; }
        const toDb = (x) => (x > 0 ? Math.max(-120, 20 * Math.log10(x)) : -120);
        return { rmsDb: toDb(Math.sqrt(sum / buf.length)), peakDb: toDb(peak) };
      } catch { return null; }
    },
  };
  try { ctx.__voiceLoudness = chain; } catch {}
  return chain;
}
// ── voice helpers (end) ──

// Hands-free call controller: shared with lib/ui-voice-call.js, kept in step by test/ui-voice-call.test.js.
// ── voice call (begin) ──
const VOICE_ECHO_HOLD_MS = 600, VOICE_CALL_LEAD_IN_MS = 300, VOICE_KEEPALIVE_DB = -70;
const VOICE_MIC_LOST_LINE = 'I lost the microphone. Tap the button to try it again.';
const VOICE_CALL_HEARTBEAT_MS = 15000, VOICE_CALL_STATUS_GAP_MS = 10000, VOICE_CALL_PAUSE_MS = 1500, VOICE_CALL_ANSWER_MS = 20000;
const VOICE_CALL_JOIN_MS = 2000, VOICE_CALL_STILL_MS = 20000, VOICE_CALL_THINK_MS = 2000, VOICE_CALL_CONTINUE_MS = 3000, VOICE_CALL_HOLD_MS = 5000, VOICE_CALL_WAIT_HOLD_MS = 20000;
// After 20 s with no reply speech, ONE of these is spoken (never the same one twice in a wait).
const VOICE_THINKING_LINES = ['I\'m considering what you just said.', 'Still thinking about that.', 'Give me a moment, I\'m working through it.'];
const VOICE_CALL_FILLERS = new Set(['uh', 'um', 'umm', 'uhh', 'er', 'erm', 'ah', 'hmm', 'hm', 'mm', 'mmm', 'huh']);
const VOICE_CALL_ORDINALS = [['first', '1st', 'one', '1'], ['second', '2nd', 'two', '2'], ['third', '3rd', 'three', '3'], ['fourth', '4th', 'four', '4'], ['fifth', '5th', 'five', '5']];
function voiceCallNorm(text) {
  return String(text == null ? '' : text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
function voiceJoinOr(list) {
  const a = Array.from(list || []).filter(Boolean);
  return a.length < 2 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' or ' + a[a.length - 1];
}
function voiceDecisionWord(text) {
  const t = voiceCallNorm(text);
  if (!t || t.split(' ').length > 6) return null;
  if (/\b(later|after|afterwards|not now|wait|hold on)\b/.test(t)) return 'later';
  if (/\b(skip|no|nope|decline|cancel it|drop it|dismiss)\b/.test(t)) return 'skip';
  if (/\b(now|go ahead|yes|yeah|yep|sure)\b/.test(t)) return 'now';
  return null;
}
function voiceMatchChoice(text, options) {
  const labels = Array.from(options || []).map(o => (typeof o === 'string' ? o : (o && (o.label || o.value || o.text)) || '')).filter(Boolean);
  const t = voiceCallNorm(text);
  if (!t || !labels.length) return null;
  const norm = labels.map(voiceCallNorm);
  let i = norm.indexOf(t);
  if (i >= 0) return labels[i];
  const byLen = norm.map((n, k) => k).filter(k => norm[k]).sort((a, b) => norm[b].length - norm[a].length);
  for (const k of byLen) if ((' ' + t + ' ').includes(' ' + norm[k] + ' ')) return labels[k];
  const words = t.split(' ');
  for (const w of words) {
    const k = VOICE_CALL_ORDINALS.findIndex(set => set.includes(w));
    if (k >= 0 && k < labels.length) return labels[k];
  }
  i = norm.findIndex(n => n && n.split(' ')[0] === words[0] && words[0].length > 1);
  return i >= 0 ? labels[i] : null;
}
function voiceStatusLine(item) {
  const s = (typeof item === 'string' ? item : item && (item.tool || item.name || item.label || item.kind || item.type) || '').toString().toLowerCase();
  if (/consult|agent|delegate/.test(s)) return 'Asking another agent.';
  if (/web|search|fetch|browse|url/.test(s)) return 'Searching the web.';
  if (/bash|shell|command|exec|terminal|\brun/.test(s)) return 'Running a command.';
  if (/read|file|grep|glob|\bls\b|view/.test(s)) return 'Reading a file.';
  return 'Working on it.';
}
function voiceCallMedian(list) {
  const a = Array.from(list || []).filter(x => Number.isFinite(x) && x > -100).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function voiceRoomCheck(speechDb, silenceDb, currentMicLevel) {
  const cur = Number.isFinite(currentMicLevel) ? Math.max(0, Math.min(100, currentMicLevel)) : 50;
  const speech = voiceCallMedian(speechDb), noise = voiceCallMedian(silenceDb);
  if (speech === null) return { micLevel: cur, interruptSensitivity: 50 };
  const micLevel = Math.round(Math.max(0, Math.min(100, cur + (-20 - speech) * 50 / 12)));
  const gap = noise === null ? 60 : speech - noise;
  const interruptSensitivity = Math.round(Math.max(10, Math.min(90, 10 + (gap - 10) / 30 * 60)));
  return { micLevel, interruptSensitivity };
}
function voiceVadThresholds(interruptSensitivity, playing) {
  if (!playing) return { positiveSpeechThreshold: 0.5, negativeSpeechThreshold: 0.35, minSpeechFrames: 3 };
  const s = Number.isFinite(Number(interruptSensitivity)) ? Math.max(0, Math.min(100, Number(interruptSensitivity))) : 50;
  const positive = 0.9 - 0.4 * s / 100;
  return { positiveSpeechThreshold: +positive.toFixed(3), negativeSpeechThreshold: +(positive - 0.15).toFixed(3), minSpeechFrames: Math.round(8 - 5 * s / 100) };
}
// On a call only the spoken lead of a reply is read aloud: at most this many sentences.
const VOICE_LEAD_MAX_SENTENCES = 3;
// A 'detail' line ends the spoken lead: a table row starting with |, a code fence, a heading, a list item, a rule, or a bold label
// (bold text ending in a colon: **Details:** or **Details**:). A bold sentence (**Yes, it finished.**) is an answer and is read.
const VOICE_DETAIL_LINE_RE = /^[ \t]*(?:\||```|~~~|#{1,6}[ \t]|[-*+•◦▪‣][ \t]|\d+[.)][ \t]|([-*_])(?:[ \t]*\1){2,}[ \t]*$|(\*\*|__)[^*_\n]+(?::\2|\2[ \t]*:)[ \t]*$)/;
// A table's delimiter row, also without outer pipes (--- | ---); the line before it is the table's header.
const VOICE_TABLE_RULE_RE = /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/;
// voiceSpokenLead(markdown, done) -> { lead, cut }: the text before the first detail line; cut is true when such a line was found.
// While the reply streams (done false) the last line is still being typed: a detail-looking last line, or a line with a pipe whose next
// line has not arrived (it may be a table header), is held back (cut false, so nothing before it is taken as finished).
function voiceSpokenLead(markdown, done) {
  const text = String(markdown == null ? '' : markdown).replace(/\r\n?/g, '\n');
  const lines = text.split('\n'), last = lines.length - 1;
  const before = (i) => (i > 0 ? lines.slice(0, i).join('\n') + '\n' : '');
  // A line with a pipe keeps its text before the first pipe as lead text, read like text still being typed (openTail): its complete
  // sentences count, an unfinished last one does not. That is exactly the lead the line had before the pipe arrived, so a sentence
  // already spoken is never taken back, whether the line turns out to be prose or a table header (whose cells are never read).
  const pipeKeep = (i) => before(i) + lines[i].slice(0, lines[i].indexOf('|'));
  for (let i = 0; i < lines.length; i++) {
    const open = !done && i === last;
    if (VOICE_DETAIL_LINE_RE.test(lines[i]) || VOICE_TABLE_RULE_RE.test(lines[i])) return { lead: before(i), cut: !open };
    if (lines[i].includes('|')) {
      if (open || (!done && i + 1 === last)) return { lead: pipeKeep(i), cut: false };
      if (i + 1 <= last && VOICE_TABLE_RULE_RE.test(lines[i + 1])) return { lead: pipeKeep(i), cut: true, openTail: true };
    }
  }
  return { lead: text, cut: false };
}
function voiceReplySentences(markdown, done) {
  const note = voiceSpeechText('| a |');
  const sp = voiceSpokenLead(markdown, done);
  const finished = (!!done || sp.cut) && !sp.openTail;   // a cut lead is complete; an uncut reply may still be streaming; text before a table header's pipe is read as typed
  let lead = sp.lead;
  // While streaming, a last line that is only the start of a detail line (a lone marker, digits, an unclosed bold) is not lead text yet.
  if (!finished) lead = lead.replace(/(^|\n)[ \t]*(?:[-*+•◦▪‣`~#|_=]+|\d+[.)]?|(?:\*\*|__)[^\n]*)$/, '$1');
  let t = voiceSpeechText(lead, !finished), hasNote = sp.cut;
  if (t === note) { t = ''; hasNote = true; } else if (t.endsWith(' ' + note)) { t = t.slice(0, -note.length).trim(); hasNote = true; }
  let sentences = voiceSentences(t).filter(Boolean);
  if (!finished && sentences.length && !(/[.!?]["')\]]*$/.test(t) && /\s$/.test(lead))) sentences.pop();
  if (sentences.length > VOICE_LEAD_MAX_SENTENCES) { sentences = sentences.slice(0, VOICE_LEAD_MAX_SENTENCES); hasNote = true; }
  return { sentences, note: hasNote ? note : '' };
}
function voiceCreateCall(deps) {
  const d = deps || {};
  const ui = Object.assign({ state() {}, heard() {}, held() {}, toast() {}, summary() {}, level() {}, activity() {}, reply() {}, mic() {}, micLost() {} }, d.ui);   // ui.mic(info): the open microphone; ui.micLost(bool): it was lost / is back; ui.thinkingPulse(event) is optional; ui.reply(kind): 'start' | 'end' | 'drop' | 'resume' (a reply's boundaries, for the display's reaction)
  const server = d.server || {}, vad = d.vad || {};
  const now = () => d.now();
  const quiet = (fn) => { try { return fn(); } catch { return undefined; } };
  let state = '', mode = 'announce', ended = false, started = false, endPromise = null;
  let personSpeaking = false, speechEndAt = null, awaitingReply = false, cutSkip = false;
  let lastText = '', spokenCount = 0, noteSpoken = false, lastStatusAt = null;
  let queue = [], current = null, speaking = false, gen = 0;
  let heldList = [], announceQueue = [], pendingAnnounce = null, pendingAsk = null;
  let hbTimer = null, pumpTimer = null, sttChain = Promise.resolve();
  let callId = null, startP = null, sttPending = 0, speechAnn = null, cutRec = null, lastDone = false;
  // Joining pieces of one sentence: lastSeg is the latest speech segment (its transcript may still be pending), curCand the
  // earlier segment a new one may join, segActive that a segment has begun and has not ended.
  let lastSeg = null, curCand = null, segActive = false;
  // The one spoken line after a long wait: when something was last spoken, when the running turn began, whether a line was
  // said since, which lines this wait has used. The thinking sound: its 2 s timer and whether it is playing.
  let lastSpokenAt = null, turnAt = null, stillSaid = false, stillTimer = null, stillUsed = [];
  let thinkTimer = null, thinkingOn = false, thinkStep = 0, thinkT0 = 0, thinkDueAt = 0, thinkSeed = 0;
  let replyEnded = false;   // the whole reply of this turn was reported once (ui.reply('end'))
  // deps.keepAlive ({ start(), stop() }, optional): an inaudible sound that keeps a Bluetooth / car audio route awake. It starts with the call and
  // the first spoken line of the call waits until VOICE_CALL_LEAD_IN_MS after that (the route needs a moment to open, or the first syllable is lost).
  let leadInUntil = 0, keepAliveOn = false, micLost = false;
  let linkLost = false, linkWasLost = false;   // the connection to the server is lost (setLinkLost): speech is dropped, nothing is reported as an error
  // Outage count: each loss adds one. A piece of speech remembers the count when it began (-1 if the link was already lost); it is dropped when
  // that differs from the count when it is transcribed or sent, so nothing heard around an outage reaches the agent after the link is back.
  let linkGen = 0, segLinkGen = 0;
  const prefs = () => { const p = quiet(() => d.prefs && d.prefs()); return p && typeof p === 'object' ? p : {}; };
  // 'Wait for me to go on': how long a sentence that sounds unfinished waits for the next piece.
  const continueWait = () => { const n = Number(prefs().continueWait); return Number.isFinite(n) && n >= 0 ? n : VOICE_CALL_CONTINUE_MS; };

  // The thinking clock: ONE scheduler for what is heard and what is shown. When the person's turn was sent (and nothing is being
  // transcribed or asked) it starts: a small silent pulse at once (strength 0.35, visual only), the first full pulse VOICE_CALL_THINK_MS
  // later (2 s, the first audible one), then a quiet random pop cluster (lib/ui-voice-thinking.js: voiceThinkingCluster, seeded) about
  // every 1.5 s of pops + a 4-6 s gap (the gap is measured from the END of the cluster). Every pulse is one event (the contract is in
  // lib/ui-voice-thinking.js: at, kind, durationMs, pops [{ tMs, strength, freqHz, decayMs }], and the old swell fields attackMs, decayMs,
  // strength) handed to ui.thinkingPulse(event) (the call display's orb), and when the sound is on (thinkingSound not false; do-not-disturb never mutes it, with any display) to
  // thinking.pulse(event) as well; `at` is the performance.now() time (d.perfNow, else d.now) the audio is scheduled to start (+20 ms);
  // thinking.pulse(event) may move event.at to the time the pulse is really heard (audio output clock) before the picture gets it.
  // A thinking adapter without pulse() (older) is started with start() at the first audible pulse and runs its own interval.
  // The plan of a wait: variant 'A' (airy; the default build), 'B' (round bubble) or 'C' (sparse single pop), the seed and the gap
  // range come from deps.thinkingPlan { variant, seed, gapMinMs, gapSpreadMs } (a fixed seed makes a wait repeatable; no seed: a new random
  // one for each wait). No saved setting. Without voiceThinkingCluster (lib not loaded) the old single swell every 2.5 s is used.
  // Switching the sound off or on, or do-not-disturb, only changes what is audible: the clock and its phase go on. The clock stops
  // at once when the reply speaks, the person speaks, an announcement plays, the turn ends or the call ends.
  const perfNow = () => { const f = d.perfNow || d.now; return Number(f()); };
  // thinkVisual: a display really takes the pulses right now (ui.thinkingPulse exists and ui.thinkingWanted(), when the page has it, says
  // a view is shown). With NO display (None, hidden, ended) the clock is exactly the plain thinking sound of before: nothing is armed
  // when the sound is off, do-not-disturb does not mute it, switching it off ends the wait and switching it on starts a fresh 2 s one,
  // and the sound's own pulse() is called without an event.
  const thinkVisual = () => typeof (d.ui && d.ui.thinkingPulse) === 'function' && !(typeof d.ui.thinkingWanted === 'function' && !quiet(() => d.ui.thinkingWanted()));
  const thinkAudible = () => !!d.thinking && prefs().thinkingSound !== false;   // the same in every display (None, Orb, Character): do-not-disturb does not mute the sound
  function thinkQuiet() { return ended || !awaitingReply || sttPending || pendingAsk || speaking || personSpeaking || pendingAnnounce || queue.length; }
  function muteThinking() {   // the sound only; the clock stays
    if (!thinkingOn) return;
    thinkingOn = false;
    quiet(() => d.thinking.stop());
    if (!speaking) quiet(() => vad.setPlaybackActive(false));
  }
  function stopThinking() {
    if (thinkTimer !== null) { quiet(() => d.clearTimer(thinkTimer)); thinkTimer = null; }
    thinkStep = 0;
    muteThinking();
  }
  // Pulse 0 (the small silent one) happens at t0, pulse 1 at t0 + 2000, and every next one at the previous one's time + its
  // cluster length + its own gap (all on the controller's clock, so the audio mapping of event.at never makes it drift).
  const thinkPlan = (k) => {
    if (typeof voiceThinkingCluster !== 'function') return null;
    const tp = d.thinkingPlan || {};
    return quiet(() => voiceThinkingCluster({ seed: thinkSeed, index: k - 1, variant: tp.variant, gapMinMs: tp.gapMinMs, gapSpreadMs: tp.gapSpreadMs })) || null;
  };
  function thinkTick() {
    thinkTimer = null;
    if (thinkQuiet()) { stopThinking(); return; }
    const k = thinkStep++, vis = thinkVisual();
    const plan = k > 0 ? thinkPlan(k) : null;
    const ev = plan ? voiceThinkingEvent(plan, perfNow() + 20)
      : { at: perfNow() + 20, kind: k === 0 ? 'tick' : 'cluster', pops: [], attackMs: 250, decayMs: 1000, strength: k === 0 ? 0.35 : 1 };
    thinkDueAt = k === 0 ? thinkT0 + VOICE_CALL_THINK_MS : thinkDueAt + (plan ? plan.durationMs + plan.gapAfterMs : 2500);
    if (k > 0 && thinkAudible()) {
      if (!thinkingOn) {
        thinkingOn = true;
        quiet(() => vad.setPlaybackActive(true));   // the pulse is playback: it must not trigger the barge-in detector
        if (typeof d.thinking.pulse !== 'function') quiet(() => d.thinking.start());
      }
      if (!vis) { if (typeof d.thinking.pulse === 'function') quiet(() => d.thinking.pulse()); }   // no display: the plain sound, no event
      else if (typeof d.thinking.pulse === 'function') {
        // The sound schedules the pulse once on the audio clock and moves ev.at to when it is heard (it mutates ev or returns one);
        // the picture then gets the same event. A sound that did not play (false) leaves the controller's clock and is not audible.
        const at0 = ev.at, r = quiet(() => d.thinking.pulse(ev));
        if (r && typeof r === 'object' && r !== ev && Number.isFinite(Number(r.at))) ev.at = Number(r.at);
        const now = perfNow();
        if (!Number.isFinite(ev.at) || ev.at < now - 100 || ev.at > now + 2000) ev.at = at0;   // never a stale or wild time
        if (r === false) muteThinking();
      }
    } else muteThinking();
    if (vis) quiet(() => ui.thinkingPulse(ev));
    if (thinkTimer === null && !ended) thinkTimer = d.setTimer(thinkTick, Math.max(0, thinkDueAt - perfNow()));
  }
  function armThinking() {
    if (ended || thinkTimer !== null || thinkStep > 0 || !awaitingReply || sttPending || pendingAsk || (!thinkVisual() && !thinkAudible())) return;
    thinkT0 = perfNow();
    const sd = Number(d.thinkingPlan && d.thinkingPlan.seed);
    thinkSeed = Number.isFinite(sd) ? sd : Math.floor(Math.random() * 4294967296);
    thinkTick();
  }
  // The person's settings changed (the in-chat voice panel): re-read them now. Muting stops the sound, not the clock.
  function setPrefs() {
    const p = prefs();
    if (!thinkVisual() && !thinkAudible()) stopThinking();   // no display: the sound switched off ends the wait (a fresh one starts when it is on again)
    else if (!thinkAudible()) muteThinking();
    armThinking();
    if (d.thinking && d.thinking.setVolume && Number.isFinite(Number(p.thinkingVolume))) quiet(() => d.thinking.setVolume(Math.max(0, Math.min(1, Number(p.thinkingVolume)))));
  }

  function clearStill() { if (stillTimer !== null) { quiet(() => d.clearTimer(stillTimer)); stillTimer = null; } }
  // One spoken line (VOICE_THINKING_LINES) when a turn runs and nothing was said for 20 s; not again until something else is said.
  function armStill() {
    if (ended || stillTimer !== null || stillSaid || !awaitingReply) return;
    const since = Math.max(lastSpokenAt === null ? -Infinity : lastSpokenAt, turnAt === null ? -Infinity : turnAt);
    const wait = Number.isFinite(since) ? Math.max(200, VOICE_CALL_STILL_MS - (now() - since)) : VOICE_CALL_STILL_MS;
    stillTimer = d.setTimer(checkStill, wait);
  }
  function checkStill() {
    stillTimer = null;
    if (ended || stillSaid || !awaitingReply) return;
    if (speaking || personSpeaking || sttPending || pendingAsk || pendingAnnounce || queue.length) return;   // settle() arms it again when it is quiet
    const since = Math.max(lastSpokenAt === null ? -Infinity : lastSpokenAt, turnAt === null ? -Infinity : turnAt);
    if (Number.isFinite(since) && now() - since < VOICE_CALL_STILL_MS) { armStill(); return; }
    stillSaid = true;
    let fresh = VOICE_THINKING_LINES.filter(l => !stillUsed.includes(l));
    if (!fresh.length) { stillUsed = []; fresh = VOICE_THINKING_LINES; }
    const line = fresh[0]; stillUsed.push(line);   // never the same line twice in one wait
    enqueue(line, 'still');
  }
  // Standby (deps.wake(), optional): { phrase, quietMs, local } while the person has the wake phrase on, else null (switched off).
  // local is true only when speech is known to be recognized on this computer. Standby shows state 'standby' (ui.state gets the
  // phrase as its second argument), drops everything said that does not start with the phrase and is left again when the phrase is
  // heard; an awake call that stays quiet for quietMs goes back to standby. Wake mode starts only with local true, and once on it fails
  // closed: if local turns false the call stays in (or returns to) standby and nothing heard there is even transcribed. Only the
  // person switching it off (wake() -> null) makes it an ordinary call. Without deps.wake nothing here acts.
  const wake = () => { if (!d.wake) return null; const w = quiet(() => d.wake()); return w && typeof w === 'object' ? w : null; };
  const wakePhrase = () => { const w = wake(); return w && typeof w.phrase === 'string' ? w.phrase : ''; };
  let standby = false, wakeMode = false, wakeSeq = 0, quietTimer = null, chimeTimer = null, statePhrase = '';
  let capWake = null, heardShown = false;   // heardShown: a 'Heard' line is on screen (cleared when the call goes back to standby)   // { sb, seq } taken when the person starts to speak: what counts is whether the call was in standby then
  const wakeIdle = () => !awaitingReply && !speaking && !personSpeaking && !sttPending && !queue.length && !current && !pendingAsk && !pendingAnnounce;
  function clearQuiet() { if (quietTimer !== null) { quiet(() => d.clearTimer(quietTimer)); quietTimer = null; } }
  function enterStandby() {
    if (ended) return;
    standby = true; clearQuiet(); stopThinking();
    if (heardShown) { heardShown = false; quiet(() => ui.heard('')); }   // the last message does not stay on screen while waiting
    if (!speaking) setState('standby');
  }
  function leaveStandby() { standby = false; clearQuiet(); settle(); }
  function setState(name) {
    const phrase = name === 'standby' ? wakePhrase() : '';
    if (name === state && phrase === statePhrase) return;   // (the phrase of a standby can change with the setting)
    state = name; statePhrase = phrase; quiet(() => ui.state(name, phrase));
  }
  function armQuiet() {
    const w = wake();
    if (!wakeMode || standby || state !== 'listening' || !wakeIdle()) { clearQuiet(); return; }
    if (quietTimer !== null) return;
    const ms = w && VOICE_WAKE_QUIET_MS.includes(w.quietMs) ? w.quietMs : 20000;
    quietTimer = d.setTimer(() => {
      quietTimer = null;
      if (ended) return;
      if (wakeMode && !standby && wakeIdle()) enterStandby(); else settle();
    }, ms);
  }
  function settle() {
    if (ended) return;
    if (!speaking && !personSpeaking && queue.length) { clearQuiet(); runQueue(); return; }   // lines that waited while the person spoke are read now
    setState(speaking ? 'speaking' : standby ? 'standby' : personSpeaking ? 'hearing' : awaitingReply ? 'thinking' : 'listening');
    armQuiet();
    pumpAnnounce();
    armStill();
    if (awaitingReply && !speaking && !personSpeaking && !standby) armThinking();   // a long quiet stretch inside a running turn gets the sound too
  }
  function runAfter(item) { if (item && item.after) { const f = item.after; item.after = null; quiet(f); } }
  function enqueue(text, kind, after, onStart) {
    if (ended || !text) return;
    queue.push({ text, kind, after, onStart });
    if (!speaking && !personSpeaking) runQueue();   // never start reading while the person is speaking: the line waits
  }
  async function runQueue() {
    const my = gen;
    speaking = true; stopThinking(); setState('speaking'); quiet(() => vad.setPlaybackActive(true));
    const lead = leadInUntil; leadInUntil = 0;   // only before the first speak of the call
    if (lead && now() < lead) {
      await new Promise((resolve) => { d.setTimer(resolve, lead - now()); });
      if (my !== gen) return;
    }
    while (queue.length && my === gen && !personSpeaking) {
      current = queue.shift();
      if (current.onStart) { const f = current.onStart; current.onStart = null; quiet(f); }   // the line really starts playing
      let ok = true;
      lastSpokenAt = now();
      try { ok = await d.speak(current.text); } catch { ok = false; }
      if (my !== gen) return;
      const item = current; current = null;
      lastSpokenAt = now();
      if (item.kind !== 'still') stillSaid = false;   // something new was said: the next long silence may be filled again
      if (ok === false) {
        // A failed or cut line drops what waits behind it, except a microphone line ('mic': lost / back / switched), which is
        // tried ONCE more: sending the person's last words stops playback, and that must not swallow "I lost the microphone".
        // Only the line that was cut uses up its retry; mic lines still waiting keep theirs (each gets at most two real attempts).
        const retryItem = item.kind === 'mic' && !item.retried;
        const keep = (retryItem ? [item] : []).concat(queue.filter(q => q.kind === 'mic'));
        for (const q of queue) if (!keep.includes(q)) runAfter(q);
        if (retryItem) item.retried = true;
        queue = keep;
        if (retryItem) continue;   // its after() runs when it is really done
      }
      runAfter(item);
    }
    if (my !== gen) return;
    speaking = false; quiet(() => vad.setPlaybackActive(false));
    maybeReplyEnd();
    settle();
  }
  // Cuts what is being read at once. True when part of a reply was cut (the rest of that reply is then skipped).
  // byPerson: the person's real speech cut it, so the thresholds drop at once (no echo hold-over over their own words), and the
  // microphone lines ('mic': lost / back / switched) are kept: they are about the call, not the reply, and are said when the person
  // stops (the words that cut them may be the last ones heard before the microphone went).
  function cancelSpeaking(byPerson) {
    const items = (current ? [current] : []).concat(queue);
    const hadReply = items.some(i => i.kind === 'reply');
    // a mic line that was PLAYING when cut is kept once (it is not replayed on every barge-in); waiting ones are kept as they are
    const keep = byPerson ? items.filter(i => i.kind === 'mic' && !(i === current && i.retried)) : [];
    if (current && keep.includes(current)) current.retried = true;
    gen++; queue = keep; current = null;
    if (speaking) { speaking = false; quiet(() => vad.setPlaybackActive(false, !!byPerson)); }
    quiet(() => d.cancelSpeech());
    items.filter(i => !keep.includes(i)).forEach(runAfter);
    return hadReply;
  }

  function completeCount() { return voiceReplySentences(lastText, false).sentences.length; }
  // The whole reply is over, reported ONCE (ui.reply('end')) for the display's reaction: its text is complete AND nothing is read or waiting to be
  // read (so a gap between two sentences of a growing reply is not the end) AND the person is not speaking. With no speech (voice off, a failed
  // line) that is the moment the text is complete; otherwise right after the last line ended, before the call returns to listening.
  function maybeReplyEnd() {
    if (ended || replyEnded || !lastDone || awaitingReply || cutSkip || speaking || personSpeaking || current || queue.length) return;
    replyEnded = true;
    quiet(() => ui.reply('end'));
  }
  // Reply text so far (markdown) and whether the turn is over: speaks the complete sentences that are new.
  function onReplyText(full, done) {
    if (ended) return;
    lastText = String(full == null ? '' : full); lastDone = !!done;
    if (!done && !awaitingReply && !cutSkip) { awaitingReply = true; replyEnded = false; }
    const r = voiceReplySentences(lastText, !!done);
    if (r.sentences.length < spokenCount) spokenCount = 0;
    if (cutSkip) spokenCount = r.sentences.length;
    else { for (const s of r.sentences.slice(spokenCount)) enqueue(s, 'reply'); spokenCount = r.sentences.length; }
    if (done) {
      if (!cutSkip && r.note && !noteSpoken) enqueue(r.note, 'reply');
      noteSpoken = true; awaitingReply = false;
      clearStill(); stopThinking(); quiet(() => ui.activity(''));
      if (!speaking) { maybeReplyEnd(); settle(); }
    }
  }
  // A tool activity of the running turn: shown silently (ui.activity); spoken only when the page's speakActivity() says so.
  function onActivity(item) {
    if (ended) return;
    if (!awaitingReply && !quiet(() => d.isTurnRunning())) return;
    quiet(() => ui.activity(voiceStatusLine(item)));
    if (state !== 'thinking' || speaking || personSpeaking || pendingAsk || pendingAnnounce) return;
    if (!quiet(() => d.speakActivity && d.speakActivity())) return;
    if (lastStatusAt !== null && now() - lastStatusAt < VOICE_CALL_STATUS_GAP_MS) return;
    lastStatusAt = now();
    enqueue(voiceStatusLine(item), 'status');
  }

  function onAsk(ask) {
    if (ended || !ask) return;
    const options = Array.from(ask.options || []).map(o => (typeof o === 'string' ? o : (o && (o.label || o.value || o.text)) || '')).filter(Boolean);
    pendingAsk = { id: ask.request_id, options, free: !options.length || ask.allow_free_text === true || ask.allow_other === true, reasked: false, tapped: false };
    if (standby && wake() && wake().local === true) { standby = false; clearQuiet(); }   // the agent asks: the answer is listened for without the phrase (talk from before the question is still dropped)
    enqueue(String(ask.question || '') + (options.length ? ' Options: ' + voiceJoinOr(options) + '.' : ''), 'ask');
  }
  function onAskDone(id) { if (pendingAsk && (id == null || pendingAsk.id === id)) pendingAsk = null; }

  function showHeld() { quiet(() => ui.held(heldList.map(h => Object.assign({}, h)))); }
  function onHeld(item, quietFlag) {
    if (ended || !item || heldList.some(h => h.id === item.id)) return;
    const entry = Object.assign({}, item, { later: false, announced: false });
    heldList.push(entry); showHeld();
    if (!quietFlag && mode === 'announce') { announceQueue.push(entry); pumpAnnounce(); }
  }
  // The hub says an item was decided. 'later' keeps it (deferred: shown with "later", buttons stay, not announced again);
  // 'now' and 'skip' (or no choice) remove it.
  function onHeldDone(id, choice) {
    announceQueue = announceQueue.filter(h => h.id !== id);
    if (pendingAnnounce && pendingAnnounce.id === id) { quiet(() => d.clearTimer(pendingAnnounce.timer)); pendingAnnounce = null; }
    if (choice === 'later') { const e = heldList.find(h => h.id === id); if (e) { e.later = true; e.announced = true; } }
    else heldList = heldList.filter(h => h.id !== id);
    showHeld(); settle();
  }
  // The hub's list of held items (the start answer, every heartbeat answer): merged by id, a known item keeps its state.
  function hydrate(list) {
    if (ended || !Array.isArray(list)) return;
    let changed = false;
    for (const item of list) {
      if (!item || item.id == null) continue;
      const known = heldList.find(h => h.id === item.id);
      // 'allowed': the person said now and the producer runs it; 'done': it ran. Neither waits for a decision any more.
      if (item.state === 'done' || item.state === 'allowed') {
        if (known) { heldList = heldList.filter(h => h !== known); announceQueue = announceQueue.filter(h => h !== known); changed = true; }
        // decided elsewhere (another device, an admin) while it was being asked: the question is over, the next one may come
        if (pendingAnnounce && pendingAnnounce.id === item.id) { if (pendingAnnounce.timer !== null) quiet(() => d.clearTimer(pendingAnnounce.timer)); pendingAnnounce = null; changed = true; }
        continue;
      }
      if (known) { if (item.state === 'later' && !known.later) { known.later = true; known.announced = true; changed = true; } continue; }
      const later = item.state === 'later';
      const entry = Object.assign({}, item, { later, announced: later });
      heldList.push(entry); changed = true;
      if (!later && mode === 'announce') announceQueue.push(entry);
    }
    if (changed) { showHeld(); pumpAnnounce(); }
  }
  function decide(id, choice) {
    const entry = heldList.find(h => h.id === id);
    if (!entry || !['now', 'later', 'skip'].includes(choice)) return;
    announceQueue = announceQueue.filter(h => h.id !== id);
    if (pendingAnnounce && pendingAnnounce.id === id) { quiet(() => d.clearTimer(pendingAnnounce.timer)); pendingAnnounce = null; }
    if (choice === 'later') entry.later = true; else heldList = heldList.filter(h => h.id !== id);
    showHeld();
    const failed = () => { if (!linkLost) quiet(() => ui.toast('Could not send that choice.')); };
    try { Promise.resolve(server.decide(id, choice, callId)).catch(failed); } catch { failed(); }
    settle();
  }
  function pumpAnnounce() {
    if (pumpTimer !== null) { quiet(() => d.clearTimer(pumpTimer)); pumpTimer = null; }
    if (ended || state !== 'listening' || speaking || personSpeaking || sttPending || pendingAsk || pendingAnnounce || !announceQueue.length) return;
    const wait = speechEndAt === null ? 0 : VOICE_CALL_PAUSE_MS - (now() - speechEndAt);
    if (wait > 0) { pumpTimer = d.setTimer(() => { pumpTimer = null; pumpAnnounce(); }, wait); return; }
    const item = announceQueue.shift();
    item.announced = true;
    const me = { id: item.id, timer: null, heard: false };
    pendingAnnounce = me;
    const start = () => {
      if (pendingAnnounce !== me) return;
      me.timer = d.setTimer(() => { if (pendingAnnounce === me) decide(me.id, 'later'); }, VOICE_CALL_ANSWER_MS);
    };
    enqueue(String(item.label || 'Something came in').replace(/[.!?\s]+$/, '') + '. Now, or after we\'re done?', 'announce', start, () => { me.heard = true; });
  }
  function setMode(m) {
    if (m !== 'announce' && m !== 'dnd') return;
    mode = m;   // the thinking sound is not touched: do-not-disturb holds announcements, not the thinking sound
    if (m === 'dnd') announceQueue = [];
    else announceQueue = heldList.filter(h => !h.later && !h.announced && !(pendingAnnounce && pendingAnnounce.id === h.id));
    quiet(() => Promise.resolve(server.mode(m, callId)).catch(() => {}));
    pumpAnnounce();
  }

  // The first speech-like frame (vad-web onSpeechStart): the person may be starting to talk. Nothing new is started over
  // them, and an answer belongs to the announcement that was pending at this moment. A false start ends in onMisfire.
  // An answer belongs to an announcement only once its line started playing (talking over it to answer is fine) or was
  // read out (its answer timer runs from then); a line still waiting in the queue was not heard yet.
  const heardAnnouncement = () => (pendingAnnounce && pendingAnnounce.heard ? pendingAnnounce.id : null);   // heard: its line started playing
  // A first frame that is followed by nothing (the audio stopped: an incoming phone call, a suspended audio context)
  // must not leave the call deaf and mute: after 4 s without real speech, a misfire or an end, it is let go.
  let beginTimer = null;
  const clearBegin = () => { if (beginTimer !== null) { quiet(() => d.clearTimer(beginTimer)); beginTimer = null; } };
  // A new speech segment begins. When the previous one ended less than 2 s ago and its transcript is not sent yet (still
  // being transcribed, or waiting in line), the previous one is held back: it is joined with this segment into one message.
  function segmentStarting() {
    if (segActive) return;
    segActive = true;
    const c = lastSeg;
    // The earlier piece qualifies while its text is not sent yet (its transcript pending, held, or in the continue wait): one chain,
    // in order, however slow the transcription is, so a later stop word still wins over it.
    if (c && !c.done && !c.hold) {
      let resolve; const promise = new Promise((r) => { resolve = r; });
      c.hold = { promise, resolve }; curCand = c;
      if (c.onJoin) { const f = c.onJoin; c.onJoin = null; quiet(f); }   // the wait for more is over: the next piece is coming
    } else curCand = null;
  }
  // The segment was a false start: the held one is sent on its own after all.
  function segmentDropped() {
    segActive = false;
    const c = curCand; curCand = null;
    if (c && c.hold) { c.hold.resolve(null); c.hold = null; }
  }
  function onSpeechBegin() {
    if (ended || personSpeaking) return;
    personSpeaking = true; stopThinking(); clearQuiet();
    capWake = { sb: standby, seq: wakeSeq };
    speechAnn = heardAnnouncement();
    segLinkGen = linkLost ? -1 : linkGen;
    clearBegin();
    segmentStarting();
    // Real speech, a misfire and an end all clear this timer, so when it fires no real start came: let the false start go.
    beginTimer = d.setTimer(() => { beginTimer = null; if (!ended && personSpeaking) { personSpeaking = false; speechAnn = null; capWake = null; segmentDropped(); settle(); } }, 4000);
  }
  // Real speech began (the VAD adapter calls this from onSpeechRealStart, so a cough or a click does not cut the reading).
  function onSpeechStart() {
    if (ended) return;
    clearBegin();
    if (!personSpeaking) { speechAnn = heardAnnouncement(); segLinkGen = linkLost ? -1 : linkGen; }   // no onSpeechBegin came first
    if (!personSpeaking || !capWake) capWake = { sb: standby, seq: wakeSeq };
    personSpeaking = true; stopThinking(); clearQuiet();
    quiet(() => ui.reply('drop'));   // real speech: a reaction that has not played is dropped
    segmentStarting();
    if (!standby && (speaking || queue.length)) {   // in standby a sound does not cut the reading ("<phrase>, stop" does, once heard)
      const noteText = voiceSpeechText('| a |');   // the details note is a reply item but not one of the counted sentences
      const items = (current ? [current] : []).concat(queue);
      const n = items.filter(i => i.kind === 'reply' && i.text !== noteText).length;
      const noteCut = items.some(i => i.kind === 'reply' && i.text === noteText);   // a false start puts the note back too
      const cutReply = cancelSpeaking(true);
      const setSkip = cutReply && awaitingReply && !cutSkip;
      if (setSkip) cutSkip = true;
      if (cutReply) cutRec = { mark: Math.max(0, spokenCount - n), setSkip, noteCut };   // a cut of mic lines only keeps an earlier reply cut to resume
    }
    if (!standby) setState('hearing');   // in standby the person is not addressed until the phrase
  }
  // The VAD heard no real speech after all (a false start): the person is not speaking, and a reply that was cut by it is read on.
  function onMisfire() {
    if (ended) return;
    clearBegin(); segmentDropped();
    personSpeaking = false; speechAnn = null; capWake = null;
    quiet(() => ui.reply('resume'));
    const rec = cutRec; cutRec = null;
    if (rec) {
      if (rec.setSkip) cutSkip = false;
      spokenCount = rec.mark;
      if (rec.noteCut) noteSpoken = false;
      onReplyText(lastText, lastDone);
    }
    settle();
  }
  // Text decides; the optional end-of-turn model (deps.turnModel, audio -> probability finished, or null) can only add doubt:
  // a text that sounds finished is sent when the model says finished or is unsure, and waits when the model says it is not.
  async function soundsUnfinished(text, audio) {
    if (voiceSoundsUnfinished(text)) return true;
    if (!d.turnModel) return false;
    let p = null;
    try { p = await d.turnModel(audio); } catch { p = null; }
    return typeof p === 'number' && Number.isFinite(p) && p < 0.35;
  }
  function onSpeechEnd(audio) {
    if (ended) return Promise.resolve();
    clearBegin();
    personSpeaking = false; speechEndAt = now(); cutRec = null;
    // sb and seq: was this said in standby (when it began, or now), and how many wakes had there been. Said in standby, it needs the phrase unless a wake came
    // in between (the phrase said alone, then this): so neither a switch-off nor a lost recognizer check can release it.
    const cap = capWake || { sb: standby, seq: wakeSeq }; capWake = null;
    const mine = { endAt: now(), ann: speechAnn, carry: '', done: false, hold: null, waiting: false, onJoin: null, sb: cap.sb || standby, seq: cap.seq,
      linkGen: segLinkGen === linkGen && !linkLost ? linkGen : -1 };
    const stale = () => linkLost || mine.linkGen !== linkGen;   // heard while the link was lost, or an outage began since: never sent
    speechAnn = null; segActive = false;
    const cand = curCand; curCand = null;
    if (cand && cand.hold) cand.hold.resolve(mine);   // the earlier piece hands its text to this one
    lastSeg = mine;
    sttPending++;
    settle();
    sttChain = sttChain.then(async () => {
      let counted = false;
      try {
        let text = '', failed = false;
        const mustMatch = () => standby || (mine.sb && mine.seq === wakeSeq);
        const w0 = wake();
        if (mustMatch() && !(w0 && w0.local === true)) return;   // standby without a recognizer known to be local: not even transcribed
        const dropLong = mustMatch() && !!audio && audio.length > 30 * 16000;   // a long stretch of talk in standby is not transcribed at all
        try { text = dropLong || stale() ? '' : await d.stt(audio); } catch { failed = true; if (!mustMatch() && !linkLost) quiet(() => ui.toast('Could not transcribe that.')); }
        if (ended || stale()) return;   // heard around an outage: dropped, not sent (also when the link came back while this waited)
        const own = String(text || '').trim(), n = voiceCallNorm(own);
        const ownOk = !failed && !(n.length < 2 || n.split(' ').every(w => VOICE_CALL_FILLERS.has(w)));
        let t = ownOk ? own : '';
        if (mine.carry) t = ownOk ? (voiceIsStopCommand(own) || (wakeMode && voiceIsSleepCommand(own)) ? own : mine.carry + ' ' + own) : mine.carry;   // a stop or sleep command in this piece wins over the earlier one
        if (!t) return;
        if (mustMatch()) {   // only the wake phrase is listened for: anything else is dropped (not shown, not sent, nothing kept)
          const w = wake();
          if (!(w && w.local === true)) return;   // switched off, or the check failed, while this was waiting: what was said in standby stays dropped
          const m = voiceWakeMatch(t, w.phrase);
          if (!m.match) return;
          standby = false; wakeSeq++;
          quiet(() => d.chime && d.chime());
          quiet(() => vad.setPlaybackActive(true));   // the chime is playback: it must not be taken as speech
          if (chimeTimer !== null) quiet(() => d.clearTimer(chimeTimer));
          chimeTimer = d.setTimer(() => { chimeTimer = null; if (!ended && !speaking) quiet(() => vad.setPlaybackActive(false)); }, 700);
          if (!m.rest) { settle(); return; }   // the next utterance is the message
          t = m.rest;
        }
        const sleepy = wakeMode && voiceIsSleepCommand(t);
        if (sleepy) { mine.done = true; enterStandby(); return; }   // 'that's all': back to standby at once, not shown, not sent, never joined to what follows
        // Does it sound unfinished? Then it is not sent yet: it waits up to the 'Wait for me to go on' time for the next piece,
        // which takes this text along. Not for a stop command, an answer to a question or an announcement, or when the wait is 0.
        let waited = false, waitStart = 0, ms = 0;
        const waitMore = async (len) => {
          mine.waiting = true;
          let waitTimer = null;
          await new Promise((resolve) => { mine.onJoin = resolve; waitTimer = d.setTimer(resolve, len); });
          if (waitTimer !== null) quiet(() => d.clearTimer(waitTimer));
          mine.waiting = false; mine.onJoin = null;
        };
        if (!mine.hold && !ended && !voiceIsStopCommand(t) && !sleepy && !pendingAsk && mine.ann == null && !pendingAnnounce) {
          ms = continueWait();
          if (ms > 0 && await soundsUnfinished(t, audio)) {
            waited = true; waitStart = now();
            await waitMore(ms);
            if (ended) return;
          }
        }
        // A later piece started (within 2 s, or while this one waited): it takes this text along (unless this one is a stop command: stop wins at once).
        while (mine.hold && !voiceIsStopCommand(t)) {
          // At most 5 s (20 s after a wait for more, which a long next piece may need): a later piece whose end never comes
          // (audio interrupted) must not block this text and every one after it.
          let holdTimer = null, timedOut = false;
          const next = await Promise.race([mine.hold.promise, new Promise((r) => { holdTimer = d.setTimer(() => { timedOut = true; r(null); }, waited ? VOICE_CALL_WAIT_HOLD_MS : VOICE_CALL_HOLD_MS); })]);
          if (holdTimer !== null) quiet(() => d.clearTimer(holdTimer));
          if (ended || stale()) return;
          if (next) { next.carry = t; if (next.ann == null) next.ann = mine.ann; return; }
          if (timedOut || !waited) break;
          // A misfire (cough, click) ended the wait early: the rest of the wait goes on.
          const left = ms - (now() - waitStart);
          if (left <= 0) break;
          await waitMore(left);
          if (ended) return;
        }
        if (stale()) return;
        mine.done = true;
        heardShown = true; quiet(() => ui.heard(t));
        sttPending--; counted = true;   // the transcript is out of the queue: the thinking sound may arm while the turn runs
        await route(t, mine.ann);
      } finally { mine.done = true; if (!counted) sttPending--; settle(); }
    });
    return sttChain;
  }
  async function route(t, ann) {
    if (voiceIsStopCommand(t)) {
      cancelSpeaking(); cutSkip = true; awaitingReply = false; stopThinking(); clearStill();
      quiet(() => d.stop()); enqueue('Stopped.', 'stop'); settle();
      return;
    }
    if (pendingAnnounce && ann != null && pendingAnnounce.id === ann) {   // only the announcement pending when the speech began
      const id = pendingAnnounce.id, w = voiceDecisionWord(t);
      decide(id, w || 'later');
      if (w) return;
    }
    if (pendingAsk) {
      const a = pendingAsk, label = voiceMatchChoice(t, a.options);
      if (label !== null || a.free) { pendingAsk = null; quiet(() => d.answerAsk(a.id, label !== null ? label : t)); return; }
      if (!a.reasked) { a.reasked = true; enqueue('Please say one of: ' + voiceJoinOr(a.options) + '.', 'ask'); }
      else if (!a.tapped) { a.tapped = true; enqueue('Please tap one of the options on the screen.', 'ask'); }
      return;
    }
    try {
      if (quiet(() => d.isTurnRunning())) {
        if (cutSkip) { cutSkip = false; spokenCount = completeCount(); }
        awaitingReply = true; replyEnded = false; turnAt = now(); stillSaid = false; quiet(() => ui.reply('start')); setState('thinking'); armStill(); armThinking();
        await d.interject(t);
      } else {
        awaitingReply = true; replyEnded = false; cutSkip = false; spokenCount = 0; noteSpoken = false; lastText = ''; lastDone = false; turnAt = now(); stillSaid = false; stillUsed = [];
        quiet(() => ui.reply('start')); setState('thinking'); armStill(); armThinking();
        await d.send(t);
      }
    } catch {
      awaitingReply = false; clearStill(); stopThinking(); quiet(() => ui.activity(''));
      if (!linkLost) { quiet(() => ui.toast('Could not send that.')); enqueue('That did not go through.', 'status'); }   // a lost connection is reported by the link watch, not as an error line
      settle();
    }
  }
  // The connection to the server was lost (on) or is back (!on). While lost, what is heard is dropped and no error is spoken or shown;
  // when it is back after a real outage, "Reconnected." is spoken (kind 'mic': a barge-in does not drop it).
  function setLinkLost(on) {
    if (ended) return;
    if (on) { if (!linkLost) linkGen++; linkLost = true; linkWasLost = true; return; }
    if (!linkLost) return;
    linkLost = false;
    if (linkWasLost) { linkWasLost = false; enqueue('Reconnected.', 'mic'); }
  }

  // The microphone (from the VAD adapter): onMicInfo shows which one is open; onMicChange says a reopen after the microphone ended or
  // changed (Bluetooth connected or dropped, a car started) worked or failed. A lost microphone does not end the call: the heartbeat, held
  // items and the reading of replies go on, and a tap (retryMic) tries again. Nothing is retried on its own.
  function onMicInfo(info) { if (!ended) quiet(() => ui.mic(info)); }
  function onMicChange(ev) {
    if (ended || !ev) return;
    if (ev.ok === false) {
      if (micLost) return;   // already said: a burst of device events while it is lost is not announced again
      micLost = true; quiet(() => ui.micLost(true));
      enqueue(VOICE_MIC_LOST_LINE, 'mic');
      return;
    }
    if (micLost) {
      micLost = false; quiet(() => ui.micLost(false));
      queue = queue.filter(q => !(q.kind === 'mic' && q.text === VOICE_MIC_LOST_LINE));   // a lost line still waiting is no longer true
      enqueue('The microphone is back.', 'mic'); return;
    }
    if (ev.changed) enqueue('I\'ve switched microphones.', 'mic');
  }
  // Tries to open the microphone again (the answer arrives through onMicChange); the promise says whether it worked.
  function retryMic() {
    if (ended || typeof vad.reopen !== 'function') return Promise.resolve(false);
    try { return Promise.resolve(vad.reopen()).then((r) => !!r, () => false); } catch { return Promise.resolve(false); }
  }

  function beat() {
    hbTimer = d.setTimer(() => {
      hbTimer = null;
      if (ended) return;
      Promise.resolve().then(() => server.heartbeat(callId)).then((r) => { if (!ended && r) hydrate(r.held); }).catch(() => {});
      beat();
    }, VOICE_CALL_HEARTBEAT_MS);
  }
  async function start() {
    if (started) return !ended;
    started = true; setState('starting');
    if (d.keepAlive) { keepAliveOn = true; quiet(() => d.keepAlive.start()); leadInUntil = now() + VOICE_CALL_LEAD_IN_MS; }   // inside the tap, before anything is awaited
    const fail = async (msg) => { quiet(() => ui.toast(msg)); teardown(); await Promise.resolve().then(() => (callId ? server.end(callId) : null)).catch(() => {}); return false; };   // no id: never end another call of this person
    // Standby is decided before the microphone opens, so nothing said while the call starts gets past it.
    const w0 = wake();
    wakeMode = !!(w0 && w0.local === true); standby = wakeMode;
    if (w0 && !wakeMode) quiet(() => ui.toast('The wake phrase is not in use on this call: speech recognition is not known to run on this computer.'));
    // The microphone starts first, still inside the tap that began the call (iOS needs that for audio); the server next.
    let vadErr = null;
    let vadStarting;
    try {
      vadStarting = Promise.resolve(vad.start({
        onSpeechBegin, onSpeechStart, onMisfire, onSpeechEnd,
        onFrame: (db, probs) => quiet(() => ui.level(db, probs)),
        onMicInfo, onMicChange,
      })).catch((e) => { vadErr = e || new Error('no microphone'); });
    } catch (e) { vadErr = e || new Error('no microphone'); vadStarting = Promise.resolve(); }
    // The call's id comes with the answer; a hang-up while the server is still starting ends that call once the id is known.
    startP = (async () => server.start(mode))().then((r) => { if (r && r.callId) callId = r.callId; return r; });
    let startRes;
    try { startRes = await startP; } catch (e) { await vadStarting; quiet(() => vad.stop()); return fail('Could not start the call: ' + (e && e.message || e)); }
    await vadStarting;
    if (ended) { quiet(() => vad.stop()); return false; }   // hung up while starting: a microphone that came up late is let go
    if (vadErr) return fail('Could not start the microphone: ' + (vadErr.message || vadErr));
    hydrate(startRes && startRes.held);
    beat();
    if (!wake()) { wakeMode = false; standby = false; }   // switched off while the call started (wakeChanged waits for the start)
    if (standby) enterStandby();   // (a phrase heard while the call started has already woken it)
    settle();
    return true;
  }
  // Everything the call holds is let go at once: timers, the thinking sound, the microphone and the speaking.
  function teardown() {
    ended = true; capWake = null;
    for (const t of [hbTimer, pumpTimer, quietTimer, chimeTimer, pendingAnnounce && pendingAnnounce.timer]) if (t) quiet(() => d.clearTimer(t));
    hbTimer = pumpTimer = quietTimer = chimeTimer = null; pendingAnnounce = null; pendingAsk = null; announceQueue = []; clearBegin(); clearStill(); stopThinking();
    for (const s of [lastSeg, curCand]) if (s) { if (s.hold) s.hold.resolve(null); if (s.onJoin) { const f = s.onJoin; s.onJoin = null; quiet(f); } }   // a held or waiting transcript is let go with the call
    quiet(() => vad.stop()); cancelSpeaking(); setState('ended');
    if (keepAliveOn) { keepAliveOn = false; quiet(() => d.keepAlive.stop()); }
  }
  // Immediate hang-up, for a page that is being hidden, frozen or closed (reason: 'hidden', 'pagehide', 'freeze', ...): everything is
  // released now and the server is told in the background; nothing is waited for and nothing is read out.
  function release(reason) {
    if (endPromise) return endPromise;
    teardown();
    const tell = () => { if (callId) quiet(() => Promise.resolve(server.end(callId)).catch(() => {})); };
    if (callId || !startP) tell(); else startP.then(tell, () => {});   // the id may still be on its way
    endPromise = Promise.resolve([]);
    return endPromise;
  }
  // Hangs up: stops listening and speaking, tells the server and shows what came in while we talked. After Hang up nothing is
  // spoken: the person asked for silence, and the labels of held jobs and tasks read badly aloud.
  function hangUp() {
    if (endPromise) return endPromise;
    teardown();
    const idKnown = callId || !startP ? Promise.resolve() : startP.catch(() => {});   // hanging up while the start is in flight waits for the id
    endPromise = idKnown.then(() => (callId ? server.end(callId) : { held: [] })).then(r => (r && Array.isArray(r.held) ? r.held : []), () => []).then((held) => {
      if (held.length) {
        const label = (h) => String(h.label || h.kind || 'something').replace(/[.!?\s]+$/, '');
        const n = held.length, ran = held.filter(h => h.state === 'done'), runs = held.filter(h => h.state !== 'done');
        let tail;
        if (!ran.length) tail = n === 1 ? 'It runs now.' : 'They run now.';
        else if (!runs.length) tail = n === 1 ? 'It already ran.' : 'They already ran.';
        else tail = 'Already ran: ' + ran.map(label).join(', ') + '. Running now: ' + runs.map(label).join(', ') + '.';
        const text = 'While we talked: ' + (n === 1 ? '1 thing came in' : n + ' things came in') + ': ' + held.map(label).join(', ') + '. ' + tail;
        quiet(() => ui.summary(text));   // shown only, never spoken
      }
      return held;
    });
    return endPromise;
  }
  // The page calls this when the wake setting or the recognizer check may have changed (also on routine refreshes: nothing that is
  // unchanged may move the call). Switched off: an ordinary call. Switched on (with a local recognizer): standby now if idle, else after
  // the quiet time. Anything else (a new phrase or quiet time, a check that failed) leaves the mode and the state as they are.
  function wakeChanged() {
    if (ended || !started || state === 'starting') return;
    const w = wake();
    if (!w) { wakeMode = false; if (standby) leaveStandby(); else settle(); return; }
    if (!wakeMode && w.local === true) { wakeMode = true; if (!standby && wakeIdle()) enterStandby(); }
    settle();
  }
  return {
    start, hangUp, release, wakeChanged, isStandby: () => standby, setPrefs, retryMic, setLinkLost, onSpeechBegin, onSpeechStart, onMisfire, onSpeechEnd, onReplyText, onActivity, onAsk, onAskDone, onHeld, onHeldDone, decide, setMode,
    get state() { return state; }, get callId() { return callId; }, get mode() { return mode; }, get held() { return heldList.map(h => Object.assign({}, h)); },
  };
}
// The link watch of a call: is the server reachable? o = { probe: () => Promise<boolean> (true = reachable), setTimeout, clearTimeout, onLost(), onBack(),
// onGiveUp(), everyMs = 5000, lostEveryMs = 1000, giveUpMs = 10000, now = Date.now }. While the link is fine it probes every everyMs; a failed probe, report()
// (a network failure seen on one of the call's own requests) or offline() mark it LOST at once (onLost, once per outage), and it then probes every
// lostEveryMs. A probe that succeeds within giveUpMs -> onBack (once) and the normal rhythm; no success within giveUpMs -> onGiveUp (once), and nothing runs
// any more. One probe is in flight at a time; after stop() nothing fires, and a probe that resolves late is ignored.
// -> { start(), stop(), report(), offline(), online() (probe at once), get lost() }
function voiceCreateLinkWatch(o) {
  const c = o || {};
  const setT = c.setTimeout, clrT = c.clearTimeout, clock = typeof c.now === 'function' ? c.now : Date.now;
  const every = Number.isFinite(Number(c.everyMs)) ? Number(c.everyMs) : 5000;
  const lostEvery = Number.isFinite(Number(c.lostEveryMs)) ? Number(c.lostEveryMs) : 1000;
  const giveUp = Number.isFinite(Number(c.giveUpMs)) ? Number(c.giveUpMs) : 10000;
  let running = false, lost = false, lostAt = 0, probing = false, gen = 0, timer = null, giveTimer = null;
  let outage = 0;   // each loss adds one: only a probe started after the loss can say the link is back
  const say = (f) => { try { if (typeof f === 'function') f(); } catch { /* a listener must not break the watch */ } };
  const clear = (t) => { if (t !== null) { try { clrT(t); } catch { /* gone */ } } return null; };
  function schedule(ms) {
    timer = clear(timer);
    if (running) timer = setT(() => { timer = null; probeNow(); }, ms);
  }
  function markLost() {
    if (!running || lost) return;
    lost = true; lostAt = clock(); outage++;
    giveTimer = clear(giveTimer);
    giveTimer = setT(() => {
      giveTimer = null;
      if (!running || !lost) return;
      running = false; gen++; probing = false;   // a probe still out is ignored
      timer = clear(timer);
      say(c.onGiveUp);
    }, giveUp);
    schedule(lostEvery);
    say(c.onLost);
  }
  function probeNow() {
    if (!running || probing) return;
    probing = true;
    timer = clear(timer);
    const my = gen, myOutage = outage;
    let p;
    try { p = Promise.resolve(c.probe()); } catch { p = Promise.resolve(false); }
    p.then((ok) => ok === true, () => false).then((ok) => {
      if (my !== gen || !running) return;
      probing = false;
      if (ok) {
        if (lost) {
          if (myOutage !== outage) { schedule(0); return; }   // it left before the loss: it proves nothing, so ask again at once (the deadline stands)
          if (clock() - lostAt > giveUp) return;   // too late: the give-up timer ends the call
          lost = false; giveTimer = clear(giveTimer);
          schedule(every);
          say(c.onBack);
        } else schedule(every);
      } else if (lost) schedule(lostEvery);
      else markLost();
    });
  }
  return {
    start() { if (running) return; running = true; lost = false; probing = false; gen++; schedule(every); },
    stop() { running = false; gen++; probing = false; lost = false; timer = clear(timer); giveTimer = clear(giveTimer); },
    report() { markLost(); },
    offline() { markLost(); },
    online() { if (running) probeNow(); },
    get lost() { return lost; },
  };
}
// Two short soft tones on the call's own audio context: descending (660 then 440 Hz) = the connection was lost, rising (440 then 660 Hz) = it is back.
// Nothing happens without a context; it never throws.
function voiceLinkTone(ctx, up) {
  try {
    if (!ctx || typeof ctx.createOscillator !== 'function' || typeof ctx.createGain !== 'function') return false;
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') { try { Promise.resolve(ctx.resume()).catch(() => {}); } catch { /* not resumable */ } }
    const t0 = (Number(ctx.currentTime) || 0) + 0.02, freqs = up ? [440, 660] : [660, 440], len = 0.16;
    freqs.forEach((hz, i) => {
      const osc = ctx.createOscillator(), g = ctx.createGain(), s = t0 + i * len;
      osc.type = 'sine'; osc.frequency.value = hz;
      g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(0.12, s + 0.015); g.gain.linearRampToValueAtTime(0, s + len);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(s); osc.stop(s + len + 0.02);
    });
    return true;
  } catch { return false; }
}
// Every microphone track the adapter makes is counted until it is stopped (voiceLiveTracks: a test hook, and a way to prove nothing is left holding the microphone).
const VOICE_LIVE_TRACKS = new Set();
function voiceTrackLive(stream) { try { for (const tr of stream.getTracks()) VOICE_LIVE_TRACKS.add(tr); } catch { /* not a stream */ } }
function voiceStopStream(stream) {
  try { for (const tr of stream.getTracks()) { try { tr.stop(); } catch { /* already stopped */ } VOICE_LIVE_TRACKS.delete(tr); } } catch { /* no stream */ }
}
function voiceLiveTracks() {
  let n = 0;
  for (const tr of Array.from(VOICE_LIVE_TRACKS)) { if (tr && tr.readyState === 'ended') VOICE_LIVE_TRACKS.delete(tr); else n++; }
  return n;
}
// The constraint ladder that opens the microphone (the VAD adapter and the Car or Bluetooth check use it): echo cancellation, noise suppression and
// auto gain first, exactly as ever. A refusal by the person or the browser (NotAllowedError, SecurityError, AbortError) ends it; any other failure
// (OverconstrainedError, NotReadableError, TypeError, NotSupportedError, NotFoundError: some Bluetooth and car inputs cannot do those) gets ONE more
// try with plain { audio: true }; when that fails too, the FIRST error is thrown. -> Promise of { stream, fallback }.
async function voiceOpenMicStream(nav) {
  const md = nav.mediaDevices;
  try { return { stream: await md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }), fallback: false }; } catch (first) {
    const name = first && first.name;
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'AbortError') throw first;
    try { return { stream: await md.getUserMedia({ audio: true }), fallback: true }; } catch { throw first; }
  }
}
// The recording of the 'Car or Bluetooth check'. The test chirp is played three times (opts.at, seconds after the start; default VOICE_CAR_AT) and the
// microphone is recorded until opts.seconds (default VOICE_CAR_END) on the audio clock. WHY ONE PROCESSOR AND A REFERENCE CHANNEL: the delay is the
// time between the chirp leaving and its echo arriving, and two clocks (a timestamp of the played sound, one of the microphone block) never agree:
// the first version dated blocks with AudioProcessingEvent.playbackTime (the OUTPUT buffer's time) and every delay came out about one buffer too
// long. So no timestamps are used: every chirp is played twice at the same scheduled time, once to the speakers (ctx.destination) and once into
// input 1 of a ChannelMerger whose input 0 is the microphone; the merger feeds ONE ScriptProcessor, so a block holds the microphone (channel 0)
// and an exact copy of the chirp (channel 1, silence elsewhere) at the same sample positions, and the delay is the distance between the chirp
// in channel 1 and its echo in channel 0 (voiceCarAnalyse). WHY 1.5 s SPACING AND A 1.2 s SEARCH: the three chirps are identical, so an echo found
// in the window of one chirp could be the echo of the next; the chirps are 1.5 s apart and the search stops at VOICE_CAR_MAX_DELAY_MS (1.2 s), so
// a window never reaches the next chirp's echo. The processor only runs while connected to the destination, hence the 0-gain node at the end.
// opts: { ctx (made and resumed by the page inside the tap; NOT closed here), nav, chirp (Float32Array at ctx.sampleRate), micLevel (the Mic level
// slider, applied to the microphone channel as in a call; default 50 = 0 dB), at, seconds, setTimer,
// clearTimer, now (ms clock), wallMs (default 12000: the audio clock must start within this, else the error code is 'audio_not_started') }.
// -> { done: Promise of { mic, ref, rate, fallback }, cancel() }; cancel() rejects with an Error whose code is 'cancelled'. However it ends
// (result, error, cancel, an exception while building) every source is stopped and disconnected, the processor's handler is removed, the
// microphone stream is stopped and the timer is cleared.
function voiceCarRecord(opts) {
  const o = opts || {}, ctx = o.ctx;
  const at = Array.isArray(o.at) ? o.at : VOICE_CAR_AT;
  const seconds = Number.isFinite(Number(o.seconds)) ? Number(o.seconds) : VOICE_CAR_END;
  const wallMs = Number.isFinite(Number(o.wallMs)) ? Number(o.wallMs) : 12000;
  const micChunks = [], refChunks = [], bufSources = [];
  let finished = false, stream = null, timer = null, micSource = null, micGain = null, merger = null, proc = null, gain = null, resolveF, rejectF;
  const done = new Promise((resolve, reject) => { resolveF = resolve; rejectF = reject; });
  const fail = (code, message) => { const e = new Error(message); e.code = code; return e; };
  const concat = (chunks) => {
    let n = 0; for (const c of chunks) n += c.length;
    const out = new Float32Array(n);
    let at0 = 0; for (const c of chunks) { out.set(c, at0); at0 += c.length; }
    return out;
  };
  function cleanup() {
    if (timer !== null) { try { o.clearTimer(timer); } catch { /* gone */ } timer = null; }
    if (proc) { try { proc.onaudioprocess = null; } catch { /* gone */ } }
    for (const s of bufSources) { try { s.stop(); } catch { /* not started */ } try { s.disconnect(); } catch { /* gone */ } }
    for (const n of [micSource, micGain, merger, proc, gain]) { if (n) { try { n.disconnect(); } catch { /* gone */ } } }
    if (stream) voiceStopStream(stream);
  }
  function finish(ok, value) {
    if (finished) return;
    finished = true;
    cleanup();
    if (ok) resolveF(value); else rejectF(value);
  }
  (async () => {
    let opened;
    try { opened = await voiceOpenMicStream(o.nav); } catch (e) { finish(false, e); return; }
    stream = opened.stream; voiceTrackLive(stream);
    if (finished) { voiceStopStream(stream); return; }   // cancelled while the microphone was opening: let go of it
    // iOS can suspend or interrupt the context when the microphone starts (or after the first permission prompt): resume it, waiting at most 3 s.
    if (ctx.state && ctx.state !== 'running' && typeof ctx.resume === 'function') {
      let wait = null;
      try { await Promise.race([Promise.resolve(ctx.resume()), new Promise((r) => { wait = o.setTimer(r, 3000); })]); } catch { /* the wall-clock limit below reports it */ }
      finally { if (wait !== null) { try { o.clearTimer(wait); } catch { /* gone */ } } }
      if (finished) return;
    }
    let t0, startMs;
    try {
      micSource = ctx.createMediaStreamSource(stream);
      merger = ctx.createChannelMerger(2);
      // The microphone goes through the person's Mic level, exactly as in a call (the VAD hears it after that gain); the reference does not.
      micGain = ctx.createGain(); micGain.gain.value = voiceGainFromSlider(o.micLevel);
      micSource.connect(micGain); micGain.connect(merger, 0, 0);
      proc = ctx.createScriptProcessor(4096, 2, 1);
      proc.onaudioprocess = (ev) => {
        if (finished) return;
        const ib = ev.inputBuffer, mic = ib.getChannelData(0);
        micChunks.push(new Float32Array(mic));
        refChunks.push(ib.numberOfChannels > 1 ? new Float32Array(ib.getChannelData(1)) : new Float32Array(mic.length));
      };
      merger.connect(proc);
      gain = ctx.createGain(); gain.gain.value = 0;
      proc.connect(gain); gain.connect(ctx.destination);
      t0 = ctx.currentTime;
      const buffer = ctx.createBuffer(1, o.chirp.length, ctx.sampleRate);
      buffer.getChannelData(0).set(o.chirp);
      for (const a of at) {
        const toSpeakers = ctx.createBufferSource(); bufSources.push(toSpeakers);
        toSpeakers.buffer = buffer; toSpeakers.connect(ctx.destination); toSpeakers.start(t0 + a);
        const toMerger = ctx.createBufferSource(); bufSources.push(toMerger);
        toMerger.buffer = buffer; toMerger.connect(merger, 0, 1); toMerger.start(t0 + a);
      }
      startMs = o.now();
    } catch (e) { finish(false, e); return; }
    const tick = () => {
      timer = null;
      if (finished) return;
      try {
        if (ctx.currentTime >= t0 + seconds) { finish(true, { mic: concat(micChunks), ref: concat(refChunks), rate: ctx.sampleRate, fallback: !!opened.fallback }); return; }
        if (o.now() - startMs > wallMs) { finish(false, fail('audio_not_started', 'the audio did not start')); return; }
        timer = o.setTimer(tick, 100);
      } catch (e) { finish(false, e); }
    };
    try { timer = o.setTimer(tick, 100); } catch (e) { finish(false, e); }
  })();
  return { done, cancel() { finish(false, fail('cancelled', 'cancelled')); } };
}
// The thinking sound: quiet random pop clusters made with Web Audio only (no files). The plan (how many pops, when, how high, the gaps) is
// DATA from lib/ui-voice-thinking.js (voiceThinkingCluster, seeded); this function only plays an event's pops: each pop is a sine with a
// few-ms attack and a 30-60 ms decay (a little glide), through a low-pass below 2 kHz, the whole cluster fades in and out. Peak = volume x
// 0.1125 (volume 0.5, the default, is -25 dBFS). start(), stop() (a 0.1 s fade), setVolume(0..1). pulse(event) schedules ONE cluster at
// ctx.currentTime + 0.02 and moves event.at to the moment that cluster is HEARD (the audio output clock mapped to performance.now():
// getOutputTimestamp when valid, else now + the scheduling lead + the output or base latency); it returns the same event, or false when
// the context is not running (nothing was claimed, event.at is untouched). An event without pops (or no event) plays a cluster of a fresh
// random seed. start() plays one now and another every 6.5 s (the old adapters without a clock of their own).
// opts: { ctx, volume, variant, seed (a fixed seed for the clusters it makes itself), setInterval, clearInterval, perfNow } (the last four for tests).
function voiceCreateThinkingSound(opts) {
  const o = opts || {}, ctx = o.ctx;
  const perf = o.perfNow || (() => (typeof performance !== 'undefined' && performance && typeof performance.now === 'function' ? performance.now() : NaN));
  const setIv = o.setInterval || ((f, ms) => setInterval(f, ms)), clearIv = o.clearInterval || ((id) => clearInterval(id));
  const clamp = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5; };
  let vol = clamp(o.volume === undefined ? 0.5 : o.volume), master = null, timer = null, running = false, active = [], own = 0;
  const peak = () => vol * 2 * Math.pow(10, -25 / 20);   // volume 0.5 = -25 dBFS
  // performance.now() time at which the sample scheduled for context time t0 comes out of the speakers; null when it cannot be told.
  function heardAt(ct, t0) {
    const now = Number(perf());
    if (!Number.isFinite(ct) || !Number.isFinite(now)) return null;
    const sane = (m) => Number.isFinite(m) && m >= 0 && m >= now - 5 && m <= now + 1500;   // never in the past, never far ahead
    try {
      const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
      if (ts && Number.isFinite(ts.contextTime) && Number.isFinite(ts.performanceTime) && ts.contextTime >= 0 && ts.performanceTime > 0) {
        const m = ts.performanceTime + (t0 - ts.contextTime) * 1000;
        if (sane(m)) return m;
      }
    } catch { /* no output timestamp: the latency estimate below */ }
    const l = Number(ctx.outputLatency) > 0 ? Number(ctx.outputLatency) : (Number(ctx.baseLatency) > 0 ? Number(ctx.baseLatency) : 0);
    const m = now + (t0 - ct) * 1000 + l * 1000;
    return sane(m) ? m : null;
  }
  function pulse(ev) {
    if (!running || !master) return;
    const ct = ctx.currentTime, t0 = ct + 0.02;
    if (ev && typeof ev === 'object') { const m = heardAt(ct, t0); if (m !== null) ev.at = m; }
    // the plan: the event's own pops, else a cluster of a fresh random seed (nothing without lib/ui-voice-thinking.js)
    let plan = ev && typeof ev === 'object' && Array.isArray(ev.pops) && ev.pops.length ? ev : null;
    if (!plan && typeof voiceThinkingCluster === 'function') plan = voiceThinkingCluster({ seed: Number.isFinite(Number(o.seed)) ? Number(o.seed) : Math.floor(Math.random() * 4294967296), index: own++, variant: o.variant });
    if (!plan || !Array.isArray(plan.pops) || !plan.pops.length) return;
    const dur = Math.max(0.05, (Number(plan.durationMs) || 1500) / 1000);
    const fin = Math.min(dur, Math.max(0.004, (Number(plan.fadeInMs) || 0) / 1000)), fout = Math.min(dur - fin, Math.max(0.01, (Number(plan.fadeOutMs) || 0) / 1000));
    const env = ctx.createGain();   // the cluster's fade in and out
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(1, t0 + fin);
    env.gain.setValueAtTime(1, t0 + dur - fout);
    env.gain.linearRampToValueAtTime(0, t0 + dur);
    env.connect(master);
    let sink = env;
    if (typeof ctx.createBiquadFilter === 'function') {   // the low-pass: nothing above 2 kHz
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = Math.min(1990, Number(plan.lowpassHz) || 1600); if (lp.Q) lp.Q.value = 0.5;
      lp.connect(env); sink = lp;
    }
    let left = plan.pops.length;
    const done = () => { if (--left === 0) { try { sink.disconnect(); } catch { /* gone */ } try { env.disconnect(); } catch { /* gone */ } } };
    for (const p of plan.pops) {
      const tp = t0 + Math.max(0, Number(p.tMs) || 0) / 1000, dec = Math.max(0.03, Math.min(0.06, (Number(p.decayMs) || 45) / 1000));
      const freq = Math.max(60, Math.min(1900, Number(p.freqHz) || 300)), level = Math.max(0, Math.min(1, Number(p.strength))), glide = Number(p.glide) > 0 ? Number(p.glide) : 1;
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = freq;
      if (glide !== 1 && osc.frequency.setValueAtTime) { osc.frequency.setValueAtTime(freq, tp); osc.frequency.linearRampToValueAtTime(Math.min(1900, freq * glide), tp + dec); }
      g.gain.setValueAtTime(0, tp);
      g.gain.linearRampToValueAtTime(Number.isFinite(level) ? level : 0.7, tp + 0.004);   // a few ms attack
      g.gain.linearRampToValueAtTime(0, tp + dec);                                          // the 30-60 ms decay ramp
      osc.connect(g); g.connect(sink);
      const item = { osc, env };
      active.push(item);
      osc.onended = () => { active = active.filter(x => x !== item); try { g.disconnect(); } catch { /* gone */ } done(); };
      osc.start(tp); osc.stop(tp + dec + 0.02);
    }
  }
  return {
    start() {
      if (running || !ctx) return;
      running = true;
      try { if (ctx.state === 'suspended' && ctx.resume) { const r = ctx.resume(); if (r && r.catch) r.catch(() => {}); } } catch { /* the page resumes it */ }
      master = ctx.createGain(); master.gain.value = peak(); master.connect(ctx.destination);
      pulse();
      timer = setIv(pulse, 6500);
    },
    // ONE pulse at ctx.currentTime + 0.02 (the call's thinking clock decides when); no interval of its own. stop() ends it like start().
    // With an event: event.at becomes the moment the pulse is heard and the event is returned (the same object); a context that is
    // not running (suspended, closed) is asked to resume, plays nothing, claims nothing and false is returned.
    pulse(ev) {
      if (!ctx) return ev ? false : undefined;
      const wants = ev && typeof ev === 'object';
      if (wants && ctx.state !== undefined && ctx.state !== 'running') {
        try { if (ctx.state === 'suspended' && ctx.resume) { const r = ctx.resume(); if (r && r.catch) r.catch(() => {}); } } catch { /* the page resumes it */ }
        return false;
      }
      if (!running) {
        running = true;
        try { if (ctx.state === 'suspended' && ctx.resume) { const r = ctx.resume(); if (r && r.catch) r.catch(() => {}); } } catch { /* the page resumes it */ }
        master = ctx.createGain(); master.gain.value = peak(); master.connect(ctx.destination);
      }
      pulse(wants ? ev : undefined);
      return wants ? ev : undefined;
    },
    stop() {
      if (!running) return;
      running = false;
      if (timer !== null) { clearIv(timer); timer = null; }
      const m = master, t = ctx.currentTime; master = null;
      try { m.gain.cancelScheduledValues(t); m.gain.setValueAtTime(m.gain.value, t); m.gain.linearRampToValueAtTime(0, t + 0.1); } catch { /* ignore */ }
      for (const x of active) { try { x.osc.stop(t + 0.12); } catch { /* already stopped */ } }
      active = [];
      try { if (typeof setTimeout === 'function') setTimeout(() => { try { m.disconnect(); } catch { /* gone */ } }, 300); } catch { /* ignore */ }
    },
    setVolume(v) { vol = clamp(v); if (master) { try { master.gain.value = peak(); } catch { /* ignore */ } } },
    get playing() { return running; },
  };
}
// The keep-alive sound: a 2 s loop of white noise at levelDb (default -70 dB, amplitude 10^(levelDb/20), mono) through a GainNode to
// ctx.destination. It is inaudible noise, not digital silence: phones and Bluetooth links that put the audio route to sleep on silence keep
// it open, so the first syllable of a reply and the thinking sound are not clipped. start() makes the buffer once and a source node each
// time; stop() stops and disconnects it. A missing or failing context makes every call a no-op. opts: { ctx, levelDb }.
function voiceCreateKeepAlive(opts) {
  const o = opts || {}, ctx = o.ctx;
  const db = typeof o.levelDb === 'number' && Number.isFinite(o.levelDb) ? o.levelDb : VOICE_KEEPALIVE_DB;
  let buffer = null, src = null, gain = null;
  const drop = () => {
    const s = src, g = gain; src = gain = null;
    if (s) { try { s.stop(); } catch { /* not started */ } try { s.disconnect(); } catch { /* gone */ } }
    if (g) { try { g.disconnect(); } catch { /* gone */ } }
  };
  return {
    start() {
      if (!ctx || src) return;
      try {
        if (ctx.state === 'suspended' && ctx.resume) { const r = ctx.resume(); if (r && r.catch) r.catch(() => {}); }
        if (!buffer) {
          const rate = ctx.sampleRate, amp = Math.pow(10, db / 20);
          buffer = ctx.createBuffer(1, Math.max(1, Math.round(rate * 2)), rate);
          const data = buffer.getChannelData(0);
          for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * amp;
        }
        gain = ctx.createGain(); gain.gain.value = 1;
        src = ctx.createBufferSource(); src.buffer = buffer; src.loop = true;
        src.connect(gain); gain.connect(ctx.destination);
        src.start();
      } catch { drop(); }
    },
    stop() { drop(); },
    get running() { return !!src; },
  };
}
// The microphone and the voice activity detector. opts: { baseUrl, micLevel, interruptSensitivity, endPause, echoHoldMs, win, nav, loadScript, setTimer, clearTimer }.
// MicVAD 0.0.31 only takes getStream (no stream option), so the stream it gets is built here: microphone (echo
// cancellation, noise suppression and auto gain on) -> GainNode (the Mic level) -> MediaStreamDestination; the VAD
// listens to that destination stream, so the gain acts on what it hears and on what is sent to transcription.
// The gain and the destination are made once; the microphone source in front of them can be swapped (attach), so when the microphone
// ends or changes (Bluetooth connected or dropped, a car started) it is opened again without restarting the speech detector.
// handlers.onMicInfo(info) after every open; handlers.onMicChange({ ok, reason, info, changed, error }) after every reopen.
function voiceCreateVad(opts) {
  const o = opts || {};
  const base = o.baseUrl || '/api/voice/web/';
  const pause = (v) => (VOICE_END_PAUSES.includes(Number(v)) ? Number(v) : 1200);   // how long a pause ends the person's turn (ms)
  const holdMs = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : VOICE_ECHO_HOLD_MS; };
  const st = { micLevel: o.micLevel, sens: o.interruptSensitivity, pause: pause(o.endPause), playing: false, vad: null, ctx: null, gain: null, raw: null, dest: null, gen: 0,
    hold: o.echoHoldMs === undefined ? VOICE_ECHO_HOLD_MS : holdMs(o.echoHoldMs), holdTimer: null, nav: null, handlers: {}, src: null, track: null, trackOff: null,
    mdOff: null, devTimer: null, reopening: null, info: null, defSnap: null };
  const win = () => o.win || window;
  const setT = o.setTimer || ((fn, ms) => { const w = win(); return (typeof w.setTimeout === 'function' ? w.setTimeout.bind(w) : setTimeout)(fn, ms); });
  const clearT = o.clearTimer || ((id) => { const w = win(); return (typeof w.clearTimeout === 'function' ? w.clearTimeout.bind(w) : clearTimeout)(id); });
  const clearHold = () => { if (st.holdTimer !== null) { try { clearT(st.holdTimer); } catch { /* gone */ } st.holdTimer = null; } };
  const loadScript = o.loadScript || ((src) => new Promise((resolve, reject) => {
    const el = win().document.createElement('script');
    el.src = src; el.onload = () => resolve(); el.onerror = () => reject(new Error('could not load ' + src));
    win().document.head.appendChild(el);
  }));
  const apply = () => {
    const t = voiceVadThresholds(st.sens, st.playing);
    if (st.vad) st.vad.setOptions({ positiveSpeechThreshold: t.positiveSpeechThreshold, negativeSpeechThreshold: t.negativeSpeechThreshold, minSpeechMs: t.minSpeechFrames * 32 });
  };
  // The microphone helpers. A handler (onMicInfo, onMicChange) must never break the microphone.
  const call = (name, arg) => { try { const f = st.handlers[name]; if (typeof f === 'function') f(arg); } catch { /* the handler's own problem */ } };
  const rawTrack = (raw) => { try { const l = raw && (raw.getAudioTracks ? raw.getAudioTracks() : (raw.getTracks ? raw.getTracks() : [])); return (l && l[0]) || null; } catch { return null; } };
  // { label, sampleRate, channelCount, echoCancellation, fallback } from the track (each may be missing; the rate then is the context's).
  function micInfo(raw, fallback) {
    const tr = rawTrack(raw);
    let s = {};
    try { s = (tr && typeof tr.getSettings === 'function' && tr.getSettings()) || {}; } catch { s = {}; }
    return { label: tr && typeof tr.label === 'string' ? tr.label : '', sampleRate: Number.isFinite(s.sampleRate) ? s.sampleRate : (st.ctx ? st.ctx.sampleRate : undefined),
      channelCount: s.channelCount, echoCancellation: s.echoCancellation, fallback: !!fallback };
  }
  // The constraint ladder: echo cancellation, noise suppression and auto gain first, exactly as ever. A refusal by the person or the browser
  // (NotAllowedError, SecurityError, AbortError) ends it; any other failure (OverconstrainedError, NotReadableError, TypeError, NotSupportedError,
  // NotFoundError: some Bluetooth and car inputs cannot do those) gets ONE more try with plain { audio: true }; when that fails too, the FIRST error is thrown.
  async function openMic() {
    const r = await voiceOpenMicStream(st.nav);
    return { raw: r.stream, fallback: r.fallback };
  }
  function unwatchTrack() {
    if (st.trackOff) { try { st.trackOff(); } catch { /* gone */ } }
    st.trackOff = null; st.track = null;
  }
  // The new microphone goes in front of the SAME gain: the source is swapped, the destination stream (and so MicVAD) stays.
  // The new source is made and connected first: if that throws, nothing of the old one was touched (the caller lets go of the new stream).
  function attach(raw, fallback) {
    const prevRaw = st.raw, prevSrc = st.src;
    const src = st.ctx.createMediaStreamSource(raw);
    try { src.connect(st.gain); } catch (e) { try { src.disconnect(); } catch { /* never connected */ } throw e; }
    unwatchTrack();
    if (prevSrc) { try { prevSrc.disconnect(); } catch { /* gone */ } }
    if (prevRaw && prevRaw !== raw) voiceStopStream(prevRaw);   // stops and untracks it
    st.src = src; st.raw = raw;
    const tr = rawTrack(raw);
    if (tr && typeof tr.addEventListener === 'function') {
      const f = () => { if (st.track === tr) reopen('ended').catch(() => {}); };   // ended: opened again at once
      tr.addEventListener('ended', f);
      st.track = tr;
      st.trackOff = () => { if (typeof tr.removeEventListener === 'function') tr.removeEventListener('ended', f); };
    }
  }
  // The 'default' audio input as it was at the last open (its group and label change when the system switches, for example to a car).
  async function snapDefault() {
    const my = st.gen, md = st.nav && st.nav.mediaDevices;
    if (!md || typeof md.enumerateDevices !== 'function') return;
    try {
      const list = await md.enumerateDevices();
      if (st.gen !== my || !st.ctx) return;
      const def = Array.from(list || []).find(x => x && x.kind === 'audioinput' && x.deviceId === 'default');
      st.defSnap = def ? { groupId: def.groupId, label: def.label } : null;
    } catch { /* no list: the default entry is simply not compared */ }
  }
  // devicechange: waits 700 ms (a burst of events counts once), then opens the microphone again only when it matters for this call: the
  // current track ended, its device is no longer listed, or the 'default' input moved to another device or name.
  function deviceChanged() {
    if (!st.ctx) return;
    if (st.devTimer !== null) { try { clearT(st.devTimer); } catch { /* gone */ } }
    st.devTimer = setT(() => { st.devTimer = null; checkDevices().catch(() => {}); }, 700);
  }
  async function checkDevices() {
    const my = st.gen;
    if (!st.ctx || st.reopening) return;
    let need = !!(st.track && st.track.readyState === 'ended');
    if (!need) {
      const md = st.nav.mediaDevices;
      if (typeof md.enumerateDevices !== 'function') return;
      let list;
      try { list = await md.enumerateDevices(); } catch { return; }
      if (st.gen !== my || !st.ctx) return;
      const inputs = Array.from(list || []).filter(x => x && x.kind === 'audioinput');
      let id;
      try { id = st.track && typeof st.track.getSettings === 'function' ? st.track.getSettings().deviceId : undefined; } catch { id = undefined; }
      if (id && !inputs.some(x => x.deviceId === id)) need = true;
      const def = inputs.find(x => x.deviceId === 'default');
      if (!need && def && st.defSnap && (def.groupId !== st.defSnap.groupId || def.label !== st.defSnap.label)) need = true;
    }
    if (need) await reopen('devicechange');
  }
  // ONE attempt (with the constraint ladder), never two at once: a reopen in flight absorbs further triggers (and answers them with its own
  // result). Success: the new source is attached, onMicInfo and onMicChange({ ok: true, info, reason, changed }) (changed: the label differs from
  // before). Failure: onMicChange({ ok: false, reason, error }); the speech detector keeps running on the silent destination and nothing is retried.
  function reopen(reason) {
    if (st.reopening) return st.reopening;
    if (!st.ctx || !st.gain || !st.nav) return Promise.resolve(false);
    const my = st.gen, prev = st.info ? st.info.label : '';
    st.reopening = (async () => {
      let res;
      try { res = await openMic(); } catch (error) { if (st.gen === my) call('onMicChange', { ok: false, reason, error }); return false; }
      voiceTrackLive(res.raw);
      if (st.gen !== my || !st.ctx || !st.gain) { voiceStopStream(res.raw); return false; }   // stopped meanwhile: let go of it
      // iOS leaves the context 'interrupted' (or suspended) after a route change or a phone call: resume it, or the new source is silent.
      // A resume can stay pending on iOS while a phone call holds the audio: it is given 3 s; a context still not running is a lost microphone
      // (the new stream is let go, "Try the microphone again" tries later), never a recovery that hears nothing.
      if (st.ctx.state && st.ctx.state !== 'running' && typeof st.ctx.resume === 'function') {
        let wait = null;
        try { await Promise.race([Promise.resolve(st.ctx.resume()), new Promise((r) => { wait = setT(r, 3000); })]); } catch { /* checked below */ }
        finally { if (wait !== null) { try { clearT(wait); } catch { /* gone */ } } }
        if (st.gen !== my || !st.ctx || !st.gain) { voiceStopStream(res.raw); return false; }
        if (st.ctx.state && st.ctx.state !== 'running') { voiceStopStream(res.raw); call('onMicChange', { ok: false, reason, error: new Error('the audio is not running') }); return false; }
      }
      try { attach(res.raw, res.fallback); } catch (error) {
        voiceStopStream(res.raw);   // the new stream is let go; the old source (if any) was not touched
        call('onMicChange', { ok: false, reason, error });
        return false;
      }
      const info = micInfo(res.raw, res.fallback);
      st.info = info;
      snapDefault();
      call('onMicInfo', info);
      call('onMicChange', { ok: true, reason, info, changed: (info.label || '') !== (prev || '') });
      return true;
    })().finally(() => { st.reopening = null; });
    return st.reopening;
  }
  async function start(h) {
    const w = win(), handlers = h || {}, my = ++st.gen;
    const stale = () => st.gen !== my;   // stop() was called while this start was still in flight: whatever it makes is let go
    st.handlers = handlers;
    // Every failure from here on (script load, resume, MicVAD) lets go of the VAD, the stream and the audio context.
    try {
      // The audio context is made and resumed first, still inside the tap that started the call: iOS keeps a context
      // suspended when it is made after an await. Speech detection needs at least 16 kHz: a context that came up lower (some
      // Bluetooth hands-free profiles run at 8 kHz) is closed and a 48 kHz one made instead (a plain one when that is refused).
      const Ctx = w.AudioContext || w.webkitAudioContext;
      st.ctx = new Ctx();
      if (typeof st.ctx.sampleRate === 'number' && st.ctx.sampleRate < 16000) {
        try { const c = st.ctx.close(); if (c && c.catch) c.catch(() => {}); } catch { /* already closed */ }
        try { st.ctx = new Ctx({ sampleRate: 48000 }); } catch { st.ctx = new Ctx(); }
      }
      const resumed = st.ctx.resume();
      resumed.catch(() => {});   // a failed resume is reported by the await below, not as an unhandled rejection
      if (!w.vad || !w.vad.MicVAD) { await loadScript(base + 'ort.wasm.min.js'); await loadScript(base + 'bundle.min.js'); }
      await resumed;
      if (stale()) throw new Error('stopped');
      const nav = o.nav || w.navigator;
      st.nav = nav;
      const t = voiceVadThresholds(st.sens, false);
      st.vad = await w.vad.MicVAD.new({
        model: 'v5', audioContext: st.ctx, baseAssetPath: base, onnxWASMBasePath: base,
        ortConfig: (c) => { c.env.wasm.numThreads = 1; },
        getStream: async () => {
          const opened = await openMic();
          voiceTrackLive(opened.raw);
          if (stale()) { voiceStopStream(opened.raw); throw new Error('stopped'); }
          const dest = st.ctx.createMediaStreamDestination();   // the destination and the gain are made once; a reopen only swaps the source (attach)
          st.dest = dest.stream; voiceTrackLive(st.dest);
          st.gain = st.ctx.createGain(); st.gain.gain.value = voiceGainFromSlider(st.micLevel);
          try { attach(opened.raw, opened.fallback); } catch (e) { voiceStopStream(opened.raw); throw e; }   // never leave the new stream live
          st.gain.connect(dest);
          st.info = micInfo(opened.raw, opened.fallback);
          if (!st.mdOff && nav.mediaDevices && typeof nav.mediaDevices.addEventListener === 'function') {
            const md = nav.mediaDevices, onChange = () => deviceChanged();
            md.addEventListener('devicechange', onChange);
            st.mdOff = () => { try { md.removeEventListener('devicechange', onChange); } catch { /* gone */ } };
          }
          snapDefault();
          call('onMicInfo', st.info);
          return dest.stream;
        },
        pauseStream: async () => {}, resumeStream: async (s) => s,
        positiveSpeechThreshold: t.positiveSpeechThreshold, negativeSpeechThreshold: t.negativeSpeechThreshold,
        redemptionMs: st.pause, preSpeechPadMs: 256, minSpeechMs: t.minSpeechFrames * 32,
        // vad-web 0.0.31: onSpeechStart fires on the first speech-like frame, onSpeechRealStart once minSpeechMs is reached.
        // A candidate start marks the person as speaking (nothing new starts over them); playback is cut on the real start
        // only; a candidate that never gets there ends in onVADMisfire.
        onSpeechStart: () => { if (handlers.onSpeechBegin) handlers.onSpeechBegin(); },
        // Real speech passed the raised thresholds: an echo hold-over still running (after a reply or a thinking pulse) ends at once, so
        // it never stays raised over the person's own words.
        onSpeechRealStart: () => {
          if (st.holdTimer !== null) { clearHold(); st.playing = false; apply(); }
          if (handlers.onSpeechStart) handlers.onSpeechStart();
        },
        onSpeechEnd: (audio) => (handlers.onSpeechEnd ? handlers.onSpeechEnd(audio) : undefined),
        onVADMisfire: () => { if (handlers.onMisfire) handlers.onMisfire(); },
        onFrameProcessed: (probs, frame) => { if (handlers.onFrame) handlers.onFrame(voiceLevelDb(frame), probs); },
      });
      if (stale()) throw new Error('stopped');
      await st.vad.start();
    } catch (e) { if (!stale()) await stop(); else await release(); throw e; }
  }
  // Lets go of everything this adapter holds: MicVAD, the raw microphone stream, the processed stream (the destination's
  // tracks) and the audio context, so other apps can use the microphone at once.
  async function release() {
    const { vad, raw, dest, ctx } = st;
    if (st.holdTimer !== null) st.playing = false;   // an echo hold-over that was still running ends with the adapter
    clearHold();
    if (st.devTimer !== null) { try { clearT(st.devTimer); } catch { /* gone */ } st.devTimer = null; }
    unwatchTrack();
    if (st.mdOff) { st.mdOff(); st.mdOff = null; }
    const src = st.src;
    st.vad = st.raw = st.dest = st.ctx = st.gain = st.src = st.defSnap = null;
    if (src) { try { src.disconnect(); } catch { /* gone */ } }
    voiceStopStream(raw); voiceStopStream(dest);   // first, so the microphone is free even when the rest is slow
    try { if (vad) await vad.destroy(); } catch { /* already gone */ }
    try { if (ctx) await ctx.close(); } catch { /* already closed */ }
  }
  async function stop() { st.gen++; await release(); }
  return {
    start, stop,
    // While a reply plays the barge-in thresholds are raised. Playback stopping does NOT lower them at once: a car cabin's echo of the reply
    // reaches the microphone 150-300 ms after playback stops (longer through Bluetooth), and would be heard as the person speaking. So they stay
    // raised for echoHoldMs (default VOICE_ECHO_HOLD_MS; 0 = off: lowered at once) and a new playback in between cancels the lowering.
    // now = true (the person's real speech cut the playback): lowered at once, so the hold-over never shortens their own turn.
    setPlaybackActive(on, now) {
      if (on) { clearHold(); st.playing = true; apply(); return; }
      if (now) { clearHold(); st.playing = false; apply(); return; }
      if (st.holdTimer !== null) return;   // already counting down
      if (!st.ctx) { st.playing = false; return; }   // released (a hang-up): no timer outlives the adapter
      if (st.hold > 0 && st.playing) {
        try { st.holdTimer = setT(() => { st.holdTimer = null; st.playing = false; apply(); }, st.hold); return; } catch { st.holdTimer = null; /* no timer: lowered at once */ }
      }
      st.playing = false; apply();
    },
    // 'Echo guard' (ms, 0 = off); lowering it to 0 ends a hold-over that is running.
    setEchoHold(ms) { st.hold = holdMs(ms); if (st.hold === 0 && st.holdTimer !== null) { clearHold(); st.playing = false; apply(); } },
    // Opens the microphone again (the same path as a lost or changed one, reason 'manual'): a promise of true / false.
    reopen() { return reopen('manual'); },
    info() { return st.info; },
    setMicLevel(v) { st.micLevel = v; if (st.gain) st.gain.gain.value = voiceGainFromSlider(v); },
    setInterruptSensitivity(v) { st.sens = v; apply(); },
    // 'Pause before I'm done': only the END of a turn waits this long; the start of speech (barge-in) is not delayed.
    setEndPause(ms) { st.pause = pause(ms); if (st.vad) st.vad.setOptions({ redemptionMs: st.pause }); },
  };
}
// The wake chime: two soft sine notes (660 Hz, then 880 Hz), 110 ms each, 40 ms apart, peak gain 0.08 (10 ms attack, exponential decay).
// Pure Web Audio on the given AudioContext, no asset. -> true when scheduled, false when there is no context or anything threw.
function voicePlayWakeChime(ctx) {
  try {
    if (!ctx || typeof ctx.createOscillator !== 'function') return false;
    const t0 = ctx.currentTime + 0.02;
    [[660, 0], [880, 0.15]].forEach(([freq, offset]) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain(), s = t0 + offset, e = s + 0.11;
      osc.type = 'sine'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, s);
      gain.gain.linearRampToValueAtTime(0.08, s + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, e);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(s); osc.stop(e + 0.02);
    });
    return true;
  } catch { return false; }
}
// ── voice call (end) ──

// The date and time under each message: when it was sent, when a reply was finished and how long it took.
// Shared verbatim with lib/ui-msg-time.js and app.js (test/ui-msg-time.test.js keeps the three in step).
// ── message-time helpers (begin) ──
const msgTimeFormats = new Map();   // one formatter per language, zone and year style: one per message was slow
function msgTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
}
function msgTimeLabel(t, now = Date.now(), locale = [], zone = msgTimeZone()) {
  const ms = typeof t === 'number' ? t : Date.parse(t);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const fmt = (key, make) => { let f = msgTimeFormats.get(key); if (!f) { f = make(); msgTimeFormats.set(key, f); } return f; };
  try {
    const yf = fmt(`year|${zone}`, () => new Intl.DateTimeFormat('en-US', { year: 'numeric', ...(zone ? { timeZone: zone } : {}) }));
    const year = yf.format(d) !== yf.format(new Date(now));   // judged in the same zone the time is shown in
    return fmt(`${locale}|${zone}|${year}`, () => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(year ? { year: 'numeric' } : {}), ...(zone ? { timeZone: zone } : {}) })).format(d);
  } catch { return d.toLocaleString(); }   // an unknown language or zone
}
function msgTookLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
function msgTimeLine(end, start, now = Date.now(), locale = [], zone = msgTimeZone()) {
  const when = msgTimeLabel(end, now, locale, zone);
  const e = typeof end === 'number' ? end : Date.parse(end);
  const s = typeof start === 'number' ? start : Date.parse(start);
  const took = when && Number.isFinite(s) ? msgTookLabel(e - s) : '';
  return took ? `${when} · ${took}` : when;
}
function msgTimeLines(history, now = Date.now(), locale = [], zone = msgTimeZone()) {
  const lines = [];
  let start = NaN, last = -1, joined = 0;   // the turn's message time; its reply's newest piece, and the length so far
  for (let i = 0; i < history.length; i++) {
    const m = history[i] || {};
    const t = m.inProgress ? NaN : Date.parse(m.ts);   // the running turn's reply so far: not finished, no line
    lines.push(Number.isFinite(t) ? msgTimeLabel(t, now, locale, zone) : '');
    if (m.role === 'user' && !m.ask) { start = t; last = -1; continue; }   // the next turn
    if (m.role !== 'assistant' || m.ask || typeof m.content !== 'string') continue;
    if (last >= 0 && m.base > 0 && m.base === joined) {
      lines[last] = msgTimeLabel(Date.parse(history[last].ts), now, locale, zone);   // an earlier piece: its time only
    } else if (last >= 0 || m.base > 0) {
      start = NaN; last = -1;   // not this turn's reply
      continue;
    } else joined = 0;
    last = i; joined += m.content.length;
    if (Number.isFinite(t)) lines[i] = msgTimeLine(t, start, now, locale, zone);
  }
  return lines;
}
// ── message-time helpers (end) ──

// Face ID / fingerprint unlock of the wallet (WebAuthn PRF). Shared verbatim with lib/ui-passkey.js and app.js
// (test/ui-passkey.test.js keeps the three in step). The Wallet sheet below uses it.
// ── passkey helpers (begin) ──
function pkB64u(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pkBytes(s) {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function pkUsable(loc = location, w = window) {
  if (!w.PublicKeyCredential || !navigator.credentials) return { ok: false, code: 'no_api', text: "This browser can't use passkeys." };
  const host = loc.hostname || '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, code: 'bad_address', text: `Face ID and fingerprint work on My Maestro's secure tailnet address (https), not on ${host}.` };
  }
  if (loc.protocol !== 'https:') {
    return { ok: false, code: 'bad_address', text: "Face ID and fingerprint need My Maestro's secure (https) address." };
  }
  return { ok: true, code: '', text: '' };
}
function pkErrorText(e) {
  const name = e && e.name;
  if (name === 'NotAllowedError') return 'Cancelled, or the device did not confirm it was you.';
  if (name === 'InvalidStateError') return 'This device is already set up.';
  if (name === 'SecurityError') return "This address can't use passkeys.";
  if (name === 'AbortError') return 'Cancelled.';
  return (e && e.message) || 'Something went wrong.';
}
function pkStop(signal) {
  if (signal && signal.aborted) throw new DOMException('Cancelled.', 'AbortError');
}
async function pkUnlock(api, signal) {
  const o = await api('passkey/options', { purpose: 'unlock' });
  pkStop(signal);
  const one = o.allowCredentials.length === 1;
  const byCred = {};
  for (const c of o.allowCredentials) byCred[c.id] = { first: pkBytes(o.prfSalts[c.id]) };
  const publicKey = {
    challenge: pkBytes(o.challenge), rpId: o.rpId, timeout: o.timeout, userVerification: 'required',
    allowCredentials: o.allowCredentials.map(c => ({ type: 'public-key', id: pkBytes(c.id) })),
    extensions: { prf: { evalByCredential: byCred, ...(one ? { eval: { first: pkBytes(o.prfSalts[o.allowCredentials[0].id]) } } : {}) } },
  };
  const cred = await navigator.credentials.get({ publicKey, signal });
  pkStop(signal);
  const prf = cred.getClientExtensionResults().prf?.results?.first;
  if (!prf) throw new Error("This device didn't give the unlock secret. Use the passphrase instead.");
  return api('passkey/unlock', {
    challenge: o.challenge, id: cred.id,
    clientDataJSON: pkB64u(cred.response.clientDataJSON), authenticatorData: pkB64u(cred.response.authenticatorData),
    signature: pkB64u(cred.response.signature), prf: pkB64u(prf),
  });
}
async function pkAdd(api, { passphrase, label }, confirmStep, signal) {
  const stray = ' A passkey named "My Maestro wallet" may have been saved on this device; you can delete it in its password manager.';
  const o = await api('passkey/options', { purpose: 'register', passphrase });
  pkStop(signal);
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: pkBytes(o.challenge), rp: o.rp, user: { ...o.user, id: pkBytes(o.user.id) }, pubKeyCredParams: o.pubKeyCredParams,
    timeout: o.timeout, attestation: 'none', authenticatorSelection: o.authenticatorSelection,
    excludeCredentials: o.excludeCredentials.map(c => ({ type: 'public-key', id: pkBytes(c.id) })),
    extensions: { prf: { eval: { first: pkBytes(o.prfSalt) } } },
  }, signal });
  pkStop(signal);
  const ext = cred.getClientExtensionResults().prf;
  if (ext && ext.enabled === false) throw new Error("This device's passkeys can't unlock the wallet. Keep using the passphrase here." + stray);
  const pub = cred.response.getPublicKey ? cred.response.getPublicKey() : null;
  if (!pub) throw new Error("This device's passkey type isn't supported here.");
  let prf = ext?.results?.first, confirm;
  if (!prf) {
    pkStop(signal);
    await confirmStep();
    const c = await api('passkey/options', { purpose: 'confirm', registerChallenge: o.challenge });
    pkStop(signal);
    const g = await navigator.credentials.get({ publicKey: {
      challenge: pkBytes(c.challenge), rpId: c.rpId, timeout: c.timeout, userVerification: 'required',
      allowCredentials: [{ type: 'public-key', id: cred.rawId }],
      extensions: { prf: { eval: { first: pkBytes(c.prfSalt) } } },
    }, signal });
    prf = g.getClientExtensionResults().prf?.results?.first;
    if (!prf) throw new Error("This device didn't give the unlock secret, so it can't unlock the wallet." + stray);
    confirm = { challenge: c.challenge, clientDataJSON: pkB64u(g.response.clientDataJSON), authenticatorData: pkB64u(g.response.authenticatorData), signature: pkB64u(g.response.signature) };
  }
  pkStop(signal);
  return api('passkey/register', {
    passphrase, label, challenge: o.challenge,
    credential: {
      id: cred.id, clientDataJSON: pkB64u(cred.response.clientDataJSON), authenticatorData: pkB64u(cred.response.getAuthenticatorData()),
      publicKey: pkB64u(pub), publicKeyAlgorithm: cred.response.getPublicKeyAlgorithm(),
    },
    prf: pkB64u(prf), ...(confirm ? { confirm } : {}),
  });
}
function pkDeviceLabel(nav = navigator) {
  const ua = String((nav && nav.userAgent) || '');
  const plat = String((nav && nav.userAgentData && nav.userAgentData.platform) || '');
  if (/iPhone|iPod/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && nav.maxTouchPoints > 1)) return 'iPad';
  if (/^Android$/i.test(plat) || /Android/i.test(ua)) return 'Android phone';
  if (/^macOS$/i.test(plat) || /Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/^Windows$/i.test(plat) || /Windows/i.test(ua)) return 'Windows PC';
  if (/^(Linux|Chrome OS|Chromium OS)$/i.test(plat) || /Linux|X11|CrOS/i.test(ua)) return 'Linux computer';
  return 'This device';
}
// ── passkey helpers (end) ──

// The line under a bubble (msgTimeLabel / msgTimeLine): below its right edge for the person, its left edge for the
// agent. It sits outside the reply body, which repaints; '' removes it.
function setBubbleTime(el, text) {
  if (!el) return;
  let line = el.querySelector(':scope > .msg-time');
  if (!text) { if (line) line.remove(); el.classList.remove('has-time'); return; }
  if (!line) { line = document.createElement('div'); line.className = 'msg-time'; el.appendChild(line); }
  line.textContent = text;
  el.classList.add('has-time');
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
  bubbleHost().appendChild(d);
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
  bubbleHost().appendChild(d);
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
  const sp = e.target.closest('.speak');
  if (sp) { e.stopPropagation(); const m = sp.closest('.msg'); if (m) voiceSpeakToggle(m); return; }
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

function renderEntry(m, time = '') {
  if (m.role === 'user') {
    if (m.origin?.kind) addNote(`⚡ ${originLabel(m.origin)} — ${timeLabel(m.ts)}`);
    setBubbleTime(addUserBubble(m.content, null), time);
  } else if (m.role === 'assistant') {
    const saved = Array.isArray(m.activity) && m.activity.length;
    const b = addAssistantBubble(saved ? undefined : m.content);
    if (saved) paintSaved(b, m);
    if (typeof m.reasoning === 'string' && m.reasoning) reasoningSet({ agent: current, bubble: b }, m.reasoning, { total: Number(m.reasoningChars) });
    setBubbleTime(b.el, time);
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
  const times = msgTimeLines(chatHistory);   // the date and time under each message
  lastHistoryCard = null;
  if (foldAutoOn()) {
    for (const it of autoGroupHistory(chatHistory, start)) {
      if (it.type === 'entry') renderEntry(chatHistory[it.index], times[it.index]);
      else if (it.type === 'card') renderAutoCard(it, times);
      else if (it.type === 'stack') renderAutoStack(it, times);
    }
  } else {
    for (let i = start; i < chatHistory.length; i++) renderEntry(chatHistory[i], times[i]);
  }
  if (!chatHistory.length) addNote('No messages yet');
}

// Turns the hub starts by itself fold into closed cards; the setting is per device ('off' turns it off).
function foldAutoOn() {
  try { return localStorage.getItem('hub-fold-auto') !== 'off'; } catch { return true; }
}
function paintFoldMenu() {
  const b = $('menu-fold');
  if (b) b.textContent = `⇅ Fold automatic turns: ${foldAutoOn() ? 'On' : 'Off'}`;
}
function toggleFoldAuto() {
  $('menu').classList.remove('open');
  try { localStorage.setItem('hub-fold-auto', foldAutoOn() ? 'off' : 'on'); } catch { /* storage refused */ }
  paintFoldMenu();
  // A redraw would detach the live bubble of a hub turn this phone is following, so it waits like a stream does.
  const following = Object.values(hubTurns).some(t => t && t.agent === current && t.el && t.el.isConnected);
  if (current && !streams.has(current) && !reattaches.has(current) && !following) { stick = true; renderHistory(); scrollChat(true); }
  else toast(`Fold automatic turns: ${foldAutoOn() ? 'On' : 'Off'}`);
}

// A card header: a button (aria-expanded) that opens and closes the body next to it.
function makeFoldHeader(cls, label, time, line) {
  const wrap = document.createElement('div');
  wrap.className = 'auto-wrap';
  const head = document.createElement('button');
  head.type = 'button';
  head.className = cls;
  head.setAttribute('aria-expanded', 'false');
  const l = document.createElement('span'); l.className = 'auto-label'; l.textContent = label;
  head.appendChild(l);
  if (time) { const t = document.createElement('span'); t.className = 'auto-time'; t.textContent = time; head.appendChild(t); }
  const f = document.createElement('span'); f.className = 'auto-line'; f.textContent = line || '';
  head.appendChild(f);
  const c = document.createElement('span'); c.className = 'auto-chev'; c.textContent = '▸';
  head.appendChild(c);
  const body = document.createElement('div');
  body.className = 'auto-body';
  body.hidden = true;
  head.addEventListener('click', () => {
    const open = body.hidden;
    body.hidden = !open;
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    c.textContent = open ? '▾' : '▸';
  });
  wrap.append(head, body);
  return { wrap, head, body, line: f };
}

function addFromLine(label) {
  const d = document.createElement('div');
  d.className = 'auto-from';
  d.textContent = `from ${label}`;
  bubbleHost().appendChild(d);
  return d;
}

// The card's line once its reply left it (for_owner): the prompt's task line, else the label.
function promptCardLine(prompt, label) {
  const c = typeof prompt === 'string' ? prompt : '';
  const i = c.indexOf('\nTask:\n');
  return (i >= 0 && autoFirstLine(c.slice(i + 7))) || label;
}

// True when the card is the last thing in the chat (or the last card of a stack that is itself last). skip: a trailing
// element that does not count (the waiting bubble a re-attach drew after the card).
function cardIsLast(wrap, skip = null) {
  const box = chatEl();
  if (!box || !wrap || !wrap.isConnected) return false;
  const lastOf = (el) => {
    let l = el.lastElementChild;
    if (skip && l === skip) l = l.previousElementSibling || null;
    return l;
  };
  if (wrap.parentNode === box) return lastOf(box) === wrap;
  const body = wrap.parentNode;
  if (!body || body.lastElementChild !== wrap) return false;
  const stack = body.parentNode;
  return !!stack && stack.parentNode === box && lastOf(box) === stack;
}
// The hub clips a turn_start message to 12000 characters and ends it with this suffix.
const TURN_CLIP_SUFFIX = '\n…[truncated]';
// True when the saved prompt is the one the hub announced (whole, or its clipped start).
function samePrompt(saved, sent) {
  if (typeof saved !== 'string' || typeof sent !== 'string') return false;
  if (saved === sent) return true;
  // only the hub's own clipping (exactly 12000 characters and the suffix) counts as a clipped prompt
  const head = sent.slice(0, -TURN_CLIP_SUFFIX.length);
  return sent.endsWith(TURN_CLIP_SUFFIX) && head.length === 12000 && saved.length > 12000 && saved.startsWith(head);
}
// A remembered card is adopted only when its prompt was saved within 10 minutes of this turn starting.
function promptRecent(ts, startedAt) {
  const a = Date.parse(ts), b = Date.parse(startedAt);
  return !isNaN(a) && !isNaN(b) && Math.abs(a - b) <= 10 * 60 * 1000;
}

// One automatic turn as a closed card; the entries the agent marked for the owner follow it, open.
function renderAutoCard(it, times, host = chatEl()) {
  const card = makeFoldHeader(`auto-card auto-card-${autoCardKind(it.kind)}`, it.label, timeLabel(it.ts), it.firstLine);
  host.appendChild(card.wrap);
  const users = it.indexes.filter(k => chatHistory[k] && chatHistory[k].role === 'user');
  const lastUser = users[users.length - 1];
  lastHistoryCard = lastUser === undefined ? null : { wrap: card.wrap, body: card.body, line: card.line, label: it.label, prompt: chatHistory[lastUser].content, ts: chatHistory[lastUser].ts || null, agent: current };
  const open = new Set(it.open);
  withRenderTarget(card.body, () => { for (const i of it.indexes) if (!open.has(i)) renderEntry(chatHistory[i], times[i]); });
  withRenderTarget(host === chatEl() ? null : host, () => {
    for (const i of it.open) { addFromLine(it.label); renderEntry(chatHistory[i], times[i]); }
  });
}

// Three or more cards in a row: one line with a count; tapping it shows the cards, each still closed.
function renderAutoStack(it, times) {
  const st = makeFoldHeader('auto-stack', it.summary, '', '');
  chatEl().appendChild(st.wrap);
  for (const c of it.cards) renderAutoCard(c, times, st.body);
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
  if (typeof plusSheetShow === 'function') plusSheetShow(false);   // opening a chat closes the + sheet
  if (!same && voiceCall) voiceCallHangUp();   // switching to another agent's chat ends a hands-free call
  if (!same && tsnSheetFor) closeToolsSheet();   // the full screen of another chat's calls
  current = name;
  localStorage.setItem('hub-mobile-last', name);
  voiceStatusRefresh();   // the mic button shows only while the hub voice is on and ready
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
  if (!(last && last.role === 'user' && last.content === rec.text)) { rec.userEl = addUserBubble(rec.text, rec.images); setBubbleTime(rec.userEl, msgTimeLabel(rec.startedAt)); }
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

// A named agent by its name; a temporary worker or a Claude sub-agent by its label (its kind, "temporal" or
// "sdk-agent", says nothing to a person).
function workerName(it) {
  if (it.agent && agentByName(it.agent)) return displayName(it.agent);
  const label = String(it.description || '').replace(/^Worker:\s*/, '');
  return label || it.agent || 'worker';
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
    const guessed = !!(it.inferred || it.unknown);
    it.status = item.status === 'completed' ? 'completed' : item.status === 'failed' ? 'failed' : 'running';
    if (item.cancelled != null) it.cancelled = item.cancelled === true;   // stopped (by a person, or with its caller): not a failure
    it.unknown = false; it.inferred = false;   // the hub said how it is: no longer a guess
    if (it.status === 'running') it.t1 = null;
    else if (!it.t1 || guessed) it.t1 = Date.parse(item.doneTs) || it.t1 || Date.now();
    if (guessed && wkSeen.has(wid)) wkSeen.get(wid).endSeen = null;
    if (item.description) it.description = String(item.description);
    if (item.model) it.model = String(item.model);
    if (item.agent) it.agent = String(item.agent);
    if (item.error) it.error = String(item.error);
  } else {
    return null;
  }
  paintFeed(holder, it);
  if (it.kind === 'worker') { it.rev = (it.rev || 0) + 1; wkTrack(holder, it); }
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
  w.rev = (w.rev || 0) + 1;
  paintFeed(holder, w);
  if (wkView && wkView.mode === 'worker' && wkView.id === String(w.workerId)) wkPaintWorker();
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
  return `worker ${who} ${x.status === 'failed' ? (x.cancelled ? 'stopped' : 'failed') : x.unknown ? 'ended' : 'finished'}`;
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
  const mark = it.status === 'completed' ? (it.unknown ? '–' : '✓') : it.status === 'failed' ? (it.cancelled ? '■' : '✗') : '👷';
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
  const mark = it.status === 'completed' ? (it.unknown ? '–' : '✓') : it.status === 'failed' ? (it.cancelled ? '■' : '✗') : '👷';
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
// how: 'sure' when the turn is known to be over (the hub said so, or its stream ended with its final marker); 'maybe'
// when only this page's side ended (a person's Stop, a stream cut off without its final marker, giving up waiting):
// its workers then keep running here until the hub's record says how they ended.
function feedEnd(holder, how = 'sure') {
  const feed = holder && holder.feed;
  if (!feed) return;
  feed.ended = true;
  for (const x of feed.items.values()) {
    if (x.kind === 'tool' && x.status === 'running') x.status = 'done';
    if (x.kind === 'worker' && x.status === 'running') {   // over with its reply; how it ended is asked of the hub
      if (how === 'sure') { x.status = 'completed'; x.unknown = true; x.inferred = true; x.inferredAt = Date.now(); x.t1 = x.t1 || Date.now(); x.rev = (x.rev || 0) + 1; }
      wkInferEnd(wkSeen.get(String(x.workerId)), 1500, how === 'sure' ? 'sure' : 'maybe');
    }
  }
  paintFeed(holder);
  wkRefreshSoon();
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

// ── Workers: a chip under the chat's name, a full-screen list, each worker full screen, and the history ──────────
// The same list as the desktop's Workers button: running workers, finished ones for 2 minutes, failed ones until
// opened or 10 minutes (the newest 3). The chip shows while the list has workers; the history is also in the menu.
// Shared verbatim with lib/ui-worker-list.js and app.js (test/ui-worker-list.test.js keeps the three in step).
// ── worker list helpers (begin) ──
const WORKER_DONE_MS = 2 * 60 * 1000, WORKER_FAILED_MS = 10 * 60 * 1000, WORKER_FAILED_MAX = 3;
function workerListPick(entries, now, activeId) {
  const items = [], gone = [], failed = [];
  for (const e of entries || []) {
    if (!e) continue;
    const item = { ...e, endedAt: e.state === 'running' ? null : (e.endedAt || now) };
    if (e.state === 'running') items.push(item);
    else if (e.state === 'failed') failed.push(item);
    else if (e.id === activeId || now - item.endedAt < WORKER_DONE_MS) items.push(item);
    else gone.push(e.id);
  }
  failed.sort((a, b) => b.endedAt - a.endedAt);
  let kept = 0;
  for (const item of failed) {
    const waiting = !item.failSeen && now - item.endedAt < WORKER_FAILED_MS && kept < WORKER_FAILED_MAX;
    if (waiting) kept++;
    if (waiting || item.id === activeId) items.push(item); else gone.push(item.id);
  }
  items.sort((a, b) => ((b.state === 'running') - (a.state === 'running')) || ((b.endedAt || now) - (a.endedAt || now)) || ((b.startedAt || 0) - (a.startedAt || 0)));
  const counts = { running: 0, done: 0, failed: 0 };
  for (const i of items) counts[i.state === 'running' ? 'running' : i.state === 'failed' ? 'failed' : 'done']++;
  return { items, gone, counts, alert: items.some(i => i.state === 'failed' && !i.failSeen) };
}
function workerButtonLabel(counts) {
  if (!counts.running && !counts.done && !counts.failed) return 'Workers';
  return `${counts.running} working · ${counts.done} done${counts.failed ? ` · ${counts.failed} failed` : ''}`;
}
function fmtWorkerClock(ms) {
  const t = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
// ── worker list helpers (end) ──
// ── active agents helpers (begin) ──
function activeInitial() {
  return { rows: [] };
}
function activeIsWorker(name, entry) {
  return entry && typeof entry.worker === 'boolean' ? entry.worker : /^tw-/.test(name);
}
function activeBusyFrom(statusMap, localBusy, visibleNames) {
  const visible = new Set(visibleNames || []);
  const out = {};
  const mark = (name, iso) => {
    if (!visible.has(name)) return;
    const t = Date.parse(iso);
    const since = Number.isFinite(t) ? t : Date.now();
    out[name] = name in out ? Math.min(out[name], since) : since;
  };
  for (const [name, entry] of Object.entries(statusMap || {})) {
    if (!entry || !(entry.busy || entry.pendingQuestion)) continue;
    if (activeIsWorker(name, entry)) { if (entry.parent) mark(entry.parent, entry.busySince); }
    else mark(name, entry.busySince);
  }
  const local = localBusy instanceof Map ? [...localBusy.entries()] : Object.entries(localBusy || {});
  for (const [name, iso] of local) {
    const entry = (statusMap || {})[name];
    if (activeIsWorker(name, entry)) continue;
    mark(name, iso);
  }
  return out;
}
function activeJobsFrom(jobs, visibleNames) {
  const visible = new Set(visibleNames || []);
  const list = [];
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (!j || !j.owner || !visible.has(j.owner)) continue;
    if (j.status !== 'running' && j.status !== 'cancelling') continue;
    const t = typeof j.startedAt === 'number' ? j.startedAt : Date.parse(j.startedAt);
    list.push({ owner: j.owner, name: String(j.name == null ? '' : j.name).trim() || 'job', at: Number.isFinite(t) ? t : Date.now() });
  }
  list.sort((a, b) => a.at - b.at);                           // oldest first (the sort is stable)
  const out = {};
  for (const j of list) {
    const o = out[j.owner] || (out[j.owner] = { names: [], since: j.at, count: 0 });
    o.names.push(j.name); o.count++;
  }
  return out;
}
function activeJobTail(info, now) {
  if (!info || !info.count) return '';
  const m = Math.max(0, Math.floor(((now == null ? Date.now() : now) - info.since) / 60000));
  const t = m < 1 ? '<1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `${info.count > 1 ? ` + ${info.count - 1} more` : ''} \u00B7 ${t}`;
}
function activeJobLabel(info, now) {
  if (!info || !info.count) return '';
  return `${info.names[0]}${activeJobTail(info, now)}`;
}
function activeJobTitle(info) {
  return info && info.names ? info.names.join('\n') : '';
}
function activeStep(state, input) {
  const { busy = {}, jobs = {}, now = Date.now(), held = false, enabled = true, lingerMs = 3000 } = input || {};
  if (!enabled) return { rows: [] };
  const work = Object.assign({}, busy);                       // working: busy, or has a running job
  for (const n of Object.keys(jobs)) work[n] = n in work ? Math.min(work[n], jobs[n].since) : jobs[n].since;
  const prev = (state && state.rows) || [];
  const rows = [];
  for (const r of prev) {
    if (r.name in work) { rows.push({ name: r.name, since: Math.min(r.since, work[r.name]), doneAt: null, jobOnly: !(r.name in busy) }); continue; }
    const doneAt = r.doneAt == null ? now : r.doneAt;
    if (!held && now - doneAt >= lingerMs) continue;          // leaves the section
    rows.push({ name: r.name, since: r.since, doneAt, jobOnly: false });
  }
  if (held) return { rows };                                  // nothing joins while the list is held
  const have = new Set(rows.map(r => r.name));
  const joining = Object.keys(work).filter(n => !have.has(n)).map(n => ({ name: n, since: work[n], doneAt: null, jobOnly: !(n in busy) }));
  joining.sort((a, b) => (a.since - b.since) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { rows: rows.concat(joining) };
}
function activeChanged(a, b) {
  const x = (a && a.rows) || [], y = (b && b.rows) || [];
  if (x.length !== y.length) return true;
  for (let i = 0; i < x.length; i++) if (x[i].name !== y[i].name || (x[i].doneAt == null) !== (y[i].doneAt == null) || !!x[i].jobOnly !== !!y[i].jobOnly) return true;
  return false;
}
function activeMembersChanged(a, b) {
  const x = (a && a.rows) || [], y = (b && b.rows) || [];
  if (x.length !== y.length) return true;
  for (let i = 0; i < x.length; i++) if (x[i].name !== y[i].name) return true;
  return false;
}
function activeTitle(state) {
  return `Active ${((state && state.rows) || []).length}`;
}
// ── active agents helpers (end) ──
// ── busy and hub workers helpers (begin) ──
function busyIsWorker(name, entry) {
  return entry && typeof entry.worker === 'boolean' ? entry.worker : /^tw-/.test(name);
}
function busySplit(statusMap, localBusyNames) {
  const agents = new Set(), workers = new Set();
  for (const [name, entry] of Object.entries(statusMap || {})) {
    if (!entry || !(entry.busy || entry.pendingQuestion)) continue;
    (busyIsWorker(name, entry) ? workers : agents).add(name);
  }
  for (const name of localBusyNames || []) {
    const entry = (statusMap || {})[name];
    (busyIsWorker(name, entry) ? workers : agents).add(name);
  }
  return { agents: [...agents].sort(), workers: [...workers].sort() };
}
function busyChipLabel(split, filtering) {
  const a = split.agents.length, w = split.workers.length;
  if (!a && !w) return '';
  const parts = [];
  if (a) parts.push(`${a} agent${a === 1 ? '' : 's'}`);
  if (w) parts.push(`${w} worker${w === 1 ? '' : 's'}`);
  return `${parts.join(' · ')} working${filtering && a ? ' · showing only these ✕' : ''}`;
}
function fmtElapsedShort(ms) {
  if (ms == null || !(ms >= 0)) return '';
  const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
function hubWorkerGroups(statusMap, opts) {
  const { known = {}, skipIds = [], skipKeys = [], now } = opts || {};
  const byParent = new Map();
  const add = (parent, kind, id, label, entry) => {
    const startedAt = Date.parse(entry.busySince) || null;
    const item = { id, kind, label, model: entry.model || '', startedAt, elapsedMs: startedAt ? Math.max(0, now - startedAt) : null };
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(item);
  };
  for (const [name, entry] of Object.entries(statusMap || {})) {
    if (!entry || !entry.busy || skipIds.includes(name)) continue;
    if (busyIsWorker(name, entry)) add(entry.parent || null, 'temporary', name, entry.label || 'Worker', entry);
    else if (entry.consultedBy && !skipKeys.includes(`${entry.consultedBy}>${name}`)) add(entry.consultedBy, 'consulted', name, known[name] || name, entry);
  }
  const groups = [...byParent].map(([parent, items]) => {
    items.sort((x, y) => ((x.startedAt == null) - (y.startedAt == null)) || ((x.startedAt || 0) - (y.startedAt || 0)) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    return { parent, parentLabel: parent ? (known[parent] || parent) : 'Unknown agent', items };
  });
  groups.sort((x, y) => ((x.parent == null) - (y.parent == null)) || x.parentLabel.localeCompare(y.parentLabel));
  return groups;
}
function hubWorkerCount(groups) {
  return (groups || []).reduce((n, g) => n + g.items.length, 0);
}
function workerGoneStep(prev, opts) {
  const { running, statusMap, now, graceMs = 15000, confirmMs = 4000 } = opts || {};
  const before = prev || {}, map = statusMap || {}, next = {}, gone = [];
  for (const w of running || []) {
    const id = w && w.id;
    if (typeof id !== 'string' || !/^tw-/.test(id)) continue;
    const entry = map[id];
    if (entry && (entry.busy || entry.pendingQuestion)) continue;
    const startedAt = Number.isFinite(w.startedAt) ? w.startedAt : now;
    if (now - startedAt < graceMs) continue;
    if (id in before && now - before[id] >= confirmMs) gone.push(id);
    else next[id] = id in before ? before[id] : now;
  }
  return { next, gone: gone.sort() };
}
// ── busy and hub workers helpers (end) ──

// The workers this page saw start or run (live replies and catch-ups; saved replies are history, not listed):
// workerId -> { id, it (its feed row), agent (whose chat it works in), failSeen, endSeen, lastStatus }.
const wkSeen = new Map();
let wkView = null;   // the sheet on screen: { mode: 'list' | 'worker' | 'history' | 'run', id?, run?, w?, back? }
let wkTimer = null;
function wkTrack(holder, it) {
  if (!it || it.kind !== 'worker') return;
  const id = String(it.workerId);
  let e = wkSeen.get(id);
  if (!e) { e = { id, it, agent: (holder && holder.agent) || current, failSeen: false, endSeen: null, lastStatus: null }; wkSeen.set(id, e); }
  e.it = it;
  if (holder) { e.holder = holder; if (holder.turnId) e.turnId = holder.turnId; }
  if (it.status === 'failed' && e.lastStatus !== 'failed') e.failSeen = !!(wkView && wkView.mode === 'worker' && wkView.id === id);   // watched as it failed: seen
  e.lastStatus = it.status;
  wkRefreshSoon();
}
const wkState = (it) => (it.status === 'running' ? 'running' : it.status === 'failed' ? (it.cancelled ? 'stopped' : 'failed') : it.unknown ? 'ended' : 'done');
function wkPick() {
  const now = Date.now();
  const entries = [...wkSeen.values()].map(e => {
    const state = wkState(e.it);
    if (state === 'running') e.endSeen = null; else if (!e.endSeen) e.endSeen = e.it.t1 || now;
    return { id: e.id, e, state, startedAt: e.it.t0 || 0, endedAt: state === 'running' ? null : e.endSeen, failSeen: e.failSeen };
  });
  return workerListPick(entries, now, wkView && wkView.mode === 'worker' ? wkView.id : null);
}
function wkRefreshSoon() { if (!wkTimer) wkTimer = setTimeout(() => { wkTimer = null; wkRefresh(); }, 60); }
// The end of one of a caller's turns: its workers this page still shows running are asked about. Only a worker of that
// very turn may read "ended" without a recorded outcome; one of another or an unknown turn ends only on a recorded
// outcome; one whose reply this page is still streaming is left to that stream's own end.
function wkSettleAgent(agent, turnId) {
  for (const e of wkSeen.values()) {
    if (e.agent !== agent || e.it.status !== 'running') continue;
    if (streams.get(agent) === e.holder) continue;
    if (e.checking) e.again = true;   // a check already out may be answered from before this end: ask once more after it
    wkInferEnd(e, 1500, turnId && e.turnId === turnId ? 'sure' : 'maybe');
  }
}
// An end the page did not see is checked against the caller's worker history, which records how every worker of a
// turn ended. how: 'sure' (its reply or its own turn ended), 'gone' (the hub says it runs nothing under that id) or
// 'maybe' (its caller sat idle, or another turn of its caller ended); the strongest reason since the last answer counts.
// - a recorded outcome: that outcome and its real end time;
// - recorded as still running: running (provisional ends undone), unless the hub said it is not running;
// - no record of it (the route's own 404): "ended", outcome unknown, when 'sure' or 'gone'; otherwise unchanged;
// - no usable answer (offline, a server error, anything else): unchanged, asked again a minute later.
const WK_HOW = { maybe: 0, sure: 1, gone: 2 };
function wkInferEnd(e, delay = 0, how = 'maybe') {
  if (!e) return;
  if (!e.how || WK_HOW[how] > WK_HOW[e.how]) e.how = how;
  if (e.checking) return;
  e.checking = true; e.again = false;
  setTimeout(async () => {
    let w = null, answer = 'none';
    try {
      const res = await api(`/api/agents/${encodeURIComponent(e.agent)}/workers/${encodeURIComponent(e.id)}`, { signal: AbortSignal.timeout(10000) });
      const d = await res.json().catch(() => null);
      if (res.ok && d && d.worker) { w = d.worker; answer = 'worker'; }
      else if (res.status === 404 && d && /no such worker/i.test(String(d.error || ''))) answer = 'missing';
    } catch {}
    e.checking = false;
    const it = e.it, now = Date.now();
    if (!it.inferred && it.status !== 'running') { e.how = null; return; }   // its real end arrived meanwhile
    if (answer === 'none') { e.recheckAt = now + 60000; return; }
    const why = e.how || 'maybe';
    e.how = null;
    const ended = (o) => {
      it.status = o && o !== 'done' ? 'failed' : 'completed';
      it.cancelled = o === 'stopped';
      it.unknown = !o;
      it.inferred = false;
      if (w && w.error && !it.error) it.error = String(w.error);
      if (o === 'unfinished' && !it.error) it.error = "Did not finish: its caller's reply ended first";
      const at = w && w.startedAt && w.durationMs != null ? Date.parse(w.startedAt) + w.durationMs : null;
      it.t1 = at || it.t1 || now;
      e.endSeen = null;   // the list's clock runs from the real end
      if (it.status === 'failed' && wkView && wkView.mode === 'worker' && wkView.id === e.id) e.failSeen = true;   // watched as it was learned
      e.lastStatus = it.status;
    };
    if (answer === 'worker' && w.outcome) ended(w.outcome);
    else if (answer === 'worker' && why !== 'gone') {   // still running by its record
      if (it.inferred) { it.status = 'running'; it.t1 = null; it.unknown = false; it.inferred = false; }
      e.recheckAt = now + 60000;
      if (e.again) { e.again = false; wkInferEnd(e, 1500, why); }
    } else if (why !== 'maybe') ended(null);
    else {   // no record, and nothing says its turn is over: unchanged
      e.recheckAt = now + 60000;
      if (e.again) { e.again = false; wkInferEnd(e, 1500, why); }
      return;
    }
    it.rev = (it.rev || 0) + 1;
    if (e.holder) paintFeed(e.holder, it);
    wkRefreshSoon();
  }, delay);
}
// The workers running hub-wide (from the status feed) that no card of this page already shows, grouped by the agent
// that started them.
function wkHubGroups() {
  const known = {};
  for (const a of agents) known[a.name] = displayName(a.name);
  const skipIds = [], skipKeys = [];
  for (const e of wkSeen.values()) {
    if (e.it.status !== 'running') continue;
    skipIds.push(e.id);
    if (e.it.agent && agentByName(e.it.agent)) skipKeys.push(`${e.agent}>${e.it.agent}`);
  }
  return hubWorkerGroups(live, { known, skipIds, skipKeys, now: Date.now() });
}
// A light poll of the status feed while the Workers sheet is open or someone is busy with a worker or a consultation.
let wkHubPolling = false, wkHubSoon = 0;
async function wkHubPoll() {
  if (wkHubPolling) return;
  wkHubPolling = true;
  try {
    const r = await api('/api/agents/status', { signal: AbortSignal.timeout(8000) });
    if (r.ok) { const d = await r.json(); if (d && d.agents) { applySnapshot(d.agents); wkRefreshSoon(); } }
  } catch {} finally { wkHubPolling = false; }
}
function wkHubPollSoon() {
  if (wkHubSoon) return;
  wkHubSoon = setTimeout(() => { wkHubSoon = 0; wkHubPoll(); }, 800);
}
setInterval(() => {
  if (document.hidden) return;
  if ((wkView && wkView.mode === 'list') || Object.entries(live).some(([n, s]) => s && s.busy && (busyIsWorker(n, s) || s.consultedBy))
    || [...wkSeen.values()].some(e => e.it && e.it.status === 'running' && /^tw-/.test(e.id))) wkHubPoll();
}, 5000);
function wkRefresh() {
  const now = Date.now();
  for (const e of wkSeen.values()) {
    if (e.it.inferred) { if (now >= (e.recheckAt || 0)) wkInferEnd(e, 0, 'sure'); continue; }   // an end still being checked
    if (!statusKnown || e.it.status !== 'running' || isBusy(e.agent)) { e.idleSince = 0; continue; }
    if (!e.idleSince) e.idleSince = now;   // its caller sat idle 12 s: the page may have slept through its end
    else if (now - e.idleSince >= 12000 && now >= (e.recheckAt || 0)) wkInferEnd(e, 0, 'maybe');
  }
  const { items, gone, counts, alert } = wkPick();
  for (const id of gone) {
    const g = wkSeen.get(id);
    if (g && g.it.inferred && now - (g.it.inferredAt || now) < 10 * 60000) continue;   // kept, unlisted, while its end is checked
    wkSeen.delete(id);
  }
  const hubGroups = wkHubGroups(), hubCount = hubWorkerCount(hubGroups);
  const btn = $('chat-workers-btn');
  if (btn) {
    btn.hidden = !items.length && !hubCount;
    btn.querySelector('.wb-label').textContent = workerButtonLabel({ ...counts, running: counts.running + hubCount });
    btn.classList.toggle('busy', counts.running + hubCount > 0);
    btn.classList.toggle('alert', alert);
  }
  if (wkView && wkView.mode === 'list') wkPaintList(items, hubGroups);
  else if (wkView && wkView.mode === 'worker') wkPaintWorker();
}
setInterval(wkRefresh, 5000);

const wkName = (it) => workerName(it);
const wkKind = (agent) => (agent === 'temporal' || !agent || agent === 'worker' ? 'temporary' : agent === 'sdk-agent' ? 'sub-agent' : (agentByName(agent) ? displayName(agent) : agent));
const wkEl = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };

function wkSheet() {
  let sh = $('wk-sheet');
  if (sh) return sh;
  sh = document.createElement('div');
  sh.id = 'wk-sheet';
  sh.className = 'rsn-sheet wk-sheet';
  sh.dataset.noDirty = '';   // its search box and picker hold nothing to lose
  sh.setAttribute('role', 'dialog');
  sh.setAttribute('aria-modal', 'true');
  sh.setAttribute('aria-label', 'Workers');
  sh.innerHTML = '<div class="rsn-sheet-head"><button type="button" class="wk-back" aria-label="Back">&#x2039;</button><span class="rsn-sheet-title"></span><span class="rsn-sheet-count"></span>' +
    '<button type="button" class="rsn-sheet-close" aria-label="Close">&#x2715;</button></div><div class="wk-body" tabindex="-1"></div>';
  sh.querySelector('.rsn-sheet-close').addEventListener('click', wkClose);
  sh.querySelector('.wk-back').addEventListener('click', () => wkShow((wkView && wkView.back) || { mode: 'list' }));
  sh.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); wkClose(); } });
  document.body.appendChild(sh);
  return sh;
}
function openWorkerSheet(mode = 'list') {
  $('menu').classList.remove('open');
  const sh = wkSheet();
  if (!sh.classList.contains('open')) { sh.classList.add('open'); dialogGuard.open(sh, { close: wkClose }); }   // Back and Esc close it first
  wkShow({ mode });
}
function wkClose() {
  const sh = $('wk-sheet');
  if (sh) { sh.classList.remove('open'); dialogGuard.closed(sh); }
  wkView = null;
  wkHist.openSeq++;
  wkRefreshSoon();
}
function wkShow(view) {
  wkView = view;
  wkHist.openSeq++;   // a pending "Open full run" never takes the screen from what the person went to
  const sh = wkSheet();
  sh.querySelector('.wk-back').hidden = view.mode === 'list';
  sh.querySelector('.rsn-sheet-title').textContent = { list: 'Workers', worker: 'Worker', history: 'Worker history', run: 'Worker · history' }[view.mode];
  sh.querySelector('.rsn-sheet-count').textContent = '';
  const body = sh.querySelector('.wk-body');
  body.textContent = '';
  delete body.dataset.key;   // a worker shown before is painted again, not skipped as unchanged
  body.scrollTop = 0;
  if (view.mode === 'list') wkRefresh();
  else if (view.mode === 'worker') { const e = wkSeen.get(view.id); if (e && e.it.status === 'failed') e.failSeen = true; wkPaintWorker(); wkRefreshSoon(); }
  else if (view.mode === 'history') wkHistoryShow();
  else if (view.mode === 'run') wkPaintRun(view.run, view.w);
}

// The list: one row per worker; a tap opens it full screen; running ones (not a Claude sub-agent, which stops with its
// caller's reply) have Stop.
function wkPaintList(items, hubGroups = []) {
  const body = $('wk-sheet') && $('wk-sheet').querySelector('.wk-body');
  if (!body) return;
  const now = Date.now();
  const scroll = body.scrollTop, act = document.activeElement;
  const focused = act && act !== body && body.contains(act) ? { id: act.closest('.wk-row') ? act.closest('.wk-row').dataset.wid : null, hubId: act.closest('.wk-hub') ? act.closest('.wk-hub').dataset.hubId : null, stop: act.classList.contains('wk-stop'), all: act.classList.contains('wk-history') } : null;
  body.textContent = '';
  if (!items.length && !hubGroups.length) body.appendChild(wkEl('div', 'wk-empty', 'Nothing working right now.'));
  for (const { id, e, state, endedAt } of items) {
    const it = e.it;
    const row = wkEl('div', `wk-row wk-${state}` + (state === 'failed' && !e.failSeen ? ' wk-unseen' : ''));
    row.dataset.wid = id;
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    const mark = wkEl('span', 'wk-mark', state === 'running' ? '' : state === 'failed' ? '✕' : state === 'stopped' ? '■' : state === 'ended' ? '–' : '✓');
    const name = wkEl('span', 'wk-name', wkName(it));
    const when = wkEl('span', 'wk-when', state === 'running' ? fmtWorkerClock(now - (it.t0 || now)) : `${state} ${fmtWorkerClock(now - endedAt)} ago`);
    const meta = wkEl('span', 'wk-meta', [it.model ? shortModel(it.model) : '', wkKind(it.agent), e.agent && e.agent !== current ? `for ${displayName(e.agent)}` : ''].filter(Boolean).join(' · '));
    row.append(mark, name, when, meta);
    if (state === 'running' && it.agent !== 'sdk-agent') {
      const stop = wkEl('button', 'wk-stop', '■');
      stop.type = 'button';
      stop.setAttribute('aria-label', 'Stop this worker');
      stop.addEventListener('click', (ev) => { ev.stopPropagation(); wkStop(e); });
      row.appendChild(stop);
    }
    row.addEventListener('click', () => wkShow({ mode: 'worker', id, back: { mode: 'list' } }));
    row.addEventListener('keydown', (ev) => { if (ev.target === row && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); row.click(); } });
    body.appendChild(row);
  }
  for (const g of hubGroups) {
    body.appendChild(wkEl('div', 'wk-group', `Started by ${g.parentLabel}`));
    for (const item of g.items) {
      const row = wkEl('div', 'wk-row wk-running wk-hub');
      row.dataset.hubId = item.id;
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      if (!g.parent) row.title = 'The agent that started it is not known';
      row.append(wkEl('span', 'wk-mark', ''), wkEl('span', 'wk-name', item.label), wkEl('span', 'wk-when', fmtElapsedShort(item.elapsedMs)),
        wkEl('span', 'wk-meta', (item.model ? shortModel(item.model) + ' · ' : '') + (item.kind === 'consulted' ? 'consulted' : 'temporary')));
      row.addEventListener('click', () => { if (g.parent) wkOpenHub(g.parent, item); });
      row.addEventListener('keydown', (ev) => { if (ev.target === row && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); row.click(); } });
      body.appendChild(row);
    }
  }
  const all = wkEl('button', 'wk-history', 'All worker history →');
  all.type = 'button';
  all.addEventListener('click', () => wkShow({ mode: 'history', back: { mode: 'list' } }));
  body.appendChild(all);
  body.scrollTop = scroll;
  if (focused) {   // the 5-second repaint keeps the keyboard where it was
    const row = focused.hubId ? [...body.querySelectorAll('.wk-hub')].find(r => r.dataset.hubId === focused.hubId)
      : focused.id ? [...body.querySelectorAll('.wk-row')].find(r => r.dataset.wid === focused.id) : null;
    const to = focused.all ? all : (focused.stop && row && row.querySelector('.wk-stop')) || row || all;
    try { to.focus({ preventScroll: true }); } catch {}
  }
}
// A hub-wide row: open the chat of the agent that started it and, once this page follows the turn and sees the worker,
// open that worker's view; else the chat stays open.
let wkOpenSeq = 0;
function wkOpenHub(parent, item) {
  const seq = ++wkOpenSeq;
  wkClose();
  openChat(parent);
  const started = Date.now();
  const find = () => item.kind === 'temporary' ? wkSeen.get(item.id)
    : [...wkSeen.values()].find(e => e.it.status === 'running' && e.agent === parent && e.it.agent === item.id);
  const look = () => {
    if (seq !== wkOpenSeq || current !== parent || wkView !== null) return;
    const e = find();
    if (e) { openWorkerSheet('list'); wkShow({ mode: 'worker', id: e.id, back: { mode: 'list' } }); return; }
    if (Date.now() - started < 6000) setTimeout(look, 300);
  };
  setTimeout(look, 300);
}
async function wkStop(e) {
  try {
    const res = await api('/api/cancel-worker', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ worker_id: e.id, agent: e.agent || undefined }) });
    const r = await res.json().catch(() => null);
    if (!r || !r.success) {
      // the hub runs nothing under that id any more: it ended where this page did not see it
      if (res.status === 404 && r && /not running/i.test(String(r.error || ''))) wkInferEnd(e, 0, 'gone');
      else toast((r && (r.error || r.message)) || 'Could not stop that worker');
    }
  } catch { toast('Could not reach the hub'); }
}

// One worker full screen, live: how it is doing, its tool calls, its words so far.
function wkPaintWorker() {
  const sh = $('wk-sheet');
  const e = wkView && wkSeen.get(wkView.id);
  if (!sh || !e) return;
  const it = e.it, state = wkState(it), now = Date.now();
  sh.querySelector('.rsn-sheet-title').textContent = wkName(it);
  sh.querySelector('.rsn-sheet-count').textContent = [it.model ? shortModel(it.model) : '', state === 'running' ? fmtWorkerClock(now - (it.t0 || now)) : state].filter(Boolean).join(' · ');
  const body = sh.querySelector('.wk-body');
  const key = `${e.id}|${it.rev || 0}|${state}`;   // every change to the worker bumps its revision
  if (body.dataset.key === key) return;
  const fresh = !String(body.dataset.key || '').startsWith(`${e.id}|`);   // just opened: start at the top
  body.dataset.key = key;
  const scroll = body.scrollTop, atEnd = !fresh && body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  const onStop = !!(document.activeElement && body.contains(document.activeElement) && document.activeElement.classList.contains('wk-stop-one'));
  body.textContent = '';
  const head = wkEl('div', 'wk-sub', [wkKind(it.agent), `for ${displayName(e.agent || current || '')}`].filter(Boolean).join(' · '));
  body.appendChild(head);
  if (it.error) body.appendChild(wkEl('div', 'wk-error', it.error));
  if (state === 'running' && it.agent !== 'sdk-agent') {
    const stop = wkEl('button', 'wk-btn wk-stop-one', 'Stop this worker');
    stop.type = 'button';
    stop.addEventListener('click', () => wkStop(e));
    body.appendChild(stop);
    if (onStop) { try { stop.focus({ preventScroll: true }); } catch {} }
  } else if (onStop) { try { body.focus({ preventScroll: true }); } catch {} }   // it ended under the keyboard: stay in the sheet
  if (it.tools.length) {
    body.appendChild(wkEl('div', 'wk-label', `${it.tools.length} tool call${it.tools.length === 1 ? '' : 's'}`));
    for (const t of it.tools) body.appendChild(wkEl('div', 'wk-tool', `⚙ ${t.tool}${t.summary ? ` · ${clipText(t.summary, 200)}` : ''}`));
  }
  if (it.text) {
    body.appendChild(wkEl('div', 'wk-label', state === 'running' ? 'So far' : 'Answer'));
    const text = wkEl('div', 'wk-text');
    text.innerHTML = formatContent(it.text);
    body.appendChild(text);
    renderVisualBlocks(text);
  } else if (state === 'running') body.appendChild(wkEl('div', 'wk-empty', 'Working…'));
  body.scrollTop = fresh ? 0 : atEnd ? body.scrollHeight : scroll;   // following the end keeps following it; reading higher up stays put
}

// ── Worker history: the part-7 API (GET /api/agents/<a>/workers, /api/workers, /api/agents/<a>/workers/<id>) ──
// gen: a new search, filter or caller (only then are answers for the old view dropped); listReq: the newest list
// request; openSeq: the newest "Open full run"; runReq: the newest fetch of each run.
const wkHist = { caller: null, q: '', filter: 'all', items: [], next: null, loading: false, open: new Set(), runs: new Map(), error: '', gen: 0, listReq: 0, openSeq: 0, runReq: new Map() };
async function wkJson(url) {
  const res = await api(url);
  let data = {}; try { data = await res.json(); } catch {}
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
function wkHistoryShow() {
  const body = $('wk-sheet').querySelector('.wk-body');
  if (!wkHist.caller || (wkHist.caller !== '*' && !agentByName(wkHist.caller))) wkHist.caller = current || (isAdmin() ? '*' : ((agents[0] || {}).name || '*'));
  const q = wkEl('input', 'wk-q');
  q.type = 'search'; q.placeholder = 'Search briefs and results…'; q.autocomplete = 'off'; q.enterKeyHint = 'search'; q.value = wkHist.q;
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); wkHist.q = q.value.trim(); q.blur(); wkLoad(true); } });
  const chips = wkEl('div', 'wk-filters');
  for (const [v, label] of [['all', 'All'], ['named', 'Named agents'], ['temporary', 'Temporary'], ['failed', 'Failed']]) {
    const c = wkEl('button', 'wk-chip-f' + (wkHist.filter === v ? ' on' : ''), label);
    c.type = 'button';
    c.addEventListener('click', () => { wkHist.filter = v; chips.querySelectorAll('.wk-chip-f').forEach(x => x.classList.toggle('on', x === c)); wkLoad(true); });
    chips.appendChild(c);
  }
  const pick = wkEl('select', 'wk-caller');
  pick.setAttribute('aria-label', 'Whose workers');
  const opts = (isAdmin() ? [['*', 'Called by: all agents']] : []).concat(agents.map(a => [a.name, `Called by: ${a.display || a.name}`]));
  for (const [v, label] of opts) { const o = wkEl('option', null, label); o.value = v; pick.appendChild(o); }
  pick.value = opts.some(o => o[0] === wkHist.caller) ? wkHist.caller : (opts[0] || [''])[0];
  wkHist.caller = pick.value;
  pick.addEventListener('change', () => { wkHist.caller = pick.value; wkLoad(true); });
  chips.appendChild(pick);
  body.append(q, chips, wkEl('div', 'wk-hlist'), wkEl('div', 'wk-status'));
  body.querySelector('.wk-hlist').id = 'wk-hlist';
  body.querySelector('.wk-status').id = 'wk-hstatus';
  if (wkView.keep && (wkHist.items.length || wkHist.loading)) { wkHistoryRender(); body.scrollTop = wkView.scroll || 0; }   // Back from an old run: the list as it was
  else wkLoad(true);   // any other opening loads it afresh
}
async function wkLoad(reset) {
  if (!reset && (wkHist.loading || !wkHist.next)) return;
  if (reset) { wkHist.gen++; wkHist.items = []; wkHist.next = null; wkHist.open.clear(); wkHist.runs.clear(); }
  const gen = wkHist.gen, req = ++wkHist.listReq;
  wkHist.loading = true; wkHist.error = '';
  wkHistoryRender();
  const params = new URLSearchParams({ filter: wkHist.filter, limit: '50' });
  if (wkHist.q) params.set('q', wkHist.q);
  if (!reset) params.set('before', wkHist.next);
  const base = wkHist.caller === '*' ? '/api/workers' : `/api/agents/${encodeURIComponent(wkHist.caller)}/workers`;
  let data = null, error = '';
  try { data = await wkJson(`${base}?${params.toString()}`); } catch (e) { error = e.message; }
  if (gen !== wkHist.gen || req !== wkHist.listReq) return;   // superseded
  if (data) { wkHist.items = wkHist.items.concat(Array.isArray(data.workers) ? data.workers : []); wkHist.next = data.next || null; }
  wkHist.error = error;
  wkHist.loading = false;
  wkHistoryRender();
  // a page that came back short with more behind it (the hub stopped looking part-way): ask for the rest
  if (data && wkHist.next && (data.workers || []).length < 10 && wkView && wkView.mode === 'history') wkLoad(false);
}
function wkDay(iso) {
  const d = new Date(iso), today = new Date();
  const key = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const y = new Date(today); y.setDate(today.getDate() - 1);
  if (key(d) === key(today)) return 'Today';
  if (key(d) === key(y)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}
const wkMarkOf = (o) => (o === 'done' ? '✓' : o === 'stopped' ? '■' : o === 'failed' || o === 'unfinished' ? '✕' : '●');
function wkHistoryRender() {
  const list = $('wk-hlist'), status = $('wk-hstatus');
  if (!list || !wkView || wkView.mode !== 'history') return;
  // a repaint (a page or a run arriving) keeps the keyboard on the same item, or the same button in its detail
  const act = document.activeElement, actItem = act && list.contains(act) ? act.closest('.wk-hitem') : null;
  const keep = actItem ? { key: actItem.dataset.key, head: act.classList.contains('wk-htop'), act: act.dataset.act || null } : (act && act.classList && act.classList.contains('wk-more') && list.contains(act) ? { more: true } : null);
  list.textContent = '';
  let day = null;
  for (const w of wkHist.items) {
    const label = wkDay(w.startedAt);
    if (label !== day) { day = label; list.appendChild(wkEl('div', 'wk-day', label)); }
    const key = `${w.caller}|${w.workerId}`;
    const item = wkEl('div', `wk-hitem wk-o-${w.outcome || 'running'}` + (wkHist.open.has(key) ? ' open' : ''));
    item.dataset.key = key;
    const top = wkEl('div', 'wk-htop');
    top.append(wkEl('span', 'wk-mark', wkMarkOf(w.outcome)), wkEl('span', 'wk-name', String(w.description || 'Worker').replace(/^Worker:\s*/, '')),
      wkEl('span', 'wk-when', new Date(w.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + (w.durationMs != null ? ` · ${fmtWorkerClock(w.durationMs)}` : w.outcome ? '' : ' · running')));
    const sub = wkEl('div', 'wk-meta', [w.model ? shortModel(w.model) : '', w.kind === 'agent' ? wkKind(w.agentType) : w.kind, `called by ${displayName(w.caller)}`].filter(Boolean).join(' · ')
      + (w.answer ? ` · “${w.answer.replace(/\s+/g, ' ').slice(0, 90)}”` : w.error ? ` · ${w.error}` : ''));
    item.append(top, sub);
    if (wkHist.open.has(key)) item.appendChild(wkDetail(w, key));
    top.setAttribute('role', 'button');
    top.tabIndex = 0;
    top.setAttribute('aria-expanded', String(wkHist.open.has(key)));
    item.addEventListener('click', (ev) => {
      if (ev.target.closest('.wk-detail')) return;
      if (wkHist.open.has(key)) wkHist.open.delete(key); else { wkHist.open.add(key); wkFetchRun(w); }
      wkHistoryRender();
    });
    top.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); top.click(); } });
    list.appendChild(item);
  }
  if (wkHist.next && !wkHist.loading) {
    const more = wkEl('button', 'wk-btn wk-more', 'Show 50 more');
    more.type = 'button';
    more.addEventListener('click', () => wkLoad(false));
    list.appendChild(more);
  }
  if (keep) {
    const item = keep.key ? [...list.querySelectorAll('.wk-hitem')].find(x => x.dataset.key === keep.key) : null;
    let to = null;
    if (item && keep.head) to = item.querySelector('.wk-htop');
    else if (item) to = (keep.act && [...item.querySelectorAll('button')].find(b => b.dataset.act === keep.act)) || item.querySelector('.wk-htop');
    else if (keep.more) to = list.querySelector('.wk-more') || [...list.querySelectorAll('.wk-htop')].pop() || null;   // while the next page loads: the last item
    if (to) { try { to.focus({ preventScroll: true }); } catch {} }
  }
  status.textContent = wkHist.loading ? 'Loading…' : wkHist.error ? `Could not load the history: ${wkHist.error}` : !wkHist.items.length ? (wkHist.q || wkHist.filter !== 'all' ? 'No workers match.' : 'No workers yet.') : '';
}
function wkDetail(w, key) {
  const box = wkEl('div', 'wk-detail');
  const run = wkHist.runs.get(key);
  const cur = (run && run.worker) || w;   // one snapshot: the fetched run once it is here
  const section = (title, text, cls) => { if (!text) return; box.append(wkEl('div', 'wk-label', title), wkEl('div', 'wk-text' + (cls ? ` ${cls}` : ''), text)); };
  section('Brief', cur.prompt || cur.description);
  section(cur.partial ? 'Result (partial: it did not finish)' : 'Result', cur.answer || (cur.outcome ? '(no answer)' : '(still running)'));
  if (cur.error) section('Error', cur.error, 'wk-error');
  if (run && run.rows) {
    const uses = run.rows.filter(r => r.kind === 'tool_use');
    const by = {};
    for (const u of uses) by[u.tool] = (by[u.tool] || 0) + 1;
    section('Work', uses.length ? `${uses.length} tool call${uses.length === 1 ? '' : 's'}: ${Object.entries(by).map(([t, n]) => `${t} ${n}`).join(', ')}` : 'No tool calls');
  } else section('Work', run && run.error ? `Could not load its steps: ${run.error}` : 'Loading…');
  const actions = wkEl('div', 'wk-actions');
  const open = wkEl('button', 'wk-btn', 'Open full run');
  open.type = 'button';
  open.dataset.act = 'open';
  open.addEventListener('click', () => wkOpenRun(w));
  const copy = wkEl('button', 'wk-btn secondary', 'Copy result');
  copy.type = 'button';
  copy.dataset.act = 'copy';
  copy.disabled = !cur.answer;
  copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(cur.answer || ''); copy.textContent = 'Copied'; } catch { copy.textContent = 'Could not copy'; } });
  actions.append(open, copy);
  box.appendChild(actions);
  return box;
}
// A run is kept for reuse only once it is over and its answer is in (a sub-agent's answer can come after its end).
async function wkFetchRun(w, { fresh = false } = {}) {
  const key = `${w.caller}|${w.workerId}`;
  const had = wkHist.runs.get(key);
  const settled = had && !had.error && had.worker && had.worker.outcome && (had.worker.answer || Date.now() - (had.at || 0) < 15000);
  if (settled && !fresh) return had;
  const gen = wkHist.gen;
  const req = (wkHist.runReq.get(key) || 0) + 1;
  wkHist.runReq.set(key, req);
  let got;
  try { got = { ...(await wkJson(`/api/agents/${encodeURIComponent(w.caller)}/workers/${encodeURIComponent(w.workerId)}`)), at: Date.now() }; }
  catch (e) { got = { error: e.message, at: Date.now() }; }
  if (gen !== wkHist.gen) return null;
  if (wkHist.runReq.get(key) === req) { wkHist.runs.set(key, got); wkHistoryRender(); }
  return got;
}
async function wkOpenRun(w) {
  const mine = ++wkHist.openSeq;
  const run = await wkFetchRun(w, { fresh: true });
  if (mine !== wkHist.openSeq || !run || !run.rows) return;   // a later open, or the person went elsewhere
  const scroll = $('wk-sheet') ? $('wk-sheet').querySelector('.wk-body').scrollTop : 0;
  wkShow({ mode: 'run', run, w: { ...w, ...(run.worker || {}) }, back: { mode: 'history', keep: true, scroll, back: wkView && wkView.back } });
}
// An old worker full screen, as it ran: its brief, each step, its answer and how it ended.
function wkPaintRun(run, w) {
  const sh = $('wk-sheet');
  if (!sh || !run) return;
  sh.querySelector('.rsn-sheet-title').textContent = String(w.description || 'Worker').replace(/^Worker:\s*/, '');
  sh.querySelector('.rsn-sheet-count').textContent = [w.model ? shortModel(w.model) : '', w.durationMs != null ? fmtWorkerClock(w.durationMs) : ''].filter(Boolean).join(' · ');
  const body = sh.querySelector('.wk-body');
  body.textContent = '';
  body.appendChild(wkEl('div', 'wk-sub', `called by ${displayName(w.caller)} · ${new Date(w.startedAt).toLocaleString()}`));
  body.append(wkEl('div', 'wk-label', 'Brief'), wkEl('div', 'wk-text', w.prompt || w.description || '(no brief)'));
  const steps = run.rows.filter(r => r.kind === 'tool_use' || (r.kind === 'tool_result' && r.tool !== 'worker_answer'));
  if (steps.length) {
    body.appendChild(wkEl('div', 'wk-label', 'Steps'));
    for (const r of steps) {
      if (r.kind === 'tool_use') {
        const tool = String(r.tool || 'tool'), text = String(r.text || '');
        body.appendChild(wkEl('div', 'wk-tool', `⚙ ${tool}${text.startsWith(tool) ? ` ${text.slice(tool.length).trim()}` : ` ${text}`}`.slice(0, 600)));
      } else {
        const out = wkEl('details', 'wk-out');
        out.append(wkEl('summary', null, 'output'), wkEl('pre', null, String(r.text || '').slice(0, 20000)));
        body.appendChild(out);
      }
    }
  }
  body.appendChild(wkEl('div', 'wk-label', w.partial ? 'Answer (partial: it did not finish)' : 'Answer'));
  const ans = wkEl('div', 'wk-text');
  if (w.answer) { ans.innerHTML = formatContent(w.answer); renderVisualBlocks(ans); } else ans.textContent = w.outcome ? '(no answer)' : '(still running)';
  body.appendChild(ans);
  const end = w.outcome === 'done' ? `✅ Finished${w.durationMs != null ? ` in ${fmtWorkerClock(w.durationMs)}` : ''}` : w.outcome === 'stopped' ? '⏹ Stopped' : w.outcome === 'failed' ? `❌ Failed${w.error ? `: ${w.error}` : ''}` : w.outcome === 'unfinished' ? '❌ Did not finish (its caller’s reply ended first)' : '⏳ Still running when this was saved';
  body.appendChild(wkEl('div', 'wk-end' + (w.outcome === 'done' ? '' : ' bad'), end));
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
    const it = feedUpsert(holder, { kind: 'worker', id: `w:${w.id}`, workerId: w.id, status: w.status, description: w.description, model: w.model, agent: w.agent, error: w.error, ts: w.startedAt, doneTs: w.endedAt, ...(w.cancelled ? { cancelled: true } : {}) });
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
      setBubbleTime(u, msgTimeLabel(turn.startedAt));
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
  composerTypingPaint();
  stick = true;
  const userEl = addUserBubble(text, null);
  setBubbleTime(userEl, msgTimeLabel(Date.now()));
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
  composerTypingPaint();
}

// The hub no longer stops a turn when the browser goes away, so Stop has to say so explicitly.
function stopTurn(agent) {
  try { voiceStopPlayback(); } catch { /* nothing playing */ }
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
let keepKeyboard = null;   // set up with the message box; sent() tells it a send is not a keyboard that went away
function sendAndClose() {
  keepKeyboard && keepKeyboard.sent();
  const input = $('msg-input');
  const hadText = !!input.value.trim();
  const hadImages = pendingImages.length > 0;
  sendMessage();
  if ((hadText && !input.value.trim()) || (hadImages && !pendingImages.length)) input.blur();
}

// ── Voice (phase 1): tap to talk, read aloud, the Voice sheet ───────────────
// The hub does the speech work (POST /api/voice/stt, /api/voice/tts); this page records, plays and keeps the settings.
// The helpers (voiceSpeechText, voiceSentences, voiceResample, voiceEncodeWav, voiceGainFromSlider, voiceLevelDb,
// voiceMeterPercent, voiceLoadPrefs, voiceSavePrefs) are in the voice helpers block of this file.
const VOICE_MAX_SECONDS = 60;
let voiceStatus = { enabled: false, ready: false };
let voiceDictatedFor = null;   // the agent whose message was dictated with the mic here, until it is sent
let voiceAutoReadGen = 0;   // raised when a call starts or ends: a dictated reply still on its way is then never read aloud (not over the call, not after Hang up)
let voiceCall = null;          // the hands-free call that is up (see "Voice call (phone)" below), or null
let voiceCallBgNote = false;   // a call was ended by the page going to the background: say so when it returns
const VOICE_MIC_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0"></path><path d="M12 18v3"></path></svg>';
const VOICE_HANGUP_SVG = '<svg class="hang" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 15c2-4 16-4 18 0l-3 2.5-3-1.5v-2c-2-.7-4-.7-6 0v2l-3 1.5z"></path></svg>';
const voiceRec = { state: 'idle', handle: null, chunks: [], t0: 0, tick: null, agent: null, guard: voiceMicGuard() };
const voicePlay = { token: 0, audio: null, url: null, el: null, cancel: null, told: false };
const voiceErr = (e) => (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'The microphone is blocked: allow it for this site in the browser settings'
  : e && e.name === 'NotFoundError' ? 'No microphone found' : (e && e.message) || 'The microphone did not start');
function voicePrefsNow() { try { return voiceLoadPrefs(localStorage); } catch { return { micLevel: 50, interruptSensitivity: 50, mode: 'tap', readAloud: false, deviceVoiceFallback: true }; } }
function voiceEndPauseNow() { const v = Number(voicePrefsNow().endPause); return VOICE_END_PAUSES.includes(v) ? v : 1200; }
function voiceSpeedNow() { const v = voicePrefsNow().voiceSpeed; return voiceCleanSpeed(v == null ? 1 : v); }
const VOICE_SPEED_HINT = 'Google voices ignore this setting.';
const VOICE_ECHO_LABELS = ['Off', '0.6 s', '1 s', '1.5 s'];   // one per VOICE_ECHO_HOLDS entry
const VOICE_ECHO_HINT = 'Keeps the agent from hearing its own reply in a car or through a speaker.';
const VOICE_KEEPALIVE_HINT = 'Plays an inaudible hiss so a car or speaker does not cut the first word.';
function voicePrefsSave(patch) { const p = { ...voicePrefsNow(), ...patch }; try { voiceSavePrefs(localStorage, p); } catch { /* storage full or blocked */ } return p; }
function voiceTakeDictated(agent) { const d = voiceDictatedFor === agent; voiceDictatedFor = null; return d; }
function voiceOn() { return !!(voiceStatus && voiceStatus.enabled && voiceStatus.ready); }
// The speaker on a reply is shown only when something can speak: the hub voice, or (when the box is ticked) an offline voice on this phone.
let voiceLocalOk = false, voiceLocalProbed = false;
function voiceSpeakPaint() {
  const usable = voiceOn() || (!!voicePrefsNow().deviceVoiceFallback && voiceLocalOk);
  if (document.body) document.body.classList.toggle('no-speak', !usable);
}
function voiceLocalProbe() {
  if (voiceLocalProbed) return;
  voiceLocalProbed = true;
  try {
    if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') return;
    voiceWaitLocalVoice(window.speechSynthesis, 'en', 1000).then((v) => { voiceLocalOk = !!v; voiceSpeakPaint(); }).catch(() => {});
  } catch { /* no device voice */ }
}

async function voiceStatusRefresh() {
  try {
    const r = await api('/api/voice/status');
    if (r.ok) voiceStatus = (await r.json()) || { enabled: false, ready: false };
  } catch { /* offline: keep what was known */ }
  const b = $('mic-btn');
  if (b) { b.hidden = !voiceOn(); if (!voiceOn() && voiceRec.state === 'recording') voiceMicCancel(); }
  if (!voiceOn() && voiceCall) { toast('Voice was turned off, the call ended'); voiceCallHangUp(); }
  voiceMicPaint();
  voiceLocalProbe();
  voiceSpeakPaint();
  paintVoiceSheet();
  if (typeof voiceWakeRecheck === 'function') voiceWakeRecheck();   // the recognizer check can have changed
}

// Opens the microphone. Called straight from a tap: the AudioContext is made and resumed before the first await.
async function voiceMicOpen(gainValue, onChunk) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser cannot use the microphone here (it needs https)');
  const ctx = new AC();
  try { if (ctx.resume) ctx.resume(); } catch { /* resumes with the stream */ }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch (e) { try { ctx.close(); } catch { /* closed */ } throw e; }
  let source, gain, proc;
  try {
    source = ctx.createMediaStreamSource(stream);
    gain = ctx.createGain();
    gain.gain.value = voiceGainFromSlider(gainValue);
    proc = ctx.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = (ev) => onChunk(new Float32Array(ev.inputBuffer.getChannelData(0)));
    source.connect(gain); gain.connect(proc); proc.connect(ctx.destination);   // the processor only runs while connected; it writes silence
  } catch (e) {
    // the graph could not be built: the microphone must not stay open
    for (const t of stream.getTracks()) { try { t.stop(); } catch { /* stopped */ } }
    try { ctx.close(); } catch { /* closed */ }
    throw e;
  }
  return {
    rate: ctx.sampleRate,
    setLevel(v) { gain.gain.value = voiceGainFromSlider(v); },
    close() {
      proc.onaudioprocess = null;
      try { source.disconnect(); gain.disconnect(); proc.disconnect(); } catch { /* already apart */ }
      for (const t of stream.getTracks()) { try { t.stop(); } catch { /* stopped */ } }
      try { ctx.close(); } catch { /* closed */ }
    },
  };
}
function voiceMeterPaint(f32) {
  let pct = 0;
  try { pct = Math.max(0, Math.min(100, Number(voiceMeterPercent(voiceLevelDb(f32))) || 0)); } catch { /* no meter */ }
  return pct;
}
function voiceBarPaint(pct) { const i = document.querySelector('#voice-level i'); if (i) i.style.width = `${pct}%`; }

function voiceMicPaint() {
  if (typeof voiceStripPaint === 'function') voiceStripPaint();   // the mode chip and the settings button follow the mic
  const b = $('mic-btn'); if (!b) return;
  if (voiceCall) {   // a call is up: the button is the red hang-up
    b.classList.remove('rec', 'busy'); b.classList.add('call');
    b.setAttribute('aria-pressed', 'true'); b.setAttribute('aria-label', 'Hang up'); b.title = 'Hang up';
    if (!b.querySelector('svg.hang')) b.innerHTML = VOICE_HANGUP_SVG;
    const bar0 = $('voice-level'); if (bar0) bar0.hidden = true;
    return;
  }
  b.classList.remove('call');
  const rec = voiceRec.state === 'recording';
  b.classList.toggle('rec', rec);
  b.classList.toggle('busy', voiceRec.state === 'starting' || voiceRec.state === 'sending');
  b.setAttribute('aria-pressed', rec ? 'true' : 'false');
  const hands = voicePrefsNow().mode !== 'tap';
  b.setAttribute('aria-label', rec ? 'Stop and transcribe' : hands ? 'Talk hands-free' : 'Dictate');
  b.title = rec ? 'Tap to stop' : hands ? 'Tap to start a hands-free call' : 'Tap to dictate, tap again to stop';
  if (rec) b.textContent = `● ${Math.floor((Date.now() - voiceRec.t0) / 1000)}s`;
  else if (voiceRec.state === 'sending') b.textContent = '…';
  else if (!b.querySelector('svg') || b.querySelector('svg.hang')) b.innerHTML = VOICE_MIC_SVG;
  const bar = $('voice-level'); if (bar) bar.hidden = !rec;
  if (!rec) voiceBarPaint(0);
}
function voiceMicCancel() {
  voiceRec.guard.cancel();   // a microphone still being asked for is stopped the moment it arrives
  clearInterval(voiceRec.tick); voiceRec.tick = null;
  if (voiceRec.handle) { voiceRec.handle.close(); voiceRec.handle = null; }
  voiceRec.chunks = []; voiceRec.state = 'idle';
  voiceMicPaint();
}

async function voiceMicTap() {
  keepKeyboard && keepKeyboard.elsewhere();   // the mic button took the touch: the keyboard guard must not bring the keyboard back
  if (voiceCall) { voiceCallHangUp(); return; }   // during a call it is the red phone: it hangs up first, whatever else is busy
  if (voiceRec.state === 'starting' || voiceRec.state === 'sending' || voiceRec.guard.pending || voiceTest.guard.pending) return;
  if (voiceRec.state === 'recording') { voiceMicStop(); return; }
  if (!current) { toast('Pick an agent first'); return; }
  if (voicePrefsNow().mode !== 'tap') { voiceCallStart(); return; }   // hands-free: a tap starts a call (nothing awaited before call.start, for iOS)
  if (voiceTest.handle) voiceTestStop();
  voiceStopPlayback();   // the phone's own speaker must not be heard by the mic
  voiceUnlockAudio();
  const token = voiceRec.guard.begin();
  voiceRec.state = 'starting'; voiceRec.agent = current; voiceRec.chunks = [];
  voiceMicPaint();
  let handle;
  try {
    handle = await voiceMicOpen(voicePrefsNow().micLevel, (f) => { voiceRec.chunks.push(f); voiceBarPaint(voiceMeterPaint(f)); });
  } catch (e) {
    voiceRec.guard.fail();
    if (token === voiceRec.guard.gen) { voiceRec.state = 'idle'; voiceMicPaint(); toast(voiceErr(e), 4500); }
    return;
  }
  if (!voiceRec.guard.settle(token, handle)) return;   // cancelled while the browser was asking: the stream is already stopped
  voiceRec.handle = handle;
  voiceRec.state = 'recording'; voiceRec.t0 = Date.now();
  voiceRec.tick = setInterval(() => { voiceMicPaint(); if (Date.now() - voiceRec.t0 >= VOICE_MAX_SECONDS * 1000) voiceMicStop(); }, 250);
  voiceMicPaint();
}

async function voiceMicStop() {
  if (voiceRec.state !== 'recording') return;
  const { handle, chunks, agent } = voiceRec;
  clearInterval(voiceRec.tick); voiceRec.tick = null;
  voiceRec.handle = null; voiceRec.chunks = []; voiceRec.state = 'sending';
  const rate = handle.rate;
  handle.close();   // the microphone is released before the upload
  voiceMicPaint();
  try {
    let n = 0; for (const c of chunks) n += c.length;
    if (!n) throw new Error('Nothing was recorded');
    const all = new Float32Array(n); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
    const wav = new Blob([voiceEncodeWav(voiceResample(all, rate, 16000), 16000)], { type: 'audio/wav' });
    const r = await api(`/api/voice/stt?agent=${encodeURIComponent(agent)}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
    if (r.status === 409) throw new Error('Voice is turned off');
    if (r.status === 503) throw new Error('Voice is busy, try again in a few seconds');
    if (!r.ok) throw new Error(`Speech to text failed (HTTP ${r.status})`);
    const text = String((await r.json()).text || '').trim();
    if (!text) throw new Error('I did not catch that');
    voiceInsert(agent, text);
  } catch (e) { toast(e && e.message ? e.message : 'Speech to text failed', 4000); }
  voiceRec.state = 'idle';
  voiceMicPaint();
}

// The text goes after what is already in the box; the box is not focused, so no keyboard opens.
function voiceInsert(agent, text) {
  const join = (old) => (old && old.trim() ? `${old.replace(/\s+$/, '')} ${text}` : text);
  voiceDictatedFor = agent;
  if (current === agent) {
    const input = $('msg-input');
    input.value = join(input.value);
    composerTypingPaint();
    input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    saveDraft(agent, input.value);
  } else {
    saveDraft(agent, join((draftsAll()[agent] || {}).text || ''));
  }
}

// ── Read aloud ──
function voiceUnlockAudio() {   // a tap lets one audio element play; the later sentences and automatic reads reuse it
  if (typeof voiceDispPageRecover === 'function') voiceDispPageRecover();   // a tap is also the moment to wake or replace the page's audio context (read aloud after a call)
  try {
    if (!voicePlay.audio) voicePlay.audio = new Audio();
    const a = voicePlay.audio;
    if (!a.src) { a.src = URL.createObjectURL(new Blob([voiceEncodeWav(new Float32Array(160), 16000)], { type: 'audio/wav' })); const p = a.play(); if (p && p.catch) p.catch(() => {}); }
  } catch { /* the first real play decides */ }
}
function voiceMarkPlaying(el) {
  if (voicePlay.el && voicePlay.el !== el) { voicePlay.el.classList.remove('speaking'); const o = voicePlay.el.querySelector('.speak'); if (o) o.textContent = '\u{1F50A}'; }
  voicePlay.el = el || null;
  if (el) { el.classList.add('speaking'); const s = el.querySelector('.speak'); if (s) s.textContent = '■'; }
}
function voiceStopPlayback() {
  voicePlay.token++;
  if (typeof voiceDisplayHook === 'function') { voiceDisplayHook('audioStop'); voiceDisplayHook('clearCaption'); }   // the beak closes at once
  try { if (voicePlay.audio) { voicePlay.audio.pause(); voicePlay.audio.onended = null; voicePlay.audio.onerror = null; } } catch { /* nothing playing */ }
  if (voicePlay.cancel) { const c = voicePlay.cancel; voicePlay.cancel = null; c(); }   // settles the waiting voicePlayBlob (not played to the end) and frees its blob URL
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch { /* no device voice */ }
  if (voicePlay.el) { voicePlay.el.classList.remove('speaking'); const s = voicePlay.el.querySelector('.speak'); if (s) s.textContent = '\u{1F50A}'; voicePlay.el = null; }
}
async function voiceTtsBlob(agent, text) {   // null when the hub cannot say it (never throws)
  if (!voiceOn()) return null;
  const linkOwner = typeof voiceCall !== 'undefined' ? voiceCall : null;   // a failure is charged only to the call that made the request
  try {
    const r = await api('/api/voice/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent, text, speed: voiceSpeedNow() }) });
    if (r.status === 409 || r.status === 503) { voicePlay.told = true; toast(r.status === 409 ? 'Voice is turned off' : 'Voice is busy, try again in a few seconds', 4000); }
    if (!r.ok) return null;
    const b = await r.blob();
    // The flag travels with the audio and is applied only when it starts playing (voicePlayBlob), never on arrival.
    try { if (b) b.__voiceNorm = !!(r.headers && typeof r.headers.get === 'function' && r.headers.get('X-Voice-Normalized') === '1'); } catch { /* old defaults */ }
    return b && b.size ? b : null;
  } catch (e) { if (typeof voiceLinkNetFail === 'function') voiceLinkNetFail(e, linkOwner, agent); return null; }   // a network failure marks the link lost
}
function voicePlayBlob(blob, my, meta) {
  return new Promise((resolve) => {
    if (my !== voicePlay.token) { resolve(false); return; }
    // Before the element is chosen: a closed context is replaced (a captured element is silent for good), a suspended one is resumed for a moment (display or not).
    const wait = typeof voiceDispPagePrep === 'function' ? voiceDispPagePrep(my) : null;
    const begin = () => {
    if (my !== voicePlay.token) { resolve(false); return; }
    try { if (typeof voiceNoteNormalized === 'function') voiceNoteNormalized(!!(blob && blob.__voiceNorm === true)); } catch { /* the level stays as it was */ }
    const a = voicePlay.audio || (voicePlay.audio = new Audio());
    const prev = voicePlay.url;
    const url = URL.createObjectURL(blob);
    voicePlay.url = url;
    // Runs once; the shared <audio> element's handlers are cleared only while they are still this playback's (a late
    // rejection of an older play() must not take the handlers of the playback that replaced it).
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      if (a.onended === onEnded) a.onended = null;
      if (a.onerror === onError) a.onerror = null;
      if (a.onplaying === onPlaying) a.onplaying = null;
      if (typeof voiceDisplayHook === 'function') voiceDisplayHook('audioEnd');
      try { URL.revokeObjectURL(url); } catch { /* gone */ }
      if (voicePlay.url === url) voicePlay.url = null;
      if (voicePlay.cancel === cancel) voicePlay.cancel = null;
      resolve(ok);
    };
    const cancel = () => done(false);   // voiceStopPlayback: the promise settles as "not played to the end"
    voicePlay.cancel = cancel;
    const onEnded = () => done(true);
    const onError = () => done(false);
    // The reply audio really started (not when it was fetched): the display's analyser and caption begin here.
    const onPlaying = () => { if (settled || typeof voiceDisplayHook !== 'function') return; voiceDisplayHook('audioStart'); if (meta && meta.text) voiceDisplayHook('caption', meta.text); };
    a.onended = onEnded;
    a.onerror = onError;
    a.onplaying = onPlaying;
    if (typeof voiceDisplayRoute === 'function') voiceDisplayRoute(a);   // once per element; nothing is routed (or muted) when there is no display or the audio context is not running
    a.src = url;
    if (prev) { try { URL.revokeObjectURL(prev); } catch { /* gone */ } }
    const p = a.play();
    if (p && p.catch) p.catch(() => done(false));
    };
    if (wait) wait.then(begin, begin); else begin();
  });
}
function voiceDeviceSpeak(sentences, my) {   // the phone's own voice, sentence by sentence
  const synth = window.speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return Promise.resolve(false);
  return (async () => {
    // only an offline voice (localService) is used: the browser's default voice may be an online one
    const voice = await voiceWaitLocalVoice(synth, 'en', 1000);
    if (my !== voicePlay.token) return true;
    if (!voice) { toast('This device has no offline voice; turn on voice in Settings', 4500); return true; }
    for (const s of sentences) {
      if (my !== voicePlay.token) return true;
      await new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(s); u.voice = voice; u.lang = voice.lang; u.rate = voiceSpeedNow();
        const dsp = (k) => { if (typeof voiceDisplayHook === 'function') voiceDisplayHook('speech', k); };
        u.onstart = () => { dsp('start'); if (typeof voiceDisplayHook === 'function') voiceDisplayHook('caption', s); };
        u.onboundary = () => dsp('boundary'); u.onpause = () => dsp('pause'); u.onresume = () => dsp('resume');
        u.onend = () => { dsp('end'); resolve(); }; u.onerror = () => { dsp('end'); resolve(); };
        synth.speak(u);
      });
    }
    return true;
  })();
}
async function voiceSpeak(markdown, agent, el) {
  voiceStopPlayback();
  const my = voicePlay.token;
  voicePlay.told = false;
  let sentences = [];
  try { sentences = voiceSentences(voiceSpeechText(markdown)) || []; } catch { sentences = []; }
  if (!sentences.length) { toast('Nothing to read aloud'); return; }
  voiceMarkPlaying(el);
  const fallback = voicePrefsNow().deviceVoiceFallback;
  let rest = sentences;   // what the phone's own voice has to say when the hub voice cannot
  if (voiceOn()) {
    rest = [];
    let next = voiceTtsBlob(agent, sentences[0]);   // the next sentence is fetched while this one plays
    for (let i = 0; i < sentences.length; i++) {
      const blob = await next;
      if (my !== voicePlay.token) return;
      if (!blob) { rest = sentences.slice(i); break; }
      next = i + 1 < sentences.length ? voiceTtsBlob(agent, sentences[i + 1]) : null;
      const ok = await voicePlayBlob(blob, my);
      if (my !== voicePlay.token) return;
      if (!ok) { rest = sentences.slice(i); break; }
    }
  }
  if (rest.length && my === voicePlay.token) {
    if (fallback && await voiceDeviceSpeak(rest, my)) { /* spoken by the phone */ }
    else if (my === voicePlay.token && !voicePlay.told) toast(voiceOn() ? 'The hub voice did not answer' : 'Voice is off on the hub (an admin turns it on in Settings on the computer)', 4000);
  }
  if (my === voicePlay.token) voiceStopPlayback();
}
function voiceSpeakToggle(msgEl) {
  if (voicePlay.el === msgEl) { voiceStopPlayback(); return; }
  const text = rawText.get(msgEl);
  if (text === undefined || text === '') { toast('Nothing to read yet'); return; }
  voiceUnlockAudio();
  voiceSpeak(text, current, msgEl);
}
// A call starting or ending drops any read-aloud still owed to an earlier dictation.
function voiceAutoReadReset() { voiceAutoReadGen++; voiceDictatedFor = null; }
function voiceAutoRead(rec) {   // a reply to a message dictated here is read when it ends
  if (voiceCall || !rec || rec.readGen !== voiceAutoReadGen) return;
  if (!rec || !rec.dictated || !rec.full || !voicePrefsNow().readAloud || current !== rec.agent) return;
  voiceSpeak(rec.full, rec.agent, rec.bubble && rec.bubble.el);
}
function addSpeakButton(el) {
  const b = document.createElement('button');
  b.className = 'speak';
  b.type = 'button';
  b.textContent = '\u{1F50A}';
  b.setAttribute('aria-label', 'Read aloud');
  b.title = 'Read aloud';
  el.appendChild(b);
}

// ── Voice call (phone): the hands-free call ─────────────────────────────────
// The controller (voiceCreateCall) and the microphone/VAD adapter (voiceCreateVad) are in the voice call block of this
// file; this part gives them their deps: the hub routes, the chat, playback and the call panel above the composer.
// Hands-free works with the app open and the screen on: a hidden page hangs up, the screen stays on during a call.
const VOICE_CALL_HELP = 'Hands-free works with the app open and the screen on, also through a car\'s Bluetooth hands-free or a Bluetooth speaker. Locked-screen use and car apps (CarPlay, Android Auto) are not supported.';
const VOICE_LINK_LOST_TEXT = 'Connection lost', VOICE_LINK_ENDED_TEXT = 'Call ended: connection lost';
const VOICE_CALL_STATE_TEXT = { starting: 'Starting', listening: 'Listening', hearing: 'Hearing you', thinking: 'Thinking', speaking: 'Speaking', ended: 'Call ended' };
const voiceCallPost = (path, body, opts) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...(opts || {}) });
const voiceCallJson = async (r) => { try { return (await r.json()) || {}; } catch { return {}; } };

// ── Call display: None / Orb / an installed character (lib/ui-call-display.js; the choice is per device, the agent only has a default) ──
// Everything here is a no-op unless a display exists for the running call, so reading aloud and a call without a display are unchanged.
const voiceDisp = { cur: null, last: null, floor: null, turnSeq: new Map(), shared: { ctx: null, routes: new WeakMap(), routed: 0 } };   // shared: the audio context and the routed <audio> outlive a call (an element can be routed only once, and a closed context would silence it)
// The context a routed <audio> element was captured by is gone: that element stays silent for good, so the next playback gets a new one.
// A routed <audio> outlives the call, and so does its audio context: read aloud after a call (or a call with None) needs them recovered by the page itself.
// Never routes anything, never mutes a plain element, never loops: one resume per tap / per sentence, and none while the page is hidden.
function voiceDispRoutedEl() { const s = voiceDisp.shared, a = voicePlay.audio; return !!(s && s.ctx && a && s.routes && (s.routes.has(a) || (typeof voiceOwnCtx === 'function' && voiceOwnCtx() === s.ctx))); }   // captured by the display, or by the page's own loudness route on the same context
function voiceDispCtxClosed() {   // the context behind the routed element is closed: forget it and replace the element BEFORE a new one is chosen to play
  const own = typeof voiceOwnCtx === 'function' ? voiceOwnCtx() : null;
  if (own && own.state === 'closed') { voiceDispRoutesLost(); return true; }   // the page's own loudness route: the call's context closed with the call
  if (!voiceDispRoutedEl() || voiceDisp.shared.ctx.state !== 'closed') return false;
  const s = voiceDisp.shared;
  if (!voiceDisp.cur) { s.ctx = null; s.routed = 0; s.routes = new WeakMap(); }   // a running display keeps its own references; its next unlock() makes a new context
  voiceDispRoutesLost();
  return true;
}
function voiceDispPageRecover() {   // inside a user gesture
  if (voiceDispCtxClosed()) return;
  const ctx = voiceDispRoutedEl() ? voiceDisp.shared.ctx : null;
  if (!ctx || ctx.state === 'running' || document.hidden) return;
  try { const r = ctx.resume(); if (r && r.catch) r.catch(() => {}); } catch { /* the sentence decides */ }
}
function voiceDispPagePrep(my) {   // null: play now; a promise: wait (bounded) for a suspended context, else fall back to a plain element
  if (voiceDispCtxClosed()) return null;
  const ctx = voiceDispRoutedEl() ? voiceDisp.shared.ctx : null;
  if (!ctx || ctx.state === 'running' || voiceDisp.cur) return null;   // with a display, routeElement() resumes and waits for the context itself
  const a = voicePlay.audio;
  const plain = () => { if (my === voicePlay.token && voicePlay.audio === a && ctx.state !== 'running') voiceDispRoutesLost(); };   // silent behind a context that will not run: a fresh, unrouted element is audible
  if (document.hidden) { plain(); return null; }
  return new Promise((res) => {
    let t = null;
    const fin = () => { if (t !== null) { clearTimeout(t); t = null; } plain(); res(); };
    t = setTimeout(fin, 600);
    try { const r = ctx.resume(); if (r && r.then) r.then(fin, fin); else fin(); } catch { fin(); }
  });
}
function voiceDispRoutesLost() { try { if (voicePlay.audio) { voicePlay.audio.pause(); voicePlay.audio.onended = null; voicePlay.audio.onerror = null; voicePlay.audio.onplaying = null; } } catch { /* nothing playing */ } voicePlay.audio = null; if (voicePlay.cancel) { const c = voicePlay.cancel; voicePlay.cancel = null; c(); } }   // a play waiting on the replaced element settles as not played
function voiceDispAgentDefault(agent) { const a = (typeof agents !== 'undefined' && Array.isArray(agents) ? agents : []).find(x => x && x.name === agent); return a && typeof a.callDisplay === 'string' ? a.callDisplay : 'none'; }
function voiceDisplayHook(name, ...args) {
  const d = voiceDisp.cur;
  if (!d || typeof d[name] !== 'function') return undefined;
  try { return d[name](...args); } catch { return undefined; }
}
// One media element, one source: the analyser is wired the first time and reused for every sentence (see lib/ui-call-display.js routeElement).
function voiceDisplayRoute(el) {
  try { voiceLoudSync(); } catch { /* a loudness fault never stops a reply */ }
  const d = voiceDisp.cur; let took = false;
  if (d) { try { took = d.routeElement(el) === true; } catch { /* plain playback */ } }
  if (!took) { try { voiceOwnRoute(el); } catch { /* plain playback */ } }   // no display route took the element: a call still gets the loudness chain
}
// Loudness of call replies: while a call is up the reply element ends in a gain -> limiter chain (voiceCreateLoudness) on the audio context
// that captured it; read aloud outside a call is left at 0 dB. The display sends its element there through its `output` option.
const voiceOwnRoutes = new WeakMap();   // <audio> -> { ctx, srcNode }: elements this page captured itself (a media element has one source per element)
// The output of a call follows its open microphone: vc.micInfo.label (set by ui.mic on every open and reopen, refreshed on devicechange).
function voiceOutputNow() { const i = voiceCall && voiceCall.micInfo, label = i && typeof i.label === 'string' ? i.label : ''; return { output: voiceOutputKind(label), label }; }
function voiceLoudnessNow() { return voiceLoudnessFor(voicePrefsNow(), voiceOutputNow().output); }
function voiceOutputOnDeviceChange() {   // devicechange during a call: read the open microphone's label again
  const vc = voiceCall; if (!vc) return;
  try { const i = vc.vad && typeof vc.vad.info === 'function' && vc.vad.info(); if (i && typeof i.label === 'string') vc.micInfo = i; } catch { /* keep the last info */ }
  try { voiceLoudSync(); } catch { /* the next sentence syncs it */ }
}
try { if (typeof navigator !== 'undefined' && navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') navigator.mediaDevices.addEventListener('devicechange', voiceOutputOnDeviceChange); } catch { /* no devicechange: the mic reopen still reports the label */ }
function voiceLoudChain(ctx) {
  if (!ctx || !voiceCall) return null;
  try { const c = voiceCreateLoudness(ctx); if (c) { if (typeof c.setNormalized === 'function') c.setNormalized(voiceNormFlag); c.setLevel(voiceLoudnessNow()); } return c || null; } catch { return null; }
}
// The last reply audio's X-Voice-Normalized header (the hub sent the voice already at -16 dBFS): the chains boost less. New chains pick it up in voiceLoudChain.
let voiceNormFlag = false;
function voiceNoteNormalized(flag) {
  voiceNormFlag = !!flag;
  for (const ctx of voiceLoudCtxs()) { const c = ctx.__voiceLoudness; if (c && typeof c.setNormalized === 'function') { try { c.setNormalized(voiceNormFlag); } catch { /* gone */ } } }
}
function voiceOutNode(ctx) { const c = voiceLoudChain(ctx); return c ? c.input : ctx.destination; }
function voiceLoudCtxs() { const a = voiceDisp.shared && voiceDisp.shared.ctx, b = voiceCall && voiceCall.thinkCtx; return [a, b && b !== a ? b : null].filter(Boolean); }
function voiceLoudSync() {   // the chains follow the pref during a call and sit at 0 dB outside one
  const lv = voiceCall ? voiceLoudnessNow() : 'normal';
  for (const ctx of voiceLoudCtxs()) { const c = ctx.__voiceLoudness; if (c) { try { c.setLevel(lv); } catch { /* gone */ } } }
}
function voiceOwnCtx() { const a = voicePlay.audio, r = a && voiceOwnRoutes.get(a); return r ? r.ctx : null; }
function voiceOwnRoute(el) {
  if (!voiceCall || !el || typeof voiceCreateLoudness !== 'function') return false;
  if (voiceDisp.shared && voiceDisp.shared.routes && voiceDisp.shared.routes.has(el)) return false;   // the display captured it: its output option already sends it through the chain
  const ctx = (voiceDisp.shared && voiceDisp.shared.ctx) || voiceCall.thinkCtx;
  if (!ctx || ctx.state !== 'running' || typeof ctx.createMediaElementSource !== 'function') return false;   // never route (and so mute) through a context that is not running
  const had = voiceOwnRoutes.get(el);
  if (had) return had.ctx === ctx;   // one route per element per context: never a second source
  const chain = voiceLoudChain(ctx); if (!chain) return false;
  try { const srcNode = ctx.createMediaElementSource(el); srcNode.connect(chain.input); voiceOwnRoutes.set(el, { ctx, srcNode }); return true; } catch { return false; }
}
try { window.__voiceOut = () => { let c = null; for (const ctx of voiceLoudCtxs()) { if (ctx.__voiceLoudness) { c = ctx.__voiceLoudness; break; } } return { level: voiceLoudnessNow(), ...voiceOutputNow(), gainDb: c ? c.gainDb : null, normalized: c ? !!c.normalized : voiceNormFlag, meter: c ? c.meter() : null }; }; } catch { /* a test hook only */ }
function voiceFacePackBody() { const d = voiceDisp.cur; const slug = d && typeof d.activeFacePack === 'function' ? d.activeFacePack() : null; return slug ? { facePack: slug } : {}; }
function voiceDispTalk() { const f = voiceDisp.floor; if (f) f.take(); }
function voiceDispAdopt() {
  return [
    { el: $('call-panel'), label: 'Call' },
    { el: $('voice-panel'), label: 'Voice settings', show: true, prepare: () => voicePanelPaint() },
  ];
}
function voiceDispBegin(vc) {
  if (typeof CallDisplay === 'undefined' || typeof CallDisplay.createCallDisplay !== 'function' || typeof CallDisplay.createTalkFloor !== 'function') return;   // the module exports only window.CallDisplay
  if (voiceDisp.last) { try { voiceDisp.last.release(); } catch { /* gone */ } voiceDisp.last = null; }
  voiceDisp.floor = CallDisplay.createTalkFloor({ call: () => (voiceCall === vc ? vc.call : null), setTimer: (f, ms) => setTimeout(f, ms), clearTimer: (t) => clearTimeout(t) });
  voiceDisp.turnSeq.clear();
  let d = null;
  try {
    d = CallDisplay.createCallDisplay({ window, document, storage: localStorage, fetch: (...a) => fetch(...a), needsContext: true, shared: voiceDisp.shared, onRoutesLost: voiceDispRoutesLost, agentDefault: () => voiceDispAgentDefault(vc.agent), adopt: voiceDispAdopt,
      output: (ctx) => voiceOutNode(ctx),   // reply audio ends in the loudness chain
      reopenHost: () => $('cp-hangup'),   // "Show display" goes inside the call panel, beside Hang up
      onTalk: voiceDispTalk, onHangUp: () => voiceCallHangUp(), onRetryMic: voiceCallRetryMicTap, onChange: () => voiceDispPaintPanel() });
    voiceDisp.cur = d;
    d.start();   // synchronous: the audio context is made and resumed inside the tap that started the call
  } catch { voiceDisp.cur = null; }
}
// The call is ending: hang-up = a short goodbye (bounded), release = at once. Safe to call twice.
function voiceDispEnd(goodbye) {
  const d = voiceDisp.cur; voiceDisp.cur = null;
  if (voiceDisp.floor) { try { voiceDisp.floor.cancel(); } catch { /* gone */ } voiceDisp.floor = null; }
  voiceDisp.turnSeq.clear();
  if (!d) return;
  if (!goodbye) { try { d.release(); } catch { /* gone */ } return; }
  voiceDisp.last = d;
  let said = null; try { said = d.hangUp(); } catch { /* the view is gone */ }   // synchronous: the controls are back in the page before the page tears the call down
  Promise.resolve(said).catch(() => {}).then(() => { if (voiceDisp.last === d) voiceDisp.last = null; });
}
function voiceDispMood(seq, mood) { voiceDisplayHook('mood', 'seq:' + seq, mood); }   // once per turn, whichever of the chat stream and the hub event comes first
function voiceCallSseMood(rec, mood) { const vc = voiceCall; if (vc && rec && rec.agent === vc.agent) voiceDispMood(vc.sendSeq, mood); }
async function voiceDispPaintPanel() {
  const sels = [$('vp-display'), $('cp-display')].filter(Boolean);   // the voice sheet's select and the call panel's
  if (!sels.length || typeof CallDisplay === 'undefined') return;
  const paintBoxes = (p) => { const cap = $('vp-captions'); if (cap) cap.checked = !!p.captions; const intr = $('vp-interrupt'); if (intr) intr.checked = p.interrupt === true; };   // set at once, and again after the wait
  paintBoxes(CallDisplay.loadDisplayPrefs(localStorage));
  const my = voiceDisp.paintGen = (voiceDisp.paintGen || 0) + 1;
  let packs = [], state = 'ready';
  try { packs = await CallDisplay.fetchPacks((...a) => fetch(...a)); } catch { state = 'failed'; }
  if (voiceDisp.paintGen !== my) return;   // a newer paint started meanwhile: an older answer never puts back an older choice
  const prefs = CallDisplay.loadDisplayPrefs(localStorage);   // read after the wait: a choice made meanwhile counts
  paintBoxes(prefs);
  for (const sel of sels) if (sel.isConnected !== false && document.activeElement !== sel) CallDisplay.fillDisplaySelect(document, sel, { choice: prefs.choice, packs });
  const note = $('vp-display-note');
  if (note) note.textContent = CallDisplay.displayNote(CallDisplay.resolveDisplay({ choice: prefs.choice, agentDefault: voiceDispAgentDefault(current), packs, packsState: state }));
}
function voiceDispSetChoice(v) {
  if (typeof CallDisplay === 'undefined') return;
  if (voiceDisp.cur) voiceDisp.cur.setChoice(v); else CallDisplay.saveDisplayPrefs(localStorage, { choice: v });   // live: the view changes, the call goes on
  voiceDispPaintPanel();
}
function voiceDispSetCaptions(on) {
  if (typeof CallDisplay === 'undefined') return;
  if (voiceDisp.cur) voiceDisp.cur.setCaptions(on); else CallDisplay.saveDisplayPrefs(localStorage, { captions: !!on });
}
const VOICE_INTERRUPT_HINT = 'For places where talking over the reply doesn\'t register.';
// The option is shown in the call panel and in the Voice sheet; both follow it.
function voiceInterruptPaint() {
  const on = typeof CallDisplay !== 'undefined' && CallDisplay.loadDisplayPrefs(localStorage).interrupt === true;
  const a = $('vp-interrupt'); if (a) a.checked = on;
  const b = $('vs-interrupt'); if (b) b.checked = on;
}
function voiceDispSetInterrupt(on) {
  if (typeof CallDisplay === 'undefined') return;
  if (voiceDisp.cur && typeof voiceDisp.cur.setInterruptButton === 'function') voiceDisp.cur.setInterruptButton(!!on); else CallDisplay.saveDisplayPrefs(localStorage, { interrupt: !!on });
  voiceInterruptPaint();
  voiceDispPaintPanel();
}

function voiceCallPaintState(name, phrase) {
  const lostNow = typeof voiceCall !== 'undefined' && voiceCall && voiceCall.linkLostOn;   // while the connection is lost the line keeps saying so
  const s = $('cp-state'); if (s) { s.textContent = lostNow ? VOICE_LINK_LOST_TEXT : voiceCallStateText(name, phrase); s.dataset.state = name; s.dataset.phrase = phrase || ''; }
  const p = $('call-panel'); if (p) p.dataset.state = name;
}
function voiceCallPaintMeter(db) {
  const i = document.querySelector('#cp-meter i'); if (!i) return;
  let pct = 0; try { pct = Math.max(0, Math.min(100, Number(voiceMeterPercent(db)) || 0)); } catch { /* no meter */ }
  i.style.width = `${pct}%`;
  const live = document.querySelector('#vp-meter i'); if (live) live.style.width = `${pct}%`;   // the chat's voice panel shows it too
}
function voiceCallPaintHeld(list) {
  const box = $('cp-held'); if (!box) return;
  box.textContent = '';
  for (const h of Array.isArray(list) ? list : []) {
    const row = document.createElement('div'); row.className = 'cp-item'; row.dataset.id = String(h.id);
    const label = String(h.label || h.kind || 'Something came in');
    const t = document.createElement('span'); t.className = 'cp-item-text';
    t.textContent = h.from && !label.includes(String(h.from)) ? `${label} (from ${h.from})` : label;
    row.appendChild(t);
    const acts = document.createElement('span'); acts.className = 'cp-item-acts';
    for (const [choice, text] of [['now', 'Now'], ['later', 'Later'], ['skip', 'Skip']]) {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.choice = choice; b.textContent = text;
      b.setAttribute('aria-label', `${text}: ${label}`);
      if (choice === 'later' && h.later) b.classList.add('on');
      acts.appendChild(b);
    }
    row.appendChild(acts); box.appendChild(row);
  }
}
function voiceFocusHint(show) {   // "Music playing? Pause it": shown where the page cannot pause other apps (iPhone) or the focus sound was refused
  const h = $('cp-focus-hint'); if (h) h.hidden = !show;
}
function voiceCallPanel(show) {
  const p = $('call-panel'); if (!p) return;
  p.hidden = !show;
  callPanelCompactPaint();
  if (show) { const d = $('cp-dnd'); if (d) d.checked = false; return; }
  voiceCallPaintHeld([]); voiceCallPaintMeter(-100);
  const h = $('cp-heard'); if (h) h.textContent = '';
  const mic = $('cp-mic'); if (mic) { mic.textContent = ''; mic.classList.remove('cp-mic-lost'); }
  const retry = $('cp-retry-mic'); if (retry) retry.hidden = true;
}
async function voiceWakeAcquire(vc) {   // the screen stays on during a call; asked again when the page is visible again
  try {
    if (!navigator.wakeLock || document.hidden || voiceCall !== vc || (vc.wake && !vc.wake.released)) return;
    const lock = await navigator.wakeLock.request('screen');
    if (voiceCall !== vc) { try { lock.release(); } catch { /* gone */ } return; }
    vc.wake = lock;
  } catch { /* not allowed (low battery, no support): the call still works */ }
}
function voiceCallTeardown(vc) {
  if (voiceCall !== vc) return;
  voiceCall = null;
  if (typeof voiceAutoReadReset === 'function') voiceAutoReadReset();   // nor after the call has ended
  if (typeof voiceDispEnd === 'function') voiceDispEnd(false);   // a call that ended some other way: the display goes at once (hang-up has already started its goodbye)
  const lock = vc.wake; vc.wake = null;
  try { if (lock) Promise.resolve(lock.release()).catch(() => {}); } catch { /* already released */ }
  clearInterval(vc.beatTimer); vc.beatTimer = null;
  if (vc.link) { try { vc.link.stop(); } catch { /* gone */ } vc.link = null; }
  try { if (vc.vad && typeof vc.vad.stop === 'function') Promise.resolve(vc.vad.stop()).catch(() => {}); } catch { /* the mic is never left held: stop() is safe to repeat */ }
  voiceMediaSession(vc, false);
  if (vc.focus) { try { vc.focus.stop(); } catch {} }
  if (typeof voiceFocusHint === 'function') voiceFocusHint(false);
  voiceThinkingClose(vc);
  voiceCallPanel(false);
  voiceMicPaint();
}
// Hangs up the call that is up (the controller tells the hub and shows what came in; nothing is spoken after Hang up); the page lets go at once.
function voiceCallHangUp() {
  const vc = voiceCall;
  if (!vc) return Promise.resolve([]);
  vc.hangingUp = true;   // the controller reports 'ended' synchronously inside hangUp(): the page teardown must wait for the goodbye to start (below)
  let p; try { p = vc.call.hangUp(); } catch { p = Promise.resolve([]); }
  if (typeof voiceDispEnd === 'function') voiceDispEnd(true);   // the microphone and the hub are already being let go; the character says goodbye for a moment
  voiceCallTeardown(vc);
  return p;
}

// The hub's call routes, for one agent.
function voiceCallServer(agent, getVc) {
  const url = '/api/voice/call';
  return {
    async start(mode) {
      const r = await voiceCallPost(url, { agent, action: 'start', mode });
      if (!r.ok) { const j = await voiceCallJson(r); throw new Error(r.status === 403 ? 'someone else is on a call with this agent' : (j && j.error) || `HTTP ${r.status}`); }
      const j = await voiceCallJson(r);
      return { callId: j.call && j.call.callId, held: (j.call && Array.isArray(j.call.held)) ? j.call.held : [] };   // the controller keeps the id and passes it back
    },
    async heartbeat(callId) {
      let r;
      try { r = await voiceCallPost(url, { agent, action: 'heartbeat', callId }); } catch (e) { if (typeof voiceLinkNetFail === 'function') voiceLinkNetFail(e, getVc()); throw e; }   // a network failure marks the link lost
      if (r.status === 409 || r.status === 403) { const vc = getVc(); if (vc && voiceCall === vc) { toast('The call ended.'); voiceCallHangUp(); } return null; }
      const j = await voiceCallJson(r);
      return { callId: j.call && j.call.callId, held: (j.call && Array.isArray(j.call.held)) ? j.call.held : [] };
    },
    async mode(m, callId) { await voiceCallPost(url, { agent, action: 'mode', mode: m, callId }); },
    async end(callId) {
      const r = await voiceCallPost(url, { agent, action: 'end', callId }, { keepalive: true });
      const j = await voiceCallJson(r);
      return { held: Array.isArray(j.held) ? j.held : (j.call && Array.isArray(j.call.held) ? j.call.held : []) };
    },
    async decide(id, choice, callId) {
      const r = await voiceCallPost(url + '/decide', { agent, id, choice, callId });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    },
  };
}
async function voiceCallStt(agent, f32) {
  const wav = new Blob([voiceEncodeWav(f32, 16000)], { type: 'audio/wav' });
  const linkOwner = typeof voiceCall !== 'undefined' ? voiceCall : null;   // a failure is charged only to the call that made the request
  let r;
  try { r = await api(`/api/voice/stt?agent=${encodeURIComponent(agent)}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav }); } catch (e) { if (typeof voiceLinkNetFail === 'function') voiceLinkNetFail(e, linkOwner, agent); throw e; }   // a network failure marks the link lost
  if (r.status === 409) throw new Error('Voice is turned off');
  if (r.status === 503) throw new Error('Voice is busy');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await voiceCallJson(r);
  return String(j.text || '');
}
// One sentence, resolved false when it was cut (cancelSpeech = voiceStopPlayback raises the token): the hub voice, else the offline device voice.
async function voiceCallSpeak(agent, rawText) {
  const text = voiceSpeechText(String(rawText || ''));   // every spoken string goes through the cleaner
  if (!text) return true;
  const my = voicePlay.token;
  if (voiceOn()) {
    const blob = await voiceTtsBlob(agent, text);
    if (my !== voicePlay.token) return false;
    if (blob) {
      const ok = await voicePlayBlob(blob, my, { text });
      if (my !== voicePlay.token) return false;
      if (ok) return true;
    }
  }
  if (voicePrefsNow().deviceVoiceFallback) {
    await voiceDeviceSpeak([text], my);
    return my === voicePlay.token;
  }
  return my === voicePlay.token;
}
// A spoken message starts a voice turn (voice: true). The stream is not awaited: the next utterance must not wait for the reply.
function voiceCallSend(vc, text, userEl) {
  stick = true;
  if (!userEl) { userEl = addUserBubble(text, null); setBubbleTime(userEl, msgTimeLabel(Date.now())); }
  scrollChat(true);
  const seq = ++vc.sendSeq;
  voiceDisplayHook('reply', 'turn', 'seq:' + seq);   // a new turn: the older ones (and their moods) are over
  vc.expecting = true;
  const release = () => {   // a turn_end that never arrived must not leave the call in Thinking
    setTimeout(() => { if (voiceCall === vc && vc.sendSeq === seq && vc.expecting) { vc.expecting = false; vc.call.onReplyText(vc.lastText || '', true); } }, 2500);
  };
  sendMessage({ agent: vc.agent, text, userEl, noteEl: null, voice: true }).then(release, release);
}
// A spoken correction while the agent works is an interjection; when the turn had just ended it goes as a new voice message.
async function voiceCallInterject(vc, text) {
  stick = true;
  const userEl = addUserBubble(text, null);
  setBubbleTime(userEl, msgTimeLabel(Date.now()));
  scrollChat(true);
  let result;
  try {
    const r = await voiceCallPost('/api/chat/interject', { agent: vc.agent, message: text });
    result = await r.json().catch(() => ({ success: false, error: `HTTP ${r.status}` }));
  } catch (e) { result = { success: false, error: e.message || 'request failed' }; if (typeof voiceLinkNetFail === 'function') voiceLinkNetFail(e, vc); }
  if (result && result.success) return;
  if (vc.link && vc.link.lost) return;   // the link watch speaks for a lost connection: no error toast
  const error = String((result && result.error) || 'request failed');
  if (/not currently processing/i.test(error)) {
    const stale = streams.get(vc.agent);
    if (stale) { stale.stale = true; stale.controller.abort(); }
    setLive(vc.agent, { busy: false, pendingQuestion: false });
    paintStatus();
    if (voiceCall === vc) voiceCallSend(vc, text, userEl);
    return;
  }
  toast(`Could not interject: ${error}`);
}
async function voiceCallAnswerAsk(vc, requestId, answer) {
  const question = vc.asks.get(requestId) || '';
  try {
    const r = await voiceCallPost('/api/ask_response', { agent: vc.agent, request_id: requestId, answers: { [question]: answer } });
    if (!r.ok) toast('Could not send the answer');
  } catch { toast('Could not send the answer'); }
}

// The thinking sound (a soft low pulse made with Web Audio, no files). The controller starts it when a reply is slow
// and stops it when the reply speaks, the person speaks or the call ends. It plays on its own audio context (made when
// first needed, closed with the call) and tells the VAD playback is on while it pulses, so it cannot trigger barge-in.
function voiceThinkingClose(vc) {
  if (!vc) return;
  const snd = vc.thinkSnd, ctx = vc.thinkCtx, ka = vc.keepAlive;
  vc.thinkSnd = null; vc.thinkCtx = null; vc.thinkOn = false; vc.keepAlive = null;
  try { if (snd) snd.stop(); } catch { /* stopped */ }
  try { if (ka) ka.stop(); } catch { /* stopped */ }   // the controller stops it too; this covers a page teardown without the controller
  try { if (ctx && ctx.close) Promise.resolve(ctx.close()).catch(() => {}); } catch { /* closed */ }
}
function voiceThinkingCtxMake(vc) {
  try {
    if (vc.thinkCtx) return;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    vc.thinkCtx = new AC();
    try { if (vc.thinkCtx.resume) Promise.resolve(vc.thinkCtx.resume()).catch(() => {}); } catch { /* resumes later */ }
  } catch { /* no sound: the wait is just quiet */ }
}
function voiceThinkingVolume() { const v = Number(voicePrefsNow().thinkingVolume); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5; }
function voiceThinkingDeps(vc) {
  return {
    start() {
      if (voiceCall !== vc || typeof voiceCreateThinkingSound !== 'function') return;
      if (voicePrefsNow().thinkingSound === false) return;
      try {
        if (!vc.thinkCtx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; vc.thinkCtx = new AC(); }
        try { if (vc.thinkCtx.state === 'suspended') Promise.resolve(vc.thinkCtx.resume()).catch(() => {}); } catch { /* resumes later */ }
        if (!vc.thinkSnd) vc.thinkSnd = voiceCreateThinkingSound({ ctx: vc.thinkCtx, volume: voiceThinkingVolume() });
        vc.thinkSnd.setVolume(voiceThinkingVolume());
        vc.thinkSnd.start();
        vc.thinkOn = true;
        vc.vad.setPlaybackActive(true);
      } catch { /* no sound: the wait is just quiet */ }
    },
    // The event goes to the sound, which moves ev.at to when the pulse is heard (same object back); false = not playing (suspended).
    pulse(ev) {
      if (voiceCall !== vc || typeof voiceCreateThinkingSound !== 'function') return;
      let r;
      try {
        if (!vc.thinkCtx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; vc.thinkCtx = new AC(); }
        try { if (vc.thinkCtx.state === 'suspended') Promise.resolve(vc.thinkCtx.resume()).catch(() => {}); } catch { /* resumes later */ }
        if (!vc.thinkSnd) vc.thinkSnd = voiceCreateThinkingSound({ ctx: vc.thinkCtx, volume: voiceThinkingVolume() });
        vc.thinkSnd.setVolume(voiceThinkingVolume());
        r = vc.thinkSnd.pulse(ev);
        if (r === false) return r;
        vc.thinkOn = true;
        vc.vad.setPlaybackActive(true);
      } catch { /* no sound: the wait is just quiet */ }
      return r;
    },
    stop() {
      if (!vc.thinkOn) return;
      vc.thinkOn = false;
      try { if (vc.thinkSnd) vc.thinkSnd.stop(); } catch { /* stopped */ }
      try { if (voiceCall === vc && vc.call && vc.call.state !== 'speaking') vc.vad.setPlaybackActive(false); } catch { /* call over */ }
    },
  };
}
// Changing a setting in the chat panel or the Voice sheet reaches a call that is up straight away.
function voiceCallApplyPrefs() {
  try { voiceLoudSync(); } catch { /* the next sentence syncs it */ }   // the loudness of a running call follows at once
  const vc = voiceCall; if (!vc) return;
  const p = voicePrefsNow();
  try { vc.vad.setMicLevel(p.micLevel); vc.vad.setInterruptSensitivity(p.interruptSensitivity); vc.vad.setEndPause(voiceEndPauseNow()); } catch { /* vad not up yet */ }
  try { if (typeof vc.call.setPrefs === 'function') vc.call.setPrefs(); } catch { /* older controller */ }
  try { if (vc.thinkSnd) vc.thinkSnd.setVolume(voiceThinkingVolume()); } catch { /* not playing */ }
  try { vc.vad.setEchoHold(p.echoHold); } catch { /* vad not up yet */ }
}
// The call panel's microphone line: plain text only (the label comes from the device).
function voiceMicLine(info) {
  const i = info || {};
  const rate = Number(i.sampleRate);
  return 'Microphone: ' + (i.label ? String(i.label) : 'default') + (rate > 0 ? ' · ' + Math.round(rate / 100) / 10 + ' kHz' : '') + (i.fallback ? ' · basic mode' : '');
}
// ── Wake phrase standby: allowed only with a ready local recognizer (the server rule is engineFor in lib/voice/routes.js) ──
function voiceWakeAllowed(agent) {
  try {
    const st = voiceStatus;
    if (!agent || !st || st.enabled !== true || st.ready !== true || !st.stt || st.stt.engine !== 'local') return false;
    const a = agentByName(agent);
    if (!a) return false;
    return !a.voice || !a.voice.stt || a.voice.stt === 'local';
  } catch { return false; }
}
function voiceWakeNow(agent) {
  // null only when the person has it off; on, local says whether standby may run (a call in standby with local false stays deaf).
  try {
    const w = voiceWakeForAgent(voicePrefsNow(), agent);
    if (!(w && w.on === true && w.phrase)) return null;
    let local = false;
    try { local = voiceWakeAllowed(agent) === true; } catch { local = false; }
    return { phrase: w.phrase, quietMs: w.quietMs, local };
  } catch { return { phrase: '', quietMs: 20000, local: false }; }
}
function voiceWakeChime(vc) {
  try {
    if (!vc) return false;
    if (vc.thinkCtx && vc.thinkCtx.state === 'closed') vc.thinkCtx = null;
    if (!vc.thinkCtx) voiceThinkingCtxMake(vc);   // the call's own context (made inside the tap); a new one only if it is gone
    const ctx = vc.thinkCtx;
    if (!ctx) return false;
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') Promise.resolve(ctx.resume()).catch(() => {});
    return voicePlayWakeChime(ctx) === true;
  } catch { return false; }
}
function voiceCallStateText(name, phrase) { return name === 'standby' ? (phrase ? `Waiting for “${phrase}”` : 'Waiting') : (VOICE_CALL_STATE_TEXT[name] || name); }
function voiceWakeName(agent) { const a = agentByName(agent); return String((a && a.display) || agent || ''); }
// The panel's wake rows follow the recognizer check: disabled, with one line why, while it says no.
function voiceWakePaint() {
  const box = $('vp-wake-box'); if (!box) return;
  const agent = current || '', ok = voiceWakeAllowed(agent), w = voiceWakeForAgent(voicePrefsNow(), agent) || { on: false, phrase: '', quietMs: 20000 };
  const cb = $('vp-wake'), ph = $('vp-wake-phrase'), qs = $('vp-wake-quiet'), off = $('vp-wake-off');
  const hint = $('vp-wake-hint');
  if (hint && voiceWakePaint.agent !== agent) { hint.textContent = ''; hint.hidden = true; }   // another agent: its phrase hint is gone
  voiceWakePaint.agent = agent;
  if (cb) { cb.checked = w.on; cb.disabled = !ok && !w.on; }   // a ticked box can always be unticked
  if (ph) {
    if (document.activeElement !== ph && !(hint && !hint.hidden)) ph.value = w.phrase;   // (a phrase that was refused stays in the box beside its hint)
    ph.placeholder = `Hey ${voiceWakeName(agent)}`; ph.disabled = !ok;
  }
  if (qs) { qs.value = String(w.quietMs); qs.disabled = !ok; }
  if (off) off.hidden = ok;
}
// The recognizer check can change mid-call (the status or the agent list was read again): the controller looks again.
function voiceWakeRecheck() {
  try { if (voiceCall && voiceCall.call && typeof voiceCall.call.wakeChanged === 'function') voiceCall.call.wakeChanged(); } catch { /* the call carries on */ }
  try { voiceWakePaint(); } catch { /* no panel */ }
}
function voiceWakeSave() {
  const agent = current; if (!agent) return;
  const cb = $('vp-wake'), ph = $('vp-wake-phrase'), qs = $('vp-wake-quiet'), hint = $('vp-wake-hint');
  if (!cb || !ph || !qs) return;
  const name = voiceWakeName(agent), on = !!cb.checked;
  let typed = ph.value.trim();
  if (on && !typed) { typed = `Hey ${name}`; ph.value = voiceCleanWakePhrase(typed) || typed; }   // turned on with nothing typed: the placeholder phrase
  const phrase = voiceCleanWakePhrase(typed);
  if (hint) { hint.textContent = typed && !phrase ? `Use 1 to 4 words, e.g. Hey ${name}` : ''; hint.hidden = !hint.textContent; }
  if (phrase) ph.value = phrase;
  const quietMs = VOICE_WAKE_QUIET_MS.includes(Number(qs.value)) ? Number(qs.value) : 20000;
  voicePrefsSave({ wake: { ...(voicePrefsNow().wake || {}), [agent]: { on, phrase, quietMs } } });
  if (voiceCall && voiceCall.agent === agent && voiceCall.call && typeof voiceCall.call.wakeChanged === 'function') voiceCall.call.wakeChanged();
}
function voiceCallDeps(vc) {
  const agent = vc.agent;
  return {
    thinking: voiceThinkingDeps(vc),
    agent,
    now: () => Date.now(),
    perfNow: () => performance.now(),
    setTimer: (f, ms) => setTimeout(f, ms),
    clearTimer: (t) => clearTimeout(t),
    prefs: () => voicePrefsNow(),
    // Everything the controller uses passes through: the "now" of setPlaybackActive (a cut by the person drops the echo guard at once),
    // reopen ("Try the microphone again" after a lost microphone) and info.
    vad: { start: (h) => vc.vad.start(typeof voiceDisp !== 'undefined' && voiceDisp.floor ? voiceDisp.floor.wrap(h) : h), stop: () => vc.vad.stop(),
      setPlaybackActive: (on, now) => vc.vad.setPlaybackActive(on, now), reopen: () => vc.vad.reopen(), info: () => vc.vad.info() },
    stt: (f32) => voiceCallStt(agent, f32),
    isTurnRunning: () => isBusy(agent) || ownTurnFor(agent),
    send: (text) => voiceCallSend(vc, text),
    interject: (text) => voiceCallInterject(vc, text),
    stop: () => stopTurn(agent),
    speak: (text) => voiceCallSpeak(agent, text),
    cancelSpeech: () => voiceStopPlayback(),
    answerAsk: (id, text) => voiceCallAnswerAsk(vc, id, text),
    speakActivity: () => !!voicePrefsNow().speakActivity,   // off by default: what the agent is doing is shown in the panel, not spoken
    wake: () => voiceWakeNow(agent),   // null (the default) unless the person turned the wake phrase on and the recognizer is local
    chime: () => voiceWakeChime(vc),
    server: voiceCallServer(agent, () => vc),
    ...(vc.keepAlive ? { keepAlive: vc.keepAlive } : {}),   // the controller starts it with the call and stops it with the call
    ui: {
      mic: (info) => { if (voiceCall !== vc) return; vc.micInfo = info || null; try { voiceLoudSync(); } catch { /* the next sentence syncs it */ } const m = $('cp-mic'); if (m && !vc.micLostOn) m.textContent = voiceMicLine(info); },   // while it is lost the line keeps saying so
      micLost: (on) => {   // the call goes on; the line says the microphone is lost, the meter is empty and a tap tries it again
        if (voiceCall !== vc) return;
        vc.micLostOn = !!on;
        const b = $('cp-retry-mic'); if (b) b.hidden = !on;
        const m = $('cp-mic'); if (m) { m.textContent = on ? 'Microphone lost' : (vc.micInfo ? voiceMicLine(vc.micInfo) : ''); m.classList.toggle('cp-mic-lost', !!on); }
        if (on) voiceCallPaintMeter(-Infinity);
        if (typeof voiceDisplayHook === 'function') voiceDisplayHook('micLost', !!on);
      },
      state: (name, phrase) => { if (voiceCall !== vc) return; voiceCallPaintState(name, phrase); if (typeof voiceDisplayHook === 'function') voiceDisplayHook('setState', name, phrase); if (name === 'ended' && !vc.hangingUp) voiceCallTeardown(vc); },
      thinkingPulse: (ev) => { if (voiceCall === vc && typeof voiceDisplayHook === 'function') voiceDisplayHook('thinkingPulse', ev); },
      reply: (kind) => { if (voiceCall === vc && typeof voiceDisplayHook === 'function') voiceDisplayHook('reply', kind, 'seq:' + vc.sendSeq); },   // the reply's boundaries: the character's reaction plays once, after the whole reply
      thinkingWanted: () => voiceCall === vc && typeof voiceDisplayHook === 'function' && voiceDisplayHook('showsPulse') === true,   // no view shown (None, hidden): the plain thinking sound
      level: (db) => { if (voiceCall === vc) { vc.lastFrame = Date.now(); voiceCallPaintMeter(vc.micLostOn ? -Infinity : db); if (typeof voiceDisplayHook === 'function') voiceDisplayHook('level', db); } },   // a VAD frame ran: the page is alive
      activity: (text) => { const a = $('cp-activity'); if (a && voiceCall === vc) a.textContent = text || ''; },   // silent: shown in the panel only
      heard: (text) => { const h = $('cp-heard'); if (h && voiceCall === vc) h.textContent = text ? `Heard: ${text}` : ''; },
      held: (list) => { if (voiceCall === vc) { voiceCallPaintHeld(list); if (typeof voiceDisplayHook === 'function') voiceDisplayHook('badge', (list || []).length); } },
      toast: (msg) => toast(msg, 4000),
      summary: (text) => { if (chatOpenFor(agent)) { addNote(text); scrollChat(true); } else toast(text, 6000); },   // not saved: it is gone when the chat is drawn again
    },
  };
}

// ── Lost connection ends the call ──
// While a call is up the page asks /health every 5 s (4 s limit); a failed probe, a network failure on the call's own requests (heartbeat, speech-to-text,
// sending, text-to-speech) or the offline event marks the link LOST: a falling two-tone, "Connection lost" on the screens, speech heard meanwhile is dropped,
// probes every 1 s. Back within 10 s: a rising two-tone and "Reconnected." Not back: the call ends cleanly and the chat says so.
function voiceLinkProbe() {
  return new Promise((resolve) => {
    let ac = null;
    try { ac = typeof AbortController === 'function' ? new AbortController() : null; } catch { ac = null; }
    const timer = setTimeout(() => { try { if (ac) ac.abort(); } catch { /* done */ } resolve(false); }, 4000);
    let p;
    try { p = fetch('/health', { cache: 'no-store', credentials: 'include', ...(ac ? { signal: ac.signal } : {}) }); } catch { clearTimeout(timer); resolve(false); return; }
    Promise.resolve(p).then((r) => { clearTimeout(timer); resolve(!!r && !(r.status >= 500)); }, () => { clearTimeout(timer); resolve(false); });   // a server error from a proxy in front of a dead hub counts as unreachable
  });
}
// A network failure (fetch threw a TypeError; not an HTTP error status) seen on one of the active call's requests. vc, or the agent the request was for.
// vc is the call that was up when the request started (null: none, so nothing to report); a late failure never marks a newer call lost.
function voiceLinkNetFail(e, vc, agent) {
  if (!e || e.name !== 'TypeError') return;
  const v = vc;
  if (!v || !v.link || (agent && v.agent !== agent)) return;
  if (typeof voiceCall !== 'undefined' && voiceCall !== v) return;
  try { v.link.report(); } catch { /* gone */ }
}
function voiceLinkPaint(vc, on) {
  if (voiceCall !== vc) return;
  vc.linkLostOn = !!on;
  const s = $('cp-state');
  if (s) { if (on) s.textContent = VOICE_LINK_LOST_TEXT; else s.textContent = voiceCallStateText(s.dataset.state || 'listening', s.dataset.phrase || ''); }   // back: the call's own line, standby's "Waiting for ..." included
  if (typeof voiceDisplayHook === 'function') voiceDisplayHook('connLost', !!on);
}
function voiceCallLinkGiveUp(vc) {
  if (voiceCall !== vc) return;
  voiceCallRelease('link');   // the immediate path: microphone released, the hub told in the background, the display ended with no goodbye
  voiceEndedBar(true, VOICE_LINK_ENDED_TEXT);
}
function voiceLinkMake(vc) {
  if (typeof voiceCreateLinkWatch !== 'function') return;
  const tone = (up) => { if (typeof voiceLinkTone === 'function') voiceLinkTone(vc.thinkCtx, up); };
  const setLost = (on) => { if (vc.call && typeof vc.call.setLinkLost === 'function') vc.call.setLinkLost(on); };
  vc.link = voiceCreateLinkWatch({
    probe: () => voiceLinkProbe(),
    setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t),
    onLost: () => { if (voiceCall !== vc) return; setLost(true); tone(false); voiceLinkPaint(vc, true); },
    onBack: () => { if (voiceCall !== vc) return; voiceLinkPaint(vc, false); tone(true); setLost(false); },
    onGiveUp: () => voiceCallLinkGiveUp(vc),
  });
}

// The tap on the mic button. call.start() runs synchronously in the tap (the controller starts the microphone and
// the audio context first, which iOS only allows inside the tap), so nothing is awaited before it.
function voiceCallStart() {
  if (typeof voiceAutoReadReset === 'function') voiceAutoReadReset();   // a reply to an earlier dictation is not read aloud over the call
  if (voiceCall) return;
  // A call starts with nothing over its controls: the voice panel sits right above the composer, where Hang up is.
  if (typeof voicePanelOpen === 'function' && voicePanelOpen() && typeof voicePanelShow === 'function') voicePanelShow(false);
  if (typeof plusSheetShow === 'function') plusSheetShow(false);
  const agent = current;
  if (!agent) { toast('Pick an agent first'); return; }
  if (!voiceOn()) { toast('Voice is not ready on the hub yet'); return; }
  if (voiceRec.state === 'recording' || voiceRec.state === 'starting') voiceMicCancel();   // dictation stops first
  if (voiceTest.handle) voiceTestStop();
  voiceRoomStop();
  voiceStopPlayback();   // the phone's own speaker must not be heard by the mic
  voiceUnlockAudio();
  const prefs = voicePrefsNow();
  voiceEndedBar(false); voiceCallBgNote = false;   // a new call: the "call ended" bar goes away
  const vc = { agent, call: null, vad: null, callTurns: new Set(), hubTurns: new Map(), asks: new Map(), lastText: '', sendSeq: 0, expecting: false, wake: null, startedAt: Date.now(), lastFrame: Date.now(), lastTick: Date.now(), beatTimer: null, thinkSnd: null, thinkCtx: null, thinkOn: false };
  vc.vad = voiceCreateVad({ baseUrl: '/api/voice/web/', micLevel: prefs.micLevel, interruptSensitivity: prefs.interruptSensitivity, endPause: voiceEndPauseNow(), echoHoldMs: prefs.echoHold });
  voiceThinkingCtxMake(vc);   // iOS: the thinking sound's AudioContext is made and resumed inside this tap, before any await
  if (prefs.keepAlive !== false && vc.thinkCtx && typeof voiceCreateKeepAlive === 'function') vc.keepAlive = voiceCreateKeepAlive({ ctx: vc.thinkCtx });   // the route stays awake in a car or on a speaker; the controller starts it
  if (typeof voiceCreateAudioFocus === 'function') {   // a looping media element: Android then takes full audio focus and other apps pause for the call (inside the tap)
    try { vc.focus = window.__voiceFocusOne || (window.__voiceFocusOne = voiceCreateAudioFocus({ doc: document, URL, Blob })); vc.focus.start().then((ok) => { if (voiceCall === vc && typeof voiceFocusHint === 'function') voiceFocusHint(!ok || (typeof voiceIsIOS === 'function' && voiceIsIOS())); }); } catch { vc.focus = null; }
  }
  vc.call = voiceCreateCall(voiceCallDeps(vc));
  voiceCall = vc;
  if (typeof voiceLinkMake === 'function') voiceLinkMake(vc);   // is the server still there? a lost connection ends the call
  try { window.__voiceBt = { keepAliveRunning: () => !!(vc.keepAlive && vc.keepAlive.running), micInfo: () => vc.micInfo || null, micLost: () => !!vc.micLostOn, echoHold: () => voicePrefsNow().echoHold }; } catch { /* a test hook only */ }
  voiceMediaSession(vc, true);   // Android Chrome: a playing media session is what lets a call go on while the page is hidden
  vc.beatTimer = setInterval(voiceCallBeat, 1000);
  if (vc.link) vc.link.start();
  voiceCallPanel(true); voiceCallPaintState('starting'); voiceMicPaint(); if (typeof voiceDispPaintPanel === 'function') voiceDispPaintPanel();   // the Display select is filled at call start
  if (typeof voiceDispBegin === 'function') voiceDispBegin(vc);   // synchronous, still inside the tap
  const bail = () => { if (voiceCall === vc) voiceCallTeardown(vc); };
  Promise.resolve(vc.call.start()).then((ok) => { if (!ok) bail(); }, bail);
  voiceWakeAcquire(vc);
}
// The "Try the microphone again" tap (the panel's button and the display's own retry control).
function voiceCallRetryMicTap() {
  const vc = voiceCall;
  if (vc && vc.call && typeof vc.call.retryMic === 'function') Promise.resolve(vc.call.retryMic()).then((ok) => { if (!ok && voiceCall === vc) toast('Still no microphone.'); }, () => { if (voiceCall === vc) toast('Still no microphone.'); });
}
function voiceCallWire() {   // the panel's own buttons
  $('cp-hangup')?.addEventListener('click', () => voiceCallHangUp());
  $('cp-levels')?.addEventListener('click', () => openVoiceSheet());
  $('cp-retry-mic')?.addEventListener('click', () => { const vc = voiceCall; if (vc && vc.call && typeof vc.call.retryMic === 'function') Promise.resolve(vc.call.retryMic()).then((ok) => { if (!ok && voiceCall === vc) toast('Still no microphone.'); }, () => { if (voiceCall === vc) toast('Still no microphone.'); }); });   // the call is not ended: the microphone is asked for again (same as voiceCallRetryMicTap; kept inline because the page tests cut this function out on its own)
  $('cp-display')?.addEventListener('change', (e) => voiceDispSetChoice(e.target.value));
  $('cp-display')?.addEventListener('blur', () => voiceDispPaintPanel());   // a list skipped while it had focus is put in now
  voicePanelWire();   // the chat's own voice panel, the mode chip and the "call ended" bar
  $('cp-dnd')?.addEventListener('change', (e) => { if (voiceCall) voiceCall.call.setMode(e.target.checked ? 'dnd' : 'announce'); });
  $('cp-held')?.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button[data-choice]');
    const row = b && b.closest('.cp-item');
    if (b && row && voiceCall) voiceCall.call.decide(row.dataset.id, b.dataset.choice);
  });
  const help = $('cp-help'); if (help) help.textContent = VOICE_CALL_HELP;
}

// Hub events for the call (the same /api/events stream as the chat; see connectEvents).
function voiceCallTurnStart(ev) {
  const vc = voiceCall; if (!vc || !ev || ev.agent !== vc.agent || !ev.turnId) return;
  if (ev.origin && ev.origin.kind === 'user') { vc.callTurns.add(ev.turnId); vc.lastText = ''; if (typeof voiceDisp !== 'undefined') { voiceDisp.turnSeq.set(ev.turnId, vc.sendSeq); if (voiceDisp.turnSeq.size > 64) voiceDisp.turnSeq.delete(voiceDisp.turnSeq.keys().next().value); } }
  else vc.hubTurns.set(ev.turnId, String((ev.origin && (ev.origin.label || ev.origin.from)) || originLabel(ev.origin) || 'A task'));
}
function voiceCallTurnDelta(ev) {
  const vc = voiceCall; if (!vc || !ev || ev.agent !== vc.agent || !vc.callTurns.has(ev.turnId)) return;
  vc.lastText = String(ev.text || '');   // cumulative
  vc.call.onReplyText(vc.lastText, false);
}
function voiceCallTurnActivity(ev) {
  const vc = voiceCall; if (!vc || !ev || ev.agent !== vc.agent || !vc.callTurns.has(ev.turnId)) return;
  if (ev.item) vc.call.onActivity(ev.item);
}
function voiceCallTurnEnd(ev) {
  const vc = voiceCall; if (!vc || !ev || ev.agent !== vc.agent) return;
  if (vc.callTurns.has(ev.turnId)) {
    vc.callTurns.delete(ev.turnId); vc.expecting = false;
    vc.call.onReplyText(ev.ok === false ? vc.lastText : String(ev.reply || vc.lastText || ''), true);
    return;
  }
  if (!vc.hubTurns.has(ev.turnId)) return;
  const label = vc.hubTurns.get(ev.turnId); vc.hubTurns.delete(ev.turnId);
  // A turn the hub started (a held item allowed with Now): only "<label>: <first sentence>" is spoken, the rest stays in the chat.
  if (ev.ok === false || !ev.reply || vc.call.state !== 'listening') return;
  const first = (voiceSentences(voiceSpeechText(String(ev.reply))) || [])[0];
  if (!first) return;
  vc.call.onReplyText('', false);   // a fresh reading for the controller (it counts sentences per reply)
  vc.call.onReplyText(`${label}: ${first}`, true);
}
function voiceCallTurnMood(ev) {   // turn_mood { agent, turnId, mood }: only the call's own turns
  const vc = voiceCall; if (!vc || !ev || ev.agent !== vc.agent || !vc.callTurns.has(ev.turnId)) return;
  voiceDispMood(voiceDisp.turnSeq.has(ev.turnId) ? voiceDisp.turnSeq.get(ev.turnId) : vc.sendSeq, ev.mood);
}
function voiceCallAsk(ev) {
  const vc = voiceCall; if (!vc || !ev || ev.agent !== vc.agent || !ev.request_id) return;
  if (Array.isArray(ev.questions) && ev.questions.length > 1) { toast('Answer these questions on screen'); return; }   // several questions: no voice answer, no partial answer
  const q0 = Array.isArray(ev.questions) && ev.questions[0] ? ev.questions[0] : {};
  const question = String(ev.question || q0.question || '');
  vc.asks.set(ev.request_id, question);
  vc.call.onAsk({ request_id: ev.request_id, question, options: Array.isArray(ev.options) && ev.options.length ? ev.options : (q0.options || []) });
}
function voiceCallAskDone(ev) {
  const vc = voiceCall; if (!vc || !ev || ev.agent !== vc.agent) return;
  vc.call.onAskDone(ev.request_id); vc.asks.delete(ev.request_id);
}
// Events of another call (an earlier one this call replaced, or one on another device) carry another callId: ignored.
function voiceCallHeld(ev) { const vc = voiceCall; if (vc && ev && ev.agent === vc.agent && ev.callId === vc.call.callId && ev.item) vc.call.onHeld(ev.item, !!ev.quiet); }
function voiceCallHeldDone(ev) { const vc = voiceCall; if (vc && ev && ev.agent === vc.agent && ev.callId === vc.call.callId) vc.call.onHeldDone(ev.id, ev.choice); }
function voiceCallState(ev) {   // the hub says this call is off (it expired, or it ended elsewhere)
  const vc = voiceCall; if (!vc || !ev || ev.agent !== vc.agent || ev.state !== 'off' || ev.callId !== vc.call.callId) return;
  toast('The call ended.'); voiceCallHangUp();
}

// ── Room check (5 s): say a sentence for 2.5 s, then stay quiet for 2.5 s; sets Mic level and Interrupt sensitivity ──
// Pure: speech levels are the loud half of the first part (a sentence has pauses), nothing above -60 dBFS is "no speech heard".
function voiceRoomResult(speechDb, silenceDb, currentMicLevel) {
  const s = Array.from(speechDb || []).filter(Number.isFinite).sort((a, b) => b - a);
  if (!s.length || s[0] <= -60) return { heard: false };
  const loud = s.slice(0, Math.max(1, Math.ceil(s.length / 2)));
  const r = voiceRoomCheck(loud, Array.from(silenceDb || []).filter(Number.isFinite), currentMicLevel);
  return { heard: true, micLevel: r.micLevel, interruptSensitivity: r.interruptSensitivity };
}
const voiceRoom = { running: false, handle: null, tick: null, guard: voiceMicGuard(), root: null };
// The Room check can be run from the chat's voice panel or from the Voice sheet: whichever is open shows its progress.
function voiceRoomRoot() { const p = $('voice-panel'); return p && !p.hidden ? p : $('voice-sheet'); }
function voiceRoomStop() {
  voiceCarStop();   // wherever a Room check lets go of the mic (sheet or panel closed, call started, page hidden), a Car or Bluetooth check does too
  voiceRoom.guard.cancel();
  clearInterval(voiceRoom.tick); voiceRoom.tick = null;
  if (voiceRoom.handle) { voiceRoom.handle.close(); voiceRoom.handle = null; }
  const sh = voiceRoom.root || $('voice-sheet'); voiceRoom.root = null;
  if (voiceRoom.running && sh) { const b = sh.querySelector('.vs-room'); if (b) b.disabled = false; const o = sh.querySelector('.vs-room-out'); if (o) o.textContent = ''; const m = sh.querySelector('.vs-meter i'); if (m) m.style.width = '0%'; }
  voiceRoom.running = false;
}
async function voiceRoomRun() {
  const sh = voiceRoomRoot(); if (!sh || voiceRoom.running) return;
  const out = sh.querySelector('.vs-room-out'), btn = sh.querySelector('.vs-room'), meter = sh.querySelector('.vs-meter i');
  if (voiceCall) { toast('Hang up first: the call is using the microphone'); return; }
  if (voiceRec.state !== 'idle' || voiceRec.guard.pending || voiceTest.guard.pending || voiceTest.handle || voiceCar.running) { toast('The mic is already in use'); return; }
  voiceStopPlayback();
  const start = voicePrefsNow();
  const speech = [], quiet = [];
  voiceRoom.running = true; voiceRoom.root = sh; btn.disabled = true; out.textContent = 'Starting the microphone…';
  const token = voiceRoom.guard.begin();
  let t0 = 0;
  const onChunk = (f) => {
    if (!t0) return;
    const el = (Date.now() - t0) / 1000, db = voiceLevelDb(f);
    if (meter) meter.style.width = `${voiceMeterPaint(f)}%`;
    if (el < 2.5) speech.push(db); else if (el >= 2.8 && el < 5) quiet.push(db);   // the first 0.3 s of the quiet part may hold the end of the sentence
  };
  let handle = null;
  try { handle = await voiceMicOpen(start.micLevel, onChunk); }
  catch (e) { voiceRoom.guard.fail(); if (token === voiceRoom.guard.gen) { voiceRoom.running = false; btn.disabled = false; out.textContent = ''; toast(voiceErr(e), 4500); } return; }
  if (!voiceRoom.guard.settle(token, handle)) return;   // cancelled meanwhile: the stream is already stopped
  voiceRoom.handle = handle; t0 = Date.now();
  const paint = () => {
    const el = (Date.now() - t0) / 1000;
    if (el >= 5) { finish(); return; }
    out.textContent = el < 2.5 ? `Say a sentence… ${Math.ceil(2.5 - el)}` : `Now stay quiet… ${Math.ceil(5 - el)}`;
  };
  const finish = () => {
    clearInterval(voiceRoom.tick); voiceRoom.tick = null;
    if (voiceRoom.handle) { voiceRoom.handle.close(); voiceRoom.handle = null; }
    voiceRoom.running = false; btn.disabled = false; if (meter) meter.style.width = '0%';
    const r = voiceRoomResult(speech, quiet, start.micLevel);
    if (!r.heard) { out.textContent = 'No speech heard: check the microphone and its permission.'; return; }
    voicePrefsSave({ micLevel: r.micLevel, interruptSensitivity: r.interruptSensitivity });
    if (voiceCall) { voiceCall.vad.setMicLevel(r.micLevel); voiceCall.vad.setInterruptSensitivity(r.interruptSensitivity); }
    paintVoiceSheet(); voicePanelPaint();
    out.textContent = `Done: Mic level ${r.micLevel}, Interrupt sensitivity ${r.interruptSensitivity}.` + (r.interruptSensitivity < 30 ? ' This room is noisy, so cutting in needs a firmer voice.' : '');
  };
  voiceRoom.tick = setInterval(paint, 200);
  paint();
}

// ── Voice sheet (menu, Voice) ──
const voiceTest = { handle: null, guard: voiceMicGuard() };
function voiceTestStop() {
  voiceTest.guard.cancel();   // a test mic still being asked for is stopped the moment it arrives
  if (voiceTest.handle) { voiceTest.handle.close(); voiceTest.handle = null; }
  const sh = $('voice-sheet');
  if (sh) { const t = sh.querySelector('.vs-test'); if (t) { t.setAttribute('aria-pressed', 'false'); t.textContent = 'Test mic'; } const m = sh.querySelector('.vs-meter i'); if (m) m.style.width = '0%'; }
}
async function voiceTestToggle() {
  if (voiceTest.handle) { voiceTestStop(); return; }
  if (voiceTest.guard.pending) return;   // a second tap while the microphone is still being asked for
  if (voiceCall) { toast('Hang up first: the call is using the microphone'); return; }
  if (voiceRec.state !== 'idle' || voiceRec.guard.pending || voiceRoom.running || (typeof voiceCar !== 'undefined' && voiceCar.running)) { toast('The mic is already in use'); return; }
  const sh = $('voice-sheet'); const t = sh.querySelector('.vs-test'); const m = sh.querySelector('.vs-meter i');
  const token = voiceTest.guard.begin();
  t.disabled = true;
  let handle = null;
  try {
    handle = await voiceMicOpen(voicePrefsNow().micLevel, (f) => { m.style.width = `${voiceMeterPaint(f)}%`; });
  } catch (e) { voiceTest.guard.fail(); if (token === voiceTest.guard.gen) toast(voiceErr(e), 4500); }
  t.disabled = false;
  if (!handle) return;
  if (!voiceTest.guard.settle(token, handle)) return;   // the sheet was closed (or the page hidden) meanwhile: the stream is already stopped
  voiceTest.handle = handle;
  t.setAttribute('aria-pressed', 'true'); t.textContent = 'Stop test';
}
// ── Car or Bluetooth check (about 4 s): three short test sounds are played on the phone's own output and listened for ──
// The page makes the check's own AudioContext inside the tap (and resumes it, iOS) and hands it to the library: voiceCarRecord opens the microphone, plays
// the chirp three times and records the microphone together with an exact copy of the chirp on one processor (one clock); voiceCarAnalyse measures the
// delay of each chirp. voiceCarCheckResult turns the three analyses into the Echo guard and (if the echo is loud) a lower Interrupt sensitivity.
const voiceCar = { running: false, rec: null, ctx: null, root: null };
function voiceCarCloseCtx() {
  const c = voiceCar.ctx; voiceCar.ctx = null;
  if (c) { try { const p = c.close(); if (p && p.catch) p.catch(() => {}); } catch { /* closed */ } }
}
function voiceCarStop() {
  const rec = voiceCar.rec; voiceCar.rec = null;
  if (rec) { try { rec.cancel(); } catch { /* ended */ } }   // a cancel stops the sounds and lets go of the microphone
  voiceCarCloseCtx();
  const sh = voiceCar.root; voiceCar.root = null;
  if (voiceCar.running && sh) { const b = sh.querySelector('.vs-car'); if (b) b.disabled = false; const o = sh.querySelector('.vs-car-out'); if (o) o.textContent = ''; }
  voiceCar.running = false;
}
async function voiceCarRun() {
  const sh = voiceRoomRoot(); if (!sh || voiceCar.running) return;
  const out = sh.querySelector('.vs-car-out'), btn = sh.querySelector('.vs-car');
  if (!out || !btn) return;
  if (voiceCall) { toast('Hang up first: the call is using the microphone'); return; }
  if (voiceRec.state !== 'idle' || voiceRec.guard.pending || voiceTest.guard.pending || voiceTest.handle || voiceRoom.running) { toast('The mic is already in use'); return; }
  voiceStopPlayback();
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { toast('This browser cannot use the microphone here (it needs https)', 4500); return; }
  voiceCar.running = true; voiceCar.root = sh; btn.disabled = true; out.textContent = 'Playing three short test sounds. Stay quiet.';
  // Everything up to voiceCarRecord happens before the first await: the context is made and resumed inside the tap (iOS).
  let chirp, rec;
  try {
    const ctx = new AC(); voiceCar.ctx = ctx;
    try { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch { /* a running context needs no resume */ }
    chirp = voiceCarChirp(ctx.sampleRate);
    rec = voiceCarRecord({ ctx, nav: navigator, chirp, micLevel: voicePrefsNow().micLevel, setTimer: (f, ms) => setTimeout(f, ms), clearTimer: (h) => clearTimeout(h), now: Date.now });   // the Mic level applies as in a call
    voiceCar.rec = rec;
  } catch (e) { voiceCarStop(); toast(voiceErr(e), 4500); return; }
  let got;
  try { got = await rec.done; }
  catch (e) {
    if (voiceCar.rec !== rec) return;   // voiceCarStop cancelled it (sheet or panel closed, call started, page hidden): it has cleaned up already
    voiceCarStop();
    if (e && e.code === 'audio_not_started') out.textContent = 'The check could not run: the audio did not start. Settings were not changed.';
    else toast(voiceErr(e), 4500);
    return;
  }
  if (voiceCar.rec !== rec) return;
  voiceCar.rec = null; voiceCarCloseCtx();
  voiceCar.running = false; voiceCar.root = null; btn.disabled = false;
  try {
    const analyses = voiceCarAnalyse(got.mic, got.ref, chirp, got.rate);
    const cur = voicePrefsNow();
    const r = voiceCarCheckResult(analyses, { echoHold: cur.echoHold, interruptSensitivity: cur.interruptSensitivity });
    voicePrefsSave({ echoHold: r.echoHold, interruptSensitivity: r.interruptSensitivity });
    if (voiceCall) { try { voiceCall.vad.setEchoHold(r.echoHold); voiceCall.vad.setInterruptSensitivity(r.interruptSensitivity); } catch { /* vad not up */ } }
    paintVoiceSheet(); voicePanelPaint();
    out.textContent = r.line;
  } catch (e) { out.textContent = ''; toast(voiceErr(e), 4500); }
}

// ── Leaving the app (round 2, item 8) ──
// iPhone/iPad (every browser there is WebKit) suspend a hidden page, so the call is released the moment the page is
// hidden. Android Chrome can keep a call going while hidden when Media Session is there (the call holds the mic and
// plays audio); it is released on freeze, pagehide, or when nothing has run for 10 s after coming back (a stall).
// Every release stops the VAD, the raw and the processed mic tracks and the audio contexts: never a stopped call with a held mic.
const VOICE_STALL_MS = 10000;
const VOICE_ENDED_TEXT = 'The call ended when you left the app';
function voiceIsIOS() {
  try {
    const ua = String(navigator.userAgent || '');
    return /iPhone|iPad|iPod/.test(ua) || (String(navigator.platform || '') === 'MacIntel' && Number(navigator.maxTouchPoints) > 1);   // iPadOS asks for the desktop site
  } catch { return false; }
}
function voiceCanStayHidden() { try { return !voiceIsIOS() && !!navigator.mediaSession; } catch { return false; } }
function voiceMediaSession(vc, on) {
  try {
    const ms = navigator.mediaSession; if (!ms) return;
    if (on) {
      if (typeof MediaMetadata !== 'undefined') ms.metadata = new MediaMetadata({ title: 'Voice call', artist: vc && vc.agent ? String(vc.agent) : 'Voice call', album: 'My Maestro' });
      ms.playbackState = 'playing';
      for (const a of ['pause', 'stop']) { try { ms.setActionHandler(a, () => voiceCallHangUp()); } catch { /* action not supported */ } }
    } else {
      ms.playbackState = 'none'; ms.metadata = null;
      for (const a of ['pause', 'stop']) { try { ms.setActionHandler(a, null); } catch { /* action not supported */ } }
    }
  } catch { /* no Media Session: the call is released when hidden instead */ }
}
function voiceCallStalled(vc, now) { return !!vc && now - Math.max(vc.lastFrame || 0, vc.lastTick || 0) > VOICE_STALL_MS; }
function voiceCallBeat() {   // once a second while a call is up: a gap of 10 s with no VAD frame either means the page was suspended
  const vc = voiceCall; if (!vc) return;
  const now = Date.now();
  const gap = now - (vc.lastTick || now);
  if (gap > VOICE_STALL_MS && voiceCallStalled({ lastFrame: vc.lastFrame, lastTick: 0 }, now)) { voiceCallRelease('stall'); if (!document.hidden) voiceEndedBar(true); return; }
  vc.lastTick = now;
}
// Immediate hang-up without waiting for the hub: everything is let go and the person is told when they are back.
function voiceCallRelease(reason) {
  const vc = voiceCall; if (!vc) return;
  voiceCallBgNote = true;
  try { if (typeof vc.call.release === 'function') vc.call.release(reason); else vc.call.hangUp(); } catch { /* the controller is gone */ }
  try { Promise.resolve(vc.vad.stop()).catch(() => {}); } catch { /* already stopped */ }   // belt and braces: stop() is safe to repeat
  voiceCallTeardown(vc);
}
function voiceEndedBar(show, text) {
  const b = $('call-ended-bar');
  if (!b) { if (show) toast(text || VOICE_ENDED_TEXT, 5000); voiceCallBgNote = false; return; }
  if (show) { const t = b.querySelector && b.querySelector('.ceb-text'); if (t) t.textContent = text || VOICE_ENDED_TEXT; }
  b.hidden = !show;
  if (show) voiceCallBgNote = false;
}
function voiceLeaveApp(reason) {   // pagehide / freeze
  voiceCallRelease(reason);
  voiceRoomStop();
  voiceTestStop();
  if (voiceRec.state === 'recording') voiceMicStop();
  else if (voiceRec.state === 'starting') voiceMicCancel();
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    if (voiceCall && voiceCallStalled(voiceCall, Date.now())) voiceCallRelease('stall');
    if (voiceCallBgNote && !voiceCall) voiceEndedBar(true);
    if (voiceCall) voiceWakeAcquire(voiceCall);   // the screen lock is dropped while hidden: asked for again
    return;
  }
  // iOS (and a browser without Media Session) cannot keep the call while hidden: release it now, say so when it returns.
  if (voiceCall && !voiceCanStayHidden()) voiceCallRelease('hidden');
  voiceRoomStop();
  voiceTestStop();
  // A hidden page does not keep the microphone: what was already said is sent, a microphone still being asked for is dropped.
  if (voiceRec.state === 'recording') voiceMicStop();
  else if (voiceRec.state === 'starting') voiceMicCancel();
});
window.addEventListener('pagehide', () => voiceLeaveApp('pagehide'));
window.addEventListener('offline', () => { const vc = typeof voiceCall !== 'undefined' ? voiceCall : null; if (vc && vc.link) vc.link.offline(); });   // the link watch of the active call
window.addEventListener('online', () => { const vc = typeof voiceCall !== 'undefined' ? voiceCall : null; if (vc && vc.link) vc.link.online(); });
document.addEventListener('freeze', () => voiceLeaveApp('freeze'));
window.addEventListener('pageshow', () => { if (!document.hidden && voiceCallBgNote && !voiceCall) voiceEndedBar(true); });
function voiceSheet() {
  let sh = $('voice-sheet');
  if (sh) return sh;
  sh = document.createElement('div');
  sh.id = 'voice-sheet';
  sh.className = 'rsn-sheet voice-sheet';
  sh.setAttribute('role', 'dialog');
  sh.setAttribute('aria-modal', 'true');
  sh.setAttribute('aria-label', 'Voice');
  sh.dataset.noDirty = '';
  sh.innerHTML = '<div class="rsn-sheet-head"><span class="rsn-sheet-title">Voice</span><span class="rsn-sheet-count"></span>' +
    '<button type="button" class="rsn-sheet-close" aria-label="Close">&#x2715;</button></div>' +
    '<div class="vs-body" tabindex="-1">' +
    '<p class="vs-note"></p>' +
    '<label class="vs-row" for="vs-level"><span>Mic level</span><b class="vs-val"></b></label>' +
    '<input type="range" id="vs-level" class="vs-level" min="0" max="100" step="1">' +
    '<div class="vs-meter" aria-hidden="true"><i></i></div>' +
    '<button type="button" class="vs-btn vs-test" aria-pressed="false">Test mic</button>' +
    '<div class="vs-row"><span id="vs-mode-label">Talk mode</span></div>' +
    '<div class="vs-seg" role="radiogroup" aria-labelledby="vs-mode-label">' +
    '<label class="vs-opt"><input type="radio" name="vs-mode" value="handsfree"> <span>Hands-free</span></label>' +
    '<label class="vs-opt"><input type="radio" name="vs-mode" value="tap"> <span>Tap to talk</span></label></div>' +
    '<p class="vs-hint vs-help"></p>' +
    '<label class="vs-row" for="vs-sens"><span>Interrupt sensitivity</span><b class="vs-sens-val"></b></label>' +
    '<input type="range" id="vs-sens" class="vs-level vs-sens" min="0" max="100" step="1">' +
    '<p class="vs-hint">How easily your voice cuts in while the agent is speaking. Lower it in a noisy room.</p>' +
    '<label class="vs-check"><input type="checkbox" id="vs-interrupt"> <span>Show an Interrupt button</span></label>' +
    '<p class="vs-hint">' + VOICE_INTERRUPT_HINT + '</p>' +
    '<label class="vs-row" for="vs-pause"><span>Pause before I&#39;m done</span></label>' +
    '<select id="vs-pause" class="vs-pause vs-btn">' + VOICE_END_PAUSES.map((ms, i) => '<option value="' + ms + '">' + ['Short', 'Normal', 'Long'][i] + '</option>').join('') + '</select>' +
    '<p class="vs-hint">How long a quiet moment ends your turn: short 0.8 s, normal 1.2 s, long 2 s. A short pause can cut you off mid-sentence.</p>' +
    '<label class="vs-row" for="vs-speed"><span>Voice speed</span><b class="vs-speed-val"></b></label>' +
    '<input type="range" id="vs-speed" class="vs-level vs-speed" min="0.75" max="1.5" step="0.05">' +
    '<p class="vs-hint">' + VOICE_SPEED_HINT + '</p>' +
    '<button type="button" class="vs-btn vs-room">Room check</button>' +
    '<div class="vs-room-out" role="status" aria-live="polite"></div>' +
    '<label class="vs-row" for="vs-echo"><span>Echo guard after replies</span></label>' +
    '<select id="vs-echo" class="vs-echo vs-btn">' + VOICE_ECHO_HOLDS.map((ms, i) => '<option value="' + ms + '">' + VOICE_ECHO_LABELS[i] + '</option>').join('') + '</select>' +
    '<p class="vs-hint">' + VOICE_ECHO_HINT + '</p>' +
    '<label class="vs-check"><input type="checkbox" class="vs-keepalive"> <span>Keep Bluetooth awake during calls</span></label>' +
    '<p class="vs-hint">' + VOICE_KEEPALIVE_HINT + '</p>' +
    '<button type="button" class="vs-btn vs-car">Car or Bluetooth check</button>' +
    '<div class="vs-car-out" role="status" aria-live="polite"></div>' +
    '<label class="vs-check"><input type="checkbox" class="vs-read"> <span>Read replies aloud</span></label>' +
    '<p class="vs-hint">After a message you dictated with the mic, the reply is read when it ends. The speaker on a reply reads it any time.</p>' +
    '<label class="vs-check"><input type="checkbox" class="vs-activity"> <span>Say what the agent is doing</span></label>' +
    '<label class="vs-check"><input type="checkbox" class="vs-fallback"> <span>Use this device&#39;s own offline voice when the hub voice is unavailable</span></label>' +
    '<button type="button" class="vs-btn vs-sample">Play sample</button></div>';
  const close = () => { voiceTestStop(); voiceStopPlayback(); voiceRoomStop(); sh.classList.remove('open'); dialogGuard.closed(sh); };
  sh.querySelector('.rsn-sheet-close').addEventListener('click', close);
  sh.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } });
  const level = sh.querySelector('.vs-level');
  // Mic level and Interrupt sensitivity apply live to a call that is up (and to the test mic).
  level.addEventListener('input', () => { sh.querySelector('.vs-val').textContent = level.value; if (voiceTest.handle) voiceTest.handle.setLevel(Number(level.value)); if (voiceCall) voiceCall.vad.setMicLevel(Number(level.value)); });
  level.addEventListener('change', () => voicePrefsSave({ micLevel: Number(level.value) }));
  const sens = sh.querySelector('.vs-sens');
  sens.addEventListener('input', () => { sh.querySelector('.vs-sens-val').textContent = sens.value; if (voiceCall) voiceCall.vad.setInterruptSensitivity(Number(sens.value)); });
  sens.addEventListener('change', () => voicePrefsSave({ interruptSensitivity: Number(sens.value) }));
  const pause = sh.querySelector('.vs-pause');
  pause.addEventListener('change', () => { voicePrefsSave({ endPause: Number(pause.value) }); if (voiceCall) voiceCall.vad.setEndPause(Number(pause.value)); });
  const speed = sh.querySelector('.vs-speed');
  speed.addEventListener('input', () => { sh.querySelector('.vs-speed-val').textContent = voiceSpeedLabel(speed.value); });
  speed.addEventListener('change', () => voicePrefsSave({ voiceSpeed: voiceCleanSpeed(speed.value) }));
  sh.querySelector('.vs-activity').addEventListener('change', (e) => voicePrefsSave({ speakActivity: !!e.target.checked }));
  sh.querySelector('#vs-interrupt').addEventListener('change', (e) => voiceDispSetInterrupt(!!e.target.checked));
  for (const r of sh.querySelectorAll('input[name="vs-mode"]')) r.addEventListener('change', (e) => { if (e.target.checked) { voicePrefsSave({ mode: e.target.value }); voiceMicPaint(); paintVoiceSheet(); } });
  sh.querySelector('.vs-room').addEventListener('click', voiceRoomRun);
  sh.querySelector('.vs-car').addEventListener('click', voiceCarRun);
  const echo = sh.querySelector('.vs-echo');
  echo.addEventListener('change', () => { voicePrefsSave({ echoHold: Number(echo.value) }); voiceCallApplyPrefs(); voicePanelPaint(); });   // a call that is up takes it at once
  sh.querySelector('.vs-keepalive').addEventListener('change', (e) => { voicePrefsSave({ keepAlive: !!e.target.checked }); voicePanelPaint(); });
  sh.querySelector('.vs-read').addEventListener('change', (e) => voicePrefsSave({ readAloud: !!e.target.checked }));
  sh.querySelector('.vs-fallback').addEventListener('change', (e) => { voicePrefsSave({ deviceVoiceFallback: !!e.target.checked }); voiceSpeakPaint(); });
  sh.querySelector('.vs-test').addEventListener('click', voiceTestToggle);
  sh.querySelector('.vs-sample').addEventListener('click', () => { voiceUnlockAudio(); voiceSpeak('This is how replies will sound.', current, null); });
  sh.closeSheet = close;
  document.body.appendChild(sh);
  return sh;
}
function paintVoiceSheet() {
  const sh = $('voice-sheet');
  if (!sh || !sh.classList.contains('open')) return;
  const p = voicePrefsNow();
  const level = sh.querySelector('.vs-level');
  if (document.activeElement !== level) { level.value = String(p.micLevel); sh.querySelector('.vs-val').textContent = String(p.micLevel); }
  const sens = sh.querySelector('.vs-sens');
  if (document.activeElement !== sens) { sens.value = String(p.interruptSensitivity); sh.querySelector('.vs-sens-val').textContent = String(p.interruptSensitivity); }
  const pauseEl = sh.querySelector('.vs-pause');
  if (document.activeElement !== pauseEl) pauseEl.value = String(voiceEndPauseNow());
  const speedEl = sh.querySelector('.vs-speed');
  if (document.activeElement !== speedEl) { speedEl.value = String(voiceSpeedNow()); sh.querySelector('.vs-speed-val').textContent = voiceSpeedLabel(voiceSpeedNow()); }
  sh.querySelector('.vs-activity').checked = !!p.speakActivity;
  const intrEl = sh.querySelector('#vs-interrupt');
  if (intrEl) intrEl.checked = typeof CallDisplay !== 'undefined' && CallDisplay.loadDisplayPrefs(localStorage).interrupt === true;
  const echoEl = sh.querySelector('.vs-echo');
  if (document.activeElement !== echoEl) echoEl.value = String(p.echoHold);
  sh.querySelector('.vs-keepalive').checked = p.keepAlive !== false;
  for (const r of sh.querySelectorAll('input[name="vs-mode"]')) r.checked = r.value === p.mode;
  sh.querySelector('.vs-help').textContent = (p.mode === 'tap' ? 'Tap to talk: tap the mic to dictate a message, tap it again to stop. ' : 'Hands-free: tap the mic to start a call, talk any time, and hang up with the red button. ') + VOICE_CALL_HELP;
  sh.querySelector('.vs-read').checked = !!p.readAloud;
  sh.querySelector('.vs-fallback').checked = !!p.deviceVoiceFallback;
  const note = sh.querySelector('.vs-note');
  note.textContent = voiceOn() ? `Voice is on${voiceStatus.stt && voiceStatus.stt.engine ? ` (${voiceStatus.stt.engine})` : ''}. Tap the mic beside the message box to ${p.mode === 'tap' ? 'dictate' : 'start a hands-free call'}.`
    : voiceStatus.failed ? 'Voice setup failed on the hub. An admin can see the details in Settings on the computer.'
    : voiceStatus.enabled ? (voiceStatus.installing ? `Voice is installing on the hub${Number.isFinite(voiceStatus.progress) ? ` (${Math.round(voiceStatus.progress * 100)}%)` : ''}.` : 'Voice is on, but not ready on the hub yet.')
      : 'Voice is not enabled on the hub. An admin turns it on in Settings on the computer.';
  note.classList.toggle('off', !voiceOn());
}
function openVoiceSheet() {
  $('menu').classList.remove('open');
  const sh = voiceSheet();
  if (!sh.classList.contains('open')) { sh.classList.add('open'); dialogGuard.open(sh, { close: sh.closeSheet }); }
  paintVoiceSheet();
  voiceStatusRefresh();
}

// ── The voice panel in the chat (round 2, item 7): the everyday voice settings one tap from the composer, for every user ──
// A "Hands-free" / "Tap to talk" chip is always visible beside the mic; the levels button opens this panel. Everything
// writes the same per-device prefs as the Voice sheet and reaches a running call at once.
// VOICE_CONTINUE_WAITS comes from the shared voice helpers block above.
const VOICE_WAIT_LABELS = ['Short (1.5 s)', 'Normal (3 s)', 'Long (5 s)'];
function voiceContinueWaitNow() { const v = Number(voicePrefsNow().continueWait); return VOICE_CONTINUE_WAITS.includes(v) ? v : 3000; }
function voicePanelOpen() { const p = $('voice-panel'); return !!p && !p.hidden; }
// The + sheet beside the message box: Attach file, Camera and Voice settings (moved here from the row and the voice strip, same ids).
function plusSheetOpen() { const s = $('plus-sheet'); return !!s && !s.hidden; }
function plusSheetShow(show) {
  const s = $('plus-sheet'), b = $('plus-btn'); if (!s) return;
  s.hidden = !show;
  if (b) b.setAttribute('aria-expanded', show ? 'true' : 'false');
  if (!show) return;
  if (typeof voicePanelOpen === 'function' && voicePanelOpen() && typeof voicePanelShow === 'function') voicePanelShow(false);   // never both open at once
  const first = s.querySelectorAll ? [...s.querySelectorAll('[role="menuitem"]')].find((i) => !i.hidden) : null;
  if (first && first.focus) first.focus();   // keyboard: Tab from + would reach the box and close the sheet; start inside it
}
function plusSheetWire() {
  const s = $('plus-sheet'), b = $('plus-btn'); if (!s || !b) return;
  b.addEventListener('click', (e) => { e.stopPropagation(); plusSheetShow(!plusSheetOpen()); });
  // Capture phase: the sheet closes first, then the item's own handler acts (same tap, so a file picker still opens).
  s.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('[role="menuitem"]')) plusSheetShow(false); }, true);
  s.addEventListener('keydown', (e) => { if (e.key === 'Escape' && plusSheetOpen()) { e.preventDefault(); plusSheetShow(false); b.focus(); } });
  // Escape closes the layer on top: the + sheet if it is open, else an open voice panel (whose own Escape needs focus inside it).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (plusSheetOpen()) { e.preventDefault(); plusSheetShow(false); b.focus(); return; }
    if (typeof voicePanelOpen === 'function' && voicePanelOpen() && typeof voicePanelShow === 'function') { e.preventDefault(); voicePanelShow(false); b.focus(); }
  });
  b.addEventListener('keydown', (e) => { if (e.key === 'Escape' && plusSheetOpen()) { e.preventDefault(); plusSheetShow(false); b.focus(); } });
  document.addEventListener('click', (e) => { if (plusSheetOpen() && !s.contains(e.target) && !(e.target.closest && e.target.closest('#plus-btn'))) plusSheetShow(false); });
  $('msg-input')?.addEventListener('focus', () => plusSheetShow(false));
}
function voiceStripPaint() {
  const on = voiceOn();
  const strip = $('voice-strip'), btn = $('voice-settings-btn'), chip = $('voice-mode-chip');
  if (strip) strip.hidden = !on || !voiceCall;   // the Hands-free pill only while a call is up; the mode stays in Voice settings
  if (btn) btn.hidden = !on;
  if (chip) {
    const hands = voicePrefsNow().mode !== 'tap';
    chip.textContent = hands ? 'Hands-free' : 'Tap to talk';
    chip.classList.toggle('hands', hands);
    chip.setAttribute('aria-label', `Talk mode: ${hands ? 'Hands-free' : 'Tap to talk'}. Tap to switch.`);
  }
  if (!on && voicePanelOpen()) voicePanelShow(false);
  else if (voicePanelOpen()) voicePanelPaint();
}
function voicePanelPaint() {
  const p = $('voice-panel'); if (!p) return;
  const prefs = voicePrefsNow();
  const set = (id, v, labelSel, label) => { const el = $(id); if (el && document.activeElement !== el) el.value = String(v); if (labelSel) { const l = p.querySelector(labelSel); if (l) l.textContent = label; } };
  for (const r of p.querySelectorAll('input[name="vp-mode"]')) r.checked = r.value === prefs.mode;
  set('vp-speed', voiceSpeedNow(), '.vp-speed-val', voiceSpeedLabel(voiceSpeedNow()));
  set('vp-loudness', voiceLoudnessFor(voicePrefsNow(), 'speaker'));
  set('vp-loudness-bt', voiceLoudnessFor(voicePrefsNow(), 'bluetooth'));
  set('vp-pause', voiceEndPauseNow());
  set('vp-wait', voiceContinueWaitNow());
  set('vp-level', prefs.micLevel, '.vp-level-val', String(prefs.micLevel));
  set('vp-sens', prefs.interruptSensitivity, '.vp-sens-val', String(prefs.interruptSensitivity));
  const vol = Math.round(voiceThinkingVolume() * 100);
  set('vp-think-vol', vol, '.vp-think-val', `${vol}%`);
  const think = $('vp-think'); if (think) think.checked = prefs.thinkingSound !== false;
  set('vp-echo', prefs.echoHold);
  const ka = $('vp-keepalive'); if (ka) ka.checked = prefs.keepAlive !== false;
  voiceDispPaintPanel();
  voiceWakePaint();
  const vv = $('vp-think-vol'); if (vv) vv.disabled = prefs.thinkingSound === false;
  const room = $('vp-room'); if (room && !voiceRoom.running) room.disabled = !!voiceCall;
  const car = $('vp-car'); if (car && !voiceCar.running) car.disabled = !!voiceCall;
}
function voicePanelShow(show) {
  const p = $('voice-panel'), b = $('voice-settings-btn'); if (!p) return;
  p.hidden = !show;
  if (b) b.setAttribute('aria-expanded', show ? 'true' : 'false');
  if (show) voicePanelPaint(); else voiceRoomStop();   // a Room check still running lets go of the mic when the panel closes
}
function voicePanelWire() {
  const p = $('voice-panel'); if (!p) return;
  const pause = $('vp-pause');
  if (pause) pause.innerHTML = VOICE_END_PAUSES.map((ms, i) => '<option value="' + ms + '">' + ['Short', 'Normal', 'Long'][i] + '</option>').join('');
  const wait = $('vp-wait');
  if (wait) wait.innerHTML = VOICE_CONTINUE_WAITS.map((ms, i) => '<option value="' + ms + '">' + VOICE_WAIT_LABELS[i] + '</option>').join('');
  const save = (patch) => { voicePrefsSave(patch); voiceCallApplyPrefs(); voiceMicPaint(); voicePanelPaint(); paintVoiceSheet(); };
  $('voice-settings-btn')?.addEventListener('click', (e) => { e.stopPropagation(); voicePanelShow(!voicePanelOpen()); });
  $('voice-mode-chip')?.addEventListener('click', () => save({ mode: voicePrefsNow().mode === 'tap' ? 'handsfree' : 'tap' }));
  for (const r of p.querySelectorAll('input[name="vp-mode"]')) r.addEventListener('change', (e) => { if (e.target.checked) save({ mode: e.target.value }); });
  const speed = $('vp-speed');
  speed?.addEventListener('input', () => { const l = p.querySelector('.vp-speed-val'); if (l) l.textContent = voiceSpeedLabel(speed.value); });
  speed?.addEventListener('change', () => save({ voiceSpeed: voiceCleanSpeed(speed.value) }));
  $('vp-loudness-bt')?.addEventListener('change', (e) => save({ loudnessBt: Object.prototype.hasOwnProperty.call(VOICE_LOUDNESS, e.target.value) ? e.target.value : 'normal' }));   // applied at once when Bluetooth is the current output (voiceLoudSync)
  $('vp-loudness')?.addEventListener('change', (e) => save({ loudness: Object.prototype.hasOwnProperty.call(VOICE_LOUDNESS, e.target.value) ? e.target.value : 'louder' }));   // save() reaches a call that is up (voiceCallApplyPrefs)
  pause?.addEventListener('change', () => save({ endPause: Number(pause.value) }));
  wait?.addEventListener('change', () => save({ continueWait: Number(wait.value) }));
  const echo = $('vp-echo');
  if (echo) echo.innerHTML = VOICE_ECHO_HOLDS.map((ms, i) => '<option value="' + ms + '">' + VOICE_ECHO_LABELS[i] + '</option>').join('');
  $('vp-echo')?.addEventListener('change', () => save({ echoHold: Number(echo.value) }));   // save() reaches a call that is up (voiceCallApplyPrefs)
  $('vp-keepalive')?.addEventListener('change', (e) => save({ keepAlive: !!e.target.checked }));
  $('vp-car')?.addEventListener('click', voiceCarRun);
  const wq = $('vp-wake-quiet');
  if (wq) wq.innerHTML = VOICE_WAKE_QUIET_MS.map((ms) => '<option value="' + ms + '">' + ms / 1000 + ' s</option>').join('');
  for (const id of ['vp-wake', 'vp-wake-phrase', 'vp-wake-quiet']) $(id)?.addEventListener('change', () => voiceWakeSave());
  const level = $('vp-level');
  level?.addEventListener('input', () => { const l = p.querySelector('.vp-level-val'); if (l) l.textContent = level.value; if (voiceCall) voiceCall.vad.setMicLevel(Number(level.value)); });
  level?.addEventListener('change', () => save({ micLevel: Number(level.value) }));
  const sens = $('vp-sens');
  sens?.addEventListener('input', () => { const l = p.querySelector('.vp-sens-val'); if (l) l.textContent = sens.value; if (voiceCall) voiceCall.vad.setInterruptSensitivity(Number(sens.value)); });
  sens?.addEventListener('change', () => save({ interruptSensitivity: Number(sens.value) }));
  $('vp-think')?.addEventListener('change', (e) => {
    save({ thinkingSound: !!e.target.checked });
    if (!e.target.checked && voiceCall && voiceCall.thinkOn) voiceThinkingDeps(voiceCall).stop();   // switched off while pulsing: quiet at once
  });
  const vol = $('vp-think-vol');
  vol?.addEventListener('input', () => { const l = p.querySelector('.vp-think-val'); if (l) l.textContent = `${vol.value}%`; });
  vol?.addEventListener('change', () => save({ thinkingVolume: Math.max(0, Math.min(1, Number(vol.value) / 100)) }));
  $('vp-room')?.addEventListener('click', voiceRoomRun);
  $('vp-display')?.addEventListener('change', (e) => voiceDispSetChoice(e.target.value));
  $('vp-display')?.addEventListener('blur', () => voiceDispPaintPanel());   // a list skipped while it had focus is put in now
  $('vp-captions')?.addEventListener('change', (e) => voiceDispSetCaptions(!!e.target.checked));
  $('vp-interrupt')?.addEventListener('change', (e) => voiceDispSetInterrupt(!!e.target.checked));
  p.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); voicePanelShow(false); $('plus-btn')?.focus(); } });   // its opener now lives in the closed + sheet
  document.addEventListener('click', (e) => { if (voicePanelOpen() && !p.contains(e.target) && !(e.target.closest && e.target.closest('#voice-settings-btn'))) voicePanelShow(false); });
  $('call-again')?.addEventListener('click', () => { voiceEndedBar(false); voiceCallStart(); });
  $('call-ended-x')?.addEventListener('click', () => voiceEndedBar(false));
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
  composerTypingPaint();
  input.style.height = 'auto';
  if (input.value) input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}
// A reload the app wants (a new version, a hub restart) waits while the message box is in use: focused or holding
// text. At most 10 minutes; the draft is saved either way, so even a reload that has to happen brings the text back.
function typingNow() { const i = $('msg-input'); return !!i && (document.activeElement === i || !!i.value.trim()); }
// The phone's composer while the message box has focus (the keyboard is up): #composer gets 'typing' (the CSS hides attach, camera
// and the voice strip on a narrow screen so the box gets the width). Leaving the box brings them back, also with a draft in it, so a
// file can be attached to a typed message. Called on focus / blur / input and after the page fills or clears the box.
function composerTypingPaint() {
  const c = $('composer'), i = $('msg-input'); if (!c || !i) return;
  c.classList.toggle('typing', document.activeElement === i);
}
// The call panel in compact mode (box focused, or a short screen such as a phone with the keyboard open): the CSS keeps only the
// state line, held items and mic trouble. Never inside the call display's drawer, which has its own room.
function callPanelCompactPaint() {
  const p = $('call-panel'), i = $('msg-input'); if (!p) return;
  const vv = window.visualViewport;
  const h = vv && vv.height ? vv.height : window.innerHeight;
  const inDrawer = !!(p.closest && p.closest('.ucd-drawer'));
  p.classList.toggle('compact', !inDrawer && ((!!i && document.activeElement === i) || h < 600));
}
function composerPaintAll() { composerTypingPaint(); callPanelCompactPaint(); }

// `fallback` is set when an interjection found the turn already over: the text and its user
// bubble are reused instead of being read from the composer again.
async function sendMessage(fallback) {
  if (typeof plusSheetShow === 'function') plusSheetShow(false);   // sending closes the + sheet
  const linkOwner = typeof voiceCall !== 'undefined' ? voiceCall : null;   // a failed send is charged only to the call that was up when it was sent
  if (!current) { toast('Pick an agent first'); return; }
  const agent = fallback ? fallback.agent : current;
  // While the agent is busy (a turn this phone is streaming or one started elsewhere) the
  // composer interjects into that turn; Stop is in the header.
  if (!fallback && (isBusy(agent) || ownTurnFor(agent))) { await sendInterjection(agent); return; }
  if (!fallback) tzSentAt = Date.now();   // the person's own send: its request carries the phone's zone (zoneHeader)
  const input = $('msg-input');
  const text = fallback ? fallback.text : input.value.trim();
  const images = fallback ? [] : pendingImages.slice();
  if (!text && !images.length) return;

  if (!fallback) {
    input.value = '';
    input.style.height = 'auto';
    saveDraft(agent, '');
    composerTypingPaint();
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
  if (!fallback) setBubbleTime(userEl, msgTimeLabel(Date.now()));
  const bubble = addAssistantBubble();
  bubble.body.innerHTML = '<span style="opacity:.6">⏳ Thinking…</span>';
  scrollChat(true);

  const controller = new AbortController();
  const rec = { controller, agent, text, images, bubble, userEl, startedAt: Date.now(), full: '', gotAny: false, feed: newFeed(true), question: null, dictated: !fallback && voiceTakeDictated(agent), readGen: voiceAutoReadGen };
  streams.set(agent, rec);
  paintChatStatus();

  let lost = false;
  let sent = true;
  try {
    const r = await api('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...zoneHeader() },
      signal: controller.signal,
      body: JSON.stringify({ agent, message: text, images, confirm_tools: false, ...(fallback && fallback.voice ? { voice: true } : {}), ...(fallback && fallback.voice && typeof voiceFacePackBody === 'function' ? voiceFacePackBody() : {}) }),   // facePack only while a character with reactions is on screen   // voice: the message came from a hands-free call
    });
    if (r.status === 409) {
      sent = false;
      rec.bubble.el.remove();
      rec.userEl?.remove();
      fallback?.noteEl?.remove();
      if (fallback && fallback.voice) {
        toast(`${displayName(agent)} is busy; your spoken message was not sent`);   // a call keeps the composer as it was
      } else if (current === agent) {
        input.value = text;
        saveDraft(agent, text);
        composerTypingPaint();
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
      if (bubbleLive(rec) && !reattaches.has(agent)) setBubbleTime(rec.bubble.el, msgTimeLine(Date.now(), rec.startedAt));
      if (!rec.gotAny && bubbleLive(rec)) rec.bubble.body.innerHTML = '<span style="opacity:.6">[No response]</span>';
      if (current === agent) rereadHistory(agent);   // the finished exchange, as the hub saved it
      try { voiceAutoRead(rec); } catch { /* reading aloud never breaks a reply */ }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      if (bubbleLive(rec) && !rec.stale) {
        if (!rec.gotAny) rec.bubble.body.innerHTML = '<span style="opacity:.6">(stopped)</span>';
        else addNote('(stopped)');
      }
    } else if (e.name === 'TypeError' || /HTTP 50[234]/.test(e.message || '') || /network|fetch|stream|socket/i.test(e.message || '')) {
      if (typeof voiceLinkNetFail === 'function') voiceLinkNetFail(e, linkOwner, agent);   // a call's own message that did not get through: the link is lost
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
    if (!lost) { feedEnd(rec, rec.done ? 'sure' : 'maybe'); reasoningEnd(rec); }   // fold the activity feed under the finished reply; the reasoning is done
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

// A hub turn of this agent is followed on screen (onTurnStart drew its bubble and it is still in the chat).
function followedHubTurn(agent) {
  return Object.values(hubTurns).some(t => t && t.agent === agent && t.el && t.el.isConnected);
}
// The open chat's agent is mid-turn on the server and this phone has no stream to it (page just
// loaded, woke from sleep, or the turn was started from another device): follow it.
function reattachIfIdle(agent, partial = '') {
  if (!agent || !chatOpenFor(agent) || streams.has(agent) || reattaches.has(agent)) return;
  if (followedHubTurn(agent)) return;   // that turn is already drawn live; a re-attach would be a second copy
  const s = live[agent];
  if (!s || !s.busy) return;
  // a followed hub turn whose bubble a redraw removed (chat left and opened again): the re-attach takes over from it
  for (const [id, t] of Object.entries(hubTurns)) if (t && t.agent === agent && !(t.el && t.el.isConnected)) delete hubTurns[id];
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

function finishReattach(ra, reply, ok = true, how = 'sure') {
  if (!ra || reattaches.get(ra.agent) !== ra) return;
  reattaches.delete(ra.agent);
  reasoningEnd(ra);
  if (bubbleLive(ra)) {
    ra.line?.remove();
    setReplyText(ra, reply);
    feedEnd(ra, how);
    ra.bubble.el.classList.toggle('error', !ok);
    if (ok) setBubbleTime(ra.bubble.el, msgTimeLine(Date.now(), ra.sentAt || Date.parse(ra.since)));
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
  finishReattach(ra, partial ? `${partial}\n\n(stopped)` : '(stopped)', true, 'maybe');
}

function reattachCheckAll() {
  for (const ra of reattaches.values()) reattachCheck(ra);
}

// Shared verbatim with lib/ui-turn-reply.js and app.js (test/ui-turn-reply.test.js keeps the three in step).
// ── turn-reply helpers (begin) ──
function turnReplyFrom(history, start, minTs) {
  let reply = null, content = '';
  for (let i = Math.max(0, start); i < history.length; i++) {
    const m = history[i];
    if (!m) continue;
    if (m.role === 'user' && !m.ask) break;                                  // the next turn
    if (m.role !== 'assistant' || m.ask || typeof m.content !== 'string') continue;
    if (minTs && m.ts && Date.parse(m.ts) < minTs) continue;
    if (!reply) { reply = m; content = m.content; continue; }                 // the reply's first piece
    if (m.base > 0 && m.base === content.length) { reply = m; content += m.content; continue; }   // the next piece
    break;                                                                    // another reply: not this turn's
  }
  return reply ? { ...reply, content } : null;
}
function turnReplySince(history, sinceTs) {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m || (m.role === 'user' && !m.ask) || !m.ts || !(Date.parse(m.ts) >= sinceTs)) return null;
    if (m.role === 'assistant' && !m.ask && typeof m.content === 'string' && !(m.base > 0)) return turnReplyFrom(history, i, sinceTs);
  }
  return null;
}
// ── turn-reply helpers (end) ──

async function reattachCheck(ra) {
  if (!ra || ra.checking || reattaches.get(ra.agent) !== ra) return;
  ra.checking = true;
  try {
    const r = await api(`/api/history/${encodeURIComponent(ra.agent)}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const hist = (await r.json()).history || [];
    if (reattaches.get(ra.agent) !== ra) return;
    const ui = ra.text ? ownEntryIndex(hist, ra.text, ra.sentAt || ra.startedAt, r.headers.get('Date')) : -1;
    // The whole reply: in pieces when the agent asked a question meanwhile (lib/ui-turn-reply.js).
    let reply = null;
    if (ui >= 0) {
      reply = turnReplyFrom(hist, ui + 1, hist[ui].ts ? new Date(hist[ui].ts).getTime() : 0);
    } else if (!ra.text && ra.since) {
      // No user entry to anchor on: the newest reply written since the turn began.
      reply = turnReplySince(hist, new Date(ra.since).getTime() - 2000);
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
        if (input && !input.value && current === ra.agent) { input.value = ra.text; composerTypingPaint(); }
        finishReattach(ra, '⚠ The hub has no record of this message, so it is back in the input box. If you are not sure it was lost, reload the chat before sending it again.', false);
      } else {
        finishReattach(ra, `${ra.partial ? ra.partial + '\n\n' : ''}⚠ ${displayName(ra.agent)} stopped without a reply (the hub may have restarted).`, false);
      }
      return;
    }
    if (waited > REATTACH_GIVE_UP_MS) {
      finishReattach(ra, `${ra.partial ? ra.partial + '\n\n' : ''}⚠ Gave up waiting after 30 minutes. Pull to refresh to see the reply if it arrived.`, false, 'maybe');
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
      case 'voice_mood': voiceCallSseMood(rec, g.mood); break;   // the agent's mood word, already stripped from the text
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
        feedUpsert(rec, { kind: 'worker', id: `w:${g.worker_id}`, workerId: g.worker_id, status: g.type === 'worker_completed' ? 'completed' : 'failed', error: g.error, cancelled: g.cancelled === true });
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
      if (data === '[DONE]') { rec.done = true; continue; }   // the hub's own end of the reply (not a cut connection)
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
// Shared verbatim with lib/ui-retire.js and app.js (test/ui-retire.test.js keeps the three in step).
// ── retire helpers (begin) ──
const RETIRE_AFTER_MS = 4000;
const RETIRE_FOLD_MS = 600;
function retireSoon(el, ms = RETIRE_AFTER_MS) {
  if (!el || !el.dataset || el.dataset.retiring) return false;
  el.dataset.retiring = '1';
  setTimeout(() => {
    if (!el.isConnected) { delete el.dataset.retiring; return; }   // gone meanwhile: if it comes back, it can be retired again
    el.style.maxHeight = el.offsetHeight + 'px';   // fold from its own height, not from "none"
    void el.offsetHeight;
    el.classList.add('retiring');
    setTimeout(() => el.remove(), RETIRE_FOLD_MS);
  }, ms);
  return true;
}
// ── retire helpers (end) ──

// An answered or closed question box says how it ended, then leaves a few seconds later (lib/ui-retire.js).
function closeQuestion(requestId, how) {
  const box = questionBoxes.get(requestId);
  if (!box) return;
  // The hub's outcome, unless it confirms the answer this box already shows ("Answered: …", sent from here)
  if (how !== 'answered' || !box.querySelector('.done')) box.innerHTML = `<div class="done">${how === 'no_answer' ? 'No answer in time; the agent carried on' : how === 'skipped' ? 'Skipped' : 'Answered elsewhere'}</div>`;
  questionBoxes.delete(requestId);
  retireSoon(box);
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
    }).then(r => { if (r.ok) { questionBoxes.delete(request_id); retireSoon(box); } })   // the hub has the answer: the box can go
      .catch(err => toast(`Could not send answer: ${err.message}`));
    box.innerHTML = `<div class="done">Answered: ${esc(label)}</div>`;   // kept in questionBoxes until the hub confirms or closes it
  };
  // The hub's "Skip" choice (ask_user allow_skip) is a Skip button beside Submit that answers at once; with several
  // questions each keeps its own Skip choice and the button skips them all (as on the desktop page).
  const isSkip = (o) => o && String(o.label || '').trim().toLowerCase() === 'skip';
  const canSkip = questions.every(q => (q.options || []).some(isSkip));
  const shownOptions = (q) => (q.options || []).filter(o => !(isSkip(o) && questions.length === 1));
  const textOnly = questions.every(q => !shownOptions(q).length && !(Array.isArray(q.models) && q.models.length));
  // A tap only selects (highlighted); nothing is sent until Submit, so a mis-tap cannot answer the agent.
  const selected = {};
  const groups = {};
  const picks = {};
  questions.forEach((q, i) => {
    if (q.header) { const h = document.createElement('div'); h.className = 'qh'; h.textContent = q.header; box.appendChild(h); }
    const t = document.createElement('div');
    t.className = 'qt';
    t.textContent = q.question || '';
    box.appendChild(t);
    groups[i] = [];
    for (const opt of shownOptions(q)) {
      const b = document.createElement('button');
      b.className = 'opt';
      b.innerHTML = `<strong>${esc(opt.label)}</strong>${opt.description ? `<small>${esc(opt.description)}</small>` : ''}`;
      b.addEventListener('click', () => {
        const was = b.classList.contains('selected');
        groups[i].forEach(x => x.classList.remove('selected'));
        if (was) delete selected[i];                            // tapping the highlighted option again clears it
        else { b.classList.add('selected'); selected[i] = opt.label; }
        if (picks[i]) picks[i].value = '';
        refresh();
      });
      groups[i].push(b);
      box.appendChild(b);
    }
    // ask_user with choose_model: every model the hub can use, as a drop-down; picking there clears the buttons, and a
    // button clears it. The answer is the model id.
    if (Array.isArray(q.models) && q.models.length) {
      const wrap = document.createElement('label');
      wrap.className = 'qmodel';
      const cap = document.createElement('span');
      cap.textContent = 'Or pick any model this hub can use';
      const sel = document.createElement('select');
      sel.appendChild(new Option('Choose a model…', ''));
      const og = new Map();
      for (const m of q.models) {
        if (!m || !m.id) continue;
        if (!og.has(m.group)) { const g = document.createElement('optgroup'); g.label = String(m.group || 'Other'); og.set(m.group, g); sel.appendChild(g); }
        og.get(m.group).appendChild(new Option(String(m.label || m.id), String(m.id)));
      }
      sel.addEventListener('change', () => {
        groups[i].forEach(x => x.classList.remove('selected'));
        if (sel.value) selected[i] = sel.value; else delete selected[i];
        refresh();
      });
      picks[i] = sel;
      wrap.appendChild(cap); wrap.appendChild(sel);
      box.appendChild(wrap);
    }
  });
  const custom = document.createElement('div');
  custom.className = 'qcustom';
  // A text box that grows with the answer (Return is a new line; Submit sends).
  custom.innerHTML = `<textarea rows="3" placeholder="${textOnly ? 'Type your answer' : 'Or type your own answer'}"></textarea>`;
  const actions = document.createElement('div');
  actions.className = 'qactions';
  actions.innerHTML = '<span class="qhint"></span><span class="qbuttons">' + (canSkip ? '<button class="qskip" type="button">Skip</button>' : '') + '<button class="qsubmit" disabled>Submit</button></span>';
  const input = custom.querySelector('textarea');
  const submitBtn = actions.querySelector('.qsubmit');
  const hint = actions.querySelector('.qhint');
  const refresh = () => {
    const typed = input.value.trim();
    const complete = typed || questions.every((q, i) => selected[i] !== undefined);
    submitBtn.disabled = !complete;
    hint.textContent = typed ? 'Your typed answer will be sent.' : complete ? 'Press Submit to send.' : textOnly ? 'Type your answer, then press Submit.' : (questions.length > 1 ? 'Pick an answer for each question.' : 'Pick an answer, then press Submit.');
  };
  const grow = () => { if (input.scrollHeight > input.clientHeight && input.clientHeight < 240) input.style.height = Math.min(input.scrollHeight + 2, 240) + 'px'; };
  const send = () => {
    const v = input.value.trim();
    const answers = {};
    if (v) { questions.forEach((q, i) => { answers[String(i)] = v; }); submit(answers, v); return; }
    if (!questions.every((q, i) => selected[i] !== undefined)) return;
    questions.forEach((q, i) => { answers[String(i)] = selected[i]; });
    // A pick from the model list is sent as its id and shown as it reads in the list.
    submit(answers, questions.map((q, i) => (picks[i] && picks[i].value ? picks[i].options[picks[i].selectedIndex].text : selected[i])).join(' / '));
  };
  submitBtn.addEventListener('click', send);
  const skipBtn = actions.querySelector('.qskip');
  if (skipBtn) skipBtn.addEventListener('click', () => {
    const answers = {};
    questions.forEach((q, i) => { answers[String(i)] = (q.options || []).find(isSkip).label; });
    submit(answers, 'Skipped');
  });
  input.addEventListener('input', () => { grow(); refresh(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && input.value.trim()) { e.preventDefault(); send(); }
  });
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
const APPROVAL_DETAIL_LABELS = { command: 'Command', path: 'Path', paths: 'Paths', to: 'To', channel: 'Channel', text: 'Text', reason: 'Why flagged', tool: 'Tool', input: 'Arguments', name: 'Name', model: 'Model', module: 'Module' };

function approvalWants(ev) {
  if (ev.cls === 'module') return `${displayName(ev.agent)} needs your OK${ev.detail && ev.detail.module ? ` (${ev.detail.module})` : ''}`;   // asked by a module (hub/approve)
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
    (ev.cls === 'module' ? '' : '<button class="ok1h" data-decision="allow" data-remember="1h">Approve this kind for 1 hour</button>') +   // a module's question is asked once: no "remember" choice
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

// ── Wallet (⋮ menu, admins only): a full-screen sheet over GET /api/wallet/status. Locked or unlocked, unlock with
// Face ID / fingerprint (pkUnlock) or the passphrase, set up or remove this phone's passkey (pkAdd), and the after-restart
// notice switch. Like the desktop's Wallet panel; a /mobile?wallet=unlock link (the notice's tap) opens it. ──
let walletStatus = null;   // the last GET /api/wallet/status
let walletMsg = null;      // { text, ok }: the result line inside the sheet
let walletBusy = false;
// One wallet run at a time (a Face ID / fingerprint add or unlock, a passphrase unlock, a remove):
// { ctrl, cancelled, rejectConfirm, confirmRow, fields } (the run's own confirm row and passphrase inputs). Closing the
// sheet cancels it and cleans up at once; the cancelled run's own code then finds pkRunEnd(run) false and does nothing.
// walletGen counts status loads and runs: a load only paints while it is still the latest and no run is going.
let pkRun = null;
let walletGen = 0;
const PK_ENROLL_MS = 110000;   // an add gives up after this long; the server's challenge lives 120 seconds
function pkRunStart(confirmRow, fields) {
  if (pkRun) return null;
  const run = { ctrl: new AbortController(), cancelled: false, rejectConfirm: null, confirmRow, fields: fields || [], timer: null };
  pkRun = run;
  walletSetBusy(true);
  walletGen++;
  return run;
}
function pkRunCleanup(run) {
  if (run.timer) { clearTimeout(run.timer); run.timer = null; }
  walletSetBusy(false);
  if (run.confirmRow && run.confirmRow.isConnected) run.confirmRow.innerHTML = '';
  for (const f of run.fields) f.value = '';
}
function pkCancel() {
  if (!pkRun) return;
  const run = pkRun; pkRun = null; run.cancelled = true;
  try { run.ctrl.abort(); } catch { /* already finished */ }
  if (run.rejectConfirm) { const rej = run.rejectConfirm; run.rejectConfirm = null; rej(new DOMException('Cancelled.', 'AbortError')); }
  pkRunCleanup(run);
}
function pkRunEnd(run) {
  if (pkRun !== run) return false;
  pkRun = null; pkRunCleanup(run);
  return true;
}
async function walletApi(path, body, signal) {
  const r = await fetch('/api/wallet/' + path, body === undefined ? { credentials: 'include', signal }
    : { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
// Closing the sheet: cancel any run, drop in-flight loads, and empty every password input in it (run or no run).
function walletClose(sh) {
  pkCancel(); walletGen++;
  sh.querySelectorAll('input[type="password"]').forEach((i) => { i.value = ''; });
  sh.classList.remove('open'); dialogGuard.closed(sh);
}
function walletSheet() {
  let sh = $('wallet-sheet');
  if (sh) return sh;
  sh = document.createElement('div');
  sh.id = 'wallet-sheet';
  sh.className = 'rsn-sheet mh-sheet wallet-sheet';
  sh.setAttribute('role', 'dialog');
  sh.setAttribute('aria-modal', 'true');
  sh.setAttribute('aria-label', 'Wallet');
  sh.dataset.noDirty = '';   // its fields are emptied before every request: nothing to lose
  sh.innerHTML = '<div class="rsn-sheet-head"><span class="rsn-sheet-title">Wallet</span>' +
    '<button type="button" class="rsn-sheet-close" aria-label="Close">&#x2715;</button></div><div class="mh-body wl-body" tabindex="-1"></div>';
  const close = () => walletClose(sh);
  sh.querySelector('.rsn-sheet-close').addEventListener('click', close);
  sh.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } });
  sh.addEventListener('click', (e) => { const b = e.target.closest('[data-wl]'); if (b && !walletBusy) walletAct(b.dataset.wl, b.dataset.id); });
  sh.addEventListener('change', (e) => { if (e.target.id === 'wl-notice') walletLockedNotice(e.target); });
  sh.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || walletBusy) return;
    if (e.target.id === 'wl-pass') { e.preventDefault(); walletAct('unlock'); }
    else if (e.target.id === 'wl-pk-pass') { e.preventDefault(); walletAct('pkadd'); }
  });
  sh.closeSheet = close;
  document.body.appendChild(sh);
  return sh;
}
function openWalletSheet() {
  $('menu').classList.remove('open');
  if (!isAdmin()) return;
  const sh = walletSheet();
  if (!sh.classList.contains('open')) { sh.classList.add('open'); dialogGuard.open(sh, { close: sh.closeSheet }); }
  walletMsg = null; walletStatus = null;   // never show the last open's status while this load runs
  walletPaint();
  walletLoad();
}
async function walletLoad(msg) {
  if (msg !== undefined) walletMsg = msg;
  const gen = ++walletGen;
  let status = null, failed = null;
  try { status = await walletApi('status'); }
  catch (e) { failed = { text: pkErrorText(e), ok: false }; }
  // A newer load, a run, or closing the sheet since this started: paint nothing.
  const sh = $('wallet-sheet');
  if (gen !== walletGen || !sh || !sh.classList.contains('open') || pkRun) return;
  if (failed && walletStatus) { walletShowMsg(failed.text, false); return; }   // keep the form (and what is typed in it) when a refresh fails
  walletStatus = status;
  if (failed) walletMsg = failed;
  walletPaint();
}
function walletPaint() {
  const sh = $('wallet-sheet');
  if (!sh || !sh.classList.contains('open')) return;
  const body = sh.querySelector('.wl-body');
  const s = walletStatus, ks = s && s.keystore;
  const msg = walletMsg ? `<div class="sec-msg wl-msg${walletMsg.ok ? ' ok' : ''}" role="status">${esc(walletMsg.text)}</div>` : '';
  if (!ks) { body.innerHTML = `<p class="wl-status">Loading…</p>${msg}`; return; }
  if (!ks.exists) { body.innerHTML = `<p class="wl-status">No wallet is set up on this hub.</p>${msg}`; return; }
  const n = Array.isArray(s.wallets) ? s.wallets.length : 0;
  const pkOk = pkUsable(), pkList = Array.isArray(ks.passkeys) ? ks.passkeys : [];
  const pkHere = pkOk.ok && pkList.some(p => p.rpId === location.hostname);
  const unlockBox = ks.unlocked ? '' : `<div class="sec-section">
      ${pkHere ? '<button type="button" class="wl-big" data-wl="pkunlock">Unlock with Face ID / fingerprint</button>' : ''}
      <input id="wl-pass" type="password" autocomplete="off" placeholder="Wallet passphrase" aria-label="Wallet passphrase">
      <div class="sec-actions"><button type="button" data-wl="unlock">Unlock with passphrase</button></div>
    </div>`;
  const rows = pkList.map(p => `<div class="wl-pk"><div class="wl-pk-info"><strong>${esc(p.label)}</strong>
        <span class="sec-hint">${esc(p.rpId)} · added ${esc(new Date(p.createdAt).toLocaleDateString())}</span></div>
        <button type="button" class="wl-rm" data-wl="pkremove" data-id="${esc(p.id)}">Remove</button></div>`).join('')
    || '<div class="sec-hint">None set up yet.</div>';
  const addForm = pkOk.ok ? `<input id="wl-pk-label" value="${esc(pkDeviceLabel())}" maxlength="40" placeholder="Name for this phone" aria-label="Name for this phone">
      <input id="wl-pk-pass" type="password" autocomplete="off" placeholder="Wallet passphrase (needed once; never stored)" aria-label="Wallet passphrase">
      <div id="wl-confirm-row"></div>
      <div class="sec-actions"><button type="button" class="go" data-wl="pkadd">Add this phone</button></div>`
    : `<div class="sec-hint">${esc(pkOk.text)}</div>`;
  const keep = {};   // what the person is typing survives a status repaint (closing the sheet and every run empty these fields themselves)
  for (const id of ['wl-pass', 'wl-pk-pass', 'wl-pk-label']) { const el = sh.querySelector('#' + id); if (el && el.value) keep[id] = el.value; }
  const focused = document.activeElement && sh.contains(document.activeElement) ? document.activeElement.id : '';
  body.innerHTML = `<p class="wl-status">${ks.unlocked ? '&#x1F513; Unlocked' : '&#x1F512; Locked'} · ${n} wallet${n === 1 ? '' : 's'}</p>${msg}${unlockBox}
    <div class="sec-section"><div class="sec-title">Face ID / fingerprint</div>
      <div class="sec-hint">Unlock the wallet with Face ID, a fingerprint or the screen lock instead of typing the passphrase. Add each device once with the passphrase. Your device's password manager may copy the passkey to your other devices; each one still asks for your face, fingerprint or screen lock.</div>
      ${rows}${addForm}
    </div>
    <label class="wl-notice"><input type="checkbox" id="wl-notice" ${s.lockedNotice ? 'checked' : ''}> Send admins a phone notice when the wallet is locked after a restart</label>`;
  for (const [id, v] of Object.entries(keep)) { const el = sh.querySelector('#' + id); if (el) el.value = v; }
  if (focused) { const el = sh.querySelector('#' + focused); if (el && typeof el.focus === 'function') el.focus(); }
}
function walletSetBusy(on) {
  walletBusy = on;
  const sh = $('wallet-sheet');
  if (sh) sh.querySelectorAll('.wl-body button, .wl-body input').forEach(el => { el.disabled = on; });
}
function walletShowMsg(text, ok) {
  walletMsg = { text, ok: !!ok };
  const sh = $('wallet-sheet');
  let el = sh && sh.querySelector('.wl-msg');
  if (!el && sh) {
    el = wkEl('div', 'sec-msg wl-msg');
    el.setAttribute('role', 'status');
    const first = sh.querySelector('.wl-body .wl-status');
    if (first) first.after(el); else sh.querySelector('.wl-body').prepend(el);
  }
  if (el) { el.textContent = text; el.classList.toggle('ok', !!ok); }
}
async function walletAct(action, id) {
  const sh = $('wallet-sheet');
  const val = (i) => { const el = sh && sh.querySelector('#' + i); return el ? el.value : ''; };
  if (pkRun) return;   // one run at a time: this tap or Enter is ignored
  if (action === 'pkremove') {
    const known = ((walletStatus && walletStatus.keystore && walletStatus.keystore.passkeys) || []).find(p => p.id === id);
    const label = known ? known.label : 'this passkey';
    if (!confirm(`Remove "${label}"? It will stop unlocking this wallet. Copies of the wallet file made before now still accept it, protected by that passkey's own Face ID, fingerprint or screen lock.`)) return;
  }
  const passEl = sh && (action === 'unlock' ? sh.querySelector('#wl-pass') : action === 'pkadd' ? sh.querySelector('#wl-pk-pass') : null);
  const run = pkRunStart(sh && sh.querySelector('#wl-confirm-row'), passEl ? [passEl] : []);
  if (!run) return;
  if (action === 'pkadd') {
    run.timer = setTimeout(() => {
      run.timer = null;
      if (pkRun !== run) return;
      pkCancel();
      const text = 'Setup timed out. Start again.';
      walletShowMsg(text, false); walletLoad({ text, ok: false });
    }, PK_ENROLL_MS);
  }
  let passphrase = '', name = '';
  if (passEl) {
    passphrase = passEl.value; passEl.value = '';   // the passphrase lives only in this request
    if (!passphrase) {
      pkRunEnd(run);
      const text = 'Type the wallet passphrase first.';
      walletShowMsg(text, false); passEl.focus();
      walletLoad({ text, ok: false });   // the run stopped any load in flight: start one again, keeping the message
      return;
    }
  }
  try {
    let done;
    if (action === 'pkremove') { await walletApi('passkey/remove', { id }, run.ctrl.signal); done = 'Removed.'; }
    else if (action === 'pkunlock') { await pkUnlock((p, b) => walletApi(p, b, run.ctrl.signal), run.ctrl.signal); done = 'Unlocked until the hub restarts.'; }
    else if (action === 'unlock') { await walletApi('unlock', { passphrase }, run.ctrl.signal); done = 'Unlocked until the hub restarts.'; }
    else {
      name = (val('wl-pk-label') || '').trim() || pkDeviceLabel();
      const confirmStep = () => new Promise((resolve, reject) => {
        if (run.cancelled || run.ctrl.signal.aborted) return reject(new DOMException('Cancelled.', 'AbortError'));
        const row = run.confirmRow; if (!row) return resolve();
        run.rejectConfirm = reject;
        row.innerHTML = '<div class="sec-hint">One more tap: confirm with this phone.</div><button type="button" class="wl-big" id="wl-confirm-btn">Confirm with Face ID / fingerprint</button>';
        row.querySelector('#wl-confirm-btn').onclick = () => { run.rejectConfirm = null; row.innerHTML = ''; resolve(); };
      });
      await pkAdd((p, b) => walletApi(p, b, run.ctrl.signal), { passphrase, label: name }, confirmStep, run.ctrl.signal);
      done = `Added. ${name} can now unlock the wallet.`;
    }
    passphrase = '';   // the request that needed it has settled
    if (!pkRunEnd(run)) return;   // cancelled: its canceller already cleaned up
    await walletLoad({ text: done, ok: true });
  } catch (e) {
    passphrase = '';
    if (!pkRunEnd(run)) return;
    const text = pkErrorText(e);
    walletShowMsg(text, false);
    walletLoad({ text, ok: false });   // the run stopped any load in flight: start one again, keeping the message
  }
}
// The after-restart notice "Your wallet is locked": on or off; the box goes back when the hub refuses.
async function walletLockedNotice(box) {
  const on = !!box.checked;
  try {
    const r = await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ walletLockedNotice: on }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not save that.');
    if (walletStatus) walletStatus.lockedNotice = on;
  } catch (e) { box.checked = !on; walletShowMsg(pkErrorText(e), false); }
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
  on('for_owner', onForOwner);
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
  // The hands-free call listens to the same stream (each handler ignores everything unless a call is up for that agent).
  on('turn_start', voiceCallTurnStart);
  on('turn_delta', voiceCallTurnDelta);
  on('turn_activity', voiceCallTurnActivity);
  on('turn_end', voiceCallTurnEnd);
  on('turn_mood', voiceCallTurnMood);
  on('ask_user', voiceCallAsk);
  on('ask_user_done', voiceCallAskDone);
  on('voice_held', voiceCallHeld);
  on('voice_held_done', voiceCallHeldDone);
  on('voice_call', voiceCallState);
  on('compaction_start', onCompactionStart);
  on('compaction_progress', onCompactionProgress);
  on('compaction_end', onCompactionEnd);
  on('agent_updated', onAgentUpdated);
  $('chat-model-pick')?.addEventListener('change', changeModelFromPick);
  $('chat-effort-pick')?.addEventListener('change', changeEffortFromPick);
  on('model_fallback', (ev) => toast(`${displayName(ev.agent)}: ${String(ev.from || '').split('/').pop()} at its weekly limit; running on ${String(ev.to || '').split('/').pop()} until ${ev.resetsAt ? new Date(ev.resetsAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'it resets'}`));
  // Plan warnings and refusals (lib/plan-usage): no pop-up over the input; the usage in the chat header updates.
  on('plan_limit', () => refreshPlanUsage());
  on('plan_extra_usage', () => refreshPlanUsage());
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
    // The last saved entry: renderHistory leaves out a running turn's inProgress entry, so does this.
    let last;
    for (let i = chatHistory.length - 1; i >= 0; i--) if (!chatHistory[i].inProgress) { last = chatHistory[i]; break; }
    const dup = typeof ev.message === 'string' && !!last && last.role === 'user' && samePrompt(last.content, ev.message);
    // A turn the hub started by itself draws straight into a closed card (tap it to watch the turn live).
    const info = foldAutoOn() && autoKindOfOrigin(ev.origin) ? autoInfoOf({ role: 'user', origin: ev.origin, content: ev.message || '' }) : null;
    let card = null;
    let retired = false;   // a re-attach of this turn gave way to the card
    if (info) {
      const mem = lastHistoryCard;
      // A re-attach bubble drawn after that card (the chat followed this turn before turn_start came) does not count.
      const ra = reattaches.get(ev.agent);
      const raEl = ra && !ra.text && ra.bubble && (!ra.turnId || ra.turnId === ev.turnId) ? ra.bubble.el : null;
      // Opened while this turn runs: renderHistory already drew a card with its prompt (the reply, still in progress,
      // is not in history). Adopt that card when it is the last thing on screen rather than build a second one.
      if (dup && mem && mem.agent === ev.agent && samePrompt(mem.prompt, ev.message) && promptRecent(mem.ts, ev.startedAt) && cardIsLast(mem.wrap, raEl)) {
        card = { wrap: mem.wrap, body: mem.body, line: mem.line };
        card.line.textContent = 'working…';
      } else {
        card = makeFoldHeader(`auto-card auto-card-${autoCardKind(info.kind)}`, info.label, timeLabel(ev.startedAt), 'working…');
        chatEl().appendChild(card.wrap);
      }
      lastHistoryCard = null;
      // The card now shows this turn live: the waiting bubble of a re-attach would be a second copy of the reply.
      if (raEl) { reasoningEnd(ra); raEl.remove(); reattaches.delete(ev.agent); paintChatStatus(); retired = true; }
    }
    const paint = () => {
      if (typeof ev.message === 'string' && !dup) {
        if (!card) addNote(`⚡ ${ev.origin?.kind === 'user' ? 'sent from another device' : originLabel(ev.origin)} — ${timeLabel()}`);
        setBubbleTime(addUserBubble(ev.message, null), msgTimeLabel(Date.parse(ev.startedAt) || Date.now()));
      }
      return addAssistantBubble('…');
    };
    const b = card ? withRenderTarget(card.body, paint) : paint();
    const t = { turnId: ev.turnId, agent: ev.agent, bubble: b, el: b.el, body: b.body, feed: null, startedAt: ev.startedAt || null, prompt: ev.message, card: card ? { ...card, label: info.label } : null };
    hubTurns[ev.turnId] = t;
    // A for_owner that arrived before this card existed: apply it now.
    if (t.card && forOwnerPending[ev.turnId]) { delete forOwnerPending[ev.turnId]; moveReplyOut(t); }
    if (retired) catchUpOpenAgent();   // what the turn already did (tool rows, text), which the retired bubble had shown
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
  if (ev && ev.item && ev.item.kind === 'worker') wkHubPollSoon();   // any agent's worker: the status feed names it
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

// for_owner { agent, reason, turnId, origin }: the agent marked this reply for the owner. A live automatic turn's reply
// bubble moves out of its closed card to right after it, open, under a "from <card label>" line.
function moveReplyOut(t) {
  if (!t || !t.card || t.card.moved || !t.el.isConnected || !chatOpenFor(t.agent)) return;
  // The card may sit inside a stack (hidden body): the reply goes after the outermost block that is in the chat.
  const panel = chatEl();
  let anchor = t.card.wrap;
  while (anchor.parentNode && anchor.parentNode !== panel) anchor = anchor.parentNode;
  if (!panel || anchor.parentNode !== panel) return;
  // replies already moved out after the same block keep their order: this one goes after them
  while (anchor.nextElementSibling && anchor.nextElementSibling.dataset && anchor.nextElementSibling.dataset.autoMoved === '1') anchor = anchor.nextElementSibling;
  const from = document.createElement('div');
  from.className = 'auto-from';
  from.textContent = `from ${t.card.label}`;
  from.dataset.autoMoved = '1'; t.el.dataset.autoMoved = '1';
  anchor.after(from);
  from.after(t.el);
  t.card.moved = true;
  scrollChat();
}
function onForOwner(ev) {
  if (!ev || !ev.turnId) return;
  const t = hubTurns[ev.turnId];
  if (t) { moveReplyOut(t); return; }
  // The live card is not there yet (a replayed turn_start, or the turn not drawn yet): keep the mark for when it is.
  forOwnerPending[ev.turnId] = { reason: typeof ev.reason === 'string' ? ev.reason : '', at: Date.now() };
  const ids = Object.keys(forOwnerPending);
  for (const id of ids.slice(0, Math.max(0, ids.length - 50))) delete forOwnerPending[id];
}

function onTurnEnd(ev) {
  setLive(ev.agent, { busy: false });
  if (ev.agent) wkSettleAgent(ev.agent, ev.turnId || null);
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
    // The card's line: the reply's first line; a reply that moved out of the card is shown below it, so the prompt's task line instead.
    if (t.card) t.card.line.textContent = t.card.moved ? promptCardLine(ev.message || t.prompt, t.card.label) : (autoFirstLine(reply) || t.card.label);
    setBubbleTime(t.el, msgTimeLine(Date.parse(ev.endedAt) || Date.now(), Date.parse(t.startedAt)));
    rereadHistory(t.agent);   // the finished exchange (its message came from elsewhere), as the hub saved it
    scrollChat();
  } else if (ra) {
    if (ev.reply) finishReattach(ra, ev.reply, true);
    else if (ev.ok === false) finishReattach(ra, `${ra.partial ? ra.partial + '\n\n' : ''}${reply}`, false);
    else reattachCheck(ra);
  } else if (chatOpenFor(ev.agent) && !streams.has(ev.agent) && !ownTurn) {
    setBubbleTime(addAssistantBubble(reply).el, msgTimeLabel(Date.parse(ev.endedAt) || Date.now()));
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
  $('menu-activity')?.addEventListener('click', (e) => { e.preventDefault(); navigate('activity'); });   // a #activity link: one history entry
  $('tab-activity')?.addEventListener('click', () => navigate('activity'));   // a page cached before the move still has the tab
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
  $('menu-reload')?.addEventListener('click', (e) => { e.stopPropagation(); $('menu').classList.remove('open'); reloadApp(); });   // ?.: a phone page cached from before has no menu entry
  $('about-sheet').addEventListener('click', onAboutClick);
  // Esc, Back or a tap outside the approval sheet is Later: hidden until a new request comes, never answered.
  $('approval-sheet').__dialogClose = () => { approvalsHidden = true; paintApprovals(); };
  $('menu-profile')?.addEventListener('click', openProfileSheet);   // ?.: a page cached before Profile existed has no such item
  $('menu-security').addEventListener('click', openSecuritySheet);
  $('menu-files').addEventListener('click', openFilesSheet);
  $('menu-recall').addEventListener('click', openRecallSheet);
  $('menu-voice')?.addEventListener('click', openVoiceSheet);   // ?.: a phone page cached from before has no menu entry
  $('menu-workers').addEventListener('click', () => openWorkerSheet('history'));
  $('menu-wallet')?.addEventListener('click', openWalletSheet);   // ?.: a phone page cached from before has no menu entry
  $('menu-memory')?.addEventListener('click', openMemorySheet);   // a phone page cached from before this line has no menu entry
  $('chat-workers-btn').addEventListener('click', () => openWorkerSheet('list'));
  $('menu-compact').addEventListener('click', compressNow);
  $('files-upload-input').addEventListener('change', (e) => { filesUpload(e.target.files); e.target.value = ''; });
  $('menu-signout').addEventListener('click', signOut);
  $('chat-stop-btn')?.addEventListener('click', stopRemoteTurn);
  $('chat-resync')?.addEventListener('click', resyncClick);
  document.addEventListener('click', () => $('menu').classList.remove('open'));
  $('menu-clear').addEventListener('click', confirmClear);
  $('menu-copy').addEventListener('click', copyWholeChat);
  $('menu-fold')?.addEventListener('click', toggleFoldAuto);
  paintFoldMenu();
  $('menu-active-top')?.addEventListener('click', toggleActiveTop);
  paintActiveMenu();
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
  for (const ev of ['focus', 'input']) input.addEventListener(ev, composerPaintAll);
  input.addEventListener('blur', () => setTimeout(composerPaintAll, 300));   // a tap on a call-panel button lands before the panel grows back
  const vvPaint = window.visualViewport;
  if (vvPaint) vvPaint.addEventListener('resize', callPanelCompactPaint);
  window.addEventListener('resize', callPanelCompactPaint);
  composerPaintAll();
  // Chrome's spell-check menu (a tap on an underlined word, Backspace with the menu open) hides the soft keyboard
  // while the box keeps focus, and Android only reopens it on a new focus. So a keyboard that goes away right after
  // a tap on the box or an edit in it, with the box still focused, is brought back by blurring and refocusing the box.
  const vv = window.visualViewport;
  const viewSize = () => (vv ? { w: vv.width, h: vv.height } : { w: window.innerWidth, h: window.innerHeight });
  keepKeyboard = createKeepKeyboard({ viewport: viewSize, reopen: () => setTimeout(() => { if (document.hidden || document.activeElement !== input) return; const s = input.selectionStart, e = input.selectionEnd, d = input.selectionDirection; input.blur(); input.focus({ preventScroll: true }); try { input.setSelectionRange(s, e, d || 'none'); } catch { /* no selection */ } }, 0) });
  input.addEventListener('pointerdown', () => keepKeyboard.touch(current));
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') keepKeyboard.escape(); else keepKeyboard.touch(current, 'edit'); });
  input.addEventListener('beforeinput', () => keepKeyboard.touch(current, 'edit'));
  input.addEventListener('input', () => keepKeyboard.touch(current, 'edit'));
  document.addEventListener('pointerdown', (e) => { if (e.target !== input && !(input.contains && input.contains(e.target))) keepKeyboard.elsewhere(); }, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) keepKeyboard.hidden(); });
  const onView = () => keepKeyboard.resized({ chat: current, focused: document.activeElement === input, hidden: document.hidden, dialogOpen: !!document.querySelector('dialog[open], .rsn-sheet.open, [role="dialog"].open') });
  if (vv) vv.addEventListener('resize', onView); else window.addEventListener('resize', onView);
  // Send, and the 🔔 beside it, act on the touch itself (onComposerTap). Once a send has taken the text,
  // sendAndClose lets go of the box so the keyboard goes away.
  onComposerTap($('send-btn'), sendAndClose);
  onComposerTap($('chat-notify-btn'), toggleNotifyDone);
  // The mic acts on the touch itself too (the box keeps its state, no keyboard opens). Its status is polled every 60 s while the page is visible.
  if ($('mic-btn')) onComposerTap($('mic-btn'), voiceMicTap);
  voiceCallWire();
  setInterval(() => { if (!document.hidden && current) voiceStatusRefresh(); }, 60000);

  plusSheetWire();
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

// ── Multi-user: owner switcher, account menu, Profile and Security sheets ──────

async function loadMe() {
  try {
    const r = await api('/api/me');
    if (r.ok) hubMe = await r.json();
  } catch {}
  return hubMe;
}

// The time zone this person's agents use follows the device they are using (lib/timezone). The app reports the
// phone's zone on the first tap or key after it opens or comes back into view, then at most every 10 minutes while in
// use, so an app that reloads by itself doesn't move it. The hub ignores the reports while a zone is pinned (desktop:
// Security).
const TZ_REPORT_EVERY_MS = 10 * 60 * 1000;
let tzReportedAt = 0;
let tzChoice = 0;   // counts choices in the Profile sheet: an older report's late answer must not undo one
let tzSaving = false;   // a choice is being saved: the list stays disabled, also in a Profile closed and opened again
function deviceTimeZone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } }
function reportTimeZone() {
  const tz = deviceTimeZone();
  if (!tz || !hubMe || !hubMe.user || document.visibilityState !== 'visible') return;
  if (Date.now() - tzReportedAt < TZ_REPORT_EVERY_MS) return;
  tzReportedAt = Date.now();
  const choice = tzChoice;
  api('/api/me/timezone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tz, auto: true }) })
    .then(r => { if (r.status >= 500) throw new Error(`HTTP ${r.status}`); return r.ok ? r.json() : null; })   // a hub error: try again at the next tap
    .then(d => { if (d && d.user && hubMe && choice === tzChoice) { hubMe.user = { ...hubMe.user, ...d.user }; hubMe.timeZone = d.timeZone; } })
    .catch(() => { tzReportedAt = 0; });
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tzReportedAt = 0; });
// A chat request carries the phone's zone only when it carries a message the person just sent (sendMessage sets
// tzSentAt; one request per send, within a minute), never a re-send the app makes by itself.
let tzSentAt = 0;
function zoneHeader() {
  const tz = deviceTimeZone();
  if (!tz || !tzSentAt || Date.now() - tzSentAt > 60 * 1000) return {};
  tzSentAt = 0;
  return { 'X-Hub-Time-Zone': tz };
}
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, reportTimeZone, { capture: true, passive: true });

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
  refreshMemoryHealth();
  if (hubMe) {
    $('menu-users').hidden = !hubMe.isAdmin;
    if ($('menu-connectors')) $('menu-connectors').hidden = !hubMe.isAdmin;   // admins only; a page cached from before has no such item
    if ($('menu-wallet')) $('menu-wallet').hidden = !hubMe.isAdmin;   // admins only
    if ($('menu-profile')) $('menu-profile').hidden = !hubMe.user;
    $('menu-2fa-note').hidden = !(hubMe.isAdmin && !hubMe.user.totpEnabled && hubMe.admin2faRequired !== false);
    $('menu-signout').textContent = `Sign out (${hubMe.user.name || hubMe.user.login})`;
  }
}

// Reload app (menu): fetch the page's own files fresh, ask the service worker to look for a new version, then reload.
// The open chat is in the address (#chat=), its draft is saved first, and a reply still streaming is followed again by
// openChat's own re-attach. The service worker is never unregistered; push and settings are not touched.
function paintReloadBusy(b) {
  const el = $('menu-reload');
  if (el) { el.disabled = !!b; el.setAttribute('aria-busy', b ? 'true' : 'false'); }
  if (b) toast('Reloading…');
}
let appReloaderInst = null;
function reloadApp() {
  if (!appReloaderInst) {
    appReloaderInst = createAppReloader({
      questions: () => (voiceCall ? [APP_RELOAD_CALL_QUESTION] : []),   // offline is fine here: the service worker keeps /mobile
      confirm: (q) => window.confirm(q),
      prepare: () => appFreshFetch({
        urls: appReloadUrls(document, location.origin),
        fetch: (u, o) => fetch(u, o),
        swUpdate: () => ('serviceWorker' in navigator ? navigator.serviceWorker.getRegistration('/mobile').then(r => r && r.update()) : null),
      }),
      // the draft as it is now, right before the reload (typing goes on while the files are fetched)
      go: () => { if (current && $('msg-input')) saveDraft(current, $('msg-input').value); location.reload(); },
      onBusy: paintReloadBusy,
    });
  }
  return appReloaderInst.reload();
}

function toggleMenu(e) {
  e.stopPropagation();
  const menu = $('menu');
  menu.classList.toggle('no-chat', !$('screen-chat').classList.contains('active'));
  menu.classList.toggle('open');
  if (menu.classList.contains('open')) paintMenuCredit();
  if (menu.classList.contains('open')) paintVersionLabel();
  if (menu.classList.contains('open')) refreshMemoryHealth();
}

// Memory (lib/memory-health): admins see the agents the last check flagged; the menu line shows only when there are
// some. Read-only here: Settings → Status → Memory on a computer has the details.
let mhLast = null;
async function refreshMemoryHealth() {
  const item = $('menu-memory');
  if (!item) return;
  if (!(hubMe && hubMe.isAdmin)) { item.hidden = true; return; }
  try {
    const r = await api('/api/memory-health?stored=1');
    if (!r.ok) return;
    const d = await r.json();
    mhLast = d;
    const n = (Array.isArray(d.agents) ? d.agents : []).filter(a => a.status !== 'green').length;
    item.hidden = !n;
    const c = $('menu-memory-count');
    c.textContent = n ? String(n) : '';
    c.classList.toggle('on', !!n);
  } catch {}
  paintMemorySheet();
}
function memorySheet() {
  let sh = $('mh-sheet');
  if (sh) return sh;
  sh = document.createElement('div');
  sh.id = 'mh-sheet';
  sh.className = 'rsn-sheet mh-sheet';
  sh.setAttribute('role', 'dialog');
  sh.setAttribute('aria-modal', 'true');
  sh.setAttribute('aria-label', 'Memory');
  sh.dataset.noDirty = '';
  sh.innerHTML = '<div class="rsn-sheet-head"><span class="rsn-sheet-title">Memory</span><span class="rsn-sheet-count"></span>' +
    '<button type="button" class="rsn-sheet-close" aria-label="Close">&#x2715;</button></div><div class="mh-body" tabindex="-1"></div>';
  const close = () => { sh.classList.remove('open'); dialogGuard.closed(sh); };
  sh.querySelector('.rsn-sheet-close').addEventListener('click', close);
  sh.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } });
  sh.closeSheet = close;
  document.body.appendChild(sh);
  return sh;
}
function openMemorySheet() {
  $('menu').classList.remove('open');
  const sh = memorySheet();
  if (!sh.classList.contains('open')) { sh.classList.add('open'); dialogGuard.open(sh, { close: sh.closeSheet }); }
  paintMemorySheet();
  refreshMemoryHealth();
}
function paintMemorySheet() {
  const sh = $('mh-sheet');
  if (!sh || !sh.classList.contains('open')) return;
  const d = mhLast || {};
  const flagged = (Array.isArray(d.agents) ? d.agents : []).filter(a => a.status !== 'green');
  sh.querySelector('.rsn-sheet-count').textContent = d.checkedAt ? `checked ${new Date(d.checkedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : '';
  const body = sh.querySelector('.mh-body');
  const scroll = body.scrollTop;
  body.textContent = '';
  for (const a of flagged) {
    const row = wkEl('div', 'mh-row');
    const head = wkEl('div', 'mh-head');
    head.append(wkEl('span', `mh-dot mh-${a.status === 'red' ? 'red' : 'amber'}`), wkEl('b', null, a.display || a.agent));
    row.appendChild(head);
    for (const i of (a.items || []).filter(x => x.status !== 'green')) {
      const it = wkEl('div', 'mh-item');
      it.append(wkEl('span', `mh-t mh-t-${i.status === 'red' ? 'red' : 'amber'}`, i.title), document.createTextNode(` ${i.detail || ''}`));
      row.appendChild(it);
    }
    body.appendChild(row);
  }
  if (!flagged.length) body.appendChild(wkEl('div', 'mh-item', d.checkedAt ? 'Every agent is fine.' : 'Not checked yet.'));
  body.appendChild(wkEl('div', 'mh-foot', 'The details are under Settings → Status → Memory on a computer.'));
  body.scrollTop = scroll;
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

// Profile: who you are here (your name and sign-in, set by an admin on the Users page) and the time zone your agents
// use. Security keeps password, two-factor and sessions.
function openProfileSheet() {
  $('menu').classList.remove('open');
  if (!hubMe || !hubMe.user) return;
  const sheet = $('profile-sheet');
  sheet.innerHTML = `
    <h3>Profile</h3>
    <div class="sec-section">
      <div class="sec-title" id="prof-name"></div>
      <div class="sec-hint" id="prof-login"></div>
    </div>
    <div class="sec-section">
      <div class="sec-title">Time zone</div>
      <div class="sec-hint" id="prof-tz-hint"></div>
      <select id="prof-tz" aria-label="Time zone your agents use"></select>
      <div class="sec-msg" id="prof-tz-msg"></div>
    </div>
    <div class="sec-actions" style="margin-top:10px"><button id="prof-close">Close</button></div>`;
  $('prof-name').textContent = hubMe.user.name || hubMe.user.login;
  $('prof-login').textContent = `Signed in as ${hubMe.user.login} · ${hubMe.user.role === 'admin' ? 'admin' : 'member'}`;
  $('prof-tz').addEventListener('change', (e) => chooseTimeZone(e.target));
  $('prof-close').addEventListener('click', () => dialogRequestClose(sheet));
  paintTimeZone();
  if (!sheet.open) sheet.showModal();
}
// Which zone the agents use for "now" and every time they show: the phone's (it follows you), or one pinned here.
function paintTimeZone() {
  const sel = $('prof-tz'), hint = $('prof-tz-hint');
  if (!sel || !hint || !hubMe || !hubMe.user) return;
  const device = deviceTimeZone();
  const pinned = !!hubMe.user.timeZonePinned;
  const zone = hubMe.timeZone || hubMe.user.timeZone || device || 'UTC';
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = []; }
  if (!zones.includes(zone)) zones.unshift(zone);
  let now = '';
  try { now = new Date().toLocaleTimeString([], { timeZone: zone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); } catch { now = ''; }
  sel.innerHTML = `<option value="">Follow this phone${device ? ` (${esc(device.replace(/_/g, ' '))})` : ''}</option>`
    + zones.map(z => `<option value="${esc(z)}">${esc(z.replace(/_/g, ' '))}</option>`).join('');
  sel.value = pinned ? zone : '';
  sel.disabled = tzSaving;
  hint.textContent = `Your agents use ${zone.replace(/_/g, ' ')}${now ? ` (now ${now})` : ''}${pinned ? ', pinned wherever you are.' : ', following the device you use.'}`;
  try { dialogGuard.markLoaded(sel); } catch { /* no guard */ }
}
async function chooseTimeZone(sel) {
  if (tzSaving) { paintTimeZone(); return; }   // one choice at a time: a second one waits until this is saved
  const tz = sel.value;
  tzChoice++;
  tzSaving = true;
  sel.disabled = true;
  const body = tz ? { tz, pinned: true } : { tz: deviceTimeZone() || null, pinned: false };
  let error = '';
  try {
    const r = await api('/api/me/timezone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    hubMe.user = { ...hubMe.user, ...d.user };
    hubMe.timeZone = d.timeZone;
  } catch (e) { error = e.message || 'failed'; }
  tzSaving = false;
  paintTimeZone();
  secMsg('prof-tz-msg', error ? `Not saved: ${error}` : 'Saved.', !error);
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
    const adminLocked = hubMe.isAdmin && hubMe.admin2faRequired !== false;
    const adminFree = hubMe.isAdmin && !adminLocked;
    box.innerHTML = `
      <div class="sec-title">Two-factor authentication: on</div>
      ${adminLocked ? `<div class="sec-hint">Two-factor sign-in is on. Admins can't remove it while "Require two-factor sign-in for admins" is on in Settings, Security on a computer.</div>` : `
      <input type="password" id="sec-2fa-password" placeholder="Password (to turn it off)" autocomplete="current-password">
      ${adminFree ? '<input type="text" id="sec-2fa-disable-code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456 or a recovery code">' : ''}
      <div class="sec-actions"><button id="sec-2fa-disable" class="danger">${adminFree ? 'Remove two-factor' : 'Disable 2FA'}</button></div>`}
      <div class="sec-msg" id="sec-2fa-msg"></div>`;
    if (!adminLocked) $('sec-2fa-disable').addEventListener('click', disableTwoFactor);
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
  if (hubMe) $('menu-2fa-note').hidden = !(hubMe.isAdmin && !hubMe.user.totpEnabled && hubMe.admin2faRequired !== false);
}

async function copyRecoveryCodes() {
  const text = $('sec-recovery').textContent;
  try { await navigator.clipboard.writeText(text); toast('Recovery codes copied'); }
  catch { toast('Copy failed: select the codes and copy by hand'); }
}

let secDisableBusy = false;   // one removal at a time
async function disableTwoFactor() {
  if (secDisableBusy) return;
  const pwEl = $('sec-2fa-password');
  const codeEl = $('sec-2fa-disable-code');
  const password = pwEl.value;
  if (!password) return secMsg('sec-2fa-msg', 'Enter your password to turn 2FA off.');
  const body = { password };
  if (codeEl) {
    body.code = (codeEl.value || '').trim();
    if (!body.code) return secMsg('sec-2fa-msg', 'Enter a current code or a recovery code.');
  }
  pwEl.value = ''; if (codeEl) codeEl.value = '';   // the password goes in this one request and stays nowhere else
  secDisableBusy = true;
  try {
    await authPost('/api/auth/totp/disable', body);
    hubMe.user.totpEnabled = false;
    await loadMe();
    applyMultiUserNote();
    paintTwoFactor();
  } catch (e) { secMsg('sec-2fa-msg', e.message); }
  finally { secDisableBusy = false; }
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
  activeJobsSync();
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
  // The "wallet is locked" notice's tap (/mobile?wallet=unlock) opens the Wallet sheet once and is then dropped from the
  // address. The passkey prompt needs a tap of its own, so only the sheet opens here.
  if (new URLSearchParams(location.search).get('wallet') === 'unlock') {
    const u = new URL(location.href); u.searchParams.delete('wallet');
    window.history.replaceState(window.history.state, '', u.pathname + u.search + u.hash);
    openWalletSheet();
  }
  paintVersionLabel();
  setInterval(refreshUpdateCheck, 30 * 60 * 1000);
}

init();
