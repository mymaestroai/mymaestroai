'use strict';
// The phone's Voice sheet (openVoiceSheet / voiceSheet) has the same two loudness selects as #voice-panel,
// saved to the same prefs through the same function (voiceLoudnessSave) and applied live the same way.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const V = require('../lib/ui-voice');
const mob = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'mobile.html'), 'utf8');
const between = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, a + ' .. ' + b); return src.slice(i, j); };

const sheetSrc = between(mob, 'function voiceSheet() {', 'function paintVoiceSheet() {');
const paintSrc = between(mob, 'function paintVoiceSheet() {', 'function openVoiceSheet() {');
const optsSrc = between(mob, 'const VOICE_LOUDNESS_OPTIONS', 'function voiceLoudnessSave');
const saveSrc = between(mob, 'function voiceLoudnessSave(', 'function voiceSheet() {');
const OPTIONS = new Function(optsSrc + '\nreturn VOICE_LOUDNESS_OPTIONS;')();
const forFn = between(mob, 'function voiceLoudnessFor(', '\nfunction ', 0);

// The sheet's html is a string concatenation: evaluate just the template part with the constants it needs.
function sheetHtml() {
  const start = sheetSrc.indexOf("sh.innerHTML = ") + 'sh.innerHTML = '.length;
  const end = sheetSrc.indexOf("</button></div>';", start) + "</button></div>'".length;
  const expr = sheetSrc.slice(start, end);
  const consts = { VOICE_LOUDNESS_OPTIONS: OPTIONS, VOICE_INTERRUPT_HINT: '', VOICE_END_PAUSES: [800, 1200, 2000], VOICE_SPEED_HINT: '', VOICE_ECHO_HOLDS: [400, 600], VOICE_ECHO_LABELS: ['a', 'b'], VOICE_KEEPALIVE_HINT: '', VOICE_ECHO_HINT: '' };
  return new Function(...Object.keys(consts), 'return ' + expr + ';')(...Object.values(consts));
}
const selectOf = (h, id) => { const m = h.match(new RegExp('<select id="' + id + '"[^>]*>(.*?)</select>')); assert.ok(m, id + ' select'); return m[1]; };
const optionsOf = (inner) => [...inner.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map((m) => [m[1], m[2]]);
const WANT = [['normal', 'Normal'], ['louder', 'Louder'], ['loudest', 'Loudest']];

test('the Voice sheet has both loudness selects, labelled like #voice-panel, with Normal / Louder / Loudest', () => {
  const h = sheetHtml();
  assert.ok(h.includes('<label class="vs-row" for="vs-loudness"><span>Voice loudness, speaker</span></label>'));
  assert.ok(h.includes('<label class="vs-row" for="vs-loudness-bt"><span>Voice loudness, Bluetooth / car</span></label>'));
  assert.deepStrictEqual(optionsOf(selectOf(h, 'vs-loudness')), WANT);
  assert.deepStrictEqual(optionsOf(selectOf(h, 'vs-loudness-bt')), WANT);
  // same labels and options as the static panel
  assert.ok(html.includes('<span>Voice loudness, speaker</span>') && html.includes('<span>Voice loudness, Bluetooth / car</span>'));
  assert.deepStrictEqual(optionsOf(selectOf(html, 'vp-loudness')), WANT);
  assert.deepStrictEqual(optionsOf(selectOf(html, 'vp-loudness-bt')), WANT);
  assert.ok(/<select id="vs-loudness" class="vs-btn">/.test(h) && /<select id="vs-loudness-bt" class="vs-btn">/.test(h), 'same vs-btn styling as the other sheet selects');
});

// paintVoiceSheet cut out with a fake sheet; voiceLoudnessFor is the real one.
function paint(prefs) {
  const els = {};
  const sel = (id) => (els[id] = els[id] || { value: '', id });
  const dummy = new Proxy({}, { get: (t, k) => (k === 'classList' ? { toggle() {}, contains: () => true } : k === 'querySelector' ? () => dummy : k === 'textContent' || k === 'value' || k === 'checked' ? t[k] : t[k]), set: (t, k, v) => { t[k] = v; return true; } });
  const sh = { classList: { contains: () => true }, querySelector: (s) => (s === '#vs-loudness' ? sel('vs-loudness') : s === '#vs-loudness-bt' ? sel('vs-loudness-bt') : s === '#vs-interrupt' ? null : dummy), querySelectorAll: () => [] };
  const fn = new Function('$', 'voicePrefsNow', 'voiceEndPauseNow', 'voiceSpeedNow', 'voiceSpeedLabel', 'document', 'CallDisplay', 'voiceOn', 'voiceStatus', 'VOICE_CALL_HELP', 'voiceLoudnessFor',
    paintSrc + '\nreturn paintVoiceSheet;')((id) => (id === 'voice-sheet' ? sh : null), () => prefs, () => 1200, () => 1, () => '1x', { activeElement: null }, undefined, () => true, {}, '', (p, k) => voiceLoudnessForReal(p, k));
  fn();
  return els;
}
const VOICE_LOUDNESS = V.VOICE_LOUDNESS;
const voiceLoudnessForReal = new Function('VOICE_LOUDNESS', 'VOICE_DEFAULT_PREFS', forFn + '\nreturn voiceLoudnessFor;')(VOICE_LOUDNESS, { loudness: 'louder', loudnessBt: 'normal' });

test('the sheet shows the prefs: defaults Louder (speaker) and Normal (Bluetooth / car), then what was saved', () => {
  let els = paint({ loudness: 'louder', loudnessBt: 'normal' });
  assert.strictEqual(els['vs-loudness'].value, 'louder');
  assert.strictEqual(els['vs-loudness-bt'].value, 'normal');
  els = paint({ loudness: 'loudest', loudnessBt: 'louder' });
  assert.strictEqual(els['vs-loudness'].value, 'loudest');
  assert.strictEqual(els['vs-loudness-bt'].value, 'louder');
});

test('the sheet selects and #voice-panel selects both go through voiceLoudnessSave', () => {
  assert.ok(sheetSrc.includes("sh.querySelector('#vs-loudness').addEventListener('change', (e) => voiceLoudnessSave('loudness', e.target.value));"));
  assert.ok(sheetSrc.includes("sh.querySelector('#vs-loudness-bt').addEventListener('change', (e) => voiceLoudnessSave('loudnessBt', e.target.value));"));
  assert.ok(mob.includes("$('vp-loudness')?.addEventListener('change', (e) => voiceLoudnessSave('loudness', e.target.value));"));
  assert.ok(mob.includes("$('vp-loudness-bt')?.addEventListener('change', (e) => voiceLoudnessSave('loudnessBt', e.target.value));"));
  assert.ok(!sheetSrc.includes('loudnessBt: Object.prototype'), 'no second copy of the validation');
});

test('voiceLoudnessSave saves prefs.loudness / prefs.loudnessBt, applies to a running call and repaints both UIs', () => {
  const calls = [];
  const save = new Function('VOICE_LOUDNESS', 'voicePrefsSave', 'voiceCallApplyPrefs', 'voiceMicPaint', 'voicePanelPaint', 'paintVoiceSheet', saveSrc + '\nreturn voiceLoudnessSave;')(
    VOICE_LOUDNESS, (p) => calls.push(['save', p]), () => calls.push(['apply']), () => calls.push(['mic']), () => calls.push(['panel']), () => calls.push(['sheet']));
  save('loudness', 'loudest');
  assert.deepStrictEqual(calls, [['save', { loudness: 'loudest' }], ['apply'], ['mic'], ['panel'], ['sheet']]);
  calls.length = 0; save('loudnessBt', 'louder');
  assert.deepStrictEqual(calls[0], ['save', { loudnessBt: 'louder' }]);
  assert.deepStrictEqual(calls.slice(1).map((c) => c[0]), ['apply', 'mic', 'panel', 'sheet']);
  // junk falls back to each kind's default
  calls.length = 0; save('loudness', 'LOUD'); assert.deepStrictEqual(calls[0], ['save', { loudness: 'louder' }]);
  calls.length = 0; save('loudnessBt', '__proto__'); assert.deepStrictEqual(calls[0], ['save', { loudnessBt: 'normal' }]);
});

test('paintVoiceSheet fills the loudness selects from the prefs (kept in step with #voice-panel)', () => {
  assert.ok(paintSrc.includes("['vs-loudness', 'speaker']") && paintSrc.includes("['vs-loudness-bt', 'bluetooth']"));
  assert.ok(paintSrc.includes('voiceLoudnessFor(p, kind)'));
});
