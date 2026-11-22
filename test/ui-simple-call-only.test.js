'use strict';
// Simple has no dictation: the composer's voice button is the voice call only (desktop), and the phone's dictation mic
// is hidden so the call button is the only voice control. Advanced keeps its mic and its tap/hands-free choice.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js');

function fnSource(src, name) {
  const i = src.search(new RegExp('(async )?function ' + name + '\\('));
  assert.ok(i >= 0, name);
  let depth = 0; let j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}') { depth--; if (!depth) break; } }
  return src.slice(i, j + 1);
}

test('desktop: in Simple the voice button starts a call whatever the voice mode; Advanced keeps its own line', () => {
  const f = fnSource(app, 'voiceMicToggle');
  const simple = f.indexOf("if (typeof simpleOn === 'function' && simpleOn()) { voiceCallStart(chatId); if (held && voiceCallS.call) voiceCallS.idle = true; return; }");   // (both lines now also mark a call that comes up idle after a held idle mic: Tap to talk)
  const adv = f.indexOf("if (voicePrefsNow().mode !== 'tap') { voiceCallStart(chatId); if (held && voiceCallS.call) voiceCallS.idle = true; return; }");
  assert.ok(simple > 0 && adv > simple, 'the Simple line comes first and the Advanced line is unchanged but for that mark');
  assert.ok(f.indexOf('if (!voiceReady())') < simple, 'voice off still says so first');
  assert.ok(f.indexOf('voiceCallHangUp()') < simple, 'a call that is up is still hung up first');
});

test('desktop: simpleCallLook makes the button a voice-call button in Simple only, and leaves the Hang up state alone', () => {
  const ctx = { VOICE_LEVELS_SVG: '<svg id="levels"></svg>', on: true };
  vm.createContext(ctx);
  vm.runInContext('function simpleOn() { return on; }\n' + fnSource(app, 'simpleCallLook') + '\nthis.look = simpleCallLook;', ctx);
  const btn = () => {
    const cls = new Set(); const attrs = {};
    return { classList: { toggle: (c, v) => { if (v) cls.add(c); else cls.delete(c); }, has: (c) => cls.has(c) }, setAttribute: (k, v) => { attrs[k] = v; }, attrs, innerHTML: '<svg id="mic"></svg>', title: 'Talk' };
  };
  const b = btn(); ctx.look(b, false);
  assert.ok(b.classList.has('simple-call'));
  assert.strictEqual(b.innerHTML, '<svg id="levels"></svg>');
  assert.strictEqual(b.attrs['aria-label'], 'Voice call');
  const c = btn(); c.innerHTML = '<svg id="hangup"></svg>'; ctx.look(c, true);
  assert.strictEqual(c.innerHTML, '<svg id="hangup"></svg>', 'during a call the red Hang up stays');
  ctx.on = false; const d = btn(); ctx.look(d, false);
  assert.strictEqual(d.innerHTML, '<svg id="mic"></svg>', 'Advanced: untouched');
  assert.ok(!d.classList.has('simple-call'));
});

test('desktop: the look is applied when the composer is set up and after every call paint', () => {
  assert.match(fnSource(app, 'voiceCallPaintBtn'), /if \(typeof simpleCallLook === 'function'\) simpleCallLook\(b, on\);/);
  assert.match(fnSource(app, 'simpleComposerInit'), /if \(mic\) simpleCallLook\(mic, mic\.classList\.contains\('call'\)\);/);
  const css = read('index.html');
  // looks-vars: the value is unchanged; index.html/app.js now spell it as a variable (defined in index.html :root)
  assert.match(css, /html\.mm-simple \.input-area \.mic-btn\.simple-call \{[^}]*background: var\(--brand-violet\);/);
  assert.match(css, /--brand-violet:\s*#8b6fd6;/);
  assert.match(css, /html\.mm-simple \.input-area \.mic-btn\.simple-call\.call \{ background: var\(--simple-call-live-bg\);/);
  assert.match(css, /--simple-call-live-bg:\s*#e5484d;/);
});

test('phone: the dictation mic is hidden in Simple; the call button still follows whether voice is on', () => {
  const html = read('mobile.html');
  assert.match(html, /html\.mm-simple #mic-btn \{ display: none !important; \}/);
  assert.match(html, /html\.mm-simple #composer \.row:has\(#mic-btn\[hidden\]\) #simple-call-btn \{ display: none; \}/);
});
