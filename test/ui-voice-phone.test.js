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
  // changed on purpose (one calm bottom row: + , box, mic, Send): the mic is now right of the box, just before Send
  assert.ok(html.indexOf('id="mic-btn"') > html.indexOf('id="msg-input"') && html.indexOf('id="mic-btn"') < html.indexOf('id="send-btn"'), 'right of the box, before Send');
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
  assert.match(js, /api\('\/api\/voice\/tts', \{ method: 'POST', headers: \{ 'Content-Type': 'application\/json' \}, body: JSON\.stringify\(\{ agent, text, speed: voiceSpeedFor\(agent\) }\) \}\)/);   // + the voice speed on every request (voice fixes 1)
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
  assert.match(js, /if \(fallback && await voiceDeviceSpeak\(rest, my, agent\)\)/);
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
  for (const s of ['class="vs-level"', 'min="0" max="100"', 'vs-meter', 'Test mic', 'Read replies aloud', 'Use this device&#39;s own offline voice when the hub voice is unavailable', 'Play sample', 'rsn-sheet voice-sheet']) assert.ok(sheet.includes(s), s);
  assert.match(sheet, /voicePrefsSave\(\{ micLevel: Number\(level\.value\) \}\)/);
  assert.match(sheet, /voicePrefsSave\(\{ readAloud: /);
  assert.match(sheet, /voicePrefsSave\(\{ deviceVoiceFallback: /);
  assert.match(js, /voiceSavePrefs\(localStorage, p\)/);
  assert.match(js, /voiceLoadPrefs\(localStorage\)/);
  assert.match(js, /dialogGuard\.open\(sh, \{ close: sh\.closeSheet \}\); \}\n\s*paintVoiceSheet/);
  assert.match(sheet, /dialogGuard\.closed\(sh\)/);
  assert.match(sheet, /voiceTestStop\(\); voiceStopPlayback\(\);/, 'closing releases the mic and stops the sample');
  assert.match(js, /Voice is not enabled on the hub\. An admin turns it on in Settings on the computer\./);
  assert.match(js, /handle = await voiceMicOpen\(voicePrefsNow\(\)\.micLevel, \(f\) => \{ m\.style\.width/, 'meter opens the mic only through the test toggle');
});

const L = require('../lib/ui-voice');
const sliceBetween = (a, b) => { const i = js.indexOf(a), j = js.indexOf(b, i); assert.ok(i > 0 && j > i, a); return js.slice(i, j); };

test('device voice is offline only: the utterance gets a localService voice, no voice means no speech and a toast', async () => {
  const dev = sliceBetween('function voiceDeviceSpeak', 'async function voiceSpeak(');
  assert.match(dev, /voiceWaitLocalVoice\(synth, 'en', 1000\)/);
  assert.match(dev, /u\.voice = voice/);
  assert.match(dev, /This device has no offline voice; turn on voice in Settings/);
  const run = (voices) => {
    const spoken = [], toasts = [];
    const synth = { getVoices: () => voices, speak(u) { spoken.push(u); setImmediate(() => u.onend()); } };
    const f = new Function('window', 'SpeechSynthesisUtterance', 'voicePlay', 'voiceWaitLocalVoice', 'toast', 'voiceSpeedFor', dev + '\nreturn voiceDeviceSpeak;')({ speechSynthesis: synth }, class { constructor(t) { this.text = t; } }, { token: 1 }, L.voiceWaitLocalVoice, (t) => toasts.push(t), () => 1.25);
    return f(['One.', 'Two.'], 1).then(() => ({ spoken, toasts }));
  };
  const local = { name: 'L', lang: 'en-US', localService: true, default: false };
  const a = await run([{ name: 'Online', lang: 'en-US', localService: false, default: true }, local]);
  assert.deepStrictEqual(a.spoken.map(u => u.text), ['One.', 'Two.']);
  assert.ok(a.spoken.every(u => u.voice === local), 'the offline voice, not the default online one');
  assert.ok(a.spoken.every(u => u.rate === 1.25), 'the device voice speaks at the voice speed (utterance.rate)');
  const b = await run([{ name: 'Online', lang: 'en-US', localService: false, default: true }]);
  assert.deepStrictEqual(b.spoken, [], 'nothing is spoken');
  assert.deepStrictEqual(b.toasts, ['This device has no offline voice; turn on voice in Settings']);
});

test('the speaker is hidden when neither the hub voice nor an offline device voice can speak (F8) and its room is reserved', () => {
  assert.match(js, /function voiceSpeakPaint\(\)/);
  assert.match(js, /classList\.toggle\('no-speak', !usable\)/);
  assert.match(js, /const usable = voiceOn\(\) \|\| \(!!voicePrefsNow\(\)\.deviceVoiceFallback && voiceLocalOk\)/);
  assert.match(html, /body\.no-speak \.msg \.speak \{ display: none; \}/);
  // the copy button reserves 30px; the speaker sits left of it and the reply keeps 58px free on the right
  assert.match(html, /\.msg \.copy \{ position: absolute; top: 2px; right: 2px; width: 28px;/);
  assert.match(html, /\.msg \.speak \{ position: absolute; top: 2px; right: 30px; width: 28px;/);
  assert.match(html, /body:not\(\.no-speak\) \.msg\.assistant \{ padding-right: 58px; \}/);
});

test('mic icon is an inline SVG (not the U+1F399 emoji), labelled Dictate; recording stays red', () => {
  assert.match(html, /id="mic-btn"[^>]*aria-label="Dictate"[^>]*title="[^"]+"[^>]*hidden><svg viewBox="0 0 24 24"[^>]*stroke="currentColor"[^>]*aria-hidden="true"/);
  assert.ok(!/id="mic-btn"[^\n]*(&#x1F399;|\u{1F399})/u.test(html));
  const paint = sliceBetween('function voiceMicPaint()', 'function voiceMicCancel()');
  assert.ok(!paint.includes('\u{1F399}'));
  assert.match(paint, /b\.innerHTML = VOICE_MIC_SVG/);
  assert.match(js, /const VOICE_MIC_SVG = '<svg viewBox="0 0 24 24" width="20" height="20"/);
  assert.match(html, /#mic-btn\.rec \{[^}]*var\(--error/);
});

test('install progress is 0..1 and shown as a percentage', () => {
  assert.match(js, /Math\.round\(voiceStatus\.progress \* 100\)/);
});

test('stop playback settles the pending voicePlayBlob and frees its blob URL', async () => {
  const src = sliceBetween('function voiceStopPlayback()', 'function voiceDeviceSpeak');
  assert.match(src, /voicePlay\.cancel = cancel/);
  assert.match(src, /const c = voicePlay\.cancel; voicePlay\.cancel = null; c\(\)/);
  const revoked = [];
  class FakeAudio { constructor() { this.paused = false; } pause() { this.paused = true; } play() { return Promise.resolve(); } }
  const voicePlay = { token: 5, audio: null, url: null, el: null, cancel: null };
  const f = new Function('voicePlay', 'window', 'URL', 'Audio', 'voiceOn', 'api', 'toast', src + '\nreturn { voicePlayBlob, voiceStopPlayback };')(
    voicePlay, {}, { createObjectURL: () => 'blob:x', revokeObjectURL: (u) => revoked.push(u) }, FakeAudio, () => true, null, () => {});
  const p = f.voicePlayBlob({}, 5);
  let settled = null; p.then((v) => { settled = v; });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(settled, null, 'still waiting while it plays');
  f.voiceStopPlayback();
  assert.strictEqual(await p, false, 'settles as not played to the end');
  assert.deepStrictEqual(revoked, ['blob:x'], 'the object URL is revoked');
  assert.strictEqual(voicePlay.url, null);
  assert.strictEqual(voicePlay.cancel, null);
});

test('a late play() rejection of a replaced voicePlayBlob leaves the newer playback its handlers; the newer one still resolves when it ends', async () => {
  const src = sliceBetween('function voiceStopPlayback()', 'function voiceDeviceSpeak');
  const revoked = []; const rejects = []; let urls = 0;
  class FakeAudio { constructor() { FakeAudio.last = this; this.paused = false; } pause() { this.paused = true; }
    play() { return new Promise((res, rej) => { rejects.push(rej); }); } }
  const voicePlay = { token: 5, audio: null, url: null, el: null, cancel: null };
  const f = new Function('voicePlay', 'window', 'URL', 'Audio', 'voiceOn', 'api', 'toast', src + '\nreturn { voicePlayBlob, voiceStopPlayback };')(
    voicePlay, {}, { createObjectURL: () => 'blob:' + (++urls), revokeObjectURL: (u) => revoked.push(u) }, FakeAudio, () => true, null, () => {});
  let aRes = null, bRes = null;
  const pa = f.voicePlayBlob({}, 5); pa.then((v) => { aRes = v; });
  const pb = f.voicePlayBlob({}, 5); pb.then((v) => { bRes = v; });   // B replaces A on the same shared element
  const audio = FakeAudio.last;
  assert.strictEqual(rejects.length, 2);
  const bEnded = audio.onended, bError = audio.onerror;
  assert.strictEqual(typeof bEnded, 'function');
  rejects[0](new Error('The play() request was interrupted'));        // A's play() fails late
  await new Promise(r => setImmediate(r));
  assert.strictEqual(aRes, false, 'A settles as not played');
  assert.strictEqual(bRes, null, 'B is still playing');
  assert.strictEqual(audio.onended, bEnded, "B's onended is still installed");
  assert.strictEqual(audio.onerror, bError, "B's onerror is still installed");
  audio.onended();                                                     // B reaches its end
  assert.strictEqual(await pb, true, 'B resolves true when it ends');
  assert.strictEqual(audio.onended, null, 'cleared once B is done');
  assert.strictEqual(audio.onerror, null);
  // completion runs once: a second signal from the same playback does nothing more
  const before = revoked.length; bEnded(); bError();
  assert.strictEqual(revoked.length, before, 'a finished playback does not revoke twice');
  assert.ok(revoked.includes('blob:2'), "B's URL was revoked");
  assert.strictEqual(voicePlay.url, null);
});

test('voiceMicOpen stops the stream tracks when the audio graph cannot be built', async () => {
  const open = sliceBetween('async function voiceMicOpen', 'function voiceMeterPaint');
  let stopped = 0, closed = 0;
  class Ctx { constructor() { this.destination = {}; } resume() {} close() { closed++; } createMediaStreamSource() { throw new Error('graph failed'); } }
  const navigator = { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { stopped++; } }, { stop() { stopped++; } }] }) } };
  const f = new Function('window', 'navigator', 'voiceGainFromSlider', open + '\nreturn voiceMicOpen;')({ AudioContext: Ctx }, navigator, (v) => v);
  await assert.rejects(f(50, () => {}), /graph failed/);
  assert.strictEqual(stopped, 2, 'every track stopped');
  assert.strictEqual(closed, 1, 'context closed');
});

test('mic requests: one pending flag + generation; sheet close or a hidden page while getUserMedia is pending stops the stream', async () => {
  assert.match(js, /guard: voiceMicGuard\(\)/);
  const tap = sliceBetween('async function voiceMicTap()', 'async function voiceMicStop()');
  assert.match(tap, /voiceRec\.guard\.pending/);
  assert.match(tap, /const token = voiceRec\.guard\.begin\(\)/);
  assert.match(tap, /voiceRec\.guard\.settle\(token, handle\)/);
  assert.match(sliceBetween('function voiceMicCancel()', 'async function voiceMicTap()'), /voiceRec\.guard\.cancel\(\)/);
  const testAll = sliceBetween('const voiceTest = {', 'function voiceSheet()');   // round 2: the leaving-the-app code (window listeners) follows the test-mic code
  const test = sliceBetween('const voiceTest = {', '// ── Leaving the app (round 2');
  assert.match(test, /voiceTest\.guard\.cancel\(\)/);
  assert.match(test, /voiceTest\.guard\.pending/);
  assert.match(test, /voiceTest\.guard\.settle\(token, handle\)/);
  assert.match(testAll, /addEventListener\('visibilitychange'[\s\S]*voiceTestStop\(\)[\s\S]*voiceMicCancel\(\)/);
  // run: Test mic, close the sheet while the permission prompt is open, then the stream arrives -> it is stopped at once
  const els = {};
  const mk = (id) => (els[id] ||= { disabled: false, textContent: '', style: {}, setAttribute() {}, querySelector: (q) => mk(q) });
  let release; const gate = new Promise((r) => { release = r; });
  let stopped = 0, opened = 0;
  const handle = { close() { stopped++; } };
  const voiceMicOpen = async () => { opened++; await gate; return handle; };
  const f = new Function('voiceMicGuard', 'voiceRec', '$', 'toast', 'voicePrefsNow', 'voiceMicOpen', 'voiceErr', 'voiceMeterPaint', 'document', 'voiceCall', 'voiceRoom',
    test + '\nreturn { voiceTestToggle, voiceTestStop, voiceTest };')(L.voiceMicGuard, { state: 'idle', guard: L.voiceMicGuard() }, () => mk('voice-sheet'), () => {}, () => ({ micLevel: 50 }), voiceMicOpen, () => '', () => 0, { addEventListener() {} }, null, { running: false });   // phase 2: the toggle also looks at a call and the room check
  const first = f.voiceTestToggle();
  f.voiceTestToggle();   // a second tap while pending is ignored
  assert.strictEqual(opened, 1, 'one acquisition');
  f.voiceTestStop();      // the sheet is closed
  release();
  await first;
  assert.strictEqual(stopped, 1, 'the late stream was stopped');
  assert.strictEqual(f.voiceTest.handle, null, 'nothing kept open');
  assert.strictEqual(f.voiceTest.guard.pending, false);
});

test('409 voice_off and 503 voice_busy get short toasts', () => {
  assert.match(js, /Voice is turned off/);
  assert.match(js, /Voice is busy, try again in a few seconds/);
  assert.match(sliceBetween('async function voiceMicStop()', 'function voiceInsert'), /r\.status === 503/);
  assert.match(sliceBetween('async function voiceTtsBlob', 'function voicePlayBlob'), /r\.status === 409 \|\| r\.status === 503/);
});

test('no U+FE0F in the voice code or markup', () => {
  const a = js.slice(js.indexOf('// ── Voice (phase 1)'), js.indexOf('// The message box keeps a draft per agent'));
  assert.ok(!a.includes('\uFE0F'));
  assert.ok(!/id="mic-btn"[^\n]*\uFE0F/.test(html) && !/id="menu-voice"[^\n]*(\uFE0F|&#xFE0F;)/i.test(html));
});

test('service worker cache is v65', () => {
  assert.match(read('sw.js'), /const VERSION = 'hub-mobile-v66'/);
});
