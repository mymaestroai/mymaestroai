'use strict';
// The desktop page folds the turns the hub starts by itself into closed cards (lib/ui-auto-turns.js makes the groups;
// app.js carries a byte-identical copy of the helpers and draws the cards, the stacks and the live turns).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const BEGIN = '// ── auto-turn helpers (begin) ──';
const END = '// ── auto-turn helpers (end) ──';
function helperBlock(src, indent) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  assert.ok(a > 0 && b > a, 'helper markers present');
  return src.slice(a + BEGIN.length, b).split('\n').map(l => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n').trim();
}
function block(src, from, to) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `${from} not found`);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, `${to} not found after ${from}`);
  return src.slice(a, b);
}
const app = read('app.js');
const html = read('index.html');

test('app.js carries the helpers byte for byte', () => {
  assert.strictEqual(helperBlock(app, '    '), helperBlock(read('lib/ui-auto-turns.js'), ''));
  assert.match(app, /Shared with lib\/ui-auto-turns\.js; test\/ui-auto-turns-desktop\.test\.js keeps the copies in step\./);
});

test('history: folding on goes through autoGroupHistory; entries, cards and stacks are drawn', () => {
  const loop = block(app, 'if (foldAutoOn()) {', '// Scroll to bottom after loading history');
  assert.match(loop, /autoGroupHistory\(history\)/);
  assert.match(loop, /draw\(item\.index\)/);
  assert.match(loop, /item\.type === 'entry'/);
  assert.match(loop, /item\.type === 'card'/);
  assert.match(loop, /foldRenderHistoryStack\(/);
  assert.match(loop, /history\.entries\(\)/, 'folding off keeps every entry in full');
  assert.match(app, /document\.getElementById\(`messages-\$\{chatId\}`\);\s*if \(panel && !keepScroll\) setTimeout\(\(\) => panel\.scrollTop = panel\.scrollHeight, 100\)/, 'still lands at the bottom');
});

test('cards: class per kind, aria-expanded header, hidden body, every entry still pushed in order', () => {
  assert.match(app, /className = `auto-card auto-card-\$\{autoCardKind\(c\.kind\)\}`/);
  const card = block(app, 'function foldBuildCard(', 'function foldFromLine(');
  assert.match(card, /auto-card-label/);
  assert.match(card, /auto-card-time/);
  assert.match(card, /auto-card-line/);
  assert.match(card, /auto-card-chev/);
  assert.match(app, /setAttribute\('aria-expanded'/);
  assert.match(app, /body\.hidden = true/);
  const render = block(app, 'function foldRenderHistoryCard(', 'function foldRenderHistoryStack(');
  assert.match(render, /for \(const k of c\.indexes\)/);
  assert.match(render, /show: false/, 'open entries reach chat.messages too (pushed in order)');
  assert.match(render, /into: built\.body/, 'the rest is drawn in the closed body');
  const entry = block(app, 'const draw = (i,', 'const panelEl');
  assert.match(entry, /chats\[chatId\]\.messages\.push\(/);
  for (const call of ['appendMessage(', 'paintSavedActivity(', 'setReasoning(', 'setMessageTime(']) assert.ok(entry.includes(call), call);
  assert.match(app, /function appendMessage\(chatId, role, content, into\)/);
  assert.match(app, /\(into \|\| container\)\.appendChild\(div\)/);
});

test('marked replies show open after the card under a "from <label>" line', () => {
  const render = block(app, 'function foldRenderHistoryCard(', 'function foldRenderHistoryStack(');
  assert.match(render, /for \(const k of c\.open\)/);
  assert.match(render, /foldFromLine\(c\.label\)/);
  assert.match(app, /`from \$\{label\}`/);
});

test('stacks: the summary is the header; the cards are inside', () => {
  const stack = block(app, 'function foldRenderHistoryStack(', 'const hubTurns = {}');
  assert.match(stack, /s\.summary/);
  assert.match(stack, /auto-stack/);
  assert.match(stack, /for \(const c of s\.cards\)/);
});

test('live hub turns: autoKindOfOrigin picks the card; the reply bubble draws inside; turn_end sets the line', () => {
  const start = block(app, 'async function onHubTurnStart(', 'function onHubTurnDelta(');
  assert.match(start, /foldAutoOn\(\) \|\| hubMain \? autoKindOfOrigin\(ev\.origin\)/);
  assert.match(start, /autoInfoOf\(\{ role: 'user', origin: ev\.origin/);
  assert.match(start, /'working…'/);
  assert.match(start, /appendMessage\(chat\.id, 'assistant', '…', card && card\.body\)/);
  assert.match(start, /if \(!card\) appendSystemNotice/);
  assert.match(block(app, 'function onHubTurnEnd(', 'Context compression'), /t\.card\.setLine\(t\.card\.moved \? foldPromptLine\(ev\.message \|\| t\.prompt\) : autoFirstLine\(reply\)\)/);
});

test('a for_owner that comes before the live card exists is kept and applied when the card registers', () => {
  assert.match(app, /const hubForOwnerPending = \{\}/);
  const h = block(app, 'function onHubForOwner(', 'function onHubTurnEnd(');
  assert.match(h, /hubForOwnerPending\[ev\.turnId\] = \{ reason:[^}]*at: Date\.now\(\) \}/);
  assert.match(h, /slice\(0, Math\.max\(0, ids\.length - 50\)\)/, 'capped');
  const start = block(app, 'async function onHubTurnStart(', 'function onHubTurnDelta(');
  const reg = start.slice(start.indexOf('hubTurnCards[ev.turnId] = card;'));
  assert.match(reg, /hubForOwnerPending\[ev\.turnId\]\) \{ delete hubForOwnerPending\[ev\.turnId\]; hubMoveReplyOut\(card\); \}/);
  assert.ok(start.indexOf('card.msgId = msgId') < start.indexOf('hubMoveReplyOut(card)'), 'msgId is set before the move');
  const mv = block(app, 'function hubMoveReplyOut(', 'function onHubForOwner(');
  assert.match(mv, /card\.moved = true/);
  assert.match(mv, /foldFromLine\(card\.label\)/);
});

test('opening a chat during an automatic turn: the live turn adopts the history card of the same prompt', () => {
  const loop = block(app, 'chats[chatId].lastAutoCard = null;', '// Scroll to bottom after loading history');
  assert.match(loop, /lastAutoCard = k === undefined \? null : \{ card: built, prompt: history\[k\]\.content, label: c\.label, ts: history\[k\]\.ts \|\| null \}/);
  assert.match(loop, /foldRenderHistoryCard\(draw, item, panelEl, remember\)/);
  assert.match(loop, /foldRenderHistoryStack\(draw, item, panelEl, remember\)/);
  const start = block(app, 'async function onHubTurnStart(', 'function onHubTurnDelta(');
  assert.match(start, /foldSamePrompt\(mem\.prompt, ev\.message\)/);
  assert.match(start, /const dup = typeof ev\.message === 'string' && !!last && last\.role === 'user' && foldSamePrompt\(last\.content, ev\.message\)/, 'only on a duplicate of the history prompt');
  assert.match(start, /foldPromptRecent\(mem\.ts, ev\.startedAt\)/);
  assert.match(start, /foldCardIsLast\(panel, mem\.card, raEl\)/);
  assert.match(start, /delete chat\.reattach/, 'a re-attach waiting bubble is retired once the card shows the turn');
  assert.match(start, /card = mem\.card;\s*card\.setLine\('working…'\)/);
  assert.match(start, /card\.label = info\.label; card\.chatId = chat\.id;/);
  const last = block(app, 'function foldCardIsLast(', 'function foldRenderHistoryStack(');
  assert.match(last, /lastOf\(panel\) === w/);
  assert.match(last, /lastOf\(panel\) === stack/);
});

test('foldCardIsLast: a card is reusable only when it ends the panel (or the last stack)', () => {
  const src = block(app, 'function foldCardIsLast(', 'function foldRenderHistoryStack(');
  const fn = new Function(`${src}; return foldCardIsLast;`)();
  const mk = (parent, kids = []) => ({ parentNode: parent, isConnected: true, lastElementChild: kids[kids.length - 1] || null });
  const panel = { parentNode: null, isConnected: true, lastElementChild: null };
  const a = mk(panel), b = mk(panel);
  panel.lastElementChild = b;
  assert.strictEqual(fn(panel, { wrap: b }), true);
  assert.strictEqual(fn(panel, { wrap: a }), false, 'an older card is never reused');
  const stack = mk(panel), body = mk(stack), c1 = mk(body), c2 = mk(body);
  body.lastElementChild = c2; stack.body = body; stack.lastElementChild = body;
  panel.lastElementChild = stack;
  assert.strictEqual(fn(panel, { wrap: c2 }), true);
  assert.strictEqual(fn(panel, { wrap: c1 }), false);
  panel.lastElementChild = b;
  assert.strictEqual(fn(panel, { wrap: c2 }), false, 'the stack is not last');
  assert.strictEqual(fn(panel, { wrap: { ...b, isConnected: false } }), false);
});

test('foldPromptLine: the text after the Task marker, else empty (the card label then shows)', () => {
  const src = block(app, 'function foldPromptLine(', 'function foldCardIsLast(');
  const fn = new Function('autoFirstLine', `${src}; return foldPromptLine;`)((t) => String(t).split('\n').find(l => l.trim()) || '');
  assert.strictEqual(fn('Context line\nTask:\nSummarise the notes\nmore'), 'Summarise the notes');
  assert.strictEqual(fn('no marker here'), '');
  assert.strictEqual(fn(undefined), '');
});

test('for_owner event: subscribed, and the reply moves out of the card with the from line', () => {
  assert.match(app, /addEventListener\('for_owner', e => \{ const ev = parse\(e\); if \(ev\) onHubForOwner\(ev\); \}\)/);
  const h = block(app, 'function hubMoveReplyOut(', 'function onHubTurnEnd(');
  assert.match(h, /hubTurnCards\[ev\.turnId\]/);
  assert.match(h, /foldFromLine\(card\.label\)/);
  assert.match(h, /anchor\.after\(line\)/);
  assert.match(h, /line\.after\(el\)/);
});

test('setting: key hub-fold-auto, default on, Chat section in Settings', () => {
  assert.match(app, /function foldAutoOn\(\) \{ try \{ return localStorage\.getItem\('hub-fold-auto'\) !== 'off'; \} catch \{ return true; \} \}/);
  assert.match(app, /localStorage\.setItem\('hub-fold-auto', on \? 'on' : 'off'\)/);
  assert.match(app, /sections: \[[^\]]*'st-chat-section'\]/);
  const sec = block(app, 'id="st-chat-section"', 'id="st-emergency-section"');
  assert.match(sec, /<h4>Chat<\/h4>/);
  assert.match(sec, /type="checkbox"/);
  assert.match(sec, /Fold consultations, scheduled tasks and hub notices into cards/);
  assert.match(sec, /This browser only\. Turn it off to show every automatic turn in full\./);
});

test('CSS: kind colours, compact header, hidden body, muted from line', () => {
  assert.match(html, /\.auto-card-consult \{[^}]*#8b6fd6/);
  assert.match(html, /\.auto-card-schedule \{[^}]*#c9a227/);
  assert.match(html, /\.auto-card-notice \{[^}]*#8a8a85/);
  assert.match(html, /\.auto-card-head, \.auto-stack-head \{[^}]*border-left: 3px solid var\(--auto-color\)/);
  assert.match(html, /\.auto-card-body\[hidden\]/);
  assert.match(html, /\.auto-from \{/);
});

test('the grouping used by the page puts consultations, tasks and notices in cards, with marked replies open', () => {
  const lib = require('../lib/ui-auto-turns');
  const h = [
    { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'q', origin: { kind: 'consultation', from: 'lead' } },
    { role: 'assistant', content: 'answer', for_owner: true, for_owner_reason: 'x' },
    { role: 'user', content: 'run', origin: { kind: 'schedule', from: 'Daily review' } }, { role: 'assistant', content: 'done' },
  ];
  const items = lib.autoGroupHistory(h, 0);
  assert.deepStrictEqual(items.map(i => i.type), ['entry', 'entry', 'card', 'card']);
  assert.strictEqual(items[2].label, 'Consultation from lead');
  assert.deepStrictEqual(items[2].open, [3]);
});

test('the remembered card carries the prompt time', () => {
  assert.match(app, /label: c\.label, ts: history\[k\]\.ts \|\| null \}/);
});

test('chat.messages never holds an inProgress entry, so onHubTurnStart `last` is a saved entry', () => {
  const load = block(app, 'for (const msg of history) {', 'const draw = (i,');
  assert.match(load, /if \(msg\.inProgress\) \{[^}]*\}[^}]*\}?\s*continue;\s*\}/);
  assert.match(app, /for \(const \[i, msg\] of history\.entries\(\)\) \{\s*if \(!msg\.inProgress\) draw\(i\);/);
  assert.match(block(app, 'async function onHubTurnStart(', 'function onHubTurnDelta('), /never holds an inProgress entry/);
});

test('foldSamePrompt: whole prompt, or the clipped start when the hub cut the message', () => {
  const src = block(app, 'const FOLD_CLIP_SUFFIX', 'function foldRenderHistoryStack(');
  const { foldSamePrompt, foldPromptRecent } = new Function(`${src}; return { foldSamePrompt, foldPromptRecent };`)();
  assert.strictEqual(foldSamePrompt('abc', 'abc'), true);
  assert.strictEqual(foldSamePrompt('abc', 'abd'), false);
  const long = 'x'.repeat(13000);
  assert.strictEqual(foldSamePrompt(long, long.slice(0, 12000) + '\n…[truncated]'), true);
  assert.strictEqual(foldSamePrompt('y' + long, long.slice(0, 12000) + '\n…[truncated]'), false);
  assert.strictEqual(foldSamePrompt(undefined, 'abc'), false);
  const t0 = '2026-01-01T10:00:00.000Z';
  assert.strictEqual(foldPromptRecent('2026-01-01T09:55:00.000Z', t0), true);
  assert.strictEqual(foldPromptRecent('2026-01-01T09:40:00.000Z', t0), false, 'older than 10 minutes');
  assert.strictEqual(foldPromptRecent(null, t0), false);
  assert.strictEqual(foldPromptRecent(t0, undefined), false);
});

test('foldCardIsLast ignores the re-attach bubble drawn after the card', () => {
  const src = block(app, 'function foldCardIsLast(', 'const FOLD_CLIP_SUFFIX');
  const fn = new Function(`${src}; return foldCardIsLast;`)();
  const panel = { parentNode: null, isConnected: true, lastElementChild: null };
  const card = { parentNode: panel, isConnected: true, lastElementChild: null };
  const bubble = { parentNode: panel, isConnected: true, previousElementSibling: card };
  panel.lastElementChild = bubble;
  assert.strictEqual(fn(panel, { wrap: card }), false, 'a stray element after the card');
  assert.strictEqual(fn(panel, { wrap: card }, bubble), true, 'the re-attach bubble is skipped');
});

test('hubMoveReplyOut: a card inside a stack sends the reply after the stack, in the panel', () => {
  const src = block(app, 'function hubMoveReplyOut(', 'function onHubForOwner(');
  const mk = (parentNode) => {
    const n = { parentNode, isConnected: true, dataset: {}, after(x) { const sib = this.parentNode.children; sib.splice(sib.indexOf(this) + 1, 0, x); x.parentNode = this.parentNode; } };
    return n;
  };
  const panel = { children: [], parentNode: null, isConnected: true };
  const stack = mk(panel); panel.children.push(stack);
  const body = mk(stack); body.children = [];
  const wrap = mk(body); body.children.push(wrap); wrap.classList = { remove() {} };
  const reply = { id: 'm1', parentNode: body, isConnected: true, dataset: {} };
  body.children.push(reply);
  const line = mk(null);
  const card = { chatId: 'c1', msgId: 'm1', label: 'Lbl', wrap };
  const doc = { getElementById: (id) => (id === 'messages-c1' ? panel : id === 'm1' ? reply : null) };
  const fn = new Function('chats', 'document', 'foldFromLine', `${src}; return hubMoveReplyOut;`)({ c1: {} }, doc, () => line);
  fn(card);
  assert.strictEqual(card.moved, true);
  assert.strictEqual(line.parentNode, panel);
  assert.strictEqual(reply.parentNode, panel, 'a direct child of the panel, not the hidden body');
  // detached from the panel: nothing moves
  const orphan = { chatId: 'c1', msgId: 'm1', label: 'L', wrap: Object.assign(mk(mk(null)), { classList: { remove() {} } }) };
  fn(orphan);
  assert.ok(!orphan.moved);
});

test('a retired re-attach: only of the same turn, clears this browser\'s busy mark and catches the card up', () => {
  assert.match(app, /const raSame = chat\.reattach && !chat\.reattach\.content && \(!chat\.reattach\.turnId \|\| chat\.reattach\.turnId === ev\.turnId\);/);
  const start = block(app, 'async function onHubTurnStart(', 'setStatus(chat.id, \'thinking\'');
  assert.match(start, /if \(raSame\) \{[^}]*setAgentStatus\(chat\.agent, ''\);[^}]*retiredReattach = true;/);
  assert.match(start, /if \(retiredReattach\) catchUpTurn\(chat\.id\);/);
});

test('foldSamePrompt: only the hub\'s own clipping (12000 characters + the suffix) counts as a clipped prompt', () => {
  const src = block(app, 'const FOLD_CLIP_SUFFIX', '// A remembered card is adopted only when');
  const fn = new Function(`${src}; return foldSamePrompt;`)();
  const long = 'y'.repeat(12500);
  assert.strictEqual(fn(long, long.slice(0, 12000) + '\n…[truncated]'), true);
  assert.strictEqual(fn('Please inspect the full log', 'Please inspect\n…[truncated]'), false);
  assert.strictEqual(fn('a', 'a'), true);
});
