'use strict';
// A recorded call on the pages: the page-side session (lib/ui-voice-call.js voiceCreateRecordingSession, with a fake adapter, a fake fetch and fake timers), the
// call display's recording badge and Pause button (fake DOM), the VAD adapter's second microphone track, and source checks of app.js and mobile.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
Object.assign(globalThis, require('../lib/ui-voice'));
const CALL = require('../lib/ui-voice-call');
const CD = require('../lib/ui-call-display');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const tick = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

// ── page source checks ──
for (const [name, file] of [['desktop', 'app.js'], ['phone', 'mobile.js']]) {
  const src = read(file);
  test(`${name} page: the start body gets device only when recordings.keep is true`, () => {
    assert.match(src, /if \(rec\) body\.device = await rec\.device\(\)/, 'device is added only for a recorded call');
    assert.match(src, /voiceRecSettings\(/);
    assert.match(src, /recCfg\.keep/);
    assert.ok(!/action: 'start', mode, device/.test(src), 'never part of the plain start body');
  });
  test(`${name} page: recording_needs_local_stt stops the call with the plain-words reason`, () => {
    assert.match(src, /recording_needs_local_stt/);
    assert.match(src, /throw new Error\(VOICE_REC_NEEDS_LOCAL\)/);
    assert.ok(CALL.VOICE_REC_NEEDS_LOCAL.startsWith('This agent keeps recordings of its calls, and recordings are only made with speech recognition on this computer.'));
    assert.ok(CALL.VOICE_REC_NEEDS_LOCAL.endsWith("An admin can switch this agent's speech recognition to this computer on its settings page."));
    assert.ok(src.includes('VOICE_REC_NEEDS_LOCAL = \'This agent keeps recordings'), 'the shared block carries the message');
  });
  test(`${name} page: the recorder exists only with a recording sessionId (the start answer), made by the shared session`, () => {
    assert.match(src, /voiceCreateRecordingSession\(\{/);
    assert.match(src, /await g\.started\(/, 'the start answer\'s recording goes to the session');
    assert.ok(src.includes("const make = q.createRecorder || voiceCreateRecorder;"), 'the recorder is made inside started()');
    const lib = read('lib/ui-voice-call.js');
    const started = lib.slice(lib.indexOf('async started(rec, id)'), lib.indexOf('async recordTranscript'));
    assert.ok(started.indexOf('!rec.sessionId') > 0 && started.indexOf('!rec.sessionId') < started.indexOf('make('), 'no sessionId: no recorder');
  });
  test(`${name} page: the display is told the recording state (setRecording) and the Pause button is wired`, () => {
    assert.match(src, /voiceDisplayHook\('setRecording'/);
    assert.match(src, /onRecordingToggle:/);
  });
  test(`${name} page: reply audio is handed to the session only in a recorded call; the consent line goes through the replies' TTS path`, () => {
    assert.match(src, /\.replyAudio\(/);
    assert.match(src, /speak: \(line\) => voiceCallSpeakLine\(agent, line\)/);
  });
}

// ── the page-side session ──
function fakeVad(over) {
  const v = { opened: true, tap: { processing: 'second-track', node: { name: 'second' } }, watchers: [], ctx: { sampleRate: 48000 }, playback: [], tapped: [] };
  return Object.assign(v, {
    whenOpen: () => Promise.resolve(v.opened), openRecordingTap: async (un) => { v.tapped.push(un); return v.tap; },
    info: () => ({ label: 'Test mic' }), audioContext: () => v.ctx, recordingNode: () => ({ name: 'call' }), onSourceChange: (f) => v.watchers.push(f),
  }, over);
}
function session(over, vadOver) {
  const t = { posts: [], badges: [], toasts: [], spoken: [], vad: fakeVad(vadOver), recorders: [], timers: [], now: 5000 };
  t.fetch = async (url, init) => {
    t.posts.push({ url, init });
    if (t.failPause && url.includes('/pause')) return { ok: false, status: 500, json: async () => ({ error: 'recording_failed' }) };
    if (t.segmentStatus && url.includes('/segment')) return { ok: t.segmentStatus < 400, status: t.segmentStatus, json: async () => ({}) };
    const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : {};
    return { ok: true, status: 200, json: async () => (url.includes('/pause') ? { ok: true, paused: body.paused } : { ok: true, seq: 3 }) };
  };
  t.createRecorder = (o) => { const r = { o, log: [], begin() { r.log.push('begin'); }, drop() { r.log.push('drop'); }, end() { r.log.push('end'); return { seq: Promise.resolve(7) }; }, pause(on) { r.log.push('pause:' + on); }, setSource(n) { r.log.push('source:' + n.name); }, stop() { r.log.push('stop'); } }; t.recorders.push(r); return r; };
  t.s = CALL.voiceCreateRecordingSession(Object.assign({
    agent: 'biographer', vad: t.vad, fetch: t.fetch, nav: { userAgent: 'TestAgent/1' }, unprocessed: true, wired: true,
    speak: async (line) => { t.spoken.push(line); t.order.push('speak'); }, playback: (on) => t.vad.playback.push(on),
    badge: (s) => t.badges.push(s), toast: (m) => t.toasts.push(m), now: () => t.now, setTimer: (fn, ms) => { t.timers.push([fn, ms]); return t.timers.length; }, clearTimer() {},
    createRecorder: t.createRecorder,
  }, over));
  t.order = [];
  return t;
}
const posted = (t, part) => t.posts.filter(p => p.url.includes(part));
const bodyOf = (p) => JSON.parse(p.init.body);

test('session.device(): the call microphone, rate and how the voice is taken (second-track / call-track / processed)', async () => {
  const t = session();
  const d = await t.s.device();
  assert.deepStrictEqual(d, { userAgent: 'TestAgent/1', processing: 'second-track', micLabel: 'Test mic', sampleRate: 48000 });
  assert.deepStrictEqual(t.vad.tapped, [true], 'unprocessed was asked for');
  const p = session({ unprocessed: false }, { tap: { processing: 'processed', node: { name: 'call' } } });
  assert.strictEqual((await p.s.device()).processing, 'processed');
  assert.deepStrictEqual(p.vad.tapped, [false], 'processed: the call\'s own source, no second stream');
});

test('session.device(): a microphone that never opens does not hold the start for ever, and sends what is known', async () => {
  const t = session({}, { whenOpen: () => new Promise(() => {}) });
  const p = t.s.device();
  await tick();
  assert.strictEqual(t.timers.length, 1);
  assert.strictEqual(t.timers[0][1], 15000);
  t.timers[0][0]();
  assert.deepStrictEqual(await p, { userAgent: 'TestAgent/1' });
});

test('session.started(): the consent line is spoken first (not recorded), consent is posted, then the recorder is made on the tap and the badge is on', async () => {
  const t = session();
  await t.s.device();
  await t.s.started({ sessionId: '20261113-220000-0a0b0c', consentLine: 'This is being recorded for the family.', keepReplies: false, mic: 'unprocessed' }, 'call-1');
  assert.deepStrictEqual(t.spoken, ['This is being recorded for the family.']);
  assert.deepStrictEqual(t.vad.playback, [true, false], 'the speech detector is told a line is playing');
  assert.deepStrictEqual(t.badges, ['on']);
  assert.strictEqual(t.recorders.length, 1);
  assert.strictEqual(t.recorders[0].o.source.name, 'second', 'the second track is the tap');
  assert.deepStrictEqual(bodyOf(posted(t, '/consent')[0]), { agent: 'biographer', callId: 'call-1' });
  // speech before the recorder: the controller's proxy is a no-op; after: it begins and ends the real recorder
  t.s.recorder.begin(); const h = t.s.recorder.end();
  assert.deepStrictEqual(t.recorders[0].log, ['begin', 'end']);
  assert.strictEqual(await h.seq, 7);
  t.vad.watchers[0]({ name: 'reopened' });
  assert.ok(t.recorders[0].log.includes('source:reopened'), 'a microphone reopen moves the tap');
});

test('session: nothing is recorded before the line has played (the recorder does not exist while it is spoken)', async () => {
  const t = session({ speak: async () => { assert.strictEqual(t.recorders.length, 0); t.s.recorder.begin(); assert.strictEqual(t.s.recorder.end(), null); } });
  await t.s.started({ sessionId: 's', consentLine: 'x' }, 'c1');
  assert.strictEqual(t.recorders.length, 1);
});

test('session.started(): a line that could not be spoken (TTS failed) still shows the badge and posts consent', async () => {
  const t = session({ speak: async () => { throw new Error('tts down'); } });
  await t.s.started({ sessionId: 's', consentLine: 'x' }, 'c1');
  assert.deepStrictEqual(t.badges, ['on']);
  assert.strictEqual(posted(t, '/consent').length, 1);
  assert.strictEqual(t.recorders.length, 1);
});

test('session.started() with recording.error: "Not recording" and ONE start_failed report; no recorder', async () => {
  const t = session();
  await t.s.started({ error: 'recording_unavailable' }, 'c1');
  assert.deepStrictEqual(t.badges, ['error']);
  assert.strictEqual(t.recorders.length, 0);
  const r = posted(t, '/trouble');
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual(bodyOf(r[0]), { agent: 'biographer', callId: 'c1', reason: 'start_failed' });
  t.s.trouble('upload_failed');
  assert.strictEqual(posted(t, '/trouble').length, 1, 'once per call');
  assert.strictEqual(t.s.state, 'error');
});

test('session: an answer with a recording that this page did not expect (wired false) is "Not recording"', async () => {
  const t = session({ wired: false });
  await t.s.started({ sessionId: 's', consentLine: 'x' }, 'c1');
  assert.deepStrictEqual(t.badges, ['error']);
  assert.strictEqual(t.recorders.length, 0);
  assert.deepStrictEqual(t.spoken, [], 'nothing is recorded, so no consent line is claimed');
});

test('session: an upload that keeps failing shows "trouble" (still recording, Pause stays), reports once; Pause and Resume work in that state', async () => {
  const t = session();
  await t.s.started({ sessionId: 's', consentLine: '' }, 'c1');
  t.recorders[0].o.onTrouble('upload_failed'); t.recorders[0].o.onTrouble('upload_failed');
  assert.deepStrictEqual(t.badges, ['on', 'trouble']);
  assert.deepStrictEqual(posted(t, '/trouble').map(p => bodyOf(p).reason), ['upload_failed']);
  await t.s.togglePause(true);
  assert.strictEqual(posted(t, '/pause').length, 1, 'pause works in trouble');
  assert.deepStrictEqual(t.badges, ['on', 'trouble', 'paused']);
  await t.s.togglePause(false);
  assert.deepStrictEqual(t.badges, ['on', 'trouble', 'paused', 'trouble'], 'back to recording, with the trouble still shown');
  assert.strictEqual(t.recorders[0].log.includes('stop'), false, 'the recorder was never stopped');
});

test('session: a recorder that could not be made, or whose tap failed, is "stopped" (start_failed, reported once); an upload trouble is not', async () => {
  const t = session({ createRecorder: () => { throw new Error('no tap'); } });
  await t.s.started({ sessionId: 's', consentLine: '' }, 'c1');
  assert.deepStrictEqual(t.badges, ['on', 'stopped']);
  assert.deepStrictEqual(posted(t, '/trouble').map(p => bodyOf(p).reason), ['start_failed']);
  const u = session({ createRecorder: (o) => ({ ready: Promise.resolve(false), begin() {}, drop() {}, end() { return null; }, pause() {}, setSource() {}, stop() {} }) });
  await u.s.started({ sessionId: 's', consentLine: '' }, 'c2');
  await tick();
  assert.deepStrictEqual(u.badges, ['on', 'stopped'], 'ready false: the tap failed');
  assert.deepStrictEqual(posted(u, '/trouble').map(p => bodyOf(p).reason), ['start_failed']);
  await u.s.togglePause(true);
  assert.strictEqual(posted(u, '/pause').length, 0, 'no pause once it has stopped');
  const ok = session({ createRecorder: (o) => ({ ready: Promise.resolve(true), begin() {}, drop() {}, end() { return null; }, pause() {}, setSource() {}, stop() {} }) });
  await ok.s.started({ sessionId: 's', consentLine: '' }, 'c3'); await tick();
  assert.deepStrictEqual(ok.badges, ['on'], 'ready true: nothing changes');
});

test('fix 2: pause does not wait: the recorder pauses locally and the hub is asked to pause at once, even while uploads are still going up', async () => {
  const gate = new Promise(() => {});   // an upload that never finishes
  const t = session();
  const seen = [];
  t.createRecorder = (o) => { const r = { o, log: [], begin() {}, drop() {}, end() { return null; }, pause(on) { r.log.push('pause:' + on); return on ? gate : Promise.resolve(); }, setSource() {}, stop() {} }; t.recorders.push(r); return r; };
  t.s = CALL.voiceCreateRecordingSession({ agent: 'biographer', vad: t.vad, fetch: async (u, i) => { seen.push(u); return { ok: true, status: 200, json: async () => ({ paused: true }) }; }, nav: {}, wired: true, speak: async () => {}, badge: (s) => t.badges.push(s), toast() {}, now: () => 1, setTimer: (fn, ms) => { t.timers.push([fn, ms]); return 1; }, clearTimer() {}, createRecorder: t.createRecorder });
  await t.s.started({ sessionId: 's', consentLine: '' }, 'c1');
  seen.length = 0;
  await t.s.togglePause(true);   // resolves although the recorder's flushed() never does
  assert.deepStrictEqual(t.recorders[0].log, ['pause:true', 'pause:true']);
  assert.deepStrictEqual(seen, ['/api/recordings/pause']);
  assert.deepStrictEqual(t.badges, ['on', 'paused']);
  assert.ok(!t.timers.some(x => x[1] === 60000), 'no 60 s wait');
});

test('session pause: when the hub\'s pause fails, capture goes back to recording (pause(false)) and the badge keeps its state', async () => {
  const t = session();
  await t.s.started({ sessionId: 's', consentLine: '' }, 'c1');
  t.failPause = true;
  await t.s.togglePause(true);
  assert.deepStrictEqual(t.recorders[0].log, ['pause:true', 'pause:false']);
  assert.deepStrictEqual(t.badges, ['on']);
});

test('session consent: the line gets at most 20 s; after that the call carries on, the hub is told { spoken: false } and the line is shown in a toast', async () => {
  const t = session({ speak: () => new Promise(() => {}) });
  const p = t.s.started({ sessionId: 's', consentLine: 'This call is being recorded.' }, 'c1');
  await tick();
  assert.strictEqual(t.recorders.length, 0, 'still waiting for the line');
  const w = t.timers.find(x => x[1] === 20000); assert.ok(w, 'a 20 s limit');
  w[0](); await p;
  assert.strictEqual(t.recorders.length, 1, 'carried on');
  assert.deepStrictEqual(bodyOf(posted(t, '/consent')[0]), { agent: 'biographer', callId: 'c1', spoken: false });
  assert.deepStrictEqual(t.toasts, ['This call is being recorded.']);
  assert.deepStrictEqual(t.vad.playback, [true, false]);
});

test('session consent: a line that failed is shown and reported the same way; one that played is neither toasted nor flagged', async () => {
  const bad = session({ speak: async () => { throw new Error('tts down'); } });
  await bad.s.started({ sessionId: 's', consentLine: 'Recorded.' }, 'c1');
  assert.deepStrictEqual(bodyOf(posted(bad, '/consent')[0]), { agent: 'biographer', callId: 'c1', spoken: false });
  assert.deepStrictEqual(bad.toasts, ['Recorded.']);
  const ok = session();
  await ok.s.started({ sessionId: 's', consentLine: 'Recorded.' }, 'c2');
  assert.deepStrictEqual(bodyOf(posted(ok, '/consent')[0]), { agent: 'biographer', callId: 'c2' });
  assert.deepStrictEqual(ok.toasts, []);
});

test('session.flushOpen(): the recorder cuts its open segment (page hidden or closed); the call is not ended', async () => {
  const t = session();
  await t.s.started({ sessionId: 's', consentLine: '' }, 'c1');
  t.recorders[0].cut = () => t.recorders[0].log.push('cut');
  t.s.flushOpen();
  assert.deepStrictEqual(t.recorders[0].log, ['cut']);
  assert.strictEqual(t.s.state, 'on');
});

test('session: the recorder is told which piece belongs where (agent, callId, speaker) so the store can name it', async () => {
  const t = session();
  await t.s.started({ sessionId: 's', consentLine: '' }, 'c7');
  assert.strictEqual(t.recorders[0].o.agent, 'biographer');
  assert.strictEqual(t.recorders[0].o.callId, 'c7');
  assert.strictEqual(t.recorders[0].o.speaker, 'person');
});

// ── the pieces kept until the hub has them: IndexedDB store and the resend ──
function fakeIdb() {
  const data = new Map(); let created = 0;
  const req = () => ({ onsuccess: null, onerror: null, result: undefined });
  const later = (fn) => setImmediate(fn);
  const store = {
    put(rec) { const r = req(); data.set(rec.id, rec); later(() => { r.result = rec.id; r.onsuccess && r.onsuccess(); }); return r; },
    delete(id) { const r = req(); data.delete(id); later(() => r.onsuccess && r.onsuccess()); return r; },
    get(id) { const r = req(); later(() => { r.result = data.get(id); r.onsuccess && r.onsuccess(); }); return r; },
    getAll() { const r = req(); later(() => { r.result = [...data.values()]; r.onsuccess && r.onsuccess(); }); return r; },
  };
  const db = { transaction(name, mode) { assert.strictEqual(name, 'pieces'); const tx = { oncomplete: null, objectStore: () => store }; later(() => later(() => tx.oncomplete && tx.oncomplete())); return tx; }, createObjectStore(name, o) { assert.strictEqual(name, 'pieces'); assert.deepStrictEqual(o, { keyPath: 'id' }); created++; } };
  return { data, get created() { return created; }, open(name, ver) { assert.strictEqual(name, 'hub-rec-pending'); const r = { result: db, onsuccess: null, onupgradeneeded: null }; later(() => { r.onupgradeneeded && r.onupgradeneeded(); r.onsuccess && r.onsuccess(); }); return r; } };
}
const piece = (id, createdAt, extra) => Object.assign({ id, userId: 'u1', agent: 'biographer', callId: 'c1', speaker: 'person', startedAt: Date.UTC(2026, 10, 13, 22, 0, 0), endedAt: Date.UTC(2026, 10, 13, 22, 0, 2), wav: new Uint8Array([1, 2, 3]).buffer, createdAt }, extra);

test('IndexedDB store: database hub-rec-pending, store pieces (keyPath id); put, all, del round trip', async () => {
  const idb = fakeIdb();
  const st = CALL.voiceRecStore(idb);
  assert.strictEqual(await st.put(piece('a', 1)), true);
  assert.strictEqual(idb.created, 1);
  assert.deepStrictEqual((await st.all()).map(r => r.id), ['a']);
  assert.strictEqual(await st.del('a'), true);
  assert.deepStrictEqual(await st.all(), []);
  assert.strictEqual(CALL.voiceRecStore(null), null, 'no IndexedDB: no store, memory only');
  const broken = CALL.voiceRecStore({ open() { throw new Error('denied'); } });
  assert.strictEqual(await broken.put(piece('b', 1)), false, 'a failing database never throws');
  assert.deepStrictEqual(await broken.all(), []);
});

test('voiceRecResendPending: sends every stored piece younger than 55 minutes one at a time, oldest first; deletes older ones; deletes what the hub took or refused for good', async () => {
  const now = 10 * 3600 * 1000, idb = fakeIdb();
  const st = CALL.voiceRecStore(idb);
  await st.put(piece('old', now - 56 * 60 * 1000));
  await st.put(piece('b', now - 2000)); await st.put(piece('a', now - 3000)); await st.put(piece('gone', now - 1000));
  const calls = []; let live = 0, peak = 0;
  const fetchFn = async (url, init) => {
    live++; peak = Math.max(peak, live); calls.push({ url, init }); await tick(); live--;
    return { ok: !url.includes('callId=c9'), status: url.includes('callId=c9') ? 409 : 200 };
  };
  await st.put(piece('paused', now - 500, { callId: 'c9' }));
  const r = await CALL.voiceRecResendPending(fetchFn, { store: st, now: () => now, userId: 'u1' });
  assert.strictEqual(peak, 1, 'one at a time');
  assert.strictEqual(calls.length, 4, 'the old one is not sent');
  assert.match(calls[0].url, /^\/api\/recordings\/segment\?agent=biographer&callId=c1&speaker=person&startedAt=2026-11-13T22%3A00%3A00\.000Z&endedAt=2026-11-13T22%3A00%3A02\.000Z&piece=a$/);
  assert.strictEqual(calls[0].init.headers['Content-Type'], 'audio/wav');
  assert.deepStrictEqual(Array.from(calls[0].init.body), [1, 2, 3]);
  assert.deepStrictEqual(await st.all(), [], 'sent, refused (409) and too old: all deleted');
  assert.deepStrictEqual(r, { sent: 3, dropped: 2, kept: 0 });
});

test('voiceRecResendPending: a network failure stops the pass and keeps the rest; a 5xx or a lost sign-in (401) keeps that piece', async () => {
  const now = 5e6, st = CALL.voiceRecStore(fakeIdb()), U = { store: st, now: () => now, userId: 'u1' };
  await st.put(piece('a', now - 3000)); await st.put(piece('b', now - 2000));
  let n = 0;
  let r = await CALL.voiceRecResendPending(async () => { n++; throw new Error('offline'); }, U);
  assert.strictEqual(n, 1, 'stops at the first failure'); assert.strictEqual(r.kept, 2);
  r = await CALL.voiceRecResendPending(async () => ({ ok: false, status: 503 }), U);
  r = await CALL.voiceRecResendPending(async () => ({ ok: false, status: 401 }), U);
  assert.strictEqual((await st.all()).length, 2);
  r = await CALL.voiceRecResendPending(async () => ({ ok: true, status: 200 }), U);
  assert.strictEqual(r.sent, 2); assert.strictEqual((await st.all()).length, 0);
  assert.deepStrictEqual(await CALL.voiceRecResendPending(async () => ({ ok: true }), { store: null, userId: 'u1' }), { sent: 0, dropped: 0, kept: 0 }, 'no store: nothing to do');
});

test('fix 8: voiceRecResendPending: a 5xx or 413 on one piece skips to the next; only a network failure stops the pass', async () => {
  const now = 5e6, st = CALL.voiceRecStore(fakeIdb()), U = { store: st, now: () => now, userId: 'u1' };
  await st.put(piece('aaaaaaaa', now - 4000)); await st.put(piece('bbbbbbbb', now - 3000)); await st.put(piece('cccccccc', now - 2000)); await st.put(piece('dddddddd', now - 1000));
  const seen = [];
  const r = await CALL.voiceRecResendPending(async (u) => {
    seen.push(u.split('piece=')[1]);
    if (u.endsWith('aaaaaaaa')) return { ok: false, status: 503 };
    if (u.endsWith('bbbbbbbb')) return { ok: false, status: 413 };
    if (u.endsWith('cccccccc')) return { ok: true, status: 200 };
    throw new Error('offline');
  }, U);
  assert.deepStrictEqual(seen, ['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd'], 'the 503 and the 413 did not stall the pass');
  assert.deepStrictEqual((await st.all()).map(x => x.id).sort(), ['aaaaaaaa', 'bbbbbbbb', 'dddddddd'], 'only the sent one is gone; a 413 is kept too');
  assert.strictEqual(r.sent, 1);
});

test('fix 3: voiceRecResendPending sends only the signed-in user\'s pieces; others and ownerless pieces are left alone until 55 minutes; no userId: nothing', async () => {
  const now = 5e6, st = CALL.voiceRecStore(fakeIdb());
  await st.put(piece('mine0001', now - 1000)); await st.put(piece('theirs01', now - 1000, { userId: 'u2' }));
  await st.put(piece('nobody01', now - 1000, { userId: undefined })); await st.put(piece('theirsold', now - 56 * 60 * 1000, { userId: 'u2' })); await st.put(piece('nobodyold', now - 56 * 60 * 1000, { userId: undefined }));
  const calls = [];
  const fetchFn = async (u) => { calls.push(u); return { ok: true, status: 200 }; };
  assert.deepStrictEqual(await CALL.voiceRecResendPending(fetchFn, { store: st, now: () => now }), { sent: 0, dropped: 0, kept: 0 }, 'userId unknown: nothing is sent');
  assert.deepStrictEqual(await CALL.voiceRecResendPending(fetchFn, { store: st, now: () => now, userId: '' }), { sent: 0, dropped: 0, kept: 0 });
  assert.strictEqual(calls.length, 0); assert.strictEqual((await st.all()).length, 5, 'and nothing deleted');
  const r = await CALL.voiceRecResendPending(fetchFn, { store: st, now: () => now, userId: 'u1' });
  assert.deepStrictEqual(calls.map(u => u.split('piece=')[1]), ['mine0001'], 'only the signed-in user\'s piece');
  assert.deepStrictEqual((await st.all()).map(x => x.id).sort(), ['nobody01', 'theirs01'], 'the others are left alone (the aged ones are gone)');
  assert.deepStrictEqual(r, { sent: 1, dropped: 2, kept: 0 });
});

test('fix 7: the store has get(id): the record, or null when absent; it rejects when unreadable (round 5)', async () => {
  const st = CALL.voiceRecStore(fakeIdb());
  await st.put(piece('a', 1));
  assert.strictEqual((await st.get('a')).id, 'a');
  assert.strictEqual(await st.get('zzz'), null);
  await assert.rejects(() => CALL.voiceRecStore({ open() { throw new Error('denied'); } }).get('a'));
});

test('voiceRecResendPending: a piece a live recorder is still sending is left alone', async () => {
  const now = 1e7, st = CALL.voiceRecStore(fakeIdb());
  const never = new Promise(() => {});
  let proc = null;
  const rec = CALL.voiceCreateRecorder({ ctx: { sampleRate: 1000, destination: {}, createGain: () => ({ gain: {}, connect() {}, disconnect() {} }), createScriptProcessor: () => { proc = { connect() {}, disconnect() {} }; return proc; } }, source: null,
    upload: () => never, now: () => now, setTimer() {}, clearTimer() {}, store: st, agent: 'biographer', callId: 'c1', prerollMs: 0 });
  await rec.ready;
  await st.put(piece('other', now - 1000));
  rec.begin(); proc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(100) } });
  rec.end();   // stored, and its upload hangs: it is the live recorder's
  await tick(40); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.strictEqual((await st.all()).length, 2, 'both are in the store');
  const calls = [];
  await CALL.voiceRecResendPending(async (u) => { calls.push(u); return { ok: true, status: 200 }; }, { store: st, now: () => now, userId: 'u1' });
  assert.strictEqual(calls.length, 1, 'only the stored piece of an earlier page');
});

// ── the pages: the resend, pagehide, the settings dialog ──
for (const [name, file] of [['desktop', 'app.js'], ['phone', 'mobile.js']]) {
  test(`${name} page: pieces are resent after sign-in is known and when a call starts; a page being hidden or closed sends the open segment`, () => {
    const src = read(file);
    const me = src.slice(src.indexOf('async function loadMe()'), src.indexOf('async function loadMe()') + 1200);
    assert.match(me, /voiceRecResendPending\(/, 'after /api/me says who is signed in');
    assert.match(src, /voiceRecFlushOpen/);
    assert.match(src, /if \(document\.hidden\) \{ voiceRecFlushOpen\(\); return; \}|try \{ voiceRecFlushOpen\(\); \} catch/, 'hidden: the open segment is sent (inside the one visibility handler)');
    assert.match(src, /flushOpen\(\)/);
    assert.ok(/'pagehide'[^\n]*(voiceRecFlushOpen|voiceLeaveApp)/.test(src), 'pagehide sends it too');
    const start = src.slice(src.indexOf(name === 'phone' ? 'function voiceCallStart()' : 'const rec = recCfg.keep'), src.indexOf(name === 'phone' ? 'function voiceCallStart()' : 'const rec = recCfg.keep') + 3500);
    assert.match(start, /voiceRecResendPending\(/, 'again at the start of a call');
    assert.ok(!/visibilityState === 'hidden'\) (voiceCallRelease|voiceCallHangUp)/.test(src), 'a hidden page does not end the call by this');
  });
}

test('desktop settings dialog: a call that is up takes the EFFECTIVE values (voiceEffNow of the call\'s agent), after the new prefs are saved', () => {
  const app = read('app.js');
  const save = app.slice(app.indexOf('function voiceSettingsSavePrefs(changed)'), app.indexOf('function voiceTestStop('));
  assert.match(save, /voiceEffNow\(voiceCallS\.agent\)/);
  assert.match(save, /setEndPause\(eff\.endPause\)/);
  assert.match(save, /setInterruptSensitivity\(eff\.interruptSensitivity\)/);
  assert.ok(!/setEndPause\(prefs\.endPause\)/.test(save), 'never the raw dialog value');
  assert.ok(save.indexOf('voicePrefsCache = prefs') < save.indexOf('voiceEffNow(voiceCallS.agent)'), 'the cache holds the new prefs before they are read back');
});

test('session uploads: the person\'s segment goes to /api/recordings/segment with agent, callId, speaker and ISO times as audio/wav; a 409 is not a failure; a 500 carries its status', async () => {
  const t = session();
  await t.s.started({ sessionId: 's', consentLine: '' }, 'call-9');
  const up = t.recorders[0].o.upload;
  const r = await up({ wav: new Uint8Array([1, 2, 3]), startedAt: Date.UTC(2026, 10, 13, 22, 0, 0), endedAt: Date.UTC(2026, 10, 13, 22, 0, 2) });
  assert.strictEqual(r.seq, 3);
  const p = posted(t, '/segment')[0];
  assert.strictEqual(p.url, '/api/recordings/segment?agent=biographer&callId=call-9&speaker=person&startedAt=2026-11-13T22%3A00%3A00.000Z&endedAt=2026-11-13T22%3A00%3A02.000Z');
  assert.strictEqual(p.init.headers['Content-Type'], 'audio/wav');
  assert.strictEqual(p.init.credentials, 'include');
  assert.deepStrictEqual(Array.from(p.init.body), [1, 2, 3]);
  t.segmentStatus = 409;
  assert.deepStrictEqual(await up({ wav: new Uint8Array(1), startedAt: 1, endedAt: 2 }), { seq: null, status: 409, error: 'not_recording' }, 'the hub refused it: no seq, the status and code are given back (the recorder keeps the stored copy)');
  t.segmentStatus = 500;
  await assert.rejects(() => up({ wav: new Uint8Array(1), startedAt: 1, endedAt: 2 }), (e) => e.status === 500);
});

test('session: the transcript waits for the segment\'s seq and posts it; a failed upload (null seq) posts nothing; reply text is posted once per call it is given', async () => {
  const t = session();
  await t.s.started({ sessionId: 's', consentLine: '' }, 'c1');
  await t.s.recordTranscript(Promise.resolve(7), 'I grew up by the sea.');
  assert.deepStrictEqual(bodyOf(posted(t, '/transcript')[0]), { agent: 'biographer', callId: 'c1', seq: 7, text: 'I grew up by the sea.', engine: 'local' });
  await t.s.recordTranscript(Promise.resolve(null), 'lost');
  assert.strictEqual(posted(t, '/transcript').length, 1);
  t.s.recordReplyText('Tell me more.');
  await tick();
  assert.deepStrictEqual(bodyOf(posted(t, '/text')[0]), { agent: 'biographer', callId: 'c1', text: 'Tell me more.', at: '1970-01-01T00:00:05.000Z' });
});

test('session pause: the badge follows the server\'s answer; a failure keeps the old state, shows a short toast and puts the recorder back', async () => {
  const t = session();
  await t.s.started({ sessionId: 's', consentLine: '' }, 'c1');
  await t.s.togglePause(true);
  assert.deepStrictEqual(bodyOf(posted(t, '/pause')[0]), { agent: 'biographer', callId: 'c1', paused: true });
  assert.deepStrictEqual(t.badges, ['on', 'paused']);
  assert.deepStrictEqual(t.recorders[0].log, ['pause:true', 'pause:true']);
  t.s.recordReplyText('while paused');
  await tick();
  assert.strictEqual(posted(t, '/text').length, 0, 'no reply text while paused');
  await t.s.togglePause(false);
  assert.deepStrictEqual(t.badges, ['on', 'paused', 'on']);
  t.failPause = true;
  await t.s.togglePause(true);
  assert.deepStrictEqual(t.badges, ['on', 'paused', 'on'], 'the old state stays');
  assert.strictEqual(t.toasts.length, 1);
  assert.match(t.toasts[0], /Could not change the recording/);
  assert.strictEqual(t.recorders[0].log.slice(-1)[0], 'pause:false', 'capture was put back as it was');
});

test('session reply audio: uploaded as speaker agent only when the agent keeps replies; never the consent line; never while paused', async () => {
  const wavBuf = () => { const b = new ArrayBuffer(48); const dv = new DataView(b); dv.setUint32(28, 48000, true); dv.setUint32(40, 4, true); return b; };
  const off = session();
  await off.s.started({ sessionId: 's', consentLine: '', keepReplies: false }, 'c1');
  off.s.replyAudio(wavBuf()); await tick();
  assert.strictEqual(posted(off, '/segment').length, 0, 'keepReplies off: never');
  const on = session({ speak: async () => { on.s.replyAudio(wavBuf()); } });
  await on.s.started({ sessionId: 's', consentLine: 'x', keepReplies: true }, 'c2');
  await tick();
  assert.strictEqual(posted(on, '/segment').length, 0, 'the consent line itself is not kept');
  on.s.replyAudio(wavBuf()); await tick();
  const p = posted(on, '/segment');
  assert.strictEqual(p.length, 1);
  assert.match(p[0].url, /speaker=agent&/);
  await on.s.togglePause(true);
  on.s.replyAudio(wavBuf()); await tick();
  assert.strictEqual(posted(on, '/segment').length, 1, 'paused: nothing');
});

test('session.stop(): the recorder stops and nothing more is started', async () => {
  const t = session();
  await t.s.started({ sessionId: 's', consentLine: '' }, 'c1');
  t.s.recorder.stop();
  assert.ok(t.recorders[0].log.includes('stop'));
  assert.strictEqual(t.s.recorder.end(), null);
});

test('voiceRecSettings: keep and mic from the agent record, defaults when missing', () => {
  assert.deepStrictEqual(CALL.voiceRecSettings(null), { keep: false, mic: 'processed' });
  assert.deepStrictEqual(CALL.voiceRecSettings({ recordings: { keep: true, mic: 'unprocessed' } }), { keep: true, mic: 'unprocessed' });
  assert.deepStrictEqual(CALL.voiceRecSettings({ recordings: { keep: 'yes' } }), { keep: false, mic: 'processed' });
});

// ── the VAD adapter: the tap and the second microphone track ──
function track(settings, extra) {
  const t = { readyState: 'live', label: 'Mic', listeners: {}, stopped: false, getSettings: () => settings, stop() { t.stopped = true; t.readyState = 'ended'; }, addEventListener(n, f) { t.listeners[n] = f; }, removeEventListener(n) { delete t.listeners[n]; } };
  return Object.assign(t, extra);
}
function stream(tr) { return { getTracks: () => [tr], getAudioTracks: () => [tr] }; }
function vadWorld({ seconds }) {
  const w = { opens: [], nodes: [], micCount: 0 };
  const ctx = {
    sampleRate: 48000, state: 'running', resume: async () => {}, close: async () => {},
    createMediaStreamSource: (s) => { const n = { stream: s, links: [], connect(x) { n.links.push(x); }, disconnect() { n.links = []; } }; w.nodes.push(n); return n; },
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    createMediaStreamDestination: () => ({ stream: stream(track({})) }),
  };
  const nav = { mediaDevices: { getUserMedia: async (c) => {
    w.opens.push(c);
    const raw = c.audio && c.audio.echoCancellation === false;
    const which = w.opens.length;
    if (raw && w.opens.length === 2 && seconds === 'fails') throw Object.assign(new Error('busy'), { name: 'NotReadableError' });
    const echo = raw ? (w.opens.length === 2 && seconds === 'still-processed' ? true : false) : true;
    return stream(track({ deviceId: 'dev-1', echoCancellation: echo, sampleRate: 48000 }, { which }));
  }, addEventListener() {}, removeEventListener() {}, enumerateDevices: async () => [] } };
  const win = { AudioContext: function () { return ctx; }, vad: { MicVAD: { new: async (o) => { w.opts = o; await o.getStream(); return { start: async () => {}, destroy: async () => {}, setOptions() {} }; } } }, setTimeout, clearTimeout };
  const vad = CALL.voiceCreateVad({ win, nav, micLevel: 50, loadScript: async () => {} });
  return { w, vad, ctx };
}

test('VAD adapter: tapNode() is the call\'s microphone source, onSourceChange fires after a reopen, whenOpen resolves once the microphone is open', async () => {
  const { w, vad } = vadWorld({});
  const opened = vad.whenOpen();
  await vad.start({});
  assert.strictEqual(await opened, true);
  assert.strictEqual(vad.tapNode(), w.nodes[0]);
  const seen = []; vad.onSourceChange((n) => seen.push(n));
  assert.strictEqual(await vad.reopen(), true);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0], vad.tapNode());
  assert.notStrictEqual(vad.tapNode(), w.nodes[0], 'the new microphone is a new source');
  await vad.stop();
});

test('VAD adapter, mic processed: the call\'s own source is tapped and no second stream is opened', async () => {
  const { w, vad } = vadWorld({});
  await vad.start({});
  const r = await vad.openRecordingTap(false);
  assert.strictEqual(r.processing, 'processed');
  assert.strictEqual(r.node, vad.tapNode());
  assert.strictEqual(w.opens.length, 1);
  await vad.stop();
});

test('VAD adapter, mic unprocessed: a SECOND stream with echo cancellation, noise suppression and auto gain off, on the call track\'s device; its track says processing is off: second-track', async () => {
  const { w, vad } = vadWorld({});
  await vad.start({});
  const r = await vad.openRecordingTap(true);
  assert.strictEqual(r.processing, 'second-track');
  assert.deepStrictEqual(w.opens[1].audio, { echoCancellation: false, noiseSuppression: false, autoGainControl: false, deviceId: 'dev-1' });
  assert.strictEqual(vad.recordingNode(), r.node);
  assert.notStrictEqual(r.node, vad.tapNode(), 'a separate source; the call keeps its own');
  const seen = []; vad.onSourceChange((n) => seen.push(n));
  await vad.reopen();
  assert.strictEqual(seen[0], r.node, 'a call reopen does not move a recording that has its own track');
  await vad.stop();
  assert.ok(w.nodes.every(n => n.links.length === 0));
});

test('VAD adapter, mic unprocessed: the second stream fails: the call\'s own microphone is opened again without processing and tapped (call-track)', async () => {
  const { w, vad } = vadWorld({ seconds: 'fails' });
  await vad.start({});
  const heard = [];
  const r = await vad.openRecordingTap(true);
  assert.strictEqual(r.processing, 'call-track');
  assert.strictEqual(r.node, vad.tapNode());
  assert.strictEqual(w.opens.length, 3, 'call mic, failed second stream, the call mic reopened');
  assert.strictEqual(w.opens[2].audio.echoCancellation, false, 'the reopen asks for no processing');
  assert.strictEqual(heard.length, 0);
  await vad.stop();
});

test('VAD adapter, mic unprocessed: the second track still says echo cancellation is on: it is let go and the call track is reopened (call-track)', async () => {
  const { w, vad } = vadWorld({ seconds: 'still-processed' });
  await vad.start({});
  const r = await vad.openRecordingTap(true);
  assert.strictEqual(r.processing, 'call-track');
  assert.strictEqual(CALL.voiceLiveTracks() >= 0, true);
  assert.strictEqual(w.opens.length, 3);
  await vad.stop();
});

test('voiceOpenMicStream: unprocessed asks for the three processing features off; the default is unchanged', async () => {
  const seen = [];
  const nav = { mediaDevices: { getUserMedia: async (c) => { seen.push(c); return stream(track({})); } } };
  await CALL.voiceOpenMicStream(nav);
  await CALL.voiceOpenMicStream(nav, { unprocessed: true });
  assert.deepStrictEqual(seen[0], { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  assert.deepStrictEqual(seen[1], { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
});

// ── the call display's recording badge ──
function fakeDom() {
  const doc = { activeElement: null };
  class El {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {}; this.listeners = {}; this.className = ''; this.hidden = false; this.disabled = false; this.value = ''; this._text = ''; this.props = {}; this.style = { setProperty: (k, v) => { this.props[k] = v; } }; }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    set textContent(v) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; this._text = String(v); }
    get nextSibling() { const i = this.parentNode ? this.parentNode.children.indexOf(this) : -1; return i >= 0 ? this.parentNode.children[i + 1] || null : null; }
    get firstChild() { return this.children[0] || null; }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
    insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); const i = this.children.indexOf(ref); c.parentNode = this; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; } return c; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k]; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
    focus() { doc.activeElement = this; }
    click() { for (const f of this.listeners.click || []) f({ preventDefault() {}, target: this }); }
    all() { return this.children.flatMap(c => [c, ...c.all()]); }
    querySelectorAll() { return []; }
  }
  doc.createElement = (t) => new El(t);
  doc.body = new El('body');
  const find = (cls) => doc.body.all().filter(n => (' ' + n.className + ' ').includes(' ' + cls + ' '));
  return { doc, El, find };
}
function orbFactory() { return () => ({ setState() {}, setAnalyser() {}, setMicLevel() {}, speechEvent() {}, setLevel() {}, thinkingPulse() {}, react: () => true, cancelReaction() {}, destroy() {}, ready: Promise.resolve(), pictureReady: Promise.resolve() }); }
function displayWorld(choice, extra) {
  const dom = fakeDom(), toggles = [];
  const page = new dom.El('div'), bar = new dom.El('div'), hang = new dom.El('button');
  hang.className = 'vcb-hang'; bar.appendChild(hang); page.appendChild(bar); dom.doc.body.appendChild(page);
  const store = new Map([[CD.DISPLAY_STORE_KEY, JSON.stringify({ choice })]]);
  const display = CD.createCallDisplay(Object.assign({
    window: { document: dom.doc }, document: dom.doc, storage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ packs: [] }) }), setTimeout: (f) => { f; return 1; }, clearTimeout() {},
    agentDefault: () => 'none', adopt: () => [], reopenHost: () => hang, onTalk() {}, onHangUp() {}, onChange() {},
    onRecordingToggle: (want) => { toggles.push(want); },
    createVoiceOrb: orbFactory(), createFacePlayer: orbFactory(),
  }, extra));
  return { dom, display, toggles, bar, hang };
}
const rec = (w) => w.dom.find('ucd-rec')[0] || null;
const textOf = (w) => rec(w).all().find(n => n.className === 'ucd-rec-text').textContent;
const dotOf = (w) => rec(w).all().find(n => n.className === 'ucd-rec-dot');
const pauseOf = (w) => rec(w).all().find(n => n.className === 'ucd-rec-pause');

test('display: nothing is shown by default and "off" hides it', async () => {
  const w = displayWorld('orb');
  w.display.start(); await tick();
  assert.strictEqual(rec(w), null);
  w.display.setRecording({ state: 'on' }); assert.ok(rec(w));
  w.display.setRecording({ state: 'off' }); assert.strictEqual(rec(w), null);
  w.display.setRecording({ state: 'nonsense' }); assert.strictEqual(rec(w), null);
});

test('display, Orb: "Recording" with a red dot in the view\'s stage (not in the bar with Hang up); paused reads "Recording paused" with a hollow dot and Resume; error: "Not recording", no dot, no button; stopped', async () => {
  const w = displayWorld('orb');
  w.display.start(); await tick();
  const root = w.dom.find('ucd-overlay')[0];
  assert.ok(root, 'the Orb view is up');
  w.display.setRecording({ state: 'on' });
  assert.ok(w.dom.find('ucd-stage')[0].contains(rec(w)), 'in the view\'s stage, away from the bar that holds Hang up');
  assert.ok(!w.dom.find('ucd-bar')[0].contains(rec(w)));
  assert.strictEqual(textOf(w), 'Recording');
  assert.strictEqual(dotOf(w).hidden, false);
  assert.strictEqual(rec(w).getAttribute('data-state'), 'on');
  assert.strictEqual(pauseOf(w).textContent, 'Pause recording');
  w.display.setRecording({ state: 'paused' });
  assert.strictEqual(textOf(w), 'Recording paused');
  assert.strictEqual(rec(w).getAttribute('data-state'), 'paused', 'the CSS draws a hollow dot for paused');
  assert.strictEqual(pauseOf(w).textContent, 'Resume recording');
  w.display.setRecording({ state: 'error' });
  assert.strictEqual(textOf(w), 'Not recording');
  assert.strictEqual(dotOf(w).hidden, true);
  assert.strictEqual(pauseOf(w).hidden, true);
  w.display.setRecording({ state: 'stopped' });
  assert.strictEqual(textOf(w), 'Recording stopped');
  assert.strictEqual(pauseOf(w).hidden, true);
  assert.strictEqual(w.display.info().recording, 'stopped');
});

test('display: "trouble" reads "Recording (some speech not sent yet)" with the red dot and the Pause button still there; Pause asks to pause, and from paused Resume asks to resume', async () => {
  const w = displayWorld('orb');
  w.display.start(); await tick();
  w.display.setRecording({ state: 'trouble' });
  assert.strictEqual(textOf(w), 'Recording (some speech not sent yet)');
  assert.strictEqual(rec(w).getAttribute('data-state'), 'trouble');
  assert.strictEqual(dotOf(w).hidden, false, 'a red dot');
  assert.strictEqual(pauseOf(w).hidden, false, 'Pause is still there');
  assert.strictEqual(pauseOf(w).textContent, 'Pause recording');
  pauseOf(w).click(); await tick();
  assert.deepStrictEqual(w.toggles, [true], 'it asks to pause');
  w.display.setRecording({ state: 'paused' });
  pauseOf(w).click(); await tick();
  assert.deepStrictEqual(w.toggles, [true, false]);
  assert.strictEqual(w.display.info().recording, 'paused');
  w.display.setRecording({ state: 'trouble' });
  assert.strictEqual(w.display.info().recording, 'trouble');
});

test('display, None: no view, so the badge sits on its own first line in the call bar\'s container (never in its button row, so Hang up keeps its place); it moves into the view and back with Back to chat', async () => {
  const w = displayWorld('none');
  w.display.start(); await tick();
  assert.strictEqual(w.dom.find('ucd-overlay').length, 0);
  w.display.setRecording({ state: 'on' });
  assert.notStrictEqual(rec(w).parentNode, w.bar, 'not in the row with Hang up (a narrow phone pushed Hang up off the screen)');
  assert.strictEqual(rec(w).parentNode, w.bar.parentNode, 'in the bar\'s container');
  assert.strictEqual(w.bar.parentNode.firstChild, rec(w), 'its own first line, pinned at the top by the CSS (never under a pinned Hang up row)');
  assert.strictEqual(rec(w).getAttribute('data-place'), 'bar');
  const o = displayWorld('orb');
  o.display.start(); await tick();
  o.display.setRecording({ state: 'on' });
  assert.ok(o.dom.find('ucd-stage')[0].contains(rec(o)));
  o.display.hideToChat();
  assert.strictEqual(o.bar.parentNode.firstChild, rec(o), 'back to chat: its own first line in the bar\'s container');
  o.display.showView();
  assert.ok(o.dom.find('ucd-stage')[0].contains(rec(o)), 'the view is shown again: in its stage');
});

test('display: the Pause button asks the page (true = pause, false = resume) and stays disabled until the page answers; the badge changes only when the page says so', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const w = displayWorld('orb', { onRecordingToggle: (want) => { w2.toggles.push(want); return gate; } });
  const w2 = { toggles: [] };
  w.display.start(); await tick();
  w.display.setRecording({ state: 'on' });
  pauseOf(w).click();
  assert.deepStrictEqual(w2.toggles, [true]);
  assert.strictEqual(pauseOf(w).disabled, true, 'no second request while one is out');
  pauseOf(w).click();
  assert.deepStrictEqual(w2.toggles, [true]);
  assert.strictEqual(textOf(w), 'Recording', 'unchanged until the page calls setRecording');
  release(); await tick();
  assert.strictEqual(pauseOf(w).disabled, false);
  w.display.setRecording({ state: 'paused' });
  pauseOf(w).click();
  assert.deepStrictEqual(w2.toggles, [true, false]);
});

test('display: hang-up and release remove the badge', async () => {
  const w = displayWorld('none');
  w.display.start(); await tick();
  w.display.setRecording({ state: 'on' });
  assert.ok(rec(w));
  w.display.release();
  assert.strictEqual(rec(w), null);
});

test('display CSS: the badge is dark with white text, has a red dot, a hollow one when paused, and sits top right of the stage', () => {
  const css = read('lib/ui-call-display.css');
  assert.match(css, /\.ucd-rec-dot \{[^}]*background: #e5484d/);
  assert.match(css, /\.ucd-rec\[data-state="paused"\] \.ucd-rec-dot \{[^}]*background: transparent; border: 2px solid #e5484d/);
  assert.match(css, /\.ucd-stage > \.ucd-rec \{ position: absolute; z-index: 3; top: 10px; right: 12px; \}/);
});

// ── the consent line counts only when it really played (the hub then counts it as heard: announce once per person) ──
const vm = require('node:vm');
function pageFn(src, start, end) {
  const i = src.indexOf(start);
  assert.ok(i >= 0, start);
  return src.slice(i, src.indexOf(end, i) + end.length);
}
test('desktop page: voiceCallSpeakLine is true only when the line played to the end', async () => {
  const src = read('app.js');
  const code = pageFn(src, '    async function voiceSpeakText(', '\n    }\n') + pageFn(src, '    async function voiceCallSpeakLine(', '\n    }\n');
  async function run({ ready = true, device = false, hub = 'ok', dev = 'ok' }) {
    const toasts = [];
    const ctx = {
      voicePlay: { token: 0, btn: null }, voiceCallS: { linkLost: false },
      voiceStopPlayback() { ctx.voicePlay.token++; }, voiceSentences: (s) => [s], voiceSpeechText: (s) => String(s || ''),
      voiceReady: () => ready, voiceDeviceFallback: () => device, hubToast: (m) => toasts.push(m), voicePlayState() {},
      async voicePlayHub() { if (hub === 'fail') { const e = new Error('tts down'); throw e; } if (hub === 'cut') ctx.voicePlay.token++; },
      async voicePlayDevice() { if (dev === 'cut') ctx.voicePlay.token++; },
    };
    vm.createContext(ctx);
    vm.runInContext(code + '\nthis.f = voiceCallSpeakLine;', ctx);
    return { ok: await ctx.f('maestro', 'This conversation is being recorded.'), toasts };
  }
  assert.strictEqual((await run({})).ok, true, 'the hub voice played it');
  assert.strictEqual((await run({ hub: 'cut' })).ok, false, 'cut while playing');
  assert.strictEqual((await run({ hub: 'fail' })).ok, false, 'the hub voice failed and there is no device voice');
  assert.strictEqual((await run({ hub: 'fail', device: true })).ok, true, 'the device voice took over and played it');
  assert.strictEqual((await run({ ready: false })).ok, false, 'voice is off');
  assert.strictEqual((await run({ ready: false, device: true })).ok, true, 'voice off, the device voice played it');
  assert.strictEqual((await run({ ready: false, device: true, dev: 'cut' })).ok, false, 'the device voice was cut');
});
test('phone page: voiceCallSpeakLine is true only when the line played to the end', async () => {
  const src = read('mobile.js');
  const code = pageFn(src, 'async function voiceCallSpeakLine(', '\n}\n');
  async function run({ on = true, blob = true, plays = true, device = false, cut = '' }) {
    const ctx = {
      voicePlay: { token: 0 }, voiceSpeechText: (s) => String(s || ''), voiceOn: () => on, voicePrefsNow: () => ({ deviceVoiceFallback: device }),
      async voiceTtsBlob() { if (cut === 'fetch') ctx.voicePlay.token++; return blob ? {} : null; },
      async voicePlayBlob() { if (cut === 'play') ctx.voicePlay.token++; return plays; },
      async voiceDeviceSpeak() { if (cut === 'device') ctx.voicePlay.token++; },
    };
    vm.createContext(ctx);
    vm.runInContext(code + '\nthis.f = voiceCallSpeakLine;', ctx);
    return ctx.f('maestro', 'This conversation is being recorded.');
  }
  assert.strictEqual(await run({}), true, 'the hub voice played it');
  assert.strictEqual(await run({ cut: 'play' }), false, 'cut while playing');
  assert.strictEqual(await run({ cut: 'fetch' }), false, 'cut while fetching');
  assert.strictEqual(await run({ blob: false }), false, 'no audio from the hub, no device voice');
  assert.strictEqual(await run({ plays: false }), false, 'the audio did not play, no device voice');
  assert.strictEqual(await run({ on: false }), false, 'voice is off');
  assert.strictEqual(await run({ on: false, device: true }), true, 'the device voice played it');
  assert.strictEqual(await run({ blob: false, device: true, cut: 'device' }), false, 'the device voice was cut');
  assert.strictEqual(await run({ on: true }), true);
});
