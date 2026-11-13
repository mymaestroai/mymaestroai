'use strict';
// Bluetooth / car audio on the phone page: keep-alive, echo guard, the two settings, the microphone line, a lost microphone,
// the Car or Bluetooth check, the new help text, and Media Session left as it was.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const V = require('../lib/ui-voice');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const js = read('mobile.js');
const html = read('mobile.html');
const sliceBetween = (a, b) => { const i = js.indexOf(a), j = js.indexOf(b, i + a.length); assert.ok(i > 0 && j > i, a + ' .. ' + b); return js.slice(i, j); };
const baseJs = (() => { try { return execFileSync('git', ['-C', ROOT, 'show', '5e69a44:mobile.js'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 }); } catch { return null; } })();

const tick = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const el = (o) => Object.assign({ textContent: '', hidden: false, disabled: false, value: '', checked: false, listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } }, o || {});

// ── the call: deps, keep-alive, echo guard, microphone line, test hooks ──
const CALL_SRC = () => sliceBetween('function voiceThinkingClose(vc)', 'function voiceCallWire()');

function callEnv(over) {
  const o = over || {};
  const log = [], els = {};
  const getEl = (id) => (els[id] = els[id] || el({ hidden: id === 'cp-retry-mic' }));
  getEl('cp-retry-mic'); getEl('cp-mic');
  const prefs = Object.assign({ micLevel: 50, interruptSensitivity: 50, echoHold: 600, keepAlive: true, thinkingSound: true, thinkingVolume: 0.5 }, o.prefs || {});
  class AC { constructor() { this.state = 'running'; this.destination = {}; AC.made.push(this); } resume() { return Promise.resolve(); } close() { this.closed = true; return Promise.resolve(); } }
  AC.made = [];
  const win = { AudioContext: AC };
  const created = { kaCtx: [], vadOpts: null, deps: null, ka: null, vad: null, call: null };
  const env = {
    window: win, current: 'bob', toast: (t) => log.push('toast:' + t), voiceOn: () => true, voiceRec: { state: 'idle' }, voiceMicCancel() {}, voiceTest: { handle: null }, voiceTestStop() {}, voiceRoomStop() {},
    voiceStopPlayback() {}, voiceUnlockAudio() {}, voicePrefsNow: () => prefs, voiceEndPauseNow: () => 1200, voiceEndedBar() {}, voiceCallBgNote: false,
    voiceCreateVad: (opts) => { created.vadOpts = opts; created.vad = { setMicLevel() {}, setInterruptSensitivity() {}, setEndPause() {}, setEchoHold: (ms) => log.push('setEchoHold:' + ms), setPlaybackActive() {}, stop() {} }; return created.vad; },
    voiceCreateCall: (deps) => { created.deps = deps; created.call = { start: () => new Promise(() => {}), retryMic: () => { log.push('retryMic'); return Promise.resolve(true); }, hangUp: () => { log.push('hangUp'); return Promise.resolve([]); }, setPrefs() {} }; return created.call; },
    voiceCreateKeepAlive: (opts) => { created.kaCtx.push(opts.ctx); created.ka = { running: false, start() { this.running = true; log.push('ka.start'); }, stop() { this.running = false; log.push('ka.stop'); } }; return created.ka; },
    voiceCreateThinkingSound: (opts) => ({ opts, setVolume() {}, start() {}, stop() {}, pulse() { return true; } }),
    voiceMediaSession() {}, voiceCallBeat() {}, setInterval: () => 0, clearInterval() {}, voiceCallPanel() {}, voiceCallPaintState() {}, voiceMicPaint() {}, voiceCallTeardown() {}, voiceWakeAcquire() {},
    voiceCallServer: () => ({}), $: getEl, voiceCallPaintMeter() {}, voiceCallPaintHeld() {}, voiceDisplayHook() {}, voiceDisp: { turnSeq: new Map() }, voiceThinkingVolume: undefined,
  };
  delete env.voiceThinkingVolume;
  const names = Object.keys(env);
  const body = 'let voiceCall = null;\n' + CALL_SRC() + '\nreturn { voiceCallStart, voiceCallDeps, voiceCallApplyPrefs, voiceThinkingClose, voiceMicLine, getCall: () => voiceCall };';
  const fns = new Function(...names, body)(...names.map((n) => env[n]));
  return { fns, log, els, prefs, created, AC, win };
}

test('help text: the call help names Bluetooth hands-free in a car or speaker (app, phone page)', () => {
  const want = 'Hands-free works with the app open and the screen on, also through a car\'s Bluetooth hands-free or a Bluetooth speaker. Locked-screen use and car apps (CarPlay, Android Auto) are not supported.';
  assert.ok(js.includes("const VOICE_CALL_HELP = '" + want.replace(/'/g, "\\'") + "';"), 'VOICE_CALL_HELP');
  assert.ok(html.includes('<p id="cp-help">' + want.replace(/'/g, '&#39;') + '</p>') || html.includes('<p id="cp-help">' + want + '</p>'), 'cp-help in the html');
});

test('keep-alive: made on the call\'s thinking context inside the tap when the pref is on, and passed as deps.keepAlive', () => {
  const { fns, created, AC, log } = callEnv();
  fns.voiceCallStart();
  const vc = fns.getCall();
  assert.ok(vc && vc.thinkCtx, 'the thinking context is made in the tap');
  assert.strictEqual(created.kaCtx.length, 1);
  assert.strictEqual(created.kaCtx[0], vc.thinkCtx, 'keep-alive plays on the call\'s thinking context');
  assert.strictEqual(AC.made.length, 1, 'one context only');
  assert.strictEqual(created.deps.keepAlive, created.ka, 'deps.keepAlive');
  assert.ok(!log.includes('ka.start'), 'the controller starts it, not the page');
  const src = sliceBetween('function voiceCallStart()', 'function voiceCallWire()');
  assert.ok(src.indexOf('voiceThinkingCtxMake(vc)') < src.indexOf('voiceCreateCall('), 'the context exists before the controller is made');
});

test('keep-alive: not made when the pref is off; made when the pref is missing (default on)', () => {
  const off = callEnv({ prefs: { keepAlive: false } });
  off.fns.voiceCallStart();
  assert.strictEqual(off.created.kaCtx.length, 0);
  assert.strictEqual(off.created.deps.keepAlive, undefined);
  const dflt = callEnv({ prefs: { keepAlive: undefined } });
  dflt.fns.voiceCallStart();
  assert.strictEqual(dflt.created.kaCtx.length, 1);
});

test('keep-alive: stopped in the page\'s own teardown (voiceThinkingClose) before its context is closed', () => {
  const { fns, created, log } = callEnv();
  fns.voiceCallStart();
  const vc = fns.getCall(), ctx = vc.thinkCtx;
  created.ka.running = true;
  fns.voiceThinkingClose(vc);
  assert.ok(log.includes('ka.stop'));
  assert.strictEqual(ctx.closed, true);
  assert.strictEqual(vc.keepAlive, null);
});

test('echo guard: echoHoldMs is passed to the VAD and a change during a call goes to vad.setEchoHold', () => {
  const { fns, created, prefs, log } = callEnv({ prefs: { echoHold: 1000 } });
  fns.voiceCallStart();
  assert.strictEqual(created.vadOpts.echoHoldMs, 1000);
  prefs.echoHold = 0;
  fns.voiceCallApplyPrefs();
  assert.ok(log.includes('setEchoHold:0'));
  prefs.echoHold = 1500;
  fns.voiceCallApplyPrefs();
  assert.ok(log.includes('setEchoHold:1500'));
});

test('microphone line: label or default, kHz when known, basic mode on fallback; plain text only', () => {
  const { fns, els } = callEnv();
  assert.strictEqual(fns.voiceMicLine({ label: 'Car kit', sampleRate: 16000, fallback: false }), 'Microphone: Car kit · 16 kHz');
  assert.strictEqual(fns.voiceMicLine({ label: '', sampleRate: 44100 }), 'Microphone: default · 44.1 kHz');
  assert.strictEqual(fns.voiceMicLine({ label: 'Headset', fallback: true }), 'Microphone: Headset · basic mode');
  assert.strictEqual(fns.voiceMicLine({}), 'Microphone: default');
  void els;
  const evil = '<img src=x onerror=alert(1)>';
  const e2 = callEnv();
  e2.fns.voiceCallStart();
  e2.created.deps.ui.mic({ label: evil, sampleRate: 48000, fallback: true });
  const line = e2.els['cp-mic'];
  assert.strictEqual(line.textContent, 'Microphone: ' + evil + ' · 48 kHz · basic mode');
  assert.ok(!('innerHTML' in line) || line.innerHTML === undefined, 'textContent only');
  assert.ok(!/cp-mic[^;]*innerHTML/.test(sliceBetween('function voiceMicLine(', 'function voiceCallDeps(vc)')));
  assert.deepStrictEqual(e2.fns.getCall().micInfo && e2.fns.getCall().micInfo.sampleRate, 48000);
});

test('lost microphone: micLost(true) shows the Tap to talk button, false hides it; the button calls retryMic; the call is not ended', () => {
  const e = callEnv();
  e.fns.voiceCallStart();
  const btn = e.els['cp-retry-mic'];
  assert.strictEqual(btn.hidden, true, 'hidden at the start');
  e.created.deps.ui.micLost(true);
  assert.strictEqual(btn.hidden, false);
  assert.ok(!e.log.includes('hangUp'), 'the call goes on');
  // the wiring
  const wireSrc = sliceBetween('function voiceCallWire()', '// Hub events for the call');
  const els = { 'cp-retry-mic': el() };
  const state = { call: null };
  const wire = new Function('$', 'voiceCall', 'voiceCallHangUp', 'openVoiceSheet', 'voicePanelWire', 'VOICE_CALL_HELP', wireSrc + '\nreturn voiceCallWire;')((id) => els[id] || null, { call: { retryMic: () => { state.retried = (state.retried || 0) + 1; return Promise.resolve(true); } } }, () => state.hung = true, () => {}, () => {}, 'help');
  wire();
  assert.strictEqual(typeof els['cp-retry-mic'].listeners.click, 'function');
  els['cp-retry-mic'].listeners.click();
  assert.strictEqual(state.retried, 1);
  assert.ok(!state.hung);
  e.created.deps.ui.micLost(false);
  assert.strictEqual(btn.hidden, true);
});

test('test hooks: window.__voiceBt reads keep-alive, mic info, mic lost and echo hold', () => {
  const e = callEnv({ prefs: { echoHold: 1000 } });
  e.fns.voiceCallStart();
  const h = e.win.__voiceBt;
  assert.ok(h);
  assert.strictEqual(h.keepAliveRunning(), false);
  e.created.ka.running = true;
  assert.strictEqual(h.keepAliveRunning(), true);
  assert.strictEqual(h.micInfo(), null);
  e.created.deps.ui.mic({ label: 'X', sampleRate: 16000 });
  assert.strictEqual(h.micInfo().label, 'X');
  assert.strictEqual(h.micLost(), false);
  e.created.deps.ui.micLost(true);
  assert.strictEqual(h.micLost(), true);
  assert.strictEqual(h.echoHold(), 1000);
  e.prefs.echoHold = 600;
  assert.strictEqual(h.echoHold(), 600);
});

// ── settings ──
test('settings: the Voice sheet and the chat panel show Echo guard and Keep Bluetooth awake, and the check button', () => {
  const sheet = sliceBetween('function voiceSheet()', 'function paintVoiceSheet()');
  for (const s of ['Echo guard after replies', 'vs-echo', 'VOICE_ECHO_HINT', 'Keep Bluetooth awake during calls', 'vs-keepalive', 'VOICE_KEEPALIVE_HINT', 'Car or Bluetooth check', 'vs-car', 'vs-car-out']) assert.ok(sheet.includes(s), 'sheet: ' + s);
  assert.ok(js.includes("const VOICE_ECHO_HINT = 'Keeps the agent from hearing its own reply in a car or through a speaker.';"));
  assert.ok(js.includes("const VOICE_KEEPALIVE_HINT = 'Plays an inaudible hiss so a car or speaker does not cut the first word.';"));
  const panel = html.slice(html.indexOf('id="voice-panel"'), html.indexOf('id="voice-level"'));
  for (const s of ['Echo guard after replies', 'id="vp-echo"', 'Keeps the agent from hearing its own reply in a car or through a speaker.', 'Keep Bluetooth awake during calls', 'id="vp-keepalive"',
    'Plays an inaudible hiss so a car or speaker does not cut the first word.', 'Car or Bluetooth check', 'id="vp-car"', 'vs-car-out']) assert.ok(panel.includes(s), 'panel: ' + s);
  assert.match(panel, /class="vs-car-out"[^>]*aria-live="polite"|aria-live="polite"[^>]*class="vs-car-out"/);
  assert.ok(sheet.includes("aria-live=\"polite\"") );
  assert.match(js, /const VOICE_ECHO_LABELS = \['Off', '0\.6 s', '1 s', '1\.5 s'\]/);
});

test('settings: both places save echoHold / keepAlive and stay in step', () => {
  const sheet = sliceBetween('function voiceSheet()', 'function paintVoiceSheet()');
  assert.match(sheet, /voicePrefsSave\(\{ echoHold: Number\(echo\.value\) \}\)/);
  assert.match(sheet, /voicePrefsSave\(\{ keepAlive: !!e\.target\.checked \}\)/);
  assert.match(sheet, /\.vs-car'\)\.addEventListener\('click', voiceCarRun\)/);
  assert.match(sheet, /const close = \(\) => \{[^}]*voiceRoomStop\(\)/, 'closing the sheet goes through voiceRoomStop, which cancels a running check');
  const wire = sliceBetween('function voicePanelWire()', '// The message box keeps a draft per agent');
  assert.match(wire, /\$\('vp-echo'\)\?\.addEventListener\('change', \(\) => save\(\{ echoHold: Number\(echo\.value\) \}\)\)/);
  assert.match(wire, /\$\('vp-keepalive'\)\?\.addEventListener\('change', \(e\) => save\(\{ keepAlive: !!e\.target\.checked \}\)\)/);
  assert.match(wire, /\$\('vp-car'\)\?\.addEventListener\('click', voiceCarRun\)/);
  assert.match(wire, /VOICE_ECHO_HOLDS\.map\(/);
  const paintSheet = sliceBetween('function paintVoiceSheet()', 'function openVoiceSheet()');
  assert.match(paintSheet, /\.vs-echo/); assert.match(paintSheet, /\.vs-keepalive/);
  const paintPanel = sliceBetween('function voicePanelPaint()', 'function voicePanelShow(show)');
  assert.match(paintPanel, /'vp-echo', prefs\.echoHold/); assert.match(paintPanel, /\$\('vp-keepalive'\)/);
  const closeSrc = sliceBetween('function voicePanelShow(show)', 'function voicePanelWire()');
  assert.match(closeSrc, /voiceRoomStop\(\)/);   // voiceRoomStop also cancels a car check
  assert.match(sliceBetween('function voiceRoomStop()', 'async function voiceRoomRun()'), /voiceCarStop\(\)/);
});

// ── the Car or Bluetooth check ──
const CAR_SRC = () => sliceBetween('// ── Car or Bluetooth check', '// ── Leaving the app (round 2, item 8) ──');

function carEnv(over) {
  const o = over || {};
  const log = [], saved = [];
  const out = el(), btn = el(), meter = el();
  const root = { querySelector: (s) => (s === '.vs-car-out' ? out : s === '.vs-car' ? btn : s === '.vs-meter i' ? meter : null) };
  const rate = 8000;
  const clock = { t: 5 };
  const starts = [], bufs = [];
  const ctx = {
    sampleRate: rate, destination: { id: 'dest' }, get currentTime() { return clock.t; },
    createBuffer: (ch, n, r) => { const b = { n, r, data: new Float32Array(n), getChannelData() { return this.data; } }; bufs.push(b); return b; },
    createBufferSource: () => { const s = { buffer: null, connect: (d) => { s.to = d; }, start: (t) => starts.push({ t, buffer: s.buffer, to: s.to }) }; return s; },
  };
  const handle = { rate, ctx, closed: 0, close() { this.closed++; } };
  let onChunk = null, openArgs = null;
  const prefs = Object.assign({ micLevel: 60, interruptSensitivity: 50, echoHold: 600, keepAlive: true }, o.prefs || {});
  let tickFn = null;
  const env = {
    voiceRoomRoot: () => root, voiceCall: o.call || null, toast: (t) => log.push('toast:' + t), voiceRec: { state: 'idle', guard: { pending: false } }, voiceTest: { guard: { pending: false }, handle: null }, voiceRoom: { running: false },
    voiceStopPlayback: () => log.push('stopPlayback'), voicePrefsNow: () => Object.assign({}, prefs),
    voiceMicGuard: V.voiceMicGuard, voiceMicOpen: async (level, f) => { openArgs = { level }; if (o.openError) throw o.openError; onChunk = f; return handle; },
    voiceErr: (e) => 'err:' + (e && e.message), voiceCarChirp: V.voiceCarChirp, voiceEchoAnalysis: V.voiceEchoAnalysis, voiceCarCheckResult: V.voiceCarCheckResult,
    voicePrefsSave: (p) => { saved.push(p); Object.assign(prefs, p); }, paintVoiceSheet: () => log.push('paintSheet'), voicePanelPaint: () => log.push('paintPanel'),
    setInterval: (f) => { tickFn = f; return 1; }, clearInterval: () => { tickFn = null; },
  };
  const names = Object.keys(env);
  const body = CAR_SRC().replace(/\bvoiceCall\b/g, 'env_voiceCall') + '\nreturn { voiceCarRun, voiceCarStop, voiceCarSlice, voiceCar };';
  const fns = new Function(...names, 'env_voiceCall', body)(...names.map((n) => env[n]), o.call || null);
  return { fns, log, saved, out, btn, handle, ctx, clock, starts, bufs, rate, prefs, feed: (f, t) => onChunk(f, t), openArgs: () => openArgs, tick: () => tickFn && tickFn(), hasTick: () => !!tickFn };
}

test('car check: opens the mic like the Room check, plays three chirps at t0+0.6/1.6/2.6 on the same context, records until t0+3.8, saves the result', async () => {
  const e = carEnv();
  const run = e.fns.voiceCarRun();
  await tick();
  await run;
  assert.strictEqual(e.openArgs().level, 60, 'the same helper and the mic level pref');
  assert.strictEqual(e.out.textContent, 'Playing three short test sounds. Stay quiet.');
  assert.strictEqual(e.btn.disabled, true);
  const t0 = 5;
  assert.deepStrictEqual(e.starts.map((s) => Math.round((s.t - t0) * 10) / 10), [0.6, 1.6, 2.6]);
  for (const s of e.starts) { assert.strictEqual(s.to, e.ctx.destination); assert.strictEqual(s.buffer.n, V.voiceCarChirp(e.rate).length); assert.strictEqual(s.buffer.r, e.rate); }
  // simulate a car: the chirp comes back 500 ms after it was scheduled, quiet otherwise; blocks of 4096 with their start time
  const rate = e.rate, chirp = V.voiceCarChirp(rate), total = Math.round(3.8 * rate);
  const rec = new Float32Array(total);
  for (const g of [0.6, 1.6, 2.6]) rec.set(chirp, Math.round((g + 0.5) * rate));
  for (let i = 0; i < total; i += 4096) e.feed(rec.slice(i, i + 4096), t0 + i / rate);
  e.clock.t = t0 + 3.5; e.tick();
  assert.strictEqual(e.handle.closed, 0, 'still recording before t0+3.8');
  e.clock.t = t0 + 3.8; e.tick();
  assert.strictEqual(e.handle.closed, 1, 'the microphone is released');
  assert.strictEqual(e.fns.voiceCar.running, false);
  assert.strictEqual(e.btn.disabled, false);
  const want = V.voiceCarCheckResult([0, 1, 2].map((i) => V.voiceEchoAnalysis(chirp, rec.slice(Math.round((0.6 + i) * rate), Math.round((0.6 + i + 1.5) * rate)), rate)), { echoHold: 600, interruptSensitivity: 50 });
  assert.strictEqual(want.heard, true);
  assert.strictEqual(want.echoHold, 1000);
  assert.deepStrictEqual(e.saved, [{ echoHold: want.echoHold, interruptSensitivity: want.interruptSensitivity }]);
  assert.strictEqual(e.out.textContent, want.line);
  assert.ok(e.log.includes('paintSheet') && e.log.includes('paintPanel'));
});

test('car check: block times fall back to the context clock when playbackTime is missing; voiceCarSlice places blocks by time', async () => {
  const e = carEnv();
  const S = e.fns.voiceCarSlice;
  const a = Float32Array.from([1, 2, 3, 4]), b = Float32Array.from([5, 6, 7, 8]);
  const out = S([{ t: 10, data: a }, { t: 10 + 4 / 100, data: b }], 100, 10.02, 0.08);   // rate 100: starts at sample 2 of the first block
  assert.deepStrictEqual(Array.from(out), [3, 4, 5, 6, 7, 8, 0, 0]);
  assert.deepStrictEqual(Array.from(S([{ t: 10, data: a }], 100, 9.98, 0.06)), [0, 0, 1, 2, 3, 4].map((x) => x));
  const run = e.fns.voiceCarRun(); await tick(); await run;
  e.clock.t = 7.5; e.feed(Float32Array.from([1, 1]), undefined);
  e.clock.t = 9; e.tick(); e.clock.t = 9.2; e.tick();
  assert.strictEqual(e.fns.voiceCar.running, false);
});

test('car check: nothing heard keeps the settings and says so; the line is shown', async () => {
  const e = carEnv();
  const run = e.fns.voiceCarRun(); await tick(); await run;
  e.feed(new Float32Array(4096), 5.1);
  e.clock.t = 9; e.tick();
  assert.deepStrictEqual(e.saved, [{ echoHold: 600, interruptSensitivity: 50 }]);
  assert.match(e.out.textContent, /^No echo of the test sound reached the microphone/);
  assert.strictEqual(e.handle.closed, 1);
});

test('car check: refused during a call and while the mic is busy, with the Room check messages', async () => {
  const c = carEnv({ call: { x: 1 } });
  await c.fns.voiceCarRun();
  assert.deepStrictEqual(c.log.filter((l) => l.startsWith('toast')), ['toast:Hang up first: the call is using the microphone']);
  assert.strictEqual(c.openArgs(), null);
  const src = CAR_SRC();
  assert.match(src, /toast\('The mic is already in use'\)/);
  assert.match(src, /voiceRec\.state !== 'idle' \|\| voiceRec\.guard\.pending \|\| voiceTest\.guard\.pending \|\| voiceTest\.handle \|\| voiceRoom\.running/);
  const busy = carEnv();
  busy.fns.voiceCar.running = true;
  await busy.fns.voiceCarRun();
  assert.strictEqual(busy.openArgs(), null, 'a second tap while running does nothing');
});

test('car check: an open error and a cancel release everything', async () => {
  const f = carEnv({ openError: new Error('no mic') });
  await f.fns.voiceCarRun();
  assert.ok(f.log.includes('toast:err:no mic'));
  assert.strictEqual(f.fns.voiceCar.running, false);
  assert.strictEqual(f.btn.disabled, false);
  const e = carEnv();
  const run = e.fns.voiceCarRun(); await tick(); await run;
  assert.strictEqual(e.fns.voiceCar.running, true);
  e.fns.voiceCarStop();
  assert.strictEqual(e.handle.closed, 1);
  assert.strictEqual(e.fns.voiceCar.running, false);
  assert.strictEqual(e.btn.disabled, false);
  assert.strictEqual(e.out.textContent, '');
  assert.strictEqual(e.hasTick(), false);
  assert.deepStrictEqual(e.saved, []);
  e.fns.voiceCarStop();   // safe to repeat
  assert.strictEqual(e.handle.closed, 1);
});

test('car check: voiceMicOpen hands out its context and each block\'s playbackTime; the other mic users refuse while it runs', () => {
  const open = sliceBetween('async function voiceMicOpen', 'function voiceMeterPaint');
  assert.match(open, /onChunk\(new Float32Array\(ev\.inputBuffer\.getChannelData\(0\)\), ev\.playbackTime\)/);
  assert.match(open, /rate: ctx\.sampleRate, ctx,/);
  assert.match(sliceBetween('async function voiceRoomRun()', '// ── Voice sheet (menu, Voice) ──'), /voiceCar\.running/);
  assert.match(sliceBetween('async function voiceTestToggle()', '// ── Car or Bluetooth check'), /voiceCar\.running/);
});

// ── things that must not change ──
const fnSrc = (text, name) => { const i = text.indexOf('function ' + name + '('); assert.ok(i > 0, name); const j = text.indexOf('\nfunction voiceCallStalled(', i); assert.ok(j > i); return text.slice(i, j); };
test('Media Session code is unchanged against the base commit', { skip: baseJs === null }, () => {
  assert.strictEqual(fnSrc(js, 'voiceMediaSession'), fnSrc(baseJs, 'voiceMediaSession'));
  assert.ok(js.includes("for (const a of ['pause', 'stop']) { try { ms.setActionHandler(a, () => voiceCallHangUp()); }"));
});

test('the call panel has the microphone line and the Tap to talk button, hidden to begin with', () => {
  assert.match(html, /<div id="cp-mic"[^>]*><\/div>/);
  assert.match(html, /<button type="button" id="cp-retry-mic"[^>]*hidden[^>]*>Tap to talk<\/button>/);
  const i = html.indexOf('id="call-panel"'), j = html.indexOf('id="composer"');
  assert.ok(html.indexOf('id="cp-mic"') > i && html.indexOf('id="cp-retry-mic"') < j);
});
