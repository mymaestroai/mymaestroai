'use strict';
// The phone page folds turns the hub starts by itself into closed cards: the helper block is a byte-identical copy of
// lib/ui-auto-turns.js, and renderHistory, the live turn path, the menu item and the CSS are wired as designed.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const BEGIN = '// ── auto-turn helpers (begin) ──';
const END = '// ── auto-turn helpers (end) ──';
function helperBlock(src) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  assert.ok(a >= 0 && b > a, 'markers present');
  return src.slice(a + BEGIN.length, b).trim();
}

const js = read('mobile.js');
const html = read('mobile.html');

test('the helper block in mobile.js is byte-identical to lib/ui-auto-turns.js, top level, before the message-time helpers', () => {
  assert.strictEqual(helperBlock(js), helperBlock(read('lib/ui-auto-turns.js')));
  const block = js.slice(js.indexOf(BEGIN), js.indexOf(END));
  assert.ok(!/^[ \t]+(const AUTO_STACK_MIN|function auto)/m.test(block), 'declarations are not indented');
  assert.ok(js.indexOf(END) < js.indexOf('// The date and time under each message'), 'placed before the message-time comment');
  assert.match(js, /Shared verbatim with lib\/ui-auto-turns\.js \(test\/ui-auto-turns-phone\.test\.js keeps the two in step\)/);
});

test('renderHistory groups with autoGroupHistory when folding is on, and draws cards, stacks and entries', () => {
  const rh = js.slice(js.indexOf('function renderHistory()'), js.indexOf('function loadEarlier()'));
  assert.match(rh, /if \(foldAutoOn\(\)\)/);
  assert.match(rh, /autoGroupHistory\(chatHistory, start\)/);
  assert.match(rh, /renderEntry\(chatHistory\[it\.index\], times\[it\.index\]\)/);
  assert.match(rh, /renderAutoCard\(it, times\)/);
  assert.match(rh, /renderAutoStack\(it, times\)/);
  assert.match(rh, /for \(let i = start; i < chatHistory\.length; i\+\+\) renderEntry\(chatHistory\[i\], times\[i\]\)/, 'folding off renders every entry as before');
});

test('cards: header button with kind class, closed body, open entries after it under a "from" line', () => {
  assert.match(js, /`auto-card auto-card-\$\{autoCardKind\(it\.kind\)\}`/);
  assert.match(js, /setAttribute\('aria-expanded', 'false'\)/);
  assert.match(js, /body\.hidden = true/);
  assert.match(js, /`from \$\{label\}`/);
  assert.match(js, /addFromLine\(it\.label\); renderEntry\(chatHistory\[i\], times\[i\]\)/);
  assert.match(js, /withRenderTarget\(card\.body,/);
  assert.match(js, /function bubbleHost\(\) \{ return renderTarget \|\| chatEl\(\); \}/);
  assert.match(js, /it\.summary/, 'stack summary shown');
  assert.match(js, /'auto-stack'/);
  assert.match(js, /for \(const c of it\.cards\) renderAutoCard\(c, times, st\.body\)/);
});

test('live automatic turns draw into a closed card; for_owner moves the reply out of it', () => {
  const ts = js.slice(js.indexOf('function onTurnStart('), js.indexOf('function onTurnDelta('));
  assert.match(ts, /autoKindOfOrigin\(ev\.origin\)/);
  assert.match(ts, /'working…'/);
  assert.match(ts, /withRenderTarget\(card\.body, paint\)/);
  assert.match(js, /autoFirstLine\(reply\)/);
  assert.match(js, /on\('for_owner', onForOwner\)/);
  const fo = js.slice(js.indexOf('function moveReplyOut('), js.indexOf('function onTurnEnd('));
  assert.match(fo, /`from \$\{t\.card\.label\}`/);
  assert.match(fo, /anchor\.after\(from\)/);
  assert.match(fo, /from\.after\(t\.el\)/);
});

test('a for_owner that comes before the live card exists is kept and applied when the card registers', () => {
  assert.match(js, /const forOwnerPending = \{\}/);
  const fo = js.slice(js.indexOf('function onForOwner('), js.indexOf('function onTurnEnd('));
  assert.match(fo, /forOwnerPending\[ev\.turnId\] = \{ reason:[^}]*at: Date\.now\(\) \}/);
  assert.match(fo, /slice\(0, Math\.max\(0, ids\.length - 50\)\)/, 'capped');
  assert.match(fo, /moveReplyOut\(t\)/);
  const ts = js.slice(js.indexOf('function onTurnStart('), js.indexOf('function onTurnDelta('));
  assert.match(ts, /hubTurns\[ev\.turnId\] = t;\s*[^\n]*\n\s*if \(t\.card && forOwnerPending\[ev\.turnId\]\) \{ delete forOwnerPending\[ev\.turnId\]; moveReplyOut\(t\); \}/);
});

test('opening a chat during an automatic turn: the live turn adopts the history card of the same prompt', () => {
  const rh = js.slice(js.indexOf('function renderHistory()'), js.indexOf('function loadEarlier()'));
  assert.match(rh, /lastHistoryCard = null;/, 'reset at the start of renderHistory');
  assert.match(js, /lastHistoryCard = lastUser === undefined \? null : \{ wrap: card\.wrap, body: card\.body, line: card\.line, label: it\.label, prompt: chatHistory\[lastUser\]\.content, ts: chatHistory\[lastUser\]\.ts \|\| null, agent: current \}/);
  const ts = js.slice(js.indexOf('function onTurnStart('), js.indexOf('function onTurnDelta('));
  assert.match(ts, /samePrompt\(last\.content, ev\.message\)/, 'only on a duplicate of the history prompt');
  assert.match(ts, /samePrompt\(mem\.prompt, ev\.message\) && promptRecent\(mem\.ts, ev\.startedAt\) && cardIsLast\(mem\.wrap, raEl\)/);
  assert.match(ts, /for \(let i = chatHistory\.length - 1; i >= 0; i--\) if \(!chatHistory\[i\]\.inProgress\)/, 'last saved entry, not an inProgress one');
  assert.match(ts, /reattaches\.delete\(ev\.agent\)/, 'the re-attach waiting bubble is retired once the card shows the turn');
  assert.match(ts, /card = \{ wrap: mem\.wrap, body: mem\.body, line: mem\.line \};\s*card\.line\.textContent = 'working…'/);
  assert.match(ts, /card: card \? \{ \.\.\.card, label: info\.label \} : null/);
  const fn = js.slice(js.indexOf('function cardIsLast('), js.indexOf('function renderAutoCard('));
  assert.match(fn, /lastOf\(box\) === wrap/);
  assert.match(fn, /lastOf\(box\) === stack/);
});

test('cardIsLast: a card is reusable only when it ends the chat (or the last stack)', () => {
  const src = js.slice(js.indexOf('function cardIsLast('), js.indexOf('function renderAutoCard('));
  const box = { parentNode: null, isConnected: true, lastElementChild: null };
  const fn = new Function('chatEl', `${src}; return cardIsLast;`)(() => box);
  const mk = (parent) => ({ parentNode: parent, isConnected: true, lastElementChild: null });
  const a = mk(box), b = mk(box);
  box.lastElementChild = b;
  assert.strictEqual(fn(b), true);
  assert.strictEqual(fn(a), false);
  const stack = mk(box), body = mk(stack), c1 = mk(body), c2 = mk(body);
  body.lastElementChild = c2;
  box.lastElementChild = stack;
  assert.strictEqual(fn(c2), true);
  assert.strictEqual(fn(c1), false);
  box.lastElementChild = b;
  assert.strictEqual(fn(c2), false);
});

test('the moved card shows the prompt line at turn end, not the reply again', () => {
  assert.match(js, /t\.card\.line\.textContent = t\.card\.moved \? promptCardLine\(ev\.message \|\| t\.prompt, t\.card\.label\) : \(autoFirstLine\(reply\) \|\| t\.card\.label\)/);
  const src = js.slice(js.indexOf('function promptCardLine('), js.indexOf('function cardIsLast('));
  const fn = new Function('autoFirstLine', `${src}; return promptCardLine;`)((t) => String(t).split('\n').find(l => l.trim()) || '');
  assert.strictEqual(fn('Context\nTask:\nCheck the queue\nmore', 'Scheduled task'), 'Check the queue');
  assert.strictEqual(fn('no marker', 'Scheduled task'), 'Scheduled task');
  assert.strictEqual(fn(undefined, 'Scheduled task'), 'Scheduled task');
});

// toggleFoldAuto is run for real with stand-ins for the page's globals.
function runToggle({ hubTurns, streams = new Set(), reattaches = new Map(), current = 'agent-a' }) {
  const src = js.slice(js.indexOf('function toggleFoldAuto('), js.indexOf('function makeFoldHeader('));
  const calls = { render: 0, toast: [] };
  const store = {};
  const fn = new Function('$', 'localStorage', 'foldAutoOn', 'paintFoldMenu', 'hubTurns', 'streams', 'reattaches', 'current', 'renderHistory', 'scrollChat', 'toast',
    `let stick = false; ${src}; return toggleFoldAuto;`)(
    () => ({ classList: { remove() {} } }), { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
    () => store['hub-fold-auto'] !== 'off', () => {}, hubTurns, streams, reattaches, current, () => { calls.render++; }, () => {}, (m) => calls.toast.push(m));
  fn();
  return calls;
}
test('toggleFoldAuto does not redraw the chat while the phone follows a live hub turn of the open chat', () => {
  assert.match(js, /const following = Object\.values\(hubTurns\)\.some\(t => t && t\.agent === current && t\.el && t\.el\.isConnected\);/);
  assert.deepStrictEqual(runToggle({ hubTurns: { t1: { agent: 'agent-a', el: { isConnected: true } } } }), { render: 0, toast: ['Fold automatic turns: Off'] }, 'toast instead');
  assert.strictEqual(runToggle({ hubTurns: {} }).render, 1, 'nothing live: redraws');
  assert.strictEqual(runToggle({ hubTurns: { t1: { agent: 'agent-b', el: { isConnected: true } } } }).render, 1, 'another agent\'s turn does not block it');
  assert.strictEqual(runToggle({ hubTurns: { t1: { agent: 'agent-a', el: { isConnected: false } } } }).render, 1, 'a detached bubble is nothing to protect');
  assert.strictEqual(runToggle({ hubTurns: {}, streams: new Set(['agent-a']) }).render, 0, 'a stream still blocks it');
});

test('the per-device setting: hub-fold-auto key, default on, menu item wired', () => {
  assert.match(js, /localStorage\.getItem\('hub-fold-auto'\) !== 'off'/);
  assert.match(js, /localStorage\.setItem\('hub-fold-auto'/);
  assert.match(html, /id="menu-fold"/);
  assert.match(js, /\$\('menu-fold'\)\??\.addEventListener\('click', toggleFoldAuto\)/);
  assert.match(js, /Fold automatic turns: \$\{foldAutoOn\(\) \? 'On' : 'Off'\}/);
  const tg = js.slice(js.indexOf('function toggleFoldAuto('), js.indexOf('function makeFoldHeader('));
  assert.match(tg, /\$\('menu'\)\.classList\.remove\('open'\)/);
  assert.match(tg, /renderHistory\(\)/);
});

test('CSS: kind colours, left border, stack, from line', () => {
  assert.match(html, /\.auto-card-consult \{[^}]*#8b6fd6/);
  assert.match(html, /\.auto-card-schedule \{[^}]*#c9a227/);
  assert.match(html, /\.auto-card-notice \{[^}]*#8a8a85/);
  assert.match(html, /border-left: 3px solid/);
  assert.match(html, /\.auto-stack/);
  assert.match(html, /\.auto-from \{/);
  assert.match(html, /\.auto-body\[hidden\] \{ display: none; \}/);
});

test('the service worker is bumped so open phones load this page', () => {
  assert.match(read('sw.js'), /const VERSION = 'hub-mobile-v66'/);
});

test('samePrompt and promptRecent: clipped prompts match by start; stale or undated cards are not adopted', () => {
  const src = js.slice(js.indexOf('const TURN_CLIP_SUFFIX'), js.indexOf('// One automatic turn as a closed card;'));
  const { samePrompt, promptRecent } = new Function(`${src}; return { samePrompt, promptRecent };`)();
  assert.strictEqual(samePrompt('abc', 'abc'), true);
  assert.strictEqual(samePrompt('abc', 'abd'), false);
  const long = 'x'.repeat(13000);
  assert.strictEqual(samePrompt(long, long.slice(0, 12000) + '\n…[truncated]'), true);
  assert.strictEqual(samePrompt('y' + long, long.slice(0, 12000) + '\n…[truncated]'), false);
  assert.strictEqual(samePrompt(undefined, 'abc'), false);
  const t0 = '2026-01-01T10:00:00.000Z';
  assert.strictEqual(promptRecent('2026-01-01T09:55:00.000Z', t0), true);
  assert.strictEqual(promptRecent('2026-01-01T09:40:00.000Z', t0), false);
  assert.strictEqual(promptRecent(null, t0), false);
  assert.strictEqual(promptRecent(t0, undefined), false);
});

test('cardIsLast ignores the re-attach bubble drawn after the card', () => {
  const src = js.slice(js.indexOf('function cardIsLast('), js.indexOf('const TURN_CLIP_SUFFIX'));
  const box = { parentNode: null, isConnected: true, lastElementChild: null };
  const fn = new Function('chatEl', `${src}; return cardIsLast;`)(() => box);
  const card = { parentNode: box, isConnected: true, lastElementChild: null };
  const bubble = { parentNode: box, isConnected: true, previousElementSibling: card };
  box.lastElementChild = bubble;
  assert.strictEqual(fn(card), false);
  assert.strictEqual(fn(card, bubble), true);
});

test('moveReplyOut: a card inside a stack sends the reply after the stack, in the chat', () => {
  const src = js.slice(js.indexOf('function moveReplyOut('), js.indexOf('function onForOwner('));
  const mk = (parentNode) => ({ parentNode, isConnected: true, dataset: {}, after(x) { const c = this.parentNode.children; c.splice(c.indexOf(this) + 1, 0, x); x.parentNode = this.parentNode; } });
  const panel = { children: [], parentNode: null, isConnected: true };
  const stack = mk(panel); panel.children.push(stack);
  const body = mk(stack); body.children = [];
  const wrap = mk(body); body.children.push(wrap);
  const el = { parentNode: body, isConnected: true, dataset: {} };
  body.children.push(el);
  let from = null;
  const document = { createElement: () => (from = mk(null)) };
  const fn = new Function('chatOpenFor', 'chatEl', 'document', 'scrollChat', 'unhideHubTurn', `${src}; return moveReplyOut;`)(() => true, () => panel, document, () => {}, () => {});
  const t = { agent: 'a', el, card: { label: 'Lbl', wrap } };
  fn(t);
  assert.strictEqual(t.card.moved, true);
  assert.strictEqual(from.parentNode, panel);
  assert.strictEqual(el.parentNode, panel, 'a direct child of the chat, not the hidden body');
  const orphan = { agent: 'a', el, card: { label: 'L', wrap: mk(mk(null)) } };
  fn(orphan);
  assert.ok(!orphan.card.moved, 'not moved when the card is not in the chat');
});

test('samePrompt: only the hub\'s own clipping (12000 characters + the suffix) counts as a clipped prompt', () => {
  const src = js.slice(js.indexOf('const TURN_CLIP_SUFFIX'), js.indexOf('// A remembered card is adopted only when'));
  const fn = new Function(`${src}; return samePrompt;`)();
  const long = 'x'.repeat(12500);
  assert.strictEqual(fn('same', 'same'), true);
  assert.strictEqual(fn(long, long.slice(0, 12000) + '\n…[truncated]'), true);
  assert.strictEqual(fn('Please inspect the full log', 'Please inspect\n…[truncated]'), false, 'a short message that happens to end like the suffix');
  assert.strictEqual(fn('other', 'same'), false);
});

test('a retired re-attach: only of the same turn; reattachIfIdle never starts one next to a followed hub turn', () => {
  assert.match(js, /const raEl = ra && !ra\.text && ra\.bubble && \(!ra\.turnId \|\| ra\.turnId === ev\.turnId\) \? ra\.bubble\.el : null;/);
  assert.match(js, /if \(raEl\) \{ reasoningEnd\(ra\); raEl\.remove\(\); reattaches\.delete\(ev\.agent\); paintChatStatus\(\); retired = true; \}/);
  assert.match(js, /if \(retired\) catchUpOpenAgent\(\);/);
});

test('reattachIfIdle: a hub turn still on screen blocks a re-attach; a stale one (its bubble removed by a redraw) does not and is dropped', () => {
  const src = js.slice(js.indexOf('function followedHubTurn('), js.indexOf('// The open chat\'s agent is mid-turn on the server and this phone has no stream'))
    + js.slice(js.indexOf('function reattachIfIdle('), js.indexOf('\n}\n', js.indexOf('function reattachIfIdle(')) + 3);
  const run = (hubTurns) => {
    const entered = [];
    const fn = new Function('hubTurns', 'chatOpenFor', 'streams', 'reattaches', 'live', 'enterReattach', 'addAssistantBubble', 'busyCardInfo',
      `${src}; return reattachIfIdle;`)(hubTurns, () => true, new Map(), new Map(), { sam: { busy: true } }, (a) => entered.push(a), () => ({}), () => null);
    fn('sam');
    return entered.length;
  };
  assert.strictEqual(run({ t1: { agent: 'sam', el: { isConnected: true } } }), 0, 'followed on screen: no re-attach');
  const stale = { t1: { agent: 'sam', el: { isConnected: false } } };
  assert.strictEqual(run(stale), 1, 'stale entry: the re-attach starts');
  assert.ok(!stale.t1, 'and the stale entry is dropped so live events reach the re-attach');
  assert.strictEqual(run({ t2: { agent: 'other', el: { isConnected: true } } }), 1, 'another agent\'s turn does not block it');
  assert.match(js, /if \(current && map\[current\] && map\[current\]\.busy && !followedHubTurn\(current\)\) reattachIfIdle\(current\);/);
});
