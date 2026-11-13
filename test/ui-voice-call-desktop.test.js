'use strict';
// Voice phase 2, desktop page (P2): the hands-free call wired into app.js and index.html. Source-level checks, plus the
// call wiring block of app.js run against fakes (a recording stand-in for the controller, so the deps and the event
// feed are checked; the controller itself is tested in test/ui-voice-call.test.js).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js');
const html = read('index.html');
const CALL = require('../lib/ui-voice-call');

const START = '    // ── Hands-free call (voice phase 2)';
const END = '    // Message rendering\n';
function wiring() {
  const a = app.indexOf(START), b = app.indexOf(END, a);
  assert.ok(a > 0 && b > a, 'call wiring block found');
  return app.slice(a, b);
}
const flush = () => new Promise((r) => setImmediate(r));

test('mic button: hands-free starts a call, tap mode keeps dictation, a call turns the button into Hang up', () => {
  const m = app.slice(app.indexOf('async function voiceMicToggle('), app.indexOf('async function voiceMicStop('));
  assert.match(m, /if \(voiceCallS\.active \|\| voiceCallS\.starting\) \{ voiceCallHangUp\(\); return; \}/);
  assert.match(m, /if \(voicePrefsNow\(\)\.mode !== 'tap'\) \{ voiceCallStart\(chatId\); return; \}/);
  assert.ok(m.indexOf('voiceReady()') < m.indexOf('voiceCallStart('), 'only when voice is enabled and ready');
  assert.ok(m.indexOf('voiceCallStart(') < m.indexOf('voiceRec.guard.begin()'), 'dictation code is untouched below');
  const w = wiring();
  assert.match(w, /b\.setAttribute\('aria-label', on \? 'Hang up' : 'Dictate'\)/);
  assert.match(w, /voiceRec\.guard\.cancel\(\); if \(voiceRec\.chatId\) voiceMicStop\(false\);/, 'starting a call ends dictation first');
  assert.match(w, /voiceStopPlayback\(\);\s*const vad = voiceCreateVad\(/);
  assert.match(w, /if \(S\.call\) return;/, 'one call at a time');
});

test('send path: voice: true only for messages that came from a call', () => {
  assert.match(app, /async function sendSoloMessage\(chatId, retryCount = 0, sendOpts = null\)/);
  assert.match(app, /if \(!retryCount\) chat\.voiceSend = !!\(sendOpts && sendOpts\.voice\);/);
  assert.match(app, /images: imagesToSend,\s*\.\.\.\(chat\.voiceSend \? \{ voice: true \} : \{\}\)/);
  assert.match(wiring(), /sendSoloMessage\(chatId, 0, \{ voice: true, onSendResult: accepted \}\)/);
});

test('hub events: the call listens to turn, ask and voice events on the one EventSource', () => {
  assert.match(app, /for \(const t of \['turn_start', 'turn_delta', 'turn_activity', 'turn_end', 'ask_user', 'ask_user_done', 'voice_held', 'voice_held_done', 'voice_call'\]\) \{\s*source\.addEventListener\(t, e => \{ const ev = parse\(e\); if \(ev\) voiceCallHubEvent\(t, ev\); \}\);/);
});

test('settings: Talk mode, Interrupt sensitivity, Room check; the phase-1 hint is replaced', () => {
  assert.match(app, /id="st-voice-mode"[^`]*Hands-free<\/option><option value="tap"[^`]*Tap to talk/);
  assert.match(app, /id="st-voice-sens"[^`]*oninput="voiceSettingSensInput\(this\)"/);
  assert.match(app, /id="st-voice-room" type="button" onclick="voiceRoomCheckRun\(\)">Room check</);
  assert.ok(!app.includes('Hands-free conversation comes next'));
  assert.ok(app.includes('Tap the microphone in a chat to start a hands-free call'));
});

test('call bar: help line, switch, sliders, buttons and the dark-theme CSS', () => {
  const w = wiring();
  assert.ok(w.includes("Hands-free works with the page open and the screen on, also through a car\\'s Bluetooth hands-free or a Bluetooth speaker. Locked-screen use and car apps (CarPlay, Android Auto) are not supported."));
  for (const s of ['Do not disturb', 'Mic level', 'Interrupt sensitivity', 'Hang up', "'Now'", "'Later'", "'Skip'", 'Hearing you', 'Listening', 'Thinking', 'Speaking', 'Starting']) assert.ok(w.includes(s), s);
  assert.match(w, /area\.parentNode\.insertBefore\(bar, area\)/, 'above the message box');
  assert.match(w, /voiceCallS\.call\.setMode\(t\.checked \? 'dnd' : 'announce'\)/);
  assert.match(w, /voiceCallS\.call\.decide\(t\.dataset\.id, t\.dataset\.choice\)/);
  for (const sel of ['.voice-callbar', '.vcb-hang', '.vcb-item', '.vcb-help', '.input-area .mic-btn.call']) assert.ok(html.includes(sel), sel);
  assert.match(html, /\.voice-callbar \{[^}]*var\(--bg-card\)/);
  assert.match(w, /<svg viewBox/, 'the hang-up icon is an inline SVG');
});

test('wake lock, visibility and leaving: re-acquire on return, release on hang-up, hidden tab keeps the call, pagehide hangs up', () => {
  const w = wiring();
  assert.match(w, /navigator\.wakeLock\.request\('screen'\)/);
  // round 2 (voice fixes): a visible page with no call may show "The call ended when you left the app"; the wake-lock re-acquire stays
  assert.match(w, /document\.addEventListener\('visibilitychange', \(\) => \{[^]*?if \(document\.hidden\) return;\s*if \(voiceCallS\.call\) voiceCallWake\(true\); else voiceLeftNoticeShow\(\);/);
  assert.match(w, /voiceCallWake\(false\);/);
  // round 2: leaving the page is an immediate release (call.release), not a wait for the hub
  assert.match(w, /window\.addEventListener\('pagehide', \(\) => \{ voiceCallRelease\('pagehide'\); \}\)/);
  assert.match(app, /if \(voiceCallS\.chatId === chatId\) voiceCallHangUp\(\);/, 'closing the chat panel hangs up');
});

test('no U+FE0F, zero-width characters or emoji icons in the new wiring and CSS', () => {
  const css = html.slice(html.indexOf('/* Voice call:'), html.indexOf('.message > .msg-speak {'));
  for (const s of [wiring(), css]) {
    assert.ok(!/[\uFE0F\u200B\u200C\u200D\u2060\uFEFF]/.test(s));
  }
  const bar = wiring().slice(wiring().indexOf('function voiceCallBarHtml'), wiring().indexOf('function voiceCallShowBar'));
  assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(bar), 'no emoji in the bar');
});

// ── The wiring block run against fakes ──

function el(extra = {}) {
  const cls = new Set(), attrs = {};
  const e = Object.assign({
    style: {}, dataset: {}, value: '', textContent: '', innerHTML: '', disabled: false, isConnected: true,
    classList: { toggle(c, on) { if (on) cls.add(c); else cls.delete(c); }, contains: (c) => cls.has(c) },
    setAttribute(k, v) { attrs[k] = v; }, attrs, title: '',
    remove() { e.removed = true; e.isConnected = false; delete e.registry[e.id]; },
  }, extra);
  return e;
}

function makeEnv(opts = {}) {
  const calls = { fetch: [], toasts: [], notices: [], appended: [], sent: [], stops: [], closed: [], created: [], saved: [], vadCalls: [], spoken: [], wake: [] };
  const els = {};
  const get = (id) => { if (!els[id]) els[id] = el({ id, registry: els }); return els[id]; };
  const area = { parentNode: { insertBefore(bar) { calls.bar = bar; els[bar.id] = bar; bar.registry = els; bar.isConnected = true; } } };
  get('input-c1').closest = () => area;
  get('input-c1').value = 'half typed';
  get('messages-c1');
  get('mic-c1').innerHTML = '<svg>mic</svg>';
  const fetchFn = async (url, o = {}) => {
    calls.fetch.push({ url, body: o.body && typeof o.body === 'string' ? JSON.parse(o.body) : o.body, o });
    if (opts.fetch) { const r = opts.fetch(url, o); if (r) return r; }
    if (url === '/api/voice/call') return { ok: true, status: 200, json: async () => ({ ok: true, call: { mode: 'announce', held: opts.held || [] } }) };
    if (url.startsWith('/api/voice/stt')) return { ok: true, status: 200, json: async () => ({ text: 'hello' }) };
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  };
  const fakeCall = {
    callId: 'c-1', started: 0, hung: 0, replies: [], activities: [], asks: [], askDone: [], held: [], heldDone: [], modes: [], decisions: [],
    async start() { fakeCall.started++; return opts.startOk !== false; },
    hangUp() { fakeCall.hung++; return Promise.resolve([]); },
    onReplyText(t, d) { fakeCall.replies.push([t, d]); }, onActivity(i) { fakeCall.activities.push(i); },
    onAsk(a) { fakeCall.asks.push(a); }, onAskDone(id) { fakeCall.askDone.push(id); },
    onHeld(i, q) { fakeCall.held.push([i, q]); }, onHeldDone(id, choice) { fakeCall.heldDone.push([id, choice]); },
    setMode(m) { fakeCall.modes.push(m); }, decide(id, c) { fakeCall.decisions.push([id, c]); },
  };
  const vad = { setMicLevel(v) { calls.vadCalls.push(['mic', v]); }, setInterruptSensitivity(v) { calls.vadCalls.push(['sens', v]); }, setEndPause(v) { calls.vadCalls.push(['pause', v]); } };
  const chats = { c1: { agent: 'alice', status: 'idle', pendingImages: [] } };
  const agentStatus = {};
  let prefs = { micLevel: 60, interruptSensitivity: 40, mode: 'handsfree' };
  let clock = 0;
  const stubs = {
    document: { getElementById: get, querySelectorAll: () => [], addEventListener() {}, createElement: () => el({ registry: els, listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } }) },
    navigator: { wakeLock: { request: async (k) => { calls.wake.push(k); const w = { release: async () => { calls.wake.push('release'); }, addEventListener() {} }; return w; } } },
    localStorage: {},
    fetch: fetchFn,
    hubToast: (t) => calls.toasts.push(t),
    hubEsc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    hubOriginLabel: (o) => 'label of ' + (o && o.kind),
    chats, agentStatus, closeQuestion: (id) => calls.closed.push(id),
    appendMessage: (c, r, t) => calls.appended.push([c, r, t]),
    appendSystemNotice: (c, t) => calls.notices.push([c, t]),
    stopAgentTurn: (a) => calls.stops.push(a),
    sendSoloMessage: async (c, n, o) => {
      calls.sent.push({ c, n, o: { voice: o.voice }, text: els['input-c1'].value });
      if (opts.sendFails) o.onSendResult(new Error('HTTP 500: Internal'));
      else if (opts.sendOk) o.onSendResult(null);
    },
    voicePrefsNow: () => prefs, voiceMicLevelNow: () => prefs.micLevel, voiceSensNow: () => prefs.interruptSensitivity,
    // voice fixes 1: pause before done, voice speed (the real ones are in app.js outside the wiring block)
    voiceEndPauseNow: () => prefs.endPause || 1200, voiceSpeedNow: () => prefs.voiceSpeed || 1, voiceSpeedLabel: (v) => Number(v).toFixed(2) + 'x',
    voiceCleanSpeed: (v) => Math.round(Math.max(0.75, Math.min(1.5, Number(v))) * 20) / 20,
    voicePauseSelectHtml: (id, attrs) => `<select id="${id}" ${attrs}></select>`, VOICE_SPEED_HINT: 'Google voices ignore this setting.',
    voiceSavePrefs: (s, p) => { prefs = p; calls.saved.push(p); },
    voicePrefsCacheSet: null,
    voiceById: (id) => get(id), voiceReady: () => opts.ready !== false,
    voiceRec: { guard: { cancel() { calls.recCancel = true; }, pending: false }, chatId: null, busy: false },
    voiceTest: { mic: null, guard: { pending: false } },
    voiceMicStop() {},
    voiceStopPlayback() { stubs.voicePlay.token++; calls.stopPlayback = (calls.stopPlayback || 0) + 1; },
    voicePlay: { token: 0 },
    // the real one stops the previous playback first (one step on the token); a cut is a further step
    voiceSpeakText: async (agent, text, btn, o) => { stubs.voicePlay.token++; calls.spoken.push([agent, text, o.sentences]); if (opts.cutSpeech) stubs.voicePlay.token++; },
    VOICE_MIC_SVG: '<svg>mic</svg>',
    voiceSentences: (t) => String(t).split(/(?<=[.!?])\s+/).filter(Boolean),
    voiceSpeechText: (t) => String(t),
    voiceEncodeWav: (f, r) => { calls.wavRate = r; return new Uint8Array([1]).buffer; },
    voiceBusyToast: () => false, voiceRefreshStatus() {},
    VOICE_ECHO_HOLDS: [0, 600, 1000, 1500], voiceMeterPercent: (db) => Math.round(Math.max(0, Math.min(100, (db + 60) / 0.6))),
    voiceCreateVad: (o) => { calls.vadOpts = o; return vad; },
    voiceCreateCall: (deps) => { calls.created.push(deps); return fakeCall; },
    voiceRoomCheck: CALL.voiceRoomCheck, voiceCallMedian: (l) => { const a = l.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; },
    voiceOpenMic: opts.openMic || (async (lvl, onChunk) => { calls.micOpened = lvl; stubs.__onChunk = onChunk; return { close() { calls.micClosed = true; } }; }),
    voiceLevelDb: (d) => d[0], voiceMicError: (e) => 'mic: ' + e.message,
    setTimeout: (fn, ms) => { clock += ms; setImmediate(fn); return 1; }, clearTimeout() {},
    Date: { now: () => clock },
    window: { addEventListener() {} },
  };
  let micFeed = null;
  if (opts.roomSpeech) {
    stubs.voiceOpenMic = async (lvl, onChunk) => { calls.micOpened = lvl; micFeed = onChunk; return { close() { calls.micClosed = true; } }; };
    // every 100 ms tick feeds one frame: speech level in the first half, quiet level in the second
    const realSet = stubs.setTimeout;
    stubs.setTimeout = (fn, ms) => { if (micFeed) micFeed(Float32Array.from([clock < 2500 ? opts.roomSpeech : opts.roomQuiet])); return realSet(fn, ms); };
  }
  const names = Object.keys(stubs);
  const src = wiring() + '\nreturn { voiceCallS, voiceRoom, voiceCallStart, voiceCallHangUp, voiceCallHubEvent, voiceCallDeps, voiceCallSlider, voiceRoomCheckRun, voiceCallPaintHeld, voiceCallSend, voiceCallInterject, voiceCallSpeak, voiceCallStt, voiceCallAnswerAsk };';
  const api = new Function(...names, src)(...names.map(n => stubs[n]));
  return { api, calls, chats, get, els, fakeCall, agentStatus, stubs, getPrefs: () => prefs };
}

test('start: deps contract, VAD options from prefs, bar above the box, button becomes Hang up, wake lock', async () => {
  const { api, calls, fakeCall, get } = makeEnv();
  await api.voiceCallStart('c1');
  assert.strictEqual(fakeCall.started, 1);
  assert.deepStrictEqual({ ...calls.vadOpts }, { baseUrl: '/api/voice/web/', micLevel: 60, interruptSensitivity: 40, endPause: 1200, echoHoldMs: 600 });   // + the end-of-turn pause (voice fixes 1)
  const d = calls.created[0];
  for (const k of ['agent', 'now', 'setTimer', 'clearTimer', 'prefs', 'vad', 'stt', 'isTurnRunning', 'send', 'interject', 'stop', 'speak', 'cancelSpeech', 'answerAsk', 'server', 'ui']) assert.ok(k in d, k);
  for (const k of ['start', 'heartbeat', 'mode', 'end', 'decide']) assert.strictEqual(typeof d.server[k], 'function', 'server.' + k);
  for (const k of ['state', 'heard', 'held', 'toast', 'summary', 'level']) assert.strictEqual(typeof d.ui[k], 'function', 'ui.' + k);
  assert.strictEqual(d.agent, 'alice');
  assert.ok(calls.bar && /Hang up/.test(calls.bar.innerHTML) && /Do not disturb/.test(calls.bar.innerHTML));
  const b = get('mic-c1');
  assert.strictEqual(b.attrs['aria-label'], 'Hang up');
  assert.ok(b.classList.contains('call'));
  assert.ok(calls.wake.includes('screen'));
  assert.strictEqual(api.voiceCallS.active, true);
  assert.ok(calls.recCancel && calls.stopPlayback, 'dictation and playback stopped first');
  // a second start is ignored: one call at a time
  await api.voiceCallStart('c1');
  assert.strictEqual(fakeCall.started, 1);
});

test('start: not ready, a group chat, or the microphone busy in Settings refuse without a call', async () => {
  let e = makeEnv({ ready: false });
  await e.api.voiceCallStart('c1');
  assert.strictEqual(e.fakeCall.started, 0);
  assert.ok(e.calls.toasts.some(t => /Voice is off/.test(t)));
  e = makeEnv();
  e.chats.c1.isGroup = true;
  await e.api.voiceCallStart('c1');
  assert.strictEqual(e.fakeCall.started, 0);
  e = makeEnv();
  e.stubs.voiceTest.mic = {};
  await e.api.voiceCallStart('c1');
  assert.strictEqual(e.fakeCall.started, 0);
});

test('start failing (the controller says why) removes the bar and the red button', async () => {
  const { api, fakeCall, get, calls } = makeEnv({ startOk: false });
  await api.voiceCallStart('c1');
  assert.strictEqual(fakeCall.started, 1);
  assert.strictEqual(api.voiceCallS.call, null);
  assert.ok(calls.bar.removed);
  assert.strictEqual(get('mic-c1').attrs['aria-label'], 'Dictate');
  assert.ok(!get('mic-c1').classList.contains('call'));
});

test('deps: send posts with voice: true and keeps the half typed text; interject posts to /api/chat/interject', async () => {
  const { api, calls, get } = makeEnv();
  await api.voiceCallStart('c1');
  const d = calls.created[0];
  d.send('what is up');
  assert.deepStrictEqual(calls.sent[0], { c: 'c1', n: 0, o: { voice: true }, text: 'what is up' });
  assert.strictEqual(get('input-c1').value, 'half typed');
  await d.interject('also this');
  const f = calls.fetch.find(x => x.url === '/api/chat/interject');
  assert.deepStrictEqual(f.body, { agent: 'alice', message: 'also this' });
  assert.ok(calls.appended.some(a => /Interjection\] also this/.test(a[2])));
  d.stop();
  assert.deepStrictEqual(calls.stops, ['alice']);
});

test('deps: interject finding the turn over is sent as a normal voice message', async () => {
  const { api, calls } = makeEnv({ fetch: (url) => (url === '/api/chat/interject' ? { ok: false, status: 400, json: async () => ({ error: 'Agent is not currently processing' }) } : null) });
  await api.voiceCallStart('c1');
  await calls.created[0].interject('late words');
  assert.strictEqual(calls.sent.length, 1);
  assert.strictEqual(calls.sent[0].text, 'late words');
  assert.deepStrictEqual(calls.sent[0].o, { voice: true });
});

test('deps: isTurnRunning follows chat.status and the hub busy flag; stt posts the wav with the agent', async () => {
  const { api, calls, chats, agentStatus } = makeEnv();
  await api.voiceCallStart('c1');
  const d = calls.created[0];
  assert.strictEqual(d.isTurnRunning(), false);
  chats.c1.status = 'thinking'; assert.strictEqual(d.isTurnRunning(), true);
  chats.c1.status = 'idle'; agentStatus.alice = { busy: true }; assert.strictEqual(d.isTurnRunning(), true);
  assert.strictEqual(await d.stt(new Float32Array(4)), 'hello');
  const f = calls.fetch.find(x => x.url.startsWith('/api/voice/stt'));
  assert.strictEqual(f.url, '/api/voice/stt?agent=alice');
  assert.strictEqual(f.o.headers['Content-Type'], 'audio/wav');
  assert.strictEqual(calls.wavRate, 16000);
});

test('deps: server routes carry the agent and the action; end returns the held list', async () => {
  const { api, calls } = makeEnv({ held: [{ id: 'job:1', label: 'Nightly job' }] });
  await api.voiceCallStart('c1');
  const s = calls.created[0].server;
  await s.start('announce'); await s.heartbeat('c-1'); await s.mode('dnd', 'c-1');
  const end = await s.end('c-1');
  await s.decide('job:1', 'now', 'c-1');
  const posts = calls.fetch.filter(x => x.url.startsWith('/api/voice/call')).map(x => [x.url, x.body]);
  assert.deepStrictEqual(posts[0], ['/api/voice/call', { agent: 'alice', action: 'start', mode: 'announce' }]);
  assert.deepStrictEqual(posts[1], ['/api/voice/call', { agent: 'alice', action: 'heartbeat', callId: 'c-1' }]);
  assert.deepStrictEqual(posts[2], ['/api/voice/call', { agent: 'alice', action: 'mode', mode: 'dnd', callId: 'c-1' }]);
  assert.deepStrictEqual(posts[3], ['/api/voice/call', { agent: 'alice', action: 'end', callId: 'c-1' }]);
  assert.deepStrictEqual(posts[4], ['/api/voice/call/decide', { agent: 'alice', id: 'job:1', choice: 'now', callId: 'c-1' }]);
  assert.deepStrictEqual(end, { held: [{ id: 'job:1', label: 'Nightly job' }] });
});

test('deps: speak resolves true when read to the end and false when cut; cancelSpeech stops at once', async () => {
  let e = makeEnv();
  await e.api.voiceCallStart('c1');
  assert.strictEqual(await e.calls.created[0].speak('One. Two.'), true);
  assert.deepStrictEqual(e.calls.spoken[0][2], ['One.', 'Two.']);
  e = makeEnv({ cutSpeech: true });
  await e.api.voiceCallStart('c1');
  assert.strictEqual(await e.calls.created[0].speak('One. Two.'), false);
  const before = e.calls.stopPlayback;
  e.calls.created[0].cancelSpeech();
  assert.strictEqual(e.calls.stopPlayback, before + 1);
});

test('ui: state, level, heard, held buttons, summary (a panel line, not history), toast', async () => {
  const { api, calls, get } = makeEnv();
  await api.voiceCallStart('c1');
  const ui = calls.created[0].ui;
  ui.state('hearing'); assert.strictEqual(get('vcb-state-c1').textContent, 'Hearing you');
  ui.state('thinking'); assert.strictEqual(get('vcb-state-c1').textContent, 'Thinking');
  ui.level(-30); assert.strictEqual(get('vcb-level-c1').style.width, '50%');
  ui.heard('open the door'); assert.strictEqual(get('vcb-heard-c1').textContent, 'Heard: open the door');
  ui.held([{ id: 'consult:9', label: 'A <b>consult</b>', from: 'bob' }]);
  const h = get('vcb-held-c1').innerHTML;
  assert.match(h, /A &lt;b>consult/);
  assert.match(h, /data-id="consult:9" data-choice="now">Now</);
  assert.match(h, /data-choice="later">Later</);
  assert.match(h, /data-choice="skip">Skip</);
  ui.summary('While we talked: 1 thing came in: x. It runs now.');
  assert.deepStrictEqual(calls.notices[0], ['c1', 'While we talked: 1 thing came in: x. It runs now.']);
  ui.toast('hi'); assert.deepStrictEqual(calls.toasts.slice(-1), ['hi']);
});

test('sliders: live on the VAD at once, saved to the prefs when released', async () => {
  const { api, calls, get, getPrefs } = makeEnv();
  await api.voiceCallStart('c1');
  api.voiceCallSlider('c1', 'mic', 70, false);
  api.voiceCallSlider('c1', 'sens', 25, false);
  assert.deepStrictEqual(calls.vadCalls, [['mic', 70], ['sens', 25]]);
  assert.strictEqual(calls.saved.length, 0, 'no write while dragging');
  assert.strictEqual(get('vcb-mic-val-c1').textContent, '70');
  api.voiceCallSlider('c1', 'sens', 25, true);
  assert.deepStrictEqual(getPrefs(), { micLevel: 60, interruptSensitivity: 25, mode: 'handsfree' });
});

test('events: replies of turns the call started feed onReplyText; other agents are ignored', async () => {
  const { api, fakeCall } = makeEnv();
  await api.voiceCallStart('c1');
  const ev = api.voiceCallHubEvent;
  ev('turn_start', { agent: 'alice', turnId: 't1', origin: { kind: 'user' } });
  ev('turn_delta', { agent: 'alice', turnId: 't1', text: 'Hello. I' });
  ev('turn_delta', { agent: 'bob', turnId: 't1', text: 'nope' });
  ev('turn_delta', { agent: 'alice', turnId: 'tX', text: 'unknown turn' });
  ev('turn_activity', { agent: 'alice', turnId: 't1', item: { kind: 'tool', tool: 'Bash' } });
  ev('turn_end', { agent: 'alice', turnId: 't1', ok: true, reply: 'Hello. It is done.' });
  assert.deepStrictEqual(fakeCall.replies, [['Hello. I', false], ['Hello. It is done.', true]]);
  assert.deepStrictEqual(fakeCall.activities, [{ kind: 'tool', tool: 'Bash' }]);
  // a failed turn with no reply ends with the last text seen
  ev('turn_start', { agent: 'alice', turnId: 't2', origin: { kind: 'user' } });
  ev('turn_delta', { agent: 'alice', turnId: 't2', text: 'Partial.' });
  ev('turn_end', { agent: 'alice', turnId: 't2', ok: false });
  assert.deepStrictEqual(fakeCall.replies.slice(-1), [['Partial.', true]]);
});

test('events: a hub-started turn speaks only "<label>: <first sentence>" at its end', async () => {
  const { api, fakeCall } = makeEnv();
  await api.voiceCallStart('c1');
  const ev = api.voiceCallHubEvent;
  ev('turn_start', { agent: 'alice', turnId: 'h1', origin: { kind: 'job_notice', label: 'Nightly job', from: 'jobs' } });
  ev('turn_delta', { agent: 'alice', turnId: 'h1', text: 'It finished. Details follow.' });
  assert.deepStrictEqual(fakeCall.replies, [], 'nothing while it runs');
  ev('turn_end', { agent: 'alice', turnId: 'h1', ok: true, reply: 'It finished. Details follow.' });
  assert.deepStrictEqual(fakeCall.replies, [['Nightly job: It finished.', true]]);
  ev('turn_start', { agent: 'alice', turnId: 'h2', origin: { kind: 'consultation', from: 'bob' } });
  ev('turn_end', { agent: 'alice', turnId: 'h2', ok: true, reply: 'Sure thing! More.' });
  assert.deepStrictEqual(fakeCall.replies.slice(-1), [['bob: Sure thing!', true]]);
});

test('events: ask_user, ask_user_done, voice_held, voice_held_done reach the controller; the answer is posted', async () => {
  const { api, fakeCall, calls } = makeEnv();
  await api.voiceCallStart('c1');
  const ev = api.voiceCallHubEvent;
  ev('ask_user', { agent: 'alice', request_id: 'r1', question: 'Which one?', options: [{ label: 'Red' }, { label: 'Blue' }], questions: [{ question: 'Which one?', options: [{ label: 'Red' }, { label: 'Blue' }] }] });
  assert.deepStrictEqual(fakeCall.asks[0], { request_id: 'r1', question: 'Which one?', options: ['Red', 'Blue'] });
  await calls.created[0].answerAsk('r1', 'Blue');
  const f = calls.fetch.find(x => x.url === '/api/ask_response');
  assert.deepStrictEqual(f.body, { agent: 'alice', request_id: 'r1', answers: { 'Which one?': 'Blue' } });
  assert.deepStrictEqual(calls.closed, ['r1']);
  ev('ask_user_done', { agent: 'alice', request_id: 'r1' });
  assert.deepStrictEqual(fakeCall.askDone, ['r1']);
  ev('ask_user', { agent: 'alice', request_id: 'r2', questions: [{ question: 'a', options: [] }, { question: 'b', options: [] }] });
  assert.strictEqual(fakeCall.asks.length, 1, 'several questions are left to the screen');
  ev('voice_held', { agent: 'alice', callId: 'c-1', item: { id: 'job:1', label: 'Job' }, quiet: true });
  ev('voice_held_done', { agent: 'alice', callId: 'c-1', id: 'job:1', choice: 'later' });
  assert.deepStrictEqual(fakeCall.held, [[{ id: 'job:1', label: 'Job' }, true]]);
  assert.deepStrictEqual(fakeCall.heldDone, [['job:1', 'later']], 'P-b: the choice is forwarded');
});

test('call bar buttons: Now/Later/Skip call decide, the switch calls setMode, Hang up hangs up', async () => {
  const { api, fakeCall, calls } = makeEnv();
  await api.voiceCallStart('c1');
  const L = calls.bar.listeners;
  const target = (dataset, extra = {}) => ({ target: { dataset, closest: () => ({ dataset }), ...extra } });
  L.click(target({ vcb: 'decide', id: 'job:1', choice: 'now' }));
  L.click(target({ vcb: 'decide', id: 'job:2', choice: 'skip' }));
  assert.deepStrictEqual(fakeCall.decisions, [['job:1', 'now'], ['job:2', 'skip']]);
  L.change(target({ vcb: 'dnd' }, { checked: true }));
  L.change(target({ vcb: 'dnd' }, { checked: false }));
  assert.deepStrictEqual(fakeCall.modes, ['dnd', 'announce']);
  L.click(target({ vcb: 'hang' }));
  assert.strictEqual(fakeCall.hung, 1);
});

test('hang up: controller hung up once, bar and red button removed, wake lock released, a stray call event is ignored', async () => {
  const { api, fakeCall, get, calls } = makeEnv();
  await api.voiceCallStart('c1');
  await api.voiceCallHangUp();
  assert.strictEqual(fakeCall.hung, 1);
  assert.ok(calls.bar.removed);
  assert.strictEqual(get('mic-c1').attrs['aria-label'], 'Dictate');
  assert.ok(calls.wake.includes('release'));
  assert.strictEqual(api.voiceCallS.call, null);
  api.voiceCallHubEvent('turn_delta', { agent: 'alice', turnId: 't1', text: 'x' });
  assert.strictEqual(fakeCall.replies.length, 0);
  await api.voiceCallHangUp();
  assert.strictEqual(fakeCall.hung, 1, 'a second hang-up does nothing');
});

test('events: the hub ending the call (state off, e.g. it expired) hangs up with a toast', async () => {
  const { api, fakeCall, calls } = makeEnv();
  await api.voiceCallStart('c1');
  api.voiceCallHubEvent('voice_call', { agent: 'alice', state: 'off', callId: 'c-1' });
  assert.strictEqual(fakeCall.hung, 1);
  assert.ok(calls.toasts.includes('The call ended.'));
});

test('P-a: events of another call (another callId, or none) are ignored', async () => {
  const { api, fakeCall, calls } = makeEnv();
  await api.voiceCallStart('c1');
  const ev = api.voiceCallHubEvent;
  ev('voice_held', { agent: 'alice', callId: 'old', item: { id: 'x' } });
  ev('voice_held', { agent: 'alice', item: { id: 'y' } });
  ev('voice_held_done', { agent: 'alice', callId: 'old', id: 'x', choice: 'now' });
  ev('voice_call', { agent: 'alice', state: 'off', callId: 'old' });
  assert.deepStrictEqual([fakeCall.held, fakeCall.heldDone, fakeCall.hung], [[], [], 0]);
  assert.ok(!calls.toasts.includes('The call ended.'));
});

test('P-a: the server adapter sends the call id on heartbeat, mode, decide and end, and reads the id and the held items from the answers', async () => {
  const { api, calls } = makeEnv({ fetch: (url, o) => (url === '/api/voice/call' ? { ok: true, status: 200, json: async () => ({ ok: true, call: { callId: 'c-9', mode: 'announce', held: [{ id: 'j', state: 'later' }] } }) } : null) });
  await api.voiceCallStart('c1');
  const s = calls.created[0].server;
  assert.deepStrictEqual(await s.start('announce'), { callId: 'c-9', held: [{ id: 'j', state: 'later' }] });
  assert.deepStrictEqual(await s.heartbeat('c-9'), { callId: 'c-9', held: [{ id: 'j', state: 'later' }] });
  await s.mode('dnd', 'c-9'); await s.end('c-9'); await s.decide('j', 'now', 'c-9');
  const bodies = calls.fetch.filter(x => x.url.startsWith('/api/voice/call')).map(x => x.body);
  assert.deepStrictEqual(bodies.slice(1), [
    { agent: 'alice', action: 'heartbeat', callId: 'c-9' }, { agent: 'alice', action: 'mode', mode: 'dnd', callId: 'c-9' },
    { agent: 'alice', action: 'end', callId: 'c-9' }, { agent: 'alice', id: 'j', choice: 'now', callId: 'c-9' }]);
});

test('P-j: a heartbeat the hub answers with 409 or 403 hangs up here with a toast', async () => {
  for (const [status, error] of [[409, 'no_call'], [409, 'stale_call'], [403, 'not_your_call']]) {
    const { api, fakeCall, calls } = makeEnv({ fetch: (url, o) => (o.body && JSON.parse(o.body).action === 'heartbeat' ? { ok: false, status, json: async () => ({ error }) } : null) });
    await api.voiceCallStart('c1');
    await assert.rejects(() => calls.created[0].server.heartbeat('c-1'));
    assert.strictEqual(fakeCall.hung, 1, error);
    assert.ok(calls.toasts.includes('The call ended.'), error);
  }
  const { api, fakeCall, calls } = makeEnv({ fetch: (url, o) => (o.body && JSON.parse(o.body).action === 'heartbeat' ? { ok: false, status: 500, json: async () => ({}) } : null) });
  await api.voiceCallStart('c1');
  await assert.rejects(() => calls.created[0].server.heartbeat('c-1'));
  assert.strictEqual(fakeCall.hung, 0, 'a server error is not the end of the call');
});

test('P-i: a voice send the hub did not take rejects to the controller; a taken one resolves; a missing turn_end is released after 2.5 s', async () => {
  const e2 = makeEnv({ sendFails: true });
  await e2.api.voiceCallStart('c1');
  await assert.rejects(() => Promise.resolve(e2.calls.created[0].send('hello')), /HTTP 500/);
  const e3 = makeEnv({ sendOk: true });
  await e3.api.voiceCallStart('c1');
  await e3.calls.created[0].send('hello');
  await flush(); await flush();
  assert.deepStrictEqual(e3.fakeCall.replies, [['', true]], 'no turn_end came: the call is released from Thinking');
  const e4 = makeEnv({ sendOk: true });
  await e4.api.voiceCallStart('c1');
  await e4.calls.created[0].send('hello');
  e4.api.voiceCallHubEvent('turn_start', { agent: 'alice', turnId: 't1', origin: { kind: 'user' } });
  e4.api.voiceCallHubEvent('turn_end', { agent: 'alice', turnId: 't1', ok: true, reply: 'Hi.' });
  await flush(); await flush();
  assert.deepStrictEqual(e4.fakeCall.replies, [['Hi.', true]], 'a turn_end that arrived leaves nothing to release');
});

test('P-i: sendSoloMessage tells a voice caller whether the hub took the message (accepted, interjected, refused, network error)', () => {
  const s = app.slice(app.indexOf('async function sendSoloMessage('), app.indexOf('// Group chat - free flowing'));
  assert.match(s, /const notify = \(err\) => \{ if \(notified \|\| !sendOpts \|\| !sendOpts\.onSendResult\) return;/);
  assert.match(s, /throw new Error\(`HTTP \$\{response\.status\}: \$\{response\.statusText\}`\);\s*\}\s*notify\(null\);/, 'accepted');
  assert.match(s, /\} catch \(err\) \{\s*notify\(err\);/, 'network error or a non-2xx answer');
  assert.match(s, /notify\(new Error\('busy'\)\);/, 'refused');
});

test('P-k: a wake lock that arrives after the hang-up is released at once and not kept', async () => {
  const released = [];
  let grant;
  const e = makeEnv();
  e.stubs.navigator.wakeLock.request = () => new Promise((r) => { grant = () => r({ release: async () => { released.push(1); }, addEventListener() {} }); });
  await e.api.voiceCallStart('c1');
  await e.api.voiceCallHangUp();
  grant(); await flush(); await flush();
  assert.deepStrictEqual(released, [1], 'released at once');
  assert.strictEqual(e.api.voiceCallS.wake, null, 'not kept');
});

test('room check: counts down, sets and saves mic level and interrupt sensitivity, shows the result', async () => {
  const { api, get, calls, getPrefs } = makeEnv({ roomSpeech: -20, roomQuiet: -60 });
  await api.voiceRoomCheckRun();
  const out = get('st-voice-room-out').textContent;
  assert.match(out, /^Mic level \d+, interrupt sensitivity \d+$/);
  const p = getPrefs();
  assert.strictEqual(out, `Mic level ${p.micLevel}, interrupt sensitivity ${p.interruptSensitivity}`);
  assert.strictEqual(get('st-voice-mic').value, String(p.micLevel));
  assert.strictEqual(get('st-voice-sens').value, String(p.interruptSensitivity));
  assert.ok(calls.micClosed);
  assert.strictEqual(api.voiceRoom.active, false);
  assert.strictEqual(get('st-voice-room').disabled, false);
});

test('room check: the countdown texts say a sentence, then stay quiet', () => {
  const w = wiring();
  assert.match(w, /Say a sentence now \(\$\{left\}\)/);
  assert.match(w, /Now stay quiet \(\$\{left\}\)/);
  assert.match(w, /TOTAL = 5000/);
  assert.match(w, /el < TOTAL \/ 2 \? 'speech' : 'silence'/);
});

test('room check: no speech heard says so and changes nothing', async () => {
  const { api, get, calls } = makeEnv({ roomSpeech: -90, roomQuiet: -90 });
  await api.voiceRoomCheckRun();
  assert.strictEqual(get('st-voice-room-out').textContent, 'No speech heard: check the microphone and its permission.');
  assert.strictEqual(calls.saved.length, 0);
});

test('room check: a blocked microphone shows the browser error and frees the button', async () => {
  const { api, get, calls } = makeEnv({ openMic: async () => { throw new Error('blocked'); } });
  await api.voiceRoomCheckRun();
  assert.strictEqual(get('st-voice-room-out').textContent, 'mic: blocked');
  assert.strictEqual(api.voiceRoom.active, false);
  assert.ok(calls.toasts.includes('mic: blocked'));
});

test('room check is refused while a call is up', async () => {
  const { api, calls, get } = makeEnv();
  await api.voiceCallStart('c1');
  await api.voiceRoomCheckRun();
  assert.ok(calls.toasts.includes('The microphone is in use.'));
  assert.strictEqual(calls.micOpened, undefined);
});
