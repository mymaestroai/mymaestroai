'use strict';
// After "Reconnected.", "Say that again." is spoken when speech was dropped during the outage.
const { test } = require('node:test');
const assert = require('node:assert');
Object.assign(globalThis, require('../lib/ui-voice'));
const { voiceCreateCall } = require('../lib/ui-voice-call');
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function harness() {
  const h = { spoken: [], pend: [], sent: [] };
  h.deps = {
    agent: 'a1', now: () => 0, setTimer: () => 1, clearTimer() {}, prefs: () => ({ continueWait: 0 }),
    vad: { start: async (hd) => { h.hd = hd; }, stop() {}, setPlaybackActive() {} },
    stt: async (audio) => audio.text, isTurnRunning: () => false,
    send: async (t) => { h.sent.push(t); }, interject: async () => {}, stop() {},
    speak: (text) => new Promise((resolve) => { h.spoken.push(text); h.pend.push(resolve); }),
    cancelSpeech() { const r = h.pend.shift(); if (r) r(false); }, answerAsk() {},
    server: { start: async () => ({ callId: 'c1', held: [] }), heartbeat: async () => ({ held: [] }), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} },
    ui: { state() {}, heard() {}, held() {}, toast() {}, summary() {} },
  };
  h.call = voiceCreateCall(h.deps);
  h.say = async (text) => { h.hd.onSpeechStart(); h.hd.onSpeechEnd({ text }); await tick(); };
  h.finish = async () => { const r = h.pend.shift(); if (r) r(true); await tick(); };
  return h;
}

test('reconnect: an utterance dropped during the outage -> "Reconnected." then "Say that again."', async () => {
  const h = harness(); await h.call.start();
  h.call.setLinkLost(true);
  await h.say('are you still there');
  h.call.setLinkLost(false); await tick();
  assert.deepStrictEqual(h.spoken, ['Reconnected.']);
  await h.finish();
  assert.deepStrictEqual(h.spoken, ['Reconnected.', 'Say that again.']);
  assert.deepStrictEqual(h.sent, []);
});

test('reconnect: nothing heard during the outage -> only "Reconnected."', async () => {
  const h = harness(); await h.call.start();
  h.call.setLinkLost(true); h.call.setLinkLost(false); await tick();
  await h.finish(); await tick();
  assert.deepStrictEqual(h.spoken, ['Reconnected.']);
});

test('reconnect: two outages, speech only in the first -> the second says only "Reconnected."', async () => {
  const h = harness(); await h.call.start();
  h.call.setLinkLost(true); await h.say('lost words'); h.call.setLinkLost(false); await tick();
  await h.finish(); await h.finish();
  assert.deepStrictEqual(h.spoken, ['Reconnected.', 'Say that again.']);
  h.call.setLinkLost(true); h.call.setLinkLost(false); await tick();
  await h.finish(); await tick();
  assert.deepStrictEqual(h.spoken, ['Reconnected.', 'Say that again.', 'Reconnected.']);
});

test('reconnect: speech dropped in an earlier outage does not carry to a quiet later one', async () => {
  const h = harness(); await h.call.start();
  h.call.setLinkLost(true); await h.say('lost words'); h.call.setLinkLost(true);   // same outage, repeated report
  h.call.setLinkLost(false); await tick();
  assert.deepStrictEqual(h.spoken, ['Reconnected.']);
  await h.finish(); await h.finish();
  assert.deepStrictEqual(h.spoken, ['Reconnected.', 'Say that again.']);
});

test('reconnect: a give-up (the call ends) says neither', async () => {
  const h = harness(); await h.call.start();
  h.call.setLinkLost(true); await h.say('lost words');
  h.call.release && h.call.release('link');
  h.call.setLinkLost(false); await tick();
  assert.deepStrictEqual(h.spoken, []);
});
