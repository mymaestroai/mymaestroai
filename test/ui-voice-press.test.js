'use strict';
// Tap to talk inside a voice call (deps.press, opts.manual): the controller (voiceCreateCall.talk) and the VAD adapter (voiceCreateVad in manual mode).
// The microphone is heard only while the person presses; a press ends when they press again or let go, never on a pause.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
Object.assign(globalThis, require('../lib/ui-voice'), require('../lib/ui-voice-thinking'));
const CALL = require('../lib/ui-voice-call');
const { voiceCreateCall, voiceCreateVad } = CALL;

const tick = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// ── the controller: fake clock, a fake detector that stands for the manual adapter, server, speech, stt (audio.text) ──
function harness(over, vadOver) {
  const h = { t: 0, timers: [], nextId: 1, sent: [], log: [], stt: [], pressUi: [], toasts: [], running: false, handlers: null, pend: [], frames: 0 };
  h.setTimer = (fn, ms) => { const id = h.nextId++; h.timers.push({ id, at: h.t + ms, fn }); return id; };
  h.clearTimer = (id) => { h.timers = h.timers.filter(x => x.id !== id); };
  h.text = 'hello there';
  // The manual adapter: setMuted(false) reports a piece starting; endPiece delivers the whole recording (the text) through onSpeechEnd.
  h.vad = Object.assign({
    start: async (hd) => { h.handlers = hd; }, stop() { h.log.push('vad.stop'); }, setPlaybackActive() {},
    setMuted: (on) => { h.log.push('vad.muted ' + on); if (!on && h.emit !== false) { h.handlers.onSpeechBegin(); h.handlers.onSpeechStart(); } },
    endPiece: async () => { h.log.push('endPiece'); await h.handlers.onSpeechEnd({ text: h.text }); return true; },
  }, vadOver || {});
  h.deps = {
    agent: 'a1', press: true, now: () => h.t, setTimer: h.setTimer, clearTimer: h.clearTimer, prefs: () => ({ continueWait: 0, thinkingSound: false }),
    vad: h.vad,
    stt: async (audio) => { h.stt.push(audio.text); return audio.text; }, isTurnRunning: () => h.running,
    send: async (t) => { h.sent.push(t); h.running = true; }, interject: async () => {}, stop() {},
    speak: (text) => new Promise((resolve) => { h.log.push('speak ' + text); h.pend.push(resolve); }),
    cancelSpeech: () => { h.log.push('cancelSpeech'); const r = h.pend.shift(); if (r) r(false); },
    answerAsk() {},
    server: { start: async () => ({ callId: 'c1', held: [] }), heartbeat: async () => ({ held: [] }), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} },
    ui: { state() {}, heard() {}, held() {}, toast: (m) => h.toasts.push(m), summary() {}, level() {}, activity() {}, press: (on) => h.pressUi.push(on) },
  };
  Object.assign(h.deps, over || {});
  h.call = voiceCreateCall(h.deps);
  return h;
}
async function started(over, vadOver) { const h = harness(over, vadOver); assert.strictEqual(await h.call.start(), true); h.log.length = 0; return h; }
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

test('press 1: a press-mode call starts with the microphone off, paints ui.press(false) and is not in standby (even with a wake phrase on)', async () => {
  const h = harness({ wake: () => ({ phrase: 'hey', quietMs: 1000, local: true }), chime() {} });
  assert.strictEqual(h.call.press, true);
  assert.strictEqual(await h.call.start(), true);
  assert.ok(h.log.includes('vad.muted true'), 'the microphone tracks are switched off');
  assert.deepStrictEqual(h.pressUi, [false]);
  assert.notStrictEqual(h.call.state, 'standby'); assert.strictEqual(h.call.isStandby(), false);
  h.call.wakeChanged(); assert.strictEqual(h.call.isStandby(), false, 'wakeChanged is a no-op');
  assert.strictEqual(h.call.talk(true), true);
  assert.deepStrictEqual(h.pressUi, [false, true]);
});

test('press 2: talk(true) then talk(false) sends the whole recording at once, with no wait for more, even when it sounds unfinished', async () => {
  const h = await started({ prefs: () => ({ continueWait: 3000, thinkingSound: false }) });
  h.text = 'and then I went to';
  assert.strictEqual(h.call.talk(true), true);
  assert.strictEqual(h.call.talk(true), true, 'idempotent');
  assert.strictEqual(h.call.talk(false), false);
  assert.strictEqual(h.call.talk(false), false, 'idempotent');
  await tick(40);
  assert.deepStrictEqual(h.sent, ['and then I went to'], 'sent at once, once');
  assert.deepStrictEqual(h.log.filter(x => x.startsWith('vad.muted') || x === 'endPiece'), ['vad.muted false', 'vad.muted true', 'endPiece']);
  assert.deepStrictEqual(h.pressUi, [false, true, false]);
  await advance(h, 10000);
  assert.deepStrictEqual(h.sent, ['and then I went to'], 'nothing more later');
});

test('press 2b: a detector that does not report the piece start still gets one from talk(true)', async () => {
  const h = await started({}, { setMuted: (on) => { h.log.push('vad.muted ' + on); } });
  h.text = 'no start event';
  h.call.talk(true); h.call.talk(false); await tick(40);
  assert.deepStrictEqual(h.sent, ['no start event']);
});

test('press 3: a pause does not send; only letting go does', async () => {
  const h = await started();
  h.call.talk(true);
  await advance(h, 10000);
  assert.deepStrictEqual(h.sent, []); assert.strictEqual(count(h, 'endPiece'), 0);
  h.call.talk(false); await tick(40);
  assert.deepStrictEqual(h.sent, ['hello there']);
});

test('press 4: a statement of five minutes goes through whole: no cut at 60 s, frames keep arriving', async () => {
  const h = await started();
  h.call.talk(true);
  for (let s = 0; s < 300; s++) { h.handlers.onFrame(-30, {}); await advance(h, 1000); }
  assert.strictEqual(count(h, 'endPiece'), 0, 'no piece cut');
  assert.deepStrictEqual(h.sent, []); assert.deepStrictEqual(h.toasts, []);
  h.call.talk(false); await tick(40);
  assert.deepStrictEqual(h.sent, ['hello there']);
});

test('press 4b: at 15 minutes the press is cut and sent with the press line; lost frames also end it', async () => {
  const h = await started();
  h.call.talk(true);
  for (let s = 0; s < 15 * 60 + 2; s++) { h.handlers.onFrame(-30, {}); await advance(h, 1000); }
  await tick(40);
  assert.deepStrictEqual(h.toasts, ['You talked for 15 minutes, so I sent what I heard.']);
  assert.deepStrictEqual(h.sent, ['hello there']);
  assert.deepStrictEqual(h.pressUi.slice(-1), [false], 'the press is over');
  // frames stop arriving during a press: the press ends and is sent
  const g = await started();
  await advance(g, 100);   // (a frame at clock 0 would count as "no frame yet")
  g.call.talk(true); g.handlers.onFrame(-30, {}); await advance(g, 3000); await tick(40);
  assert.deepStrictEqual(g.sent, ['hello there']); assert.strictEqual(g.toasts.length, 1);
});

test('press 5: talk(true) while the agent is speaking cuts the reply', async () => {
  const h = await started();
  h.call.onReplyText('Sentence one. Sentence two. Sentence three. ', false);
  await advance(h, 5000);
  assert.ok(h.log.includes('speak Sentence one.'), 'the reply is being spoken');
  assert.strictEqual(count(h, 'cancelSpeech'), 0);
  h.call.talk(true); await tick();
  assert.ok(count(h, 'cancelSpeech') >= 1, 'the reply is cut');
  h.call.talk(false); await tick(40);
});

test('press 6: talk() in a hands-free call returns false and changes nothing; Mute still ends the piece and sends it at once', async () => {
  const h = await started({ press: undefined, prefs: () => ({ continueWait: 3000, thinkingSound: false }) });
  assert.strictEqual(h.call.press, false);
  assert.strictEqual(h.call.talk(true), false); assert.strictEqual(h.call.talk(false), false);
  assert.strictEqual(h.call.isMuted(), false); assert.deepStrictEqual(h.log.filter(x => x.startsWith('vad.muted')), []); assert.deepStrictEqual(h.pressUi, []);
  h.text = 'and then I went to';
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart();
  h.call.setMuted(true); await tick(40);
  assert.deepStrictEqual(h.sent, ['and then I went to'], 'Mute: sent at once');
});

// ── the adapter in manual mode: a fake MicVAD, one persistent microphone track ──
function fakeBrowser() {
  const b = { created: [], track: { enabled: true, stop() {} }, destroyed: 0, closed: 0 };
  class Gain { constructor() { this.gain = { value: 1 }; } connect() {} }
  class Ctx {
    constructor() { this.state = 'suspended'; } async resume() { this.state = 'running'; } async close() { b.closed++; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; } createGain() { return new Gain(); }
    createMediaStreamDestination() { return { kind: 'dest', stream: { id: 'dest-stream', getTracks: () => [] } }; }
  }
  const raw = { id: 'raw', getAudioTracks: () => [b.track], getTracks: () => [b.track] };
  class MicVAD {
    static async new(options) { const v = new MicVAD(); v.options = options; b.created.push(v); return v; }
    async start() {} async destroy() { b.destroyed++; } setOptions() {}
  }
  const win = { AudioContext: Ctx, vad: undefined, navigator: { mediaDevices: { getUserMedia: async () => raw } } };
  const loadScript = async () => { win.vad = { MicVAD }; };
  return { b, win, loadScript };
}
const frames = (o, n) => { for (let i = 0; i < n; i++) o.onFrameProcessed({ isSpeech: 0.1 }, new Float32Array(512).fill(i + 1)); };

test('press 7: the manual adapter ignores the detector\'s speech events, starts muted, and a press is the frames between unmute and mute', async () => {
  const { b, win, loadScript } = fakeBrowser();
  const ev = [];
  const vad = voiceCreateVad({ manual: true, win, loadScript, echoHoldMs: 0 });
  await vad.start({ onSpeechBegin: () => ev.push('begin'), onSpeechStart: () => ev.push('start'), onSpeechEnd: (a) => ev.push(['end', a.length, a[0], a[a.length - 1]]), onMisfire: () => ev.push('misfire'), onFrame: () => ev.push('frame') });
  const o = b.created[0].options;
  await o.getStream();
  assert.strictEqual(b.track.enabled, false, 'tracks are off from the start');
  assert.strictEqual(vad.isMuted(), true);
  o.onSpeechStart(); o.onSpeechRealStart(); o.onSpeechEnd(new Float32Array(3)); o.onVADMisfire();
  assert.deepStrictEqual(ev, [], 'the detector\'s speech events reach nobody');
  frames(o, 3); assert.deepStrictEqual(ev, ['frame', 'frame', 'frame'], 'frames (the level meter) still flow, but nothing is kept while muted');
  assert.strictEqual(await vad.endPiece(), true); assert.deepStrictEqual(ev.slice(3), ['misfire'], 'nothing collected: a false start');
  ev.length = 0;
  // press: tracks on, begin then start, frames kept
  vad.setMuted(false);
  assert.strictEqual(b.track.enabled, true);
  assert.deepStrictEqual(ev, ['begin', 'start']);
  ev.length = 0;
  frames(o, 9);
  vad.setMuted(true);
  assert.strictEqual(b.track.enabled, false, 'tracks are off between presses');
  frames(o, 5);   // after the release: not kept
  ev.length = 0;
  assert.strictEqual(await vad.endPiece(), true);
  assert.deepStrictEqual(ev, [['end', 9 * 512, 1, 9]], 'one Float32Array of the right length, in order');
  assert.strictEqual(await vad.endPiece(), true); assert.deepStrictEqual(ev.slice(1), ['misfire'], 'the buffer was cleared');
  await vad.stop();
});

test('press 7b: a press under 250 ms is a false start; exactly 250 ms is a piece; a second press starts a clean buffer', async () => {
  const { b, win, loadScript } = fakeBrowser();
  const ev = [];
  const vad = voiceCreateVad({ manual: true, win, loadScript, echoHoldMs: 0 });
  await vad.start({ onSpeechBegin() {}, onSpeechStart() {}, onSpeechEnd: (a) => ev.push('end ' + a.length), onMisfire: () => ev.push('misfire') });
  const o = b.created[0].options; await o.getStream();
  vad.setMuted(false); frames(o, 7); vad.setMuted(true);   // 3584 samples = 224 ms
  await vad.endPiece(); assert.deepStrictEqual(ev, ['misfire']);
  ev.length = 0;
  vad.setMuted(false); o.onFrameProcessed({}, new Float32Array(4000)); vad.setMuted(true);
  await vad.endPiece(); assert.deepStrictEqual(ev, ['end 4000']);
  ev.length = 0;
  vad.setMuted(false); frames(o, 2); vad.setMuted(true);
  vad.setMuted(false); frames(o, 1); vad.setMuted(true);   // a quick second press: only its own frames
  await vad.endPiece(); assert.deepStrictEqual(ev, ['misfire']);
  await vad.stop();
});

test('press 7c: a hands-free adapter is unchanged: speech events pass, tracks start on, setMuted emits nothing', async () => {
  const { b, win, loadScript } = fakeBrowser();
  const ev = [];
  const vad = voiceCreateVad({ win, loadScript, echoHoldMs: 0 });
  await vad.start({ onSpeechBegin: () => ev.push('begin'), onSpeechStart: () => ev.push('start'), onSpeechEnd: (a) => ev.push('end ' + a.length), onMisfire: () => ev.push('misfire') });
  const o = b.created[0].options; await o.getStream();
  assert.strictEqual(b.track.enabled, true);
  o.onSpeechStart(); o.onSpeechRealStart(); o.onSpeechEnd(new Float32Array(3)); o.onVADMisfire();
  assert.deepStrictEqual(ev, ['begin', 'start', 'end 3', 'misfire']);
  ev.length = 0; vad.setMuted(true); vad.setMuted(false); assert.deepStrictEqual(ev, []);
  await vad.stop();
});

test('press 7d: the controller on a real manual adapter: press, frames, release sends the whole recording', async () => {
  const { b, win, loadScript } = fakeBrowser();
  const vad = voiceCreateVad({ manual: true, win, loadScript, echoHoldMs: 0 });
  const h = await started({ vad, stt: async (audio) => { h.stt.push(audio.length); return 'what I said'; } });
  const o = b.created[0].options; await o.getStream();
  assert.strictEqual(b.track.enabled, false);
  h.call.talk(true); assert.strictEqual(b.track.enabled, true);
  for (let i = 0; i < 20; i++) { frames(o, 1); await advance(h, 32); }
  for (let s = 0; s < 10; s++) { o.onFrameProcessed({}, new Float32Array(0)); await advance(h, 1000); }   // a pause: frames of silence keep arriving, nothing is kept or sent
  assert.deepStrictEqual(h.sent, []);
  h.call.talk(false); await tick(40);
  assert.deepStrictEqual(h.stt, [20 * 512]); assert.deepStrictEqual(h.sent, ['what I said']);
  assert.strictEqual(b.track.enabled, false);
  // a tap that is too short sends nothing
  h.sent.length = 0; h.call.talk(true); frames(o, 2); h.call.talk(false); await tick(40);
  assert.deepStrictEqual(h.sent, []); assert.strictEqual(h.call.state === 'hearing', false);
  await h.call.hangUp();
});

test('press 8: the page copies in app.js and mobile.js carry the controller and the adapter', () => {
  const lib = read('lib/ui-voice-call.js');
  for (const f of ['app.js', 'mobile.js']) {
    const s = read(f);
    for (const needle of ['function talk(on)', 'VOICE_PRESS_MAX_MS', 'st.manual', 'get press()']) assert.ok(s.includes(needle), f + ' has ' + needle);
  }
  assert.ok(lib.includes('function talk(on)'));
});
