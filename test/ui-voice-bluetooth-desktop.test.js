'use strict';
// Bluetooth and car audio, desktop page (app.js): keep-alive on the reply output context, the echo guard, the two per-device settings,
// the microphone line and "Tap to talk" in the call bar, the Car or Bluetooth check, the new help text and the test hooks.
// The page code is run against fakes (the controller and the lib are tested in their own files).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js');

function between(a, b) {
  const i = app.indexOf(a), j = app.indexOf(b, i + a.length);
  assert.ok(i > 0 && j > i, 'found ' + a);
  return app.slice(i, j);
}
const wiring = () => between('    // ── Hands-free call (voice phase 2)', '    // Message rendering\n');
const settingsPart = () => between('    // Settings, Voices.\n', '    // A closed chat stops its dictation');
const flush = () => new Promise((r) => setImmediate(r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function el(id, extra = {}) {
  const attrs = {}, cls = new Set();
  const e = Object.assign({
    id, style: {}, dataset: {}, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, isConnected: true, checked: false,
    classList: { toggle(c, on) { if (on) cls.add(c); else cls.delete(c); }, contains: (c) => cls.has(c) },
    setAttribute(k, v) { attrs[k] = v; }, attrs, listeners: {},
    addEventListener(t, f) { e.listeners[t] = f; }, remove() { e.removed = true; e.isConnected = false; },
  }, extra);
  return e;
}

const HOLDS = [0, 600, 1000, 1500];
function makeEnv(opts = {}) {
  const log = { saved: [], vad: [], vadOpts: [], thinking: [], created: [], toasts: [], ka: [], kaCtx: [], retry: 0, hung: 0, micClosed: 0, starts: [], chirps: [], analyses: [], results: [], recs: [], opens: 0 };
  const els = {};
  const get = (id) => (els[id] || (els[id] = el(id)));
  const popBtns = { room: el('pop-room'), car: el('pop-car'), echo: el('pop-echo'), keep: el('pop-keep') };
  const popOut = { car: el('pop-car-out'), room: el('pop-room-out') };
  const area = { parentNode: { insertBefore(bar) { log.bar = bar; els[bar.id] = bar; } } };
  get('input-c1').closest = () => area;
  let prefs = Object.assign({ micLevel: 50, interruptSensitivity: 50, mode: 'handsfree', endPause: 1200, voiceSpeed: 1, echoHold: 600, keepAlive: true }, opts.prefs || {});
  const vad = {
    setMicLevel() {}, setInterruptSensitivity(v) { log.vad.push(['sens', v]); }, setEndPause() {}, setEchoHold(v) { log.vad.push(['echo', v]); },
    setPlaybackActive(on) { log.vad.push(['playing', on]); }, stop() { return Promise.resolve(); },
  };
  const call = {
    callId: 'k1', async start() { return true; }, hangUp() { log.hung++; return Promise.resolve([]); }, setPrefs() {}, retryMic() { log.retry++; return Promise.resolve(true); }, release() {},
  };
  class FakeCtx {
    constructor() { this.state = 'running'; this.sampleRate = 8000; this.currentTime = 0; this.destination = { d: 1 }; (log.ctxs = log.ctxs || []).push(this); }
    resume() { this.resumed = (this.resumed || 0) + 1; return Promise.resolve(); }
    close() { this.closed = true; return Promise.resolve(); }
    createBuffer(ch, n, rate) { const data = new Float32Array(n); return { length: n, sampleRate: rate, getChannelData: () => data, copyToChannel: (a) => data.set(a) }; }
    createBufferSource() { const s = { buffer: null, connect(d) { s.to = d; }, start(when) { s.when = when; log.chirps.push(s); }, stop() {}, disconnect() {} }; return s; }
  }
  // voiceCarRecord of the library, replaced by a controllable fake: rec.resolve(value) / rec.reject(err); cancel() rejects with code 'cancelled'
  const carRecord = (o) => {
    let res, rej;
    const done = new Promise((a, b) => { res = a; rej = b; });
    const rec = { o, done, resolve: res, reject: rej, cancelled: 0, cancel() { rec.cancelled++; const e = new Error('cancelled'); e.code = 'cancelled'; rej(e); } };
    log.recs.push(rec);
    if (!opts.manualRec) res({ mic: new Float32Array(7).fill(1), ref: new Float32Array(7).fill(2), rate: 8000, fallback: false });
    return rec;
  };
  const voicePlay = { token: 0, ctx: null, source: null, btn: null };
  const stubs = {
    document: { hidden: false, getElementById: get, querySelectorAll: (sel) => (sel.includes('data-vp="room"') ? [popBtns.room].concat(sel.includes('data-vp="car"') ? [popBtns.car] : []) : sel === '.voice-pop .vp-car-out' ? [popOut.car] : sel === '.voice-pop .vp-room-out' ? [popOut.room] : sel.includes('data-vp="car"') ? [popBtns.car] : sel.includes('data-vp="echo"') ? [popBtns.echo] : sel.includes('data-vp="keep"') ? [popBtns.keep] : []), addEventListener() {}, createElement: () => el('', {}), querySelector: () => (opts.noSection ? null : { isConnected: true }) },
    navigator: {}, localStorage: {}, fetch: async () => ({ ok: true, status: 200, json: async () => ({ call: { callId: 'k1' } }) }),
    hubToast: (t) => log.toasts.push(t), hubEsc: (s) => String(s), chats: { c1: { agent: 'alice', status: 'idle' } }, agentStatus: {},
    voicePrefsNow: () => prefs, voiceEffNow: () => ({ ...require('../lib/ui-voice').VOICE_DEFAULT_PREFS, ...prefs }), voiceSpeedFor: () => prefs.voiceSpeed || 1, voiceFollowLine: () => '', voiceMarkChosen: require('../lib/ui-voice').voiceMarkChosen, voiceEffectivePrefs: require('../lib/ui-voice').voiceEffectivePrefs, VOICE_AGENT_DEFAULT_KEYS: require('../lib/ui-voice').VOICE_AGENT_DEFAULT_KEYS, VOICE_DEFAULT_PREFS: require('../lib/ui-voice').VOICE_DEFAULT_PREFS, voiceMicLevelNow: () => prefs.micLevel, voiceSensNow: () => prefs.interruptSensitivity, voiceEndPauseNow: () => prefs.endPause,
    voiceSpeedNow: () => prefs.voiceSpeed || 1, voiceSpeedLabel: (v) => Number(v).toFixed(2) + 'x',
    voiceCleanSpeed: (v) => Math.round(Math.max(0.75, Math.min(1.5, Number(v))) * 20) / 20,
    voicePauseSelectHtml: (id, attrs) => `<select id="${id}" ${attrs}></select>`, VOICE_SPEED_HINT: '', VOICE_END_PAUSES: [800, 1200, 2000],
    voiceContinueWaitNow: () => 3000, voiceThinkingVolNow: () => 0.5, voiceThinkingOnNow: () => true, voiceModeLabel: () => 'Hands-free', VOICE_CONTINUE_WAITS: [1500, 3000, 5000],
    VOICE_LOUDNESS: { normal: 0, louder: 9, loudest: 14 }, voiceLoudnessNow: () => 'louder', voiceLoudnessFor: (p, kind) => (kind === 'bluetooth' ? 'normal' : 'louder'), voiceLoudnessSelectHtml: (id, attrs) => `<select id="${id}" ${attrs}></select>`, voiceLoudApply() {}, VOICE_ECHO_HOLDS: HOLDS, voiceEchoHoldLabel: (ms) => (ms === 0 ? 'off' : (ms / 1000) + ' s'),
    voiceSavePrefs: (s, p) => { prefs = { ...p }; log.saved.push({ ...p }); return { ...p }; },
    voiceById: get, voiceReady: () => true,
    voiceRec: { guard: { cancel() {}, pending: false }, chatId: null, busy: false },
    voiceMicGuard: () => ({ cancel() {}, pending: false, begin: () => 1, settle: () => true, fail() {}, gen: 1 }),
    dialogGuard: { savePoint: () => () => {}, markLoaded() {} }, isHubAdmin: () => true, voiceMicStop() {}, voiceStopPlayback() {}, voicePlay,
    voicePaint() {}, voiceMicStop2() {}, voiceGainFromSlider: (v) => v, voiceMeterPercent: (db) => db, voiceLevelDb: () => -100,
    VOICE_MIC_SVG: '<svg>mic</svg>', voiceSentences: (t) => [t], voiceSpeechText: (t) => t, voiceSpeakText: async () => {}, voiceEncodeWav: () => new ArrayBuffer(1),
    voiceBusyToast: () => false, voiceRefreshStatus() {}, voiceDeviceFallback: () => false,
    voiceCreateVad: (o) => { log.vadOpts.push(o); return vad; }, voiceCreateCall: (deps) => { log.created.push(deps); return call; },
    voiceCreateKeepAlive: (o) => { const k = { ctx: o && o.ctx, running: false, start() { k.running = true; log.ka.push('start'); }, stop() { k.running = false; log.ka.push('stop'); } }; log.kaCtx.push(o && o.ctx); log.keepAlive = k; return k; },
    voiceCreateThinkingSound: ({ ctx, volume }) => { const s = { ctx, volume, pulse() {}, start() { log.thinking.push('start'); }, stop() { log.thinking.push('stop'); }, setVolume() {} }; log.sound = s; return s; },
    voiceRoomCheck() {}, voiceCallMedian: () => null, voiceMicError: (e) => String(e),
    voiceOpenMic: async () => { log.opens++; return { close() {} }; },
    voiceCarChirp: (rate) => { log.chirpRate = rate; return (log.chirp = new Float32Array(10).fill(0.5)); },
    voiceCarRecord: carRecord,
    voiceCarAnalyse: (mic, ref, chirp, rate) => { log.analyses.push({ mic, ref, chirp, rate }); return [0, 1, 2].map(() => ({ delayMs: 120, echoDb: -30, confidence: 0.9 })); },
    voiceCarCheckResult: (an, cur) => { log.results.push({ an, cur }); return { echoHold: 1000, interruptSensitivity: 40, delayMs: 120, echoDb: -30, heard: true, line: 'The echo comes back after 120 ms.' }; },
    appendMessage() {}, appendSystemNotice() {}, stopAgentTurn() {}, sendSoloMessage: async () => {}, closeQuestion() {}, hubOriginLabel: () => '',
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Promise, performance,
    window: { AudioContext: FakeCtx, addEventListener() {} },
  };
  const names = Object.keys(stubs);
  const src = settingsPart() + '\n' + wiring() + '\nreturn { voiceCallS, voiceCallStart, voiceCallTeardown, voiceCallHangUp, voiceCtlSet, voicePopHtml, voiceSettingsHtml, voiceSettingsSavePrefs, voiceCarCheckRun, voiceRoom, voiceCallThinking, voiceCallShowBar, voiceCallDeps };';
  const api = new Function(...names, 'let voicePrefsCache = null;\n' + src)(...names.map((n) => stubs[n]));
  return { api, log, els, get, stubs, vad, call, popBtns, popOut, getPrefs: () => prefs, setPrefs: (p) => { prefs = p; } };
}

// ── help text and Media Session ──

test('help line: the new text; the old one is gone; the phone-only word "app" is not used on the desktop', () => {
  const NEW = "Hands-free works with the page open and the screen on, also through a car's Bluetooth hands-free or a Bluetooth speaker. Locked-screen use and car apps (CarPlay, Android Auto) are not supported.";
  assert.ok(app.includes("const VOICE_CALL_HELP = '" + NEW.replace(/'/g, "\\'") + "'") || app.includes('const VOICE_CALL_HELP = "' + NEW + '"'), 'VOICE_CALL_HELP is the spec text');
  assert.ok(!app.includes('locked-screen and car systems'));
});

test('Media Session handling is unchanged against the base commit', () => {
  const lines = (s) => s.split('\n').filter((l) => /mediaSession|MediaSession/.test(l));
  let base;
  try { base = execFileSync('git', ['-C', path.join(__dirname, '..'), 'show', '5e69a44:app.js'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch { return; }   // no history here: nothing to compare against
  assert.deepStrictEqual(lines(app), lines(base));
});

test('no emoji with U+FE0F and no zero-width characters in the new code', () => {
  for (const s of [settingsPart(), wiring()]) assert.ok(!/[\ufe0f\u200b\u200c\u200d\u2060\ufeff]/.test(s));
});

// ── keep-alive and the shared output context ──

test('keep-alive: made inside the tap on voicePlay.ctx and passed as deps.keepAlive; the thinking sound uses the same context', async () => {
  const { api, log, stubs } = makeEnv();
  const p = api.voiceCallStart('c1');   // not awaited: everything below must already have happened (inside the tap)
  assert.strictEqual(log.kaCtx.length, 1, 'made before any await');
  assert.ok(stubs.voicePlay.ctx, 'the reply playback context exists');
  assert.strictEqual(log.kaCtx[0], stubs.voicePlay.ctx);
  assert.strictEqual(log.created[0].keepAlive, log.keepAlive);
  assert.strictEqual(log.created[0].keepAlive.start !== undefined && log.created[0].keepAlive.stop !== undefined, true);
  assert.strictEqual(log.ctxs.length, 1, 'one output context for replies, the thinking pulse and the keep-alive');
  api.voiceCallS.thinking.start();
  assert.strictEqual(log.sound.ctx, stubs.voicePlay.ctx, 'the thinking sound goes out through voicePlay.ctx');
  assert.deepStrictEqual(log.vad.filter((x) => x[0] === 'playing'), [['playing', true]], 'still tells the VAD playback is active');
  api.voiceCallS.thinking.stop();
  assert.deepStrictEqual(log.vad.filter((x) => x[0] === 'playing').pop(), ['playing', false]);
  await p;
});

test('keep-alive: not made when the pref is off; a closed voicePlay.ctx is replaced', async () => {
  const off = makeEnv({ prefs: { keepAlive: false } });
  await off.api.voiceCallStart('c1');
  assert.strictEqual(off.log.kaCtx.length, 0);
  assert.strictEqual(off.log.created[0].keepAlive, undefined);
  const on = makeEnv();
  on.stubs.voicePlay.ctx = { state: 'closed' };
  await on.api.voiceCallStart('c1');
  assert.notStrictEqual(on.stubs.voicePlay.ctx.state, 'closed');
  assert.strictEqual(on.log.kaCtx[0], on.stubs.voicePlay.ctx);
});

test('thinking.close() no longer closes the shared output context; the page teardown stops the keep-alive', async () => {
  const { api, log, stubs } = makeEnv();
  await api.voiceCallStart('c1');
  const ctx = stubs.voicePlay.ctx;
  api.voiceCallTeardown();
  assert.ok(!ctx.closed, 'voicePlay.ctx stays: replies use it');
  assert.ok(log.ka.includes('stop'), 'keep-alive stopped by the page teardown');
});

// ── echo guard ──

test('echo guard: echoHoldMs goes to the VAD; a change calls setEchoHold (the chat panel and Settings)', async () => {
  const { api, log, get } = makeEnv({ prefs: { echoHold: 1000 } });
  await api.voiceCallStart('c1');
  assert.strictEqual(log.vadOpts[0].echoHoldMs, 1000);
  api.voiceCtlSet('echo', 1500, true);
  assert.deepStrictEqual(log.vad.filter((x) => x[0] === 'echo'), [['echo', 1500]]);
  assert.strictEqual(log.saved.pop().echoHold, 1500);
  get('st-voice-echo').value = '0';
  for (const id of ['st-voice-mic', 'st-voice-readaloud', 'st-voice-fallback', 'st-voice-mode', 'st-voice-sens', 'st-voice-pause', 'st-voice-speed', 'st-voice-speakactivity']) get(id).value = '50';
  api.voiceSettingsSavePrefs();
  assert.deepStrictEqual(log.vad.filter((x) => x[0] === 'echo').pop(), ['echo', 0]);
  assert.strictEqual(log.saved.pop().echoHold, 0);
});

// ── settings ──

test('Settings and the chat panel render and save the two settings', () => {
  const { api, get, log } = makeEnv({ prefs: { echoHold: 1000, keepAlive: false } });
  const s = api.voiceSettingsHtml({});
  for (const t of ['Echo guard after replies', 'Off', '0.6 s', '1 s', '1.5 s', 'Keeps the agent from hearing its own reply in a car or through a speaker.',
    'Keep Bluetooth awake during calls', 'Plays an inaudible hiss so a car or speaker does not cut the first word.', 'Car or Bluetooth check', 'id="st-voice-echo"', 'id="st-voice-keepalive"', 'id="st-voice-car"', 'id="st-voice-car-out"']) assert.ok(s.includes(t), t);
  assert.match(s, /<option value="1000" selected>/);
  assert.match(s, /id="st-voice-keepalive"(?![^>]*checked)/);
  const h = api.voicePopHtml('c1');
  for (const t of ['Echo guard after replies', 'Keep Bluetooth awake during calls', 'Car or Bluetooth check', 'data-vp="echo"', 'data-vp="keep"', 'data-vp="car"', 'vp-car-out']) assert.ok(h.includes(t), t);
  // the panel's checkbox saves keepAlive and Settings follows
  get('st-voice-keepalive').checked = false;
  api.voiceCtlSet('keep', true, true);
  assert.strictEqual(log.saved.pop().keepAlive, true);
  assert.strictEqual(get('st-voice-keepalive').checked, true, 'Settings follows the panel');
  // Settings saves keepAlive too
  for (const id of ['st-voice-mic', 'st-voice-readaloud', 'st-voice-fallback', 'st-voice-mode', 'st-voice-sens', 'st-voice-pause', 'st-voice-speed', 'st-voice-speakactivity']) get(id).value = '50';
  get('st-voice-echo').value = '1500'; get('st-voice-keepalive').checked = false;
  api.voiceSettingsSavePrefs();
  const saved = log.saved.pop();
  assert.strictEqual(saved.echoHold, 1500); assert.strictEqual(saved.keepAlive, false);
});

// ── the microphone line and "Try the microphone again" ──

test('ui.mic: one plain-text line (label, kHz, basic mode); never HTML', async () => {
  const { api, log, get } = makeEnv();
  await api.voiceCallStart('c1');
  const ui = log.created[0].ui;
  ui.mic({ label: 'Car kit <b>x</b>', sampleRate: 16000, fallback: false });
  assert.strictEqual(get('vcb-micinfo-c1').textContent, 'Microphone: Car kit <b>x</b> · 16 kHz');
  ui.mic({ label: '', sampleRate: 44100, fallback: true });
  assert.strictEqual(get('vcb-micinfo-c1').textContent, 'Microphone: default · 44.1 kHz · basic mode');
  ui.mic({ label: 'Headset' });
  assert.strictEqual(get('vcb-micinfo-c1').textContent, 'Microphone: Headset');
  assert.ok(!/vcb-micinfo[^\n]*innerHTML|micinfo.*innerHTML/.test(wiring()), 'textContent only');
});

test('ui.micLost: shows and hides "Try the microphone again"; the line says "Microphone lost" and the meter is empty; the button calls retryMic; the call is not ended', async () => {
  const { api, log, get } = makeEnv();
  await api.voiceCallStart('c1');
  const ui = log.created[0].ui, btn = get('vcb-retry-c1'), line = get('vcb-micinfo-c1'), meter = get('vcb-level-c1');
  assert.match(log.bar.innerHTML, /id="vcb-retry-c1" data-vcb="retry" hidden>Try the microphone again</, 'drawn hidden');
  ui.mic({ label: 'Car kit', sampleRate: 16000 });
  ui.level(-20);
  assert.notStrictEqual(meter.style.width, '0%');
  ui.micLost(true);
  assert.strictEqual(btn.hidden, false);
  assert.strictEqual(line.textContent, 'Microphone lost');
  assert.strictEqual(line.classList.contains('vcb-mic-lost'), true);
  assert.strictEqual(meter.style.width, '0%', 'emptied at once');
  ui.level(-20);
  assert.strictEqual(meter.style.width, '0%', 'frames from the old stream do not fill it');
  ui.mic({ label: 'Phone mic', sampleRate: 48000 });
  assert.strictEqual(line.textContent, 'Microphone lost', 'a late mic report does not hide the lost state');
  log.bar.listeners.click({ target: { closest: () => ({ dataset: { vcb: 'retry' } }) } });
  assert.strictEqual(log.retry, 1);
  ui.micLost(false);
  assert.strictEqual(btn.hidden, true);
  assert.strictEqual(line.textContent, 'Microphone: Phone mic · 48 kHz', 'the device name is back');
  assert.strictEqual(line.classList.contains('vcb-mic-lost'), false);
  ui.level(-20);
  assert.notStrictEqual(meter.style.width, '0%', 'the meter moves again');
  assert.strictEqual(log.hung, 0);
  assert.ok(api.voiceCallS.call, 'still in the call');
});

test('ui.micLost before any microphone report: "Microphone lost", then an empty line when it is back', async () => {
  const { api, log, get } = makeEnv();
  await api.voiceCallStart('c1');
  const ui = log.created[0].ui, line = get('vcb-micinfo-c1');
  ui.micLost(true);
  assert.strictEqual(line.textContent, 'Microphone lost');
  ui.micLost(false);
  assert.strictEqual(line.textContent, '');
  assert.strictEqual(line.classList.contains('vcb-mic-lost'), false);
});

test('test hooks: window.__voiceBt reports keep-alive, mic info, mic lost and the echo guard', async () => {
  const { api, log, stubs } = makeEnv({ prefs: { echoHold: 1500 } });
  await api.voiceCallStart('c1');
  const bt = stubs.window.__voiceBt;
  assert.ok(bt);
  assert.strictEqual(bt.echoHold(), 1500);
  assert.strictEqual(bt.keepAliveRunning(), false);
  log.keepAlive.start();
  assert.strictEqual(bt.keepAliveRunning(), true);
  assert.strictEqual(bt.micLost(), false);
  log.created[0].ui.micLost(true);
  assert.strictEqual(bt.micLost(), true);
  log.created[0].ui.mic({ label: 'Car', sampleRate: 16000 });
  assert.ok(String(bt.micInfo()).includes('Car'));
});

// ── Car or Bluetooth check ──

test('car check: a NEW context made and resumed inside the tap; the library records and analyses; result saved and shown; the context is closed', async () => {
  const env = makeEnv();
  const { api, log, get, popOut, stubs } = env;
  get('st-voice-section'); get('st-voice-car-out');
  const run = api.voiceCarCheckRun();   // not awaited: the context and the recording must already exist (before any await)
  assert.strictEqual(log.ctxs.length, 1, 'one new AudioContext, made synchronously');
  assert.strictEqual(log.ctxs[0].resumed, 1, 'resumed inside the tap (iOS)');
  assert.strictEqual(log.recs.length, 1, 'voiceCarRecord started synchronously');
  const o = log.recs[0].o;
  assert.strictEqual(o.ctx, log.ctxs[0]);
  assert.strictEqual(o.nav, stubs.navigator);
  assert.strictEqual(o.chirp, log.chirp);
  assert.strictEqual(log.chirpRate, 8000, 'the chirp is made at the context rate');
  assert.strictEqual(typeof o.setTimer, 'function'); assert.strictEqual(typeof o.clearTimer, 'function');
  assert.strictEqual(o.now, Date.now);
  await run;
  assert.strictEqual(log.opens, 0, 'voiceOpenMic is not used by the check');
  assert.strictEqual(log.chirps.length, 0, 'the page does not schedule sounds itself');
  assert.strictEqual(log.analyses.length, 1);
  assert.strictEqual(log.analyses[0].mic.length, 7); assert.strictEqual(log.analyses[0].ref[0], 2);
  assert.strictEqual(log.analyses[0].chirp, log.chirp); assert.strictEqual(log.analyses[0].rate, 8000);
  assert.strictEqual(log.results[0].an.length, 3);
  assert.deepStrictEqual(log.results[0].cur, { echoHold: 600, interruptSensitivity: 50 });
  const saved = log.saved.pop();
  assert.strictEqual(saved.echoHold, 1000); assert.strictEqual(saved.interruptSensitivity, 40);
  assert.deepStrictEqual(log.vad.filter((x) => x[0] === 'echo'), [], 'no live call: no VAD to update');
  assert.strictEqual(get('st-voice-car-out').textContent, 'The echo comes back after 120 ms.');
  assert.strictEqual(get('st-voice-echo').value, '1000');
  assert.strictEqual(log.ctxs[0].closed, true, 'the check context is closed at the end');
  assert.strictEqual(api.voiceRoom.active, false);
  assert.ok(popOut.car);
});

test('car check: progress text, refusal when the microphone is busy, release on cancel and on error', async () => {
  const busy = makeEnv();
  busy.stubs.voiceRec.busy = true;
  await busy.api.voiceCarCheckRun();
  assert.deepStrictEqual(busy.log.toasts, ['The microphone is in use.']);
  assert.strictEqual(busy.log.recs.length, 0);
  assert.strictEqual((busy.log.ctxs || []).length, 0, 'no context made when refused');

  const seen = [];
  const env = makeEnv();
  const out = env.get('st-voice-car-out');
  env.get('st-voice-section');
  Object.defineProperty(out, 'textContent', { get: () => out._t, set: (v) => { out._t = v; seen.push(v); } });
  await env.api.voiceCarCheckRun();
  assert.ok(seen.includes('Playing three short test sounds. Stay quiet.'));

  // cancel: the Settings section closed -> rec.cancel(), 'cancelled' text, nothing saved, context closed
  const cancel = makeEnv({ manualRec: true });
  const sec = cancel.get('st-voice-section'); cancel.get('st-voice-car-out');
  const p = cancel.api.voiceCarCheckRun();
  await wait(5);
  sec.isConnected = false;
  await wait(250);
  await p;
  assert.strictEqual(cancel.log.recs[0].cancelled, 1, 'rec.cancel() called once');
  assert.strictEqual(cancel.get('st-voice-car-out').textContent, 'Car or Bluetooth check cancelled.');
  assert.strictEqual(cancel.log.saved.length, 0);
  assert.strictEqual(cancel.log.ctxs[0].closed, true);
  assert.strictEqual(cancel.api.voiceRoom.active, false);

  // cancel: the page is hidden
  const hid = makeEnv({ manualRec: true });
  hid.get('st-voice-section'); hid.get('st-voice-car-out');
  const ph = hid.api.voiceCarCheckRun();
  hid.stubs.document.hidden = true;
  await wait(250);
  await ph;
  assert.strictEqual(hid.log.recs[0].cancelled, 1);
  assert.strictEqual(hid.get('st-voice-car-out').textContent, 'Car or Bluetooth check cancelled.');

  // audio never started
  const na = makeEnv({ manualRec: true });
  na.get('st-voice-section'); na.get('st-voice-car-out');
  const pn = na.api.voiceCarCheckRun();
  const e1 = new Error('the audio did not start'); e1.code = 'audio_not_started';
  na.log.recs[0].reject(e1);
  await pn;
  assert.strictEqual(na.get('st-voice-car-out').textContent, 'The check could not run: the audio did not start. Settings were not changed.');
  assert.strictEqual(na.log.saved.length, 0);
  assert.strictEqual(na.log.ctxs[0].closed, true);

  // a microphone error: the page's existing microphone error text
  const err = makeEnv({ manualRec: true });
  err.get('st-voice-section'); err.get('st-voice-car-out');
  const pe = err.api.voiceCarCheckRun();
  err.log.recs[0].reject(new Error('denied'));
  await pe;
  assert.strictEqual(err.get('st-voice-car-out').textContent, 'Error: denied');   // the stub voiceMicError(e) = String(e)
  assert.ok(err.log.toasts.includes('Error: denied'));
  assert.strictEqual(err.api.voiceRoom.active, false);
  assert.strictEqual(err.log.ctxs[0].closed, true);
  assert.strictEqual(err.log.saved.length, 0);
  await flush();
});

test('car check: the old method is gone from the page (slices, playbackTime, ctx on the mic helper); voiceOpenMic is back to the base', () => {
  // (the library blocks may mention playbackTime in a comment: look at the page's own code only)
  const strip = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); return s.slice(0, i) + s.slice(j + b.length); };
  const own = strip(strip(app, '// ── voice helpers (begin) ──', '// ── voice helpers (end) ──'), '// ── voice call (begin) ──', '// ── voice call (end) ──');
  for (const name of ['voiceCarSlice', 'VOICE_CAR_SLICE', 'VOICE_CAR_WINDOW', 'playbackTime', 'VOICE_CAR_AT', 'VOICE_CAR_END']) assert.ok(!own.includes(name), name + ' is gone from the page code');
  assert.ok(/voiceCarAnalyse\(/.test(own) && /voiceCarRecord\(/.test(own));
  let base;
  try { base = execFileSync('git', ['-C', path.join(__dirname, '..'), 'show', '5e69a44:app.js'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch { return; }
  const fn = (s) => { const i = s.indexOf('async function voiceOpenMic('); return s.slice(i, s.indexOf('// Tap-to-talk.', i)); };
  assert.strictEqual(fn(app), fn(base), 'voiceOpenMic is exactly what it was at 5e69a44');
});

test('round 2: the Car or Bluetooth check passes the Mic level to the recorder; a failed Tap to talk says so', () => {
  const run = app.slice(app.indexOf('async function voiceCarCheckRun'), app.indexOf('async function voiceCarCheckRun') + 4000);
  assert.ok(/voiceCarRecord\(\{[^}]*micLevel: voiceMicLevelNow\(\)/.test(run), 'Mic level passed');
  assert.ok(/data-?\.?vcb === 'retry'[\s\S]{0,200}retryMic\(\)\)\.then\(\(ok\) => \{ if \(!ok\) hubToast\('Still no microphone\.'\)/.test(app) || app.includes("Promise.resolve(c.retryMic()).then((ok) => { if (!ok && voiceCallS.call === c) hubToast('Still no microphone.'); }"), 'failed retry toasts');
});
