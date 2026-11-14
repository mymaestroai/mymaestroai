'use strict';
// Voice round 2 on the phone page: voice controls in the chat (item 7), leaving the app (item 8), the thinking sound adapter (item 9).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const js = read('mobile.js');
const html = read('mobile.html');
const sliceBetween = (a, b) => { const i = js.indexOf(a), j = js.indexOf(b, i + a.length); assert.ok(i > 0 && j > i, a + ' .. ' + b); return js.slice(i, j); };
const LEAVE = () => sliceBetween('// ── Leaving the app (round 2, item 8) ──', 'function voiceSheet()');

// Runs the leaving-the-app code with fakes. Returns the functions, the registered listeners and the log.
function leaveEnv(over) {
  const log = [], docL = {}, winL = {};
  const o = over || {};
  const doc = { hidden: false, addEventListener: (t, f) => { docL[t] = f; } };
  const win = { addEventListener: (t, f) => { winL[t] = f; } };
  const state = { voiceCall: o.call === undefined ? null : o.call, voiceCallBgNote: false };
  const els = {};
  const env = {
    document: doc, window: win, state, navigator: o.navigator || { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126', platform: 'Linux armv81', maxTouchPoints: 5, mediaSession: { setActionHandler() {} } },
    toast: (t) => log.push('toast:' + t), $: (id) => els[id] || null, voiceCallHangUp: () => log.push('hangUp'),
    voiceCallTeardown: (vc) => { log.push('teardown'); if (state.voiceCall === vc) state.voiceCall = null; },
    voiceWakeAcquire: () => log.push('wake'), voiceRoomStop: () => log.push('roomStop'), voiceTestStop: () => log.push('testStop'),
    voiceRec: { state: 'idle' }, voiceMicStop: () => log.push('micStop'), voiceMicCancel: () => log.push('micCancel'),
    MediaMetadata: function (m) { Object.assign(this, m); }, Date: o.Date || Date,
  };
  const body = LEAVE().replace(/\bvoiceCallBgNote\b/g, 'state.voiceCallBgNote').replace(/\bvoiceCall\b(?!BgNote|Release|Stalled|HangUp|Teardown|Beat|Start)/g, 'state.voiceCall');
  const names = Object.keys(env);
  const fns = new Function(...names, body + '\nreturn { voiceIsIOS, voiceCanStayHidden, voiceMediaSession, voiceCallStalled, voiceCallBeat, voiceCallRelease, voiceEndedBar, voiceLeaveApp };')(...names.map((n) => env[n]));
  return { fns, docL, winL, doc, state, log, els, env };
}
const fakeCall = (log, withRelease) => {
  const c = { state: 'listening', hangUp: () => { log.push('call.hangUp'); return Promise.resolve([]); } };
  if (withRelease) c.release = (r) => log.push('call.release:' + r);
  return c;
};
const fakeVc = (log, withRelease = true) => ({ agent: 'bob', call: fakeCall(log, withRelease), vad: { stop: () => { log.push('vad.stop'); return Promise.resolve(); } }, lastFrame: Date.now(), lastTick: Date.now() });

// ── item 7: the controls in the chat ──
test('chat controls: a Voice settings button beside the mode chip, a visible mode chip, a panel with every control, all hidden until voice is on', () => {
  // changed on purpose (owner: the bottom of the phone screen was too busy): the button moved from the voice strip into the + sheet
  // (a menu item); the strip keeps only the mode chip
  const strip = html.indexOf('id="voice-strip"'), chip = html.indexOf('id="voice-mode-chip"'), btn = html.indexOf('id="voice-settings-btn"');
  const stripEnd = html.indexOf('</div>', strip);
  const sheet = html.indexOf('id="plus-sheet"'), sheetEnd = html.indexOf('</div>', sheet);
  assert.ok(strip > 0 && chip > strip && chip < stripEnd && !html.slice(strip, stripEnd).includes('voice-settings-btn'), 'the strip holds only the mode chip');
  assert.ok(sheet > 0 && btn > sheet && btn < sheetEnd, 'the button is a menu item in the + sheet');
  assert.match(html, /id="voice-settings-btn"[^>]*aria-label="Voice settings"[^>]*hidden/);
  assert.match(html, /id="voice-settings-btn"[^>]*aria-controls="voice-panel"/);
  assert.match(html, /id="voice-strip" hidden/);
  assert.match(html, /id="voice-mode-chip"/);
  assert.match(html, /id="voice-panel" role="dialog" aria-label="Voice settings" hidden/);
  const panel = html.slice(html.indexOf('id="voice-panel"'), html.indexOf('id="voice-level"'));
  for (const s of ['name="vp-mode"', 'Hands-free', 'Tap to talk', 'Voice speed', 'id="vp-speed"', 'Pause before I&#39;m done', 'id="vp-pause"', 'Wait for me to go on', 'id="vp-wait"',
    'Mic level', 'id="vp-level"', 'id="vp-meter"', 'Interrupt sensitivity', 'id="vp-sens"', 'Thinking sound', 'id="vp-think"', 'id="vp-think-vol"', 'Room check', 'vs-room-out']) assert.ok(panel.includes(s), s);
  assert.ok(html.indexOf('id="voice-panel"') > html.indexOf('id="composer"'), 'the panel lives in the composer, so it is anchored to it');
  assert.match(html, /#composer \{ position: relative; \}/);
  assert.match(html, /#voice-panel \{ position: absolute;[^}]*bottom: 100%/);
  assert.ok(!/menu-voice[^>]*hidden/.test(html), 'the menu entry (the old Voice sheet, a mirror) stays');
});

test('chat controls: every control writes the same per-device prefs and reaches a call that is up; not behind the menu', () => {
  const w = sliceBetween('function voicePanelWire()', '// The message box keeps a draft per agent');
  assert.match(w, /const save = \(patch\) => \{ voicePrefsSave\(patch\); voiceCallApplyPrefs\(\);/);
  for (const k of ['mode', 'voiceSpeed: voiceCleanSpeed', 'endPause', 'continueWait', 'micLevel', 'interruptSensitivity', 'thinkingSound', 'thinkingVolume']) assert.ok(w.includes(k), k);
  assert.match(w, /voiceCall\.vad\.setMicLevel\(Number\(level\.value\)\)/, 'mic level is live while dragging');
  assert.match(w, /voiceCall\.vad\.setInterruptSensitivity\(Number\(sens\.value\)\)/);
  assert.match(w, /\$\('vp-room'\)\?\.addEventListener\('click', voiceRoomRun\)/);
  assert.match(w, /key === 'Escape'/);
  assert.match(sliceBetween('function voiceCallWire()', '// Hub events for the call'), /voicePanelWire\(\)/);
  assert.match(sliceBetween('function voiceMicPaint()', 'function voiceMicCancel()'), /voiceStripPaint\(\)/);
  const apply = sliceBetween('function voiceCallApplyPrefs()', 'function voiceCallDeps(vc)');
  assert.match(apply, /vc\.vad\.setEndPause\(voiceEndPauseNow\(\)\)/);
  assert.match(apply, /typeof vc\.call\.setPrefs === 'function'\) vc\.call\.setPrefs\(\)/);
  assert.match(sliceBetween('function voiceCallPaintMeter(db)', 'function voiceCallPaintHeld'), /#vp-meter i/, 'the live meter in the panel');
});

test('chat controls: the mode chip shows the mode at all times, toggles it, and follows the mic visibility (run)', () => {
  const src = sliceBetween('const VOICE_WAIT_LABELS', 'function voicePanelPaint()');
  const els = { 'voice-strip': { hidden: true }, 'voice-settings-btn': { hidden: true }, 'voice-mode-chip': { textContent: '', classList: { toggle(c, v) { this.on = v; } }, setAttribute(k, v) { this.aria = v; } } };
  let prefs = { mode: 'tap' }, on = false, repainted = 0;
  const f = new Function('VOICE_CONTINUE_WAITS', '$', 'voicePrefsNow', 'voiceOn', 'voicePanelShow', 'voicePanelPaint', src + '\nreturn { voiceStripPaint, voiceContinueWaitNow };')([1500, 3000, 5000], (id) => els[id], () => prefs, () => on, () => {}, () => { repainted++; });
  f.voiceStripPaint();
  assert.strictEqual(els['voice-strip'].hidden, true); assert.strictEqual(els['voice-settings-btn'].hidden, true);
  on = true; f.voiceStripPaint();
  assert.strictEqual(els['voice-strip'].hidden, false); assert.strictEqual(els['voice-settings-btn'].hidden, false);
  assert.strictEqual(els['voice-mode-chip'].textContent, 'Tap to talk');
  prefs = { mode: 'handsfree' }; f.voiceStripPaint();
  assert.strictEqual(els['voice-mode-chip'].textContent, 'Hands-free');
  assert.match(els['voice-mode-chip'].aria, /Hands-free/);
  prefs = { continueWait: 5000 }; assert.strictEqual(f.voiceContinueWaitNow(), 5000);
  prefs = { continueWait: 777 }; assert.strictEqual(f.voiceContinueWaitNow(), 3000, 'default 3 s');
  prefs = {}; assert.strictEqual(f.voiceContinueWaitNow(), 3000);
});

test('Room check can run from the chat panel: its progress shows in whichever of the panel and the sheet is open', () => {
  const root = sliceBetween('function voiceRoomRoot()', 'function voiceRoomStop()');
  assert.match(root, /p && !p\.hidden \? p : \$\('voice-sheet'\)/);
  const run = sliceBetween('async function voiceRoomRun()', '// ── Voice sheet (menu, Voice) ──');
  assert.match(run, /const sh = voiceRoomRoot\(\)/);
  assert.match(run, /voiceRoom\.root = sh/);
  assert.match(run, /voicePanelPaint\(\)/);
  assert.match(sliceBetween('function voicePanelShow(show)', 'function voicePanelWire()'), /voiceRoomStop\(\)/, 'closing the panel lets go of the mic');
});

// ── item 8: leaving the app ──
test('platform detection: iPhone, iPad, iPadOS-as-Mac and Firefox/Chrome on iOS are iOS; Pixel and desktop are not', () => {
  const ua = {
    safari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1',
    ipad: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1',
    firefoxIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 FxiOS/127.0 Mobile/15E148 Safari/605.1.15',
    chromeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 CriOS/126.0 Mobile/15E148 Safari/604.1',
    pixel: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36',
  };
  const is = (nav) => leaveEnv({ navigator: nav }).fns.voiceIsIOS();
  for (const k of ['safari', 'ipad', 'firefoxIos', 'chromeIos']) assert.strictEqual(is({ userAgent: ua[k], platform: 'iPhone', maxTouchPoints: 5 }), true, k);
  assert.strictEqual(is({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605', platform: 'MacIntel', maxTouchPoints: 5 }), true, 'iPadOS in desktop mode');
  assert.strictEqual(is({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605', platform: 'MacIntel', maxTouchPoints: 0 }), false, 'a real Mac');
  assert.strictEqual(is({ userAgent: ua.pixel, platform: 'Linux armv81', maxTouchPoints: 5 }), false);
  const stay = (nav) => leaveEnv({ navigator: nav }).fns.voiceCanStayHidden();
  assert.strictEqual(stay({ userAgent: ua.pixel, platform: 'Linux', mediaSession: {} }), true, 'Android with Media Session keeps the call');
  assert.strictEqual(stay({ userAgent: ua.pixel, platform: 'Linux' }), false, 'no Media Session: released when hidden');
  assert.strictEqual(stay({ userAgent: ua.safari, platform: 'iPhone', mediaSession: {} }), false, 'iOS never');
});

test('Media Session: metadata and "playing" while the call is up, cleared when it ends', () => {
  const handlers = {};
  const ms = { setActionHandler: (a, f) => { handlers[a] = f; } };
  const e = leaveEnv({ navigator: { userAgent: 'Android', platform: 'Linux', mediaSession: ms } });
  e.fns.voiceMediaSession({ agent: 'bob' }, true);
  assert.strictEqual(ms.playbackState, 'playing');
  assert.strictEqual(ms.metadata.artist, 'bob');
  assert.strictEqual(typeof handlers.pause, 'function'); assert.strictEqual(typeof handlers.stop, 'function');
  handlers.stop(); assert.deepStrictEqual(e.log, ['hangUp'], 'stop on the notification hangs up');
  e.fns.voiceMediaSession({ agent: 'bob' }, false);
  assert.strictEqual(ms.playbackState, 'none'); assert.strictEqual(ms.metadata, null); assert.strictEqual(handlers.pause, null);
  // no Media Session at all: nothing throws
  leaveEnv({ navigator: { userAgent: 'x' } }).fns.voiceMediaSession({}, true);
});

test('release: tells the controller the reason, stops the VAD again, tears down, and remembers to say so (falls back to hangUp for an older controller)', () => {
  const e = leaveEnv();
  const vc = fakeVc(e.log); e.state.voiceCall = vc;
  e.fns.voiceCallRelease('freeze');
  assert.deepStrictEqual(e.log, ['call.release:freeze', 'vad.stop', 'teardown']);
  assert.strictEqual(e.state.voiceCall, null); assert.strictEqual(e.state.voiceCallBgNote, true);
  const o = leaveEnv(); const old = fakeVc(o.log, false); o.state.voiceCall = old;
  o.fns.voiceCallRelease('hidden');
  assert.deepStrictEqual(o.log, ['call.hangUp', 'vad.stop', 'teardown']);
  const n = leaveEnv(); n.fns.voiceCallRelease('hidden'); assert.deepStrictEqual(n.log, [], 'no call: nothing happens');
  assert.strictEqual(n.state.voiceCallBgNote, false, 'and no "call ended" note');
  // a controller that throws still lets the page go
  const t = leaveEnv(); const bad = fakeVc(t.log); bad.call.release = () => { throw new Error('boom'); }; t.state.voiceCall = bad;
  t.fns.voiceCallRelease('pagehide'); assert.deepStrictEqual(t.log, ['vad.stop', 'teardown']);
});

test('hidden: iPhone releases at once; Android with Media Session keeps the call; Android without it releases; the mic tests stop either way', () => {
  const iosNav = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15', platform: 'iPhone', maxTouchPoints: 5, mediaSession: {} };
  const a = leaveEnv({ navigator: iosNav }); a.state.voiceCall = fakeVc(a.log);
  a.doc.hidden = true; a.docL.visibilitychange();
  assert.deepStrictEqual(a.log.slice(0, 4), ['call.release:hidden', 'vad.stop', 'teardown', 'roomStop']);
  const b = leaveEnv(); b.state.voiceCall = fakeVc(b.log);   // the Pixel default
  b.doc.hidden = true; b.docL.visibilitychange();
  assert.ok(!b.log.some((l) => l.startsWith('call.')), 'Android keeps the call'); assert.ok(b.state.voiceCall); assert.ok(b.log.includes('roomStop') && b.log.includes('testStop'));
  const c = leaveEnv({ navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14)', platform: 'Linux', maxTouchPoints: 5 } }); c.state.voiceCall = fakeVc(c.log);
  c.doc.hidden = true; c.docL.visibilitychange();
  assert.strictEqual(c.log[0], 'call.release:hidden');
  const d = leaveEnv(); d.env.voiceRec.state = 'recording'; d.doc.hidden = true; d.docL.visibilitychange(); assert.ok(d.log.includes('micStop'), 'dictation is sent');
  const d2 = leaveEnv(); d2.env.voiceRec.state = 'starting'; d2.doc.hidden = true; d2.docL.visibilitychange(); assert.ok(d2.log.includes('micCancel'));
});

test('pagehide and freeze release the call on every platform (Android too), the mic tests and a recording', () => {
  for (const [type, host, reason] of [['pagehide', 'winL', 'pagehide'], ['freeze', 'docL', 'freeze']]) {
    const e = leaveEnv(); e.state.voiceCall = fakeVc(e.log);
    e[host][type]();
    assert.deepStrictEqual(e.log.slice(0, 5), ['call.release:' + reason, 'vad.stop', 'teardown', 'roomStop', 'testStop'], type);
    assert.strictEqual(e.state.voiceCall, null);
  }
  assert.match(LEAVE(), /document\.addEventListener\('freeze'/);
  assert.match(LEAVE(), /window\.addEventListener\('pagehide'/);
});

test('coming back: a "call ended" bar with Call again after a release; a stall (nothing ran for 10 s) releases; a healthy call is left alone', () => {
  // after a release the bar is shown when the page is visible again
  const e = leaveEnv();
  e.els['call-ended-bar'] = { hidden: true };
  e.state.voiceCallBgNote = true;
  e.doc.hidden = false; e.docL.visibilitychange();
  assert.strictEqual(e.els['call-ended-bar'].hidden, false); assert.strictEqual(e.state.voiceCallBgNote, false);
  assert.ok(!e.log.some((l) => l.startsWith('toast')), 'the bar, not a toast');
  e.fns.voiceEndedBar(false); assert.strictEqual(e.els['call-ended-bar'].hidden, true);
  // no bar element (a page cached from before): a toast says it
  const t = leaveEnv(); t.state.voiceCallBgNote = true; t.docL.visibilitychange();
  assert.deepStrictEqual(t.log, ['toast:The call ended when you left the app']);
  // pageshow (bfcache) shows it too
  const p = leaveEnv(); p.els['call-ended-bar'] = { hidden: true }; p.state.voiceCallBgNote = true; p.winL.pageshow(); assert.strictEqual(p.els['call-ended-bar'].hidden, false);
  // stall on return: no VAD frame and no timer tick for over 10 s
  let now = 1_000_000;
  const FakeDate = { now: () => now };
  const s = leaveEnv({ Date: FakeDate }); const vc = fakeVc(s.log); vc.lastFrame = now; vc.lastTick = now; s.state.voiceCall = vc;
  now += 9000; s.docL.visibilitychange(); assert.ok(s.state.voiceCall, '9 s: fine');
  now += 2000; s.docL.visibilitychange();
  assert.strictEqual(s.state.voiceCall, null); assert.ok(s.log.includes('call.release:stall'));
  // a frame that did run keeps it alive
  const k = leaveEnv({ Date: FakeDate }); const live = fakeVc(k.log); live.lastTick = now - 60000; live.lastFrame = now - 500; k.state.voiceCall = live;
  k.docL.visibilitychange(); assert.ok(k.state.voiceCall, 'VAD frames are running');
  // the once-a-second beat: a 10 s gap in the timer AND in the frames = a stall; a gap with fresh frames is not
  const b1 = leaveEnv({ Date: FakeDate }); const v1 = fakeVc(b1.log); v1.lastTick = now - 15000; v1.lastFrame = now - 15000; b1.state.voiceCall = v1;
  b1.doc.hidden = false; b1.fns.voiceCallBeat();
  assert.ok(b1.log.includes('call.release:stall'));
  const b2 = leaveEnv({ Date: FakeDate }); const v2 = fakeVc(b2.log); v2.lastTick = now - 15000; v2.lastFrame = now - 100; b2.state.voiceCall = v2;
  b2.fns.voiceCallBeat(); assert.ok(b2.state.voiceCall); assert.strictEqual(v2.lastTick, now);
  // wiring: the bar's button starts a new call, a new call hides the bar
  assert.match(sliceBetween('function voicePanelWire()', '// The message box keeps a draft per agent'), /\$\('call-again'\)\?\.addEventListener\('click', \(\) => \{ voiceEndedBar\(false\); voiceCallStart\(\); \}\)/);
  assert.match(html, /id="call-ended-bar"[^>]*hidden>[\s\S]*The call ended when you left the app[\s\S]*id="call-again"[^>]*>Call again</);
  assert.match(sliceBetween('function voiceCallStart()', 'function voiceCallWire()'), /voiceEndedBar\(false\)[\s\S]*voiceMediaSession\(vc, true\)[\s\S]*setInterval\(voiceCallBeat, 1000\)/);
  assert.match(sliceBetween('function voiceCallTeardown(vc)', 'function voiceCallHangUp()'), /clearInterval\(vc\.beatTimer\)[\s\S]*vc\.vad\.stop\(\)[\s\S]*voiceMediaSession\(vc, false\)[\s\S]*voiceThinkingClose\(vc\)/, 'whatever ends the call lets go of the mic, the media session and the sound');
  assert.match(sliceBetween('function voiceCallDeps(vc)', 'function voiceCallStart()'), /level: \(db\) => \{ if \(voiceCall === vc\) \{ vc\.lastFrame = Date\.now\(\)/, 'a VAD frame is the heartbeat');
});

// ── item 9: the thinking sound adapter ──
test('thinking sound adapter: deps.thinking starts a pulse on its own context, marks playback active, stops quietly, closes with the call', () => {
  const src = sliceBetween('function voiceThinkingClose(vc)', 'function voiceCallApplyPrefs()');
  const log = [];
  let prefs = { thinkingSound: true, thinkingVolume: 0.4 };
  class AC { constructor() { log.push('ctx.new'); this.state = 'running'; } close() { log.push('ctx.close'); return Promise.resolve(); } resume() { return Promise.resolve(); } }
  const state = { voiceCall: null };
  const mkSnd = ({ ctx, volume }) => { log.push('create:' + volume); return { start: () => log.push('snd.start'), stop: () => log.push('snd.stop'), setVolume: (v) => log.push('vol:' + v) }; };
  const vc = { call: { state: 'thinking' }, vad: { setPlaybackActive: (on) => log.push('playback:' + on) }, thinkSnd: null, thinkCtx: null, thinkOn: false };
  state.voiceCall = vc;
  const f = new Function('state', 'window', 'voicePrefsNow', 'voiceCreateThinkingSound', src.replace(/\bvoiceCall\b/g, 'state.voiceCall') + '\nreturn { voiceThinkingDeps, voiceThinkingClose, voiceThinkingVolume };')(state, { AudioContext: AC }, () => prefs, mkSnd);
  const th = f.voiceThinkingDeps(vc);
  th.start();
  assert.deepStrictEqual(log, ['ctx.new', 'create:0.4', 'vol:0.4', 'snd.start', 'playback:true']);
  th.stop();
  assert.deepStrictEqual(log.slice(5), ['snd.stop', 'playback:false']);
  th.stop(); assert.strictEqual(log.length, 7, 'stopping twice does nothing');
  th.start(); th.start();   // pulses again on the same context
  assert.strictEqual(log.filter((l) => l === 'ctx.new').length, 1);
  prefs = { thinkingSound: true, thinkingVolume: 0.9 }; th.start();
  assert.ok(log.includes('vol:0.9'), 'volume follows the setting');
  // the reply is already speaking when the pulse is stopped: the speaking state keeps playback active
  vc.call.state = 'speaking'; log.length = 0; th.stop();
  assert.deepStrictEqual(log, ['snd.stop']);
  // the call ends: the sound and its context are let go
  th.start(); log.length = 0; f.voiceThinkingClose(vc);
  assert.deepStrictEqual(log, ['snd.stop', 'ctx.close']); assert.strictEqual(vc.thinkCtx, null);
  // off in the settings: nothing plays
  prefs = { thinkingSound: false }; log.length = 0; th.start(); assert.deepStrictEqual(log, []);
  // volume is clamped, default 0.5
  prefs = {}; assert.strictEqual(f.voiceThinkingVolume(), 0.5);
  prefs = { thinkingVolume: 7 }; assert.strictEqual(f.voiceThinkingVolume(), 1);
});

test('thinking sound adapter: an older lib without voiceCreateThinkingSound, or a browser without Web Audio, just stays quiet', () => {
  const src = sliceBetween('function voiceThinkingClose(vc)', 'function voiceCallApplyPrefs()');
  const vc = { call: {}, vad: { setPlaybackActive() { throw new Error('must not be called'); } }, thinkSnd: null, thinkCtx: null, thinkOn: false };
  const state = { voiceCall: vc };
  const mk = (win, create) => new Function('state', 'window', 'voicePrefsNow', 'voiceCreateThinkingSound', src.replace(/\bvoiceCall\b/g, 'state.voiceCall') + '\nreturn voiceThinkingDeps;')(state, win, () => ({}), create);
  mk({ AudioContext: function () {} }, undefined)(vc).start();
  mk({}, () => ({}))(vc).start();
  assert.strictEqual(vc.thinkOn, false);
  // a sound that throws while starting never breaks the call
  const boom = mk({ AudioContext: function () { this.state = 'running'; } }, () => ({ setVolume() {}, start() { throw new Error('x'); }, stop() {} }));
  boom(vc).start();
  assert.match(sliceBetween('function voiceCallDeps(vc)', 'function voiceCallStart()'), /thinking: voiceThinkingDeps\(vc\)/, 'the controller gets deps.thinking');
  assert.match(src, /typeof voiceCreateThinkingSound !== 'function'/);
});

test('thinking sound: the AudioContext is made and resumed in the tap that starts the call (iOS), before any await, and closed in teardown', () => {
  const start = sliceBetween('function voiceCallStart()', 'function voiceCallWire()');
  assert.ok(start.indexOf('voiceThinkingCtxMake(vc)') > 0 && start.indexOf('voiceThinkingCtxMake(vc)') < start.indexOf('vc.call.start()'), 'made in the start path before call.start');
  const src = sliceBetween('function voiceThinkingClose(vc)', 'function voiceCallApplyPrefs()');
  const log = [];
  class AC { constructor() { log.push('ctx.new'); this.state = 'suspended'; } close() { log.push('ctx.close'); return Promise.resolve(); } resume() { log.push('ctx.resume'); return Promise.resolve(); } }
  const vc = { call: {}, vad: {}, thinkSnd: null, thinkCtx: null, thinkOn: false };
  const f = new Function('state', 'window', 'voicePrefsNow', 'voiceCreateThinkingSound', src.replace(/\bvoiceCall\b/g, 'state.voiceCall') + '\nreturn { voiceThinkingCtxMake, voiceThinkingClose };')({ voiceCall: vc }, { AudioContext: AC }, () => ({}), () => ({}));
  f.voiceThinkingCtxMake(vc);
  assert.deepStrictEqual(log, ['ctx.new', 'ctx.resume']); assert.ok(vc.thinkCtx);
  f.voiceThinkingCtxMake(vc); assert.strictEqual(log.length, 2, 'kept for the call, not made twice');
  f.voiceThinkingClose(vc); assert.deepStrictEqual(log.slice(2), ['ctx.close']); assert.strictEqual(vc.thinkCtx, null);
});

test('settings applied live: voiceCallApplyPrefs reaches the VAD, call.setPrefs() and the sound volume; an older controller is tolerated (run)', () => {
  const src = sliceBetween('function voiceCallApplyPrefs()', 'function voiceCallDeps(vc)');
  const log = [];
  const vc = { vad: { setMicLevel: (v) => log.push('mic:' + v), setInterruptSensitivity: (v) => log.push('sens:' + v), setEndPause: (v) => log.push('pause:' + v) }, call: { setPrefs: () => log.push('setPrefs') }, thinkSnd: { setVolume: (v) => log.push('vol:' + v) } };
  const state = { voiceCall: vc };
  const mk = () => new Function('state', 'voicePrefsNow', 'voiceEndPauseNow', 'voiceThinkingVolume', src.replace(/\bvoiceCall\b/g, 'state.voiceCall') + '\nreturn voiceCallApplyPrefs;')(state, () => ({ micLevel: 70, interruptSensitivity: 30 }), () => 2000, () => 0.25);
  mk()();
  assert.deepStrictEqual(log, ['mic:70', 'sens:30', 'pause:2000', 'setPrefs', 'vol:0.25']);
  delete vc.call.setPrefs; log.length = 0; mk()(); assert.ok(!log.includes('setPrefs'));
  state.voiceCall = null; log.length = 0; mk()(); assert.deepStrictEqual(log, []);
});

test('the old Voice sheet and menu entry remain as a mirror; sw.js is untouched by a data-less page change only if its version is a string', () => {
  assert.match(js, /\$\('menu-voice'\)\?\.addEventListener\('click', openVoiceSheet\)/);
  assert.match(read('sw.js'), /const VERSION = 'hub-mobile-v\d+';/);
  assert.ok(!/[\uFE0F\u200B\u200C\u200D]/.test(html + js.slice(js.indexOf('// ── Leaving the app (round 2'), js.indexOf('function voiceSheet()'))), 'no variation selectors or zero-width characters');
});

test('the chat panel and Voice sheet dropdowns are dark with readable text, at 16px so iOS does not zoom on tap', () => {
  const rule = (html.match(/#voice-panel select, #voice-sheet select \{[^}]*\}/) || [''])[0];   // the sheet's selects (Pause, Echo guard) were pale too
  assert.match(rule, /background: var\(--bg-input\)/);
  assert.match(rule, /color: var\(--text\)/);
  assert.match(rule, /font-size: 16px/);
});

test('thinking sound adapter: pulse(event) passes the event to the sound and returns its answer; a refusal is not marked as playing', () => {
  const src = sliceBetween('function voiceThinkingClose(vc)', 'function voiceCallApplyPrefs()');
  const log = [];
  class AC { constructor() { this.state = 'running'; } close() { return Promise.resolve(); } resume() { return Promise.resolve(); } }
  let answer = 'same';
  const mkSnd = () => ({ start() {}, stop() {}, setVolume() {}, pulse: (ev) => { log.push(ev); if (answer === 'false') return false; ev.at += 160; return ev; } });
  const state = { voiceCall: null };
  const vc = { call: { state: 'thinking' }, vad: { setPlaybackActive: (on) => log.push('playback:' + on) }, thinkSnd: null, thinkCtx: null, thinkOn: false };
  state.voiceCall = vc;
  const f = new Function('state', 'window', 'voicePrefsNow', 'voiceCreateThinkingSound', src.replace(/\bvoiceCall\b/g, 'state.voiceCall') + '\nreturn voiceThinkingDeps;')(state, { AudioContext: AC }, () => ({}), mkSnd);
  const th = f(vc), ev = { at: 100 };
  assert.strictEqual(th.pulse(ev), ev); assert.strictEqual(log[0], ev); assert.strictEqual(ev.at, 260);
  assert.deepStrictEqual(log.slice(1), ['playback:true']); assert.strictEqual(vc.thinkOn, true);
  vc.thinkOn = false; log.length = 0; answer = 'false';
  assert.strictEqual(th.pulse({ at: 1 }), false); assert.strictEqual(vc.thinkOn, false); assert.ok(!log.includes('playback:true'));
});
