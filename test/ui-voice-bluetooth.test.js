'use strict';
// Voice over Bluetooth and car audio, part A (the shared libs): the echo-guard and keep-alive settings, the car test sound and
// its echo analysis, the VAD adapter's echo hold-over, constraint fallback, sample-rate guard and microphone-lost handling,
// the call controller's keep-alive lead-in and mic messages, and the keep-alive sound. Fake clock, fake browser, fake tracks.
const { test } = require('node:test');
const assert = require('node:assert');
Object.assign(globalThis, require('../lib/ui-voice'));   // the call file uses these helpers as globals, like the pages
const V = require('../lib/ui-voice');
const C = require('../lib/ui-voice-call');
const { voiceCreateCall, voiceCreateVad, voiceLiveTracks } = C;

const tick = async (n = 30) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

// ---- settings ----

test('prefs: echoHold defaults to 600 and keeps 0 / 600 / 1000 / 1500 only; keepAlive is a boolean defaulting to true', () => {
  assert.deepStrictEqual(V.VOICE_ECHO_HOLDS, [0, 600, 1000, 1500]);
  assert.strictEqual(V.voiceCleanPrefs(null).echoHold, 600);
  assert.strictEqual(V.voiceCleanPrefs({}).echoHold, 600);
  for (const v of [0, 600, 1000, 1500]) assert.strictEqual(V.voiceCleanPrefs({ echoHold: v }).echoHold, v, String(v));
  for (const v of [750, -1, '1000', null, NaN]) assert.strictEqual(V.voiceCleanPrefs({ echoHold: v }).echoHold, 600, String(v));
  assert.strictEqual(V.voiceCleanPrefs(null).keepAlive, true);
  assert.strictEqual(V.voiceCleanPrefs({ keepAlive: false }).keepAlive, false);
  assert.strictEqual(V.voiceCleanPrefs({ keepAlive: true }).keepAlive, true);
  assert.strictEqual(V.voiceCleanPrefs({ keepAlive: 'no' }).keepAlive, true);
  const store = new Map(); const st = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  V.voiceSavePrefs(st, { echoHold: 1500, keepAlive: false });
  const back = V.voiceLoadPrefs(st);
  assert.deepStrictEqual([back.echoHold, back.keepAlive], [1500, false]);
});

// ---- the car test sound and its analysis ----

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rmsOf = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); };
function noise(n, db, seed) { const r = rng(seed), amp = Math.pow(10, db / 20) * Math.sqrt(3), out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = (r() * 2 - 1) * amp; return out; }
// A recording of 2 s: noise at noiseDb, plus (when delayMs is given) the chirp copy at echoDb (its RMS) from delayMs on.
function recording(rate, chirp, delayMs, echoDb, noiseDb, seed) {
  const rec = noise(rate * 2, noiseDb, seed);
  if (delayMs != null) {
    const g = Math.pow(10, echoDb / 20) / rmsOf(chirp), at = Math.round(delayMs * rate / 1000);
    for (let i = 0; i < chirp.length; i++) rec[at + i] += chirp[i] * g;
  }
  return rec;
}

test('voiceCarChirp: 120 ms linear sweep 500 to 3000 Hz, Hann window, peak 0.5', () => {
  for (const rate of [8000, 16000, 48000]) {
    const c = V.voiceCarChirp(rate);
    assert.ok(c instanceof Float32Array);
    assert.strictEqual(c.length, Math.round(rate * 0.12), 'length at ' + rate);
    let peak = 0; for (const x of c) peak = Math.max(peak, Math.abs(x));
    assert.ok(Math.abs(peak - 0.5) < 0.01, 'peak ' + peak);
    assert.ok(Math.abs(c[0]) < 0.01 && Math.abs(c[c.length - 1]) < 0.01, 'windowed ends');
  }
  const c = V.voiceCarChirp(48000);
  const zc = (a, b) => { let n = 0; for (let i = a + 1; i < b; i++) if ((c[i - 1] < 0) !== (c[i] < 0)) n++; return n; };
  assert.ok(zc(Math.floor(c.length * 0.7), Math.floor(c.length * 0.9)) > 2 * zc(Math.floor(c.length * 0.1), Math.floor(c.length * 0.3)), 'the pitch rises');
});

test('voiceEchoAnalysis: finds a 230 ms echo at -20 dB under -50 dB noise at 8, 16 and 48 kHz', () => {
  for (const rate of [8000, 16000, 48000]) {
    const chirp = V.voiceCarChirp(rate), rec = recording(rate, chirp, 230, -20, -50, rate);
    const r = V.voiceEchoAnalysis(chirp, rec, rate);
    assert.ok(r.delayMs !== null && Math.abs(r.delayMs - 230) <= 3, rate + ' Hz delay ' + r.delayMs);
    assert.ok(r.confidence > 0.5 && r.confidence <= 1.0001, rate + ' Hz confidence ' + r.confidence);
    assert.ok(Math.abs(r.echoDb - -20) <= 2, rate + ' Hz echoDb ' + r.echoDb);
  }
});

test('voiceEchoAnalysis: pure noise finds no echo; silence is -Infinity; maxDelayMs limits the search; fast at 48 kHz', () => {
  for (const rate of [8000, 16000, 48000]) {
    const chirp = V.voiceCarChirp(rate), r = V.voiceEchoAnalysis(chirp, noise(rate * 2, -50, 7), rate);
    assert.strictEqual(r.delayMs, null, rate + ' Hz noise');
    assert.ok(r.confidence < 0.3);
  }
  const chirp = V.voiceCarChirp(16000);
  const sil = V.voiceEchoAnalysis(chirp, new Float32Array(32000), 16000);
  assert.strictEqual(sil.delayMs, null); assert.strictEqual(sil.echoDb, -Infinity);
  const late = recording(16000, chirp, 900, -20, -60, 3);
  assert.strictEqual(V.voiceEchoAnalysis(chirp, late, 16000, { maxDelayMs: 500 }).delayMs, null, 'beyond maxDelayMs');
  assert.ok(Math.abs(V.voiceEchoAnalysis(chirp, late, 16000).delayMs - 900) <= 3, 'default 1500 ms reaches it');
  const c48 = V.voiceCarChirp(48000), rec = recording(48000, c48, 1200, -25, -50, 11);
  V.voiceEchoAnalysis(c48, rec, 48000);   // warm up
  const t0 = process.hrtime.bigint();
  const r = V.voiceEchoAnalysis(c48, rec, 48000);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(Math.abs(r.delayMs - 1200) <= 3);
  assert.ok(ms < 100, 'took ' + ms.toFixed(1) + ' ms (target 50)');
});

test('voiceCarCheckResult: echo guard from the delay, interrupt sensitivity from the level, and the spoken lines', () => {
  const cur = { echoHold: 600, interruptSensitivity: 50 };
  const A = (d, db = -55) => ({ delayMs: d, echoDb: db, confidence: 0.8 });
  let r = V.voiceCarCheckResult([A(230), A(240), A(250)], cur);
  assert.deepStrictEqual([r.heard, r.echoHold, r.interruptSensitivity, r.delayMs, r.echoDb], [true, 600, 50, 240, -55]);
  assert.strictEqual(r.line, 'The echo comes back after 240 ms. Echo guard set to 0.6 s.');
  r = V.voiceCarCheckResult([A(700), A(720), A(690)], cur);
  assert.strictEqual(r.echoHold, 1000); assert.strictEqual(r.delayMs, 700);
  assert.strictEqual(r.line, 'The echo comes back after 700 ms. Echo guard set to 1 s.');
  r = V.voiceCarCheckResult([A(1300), A(1310), A(1290)], cur);
  assert.strictEqual(r.echoHold, 1500);
  assert.strictEqual(r.line, 'The echo comes back after 1300 ms. Echo guard set to 1.5 s.');
  r = V.voiceCarCheckResult([A(40), A(50), A(45)], { echoHold: 1500, interruptSensitivity: 50 });
  assert.strictEqual(r.echoHold, 600, 'smallest hold at or above delay + 300');
  r = V.voiceCarCheckResult([A(240, -25), A(240, -26), A(240, -24)], cur);
  assert.strictEqual(r.interruptSensitivity, 30); assert.strictEqual(r.echoDb, -25);
  assert.strictEqual(r.line, 'The echo comes back after 240 ms. Echo guard set to 0.6 s, interrupt sensitivity lowered to 30.');
  r = V.voiceCarCheckResult([A(240, -40), A(240, -41), A(240, -39)], cur);
  assert.strictEqual(r.interruptSensitivity, 40);
  r = V.voiceCarCheckResult([A(240, -40)].concat([A(240, -40)]), { echoHold: 600, interruptSensitivity: 20 });
  assert.strictEqual(r.interruptSensitivity, 20, 'never raised');
  assert.ok(!/lowered/.test(r.line));
  r = V.voiceCarCheckResult([A(240, -60), A(240, -61), A(240, -62)], cur);
  assert.strictEqual(r.interruptSensitivity, 50, 'quiet echo leaves it');
  // heard needs two of three
  r = V.voiceCarCheckResult([A(240), { delayMs: null, echoDb: -80, confidence: 0.1 }, { delayMs: null, echoDb: -80, confidence: 0.1 }], { echoHold: 1000, interruptSensitivity: 35 });
  assert.deepStrictEqual([r.heard, r.echoHold, r.interruptSensitivity], [false, 1000, 35]);
  assert.strictEqual(r.line, 'No echo of the test sound reached the microphone. Echo guard stays at 1 s.');
  r = V.voiceCarCheckResult([], { echoHold: 0, interruptSensitivity: 50 });
  assert.strictEqual(r.line, 'No echo of the test sound reached the microphone. Echo guard stays at off.');
  r = V.voiceCarCheckResult([A(240), A(250), { delayMs: null, echoDb: -80, confidence: 0.1 }], cur);
  assert.deepStrictEqual([r.heard, r.delayMs], [true, 245]);
  assert.strictEqual(V.voiceCarCheckResult([null, null], { echoHold: 1500, interruptSensitivity: 50 }).line, 'No echo of the test sound reached the microphone. Echo guard stays at 1.5 s.');
});

// ---- fakes: clock, tracks, browser ----

function clock() {
  const k = { t: 0, timers: [], nextId: 1 };
  k.setTimer = (fn, ms) => { const id = k.nextId++; k.timers.push({ id, at: k.t + ms, fn }); return id; };
  k.clearTimer = (id) => { k.timers = k.timers.filter(x => x.id !== id); };
  k.advance = async (ms) => {
    const end = k.t + ms;
    for (;;) {
      const due = k.timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      k.timers = k.timers.filter(x => x !== due); k.t = due.at; due.fn(); await tick();
    }
    k.t = end; await tick();
  };
  return k;
}
function fakeTrack(label, deviceId) {
  const t = { label, readyState: 'live', kind: 'audio', listeners: {}, stopped: 0 };
  t.addEventListener = (n, f) => { (t.listeners[n] = t.listeners[n] || []).push(f); };
  t.removeEventListener = (n, f) => { t.listeners[n] = (t.listeners[n] || []).filter(x => x !== f); };
  t.dispatch = (n) => { if (n === 'ended') t.readyState = 'ended'; for (const f of (t.listeners[n] || []).slice()) f({ type: n }); };
  t.getSettings = () => ({ deviceId, sampleRate: 48000, channelCount: 1, echoCancellation: true });
  t.stop = () => { t.stopped++; t.readyState = 'ended'; };
  return t;
}
// o.rate: sample rate of a Ctx made without options; o.plan[i]: an Error (getUserMedia call i rejects) or 'gate' (waits for b.gate())
function browser(o = {}) {
  const b = { gums: [], ctxs: [], gains: [], sources: [], tracks: [], created: [], mdl: {}, setOptionsCalls: [] };
  b.devices = [{ kind: 'audioinput', deviceId: 'dev-a', groupId: 'g1', label: 'Mic A' }, { kind: 'audioinput', deviceId: 'default', groupId: 'g1', label: 'Default - Mic A' }];
  class Gain { constructor() { this.gain = { value: -1 }; b.gains.push(this); } connect() {} }
  class Ctx {
    constructor(opts) { this.opts = opts; this.sampleRate = opts && opts.sampleRate ? opts.sampleRate : (o.rate === undefined ? 48000 : o.rate); this.closed = false; b.ctxs.push(this); this.state = 'suspended'; }
    async resume() { this.state = 'running'; } async close() { this.closed = true; }
    createMediaStreamSource(raw) { const s = { raw, connected: [], disconnected: 0, connect(g) { this.connected.push(g); }, disconnect() { this.disconnected++; } }; b.sources.push(s); return s; }
    createGain() { return new Gain(); }
    createMediaStreamDestination() { const tr = fakeTrack('dest', 'dest'); return { stream: { id: 'dest-stream', getTracks: () => [tr], getAudioTracks: () => [tr] } }; }
  }
  class MicVAD {
    static async new(options) { const v = new MicVAD(); v.options = options; v.setOptionsCalls = []; b.created.push(v); v.stream = await options.getStream(); return v; }
    async start() { this.started = true; } async destroy() { this.destroyed = true; }
    setOptions(u) { this.setOptionsCalls.push(u); }
  }
  const md = {
    getUserMedia: async (c) => {
      const i = b.gums.length; b.gums.push(c);
      const plan = (o.plan || [])[i];
      if (plan === 'gate') await new Promise((r) => { b.gate = r; });
      if (plan instanceof Error) throw plan;
      const n = b.raws ? b.raws.length : 0;
      const tr = fakeTrack(n === 0 ? 'Mic A' : 'Mic B', n === 0 ? 'dev-a' : 'dev-b');
      b.tracks.push(tr);
      const raw = { id: 'raw-' + n, getTracks: () => [tr], getAudioTracks: () => [tr], track: tr };
      (b.raws = b.raws || []).push(raw);
      return raw;
    },
    enumerateDevices: async () => b.devices.map(d => Object.assign({}, d)),
    addEventListener: (n, f) => { (b.mdl[n] = b.mdl[n] || []).push(f); },
    removeEventListener: (n, f) => { b.mdl[n] = (b.mdl[n] || []).filter(x => x !== f); },
  };
  b.devicechange = () => { for (const f of (b.mdl.devicechange || []).slice()) f({ type: 'devicechange' }); };
  b.win = { AudioContext: Ctx, vad: { MicVAD }, navigator: { mediaDevices: md } };
  return b;
}
const noErr = (name) => { const e = new Error(name); e.name = name; return e; };
async function liveVad(o, vadOpts, handlers) {
  const b = browser(o), k = clock();
  const events = { info: [], change: [] };
  const vad = voiceCreateVad(Object.assign({ win: b.win, loadScript: async () => {}, setTimer: k.setTimer, clearTimer: k.clearTimer, micLevel: 50, interruptSensitivity: 50 }, vadOpts));
  await vad.start(Object.assign({ onMicInfo: (i) => events.info.push(i), onMicChange: (c) => events.change.push(c) }, handlers));
  return { b, k, vad, events, m: b.created[0] };
}
const lastOpts = (m) => m.setOptionsCalls[m.setOptionsCalls.length - 1];
const NORMAL = { positiveSpeechThreshold: 0.5, negativeSpeechThreshold: 0.35, minSpeechMs: 96 };

// ---- VAD adapter: echo hold-over ----

test('echo hold: the raised thresholds stay 600 ms after playback stops; a new playback cancels; 0 drops at once; setEchoHold works', async () => {
  const { k, vad, m } = await liveVad();
  vad.setPlaybackActive(true);
  const raised = lastOpts(m);
  assert.ok(raised.positiveSpeechThreshold > 0.5);
  vad.setPlaybackActive(false);
  assert.deepStrictEqual(lastOpts(m), raised, 'still raised right after playback stops');
  await k.advance(599);
  assert.deepStrictEqual(lastOpts(m), raised, 'still raised at 599 ms');
  await k.advance(1);
  assert.deepStrictEqual(lastOpts(m), NORMAL, 'normal at 600 ms');
  // a true at 300 ms cancels the hold-over
  vad.setPlaybackActive(true); vad.setPlaybackActive(false);
  await k.advance(300);
  vad.setPlaybackActive(true);
  await k.advance(2000);
  assert.deepStrictEqual(lastOpts(m), raised, 'playback went on: nothing dropped');
  vad.setPlaybackActive(false);
  await k.advance(600);
  assert.deepStrictEqual(lastOpts(m), NORMAL);
  // a second false while the hold runs does not restart it into a longer one
  vad.setEchoHold(1000);
  vad.setPlaybackActive(true); vad.setPlaybackActive(false);
  await k.advance(999);
  assert.deepStrictEqual(lastOpts(m), raised);
  await k.advance(1);
  assert.deepStrictEqual(lastOpts(m), NORMAL, 'setEchoHold(1000)');
  vad.setEchoHold(0);
  vad.setPlaybackActive(true); vad.setPlaybackActive(false);
  assert.deepStrictEqual(lastOpts(m), NORMAL, 'echoHold 0: at once');
  await vad.stop();
});

test('echo hold: echoHoldMs 0 as an option is today\'s behaviour; stop() clears a running hold; thinking pulse also holds', async () => {
  const z = await liveVad({}, { echoHoldMs: 0 });
  z.vad.setPlaybackActive(true); z.vad.setPlaybackActive(false);
  assert.deepStrictEqual(lastOpts(z.m), NORMAL);
  assert.strictEqual(z.k.timers.length, 0, 'no timer');
  await z.vad.stop();
  const h = await liveVad();
  h.vad.setPlaybackActive(true); h.vad.setPlaybackActive(false);
  assert.strictEqual(h.k.timers.length, 1, 'one hold timer');
  await h.vad.stop();
  assert.strictEqual(h.k.timers.length, 0, 'stop clears the hold timer');
});

// ---- VAD adapter: constraint fallback, sample-rate guard, mic info ----

test('fallback: an OverconstrainedError is retried once with { audio: true }; info.fallback is true', async () => {
  const { b, vad, events } = await liveVad({ plan: [noErr('OverconstrainedError')] });
  assert.strictEqual(b.gums.length, 2);
  assert.deepStrictEqual(b.gums[0], { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  assert.deepStrictEqual(b.gums[1], { audio: true });
  assert.strictEqual(vad.info().fallback, true);
  assert.strictEqual(events.info.length, 1);
  assert.strictEqual(events.info[0].fallback, true);
  assert.strictEqual(voiceLiveTracks() >= 2, true);
  await vad.stop();
});

test('fallback: the first call is exactly as before and info reports the track', async () => {
  const { b, vad, events } = await liveVad();
  assert.strictEqual(b.gums.length, 1);
  assert.deepStrictEqual(b.gums[0], { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  assert.deepStrictEqual(events.info[0], { label: 'Mic A', sampleRate: 48000, channelCount: 1, echoCancellation: true, fallback: false });
  assert.deepStrictEqual(vad.info(), events.info[0]);
  await vad.stop();
});

test('fallback: NotAllowedError, SecurityError and AbortError are not retried; the first error is thrown when both fail', async () => {
  for (const name of ['NotAllowedError', 'SecurityError', 'AbortError']) {
    const b = browser({ plan: [noErr(name)] }), vad = voiceCreateVad({ win: b.win, loadScript: async () => {} });
    await assert.rejects(() => vad.start({}), (e) => e.name === name);
    assert.strictEqual(b.gums.length, 1, name + ': no second call');
  }
  const b = browser({ plan: [noErr('NotReadableError'), noErr('NotFoundError')] }), vad = voiceCreateVad({ win: b.win, loadScript: async () => {} });
  await assert.rejects(() => vad.start({}), (e) => e.name === 'NotReadableError');
  assert.strictEqual(b.gums.length, 2);
});

test('rate guard: a context under 16 kHz is closed and a 48 kHz one made; a throwing options constructor falls back to a plain one', async () => {
  const { b, vad } = await liveVad({ rate: 8000 });
  assert.strictEqual(b.ctxs.length, 2);
  assert.strictEqual(b.ctxs[0].closed, true);
  assert.deepStrictEqual(b.ctxs[1].opts, { sampleRate: 48000 });
  assert.strictEqual(b.ctxs[1].sampleRate, 48000);
  await vad.stop();
  assert.strictEqual(b.ctxs[1].closed, true, 'the new context is the one released');
  const ok = await liveVad({ rate: 44100 });
  assert.strictEqual(ok.b.ctxs.length, 1, '44.1 kHz is fine');
  await ok.vad.stop();
  const b2 = browser({ rate: 8000 }), Base = b2.win.AudioContext;
  b2.win.AudioContext = class extends Base { constructor(opts) { if (opts && opts.sampleRate) throw new Error('unsupported'); super(opts); } };
  const v2 = voiceCreateVad({ win: b2.win, loadScript: async () => {} });
  await v2.start({});
  assert.strictEqual(b2.ctxs.length, 2, 'the plain Ctx again');
  assert.strictEqual(b2.ctxs[0].closed, true);
  await v2.stop();
});

// ---- VAD adapter: microphone lost or changed ----

test('reopen: the track ending opens the microphone again once, on the same gain, without recreating MicVAD', async () => {
  const base = voiceLiveTracks();
  const { b, k, vad, events, m } = await liveVad();
  assert.strictEqual(voiceLiveTracks(), base + 2);
  const gain0 = b.gains[0];
  b.tracks[0].dispatch('ended');   // b.tracks: the microphone tracks, in the order they were opened
  await k.advance(0); await tick();
  assert.strictEqual(b.gums.length, 2, 'one new getUserMedia');
  assert.ok(b.tracks[0].stopped >= 1, 'the old raw is stopped');
  assert.strictEqual(b.sources[0].disconnected, 1);
  assert.strictEqual(b.sources[1].connected[0], gain0, 'the new source feeds the SAME gain');
  assert.strictEqual(b.gains.length, 1);
  assert.strictEqual(b.created.length, 1, 'MicVAD is not recreated');
  assert.deepStrictEqual(events.change.length, 1);
  assert.strictEqual(events.change[0].ok, true); assert.strictEqual(events.change[0].reason, 'ended'); assert.strictEqual(events.change[0].changed, true);
  assert.strictEqual(events.change[0].info.label, 'Mic B');
  assert.strictEqual(events.info.length, 2, 'onMicInfo again after the reopen');
  assert.strictEqual(vad.info().label, 'Mic B');
  assert.strictEqual(voiceLiveTracks(), base + 2, 'old raw untracked, new raw tracked');
  // the new track is watched too
  b.tracks[b.tracks.length - 1].dispatch('ended');
  await tick();
  assert.strictEqual(b.gums.length, 3);
  await vad.stop();
  assert.strictEqual(voiceLiveTracks(), base, 'nothing left holding the microphone');
  assert.strictEqual((b.mdl.devicechange || []).length, 0, 'devicechange listener removed');
  const n = b.gums.length;
  b.tracks[b.tracks.length - 1].dispatch('ended'); b.devicechange(); await k.advance(2000);
  assert.strictEqual(b.gums.length, n, 'ignored after stop');
});

test('reopen: a failing reopen reports ok:false once, keeps the VAD running and does not retry', async () => {
  const { b, k, vad, events, m } = await liveVad({ plan: [undefined, noErr('NotAllowedError')] });
  b.tracks[0].dispatch('ended');
  await tick();
  assert.strictEqual(b.gums.length, 2);
  assert.strictEqual(events.change.length, 1);
  assert.strictEqual(events.change[0].ok, false);
  assert.strictEqual(events.change[0].reason, 'ended');
  assert.strictEqual(events.change[0].error.name, 'NotAllowedError');
  await k.advance(30000);
  assert.strictEqual(b.gums.length, 2, 'no retry loop');
  assert.strictEqual(m.destroyed, undefined, 'MicVAD still alive');
  await vad.stop();
});

test('reopen: the constraint ladder is used (fallback on reopen) and the manual reopen() returns a promise of true/false', async () => {
  const { b, vad, events } = await liveVad({ plan: [undefined, noErr('OverconstrainedError'), undefined, noErr('NotAllowedError')] });
  assert.strictEqual(await vad.reopen(), true);
  assert.deepStrictEqual(b.gums.map(g => JSON.stringify(g)).slice(1), [JSON.stringify({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }), JSON.stringify({ audio: true })]);
  assert.strictEqual(events.change[0].reason, 'manual');
  assert.strictEqual(events.change[0].info.fallback, true);
  assert.strictEqual(await vad.reopen(), false);
  assert.strictEqual(events.change[1].ok, false);
  await vad.stop();
  assert.strictEqual(await vad.reopen(), false, 'after stop');
});

test('reopen: two quick triggers make one getUserMedia (a reopen in flight absorbs them)', async () => {
  const { b, k, vad, events } = await liveVad({ plan: [undefined, 'gate'] });
  b.tracks[0].dispatch('ended');
  b.tracks[0].dispatch('ended');
  const second = vad.reopen();
  b.devicechange();
  await k.advance(800);
  assert.strictEqual(b.gums.length, 2, 'one getUserMedia while the first reopen is in flight');
  b.gate(); await tick();
  assert.strictEqual(typeof await second, 'boolean', 'the absorbed manual trigger still answers');
  assert.strictEqual(b.gums.length, 2);
  assert.strictEqual(events.change.length, 1);
  await vad.stop();
});

test('reopen: devicechange with unchanged devices does nothing; a burst counts once', async () => {
  const { b, k, vad, events } = await liveVad();
  assert.strictEqual((b.mdl.devicechange || []).length, 1, 'the adapter listens for devicechange');
  b.devicechange(); b.devicechange(); b.devicechange();
  await k.advance(5000);
  assert.strictEqual(b.gums.length, 1);
  assert.strictEqual(events.change.length, 0);
  await vad.stop();
});

test('reopen: devicechange where the track\'s device disappeared reopens after 700 ms, once for a burst', async () => {
  const { b, k, vad, events } = await liveVad();
  b.devices = [{ kind: 'audioinput', deviceId: 'dev-b', groupId: 'g2', label: 'Mic B' }, { kind: 'audioinput', deviceId: 'default', groupId: 'g2', label: 'Default - Mic B' }];
  b.devicechange(); b.devicechange(); b.devicechange();
  await k.advance(699);
  assert.strictEqual(b.gums.length, 1, 'debounced: not yet');
  await k.advance(1); await tick();
  assert.strictEqual(b.gums.length, 2, 'reopened after 700 ms');
  assert.strictEqual(events.change.length, 1);
  assert.strictEqual(events.change[0].reason, 'devicechange');
  assert.strictEqual(events.change[0].ok, true);
  await vad.stop();
});

test('reopen: devicechange where only the default input changed (group or label) reopens; the track ended also reopens', async () => {
  const a = await liveVad();
  a.b.devices = [{ kind: 'audioinput', deviceId: 'dev-a', groupId: 'g1', label: 'Mic A' }, { kind: 'audioinput', deviceId: 'default', groupId: 'g9', label: 'Default - Car' }];
  a.b.devicechange(); await a.k.advance(700); await tick();
  assert.strictEqual(a.b.gums.length, 2, 'the default moved to another device');
  await a.vad.stop();
  const e = await liveVad();
  e.b.tracks[0].readyState = 'ended';   // ended without the event
  e.b.devicechange(); await e.k.advance(700); await tick();
  assert.strictEqual(e.b.gums.length, 2, 'current track is ended');
  await e.vad.stop();
});

test('reopen: changed is false when the new microphone has the same label', async () => {
  const { b, k, vad, events } = await liveVad();
  const orig = b.win.navigator.mediaDevices.getUserMedia;
  b.win.navigator.mediaDevices.getUserMedia = async (c) => { const r = await orig(c); r.track.label = 'Mic A'; return r; };
  await vad.reopen();
  assert.strictEqual(events.change[0].ok, true); assert.strictEqual(events.change[0].changed, false);
  await vad.stop();
});

// ---- call controller ----

function callHarness(over) {
  const k = clock();
  const h = { k, log: [], spoken: [], pend: [], states: [], mics: [], lost: [], playing: [], sent: [], reopens: 0 };
  h.speak = (text) => new Promise((resolve) => { h.spoken.push(text); h.pend.push(resolve); });
  h.finish = async (ok = true) => { const r = h.pend.shift(); if (r) r(ok); await tick(); };
  h.handlers = null;
  h.vad = { start: async (hd) => { h.handlers = hd; }, stop: () => { h.log.push('vad.stop'); }, setPlaybackActive: (b) => { h.playing.push(b); } };
  h.running = false;
  h.deps = {
    now: () => k.t, setTimer: k.setTimer, clearTimer: k.clearTimer, prefs: () => ({ continueWait: 0, thinkingSound: false }),
    vad: h.vad, stt: async (a) => a.text, isTurnRunning: () => h.running,
    send: async (t) => { h.sent.push(t); h.running = true; }, interject: async () => {}, stop: () => {},
    speak: h.speak, cancelSpeech: () => { const r = h.pend.shift(); if (r) r(false); }, answerAsk: () => {},
    server: { start: async () => { h.log.push('server.start'); return { callId: 'c1', held: [] }; }, heartbeat: async () => ({ held: [] }), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} },
    ui: { state: (n) => { h.states.push(n); h.log.push('state:' + n); }, reply: (kind) => h.log.push('reply:' + kind), mic: (i) => h.mics.push(i), micLost: (b) => h.lost.push(b) },
  };
  Object.assign(h.deps, over || {});
  h.call = voiceCreateCall(h.deps);
  return h;
}
async function callStarted(over) { const h = callHarness(over); assert.strictEqual(await h.call.start(), true); return h; }
const keepAliveFake = (log) => ({ start: () => log.push('ka.start'), stop: () => log.push('ka.stop') });

test('keep-alive: start() is called before anything is awaited and the first speak waits until 300 ms after start', async () => {
  const log = [];
  let answer;
  const h = callHarness({ keepAlive: keepAliveFake(log) });
  h.deps.server.start = () => new Promise((r) => { log.push('server.start'); answer = r; });
  h.call = voiceCreateCall(h.deps);
  const p = h.call.start();
  assert.deepStrictEqual(log, ['ka.start', 'server.start'], 'keep-alive started first, synchronously');
  answer({ callId: 'c1', held: [] });
  assert.strictEqual(await p, true);
  h.call.onReplyText('First one. Second one. Third one.', true);
  await h.k.advance(0);
  assert.deepStrictEqual(h.spoken, [], 'lead-in: not yet');
  await h.k.advance(299);
  assert.deepStrictEqual(h.spoken, [], 'still waiting at 299 ms');
  await h.k.advance(1);
  assert.deepStrictEqual(h.spoken, ['First one.'], 'first speak at 300 ms');
  await h.finish();
  assert.deepStrictEqual(h.spoken, ['First one.', 'Second one.'], 'later sentences do not wait');
  await h.finish();
  assert.deepStrictEqual(h.spoken.length, 3);
  await h.finish();
  h.call.onAsk({ request_id: 'q', question: 'Later question?', options: [] });
  await tick();
  assert.strictEqual(h.spoken.length, 4, 'no second lead-in');
  await h.call.hangUp();
  assert.ok(log.includes('ka.stop'), 'teardown stops the keep-alive');
  assert.strictEqual(log.filter(x => x === 'ka.stop').length, 1);
});

test('keep-alive: when the first speak comes after the lead-in it is not delayed; a hang-up during the wait speaks nothing', async () => {
  const log = [];
  const h = await callStarted({ keepAlive: keepAliveFake(log) });
  await h.k.advance(400);
  h.call.onAsk({ request_id: 'q', question: 'Hello?', options: [] });
  await tick();
  assert.strictEqual(h.spoken.length, 1);
  const log2 = [];
  const g = await callStarted({ keepAlive: keepAliveFake(log2) });
  g.call.onAsk({ request_id: 'q', question: 'Hello?', options: [] });
  await tick();
  await g.call.hangUp();
  await g.k.advance(1000);
  assert.deepStrictEqual(g.spoken, [], 'nothing is spoken after the hang-up');
  assert.deepStrictEqual(log2, ['ka.start', 'ka.stop']);
});

test('keep-alive: a failing keepAlive never stops the call; without one the first speak is not delayed', async () => {
  const tries = [];
  const h = await callStarted({ keepAlive: { start() { tries.push('start'); throw new Error('no audio'); }, stop() { tries.push('stop'); throw new Error('no audio'); } } });
  await h.call.hangUp();
  assert.deepStrictEqual(tries, ['start', 'stop']);
  const n = await callStarted();
  n.call.onAsk({ request_id: 'q', question: 'Hello?', options: [] });
  await tick();
  assert.strictEqual(n.spoken.length, 1, 'no keepAlive: no lead-in');
});

test('mic: onMicInfo goes to ui.mic; a lost microphone is announced, the call stays up and retryMic asks the adapter', async () => {
  const h = await callStarted();
  h.vad.reopen = () => { h.reopens++; return Promise.resolve(true); };
  h.handlers.onMicInfo({ label: 'Car' });
  assert.deepStrictEqual(h.mics, [{ label: 'Car' }]);
  h.handlers.onMicChange({ ok: false, reason: 'ended', error: new Error('gone') });
  await tick();
  assert.deepStrictEqual(h.lost, [true]);
  assert.deepStrictEqual(h.spoken, ['I lost the microphone. Tap to talk to carry on.']);
  assert.notStrictEqual(h.call.state, 'ended');
  await h.finish();
  assert.notStrictEqual(h.call.state, 'ended');
  assert.strictEqual(await h.call.retryMic(), true);
  assert.strictEqual(h.reopens, 1);
  h.handlers.onMicChange({ ok: true, changed: true, reason: 'manual', info: { label: 'Phone' } });
  await tick();
  assert.deepStrictEqual(h.lost, [true, false]);
  assert.deepStrictEqual(h.spoken, ['I lost the microphone. Tap to talk to carry on.', 'The microphone is back.']);
  await h.finish();
  // a second failure while already lost is just another lost line
  await h.call.hangUp();
});

test('mic: a changed microphone says so; unchanged says nothing; unchanged after a loss says it is back', async () => {
  const h = await callStarted();
  h.handlers.onMicChange({ ok: true, changed: true, reason: 'devicechange' });
  await tick();
  assert.deepStrictEqual(h.spoken, ['I\'ve switched microphones.']);
  assert.deepStrictEqual(h.lost, []);
  await h.finish();
  h.handlers.onMicChange({ ok: true, changed: false, reason: 'devicechange' });
  await tick();
  assert.strictEqual(h.spoken.length, 1, 'nothing spoken for a change that changed nothing');
  h.handlers.onMicChange({ ok: false, reason: 'ended' }); await tick(); await h.finish();
  h.handlers.onMicChange({ ok: true, changed: false, reason: 'manual' }); await tick();
  assert.deepStrictEqual(h.lost, [true, false]);
  assert.strictEqual(h.spoken[h.spoken.length - 1], 'The microphone is back.');
  await h.call.hangUp();
});

test('mic: retryMic without a reopen method resolves false; after the call ended it is ignored', async () => {
  const h = await callStarted();
  assert.strictEqual(await h.call.retryMic(), false);
  h.vad.reopen = () => { h.reopens++; return Promise.resolve(true); };
  await h.call.hangUp();
  assert.strictEqual(await h.call.retryMic(), false);
  assert.strictEqual(h.reopens, 0);
  h.handlers.onMicChange({ ok: false, reason: 'ended' }); await tick();
  assert.deepStrictEqual(h.lost, [], 'mic events after the call are ignored');
  assert.deepStrictEqual(h.spoken, []);
});

test('mic: the ui defaults accept a ui without mic() and micLost()', async () => {
  const h = await callStarted({ ui: { state: () => {} } });
  h.handlers.onMicInfo({ label: 'x' });
  h.handlers.onMicChange({ ok: false, reason: 'ended' });
  await tick();
  assert.strictEqual(h.spoken.length, 1);
});

test('events: ui.reply(\'end\') still comes before the state settles to listening, with the keep-alive on too', async () => {
  const log = [];
  const h = await callStarted({ keepAlive: keepAliveFake(log) });
  await h.k.advance(400);
  h.handlers.onSpeechStart(); h.handlers.onSpeechEnd({ text: 'What time is it?' }); await tick();
  await h.k.advance(0);
  assert.deepStrictEqual(h.sent, ['What time is it?']);
  h.call.onReplyText('It is noon.', true);
  await tick();
  await h.finish();
  assert.ok(log.includes('ka.start'));
  const iEnd = h.log.lastIndexOf('reply:end'), iListen = h.log.lastIndexOf('state:listening');
  assert.ok(iEnd > 0, 'reply end reported: ' + h.log.join(' '));
  assert.ok(iEnd < iListen, 'reply end before listening: ' + h.log.join(' '));
  await h.call.hangUp();
});

// ---- the keep-alive sound ----

function fakeAudioCtx(over) {
  const c = { sampleRate: 8000, destination: { kind: 'destination' }, buffers: [], sources: [], gains: [], state: 'running' };
  c.createBuffer = (ch, len, rate) => { const data = new Float32Array(len), buf = { numberOfChannels: ch, length: len, sampleRate: rate, getChannelData: () => data, data }; c.buffers.push(buf); return buf; };
  c.createBufferSource = () => { const s = { loop: false, buffer: null, to: [], started: 0, stopped: 0, disconnected: 0, connect(x) { this.to.push(x); }, start() { this.started++; }, stop() { this.stopped++; }, disconnect() { this.disconnected++; } }; c.sources.push(s); return s; };
  c.createGain = () => { const g = { gain: { value: 1 }, to: [], connect(x) { this.to.push(x); }, disconnect() { this.disconnected = (this.disconnected || 0) + 1; } }; c.gains.push(g); return g; };
  return Object.assign(c, over || {});
}

test('voiceCreateKeepAlive: start makes one looping 2 s noise buffer at -70 dB into the destination; a second start does nothing; stop stops it', () => {
  const ctx = fakeAudioCtx();
  const ka = C.voiceCreateKeepAlive({ ctx });
  assert.strictEqual(ka.running, false);
  ka.start();
  assert.strictEqual(ka.running, true);
  assert.strictEqual(ctx.buffers.length, 1);
  const buf = ctx.buffers[0], amp = Math.pow(10, -70 / 20);
  assert.deepStrictEqual([buf.numberOfChannels, buf.length, buf.sampleRate], [1, 16000, 8000]);
  let peak = 0, nonzero = 0; for (const x of buf.data) { peak = Math.max(peak, Math.abs(x)); if (x !== 0) nonzero++; }
  assert.ok(peak <= amp * 1.0001 && peak > amp * 0.9, 'peak ' + peak + ' vs ' + amp);
  assert.ok(nonzero > buf.length * 0.9, 'noise, not digital silence');
  assert.strictEqual(ctx.sources.length, 1);
  const s = ctx.sources[0];
  assert.strictEqual(s.loop, true); assert.strictEqual(s.buffer, buf); assert.strictEqual(s.started, 1);
  assert.strictEqual(s.to.length, 1); assert.strictEqual(s.to[0], ctx.gains[0]);
  assert.strictEqual(ctx.gains[0].to[0], ctx.destination);
  ka.start();
  assert.strictEqual(ctx.sources.length, 1, 'second start: nothing new'); assert.strictEqual(ctx.buffers.length, 1);
  ka.stop();
  assert.strictEqual(ka.running, false);
  assert.strictEqual(s.stopped, 1); assert.ok(s.disconnected >= 1);
  ka.stop();
  assert.strictEqual(s.stopped, 1, 'second stop: nothing');
  ka.start();
  assert.strictEqual(ctx.buffers.length, 1, 'the buffer is made once');
  assert.strictEqual(ctx.sources.length, 2, 'a restart needs a new source node');
  ka.stop();
});

test('voiceCreateKeepAlive: levelDb sets the amplitude; a null or throwing context is a no-op', () => {
  const ctx = fakeAudioCtx({ sampleRate: 16000 });
  C.voiceCreateKeepAlive({ ctx, levelDb: -50 }).start();
  let peak = 0; for (const x of ctx.buffers[0].data) peak = Math.max(peak, Math.abs(x));
  assert.ok(peak <= Math.pow(10, -50 / 20) * 1.0001 && peak > Math.pow(10, -50 / 20) * 0.9);
  assert.strictEqual(ctx.buffers[0].length, 32000);
  for (const bad of [null, undefined, fakeAudioCtx({ createBuffer() { throw new Error('closed'); } })]) {
    const ka = C.voiceCreateKeepAlive({ ctx: bad });
    ka.start(); assert.strictEqual(ka.running, false); ka.stop();
  }
  assert.doesNotThrow(() => C.voiceCreateKeepAlive().start());
});

test('exports: the new constants and names', () => {
  assert.strictEqual(C.VOICE_ECHO_HOLD_MS, 600);
  assert.strictEqual(C.VOICE_CALL_LEAD_IN_MS, 300);
  assert.strictEqual(typeof C.voiceCreateKeepAlive, 'function');
  for (const n of ['voiceCarChirp', 'voiceEchoAnalysis', 'voiceCarCheckResult']) assert.strictEqual(typeof V[n], 'function', n);
});

// ---- the hold-over never runs over the person's own words ----

test('echo hold: setPlaybackActive(false, true) drops the thresholds at once and ends a running hold-over', async () => {
  const { k, vad, m } = await liveVad();
  vad.setPlaybackActive(true);
  vad.setPlaybackActive(false, true);
  assert.deepStrictEqual(lastOpts(m), NORMAL, 'dropped at once');
  assert.strictEqual(k.timers.length, 0, 'no hold timer');
  vad.setPlaybackActive(true); vad.setPlaybackActive(false);
  assert.strictEqual(k.timers.length, 1, 'a hold-over is running');
  vad.setPlaybackActive(false, true);
  assert.deepStrictEqual(lastOpts(m), NORMAL, 'a running hold-over ends at once');
  assert.strictEqual(k.timers.length, 0);
  await vad.stop();
});

test('controller: real speech cutting a reply tells the adapter to drop the thresholds at once (no hold-over)', async () => {
  const h = await callStarted();
  h.call.onAsk({ request_id: 'q', question: 'Shall I go on?', options: [] });
  await tick();
  const vadCalls = [];
  h.vad.setPlaybackActive = (b, now) => { vadCalls.push([b, !!now]); };
  h.call.onSpeechBegin(); h.call.onSpeechStart();
  assert.deepStrictEqual(vadCalls, [[false, true]], 'cut by the person: at once');
  h.call.release('test');
});

test('adapter: real speech during a running hold-over ends it at once; a candidate start does not', async () => {
  const seen = [];
  const { k, vad, m } = await liveVad({}, {}, { onSpeechBegin: () => seen.push('begin'), onSpeechStart: () => seen.push('start') });
  vad.setPlaybackActive(true); vad.setPlaybackActive(false);
  const raised = lastOpts(m);
  m.options.onSpeechStart();   // a candidate (maybe the echo): the hold-over stays
  assert.deepStrictEqual(lastOpts(m), raised);
  assert.strictEqual(k.timers.length, 1);
  m.options.onSpeechRealStart();   // real speech passed the raised thresholds
  assert.deepStrictEqual(lastOpts(m), NORMAL, 'dropped at once');
  assert.strictEqual(k.timers.length, 0, 'hold timer gone');
  assert.deepStrictEqual(seen, ['begin', 'start']);
  await vad.stop();
});

// ---- late-echo simulation against the real adapter's thresholds ----
// A frame-by-frame stand-in for MicVAD's start rule: a real start needs minSpeechMs of consecutive frames (32 ms each) at or above the
// positive threshold that is in force at that frame. The reply ends at t = 0; the car's echo of its last syllable arrives 150-330 ms later
// (speech probability 0.65); the person really speaks from 1000 ms (0.9).
async function simulate(vadOpts) {
  const { k, vad, m } = await liveVad({}, vadOpts);
  const cur = () => Object.assign({ positiveSpeechThreshold: m.options.positiveSpeechThreshold, minSpeechMs: m.options.minSpeechMs }, ...m.setOptionsCalls);
  vad.setPlaybackActive(true);
  vad.setPlaybackActive(false);   // the reply's last sentence ended
  const starts = [];
  let run = 0;
  for (let t = 0; t < 1600; t += 32) {
    const p = t >= 150 && t < 330 ? 0.65 : t >= 1000 ? 0.9 : 0.05;
    const o = cur();
    run = p >= o.positiveSpeechThreshold ? run + 1 : 0;
    if (run * 32 >= o.minSpeechMs && run * 32 - 32 < o.minSpeechMs) starts.push(t);
    await k.advance(32);
  }
  await vad.stop();
  return starts;
}

test('late echo: with the 600 ms echo guard the car\'s echo is not a new turn and the person still is; without it the echo starts a turn', async () => {
  const guarded = await simulate({});
  assert.strictEqual(guarded.length, 1, 'one start: the person');
  assert.ok(guarded[0] >= 1000, 'the start is the person at ' + guarded[0] + ' ms');
  const off = await simulate({ echoHoldMs: 0 });
  assert.ok(off.length === 2 && off[0] < 400, 'without the guard the echo at ' + off[0] + ' ms counts as speech');
});

// ---- review round 1: the Car or Bluetooth check on one clock ----

test('exports: the car-check constants and names (round 1)', () => {
  assert.deepStrictEqual(V.VOICE_CAR_AT, [0.5, 2.0, 3.5]);
  assert.strictEqual(V.VOICE_CAR_END, 5.2);
  assert.strictEqual(V.VOICE_CAR_MAX_DELAY_MS, 1200);
  assert.strictEqual(typeof V.voiceCarAnalyse, 'function');
  assert.strictEqual(typeof C.voiceCarRecord, 'function');
  assert.strictEqual(typeof C.voiceOpenMicStream, 'function');
});

// A synthetic 5.2 s recording: ref = the chirp at 0.5 / 2.0 / 3.5 s and silence; mic = noise at -55 dB plus (when delayMs is given) the three chirps delayed by it at -20 dB.
function carRecording(rate, delayMs, seed) {
  const chirp = V.voiceCarChirp(rate), n = Math.round(5.2 * rate);
  const ref = new Float32Array(n), mic = noise(n, -55, seed || 5);
  const g = Math.pow(10, -20 / 20) / rmsOf(chirp);
  for (const a of [0.5, 2.0, 3.5]) {
    const s = Math.round(a * rate);
    for (let i = 0; i < chirp.length; i++) {
      ref[s + i] = chirp[i];
      if (delayMs != null) mic[s + Math.round(delayMs * rate / 1000) + i] += chirp[i] * g;
    }
  }
  return { chirp, ref, mic };
}

test('voiceCarAnalyse: finds echoes at 230, 1100 and 1190 ms at 16 and 48 kHz; the guard follows the delay', () => {
  for (const rate of [16000, 48000]) {
    for (const [d, hold] of [[230, 600], [1100, 1500], [1190, 1500]]) {
      const { chirp, ref, mic } = carRecording(rate, d, d + rate);
      const res = V.voiceCarAnalyse(mic, ref, chirp, rate);
      assert.strictEqual(res.length, 3, 'three results');
      for (const r of res) assert.ok(r.delayMs !== null && Math.abs(r.delayMs - d) <= 3, rate + ' Hz, D ' + d + ': ' + JSON.stringify(res.map(x => x.delayMs)));
      const out = V.voiceCarCheckResult(res, { echoHold: 600, interruptSensitivity: 50 });
      assert.strictEqual(out.heard, true);
      assert.strictEqual(out.echoHold, hold, rate + ' Hz, D ' + d);
    }
  }
});

test('voiceCarAnalyse: an echo of chirp i+1 is never found in the window of chirp i (D = 230: every delay is 230, never 1730 or 1230)', () => {
  for (const rate of [16000, 48000]) {
    const { chirp, ref, mic } = carRecording(rate, 230, 77);
    const delays = V.voiceCarAnalyse(mic, ref, chirp, rate).map(r => r.delayMs);
    for (const d of delays) assert.ok(d !== null && Math.abs(d - 230) <= 3, rate + ' Hz ' + JSON.stringify(delays));
    assert.ok(V.voiceCarAnalyse(mic, ref, chirp, rate).every(r => r.delayMs !== 1730 && r.delayMs !== 1230));
  }
});

test('voiceCarAnalyse: no echo in the microphone gives three nulls and "not heard"; a missing onset in ref gives a null result in its place', () => {
  const { chirp, ref, mic } = carRecording(16000, null, 9);
  const res = V.voiceCarAnalyse(mic, ref, chirp, 16000);
  assert.strictEqual(res.length, 3);
  for (const r of res) assert.strictEqual(r.delayMs, null);
  assert.strictEqual(V.voiceCarCheckResult(res, { echoHold: 600, interruptSensitivity: 50 }).heard, false);
  const none = V.voiceCarAnalyse(mic, new Float32Array(ref.length), chirp, 16000);
  assert.deepStrictEqual(none, [0, 1, 2].map(() => ({ delayMs: null, echoDb: -Infinity, confidence: 0 })));
  const one = carRecording(16000, 230, 3);
  const part = new Float32Array(one.ref.length); part.set(one.ref.subarray(0, Math.round(1.0 * 16000)));   // only the first chirp is in ref
  const r1 = V.voiceCarAnalyse(one.mic, part, one.chirp, 16000);
  assert.strictEqual(r1.length, 3);
  assert.ok(Math.abs(r1[0].delayMs - 230) <= 3);
  assert.deepStrictEqual([r1[1], r1[2]], [{ delayMs: null, echoDb: -Infinity, confidence: 0 }, { delayMs: null, echoDb: -Infinity, confidence: 0 }]);
});

// ---- voiceOpenMicStream ----

test('voiceOpenMicStream: the constraint ladder (same cases as the adapter)', async () => {
  const b = browser();
  const r = await C.voiceOpenMicStream(b.win.navigator);
  assert.strictEqual(r.fallback, false);
  assert.strictEqual(r.stream, b.raws[0]);
  assert.deepStrictEqual(b.gums, [{ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }]);
  const f = browser({ plan: [noErr('OverconstrainedError')] });
  const fr = await C.voiceOpenMicStream(f.win.navigator);
  assert.strictEqual(fr.fallback, true);
  assert.deepStrictEqual(f.gums[1], { audio: true });
  for (const name of ['NotAllowedError', 'SecurityError', 'AbortError']) {
    const x = browser({ plan: [noErr(name)] });
    await assert.rejects(() => C.voiceOpenMicStream(x.win.navigator), (e) => e.name === name);
    assert.strictEqual(x.gums.length, 1, name + ': no second call');
  }
  const y = browser({ plan: [noErr('NotReadableError'), noErr('NotFoundError')] });
  await assert.rejects(() => C.voiceOpenMicStream(y.win.navigator), (e) => e.name === 'NotReadableError');
  assert.strictEqual(y.gums.length, 2);
});

// ---- voiceCarRecord ----

function carCtx(rate, t) {
  const c = { sampleRate: rate, currentTime: t, destination: { kind: 'destination' }, state: 'running', bufSources: [], micSources: [], buffers: [], merger: null, proc: null, gain: null, closed: false };
  const node = (extra) => Object.assign({ to: [], disconnected: 0, connect(x, out, inp) { this.to.push({ x, out, inp }); }, disconnect() { this.disconnected++; } }, extra);
  c.createMediaStreamSource = (raw) => { const s = node({ raw }); c.micSources.push(s); return s; };
  c.createChannelMerger = (n) => { if (c.mergerThrows) throw new Error('no merger'); c.merger = node({ kind: 'merger', n }); return c.merger; };
  c.createScriptProcessor = (size, inCh, outCh) => { c.proc = node({ kind: 'proc', size, inCh, outCh, onaudioprocess: null }); return c.proc; };
  c.gains = [];
  c.createGain = () => { c.gain = node({ kind: 'gain', gain: { value: 1 } }); c.gains.push(c.gain); return c.gain; };
  c.createBuffer = (ch, len, r) => { const data = new Float32Array(len), buf = { numberOfChannels: ch, length: len, sampleRate: r, data, getChannelData: () => data }; c.buffers.push(buf); return buf; };
  c.createBufferSource = () => { const s = node({ buffer: null, starts: [], stopped: 0, start(t) { this.starts.push(t); }, stop() { this.stopped++; } }); c.bufSources.push(s); return s; };
  c.close = async () => { c.closed = true; };
  return c;
}
function carRig(o = {}) {
  const b = browser(o), k = clock(), ctx = carCtx(o.rate || 16000, o.t === undefined ? 1.5 : o.t);
  if (o.mergerThrows) ctx.mergerThrows = true;
  const chirp = V.voiceCarChirp(ctx.sampleRate);
  const rec = C.voiceCarRecord(Object.assign({ ctx, nav: b.win.navigator, chirp, setTimer: k.setTimer, clearTimer: k.clearTimer, now: () => k.t }, o.opts));
  const rig = { b, k, ctx, chirp, rec, settled: false, result: undefined, error: undefined };
  rec.done.then((r) => { rig.settled = true; rig.result = r; }, (e) => { rig.settled = true; rig.error = e; });
  return rig;
}
function assertCarCleanedUp(g, base, why) {
  assert.strictEqual(voiceLiveTracks(), base, why + ': microphone tracks let go');
  for (const t of g.b.tracks) assert.ok(t.stopped >= 1, why + ': track stopped');
  for (const s of g.ctx.bufSources) { assert.ok(s.stopped >= 1, why + ': source stopped'); assert.ok(s.disconnected >= 1, why + ': source disconnected'); }
  for (const s of g.ctx.micSources) assert.ok(s.disconnected >= 1, why + ': mic source disconnected');
  for (const n of [g.ctx.merger, g.ctx.proc, g.ctx.gain]) if (n) assert.ok(n.disconnected >= 1, why + ': node disconnected');
  if (g.ctx.proc) assert.strictEqual(g.ctx.proc.onaudioprocess, null, why + ': onaudioprocess null');
  assert.strictEqual(g.k.timers.length, 0, why + ': timer cleared');
  assert.strictEqual(g.ctx.closed, false, why + ': the page owns the context');
}

test('voiceCarRecord: one processor on the microphone plus the chirp channel; two sources per chirp started at t0 + a; arrays are the concatenated channels; resolves when the clock passes t0 + seconds', async () => {
  const base = voiceLiveTracks();
  const g = carRig({ t: 1.5 });
  await tick();
  const { ctx, k, chirp } = g;
  assert.strictEqual(g.b.gums.length, 1);
  assert.strictEqual(ctx.micSources.length, 1);
  assert.strictEqual(ctx.merger.n, 2);
  const micGain = ctx.gains[0];
  assert.deepStrictEqual(ctx.micSources[0].to.map(t => t.x), [micGain], 'mic -> its Mic level gain');
  assert.strictEqual(micGain.gain.value, 1, 'Mic level 50 (default) = 0 dB');
  assert.deepStrictEqual(micGain.to, [{ x: ctx.merger, out: 0, inp: 0 }], 'Mic level gain -> merger input 0');
  assert.deepStrictEqual([ctx.proc.size, ctx.proc.inCh, ctx.proc.outCh], [4096, 2, 1]);
  assert.deepStrictEqual(ctx.merger.to.map(t => t.x), [ctx.proc], 'merger -> processor');
  assert.deepStrictEqual(ctx.proc.to.map(t => t.x), [ctx.gain], 'processor -> gain');
  assert.strictEqual(ctx.gain.gain.value, 0);
  assert.deepStrictEqual(ctx.gain.to.map(t => t.x), [ctx.destination], 'gain -> destination');
  assert.strictEqual(typeof ctx.proc.onaudioprocess, 'function');
  assert.strictEqual(ctx.buffers.length, 1, 'ONE buffer from the chirp');
  assert.deepStrictEqual(Array.from(ctx.buffers[0].data), Array.from(chirp));
  assert.strictEqual(ctx.bufSources.length, 6, 'two sources per chirp');
  const t0 = 1.5;
  [0.5, 2.0, 3.5].forEach((a, i) => {
    const toDest = ctx.bufSources[2 * i], toMerger = ctx.bufSources[2 * i + 1];
    assert.strictEqual(toDest.buffer, ctx.buffers[0]); assert.strictEqual(toMerger.buffer, ctx.buffers[0]);
    assert.deepStrictEqual(toDest.to.map(t => t.x), [ctx.destination], 'chirp ' + i + ' -> destination');
    assert.deepStrictEqual(toMerger.to, [{ x: ctx.merger, out: 0, inp: 1 }], 'chirp ' + i + ' -> merger input 1');
    assert.deepStrictEqual(toDest.starts, [t0 + a]); assert.deepStrictEqual(toMerger.starts, [t0 + a], 'the same scheduled time');
  });
  // two buffers of audio: the arrays are copies of what each channel held
  const m1 = new Float32Array(4096).fill(0.25), r1 = new Float32Array(4096).fill(0.5), m2 = new Float32Array(4096).fill(-0.25), r2 = new Float32Array(4096).fill(-0.5);
  const feed = (m, r) => ctx.proc.onaudioprocess({ inputBuffer: { numberOfChannels: 2, length: 4096, getChannelData: (i) => (i === 0 ? m : r) } });
  feed(m1, r1); m1.fill(9); r1.fill(9);   // the page's buffer is reused by the browser: a copy was needed
  feed(m2, r2);
  ctx.currentTime = t0 + 5.2 - 0.01;
  await k.advance(100);
  assert.strictEqual(g.settled, false, 'not yet at t0 + seconds - 10 ms');
  ctx.currentTime = t0 + 5.2;
  await k.advance(100);
  assert.strictEqual(g.settled, true);
  assert.strictEqual(g.error, undefined);
  assert.strictEqual(g.result.rate, 16000);
  assert.strictEqual(g.result.fallback, false);
  assert.strictEqual(g.result.mic.length, 8192);
  assert.deepStrictEqual([g.result.mic[0], g.result.mic[4095], g.result.mic[4096], g.result.mic[8191]], [0.25, 0.25, -0.25, -0.25]);
  assert.deepStrictEqual([g.result.ref[0], g.result.ref[4095], g.result.ref[4096], g.result.ref[8191]], [0.5, 0.5, -0.5, -0.5]);
  assertCarCleanedUp(g, base, 'resolve');
});

test('voiceCarRecord: audio_not_started when the clock never moves and wallMs passes (not before); cancel() rejects with cancelled; both clean up', async () => {
  const base = voiceLiveTracks();
  const a = carRig({ t: 0 });
  await tick();
  await a.k.advance(12000);
  assert.strictEqual(a.settled, false, 'not yet at exactly wallMs');
  await a.k.advance(100);
  assert.strictEqual(a.settled, true);
  assert.strictEqual(a.error.code, 'audio_not_started');
  assert.ok(a.error instanceof Error);
  assertCarCleanedUp(a, base, 'audio_not_started');
  const s = carRig({ t: 0, opts: { wallMs: 3000 } });
  await tick(); await s.k.advance(3100);
  assert.strictEqual(s.error.code, 'audio_not_started', 'wallMs is an option');
  const c = carRig({});
  await tick();
  c.rec.cancel();
  await tick();
  assert.strictEqual(c.error.code, 'cancelled');
  assertCarCleanedUp(c, base, 'cancel');
  c.rec.cancel();   // a second cancel is harmless
  c.ctx.currentTime = 99; await c.k.advance(500);
  assert.strictEqual(c.result, undefined, 'nothing resolves after the end');
});

test('voiceCarRecord: cancel while the microphone is still opening lets go of the stream that arrives; an exception while building cleans up too', async () => {
  const base = voiceLiveTracks();
  const g = carRig({ plan: ['gate'] });
  g.rec.cancel();
  await tick();
  assert.strictEqual(g.error.code, 'cancelled');
  g.b.gate(); await tick();
  assert.strictEqual(voiceLiveTracks(), base, 'the late stream is stopped');
  assert.ok(g.b.tracks[0].stopped >= 1);
  assert.strictEqual(g.ctx.micSources.length, 0, 'no graph for a cancelled check');
  const e = carRig({ mergerThrows: true });
  await tick();
  assert.strictEqual(e.error.message, 'no merger');
  assertCarCleanedUp(e, base, 'building failed');
});

test('voiceCarRecord: NotAllowedError rejects without a retry; OverconstrainedError retries with { audio: true } and fallback is true', async () => {
  const base = voiceLiveTracks();
  const n = carRig({ plan: [noErr('NotAllowedError')] });
  await tick();
  assert.strictEqual(n.error.name, 'NotAllowedError');
  assert.strictEqual(n.b.gums.length, 1);
  assert.strictEqual(n.ctx.micSources.length, 0);
  assert.strictEqual(voiceLiveTracks(), base);
  const f = carRig({ plan: [noErr('OverconstrainedError')] });
  await tick();
  assert.strictEqual(f.b.gums.length, 2);
  assert.deepStrictEqual(f.b.gums[1], { audio: true });
  f.ctx.currentTime = 1.5 + 5.2; await f.k.advance(100);
  assert.strictEqual(f.result.fallback, true);
  assertCarCleanedUp(f, base, 'fallback');
});

// ---- controller and adapter fixes of the lead ----

test('mic: a second onMicChange({ ok: false }) while the microphone is already lost enqueues nothing and does not call ui.micLost again', async () => {
  const h = await callStarted();
  h.handlers.onMicChange({ ok: false, reason: 'ended' }); await tick();
  assert.deepStrictEqual(h.lost, [true]);
  assert.strictEqual(h.spoken.length, 1);
  await h.finish();
  h.handlers.onMicChange({ ok: false, reason: 'devicechange' }); await tick();
  h.handlers.onMicChange({ ok: false, reason: 'manual' }); await tick();
  assert.deepStrictEqual(h.lost, [true], 'ui.micLost(true) once');
  assert.strictEqual(h.spoken.length, 1, 'nothing new spoken');
  assert.strictEqual(h.pend.length, 0, 'nothing queued');
  h.handlers.onMicChange({ ok: true, reason: 'manual', changed: false }); await tick();
  assert.deepStrictEqual(h.lost, [true, false]);
  await h.call.hangUp();
});

test('adapter: attach throwing during a reopen stops and untracks the new stream, reports ok:false and leaves the old source alone', async () => {
  const base = voiceLiveTracks();
  const { b, vad, events } = await liveVad();
  assert.strictEqual(voiceLiveTracks(), base + 2);
  b.ctxs[0].createMediaStreamSource = () => { throw new Error('no source'); };
  assert.strictEqual(await vad.reopen(), false);
  assert.strictEqual(events.change.length, 1);
  assert.strictEqual(events.change[0].ok, false); assert.strictEqual(events.change[0].reason, 'manual'); assert.strictEqual(events.change[0].error.message, 'no source');
  assert.ok(b.tracks[1].stopped >= 1, 'the new stream is stopped');
  assert.strictEqual(voiceLiveTracks(), base + 2, 'the new stream is untracked, the old one is still the live one');
  assert.strictEqual(b.tracks[0].stopped, 0, 'the old raw is untouched');
  assert.strictEqual(b.sources[0].disconnected, 0, 'the old source is untouched');
  await vad.stop();
  assert.strictEqual(voiceLiveTracks(), base);
});

test('adapter: a context in state interrupted is resumed before the new source is attached', async () => {
  const { b, vad, events } = await liveVad();
  const ctx = b.ctxs[0], log = [];
  ctx.state = 'interrupted';
  const resume = ctx.resume.bind(ctx), make = ctx.createMediaStreamSource.bind(ctx);
  ctx.resume = async () => { log.push('resume'); await resume(); };
  ctx.createMediaStreamSource = (raw) => { log.push('source:' + ctx.state); return make(raw); };
  assert.strictEqual(await vad.reopen(), true);
  assert.deepStrictEqual(log, ['resume', 'source:running']);
  assert.strictEqual(events.change[0].ok, true);
  log.length = 0;
  assert.strictEqual(await vad.reopen(), true);
  assert.deepStrictEqual(log, ['source:running'], 'a running context is not resumed');
  await vad.stop();
});

test('adapter: setPlaybackActive(false) after stop() starts no timer', async () => {
  const { k, vad } = await liveVad();
  vad.setPlaybackActive(true);
  await vad.stop();
  vad.setPlaybackActive(false);
  assert.strictEqual(k.timers.length, 0, 'no hold timer after the adapter was released');
  vad.setPlaybackActive(true); vad.setPlaybackActive(false);
  assert.strictEqual(k.timers.length, 0);
});

test('voiceCarRecord: the microphone channel goes through the Mic level exactly as in a call (the reference does not)', async () => {
  const g = carRig({ t: 1.5, opts: { micLevel: 100 } });
  await tick();
  const micGain = g.ctx.gains[0];
  assert.ok(Math.abs(micGain.gain.value - V.voiceGainFromSlider(100)) < 1e-9, 'Mic level 100 = +12 dB on the microphone');
  assert.ok(Math.abs(20 * Math.log10(micGain.gain.value) - 12) < 0.01);
  for (const s of g.ctx.bufSources) assert.ok(!s.to.some(t => t.x === micGain), 'no chirp goes through the Mic level');
  g.rec.cancel(); await tick();
  assert.ok(micGain.disconnected >= 1, 'the Mic level node is let go too');
});

test('voiceCarAnalyse: the first onset can only be the first chirp (a strong later chirp is not taken first) at 44.1 kHz', () => {
  for (const rate of [44100, 16000]) {
    const chirp = V.voiceCarChirp(rate), len = Math.round(5.2 * rate);
    const ref = new Float32Array(len), mic = noise(len, -55, 7);
    for (const a of V.VOICE_CAR_AT) { const o = Math.round(a * rate); ref.set(chirp, o); const d = o + Math.round(0.23 * rate); for (let i = 0; i < chirp.length; i++) mic[d + i] += chirp[i] * 0.1; }
    const r = V.voiceCarAnalyse(mic, ref, chirp, rate);
    assert.deepStrictEqual(r.map(x => x.delayMs !== null && Math.abs(x.delayMs - 230) <= 3), [true, true, true], rate + ' Hz: all three found at 230 ms');
  }
});

test('adapter: a resume that never settles (iOS during a phone call) is given 3 s, then the microphone is reported lost and the new stream let go', async () => {
  const { b, k, vad, events } = await liveVad();
  const ctx = b.ctxs[0];
  ctx.state = 'interrupted';
  ctx.resume = () => new Promise(() => {});   // pending until the interruption ends
  const p = vad.reopen();
  await tick();
  assert.strictEqual(events.change.length, 0, 'still waiting');
  await k.advance(3000);
  assert.strictEqual(await p, false);
  assert.strictEqual(events.change.length, 1);
  assert.strictEqual(events.change[0].ok, false, 'reported lost, not recovered');
  const fresh = b.tracks[b.tracks.length - 1];
  assert.ok(fresh.stopped >= 1, 'the new stream is let go');
  // the reopen settled: Tap to talk can try again later
  ctx.state = 'running'; ctx.resume = async () => {};
  assert.strictEqual(await vad.reopen(), true);
  await vad.stop();
});

test('round 3: a resume that wins clears its 3 s deadline (no timer left behind)', async () => {
  const { b, k, vad } = await liveVad();
  const ctx = b.ctxs[0];
  ctx.state = 'interrupted';
  const before = k.timers.length;
  assert.strictEqual(await vad.reopen(), true);
  assert.strictEqual(k.timers.length, before, 'the deadline timer was cleared');
  await vad.stop();
});

test('mic lines survive a cut line once: sending the person\'s last words stops playback, "I lost the microphone" is still said', async () => {
  const h = await callStarted();
  h.call.onSpeechEnd({ text: 'a question' }); await tick(60);
  h.call.onReplyText('First sentence. Second sentence.', true); await tick();
  h.handlers.onMicChange({ ok: false, reason: 'ended' });
  await h.finish(false);   // the reply line is cut (for example the send of the last words stopped playback)
  await tick();
  assert.deepStrictEqual(h.spoken.slice(-1), ['I lost the microphone. Tap to talk to carry on.'], 'the mic line is tried after the cut');
  assert.ok(!h.spoken.includes('Second sentence.'), 'the rest of the cut reply is dropped as before');
  const n = h.spoken.length;
  await h.finish(false);   // its own first attempt is cut: a waiting line kept its retry, so it is tried once more
  await tick();
  assert.strictEqual(h.spoken.length, n + 1, 'one more attempt');
  await h.finish(false); await tick();   // cut again: dropped (at most two real attempts, no loop)
  assert.strictEqual(h.spoken.length, n + 1, 'no further attempt');
  // a mic line that is itself cut while playing is tried once more
  const h2 = await callStarted();
  h2.handlers.onMicChange({ ok: false, reason: 'ended' }); await tick();
  assert.deepStrictEqual(h2.spoken, ['I lost the microphone. Tap to talk to carry on.']);
  await h2.finish(false); await tick();
  assert.deepStrictEqual(h2.spoken, ['I lost the microphone. Tap to talk to carry on.', 'I lost the microphone. Tap to talk to carry on.'], 'tried once more');
  await h2.finish(false); await tick();
  assert.strictEqual(h2.spoken.length, 2, 'and not again');
  h2.call.release('test');
  h.call.release('test');
});

test('mic lines: a waiting mic line keeps its own retry; a lost line still waiting is dropped when the microphone comes back', async () => {
  const h = await callStarted();
  h.call.onSpeechEnd({ text: 'a question' }); await tick(60);
  h.call.onReplyText('First sentence. Second sentence.', true); await tick();
  h.handlers.onMicChange({ ok: false, reason: 'ended' });
  h.handlers.onMicChange({ ok: true, reason: 'manual', changed: false });
  await h.finish(false); await tick();   // the reply line is cut: "lost" was already dropped by the return, "back" is said
  assert.deepStrictEqual(h.spoken.slice(1), ['The microphone is back.'], 'no stale "lost" line, the back line is said');
  h.call.release('test');
  const g = await callStarted();
  g.call.onSpeechEnd({ text: 'a question' }); await tick(60);
  g.call.onReplyText('First sentence.', true); await tick();
  g.handlers.onMicChange({ ok: true, reason: 'devicechange', changed: true });   // "I've switched microphones." waits
  g.handlers.onMicChange({ ok: false, reason: 'ended' });                          // and the lost line waits behind it
  await g.finish(false); await tick();   // reply cut: both mic lines kept
  assert.strictEqual(g.spoken[g.spoken.length - 1], "I've switched microphones.");
  await g.finish(false); await tick();   // the switched line is cut on its own attempt: it is retried, the lost line still waits with its retry
  assert.strictEqual(g.spoken[g.spoken.length - 1], "I've switched microphones.");
  await g.finish(true); await tick();
  assert.strictEqual(g.spoken[g.spoken.length - 1], 'I lost the microphone. Tap to talk to carry on.', 'the waiting lost line still gets its attempt');
  g.call.release('test');
});
