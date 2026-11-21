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

test('hanging up while waiting hands the kept words to the page\'s message box: never sent, never interjected', async () => {
  const h = await started({ keepWords: (t) => { h.plain.push(t); } });
  h.bg = true;
  await h.say('first words');
  await h.say('more words');
  await h.call.hangUp();
  assert.deepStrictEqual(h.plain, ['first words more words']);
  assert.deepStrictEqual(h.sent, [], 'no POST');
  assert.deepStrictEqual(h.interjected, [], 'no interjection into the hub turn');
  const g = await started({ keepWords: (t) => { g.plain.push(t); } });
  g.bg = true;
  await g.say('only words');
  g.call.release('pagehide');
  assert.deepStrictEqual(g.plain, ['only words']);
  assert.deepStrictEqual(g.sent, []);
  assert.deepStrictEqual(g.interjected, []);
  const n = await started();   // a page without keepWords: nothing is sent either
  n.bg = true;
  await n.say('lost but not sent');
  n.call.release('pagehide');
  assert.deepStrictEqual(n.sent, []);
  assert.deepStrictEqual(n.interjected, []);
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
    voiceCallRunning: () => true, busyRun: {}, agentStatus: { alice: { busy: true } }, chats: { c1: { agent: 'alice', status: 'thinking' } }, voiceSentences: V.voiceSentences, voiceSpeechText: V.voiceSpeechText, Date: { now: () => clock } }, over || {});
  const a = app.indexOf('    // A turn the hub started runs (a scheduled task, a consultation'), b = app.indexOf("    document.addEventListener('visibilitychange'", a);
  assert.ok(a > 0 && b > a, 'hub event block of app.js found');
  const names = Object.keys(st);
  const f = new Function(...names, app.slice(a, b) + '\nreturn { voiceCallHubEvent, voiceCallBackgroundBusy, voiceCallHubIdle, voiceCallSeedHub };')(...names.map(n => st[n]));
  return { f, S, st, calls, setClock: (t) => { clock = t; } };
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
  let running = false;
  const { f, S, calls } = deskEnv({ voiceCallRunning: () => running });
  const ev = f.voiceCallHubEvent;
  assert.strictEqual(f.voiceCallBackgroundBusy(), false, 'nothing runs');
  running = true;
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
  assert.strictEqual(calls.bgDone, 0, 'its end alone does not release while the page still sees the agent busy');
  running = false;
  ev('turn_start', { agent: 'alice', turnId: 'h3', origin: { kind: 'schedule' } });
  ev('turn_end', { agent: 'alice', turnId: 'h3', ok: true, reply: 'Done.' });
  assert.strictEqual(calls.bgDone, 1, 'released at its end when the page sees the agent idle');
  running = true;
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
    voiceDisp: { turnSeq: new Map() }, voiceDispMood() {}, ownTurnFor: () => false, isBusy: () => true, turnOrigins: {}, Date: { now: () => clock } }, over || {});
  const a = mob.indexOf('function voiceCallTurnStart(ev)'), b = mob.indexOf('// ── Room check (5 s)', a);
  assert.ok(a > 0 && b > a, 'hub event block of mobile.js found');
  const names = Object.keys(st);
  const f = new Function(...names, mob.slice(a, b) + '\nreturn { voiceCallTurnStart, voiceCallTurnDelta, voiceCallTurnActivity, voiceCallTurnEnd, voiceCallForOwner, voiceCallBackgroundBusy, voiceCallHubIdle, voiceCallSeedHub };')(...names.map(n => st[n]));
  return { f, vc, st, calls, setClock: (t) => { clock = t; } };
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
  assert.strictEqual(calls.bgDone, 0, 'the page still sees the agent busy: the idle hook releases the words later');
  busy = false;
  f.voiceCallHubIdle('bob');
  assert.strictEqual(calls.bgDone, 1, 'the kept words are released');
  busy = true;
  f.voiceCallTurnStart({ agent: 'bob', turnId: 'h2', origin: { kind: 'schedule' } });
  busy = false;
  f.voiceCallTurnEnd({ agent: 'bob', turnId: 'h2', ok: true, reply: 'Done.' });
  assert.strictEqual(calls.bgDone, 2, 'released at its end when the page sees the agent idle');
  busy = true;
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
    assert.ok(src.includes('keepWords: ('), name + ': dep keepWords');
    assert.ok(!src.includes('sendPlain'), name + ': nothing is sent at hang-up any more');
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
  h.call.onHeld({ id: 'job:1', kind: 'job_notice', label: 'Nightly job finished' }, false);
  await h.advance(2000);
  assert.deepStrictEqual(h.spoken, ['A background job finished. Now, or after we\'re done?']);
  assert.strictEqual(h.chimes, 0);
});

// ═══ review round 1 fixes ═══
// The code between two markers of a page source, run against stubs (a Proxy scope: names the test does not define are no-ops).
function scoped(src, from, to, base, exportsList) {
  const a = src.indexOf(from), b = src.indexOf(to, a);
  assert.ok(a >= 0 && b > a, 'found: ' + from);
  const scope = new Proxy(base, { has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)), get: (t, k) => (k in t ? t[k] : (typeof k === 'string' ? () => undefined : undefined)), set: (t, k, v) => { t[k] = v; return true; } });
  return new Function('scope', 'with (scope) { ' + src.slice(a, b) + '\nreturn { ' + exportsList + ' }; }')(scope);
}

// 1. words kept at hang-up: into the message box, never sent
test('desktop: kept words at hang-up go to the chat\'s input after what is typed there, with the toast; nothing is sent', () => {
  const toasts = [], sentTo = [];
  const input = { value: 'half typed ', dispatched: 0, dispatchEvent() { this.dispatched++; return true; } };
  const f = scoped(app, 'function voiceCallKeepWords(chatId, text, note) {', 'async function voiceCallInterject', {
    document: { getElementById: (id) => (id === 'input-c1' ? input : null) }, chats: { c1: { agent: 'alice' } }, hubToast: (t) => toasts.push(t),
    sendSoloMessage: (...a) => { sentTo.push(a); }, Event: class { constructor(t) { this.type = t; } } }, 'voiceCallKeepWords');
  f.voiceCallKeepWords('c1', 'first words more words');
  assert.strictEqual(input.value, 'half typed first words more words');
  assert.deepStrictEqual(toasts, ['What you said is in the message box.']);
  assert.deepStrictEqual(sentTo, [], 'no POST, no interjection');
  assert.ok(input.dispatched >= 1, 'the box is told it changed');
  input.value = '';
  f.voiceCallKeepWords('c1', 'alone');
  assert.strictEqual(input.value, 'alone', 'an empty box: no leading space');
  f.voiceCallKeepWords('gone', 'x');   // a closed chat: the words are shown in a toast (round 2), not lost silently
  assert.deepStrictEqual(toasts.length, 3);
  assert.strictEqual(toasts[2], 'What you said: x');
});

test('phone: kept words at hang-up go to the composer and its saved draft after what is there, with the toast; nothing is sent', () => {
  const toasts = [], drafts = {}, sent = [];
  const input = { value: 'typed', style: {}, scrollHeight: 30 };
  const base = { current: 'bob', $: (id) => (id === 'msg-input' ? input : null), draftsAll: () => ({ cat: { text: 'cat draft' } }), saveDraft: (a, t) => { drafts[a] = t; }, composerTypingPaint() {}, toast: (t) => toasts.push(t), sendMessage: (...a) => { sent.push(a); } };
  const f = scoped(mob, 'function voiceCallKeepWords(vc, text, note) {', '// A spoken correction while the agent works', base, 'voiceCallKeepWords');
  f.voiceCallKeepWords({ agent: 'bob' }, 'say this');
  assert.strictEqual(input.value, 'typed say this');
  assert.deepStrictEqual(drafts, { bob: 'typed say this' }, 'the saved draft: a reload keeps them');
  assert.deepStrictEqual(toasts, ['What you said is in the message box.']);
  assert.deepStrictEqual(sent, []);
  f.voiceCallKeepWords({ agent: 'cat' }, 'for the cat');   // another chat (bob's) is open: the call's agent's draft
  assert.strictEqual(input.value, 'typed say this', 'the open composer is not touched when it is another chat');
  assert.strictEqual(drafts.cat, 'cat draft for the cat');
});

test('controller: hanging up while the words are on their way and the hub refuses them puts them in the message box', async () => {
  let rejectSend;
  const h = await started({ keepWords: (t) => { h.plain.push(t); }, send: (t) => { h.sent.push(t); return new Promise((_, rej) => { rejectSend = rej; }); } });
  h.bg = true;
  await h.say('slow words');
  h.bg = false;
  const p = h.call.backgroundDone();
  await tick();
  await h.call.hangUp();
  rejectSend(new Error('409'));
  await p; await tick();
  assert.deepStrictEqual(h.plain, ['slow words']);
  assert.deepStrictEqual(h.interjected, []);
});

// 2. a hub turn that already runs when the call starts
test('desktop: a scheduled task already running when the call starts: speaking is kept, not interjected; its for_owner mark still gives the cue at its end', () => {
  const { f, S, st, calls } = deskEnv();
  st.busyRun.alice = { turnId: 's1', origin: { kind: 'schedule', label: 'Morning report' }, since: 1, own: false };
  assert.strictEqual(S.hub.size, 0, 'the call has not seen turn_start');
  f.voiceCallSeedHub();
  assert.deepStrictEqual([...S.hub.keys()], ['s1']);
  assert.strictEqual(f.voiceCallBackgroundBusy(), true, 'his words are kept');
  f.voiceCallHubEvent('for_owner', { agent: 'alice', reason: 'needs you', turnId: 's1', origin: { kind: 'schedule' } });
  assert.strictEqual(calls.owners, 0);
  f.voiceCallHubEvent('turn_end', { agent: 'alice', turnId: 's1', ok: true, reply: 'Done.' });
  assert.strictEqual(calls.owners, 1);
  assert.deepStrictEqual(calls.replies, []);
});

test('desktop: an own turn already running is not background; an agent busy with an unknown turn counts as background until identified', () => {
  const { f, S, st } = deskEnv();
  st.busyRun.alice = { turnId: 'u1', origin: { kind: 'user' }, since: 1, own: true };
  f.voiceCallSeedHub();
  assert.strictEqual(S.hub.size, 0);
  assert.strictEqual(f.voiceCallBackgroundBusy(), false, 'a turn of the person\'s own: interjection as today');
  delete st.busyRun.alice;
  assert.strictEqual(f.voiceCallBackgroundBusy(), true, 'busy, nobody has said whose turn it is');
  f.voiceCallHubEvent('turn_start', { agent: 'alice', turnId: 'u2', origin: { kind: 'user' } });
  assert.strictEqual(f.voiceCallBackgroundBusy(), false, 'identified as his own');
  const idle = deskEnv({ voiceCallRunning: () => false });
  idle.st.busyRun.alice = { turnId: 's1', origin: { kind: 'schedule' }, since: 1, own: false };
  idle.st.agentStatus.alice = { busy: false };
  idle.f.voiceCallSeedHub();
  assert.strictEqual(idle.S.hub.size, 0, 'a stale record of an agent that is idle is not a running turn');
});

test('phone: a scheduled task already running when the call starts: kept, not interjected; its for_owner mark still gives the cue', () => {
  const { f, vc, st, calls } = phoneEnv();
  st.turnOrigins.bob = { turnId: 's1', origin: { kind: 'schedule', label: 'Morning report' }, hub: true, since: 1 };
  assert.strictEqual(vc.hubTurns.size, 0);
  f.voiceCallSeedHub(vc);
  assert.deepStrictEqual([...vc.hubTurns.keys()], ['s1']);
  assert.strictEqual(f.voiceCallBackgroundBusy(vc), true);
  f.voiceCallForOwner({ agent: 'bob', reason: 'needs you', turnId: 's1', origin: { kind: 'schedule' } });
  f.voiceCallTurnEnd({ agent: 'bob', turnId: 's1', ok: true, reply: 'Done.' });
  assert.strictEqual(calls.owners, 1);
  assert.deepStrictEqual(calls.replies, []);
});

test('phone: an own turn already running is not background; a busy agent with no known turn counts as background', () => {
  const { f, vc, st } = phoneEnv();
  st.turnOrigins.bob = { turnId: 'u1', origin: { kind: 'user' }, hub: false, since: 1 };
  f.voiceCallSeedHub(vc);
  assert.strictEqual(vc.hubTurns.size, 0);
  assert.strictEqual(f.voiceCallBackgroundBusy(vc), false);
  delete st.turnOrigins.bob;
  assert.strictEqual(f.voiceCallBackgroundBusy(vc), true);
});

test('both pages seed the call from what they know when it starts and when the link comes back', () => {
  assert.ok(app.includes("voiceCallSeedHub();   // a hub-started turn that already runs"));
  assert.ok(/onBack: \(\) => \{[^}]*voiceCallSeedHub\(\); \}/.test(app));
  assert.ok(mob.includes("voiceCallSeedHub(vc);   // a hub-started turn that already runs"));
  assert.ok(/onBack: \(\) => \{[^}]*voiceCallSeedHub\(vc\); \}/.test(mob));
});

// 3. back-to-back hub turns; a refused send
test('desktop: back-to-back hub turns: the words wait for the second and are released once, at idle', () => {
  let running = true;
  const { f, calls } = deskEnv({ voiceCallRunning: () => running });
  const ev = f.voiceCallHubEvent;
  ev('turn_start', { agent: 'alice', turnId: 'h1', origin: { kind: 'schedule' } });
  ev('turn_end', { agent: 'alice', turnId: 'h1', ok: true, reply: 'Done.' });   // the agent still shows busy
  assert.strictEqual(calls.bgDone, 0);
  ev('turn_start', { agent: 'alice', turnId: 'h2', origin: { kind: 'consultation' } });
  assert.strictEqual(f.voiceCallBackgroundBusy(), true);
  ev('turn_end', { agent: 'alice', turnId: 'h2', ok: true, reply: 'Done.' });
  assert.strictEqual(calls.bgDone, 0, 'the second one ended too but the agent still shows busy');
  running = false;
  f.voiceCallHubIdle('alice');
  assert.strictEqual(calls.bgDone, 1, 'sent once, at idle');
  f.voiceCallHubIdle('alice');
  assert.strictEqual(calls.bgDone, 2, '(a second idle report asks again; the controller has nothing left to send then)');
});

test('phone: back-to-back hub turns: the words wait for the second and are released at idle', () => {
  let busy = true;
  const { f, calls } = phoneEnv({ isBusy: () => busy });
  f.voiceCallTurnStart({ agent: 'bob', turnId: 'h1', origin: { kind: 'schedule' } });
  f.voiceCallTurnEnd({ agent: 'bob', turnId: 'h1', ok: true, reply: 'Done.' });
  assert.strictEqual(calls.bgDone, 0);
  f.voiceCallTurnStart({ agent: 'bob', turnId: 'h2', origin: { kind: 'schedule' } });
  f.voiceCallTurnEnd({ agent: 'bob', turnId: 'h2', ok: true, reply: 'Done.' });
  assert.strictEqual(calls.bgDone, 0);
  busy = false;
  f.voiceCallHubIdle('bob');
  assert.strictEqual(calls.bgDone, 1);
});

test('controller: a send the hub refuses puts the words back at the front; nothing extra is said; the next idle sends them with what came after', async () => {
  let fail = true; const toasts = [];
  const h = await started({ send: async (t) => { h.sent.push(t); if (fail) throw Object.assign(new Error('409'), { refused: true }); h.running = true; }, ui: { state: (n) => h.states.push(n), heard() {}, held() {}, toast: (t) => toasts.push(t), summary() {} } });
  h.bg = true;
  await h.say('first');
  await h.finish();
  h.bg = false;
  await h.call.backgroundDone();
  assert.deepStrictEqual(h.sent, ['first']);
  assert.strictEqual(h.call.background, true, 'the words are kept again');
  assert.deepStrictEqual(h.spoken, [LINE], 'nothing extra said (no "That did not go through.")');
  assert.deepStrictEqual(toasts, []);
  h.bg = true;   // another hub turn
  await h.say('second');
  assert.deepStrictEqual(h.spoken, [LINE]);
  h.bg = false; fail = false;
  await h.call.backgroundDone();
  assert.deepStrictEqual(h.sent, ['first', 'first second'], 'the old words first');
  assert.strictEqual(h.call.background, false);
});

test('phone: the call\'s send is refused with a 409: the controller is told (the real sendMessage and voiceCallSend)', async () => {
  const toasts = [];
  let status = 409;
  const base = { current: 'bob', plusSheetShow() {}, toast: (t) => toasts.push(t), displayName: (n) => n, isBusy: () => false, ownTurnFor: () => false, streams: new Map(), reattaches: new Map(), live: {}, recentOwn: new Map(), pendingImages: [],
    api: async () => ({ status, ok: status < 400, json: async () => ({}) }), zoneHeader: () => ({}), voiceTakeDictated: () => false, newFeed: () => ({}), bubbleLive: () => false, readStream: async () => {},
    addUserBubble: () => ({ remove() {} }), addAssistantBubble: () => ({ el: { remove() {}, classList: { add() {} } }, body: {} }), setTimeout: () => 0,
    voiceCall: null, stick: false, tzSentAt: 0, voiceAutoReadGen: 0 };
  const f = scoped(mob, 'function voiceCallSend(vc, text, userEl) {', '// The words kept for the background work', Object.assign(base, {}), 'voiceCallSend');
  const g = scoped(mob, 'async function sendMessage(fallback) {', '// ── Re-attach after a lost connection', base, 'sendMessage');
  base.sendMessage = g.sendMessage;
  const vc = { agent: 'bob', sendSeq: 0, expecting: false, call: { onReplyText() {} }, lastText: '' };
  base.voiceCall = vc;
  await assert.rejects(f.voiceCallSend(vc, 'kept words'), /busy/, 'a 409 for a busy agent is a failure to the controller');
  assert.deepStrictEqual(toasts, [], 'no toast of the page: the controller decides what is said');
  status = 200;
  await f.voiceCallSend(vc, 'more words');   // taken: resolved without waiting for the reply
});

// 4. the 30 s re-check in every mode; a queued line dropped
test('backgroundCue "show" with a missed turn_end: the 30 s check finds the agent idle and sends', async () => {
  const h = await started(null, { backgroundCue: 'show' });
  h.bg = true;
  await h.say('words for later');
  assert.deepStrictEqual(h.sent, []);
  await h.advance(20000);
  h.bg = false; h.running = false;   // it ended; the page never told the call
  await h.advance(11000);
  assert.deepStrictEqual(h.sent, ['words for later']);
  assert.deepStrictEqual(h.spoken, [], 'nothing said in "show"');
  const o = await started(null, { backgroundCue: 'off' });
  o.bg = true;
  await o.say('off words');
  o.bg = false; o.running = false;
  await o.advance(31000);
  assert.deepStrictEqual(o.sent, ['off words'], '"off" re-checks too');
});

test('a background line still queued, not yet spoken, is dropped when the work is over', async () => {
  const h = await started();
  h.bg = true;
  await h.say('wait');
  await h.finish();                 // the first line is spoken
  await h.advance(30500);           // the repeat starts to be spoken (not finished)
  await h.advance(30000);           // another repeat is queued behind it
  assert.deepStrictEqual(h.spoken, [LINE, LINE]);
  h.bg = false;
  await h.call.backgroundDone();
  await h.finish();
  assert.deepStrictEqual(h.spoken, [LINE, LINE], 'the queued one is never spoken');
  assert.deepStrictEqual(h.sent, ['wait']);
});

// 5. the cue waits for the reply stream; an old cue is not given
test('a cue during a reply stream is not given between its sentences; it comes after the reply', async () => {
  const h = await started();
  await h.say('tell me');
  h.call.onReplyText('First sentence. Second sen', false);
  await tick();
  assert.deepStrictEqual(h.spoken, ['First sentence.']);
  await h.finish();                 // between two sentences: nothing queued, nothing playing
  h.call.onHubOwner(); await tick();
  assert.strictEqual(h.chimes, 0, 'not between the sentences of a reply');
  h.call.onReplyText('First sentence. Second sentence.', true);
  await tick();
  await h.finish();
  assert.deepStrictEqual(h.spoken, ['First sentence.', 'Second sentence.', CUE].slice(0, h.spoken.length));
  assert.strictEqual(h.spoken[h.spoken.length - 1], CUE, 'after the reply');
  assert.strictEqual(h.chimes, 1);
});

test('a pending cue expires after 10 s and is not given later', async () => {
  const h = await started();
  await h.say('question');          // a reply is awaited
  h.call.onHubOwner(); await tick();
  assert.strictEqual(h.chimes, 0);
  await h.advance(12000);
  h.call.onReplyText('Answer.', true);
  await tick(); await h.finish();
  assert.strictEqual(h.chimes, 0, 'too old: dropped');
  assert.ok(!h.spoken.includes(CUE));
  // a fresh one still works
  await h.advance(31000);
  h.call.onHubOwner(); await tick();
  assert.strictEqual(h.chimes, 1);
});

// 6. "stop" while only a hub-started turn runs
test('"stop" while only a hub-started turn runs (nothing kept, no own turn): says nothing and does not stop it', async () => {
  const h = await started();
  h.bg = true;
  await h.say('stop');
  assert.strictEqual(h.stops, 0, 'd.stop() is not called');
  assert.deepStrictEqual(h.spoken, [], 'nothing said, not even "Stopped."');
  assert.deepStrictEqual(h.sent, []);
  assert.deepStrictEqual(h.interjected, []);
  // with a turn of his own running, stop works as today
  const g = await started();
  await g.say('do a thing');
  await g.say('stop');
  assert.strictEqual(g.stops, 1);
});

// ═══ review round 2 fixes ═══
const MAY_NOT = 'That may not have gone through. It\'s in the message box.';
const DID_NOT = 'That did not go through. It\'s in the message box.';
const NOT_SURE = 'I couldn\'t confirm that went through. What you said is in the message box.';

// 1. an uncertain delivery is never retried
test('r2-1 controller: a network failure after the POST: no second send, the words in the message box with the toast text, the line once', async () => {
  const h = await started({ keepWords: (t, note) => { h.plain.push([t, note]); }, send: async (t) => { h.sent.push(t); throw new Error('network error'); } });
  h.bg = true;
  await h.say('please do it');
  await h.finish();
  h.bg = false;
  await h.call.backgroundDone();
  await h.advance(100);
  assert.deepStrictEqual(h.sent, ['please do it'], 'sent once');
  assert.deepStrictEqual(h.plain, [['please do it', NOT_SURE]]);
  assert.deepStrictEqual(h.spoken, [LINE, MAY_NOT], 'the line once');
  await h.finish();
  assert.strictEqual(h.call.background, false, 'nothing is waiting any more');
  await h.call.backgroundDone();
  h.bg = true; h.bg = false;
  await h.advance(61000);
  assert.deepStrictEqual(h.sent, ['please do it'], 'never retried, at the next idle or later');
  assert.deepStrictEqual(h.spoken, [LINE, MAY_NOT]);
});

test('r2-1 controller: a confirmed refusal (409) is put back and sent once at the next idle', async () => {
  let fail = true;
  const h = await started({ send: async (t) => { h.sent.push(t); if (fail) throw Object.assign(new Error('busy'), { refused: true }); h.running = true; } });
  h.bg = true;
  await h.say('again please');
  await h.finish();
  h.bg = false;
  await h.call.backgroundDone();
  assert.deepStrictEqual(h.sent, ['again please']);
  assert.strictEqual(h.call.background, true, 'back to wait');
  fail = false;
  await h.call.backgroundDone();
  assert.deepStrictEqual(h.sent, ['again please', 'again please'], 'sent once more, at the next idle');
  await h.call.backgroundDone();
  assert.strictEqual(h.sent.length, 2);
});

test('r2-1 pages: the call send rejects with refused: true for a 409 only, not for another non-2xx or a network failure (desktop source and phone sendMessage)', async () => {
  assert.ok(app.includes("notify(Object.assign(new Error('busy'), { refused: true }))"));
  assert.ok(!app.includes('`HTTP ${response.status}: ${response.statusText}`), { refused: true })'), 'r3: only a 409 is a refusal');
  assert.ok(mob.includes("notify(Object.assign(new Error('busy'), { refused: true }))"));
  let status = 409, boom = null;
  const base = { current: 'bob', plusSheetShow() {}, toast() {}, displayName: (n) => n, isBusy: () => false, ownTurnFor: () => false, streams: new Map(), reattaches: new Map(), live: {}, recentOwn: new Map(), pendingImages: [],
    api: async () => { if (boom) throw boom; return { status, ok: status < 400, json: async () => ({}) }; }, zoneHeader: () => ({}), voiceTakeDictated: () => false, newFeed: () => ({}), bubbleLive: () => false, readStream: async () => {}, enterReattach() {},
    addUserBubble: () => ({ remove() {} }), addAssistantBubble: () => ({ el: { remove() {}, classList: { add() {} } }, body: {} }), voiceCall: null, stick: false, tzSentAt: 0, voiceAutoReadGen: 0 };
  const g = scoped(mob, 'async function sendMessage(fallback) {', '// ── Re-attach after a lost connection', base, 'sendMessage');
  const errOf = async () => { let err = null; await g.sendMessage({ agent: 'bob', text: 'hi', userEl: null, noteEl: null, voice: true, onSendResult: (e) => { err = e; } }); return err; };
  assert.strictEqual((await errOf()).refused, true, '409');
  for (const s of [500, 502, 503, 504]) {   // r3: a 5xx may have been taken by the hub: uncertain, never a refusal
    status = s;
    const e5 = await errOf();
    assert.ok(e5 && e5.refused !== true, 'HTTP ' + s + ' is an uncertain delivery');
  }
  status = 200; boom = new TypeError('Failed to fetch');
  const net = await errOf();
  assert.ok(net && net.refused !== true, 'a network failure is uncertain');
});

// 2. the idle report comes before the hub turn's turn_end
test('r2-2 desktop: the real event order (idle first, then turn_end): a for_owner-marked hub turn gives the cue once', () => {
  let running = true;
  const { f, calls, S } = deskEnv({ voiceCallRunning: () => running });
  const ev = f.voiceCallHubEvent;
  ev('turn_start', { agent: 'alice', turnId: 'h1', origin: { kind: 'schedule' } });
  ev('for_owner', { agent: 'alice', reason: 'needs you', turnId: 'h1', origin: { kind: 'schedule' } });
  running = false;
  f.voiceCallHubIdle('alice');          // onHubTurnEnd -> setAgentLive -> idle hook runs first
  assert.strictEqual(calls.owners, 1, 'the cue at idle');
  ev('turn_end', { agent: 'alice', turnId: 'h1', ok: true, reply: 'Done.' });   // then its turn_end
  assert.strictEqual(calls.owners, 1, 'once');
  assert.strictEqual(S.owner.size, 0);
  // an unmarked turn: nothing at idle; marked just after, still within 5 s: the cue
  running = true;
  ev('turn_start', { agent: 'alice', turnId: 'h2', origin: { kind: 'schedule' } });
  running = false;
  f.voiceCallHubIdle('alice');
  ev('turn_end', { agent: 'alice', turnId: 'h2', ok: true, reply: 'Done.' });
  assert.strictEqual(calls.owners, 1);
  ev('for_owner', { agent: 'alice', reason: 'late', turnId: 'h2', origin: { kind: 'schedule' } });
  assert.strictEqual(calls.owners, 2, 'marked up to 5 s after it ended still works');
});

test('r2-2 phone: the real event order (idle first, then turn_end): a for_owner-marked hub turn gives the cue once', () => {
  let busy = true;
  const { f, calls, vc } = phoneEnv({ isBusy: () => busy });
  f.voiceCallTurnStart({ agent: 'bob', turnId: 'h1', origin: { kind: 'schedule' } });
  f.voiceCallForOwner({ agent: 'bob', reason: 'needs you', turnId: 'h1', origin: { kind: 'schedule' } });
  busy = false;
  f.voiceCallHubIdle('bob');            // onTurnEnd -> setLive -> idle hook runs first
  assert.strictEqual(calls.owners, 1, 'the cue at idle');
  f.voiceCallTurnEnd({ agent: 'bob', turnId: 'h1', ok: true, reply: 'Done.' });   // then voiceCallTurnEnd
  assert.strictEqual(calls.owners, 1, 'once');
  assert.strictEqual(vc.hubOwner.size, 0);
  busy = true;
  f.voiceCallTurnStart({ agent: 'bob', turnId: 'h2', origin: { kind: 'schedule' } });
  busy = false;
  f.voiceCallHubIdle('bob');
  f.voiceCallTurnEnd({ agent: 'bob', turnId: 'h2', ok: true, reply: 'Done.' });
  assert.strictEqual(calls.owners, 1);
  f.voiceCallForOwner({ agent: 'bob', reason: 'late', turnId: 'h2', origin: { kind: 'schedule' } });
  assert.strictEqual(calls.owners, 2, 'marked up to 5 s after it ended still works');
});

// 3. at most three confirmed refusals
test('r2-3 controller: the third confirmed refusal sends the words to the message box and says so once; nothing is retried', async () => {
  const h = await started({ ...{}, keepWords: (t, note) => { h.plain.push([t, note]); }, send: async (t) => { h.sent.push(t); throw Object.assign(new Error('busy'), { refused: true }); } });
  h.bg = true;
  await h.say('stubborn words');
  await h.finish();
  h.bg = false;
  await h.call.backgroundDone();
  assert.strictEqual(h.call.background, true, 'after the first: waiting');
  await h.call.backgroundDone();
  assert.strictEqual(h.call.background, true, 'after the second: waiting');
  assert.deepStrictEqual(h.plain, []);
  await h.call.backgroundDone();
  assert.deepStrictEqual(h.sent, ['stubborn words', 'stubborn words', 'stubborn words'], 'three tries in all');
  assert.deepStrictEqual(h.plain, [['stubborn words', undefined]], 'the page\'s own toast: "What you said is in the message box."');
  assert.deepStrictEqual(h.spoken, [LINE, DID_NOT]);
  assert.strictEqual(h.call.background, false);
  await h.call.backgroundDone();
  await h.advance(61000);
  assert.strictEqual(h.sent.length, 3);
  assert.deepStrictEqual(h.spoken, [LINE, DID_NOT]);
});

// 4. a rejected send: expecting is cleared at once, no 2.5 s release
function deskSendEnv(sendImpl) {
  const timers = [], replies = [], input = { value: 'half' };
  const S = { call: { onReplyText: (t, d) => replies.push([t, d]) }, sendSeq: 0, expecting: false, own: new Map(), hub: new Map(), owner: new Set(), hubEnded: new Map(), agent: 'alice', chatId: 'c1' };
  const base = { document: { getElementById: () => input }, chats: { c1: { agent: 'alice', status: 'idle' } }, voiceCallS: S, voiceDisplayHook() {}, sendSoloMessage: sendImpl, setTimeout: (fn, ms) => { timers.push([fn, ms]); return timers.length; }, voiceLinkNetFail() {} };
  const f = scoped(app, 'function voiceCallSend(chatId, text) {', '// The words kept for the background work', base, 'voiceCallSend');
  return { f, S, timers, replies, input };
}
test('r2-4 desktop: a rejected call send clears expecting at once and its 2.5 s release says nothing', async () => {
  const e = deskSendEnv((chatId, n, o) => { o.onSendResult(Object.assign(new Error('busy'), { refused: true })); return Promise.resolve(); });
  await assert.rejects(e.f.voiceCallSend('c1', 'words'), /busy/);
  await tick();
  assert.strictEqual(e.S.expecting, false, 'cleared at once: words spoken next are not taken for the reply of a send that never went out (they are kept as background, not interjected)');
  for (const [fn] of e.timers) fn();
  assert.deepStrictEqual(e.replies, [], 'no onReplyText(\'\', true) for the send that never went out');
  assert.strictEqual(e.input.value, 'half', 'the typed text stays');
  // an accepted send still releases
  const ok = deskSendEnv((chatId, n, o) => { o.onSendResult(null); return Promise.resolve(); });
  await ok.f.voiceCallSend('c1', 'words'); await tick();
  assert.strictEqual(ok.S.expecting, true);
  for (const [fn] of ok.timers) fn();
  assert.deepStrictEqual(ok.replies, [['', true]]);
});
test('r2-4 phone: a rejected call send clears expecting at once and its 2.5 s release says nothing', async () => {
  const timers = [], replies = [];
  const vc = { agent: 'bob', sendSeq: 0, expecting: false, lastText: '', call: { onReplyText: (t, d) => replies.push([t, d]) } };
  const base = { voiceCall: vc, stick: false, setTimeout: (fn) => { timers.push(fn); return timers.length; }, sendMessage: async (o) => { o.onSendResult(Object.assign(new Error('busy'), { refused: true })); } };
  const f = scoped(mob, 'function voiceCallSend(vc, text, userEl) {', '// The words kept for the background work', base, 'voiceCallSend');
  await assert.rejects(f.voiceCallSend(vc, 'words'), /busy/);
  await tick();
  assert.strictEqual(vc.expecting, false);
  for (const fn of timers) fn();
  assert.deepStrictEqual(replies, []);
  const vc2 = { agent: 'bob', sendSeq: 0, expecting: false, lastText: '', call: { onReplyText: (t, d) => replies.push([t, d]) } };
  base.voiceCall = vc2; base.sendMessage = async (o) => { o.onSendResult(null); };
  await f.voiceCallSend(vc2, 'words'); await tick();
  for (const fn of timers) fn();
  assert.deepStrictEqual(replies, [['', true]], 'an accepted send still releases');
});

// 5. a stale busy report right after his own turn ended
test('r2-5 desktop: his own turn ends, a stale busy report within 3 s, he speaks: a normal send, not kept as background; after 3 s it counts again', () => {
  const { f, setClock, S, st } = deskEnv({ busyRun: {} });
  setClock(1000);
  f.voiceCallHubEvent('turn_start', { agent: 'alice', turnId: 'u1', origin: { kind: 'user' } });
  f.voiceCallHubEvent('turn_end', { agent: 'alice', turnId: 'u1', ok: true, reply: 'ok' });
  setClock(2500);
  assert.strictEqual(f.voiceCallBackgroundBusy(), false, '1.5 s after: the status feed lags');
  setClock(4500);
  assert.strictEqual(f.voiceCallBackgroundBusy(), true, '3.5 s after, still busy with no known turn: background');
  const fresh = deskEnv({ busyRun: {} });
  assert.strictEqual(fresh.f.voiceCallBackgroundBusy(), true, 'no turn of his own ended: unchanged');
});
test('r2-5 phone: his own turn ends, a stale busy report within 3 s, he speaks: a normal send, not kept as background; after 3 s it counts again', () => {
  const { f, vc, setClock } = phoneEnv();
  setClock(1000);
  f.voiceCallTurnStart({ agent: 'bob', turnId: 'u1', origin: { kind: 'user' } });
  f.voiceCallTurnEnd({ agent: 'bob', turnId: 'u1', ok: true, reply: 'ok' });
  setClock(2500);
  assert.strictEqual(f.voiceCallBackgroundBusy(vc), false);
  setClock(4500);
  assert.strictEqual(f.voiceCallBackgroundBusy(vc), true);
  const fresh = phoneEnv();
  assert.strictEqual(fresh.f.voiceCallBackgroundBusy(fresh.vc), true);
});

// 6. desktop keepWords with the chat gone
test('r2-6 desktop: kept words with the chat or its input gone are shown in a toast, at most 200 characters; the note replaces the default toast', () => {
  const toasts = [];
  const input = { value: '', dispatchEvent() { return true; } };
  let chats = { c1: { agent: 'alice' } }, el = input;
  const f = scoped(app, 'function voiceCallKeepWords(chatId, text, note) {', 'async function voiceCallInterject', {
    document: { getElementById: () => el }, get chats() { return chats; }, hubToast: (t) => toasts.push(t), Event: class {} }, 'voiceCallKeepWords');
  el = null;
  f.voiceCallKeepWords('c1', 'x'.repeat(300));
  assert.deepStrictEqual(toasts, ['What you said: ' + 'x'.repeat(200)]);
  el = input; chats = {};
  f.voiceCallKeepWords('c1', 'my words');
  assert.strictEqual(toasts[1], 'What you said: my words');
  chats = { c1: {} };
  f.voiceCallKeepWords('c1', 'in the box', NOT_SURE);
  assert.strictEqual(input.value, 'in the box');
  assert.strictEqual(toasts[2], NOT_SURE);
});

// ═══ review round 3 fixes ═══
// The real desktop send path (sendSoloMessage), against stubs.
function deskRealSend(status, statusText) {
  const interjections = [], results = [];
  const input = { value: 'hello there', style: {}, placeholder: '' };
  const chats = { c1: { agent: 'alice', status: 'idle', messages: [], pendingImages: [] } };
  const base = { chats, agentStatus: {}, skipInterjectOnce: new Set(), pendingImages: [], tzSentAt: 0, sentAt: 0,
    document: { getElementById: (id) => (id === 'input-c1' ? input : null) },
    fetch: async () => ({ status, ok: status >= 200 && status < 300, statusText: statusText || '' }),
    setStatus: (id, s) => { chats[id].status = s; }, sendInterjection: async (id) => { interjections.push(id); }, enterReattach() {},
    zoneHeader: () => ({}), appendMessage: () => 'm1', appendMessageWithImages() {}, elapsedLabel: () => '' };
  const f = scoped(app, 'async function sendSoloMessage(chatId, retryCount = 0, sendOpts = null) {', 'async function streamResponseSolo(', base, 'sendSoloMessage');
  return { f, interjections, results, input, chats, call: () => f.sendSoloMessage('c1', 0, { voice: true, onSendResult: (e) => results.push(e) }), typed: () => f.sendSoloMessage('c1', 0, { onSendResult: (e) => results.push(e) }) };
}
test('r3-1 desktop (real send): a 409 to a call\'s own send rejects at once with refused: true and is not bounced into an interjection', async () => {
  const e = deskRealSend(409, 'Conflict');
  await e.call();
  assert.deepStrictEqual(e.interjections, [], 'no interjection');
  assert.strictEqual(e.results.length, 1);
  assert.strictEqual(e.results[0] && e.results[0].refused, true);
  assert.strictEqual(e.chats.c1.bounced409, false);
});
test('r3-1 desktop (real send): a typed message that gets a 409 is still bounced into an interjection once', async () => {
  const e = deskRealSend(409, 'Conflict');
  await e.typed();
  assert.deepStrictEqual(e.interjections, ['c1']);
  assert.deepStrictEqual(e.results, [null], 'delivered into the running turn');
});
for (const s of [500, 502, 503, 504]) {
  test('r3-2 desktop (real send): HTTP ' + s + ' to a call\'s send is an uncertain delivery: not refused, no resend', async () => {
    const e = deskRealSend(s, 'Bad');
    await e.call();
    assert.deepStrictEqual(e.interjections, []);
    assert.strictEqual(e.results.length, 1);
    assert.ok(e.results[0] instanceof Error && e.results[0].refused !== true, 'uncertain, not refused');
  });
}
test('r3-2 controller: an uncertain failure (a 502/503/504, not refused) is never resent; the words go to the message box with the note', async () => {
  for (const code of [502, 503, 504]) {
    const h = await started({ keepWords: (t, note) => { h.plain.push([t, note]); }, send: async (t) => { h.sent.push(t); throw new Error('HTTP ' + code); } });
    h.bg = true;
    await h.say('careful words');
    await h.finish();
    h.bg = false;
    await h.call.backgroundDone();
    await h.call.backgroundDone();
    await h.advance(61000);
    assert.deepStrictEqual(h.sent, ['careful words'], 'HTTP ' + code + ': sent once');
    assert.strictEqual(h.plain.length, 1, 'words in the box');
    assert.strictEqual(h.plain[0][0], 'careful words');
    assert.ok(h.plain[0][1], 'with the note that delivery is unconfirmed');
  }
});

// 3. a for_owner for a turn the call never saw
test('r3-3 desktop: for_owner for an unseen turn: idle gives the cue at once; busy keeps the mark until the turn ends or the agent goes idle', () => {
  let running = false;
  const { f, calls, S } = deskEnv({ voiceCallRunning: () => running });
  f.voiceCallHubEvent('for_owner', { agent: 'alice', reason: 'x', turnId: 'z1', origin: { kind: 'schedule' } });
  assert.strictEqual(calls.owners, 1, 'idle: the cue now');
  assert.strictEqual(S.owner.size, 0);
  running = true;
  f.voiceCallHubEvent('for_owner', { agent: 'alice', reason: 'x', turnId: 'z2', origin: { kind: 'schedule' } });
  assert.strictEqual(calls.owners, 1, 'busy: not yet');
  assert.ok(S.owner.has('z2'), 'the mark is kept');
  f.voiceCallHubEvent('turn_end', { agent: 'alice', turnId: 'z2', ok: true, reply: 'Done.' });
  assert.strictEqual(calls.owners, 2, 'the turn\'s end cues');
  assert.strictEqual(S.owner.size, 0);
  f.voiceCallHubEvent('for_owner', { agent: 'alice', reason: 'x', turnId: 'z3', origin: { kind: 'schedule' } });
  running = false;
  f.voiceCallHubIdle('alice');
  assert.strictEqual(calls.owners, 3, 'the idle hook cues');
  assert.strictEqual(S.owner.size, 0);
  f.voiceCallHubIdle('alice');
  assert.strictEqual(calls.owners, 3, 'once');
  // a turn the call did see is unchanged: marked while it runs, cue at its end
  running = true;
  f.voiceCallHubEvent('turn_start', { agent: 'alice', turnId: 'h1', origin: { kind: 'schedule' } });
  f.voiceCallHubEvent('for_owner', { agent: 'alice', reason: 'x', turnId: 'h1', origin: { kind: 'schedule' } });
  assert.strictEqual(calls.owners, 3);
  f.voiceCallHubEvent('turn_end', { agent: 'alice', turnId: 'h1', ok: true, reply: 'Done.' });
  assert.strictEqual(calls.owners, 4);
});
test('r3-3 phone: for_owner for an unseen turn: idle gives the cue at once; busy keeps the mark until the turn ends or the agent goes idle', () => {
  let busy = false;
  const { f, calls, vc } = phoneEnv({ isBusy: () => busy });
  f.voiceCallForOwner({ agent: 'bob', reason: 'x', turnId: 'z1', origin: { kind: 'schedule' } });
  assert.strictEqual(calls.owners, 1, 'idle: the cue now');
  assert.strictEqual(vc.hubOwner.size, 0);
  busy = true;
  f.voiceCallForOwner({ agent: 'bob', reason: 'x', turnId: 'z2', origin: { kind: 'schedule' } });
  assert.strictEqual(calls.owners, 1, 'busy: not yet');
  assert.ok(vc.hubOwner.has('z2'));
  f.voiceCallTurnEnd({ agent: 'bob', turnId: 'z2', ok: true, reply: 'Done.' });
  assert.strictEqual(calls.owners, 2, 'the turn\'s end cues');
  f.voiceCallForOwner({ agent: 'bob', reason: 'x', turnId: 'z3', origin: { kind: 'schedule' } });
  busy = false;
  f.voiceCallHubIdle('bob');
  assert.strictEqual(calls.owners, 3, 'the idle hook cues');
  assert.strictEqual(vc.hubOwner.size, 0);
  f.voiceCallHubIdle('bob');
  assert.strictEqual(calls.owners, 3, 'once');
  busy = true;
  f.voiceCallTurnStart({ agent: 'bob', turnId: 'h1', origin: { kind: 'schedule' } });
  f.voiceCallForOwner({ agent: 'bob', reason: 'x', turnId: 'h1', origin: { kind: 'schedule' } });
  assert.strictEqual(calls.owners, 3);
  f.voiceCallTurnEnd({ agent: 'bob', turnId: 'h1', ok: true, reply: 'Done.' });
  assert.strictEqual(calls.owners, 4);
});

// review r4 (Sonnet follow-up 1): the hub refuses his normal send as busy before the page has seen the background turn
test('r4-1 controller: a normal send the hub refuses as busy (409) keeps his words, says the background line, and sends them when the work is over', async () => {
  let n = 0;
  const h = await started({ keepWords: (t, note) => { h.plain.push([t, note]); }, send: async (t) => { h.sent.push(t); n++; if (n === 1) throw Object.assign(new Error('busy'), { refused: true }); } });
  h.bg = false;   // the page has not seen the hub-started turn yet
  await h.say('what is on today');
  await h.finish();
  assert.deepStrictEqual(h.sent, ['what is on today'], 'sent once, refused');
  assert.strictEqual(h.call.background, true, 'his words are kept, not dropped');
  assert.deepStrictEqual(h.spoken, [LINE], 'the background line, not "That did not go through."');
  await h.call.backgroundDone();
  assert.deepStrictEqual(h.sent, ['what is on today', 'what is on today'], 'sent again once the work is over');
  assert.deepStrictEqual(h.plain, []);
  assert.strictEqual(h.call.background, false);
});
test('r4-1 controller: a normal send that fails without a refusal still says "That did not go through." and keeps nothing', async () => {
  const h = await started({ keepWords: (t, note) => { h.plain.push([t, note]); }, send: async (t) => { h.sent.push(t); throw new Error('HTTP 500'); } });
  h.bg = false;
  await h.say('hello there');
  await h.finish();
  assert.deepStrictEqual(h.sent, ['hello there']);
  assert.strictEqual(h.call.background, false);
  assert.ok(h.spoken.includes('That did not go through.'), JSON.stringify(h.spoken));
});

// review r5: a send refused (or failing) after the caller hung up; the first refusal counts toward the cap
test('r5-1 controller: hung up while his send was in flight, then a 409: the words go to the message box, are not resent, nothing is said', async () => {
  let reject;
  const h = await started({ keepWords: (t, note) => { h.plain.push([t, note]); }, send: (t) => { h.sent.push(t); return new Promise((res, rej) => { reject = rej; }); } });
  h.bg = false;
  const said = h.say('call me back');
  await h.finish();
  h.call.hangUp();
  reject(Object.assign(new Error('busy'), { refused: true }));
  await said; await h.finish();
  assert.deepStrictEqual(h.sent, ['call me back'], 'sent once, never again');
  assert.deepStrictEqual(h.plain, [['call me back', undefined]], 'kept in the message box');
  assert.ok(!h.spoken.includes('That did not go through.'), JSON.stringify(h.spoken));
});
test('r5-2 controller: a refused first send counts toward the cap: two more refusals and the words go to the message box (three in all)', async () => {
  const h = await started({ keepWords: (t, note) => { h.plain.push([t, note]); }, send: async (t) => { h.sent.push(t); throw Object.assign(new Error('busy'), { refused: true }); } });
  h.bg = false;
  await h.say('try again later');
  await h.finish();
  await h.call.backgroundDone();
  assert.deepStrictEqual(h.plain, [], 'after two refusals: still waiting');
  await h.call.backgroundDone();
  assert.deepStrictEqual(h.sent, ['try again later', 'try again later', 'try again later'], 'three sends in all');
  assert.deepStrictEqual(h.plain, [['try again later', undefined]]);
});
