'use strict';
// Voice fixes 1 (2026-11-12), controller and VAD adapter: (1) a person's sentence cut in pieces by a pause is joined into one
// message, with a stop word winning; the end-of-turn pause reaches MicVAD (redemptionMs) and can change live; (4) tool activity
// is shown silently, never spoken by default, and at most one "Still working on it." comes after 20 s of silence.
// Fake clock, fake vad, fake server and a speech-to-text that answers when the test says so.
const { test } = require('node:test');
const assert = require('node:assert');
Object.assign(globalThis, require('../lib/ui-voice'));   // the call file uses these helpers as globals, like the pages
const { voiceCreateCall, voiceCreateVad, VOICE_THINKING_LINES } = require('../lib/ui-voice-call');

const tick = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function harness(over) {
  const h = { t: 0, timers: [], nextId: 1, spoken: [], pend: [], sent: [], interjected: [], stops: 0, running: false, activity: [], heard: [], gates: [] };
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
  h.handlers = null;
  // the speech-to-text of a segment answers when the test calls h.answer(); with h.autoStt it answers at once
  h.stt = (audio) => (h.autoStt ? Promise.resolve(audio.text) : new Promise((res) => h.gates.push(() => res(audio.text))));
  h.answer = async () => { const g = h.gates.shift(); if (g) g(); await tick(); };
  h.deps = {
    agent: 'a1', now: () => h.t, setTimer: h.setTimer, clearTimer: h.clearTimer, prefs: () => ({ continueWait: 0 }),   // 0: these tests send short texts and must not wait for more (ui-voice-call-continue.test.js tests the wait)
    vad: { start: async (hd) => { h.handlers = hd; }, stop() {}, setPlaybackActive() {} },
    stt: h.stt, isTurnRunning: () => h.running,
    send: async (t) => { h.sent.push(t); h.running = true; }, interject: async (t) => { h.interjected.push(t); },
    stop: () => { h.stops++; }, speak: h.speak, cancelSpeech: () => { const r = h.pend.shift(); if (r) r(false); }, answerAsk() {},
    server: { start: async () => ({ callId: 'c1', held: [] }), heartbeat: async () => ({ held: [] }), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} },
    ui: { state() {}, heard: (t) => h.heard.push(t), held() {}, toast() {}, summary() {}, level() {}, activity: (t) => h.activity.push(t) },
  };
  Object.assign(h.deps, over || {});
  h.call = voiceCreateCall(h.deps);
  // one speech segment: starts now (real start), ends now with the given text as its audio
  h.begin = () => h.handlers.onSpeechStart();
  h.end = (text) => { h.handlers.onSpeechEnd({ text }); return tick(); };
  return h;
}
async function started(over) { const h = harness(over); assert.strictEqual(await h.call.start(), true); return h; }

// ---- (1) joining the pieces of one sentence ----

test('join: a segment that starts within 2 s of the previous one, which is still being transcribed, is sent as one message', async () => {
  const h = await started();
  h.begin(); await h.end('turn on the light');           // segment A ends at t = 0, its text is not back yet
  await h.advance(1000);
  h.begin(); await h.end('in the kitchen');              // segment B starts 1 s later
  await h.answer(); await h.answer();                    // A's text, then B's
  assert.deepStrictEqual(h.sent, ['turn on the light in the kitchen']);
  assert.deepStrictEqual(h.interjected, []);
  assert.deepStrictEqual(h.heard, ['turn on the light in the kitchen']);
});

test('join: three pieces in a row become one message', async () => {
  const h = await started();
  h.begin(); await h.end('one');
  await h.advance(1500); h.begin(); await h.end('two');
  await h.advance(1500); h.begin(); await h.end('three');
  await h.answer(); await h.answer(); await h.answer();
  assert.deepStrictEqual(h.sent, ['one two three']);
});

test('join: not when the previous piece was already sent; a slow transcript (2.5 s later, still pending) is still joined', async () => {
  let h = await started();
  h.autoStt = true;
  h.begin(); await h.end('first thing'); await tick();
  assert.deepStrictEqual(h.sent, ['first thing']);
  await h.advance(500); h.begin(); await h.end('second thing'); await tick();
  assert.deepStrictEqual(h.sent, ['first thing']);
  assert.deepStrictEqual(h.interjected, ['second thing'], 'a turn is running: the second one is its own interjection');
  h = await started();
  h.begin(); await h.end('slow piece');
  await h.advance(2500);                                  // more than 2 s later, its text is still not back
  h.begin(); await h.end('another piece');
  await h.answer(); await h.answer();
  assert.deepStrictEqual(h.sent, ['slow piece another piece'], 'its text was still unsent: one chain');
  assert.deepStrictEqual(h.interjected, []);
});

test('join: while a turn runs, the joined text is one interjection', async () => {
  const h = await started();
  h.running = true;
  h.begin(); await h.end('and also');
  await h.advance(800); h.begin(); await h.end('check the logs');
  await h.answer(); await h.answer();
  assert.deepStrictEqual(h.interjected, ['and also check the logs']);
  assert.deepStrictEqual(h.sent, []);
});

test('join: a stop word in either piece wins and is not merged', async () => {
  let h = await started();
  h.begin(); await h.end('stop');
  await h.advance(700); h.begin(); await h.end('and then tell me the time');
  await h.answer(); await h.answer();
  assert.strictEqual(h.stops, 1, 'the first piece was a stop command');
  assert.ok(!h.sent.some(t => /stop/.test(t)), 'stop was not glued into a message');
  h = await started();
  h.begin(); await h.end('delete everything in the folder');
  await h.advance(700); h.begin(); await h.end('stop');
  await h.answer(); await h.answer();
  assert.strictEqual(h.stops, 1, 'the second piece was a stop command');
  assert.deepStrictEqual(h.sent, [], 'the held piece is dropped: stop wins');
});

test('join: a false start (misfire) releases the held piece, which is sent on its own', async () => {
  const h = await started();
  h.begin(); await h.end('hello there');
  await h.advance(500);
  h.handlers.onSpeechBegin();                             // a candidate start...
  h.handlers.onMisfire();                                 // ...that was nothing
  await h.answer();
  assert.deepStrictEqual(h.sent, ['hello there']);
});

test('join: a piece that is only a filler does not hold back the earlier one', async () => {
  const h = await started();
  h.begin(); await h.end('open the door');
  await h.advance(500); h.begin(); await h.end('um');
  await h.answer(); await h.answer();
  assert.deepStrictEqual(h.sent, ['open the door']);
});

test('join: a later piece joins an earlier one whose text is not back yet, even after 2 s', async () => {
  const h = await started();
  h.begin(); await h.end('alpha');
  await h.advance(2100);
  h.begin(); await h.end('beta');
  await h.answer(); await h.answer();
  assert.deepStrictEqual(h.sent, ['alpha beta']);
});

// ---- (4) no spoken tool activity ----

test('activity: shown silently in the bar and never spoken by default', async () => {
  const h = await started(); h.autoStt = true;
  h.begin(); await h.end('do the thing'); await tick();
  h.call.onActivity({ tool: 'Bash' });
  await h.advance(1000);
  h.call.onActivity({ tool: 'Read' });
  h.call.onActivity({ tool: 'WebSearch' });
  assert.deepStrictEqual(h.spoken, [], 'nothing is spoken');
  assert.deepStrictEqual(h.activity, ['Running a command.', 'Reading a file.', 'Searching the web.']);
  h.call.onReplyText('All done.', true);
  assert.strictEqual(h.activity[h.activity.length - 1], '', 'the activity line is cleared when the turn ends');
});

test('activity: with speakActivity on, the old spoken lines come back', async () => {
  const h = await started({ speakActivity: () => true }); h.autoStt = true;
  h.begin(); await h.end('do the thing'); await tick();
  h.call.onActivity({ tool: 'Bash' });
  assert.deepStrictEqual(h.spoken, ['Running a command.']);
});

test('activity: nothing shown or spoken when no turn is running', async () => {
  const h = await started();
  h.call.onActivity({ tool: 'Bash' });
  assert.deepStrictEqual(h.activity, []);
  assert.deepStrictEqual(h.spoken, []);
});

test('still working: one "Still working on it." after 20 s of silence, not again until something new was said', async () => {
  const h = await started(); h.autoStt = true;
  h.begin(); await h.end('long task please'); await tick();
  await h.advance(19000);
  assert.deepStrictEqual(h.spoken, [], 'not before 20 s');
  await h.advance(1500);
  const L = VOICE_THINKING_LINES;
  assert.strictEqual(h.spoken.length, 1); assert.ok(L.includes(h.spoken[0]), 'one of the thinking lines');
  assert.ok(!h.spoken.includes('Still working on it.'), 'round 1 line is gone');
  const first = h.spoken[0];
  await h.finish();
  await h.advance(120000);
  assert.deepStrictEqual(h.spoken, [first], 'not again while nothing new was said');
  h.call.onReplyText('First part is ready. ', false);    // something new is spoken
  await tick();
  assert.deepStrictEqual(h.spoken, [first, 'First part is ready.']);
  await h.finish();
  await h.advance(19000);
  assert.strictEqual(h.spoken.length, 2);
  await h.advance(1500);
  assert.strictEqual(h.spoken.length, 3, 'allowed again after something new was said');
  assert.ok(L.includes(h.spoken[2]) && h.spoken[2] !== first, 'a different line in the same wait: never twice');
});

test('still working: nothing once the reply is done, and not while the person is speaking', async () => {
  let h = await started(); h.autoStt = true;
  h.begin(); await h.end('quick one'); await tick();
  h.call.onReplyText('Done.', true);
  await h.finish();
  await h.advance(60000);
  assert.deepStrictEqual(h.spoken, ['Done.']);
  h = await started(); h.autoStt = true;
  h.begin(); await h.end('another task'); await tick();
  await h.advance(15000);
  h.begin();                                              // the person is talking when the 20 s are up
  await h.advance(10000);
  assert.deepStrictEqual(h.spoken, [], 'not over the person');
});

test('still working: the 20 s count from the last thing spoken, not from the start of the turn', async () => {
  const h = await started(); h.autoStt = true;
  h.begin(); await h.end('talk to me'); await tick();
  await h.advance(10000);
  h.call.onReplyText('Here is a start. ', false); await tick();
  await h.finish();
  await h.advance(15000);
  assert.deepStrictEqual(h.spoken, ['Here is a start.'], '15 s after the last spoken line is too early');
  await h.advance(6000);
  assert.strictEqual(h.spoken.length, 2); assert.strictEqual(h.spoken[0], 'Here is a start.'); assert.ok(VOICE_THINKING_LINES.includes(h.spoken[1]));
});

// ---- the VAD adapter: end-of-turn pause ----

function fakeBrowser() {
  const b = { created: [] };
  class Gain { constructor() { this.gain = { value: 1 }; } connect() {} }
  class Ctx {
    constructor() { this.state = 'running'; } async resume() {} async close() {}
    createMediaStreamSource() { return { connect() {} }; } createGain() { return new Gain(); } createMediaStreamDestination() { return { stream: {} }; }
  }
  class MicVAD {
    static async new(options) { const v = new MicVAD(); v.options = options; v.setOptionsCalls = []; b.created.push(v); return v; }
    async start() {} async destroy() {} setOptions(u) { this.setOptionsCalls.push(u); }
  }
  const win = { AudioContext: Ctx, vad: { MicVAD }, navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } } };
  return { b, win };
}

test('vad: the end-of-turn pause is redemptionMs (default 1200; 800 and 2000 allowed; anything else = 1200)', async () => {
  for (const [given, want] of [[undefined, 1200], [800, 800], [1200, 1200], [2000, 2000], [384, 1200], ['x', 1200]]) {
    const { b, win } = fakeBrowser();
    const vad = voiceCreateVad({ win, endPause: given });
    await vad.start({});
    assert.strictEqual(b.created[0].options.redemptionMs, want, String(given));
    await vad.stop();
  }
});

test('vad: setEndPause changes redemptionMs live; barge-in still fires on the real start with no delay', async () => {
  const { b, win } = fakeBrowser();
  const vad = voiceCreateVad({ win, endPause: 1200 });
  const events = [];
  await vad.start({ onSpeechStart: () => events.push('start'), onSpeechEnd: () => events.push('end') });
  const m = b.created[0];
  vad.setEndPause(2000);
  assert.deepStrictEqual(m.setOptionsCalls[m.setOptionsCalls.length - 1], { redemptionMs: 2000 });
  vad.setEndPause(800);
  assert.deepStrictEqual(m.setOptionsCalls[m.setOptionsCalls.length - 1], { redemptionMs: 800 });
  vad.setEndPause(5);
  assert.deepStrictEqual(m.setOptionsCalls[m.setOptionsCalls.length - 1], { redemptionMs: 1200 }, 'an unknown value is the normal pause');
  m.options.onSpeechRealStart();
  assert.deepStrictEqual(events, ['start'], 'speech start reaches the controller at once, the pause only delays the end');
  await vad.stop();
  vad.setEndPause(2000);   // harmless after stop
});

test('join: a later piece whose end never comes (audio interrupted) does not hold the earlier text for more than 5 s', async () => {
  const h = await started();
  h.begin(); await h.end('turn on the light');
  await h.advance(1000);
  h.begin();                                             // the next piece starts, and its end never arrives
  await h.answer();                                      // the first text is back and waits for the next piece
  assert.deepStrictEqual(h.sent, []);
  await h.advance(5100);
  assert.deepStrictEqual(h.sent, ['turn on the light'], 'sent on its own after at most 5 s');
});
