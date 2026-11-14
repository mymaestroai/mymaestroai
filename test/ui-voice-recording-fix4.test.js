'use strict';
// Call recordings, fix round 4 (page side): the piece id on every try, the badge that clears, a hung or failing IndexedDB, a 401 that keeps the audio.
const { test } = require('node:test');
const assert = require('node:assert');
const CALL = require('../lib/ui-voice-call');
const { voiceCreateRecorder } = CALL;

const RATE = 1000;
const tick = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const PIECE_RE = /^[A-Za-z0-9_-]{8,64}$/;

function node() { const n = { links: [], connect(to) { n.links.push(to); }, disconnect() {} }; return n; }
function harness(over) {
  const h = { t: 1000, timers: [], uploads: [], troubles: [], recovers: 0, failTimes: 0, failWith: null };
  const ctx = { sampleRate: RATE, destination: node(), createGain: () => Object.assign(node(), { gain: { value: 1 } }), createScriptProcessor: () => { ctx.proc = Object.assign(node(), { onaudioprocess: null }); return ctx.proc; } };
  h.ctx = ctx;
  h.upload = async (seg) => { h.uploads.push(seg); if (h.failTimes > 0) { h.failTimes--; throw h.failWith || new Error('network'); } return { seq: h.uploads.length }; };
  h.rec = voiceCreateRecorder(Object.assign({ ctx, source: node(), upload: (s) => h.upload(s), now: () => h.t, setTimer: (fn, ms) => { h.timers.push({ fn, ms }); return h.timers.length; }, clearTimer() {},
    onTrouble: (r) => h.troubles.push(r), onRecover: () => { h.recovers++; }, prerollMs: 0 }, over));
  h.send = () => { h.rec.begin(); ctx.proc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(100).fill(0.5) } }); h.t += 50; return h.rec.end(); };
  h.flush = async () => { for (let round = 0; round < 6; round++) { await tick(30); while (h.timers.length) { const t = h.timers.shift(); t.fn(); await tick(30); } } };
  return h;
}
const ready = async (h) => { await h.rec.ready; await tick(); };
const later = () => new Promise((r) => setImmediate(r));

test('fix 1: the piece id fits the hub rule, and a retried piece carries the same id on every try', async () => {
  const h = harness(); await ready(h);
  h.failTimes = 2;
  const handle = h.send(); await h.flush();
  assert.strictEqual(await handle.seq, 3);
  assert.strictEqual(h.uploads.length, 3);
  const ids = h.uploads.map(s => s.piece);
  assert.ok(PIECE_RE.test(ids[0]), 'id ' + ids[0]);
  assert.deepStrictEqual(ids, [ids[0], ids[0], ids[0]], 'the same piece every try');
  const h2 = harness(); await ready(h2);
  h2.send(); h2.send(); await h2.flush();
  assert.notStrictEqual(h2.uploads[0].piece, h2.uploads[1].piece, 'two pieces, two ids');
  assert.ok(h2.uploads.every(s => PIECE_RE.test(s.piece)));
});

test('fix 1: the stored record is named by the same id that every try carries (so a resend after a reload sends it again)', async () => {
  const put = [];
  const h = harness({ store: { put: async (r) => { put.push(r); return true; }, get: async () => put[0], del: async () => true } }); await ready(h);
  h.failTimes = 1;
  const handle = h.send(); await h.flush(); await handle.seq;
  assert.strictEqual(put.length, 1);
  assert.deepStrictEqual(h.uploads.map(s => s.piece), [put[0].id, put[0].id]);
});

test('fix 1: voiceRecSegmentUrl puts &piece= on the address', () => {
  assert.ok(CALL.voiceRecSegmentUrl('a', 'c', 'person', 0, 1000, 'abcd-1234').endsWith('&piece=abcd-1234'));
  assert.ok(!/piece=/.test(CALL.voiceRecSegmentUrl('a', 'c', 'person', 0, 1000)));
});

test('fix 4: a 401 keeps the audio: the piece is tried again on the normal schedule, and sent when the sign-in is back', async () => {
  const h = harness(); await ready(h);
  const e = new Error('HTTP 401'); e.status = 401;
  h.failTimes = 2; h.failWith = e;
  const handle = h.send(); await tick(40);
  assert.strictEqual(h.uploads.length, 1);
  assert.deepStrictEqual(h.timers.map(t => t.ms).slice(0, 1), [1000], 'a retry is scheduled, as for any other failure');
  await h.flush();
  assert.strictEqual(h.uploads.length, 3, 'tried again until it went through');
  assert.strictEqual(await handle.seq, 3);
  // other 4xx stay final
  const h2 = harness(); await ready(h2);
  const f = new Error('HTTP 400'); f.status = 400; h2.failTimes = 5; h2.failWith = f;
  const hd = h2.send(); await h2.flush();
  assert.strictEqual(h2.uploads.length, 1); assert.strictEqual(await hd.seq, null);
});

test('fix 5: when every piece that failed has been sent, onRecover fires once; the push (onTrouble) was one; a later failure tells again', async () => {
  const h = harness(); await ready(h);
  h.failTimes = 2;
  const handle = h.send(); await tick(40);
  h.t += 61000;   // the piece has been failing for more than a minute
  await h.flush();
  assert.strictEqual(await handle.seq, 3);
  assert.deepStrictEqual(h.troubles, ['upload_failed']);
  assert.strictEqual(h.recovers, 1);
  h.failTimes = 2; h.uploads.length = 0;
  const again = h.send(); await tick(40); h.t += 61000; await h.flush(); await again.seq;
  assert.strictEqual(h.recovers, 2);
});

test('fix 5: no recovery while another piece is still failing, and none after a piece was given up', async () => {
  const h = harness(); await ready(h);
  const gates = [];
  h.upload = (seg) => new Promise((resolve, reject) => { h.uploads.push(seg); gates.push({ resolve, reject }); });
  const a = h.send(); const b = h.send(); await tick(40);
  gates[0].reject(new Error('network')); await tick(40);
  h.t += 61000;
  h.timers.splice(h.timers.findIndex(x => x.ms === 1000), 1)[0].fn(); await tick(40);   // a's retry
  gates[2].reject(new Error('network')); await tick(40);   // a fails again after a minute: trouble
  assert.deepStrictEqual(h.troubles, ['upload_failed']);
  gates[1].resolve({ seq: 1 }); await tick(40);   // b is sent but a is still failing
  assert.strictEqual(h.recovers, 0);
  const e = new Error('HTTP 400'); e.status = 400;
  h.timers.splice(h.timers.findIndex(x => x.ms === 2000), 1)[0].fn(); await tick(40);
  gates[3].reject(e); await tick(40);   // a is refused for good: lost
  assert.strictEqual(await a.seq, null); await b.seq;
  assert.strictEqual(h.recovers, 0, 'a lost piece is not "sent"');
});

test('fix 6: a store that hangs does not hold the upload: after 2 s the piece goes to the network, its copy kept in memory', async () => {
  const h = harness({ store: { put: () => new Promise(() => {}), del: async () => true, get: async () => { throw new Error('unused'); } } }); await ready(h);
  const handle = h.send(); await tick(40);
  assert.strictEqual(h.uploads.length, 0, 'waiting for the store');
  const t = h.timers.find(x => x.ms === 2000); assert.ok(t, 'a 2 s limit');
  t.fn(); await tick(40);
  assert.strictEqual(h.uploads.length, 1);
  assert.ok(h.uploads[0].wav && h.uploads[0].wav.length === 44 + 200, 'the copy in memory was sent');
  assert.strictEqual(await handle.seq, 1);
});

test('fix 6: a store that answers in time is not raced: no upload before it answers, the 2 s timer is cleared', async () => {
  let release, cleared = 0;
  const h = harness({ clearTimer: () => { cleared++; }, store: { put: () => new Promise((r) => { release = r; }), del: async () => true, get: async () => ({ wav: new ArrayBuffer(4) }) } }); await ready(h);
  h.send(); await tick(40);
  assert.strictEqual(h.uploads.length, 0);
  release(true); await tick(40);
  assert.strictEqual(cleared, 2, 'the put\'s 2 s timer, and the read-back\'s own 2 s timer (round 5)');
  assert.strictEqual(h.uploads.length, 1);
});

function fakeStore(over) {
  const data = new Map(), s = { data, gets: 0, dels: [], getOk: true };
  s.put = async (r) => { data.set(r.id, r); return true; };
  s.del = async (id) => { s.dels.push(id); data.delete(id); return true; };
  s.get = async (id) => { s.gets++; if (!s.getOk) throw new Error('read failed'); return data.get(id) || null; };   // round 5: an unreadable store rejects; a missing record is null
  return Object.assign(s, over);
}

test('fix 7: once the put succeeded the WAV is dropped from memory and read back from the store for each try', async () => {
  const st = fakeStore();
  const h = harness({ store: st }); await ready(h);
  h.failTimes = 2;
  const handle = h.send(); await h.flush();
  assert.strictEqual(await handle.seq, 3);
  assert.strictEqual(st.gets, 3, 'read back at every try, the first one included');
  for (const seg of h.uploads) { assert.ok(seg.wav instanceof Uint8Array && seg.wav.length === 44 + 200, 'the stored WAV was uploaded'); assert.ok(PIECE_RE.test(seg.piece)); }
  assert.deepStrictEqual(st.dels.length, 1, 'deleted once the hub has it');
});

test('fix 7: a read-back that fails cannot be sent: the piece stays in the store, counts as failing, and goes once it can be read', async () => {
  const st = fakeStore({ getOk: false });
  const h = harness({ store: st }); await ready(h);
  const handle = h.send(); await tick(60);
  assert.strictEqual(h.uploads.length, 0, 'nothing to send');
  assert.strictEqual(st.data.size, 1, 'still in the store'); assert.deepStrictEqual(st.dels, []);
  assert.ok(h.timers.some(t => t.ms === 1000), 'tried again later');
  h.t += 61000;
  await tick(40); h.timers.splice(h.timers.findIndex(x => x.ms === 1000), 1)[0].fn(); await tick(60);   // the retry: still unreadable after a minute
  assert.deepStrictEqual(h.troubles, ['upload_failed'], 'it counts as failing');
  st.getOk = true;
  await h.flush();
  assert.strictEqual(await handle.seq, 1);
  assert.strictEqual(h.recovers, 1);
});

test('fix 7: a piece whose put failed keeps its WAV in memory and never reads the store', async () => {
  const st = fakeStore({ put: async () => false });
  const h = harness({ store: st }); await ready(h);
  h.failTimes = 1;
  const handle = h.send(); await h.flush();
  assert.strictEqual(await handle.seq, 2);
  assert.strictEqual(st.gets, 0);
  assert.ok(h.uploads.every(s => s.wav && s.wav.length === 44 + 200));
  const thrown = fakeStore({ put: async () => { throw new Error('closed'); } });
  const h2 = harness({ store: thrown }); await ready(h2);
  assert.strictEqual(await h2.send().seq, 1); assert.strictEqual(thrown.gets, 0);
});

test('fix 7: a put that finishes after the piece was already sent leaves nothing in the store', async () => {
  let release; const st = fakeStore({ put: (r) => new Promise((res) => { release = () => { st.data.set(r.id, r); res(true); }; }) });
  const h = harness({ store: st }); await ready(h);
  const handle = h.send(); await tick(40);
  h.timers.find(x => x.ms === 2000).fn(); await tick(40);
  assert.strictEqual(await handle.seq, 1);
  release(); await tick(40); await later();
  assert.strictEqual(st.data.size, 0);
});

// ── the session ──
function session(over) {
  const t = { posts: [], badges: [], recorders: [] };
  t.fetch = async (url, init) => { t.posts.push({ url, init }); const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : {}; return { ok: true, status: 200, json: async () => ({ ok: true, seq: 3, paused: body.paused }) }; };
  t.vad = { whenOpen: () => Promise.resolve(true), audioContext: () => ({ sampleRate: 48000 }), recordingNode: () => ({}), onSourceChange() {}, info: () => ({}), openRecordingTap: async () => null };
  t.createRecorder = (o) => { const r = { o, begin() {}, drop() {}, end() { return null; }, pause() {}, setSource() {}, stop() {} }; t.recorders.push(r); return r; };
  t.s = CALL.voiceCreateRecordingSession(Object.assign({ agent: 'biographer', userId: 'u1', vad: t.vad, fetch: t.fetch, nav: {}, wired: true, speak: async () => {}, badge: (s) => t.badges.push(s), toast() {}, now: () => 5000, setTimer: () => 1, clearTimer() {}, createRecorder: t.createRecorder }, over));
  return t;
}
const posted = (t, part) => t.posts.filter(p => p.url.includes(part));

test('fix 3: the session hands the recorder the signed-in user\'s id', async () => {
  const t = session();
  await t.s.started({ sessionId: 's', consentLine: '' }, 'c1');
  assert.strictEqual(t.recorders[0].o.userId, 'u1');
});

test('fix 1: the session\'s upload sends the segment\'s piece id; a reply sentence has an id of its own', async () => {
  const t = session();
  await t.s.started({ sessionId: 's', consentLine: '', keepReplies: true }, 'c1');
  await t.recorders[0].o.upload({ wav: new Uint8Array(4), startedAt: 1000, endedAt: 2000, piece: 'abcd1234-x' });
  assert.ok(posted(t, '/segment')[0].url.endsWith('&piece=abcd1234-x'));
  const wav = new Uint8Array(44); const dv = new DataView(wav.buffer); dv.setUint32(28, 2000, true); dv.setUint32(40, 2000, true);
  t.s.replyAudio(wav.buffer); await tick(40);
  const url = posted(t, '/segment')[1].url;
  assert.ok(PIECE_RE.test(decodeURIComponent(url.split('&piece=')[1])), url);
});

test('fix 4: a 401 from the hub carries its status, so the recorder keeps the piece', async () => {
  const t = session({ fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  await t.s.started({ sessionId: 's', consentLine: '' }, 'c1');
  await assert.rejects(() => t.recorders[0].o.upload({ wav: new Uint8Array(4), startedAt: 1, endedAt: 2, piece: 'abcd1234' }), (e) => e.status === 401);
});

test('fix 5: the badge goes back from trouble to on when the recorder says every piece was sent; the hub is told of the trouble once only', async () => {
  const t = session();
  await t.s.started({ sessionId: 's', consentLine: '' }, 'c1');
  const o = t.recorders[0].o;
  o.onTrouble('upload_failed'); o.onRecover();
  assert.deepStrictEqual(t.badges, ['on', 'trouble', 'on']);
  assert.strictEqual(t.s.state, 'on');
  assert.strictEqual(posted(t, '/trouble').length, 1);
  o.onTrouble('upload_failed');   // trouble again later: shown again, not pushed again
  assert.deepStrictEqual(t.badges, ['on', 'trouble', 'on', 'trouble']);
  assert.strictEqual(posted(t, '/trouble').length, 1);
});

test('fix 5: recovery while paused keeps the badge paused, and Resume then shows on', async () => {
  const t = session();
  await t.s.started({ sessionId: 's', consentLine: '' }, 'c1');
  const o = t.recorders[0].o;
  o.onTrouble('upload_failed');
  await t.s.togglePause(true);
  o.onRecover();
  assert.deepStrictEqual(t.badges, ['on', 'trouble', 'paused']);
  await t.s.togglePause(false);
  assert.deepStrictEqual(t.badges, ['on', 'trouble', 'paused', 'on']);
});

test('fix 5: a stopped recording is not brought back by a recovery', async () => {
  const t = session({ createRecorder: (o) => { const r = { o, ready: Promise.resolve(false), begin() {}, drop() {}, end() { return null; }, pause() {}, setSource() {}, stop() {} }; t.recorders.push(r); return r; } });
  await t.s.started({ sessionId: 's', consentLine: '' }, 'c1'); await tick(40);
  t.recorders[0].o.onRecover();
  assert.strictEqual(t.s.state, 'stopped');
});

// ── the pages ──
const fs = require('node:fs'), path = require('node:path');
for (const [name, file] of [['desktop', 'app.js'], ['phone', 'mobile.js']]) {
  test(`fix 3: ${name} page gives the session and every resend the signed-in user's id`, () => {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const resends = src.split('voiceRecResendPending(').slice(1).filter(s => /^\(u, i\) =>/.test(s));
    assert.ok(resends.length >= 2, 'the sign-in resend and the call-start resend');
    for (const s of resends) assert.match(s.slice(0, 260), /userId: /, 'each call passes { userId }');
    assert.match(src, /voiceCreateRecordingSession\(\{ agent, userId: /);
  });
}
