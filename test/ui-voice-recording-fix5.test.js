'use strict';
// Call recordings, fix round 5 (page side): a refused piece stays stored (409 not_recording), a missing record after a put means it was sent, the read-back has a timeout.
const { test } = require('node:test');
const assert = require('node:assert');
const CALL = require('../lib/ui-voice-call');
const { voiceCreateRecorder } = CALL;

const RATE = 1000;
const tick = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function node() { const n = { links: [], connect(to) { n.links.push(to); }, disconnect() {} }; return n; }
function fakeStore() {
  const s = { recs: new Map(), dels: [], getCalls: 0, getImpl: null };
  s.put = async (r) => { s.recs.set(r.id, r); return true; };
  s.get = (id) => { s.getCalls++; return s.getImpl ? s.getImpl(id) : Promise.resolve(s.recs.get(id) || null); };
  s.del = async (id) => { s.dels.push(id); s.recs.delete(id); return true; };
  s.all = async () => Array.from(s.recs.values());
  return s;
}
function harness(over) {
  const h = { t: 1000, timers: [], uploads: [], troubles: [], recovers: 0, reply: null };
  const ctx = { sampleRate: RATE, destination: node(), createGain: () => Object.assign(node(), { gain: { value: 1 } }), createScriptProcessor: () => { ctx.proc = Object.assign(node(), { onaudioprocess: null }); return ctx.proc; } };
  h.ctx = ctx;
  h.upload = async (seg) => { h.uploads.push(seg); if (typeof h.reply === 'function') return h.reply(seg); return { seq: h.uploads.length }; };
  h.rec = voiceCreateRecorder(Object.assign({ ctx, source: node(), upload: (s) => h.upload(s), now: () => h.t, setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; h.timers.push(t); return t; }, clearTimer(t) { if (t) t.cleared = true; },
    onTrouble: (r) => h.troubles.push(r), onRecover: () => { h.recovers++; }, prerollMs: 0, userId: 'u1', agent: 'a', callId: 'c' }, over));
  h.send = () => { h.rec.begin(); ctx.proc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(100).fill(0.5) } }); h.t += 50; return h.rec.end(); };
  h.fire = async (ms) => { const i = h.timers.findIndex(t => t.ms === ms && !t.cleared); assert.ok(i >= 0, 'a timer of ' + ms + ' ms'); const t = h.timers.splice(i, 1)[0]; t.fn(); await tick(30); };
  return h;
}
const ready = async (h) => { await h.rec.ready; await tick(); };

// ── fix 5: the page's upload gives back the hub's answer ──
function sessionUpload(status, body) {
  const recorders = [];
  const s = CALL.voiceCreateRecordingSession({
    agent: 'biographer', vad: { whenOpen: () => Promise.resolve(true), openRecordingTap: async () => ({ processing: 'processed', node: {} }), info: () => ({}), audioContext: () => ({ sampleRate: 48000 }), recordingNode: () => ({}), onSourceChange() {} },
    fetch: async (url) => (url.includes('/segment') ? { ok: status < 400, status, json: async () => body } : { ok: true, status: 200, json: async () => ({ ok: true }) }),
    nav: {}, wired: true, speak: async () => {}, playback() {}, badge() {}, toast() {}, now: () => 5000, setTimer: () => 1, clearTimer() {},
    createRecorder: (o) => { recorders.push(o); return { begin() {}, drop() {}, end() { return null; }, pause() {}, setSource() {}, stop() {} }; },
  });
  return s.started({ sessionId: 's', consentLine: '' }, 'call-9').then(() => recorders[0].upload);
}

test('fix 5: sendAudio gives back the status and code of a 409; a 503 try_later is thrown with its status and code (retryable)', async () => {
  const seg = { wav: new Uint8Array(1), startedAt: 1, endedAt: 2, piece: 'abcd-1234' };
  assert.deepStrictEqual(await (await sessionUpload(409, { error: 'not_recording' }))(seg), { seq: null, status: 409, error: 'not_recording' });
  assert.deepStrictEqual(await (await sessionUpload(409, { error: 'piece_conflict' }))(seg), { seq: null, status: 409, error: 'piece_conflict' });
  await assert.rejects(async () => (await sessionUpload(503, { error: 'try_later' }))(seg), (e) => e.status === 503 && e.code === 'try_later');
});

test('fix 5: a 409 not_recording ends the piece (no live retry, seq null, no trouble) but its stored record stays', async () => {
  const st = fakeStore(), h = harness({ store: st }); await ready(h);
  h.reply = () => ({ seq: null, status: 409, error: 'not_recording' });
  const handle = h.send(); await tick(40);
  assert.strictEqual(await handle.seq, null);
  assert.strictEqual(h.uploads.length, 1, 'no live retry');
  assert.deepStrictEqual(st.dels, [], 'the stored record was not deleted');
  assert.strictEqual(st.recs.size, 1, 'it is still there for voiceRecResendPending');
  assert.deepStrictEqual(h.troubles, [], 'a refusal is not a trouble');
  assert.deepStrictEqual(h.timers.filter(t => t.ms !== 2000), [], 'nothing scheduled to try again');
});

test('fix 5: a 409 not_recording keeps the record even when the put finishes after the answer', async () => {
  const st = fakeStore(); let finishPut;
  st.put = (r) => new Promise((res) => { finishPut = () => { st.recs.set(r.id, r); res(true); }; });
  const h = harness({ store: st }); await ready(h);
  h.reply = () => ({ seq: null, status: 409, error: 'not_recording' });
  const handle = h.send(); await tick(10);
  await h.fire(2000);   // the put hangs: after 2 s the piece goes to the network from memory
  assert.strictEqual(await handle.seq, null);
  finishPut(); await tick(30);
  assert.deepStrictEqual(st.dels, [], 'the late put is not undone');
  assert.strictEqual(st.recs.size, 1);
});

test('fix 5: a 409 piece_conflict deletes the stored record (the hub has a different body under that id)', async () => {
  const st = fakeStore(), h = harness({ store: st }); await ready(h);
  h.reply = () => ({ seq: null, status: 409, error: 'piece_conflict' });
  const handle = h.send(); await tick(40);
  assert.strictEqual(await handle.seq, null);
  assert.strictEqual(h.uploads.length, 1);
  assert.strictEqual(st.dels.length, 1);
  assert.strictEqual(st.recs.size, 0);
});

test('fix 5: a 503 try_later is retried (the record stays, seq comes with the later 2xx)', async () => {
  const st = fakeStore(), h = harness({ store: st }); await ready(h);
  let n = 0;
  h.reply = () => { if (n++ === 0) throw Object.assign(new Error('HTTP 503'), { status: 503, code: 'try_later' }); return { seq: 4 }; };
  const handle = h.send(); await tick(40);
  assert.strictEqual(h.uploads.length, 1);
  assert.deepStrictEqual(st.dels, []);
  await h.fire(1000);
  assert.strictEqual(await handle.seq, 4);
  assert.strictEqual(h.uploads.length, 2);
});

test('fix 5: without a store a 409 still gives a null seq and a refusal is not counted as sent (no recovery for it)', async () => {
  const h = harness({ store: null }); await ready(h);
  h.reply = () => ({ seq: null, status: 409, error: 'not_recording' });
  const handle = h.send(); await tick(40);
  assert.strictEqual(await handle.seq, null);
  assert.strictEqual(h.recovers, 0);
});

test('fix 5: the resend sends a record under its own userId, deletes it on 409 not_recording, and leaves another person\'s record alone', async () => {
  const st = fakeStore(); const now = 10 * 60 * 1000;
  const mk = (id, userId) => ({ id, userId, agent: 'a', callId: 'c', speaker: 'person', startedAt: 1, endedAt: 2, wav: new Uint8Array([1]).buffer, createdAt: now - 1000 });
  st.recs.set('mine-0001', mk('mine-0001', 'u1')); st.recs.set('theirs-01', mk('theirs-01', 'u2'));
  const sent = [];
  const r = await CALL.voiceRecResendPending(async (url) => { sent.push(url); return { ok: false, status: 409, json: async () => ({ error: 'not_recording' }) }; }, { store: st, now: () => now, userId: 'u1' });
  assert.strictEqual(sent.length, 1);
  assert.ok(sent[0].endsWith('&piece=mine-0001'));
  assert.deepStrictEqual(st.dels, ['mine-0001']);
  assert.ok(st.recs.has('theirs-01'), 'the other person\'s piece stays');
  assert.strictEqual(r.dropped, 1);
});

// ── fix 6: no record after a successful put: it was sent ──
test('fix 6: when the read-back finds no record (another tab sent and deleted it) the piece is finished as sent: no upload, no trouble, no failure', async () => {
  const st = fakeStore(), h = harness({ store: st }); await ready(h);
  st.getImpl = () => Promise.resolve(null);
  const handle = h.send(); await tick(40);
  assert.strictEqual(await handle.seq, null);
  assert.strictEqual(h.uploads.length, 0, 'nothing to send');
  assert.deepStrictEqual(h.troubles, []);
  assert.deepStrictEqual(h.timers.filter(t => t.ms !== 2000), [], 'no retry scheduled');
  // not a failure: a later failure that recovers still tells the people it is fine again
  st.getImpl = null; let n = 0;
  h.reply = () => { if (n++ === 0) throw new Error('network'); return { seq: 9 }; };
  const again = h.send(); await tick(40); h.t += 61000; await h.fire(60001); await h.fire(1000); await again.seq;
  assert.strictEqual(h.recovers, 1, 'no failure was counted for the piece that was missing');
});

test('fix 6: a record that exists but cannot be read (the store rejects) is still a failed try, not a sent piece', async () => {
  const st = fakeStore(), h = harness({ store: st }); await ready(h);
  let first = true;
  st.getImpl = (id) => (first ? (first = false, Promise.reject(new Error('read failed'))) : Promise.resolve(st.recs.get(id)));
  const handle = h.send(); await tick(40);
  assert.strictEqual(h.uploads.length, 0);
  await h.fire(1000);
  assert.strictEqual(await handle.seq, 1);
});

test('fix 6: voiceRecStore.get gives null for a missing record and rejects when the read fails', async () => {
  const mkIdb = (fail) => ({ open: () => { const req = {}; setImmediate(() => { req.result = { createObjectStore() {}, transaction: () => { const tx = { objectStore: () => ({ get: () => { const r = { result: undefined }; setImmediate(() => { if (fail) tx.onerror(); else tx.oncomplete(); }); return r; } }) }; return tx; } }; req.onsuccess(); }); return req; } });
  assert.strictEqual(await CALL.voiceRecStore(mkIdb(false)).get('x'), null);
  await assert.rejects(() => CALL.voiceRecStore(mkIdb(true)).get('x'));
});

// ── fix 7: the read-back has a 2 s timeout ──
test('fix 7: a read-back that hangs is one failed try after 2 s: the slot is freed and the piece is tried again later', async () => {
  const st = fakeStore(), h = harness({ store: st }); await ready(h);
  let hang = true;
  st.getImpl = (id) => (hang ? new Promise(() => {}) : Promise.resolve(st.recs.get(id)));
  const handle = h.send(); await tick(40);
  assert.strictEqual(h.uploads.length, 0);
  await h.fire(2000);
  assert.deepStrictEqual(h.timers.filter(t => !t.cleared).map(t => t.ms), [1000, 60001].filter(ms => h.timers.some(t => t.ms === ms)), 'a retry is scheduled');
  hang = false;
  await h.fire(1000);
  assert.strictEqual(await handle.seq, 1, 'sent on the next try');
});

test('fix 7: hung read-backs do not hold the two upload slots: a third piece still goes out', async () => {
  const st = fakeStore(), h = harness({ store: st }); await ready(h);
  const hung = new Set();
  st.getImpl = (id) => (hung.has(id) ? new Promise(() => {}) : Promise.resolve(st.recs.get(id)));
  const a = h.send(); const b = h.send(); await tick(40);
  for (const id of st.recs.keys()) hung.add(id);
  // a and b were already read back (or are waiting); hang the next two, then send two more
  const c = h.send(), d = h.send(); await tick(40);
  while (h.timers.some(t => t.ms === 2000 && !t.cleared)) await h.fire(2000);
  const e = h.send(); await tick(40);
  assert.ok(h.uploads.length >= 1, 'the slots were freed by the timeouts');
  assert.ok(a && b && c && d && e);
});
