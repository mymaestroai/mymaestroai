'use strict';
// "Read it in full": when the person on a call asks to hear the details, the hub tells the page the reply must be read in full
// (voice_read_full chunk / turn_read_full event) and the call's onReadFull() switches the current reply to full mode:
// voiceReplySentences(markdown, done, readWords, true) and the controller. Fake clock, fake vad, fake speak; no network, no real data.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
Object.assign(globalThis, require('../lib/ui-voice'));
const { voiceCreateCall, voiceReplySentences, voiceReadFullGate } = require('../lib/ui-voice-call');

const tick = async (n = 6) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
function harness() {
  const h = { t: 0, timers: [], nextId: 1, log: [], spoken: [], pend: [], running: false, sent: [] };
  h.speak = (text) => new Promise((resolve) => { h.spoken.push(text); h.pend.push(resolve); });
  h.finish = async (ok = true) => { const r = h.pend.shift(); if (r) r(ok); await tick(); };
  h.drain = async () => { for (let i = 0; i < 60 && h.pend.length; i++) await h.finish(); };
  h.deps = {
    agent: 'a1', now: () => h.t, setTimer: (fn, ms) => { const id = h.nextId++; h.timers.push({ id, at: h.t + ms, fn }); return id; }, clearTimer: (id) => { h.timers = h.timers.filter(x => x.id !== id); },
    prefs: () => ({ micLevel: 50, interruptSensitivity: 50, continueWait: 0, detailsReadWords: 0 }),   // 0: short extra parts are never read on their own, so only full mode reads them
    vad: { start: async (hd) => { h.vadHandlers = hd; }, stop() {}, setPlaybackActive() {} },
    stt: async (audio) => audio.text, isTurnRunning: () => h.running,
    send: async (t) => { h.sent.push(t); h.running = true; }, interject: async () => {}, stop() {},
    speak: h.speak, cancelSpeech: () => { h.log.push('cancelSpeech'); const r = h.pend.shift(); if (r) r(false); },
    answerAsk() {},
    server: { start: async () => ({ callId: 'c1', held: [] }), heartbeat: async (c) => ({ callId: c, held: [] }), mode: async () => {}, end: async () => ({ held: [] }), decide: async () => {} },
    ui: {},
  };
  h.call = voiceCreateCall(h.deps);
  h.say = async (text) => { h.vadHandlers.onSpeechStart(); h.vadHandlers.onSpeechEnd({ text }); await tick(); };
  return h;
}
async function started() { const h = harness(); assert.strictEqual(await h.call.start(), true); return h; }

const LONG = 'Here are the steps. First, open the file. Second, change the name. Third, save it.\n\n'
  + '- Fourth, run the tests.\n- Fifth, read the output.\n- Sixth, fix what failed.\n- Seventh, commit the work.\n'
  + '\nThat is all of it.';
const NOTE = globalThis.VOICE_NOTE_DETAILS_CALL.trim();   // the call's generic details note: the long lead holds more than 3 sentences

// ---- voiceReplySentences ----

test('full mode reads every sentence of a long list reply, with no note', () => {
  const def = voiceReplySentences(LONG, true, 0);
  assert.strictEqual(def.sentences.length, 3);
  assert.ok(def.note, 'default: capped, with a note');
  const r = voiceReplySentences(LONG, true, 0, true);
  assert.strictEqual(r.note, '');
  assert.ok(r.sentences.length >= 8, JSON.stringify(r.sentences));
  assert.deepStrictEqual(r.sentences.slice(0, 3), def.sentences, 'the old lead is a prefix');
  const all = r.sentences.join(' ');
  for (const w of ['Fourth, run the tests', 'Seventh, commit the work', 'That is all of it']) assert.ok(all.includes(w), w);
});

test('full mode while streaming: only complete sentences, and each result is a prefix of the next', () => {
  let prev = [];
  for (let i = 1; i <= LONG.length; i += 3) {
    const r = voiceReplySentences(LONG.slice(0, i), false, 0, true);
    assert.strictEqual(r.note, '');
    assert.deepStrictEqual(r.sentences.slice(0, prev.length), prev, 'prefix at ' + i);
    prev = r.sentences;
  }
  const fin = voiceReplySentences(LONG, true, 0, true).sentences;
  assert.deepStrictEqual(fin.slice(0, prev.length), prev);
  assert.ok(!voiceReplySentences('One. Two. Three. Four. Fiv', false, 0, true).sentences.includes('Fiv'));
  assert.strictEqual(voiceReplySentences('One. Two. Three. Four. Five.', false, 0, true).sentences.length, 4, 'the open last sentence waits');
  assert.strictEqual(voiceReplySentences('One. Two. Three. Four. Five.', true, 0, true).sentences.length, 5);
});

test('full mode drops a table and a code block silently, with no note', () => {
  const md = 'Here it is.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nrun();\n```\n\nAnd then more words follow. Last one.';
  const r = voiceReplySentences(md, true, 0, true);
  assert.strictEqual(r.note, '');
  const all = r.sentences.join(' ');
  assert.ok(!/run\(\)|\b1\b|\ba b\b/.test(all), all);
  assert.ok(all.includes('Here it is') && all.includes('And then more words follow') && all.includes('Last one'), all);
  const noPipes = voiceReplySentences('Intro here.\n\nName | Value\n--- | ---\nx | y\n\nOutro here.', true, 0, true);
  assert.deepStrictEqual(noPipes.sentences, ['Intro here.', 'Outro here.']);
  assert.strictEqual(noPipes.note, '');
  const streaming = voiceReplySentences('Intro here.\n\nName | Val', false, 0, true);
  assert.deepStrictEqual(streaming.sentences, ['Intro here.'], 'a line that may be a table header is held');
});

test('without the 4th argument (or anything but true) the behaviour is unchanged', () => {
  for (const md of [LONG, 'One. Two. Three. Four.', 'Lead.\n| a |\n|--|\n| 1 |']) {
    for (const done of [false, true]) {
      const base = voiceReplySentences(md, done, 40);
      assert.deepStrictEqual(voiceReplySentences(md, done, 40, undefined), base);
      assert.deepStrictEqual(voiceReplySentences(md, done, 40, false), base);
      assert.deepStrictEqual(voiceReplySentences(md, done, 40, 'yes'), base);
    }
  }
  assert.deepStrictEqual(voiceReplySentences('One. Two. Three. Four.', true, 0), { sentences: ['One.', 'Two.', 'Three.'], note: NOTE });
});

// ---- the controller ----

test('onReadFull before the first text: the whole reply is read, no note', async () => {
  const h = await started();
  await h.say('tell me the details');
  h.call.onReadFull();
  h.call.onReplyText('Here are the steps.', false);
  h.call.onReplyText(LONG, true);
  await h.drain();
  const all = h.spoken.join(' ');
  assert.ok(all.includes('Seventh, commit the work') && all.includes('That is all of it'), all);
  assert.ok(!h.spoken.includes(NOTE), 'no note');
  assert.ok(h.spoken.length >= 8);
});

test('onReadFull mid-reply: sentences beyond the old cap are enqueued as they complete', async () => {
  const h = await started();
  await h.say('what are the steps');
  h.call.onReplyText('One is here. Two is here. Three is here.\n\n- Four is here.\n- Five is here.\n', false);
  await h.drain();
  assert.deepStrictEqual(h.spoken, ['One is here.', 'Two is here.', 'Three is here.']);
  h.call.onReadFull();
  await h.drain();
  assert.deepStrictEqual(h.spoken.slice(3), ['Four is here.', 'Five is here.'], 'what was held back is read now');
  h.call.onReplyText('One is here. Two is here. Three is here.\n\n- Four is here.\n- Five is here.\n- Six is here.\n- Sev', false);
  await h.drain();
  assert.strictEqual(h.spoken[5], 'Six is here.');
  assert.ok(!h.spoken.includes('Sev'));
  h.call.onReplyText('One is here. Two is here. Three is here.\n\n- Four is here.\n- Five is here.\n- Six is here.\n- Seven is here.', true);
  await h.drain();
  assert.strictEqual(h.spoken.length, 7);
  assert.strictEqual(h.spoken.filter(s => s === 'Seven is here.').length, 1);
  assert.ok(!h.spoken.some(s => /in the chat/.test(s)));
});

test('onReadFull after done with a note queued: the note is dropped and the rest is read', async () => {
  const h = await started();
  await h.say('list them');
  h.call.onReplyText(LONG, true);
  await tick();
  assert.strictEqual(h.spoken.length, 1, 'the first lead sentence plays, the rest waits in the queue with the note');
  h.call.onReadFull();
  await h.drain();
  const all = h.spoken.join(' ');
  assert.ok(!h.spoken.includes(NOTE), 'the queued note is gone: ' + all);
  assert.ok(all.includes('Seventh, commit the work') && all.includes('That is all of it'), all);
  assert.strictEqual(new Set(h.spoken).size, h.spoken.length, 'nothing read twice');
});

test('the flag is reset when the next turn begins', async () => {
  const h = await started();
  await h.say('details please');
  h.call.onReadFull();
  h.call.onReplyText(LONG, true);
  await h.drain();
  assert.ok(!h.spoken.includes(NOTE));
  h.running = false;
  const before = h.spoken.length;
  await h.say('and another question');
  h.call.onReplyText(LONG, true);
  await h.drain();
  const second = h.spoken.slice(before);
  assert.strictEqual(second.length, 4, 'three lead sentences and the note again: ' + JSON.stringify(second));
  assert.strictEqual(second[3], NOTE);
});

test('the flag is reset when an interjection begins a new reply', async () => {
  const h = await started();
  await h.say('details please');
  h.call.onReadFull();
  h.call.onReplyText('Short answer.', false);
  await h.drain();
  await h.say('and one more thing');   // the turn still runs: an interjection
  h.call.onReplyText('Short answer. ' + LONG, true);
  await h.drain();
  assert.ok(h.spoken.includes(NOTE), 'the interjected reply is capped again unless it is flagged: ' + JSON.stringify(h.spoken));
});

test('barge-in during a full reading cuts it at once and nothing more of that reply is read', async () => {
  const h = await started();
  await h.say('read me everything');
  h.call.onReadFull();
  h.call.onReplyText(LONG, false);
  await tick();
  assert.deepStrictEqual(h.spoken, ['Here are the steps.']);
  h.vadHandlers.onSpeechStart();   // the person talks over it
  await tick();
  assert.deepStrictEqual(h.log, ['cancelSpeech'], 'cut at once');
  h.call.onReplyText(LONG, true);   // the rest of the reply arrives while the person talks
  h.vadHandlers.onSpeechEnd({ text: 'stop there' });
  await tick(); await h.drain();
  assert.deepStrictEqual(h.spoken, ['Here are the steps.'], 'nothing more of the cut reply is read');
  assert.ok(!h.spoken.includes(NOTE));
});

test('onReadFull on a cut reply does not bring the reading back', async () => {
  const h = await started();
  await h.say('read me everything');
  h.call.onReplyText(LONG.slice(0, 40), false);
  await tick();
  h.vadHandlers.onSpeechStart();
  await tick();
  h.call.onReadFull();
  h.call.onReplyText(LONG, true);
  await tick(); await h.drain();
  assert.deepStrictEqual(h.spoken, ['Here are the steps.']);
});

test('resetReadFull clears the flag and touches nothing else', async () => {
  const h = await started();
  await h.say('details please');
  h.call.onReadFull();
  h.call.resetReadFull();
  h.call.onReplyText(LONG, true);
  await h.drain();
  assert.ok(h.spoken.includes(NOTE), 'capped again after the reset: ' + JSON.stringify(h.spoken));
  assert.strictEqual(h.spoken.length, 4);
  // a reading in progress is not cut, queued items stay, and a reset with no flag is harmless
  const g = await started();
  await g.say('read it all');
  g.call.onReadFull();
  g.call.onReplyText(LONG, false);
  await tick();
  assert.deepStrictEqual(g.spoken, ['Here are the steps.']);
  g.call.resetReadFull();
  await tick();
  assert.deepStrictEqual(g.log, [], 'no cancelSpeech');
  assert.strictEqual(g.pend.length, 1, 'the sentence being spoken plays on');
  const k = await started();
  assert.doesNotThrow(() => { k.call.resetReadFull(); k.call.resetReadFull(); });
  assert.strictEqual(typeof k.call.resetReadFull, 'function');
});

// ---- the one rule set both pages use: voiceReadFullGate ----

test('gate: the chat-stream chunk before the hub turn_start of the same turn keeps the flag', () => {
  let r = voiceReadFullGate(null, { kind: 'chunk', turnId: 'T2' });
  assert.strictEqual(r.action, 'set'); assert.deepStrictEqual(r.state, { set: true, turn: 'T2', own: null, past: [] });
  r = voiceReadFullGate(r.state, { kind: 'start', turnId: 'T2' });
  assert.strictEqual(r.action, 'ignore'); assert.strictEqual(r.state.set, true); assert.strictEqual(r.state.turn, 'T2'); assert.strictEqual(r.state.own, 'T2');
  r = voiceReadFullGate(r.state, { kind: 'event', turnId: 'T2' });
  assert.strictEqual(r.action, 'set');
});

test('gate: a typed turn after a details turn resets the flag', () => {
  let s = voiceReadFullGate(null, { kind: 'start', turnId: 'T1' }).state;
  s = voiceReadFullGate(s, { kind: 'event', turnId: 'T1' }).state;
  assert.strictEqual(s.set, true);
  const r = voiceReadFullGate(s, { kind: 'start', turnId: 'T2' });   // typed: no beginOwnTurn on the controller
  assert.strictEqual(r.action, 'reset'); assert.deepStrictEqual(r.state, { set: false, turn: null, own: 'T2', past: ['T1'] });
  assert.strictEqual(voiceReadFullGate(r.state, { kind: 'start', turnId: 'T3' }).action, 'ignore', 'nothing to clear');
});

test('gate: a late chat-stream chunk of an earlier turn never re-enables full reading (review r2)', () => {
  let s = voiceReadFullGate(null, { kind: 'start', turnId: 'A' }).state;
  s = voiceReadFullGate(s, { kind: 'chunk', turnId: 'A' }).state;        // A: a details reading
  let r = voiceReadFullGate(s, { kind: 'start', turnId: 'B' });           // B typed: reset
  assert.strictEqual(r.action, 'reset');
  r = voiceReadFullGate(r.state, { kind: 'chunk', turnId: 'A' });         // A's chunk arrives late
  assert.strictEqual(r.action, 'ignore'); assert.strictEqual(r.state.set, false);
  // a chunk for a turn not seen yet (it comes before its own turn_start) is still taken
  assert.strictEqual(voiceReadFullGate(r.state, { kind: 'chunk', turnId: 'C' }).action, 'set');
  // the same turn's turn_start again changes nothing; at most 32 earlier turns are kept
  assert.strictEqual(voiceReadFullGate(r.state, { kind: 'start', turnId: 'B' }).action, 'ignore');
  let t = r.state; for (let i = 0; i < 40; i++) t = voiceReadFullGate(t, { kind: 'start', turnId: 'X' + i }).state;
  assert.strictEqual(t.past.length, 32);
});

test('gate: signals repeat: a second details reading in the same turn (an answer to an interjection) sets again', () => {
  let s = voiceReadFullGate(null, { kind: 'start', turnId: 'T1' }).state;
  s = voiceReadFullGate(s, { kind: 'event', turnId: 'T1' }).state;
  assert.strictEqual(voiceReadFullGate(s, { kind: 'event', turnId: 'T1' }).action, 'set');
  assert.strictEqual(voiceReadFullGate(s, { kind: 'chunk', turnId: 'T1' }).action, 'set');
});

test('gate: a flag remembered with a null turn id is cleared by the next own turn', () => {
  let s = voiceReadFullGate(null, { kind: 'chunk', turnId: null }).state;
  assert.deepStrictEqual(s, { set: true, turn: null, own: null, past: [] });
  assert.strictEqual(voiceReadFullGate(s, { kind: 'start', turnId: 'T1' }).action, 'reset');
});

test('gate: a late turn_read_full for an older turn, or for no own turn, is ignored', () => {
  let s = voiceReadFullGate(null, { kind: 'start', turnId: 'T1' }).state;
  s = voiceReadFullGate(s, { kind: 'start', turnId: 'T2' }).state;
  for (const id of ['T1', 'T9', '', null, undefined]) {
    const r = voiceReadFullGate(s, { kind: 'event', turnId: id });
    assert.strictEqual(r.action, 'ignore', String(id)); assert.strictEqual(r.state.set, false);
  }
  assert.strictEqual(voiceReadFullGate(null, { kind: 'event', turnId: 'T1' }).action, 'ignore', 'no own turn seen yet');
  assert.strictEqual(voiceReadFullGate(s, { kind: 'event', turnId: 'T2' }).action, 'set');
});

test('gate: odd input never throws and the state is never mutated', () => {
  for (const [st, ev] of [[undefined, undefined], [null, null], ['x', {}], [{}, { kind: 'nope' }], [{ set: 1 }, { kind: 'start' }]]) {
    const r = voiceReadFullGate(st, ev);
    assert.strictEqual(r.action, 'ignore'); assert.strictEqual(r.state.set, false);
  }
  const s = Object.freeze({ set: true, turn: 'A', own: 'A' });
  voiceReadFullGate(s, { kind: 'start', turnId: 'B' });
  assert.deepStrictEqual(s, { set: true, turn: 'A', own: 'A' });
});

test('gate + controller: after a typed turn begins the flag is gone, so what is beyond the cap is held back again', async () => {
  const BASE = 'One is here. Two is here. Three is here.\n\n- Four is here.\n';
  const run = async (typedTurnStarts) => {
    const h = await started();
    await h.say('details please');
    let gate = voiceReadFullGate(null, { kind: 'start', turnId: 'T1' }).state;
    const apply = (ev) => { const r = voiceReadFullGate(gate, ev); gate = r.state; if (r.action === 'set') h.call.onReadFull(); else if (r.action === 'reset') h.call.resetReadFull(); };
    apply({ kind: 'event', turnId: 'T1' });
    h.call.onReplyText(BASE, false);
    await h.drain();
    assert.ok(h.spoken.includes('Four is here.'), 'flagged: read beyond the cap ' + JSON.stringify(h.spoken));
    if (typedTurnStarts) apply({ kind: 'start', turnId: 'T2' });   // the person typed: a new own turn; the controller never saw beginOwnTurn
    h.call.onReplyText(BASE + '- Five is here.\n- Six is here.\n', false);
    await h.drain();
    apply({ kind: 'event', turnId: 'T1' });   // a late event for the older turn changes nothing
    return { spoken: h.spoken, gate };
  };
  const kept = await run(false);
  assert.ok(kept.spoken.includes('Five is here.'), 'control: the flag still reads on');
  const reset = await run(true);
  assert.ok(!reset.spoken.includes('Five is here.') && !reset.spoken.includes('Six is here.'), 'the reset reply is capped: ' + JSON.stringify(reset.spoken));
  assert.strictEqual(reset.gate.set, false);
});

// ---- the pages ----

test('the pages wire voice_read_full and turn_read_full through the same gate', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const mob = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
  assert.ok(/voiceCallSseReadFull\(chatId, oc2\.turnId\)/.test(app) && /addEventListener\('turn_read_full'/.test(app) && /case 'turn_read_full': \{/.test(app));
  assert.ok(/voiceCallSseReadFull\(rec, g\.turnId\)/.test(mob) && /on\('turn_read_full'/.test(mob) && /ev\.agent !== vc\.agent \|\| !vc\.callTurns\.has\(ev\.turnId\)/.test(mob.slice(mob.indexOf('function voiceCallTurnReadFull'))));
  for (const [name, src] of [['app', app], ['mobile', mob]]) {
    assert.ok(/onReadFull/.test(src), name);
    for (const kind of ['chunk', 'event', 'start']) assert.ok(new RegExp("voiceReadFullGate\\([^\\n]*kind: '" + kind + "'").test(src), name + ' ' + kind);
    assert.ok(/typeof (?:call|vc\.call)\.resetReadFull === 'function'/.test(src), name + ' guards resetReadFull');
    assert.ok(/function voiceReadFullGate\(/.test(src) && /function resetReadFull\(\) \{ readFull = false; \}/.test(src), name);
  }
});
