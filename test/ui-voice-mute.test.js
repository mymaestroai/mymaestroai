'use strict';
// Mute for voice calls: the call controller (voiceCreateCall.setMuted / isMuted), the VAD adapter (voiceCreateVad.setMuted: the microphone
// tracks are switched off, also after a reopen) and the page sources (app.js and mobile.js wire the Mute button to the call and the display).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
Object.assign(globalThis, require('../lib/ui-voice'), require('../lib/ui-voice-thinking'));
const CALL = require('../lib/ui-voice-call');
const { voiceCreateCall, voiceCreateVad } = CALL;

const tick = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// ── the call controller: fake clock, fake vad, recorder, server, speech ──
function harness(over) {
  const h = { t: 0, timers: [], nextId: 1, sent: [], log: [], stt: [], vadMuted: [], running: false, handlers: null, pend: [] };
  h.setTimer = (fn, ms) => { const id = h.nextId++; h.timers.push({ id, at: h.t + ms, fn }); return id; };
  h.clearTimer = (id) => { h.timers = h.timers.filter(x => x.id !== id); };
  h.recorder = { begin: () => h.log.push('begin'), drop: () => h.log.push('drop'), end: () => { h.log.push('end'); return { seq: Promise.resolve(1) }; }, stop: () => h.log.push('rec.stop') };
  h.deps = {
    agent: 'a1', now: () => h.t, setTimer: h.setTimer, clearTimer: h.clearTimer, prefs: () => ({ continueWait: 0, thinkingSound: false }),
    vad: { start: async (hd) => { h.handlers = hd; }, stop() { h.log.push('vad.stop'); }, setPlaybackActive() {}, setMuted: (on) => { h.vadMuted.push(on); } },
    stt: async (audio) => { h.stt.push(audio.text); return audio.text; }, isTurnRunning: () => h.running,
    send: async (t) => { h.sent.push(t); h.running = true; }, interject: async () => {}, stop() {},
    speak: (text) => new Promise((resolve) => { h.log.push('speak ' + text); h.pend.push(resolve); }),
    cancelSpeech: () => { h.log.push('cancelSpeech'); const r = h.pend.shift(); if (r) r(false); },
    answerAsk() {},
    keepAlive: { start: () => h.log.push('ka.start'), stop: () => h.log.push('ka.stop') },
    recorder: h.recorder, recordTranscript() {}, recordReplyText() {},
    server: { start: async () => ({ callId: 'c1', held: [] }), heartbeat: async () => ({ held: [] }), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} },
    ui: { state() {}, heard() {}, held() {}, toast() {}, summary() {}, level() {}, activity() {} },
  };
  Object.assign(h.deps, over || {});
  h.call = voiceCreateCall(h.deps);
  return h;
}
async function started(over) { const h = harness(over); assert.strictEqual(await h.call.start(), true); h.log.length = 0; return h; }
async function advance(h, ms) {
  const end = h.t + ms;
  for (;;) {
    const due = h.timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    h.timers = h.timers.filter(x => x !== due); h.t = due.at; due.fn(); await tick();
  }
  h.t = end; await tick();
}
const count = (h, s) => h.log.filter(x => x === s).length;

test('mute: setMuted(true) returns true and isMuted() says so; false returns false; every call starts unmuted', async () => {
  const h = await started();
  assert.strictEqual(h.call.isMuted(), false);
  assert.strictEqual(h.call.setMuted(true), true); assert.strictEqual(h.call.isMuted(), true);
  assert.strictEqual(h.call.setMuted(false), false); assert.strictEqual(h.call.isMuted(), false);
});

test('mute: speech begin, start and end while muted: no transcription, no send, no recorder.begin', async () => {
  const h = await started();
  h.call.setMuted(true);
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart();
  h.handlers.onSpeechEnd({ text: 'hello there' }); await tick();
  h.handlers.onMisfire(); await tick();
  assert.deepStrictEqual(h.stt, []); assert.deepStrictEqual(h.sent, []);
  assert.strictEqual(count(h, 'begin'), 0, 'nothing recorded');
  assert.strictEqual(count(h, 'end'), 0);
});

test('mute: a reply being spoken is not cancelled by speech while muted', async () => {
  const h = await started();
  h.handlers.onSpeechStart(); h.handlers.onSpeechEnd({ text: 'read it' }); await tick();
  h.call.onReplyText('Sentence one. Sentence two. Sentence three. ', false);
  await advance(h, 5000); h.stt.length = 0; h.sent.length = 0;
  assert.ok(h.log.includes('speak Sentence one.'), 'the reply is being spoken');
  h.call.setMuted(true);
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart(); await tick();
  assert.strictEqual(count(h, 'cancelSpeech'), 0, 'not cut');
  h.handlers.onSpeechEnd({ text: 'stop' }); await tick();
  assert.strictEqual(count(h, 'cancelSpeech'), 0); assert.deepStrictEqual(h.stt, []);
});

// Mute mid-statement (owner's report 2026-11-22: a minute of useful talk was lost when Mute was tapped): the statement ENDS at the tap and is sent.
// endPiece stands for the real detector: MicVAD.pause() delivers the audio heard so far through onSpeechEnd (or onVADMisfire when too short).
function endPieceVad(h, deliver) {
  return { start: async (hd) => { h.handlers = hd; }, stop() { h.log.push('vad.stop'); }, setPlaybackActive() {}, setMuted: (on) => { h.vadMuted.push(on); h.log.push('vad.muted ' + on); },
    reopen: async () => { h.log.push('reopen'); return true; },
    endPiece: async () => { h.log.push('endPiece'); return deliver ? deliver() : true; } };
}

test('mute while the person is speaking: what was said up to the tap is transcribed and sent, recorded (end, not drop), tracks off first', async () => {
  const h = harness(); h.deps.vad = endPieceVad(h, () => { h.handlers.onSpeechEnd({ text: 'a long useful statement' }); return true; });
  h.call = voiceCreateCall(h.deps); await h.call.start(); h.log.length = 0;
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart();
  assert.strictEqual(count(h, 'begin'), 1);
  h.call.setMuted(true); await tick(30);
  assert.deepStrictEqual(h.log.filter(x => x === 'vad.muted true' || x === 'endPiece'), ['vad.muted true', 'endPiece'], 'the microphone is off before the piece is ended');
  assert.deepStrictEqual(h.stt, ['a long useful statement']);
  assert.deepStrictEqual(h.sent, ['a long useful statement'], 'sent as a normal turn');
  assert.strictEqual(count(h, 'end'), 1, 'the recording keeps it'); assert.strictEqual(count(h, 'drop'), 0);
  assert.strictEqual(h.call.isMuted(), true);
});

test('mute mid-statement: speech after the tap is not heard, muted; after unmute a stray end of an old piece is ignored and fresh speech is sent', async () => {
  const h = harness(); h.deps.vad = endPieceVad(h, () => { h.handlers.onSpeechEnd({ text: 'before the tap' }); return true; });
  h.call = voiceCreateCall(h.deps); await h.call.start();
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart();
  h.call.setMuted(true); await tick(30);
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart(); h.handlers.onSpeechEnd({ text: 'said while muted' }); h.handlers.onMisfire(); await tick(30);
  assert.deepStrictEqual(h.sent, ['before the tap']);
  h.running = false;   // that turn is over
  h.call.setMuted(false);
  h.handlers.onSpeechEnd({ text: 'stray fragment' }); await tick(30);
  assert.deepStrictEqual(h.stt, ['before the tap'], 'an end with no speech begun since the unmute is a stray fragment');
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart(); h.handlers.onSpeechEnd({ text: 'after unmute' }); await tick(30);
  assert.deepStrictEqual(h.sent, ['before the tap', 'after unmute']);
});

test('mute mid-statement, unmuted again before the detector delivered the end: the statement is still sent', async () => {
  const h = harness(); let release;
  h.deps.vad = endPieceVad(h, () => new Promise((r) => { release = () => { h.handlers.onSpeechEnd({ text: 'kept anyway' }); r(true); }; }));
  h.call = voiceCreateCall(h.deps); await h.call.start();
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart();
  h.call.setMuted(true); await tick(); h.call.setMuted(false);
  release(); await tick(30);
  assert.deepStrictEqual(h.sent, ['kept anyway']);
});

test('mute after only onSpeechBegin: the detector calls it a misfire, nothing is sent, and the call listens on after unmute', async () => {
  const h = harness(); h.deps.vad = endPieceVad(h, () => { h.handlers.onMisfire(); return true; });
  h.call = voiceCreateCall(h.deps); await h.call.start(); h.log.length = 0;
  h.handlers.onSpeechBegin();
  h.call.setMuted(true); await tick(30);
  assert.deepStrictEqual(h.stt, []); assert.strictEqual(count(h, 'drop'), 1);
  h.call.setMuted(false);
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart(); h.handlers.onSpeechEnd({ text: 'fresh' }); await tick(30);
  assert.deepStrictEqual(h.sent, ['fresh']);
});

test('mute mid-statement: an earlier piece still being transcribed is not dropped; it joins the cut piece into one message', async () => {
  const h = harness(); const slow = [];
  h.deps.stt = (audio) => new Promise((r) => { h.stt.push(audio.text); slow.push(() => r(audio.text)); });
  h.deps.vad = endPieceVad(h, () => { h.handlers.onSpeechEnd({ text: 'and the second part' }); return true; });
  h.call = voiceCreateCall(h.deps); await h.call.start();
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart(); h.handlers.onSpeechEnd({ text: 'the first part' }); await tick();
  await advance(h, 500);
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart();   // the second piece begins while the first is being transcribed
  h.call.setMuted(true); await tick(30);
  while (slow.length) { slow.shift()(); await tick(30); }
  assert.deepStrictEqual(h.sent, ['the first part and the second part']);
});

test('mute while a piece waits for more (it sounded unfinished): it is sent at once, not after the wait', async () => {
  const h = harness({ prefs: () => ({ continueWait: 8000, thinkingSound: false }) }); h.deps.vad = endPieceVad(h);
  h.call = voiceCreateCall(h.deps); await h.call.start();
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart(); h.handlers.onSpeechEnd({ text: 'I want to talk about the budget and' }); await tick(30);
  assert.deepStrictEqual(h.sent, [], 'waiting for more');
  h.call.setMuted(true); await tick(30);
  assert.deepStrictEqual(h.sent, ['I want to talk about the budget and']);
  assert.strictEqual(h.log.includes('endPiece'), false, 'nothing was under way at the detector');
  assert.strictEqual(h.timers.filter(x => x.at === 8000).length, 0, 'the 8 s wait timer is gone');
});

test('review r1: Mute while the end-of-turn model is still deciding: the piece is sent at once when it answers "not finished"', async () => {
  let answer;
  const h = harness({ prefs: () => ({ continueWait: 8000, thinkingSound: false }), turnModel: () => new Promise((r) => { answer = r; }) });
  h.deps.vad = endPieceVad(h); h.call = voiceCreateCall(h.deps); await h.call.start();
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart(); h.handlers.onSpeechEnd({ text: 'I want to talk about the budget.' }); await tick(30);
  assert.strictEqual(typeof answer, 'function', 'the model is deciding');
  h.call.setMuted(true); await tick(5);
  answer(0.1); await tick(30);
  assert.deepStrictEqual(h.sent, ['I want to talk about the budget.']);
});

test('review r1: Mute while the end-of-turn model decides, then a quick unmute: still sent at once', async () => {
  let answer;
  const h = harness({ prefs: () => ({ continueWait: 8000, thinkingSound: false }), turnModel: () => new Promise((r) => { answer = r; }) });
  h.deps.vad = endPieceVad(h); h.call = voiceCreateCall(h.deps); await h.call.start();
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart(); h.handlers.onSpeechEnd({ text: 'I want to talk about the budget.' }); await tick(30);
  h.call.setMuted(true); h.call.setMuted(false); answer(0.1); await tick(30);
  assert.deepStrictEqual(h.sent, ['I want to talk about the budget.']);
});

test('review r1: a waiting piece held by a cough, then Mute (the cough is a misfire): sent at once, not after the rest of the wait', async () => {
  const h = harness({ prefs: () => ({ continueWait: 8000, thinkingSound: false }) });
  h.deps.vad = endPieceVad(h, () => { h.handlers.onMisfire(); return true; });
  h.call = voiceCreateCall(h.deps); await h.call.start();
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart(); h.handlers.onSpeechEnd({ text: 'I want to talk about the budget and' }); await tick(30);
  await advance(h, 1000);
  h.handlers.onSpeechBegin(); await tick(5);   // a cough: the waiting piece is held for it
  h.call.setMuted(true); await tick(30);
  assert.deepStrictEqual(h.sent, ['I want to talk about the budget and']);
});

test('review r1: Mute, unmute, Mute before the detector answered: one endPiece, the statement is sent once', async () => {
  const h = harness(); let release;
  h.deps.vad = endPieceVad(h, () => new Promise((r) => { release = () => { h.handlers.onSpeechEnd({ text: 'said before the taps' }); r(true); }; }));
  h.call = voiceCreateCall(h.deps); await h.call.start(); h.log.length = 0;
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart();
  h.call.setMuted(true); h.call.setMuted(false); h.call.setMuted(true); await tick();
  release(); await tick(30);
  assert.strictEqual(count(h, 'endPiece'), 1);
  assert.deepStrictEqual(h.sent, ['said before the taps']);
});

test('review r2: Mute and a quick unmute while an earlier piece is still being transcribed: it is sent at once when its text arrives', async () => {
  const h = harness({ prefs: () => ({ continueWait: 8000, thinkingSound: false }) }); const slow = [];
  h.deps.stt = (audio) => new Promise((r) => { h.stt.push(audio.text); slow.push(() => r(audio.text)); });
  h.deps.vad = endPieceVad(h); h.call = voiceCreateCall(h.deps); await h.call.start();
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart(); h.handlers.onSpeechEnd({ text: 'I want to talk about the budget and' }); await tick(5);
  await advance(h, 200); h.call.setMuted(true);
  await advance(h, 400); h.call.setMuted(false);
  await advance(h, 600); slow.shift()(); await tick(30);
  assert.deepStrictEqual(h.sent, ['I want to talk about the budget and'], 'no 8 s wait');
});

test('review r2: a second Mute on a newer piece (begun after a quick unmute) while the first cut runs: that piece is cut too once the first is done', async () => {
  const h = harness(); const pend = [];
  h.deps.vad = endPieceVad(h, () => new Promise((r) => { pend.push(r); }));
  h.call = voiceCreateCall(h.deps); await h.call.start(); h.log.length = 0;
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart();
  h.call.setMuted(true); await tick();
  h.handlers.onSpeechEnd({ text: 'the first statement' }); await tick(30);   // the detector delivered the cut piece; its restart is still running
  h.running = false; h.call.setMuted(false);
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart();   // speaking again at once
  h.call.setMuted(true); await tick();
  assert.strictEqual(count(h, 'endPiece'), 1, 'one cut at a time');
  pend.shift()(true); await tick(30);
  assert.strictEqual(count(h, 'endPiece'), 2, 'the newer piece is cut after the first');
  h.handlers.onSpeechEnd({ text: 'and the second one' }); pend.shift()(true); await tick(30);
  assert.deepStrictEqual(h.sent, ['the first statement', 'and the second one']);
});

test('review r1: hang-up while the cut at Mute runs: no reopen, nothing sent afterwards, no error', async () => {
  const h = harness(); let release;
  h.deps.vad = endPieceVad(h, () => new Promise((r) => { release = () => r(false); }));
  h.call = voiceCreateCall(h.deps); await h.call.start(); h.log.length = 0;
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart();
  h.call.setMuted(true); await tick();
  await h.call.hangUp(); release(); await tick(30);
  assert.strictEqual(count(h, 'reopen'), 0);
  assert.deepStrictEqual(h.sent, []);
});

test('the piece Mute ended is sent as it is: it does not wait for more even when it sounds unfinished', async () => {
  const h = harness({ prefs: () => ({ continueWait: 8000, thinkingSound: false }) });
  h.deps.vad = endPieceVad(h, () => { h.handlers.onSpeechEnd({ text: 'the next thing we should do is' }); return true; });
  h.call = voiceCreateCall(h.deps); await h.call.start();
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart();
  h.call.setMuted(true); await tick(30);
  assert.deepStrictEqual(h.sent, ['the next thing we should do is']);
});

test('mute with nothing under way: no endPiece, nothing sent, only the microphone goes off', async () => {
  const h = harness(); h.deps.vad = endPieceVad(h);
  h.call = voiceCreateCall(h.deps); await h.call.start(); h.log.length = 0;
  h.call.setMuted(true); await tick(30); await advance(h, 10000);
  assert.deepStrictEqual(h.log, ['vad.muted true']); assert.deepStrictEqual(h.sent, []); assert.deepStrictEqual(h.stt, []);
});

test('mute mid-statement, the detector gives no end and cannot listen again: the piece is let go and the microphone is opened again', async () => {
  const h = harness(); h.deps.vad = endPieceVad(h, () => false);
  h.call = voiceCreateCall(h.deps); await h.call.start(); h.log.length = 0;
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart();
  h.call.setMuted(true); await tick(30);
  assert.strictEqual(count(h, 'drop'), 1); assert.strictEqual(count(h, 'reopen'), 1);
  h.handlers.onSpeechEnd({ text: 'too late' }); await tick(30);
  assert.deepStrictEqual(h.sent, [], 'muted: a later end is not taken');
});

test('a detector without endPiece: the end that follows the silence (within VOICE_MUTE_END_MS) is sent; none at all lets the piece go', async () => {
  const h = await started();   // the harness vad has no endPiece
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart();
  h.call.setMuted(true); await advance(h, 900);
  h.handlers.onSpeechEnd({ text: 'ended by the silence' }); await tick(30);
  assert.deepStrictEqual(h.sent, ['ended by the silence']);
  h.call.setMuted(false);
  const g = await started();
  g.handlers.onSpeechBegin(); g.handlers.onSpeechStart();
  g.call.setMuted(true); await advance(g, 5000); await tick(30);
  assert.strictEqual(count(g, 'drop'), 1, 'let go after the wait');
  g.handlers.onSpeechEnd({ text: 'much later' }); await tick(30);
  assert.deepStrictEqual(g.sent, []);
});

test('mute while the person had cut a reply: their statement is sent as a new turn, like a pause', async () => {
  const h = harness(); h.deps.vad = endPieceVad(h, () => { h.handlers.onSpeechEnd({ text: 'no wait, one more thing' }); return true; });
  h.call = voiceCreateCall(h.deps); await h.call.start();
  h.handlers.onSpeechStart(); h.handlers.onSpeechEnd({ text: 'read it' }); await tick();
  h.call.onReplyText('Sentence one. Sentence two. Sentence three. ', false);
  await advance(h, 5000); h.stt.length = 0; h.sent.length = 0; h.running = false;
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart(); await tick();
  assert.strictEqual(count(h, 'cancelSpeech'), 1, 'the person cut it');
  h.call.setMuted(true); await tick(30);
  assert.deepStrictEqual(h.stt, ['no wait, one more thing']);
  assert.strictEqual(count(h, 'drop'), 0);
});

test('unmute: a fresh onSpeechBegin / onSpeechStart / onSpeechEnd is transcribed and sent as usual', async () => {
  const h = await started();
  h.call.setMuted(true); h.call.setMuted(false);
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart(); h.handlers.onSpeechEnd({ text: 'after unmute' }); await tick();
  assert.deepStrictEqual(h.stt, ['after unmute']); assert.deepStrictEqual(h.sent, ['after unmute']);
});

test('unmute: a fresh onSpeechStart alone (no begin) re-arms the end', async () => {
  const h = await started();
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart();
  h.call.setMuted(true); h.call.setMuted(false);
  h.handlers.onSpeechStart(); h.handlers.onSpeechEnd({ text: 'second try' }); await tick();
  assert.deepStrictEqual(h.sent, ['second try']);
});

test('setMuted calls vad.setMuted with the same value, only on a change', async () => {
  const h = await started();
  h.call.setMuted(true); h.call.setMuted(true); h.call.setMuted(false);
  assert.deepStrictEqual(h.vadMuted, [true, false]);
});

test('a vad without setMuted does not break muting', async () => {
  let hd0 = null;
  const h = await started({ vad: { start: async (hd) => { hd0 = hd; }, stop() {}, setPlaybackActive() {} } });
  assert.strictEqual(h.call.setMuted(true), true);
  hd0.onSpeechBegin(); hd0.onSpeechEnd({ text: 'x' }); await tick();
  assert.deepStrictEqual(h.sent, []);
});

test('muting does not stop the keep-alive; hang-up does', async () => {
  const h = await started();
  h.call.setMuted(true); h.call.setMuted(false);
  assert.strictEqual(count(h, 'ka.stop'), 0);
  await h.call.hangUp(); await tick();
  assert.strictEqual(count(h, 'ka.stop'), 1);
});

test('hang-up while muted: vad.setMuted(false) is called and isMuted() is false after', async () => {
  const h = await started();
  h.call.setMuted(true);
  await h.call.hangUp(); await tick();
  assert.deepStrictEqual(h.vadMuted, [true, false]);
  assert.strictEqual(h.call.isMuted(), false);
});

test('release while muted: vad.setMuted(false) too', async () => {
  const h = await started();
  h.call.setMuted(true);
  h.call.release(); await tick();
  assert.deepStrictEqual(h.vadMuted, [true, false]);
  assert.strictEqual(h.call.isMuted(), false);
});

test('setMuted after the call ended returns false and does not touch the vad', async () => {
  const h = await started();
  await h.call.hangUp(); await tick();
  assert.strictEqual(h.call.setMuted(true), false);
  assert.strictEqual(h.call.isMuted(), false);
  assert.deepStrictEqual(h.vadMuted, []);
});

// ── the VAD adapter: tracks are switched off, also after a reopen ──
function track(settings) {
  const t = { enabled: true, readyState: 'live', label: 'Mic', listeners: {}, getSettings: () => settings, stop() { t.readyState = 'ended'; }, addEventListener(n, f) { t.listeners[n] = f; }, removeEventListener(n) { delete t.listeners[n]; } };
  return t;
}
function stream(tr) { return { getTracks: () => [tr], getAudioTracks: () => [tr] }; }
function vadWorld() {
  const w = { opens: [], tracks: [] };
  const ctx = {
    sampleRate: 48000, state: 'running', resume: async () => {}, close: async () => {},
    createMediaStreamSource: (s) => ({ stream: s, connect() {}, disconnect() {} }),
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    createMediaStreamDestination: () => ({ stream: stream(track({})) }),
  };
  const nav = { mediaDevices: { getUserMedia: async (c) => {
    w.opens.push(c);
    const raw = c.audio && c.audio.echoCancellation === false;
    const tr = track({ deviceId: 'dev-1', echoCancellation: !raw, sampleRate: 48000 });
    w.tracks.push(tr);
    return stream(tr);
  }, addEventListener() {}, removeEventListener() {}, enumerateDevices: async () => [] } };
  const win = { AudioContext: function () { return ctx; }, vad: { MicVAD: { new: async (o) => { await o.getStream(); return { start: async () => {}, destroy: async () => {}, setOptions() {} }; } } }, setTimeout, clearTimeout };
  const vad = voiceCreateVad({ win, nav, micLevel: 50, loadScript: async () => {} });
  return { w, vad };
}

test('VAD adapter: setMuted(true) disables the open microphone track; setMuted(false) enables it; isMuted follows', async () => {
  const { w, vad } = vadWorld();
  await vad.start({});
  assert.strictEqual(w.tracks[0].enabled, true);
  assert.strictEqual(vad.isMuted(), false);
  vad.setMuted(true);
  assert.strictEqual(w.tracks[0].enabled, false); assert.strictEqual(vad.isMuted(), true);
  vad.setMuted(false);
  assert.strictEqual(w.tracks[0].enabled, true); assert.strictEqual(vad.isMuted(), false);
  await vad.stop();
});

test('VAD adapter: a reopen while muted gives a new track that is already disabled; unmute enables whatever is open then', async () => {
  const { w, vad } = vadWorld();
  await vad.start({});
  vad.setMuted(true);
  assert.strictEqual(await vad.reopen(), true);
  assert.ok(w.tracks.length >= 2);
  const cur = w.tracks[w.tracks.length - 1];
  assert.notStrictEqual(cur, w.tracks[0]);
  assert.strictEqual(cur.enabled, false, 'a microphone opened while muted starts disabled');
  vad.setMuted(false);
  assert.strictEqual(cur.enabled, true);
  await vad.stop();
});

test('VAD adapter: the track ending while muted (opened again at once) also gives a disabled track', async () => {
  const { w, vad } = vadWorld();
  await vad.start({});
  vad.setMuted(true);
  const n = w.tracks.length;
  w.tracks[0].listeners.ended && w.tracks[0].listeners.ended();
  await tick(30);
  if (w.tracks.length > n) assert.strictEqual(w.tracks[w.tracks.length - 1].enabled, false);
  else assert.fail('the ended track was not reopened');
  await vad.stop();
});

test('VAD adapter: the recording\'s second microphone track follows mute too (muted before and after it is opened)', async () => {
  const { w, vad } = vadWorld();
  await vad.start({});
  vad.setMuted(true);
  const r = await vad.openRecordingTap(true);
  assert.strictEqual(r.processing, 'second-track');
  const second = w.tracks[1];
  assert.strictEqual(second.enabled, false, 'opened while muted: disabled');
  vad.setMuted(false);
  assert.strictEqual(second.enabled, true); assert.strictEqual(w.tracks[0].enabled, true);
  vad.setMuted(true);
  assert.strictEqual(second.enabled, false); assert.strictEqual(w.tracks[0].enabled, false);
  await vad.stop();
});

// ── the pages wire the Mute button ──
for (const [file, label] of [['app.js', 'app.js'], ['mobile.js', 'mobile.js']]) {
  test(label + ': the display gets onMute: voiceCallMuteTap, the vad wrapper passes setMuted through, the tap calls setMuted on the call and on the display', () => {
    const src = read(file);
    assert.ok(/createCallDisplay\(/.test(src));
    assert.ok(/onMute:\s*voiceCallMuteTap/.test(src), 'onMute: voiceCallMuteTap');
    const w = src.match(/function voiceDispVad\([^)]*\)[^\n]*|setPlaybackActive: \(on, now\) => vc\.vad\.setPlaybackActive[^\n]*/g) || [];
    assert.ok(w.some(l => /setMuted:\s*\(on\)\s*=>\s*\w+(\.vad)?\.setMuted\(on\)/.test(l)), 'the vad wrapper includes setMuted');
    const m = src.match(/function voiceCallMuteTap\(want\) \{[^\n]*\}/);
    assert.ok(m, 'voiceCallMuteTap exists');
    assert.ok(/\.setMuted\(want\)/.test(m[0]), 'calls setMuted on the call');
    assert.ok(/\bd\.setMuted\(/.test(m[0]), 'calls setMuted on the display');
  });
}

// ── Interrupt while muted: the reply still stops (the Interrupt button's floor asks the call's interrupt()) ──
test('mute: interrupt() while muted stops the reply being read and the rest of it; unmuted or idle it does nothing', async () => {
  const h = await started();
  assert.strictEqual(h.call.interrupt(), false, 'not muted: the floor is taken the usual way instead');
  h.handlers.onSpeechStart(); h.handlers.onSpeechEnd({ text: 'read it' }); await tick();
  h.call.onReplyText('Sentence one. Sentence two. Sentence three. ', false);
  await advance(h, 5000);
  assert.ok(h.log.includes('speak Sentence one.'));
  h.call.setMuted(true);
  assert.strictEqual(h.call.interrupt(), true, 'something was stopped');
  assert.strictEqual(count(h, 'cancelSpeech'), 1, 'the reading is cut');
  await advance(h, 5000);
  assert.ok(!h.log.some(x => x === 'speak Sentence two.' || x === 'speak Sentence three.'), 'the rest of the reply is not read');
  assert.strictEqual(h.call.interrupt(), false, 'nothing left to stop');
  assert.deepStrictEqual(h.stt.slice(1), [], 'nothing listened for');
  h.call.onReplyText('Sentence one. Sentence two. Sentence three. Sentence four. ', true);   // the rest of this reply arrives after the interrupt
  await advance(h, 5000);
  assert.ok(!h.log.includes('speak Sentence four.'), 'text arriving after the interrupt is not read either');
  // unmuted, the next turn is heard and its reply read as usual
  h.running = false; h.call.setMuted(false);
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart(); h.handlers.onSpeechEnd({ text: 'next question' }); await tick(); await advance(h, 3000);
  assert.ok(h.stt.includes('next question') && h.sent.some(x => /next question/.test(x)), 'the next turn is sent');
  h.call.onReplyText('A new answer. ', true); await advance(h, 5000);
  assert.ok(h.log.includes('speak A new answer.'), 'and its reply is read');
});

test('talk floor: while the call is muted, take() asks interrupt() and never sends a speech start', () => {
  const CD = require('../lib/ui-call-display');
  const log = [];
  const fake = { state: 'speaking', isMuted: () => true, interrupt: () => { log.push('interrupt'); return true; }, onSpeechStart: () => log.push('start'), onMisfire: () => log.push('misfire') };
  const f = CD.createTalkFloor({ call: () => fake, setTimer: () => 1, clearTimer() {} });
  assert.strictEqual(f.take(), true);
  assert.deepStrictEqual(log, ['interrupt']);
  assert.strictEqual(f.taken, false, 'the floor is not taken while muted');
  fake.isMuted = () => false;
  assert.strictEqual(f.take(), true);
  assert.deepStrictEqual(log, ['interrupt', 'start'], 'unmuted: the floor as before');
});
