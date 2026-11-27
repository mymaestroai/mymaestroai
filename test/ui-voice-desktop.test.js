'use strict';
// Voice, desktop page (phase 1): the Voices settings section, the mic button in the composer, read aloud on replies and the
// agent settings voice row. Source-level wiring checks, plus the voice block of app.js run against fake browser objects.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js');
const html = read('index.html');
const L = require('../lib/ui-voice');

// The shared device helpers of the library (the real ones) and the page's own voiceMarkDeviceChanged, taken from app.js.
const DEV = (() => {
  const LL = require('../lib/ui-voice');
  const i = app.indexOf('    function voiceMarkDeviceChanged('), j = app.indexOf('    function voiceMicLevelNow()', i);
  if (!(i > 0 && j > i)) throw new Error('voiceMarkDeviceChanged not found in app.js');
  const voiceMarkDeviceChanged = new Function('VOICE_DEVICE_DEFAULT_KEYS', 'voiceMarkDeviceSet', app.slice(i, j) + '\nreturn voiceMarkDeviceChanged;')(LL.VOICE_DEVICE_DEFAULT_KEYS, LL.voiceMarkDeviceSet);
  return { ...LL, voiceMarkDeviceChanged };
})();

const BLOCK_START = '    // ── Voice, desktop page:';
const BLOCK_END = '    // Message rendering\n';
function voiceBlock() {
  const a = app.indexOf(BLOCK_START), b = app.indexOf(BLOCK_END, a);
  assert.ok(a > 0 && b > a, 'voice block found');
  return app.slice(a, b);
}

test('settings: Voices section in the tools group, admin controls and per-device prefs', () => {
  // voice entry: Voice is a group of its own (after Appearance), no longer part of Tools and data
  const G = require('../lib/ui-settings-groups.js');
  assert.deepStrictEqual(G.GROUPS.find((x) => x.id === 'voice').sections, ['st-voice-section']);
  assert.ok(!G.GROUPS.find((x) => x.id === 'tools').sections.includes('st-voice-section'));
  assert.ok(app.includes('html += voiceSettingsHtml(data);'));
  const b = voiceBlock();
  assert.match(b, /id="st-voice-section"><h4>Voice<\/h4>/);
  assert.match(b, /const admin = isHubAdmin\(\);/);
  assert.match(b, /On for everyone on this Maestro/);   // was "Enable voice" (voice entry)
  assert.match(b, /`\/api\/voice\/\$\{on \? 'enable' : 'disable'\}`/);
  assert.match(b, /method: 'POST'/);
  assert.match(b, /setTimeout\(voiceSettingsRefresh, 2000\)/, 'polls every 2 s while installing');
  assert.match(b, /st\.installing/);
  assert.match(b, /body: JSON\.stringify\(\{ voice: \{ defaultVoice: sel\.value \} \}\)/, 'default voice saved through /api/settings, nothing else');
  assert.doesNotMatch(b.slice(b.indexOf('async function voiceSettingDefaultVoice'), b.indexOf('function voicePlaySample')), /enabled|sttModel/);
  assert.match(b, /fetch\('\/api\/settings'/);
  assert.match(b, /Play sample/);
  assert.match(b, /nothing is sent to the internet/);
  assert.doesNotMatch(b, /Hands-free conversation comes next/, 'phase 2 replaced the phase-1 hint');
  assert.match(b, /start a hands-free call/);
  assert.match(b, /id="st-voice-mic" value=/);
  assert.match(b, /Read replies aloud/);
  assert.match(b, /Use this device's own offline voice when the hub voice is unavailable/);
  assert.match(b, /voiceSavePrefs\(localStorage, prefs\)/);
  assert.match(b, /dialogGuard\.savePoint\(/);
  // the default voice and the play sample are admin only
  const admin = b.slice(b.indexOf('if (admin) {'), b.indexOf("row('Mic level'"));
  assert.match(admin, /st-voice-default/);
  assert.match(admin, /st-voice-sample/);
  // the meter moves only while the test mic is open
  assert.match(b, /voiceTest\.timer = setInterval/);
  assert.match(b, /if \(voiceTest\.mic\) \{ voiceTest\.mic\.close\(\); voiceTest\.mic = null; \}/);
});

test('composer: mic button next to attach, shown only when voice is enabled and ready', () => {
  assert.match(app, /id="mic-\$\{chatId\}" class="mic-btn" style="display:none"[^>]*title="\$\{hubEsc\(voiceMicIdleTitle\(chatId\)\)\}"/);   // the title follows the saved mode and names the chat's agent (voice entry)
  assert.match(app, /onclick="voiceMicToggle\('\$\{chatId\}'\)"/);
  const at = app.indexOf('id="mic-${chatId}"');
  assert.ok(app.indexOf('document.getElementById(\'file-input-${chatId}\').click()') < at, 'after the attach button');
  assert.match(app, /const voiceReady = \(\) => !!\(voiceStatus && voiceStatus\.enabled && voiceStatus\.ready\);/);
  assert.match(app, /b\.style\.display = voiceReady\(\) \? '' : 'none'/);
  const b = voiceBlock();
  assert.match(b, /getUserMedia\(\{ audio: \{ echoCancellation: true, noiseSuppression: true, autoGainControl: true \} \}\)/);
  assert.match(b, /gain\.gain\.value = voiceGainFromSlider\(micLevel\)/);
  assert.match(b, /createGain\(\)/);
  assert.match(b, /createScriptProcessor\(4096, 1, 1\)/);
  assert.match(b, /VOICE_MAX_RECORD_S = 60/);
  assert.match(b, /voiceEncodeWav\(voiceResample\(all, rate, 16000\), 16000\)/);
  assert.match(b, /`\/api\/voice\/stt\?agent=\$\{encodeURIComponent\(chat \? chat\.agent : ''\)\}`/);
  assert.match(b, /'Content-Type': 'audio\/wav'/);
  assert.match(b, /mic\.close\(\);\s*\/\/ the microphone is released after every use/);
  assert.match(b, /voiceRec\.timer = setInterval\(voiceMicTick, 100\)/);
});

test('read aloud: speaker button on assistant bubbles, TTS sentence by sentence, device fallback, Stop stops it', () => {
  const dm = app.slice(app.indexOf('function decorateMessage('), app.indexOf('function setMessageTime('));
  assert.match(dm, /el\.classList\.contains\('assistant'\)[\s\S]*sp\.className = 'msg-speak'/);
  const b = voiceBlock();
  assert.match(b, /fetch\('\/api\/voice\/tts', \{ method: 'POST'/);
  assert.match(b, /voiceSentences\(voiceSpeechText\(md\)\)/);
  assert.match(b, /next = voiceFetchTts\(agent, sentences\[i \+ 1\], voice\)/, 'prefetches the next sentence');
  assert.match(b, /new SpeechSynthesisUtterance\(/);
  assert.match(b, /window\.speechSynthesis\.speak\(u\)/);
  assert.match(b, /voicePlay\.btn === b\) \{ voiceStopPlayback\(\)/, 'tap again stops');
  assert.match(app, /function stopAgentTurn\(agentName\) \{\s*try \{ voiceStopPlayback\(\); \} catch \{\}/);
  assert.match(app, /if \(!retryCount\) \{ chat\.voiceTurn = !!chat\.voiceDictated; chat\.voiceDictated = false; \}/);
  assert.match(app, /if \(!partial && chat\.voiceTurn\) \{ chat\.voiceTurn = false; voiceAutoRead\(chat, msgId, fullResponse\); \}/);
  assert.match(b, /if \(!voicePrefsNow\(\)\.readAloud \|\| /);
  assert.match(b, /if \(chat\) chat\.voiceDictated = true;/);
});

test('css: mic button states, meter, speaker button (dark theme variables)', () => {
  for (const sel of ['.input-area .mic-btn.rec', '.input-area .mic-btn.wait', '.mic-meter > i', '.voice-meter', '.message > .msg-speak', 'body.voice-on .message > .msg-speak']) {
    assert.ok(html.includes(sel), sel);
  }
  assert.match(html, /\.message > \.msg-speak \{[^}]*var\(--bg-card\)/);
});

// The old 'agent settings: Voice row' test pinned the old page's markup; the card's Voice rows are tested in
// test/ui-agent-card-basics.test.js (the 'Voice: ...' tests: PATCH {voice}, the voice list from /api/voice/status).

test('no variation selector U+FE0F in the new voice code', () => {
  assert.ok(!voiceBlock().includes('\uFE0F'));
  assert.ok(!read('lib/ui-agent-card-basics.js').includes('\uFE0F'));
  const css = html.slice(html.indexOf('/* Voice: mic button'), html.indexOf('.input-area button.secondary'));
  assert.ok(!css.includes('\uFE0F'));
});

// ── The voice block run against fake browser objects ──

function el(extra = {}) {
  const cls = new Set();
  return Object.assign({
    style: {}, dataset: {}, value: '', textContent: '', disabled: false, isConnected: true,   // a page element stays the same connected element until removed
    classList: { toggle(c, on) { if (on) cls.add(c); else cls.delete(c); }, contains: (c) => cls.has(c) },
    setAttribute() {}, querySelector() { return null; }, focus() { this.focused = true; }, firstElementChild: { style: {} },
  }, extra);
}

function makeEnv(opts = {}) {
  const calls = { fetch: [], toasts: [], gum: [], utter: [], played: [], gains: [] };
  const els = {};
  const get = (id) => (els[id] ||= el());
  const status = opts.status || { enabled: true, ready: true, voices: [], tts: {}, stt: {} };
  class FakeCtx {
    constructor() { this.state = 'running'; this.sampleRate = 48000; this.destination = {}; this.procs = []; FakeCtx.last = this; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { const g = { gain: { value: 1 }, connect() {}, disconnect() {} }; calls.gains.push(g); return g; }
    createScriptProcessor() { const p = { connect() {}, disconnect() {} }; this.procs.push(p); return p; }
    createBufferSource() { const s = { connect() {}, stop() { s.stopped = true; setImmediate(() => s.onended && s.onended()); }, start() { calls.played.push(s.buffer); setImmediate(() => s.onended && s.onended()); } }; return s; }
    async decodeAudioData(buf) { return { fromBytes: new Uint8Array(buf)[0] }; }
    async resume() {}
    close() { this.state = 'closed'; }
  }
  const voices = opts.voices || [{ name: 'Online', lang: 'en-US', localService: false, default: true }, { name: 'Local', lang: 'en-GB', localService: true, default: false }];
  const win = { AudioContext: FakeCtx, addEventListener() {}, speechSynthesis: opts.noSynth ? undefined : { getVoices: () => voices, speak(u) { calls.utter.push(u.text); calls.voiceUsed = u.voice; setImmediate(() => u.onend && u.onend()); }, cancel() { calls.cancelled = true; } } };
  const fetchFn = async (url, o = {}) => {
    calls.fetch.push({ url, o });
    if (url === '/api/voice/status') return { ok: true, json: async () => status };
    if (url.startsWith('/api/voice/stt')) return opts.stt ? opts.stt() : { ok: true, status: 200, json: async () => ({ text: 'hello there', ms: 5 }) };
    if (url === '/api/voice/tts') {
      if (opts.ttsStatus) return { ok: false, status: opts.ttsStatus, json: async () => ({ error: opts.ttsStatus === 409 ? 'voice_off' : 'voice_busy' }) };
      const n = calls.fetch.filter(c => c.url === '/api/voice/tts').length;
      if (opts.ttsFailAt === n) return { ok: false, status: 500, json: async () => ({ error: 'engine down' }) };
      return { ok: true, arrayBuffer: async () => Uint8Array.from([n]).buffer };
    }
    return { ok: true, json: async () => ({}) };
  };
  const chats = { c1: { agent: 'alice', pendingImages: [] } };
  const stubs = {
    document: { getElementById: get, querySelectorAll: () => [], body: { classList: { toggle() {} } }, addEventListener() {} },
    window: win,
    navigator: { mediaDevices: { getUserMedia: async (c) => { calls.gum.push(c); return { getTracks: () => [{ stop() { calls.gumStopped = true; } }] }; } } },
    localStorage: {},
    fetch: fetchFn,
    hubToast: (t) => calls.toasts.push(t),
    chats, activeChat: 'c1', rawMessageText: new WeakMap(),
    isHubAdmin: () => !opts.member, openVoiceSettings: () => { calls.openedSettings = (calls.openedSettings || 0) + 1; }, stSum() {}, capName: (s) => s, questionOverlays: {}, hubEsc: String, dialogGuard: { savePoint: () => () => {}, markLoaded() {} },
    autoGrowTextarea() {},
    SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } },
    voiceLoadPrefs: () => ({ micLevel: 80, mode: 'tap', readAloud: true, deviceVoiceFallback: !!opts.fallback, echoHold: 0, loudness: 'louder', loudnessBt: 'normal' }),   // the two device defaults are already the stored values, so a save that keeps them marks nothing as chosen (the page marks `set` only for a changed device default)   // 'tap': these tests are the phase-1 dictation path (hands-free is the default since phase 2)
    voiceSavePrefs: (s, p) => { calls.saved = p; },
    voiceGainFromSlider: (v) => v / 10,
    voiceSliderFromGain: (g) => g * 10,
    voiceLevelDb: () => -20, voiceMeterPercent: () => 50, VOICE_LOUDNESS: { normal: 0, louder: 9, loudest: 14 }, voiceLoudnessNow: () => 'louder', voiceLoudnessFor: (p, kind) => (kind === 'bluetooth' ? 'normal' : 'louder'), voiceLoudnessSelectHtml: (id, attrs) => `<select id="${id}" ${attrs}></select>`, voiceLoudApply() {}, VOICE_ECHO_HOLDS: [0, 600, 1000, 1500],
    voiceResample: (f, from, to) => { calls.resample = [f.length, from, to]; return f; },
    voiceEncodeWav: (f, r) => { calls.wavRate = r; return new Uint8Array([82, 73, 70, 70]).buffer; },
    voiceSentences: (t) => t.split(/(?<=\.)\s+/).filter(Boolean),
    voiceSpeechText: (t) => t,
    voiceCleanSpeed: L.voiceCleanSpeed, voiceSpeedLabel: L.voiceSpeedLabel, VOICE_END_PAUSES: L.VOICE_END_PAUSES, VOICE_DETAILS_READ_WORDS: L.VOICE_DETAILS_READ_WORDS,
    voiceEffectivePrefs: L.voiceEffectivePrefs, voiceMarkChosen: L.voiceMarkChosen, voiceIsIOSNav: DEV.voiceIsIOSNav, voiceEchoHoldOk: DEV.voiceEchoHoldOk, voiceEchoHoldLabel: DEV.voiceEchoHoldLabel, VOICE_ECHO_HOLDS: DEV.VOICE_ECHO_HOLDS, voiceEchoChoices: DEV.voiceEchoChoices, VOICE_DEVICE_DEFAULT_KEYS: DEV.VOICE_DEVICE_DEFAULT_KEYS, voiceMarkDeviceSet: DEV.voiceMarkDeviceSet, voiceDevicePrefs: DEV.voiceDevicePrefs, VOICE_ECHO_HOLD_IOS: DEV.VOICE_ECHO_HOLD_IOS, voiceMarkDeviceChanged: DEV.voiceMarkDeviceChanged, VOICE_AGENT_DEFAULT_KEYS: L.VOICE_AGENT_DEFAULT_KEYS, VOICE_DEFAULT_PREFS: L.VOICE_DEFAULT_PREFS, AGENTS: [], capName: (n) => n,   // agent voice defaults (part 6)   // voice fixes 1: speed and end-of-turn pause
    voiceMicGuard: L.voiceMicGuard, voiceWaitLocalVoice: L.voiceWaitLocalVoice, voicePickLocalVoice: L.voicePickLocalVoice, VOICE_PRESS_HOLD_MS: L.VOICE_PRESS_HOLD_MS,   // (voiceMicToggle tells a tap from a hold of the idle mic)
  };
  if (opts.gum) stubs.navigator.mediaDevices.getUserMedia = opts.gum(calls);
  const names = Object.keys(stubs);
  const src = voiceBlock() + '\nreturn { voiceRefreshStatus, voiceOpenMic, voiceMicToggle, voiceMicStop, voiceSpeakText, voiceStopPlayback, voicePlay, voiceRec, voiceSettingEnable, voiceSettingsSavePrefs, voiceSettingsHtml, voiceReady, voiceTest, voiceTestMic, voiceTestStop, voiceChatGone, voicePaintSettings, voiceSettingDefaultVoice };';
  const api = new Function(...names, src)(...names.map(n => stubs[n]));
  return { api, calls, chats, get, els, FakeCtx };
}

test('mic: opens with the echo/noise/gain constraints, applies the Mic level gain, releases the mic', async () => {
  const { api, calls, FakeCtx } = makeEnv();
  const got = [];
  const mic = await api.voiceOpenMic(80, (d) => got.push(d));
  assert.deepStrictEqual(calls.gum[0], { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  assert.strictEqual(calls.gains[0].gain.value, 8, 'gain from the slider');
  mic.setGain(30);
  assert.strictEqual(calls.gains[0].gain.value, 3);
  FakeCtx.last.procs[0].onaudioprocess({ inputBuffer: { getChannelData: () => Float32Array.from([0.1, 0.2]) } });
  assert.strictEqual(got.length, 1);
  assert.strictEqual(mic.rate, 48000);
  mic.close();
  assert.ok(calls.gumStopped, 'tracks stopped');
  assert.strictEqual(FakeCtx.last.state, 'closed');
});

test('mic: tap, tap sends 16 kHz wav to the STT route and appends the text to the box', async () => {
  const { api, calls, chats, get } = makeEnv();
  await api.voiceRefreshStatus();
  get('input-c1').value = 'first part ';
  await api.voiceMicToggle('c1');
  assert.strictEqual(api.voiceRec.chatId, 'c1');
  assert.ok(api.voiceRec.mic, 'the mic is open');
  api.voiceRec.chunks.push(new Float32Array(48000));   // one second of samples
  await api.voiceMicToggle('c1');
  const stt = calls.fetch.find(c => c.url.startsWith('/api/voice/stt'));
  assert.ok(stt, 'posted to stt');
  assert.strictEqual(stt.url, '/api/voice/stt?agent=alice');
  assert.strictEqual(stt.o.method, 'POST');
  assert.strictEqual(stt.o.headers['Content-Type'], 'audio/wav');
  assert.deepStrictEqual(calls.resample, [48000, 48000, 16000]);
  assert.strictEqual(calls.wavRate, 16000);
  assert.strictEqual(get('input-c1').value, 'first part hello there');
  assert.ok(get('input-c1').focused);
  assert.strictEqual(chats.c1.voiceDictated, true);
  assert.ok(calls.gumStopped, 'mic released');
  assert.strictEqual(api.voiceRec.chatId, null);
});

test('mic: off voice is refused with a message; a 409 voice_off from the hub shows a toast', async () => {
  const off = makeEnv({ status: { enabled: false, ready: false } });
  await off.api.voiceRefreshStatus();
  await off.api.voiceMicToggle('c1');
  assert.strictEqual(off.calls.gum.length, 0, 'no microphone when voice is off');
  assert.match(off.calls.toasts[0], /Voice is off/);   // the microphone is hidden until ready, so this is only a guard; its words are the voice-entry words
  const member = makeEnv({ status: { enabled: false, ready: false, adminName: 'Sam' }, member: true });
  await member.api.voiceRefreshStatus();
  await member.api.voiceMicToggle('c1');
  assert.strictEqual(member.calls.gum.length, 0);
  assert.strictEqual(member.calls.toasts[0], 'Voice is off on this Maestro. Ask Sam to turn it on.');
  const e = makeEnv({ stt: async () => ({ ok: false, status: 409, json: async () => ({ error: 'voice_off' }) }) });
  await e.api.voiceRefreshStatus();
  await e.api.voiceMicToggle('c1');
  e.api.voiceRec.chunks.push(new Float32Array(48000));
  await e.api.voiceMicToggle('c1');
  assert.ok(e.calls.toasts.some(t => /turned off/.test(t)));
  assert.strictEqual(e.get('input-c1').value, '');
});

test('read aloud: every sentence is fetched in order and played through one AudioContext', async () => {
  const { api, calls, FakeCtx } = makeEnv();
  await api.voiceRefreshStatus();
  await api.voiceSpeakText('alice', 'One. Two. Three.', null);
  const tts = calls.fetch.filter(c => c.url === '/api/voice/tts').map(c => JSON.parse(c.o.body));
  assert.deepStrictEqual(tts.map(t => t.text), ['One.', 'Two.', 'Three.']);
  assert.ok(tts.every(t => t.agent === 'alice'));
  assert.deepStrictEqual(calls.played.map(b => b.fromBytes), [1, 2, 3], 'played in order');
  assert.ok(FakeCtx.last, 'one context');
});

test('read aloud: a failing hub voice falls back to the device voice only when asked to', async () => {
  const a = makeEnv({ ttsFailAt: 2, fallback: true });
  await a.api.voiceRefreshStatus();
  await a.api.voiceSpeakText('alice', 'One. Two. Three.', null);
  assert.deepStrictEqual(a.calls.utter, ['Two.', 'Three.'], 'the device voice continues from the failed sentence');
  const b = makeEnv({ ttsFailAt: 1, fallback: false });
  await b.api.voiceRefreshStatus();
  await b.api.voiceSpeakText('alice', 'One. Two.', null);
  assert.deepStrictEqual(b.calls.utter, []);
  assert.match(b.calls.toasts[0], /Could not read this aloud: engine down/);
  const c = makeEnv({ status: { enabled: false, ready: false }, fallback: true });
  await c.api.voiceRefreshStatus();
  await c.api.voiceSpeakText('alice', 'Hello there.', null);
  assert.deepStrictEqual(c.calls.utter, ['Hello there.'], 'voice off: device voice');
});

test('read aloud: stop ends playback and a newer playback replaces the older one', async () => {
  const { api, calls } = makeEnv();
  await api.voiceRefreshStatus();
  const first = api.voiceSpeakText('alice', 'One. Two. Three. Four.', null);
  api.voiceStopPlayback();
  await first;
  assert.ok(calls.played.length < 4, 'stopped before the end');
  assert.ok(calls.cancelled, 'device speech cancelled too');
});

test('settings prefs are saved with voiceSavePrefs from the controls', () => {
  const { api, calls, get } = makeEnv();
  get('st-voice-mic').value = '35'; get('st-voice-readaloud').checked = false; get('st-voice-fallback').checked = true;
  get('st-voice-mode').value = 'tap'; get('st-voice-sens').value = '40';   // phase 2 added these two controls to the same save
  get('st-voice-pause').value = '2000'; get('st-voice-speed').value = '1.1'; get('st-voice-speakactivity').checked = true;   // voice fixes 1: pause, speed, spoken activity
  api.voiceSettingsSavePrefs();
  assert.deepStrictEqual(calls.saved, { micLevel: 35, interruptSensitivity: 40, mode: 'tap', readAloud: false, deviceVoiceFallback: true, endPause: 2000, voiceSpeed: 1.1, speakActivity: true, echoHold: 0, keepAlive: false, loudness: 'louder', loudnessBt: 'normal' });   // changed: loudnessBt (the second select, no control in the fake controls keeps the current pref); + the Bluetooth settings; loudness: no select in the fake controls keeps the current pref (default louder) (the fake controls read as 0 / unchecked)
});

test('settings: members get no enable switch, default voice or sample; admins do', () => {
  const admin = makeEnv().api.voiceSettingsHtml({});
  assert.match(admin, /st-voice-enabled/);
  assert.match(admin, /st-voice-default/);
  assert.match(admin, /Play sample/);
  const stubsSrc = voiceBlock().replace('const admin = isHubAdmin();', 'const admin = false;');
  const member = new Function('document', 'window', 'localStorage', 'voiceLoadPrefs', 'voiceGainFromSlider', 'chats', 'dialogGuard', 'voiceMicGuard', 'voiceCleanSpeed', 'voiceSpeedLabel', 'VOICE_END_PAUSES', 'VOICE_ECHO_HOLDS', 'voiceLoudnessSelectHtml', 'voiceLoudnessNow', 'VOICE_LOUDNESS', 'voiceLoudnessFor', 'voiceIsIOSNav', 'voiceEchoHoldOk', 'voiceEchoHoldLabel', 'voiceEchoChoices', 'VOICE_DEVICE_DEFAULT_KEYS', 'voiceMarkDeviceSet', 'voiceDevicePrefs', 'voiceMarkDeviceChanged', 'VOICE_ECHO_HOLD_IOS', 'VOICE_DETAILS_READ_WORDS',
    stubsSrc + '\nreturn voiceSettingsHtml({});')({ getElementById() {}, body: { classList: {} }, addEventListener() {} }, { addEventListener() {} }, {}, () => ({ micLevel: 50 }), (v) => v, {}, {}, L.voiceMicGuard, L.voiceCleanSpeed, L.voiceSpeedLabel, L.VOICE_END_PAUSES, [0, 600, 1000, 1500], () => '', () => 'louder', { normal: 0, louder: 9, loudest: 14 }, () => 'louder', DEV.voiceIsIOSNav, DEV.voiceEchoHoldOk, DEV.voiceEchoHoldLabel, DEV.voiceEchoChoices, DEV.VOICE_DEVICE_DEFAULT_KEYS, DEV.voiceMarkDeviceSet, DEV.voiceDevicePrefs, DEV.voiceMarkDeviceChanged, DEV.VOICE_ECHO_HOLD_IOS, L.VOICE_DETAILS_READ_WORDS);
  assert.doesNotMatch(member, /st-voice-enabled|st-voice-default|Play sample/);
  assert.match(member, /st-voice-status/);
  assert.match(member, /id="st-voice-mic"/);
});

// A getUserMedia that stays pending until calls.resolveGum() is called; each stream counts its track stops.
const lateGum = (calls) => {
  calls.gumCalls = 0; calls.streams = [];
  return () => { calls.gumCalls++; return new Promise((res) => { calls.resolveGum = () => { const s = { stops: 0, getTracks: () => [{ stop() { s.stops++; } }] }; calls.streams.push(s); res(s); }; }); };
};
const tick = () => new Promise((r) => setImmediate(r));

test('Settings Test the mic: two quick clicks start one acquisition and Stop closes it', async () => {
  const { api, calls } = makeEnv({ gum: lateGum });
  const first = api.voiceTestMic();
  const second = api.voiceTestMic();
  await second;
  assert.strictEqual(calls.gumCalls, 1, 'the second click is ignored while the first is pending');
  calls.resolveGum(); await first;
  assert.ok(api.voiceTest.mic, 'open');
  api.voiceTestStop();
  assert.strictEqual(calls.streams[0].stops, 1, 'Stop released the only stream');
  assert.strictEqual(api.voiceTest.mic, null);
});

test('Settings Test the mic: closing Settings (or hiding the page) while the permission is pending stops the stream when it arrives', async () => {
  const { api, calls } = makeEnv({ gum: lateGum });
  const p = api.voiceTestMic();
  api.voiceTestStop();   // what the visibilitychange handler and a closed Settings do
  calls.resolveGum(); await p;
  assert.strictEqual(calls.streams[0].stops, 1, 'stopped at once');
  assert.strictEqual(api.voiceTest.mic, null);
  assert.strictEqual(api.voiceTest.timer, null, 'no meter timer was started');
});

test('Settings Test the mic: Settings closed and reopened (a new section element) while the permission is pending closes the stream and leaves no test mic', async () => {
  const { api, calls, els, get } = makeEnv({ gum: lateGum });
  const first = get('st-voice-section');
  const p = api.voiceTestMic();
  first.isConnected = false;                       // Settings closed: the section is removed
  els['st-voice-section'] = el();                  // Settings reopened: a new, connected section
  calls.resolveGum(); await p;
  assert.strictEqual(calls.streams[0].stops, 1, 'the late stream was closed');
  assert.strictEqual(api.voiceTest.mic, null);
  assert.strictEqual(api.voiceTest.timer, null, 'no meter timer was started');
});

test('dictation: a second tap while pending is ignored; closing the chat while pending stops the late stream', async () => {
  const { api, calls } = makeEnv({ gum: lateGum });
  await api.voiceRefreshStatus();
  const p = api.voiceMicToggle('c1');
  await api.voiceMicToggle('c1');
  assert.strictEqual(calls.gumCalls, 1, 'one acquisition');
  api.voiceChatGone('c1');
  calls.resolveGum(); await p;
  assert.strictEqual(calls.streams[0].stops, 1);
  assert.strictEqual(api.voiceRec.chatId, null);
  assert.strictEqual(api.voiceRec.mic, null);
  assert.strictEqual(api.voiceRec.guard.pending, false);
  assert.strictEqual(calls.fetch.filter(c => c.url.startsWith('/api/voice/stt')).length, 0);
});

test('dictation: closing the chat while recording stops without uploading', async () => {
  const { api, calls } = makeEnv({ gum: (c) => { c.streams = []; return async () => { const s = { stops: 0, getTracks: () => [{ stop() { s.stops++; } }] }; c.streams.push(s); return s; }; } });
  await api.voiceRefreshStatus();
  await api.voiceMicToggle('c1');
  api.voiceRec.chunks.push(new Float32Array(48000));
  api.voiceChatGone('c1');
  await tick();
  assert.strictEqual(calls.streams[0].stops, 1, 'microphone released');
  assert.strictEqual(api.voiceRec.chatId, null);
  assert.strictEqual(calls.fetch.filter(c => c.url.startsWith('/api/voice/stt')).length, 0, 'nothing uploaded');
});

test('device voice: only an offline voice is used; none means nothing is spoken and a toast', async () => {
  const a = makeEnv({ status: { enabled: false, ready: false }, fallback: true });
  await a.api.voiceRefreshStatus();
  await a.api.voiceSpeakText('alice', 'Hello there.', null);
  assert.deepStrictEqual(a.calls.utter, ['Hello there.']);
  assert.strictEqual(a.calls.voiceUsed.name, 'Local', 'the offline voice, not the online default');
  const b = makeEnv({ status: { enabled: false, ready: false }, fallback: true, voices: [{ name: 'Online', lang: 'en-US', localService: false, default: true }] });
  await b.api.voiceRefreshStatus();
  await b.api.voiceSpeakText('alice', 'Hello there.', null);
  assert.deepStrictEqual(b.calls.utter, [], 'not spoken');
  assert.ok(b.calls.toasts.includes('This device has no offline voice; turn on voice in Settings'));
});

test('409 voice_off / 503 voice_busy from the TTS route show a short toast (once)', async () => {
  for (const [status, text] of [[409, 'Voice is turned off'], [503, 'Voice is busy, try again in a few seconds']]) {
    const e = makeEnv({ ttsStatus: status });
    await e.api.voiceRefreshStatus();
    await e.api.voiceSpeakText('alice', 'One. Two.', null);
    assert.deepStrictEqual(e.calls.toasts, [text], String(status));
  }
  const src = voiceBlock();
  assert.match(src, /if \(status === 409\) hubToast\('Voice is turned off'\); else if \(status === 503\) hubToast\('Voice is busy, try again in a few seconds'\)/);
  assert.match(src, /e\.toasted = voiceBusyToast\(r\.status\)/);
  assert.match(src, /r\.status === 503 && j\.error === 'voice_busy'/);
});

test('default voice picker: starts at the hub default, saves only defaultVoice, labels show the accent once', async () => {
  const { api, calls, get } = makeEnv();
  api.voicePaintSettings({ enabled: true, ready: true, defaultVoice: 'b', installDefaultVoice: 'a', tts: { defaultVoice: 'a' },
    voices: [{ id: 'a', label: 'Heart (US, female)', accent: 'US' }, { id: 'b', label: 'Emma (UK, female)', accent: 'UK' }] });
  const html = get('st-voice-default').innerHTML;
  assert.match(html, /<option value="b" selected>Emma \(UK, female\)<\/option>/, 'the effective default is selected');
  assert.match(html, /<option value="a">Heart \(US, female\)<\/option>/);
  assert.doesNotMatch(html, /\(US\) \(US\)|female\) \(US\)|female\) \(UK\)/, 'no second accent');
  get('st-voice-default').value = 'a';
  await api.voiceSettingDefaultVoice();
  const post = calls.fetch.find(c => c.url === '/api/settings');
  assert.deepStrictEqual(JSON.parse(post.o.body), { voice: { defaultVoice: 'a' } });
});

test('Voices settings: both checkboxes sit in the value column (text may wrap there, inside the dialog), ids kept', () => {
  const h = makeEnv().api.voiceSettingsHtml({});
  for (const id of ['st-voice-readaloud', 'st-voice-fallback']) {
    assert.match(h, new RegExp(`<div class="st-row"><label style="flex-basis:150px">[A-Za-z ]{0,12}</label><label style="[^"]*flex:1;min-width:0;[^"]*"><input type="checkbox" id="${id}"`), id);
    assert.doesNotMatch(h, new RegExp(`white-space:nowrap[^"]*"><input type="checkbox" id="${id}"`), id);
  }
  assert.match(h, /<label style="flex:0 0 auto;[^"]*white-space:nowrap"><input type="checkbox" id="st-voice-enabled"/);
  assert.match(h, /Use this device's own offline voice when the hub voice is unavailable/);
});

test('mic icon is an inline SVG, not the U+1F399 emoji; Dictate label; recording is the red .rec state', () => {
  assert.match(app, /id="mic-\$\{chatId\}" class="mic-btn" style="display:none" aria-pressed="false" aria-label="\$\{voiceMicIdleLabel\(\)\}" title="[^"]+">\$\{VOICE_MIC_SVG\}<\/button>/);   // the label follows the saved mode; 'Dictate' is the Dictation label (voiceMicIdleLabel)
  const b = voiceBlock();
  assert.match(b, /const VOICE_MIC_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"[^']*aria-hidden="true"/);
  assert.ok(!b.includes('\u{1F399}') && !/&#127897;/.test(app.slice(app.indexOf('id="mic-${chatId}"'), app.indexOf('id="mic-${chatId}"') + 400)));
  assert.match(b, /b\.setAttribute\('aria-label', state === 'rec' \? 'Stop dictation' : voiceMicIdleLabel\(\)\)/);
  assert.match(app, /function voiceMicIdleLabel\(\) \{ const m = voicePrefsNow\(\)\.mode; return m === 'press' \? 'Tap to talk' : m === 'tap' \? 'Dictate' : 'Talk hands-free'; \}/);
    // looks-vars: the value is unchanged; index.html/app.js now spell it as a variable (defined in index.html :root)
  assert.match(html, /\.input-area \.mic-btn\.rec \{[^}]*var\(--mic-rec\)/);
  assert.match(html, /--mic-rec:\s*#ef4444;/);
  assert.match(html, /\.input-area \.mic-btn svg \{/);
});
