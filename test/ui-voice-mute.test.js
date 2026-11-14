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

test('mute while the person is speaking: the piece is dropped (recorder.drop), a later end sends nothing, muted or after unmute', async () => {
  const h = await started();
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart();
  assert.strictEqual(count(h, 'begin'), 1);
  h.call.setMuted(true);
  assert.strictEqual(count(h, 'drop'), 1, 'dropped like a false start');
  h.handlers.onSpeechEnd({ text: 'half a sentence' }); await tick();
  assert.deepStrictEqual(h.stt, []); assert.deepStrictEqual(h.sent, []);
  h.call.setMuted(false);
  h.handlers.onSpeechEnd({ text: 'the tail of it' }); await tick();
  assert.deepStrictEqual(h.stt, [], 'a piece begun before the mute is never sent');
  assert.deepStrictEqual(h.sent, []);
});

test('mute after only onSpeechBegin (no real start yet) also drops, and the end after unmute is ignored', async () => {
  const h = await started();
  h.handlers.onSpeechBegin();
  h.call.setMuted(true); h.call.setMuted(false);
  h.handlers.onSpeechEnd({ text: 'old piece' }); await tick();
  assert.deepStrictEqual(h.stt, []); assert.deepStrictEqual(h.sent, []);
});

test('mute while a reply was cut by the person: the cut reply reads on (resume) as after a false start', async () => {
  const h = await started();
  h.handlers.onSpeechStart(); h.handlers.onSpeechEnd({ text: 'read it' }); await tick();
  h.call.onReplyText('Sentence one. Sentence two. Sentence three. ', false);
  await advance(h, 5000); h.stt.length = 0; h.sent.length = 0;
  h.handlers.onSpeechBegin(); h.handlers.onSpeechStart(); await tick();
  assert.strictEqual(count(h, 'cancelSpeech'), 1, 'the person cut it');
  h.call.setMuted(true);
  assert.strictEqual(count(h, 'drop'), 1);
  assert.deepStrictEqual(h.stt, []);
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
