'use strict';
// iOS-proofing of voice calls: the frame watchdog (audio stops reaching the detector, or a piece runs over a minute), the adapter's endPiece(),
// the stricter talk-over option and the "I didn't catch that." line for an empty transcript.
const { test } = require('node:test');
const assert = require('node:assert');
Object.assign(globalThis, require('../lib/ui-voice'), require('../lib/ui-voice-thinking'));
const CALL = require('../lib/ui-voice-call');
const { voiceCreateCall, voiceCreateVad, voiceVadThresholds } = CALL;

const tick = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const FRAMES = 'The microphone stopped sending sound, so I restarted it.';
const LONG = 'You talked for over a minute, so I sent what I heard.';
const EMPTY = 'I didn\'t catch that.';

function harness(over) {
  const h = { t: 1000, timers: [], nextId: 1, sent: [], log: [], toasts: [], states: [], handlers: null, running: false, reopens: 0 };
  h.setTimer = (fn, ms) => { const id = h.nextId++; h.timers.push({ id, at: h.t + ms, fn, ms }); return id; };
  h.clearTimer = (id) => { h.timers = h.timers.filter(x => x.id !== id); };
  h.deps = {
    agent: 'a1', now: () => h.t, setTimer: h.setTimer, clearTimer: h.clearTimer, prefs: () => ({ continueWait: 0, thinkingSound: false }),
    vad: {
      start: async (hd) => { h.handlers = hd; }, stop() { h.log.push('vad.stop'); }, setPlaybackActive() {}, setMuted() {},
      endPiece: async () => { h.log.push('endPiece'); return true; },
      reopen: async () => { h.log.push('reopen'); h.reopens++; return true; },
    },
    stt: async (audio) => { h.log.push('stt'); return audio.text; }, isTurnRunning: () => h.running,
    send: async (t) => { h.sent.push(t); h.running = true; }, interject: async () => {}, stop() {},
    speak: () => new Promise(() => {}), cancelSpeech() {}, answerAsk() {},
    recordTranscript() {}, recordReplyText() {},
    server: { start: async () => ({ callId: 'c1', held: [] }), heartbeat: async () => ({ held: [] }), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} },
    ui: { state: (s) => h.states.push(s), heard() {}, held() {}, toast: (m) => h.toasts.push(m), summary() {}, level() {}, activity() {} },
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
const clip = (text, n = 16000) => Object.assign(new Float32Array(n), { text });
const count = (h, s) => h.log.filter(x => x === s).length;
// Real speech with a frame seen just before it, as the detector does.
function speak(h) { h.handlers.onFrame(-30, {}); h.handlers.onSpeechBegin(); h.handlers.onSpeechStart(); }

// ── the frame watchdog ──
test('watchdog: a frame, real speech, then 2 s without frames -> frames line, endPiece, then the microphone is reopened', async () => {
  const h = await started();
  speak(h);
  await advance(h, 1900);
  assert.deepStrictEqual(h.toasts, []);
  await advance(h, 600);
  assert.deepStrictEqual(h.toasts, [FRAMES]);
  assert.deepStrictEqual(h.log.filter(x => x === 'endPiece' || x === 'reopen'), ['endPiece', 'reopen']);
});

test('watchdog: when endPiece delivers the piece through onSpeechEnd it is transcribed and sent as usual', async () => {
  const box = { handlers: null, log: [] };
  const h = await started({ vad: { start: async (hd) => { box.handlers = hd; }, stop() {}, setPlaybackActive() {}, setMuted() {}, reopen: async () => { h.log.push('reopen'); return true; },
    endPiece: async () => { h.log.push('endPiece'); box.handlers.onSpeechEnd(clip('please read the file')); return true; } } });
  h.handlers = box.handlers;
  speak(h);
  await advance(h, 2600);
  assert.deepStrictEqual(h.sent, ['please read the file']);
  assert.deepStrictEqual(h.toasts, [FRAMES]);
  assert.strictEqual(count(h, 'reopen'), 1);
});

test('watchdog: frames keep arriving -> it never fires', async () => {
  const h = await started();
  speak(h);
  for (let i = 0; i < 20; i++) { await advance(h, 500); h.handlers.onFrame(-30, {}); }
  assert.deepStrictEqual(h.toasts, []); assert.strictEqual(count(h, 'endPiece'), 0); assert.strictEqual(count(h, 'reopen'), 0);
});

test('watchdog: no frame ever seen (a detector that sends none) -> not watched for lost frames', async () => {
  const h = await started();
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart();
  await advance(h, 30000);
  assert.deepStrictEqual(h.toasts, []); assert.strictEqual(count(h, 'endPiece'), 0); assert.strictEqual(h.call.state, 'hearing');
});

test('watchdog: one piece over 60 s -> long line and endPiece, no microphone reopen', async () => {
  const h = await started();
  speak(h);
  for (let i = 0; i < 118; i++) { await advance(h, 500); h.handlers.onFrame(-30, {}); }   // 59 s
  assert.deepStrictEqual(h.toasts, []);
  await advance(h, 1000); h.handlers.onFrame(-30, {});
  assert.deepStrictEqual(h.toasts, [LONG]);
  assert.strictEqual(count(h, 'endPiece'), 1); assert.strictEqual(count(h, 'reopen'), 0);
});

test('watchdog: no timer is left after hangUp, nor after the piece ended', async () => {
  const h = await started();
  const dogs = () => h.timers.filter(x => x.ms === 500).length;
  speak(h);
  assert.strictEqual(dogs(), 1, 'one repeating check');
  h.handlers.onSpeechStart();
  assert.strictEqual(dogs(), 1, 'never two');
  await advance(h, 700); h.handlers.onFrame(-30, {});
  assert.strictEqual(dogs(), 1, 're-armed each tick');
  h.handlers.onSpeechEnd(clip('hello there')); await tick();
  assert.strictEqual(dogs(), 0, 'the piece ended');
  speak(h);
  assert.strictEqual(dogs(), 1);
  await h.call.hangUp();
  assert.strictEqual(dogs(), 0, 'no watchdog tick left');
  await advance(h, 5000);
  assert.deepStrictEqual(h.toasts, []); assert.strictEqual(count(h, 'endPiece'), 0);
});

test('watchdog: muting clears it', async () => {
  const h = await started();
  const dogs = () => h.timers.filter(x => x.ms === 500).length;
  speak(h);
  assert.strictEqual(dogs(), 1);
  h.call.setMuted(true);
  assert.strictEqual(dogs(), 0);
  await advance(h, 5000);
  assert.deepStrictEqual(h.toasts, []); assert.strictEqual(count(h, 'endPiece'), 0);
});

test('watchdog: no endPiece on the detector -> the piece is dropped, back to listening, nothing sent; the microphone is still reopened', async () => {
  const box = {};
  const h = await started({ vad: { start: async (hd) => { box.handlers = hd; }, stop() {}, setPlaybackActive() {}, setMuted() {}, reopen: async () => { h.log.push('reopen'); return true; } } });
  h.handlers = box.handlers;
  speak(h);
  assert.strictEqual(h.call.state, 'hearing');
  await advance(h, 2600);
  assert.deepStrictEqual(h.toasts, [FRAMES]);
  assert.strictEqual(h.call.state, 'listening');
  assert.deepStrictEqual(h.sent, []); assert.strictEqual(count(h, 'stt'), 0);
  assert.strictEqual(count(h, 'reopen'), 1);
  assert.strictEqual(h.timers.filter(x => x.ms === 500).length, 0, 'nothing keeps ticking');
});

test('watchdog: an endPiece that delivers nothing leaves the piece dropped, and a throwing one is swallowed', async () => {
  const box = {};
  const h = await started({ vad: { start: async (hd) => { box.handlers = hd; }, stop() {}, setPlaybackActive() {}, setMuted() {}, endPiece: async () => { throw new Error('boom'); }, reopen: async () => { throw new Error('nope'); } } });
  h.handlers = box.handlers;
  speak(h);
  await advance(h, 2600);
  assert.strictEqual(h.call.state, 'listening'); assert.deepStrictEqual(h.sent, []);
});

// ── the adapter: endPiece, and nothing reaches the call after a stop ──
function track() { const t = { enabled: true, readyState: 'live', label: 'Mic', getSettings: () => ({}), stop() { t.readyState = 'ended'; }, addEventListener() {}, removeEventListener() {} }; return t; }
function stream() { const t = track(); return { getTracks: () => [t], getAudioTracks: () => [t] }; }
function vadWorld(extra) {
  const w = { calls: [], newOpts: null, inst: null, ctxState: 'running', resumes: 0, setOpts: [], emitOnPause: null };
  const ctx = {
    sampleRate: 48000, get state() { return w.ctxState; }, resume: async () => { w.resumes++; w.ctxState = 'running'; }, close: async () => {},
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }), createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    createMediaStreamDestination: () => ({ stream: stream() }),
  };
  const nav = { mediaDevices: { getUserMedia: async () => stream(), addEventListener() {}, removeEventListener() {}, enumerateDevices: async () => [] } };
  const MicVAD = { new: async (o) => {
    w.newOpts = o; await o.getStream();
    w.inst = {
      start: async () => { w.calls.push('start'); }, pause: async () => { w.calls.push('pause'); if (w.emitOnPause) w.emitOnPause(); },
      destroy: async () => { w.calls.push('destroy'); await w.inst.pause(); }, setOptions: (x) => { w.setOpts.push(x); },
    };
    return w.inst;
  } };
  const win = { AudioContext: function () { return ctx; }, vad: { MicVAD }, setTimeout, clearTimeout };
  const vad = voiceCreateVad(Object.assign({ win, nav, micLevel: 50, loadScript: async () => {} }, extra || {}));
  return { w, vad, ctx };
}

test('adapter: MicVAD gets submitUserSpeechOnPause: true', async () => {
  const { w, vad } = vadWorld();
  await vad.start({});
  assert.strictEqual(w.newOpts.submitUserSpeechOnPause, true);
  await vad.stop();
});

test('adapter: endPiece pauses then starts the same detector, and the piece reaches onSpeechEnd', async () => {
  const { w, vad } = vadWorld();
  const got = [];
  await vad.start({ onSpeechEnd: (a) => got.push(a) });
  w.calls.length = 0;
  w.emitOnPause = () => w.newOpts.onSpeechEnd('audio-1');
  assert.strictEqual(await vad.endPiece(), true);
  assert.deepStrictEqual(w.calls, ['pause', 'start']);
  assert.deepStrictEqual(got, ['audio-1']);
  await vad.stop();
});

test('adapter: endPiece resumes a context that is not running (1 s at most) and is false without a detector', async () => {
  const { w, vad } = vadWorld();
  assert.strictEqual(await vad.endPiece(), false, 'not started');
  await vad.start({});
  w.ctxState = 'interrupted'; w.calls.length = 0; w.resumes = 0;
  assert.strictEqual(await vad.endPiece(), true);
  assert.strictEqual(w.resumes, 1); assert.deepStrictEqual(w.calls, ['pause', 'start']);
  await vad.stop();
  assert.strictEqual(await vad.endPiece(), false, 'stopped');
});

test('adapter: endPiece is false when pause or start throws, and when stopped meanwhile', async () => {
  const a = vadWorld();
  await a.vad.start({});
  a.w.inst.start = async () => { throw new Error('no'); };
  assert.strictEqual(await a.vad.endPiece(), false);
  await a.vad.stop();
  const b = vadWorld();
  await b.vad.start({});
  b.w.inst.pause = async () => { await b.vad.stop(); };
  b.w.calls.length = 0;
  assert.strictEqual(await b.vad.endPiece(), false);
  assert.ok(!b.w.calls.includes('start'), 'not restarted after the stop');
});

test('adapter: a SpeechEnd the detector emits while it is destroyed (stop) never reaches the handlers', async () => {
  const { w, vad } = vadWorld();
  const got = [];
  await vad.start({ onSpeechEnd: (a) => got.push(['end', a]), onMisfire: () => got.push(['misfire']), onFrame: () => got.push(['frame']) });
  w.newOpts.onSpeechEnd('live');   // while running it is delivered
  assert.deepStrictEqual(got, [['end', 'live']]);
  w.emitOnPause = () => { w.newOpts.onSpeechEnd('late'); w.newOpts.onVADMisfire(); w.newOpts.onFrameProcessed({}, new Float32Array(4)); };
  await vad.stop();
  assert.ok(w.calls.includes('destroy'));
  assert.deepStrictEqual(got, [['end', 'live']]);
});

test('watchdog: a long piece whose endPiece could not restart the detector (false) -> the microphone is reopened', async () => {
  const box = { log: [] };
  const h = await started({ vad: { start: async (hd) => { box.handlers = hd; }, stop() {}, setPlaybackActive() {}, setMuted() {},
    endPiece: async () => { box.log.push('endPiece'); return false; }, reopen: async () => { box.log.push('reopen'); return true; } } });
  h.handlers = box.handlers; h.log = box.log;
  speak(h);
  for (let i = 0; i < 122; i++) { await advance(h, 500); h.handlers.onFrame(-30, {}); }   // 61 s, frames all along
  assert.deepStrictEqual(h.toasts, [LONG]);
  assert.deepStrictEqual(h.log.filter(x => x === 'endPiece' || x === 'reopen'), ['endPiece', 'reopen']);
  assert.strictEqual(h.call.state, 'listening');
});

test('adapter: a detector endPiece left paused (its start failed) is started again by reopen; when it cannot start, the microphone is reported lost', async () => {
  const a = vadWorld();
  const changes = [];
  await a.vad.start({ onMicChange: (ev) => changes.push(ev.ok) });
  let fail = true;
  a.w.inst.start = async () => { a.w.calls.push('start'); if (fail) throw new Error('no'); };
  a.w.calls.length = 0;
  assert.strictEqual(await a.vad.endPiece(), false);
  assert.deepStrictEqual(a.w.calls, ['pause', 'start']);
  assert.strictEqual(await a.vad.reopen(), false, 'still cannot start: lost');
  assert.deepStrictEqual(changes, [false]);
  fail = false; a.w.calls.length = 0;
  assert.strictEqual(await a.vad.reopen(), true);
  assert.deepStrictEqual(a.w.calls, ['start']);
  assert.deepStrictEqual(changes, [false, true]);
  a.w.calls.length = 0;
  assert.strictEqual(await a.vad.reopen(), true);
  assert.deepStrictEqual(a.w.calls, [], 'listening again: a later reopen does not start it');
  await a.vad.stop();
});

// ── stricter talk-over ──
function thr(w) { const x = w.setOpts[w.setOpts.length - 1]; return { positiveSpeechThreshold: x.positiveSpeechThreshold, negativeSpeechThreshold: x.negativeSpeechThreshold, minSpeechFrames: x.minSpeechMs / 32 }; }

test('strictTalkOver: while a reply plays sensitivity 50 acts as 20', async () => {
  const { w, vad } = vadWorld({ strictTalkOver: true, interruptSensitivity: 50 });
  await vad.start({});
  vad.setPlaybackActive(true);
  assert.deepStrictEqual(thr(w), voiceVadThresholds(20, true));
  assert.notDeepStrictEqual(thr(w), voiceVadThresholds(50, true));
  vad.setPlaybackActive(false, true);   // not playing: as always
  assert.deepStrictEqual(thr(w), voiceVadThresholds(50, false));
  await vad.stop();
});

test('strictTalkOver: a sensitivity below 20 stays as it is', async () => {
  const { w, vad } = vadWorld({ strictTalkOver: true, interruptSensitivity: 10 });
  await vad.start({});
  vad.setPlaybackActive(true);
  assert.deepStrictEqual(thr(w), voiceVadThresholds(10, true));
  await vad.stop();
});

test('strictTalkOver: off (the default) leaves the thresholds as before; a later sensitivity change is capped too', async () => {
  const a = vadWorld({ interruptSensitivity: 50 });
  await a.vad.start({}); a.vad.setPlaybackActive(true);
  assert.deepStrictEqual(thr(a.w), voiceVadThresholds(50, true));
  await a.vad.stop();
  const b = vadWorld({ strictTalkOver: true, interruptSensitivity: 10 });
  await b.vad.start({}); b.vad.setPlaybackActive(true);
  b.vad.setInterruptSensitivity(90);
  assert.deepStrictEqual(thr(b.w), voiceVadThresholds(20, true));
  await b.vad.stop();
});

// ── an empty transcript ──
test('empty transcript: a piece of 1 s with no words -> "I didn\'t catch that.", nothing sent, back to listening', async () => {
  const h = await started();
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart();
  assert.strictEqual(h.call.state, 'hearing');
  h.handlers.onSpeechEnd(clip('')); await tick(30);
  assert.deepStrictEqual(h.toasts, [EMPTY]);
  assert.deepStrictEqual(h.sent, []);
  assert.strictEqual(h.call.state, 'listening');
});

test('empty transcript: punctuation only counts as no words', async () => {
  const h = await started();
  h.handlers.onSpeechStart(); h.handlers.onSpeechEnd(clip(' ... ')); await tick(30);
  assert.deepStrictEqual(h.toasts, [EMPTY]);
});

test('empty transcript: a filler-only text stays silent', async () => {
  const h = await started();
  h.handlers.onSpeechStart(); h.handlers.onSpeechEnd(clip('um')); await tick(30);
  assert.deepStrictEqual(h.toasts, []); assert.deepStrictEqual(h.sent, []); assert.strictEqual(h.call.state, 'listening');
});

test('empty transcript: audio under 1 s stays silent', async () => {
  const h = await started();
  h.handlers.onSpeechStart(); h.handlers.onSpeechEnd(clip('', 15999)); await tick(30);
  assert.deepStrictEqual(h.toasts, []);
});

test('empty transcript: in standby (wake phrase on) nothing is said', async () => {
  const h = await started({ wake: () => ({ phrase: 'Computer', quietMs: 20000, local: true }) });
  assert.strictEqual(h.call.isStandby(), true);
  h.handlers.onSpeechStart(); h.handlers.onSpeechEnd(clip('')); await tick(30);
  assert.deepStrictEqual(h.toasts, []);
});

test('empty transcript: when the recognizer fails only "Could not transcribe that." shows', async () => {
  const h = await started({ stt: async () => { throw new Error('down'); } });
  h.handlers.onSpeechStart(); h.handlers.onSpeechEnd(clip('')); await tick(30);
  assert.deepStrictEqual(h.toasts, ['Could not transcribe that.']);
  assert.strictEqual(h.call.state, 'listening');
});

test('empty transcript: a real text is sent and no empty line shows', async () => {
  const h = await started();
  h.handlers.onSpeechStart(); h.handlers.onSpeechEnd(clip('hello sam')); await tick(30);
  assert.deepStrictEqual(h.sent, ['hello sam']); assert.deepStrictEqual(h.toasts, []);
});
