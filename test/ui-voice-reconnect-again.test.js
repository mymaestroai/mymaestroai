'use strict';
// After "Reconnected.", "Say that again." is spoken when a sendable piece's transcription FAILED (d.stt threw) while the link was lost or an outage touched it.
// A piece whose transcript arrived is never dropped for the link state (it is sent as usual) and never sets "Say that again." (link-flaps change).
// h.down = the requests fail (a real outage): the stt throws a TypeError until it is cleared. h.lose() / h.back() flip it together with setLinkLost.
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
    stt: async (audio) => { if (audio.gate) await audio.gate; if (audio.fail || h.down) throw new TypeError('Failed to fetch'); return audio.text; }, isTurnRunning: () => false,
    send: async (t) => { h.sent.push(t); }, interject: async () => {}, stop() {},
    speak: (text) => new Promise((resolve) => { h.spoken.push(text); h.pend.push(resolve); }),
    cancelSpeech() { const r = h.pend.shift(); if (r) r(false); }, answerAsk() {},
    server: { start: async () => ({ callId: 'c1', held: [] }), heartbeat: async () => ({ held: [] }), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} },
    ui: { state() {}, heard() {}, held() {}, toast() {}, summary() {} },
  };
  h.call = voiceCreateCall(h.deps);
  h.say = async (text) => { h.hd.onSpeechStart(); h.hd.onSpeechEnd({ text }); await tick(); };
  h.lose = () => { h.down = true; h.call.setLinkLost(true); };
  h.back = async () => { h.down = false; h.call.setLinkLost(false); await tick(); };
  h.finish = async () => { const r = h.pend.shift(); if (r) r(true); await tick(); };
  return h;
}

test('reconnect: an utterance dropped during the outage -> "Reconnected." then "Say that again."', async () => {
  const h = harness(); await h.call.start();
  h.lose();   // requests fail during the outage: the transcription throws
  await h.say('are you still there');
  await h.back();
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
  h.lose(); await h.say('lost words'); await h.back();
  await h.finish(); await h.finish();
  assert.deepStrictEqual(h.spoken, ['Reconnected.', 'Say that again.']);
  h.call.setLinkLost(true); h.call.setLinkLost(false); await tick();
  await h.finish(); await tick();
  assert.deepStrictEqual(h.spoken, ['Reconnected.', 'Say that again.', 'Reconnected.']);
});

test('reconnect: speech dropped in an earlier outage does not carry to a quiet later one', async () => {
  const h = harness(); await h.call.start();
  h.lose(); await h.say('lost words'); h.call.setLinkLost(true);   // same outage, repeated report
  await h.back();
  assert.deepStrictEqual(h.spoken, ['Reconnected.']);
  await h.finish(); await h.finish();
  assert.deepStrictEqual(h.spoken, ['Reconnected.', 'Say that again.']);
});

const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

// Review note (link flaps): this used to pin "stale when it resolves -> dropped" even when STT answered; the transcript that arrives is now sent (next test).
test('reconnect: STT in flight when the outage begins, then it THROWS after the link is back -> "Reconnected." + "Say that again."', async () => {
  const h = harness(); await h.call.start();
  const g = gate();
  h.hd.onSpeechStart(); h.hd.onSpeechEnd({ text: 'in flight', gate: g.p, fail: true }); await tick();
  h.call.setLinkLost(true); h.call.setLinkLost(false); await tick();
  g.open(); await tick();
  await h.finish(); await h.finish();
  assert.deepStrictEqual(h.spoken, ['Reconnected.', 'Say that again.']);
  assert.deepStrictEqual(h.sent, []);
});

test('reconnect: STT in flight when the outage begins and it ANSWERS with text after the link is back -> sent, only "Reconnected."', async () => {
  const h = harness(); await h.call.start();
  const g = gate();
  h.hd.onSpeechStart(); h.hd.onSpeechEnd({ text: 'in flight', gate: g.p }); await tick();
  h.call.setLinkLost(true); h.call.setLinkLost(false); await tick();
  g.open(); await tick();
  await h.finish(); await h.finish(); await tick();
  assert.deepStrictEqual(h.spoken, ['Reconnected.']);
  assert.deepStrictEqual(h.sent, ['in flight']);
});

test('reconnect: speech begun during the outage and ended after recovery, STT throws -> both lines', async () => {
  const h = harness(); await h.call.start();
  h.call.setLinkLost(true);
  h.hd.onSpeechStart(); await tick();
  h.call.setLinkLost(false); await tick();
  assert.deepStrictEqual(h.spoken, []);   // the person is still talking: the line waits
  h.hd.onSpeechEnd({ text: 'half heard', fail: true }); await tick();
  await h.finish(); await h.finish();
  assert.deepStrictEqual(h.spoken, ['Reconnected.', 'Say that again.']);
  assert.deepStrictEqual(h.sent, []);
});

test('reconnect: speech being said when the outage begins (ends during it, STT throws) -> both lines', async () => {
  const h = harness(); await h.call.start();
  h.hd.onSpeechStart();
  h.lose();
  h.hd.onSpeechEnd({ text: 'cut off' }); await tick();
  await h.back();
  await h.finish(); await h.finish();
  assert.deepStrictEqual(h.spoken, ['Reconnected.', 'Say that again.']);
});

// Review note (link flaps): used to expect "Say that again." for outage 1 (the stale piece was dropped). Now the transcript that arrives is sent,
// so neither outage says it.
test('reconnect: a transcript from before outage 1 resolving in a quiet outage 2 is sent and marks neither outage', async () => {
  const h = harness(); await h.call.start();
  const g = gate();
  h.hd.onSpeechStart(); h.hd.onSpeechEnd({ text: 'old', gate: g.p }); await tick();
  h.call.setLinkLost(true); h.call.setLinkLost(false); await tick();
  await h.finish();
  assert.deepStrictEqual(h.spoken, ['Reconnected.']);
  h.call.setLinkLost(true);   // outage 2: quiet
  g.open(); await tick();   // the transcript resolves now: sent
  h.call.setLinkLost(false); await tick();
  await h.finish(); await tick();
  assert.deepStrictEqual(h.spoken, ['Reconnected.', 'Reconnected.']);
  assert.deepStrictEqual(h.sent, ['old']);
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
  h.lose(); await h.say('lost words'); await h.back();
  assert.deepStrictEqual(h.spoken, ['Reconnected.']);
  h.hd.onSpeechStart(); await tick();   // already repeating
  h.hd.onSpeechEnd({ text: 'lost words again' }); await tick();
  await h.finish(); await tick();
  assert.deepStrictEqual(h.spoken.filter(s => s === 'Say that again.'), []);
  assert.ok(h.spoken.includes('Reconnected.'));   // "Reconnected." itself is still spoken
  assert.deepStrictEqual(h.sent, ['lost words again']);
});

test('reconnect: an accepted interjection still awaiting its response when an outage starts and ends -> only "Reconnected."', async () => {
  const h = harness(); await h.call.start();
  const g = gate(); h.interjected = [];
  h.deps.isTurnRunning = () => true;   // a turn is running: the utterance is an interjection
  h.deps.interject = (t) => { h.interjected.push(t); return g.p; };   // slow response, resolved later
  await h.say('actually make it blue');
  assert.deepStrictEqual(h.interjected, ['actually make it blue']);   // handed off to route()
  h.call.setLinkLost(true); h.call.setLinkLost(false); await tick();   // the whole outage happens before it resolves
  g.open(); await tick();
  await h.finish(); await h.finish(); await tick();
  assert.deepStrictEqual(h.spoken, ['Reconnected.']);   // it was accepted, so nothing to repeat
});

test('reconnect: a long utterance begun in outage 1, going on across recovery and into outage 2 -> "Say that again." once per outage', async () => {
  const h = harness(); await h.call.start();
  h.call.setLinkLost(true);
  h.hd.onSpeechStart(); await tick();   // begun during outage 1 (segLinkGen -1)
  h.call.setLinkLost(false); await tick();   // recovery 1 counts it: "Reconnected." + "Say that again." queue (the person is still talking)
  h.call.setLinkLost(true);   // outage 2 begins: the speech is not counted again at the start (it began in outage 1)
  h.call.setLinkLost(false); await tick();   // recovery 2: it is still going and is lost for this outage too
  h.hd.onSpeechEnd({ text: 'a very long story' }); await tick();
  for (let i = 0; i < 6; i++) await h.finish();
  // Review note (link flaps): its transcript arrived (STT answered), so it is sent and nothing says "Say that again." (it used to: once per outage).
  assert.deepStrictEqual(h.spoken, ['Reconnected.', 'Reconnected.']);
  assert.deepStrictEqual(h.sent, ['a very long story']);
});

test('reconnect: a long utterance across two outages whose STT throws -> "Say that again." once (one piece, one failure)', async () => {
  const h = harness(); await h.call.start();
  h.call.setLinkLost(true);
  h.hd.onSpeechStart(); await tick();
  h.call.setLinkLost(false); await tick();
  h.call.setLinkLost(true); h.call.setLinkLost(false); await tick();
  h.hd.onSpeechEnd({ text: 'a very long story', fail: true }); await tick();
  for (let i = 0; i < 6; i++) await h.finish();
  assert.deepStrictEqual(h.spoken.filter(s => s === 'Say that again.'), ['Say that again.']);
  assert.deepStrictEqual(h.sent, []);
});

test('reconnect: STT throws while the link is lost, the call recovers before the next piece -> sent as usual afterwards', async () => {
  const h = harness(); await h.call.start();
  h.lose(); await h.say('lost words'); await h.back();
  await h.finish(); await h.finish();
  await h.say('next words');
  assert.deepStrictEqual(h.sent, ['next words']);
});

test('reconnect: STT answers with text while the link is marked lost -> sent, and no "Say that again." after "Reconnected."', async () => {
  const h = harness(); await h.call.start();
  h.call.setLinkLost(true);   // marked lost, but the upload gets through (a slow link)
  await h.say('slow but fine');
  h.call.setLinkLost(false); await tick();
  await h.finish(); await tick();
  assert.deepStrictEqual(h.sent, ['slow but fine']);
  assert.deepStrictEqual(h.spoken, ['Reconnected.']);
});

test('reconnect: the link is marked lost while a piece is in STT and STT then resolves with text -> sent, no "Say that again."', async () => {
  const h = harness(); await h.call.start();
  const g = gate();
  h.hd.onSpeechStart(); h.hd.onSpeechEnd({ text: 'in flight words', gate: g.p }); await tick();
  h.call.setLinkLost(true); await tick();
  g.open(); await tick(); await tick();
  assert.deepStrictEqual(h.sent, ['in flight words'], 'sent although the link is still marked lost');
  h.call.setLinkLost(false); await tick();
  await h.finish(); await h.finish(); await tick();
  assert.deepStrictEqual(h.spoken, ['Reconnected.']);
});

test('reconnect: a give-up (the call ends) says neither', async () => {
  const h = harness(); await h.call.start();
  h.call.setLinkLost(true); await h.say('lost words');
  h.call.release && h.call.release('link');
  h.call.setLinkLost(false); await tick();
  assert.deepStrictEqual(h.spoken, []);
});
