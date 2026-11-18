'use strict';
// "Read it in full": when the person on a call asks to hear the details, the hub tells the page the reply must be read in full
// (voice_read_full chunk / turn_read_full event) and the call's onReadFull() switches the current reply to full mode:
// voiceReplySentences(markdown, done, readWords, true) and the controller. Fake clock, fake vad, fake speak; no network, no real data.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
Object.assign(globalThis, require('../lib/ui-voice'));
const { voiceCreateCall, voiceReplySentences } = require('../lib/ui-voice-call');

const tick = async (n = 6) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
function harness() {
  const h = { t: 0, timers: [], nextId: 1, log: [], spoken: [], pend: [], running: false, sent: [] };
  h.speak = (text) => new Promise((resolve) => { h.spoken.push(text); h.pend.push(resolve); });
  h.finish = async (ok = true) => { const r = h.pend.shift(); if (r) r(ok); await tick(); };
  h.drain = async () => { for (let i = 0; i < 60 && h.pend.length; i++) await h.finish(); };
  h.deps = {
    agent: 'a1', now: () => h.t, setTimer: (fn, ms) => { const id = h.nextId++; h.timers.push({ id, at: h.t + ms, fn }); return id; }, clearTimer: (id) => { h.timers = h.timers.filter(x => x.id !== id); },
    prefs: () => ({ micLevel: 50, interruptSensitivity: 50, continueWait: 0, detailsReadWords: 0 }),   // 0: short extra parts are never read on their own, so only full mode reads them
    vad: { start: async (hd) => { h.vadHandlers = hd; }, stop() {}, setPlaybackActive() {} },
    stt: async (audio) => audio.text, isTurnRunning: () => h.running,
    send: async (t) => { h.sent.push(t); h.running = true; }, interject: async () => {}, stop() {},
    speak: h.speak, cancelSpeech: () => { h.log.push('cancelSpeech'); const r = h.pend.shift(); if (r) r(false); },
    answerAsk() {},
    server: { start: async () => ({ callId: 'c1', held: [] }), heartbeat: async (c) => ({ callId: c, held: [] }), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} },
    ui: {},
  };
  h.call = voiceCreateCall(h.deps);
  h.say = async (text) => { h.vadHandlers.onSpeechStart(); h.vadHandlers.onSpeechEnd({ text }); await tick(); };
  return h;
}
async function started() { const h = harness(); assert.strictEqual(await h.call.start(), true); return h; }

const LONG = 'Here are the steps. First, open the file. Second, change the name. Third, save it.\n\n'
  + '- Fourth, run the tests.\n- Fifth, read the output.\n- Sixth, fix what failed.\n- Seventh, commit the work.\n'
  + '\nThat is all of it.';
const NOTE = voiceSpeechText('| a |');   // the generic details note: the long lead holds more than 3 sentences

// ---- voiceReplySentences ----

test('full mode reads every sentence of a long list reply, with no note', () => {
  const def = voiceReplySentences(LONG, true, 0);
  assert.strictEqual(def.sentences.length, 3);
  assert.ok(def.note, 'default: capped, with a note');
  const r = voiceReplySentences(LONG, true, 0, true);
  assert.strictEqual(r.note, '');
  assert.ok(r.sentences.length >= 8, JSON.stringify(r.sentences));
  assert.deepStrictEqual(r.sentences.slice(0, 3), def.sentences, 'the old lead is a prefix');
  const all = r.sentences.join(' ');
  for (const w of ['Fourth, run the tests', 'Seventh, commit the work', 'That is all of it']) assert.ok(all.includes(w), w);
});

test('full mode while streaming: only complete sentences, and each result is a prefix of the next', () => {
  let prev = [];
  for (let i = 1; i <= LONG.length; i += 3) {
    const r = voiceReplySentences(LONG.slice(0, i), false, 0, true);
    assert.strictEqual(r.note, '');
    assert.deepStrictEqual(r.sentences.slice(0, prev.length), prev, 'prefix at ' + i);
    prev = r.sentences;
  }
  const fin = voiceReplySentences(LONG, true, 0, true).sentences;
  assert.deepStrictEqual(fin.slice(0, prev.length), prev);
  assert.ok(!voiceReplySentences('One. Two. Three. Four. Fiv', false, 0, true).sentences.includes('Fiv'));
  assert.strictEqual(voiceReplySentences('One. Two. Three. Four. Five.', false, 0, true).sentences.length, 4, 'the open last sentence waits');
  assert.strictEqual(voiceReplySentences('One. Two. Three. Four. Five.', true, 0, true).sentences.length, 5);
});

test('full mode drops a table and a code block silently, with no note', () => {
  const md = 'Here it is.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nrun();\n```\n\nAnd then more words follow. Last one.';
  const r = voiceReplySentences(md, true, 0, true);
  assert.strictEqual(r.note, '');
  const all = r.sentences.join(' ');
  assert.ok(!/run\(\)|\b1\b|\ba b\b/.test(all), all);
  assert.ok(all.includes('Here it is') && all.includes('And then more words follow') && all.includes('Last one'), all);
  const noPipes = voiceReplySentences('Intro here.\n\nName | Value\n--- | ---\nx | y\n\nOutro here.', true, 0, true);
  assert.deepStrictEqual(noPipes.sentences, ['Intro here.', 'Outro here.']);
  assert.strictEqual(noPipes.note, '');
  const streaming = voiceReplySentences('Intro here.\n\nName | Val', false, 0, true);
  assert.deepStrictEqual(streaming.sentences, ['Intro here.'], 'a line that may be a table header is held');
});

test('without the 4th argument (or anything but true) the behaviour is unchanged', () => {
  for (const md of [LONG, 'One. Two. Three. Four.', 'Lead.\n| a |\n|--|\n| 1 |']) {
    for (const done of [false, true]) {
      const base = voiceReplySentences(md, done, 40);
      assert.deepStrictEqual(voiceReplySentences(md, done, 40, undefined), base);
      assert.deepStrictEqual(voiceReplySentences(md, done, 40, false), base);
      assert.deepStrictEqual(voiceReplySentences(md, done, 40, 'yes'), base);
    }
  }
  assert.deepStrictEqual(voiceReplySentences('One. Two. Three. Four.', true, 0), { sentences: ['One.', 'Two.', 'Three.'], note: voiceSpeechText('| a |') });
});

// ---- the controller ----

test('onReadFull before the first text: the whole reply is read, no note', async () => {
  const h = await started();
  await h.say('tell me the details');
  h.call.onReadFull();
  h.call.onReplyText('Here are the steps.', false);
  h.call.onReplyText(LONG, true);
  await h.drain();
  const all = h.spoken.join(' ');
  assert.ok(all.includes('Seventh, commit the work') && all.includes('That is all of it'), all);
  assert.ok(!h.spoken.includes(NOTE), 'no note');
  assert.ok(h.spoken.length >= 8);
});

test('onReadFull mid-reply: sentences beyond the old cap are enqueued as they complete', async () => {
  const h = await started();
  await h.say('what are the steps');
  h.call.onReplyText('One is here. Two is here. Three is here.\n\n- Four is here.\n- Five is here.\n', false);
  await h.drain();
  assert.deepStrictEqual(h.spoken, ['One is here.', 'Two is here.', 'Three is here.']);
  h.call.onReadFull();
  await h.drain();
  assert.deepStrictEqual(h.spoken.slice(3), ['Four is here.', 'Five is here.'], 'what was held back is read now');
  h.call.onReplyText('One is here. Two is here. Three is here.\n\n- Four is here.\n- Five is here.\n- Six is here.\n- Sev', false);
  await h.drain();
  assert.strictEqual(h.spoken[5], 'Six is here.');
  assert.ok(!h.spoken.includes('Sev'));
  h.call.onReplyText('One is here. Two is here. Three is here.\n\n- Four is here.\n- Five is here.\n- Six is here.\n- Seven is here.', true);
  await h.drain();
  assert.strictEqual(h.spoken.length, 7);
  assert.strictEqual(h.spoken.filter(s => s === 'Seven is here.').length, 1);
  assert.ok(!h.spoken.some(s => /in the chat/.test(s)));
});

test('onReadFull after done with a note queued: the note is dropped and the rest is read', async () => {
  const h = await started();
  await h.say('list them');
  h.call.onReplyText(LONG, true);
  await tick();
  assert.strictEqual(h.spoken.length, 1, 'the first lead sentence plays, the rest waits in the queue with the note');
  h.call.onReadFull();
  await h.drain();
  const all = h.spoken.join(' ');
  assert.ok(!h.spoken.includes(NOTE), 'the queued note is gone: ' + all);
  assert.ok(all.includes('Seventh, commit the work') && all.includes('That is all of it'), all);
  assert.strictEqual(new Set(h.spoken).size, h.spoken.length, 'nothing read twice');
});

test('the flag is reset when the next turn begins', async () => {
  const h = await started();
  await h.say('details please');
  h.call.onReadFull();
  h.call.onReplyText(LONG, true);
  await h.drain();
  assert.ok(!h.spoken.includes(NOTE));
  h.running = false;
  const before = h.spoken.length;
  await h.say('and another question');
  h.call.onReplyText(LONG, true);
  await h.drain();
  const second = h.spoken.slice(before);
  assert.strictEqual(second.length, 4, 'three lead sentences and the note again: ' + JSON.stringify(second));
  assert.strictEqual(second[3], NOTE);
});

test('the flag is reset when an interjection begins a new reply', async () => {
  const h = await started();
  await h.say('details please');
  h.call.onReadFull();
  h.call.onReplyText('Short answer.', false);
  await h.drain();
  await h.say('and one more thing');   // the turn still runs: an interjection
  h.call.onReplyText('Short answer. ' + LONG, true);
  await h.drain();
  assert.ok(h.spoken.includes(NOTE), 'the interjected reply is capped again unless it is flagged: ' + JSON.stringify(h.spoken));
});

test('barge-in during a full reading cuts it at once and nothing more of that reply is read', async () => {
  const h = await started();
  await h.say('read me everything');
  h.call.onReadFull();
  h.call.onReplyText(LONG, false);
  await tick();
  assert.deepStrictEqual(h.spoken, ['Here are the steps.']);
  h.vadHandlers.onSpeechStart();   // the person talks over it
  await tick();
  assert.deepStrictEqual(h.log, ['cancelSpeech'], 'cut at once');
  h.call.onReplyText(LONG, true);   // the rest of the reply arrives while the person talks
  h.vadHandlers.onSpeechEnd({ text: 'stop there' });
  await tick(); await h.drain();
  assert.deepStrictEqual(h.spoken, ['Here are the steps.'], 'nothing more of the cut reply is read');
  assert.ok(!h.spoken.includes(NOTE));
});

test('onReadFull on a cut reply does not bring the reading back', async () => {
  const h = await started();
  await h.say('read me everything');
  h.call.onReplyText(LONG.slice(0, 40), false);
  await tick();
  h.vadHandlers.onSpeechStart();
  await tick();
  h.call.onReadFull();
  h.call.onReplyText(LONG, true);
  await tick(); await h.drain();
  assert.deepStrictEqual(h.spoken, ['Here are the steps.']);
});

// ---- the pages ----

test('the pages wire voice_read_full and turn_read_full next to the mood ones', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const mob = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
  assert.ok(/oc2\.type === 'voice_read_full'/.test(app) && /addEventListener\('turn_read_full'/.test(app) && /case 'turn_read_full': if \(S\.own\.has\(ev\.turnId\)/.test(app));
  assert.ok(/case 'voice_read_full':/.test(mob) && /on\('turn_read_full'/.test(mob) && /ev\.agent !== vc\.agent \|\| !vc\.callTurns\.has\(ev\.turnId\)/.test(mob.slice(mob.indexOf('function voiceCallTurnReadFull'))));
  assert.ok(/onReadFull/.test(app) && /onReadFull/.test(mob));
});
