'use strict';
// The voice helpers (2026-11-12): what a reply is spoken from, sentence splitting, audio resampling and WAV, level and
// meter maths, per-device settings and stop commands. lib/ui-voice.js is the source; the pages carry byte-identical
// copies of it (app.js, mobile.js) and these tests prove the copies match and the behaviour is right.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const V = require('../lib/ui-voice');
const { voiceSpeechText, voiceSentences, voiceResample, voiceEncodeWav, voiceDecodeWav, voiceLevelDb, voiceGainFromSlider,
  voiceSliderFromGain, voiceMeterPercent, voiceLoadPrefs, voiceSavePrefs, voiceIsStopCommand } = V;

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const BEGIN = '// ── voice helpers (begin) ──';
const END = '// ── voice helpers (end) ──';
function helperBlock(src, indent) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  assert.ok(a > 0 && b > a, 'helper markers present');
  return src.slice(a + BEGIN.length, b).split('\n').map(l => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n').trim();
}
const memStore = (init) => {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, _m: m };
};
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test('the pages carry the helpers byte for byte', () => {
  const lib = helperBlock(read('lib/ui-voice.js'), '');
  assert.ok(lib.includes('function voiceSpeechText'), 'block has content');
  assert.strictEqual(helperBlock(read('app.js'), '    '), lib, 'app.js copy');
  assert.strictEqual(helperBlock(read('mobile.js'), ''), lib, 'mobile.js copy');
});

test('speech text: code and tables are left out and a note is added once', () => {
  const md = 'Here is the fix.\n\n```js\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nDone.';
  assert.strictEqual(voiceSpeechText(md), 'Here is the fix. Done. I have put the details in the chat.');
  assert.strictEqual(voiceSpeechText('Look:\n```\nx\n```\nand\n```\ny\n```\nok'), 'Look: and. ok. I have put the details in the chat.');   // a removed code block ends the paragraph: each piece gets a full stop (changed on purpose)
  assert.strictEqual(voiceSpeechText('| a | b |\n|--|--|\n| 1 | 2 |'), 'I have put the details in the chat.');
  assert.strictEqual(voiceSpeechText('Unclosed:\n```\ncode forever'), 'Unclosed: I have put the details in the chat.');
  assert.strictEqual(voiceSpeechText('No code here.'), 'No code here.');
});

test('speech text: links, URLs and markdown marks', () => {
  assert.strictEqual(voiceSpeechText('See [the docs](https://example.com/a?b=1) now.'), 'See the docs now.');
  assert.strictEqual(voiceSpeechText('Go to https://example.com/x, then stop.'), 'Go to a link, then stop.');
  assert.strictEqual(voiceSpeechText('Visit www.example.com today'), 'Visit a link today.');   // the cleaner ends every spoken block with a full stop (changed on purpose)
  assert.strictEqual(voiceSpeechText('This is **bold**, *italic*, _under_ and `code`.'), 'This is bold, italic, under and code.');
  assert.strictEqual(voiceSpeechText('# Title\n> quoted line\n- one\n* two\n+ three\n1. first\n2) second'), 'Title. quoted line. one. two. three. first. second.');   // headings and list items are separate spoken sentences now (changed on purpose)
  assert.strictEqual(voiceSpeechText('Use snake_case names'), 'Use snake case names.');
  assert.strictEqual(voiceSpeechText('Price is 3.5 dollars. Really!'), 'Price is 3.5 dollars. Really!');
  assert.strictEqual(voiceSpeechText('  lots   of\n\n\n space  '), 'lots of. space.');   // a blank line ends a block, which gets a full stop (changed on purpose)
  assert.strictEqual(voiceSpeechText(''), '');
  assert.strictEqual(voiceSpeechText(null), '');
});

test('speech text: emoji are dropped', () => {
  assert.strictEqual(voiceSpeechText('Great \u{1F600} job \u{1F44D}\u{1F3FD}! \u{2764}\u{FE0F} Thanks'), 'Great job! Thanks.');   // the space before '!' is closed up and the block ends in a full stop (changed on purpose)
  assert.strictEqual(voiceSpeechText('\u{1F468}\u200D\u{1F469}\u200D\u{1F467} family'), 'family.');
  assert.strictEqual(voiceSpeechText('Flag \u{1F1FA}\u{1F1F8} ok'), 'Flag ok.');
  assert.strictEqual(voiceSpeechText('Call 911 now #1'), 'Call 911 now 1.');
});

test('sentences: split on . ! ? but not inside numbers or abbreviations', () => {
  assert.deepStrictEqual(voiceSentences('Hello there. How are you? Fine! Thanks'), ['Hello there.', 'How are you?', 'Fine!', 'Thanks']);
  assert.deepStrictEqual(voiceSentences('It costs 3.5 dollars. Version 2.0.1 is out.'), ['It costs 3.5 dollars.', 'Version 2.0.1 is out.']);
  assert.deepStrictEqual(voiceSentences('Ask Dr. Smith, e.g. tomorrow, i.e. early. Then Mr. Jones met St. Paul.'),
    ['Ask Dr. Smith, e.g. tomorrow, i.e. early.', 'Then Mr. Jones met St. Paul.']);
  assert.deepStrictEqual(voiceSentences('Wait... what? Really?!'), ['Wait...', 'what?', 'Really?!']);
  assert.deepStrictEqual(voiceSentences('He said "go." Then left.'), ['He said "go."', 'Then left.']);
  assert.deepStrictEqual(voiceSentences(''), []);
  assert.deepStrictEqual(voiceSentences('   \n  '), []);
  assert.deepStrictEqual(voiceSentences(null), []);
});

test('sentences: a long sentence is split at ; , or spaces so none exceeds max', () => {
  const long = Array.from({ length: 100 }, (_, i) => 'word' + i).join(' ') + '.';   // far over 600 characters
  assert.ok(long.length > 600);
  const parts = voiceSentences(long);
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(p.length > 0 && p.length <= 220, `length ${p.length}`);
  assert.strictEqual(parts.join(' '), long);
  const commas = Array.from({ length: 60 }, (_, i) => 'clause' + i).join(', ') + '.';
  const cp = voiceSentences(commas, 100);
  for (const p of cp) assert.ok(p.length <= 100);
  assert.ok(cp.slice(0, -1).every(p => p.endsWith(',')), 'cuts at commas');
  assert.strictEqual(cp.join(' '), commas);
  const semi = voiceSentences('alpha beta gamma; delta epsilon zeta; eta theta iota', 30);
  assert.deepStrictEqual(semi, ['alpha beta gamma;', 'delta epsilon zeta;', 'eta theta iota']);
  const solid = voiceSentences('x'.repeat(600), 220);   // no break point at all
  assert.deepStrictEqual(solid.map(p => p.length), [220, 220, 160]);
  assert.deepStrictEqual(voiceSentences('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
});

test('resample: identity when equal, length follows the rate, linear interpolation', () => {
  const a = Float32Array.from([0, 0.5, -0.5, 1]);
  const same = voiceResample(a, 16000, 16000);
  assert.ok(same instanceof Float32Array);
  assert.deepStrictEqual(Array.from(same), Array.from(a));
  assert.strictEqual(voiceResample(new Float32Array(48000), 48000, 16000).length, 16000);
  assert.strictEqual(voiceResample(new Float32Array(16000), 16000, 48000).length, 48000);
  assert.strictEqual(voiceResample(new Float32Array(44100), 44100, 16000).length, 16000);
  const up = voiceResample(Float32Array.from([0, 1]), 1, 2);
  assert.strictEqual(up.length, 4);
  near(up[0], 0); near(up[1], 0.5); near(up[2], 1); near(up[3], 1);
  const down = voiceResample(Float32Array.from([0, 1, 2, 3]), 4, 2);
  assert.deepStrictEqual(Array.from(down), [0, 2]);
  assert.strictEqual(voiceResample(new Float32Array(0), 8000, 16000).length, 0);
});

test('WAV: 44-byte header, 16-bit mono, and a round trip', () => {
  const src = Float32Array.from([0, 0.25, -0.25, 0.5, -0.5, 1, -1]);
  const buf = voiceEncodeWav(src, 16000);
  assert.ok(buf instanceof ArrayBuffer);
  assert.strictEqual(buf.byteLength, 44 + src.length * 2);
  const v = new DataView(buf), tag = (o) => String.fromCharCode(...new Uint8Array(buf, o, 4));
  assert.strictEqual(tag(0), 'RIFF'); assert.strictEqual(tag(8), 'WAVE'); assert.strictEqual(tag(12), 'fmt '); assert.strictEqual(tag(36), 'data');
  assert.strictEqual(v.getUint32(4, true), 36 + src.length * 2);
  assert.strictEqual(v.getUint16(20, true), 1);       // PCM
  assert.strictEqual(v.getUint16(22, true), 1);       // mono
  assert.strictEqual(v.getUint32(24, true), 16000);
  assert.strictEqual(v.getUint32(28, true), 32000);   // byte rate
  assert.strictEqual(v.getUint16(34, true), 16);
  assert.strictEqual(v.getUint32(40, true), src.length * 2);
  const back = voiceDecodeWav(buf);
  assert.strictEqual(back.sampleRate, 16000);
  assert.strictEqual(back.samples.length, src.length);
  src.forEach((x, i) => near(back.samples[i], x, 1 / 16384));
  const loud = voiceDecodeWav(voiceEncodeWav(Float32Array.from([3, -3]), 8000));   // clipped, not wrapped
  near(loud.samples[0], 1, 1e-3); near(loud.samples[1], -1, 1e-3);
  const empty = voiceDecodeWav(voiceEncodeWav(new Float32Array(0), 8000));
  assert.strictEqual(empty.samples.length, 0);
});

test('WAV: stereo is averaged, extra chunks skipped, bad input throws', () => {
  const frames = [[16384, -16384], [32767, 0], [-32768, -32768]];
  const buf = new ArrayBuffer(44 + frames.length * 4), v = new DataView(buf);
  const tag = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + frames.length * 4, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, 44100, true);
  v.setUint32(28, 44100 * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); tag(36, 'data'); v.setUint32(40, frames.length * 4, true);
  frames.forEach(([l, r], i) => { v.setInt16(44 + i * 4, l, true); v.setInt16(46 + i * 4, r, true); });
  const out = voiceDecodeWav(buf);
  assert.strictEqual(out.sampleRate, 44100);
  assert.strictEqual(out.samples.length, 3);
  near(out.samples[0], 0); near(out.samples[1], 32767 / 2 / 32768); near(out.samples[2], -1);
  // a LIST chunk between fmt and data is skipped
  const mono = new Uint8Array(voiceEncodeWav(Float32Array.from([0.5]), 8000));
  const withList = new Uint8Array(mono.length + 12);
  withList.set(mono.subarray(0, 36)); withList.set([76, 73, 83, 84, 4, 0, 0, 0, 1, 2, 3, 4], 36); withList.set(mono.subarray(36), 48);
  const dec = voiceDecodeWav(withList.buffer);
  assert.strictEqual(dec.sampleRate, 8000); near(dec.samples[0], 0.5, 1e-3);
  assert.throws(() => voiceDecodeWav(new ArrayBuffer(10)));
  assert.throws(() => voiceDecodeWav(new ArrayBuffer(64)));
});

test('level: RMS in dBFS; silence is -100, full scale is 0', () => {
  assert.strictEqual(voiceLevelDb(new Float32Array(100)), -100);
  assert.strictEqual(voiceLevelDb(new Float32Array(0)), -100);
  near(voiceLevelDb(new Float32Array(100).fill(1)), 0);
  near(voiceLevelDb(new Float32Array(100).fill(-1)), 0);
  near(voiceLevelDb(new Float32Array(100).fill(0.5)), -6.0206, 1e-3);
  near(voiceLevelDb(new Float32Array(100).fill(0.1)), -20, 1e-4);
  const sine = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(2 * Math.PI * i / 100));
  near(voiceLevelDb(sine), -3.0103, 1e-3);   // a full-scale sine is 3 dB below a full-scale square
  assert.strictEqual(voiceLevelDb(new Float32Array(10).fill(1e-9)), -100);   // clamped at the floor
});

test('gain slider: 0 = -12 dB, 50 = 1, 100 = +12 dB, log-linear, clamped, with an inverse', () => {
  near(voiceGainFromSlider(50), 1);
  near(voiceGainFromSlider(0), 0.25, 0.01);
  near(voiceGainFromSlider(100), 4, 0.02);
  near(20 * Math.log10(voiceGainFromSlider(0)), -12, 1e-9);
  near(20 * Math.log10(voiceGainFromSlider(100)), 12, 1e-9);
  near(20 * Math.log10(voiceGainFromSlider(75)), 6, 1e-9);   // linear in dB
  assert.strictEqual(voiceGainFromSlider(-20), voiceGainFromSlider(0));
  assert.strictEqual(voiceGainFromSlider(500), voiceGainFromSlider(100));
  assert.strictEqual(voiceGainFromSlider(NaN), 1);
  for (const s of [0, 1, 25, 50, 62.5, 99, 100]) near(voiceSliderFromGain(voiceGainFromSlider(s)), s, 1e-9);
  near(voiceSliderFromGain(1), 50); near(voiceSliderFromGain(0.25), 0, 0.5); near(voiceSliderFromGain(4), 100, 0.5);
  assert.strictEqual(voiceSliderFromGain(0), 0);
  assert.strictEqual(voiceSliderFromGain(-1), 0);
  assert.strictEqual(voiceSliderFromGain(100), 100);
  assert.strictEqual(voiceSliderFromGain(0.001), 0);
});

test('meter: -60 dB is 0, 0 dB is 100, clamped', () => {
  assert.strictEqual(voiceMeterPercent(-60), 0);
  assert.strictEqual(voiceMeterPercent(0), 100);
  assert.strictEqual(voiceMeterPercent(-30), 50);
  assert.strictEqual(voiceMeterPercent(-100), 0);
  assert.strictEqual(voiceMeterPercent(6), 100);
  assert.strictEqual(voiceMeterPercent(-Infinity), 0);
  assert.strictEqual(voiceMeterPercent(NaN), 0);
});

test('prefs: defaults, merge, bad values and bad JSON', () => {
  assert.strictEqual(V.VOICE_STORE_KEY, 'hub-voice');
  const defaults = { micLevel: 50, interruptSensitivity: 50, mode: 'handsfree', readAloud: true, deviceVoiceFallback: true, endPause: 1200, voiceSpeed: 1, speakActivity: false, continueWait: 3000, thinkingSound: true, thinkingVolume: 0.5, echoHold: 600, keepAlive: true, loudness: 'louder' };   // voice fixes round 2: wait for more, thinking sound; Bluetooth / car: echo guard, keep-alive
  assert.deepStrictEqual(voiceLoadPrefs(memStore()), defaults);
  assert.deepStrictEqual(voiceLoadPrefs(memStore({ 'hub-voice': '{not json' })), defaults);
  assert.deepStrictEqual(voiceLoadPrefs(memStore({ 'hub-voice': 'null' })), defaults);
  assert.deepStrictEqual(voiceLoadPrefs(memStore({ 'hub-voice': '[1,2]' })), defaults);
  assert.deepStrictEqual(voiceLoadPrefs(null), defaults);
  assert.deepStrictEqual(voiceLoadPrefs({ getItem() { throw new Error('blocked'); } }), defaults);
  assert.deepStrictEqual(voiceLoadPrefs(memStore({ 'hub-voice': '{"micLevel":80,"mode":"tap","extra":1}' })),
    { ...defaults, micLevel: 80, mode: 'tap' });
  assert.deepStrictEqual(voiceLoadPrefs(memStore({ 'hub-voice': '{"micLevel":"loud","mode":"shout","readAloud":"yes","interruptSensitivity":900}' })),
    { ...defaults, interruptSensitivity: 100 });
  const st = memStore();
  const saved = voiceSavePrefs(st, { micLevel: 20, readAloud: false });
  assert.deepStrictEqual(saved, { ...defaults, micLevel: 20, readAloud: false });
  assert.deepStrictEqual(JSON.parse(st._m.get('hub-voice')), saved);
  assert.deepStrictEqual(voiceLoadPrefs(st), saved);
  voiceSavePrefs(st, { mode: 'tap' });   // keeps what was saved before
  assert.deepStrictEqual(voiceLoadPrefs(st), { ...saved, mode: 'tap' });
  assert.doesNotThrow(() => voiceSavePrefs({ getItem: () => null, setItem() { throw new Error('quota'); } }, { micLevel: 1 }));
  assert.doesNotThrow(() => voiceSavePrefs(memStore(), null));
});

test('stop commands: the whole utterance only', () => {
  for (const yes of ['stop', 'Stop.', '  STOP!  ', 'cancel', 'stop stop', 'Stop, stop!', 'stop it', 'stop that', 'cancel that', 'never mind', 'Never mind.', 'nevermind', 'stop…'])
    assert.strictEqual(voiceIsStopCommand(yes), true, yes);
  for (const no of ['please stop the timer', 'stop the music', 'don\'t stop', 'cancel my order', 'stopping', 'never mind that', '', '   ', '...', null, undefined])
    assert.strictEqual(voiceIsStopCommand(no), false, String(no));
});

test('voicePickLocalVoice: only offline voices of the language, the default one first', () => {
  const { voicePickLocalVoice } = V;
  const on = { name: 'on', lang: 'en-US', localService: false, default: true };
  const a = { name: 'a', lang: 'en-GB', localService: true, default: false };
  const b = { name: 'b', lang: 'en-US', localService: true, default: true };
  const de = { name: 'de', lang: 'de-DE', localService: true, default: true };
  assert.strictEqual(voicePickLocalVoice([on, a, b], 'en'), b, 'the default offline voice');
  assert.strictEqual(voicePickLocalVoice([on, a], 'en'), a, 'any offline voice when none is the default');
  assert.strictEqual(voicePickLocalVoice([on, de], 'en'), null, 'online voices and other languages never');
  assert.strictEqual(voicePickLocalVoice([on, a, de], 'de'), de);
  assert.strictEqual(voicePickLocalVoice([on, a], undefined), a, "'en' by default");
  assert.strictEqual(voicePickLocalVoice([{ lang: 'en_US', localService: true }], 'en').lang, 'en_US', 'Android style tags');
  assert.strictEqual(voicePickLocalVoice([{ lang: 'en-US', localService: 'true' }], 'en'), null, 'strictly true');
  assert.strictEqual(voicePickLocalVoice([], 'en'), null);
  assert.strictEqual(voicePickLocalVoice(null, 'en'), null);
  assert.strictEqual(voicePickLocalVoice([null, undefined, a], 'en'), a);
});

test('voiceWaitLocalVoice: waits up to a second for voiceschanged when the list is empty', async () => {
  const local = { lang: 'en-US', localService: true, default: true };
  const ready = { getVoices: () => [local] };
  assert.strictEqual(await V.voiceWaitLocalVoice(ready, 'en', 50), local, 'no waiting when the list is there');
  let list = [], handlers = new Set();
  const late = { getVoices: () => list, addEventListener: (_, h) => handlers.add(h), removeEventListener: (_, h) => handlers.delete(h) };
  const p = V.voiceWaitLocalVoice(late, 'en', 1000);
  list = [local]; for (const h of [...handlers]) h();
  assert.strictEqual(await p, local, 'voiceschanged delivers the list');
  assert.strictEqual(handlers.size, 0, 'listener removed');
  const t0 = Date.now();
  const never = { getVoices: () => [], addEventListener() {}, removeEventListener() {} };
  assert.strictEqual(await V.voiceWaitLocalVoice(never, 'en', 40), null, 'times out with no voice');
  assert.ok(Date.now() - t0 < 900);
  assert.strictEqual(await V.voiceWaitLocalVoice(null, 'en', 40), null);
  assert.strictEqual(await V.voiceWaitLocalVoice({ getVoices: () => [{ lang: 'en-US', localService: false }] }, 'en', 40), null, 'only online voices: none');
});

test('voiceMicGuard: pending flag + generation; a stream for an old generation is closed at once', async () => {
  const g = V.voiceMicGuard();
  const t1 = g.begin();
  assert.strictEqual(g.begin(), -1, 'starting while pending is ignored');
  g.cancel();                       // stop / close / hidden bumps the generation
  let closed = 0;
  assert.strictEqual(g.settle(t1, { close() { closed++; } }), false, 'old generation');
  assert.strictEqual(closed, 1, 'the late stream was closed');
  assert.strictEqual(g.pending, false);
  const t2 = g.begin();
  assert.notStrictEqual(t2, -1);
  assert.strictEqual(g.settle(t2, { close() { closed++; } }), true, 'current generation is kept');
  assert.strictEqual(closed, 1);
  g.begin(); g.fail(); assert.strictEqual(g.pending, false, 'a failed request frees the guard');
  // with a fake getUserMedia that resolves late
  const open = async (gate) => { await gate; return { close() { closed++; } }; };
  let release; const gate = new Promise((r) => { release = r; });
  const tok = g.begin(); const pending = open(gate);
  g.cancel(); release();
  assert.strictEqual(g.settle(tok, await pending), false);
  assert.strictEqual(closed, 2);
});
