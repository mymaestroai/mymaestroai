'use strict';
// Tap to talk follow-up: the listening look (green, not the red of Hang up or recording), the short caption, and ui.press(false) when a pressing call ends.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
Object.assign(globalThis, require('../lib/ui-voice'), require('../lib/ui-voice-thinking'));
const { voiceCreateCall } = require('../lib/ui-voice-call');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

// ── the controller: a manual-style fake detector, as in ui-voice-press.test.js ──
function harness() {
  const h = { t: 0, pressUi: [], handlers: null, ended: [] };
  h.vad = {
    start: async (hd) => { h.handlers = hd; }, stop() {}, setPlaybackActive() {},
    setMuted: (on) => { if (!on) { h.handlers.onSpeechBegin(); h.handlers.onSpeechStart(); } },
    endPiece: async () => true,
  };
  h.deps = {
    agent: 'a1', press: true, now: () => h.t, setTimer: () => 1, clearTimer() {}, prefs: () => ({ continueWait: 0, thinkingSound: false }),
    vad: h.vad, stt: async (a) => a.text, isTurnRunning: () => false, send: async () => {}, interject: async () => {}, stop() {},
    speak: () => new Promise(() => {}), cancelSpeech() {}, answerAsk() {},
    server: { start: async () => ({ callId: 'c1', held: [] }), heartbeat: async () => ({ held: [] }), mode: async () => {}, end: async () => { h.ended.push(1); return { held: [] }; }, decide: async () => {} },
    ui: { state() {}, heard() {}, held() {}, toast() {}, summary() {}, level() {}, activity() {}, press: (on) => h.pressUi.push(on) },
  };
  h.call = voiceCreateCall(h.deps);
  return h;
}
async function started() { const h = harness(); assert.strictEqual(await h.call.start(), true); return h; }

test('look 1: hanging up a Tap to talk call while pressing calls ui.press(false) once', async () => {
  const h = await started();
  h.call.talk(true);
  assert.deepStrictEqual(h.pressUi, [false, true]);
  await h.call.hangUp(); await tick();
  assert.deepStrictEqual(h.pressUi, [false, true, false], 'the listening look is let go with the call');
  await h.call.hangUp(); h.call.release(); await tick();
  assert.deepStrictEqual(h.pressUi, [false, true, false], 'a second hang-up or release adds nothing');
});

test('look 2: release() (page hidden or closed) while pressing calls ui.press(false) once', async () => {
  const h = await started();
  h.call.talk(true);
  h.call.release('pagehide'); h.call.release('hidden'); await tick();
  assert.deepStrictEqual(h.pressUi, [false, true, false]);
});

test('look 3: a press requested but not yet shown still ends with ui.press(false); a call that is not pressing says nothing more', async () => {
  const h = harness();
  h.vad.manual = true; h.vad.setMuted = () => {};   // a detector that has not reported the start of the press: ui.press(true) was never said
  await h.call.start();
  h.call.talk(true);
  assert.deepStrictEqual(h.pressUi, [false]);
  await h.call.hangUp(); await tick();
  assert.deepStrictEqual(h.pressUi, [false, false], 'the button (which follows the request) is let go too');
  const g = await started();   // not pressing at hang-up: the call's own ui.press(false) at its start is all there is
  await g.call.hangUp(); await tick();
  assert.deepStrictEqual(g.pressUi, [false]);
});

test('look 4: a call that is not a Tap to talk call never calls ui.press', async () => {
  const h = harness(); h.deps.press = false; h.call = voiceCreateCall(h.deps);
  await h.call.start(); await h.call.hangUp(); await tick();
  assert.deepStrictEqual(h.pressUi, []);
});

test('look 5: the teardown line is the same in the library and in both pages', () => {
  const line = "if (press && (pressing || pressShown)) { pressing = false; pressShown = false; quiet(() => { if (typeof ui.press === 'function') ui.press(false); }); }";
  for (const f of ['lib/ui-voice-call.js', 'app.js', 'mobile.js']) assert.ok(read(f).includes(line), f);
});

// ── the listening look ──
test('look 6: the display\'s pressed press slot is green (--voice-listening), never --mic-rec; Hang up keeps its red', () => {
  const css = read('lib/ui-call-display.css');
  const rule = css.split('\n').find(l => l.startsWith('.ucd-bar .ucd-talk[data-ucd-mode="press"][aria-pressed="true"]'));
  assert.ok(rule, 'the pressed rule exists');
  assert.match(rule, /background: var\(--voice-listening, #15803d\)/);
  assert.match(rule, /box-shadow: 0 0 0 3px var\(--voice-listening, #15803d\)/);
  assert.ok(!/mic-rec/.test(rule), 'not the red');
  assert.match(css, /\.ucd-bar \.ucd-hang \{ background: var\(--error, #e5484d\)/, 'Hang up stays red');
});

test('look 7: the press buttons of both pages use the listening class, not rec; dictation still uses rec', () => {
  for (const f of ['app.js', 'mobile.js']) {
    const s = read(f);
    assert.ok(/voiceCallPressAttach\((voiceCall, )?b, \{ cls: 'listening' \}\)/.test(s), f + ': the mic button is a press button painted with listening');
    assert.ok(!/voiceCallPressAttach\((voiceCall, )?b, \{ cls: 'rec' \}\)/.test(s), f + ': no press button is painted with rec');
  }
  assert.match(read('app.js'), /b\.classList\.toggle\('rec', state === 'rec'\)/, 'desktop dictation: rec');
  assert.match(read('mobile.js'), /b\.classList\.toggle\('rec', rec\)/, 'phone dictation: rec');
  assert.match(read('lib/ui-voice.js'), /typeof o\.cls === 'string' \? o\.cls : 'rec'/, 'the helper\'s default stays rec');
});

test('look 8: .listening is styled on the desktop mic button and the phone #mic-btn from --voice-listening', () => {
  const idx = read('index.html'), mob = read('mobile.html');
  assert.match(idx, /\.input-area \.mic-btn\.listening, \.input-area \.mic-btn\.listening:hover \{ background: var\(--voice-listening\)/);
  assert.match(idx, /html\.mm-simple \.input-area \.mic-btn\.listening[^{]*\{ background: var\(--voice-listening\)/, 'Simple too');
  assert.match(mob, /#mic-btn\.listening \{ background: var\(--voice-listening\)/);
  assert.ok(!/\.listening[^}]*--mic-rec|\.listening[^}]*var\(--error\)/.test(idx.match(/\.mic-btn\.listening[^\n]*/)[0] + (mob.match(/#mic-btn\.listening[^\n]*/)[0])), 'no red in them');
  assert.match(idx, /--voice-listening: #15803d;/); assert.match(mob, /--voice-listening: #15803d;/);
});

function lum(hex) {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrastWhite = (hex) => 1.05 / (lum(hex) + 0.05);

test('look 9: every --voice-listening green keeps white text at 4.5:1 or more; each look sets its own', () => {
  for (const [file, expected] of [['index.html', '#15803d'], ['mobile.html', '#15803d'], ['looks/broadsheet.css', '#1F6B45'], ['looks/quiet.css', '#2A724A']]) {
    const m = read(file).match(/--voice-listening: (#[0-9A-Fa-f]{6});/);
    assert.ok(m, file + ' defines --voice-listening');
    assert.strictEqual(m[1], expected);
    assert.ok(contrastWhite(m[1]) >= 4.5, file + ' ' + m[1] + ' white contrast ' + contrastWhite(m[1]).toFixed(2));
  }
  assert.ok(contrastWhite('#15803d') >= 5.0);
});

// ── the caption ──
test('look 10: the state text while pressing is "Listening" everywhere; the idle text stays "Tap to talk"', () => {
  for (const f of ['app.js', 'mobile.js', 'lib/ui-call-display.js']) {
    const s = read(f);
    assert.ok(!s.includes('Listening, tap to send'), f + ': the long caption is gone');
    assert.ok(s.includes("'Listening'") && s.includes("'Tap to talk'"), f);
  }
});
