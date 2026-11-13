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
