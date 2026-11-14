'use strict';
// Desktop page: the main chat is the person's own conversation; the hub-started turns are the "Agent work" view.
// History is loaded per view (chatViewHistoryUrl), "Load earlier" pages backwards, a live hub-started turn is hidden in
// the main view until its reply is marked for the owner, and ONE busy card at the bottom says the agent is working.
// The page functions are cut out of app.js and run with explicit stubs.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const V = require('../lib/ui-chat-view.js');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extract(name) {
  let at = src.indexOf(`async function ${name}(`);
  if (at < 0) at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} present`);
  let p = src.indexOf('(', at); let pd = 0;
  for (; p < src.length; p++) { if (src[p] === '(') pd++; else if (src[p] === ')' && --pd === 0) break; }
  let i = src.indexOf('{', p); let depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}
const storage = (v) => ({ v, getItem() { return this.v; }, setItem(k, x) { this.v = x; } });
const chatViewLib = { chatViewGet: V.chatViewGet, chatViewSet: V.chatViewSet, chatViewHistoryUrl: V.chatViewHistoryUrl, chatViewIsHubOrigin: V.chatViewIsHubOrigin, chatViewBusyText: V.chatViewBusyText, chatViewElapsed: V.chatViewElapsed, chatViewMergeOlder: V.chatViewMergeOlder };

// a tiny DOM: elements with children, className, textContent, :scope > .class lookups
function el(cls) {
  const e = { className: cls || '', children: [], textContent: '', attrs: {}, parentNode: null,
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { if (c.parentNode) c.parentNode.children.splice(c.parentNode.children.indexOf(c), 1); c.parentNode = this; this.children.push(c); return c; },
    prepend(c) { c.parentNode = this; this.children.unshift(c); },
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; },
    get lastElementChild() { return this.children[this.children.length - 1] || null; },
    querySelector(sel) { const c = sel.replace(':scope > .', ''); return this.children.find(x => x.className.split(' ').includes(c)) || null; },
    querySelectorAll(sel) { const c = sel.replace(':scope > .', ''); return this.children.filter(x => x.className.split(' ').includes(c)); },
    addEventListener(t, f) { this.on = f; },
    classList: null };
  e.classList = { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); } };
  return e;
}

// ── history load ────────────────────────────────────────────────────────────────────────────────
function loadPage(stored, fetchImpl) {
  const urls = []; const draws = [];
  const chats = { c1: { id: 'c1', agent: 'forge' } };
  const body = `${extract('soloHistoryFetch')}\n${extract('soloHistoryLoad')}\nreturn { soloHistoryLoad };`;
  const fn = new Function('chats', 'localStorage', 'fetch', 'soloHistoryDraw', 'chatViewGet', 'chatViewHistoryUrl', body);
  const { soloHistoryLoad } = fn(chats, storage(stored), async (url) => { urls.push(url); return fetchImpl(url); }, (...a) => draws.push(a), V.chatViewGet, V.chatViewHistoryUrl);
  return { soloHistoryLoad, urls, draws, chats };
}
const ok = (data) => ({ ok: true, json: async () => data });

test('opening a chat loads the newest page of the stored view (not the bare /api/history) and remembers next', async () => {
  const main = loadPage(null, () => ok({ history: [{ ts: 't', role: 'user', content: 'hi' }], next: 'log:7' }));
  await main.soloHistoryLoad('c1');
  assert.deepStrictEqual(main.urls, ['/api/history/forge?view=main&limit=40']);
  assert.strictEqual(main.draws[0][2], 'log:7', 'the cursor goes to the drawing');
  assert.strictEqual(main.draws[0][3], 'main');
  assert.strictEqual(main.draws[0][4].reset, false, 'the first load draws into the fresh panel');
  const all = loadPage('all', () => ok({ history: [], next: null }));
  await all.soloHistoryLoad('c1');
  assert.deepStrictEqual(all.urls, ['/api/history/forge?view=all&limit=40']);
  assert.strictEqual(all.draws[0][2], null);
  assert.match(src, /chats\[chatId\]\.historyLoaded = soloHistoryLoad\(chatId\);/);
  assert.doesNotMatch(src, /historyLoaded = fetch\(`\/api\/history\/\$\{encodeURIComponent\(agentName\)\}`/, 'the bare form is gone from the opening load');
  assert.ok(src.includes('/api/history/${encodeURIComponent(chat.agent)}`, { credentials'), 're-attach read-back keeps the bare form');
});

test('a second load (a view change) resets the panel; an older answer arriving late is dropped', async () => {
  let release; const gate = new Promise(r => { release = r; });
  let n = 0;
  const t = loadPage(null, async () => { n++; if (n === 1) await gate; return ok({ history: [], next: null }); });
  const first = t.soloHistoryLoad('c1');   // slow
  t.chats.c1.viewLoaded = 'main';
  const second = t.soloHistoryLoad('c1');
  await second;
  release(); await first;
  assert.strictEqual(t.draws.length, 1, 'only the newest load draws');
  assert.strictEqual(t.draws[0][4].reset, true);
});

// ── Load earlier ──────────────────────────────────────────────────────────────────────────────────
function earlierPage(pages, { controller = null } = {}) {
  const fetched = []; const draws = []; const toasts = [];
  const panel = el('messages'); panel.scrollHeight = 1000; panel.scrollTop = 100;
  const chat = { id: 'c1', agent: 'forge', histNext: 'log:40', viewLoaded: 'main', histSeq: 1, rawHistory: [{ ts: 't9', role: 'user', content: 'newest' }], controller };
  const chats = { c1: chat };
  const painted = [];
  const body = `${extract('soloHistoryEarlier')}\nreturn soloHistoryEarlier;`;
  const fn = new Function('chats', 'hubToast', 'chatViewGet', 'localStorage', 'soloEarlierPaint', 'soloHistoryFetch', 'chatViewMergeOlder', 'soloHistoryDraw', 'document', 'userScrolledUp', body)(
    chats, (m) => toasts.push(m), V.chatViewGet, storage(null), (id) => painted.push(chat.histBusy), async (agent, view, before) => {
      fetched.push(before);
      const p = pages.shift();
      if (p instanceof Error) throw p;
      return p;
    }, V.chatViewMergeOlder, (id, list, next, view, o) => { draws.push({ list, next, view, o }); panel.scrollHeight = 1500; chat.rawHistory = list; chat.histNext = next; },
    { getElementById: () => panel }, new WeakMap());
  return { fn, fetched, draws, toasts, panel, chat, painted };
}

test('Load earlier: fetches before: next, merges in front, redraws, and keeps the content the person was looking at in place', async () => {
  const t = earlierPage([{ history: [{ ts: 't1', role: 'user', content: 'older' }], next: 'log:20' }]);
  await t.fn('c1');
  assert.deepStrictEqual(t.fetched, ['log:40']);
  assert.strictEqual(t.draws.length, 1);
  assert.deepStrictEqual(t.draws[0].list.map(e => e.content), ['older', 'newest']);
  assert.strictEqual(t.draws[0].next, 'log:20');
  assert.deepStrictEqual(t.draws[0].o, { reset: true, keepScroll: true });
  // 1000 - 100 = 900 below the viewport top before; after the redraw (1500 high) the same 900 stay below it
  assert.strictEqual(t.panel.scrollTop, 600);
  assert.strictEqual(t.chat.histBusy, false);
  assert.ok(t.painted[0] === true, 'the button said Loading… while it worked');
});

test('Load earlier: an empty page that still has a next asks again, at most 5 fetches per click', async () => {
  const empty = (next) => ({ history: [], next });
  const t = earlierPage([empty('a'), empty('b'), { history: [{ ts: 't3', role: 'user', content: 'found' }], next: null }]);
  await t.fn('c1');
  assert.deepStrictEqual(t.fetched, ['log:40', 'a', 'b']);
  assert.deepStrictEqual(t.draws[0].list.map(e => e.content), ['found', 'newest']);
  assert.strictEqual(t.draws[0].next, null);
  const t2 = earlierPage([empty('1'), empty('2'), empty('3'), empty('4'), empty('5'), empty('6')]);
  await t2.fn('c1');
  assert.strictEqual(t2.fetched.length, 5, 'stops after 5');
  assert.strictEqual(t2.draws.length, 0, 'nothing to draw');
  assert.strictEqual(t2.chat.histNext, '5', 'the next click continues from the last cursor');
});

test('Load earlier: an error is a toast and the button stays; no next, or an own stream running, does nothing', async () => {
  const t = earlierPage([new Error('HTTP 500')]);
  await t.fn('c1');
  assert.strictEqual(t.toasts.length, 1);
  assert.match(t.toasts[0], /HTTP 500/);
  assert.strictEqual(t.chat.histNext, 'log:40', 'the cursor is kept: the button stays');
  assert.strictEqual(t.chat.histBusy, false);
  const none = earlierPage([]); none.chat.histNext = null;
  await none.fn('c1');
  assert.deepStrictEqual(none.fetched, []);
  const own = earlierPage([{ history: [], next: null }], { controller: {} });
  await own.fn('c1');
  assert.deepStrictEqual(own.fetched, [], 'a redraw would wipe the live reply');
  assert.strictEqual(own.toasts.length, 1);
});

test('the Load earlier button: shown at the top while next is not null (Loading… and disabled while busy), hidden when null', () => {
  const panel = el('messages'); panel.querySelectorAll = el().querySelectorAll;
  const doc = { getElementById: () => panel };
  const chat = { histNext: 'log:3', histBusy: false };
  const paint = new Function('chats', 'document', `${extract('soloEarlierPaint')}\nreturn soloEarlierPaint;`)({ c1: chat }, { createElement: () => el(), ...doc });
  panel.appendChild(el('message'));
  paint('c1');
  assert.strictEqual(panel.children[0].className, 'chat-earlier-btn');
  assert.strictEqual(panel.children[0].textContent, 'Load earlier');
  chat.histBusy = true; paint('c1');
  assert.strictEqual(panel.children.filter(c => c.className === 'chat-earlier-btn').length, 1, 'one button');
  assert.strictEqual(panel.children[0].textContent, 'Loading…');
  assert.strictEqual(panel.children[0].disabled, true);
  chat.histNext = null; chat.histBusy = false; paint('c1');
  assert.strictEqual(panel.children.filter(c => c.className === 'chat-earlier-btn').length, 0, 'hidden when nothing is older');
});

// ── hub-started live turns in the main view ─────────────────────────────────────────────────────────
test('a hub-started live turn in the main view: its card wrapper gets chat-view-hidden; the all view is as before', () => {
  const start = src.slice(src.indexOf('async function onHubTurnStart('), src.indexOf('function onHubTurnDelta('));
  assert.match(start, /const hubMain = chatViewGet\(localStorage\) === 'main' && chatViewIsHubOrigin\(ev\.origin\);/);
  assert.match(start, /card = foldBuildCard\(panel, \{[^}]*\}\);\s*if \(hubMain\) \{ card\.wrap\.classList\.add\('chat-view-hidden'\); card\.hiddenMsgs = \[\]; \}/);
  assert.match(start, /foldAutoOn\(\) \|\| hubMain \? autoKindOfOrigin\(ev\.origin\)/, 'the card is built even with folding off: it is how the turn stays hideable');
  assert.ok(!/chat-view-hidden/.test(start.replace(/if \(hubMain\) \{ card\.wrap\.classList\.add\('chat-view-hidden'\)/, '')), 'only the hubMain branch hides');
  assert.match(html, /\.chat-view-hidden \{ display: none !important; \}/);
});

test('for_owner shows the hidden card (and its reply): hubMoveReplyOut removes chat-view-hidden', () => {
  const panel = el('messages');
  const wrap = el('auto-card chat-view-hidden'); wrap.classList.add('chat-view-hidden');
  const reply = el('message'); reply.id = 'm1'; reply.dataset = {};
  wrap.isConnected = true; wrap.dataset = {};
  panel.appendChild(wrap); wrap.children = []; wrap.after = function (x) { const s = panel.children; s.splice(s.indexOf(this) + 1, 0, x); x.parentNode = panel; };
  const um = { role: 'user', content: 'p', hidden: true };
  const card = { chatId: 'c1', msgId: 'm1', label: 'L', wrap, hiddenMsgs: [um] };
  const line = el('auto-from'); line.dataset = {}; line.after = function (x) { panel.children.splice(panel.children.indexOf(this) + 1, 0, x); x.parentNode = panel; };
  const fn = new Function('chats', 'document', 'foldFromLine', `${extract('hubMoveReplyOut')}\nreturn hubMoveReplyOut;`)(
    { c1: {} }, { getElementById: (id) => (id === 'messages-c1' ? panel : id === 'm1' ? reply : null) }, () => line);
  assert.ok(wrap.classList.contains('chat-view-hidden'));
  fn(card);
  assert.ok(!wrap.classList.contains('chat-view-hidden'), 'the card shows');
  assert.strictEqual(card.moved, true, 'and its reply moved out below it');
  assert.ok(!('hidden' in um), 'what is shown is saved by Save');
  // all view: a card that was never hidden is unchanged by the same call
  const plain = { chatId: 'c1', msgId: 'm1', label: 'L', wrap: Object.assign(el('auto-card'), { isConnected: true, dataset: {} }) };
  assert.doesNotThrow(() => fn(plain));
});

test('Save writes what is shown: messages of a still-hidden hub turn are left out', () => {
  assert.match(src, /chat\.messages\.filter\(m => !m\.hidden\)\.map\(m => `\[\$\{m\.role\.toUpperCase\(\)\}\]/);
  assert.match(src, /if \(card && card\.hiddenMsgs\) \{ um\.hidden = true; card\.hiddenMsgs\.push\(um\); \}/);
  assert.match(src, /if \(t\.card && t\.card\.hiddenMsgs\) \{ rm\.hidden = true; t\.card\.hiddenMsgs\.push\(rm\); \}/);
});

// ── the busy card ────────────────────────────────────────────────────────────────────────────────
function busyPage({ view = null, status = {}, run = {} } = {}) {
  const panel = el('messages');
  const timers = []; let now = 1000000;
  const agentStatus = status; const busyRun = run; const localBusy = new Map();
  const mk = () => new Function('document', 'agentStatus', 'busyRun', 'localBusy', 'localStorage', 'chatViewGet', 'chatViewBusyText', 'chatViewElapsed', 'autoScroll', 'setInterval', 'clearInterval', 'Date', 'chats',
    `let busyCardTimer = null;\n${extract('busyCardState')}\n${extract('busyCardRefresh')}\n${extract('busyCardRefreshAll')}\n${extract('busyCardKeepLast')}\nreturn { busyCardState, busyCardRefresh, busyCardRefreshAll, busyCardKeepLast, timer: () => busyCardTimer };`);
  const chat = { id: 'c1', agent: 'forge' };
  const FakeDate = { now: () => now, parse: Date.parse };
  const api = mk()({ getElementById: () => panel, createElement: () => el() }, agentStatus, busyRun, localBusy, storage(view), V.chatViewGet, V.chatViewBusyText, V.chatViewElapsed, () => {}, (f, ms) => { timers.push(ms); return timers.length; }, () => {}, FakeDate, { c1: chat });
  return { ...api, panel, chat, timers, advance: (ms) => { now += ms; }, status, run, localBusy, nowMs: () => now };
}
const busyCards = (p) => p.panel.children.filter(c => c.className === 'chat-busy-card');

test('busy card: a running hub-started turn (turn_start origin) shows text, elapsed time, role status; one instance, always last', () => {
  const p = busyPage({ run: { forge: { turnId: 't1', origin: { kind: 'consultation', from: 'forge2' }, since: 1000000 - 12000, own: false } } });
  p.panel.appendChild(el('message'));
  assert.strictEqual(p.busyCardRefresh(p.chat), true);
  assert.strictEqual(busyCards(p).length, 1);
  const card = busyCards(p)[0];
  assert.strictEqual(card.textContent, '⏳ Answering a consultation from Forge2 · 12 s');
  assert.strictEqual(card.attrs.role, 'status');
  p.panel.appendChild(el('message')); p.busyCardKeepLast(p.panel);
  assert.strictEqual(p.panel.lastElementChild, card, 're-appended after a later message');
  p.advance(5000); p.busyCardRefresh(p.chat); p.busyCardRefresh(p.chat);
  assert.strictEqual(busyCards(p).length, 1, 'never more than one');
  assert.strictEqual(card.textContent, '⏳ Answering a consultation from Forge2 · 17 s', 'the time moves');
  assert.deepStrictEqual(p.timers, [5000], 'one 5 s ticker while shown');
});

test('busy card: with no known turn (page opened mid-turn) the status feed decides; pending question, own stream, "replying to you" never', () => {
  const st = { forge: { busy: true, busySince: new Date(1000000 - 4 * 60000).toISOString(), activity: 'scheduled task: nightly', pendingQuestion: false } };
  const p = busyPage({ status: st });
  p.busyCardRefresh(p.chat);
  assert.strictEqual(busyCards(p)[0].textContent, '⏳ Working on a scheduled task: nightly · 4 min');
  st.forge.activity = 'replying to you'; p.busyCardRefresh(p.chat);
  assert.strictEqual(busyCards(p).length, 0, 'the person\'s own turn is never a busy card');
  st.forge.activity = 'consulted by forge2'; st.forge.pendingQuestion = true; p.busyCardRefresh(p.chat);
  assert.strictEqual(busyCards(p).length, 0, 'a pending question is not busy work');
  st.forge.pendingQuestion = false; p.chat.controller = {}; p.busyCardRefresh(p.chat);
  assert.strictEqual(busyCards(p).length, 0, 'this page\'s own stream');
  p.chat.controller = null; p.localBusy.set('forge', 'x'); p.busyCardRefresh(p.chat);
  assert.strictEqual(busyCards(p).length, 0, 'this page is streaming a reply for the agent');
});

test('busy card: never for an own turn (turn_start origin user), removed when the turn ends and in the all view', () => {
  const run = { forge: { turnId: 't1', origin: { kind: 'user' }, since: 1, own: true } };
  const p = busyPage({ run, status: { forge: { busy: true, busySince: null, activity: 'working' } } });
  p.busyCardRefresh(p.chat);
  assert.strictEqual(busyCards(p).length, 0, 'own turn: the live reply streams as today');
  delete run.forge;
  run.forge = { turnId: 't2', origin: { kind: 'schedule', label: 'nightly' }, since: 1000000, own: false };
  p.busyCardRefresh(p.chat);
  assert.strictEqual(busyCards(p).length, 1);
  delete run.forge; p.status.forge.busy = false;   // turn_end: the page forgets the turn and the agent is idle
  p.busyCardRefresh(p.chat);
  assert.strictEqual(busyCards(p).length, 0, 'removed at turn_end');
  const all = busyPage({ view: 'all', run: { forge: { turnId: 't', origin: { kind: 'consultation', from: 'x' }, since: 1, own: false } } });
  assert.strictEqual(all.busyCardRefresh(all.chat), false);
  assert.strictEqual(busyCards(all).length, 0, 'no card in the all view');
  // the ticker stops by itself when nothing is shown
  p.busyCardRefreshAll();
  assert.strictEqual(p.timer(), null);
});

test('busy card: wired to turn_start (origin kept per agent), turn_end (cleared), the status feed, and the list\'s appenders', () => {
  const start = src.slice(src.indexOf('async function onHubTurnStart('), src.indexOf('function onHubTurnDelta('));
  assert.match(start, /busyRun\[ev\.agent\] = \{ turnId: ev\.turnId, origin: ev\.origin, since: Date\.parse\(ev\.startedAt\) \|\| Date\.now\(\), own: !chatViewIsHubOrigin\(ev\.origin\) \};/);
  assert.match(start, /busyCardKeepLast\([^)]*\)\);\s*busyCardRefresh\(chat\);/);
  const end = src.slice(src.indexOf('function onHubTurnEnd('), src.indexOf('Context compression'));
  assert.match(end, /delete busyRun\[ev\.agent\];\s*\{ const c = findSoloChat\(ev\.agent\); if \(c\) busyCardRefresh\(c\); \}/);
  assert.match(extract('setAgentLive'), /busyCardRefresh\(c\)/);
  assert.match(extract('appendMessage'), /busyCardKeepLast\(container\)/);
  assert.match(extract('appendSystemNotice'), /busyCardKeepLast\(container\)/);
  assert.match(extract('closeChat'), /panel-\$\{chatId\}|\.remove\(\)/, 'the panel (and its card) goes with the chat');
});

// ── re-attach ────────────────────────────────────────────────────────────────────────────────────
function reattachPage(view, status) {
  const calls = [];
  const chat = { id: 'c1', agent: 'forge', historyLoaded: Promise.resolve(), inProgress: null };
  const chats = { c1: chat };
  const agentStatus = { forge: status };
  const body = `${extract('reattachIfIdle')}\nreturn reattachIfIdle;`;
  const busyCardState = (c) => (view === 'all' ? null : (status.activity !== 'replying to you' ? { text: 'x', since: 1 } : null));
  const fn = new Function('findSoloChat', 'hubTurns', 'chats', 'agentStatus', 'busyCardState', 'busyCardRefresh', 'appendMessage', 'enterReattach', body)(
    () => chat, {}, chats, agentStatus, busyCardState, () => calls.push('card'), () => 'msg1', () => calls.push('reattach'));
  return { fn, calls };
}
test('reattachIfIdle: main view skips a running hub-started turn (busy card instead); own turns and the all view re-attach', async () => {
  const hub = reattachPage('main', { busy: true, activity: 'consulted by forge2' });
  await hub.fn('forge', null);
  assert.deepStrictEqual(hub.calls, ['card']);
  const own = reattachPage('main', { busy: true, activity: 'replying to you' });
  await own.fn('forge', null);
  assert.deepStrictEqual(own.calls, ['reattach']);
  const all = reattachPage('all', { busy: true, activity: 'consulted by forge2' });
  await all.fn('forge', null);
  assert.deepStrictEqual(all.calls, ['reattach']);
  assert.match(extract('reattachIfIdle'), /if \(busyCardState\(chat\)\) \{ busyCardRefresh\(chat\); return; \}/);
});

// ── the toggle ───────────────────────────────────────────────────────────────────────────────────
test('the Agent work toggle stores the view, repaints the button (aria-pressed) and reloads the open chat in the new view', () => {
  const store = storage(null);
  const btn = { textContent: 'Agent work', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const reloads = [];
  const chats = { c1: { id: 'c1', agent: 'a', viewLoaded: 'main' }, c2: { id: 'c2', agent: 'b', viewLoaded: 'main' }, g: { id: 'g', isGroup: true } };
  const body = `${extract('soloViewToggle')}\n${extract('soloViewReload')}\n${extract('soloViewPaint')}\nreturn { soloViewToggle };`;
  const { soloViewToggle } = new Function('chatViewGet', 'chatViewSet', 'localStorage', 'document', 'chats', 'activeChat', 'soloHistoryLoad', 'busyCardRefresh', body)(
    V.chatViewGet, V.chatViewSet, store, { querySelectorAll: () => [btn] }, chats, 'c1', (id) => { reloads.push(id); return Promise.resolve(); }, () => {});
  assert.strictEqual(soloViewToggle(), 'all');
  assert.strictEqual(store.v, 'all', 'stored');
  assert.strictEqual(btn.textContent, 'Agent work ✓');
  assert.strictEqual(btn.attrs['aria-pressed'], 'true');
  assert.deepStrictEqual(reloads, ['c1'], 'the visible chat reloads now; the other when it comes to the front');
  assert.strictEqual(soloViewToggle(), 'main');
  assert.strictEqual(btn.textContent, 'Agent work');
  assert.strictEqual(btn.attrs['aria-pressed'], 'false');
  // lazy reload of a chat that was behind
  assert.match(src, /opened\.viewLoaded !== undefined\) soloViewReload\(opened\);/);
});

test('toolbar markup and CSS: the button sits next to Recall; archived entries are marked; styles exist', () => {
  const tb = src.slice(src.indexOf('id="recall-btn-${chatId}"'));
  assert.match(tb.slice(0, 700), /id="view-btn-\$\{chatId\}"[^>]*aria-pressed="false"[^>]*title="Show the turns the hub started \(consultations, scheduled tasks, job notices\)">Agent work<\/button>/);
  assert.match(src, /soloViewPaint\(\);\s*\/\/ the "Agent work" toggle/);
  assert.match(src, /\$\{times\[i\]\} · from the archive/);
  assert.match(src, /classList\.add\('msg-archived'\)/);
  assert.match(html, /\.chat-busy-card \{[^}]*text-overflow: ellipsis/);
  assert.match(html, /\.msg-archived > \.msg-time/);
  assert.match(html, /\.chat-earlier-btn \{/);
});
