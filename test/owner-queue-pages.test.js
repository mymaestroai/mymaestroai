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
  constructor(tag) { this.tagName = tag; this.children = []; this.parentNode = null; this.attrs = {}; this.style = {}; this.listeners = {}; this.own = ''; this.id = ''; this.disabled = false; this.className = ''; this.type = ''; this.value = ''; this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } }; }
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
const memStorage = (init) => { const m = new Map(Object.entries(init || {})); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, m }; };
const NAMES = { lead: 'Lead', helper: 'Helper' };
const QOM_SHARED = ['qomKey', 'qomUser', 'qomAll', 'qomForgetAll', 'qomStored', 'qomSave', 'qomKeep', 'qomForget', 'qomNewId', 'qomHidden', 'qomWords', 'qomLineText', 'qomWaiting', 'qomButton', 'qomPaint', 'qomTakeover', 'qomScan', 'qomEnd', 'qomEvent', 'qomStarted', 'qomRun', 'qomResendAll', 'qomEnqueue', 'qomName', 'qomPost', 'qomStream', 'qomReady', 'qomRestore', 'qomReread', 'qomBegin', 'qomOnConsult', 'qomSendNew', 'qomQueueMessage', 'qomDecorate', 'qomPaintBusy', 'qomRetryLater', 'qomForeign', 'qomDrop'];

// ── desktop ──
function desk({ status = { busy: true, consultedBy: 'helper' }, chatOver = {}, stored = {}, hidden = false, me = { user: { id: 'sam' } }, more = {} } = {}) {
  const doc = makeDoc(); doc.hidden = hidden;
  const bar = new El('div'); doc.root.appendChild(bar);
  const statusText = new El('span'); statusText.id = 'status-text-c1'; bar.appendChild(statusText);
  const msgs = new El('div'); msgs.id = 'messages-c1'; doc.root.appendChild(msgs);
  const input = new El('textarea'); input.id = 'input-c1'; input.value = 'Please check the plan'; doc.root.appendChild(input);
  const chat = { id: 'c1', agent: 'lead', messages: [], pendingImages: [], status: 'idle', ...chatOver };
  const calls = { fetch: [], solo: [], inter: [], resync: 0, begun: [] };
  const streams = [];
  const answers = {};   // url -> async () => Response-like
  const agentStatus = { lead: status };
  const ctx = {
    window: { hubMe: me }, document: doc, chats: { c1: chat }, skipInterjectOnce: new Set(), agentStatus, busyRun: {}, localStorage: memStorage(stored), tzSentAt: 0,
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
    ...(more.ctx ? more.ctx({ doc, msgs, chat, calls, agentStatus }) : {}),
  };
  const { api, ctx: vctx } = load(APP, [...QOM_SHARED, 'qomHeaderBtn', 'sendSoloMessage', ...(more.names || [])], ctx);
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
  assert.deepStrictEqual(Object.keys(kept[0]).sort(), ['agent', 'client_id', 'message', 'ts', 'user']);
  assert.strictEqual(kept[0].user, 'sam', 'the entry belongs to the signed-in person');
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
  const fresh = { agent: 'lead', client_id: 'qkeep1', message: 'Still waiting', ts: Date.now() - 60000, user: 'sam' };
  const old = { agent: 'lead', client_id: 'qold1', message: 'Ancient', ts: Date.now() - 7 * 3600 * 1000, user: 'sam' };
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

// ── a late status (the hub started a consultation, the page has not heard yet) and a status that outlives the person's own turn ──
const noop = () => {};
const full = (extra = {}) => ({ names: ['sendInterjection', 'qomStatusConsult'], ctx: ({ doc, msgs, chat, calls, agentStatus }) => ({
  AbortSignal, skipInterjectOnce: new Set(), waitForPreparingImages: async () => true, renderImagePreviews: noop, setStatus: noop, setAgentStatus: noop, setAgentLive: noop, startToolTracker: noop,
  appendMessage: () => 'a1', elapsedLabel: () => '', chatViewActivityWord: () => '',
  appendSystemNotice(id, text) { const d = new El('div'); d.own = text; d.className = 'notice'; msgs.appendChild(d); return d; },
  applyStatusSnapshot(map) { for (const [n, v] of Object.entries(map)) agentStatus[n] = { ...v }; },
  appendMessageWithImages: (id, role, content) => { const d = new El('div'); d.own = content; d.className = `msg ${role}`; d.id = `mm${msgs.children.length}`; msgs.appendChild(d); return d.id; },
  ...extra }) });

test('desktop: qomOnConsult is true while the chat shows a hub-started turn (status "thinking") but has no running send of its own; a send of its own (controller, reattach) still rules it out', () => {
  const d = desk({ chatOver: { status: 'thinking' } });
  assert.strictEqual(d.api.qomOnConsult('lead', d.chat), true, 'thinking is also set for a consultation shown in the chat');
  d.chat.controller = {};
  assert.strictEqual(d.api.qomOnConsult('lead', d.chat), false, 'this page\'s own stream');
  d.chat.controller = null; d.chat.reattach = { x: 1 };
  assert.strictEqual(d.api.qomOnConsult('lead', d.chat), false, 'a re-attach to the person\'s own turn');
  d.chat.reattach = null;
  d.ctx.agentStatus.lead = { busy: true }; d.vctx.busyRun.lead = { origin: { kind: 'consultation', from: 'helper' } };
  assert.strictEqual(d.api.qomOnConsult('lead', d.chat), true, 'the running turn\'s origin says consultation');
  d.vctx.busyRun.lead = { origin: { kind: 'schedule' } };
  assert.strictEqual(d.api.qomOnConsult('lead', d.chat), false, 'a scheduled task is not a consultation');
});

test('desktop: a send in a chat whose status is "thinking" (a consultation shown in it) waits as a queued request, not an interjection', async () => {
  const d = desk({ chatOver: { status: 'thinking' } });
  await d.api.sendSoloMessage('c1');
  await tick();
  assert.ok(!d.calls.fetch.some(f => /interject/.test(f.url)), 'no interjection');
  assert.strictEqual(d.calls.fetch[0].url, '/api/chat/stream');
  assert.strictEqual(d.calls.fetch[0].body.queue_behind_consult, true);
  assert.strictEqual(linesOf(d.msgs).length, 1, 'the waiting line');
});

test('desktop: the hub refuses an interjection into a consultation (consultation: true) -> the bubble and notice go, the text and pictures wait as a queued request, drawn once', async () => {
  const d = desk({ status: { busy: true }, more: full() });   // the page does not know about the consultation yet
  d.ctx.chats.c1.pendingImages = ['data:image/png;base64,AAA'];
  d.answers['/api/chat/interject'] = async () => ({ ok: true, status: 200, json: async () => ({ success: false, consultation: true, error: 'busy answering a consultation' }) });
  await d.api.sendSoloMessage('c1');
  await tick(12);
  assert.ok(d.calls.fetch.some(f => /interject/.test(f.url)), 'the interjection was tried first');
  const stream = d.calls.fetch.find(f => f.url === '/api/chat/stream');
  assert.ok(stream, 'then the same text is sent as a queued request');
  assert.strictEqual(stream.body.queue_behind_consult, true);
  assert.strictEqual(stream.body.message, 'Please check the plan');
  assert.deepStrictEqual(stream.body.images, ['data:image/png;base64,AAA']);
  assert.strictEqual(d.msgs.all(e => e.className === 'notice').length, 0, 'the interjection notice is gone');
  const bubbles = d.msgs.all(e => /^msg /.test(e.className));
  assert.strictEqual(bubbles.length, 1, 'the message is drawn once');
  assert.ok(!/Interjection/.test(bubbles[0].textContent), 'and it is not the interjection bubble');
  assert.strictEqual(linesOf(d.msgs).length, 1, 'with its waiting line');
});

test('desktop: a normal send the hub answers 409 busy, while the status (or a fresh /api/agents/status) says consultation -> it is queued, not interjected', async () => {
  const d = desk({ status: { busy: false }, more: full() });
  d.answers['/api/chat/stream'] = async () => ({ ok: false, status: 409, statusText: 'Conflict' });
  d.answers['/api/agents/status'] = async () => ({ ok: true, json: async () => ({ agents: { lead: { busy: true, consultedBy: 'helper' } } }) });
  await d.api.sendSoloMessage('c1');
  await tick(12);
  assert.ok(!d.calls.fetch.some(f => /interject/.test(f.url)), 'no interjection');
  assert.ok(d.calls.fetch.some(f => f.url === '/api/agents/status'), 'the status was read again');
  const queued = d.calls.fetch.filter(f => f.url === '/api/chat/stream' && f.body && f.body.queue_behind_consult === true);
  assert.strictEqual(queued.length, 1);
  assert.strictEqual(queued[0].body.message, 'Please check the plan');
  assert.strictEqual(d.msgs.all(e => /^msg user/.test(e.className)).length, 1, 'drawn once');
  assert.strictEqual(linesOf(d.msgs).length, 1);
});

test('desktop: a late re-route (409, then the status says consultation) queues the captured message and never touches the composer', async () => {
  const d = desk({ status: { busy: false }, more: full() });
  d.answers['/api/chat/stream'] = async () => ({ ok: false, status: 409, statusText: 'Conflict' });
  let release;
  d.answers['/api/agents/status'] = () => new Promise((res) => { release = () => res({ ok: true, json: async () => ({ agents: { lead: { busy: true, consultedBy: 'helper' } } }) }); });
  const sending = d.api.sendSoloMessage('c1');
  await tick(12);
  assert.ok(release, 'the status lookup is pending');
  d.input.value = 'something new';   // typed and attached while the lookup was pending
  d.chat.pendingImages = ['data:image/png;base64,NEW'];
  release();
  await sending;
  await tick(12);
  const queued = d.calls.fetch.filter(f => f.url === '/api/chat/stream' && f.body && f.body.queue_behind_consult === true);
  assert.strictEqual(queued.length, 1, 'the original message is queued');
  assert.strictEqual(queued[0].body.message, 'Please check the plan');
  assert.strictEqual(d.input.value, 'something new', 'the composer keeps the new text');
  assert.deepStrictEqual(d.chat.pendingImages, ['data:image/png;base64,NEW'], 'and the new picture');
  assert.strictEqual(d.msgs.all(e => /^msg user/.test(e.className)).length, 1, 'drawn once');
});

// ── phone ──
function phone({ live = { lead: { busy: true, consultedBy: 'helper' } }, stored = {}, own = false, origin = null, me = { user: { id: 'sam' } } } = {}) {
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
    hubMe: me, document: doc, current: 'lead', screen: 'chat', live, streams: sstreams, reattaches: new Map(), pendingImages: [], imagesPreparing: new Set(), sendWaiting: false, tzSentAt: 0,
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
  const q = phone({ stored: { mmQueuedOwnerMessages: JSON.stringify([{ agent: 'lead', client_id: 'qk', message: 'kept', ts: Date.now() - 1000, user: 'sam' }, { agent: 'lead', client_id: 'qo', message: 'old', ts: Date.now() - 7 * 3600 * 1000, user: 'sam' }]) } });
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
  assert.strictEqual(p.doc.getElementById('chat-busy-answer'), null, 'never in the phone header: it squeezed the name and was clipped');
  const card = new El('div');
  p.api.qomDecorate(card, 'lead');
  assert.strictEqual(btnsOf(card).length, 1);
  const b = btnsOf(card)[0];
  assert.strictEqual(b.tagName, 'button');
  assert.strictEqual(b.type, 'button');
  assert.strictEqual(b.textContent, 'Answer me now');
  assert.match(b.style.cssText, /min-height:36px/);
  b.click();
  await tick();
  assert.strictEqual(p.calls.api.find(f => f.url === '/api/chat/takeover').body.client_id, p.calls.api[0].body.client_id);
  p.streams[0].ev({ type: 'text', content: 'x' });
  await tick(10);
  p.api.qomBusyBtn();
  assert.strictEqual(p.doc.getElementById('chat-busy-answer'), null, 'the turn started: the button is gone');
  // wiring in the page
  assert.match(fnSource(MOBILE, 'paintChatStatus'), /qomBusyBtn\(\);[^\n]*\n\s*setSendMode\(own\);\s*paintBusyCard\(\);/);
  assert.match(fnSource(MOBILE, 'paintBusyCard'), /qomDecorate\(busyCardEl, current\)/);
});

// The phone with the page's own sendInterjection / sendMessage (their other helpers are stubs).
function phoneFull(opts = {}) {
  const p = phone(opts);
  const c = p.ctx;
  const bubbles = () => p.msgs.all(e => e.className === 'msg user');
  Object.assign(c, {
    AbortSignal, streams: new Map(), recentOwn: new Map(), imagesPreparing: new Set(), sendWaiting: false, stick: false,
    addNote: (t) => { const d = new El('div'); d.own = t; d.className = 'note'; p.msgs.appendChild(d); return d; },
    classList: undefined, addAssistantBubble: () => { const el = new El('div'); el.className = 'msg assistant'; p.msgs.appendChild(el); return { el, body: new El('div') }; },
    newFeed: () => ({}), voiceTakeDictated: () => false, simpleThinkStart: noop, elapsed: () => '', chatViewActivityWord: () => '', paintStatus: noop, feedEnd: noop, reasoningEnd: noop,
    chatOpenFor: () => true, bubbleLive: () => true, voiceAutoReadGen: 0, window: {}, setLive: noop, toast: noop,
    applySnapshot(map) { for (const [n, v] of Object.entries(map)) c.live[n] = { ...v }; },
    ...(opts.ctx || {}),
  });
  const { api, ctx: vctx } = load(MOBILE, [...QOM_SHARED, 'qomBusyBtn', 'isBusy', 'ownTurnFor', 'currentTurnOrigin', 'qomStatusConsult', 'qomRefusedOnConsult', 'qomChatOpened', 'sendInterjection', 'sendMessage'], c);
  vctx.sendMessage = c.sendMessage;
  Object.assign(p, { api, vctx, bubbles });
  return p;
}

test('phone: the hub refuses an interjection into a consultation (consultation: true) -> the bubble and note go, the same text and pictures wait as a queued request, drawn once', async () => {
  const p = phoneFull({ live: { lead: { busy: true } } });   // the phone does not know about the consultation yet
  p.vctx.pendingImages = ['data:image/png;base64,AAA'];
  p.answers['/api/chat/interject'] = async () => ({ ok: true, status: 200, json: async () => ({ success: false, consultation: true, error: 'busy answering a consultation' }) });
  await p.api.sendInterjection('lead');
  await tick(12);
  const stream = p.calls.api.find(c => c.url === '/api/chat/stream');
  assert.ok(stream, 'the same text goes as a queued request');
  assert.strictEqual(stream.body.queue_behind_consult, true);
  assert.strictEqual(stream.body.message, 'Please check the plan');
  assert.deepStrictEqual(stream.body.images, ['data:image/png;base64,AAA']);
  assert.strictEqual(p.msgs.all(e => e.className === 'note').length, 0, 'the interjection note is gone');
  assert.strictEqual(p.bubbles().length, 1, 'the message is drawn once');
  assert.strictEqual(linesOf(p.msgs).length, 1, 'with its waiting line');
});

test('phone: a normal send the hub answers 409 busy while a fresh /api/agents/status says consultation -> it is queued, not refused', async () => {
  const p = phoneFull({ live: { lead: { busy: false } } });
  p.answers['/api/chat/stream'] = async () => { p.answers['/api/chat/stream'] = null; return { ok: false, status: 409 }; };
  p.answers['/api/agents/status'] = async () => ({ ok: true, json: async () => ({ agents: { lead: { busy: true, consultedBy: 'helper' } } }) });
  await p.api.sendMessage();
  await tick(12);
  assert.ok(p.calls.api.some(c => c.url === '/api/agents/status'), 'the status was read again');
  const queued = p.calls.api.filter(c => c.url === '/api/chat/stream' && c.body && c.body.queue_behind_consult === true);
  assert.strictEqual(queued.length, 1);
  assert.strictEqual(queued[0].body.message, 'Please check the plan');
  assert.strictEqual(p.input.value, '', 'the text is not put back in the box');
  assert.strictEqual(p.bubbles().length, 1, 'drawn once');
  assert.strictEqual(linesOf(p.msgs).length, 1);
});

const keptFor = (p) => JSON.parse(p.ctx.localStorage.getItem('mmQueuedOwnerMessages') || '[]');
function lateOnOtherChat(p, how) {
  // the person switched to another agent's chat while the answer was pending: nothing is drawn there, the message waits for helper
  assert.strictEqual(p.msgs.all(e => /^msg /.test(e.className)).length, 0, 'nothing is drawn in the other chat');
  assert.strictEqual(linesOf(p.msgs).length, 0, 'no waiting line there either');
  const kept = keptFor(p).filter(e => e.agent === 'helper');
  assert.strictEqual(kept.length, 1, `${how}: kept for helper`);
  assert.strictEqual(kept[0].message, 'Please check the plan');
  assert.strictEqual(p.vctx.qomWait.size, 1);
  assert.strictEqual([...p.vctx.qomWait.values()][0].agent, 'helper');
  assert.strictEqual(p.input.value, 'typed in lead', 'the composer is left alone');
  p.vctx.current = 'helper'; p.vctx.screen = 'chat';   // helper's chat is opened
  p.api.qomChatOpened('helper');
  assert.strictEqual(p.msgs.all(e => e.className === 'msg user').length, 1, 'opening helper draws the message');
  assert.strictEqual(linesOf(p.msgs).length, 1, 'with its waiting line');
}

test('phone: a refused interjection (consultation: true) that comes back after a switch to another chat is queued for the agent it was sent to, not drawn in the other chat', async () => {
  const p = phoneFull({ live: { helper: { busy: true }, lead: { busy: false } }, ctx: { current: 'helper' } });
  let release;
  p.answers['/api/chat/interject'] = () => new Promise((res) => { release = () => res({ ok: true, status: 200, json: async () => ({ success: false, consultation: true, error: 'busy answering a consultation' }) }); });
  const sending = p.api.sendInterjection('helper');
  await tick(6);
  p.vctx.current = 'lead'; p.input.value = 'typed in lead';
  p.msgs.children.splice(0);   // lead's chat on screen: empty
  release();
  await sending; await tick(12);
  lateOnOtherChat(p, 'refusal');
});

test('phone: a 409 whose status lookup says consultation, after a switch to another chat, is queued for the agent it was sent to, not drawn in the other chat', async () => {
  const p = phoneFull({ live: { helper: { busy: false }, lead: { busy: false } }, ctx: { current: 'helper' } });
  p.answers['/api/chat/stream'] = async () => { p.answers['/api/chat/stream'] = null; return { ok: false, status: 409 }; };
  let release;
  p.answers['/api/agents/status'] = () => new Promise((res) => { release = () => res({ ok: true, json: async () => ({ agents: { helper: { busy: true, consultedBy: 'lead' } } }) }); });
  const sending = p.api.sendMessage();
  await tick(12);
  assert.ok(release, 'the status lookup is pending');
  p.vctx.current = 'lead'; p.input.value = 'typed in lead';
  p.msgs.children.splice(0);
  release();
  await sending; await tick(12);
  lateOnOtherChat(p, '409');
});

test('phone: no Answer me now in the header next to #chat-busy (no room there) through every repaint; the busy card in the chat carries it', async () => {
  const p = phoneFull();
  p.busy.hidden = false;
  const repaint = () => { p.busy.textContent = '⏳ Answering a consultation from Helper · 6s'; p.api.qomBusyBtn(); };   // what paintChatStatus does each time
  const answers = () => p.doc.root.all(e => e.id === 'chat-busy-answer');
  repaint();
  assert.strictEqual(answers().length, 0, 'nothing waits: no button');
  await p.api.sendMessage();
  await tick(12);
  repaint(); repaint(); repaint();
  assert.strictEqual(answers().length, 0, 'no button in the phone header after any number of repaints');
  assert.strictEqual(p.busy.all(e => e.tagName === 'button').length, 0, 'not inside the busy line (a button in a button never gets the tap)');
  assert.match(p.busy.textContent, /Answering a consultation from Helper · 6s/);
  p.streams[0].ev({ type: 'text', content: 'x' });   // the turn began: the message no longer waits
  await tick(12);
  repaint();
  assert.strictEqual(answers().length, 0, 'no waiting message: no button');
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

// ── person scope (both pages) ──
const entry = (id, user, extra = {}) => ({ agent: 'lead', client_id: id, message: `m-${id}`, ts: Date.now() - 1000, ...(user === undefined ? {} : { user }), ...extra });

test('desktop: waiting messages are kept per person; another person\'s entries are neither restored nor sent, and keeping one leaves the others in the key', async () => {
  const d = desk({ me: { user: { id: 'sam' } }, stored: { mmQueuedOwnerMessages: JSON.stringify([entry('mine', 'sam'), entry('theirs', 'lee'), entry('nobody')]) } });
  assert.deepStrictEqual(d.api.qomStored().map(e => e.client_id), ['mine']);
  assert.deepStrictEqual(d.api.qomStored('lee').map(e => e.client_id), ['theirs']);
  d.api.qomResendAll();
  await tick();
  assert.deepStrictEqual(d.calls.fetch.map(c => c.body.client_id), ['mine'], 'only this person\'s message is sent again');
  await d.api.sendSoloMessage('c1');
  await tick();
  const all = JSON.parse(d.ctx.localStorage.getItem('mmQueuedOwnerMessages'));
  assert.ok(all.some(e => e.client_id === 'theirs' && e.user === 'lee'), 'the other person\'s entry is still stored');
  assert.ok(all.some(e => e.user === 'sam' && e.message === 'Please check the plan'));
});

test('desktop: nothing is restored or sent until the page knows who is signed in; no accounts -> the empty person', async () => {
  const d = desk({ me: null, stored: { mmQueuedOwnerMessages: JSON.stringify([entry('mine', 'sam'), entry('plain', '')]) } });
  assert.strictEqual(d.api.qomStored().length, 0);
  d.api.qomResendAll();
  await tick();
  assert.strictEqual(d.calls.fetch.length, 0, 'nothing sent while hubMe is not loaded');
  assert.strictEqual(d.msgs.children.length, 0, 'nothing drawn');
  d.vctx.window.hubMe = { user: { id: 'sam' } };
  d.api.qomResendAll();
  await tick();
  assert.deepStrictEqual(d.calls.fetch.map(c => c.body.client_id), ['mine']);
  const n = desk({ me: { user: null }, stored: { mmQueuedOwnerMessages: JSON.stringify([entry('mine', 'sam'), entry('plain', '')]) } });
  assert.deepStrictEqual(n.api.qomStored().map(e => e.client_id), ['plain']);
});

test('desktop: sign-out removes the whole key (and the page calls it where it forgets the theme)', () => {
  const d = desk({ stored: { mmQueuedOwnerMessages: JSON.stringify([entry('mine', 'sam'), entry('theirs', 'lee')]) } });
  d.api.qomForgetAll();
  assert.strictEqual(d.ctx.localStorage.getItem('mmQueuedOwnerMessages'), null);
  assert.match(fnSource(APP, 'signOut'), /qomForgetAll\(\)/);
});

test('phone: per person, nothing before hubMe is loaded, sign-out removes the key', async () => {
  const p = phone({ me: { user: { id: 'sam' } }, stored: { mmQueuedOwnerMessages: JSON.stringify([entry('mine', 'sam'), entry('theirs', 'lee'), entry('nobody')]) } });
  assert.deepStrictEqual(p.api.qomStored().map(e => e.client_id), ['mine']);
  p.api.qomResendAll();
  await tick();
  assert.deepStrictEqual(p.calls.api.map(c => c.body.client_id), ['mine']);
  const w = phone({ me: null, stored: { mmQueuedOwnerMessages: JSON.stringify([entry('mine', 'sam')]) } });
  w.api.qomResendAll();
  await tick();
  assert.strictEqual(w.calls.api.length, 0, 'nothing sent while hubMe is not loaded');
  p.api.qomForgetAll();
  assert.strictEqual(p.ctx.localStorage.getItem('mmQueuedOwnerMessages'), null);
  assert.match(fnSource(MOBILE, 'signOut'), /qomForgetAll\(\)/);
  assert.match(MOBILE, /forgetBanner\(window\.HubLooks\.storageOf\(window\)\); \} catch \{[^\n]*\n\s*try \{ qomForgetAll\(\); \}[^\n]*\n\s*location\.href = '\/login\?next='/);
});

// ── a retry is from the account that sent the message; a refusal "try again" keeps it waiting ──
const timersOf = (v) => { const t = []; v.setTimeout = (fn, ms) => { t.push(ms); return t.length; }; return t; };

test('desktop: every stream request of a waiting message says who sent it (expect_user), first send and resend; no accounts -> the empty string', async () => {
  const d = desk();
  await d.api.sendSoloMessage('c1');
  await tick();
  assert.strictEqual(d.calls.fetch[0].body.expect_user, 'sam');
  d.streams[0].end();
  await tick();
  d.api.qomResendAll();   // the in-memory waiter goes again
  await tick();
  assert.strictEqual(d.calls.fetch[1].body.expect_user, 'sam');
  const kept = desk({ stored: { mmQueuedOwnerMessages: JSON.stringify([entry('kept1', 'sam')]) } });
  kept.api.qomResendAll();
  await tick();
  assert.strictEqual(kept.calls.fetch[0].body.expect_user, 'sam', 'a restored message too');
  const open = desk({ me: { user: null } });
  await open.api.sendSoloMessage('c1');
  await tick();
  assert.strictEqual(open.calls.fetch[0].body.expect_user, '');
});

test('desktop: another account signed in -> the waiter is dropped (line, memory and kept entry), not sent; the other person\'s kept entries stay', async () => {
  const d = desk({ stored: { mmQueuedOwnerMessages: JSON.stringify([entry('theirs', 'lee')]) } });
  await d.api.sendSoloMessage('c1');
  await tick();
  const id = d.calls.fetch[0].body.client_id;
  d.streams[0].end();
  await tick();
  assert.strictEqual(linesOf(d.msgs).length, 1);
  d.vctx.window.hubMe = { user: { id: 'lee' } };   // someone else is signed in on this page now
  d.api.qomResendAll();
  await tick();
  assert.ok(!d.calls.fetch.slice(1).some(f => f.body && f.body.client_id === id), 'the message of the first account is not sent again');
  assert.ok(!d.vctx.qomWait.has(id), 'forgotten in memory');
  const kept = JSON.parse(d.ctx.localStorage.getItem('mmQueuedOwnerMessages'));
  assert.ok(!kept.some(e => e.client_id === id), 'its kept entry is gone');
  assert.ok(kept.some(e => e.client_id === 'theirs'), 'the signed-in person\'s own entries are untouched');
  // and qomRun itself refuses to send a foreign waiter
  const w = { chatId: 'c1', agent: 'lead', message: 'x', images: [], ts: Date.now(), client_id: 'qf', user: 'sam', position: 1, runId: 0 };
  d.vctx.qomWait.set('qf', w);
  const before = d.calls.fetch.length;
  await d.api.qomRun(w);
  assert.strictEqual(d.calls.fetch.length, before);
  assert.ok(!d.vctx.qomWait.has('qf'));
});

test('desktop: an error event with retry:true keeps the message waiting, shows the text on its line, and retries with a growing pause; any other error ends it', async () => {
  const d = desk();
  const timers = timersOf(d.vctx);
  await d.api.sendSoloMessage('c1');
  await tick();
  const id = d.calls.fetch[0].body.client_id;
  const msg = 'Your Maestro could not record this message, so it was not run. Try again in a moment.';
  d.streams[0].ev({ type: 'error', error: msg, status: 503, retry: true });
  await tick();
  assert.ok(d.vctx.qomWait.has(id), 'still waiting');
  assert.strictEqual(JSON.parse(d.ctx.localStorage.getItem('mmQueuedOwnerMessages')).length, 1, 'still kept');
  assert.strictEqual(lineOf(d.msgs).children[0].textContent, msg, 'the reason is on the line');
  assert.deepStrictEqual(timers, [2000]);
  d.api.qomResendAll();
  await tick();
  assert.strictEqual(d.calls.fetch.length, 2, 'sent again with the same client_id');
  assert.strictEqual(d.calls.fetch[1].body.client_id, id);
  d.streams[1].ev({ type: 'error', error: msg, status: 503, retry: true });
  await tick();
  assert.deepStrictEqual(timers, [2000, 4000], 'backoff grows');
  // a queued event clears the text; a plain error ends the message
  d.api.qomResendAll(); await tick();
  d.streams[2].ev({ type: 'queued', agent: 'lead', behind: { kind: 'consultation', from: 'helper' }, position: 1, client_id: id });
  await tick();
  assert.match(lineOf(d.msgs).children[0].textContent, /^Waiting:/);
  d.streams[2].ev({ type: 'error', error: 'Signed in as someone else: this message was not sent.', status: 409 });
  await tick();
  assert.ok(!d.vctx.qomWait.has(id));
  assert.match(lineOf(d.msgs).children[0].textContent, /^Not sent: Signed in as someone else/);
});

test('phone: expect_user on every send, a foreign waiter is dropped, retry:true keeps waiting with backoff', async () => {
  const p = phone();
  const timers = timersOf(p.vctx);
  await p.api.qomSendNew('lead');
  await tick();
  const id = p.calls.api[0].body.client_id;
  assert.strictEqual(p.calls.api[0].body.expect_user, 'sam');
  const msg = 'Your Maestro could not record this message, so it was not run. Try again in a moment.';
  p.streams[0].ev({ type: 'error', error: msg, status: 503, retry: true });
  await tick();
  assert.ok(p.vctx.qomWait.has(id), 'still waiting');
  assert.strictEqual(lineOf(p.msgs).children[0].textContent, msg);
  assert.deepStrictEqual(timers, [2000]);
  p.api.qomResendAll();
  await tick();
  assert.strictEqual(p.calls.api.length, 2);
  assert.strictEqual(p.calls.api[1].body.expect_user, 'sam');
  p.streams[1].end();
  await tick();
  p.vctx.hubMe = { user: { id: 'lee' } };
  p.api.qomResendAll();
  await tick();
  assert.strictEqual(p.calls.api.length, 2, 'not sent as the other account');
  assert.ok(!p.vctx.qomWait.has(id));
  assert.strictEqual(linesOf(p.msgs).length, 0);
  assert.ok(!JSON.parse(p.ctx.localStorage.getItem('mmQueuedOwnerMessages') || '[]').some(e => e.client_id === id));
});

test('desktop: while the agent answers a consultation the composer reads Send with when the message runs; during the person\'s own turn it is Interject', () => {
  const p = desk({ chatOver: { status: 'thinking' }, more: { names: ['qomComposerLook'] } });
  const send = new El('button'); send.id = 'send-c1'; send.textContent = '⚡ Interject'; p.doc.root.appendChild(send);
  const input = p.doc.getElementById('input-c1');
  p.api.qomComposerLook(p.chat);
  assert.strictEqual(send.textContent, 'Send');
  assert.strictEqual(input.placeholder, 'Lead is answering Helper. Your message runs next.');
  p.ctx.agentStatus.lead = { busy: true };   // the consultation ended and the person's own turn runs
  p.api.qomComposerLook(p.chat);
  assert.strictEqual(send.textContent, '⚡ Interject');
  assert.strictEqual(input.placeholder, 'Type to interject new info into the running agent...');
  p.chat.status = 'idle'; send.textContent = 'Send'; p.ctx.agentStatus.lead = { busy: true, consultedBy: 'helper' };
  p.api.qomComposerLook(p.chat);
  assert.strictEqual(send.textContent, 'Send', 'an idle chat is left to setStatus');
  // wiring: setStatus's busy branch and the status feed both call it
  assert.match(APP, /simpleBusyLook\(sendBtn, input, cancelBtn\);[^\n]*\n\s*if \(typeof qomComposerLook === 'function'\) qomComposerLook\(chats\[chatId\]\);/);
  assert.match(APP, /busyCardRefresh\(c\); if \(typeof qomComposerLook === 'function'\) qomComposerLook\(c\);/);
});
