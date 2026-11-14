'use strict';
// After "Reconnected.", "Say that again." is spoken when speech was dropped during the outage.
const { test } = require('node:test');
const assert = require('node:assert');
Object.assign(globalThis, require('../lib/ui-voice'));
const { voiceCreateCall } = require('../lib/ui-voice-call');
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function harness(opts = {}) {
  const h = { spoken: [], pend: [], sent: [] };
  h.deps = {
    ...(opts.wake ? { wake: () => ({ local: true, phrase: 'hey maestro' }) } : {}),
    agent: 'a1', now: () => 0, setTimer: () => 1, clearTimer() {}, prefs: () => ({ continueWait: 0 }),
    vad: { start: async (hd) => { h.hd = hd; }, stop() {}, setPlaybackActive() {} },
    stt: async (audio) => { if (audio.gate) await audio.gate; return audio.text; }, isTurnRunning: () => false,
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

const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

test('reconnect: STT in flight when the outage begins, stale when it resolves -> "Reconnected." + "Say that again."', async () => {
  const h = harness(); await h.call.start();
  const g = gate();
  h.hd.onSpeechStart(); h.hd.onSpeechEnd({ text: 'in flight', gate: g.p }); await tick();
  h.call.setLinkLost(true); h.call.setLinkLost(false); await tick();
  g.open(); await tick();
  await h.finish(); await h.finish();
  assert.deepStrictEqual(h.spoken, ['Reconnected.', 'Say that again.']);
  assert.deepStrictEqual(h.sent, []);
});

test('reconnect: speech begun during the outage and ended after recovery -> both lines', async () => {
  const h = harness(); await h.call.start();
  h.call.setLinkLost(true);
  h.hd.onSpeechStart(); await tick();
  h.call.setLinkLost(false); await tick();
  assert.deepStrictEqual(h.spoken, []);   // the person is still talking: the line waits
  h.hd.onSpeechEnd({ text: 'half heard' }); await tick();
  await h.finish(); await h.finish();
  assert.deepStrictEqual(h.spoken, ['Reconnected.', 'Say that again.']);
  assert.deepStrictEqual(h.sent, []);
});

test('reconnect: speech being said when the outage begins (ends during it) -> both lines', async () => {
  const h = harness(); await h.call.start();
  h.hd.onSpeechStart();
  h.call.setLinkLost(true);
  h.hd.onSpeechEnd({ text: 'cut off' }); await tick();
  h.call.setLinkLost(false); await tick();
  await h.finish(); await h.finish();
  assert.deepStrictEqual(h.spoken, ['Reconnected.', 'Say that again.']);
});

test('reconnect: a stale transcript from outage 1 resolving in a quiet outage 2 does not mark outage 2', async () => {
  const h = harness(); await h.call.start();
  const g = gate();
  h.hd.onSpeechStart(); h.hd.onSpeechEnd({ text: 'old', gate: g.p }); await tick();
  h.call.setLinkLost(true); h.call.setLinkLost(false); await tick();
  await h.finish(); await h.finish();
  assert.deepStrictEqual(h.spoken, ['Reconnected.', 'Say that again.']);
  h.call.setLinkLost(true);   // outage 2: quiet
  g.open(); await tick();   // the stale transcript of outage 1 resolves now
  h.call.setLinkLost(false); await tick();
  await h.finish(); await tick();
  assert.deepStrictEqual(h.spoken, ['Reconnected.', 'Say that again.', 'Reconnected.']);
});

test('reconnect: standby speech during the outage (wake phrase on, nothing matched) -> only "Reconnected."', async () => {
  const h = harness({ wake: true }); await h.call.start(); h.call.wakeChanged(); await tick();
  assert.strictEqual(h.call.isStandby(), true);
  h.call.setLinkLost(true);
  await h.say('just talking in the room');
  h.hd.onSpeechStart(); await tick();   // and one still going at recovery
  h.call.setLinkLost(false); await tick();
  h.hd.onSpeechEnd({ text: 'more room talk' }); await tick();   // the line waited for it to end
  await h.finish(); await tick();
  assert.deepStrictEqual(h.spoken, ['Reconnected.']);
});

test('reconnect: the person speaks again right after "Reconnected." -> "Say that again." is not spoken', async () => {
  const h = harness(); await h.call.start();
  h.call.setLinkLost(true); await h.say('lost words'); h.call.setLinkLost(false); await tick();
  assert.deepStrictEqual(h.spoken, ['Reconnected.']);
  h.hd.onSpeechStart(); await tick();   // already repeating
  h.hd.onSpeechEnd({ text: 'lost words again' }); await tick();
  await h.finish(); await tick();
  assert.deepStrictEqual(h.spoken.filter(s => s === 'Say that again.'), []);
  assert.deepStrictEqual(h.sent, ['lost words again']);
});

test('reconnect: a give-up (the call ends) says neither', async () => {
  const h = harness(); await h.call.start();
  h.call.setLinkLost(true); await h.say('lost words');
  h.call.release && h.call.release('link');
  h.call.setLinkLost(false); await tick();
  assert.deepStrictEqual(h.spoken, []);
});
