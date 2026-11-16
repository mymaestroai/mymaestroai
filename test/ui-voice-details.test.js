'use strict';
// On a call, what the spoken lead leaves out is read too when it is short (the 'detailsReadWords' pref, default 40 words);
// a substantial rest (a code block, a table, 3+ raw links or paths, more words than the pref) stays in the chat and ONE note
// names it: the full list / the table / the code / the details. Streaming never takes back a sentence already spoken.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
Object.assign(globalThis, require('../lib/ui-voice'));   // the call file uses these helpers as globals, like the pages
const V = require('../lib/ui-voice');
const C = require('../lib/ui-voice-call');
const { voiceCreateCall, voiceReplySentences } = C;

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const NOTE = 'I have put the details in the chat.';
const NOTE_LIST = 'I\'ve put the full list in the chat.';
const NOTE_TABLE = 'I\'ve put the table in the chat.';
const NOTE_CODE = 'I\'ve put the code in the chat.';

const FOUR = 'One is here. Two is here. Three is here. Four is here.';
const TWO_ITEMS = 'Here are the two checks.\n\n- Check the disk\n- Check the logs';
const TABLE10 = 'Here are the results.\n\n| Name | Score |\n|---|---|\n' + Array.from({ length: 10 }, (_, i) => `| Row${i + 1} | ${i + 10} |`).join('\n');
const CODE = 'Run this to fix it.\n\n```bash\nls -la\n```';
const LIST12 = 'Here are the twelve items.\n\n' + Array.from({ length: 12 }, (_, i) => `- Item ${i + 1} has six short words`).join('\n');
// 8 sentences, 90 words in all (ten words each, two have ten and a half: 82 + 8 more)
const LONG = ['The first part of the report covers the northern region sales.', 'The second part looks at how the costs moved over the year.', 'The third part lists every supplier that changed its prices.',
  'The fourth part explains why the warehouse needed a new layout.', 'The fifth part describes the hiring plan for the coming spring.', 'The sixth part compares three offers from different banks.',
  'The seventh part notes the risks that the board asked about.', 'The eighth part closes with the dates that matter for the next review meeting today.'].join(' ');
// a 50-word rest: five bullets of ten words
const REST50 = 'Here are the notes.\n\n' + Array.from({ length: 5 }, (_, i) => `- alpha${i} beta gamma delta epsilon zeta eta theta iota kappa`).join('\n');

function makeCall(prefs) {
  const h = { t: 0, timers: [], nextId: 1, spoken: [], pend: [], sent: [], running: false, states: [] };
  const deps = {
    agent: 'a1', now: () => h.t, setTimer: (fn, ms) => { const id = h.nextId++; h.timers.push({ id, at: h.t + ms, fn }); return id; }, clearTimer: (id) => { h.timers = h.timers.filter(x => x.id !== id); },
    prefs: () => Object.assign({ micLevel: 50, interruptSensitivity: 50, continueWait: 0 }, prefs),
    vad: { start: async (hd) => { h.hd = hd; }, stop() {}, setPlaybackActive() {} }, stt: async (a) => a.text, isTurnRunning: () => h.running,
    send: async (t) => { h.sent.push(t); h.running = true; }, interject: async () => {}, stop() {},
    speak: (text) => new Promise((resolve) => { h.spoken.push(text); h.pend.push(resolve); }), cancelSpeech() { const r = h.pend.shift(); if (r) r(false); },
    answerAsk() {},
    server: { start: async () => ({ callId: 'c1', held: [] }), heartbeat: async (c) => ({ callId: c, held: [] }), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} },
    ui: { state: (n) => h.states.push(n) },
  };
  h.call = voiceCreateCall(deps);
  h.drain = async () => { for (let i = 0; i < 40 && h.pend.length; i++) { h.pend.shift()(true); await tick(); } };
  return h;
}
async function startedCall(prefs) {
  const h = makeCall(prefs);
  assert.strictEqual(await h.call.start(), true);
  h.hd.onSpeechStart(); h.hd.onSpeechEnd({ text: 'tell me' }); await tick();
  return h;
}
// the whole reply fed in pieces (done false), then done; everything spoken
async function speakReply(md, prefs, step = 7) {
  const h = await startedCall(prefs);
  for (let i = step; i < md.length; i += step) { h.call.onReplyText(md.slice(0, i), false); await tick(); await h.drain(); }
  h.call.onReplyText(md, false); await tick(); await h.drain();
  h.call.onReplyText(md, true); await tick(); await h.drain();
  return h.spoken;
}

test('one extra sentence (4 short sentences): all 4 are read, no note', async () => {
  const r = voiceReplySentences(FOUR, true);
  assert.deepStrictEqual(r, { sentences: ['One is here.', 'Two is here.', 'Three is here.', 'Four is here.'], note: '' });
  assert.deepStrictEqual(voiceReplySentences(FOUR, true, 40), r, 'the default is 40 words');
  assert.deepStrictEqual(await speakReply(FOUR), ['One is here.', 'Two is here.', 'Three is here.', 'Four is here.']);
});

test('two short list items after a lead sentence: the lead and both items are read, no note', async () => {
  assert.deepStrictEqual(voiceReplySentences(TWO_ITEMS, true), { sentences: ['Here are the two checks.', 'Check the disk.', 'Check the logs.'], note: '' });
  assert.deepStrictEqual(await speakReply(TWO_ITEMS), ['Here are the two checks.', 'Check the disk.', 'Check the logs.']);
});

test('a 10-row table after a lead sentence: the lead, then the table note', async () => {
  assert.deepStrictEqual(voiceReplySentences(TABLE10, true), { sentences: ['Here are the results.'], note: NOTE_TABLE });
  assert.deepStrictEqual(await speakReply(TABLE10), ['Here are the results.', NOTE_TABLE]);
  assert.strictEqual(' ' + NOTE_TABLE, V.VOICE_NOTE_TABLE);
});

test('a short code block after a lead sentence: the lead, then the code note', async () => {
  assert.deepStrictEqual(voiceReplySentences(CODE, true), { sentences: ['Run this to fix it.'], note: NOTE_CODE });
  assert.deepStrictEqual(await speakReply(CODE), ['Run this to fix it.', NOTE_CODE]);
  assert.strictEqual(' ' + NOTE_CODE, V.VOICE_NOTE_CODE);
});

test('a long list (12 items of 6 words): the lead, then the full-list note', async () => {
  assert.deepStrictEqual(voiceReplySentences(LIST12, true), { sentences: ['Here are the twelve items.'], note: NOTE_LIST });
  assert.deepStrictEqual(await speakReply(LIST12), ['Here are the twelve items.', NOTE_LIST]);
  assert.strictEqual(' ' + NOTE_LIST, V.VOICE_NOTE_LIST);
});

test('long plain text (8 sentences, 90 words): the first 3, then the generic note', async () => {
  assert.strictEqual(LONG.split(/\s+/).length, 90);
  const r = voiceReplySentences(LONG, true);
  assert.strictEqual(r.sentences.length, 3);
  assert.strictEqual(r.sentences[0], 'The first part of the report covers the northern region sales.');
  assert.strictEqual(r.note, NOTE);
  assert.strictEqual(' ' + NOTE, V.VOICE_DETAILS_NOTE);
  const spoken = await speakReply(LONG);
  assert.deepStrictEqual(spoken, r.sentences.concat(NOTE));
});

test('three or more raw links or file paths in the rest are never read, even when short', () => {
  const links = 'Here is where to look.\n\n- https://example.com/a\n- https://example.com/b\n- https://example.com/c';
  assert.deepStrictEqual(voiceReplySentences(links, true), { sentences: ['Here is where to look.'], note: NOTE_LIST });
  const paths = 'Here is where to look.\n\n## Files\nSee /etc/app/one.conf and /etc/app/two.conf and /var/log/app/three.log for it.';
  assert.deepStrictEqual(voiceReplySentences(paths, true), { sentences: ['Here is where to look.'], note: NOTE });
  const two = 'Here is where to look.\n\n## Files\nSee /etc/app/one.conf and /etc/app/two.conf for it.';
  const r = voiceReplySentences(two, true);
  assert.strictEqual(r.note, '', 'two paths are read');
  assert.strictEqual(r.sentences.length, 3);
});

test('readWords 0 is today\'s behaviour: the lead only (at most 3 sentences) and the note', async () => {
  assert.deepStrictEqual(voiceReplySentences(FOUR, true, 0), { sentences: ['One is here.', 'Two is here.', 'Three is here.'], note: NOTE });
  assert.deepStrictEqual(voiceReplySentences(TWO_ITEMS, true, 0), { sentences: ['Here are the two checks.'], note: NOTE });
  assert.notDeepStrictEqual(voiceReplySentences(FOUR, true).sentences, voiceReplySentences(FOUR, true, 0).sentences, 'the default reads more');
  assert.deepStrictEqual(await speakReply(FOUR, { detailsReadWords: 0 }), ['One is here.', 'Two is here.', 'Three is here.', NOTE]);
  assert.deepStrictEqual(await speakReply(TWO_ITEMS, { detailsReadWords: 0 }), ['Here are the two checks.', NOTE]);
  // the table / code / list notes still name their kind when the rest is not read
  assert.strictEqual(voiceReplySentences(TABLE10, true, 0).note, NOTE, 'off: the generic note, as today');
});

test('readWords 80 vs 20 vs 40 on a 50-word rest', () => {
  const rest = REST50.split('\n\n')[1];
  assert.strictEqual(voiceSpeechText(rest).split(/\s+/).length, 50);
  const s80 = voiceReplySentences(REST50, true, 80);
  assert.strictEqual(s80.note, '');
  assert.strictEqual(s80.sentences.length, 6, 'the lead and the five items');
  assert.strictEqual(voiceReplySentences(REST50, true, 50).note, '', 'exactly the limit is short (at most)');
  assert.deepStrictEqual(voiceReplySentences(REST50, true, 20), { sentences: ['Here are the notes.'], note: NOTE_LIST });
  assert.deepStrictEqual(voiceReplySentences(REST50, true, 40), { sentences: ['Here are the notes.'], note: NOTE_LIST }, '50 words is over 40');
});

test('streaming: sentences already returned are never removed or reordered; the note comes at the end, only when substantial', () => {
  for (const [md, final, note] of [[FOUR, 4, ''], [TWO_ITEMS, 3, ''], [TABLE10, 1, NOTE_TABLE], [CODE, 1, NOTE_CODE], [LIST12, 1, NOTE_LIST], [LONG, 3, NOTE], [REST50, 1, NOTE_LIST], ['Fine.\n\n**Label**\nText 12.', 3, '']]) {
    let prev = [];
    for (let i = 1; i < md.length; i++) {
      const cur = voiceReplySentences(md.slice(0, i), false).sentences;
      assert.deepStrictEqual(cur.slice(0, prev.length), prev, 'a prefix at char ' + i + ' of ' + JSON.stringify(md.slice(0, 20)));
      assert.ok(cur.length <= 3, 'while streaming only the lead (at most 3 sentences) is read');
      prev = cur;
    }
    const done = voiceReplySentences(md, true);
    assert.deepStrictEqual(done.sentences.slice(0, prev.length), prev, 'the final list starts with what was already spoken');
    assert.strictEqual(done.sentences.length, final, JSON.stringify(md.slice(0, 20)));
    assert.strictEqual(done.note, note);
  }
});

test('the note is spoken once in a full call (also when done arrives twice)', async () => {
  for (const [md, note] of [[TABLE10, NOTE_TABLE], [CODE, NOTE_CODE], [LIST12, NOTE_LIST], [LONG, NOTE]]) {
    const h = await startedCall();
    for (let i = 9; i < md.length; i += 9) { h.call.onReplyText(md.slice(0, i), false); await tick(); await h.drain(); }
    h.call.onReplyText(md, true); await tick(); await h.drain();
    h.call.onReplyText(md, true); await tick(); await h.drain();
    assert.strictEqual(h.spoken.filter(s => s === note).length, 1, note);
    assert.strictEqual(h.spoken.filter(s => /in the chat/.test(s)).length, 1, 'only one note of any kind');
    assert.strictEqual(h.spoken[h.spoken.length - 1], note, 'the note comes last');
  }
  for (const md of [FOUR, TWO_ITEMS]) assert.strictEqual((await speakReply(md)).filter(s => /in the chat/.test(s)).length, 0, 'a short rest has no note');
});

test('a person cutting in while the extra sentences wait: the cut sentences are re-read after a false start, the note is not counted as one', async () => {
  const h = await startedCall();
  for (let i = 8; i < FOUR.length; i += 8) { h.call.onReplyText(FOUR.slice(0, i), false); await tick(); }
  h.call.onReplyText(FOUR, true); await tick();
  h.hd.onSpeechStart();   // barge-in while sentences are queued
  await tick();
  h.hd.onMisfire && h.hd.onMisfire();   // a false start: the reading goes on
  await tick(); await h.drain();
  assert.strictEqual(h.spoken.filter(s => s === 'Four is here.').length >= 1, true, 'the 4th sentence is read');
  assert.strictEqual(h.spoken.filter(s => /in the chat/.test(s)).length, 0);
});

test('voiceLoadPrefs: detailsReadWords defaults to 40; 20, 80 and 0 are kept; anything else gives 40', () => {
  const store = (o) => ({ getItem: () => (o === undefined ? null : JSON.stringify(o)) });
  assert.deepStrictEqual(V.VOICE_DETAILS_READ_WORDS, [0, 20, 40, 80]);
  assert.strictEqual(V.VOICE_DEFAULT_PREFS.detailsReadWords, 40);
  assert.strictEqual(voiceLoadPrefs(store()).detailsReadWords, 40);
  assert.strictEqual(voiceLoadPrefs(store({})).detailsReadWords, 40);
  for (const n of [20, 80, 0, 40]) assert.strictEqual(voiceLoadPrefs(store({ detailsReadWords: n })).detailsReadWords, n);
  for (const bad of [33, -1, '20', null, true, 1000]) assert.strictEqual(voiceLoadPrefs(store({ detailsReadWords: bad })).detailsReadWords, 40, JSON.stringify(bad));
});

test('the agent-level voice defaults are not extended', () => {
  assert.ok(!V.VOICE_AGENT_DEFAULT_KEYS.includes('detailsReadWords'));
});

test('voiceSpeechText is unchanged: tables and code still add the details note', () => {
  assert.strictEqual(voiceSpeechText('| a |'), NOTE);
  assert.strictEqual(voiceSpeechText('Hi.\n```js\nx\n```'), 'Hi. ' + NOTE);
});

test('the page copies carry the same code, the notes and the settings controls', () => {
  const lib = read('lib/ui-voice-call.js'), app = read('app.js'), mob = read('mobile.js');
  for (const [name, src] of [['app.js', app], ['mobile.js', mob]]) {
    for (const s of ['function voiceRestAnalysis(rest, extra, readWords, openTail) {', 'function voiceIsNoteText(text) {', 'function voiceReplySentences(markdown, done, readWords) {',
      'const VOICE_NOTE_LIST = ', 'const VOICE_NOTE_TABLE = ', 'const VOICE_NOTE_CODE = ', 'const VOICE_DETAILS_READ_WORDS = [0, 20, 40, 80];', 'detailsReadWords: 40 };',
      'Read short extra parts aloud', 'voiceReplySentences(lastText, !!done, readWords())', '!voiceIsNoteText(i.text)']) assert.ok(src.includes(s), name + ': ' + s);
    assert.ok(!src.includes("const noteText = voiceSpeechText('| a |');"), name + ': the old single-note check is gone');
  }
  assert.ok(lib.includes('function voiceRestAnalysis(rest, extra, readWords, openTail) {'));
  assert.ok(app.includes('id="st-voice-details"') || app.includes("'st-voice-details'"), 'desktop select');
  assert.ok(app.includes('prefs.detailsReadWords = Number(details.value)'), 'desktop saves it');
  assert.ok(mob.includes("voicePrefsSave({ detailsReadWords: Number(details.value) })"), 'phone sheet saves it');
  assert.ok(mob.includes("save({ detailsReadWords: Number(details.value) })"), 'phone panel saves it');
  assert.ok(read('mobile.html').includes('id="vp-details"'));
  assert.ok(!read('agent-settings.html').includes('detailsReadWords'), 'the agent-level defaults are not extended');
});
