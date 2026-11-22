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
// The adapter's own clock and timers (its press tail is waited out through the injected setTimer): c.go(ms) moves time and runs what is due.
function clock() {
  const c = { t: 1000, timers: [], id: 1 };
  c.now = () => c.t;
  c.setTimer = (fn, ms) => { const id = c.id++; c.timers.push({ id, at: c.t + ms, fn }); return id; };
  c.clearTimer = (id) => { c.timers = c.timers.filter((x) => x.id !== id); };
  c.go = (ms) => { const end = c.t + ms; for (;;) { const due = c.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0]; if (!due) break; c.timers = c.timers.filter((x) => x !== due); c.t = due.at; due.fn(); } c.t = end; };
  c.opts = { now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer };
  return c;
}
// endPiece with the tail waited out: starts it, moves the clock past the 200 ms tail, and answers with what it answered.
const endAfter = async (vad, c, ms = 200) => { const p = vad.endPiece(); c.go(ms); return p; };

test('press 7: the manual adapter ignores the detector\'s speech events, starts muted, and a press is the frames between unmute and mute', async () => {
  const { b, win, loadScript } = fakeBrowser();
  const ev = [], c = clock();
  const vad = voiceCreateVad({ manual: true, win, loadScript, echoHoldMs: 0, ...c.opts });
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
  c.go(250); frames(o, 5);   // long after the release (past its 200 ms tail): not kept
  ev.length = 0;
  assert.strictEqual(await vad.endPiece(), true);
  assert.deepStrictEqual(ev, [['end', 9 * 512, 1, 9]], 'one Float32Array of the right length, in order');
  assert.strictEqual(await vad.endPiece(), true); assert.deepStrictEqual(ev.slice(1), ['misfire'], 'the buffer was cleared');
  await vad.stop();
});

test('press 7b: a press under 250 ms is a false start; exactly 250 ms is a piece; a second press starts a clean buffer', async () => {
  const { b, win, loadScript } = fakeBrowser();
  const ev = [], c = clock();
  const vad = voiceCreateVad({ manual: true, win, loadScript, echoHoldMs: 0, ...c.opts });
  await vad.start({ onSpeechBegin() {}, onSpeechStart() {}, onSpeechEnd: (a) => ev.push('end ' + a.length), onMisfire: () => ev.push('misfire') });
  const o = b.created[0].options; await o.getStream();
  vad.setMuted(false); frames(o, 7); vad.setMuted(true);   // 3584 samples = 224 ms
  await endAfter(vad, c); assert.deepStrictEqual(ev, ['misfire']);
  ev.length = 0;
  vad.setMuted(false); o.onFrameProcessed({}, new Float32Array(4000)); vad.setMuted(true);
  await endAfter(vad, c); assert.deepStrictEqual(ev, ['end 4000']);
  ev.length = 0;
  vad.setMuted(false); frames(o, 2); vad.setMuted(true);
  vad.setMuted(false); frames(o, 1); vad.setMuted(true);   // a quick second press: only its own frames
  await endAfter(vad, c); assert.deepStrictEqual(ev, ['misfire']);
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
  const c = clock();
  const vad = voiceCreateVad({ manual: true, win, loadScript, echoHoldMs: 0, ...c.opts });
  const h = await started({ vad, stt: async (audio) => { h.stt.push(audio.length); return 'what I said'; } });
  const o = b.created[0].options; await o.getStream();
  assert.strictEqual(b.track.enabled, false);
  h.call.talk(true); assert.strictEqual(b.track.enabled, true);
  for (let i = 0; i < 20; i++) { frames(o, 1); await advance(h, 32); }
  for (let s = 0; s < 10; s++) { o.onFrameProcessed({}, new Float32Array(0)); await advance(h, 1000); }   // a pause: frames of silence keep arriving, nothing is kept or sent
  assert.deepStrictEqual(h.sent, []);
  h.call.talk(false); await tick(10); c.go(200); await tick(40);   // the press's 200 ms tail (frames still in the pipeline) is waited out, then it is sent
  assert.deepStrictEqual(h.stt, [20 * 512]); assert.deepStrictEqual(h.sent, ['what I said']);
  assert.strictEqual(b.track.enabled, false);
  // a tap that is too short sends nothing
  h.sent.length = 0; h.call.talk(true); frames(o, 2); h.call.talk(false); await tick(10); c.go(200); await tick(40);
  assert.deepStrictEqual(h.sent, []); assert.strictEqual(h.call.state === 'hearing', false);
  await h.call.hangUp();
});

// ── review round 1, item 1: a frame belongs to the press it was captured in; the tail of a press is kept ──
const fr = (o, n, v) => { for (let i = 0; i < n; i++) o.onFrameProcessed({ isSpeech: 0.1 }, new Float32Array(512).fill(v)); };
async function manual(extra) {
  const { b, win, loadScript } = fakeBrowser(), c = clock(), ev = [];
  const vad = voiceCreateVad({ manual: true, win, loadScript, echoHoldMs: 0, ...c.opts, ...(extra || {}) });
  await vad.start({ onSpeechBegin() {}, onSpeechStart() {}, onSpeechEnd: (a) => ev.push(['end', a.length, a[0], a[a.length - 1]]), onMisfire: () => ev.push('misfire') });
  const o = b.created[0].options; await o.getStream();
  return { vad, c, ev, o };
}

test('press R1a: a frame processed after the release but within 200 ms is in the sent audio (the last syllable); one 250 ms after is not', async () => {
  const { vad, c, ev, o } = await manual();
  vad.setMuted(false); fr(o, 9, 1); vad.setMuted(true);
  c.go(120); fr(o, 2, 7);                      // captured before the release, processed 120 ms after it
  const p = vad.endPiece(); await tick(); assert.deepStrictEqual(ev, [], 'handed over only when the tail is over');
  c.go(80); await p;
  assert.deepStrictEqual(ev, [['end', 11 * 512, 1, 7]], 'the late frames are at the end of the piece');
  ev.length = 0;
  vad.setMuted(false); fr(o, 9, 1); vad.setMuted(true);
  c.go(250); fr(o, 3, 7);                      // 250 ms after the release: silence, not the press's
  await endAfter(vad, c);
  assert.deepStrictEqual(ev, [['end', 9 * 512, 1, 1]]);
  await vad.stop();
});

// changed (round 2): B's audio during A's tail used to be B's at once; now B's tracks stay muted and B is admitted when A's tail ends, so a frame in A's tail is A's.
test('press R1b: a new press started during the tail of the old one is admitted when that tail ends; the tail frames stay A\'s, B has only its own', async () => {
  const { vad, c, ev, o } = await manual();
  vad.setMuted(false); fr(o, 9, 1); vad.setMuted(true);   // press A, released
  c.go(50); vad.setMuted(false);                           // press B starts inside A's tail, before A's piece has been taken: still muted
  assert.strictEqual(vad.isMuted(), true, 'B is not admitted yet');
  fr(o, 10, 5);                                            // processed inside A's tail: A's frames (B's tracks are off)
  const pa = vad.endPiece();                               // A's piece: waits out what is left of A's tail
  c.go(150); await pa;                                     // A's tail ends: B is admitted
  assert.strictEqual(vad.isMuted(), false, 'B is admitted when A\'s tail ends');
  assert.deepStrictEqual(ev, [['end', 19 * 512, 1, 5]], 'A has its own frames and those of its tail; B\'s start neither cleared them nor took them');
  ev.length = 0;
  fr(o, 10, 6); vad.setMuted(true); const pb = vad.endPiece(); c.go(200); await pb;
  assert.deepStrictEqual(ev, [['end', 10 * 512, 6, 6]], 'B has only the frames after its admission');
  await vad.stop();
});

// changed (round 2): B pressed inside A's tail is admitted only when the tail ends (its own frames start then); A keeps everything that arrives in its tail.
test('press R1c: two quick presses make two pieces, each with its own frames (A keeps the frames that arrive in its tail, B is admitted when it ends)', async () => {
  const { vad, c, ev, o } = await manual();
  vad.setMuted(false); fr(o, 9, 1); vad.setMuted(true);
  c.go(60); fr(o, 2, 9);                                                       // A's last syllable, processed 60 ms after the release
  const pa = vad.endPiece();
  c.go(40); vad.setMuted(false); fr(o, 1, 4);                                  // B is pressed inside A's tail: its tracks stay muted, this frame is A's
  c.go(100);                                                                   // A's tail ends: B is admitted
  fr(o, 12, 2); c.go(30); vad.setMuted(true);
  const pb = vad.endPiece();                                                   // takes the most recently ended press (B)
  c.go(400); await pa; await pb;
  assert.deepStrictEqual(ev, [['end', 12 * 512, 1, 4], ['end', 12 * 512, 2, 2]]);
  // a press nobody ended with endPiece is not mixed into the next one, nor sent late with it
  ev.length = 0;
  vad.setMuted(false); fr(o, 8, 3); vad.setMuted(true); c.go(300);
  vad.setMuted(false); fr(o, 9, 4); vad.setMuted(true);
  await endAfter(vad, c);
  assert.deepStrictEqual(ev, [['end', 9 * 512, 4, 4]]);
  assert.deepStrictEqual(await endAfter(vad, c), true); assert.deepStrictEqual(ev.slice(1), ['misfire'], 'the older press was let go, not sent on the next release');
  await vad.stop();
});

test('press R1d: a call that ends during the tail of a press hands nothing over (the piece is not sent into a call that is gone)', async () => {
  const { vad, c, ev, o } = await manual();
  vad.setMuted(false); fr(o, 40, 1); vad.setMuted(true);
  const p = vad.endPiece(); c.go(50);
  await vad.stop(); c.go(300); await p;
  assert.deepStrictEqual(ev, []);
});

// ── review round 2: the press boundary (a 200 ms admission delay) and the controller's fallback ──
test('press R2a: B requests capture at +100 while A still owns the drain', async () => {
  const { vad, c, ev, o } = await manual();
  vad.setMuted(false);
  fr(o, 9, 1);
  vad.setMuted(true);                         // A released at relative t=0
  const a = vad.endPiece();
  c.go(100);
  vad.setMuted(false);                        // B requested, still muted
  assert.equal(vad.isMuted(), true);
  c.go(20);
  fr(o, 1, 7);                                // A's last frame at +120
  c.go(80);
  await a;
  assert.equal(vad.isMuted(), false);
  fr(o, 9, 2);
  vad.setMuted(true);
  await endAfter(vad, c);
  assert.deepEqual(ev, [
    ['end', 10 * 512, 1, 7],
    ['end', 9 * 512, 2, 2]
  ]);
  await vad.stop();
});

test('press R2b: release of queued B cancels admission without ending A\'s drain', async () => {
  const { vad, c, ev, o } = await manual();
  vad.setMuted(false);
  fr(o, 9, 1);
  vad.setMuted(true);
  const a = vad.endPiece();
  c.go(100);
  vad.setMuted(false);
  c.go(10);
  vad.setMuted(true);
  await vad.endPiece();
  c.go(10);
  fr(o, 1, 7);
  c.go(100);
  await a;
  assert.equal(vad.isMuted(), true);
  assert.deepEqual(ev, ['misfire', ['end', 10 * 512, 1, 7]]);
  await vad.stop();
});

test('press R2c: an older untaken press is never submitted late', async () => {
  const { vad, c, ev, o } = await manual();
  vad.setMuted(false);
  fr(o, 9, 1);
  vad.setMuted(true);
  c.go(250);
  vad.setMuted(false);
  fr(o, 9, 2);
  vad.setMuted(true);
  await endAfter(vad, c);
  await vad.endPiece();
  assert.deepEqual(ev, [['end', 9 * 512, 2, 2], 'misfire']);
  // added: a press queued and released inside A's tail was never admitted: audio arriving in that tail is not taken into it (it sends nothing, 'misfire')
  ev.length = 0;
  vad.setMuted(false);
  fr(o, 9, 3);
  vad.setMuted(true);
  c.go(50);
  vad.setMuted(false);
  c.go(10);
  vad.setMuted(true);
  fr(o, 9, 7);
  await endAfter(vad, c);
  assert.deepEqual(ev, ['misfire']);
  await vad.stop();
});

test('press R2d: stop during drain invalidates both A and queued B', async () => {
  const { vad, c, ev, o } = await manual();
  vad.setMuted(false);
  fr(o, 9, 1);
  vad.setMuted(true);
  const a = vad.endPiece();
  c.go(100);
  vad.setMuted(false);
  await vad.stop();
  c.go(300);
  await a;
  assert.deepEqual(ev, []);
  assert.equal(vad.isMuted(), true);
});

test('press R2e: talk(true) during a previous press\'s tail runs onSpeechBegin and onSpeechStart once for that press, when the tail ends; the recorder starts once', async () => {
  const { b, win, loadScript } = fakeBrowser();
  const c = clock(), n = { begin: 0, start: 0 };
  const real = voiceCreateVad({ manual: true, win, loadScript, echoHoldMs: 0, ...c.opts });
  assert.strictEqual(real.manual, true, 'the adapter says it reports the start itself');
  const vad = Object.create(real);
  vad.start = (hd) => real.start({ ...hd, onSpeechBegin: () => { n.begin++; return hd.onSpeechBegin(); }, onSpeechStart: () => { n.start++; return hd.onSpeechStart(); } });
  const rec = [];
  const h = await started({ vad, recorder: { begin: () => rec.push('begin'), drop: () => rec.push('drop'), end: () => { rec.push('end'); return { seq: Promise.resolve(1) }; }, stop() {} }, stt: async () => 'words' });
  const o = b.created[0].options; await o.getStream();
  h.call.talk(true); assert.deepStrictEqual([n.begin, n.start, rec.length], [1, 1, 1], 'press A: one begin, one start');
  for (let i = 0; i < 20; i++) frames(o, 1);
  h.call.talk(false); await tick(10);                 // A released: it is in its 200 ms tail
  assert.strictEqual(h.call.talk(true), true);        // B pressed inside A's tail
  await tick(10);
  assert.deepStrictEqual([n.begin, n.start], [1, 1], 'B is not admitted yet: nothing was reported (the controller does not fake it)');
  assert.strictEqual(b.track.enabled, false, 'the microphone stays off until A\'s tail ends');
  c.go(200); await tick(40);                          // A's tail ends: B is admitted; A's piece is handed over
  assert.deepStrictEqual([n.begin, n.start], [2, 2], 'B: exactly one begin and one start');
  assert.strictEqual(b.track.enabled, true);
  const begins = rec.filter((x) => x === 'begin').length;
  assert.ok(begins >= 1 && begins <= 2, 'the recorder began A and at most once more for B: ' + rec.join());
  c.go(1000); await tick(40);
  assert.deepStrictEqual([n.begin, n.start], [2, 2], 'nothing runs a second time later');
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
