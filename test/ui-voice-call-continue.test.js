'use strict';
// Voice fixes round 2, controller side: (5) the end of a turn is judged from what was said (an unfinished sentence waits for
// the next piece, up to "Wait for me to go on"), (9) the thinking sound and the one spoken line after 20 s, (8) everything is
// released on hang-up, release(), a VAD error, a start failure and a hang-up during the start (live microphone tracks counted).
// Fake clock, fake vad, fake audio context and fake MicVAD.
const { test } = require('node:test');
const assert = require('node:assert');
Object.assign(globalThis, require('../lib/ui-voice'));   // the call file uses these helpers as globals, like the pages
const { voiceCreateCall, voiceCreateVad, voiceCreateThinkingSound, voiceLiveTracks, VOICE_THINKING_LINES } = require('../lib/ui-voice-call');

const tick = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function harness(over, prefs) {
  const h = { t: 0, timers: [], nextId: 1, spoken: [], pend: [], sent: [], interjected: [], stops: 0, running: false, heard: [], asks: [], playing: [], think: [], ends: [], prefs: Object.assign({ continueWait: 3000, thinkingSound: true, thinkingVolume: 0.5 }, prefs) };
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
  h.deps = {
    agent: 'a1', now: () => h.t, setTimer: h.setTimer, clearTimer: h.clearTimer, prefs: () => h.prefs,
    vad: { start: async (hd) => { h.handlers = hd; }, stop() { h.vadStops = (h.vadStops || 0) + 1; }, setPlaybackActive: (b) => h.playing.push(b) },
    stt: async (audio) => audio.text, isTurnRunning: () => h.running,
    send: async (t) => { h.sent.push(t); h.running = true; }, interject: async (t) => { h.interjected.push(t); },
    stop: () => { h.stops++; }, speak: h.speak, cancelSpeech: () => { const r = h.pend.shift(); if (r) r(false); }, answerAsk: (id, t) => h.asks.push([id, t]),
    server: { start: async () => ({ callId: 'c1', held: [] }), heartbeat: async () => ({ held: [] }), mode: async () => {}, end: async (id) => { h.ends.push(id); return { held: [] }; }, decide: async () => {} },
    ui: { state() {}, heard: (t) => h.heard.push(t), held() {}, toast() {}, summary() {}, level() {}, activity() {} },
  };
  Object.assign(h.deps, over || {});
  h.call = voiceCreateCall(h.deps);
  h.begin = () => h.handlers.onSpeechStart();
  h.end = async (text) => { h.handlers.onSpeechEnd({ text }); await tick(); };
  h.say = async (text) => { h.begin(); await h.end(text); };
  return h;
}
async function started(over, prefs) { const h = harness(over, prefs); assert.strictEqual(await h.call.start(), true); return h; }
const thinking = (h) => ({ start: () => h.think.push('start'), stop: () => h.think.push('stop'), setVolume: (v) => h.think.push('vol ' + v) });

// ---- (5) the end of a turn from what was said ----

const OWNER_A1 = 'to be able to change the speed of the voice that\'s coming at us and also';
const OWNER_A2 = 'to choose how fast you talk when I am listening.';
const OWNER_B1 = 'I think you and other agents should know when';
const OWNER_B2 = 'you are in a voice chat because in a voice chat it\'s very difficult to.';
const OWNER_B3 = 'for you to articulate things like dashes and symbols so you should avoid using those in a voice chat.';

test('owner cut-off 1: "... and also" then a piece within 3 s is ONE message', async () => {
  const h = await started();
  await h.say(OWNER_A1);
  await h.advance(2500);
  assert.deepStrictEqual(h.sent, [], 'not sent while it sounds unfinished');
  await h.say(OWNER_A2);
  await h.advance(5000);
  assert.deepStrictEqual(h.sent, [OWNER_A1 + ' ' + OWNER_A2]);
  assert.deepStrictEqual(h.interjected, []);
  assert.deepStrictEqual(h.heard, [OWNER_A1 + ' ' + OWNER_A2]);
});

test('owner cut-off 2: three pieces, the middle one ends "difficult to." -> ONE message', async () => {
  const h = await started();
  await h.say(OWNER_B1);
  await h.advance(1500);
  await h.say(OWNER_B2);
  await h.advance(2000);
  assert.deepStrictEqual(h.sent, [], 'the joined text still sounds unfinished (ends on "to.")');
  await h.say(OWNER_B3);
  await h.advance(100);
  assert.deepStrictEqual(h.sent, [OWNER_B1 + ' ' + OWNER_B2 + ' ' + OWNER_B3]);
  assert.strictEqual(h.interjected.length, 0);
  await h.advance(30000);
  assert.strictEqual(h.sent.length, 1, 'sent once');
});

test('a long next piece is not cut off by the wait: the first piece waits for it to end', async () => {
  const h = await started();
  await h.say('please look at the disk usage and');
  await h.advance(1000);
  h.begin();                                  // the person goes on, for a long time
  await h.advance(12000);
  assert.deepStrictEqual(h.sent, [], 'still waiting for the end of the long piece');
  await h.end('tell me which folder is the biggest.');
  await h.advance(100);
  assert.deepStrictEqual(h.sent, ['please look at the disk usage and tell me which folder is the biggest.']);
});

test('an unfinished sentence that gets nothing more is sent once, when the wait ends (3 s by default)', async () => {
  const h = await started();
  await h.say(OWNER_A1);
  await h.advance(2900);
  assert.deepStrictEqual(h.sent, []);
  await h.advance(200);
  assert.deepStrictEqual(h.sent, [OWNER_A1]);
  await h.advance(60000);
  assert.strictEqual(h.sent.length, 1);
});

test('the wait follows the setting: 1.5 s and 5 s', async () => {
  let h = await started({}, { continueWait: 1500 });
  await h.say('and then we');
  await h.advance(1400); assert.deepStrictEqual(h.sent, []);
  await h.advance(200); assert.deepStrictEqual(h.sent, ['and then we']);
  h = await started({}, { continueWait: 5000 });
  await h.say('and then we');
  await h.advance(4900); assert.deepStrictEqual(h.sent, []);
  await h.advance(200); assert.deepStrictEqual(h.sent, ['and then we']);
  h = await started({}, { continueWait: 0 });
  await h.say('and then we');
  assert.deepStrictEqual(h.sent, ['and then we'], '0 = no waiting');
});

test('a complete sentence or a question is sent at once, without waiting', async () => {
  let h = await started();
  await h.say('Turn on the light in the kitchen.');
  assert.deepStrictEqual(h.sent, ['Turn on the light in the kitchen.']);
  h = await started();
  await h.say('What time is it?');
  assert.deepStrictEqual(h.sent, ['What time is it?']);
});

test('a stop word wins at once, in the first piece or in a later one', async () => {
  let h = await started();
  await h.say('stop');
  assert.strictEqual(h.stops, 1); assert.deepStrictEqual(h.sent, []);
  h = await started();
  await h.say('delete everything in the folder and');
  await h.advance(1000);
  await h.say('stop');
  await h.advance(100);
  assert.strictEqual(h.stops, 1, 'the later piece was a stop command');
  assert.deepStrictEqual(h.sent, [], 'the unfinished text was not sent');
});

test('a false start while waiting: the waiting text is sent after the wait, not lost', async () => {
  const h = await started();
  await h.say('please open the file and');
  await h.advance(500);
  h.handlers.onSpeechBegin(); await tick();
  h.handlers.onMisfire(); await tick();
  await h.advance(4000);
  assert.deepStrictEqual(h.sent, ['please open the file and']);
});

test('an answer to a question (ask_user) or to an announcement is not made to wait', async () => {
  const h = await started();
  h.call.onAsk({ request_id: 'r1', question: 'Which colour?', options: ['Red', 'Green'] });
  await h.finish();
  await h.say('red');
  assert.deepStrictEqual(h.asks, [['r1', 'Red']]);
});

test('a turn that is running gets the joined text as one interjection', async () => {
  const h = await started();
  h.running = true;
  await h.say('and also look at the logs from');
  await h.advance(800);
  await h.say('the backup server.');
  await h.advance(100);
  assert.deepStrictEqual(h.interjected, ['and also look at the logs from the backup server.']);
  assert.deepStrictEqual(h.sent, []);
});

test('hanging up while a text waits sends nothing', async () => {
  const h = await started();
  await h.say('and then I');
  await h.call.hangUp();
  await h.advance(10000);
  assert.deepStrictEqual(h.sent, []);
});

test('optional end-of-turn model: it can add doubt to a complete-sounding text, never remove the text check', async () => {
  const seen = [];
  let h = await started({ turnModel: async (a) => { seen.push(a.text); return 0.1; } });
  await h.say('Turn on the light in the kitchen.');
  assert.deepStrictEqual(h.sent, [], 'the model says not finished: wait');
  await h.advance(3100);
  assert.deepStrictEqual(h.sent, ['Turn on the light in the kitchen.']);
  assert.deepStrictEqual(seen, ['Turn on the light in the kitchen.']);
  h = await started({ turnModel: async () => 0.95 });
  await h.say('Turn on the light.');
  assert.deepStrictEqual(h.sent, ['Turn on the light.'], 'model finished + text finished: sent');
  h = await started({ turnModel: async () => 0.95 });
  await h.say('turn on the light and');
  assert.deepStrictEqual(h.sent, [], 'model finished but the text is not: the text waits');
  h = await started({ turnModel: async () => null });
  await h.say('Turn on the light.');
  assert.deepStrictEqual(h.sent, ['Turn on the light.'], 'model unsure: the text decides');
  h = await started({ turnModel: async () => { throw new Error('model down'); } });
  await h.say('Turn on the light.');
  assert.deepStrictEqual(h.sent, ['Turn on the light.'], 'a failing model changes nothing');
});

test('barge-in stays on speech start: it cuts the reading at once, a waiting text does not delay it', async () => {
  const h = await started();
  await h.say('Please tell me a story.');
  h.call.onReplyText('Once upon a time. There was a cat. ', false);
  assert.strictEqual(h.spoken.length, 1);
  h.begin();
  assert.strictEqual(h.call.state, 'hearing');
  await tick();
  assert.deepStrictEqual(h.spoken, ['Once upon a time.'], 'cut, the rest dropped');
});

// ---- (9) the thinking sound ----

test('thinking sound: starts 2 s after the turn was sent when no reply speech began, stops the instant the reply speaks', async () => {
  const h = await started({}, {}); h.deps.thinking = thinking(h); h.call = voiceCreateCall(h.deps);
  assert.strictEqual(await h.call.start(), true);
  await h.say('Please check the system status.');
  await h.advance(1900); assert.deepStrictEqual(h.think, [], 'nothing before 2 s');
  await h.advance(200); assert.deepStrictEqual(h.think, ['start']);
  assert.strictEqual(h.playing[h.playing.length - 1], true, 'the VAD treats the pulse as playback (no barge-in from it)');
  h.call.onReplyText('All good. ', false);
  assert.deepStrictEqual(h.think, ['start', 'stop']);
  await h.finish();
  h.call.onReplyText('All good. Nothing is wrong.', true);
  await h.finish();
  await h.advance(60000);
  assert.deepStrictEqual(h.think, ['start', 'stop'], 'nothing plays when the turn ends');
});

test('thinking sound: a quick reply (within 2 s) has no sound at all', async () => {
  const h = await started(); h.deps.thinking = thinking(h); h.call = voiceCreateCall(h.deps);
  await h.call.start();
  await h.say('Please check the system status.');
  await h.advance(1000);
  h.call.onReplyText('All good. ', true);
  await h.advance(20000);
  assert.deepStrictEqual(h.think, []);
});

test('thinking sound: no sound after a turn ends, none for a stop command, none when switched off', async () => {
  let h = await started(); h.deps.thinking = thinking(h); h.call = voiceCreateCall(h.deps);
  await h.call.start();
  await h.say('stop');
  await h.advance(10000);
  assert.deepStrictEqual(h.think, [], 'a stop command starts nothing');
  h = await started({}, { thinkingSound: false }); h.deps.thinking = thinking(h); h.call = voiceCreateCall(h.deps);
  await h.call.start();
  await h.say('Please check the system status.');
  await h.advance(10000);
  assert.deepStrictEqual(h.think, [], 'the pref is off');
  h = await started({ thinking: undefined });
  await h.say('Please check the system status.');
  await h.advance(10000);
  assert.strictEqual(h.sent.length, 1, 'no thinking adapter: no sound, no error');
});

test('thinking sound: stops when the person starts speaking; comes back after they were heard and the turn goes on', async () => {
  const h = await started(); h.deps.thinking = thinking(h); h.call = voiceCreateCall(h.deps);
  await h.call.start();
  await h.say('Please check the system status.');
  await h.advance(2500); assert.deepStrictEqual(h.think, ['start']);
  h.handlers.onSpeechBegin();
  assert.deepStrictEqual(h.think, ['start', 'stop'], 'the person starts speaking: stopped at once');
  await h.end('Also the memory use please.');
  await h.advance(2500);
  assert.deepStrictEqual(h.think, ['start', 'stop', 'start'], 'a new wait begins after their turn was sent');
});

test('thinking sound: stops on hang-up and on release; prefs change live with setPrefs()', async () => {
  let h = await started(); h.deps.thinking = thinking(h); h.call = voiceCreateCall(h.deps);
  await h.call.start();
  await h.say('Please check the system status.');
  await h.advance(2500);
  await h.call.hangUp();
  assert.deepStrictEqual(h.think, ['start', 'stop']);
  h = await started(); h.deps.thinking = thinking(h); h.call = voiceCreateCall(h.deps);
  await h.call.start();
  await h.say('Please check the system status.');
  await h.advance(2500);
  h.call.release('hidden');
  assert.deepStrictEqual(h.think, ['start', 'stop']);
  h = await started(); h.deps.thinking = thinking(h); h.call = voiceCreateCall(h.deps);
  await h.call.start();
  await h.say('Please check the system status.');
  await h.advance(2500);
  h.prefs.thinkingSound = false; h.call.setPrefs();
  assert.deepStrictEqual(h.think.filter(x => !x.startsWith('vol')), ['start', 'stop'], 'switched off in the panel: silent now');
  h.prefs.thinkingSound = true; h.prefs.thinkingVolume = 0.2; h.call.setPrefs();
  await h.advance(2500);
  assert.deepStrictEqual(h.think.filter(x => x === 'start').length, 2, 'switched on again: the sound comes back');
  assert.ok(h.think.includes('vol 0.2'), 'the volume is passed on');
});

test('after 20 s of waiting: ONE line from the three, never twice in the same wait; "Still working on it." is gone', async () => {
  const h = await started(); h.deps.thinking = thinking(h); h.call = voiceCreateCall(h.deps);
  await h.call.start();
  await h.say('Please check the system status.');
  await h.advance(19000); assert.deepStrictEqual(h.spoken, []);
  await h.advance(1500);
  assert.strictEqual(h.spoken.length, 1);
  assert.ok(VOICE_THINKING_LINES.includes(h.spoken[0]));
  assert.deepStrictEqual(VOICE_THINKING_LINES, ['I\'m considering what you just said.', 'Still thinking about that.', 'Give me a moment, I\'m working through it.']);
  assert.strictEqual(h.think[h.think.length - 1], 'stop', 'the pulse stopped when the line began');
  await h.finish();
  await h.advance(100000);
  assert.strictEqual(h.spoken.length, 1, 'one line in this wait');
  h.call.onReplyText('First part. ', false); await tick(); await h.finish();
  await h.advance(21000);
  assert.strictEqual(h.spoken.length, 3);
  assert.ok(VOICE_THINKING_LINES.includes(h.spoken[2]) && h.spoken[2] !== h.spoken[0], 'not the same line twice');
});

// ---- the thinking sound itself (Web Audio, fake context) ----

function fakeCtx() {
  const c = { nodes: [], currentTime: 10, state: 'running', destination: { kind: 'dest' }, intervals: [] };
  const param = (v) => ({ value: v, calls: [], setValueAtTime(x, t) { this.calls.push(['set', x, t]); }, linearRampToValueAtTime(x, t) { this.calls.push(['ramp', x, t]); }, cancelScheduledValues(t) { this.calls.push(['cancel', t]); } });
  const node = (kind, extra) => { const n = Object.assign({ kind, connected: [], connect(x) { this.connected.push(x); }, disconnect() { this.disconnected = true; } }, extra); c.nodes.push(n); return n; };
  c.createGain = () => node('gain', { gain: param(1) });
  c.createOscillator = () => node('osc', { type: '', frequency: { value: 0 }, started: null, stopped: null, start(t) { this.started = t; }, stop(t) { this.stopped = t; } });
  return c;
}

test('thinking sound: a soft low pulse, sine near 200 Hz with a quiet second partial, peak <= volume x 0.06, every 2.5 s', () => {
  const ctx = fakeCtx(), ivs = [];
  const s = voiceCreateThinkingSound({ ctx, volume: 1, setInterval: (f, ms) => { ivs.push({ f, ms }); return 7; }, clearInterval: (id) => { ivs.push({ cleared: id }); } });
  s.start();
  const oscs = ctx.nodes.filter(n => n.kind === 'osc');
  assert.strictEqual(oscs.length, 2);
  assert.ok(oscs.every(o => o.type === 'sine'));
  const freqs = oscs.map(o => o.frequency.value);
  assert.ok(freqs[0] >= 196 && freqs[0] <= 220, 'base ' + freqs[0]);
  assert.ok(freqs[1] > freqs[0] * 1.4 && freqs[1] < freqs[0] * 2.1, 'second partial');
  const levels = ctx.nodes.filter(n => n.kind === 'gain' && oscs.some(o => o.connected.includes(n))).map(g => g.gain.value);
  assert.ok(levels[1] < levels[0] / 3, 'the second partial is quiet');
  assert.ok(levels[0] + levels[1] <= 1.0001, 'partials add up to at most the envelope');
  const master = ctx.nodes.find(n => n.kind === 'gain' && n.connected.includes(ctx.destination));
  assert.ok(master.gain.value <= 0.06 + 1e-9 && master.gain.value > 0.059, 'master = volume x 0.06');
  const env = ctx.nodes.filter(n => n.kind === 'gain' && n.connected.includes(master))[0];
  const ramps = env.gain.calls.filter(c => c[0] === 'ramp');
  assert.ok(Math.abs((ramps[0][2] - 10.02) - 0.25) < 1e-9, 'attack 0.25 s');
  assert.strictEqual(ramps[0][1], 1); assert.ok(Math.abs((ramps[1][2] - ramps[0][2]) - 1) < 1e-9 && ramps[1][1] === 0, 'decay 1 s');
  assert.strictEqual(ivs[0].ms, 2500, 'repeats every 2.5 s');
  ivs[0].f();
  assert.strictEqual(ctx.nodes.filter(n => n.kind === 'osc').length, 4, 'the next pulse');
  s.start();
  assert.strictEqual(ctx.nodes.filter(n => n.kind === 'osc').length, 4, 'start twice does nothing');
});

test('thinking sound: volume 0 is silent, setVolume changes the level, stop fades in 0.1 s and stops the oscillators', () => {
  const ctx = fakeCtx(), ivs = [];
  const s = voiceCreateThinkingSound({ ctx, volume: 0.5, setInterval: () => 3, clearInterval: (id) => ivs.push(id) });
  s.start();
  const master = ctx.nodes.find(n => n.kind === 'gain' && n.connected.includes(ctx.destination));
  assert.ok(Math.abs(master.gain.value - 0.03) < 1e-9);
  s.setVolume(0); assert.strictEqual(master.gain.value, 0);
  s.setVolume(9); assert.ok(master.gain.value <= 0.06 + 1e-9, 'capped');
  ctx.currentTime = 11;
  s.stop();
  assert.deepStrictEqual(ivs, [3], 'the repeat is cleared');
  const last = master.gain.calls[master.gain.calls.length - 1];
  assert.deepStrictEqual(last, ['ramp', 0, 11.1], 'fade out over 0.1 s');
  assert.ok(ctx.nodes.filter(n => n.kind === 'osc').every(o => o.stopped <= 11.13), 'oscillators stop with the fade');
  s.stop();   // twice is harmless
  s.start();
  assert.strictEqual(ctx.nodes.filter(n => n.kind === 'osc').length, 4, 'can start again');
});

test('thinking sound: no melody, no files: the source uses only Web Audio oscillators', () => {
  const src = require('node:fs').readFileSync(require.resolve('../lib/ui-voice-call.js'), 'utf8');
  const a = src.indexOf('function voiceCreateThinkingSound'), b = src.indexOf('// The microphone and the voice activity detector.');
  const body = src.slice(a, b);
  assert.ok(/createOscillator/.test(body) && !/fetch|new Audio|decodeAudioData|\.mp3|\.wav|\.ogg/.test(body));
});

// ---- (8) everything is released ----

function liveBrowser(opts) {
  const o = opts || {};
  const b = { created: [], closed: 0, destroyed: 0, gate: null, madeTracks: [] };
  const track = () => { const t = { readyState: 'live', stop() { this.readyState = 'ended'; } }; b.madeTracks.push(t); return t; };
  class Ctx {
    constructor() { this.state = 'suspended'; } async resume() { this.state = 'running'; } async close() { b.closed++; }
    createMediaStreamSource() { return { connect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    createMediaStreamDestination() { const ts = [track()]; return { stream: { getTracks: () => ts } }; }
  }
  class MicVAD {
    static async new(options) {
      const v = new MicVAD(); v.options = options; b.created.push(v);
      await options.getStream();
      if (o.vadError) throw new Error('model failed');
      return v;
    }
    async start() { this.started = true; } async destroy() { b.destroyed++; }
    setOptions() {}
  }
  const getUserMedia = async () => {
    if (o.micError) throw new Error('NotAllowedError');
    if (o.gateMic) await new Promise((r) => { b.gate = r; });
    const ts = [track()];
    return { getTracks: () => ts };
  };
  const win = { AudioContext: Ctx, vad: { MicVAD }, navigator: { mediaDevices: { getUserMedia } } };
  return { b, win };
}
function realCall(opts, depsOver) {
  const f = liveBrowser(opts);
  const h = harness({ vad: voiceCreateVad({ win: f.win, loadScript: async () => {} }) });
  if (depsOver) { Object.assign(h.deps, depsOver); h.call = voiceCreateCall(h.deps); }
  return Object.assign(f, { h });
}

test('release: voiceLiveTracks counts the raw AND the processed microphone tracks, and is 0 after hang-up', async () => {
  assert.strictEqual(voiceLiveTracks(), 0);
  const f = realCall();
  assert.strictEqual(await f.h.call.start(), true);
  assert.strictEqual(voiceLiveTracks(), 2, 'the raw stream and the processed (destination) stream');
  await f.h.call.hangUp();
  assert.strictEqual(voiceLiveTracks(), 0);
  assert.ok(f.b.madeTracks.every(t => t.readyState === 'ended'));
  assert.deepStrictEqual([f.b.destroyed, f.b.closed], [1, 1], 'MicVAD destroyed and the AudioContext closed');
  assert.deepStrictEqual(f.h.ends, ['c1']);
});

for (const reason of ['hidden', 'pagehide', 'freeze']) {
  test('release(' + reason + '): at once, tracks 0, context closed, the server told without waiting', async () => {
    const f = realCall();
    await f.h.call.start();
    assert.strictEqual(voiceLiveTracks(), 2);
    f.h.call.release(reason);
    assert.strictEqual(voiceLiveTracks(), 0, 'every track is stopped synchronously, before anything is awaited');
    assert.strictEqual(f.h.call.state, 'ended');
    await tick(20);
    assert.deepStrictEqual([f.b.destroyed, f.b.closed], [1, 1]);
    assert.deepStrictEqual(f.h.ends, ['c1'], 'server.end fire-and-forget');
    assert.deepStrictEqual(await f.h.call.release(reason), [], 'a second release is harmless');
    await f.h.call.hangUp();
    assert.deepStrictEqual(f.h.ends, ['c1'], 'and ends the call only once');
  });
}

test('release: a server that never answers does not hold anything up; speech and timers are dropped', async () => {
  const f = realCall({}, { server: { start: async () => ({ callId: 'c1', held: [] }), heartbeat: async () => ({ held: [] }), mode: async () => {}, end: () => new Promise(() => {}), decide: async () => {} } });
  await f.h.call.start();
  f.h.call.onReplyText('One sentence here. Another one. ', false);
  assert.strictEqual(f.h.spoken.length, 1);
  f.h.call.release('pagehide');
  assert.strictEqual(voiceLiveTracks(), 0);
  assert.strictEqual(f.h.timers.length, 0 + f.h.timers.length, 'no throw');
  await f.h.advance(60000);
  assert.strictEqual(f.h.spoken.length, 1, 'nothing more is read after the release');
});

test('release: a VAD error while starting (model fails after the microphone came up) leaves no live track', async () => {
  const f = realCall({ vadError: true });
  assert.strictEqual(await f.h.call.start(), false);
  assert.strictEqual(voiceLiveTracks(), 0);
  assert.ok(f.b.closed >= 1, 'the context is closed');
});

test('release: a start failure leaves no live track (microphone refused; server refused after the microphone came up)', async () => {
  let f = realCall({ micError: true });
  assert.strictEqual(await f.h.call.start(), false);
  assert.strictEqual(voiceLiveTracks(), 0);
  assert.ok(f.b.closed >= 1);
  f = realCall({}, { server: { start: async () => { throw new Error('server down'); }, heartbeat: async () => ({}), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} } });
  assert.strictEqual(await f.h.call.start(), false);
  assert.strictEqual(voiceLiveTracks(), 0, 'the microphone that was already up is let go');
  assert.ok(f.b.closed >= 1);
});

test('release: hanging up while the microphone is still coming up lets go of it when it arrives', async () => {
  const f = realCall({ gateMic: true });
  const p = f.h.call.start();
  await tick(20);
  const ended = f.h.call.hangUp();
  await tick(20);
  f.b.gate();                       // the permission prompt is answered after the hang-up
  assert.strictEqual(await p, false);
  await ended;
  await tick(20);
  assert.strictEqual(voiceLiveTracks(), 0, 'the late microphone was stopped');
  assert.ok(f.b.madeTracks.length > 0 && f.b.madeTracks.every(t => t.readyState === 'ended'));
  assert.ok(f.b.closed >= 1);
});

test('release: release() while the microphone is still coming up lets go of it when it arrives', async () => {
  const f = realCall({ gateMic: true });
  const p = f.h.call.start();
  await tick(20);
  f.h.call.release('hidden');
  f.b.gate();
  assert.strictEqual(await p, false);
  await tick(20);
  assert.strictEqual(voiceLiveTracks(), 0);
  assert.ok(f.b.madeTracks.every(t => t.readyState === 'ended'));
});

test('release: voiceCreateVad.stop() alone stops both streams, destroys MicVAD and closes the context (twice is fine)', async () => {
  const f = liveBrowser();
  const vad = voiceCreateVad({ win: f.win, loadScript: async () => {} });
  await vad.start({});
  assert.strictEqual(voiceLiveTracks(), 2);
  await vad.stop(); await vad.stop();
  assert.strictEqual(voiceLiveTracks(), 0);
  assert.deepStrictEqual([f.b.destroyed, f.b.closed], [1, 1]);
});
