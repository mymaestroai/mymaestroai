'use strict';
// voiceCreateCall with deps.recorder (a fake recorder): what is begun, dropped, ended and saved; standby speech is never recorded;
// hang-up stops the recorder; without deps.recorder the controller makes no recorder calls.
const { test } = require('node:test');
const assert = require('node:assert');
Object.assign(globalThis, require('../lib/ui-voice'), require('../lib/ui-voice-thinking'));
const { voiceCreateCall } = require('../lib/ui-voice-call');

const tick = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function harness({ withRecorder = true, wake = null, over } = {}) {
  const h = { t: 0, timers: [], nextId: 1, sent: [], log: [], transcripts: [], replies: [], handlers: null, running: false, stt: {} };
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
  let seqN = 0;
  h.recorder = { begin: () => h.log.push('begin'), drop: () => h.log.push('drop'), end: () => { h.log.push('end'); return { seq: Promise.resolve(++seqN) }; }, stop: () => h.log.push('stop') };
  h.deps = {
    agent: 'biographer', now: () => h.t, setTimer: h.setTimer, clearTimer: h.clearTimer, prefs: () => ({ continueWait: 0, thinkingSound: false }),
    vad: { start: async (hd) => { h.handlers = hd; }, stop() {}, setPlaybackActive() {} },
    stt: async (audio) => audio.text, isTurnRunning: () => h.running,
    send: async (t) => { h.sent.push(t); h.running = true; }, interject: async () => {}, stop() {},
    speak: async () => true, cancelSpeech() {}, answerAsk() {},
    server: { start: async () => ({ callId: 'c1', held: [] }), heartbeat: async () => ({ held: [] }), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} },
    ui: { state() {}, heard() {}, held() {}, toast() {}, summary() {}, level() {}, activity() {} },
  };
  if (withRecorder) Object.assign(h.deps, { recorder: h.recorder, recordTranscript: (seq, text) => h.transcripts.push([seq, text]), recordReplyText: (text) => h.replies.push(text) });
  if (wake) h.deps.wake = () => wake;
  Object.assign(h.deps, over || {});
  h.call = voiceCreateCall(h.deps);
  h.say = async (text) => { h.handlers.onSpeechBegin(); h.handlers.onSpeechStart(); h.handlers.onSpeechEnd({ text }); await tick(); };
  return h;
}

test('begin, end and the transcript are wired: begin at speech begin, end at speech end, the text saved with the handle\'s seq', async () => {
  const h = harness();
  assert.strictEqual(await h.call.start(), true);
  h.handlers.onSpeechBegin();
  assert.deepStrictEqual(h.log, ['begin']);
  h.handlers.onSpeechStart();
  assert.deepStrictEqual(h.log, ['begin'], 'onSpeechStart after a begin does not begin again');
  h.handlers.onSpeechEnd({ text: 'I grew up by the sea.' }); await tick();
  assert.deepStrictEqual(h.log, ['begin', 'end']);
  assert.strictEqual(h.transcripts.length, 1);
  assert.strictEqual(await h.transcripts[0][0], 1, 'the page gets the handle\'s seq promise');
  assert.strictEqual(h.transcripts[0][1], 'I grew up by the sea.');
  assert.deepStrictEqual(h.sent, ['I grew up by the sea.']);
});

test('onSpeechStart alone (no begin came) begins the recording', async () => {
  const h = harness();
  await h.call.start();
  h.handlers.onSpeechStart(); h.handlers.onSpeechEnd({ text: 'hello there' }); await tick();
  assert.deepStrictEqual(h.log, ['begin', 'end']);
});

test('a filler that is not sent is still saved: it is the person\'s speech', async () => {
  const h = harness();
  await h.call.start();
  await h.say('um');
  assert.deepStrictEqual(h.sent, [], 'a filler is not sent');
  assert.deepStrictEqual(h.log, ['begin', 'end']);
  assert.strictEqual(h.transcripts[0][1], 'um');
});

test('a misfire drops; the 4 s false-start timer drops', async () => {
  const h = harness();
  await h.call.start();
  h.handlers.onSpeechBegin(); h.handlers.onMisfire();
  assert.deepStrictEqual(h.log, ['begin', 'drop']);
  h.log.length = 0;
  h.handlers.onSpeechBegin();
  await h.advance(4100);
  assert.deepStrictEqual(h.log, ['begin', 'drop'], 'no real start came: let go');
  h.log.length = 0;
  await h.say('and then it works');
  assert.deepStrictEqual(h.log, ['begin', 'end'], 'a new speech after a drop begins again');
  assert.deepStrictEqual(h.transcripts.map(t => t[1]), ['and then it works']);
});

test('standby speech is never begun (the decision is made at speech begin); speech after the wake phrase is', async () => {
  const w = { phrase: 'hey helper', quietMs: 20000, local: true };
  const h = harness({ wake: w });
  assert.strictEqual(await h.call.start(), true);
  assert.strictEqual(h.call.isStandby(), true);
  await h.say('something said in standby');
  assert.deepStrictEqual(h.log, [], 'no begin, no end, no drop');
  assert.deepStrictEqual(h.transcripts, []);
  await h.say('hey helper');   // the phrase alone wakes the call
  assert.deepStrictEqual(h.log, [], 'the phrase itself was said in standby: not recorded');
  assert.strictEqual(h.call.isStandby(), false);
  await h.say('now this is recorded');
  assert.deepStrictEqual(h.log, ['begin', 'end']);
  assert.deepStrictEqual(h.transcripts.map(t => t[1]), ['now this is recorded']);
  // a misfire in standby drops nothing
  h.log.length = 0;
  await h.call.hangUp();
});

test('a speech begun in standby is not recorded even when the phrase in it wakes the call and the rest is sent', async () => {
  const w = { phrase: 'hey helper', quietMs: 20000, local: true };
  const h = harness({ wake: w });
  await h.call.start();
  h.handlers.onSpeechBegin();   // begun in standby
  h.handlers.onSpeechEnd({ text: 'hey helper tell me more' }); await tick();
  assert.deepStrictEqual(h.log, [], 'the decision was made at begin');
  assert.deepStrictEqual(h.sent, ['tell me more']);
});

test('the reply text is saved once, when complete', async () => {
  const h = harness();
  await h.call.start();
  await h.say('what did I say');
  h.call.onReplyText('You said', false);
  h.call.onReplyText('You said it was the sea.', false);
  assert.deepStrictEqual(h.replies, [], 'not while it is being written');
  h.call.onReplyText('You said it was the sea.', true);
  h.call.onReplyText('You said it was the sea.', true);
  assert.deepStrictEqual(h.replies, ['You said it was the sea.']);
  await h.say('and then');
  h.call.onReplyText('Then you moved.', true);
  assert.deepStrictEqual(h.replies, ['You said it was the sea.', 'Then you moved.'], 'the next reply is saved too');
});

test('hang-up stops the recorder; so do release() and a start that fails', async () => {
  let h = harness();
  await h.call.start();
  await h.call.hangUp();
  assert.deepStrictEqual(h.log, ['stop']);
  h = harness();
  await h.call.start();
  await h.call.release('pagehide');
  assert.deepStrictEqual(h.log, ['stop']);
  h = harness({ over: { server: { start: async () => { throw new Error('no'); }, heartbeat: async () => ({}), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} } } });
  assert.strictEqual(await h.call.start(), false);
  assert.deepStrictEqual(h.log, ['stop']);
});

test('speech while the call has ended is not begun', async () => {
  const h = harness();
  await h.call.start();
  await h.call.hangUp();
  h.log.length = 0;
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart(); h.handlers.onSpeechEnd({ text: 'late' }); await tick();
  assert.deepStrictEqual(h.log, []);
});

test('with no recorder the controller makes no recorder calls and nothing else changes', async () => {
  const h = harness({ withRecorder: false });
  assert.strictEqual(await h.call.start(), true);
  await h.say('plain call speech');
  h.handlers.onSpeechBegin(); h.handlers.onMisfire();
  h.call.onReplyText('A reply.', true);
  await h.call.hangUp();
  assert.deepStrictEqual(h.log, [], 'the fake recorder was never given');
  assert.deepStrictEqual(h.transcripts, []);
  assert.deepStrictEqual(h.replies, []);
  assert.deepStrictEqual(h.sent, ['plain call speech']);
});

test('a recorder that throws never breaks the call', async () => {
  const h = harness();
  h.recorder.begin = () => { throw new Error('boom'); }; h.recorder.end = () => { throw new Error('boom'); };
  await h.call.start();
  await h.say('still sent');
  assert.deepStrictEqual(h.sent, ['still sent']);
});
