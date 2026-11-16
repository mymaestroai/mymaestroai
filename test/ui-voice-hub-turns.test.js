'use strict';
// On a call, a turn the hub started (a scheduled task, a consultation, a job report, ...) is never read aloud; the caller's words wait for his own
// turn while one runs (kept, said "One moment, I'm finishing something in the background.", state 'background'), and a hub turn marked for the owner
// (for_owner) gives a cue (pref hubCue). Controller: lib/ui-voice-call.js (voiceCreateCall with fake deps). Pages: the hub-event handlers of app.js
// and mobile.js, cut out of the source and run against stubs, as the other page tests do.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
Object.assign(globalThis, require('../lib/ui-voice'));   // the call file uses these helpers as globals, like the pages
const V = require('../lib/ui-voice');
const C = require('../lib/ui-voice-call');
const CD = require('../lib/ui-call-display');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js'), mob = read('mobile.js'), mobHtml = read('mobile.html');
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const LINE = 'One moment, I\'m finishing something in the background.';
const CUE = 'Something came in for you; it\'s in the chat.';

function harness(over, prefs) {
  const h = { t: 0, timers: [], nextId: 1, states: [], spoken: [], pend: [], sent: [], plain: [], interjected: [], stops: 0, chimes: 0, running: false, bg: false, prefs: Object.assign({ micLevel: 50, interruptSensitivity: 50, continueWait: 0 }, prefs || {}) };
  h.setTimer = (fn, ms) => { const id = h.nextId++; h.timers.push({ id, at: h.t + ms, fn }); return id; };
  h.clearTimer = (id) => { h.timers = h.timers.filter(x => x.id !== id); };
  h.advance = async (ms) => {
    const end = h.t + ms;
    for (;;) {
      const due = h.timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      h.timers = h.timers.filter(x => x !== due); h.t = due.at; due.fn(); await tick();
    }
    h.t = end; await tick();
  };
  h.finish = async (ok = true) => { const r = h.pend.shift(); if (r) r(ok); await tick(); };
  h.vad = { start: async (hd) => { h.vadHandlers = hd; }, stop() {}, setPlaybackActive() {} };
  h.deps = {
    agent: 'alice', now: () => h.t, setTimer: h.setTimer, clearTimer: h.clearTimer, prefs: () => h.prefs, vad: h.vad,
    stt: async (audio) => audio.text, isTurnRunning: () => h.running || h.bg,
    backgroundBusy: () => h.bg, chime: () => { h.chimes++; },
    send: async (t) => { h.sent.push(t); h.running = true; }, interject: async (t) => { h.interjected.push(t); }, stop: () => { h.stops++; },
    speak: (text) => new Promise((resolve) => { h.spoken.push(text); h.pend.push(resolve); }),
    cancelSpeech: () => { const r = h.pend.shift(); if (r) r(false); },
    answerAsk() {},
    server: { start: async () => ({ callId: 'call-1', held: [] }), heartbeat: async (cid) => ({ callId: cid, held: [] }), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} },
    ui: { state: (n) => h.states.push(n), heard() {}, held() {}, toast() {}, summary() {} },
  };
  Object.assign(h.deps, over || {});
  h.call = C.voiceCreateCall(h.deps);
  h.say = async (text) => { h.vadHandlers.onSpeechStart(); h.vadHandlers.onSpeechEnd({ text }); await tick(); await h.advance(100); };
  return h;
}
async function started(over, prefs) { const h = harness(over, prefs); assert.strictEqual(await h.call.start(), true); return h; }

// ── the cue (hubCue) ──
test('a hub turn marked for the owner: hubCue "cue" gives the chime and the spoken line once, never what came in', async () => {
  const h = await started();
  h.call.onHubOwner();
  await tick();
  assert.strictEqual(h.chimes, 1);
  assert.deepStrictEqual(h.spoken, [CUE]);
  assert.ok(!/task|job|consult|report/i.test(CUE), 'the line says nothing about what came in');
  await h.finish();
});

test('hubCue "chime": the chime only; "off": nothing', async () => {
  const c = await started(null, { hubCue: 'chime' });
  c.call.onHubOwner(); await tick();
  assert.strictEqual(c.chimes, 1);
  assert.deepStrictEqual(c.spoken, []);
  const o = await started(null, { hubCue: 'off' });
  o.call.onHubOwner(); await tick();
  assert.strictEqual(o.chimes, 0);
  assert.deepStrictEqual(o.spoken, []);
});

test('at most one cue per 30 s', async () => {
  const h = await started();
  h.call.onHubOwner(); await tick(); await h.finish();
  await h.advance(10000);
  h.call.onHubOwner(); await tick();
  assert.strictEqual(h.chimes, 1, 'a second one within 30 s gives nothing');
  assert.deepStrictEqual(h.spoken, [CUE]);
  await h.advance(21000);
  h.call.onHubOwner(); await tick();
  assert.strictEqual(h.chimes, 2, 'after 30 s it may come again');
  assert.deepStrictEqual(h.spoken, [CUE, CUE]);
});

test('the cue waits while a reply is playing and while the caller is speaking', async () => {
  const h = await started();
  h.call.onReplyText('Here is the answer.', true);
  await tick();
  assert.deepStrictEqual(h.spoken, ['Here is the answer.']);
  h.call.onHubOwner(); await tick();
  assert.strictEqual(h.chimes, 0, 'not over a reply');
  await h.finish();
  assert.strictEqual(h.chimes, 1, 'queued after it');
  assert.deepStrictEqual(h.spoken, ['Here is the answer.', CUE]);
  await h.finish();
  // the caller speaking
  const s = await started();
  s.vadHandlers.onSpeechStart();
  s.call.onHubOwner(); await tick();
  assert.strictEqual(s.chimes, 0, 'not over the caller');
  assert.deepStrictEqual(s.spoken, []);
  s.vadHandlers.onMisfire(); await tick();
  assert.strictEqual(s.chimes, 1, 'after he stops');
  assert.deepStrictEqual(s.spoken, [CUE]);
});

// ── the caller's words wait for his own turn ──
test('speaking while a hub turn runs: no interjection; the line once; the state shown; the words are sent once, as his own message, when it ends', async () => {
  const h = await started();
  h.bg = true;
  await h.say('please look at the mail');
  assert.deepStrictEqual(h.interjected, [], 'not interjected into the hub turn');
  assert.deepStrictEqual(h.sent, [], 'not sent yet');
  assert.deepStrictEqual(h.spoken, [LINE], 'said once, at once');
  await h.finish();
  assert.ok(h.states.includes('background'), 'the state is shown');
  assert.strictEqual(h.states[h.states.length - 1], 'background');
  assert.strictEqual(h.call.background, true);
  h.bg = false;
  await h.call.backgroundDone();
  assert.deepStrictEqual(h.sent, ['please look at the mail'], 'his own message');
  assert.strictEqual(h.call.background, false);
  await h.call.backgroundDone();
  assert.deepStrictEqual(h.sent, ['please look at the mail'], 'sent once');
});

test('two utterances while waiting are joined in order, one message, the line not repeated at once', async () => {
  const h = await started();
  h.bg = true;
  await h.say('first part');
  await h.finish();
  await h.say('second part');
  assert.deepStrictEqual(h.spoken, [LINE], 'the second utterance does not say it again');
  h.bg = false;
  await h.call.backgroundDone();
  assert.deepStrictEqual(h.sent, ['first part second part']);
  assert.deepStrictEqual(h.interjected, []);
});

test('the line repeats after 30 s while the background turn still runs, not before; not when it has ended', async () => {
  const h = await started();
  h.bg = true;
  await h.say('wait for me');
  await h.finish();
  await h.advance(29000);
  assert.deepStrictEqual(h.spoken, [LINE], 'not before 30 s');
  await h.advance(1500);
  assert.deepStrictEqual(h.spoken, [LINE, LINE], 'after 30 s');
  await h.finish();
  await h.advance(30500);
  assert.deepStrictEqual(h.spoken, [LINE, LINE, LINE], 'and again 30 s later');
  await h.finish();
  h.bg = false;   // it ended but nobody told the call yet: the timer finds out and releases the words, saying nothing
  await h.advance(30500);
  assert.deepStrictEqual(h.spoken, [LINE, LINE, LINE]);
  assert.deepStrictEqual(h.sent, ['wait for me']);
});

test('backgroundCue "off": no line, no state, the words are still kept and sent; "show": the state only', async () => {
  const o = await started(null, { backgroundCue: 'off' });
  o.bg = true;
  await o.say('keep this');
  assert.deepStrictEqual(o.spoken, []);
  assert.ok(!o.states.includes('background'));
  assert.deepStrictEqual(o.interjected, []);
  o.bg = false; await o.call.backgroundDone();
  assert.deepStrictEqual(o.sent, ['keep this']);
  const s = await started(null, { backgroundCue: 'show' });
  s.bg = true;
  await s.say('keep that');
  assert.deepStrictEqual(s.spoken, [], 'nothing said');
  assert.strictEqual(s.states[s.states.length - 1], 'background', 'the state shown');
  await s.advance(31000);
  assert.deepStrictEqual(s.spoken, [], 'no repeat either');
  s.bg = false; await s.call.backgroundDone();
  assert.deepStrictEqual(s.sent, ['keep that']);
});

test('while his own turn runs, speaking still interjects as today', async () => {
  const h = await started();
  await h.say('hello there');
  assert.deepStrictEqual(h.sent, ['hello there']);
  h.bg = true;   // (a hub turn queued behind his own one: his own turn is the one that counts)
  await h.say('and one more thing');
  assert.deepStrictEqual(h.interjected, ['and one more thing']);
  assert.ok(!h.spoken.includes(LINE));
  const r = await started();   // the page's isTurnRunning is true for a turn of his own, and backgroundBusy is false then
  r.running = true;
  await r.say('a correction');
  assert.deepStrictEqual(r.interjected, ['a correction']);
  assert.deepStrictEqual(r.spoken, []);
});

test('a stop command while waiting drops the kept words and says nothing more about it', async () => {
  const h = await started();
  h.bg = true;
  await h.say('check the calendar');
  await h.finish();
  await h.say('stop');
  assert.strictEqual(h.stops, 0, 'the background work is not stopped');
  assert.deepStrictEqual(h.spoken, [LINE], 'no "Stopped.", no more lines');
  assert.strictEqual(h.call.background, false);
  await h.advance(61000);
  assert.deepStrictEqual(h.spoken, [LINE], 'no repeat');
  h.bg = false;
  await h.call.backgroundDone();
  assert.deepStrictEqual(h.sent, [], 'the words are gone');
});

test('hanging up while waiting sends the kept words as a plain message so they land in the chat', async () => {
  const h = await started({ sendPlain: async (t) => { h.plain.push(t); } });
  h.bg = true;
  await h.say('first words');
  await h.say('more words');
  await h.call.hangUp();
  assert.deepStrictEqual(h.plain, ['first words more words']);
  assert.deepStrictEqual(h.sent, [], 'not a voice turn');
  const g = await started();   // a page without sendPlain: the ordinary send
  g.bg = true;
  await g.say('only words');
  g.call.release('pagehide');
  assert.deepStrictEqual(g.sent, ['only words']);
});

// ── prefs ──
test('prefs: hubCue and backgroundCue default to "cue" and "say"; invalid values give the defaults', () => {
  assert.strictEqual(V.VOICE_DEFAULT_PREFS.hubCue, 'cue');
  assert.strictEqual(V.VOICE_DEFAULT_PREFS.backgroundCue, 'say');
  assert.deepStrictEqual(V.VOICE_HUB_CUES, ['off', 'chime', 'cue']);
  assert.deepStrictEqual(V.VOICE_BACKGROUND_CUES, ['off', 'show', 'say']);
  const clean = V.voiceCleanPrefs;
  assert.strictEqual(clean({}).hubCue, 'cue');
  assert.strictEqual(clean({}).backgroundCue, 'say');
  for (const v of ['chime', 'off', 'cue']) assert.strictEqual(clean({ hubCue: v }).hubCue, v);
  for (const v of ['off', 'show', 'say']) assert.strictEqual(clean({ backgroundCue: v }).backgroundCue, v);
  for (const bad of ['loud', '', 7, null, true, ['cue'], 'show']) assert.strictEqual(clean({ hubCue: bad }).hubCue, 'cue', String(bad));
  for (const bad of ['loud', '', 7, null, true, ['say'], 'chime']) assert.strictEqual(clean({ backgroundCue: bad }).backgroundCue, 'say', String(bad));
  const mem = (o) => ({ getItem: () => (o ? JSON.stringify(o) : null), setItem() {} });
  assert.strictEqual(V.voiceLoadPrefs(mem({ hubCue: 'nope', backgroundCue: 'nope' })).hubCue, 'cue');
  assert.strictEqual(V.voiceLoadPrefs(mem({ hubCue: 'nope', backgroundCue: 'nope' })).backgroundCue, 'say');
  assert.strictEqual(V.voiceLoadPrefs(mem({ hubCue: 'off', backgroundCue: 'show' })).hubCue, 'off');
  assert.strictEqual(V.voiceLoadPrefs(mem({ hubCue: 'off', backgroundCue: 'show' })).backgroundCue, 'show');
});

// ── the pages: hub events ──
function deskEnv(over) {
  let clock = 1000;
  const S = { call: null, agent: 'alice', chatId: 'c1', active: true, own: new Map(), hub: new Map(), owner: new Set(), hubEnded: new Map(), asks: new Map(), sendSeq: 0, expecting: false };
  const calls = { replies: [], activities: [], owners: 0, bgDone: 0 };
  S.call = { callId: 'c-1', onReplyText: (t, d) => calls.replies.push([t, d]), onActivity: (i) => calls.activities.push(i), onHubOwner: () => { calls.owners++; }, backgroundDone: () => { calls.bgDone++; } };
  const st = Object.assign({ voiceCallS: S, voiceDisp: { turnSeq: new Map() }, hubOriginLabel: (o) => 'label of ' + (o && o.kind), hubToast() {}, voiceDispMood() {}, voiceCallHangUp() {},
    voiceCallRunning: () => true, chats: { c1: { agent: 'alice', status: 'thinking' } }, voiceSentences: V.voiceSentences, voiceSpeechText: V.voiceSpeechText, Date: { now: () => clock } }, over || {});
  const a = app.indexOf('    // A turn the hub started runs (a scheduled task, a consultation'), b = app.indexOf("    document.addEventListener('visibilitychange'", a);
  assert.ok(a > 0 && b > a, 'hub event block of app.js found');
  const names = Object.keys(st);
  const f = new Function(...names, app.slice(a, b) + '\nreturn { voiceCallHubEvent, voiceCallBackgroundBusy, voiceCallHubIdle };')(...names.map(n => st[n]));
  return { f, S, calls, setClock: (t) => { clock = t; } };
}

test('desktop: a scheduled-task turn ends during a call: nothing is spoken', () => {
  const { f, calls } = deskEnv();
  f.voiceCallHubEvent('turn_start', { agent: 'alice', turnId: 'h1', origin: { kind: 'schedule', label: 'Morning report' } });
  f.voiceCallHubEvent('turn_delta', { agent: 'alice', turnId: 'h1', text: 'Sales are up. More.' });
  f.voiceCallHubEvent('turn_activity', { agent: 'alice', turnId: 'h1', item: { kind: 'tool', tool: 'Bash' } });
  f.voiceCallHubEvent('turn_end', { agent: 'alice', turnId: 'h1', ok: true, reply: 'Sales are up. More.' });
  assert.deepStrictEqual(calls.replies, []);
  assert.deepStrictEqual(calls.activities, []);
  assert.strictEqual(calls.owners, 0, 'not marked for the owner: no cue');
});

test('desktop: a consultation turn\'s reply and input are never spoken or shown on the call', () => {
  const { f, calls, S } = deskEnv();
  f.voiceCallHubEvent('turn_start', { agent: 'alice', turnId: 'k1', origin: { kind: 'consultation', from: 'bob', text: 'Bob asks: can you check the totals?' } });
  f.voiceCallHubEvent('turn_delta', { agent: 'alice', turnId: 'k1', text: 'Checking. The totals match.' });
  f.voiceCallHubEvent('turn_end', { agent: 'alice', turnId: 'k1', ok: true, reply: 'Checking. The totals match.' });
  assert.deepStrictEqual(calls.replies, []);
  assert.deepStrictEqual(calls.activities, []);
  assert.ok(!app.slice(app.indexOf('    // A turn the hub started runs (a scheduled task'), app.indexOf("    document.addEventListener('visibilitychange'")).includes('${label}'), 'no "<label>: <first sentence>" line any more');
  // a turn of the caller's own is still read
  f.voiceCallHubEvent('turn_start', { agent: 'alice', turnId: 'u1', origin: { kind: 'user' } });
  f.voiceCallHubEvent('turn_delta', { agent: 'alice', turnId: 'u1', text: 'Hello.' });
  f.voiceCallHubEvent('turn_end', { agent: 'alice', turnId: 'u1', ok: true, reply: 'Hello.' });
  assert.deepStrictEqual(calls.replies, [['Hello.', false], ['Hello.', true]]);
  assert.strictEqual(S.own.size, 0);
});

test('desktop: for_owner marks a hub turn; its end gives the cue; one marked just after it ended too; an unmarked one gives nothing', () => {
  const { f, calls, setClock } = deskEnv();
  const ev = f.voiceCallHubEvent;
  ev('turn_start', { agent: 'alice', turnId: 'h1', origin: { kind: 'consultation', from: 'bob' } });
  ev('for_owner', { agent: 'alice', reason: 'needs you', turnId: 'h1', origin: { kind: 'consultation' } });
  assert.strictEqual(calls.owners, 0, 'not while it runs');
  ev('turn_end', { agent: 'alice', turnId: 'h1', ok: true, reply: 'Done.' });
  assert.strictEqual(calls.owners, 1);
  ev('turn_start', { agent: 'alice', turnId: 'h2', origin: { kind: 'schedule' } });
  ev('turn_end', { agent: 'alice', turnId: 'h2', ok: true, reply: 'Done.' });
  assert.strictEqual(calls.owners, 1, 'unmarked: nothing');
  setClock(3000);
  ev('for_owner', { agent: 'alice', reason: 'late', turnId: 'h2', origin: { kind: 'schedule' } });   // 2 s after it ended
  assert.strictEqual(calls.owners, 2);
  ev('turn_start', { agent: 'alice', turnId: 'h3', origin: { kind: 'schedule' } });
  ev('turn_end', { agent: 'alice', turnId: 'h3', ok: true, reply: 'Done.' });
  setClock(9000);
  ev('for_owner', { agent: 'alice', reason: 'too late', turnId: 'h3', origin: { kind: 'schedule' } });   // 6 s after
  assert.strictEqual(calls.owners, 2);
  ev('for_owner', { agent: 'zed', reason: 'x', turnId: 'h9', origin: { kind: 'schedule' } });   // another agent
  ev('for_owner', { agent: 'alice', reason: 'x', turnId: 'u9', origin: { kind: 'user' } });   // his own turn
  assert.strictEqual(calls.owners, 2);
});

test('desktop: the caller\'s words wait only while a hub-started turn runs and none of his own; they are released at its end or when the agent is idle', () => {
  let running = true;
  const { f, S, calls } = deskEnv({ voiceCallRunning: () => running });
  const ev = f.voiceCallHubEvent;
  assert.strictEqual(f.voiceCallBackgroundBusy(), false, 'nothing runs');
  ev('turn_start', { agent: 'alice', turnId: 'h1', origin: { kind: 'schedule' } });
  assert.strictEqual(f.voiceCallBackgroundBusy(), true);
  S.expecting = true;
  assert.strictEqual(f.voiceCallBackgroundBusy(), false, 'a message of his own is going out');
  S.expecting = false;
  ev('turn_start', { agent: 'alice', turnId: 'u1', origin: { kind: 'user' } });
  assert.strictEqual(f.voiceCallBackgroundBusy(), false, 'his own turn runs: today\'s interjection');
  ev('turn_end', { agent: 'alice', turnId: 'u1', ok: true, reply: 'ok' });
  assert.strictEqual(calls.bgDone, 0, 'a turn of his own ending does not release anything');
  assert.strictEqual(f.voiceCallBackgroundBusy(), true);
  ev('turn_end', { agent: 'alice', turnId: 'h1', ok: true, reply: 'Done.' });
  assert.strictEqual(calls.bgDone, 1, 'released at its end');
  ev('turn_start', { agent: 'alice', turnId: 'h4', origin: { kind: 'schedule' } });
  running = false;
  f.voiceCallHubIdle('alice');   // the status feed says idle before any turn_end came
  assert.strictEqual(calls.bgDone, 2, 'released when the agent goes idle');
  assert.strictEqual(S.hub.size, 0);
  f.voiceCallHubIdle('zed');
  assert.strictEqual(calls.bgDone, 2);
});

function phoneEnv(over) {
  let clock = 1000;
  const calls = { replies: [], activities: [], owners: 0, bgDone: 0 };
  const call = { state: 'listening', callId: 'c-1', onReplyText: (t, d) => calls.replies.push([t, d]), onActivity: (i) => calls.activities.push(i), onAsk() {}, onAskDone() {}, onHeld() {}, onHeldDone() {},
    onHubOwner: () => { calls.owners++; }, backgroundDone: () => { calls.bgDone++; } };
  const vc = { agent: 'bob', call, callTurns: new Set(), hubTurns: new Map(), hubOwner: new Set(), hubEnded: new Map(), asks: new Map(), lastText: '', expecting: false, startedAt: 0 };
  const st = Object.assign({ voiceCall: vc, voiceSentences: V.voiceSentences, voiceSpeechText: V.voiceSpeechText, originLabel: (o) => (o && o.kind) || '', voiceCallHangUp() {}, toast() {},
    voiceDisp: { turnSeq: new Map() }, voiceDispMood() {}, ownTurnFor: () => false, isBusy: () => true, Date: { now: () => clock } }, over || {});
  const a = mob.indexOf('function voiceCallTurnStart(ev)'), b = mob.indexOf('// ── Room check (5 s)', a);
  assert.ok(a > 0 && b > a, 'hub event block of mobile.js found');
  const names = Object.keys(st);
  const f = new Function(...names, mob.slice(a, b) + '\nreturn { voiceCallTurnStart, voiceCallTurnDelta, voiceCallTurnActivity, voiceCallTurnEnd, voiceCallForOwner, voiceCallBackgroundBusy, voiceCallHubIdle };')(...names.map(n => st[n]));
  return { f, vc, calls, setClock: (t) => { clock = t; } };
}

test('phone: a scheduled-task turn and a consultation end during a call: nothing is spoken', () => {
  const { f, calls, vc } = phoneEnv();
  f.voiceCallTurnStart({ agent: 'bob', turnId: 'h1', origin: { kind: 'schedule', label: 'Morning report' } });
  f.voiceCallTurnStart({ agent: 'bob', turnId: 'k1', origin: { kind: 'consultation', from: 'Alice', text: 'Alice asks: is it ready?' } });
  f.voiceCallTurnDelta({ agent: 'bob', turnId: 'h1', text: 'Sales are up.' });
  f.voiceCallTurnActivity({ agent: 'bob', turnId: 'k1', item: { kind: 'tool', tool: 'Read' } });
  f.voiceCallTurnEnd({ agent: 'bob', turnId: 'h1', ok: true, reply: 'Sales are up. More.' });
  f.voiceCallTurnEnd({ agent: 'bob', turnId: 'k1', ok: true, reply: 'Ready. More.' });
  assert.deepStrictEqual(calls.replies, []);
  assert.deepStrictEqual(calls.activities, []);
  assert.strictEqual(vc.hubTurns.size, 0);
  assert.ok(!mob.slice(mob.indexOf('function voiceCallTurnEnd(ev)'), mob.indexOf('function voiceCallTurnMood')).includes('${label}'), 'no "<label>: <first sentence>" line any more');
});

test('phone: for_owner cue, late for_owner, unmarked turns, and the release of the caller\'s kept words', () => {
  let busy = true;
  const { f, calls, vc, setClock } = phoneEnv({ isBusy: () => busy });
  f.voiceCallTurnStart({ agent: 'bob', turnId: 'h1', origin: { kind: 'schedule' } });
  assert.strictEqual(f.voiceCallBackgroundBusy(vc), true);
  f.voiceCallForOwner({ agent: 'bob', reason: 'needs you', turnId: 'h1', origin: { kind: 'schedule' } });
  assert.strictEqual(calls.owners, 0);
  f.voiceCallTurnEnd({ agent: 'bob', turnId: 'h1', ok: true, reply: 'Done.' });
  assert.strictEqual(calls.owners, 1);
  assert.strictEqual(calls.bgDone, 1, 'the kept words are released');
  f.voiceCallTurnStart({ agent: 'bob', turnId: 'h2', origin: { kind: 'schedule' } });
  f.voiceCallTurnEnd({ agent: 'bob', turnId: 'h2', ok: true, reply: 'Done.' });
  assert.strictEqual(calls.owners, 1, 'unmarked: nothing');
  setClock(3000);
  f.voiceCallForOwner({ agent: 'bob', reason: 'late', turnId: 'h2', origin: { kind: 'schedule' } });
  assert.strictEqual(calls.owners, 2);
  f.voiceCallTurnStart({ agent: 'bob', turnId: 'u1', origin: { kind: 'user' } });
  assert.strictEqual(f.voiceCallBackgroundBusy(vc), false, 'a turn of his own runs: interjection as today');
  f.voiceCallTurnEnd({ agent: 'bob', turnId: 'u1', ok: true, reply: 'ok' });
  f.voiceCallTurnStart({ agent: 'bob', turnId: 'h5', origin: { kind: 'consult' } });
  busy = false;
  f.voiceCallHubIdle('bob');
  assert.strictEqual(calls.bgDone, 3, 'released when the agent goes idle');
  assert.strictEqual(vc.hubTurns.size, 0);
});

// ── wiring in the page sources, the display and the settings ──
test('both pages wire for_owner, the deps, the idle hook, the state text and the two settings selects', () => {
  assert.match(app, /'turn_end', 'for_owner', 'ask_user'/);
  assert.ok(mob.includes("on('for_owner', voiceCallForOwner);"));
  for (const [name, src] of [['app.js', app], ['mobile.js', mob]]) {
    assert.ok(src.includes('backgroundBusy: ('), name + ': dep backgroundBusy');
    assert.ok(src.includes('sendPlain: ('), name + ': dep sendPlain');
    assert.ok(src.includes('voiceCallHubIdle(name)'), name + ': the status feed tells the call the agent is idle');
    assert.ok(src.includes("background: 'Working in the background'"), name + ': state text');
    assert.ok(src.includes("hubCue: 'cue', backgroundCue: 'say' };"), name + ': defaults');
    assert.ok(src.includes('const VOICE_HUB_CUES = ') && src.includes('const VOICE_BACKGROUND_CUES = '), name + ': choices');
  }
  assert.ok(app.includes('id="st-voice-hubcue"') && app.includes('id="st-voice-bgcue"'), 'desktop selects');
  assert.ok(app.includes('When something comes in during a call') && app.includes('While I finish something in the background'));
  assert.ok(app.includes('prefs.hubCue = hubCue.value') && app.includes('prefs.backgroundCue = bgCue.value'), 'desktop saves them');
  assert.ok(mob.includes('id="vs-hubcue"') && mob.includes('id="vs-bgcue"'), 'phone sheet');
  assert.ok(mob.includes("voicePrefsSave({ hubCue: hubCue.value })") && mob.includes("voicePrefsSave({ backgroundCue: bgCue.value })"), 'phone sheet saves them');
  assert.ok(mob.includes("save({ hubCue: e.target.value })") && mob.includes("save({ backgroundCue: e.target.value })"), 'phone panel saves them');
  assert.ok(mobHtml.includes('id="vp-hubcue"') && mobHtml.includes('id="vp-bgcue"'), 'phone panel selects');
  for (const label of ['Short cue', 'Chime', 'Show it', 'Say it']) assert.ok(mobHtml.includes(label), label);
  // the controller copies carry the new lines
  for (const [name, src] of [['app.js', app], ['mobile.js', mob]]) {
    assert.ok(src.includes("One moment, I\\'m finishing something in the background."), name);
    assert.ok(src.includes("Something came in for you; it\\'s in the chat."), name);
  }
});

test('the call display shows the "background" state with its own words', () => {
  assert.strictEqual(CD.STATE_TEXT.background, 'Working in the background');
  assert.strictEqual(CD.mapDisplayState('background', {}), 'thinking');
});

test('agents on a call: held items, announcements and decisions are not changed (a held announcement is not a hub turn reply)', async () => {
  const h = await started();
  h.call.onHeld({ id: 'job:1', label: 'Nightly job finished' }, false);
  await h.advance(2000);
  assert.deepStrictEqual(h.spoken, ['Nightly job finished. Now, or after we\'re done?']);
  assert.strictEqual(h.chimes, 0);
});
