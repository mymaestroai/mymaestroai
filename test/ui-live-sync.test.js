'use strict';
// Pages that follow a turn they did not start (another computer, the phone, a reopened chat) show what the sending
// window shows: the phase bar and token counter (turn_progress), every tool call even when the live event stream is
// down (the turn view is polled), and one bubble for the turn (the reply saved in progress is not drawn twice).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const app = read('app.js');
const mjs = read('mobile.js');
const mhtml = read('mobile.html');

test('desktop: turn_progress drives the phase bar, the token counter and the context line of a followed turn', () => {
  assert.ok(app.includes("source.addEventListener('turn_progress', e => { const ev = parse(e); if (ev) onHubTurnProgress(ev); });"));
  assert.match(app, /function applyTurnProgress\(chatId, msgId, p\) \{[\s\S]{0,300}setLiveActivity\(msgId, chatId, p\.progress\);[\s\S]{0,80}setTokenUsage\(msgId, p\.usage\);[\s\S]{0,80}updateContextHealth\(chatId, p\.context\);/);
  assert.ok(app.includes('if (!turn.ended) applyTurnProgress(chatId, ra ? ra.msgId : t.msgId, turn);'), 'a catch-up brings them too');
  assert.ok(app.includes('clearLiveActivity(ra.msgId);') && app.includes('clearLiveActivity(t.msgId);'), 'the bar ends with the turn');
  assert.ok(app.includes("if (!t.items || !t.items.size) { updateMessage(t.msgId, text || '…'); restoreLiveBars(t.msgId, streaming); return; }"), 'a repaint keeps them');
});

test('desktop: no live event stream -> followed turns are fetched every few seconds', () => {
  assert.ok(app.includes('const TURN_POLL_MS = 4000;'));
  assert.match(app, /setInterval\(\(\) => \{\n\s+if \(hubEventSource && hubEventSource\.readyState === EventSource\.OPEN && hubLastEventAt && Date\.now\(\) - hubLastEventAt <= HUB_EVENT_STALE_MS\) return;\n\s+catchUpAll\(\);\n\s+\}, TURN_POLL_MS\);/);
});

test('desktop: the reply saved in progress is not drawn twice; its text seeds the live bubble of the same turn only', () => {
  assert.ok(app.includes("if (msg.inProgress) { chats[chatId].inProgress = { text: msg.content || '', ts: msg.ts || null }; continue; }"));
  assert.ok(app.includes("const partial = ip && (!since || !ip.ts || Date.parse(ip.ts) >= Date.parse(since) - 1000) ? ip.text : '';"));
  assert.ok(app.includes('if (reply && (stillBusy === true || reply.inProgress)) {'), 'a flagged entry never finishes the bubble early');
  assert.ok(app.includes('if (reply.content && reply.content.length > (ra.partial || \'\').length) ra.partial = reply.content;'), 'the history copy never rolls the live text back');
});

test('phone: turn_progress, polling without a stream, one bubble for the turn', () => {
  assert.ok(mjs.includes("on('turn_progress', onTurnProgress);"));
  assert.match(mjs, /function applyTurnProgress\(agent, p, holder = null\) \{[\s\S]{0,200}noteCtxReading\(agent, p\.context\);[\s\S]{0,200}setLive\(agent, \{ busy: true, activity: phaseText\(p\.progress\) \}\);/);
  assert.ok(mjs.includes('const TURN_POLL_MS = 4000;'));
  assert.match(mjs, /if \(es && es\.readyState === EventSource\.OPEN && esLastEventAt && Date\.now\(\) - esLastEventAt <= ES_STALE_MS\) return;\n\s+if \(current && screen === 'chat' && !streams\.has\(current\)[^\n]+catchUpOpenAgent\(\);\n\s+\}, TURN_POLL_MS\);/);
  assert.ok(mjs.includes('const inProgress = chatHistory.length && chatHistory[chatHistory.length - 1].inProgress ? chatHistory.pop() : null;'));
  assert.ok(mjs.includes("reattachIfIdle(name, inProgress ? String(inProgress.content || '') : '');"));
  assert.ok(mjs.includes('if (stillBusy === true || reply.inProgress) {'));
  assert.ok(mjs.includes("if (reply.content.length > (ra.partial || '').length) ra.partial = reply.content;"));
});

test('phone header: the line under the name keeps its room; effort, plan and context have their own row', () => {
  assert.ok(mhtml.includes('<div id="chat-meta"><span class="sub-wrap effort-wrap" id="chat-effort-wrap" hidden>'), 'own row');
  assert.ok(!/id="chat-title"[^\n]*chat-plan/.test(mhtml), 'not under the name any more');
  assert.ok(mhtml.includes('#chat-title { overflow: hidden; }'), 'nothing paints over the header buttons');
  assert.ok(mhtml.includes('#chat-meta:not(:has(> :not([hidden]))) { display: none; }'), 'no empty row');
  assert.ok(mhtml.includes('<span class="stop-label"> Stop</span>') && mhtml.includes('@media (max-width: 430px) { #chat-stop-btn .stop-label { display: none; }'), 'compact Stop on narrow phones');
});
