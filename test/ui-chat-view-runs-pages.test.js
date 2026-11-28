'use strict';
// The run line on the pages: a hidden_run entry of a main-view page is ONE quiet line (a button) in place, not a bubble;
// a click fetches view=run and draws the turns as the Agent work view does; Load earlier counts a page of summaries as
// loaded; a live hub-started turn bumps a line at the end of the chat. Functions are cut out of app.js / mobile.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const V = require('../lib/ui-chat-view');
const A = require('../lib/ui-auto-turns');
const T = require('../lib/ui-msg-time');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const mob = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
const cutOf = (src) => (from, to) => { const a = src.indexOf(from); assert.ok(a >= 0, from); const b = src.indexOf(to, a + from.length); assert.ok(b > a, to); return src.slice(a, b); };
const cutApp = cutOf(app), cutMob = cutOf(mob);

// ── a small DOM ──
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.parentNode = null; this.attrs = {}; this.className = ''; this._text = ''; this.hidden = false; this.handlers = {}; this.dataset = {}; this.title = ''; }
  get classList() { const s = this; return { contains: (c) => s.className.split(/\s+/).includes(c), add: (c) => { if (!s.classList.contains(c)) s.className = `${s.className} ${c}`.trim(); } }; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = this; this.children.push(c); return c; }
  append(...n) { n.forEach((x) => this.appendChild(x)); }
  remove() { if (this.parentNode) { const c = this.parentNode.children; c.splice(c.indexOf(this), 1); this.parentNode = null; } }
  set textContent(v) { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  addEventListener(t, f) { (this.handlers[t] = this.handlers[t] || []).push(f); }
  async click() { for (const h of this.handlers.click || []) await h(); }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  get previousElementSibling() { const c = this.parentNode && this.parentNode.children; return c ? c[c.indexOf(this) - 1] || null : null; }
  all(cls) { const out = []; const walk = (e) => { for (const c of e.children) { if (c.classList.contains(cls)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelectorAll(sel) { const m = /^:scope > \.(\S+)$/.exec(sel); if (m) return this.children.filter((c) => c.classList.contains(m[1])); return this.all(sel.replace(/^\./, '')); }
}
const doc = () => ({ createElement: (t) => new El(t) });

const RUN = { role: 'hidden_run', ts: '2026-11-24T08:09:00.000Z', last_ts: '2026-11-24T08:17:00.000Z', turns: 2, kinds: [{ kind: 'consultation', from: 'Beacon', n: 2 }], content: '' };
const TURNS = [
  { ts: '2026-11-24T08:09:00.000Z', role: 'user', content: '[Consultation from agent "Beacon"] question one', origin: { kind: 'consultation', from: 'Beacon' } },
  { ts: '2026-11-24T08:09:30.000Z', role: 'assistant', content: 'answer one' },
  { ts: '2026-11-24T08:17:00.000Z', role: 'user', content: '[Consultation from agent "Beacon"] question two', origin: { kind: 'consultation', from: 'Beacon' } },
  { ts: '2026-11-24T08:17:30.000Z', role: 'assistant', content: 'answer two' },
];
const answer = (body, ok = true) => async () => ({ ok, status: ok ? 200 : 500, json: async () => body });

// ── desktop ──
function deskHarness({ fetchImpl, simple = false } = {}) {
  const src = [cutApp('function foldCardTime(', 'function foldFromLine('), cutApp('function foldFromLine(', '// A history card (draw:'),
    cutApp('function foldRenderHistoryCard(', '// The card\'s line once its reply left it'), cutApp('function foldRenderHistoryStack(', 'const hubTurns = {}'),
    cutApp('function soloRunTime(', '// "Load earlier": a button at the top')].join('\n');
  const panel = new El('div'); panel.className = 'messages';
  const doc2 = { createElement: (t) => new El(t), getElementById: () => panel };
  const pushed = [], fetched = [], toggled = { n: 0 };
  const chat = { id: 'c1', agent: 'scout', messages: [{ role: 'system' }] };
  chat.makeDraw = (list, times, pushDefault) => (i, o = {}) => {
    const m = new El('div'); m.className = `message ${list[i].role}`; m.textContent = list[i].content;
    ((o && o.into) || panel).appendChild(m); pushed.push(pushDefault);
    return `m${i}`;
  };
  const chats = { c1: chat };
  const f = new Function('document', 'chats', 'fetch', 'chatViewRunText', 'chatViewRunParts', 'chatViewRunUrl', 'chatViewRunKey', 'chatViewRunOpenKey', 'chatViewRunKindOf', 'chatViewRunAdd', 'autoGroupHistory', 'autoCardKind', 'msgTimeLines', 'simpleOn', 'soloViewToggle',
    `${src}; return { soloRunLine, soloRunLive, soloRunTime };`)(
    doc2, chats, (url, o) => { fetched.push(url); return fetchImpl(url, o); }, V.chatViewRunText, V.chatViewRunParts, V.chatViewRunUrl, V.chatViewRunKey, V.chatViewRunOpenKey, V.chatViewRunKindOf, V.chatViewRunAdd, A.autoGroupHistory, A.autoCardKind, T.msgTimeLines, () => simple, () => { toggled.n++; });
  return { f, panel, chat, fetched, pushed, toggled };
}

test('desktop: a hidden_run entry is one quiet line, a real button with aria-expanded, text from chatViewRunText, no bubble and nothing in chat.messages', () => {
  const h = deskHarness({ fetchImpl: answer({ history: [] }) });
  const wrap = h.f.soloRunLine('c1', RUN, null);
  assert.strictEqual(h.panel.children.length, 1);
  const line = wrap.children[0];
  assert.strictEqual(line.tag, 'button'); assert.strictEqual(line.type, 'button'); assert.ok(line.classList.contains('run-line'));
  assert.strictEqual(line.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(wrap.children[1].hidden, true, 'the body is closed');
  assert.match(line.textContent, /^▸2 consultations from Beacon · /);
  assert.strictEqual(line.title, V.chatViewRunText(RUN, h.f.soloRunTime), 'the full text is in the title');
  assert.ok(!wrap.classList.contains('message'));
  assert.deepStrictEqual(h.chat.messages, [{ role: 'system' }]);
});

test('desktop: the line is a one-row line with an ellipsis (CSS) and the draw skips it in messages and times', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /\.run-kinds \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap/);
  assert.match(html, /\.run-line \{[^}]*display: flex/);
  assert.match(html, /html\.mm-simple \.run-line/);
  const draw = cutApp('const makeDraw = (history, times, pushDefault) =>', 'const draw = makeDraw(history, times, true)');
  assert.ok(draw.indexOf("msg.role === 'hidden_run'") > 0 && draw.indexOf("msg.role === 'hidden_run'") < draw.indexOf('messages.push('), 'the run line returns before anything is pushed');
  assert.match(cutApp('function soloHistoryDraw(', 'function soloRunTime('), /m\.role === 'hidden_run'\)\)\.length/, 'a line is not one of the "Restored N messages"');
});

test('desktop: Enter/Space/click fetches view=run for the run, says Loading… meanwhile, then draws the turns as cards; closing keeps them', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const h = deskHarness({ fetchImpl: async () => { await gate; return { ok: true, json: async () => ({ history: TURNS }) }; } });
  const wrap = h.f.soloRunLine('c1', RUN, null);
  const line = wrap.children[0], body = wrap.children[1];
  const p = line.click();
  assert.match(line.textContent, /Loading…/);
  assert.strictEqual(line.getAttribute('aria-busy'), 'true');
  release(); await p;
  assert.deepStrictEqual(h.fetched, ['/api/history/scout?view=run&from=2026-11-24T08%3A09%3A00.000Z&to=2026-11-24T08%3A17%3A00.000Z']);
  assert.strictEqual(line.getAttribute('aria-expanded'), 'true'); assert.strictEqual(body.hidden, false);
  assert.match(line.textContent, /^▾2 consultations from Beacon/);
  const cards = body.all('auto-card');
  assert.strictEqual(cards.length, 2, 'two consultations: two cards of the Agent work view (a stack only from three)');
  assert.ok(cards[0].classList.contains('auto-card-consult'));
  assert.strictEqual(cards[0].children[0].tag, 'button', 'a card head is a button that opens the full exchange');
  assert.strictEqual(cards[0].children[1].all('message').length, 2, 'the whole exchange (question and answer) is in the card body');
  assert.ok(h.pushed.every((x) => x === false), 'nothing fetched is pushed into chat.messages');
  await line.click();   // close: hides, keeps the entries
  assert.strictEqual(body.hidden, true); assert.strictEqual(line.getAttribute('aria-expanded'), 'false');
  await line.click();   // open again: no second fetch
  assert.strictEqual(h.fetched.length, 1); assert.strictEqual(body.hidden, false);
});

test('desktop: three or more consecutive turns in a run open as separate cards, never one stack (r2 R4)', async () => {
  const many = [];
  for (let i = 0; i < 3; i++) many.push({ ts: `2026-11-24T08:0${i}:00.000Z`, role: 'user', content: `[Consultation from agent "Beacon"] q${i}`, origin: { kind: 'consultation', from: 'Beacon' } }, { ts: `2026-11-24T08:0${i}:30.000Z`, role: 'assistant', content: `a${i}` });
  const h = deskHarness({ fetchImpl: answer({ history: many }) });
  const wrap = h.f.soloRunLine('c1', RUN, null);
  await wrap.children[0].click();
  assert.strictEqual(wrap.children[1].all('auto-stack').length, 0);
  assert.strictEqual(wrap.children[1].all('auto-card').length, 3);
});

test('desktop: more:true ends the body with the cap line; a failed fetch says so, stays collapsed and can be tried again', async () => {
  const h = deskHarness({ fetchImpl: answer({ history: TURNS, more: true }) });
  const w = h.f.soloRunLine('c1', { ...RUN, turns: 111 }, null);
  await w.children[0].click();
  assert.strictEqual(w.children[1].all('run-more')[0].textContent, 'Showing 2 of 111 turns. Switch on Agent work to see them all.');
  let n = 0;
  const g = deskHarness({ fetchImpl: async () => (++n === 1 ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, json: async () => ({ history: TURNS }) }) });
  const w2 = g.f.soloRunLine('c1', RUN, null);
  const line = w2.children[0];
  await line.click();
  assert.strictEqual(line.getAttribute('aria-expanded'), 'false'); assert.strictEqual(w2.children[1].hidden, true);
  assert.strictEqual(w2.all('run-error')[0].textContent, "Couldn't load these turns. Try again.");
  assert.match(line.textContent, /2 consultations from Beacon/, 'the line words come back');
  await line.click();
  assert.strictEqual(w2.all('run-error').length, 0); assert.strictEqual(line.getAttribute('aria-expanded'), 'true');
});

test('desktop: the open state and the fetched turns are kept per chat by the run\'s ts: a redraw draws the line open, with no new fetch', async () => {
  const h = deskHarness({ fetchImpl: answer({ history: TURNS }) });
  const first = h.f.soloRunLine('c1', RUN, null);
  await first.children[0].click();
  h.panel.textContent = '';   // Load earlier redraws the whole panel
  const again = h.f.soloRunLine('c1', { ...RUN }, null);
  assert.strictEqual(again.children[0].getAttribute('aria-expanded'), 'true');
  assert.strictEqual(again.children[1].hidden, false);
  assert.strictEqual(again.children[1].all('auto-card').length, 2);
  assert.strictEqual(h.fetched.length, 1);
  assert.ok(!/localStorage|sessionStorage/.test(cutApp('function soloRunTime(', '// "Load earlier": a button at the top')), 'never stored');
});

test('desktop: a live hub-started turn makes a line at the end of the chat, and a second one extends it (a hidden card and the busy card do not count)', () => {
  const h = deskHarness({ fetchImpl: answer({ history: [] }) });
  const a = h.f.soloRunLive(h.chat, { kind: 'consultation', from: 'Beacon' }, '2026-11-24T08:21:00.000Z');
  assert.match(a.children[0].textContent, /^▸1 consultation from Beacon · /);
  const card = new El('div'); card.className = 'auto-card chat-view-hidden'; h.panel.appendChild(card);
  const busy = new El('div'); busy.className = 'chat-busy-card'; h.panel.appendChild(busy);
  const b = h.f.soloRunLive(h.chat, { kind: 'consultation', from: 'Beacon' }, '2026-11-24T08:25:00.000Z');
  assert.strictEqual(b, a, 'the same line');
  assert.match(a.children[0].textContent, /^▸2 consultations from Beacon · /);
  assert.strictEqual(h.panel.all('run-wrap').length, 1);
  const msg = new El('div'); msg.className = 'message assistant'; h.panel.appendChild(msg);
  const c = h.f.soloRunLive(h.chat, { kind: 'schedule' }, '2026-11-24T08:40:00.000Z');
  assert.notStrictEqual(c, a, 'something else is last: a new line');
  assert.match(c.children[0].textContent, /^▸1 scheduled task · /);
});

test('desktop: onHubTurnStart counts the turn in a live line only in the main view and only when history did not already hold it', () => {
  const start = cutApp('async function onHubTurnStart(', 'function onHubTurnDelta(');
  assert.match(start, /if \(hubMain && !dup\) soloRunLive\(chat, ev\.origin, ev\.startedAt, ev\.turnId\);/);
  assert.match(start, /card\.wrap\.classList\.add\('chat-view-hidden'\)/, 'the card stays hidden as before');
  assert.match(start, /um\.hidden = true/);
});

test('desktop: Load earlier merges runs, and a page of only summaries counts as loaded (one fetch, no looping)', async () => {
  const body = `${cutApp('async function soloHistoryCurrent(', '// After a hub-started turn this page did not follow')}\n${cutApp('async function soloHistoryEarlier(', '// The toolbar toggle')}\nreturn soloHistoryEarlier;`;
  const olderRun = { ...RUN, ts: '2026-11-24T06:00:00.000Z', last_ts: '2026-11-24T06:30:00.000Z', turns: 1, kinds: [{ kind: 'consultation', from: 'Beacon', n: 1 }] };
  const newRun = { ...RUN, ts: '2026-11-24T06:40:00.000Z', last_ts: '2026-11-24T07:00:00.000Z', turns: 3, kinds: [{ kind: 'consultation', from: 'Beacon', n: 3 }] };
  const own = { ts: '2026-11-24T09:00:00.000Z', role: 'user', content: 'hello' };
  const panel = { scrollHeight: 1000, scrollTop: 100 };
  const chat = { id: 'c1', agent: 'scout', histNext: 'log:40', viewLoaded: 'main', histSeq: 1, rawHistory: [newRun, own] };
  const fetched = [], draws = [];
  const fn = new Function('chats', 'hubToast', 'chatViewGet', 'localStorage', 'soloEarlierPaint', 'soloHistoryFetch', 'chatViewMergeOlder', 'chatViewMergeRuns', 'soloHistoryDraw', 'document', 'userScrolledUp', 'hubTurns', body)(
    { c1: chat }, () => {}, V.chatViewGet, { getItem: () => null }, () => {}, async (agent, view, before) => {
      if (before === null) return { history: [newRun, own], next: 'x' };
      fetched.push(before); return { history: [olderRun], next: 'log:20' };   // a page of only a summary, with more behind it
    }, V.chatViewMergeOlder, V.chatViewMergeRuns, (id, list, next) => { draws.push({ list, next }); }, { getElementById: () => panel }, new WeakMap(), {});
  await fn('c1');
  assert.strictEqual(fetched.length, 1, 'a summary-only page is a loaded page: no second fetch');
  assert.strictEqual(draws.length, 1);
  assert.deepStrictEqual(draws[0].list.map((e) => e.role), ['hidden_run', 'user'], 'two adjacent runs are one line');
  assert.strictEqual(draws[0].list[0].turns, 4); assert.strictEqual(draws[0].list[0].ts, olderRun.ts); assert.strictEqual(draws[0].list[0].last_ts, newRun.last_ts);
  assert.strictEqual(draws[0].next, 'log:20');
});

// ── phone ──
function phoneHarness({ fetchImpl, simple = false } = {}) {
  const src = [cutMob('let renderTarget = null;', 'function scrollChat('), cutMob('function makeFoldHeader(', 'function addFromLine('), cutMob('function addFromLine(', '// The card\'s line once its reply left it'),
    cutMob('// One automatic turn as a closed card;', '// The page before what is loaded')].join('\n');
  const box = new El('div');
  const doc2 = { createElement: (t) => new El(t) };
  const urls = [], toggled = { n: 0 };
  const f = new Function('document', 'chatEl', 'api', 'chatViewRunText', 'chatViewRunParts', 'chatViewRunUrl', 'chatViewRunKey', 'chatViewRunOpenKey', 'chatViewRunKindOf', 'chatViewRunAdd', 'autoGroupHistory', 'autoCardKind', 'msgTimeLines', 'simpleOn', 'timeLabel', 'renderEntryImpl', 'busyCard', 'toggleAgentWork',
    `let current = 'scout', lastHistoryCard = null, chatHistory = []; const busyCardEl = busyCard; function renderEntry(m, t) { renderEntryImpl(m, t, bubbleHost()); }
     ${src}; return { renderRunLine, runLive, renderAutoCard, renderAutoStack, get: () => ({ lastHistoryCard }) };`)(
    doc2, () => box, (url) => { urls.push(url); return fetchImpl(url); }, V.chatViewRunText, V.chatViewRunParts, V.chatViewRunUrl, V.chatViewRunKey, V.chatViewRunOpenKey, V.chatViewRunKindOf, V.chatViewRunAdd, A.autoGroupHistory, A.autoCardKind, T.msgTimeLines, () => simple, () => 't',
    (m, t, host) => { if (m.role === 'hidden_run') throw new Error('nested'); const e = new El('div'); e.className = `msg ${m.role}`; e.textContent = m.content; host.appendChild(e); }, null, () => { toggled.n++; });
  return { f, box, urls, toggled };
}

test('phone: a hidden_run entry is one quiet line, a real button with aria-expanded, a 36 px tap area, no bubble', () => {
  const h = phoneHarness({ fetchImpl: answer({ history: [] }) });
  const wrap = h.f.renderRunLine(RUN, h.box);
  const line = wrap.children[0];
  assert.strictEqual(line.tag, 'button'); assert.ok(line.classList.contains('run-line')); assert.strictEqual(line.getAttribute('aria-expanded'), 'false');
  assert.match(line.textContent, /^▸2 consultations from Beacon · /);
  assert.strictEqual(line.title, line.children[1].textContent + line.children[2].textContent);
  assert.ok(!wrap.classList.contains('msg'));
  const html = fs.readFileSync(path.join(__dirname, '..', 'mobile.html'), 'utf8');
  assert.match(html, /\.run-line \{[^}]*min-height: 36px/);
  assert.match(html, /\.run-kinds \{[^}]*text-overflow: ellipsis/);
  assert.match(html, /html\.mm-simple \.run-line/);
  assert.match(cutMob('function renderEntry(m, time', 'if (m.archived === true)'), /m\.role === 'hidden_run'\) \{ renderRunLine\(m\); return; \}/, 'renderEntry paints a run in place');
});

test('phone: tapping fetches view=run, says Loading… meanwhile, then draws the same cards the Agent work view draws; the cap line; a failure stays collapsed', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const h = phoneHarness({ fetchImpl: async () => { await gate; return { ok: true, json: async () => ({ history: TURNS, more: true }) }; } });
  const wrap = h.f.renderRunLine({ ...RUN, turns: 111 }, h.box);
  const line = wrap.children[0], body = wrap.children[1];
  const p = line.click();
  assert.match(line.textContent, /Loading…/);
  release(); await p;
  assert.deepStrictEqual(h.urls, ['/api/history/scout?view=run&from=2026-11-24T08%3A09%3A00.000Z&to=2026-11-24T08%3A17%3A00.000Z']);
  assert.strictEqual(line.getAttribute('aria-expanded'), 'true'); assert.strictEqual(body.hidden, false);
  const cards = body.all('auto-card');
  assert.strictEqual(cards.length, 2); assert.ok(cards[0].classList.contains('auto-card-consult'));
  assert.strictEqual(cards[0].tag, 'button', 'the card head is a button that opens the exchange');
  assert.strictEqual(cards[0].parentNode.children[1].all('msg').length, 2, 'the whole exchange is in the card body');
  assert.strictEqual(h.f.get().lastHistoryCard, null, 'a run\'s cards are never adopted as the chat\'s last card');
  assert.strictEqual(body.all('run-more')[0].textContent, 'Showing 2 of 111 turns. Switch on Agent work to see them all.');
  await line.click(); assert.strictEqual(body.hidden, true);
  await line.click(); assert.strictEqual(h.urls.length, 1, 'closed and opened again: the entries were kept');
  let n = 0;
  const g = phoneHarness({ fetchImpl: async () => (++n === 1 ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, json: async () => ({ history: TURNS }) }) });
  const w2 = g.f.renderRunLine({ ...RUN, ts: '2026-11-24T05:00:00.000Z' }, g.box);
  await w2.children[0].click();
  assert.strictEqual(w2.children[0].getAttribute('aria-expanded'), 'false');
  assert.strictEqual(w2.all('run-error')[0].textContent, "Couldn't load these turns. Try again.");
  await w2.children[0].click();
  assert.strictEqual(w2.children[0].getAttribute('aria-expanded'), 'true');
});

test('phone: a live hub-started turn makes a line at the end of the chat and a second one extends it', () => {
  const h = phoneHarness({ fetchImpl: answer({ history: [] }) });
  const a = h.f.runLive({ origin: { kind: 'hand_off', from: 'Maestro' }, startedAt: '2026-11-24T08:21:00.000Z' });
  assert.match(a.children[0].textContent, /^▸1 task from Maestro · /);
  const hidden = new El('div'); hidden.className = 'auto-wrap chat-view-hidden'; h.box.appendChild(hidden);
  const b = h.f.runLive({ origin: { kind: 'hand_off', from: 'Maestro' }, startedAt: '2026-11-24T08:30:00.000Z' });
  assert.strictEqual(b, a);
  assert.match(a.children[0].textContent, /^▸2 tasks from Maestro · /);
  const t = cutMob('function onTurnStart(ev) {', 'function onTurnDelta(ev) {');
  assert.match(t, /if \(hiddenFromMain && !dup\) runLive\(ev\);/);
});

test('phone: renderHistory draws a run in its place and Load earlier takes a summary-only page as loaded', async () => {
  const rh = cutMob('function renderHistory()', 'function foldAutoOn()');
  const box = new El('div'); const drawn = [];
  const run = (history, fold) => new Function('chatEl', 'chatNext', 'chatHistory', 'msgTimeLines', 'foldAutoOn', 'autoGroupHistory', 'renderEntry', 'renderAutoCard', 'renderAutoStack', 'addNote', 'simpleEmptyPaint', 'paintBusyCard', 'loadEarlier', 'lastHistoryCard',
    `${rh}; renderHistory();`)(() => box, null, history, T.msgTimeLines, () => fold, A.autoGroupHistory, (m) => drawn.push(m.role), () => {}, () => {}, () => {}, undefined, () => {}, () => {}, null);
  run([RUN, { ts: '2026-11-24T09:00:00.000Z', role: 'user', content: 'hi' }], true);
  assert.deepStrictEqual(drawn, ['hidden_run', 'user'], 'in its place, in the fold loop');
  drawn.length = 0; run([RUN, { ts: '2026-11-24T09:00:00.000Z', role: 'user', content: 'hi' }], false);
  assert.deepStrictEqual(drawn, ['hidden_run', 'user'], 'and in the flat loop');
  // loadEarlier: a page that holds only a summary is a loaded page (one request), and it merges with the run next to it
  const src = cutMob('async function loadEarlier()', '// A stream or re-attach paints only while');
  const urls = []; let rendered = 0;
  const older = { ...RUN, ts: '2026-11-24T06:00:00.000Z', last_ts: '2026-11-24T06:30:00.000Z', turns: 1, kinds: [{ kind: 'consultation', from: 'Beacon', n: 1 }] };
  const mod = new Function('api', 'viewNow', 'chatEl', '$', 'chatViewHistoryUrl', 'chatViewMergeOlder', 'chatViewMergeRuns', 'renderHistory', 'toast', 'streams', 'reattaches', 'followedHubTurn',
    `let current = 'scout', chatNext = 'log:100', chatHistory = ${JSON.stringify([{ ...RUN, ts: '2026-11-24T06:40:00.000Z', last_ts: '2026-11-24T07:00:00.000Z', turns: 3, kinds: [{ kind: 'consultation', from: 'Beacon', n: 3 }] }, { ts: '2026-11-24T09:00:00.000Z', role: 'user', content: 'hi' }])}, chatLoadingOlder = false, chatOpenSeq = 1, histGen = 0, stick = true;
     ${src}; return { loadEarlier, get: () => ({ chatNext, chatHistory }) };`)(
    async (u) => { urls.push(u); return { ok: true, json: async () => ({ history: [older], next: 'log:20' }) }; }, () => 'main', () => ({ querySelector: () => ({ disabled: false, textContent: '', isConnected: true }) }), () => ({ scrollHeight: 1, scrollTop: 0 }),
    V.chatViewHistoryUrl, V.chatViewMergeOlder, V.chatViewMergeRuns, () => { rendered++; }, () => {}, new Map(), new Map(), () => false);
  await mod.loadEarlier();
  assert.strictEqual(urls.length, 1); assert.strictEqual(rendered, 1);
  const st = mod.get();
  assert.deepStrictEqual(st.chatHistory.map((e) => e.role), ['hidden_run', 'user']);
  assert.strictEqual(st.chatHistory[0].turns, 4); assert.strictEqual(st.chatNext, 'log:20');
});

test('phone: simple mode draws the same words in its own muted style (CSS), and the phone service worker moved on', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'mobile.html'), 'utf8');
  assert.match(html, /html\.mm-simple \.run-line \{[^}]*font-size: 12\.5px/);
  assert.ok(!/html\.mm-simple[^{]*\.run-(line|wrap|body)[^{]*\{[^}]*display: none/.test(html), 'not hidden in Simple');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8'), /const VERSION = 'hub-mobile-v114';/);
});

// ── review r1 ──
const ONE = { ...RUN, turns: 1, last_ts: RUN.ts, live: true };
const stale = () => { let release; const gate = new Promise((r) => { release = r; }); return { gate, release }; };

test('r1 B3 desktop: an answer that arrives after the line grew is dropped: entries stay null, the line stays closed, the next click fetches again', async () => {
  const g = stale(); let n = 0;
  const h = deskHarness({ fetchImpl: async () => { n++; if (n === 1) await g.gate; return { ok: true, json: async () => ({ history: TURNS.slice(0, 2) }) }; } });
  const wrap = h.f.soloRunLive(h.chat, { kind: 'consultation', from: 'Beacon' }, '2026-11-24T08:21:00.000Z');
  const line = wrap.children[0];
  const p = line.click();                                                    // one-turn line, slow answer
  h.f.soloRunLive(h.chat, { kind: 'consultation', from: 'Beacon' }, '2026-11-24T08:22:00.000Z');   // a second turn: the line grows
  g.release(); await p;
  const st = h.chat.runs[Object.keys(h.chat.runs)[0]];
  assert.strictEqual(st.entries, null);
  assert.strictEqual(line.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(wrap.children[1].hidden, true);
  assert.strictEqual(st.loading, false);
  assert.match(line.textContent, /^▸2 consultations from Beacon/);
  await line.click();
  assert.strictEqual(h.fetched.length, 2, 'the next click fetches again');
  assert.strictEqual(line.getAttribute('aria-expanded'), 'true');
});

test('r1 B3 phone: an answer that arrives after the line grew is dropped: entries stay null, the line stays closed, the next tap fetches again', async () => {
  const g = stale(); let n = 0;
  const h = phoneHarness({ fetchImpl: async () => { n++; if (n === 1) await g.gate; return { ok: true, json: async () => ({ history: TURNS.slice(0, 2) }) }; } });
  const wrap = h.f.runLive({ startedAt: '2026-11-24T08:21:00.000Z', origin: { kind: 'consultation', from: 'Beacon' } });
  const line = wrap.children[0];
  const p = line.click();
  h.f.runLive({ startedAt: '2026-11-24T08:22:00.000Z', origin: { kind: 'consultation', from: 'Beacon' } });
  g.release(); await p;
  assert.strictEqual(line.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(wrap.children[1].hidden, true);
  assert.strictEqual(wrap.children[1].children.length, 0);
  assert.match(line.textContent, /^▸2 consultations from Beacon/);
  await line.click();
  assert.strictEqual(h.urls.length, 2);
  assert.strictEqual(line.getAttribute('aria-expanded'), 'true');
});

test('r1 B2 helper: rank goes in the URL only when above 0 (never for a live line), and the open state is keyed by ts|rank', () => {
  assert.ok(!/rank/.test(V.chatViewRunUrl('scout', RUN)));
  assert.ok(!/rank/.test(V.chatViewRunUrl('scout', { ...RUN, rank: 0 })));
  assert.match(V.chatViewRunUrl('scout', { ...RUN, rank: 2 }), /&rank=2$/);
  assert.strictEqual(V.chatViewRunKey({ ...RUN, rank: 1 }), RUN.ts + '|1');
  assert.strictEqual(V.chatViewRunKey(RUN), RUN.ts + '|0');
});

test('r1 B2 desktop and phone: two lines at the same ts keep separate open state and fetch their own rank', async () => {
  const a = { ...RUN, rank: 0 }, b = { ...RUN, rank: 1 };
  const d = deskHarness({ fetchImpl: answer({ history: TURNS.slice(0, 2) }) });
  const w1 = d.f.soloRunLine('c1', a, null), w2 = d.f.soloRunLine('c1', b, null);
  await w2.children[0].click();
  assert.strictEqual(w1.children[0].getAttribute('aria-expanded'), 'false');
  assert.strictEqual(w2.children[0].getAttribute('aria-expanded'), 'true');
  assert.match(d.fetched[0], /&rank=1$/);
  const m = phoneHarness({ fetchImpl: answer({ history: TURNS.slice(0, 2) }) });
  const p1 = m.f.renderRunLine(a, m.box), p2 = m.f.renderRunLine(b, m.box);
  await p2.children[0].click();
  assert.strictEqual(p1.children[0].getAttribute('aria-expanded'), 'false');
  assert.strictEqual(p2.children[0].getAttribute('aria-expanded'), 'true');
  assert.match(m.urls[0], /&rank=1$/);
});

test('r1 FOLLOW-UP: Load earlier merges an older run into an open line: the merged line stays open (turns fetched again)', async () => {
  const older = { ...RUN, ts: '2026-11-24T07:00:00.000Z', last_ts: '2026-11-24T07:05:00.000Z', turns: 1, kinds: [{ kind: 'consultation', from: 'Beacon', n: 1 }] };
  const merged = V.chatViewMergeRuns([older, RUN])[0];
  assert.strictEqual(merged.ts, older.ts);
  assert.strictEqual(V.chatViewRunOpenKey({ [V.chatViewRunKey(RUN)]: { open: true } }, merged), V.chatViewRunKey(RUN));
  assert.strictEqual(V.chatViewRunOpenKey({ [V.chatViewRunKey(RUN)]: { open: false } }, merged), null);
  const d = deskHarness({ fetchImpl: answer({ history: TURNS }) });
  await d.f.soloRunLine('c1', RUN, null).children[0].click();
  d.panel.textContent = '';
  const again = d.f.soloRunLine('c1', merged, null);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(again.children[0].getAttribute('aria-expanded'), 'true');
  assert.strictEqual(d.fetched.length, 2);
  const m = phoneHarness({ fetchImpl: answer({ history: TURNS }) });
  await m.f.renderRunLine(RUN, m.box).children[0].click();
  m.box.textContent = '';
  const again2 = m.f.renderRunLine(merged, m.box);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(again2.children[0].getAttribute('aria-expanded'), 'true');
  assert.strictEqual(m.urls.length, 2);
});

test('r4 Load earlier: an open run B is not taken for part of an older run A at the same ts (separated by a shown entry)', async () => {
  const a = { ...RUN, rank: 0 }, b = { ...RUN, rank: 1 };
  const page = V.chatViewMergeRuns([a, { role: 'user', content: 'hi' }, b]);
  assert.strictEqual(page.length, 3);
  assert.strictEqual(V.chatViewRunOpenKey({ [V.chatViewRunKey(b)]: { open: true } }, page[0]), null);
  const d = deskHarness({ fetchImpl: answer({ history: TURNS }) });
  const wb0 = d.f.soloRunLine('c1', b, null);
  await wb0.children[0].click();
  assert.strictEqual(d.fetched.length, 1);
  d.panel.textContent = '';
  const wa = d.f.soloRunLine('c1', a, null), wb = d.f.soloRunLine('c1', b, null);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(wa.children[0].getAttribute('aria-expanded'), 'false');
  assert.strictEqual(wb.children[0].getAttribute('aria-expanded'), 'true');
  assert.strictEqual(d.fetched.length, 1);
  const m = phoneHarness({ fetchImpl: answer({ history: TURNS }) });
  await m.f.renderRunLine(b, m.box).children[0].click();
  assert.strictEqual(m.urls.length, 1);
  m.box.textContent = '';
  const pa = m.f.renderRunLine(a, m.box), pb = m.f.renderRunLine(b, m.box);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(pa.children[0].getAttribute('aria-expanded'), 'false');
  assert.strictEqual(pb.children[0].getAttribute('aria-expanded'), 'true');
  assert.strictEqual(m.urls.length, 1);
});

test('r1 B1 pages: an incomplete answer says to switch on Agent work, not an empty body', async () => {
  const d = deskHarness({ fetchImpl: answer({ history: [], more: false, incomplete: true }) });
  const w = d.f.soloRunLine('c1', RUN, null);
  await w.children[0].click();
  assert.strictEqual(w.children[0].getAttribute('aria-expanded'), 'false');
  assert.strictEqual(w.all('run-error')[0].textContent, "Couldn't load these turns. Switch on Agent work to see them.");
  const m = phoneHarness({ fetchImpl: answer({ history: [], incomplete: true }) });
  const p = m.f.renderRunLine(RUN, m.box);
  await p.children[0].click();
  assert.strictEqual(p.all('run-error')[0].textContent, "Couldn't load these turns. Switch on Agent work to see them.");
});

// ── review r2 ──
const FOUR = [];
for (let i = 0; i < 4; i++) FOUR.push({ ts: `2026-11-24T08:0${i}:00.000Z`, role: 'user', content: `[Consultation from agent "Beacon"] q${i}`, origin: { kind: 'consultation', from: 'Beacon' } }, { ts: `2026-11-24T08:0${i}:30.000Z`, role: 'assistant', content: `a${i}` });

test('r2 R4 desktop and phone: a 4-turn run opens to 4 cards at once, no stack', async () => {
  const d = deskHarness({ fetchImpl: answer({ history: FOUR }) });
  const w = d.f.soloRunLine('c1', { ...RUN, turns: 4 }, null);
  await w.children[0].click();
  assert.strictEqual(w.children[1].all('auto-card').length, 4);
  assert.strictEqual(w.children[1].all('auto-stack').length, 0);
  const m = phoneHarness({ fetchImpl: answer({ history: FOUR }) });
  const p = m.f.renderRunLine({ ...RUN, turns: 4 }, m.box);
  await p.children[0].click();
  assert.strictEqual(p.children[1].all('auto-card').length, 4);
  assert.strictEqual(p.children[1].all('auto-stack').length, 0);
  assert.ok(!/foldRenderHistoryStack|renderAutoStack/.test(cutApp('function soloRunLine(', 'function soloRunLive(') + cutMob('function renderRunLine(', 'function runLive(')), 'a run body never calls the stack renderers');
});

test('r2 R6 desktop and phone: the line is a chevron, a kinds span and a when span holding the time range; the range never shrinks (CSS)', () => {
  const d = deskHarness({ fetchImpl: answer({ history: [] }) });
  const dl = d.f.soloRunLine('c1', RUN, null).children[0];
  assert.deepStrictEqual(dl.children.map((c) => c.className), ['run-chev', 'run-kinds', 'run-when']);
  assert.strictEqual(dl.children[1].textContent, '2 consultations from Beacon');
  assert.strictEqual(dl.children[2].textContent, ' \u00b7 ' + V.chatViewRunParts(RUN, d.f.soloRunTime).when);
  assert.match(dl.children[2].textContent, /^ · .*[–-]/);
  const m = phoneHarness({ fetchImpl: answer({ history: [] }) });
  const pl = m.f.renderRunLine(RUN, m.box).children[0];
  assert.deepStrictEqual(pl.children.map((c) => c.className), ['run-chev', 'run-kinds', 'run-when']);
  assert.match(pl.children[2].textContent, /^ · /);
  assert.strictEqual(pl.title, pl.children[1].textContent + pl.children[2].textContent, 'the title is the whole line');
  for (const f of ['index.html', 'mobile.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.match(html, /\.run-when \{[^}]*flex: 0 0 auto/, f);
    assert.match(html, /\.run-kinds \{[^}]*flex: 0 1 auto;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis/, f);
  }
});

test('r2 R7 desktop and phone: a run over the cap says "Showing N of M turns" with the line\'s turns', async () => {
  const d = deskHarness({ fetchImpl: answer({ history: FOUR, more: true }) });
  const w = d.f.soloRunLine('c1', { ...RUN, turns: 111 }, null);
  await w.children[0].click();
  assert.strictEqual(w.children[1].all('run-more')[0].textContent, 'Showing 4 of 111 turns. Switch on Agent work to see them all.');
  const m = phoneHarness({ fetchImpl: answer({ history: FOUR, more: true }) });
  const p = m.f.renderRunLine({ ...RUN, turns: 111 }, m.box);
  await p.children[0].click();
  assert.strictEqual(p.children[1].all('run-more')[0].textContent, 'Showing 4 of 111 turns. Switch on Agent work to see them all.');
});

test('r2 R1 pages: a run with a turn id is fetched by it (no rank); a live line is named by its first turn and fetched with no 2 s allowance', async () => {
  const d = deskHarness({ fetchImpl: answer({ history: TURNS }) });
  const w = d.f.soloRunLine('c1', { ...RUN, rank: 1, turn: 'scout-a1-b2' }, null);
  await w.children[0].click();
  assert.match(d.fetched[0], /&turn=scout-a1-b2$/); assert.ok(!/rank/.test(d.fetched[0]));
  // two runs at the same ts with their own turns keep separate state
  const x = d.f.soloRunLine('c1', { ...RUN, turn: 'tX' }, null), y = d.f.soloRunLine('c1', { ...RUN, turn: 'tY' }, null);
  await x.children[0].click();
  assert.strictEqual(x.children[0].getAttribute('aria-expanded'), 'true'); assert.strictEqual(y.children[0].getAttribute('aria-expanded'), 'false');
  // live: first turn id kept, from = the turn's start
  const h = deskHarness({ fetchImpl: answer({ history: TURNS }) });
  const a = h.f.soloRunLive(h.chat, { kind: 'consultation', from: 'Beacon' }, '2026-11-24T08:21:00.000Z', 'scout-first-1');
  h.f.soloRunLive(h.chat, { kind: 'consultation', from: 'Beacon' }, '2026-11-24T08:25:00.000Z', 'scout-second-2');
  assert.strictEqual(a._run.turn, 'scout-first-1');
  await a.children[0].click();
  assert.match(h.fetched[0], /from=2026-11-24T08%3A21%3A00\.000Z&/, 'from is the first turn\'s own start');
  assert.match(h.fetched[0], /&turn=scout-first-1$/);
  const m = phoneHarness({ fetchImpl: answer({ history: TURNS }) });
  const pw = m.f.runLive({ startedAt: '2026-11-24T08:21:00.000Z', origin: { kind: 'consultation', from: 'Beacon' }, turnId: 'scout-first-1' });
  m.f.runLive({ startedAt: '2026-11-24T08:25:00.000Z', origin: { kind: 'consultation', from: 'Beacon' }, turnId: 'scout-second-2' });
  await pw.children[0].click();
  assert.match(m.urls[0], /from=2026-11-24T08%3A21%3A00\.000Z&/);
  assert.match(m.urls[0], /&turn=scout-first-1$/);
  assert.match(cutMob('function onTurnStart(ev) {', 'function onTurnDelta(ev) {'), /runLive\(ev\)/);
  assert.ok(!/- 2000/.test(cutApp('function soloRunLine(', 'function soloRunLive(') + cutMob('function renderRunLine(', 'function runLive(')), 'no 2 s widening');
});

// ── review r3 ──
test('r3 F1: Load earlier keeps two different runs with the same times apart (keyed by turn id), each fetching its own turn', () => {
  const mk = (turn) => ({ ...RUN, turn });
  const owner = { ts: '2026-11-24T08:30:00.000Z', role: 'user', content: 'owner says hi' };
  const older = [mk('turnA'), owner];
  const current = [mk('turnB'), { ts: '2026-11-24T09:00:00.000Z', role: 'assistant', content: 'later' }];
  const merged = V.chatViewMergeRuns(V.chatViewMergeOlder(older, current));
  const lines = merged.filter((e) => e.role === 'hidden_run');
  assert.deepStrictEqual(lines.map((e) => e.turn), ['turnA', 'turnB'], 'both lines survive, a shown entry keeps them apart');
  assert.match(V.chatViewRunUrl('scout', lines[0]), /&turn=turnA$/);
  assert.match(V.chatViewRunUrl('scout', lines[1]), /&turn=turnB$/);
  // the same run on both pages (the cursor repeats it) is still one
  assert.strictEqual(V.chatViewMergeOlder([mk('turnA')], [mk('turnA')]).length, 1);
  // old runs without a turn id: the same ts and rank is one, another rank is another
  assert.strictEqual(V.chatViewMergeOlder([{ ...RUN, rank: 0 }], [{ ...RUN, rank: 1 }]).length, 2);
  assert.strictEqual(V.chatViewMergeOlder([{ ...RUN, rank: 1 }], [{ ...RUN, rank: 1 }]).length, 1);
});

test('r3 F3 pages: a live line sends from = its first turn\'s hub time and to = its last counted hub time, never the device clock', async () => {
  const d = deskHarness({ fetchImpl: answer({ history: TURNS }) });
  const a = d.f.soloRunLive(d.chat, { kind: 'consultation', from: 'Beacon' }, '2026-11-24T08:21:00.000Z', 'scout-first-1');
  d.f.soloRunLive(d.chat, { kind: 'consultation', from: 'Beacon' }, '2026-11-24T08:25:00.000Z', 'scout-second-2');
  await a.children[0].click();
  assert.match(d.fetched[0], /from=2026-11-24T08%3A21%3A00\.000Z&to=2026-11-24T08%3A25%3A00\.000Z&turn=scout-first-1$/);
  const m = phoneHarness({ fetchImpl: answer({ history: TURNS }) });
  const pw = m.f.runLive({ startedAt: '2026-11-24T08:21:00.000Z', origin: { kind: 'consultation', from: 'Beacon' }, turnId: 'scout-first-1' });
  m.f.runLive({ startedAt: '2026-11-24T08:25:00.000Z', origin: { kind: 'consultation', from: 'Beacon' }, turnId: 'scout-second-2' });
  await pw.children[0].click();
  assert.match(m.urls[0], /from=2026-11-24T08%3A21%3A00\.000Z&to=2026-11-24T08%3A25%3A00\.000Z&turn=scout-first-1$/);
  assert.ok(!/new Date\(\)\.toISOString\(\)/.test(cutApp('function soloRunLine(', 'function soloRunLive(') + cutMob('function renderRunLine(', 'function runLive(')), 'the fetch never reads the device clock');
});

test('r3 F4 pages: a first turn alone over the cap says "Showing part of 1 turn. Switch on Agent work to see it all." on desktop and phone', async () => {
  const body = { history: FOUR, more: true, partial: true };
  const d = deskHarness({ fetchImpl: answer(body) });
  const w = d.f.soloRunLine('c1', { ...RUN, turns: 5 }, null);
  await w.children[0].click();
  assert.strictEqual(w.children[1].all('run-more')[0].textContent, 'Showing part of 1 turn. Switch on Agent work to see it all.');
  const m = phoneHarness({ fetchImpl: answer(body) });
  const p = m.f.renderRunLine({ ...RUN, turns: 5 }, m.box);
  await p.children[0].click();
  assert.strictEqual(p.children[1].all('run-more')[0].textContent, 'Showing part of 1 turn. Switch on Agent work to see it all.');
});

// ── r4 (Easel's must-fix items) ──
const timeOf = (card) => card.all('auto-card-time')[0] || card.all('auto-time')[0];
const htmlOf = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('r4 E1: a card inside an opened run shows only the time, on desktop and phone, formatted as the run line formats it', async () => {
  const d = deskHarness({ fetchImpl: answer({ history: TURNS }) });
  const w = d.f.soloRunLine('c1', RUN, null);
  await w.children[0].click();
  const dt = timeOf(w.children[1].all('auto-card')[0].children[0]);
  assert.strictEqual(dt.textContent, d.f.soloRunTime(TURNS[0].ts), 'the run line\'s own formatter');
  assert.ok(!/[A-Za-z]{3} \d/.test(dt.textContent), 'no date');
  const p = phoneHarness({ fetchImpl: answer({ history: TURNS }) });
  const pw = p.f.renderRunLine(RUN, p.box);
  await pw.children[0].click();
  const pt = timeOf(pw.children[1].all('auto-card')[0]);
  assert.strictEqual(pt.textContent, d.f.soloRunTime(TURNS[0].ts), 'the same words on both pages');
  assert.notStrictEqual(pt.textContent, 't');
  assert.match(cutApp('function foldBuildCard(', 'function foldFromLine('), /timeFn \? timeFn\(c\.ts\) : foldCardTime\(c\.ts\)/, 'outside a run the card keeps its date');
  assert.match(cutMob('function renderAutoCard(', 'function renderAutoStack('), /timeFn \? timeFn\(it\.ts\) : timeLabel\(it\.ts\)/);
});

test('r4 E1: inside a run the title shrinks before the reply line, which keeps about 15 characters (CSS)', () => {
  assert.match(htmlOf('index.html'), /\.run-body \.auto-card-label \{[^}]*flex: 0 1 auto;[^}]*min-width: 0/);
  assert.match(htmlOf('index.html'), /\.run-body \.auto-card-line \{[^}]*min-width: 15ch/);
  assert.match(htmlOf('mobile.html'), /\.run-body \.auto-label \{[^}]*flex: 0 1 auto;[^}]*min-width: 0/);
  assert.match(htmlOf('mobile.html'), /\.run-body \.auto-line \{[^}]*min-width: 15ch/);
});

test('r4 E3: the phone line may wrap its kinds to two lines and keeps the time whole; the desktop line stays one row', () => {
  const m = htmlOf('mobile.html');
  assert.match(m, /\.run-line \{[^}]*flex-wrap: wrap[^}]*width: 100%[^}]*min-height: 36px/, 'the whole width is the button, at least 36 px high');
  assert.match(m, /\.run-kinds \{[^}]*-webkit-line-clamp: 2[^}]*text-overflow: ellipsis/);
  assert.match(m, /\.run-when \{[^}]*flex: 0 0 auto;[^}]*white-space: pre/);
  const d = htmlOf('index.html');
  assert.ok(!/\.run-line \{[^}]*flex-wrap/.test(d) && /\.run-kinds \{[^}]*white-space: nowrap/.test(d));
});

test('r4 nice: the cap line\'s "Agent work" is a button that switches the Agent work view on (desktop toolbar toggle, phone menu toggle); the chevron is brighter', async () => {
  const body = { history: TURNS, more: true };
  const d = deskHarness({ fetchImpl: answer(body) });
  const w = d.f.soloRunLine('c1', { ...RUN, turns: 111 }, null);
  await w.children[0].click();
  const more = w.children[1].all('run-more')[0];
  assert.strictEqual(more.textContent, 'Showing 2 of 111 turns. Switch on Agent work to see them all.');
  const b = more.all('run-more-btn')[0];
  assert.strictEqual(b.tag, 'button'); assert.strictEqual(b.textContent, 'Agent work');
  await b.click(); assert.strictEqual(d.toggled.n, 1);
  const p = phoneHarness({ fetchImpl: answer(body) });
  const pw = p.f.renderRunLine({ ...RUN, turns: 111 }, p.box);
  await pw.children[0].click();
  const pb = pw.children[1].all('run-more')[0].all('run-more-btn')[0];
  assert.strictEqual(pb.tag, 'button'); assert.strictEqual(pb.textContent, 'Agent work');
  await pb.click(); assert.strictEqual(p.toggled.n, 1);
  assert.match(htmlOf('index.html'), /\.run-chev \{[^}]*color: var\(--auto-head-text\)/);
  assert.match(htmlOf('mobile.html'), /\.run-chev \{[^}]*color: var\(--text-dim\)/);
});
