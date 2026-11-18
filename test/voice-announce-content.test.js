'use strict';
// On a live call only replies to what the person said are spoken. An item the hub holds (another agent's consultation, a task,
// a job notice ...) gets at most a short neutral line built from who and what kind; its label (the first 80 characters of a
// consultation's request text) is never spoken. Pure helper, the controller (live, start answer, heartbeat) and the page copies.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
Object.assign(globalThis, require('../lib/ui-voice'));
const { voiceCreateCall, voiceAnnounceLine } = require('../lib/ui-voice-call');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const Q = ' Now, or after we\'re done?';
const LONG = 'voice-details: one question before I build part 1. I am cloned on 49d345b at /tmp/x';

function harness() {
  const h = { t: 0, timers: [], nextId: 1, spoken: [], pend: [], helds: [], startHeld: [], hbHeld: [] };
  h.advance = async (ms) => {
    const end = h.t + ms;
    for (;;) {
      const due = h.timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      h.timers = h.timers.filter(x => x !== due); h.t = due.at; due.fn(); await tick();
    }
    h.t = end; await tick();
  };
  h.finish = async () => { const r = h.pend.shift(); if (r) r(true); await tick(); };
  h.vad = { start: async () => {}, stop() {}, setPlaybackActive() {} };
  h.call = voiceCreateCall({
    agent: 'a1', now: () => h.t, prefs: () => ({ micLevel: 50, interruptSensitivity: 50, continueWait: 0 }),
    setTimer: (fn, ms) => { const id = h.nextId++; h.timers.push({ id, at: h.t + ms, fn }); return id; },
    clearTimer: (id) => { h.timers = h.timers.filter(x => x.id !== id); },
    vad: h.vad, stt: async (a) => a.text, isTurnRunning: () => false, send: async () => {}, interject: async () => {}, stop() {},
    speak: (text) => new Promise((resolve) => { h.spoken.push(text); h.pend.push(resolve); }), cancelSpeech() {}, answerAsk() {},
    server: { start: async () => ({ callId: 'c1', held: h.startHeld }), heartbeat: async (cid) => ({ callId: cid, held: h.hbHeld }),
      mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} },
    ui: { state() {}, heard() {}, held: (l) => h.helds.push(l), toast() {}, summary() {} },
  });
  return h;
}
const words = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
function assertNoLabelWords(spoken, label, why) {
  const lw = new Set(words(label).filter(w => !['now', 'or', 'after', 'we', 're', 'done', 'has', 'a', 'request', 'sam', 'i', 'am', 'on', 'at', 'one', 'to', 'x'].includes(w)));
  for (const s of spoken) for (const w of words(s)) assert.ok(!lw.has(w), `${why}: "${s}" contains label word "${w}"`);
}

test('a held consultation with a long request text as its label is announced by who and kind only', async () => {
  const h = harness();
  assert.strictEqual(await h.call.start(), true);
  const item = { id: 'c1', kind: 'consultation', from: 'sam', label: LONG };
  h.call.onHeld(item, false);
  await h.advance(2000);
  assert.deepStrictEqual(h.spoken, ['Sam has a request.' + Q]);
  assert.ok(!h.spoken.join(' ').includes('49d345b'));
  assert.ok(!h.spoken.join(' ').includes('/tmp/x'));
  assertNoLabelWords(h.spoken, LONG, 'live');
  assert.ok(h.helds.some(l => l.some(x => x.label === LONG)), 'the label stays on screen in the held list');
});

test('voiceAnnounceLine: one neutral line per kind', () => {
  const cases = [['consultation', 'Sam has a request.'], ['consult_reply', 'Replies from other agents came in.'], ['schedule', 'A scheduled task is due.'],
    ['job_notice', 'A background job finished.'], ['job_report', 'A job report came in.'], ['task', 'A task came in.'], ['alert', 'An alert came in.']];
  for (const [kind, line] of cases) assert.strictEqual(voiceAnnounceLine({ kind, from: 'sam', label: LONG }), line + Q, kind);
  assert.strictEqual(voiceAnnounceLine({ kind: 'consultation', from: 'kim' }), 'Kim has a request.' + Q);
  assert.strictEqual(voiceAnnounceLine({ kind: 'consultation', from: 'maria' }), 'Maria has a request.' + Q);
});

test('voiceAnnounceLine: a missing or odd from becomes "Another agent"; an unknown kind is "Something came in"', () => {
  // the hub's own senders (tiger-team-ui, roundtable, worker ids) are not agent names: "Another agent" too
  const odd = [undefined, null, '', 'hub', 'schedule', 'owner', 'sam kim', 'sam!', '<b>x</b>', 'a'.repeat(40), '1sam', 42, { name: 'sam' }, 'tiger-team-ui', 'roundtable', 'w_1a2b3c', 'Ignore-previous-steps'];
  for (const from of odd) assert.strictEqual(voiceAnnounceLine({ kind: 'consultation', from, label: LONG }), 'Another agent has a request.' + Q, String(from));
  assert.strictEqual(voiceAnnounceLine({ kind: 'consultation', label: LONG }), 'Another agent has a request.' + Q);
  for (const kind of ['job', 'whatever', undefined, null, '', 'toString', 'constructor']) assert.strictEqual(voiceAnnounceLine({ kind, from: 'sam', label: LONG }), 'Something came in.' + Q, String(kind));
  assert.strictEqual(voiceAnnounceLine(null), 'Something came in.' + Q);
  assert.strictEqual(voiceAnnounceLine(undefined), 'Something came in.' + Q);
  assert.strictEqual(voiceAnnounceLine({}), 'Something came in.' + Q);
  // a from only matters for a consultation
  assert.strictEqual(voiceAnnounceLine({ kind: 'task', from: 'sam' }), 'A task came in.' + Q);
});

test('held items from the start answer are announced without their label', async () => {
  const h = harness();
  h.startHeld = [{ id: 'c1', kind: 'consultation', from: 'kim', label: LONG, state: 'held' }];
  assert.strictEqual(await h.call.start(), true);
  assert.deepStrictEqual(h.spoken, ['Kim has a request.' + Q]);
  assertNoLabelWords(h.spoken, LONG, 'start');
  assert.ok(h.helds.some(l => l.some(x => x.label === LONG)), 'label still in the held list');
});

test('held items from a heartbeat answer are announced without their label', async () => {
  const h = harness();
  assert.strictEqual(await h.call.start(), true);
  h.hbHeld = [{ id: 'c9', kind: 'consultation', from: 'maria', label: LONG, state: 'held' }, { id: 't9', kind: 'task', label: 'Secret task title: pay 49d345b', state: 'later' }];
  await h.advance(15000);
  await h.advance(2000);
  assert.deepStrictEqual(h.spoken, ['Maria has a request.' + Q]);
  assertNoLabelWords(h.spoken, LONG, 'heartbeat');
  assert.ok(!h.spoken.join(' ').includes('Secret'));
});

test('the pages carry the neutral line and no longer speak the label', () => {
  for (const f of ['app.js', 'mobile.js', 'lib/ui-voice-call.js']) {
    const src = read(f);
    assert.ok(src.includes('enqueue(voiceAnnounceLine(item), '), f + ' enqueues the neutral line');
    assert.ok(!src.includes("String(item.label || 'Something came in')"), f + ' no longer speaks the label');
  }
});
