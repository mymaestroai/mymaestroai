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
const { createMoodFilter, READ_TAG, FACE_MOOD_NOTE } = require('../lib/voice/mood');
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
  assert.match(SRC, /onTag: \(\) => \{[\s\S]{0,160}type: 'voice_read_full'/);
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
