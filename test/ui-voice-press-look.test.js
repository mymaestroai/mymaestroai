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

test('look 11: the microphone lost during a press ends the press and lets the listening look go', async () => {
  const h = await started();
  h.call.talk(true);
  assert.deepStrictEqual(h.pressUi, [false, true]);
  h.handlers.onMicChange({ ok: false, reason: 'ended' }); await tick();
  assert.deepStrictEqual(h.pressUi, [false, true, false], 'the green look goes with the microphone');
  h.handlers.onMicChange({ ok: true }); await tick();
  assert.strictEqual(h.call.talk(true), true, 'not pressing any more: the next tap starts a new press');
});

test('look 12: no press starts while the microphone is lost; one starts again once it is back', async () => {
  const h = await started();
  h.handlers.onMicChange({ ok: false, reason: 'ended' }); await tick();
  assert.strictEqual(h.call.talk(true), false, 'a tap with no microphone does not start listening');
  assert.deepStrictEqual(h.pressUi, [false]);
  h.handlers.onMicChange({ ok: true }); await tick();
  assert.strictEqual(h.call.talk(true), true);
  assert.deepStrictEqual(h.pressUi, [false, true]);
});

// ── the ready look: idle "Tap to talk" is neutral ink, never the accent ──
const blocksOf = (file) => [...read(file).replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2], file }));
const COLOR_FILES = ['index.html', 'mobile.html', 'looks/broadsheet.css', 'looks/quiet.css'];
const hexOf = (body, name) => { const m = body.match(new RegExp('(?:^|[\\s;{])' + name + ':\\s*(#[0-9A-Fa-f]{6})\\b')); return m ? m[1] : null; };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const rgb = (hex) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

test('ready 1: the idle press slot rule uses --voice-ready and --on-voice-ready; no idle press rule uses --accent', () => {
  const css = read('lib/ui-call-display.css');
  const idle = css.split('\n').filter(l => l.includes('.ucd-talk[data-ucd-mode="press"]') && !l.replace(':not([aria-pressed="true"])', '').includes('[aria-pressed="true"]') && /background|color:/.test(l));
  assert.ok(idle.length >= 1, 'an idle press rule sets the colours');
  assert.ok(idle.some(l => /background: var\(--voice-ready[,)]/.test(l) && /[^-]color: var\(--on-voice-ready[,)]/.test(l) && /border-color: transparent/.test(l)), 'idle: ready fill, its text, no border');
  for (const l of idle) assert.ok(!/--accent/.test(l), 'idle press rule must not use the accent: ' + l.slice(0, 80));
});

test('ready 2: the listening rule takes its text colour from --on-voice-listening', () => {
  const css = read('lib/ui-call-display.css');
  const rule = css.split('\n').find(l => l.startsWith('.ucd-bar .ucd-talk[data-ucd-mode="press"][aria-pressed="true"]'));
  assert.match(rule, /[^-]color: var\(--on-voice-listening, #fff\)/);
});

test('ready 3: the hands-free slot (no press mode) keeps the accent', () => {
  const css = read('lib/ui-call-display.css');
  const base = css.split('\n').find(l => l.startsWith('.ucd-bar .ucd-talk {'));
  assert.ok(base && /background: var\(--accent, #3d7bff\)/.test(base));
  assert.ok(!/--voice-ready/.test(base), 'the base slot is not the ready look');
  assert.ok(!css.split('\n').some(l => /data-ucd-mode="mic"/.test(l) && /--voice-ready/.test(l)), 'the mic-retry slot is not the ready look');
});

test('ready 4: wherever --voice-listening is defined, --voice-ready and --on-voice-ready are defined beside it', () => {
  let seen = 0;
  for (const f of COLOR_FILES) for (const b of blocksOf(f)) {
    if (!hexOf(b.body, '--voice-listening')) continue;
    seen++;
    assert.ok(hexOf(b.body, '--voice-ready'), f + ' [' + b.sel.slice(-60) + '] lacks --voice-ready');
    assert.ok(hexOf(b.body, '--on-voice-ready'), f + ' [' + b.sel.slice(-60) + '] lacks --on-voice-ready');
  }
  assert.ok(seen >= 6, 'index, mobile, both looks (main) and both looks (Simple): ' + seen);
});

test('ready 5: each look\'s Simple blocks define all four voice colours; so do both pages\' Simple palettes', () => {
  const four = (body) => ['--voice-listening', '--on-voice-listening', '--voice-ready', '--on-voice-ready'].every(n => hexOf(body, n));
  for (const look of ['broadsheet', 'quiet']) {
    const bs = blocksOf('looks/' + look + '.css');
    for (const tail of ['.mm-simple', '.mm-simple.mm-light']) {
      const sel = 'html[data-look="' + look + '"]' + tail;
      const hit = bs.filter(b => b.sel.split(',').map(s => s.trim()).includes(sel));
      assert.ok(hit.length, look + ' has a block for ' + sel);
      assert.ok(hit.some(b => four(b.body)), look + ' ' + tail + ' defines all four');
    }
  }
  for (const f of ['index.html', 'mobile.html']) {
    const bs = blocksOf(f);
    for (const sel of ['html.mm-simple', 'html.mm-simple.mm-light']) {
      const hit = bs.filter(b => b.sel.split(',').some(s => s.trim().endsWith(sel)) && /--bg-dark:/.test(b.body));   // endsWith: the first selector of a block in index.html follows a </style><style> tag
      assert.ok(hit.length === 1, f + ' has the ' + sel + ' palette');
      assert.ok(hexOf(hit[0].body, '--voice-ready') && hexOf(hit[0].body, '--on-voice-ready'), f + ' ' + sel + ' defines the ready pair');
    }
  }
});

test('ready 6: every ready pair has 7:1 text contrast, 3:1 against its page, and is neither red- nor green-dominant', () => {
  let pairs = 0;
  for (const f of COLOR_FILES) for (const b of blocksOf(f)) {
    const fill = hexOf(b.body, '--voice-ready'); if (!fill) continue;
    const on = hexOf(b.body, '--on-voice-ready'); assert.ok(on, f + ': a pair');
    pairs++;
    const bg = hexOf(b.body, '--bg-dark') || '#1a1a19';   // a block with no page colour of its own sits on the dark Simple page
    assert.ok(ratio(fill, on) >= 7, f + ' ' + fill + '/' + on + ' text ' + ratio(fill, on).toFixed(2));
    assert.ok(ratio(fill, bg) >= 3, f + ' ' + fill + ' on ' + bg + ' ' + ratio(fill, bg).toFixed(2));
    const [r, g, bl] = rgb(fill);
    assert.ok(!(r > g + 40 && r > bl + 40), f + ' ' + fill + ' is red-dominant');
    assert.ok(!(g > r + 40 && g > bl + 40), f + ' ' + fill + ' is green-dominant');
  }
  assert.ok(pairs >= 10, 'pairs checked: ' + pairs);
});

test('ready 7: the desktop Simple call button is the ready look only while a Tap to talk call is idle', () => {
  const idx = read('index.html');
  const line = idx.split('\n').find(l => l.includes('.mic-btn.simple-call[aria-label="Talk"][aria-pressed="false"]'));
  assert.ok(line && /background: var\(--voice-ready\); color: var\(--on-voice-ready\)/.test(line));
  assert.ok(!/--accent|--brand-violet|--error/.test(line));
});
