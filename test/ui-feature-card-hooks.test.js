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
  assert.strictEqual(count(bodyOf(src, /function soloHistoryDraw\s*\(/)), 0);
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
