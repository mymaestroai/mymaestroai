'use strict';
// Voice fixes round 2 (helpers): voiceSoundsUnfinished and the new per-device prefs (continueWait, thinkingSound, thinkingVolume).
const { test } = require('node:test');
const assert = require('node:assert');
const V = require('../lib/ui-voice');
const { voiceSoundsUnfinished: u, voiceLoadPrefs, voiceSavePrefs } = V;

function memStore(init) { const m = new Map(Object.entries(init || {})); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } }; }

test('voiceSoundsUnfinished: ends on a joining word, a comma, a dash or an ellipsis, or is a 1-2 word fragment', () => {
  for (const w of ['and', 'also', 'but', 'or', 'because', 'so', 'to', 'the', 'a', 'an', 'of', 'that', 'when', 'if', 'with', 'for', 'from', 'about', 'like', 'which', 'who', 'I', 'you', 'we', 'it',
    'is', 'are', 'was', 'my', 'your', 'our', 'their', 'this', 'these', 'then', 'as', 'at', 'in', 'on', 'by', 'than', 'just', 'really', 'very', 'um', 'uh', 'er', 'hmm']) {
    assert.strictEqual(u('please check the logs for the server ' + w), true, w);
  }
  assert.strictEqual(u('well it is what it is you know'), true, 'you know');
  assert.strictEqual(u('so the thing is, I mean'), true, 'I mean');
  assert.strictEqual(u('first of all, the logs,'), true, 'a comma');
  assert.strictEqual(u('and then I thought…'), true, 'an ellipsis');
  assert.strictEqual(u('and then I thought...'), true, 'three dots');
  assert.strictEqual(u('the thing is —'), true, 'a dash');
  assert.strictEqual(u('hello there'), true, 'two words without a stop');
  assert.strictEqual(u('turn it'), true);
  assert.strictEqual(u('Uh huh'), true);
  assert.strictEqual(u('Maybe'), true, 'one word without a stop');
});

test('voiceSoundsUnfinished: whole sentences, questions and stop / now / later / skip words are finished', () => {
  for (const s of ['Turn on the light in the kitchen.', 'turn on the light in the kitchen', 'What time is it?', 'Can you do that?', 'Really!', 'Okay.', 'Yes.',
    'stop', 'Stop.', 'cancel', 'never mind', 'now', 'Later.', 'skip', 'no', 'Open the file called report', 'I would like you to summarise the report']) {
    assert.strictEqual(u(s), false, s);
  }
  assert.strictEqual(u(''), false); assert.strictEqual(u(null), false); assert.strictEqual(u(undefined), false); assert.strictEqual(u('   '), false);
});

test('voiceSoundsUnfinished: Whisper puts a full stop on a cut-off piece; it is stripped before the last word is checked', () => {
  assert.strictEqual(u('you are in a voice chat because in a voice chat it\'s very difficult to.'), true);
  assert.strictEqual(u('I think you and other agents should know when.'), true);
  assert.strictEqual(u('and also.'), true);
  assert.strictEqual(u('to be able to change the speed of the voice that\'s coming at us and also'), true);
  assert.strictEqual(u('for you to articulate things like dashes and symbols so you should avoid using those in a voice chat.'), false);
});

test('voiceSoundsUnfinished: complete sentences that end in a particle are finished; CJK stops count like . ! ?', () => {
  for (const s of ['Turn the light on.', 'Log in.', 'I think so.', 'I guess so.', 'Sign in.', 'Go on.', 'Come in.', '我喜欢这个。', '你好吗？', '太好了！']) {
    assert.strictEqual(u(s), false, s);
  }
  for (const s of ['Turn the light on', 'I think so', 'Log in']) assert.strictEqual(u(s), true, s + ' (no final stop: a weak word still reads as cut off)');
  assert.strictEqual(u('I think you and other agents should know when'), true);
  for (const w of ['and', 'also', 'but', 'or', 'because', 'to', 'the', 'a', 'an', 'of', 'when', 'if', 'with', 'from', 'about', 'like', 'my', 'your', 'our', 'their', 'very', 'um', 'uh', 'er', 'hmm']) {
    assert.strictEqual(u('please check the logs ' + w + '.'), true, w + ' with a final stop');
  }
});

test('prefs: continueWait is one of 1.5 / 3 / 5 s, thinkingSound a boolean, thinkingVolume 0..1', () => {
  const load = (o) => voiceLoadPrefs(memStore({ 'hub-voice': JSON.stringify(o) }));
  assert.deepStrictEqual([load({}).continueWait, load({}).thinkingSound, load({}).thinkingVolume], [3000, true, 0.5], 'defaults');
  assert.strictEqual(load({ continueWait: 1500 }).continueWait, 1500);
  assert.strictEqual(load({ continueWait: 5000 }).continueWait, 5000);
  assert.strictEqual(load({ continueWait: 4000 }).continueWait, 3000, 'not one of the three: the default');
  assert.strictEqual(load({ continueWait: '5000' }).continueWait, 3000);
  assert.strictEqual(load({ thinkingSound: false }).thinkingSound, false);
  assert.strictEqual(load({ thinkingSound: 'no' }).thinkingSound, true);
  assert.strictEqual(load({ thinkingVolume: 0.2 }).thinkingVolume, 0.2);
  assert.strictEqual(load({ thinkingVolume: 7 }).thinkingVolume, 1);
  assert.strictEqual(load({ thinkingVolume: -1 }).thinkingVolume, 0);
  assert.strictEqual(load({ thinkingVolume: 'loud' }).thinkingVolume, 0.5);
  const st = memStore();
  voiceSavePrefs(st, { continueWait: 1500, thinkingSound: false, thinkingVolume: 0.3 });
  const back = voiceLoadPrefs(st);
  assert.deepStrictEqual([back.continueWait, back.thinkingSound, back.thinkingVolume], [1500, false, 0.3]);
});

test('whole sentences ending on a pronoun or "that" are finished; strong joining words stay unfinished even with a full stop', () => {
  const { voiceSoundsUnfinished: u } = require('../lib/ui-voice');
  for (const t of ['Do it.', 'Thank you for that.', 'That is what it is.', 'Turn on the light.', 'Can you help me?']) assert.strictEqual(u(t), false, t);
  for (const t of ['in a voice chat it is very difficult to.', 'I think you and other agents should know when', 'and the', 'I like that']) assert.strictEqual(u(t), true, t);
});
