'use strict';
// The hands-free call on the phone page (phase 2): mobile.js feeds the call controller (lib/ui-voice-call.js), mobile.html has the call panel.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const js = read('mobile.js');
const html = read('mobile.html');
const C = require('../lib/ui-voice-call');
const sliceBetween = (a, b) => { const i = js.indexOf(a), j = js.indexOf(b, i + a.length); assert.ok(i > 0 && j > i, a + ' .. ' + b); return js.slice(i, j); };
const callSection = () => sliceBetween('// ── Voice call (phone): the hands-free call', '// ── Voice sheet (menu, Voice) ──');

test('mic button: hands-free tap starts a call synchronously, a second tap hangs up, tap mode keeps dictation', () => {
  const tap = sliceBetween('async function voiceMicTap()', 'async function voiceMicStop()');
  assert.match(tap, /if \(voiceCall\) \{ voiceCallHangUp\(\); return; \}/);
  assert.match(tap, /if \(voicePrefsNow\(\)\.mode !== 'tap'\) \{ voiceCallStart\(\); return; \}/);
  assert.ok(!tap.slice(0, tap.indexOf('voiceCallStart()')).includes('await'), 'no await before call.start (iOS)');
  assert.ok(tap.indexOf('voiceCallStart()') < tap.indexOf('voiceRec.guard.begin()'), 'dictation code is only reached in tap mode');
  const start = sliceBetween('function voiceCallStart()', 'function voiceCallWire()');
  assert.ok(!start.includes('await '), 'voiceCallStart awaits nothing');
  assert.ok(start.indexOf('voiceMicCancel()') < start.indexOf('vc.call.start()'), 'dictation stops first');
  assert.ok(start.indexOf('voiceStopPlayback()') < start.indexOf('vc.call.start()'), 'playback stops first');
  assert.match(start, /voiceCreateVad\(\{ baseUrl: '\/api\/voice\/web\/', micLevel: prefs\.micLevel, interruptSensitivity: prefs\.interruptSensitivity \}\)/);
  assert.match(start, /voiceCreateCall\(voiceCallDeps\(vc\)\)/);
  assert.match(js, /navigator\.wakeLock\.request\('screen'\)/);
});

test('hang-up button: red, inline SVG, aria-label Hang up, no emoji', () => {
  const paint = sliceBetween('function voiceMicPaint()', 'function voiceMicCancel()');
  assert.match(paint, /setAttribute\('aria-label', 'Hang up'\)/);
  assert.match(paint, /VOICE_HANGUP_SVG/);
  assert.match(js, /const VOICE_HANGUP_SVG = '<svg class="hang"/);
  assert.match(html, /#mic-btn\.call \{[^}]*var\(--error/);
  assert.match(html, /id="cp-hangup"[^>]*aria-label="Hang up"><svg /);
  const mine = callSection() + sliceBetween('function voiceSheet()', 'function openVoiceSheet') + html.slice(html.indexOf('id="call-panel"'), html.indexOf('id="composer"')) + html.slice(html.indexOf('#mic-btn.call'), html.indexOf('.vs-room-out'));
  const bad = new RegExp('[' + [0xFE0F, 0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF].map(c => String.fromCharCode(c)).join('') + ']');
  assert.ok(!bad.test(mine), 'no U+FE0F or zero-width characters in the call code and markup');
  assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(mine), 'no emoji in the call code and markup');
});

test('call panel sits between the messages and the composer, with every control, the help line and large targets', () => {
  const i = html.indexOf('id="call-panel"');
  assert.ok(i > html.indexOf('id="chat-scroll"') && i < html.indexOf('id="composer"'), 'above the composer, in the chat screen flow (not over the send row or the tab bar)');
  assert.ok(i < html.indexOf('id="tabbar"'));
  for (const id of ['cp-state', 'cp-meter', 'cp-heard', 'cp-held', 'cp-dnd', 'cp-levels', 'cp-hangup', 'cp-help']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /Do not disturb/);
  assert.match(html, /Hands-free works with the app open and the screen on; locked-screen and car systems \(CarPlay, Android Auto\) are not supported yet\./);
  assert.match(js, /const VOICE_CALL_HELP = 'Hands-free works with the app open and the screen on; locked-screen and car systems \(CarPlay, Android Auto\) are not supported yet\.'/);
  assert.match(html, /#call-panel \{[^}]*flex-shrink: 0/);
  assert.ok(!/#call-panel \{[^}]*position: (fixed|absolute)/.test(html), 'in flow, so it cannot cover the composer');
  assert.match(html, /\.cp-item-acts button \{ flex: 1; min-height: 48px/);
  assert.match(html, /\.cp-hang \{ flex: 1;/);
  assert.match(js, /\['now', 'Now'\], \['later', 'Later'\], \['skip', 'Skip'\]/);
  assert.match(js, /voiceCall\.call\.decide\(row\.dataset\.id, b\.dataset\.choice\)/);
  assert.match(js, /voiceCall\.call\.setMode\(e\.target\.checked \? 'dnd' : 'announce'\)/);
  assert.match(js, /\$\('cp-levels'\)\?\.addEventListener\('click', \(\) => openVoiceSheet\(\)\)/);
  assert.match(js, /VOICE_CALL_STATE_TEXT = \{ starting: 'Starting', listening: 'Listening', hearing: 'Hearing you', thinking: 'Thinking', speaking: 'Speaking'/);
  assert.match(js, /voiceCallWire\(\);/);
});

test('deps: every key of the controller contract is given', () => {
  const deps = sliceBetween('function voiceCallDeps(vc)', 'function voiceCallStart()');
  for (const k of ['agent', 'now:', 'setTimer:', 'clearTimer:', 'prefs:', 'vad:', 'stt:', 'isTurnRunning:', 'send:', 'interject:', 'stop:', 'speak:', 'cancelSpeech:', 'answerAsk:', 'server:', 'ui:']) assert.ok(deps.includes(k), k);
  assert.match(deps, /isTurnRunning: \(\) => isBusy\(agent\) \|\| ownTurnFor\(agent\)/);
  assert.match(deps, /stop: \(\) => stopTurn\(agent\)/);
  assert.match(deps, /cancelSpeech: \(\) => voiceStopPlayback\(\)/);
  for (const k of ['state:', 'heard:', 'held:', 'toast:', 'summary:', 'level:']) assert.ok(deps.includes(k), 'ui.' + k);
  const srv = sliceBetween('function voiceCallServer(', 'async function voiceCallStt');
  for (const a of ["action: 'start'", "action: 'heartbeat'", "action: 'mode'", "action: 'end'", "'/decide'"]) assert.ok(srv.includes(a), a);
});

test('voice: true goes only with messages that came from a call; the 409 path leaves the composer alone', () => {
  assert.match(js, /\.\.\.\(fallback && fallback\.voice \? \{ voice: true \} : \{\}\)/);
  assert.match(js, /sendMessage\(\{ agent: vc\.agent, text, userEl, noteEl: null, voice: true \}\)/);
  assert.match(js, /body: JSON\.stringify\(\{ agent, message: text, images, confirm_tools: false, \.\.\./);
  assert.match(js, /if \(fallback && fallback\.voice\) \{\n\s*toast\(/);
  assert.ok(!/voice: true/.test(sliceBetween('async function sendInterjection(agent)', 'function stopTurn(agent)')), 'typed sends are unchanged');
});

test('events feed the controller; hub events are wired on the same stream', () => {
  for (const [ev, fn] of [['turn_start', 'voiceCallTurnStart'], ['turn_delta', 'voiceCallTurnDelta'], ['turn_activity', 'voiceCallTurnActivity'], ['turn_end', 'voiceCallTurnEnd'],
    ['ask_user', 'voiceCallAsk'], ['ask_user_done', 'voiceCallAskDone'], ['voice_held', 'voiceCallHeld'], ['voice_held_done', 'voiceCallHeldDone'], ['voice_call', 'voiceCallState']]) {
    assert.ok(js.includes(`on('${ev}', ${fn});`), ev);
  }
});

function runEvents(overrides) {
  const calls = [];
  const call = {
    state: 'listening',
    onReplyText: (t, d) => calls.push(['reply', t, d]), onActivity: (i) => calls.push(['activity', i]),
    onAsk: (a) => calls.push(['ask', a]), onAskDone: (id) => calls.push(['askDone', id]),
    onHeld: (i, q) => calls.push(['held', i, q]), onHeldDone: (id) => calls.push(['heldDone', id]),
  };
  const vc = { agent: 'bob', call, callTurns: new Set(), hubTurns: new Map(), asks: new Map(), lastText: '', expecting: true, startedAt: 0 };
  const src = js.slice(js.indexOf('function voiceCallTurnStart(ev)'), js.indexOf('// ── Room check (5 s)'));
  const hung = [], toasts = [];
  const env = Object.assign({ voiceCall: vc, voiceSentences: C.voiceReplySentences ? require('../lib/ui-voice').voiceSentences : null, voiceSpeechText: require('../lib/ui-voice').voiceSpeechText,
    originLabel: (o) => (o && o.kind) || '', voiceCallHangUp: () => hung.push(1), toast: (t) => toasts.push(t), Date }, overrides || {});
  const names = Object.keys(env);
  const f = new Function(...names, src + '\nreturn { voiceCallTurnStart, voiceCallTurnDelta, voiceCallTurnActivity, voiceCallTurnEnd, voiceCallAsk, voiceCallAskDone, voiceCallHeld, voiceCallHeldDone, voiceCallState };')(...names.map(n => env[n]));
  return { f, calls, vc, hung, toasts };
}

test('a turn the call started: deltas (cumulative) and the end go to onReplyText, activity to onActivity', () => {
  const { f, calls, vc } = runEvents();
  f.voiceCallTurnStart({ agent: 'bob', turnId: 't1', origin: { kind: 'user' } });
  f.voiceCallTurnStart({ agent: 'other', turnId: 'tx', origin: { kind: 'user' } });
  f.voiceCallTurnDelta({ agent: 'bob', turnId: 't1', text: 'Hello. ' });
  f.voiceCallTurnDelta({ agent: 'bob', turnId: 't1', text: 'Hello. There' });
  f.voiceCallTurnDelta({ agent: 'other', turnId: 'tx', text: 'ignored' });
  f.voiceCallTurnActivity({ agent: 'bob', turnId: 't1', item: { kind: 'tool', tool: 'Bash', status: 'run' } });
  f.voiceCallTurnEnd({ agent: 'bob', turnId: 't1', ok: true, reply: 'Hello. There.' });
  assert.deepStrictEqual(calls, [['reply', 'Hello. ', false], ['reply', 'Hello. There', false], ['activity', { kind: 'tool', tool: 'Bash', status: 'run' }], ['reply', 'Hello. There.', true]]);
  assert.strictEqual(vc.expecting, false);
  assert.strictEqual(vc.callTurns.size, 0);
});

test('a hub-started turn during the call: only "<label>: <first sentence>" is spoken at turn_end', () => {
  const { f, calls } = runEvents();
  f.voiceCallTurnStart({ agent: 'bob', turnId: 'h1', origin: { kind: 'schedule', label: 'Morning report' } });
  f.voiceCallTurnStart({ agent: 'bob', turnId: 'h2', origin: { kind: 'consult', from: 'Alice' } });
  f.voiceCallTurnDelta({ agent: 'bob', turnId: 'h1', text: 'streaming' });   // not read
  f.voiceCallTurnEnd({ agent: 'bob', turnId: 'h1', ok: true, reply: 'Sales are up. Details follow in a table.\n\n| a | b |\n|---|---|\n| 1 | 2 |' });
  f.voiceCallTurnEnd({ agent: 'bob', turnId: 'h2', ok: true, reply: 'Ready when you are. More.' });
  assert.deepStrictEqual(calls, [['reply', '', false], ['reply', 'Morning report: Sales are up.', true], ['reply', '', false], ['reply', 'Alice: Ready when you are.', true]]);
});

test('a hub turn is not spoken while the call is busy or when it failed', () => {
  const { f, calls, vc } = runEvents();
  vc.call.state = 'speaking';
  f.voiceCallTurnStart({ agent: 'bob', turnId: 'h1', origin: { kind: 'schedule', label: 'X' } });
  f.voiceCallTurnEnd({ agent: 'bob', turnId: 'h1', ok: true, reply: 'Done.' });
  vc.call.state = 'listening';
  f.voiceCallTurnStart({ agent: 'bob', turnId: 'h2', origin: { kind: 'schedule', label: 'Y' } });
  f.voiceCallTurnEnd({ agent: 'bob', turnId: 'h2', ok: false, reply: '' });
  assert.deepStrictEqual(calls, []);
});

test('ask_user, ask_user_done, voice_held and voice_held_done reach the controller; the answer is keyed by the question text', async () => {
  const { f, calls, vc } = runEvents();
  f.voiceCallAsk({ agent: 'bob', request_id: 'r1', question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }], questions: [{ question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }] });
  f.voiceCallAsk({ agent: 'bob', request_id: 'r2', questions: [{ question: 'Only in questions?', options: [{ label: 'Yes' }] }] });
  f.voiceCallAskDone({ agent: 'bob', request_id: 'r1' });
  f.voiceCallHeld({ agent: 'bob', item: { id: 'consult:1', label: 'Alice asks' }, quiet: true });
  f.voiceCallHeld({ agent: 'zed', item: { id: 'x' } });
  f.voiceCallHeldDone({ agent: 'bob', id: 'consult:1', choice: 'skip' });
  assert.deepStrictEqual(calls, [
    ['ask', { request_id: 'r1', question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }],
    ['ask', { request_id: 'r2', question: 'Only in questions?', options: [{ label: 'Yes' }] }],
    ['askDone', 'r1'], ['held', { id: 'consult:1', label: 'Alice asks' }, true], ['heldDone', 'consult:1']]);
  assert.strictEqual(vc.asks.get('r2'), 'Only in questions?');
  // the answer POST
  const posted = [];
  const src = sliceBetween('async function voiceCallAnswerAsk(', 'function voiceCallDeps(vc)');
  const g = new Function('voiceCallPost', 'toast', src + '\nreturn voiceCallAnswerAsk;')(async (url, body) => { posted.push([url, body]); return { ok: true }; }, () => {});
  await g(vc, 'r2', 'Yes');
  assert.deepStrictEqual(posted, [['/api/ask_response', { agent: 'bob', request_id: 'r2', answers: { 'Only in questions?': 'Yes' } }]]);
});

test('voice_call off ends the call (but not the "off" of the call it replaced)', () => {
  const a = runEvents();
  a.vc.startedAt = Date.now();
  a.f.voiceCallState({ agent: 'bob', state: 'off' });
  assert.deepStrictEqual(a.hung, []);
  const b = runEvents();
  b.f.voiceCallState({ agent: 'bob', state: 'on' });
  assert.deepStrictEqual(b.hung, []);
  b.f.voiceCallState({ agent: 'bob', state: 'off' });
  assert.deepStrictEqual(b.hung, [1]);
  assert.match(b.toasts[0], /call ended/);
});

test('voiceCallStart calls call.start() inside the tap, before anything is awaited, and stops dictation and playback first', () => {
  const order = [];
  const src = sliceBetween('function voiceCallStart()', 'function voiceCallWire()');
  const els = {};
  const env = {
    voiceCall: null, current: 'bob', toast: (t) => order.push('toast:' + t), voiceOn: () => true,
    voiceRec: { state: 'recording' }, voiceMicCancel: () => order.push('micCancel'), voiceTest: { handle: null }, voiceTestStop() {}, voiceRoomStop: () => order.push('roomStop'),
    voiceStopPlayback: () => order.push('stopPlayback'), voiceUnlockAudio: () => order.push('unlock'),
    voicePrefsNow: () => ({ micLevel: 60, interruptSensitivity: 40 }),
    voiceCreateVad: (o) => { order.push('vad:' + o.micLevel + ':' + o.interruptSensitivity); return {}; },
    voiceCreateCall: () => ({ start: () => { order.push('call.start'); return new Promise(() => {}); } }),
    voiceCallDeps: () => ({}), voiceCallPanel: () => order.push('panel'), voiceCallPaintState: () => {}, voiceMicPaint: () => order.push('micPaint'),
    voiceCallTeardown: () => {}, voiceWakeAcquire: () => order.push('wake'), Date,
  };
  const names = Object.keys(env);
  const run = new Function(...names, src.replace(/voiceCall = vc;/, 'voiceCall = vc; globalThis.__vc = vc;') + '\nreturn voiceCallStart;')(...names.map(n => env[n]));
  run();
  assert.deepStrictEqual(order.slice(0, 6), ['micCancel', 'roomStop', 'stopPlayback', 'unlock', 'vad:60:40', 'panel']);
  assert.ok(order.includes('call.start'), 'start ran synchronously');
  assert.ok(order.indexOf('stopPlayback') < order.indexOf('call.start'));
  assert.strictEqual(globalThis.__vc.agent, 'bob');
  delete globalThis.__vc;
});

test('voiceCallStart does nothing without an agent or while voice is not ready', () => {
  const src = sliceBetween('function voiceCallStart()', 'function voiceCallWire()');
  const toasts = [];
  const mk = (current, on) => new Function('voiceCall', 'current', 'toast', 'voiceOn', src + '\nreturn voiceCallStart;')(null, current, (t) => toasts.push(t), () => on);
  mk(null, true)(); mk('bob', false)();
  assert.deepStrictEqual(toasts, ['Pick an agent first', 'Voice is not ready on the hub yet']);
});

test('hang-up: the controller hangs up, the page lets go at once, the wake lock is released; teardown is idempotent', () => {
  const src = sliceBetween('function voiceCallTeardown(vc)', '// The hub\'s call routes, for one agent.');
  const log = [];
  const vc = { call: { hangUp: () => { log.push('hangUp'); return Promise.resolve([{ label: 'x' }]); } }, wake: { release: () => { log.push('release'); return Promise.resolve(); } } };
  const state = { voiceCall: vc };
  const f = new Function('state', 'voiceCallPanel', 'voiceMicPaint', src.replace(/\bvoiceCall\b/g, 'state.voiceCall') + '\nreturn { voiceCallHangUp, voiceCallTeardown };')(state, (s) => log.push('panel:' + s), () => log.push('micPaint'));
  const p = f.voiceCallHangUp();
  assert.strictEqual(state.voiceCall, null);
  assert.deepStrictEqual(log, ['hangUp', 'release', 'panel:false', 'micPaint']);
  f.voiceCallTeardown(vc);
  assert.strictEqual(log.length, 4, 'a second teardown does nothing');
  return p.then((held) => assert.strictEqual(held.length, 1));
});

test('server.end reads the held list from either shape; heartbeat on 409 hangs up', async () => {
  const src = sliceBetween('function voiceCallServer(', 'async function voiceCallStt');
  const posts = [];
  let reply = { status: 200, ok: true, body: { ok: true, held: [{ id: 'a' }] } };
  const hung = [], toasts = [];
  const voiceCallPost = async (url, body, opts) => { posts.push([url, body, opts]); return { status: reply.status, ok: reply.ok, json: async () => reply.body }; };
  const state = { voiceCall: null };
  const make = new Function('voiceCallPost', 'voiceCallJson', 'toast', 'voiceCallHangUp', 'state', src.replace(/\bvoiceCall\b(?!Post|Json|Hang)/g, 'state.voiceCall') + '\nreturn voiceCallServer;')(
    voiceCallPost, async (r) => r.json(), (t) => toasts.push(t), () => hung.push(1), state);
  const vc = {}; state.voiceCall = vc;
  const s = make('bob', () => vc);
  await s.start('announce');
  assert.deepStrictEqual(posts[0], ['/api/voice/call', { agent: 'bob', action: 'start', mode: 'announce' }, undefined]);
  assert.deepStrictEqual(await s.end(), { held: [{ id: 'a' }] });
  assert.strictEqual(posts[1][2].keepalive, true);
  reply = { status: 200, ok: true, body: { ok: true, call: { held: [{ id: 'b' }, { id: 'c' }] } } };
  assert.strictEqual((await s.end()).held.length, 2);
  await s.decide('x', 'now');
  assert.deepStrictEqual(posts[3].slice(0, 2), ['/api/voice/call/decide', { agent: 'bob', id: 'x', choice: 'now' }]);
  reply = { status: 409, ok: false, body: { error: 'no_call' } };
  await s.heartbeat();
  assert.deepStrictEqual(hung, [1]);
  await assert.rejects(s.start('announce'), /no_call/);
  reply = { status: 403, ok: false, body: { error: 'not_your_call' } };
  await assert.rejects(s.start('announce'), /someone else/);
});

test('speak resolves false when cut (the token moves), true when played, falls back to the device voice', async () => {
  const src = sliceBetween('async function voiceCallSpeak(', '// A spoken message starts a voice turn');
  const run = async ({ on = true, blob = {}, ok = true, cutDuring = false, fallback = true }) => {
    const voicePlay = { token: 3 };
    const dev = [];
    const f = new Function('voicePlay', 'voiceOn', 'voiceTtsBlob', 'voicePlayBlob', 'voicePrefsNow', 'voiceDeviceSpeak', src + '\nreturn voiceCallSpeak;')(
      voicePlay, () => on, async () => blob, async () => { if (cutDuring) voicePlay.token++; return ok; }, () => ({ deviceVoiceFallback: fallback }), async (s) => { dev.push(s); return true; });
    return { r: await f('bob', 'Hi.'), dev };
  };
  assert.deepStrictEqual(await run({}), { r: true, dev: [] });
  assert.strictEqual((await run({ cutDuring: true })).r, false);
  const b = await run({ blob: null });
  assert.deepStrictEqual(b, { r: true, dev: [['Hi.']] });
  assert.deepStrictEqual((await run({ on: false })).dev, [['Hi.']]);
  assert.deepStrictEqual((await run({ on: false, fallback: false })).dev, []);
});

test('interjection that finds the turn over is sent as a new voice message; other errors toast', async () => {
  const src = sliceBetween('async function voiceCallInterject(', 'async function voiceCallAnswerAsk');
  const run = async (resp) => {
    const sent = [], toasts = [], posts = [];
    const vc = { agent: 'bob' }; const state = { voiceCall: vc };
    const f = new Function('addUserBubble', 'setBubbleTime', 'msgTimeLabel', 'scrollChat', 'voiceCallPost', 'streams', 'setLive', 'paintStatus', 'toast', 'voiceCallSend', 'state', 'stick',
      src.replace(/\bvoiceCall\b(?!Post|Send|Interject)/g, 'state.voiceCall') + '\nreturn voiceCallInterject;')(
      () => ({ el: 1 }), () => {}, () => '', () => {}, async (u, b) => { posts.push([u, b]); return { json: async () => resp }; }, new Map(), () => {}, () => {}, (t) => toasts.push(t), (v, t, el) => sent.push([t, !!el]), state, true);
    await f(vc, 'wait stop');
    return { sent, toasts, posts };
  };
  assert.deepStrictEqual((await run({ success: true })).sent, []);
  const a = await run({ success: false, error: 'Agent is not currently processing a turn' });
  assert.deepStrictEqual(a.sent, [['wait stop', true]]);
  assert.deepStrictEqual(a.posts[0], ['/api/chat/interject', { agent: 'bob', message: 'wait stop' }]);
  const b = await run({ success: false, error: 'boom' });
  assert.deepStrictEqual(b.sent, []);
  assert.match(b.toasts[0], /boom/);
});

test('page hidden hangs up and the toast comes when it returns; the wake lock is asked for again when visible', () => {
  const h = sliceBetween("document.addEventListener('visibilitychange'", 'function voiceSheet()');
  assert.match(h, /if \(voiceCall\) \{ voiceCallBgNote = true; voiceCallHangUp\(\); \}/);
  assert.match(h, /The call ended when the app went to the background\./);
  assert.match(h, /if \(voiceCall\) voiceWakeAcquire\(voiceCall\)/);
  assert.match(h, /voiceMicStop\(\)[\s\S]*voiceMicCancel\(\)/, 'phase-1 dictation behaviour is kept');
  // run it
  const handlers = [];
  const log = [];
  const doc = { hidden: false, addEventListener: (t, fn) => handlers.push(fn) };
  const state = { voiceCall: { x: 1 }, voiceCallBgNote: false };
  const body = h.replace(/\bvoiceCallBgNote\b/g, 'state.voiceCallBgNote').replace(/\bvoiceCall\b(?!BgNote|HangUp)/g, 'state.voiceCall').replace('function voiceSheet()', '');
  new Function('document', 'state', 'toast', 'voiceCallHangUp', 'voiceWakeAcquire', 'voiceRoomStop', 'voiceTestStop', 'voiceRec', 'voiceMicStop', 'voiceMicCancel', body)(
    doc, state, (t) => log.push('toast:' + t), () => { log.push('hangUp'); state.voiceCall = null; }, () => log.push('wake'), () => {}, () => {}, { state: 'idle' }, () => {}, () => {});
  doc.hidden = true; handlers[0]();
  assert.deepStrictEqual(log, ['hangUp']);
  doc.hidden = false; handlers[0]();
  assert.deepStrictEqual(log, ['hangUp', 'toast:The call ended when the app went to the background.']);
  state.voiceCall = { y: 1 }; handlers[0]();
  assert.strictEqual(log[2], 'wake');
});

test('switching agent or leaving the chat view hangs up', () => {
  assert.match(sliceBetween('function show(name)', 'function hashFor'), /if \(name !== 'chat' && typeof voiceCall !== 'undefined' && voiceCall\) voiceCallHangUp\(\);/);
  assert.match(sliceBetween('async function openChat(name)', "localStorage.setItem('hub-mobile-last'"), /if \(!same && voiceCall\) voiceCallHangUp\(\);/);
});

test('Voice sheet: Talk mode, Interrupt sensitivity (live), Room check; the old hint is gone', () => {
  const sheet = sliceBetween('function voiceSheet()', 'function openVoiceSheet');
  for (const s of ['Talk mode', 'Hands-free', 'Tap to talk', 'name="vs-mode"', 'Interrupt sensitivity', 'id="vs-sens"', 'Room check', 'vs-room-out']) assert.ok(sheet.includes(s), s);
  assert.match(sheet, /voicePrefsSave\(\{ mode: e\.target\.value \}\)/);
  assert.match(sheet, /voicePrefsSave\(\{ interruptSensitivity: Number\(sens\.value\) \}\)/);
  assert.match(sheet, /if \(voiceCall\) voiceCall\.vad\.setInterruptSensitivity\(Number\(sens\.value\)\)/);
  assert.match(sheet, /if \(voiceCall\) voiceCall\.vad\.setMicLevel\(Number\(level\.value\)\)/);
  assert.match(sheet, /voiceRoomStop\(\)/, 'closing the sheet stops a room check');
  assert.ok(!/Hands-free conversation comes next/.test(js + html));
  assert.match(js, /\+ VOICE_CALL_HELP/);
});

test('room check: 2.5 s speech then 2.5 s quiet, result sets and saves both values, "No speech heard" otherwise', () => {
  const run = sliceBetween('async function voiceRoomRun()', '// ── Voice sheet (menu, Voice) ──');
  assert.match(run, /if \(el < 2\.5\) speech\.push\(db\); else if \(el >= 2\.8 && el < 5\) quiet\.push\(db\)/);
  assert.match(run, /Say a sentence… \$\{Math\.ceil\(2\.5 - el\)\}/);
  assert.match(run, /Now stay quiet… \$\{Math\.ceil\(5 - el\)\}/);
  assert.match(run, /if \(el >= 5\) \{ finish\(\); return; \}/);
  assert.match(run, /No speech heard: check the microphone and its permission\./);
  assert.match(run, /voicePrefsSave\(\{ micLevel: r\.micLevel, interruptSensitivity: r\.interruptSensitivity \}\)/);
  assert.match(run, /voiceCall\.vad\.setMicLevel\(r\.micLevel\)/);
  assert.match(run, /if \(voiceCall\) \{ toast\('Hang up first/);
  const pure = sliceBetween('function voiceRoomResult(', 'const voiceRoom =');
  const f = new Function('voiceRoomCheck', pure + '\nreturn voiceRoomResult;')(C.voiceRoomCheck);
  assert.deepStrictEqual(f([], [-60], 50), { heard: false });
  assert.deepStrictEqual(f([-80, -75, -90], [-80], 50), { heard: false }, 'nothing above -60 dBFS');
  const quietRoom = f([-40, -35, -50, -38, -90, -95], [-75, -78, -80], 50);
  assert.strictEqual(quietRoom.heard, true);
  assert.ok(quietRoom.micLevel > 50, 'low speech raises the mic level');
  assert.ok(quietRoom.interruptSensitivity > 50, 'a quiet room keeps sensitivity high');
  const noisy = f([-25, -22, -28, -90], [-30, -32, -29], 50);
  assert.ok(noisy.interruptSensitivity < 30, 'a noisy room lowers it');
  for (const r of [quietRoom, noisy]) assert.ok(r.micLevel >= 0 && r.micLevel <= 100 && r.interruptSensitivity >= 0 && r.interruptSensitivity <= 100);
});

test('the summary line is not saved: a note in the open chat or a toast', () => {
  const deps = sliceBetween('function voiceCallDeps(vc)', 'function voiceCallStart()');
  assert.match(deps, /summary: \(text\) => \{ if \(chatOpenFor\(agent\)\) \{ addNote\(text\); scrollChat\(true\); \} else toast\(text, 6000\); \}/);
});

test('the call block in mobile.js is still byte-identical to lib/ui-voice-call.js', () => {
  const lib = read('lib/ui-voice-call.js');
  const b = '// ── voice call (begin) ──', e = '// ── voice call (end) ──';
  const norm = (s) => s.split('\n').map(l => l.replace(/^ {4}/, '')).join('\n');
  const libBlock = lib.slice(lib.indexOf(b), lib.indexOf(e) + e.length);
  const jsBlock = js.slice(js.indexOf(b), js.indexOf(e) + e.length);
  assert.ok(libBlock.length > 1000);
  assert.strictEqual(norm(jsBlock), norm(libBlock));
});
