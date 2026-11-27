'use strict';
// The quick switcher (app.js): ⌘K on a Mac, Ctrl+K elsewhere, opens a search over the agents, like Slack's "Jump to…".
// The tests run the page's real functions (taken out of app.js) with the real dialog layer (lib/ui-dialog.js, which
// app.js carries verbatim) on a small fake DOM: they open the switcher, type, press keys and close it, and check where
// the focus and the caret end up.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ui = require('../lib/ui-dialog');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const fn = (name) => {
  const m = app.match(new RegExp(`\\n    (?:async )?function ${name}\\(.*\\) \\{\\n[\\s\\S]*?\\n    \\}\\n`));
  assert.ok(m, `app.js has function ${name}`);
  return m[0];
};
const one = (name) => {   // a one-line function
  const m = app.match(new RegExp(`\\n    function ${name}\\(.*\\) \\{[^\\n]*\\}\\n`));
  assert.ok(m, `app.js has function ${name}`);
  return m[0];
};

function storage(init = {}) {
  const s = { ...init };
  return {
    getItem: (k) => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); }, removeItem: (k) => { delete s[k]; },
    key: (i) => Object.keys(s)[i] ?? null, get length() { return Object.keys(s).length; }, _s: s,
  };
}
const A = (name, display, extra = {}) => ({ name, display, ...extra });
const names = (list) => [...list].map(a => a.name);

// ── Ranking and recents: the pure functions ──
function tab(extra = {}) {   // one browser tab: its own sessionStorage, the origin's localStorage (shared across tabs)
  const c = { localStorage: storage(), window: { hubMe: { user: { id: 'u1' } }, sessionStorage: storage() }, ...extra };
  vm.runInNewContext(
    [fn('qsRecentStore'), one('qsRecentBox'), fn('qsRecent'), fn('qsNoteOpened'), fn('qsRecentKeys'), fn('qsForgetRecents'), fn('qsScore'), fn('qsRank')].join('')
    + '\nthis.qsRecent = qsRecent; this.qsNoteOpened = qsNoteOpened; this.qsForgetRecents = qsForgetRecents; this.qsRecentStore = qsRecentStore; this.qsScore = qsScore; this.qsRank = qsRank;', c);
  return c;
}
const ctx = tab;
const loadCleanup = () => { const m = app.match(/\n    try \{ for \(const k of qsRecentKeys\(localStorage\)\) localStorage\.removeItem\(k\); \}[^\n]*\n/); assert.ok(m, 'app.js empties localStorage of recents on load'); return m[0]; };

test('an empty search: unread first, then the agents opened last, then the rest by name', () => {
  const c = ctx();
  const agents = [A('scout', 'Scout'), A('aide', 'Aide'), A('forge', 'Forge'), A('agent-lead', 'Compass'), A('beacon', 'Beacon')];
  const out = c.qsRank(agents, '', { recent: ['forge', 'agent-lead'], unread: new Set(['scout']) });
  assert.deepStrictEqual(names(out), ['scout', 'forge', 'agent-lead', 'aide', 'beacon']);
});

test('typing: a name that starts with it, then a word that does, then anywhere, then the letters in order; no match is left out', () => {
  const c = ctx();
  const agents = [A('researcher', 'Researcher'), A('aide', 'Aide'), A('opportunity', 'Opportunity'), A('agent-lead', 'Compass'), A('code-reviewer', 'Code Reviewer'), A('beacon', 'Beacon')];
  assert.deepStrictEqual(names(c.qsRank(agents, 're', {})), ['researcher', 'code-reviewer']);
  assert.deepStrictEqual(names(c.qsRank(agents, 'com', {})), ['agent-lead']);
  assert.deepStrictEqual(names(c.qsRank(agents, 'lead', {})), ['agent-lead']);
  assert.deepStrictEqual(names(c.qsRank(agents, 'con', {})), ['beacon']);
  assert.deepStrictEqual(names(c.qsRank(agents, 'opy', {})), ['opportunity']);
  assert.deepStrictEqual(names(c.qsRank(agents, 'zzz', {})), []);
  assert.deepStrictEqual(names(c.qsRank(agents, '  AIDE ', {})), ['aide'], 'case and spaces around it do not matter');
});

test('among equal matches the recent one comes first, and unread does not reorder typed results', () => {
  const c = ctx();
  const agents = [A('scout', 'Scout'), A('scribe', 'Scribe'), A('sage', 'Sage')];
  assert.deepStrictEqual(names(c.qsRank(agents, 's', { recent: ['scribe'], unread: new Set(['sage']) })), ['scribe', 'sage', 'scout']);
});

test('recents live in the tab (sessionStorage), per person: nothing in localStorage, none before /api/me, others dropped, all gone on sign-out', () => {
  const c = tab();
  const ss = c.window.sessionStorage, ls = c.localStorage;
  c.qsNoteOpened('aide'); c.qsNoteOpened('forge'); c.qsNoteOpened('aide');
  assert.deepStrictEqual([...c.qsRecent()], ['aide', 'forge']);
  assert.deepStrictEqual(Object.keys(ss._s), ['hub-qs-recent:u1']);
  assert.deepStrictEqual(Object.keys(ls._s), [], 'nothing written to localStorage');
  for (let i = 0; i < 40; i++) c.qsNoteOpened(`a${i}`);
  assert.strictEqual(c.qsRecent().length, 30);
  c.window.hubMe = { user: { id: 'u2' } };
  assert.deepStrictEqual([...c.qsRecent()], [], 'u2 never sees u1\'s list');
  c.qsNoteOpened('scout');
  ls.setItem('hub-qs-recent', '["legacy"]'); ls.setItem('hub-qs-recent:u1', '["legacy-owner"]'); ls.setItem('other-key', 'x');
  c.qsForgetRecents(c.qsRecentStore().key);   // what the page does when /api/me answers
  assert.deepStrictEqual(Object.keys(ss._s), ['hub-qs-recent:u2']);
  assert.deepStrictEqual(Object.keys(ls._s), ['other-key'], 'every recents key an earlier build left in localStorage is gone');
  c.qsForgetRecents(null);                    // sign-out
  assert.deepStrictEqual(Object.keys(ss._s), []);
  c.window.hubMe = null;
  c.qsNoteOpened('aide');
  assert.deepStrictEqual(Object.keys(ss._s), [], 'nothing stored before the hub says who is signed in');
});

test('a stale tab can no longer leave recents another account\'s tab could read', () => {
  const shared = storage({ 'hub-qs-recent:owner': '["old-build"]' });   // origin storage, shared by every tab
  const owner = tab({ localStorage: shared, window: { hubMe: { user: { id: 'owner' } }, sessionStorage: storage() } });
  const member = tab({ localStorage: shared, window: { hubMe: { user: { id: 'member' } }, sessionStorage: storage() } });
  vm.runInNewContext(loadCleanup(), owner);   // the owner's page loads: localStorage emptied of recents
  owner.qsNoteOpened('private-agent');
  member.qsForgetRecents(member.qsRecentStore().key);   // another tab signs out and in as the member
  owner.qsNoteOpened('private-agent-2');                 // the stale owner tab picks another chat
  assert.deepStrictEqual(Object.keys(shared._s), [], 'nothing in the storage both tabs share');
  assert.deepStrictEqual(Object.keys(member.window.sessionStorage._s), [], 'the member\'s tab holds no owner list');
  assert.deepStrictEqual([...member.qsRecent()], []);
});

test('recents are tidied when /api/me answers and cleared on sign-out (page wiring)', () => {
  assert.match(fn('loadMe'), /window\.hubMe = await r\.json\(\);[^\n]*\n[^\n]*hubSimple\.apply[^\n]*\n\s*try \{ qsForgetRecents\(qsRecentStore\(\)\.key\); \}/);
  // The recents are forgotten before the logout request; other sign-out clean-ups (the cached theme, from dev) may sit between them.
  assert.match(fn('signOut'), /^\s*async function signOut\(\) \{\s*\n\s*try \{ qsForgetRecents\(null\); \}[^\n]*\n(?:\s*try \{[^\n]*\n)*?\s*try \{ await fetch\('\/api\/auth\/logout'/m);
  assert.match(fn('switchToChat'), /if \(opened && !opened\.isGroup && !opened\.isWorker && !opened\.isHistory && opened\.agent\) qsNoteOpened\(opened\.agent\);/);
  assert.ok(loadCleanup());
  assert.doesNotMatch(app, /localStorage\.setItem\([^)]*qs-recent/, 'no recents write to localStorage anywhere');
});

test('a Mac is recognised however the browser names it ("macOS" in Chrome, "MacIntel", the user agent)', () => {
  const c = {};
  vm.runInNewContext(one('qsIsMac') + '\nthis.isMac = qsIsMac;', c);
  assert.strictEqual(c.isMac({ userAgentData: { platform: 'macOS' }, platform: 'MacIntel' }), true);
  assert.strictEqual(c.isMac({ platform: 'MacIntel' }), true);
  assert.strictEqual(c.isMac({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }), true);
  assert.strictEqual(c.isMac({ userAgentData: { platform: 'Windows' }, platform: 'Win32' }), false);
  assert.strictEqual(c.isMac({ platform: 'Linux x86_64' }), false);
  assert.strictEqual(c.isMac(undefined), false);
});

// The dialog layer discovers overlays with a MutationObserver (records delivered after the current task, as in a
// browser). This one watches the fake DOM below; the layer finds it as the global MutationObserver.
class FakeMutationObserver {
  constructor(cb) { this.cb = cb; this.queue = []; this.target = null; FakeMutationObserver.all.push(this); }
  observe(target) { this.target = target; }
  disconnect() { this.target = null; }
  static record(node, rec) {
    for (const mo of FakeMutationObserver.all) {
      if (!mo.target || !mo.target.contains(node)) continue;
      mo.queue.push(rec);
      if (!mo.scheduled) { mo.scheduled = true; queueMicrotask(() => { mo.scheduled = false; const r = mo.queue; mo.queue = []; mo.cb(r); }); }
    }
  }
}
FakeMutationObserver.all = [];
globalThis.MutationObserver = FakeMutationObserver;
const tick = () => new Promise(r => setTimeout(r, 0));

// ── A small DOM: elements, text, a little markup (for the dialog layer's own question), focus with focusin, the
// active element falling back to <body> when it is removed, events with capture and bubble, <dialog> showModal. ──
function makeDom() {
  const doc = { listeners: { capture: {}, bubble: {} }, activeElement: null, modal: null };
  const kebab = (k) => String(k).replace(/[A-Z]/g, c => '-' + c.toLowerCase());
  class Text { constructor(t) { this.nodeType = 3; this.data = String(t); this.parent = null; } get textContent() { return this.data; } remove() { if (this.parent) this.parent.childNodes = this.parent.childNodes.filter(x => x !== this); this.parent = null; } }
  class El {
    constructor(tag) {
      this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this.children = []; this.childNodes = []; this.parent = null;
      this.attrs = {}; this.listeners = {}; this.cls = new Set(); this.value = ''; this.selectionStart = 0; this.selectionEnd = 0; this.open = false; this.style = { setProperty: (k, v) => { this.style[k] = v; }, removeProperty: (k) => { delete this.style[k]; } };
      const self = this;
      this.classList = {
        contains: (c) => self.cls.has(c), add: (c) => { self.cls.add(c); }, remove: (c) => { self.cls.delete(c); },
        toggle: (c, on) => { const v = on === undefined ? !self.cls.has(c) : !!on; if (v) self.cls.add(c); else self.cls.delete(c); return v; },
      };
      this.dataset = new Proxy({}, { get: (_, k) => self.attrs['data-' + kebab(k)], set: (_, k, v) => { self.attrs['data-' + kebab(k)] = String(v); return true; } });
    }
    get className() { return [...this.cls].join(' '); } set className(v) { this.cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get id() { return this.attrs.id || ''; } set id(v) { this.attrs.id = String(v); }
    get type() { return this.attrs.type || (this.tagName === 'INPUT' ? 'text' : ''); } set type(v) { this.attrs.type = String(v); }
    get name() { return this.attrs.name || ''; }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'open') FakeMutationObserver.record(this, { type: 'attributes', target: this, attributeName: k }); }
    get parentElement() { return this.parent; }
    get parentNode() { return this.parent; }
    get hidden() { return 'hidden' in this.attrs; } set hidden(v) { if (v) this.attrs.hidden = ''; else delete this.attrs.hidden; }
    get firstChild() { return this.childNodes[0] || null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
    insertBefore(n, ref) {
      if (!ref) return this.appendChild(n);
      if (n.parent) n.remove();
      n.parent = this; this.childNodes.splice(this.childNodes.indexOf(ref), 0, n);
      if (n.nodeType === 1) { this.children.splice(this.children.indexOf(ref) < 0 ? this.children.length : this.children.indexOf(ref), 0, n); FakeMutationObserver.record(n, { type: 'childList', addedNodes: [n], removedNodes: [] }); }
      return n;
    }
    removeChild(n) { if (n.parent === this) n.remove(); return n; }
    // What a browser would lay out: nothing for [hidden] or display:none on it or above it, nor for the one stylesheet rule
    // these tests rely on (.rsn-full-overlay is display:none until .open, as in index.html).
    getClientRects() { for (let n = this; n && n.nodeType === 1; n = n.parent) { if (n.hidden || n.style.display === 'none' || (n.cls.has('rsn-full-overlay') && !n.cls.has('open'))) return []; } return this.isConnected ? [1] : []; }
    removeAttribute(k) { delete this.attrs[k]; } hasAttribute(k) { return k in this.attrs; }
    appendChild(n) { if (n.parent) n.remove(); n.parent = this; this.childNodes.push(n); if (n.nodeType === 1) { this.children.push(n); FakeMutationObserver.record(n, { type: 'childList', addedNodes: [n], removedNodes: [] }); } return n; }
    remove() {
      const p = this.parent; if (!p) return;
      FakeMutationObserver.record(p, { type: 'childList', addedNodes: [], removedNodes: [this] });
      p.childNodes = p.childNodes.filter(x => x !== this); p.children = p.children.filter(x => x !== this); this.parent = null;
      if (doc.activeElement && this.contains(doc.activeElement)) doc.activeElement = doc.body;   // as browsers do
      if (doc.modal && this.contains(doc.modal)) doc.modal = null;
    }
    contains(n) { while (n) { if (n === this) return true; n = n.parent; } return false; }
    get isConnected() { return doc.body.contains(this) || doc.head.contains(this); }
    get firstElementChild() { return this.children[0] || null; }
    get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
    set textContent(v) { for (const c of this.childNodes) c.parent = null; this.childNodes = []; this.children = []; if (v !== '' && v != null) this.appendChild(new Text(v)); }
    set innerHTML(html) {   // just enough markup: nested tags with id / class / type attributes, no text
      this.textContent = '';
      const stack = [this];
      for (const m of String(html).matchAll(/<(\/?)([a-z0-9]+)([^>]*)>/gi)) {
        if (m[1]) { stack.pop(); continue; }
        const e = new El(m[2]);
        for (const a of m[3].matchAll(/([\w-]+)="([^"]*)"/g)) { if (a[1] === 'class') e.className = a[2]; else e.setAttribute(a[1], a[2]); }
        stack[stack.length - 1].appendChild(e); stack.push(e);
      }
    }
    *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
    matchOne(sel) {
      sel = sel.trim(); if (sel === ':modal') return this === doc.modal;
      const parts = sel.match(/[.#][\w-]+|\[[^\]]+\]|[a-z][\w-]*/gi) || [];
      return parts.every(p => {
        if (p[0] === '#') return this.id === p.slice(1);
        if (p[0] === '.') return this.cls.has(p.slice(1));
        if (p[0] === '[') { const a = p.slice(1, -1).match(/^([\w-]+)(?:="([^"]*)")?$/); return a[1] in this.attrs && (a[2] === undefined || this.attrs[a[1]] === a[2]); }
        return this.tagName === p.toUpperCase();
      });
    }
    matches(sel) {
      return sel.split(',').some(s => {
        const parts = s.trim().split(/\s+/);
        if (!this.matchOne(parts.pop())) return false;
        let n = this.parent;
        for (let i = parts.length - 1; i >= 0; i--) { while (n && n.nodeType === 1 && !n.matchOne(parts[i])) n = n.parent; if (!n || n.nodeType !== 1) return false; n = n.parent; }
        return true;
      });
    }
    querySelectorAll(sel) { return [...this.walk()].filter(e => e.matches(sel)); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    closest(sel) { let n = this; while (n && n.nodeType === 1) { if (n.matches(sel)) return n; n = n.parent; } return null; }
    addEventListener(t, f, cap) { (this.listeners[t] = this.listeners[t] || []).push({ f, cap: cap === true || !!(cap && cap.capture) }); }
    removeEventListener() {}
    focus() { if (doc.activeElement === this) return; doc.activeElement = this; dispatch(this, 'focusin'); }
    getBoundingClientRect() { return { left: 0, right: 0, top: 0, bottom: 0 }; }
    scrollIntoView() {}
    showModal() { this.open = true; doc.modal = this; this.setAttribute('open', ''); }
    close() { this.open = false; if (doc.modal === this) doc.modal = null; this.removeAttribute('open'); FakeMutationObserver.record(this, { type: 'attributes', target: this, attributeName: 'open' }); }
  }
  function dispatch(target, type, props = {}) {
    const e = {
      type, target, key: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, keyCode: 0, defaultPrevented: false,
      ...props, stopped: false, immediate: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; this.immediate = true; },
    };
    const path = []; for (let n = target; n; n = n.parent) path.unshift(n);
    const run = (list, phase) => { for (const l of (list || []).slice()) { if (phase === 'capture' && !l.cap) continue; if (phase === 'bubble' && l.cap) continue; l.f(e); if (e.immediate) return; } };
    run(doc.listeners.capture[type], 'all'); if (e.stopped) return e;
    for (const n of path.slice(0, -1)) { run(n.listeners[type], 'capture'); if (e.stopped) return e; }
    run(target.listeners[type], 'all'); if (e.stopped) return e;
    for (const n of path.slice(0, -1).reverse()) { run(n.listeners[type], 'bubble'); if (e.stopped) return e; }
    run(doc.listeners.bubble[type], 'all');
    return e;
  }
  doc.body = new El('body'); doc.head = new El('head');
  doc.createElement = (t) => new El(t);
  doc.createTextNode = (t) => new Text(t);
  doc.getElementById = (id) => [doc.body, doc.head].flatMap(r => [...r.walk()]).find(e => e.id === id) || null;
  doc.querySelectorAll = (sel) => [...doc.body.walk()].filter(e => e.matches(sel));
  doc.querySelector = (sel) => (sel === ':modal' ? doc.modal : doc.querySelectorAll(sel)[0] || null);
  doc.removeEventListener = (t, f) => { for (const ph of ['capture', 'bubble']) if (doc.listeners[ph][t]) doc.listeners[ph][t] = doc.listeners[ph][t].filter(l => l.f !== f); };
  doc.addEventListener = (t, f, cap) => { const ph = cap === true || (cap && cap.capture) ? 'capture' : 'bubble'; (doc.listeners[ph][t] = doc.listeners[ph][t] || []).push({ f, cap: ph === 'capture' }); };
  doc.activeElement = doc.body;
  return { doc, El, dispatch };
}

// The page: a message draft, the dialog layer with app.js's own overlay list and automatic discovery, the switcher's
// real functions, the real open paths of Simple Settings and the expanded Reasoning and Tool calls views, the Workers
// menu's real Escape listener, and loadAgents. Stand-ins: the hub (fetch), chat opening (startSoloChat records the
// name), and the views' painting (paint* only fill text in). Real timers.
const AUTO = (app.match(/const dialogGuard = createDialogGuard\(\{ auto: '([^']+)' \}\);/) || [])[1];
const WORKERS_ESC = (app.match(/\n    document\.addEventListener\('keydown', \(e\) => \{\n      if \(e\.key === 'Escape' && document\.getElementById\('workers-menu'\)[^\n]*\n    \}\);\n/) || [])[0];
function page({ agents = [A('aide', 'Aide'), A('researcher', 'Researcher'), A('reporter', 'Reporter'), A('scout', 'Scout')], roster = 'ready', user = 'u1' } = {}) {
  assert.ok(AUTO && WORKERS_ESC, 'app.js wiring found');
  const { doc, dispatch } = makeDom();
  const win = { addEventListener() {}, history: { state: null, pushState() {}, back() {} } };
  const guard = ui.createDialogGuard({ doc, win, auto: AUTO, trackSaves: false });
  const draft = doc.createElement('textarea'); draft.id = 'input-chat-1'; doc.body.appendChild(draft);
  draft.value = 'Hello there, half a message'; draft.selectionStart = draft.selectionEnd = 5;
  const workers = doc.createElement('div'); workers.id = 'workers-menu'; workers.hidden = true; doc.body.appendChild(workers);
  const opened = [], workersClosed = [];
  const c = {
    document: doc, window: { hubMe: user ? { user: { id: user } } : null, __qsRoster: roster, sessionStorage: storage() }, localStorage: storage(), navigator: {},
    AGENTS: agents, chats: {}, dialogGuard: guard, dialogIsModal: ui.dialogIsModal, capName: (x) => x[0].toUpperCase() + x.slice(1),
    dialogRequestClose: (el, how) => guard.requestClose(el, how || 'close'),
    startSoloChat: (name) => { opened.push(name); return 'chat-2'; }, setTimeout, console: { log() {}, error() {} },
    reasonState: new Map([['msg-1', { text: 'thinking', live: false, v: 1 }]]), rsnWords: () => 1, rsnShown: (st) => st.text,
    simpleStyleLabel: () => null, toggleWorkersMenu: (on) => { workersClosed.push(on); workers.hidden = true; },
    live: {}, bg: {}, AgentDot: require('../lib/ui-agent-dot'),   // stand-ins for the sidebar's state (agentLiveState's answer, bgCountOf); AgentDot is the real helper
    agentLiveState: (n) => ({ busy: false, question: false, activity: 'working', ...(c.live[n] || {}) }), bgCountOf: (n) => c.bg[n] || 0,
    agentStatus: {}, doing: {}, frames: [], agentDoingNow: (n) => c.doing[n] || { words: '', detail: '' },   // the sidebar's busy words
    requestAnimationFrame: (f) => { c.frames.push(f); return c.frames.length; }, flush: () => { const f = c.frames.splice(0); f.forEach(x => x()); },
    ownerView: () => 'mine', agentOwnerCache: new Map(), CYBER_MODELS: new Set(['x']), applyStatusSnapshot() {}, renderAgents() {},
  };
  vm.runInNewContext('let qsList = [], qsSel = 0, qsLastQ = null, qsWaiting = new Set(); const QS_MAC = true; let simpleLookOff = null, simpleThemeSaving = false; let rsnFullFor = null, rsnFullReturn = null, toolsFullFor = null, toolsFullReturn = null;\n'
    + ['qsRecentStore', 'qsRecent', 'qsNoteOpened', 'qsRecentKeys', 'qsForgetRecents', 'qsScore', 'qsRank', 'qsUnread', 'qsBlocked', 'closeQuickSwitcher',
      'openQuickSwitcher', 'renderQuickSwitcher', 'qsPaintSel', 'qsKey', 'qsOpen', 'qsShortcut',
      'simpleCloseSettings', 'openSimpleSettings', 'openReasoningFull', 'paintReasoningFull', 'closeReasoningFull', 'openToolsFull', 'closeToolsFull', 'loadAgents'].map(fn).join('')
    + ['qsRowState', 'qsWriteState', 'qsRefreshStates', 'agentStateWords', 'agentBusyWords'].map(fn).join('')
    + one('qsIsOpen') + one('qsRosterChanged') + one('qsRecentBox') + fn('qsStatusChanged') + 'let qsStatusRaf = 0;\n'
    + 'function paintToolsFull() {}\n'   // its painting reads the reply's tool model; opening and closing are real
    + WORKERS_ESC
    + '\nthis.api = { open: openQuickSwitcher, close: closeQuickSwitcher, isOpen: qsIsOpen, roster: qsRosterChanged, statusChanged: qsStatusChanged, shortcut: qsShortcut, openSimpleSettings, simpleCloseSettings, openReasoningFull, closeReasoningFull, openToolsFull, closeToolsFull, loadAgents };', c);
  doc.addEventListener('keydown', c.api.shortcut, true);   // as app.js wires it
  const key = (target, key, props = {}) => dispatch(target, 'keydown', { key, ...props });
  const cmdK = (props = {}) => key(doc.activeElement, 'k', { metaKey: true, ...props });
  const q = () => doc.getElementById('qs-q');
  const rows = () => (doc.getElementById('qs-list') ? doc.getElementById('qs-list').children.map(r => r.dataset.agent) : []);
  const status = () => (doc.getElementById('qs-status') ? doc.getElementById('qs-status').textContent : null);
  const type = (text) => { q().value = text; dispatch(q(), 'input'); };
  draft.focus();
  return { doc, dispatch, guard, draft, workers, workersClosed, c, opened, key, cmdK, q, rows, status, type };
}

// What stays with the browser check: a fake element keeps its caret when it loses and regains the focus, as browsers do
// for a textarea; that the real browser does so (and that focus lands in the draft) was checked in Chrome.
test('⌘K from a message draft: the search box gets the focus; Esc, a click outside and ⌘K again put the focus back in the draft', async () => {
  for (const how of ['escape', 'backdrop', 'shortcut']) {
    const p = page();
    const e = p.cmdK();
    assert.ok(e.defaultPrevented, 'the browser\'s own ⌘K is suppressed');
    assert.ok(p.c.api.isOpen(), how);
    assert.strictEqual(p.doc.activeElement, p.q(), 'focus in the search box');
    await tick();   // the dialog layer's automatic discovery has run too
    if (how === 'escape') p.key(p.q(), 'Escape');
    if (how === 'backdrop') p.dispatch(p.doc.getElementById('qs-overlay'), 'click');
    if (how === 'shortcut') p.cmdK();
    assert.strictEqual(p.c.api.isOpen(), false, `${how} closes it`);
    assert.strictEqual(p.doc.activeElement, p.draft, `${how}: the focus is back in the draft`);
    assert.strictEqual(p.draft.selectionStart, 5, `${how}: the caret is where it was`);
    await tick();
    assert.strictEqual(p.guard.layers().length, 0, `${how}: the dialog layer let go of it`);
  }
});

test('Esc closes only the switcher: an open Workers menu stays open', () => {
  const p = page();
  p.workers.hidden = false;
  p.key(p.draft, 'Escape');
  assert.deepStrictEqual(p.workersClosed, [false], 'control: Esc elsewhere closes the Workers menu (the real listener)');
  p.workers.hidden = false; p.workersClosed.length = 0;
  p.cmdK();
  p.key(p.q(), 'Escape');
  assert.strictEqual(p.c.api.isOpen(), false);
  assert.deepStrictEqual(p.workersClosed, [], 'the Workers menu did not see that Esc');
  assert.strictEqual(p.workers.hidden, false);
});

test('typing filters, ↓ moves, Enter opens that agent\'s chat and closes the switcher', () => {
  const p = page();
  p.cmdK();
  assert.deepStrictEqual(p.rows(), ['aide', 'reporter', 'researcher', 'scout']);
  p.type('re');
  assert.deepStrictEqual(p.rows(), ['reporter', 'researcher']);
  p.key(p.q(), 'ArrowDown');
  assert.strictEqual(p.q().getAttribute('aria-activedescendant'), 'qs-opt-1');
  p.key(p.q(), 'Enter');
  assert.deepStrictEqual(p.opened, ['researcher']);
  assert.strictEqual(p.c.api.isOpen(), false);
});

test('it never opens over another view: Simple Settings, expanded Reasoning, expanded Tool calls (their real open paths), an Advanced settings overlay, "Discard changes?", a modal <dialog>', async () => {
  const views = [
    ['Simple Settings', (p) => p.c.api.openSimpleSettings(), (p) => p.c.api.simpleCloseSettings()],
    ['expanded Reasoning', (p) => p.c.api.openReasoningFull('msg-1'), (p) => p.c.api.closeReasoningFull()],
    ['expanded Tool calls', (p) => p.c.api.openToolsFull('msg-1'), (p) => p.c.api.closeToolsFull()],
  ];
  for (const [label, open, close] of views) {
    const p = page();
    open(p);
    await tick();
    const e = p.cmdK();
    assert.strictEqual(p.c.api.isOpen(), false, `nothing over ${label}`);
    assert.strictEqual(e.defaultPrevented, false, 'the key is not consumed when the switcher will not open: it stays the page\'s and the browser\'s');
    assert.strictEqual(e.stopped, false, 'and it still travels on');
    p.c.api.open();   // openQuickSwitcher() itself refuses too
    assert.strictEqual(p.c.api.isOpen(), false, `openQuickSwitcher() over ${label}`);
    close(p);
    await tick();
    p.cmdK();
    assert.ok(p.c.api.isOpen(), `once ${label} is closed it opens`);
  }

  // Advanced settings (.st-overlay): found by the dialog layer on its own, no hand registration
  let p = page();
  const st = p.doc.createElement('div'); st.className = 'st-overlay'; p.doc.body.appendChild(st);
  await tick();
  p.cmdK();
  assert.strictEqual(p.c.api.isOpen(), false, 'over Advanced settings');

  // The dialog layer's "Discard changes?" question (a changed field in an overlay, then Escape)
  p = page();
  const ov = p.doc.createElement('div'); ov.className = 'gs-overlay'; p.doc.body.appendChild(ov);
  const field = p.doc.createElement('input'); ov.appendChild(field);
  await tick();
  field.focus(); field.value = 'changed'; p.dispatch(field, 'input');
  p.key(field, 'Escape');
  assert.ok(p.guard._confirm(), 'the question is up');
  p.cmdK();
  assert.strictEqual(p.c.api.isOpen(), false, 'over "Discard changes?"');
  assert.strictEqual(p.doc.querySelectorAll('.qs-overlay').length, 0, 'nothing left behind under it');

  // A native <dialog> opened with showModal()
  p = page();
  const d = p.doc.createElement('dialog'); p.doc.body.appendChild(d); d.showModal();
  await tick();
  p.cmdK();
  assert.strictEqual(p.c.api.isOpen(), false, 'over a modal <dialog>');

  // A docked panel leaves the page usable: the switcher opens; and its own toggle still closes it
  p = page();
  const dock = p.doc.createElement('div'); dock.className = 'gs-overlay gs-dock'; p.doc.body.appendChild(dock);
  await tick();
  p.cmdK();
  assert.ok(p.c.api.isOpen(), 'beside a docked panel');
  p.cmdK();
  assert.strictEqual(p.c.api.isOpen(), false, 'a second ⌘K closes it');
});

test('a held ⌘K (auto-repeat) neither toggles nor reaches the browser', () => {
  const p = page();
  let e = p.cmdK({ repeat: true });
  assert.strictEqual(p.c.api.isOpen(), false, 'a repeat alone opens nothing');
  assert.ok(e.defaultPrevented);
  p.cmdK();
  for (let i = 0; i < 5; i++) e = p.cmdK({ repeat: true });
  assert.ok(p.c.api.isOpen(), 'held down: stays open');
  assert.ok(e.defaultPrevented);
  p.cmdK();
  assert.strictEqual(p.c.api.isOpen(), false, 'a second deliberate press closes it');
});

test('the agent list: loading, then arriving into an open switcher; a failed answer from the hub reads as a failure, not "No agents yet."', async () => {
  const p = page({ agents: [], roster: null });
  p.cmdK();
  assert.strictEqual(p.status(), 'Loading agents…');
  p.key(p.q(), 'Enter');
  assert.deepStrictEqual(p.opened, [], 'Enter does nothing while loading');
  p.type('sc');
  p.c.fetch = async () => ({ ok: true, status: 200, json: async () => ({ agents: [A('scout', 'Scout'), A('aide', 'Aide')] }) });
  await p.c.api.loadAgents();
  assert.deepStrictEqual(p.rows(), ['scout']);
  assert.strictEqual(p.q().value, 'sc');
  assert.strictEqual(p.status(), '');
  p.key(p.q(), 'Enter');
  assert.deepStrictEqual(p.opened, ['scout']);

  const answers = {
    '503 with a JSON body': { ok: false, status: 503, json: async () => ({ error: 'busy' }) },
    'OK without a list': { ok: true, status: 200, json: async () => ({ agents: 'nope' }) },
    'an unreadable body': { ok: true, status: 200, json: async () => { throw new Error('bad json'); } },
  };
  for (const [label, res] of Object.entries(answers)) {
    const f = page({ agents: [], roster: null });
    f.cmdK();
    f.c.fetch = async () => res;
    await f.c.api.loadAgents();
    assert.match(f.status(), /^Could not load your agents/, label);
  }
  const empty = page({ agents: [], roster: null });
  empty.cmdK();
  empty.c.fetch = async () => ({ ok: true, status: 200, json: async () => ({ agents: [] }) });
  await empty.c.api.loadAgents();
  assert.strictEqual(empty.status(), 'No agents yet.', 'a real empty list');
  const none = page(); none.cmdK(); none.type('zzz');
  assert.strictEqual(none.status(), 'No agent matches “zzz”.');
});

test('accessibility: a named combobox that is expanded, an active option, and a live status for "no results"', () => {
  const p = page();
  p.cmdK();
  const q = p.q();
  assert.strictEqual(q.getAttribute('role'), 'combobox');
  assert.strictEqual(q.getAttribute('aria-expanded'), 'true');
  assert.strictEqual(q.getAttribute('aria-controls'), 'qs-list');
  assert.ok(q.getAttribute('aria-label'), 'an accessible name');
  assert.strictEqual(p.doc.getElementById('qs-list').getAttribute('role'), 'listbox');
  assert.strictEqual(q.getAttribute('aria-activedescendant'), 'qs-opt-0');
  const st = p.doc.getElementById('qs-status');
  assert.strictEqual(st.getAttribute('role'), 'status');
  assert.strictEqual(st.getAttribute('aria-live'), 'polite');
  p.type('zzz');
  assert.strictEqual(q.hasAttribute('aria-activedescendant'), false);
  assert.strictEqual(st.textContent, 'No agent matches “zzz”.', 'announced');
  const dialog = p.doc.querySelector('.qs-modal');
  assert.strictEqual(dialog.getAttribute('role'), 'dialog');
  assert.strictEqual(dialog.getAttribute('aria-modal'), 'true');
});

test('the shortcut: ⌘K on a Mac and Ctrl+K elsewhere; other combinations are left alone', () => {
  const run = (mac, ev) => {
    let opened = 0, prevented = false, stopped = false;
    const c = { QS_MAC: mac, openQuickSwitcher: () => { opened++; }, qsIsOpen: () => !!ev.isOpen, qsBlocked: () => !!ev.blocked };
    vm.runInNewContext(fn('qsShortcut') + '\nthis.go = qsShortcut;', c);
    c.go({ key: 'k', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, ...ev, preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
    return { opened, prevented, stopped };
  };
  assert.deepStrictEqual(run(true, { metaKey: true }), { opened: 1, prevented: true, stopped: true });
  assert.deepStrictEqual(run(true, { metaKey: true, key: 'K' }), { opened: 1, prevented: true, stopped: true }, 'Caps Lock on');
  assert.strictEqual(run(true, { ctrlKey: true }).opened, 0, 'Ctrl+K on a Mac deletes to the end of the line: left alone');
  assert.strictEqual(run(true, { metaKey: true, shiftKey: true }).opened, 0);
  assert.strictEqual(run(true, { metaKey: true, altKey: true }).opened, 0);
  assert.strictEqual(run(true, { metaKey: true, isComposing: true }).opened, 0);
  assert.strictEqual(run(true, { metaKey: true, key: 'j' }).opened, 0);
  assert.deepStrictEqual(run(false, { ctrlKey: true }), { opened: 1, prevented: true, stopped: true });
  assert.strictEqual(run(false, { metaKey: true }).opened, 0);
  assert.strictEqual(run(false, {}).opened, 0, 'a plain k is typing');
  // a non-Latin layout: key is another letter, code is still KeyK; the modifier rules are the same
  assert.deepStrictEqual(run(false, { ctrlKey: true, key: 'л', code: 'KeyK' }), { opened: 1, prevented: true, stopped: true });
  assert.deepStrictEqual(run(true, { metaKey: true, key: 'л', code: 'KeyK' }), { opened: 1, prevented: true, stopped: true });
  assert.strictEqual(run(true, { ctrlKey: true, key: 'л', code: 'KeyK' }).opened, 0);
  assert.strictEqual(run(false, { ctrlKey: true, shiftKey: true, key: 'л', code: 'KeyK' }).opened, 0);
  assert.strictEqual(run(false, { ctrlKey: true, key: 'о', code: 'KeyJ' }).opened, 0);
  // blocked and closed: not consumed, nothing opened; blocked but open (its own toggle) and not blocked: consumed
  assert.deepStrictEqual(run(false, { ctrlKey: true, blocked: true }), { opened: 0, prevented: false, stopped: false });
  assert.deepStrictEqual(run(false, { ctrlKey: true, blocked: true, isOpen: true }), { opened: 1, prevented: true, stopped: true });
});

test('keys in the search box: ↓/↑ and Ctrl+N/P wrap, an input method composing is left alone', () => {
  const p = page();
  p.cmdK();
  const sel = () => p.q().getAttribute('aria-activedescendant');
  p.key(p.q(), 'ArrowUp'); assert.strictEqual(sel(), 'qs-opt-3', 'wraps to the bottom');
  p.key(p.q(), 'ArrowDown'); assert.strictEqual(sel(), 'qs-opt-0', 'wraps to the top');
  p.key(p.q(), 'n', { ctrlKey: true }); assert.strictEqual(sel(), 'qs-opt-1');
  p.key(p.q(), 'p', { ctrlKey: true }); assert.strictEqual(sel(), 'qs-opt-0');
  p.key(p.q(), 'Enter', { isComposing: true });
  assert.deepStrictEqual(p.opened, [], 'Enter that ends an input method composition does not open');
  p.key(p.q(), 'Escape', { isComposing: true });
  assert.ok(p.c.api.isOpen(), 'nor does Escape close it then');
});

test('styles and the CHANGELOG entry', () => {
  assert.match(index, /\.gs-overlay\.qs-overlay \{/);
  assert.match(index, /\.qs-status:empty \{ display: none; \}/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8'), /\*\*⌘K jumps to any agent\.\*\*/);
});

// ── The voice call's display (lib/ui-call-display.js, the real code) and anything else shown with aria-modal ──
const CD = require('../lib/ui-call-display');
function callDisplay(p, choice) {
  const player = () => new Proxy({}, { get: (t, k) => (k === 'ready' || k === 'pictureReady' ? Promise.resolve(t) : k === 'then' ? undefined : () => true) });
  const composer = p.doc.createElement('div'); composer.id = 'composer'; p.doc.body.appendChild(composer);
  const mem = new Map([[CD.DISPLAY_STORE_KEY, JSON.stringify({ choice, captions: false })]]);
  const display = CD.createCallDisplay({
    window: { document: p.doc }, document: p.doc, storage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ packs: [] }) }), setTimeout, clearTimeout,
    agentDefault: () => 'none', dock: () => composer, adopt: () => [], onTalk() {}, onHangUp() {}, onChange() {},
    createVoiceOrb: player, createFacePlayer: player,
  });
  display.start();
  return display;
}
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

test('a voice call: the full-screen display (Orb) blocks ⌘K and keeps the focus; the docked call bar in the chat does not', async () => {
  let p = page();
  const full = callDisplay(p, 'orb');
  await settle();
  const root = p.doc.querySelector('.ucd-overlay');
  assert.ok(root && root.getAttribute('aria-modal') === 'true' && !root.cls.has('ucd-docked'), 'the real full-screen display is up (aria-modal)');
  const before = p.doc.activeElement;
  p.cmdK();
  assert.strictEqual(p.c.api.isOpen(), false, 'nothing opens over the call');
  assert.strictEqual(p.doc.activeElement, before, 'the focus stays where the call put it');
  p.c.api.open();
  assert.strictEqual(p.c.api.isOpen(), false, 'nor when openQuickSwitcher() is called directly');
  full.release();

  p = page();
  const docked = callDisplay(p, 'none');
  await settle();
  const bar = p.doc.querySelector('.ucd-overlay');
  assert.ok(bar && bar.cls.has('ucd-docked') && !bar.hasAttribute('aria-modal'), 'the real docked bar is in the chat, without aria-modal');
  p.cmdK();
  assert.ok(p.c.api.isOpen(), 'beside the docked call bar the switcher opens');
  docked.release();
});

test('anything shown with aria-modal="true" blocks; the same thing hidden, under display:none or out of the page does not', async () => {
  const cases = [
    ['visible', () => {}, true],
    ['hidden attribute', (el) => { el.hidden = true; }, false],
    ['parent display:none', (el, wrap) => { wrap.style.display = 'none'; }, false],
    ['removed from the page', (el, wrap) => { wrap.remove(); }, false],
  ];
  for (const [label, change, blocks] of cases) {
    const p = page();
    const wrap = p.doc.createElement('div'); const el = p.doc.createElement('div');
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true');
    wrap.appendChild(el); p.doc.body.appendChild(wrap);
    change(el, wrap);
    p.cmdK();
    assert.strictEqual(p.c.api.isOpen(), !blocks, `${label}: ${blocks ? 'blocks' : 'does not block'}`);
  }
  // The expanded Reasoning view closed: its aria-modal box stays in the page (display:none from its overlay), and must not block
  const p = page();
  p.c.api.openReasoningFull('msg-1'); p.c.api.closeReasoningFull();
  assert.ok(p.doc.querySelector('.rsn-full-box[aria-modal="true"]'), 'the closed view keeps its aria-modal box');
  p.cmdK();
  assert.ok(p.c.api.isOpen(), 'a closed expanded view never blocks the switcher');
});

// ── Review fixes: the selection follows the agent, the state is in words with the sidebar's marker ──
test('the selection follows the agent by name across a repaint; a new query starts at the first row; a vanished agent falls back to the first row', () => {
  const p = page({ agents: [A('beta', 'Beta'), A('delta', 'Delta'), A('gamma', 'Gamma')] });
  p.cmdK();
  assert.deepStrictEqual(p.rows(), ['beta', 'delta', 'gamma']);
  p.key(p.q(), 'ArrowDown'); p.key(p.q(), 'ArrowDown');   // gamma
  p.c.AGENTS.push(A('alpha', 'Alpha'));   // sorts above everything: the roster reloaded
  p.c.api.roster();
  assert.deepStrictEqual(p.rows(), ['alpha', 'beta', 'delta', 'gamma']);
  const sel = p.doc.querySelector('.qs-row.sel');
  assert.strictEqual(sel.dataset.agent, 'gamma', 'still gamma');
  assert.strictEqual(p.q().getAttribute('aria-activedescendant'), 'qs-opt-3');
  p.key(p.q(), 'Enter');
  assert.deepStrictEqual(p.opened, ['gamma']);
  // a new query: first row
  const q = page({ agents: [A('beta', 'Beta'), A('delta', 'Delta'), A('gamma', 'Gamma')] });
  q.cmdK(); q.key(q.q(), 'ArrowDown');
  q.type('a');
  assert.strictEqual(q.doc.querySelector('.qs-row.sel').dataset.agent, q.rows()[0]);
  // the selected agent is gone: first row
  const g = page({ agents: [A('beta', 'Beta'), A('delta', 'Delta'), A('gamma', 'Gamma')] });
  g.cmdK(); g.key(g.q(), 'ArrowDown');   // delta
  g.c.AGENTS.splice(1, 1);
  g.c.api.roster();
  assert.strictEqual(g.doc.querySelector('.qs-row.sel').dataset.agent, 'beta');
  // closed and opened again: starts at the first row, not at the earlier agent
  const r = page({ agents: [A('beta', 'Beta'), A('delta', 'Delta')] });
  r.cmdK(); r.key(r.q(), 'ArrowDown'); r.cmdK(); r.cmdK();
  assert.strictEqual(r.doc.querySelector('.qs-row.sel').dataset.agent, 'beta');
});

test('each row says its state in words (the sidebar\'s), with the sidebar\'s marker; waiting for an answer is not "Working"; the words are part of the option', () => {
  const p = page({ agents: [A('aide', 'Aide'), A('scout', 'Scout'), A('forge', 'Forge'), A('hazel', 'Hazel'), A('news', 'News'), A('calm', 'Calm')] });
  p.c.live = { scout: { busy: true, activity: 'replying to you' }, forge: { question: true, busy: true }, hazel: { busy: false } };
  p.c.bg = { hazel: 2 };
  p.c.doing = { scout: { words: 'Replying to you', detail: '' } };
  const tabEl = p.doc.createElement('div'); tabEl.id = 'tab-c9'; tabEl.className = 'chat-tab unread'; p.doc.body.appendChild(tabEl);
  p.c.chats.c9 = { agent: 'news' };
  p.cmdK();
  const row = (n) => p.doc.querySelector(`.qs-row[data-agent="${n}"]`);
  const state = (n) => { const s = row(n).children.find(x => x.cls.has('qs-state')); return s ? s.textContent : null; };
  const dot = (n) => row(n).children.find(x => x.cls.has('qs-dot'));
  assert.strictEqual(state('news'), 'New replies'); assert.ok(dot('news').cls.has('unread'));
  assert.strictEqual(state('forge'), 'waiting for your answer', 'the question state, the sidebar\'s words');
  assert.ok(dot('forge').cls.has('live-question') && !dot('forge').cls.has('busy'), 'the sidebar\'s marker, not the amber one');
  assert.strictEqual(dot('forge').textContent, '?');
  assert.strictEqual(state('scout'), 'Replying to you'); assert.ok(dot('scout').cls.has('busy'));
  assert.strictEqual(state('hazel'), 'Free · 2 in background'); assert.ok(dot('hazel').cls.has('bg-work'));
  assert.strictEqual(state('calm'), null); assert.strictEqual(dot('calm'), undefined);
  for (const n of ['news', 'forge', 'scout', 'hazel']) {
    assert.ok(row(n).textContent.includes(state(n)), 'the words are in the option\'s text, so in its accessible name');
    assert.strictEqual(dot(n).getAttribute('aria-hidden'), 'true');
    assert.strictEqual(dot(n).getAttribute('title'), null, 'no hover-only meaning');
  }
  // the icon is decoration, in a fixed box
  assert.strictEqual(row('aide').children[0].getAttribute('aria-hidden'), 'true');
  assert.match(index, /\.qs-ic \{[^}]*width: 22px; height: 22px;[^}]*flex: none;/);
});

test('the grey short name shows only when the typed text matched it', () => {
  const p = page({ agents: [A('rsch', 'Researcher'), A('aide', 'Aide')] });
  p.cmdK();
  const ids = () => p.doc.querySelectorAll('.qs-id').map(x => x.textContent);
  assert.deepStrictEqual(ids(), [], 'nothing typed');
  p.type('rs');
  assert.deepStrictEqual(ids(), ['rsch']);
  p.type('resea');
  assert.deepStrictEqual(ids(), [], 'matched the display name only');
});

// ── Round 1 review fixes ──
const rowState = (p, n) => { const r = p.doc.querySelector(`.qs-row[data-agent="${n}"]`); const s = r && r.children.find(x => x.cls.has('qs-state')); return s ? s.textContent : null; };
const rowDot = (p, n) => { const r = p.doc.querySelector(`.qs-row[data-agent="${n}"]`); return r && r.children.find(x => x.cls.has('qs-dot')); };
const markUnread = (p, id, agent) => { const t = p.doc.createElement('div'); t.id = `tab-${id}`; t.className = 'chat-tab unread'; p.doc.body.appendChild(t); p.c.chats[id] = { agent }; };

test('one state per row: question > busy > unread > background', () => {
  const p = page({ agents: [A('qa', 'Qa'), A('ba', 'Ba'), A('ua', 'Ua'), A('ga', 'Ga')] });
  p.c.live = { qa: { question: true, busy: true }, ba: { busy: true, activity: 'working' } };
  p.c.bg = { ga: 3 };
  p.c.doing = { ba: { words: 'Working', detail: '' } };
  for (const [i, n] of ['qa', 'ba', 'ua', 'ga'].entries()) markUnread(p, `c${i}`, n);
  p.cmdK();
  assert.strictEqual(rowState(p, 'qa'), 'waiting for your answer');
  assert.ok(rowDot(p, 'qa').cls.has('live-question') && rowDot(p, 'qa').textContent === '?');
  assert.strictEqual(rowState(p, 'ba'), 'Working', 'busy and unread: the busy words');
  assert.ok(rowDot(p, 'ba').cls.has('busy'));
  assert.strictEqual(rowState(p, 'ua'), 'New replies'); assert.ok(rowDot(p, 'ua').cls.has('unread'));
  assert.strictEqual(rowState(p, 'ga'), 'New replies', 'background work and unread: unread');
  assert.ok(rowDot(p, 'ga').cls.has('unread'));
});

test('a busy named agent reads the sidebar\'s words (agentDoingNow), a worker the activity words', () => {
  const p = page({ agents: [A('scout', 'Scout'), A('wk', 'Wk')] });
  p.c.live = { scout: { busy: true, activity: 'replying to you' }, wk: { busy: true, activity: 'working' } };
  p.c.doing = { scout: { words: 'Replying to your message', detail: 'step 2' }, wk: { words: 'Never shown' } };
  p.c.agentStatus = { wk: { worker: true } };
  p.cmdK();
  assert.strictEqual(rowState(p, 'scout'), 'Replying to your message');
  assert.strictEqual(rowState(p, 'wk'), 'working', 'a worker: the activity words, as the sidebar prints them (no capital added)');
  p.c.doing.scout = { words: 'checking the mail' };
  p.c.api.roster();
  assert.strictEqual(rowState(p, 'scout'), 'checking the mail', 'the sidebar\'s case, untouched');
});

test('an open switcher repaints its rows when the sidebar status changes: once per frame, selection, focus and scroll kept', () => {
  const p = page({ agents: [A('aide', 'Aide'), A('scout', 'Scout'), A('forge', 'Forge')] });
  p.c.live = { scout: { busy: true, activity: 'working' } };
  p.c.doing = { scout: { words: 'Working', detail: '' } };
  p.c.api.statusChanged();
  assert.strictEqual(p.c.frames.length, 0, 'closed: nothing scheduled');
  p.cmdK();
  p.key(p.q(), 'ArrowDown'); p.key(p.q(), 'ArrowDown');
  const selBefore = p.doc.querySelector('.qs-row.sel').dataset.agent;
  p.doc.getElementById('qs-list').scrollTop = 40;
  assert.strictEqual(rowState(p, 'scout'), 'Working');
  p.c.live = { scout: { question: true, busy: true } };
  p.c.api.statusChanged(); p.c.api.statusChanged(); p.c.api.statusChanged();
  assert.strictEqual(p.c.frames.length, 1, 'many calls, one frame');
  assert.strictEqual(rowState(p, 'scout'), 'Working', 'not before the frame');
  p.c.flush();
  assert.strictEqual(rowState(p, 'scout'), 'waiting for your answer');
  assert.strictEqual(p.doc.querySelector('.qs-row.sel').dataset.agent, selBefore);
  assert.strictEqual(p.doc.activeElement, p.q(), 'the focus did not move');
  assert.strictEqual(p.doc.getElementById('qs-list').scrollTop, 40);
  p.c.api.statusChanged(); p.cmdK();   // closed before the frame runs
  assert.doesNotThrow(() => p.c.flush());
  p.c.api.statusChanged();
  assert.strictEqual(p.c.frames.length, 0);
});

test('a status repaint updates the rows in place: the same row nodes, no row replaced (a click in flight still lands)', () => {
  const p = page({ agents: [A('aide', 'Aide'), A('scout', 'Scout'), A('forge', 'Forge')] });
  p.c.live = { scout: { busy: true, activity: 'working' } };
  p.cmdK();
  p.key(p.q(), 'ArrowDown');
  const list = p.doc.getElementById('qs-list');
  const rowEl = (n) => p.doc.querySelector(`.qs-row[data-agent="${n}"]`);
  const before = list.children.slice(), scoutRow = rowEl('scout'), forgeRow = rowEl('forge');
  list.scrollTop = 40;
  const selBefore = p.doc.querySelector('.qs-row.sel').dataset.agent, active = p.q().getAttribute('aria-activedescendant');
  // (a) busy -> question: the same node, new words and marker
  p.c.live = { scout: { question: true, busy: true } };
  p.c.api.statusChanged(); p.c.flush();
  assert.strictEqual(rowEl('scout'), scoutRow, 'the same row node');
  assert.strictEqual(rowState(p, 'scout'), 'waiting for your answer');
  assert.ok(rowDot(p, 'scout').cls.has('live-question') && !rowDot(p, 'scout').cls.has('busy') && rowDot(p, 'scout').textContent === '?');
  assert.ok(list.children.length === before.length && before.every(r => list.children.includes(r)), 'every row node kept (the waiting agent moved to the top: the waiting set changed)');
  assert.deepStrictEqual(list.children.map(r => r.dataset.agent), ['scout', 'aide', 'forge']);
  assert.deepStrictEqual(scoutRow.children.map(x => [...x.cls][0]), ['qs-ic', 'qs-name', 'qs-state', 'qs-dot'], 'same element order as a full paint');
  // a new state on a row that had none: created in place
  p.c.bg = { forge: 2 };
  p.c.api.statusChanged(); p.c.flush();
  assert.strictEqual(rowEl('forge'), forgeRow);
  assert.strictEqual(rowState(p, 'forge'), 'Free · 2 in background'); assert.ok(rowDot(p, 'forge').cls.has('bg-work'));
  assert.strictEqual(rowDot(p, 'forge').getAttribute('aria-hidden'), 'true');
  // (b) a state cleared: the state words and the dot are removed from that row
  p.c.live = {}; p.c.bg = {};
  p.c.api.statusChanged(); p.c.flush();
  assert.strictEqual(rowEl('scout'), scoutRow);
  assert.strictEqual(rowState(p, 'scout'), null); assert.strictEqual(rowDot(p, 'scout'), undefined);
  assert.strictEqual(rowState(p, 'forge'), null); assert.strictEqual(rowDot(p, 'forge'), undefined);
  assert.strictEqual(scoutRow.children.length, 2);
  // untouched: selection, aria-activedescendant, scroll, focus
  assert.strictEqual(p.doc.querySelector('.qs-row.sel').dataset.agent, selBefore);
  assert.strictEqual(p.q().getAttribute('aria-activedescendant'), active);
  assert.strictEqual(list.scrollTop, 40); assert.strictEqual(p.doc.activeElement, p.q());
  assert.deepStrictEqual(list.children, before);
});

test('scroll is restored only for an unchanged query; a changed query scrolls back to the selected first row', () => {
  const agents = Array.from({ length: 40 }, (_, i) => A('ag' + String(i).padStart(2, '0'), 'Ag' + String(i).padStart(2, '0')));
  const p = page({ agents });
  p.cmdK();
  const list = p.doc.getElementById('qs-list');
  list.scrollTop = 300;
  p.c.AGENTS.push(A('zed', 'Zed'));   // roster refresh, same query: scroll kept
  p.c.api.roster();
  assert.strictEqual(list.scrollTop, 300, 'unchanged query: scroll kept');
  p.type('ag1');   // a changed query: first row selected and in view
  assert.strictEqual(list.scrollTop, 0);
  assert.strictEqual(p.doc.querySelector('.qs-row.sel').dataset.i, '0');
  list.scrollTop = 50; p.c.api.roster();
  assert.strictEqual(list.scrollTop, 50, 'same query again: kept');
});

test('the selected agent removed from the roster while scrolled down: back to the first row, scrolled to the top', () => {
  const agents = Array.from({ length: 40 }, (_, i) => A('ag' + String(i).padStart(2, '0'), 'Ag' + String(i).padStart(2, '0')));
  const p = page({ agents });
  p.cmdK();
  const list = p.doc.getElementById('qs-list');
  for (let i = 0; i < 30; i++) p.key(p.q(), 'ArrowDown');
  const gone = p.doc.querySelector('.qs-row.sel').dataset.agent;
  assert.ok(Number(p.doc.querySelector('.qs-row.sel').dataset.i) >= 30, 'selection far down');
  list.scrollTop = 500;
  const at = p.c.AGENTS.findIndex(a => a.name === gone);
  p.c.AGENTS.splice(at, 1);
  p.c.api.roster();
  assert.strictEqual(p.doc.querySelector('.qs-row.sel').dataset.i, '0');
  assert.strictEqual(p.q().getAttribute('aria-activedescendant'), 'qs-opt-0');
  assert.strictEqual(list.scrollTop, 0);
});

test('an agent entering then leaving the waiting state while open moves to the top and back: same nodes, the selection follows its agent', () => {
  const p = page({ agents: [A('aide', 'Aide'), A('forge', 'Forge'), A('scout', 'Scout'), A('zed', 'Zed')] });
  p.cmdK();
  const list = p.doc.getElementById('qs-list');
  const order = () => list.children.map(r => r.dataset.agent);
  const nodes = list.children.slice();
  p.key(p.q(), 'ArrowDown'); p.key(p.q(), 'ArrowDown');   // forge is row 1, scout row 2: select scout
  list.scrollTop = 25;
  assert.deepStrictEqual(order(), ['aide', 'forge', 'scout', 'zed']);
  assert.strictEqual(p.doc.querySelector('.qs-row.sel').dataset.agent, 'scout');
  p.c.live = { zed: { question: true } };
  p.c.api.statusChanged(); p.c.flush();
  assert.deepStrictEqual(order(), ['zed', 'aide', 'forge', 'scout'], 'the waiting agent is on top');
  assert.ok(nodes.every(r => list.children.includes(r)) && list.children.length === 4, 'the same row nodes');
  assert.strictEqual(p.doc.querySelector('.qs-row.sel').dataset.agent, 'scout', 'the selection stays on scout');
  assert.deepStrictEqual(list.children.map(r => r.dataset.i), ['0', '1', '2', '3']);
  assert.strictEqual(p.q().getAttribute('aria-activedescendant'), 'qs-opt-3');
  assert.strictEqual(p.doc.activeElement, p.q()); assert.strictEqual(list.scrollTop, 25);
  // select the waiting agent itself (row 0), then let it stop waiting: it goes back down and stays selected
  p.key(p.q(), 'ArrowDown');   // wraps: scout (row 3) -> zed (row 0)
  assert.strictEqual(p.doc.querySelector('.qs-row.sel').dataset.agent, 'zed');
  p.c.live = {};
  p.c.api.statusChanged(); p.c.flush();
  assert.deepStrictEqual(order(), ['aide', 'forge', 'scout', 'zed'], 'back to the normal order');
  assert.ok(nodes.every(r => list.children.includes(r)) && list.children.length === 4, 'the same row nodes');
  assert.strictEqual(p.doc.querySelector('.qs-row.sel').dataset.agent, 'zed', 'the selection followed zed to its new place');
  assert.strictEqual(p.q().getAttribute('aria-activedescendant'), 'qs-opt-3');
  assert.strictEqual(list.scrollTop, 25);
});

test('a typed query: the match decides first, waiting only breaks ties; with no query waiting comes first', () => {
  const c = {};
  vm.runInNewContext([fn('qsScore'), fn('qsRank')].join('') + '\nthis.rank = qsRank;', c);
  const agents = [A('misc-coach', 'Misc Coach'), A('scout', 'Scout')];
  const names = (l) => l.map(a => a.name);
  const waiting = new Set(['misc-coach']);
  assert.deepStrictEqual(names(c.rank(agents, 'sc', { waiting })), ['scout', 'misc-coach'], 'exact prefix beats a waiting loose match');
  assert.deepStrictEqual(names(c.rank(agents, '', { waiting })), ['misc-coach', 'scout'], 'no query: waiting first');
  const tie = [A('scout-a', 'Scout A'), A('scout-b', 'Scout B')];
  assert.deepStrictEqual(names(c.rank(tie, 'sco', { waiting: new Set(['scout-b']) })), ['scout-b', 'scout-a'], 'equal scores: waiting breaks the tie');
});

test('a status-only update never re-sorts the open rows (an agent that becomes unread keeps its place until the next full render)', () => {
  const agents = Array.from({ length: 6 }, (_, i) => A('ag' + i, 'Ag' + i));
  const p = page({ agents });
  p.cmdK();
  const order = () => p.doc.querySelectorAll('.qs-row').map(r => r.dataset.agent);
  const before = order();
  assert.strictEqual(before.length, 6);
  markUnread(p, 'c1', 'ag4');
  p.c.api.statusChanged(); p.c.flush();
  assert.strictEqual(rowState(p, 'ag4'), 'New replies');
  assert.deepStrictEqual(order(), before, 'same row order');
});

test('without requestAnimationFrame the repaint falls back to a timer', async () => {
  const p = page({ agents: [A('scout', 'Scout')] });
  p.c.requestAnimationFrame = undefined;
  p.cmdK();
  p.c.live = { scout: { question: true } };
  p.c.api.statusChanged();
  await tick();
  assert.strictEqual(rowState(p, 'scout'), 'waiting for your answer');
});

test('the sidebar status paint tells the open switcher', () => {
  assert.match(fn('paintAgentStatus'), /qsStatusChanged\(\)/);
  assert.match(fn('paintAllAgentStatus'), /qsStatusChanged\(\)/);
});

test('the shortcut leaves an input method composition alone (isComposing, keyCode 229)', () => {
  const run = (ev) => {
    let opened = 0, prevented = false, stopped = false;
    const c = { QS_MAC: false, openQuickSwitcher: () => { opened++; }, qsIsOpen: () => false, qsBlocked: () => false };
    vm.runInNewContext(fn('qsShortcut') + '\nthis.go = qsShortcut;', c);
    c.go({ key: 'k', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, ...ev, preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
    return { opened, prevented, stopped };
  };
  assert.deepStrictEqual(run({ isComposing: true }), { opened: 0, prevented: false, stopped: false });
  assert.deepStrictEqual(run({ keyCode: 229 }), { opened: 0, prevented: false, stopped: false });
  assert.deepStrictEqual(run({ keyCode: 75 }), { opened: 1, prevented: true, stopped: true });
});

test('the physical K key counts only when the key typed is not a Latin letter (Dvorak, Colemak, Cyrillic)', () => {
  const run = (ev) => {
    let opened = 0, prevented = false;
    const c = { QS_MAC: false, openQuickSwitcher: () => { opened++; }, qsIsOpen: () => false, qsBlocked: () => false };
    vm.runInNewContext(fn('qsShortcut') + '\nthis.go = qsShortcut;', c);
    c.go({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, ...ev, preventDefault: () => { prevented = true; }, stopPropagation() {} });
    return { opened, prevented };
  };
  assert.deepStrictEqual(run({ key: 'л', code: 'KeyK' }), { opened: 1, prevented: true });
  assert.deepStrictEqual(run({ key: 't', code: 'KeyK' }), { opened: 0, prevented: false }, 'Dvorak: Ctrl+T stays the browser\'s');
  assert.deepStrictEqual(run({ key: 'e', code: 'KeyK' }), { opened: 0, prevented: false }, 'Colemak: Ctrl+E');
  assert.deepStrictEqual(run({ key: 'k', code: 'KeyT' }), { opened: 1, prevented: true }, 'Dvorak K is on another physical key');
  assert.deepStrictEqual(run({ key: 'K', code: 'KeyT' }), { opened: 1, prevented: true });
});
