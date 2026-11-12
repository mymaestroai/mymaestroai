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
const as = read('agent-settings.html');

const BLOCK_START = '    // ── Voice, desktop page:';
const BLOCK_END = '    // Message rendering\n';
function voiceBlock() {
  const a = app.indexOf(BLOCK_START), b = app.indexOf(BLOCK_END, a);
  assert.ok(a > 0 && b > a, 'voice block found');
  return app.slice(a, b);
}

test('settings: Voices section in the tools group, admin controls and per-device prefs', () => {
  assert.match(app, /\{ id: 'tools', title: '[^']+', sections: \[[^\]]*'st-voice-section'[^\]]*\] \}/);
  assert.ok(app.includes('html += voiceSettingsHtml(data);'));
  const b = voiceBlock();
  assert.match(b, /id="st-voice-section"><h4>Voices<\/h4>/);
  assert.match(b, /const admin = isHubAdmin\(\);/);
  assert.match(b, /Enable voice/);
  assert.match(b, /`\/api\/voice\/\$\{on \? 'enable' : 'disable'\}`/);
  assert.match(b, /method: 'POST'/);
  assert.match(b, /setTimeout\(voiceSettingsRefresh, 2000\)/, 'polls every 2 s while installing');
  assert.match(b, /st\.installing/);
  assert.match(b, /body: JSON\.stringify\(\{ voice: \{ enabled: [^}]*defaultVoice: sel\.value/, 'default voice saved through /api/settings');
  assert.match(b, /fetch\('\/api\/settings'/);
  assert.match(b, /Play sample/);
  assert.match(b, /nothing is sent to the internet/);
  assert.match(b, /Hands-free conversation comes next/);
  assert.match(b, /id="st-voice-mic" value=/);
  assert.match(b, /Read replies aloud/);
  assert.match(b, /Use the device voice when the hub voice is unavailable/);
  assert.match(b, /voiceSavePrefs\(localStorage, prefs\)/);
  assert.match(b, /dialogGuard\.savePoint\(/);
  // the default voice and the play sample are admin only
  const admin = b.slice(b.indexOf('if (admin) {'), b.indexOf('On this device only'));
  assert.match(admin, /st-voice-default/);
  assert.match(admin, /st-voice-sample/);
  // the meter moves only while the test mic is open
  assert.match(b, /voiceTest\.timer = setInterval/);
  assert.match(b, /if \(voiceTest\.mic\) \{ voiceTest\.mic\.close\(\); voiceTest\.mic = null; \}/);
});

test('composer: mic button next to attach, shown only when voice is enabled and ready', () => {
  assert.match(app, /id="mic-\$\{chatId\}" class="mic-btn" style="display:none"[^>]*title="Talk \(tap to start, tap to stop\)"/);
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

test('agent settings: Voice row, saved through the agent PATCH, with its SAVES row', () => {
  assert.match(as, /<select id="voice-select" onchange="saveAgentVoice\(\)"/);
  assert.match(as, /<option value="">Hub default<\/option>/);
  assert.match(as, /onclick="playAgentVoiceSample\(\)"/);
  assert.match(as, /\['saveAgentVoice', 'voice-status', byId\('voice-select'\)\],/);
  assert.match(as, /SAVES_ON_CHANGE = new Set\(\[[^\]]*'saveAgentVoice'\]\)/);
  assert.match(as, /method: 'PATCH'[^\n]*JSON\.stringify\(\{ voice: \{ voice: v, stt: 'local', tts: 'local' \} \}\)/);
  assert.match(as, /apiFetch\('\/api\/voice\/status'\)/);
  assert.match(as, /fetch\('\/api\/voice\/tts'/);
});

test('no variation selector U+FE0F in the new voice code', () => {
  assert.ok(!voiceBlock().includes('\uFE0F'));
  assert.ok(!as.slice(as.indexOf('id="voice-section"'), as.indexOf('id="compaction-section"')).includes('\uFE0F'));
  const css = html.slice(html.indexOf('/* Voice: mic button'), html.indexOf('.input-area button.secondary'));
  assert.ok(!css.includes('\uFE0F'));
});

// ── The voice block run against fake browser objects ──

function el(extra = {}) {
  const cls = new Set();
  return Object.assign({
    style: {}, dataset: {}, value: '', textContent: '', disabled: false,
    classList: { toggle(c, on) { if (on) cls.add(c); else cls.delete(c); }, contains: (c) => cls.has(c) },
    setAttribute() {}, focus() { this.focused = true; }, firstElementChild: { style: {} },
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
  const win = { AudioContext: FakeCtx, speechSynthesis: opts.noSynth ? undefined : { speak(u) { calls.utter.push(u.text); setImmediate(() => u.onend && u.onend()); }, cancel() { calls.cancelled = true; } } };
  const fetchFn = async (url, o = {}) => {
    calls.fetch.push({ url, o });
    if (url === '/api/voice/status') return { ok: true, json: async () => status };
    if (url.startsWith('/api/voice/stt')) return opts.stt ? opts.stt() : { ok: true, status: 200, json: async () => ({ text: 'hello there', ms: 5 }) };
    if (url === '/api/voice/tts') {
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
    isHubAdmin: () => true, hubEsc: String, dialogGuard: { savePoint: () => () => {}, markLoaded() {} },
    autoGrowTextarea() {},
    SpeechSynthesisUtterance: class { constructor(t) { this.text = t; } },
    voiceLoadPrefs: () => ({ micLevel: 80, readAloud: true, deviceVoiceFallback: !!opts.fallback }),
    voiceSavePrefs: (s, p) => { calls.saved = p; },
    voiceGainFromSlider: (v) => v / 10,
    voiceSliderFromGain: (g) => g * 10,
    voiceLevelDb: () => -20, voiceMeterPercent: () => 50,
    voiceResample: (f, from, to) => { calls.resample = [f.length, from, to]; return f; },
    voiceEncodeWav: (f, r) => { calls.wavRate = r; return new Uint8Array([82, 73, 70, 70]).buffer; },
    voiceSentences: (t) => t.split(/(?<=\.)\s+/).filter(Boolean),
    voiceSpeechText: (t) => t,
  };
  const names = Object.keys(stubs);
  const src = voiceBlock() + '\nreturn { voiceRefreshStatus, voiceOpenMic, voiceMicToggle, voiceMicStop, voiceSpeakText, voiceStopPlayback, voicePlay, voiceRec, voiceSettingEnable, voiceSettingsSavePrefs, voiceSettingsHtml, voiceReady };';
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
  assert.match(off.calls.toasts[0], /Voice is off/);
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
  api.voiceSettingsSavePrefs();
  assert.deepStrictEqual(calls.saved, { micLevel: 35, readAloud: false, deviceVoiceFallback: true });
});

test('settings: members get no enable switch, default voice or sample; admins do', () => {
  const admin = makeEnv().api.voiceSettingsHtml({});
  assert.match(admin, /st-voice-enabled/);
  assert.match(admin, /st-voice-default/);
  assert.match(admin, /Play sample/);
  const stubsSrc = voiceBlock().replace('const admin = isHubAdmin();', 'const admin = false;');
  const member = new Function('document', 'window', 'localStorage', 'voiceLoadPrefs', 'voiceGainFromSlider', 'chats', 'dialogGuard',
    stubsSrc + '\nreturn voiceSettingsHtml({});')({ getElementById() {}, body: { classList: {} }, addEventListener() {} }, {}, {}, () => ({ micLevel: 50 }), (v) => v, {}, {});
  assert.doesNotMatch(member, /st-voice-enabled|st-voice-default|Play sample/);
  assert.match(member, /st-voice-status/);
  assert.match(member, /id="st-voice-mic"/);
});
