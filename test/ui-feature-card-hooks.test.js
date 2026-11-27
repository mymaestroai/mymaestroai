'use strict';
// The pages call FeatureCard.messageArrived(list) where a LIVE message lands in an open chat, never where saved history is drawn.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CALL = 'FeatureCard.messageArrived(';
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const count = (s) => s.split(CALL).length - 1;

/** The source of `function <name>(...) { ... }` (brace-matched from its first "{" after the signature). */
function bodyOf(src, re) {
  const m = re.exec(src);
  assert.ok(m, 'function found: ' + re);
  const open = src.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  throw new Error('unbalanced');
}

test('mobile.js: at least two live hooks; renderHistory (saved history) has none', () => {
  const src = read('mobile.js');
  assert.ok(count(src) >= 2, 'hooks: ' + count(src));
  assert.strictEqual(count(bodyOf(src, /function renderHistory\s*\(\)\s*\{/)), 0);
  const send = bodyOf(src, /async function sendMessage\s*\(fallback\)\s*\{/);
  assert.ok(count(send) >= 1, 'sendMessage hooks');
  assert.ok(count(bodyOf(src, /function onTurnStart\s*\(ev\)\s*\{/)) >= 1, 'onTurnStart hooks');
  assert.ok(!src.includes('function addUserBubble') || count(bodyOf(src, /function addUserBubble\s*\([^)]*\)\s*\{/)) === 0, 'not inside addUserBubble');
  assert.strictEqual(count(bodyOf(src, /function addAssistantBubble\s*\([^)]*\)\s*\{/)), 0, 'not inside addAssistantBubble');
});

test('app.js: at least two live hooks; soloHistoryDraw (saved history) and appendMessage have none', () => {
  const src = read('app.js');
  assert.ok(count(src) >= 2, 'hooks: ' + count(src));
  assert.strictEqual(count(bodyOf(src, /function soloHistoryDraw\s*\([^)]*\)\s*\{/)), 0);
  assert.strictEqual(count(bodyOf(src, /function appendMessage\s*\(chatId, role, content, into\)\s*\{/)), 0);
  assert.ok(count(bodyOf(src, /async function sendSoloMessage\s*\(/)) >= 1, 'sendSoloMessage hooks');
  assert.ok(count(bodyOf(src, /async function onHubTurnStart\s*\(ev\)\s*\{/)) >= 1, 'onHubTurnStart hooks');
});

test('every hook is wrapped so a failure stays cosmetic', () => {
  for (const f of ['app.js', 'mobile.js']) {
    const lines = read(f).split('\n').filter((l) => l.includes(CALL));
    for (const l of lines) assert.ok(/try \{ window\.FeatureCard && FeatureCard\.messageArrived\(.*\); \} catch \{/.test(l), f + ': ' + l.trim());
  }
});

test('the person\'s own sends pass { own: true } (the one-line done card then goes at once); the hub-turn hooks do not', () => {
  const OWN = /FeatureCard\.messageArrived\([^;]*, \{ own: true \}\)/;
  const app = read('app.js'); const mob = read('mobile.js');
  const solo = bodyOf(app, /async function sendSoloMessage\s*\(/);
  assert.ok(OWN.test(solo), 'sendSoloMessage passes own: true');
  const hubTurn = bodyOf(app, /async function onHubTurnStart\s*\(ev\)\s*\{/);
  assert.ok(hubTurn.includes(CALL) && !/own/.test(hubTurn.split('\n').filter((l) => l.includes(CALL)).join('\n')), 'onHubTurnStart: no own');
  const send = bodyOf(mob, /async function sendMessage\s*\(fallback\)\s*\{/);
  assert.ok(OWN.test(send), 'sendMessage passes own: true');
  const turn = bodyOf(mob, /function onTurnStart\s*\(ev\)\s*\{/);
  assert.ok(turn.includes(CALL) && !/own/.test(turn.split('\n').filter((l) => l.includes(CALL)).join('\n')), 'onTurnStart: no own');
  // no other hook passes it
  for (const src of [app, mob]) assert.strictEqual(src.split('\n').filter((l) => l.includes(CALL) && /own: true/.test(l)).length, 1);
});

test('the pages tell the card when the saved history is drawn: renderHistory and soloHistoryDraw each end with one wrapped historyDrawn call', () => {
  const HD = 'FeatureCard.historyDrawn(';
  const n = (s) => s.split(HD).length - 1;
  const WRAPPED = /^\s*try \{ window\.FeatureCard && FeatureCard\.historyDrawn\(.*\); \} catch \{ \/\* cosmetic \*\/ \}/;
  const mobBody = bodyOf(read('mobile.js'), /function renderHistory\s*\(\)\s*\{/);
  const appBody = bodyOf(read('app.js'), /function soloHistoryDraw\s*\([^)]*\)\s*\{/);
  for (const [name, body, arg] of [['renderHistory', mobBody, "$('messages')"], ['soloHistoryDraw', appBody, 'document.getElementById(`messages-${chatId}`)']]) {
    assert.strictEqual(n(body), 1, name + ': one call');
    const line = body.split('\n').find((l) => l.includes(HD));
    assert.ok(WRAPPED.test(line), name + ': wrapped: ' + line.trim());
    assert.ok(line.includes(HD + arg + ')'), name + ': the right list');
  }
  assert.strictEqual(n(read('mobile.js')), 2);   // renderHistory, and openChat's early return for the same chat (its list keeps its messages)
  assert.ok(/if \(same && \(\(rec && bubbleLive\(rec\)\) \|\| \(ra && bubbleLive\(ra\)\)\)\) \{ paintChatStatus\(\); try \{ window\.FeatureCard && FeatureCard\.historyDrawn\(\$\('messages'\)\); \} catch/.test(read('mobile.js')), 'the same-chat early return signals drawn');
  assert.strictEqual(n(read('app.js')), 1);
  // renderHistory: the call is after the last thing the redraw does (the busy card paint); no early return after it
  assert.ok(mobBody.indexOf('paintBusyCard();') < mobBody.indexOf(HD));
  // soloHistoryDraw: after the history is drawn (the scroll is set), outside the "has history" branch, so an empty history signals too
  assert.ok(appBody.indexOf('panel.scrollTop = panel.scrollHeight') < appBody.indexOf(HD));
  assert.ok(appBody.indexOf('busyCardRefresh(chat);') < appBody.indexOf(HD));
});

test('the pages say before they empty a list to redraw it: historyDrawing just before each clear', () => {
  const app = read('app.js'); const mob = read('mobile.js');
  assert.ok(app.includes("if (panel0) { try { window.FeatureCard && FeatureCard.historyDrawing(panel0); } catch { /* cosmetic */ } panel0.textContent = ''; }"), 'desktop soloHistoryDraw reset');
  assert.ok(/function renderHistory\(\) \{\n  const box = chatEl\(\);\n  try \{ window\.FeatureCard && FeatureCard\.historyDrawing\(box\); \} catch \{ \/\* cosmetic \*\/ \}[^\n]*\n  box\.innerHTML = '';/.test(mob), 'phone renderHistory');
});
