'use strict';
// Tap to talk on the pages (spec 2): the three Talk modes (Hands-free, Tap to talk = 'press', Dictation = 'tap'), the pickers, a press call
// started from the mic, the press button (voicePressButton in the voice helpers, used by both pages and the call display's Talk slot) and
// the texts. Source checks, plus the page code run against fakes (the desktop wiring block with the harness of ui-voice-call-desktop.test.js,
// the phone functions cut out of mobile.js, the real call display on a fake DOM). The controller itself is tested in test/ui-voice-press.test.js.
// Fakes cannot prove how it feels under a finger or looks in a browser.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const LIB = require('../lib/ui-voice');
Object.assign(globalThis, LIB);
const CD = require('../lib/ui-call-display');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js'), mob = read('mobile.js'), mhtml = read('mobile.html');
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const between = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, 'found ' + a + ' .. ' + b); return src.slice(i, j); };

// ── the three copies of the voice helpers: the library, app.js (indented 4 spaces) and mobile.js ──
const BEGIN = '// ── voice helpers (begin) ──', END = '// ── voice helpers (end) ──';
const block = (src, indent) => { const a = src.indexOf(BEGIN), b = src.indexOf(END); assert.ok(a > 0 && b > a); return src.slice(a + BEGIN.length, b).split('\n').map(l => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n'); };
const copies = {
  lib: LIB,
  'app.js': new Function(block(app, '    ') + '\nreturn { voiceCleanPrefs, voicePressButton, VOICE_PRESS_HOLD_MS };')(),
  'mobile.js': new Function(block(mob, '') + '\nreturn { voiceCleanPrefs, voicePressButton, VOICE_PRESS_HOLD_MS };')(),
};

// ── 1. the three modes in the prefs ──
test('voiceCleanPrefs keeps handsfree, press and tap (Dictation) on the library and both pages; anything else is hands-free', () => {
  for (const [name, C] of Object.entries(copies)) {
    for (const m of ['handsfree', 'press', 'tap']) assert.strictEqual(C.voiceCleanPrefs({ mode: m }).mode, m, name + ' keeps ' + m);
    for (const bad of ['Press', 'dictation', '', null, 7, undefined]) assert.strictEqual(C.voiceCleanPrefs({ mode: bad }).mode, 'handsfree', name + ' ' + String(bad));
  }
  assert.strictEqual(LIB.VOICE_DEFAULT_PREFS.mode, 'handsfree', 'the default stays hands-free');
});

// ── 2. the mic: Dictation stays dictation, Tap to talk starts a call ──
function desktopMic(mode, over) {
  const src = between(app, 'async function voiceMicToggle(', 'async function voiceMicStop(');
  const log = [];
  const env = {
    voicePressEndedAt: 0, voiceMicHeldMs: () => 0, VOICE_PRESS_HOLD_MS: 400,   // the idle mic's pointer record, and when a Tap to talk call last ended (round 1, items 4 and 6)
    voiceCallS: { active: false, starting: false }, voiceCallHangUp: () => log.push('hangup'),
    voiceRec: { busy: false, chatId: null, guard: { pending: false, begin: () => 1, fail() {}, settle: () => true, gen: 1 }, chunks: [], samples: 0, level: -100 }, voiceMicStop: async () => {},
    voiceReady: () => true, voiceHintDismiss() {}, hubToast: () => {}, voiceRefreshStatus() {}, simpleOn: () => false, voicePrefsNow: () => ({ mode }), voiceCallStart: (id) => log.push('call:' + id),
    voiceTest: { mic: null, guard: { pending: false } }, voiceStopPlayback() {}, voiceOpenMic: async () => { log.push('openMic'); return { close() {} }; }, voiceMicLevelNow: () => 50,
    voiceLevelDb: () => -50, voiceMicError: () => 'x', voiceMicTick() {}, setInterval: () => 0, Date,
  };
  Object.assign(env, over || {});
  const names = Object.keys(env);
  return { log, env, run: new Function(...names, src + '\nreturn voiceMicToggle;')(...names.map(n => env[n])) };
}
function phoneMic(mode, voiceCall, over) {
  const src = between(mob, 'async function voiceMicTap()', 'async function voiceMicStop()');
  const log = [];
  const env = {
    voicePressEndedAt: 0, voiceMicHeldMs: () => 0, VOICE_PRESS_HOLD_MS: 400,
    keepKeyboard: null, voiceCall: voiceCall || null, voiceCallHangUp: () => log.push('hangup'),
    voiceRec: { state: 'idle', guard: { pending: false, begin: () => 1, fail() {}, settle: () => true, gen: 1 }, chunks: [], tick: null, t0: 0, handle: null }, voiceTest: { guard: { pending: false }, handle: null }, voiceTestStop() {}, voiceMicStop() {},
    current: 'bob', toast() {}, voicePrefsNow: () => ({ mode, micLevel: 50 }), voiceCallStart: () => log.push('call'), voiceStopPlayback() {}, voiceUnlockAudio() {}, voiceMicPaint() {},
    voiceMicOpen: async () => { log.push('openMic'); return { close() {} }; }, voiceBarPaint() {}, voiceMeterPaint: () => 0, voiceErr: () => 'x', setInterval: () => 0, VOICE_MAX_SECONDS: 60, Date,
  };
  Object.assign(env, over || {});
  const names = Object.keys(env);
  return { log, run: new Function(...names, src + '\nreturn voiceMicTap;')(...names.map(n => env[n])) };
}
test('mic, both pages: a saved Dictation (tap) still records, Tap to talk and Hands-free start a call; the new mode is kept by the prefs', async () => {
  assert.strictEqual(LIB.voiceCleanPrefs({ mode: 'press' }).mode, 'press', 'a saved Tap to talk is kept (it used to fall back to hands-free)');
  for (const [name, make, call] of [['desktop', desktopMic, (m) => m.run('c1')], ['phone', phoneMic, (m) => m.run()]]) {
    let m = make('tap'); await call(m);
    assert.ok(m.log.includes('openMic') && !m.log.some(x => x.startsWith('call')), name + ': Dictation opens the recorder, no call');
    for (const mode of ['press', 'handsfree']) { m = make(mode); await call(m); assert.ok(m.log.some(x => x.startsWith('call')) && !m.log.includes('openMic'), name + ': ' + mode + ' starts a call'); }
  }
  // during a Tap to talk call the mic button is the press button, not Hang up; during a hands-free call it still hangs up
  let m = desktopMic('press'); m.env.voiceCallS.active = true; m.env.voiceCallS.press = true; await m.run('c1');
  assert.deepStrictEqual(m.log, [], 'desktop: a tap on the mic in a press call is left to the press button');
  m = desktopMic('handsfree'); m.env.voiceCallS.active = true; await m.run('c1'); assert.deepStrictEqual(m.log, ['hangup']);
  m = phoneMic('press', { press: true }); await m.run(); assert.deepStrictEqual(m.log, [], 'phone: the same');
  m = phoneMic('handsfree', { press: false }); await m.run(); assert.deepStrictEqual(m.log, ['hangup']);
});

// ── 3. the press button ──
function fakeButton() {
  const attrs = {}, cls = new Set(), l = {};
  const e = { attrs, cls, listeners: l, textContent: '', captured: [], isConnected: true, setAttribute(k, v) { attrs[k] = String(v); }, removeAttribute(k) { delete attrs[k]; }, classList: { toggle(c, on) { if (on) cls.add(c); else cls.delete(c); }, contains: (c) => cls.has(c) },
    addEventListener(t, f) { (l[t] = l[t] || []).push(f); }, removeEventListener(t, f) { l[t] = (l[t] || []).filter(x => x !== f); }, setPointerCapture(id) { e.captured.push(id); } };
  e.fire = (t, ev) => { const x = Object.assign({ prevented: false, preventDefault() { this.prevented = true; }, pointerId: 1, pointerType: 'touch', button: 0 }, ev); for (const f of (l[t] || []).slice()) f(x); return x; };
  return e;
}
function pressRig(C, takesTalk = true) {
  const calls = [], clock = { t: 10000 }, el = fakeButton();
  // like the controller: pressing is the REQUESTED state (set by talk), not what btn.paint shows. takesTalk = false: a call that records talk() but never takes the press (not started yet), so pressing stays false.
  const call = { pressing: false, talk(on) { calls.push(on); if (takesTalk) this.pressing = !!on; } };
  const btn = C.voicePressButton(el, () => call, { now: () => clock.t });
  clock.t += 5000;   // the button is a few seconds old: the click of the tap that made it is long gone
  return { calls, clock, el, btn };
}
for (const name of ['lib', 'app.js', 'mobile.js']) {
  const C = copies[name];
  test(`voicePressButton (${name}): a tap starts listening and the second tap sends; the press is never cut by a short release`, () => {
    const r = pressRig(C);
    const d = r.el.fire('pointerdown'); assert.deepStrictEqual(r.calls, [true], 'pointerdown: call.talk(true)');
    assert.ok(d.prevented, 'preventDefault on pointerdown: no focus change, no text selection, no keyboard');
    assert.deepStrictEqual(r.el.captured, [1], 'the pointer is captured so its release arrives');
    r.btn.paint(true);   // what the call's ui.press(true) does
    r.clock.t += 120; r.el.fire('pointerup');
    assert.deepStrictEqual(r.calls, [true], 'a short tap keeps listening');
    r.clock.t += 3000;
    r.el.fire('pointerdown'); assert.deepStrictEqual(r.calls, [true], 'the second tap sends on its release, not on its press');
    r.clock.t += 80; r.el.fire('pointerup'); assert.deepStrictEqual(r.calls, [true, false], 'second tap: call.talk(false)');
  });
  test(`voicePressButton (${name}): hold to talk, let go to send (400 ms and more); 399 ms does not send`, () => {
    let r = pressRig(C);
    r.el.fire('pointerdown'); r.btn.paint(true); r.clock.t += C.VOICE_PRESS_HOLD_MS; r.el.fire('pointerup');
    assert.deepStrictEqual(r.calls, [true, false], 'held 400 ms: released = sent');
    assert.strictEqual(C.VOICE_PRESS_HOLD_MS, 400);
    r = pressRig(C);
    r.el.fire('pointerdown'); r.btn.paint(true); r.clock.t += 399; r.el.fire('pointerup');
    assert.deepStrictEqual(r.calls, [true], 'held 399 ms: still listening');
    r = pressRig(C);
    r.el.fire('pointerdown'); r.btn.paint(true); r.clock.t += 900; r.el.fire('pointercancel');
    assert.deepStrictEqual(r.calls, [true, false], 'a cancelled pointer after a long hold lets go too');
    r = pressRig(C);
    r.el.fire('pointerup'); r.el.fire('pointercancel');
    assert.deepStrictEqual(r.calls, [], 'a release with no press that began here does nothing');
    r = pressRig(C);
    r.el.fire('pointerdown', { pointerType: 'mouse', button: 2 }); assert.deepStrictEqual(r.calls, [], 'a right click is not a press');
  });
  test(`voicePressButton (${name}): the click that follows a pointer sequence is swallowed; Enter and Space toggle once, no auto-repeat`, () => {
    const r = pressRig(C);
    r.el.fire('pointerdown'); r.btn.paint(true); r.clock.t += 600; r.el.fire('pointerup');
    const c = r.el.fire('click');
    assert.deepStrictEqual(r.calls, [true, false], 'the click did nothing more');
    assert.ok(c.prevented);
    // keyboard
    const k = pressRig(C);
    const e1 = k.el.fire('keydown', { key: 'Enter' }); assert.deepStrictEqual(k.calls, [true], 'Enter starts listening'); assert.ok(e1.prevented);
    k.btn.paint(true);
    k.el.fire('keydown', { key: 'Enter', repeat: true }); k.el.fire('keydown', { key: 'Enter' }); assert.deepStrictEqual(k.calls, [true], 'held key: no auto-repeat');
    k.el.fire('keyup', { key: 'Enter' }); k.el.fire('click');   // the click some browsers still send after the key
    assert.deepStrictEqual(k.calls, [true], 'that click is swallowed too');
    k.clock.t += 2000;
    k.el.fire('keydown', { key: ' ' }); assert.deepStrictEqual(k.calls, [true, false], 'Space sends');
    k.el.fire('keyup', { key: ' ' });
    k.el.fire('keydown', { key: 'a' }); assert.deepStrictEqual(k.calls, [true, false], 'other keys do nothing');
  });
  test(`voicePressButton (${name}): aria-pressed, the title and the visible text follow ui.press while the aria-label stays "Talk"; the pressed style is toggled; detach lets go`, () => {
    const r = pressRig(C);
    assert.strictEqual(r.el.attrs['aria-label'], 'Talk', 'the name is set when the button becomes a press button');
    r.btn.paint(false);
    assert.strictEqual(r.el.attrs['aria-pressed'], 'false'); assert.strictEqual(r.el.attrs['aria-label'], 'Talk'); assert.strictEqual(r.el.attrs.title, 'Tap to talk'); assert.ok(!r.el.cls.has('rec'));
    r.btn.paint(true);
    assert.strictEqual(r.el.attrs['aria-pressed'], 'true'); assert.strictEqual(r.el.attrs['aria-label'], 'Talk', 'constant: a screen reader hears the same name, and aria-pressed'); assert.strictEqual(r.el.attrs.title, 'Tap to send'); assert.ok(r.el.cls.has('rec'), 'a visible pressed style (the existing red .rec)');
    const t = fakeButton(), tb = C.voicePressButton(t, () => ({ talk() {} }), { text: true });
    tb.paint(false); assert.strictEqual(t.textContent, 'Tap to talk'); tb.paint(true); assert.strictEqual(t.textContent, 'Tap to send'); assert.strictEqual(t.attrs['aria-label'], 'Talk');
    assert.strictEqual(r.btn.pressing, true);
    r.btn.detach();
    r.el.fire('pointerdown'); assert.deepStrictEqual(r.calls, [], 'no listener is left after detach');
  });
}

// Pointer ownership: a second finger's release, cancel, lost capture or click cannot end the first finger's hold or leave the mic listening after its release.
for (const name of ['lib', 'app.js', 'mobile.js']) {
  test(`only the owning pointer can end a hold (${name})`, () => {
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      const r = pressRig(copies[name]);
      r.clock.t += 1000; // past the button's initial click suppression
      r.el.fire('pointerdown', { pointerId: 1 });
      r.btn.paint(true);
      r.clock.t += 100;
      r.el.fire('pointerdown', { pointerId: 2 });
      r.clock.t += 50;
      r.el.fire(event, { pointerId: 2 });
      r.el.fire('click', { pointerId: 2 });
      assert.deepEqual(r.calls, [true], event);
      r.clock.t += 450;
      r.el.fire('pointerup', { pointerId: 1 });
      r.btn.paint(false);
      r.el.fire('click', { pointerId: 1 });
      assert.deepEqual(r.calls, [true, false], event);
    }
  });
}

// ── 4. a press call from the desktop mic: the harness of ui-voice-call-desktop.test.js, with a few extra stubs ──
const dsrc = read('test/ui-voice-call-desktop.test.js');
const dHead = dsrc.slice(0, dsrc.indexOf("test('mic button:"));
let dEnv = dsrc.slice(dsrc.indexOf('function el(extra = {})'), dsrc.indexOf("test('start: deps contract"));
assert.ok(dEnv.includes('const names = Object.keys(stubs);') && dEnv.includes('return { api, calls'), 'the desktop harness is where this test expects it');
dEnv = dEnv.replace('const names = Object.keys(stubs);', 'Object.assign(stubs, opts.extra || {});\n  const names = Object.keys(stubs);').replace('const src = wiring() + \'\\nreturn { voiceCallS,', 'const src = wiring() + \'\\nreturn { voiceModeToggle, voiceCtlSet, voiceDisp, voiceCallS,');
assert.ok(dEnv.includes('voiceModeToggle, voiceCtlSet, voiceDisp, voiceCallS'), 'the desktop harness returns voiceModeToggle, voiceCtlSet and voiceDisp');
const dMake = new Function('require', '__dirname', dHead + dEnv + '\nreturn makeEnv;')(require, __dirname);
function desktopCall(mode, more) {   // more: further stubs for the page (round 3: the real adapter as voiceCreateVad)
  const shown = { displays: [] };
  const CallDisplay = {
    ...CD, loadDisplayPrefs: () => ({ choice: 'follow', captions: false, interrupt: false }), saveDisplayPrefs() {}, fillDisplaySelect() {},
    createCallDisplay: (o) => { const d = { opts: o, press: [], start() {}, setPress(on) { d.press.push(on); }, setState() {}, hangUp() {}, release() {}, setMuted() {} }; shown.displays.push(d); return d; },
    createTalkFloor: () => ({ wrap: (h) => h, cancel() {}, take() {} }),
  };
  const e = dMake({ extra: { voicePressButton: LIB.voicePressButton, CallDisplay, ...(more || {}) } });
  e.stubs.voiceSavePrefs(null, { micLevel: 60, interruptSensitivity: 40, mode });
  const talks = []; e.fakeCall.talk = (on) => { talks.push(on); return on; };
  const m = e.get('mic-c1'); m.listeners = {}; m.addEventListener = (t, f) => { m.listeners[t] = f; }; m.removeEventListener = (t) => { delete m.listeners[t]; };
  return { ...e, talks, shown };
}
test('desktop: Tap to talk starts a call with press: true and manual: true and calls talk(true) once after start; the mic button is the press button', async () => {
  const e = desktopCall('press');
  await e.api.voiceCallStart('c1');
  await tick();
  assert.strictEqual(e.fakeCall.started, 1);
  assert.strictEqual(e.calls.vadOpts.manual, true, 'voiceCreateVad({ manual: true })');
  assert.strictEqual(e.calls.created[0].press, true, 'the call deps carry press: true');
  assert.deepStrictEqual(e.talks, [true], 'call.talk(true) once: the first tap starts the call and starts listening');
  assert.strictEqual(e.api.voiceCallS.press, true);
  const m = e.get('mic-c1');
  assert.ok(!m.classList.contains('call'), 'not the red Hang up');
  assert.strictEqual(m.attrs['aria-label'], 'Talk', 'the press button\'s name is constant');
  assert.ok(m.listeners.pointerdown, 'the press button is wired to the mic');
  // ui.press paints the button, the state line and the display
  const ui = e.calls.created[0].ui;
  ui.state('listening');
  assert.strictEqual(e.get('vcb-state-c1').textContent, 'Tap to talk', 'listening and not pressing');
  ui.press(true);
  assert.strictEqual(m.attrs['aria-pressed'], 'true'); assert.strictEqual(m.attrs['aria-label'], 'Talk'); assert.strictEqual(m.attrs.title, 'Tap to send'); assert.ok(m.classList.contains('listening') && !m.classList.contains('rec'), 'the green listening look, never the red recording one');
  assert.strictEqual(e.get('vcb-state-c1').textContent, 'Listening');
  ui.state('thinking'); assert.strictEqual(e.get('vcb-state-c1').textContent, 'Thinking', 'other states as in a hands-free call');
  ui.press(false);
  assert.strictEqual(m.attrs['aria-pressed'], 'false'); assert.strictEqual(m.attrs['aria-label'], 'Talk'); assert.strictEqual(m.attrs.title, 'Tap to talk');
  assert.deepStrictEqual(e.shown.displays[0].press, [true, false], 'the display follows ui.press');
  // a press on the mic button reaches the call
  m.listeners.pointerdown({ preventDefault() {}, pointerId: 1, pointerType: 'mouse', button: 0 });
  assert.deepStrictEqual(e.talks, [true, true], 'pointerdown: talk(true) (the first one was the start)');
  // hang up lets the button go: it is a mic again, with no press listener
  await e.api.voiceCallHangUp(); await tick();
  assert.ok(!m.listeners.pointerdown, 'the press button is detached at hang-up');
  assert.strictEqual(e.api.voiceCallS.press, false);
});
test('desktop: a hands-free call is unchanged: no manual, no press, no talk(), the mic button is Hang up', async () => {
  const e = desktopCall('handsfree');
  await e.api.voiceCallStart('c1'); await tick();
  assert.ok(!('manual' in e.calls.vadOpts), 'no manual option');
  assert.ok(!('press' in e.calls.created[0]), 'no press dep');
  assert.deepStrictEqual(e.talks, []);
  const m = e.get('mic-c1');
  assert.strictEqual(m.attrs['aria-label'], 'Hang up'); assert.ok(m.classList.contains('call'));
  e.calls.created[0].ui.state('listening'); assert.strictEqual(e.get('vcb-state-c1').textContent, 'Listening');
  await e.api.voiceCallHangUp(); await tick();
});
test('desktop: a press call passes no onMute to the call display and hands the Talk slot to the press button; a hands-free call still passes onMute', async () => {
  let e = desktopCall('press');
  await e.api.voiceCallStart('c1'); await tick();
  const o = e.shown.displays[0].opts;
  assert.ok(!('onMute' in o) && o.onMute === undefined, 'no Mute for a press call');
  assert.strictEqual(o.press, true);
  const slot = fakeButton(); o.onPressButton(slot);
  slot.fire('pointerdown'); assert.deepStrictEqual(e.talks.slice(-1), [true], 'the Talk slot presses too');
  await e.api.voiceCallHangUp(); await tick();
  e = desktopCall('handsfree');
  await e.api.voiceCallStart('c1'); await tick();
  const h = e.shown.displays[0].opts;
  assert.strictEqual(typeof h.onMute, 'function', 'a hands-free call keeps Mute');
  assert.ok(!('press' in h) && !('onPressButton' in h));
  await e.api.voiceCallHangUp(); await tick();
});
test('desktop: the mode chip cycles Hands-free -> Tap to talk -> Hands-free (a saved Dictation goes to Hands-free), and never names Dictation', () => {
  const e = desktopCall('handsfree');
  const saved = () => e.getPrefs().mode;
  e.api.voiceModeToggle(); assert.strictEqual(saved(), 'press');
  e.api.voiceModeToggle(); assert.strictEqual(saved(), 'handsfree');
  e.stubs.voiceSavePrefs(null, { ...e.getPrefs(), mode: 'tap' });
  e.api.voiceModeToggle(); assert.strictEqual(saved(), 'handsfree');
  const label = between(app, 'function voiceModeLabel()', 'const VOICE_LEVELS_SVG');
  assert.ok(/'Tap to talk' : 'Hands-free'/.test(label) && !/Dictation/.test(label));
});

// ── 5. a press call from the phone mic ──
function phoneStart(mode) {
  const src = between(mob, 'function voiceCallStart()', 'function voiceCallWire()');
  const created = [], seen = {};
  const talks = [];
  const env = {
    voiceCall: null, current: 'bob', toast() {}, voiceOn: () => true, voiceRec: { state: 'idle' }, voiceMicCancel() {}, voiceTest: { handle: null }, voiceTestStop() {}, voiceRoomStop() {}, voiceStopPlayback() {}, voiceUnlockAudio() {},
    voicePrefsNow: () => ({ mode, micLevel: 60, interruptSensitivity: 40 }), voiceEffNow: () => ({ micLevel: 60, interruptSensitivity: 40, endPause: 1200, echoHold: 600 }),
    voiceCreateVad: (o) => { seen.vadOpts = o; return {}; }, voiceMicChoiceId: () => null, voiceIsIOS: () => false, voiceIsAndroidNav: () => false,
    voiceCreateCall: (deps) => { created.push(deps); return { start: async () => true, talk: (on) => { talks.push(on); return on; } }; },
    voiceCallDeps: (vc) => ({ press: vc.press === true ? true : undefined }), voiceCallPanel() {}, voiceCallPaintState() {}, voiceMicPaint() {}, voiceCallTeardown() {}, voiceWakeAcquire() {}, Date,
    voiceEndedBar() {}, voiceCallBgNote: false, voiceThinkingCtxMake() {}, voiceMediaSession() {}, voiceCallBeat() {}, setInterval: () => 0,
  };
  const names = Object.keys(env);
  const run = new Function(...names, src.replace(/voiceCall = vc;/, 'voiceCall = vc; globalThis.__vcPress = vc;') + '\nreturn voiceCallStart;')(...names.map(n => env[n]));
  return { run, created, seen, talks };
}
test('phone: Tap to talk starts a call with manual: true and a press vc, and calls talk(true) once when call.start() has resolved', async () => {
  const p = phoneStart('press');
  p.run(); assert.deepStrictEqual(p.talks, [], 'not before start has resolved'); await tick();
  assert.strictEqual(p.seen.vadOpts.manual, true);
  assert.strictEqual(globalThis.__vcPress.press, true);
  assert.deepStrictEqual(p.talks, [true], 'call.talk(true) once: one tap starts the call and starts listening');
  delete globalThis.__vcPress;
  const h = phoneStart('handsfree');
  h.run(); await tick();
  assert.ok(!('manual' in h.seen.vadOpts), 'hands-free: the VAD options are exactly as before');
  assert.strictEqual(globalThis.__vcPress.press, false);
  assert.deepStrictEqual(h.talks, []);
  delete globalThis.__vcPress;
  assert.match(between(mob, 'function voiceCallDeps(vc) {', 'return {\n'), /^function voiceCallDeps\(vc\) \{\s*const agent = vc\.agent;\s*$/, 'the deps function is the one cut above');
  assert.ok(/\.\.\.\(vc\.press === true \? \{ press: true \} : \{\}\)/.test(between(mob, 'function voiceCallDeps(vc) {', 'now: () => Date.now()')), 'the call deps carry press: true for a press call only');
  assert.ok(/press: \(on\) => \{ if \(voiceCall === vc\) voiceCallPressPaint\(vc, on\); \}/.test(mob), 'ui.press paints the phone');
});
test('phone: the press button, the state line and the display follow ui.press; hang-up lets the button go', () => {
  const src = between(mob, 'function voiceCallPressText(', 'function voiceCallPaintMeter(');
  const state = { s: { textContent: '', dataset: { state: 'listening', phrase: '' } } }, hooks = [];
  const vcRef = { v: null };
  const env = { voicePressButton: LIB.voicePressButton, $: (id) => (id === 'cp-state' ? state.s : null), voiceCallStateText: (n) => ({ listening: 'Listening', hearing: 'Hearing you', thinking: 'Thinking' }[n] || n), voiceDisplayHook: (...a) => hooks.push(a), VOICE_LINK_LOST_TEXT: 'Connection lost' };
  const f = new Function('voiceCall', ...Object.keys(env), src.replace(/\bvoiceCall\b(?!\w)/g, 'voiceCall.v') + '\nreturn { voiceCallPressText, voiceCallPressAttach, voiceCallPressDetach, voiceCallPressPaint, voiceCallPaintState };')(vcRef, ...Object.values(env));
  const talks = [];
  const vc = { press: true, pressing: false, pressBtns: [], call: { talk: (on) => talks.push(on) } }; vcRef.v = vc;
  const b = fakeButton(); f.voiceCallPressAttach(vc, b, { cls: 'listening' });
  assert.strictEqual(b.attrs['aria-label'], 'Talk'); assert.strictEqual(b.attrs.title, 'Tap to talk');
  assert.strictEqual(f.voiceCallPressAttach(vc, b, { cls: 'listening' }), vc.pressBtns[0], 'the same button is attached once');
  f.voiceCallPaintState('listening', ''); assert.strictEqual(state.s.textContent, 'Tap to talk');
  f.voiceCallPressPaint(vc, true);
  assert.strictEqual(b.attrs['aria-pressed'], 'true'); assert.strictEqual(b.attrs['aria-label'], 'Talk'); assert.strictEqual(b.attrs.title, 'Tap to send');
  assert.strictEqual(state.s.textContent, 'Listening');
  f.voiceCallPaintState('hearing', ''); assert.strictEqual(state.s.textContent, 'Listening');
  f.voiceCallPaintState('thinking', ''); assert.strictEqual(state.s.textContent, 'Thinking');
  assert.deepStrictEqual(hooks, [['setPress', true]], 'the display is told');
  f.voiceCallPressPaint(vc, false); assert.strictEqual(b.attrs['aria-label'], 'Talk'); assert.strictEqual(b.attrs.title, 'Tap to talk');
  b.fire('pointerdown'); assert.deepStrictEqual(talks, [true], 'the press reaches the call');
  f.voiceCallPressDetach(vc); b.fire('pointerdown'); assert.deepStrictEqual(talks, [true], 'let go at hang-up');
  // a hands-free call has no press text and no press button
  const hf = { press: false, pressing: false, pressBtns: [] }; vcRef.v = hf;
  assert.strictEqual(f.voiceCallPressText(hf, 'listening'), ''); assert.strictEqual(f.voiceCallPressAttach(hf, fakeButton(), {}), null);
  f.voiceCallPaintState('listening', ''); assert.strictEqual(state.s.textContent, 'Listening');
  // the mic button of a press call stays a mic; of a hands-free call it is the red hang-up
  const paint = between(mob, 'function voiceMicPaint() {', 'function voiceMicCancel()');
  assert.ok(/if \(voiceCall && voiceCall\.press\) \{[^}]*voiceCallPressAttach\(voiceCall, b, \{ cls: 'listening' \}\);[^}]*return;\s*\}\s*if \(voiceCall\) \{/.test(paint), 'press call first, then the red hang-up');
});
test('phone: a press call passes no onMute to the display (the Talk slot is the press button); a hands-free call still does', () => {
  const src = between(mob, 'function voiceDispBegin(vc) {', '// The call is ending');
  const run = (press) => {
    let opts = null, attached = [];
    const env = { CallDisplay: { createCallDisplay: (o) => { opts = o; return { start() {} }; }, createTalkFloor: () => ({}) }, voiceDisp: { last: null, floor: null, turnSeq: new Map(), cur: null, shared: {} }, voiceCall: null, document: {}, window: {}, localStorage: {}, fetch() {},
      agentByName: () => null, voiceDispRoutesLost() {}, voiceDispAgentDefault: () => 'none', voiceDispAdopt() {}, voiceOutNode() {}, $: () => null, voiceDispTalk() {}, voiceCallHangUp() {}, voiceCallRetryMicTap() {}, voiceDispPaintPanel() {}, voiceCallMuteTap() {},
      voiceCallPressAttach: (v, el, o) => attached.push([v, el, o]) };
    const f = new Function(...Object.keys(env), src + '\nreturn voiceDispBegin;')(...Object.values(env));
    const vc = { press, agent: 'bob' }; f(vc);
    return { opts, attached, vc };
  };
  const p = run(true);
  assert.ok(p.opts.onMute === undefined && p.opts.press === true, 'press: no Mute, press: true');
  p.opts.onPressButton('EL'); assert.deepStrictEqual(p.attached.map(a => a[1]), ['EL']); assert.strictEqual(p.attached[0][0], p.vc);
  const h = run(false);
  assert.strictEqual(typeof h.opts.onMute, 'function'); assert.ok(!('press' in h.opts) && !('onPressButton' in h.opts));
});

// ── 6. the call display: the Talk slot is the press button in a press call; Mute stays hidden ──
const cdSrc = read('test/ui-call-display.test.js');
let cdFakes = cdSrc.slice(cdSrc.indexOf('// ── fakes ──'), cdSrc.indexOf('// ── choice resolution ──'));
assert.ok(cdFakes.includes('onMute: o.mute ?'), 'the display harness is where this test expects it');
cdFakes = cdFakes.replace('onMute: o.mute ?', 'press: o.press, onPressButton: o.onPressButton, onMute: o.mute ?');
const cdWorld = new Function('CD', 'tick', 'require', 'assert', cdFakes + '\nreturn { world };')(CD, tick, require, assert).world;
const slot = (dom) => dom.find('ucd-talk')[0], statusText = (dom) => dom.find('ucd-status')[0].textContent, muteBtn = (dom) => dom.find('ucd-mute')[0];
test('call display: in a press call the Talk slot is the press button (label, aria-pressed, status line) and Mute stays hidden', async () => {
  const got = [];
  const w = cdWorld({ prefs: { choice: 'orb' }, press: true, onPressButton: (el) => got.push(el) });
  w.display.start(); await tick(20);
  assert.strictEqual(got.length, 1, 'the page is handed the slot button once, to wire its pointer events');
  w.display.setState('listening'); await tick();
  const s = slot(w.dom);
  assert.strictEqual(s.attrs['data-ucd-mode'], 'press'); assert.ok(!('data-ucd-off' in s.attrs), 'visible');
  assert.strictEqual(s.textContent, 'Tap to talk'); assert.strictEqual(s.attrs['aria-pressed'], 'false'); assert.strictEqual(s.attrs['aria-label'], 'Talk', 'the name is constant'); assert.strictEqual(s.attrs.title, 'Tap to talk');
  assert.strictEqual(statusText(w.dom), 'Tap to talk', 'listening and not pressing');
  assert.strictEqual(muteBtn(w.dom).hidden, true, 'no Mute in a press call');
  w.display.setPress(true);
  assert.strictEqual(s.textContent, 'Tap to send'); assert.strictEqual(s.attrs['aria-pressed'], 'true'); assert.strictEqual(statusText(w.dom), 'Listening');
  w.display.setState('hearing'); assert.strictEqual(statusText(w.dom), 'Listening');
  w.display.setPress(false); w.display.setState('thinking');
  assert.strictEqual(statusText(w.dom), 'Thinking', 'other states as today'); assert.strictEqual(s.attrs['data-ucd-mode'], 'press', 'the slot stays the press button');
  s.click(); assert.strictEqual(w.log.talk, 0, 'the display itself never calls onTalk for a press slot (the page owns the pointer)');
  w.display.release();
});
test('call display: a hands-free call is unchanged (the slot is the Interrupt slot, off by default; Mute shows with onMute); setPress does nothing there', async () => {
  const w = cdWorld({ prefs: { choice: 'orb' }, mute: true });
  w.display.start(); await tick(20);
  w.display.setState('listening'); await tick();
  assert.strictEqual(slot(w.dom).attrs['data-ucd-mode'], 'off'); assert.strictEqual(statusText(w.dom), 'Listening');
  assert.strictEqual(muteBtn(w.dom).hidden, false);
  w.display.setPress(true); assert.strictEqual(statusText(w.dom), 'Listening'); assert.strictEqual(slot(w.dom).attrs['data-ucd-mode'], 'off');
  w.display.release();
});

// ── 7. the pickers and the texts ──
const HELP_HANDS = 'Hands-free: tap the mic to start a call; it hears you whenever you speak.';
const HELP_PRESS = 'Tap to talk: a voice call where the agent answers aloud; tap the mic, speak, tap again to send (or hold it while you speak and let go).';
const HELP_DICT = 'Dictation: tap the mic to turn what you say into text in the message box.';
const inOrder = (s, list) => { let at = -1; for (const x of list) { const i = s.indexOf(x, at + 1); assert.ok(i > at, 'in order: ' + x); at = i; } };
test('desktop pickers: Settings select, the voice panel segment and the chip list Hands-free, Tap to talk, Dictation with values handsfree, press, tap', () => {
  const sel = between(app, 'id="st-voice-mode"', "h += row('Interrupt sensitivity'");
  inOrder(sel, ['value="handsfree"', '>Hands-free<', 'value="press"', '>Tap to talk<', 'value="tap"', '>Dictation<']);
  assert.match(app, /mode: mode\.value === 'tap' \|\| mode\.value === 'press' \? mode\.value : 'handsfree'/, 'the save keeps the three values');
  const pop = between(app, 'function voicePopHtml(', 'function voicePopClose(');
  inOrder(pop, ['data-vp="mode" data-val="handsfree"', '>Hands-free<', 'data-vp="mode" data-val="press"', '>Tap to talk<', 'data-vp="mode" data-val="tap"', '>Dictation<']);
  assert.match(app, /which === 'mode' \? \(v === 'tap' \|\| v === 'press' \? v : 'handsfree'\)/, 'voiceCtlSet keeps the three values');
  for (const t of [HELP_HANDS, HELP_PRESS, HELP_DICT]) { assert.ok(sel.includes(t), 'Settings help: ' + t); assert.ok(pop.includes(t), 'panel help: ' + t); }
  assert.match(app, /voiceModeToggle\(\) \{ voiceCtlSet\('mode', voicePrefsNow\(\)\.mode === 'handsfree' \? 'press' : 'handsfree', true\); \}/);
});
test('phone pickers: the voice panel radios, the Voice sheet radios and the chip list the three modes; the chip cycles Hands-free -> Tap to talk -> Hands-free', () => {
  const panel = between(mhtml, 'name="vp-mode" value="handsfree"', 'id="vp-speed"');
  inOrder(panel, ['value="handsfree"', 'Hands-free', 'value="press"', 'Tap to talk', 'value="tap"', 'Dictation']);
  const sheet = between(mob, 'name="vs-mode" value="handsfree"', "'<p class=\"vs-hint vs-help\">");
  inOrder(sheet, ['value="handsfree"', 'Hands-free', 'value="press"', 'Tap to talk', 'value="tap"', 'Dictation']);
  for (const t of [HELP_HANDS, HELP_PRESS, HELP_DICT]) assert.ok(mhtml.includes(t), 'panel help: ' + t);
  const help = between(mob, "sh.querySelector('.vs-help').textContent", "sh.querySelector('.vs-read')");
  for (const t of [HELP_HANDS, HELP_PRESS, HELP_DICT]) assert.ok(help.includes(t), 'sheet help: ' + t);
  assert.match(mob, /\$\('voice-mode-chip'\)\?\.addEventListener\('click', \(\) => \{ const prev = voicePrefsNow\(\)\.mode, next = prev === 'handsfree' \? 'press' : 'handsfree'; save\(\{ mode: next \}\); voiceModeNextCallToast\(prev, next\); \}\);/);   // (+ the toast of a mode picked during a call)
  const strip = between(mob, 'function voiceStripPaint() {', '// Under each of the four settings');
  assert.ok(/mode === 'press'/.test(strip) && !/chip\.(textContent|setAttribute)[^\n]*Dictation/.test(strip), 'the chip shows Hands-free or Tap to talk, never Dictation');
  const paint = between(mob, 'function voiceMicPaint() {', 'function voiceMicCancel()');
  inOrder(paint, ["'Tap to talk'", "'Talk hands-free'", "'Dictate'"]);
});
test('the help texts of both pages name all three modes: Hands-free, Tap to talk and Dictation (the call help names Tap to talk)', () => {
  const SENT = 'Tap to talk: tap the mic, speak, tap again to send (or hold it while you speak and let go).';
  assert.ok(app.includes("const VOICE_CALL_HELP = 'Hands-free works with the page open") && between(app, 'const VOICE_CALL_HELP', '\n').includes(SENT), 'desktop VOICE_CALL_HELP (the call bar vcb-help)');
  assert.ok(between(mob, 'const VOICE_CALL_HELP', '\n').includes(SENT), 'phone VOICE_CALL_HELP');
  assert.ok(between(mhtml, 'id="cp-help"', '</p>').includes(SENT), 'mobile.html #cp-help');
  assert.ok(/<div class="vcb-help">\$\{VOICE_CALL_HELP\}<\/div>/.test(app), 'the desktop call bar shows it');
  const label = (src) => ['Hands-free', 'Tap to talk', 'Dictation'].every(t => src.includes(t));
  assert.ok(label(between(app, 'function voicePopHtml(', 'function voicePopClose(')) && label(between(app, 'id="st-voice-mode"', "h += row('Interrupt sensitivity'")), 'desktop pickers');
  assert.ok(label(between(mhtml, 'name="vp-mode" value="handsfree"', 'id="vp-speed"')) && label(between(mob, 'name="vs-mode" value="handsfree"', "'<p class=\"vs-hint vs-help\">")), 'phone pickers');
  // the idle mic of the desktop: label and title by mode
  const idle = between(app, 'function voiceMicIdleLabel()', 'function voiceCallPaintBtn(');
  inOrder(idle, ["'Tap to talk'", "'Dictate'", "'Talk hands-free'"]);
  assert.match(app, /aria-label="\$\{voiceMicIdleLabel\(\)\}" title="\$\{hubEsc\(voiceMicIdleTitle\(chatId\)\)\}"/);   // voice entry (escaped: review r1 item 1): the title names the chat's agent
});
// ═══ review round 1 ═══
// ── item 3: a cancelled or lost pointer always ends the press it opened ──
for (const name of ['lib', 'app.js', 'mobile.js']) {
  const C = copies[name];
  test(`R1.3 voicePressButton (${name}): pointercancel and lostpointercapture end a press this pointer opened (talk(false)) whatever its length, and a cancelled second tap sends`, () => {
    let r = pressRig(C);
    r.el.fire('pointerdown'); r.btn.paint(true); r.clock.t += 120; r.el.fire('pointercancel');
    assert.deepStrictEqual(r.calls, [true, false], 'a short tap that the browser cancelled: the press it opened ends (it was never to be left open)');
    r = pressRig(C);
    r.el.fire('pointerdown'); r.btn.paint(true); r.clock.t += 120; r.el.fire('lostpointercapture');
    assert.deepStrictEqual(r.calls, [true, false], 'a lost capture ends it too');
    r = pressRig(C);
    r.el.fire('pointerdown'); r.btn.paint(true); r.clock.t += 80; r.el.fire('pointerup');   // the first tap: listening
    r.clock.t += 3000; r.el.fire('pointerdown'); r.clock.t += 60; r.el.fire('lostpointercapture');
    assert.deepStrictEqual(r.calls, [true, false], 'a second-tap sequence that loses its pointer sends');
    r = pressRig(C);
    r.el.fire('pointerdown'); r.btn.paint(true); r.clock.t += 80; r.el.fire('pointerup'); r.el.fire('lostpointercapture');
    assert.deepStrictEqual(r.calls, [true], 'the capture released after a normal pointerup changes nothing (the tap keeps listening)');
    r = pressRig(C);
    r.el.fire('lostpointercapture'); r.el.fire('pointercancel');
    assert.deepStrictEqual(r.calls, [], 'no press that began here: nothing to end');
  });
  test(`R1.3 voicePressButton (${name}): a pointerdown that finds an old or same-pointer sequence that never ended starts over; a lost pointer never leaves the clicks swallowed`, () => {
    let r = pressRig(C, false);
    r.el.fire('pointerdown', { pointerId: 1 });   // never painted (the call did not take it), no pointerup ever comes
    r.clock.t += 11000; r.el.fire('pointerdown', { pointerId: 2 });
    assert.deepStrictEqual(r.calls, [true, true], 'older than 10 s: reset, not ignored');
    r = pressRig(C, false);
    r.el.fire('pointerdown', { pointerId: 7 }); r.clock.t += 500; r.el.fire('pointerdown', { pointerId: 7 });
    assert.deepStrictEqual(r.calls, [true, true], 'the same pointer again: its earlier sequence is over');
    r = pressRig(C);
    r.el.fire('pointerdown', { pointerId: 1 }); r.clock.t += 500; r.el.fire('pointerdown', { pointerId: 2 });
    assert.deepStrictEqual(r.calls, [true], 'a second finger on a press under way is still ignored');
    r = pressRig(C);
    r.el.fire('pointerdown'); r.el.fire('lostpointercapture');   // talk(true), talk(false): swallowUntil is now + 700, not Infinity
    r.clock.t += 2000; r.el.fire('click');
    assert.deepStrictEqual(r.calls, [true, false, true], 'a later click is a toggle again: the swallowing ended with the sequence');
  });
  test(`R1.6 voicePressButton (${name}): off() (the display's "Try the microphone again") makes the press handlers do nothing; back on, they press`, () => {
    let off = true;
    const calls = [], el = fakeButton(), clock = { t: 10000 };
    C.voicePressButton(el, () => ({ talk: (on) => calls.push(on) }), { now: () => clock.t, off: () => off });
    clock.t += 5000;
    const d = el.fire('pointerdown'); el.fire('pointerup'); el.fire('click'); el.fire('keydown', { key: 'Enter' }); el.fire('keyup', { key: 'Enter' });
    assert.deepStrictEqual(calls, [], 'nothing reaches the call'); assert.ok(!d.prevented, 'and the default action is left alone: the display\'s own click runs');
    off = false; clock.t += 2000;
    el.fire('pointerdown'); assert.deepStrictEqual(calls, [true]);
  });
}

// ── item 4: holding the idle mic before a call exists ──
test('R1.4 desktop: how long the idle mic\'s pointer was held (voiceMicHeldMs) is read once; no pointer (keyboard, assistive technology) counts as a tap', () => {
  const src = between(app, 'const voiceMicPtr', 'async function voiceMicToggle(');
  const clk = { t: 5000 };
  const f = new Function('Date', src + '\nreturn { voiceMicPointer, voiceMicHeldMs };')({ now: () => clk.t });
  f.voiceMicPointer(false); clk.t += 1000; f.voiceMicPointer(true);
  assert.strictEqual(f.voiceMicHeldMs(), 1000, 'a hold of 1 s');
  assert.strictEqual(f.voiceMicHeldMs(), 0, 'read once');
  f.voiceMicPointer(false); clk.t += 120; f.voiceMicPointer(true); assert.strictEqual(f.voiceMicHeldMs(), 120, 'a tap');
  assert.strictEqual(f.voiceMicHeldMs(), 0, 'a click with no pointer: a tap');
  f.voiceMicPointer(false); clk.t += 5000; assert.strictEqual(f.voiceMicHeldMs(), 0, 'a pointerdown whose pointerup never came (a cancel) is not the pointer of a later keyboard click');
  f.voiceMicPointer(false); clk.t += 900; f.voiceMicPointer(true); clk.t += 3000; assert.strictEqual(f.voiceMicHeldMs(), 0, 'a release long before the click is not this click\'s');
  assert.ok(/onpointerdown="voiceMicPointer\(false\)" onpointerup="voiceMicPointer\(true\)" onclick="voiceMicToggle\('\$\{chatId\}'\)"/.test(app), 'the desktop mic button records its pointer');
});
test('R1.4 desktop: a held idle mic starts a Tap to talk call that comes up idle (no talk(true)); a tap or a click with no pointer starts it and listens', async () => {
  for (const [held, idle] of [[1000, true], [400, true], [399, false], [120, false], [0, false]]) {
    const S = { active: false, starting: false }, log = [];
    const m = desktopMic('press', { voiceMicHeldMs: () => held, voiceCallS: S, voiceCallStart: (id) => { log.push('call:' + id); S.call = {}; } });
    await m.run('c1');
    assert.deepStrictEqual(log, ['call:c1']);
    assert.strictEqual(S.idle === true, idle, 'held ' + held + ' ms: idle ' + idle);
  }
  const S0 = { active: false, starting: false };
  const m0 = desktopMic('press', { voiceMicHeldMs: () => 1000, voiceCallS: S0, voiceCallStart: () => {} });   // the start did not make a call (voice off ...): nothing is marked
  await m0.run('c1'); assert.ok(!S0.idle);
  // the whole call on the page: the idle mark reaches the end of voiceCallStart, where talk(true) is, only for a press call
  let e = desktopCall('press');
  let p = e.api.voiceCallStart('c1'); e.api.voiceCallS.idle = true; await p; await tick();
  assert.deepStrictEqual(e.talks, [], 'held: the call is up and idle');
  assert.strictEqual(e.api.voiceCallS.active, true); await e.api.voiceCallHangUp(); await tick();
  e = desktopCall('press'); await e.api.voiceCallStart('c1'); await tick();
  assert.deepStrictEqual(e.talks, [true], 'a tap: the call listens at once'); assert.strictEqual(e.api.voiceCallS.idle, false);
  await e.api.voiceCallHangUp(); await tick();
});
test('R1.4 phone: a held idle mic starts a Tap to talk call that comes up idle (no talk(true)); a tap or a click with no pointer starts it and listens', async () => {
  const ptrs = [];
  for (const [held, idle] of [[1000, true], [400, true], [399, false], [0, false]]) {
    const src = between(mob, 'async function voiceMicTap()', 'async function voiceMicStop()').replace(/\bvoiceCall\b(?!\w)/g, 'S.voiceCall');
    const S = { voiceCall: null }, log = [];
    const env = { S, voicePressEndedAt: 0, voiceMicHeldMs: () => held, VOICE_PRESS_HOLD_MS: 400, keepKeyboard: null, voiceCallHangUp() {}, voiceRec: { state: 'idle', guard: { pending: false } }, voiceTest: { guard: { pending: false } }, current: 'bob', toast() {},
      voicePrefsNow: () => ({ mode: 'press' }), voiceCallStart: () => { log.push('call'); S.voiceCall = { press: true }; }, Date };
    const f = new Function(...Object.keys(env), src + '\nreturn voiceMicTap;')(...Object.values(env));
    await f(); assert.deepStrictEqual(log, ['call']); assert.strictEqual(S.voiceCall.idle === true, idle, 'held ' + held + ' ms'); ptrs.push(S.voiceCall.idle === true);
  }
  assert.deepStrictEqual(ptrs, [true, true, false, false]);
  // voiceCallStart: talk(true) after call.start() resolves unless the call was marked idle meanwhile
  let p = phoneStart('press'); p.run(); globalThis.__vcPress.idle = true; await tick(); assert.deepStrictEqual(p.talks, [], 'held: idle'); delete globalThis.__vcPress;
  p = phoneStart('press'); p.run(); await tick(); assert.deepStrictEqual(p.talks, [true], 'a tap: listens'); delete globalThis.__vcPress;
  assert.ok(/\$\('mic-btn'\)\.addEventListener\('pointerdown', \(\) => voiceMicPointer\(false\)\);[^\n]*\n\s*\$\('mic-btn'\)\.addEventListener\('pointerup', \(\) => voiceMicPointer\(true\)\);\s*\n\s*onComposerTap\(\$\('mic-btn'\), voiceMicTap\);/.test(mob), 'the pointer is recorded before the tap handler acts on the pointerup');
  const rec = between(mob, 'const voiceMicPtr', 'async function voiceMicTap()');
  const clk = { t: 100 }; const g = new Function('Date', rec + '\nreturn { voiceMicPointer, voiceMicHeldMs };')({ now: () => clk.t });
  g.voiceMicPointer(false); clk.t += 700; g.voiceMicPointer(true); assert.strictEqual(g.voiceMicHeldMs(), 700); assert.strictEqual(g.voiceMicHeldMs(), 0);
});

// ── item 5: the chip and the pickers during a call show the call's own mode ──
test('R1.5 desktop: during a call the chip names the running call\'s mode; outside a call the saved one', () => {
  const src = between(app, 'function voiceModeLabel()', 'const VOICE_LEVELS_SVG');
  const mk = (S, mode) => new Function('voiceCallS', 'voicePrefsNow', src + '\nreturn voiceModeLabel;')(S, () => ({ mode }));
  assert.strictEqual(mk({ call: {}, press: false }, 'press')(), 'Hands-free', 'a Hands-free call, Tap to talk saved for the next one');
  assert.strictEqual(mk({ call: {}, press: true }, 'handsfree')(), 'Tap to talk', 'a Tap to talk call, Hands-free saved for the next one');
  assert.strictEqual(mk({ call: {}, press: true }, 'tap')(), 'Tap to talk');
  assert.strictEqual(mk({ call: null, press: true }, 'handsfree')(), 'Hands-free', 'no call: the saved mode');
  assert.strictEqual(mk({ call: null }, 'press')(), 'Tap to talk');
  assert.strictEqual(mk({ call: null }, 'tap')(), 'Hands-free', 'Dictation is never named');
});
test('R1.5 desktop: the chip, the panel and Settings save the mode for the next call and say so during a call; outside a call they say nothing', async () => {
  let e = desktopCall('handsfree');
  e.api.voiceModeToggle(); assert.strictEqual(e.getPrefs().mode, 'press'); assert.deepStrictEqual(e.calls.toasts, [], 'no call: no toast');
  await e.api.voiceCallStart('c1'); await tick();   // a Tap to talk call (the saved mode is Tap to talk now)
  assert.strictEqual(e.api.voiceCallS.press, true);
  e.api.voiceModeToggle();
  assert.strictEqual(e.getPrefs().mode, 'handsfree', 'saved for the next call');
  assert.deepStrictEqual(e.calls.toasts, ['From your next call: Hands-free.']);
  assert.strictEqual(e.api.voiceCallS.press, true, 'the running call keeps its mode');
  e.api.voiceCtlSet('mode', 'tap', true); assert.deepStrictEqual(e.calls.toasts.slice(1), ['From your next call: Dictation.']);
  e.api.voiceCtlSet('mode', 'tap', true); assert.strictEqual(e.calls.toasts.length, 2, 'picking what is already saved says nothing');
  await e.api.voiceCallHangUp(); await tick();
  e.api.voiceModeToggle(); assert.strictEqual(e.calls.toasts.length, 2, 'after the call: nothing to say');
  const settings = between(app, 'function voiceSettingsSavePrefs(', 'function voiceTestStop()');
  assert.ok(/const modeBefore = voicePrefsNow\(\)\.mode;/.test(settings) && /if \(prefs\.mode !== modeBefore\) voiceModeNextCallToast\(prefs\.mode\);/.test(settings), 'the Settings select too');
});
test('R1.5 phone: the chip names the running call\'s mode; the chip, the panel radios and the sheet radios save for the next call and say so during a call', () => {
  const src = between(mob, 'function voiceModeName(m)', 'function voiceStripPaint()');
  const toasts = [], S = { voiceCall: null };
  const f = new Function('S', 'toast', src.replace(/\bvoiceCall\b(?!\w)/g, 'S.voiceCall') + '\nreturn voiceModeNextCallToast;')(S, (t) => toasts.push(t));
  f('handsfree', 'press'); assert.deepStrictEqual(toasts, [], 'no call: nothing to say');
  S.voiceCall = { press: false };
  f('handsfree', 'press'); f('press', 'tap'); f('press', 'handsfree'); f('press', 'press');
  assert.deepStrictEqual(toasts, ['From your next call: Tap to talk.', 'From your next call: Dictation.', 'From your next call: Hands-free.']);
  assert.match(mob, /\$\('voice-mode-chip'\)\?\.addEventListener\('click', \(\) => \{ const prev = voicePrefsNow\(\)\.mode, next = prev === 'handsfree' \? 'press' : 'handsfree'; save\(\{ mode: next \}\); voiceModeNextCallToast\(prev, next\); \}\);/);
  assert.match(mob, /r\.addEventListener\('change', \(e\) => \{ if \(e\.target\.checked\) \{ const prev = voicePrefsNow\(\)\.mode; save\(\{ mode: e\.target\.value \}\); voiceModeNextCallToast\(prev, e\.target\.value\); \} \}\);/, 'the panel radios');
  assert.match(mob, /const prev = voicePrefsNow\(\)\.mode; voicePrefsSave\(\{ mode: e\.target\.value \}\); voiceMicPaint\(\); paintVoiceSheet\(\); voiceModeNextCallToast\(prev, e\.target\.value\);/, 'the sheet radios');
  const strip = between(mob, 'function voiceStripPaint() {', '// Under each of the four settings');
  assert.match(strip, /const press = voiceCall \? voiceCall\.press === true : voicePrefsNow\(\)\.mode === 'press'/, 'the chip follows voiceCall.press during a call');
});

// ── item 6: smaller fixes ──
test('R1.6 a click on the mic within 1 s of the end of a Tap to talk call does not start a new call (desktop and phone); later it does', async () => {
  const clk = { t: 100000 };
  const fake = { now: () => clk.t };
  for (const name of ['desktop', 'phone']) {
    const mk = (over) => (name === 'desktop' ? desktopMic('press', over) : phoneMic('press', undefined, over));
    const go = (m) => (name === 'desktop' ? m.run('c1') : m.run());
    let m = mk({ voicePressEndedAt: clk.t - 600, Date: fake });
    await go(m); assert.deepStrictEqual(m.log, [], name + ': 600 ms after the end: the trailing click of the press');
    m = mk({ voicePressEndedAt: clk.t - 1500, Date: fake });
    await go(m); assert.ok(m.log.some((x) => x.startsWith('call')), name + ': 1.5 s after: a new call');
    m = mk({ Date: fake });
    await go(m); assert.ok(m.log.some((x) => x.startsWith('call')), name + ': no call ended before: a new call');
  }
  const dt = between(app, 'function voiceCallTeardown()', 'function voiceCallHangUp()');
  assert.ok(dt.indexOf('if (S.press) voicePressEndedAt = Date.now();') > 0 && dt.indexOf('if (S.press) voicePressEndedAt') < dt.indexOf('voiceCallPressDetach(); S.press = false;'), 'desktop teardown notes the end of a press call before it lets go of it');
  const pt = between(mob, 'function voiceCallTeardown(vc)', 'function voiceCallHangUp()');
  assert.ok(pt.indexOf('if (vc.press) voicePressEndedAt = Date.now();') > 0 && pt.indexOf('if (vc.press) voicePressEndedAt') < pt.indexOf('voiceCallPressDetach(vc);'), 'phone teardown too');
});
test('R1.6 desktop: the call display\'s Talk slot does nothing while it reads "Try the microphone again" (the mic button still presses); the mic button gets touch-action: none during a Tap to talk call', async () => {
  const e = desktopCall('press');
  await e.api.voiceCallStart('c1'); await tick();
  const m = e.get('mic-c1');
  assert.strictEqual(m.style.touchAction, 'none', 'the pressed-by-finger mic button must not be cancelled by a pan');
  const d = e.shown.displays[0], o = d.opts, slotEl = fakeButton();
  o.onPressButton(slotEl);
  const n0 = e.talks.length; slotEl.fire('pointerdown'); assert.strictEqual(e.talks.length, n0 + 1, 'in press mode the slot presses');
  const before = e.talks.length;
  d.info = () => ({ talk: 'mic', micLost: true });   // the display's slot now reads "Try the microphone again"
  const down = slotEl.fire('pointerdown'); slotEl.fire('pointerup'); slotEl.fire('click'); slotEl.fire('keydown', { key: 'Enter' });
  assert.strictEqual(e.talks.length, before, 'the press handlers do nothing on it (only the display\'s retry runs)'); assert.ok(!down.prevented);
  m.listeners.pointerdown({ preventDefault() {}, pointerId: 1, pointerType: 'mouse', button: 0 });
  assert.strictEqual(e.talks.length, before + 1, 'the mic button still presses');
  await e.api.voiceCallHangUp(); await tick();
  assert.strictEqual(m.style.touchAction, '', 'back to a plain mic button after the call');
  const h = desktopCall('handsfree'); await h.api.voiceCallStart('c1'); await tick();
  assert.ok(h.get('mic-c1').style.touchAction !== 'none', 'a Hands-free call leaves the mic button alone'); await h.api.voiceCallHangUp(); await tick();
});
test('R1.6 phone: the display\'s Talk slot gets off() that is true only while it reads "Try the microphone again"', () => {
  const src = between(mob, 'function voiceDispBegin(vc) {', '// The call is ending');
  let opts = null, attached = [], info = { talk: 'press' };
  const disp = { cur: null, last: null, floor: null, turnSeq: new Map(), shared: {} };
  const env = { CallDisplay: { createCallDisplay: (o) => { opts = o; return { start() {}, info: () => info }; }, createTalkFloor: () => ({}) }, voiceDisp: disp, voiceCall: null, document: {}, window: {}, localStorage: {}, fetch() {},
    agentByName: () => null, voiceDispRoutesLost() {}, voiceDispAgentDefault: () => 'none', voiceDispAdopt() {}, voiceOutNode() {}, $: () => null, voiceDispTalk() {}, voiceCallHangUp() {}, voiceCallRetryMicTap() {}, voiceDispPaintPanel() {}, voiceCallMuteTap() {},
    voiceCallPressAttach: (v, el, o) => attached.push(o) };
  new Function(...Object.keys(env), src + '\nreturn voiceDispBegin;')(...Object.values(env))({ press: true, agent: 'bob' });
  opts.onPressButton('EL');
  assert.strictEqual(typeof attached[0].off, 'function');
  assert.strictEqual(attached[0].off(), false); info = { talk: 'mic' }; assert.strictEqual(attached[0].off(), true); info = { talk: 'press' }; assert.strictEqual(attached[0].off(), false);
  disp.cur = null; assert.strictEqual(attached[0].off(), false, 'no display: false');
});
test('R1.6 attaching a press button lets go of handles whose button is no longer in the document (desktop and phone)', async () => {
  // desktop
  const e = desktopCall('press');
  await e.api.voiceCallStart('c1'); await tick();
  const o = e.shown.displays[0].opts, a = fakeButton(), b = fakeButton();
  o.onPressButton(a);
  assert.ok(e.api.voiceCallS.pressBtns.some((h) => h.el === a));
  a.isConnected = false;   // the display closed: its slot left the page
  o.onPressButton(b);
  assert.ok(!e.api.voiceCallS.pressBtns.some((h) => h.el === a), 'the gone button\'s handle is dropped');
  assert.ok(e.api.voiceCallS.pressBtns.some((h) => h.el === b));
  assert.deepStrictEqual(a.listeners.pointerdown, [], 'and its listeners are removed');
  await e.api.voiceCallHangUp(); await tick();
  // phone
  const src = between(mob, 'function voiceCallPressText(', 'function voiceCallPaintMeter(');
  const vcRef = { v: null };
  const f = new Function('voiceCall', 'voicePressButton', '$', 'voiceCallStateText', 'voiceDisplayHook', 'VOICE_LINK_LOST_TEXT', src.replace(/\bvoiceCall\b(?!\w)/g, 'voiceCall.v') + '\nreturn { voiceCallPressAttach };')(vcRef, LIB.voicePressButton, () => null, () => '', () => {}, '');
  const vc = { press: true, pressing: false, pressBtns: [], call: { talk() {} } }; vcRef.v = vc;
  const p1 = fakeButton(), p2 = fakeButton();
  f.voiceCallPressAttach(vc, p1, {}); p1.isConnected = false; f.voiceCallPressAttach(vc, p2, {});
  assert.deepStrictEqual(vc.pressBtns.map((h) => h.el), [p2], 'phone: only the button that is still there');
  assert.deepStrictEqual(p1.listeners.pointerdown, []);
});

test('the phone service worker is bumped for the new mobile.html and mobile.js (hub-mobile-v82)', () => {
  assert.match(read('sw.js'), /const VERSION = 'hub-mobile-v82'/);
});

// ═══ review round 3 ═══
// ── item 2: a second finger takes over a sequence only when the owning pointer no longer has capture ──
for (const name of ['lib', 'app.js', 'mobile.js']) {
  const C = copies[name];
  test(`R3.2 voicePressButton (${name}): a long hold that keeps its capture is not taken over by a second finger; its release still ends the press`, () => {
    const r = pressRig(C);
    r.el.hasPointerCapture = (id) => id === 1;   // finger 1 holds the capture
    r.el.fire('pointerdown', { pointerId: 1 }); r.btn.paint(true);
    r.clock.t += 11000;   // past VOICE_PRESS_STALE_MS
    r.el.fire('pointerdown', { pointerId: 2 });
    assert.deepStrictEqual(r.calls, [true], 'finger 2 is ignored: finger 1 still owns the press');
    r.clock.t += 500; r.el.fire('pointerup', { pointerId: 1 });
    assert.deepStrictEqual(r.calls, [true, false], 'finger 1\'s release ends the press (the microphone does not stay on)');
  });
  test(`R3.2 voicePressButton (${name}): an old sequence whose pointer lost its capture is still taken over; so is the same pointer; a second finger inside 10 s is ignored`, () => {
    let r = pressRig(C, false);
    r.el.hasPointerCapture = () => false;   // the capture was lost, and no pointerup ever came
    r.el.fire('pointerdown', { pointerId: 1 }); r.clock.t += 11000; r.el.fire('pointerdown', { pointerId: 2 });
    assert.deepStrictEqual(r.calls, [true, true], 'stale and no capture: starts over');
    r = pressRig(C, false);
    r.el.hasPointerCapture = (id) => id === 1;
    r.el.fire('pointerdown', { pointerId: 1 }); r.clock.t += 20000; r.el.fire('pointerdown', { pointerId: 1 });
    assert.deepStrictEqual(r.calls, [true, true], 'the same pointer again starts over, capture or not');
    r = pressRig(C);
    r.el.hasPointerCapture = () => false;
    r.el.fire('pointerdown', { pointerId: 1 }); r.clock.t += 9000; r.el.fire('pointerdown', { pointerId: 2 });
    assert.deepStrictEqual(r.calls, [true], 'not stale yet: ignored even with no capture');
    r = pressRig(C, false);
    r.el.hasPointerCapture = () => { throw new Error('gone'); };   // a browser that throws: treated as no capture
    r.el.fire('pointerdown', { pointerId: 1 }); r.clock.t += 11000; r.el.fire('pointerdown', { pointerId: 2 });
    assert.deepStrictEqual(r.calls, [true, true]);
  });
}

// ── item 1: the pages' wrappers between the adapter and the call controller keep `manual` ──
const CALLLIB = require('../lib/ui-voice-call');
Object.assign(globalThis, require('../lib/ui-voice-thinking'));
function fakeBrowser3() {
  const b = { created: [], track: { enabled: true, stop() {} } };
  class Gain { constructor() { this.gain = { value: 1 }; } connect() {} }
  class Ctx {
    constructor() { this.state = 'suspended'; } async resume() { this.state = 'running'; } async close() {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; } createGain() { return new Gain(); }
    createMediaStreamDestination() { return { kind: 'dest', stream: { id: 'dest-stream', getTracks: () => [] } }; }
  }
  const raw = { id: 'raw', getAudioTracks: () => [b.track], getTracks: () => [b.track] };
  class MicVAD { static async new(options) { const v = new MicVAD(); v.options = options; b.created.push(v); return v; } async start() {} async destroy() {} setOptions() {} }
  const win = { AudioContext: Ctx, vad: undefined, navigator: { mediaDevices: { getUserMedia: async () => raw } } };
  return { b, win, loadScript: async () => { win.vad = { MicVAD }; } };
}
function clock3() {
  const c = { t: 1000, timers: [], id: 1 };
  c.now = () => c.t;
  c.setTimer = (fn, ms) => { const id = c.id++; c.timers.push({ id, at: c.t + ms, fn }); return id; };
  c.clearTimer = (id) => { c.timers = c.timers.filter((x) => x.id !== id); };
  c.go = (ms) => { const end = c.t + ms; for (;;) { const due = c.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0]; if (!due) break; c.timers = c.timers.filter((x) => x !== due); c.t = due.at; due.fn(); } c.t = end; };
  return c;
}
// The real call controller on a page's wrapped adapter (deps.vad as the page builds it); everything else is a fake.
function pageCall(pageVad, c) {
  const h = { states: [], pressUi: [], drops: 0, sent: [] };
  h.call = CALLLIB.voiceCreateCall({
    agent: 'a1', press: true, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, prefs: () => ({ continueWait: 0, thinkingSound: false }), vad: pageVad,
    stt: async () => 'words', isTurnRunning: () => false, send: async (t) => { h.sent.push(t); }, interject: async () => {}, stop() {},
    speak: () => new Promise(() => {}), cancelSpeech() {}, answerAsk() {},
    server: { start: async () => ({ callId: 'c1', held: [] }), heartbeat: async () => ({ held: [] }), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} },
    ui: { state: (s) => h.states.push(s), heard() {}, held() {}, toast() {}, summary() {}, level() {}, activity() {}, press: (on) => h.pressUi.push(on), reply: (k) => { if (k === 'drop') h.drops++; } },
  });
  return h;
}
const pf = (o, n, v) => { for (let i = 0; i < n; i++) o.onFrameProcessed({ isSpeech: 0.1 }, new Float32Array(512).fill(v)); };
// A press queued behind the tail of the one before it: nothing is started or shown before its admission, then exactly one start.
async function queuedPressThrough(pageVad, b, c) {
  const h = pageCall(pageVad, c);
  assert.strictEqual(await h.call.start(), true);
  const o = b.created[0].options; await o.getStream();
  h.call.talk(true);                      // A: nothing in its way, admitted at once
  assert.strictEqual(h.drops, 1, 'A: one start');
  pf(o, 20, 1);
  h.call.talk(false); await tick(10);     // A released: in its 200 ms tail
  const heardBefore = h.states.filter((s) => s === 'hearing').length, dropsBefore = h.drops;
  h.pressUi.length = 0;
  assert.strictEqual(h.call.talk(true), true);   // B requested inside A's tail
  await tick(10);
  assert.strictEqual(h.drops, dropsBefore, 'B: no start before its admission (the controller does not fake it)');
  assert.strictEqual(h.states.filter((s) => s === 'hearing').length, heardBefore, 'B: "hearing" is not shown before admission');
  assert.strictEqual(b.track.enabled, false, 'the tracks stay off until A\'s tail ends');
  assert.deepStrictEqual(h.pressUi, [], 'and the press is not shown as pressed yet');
  c.go(200); await tick(40);              // A's tail ends: B is admitted
  assert.strictEqual(h.drops, dropsBefore + 1, 'B: exactly one start, at admission');
  assert.strictEqual(b.track.enabled, true);
  assert.deepStrictEqual(h.pressUi, [true]);
  c.go(1000); await tick(10);
  assert.strictEqual(h.drops, dropsBefore + 1, 'nothing starts a second time');
  await h.call.hangUp();
}
test('R3.1 desktop: the page\'s wrapper (voiceCallVadFor, voiceDispVad) hands the call the live adapter\'s manual: a press queued behind a tail starts once, at admission', async () => {
  const { b, win, loadScript } = fakeBrowser3(), c = clock3();
  const real = CALLLIB.voiceCreateVad({ manual: true, win, loadScript, echoHoldMs: 0, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  const e = desktopCall('press', { voiceCreateVad: () => real });
  await e.api.voiceCallStart('c1'); await tick();
  const wrapped = e.calls.created[0].vad;
  assert.strictEqual(wrapped.manual, true, 'the object the page gives voiceCreateCall says manual');
  await queuedPressThrough(wrapped, b, c);
});
test('R3.1 phone: voiceCallDeps hands the call the live adapter\'s manual: a press queued behind a tail starts once, at admission', async () => {
  const src = between(mob, 'function voiceCallDeps(vc) {', '\n}\n') + '\n}';
  const names = ['voiceThinkingDeps', 'voiceEffNow', 'voiceCallServer', 'voiceCallOnRoute', 'voiceCallOnMicChange'];
  const voiceCallDeps = new Function(...names, src + '\nreturn voiceCallDeps;')(() => ({}), () => ({}), () => ({}), () => {}, () => {});
  const { b, win, loadScript } = fakeBrowser3(), c = clock3();
  const real = CALLLIB.voiceCreateVad({ manual: true, win, loadScript, echoHoldMs: 0, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  const deps = voiceCallDeps({ agent: 'a1', press: true, vad: real });
  assert.strictEqual(deps.vad.manual, true, 'the object the page gives voiceCreateCall says manual');
  assert.strictEqual(voiceCallDeps({ agent: 'a1', vad: { manual: false } }).vad.manual, false, 'a hands-free adapter says it is not manual');
  assert.strictEqual(voiceCallDeps({ agent: 'a1', vad: {} }).vad.manual, false, 'one with no word on it is not manual');
  await queuedPressThrough(deps.vad, b, c);
});
test('R3.1 both pages: the wrapper objects read manual from the adapter live (a getter, not a copied value)', () => {
  assert.match(between(app, 'function voiceDispVad(vad) {', '\n'), /get manual\(\) \{ return !!\(vad && vad\.manual\); \}/);
  assert.match(between(app, 'function voiceCallVadFor(vad) {', '\n    }\n'), /get manual\(\) \{ return !!\(vad && vad\.manual\); \}/);
  assert.match(between(mob, 'function voiceCallDeps(vc) {', '\n}\n'), /get manual\(\) \{ return !!\(vc\.vad && vc\.vad\.manual\); \}/);
});
