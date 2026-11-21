'use strict';
// Phone chat header: the agent's model stays in view while the agent works. The model picker is the first item of the
// row under the header (#chat-meta), busy or idle; what the agent is doing shows under the name only while it works on
// a turn this device did not start, and a tap on the name or that line tells it in full (who, what, how long).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const html = read('mobile.html'), js = read('mobile.js');
const cut = (from, to) => { const a = js.indexOf(from); assert.ok(a >= 0, from); const b = js.indexOf(to, a + from.length); assert.ok(b > a, to); return js.slice(a, b); };

function el(id) {
  const classes = new Set();
  const attrs = {};
  return {
    id, textContent: '', hidden: false,
    classList: { toggle(c, on) { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); }, contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    setAttribute(k, v) { attrs[k] = String(v); }, getAttribute: (k) => (k in attrs ? attrs[k] : null),
  };
}

// paintChatStatus, chatStatusFull and showChatStatus as the page has them, over stub elements and status.
function world(o = {}) {
  const ids = ['chat-model', 'chat-busy', 'chat-title', 'chat-stop-btn', 'chat-notify-btn'];
  const els = Object.fromEntries(ids.map(id => [id, el(id)]));
  els['chat-busy'].hidden = true;
  const toasts = [];
  const now = Date.parse('2026-11-16T12:00:00Z');
  const ctx = {
    els, toasts,
    $: (id) => els[id] || null,
    current: 'sam',
    live: o.live || {},
    streams: new Map(o.own ? [['sam', {}]] : []),
    agents: [{ name: 'sam', display: 'Sam the long-named agent', model: 'claude-sdk/claude-opus-5-5' }],
    agentByName(n) { return ctx.agents.find(a => a.name === n); },
    displayName(n) { const a = ctx.agentByName(n); return (a && a.display) || n; },
    modelText(a) { return a && a.autoModel ? 'Auto' : String(a?.model || '').split('/').pop(); },
    isBusy(n) { return ctx.streams.has(n) || !!(ctx.live[n] && (ctx.live[n].busy || ctx.live[n].pendingQuestion)); },
    ownTurnFor(n) { return ctx.streams.has(n); },
    busyText(n) { const s = ctx.live[n] || {}; return s.pendingQuestion ? '❓ waiting for your answer · 2m' : `⏳ ${s.activity || 'working'} · 2m`; },
    turnOrigins: {}, openTurns: {}, turnSteps: {}, chatViewStepsNewest: require('../lib/ui-chat-view').chatViewStepsNewest, chatViewWaiting: require('../lib/ui-chat-view').chatViewWaiting, chatViewStep: require('../lib/ui-chat-view').chatViewStep, chatViewBusyText: require('../lib/ui-chat-view').chatViewBusyText, turnOriginFetch() {},
    elapsed: (since) => (since ? '2m' : ''),
    chatViewElapsed(since, t) { return `${Math.floor((t - since) / 60000)} min`; },
    toast(text, ms) { toasts.push({ text, ms }); },
    setSendMode() {}, paintBusyCard() {}, paintNotifyBtn() {},
    Date: { now: () => now, parse: Date.parse },
  };
  vm.createContext(ctx);
  vm.runInContext(cut('function currentTurnOrigin(agent) {', '// A page opened mid-turn got no turn_start'), ctx);
  vm.runInContext(cut('function chatBusyDetail(name) {', '// A turn_activity event'), ctx);
  vm.runInContext(cut('function chatStatusFull(name) {', '// ── "Notify me when done"'), ctx);
  return ctx;
}
const busyNow = { busy: true, busySince: '2026-11-16T11:57:55Z', activity: 'scheduled task: Nightly check', pendingQuestion: false };

test('busy on a turn this device did not start: the model stays in its place, the status goes under the name', () => {
  const w = world({ live: { sam: busyNow } });
  w.paintChatStatus();
  assert.strictEqual(w.els['chat-model'].textContent, 'claude-opus-5-5', 'the model, never the status');
  assert.strictEqual(w.els['chat-busy'].hidden, false);
  assert.strictEqual(w.els['chat-busy'].textContent, '⏳ Working on a scheduled task: Nightly check · 2m');
  assert.ok(w.els['chat-title'].classList.contains('busy'));
  assert.strictEqual(w.els['chat-stop-btn'].hidden, false, 'Stop shows as before');
  assert.match(w.els['chat-busy'].getAttribute('aria-label'), /^Sam the long-named agent: Working on a scheduled task: Nightly check · 2 min$/);
});

test('idle: the model, and no status line', () => {
  const w = world({ live: { sam: { busy: false } } });
  w.els['chat-busy'].hidden = false; w.els['chat-busy'].textContent = 'old';
  w.paintChatStatus();
  assert.strictEqual(w.els['chat-model'].textContent, 'claude-opus-5-5');
  assert.strictEqual(w.els['chat-busy'].hidden, true);
  assert.strictEqual(w.els['chat-busy'].textContent, '');
  assert.ok(!w.els['chat-title'].classList.contains('busy'));
});

test("this device's own reply: the model, no status line (the reply streams in the chat)", () => {
  const w = world({ own: true, live: { sam: busyNow } });
  w.paintChatStatus();
  assert.strictEqual(w.els['chat-model'].textContent, 'claude-opus-5-5');
  assert.strictEqual(w.els['chat-busy'].hidden, true);
});

test('Auto shows "Auto" busy or idle, as before', () => {
  const w = world({ live: { sam: busyNow } });
  w.agents[0].autoModel = true;
  w.paintChatStatus();
  assert.strictEqual(w.els['chat-model'].textContent, 'Auto');
});

test('a waiting question colours the status line as a question', () => {
  const w = world({ live: { sam: { ...busyNow, pendingQuestion: true } } });
  w.paintChatStatus();
  assert.ok(w.els['chat-busy'].classList.contains('question'));
  assert.strictEqual(w.chatStatusFull('sam'), 'Sam the long-named agent is waiting for your answer · 2 min');
});

test('a tap on the name or the status: who, what and how long, in full; nothing while idle or on an own reply', () => {
  const w = world({ live: { sam: busyNow } });
  w.showChatStatus();
  assert.deepStrictEqual(w.toasts, [{ text: 'Sam the long-named agent: Working on a scheduled task: Nightly check · 2 min', ms: 6000 }]);
  const idle = world({ live: { sam: { busy: false } } }); idle.showChatStatus();
  assert.strictEqual(idle.toasts.length, 0);
  const own = world({ own: true, live: { sam: busyNow } }); own.showChatStatus();
  assert.strictEqual(own.toasts.length, 0);
  // In every view the same words (no longer only where the busy card shows).
  const other = world({ live: { sam: { ...busyNow, activity: 'hand-off' } } });
  assert.strictEqual(other.chatStatusFull('sam'), 'Sam the long-named agent: Working on a task · 2 min');
  assert.match(js, /\$\('chat-title'\)\?\.addEventListener\('click', showChatStatus\);/);
});

test('markup: the model picker leads the row under the header; under the name only the status button', () => {
  assert.ok(html.includes('<div id="chat-title"><b id="chat-name">Chat</b><span class="sub-row"><button type="button" class="sub" id="chat-busy" hidden></button></span></div>'));
  assert.ok(html.includes('<div id="chat-meta"><span class="sub-wrap"><span class="sub" id="chat-model"></span><select id="chat-model-pick" aria-label="Change this agent\'s model" hidden></select></span><span class="sub-wrap effort-wrap" id="chat-effort-wrap" hidden>'));
  assert.ok(!/id="chat-title"[^\n]*chat-model/.test(html), 'the model is no longer under the name');
});

test('CSS: the row wraps instead of cutting items off; the status is amber over the header\'s dim text', () => {
  assert.match(html, /#chat-meta \{ display: flex; flex-wrap: wrap; align-items: center; gap: 2px 14px;/);
  assert.match(html, /#chat-meta > \.sub-wrap:first-child \{ flex: 0 1 auto; max-width: 100%; \}/);
  assert.match(html, /#chat-title #chat-busy \{[^}]*color: var\(--warning\); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;/);
  assert.match(html, /#chat-title #chat-busy\.question \{ color: var\(--accent-hover\); \}/);
  assert.match(html, /#chat-busy\[hidden\] \{ display: none; \}/);
  assert.match(html, /#chat-meta \.sub-wrap\.pickable::after \{ content: '\\25BE';/, 'the picker arrow in the row');
});
