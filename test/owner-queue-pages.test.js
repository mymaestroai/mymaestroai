'use strict';
// The owner's message while the agent answers another agent's consultation (desktop app.js, phone mobile.js; Simple uses both):
// it waits as its own request (queue_behind_consult + client_id) instead of being interjected, shows one waiting line with
// "Answer me now", is kept on the device until its turn starts, and the busy line carries the same button.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const MOBILE = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');

function fnSource(src, name) {
  let start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is in the page`);
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(start, i + 1);
}
const load = (src, names, ctx) => {
  const c = vm.createContext({ TextEncoder, TextDecoder, AbortController, Date, Math, JSON, Promise, Map, Set, Array, Number, String, ...ctx });
  vm.runInContext(names.map(n => fnSource(src, n)).join('\n') + `\nthis.__fns = { ${names.join(', ')} };`, c);
  return { api: c.__fns, ctx: c };
};
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

// A tiny DOM: enough for the waiting line, the buttons and the busy card.
class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.parentNode = null; this.attrs = {}; this.style = {}; this.listeners = {}; this.own = ''; this.id = ''; this.disabled = false; this.className = ''; this.type = ''; this.value = ''; }
  appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) { if (c.parentNode) c.remove(); c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  get nextSibling() { if (!this.parentNode) return null; const s = this.parentNode.children; return s[s.indexOf(this) + 1] || null; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  remove() { if (this.parentNode) { const s = this.parentNode.children; s.splice(s.indexOf(this), 1); this.parentNode = null; } }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  click() { if (!this.disabled) for (const f of this.listeners.click || []) f(); }
  get textContent() { return this.own + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { for (const c of this.children) c.parentNode = null; this.children = []; this.own = String(v); }
  find(fn) { for (const c of this.children) { if (fn(c)) return c; const r = c.find(fn); if (r) return r; } return null; }
  all(fn, out = []) { for (const c of this.children) { if (fn(c)) out.push(c); c.all(fn, out); } return out; }
}
function makeDoc() {
  const root = new El('body');
  return { root, hidden: false, createElement: (t) => new El(t), createTextNode: (t) => { const e = new El('#text'); e.own = t; return e; }, getElementById: (id) => root.find(e => e.id === id), addEventListener() {} };
}
const lineOf = (root) => root.find(e => e.className === 'owner-queue-line');
const linesOf = (root) => root.all(e => e.className === 'owner-queue-line');
const btnsOf = (el) => el.all(e => e.tagName === 'button' && e.textContent === 'Answer me now');

// A controllable event stream (what the hub holds open while the message waits).
function makeStream() {
  const q = []; let waiter = null; let closed = false;
  const reader = { read: () => new Promise((res) => { if (q.length) res(q.shift()); else if (closed) res({ done: true }); else waiter = res; }), cancel: () => { closed = true; if (waiter) { const w = waiter; waiter = null; w({ done: true }); } } };
  const push = (s) => { const v = { done: false, value: Buffer.from(s) }; if (waiter) { const w = waiter; waiter = null; w(v); } else q.push(v); };
  const end = () => { closed = true; if (waiter) { const w = waiter; waiter = null; w({ done: true }); } };
  const ev = (o) => push(`data: ${JSON.stringify(o)}\n\n`);
  return { response: { ok: true, status: 200, body: { getReader: () => reader } }, push, end, ev, reader };
}
const memStorage = (init) => { const m = new Map(Object.entries(init || {})); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, m }; };
const NAMES = { lead: 'Lead', helper: 'Helper' };
const QOM_SHARED = ['qomKey', 'qomStored', 'qomSave', 'qomKeep', 'qomForget', 'qomNewId', 'qomHidden', 'qomWords', 'qomLineText', 'qomWaiting', 'qomButton', 'qomPaint', 'qomTakeover', 'qomScan', 'qomEnd', 'qomEvent', 'qomStarted', 'qomRun', 'qomResendAll', 'qomEnqueue', 'qomName', 'qomPost', 'qomStream', 'qomReady', 'qomRestore', 'qomReread', 'qomBegin', 'qomOnConsult', 'qomSendNew', 'qomDecorate', 'qomPaintBusy'];

// ── desktop ──
function desk({ status = { busy: true, consultedBy: 'helper' }, chatOver = {}, stored = {}, hidden = false } = {}) {
  const doc = makeDoc(); doc.hidden = hidden;
  const bar = new El('div'); doc.root.appendChild(bar);
  const statusText = new El('span'); statusText.id = 'status-text-c1'; bar.appendChild(statusText);
  const msgs = new El('div'); msgs.id = 'messages-c1'; doc.root.appendChild(msgs);
  const input = new El('textarea'); input.id = 'input-c1'; input.value = 'Please check the plan'; doc.root.appendChild(input);
  const chat = { id: 'c1', agent: 'lead', messages: [], pendingImages: [], status: 'idle', ...chatOver };
  const calls = { fetch: [], solo: [], inter: [], resync: 0, begun: [] };
  const streams = [];
  const answers = {};   // url -> async () => Response-like
  const ctx = {
    document: doc, chats: { c1: chat }, skipInterjectOnce: new Set(), agentStatus: { lead: status }, busyRun: {}, localStorage: memStorage(stored), tzSentAt: 0,
    qomWait: new Map(), setTimeout: () => 0, clearTimeout() {}, zoneHeader: () => ({}),
    agentDisplayName: (n) => NAMES[n] || n, findSoloChat: (a) => (a === 'lead' ? chat : null),
    appendMessageWithImages: (id, role, content) => { const d = new El('div'); d.own = content; d.className = `msg ${role}`; msgs.appendChild(d); return 'm1'; },
    setMessageTime() {}, msgTimeLabel: () => 't', clearPendingImages: () => { chat.pendingImages = []; }, busyCardRefresh() {}, resync: () => { calls.resync++; },
    fetch: async (url, o) => {
      const body = o && o.body ? JSON.parse(o.body) : null;
      calls.fetch.push({ url, body });
      if (answers[url]) return answers[url]();
      const s = makeStream(); streams.push(s); return s.response;
    },
    sendInterjection: async (id) => { calls.inter.push(id); },
    sendSoloMessage: async (id, retry, opts) => { calls.solo.push({ id, opts }); },
  };
  const { api, ctx: vctx } = load(APP, [...QOM_SHARED, 'qomHeaderBtn', 'sendSoloMessage'], ctx);
  // the page's own sendSoloMessage is loaded for the routing tests; the one qomBegin calls is the recording stub
  vctx.sendSoloMessage = ctx.sendSoloMessage;
  return { api, vctx, doc, msgs, input, chat, calls, streams, answers, statusText, bar, ctx };
}

test('desktop: busy on a consultation -> the message waits as a stream request with queue_behind_consult and a client_id; /api/chat/interject is not called', async () => {
  const d = desk();
  await d.api.sendSoloMessage('c1');   // the page's own sendSoloMessage
  await tick();
  assert.strictEqual(d.calls.inter.length, 0, 'no interjection');
  assert.ok(!d.calls.fetch.some(f => /interject/.test(f.url)), 'interject never requested');
  assert.strictEqual(d.calls.fetch.length, 1);
  assert.strictEqual(d.calls.fetch[0].url, '/api/chat/stream');
  const b = d.calls.fetch[0].body;
  assert.strictEqual(b.queue_behind_consult, true);
  assert.ok(typeof b.client_id === 'string' && b.client_id.length > 0 && b.client_id.length <= 80, 'a client_id of at most 80 characters');
  assert.strictEqual(b.agent, 'lead');
  assert.strictEqual(b.message, 'Please check the plan');
  assert.strictEqual(d.input.value, '', 'the box is emptied');
  assert.strictEqual(d.msgs.children[0].textContent, 'Please check the plan', 'the message bubble is drawn as usual');
  assert.match(lineOf(d.msgs).textContent, /^Waiting: Lead is answering Helper\. Your message runs next\./, 'the line is there at once');
  // each message gets its own client_id
  d.input.value = 'And the budget';
  await d.api.sendSoloMessage('c1');
  await tick();
  assert.notStrictEqual(d.calls.fetch[1].body.client_id, b.client_id);
  assert.strictEqual(linesOf(d.msgs).length, 2, 'several waiting messages each keep their own line');
});

test('desktop: the origin of the running turn alone (kind consultation) counts as a consultation', async () => {
  const d = desk({ status: { busy: true } });
  d.vctx.busyRun.lead = { origin: { kind: 'consultation', from: 'helper' } };
  await d.api.sendSoloMessage('c1');
  await tick();
  assert.strictEqual(d.calls.fetch[0].body.queue_behind_consult, true);
  assert.strictEqual(d.calls.inter.length, 0);
});

test('desktop: busy on the person\'s own turn (or a non-consultation turn) -> an interjection as today, no waiting request', async () => {
  const own = desk({ status: { busy: true }, chatOver: { status: 'thinking' } });
  await own.api.sendSoloMessage('c1');
  assert.deepStrictEqual(own.calls.inter, ['c1']);
  assert.strictEqual(own.calls.fetch.length, 0);
  const hub = desk({ status: { busy: true, activity: 'scheduled task' } });
  await hub.api.sendSoloMessage('c1');
  assert.deepStrictEqual(hub.calls.inter, ['c1']);
  assert.strictEqual(linesOf(hub.msgs).length, 0);
  // the page keeps the interjection route for a message with pictures too
  assert.match(APP, /if \(\(content \|\| pendingImages\.length > 0\) && agentWorking && !skipInterjectOnce\.delete\(chatId\)\) \{/);
});

test('desktop: the queued event draws the waiting line (role=status, exact words, button); position 2 and 3 change the words', async () => {
  const d = desk();
  await d.api.sendSoloMessage('c1');
  await tick();
  const s = d.streams[0];
  s.ev({ type: 'queued', agent: 'lead', behind: { kind: 'consultation', from: 'helper' }, position: 1, client_id: 'x' });
  s.push(': ping\n\n');
  await tick();
  const line = lineOf(d.msgs);
  assert.strictEqual(line.attrs.role, 'status');
  assert.strictEqual(line.children[0].textContent, 'Waiting: Lead is answering Helper. Your message runs next.');
  const btn = btnsOf(line)[0];
  assert.ok(btn, 'the Answer me now button');
  assert.strictEqual(btn.type, 'button');
  assert.strictEqual(btn.textContent, 'Answer me now');
  assert.match(btn.style.cssText, /min-height:36px/);
  s.ev({ type: 'queued', agent: 'lead', behind: { kind: 'consultation', from: 'helper' }, position: 2, client_id: 'x' });
  await tick();
  assert.strictEqual(line.children[0].textContent, 'Your message runs after 1 other message.');
  s.ev({ type: 'queued', agent: 'lead', behind: { kind: 'consultation', from: 'helper' }, position: 3, client_id: 'x' });
  await tick();
  assert.strictEqual(line.children[0].textContent, 'Your message runs after 2 other messages.');
  // the first normal event: the line goes and the normal turn takes the request over (nothing of the wait is replayed to it)
  s.ev({ type: 'text', content: 'hello' });
  await tick();
  assert.strictEqual(linesOf(d.msgs).length, 0, 'the waiting line is removed when the turn starts');
  assert.strictEqual(d.ctx.localStorage.getItem('mmQueuedOwnerMessages'), '[]', 'and the kept message is dropped');
});

test('desktop: the turn starts -> the same request goes to the normal send (its first event replayed, the wait events not)', async () => {
  const d = desk();
  const begun = [];
  d.vctx.sendSoloMessage = async (id, retry, opts) => { begun.push({ id, opts }); const r = opts.qomTurn.response.body.getReader(); const first = await r.read(); begun[0].first = Buffer.from(first.value).toString(); };
  await d.api.sendSoloMessage('c1');   // (this one runs before the stub is swapped in: it only queues)
  await tick();
  const s = d.streams[0];
  s.ev({ type: 'queued', agent: 'lead', behind: { kind: 'consultation', from: 'helper' }, position: 1 });
  s.ev({ type: 'meta', n: 1 });
  await tick(10);
  assert.strictEqual(begun.length, 1);
  assert.strictEqual(begun[0].id, 'c1');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(begun[0].opts.fallback)), { text: 'Please check the plan', images: [] });
  assert.match(begun[0].first, /^data: \{"type":"meta","n":1\}/);
  assert.ok(!/queued/.test(begun[0].first));
});

test('desktop: Answer me now posts /api/chat/takeover with the agent and client_id, shows the pausing words and disables the button; an error shows on the line and enables it again', async () => {
  const d = desk();
  await d.api.sendSoloMessage('c1');
  await tick();
  const id = d.calls.fetch[0].body.client_id;
  let finish;
  d.answers['/api/chat/takeover'] = () => new Promise((res) => { finish = (o) => res({ json: async () => o }); });
  const line = lineOf(d.msgs);
  const btn = btnsOf(line)[0];
  btn.click();
  await tick();
  const post = d.calls.fetch.find(f => f.url === '/api/chat/takeover');
  assert.deepStrictEqual(post.body, { agent: 'lead', client_id: id });
  assert.strictEqual(line.children[0].textContent, "Pausing Helper's request…");
  assert.strictEqual(line.find(e => e.tagName === 'button').disabled, true, 'the button is disabled while it runs');
  finish({ ok: false, error: 'Helper is not on a request right now.' });
  await tick();
  assert.strictEqual(line.children[0].textContent, 'Helper is not on a request right now.');
  assert.strictEqual(line.find(e => e.tagName === 'button').disabled, false);
  // success: nothing else is drawn (the stream continues)
  line.find(e => e.tagName === 'button').click();
  await tick();
  finish({ ok: true, from: 'helper' });
  await tick();
  assert.strictEqual(line.children[0].textContent, "Pausing Helper's request…");
  // a takeover_failed event
  const s = d.streams[0];
  s.ev({ type: 'takeover_failed', error: 'boom' });
  await tick();
  assert.strictEqual(line.children[0].textContent, 'Could not pause: boom');
  assert.strictEqual(line.find(e => e.tagName === 'button').disabled, false);
});

test('desktop: the waiting message is kept in localStorage; a lost stream is sent again with the same client_id; already_sent clears it', async () => {
  const d = desk();
  await d.api.sendSoloMessage('c1');
  await tick();
  const id = d.calls.fetch[0].body.client_id;
  const kept = JSON.parse(d.ctx.localStorage.getItem('mmQueuedOwnerMessages'));
  assert.strictEqual(kept.length, 1);
  assert.deepStrictEqual(Object.keys(kept[0]).sort(), ['agent', 'client_id', 'message', 'ts']);
  assert.strictEqual(kept[0].client_id, id);
  assert.strictEqual(kept[0].agent, 'lead');
  assert.strictEqual(kept[0].message, 'Please check the plan');
  // the stream drops while still waiting
  d.streams[0].end();
  await tick();
  assert.strictEqual(linesOf(d.msgs).length, 1, 'the line stays');
  assert.strictEqual(JSON.parse(d.ctx.localStorage.getItem('mmQueuedOwnerMessages')).length, 1, 'the message is still kept');
  // not while the page is hidden
  d.doc.hidden = true;
  d.api.qomResendAll();
  await tick();
  assert.strictEqual(d.calls.fetch.length, 1, 'no resend while hidden');
  d.doc.hidden = false;
  d.api.qomResendAll();
  await tick();
  assert.strictEqual(d.calls.fetch.length, 2);
  assert.strictEqual(d.calls.fetch[1].body.client_id, id, 'the same client_id');
  assert.strictEqual(d.calls.fetch[1].body.queue_behind_consult, true);
  // the hub says it already ran
  d.streams[1].ev({ type: 'already_sent', client_id: id });
  await tick();
  assert.strictEqual(d.ctx.localStorage.getItem('mmQueuedOwnerMessages'), '[]');
  assert.strictEqual(linesOf(d.msgs).length, 0);
  assert.strictEqual(d.calls.resync, 1, 'the reply is caught up from the history');
});

test('desktop: a page that loaded with a kept message draws and sends it again with its client_id; entries older than 6 hours are dropped; replaced ends quietly', async () => {
  const fresh = { agent: 'lead', client_id: 'qkeep1', message: 'Still waiting', ts: Date.now() - 60000 };
  const old = { agent: 'lead', client_id: 'qold1', message: 'Ancient', ts: Date.now() - 7 * 3600 * 1000 };
  const d = desk({ stored: { mmQueuedOwnerMessages: JSON.stringify([fresh, old]) } });
  d.api.qomResendAll();
  await tick();
  assert.strictEqual(d.calls.fetch.length, 1, 'only the fresh one');
  assert.strictEqual(d.calls.fetch[0].body.client_id, 'qkeep1');
  assert.strictEqual(d.calls.fetch[0].body.message, 'Still waiting');
  assert.strictEqual(d.msgs.children[0].textContent, 'Still waiting', 'drawn again');
  d.streams[0].ev({ type: 'replaced' });
  await tick();
  assert.strictEqual(linesOf(d.msgs).length, 0, 'a replaced request ends quietly');
  d.api.qomResendAll();
  await tick();
  assert.strictEqual(d.calls.fetch.length, 1, 'and is not sent again by this page');
});

test('desktop: the busy line (header text and chat card) shows Answer me now only while one of the person\'s messages waits, acting on the first', async () => {
  const d = desk();
  // nothing waits: no button anywhere
  const card = new El('div');
  d.api.qomDecorate(card, 'lead');
  assert.strictEqual(btnsOf(card).length, 0);
  d.api.qomHeaderBtn(d.chat);
  assert.strictEqual(d.doc.getElementById('qom-busy-c1'), null);
  await d.api.sendSoloMessage('c1');
  await tick();
  d.input.value = 'second';
  await d.api.sendSoloMessage('c1');
  await tick();
  const id1 = d.calls.fetch[0].body.client_id;
  const card2 = new El('div');
  d.api.qomDecorate(card2, 'lead');
  assert.strictEqual(btnsOf(card2).length, 1);
  d.api.qomHeaderBtn(d.chat);
  const head = d.doc.getElementById('qom-busy-c1');
  assert.ok(head, 'the header carries the button');
  assert.strictEqual(head.textContent, 'Answer me now');
  head.click();
  await tick();
  assert.strictEqual(d.calls.fetch.find(f => f.url === '/api/chat/takeover').body.client_id, id1, 'the first waiting message');
  // when the waiting ends, the button goes
  d.streams[0].ev({ type: 'text', content: 'x' });
  d.streams[1].ev({ type: 'already_sent', client_id: 'y' });
  await tick(10);
  const card3 = new El('div');
  d.api.qomDecorate(card3, 'lead');
  assert.strictEqual(btnsOf(card3).length, 0);
  // wiring in the page
  assert.match(fnSource(APP, 'busyCardRefresh'), /qomDecorate\(el, chat\.agent\)/);
});

// ── phone ──
function phone({ live = { lead: { busy: true, consultedBy: 'helper' } }, stored = {}, own = false, origin = null } = {}) {
  const doc = makeDoc();
  const head = new El('div'); doc.root.appendChild(head);
  const busy = new El('button'); busy.id = 'chat-busy'; head.appendChild(busy);
  const msgs = new El('div'); msgs.id = 'messages'; doc.root.appendChild(msgs);
  const input = new El('textarea'); input.id = 'msg-input'; input.value = 'Please check the plan'; doc.root.appendChild(input);
  const sendBtn = new El('button'); sendBtn.id = 'send-btn'; doc.root.appendChild(sendBtn);
  const calls = { api: [], inter: [], begun: [], reread: [] };
  const streams = []; const answers = {};
  const sstreams = new Map(); if (own) sstreams.set('lead', {});
  const ctx = {
    document: doc, current: 'lead', screen: 'chat', live, streams: sstreams, reattaches: new Map(), pendingImages: [], imagesPreparing: new Set(), sendWaiting: false, tzSentAt: 0,
    localStorage: memStorage(stored), qomWait: new Map(), setTimeout: () => 0, clearTimeout() {}, zoneHeader: () => ({}),
    turnOrigins: origin ? { lead: origin } : {}, openTurns: {},
    $: (id) => doc.getElementById(id), chatEl: () => msgs, displayName: (n) => NAMES[n] || n,
    addUserBubble: (text) => { const d = new El('div'); d.own = text; d.className = 'msg user'; msgs.appendChild(d); return d; },
    setBubbleTime() {}, msgTimeLabel: () => 't', saveDraft() {}, composerTypingPaint() {}, renderPreviews() {}, scrollChat() {}, markUnread() {}, paintChatStatus() {},
    rereadHistory: (a) => { calls.reread.push(a); },
    api: async (url, o) => {
      const body = o && o.body ? JSON.parse(o.body) : null;
      calls.api.push({ url, body });
      if (answers[url]) return answers[url]();
      const s = makeStream(); streams.push(s); return s.response;
    },
    sendInterjection: async (agent) => { calls.inter.push(agent); },
    sendMessage: async (f) => { calls.begun.push(f); },
    plusSheetShow() {}, toast() {},
  };
  const { api, ctx: vctx } = load(MOBILE, [...QOM_SHARED, 'qomBusyBtn', 'isBusy', 'ownTurnFor', 'currentTurnOrigin', 'sendMessage'], ctx);
  vctx.sendMessage = ctx.sendMessage;   // (api.sendMessage is the page's own; the one qomBegin calls is the recording stub)
  return { api, vctx, doc, msgs, input, calls, streams, answers, busy, head, ctx };
}

test('phone: busy on a consultation -> the message waits as a stream request with queue_behind_consult and a client_id; /api/chat/interject is not called', async () => {
  const p = phone();
  await p.api.sendMessage();
  await tick();
  assert.strictEqual(p.calls.inter.length, 0);
  assert.ok(!p.calls.api.some(f => /interject/.test(f.url)));
  assert.strictEqual(p.calls.api[0].url, '/api/chat/stream');
  const b = p.calls.api[0].body;
  assert.strictEqual(b.queue_behind_consult, true);
  assert.ok(typeof b.client_id === 'string' && b.client_id.length > 0 && b.client_id.length <= 80);
  assert.strictEqual(b.message, 'Please check the plan');
  assert.strictEqual(p.input.value, '');
  assert.strictEqual(p.msgs.children[0].textContent, 'Please check the plan');
  assert.match(lineOf(p.msgs).textContent, /^Waiting: Lead is answering Helper\. Your message runs next\./);
  const o = phone({ live: { lead: { busy: true } }, origin: { origin: { kind: 'consultation', from: 'helper' } } });
  await o.api.sendMessage();
  await tick();
  assert.strictEqual(o.calls.api[0].body.queue_behind_consult, true, 'the running turn\'s origin counts too');
});

test('phone: busy on the person\'s own turn (or a turn that is not a consultation) -> an interjection as today', async () => {
  const own = phone({ own: true });
  await own.api.sendMessage();
  assert.deepStrictEqual(own.calls.inter, ['lead']);
  assert.strictEqual(own.calls.api.length, 0);
  const hub = phone({ live: { lead: { busy: true, activity: 'scheduled task' } } });
  await hub.api.sendMessage();
  assert.deepStrictEqual(hub.calls.inter, ['lead']);
  assert.strictEqual(hub.calls.api.length, 0);
});

test('phone: the queued event, position 2, Answer me now (pausing words, error), takeover_failed, and the turn start', async () => {
  const p = phone();
  await p.api.sendMessage();
  await tick();
  const s = p.streams[0], id = p.calls.api[0].body.client_id;
  s.ev({ type: 'queued', agent: 'lead', behind: { kind: 'consultation', from: 'helper' }, position: 1, client_id: id });
  await tick();
  const line = lineOf(p.msgs);
  assert.strictEqual(line.attrs.role, 'status');
  assert.strictEqual(line.children[0].textContent, 'Waiting: Lead is answering Helper. Your message runs next.');
  s.ev({ type: 'queued', agent: 'lead', behind: { kind: 'consultation', from: 'helper' }, position: 2 });
  await tick();
  assert.strictEqual(line.children[0].textContent, 'Your message runs after 1 other message.');
  let finish;
  p.answers['/api/chat/takeover'] = () => new Promise((res) => { finish = (o) => res({ json: async () => o }); });
  btnsOf(line)[0].click();
  await tick();
  assert.deepStrictEqual(p.calls.api.find(f => f.url === '/api/chat/takeover').body, { agent: 'lead', client_id: id });
  assert.strictEqual(line.children[0].textContent, "Pausing Helper's request…");
  assert.strictEqual(line.find(e => e.tagName === 'button').disabled, true);
  finish({ ok: false, error: 'Nothing to pause.' });
  await tick();
  assert.strictEqual(line.children[0].textContent, 'Nothing to pause.');
  assert.strictEqual(line.find(e => e.tagName === 'button').disabled, false);
  s.ev({ type: 'takeover_failed', error: 'boom' });
  await tick();
  assert.strictEqual(line.children[0].textContent, 'Could not pause: boom');
  // the turn starts: sendMessage takes the running request over with the message already drawn
  s.ev({ type: 'text', content: 'hi' });
  await tick(10);
  assert.strictEqual(linesOf(p.msgs).length, 0);
  assert.strictEqual(p.calls.begun.length, 1);
  assert.strictEqual(p.calls.begun[0].text, 'Please check the plan');
  assert.strictEqual(p.calls.begun[0].userEl, p.msgs.children[0]);
  assert.ok(p.calls.begun[0].response && p.calls.begun[0].response.body.getReader);
  assert.strictEqual(p.ctx.localStorage.getItem('mmQueuedOwnerMessages'), '[]');
});

test('phone: kept in localStorage; a lost stream is sent again with the same client_id (not while hidden); already_sent clears it and reads the history', async () => {
  const p = phone();
  await p.api.sendMessage();
  await tick();
  const id = p.calls.api[0].body.client_id;
  const kept = JSON.parse(p.ctx.localStorage.getItem('mmQueuedOwnerMessages'));
  assert.deepStrictEqual([kept[0].agent, kept[0].client_id, kept[0].message], ['lead', id, 'Please check the plan']);
  assert.ok(kept[0].ts > 0);
  p.streams[0].end();
  await tick();
  p.doc.hidden = true;
  p.api.qomResendAll();
  await tick();
  assert.strictEqual(p.calls.api.length, 1, 'not while the page is hidden');
  p.doc.hidden = false;
  p.api.qomResendAll();
  await tick();
  assert.strictEqual(p.calls.api.length, 2);
  assert.strictEqual(p.calls.api[1].body.client_id, id);
  p.streams[1].ev({ type: 'already_sent', client_id: id });
  await tick();
  assert.strictEqual(p.ctx.localStorage.getItem('mmQueuedOwnerMessages'), '[]');
  assert.strictEqual(linesOf(p.msgs).length, 0);
  assert.deepStrictEqual(p.calls.reread, ['lead']);
  // a reload: kept entries older than 6 hours are dropped, a fresh one is drawn and sent again
  const q = phone({ stored: { mmQueuedOwnerMessages: JSON.stringify([{ agent: 'lead', client_id: 'qk', message: 'kept', ts: Date.now() - 1000 }, { agent: 'lead', client_id: 'qo', message: 'old', ts: Date.now() - 7 * 3600 * 1000 }]) } });
  q.api.qomResendAll();
  await tick();
  assert.deepStrictEqual(q.calls.api.map(c => c.body.client_id), ['qk']);
  assert.strictEqual(q.msgs.children[0].textContent, 'kept');
});

test('phone: the busy line (#chat-busy and the card) shows Answer me now only while one of the person\'s messages waits; the button is a real button of at least 36 px', async () => {
  const p = phone();
  p.api.qomBusyBtn();
  assert.strictEqual(p.doc.getElementById('chat-busy-answer'), null, 'nothing waits: no button');
  await p.api.sendMessage();
  await tick();
  p.api.qomBusyBtn();
  const b = p.doc.getElementById('chat-busy-answer');
  assert.ok(b);
  assert.strictEqual(b.tagName, 'button');
  assert.strictEqual(b.type, 'button');
  assert.strictEqual(b.textContent, 'Answer me now');
  assert.match(b.style.cssText, /min-height:36px/);
  b.click();
  await tick();
  assert.strictEqual(p.calls.api.find(f => f.url === '/api/chat/takeover').body.client_id, p.calls.api[0].body.client_id);
  const card = new El('div');
  p.api.qomDecorate(card, 'lead');
  assert.strictEqual(btnsOf(card).length, 1);
  p.streams[0].ev({ type: 'text', content: 'x' });
  await tick(10);
  p.api.qomBusyBtn();
  assert.strictEqual(p.doc.getElementById('chat-busy-answer'), null, 'the turn started: the button is gone');
  // wiring in the page
  assert.match(fnSource(MOBILE, 'paintChatStatus'), /qomBusyBtn\(\);[^\n]*\n\s*setSendMode\(own\);\s*paintBusyCard\(\);/);
  assert.match(fnSource(MOBILE, 'paintBusyCard'), /qomDecorate\(busyCardEl, current\)/);
});

test('both pages: the same words, the same storage key, and the service worker is hub-mobile-v113', () => {
  for (const src of [APP, MOBILE]) {
    assert.match(src, /Your message runs after \$\{n - 1\} other message\$\{n - 1 === 1 \? '' : 's'\}\./);
    assert.match(src, /Waiting: \$\{behind\} is answering \$\{from\}\. Your message runs next\./);
    assert.match(src, /Pausing \$\{w\.fromName\}'s request…/);
    assert.match(src, /Could not pause: \$\{ev\.error/);
    assert.match(src, /'mmQueuedOwnerMessages'/);
    assert.match(src, /btn\.textContent = 'Answer me now';/);
    assert.match(src, /btn\.type = 'button';/);
    assert.match(src, /line\.setAttribute\('role', 'status'\);/);
    assert.match(src, /6 \* 3600 \* 1000/);
  }
  assert.match(APP, /qomOnConsult\(chat\.agent, chat\)\) return qomSendNew\(/);
  assert.match(MOBILE, /if \(!fallback && typeof qomOnConsult === 'function' && qomOnConsult\(agent\)\) \{ await qomSendNew\(agent\); return; \}\s*\n\s*if \(!fallback && \(isBusy\(agent\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8'), /const VERSION = 'hub-mobile-v113';/);
});
