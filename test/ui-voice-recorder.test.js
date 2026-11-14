'use strict';
// lib/ui-voice-call.js voiceCreateRecorder: the recording of a recorded call. A fake AudioContext (the ScriptProcessor path, fed by hand) and fake timers.
const { test } = require('node:test');
const assert = require('node:assert');
const { voiceCreateRecorder } = require('../lib/ui-voice-call');

const RATE = 1000;   // a small rate keeps the arithmetic readable: 600 ms of preroll = 600 samples
const tick = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function node(name) {
  const n = { name, links: [], connect(to) { n.links.push(to); }, disconnect(to) { n.links = to ? n.links.filter(x => x !== to) : []; n.disconnected = (n.disconnected || 0) + 1; } };
  return n;
}
function fakeCtx(rate = RATE) {
  const ctx = { sampleRate: rate, destination: node('destination'), nodes: [] };
  ctx.createGain = () => { const g = node('gain'); g.gain = { value: 1 }; ctx.nodes.push(g); return g; };
  ctx.createScriptProcessor = (size, i, o) => { const p = node('processor'); p.size = size; p.inputs = i; p.outputs = o; p.onaudioprocess = null; ctx.proc = p; return p; };
  return ctx;
}
function harness(over) {
  const h = { t: 1000, timers: [], uploads: [], troubles: [], failWith: null, failTimes: 0, ctx: fakeCtx(), src: node('mic') };
  h.setTimer = (fn, ms) => { h.timers.push({ fn, ms }); return h.timers.length; };
  h.clearTimer = () => {};
  h.upload = async (seg) => {
    h.uploads.push(seg);
    if (h.failTimes > 0) { h.failTimes--; throw h.failWith || new Error('network'); }
    return { seq: h.uploads.length };
  };
  h.rec = voiceCreateRecorder(Object.assign({ ctx: h.ctx, source: h.src, upload: (s) => h.upload(s), now: () => h.t, setTimer: h.setTimer, clearTimer: h.clearTimer, onTrouble: (r) => h.troubles.push(r) }, over));
  h.feed = (n, v = 0.5) => h.ctx.proc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(n).fill(v) } });
  // Run every pending fake timer (a retry wait), letting the promises settle in between.
  h.flush = async () => { for (let round = 0; round < 6; round++) { await tick(30); while (h.timers.length) { const t = h.timers.shift(); t.fn(); await tick(30); } } };
  return h;
}
const ready = async (h) => { await h.rec.ready; await tick(); };
const samplesOf = (wav) => (wav.length - 44) / 2;
const u32 = (wav, at) => new DataView(wav.buffer, wav.byteOffset, wav.byteLength).getUint32(at, true);

test('the tap is a ScriptProcessor (4096) from the source, through a zero-gain node to the destination: processed, silent', async () => {
  const h = harness(); await ready(h);
  assert.strictEqual(h.ctx.proc.size, 4096);
  assert.ok(h.src.links.includes(h.ctx.proc), 'the source feeds the tap');
  const zero = h.ctx.nodes.find(n => n.gain);
  assert.strictEqual(zero.gain.value, 0, 'no sound');
  assert.ok(h.ctx.proc.links.includes(zero) && zero.links.includes(h.ctx.destination), 'processed through zero gain to the destination');
});

test('begin/end gives one WAV at the context rate with the preroll in front (the sample count)', async () => {
  const h = harness(); await ready(h);
  for (let i = 0; i < 10; i++) h.feed(100, 0.1);   // 1000 samples of quiet: the ring keeps the last 600
  h.rec.begin();
  h.feed(100, 0.5); h.feed(200, 0.5);
  h.t += 300;
  const handle = h.rec.end();
  assert.ok(handle && typeof handle.seq.then === 'function');
  assert.strictEqual(await handle.seq, 1);
  assert.strictEqual(h.uploads.length, 1);
  const s = h.uploads[0];
  assert.strictEqual(s.sampleRate, RATE);
  assert.strictEqual(samplesOf(s.wav), 600 + 300, '600 ms of preroll + 300 samples of speech');
  assert.strictEqual(String.fromCharCode(...s.wav.slice(0, 4)), 'RIFF');
  assert.strictEqual(u32(s.wav, 24), RATE, 'the rate in the header is the context rate: never resampled');
  assert.strictEqual(new DataView(s.wav.buffer, s.wav.byteOffset).getInt16(22, true), 1, 'mono');
  const dv = new DataView(s.wav.buffer, s.wav.byteOffset);
  assert.strictEqual(dv.getInt16(44, true), Math.round(0.1 * 32767), 'the preroll comes first');
  assert.strictEqual(dv.getInt16(44 + 700 * 2, true), Math.round(0.5 * 32767), 'then the speech');
  assert.strictEqual(s.endedAt, 1300);
  assert.strictEqual(s.startedAt, 400, 'dated at the start of the preroll (begin at 1000 ms, 600 ms before it)');
});

test('a short preroll: a segment that begins before 600 ms of audio exists has what there is', async () => {
  const h = harness(); await ready(h);
  h.feed(100); h.rec.begin(); h.feed(100);
  await h.rec.end().seq;
  assert.strictEqual(samplesOf(h.uploads[0].wav), 200);
});

test('floats are clamped to [-1, 1] and rounded to 16 bits', async () => {
  const h = harness({ prerollMs: 0 }); await ready(h);
  h.rec.begin();
  h.ctx.proc.onaudioprocess({ inputBuffer: { getChannelData: () => Float32Array.from([2, -2, 0.25, -0.5]) } });
  await h.rec.end().seq;
  const dv = new DataView(h.uploads[0].wav.buffer, h.uploads[0].wav.byteOffset);
  assert.deepStrictEqual([0, 1, 2, 3].map(i => dv.getInt16(44 + i * 2, true)), [32767, -32767, Math.round(0.25 * 32767), Math.round(-0.5 * 32767)]);
});

test('begin is ignored while a segment is open; end with no segment is null', async () => {
  const h = harness(); await ready(h);
  assert.strictEqual(h.rec.end(), null);
  h.feed(100); h.rec.begin(); h.feed(100); h.rec.begin(); h.feed(100);
  await h.rec.end().seq;
  assert.strictEqual(h.uploads.length, 1);
  assert.strictEqual(samplesOf(h.uploads[0].wav), 300, 'the second begin did not restart it');
});

test('drop discards the open segment: nothing is uploaded', async () => {
  const h = harness(); await ready(h);
  h.feed(100); h.rec.begin(); h.feed(300); h.rec.drop();
  assert.strictEqual(h.rec.end(), null);
  await tick();
  assert.strictEqual(h.uploads.length, 0);
});

test('pause SENDS the open segment, then blocks begin; nothing is captured while paused; resume starts clean', async () => {
  const h = harness(); await ready(h);
  h.feed(100); h.rec.begin(); h.feed(100);
  await h.rec.pause(true);
  assert.strictEqual(h.uploads.length, 1, 'what was already said is kept');
  assert.strictEqual(samplesOf(h.uploads[0].wav), 200);
  assert.strictEqual(h.rec.end(), null, 'the segment is closed');
  h.rec.begin(); h.feed(500);
  assert.strictEqual(h.rec.end(), null, 'begin is ignored while paused');
  h.rec.pause(false);
  h.rec.begin(); h.feed(100);
  await h.rec.end().seq;
  assert.strictEqual(h.uploads.length, 2);
  assert.strictEqual(samplesOf(h.uploads[1].wav), 100, 'no preroll from before the pause, nothing from while paused');
});

test('maxMs splits: a segment longer than the limit is cut at maxMs and the rest goes on as a new segment', async () => {
  const h = harness({ maxMs: 1000, prerollMs: 0 }); await ready(h);
  h.rec.begin();
  for (let i = 0; i < 25; i++) h.feed(100);   // 2500 samples = 2.5 s at 1 kHz
  const handle = h.rec.end();
  await handle.seq; await tick();
  assert.deepStrictEqual(h.uploads.map(u => samplesOf(u.wav)), [1000, 1000, 500]);
  assert.strictEqual(h.uploads[0].endedAt - h.uploads[0].startedAt, 1000);
  assert.strictEqual(h.uploads[1].startedAt, h.uploads[0].endedAt, 'the next piece starts where the cut was made');
});

// A fake clock with timers that fire in order as the clock is moved: run(ms) moves it.
function sched(c) {
  const s = { q: [] };
  s.setTimer = (fn, ms) => { s.q.push({ fn, at: c.t + ms }); return s.q.length; };
  s.run = async (ms) => {
    const end = c.t + ms;
    for (;;) {
      s.q.sort((a, b) => a.at - b.at);
      const n = s.q[0];
      if (!n || n.at > end) break;
      s.q.shift(); c.t = Math.max(c.t, n.at); n.fn(); await tick(40);
    }
    c.t = end; await tick(40);
  };
  return s;
}

test('upload: failed pieces are tried again after waits of 1, 2, 4, 8, 15, 30, 60 s, then every 60 s; onTrouble once, at more than 60 s of failing', async () => {
  const c = { t: 0 }, s = sched(c), times = [];
  const h2 = harness({ prerollMs: 0, setTimer: s.setTimer, now: () => c.t });
  h2.upload = async (seg) => { times.push(c.t); h2.uploads.push(seg); throw new Error('network'); };
  await ready(h2);
  h2.rec.begin(); h2.feed(100);
  h2.rec.end();
  await tick(40);
  await s.run(60000);
  assert.deepStrictEqual(times, [0, 1000, 3000, 7000, 15000, 30000, 60000], 'waits 1, 2, 4, 8, 15, 30 s so far');
  assert.deepStrictEqual(h2.troubles, [], 'a minute is not yet more than a minute');
  await s.run(2);
  assert.deepStrictEqual(h2.troubles, ['upload_failed'], 'told while it still retries');
  await s.run(180000);
  assert.deepStrictEqual(times.slice(7), [120000, 180000, 240000], 'then every 60 s');
  assert.deepStrictEqual(h2.troubles, ['upload_failed'], 'once, however long it goes on');
});

test('upload: the piece is given up 55 minutes after its end (seq null, deleted from the store, trouble told); not before', async () => {
  const stored = new Map();
  const store = { put: async (r) => { stored.set(r.id, r); return true; }, del: async (id) => { stored.delete(id); return true; }, all: async () => [...stored.values()] };
  const c = { t: 0 }, s = sched(c);
  const h = harness({ prerollMs: 0, setTimer: s.setTimer, now: () => c.t, store, agent: 'biographer', callId: 'c1' });
  h.upload = async (seg) => { h.uploads.push(seg); throw new Error('network'); };
  await ready(h);
  h.rec.begin(); h.feed(100);
  let done = false;
  const p = h.rec.end().seq.then((v) => { done = true; return v; });
  await tick(40);
  assert.strictEqual(stored.size, 1, 'written before the first try');
  await s.run(54 * 60 * 1000);
  assert.strictEqual(done, false, 'still trying at 54 minutes');
  assert.strictEqual(stored.size, 1);
  await s.run(2 * 60 * 1000);
  assert.strictEqual(await p, null);
  assert.strictEqual(stored.size, 0, 'deleted when given up');
  assert.deepStrictEqual(h.troubles, ['upload_failed']);
  const n = h.uploads.length;
  await s.run(10 * 60 * 1000);
  assert.strictEqual(h.uploads.length, n, 'no more tries');
});

test('upload: a failure that works on the second attempt gives its seq and no trouble; a 4xx (not 408/429) is final at once; 429 and 408 are retried', async () => {
  const h = harness({ prerollMs: 0 }); await ready(h);
  h.failTimes = 1;
  h.rec.begin(); h.feed(100);
  const p = h.rec.end().seq;
  await h.flush();
  assert.strictEqual(await p, 2);
  assert.deepStrictEqual(h.troubles, []);
  h.failTimes = 5; h.failWith = Object.assign(new Error('bad'), { status: 400 });
  const before = h.uploads.length;
  h.rec.begin(); h.feed(100);
  assert.strictEqual(await h.rec.end().seq, null);
  assert.strictEqual(h.uploads.length, before + 1, 'tried once');
  assert.deepStrictEqual(h.troubles, ['upload_failed']);
  for (const status of [429, 408]) {
    const h2 = harness({ prerollMs: 0 }); await ready(h2);
    h2.failTimes = 1; h2.failWith = Object.assign(new Error('slow down'), { status });
    h2.rec.begin(); h2.feed(100);
    const p2 = h2.rec.end().seq;
    await h2.flush();
    assert.strictEqual(await p2, 2, String(status));
  }
});

test('storage: each piece is written to IndexedDB (hub-rec-pending / pieces) BEFORE its first try and deleted when the hub has it; a store that fails never blocks the call', async () => {
  const order = [], stored = new Map();
  const store = { put: async (r) => { order.push('put'); stored.set(r.id, r); return true; }, del: async (id) => { order.push('del'); stored.delete(id); return true; } };
  const h = harness({ prerollMs: 0, store, agent: 'biographer', callId: 'c9' }); await ready(h);
  h.upload = async (seg) => { order.push('upload'); assert.strictEqual(stored.size, 1, 'already stored'); h.uploads.push(seg); return { seq: 4 }; };
  h.rec.begin(); h.feed(100);
  assert.strictEqual(await h.rec.end().seq, 4);
  assert.deepStrictEqual(order, ['put', 'upload', 'del']);
  assert.strictEqual(stored.size, 0);
  const bad = harness({ prerollMs: 0, store: { put: async () => { throw new Error('quota'); }, del: async () => { throw new Error('x'); } } }); await ready(bad);
  bad.rec.begin(); bad.feed(100);
  assert.strictEqual(await bad.rec.end().seq, 1, 'carried on in memory');
  const sync = harness({ prerollMs: 0, store: { put() { throw new Error('closed'); }, del() { throw new Error('closed'); } } }); await ready(sync);
  sync.rec.begin(); sync.feed(100);
  assert.strictEqual(await sync.rec.end().seq, 1);
});

test('storage: the record is { id, userId, agent, callId, speaker, startedAt, endedAt, wav (ArrayBuffer), createdAt }', async () => {
  let rec = null;
  const h = harness({ prerollMs: 0, agent: 'biographer', callId: 'c9', userId: 'u7', store: { put: async (r) => { rec = r; return true; }, del: async () => true } }); await ready(h);
  h.rec.begin(); h.feed(100); h.t += 50;
  await h.rec.end().seq;
  assert.deepStrictEqual(Object.keys(rec).sort(), ['agent', 'callId', 'createdAt', 'endedAt', 'id', 'speaker', 'startedAt', 'userId', 'wav']);
  assert.strictEqual(rec.userId, 'u7');
  assert.ok(rec.wav instanceof ArrayBuffer && rec.wav.byteLength === 44 + 200);
  assert.strictEqual(rec.agent, 'biographer'); assert.strictEqual(rec.callId, 'c9'); assert.strictEqual(rec.speaker, 'person');
  assert.strictEqual(rec.endedAt, 1050); assert.strictEqual(rec.createdAt, 1050);
});

test('pause(true) returns a promise that resolves only when every upload queued or in flight before the pause has finished; flushed() is the same', async () => {
  const h = harness({ prerollMs: 0 }); await ready(h);
  const gates = [];
  h.upload = (seg) => new Promise((resolve) => { h.uploads.push(seg); gates.push(() => resolve({ seq: 1 })); });
  h.rec.begin(); h.feed(50); h.rec.end();
  h.rec.begin(); h.feed(50);   // still open at the pause: sent by it
  let done = false;
  const p = h.rec.pause(true).then(() => { done = true; });
  await tick(40);
  assert.strictEqual(h.uploads.length, 2, 'the open segment was sent by the pause');
  assert.strictEqual(done, false);
  gates.shift()(); await tick(40);
  assert.strictEqual(done, false, 'one is still in flight');
  gates.shift()(); await p;
  assert.strictEqual(done, true);
  await h.rec.flushed();
});

test('cut() sends the open segment and goes on with a new one; nothing while paused or with nothing open', async () => {
  const h = harness({ prerollMs: 0 }); await ready(h);
  h.rec.cut(); await tick();
  assert.strictEqual(h.uploads.length, 0);
  h.rec.begin(); h.feed(100); h.t += 10;
  h.rec.cut(); await tick(40);
  assert.strictEqual(h.uploads.length, 1);
  h.feed(30);
  await h.rec.end().seq;
  assert.deepStrictEqual(h.uploads.map(u => samplesOf(u.wav)), [100, 30], 'the rest goes on as a new piece');
});

test('ready: true when the tap is made, false when it could not be made', async () => {
  const h = harness(); assert.strictEqual(await h.rec.ready, true);
  const ctx = fakeCtx(); ctx.createScriptProcessor = () => { throw new Error('no tap'); };
  const bad = voiceCreateRecorder({ ctx, source: node('mic'), upload: async () => ({ seq: 1 }), now: () => 1, setTimer() {}, clearTimer() {}, store: null });
  assert.strictEqual(await bad.ready, false);
});

test('at most 2 uploads are in flight', async () => {
  const h = harness({ prerollMs: 0 }); await ready(h);
  const gates = []; let live = 0, peak = 0;
  h.upload = (seg) => new Promise((resolve) => { live++; peak = Math.max(peak, live); h.uploads.push(seg); gates.push(() => { live--; resolve({ seq: h.uploads.length }); }); });
  const seqs = [];
  for (let i = 0; i < 4; i++) { h.rec.begin(); h.feed(50); seqs.push(h.rec.end().seq); }
  await tick();
  assert.strictEqual(h.uploads.length, 2);
  gates.shift()(); await tick();
  assert.strictEqual(h.uploads.length, 3);
  while (gates.length) { gates.shift()(); await tick(); }
  await Promise.all(seqs);
  assert.strictEqual(peak, 2);
  assert.strictEqual(h.uploads.length, 4);
});

test('stop disconnects the tap and sends the open segment (the words being said at hang-up are kept); uploads in flight finish', async () => {
  const h = harness({ prerollMs: 0 }); await ready(h);
  const finishers = [];
  const finish = () => { for (const f of finishers.splice(0)) f(); };
  h.upload = (seg) => new Promise((resolve) => { h.uploads.push(seg); finishers.push(() => resolve({ seq: 7 })); });
  h.rec.begin(); h.feed(100);
  const flying = h.rec.end().seq;
  h.rec.begin(); h.feed(100);
  const proc = h.ctx.proc, zero = h.ctx.nodes.find(n => n.gain);
  h.rec.stop();
  assert.ok(!h.src.links.includes(proc), 'the source no longer feeds the tap');
  assert.ok(proc.disconnected && zero.disconnected, 'tap and zero-gain node are disconnected');
  assert.strictEqual(proc.onaudioprocess, null);
  assert.strictEqual(h.rec.end(), null, 'the open segment was handed over at stop');
  h.rec.begin(); assert.strictEqual(h.rec.end(), null, 'nothing after stop');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(h.uploads.length, 2, 'the piece open at stop was uploaded too');
  finish();
  assert.strictEqual(await flying, 7, 'the upload in flight finished');
});

test('stop while paused sends nothing more (the pause already sent the open segment); the default cut is 3 minutes', async () => {
  const h = harness({ prerollMs: 0 }); await ready(h);
  h.rec.begin(); h.feed(100); h.rec.pause(true); h.rec.stop();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(h.uploads.length, 1, 'only the pause\'s piece');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'ui-voice-call.js'), 'utf8');
  assert.ok(src.includes(': 3 * 60 * 1000;'), 'pieces are cut at 3 minutes by default');
});

test('setSource moves the tap to the new source', async () => {
  const h = harness(); await ready(h);
  const next = node('mic2');
  h.rec.setSource(next);
  assert.ok(!h.src.links.includes(h.ctx.proc), 'the old source is let go');
  assert.ok(next.links.includes(h.ctx.proc), 'the new one feeds the tap');
  h.rec.begin(); h.feed(100);
  await h.rec.end().seq;
  assert.strictEqual(h.uploads.length, 1, 'chunks from the new tap are recorded');
});

test('with ctx.audioWorklet the tap is an AudioWorkletNode made from a Blob URL module (no ScriptProcessor)', async () => {
  const ctx = fakeCtx();
  const added = [];
  ctx.audioWorklet = { addModule: async (url) => { added.push(url); } };
  let worklet = null, revoked = [];
  class FakeWorkletNode { constructor(c, name, o) { this.c = c; this.name = name; this.o = o; this.links = []; this.port = {}; worklet = this; } connect(to) { this.links.push(to); } disconnect() { this.gone = true; } }
  class FakeBlob { constructor(parts, o) { this.parts = parts; this.type = o.type; } }
  const URLish = { createObjectURL: (b) => { assert.ok(b instanceof FakeBlob); assert.match(b.parts[0], /registerProcessor\("voice-rec-tap"/); return 'blob:x'; }, revokeObjectURL: (u) => revoked.push(u) };
  const src = node('mic'); const uploads = [];
  const rec = voiceCreateRecorder({ ctx, source: src, AudioWorkletNode: FakeWorkletNode, Blob: FakeBlob, URL: URLish, upload: async (s) => { uploads.push(s); return { seq: 1 }; }, now: () => 5, setTimer() {}, clearTimer() {}, prerollMs: 0 });
  await rec.ready; await tick();
  assert.deepStrictEqual(added, ['blob:x']);
  assert.strictEqual(ctx.proc, undefined, 'no ScriptProcessor');
  assert.strictEqual(worklet.name, 'voice-rec-tap');
  assert.ok(src.links.includes(worklet));
  rec.begin();
  worklet.port.onmessage({ data: new Float32Array(50).fill(0.2) });
  assert.strictEqual(await rec.end().seq, 1);
  assert.strictEqual((uploads[0].wav.length - 44) / 2, 50);
  rec.stop();
  assert.ok(worklet.gone);
  assert.deepStrictEqual(revoked, ['blob:x']);
});
