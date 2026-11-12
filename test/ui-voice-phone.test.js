'use strict';
// Voice on the phone page (phase 1): the mic button, tap-to-talk, read aloud, the Voice sheet, wired as designed.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const js = read('mobile.js');
const html = read('mobile.html');

test('mic button sits before Send, hidden until the hub says voice is enabled and ready, acts on the touch', () => {
  assert.match(html, /id="mic-btn"[^>]*hidden/);
  assert.ok(html.indexOf('id="mic-btn"') < html.indexOf('id="send-btn"'), 'before Send');
  assert.ok(html.indexOf('id="mic-btn"') > html.indexOf('id="camera-btn"') && html.indexOf('id="mic-btn"') < html.indexOf('id="msg-input"'), 'left of the box: notify-done test pins the bell right before Send');
  assert.match(js, /onComposerTap\(\$\('mic-btn'\), voiceMicTap\)/);
  assert.match(js, /api\('\/api\/voice\/status'\)/);
  assert.match(js, /b\.hidden = !voiceOn\(\)/);
  assert.match(js, /voiceStatus\.enabled && voiceStatus\.ready/);
  assert.match(js, /setInterval\(\(\) => \{ if \(!document\.hidden && current\) voiceStatusRefresh\(\); \}, 60000\)/, 'every 60 s while visible');
  assert.match(js, /localStorage\.setItem\('hub-mobile-last', name\);\n\s*voiceStatusRefresh\(\)/, 'on chat open');
});

test('mic tap: keepKeyboard.elsewhere first, getUserMedia with the three processing flags, gain from the slider', () => {
  const tap = js.slice(js.indexOf('async function voiceMicTap()'), js.indexOf('async function voiceMicStop()'));
  assert.match(tap, /keepKeyboard && keepKeyboard\.elsewhere\(\)/);
  assert.match(js, /getUserMedia\(\{ audio: \{ echoCancellation: true, noiseSuppression: true, autoGainControl: true \} \}\)/);
  const open = js.slice(js.indexOf('async function voiceMicOpen'), js.indexOf('function voiceMeterPaint'));
  assert.ok(open.indexOf('new AC()') < open.indexOf('await navigator.mediaDevices.getUserMedia'), 'AudioContext is made inside the tap, before the permission await');
  assert.match(open, /ctx\.resume\(\)/);
  assert.match(open, /createGain\(\)/);
  assert.match(open, /gain\.gain\.value = voiceGainFromSlider\(gainValue\)/);
  assert.match(open, /createScriptProcessor\(4096, 1, 1\)/);
  assert.match(open, /t\.stop\(\)/, 'tracks released');
  assert.match(open, /ctx\.close\(\)/);
});

test('mic stop: 60 s cap, resample to 16 kHz, WAV, POST /api/voice/stt?agent=, text appended without focusing the box', () => {
  assert.match(js, /VOICE_MAX_SECONDS = 60/);
  const stop = js.slice(js.indexOf('async function voiceMicStop()'), js.indexOf('function voiceInsert'));
  assert.match(stop, /voiceEncodeWav\(voiceResample\(all, rate, 16000\), 16000\)/);
  assert.match(stop, /type: 'audio\/wav'/);
  assert.match(stop, /api\(`\/api\/voice\/stt\?agent=\$\{encodeURIComponent\(agent\)\}`, \{ method: 'POST', headers: \{ 'Content-Type': 'audio\/wav' \}/);
  assert.match(stop, /r\.status === 409/);
  assert.ok(stop.indexOf('handle.close()') < stop.indexOf("api(`/api/voice/stt"), 'mic released before the upload');
  assert.match(stop, /toast\(/, 'errors are a toast');
  const ins = js.slice(js.indexOf('function voiceInsert'), js.indexOf('// ── Read aloud ──'));
  assert.ok(!/\.focus\(/.test(ins), 'no keyboard');
  assert.match(ins, /input\.value = join\(input\.value\)/);
  assert.match(ins, /voiceDictatedFor = agent/);
});

test('level bar above the composer row and the recording state', () => {
  assert.ok(html.indexOf('id="voice-level"') < html.indexOf('<div class="row">'), 'above the row');
  assert.match(html, /#mic-btn\.rec \{[^}]*var\(--error/);
  assert.match(html, /#voice-level i \{/);
  assert.match(js, /voiceMeterPercent\(voiceLevelDb\(f32\)\)/);
  assert.match(js, /\$\{Math\.floor\(\(Date\.now\(\) - voiceRec\.t0\) \/ 1000\)\}s/, 'elapsed seconds on the button');
});

test('read aloud: speaker on assistant bubbles, sentence by sentence TTS with prefetch, one at a time, stop with the turn', () => {
  assert.match(js, /addSpeakButton\(el\)/);
  assert.match(js, /b\.className = 'speak'/);
  assert.match(js, /const sp = e\.target\.closest\('\.speak'\)/);
  assert.match(js, /voiceSentences\(voiceSpeechText\(markdown\)\)/);
  assert.match(js, /api\('\/api\/voice\/tts', \{ method: 'POST', headers: \{ 'Content-Type': 'application\/json' \}, body: JSON\.stringify\(\{ agent, text \}\) \}\)/);
  assert.match(js, /next = i \+ 1 < sentences\.length \? voiceTtsBlob\(agent, sentences\[i \+ 1\]\) : null/, 'next sentence is fetched while this one plays');
  assert.match(js, /function voiceStopPlayback\(\) \{\n\s*voicePlay\.token\+\+/);
  assert.match(js, /function voiceSpeak\(markdown, agent, el\) \{\n\s*voiceStopPlayback\(\)|async function voiceSpeak\(markdown, agent, el\) \{\n\s*voiceStopPlayback\(\)/, 'a new playback stops the old one');
  assert.match(js, /if \(voicePlay\.el === msgEl\) \{ voiceStopPlayback\(\); return; \}/, 'tap again stops');
  const stopTurn = js.slice(js.indexOf('function stopTurn(agent)'), js.indexOf('function markUnread'));
  assert.match(stopTurn, /voiceStopPlayback\(\)/);
  assert.match(html, /\.msg \.speak \{/);
});

test('device voice fallback via speechSynthesis, gated by deviceVoiceFallback', () => {
  assert.match(js, /new SpeechSynthesisUtterance\(s\)/);
  assert.match(js, /synth\.speak\(u\)/);
  assert.match(js, /window\.speechSynthesis\.cancel\(\)/);
  assert.match(js, /const fallback = voicePrefsNow\(\)\.deviceVoiceFallback/);
  assert.match(js, /if \(fallback && await voiceDeviceSpeak\(rest, my\)\)/);
  assert.match(js, /if \(!voiceOn\(\)\) return null;/, 'voice off: no hub call, the phone voice or a plain toast');
});

test('automatic read when the reply ends, only for a message dictated here and with Read replies aloud on', () => {
  assert.match(js, /dictated: !fallback && voiceTakeDictated\(agent\)/);
  assert.match(js, /try \{ voiceAutoRead\(rec\); \}/);
  assert.match(js, /if \(!rec \|\| !rec\.dictated \|\| !rec\.full \|\| !voicePrefsNow\(\)\.readAloud/);
});

test('Voice menu item and sheet: dialogGuard, level slider, meter, test toggle, switches, sample, prefs saved', () => {
  assert.match(html, /<button id="menu-voice">/);
  assert.match(js, /\$\('menu-voice'\)\?\.addEventListener\('click', openVoiceSheet\)/);
  const sheet = js.slice(js.indexOf('function voiceSheet()'), js.indexOf('function openVoiceSheet'));
  for (const s of ['class="vs-level"', 'min="0" max="100"', 'vs-meter', 'Test mic', 'Read replies aloud', 'Use the phone&#39;s own voice when the hub voice is unavailable', 'Play sample', 'rsn-sheet voice-sheet']) assert.ok(sheet.includes(s), s);
  assert.match(sheet, /voicePrefsSave\(\{ micLevel: Number\(level\.value\) \}\)/);
  assert.match(sheet, /voicePrefsSave\(\{ readAloud: /);
  assert.match(sheet, /voicePrefsSave\(\{ deviceVoiceFallback: /);
  assert.match(js, /voiceSavePrefs\(localStorage, p\)/);
  assert.match(js, /voiceLoadPrefs\(localStorage\)/);
  assert.match(js, /dialogGuard\.open\(sh, \{ close: sh\.closeSheet \}\); \}\n\s*paintVoiceSheet/);
  assert.match(sheet, /dialogGuard\.closed\(sh\)/);
  assert.match(sheet, /voiceTestStop\(\); voiceStopPlayback\(\);/, 'closing releases the mic and stops the sample');
  assert.match(js, /Voice is not enabled on the hub\. An admin turns it on in Settings on the computer\./);
  assert.match(js, /voiceTest\.handle = await voiceMicOpen\(/, 'meter opens the mic only through the test toggle');
});

test('no U+FE0F in the voice code or markup', () => {
  const a = js.slice(js.indexOf('// ── Voice (phase 1)'), js.indexOf('// The message box keeps a draft per agent'));
  assert.ok(!a.includes('\uFE0F'));
  assert.ok(!/id="mic-btn"[^\n]*\uFE0F/.test(html) && !/id="menu-voice"[^\n]*(\uFE0F|&#xFE0F;)/i.test(html));
});

test('service worker cache is v65', () => {
  assert.match(read('sw.js'), /const VERSION = 'hub-mobile-v65'/);
});
