// Desktop: the Hands-free pill (.voice-mode-chip) shows only in the chat whose voice call is up (owner, 2026-11-13);
// outside a call the talk mode stays in Voice settings and Settings > Voices.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
function fnSource(name) {
  const at = app.indexOf(`function ${name}(`);
  assert.ok(at >= 0, name + ' exists');
  let i = app.indexOf('{', at), depth = 0;
  for (; i < app.length; i++) { if (app[i] === '{') depth++; else if (app[i] === '}') { depth--; if (depth === 0) break; } }
  return app.slice(at, i + 1);
}

test('the chat bar draws the pill hidden', () => {
  assert.ok(/<button type="button" class="voice-mode-chip" id="vmode-\$\{chatId\}"[^>]*style="display:none"/.test(app));
});

test('voiceModeChipPaint shows the pill only in the chat with the call up (run)', () => {
  const chips = ['vmode-chat-1', 'vmode-chat-2'].map((id) => ({ id, style: { display: '' } }));
  const document = { querySelectorAll: (sel) => (sel === '.input-area .voice-mode-chip' ? chips : []) };
  const S = { call: null, chatId: null };
  const paint = new Function('document', 'voiceCallS', fnSource('voiceModeChipPaint') + '\nreturn voiceModeChipPaint;')(document, S);
  paint();
  assert.deepStrictEqual(chips.map((c) => c.style.display), ['none', 'none'], 'no call: no pill anywhere');
  S.call = {}; S.chatId = 'chat-2'; paint();
  assert.deepStrictEqual(chips.map((c) => c.style.display), ['none', ''], 'only the call chat shows it');
  S.call = null; S.chatId = null; paint();
  assert.deepStrictEqual(chips.map((c) => c.style.display), ['none', 'none'], 'after the call it goes');
});

test('voiceModeChipPaint survives being painted before the call state exists', () => {
  const chips = [{ id: 'vmode-chat-1', style: { display: '' } }];
  const document = { querySelectorAll: () => chips };
  const paint = new Function('document', 'let r = (() => { ' + fnSource('voiceModeChipPaint') + '\nreturn voiceModeChipPaint; })(); return r;')(document);
  assert.doesNotThrow(() => paint());
  assert.strictEqual(chips[0].style.display, 'none');
});

test('call start, teardown and voicePaint repaint the pill (guarded calls)', () => {
  const guarded = /if \(typeof voiceModeChipPaint === 'function'\) voiceModeChipPaint\(\);/;
  assert.ok(guarded.test(fnSource('voiceCallTeardown')), 'teardown');
  assert.ok(guarded.test(fnSource('voicePaint')), 'voicePaint (a chat bar drawn during a call)');
  const start = app.slice(app.indexOf('async function voiceCallStart(chatId)'), app.indexOf('async function voiceCallStart(chatId)') + 6000);   // the recorded-call setup made the start longer
  assert.ok(/voiceCallShowBar\(chatId\);\n\s+if \(typeof voiceModeChipPaint === 'function'\) voiceModeChipPaint\(\);/.test(start), 'start, after S.chatId is set');
});
