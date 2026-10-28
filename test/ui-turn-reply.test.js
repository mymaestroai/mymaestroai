'use strict';
// A page that re-attaches to a turn reads the reply back from the hub's saved history. A reply that asks a question
// is saved in pieces around the question and answer lines (marked `ask`); the re-attach used to take the first
// assistant entry after the person's message, which is the question, and showed it as the reply (2026-10-28).
// lib/ui-turn-reply.js holds the helpers; app.js and mobile.js carry byte-identical copies between the markers.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { turnReplyFrom, turnReplySince } = require('../lib/ui-turn-reply');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const BEGIN = '// ── turn-reply helpers (begin) ──';
const END = '// ── turn-reply helpers (end) ──';
function helperBlock(src, indent) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  assert.ok(a > 0 && b > a, 'helper markers present');
  return src.slice(a + BEGIN.length, b).split('\n').map(l => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n').trim();
}

// What the hub saves for a reply that asks a question (lib/sdk-chat.js appendConversationLog, runAskUser).
const t = (s) => `2026-10-28T12:00:${String(s).padStart(2, '0')}.000Z`;
const ASKED = [
  { ts: t(0), role: 'user', content: 'push it' },
  { ts: t(1), role: 'assistant', content: '❓ Release it to stable? [Release to stable / Not yet]', ask: true },
  { ts: t(2), role: 'assistant', content: 'Nothing is unpushed. ' },
  { ts: t(20), role: 'user', content: '↳ Release to stable', ask: true },
  { ts: t(40), role: 'assistant', content: '\n\nReleased 5.8.1.', base: 21, reasoning: 'checked the tag' },
];

test('the turn-reply helpers are byte-identical in lib/ui-turn-reply.js, app.js and mobile.js', () => {
  const lib = helperBlock(read('lib/ui-turn-reply.js'), '');
  assert.strictEqual(helperBlock(read('app.js'), '    '), lib, 'app.js copy differs from lib/ui-turn-reply.js');
  assert.strictEqual(helperBlock(read('mobile.js'), ''), lib, 'mobile.js copy differs from lib/ui-turn-reply.js');
});

test('both re-attach checks read the reply with the helpers, not the first assistant entry', () => {
  const app = read('app.js'), mob = read('mobile.js');
  assert.ok(app.includes('let reply = ui >= 0 ? turnReplyFrom(history, ui + 1, userTs) : null;'), 'desktop: anchored on the message');
  assert.ok(app.includes("reply = turnReplySince(history, Date.parse(ra.since) - 2000);"), 'desktop: since the turn began');
  assert.ok(mob.includes('reply = turnReplyFrom(hist, ui + 1, hist[ui].ts ? new Date(hist[ui].ts).getTime() : 0);'), 'phone: anchored');
  assert.ok(mob.includes('reply = turnReplySince(hist, new Date(ra.since).getTime() - 2000);'), 'phone: since');
  assert.doesNotMatch(app, /history\.slice\(ui \+ 1\)\.find\(m => m\.role === 'assistant'/);
  assert.doesNotMatch(mob, /hist\.slice\(ui \+ 1\)\.find\(m => m\.role === 'assistant'/);
});

test('a reply that asked a question: the pieces joined, without the question and answer lines', () => {
  const r = turnReplyFrom(ASKED, 1, Date.parse(t(0)));
  assert.strictEqual(r.content, 'Nothing is unpushed. \n\nReleased 5.8.1.');
  assert.strictEqual(r.reasoning, 'checked the tag', 'reasoning and flags come from the newest piece');
});

test('waiting on the question: no reply yet (the question itself is never taken for one)', () => {
  assert.strictEqual(turnReplyFrom(ASKED.slice(0, 2), 1, Date.parse(t(0))), null);
  // the text before the question, saved while the turn runs: progress (inProgress keeps the page waiting)
  const r = turnReplyFrom([ASKED[0], ASKED[1], { ...ASKED[2], inProgress: true }], 1, 0);
  assert.strictEqual(r.content, 'Nothing is unpushed. ');
  assert.strictEqual(r.inProgress, true);
});

test('a plain reply, the next turn, and entries saved before the message', () => {
  const plain = [{ ts: t(0), role: 'user', content: 'hi' }, { ts: t(5), role: 'assistant', content: 'Hello.', inProgress: true }];
  assert.deepStrictEqual(turnReplyFrom(plain, 1, Date.parse(t(0))), plain[1]);
  const two = [...plain, { ts: t(9), role: 'user', content: 'next' }, { ts: t(10), role: 'assistant', content: 'Other turn.' }];
  assert.strictEqual(turnReplyFrom(two, 1, 0).content, 'Hello.', 'stops at the next message the person sent');
  const early = [{ ts: t(0), role: 'user', content: 'hi' }, { ts: '2026-10-28T11:59:00.000Z', role: 'assistant', content: 'older' }, { ts: t(5), role: 'assistant', content: 'Hello.' }];
  assert.strictEqual(turnReplyFrom(early, 1, Date.parse(t(0))).content, 'Hello.');
  assert.strictEqual(turnReplyFrom([], 0, 0), null);
});

test('turnReplySince: the newest reply since the turn began, in pieces, not an older turn', () => {
  const hist = [{ ts: '2026-10-28T11:00:00.000Z', role: 'user', content: 'earlier' }, { ts: '2026-10-28T11:00:05.000Z', role: 'assistant', content: 'Earlier reply.' }, ...ASKED];
  assert.strictEqual(turnReplySince(hist, Date.parse(t(0)) - 2000).content, 'Nothing is unpushed. \n\nReleased 5.8.1.');
  assert.strictEqual(turnReplySince(hist.slice(0, 4), Date.parse(t(0)) - 2000), null, 'only the question so far');
  // a turn with no message of its own (a schedule): what was saved since it began
  const sched = [{ ts: t(0), role: 'assistant', content: 'Morning check: ' }, { ts: t(1), role: 'assistant', content: '❓ Go?', ask: true }, { ts: t(9), role: 'user', content: '↳ Yes', ask: true }, { ts: t(10), role: 'assistant', content: 'done.', base: 15 }];
  assert.strictEqual(turnReplySince(sched, Date.parse(t(0)) - 2000).content, 'Morning check: done.');
});

test('two replies with no message between them are never joined (turns with no message of their own)', () => {
  // the reply asked for, then a scheduled turn's reply saved right after it
  const anchored = [{ ts: t(0), role: 'user', content: 'hi' }, { ts: t(1), role: 'assistant', content: 'Hello.' }, { ts: t(2), role: 'assistant', content: 'Morning report.' }];
  assert.strictEqual(turnReplyFrom(anchored, 1, Date.parse(t(0))).content, 'Hello.');
  // two such replies inside the 2 s window before the turn began: the newest one only
  const close = [{ ts: '2026-10-28T11:59:59.500Z', role: 'assistant', content: 'Previous result.' }, { ts: t(0), role: 'assistant', content: 'Current result.' }];
  assert.strictEqual(turnReplySince(close, Date.parse(t(0)) - 1000).content, 'Current result.');
});

test('a piece whose base does not continue the reply is not joined', () => {
  const bad = [ASKED[0], ASKED[1], ASKED[2], ASKED[3], { ...ASKED[4], base: 5 }];
  assert.strictEqual(turnReplyFrom(bad, 1, 0).content, 'Nothing is unpushed. ');
});

test('two questions in one reply: three pieces, each base = the length saved before it (as the hub writes them)', () => {
  const two = [
    { ts: t(0), role: 'user', content: 'go' },
    { ts: t(1), role: 'assistant', content: '❓ First?', ask: true },
    { ts: t(2), role: 'assistant', content: 'Before. ' },
    { ts: t(10), role: 'user', content: '↳ Yes', ask: true },
    { ts: t(11), role: 'assistant', content: '\n\nMiddle. ', base: 8 },
    { ts: t(12), role: 'assistant', content: '❓ Second?', ask: true },
    { ts: t(20), role: 'user', content: '↳ No', ask: true },
    { ts: t(21), role: 'assistant', content: '\n\nAfter.', base: 18 },   // 8 + '\n\nMiddle. '.length (10)
  ];
  assert.strictEqual('\n\nMiddle. '.length, 10);
  assert.strictEqual(turnReplyFrom(two, 1, Date.parse(t(0))).content, 'Before. \n\nMiddle. \n\nAfter.');
  assert.strictEqual(turnReplySince(two, Date.parse(t(0)) - 2000).content, 'Before. \n\nMiddle. \n\nAfter.');
});

test('a later reply that starts with the same words, or is the same text, is another reply', () => {
  const same = [{ ts: t(0), role: 'user', content: 'Run the check.' }, { ts: t(1), role: 'assistant', content: 'Done.' },
    { ts: t(2), role: 'assistant', content: 'Done. The scheduled backup finished.', reasoning: 'other turn' }];
  assert.deepStrictEqual(turnReplyFrom(same, 1, Date.parse(t(0))), same[1]);
  const twin = [same[0], same[1], { ts: t(2), role: 'assistant', content: 'Done.', inProgress: true }];
  assert.deepStrictEqual(turnReplyFrom(twin, 1, Date.parse(t(0))), same[1], 'not the later entry\'s flags');
  assert.strictEqual(turnReplySince(same, Date.parse(t(0)) - 2000).content, 'Done. The scheduled backup finished.');
});
