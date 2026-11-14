'use strict';
// Voice fixes round 2, desktop page: in-chat voice controls (Talk mode chip + Voice settings panel), the thinking-sound adapter,
// and letting go of everything when the page is left (pagehide / freeze / a failed start). Source checks plus the page code
// run against fakes (the controller and the lib are tested in their own files).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js');
const html = read('index.html');

function between(a, b) {
  const i = app.indexOf(a), j = app.indexOf(b, i + a.length);
  assert.ok(i > 0 && j > i, 'found ' + a);
  return app.slice(i, j);
}
const helpers = () => between('    const VOICE_CONTINUE_WAITS', '    const voiceReady = ');
const wiring = () => between('    // ── Hands-free call (voice phase 2)', '    // Message rendering\n');
const flush = () => new Promise((r) => setImmediate(r));

// ── source ──

test('composer: Talk mode chip and a "Voice settings" button sit next to the mic; shown with the mic (every user)', () => {
  const c = between('id="mic-${chatId}"', 'id="notify-${chatId}"');
  assert.match(c, /class="voice-mode-chip" id="vmode-\$\{chatId\}" onclick="voiceModeToggle\(\)"[^>]*>\$\{voiceModeLabel\(\)\}</);
  assert.match(c, /id="vset-\$\{chatId\}" onclick="voicePopToggle\('\$\{chatId\}'\)" aria-label="Voice settings" aria-expanded="false"/);
  assert.match(c, /id="voice-pop-\$\{chatId\}" role="dialog" aria-label="Voice settings" hidden/);
  assert.match(app, /querySelectorAll\('\.input-area \.voice-extra'\)\) b\.style\.display = voiceReady\(\)/);
  assert.ok(!/admin/i.test(between('function voicePopHtml(', 'function voicePopClose(')), 'no admin gate: members get the panel');
});

test('panel: every control of the spec is there and writes the per-device prefs', () => {
  const h = between('function voicePopHtml(', 'function voicePopClose(');
  for (const s of ['Talk mode', 'Hands-free', 'Tap to talk', 'Voice speed', "Pause before I'm done", 'Wait for me to go on', 'Mic level', 'Interrupt sensitivity', 'Thinking sound', 'Thinking volume', 'Room check', "id('level')"]) assert.ok(h.includes(s), s);
  const keys = app.match(/const VOICE_POP_KEYS = (\{[^}]*\})/)[1];
  for (const k of ['micLevel', 'interruptSensitivity', 'voiceSpeed', 'endPause', 'continueWait', 'thinkingSound', 'thinkingVolume', 'mode']) assert.ok(keys.includes(k), k);
  assert.match(app, /VOICE_CONTINUE_WAITS = \[1500, 3000, 5000\]/);
  assert.match(app, /document\.addEventListener\('keydown', \(e\) => \{ if \(e\.key === 'Escape'\) voicePopClose\(\); \}\)/);
});

test('css: chip, button, panel and the left-the-app bar exist; no U+FE0F or zero-width characters', () => {
  for (const s of ['.voice-mode-chip', '.voice-set-btn', '.voice-pop {', '.voice-pop[hidden]', '.vp-seg', '.voice-left-bar']) assert.ok(html.includes(s), s);
  const css = html.slice(html.indexOf('/* Voice controls in the chat'), html.indexOf('.message > .msg-speak {'));
  for (const s of [helpers(), wiring(), css]) assert.ok(!/[\uFE0F\u200B\u200C\u200D\u2060\uFEFF]/.test(s));
});

test('leaving the app: visibilitychange keeps the call on a hidden tab; pagehide and freeze release; pageshow shows the note', () => {
  const w = wiring();
  assert.match(w, /window\.addEventListener\('pagehide', \(\) => \{ voiceCallRelease\('pagehide'\); \}\)/);
  assert.match(w, /document\.addEventListener\('freeze', \(\) => \{ voiceCallRelease\('freeze'\); \}\)/);
  assert.match(w, /window\.addEventListener\('pageshow', \(\) => voiceLeftNoticeShow\(\)\)/);
  const vis = between("document.addEventListener('visibilitychange', () => {   // a hidden tab keeps", "window.addEventListener('pageshow'");
  assert.ok(!/voiceCallRelease/.test(vis), 'a hidden desktop tab keeps the call');
  assert.ok(w.includes('The call ended when you left the app') && w.includes('Call again'));
});

// ── the page code run against fakes ──

function el(id, extra = {}) {
  const attrs = {}, cls = new Set();
  const e = Object.assign({
    id, style: {}, dataset: {}, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, isConnected: true,
    classList: { toggle(c, on) { if (on) cls.add(c); else cls.delete(c); }, contains: (c) => cls.has(c) },
    setAttribute(k, v) { attrs[k] = v; }, attrs, listeners: {},
    addEventListener(t, f) { e.listeners[t] = f; }, remove() { e.removed = true; e.isConnected = false; },
  }, extra);
  return e;
}

function makeEnv(opts = {}) {
  const log = { saved: [], vad: [], thinking: [], released: [], hung: 0, setPrefs: 0, vadStop: 0, toasts: [], created: [] };
  const els = {};
  const get = (id) => (els[id] || (els[id] = el(id)));
  const docL = {}, winL = {};
  const area = { parentNode: { insertBefore(bar) { log.bar = bar; els[bar.id] = bar; } } };
  get('input-c1').closest = () => area;
  let prefs = Object.assign({ micLevel: 50, interruptSensitivity: 50, mode: 'handsfree', endPause: 1200, voiceSpeed: 1 }, opts.prefs || {});
  const vad = {
    setMicLevel(v) { log.vad.push(['mic', v]); }, setInterruptSensitivity(v) { log.vad.push(['sens', v]); }, setEndPause(v) { log.vad.push(['pause', v]); },
    setPlaybackActive(on) { log.vad.push(['playing', on]); }, stop() { log.vadStop++; return Promise.resolve(); },
  };
  const call = {
    callId: 'k1', async start() { return opts.startOk !== false; }, hangUp() { log.hung++; return Promise.resolve([]); },
    setPrefs() { log.setPrefs++; },
  };
  if (opts.release !== false) call.release = (reason) => { log.released.push(reason); };
  class FakeCtx {
    constructor() { this.state = 'running'; log.ctx = this; }
    resume() {}
    close() { this.closed = true; return Promise.resolve(); }
  }
  const stubs = {
    document: { hidden: false, getElementById: get, querySelectorAll: () => [], addEventListener(t, f) { docL[t] = f; }, createElement: () => el('', {}) },
    navigator: {}, localStorage: {}, fetch: async () => ({ ok: true, status: 200, json: async () => ({ call: { callId: 'k1' } }) }),
    hubToast: (t) => log.toasts.push(t), hubEsc: (s) => String(s), chats: { c1: { agent: 'alice', status: 'idle' } }, agentStatus: {},
    voicePrefsNow: () => prefs, voiceMicLevelNow: () => prefs.micLevel, voiceSensNow: () => prefs.interruptSensitivity,
    voiceEndPauseNow: () => prefs.endPause, voiceSpeedNow: () => prefs.voiceSpeed || 1, voiceSpeedLabel: (v) => Number(v).toFixed(2) + 'x',
    voiceCleanSpeed: (v) => Math.round(Math.max(0.75, Math.min(1.5, Number(v))) * 20) / 20,
    voicePauseSelectHtml: (id, attrs) => `<select id="${id}" ${attrs}></select>`, VOICE_SPEED_HINT: '', VOICE_END_PAUSES: [800, 1200, 2000],
    voiceContinueWaitNow: () => ([1500, 3000, 5000].includes(prefs.continueWait) ? prefs.continueWait : 3000),
    voiceThinkingVolNow: () => (typeof prefs.thinkingVolume === 'number' ? prefs.thinkingVolume : 0.5),
    voiceThinkingOnNow: () => prefs.thinkingSound !== false, voiceModeLabel: () => (prefs.mode === 'tap' ? 'Tap to talk' : 'Hands-free'),
    VOICE_CONTINUE_WAITS: [1500, 3000, 5000],
    voiceSavePrefs: (s, p) => { prefs = { ...p }; log.saved.push({ ...p }); return { ...p }; },
    voiceById: get, voiceReady: () => true,
    voiceRec: { guard: { cancel() {}, pending: false }, chatId: null, busy: false }, voiceTest: { mic: null, guard: { pending: false } },
    voiceMicStop() {}, voiceStopPlayback() { log.stopPlayback = (log.stopPlayback || 0) + 1; }, voicePlay: { token: 0, source: null },
    VOICE_MIC_SVG: '<svg>mic</svg>', voiceSentences: (t) => [t], voiceSpeechText: (t) => t, voiceSpeakText: async () => {}, voiceEncodeWav: () => new ArrayBuffer(1),
    VOICE_LOUDNESS: { normal: 0, louder: 9, loudest: 14 }, voiceLoudnessNow: () => 'louder', voiceLoudnessFor: (p, kind) => (kind === 'bluetooth' ? 'normal' : 'louder'), voiceLoudnessSelectHtml: (id, attrs) => `<select id="${id}" ${attrs}></select>`, voiceLoudApply() {}, VOICE_ECHO_HOLDS: [0, 600, 1000, 1500], voiceBusyToast: () => false, voiceRefreshStatus() {}, voiceMeterPercent: (db) => Math.round(Math.max(0, Math.min(100, (db + 60) / 0.6))),
    voiceCreateVad: () => vad, voiceCreateCall: (deps) => { log.created.push(deps); return call; },
    voiceRoomCheck() {}, voiceCallMedian: () => null, voiceOpenMic: async () => ({ close() {} }), voiceLevelDb: () => -100, voiceMicError: (e) => String(e),
    appendMessage() {}, appendSystemNotice() {}, stopAgentTurn() {}, sendSoloMessage: async () => {}, closeQuestion() {}, hubOriginLabel: () => '',
    setTimeout, clearTimeout, Date,
    window: { AudioContext: FakeCtx, addEventListener(t, f) { winL[t] = f; } },
  };
  if (opts.lib !== false) {
    stubs.voiceCreateThinkingSound = ({ ctx, volume }) => {
      const s = { ctx, volume, on: false, pulse(ev) { log.pulsed = (log.pulsed || []); log.pulsed.push(ev); if (ev && s.mode === 'move') ev.at += 160; return s.mode === 'refuse' ? false : s.mode === 'move' ? ev : undefined; }, start() { s.on = true; log.thinking.push('start'); }, stop() { s.on = false; log.thinking.push('stop'); }, setVolume(v) { s.volume = v; } };
      log.sound = s;
      return s;
    };
  } else stubs.voiceCreateThinkingSound = undefined;
  const names = Object.keys(stubs);
  const src = wiring() + '\nreturn { voiceCallS, voiceCallStart, voiceCallRelease, voiceCallHangUp, voiceCallThinking, voiceCtlSet, voicePopHtml, voiceLeftNoticeShow };';
  const api = new Function(...names, src)(...names.map((n) => stubs[n]));
  return { api, log, els, get, docL, winL, stubs, vad, call, setHidden: (h) => { stubs.document.hidden = h; }, getPrefs: () => prefs };
}

test('panel html: values of the moment, every label, no admin parts', () => {
  const { api } = makeEnv({ prefs: { continueWait: 5000, thinkingSound: false, thinkingVolume: 0.25, mode: 'tap' } });
  const h = api.voicePopHtml('c1');
  assert.match(h, /data-val="tap" aria-pressed="true"/);
  assert.match(h, /<option value="5000" selected>5 s<\/option>/);
  assert.match(h, /id="vp-think-c1" data-vp="think"><\/label>/, 'thinking sound off is unchecked');
  assert.match(h, /id="vp-thinkvol-c1"[^>]*value="0.25"/);
  for (const t of ['1.5 s', '3 s', 'vp-level-c1', 'data-vp="room"']) assert.ok(h.includes(t), t);
});

test('voiceCtlSet: live on the VAD and the call, saved on release, the keys are the contract prefs', async () => {
  const { api, log, getPrefs } = makeEnv();
  await api.voiceCallStart('c1');
  api.voiceCtlSet('mic', 70, false);
  assert.deepStrictEqual(log.vad.filter((x) => x[0] === 'mic'), [['mic', 70]]);
  assert.strictEqual(log.saved.length, 0, 'not saved while dragging');
  api.voiceCtlSet('mic', 70, true);
  assert.strictEqual(getPrefs().micLevel, 70);
  api.voiceCtlSet('sens', 30, true); api.voiceCtlSet('pause', 2000, true);
  assert.deepStrictEqual(log.vad.filter((x) => x[0] === 'sens' || x[0] === 'pause'), [['sens', 30], ['pause', 2000]]);
  api.voiceCtlSet('wait', 5000, true); api.voiceCtlSet('think', false, true); api.voiceCtlSet('thinkvol', 0.2, true); api.voiceCtlSet('speed', 1.25, true); api.voiceCtlSet('mode', 'tap', true);
  const p = getPrefs();
  assert.deepStrictEqual([p.continueWait, p.thinkingSound, p.thinkingVolume, p.voiceSpeed, p.mode], [5000, false, 0.2, 1.25, 'tap']);
  assert.ok(log.setPrefs >= 8, 'call.setPrefs() after each change');
});

test('voiceCtlSet with no call running: saves, nothing to tell', () => {
  const { api, getPrefs } = makeEnv();
  api.voiceCtlSet('wait', 1500, true); api.voiceCtlSet('mode', 'tap', true);
  assert.strictEqual(getPrefs().continueWait, 1500);
  assert.strictEqual(getPrefs().mode, 'tap');
});

test('thinking adapter: start pulses and tells the VAD playback is active; stop lets go; volume is live', () => {
  const { api, log, vad } = makeEnv({ prefs: { thinkingVolume: 0.4 } });
  const t = api.voiceCallThinking(vad);
  t.start(); t.start();
  assert.strictEqual(log.sound.volume, 0.4);
  assert.strictEqual(log.sound.on, true);
  assert.deepStrictEqual(log.vad.filter((x) => x[0] === 'playing'), [['playing', true]], 'once, however many starts');
  t.setVolume(0.9); assert.strictEqual(log.sound.volume, 0.9);
  t.stop(); t.stop();
  assert.strictEqual(log.sound.on, false);
  assert.deepStrictEqual(log.vad.filter((x) => x[0] === 'playing'), [['playing', true], ['playing', false]]);
  t.close(); assert.ok(!log.ctx.closed, 'the shared output context (voicePlay.ctx) stays open: replies use it');
});

test('thinking sound: its AudioContext is made (and resumed) in the start path, before any await, and left open in teardown (it is the shared reply output context)', async () => {
  const { api, log, els } = makeEnv();
  assert.ok(!log.ctx);
  const p = api.voiceCallStart('c1');   // no await yet: the tap's synchronous part
  assert.ok(log.ctx, 'created synchronously in voiceCallStart');
  await p;
  const made = log.ctx;
  api.voiceCallS.thinking.start();
  assert.strictEqual(log.ctx, made, 'the same context is used, not a second one');
  await api.voiceCallHangUp();
  assert.ok(!made.closed, 'the shared reply output context (voicePlay.ctx) is not closed with the call');
  assert.ok(log.thinking.includes('stop'), 'the thinking sound is stopped in teardown');
});

test('thinking adapter: reply audio already playing keeps the playback flag', () => {
  const { api, log, vad, stubs } = makeEnv();
  const t = api.voiceCallThinking(vad);
  t.start(); stubs.voicePlay.source = {};
  t.stop();
  assert.deepStrictEqual(log.vad.filter((x) => x[0] === 'playing'), [['playing', true]]);
});

test('with an older lib (no voiceCreateThinkingSound) there is no adapter and no deps.thinking', async () => {
  const { api, log } = makeEnv({ lib: false });
  assert.strictEqual(api.voiceCallThinking({}), null);
  await api.voiceCallStart('c1');
  assert.ok(!('thinking' in log.created[0]));
});

test('start passes deps.thinking {start, stop} to the controller', async () => {
  const { api, log } = makeEnv();
  await api.voiceCallStart('c1');
  assert.strictEqual(typeof log.created[0].thinking.start, 'function');
  assert.strictEqual(typeof log.created[0].thinking.stop, 'function');
});

test('release (pagehide): call.release(reason) at once, the VAD and the thinking sound are stopped, nothing left up', async () => {
  const { api, log } = makeEnv();
  await api.voiceCallStart('c1');
  log.created[0].thinking.start();
  api.voiceCallRelease('pagehide');
  assert.deepStrictEqual(log.released, ['pagehide']);
  assert.strictEqual(log.hung, 0, 'not the slow hang-up');
  assert.strictEqual(log.vadStop, 1, 'the page itself stops the VAD (raw + processed tracks, context)');
  assert.ok(!log.ctx.closed, 'the shared reply output context stays open');
  assert.ok(log.thinking.includes('stop'), 'the thinking sound is stopped');
  assert.strictEqual(api.voiceCallS.call, null);
  assert.strictEqual(api.voiceCallS.vad, null);
  assert.ok(log.stopPlayback >= 1, 'playing audio is cut');
});

test('release without call.release (older controller) falls back to hangUp and still lets go', async () => {
  const { api, log } = makeEnv({ release: false });
  await api.voiceCallStart('c1');
  api.voiceCallRelease('freeze');
  assert.strictEqual(log.hung, 1);
  assert.strictEqual(log.vadStop, 1);
});

test('pagehide and freeze listeners release; a hidden desktop tab does not', async () => {
  const { api, log, docL, winL, setHidden } = makeEnv();
  assert.ok(winL.pagehide && winL.pageshow && !docL.pagehide && !docL.pageshow, 'pagehide and pageshow are on the window, where they fire');
  await api.voiceCallStart('c1');
  setHidden(true); docL.visibilitychange();
  assert.deepStrictEqual(log.released, [], 'hidden: the call goes on');
  docL.freeze();
  assert.deepStrictEqual(log.released, ['freeze']);
  await api.voiceCallStart('c1');
  winL.pagehide();
  assert.deepStrictEqual(log.released, ['freeze', 'pagehide']);
});

test('hang-up, a start failure and hang-up during start all stop the VAD', async () => {
  let e = makeEnv();
  await e.api.voiceCallStart('c1'); await e.api.voiceCallHangUp();
  assert.strictEqual(e.log.vadStop, 1, 'hang-up');
  e = makeEnv({ startOk: false });
  await e.api.voiceCallStart('c1');
  assert.strictEqual(e.log.vadStop, 1, 'start failure');
  e = makeEnv();
  const p = e.api.voiceCallStart('c1');
  await e.api.voiceCallHangUp();   // while it is starting
  await p;
  assert.strictEqual(e.log.vadStop, 1, 'hang-up during start');
});

test('after a release the person gets "The call ended when you left the app" with Call again, once the page is visible', async () => {
  const { api, log, els, docL, setHidden } = makeEnv();
  await api.voiceCallStart('c1');
  setHidden(true);
  api.voiceCallRelease('pagehide');
  assert.ok(!els['voice-left-bar'] || !els['voice-left-bar'].innerHTML, 'not shown while hidden');
  setHidden(false); docL.visibilitychange();
  const bar = els['voice-left-bar'];
  assert.ok(bar && /The call ended when you left the app/.test(bar.innerHTML) && /Call again/.test(bar.innerHTML));
  bar.listeners.click({ target: { closest: () => ({ dataset: { vleft: 'again' } }) } });
  await flush();
  assert.ok(bar.removed, 'the bar goes away');
  assert.ok(api.voiceCallS.call, 'Call again starts a new call');
});

test('thinking adapter: pulse(event) hands the event to the sound and returns what it answers; a refusing sound is not claimed as playback', () => {
  const { api, log, vad } = makeEnv({ prefs: { thinkingVolume: 0.4 } });
  const t = api.voiceCallThinking(vad);
  const ev = { at: 1000, attackMs: 250, decayMs: 1000, strength: 1 };
  assert.strictEqual(t.pulse(ev), undefined); assert.strictEqual(log.pulsed[0], ev, 'the very same event');
  assert.deepStrictEqual(log.vad.filter((x) => x[0] === 'playing'), [['playing', true]]);
  log.sound.mode = 'move'; const e2 = { at: 1000 };
  assert.strictEqual(t.pulse(e2), e2); assert.strictEqual(e2.at, 1160, 'moved by the sound, same object back');
  log.vad.length = 0; log.sound.mode = 'refuse';
  assert.strictEqual(t.pulse({ at: 5 }), false);
  assert.deepStrictEqual(log.vad.filter((x) => x[0] === 'playing'), [], 'a refused pulse is not playback');
});
