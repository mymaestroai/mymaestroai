'use strict';
// Tiger Team batch 2, Part S: a member on a voice call is busy (S1), a member runs on its own speed tier (S2), the
// stream journal is written in batches (S3). lib/sdk-chat.js is never required: the functions under test are
// extracted from its source and run in a vm with stubs for everything around them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const live = require('../lib/tiger-team-live');
const recovery = require('../lib/tiger-team-recovery');
const tierLib = require('../lib/tier');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
function slice(from, to) {
  const a = SRC.indexOf(from), b = SRC.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `markers not found: ${from}`);
  return SRC.slice(a, b);
}

// ── S1 / S2: consultTigerTeam in a vm ────────────────────────────────────────
function harness({ onCall = () => false, active = () => false, agents = [] } = {}) {
  const ran = [];
  const frames = [];
  const state = { abortController: new AbortController(), calls: {} };
  const ctx = {
    console, setTimeout, clearTimeout, Promise, Error, Object, String, Math, Date,
    voiceCall: { onCall },
    isAgentActive: active,
    ttLive: live,
    ttRecovery: { abortError: recovery.abortError, sleep: recovery.sleep },
    tierLib,
    getTigerTeamState: () => state,
    checkpointTeam() {},
    ttMustStop: () => false,
    pendingChatRequests: new Set(),
    makeChunk: (c, model, gateway) => ({ gateway }),
    appendConversationLog() {}, writeAutoMemory: () => Promise.resolve(),
    getAgents: async () => agents,
    turnAgentRecord: (name, all) => (all || []).find(a => a && a.name === name) || null,
    streamViaGateway: async (agent, prompt, images, sink, options) => { ran.push({ agent, options, at: Date.now() }); return 'done'; },
  };
  vm.createContext(ctx);
  const agentTierSrc = SRC.match(/^async function agentTier\(.*$/m)[0];
  vm.runInContext(agentTierSrc + '\n' + slice('async function consultTigerTeam(', '/** Why one member could not do its part'), ctx);
  const sink = { writableEnded: false, destroyed: false, write(f) { frames.push(f); return true; } };
  const consult = (opts = {}) => ctx.consultTigerTeam('gemini', 'do it', 'w1', sink, 'lead', { tigerTeamId: 't1', ...opts });
  return { ctx, ran, frames, consult, state };
}

test('S1: a member on a voice call is not run until the call ends', async () => {
  let onCall = true;
  const h = harness({ onCall: () => onCall });
  const p = h.consult({ busyWait: { stepMs: 5, maxMs: 5000 } });
  await new Promise(r => setTimeout(r, 60));
  assert.equal(h.ran.length, 0, 'the member must not run mid-call');
  assert.ok(h.frames.some(f => /on a voice call/.test(f)), 'the card note says the member is on a voice call');
  onCall = false;
  assert.equal(await p, 'done');
  assert.equal(h.ran.length, 1);
});

test('S1: still on a call after the wait: reported unavailable (TT_BUSY), never run', async () => {
  const h = harness({ onCall: () => true });
  await assert.rejects(h.consult({ busyWait: { stepMs: 5, maxMs: 40 } }), e => e.code === 'TT_BUSY');
  assert.equal(h.ran.length, 0);
  assert.equal(h.state.calls.w1.status, 'failed');
});

test('S1: a call registry that throws means "not on a call" (onCallSafe never throws)', async () => {
  const h = harness({ onCall: () => { throw new Error('registry down'); } });
  assert.equal(await h.consult(), 'done');
  assert.equal(h.ctx.onCallSafe('x', { onCall() { throw new Error('boom'); } }), false);
  assert.equal(h.ctx.onCallSafe('x', null), false);
});

test('S1: a member busy in another turn still waits, with the old busy wording', async () => {
  let busy = true;
  const h = harness({ active: () => busy });
  const p = h.consult({ busyWait: { stepMs: 5, maxMs: 5000 } });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(h.ran.length, 0);
  assert.ok(h.frames.some(f => /busy with another conversation/.test(f)));
  busy = false;
  await p;
  assert.equal(h.ran.length, 1);
});

test('S2: the member runs on its own saved tier (economy), standard when none', async () => {
  const h = harness({ agents: [{ name: 'gemini', tier: 'economy' }] });
  await h.consult();
  assert.equal(h.ran[0].options.tier, 'economy');
  const h2 = harness({ agents: [{ name: 'gemini' }] });
  await h2.consult();
  assert.equal(h2.ran[0].options.tier, 'standard');
  const h3 = harness({ agents: [{ name: 'gemini', tier: 'fast' }] });
  await h3.consult();
  assert.equal(h3.ran[0].options.tier, 'fast');
});

// ── S3: batched journal ─────────────────────────────────────────────────────
function rig(t, streamOpts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-b2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new recovery.CheckpointStore(dir);
  const state = { id: 'team-b', status: 'running' };
  const s = new live.TeamStream({ store, getState: id => id === 'team-b' ? state : null, heartbeatMs: 0, log: () => {}, ...streamOpts }).bind('team-b');
  const file = path.join(dir, 'team-b.events.jsonl');
  const onDisk = () => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  return { dir, store, state, s, file, onDisk };
}
const text = n => `data: {"choices":[{"delta":{"content":"word${n} "}}]}\n\n`;
const gw = type => `data: {"gateway":{"type":"${type}"}}\n\n`;
function countFsyncs(fn) {
  const real = fs.fsyncSync; let n = 0;
  fs.fsyncSync = (...a) => { n++; return real.apply(fs, a); };
  try { fn(); } finally { fs.fsyncSync = real; }
  return n;
}
function page() {
  const res = new EventEmitter(); res.writes = [];
  res.write = x => { res.writes.push(x); return true; };
  res.end = () => { res.writableEnded = true; res.emit('close'); };
  return res;
}
const seqsOf = writes => writes.filter(w => w.startsWith('data: {')).map(w => JSON.parse(w.slice(6)).tt_seq);

test('S3: many text frames cost far fewer fsyncs; order and seq are kept on disk', t => {
  const { s, onDisk } = rig(t, { flushMs: 60000 });
  const N = 300;
  const fsyncs = countFsyncs(() => { for (let i = 1; i <= N; i++) s.write(text(i)); s.end(); });
  assert.ok(fsyncs <= 12, `expected batching, got ${fsyncs} fsyncs for ${N} frames`);
  const ev = onDisk();
  assert.equal(ev.length, N);
  assert.deepEqual(ev.map(e => e.seq), Array.from({ length: N }, (_, i) => i + 1));
  assert.deepEqual(ev.map(e => JSON.parse(e.raw.slice(6)).choices[0].delta.content), Array.from({ length: N }, (_, i) => `word${i + 1} `));
});

test('S3: viewers get every frame at once, in order, before anything is on disk', t => {
  const { s, onDisk } = rig(t, { flushMs: 60000 });
  const a = page(); s.attach(a);
  for (let i = 1; i <= 5; i++) s.write(text(i));
  assert.deepEqual(seqsOf(a.writes), [1, 2, 3, 4, 5]);
  assert.equal(onDisk().length, 0, 'text is still buffered');
  s.end();
});

test('S3: every state-change frame flushes at once, with the text before it, in seq order', t => {
  const { s, onDisk } = rig(t, { flushMs: 60000 });
  let expected = 0;
  for (const type of ['tt_dispatch', 'tt_dispatch_complete', 'tt_dispatch_failed', 'tt_complete', 'tt_error', 'tt_interrupted', 'tt_state', 'tt_session', 'tt_user_message', 'tt_interjection']) {
    s.write(text(expected)); s.write(text(expected + 1)); expected += 2;
    assert.equal(onDisk().length, expected - 2, 'text alone stays buffered');
    s.write(gw(type)); expected += 1;
    const seqs = onDisk().map(e => e.seq);
    assert.equal(seqs.length, expected, type + ' flushes immediately');
    assert.deepEqual(seqs, Array.from({ length: expected }, (_, i) => i + 1));
  }
  s.end();
});

test('S3: the buffer flushes by itself after the delay and at 8 KB', async t => {
  const timed = rig(t, { flushMs: 30 });
  timed.s.write(text(1)); timed.s.write(text(2));
  assert.equal(timed.onDisk().length, 0);
  await new Promise(r => setTimeout(r, 120));
  assert.deepEqual(timed.onDisk().map(e => e.seq), [1, 2]);
  timed.s.end();
  const big = rig(t, { flushMs: 60000 });
  const chunk = 'x'.repeat(2000);
  const frame = `data: {"choices":[{"delta":{"content":"${chunk}"}}]}\n\n`;
  for (let i = 0; i < 3; i++) big.s.write(frame);
  assert.equal(big.onDisk().length, 0, 'under 8 KB: still buffered');
  for (let i = 0; i < 3; i++) big.s.write(frame);
  assert.ok(big.onDisk().length >= 4, 'past 8 KB: flushed');
  big.s.end();
});

test('S3: a replay during the unflushed window returns every frame, in order, once', async t => {
  const { s, store, state, onDisk } = rig(t, { flushMs: 60000 });
  s.write(gw('tt_dispatch'));            // on disk
  s.write(text(1)); s.write(text(2));    // buffered
  assert.equal(onDisk().length, 1);
  const b = page();
  assert.equal(await live.replay(store, 'team-b', b, 0, state.eventSeq), 3);
  assert.deepEqual(seqsOf(b.writes), [1, 2, 3]);
  const c = page();
  assert.equal(await live.replay(store, 'team-b', c, 1), 2, 'since is honoured for buffered frames');
  assert.deepEqual(seqsOf(c.writes), [2, 3]);
  s.end();
  assert.deepEqual(onDisk().map(e => e.seq), [1, 2, 3]);
});

test('S3: a flush while a slow page replays loses and repeats nothing', async t => {
  const { s, store } = rig(t, { flushMs: 60000 });
  for (let i = 1; i <= 5; i++) s.write(text(i));   // all buffered
  const slow = page(); let n = 0;
  slow.write = x => { slow.writes.push(x); if (++n === 2) s.flush(); return true; };   // a flush lands mid-replay
  await live.replay(store, 'team-b', slow, 0);
  assert.deepEqual(seqsOf(slow.writes), [1, 2, 3, 4, 5]);
  s.end();
});

test('S3: end() flushes what is buffered; a direct append keeps the file in seq order', t => {
  const { s, store, state, onDisk } = rig(t, { flushMs: 60000 });
  s.write(text(1)); s.write(text(2));
  store.append('team-b', state, { type: 'model_chunk', chunk: {} });   // another writer (the run's own journal)
  assert.deepEqual(onDisk().map(e => e.seq), [1, 2, 3], 'buffered frames went first');
  s.write(text(3));
  assert.equal(onDisk().length, 3);
  s.end();
  assert.deepEqual(onDisk().map(e => e.seq), [1, 2, 3, 4]);
  assert.equal(onDisk()[3].type, 'stream');
});

test('S3: a failing disk is logged once and the run keeps streaming to pages', t => {
  const logs = [];
  const { s, store } = rig(t, { flushMs: 60000, log: m => logs.push(m) });
  const a = page(); s.attach(a);
  store.dir = path.join(store.dir, 'not-a-dir', 'x'); fs.writeFileSync(path.join(path.dirname(path.dirname(store.dir)), 'not-a-dir'), 'file');
  s.write(text(1));
  assert.doesNotThrow(() => s.write(gw('tt_dispatch')));
  s.write(gw('tt_dispatch'));
  assert.equal(logs.length, 1);
  assert.deepEqual(seqsOf(a.writes), [1, 2, 3]);
  s.end();
});
