'use strict';
// The call's thinking sound, audible and steady: the master gain peaks at -16 dBFS at volume 0.5, it connects to opts.out (the
// speech's loudness chain on the pages) instead of ctx.destination, and a wait has its first audible cluster 1 s after it
// starts and then one every cluster length + 1 to 2 s. Fake audio context, fake clock, fake vad.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
Object.assign(globalThis, require('../lib/ui-voice'), require('../lib/ui-voice-thinking'));   // the call file uses these helpers as globals, like the pages
const { voiceCreateCall, voiceCreateThinkingSound } = require('../lib/ui-voice-call');

const tick = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const db = (g) => 20 * Math.log10(g);

function fakeCtx() {
  const c = { nodes: [], currentTime: 10, state: 'running', destination: { kind: 'dest', connect() {} } };
  const param = (v) => ({ value: v, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} });
  const node = (kind, extra) => { const n = Object.assign({ kind, connected: [], connect(x) { this.connected.push(x); }, disconnect() {} }, extra); c.nodes.push(n); return n; };
  c.createGain = () => node('gain', { gain: param(1) });
  c.createOscillator = () => node('osc', { type: '', frequency: param(0), start() {}, stop() {} });
  c.createBiquadFilter = () => node('filter', { type: '', frequency: param(0), Q: param(1) });
  return c;
}
// the gain that the sound made and connected to something other than another gain of its own (the master)
const masterOf = (ctx) => ctx.nodes.find(n => n.kind === 'gain' && n.connected.length > 0 && n.connected.every(x => !ctx.nodes.includes(x)));
const noop = { setInterval: () => 1, clearInterval: () => {} };

test('out as a node: the master gain connects to it and not to ctx.destination (start and pulse)', () => {
  for (const how of ['start', 'pulse']) {
    const ctx = fakeCtx(), sink = { kind: 'sink', connect() {} };
    const s = voiceCreateThinkingSound({ ctx, volume: 0.5, out: sink, ...noop });
    if (how === 'start') s.start(); else s.pulse();
    const m = masterOf(ctx);
    assert.ok(m, how + ': a master gain was made');
    assert.deepStrictEqual(m.connected, [sink], how + ': connected to out only');
    assert.ok(!m.connected.includes(ctx.destination));
  }
});

test('out as a function (ctx) => node: called with the context; the master connects to what it returns', () => {
  const ctx = fakeCtx(), sink = { kind: 'sink', connect() {} }, seen = [];
  const s = voiceCreateThinkingSound({ ctx, volume: 0.5, out: (c) => { seen.push(c); return sink; }, ...noop });
  s.start();
  assert.ok(seen.length >= 1 && seen.every(c => c === ctx), 'asked with the context');
  assert.deepStrictEqual(masterOf(ctx).connected, [sink]);
});

test('without a usable out (absent, throws, nothing, no connect) the master connects to ctx.destination; a usable out does not', () => {
  const sink = { kind: 'sink', connect() {} };
  const bad = [undefined, null, () => { throw new Error('no chain'); }, () => null, () => undefined, () => ({}), {}, 'x'];
  for (const out of bad) {
    const ctx = fakeCtx();
    voiceCreateThinkingSound({ ctx, volume: 0.5, out, ...noop }).start();
    assert.deepStrictEqual(masterOf(ctx).connected, [ctx.destination], 'fallback for ' + String(out));
  }
  const ctx = fakeCtx();
  voiceCreateThinkingSound({ ctx, volume: 0.5, out: sink, ...noop }).start();
  assert.ok(!masterOf(ctx).connected.includes(ctx.destination), 'a usable out is the only target');
});

test('the master gain: volume 0.5 is -16 dBFS, volume 1 is -9.98 dBFS, setVolume follows', () => {
  for (const [v, want] of [[0.5, -16], [1, -9.98]]) {
    const ctx = fakeCtx();
    voiceCreateThinkingSound({ ctx, volume: v, ...noop }).start();
    assert.ok(Math.abs(db(masterOf(ctx).gain.value) - want) < 0.1, 'volume ' + v + ': ' + db(masterOf(ctx).gain.value));
  }
  const ctx = fakeCtx(), s = voiceCreateThinkingSound({ ctx, volume: 0.25, ...noop });
  s.start(); s.setVolume(1);
  assert.ok(Math.abs(db(masterOf(ctx).gain.value) + 9.98) < 0.1);
});

test('without voiceThinkingPeak (the lib not loaded) the sound uses the same -16 dBFS formula', () => {
  const keep = globalThis.voiceThinkingPeak; delete globalThis.voiceThinkingPeak;
  try {
    for (const [v, want] of [[0.5, -16], [1, -9.98]]) {
      const ctx = fakeCtx();
      voiceCreateThinkingSound({ ctx, volume: v, ...noop }).start();
      assert.ok(Math.abs(db(masterOf(ctx).gain.value) - want) < 0.1, 'volume ' + v);
    }
  } finally { globalThis.voiceThinkingPeak = keep; }
});

function harness() {
  const h = { t: 0, timers: [], nextId: 1, handlers: null, clusters: [], prefs: { continueWait: 3000, thinkingSound: true, thinkingVolume: 0.5 }, running: false };
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
  const ctx = fakeCtx(), snd = voiceCreateThinkingSound({ ctx, volume: 0.5, ...noop });
  h.deps = {
    agent: 'a1', now: () => h.t, setTimer: h.setTimer, clearTimer: h.clearTimer, prefs: () => h.prefs, thinkingPlan: { seed: 11 },
    vad: { start: async (hd) => { h.handlers = hd; }, stop() {}, setPlaybackActive() {} },
    stt: async (audio) => audio.text, isTurnRunning: () => h.running,
    send: async () => { h.running = true; }, interject: async () => {}, stop: () => {}, speak: () => new Promise(() => {}), cancelSpeech: () => {}, answerAsk: () => {},
    server: { start: async () => ({ callId: 'c1', held: [] }), heartbeat: async () => ({ held: [] }), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} },
    ui: { thinkingPulse() {}, state() {}, heard() {}, held() {}, toast() {}, summary() {}, level() {}, activity() {} },
    thinking: { pulse: (ev) => { const r = snd.pulse(ev); if (r && ev.kind === 'cluster') h.clusters.push({ t: h.t, durationMs: ev.durationMs, gapAfterMs: ev.gapAfterMs }); return r; }, stop: () => snd.stop(), setVolume: (v) => snd.setVolume(v), start: () => {} },
  };
  h.call = voiceCreateCall(h.deps);
  h.say = async (text) => { h.handlers.onSpeechStart(); h.handlers.onSpeechEnd({ text }); await tick(); };
  return h;
}

test('a wait: the first audible cluster 1000 ms after it starts, then one every cluster length + 1000 to 2000 ms', async () => {
  const h = harness();
  assert.strictEqual(await h.call.start(), true);
  await h.say('Please check the system status.');
  const t0 = h.t;
  await h.advance(900); assert.strictEqual(h.clusters.length, 0, 'nothing audible before 1 s');
  await h.advance(200); assert.strictEqual(h.clusters.length, 1);
  assert.strictEqual(h.clusters[0].t - t0, 1000, 'the first cluster at 1000 ms');
  await h.advance(15000);
  assert.ok(h.clusters.length >= 4, 'clusters: ' + h.clusters.length);
  for (let i = 1; i < h.clusters.length; i++) {
    const a = h.clusters[i - 1], b = h.clusters[i], gap = b.t - a.t - a.durationMs;
    assert.ok(gap >= 1000 && gap <= 2000, 'gap ' + gap);
    assert.strictEqual(gap, a.gapAfterMs, 'the planned gap');
  }
});

test('the pages send the thinking sound through the speech chain: voiceOutNode in both calls of voiceThinkingDeps (mobile.js) and voiceCallThinking (app.js)', () => {
  const root = path.join(__dirname, '..');
  const body = (file, name) => {
    const src = fs.readFileSync(path.join(root, file), 'utf8'), i = src.indexOf('function ' + name + '(');
    assert.ok(i >= 0, name + ' is in ' + file);
    const j = src.indexOf('\n  return {', i);
    return src.slice(i, src.indexOf('\n}\n', j) > 0 ? src.indexOf('\n}\n', j) : i + 4000);
  };
  const m = body('mobile.js', 'voiceThinkingDeps');
  const mc = m.match(/voiceCreateThinkingSound\(\{[^}]*\}\)/g) || [];
  assert.strictEqual(mc.length, 2, 'mobile.js: two sounds are made');
  for (const c of mc) assert.ok(/out:\s*\(c\)\s*=>\s*voiceOutNode\(c\)/.test(c), 'mobile.js: ' + c);
  const srcA = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const i = srcA.indexOf('function voiceCallThinking('); assert.ok(i >= 0);
  const a = srcA.slice(i, i + 3500);
  const ac = a.match(/voiceCreateThinkingSound\(\{[^}]*\}\)/g) || [];
  assert.strictEqual(ac.length, 2, 'app.js: two sounds are made');
  for (const c of ac) assert.ok(/out:\s*\(c\)\s*=>\s*voiceOutNode\(c\)/.test(c), 'app.js: ' + c);
});
