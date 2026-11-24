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
function ctx(extra = {}) {
  const c = { localStorage: storage(), window: { hubMe: { user: { id: 'u1' } } }, ...extra };
  vm.runInNewContext(
    [fn('qsRecentStore'), fn('qsRecent'), fn('qsNoteOpened'), fn('qsForgetRecents'), fn('qsScore'), fn('qsRank')].join('')
    + '\nthis.qsRecent = qsRecent; this.qsNoteOpened = qsNoteOpened; this.qsForgetRecents = qsForgetRecents; this.qsRecentStore = qsRecentStore; this.qsScore = qsScore; this.qsRank = qsRank;', c);
  return c;
}

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

test('recents belong to the signed-in person: their own key, none before /api/me, other people\'s and the old shared key dropped, all gone on sign-out', () => {
  const ls = storage({ 'hub-qs-recent': JSON.stringify(['old-shared']), 'other-key': 'x' });
  const c = ctx({ localStorage: ls });
  c.qsNoteOpened('aide'); c.qsNoteOpened('forge'); c.qsNoteOpened('aide');
  assert.deepStrictEqual([...c.qsRecent()], ['aide', 'forge']);
  assert.strictEqual(ls._s['hub-qs-recent:u1'], JSON.stringify(['aide', 'forge']));
  for (let i = 0; i < 40; i++) c.qsNoteOpened(`a${i}`);
  assert.strictEqual(c.qsRecent().length, 30);
  c.window.hubMe = { user: { id: 'u2' } };   // another account on the same browser
  assert.deepStrictEqual([...c.qsRecent()], [], 'u2 never sees u1\'s list');
  c.qsNoteOpened('scout');
  c.qsForgetRecents(c.qsRecentStore().key);   // what the page does when /api/me answers
  assert.deepStrictEqual(Object.keys(ls._s).sort(), ['hub-qs-recent:u2', 'other-key'], 'old shared key and u1\'s list removed, other keys untouched');
  c.qsForgetRecents(null);                    // sign-out
  assert.deepStrictEqual(Object.keys(ls._s), ['other-key']);
  c.window.hubMe = null;                      // not known yet
  c.qsNoteOpened('aide');
  assert.deepStrictEqual([...c.qsRecent()], []);
  assert.deepStrictEqual(Object.keys(ls._s), ['other-key'], 'nothing stored before the hub says who is signed in');
  const broken = ctx({ localStorage: storage({ 'hub-qs-recent:u1': '{not json' }) });
  assert.deepStrictEqual([...broken.qsRecent()], []);
});

test('recents are tidied when /api/me answers and cleared on sign-out (page wiring)', () => {
  assert.match(fn('loadMe'), /window\.hubMe = await r\.json\(\);[^\n]*\n[^\n]*hubSimple\.apply[^\n]*\n\s*try \{ qsForgetRecents\(qsRecentStore\(\)\.key\); \}/);
  assert.match(fn('signOut'), /^\s*async function signOut\(\) \{\s*\n\s*try \{ qsForgetRecents\(null\); \}[^\n]*\n\s*try \{ await fetch\('\/api\/auth\/logout'/m);
  assert.match(fn('switchToChat'), /if \(opened && !opened\.isGroup && !opened\.isWorker && !opened\.isHistory && opened\.agent\) qsNoteOpened\(opened\.agent\);/);
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

// ── A small DOM: elements, text, a little markup (for the dialog layer's own question), focus with focusin, the
// active element falling back to <body> when it is removed, events with capture and bubble, <dialog> showModal. ──
function makeDom() {
  const doc = { listeners: { capture: {}, bubble: {} }, activeElement: null, modal: null };
  const kebab = (k) => String(k).replace(/[A-Z]/g, c => '-' + c.toLowerCase());
  class Text { constructor(t) { this.nodeType = 3; this.data = String(t); this.parent = null; } get textContent() { return this.data; } remove() { if (this.parent) this.parent.childNodes = this.parent.childNodes.filter(x => x !== this); this.parent = null; } }
  class El {
    constructor(tag) {
      this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this.children = []; this.childNodes = []; this.parent = null;
      this.attrs = {}; this.listeners = {}; this.cls = new Set(); this.value = ''; this.selectionStart = 0; this.selectionEnd = 0; this.open = false;
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
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } setAttribute(k, v) { this.attrs[k] = String(v); }
    removeAttribute(k) { delete this.attrs[k]; } hasAttribute(k) { return k in this.attrs; }
    appendChild(n) { if (n.parent) n.remove(); n.parent = this; this.childNodes.push(n); if (n.nodeType === 1) this.children.push(n); return n; }
    remove() {
      const p = this.parent; if (!p) return;
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
    matchOne(sel) { sel = sel.trim(); if (sel === ':modal') return this === doc.modal; return sel.split(/(?=[.#])/).every(p => (p[0] === '#' ? this.id === p.slice(1) : p[0] === '.' ? this.cls.has(p.slice(1)) : this.tagName === p.toUpperCase())); }
    matches(sel) { return sel.split(',').some(s => this.matchOne(s)); }
    querySelectorAll(sel) { return [...this.walk()].filter(e => e.matches(sel)); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    closest(sel) { let n = this; while (n && n.nodeType === 1) { if (n.matches(sel)) return n; n = n.parent; } return null; }
    addEventListener(t, f, cap) { (this.listeners[t] = this.listeners[t] || []).push({ f, cap: cap === true || !!(cap && cap.capture) }); }
    removeEventListener() {}
    focus() { if (doc.activeElement === this) return; doc.activeElement = this; dispatch(this, 'focusin'); }
    getClientRects() { return [1]; }
    getBoundingClientRect() { return { left: 0, right: 0, top: 0, bottom: 0 }; }
    scrollIntoView() {}
    showModal() { this.open = true; doc.modal = this; }
    close() { this.open = false; if (doc.modal === this) doc.modal = null; }
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
  doc.addEventListener = (t, f, cap) => { const ph = cap === true || (cap && cap.capture) ? 'capture' : 'bubble'; (doc.listeners[ph][t] = doc.listeners[ph][t] || []).push({ f, cap: ph === 'capture' }); };
  doc.activeElement = doc.body;
  return { doc, El, dispatch };
}

// The page: a message draft, the dialog layer, the switcher's real functions, and the agents.
function page({ agents = [A('aide', 'Aide'), A('researcher', 'Researcher'), A('reporter', 'Reporter'), A('scout', 'Scout')], roster = 'ready', user = 'u1' } = {}) {
  const { doc, dispatch } = makeDom();
  const win = { addEventListener() {}, history: { state: null, pushState() {}, back() {} } };
  const guard = ui.createDialogGuard({ doc, win, auto: '', trackSaves: false });
  const draft = doc.createElement('textarea'); draft.id = 'input-chat-1'; doc.body.appendChild(draft);
  draft.value = 'Hello there, half a message'; draft.selectionStart = draft.selectionEnd = 5;
  const opened = [];
  const c = {
    document: doc, window: { hubMe: user ? { user: { id: user } } : null, __qsRoster: roster }, localStorage: storage(), navigator: {},
    AGENTS: agents, chats: {}, dialogGuard: guard, dialogIsModal: ui.dialogIsModal, capName: (s) => s[0].toUpperCase() + s.slice(1),
    dialogRequestClose: (el, how) => guard.requestClose(el, how || 'close'),
    startSoloChat: (name) => { opened.push(name); return 'chat-2'; }, setTimeout: (f) => f(),
  };
  vm.runInNewContext('let qsList = [], qsSel = 0; const QS_MAC = true;\n'
    + ['qsRecentStore', 'qsRecent', 'qsNoteOpened', 'qsForgetRecents', 'qsScore', 'qsRank', 'qsUnread', 'qsBlocked', 'closeQuickSwitcher',
      'openQuickSwitcher', 'renderQuickSwitcher', 'qsPaintSel', 'qsKey', 'qsOpen', 'qsShortcut'].map(fn).join('')
    + one('qsIsOpen') + one('qsRosterChanged')
    + '\nthis.api = { open: openQuickSwitcher, close: closeQuickSwitcher, isOpen: qsIsOpen, roster: qsRosterChanged, shortcut: qsShortcut };', c);
  doc.addEventListener('keydown', c.api.shortcut, true);   // as app.js wires it
  const key = (target, key, props = {}) => dispatch(target, 'keydown', { key, ...props });
  const cmdK = (props = {}) => key(doc.activeElement, 'k', { metaKey: true, ...props });
  const q = () => doc.getElementById('qs-q');
  const rows = () => (doc.getElementById('qs-list') ? doc.getElementById('qs-list').children.map(r => r.dataset.agent) : []);
  const status = () => (doc.getElementById('qs-status') ? doc.getElementById('qs-status').textContent : null);
  const type = (text) => { q().value = text; dispatch(q(), 'input'); };
  draft.focus();
  return { doc, dispatch, guard, draft, c, opened, key, cmdK, q, rows, status, type };
}

test('⌘K from a message draft: the search box gets the focus; Esc, a click outside and ⌘K again put the focus and the caret back in the draft', () => {
  for (const how of ['escape', 'backdrop', 'shortcut']) {
    const p = page();
    const e = p.cmdK();
    assert.ok(e.defaultPrevented, 'the browser\'s own ⌘K is suppressed');
    assert.ok(p.c.api.isOpen(), how);
    assert.strictEqual(p.doc.activeElement, p.q(), 'focus in the search box');
    if (how === 'escape') p.key(p.q(), 'Escape');
    if (how === 'backdrop') p.dispatch(p.doc.getElementById('qs-overlay'), 'click');
    if (how === 'shortcut') p.cmdK();
    assert.strictEqual(p.c.api.isOpen(), false, `${how} closes it`);
    assert.strictEqual(p.doc.activeElement, p.draft, `${how}: the focus is back in the draft`);
    assert.strictEqual(p.draft.selectionStart, 5, `${how}: the caret is where it was`);
    assert.strictEqual(p.draft.value, 'Hello there, half a message');
    assert.strictEqual(p.guard.layers().length, 0, `${how}: the dialog layer let go of it`);
  }
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

test('it never opens over another dialog: not over a settings overlay, not over "Discard changes?", not over a native modal; ⌘K still closes an open switcher', () => {
  // A settings overlay (a modal layer of the dialog layer)
  let p = page();
  const settings = p.doc.createElement('div'); settings.className = 'st-overlay'; p.doc.body.appendChild(settings); p.guard.open(settings);
  const e = p.cmdK();
  assert.strictEqual(p.c.api.isOpen(), false, 'over settings');
  assert.ok(e.defaultPrevented, 'the key is still swallowed');
  p.c.api.open();   // the Mac app's menu item goes through openQuickSwitcher() too
  assert.strictEqual(p.c.api.isOpen(), false, 'menu item over settings');

  // The dialog layer's "Discard changes?" question (a real one: a changed field in an overlay, then Escape)
  p = page();
  const ov = p.doc.createElement('div'); ov.className = 'gs-overlay'; p.doc.body.appendChild(ov); p.guard.open(ov);
  const field = p.doc.createElement('input'); ov.appendChild(field);
  field.focus(); field.value = 'changed'; p.dispatch(field, 'input');
  p.key(field, 'Escape');
  assert.ok(p.guard._confirm(), 'the question is up');
  p.cmdK();
  assert.strictEqual(p.c.api.isOpen(), false, 'over "Discard changes?"');
  assert.strictEqual(p.doc.querySelectorAll('.qs-overlay').length, 0, 'nothing left behind under it');

  // A native <dialog> opened with showModal()
  p = page();
  const d = p.doc.createElement('dialog'); p.doc.body.appendChild(d); d.showModal();
  p.cmdK();
  assert.strictEqual(p.c.api.isOpen(), false, 'over a modal <dialog>');

  // A docked panel leaves the page usable: the switcher opens; and its own toggle still closes it
  p = page();
  const dock = p.doc.createElement('div'); dock.className = 'gs-overlay gs-dock'; p.doc.body.appendChild(dock); p.guard.open(dock);
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

test('before the agent list arrives it says so; when it arrives the open switcher shows it, keeping what was typed', () => {
  const p = page({ agents: [], roster: null });   // loadAgents has not answered yet
  p.cmdK();
  assert.strictEqual(p.status(), 'Loading agents…');
  p.key(p.q(), 'Enter');
  assert.deepStrictEqual(p.opened, [], 'Enter does nothing while loading');
  p.type('sc');
  p.c.AGENTS.push(A('scout', 'Scout'), A('aide', 'Aide'));
  p.c.window.__qsRoster = 'ready';
  p.c.api.roster();   // loadAgents calls it
  assert.deepStrictEqual(p.rows(), ['scout']);
  assert.strictEqual(p.q().value, 'sc');
  assert.strictEqual(p.status(), '');
  p.key(p.q(), 'Enter');
  assert.deepStrictEqual(p.opened, ['scout']);

  const empty = page({ agents: [], roster: 'ready' }); empty.cmdK();
  assert.strictEqual(empty.status(), 'No agents yet.');
  const failed = page({ agents: [], roster: 'failed' }); failed.cmdK();
  assert.match(failed.status(), /^Could not load your agents/);
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
    let opened = 0, prevented = false;
    const c = { QS_MAC: mac, openQuickSwitcher: () => { opened++; } };
    vm.runInNewContext(fn('qsShortcut') + '\nthis.go = qsShortcut;', c);
    c.go({ key: 'k', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, ...ev, preventDefault: () => { prevented = true; }, stopPropagation: () => {} });
    return { opened, prevented };
  };
  assert.deepStrictEqual(run(true, { metaKey: true }), { opened: 1, prevented: true });
  assert.deepStrictEqual(run(true, { metaKey: true, key: 'K' }), { opened: 1, prevented: true }, 'Caps Lock on');
  assert.strictEqual(run(true, { ctrlKey: true }).opened, 0, 'Ctrl+K on a Mac deletes to the end of the line: left alone');
  assert.strictEqual(run(true, { metaKey: true, shiftKey: true }).opened, 0);
  assert.strictEqual(run(true, { metaKey: true, altKey: true }).opened, 0);
  assert.strictEqual(run(true, { metaKey: true, isComposing: true }).opened, 0);
  assert.strictEqual(run(true, { metaKey: true, key: 'j' }).opened, 0);
  assert.deepStrictEqual(run(false, { ctrlKey: true }), { opened: 1, prevented: true });
  assert.strictEqual(run(false, { metaKey: true }).opened, 0);
  assert.strictEqual(run(false, {}).opened, 0, 'a plain k is typing');
});

test('keys in the search box: ↓/↑ and Ctrl+N/P wrap, Enter opens, an input method composing is left alone', () => {
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
