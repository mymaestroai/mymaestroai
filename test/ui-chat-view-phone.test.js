'use strict';
// The phone's main chat view: the history is fetched per view and paged from the hub (Load earlier), hub-started live turns
// stay out of sight in the main view, ONE busy card shows while the agent works on one, a re-attach skips such a turn,
// archived entries are drawn as text, and the ⋮ menu switches the view. Functions are cut out of mobile.js and run with stubs.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const V = require('../lib/ui-chat-view');

const js = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'mobile.html'), 'utf8');
const cut = (from, to) => { const a = js.indexOf(from); assert.ok(a >= 0, from); const b = js.indexOf(to, a + from.length); assert.ok(b > a, to); return js.slice(a, b); };
const store = (v) => ({ getItem: () => v, setItem: (k, x) => { v = x; } });

// A small DOM: children in order, classList, siblings.
function mkBox() {
  const box = { children: [], appendChild(e) { const i = this.children.indexOf(e); if (i >= 0) this.children.splice(i, 1); this.children.push(e); e.parentNode = this; }, get lastElementChild() { return this.children[this.children.length - 1] || null; }, get firstElementChild() { return this.children[0] || null; } };
  return box;
}
function mkEl(box) {
  const cl = new Set();
  const el = { parentNode: null, attrs: {}, classList: { add: (c) => cl.add(c), remove: (c) => cl.delete(c), contains: (c) => cl.has(c) }, className: '', textContent: '',
    setAttribute(k, v) { this.attrs[k] = v; }, remove() { if (this.parentNode) { const c = this.parentNode.children; c.splice(c.indexOf(this), 1); this.parentNode = null; } },
    get nextElementSibling() { const c = this.parentNode && this.parentNode.children; return c ? c[c.indexOf(this) + 1] || null : null; } };
  if (box) box.appendChild(el);
  return el;
}

// ── history load and Load earlier ──
test('openChat fetches the history of the stored view with chatViewHistoryUrl and remembers next; the reread keeps to the view', () => {
  const oc = cut('async function openChat(name)', 'function attachStreamBubble(');
  assert.match(oc, /api\(chatViewHistoryUrl\(name, \{ view: viewNow\(\) \}\)\)/);
  assert.match(oc, /chatNext = d && d\.next != null \? d\.next : null;/);
  assert.doesNotMatch(oc, /api\(`\/api\/history\//, 'no bare history call any more');
  assert.match(oc, /openSeq !== chatOpenSeq\) return;/, 'a late answer of an older load is dropped');
  const rr = cut('async function rereadHistory(', 'function reasoningEnd(');
  assert.match(rr, /chatViewHistoryUrl\(agent, \{ view: viewNow\(\), limit: 50 \}\)/);
  assert.match(rr, /chatHistory = hist; chatNext = nextCursor; histGen\+\+;/);
  // the re-attach read-back keeps the bare form
  assert.match(cut('async function reattachCheck(', 'const ui = ra.text'), /api\(`\/api\/history\/\$\{encodeURIComponent\(ra\.agent\)\}`/);
  const vn = new Function('chatViewGet', 'localStorage', `${cut('function viewNow()', 'function paintViewMenu()')}; return viewNow;`)(V.chatViewGet, store('all'));
  assert.strictEqual(vn(), 'all');
  assert.strictEqual(new Function('chatViewGet', 'localStorage', `${cut('function viewNow()', 'function paintViewMenu()')}; return viewNow;`)(V.chatViewGet, store(null))(), 'main');
});

test('renderHistory draws the whole list and a "Load earlier" button only while next is not null; no local paging is left', () => {
  const rh = cut('function renderHistory()', 'function foldAutoOn()');
  assert.match(rh, /if \(chatNext != null\) \{[\s\S]*b\.textContent = 'Load earlier';[\s\S]*addEventListener\('click', loadEarlier\)/);
  assert.match(rh, /if \(!chatHistory\.length && chatNext == null\) addNote\('No messages yet'\)/);
  assert.match(rh, /paintBusyCard\(\);/, 'the redraw puts the busy card back');
  assert.doesNotMatch(js, /HISTORY_PAGE|let shown = 0|shown = Math\.min\(chatHistory/);
});

function loadEarlierHarness({ pages, current = 'forge', chatNext = 'log:100', chatHistory = [{ ts: '3', role: 'user', content: 'c' }], streams = new Map(), followed = false, fail = false }) {
  const src = cut('async function loadEarlier()', '// A stream or re-attach paints only while');
  const calls = { urls: [], render: 0, toasts: [] };
  const btn = { disabled: false, textContent: 'Load earlier', isConnected: true };
  const scroller = { scrollHeight: 1000, scrollTop: 40 };
  const api = async (url) => {
    calls.urls.push(url);
    if (fail) return { ok: false, status: 500 };
    const p = pages.shift();
    return { ok: true, json: async () => p };
  };
  const mod = new Function('api', 'viewNow', 'chatEl', '$', 'chatViewHistoryUrl', 'chatViewMergeOlder', 'renderHistory', 'toast', 'streams', 'reattaches', 'followedHubTurn',
    `let current = ${JSON.stringify(current)}, chatNext = ${JSON.stringify(chatNext)}, chatHistory = ${JSON.stringify(chatHistory)}, chatLoadingOlder = false, chatOpenSeq = 1, histGen = 0, stick = true;
     ${src}; return { loadEarlier, get: () => ({ chatNext, chatHistory, chatLoadingOlder, stick, histGen }) };`)(
    api, () => 'main', () => ({ querySelector: () => btn }), () => scroller, V.chatViewHistoryUrl, V.chatViewMergeOlder,
    () => { calls.render++; scroller.scrollHeight = 1600; }, (m) => calls.toasts.push(m), streams, new Map(), () => followed);
  return { mod, calls, btn, scroller };
}

test('Load earlier: fetches the page before next, merges it, redraws and keeps the content in place', async () => {
  const h = loadEarlierHarness({ pages: [{ history: [{ ts: '1', role: 'user', content: 'a' }, { ts: '2', role: 'assistant', content: 'b' }], next: 'log:60' }] });
  const p = h.mod.loadEarlier();
  assert.strictEqual(h.btn.textContent, 'Loading…'); assert.strictEqual(h.btn.disabled, true);
  await p;
  assert.deepStrictEqual(h.calls.urls, ['/api/history/forge?view=main&limit=40&before=log%3A100']);
  const st = h.mod.get();
  assert.deepStrictEqual(st.chatHistory.map(e => e.content), ['a', 'b', 'c']);
  assert.strictEqual(st.chatNext, 'log:60');
  assert.strictEqual(st.chatLoadingOlder, false);
  assert.strictEqual(h.calls.render, 1);
  assert.strictEqual(h.scroller.scrollTop, 40 + (1600 - 1000), 'scrolled by exactly the height that was added above');
});

test('Load earlier: an empty page with a next is asked again, at most 5 times per click', async () => {
  const empty = (n) => ({ history: [], next: `log:${n}` });
  const h = loadEarlierHarness({ pages: [empty(90), empty(80), { history: [{ ts: '1', role: 'user', content: 'a' }], next: null }] });
  await h.mod.loadEarlier();
  assert.strictEqual(h.calls.urls.length, 3);
  assert.match(h.calls.urls[1], /before=log%3A90/); assert.match(h.calls.urls[2], /before=log%3A80/);
  assert.strictEqual(h.mod.get().chatNext, null, 'nothing older: the button goes');
  const h2 = loadEarlierHarness({ pages: Array.from({ length: 9 }, (_, i) => ({ history: [], next: `log:${50 - i}` })) });
  await h2.mod.loadEarlier();
  assert.strictEqual(h2.calls.urls.length, 5, 'five asks, then it stops');
  assert.strictEqual(h2.mod.get().chatNext, 'log:46', 'and the button stays with the newest cursor');
  assert.strictEqual(h2.calls.render, 1);
});

test('Load earlier: an error is a toast and the button stays; nothing happens without next, during a stream or a followed hub turn', async () => {
  const h = loadEarlierHarness({ pages: [], fail: true });
  await h.mod.loadEarlier();
  assert.match(h.calls.toasts[0], /Could not load earlier messages: HTTP 500/);
  assert.strictEqual(h.btn.disabled, false); assert.strictEqual(h.btn.textContent, 'Load earlier');
  assert.strictEqual(h.mod.get().chatNext, 'log:100'); assert.strictEqual(h.calls.render, 0);
  const none = loadEarlierHarness({ pages: [], chatNext: null });
  await none.mod.loadEarlier(); assert.strictEqual(none.calls.urls.length, 0);
  const busy = loadEarlierHarness({ pages: [], streams: new Map([['forge', {}]]) });
  await busy.mod.loadEarlier(); assert.strictEqual(busy.calls.urls.length, 0); assert.strictEqual(busy.calls.toasts.length, 1);
  const hub = loadEarlierHarness({ pages: [], followed: true });
  await hub.mod.loadEarlier(); assert.strictEqual(hub.calls.urls.length, 0);
});

// ── the main view switch ──
test('the ⋮ menu item: chat-only, wired, label follows the view; switching stores it and reloads the open chat', () => {
  assert.match(html, /<button id="menu-agentwork" class="chat-only">[^<]*Show agent work<\/button>/);
  assert.match(js, /\$\('menu-agentwork'\)\?\.addEventListener\('click', toggleAgentWork\);\s*paintViewMenu\(\);/);
  const src = cut('function viewNow()', '// Per agent: the origin of its running turn');
  const make = (v, current, streams = new Map()) => {
    const ls = store(v); const el = { textContent: '' }; const opened = [], toasts = [];
    const f = new Function('chatViewGet', 'chatViewSet', 'localStorage', '$', 'current', 'streams', 'reattaches', 'openChat', 'toast',
      `${src}; return { toggleAgentWork, paintViewMenu };`)(V.chatViewGet, V.chatViewSet, ls, (id) => (id === 'menu' ? { classList: { remove() {} } } : el), current, streams, new Map(), (n) => opened.push(n), (m) => toasts.push(m));
    return { f, ls, el, opened, toasts };
  };
  const a = make(null, 'forge');
  a.f.paintViewMenu(); assert.match(a.el.textContent, /Show agent work/);
  a.f.toggleAgentWork();
  assert.strictEqual(a.ls.getItem(), 'all'); assert.deepStrictEqual(a.opened, ['forge']); assert.match(a.el.textContent, /Hide agent work/);
  const b = make('all', 'forge');
  b.f.toggleAgentWork(); assert.strictEqual(b.ls.getItem(), 'main'); assert.deepStrictEqual(b.opened, ['forge']);
  const c = make(null, 'forge', new Map([['forge', {}]]));   // own reply streaming: stored, read after it
  c.f.toggleAgentWork(); assert.strictEqual(c.ls.getItem(), 'all'); assert.deepStrictEqual(c.opened, []); assert.strictEqual(c.toasts.length, 1);
  const d = make(null, null);
  d.f.toggleAgentWork(); assert.strictEqual(d.ls.getItem(), 'all'); assert.deepStrictEqual(d.opened, []);
});

// ── hub-started live turns ──
function turnHarness({ view = 'main', fold = true, forOwnerPending = {} } = {}) {
  const src = cut('function onTurnStart(ev) {', 'function onTurnDelta(ev) {');
  const unhide = cut('function unhideHubTurn(', 'function onTurnStart(ev) {');
  const box = mkBox();
  const hubTurns = {}, moved = [];
  const mkCard = () => ({ wrap: mkEl(box), body: mkEl(), line: { textContent: '' } });
  const f = new Function('activeTurnStart', 'openTurns', 'hubTurns', 'setLive', 'noteTurnOrigin', 'ownTurnFor', 'chatOpenFor', 'streams', 'chatHistory', 'samePrompt', 'foldAutoOn',
    'autoKindOfOrigin', 'autoInfoOf', 'reattaches', 'promptRecent', 'cardIsLast', 'makeFoldHeader', 'chatEl', 'timeLabel', 'addNote', 'addUserBubble', 'setBubbleTime', 'msgTimeLabel',
    'addAssistantBubble', 'withRenderTarget', 'originLabel', 'forOwnerPending', 'moveReplyOut', 'catchUpOpenAgent', 'scrollChat', 'paintStatus', 'viewNow', 'chatViewIsHubOrigin',
    'autoCardKind', 'reasoningEnd', 'paintChatStatus', 'busyCardEl',
    `let lastHistoryCard = null; ${unhide}; ${src}; return { onTurnStart, unhideHubTurn };`)(
    () => {}, {}, hubTurns, () => {}, () => {}, () => false, () => true, new Map(), [], () => false, () => fold,
    () => 'consultation', () => ({ kind: 'consultation', label: 'Consultation from Forge', firstLine: 'hi' }), new Map(), () => true, () => false,
    () => mkCard(), () => box, () => 't', () => mkEl(box), () => mkEl(box), () => {}, () => 't', () => { const el = mkEl(box); return { el, body: mkEl() }; },
    (el, fn) => fn(), () => 'x', forOwnerPending, (t) => { moved.push(t); f2.unhideHubTurn(t); }, () => {}, () => {}, () => {}, () => view, V.chatViewIsHubOrigin,
    () => 'consultation', () => {}, () => {}, null);
  const f2 = f;
  return { f, box, hubTurns, moved };
}
const consult = { turnId: 'T1', agent: 'forge', origin: { kind: 'consultation', from: 'anvil' }, message: 'Question?', startedAt: '2026-11-14T10:00:00Z' };

test('main view: a live hub-started turn gets its card hidden; for_owner shows it again; the "all" view is unchanged', () => {
  const m = turnHarness();
  m.f.onTurnStart(consult);
  const t = m.hubTurns.T1;
  assert.ok(t && t.card, 'still followed, with its card');
  assert.ok(t.card.wrap.classList.contains('chat-view-hidden'), 'hidden in the main view');
  m.f.unhideHubTurn(t);   // what moveReplyOut does first
  assert.ok(!t.card.wrap.classList.contains('chat-view-hidden'));
  const all = turnHarness({ view: 'all' });
  all.f.onTurnStart(consult);
  assert.ok(!all.hubTurns.T1.card.wrap.classList.contains('chat-view-hidden'), 'nothing changes in the all view');
  // a for_owner that came first: the card shows at once
  const pend = turnHarness({ forOwnerPending: { T1: { reason: 'r', at: 1 } } });
  pend.f.onTurnStart(consult);
  assert.strictEqual(pend.moved.length, 1);
  assert.ok(!pend.hubTurns.T1.card.wrap.classList.contains('chat-view-hidden'));
  // the person's own turn from another device is never hidden
  const own = turnHarness();
  own.f.onTurnStart({ ...consult, origin: { kind: 'user' } });
  assert.ok(!own.hubTurns.T1.card.wrap.classList.contains('chat-view-hidden'));
});

test('main view, folding off: the turn\'s note and bubbles are hidden one by one and shown again on for_owner', () => {
  const m = turnHarness({ fold: false });
  const before = mkEl(m.box);
  m.f.onTurnStart(consult);
  const t = m.hubTurns.T1;
  assert.strictEqual(t.card, null);
  assert.ok(t.hiddenEls.length >= 2);
  assert.ok(t.hiddenEls.every(e => e.classList.contains('chat-view-hidden')));
  assert.ok(!before.classList.contains('chat-view-hidden'), 'what was there before stays');
  m.f.unhideHubTurn(t);
  assert.ok(t.hiddenEls.every(e => !e.classList.contains('chat-view-hidden')));
});

test('moveReplyOut and onForOwner show the hidden turn; the CSS class is display:none', () => {
  assert.match(cut('function moveReplyOut(t) {', 'function onForOwner('), /function moveReplyOut\(t\) \{\s*unhideHubTurn\(t\);/);
  assert.match(html, /\.chat-view-hidden \{ display: none !important; \}/);
  assert.match(html, /\.chat-busy-card \{[^}]*text-overflow: ellipsis[^}]*white-space: nowrap/);
  assert.match(html, /\.msg-time \.archive-mark \{/);
});

// ── the busy card ──
function busyHarness({ view = 'main', screen = 'chat', live = {}, turnOrigins = {}, openTurns = {}, own = false, now = 1e12 } = {}) {
  const src = cut('function busyCardInfo(agent)', '// A hub-started turn kept out of sight');
  const box = mkBox();
  const timers = []; const cleared = [];
  let observers = 0, observerCb = null;
  class MO { constructor(cb) { observerCb = cb; observers++; } observe() {} disconnect() { observers--; } }
  const S = { view, screen, current: 'forge', live, turnOrigins, own };
  const mod = new Function('S', 'viewNow', 'ownTurnFor', 'live', 'turnOrigins', 'openTurns', 'chatViewBusyText', 'chatViewElapsed', 'chatEl', 'scrollChat', 'document', 'setInterval', 'clearInterval', 'MutationObserver', 'Date',
    `let screen = S.screen, current = S.current; ${src}; return { busyCardInfo, paintBusyCard, set: (k, v) => { if (k === 'screen') screen = v; if (k === 'current') current = v; } };`)(
    S, () => S.view, () => S.own, live, turnOrigins, openTurns, V.chatViewBusyText, V.chatViewElapsed, () => box, () => {}, { createElement: () => mkEl() },
    (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, (id) => cleared.push(id), MO, { now: () => now, parse: Date.parse });
  return { mod, box, timers, cleared, S, observers: () => observers, fireObserver: () => observerCb && observerCb() };
}
const cards = (box) => box.children.filter(c => c.className === 'chat-busy-card');

test('busy card: shown for a hub turn from turn_start (origin) with text and elapsed, role status, last element, refreshed every 5 s', () => {
  const h = busyHarness({ live: { forge: { busy: true, busySince: '2026-11-14T10:00:00Z', activity: 'consulted by anvil' } },
    turnOrigins: { forge: { turnId: 'T1', origin: { kind: 'consultation', from: 'anvil' }, hub: true, since: 1e12 - 12000 } }, openTurns: { forge: ['T1'] } });
  mkEl(h.box); mkEl(h.box);
  h.mod.paintBusyCard();
  const c = cards(h.box);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].textContent, '⏳ Answering a consultation from Anvil · 12 s');
  assert.strictEqual(c[0].attrs.role, 'status');
  assert.strictEqual(h.box.lastElementChild, c[0]);
  assert.strictEqual(h.timers.length, 1); assert.strictEqual(h.timers[0].ms, 5000);
  // something added after it: the observer puts the card back at the bottom; a second paint never makes a second card
  mkEl(h.box);
  assert.notStrictEqual(h.box.lastElementChild, c[0]);
  h.fireObserver();
  assert.strictEqual(h.box.lastElementChild, c[0]);
  h.mod.paintBusyCard(); h.mod.paintBusyCard();
  assert.strictEqual(cards(h.box).length, 1); assert.strictEqual(h.timers.length, 1, 'one timer');
});

test('busy card: from the status feed when no turn_start was seen; not for a pending question, "replying to you", or this page\'s own turn', () => {
  const live = { forge: { busy: true, busySince: '2026-11-14T10:00:00Z', activity: 'scheduled task: nightly review' } };
  const a = busyHarness({ live, now: Date.parse('2026-11-14T10:04:30Z') });
  a.mod.paintBusyCard();
  assert.strictEqual(cards(a.box)[0].textContent, '⏳ Working on a scheduled task: nightly review · 4 min');
  const q = busyHarness({ live: { forge: { ...live.forge, pendingQuestion: true } } }); q.mod.paintBusyCard(); assert.strictEqual(cards(q.box).length, 0);
  const r = busyHarness({ live: { forge: { ...live.forge, activity: 'replying to you' } } }); r.mod.paintBusyCard(); assert.strictEqual(cards(r.box).length, 0);
  const o = busyHarness({ live, own: true }); o.mod.paintBusyCard(); assert.strictEqual(cards(o.box).length, 0, 'never for the person\'s own turn');
  const idle = busyHarness({ live: { forge: { busy: false } } }); idle.mod.paintBusyCard(); assert.strictEqual(cards(idle.box).length, 0);
  // an own turn from another device (origin user from turn_start): its activity words are not taken for a hub turn
  const user = busyHarness({ live: { forge: { busy: true, activity: 'thinking' } }, turnOrigins: { forge: { turnId: 'T9', origin: { kind: 'user' }, hub: false, since: 1 } } });
  user.mod.paintBusyCard(); assert.strictEqual(cards(user.box).length, 0);
});

test('busy card: removed at turn_end, in the all view, when the chat closes; the timer and observer go with it', () => {
  const live = { forge: { busy: true, busySince: '2026-11-14T10:00:00Z', activity: 'job finished' } };
  const turnOrigins = { forge: { turnId: 'T1', origin: { kind: 'job_notice', jobName: 'suite' }, hub: true, since: 1e12 } };
  const h = busyHarness({ live, turnOrigins, openTurns: { forge: ['T1'] } });
  h.mod.paintBusyCard();
  assert.strictEqual(cards(h.box)[0].textContent, '⏳ Reading a job result: suite · 0 s');
  assert.strictEqual(h.observers(), 1);
  // turn_end: origin forgotten, agent idle
  delete turnOrigins.forge; live.forge.busy = false;
  h.mod.paintBusyCard();
  assert.strictEqual(cards(h.box).length, 0); assert.strictEqual(h.cleared.length, 1); assert.strictEqual(h.observers(), 0);
  // all view
  const al = busyHarness({ view: 'all', live, turnOrigins: { forge: turnOrigins.forge || { turnId: 'T1', origin: { kind: 'job_notice' }, hub: true, since: 1 } } });
  live.forge.busy = true;
  al.mod.paintBusyCard(); assert.strictEqual(cards(al.box).length, 0);
  // switching to the all view while shown, then back
  const sw = busyHarness({ live, turnOrigins: { forge: { turnId: 'T1', origin: { kind: 'alert' }, hub: true, since: 1e12 } } });
  sw.mod.paintBusyCard(); assert.strictEqual(cards(sw.box).length, 1);
  sw.S.view = 'all'; sw.mod.paintBusyCard(); assert.strictEqual(cards(sw.box).length, 0);
  // the chat closes (another screen)
  const cl = busyHarness({ live, turnOrigins: { forge: { turnId: 'T1', origin: { kind: 'alert' }, hub: true, since: 1e12 } } });
  cl.mod.paintBusyCard(); assert.strictEqual(cards(cl.box).length, 1);
  cl.mod.set('screen', 'agents'); cl.mod.paintBusyCard(); assert.strictEqual(cards(cl.box).length, 0);
  // wiring in the page
  const te = cut('function onTurnEnd(ev) {', 'function plain(');
  assert.match(te, /delete turnOrigins\[ev\.agent\]/);
  assert.match(te, /paintStatus\(\);/);
  assert.match(cut('function paintChatStatus()', '// ── "Notify me when done"'), /setSendMode\(own\);\s*paintBusyCard\(\);/);
  assert.match(cut('function onTurnStart(ev) {', 'function onTurnDelta('), /noteTurnOrigin\(ev\.agent, ev\.turnId, ev\.origin, ev\.startedAt\);/);
});

test('a hub-started turn this page never followed does not draw its reply into the main chat at turn_end', () => {
  const te = cut('function onTurnEnd(ev) {', 'function plain(');
  assert.match(te, /viewNow\(\) === 'main' && chatViewIsHubOrigin\(ev\.origin\) && !forOwnerPending\[ev\.turnId\]\) \{/);
});

// ── re-attach ──
test('reattachIfIdle: a running hub-started turn gets the busy card, not a live bubble, in the main view; the all view re-attaches; own turns always do', () => {
  const busy = cut('function viewNow()', '// A hub-started turn kept out of sight');
  const follow = cut('function followedHubTurn(', '// The open chat\'s agent is mid-turn on the server and this phone has no stream');
  const ria = cut('function reattachIfIdle(', '\n}\n') + '\n}\n';
  const run = ({ view, live, origins = {} }) => {
    const entered = [];
    const fn = new Function('chatViewGet', 'localStorage', 'chatViewBusyText', 'chatViewIsHubOrigin', 'streams', 'reattaches', 'live', 'originsInit', 'openTurns', 'hubTurns', 'chatOpenFor', 'enterReattach', 'addAssistantBubble', 'chatEl', 'scrollChat', 'chatViewElapsed', 'ownTurnFor',
      `let screen = 'chat', current = 'forge'; ${busy}; Object.assign(turnOrigins, originsInit); ${follow}; ${ria}; return reattachIfIdle;`)(
      V.chatViewGet, store(view), V.chatViewBusyText, V.chatViewIsHubOrigin, new Map(), new Map(), live, origins, {}, {}, () => true, (a) => entered.push(a), () => ({}), () => mkBox(), () => {}, V.chatViewElapsed, () => false);
    fn('forge');
    return entered.length;
  };
  const hubLive = { forge: { busy: true, busySince: '2026-11-14T10:00:00Z', activity: 'consulted by anvil' } };
  assert.strictEqual(run({ view: null, live: hubLive }), 0, 'main view, hub turn (status feed): no re-attach');
  assert.strictEqual(run({ view: null, live: { forge: { ...hubLive.forge, activity: 'job finished' } }, origins: { forge: { turnId: 'T', origin: { kind: 'job_notice' }, hub: true, since: 1 } } }), 0, 'main view, hub turn (origin)');
  assert.strictEqual(run({ view: 'all', live: hubLive }), 1, 'the all view re-attaches as before');
  assert.strictEqual(run({ view: null, live: { forge: { ...hubLive.forge, activity: 'replying to you' } } }), 1, 'the person\'s own turn re-attaches');
  assert.strictEqual(run({ view: null, live: hubLive, origins: { forge: { turnId: 'T', origin: { kind: 'user' }, hub: false, since: 1 } } }), 1, 'own turn from another device re-attaches');
});

// ── archived entries ──
test('archived entries are drawn as text, with " · from the archive" after the time line', () => {
  assert.match(cut('function renderEntry(', 'function renderArchived('), /if \(m\.archived === true\) \{ renderArchived\(m, time\); return; \}/);
  const src = cut('function renderArchived(', 'function paintSaved(');   // renderArchived and markArchived
  assert.doesNotMatch(src.slice(0, src.indexOf('function markArchived')), /paintSaved|reasoningSet|activity/, 'text only: no tool panel, no reasoning');
  const painted = [];
  const mkBubble = () => ({ line: null, querySelector() { return this.line; } });
  const run = (m, time) => {
    const f = new Function('addNote', 'originLabel', 'timeLabel', 'addUserBubble', 'addAssistantBubble', 'setBubbleTime', 'document', `${src}; return renderArchived;`)(
      (t) => painted.push(['note', t]), () => 'Scheduled', () => 'T',
      (c) => { painted.push(['user', c]); return mkBubble(); }, (c) => { painted.push(['assistant', c]); return { el: mkBubble() }; },
      (el, text) => { el.line = { text, kids: [], appendChild(c) { this.kids.push(c); } }; },
      { createElement: () => ({ className: '', textContent: '' }) });
    painted.length = 0;
    let line = null;
    const orig = mkBubble;
    f(m, time);
    return painted.slice();
  };
  assert.deepStrictEqual(run({ role: 'assistant', content: 'plain **text**', activity: [{ id: 'x', kind: 'tool' }], reasoning: 'secret' }, 'Nov 1, 9:00 AM'), [['assistant', 'plain **text**']]);
  assert.deepStrictEqual(run({ role: 'user', content: 'hi', origin: { kind: 'schedule' } }, ''), [['note', '⚡ Scheduled — T'], ['user', 'hi']]);
  // the mark: appended after the time text; without a time, the mark alone
  let el, markEl;
  const f2 = new Function('setBubbleTime', 'document', `${src.slice(src.indexOf('function markArchived'))}; return markArchived;`)(
    (e, text) => { e.line = { text, kids: [], appendChild(c) { this.kids.push(c); } }; }, { createElement: () => ({ className: '', textContent: '' }) });
  el = { line: null, querySelector() { return this.line; } };
  f2(el, 'Nov 1, 9:00 AM');
  assert.strictEqual(el.line.text, 'Nov 1, 9:00 AM');
  assert.deepStrictEqual(el.line.kids.map(k => [k.className, k.textContent]), [['archive-mark', ' · from the archive']]);
  el = { line: null, querySelector() { return this.line; } };
  f2(el, '');
  assert.strictEqual(el.line.text, 'from the archive'); assert.strictEqual(el.line.kids.length, 0);
});
