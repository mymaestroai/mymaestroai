'use strict';
// The hands-free call controller (voice phase 2, P1): routing, barge-in, reply reading, status lines, ask_user by voice,
// announcements, heartbeat and hang-up summary, the pure helpers and the VAD adapter. lib/ui-voice-call.js is the source;
// the pages carry byte-identical copies of it (app.js, mobile.js). Fake clock, fake vad, fake server, fake speak.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
Object.assign(globalThis, require('../lib/ui-voice'));   // the call file uses these helpers as globals, like the pages
const C = require('../lib/ui-voice-call');
const { voiceCreateCall, voiceCreateVad, voiceDecisionWord, voiceMatchChoice, voiceStatusLine, voiceRoomCheck, voiceVadThresholds,
  voiceReplySentences, voiceJoinOr } = C;

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const BEGIN = '// ── voice call (begin) ──';
const END = '// ── voice call (end) ──';
function callBlock(src, indent) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  assert.ok(a > 0 && b > a, 'call markers present');
  return src.slice(a + BEGIN.length, b).split('\n').map(l => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n').trim();
}
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function harness(over) {
  const h = { t: 0, timers: [], nextId: 1, log: [], states: [], heard: [], helds: [], toasts: [], summaries: [], spoken: [], pend: [], playing: [], sent: [], interjected: [], stops: 0, asks: [], decisions: [], hb: 0, running: false, endHeld: [], hbIds: [], modeIds: [], endIds: [], decideIds: [] };
  h.setTimer = (fn, ms) => { const id = h.nextId++; h.timers.push({ id, at: h.t + ms, fn }); return id; };
  h.clearTimer = (id) => { h.timers = h.timers.filter(x => x.id !== id); };
  h.advance = async (ms) => {
    const end = h.t + ms;
    for (;;) {
      const due = h.timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      h.timers = h.timers.filter(x => x !== due); h.t = due.at; due.fn(); await tick();
    }
    h.t = end; await tick();
  };
  h.speak = (text) => new Promise((resolve) => { h.spoken.push(text); h.pend.push(resolve); });
  h.finish = async (ok = true) => { const r = h.pend.shift(); if (r) r(ok); await tick(); };
  h.vadHandlers = null;
  h.vad = { start: async (hd) => { h.vadHandlers = hd; }, stop: () => { h.log.push('vad.stop'); }, setPlaybackActive: (b) => { h.playing.push(b); } };
  h.deps = {
    agent: 'a1', now: () => h.t, setTimer: h.setTimer, clearTimer: h.clearTimer, prefs: () => ({ micLevel: 50, interruptSensitivity: 50 }),
    vad: h.vad, stt: async (audio) => audio.text, isTurnRunning: () => h.running,
    send: async (t) => { h.sent.push(t); h.running = true; }, interject: async (t) => { h.interjected.push(t); }, stop: () => { h.stops++; h.log.push('stop'); },
    speak: h.speak, cancelSpeech: () => { h.log.push('cancelSpeech'); const r = h.pend.shift(); if (r) r(false); },
    answerAsk: (id, text) => { h.asks.push([id, text]); },
    server: { start: async (m) => { h.log.push('server.start ' + m); return { callId: 'call-1', held: h.startHeld || [] }; },
      heartbeat: async (cid) => { h.hb++; h.hbIds.push(cid); return { callId: cid, held: h.hbHeld || [] }; },
      mode: async (m, cid) => { h.log.push('server.mode ' + m); h.modeIds.push(cid); },
      end: async (cid) => { h.endIds.push(cid); return { held: h.endHeld }; }, decide: async (id, c, cid) => { h.decisions.push([id, c]); h.decideIds.push(cid); } },
    ui: { state: (n) => h.states.push(n), heard: (t) => h.heard.push(t), held: (l) => h.helds.push(l), toast: (m) => h.toasts.push(m), summary: (t) => h.summaries.push(t) },
  };
  Object.assign(h.deps, over || {});
  h.call = voiceCreateCall(h.deps);
  h.last = () => h.states[h.states.length - 1];
  h.say = async (text) => { h.vadHandlers.onSpeechStart(); h.vadHandlers.onSpeechEnd({ text }); await tick(); };   // the person says text
  return h;
}
async function started(over) { const h = harness(over); assert.strictEqual(await h.call.start(), true); return h; }

// ---- pure helpers ----

test('the pages carry the call controller byte for byte', () => {
  const lib = callBlock(read('lib/ui-voice-call.js'), '');
  assert.ok(lib.includes('function voiceCreateCall') && lib.includes('function voiceCreateVad'), 'block has content');
  assert.strictEqual(callBlock(read('app.js'), '    '), lib, 'app.js copy');
  assert.strictEqual(callBlock(read('mobile.js'), ''), lib, 'mobile.js copy');
  const app = read('app.js'), mob = read('mobile.js');
  assert.ok(app.indexOf('// ── voice helpers (end) ──') < app.indexOf(BEGIN), 'app.js: after the helpers block');
  assert.ok(mob.indexOf('// ── voice helpers (end) ──') < mob.indexOf(BEGIN), 'mobile.js: after the helpers block');
});

test('the block runs nothing at load time and has no require or stray names', () => {
  const lib = callBlock(read('lib/ui-voice-call.js'), '');
  assert.ok(!/\brequire\(/.test(lib));
  for (const m of lib.matchAll(/^(?:async )?(?:function|const|let|var|class) ([A-Za-z0-9_$]+)/gm)) assert.ok(/^(voice|VOICE_)/.test(m[1]), 'top-level name ' + m[1]);
  const lines = lib.split('\n').filter(l => /^\S/.test(l) && !/^(function|async function|const|\}|\/\/)/.test(l));
  assert.deepStrictEqual(lines, [], 'only declarations at top level');
});

test('voiceDecisionWord', () => {
  for (const s of ['now', 'Go ahead.', 'do it now', 'yes', 'Yeah!', 'sure']) assert.strictEqual(voiceDecisionWord(s), 'now', s);
  for (const s of ['later', 'after we are done', 'not now', 'Wait', 'after we\'re done']) assert.strictEqual(voiceDecisionWord(s), 'later', s);
  for (const s of ['skip', 'no', 'No.', 'decline', 'cancel it']) assert.strictEqual(voiceDecisionWord(s), 'skip', s);
  for (const s of ['', 'what time is it', 'tell me about the weather today in a lot of detail', null]) assert.strictEqual(voiceDecisionWord(s), null, String(s));
  assert.strictEqual(voiceDecisionWord('now'), 'now');
  assert.strictEqual(voiceDecisionWord('know'), null);
});

test('voiceMatchChoice', () => {
  const opts = ['Red', 'Green apple', 'Blue'];
  assert.strictEqual(voiceMatchChoice('red', opts), 'Red');
  assert.strictEqual(voiceMatchChoice('  GREEN  APPLE!! ', opts), 'Green apple');
  assert.strictEqual(voiceMatchChoice('I think the blue one', opts), 'Blue');
  assert.strictEqual(voiceMatchChoice('the green apple please', opts), 'Green apple');
  assert.strictEqual(voiceMatchChoice('green', opts), 'Green apple', 'first word');
  assert.strictEqual(voiceMatchChoice('the second', opts), 'Green apple');
  assert.strictEqual(voiceMatchChoice('number three', opts), 'Blue');
  assert.strictEqual(voiceMatchChoice('first one', opts), 'Red');
  assert.strictEqual(voiceMatchChoice('fourth', opts), null, 'ordinal beyond the list');
  assert.strictEqual(voiceMatchChoice('purple', opts), null);
  assert.strictEqual(voiceMatchChoice('', opts), null);
  assert.strictEqual(voiceMatchChoice('red', []), null);
  assert.strictEqual(voiceMatchChoice('b', [{ label: 'A' }, { label: 'B' }]), 'B');
  assert.strictEqual(voiceMatchChoice('Yes, do it', ['Yes', 'No']), 'Yes');
  assert.strictEqual(voiceMatchChoice('no thanks', ['Yes', 'No']), 'No');
});

test('voiceStatusLine', () => {
  assert.strictEqual(voiceStatusLine({ tool: 'Bash' }), 'Running a command.');
  assert.strictEqual(voiceStatusLine({ name: 'run_shell' }), 'Running a command.');
  assert.strictEqual(voiceStatusLine({ tool: 'Read' }), 'Reading a file.');
  assert.strictEqual(voiceStatusLine({ tool: 'Grep' }), 'Reading a file.');
  assert.strictEqual(voiceStatusLine({ tool: 'WebSearch' }), 'Searching the web.');
  assert.strictEqual(voiceStatusLine({ tool: 'WebFetch' }), 'Searching the web.');
  assert.strictEqual(voiceStatusLine({ tool: 'consult_agent' }), 'Asking another agent.');
  assert.strictEqual(voiceStatusLine('bash'), 'Running a command.');
  assert.strictEqual(voiceStatusLine({ tool: 'Edit' }), 'Working on it.');
  assert.strictEqual(voiceStatusLine({}), 'Working on it.');
  assert.strictEqual(voiceStatusLine(null), 'Working on it.');
});

test('voiceRoomCheck', () => {
  const quietRoom = voiceRoomCheck([-30, -28, -32, -29], [-70, -72, -68], 50);
  assert.ok(quietRoom.micLevel > 50, 'quiet speech raises the mic level');
  const median = -29.5, deltaDb = -20 - median;
  assert.ok(Math.abs(voiceGainFromSlider(quietRoom.micLevel) - Math.pow(10, deltaDb / 20)) < 0.2 * Math.pow(10, deltaDb / 20), 'lands near -20 dBFS');
  const loud = voiceRoomCheck([-20, -21, -19], [-70], 50);
  assert.ok(Math.abs(loud.micLevel - 50) <= 2, 'already at -20: unchanged');
  assert.strictEqual(voiceRoomCheck([-5, -6], [-70], 50).micLevel < 50, true, 'very loud speech lowers it');
  const noisy = voiceRoomCheck([-25, -26, -24], [-32, -33, -31], 50);
  assert.ok(noisy.interruptSensitivity < quietRoom.interruptSensitivity, 'a small gap lowers the sensitivity');
  assert.ok(noisy.interruptSensitivity >= 10 && quietRoom.interruptSensitivity <= 90);
  assert.deepStrictEqual(voiceRoomCheck([], [-60], 40), { micLevel: 40, interruptSensitivity: 50 }, 'no speech: keep the level');
  const maxed = voiceRoomCheck([-90, -95], [-99], 90);
  assert.ok(maxed.micLevel <= 100 && maxed.micLevel >= 0);
  assert.ok(voiceRoomCheck([-30], [], 50).interruptSensitivity > 50, 'no noise measured counts as a quiet room');
});

test('voiceVadThresholds', () => {
  const idle = voiceVadThresholds(50, false);
  assert.deepStrictEqual(idle, { positiveSpeechThreshold: 0.5, negativeSpeechThreshold: 0.35, minSpeechFrames: 3 });
  assert.deepStrictEqual(voiceVadThresholds(0, false), idle, 'idle does not depend on the slider');
  const p0 = voiceVadThresholds(0, true), p50 = voiceVadThresholds(50, true), p100 = voiceVadThresholds(100, true);
  assert.ok(p0.positiveSpeechThreshold > p50.positiveSpeechThreshold && p50.positiveSpeechThreshold > p100.positiveSpeechThreshold, 'more sensitive = lower threshold');
  assert.ok(p0.minSpeechFrames > p100.minSpeechFrames);
  for (const p of [p0, p50, p100]) {
    assert.ok(p.positiveSpeechThreshold >= idle.positiveSpeechThreshold, 'playing is at least as conservative as idle');
    assert.ok(p.negativeSpeechThreshold < p.positiveSpeechThreshold && p.minSpeechFrames >= idle.minSpeechFrames);
  }
  assert.deepStrictEqual(voiceVadThresholds('x', true), p50, 'garbage = default 50');
  assert.deepStrictEqual(voiceVadThresholds(500, true), p100);
});

test('voiceReplySentences and voiceJoinOr', () => {
  assert.deepStrictEqual(voiceReplySentences('One. Two. Thr', false).sentences, ['One.', 'Two.']);
  assert.deepStrictEqual(voiceReplySentences('One. Two. Thr', true).sentences, ['One.', 'Two.', 'Thr']);
  assert.deepStrictEqual(voiceReplySentences('One. Two. ', false).sentences, ['One.', 'Two.'], 'a finished last sentence counts');
  assert.deepStrictEqual(voiceReplySentences('Pi is 3.', false).sentences, [], 'a number being typed is not a sentence');
  const code = voiceReplySentences('Here is code.\n```js\nlet a\n', false);
  assert.deepStrictEqual(code.sentences, ['Here is code.'], 'the open code block is not read, the note waits for the end');
  assert.strictEqual(code.note, 'I have put the details in the chat.');
  const done = voiceReplySentences('Here is code.\n```js\nlet a\n```\nAll set.', true);
  assert.deepStrictEqual(done.sentences, ['Here is code.', 'All set.']);
  assert.strictEqual(done.note, 'I have put the details in the chat.');
  assert.deepStrictEqual(voiceReplySentences('', true), { sentences: [], note: '' });
  assert.strictEqual(voiceJoinOr(['A']), 'A');
  assert.strictEqual(voiceJoinOr(['A', 'B']), 'A or B');
  assert.strictEqual(voiceJoinOr(['A', 'B', 'C']), 'A, B or C');
  assert.strictEqual(voiceJoinOr([]), '');
});

// ---- the controller ----

test('start: states, server start, heartbeat every 15 s, failures', async () => {
  const h = harness();
  const p = h.call.start();
  assert.strictEqual(h.last(), 'starting');
  assert.strictEqual(await p, true);
  assert.deepStrictEqual(h.log, ['server.start announce']);
  assert.strictEqual(h.last(), 'listening');
  await h.advance(14999); assert.strictEqual(h.hb, 0);
  await h.advance(1); assert.strictEqual(h.hb, 1);
  await h.advance(30000); assert.strictEqual(h.hb, 3);
  await h.call.hangUp();
  await h.advance(60000); assert.strictEqual(h.hb, 3, 'no heartbeat after hang-up');

  const bad = harness({ vad: { start: async () => { throw new Error('denied'); }, stop() {}, setPlaybackActive() {} } });
  assert.strictEqual(await bad.call.start(), false);
  assert.ok(/microphone: denied/.test(bad.toasts[0]));
  assert.strictEqual(bad.last(), 'ended');
  const badServer = harness(); badServer.deps.server.start = async () => { throw new Error('no hub'); };
  const c2 = voiceCreateCall(badServer.deps);
  assert.strictEqual(await c2.start(), false);
  assert.ok(/start the call: no hub/.test(badServer.toasts[0]));
});

test('states: listening -> hearing -> thinking -> speaking -> listening', async () => {
  const h = await started();
  h.vadHandlers.onSpeechStart();
  assert.strictEqual(h.last(), 'hearing');
  h.vadHandlers.onSpeechEnd({ text: 'what is the weather' });
  await tick();
  assert.deepStrictEqual(h.sent, ['what is the weather']);
  assert.strictEqual(h.last(), 'thinking');
  h.call.onReplyText('It is sunny. ', false);
  assert.strictEqual(h.last(), 'speaking');
  assert.deepStrictEqual(h.playing, [true]);
  await h.finish();
  assert.strictEqual(h.last(), 'thinking', 'reply not finished: back to waiting');
  assert.deepStrictEqual(h.playing, [true, false]);
  h.call.onReplyText('It is sunny. Take a coat.', true);
  assert.deepStrictEqual(h.spoken, ['It is sunny.', 'Take a coat.']);
  await h.finish();
  assert.strictEqual(h.last(), 'listening');
  assert.deepStrictEqual(h.heard, ['what is the weather']);
});

test('routing: stop command cancels speech, stops the turn and says Stopped', async () => {
  const h = await started();
  await h.say('tell me a story'); h.call.onReplyText('Once upon a time. And so on. ', false);
  assert.strictEqual(h.last(), 'speaking');
  await h.say('Stop.');
  assert.ok(h.log.indexOf('cancelSpeech') >= 0 && h.log.includes('stop'));
  assert.strictEqual(h.stops, 1);
  assert.strictEqual(h.spoken[h.spoken.length - 1], 'Stopped.');
  assert.deepStrictEqual(h.sent, ['tell me a story'], 'stop is not sent as a message');
  h.call.onReplyText('Once upon a time. And so on. More.', true);
  assert.strictEqual(h.spoken.filter(s => s !== 'Stopped.' && s !== 'Once upon a time.').length, 0, 'a stopped reply is not read on');
  await h.finish();
  assert.strictEqual(h.last(), 'listening');
});

test('routing: ignores empty, short and filler transcripts', async () => {
  const h = await started();
  for (const t of ['', ' ', 'a', 'uh', 'Um...', 'uh um', 'hmm']) await h.say(t);
  assert.deepStrictEqual(h.sent, []); assert.deepStrictEqual(h.heard, []);
  await h.say('ok');
  assert.deepStrictEqual(h.sent, ['ok'], 'two characters is enough');
  assert.strictEqual(h.last(), 'thinking');
});

test('routing: a turn running gets an interjection, otherwise a new message', async () => {
  const h = await started();
  await h.say('first thing');
  assert.deepStrictEqual(h.sent, ['first thing']);
  assert.strictEqual(h.running, true);
  await h.say('actually make it blue');
  assert.deepStrictEqual(h.interjected, ['actually make it blue']);
  assert.deepStrictEqual(h.sent, ['first thing']);
  h.running = false;
  await h.say('and one more');
  assert.deepStrictEqual(h.sent, ['first thing', 'and one more']);
});

test('routing: a failing send toasts and returns to listening', async () => {
  const h = await started({ send: async () => { throw new Error('x'); } });
  await h.say('hello there');
  assert.ok(h.toasts.some(m => /Could not send/.test(m)));
  assert.strictEqual(h.spoken[0], 'That did not go through.', 'P-i: the person is told');
  await h.finish();
  assert.strictEqual(h.last(), 'listening');
  const s = await started({ stt: async () => { throw new Error('stt down'); } });
  await s.say('hello');
  assert.ok(s.toasts.some(m => /transcribe/.test(m)));
  assert.strictEqual(s.last(), 'listening');
});

test('routing order: stop beats a pending announcement and a pending ask', async () => {
  const h = await started();
  h.call.onAsk({ request_id: 'r1', question: 'Which one?', options: ['Cancel it', 'Keep'] });
  await h.finish();
  await h.say('cancel');
  assert.strictEqual(h.stops, 1);
  assert.deepStrictEqual(h.asks, [], 'cancel is the stop command, not an answer');
});

test('barge-in: speech start while speaking cuts the audio before transcription', async () => {
  const h = await started();
  await h.say('read it');
  h.call.onReplyText('Sentence one. Sentence two. Sentence three. ', false);
  assert.strictEqual(h.last(), 'speaking');
  const before = h.log.length;
  h.vadHandlers.onSpeechStart();
  assert.deepStrictEqual(h.log.slice(before), ['cancelSpeech'], 'cut at once, no stt yet');
  assert.strictEqual(h.last(), 'hearing');
  assert.deepStrictEqual(h.playing, [true, false], 'VAD back to the normal threshold');
  await tick();
  assert.deepStrictEqual(h.spoken, ['Sentence one.'], 'the queued sentences were dropped');
  h.vadHandlers.onSpeechEnd({ text: 'no make it shorter' });
  await tick();
  assert.deepStrictEqual(h.interjected, ['no make it shorter'], 'a spoken correction becomes an interjection');
  h.call.onReplyText('Sentence one. Sentence two. Sentence three. Sentence four. Sentence five.', true);
  await h.finish();
  assert.deepStrictEqual(h.spoken, ['Sentence one.', 'Sentence four.', 'Sentence five.'], 'only text after the cut is read');
});

test('barge-in: the VAD is told when playback starts and stops', async () => {
  const h = await started();
  h.call.onAsk({ request_id: 'r', question: 'Sure?', options: [] });
  assert.deepStrictEqual(h.playing, [true]);
  await h.finish();
  assert.deepStrictEqual(h.playing, [true, false]);
});

test('reply reading: sentences as they arrive, code and tables skipped, note once', async () => {
  const h = await started();
  await h.say('show me');
  h.call.onReplyText('Here is the plan', false);
  assert.deepStrictEqual(h.spoken, []);
  h.call.onReplyText('Here is the plan. Step one is easy. Step tw', false);
  assert.deepStrictEqual(h.spoken, ['Here is the plan.']);
  await h.finish();
  assert.deepStrictEqual(h.spoken, ['Here is the plan.', 'Step one is easy.']);
  await h.finish();
  h.call.onReplyText('Here is the plan. Step one is easy. Step two:\n```js\nrun();\n```\n| a | b |\n|--|--|\n| 1 | 2 |\nDone.', true);
  await h.finish();
  assert.deepStrictEqual(h.spoken.slice(2), ['Step two: Done.', 'I have put the details in the chat.']);
  await h.finish(); await h.finish();
  assert.strictEqual(h.last(), 'listening');
  assert.strictEqual(h.spoken.filter(s => /details/.test(s)).length, 1);
  assert.ok(!h.spoken.join(' ').includes('run();'));
});

test('reply reading: done with nothing left goes straight back to listening; a new reply restarts', async () => {
  const h = await started();
  await h.say('hi there');
  h.call.onReplyText('', true);
  assert.strictEqual(h.last(), 'listening');
  await h.say('again please');
  h.call.onReplyText('Fine.', true);
  assert.deepStrictEqual(h.spoken, ['Fine.']);
});

test('spoken status: one line per 10 s, never during speech or while the person talks', async () => {
  const h = await started();
  await h.say('do the thing');
  h.call.onActivity({ tool: 'Bash' });
  assert.deepStrictEqual(h.spoken, ['Running a command.']);
  assert.strictEqual(h.last(), 'speaking');
  h.call.onActivity({ tool: 'Read' });
  assert.deepStrictEqual(h.spoken, ['Running a command.'], 'not while speaking');
  await h.finish();
  assert.strictEqual(h.last(), 'thinking');
  await h.advance(9000);
  h.call.onActivity({ tool: 'Read' });
  assert.strictEqual(h.spoken.length, 1, 'rate limit');
  await h.advance(1000);
  h.vadHandlers.onSpeechStart();
  h.call.onActivity({ tool: 'Read' });
  assert.strictEqual(h.spoken.length, 1, 'not while the person speaks');
  h.vadHandlers.onSpeechEnd({ text: '' }); await tick();
  await h.advance(100);
  h.call.onActivity({ tool: 'WebSearch' });
  assert.deepStrictEqual(h.spoken, ['Running a command.', 'Searching the web.']);
  await h.finish();
  await h.advance(10000);
  h.call.onReplyText('Done.', true);
  h.call.onActivity({ tool: 'Bash' });
  assert.ok(!h.spoken.includes('Running a command.') || h.spoken.filter(s => s === 'Running a command.').length === 1, 'none after the turn');
});

test('spoken status: nothing when no turn runs', async () => {
  const h = await started();
  h.call.onActivity({ tool: 'Bash' });
  assert.deepStrictEqual(h.spoken, []);
});

test('ask_user: question and options are read, an option answers, free text when allowed', async () => {
  const h = await started();
  h.call.onAsk({ request_id: 'q1', question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }] });
  assert.deepStrictEqual(h.spoken, ['Which colour? Options: Red, Green or Blue.']);
  await h.finish();
  await h.say('the blue one');
  assert.deepStrictEqual(h.asks, [['q1', 'Blue']]);
  assert.deepStrictEqual(h.sent, [], 'the answer is not a new message');
  await h.say('and another thing');
  assert.deepStrictEqual(h.sent, ['and another thing'], 'ask is cleared after the answer');

  const f = await started();
  f.call.onAsk({ request_id: 'q2', question: 'What should I call it?', options: [] });
  assert.deepStrictEqual(f.spoken, ['What should I call it?']);
  await f.finish();
  await f.say('call it Project Sunrise');
  assert.deepStrictEqual(f.asks, [['q2', 'call it Project Sunrise']]);

  const g = await started();
  g.call.onAsk({ request_id: 'q3', question: 'Pick', options: ['A', 'B'], allow_free_text: true });
  await g.finish();
  await g.say('something else entirely');
  assert.deepStrictEqual(g.asks, [['q3', 'something else entirely']]);
});

test('ask_user: an unmatched answer is re-asked once, then left pending; onAskDone clears it', async () => {
  const h = await started();
  h.call.onAsk({ request_id: 'q', question: 'Which?', options: ['Alpha', 'Beta'] });
  await h.finish();
  await h.say('hmm purple');
  assert.deepStrictEqual(h.asks, []);
  assert.strictEqual(h.spoken[1], 'Please say one of: Alpha or Beta.');
  await h.finish();
  await h.say('still purple');
  assert.strictEqual(h.spoken.length, 3, 'asked only once');
  assert.strictEqual(h.spoken[2], 'Please tap one of the options on the screen.', 'P-l: an option-only question is not left silent');
  await h.finish();
  await h.say('purple again');
  assert.strictEqual(h.spoken.length, 3, 'the tap hint is said once');
  assert.deepStrictEqual(h.sent, [], 'never sent as a message while the question is open');
  await h.say('beta');
  assert.deepStrictEqual(h.asks, [['q', 'Beta']]);
  h.call.onAsk({ request_id: 'q9', question: 'Again?', options: ['X'] });
  await h.finish();
  h.call.onAskDone('q9');
  await h.say('lets go on');
  assert.deepStrictEqual(h.sent, ['lets go on']);
});

test('announcements: spoken at the next pause, 1.5 s after the person stopped', async () => {
  const h = await started();
  h.vadHandlers.onSpeechStart();
  h.call.onHeld({ id: 'c1', kind: 'consultation', label: 'Maria asks for the report', from: 'maria' }, false);
  assert.deepStrictEqual(h.spoken, [], 'not while the person speaks');
  assert.strictEqual(h.call.held.length, 1);
  assert.strictEqual(h.helds[h.helds.length - 1][0].id, 'c1');
  h.vadHandlers.onSpeechEnd({ text: '' }); await tick();
  await h.advance(1400); assert.deepStrictEqual(h.spoken, []);
  await h.advance(100);
  assert.deepStrictEqual(h.spoken, ['Maria asks for the report. Now, or after we\'re done?']);
  assert.strictEqual(h.last(), 'speaking');
});

test('announcements: spoken at once when the person has been quiet; not while a reply is read or a turn runs', async () => {
  const h = await started();
  await h.say('work on it'); await h.advance(2000);
  h.call.onHeld({ id: 'j1', kind: 'job_notice', label: 'Nightly job finished' }, false);
  assert.deepStrictEqual(h.spoken, [], 'a turn is running (thinking)');
  h.call.onReplyText('Done.', true);
  assert.deepStrictEqual(h.spoken, ['Done.']);
  await h.finish();
  assert.deepStrictEqual(h.spoken, ['Done.', 'Nightly job finished. Now, or after we\'re done?']);
});

test('announcements: a spoken answer decides now, later, skip', async () => {
  for (const [said, choice] of [['go ahead', 'now'], ['not now', 'later'], ['skip it', 'skip'], ['yes', 'now'], ['after', 'later']]) {
    const h = await started();
    h.call.onHeld({ id: 'x1', kind: 'schedule', label: 'Weekly summary' }, false);
    await h.finish();
    await h.say(said);
    assert.deepStrictEqual(h.decisions, [['x1', choice]], said);
    assert.deepStrictEqual(h.sent, [], 'the answer is not sent to the agent');
    assert.strictEqual(h.call.held.some(x => x.id === 'x1'), choice === 'later', 'later stays on screen, now/skip leave');
  }
});

test('announcements: no answer within 20 s means later; the next one follows', async () => {
  const h = await started();
  h.call.onHeld({ id: 'a', kind: 'task', label: 'First' }, false);
  h.call.onHeld({ id: 'b', kind: 'task', label: 'Second' }, false);
  assert.deepStrictEqual(h.spoken, ['First. Now, or after we\'re done?']);
  await h.finish();
  await h.advance(19900); assert.deepStrictEqual(h.decisions, []);
  await h.advance(200);
  assert.deepStrictEqual(h.decisions, [['a', 'later']]);
  await h.advance(1600);
  assert.deepStrictEqual(h.spoken[1], 'Second. Now, or after we\'re done?');
  assert.ok(h.call.held.find(x => x.id === 'a').later, 'a later item is kept, not asked again');
});

test('announcements: an utterance that is not a decision counts as no answer (later) and is handled normally', async () => {
  const h = await started();
  h.call.onHeld({ id: 'a', kind: 'task', label: 'Thing' }, false);
  await h.finish();
  await h.say('what is the time');
  assert.deepStrictEqual(h.decisions, [['a', 'later']]);
  assert.deepStrictEqual(h.sent, ['what is the time']);
});

test('announcements: barge-in during the announcement still starts the 20 s answer window', async () => {
  const h = await started();
  h.call.onHeld({ id: 'a', kind: 'task', label: 'Thing' }, false);
  h.vadHandlers.onSpeechStart();
  h.vadHandlers.onSpeechEnd({ text: 'now' }); await tick();
  assert.deepStrictEqual(h.decisions, [['a', 'now']]);
});

test('announcements: dnd holds quietly (ui.held only); switching back announces', async () => {
  const h = await started();
  h.call.setMode('dnd');
  assert.ok(h.log.includes('server.mode dnd'));
  h.call.onHeld({ id: 'q', kind: 'job_report', label: 'Report ready' }, true);
  h.call.onHeld({ id: 'q2', kind: 'job_report', label: 'Other report' }, false);
  await h.advance(5000);
  assert.deepStrictEqual(h.spoken, []);
  assert.strictEqual(h.call.held.length, 2);
  assert.ok(h.helds.length >= 2);
  h.call.setMode('announce');
  assert.deepStrictEqual(h.spoken, ['Report ready. Now, or after we\'re done?']);
  const q = await started();
  q.call.onHeld({ id: 'z', kind: 'task', label: 'Quiet one' }, true);
  await q.advance(5000);
  assert.deepStrictEqual(q.spoken, [], 'quiet flag from the server: screen only');
  assert.strictEqual(q.call.held.length, 1);
});

test('announcements: buttons decide the same way; duplicates are ignored; onHeldDone removes', async () => {
  const h = await started();
  h.call.onHeld({ id: 'b1', kind: 'consult_reply', label: 'Reply from Sam' }, false);
  h.call.onHeld({ id: 'b1', kind: 'consult_reply', label: 'Reply from Sam' }, false);
  assert.strictEqual(h.call.held.length, 1);
  await h.finish();
  h.call.decide('b1', 'skip');
  assert.deepStrictEqual(h.decisions, [['b1', 'skip']]);
  assert.strictEqual(h.call.held.length, 0);
  await h.advance(25000);
  assert.deepStrictEqual(h.decisions, [['b1', 'skip']], 'the answer window is gone');
  h.call.decide('nope', 'now'); h.call.decide('b1', 'maybe');
  assert.strictEqual(h.decisions.length, 1);
  h.call.onHeld({ id: 'b2', kind: 'task', label: 'T' }, true);
  h.call.onHeldDone('b2');
  assert.strictEqual(h.call.held.length, 0);
  const l = await started();
  l.call.onHeld({ id: 'b3', kind: 'task', label: 'T' }, true);
  l.call.decide('b3', 'later');
  assert.strictEqual(l.call.held.length, 1, 'later stays listed');
  assert.deepStrictEqual(l.decisions, [['b3', 'later']]);
});

test('hang-up: stops the vad and speech, ends the call, summarises what came in', async () => {
  const h = await started({});
  h.endHeld = [{ id: 'a', label: 'Weekly summary' }, { id: 'b', label: 'Nightly job.' }];
  await h.say('x1'); h.call.onReplyText('Reading. More here. ', false);
  const p = h.call.hangUp();
  assert.strictEqual(h.last(), 'ended');
  assert.ok(h.log.includes('vad.stop') && h.log.includes('cancelSpeech'));
  const held = await p;
  assert.strictEqual(held.length, 2);
  const text = 'While we talked: 2 things came in: Weekly summary, Nightly job. They run now.';
  assert.deepStrictEqual(h.summaries, [text]);
  assert.strictEqual(h.spoken[h.spoken.length - 1], text);
  assert.strictEqual(await h.call.hangUp(), held, 'idempotent');
  assert.strictEqual(h.summaries.length, 1);
});

test('hang-up: nothing came in means no summary; one item reads naturally; a failing end is survived', async () => {
  const h = await started();
  assert.deepStrictEqual(await h.call.hangUp(), []);
  assert.deepStrictEqual(h.summaries, []); assert.deepStrictEqual(h.spoken, []);
  const one = await started(); one.endHeld = [{ id: 'a', label: 'Backup' }];
  await one.call.hangUp();
  assert.deepStrictEqual(one.summaries, ['While we talked: 1 thing came in: Backup. It runs now.']);
  const bad = await started(); bad.deps.server.end = async () => { throw new Error('gone'); };
  assert.deepStrictEqual(await bad.call.hangUp(), []);
});

test('after hang-up nothing is processed or spoken', async () => {
  const h = await started();
  await h.call.hangUp();
  h.call.onReplyText('Late text. ', true); h.call.onActivity({ tool: 'Bash' }); h.call.onAsk({ request_id: 'q', question: 'Hi?' }); h.call.onHeld({ id: 'z', label: 'L' }, false);
  h.call.onSpeechStart(); await h.call.onSpeechEnd({ text: 'hello there' });
  assert.deepStrictEqual(h.spoken, []); assert.deepStrictEqual(h.sent, []);
  assert.strictEqual(h.last(), 'ended');
});

test('hang-up during start: the call never comes up and the microphone is let go', async () => {
  const h = harness();
  let release; h.deps.server.start = () => new Promise(r => { release = r; });
  const c = voiceCreateCall(h.deps);
  const p = c.start();
  // the microphone is asked for first, inside the tap that started the call (iOS), before the server answers
  assert.ok(h.vadHandlers, 'the microphone starts before the server is told');
  const hu = c.hangUp();
  release(); await hu;
  assert.strictEqual(await p, false);
  assert.ok(h.log.filter(x => x === 'vad.stop').length >= 1, 'the microphone is stopped');
  assert.strictEqual(c.state, 'ended');
});

test('a microphone that comes up after a hang-up is stopped at once', async () => {
  const h = harness();
  let micUp; h.deps.vad.start = (hd) => new Promise(r => { micUp = () => { h.vadHandlers = hd; r(); }; });
  const c = voiceCreateCall(h.deps);
  const p = c.start();
  await tick();
  c.hangUp();
  const stopsBefore = h.log.filter(x => x === 'vad.stop').length;
  micUp();
  assert.strictEqual(await p, false);
  assert.ok(h.log.filter(x => x === 'vad.stop').length > stopsBefore, 'stopped again after it came up');
});

// ---- the VAD adapter ----

function fakeBrowser() {
  const b = { created: [], gains: [], tracksStopped: 0, closed: 0, destroyed: 0, scripts: [], rawOpts: null, connects: [] };
  class Gain { constructor() { this.gain = { value: -1 }; b.gains.push(this); } connect(x) { b.connects.push(['gain', x.kind]); } }
  class Ctx {
    constructor() { this.state = 'suspended'; } async resume() { this.state = 'running'; } async close() { b.closed++; }
    createMediaStreamSource(s) { return { connect: (g) => b.connects.push(['src', s.id]) }; }
    createGain() { return new Gain(); }
    createMediaStreamDestination() { return { kind: 'dest', stream: { id: 'dest-stream' } }; }
  }
  const raw = { id: 'raw-stream', getTracks: () => [{ stop: () => { b.tracksStopped++; } }] };
  class MicVAD {
    static async new(options) { const v = new MicVAD(); v.options = options; v.setOptionsCalls = []; b.created.push(v); return v; }
    async start() { this.started = true; } async destroy() { b.destroyed++; }
    setOptions(u) { this.setOptionsCalls.push(u); }
  }
  const win = { AudioContext: Ctx, vad: undefined, navigator: { mediaDevices: { getUserMedia: async (o) => { b.rawOpts = o; return raw; } } } };
  const loadScript = async (src) => { b.scripts.push(src); win.vad = { MicVAD }; };
  return { b, win, loadScript };
}

test('vad adapter: loads the bundle from /api/voice/web/ and builds MicVAD with the gain stream', async () => {
  const { b, win, loadScript } = fakeBrowser();
  const events = [];
  const vad = voiceCreateVad({ baseUrl: '/api/voice/web/', micLevel: 100, interruptSensitivity: 50, win, loadScript });
  await vad.start({ onSpeechStart: () => events.push('start'), onSpeechEnd: (a) => events.push('end ' + a.length), onFrame: (db) => events.push(['frame', Math.round(db)]), onMisfire: () => events.push('misfire') });
  assert.deepStrictEqual(b.scripts, ['/api/voice/web/ort.wasm.min.js', '/api/voice/web/bundle.min.js']);
  const m = b.created[0], o = m.options;
  assert.ok(m.started);
  assert.strictEqual(o.model, 'v5');
  assert.strictEqual(o.baseAssetPath, '/api/voice/web/'); assert.strictEqual(o.onnxWASMBasePath, '/api/voice/web/');
  assert.strictEqual(o.positiveSpeechThreshold, 0.5); assert.strictEqual(o.minSpeechMs, 96);
  const stream = await o.getStream();
  assert.strictEqual(stream.id, 'dest-stream', 'MicVAD hears the gain output, not the raw microphone');
  assert.deepStrictEqual(b.rawOpts, { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  assert.ok(Math.abs(b.gains[0].gain.value - voiceGainFromSlider(100)) < 1e-9, 'mic level 100 = +12 dB');
  assert.deepStrictEqual(b.connects.map(c => c[0]), ['src', 'gain']);
  assert.strictEqual(await o.resumeStream(stream), stream);
  await o.pauseStream(stream); assert.strictEqual(b.tracksStopped, 0, 'pausing keeps the microphone');
  const cfg = { env: { wasm: {} } }; o.ortConfig(cfg); assert.strictEqual(cfg.env.wasm.numThreads, 1);
  o.onSpeechStart(); assert.deepStrictEqual(events, [], 'the candidate start does not cut playback');
  o.onSpeechRealStart(); o.onSpeechEnd(new Float32Array(3)); o.onVADMisfire(); o.onFrameProcessed({ isSpeech: 0.1 }, new Float32Array([0.1, -0.1]));
  assert.deepStrictEqual(events, ['start', 'end 3', 'misfire', ['frame', -20]]);
  // live changes
  vad.setMicLevel(0); assert.ok(Math.abs(b.gains[0].gain.value - voiceGainFromSlider(0)) < 1e-9);
  vad.setPlaybackActive(true);
  assert.deepStrictEqual(m.setOptionsCalls[0], { positiveSpeechThreshold: 0.7, negativeSpeechThreshold: 0.55, minSpeechMs: 6 * 32 });
  vad.setInterruptSensitivity(100);
  assert.strictEqual(m.setOptionsCalls[1].positiveSpeechThreshold, 0.5);
  vad.setPlaybackActive(false);
  assert.deepStrictEqual(m.setOptionsCalls[2], { positiveSpeechThreshold: 0.5, negativeSpeechThreshold: 0.35, minSpeechMs: 96 });
  await vad.stop(); await vad.stop();
  assert.deepStrictEqual([b.destroyed, b.tracksStopped, b.closed], [1, 1, 1], 'stop releases everything once');
  vad.setMicLevel(50); vad.setPlaybackActive(true);   // harmless after stop
});

test('vad adapter: an already loaded bundle is not loaded again; a failing start cleans up', async () => {
  const { b, win, loadScript } = fakeBrowser();
  await loadScript('x'); b.scripts.length = 0;
  const vad = voiceCreateVad({ win, loadScript });
  await vad.start({});
  assert.deepStrictEqual(b.scripts, []);
  assert.strictEqual(b.created[0].options.baseAssetPath, '/api/voice/web/', 'default base');
  await vad.stop();
  const f = fakeBrowser(); f.win.navigator.mediaDevices.getUserMedia = async () => { throw new Error('NotAllowedError'); };
  const v2 = voiceCreateVad({ win: f.win, loadScript: f.loadScript });
  f.win.vad = undefined;
  await f.loadScript('x');
  f.b.created.length = 0;
  const MicVAD = f.win.vad.MicVAD; const orig = MicVAD.new;
  MicVAD.new = async (o) => { const x = await orig.call(MicVAD, o); await o.getStream(); return x; };
  await assert.rejects(() => v2.start({}), /NotAllowedError/);
  assert.strictEqual(f.b.closed, 1, 'the audio context is closed again');
});

test('the controller drives a real vad adapter: playback flips the threshold', async () => {
  const { b, win, loadScript } = fakeBrowser();
  const vad = voiceCreateVad({ micLevel: 50, interruptSensitivity: 50, win, loadScript });
  const h = await started({ vad });
  h.call.onAsk({ request_id: 'q', question: 'Hello?', options: [] });
  assert.strictEqual(b.created[0].setOptionsCalls.length, 1);
  assert.ok(b.created[0].setOptionsCalls[0].positiveSpeechThreshold > 0.5);
  await h.finish();
  assert.strictEqual(b.created[0].setOptionsCalls[1].positiveSpeechThreshold, 0.5);
  await h.call.hangUp();
  assert.strictEqual(b.destroyed, 1);
});

// ---- review round 1 fixes (P-a .. P-l) ----

test('P-a: the call id from start goes with heartbeat, mode, decide and end; the controller exposes it', async () => {
  const h = await started();
  assert.strictEqual(h.call.callId, 'call-1');
  h.call.setMode('dnd');
  h.call.onHeld({ id: 'j1', kind: 'job', label: 'Job' }, true);
  h.call.decide('j1', 'later');
  await h.advance(15000);
  await h.call.hangUp();
  assert.deepStrictEqual(h.modeIds, ['call-1']);
  assert.deepStrictEqual(h.decideIds, ['call-1']);
  assert.deepStrictEqual(h.hbIds, ['call-1']);
  assert.deepStrictEqual(h.endIds, ['call-1']);
});

test('P-a: hanging up while the server is still starting ends that call once its id is known', async () => {
  const h = harness();
  let answer; h.deps.server.start = () => new Promise((r) => { answer = r; });
  const c = voiceCreateCall(h.deps);
  const p = c.start();
  await tick();
  const hu = c.hangUp();
  await tick();
  assert.deepStrictEqual(h.endIds, [], 'nothing to end yet: the id is not known');
  answer({ callId: 'late-7', held: [] });
  await hu;
  assert.strictEqual(await p, false);
  assert.deepStrictEqual(h.endIds, ['late-7']);
});

test('P-b: onHeldDone later keeps the item as deferred (not announced again); now and skip remove it', async () => {
  const h = await started();
  h.call.onHeld({ id: 'j1', kind: 'job', label: 'Job one' }, false);
  await h.finish();
  h.call.onHeld({ id: 'j2', kind: 'job', label: 'Job two' }, true);
  h.call.onHeld({ id: 'j3', kind: 'job', label: 'Job three' }, true);
  h.call.onHeldDone('j1', 'later');
  h.call.onHeldDone('j2', 'now');
  h.call.onHeldDone('j3', 'skip');
  assert.deepStrictEqual(h.call.held.map(x => [x.id, x.later]), [['j1', true]]);
  assert.deepStrictEqual(h.helds[h.helds.length - 1].map(x => x.id), ['j1']);
  const n = h.spoken.length;
  h.call.setMode('dnd'); h.call.setMode('announce');
  await h.advance(5000);
  assert.strictEqual(h.spoken.length, n, 'a deferred item is not announced again');
});

test('P-c: a transcript only answers the announcement that was pending when its speech began', async () => {
  const h = await started();
  h.call.onHeld({ id: 'j1', kind: 'job', label: 'Job one' }, false);
  await h.finish();
  // the person starts talking while the announcement is pending: "yes" answers it
  h.vadHandlers.onSpeechStart(); h.vadHandlers.onSpeechEnd({ text: 'yes' }); await tick();
  assert.deepStrictEqual(h.decisions, [['j1', 'now']]);
  // a second item: nothing is pending when the person begins; the announcement waits for the end of the transcription
  h.call.onHeld({ id: 'j2', kind: 'job', label: 'Job two' }, true);
  h.call.setMode('dnd'); h.call.setMode('announce');
  const before = h.spoken.length;
  let resolveStt; h.deps.stt = () => new Promise((r) => { resolveStt = r; });
  h.vadHandlers.onSpeechStart();
  h.vadHandlers.onSpeechEnd({});
  await h.advance(3000);
  assert.strictEqual(h.spoken.length, before, 'no announcement starts while a transcription is pending');
  resolveStt('what is the time');
  await tick();
  assert.deepStrictEqual(h.decisions, [['j1', 'now']], 'those words did not decide the item');
  assert.deepStrictEqual(h.sent, ['what is the time']);
  h.call.onReplyText('Fine.', true);
  await h.finish();
  await h.advance(3000);
  assert.ok(h.spoken.some(x => /Job two/.test(x)), 'the announcement comes after the transcription and the reply');
});

test('P-d: a false start does not stop the call: the reply cut by it is read on, and nothing starts while the person speaks', async () => {
  const h = await started();
  await h.say('tell me');
  h.call.onReplyText('One here. Two here. Three here. ', false);
  assert.strictEqual(h.spoken[0], 'One here.');
  h.vadHandlers.onSpeechStart();
  assert.strictEqual(h.last(), 'hearing');
  h.call.onAsk({ request_id: 'q', question: 'Which?', options: [] });
  assert.strictEqual(h.spoken.length, 1, 'nothing is read while the person speaks');
  h.vadHandlers.onMisfire();
  assert.notStrictEqual(h.last(), 'hearing');
  for (let i = 0; i < 5; i++) await h.finish();
  assert.ok(h.spoken.includes('Which?'), 'the line that waited is read');
  assert.ok(h.spoken.filter(x => x === 'One here.').length === 2 && h.spoken.includes('Two here.') && h.spoken.includes('Three here.'), 'the cut reply is read on from the sentence that was cut');
});

test('P-d: lines that waited while the person spoke are read when the speech ends', async () => {
  const h = await started();
  h.vadHandlers.onSpeechStart();
  h.call.onAsk({ request_id: 'q', question: 'Which?', options: ['A', 'B'] });
  assert.deepStrictEqual(h.spoken, []);
  h.vadHandlers.onSpeechEnd({ text: '' }); await tick();
  assert.strictEqual(h.spoken[0], 'Which? Options: A or B.');
});

test('P-e: held items come from the start answer and from every heartbeat answer, merged by id', async () => {
  const h = harness();
  h.startHeld = [{ id: 'j1', kind: 'job', label: 'Job one', state: 'held' }, { id: 'j2', kind: 'job', label: 'Job two', state: 'later' }];
  assert.strictEqual(await h.call.start(), true);
  assert.deepStrictEqual(h.call.held.map(x => [x.id, x.later]), [['j1', false], ['j2', true]]);
  assert.deepStrictEqual(h.spoken, ['Job one. Now, or after we\'re done?'], 'a deferred item is not announced');
  await h.finish();
  h.hbHeld = [{ id: 'j1', kind: 'job', label: 'Job one', state: 'held' }, { id: 'j2', kind: 'job', label: 'Job two', state: 'held' }, { id: 'j3', kind: 'job', label: 'Job three', state: 'held' }];
  h.call.decide('j1', 'later');
  await h.advance(15000);
  assert.deepStrictEqual(h.call.held.map(x => [x.id, x.later]), [['j1', true], ['j2', true], ['j3', false]], 'known items keep their state');
  await h.advance(2000);
  assert.deepStrictEqual(h.spoken, ['Job one. Now, or after we\'re done?', 'Job three. Now, or after we\'re done?'], 'only the new item is announced');
  await h.finish();
  h.hbHeld = [{ id: 'j2', kind: 'job', label: 'Job two', state: 'done' }];
  await h.advance(15000);
  assert.ok(!h.call.held.some(x => x.id === 'j2'), 'an item that ran is dropped');
});

test('an item the person said now to is not brought back by a heartbeat while it runs (server state allowed)', async () => {
  const h = harness();
  h.startHeld = [{ id: 'c1', kind: 'consultation', label: 'Check the dates', state: 'held' }];
  assert.strictEqual(await h.call.start(), true);
  await h.finish();
  h.call.decide('c1', 'now');
  assert.ok(!h.call.held.some(x => x.id === 'c1'), 'removed at once');
  const spokenBefore = h.spoken.length;
  h.hbHeld = [{ id: 'c1', kind: 'consultation', label: 'Check the dates', state: 'allowed' }];
  await h.advance(15000);
  await h.advance(2000);
  assert.ok(!h.call.held.some(x => x.id === 'c1'), 'not re-added while it runs');
  assert.strictEqual(h.spoken.length, spokenBefore, 'not announced again');
});

test('an item decided elsewhere while it is being asked ends that question, and the next item is still announced', async () => {
  const h = harness();
  h.startHeld = [{ id: 'a', kind: 'consultation', label: 'Item A', state: 'held' }];
  assert.strictEqual(await h.call.start(), true);
  assert.deepStrictEqual(h.spoken, ['Item A. Now, or after we\'re done?']);
  await h.finish();
  // an admin (or another device) said now to A; this page missed the event
  h.hbHeld = [{ id: 'a', kind: 'consultation', label: 'Item A', state: 'allowed' }, { id: 'b', kind: 'consultation', label: 'Item B', state: 'held' }];
  await h.advance(15000);
  await h.advance(25000);
  await h.finish();
  assert.ok(h.spoken.includes('Item B. Now, or after we\'re done?'), 'B is announced: the question about A did not block it');
});

test('an answer that began before an announcement is not taken as its answer (candidate speech onset)', async () => {
  const h = harness();
  assert.strictEqual(await h.call.start(), true);
  h.vadHandlers.onSpeechBegin();   // first speech-like frame: the person starts to say something
  h.call.onHeld({ id: 'x', kind: 'schedule', label: 'Daily review' }, false);
  await h.advance(3000);
  assert.ok(!h.spoken.some(s => s.startsWith('Daily review')), 'nothing is announced over a person who started to speak');
  h.vadHandlers.onSpeechStart();
  h.vadHandlers.onSpeechEnd({ text: 'yes' });
  await tick();
  assert.deepStrictEqual(h.decisions, [], 'the earlier "yes" is not a decision about the item');
});

test('a call whose start failed never sends an end without a call id', async () => {
  const h = harness();
  const ends = [];
  h.deps.server.start = async () => { throw new Error('offline'); };
  h.deps.server.end = async (id) => { ends.push(id); return { held: [] }; };
  const c = voiceCreateCall(h.deps);
  assert.strictEqual(await c.start(), false);
  await c.hangUp();
  assert.deepStrictEqual(ends, [], 'no end(undefined): it would end another call of the same person');
});

test('P-g: any failure while the VAD starts lets go of the context and the stream', async () => {
  let f = fakeBrowser();
  f.loadScript = async () => { throw new Error('script 404'); };
  let v = voiceCreateVad({ win: f.win, loadScript: f.loadScript });
  await assert.rejects(() => v.start({}), /script 404/);
  assert.strictEqual(f.b.closed, 1, 'script load failure closes the context');
  f = fakeBrowser();
  f.win.AudioContext = class { resume() { return Promise.reject(new Error('resume refused')); } close() { f.b.closed++; return Promise.resolve(); } };
  f.win.vad = { MicVAD: class { static async new() { return {}; } } };
  v = voiceCreateVad({ win: f.win, loadScript: f.loadScript });
  await assert.rejects(() => v.start({}), /resume refused/);
  assert.strictEqual(f.b.closed, 1, 'resume failure closes the context');
  f = fakeBrowser();
  v = voiceCreateVad({ win: f.win, loadScript: f.loadScript });
  await f.loadScript('x');
  f.win.vad.MicVAD.new = async (o) => { await o.getStream(); throw new Error('model failed'); };
  await assert.rejects(() => v.start({}), /model failed/);
  assert.deepStrictEqual([f.b.closed, f.b.tracksStopped], [1, 1], 'MicVAD failure closes the context and stops the microphone');
});

test('P-h: the hang-up summary tells what already ran from what runs now', async () => {
  const h = await started();
  h.endHeld = [{ id: 'a', label: 'Backup', state: 'done' }, { id: 'b', label: 'Report', state: 'held' }, { id: 'c', label: 'Mail', state: 'later' }];
  await h.call.hangUp();
  assert.deepStrictEqual(h.summaries, ['While we talked: 3 things came in: Backup, Report, Mail. Already ran: Backup. Running now: Report, Mail.']);
  const d = await started();
  d.endHeld = [{ id: 'a', label: 'Backup', state: 'done' }];
  await d.call.hangUp();
  assert.deepStrictEqual(d.summaries, ['While we talked: 1 thing came in: Backup. It already ran.']);
});
