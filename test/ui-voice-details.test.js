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
// The call's notes offer to read what was left out (owner, 2026-11-18); a reply read aloud without a call keeps SPEECH_NOTE.
const NOTE = 'The details are in the chat; just say if you\'d like to hear them.';
const SPEECH_NOTE = 'I have put the details in the chat.';
const NOTE_LIST = 'I\'ve put the full list in the chat; just say if you\'d like to hear it.';
const NOTE_TABLE = 'I\'ve put the table in the chat; just say if you\'d like to hear it.';
const NOTE_CODE = 'I\'ve put the code in the chat; just say if you\'d like me to walk you through it.';

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
  assert.strictEqual(' ' + NOTE, V.VOICE_NOTE_DETAILS_CALL);
  assert.strictEqual(' ' + SPEECH_NOTE, V.VOICE_DETAILS_NOTE, 'read aloud without a call: the plain note, unchanged');
  const spoken = await speakReply(LONG);
  assert.deepStrictEqual(spoken, r.sentences.concat(NOTE));
});

test('any raw link or file path in the rest is never read, even when short (the owner\'s rule)', () => {
  const links = 'Here is where to look.\n\n- https://example.com/a\n- https://example.com/b\n- https://example.com/c';
  assert.deepStrictEqual(voiceReplySentences(links, true), { sentences: ['Here is where to look.'], note: NOTE_LIST });
  const paths = 'Here is where to look.\n\n## Files\nSee /etc/app/one.conf and /etc/app/two.conf and /var/log/app/three.log for it.';
  assert.deepStrictEqual(voiceReplySentences(paths, true), { sentences: ['Here is where to look.'], note: NOTE });
  const one = 'Here is where to look.\n\n## Files\nSee /etc/app/one.conf for it.';
  assert.deepStrictEqual(voiceReplySentences(one, true), { sentences: ['Here is where to look.'], note: NOTE }, 'one path is enough');
  const link = 'Here is where to look.\n\n## Docs\nSee https://example.com/a for it.';
  assert.deepStrictEqual(voiceReplySentences(link, true), { sentences: ['Here is where to look.'], note: NOTE }, 'one link is enough');
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
  assert.strictEqual(voiceSpeechText('| a |'), SPEECH_NOTE);
  assert.strictEqual(voiceSpeechText('Hi.\n```js\nx\n```'), 'Hi. ' + SPEECH_NOTE);
});

test('the page copies carry the same code, the notes and the settings controls', () => {
  const lib = read('lib/ui-voice-call.js'), app = read('app.js'), mob = read('mobile.js');
  for (const [name, src] of [['app.js', app], ['mobile.js', mob]]) {
    for (const s of ['function voiceRestAnalysis(rest, extra, readWords, openTail, extraRaw) {', 'function voiceReplySentences(markdown, done, readWords, full) {',
      'const VOICE_NOTE_LIST = ', 'const VOICE_NOTE_TABLE = ', 'const VOICE_NOTE_CODE = ', 'const VOICE_DETAILS_READ_WORDS = [0, 20, 40, 80];', 'detailsReadWords: 40, hubCue: \'cue\', backgroundCue: \'say\' };',
      'Read short extra parts aloud', 'voiceReplySentences(lastText, !!done, readWords(), readFull)', 'enqueue(readOffer ? r.note : voicePlainNote(r.note), \'reply\', null, null, false, true)', '!i.note)',
      'Longer lists, tables and code stay in the chat.']) assert.ok(src.includes(s), name + ': ' + s);
    assert.ok(!src.includes('Longer parts, lists, tables and code stay in the chat.'), name + ': the old help text (lists stay in the chat) is gone');
    assert.ok(!src.includes('voiceIsNoteText'), name + ': notes are recognised by a flag, not by their text');
    assert.ok(!src.includes("const noteText = voiceSpeechText('| a |');"), name + ': the old single-note check is gone');
  }
  assert.ok(lib.includes('function voiceRestAnalysis(rest, extra, readWords, openTail, extraRaw) {'));
  assert.ok(app.includes('id="st-voice-details"') || app.includes("'st-voice-details'"), 'desktop select');
  assert.ok(app.includes('prefs.detailsReadWords = Number(details.value)'), 'desktop saves it');
  assert.ok(mob.includes("voicePrefsSave({ detailsReadWords: Number(details.value) })"), 'phone sheet saves it');
  assert.ok(mob.includes("save({ detailsReadWords: Number(details.value) })"), 'phone panel saves it');
  assert.ok(read('mobile.html').includes('id="vp-details"'));
  assert.ok(!read('agent-settings.html').includes('detailsReadWords'), 'the agent-level defaults are not extended');
});

// ── review round 1 ──
const LEAD = 'Here is the answer.';
const NEVER = /rm_all|npm run|alpha|echo|force|build/i;
test('code and tables inside a Markdown container are never read: a quoted fence, indented code, a quoted table', () => {
  const quotedFence = LEAD + '\n\n## Command\n> ```sh\n> rm_all --force now\n> ```';
  const indented = LEAD + '\n\n## Command\n\n    npm run build\n    npm test';
  const tabbed = LEAD + '\n\n## Command\n\n\tnpm run build';
  const quotedTable = LEAD + '\n\n## Scores\n> | Name | Score |\n> |---|---|\n> | Alpha | 10 |';
  const quotedIndented = LEAD + '\n\n## Command\n>\n>     npm run build';
  for (const [md, note] of [[quotedFence, NOTE_CODE], [indented, NOTE_CODE], [tabbed, NOTE_CODE], [quotedTable, NOTE_TABLE], [quotedIndented, NOTE_CODE]]) {
    const r = voiceReplySentences(md, true);
    assert.deepStrictEqual(r, { sentences: [LEAD], note }, JSON.stringify(md));
    assert.ok(!NEVER.test(r.sentences.join(' ')), 'no code or cell is read');
  }
  // an indented list item (nested) is not code
  const nested = LEAD + '\n\n- Check the disk\n    - the first disk\n- Check the logs';
  assert.strictEqual(voiceReplySentences(nested, true).note, '');
  // a table with outer pipes missing is caught by its delimiter row, also in a quote
  assert.strictEqual(voiceReplySentences(LEAD + '\n\n## Scores\n> Name | Score\n> --- | ---\n> Alpha | 10', true).note, NOTE_TABLE);
});

test('raw links and file paths are never read: in the lead\'s extra sentences, and any single one in the rest', async () => {
  assert.deepStrictEqual(voiceReplySentences('One. Two. Three. Visit https://a.com.', true), { sentences: ['One.', 'Two.', 'Three.'], note: NOTE });
  assert.deepStrictEqual(voiceReplySentences('One. Two. Three. Open /etc/app/x.conf.', true), { sentences: ['One.', 'Two.', 'Three.'], note: NOTE });
  assert.deepStrictEqual(voiceReplySentences('One. Two. Three. Visit www.example.com now.', true), { sentences: ['One.', 'Two.', 'Three.'], note: NOTE });
  // a labelled link is read by its label and does not count
  assert.deepStrictEqual(voiceReplySentences('One. Two. Three. See [the docs](https://a.com).', true), { sentences: ['One.', 'Two.', 'Three.', 'See the docs.'], note: '' });
  assert.deepStrictEqual(voiceReplySentences('Here it is.\n\n## Docs\nSee [the docs](https://a.com) now.', true), { sentences: ['Here it is.', 'Docs.', 'See the docs now.'], note: '' });
  assert.deepStrictEqual(await speakReply('One. Two. Three. Visit https://a.com.'), ['One.', 'Two.', 'Three.', NOTE]);
});

test('the note\'s kind: table first, then code, then list, then generic; a fenced block of "- " lines is code, not a list', () => {
  const yaml = 'Here is the config.\n\n```yaml\n- a: 1\n- b: 2\n- c: 3\n```';
  assert.deepStrictEqual(voiceReplySentences(yaml, true), { sentences: ['Here is the config.'], note: NOTE_CODE });
  const indentedYaml = 'Here is the config.\n\n## File\n\n    a: 1\n    b: 2\n    c: 3';
  assert.strictEqual(voiceReplySentences(indentedYaml, true).note, NOTE_CODE);
  const listAndTable = 'Here it is.\n\n- a\n- b\n- c\n\n| x | y |\n|---|---|\n| 1 | 2 |';
  assert.strictEqual(voiceReplySentences(listAndTable, true).note, NOTE_TABLE);
  const listAndCode = 'Here it is.\n\n- a\n- b\n- c\n\n```sh\nls\n```';
  assert.strictEqual(voiceReplySentences(listAndCode, true).note, NOTE_CODE);
  assert.strictEqual(voiceReplySentences(LIST12, true).note, NOTE_LIST);
  assert.strictEqual(voiceReplySentences(LONG, true).note, NOTE);
});

test('a note is recognised by its flag, not its text: an agent sentence equal to a note is counted as a sentence', async () => {
  const md = 'I\'ve put the table in the chat. Two is here. Three is here. Four is here.';
  const h = await startedCall();
  h.call.onReplyText(md, true); await tick();
  h.hd.onSpeechStart();   // barge-in: the first line is playing, three wait
  await tick();
  h.hd.onMisfire && h.hd.onMisfire();   // a false start: all four are read again, none skipped
  await tick(); await h.drain();
  const spoken = h.spoken.slice(1);
  assert.deepStrictEqual(spoken, ['I\'ve put the table in the chat.', 'Two is here.', 'Three is here.', 'Four is here.']);
  // a real note cut by a false start is read again once
  const g = await startedCall();
  g.call.onReplyText(TABLE10, true); await tick(); await g.drain();
  g.hd.onSpeechStart(); await tick(); g.hd.onMisfire && g.hd.onMisfire(); await tick(); await g.drain();
  assert.strictEqual(g.spoken.filter(s => /in the chat/.test(s)).length >= 1, true);
});

test('once done was processed, a later done for the same reply never lowers what was spoken: nothing is read twice', async () => {
  const prefs = { detailsReadWords: 40 };
  const h = await startedCall(prefs);
  const sendTurn = async () => { h.t += 20000; for (let k = 0; k < 3; k++) for (const t of h.timers.filter(x => x.at <= h.t)) { h.timers = h.timers.filter(x => x !== t); t.fn(); await tick(40); } await h.drain(); };
  await sendTurn();   // the first turn is sent
  assert.strictEqual(h.sent.length, 1);
  const said = () => h.spoken.filter(s => !/considering/.test(s));   // not the thinking line
  h.call.onReplyText(TWO_ITEMS, false); await tick(); await h.drain();
  h.call.onReplyText(TWO_ITEMS, true); await tick(); await h.drain();
  assert.deepStrictEqual(said(), ['Here are the two checks.', 'Check the disk.', 'Check the logs.']);
  prefs.detailsReadWords = 0;   // the pref changed: the sentence count is lower now
  h.call.onReplyText(TWO_ITEMS, true); await tick(); await h.drain();
  assert.deepStrictEqual(said(), ['Here are the two checks.', 'Check the disk.', 'Check the logs.'], 'no re-queue, no duplicate');
  // a new reply starts afresh
  h.running = false;   // the turn is over
  h.hd.onSpeechStart(); h.hd.onSpeechEnd({ text: 'and more' }); await tick();
  await sendTurn();   // the pause ends: the second turn is sent
  assert.strictEqual(h.sent.length, 2, 'the second turn was sent');
  const before = said().length;
  h.call.onReplyText(FOUR, true); await tick(); await h.drain();
  assert.deepStrictEqual(said().slice(before), ['One is here.', 'Two is here.', 'Three is here.', NOTE]);
});

// ── review round 2 ──
test('22. an indented YAML list after a blank line or a heading is code, not a nested list (spaces and a tab)', () => {
  const spaces = 'Here is the config.\n\n## YAML\n\n    - alpha: 1\n    - beta: 2';
  const tab = 'Here is the config.\n\n## YAML\n\n\t- alpha: 1\n\t- beta: 2';
  for (const md of [spaces, tab]) {
    const r = voiceReplySentences(md, true);
    assert.deepStrictEqual(r, { sentences: ['Here is the config.'], note: NOTE_CODE }, JSON.stringify(md));
    assert.ok(!/alpha|beta/.test(r.sentences.join(' ')), 'the code is never read');
  }
  // the rest starting with an indented list, and one after a fence close, are code too
  assert.strictEqual(voiceReplySentences('Here it is.\n\n    - alpha: 1\n    - beta: 2', true).note, NOTE_CODE);
  // a nested item inside a real list stays a list item, also after a blank line (a loose list)
  assert.strictEqual(voiceReplySentences(LEAD + '\n\n- Check the disk\n\n    - the first disk\n- Check the logs', true).note, '');
  assert.strictEqual(voiceReplySentences(LEAD + '\n\n1. Check the disk\n    - the first disk\n    - the second disk\n2. Check the logs', true).note, '');
});

test('23. indented code directly after a heading (no blank line) is code', () => {
  assert.deepStrictEqual(voiceReplySentences('Here is the answer.\n\n## Command\n    npm run build', true), { sentences: [LEAD], note: NOTE_CODE });
  assert.deepStrictEqual(voiceReplySentences('Here is the answer.\n\n## Command\n\tnpm run build', true), { sentences: [LEAD], note: NOTE_CODE });
});

test('24. the words "a link" / "a file path" in prose are not a raw link or path; a real one still is', () => {
  assert.deepStrictEqual(voiceReplySentences('One. Two. Three. This creates a link between the two ideas.', true),
    { sentences: ['One.', 'Two.', 'Three.', 'This creates a link between the two ideas.'], note: '' });
  assert.deepStrictEqual(voiceReplySentences('One. Two. Three. Pick a file path that you like.', true),
    { sentences: ['One.', 'Two.', 'Three.', 'Pick a file path that you like.'], note: '' });
  assert.deepStrictEqual(voiceReplySentences('One. Two. Three. Visit https://a.com.', true), { sentences: ['One.', 'Two.', 'Three.'], note: NOTE });
  assert.deepStrictEqual(voiceReplySentences('One. Two. Three. Open /etc/app/x.conf.', true), { sentences: ['One.', 'Two.', 'Three.'], note: NOTE });
  // ordinary words in the rest are not raw either
  assert.deepStrictEqual(voiceReplySentences('Here it is.\n\n## Notes\nThis creates a link and a file path for you.', true),
    { sentences: ['Here it is.', 'Notes.', 'This creates a link and a file path for you.'], note: '' });
  assert.strictEqual(voiceReplySentences('Here it is.\n\n## Notes\nSee /etc/app/x.conf for you.', true).note, NOTE);
  assert.strictEqual(V.voicePathsToWords('See /etc/app/x.conf now'), 'See a file path now', 'the default word is unchanged');
  assert.strictEqual(V.voicePathsToWords('See /etc/app/x.conf now', 'PATH'), 'See PATH now');
  assert.strictEqual(voiceSpeechText('See /etc/app/x.conf now and https://a.com'), 'See a file path now and a link.');
});

test('25. an interjection starts a new reply: a done that arrives alone with fewer sentences than were spoken is spoken, with its own note', async () => {
  const h = await startedCall();
  const sendTurn = async () => { h.t += 20000; for (let k = 0; k < 3; k++) for (const t of h.timers.filter(x => x.at <= h.t)) { h.timers = h.timers.filter(x => x !== t); t.fn(); await tick(40); } await h.drain(); };
  await sendTurn();
  assert.strictEqual(h.sent.length, 1);
  const said = () => h.spoken.filter(s => !/considering/.test(s));
  h.call.onReplyText(TWO_ITEMS, false); await tick(); await h.drain();
  h.call.onReplyText(TWO_ITEMS, true); await tick(); await h.drain();   // done processed: three sentences spoken
  assert.strictEqual(said().length, 3);
  // the turn is still running; the person interjects (it is sent as an interjection, not a new turn)
  h.running = true;
  h.hd.onSpeechStart(); h.hd.onSpeechEnd({ text: 'and one more thing' }); await tick();
  await sendTurn();
  assert.strictEqual(h.sent.length, 1, 'an interjection, not a new turn');
  const before = said().length;
  h.call.onReplyText('Fine.', true); await tick(); await h.drain();   // the new reply arrives only as done, one sentence
  assert.deepStrictEqual(said().slice(before), ['Fine.']);
  // and it says its own note once
  const mid = said().length;
  h.running = true;
  h.hd.onSpeechStart(); h.hd.onSpeechEnd({ text: 'again please' }); await tick();
  await sendTurn();
  h.call.onReplyText(CODE, true); await tick(); await h.drain();
  assert.strictEqual(said().slice(mid).filter(s => s === NOTE_CODE).length, 1, 'the new reply says its own note, once');
});
