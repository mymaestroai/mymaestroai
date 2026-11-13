'use strict';
// Voice fixes 1 (2026-11-12), page wiring (source-level): the voice speed goes on every TTS request and the device voice,
// the 'Pause before I'm done' and 'Voice speed' controls exist in desktop Settings, the desktop call bar and the phone
// Voice sheet, every spoken string goes through voiceSpeechText, and tool activity is shown silently.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js'), mob = read('mobile.js'), idx = read('index.html'), mhtml = read('mobile.html');
const between = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, a + ' .. ' + b); return src.slice(i, j); };
const count = (src, s) => src.split(s).length - 1;

test('every TTS request of both pages carries the voice speed', () => {
  assert.strictEqual(count(app, "'/api/voice/tts'"), 1, 'one TTS request function on the desktop');
  assert.match(app, /const body = \{ agent, text, speed: voiceSpeedNow\(\) \};/);
  assert.strictEqual(count(mob, "'/api/voice/tts'"), 1, 'one TTS request function on the phone');
  assert.match(mob, /JSON\.stringify\(\{ agent, text, speed: voiceSpeedNow\(\) \}\)/);
  assert.match(app, /voiceSpeedNow\(\) \{ const v = voicePrefsNow\(\)\.voiceSpeed; return voiceCleanSpeed\(v == null \? 1 : v\); \}/);
  assert.match(mob, /function voiceSpeedNow\(\) \{ const v = voicePrefsNow\(\)\.voiceSpeed; return voiceCleanSpeed\(v == null \? 1 : v\); \}/);
});

test('the device voice speaks at the voice speed (utterance.rate)', () => {
  assert.match(app, /u\.voice = voice; u\.lang = voice\.lang; u\.rate = voiceSpeedNow\(\);/);
  assert.match(mob, /u\.voice = voice; u\.lang = voice\.lang; u\.rate = voiceSpeedNow\(\);/);
});

test('every spoken string goes through voiceSpeechText: call lines, read-aloud, sample, announcements', () => {
  assert.match(app, /const sentences = voiceSentences\(voiceSpeechText\(String\(text \|\| ''\)\)\)\.filter\(Boolean\);/, 'desktop call lines');
  assert.match(app, /opts\.sentences \? opts\.sentences\.map\(s => voiceSpeechText\(s\)\)\.filter\(Boolean\) : voiceSentences\(voiceSpeechText\(md\)\)/, 'desktop read-aloud and the sample');
  assert.match(mob, /async function voiceCallSpeak\(agent, rawText\) \{\n  const text = voiceSpeechText\(String\(rawText \|\| ''\)\);/, 'phone call lines');
  assert.match(mob, /sentences = voiceSentences\(voiceSpeechText\(markdown\)\) \|\| \[\]/, 'phone read-aloud and the sample');
});

test('desktop Settings, Voices: pause, speed (with the hint) and spoken activity; saved with the other prefs', () => {
  const s = between(app, 'function voiceSettingsHtml(data)', 'function voicePaintSettings');
  assert.ok(s.includes("Pause before I\\'m done"));
  assert.match(s, /voicePauseSelectHtml\('st-voice-pause', 'onchange="voiceSettingsSavePrefs\(\)"'\)/);
  assert.match(s, /id="st-voice-speed" value="\$\{voiceSpeedNow\(\)\}" oninput="voiceSettingSpeedInput\(this\)"/);
  assert.ok(s.includes('min="0.75" max="1.5" step="0.05"'));
  assert.ok(s.includes('${voiceSpeedLabel(voiceSpeedNow())}'), 'shows 1.10x');
  assert.ok(s.includes('${VOICE_SPEED_HINT}'));
  assert.ok(app.includes("const VOICE_SPEED_HINT = 'Google voices ignore this setting.';"));
  assert.ok(s.includes('Say what the agent is doing'));
  const save = between(app, 'function voiceSettingsSavePrefs()', 'function voiceTestStop()');
  assert.match(save, /endPause: Number\(pause\.value\), voiceSpeed: voiceCleanSpeed\(speed\.value\), speakActivity: act\.checked/);
  assert.match(save, /voiceCallS\.vad\.setEndPause\(prefs\.endPause\)/, 'a call that is up takes the new pause at once');
});

test('desktop call bar: pause select and speed slider, no spoken-activity switch, a silent activity line', () => {
  const bar = between(app, 'function voiceCallBarHtml(chatId)', 'function voiceCallShowBar(chatId)');
  assert.ok(bar.includes("Pause before I'm done"));
  assert.ok(bar.includes(`voicePauseSelectHtml(id('pause'), 'data-vcb="pause"')`));
  assert.ok(bar.includes('data-vcb="speed"') && bar.includes('min="0.75" max="1.5" step="0.05"'));
  assert.ok(bar.includes('${VOICE_SPEED_HINT}'));
  assert.ok(bar.includes(`id="\${id('activity')}"`) && bar.includes('class="vcb-activity"'));
  assert.ok(!bar.includes('Say what the agent is doing'));
  const slider = between(app, 'function voiceCallSlider(', 'function voiceSettingSensInput');
  assert.match(slider, /which === 'pause'\) vad\.setEndPause\(v\)/);
  assert.match(slider, /speed: 'voiceSpeed', pause: 'endPause'/);
  assert.match(app, /activity: \(text\) => \{ const a = barEl\('activity'\); if \(a\) a\.textContent = text \|\| ''; \}/);
  assert.match(app, /speakActivity: \(\) => !!voicePrefsNow\(\)\.speakActivity/);
  assert.match(app, /interruptSensitivity: voiceSensNow\(\), endPause: voiceEndPauseNow\(\) \}\)/);
  assert.match(idx, /\.voice-callbar \.vcb-activity \{/);
});

test('phone Voice sheet: pause select, speed slider with the hint, spoken activity switch; the call panel shows activity', () => {
  const sheet = between(mob, 'function voiceSheet()', 'function paintVoiceSheet()');
  assert.ok(sheet.includes('Pause before I&#39;m done'));
  assert.ok(sheet.includes("VOICE_END_PAUSES.map((ms, i) => '<option value=\"' + ms + '\">' + ['Short', 'Normal', 'Long'][i] + '</option>')"));
  assert.ok(sheet.includes('id="vs-speed" class="vs-level vs-speed" min="0.75" max="1.5" step="0.05"'));
  assert.ok(sheet.includes("VOICE_SPEED_HINT"));
  assert.ok(mob.includes("const VOICE_SPEED_HINT = 'Google voices ignore this setting.';"));
  assert.ok(sheet.includes('Say what the agent is doing'));
  assert.match(sheet, /voicePrefsSave\(\{ endPause: Number\(pause\.value\) \}\); if \(voiceCall\) voiceCall\.vad\.setEndPause\(Number\(pause\.value\)\)/);
  assert.match(sheet, /voicePrefsSave\(\{ voiceSpeed: voiceCleanSpeed\(speed\.value\) \}\)/);
  assert.match(sheet, /voicePrefsSave\(\{ speakActivity: !!e\.target\.checked \}\)/);
  assert.ok(sheet.includes("voiceSpeedLabel(speed.value)"), 'shows 1.10x');
  assert.match(mob, /interruptSensitivity: prefs\.interruptSensitivity, endPause: voiceEndPauseNow\(\) \}\)/);
  assert.match(mob, /speakActivity: \(\) => !!voicePrefsNow\(\)\.speakActivity/);
  assert.match(mob, /activity: \(text\) => \{ const a = \$\('cp-activity'\); if \(a && voiceCall === vc\) a\.textContent = text \|\| ''; \}/);
  assert.match(mhtml, /<div id="cp-activity" aria-live="off"><\/div>/);
  assert.match(mhtml, /#cp-activity \{/);
});

test('the pause and speed are saved per device, with the other voice prefs, on both pages', () => {
  assert.match(mob, /function voicePrefsSave\(patch\) \{ const p = \{ \.\.\.voicePrefsNow\(\), \.\.\.patch \}; try \{ voiceSavePrefs\(localStorage, p\)/);
  assert.match(app, /voiceSavePrefs\(localStorage, prefs\); voicePrefsCache = prefs;/);
});
