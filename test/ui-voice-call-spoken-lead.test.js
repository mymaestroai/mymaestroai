'use strict';
// On a call only the spoken lead of a reply is read aloud (voiceSpokenLead / voiceReplySentences); tables, lists, headings,
// code and everything after them stay in the chat, and one line says so.
const { test } = require('node:test');
const assert = require('node:assert');
Object.assign(globalThis, require('../lib/ui-voice'));   // the call file uses these helpers as globals, like the pages
const C = require('../lib/ui-voice-call');
const { voiceCreateCall, voiceReplySentences, voiceSpokenLead, VOICE_LEAD_MAX_SENTENCES } = C;

const NOTE = 'I have put the details in the chat.';
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

const TABLE = 'You have three meetings tomorrow. The first is at nine.\n\n| Time | Meeting | Room |\n|---|---|---|\n| 09:00 | Standup | B2 |\n| 13:30 | Review PR-4821 | A1 |\n\nTicket id ZX-99881 is linked.';
const BULLETS = 'Three things to check before Friday.\n\n- Invoice 2024-0815 for $1,240.50\n- Order #A77-K19 shipped 11/12\n- Renew cert at /etc/ssl/site.pem';
const NUMBERED = 'Here are the steps to take today.\n\n1. Alpha 4471\n2. Bravo 9920\n3. Charlie 1203';

test('constants and helper: the lead stops at the first detail line', () => {
  assert.strictEqual(VOICE_LEAD_MAX_SENTENCES, 3);
  assert.deepStrictEqual(voiceSpokenLead('Hi there.\n\nMore plain text.'), { lead: 'Hi there.\n\nMore plain text.', cut: false });
  assert.deepStrictEqual(voiceSpokenLead('Hi.\n| a |'), { lead: 'Hi.', cut: true });
  assert.deepStrictEqual(voiceSpokenLead('Hi.\n  ```js\nx'), { lead: 'Hi.', cut: true });
  assert.deepStrictEqual(voiceSpokenLead('Hi.\n## Head'), { lead: 'Hi.', cut: true });
  assert.deepStrictEqual(voiceSpokenLead('Hi.\n\t* item'), { lead: 'Hi.', cut: true });
  assert.deepStrictEqual(voiceSpokenLead('Hi.\n2) item'), { lead: 'Hi.', cut: true });
  assert.deepStrictEqual(voiceSpokenLead('Hi.\n• item'), { lead: 'Hi.', cut: true });
  assert.deepStrictEqual(voiceSpokenLead('Hi.\n___'), { lead: 'Hi.', cut: true });
  assert.deepStrictEqual(voiceSpokenLead('Hi.\n- - -'), { lead: 'Hi.', cut: true });
  assert.deepStrictEqual(voiceSpokenLead('Hi.\n**Details:**'), { lead: 'Hi.', cut: true });
  assert.deepStrictEqual(voiceSpokenLead('Hi.\n__Details__'), { lead: 'Hi.', cut: true });
  assert.strictEqual(voiceSpokenLead('Hi.\n**Bold** words after').cut, false, 'a bold word inside a sentence is not a label line');
  assert.strictEqual(voiceSpokenLead('Hi.\n#hashtag and 3.5 apples -5 degrees').cut, false);
  assert.deepStrictEqual(voiceSpokenLead(''), { lead: '', cut: false });
});

test('(a) lead + table: only the lead is read, text after the table is not', () => {
  assert.deepStrictEqual(voiceReplySentences(TABLE, true), { sentences: ['You have three meetings tomorrow.', 'The first is at nine.'], note: NOTE });
});

test('(b) lead + bullets', () => {
  assert.deepStrictEqual(voiceReplySentences(BULLETS, true), { sentences: ['Three things to check before Friday.'], note: NOTE });
});

test('(c) table only: nothing but the note', () => {
  assert.deepStrictEqual(voiceReplySentences('| Time | Room |\n|---|---|\n| 09:00 | B2 |', true), { sentences: [], note: NOTE });
  assert.deepStrictEqual(voiceReplySentences('\n\n- first\n- second', true), { sentences: [], note: NOTE });
  assert.deepStrictEqual(voiceReplySentences('', true), { sentences: [], note: '' });
});

test('(d) a plain paragraph of two sentences: both, no note', () => {
  assert.deepStrictEqual(voiceReplySentences('It is sunny today. Take a coat anyway.', true), { sentences: ['It is sunny today.', 'Take a coat anyway.'], note: '' });
  assert.deepStrictEqual(voiceReplySentences('It is sunny today.\n\nTake a coat anyway.', true), { sentences: ['It is sunny today.', 'Take a coat anyway.'], note: '' });
});

test('(e) a plain paragraph of five sentences: the first three and the note', () => {
  const r = voiceReplySentences('One is here. Two is here. Three is here. Four is here. Five is here.', true);
  assert.deepStrictEqual(r, { sentences: ['One is here.', 'Two is here.', 'Three is here.'], note: NOTE });
  const s = voiceReplySentences('One is here. Two is here. Three is here. Four is here. ', false);
  assert.deepStrictEqual(s.sentences, ['One is here.', 'Two is here.', 'Three is here.']);
});

test('(f) lead + heading + text / numbered list / code block / bold label', () => {
  assert.deepStrictEqual(voiceReplySentences('Short answer first.\n\n## Details\nOrder 5521 shipped on 11/12.', true), { sentences: ['Short answer first.'], note: NOTE });
  assert.deepStrictEqual(voiceReplySentences(NUMBERED, true), { sentences: ['Here are the steps to take today.'], note: NOTE });
  assert.deepStrictEqual(voiceReplySentences('Run this to fix it.\n\n```bash\nsudo rm -rf /tmp/x9f\n```\nThen restart.', true), { sentences: ['Run this to fix it.'], note: NOTE });
  assert.deepStrictEqual(voiceReplySentences('It is done.\n\n**Details:**\nCommit a1b2c3d merged.', true), { sentences: ['It is done.'], note: NOTE });
});

function prefixProperty(text) {
  const final = voiceReplySentences(text, true).sentences;
  let prev = [];
  for (let i = 0; i <= text.length; i++) {
    const cur = voiceReplySentences(text.slice(0, i), false).sentences;
    assert.ok(cur.length >= prev.length, 'the list never shrinks at char ' + i + ' ' + JSON.stringify(text.slice(0, i)));
    assert.deepStrictEqual(cur, final.slice(0, cur.length), 'a prefix of the final list at char ' + i + ' ' + JSON.stringify(text.slice(0, i)));
    prev = cur;
  }
  assert.deepStrictEqual(final, voiceReplySentences(text, true).sentences);
  return final;
}

test('(g) streaming: the sentence list only grows and is always a prefix of the final one', () => {
  assert.deepStrictEqual(prefixProperty(BULLETS), ['Three things to check before Friday.']);
  assert.deepStrictEqual(prefixProperty(NUMBERED), ['Here are the steps to take today.']);
  assert.deepStrictEqual(prefixProperty(TABLE), ['You have three meetings tomorrow.', 'The first is at nine.']);
  assert.deepStrictEqual(prefixProperty('Good news today.\n\n- item one\n- item two'), ['Good news today.']);
  assert.deepStrictEqual(prefixProperty('Done.\n\n1) Alpha\n2) Bravo'), ['Done.']);
  assert.deepStrictEqual(prefixProperty('Fine.\n\n```js\nlet a = 1\n```'), ['Fine.']);
  assert.deepStrictEqual(prefixProperty('Fine.\n\n**Label**\nText 12.'), ['Fine.']);
  assert.deepStrictEqual(prefixProperty('One is here. Two is here. Three is here. Four is here. Five is here.'), ['One is here.', 'Two is here.', 'Three is here.']);
});

test('(h) the controller reads only the lead sentence and then the details note', async () => {
  const h = { t: 0, timers: [], nextId: 1, spoken: [], pend: [], sent: [], running: false, states: [] };
  const deps = {
    agent: 'a1', now: () => h.t, setTimer: (fn, ms) => { const id = h.nextId++; h.timers.push({ id, at: h.t + ms, fn }); return id; }, clearTimer: (id) => { h.timers = h.timers.filter(x => x.id !== id); },
    prefs: () => ({ micLevel: 50, interruptSensitivity: 50, continueWait: 0 }),
    vad: { start: async (hd) => { h.hd = hd; }, stop() {}, setPlaybackActive() {} }, stt: async (a) => a.text, isTurnRunning: () => h.running,
    send: async (t) => { h.sent.push(t); h.running = true; }, interject: async () => {}, stop() {},
    speak: (text) => new Promise((resolve) => { h.spoken.push(text); h.pend.push(resolve); }), cancelSpeech() { const r = h.pend.shift(); if (r) r(false); },
    answerAsk() {},
    server: { start: async () => ({ callId: 'c1', held: [] }), heartbeat: async (c) => ({ callId: c, held: [] }), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} },
    ui: { state: (n) => h.states.push(n) },
  };
  const call = voiceCreateCall(deps);
  assert.strictEqual(await call.start(), true);
  h.hd.onSpeechStart(); h.hd.onSpeechEnd({ text: 'what should I check' }); await tick();
  assert.deepStrictEqual(h.sent, ['what should I check']);
  const drain = async () => { for (let i = 0; i < 10 && h.pend.length; i++) { h.pend.shift()(true); await tick(); } };
  for (let i = 5; i < BULLETS.length; i += 7) { call.onReplyText(BULLETS.slice(0, i), false); await tick(); await drain(); }
  call.onReplyText(BULLETS, false); await tick(); await drain();
  call.onReplyText(BULLETS, true); await tick(); await drain();
  assert.deepStrictEqual(h.spoken, ['Three things to check before Friday.', NOTE]);
});
