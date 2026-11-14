'use strict';
// The wake phrase standby of the hands-free call: the pure helpers (voiceWakeMatch, voiceCleanWakePhrase, the wake prefs,
// voiceIsSleepCommand), the controller's standby (deps.wake / deps.chime) and the chime. Fake clock, fake vad, fake stt.
const { test } = require('node:test');
const assert = require('node:assert');
Object.assign(globalThis, require('../lib/ui-voice'));   // the call file uses these helpers as globals, like the pages
const { voiceCreateCall, voicePlayWakeChime } = require('../lib/ui-voice-call');
const { voiceWakeMatch, voiceCleanWakePhrase, voiceCleanPrefs, voiceWakeForAgent, voiceIsSleepCommand, VOICE_WAKE_QUIET_MS } = require('../lib/ui-voice');

const tick = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

// ---- voiceWakeMatch ----

test('voiceWakeMatch: Hey Watchman', () => {
  const P = 'Hey Watchman';
  const yes = [['hey watchman', ''], ['Hey, Watchman.', ''], ['hey watchmen', ''], ['hey watch man', ''], ['um hey watchman', ''], ['so, hey watchman', ''],
    ['Hey Watchman, is the garage closed?', 'is the garage closed?'], ['hey watchman what time is it', 'what time is it'], ['Hey Watchman! Lights off.', 'Lights off.']];
  for (const [t, rest] of yes) assert.deepStrictEqual(voiceWakeMatch(t, P), { match: true, rest }, t);
  for (const t of ['hey', 'hey there', 'watchman', 'I told the watchman', 'hey what is up', 'Hey Watson', 'pay watchman', '', '   ']) {
    assert.deepStrictEqual(voiceWakeMatch(t, P), { match: false, rest: '' }, t);
  }
});

test('voiceWakeMatch: other phrases', () => {
  assert.deepStrictEqual(voiceWakeMatch('Computer, what time is it?', 'Computer'), { match: true, rest: 'what time is it?' });
  assert.strictEqual(voiceWakeMatch('computers what time', 'Computer').match, true);
  assert.strictEqual(voiceWakeMatch('my computer is slow', 'Computer').match, false);
  assert.strictEqual(voiceWakeMatch('hey doc', 'Hey Doc').match, true);
  assert.strictEqual(voiceWakeMatch('hey dog', 'Hey Doc').match, false, 'six letters: no slack');
  // 'heymystro' (3 words joined) is 2 edits from 'heymaestro' and the limit at 10 letters is 1
  assert.strictEqual(voiceWakeMatch('hey my stro', 'Hey Maestro').match, false);
  assert.strictEqual(voiceWakeMatch('hey maestro', 'Hey Maestro').match, true);
  assert.strictEqual(voiceWakeMatch('hey maestra', 'Hey Maestro').match, true, 'one edit at 10 letters');
  assert.deepStrictEqual(voiceWakeMatch('okay computer start', 'Okay Computer'), { match: true, rest: 'start' });
  assert.deepStrictEqual(voiceWakeMatch('um okay computer', 'Okay Computer'), { match: true, rest: '' });
  assert.strictEqual(voiceWakeMatch('computer', 'Okay Computer').match, false);
});

test('voiceWakeMatch: bad input', () => {
  assert.deepStrictEqual(voiceWakeMatch(null, 'Computer'), { match: false, rest: '' });
  assert.deepStrictEqual(voiceWakeMatch(42, 'Computer'), { match: false, rest: '' });
  assert.deepStrictEqual(voiceWakeMatch('computer', ''), { match: false, rest: '' });
  assert.deepStrictEqual(voiceWakeMatch('hey', 'hey'), { match: false, rest: '' }, 'an invalid phrase never matches');
  assert.deepStrictEqual(voiceWakeMatch('computer', undefined), { match: false, rest: '' });
});

// ---- phrase and prefs cleaning ----

test('voiceCleanWakePhrase', () => {
  assert.strictEqual(voiceCleanWakePhrase('Hey Watchman'), 'Hey Watchman');
  assert.strictEqual(voiceCleanWakePhrase('  Hey,   Watchman!  '), 'Hey Watchman');
  assert.strictEqual(voiceCleanWakePhrase('Computer'), 'Computer');
  assert.strictEqual(voiceCleanWakePhrase('Hey Dr. Who'), 'Hey Dr Who');
  assert.strictEqual(voiceCleanWakePhrase('hey'), '');
  assert.strictEqual(voiceCleanWakePhrase('ok hi'), '');
  assert.strictEqual(voiceCleanWakePhrase('hi there you guys now'), '', 'five words');
  assert.strictEqual(voiceCleanWakePhrase('a b c d'), '', 'no word of 3 letters');
  assert.strictEqual(voiceCleanWakePhrase(''), '');
  assert.strictEqual(voiceCleanWakePhrase(null), '');
  assert.strictEqual(voiceCleanWakePhrase('x'.repeat(21)), '', 'a word over 20 letters');
  assert.strictEqual(voiceCleanWakePhrase('hey wat$chman'), '', 'symbols are not letters');
  assert.strictEqual(voiceCleanWakePhrase('Hey Sam\'s'), 'Hey Sam\'s');
  assert.strictEqual(voiceCleanWakePhrase('a'.repeat(20) + ' ' + 'b'.repeat(20) + ' ' + 'c'.repeat(20) + ' d'), '', 'over 60 characters');
});

test('voiceCleanPrefs: wake', () => {
  const base = voiceCleanPrefs(null);
  assert.ok(!('wake' in base), 'the defaults have no wake key');
  assert.ok(!('wake' in voiceCleanPrefs({ micLevel: 20 })));
  assert.ok(!('wake' in voiceCleanPrefs({ wake: 'x' })));
  assert.ok(!('wake' in voiceCleanPrefs({ wake: [1] })));
  assert.ok(!('wake' in voiceCleanPrefs({ wake: null })));
  assert.deepStrictEqual(voiceCleanPrefs({ wake: {} }).wake, {});
  assert.deepStrictEqual(VOICE_WAKE_QUIET_MS, [10000, 20000, 45000]);
  const w = voiceCleanPrefs({ wake: {
    owner: { on: true, phrase: ' Hey  Watchman ', quietMs: 45000 },
    sam: { on: 'yes', phrase: 'hey', quietMs: 5 },
    'bad name': { on: true, phrase: 'Computer', quietMs: 10000 },
    '_x': { on: true, phrase: 'Computer', quietMs: 10000 },
    notobj: 5, arr: [1],
    ['a'.repeat(65)]: { on: true, phrase: 'Computer', quietMs: 10000 },
  } }).wake;
  assert.deepStrictEqual(Object.keys(w).sort(), ['owner', 'sam']);
  assert.deepStrictEqual(w.owner, { on: true, phrase: 'Hey Watchman', quietMs: 45000 });
  assert.deepStrictEqual(w.sam, { on: false, phrase: '', quietMs: 20000 });
  const many = {};
  for (let i = 0; i < 80; i++) many['agent' + i] = { on: true, phrase: 'Computer', quietMs: 10000 };
  assert.strictEqual(Object.keys(voiceCleanPrefs({ wake: many }).wake).length, 50);
  // the other keys are as before
  assert.deepStrictEqual(voiceCleanPrefs({ wake: {}, micLevel: 20 }).micLevel, 20);
  // saved and loaded through storage
  const store = {}; const storage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } };
  voiceSavePrefs(storage, { wake: { owner: { on: true, phrase: 'Computer', quietMs: 10000 } } });
  assert.deepStrictEqual(voiceLoadPrefs(storage).wake.owner, { on: true, phrase: 'Computer', quietMs: 10000 });
});

test('voiceWakeForAgent', () => {
  const prefs = voiceCleanPrefs({ wake: { owner: { on: true, phrase: 'Computer', quietMs: 10000 } } });
  assert.deepStrictEqual(voiceWakeForAgent(prefs, 'owner'), { on: true, phrase: 'Computer', quietMs: 10000 });
  assert.strictEqual(voiceWakeForAgent(prefs, 'sam'), null);
  assert.strictEqual(voiceWakeForAgent({}, 'owner'), null);
  assert.strictEqual(voiceWakeForAgent(null, 'owner'), null);
  assert.strictEqual(voiceWakeForAgent(prefs, undefined), null);
  assert.strictEqual(voiceWakeForAgent(prefs, 'constructor'), null);
});

test('voiceIsSleepCommand', () => {
  for (const s of ['that\'s all', 'That\'s all.', 'that is all', 'Go to sleep', 'go to sleep, thanks', 'that\'s all thank you', 'That’s all!']) assert.strictEqual(voiceIsSleepCommand(s), true, s);
  for (const s of ['that is all I know', 'sleep', 'go to sleep now', 'thanks', '', null, 'stop']) assert.strictEqual(voiceIsSleepCommand(s), false, String(s));
});

// ---- the chime ----

test('voicePlayWakeChime', () => {
  assert.strictEqual(voicePlayWakeChime(null), false);
  assert.strictEqual(voicePlayWakeChime({}), false);
  const osc = [], gains = [];
  const ctx = { currentTime: 1, destination: {},
    createOscillator: () => { const o = { frequency: { value: 0 }, connect() {}, start(t) { o.t = t; }, stop() {} }; osc.push(o); return o; },
    createGain: () => { const calls = []; const g = { gain: { setValueAtTime: (...a) => calls.push(['set', ...a]), linearRampToValueAtTime: (...a) => calls.push(['lin', ...a]), exponentialRampToValueAtTime: (...a) => calls.push(['exp', ...a]) }, connect() {}, calls }; gains.push(g); return g; } };
  assert.strictEqual(voicePlayWakeChime(ctx), true);
  assert.deepStrictEqual(osc.map(o => o.frequency.value), [660, 880]);
  assert.ok(Math.abs((osc[1].t - osc[0].t) - 0.15) < 1e-9, 'the second note starts 110 ms + 40 ms later');
  for (const g of gains) assert.ok(g.calls.some(c => c[0] === 'lin' && c[1] === 0.08), 'peak 0.08');
  assert.strictEqual(voicePlayWakeChime({ createOscillator() { throw new Error('boom'); }, createGain() {} }), false);
});

// ---- the controller ----

function harness(over) {
  const h = { t: 0, timers: [], nextId: 1, states: [], heard: [], sent: [], chimes: 0, sttCalls: 0, spoken: [], pend: [], playing: [], wakeCfg: { phrase: 'Hey Watchman', quietMs: 20000, local: true }, running: false };
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
  h.finish = async () => { const r = h.pend.shift(); if (r) r(true); await tick(); };
  h.vadHandlers = null;
  h.vad = { start: async (hd) => { h.vadHandlers = hd; }, stop() {}, setPlaybackActive: (b) => { h.playing.push(b); } };
  h.deps = {
    agent: 'owner', now: () => h.t, setTimer: h.setTimer, clearTimer: h.clearTimer, prefs: () => ({ micLevel: 50, interruptSensitivity: 50, continueWait: 0 }),
    vad: h.vad, stt: async (audio) => { h.sttCalls++; return audio.text; }, isTurnRunning: () => h.running,
    send: async (t) => { h.sent.push(t); h.running = true; }, interject: async () => {}, stop() {},
    speak: h.speak, cancelSpeech: () => { const r = h.pend.shift(); if (r) r(false); }, answerAsk() {},
    wake: () => h.wakeCfg, chime: () => { h.chimes++; },
    server: { start: async () => ({ callId: 'call-1', held: [] }), heartbeat: async (cid) => ({ callId: cid, held: [] }), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} },
    ui: { state: (n, p) => h.states.push([n, p]), heard: (t) => h.heard.push(t), held() {}, toast() {}, summary() {} },
  };
  Object.assign(h.deps, over || {});
  h.call = voiceCreateCall(h.deps);
  h.last = () => h.states[h.states.length - 1];
  h.say = async (text, len) => { h.vadHandlers.onSpeechStart(); h.vadHandlers.onSpeechEnd(Object.assign(new Float32Array(len || 16000), { text })); await tick(); };
  return h;
}
async function started(over) { const h = harness(over); assert.strictEqual(await h.call.start(), true); return h; }

test('wake absent or null: today\'s behaviour', async () => {
  for (const over of [{ wake: undefined, chime: undefined }, { wake: () => null }]) {
    const h = await started(over);
    assert.strictEqual(h.call.state, 'listening');
    assert.strictEqual(h.call.isStandby(), false);
    await h.say('what time is it');
    assert.deepStrictEqual(h.sent, ['what time is it']);
    assert.deepStrictEqual(h.heard, ['what time is it']);
    assert.ok(!h.states.some(s => s[0] === 'standby'));
    await h.advance(120000);
    assert.notStrictEqual(h.call.state, 'standby', 'no quiet timer without a wake setting');
  }
});

test('wake set: standby after start, non-matching speech is dropped', async () => {
  const h = await started();
  assert.strictEqual(h.call.state, 'standby');
  assert.deepStrictEqual(h.last(), ['standby', 'Hey Watchman']);
  assert.strictEqual(h.call.isStandby(), true);
  await h.say('what time is it');
  await h.say('hey there');
  assert.strictEqual(h.sttCalls, 2);
  assert.deepStrictEqual(h.sent, []);
  assert.deepStrictEqual(h.heard, []);
  assert.strictEqual(h.chimes, 0);
  assert.strictEqual(h.call.state, 'standby');
  assert.ok(!h.states.some(s => s[0] === 'hearing'), 'no hearing state in standby');
});

test('wake phrase with the message in one breath', async () => {
  const h = await started();
  await h.say('Hey Watchman, is the garage closed?');
  assert.strictEqual(h.chimes, 1);
  assert.deepStrictEqual(h.sent, ['is the garage closed?']);
  assert.deepStrictEqual(h.heard, ['is the garage closed?']);
  assert.strictEqual(h.call.isStandby(), false);
  assert.ok(h.playing.includes(true), 'the thresholds are raised for the chime');
  await h.advance(800);
  assert.strictEqual(h.playing[h.playing.length - 1], false, 'and lowered again');
});

test('wake phrase alone: the next utterance is the message', async () => {
  const h = await started();
  await h.say('Hey Watchman.');
  assert.strictEqual(h.chimes, 1);
  assert.deepStrictEqual(h.sent, []);
  assert.deepStrictEqual(h.heard, []);
  assert.strictEqual(h.call.state, 'listening');
  await h.say('what time is it');
  assert.deepStrictEqual(h.sent, ['what time is it']);
  assert.deepStrictEqual(h.heard, ['what time is it']);
  assert.strictEqual(h.chimes, 1);
});

test('back to standby after the quiet time; activity resets it', async () => {
  const h = await started({});
  await h.say('hey watchman, hello');
  assert.deepStrictEqual(h.sent, ['hello']);
  h.call.onReplyText('Hi there. ', true);
  await tick();
  assert.strictEqual(h.call.state, 'speaking');
  await h.advance(60000);
  assert.strictEqual(h.call.state, 'speaking', 'never while a reply is read');
  await h.finish();
  assert.strictEqual(h.call.state, 'listening');
  await h.advance(15000);
  assert.strictEqual(h.call.state, 'listening');
  h.running = false;
  await h.say('and another thing');   // activity before the timer fires: it starts over
  assert.deepStrictEqual(h.sent, ['hello', 'and another thing']);
  h.running = false;
  h.call.onReplyText('Sure. ', true); await tick(); await h.finish();
  assert.strictEqual(h.call.state, 'listening');
  await h.advance(19000);
  assert.strictEqual(h.call.state, 'listening', '19 s after the last activity');
  await h.advance(1500);
  assert.strictEqual(h.call.state, 'standby');
  assert.deepStrictEqual(h.last(), ['standby', 'Hey Watchman']);
  assert.strictEqual(h.call.isStandby(), true);
});

test('the quiet time is the one the setting gives', async () => {
  const h = harness();
  h.wakeCfg = { phrase: 'Computer', quietMs: 10000, local: true };
  await h.call.start();
  assert.deepStrictEqual(h.last(), ['standby', 'Computer']);
  await h.say('computer');
  assert.strictEqual(h.call.state, 'listening');
  await h.advance(9500);
  assert.strictEqual(h.call.state, 'listening');
  await h.advance(1000);
  assert.strictEqual(h.call.state, 'standby');
});

test('speech in the quiet time restarts it', async () => {
  const h = await started();
  await h.say('hey watchman');
  await h.advance(15000);
  h.vadHandlers.onSpeechBegin(); h.vadHandlers.onSpeechStart();
  await h.advance(10000);
  assert.strictEqual(h.call.state, 'hearing', 'a person speaking is never put to standby');
  h.vadHandlers.onMisfire();
  await tick();
  await h.advance(19000);
  assert.strictEqual(h.call.state, 'listening');
  await h.advance(2000);
  assert.strictEqual(h.call.state, 'standby');
});

test('sleep words put an awake call back to standby', async () => {
  const h = await started();
  await h.say('hey watchman');
  assert.strictEqual(h.call.state, 'listening');
  await h.say('that\'s all');
  assert.strictEqual(h.call.state, 'standby');
  assert.deepStrictEqual(h.sent, []);
  assert.deepStrictEqual(h.heard, []);
  assert.strictEqual(h.chimes, 1);
});

test('a long utterance in standby is not transcribed', async () => {
  const h = await started();
  await h.say('hey watchman', 31 * 16000);
  assert.strictEqual(h.sttCalls, 0);
  assert.strictEqual(h.chimes, 0);
  assert.strictEqual(h.call.state, 'standby');
  await h.say('hey watchman', 29 * 16000);
  assert.strictEqual(h.sttCalls, 1);
  assert.strictEqual(h.chimes, 1);
});

test('wakeChanged', async () => {
  const h = await started();
  assert.strictEqual(h.call.state, 'standby');
  h.wakeCfg = null;
  h.call.wakeChanged();
  assert.strictEqual(h.call.state, 'listening');
  assert.strictEqual(h.call.isStandby(), false);
  await h.say('what time is it');
  assert.deepStrictEqual(h.sent, ['what time is it'], 'an ordinary call again');
  // switched on again while idle: standby at once
  const g = harness({ wake: () => g.cfg });
  g.cfg = null;
  await g.call.start();
  assert.strictEqual(g.call.state, 'listening');
  g.call.wakeChanged();
  assert.strictEqual(g.call.state, 'listening');
  g.cfg = { phrase: 'Computer', quietMs: 20000, local: true };
  g.call.wakeChanged();
  assert.strictEqual(g.call.state, 'standby');
  assert.deepStrictEqual(g.last(), ['standby', 'Computer']);
  g.cfg = { phrase: 'Hey Doc', quietMs: 20000, local: true };   // the phrase changed in the settings: the display shows the new one
  g.call.wakeChanged();
  assert.deepStrictEqual(g.last(), ['standby', 'Hey Doc']);
});

test('onSpeechStart in standby does not show hearing', async () => {
  const h = await started();
  h.vadHandlers.onSpeechBegin();
  h.vadHandlers.onSpeechStart();
  assert.strictEqual(h.call.state, 'standby');
  assert.ok(!h.states.some(s => s[0] === 'hearing'));
  h.vadHandlers.onSpeechEnd(Object.assign(new Float32Array(16000), { text: 'nothing for me' }));
  await tick();
  assert.strictEqual(h.call.state, 'standby');
});

test('wake turned off while in standby: only wakeChanged makes it an ordinary call', async () => {
  const h = await started();
  h.wakeCfg = null;
  await h.say('what time is it');
  assert.deepStrictEqual(h.sent, [], 'said in standby: dropped until the page reports the switch-off');
  assert.ok(h.call.isStandby());
  h.call.wakeChanged();
  assert.ok(!h.call.isStandby());
  await h.say('what time is it');
  assert.deepStrictEqual(h.sent, ['what time is it']);
});

test('hang up clears the quiet timer', async () => {
  const h = await started();
  await h.say('hey watchman');
  assert.ok(h.timers.length > 0);
  await h.call.hangUp();
  await h.advance(100000);
  assert.strictEqual(h.call.state, 'ended');
});

// ---- review round 1 ----

test('voiceWakeMatch prefers the closest span: a full phrase is never cut short', () => {
  assert.deepStrictEqual(voiceWakeMatch('Hey Watchman AI, close the garage.', 'Hey Watchman AI'), { match: true, rest: 'close the garage.' });
  assert.deepStrictEqual(voiceWakeMatch('Hey Watchman AI.', 'Hey Watchman AI'), { match: true, rest: '' });
  assert.deepStrictEqual(voiceWakeMatch('hey watch man, lights off', 'Hey Watchman'), { match: true, rest: 'lights off' });
  assert.deepStrictEqual(voiceWakeMatch('Hey Watchman, lights off', 'Hey Watchman'), { match: true, rest: 'lights off' });
});

// An stt whose answer the test releases: audio.hold true keeps it pending until audio.release().
function heldStt(h) {
  return (audio) => { h.sttCalls++; if (!audio.hold) return Promise.resolve(audio.text); return new Promise((r) => { audio.release = () => r(audio.text); }); };
}
const clip = (text, hold) => Object.assign(new Float32Array(16000), { text, hold: !!hold });

test('the recognizer check lost while a standby transcript is pending: it stays dropped, and standby goes deaf', async () => {
  const h = harness(); h.deps.stt = heldStt(h);
  await h.call.start();
  const a = clip('private background conversation', true);
  h.vadHandlers.onSpeechStart(); h.vadHandlers.onSpeechEnd(a); await tick();
  h.wakeCfg = { phrase: 'Hey Watchman', quietMs: 20000, local: false };
  h.call.wakeChanged();
  a.release(); await tick(10);
  assert.deepStrictEqual(h.heard, []); assert.deepStrictEqual(h.sent, []);
  assert.strictEqual(h.call.state, 'standby');
  const calls = h.sttCalls;
  await h.say('hey watchman, open the door');
  assert.strictEqual(h.sttCalls, calls, 'not even transcribed while the recognizer is not known to be local');
  assert.deepStrictEqual(h.sent, []);
  h.wakeCfg = { phrase: 'Hey Watchman', quietMs: 20000, local: true };
  h.call.wakeChanged();
  await h.say('hey watchman, open the door');
  assert.deepStrictEqual(h.sent, ['open the door'], 'back to normal once the check passes again');
});

test('switched off while a standby transcript is pending: that one stays dropped, the next is sent', async () => {
  const h = harness(); h.deps.stt = heldStt(h);
  await h.call.start();
  const a = clip('private background conversation', true);
  h.vadHandlers.onSpeechStart(); h.vadHandlers.onSpeechEnd(a); await tick();
  h.wakeCfg = null; h.call.wakeChanged();
  a.release(); await tick(10);
  assert.deepStrictEqual(h.heard, []); assert.deepStrictEqual(h.sent, []);
  await h.say('what time is it');
  assert.deepStrictEqual(h.sent, ['what time is it']);
});

test('a routine refresh (wakeChanged with nothing changed) keeps an awake call awake', async () => {
  const h = await started();
  await h.say('Hey Watchman.');
  assert.strictEqual(h.call.state, 'listening');
  h.call.wakeChanged(); h.call.wakeChanged();
  assert.strictEqual(h.call.state, 'listening');
  await h.say('what time is it');
  assert.deepStrictEqual(h.sent, ['what time is it']);
});

test('the recognizer check lost while awake: the call stays awake, then the quiet time puts it in a deaf standby', async () => {
  const h = await started();
  await h.say('Hey Watchman.');
  h.wakeCfg = { phrase: 'Hey Watchman', quietMs: 20000, local: false };
  h.call.wakeChanged();
  assert.strictEqual(h.call.state, 'listening');
  await h.advance(21000);
  assert.strictEqual(h.call.state, 'standby');
  const calls = h.sttCalls;
  await h.say('hey watchman, what time is it');
  assert.strictEqual(h.sttCalls, calls);
  assert.deepStrictEqual(h.sent, []);
});

test('a call started without a local recognizer is an ordinary call (standby refused)', async () => {
  const h = harness();
  h.wakeCfg = { phrase: 'Hey Watchman', quietMs: 20000, local: false };
  await h.call.start();
  assert.strictEqual(h.call.state, 'listening');
  assert.ok(!h.states.some(s => s[0] === 'standby'));
  await h.say('what time is it');
  assert.deepStrictEqual(h.sent, ['what time is it']);
  await h.say('that\'s all');
  assert.deepStrictEqual(h.heard, ['what time is it', 'that\'s all'], 'no sleep command without wake mode');
});

test('a sleep command is never joined to what follows it', async () => {
  const h = harness(); h.deps.stt = heldStt(h);
  await h.call.start();
  await h.say('Hey Watchman.');
  const a = clip('go to sleep', true);
  h.vadHandlers.onSpeechStart(); h.vadHandlers.onSpeechEnd(a); await tick();
  h.vadHandlers.onSpeechBegin(); h.vadHandlers.onSpeechStart();
  h.vadHandlers.onSpeechEnd(clip('private conversation')); await tick();
  a.release(); await tick(20); await h.advance(6000);
  assert.deepStrictEqual(h.heard, []); assert.deepStrictEqual(h.sent, []);
  assert.strictEqual(h.call.state, 'standby');
});

test('a question from the agent in standby: the answer is heard without the phrase', async () => {
  const answers = [];
  const h = await started({ answerAsk: (id, text) => { answers.push([id, text]); } });
  await h.say('something said before the question');
  h.call.onAsk({ request_id: 'q1', question: 'Which door?' });
  await tick();
  assert.strictEqual(h.call.isStandby(), false);
  await h.finish();
  await h.say('the front door');
  assert.deepStrictEqual(h.heard, ['the front door']);
  assert.ok(!h.heard.includes('something said before the question'));
});

test('in standby a sound does not cut the reading', async () => {
  let cancels = 0;
  const h = await started();
  h.deps.cancelSpeech = () => { cancels++; const r = h.pend.shift(); if (r) r(false); };
  await h.say('hey watchman, tell me a story');
  await h.say('that\'s all');
  assert.strictEqual(h.call.isStandby(), true);
  h.call.onReplyText('Once upon a time. ', false); await tick();
  assert.strictEqual(h.call.state, 'speaking');
  h.vadHandlers.onSpeechBegin(); h.vadHandlers.onSpeechStart();
  assert.strictEqual(cancels, 0);
  assert.strictEqual(h.pend.length, 1, 'still reading');
});

test('the chime timer is cleared on hang up', async () => {
  const h = await started();
  await h.say('Hey Watchman.');
  await h.call.hangUp();
  assert.strictEqual(h.timers.length, 0);
});

// ---- review round 2 ----

test('a pending wake transcript does not wake the call once the recognizer check has failed', async () => {
  const h = harness(); h.deps.stt = heldStt(h);
  await h.call.start();
  const a = clip('Hey Watchman, open the door', true);
  h.vadHandlers.onSpeechStart(); h.vadHandlers.onSpeechEnd(a); await tick();
  h.wakeCfg = { phrase: 'Hey Watchman', quietMs: 20000, local: false };
  h.call.wakeChanged();
  a.release(); await tick(10);
  assert.deepStrictEqual(h.sent, []); assert.deepStrictEqual(h.heard, []);
  assert.strictEqual(h.chimes, 0);
  assert.strictEqual(h.call.isStandby(), true);
});

test('speech that began in standby stays dropped when a question wakes the call before it ends', async () => {
  const answers = [];
  const h = await started({ answerAsk: (id, text) => { answers.push([id, text]); } });
  h.vadHandlers.onSpeechBegin(); h.vadHandlers.onSpeechStart();
  h.call.onAsk({ request_id: 'q1', question: 'Which door?' });
  h.vadHandlers.onSpeechEnd(clip('private background conversation')); await tick(10);
  assert.deepStrictEqual(h.heard, []); assert.deepStrictEqual(answers, []); assert.deepStrictEqual(h.sent, []);
  await h.finish();
  await h.say('the front door');
  assert.deepStrictEqual(h.heard, ['the front door']);
});

test('speech while the call is still starting is already under standby', async () => {
  let release;
  const h = harness();
  h.deps.server.start = () => new Promise((r) => { release = () => r({ callId: 'call-1', held: [] }); });
  const p = h.call.start(); await tick();
  assert.strictEqual(h.call.isStandby(), true);
  await h.say('private conversation while it starts');
  release(); assert.strictEqual(await p, true); await tick(10);
  assert.deepStrictEqual(h.sent, []); assert.deepStrictEqual(h.heard, []);
  assert.strictEqual(h.call.state, 'standby');
});

test('a sleep command wins over an earlier piece it would be joined to', async () => {
  const h = harness(); h.deps.stt = heldStt(h);
  await h.call.start();
  await h.say('Hey Watchman.');
  const a = clip('thanks', true);
  h.vadHandlers.onSpeechStart(); h.vadHandlers.onSpeechEnd(a); await tick();
  h.vadHandlers.onSpeechBegin(); h.vadHandlers.onSpeechStart();
  h.vadHandlers.onSpeechEnd(clip('go to sleep')); await tick();
  a.release(); await tick(20); await h.advance(6000);
  assert.deepStrictEqual(h.sent, []); assert.deepStrictEqual(h.heard, []);
  assert.strictEqual(h.call.state, 'standby');
});

test('a failed transcription in standby shows no toast; a call that cannot use the phrase says so once', async () => {
  const toasts = [];
  const ui = (st) => ({ state: (n, p) => st.push([n, p]), heard() {}, held() {}, toast: (m) => toasts.push(m), summary() {} });
  const h = harness({ ui: ui([]), stt: async () => { throw new Error('down'); } });
  await h.call.start();
  await h.say('anything'); await tick(10);
  assert.deepStrictEqual(toasts, []);
  const g = harness({ ui: ui([]), stt: async () => { throw new Error('down'); } });
  await g.call.start();
  g.call.wakeChanged();
  await g.say('hey watchman'); await tick(10);
  assert.deepStrictEqual(toasts, [], 'still standby');
  const k = harness({ ui: ui([]) });
  k.wakeCfg = { phrase: 'Hey Watchman', quietMs: 20000, local: false };
  await k.call.start();
  assert.strictEqual(toasts.length, 1);
  assert.match(toasts[0], /wake phrase is not in use/);
});

// ---- review round 3 follow-ups ----

test('a long utterance that began in standby is not transcribed even if a question woke the call meanwhile', async () => {
  const h = await started();
  h.vadHandlers.onSpeechBegin(); h.vadHandlers.onSpeechStart();
  h.call.onAsk({ request_id: 'q1', question: 'Which door?' });
  h.vadHandlers.onSpeechEnd(Object.assign(new Float32Array(31 * 16000), { text: 'long private talk' })); await tick(10);
  assert.strictEqual(h.sttCalls, 0);
});

test('switched off while the call starts: an ordinary call, not a deaf standby', async () => {
  let release;
  const h = harness();
  h.deps.server.start = () => new Promise((r) => { release = () => r({ callId: 'call-1', held: [] }); });
  const p = h.call.start(); await tick();
  h.wakeCfg = null; h.call.wakeChanged();
  release(); assert.strictEqual(await p, true); await tick();
  assert.strictEqual(h.call.state, 'listening');
  await h.say('what time is it');
  assert.deepStrictEqual(h.sent, ['what time is it']);
});

test('a long message right after the phrase said alone is still transcribed', async () => {
  const h = harness(); h.deps.stt = heldStt(h);
  await h.call.start();
  const a = clip('Hey Watchman.', true);
  h.vadHandlers.onSpeechStart(); h.vadHandlers.onSpeechEnd(a); await tick();
  h.vadHandlers.onSpeechBegin(); h.vadHandlers.onSpeechStart();   // the message starts before the phrase's transcript is back
  h.vadHandlers.onSpeechEnd(Object.assign(new Float32Array(31 * 16000), { text: 'a long message' })); await tick();
  a.release(); await tick(20); await h.advance(6000);
  assert.deepStrictEqual(h.sent, ['a long message']);
});

test('the Heard line is cleared when the call goes back to standby, and only then', async () => {
  const h = await started();
  assert.deepStrictEqual(h.heard, [], 'nothing cleared at the start');
  await h.say('hey watchman, hello');
  assert.deepStrictEqual(h.heard, ['hello']);
  h.running = false;
  h.call.onReplyText('Hi. ', true); await tick(); await h.finish();
  await h.advance(21000);
  assert.strictEqual(h.call.state, 'standby');
  assert.deepStrictEqual(h.heard, ['hello', '']);
  await h.say('something else');
  assert.deepStrictEqual(h.heard, ['hello', ''], 'standby talk never shows');
});
