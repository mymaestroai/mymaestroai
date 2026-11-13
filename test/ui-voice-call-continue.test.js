'use strict';
// Voice fixes round 2, controller side: (5) the end of a turn is judged from what was said (an unfinished sentence waits for
// the next piece, up to "Wait for me to go on"), (9) the thinking sound and the one spoken line after 20 s, (8) everything is
// released on hang-up, release(), a VAD error, a start failure and a hang-up during the start (live microphone tracks counted).
// Fake clock, fake vad, fake audio context and fake MicVAD.
const { test } = require('node:test');
const assert = require('node:assert');
Object.assign(globalThis, require('../lib/ui-voice'), require('../lib/ui-voice-thinking'));   // the call file uses these helpers as globals, like the pages
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
  c.createOscillator = () => node('osc', { type: '', frequency: param(0), started: null, stopped: null, start(t) { this.started = t; }, stop(t) { this.stopped = t; } });
  c.createBiquadFilter = () => node('filter', { type: '', frequency: param(0), Q: param(1) });
  return c;
}

test('thinking sound: a quiet random pop cluster: 4-7 soft sine pops, a few-ms attack and 30-60 ms decay through a low-pass under 2 kHz, peak -25 dBFS at the default volume', () => {
  const ctx = fakeCtx(), ivs = [];
  const s = voiceCreateThinkingSound({ ctx, volume: 0.5, setInterval: (f, ms) => { ivs.push({ f, ms }); return 7; }, clearInterval: (id) => { ivs.push({ cleared: id }); } });
  s.start();
  const oscs = ctx.nodes.filter(n => n.kind === 'osc');
  assert.ok(oscs.length >= 4 && oscs.length <= 7, 'pops: ' + oscs.length);
  assert.ok(oscs.every(o => o.type === 'sine' && o.frequency.value > 100 && o.frequency.value < 2000));
  const master = ctx.nodes.find(n => n.kind === 'gain' && n.connected.includes(ctx.destination));
  assert.ok(Math.abs(20 * Math.log10(master.gain.value) - (-25)) < 0.1, 'master = -25 dBFS at volume 0.5: ' + master.gain.value);
  assert.ok(Math.abs(master.gain.value - voiceThinkingPeak(0.5)) < 1e-9, 'the renderer literal matches the planner peak');
  const env = ctx.nodes.filter(n => n.kind === 'gain' && n.connected.includes(master))[0];
  const er = env.gain.calls.filter(c => c[0] === 'ramp');
  assert.strictEqual(er[0][1], 1); assert.strictEqual(er[er.length - 1][1], 0, 'the cluster fades in and out');
  const lp = ctx.nodes.find(n => n.kind === 'filter');
  assert.strictEqual(lp.type, 'lowpass'); assert.ok(lp.frequency.value < 2000); assert.ok(lp.connected.includes(env));
  const starts = oscs.map(o => o.started - 10.02);
  const gaps = starts.slice(1).map((t, i) => (t - starts[i]) * 1000);
  assert.ok(gaps.every(g => g >= 119 && g <= 351), 'uneven spacing 120-350 ms: ' + gaps.join());
  assert.ok(starts[starts.length - 1] < 2.2, 'one cluster is about 1.5 s: ' + starts[starts.length - 1]);
  for (const o of oscs) {
    const g = ctx.nodes.find(n => n.kind === 'gain' && o.connected.includes(n));
    const r = g.gain.calls.filter(c => c[0] === 'ramp');
    assert.ok(r[0][2] - o.started <= 0.0045 && r[0][2] - o.started > 0, 'attack in a few ms');
    const dec = (r[1][2] - o.started) * 1000;
    assert.ok(dec >= 29.9 && dec <= 60.1, 'decay 30-60 ms: ' + dec);
    assert.ok(g.connected.includes(lp), 'every pop goes through the low-pass');
  }
  assert.strictEqual(ivs[0].ms, 6500, 'the old start() repeats it by itself');
  s.start();
  assert.strictEqual(ctx.nodes.filter(n => n.kind === 'osc').length, oscs.length, 'start twice does nothing');
});

test('thinking sound: volume 0 is silent, setVolume changes the level, stop fades in 0.1 s and stops the oscillators', () => {
  const ctx = fakeCtx(), ivs = [];
  const s = voiceCreateThinkingSound({ ctx, volume: 0.5, setInterval: () => 3, clearInterval: (id) => ivs.push(id) });
  s.start();
  const master = ctx.nodes.find(n => n.kind === 'gain' && n.connected.includes(ctx.destination));
  assert.ok(Math.abs(master.gain.value - voiceThinkingPeak(0.5)) < 1e-9);
  s.setVolume(0); assert.strictEqual(master.gain.value, 0);
  s.setVolume(9); assert.ok(master.gain.value <= voiceThinkingPeak(1) + 1e-9, 'capped');
  assert.ok(master.gain.value < 1, 'top volume does not clip');
  ctx.currentTime = 11;
  s.stop();
  assert.deepStrictEqual(ivs, [3], 'the repeat is cleared');
  const last = master.gain.calls[master.gain.calls.length - 1];
  assert.deepStrictEqual(last, ['ramp', 0, 11.1], 'fade out over 0.1 s');
  assert.ok(ctx.nodes.filter(n => n.kind === 'osc').every(o => o.stopped <= 11.13), 'oscillators stop with the fade');
  s.stop();   // twice is harmless
  const before = ctx.nodes.filter(n => n.kind === 'osc').length;
  s.start();
  assert.ok(ctx.nodes.filter(n => n.kind === 'osc').length > before, 'can start again');
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

// ---- round 2 review fixes ----

function slowStt(h) {
  h.sttWait = [];
  h.deps.stt = (audio) => new Promise((resolve) => { h.sttWait.push(() => resolve(audio.text)); });
  h.answerStt = async () => { const f = h.sttWait.shift(); if (f) f(); await tick(); };
}

test('slow transcription: a stop word said 2.5 s after a segment (its text still pending) wins; nothing is sent', async () => {
  const h = harness(); slowStt(h); h.call = voiceCreateCall(h.deps);
  assert.strictEqual(await h.call.start(), true);
  await h.say('delete the files and');            // ends at t=0, transcript pending
  await h.advance(2500);
  await h.say('stop');                            // outside the 2 s window
  await h.answerStt();                            // the first text comes back: 'delete the files and'
  await h.advance(3500);
  await h.answerStt();                            // the stop comes back
  await h.advance(100);
  assert.deepStrictEqual(h.sent, [], 'the earlier text was dropped');
  assert.strictEqual(h.stops, 1);
});

test('slow transcription: a later piece joins an earlier text that is still being transcribed', async () => {
  const h = harness(); slowStt(h); h.call = voiceCreateCall(h.deps);
  await h.call.start();
  await h.say('please open the file');
  await h.advance(4000);
  await h.say('called report.');
  await h.answerStt(); await h.answerStt(); await h.advance(100);
  assert.deepStrictEqual(h.sent, ['please open the file called report.']);
});

test('a cough during the continue wait does not cut the wait short: the rest of it is kept', async () => {
  const h = await started();
  await h.say('please open the file and');
  await h.advance(500);
  h.handlers.onSpeechBegin(); await tick();
  await h.advance(100);
  h.handlers.onMisfire(); await tick();
  await h.advance(2000);
  assert.deepStrictEqual(h.sent, [], 'still waiting (2.6 s of 3 s)');
  await h.advance(500);
  assert.deepStrictEqual(h.sent, ['please open the file and']);
});

test('a cough during the wait, then a real piece, still joins into one message', async () => {
  const h = await started();
  await h.say('please open the file and');
  await h.advance(500);
  h.handlers.onSpeechBegin(); await tick(); h.handlers.onMisfire(); await tick();
  await h.advance(300);
  await h.say('read it to me.');
  await h.advance(2000);
  assert.deepStrictEqual(h.sent, ['please open the file and read it to me.']);
});

test('thinking sound: never starts while the person\'s words are still being transcribed', async () => {
  const h = harness(); slowStt(h); h.deps.thinking = thinking(h); h.call = voiceCreateCall(h.deps);
  await h.call.start();
  await h.say('Please check the system status.');
  h.call.onReplyText('Working. ', false);        // a running reply arms the wait
  await h.finish();
  await h.advance(5000);
  assert.deepStrictEqual(h.think, [], 'no pulse while a transcript is pending');
  await h.answerStt(); await h.advance(2100);
  assert.deepStrictEqual(h.think, ['start'], 'it starts once the turn was sent');
});

test('thinking sound: never starts while a question from the agent waits for the answer', async () => {
  const h = await started(); h.deps.thinking = thinking(h); h.call = voiceCreateCall(h.deps);
  await h.call.start();
  await h.say('Please check the system status.');
  h.call.onAsk({ request_id: 'r1', question: 'Which one?', options: ['Alpha', 'Beta'] });
  await h.finish();
  await h.advance(10000);
  assert.deepStrictEqual(h.think, [], 'no pulse while the question is open');
  await h.say('Alpha');
  await h.advance(2100);
  assert.deepStrictEqual(h.think, ['start'], 'after the answer the turn thinks again');
});

// ---- the thinking clock: one scheduler for the sound and the picture ----

// A harness whose performance clock is offset from the wall clock (perfNow), a sound with pulse(), and a ui that takes pulses.
async function clockHarness(prefs, extra, plan) {
  const h = await started({}, prefs || {});
  h.pulses = []; h.snd = []; h.OFFSET = 5000;
  h.deps.perfNow = () => h.t + h.OFFSET;
  h.deps.thinkingPlan = plan || { seed: 11 };   // a fixed seed: the wait is repeatable
  h.deps.thinking = { pulse: (ev) => h.snd.push(ev), stop: () => h.think.push('stop'), setVolume: (v) => h.think.push('vol ' + v), start: () => h.think.push('start') };
  h.deps.ui = Object.assign({}, h.deps.ui, { thinkingPulse: (ev) => h.pulses.push(ev) }, extra);
  h.call = voiceCreateCall(h.deps);
  assert.strictEqual(await h.call.start(), true);
  return h;
}
const ats = (h) => h.pulses.map(e => e.at - h.OFFSET);
const SHORT = { seed: 11, gapMinMs: 1000, gapSpreadMs: 0 };   // short gaps: several clusters before the 20 s spoken line
// The clock of a wait with seed 11: the small silent pulse at 0, the first cluster at 2000, every next one at the previous one + its length + its own gap.
function waitOffsets(n, plan) {
  const o = [0, 2000];
  for (let i = 0; o.length < n; i++) { const p = voiceThinkingCluster(Object.assign({ seed: 11, index: i }, plan, { index: i })); o.push(o[o.length - 1] + p.durationMs + p.gapAfterMs); }
  return o.slice(0, n);
}

test('thinking clock: a small silent pulse at once, the first cluster at 2 s, then clusters with a 4-6 s quiet gap; sound and picture get the same events', async () => {
  const h = await clockHarness();
  await h.say('Please check the system status.');
  assert.strictEqual(h.pulses.length, 1, 'the first 2 s are not blank');
  assert.deepStrictEqual(h.pulses[0], { at: h.OFFSET + h.t + 20, kind: 'tick', pops: [], attackMs: 250, decayMs: 1000, strength: 0.35 });
  assert.deepStrictEqual(h.snd, [], 'the small pulse is silent');
  const t0 = h.t;
  await h.advance(1990); assert.strictEqual(h.pulses.length, 1);
  await h.advance(20);
  assert.strictEqual(h.pulses.length, 2);
  assert.strictEqual(h.pulses[1].at, h.OFFSET + t0 + 2000 + 20, 'at = the scheduled audio start in the performance clock (+20 ms)');
  assert.strictEqual(h.pulses[1].kind, 'cluster'); assert.strictEqual(h.pulses[1].variant, 'A', 'the default build is A');
  assert.deepStrictEqual(h.pulses[1], voiceThinkingEvent(voiceThinkingCluster({ seed: 11, index: 0 }), h.pulses[1].at), 'the event is the seeded plan');
  assert.ok(h.pulses[1].pops.length >= 5 && h.pulses[1].pops.length <= 7);
  assert.strictEqual(h.snd.length, 1); assert.strictEqual(h.snd[0], h.pulses[1], 'the very same event');
  assert.strictEqual(h.playing[h.playing.length - 1], true, 'the VAD treats the audible cluster as playback');
  await h.advance(17000);
  const want = waitOffsets(h.pulses.length);
  assert.ok(h.pulses.length >= 4, 'pulses ' + h.pulses.length);
  assert.deepStrictEqual(ats(h).map(a => a - 20 - t0), want, 'one clock: each cluster starts at the last one + its length + its gap, no drift');
  for (let i = 2; i < h.pulses.length; i++) { const gap = ats(h)[i] - ats(h)[i - 1] - h.pulses[i - 1].durationMs; assert.ok(gap >= 4000 && gap <= 6000, 'quiet gap 4-6 s: ' + gap); }
  assert.deepStrictEqual(h.snd, h.pulses.slice(1), 'every audible cluster is a shown cluster');
  assert.deepStrictEqual(h.think.filter(x => x === 'start'), [], 'a sound with pulse() is not started with its own interval');
});

test('thinking clock: the same seed repeats the wait; another variant and gap range are injected, not saved; no seed is random', async () => {
  const run = async (plan) => { const h = await clockHarness(); h.deps.thinkingPlan = plan; h.call = voiceCreateCall(h.deps); await h.call.start(); await h.say('Please check the system status.'); await h.advance(30000); return h; };
  const a = await run({ seed: 5 }), b = await run({ seed: 5 });
  assert.deepStrictEqual(a.pulses.map(e => [e.at - a.OFFSET - 20, e.pops]), b.pulses.map(e => [e.at - b.OFFSET - 20, e.pops]));
  const c = await run({ seed: 5, variant: 'C', gapMinMs: 4000, gapSpreadMs: 2000 });
  assert.ok(c.pulses.slice(1).every(e => e.variant === 'C' && e.pops.length === 1), 'C: a single pop each time');
  const g = await run({ seed: 5, variant: 'B', gapMinMs: 100, gapSpreadMs: 0 });
  assert.ok(g.pulses.length > a.pulses.length, 'a tuned gap changes the rhythm');
  assert.ok(g.pulses.slice(2).every((e, i) => e.at - g.pulses[i + 1].at - g.pulses[i + 1].durationMs === 100), 'gap min 100, spread 0');
  const r1 = await run(undefined), r2 = await run(undefined);
  assert.notDeepStrictEqual(r1.pulses[1].pops, r2.pulses[1].pops, 'no seed: every wait is new');
});

test('thinking clock: sound switched off: the same clock runs, nothing is heard, the VAD is never told about playback; do-not-disturb does not change that (audible, same rhythm)', async () => {
  const seen = [];
  for (const mode of ['pref', 'dnd']) {
    const h = await clockHarness(mode === 'pref' ? { thinkingSound: false } : {}, undefined, SHORT);
    if (mode === 'dnd') h.call.setMode('dnd');
    await h.say('Please check the system status.');
    const t0 = h.t;
    await h.advance(15000);
    assert.deepStrictEqual(ats(h).map(a => a - 20 - t0), waitOffsets(h.pulses.length, SHORT), mode);
    assert.ok(h.pulses.length >= 4);
    assert.deepStrictEqual(h.pulses.map(e => e.strength), h.pulses.map((e, i) => (i === 0 ? 0.35 : 1)));
    assert.ok(h.pulses.slice(1).every(e => e.pops.length >= 4), 'the picture still gets the pop times of each cluster');
    if (mode === 'pref') { assert.deepStrictEqual(h.snd, [], 'no audio'); assert.ok(!h.playing.includes(true), 'inaudible pulses are not playback'); }
    else { assert.deepStrictEqual(h.snd, h.pulses.slice(1), 'do-not-disturb: every cluster is heard, as with no display'); assert.ok(h.playing.includes(true)); }
    seen.push(h.pulses.map(e => [e.at, e.pops]));
  }
  assert.deepStrictEqual(seen[0], seen[1], 'sound off and do-not-disturb show the identical rhythm');
});

test('thinking clock: muting and unmuting mid-wait changes only the sound, the phase goes on', async () => {
  const h = await clockHarness(undefined, undefined, SHORT);
  await h.say('Please check the system status.');
  const t0 = h.t, W = waitOffsets(8, SHORT);
  await h.advance(2100);   // the first cluster is playing
  assert.strictEqual(h.snd.length, 1);
  h.prefs.thinkingSound = false; h.call.setPrefs();
  assert.strictEqual(h.think.filter(x => !x.startsWith('vol')).pop(), 'stop', 'muted now');
  assert.strictEqual(h.playing[h.playing.length - 1], false);
  await h.advance(W[2] - 2100 + 100);   // cluster 2 is silent but shown
  assert.strictEqual(h.pulses.length, 3); assert.strictEqual(h.snd.length, 1);
  h.prefs.thinkingSound = true; h.call.setPrefs();
  await h.advance(W[3] - W[2]);   // cluster 3 is audible again
  assert.deepStrictEqual(ats(h).map(a => a - 20 - t0), W.slice(0, 4), 'unchanged phase');
  assert.strictEqual(h.snd.length, 2);
  h.call.setMode('dnd');
  await h.advance(W[4] - W[3]); assert.strictEqual(h.snd.length, 3, 'do-not-disturb does not mute the next cluster (the same as with no display)'); assert.strictEqual(h.pulses.length, 5);
  h.call.setMode('announce');
  await h.advance(W[5] - W[4]); assert.strictEqual(h.snd.length, 4); assert.strictEqual(h.snd[3], h.pulses[5]);
});

test('thinking clock: stops at once on reply speech, the person speaking and release; no timer is left behind', async () => {
  let h = await clockHarness();
  await h.say('Please check the system status.'); await h.advance(2100);
  h.begin();   // the person speaks
  const n = h.pulses.length; await h.advance(20000); assert.strictEqual(h.pulses.length, n, 'quiet while the person speaks');
  assert.strictEqual(h.think[h.think.length - 1], 'stop');
  h = await clockHarness();
  await h.say('Please check the system status.'); await h.advance(2100);
  const before = h.pulses.length;
  h.call.onReplyText('All good. ', false);
  await h.advance(10000); assert.strictEqual(h.pulses.length, before, 'reply speech stops the clock');
  assert.strictEqual(h.think[h.think.length - 1], 'stop');
  await h.finish();   // the reply is not over: the wait for the rest starts a fresh clock (small pulse first)
  assert.strictEqual(h.pulses.length, before + 1); assert.strictEqual(h.pulses[before].strength, 0.35);
  h.call.onReplyText('All good. Nothing is wrong.', true); await h.finish();
  await h.advance(60000); assert.strictEqual(h.pulses.length, before + 1, 'nothing when the turn ends');
  h = await clockHarness();
  await h.say('Please check the system status.'); await h.advance(2100);
  h.call.release('hidden');
  const m = h.pulses.length; await h.advance(60000); assert.strictEqual(h.pulses.length, m);
  assert.deepStrictEqual(h.timers.filter(x => x.fn.name === 'thinkTick'), [], 'no thinking timer left after the call ended');
});

test('thinking clock: the spoken still-thinking line uses the speaking state, the clock stops, then thinking restarts it with a small pulse', async () => {
  const states = [];
  const h = await clockHarness({}, { state: (s) => states.push(s) });
  await h.say('Please check the system status.');
  await h.advance(20500);
  assert.strictEqual(h.spoken.length, 1);
  assert.strictEqual(states[states.length - 1], 'speaking');
  const n = h.pulses.length;
  await h.advance(10000); assert.strictEqual(h.pulses.length, n, 'no pulses while the line is spoken');
  await h.finish();
  assert.strictEqual(states[states.length - 1], 'thinking', 'back to thinking after the line');
  assert.strictEqual(h.pulses.length, n + 1);
  assert.strictEqual(h.pulses[n].strength, 0.35, 'a fresh wait: a small pulse first');
  const t0 = h.t;
  await h.advance(2100);
  assert.strictEqual(h.pulses[n + 1].strength, 1);
  assert.strictEqual(h.pulses[n + 1].at - h.OFFSET, t0 + 2020);
});

test('thinking clock: runs with only a picture (no sound adapter); an older ui without thinkingPulse starts no clock', async () => {
  const h = await started({}, {});
  h.pulses = []; h.deps.ui = Object.assign({}, h.deps.ui, { thinkingPulse: (e) => h.pulses.push(e) }); h.deps.thinking = undefined; h.deps.thinkingPlan = { seed: 11 };
  h.call = voiceCreateCall(h.deps); await h.call.start();
  await h.say('Please check the system status.'); await h.advance(5000);
  assert.strictEqual(h.pulses.length, 2, 'the small pulse and the first cluster');
  assert.ok(!h.playing.includes(true));
  const g = await started({}, {});   // neither a sound nor thinkingPulse
  await g.say('Please check the system status.');
  await g.advance(5000);
  assert.deepStrictEqual(g.think, [], 'no sound adapter: nothing called, no error');
});

test('thinking clock: without lib/ui-voice-thinking.js the old single swell every 2.5 s is used', async () => {
  const keep = globalThis.voiceThinkingCluster; delete globalThis.voiceThinkingCluster;
  try {
    const h = await clockHarness(); await h.say('Please check the system status.');
    const t0 = h.t; await h.advance(10000);
    assert.deepStrictEqual(ats(h).map(a => a - 20 - t0), [0, 2000, 4500, 7000, 9500]);
    assert.deepStrictEqual(h.pulses[1], { at: h.pulses[1].at, kind: 'cluster', pops: [], attackMs: 250, decayMs: 1000, strength: 1 });
  } finally { globalThis.voiceThinkingCluster = keep; }
});

test('thinking sound: pulse() plays ONE cluster with no interval of its own and stop() still fades it', () => {
  const ctx = fakeCtx(), ivs = [];
  const s = voiceCreateThinkingSound({ ctx, volume: 1, setInterval: (f, ms) => { ivs.push(ms); return 1; }, clearInterval: () => {} });
  s.pulse();
  const n1 = ctx.nodes.filter(n => n.kind === 'osc').length;
  assert.ok(n1 >= 4 && n1 <= 7, 'a cluster of a fresh seed: ' + n1);
  assert.deepStrictEqual(ivs, [], 'the call\'s clock repeats it');
  assert.strictEqual(s.playing, true);
  s.pulse(); assert.ok(ctx.nodes.filter(n => n.kind === 'osc').length >= 2 * 4);
  const master = ctx.nodes.find(n => n.kind === 'gain' && n.connected.includes(ctx.destination));
  assert.ok(Math.abs(master.gain.value - voiceThinkingPeak(1)) < 1e-9);
  s.stop(); assert.strictEqual(s.playing, false);
  assert.ok(ctx.nodes.filter(n => n.kind === 'osc').every(o => o.stopped !== null));
});

// ---- the thinking pulse: the picture gets the time the sound is HEARD (audio output clock), from the same event ----

function syncCtx(extra) {
  const c = fakeCtx();
  c.perf = 5000;   // the performance clock the sound reads
  return Object.assign(c, extra);
}
const oscStarts = (ctx) => ctx.nodes.filter(n => n.kind === 'osc').map(o => o.started);

test('thinking sound pulse(event): schedules the event\'s pops once from currentTime + 20 ms and maps event.at with getOutputTimestamp to the heard time', () => {
  const ctx = syncCtx({ getOutputTimestamp: () => ({ contextTime: 9.86, performanceTime: 5000 }) });   // the speaker is 140 ms behind currentTime
  const s = voiceCreateThinkingSound({ ctx, volume: 1, perfNow: () => ctx.perf });
  const ev = voiceThinkingEvent(voiceThinkingCluster({ seed: 3, index: 0 }), 5020), keys = Object.keys(ev).join();
  const r = s.pulse(ev);
  assert.strictEqual(r, ev, 'the same event comes back');
  assert.deepStrictEqual(oscStarts(ctx).map(t => Math.round((t - 10.02) * 1000)), ev.pops.map(p => p.tMs), 'one pop per planned pop, tMs after the cluster start');
  assert.ok(Math.abs(ev.at - (5000 + (10.02 - 9.86) * 1000)) < 1e-6, 'at = performance time of the sample at t0: ' + ev.at);   // 5160
  assert.strictEqual(Object.keys(ev).join(), keys, 'no field added');
  assert.deepStrictEqual(oscStarts(ctx).length, ev.pops.length, 'scheduled exactly once');
});

test('thinking sound pulse(event): no usable output timestamp: now + lead + outputLatency (else baseLatency); all unsupported: the original at stays', () => {
  const run = (extra, perf) => {
    const ctx = syncCtx(extra), ev = { at: 5020 };
    const s = voiceCreateThinkingSound({ ctx, volume: 1, perfNow: perf || (() => ctx.perf) });
    return { ev, ret: s.pulse(ev), ctx };
  };
  assert.ok(Math.abs(run({ outputLatency: 0.15, baseLatency: 0.01 }).ev.at - 5170) < 1e-6, 'outputLatency preferred');
  assert.ok(Math.abs(run({ outputLatency: 0, baseLatency: 0.01 }).ev.at - 5030) < 1e-6, 'baseLatency when there is no output latency');
  assert.ok(Math.abs(run({}).ev.at - 5020) < 1e-6, 'no latency known: now + 20 ms');
  // a timestamp function that throws, or answers rubbish, is not trusted
  for (const bad of [() => { throw new Error('x'); }, () => null, () => ({ contextTime: NaN, performanceTime: 5000 }), () => ({ contextTime: 0, performanceTime: 0 }),
    () => ({ contextTime: 9.86, performanceTime: -5 }), () => ({ contextTime: 9.86, performanceTime: 1 }),     // stale: maps far in the past
    () => ({ contextTime: 9.86, performanceTime: 99999 })]) {                                                     // wild: maps far ahead
    const { ev } = run({ getOutputTimestamp: bad, outputLatency: 0.1 });
    assert.ok(Math.abs(ev.at - 5120) < 1e-6, 'fallback used: ' + ev.at);
  }
  // no performance clock, or a context time that is not a number: the controller's event is left alone
  assert.strictEqual(run({}, () => NaN).ev.at, 5020);
  const nan = run({ currentTime: NaN, outputLatency: 0.1 }); assert.strictEqual(nan.ev.at, 5020); assert.strictEqual(nan.ret, nan.ev);
});

test('thinking sound pulse(event): a suspended or closed context claims nothing: no oscillator, event untouched, false, and a resume is asked for', () => {
  for (const state of ['suspended', 'closed', 'interrupted']) {
    let resumed = 0;
    const ctx = syncCtx({ state, resume() { resumed++; return Promise.resolve(); }, outputLatency: 0.2 });
    const s = voiceCreateThinkingSound({ ctx, volume: 1, perfNow: () => ctx.perf });
    const ev = voiceThinkingEvent(voiceThinkingCluster({ seed: 3 }), 5020);
    assert.strictEqual(s.pulse(ev), false, state);
    assert.strictEqual(ev.at, 5020);
    assert.strictEqual(ctx.nodes.length, 0, 'nothing scheduled, no master made');
    assert.strictEqual(s.playing, false, 'not claimed');
    assert.strictEqual(resumed, state === 'suspended' ? 1 : 0);
    ctx.state = 'running';   // resumed: the next cluster plays
    assert.strictEqual(s.pulse(ev), ev); assert.strictEqual(oscStarts(ctx).length, ev.pops.length); assert.ok(Math.abs(ev.at - 5220) < 1e-6);
  }
});

test('thinking sound: the older API is kept: start() with its interval, pulse() without an event, pulse(undefined) returns nothing and moves nothing', () => {
  const ctx = syncCtx({ state: 'suspended' }), ivs = [];
  const s = voiceCreateThinkingSound({ ctx, volume: 1, setInterval: (f, ms) => { ivs.push(ms); return 1; }, clearInterval() {} });
  s.pulse();   // no event: scheduled as before, even on a suspended context
  const n = oscStarts(ctx).length; assert.ok(n >= 4); assert.strictEqual(s.pulse(), undefined);
  s.stop();
  const s2 = voiceCreateThinkingSound({ ctx: syncCtx(), volume: 1, setInterval: (f, ms) => { ivs.push(ms); return 1; }, clearInterval() {} });
  s2.start(); assert.deepStrictEqual(ivs, [6500]); assert.strictEqual(s2.playing, true);
});

test('thinking pulse: the controller delivers the SAME event to the sound (mapped to the heard time) and then to the picture', async () => {
  const h = await started({}, {});
  const OFFSET = 5000; h.deps.perfNow = () => h.t + OFFSET; h.deps.thinkingPlan = { seed: 11 };
  const ctx = syncCtx({ outputLatency: 0.14 });
  ctx.getOutputTimestamp = () => ({ contextTime: ctx.currentTime - 0.14, performanceTime: h.t + OFFSET });
  const snd = voiceCreateThinkingSound({ ctx, volume: 1, perfNow: () => h.t + OFFSET });
  const log = [];
  h.deps.thinking = { pulse: (ev) => { const r = snd.pulse(ev); log.push({ who: 'audio', ev, at: ev.at, t: h.t, ret: r }); return r; }, stop() { snd.stop(); }, setVolume(v) { snd.setVolume(v); } };
  h.deps.ui = Object.assign({}, h.deps.ui, { thinkingPulse: (ev) => log.push({ who: 'visual', ev, at: ev.at, t: h.t }) });
  h.call = voiceCreateCall(h.deps);
  assert.strictEqual(await h.call.start(), true);
  await h.say('Please check the system status.');
  const t0 = h.t;
  assert.deepStrictEqual(log.map(l => l.who), ['visual'], 'the small first pulse is silent: the controller clock');
  assert.strictEqual(log[0].at, OFFSET + t0 + 20);
  await h.advance(2010);
  assert.deepStrictEqual(log.map(l => l.who), ['visual', 'audio', 'visual']);
  const [, a, v] = log;
  assert.strictEqual(a.ev, v.ev, 'one event object');
  assert.strictEqual(a.ret, a.ev);
  assert.strictEqual(a.at, v.at, 'the picture sees the time the audio mapped');
  assert.ok(Math.abs(v.at - (OFFSET + t0 + 2000 + 20 + 140)) < 1e-6, 'the heard time = scheduled + 20 ms lead + 140 ms output latency: ' + (v.at - OFFSET - t0));
  assert.strictEqual(a.t, v.t, 'sound and picture in the same instant of the clock');
  assert.strictEqual(oscStarts(ctx).length, a.ev.pops.length, 'scheduled exactly once');
  const W = waitOffsets(3);
  await h.advance(W[2] - 2010 + 10);
  assert.strictEqual(oscStarts(ctx).length, a.ev.pops.length + log[log.length - 2].ev.pops.length); assert.strictEqual(log.length, 5);
  assert.strictEqual(h.playing[h.playing.length - 1], true);
});

test('thinking pulse: a sound that mutates nothing keeps the controller clock; one that returns a different event with a sane at is adopted into the same event; a wild one is ignored', async () => {
  const cases = [['same', () => undefined, 2020], ['returned', (ev) => ({ ...ev, at: ev.at + 150 }), 2170], ['wild-late', (ev) => ({ at: ev.at + 99999 }), 2020], ['stale', (ev) => ({ at: 1 }), 2020],
    ['nan', (ev) => { ev.at = NaN; }, 2020], ['mutated', (ev) => { ev.at += 90; }, 2110]];
  for (const [name, fn, want] of cases) {
    const h = await clockHarness();
    const seen = [];
    h.deps.thinking.pulse = (ev) => { seen.push(ev); return fn(ev); };
    h.call = voiceCreateCall(h.deps); await h.call.start();
    await h.say('Please check the system status.');
    const t0 = h.t; await h.advance(2010);
    assert.strictEqual(seen.length, 1, name); assert.strictEqual(h.pulses.length, 2, name);
    assert.strictEqual(seen[0], h.pulses[1], name + ': same object');
    assert.strictEqual(h.pulses[1].at - h.OFFSET - t0, want, name);
  }
});

test('thinking pulse: a sound that did not play (false) is not audible: no playback claim, the picture still gets the controller clock; the next pulse can sound', async () => {
  const h = await clockHarness();
  let ok = false; const seen = [];
  h.deps.thinking.pulse = (ev) => { seen.push(ev); return ok ? ev : false; };
  h.call = voiceCreateCall(h.deps); await h.call.start();
  await h.say('Please check the system status.');
  const t0 = h.t; await h.advance(2010);
  assert.strictEqual(h.pulses.length, 2); assert.strictEqual(h.pulses[1].at - h.OFFSET - t0, 2020, 'controller clock');
  assert.strictEqual(h.playing[h.playing.length - 1], false, 'the VAD was not told the pulse is playback');
  ok = true; await h.advance(waitOffsets(3)[2] - 2010 + 10);
  assert.strictEqual(h.pulses.length, 3); assert.strictEqual(seen[1], h.pulses[2]); assert.strictEqual(h.playing[h.playing.length - 1], true);
});

test('thinking pulse: muted never calls the sound and keeps the controller clock and phase; do-not-disturb sounds like any other time, phase unchanged by mapping', async () => {
  const h = await clockHarness({ thinkingSound: false }, undefined, SHORT);
  let calls = 0; h.deps.thinking.pulse = (ev) => { calls++; ev.at += 500; return ev; };
  h.call = voiceCreateCall(h.deps); await h.call.start();
  await h.say('Please check the system status.');
  const t0 = h.t; await h.advance(10000);
  assert.strictEqual(calls, 0);
  assert.deepStrictEqual(ats(h).map(a => a - 20 - t0), waitOffsets(h.pulses.length, SHORT));
  // audible with a +160 ms mapping: clusters are still scheduled from the controller clock (no drift, no second timer)
  const g = await clockHarness(undefined, undefined, SHORT);
  g.deps.thinking.pulse = (ev) => { ev.at += 160; return ev; };
  g.call = voiceCreateCall(g.deps); await g.call.start();
  await g.say('Please check the system status.');
  const u0 = g.t; await g.advance(10000);
  const W = waitOffsets(g.pulses.length, SHORT);
  assert.deepStrictEqual(ats(g).slice(1).map(a => a - 20 - 160 - u0), W.slice(1), 'phase unchanged by the mapping');
  g.call.setMode('dnd'); const n = g.pulses.length; await g.advance(waitOffsets(n + 1, SHORT)[n] - 10000 + 10);
  assert.strictEqual(g.pulses.length, n + 1); assert.strictEqual(g.pulses[n].at - g.OFFSET - 20 - 160 - u0, waitOffsets(n + 1, SHORT)[n], 'dnd: still sounded (mapped +160), same phase');
});
