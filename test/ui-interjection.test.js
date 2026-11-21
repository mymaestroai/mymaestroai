'use strict';
// An interjection (a message sent while the agent is mid-reply) is saved in the chat history as a user line marked
// `interjection`. The pages draw it as the person's own bubble with the words only, marked as an interjection (an
// emergency one with an emergency marker), and the running turn's view draws it in its place in the reply.
// lib/ui-interjection.js holds the history reader; app.js and mobile.js carry byte-identical copies between the markers.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { interjectionView } = require('../lib/ui-interjection');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const BEGIN = '// ── interjection helpers (begin) ──';
const END = '// ── interjection helpers (end) ──';
function helperBlock(src, indent) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  assert.ok(a > 0 && b > a, 'helper markers present');
  return src.slice(a + BEGIN.length, b).split('\n').map(l => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n').trim();
}
// One named function out of a page's source, by brace matching (the functions used here hold no braces in strings).
function fnSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is in the page`);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(start, i + 1);
}
const load = (src, names, ctx = {}) => { const c = vm.createContext({ ...ctx }); vm.runInContext(names.map(n => fnSource(src, n)).join('\n') + `\nthis.api = { ${names.join(', ')} };`, c); return c.api; };

const IJ = (content, extra = {}) => ({ ts: '2026-11-14T12:00:00Z', role: 'user', content, interjection: { id: 'ij-1', transport: 'sdk-live', ...extra } });

test('the interjection helper is byte-identical in lib/ui-interjection.js, app.js and mobile.js', () => {
  const lib = helperBlock(read('lib/ui-interjection.js'), '');
  assert.strictEqual(helperBlock(read('app.js'), '    '), lib, 'app.js copy differs from lib/ui-interjection.js');
  assert.strictEqual(helperBlock(read('mobile.js'), ''), lib, 'mobile.js copy differs from lib/ui-interjection.js');
});

test('interjectionView: the words after the [LABEL]: prefix; an emergency one is told apart; other entries are not interjections', () => {
  assert.deepStrictEqual({ ...interjectionView(IJ('[OPERATOR INTERJECTION]: use last quarter')) }, { text: 'use last quarter', emergency: false });
  assert.deepStrictEqual({ ...interjectionView(IJ('[EMERGENCY INTERJECTION]: stop now', { priority: 'emergency' })) }, { text: 'stop now', emergency: true });
  assert.strictEqual(interjectionView(IJ('[EMERGENCY INTERJECTION]: label alone says it')).emergency, true);
  assert.strictEqual(interjectionView(IJ('[OPERATOR INTERJECTION]: line one\nline two [x]: y')).text, 'line one\nline two [x]: y', 'multi-line words and later brackets stay');
  assert.strictEqual(interjectionView(IJ('no prefix at all')).text, 'no prefix at all');
  assert.strictEqual(interjectionView({ role: 'user', content: '[OPERATOR INTERJECTION]: typed by hand' }), null, 'no `interjection` mark: an ordinary message');
  assert.strictEqual(interjectionView({ role: 'assistant', content: 'x', interjection: { id: 'a' } }), null);
  assert.strictEqual(interjectionView(null), null);
});

test('desktop history draws an interjection as the person\'s bubble with the live send\'s marker (emergency marked), not the raw prefix', () => {
  const app = read('app.js');
  assert.ok(app.includes("const ijView = interjectionView(msg);"), 'the history renderer asks the helper');
  assert.ok(app.includes('appendMessage(chatId, msg.role, ijView ? interjectionBubbleText(ijView) : msg.content, into)'), 'and draws the bubble from it');
  const { interjectionBubbleText } = load(app, ['interjectionBubbleText']);
  assert.strictEqual(interjectionBubbleText({ text: 'hurry', emergency: false }), '⚡ [Interjection] hurry', 'the same marker sendInterjection shows');
  assert.ok(app.includes('appendMessageWithImages(chatId, \'user\', `⚡ [Interjection] ${content}`.trim(), imagesToSend)'), 'the live send still uses that marker (and draws its pictures)');
  assert.match(interjectionBubbleText({ text: 'stop', emergency: true }), /^🚨 \[Emergency interjection\] stop$/);
});

test('phone history draws an interjection as the person\'s bubble followed by the interjection note (emergency marked)', () => {
  const mob = read('mobile.js');
  const entry = fnSource(mob, 'renderEntry');
  assert.ok(entry.includes('const ij = interjectionView(m);'));
  assert.ok(entry.includes('setBubbleTime(addUserBubble(ij ? ij.text : m.content, savedImageUrls(m.images)), time);'), 'the words only, no prefix (and the saved pictures)');
  assert.ok(entry.includes("addNote(ij.emergency ? '🚨 emergency interjection' : '⤵ interjection').classList.add('interject')"), 'the note style of the live send');
  assert.ok(mob.includes("const noteEl = addNote('⤵ delivering mid-turn…');") && mob.includes("noteEl.classList.add('interject');"), 'the live send\'s note is the same style');
  // run it: the bubble text and the note
  const added = [];
  const api = load(mob, ['savedImageUrls', 'renderEntry'], {
    interjectionView, originLabel: () => '', timeLabel: () => '', setBubbleTime: () => {},
    addNote: (t) => { const n = { text: t, classList: { add: (c) => { n.cls = c; } } }; added.push(n); return n; },
    addUserBubble: (t) => { added.push({ bubble: t }); return {}; },
    addAssistantBubble: () => ({ el: {} }), paintSaved: () => {}, reasoningSet: () => {}, current: 'x',
  });
  api.renderEntry(IJ('[OPERATOR INTERJECTION]: use last quarter'));
  api.renderEntry(IJ('[EMERGENCY INTERJECTION]: stop', { priority: 'emergency' }));
  api.renderEntry({ role: 'user', content: 'plain message' });
  assert.deepStrictEqual(added.map(a => a.bubble ?? `${a.text}|${a.cls}`), ['use last quarter', '⤵ interjection|interject', 'stop', '🚨 emergency interjection|interject', 'plain message']);
});

test('the phone drops every in-progress line of the running turn from the history it draws, and joins the pieces for the live turn', () => {
  const mob = read('mobile.js');
  assert.ok(mob.includes('const flagged = chatHistory.filter(e => e && e.inProgress);'));
  assert.ok(mob.includes('chatHistory = chatHistory.filter(e => !(e && e.inProgress));'));
  assert.doesNotMatch(mob, /chatHistory\[chatHistory\.length - 1\]\.inProgress \? chatHistory\.pop\(\)/, 'no longer only a last entry');
  // the re-read of history too (before the paged merge with older pages already loaded)
  assert.ok(mob.includes('hist = hist.filter(e => !(e && e.inProgress));'), 'the re-read of history too');
  assert.doesNotMatch(mob, /hist\[hist\.length - 1\]\.inProgress\) hist\.pop\(\)/, 'the re-read drops every flagged line, not only a last one');
  const app = read('app.js');
  assert.ok(app.includes("(msg.base > 0 && prev ? prev.text : '') + (msg.content || '')"), 'the desktop joins the flagged pieces for the re-attach\'s text so far');
});

test('desktop live turn: an interjection item is drawn in its place in the reply text, with the marker; tool rows do not take it', () => {
  const app = read('app.js');
  const { turnSteps, turnToolActivity } = load(app, ['turnSteps', 'turnToolActivity'], { toolResultDenied: () => false });
  const items = new Map([
    ['a1', { tool: 'Bash', input: 'ls', output: 'x', done: true, at: 5 }],
    ['a2', { ij: { text: 'hurry', emergency: false }, done: true, at: 10 }],
    ['a3', { ij: { text: 'stop', emergency: true }, done: true, at: 10 }],
  ]);
  const t = { items };
  const steps = turnSteps(t, 'Part one. Part two.');
  assert.deepStrictEqual(Array.from(steps, s => s.text), ['Part ', 'one. ', 'Part two.']);
  assert.deepStrictEqual(Array.from(steps, s => Array.from(s.ijs || [], i => i.text)), [[], ['hurry', 'stop'], []], 'both interjections after the text they interrupted, the reply goes on in the next step');
  assert.strictEqual(steps[0].tools.length, 1);
  assert.deepStrictEqual(Array.from(turnToolActivity(t), x => x.type), ['call', 'result'], 'the interjections are not tool rows');
  // the page's activity apply turns the hub's item into that shape
  const apply = fnSource(app, 'turnActivityApply');
  assert.ok(apply.includes("if (item.kind === 'interjection')") && apply.includes('ij: { text: String(item.message || \'\'), emergency: item.priority === \'emergency\', images: savedImageUrls(item.images) }'));
  assert.ok(app.includes("else if (kind === 'tool' || kind === 'interjection') paintTurn(h.chatId, h.t, h.t.text);"), 'a followed turn repaints when one comes');
  assert.ok(app.includes("for (const ij of step.ijs || []) html += `<div class=\"step-interjection\""), 'renderSteps draws the marker');
});

test('phone live turn: interjections are laid out among the text and tool groups by their place in the reply', () => {
  const mob = read('mobile.js');
  const { replyBlocks } = load(mob, ['replyBlocks']);
  const holder = { feed: {
    items: new Map([['t1', { kind: 'tool', id: 't1', at: 3 }], ['t2', { kind: 'tool', id: 't2', at: 14 }]]),
    ijs: new Map([['a9', { kind: 'ij', id: 'a9', text: 'hurry', emergency: false, at: 8 }]]),
  } };
  const blocks = replyBlocks(holder, 'One. Two. Three. Four.');
  assert.deepStrictEqual(Array.from(blocks, b => b.type === 'text' ? `text ${b.from}-${b.to}` : b.type === 'ij' ? `ij ${b.ij.text}` : `group ${b.items.map(i => i.id)}`),
    ['text 0-3', 'group t1', 'text 3-8', 'ij hurry', 'text 8-14', 'group t2', 'text 14-22']);
  // no tool rows at all: text, the interjection, the rest
  const only = { feed: { items: new Map(), ijs: new Map([['a1', { kind: 'ij', id: 'a1', text: 'x', at: 5 }]]) } };
  assert.deepStrictEqual(Array.from(replyBlocks(only, 'Hello world'), b => b.type), ['text', 'ij', 'text']);
  // an interjection before any reply text: it leads, the reply follows
  const first = { feed: { items: new Map(), ijs: new Map([['a1', { kind: 'ij', id: 'a1', text: 'x', at: 0 }]]) } };
  assert.deepStrictEqual(Array.from(replyBlocks(first, 'Hello'), b => b.type), ['ij', 'text']);
  // the layout paints the marker and the interjection note
  assert.ok(mob.includes("b.el.className = b.type === 'ij' ? 'seg ij-seg' : 'seg';"));
  assert.ok(mob.includes("note.textContent = b.ij.emergency ? '🚨 emergency interjection' : '⤵ interjection';"));
  assert.ok(mob.includes("if (item.kind === 'interjection') {"), 'the activity feed takes the hub\'s item');
  assert.ok(read('mobile.html').includes('.ij-seg {'), 'and the page styles it');
});
