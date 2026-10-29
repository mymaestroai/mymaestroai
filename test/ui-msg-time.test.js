'use strict';
// The date and time under each message (2026-10-29): when the person sent it, and when the agent's reply finished,
// with how long it took ("Oct 29, 6:42 AM · 1m 08s"). lib/ui-msg-time.js makes the text; the pages carry
// byte-identical copies of it and draw it under saved messages, their own sends and replies, and followed turns.
process.env.TZ = 'America/New_York';   // the texts below are New York times; the pages use the device's own zone
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { msgTimeLabel, msgTookLabel, msgTimeLine, msgTimeLines } = require('../lib/ui-msg-time');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const BEGIN = '// ── message-time helpers (begin) ──';
const END = '// ── message-time helpers (end) ──';
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
const sp = (s) => s.replace(/\s/g, ' ');   // ICU may put a narrow no-break space before AM/PM
const NOW = Date.parse('2026-10-29T12:00:00Z');   // 8:00 AM in New York
const at = (iso) => Date.parse(iso);

test('the pages carry the helpers byte for byte', () => {
  const lib = helperBlock(read('lib/ui-msg-time.js'), '');
  assert.strictEqual(helperBlock(read('app.js'), '    '), lib, 'app.js copy');
  assert.strictEqual(helperBlock(read('mobile.js'), ''), lib, 'mobile.js copy');
});

test('the date and time: month, day and time in the device zone; the year only for another year', () => {
  assert.strictEqual(sp(msgTimeLabel(at('2026-10-29T10:41:00Z'), NOW, 'en-US')), 'Oct 29, 6:41 AM');
  assert.strictEqual(sp(msgTimeLabel('2026-10-29T10:41:00.123Z', NOW, 'en-US')), 'Oct 29, 6:41 AM');   // an ISO string
  assert.strictEqual(sp(msgTimeLabel(at('2026-10-28T01:12:00Z'), NOW, 'en-US')), 'Oct 27, 9:12 PM');   // the device's own day
  assert.strictEqual(sp(msgTimeLabel(at('2025-10-29T10:41:00Z'), NOW, 'en-US')), 'Oct 29, 2025, 6:41 AM');
  // New Year's Eve in New York is already January 1 in UTC: the year is judged in the device's zone
  assert.strictEqual(sp(msgTimeLabel(at('2026-01-01T04:30:00Z'), NOW, 'en-US')), 'Dec 31, 2025, 11:30 PM');
  assert.strictEqual(sp(msgTimeLabel(at('2026-01-01T05:30:00Z'), NOW, 'en-US')), 'Jan 1, 12:30 AM');
  assert.match(sp(msgTimeLabel(at('2026-10-29T10:41:00Z'), NOW, 'en-GB')), /^29 Oct,? 0?6:41$/);   // the device's language
  for (const bad of [undefined, null, '', 'yesterday', NaN, Infinity]) assert.strictEqual(msgTimeLabel(bad, NOW, 'en-US'), '', String(bad));
});

test('how long it took: seconds, then minutes and seconds, then hours and minutes', () => {
  const cases = [[0, '0s'], [8000, '8s'], [59499, '59s'], [59500, '1m 00s'], [68000, '1m 08s'], [600000, '10m 00s'],
    [3599499, '59m 59s'], [3599500, '1h 00m'], [3725000, '1h 02m'], [26 * 3600000, '26h 00m']];
  for (const [ms, want] of cases) assert.strictEqual(msgTookLabel(ms), want, `${ms} ms`);
  for (const bad of [-1, NaN, undefined, null, Infinity, '5']) assert.strictEqual(msgTookLabel(bad), '', String(bad));
});

test('a reply: the time it finished and how long it took; the time alone without a start', () => {
  const sent = at('2026-10-29T10:41:00Z'), done = at('2026-10-29T10:42:08Z');
  assert.strictEqual(sp(msgTimeLine(done, sent, NOW, 'en-US')), 'Oct 29, 6:42 AM · 1m 08s');
  assert.strictEqual(sp(msgTimeLine('2026-10-29T10:42:08Z', '2026-10-29T10:41:00Z', NOW, 'en-US')), 'Oct 29, 6:42 AM · 1m 08s');
  assert.strictEqual(sp(msgTimeLine(done, NaN, NOW, 'en-US')), 'Oct 29, 6:42 AM');
  assert.strictEqual(sp(msgTimeLine(done, null, NOW, 'en-US')), 'Oct 29, 6:42 AM');
  assert.strictEqual(sp(msgTimeLine(sent, done, NOW, 'en-US')), 'Oct 29, 6:41 AM');   // a clock that went back: no negative time
  assert.strictEqual(msgTimeLine(NaN, sent, NOW, 'en-US'), '');
});

test('saved history: each message gets its time; a reply in pieces says how long only on its last piece', () => {
  const h = [
    { role: 'user', content: 'Push it', ts: '2026-10-29T11:19:00.000Z' },
    { role: 'assistant', content: 'Checking. ', ts: '2026-10-29T11:21:10.000Z' },
    { role: 'assistant', content: '❓ Release? [Yes / No]', ts: '2026-10-29T11:21:12.000Z', ask: true },
    { role: 'user', content: '↳ Yes', ts: '2026-10-29T11:24:00.000Z', ask: true },
    { role: 'assistant', content: 'Released.', ts: '2026-10-29T11:28:12.000Z', base: 10 },
    { role: 'user', content: '[Scheduled task] check', ts: '2026-10-29T11:30:00.000Z', origin: { kind: 'schedule' } },
    { role: 'assistant', content: 'Checked.', ts: '2026-10-29T11:30:09.000Z' },
  ];
  assert.deepStrictEqual(msgTimeLines(h, NOW, 'en-US').map(sp), [
    'Oct 29, 7:19 AM', 'Oct 29, 7:21 AM', 'Oct 29, 7:21 AM', 'Oct 29, 7:24 AM', 'Oct 29, 7:28 AM · 9m 12s',
    'Oct 29, 7:30 AM', 'Oct 29, 7:30 AM · 9s',
  ]);
});

test('saved history: a reply that does not follow its message gets its time alone; unreadable times get no line', () => {
  const h = [
    { role: 'assistant', content: 'Hello first', ts: '2026-10-29T10:00:00Z' },                       // nothing before it
    { role: 'user', content: 'Hi', ts: '2026-10-29T10:01:00Z' },
    { role: 'assistant', content: 'Answer', ts: '2026-10-29T10:01:30Z' },
    { role: 'assistant', content: 'Again, whole', ts: '2026-10-29T10:02:00Z' },                       // a second reply
    { role: 'assistant', content: 'stray piece', ts: '2026-10-29T10:02:30Z', base: 99 },             // a piece of nothing shown
    { role: 'user', content: 'When?', ts: 'not a time' },
    { role: 'assistant', content: 'Now', ts: '2026-10-29T10:05:00Z' },                                 // its message's time unknown
    { role: 'user', content: 'Next', ts: '2026-10-29T10:06:00Z' },
    { role: 'assistant', content: 'Working on it', ts: '2026-10-29T10:06:30Z', inProgress: true },   // the running turn
  ];
  assert.deepStrictEqual(msgTimeLines(h, NOW, 'en-US').map(sp), [
    'Oct 29, 6:00 AM', 'Oct 29, 6:01 AM', 'Oct 29, 6:01 AM · 30s', 'Oct 29, 6:02 AM', 'Oct 29, 6:02 AM',
    '', 'Oct 29, 6:05 AM', 'Oct 29, 6:06 AM', '',
  ]);
  assert.deepStrictEqual(msgTimeLines([], NOW), []);
});

test('saved history: while a reply in pieces is still running, no piece says how long yet', () => {
  const h = [
    { role: 'user', content: 'Go', ts: '2026-10-29T14:00:00Z' },
    { role: 'assistant', content: 'Checking.', ts: '2026-10-29T14:00:10Z' },
    { role: 'assistant', content: '❓ Continue? [Yes / No]', ts: '2026-10-29T14:00:11Z', ask: true },
    { role: 'user', content: '↳ Yes', ts: '2026-10-29T14:01:00Z', ask: true },
    { role: 'assistant', content: ' Working…', ts: '2026-10-29T14:01:30Z', base: 9, inProgress: true },
  ];
  assert.deepStrictEqual(msgTimeLines(h, NOW, 'en-US').map(sp), ['Oct 29, 10:00 AM', 'Oct 29, 10:00 AM', 'Oct 29, 10:00 AM', 'Oct 29, 10:01 AM', '']);
});

test('a device that changes time zone gets the new zone without a reload', () => {
  const t = at('2026-10-29T16:00:00Z');
  try {
    process.env.TZ = 'America/New_York';
    assert.strictEqual(sp(msgTimeLabel(t, NOW, 'en-US')), 'Oct 29, 12:00 PM');
    process.env.TZ = 'America/Los_Angeles';
    assert.strictEqual(sp(msgTimeLabel(t, NOW, 'en-US')), 'Oct 29, 9:00 AM');
    assert.strictEqual(sp(msgTimeLines([{ role: 'user', content: 'q', ts: '2026-10-29T16:00:00Z' }], NOW, 'en-US')[0]), 'Oct 29, 9:00 AM');
  } finally { process.env.TZ = 'America/New_York'; }
  assert.strictEqual(sp(msgTimeLabel(t, NOW, 'en-US', 'Asia/Kolkata')), 'Oct 29, 9:30 PM');   // a zone given
  // the year is judged in the zone the time is shown in: still 2025 in Los Angeles, already 2026 in New York
  assert.strictEqual(sp(msgTimeLabel(at('2026-01-01T06:00:00Z'), NOW, 'en-US', 'America/Los_Angeles')), 'Dec 31, 2025, 10:00 PM');
  assert.strictEqual(msgTimeLabel(t, NOW, 'en-US', 'Not/A_Zone').length > 0, true);   // an unknown zone: a plain time
});

test('the desktop page draws the line under saved messages, sends, replies and followed turns', () => {
  const app = read('app.js');
  assert.match(block(app, 'function decorateMessage(', '\n    }\n'), /paintMessageTime\(el\);/, 'a repaint keeps the line');
  assert.match(block(app, 'function paintMessageTime(', '\n    }\n'), /line\.textContent = text/, 'the text goes in as text');
  const hist = block(app, 'messages from previous session', '.catch(');
  assert.match(hist, /const times = msgTimeLines\(history\)/);
  assert.match(hist, /setMessageTime\(document\.getElementById\(hid\), times\[i\]\)/);
  const send = block(app, 'async function sendSoloMessage(', '\n    }\n');
  assert.match(send, /setMessageTime\(userMsgEl, msgTimeLabel\(chat\.sentAtMs\)\)/, 'the message, when sent');
  assert.match(send, /if \(!partial\) setMessageTime\(document\.getElementById\(msgId\), msgTimeLine\(Date\.now\(\), chat\.sentAtMs\)\)/, 'the reply, when finished');
  assert.match(block(app, 'async function onHubTurnStart(', '\n    }\n'), /startedAt: Date\.parse\(ev\.startedAt\)/);
  assert.match(block(app, 'function onHubTurnEnd(', '\n    }\n'), /msgTimeLine\(Date\.parse\(ev\.endedAt\) \|\| Date\.now\(\), t\.startedAt\)/);
  assert.match(block(app, 'function finishReattach(', '\n    }\n'), /if \(ok\) setMessageTime\(/);
  // a group agent's and the synthesis's reply count from the request, not from the first byte of the answer
  assert.match(app, /const askedAt = Date\.now\(\);[\s\S]{0,1500}await streamResponseGroup\(response, msgId, agent\.name, colorIndex, chatId, askedAt\)/);
  assert.match(app, /const askedAt = Date\.now\(\);[\s\S]{0,1500}await streamResponse\(response, msgId, true, chat\.currentRound, chatId, chat\.summarizer\.name, askedAt\)/);
  assert.match(read('index.html'), /\.message > \.msg-time \{[^}]*position: absolute; top: calc\(100% \+ 3px\)/);
});

test('the phone page draws the line under saved messages, sends, replies and followed turns', () => {
  const mob = read('mobile.js');
  assert.match(block(mob, 'function renderHistory(', '\n}\n'), /const times = msgTimeLines\(chatHistory\);[\s\S]*renderEntry\(chatHistory\[i\], times\[i\]\)/);
  const entry = block(mob, 'function renderEntry(', '\n}\n');
  assert.match(entry, /setBubbleTime\(addUserBubble\(m\.content, null\), time\)/);
  assert.match(entry, /setBubbleTime\(b\.el, time\)/);
  const send = block(mob, 'async function sendMessage(', '\n}\n');
  assert.match(send, /if \(!fallback\) setBubbleTime\(userEl, msgTimeLabel\(Date\.now\(\)\)\)/);
  assert.match(send, /if \(bubbleLive\(rec\) && !reattaches\.has\(agent\)\) setBubbleTime\(rec\.bubble\.el, msgTimeLine\(Date\.now\(\), rec\.startedAt\)\)/);
  assert.match(block(mob, 'function onTurnEnd(', '\n}\n'), /setBubbleTime\(t\.el, msgTimeLine\(Date\.parse\(ev\.endedAt\) \|\| Date\.now\(\), Date\.parse\(t\.startedAt\)\)\)/);
  assert.match(block(mob, 'function finishReattach(', '\n}\n'), /if \(ok\) setBubbleTime\(ra\.bubble\.el, /);
  assert.match(block(mob, 'function setBubbleTime(', '\n}\n'), /line\.textContent = text/, 'the text goes in as text');
  assert.match(read('mobile.html'), /\.msg\.has-time \{ margin-bottom: 16px; \}/);
});
