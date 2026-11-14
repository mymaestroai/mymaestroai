'use strict';
// Part 6: agent-level voice defaults and the "Patient listener" preset: the pure helpers in lib/ui-voice.js
// (voiceCleanAgentDefaults, voiceMarkChosen, voiceEffectivePrefs, the `chosen` pref), and the page wiring (source-level).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const V = require('../lib/ui-voice');
const { voiceCleanAgentDefaults, voiceEffectivePrefs, voiceMarkChosen, voiceCleanPrefs, VOICE_DEFAULT_PREFS, VOICE_PRESETS, VOICE_AGENT_DEFAULT_KEYS } = V;

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const PATIENT = { endPause: 4000, continueWait: 8000, interruptSensitivity: 30, voiceSpeed: 0.9 };

test('the lists gain the very long choices; the defaults and the preset are as specified', () => {
  assert.deepStrictEqual(V.VOICE_END_PAUSES, [800, 1200, 2000, 4000]);
  assert.deepStrictEqual(V.VOICE_CONTINUE_WAITS, [1500, 3000, 5000, 8000]);
  assert.deepStrictEqual(VOICE_AGENT_DEFAULT_KEYS, ['endPause', 'continueWait', 'interruptSensitivity', 'voiceSpeed']);
  assert.deepStrictEqual(VOICE_PRESETS, { patient: PATIENT });
  assert.strictEqual(VOICE_DEFAULT_PREFS.endPause, 1200);
  assert.strictEqual(VOICE_DEFAULT_PREFS.continueWait, 3000);
  assert.strictEqual(VOICE_DEFAULT_PREFS.interruptSensitivity, 50);
  assert.strictEqual(VOICE_DEFAULT_PREFS.voiceSpeed, 1);
});

test('voiceCleanAgentDefaults: the preset fills the four keys', () => {
  assert.deepStrictEqual(voiceCleanAgentDefaults({ preset: 'patient' }), { preset: 'patient', ...PATIENT });
  // a key the raw object gives wins over the preset's; the others are filled
  assert.deepStrictEqual(voiceCleanAgentDefaults({ preset: 'patient', endPause: 2000 }), { preset: 'patient', ...PATIENT, endPause: 2000 });
  // a bad value never cancels the preset's value for that key
  assert.deepStrictEqual(voiceCleanAgentDefaults({ preset: 'patient', endPause: 1500, voiceSpeed: 'slow' }), { preset: 'patient', ...PATIENT });
});

test('voiceCleanAgentDefaults: valid keys are kept, invalid values dropped, numbers clamped', () => {
  assert.deepStrictEqual(voiceCleanAgentDefaults({ endPause: 800, continueWait: 5000, interruptSensitivity: 70, voiceSpeed: 1.25 }),
    { endPause: 800, continueWait: 5000, interruptSensitivity: 70, voiceSpeed: 1.25 });
  assert.deepStrictEqual(voiceCleanAgentDefaults({ endPause: 1500, continueWait: '3000', interruptSensitivity: 'high', voiceSpeed: NaN, extra: 1 }), {});
  assert.deepStrictEqual(voiceCleanAgentDefaults({ interruptSensitivity: 250 }), { interruptSensitivity: 100 });
  assert.deepStrictEqual(voiceCleanAgentDefaults({ interruptSensitivity: -4 }), { interruptSensitivity: 0 });
  assert.deepStrictEqual(voiceCleanAgentDefaults({ voiceSpeed: 9 }), { voiceSpeed: 1.5 });
  assert.deepStrictEqual(voiceCleanAgentDefaults({ voiceSpeed: 0.91 }), { voiceSpeed: 0.9 });
  assert.deepStrictEqual(voiceCleanAgentDefaults({ preset: 'nope', endPause: 4000 }), { endPause: 4000 }, 'an unknown preset name is ignored');
  assert.deepStrictEqual(voiceCleanAgentDefaults({ preset: 'toString' }), {}, 'a name from the prototype is not a preset');
});

test('voiceCleanAgentDefaults: junk gives {}', () => {
  for (const j of [null, undefined, 0, 1, 'patient', true, [], [PATIENT], () => 1, {}]) assert.deepStrictEqual(voiceCleanAgentDefaults(j), {}, String(j));
});

test('voiceEffectivePrefs: with no agent defaults the prefs come back unchanged', () => {
  const prefs = voiceCleanPrefs({ endPause: 2000, mode: 'tap', chosen: ['endPause'] });
  for (const d of [undefined, null, {}, 'x', []]) {
    const out = voiceEffectivePrefs(prefs, d);
    assert.deepStrictEqual(out, prefs);
    assert.notStrictEqual(out, prefs, 'a copy');
  }
  assert.deepStrictEqual(voiceEffectivePrefs(voiceCleanPrefs(null), null), voiceCleanPrefs(null));
});

test('voiceEffectivePrefs: the patient preset applies on fresh prefs', () => {
  const fresh = voiceCleanPrefs(null);
  const out = voiceEffectivePrefs(fresh, { preset: 'patient' });
  for (const k of VOICE_AGENT_DEFAULT_KEYS) assert.strictEqual(out[k], PATIENT[k], k);
  assert.strictEqual(out.micLevel, fresh.micLevel, 'other prefs are the device\'s');
  assert.strictEqual(fresh.endPause, 1200, 'the input is not changed');
  // the cleaned agent record (preset plus its four values) gives the same
  assert.deepStrictEqual(voiceEffectivePrefs(fresh, voiceCleanAgentDefaults({ preset: 'patient' })), out);
});

test('voiceEffectivePrefs: a key in chosen keeps the device value, even when it equals the factory default', () => {
  const prefs = voiceMarkChosen(voiceCleanPrefs(null), ['endPause']);   // the person set it, and it is the factory value
  const out = voiceEffectivePrefs(prefs, { preset: 'patient' });
  assert.strictEqual(out.endPause, 1200);
  assert.strictEqual(out.continueWait, 8000, 'the keys not chosen still follow the agent');
  assert.strictEqual(out.voiceSpeed, 0.9);
});

test('voiceEffectivePrefs: a saved value that differs from the factory default counts as chosen', () => {
  const prefs = voiceCleanPrefs({ interruptSensitivity: 80, endPause: 800 });   // saved before this change, by a person who changed it
  const out = voiceEffectivePrefs(prefs, { preset: 'patient' });
  assert.strictEqual(out.interruptSensitivity, 80);
  assert.strictEqual(out.endPause, 800);
  assert.strictEqual(out.continueWait, 8000);
});

test('voiceEffectivePrefs: voiceSpeed 0.9 applies; a key the agent does not give stays the device\'s', () => {
  assert.strictEqual(voiceEffectivePrefs(voiceCleanPrefs(null), { voiceSpeed: 0.9 }).voiceSpeed, 0.9);
  const out = voiceEffectivePrefs(voiceCleanPrefs(null), { voiceSpeed: 0.9 });
  assert.strictEqual(out.endPause, 1200);
  assert.strictEqual(out.continueWait, 3000);
  assert.strictEqual(out.interruptSensitivity, 50);
});

test('voiceMarkChosen adds the keys, once each, known keys only, without changing the input', () => {
  const p = voiceCleanPrefs(null);
  const a = voiceMarkChosen(p, ['voiceSpeed', 'endPause', 'micLevel']);
  assert.deepStrictEqual(a.chosen, ['endPause', 'voiceSpeed']);
  assert.ok(!('chosen' in p));
  const b = voiceMarkChosen(a, ['voiceSpeed', 'continueWait']);
  assert.deepStrictEqual(b.chosen, ['endPause', 'continueWait', 'voiceSpeed']);
  assert.deepStrictEqual(voiceMarkChosen(p, []).chosen, []);
});

test('voiceCleanPrefs keeps a valid chosen and filters junk out of it', () => {
  assert.deepStrictEqual(voiceCleanPrefs({ chosen: ['voiceSpeed', 'endPause'] }).chosen, ['endPause', 'voiceSpeed']);
  assert.deepStrictEqual(voiceCleanPrefs({ chosen: ['endPause', 'endPause', 'micLevel', 7, null, '__proto__', 'voiceSpeed'] }).chosen, ['endPause', 'voiceSpeed']);
  assert.deepStrictEqual(voiceCleanPrefs({ chosen: [] }).chosen, []);
  for (const j of ['endPause', 5, {}, null, true]) assert.ok(!('chosen' in voiceCleanPrefs({ chosen: j })), 'not an array: no chosen');
});

test('voiceCleanPrefs(null) deep-equals VOICE_DEFAULT_PREFS: nothing new by default', () => {
  assert.deepStrictEqual(voiceCleanPrefs(null), VOICE_DEFAULT_PREFS);
  assert.deepStrictEqual(voiceCleanPrefs({}), VOICE_DEFAULT_PREFS);
  assert.ok(!('chosen' in VOICE_DEFAULT_PREFS));
});

test('endPause 4000 and continueWait 8000 survive voiceCleanPrefs (and a save and load)', () => {
  const p = voiceCleanPrefs({ endPause: 4000, continueWait: 8000 });
  assert.strictEqual(p.endPause, 4000);
  assert.strictEqual(p.continueWait, 8000);
  const mem = {}; const storage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };
  V.voiceSavePrefs(storage, voiceMarkChosen({ endPause: 4000, continueWait: 8000 }, ['endPause']));
  const back = V.voiceLoadPrefs(storage);
  assert.deepStrictEqual([back.endPause, back.continueWait, back.chosen], [4000, 8000, ['endPause']]);
});

// ── the pages (source level, like the other page checks) ──
const app = read('app.js'), mob = read('mobile.js');

test('both pages carry the shared voice block with the new helpers (sync check lives in test/ui-voice.test.js)', () => {
  for (const [n, src] of [['app.js', app], ['mobile.js', mob]]) {
    assert.ok(src.includes('function voiceEffectivePrefs('), n);
    assert.ok(src.includes('function voiceMarkChosen('), n);
    assert.ok(src.includes('function voiceCleanAgentDefaults('), n);
    assert.ok(src.includes('const VOICE_END_PAUSES = [800, 1200, 2000, 4000];'), n);
    assert.ok(src.includes('const VOICE_CONTINUE_WAITS = [1500, 3000, 5000, 8000];'), n);
  }
});

test('desktop: every place the person changes one of the four settings marks it chosen', () => {
  const slice = (a, b) => { const i = app.indexOf(a), j = app.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, a); return app.slice(i, j); };
  // the Settings, Voices controls say which one changed; the save marks only that key
  const html = slice('function voiceSettingsHtml(data)', 'function voicePaintSettings');
  assert.ok(html.includes("voiceSettingsSavePrefs('interruptSensitivity')"));
  assert.ok(html.includes("voiceSettingsSavePrefs(\\'endPause\\')"));
  assert.ok(html.includes("voiceSettingsSavePrefs('voiceSpeed')"));
  const save = slice('function voiceSettingsSavePrefs(changed)', 'function voiceTestStop()');
  assert.match(save, /voiceMarkChosen\(prefs, \[changed\]\)/);
  // the in-call sliders, the chat's voice panel, the room check and the car check
  assert.match(slice('function voiceCallSlider(', 'function voiceSettingSensInput'), /voiceMarkChosen\(prefs, \[key\]\)/);
  assert.match(slice('function voiceCtlSet(', 'document.addEventListener(\'click\', (e) => { if (!(e.target.closest'), /voiceMarkChosen\(voicePrefsCache, \[key\]\)/);
  assert.match(slice('async function voiceRoomCheckRun()', 'async function voiceCarCheckRun()'), /voiceMarkChosen\(prefs, \['interruptSensitivity'\]\)/);
  assert.match(slice('async function voiceCarCheckRun()', '// Message rendering'), /voiceMarkChosen\(prefs, \['interruptSensitivity'\]\)/);
});

test('desktop: a call, the push-to-talk and VAD paths and the speech use the agent\'s effective prefs', () => {
  assert.match(app, /function voiceEffNow\(agent\) \{ return voiceEffectivePrefs\(voicePrefsNow\(\), voiceAgentDefaultsOf\(agent\)\); \}/);
  assert.match(app, /prefs: \(\) => voiceEffNow\(agent\),/, 'the call controller\'s prefs() dependency');
  assert.match(app, /const eff = voiceEffNow\(chat\.agent\);[^\n]*\n\s*const vad = voiceCreateVad\(\{[^}]*interruptSensitivity: eff\.interruptSensitivity, endPause: eff\.endPause/, 'the VAD options');
  assert.match(app, /const body = \{ agent, text, speed: voiceSpeedFor\(agent\) \};/, 'the speed sent with /api/voice/tts');
  assert.match(app, /u\.rate = voiceSpeedFor\(agent\)/, 'the device voice');
  assert.match(app, /Following \$\{hubEsc\(name\)\}'s default: \$\{label\}/, 'the plain line under a control');
  assert.match(app, /voiceFollowLine\(agent, 'endPause'\)/);
  assert.match(app, /voiceFollowLine\(agent, 'continueWait'\)/);
  assert.match(app, /voiceFollowLine\(agent, 'interruptSensitivity'\)/);
  assert.match(app, /voiceFollowLine\(agent, 'voiceSpeed'\)/);
});

test('phone: the person\'s changes are marked chosen, and a call, its VAD and its speech use the agent\'s effective prefs', () => {
  assert.match(mob, /function voicePrefsSave\(patch\) \{[\s\S]*?voiceMarkChosen\(p, changed\)[\s\S]*?voiceSavePrefs\(localStorage, p\)/);
  assert.match(mob, /function voiceEffNow\(agent\) \{ return voiceEffectivePrefs\(voicePrefsNow\(\), voiceAgentDefaultsOf\(agent\)\); \}/);
  assert.match(mob, /prefs: \(\) => voiceEffNow\(agent\),/, 'the call controller\'s prefs() dependency');
  assert.match(mob, /const prefs = voiceEffNow\(agent\);[^\n]*\n\s*voiceEndedBar\(false\)/, 'the call start');
  assert.match(mob, /interruptSensitivity: prefs\.interruptSensitivity, endPause: prefs\.endPause/, 'the VAD options');
  assert.match(mob, /const p = voiceEffNow\(vc\.agent\)/, 'settings applied live to a call');
  assert.match(mob, /speed: voiceSpeedFor\(agent\)/, 'the speed sent with /api/voice/tts');
  assert.match(mob, /u\.rate = voiceSpeedFor\(agent\)/, 'the device voice');
  assert.match(mob, /Following \$\{displayName\(current\)\}'s default:/, 'the plain line under a control');
  const html = read('mobile.html');
  for (const k of VOICE_AGENT_DEFAULT_KEYS) assert.ok(html.includes(`id="vp-follow-${k}"`), k);
});

test('the choices "Very long (4 s)" and "Very long (8 s)" are offered on both pages', () => {
  assert.ok(app.includes("'Very long (4 s)'") && app.includes("'Very long (8 s)'"), 'desktop');
  assert.ok(mob.includes("'Very long (4 s)'") && mob.includes("'Very long (8 s)'"), 'phone');
});

test('agent settings page: the Voice defaults row, its three choices, the custom controls and the sentence', () => {
  const page = read('agent-settings.html');
  assert.ok(page.includes('id="voice-defaults"'));
  for (const s of ['>None<', 'Patient listener (waits 4 s before replying, 8 s for you to go on, harder to interrupt, speaks a little slower)', '>Custom<',
    'id="vd-pause"', 'id="vd-wait"', 'id="vd-sens"', 'id="vd-speed"', 'Very long (4 s)', 'Very long (8 s)',
    'Devices follow these unless the person changed that setting on that device.']) assert.ok(page.includes(s), s);
  assert.match(page, /body: JSON\.stringify\(\{ voiceDefaults: body \}\)/, 'saved through the existing PATCH');
  assert.match(page, /\['saveVoiceDefaults', 'voice-defaults-status'/);
});
