'use strict';
// Read details aloud on a call: the per-person reminder preference, the [details] tag, the instruction note, the
// voice_interrupt_reminder tool and the turn_read_full event. No network; sdk-chat is read as text, never required.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createVoicePersonPrefs, handleInterruptReminderTool, NOT_ON_CALL, MAX_PEOPLE } = require('../lib/voice-person-prefs');
const { createMoodFilter, createReadTagFilter, READ_TAG, FACE_MOOD_NOTE } = require('../lib/voice/mood');
const { createHubEvents } = require('../lib/hub-events');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vpp-')), 'voice-person-prefs.json');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');

// ── the store ──
test('store: default on, set off and on, persists across instances', () => {
  const f = tmpFile();
  const a = createVoicePersonPrefs({ file: f });
  assert.equal(a.interruptReminder('sam'), true);
  assert.equal(a.setInterruptReminder('sam', false), false);
  assert.equal(a.interruptReminder('sam'), false);
  assert.equal(a.interruptReminder('owner'), true, 'another person is unaffected');
  assert.equal(createVoicePersonPrefs({ file: f }).interruptReminder('sam'), false);
  assert.equal(a.setInterruptReminder('sam', true), true);
  assert.equal(createVoicePersonPrefs({ file: f }).interruptReminder('sam'), true);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

test('store: the key owner works; bad input is refused with bad_request', () => {
  const s = createVoicePersonPrefs({ file: tmpFile() });
  assert.equal(s.setInterruptReminder('owner', false), false);
  assert.equal(s.interruptReminder('owner'), false);
  for (const k of ['', 'x'.repeat(65), 5, null, undefined, {}]) assert.throws(() => s.setInterruptReminder(k, true), (e) => e.code === 'bad_request', String(k));
  for (const v of ['false', 0, 1, null, undefined, 'on']) assert.throws(() => s.setInterruptReminder('sam', v), (e) => e.code === 'bad_request', String(v));
  assert.equal(s.interruptReminder('sam'), true);
  assert.equal(s.interruptReminder(undefined), true);
});

test('store: a corrupt or odd file reads as on; the cap on people holds', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{not json');
  const s = createVoicePersonPrefs({ file: f });
  assert.equal(s.interruptReminder('sam'), true);
  assert.equal(s.setInterruptReminder('sam', false), false, 'a write over a corrupt file works');
  const g = tmpFile();
  fs.writeFileSync(g, JSON.stringify({ people: { a: { interruptReminder: 'no' }, b: 5, c: { interruptReminder: false } } }));
  const t = createVoicePersonPrefs({ file: g });
  assert.equal(t.interruptReminder('a'), true);
  assert.equal(t.interruptReminder('b'), true);
  assert.equal(t.interruptReminder('c'), false);
  const people = {};
  for (let i = 0; i < MAX_PEOPLE; i++) people['p' + i] = { interruptReminder: false };
  const h = tmpFile();
  fs.writeFileSync(h, JSON.stringify({ people }));
  const u = createVoicePersonPrefs({ file: h });
  assert.throws(() => u.setInterruptReminder('extra', false), (e) => e.code === 'bad_request');
  assert.equal(u.setInterruptReminder('p1', true), true, 'someone already kept can still change');
  assert.throws(() => createVoicePersonPrefs({}), /needs a file/);
});

// ── the filter ──
function run(chunks, opts = {}) {
  const moods = []; const tags = [];
  const f = createMoodFilter({ enabled: true, onMood: (m) => moods.push(m), onTag: (t) => tags.push(t), ...opts });
  let out = '';
  for (const c of chunks) out += f.push(c);
  out += f.finish();
  return { out, moods, tags };
}

test('filter: [details] is stripped and onTag is called once, across chunks too', () => {
  assert.equal(READ_TAG, 'details');
  let r = run(['[details] Remember, you can interrupt me any time.']);
  assert.equal(r.out, 'Remember, you can interrupt me any time.');
  assert.deepEqual(r.tags, ['details']); assert.deepEqual(r.moods, []);
  r = run(['  [Det', 'ails]', '\n', 'First, one.']);
  assert.equal(r.out, 'First, one.'); assert.deepEqual(r.tags, ['details']);
  r = run(['[details]']);
  assert.equal(r.out, ''); assert.deepEqual(r.tags, ['details']);
  r = run(['[details] a [details] b']);
  assert.equal(r.out, 'a [details] b'); assert.equal(r.tags.length, 1);
});

test('filter: moods still work and never call onTag', () => {
  const r = run(['[delighted] Hello there']);
  assert.equal(r.out, 'Hello there'); assert.deepEqual(r.moods, ['delighted']); assert.deepEqual(r.tags, []);
  assert.deepEqual(run(['[Proud]ok']).moods, ['proud']);
});

test('filter: link forms and other words are ordinary text; one leading tag only', () => {
  for (const t of ['[details](http://x.test) after', '[Details]: http://x.test', '[details][ref] x', '[detail] x', '[detailsx] x', 'See [details] here']) {
    const r = run([t]);
    assert.equal(r.out, t, t); assert.deepEqual(r.tags, [], t); assert.deepEqual(r.moods, [], t);
  }
  let r = run(['[details] [delighted] hi']);
  assert.equal(r.out, '[delighted] hi'); assert.deepEqual(r.tags, ['details']); assert.deepEqual(r.moods, []);
  r = run(['[delighted] [details] hi']);
  assert.equal(r.out, '[details] hi'); assert.deepEqual(r.moods, ['delighted']); assert.deepEqual(r.tags, []);
});

test('filter: a throwing onTag does not break speech; no onTag is fine; disabled passes through', () => {
  assert.equal(run(['[details] hi'], { onTag: () => { throw new Error('x'); } }).out, 'hi');
  const f = createMoodFilter({ enabled: true }); assert.equal(f.push('[details] hi'), 'hi');
  const d = createMoodFilter({ enabled: false, onTag: () => assert.fail('no') }); assert.equal(d.push('[details] hi'), '[details] hi');
});

// ── the instructions (vm-extracted from the source text) ──
function sdkNotes() {
  const line = (start) => { const i = SRC.indexOf(start); assert.ok(i >= 0, start); return SRC.slice(i, SRC.indexOf('\n', i)); };
  const grab = (start) => { const i = SRC.indexOf(start); assert.ok(i >= 0, start); let d = 0; let j = SRC.indexOf(') {', i) + 2; for (; j < SRC.length; j++) { if (SRC[j] === '{') d++; else if (SRC[j] === '}') { d--; if (!d) break; } } return SRC.slice(i, j + 1); };
  const ctx = { FACE_MOOD_NOTE };
  vm.createContext(ctx);
  vm.runInContext([line('const VOICE_NOTE ='), line('const VOICE_CALL_NOTE ='), line('const VOICE_READ_NOTE ='), line('const VOICE_READ_REMIND ='), line('const VOICE_READ_NO_REMIND ='), line('const VOICE_READ_TOOL ='),
    grab('function voiceReadNote('), grab('function voiceNoteFor('), grab('function voiceTurnCtx('),
    'this.voiceReadNote = voiceReadNote; this.voiceNoteFor = voiceNoteFor; this.voiceTurnCtx = voiceTurnCtx; this.VOICE_NOTE = VOICE_NOTE; this.VOICE_CALL_NOTE = VOICE_CALL_NOTE;'].join('\n'), ctx);
  return ctx;
}

test('voiceReadNote wording: tag, spoken style, reminder on or off, the tool', () => {
  const { voiceReadNote } = sdkNotes();
  const on = voiceReadNote(true); const off = voiceReadNote(false);
  for (const n of [on, off]) {
    assert.match(n, /\[details\]/); assert.match(n, /in full as natural speech/); assert.match(n, /no mood word/);
    assert.match(n, /voice_interrupt_reminder tool with on false or true/);
  }
  assert.match(on, /Start with the sentence: Remember, you can interrupt me any time\./);
  assert.doesNotMatch(off, /Start with the sentence/);
  assert.match(off, /asked not to be reminded.*leave that out/);
  assert.doesNotMatch(on, /leave that out/);
});

test('voiceNoteFor adds the read note only when moodStrip is true', () => {
  const { voiceNoteFor, VOICE_NOTE, VOICE_CALL_NOTE } = sdkNotes();
  assert.equal(voiceNoteFor({ voice: true }, false), VOICE_NOTE, 'a voice turn without a live call keeps the old note');
  assert.equal(voiceNoteFor({ voice: true, moodStrip: false }, false), VOICE_NOTE);
  assert.equal(voiceNoteFor({ voice: true, faceMood: true }, false), VOICE_NOTE + '\n\n' + FACE_MOOD_NOTE);
  const on = voiceNoteFor({ voice: true, moodStrip: true, interruptReminder: true }, false);
  assert.ok(on.startsWith(VOICE_CALL_NOTE) && /\[details\]/.test(on) && /Start with the sentence/.test(on));
  // on a live call real detail goes in the chat below the spoken answer, and the agent does not announce it itself
  assert.match(VOICE_CALL_NOTE, /give the spoken answer first in one to three sentences, then put the details below it/);
  assert.match(VOICE_CALL_NOTE, /tells the person the details are in the chat and that they can ask to hear them, so do not say that yourself/);
  assert.doesNotMatch(VOICE_CALL_NOTE, /offer to put it in the chat after the call/);
  assert.match(VOICE_NOTE, /offer to put it in the chat after the call; do not write it during the call/, 'unchanged off a call');
  assert.doesNotMatch(voiceNoteFor({ voice: true, moodStrip: true, interruptReminder: false }, false), /Start with the sentence/);
  assert.match(voiceNoteFor({ voice: true, moodStrip: true }, false), /Start with the sentence/, 'default on');
  assert.match(voiceNoteFor({ voice: true, moodStrip: true, faceMood: true }, false), /Optionally, begin your reply[\s\S]*\[details\]/);
  assert.equal(voiceNoteFor({ voice: true, moodStrip: true }, true), '', 'ephemeral');
  assert.equal(voiceNoteFor({ moodStrip: true }, false), '', 'not voice');
});

test('voiceTurnCtx takes the person from the hub options only', () => {
  const { voiceTurnCtx } = sdkNotes();
  const c = voiceTurnCtx({ moodStrip: true, voicePersonKey: '7', origin: { kind: 'user' } }, { consultationDepth: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(c)), { moodStrip: true, personKey: '7', ephemeral: false, consultedBy: null, depth: 0, tigerTeam: false, originKind: 'user' });
  assert.equal(voiceTurnCtx({ moodStrip: 'true' }, {}).moodStrip, false);
});

test('voiceTurnCtx: a call turn keeps originKind user; a turn with no origin is not one and the tool refuses it', () => {
  const { voiceTurnCtx } = sdkNotes();
  const s = createVoicePersonPrefs({ file: tmpFile() });
  const call = voiceTurnCtx({ moodStrip: true, voicePersonKey: 'sam', origin: { kind: 'user' } }, {});
  assert.equal(call.originKind, 'user');
  assert.match(handleInterruptReminderTool({ on: false, turn: call }, s), /^Done: I will no longer remind them/, 'a real call turn works');
  for (const options of [{ moodStrip: true, voicePersonKey: 'sam' }, { moodStrip: true, voicePersonKey: 'sam', origin: null }, { moodStrip: true, voicePersonKey: 'sam', origin: {} }, undefined]) {
    const c = voiceTurnCtx(options, {});
    assert.equal(c.originKind, '', 'no origin: not user');
    assert.equal(handleInterruptReminderTool({ on: true, turn: { ...c, moodStrip: true, personKey: 'sam' } }, s), NOT_ON_CALL);
  }
  assert.equal(voiceTurnCtx({ origin: { kind: 'schedule' } }, {}).originKind, 'schedule');
  // handleChatStreamReserved hands the turn's origin (always set: the owner at a browser is { kind: 'user' }) to all three routes
  assert.equal((SRC.match(/\n      origin: turnOrigin,\n      voice: !!voice,\n/g) || []).length, 3, 'Codex, Claude client, gateway');
  assert.match(SRC, /: consulted_by \? \{ kind: 'consultation', from: consulted_by \} : \{ kind: 'user' \};/);
});

// ── the [details] tag anywhere in a reply ──
function runAny(chunks, opts = {}) {
  const tags = [];
  const f = createReadTagFilter({ enabled: true, onTag: (t) => tags.push(t), ...opts });
  let out = '';
  for (const c of chunks) out += f.push(c);
  out += f.finish();
  return { out, tags };
}
// Every split into two chunks, and every split into three chunks, gives the same output and the same number of tags.
function everySplit(text, expectOut, expectTags) {
  const n = text.length;
  const check = (chunks, label) => { const r = runAny(chunks); assert.equal(r.out, expectOut, label + ' ' + JSON.stringify(chunks)); assert.equal(r.tags.length, expectTags, label + ' tags ' + JSON.stringify(chunks)); };
  check([text], 'whole');
  for (let i = 0; i <= n; i++) check([text.slice(0, i), text.slice(i)], 'two');
  for (let i = 0; i <= n; i++) for (let j = i; j <= n; j++) check([text.slice(0, i), text.slice(i, j), text.slice(j)], 'three');
  const ch = runAny([...text]); assert.equal(ch.out, expectOut, 'char by char'); assert.equal(ch.tags.length, expectTags);
}

test('anyplace filter: [details] mid-reply is removed with the whitespace after it; onTag per tag', () => {
  everySplit('[details] Remember, you can interrupt me any time.', 'Remember, you can interrupt me any time.', 1);
  everySplit('Sure.\n\n[details] Remember, you can interrupt me.', 'Sure.\n\nRemember, you can interrupt me.', 1);
  everySplit('Sure. [DETAILS]\n\n  First, one. [Details]Second.', 'Sure. First, one. Second.', 2);
  everySplit('Done [details]', 'Done ', 1);
  everySplit('x[details]y', 'xy', 1);
  everySplit('[details]', '', 1);
});

test('anyplace filter: links and other bracket text are kept exactly, at every split', () => {
  for (const t of ['See [details](http://x.test) now', 'See [Details][ref] now', '[details]: http://x.test', 'a [details]( b', 'a [details][', 'a [details]:',
    '[detailsX] x', '[detail] x', '[details x] y', '[ details] z', '[detail', 'tail [', 'tail [detai', '[[details]]x', 'wiki [[details]] page', '[details', 'arr[0] and [1]', '[summary] text']) {
    everySplit(t, t, 0);   // the tag inside double brackets is ordinary text too
  }
  // the decision is the one character after "]", also when it arrives alone in the next chunk
  assert.deepEqual(runAny(['a [details]', '(http://x.test)']), { out: 'a [details](http://x.test)', tags: [] });
  assert.deepEqual(runAny(['a [details]', ' next']), { out: 'a next', tags: ['details'] });
  // a link and a real tag in one reply
  everySplit('[details](u) then [details] go', '[details](u) then go', 1);
});

test('anyplace filter: holds at most 9 characters; finish() releases a held partial; nothing is lost', () => {
  const f = createReadTagFilter({ enabled: true, onTag: () => {} });
  assert.equal(f.push('abc [det'), 'abc ');
  assert.equal(f.finish(), '[det', 'flush releases the partial');
  assert.equal(f.finish(), '', 'nothing twice');
  assert.equal(f.push('[details'), '');
  assert.equal(f.push('x'), '[detailsx', 'the next chunk shows it is not the tag');
  const g = createReadTagFilter({ enabled: true, onTag: () => {} });
  for (const t of ['[', '[d', '[detail', '[details', 'x [', 'x [DETAIL']) {
    const out = g.push(t); const held = g.finish();
    assert.ok(t.length - out.length <= 9, t);
    assert.equal(out + held, t, 'every character comes out: ' + t);
  }
  // a full tag held for its next character is released as the tag at finish(): removed, onTag once, and the filter keeps working
  const tags = []; const h = createReadTagFilter({ enabled: true, onTag: (t) => tags.push(t) });
  assert.equal(h.push('hi [details]'), 'hi ');
  assert.equal(h.finish(), ''); assert.deepEqual(tags, ['details']);
  assert.equal(h.push('  more'), 'more', 'the whitespace after a removed tag is still eaten');
  assert.equal(h.push(' [details] again'), ' again'); assert.equal(tags.length, 2);
});

test('anyplace filter: disabled passes through byte for byte; a throwing onTag does not break the text; odd input', () => {
  const d = createReadTagFilter({ enabled: false, onTag: () => assert.fail('no') });
  assert.equal(d.push('[details] hi'), '[details] hi'); assert.equal(d.finish(), '');
  assert.equal(createReadTagFilter().push('[details] hi'), '[details] hi');
  assert.equal(runAny(['a [details] b'], { onTag: () => { throw new Error('x'); } }).out, 'a b');
  assert.equal(createReadTagFilter({ enabled: true }).push('a [details] b'), 'a b', 'no onTag is fine');
  const f = createReadTagFilter({ enabled: true, onTag: () => {} });
  assert.equal(f.push(null), ''); assert.equal(f.push(undefined), ''); assert.equal(f.push(5), '5'); assert.equal(f.push(''), '');
});

test('anyplace filter: after the leading filter it covers the answer to an interjection (same turn)', () => {
  // the leading filter has already passed (the turn began with ordinary text); the tag arrives later in the same turn
  const tags = [];
  const lead = createMoodFilter({ enabled: true, onTag: (t) => tags.push('lead:' + t) });
  const any = createReadTagFilter({ enabled: true, onTag: (t) => tags.push('any:' + t) });
  let out = '';
  for (const c of ['Working on it. ', '[detai', 'ls] Remember, you can interrupt me any time. ', 'Step one.']) out += any.push(lead.push(c));
  out += any.push(lead.finish()) + any.finish();
  assert.equal(out, 'Working on it. Remember, you can interrupt me any time. Step one.');
  assert.deepEqual(tags, ['any:details']);
});

// ── createVoiceMood (vm-extracted): one chunk with the turn id, nothing lost ──
function voiceMoodCtx() {
  const i = SRC.indexOf('function createVoiceMood('); assert.ok(i >= 0);
  let d = 0; let j = SRC.indexOf(') {', i) + 2;
  for (; j < SRC.length; j++) { if (SRC[j] === '{') d++; else if (SRC[j] === '}') { d--; if (!d) break; } }
  const sent = [];
  const ctx = { createMoodFilter, createReadTagFilter, sendSSE: (res, c) => sent.push(c), makeChunk: (t, model, gw) => ({ text: t, model, gateway: gw }) };
  vm.createContext(ctx);
  vm.runInContext(SRC.slice(i, j + 1) + '\nthis.createVoiceMood = createVoiceMood;', ctx);
  return { make: (o) => ctx.createVoiceMood({ res: {}, model: 'm', ...o }), sent };
}
const gwOf = (sent, type) => sent.map(c => JSON.parse(JSON.stringify(c.gateway || {}))).filter(g => g.type === type);   // JSON: the objects come from the vm realm

test('createVoiceMood: the read-full chunk carries the turn id and is sent at most once, from either filter', () => {
  const { make, sent } = voiceMoodCtx();
  const a = make({ enabled: true, turnId: 'ada-1' });
  assert.equal(a.push('[details] First. '), 'First. ');
  assert.equal(a.push('Then [details] again. '), 'Then again. ');
  assert.equal(a.flush(), '');
  assert.deepEqual(gwOf(sent, 'voice_read_full'), [{ type: 'voice_read_full', turnId: 'ada-1' }]);
  sent.length = 0;
  const b = make({ enabled: true, turnId: 't-2' });   // not at the start: the interjection's answer
  assert.equal(b.push('Okay, '), 'Okay, ');
  assert.equal(b.push('[details] Remember, you can interrupt me. Here.'), 'Remember, you can interrupt me. Here.');
  assert.deepEqual(gwOf(sent, 'voice_read_full'), [{ type: 'voice_read_full', turnId: 't-2' }]);
  sent.length = 0;
  const c = make({ enabled: true });   // no turn id known (ephemeral / tiger): null
  c.push('x [details] y');
  assert.deepEqual(gwOf(sent, 'voice_read_full'), [{ type: 'voice_read_full', turnId: null }]);
});

test('createVoiceMood: split tag, links kept, flush releases a held partial, abort sends nothing, mood still works', () => {
  const { make, sent } = voiceMoodCtx();
  const a = make({ enabled: true, turnId: 'T' });
  let out = ''; for (const ch of 'Hi. [Det' + 'ails]\n\nBody [details](u) end [det') out += a.push(ch);
  assert.equal(out, 'Hi. Body [details](u) end ');
  assert.equal(a.flush(), '[det', 'held partial released when the model call ends');
  assert.equal(gwOf(sent, 'voice_read_full').length, 1);
  sent.length = 0;
  const ab = new AbortController(); ab.abort();
  const b = make({ enabled: true, signal: ab.signal, turnId: 'T' });
  assert.equal(b.push('a [details] b'), 'a b'); assert.equal(sent.length, 0, 'aborted: no signal, text still filtered');
  const m = make({ enabled: true, turnId: 'T' });
  assert.equal(m.push('[proud] Well done [details] x'), 'Well done x');
  assert.equal(gwOf(sent, 'voice_mood').length, 1); assert.equal(gwOf(sent, 'voice_read_full').length, 1);
  const off = make({ enabled: false, turnId: 'T' });
  assert.equal(off.push('[details] a'), '[details] a'); assert.equal(off.flush(), '');
  const idle = make({ enabled: true }); assert.equal(idle.flush(), '', 'nothing received: nothing held');
});

// ── the tool handler ──
test('voice_interrupt_reminder handler: refusals change nothing; success saves', () => {
  const s = createVoicePersonPrefs({ file: tmpFile() });
  const base = { moodStrip: true, ephemeral: false, consultedBy: null, depth: 0, tigerTeam: false, originKind: 'user', personKey: 'sam' };
  const bads = [{ moodStrip: false }, { moodStrip: undefined }, { consultedBy: 'ada' }, { depth: 1 }, { ephemeral: true }, { tigerTeam: true }, { originKind: 'schedule' }, { originKind: undefined }, { personKey: '' }, { personKey: undefined }];
  for (const b of bads) assert.equal(handleInterruptReminderTool({ on: false, turn: { ...base, ...b } }, s), NOT_ON_CALL, JSON.stringify(b));
  assert.equal(handleInterruptReminderTool({ on: false }, s), NOT_ON_CALL);
  assert.equal(NOT_ON_CALL, 'This only works on a voice call, for the person speaking.');
  assert.equal(s.interruptReminder('sam'), true, 'nothing changed');
  assert.match(handleInterruptReminderTool({ on: false, turn: base }, s), /^Done: I will no longer remind them/);
  assert.equal(s.interruptReminder('sam'), false);
  assert.match(handleInterruptReminderTool({ on: true, turn: base }, s), /^Done: I will remind them again/);
  assert.equal(s.interruptReminder('sam'), true);
  assert.doesNotMatch(handleInterruptReminderTool({ on: 'yes', turn: base }, s), /^Done/);
});

test('the tool is wired in both builders and the policy, identity from the turn (source pins)', () => {
  assert.match(SRC, /name: 'voice_interrupt_reminder',\s*\n\s*description: VOICE_INTERRUPT_DESC/);
  assert.match(SRC, /sdk\.tool\('voice_interrupt_reminder', VOICE_INTERRUPT_DESC,\s*\n\s*\{ on: z\.boolean\(\)/);
  assert.match(SRC, /const VOICE_INTERRUPT_DESC = 'On a voice call, switch whether you start reading details with the reminder that the person can interrupt you\. Use it only when the person on the call asks for that\. on: false stops the reminder, true brings it back\.'/);
  assert.equal((SRC.match(/voiceTurn: voiceTurnCtx\(options,/g) || []).length, 2, 'Claude client and Codex bridge');
  assert.match(SRC, /buildAllTools\([^\n]*voiceTurnCtx\(options,/);
  assert.match(SRC, /const voicePersonKey = moodStrip \?[^\n]*trustedUserId[^\n]*: 'owner'\) : ''/);
  assert.equal((SRC.match(/\n      voicePersonKey,\n      interruptReminder,\n/g) || []).length, 3, 'gateway, Claude client, Codex');
  assert.match(SRC, /try \{ interruptReminder = voicePersonPrefs\.getVoicePersonPrefs\(\)\.interruptReminder\(voicePersonKey\) !== false; \} catch \{ interruptReminder = true; \}/);
  assert.match(SRC, /const readFull = \(\) => \{[\s\S]{0,200}type: 'voice_read_full', turnId: turnId \|\| null/);
  assert.match(SRC, /onTag: readFull \}\);\s*\n\s*const rf = createReadTagFilter\(\{ enabled: enabled === true, onTag: readFull \}\);/);
  assert.equal((SRC.match(/createVoiceMood\(\{[^\n]*turnId: \(turnRegistry\.get\(agentName\) \|\| \{\}\)\.turnId \|\| null \}\)/g) || []).length, 3, 'gateway, Claude client, Codex');
  assert.match(SRC, /extras\('voice_interrupt_reminder', !!\(voiceTurn && voiceTurn\.moodStrip === true\)\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'lib', 'tool-policy.js'), 'utf8'), /HUB_WRITE_INSIDE = new Set\([^)]*'for_owner', 'voice_interrupt_reminder'/);
  // the handler never reads the tool input for identity
  assert.match(SRC, /handleInterruptReminderTool\(\{ on: args && args\.on, turn: voiceTurn \}/);
});

// ── hub-events ──
function fakeClient() {
  const out = [];
  const res = { writableLength: 0, writeHead() {}, write(s) { out.push(s); return true; }, on() {}, destroy() {} };
  return { req: { headers: {} }, res, out };
}
const frames = (out) => out.filter(s => typeof s === 'string' && s.startsWith('id: ')).map(s => JSON.parse(s.split('\ndata: ')[1]));
const readFull = { choices: [{ delta: {} }], gateway: { type: 'voice_read_full' } };
const sse = (o) => 'data: ' + JSON.stringify(o) + '\n\n';
function setup(origin = { kind: 'user' }) {
  const hub = createHubEvents(); const c = fakeClient(); hub.subscribe(c.req, c.res);
  const res = { write: () => true };
  const tap = hub.tapTurn(res, { agent: 'ada', origin, message: 'hi', turnId: 't-1' });
  return { hub, c, res, tap };
}
const got = (c) => frames(c.out).filter(x => x.type === 'turn_read_full');

test('hub-events: voice_read_full becomes one turn_read_full per turn, user origin only', () => {
  const { c, res } = setup();
  res.write(sse(readFull)); res.write(sse(readFull));
  const f = got(c);
  assert.equal(f.length, 1);
  assert.equal(f[0].agent, 'ada'); assert.equal(f[0].turnId, 't-1');
  assert.deepEqual(Object.keys(f[0]).filter(k => !['id', 'type', 'ts', 'at', 'bootId', 'seq'].includes(k)).sort(), ['agent', 'turnId']);
  for (const kind of ['consultation', 'schedule', 'task', 'job_notice', 'alert']) {
    const o = setup({ kind }); o.res.write(sse(readFull));
    assert.equal(got(o.c).length, 0, kind);
  }
});

test('hub-events: none after the turn ends, and not replayed to a late page', () => {
  const a = setup(); a.tap.finish(true); a.res.write(sse(readFull));
  assert.equal(got(a.c).length, 0);
  const b = setup(); b.res.write(sse(readFull));
  const late = fakeClient(); b.hub.subscribe(late.req, late.res);
  assert.equal(got(late).length, 0);
});
