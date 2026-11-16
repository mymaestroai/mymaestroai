'use strict';
// iOS round on both pages: the phone's Voice sheet can turn voice on (Enable voice, progress, failed / unsupported / non-admin wording),
// no looping focus element and strict talk-over on iOS, iOS device defaults in the prefs, the echo guard choices, the dictation message.
// The lib helpers (voiceDevicePrefs, voiceMarkDeviceSet, voiceEchoChoices ...) are stubbed here from their documented behaviour, so this file
// does not wait on the lib being synced into the pages.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const mob = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'mobile.html'), 'utf8');
const between = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, a + ' .. ' + b); return src.slice(i, j); };

// ── the Voice sheet: Enable voice ──
const paintSrc = between(mob, 'function paintVoiceSheet() {', 'function openVoiceSheet() {');
const sheetSrc = between(mob, 'function voiceSheet() {', 'function paintVoiceSheet() {');

function el() { return new Proxy({ hidden: false, textContent: '', value: '', checked: false, disabled: false, classList: { toggle() {}, contains: () => true, add() {}, remove() {} }, listeners: {} }, { get: (t, k) => (k in t ? t[k] : undefined), set: (t, k, v) => { t[k] = v; return true; } }); }

// One sheet and the page globals paintVoiceSheet / voiceSheetEnable use. status / me are what voiceStatus / hubMe hold; apiFn answers the POST.
function make({ status, me = { user: { id: 'u' }, isAdmin: true }, apiFn } = {}) {
  const els = {};
  for (const s of ['.vs-note', '.vs-enable', '.vs-enable-text', '.vs-enable-btn', '.vs-progress', '.vs-progress-line']) els[s] = el();
  const other = el();
  const sh = { classList: { contains: () => true }, querySelector: (s) => els[s] || other, querySelectorAll: () => [] };
  const log = { toasts: [], timers: [], cleared: 0, refreshes: 0, posts: [] };
  const state = { status };
  const api = apiFn ? (p, o) => { log.posts.push([p, o]); return apiFn(p, o); } : async () => ({ status: 200, ok: true, json: async () => ({ ok: true }) });
  const factory = new Function('$', 'voicePrefsNow', 'voiceEndPauseNow', 'voiceSpeedNow', 'voiceSpeedLabel', 'document', 'CallDisplay', 'voiceOn', 'getStatus', 'setStatus', 'hubMeGet',
    'VOICE_CALL_HELP', 'voiceLoudnessFor', 'api', 'toast', 'voiceStatusRefresh', 'setTimeout', 'clearTimeout',
    'let voiceStatus = getStatus(); const hubMe = hubMeGet();\n' + paintSrc.replace(/voiceStatus = \{ \.\.\.voiceStatus, platformSupported: false \};/, 'voiceStatus = { ...voiceStatus, platformSupported: false }; setStatus(voiceStatus);') +
    '\nreturn { paintVoiceSheet, voiceSheetEnable, voiceSheetPollStop, setLocal: (s) => { voiceStatus = s; } };');
  const api2 = factory((id) => (id === 'voice-sheet' ? sh : null), () => ({ micLevel: 50, interruptSensitivity: 50, mode: 'tap', echoHold: 600 }), () => 1200, () => 1, () => '1x', { activeElement: null }, undefined,
    () => !!(state.status && state.status.enabled && state.status.ready), () => state.status, (s) => { state.status = s; }, () => me, '', () => 'louder', api,
    (t) => log.toasts.push(t), () => { log.refreshes++; }, (fn, ms) => { log.timers.push(ms); return log.timers.length; }, () => { log.cleared++; });
  return { els, log, state, ...api2 };
}

test('admin, voice off: "Voice is off." with the Enable voice block, its wording and the button', () => {
  const t = make({ status: { enabled: false, ready: false, platformSupported: true } });
  t.paintVoiceSheet();
  assert.strictEqual(t.els['.vs-note'].textContent, 'Voice is off.');
  assert.strictEqual(t.els['.vs-enable'].hidden, false);
  assert.strictEqual(t.els['.vs-enable-text'].textContent, 'Enable voice downloads the speech recognition and the voices to the computer your Maestro runs on and installs them there. It takes a few minutes, and you can keep chatting meanwhile.');
  assert.strictEqual(t.els['.vs-enable-text'].hidden, false);
  assert.strictEqual(t.els['.vs-enable-btn'].hidden, false);
  assert.strictEqual(t.els['.vs-enable-btn'].textContent, 'Enable voice');
  assert.strictEqual(t.els['.vs-progress'].hidden, true);
});

test('non-admin (and a page that does not know yet): admin wording, no button', () => {
  for (const me of [{ user: { id: 'm' }, isAdmin: false }, null]) {
    const t = make({ status: { enabled: false, ready: false, platformSupported: true }, me });
    t.paintVoiceSheet();
    assert.strictEqual(t.els['.vs-note'].textContent, 'Voice is off. An admin of your Maestro can turn it on, from the Voice menu on their phone or in Settings, Voices on the computer.');
    assert.strictEqual(t.els['.vs-enable'].hidden, true);
    assert.strictEqual(t.els['.vs-enable-btn'].hidden, true);
  }
});

test('platform not supported: the wording, no button, for an admin too', () => {
  const t = make({ status: { enabled: false, ready: false, platformSupported: false } });
  t.paintVoiceSheet();
  assert.strictEqual(t.els['.vs-note'].textContent, "Voice can't run on the computer your Maestro is on yet. It works on Linux (x64) and Mac computers.");
  assert.strictEqual(t.els['.vs-enable-btn'].hidden, true);
  assert.strictEqual(t.els['.vs-enable'].hidden, true);
});

test('installing (anyone): the progress bar value and the line, the button hidden, one 2 s refresh timer', () => {
  for (const me of [{ user: {}, isAdmin: true }, { user: {}, isAdmin: false }]) {
    const t = make({ status: { enabled: true, ready: false, installing: true, step: 'downloading voices', progress: 0.42, platformSupported: true }, me });
    t.paintVoiceSheet(); t.paintVoiceSheet();
    assert.strictEqual(t.els['.vs-progress'].hidden, false);
    assert.strictEqual(t.els['.vs-progress'].value, 0.42);
    assert.strictEqual(t.els['.vs-progress-line'].hidden, false);
    assert.strictEqual(t.els['.vs-progress-line'].textContent, 'Installing voice: downloading voices 42%');
    assert.strictEqual(t.els['.vs-enable-btn'].hidden, true);
    assert.deepStrictEqual(t.log.timers, [2000], 'one timer, not one per paint');
  }
  const d = make({ status: { enabled: true, installing: true } });
  d.paintVoiceSheet();
  assert.strictEqual(d.els['.vs-progress-line'].textContent, 'Installing voice: working 0%', 'default step');
});

test('the refresh timer runs only while installing / enabled but not ready; it stops when the sheet closes (voiceSheetPollStop) and when voice is on', () => {
  const t = make({ status: { enabled: true, ready: false, platformSupported: true } });
  t.paintVoiceSheet();
  assert.deepStrictEqual(t.log.timers, [2000], 'on but not ready: polls');
  t.state.status = { enabled: true, ready: true };
  t.paintVoiceSheet();
  assert.ok(t.log.cleared >= 1, 'ready: the timer is stopped');
  const f = make({ status: { enabled: false, failed: true, error: 'x' } });
  f.paintVoiceSheet();
  assert.deepStrictEqual(f.log.timers, [], 'failed: no polling');
  assert.match(sheetSrc, /const close = \(\) => \{[^\n]*voiceSheetPollStop\(\);/, 'closing the sheet stops it');
});

test('on but not installed (an install that stopped): the admin gets "Try again", a member no button', () => {
  let t = make({ status: { enabled: true, ready: false, installing: false, platformSupported: true } });
  t.paintVoiceSheet();
  assert.strictEqual(t.els['.vs-note'].textContent, 'Voice is on, but not ready on your Maestro yet.');
  assert.strictEqual(t.els['.vs-enable'].hidden, false);
  assert.strictEqual(t.els['.vs-enable-btn'].textContent, 'Try again');
  assert.strictEqual(t.els['.vs-enable-btn'].hidden, false);
  t = make({ status: { enabled: true, ready: false, installing: false, platformSupported: true }, me: { user: {}, isAdmin: false } });
  t.paintVoiceSheet();
  assert.strictEqual(t.els['.vs-enable'].hidden, true);
  assert.strictEqual(t.els['.vs-enable-btn'].hidden, true);
});

test('failed: the admin sees the error and "Try again"; a member the pointer to Settings, no button', () => {
  let t = make({ status: { enabled: true, ready: false, failed: true, error: 'no disk space' } });
  t.paintVoiceSheet();
  assert.strictEqual(t.els['.vs-note'].textContent, 'Voice setup failed: no disk space');
  assert.strictEqual(t.els['.vs-enable-btn'].textContent, 'Try again');
  assert.strictEqual(t.els['.vs-enable-btn'].hidden, false);
  t = make({ status: { enabled: true, ready: false, failed: true } });
  t.paintVoiceSheet();
  assert.strictEqual(t.els['.vs-note'].textContent, 'Voice setup failed: unknown error');
  t = make({ status: { enabled: true, ready: false, failed: true, error: 'secret' }, me: { user: {}, isAdmin: false } });
  t.paintVoiceSheet();
  assert.strictEqual(t.els['.vs-note'].textContent, 'Voice setup failed. An admin of your Maestro can see the details in Settings, Voices on the computer.');
  assert.ok(!t.els['.vs-note'].textContent.includes('secret'));
  assert.strictEqual(t.els['.vs-enable-btn'].hidden, true);
});

test('voice on and enabled-but-not-ready keep their wording ("your Maestro" instead of "the hub")', () => {
  let t = make({ status: { enabled: true, ready: true, stt: { engine: 'whisper' } } });
  t.paintVoiceSheet();
  assert.match(t.els['.vs-note'].textContent, /^Voice is on \(whisper\)\. Tap the mic beside the message box to dictate\.$/);
  assert.strictEqual(t.els['.vs-enable'].hidden, true);
  t = make({ status: { enabled: true, ready: false } });
  t.paintVoiceSheet();
  assert.strictEqual(t.els['.vs-note'].textContent, 'Voice is on, but not ready on your Maestro yet.');
});

test('the click posts /api/voice/enable with the page api(), disables the button meanwhile, then refreshes the status', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const t = make({ status: { enabled: false, ready: false, platformSupported: true }, apiFn: async () => { await gate; return { status: 200, ok: true, json: async () => ({ ok: true, status: {} }) }; } });
  t.paintVoiceSheet();
  const p = t.voiceSheetEnable();
  assert.strictEqual(t.els['.vs-enable-btn'].disabled, true, 'disabled while the request runs');
  release(); await p;
  assert.strictEqual(t.log.posts.length, 1);
  assert.strictEqual(t.log.posts[0][0], '/api/voice/enable');
  assert.strictEqual(t.log.posts[0][1].method, 'POST');
  assert.strictEqual(t.log.posts[0][1].headers['Content-Type'], 'application/json');
  assert.strictEqual(t.els['.vs-enable-btn'].disabled, false);
  assert.strictEqual(t.log.refreshes, 1);
  assert.deepStrictEqual(t.log.toasts, []);
  assert.match(sheetSrc, /sh\.querySelector\('\.vs-enable-btn'\)\.addEventListener\('click', voiceSheetEnable\)/);
});

test('403: "Only an admin can turn voice on."; 400 platform_unsupported paints the unsupported text; other errors toast the message', async () => {
  let t = make({ status: { enabled: false, platformSupported: true }, apiFn: async () => ({ status: 403, ok: false, json: async () => ({ error: 'admin_only' }) }) });
  t.paintVoiceSheet(); await t.voiceSheetEnable();
  assert.deepStrictEqual(t.log.toasts, ['Only an admin can turn voice on.']);
  assert.strictEqual(t.log.refreshes, 1);
  t = make({ status: { enabled: false, platformSupported: true }, apiFn: async () => ({ status: 400, ok: false, json: async () => ({ error: 'platform_unsupported' }) }) });
  t.paintVoiceSheet(); await t.voiceSheetEnable();
  assert.match(t.els['.vs-note'].textContent, /^Voice can't run on the computer your Maestro is on yet/);
  assert.strictEqual(t.els['.vs-enable-btn'].hidden, true);
  t = make({ status: { enabled: false, platformSupported: true }, apiFn: async () => ({ status: 500, ok: false, json: async () => ({ error: 'disk full' }) }) });
  t.paintVoiceSheet(); await t.voiceSheetEnable();
  assert.deepStrictEqual(t.log.toasts, ['Could not turn voice on: disk full']);
  t = make({ status: { enabled: false, platformSupported: true }, apiFn: async () => { throw new Error('offline'); } });
  t.paintVoiceSheet(); await t.voiceSheetEnable();
  assert.deepStrictEqual(t.log.toasts, ['Could not turn voice on: offline']);
  assert.strictEqual(t.els['.vs-enable-btn'].disabled, false, 're-enabled after an error');
});

test('the sheet markup has the block under .vs-note, and the CSS matches .vs-note', () => {
  const i = sheetSrc.indexOf('<p class="vs-note"></p>'), j = sheetSrc.indexOf('<div class="vs-enable" hidden>');
  assert.ok(i > 0 && j > i && j - i < 60, 'right under .vs-note');
  for (const frag of ['<p class="vs-enable-text"></p>', '<button type="button" class="vs-btn vs-enable-btn">Enable voice</button>', '<progress class="vs-progress" max="1" hidden></progress>', '<p class="vs-progress-line" aria-live="polite"></p>']) assert.ok(sheetSrc.includes(frag), frag);
  assert.match(html, /\.vs-progress \{[^}]*width: 100%/);
  assert.match(html, /\.vs-enable-text[^{]*\{[^}]*border-radius: 10px/);
  assert.ok(!/the hub/.test(paintSrc.replace(/hub voice/g, '')), 'no "the hub" wording left in the sheet text');
});

// ── no focus loop on iOS; strict talk-over ──
const startBody = between(mob, 'function voiceCallStart() {', '\n}\n');
test('phone call start: the focus loop is not created on iOS (the hint is shown), created and started elsewhere', () => {
  const block = between(startBody, 'if (voiceIsIOS()) {', '// A call with an agent that keeps recordings');
  const run = (ios) => {
    const calls = { created: 0, started: 0, hints: [] };
    const win = {};
    const vc = {};
    const voiceCall = vc;
    const create = () => { calls.created++; return { start: () => { calls.started++; return Promise.resolve(true); } }; };
    new Function('voiceIsIOS', 'voiceCreateAudioFocus', 'voiceFocusHint', 'window', 'document', 'URL', 'Blob', 'vc', 'voiceCall',
      block)(() => ios, create, (s) => calls.hints.push(s), win, {}, URL, Blob, vc, voiceCall);
    return new Promise((r) => setImmediate(() => r({ calls, vc })));
  };
  return Promise.all([run(true), run(false)]).then(([ios, other]) => {
    assert.deepStrictEqual(ios.calls, { created: 0, started: 0, hints: [true] });
    assert.strictEqual(ios.vc.focus, undefined);
    assert.strictEqual(other.calls.created, 1); assert.strictEqual(other.calls.started, 1);
    assert.deepStrictEqual(other.calls.hints, [false], 'the hint only when the focus sound was refused');
    assert.ok(other.vc.focus);
  });
});
test('phone: voiceIsIOS() is voiceIsIOSNav(navigator): one rule', () => {
  const fn = between(mob, 'function voiceIsIOS() {', '\nfunction voiceCanStayHidden');
  assert.ok(fn.includes('voiceIsIOSNav(navigator)'));
  assert.ok(!/iPhone\|iPad/.test(fn), 'no second copy of the user-agent test');
  const f = new Function('voiceIsIOSNav', 'navigator', fn + '\nreturn voiceIsIOS;');
  assert.strictEqual(f((n) => n.ios, { ios: true })(), true);
  assert.strictEqual(f(() => { throw new Error('x'); }, {})(), false);
});
test('strictTalkOver is passed to voiceCreateVad: voiceIsIOS() on the phone, voiceIsIOSNav(navigator) on the desktop', () => {
  assert.match(startBody, /voiceCreateVad\(\{[^}]*strictTalkOver: voiceIsIOS\(\)(, micChoice: voiceMicChoiceId)?(, bluetoothFirst: voiceIsAndroidNav\(navigator\))? \}\)/);
  assert.match(app, /voiceCreateVad\(\{ baseUrl: '\/api\/voice\/web\/'[^}]*strictTalkOver: voiceIsIOSNav\(navigator\)(, micChoice: voiceMicChoiceId)?(, bluetoothFirst: voiceIsAndroidNav\(navigator\))? \}\)/);
  assert.match(app, /typeof voiceCreateAudioFocus === 'function' && typeof navigator !== 'undefined' && \/Android\/i\.test/, 'the desktop page still starts focus only on Android');
});

// ── prefs ──
test('phone voicePrefsNow() returns voiceDevicePrefs(voiceLoadPrefs(localStorage), ios)', () => {
  const src = between(mob, 'function voicePrefsNow() {', '\nfunction voiceEndPauseNow');
  const seen = [];
  const f = new Function('voiceDevicePrefs', 'voiceLoadPrefs', 'voiceIsIOS', 'localStorage', src + '\nreturn voicePrefsNow;');
  const now = f((p, ios) => { seen.push(['dev', ios]); return { ...p, dev: ios }; }, (ls) => { seen.push(['load', ls]); return { micLevel: 40 }; }, () => true, 'LS');
  assert.deepStrictEqual(now(), { micLevel: 40, dev: true });
  assert.deepStrictEqual(seen, [['load', 'LS'], ['dev', true]]);
});
test('phone voicePrefsSave marks a device default the person changed (and only that), keeping agent-default marking', () => {
  const src = between(mob, 'function voicePrefsSave(patch) {', '\n// The agent\'s voice defaults');
  const mk = (cur) => {
    const saved = [];
    const f = new Function('voicePrefsNow', 'VOICE_AGENT_DEFAULT_KEYS', 'VOICE_DEVICE_DEFAULT_KEYS', 'voiceMarkChosen', 'voiceMarkDeviceSet', 'voiceSavePrefs', 'localStorage', src + '\nreturn voicePrefsSave;');
    const save = f(() => cur, ['endPause'], ['loudness', 'echoHold'], (p, k) => ({ ...p, chosen: k }), (p, k) => ({ ...p, set: [...(p.set || []), ...k] }), (ls, p) => { saved.push(p); return p; }, {});
    return { save, saved };
  };
  const iosCur = { loudness: 'normal', echoHold: 1200, endPause: 1200 };
  let t = mk(iosCur);
  assert.deepStrictEqual(t.save({ echoHold: 1500 }).set, ['echoHold']);
  assert.deepStrictEqual(t.save({ loudness: 'normal' }).set, undefined, 'the same value as the iOS default is not a choice');
  assert.deepStrictEqual(t.save({ loudness: 'louder', echoHold: 600 }).set, ['loudness', 'echoHold']);
  assert.deepStrictEqual(t.save({ micLevel: 70 }).set, undefined, 'other keys never mark');
  const p = t.save({ endPause: 2000, echoHold: 1000 });
  assert.deepStrictEqual(p.chosen, ['endPause']); assert.deepStrictEqual(p.set, ['echoHold']);
  assert.strictEqual(t.saved.length, 5);
});
test('desktop voicePrefsNow() applies voiceDevicePrefs; its saves mark device defaults the person changed', () => {
  assert.match(app, /voicePrefsCache = voiceDevicePrefs\(voiceLoadPrefs\(localStorage\) \|\| \{\}, voiceIsIOSNav\(navigator\)\)/);
  const src = between(app, 'function voiceMarkDeviceChanged(prefs, cur) {', '\n    function voiceMicLevelNow');
  const f = new Function('VOICE_DEVICE_DEFAULT_KEYS', 'voiceMarkDeviceSet', src + '\nreturn voiceMarkDeviceChanged;')(['loudness', 'echoHold'], (p, k) => ({ ...p, set: k }));
  assert.deepStrictEqual(f({ loudness: 'normal', echoHold: 1500 }, { loudness: 'normal', echoHold: 1200 }).set, ['echoHold']);
  assert.strictEqual(f({ loudness: 'normal', echoHold: 1200 }, { loudness: 'normal', echoHold: 1200 }).set, undefined);
  // the three desktop save paths use it
  assert.match(app, /prefs = voiceMarkDeviceChanged\(prefs, voicePrefsNow\(\)\);   \/\/ an iPhone default/);
  assert.match(app, /voicePrefsCache = voiceMarkDeviceChanged\(\{ \.\.\.prevPrefs, \[key\]: val \}, prevPrefs\)/);
  assert.match(app, /prefs = voiceMarkDeviceChanged\(prefs, voicePrefsNow\(\)\);   \/\/ the check picked a new echo guard/);
});

// ── echo guard choices ──
const CHOICES = (ios) => (ios ? [0, 600, 1000, 1200, 1500] : [0, 600, 1000, 1500]);
const LABEL = (ms) => (ms === 0 ? 'off' : ms % 1000 === 0 ? ms / 1000 + ' s' : ms / 1000 + ' s');
test('phone echo select options: 1.2 s only on iOS, labels match values', () => {
  const src = between(mob, 'function voiceEchoLabel(ms) {', 'const VOICE_ECHO_HINT');
  const f = (ios) => new Function('voiceEchoChoices', 'voiceEchoHoldLabel', 'voiceIsIOS', src + '\nreturn voiceEchoOptionsHtml;')(CHOICES, LABEL, () => ios)();
  const opts = (h) => [...h.matchAll(/<option value="(\d+)">([^<]+)<\/option>/g)].map((m) => [m[1], m[2]]);
  assert.deepStrictEqual(opts(f(true)), [['0', 'Off'], ['600', '0.6 s'], ['1000', '1 s'], ['1200', '1.2 s'], ['1500', '1.5 s']]);
  assert.deepStrictEqual(opts(f(false)), [['0', 'Off'], ['600', '0.6 s'], ['1000', '1 s'], ['1500', '1.5 s']]);
  assert.ok(!/VOICE_ECHO_LABELS/.test(mob), 'no index lookup into a label list any more');
  assert.strictEqual((mob.match(/voiceEchoOptionsHtml\(\)/g) || []).length, 3, 'its definition, the Voice sheet and #voice-panel');
});
test('desktop echo select options: 1.2 s only on iOS', () => {
  const src = between(app, 'function voiceEchoSelectHtml(id, attrs) {', '\n    function voiceKeepAliveNow');
  const f = (ios) => new Function('voiceEchoHoldNow', 'voiceEchoChoices', 'voiceEchoHoldLabel', 'voiceIsIOSNav', 'navigator', src + '\nreturn voiceEchoSelectHtml;')(() => 1200, CHOICES, LABEL, () => ios, {})('x', '');
  assert.match(f(true), /<option value="1200" selected>1\.2 s<\/option>/);
  assert.ok(!f(false).includes('1200'));
  assert.match(f(false), /<option value="0">Off<\/option><option value="600">0\.6 s<\/option><option value="1000">1 s<\/option><option value="1500">1\.5 s<\/option>/);
});
test('every page-side echo validity check outside the shared blocks uses voiceEchoHoldOk', () => {
  const strip = (src) => src.replace(/\/\/ ── voice helpers \(begin\) ──[\s\S]*?\/\/ ── voice helpers \(end\) ──/, '').replace(/\/\/ ── voice call \(begin\) ──[\s\S]*?\/\/ ── voice call \(end\) ──/, '');
  assert.ok(!/VOICE_ECHO_HOLDS\.includes/.test(strip(mob)));
  assert.ok(!/VOICE_ECHO_HOLDS/.test(strip(app)));
  assert.strictEqual((strip(app).match(/voiceEchoHoldOk\(/g) || []).length, 3);
});

// ── dictation ──
test('dictation: an empty transcript says "I didn\'t catch that." on the phone; the desktop already has its own empty-transcript message', () => {
  assert.ok(mob.includes('if (!text) throw new Error("I didn\'t catch that.");'));
  assert.ok(!mob.includes('I did not catch that'));
  assert.match(app, /if \(!text\) \{ hubToast\('No speech was heard\./);
});

// ── the pages' detector wrappers pass endPiece through (the frame watchdog ends a piece through it; without it what was heard is lost) ──
test('desktop: voiceDispVad passes endPiece through to the detector', async () => {
  const line = app.match(/function voiceDispVad\(vad\) \{[^\n]*\}/);
  assert.ok(line, 'voiceDispVad found');
  let called = 0;
  const wrapped = new Function('voiceDisp', line[0] + '\nreturn voiceDispVad;')({ floor: null })({ endPiece: async () => { called++; return true; } });
  assert.strictEqual(typeof wrapped.endPiece, 'function');
  assert.strictEqual(await wrapped.endPiece(), true);
  assert.strictEqual(called, 1);
});
test('phone: the call\'s vad wrapper passes endPiece through to vc.vad', () => {
  const w = mob.match(/setPlaybackActive: \(on, now\) => vc\.vad\.setPlaybackActive[^\n]*/);
  assert.ok(w, 'the wrapper line found');
  assert.match(w[0], /endPiece: \(\) => vc\.vad\.endPiece\(\)/);
});
