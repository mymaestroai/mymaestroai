'use strict';
// Batch 2, review round 1: model_chunk records are batched (no fsync per chunk), save() never runs ahead of the journal,
// and the war-room page keeps approval cards addressable (settled cards, redraws).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const recovery = require('../lib/tiger-team-recovery');
const live = require('../lib/tiger-team-live');
const sdkSource = fs.readFileSync(path.join(__dirname, '../lib/sdk-chat.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../tiger-team.html'), 'utf8');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tt-b2r1-'));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const chunk = (text) => ({ choices: [{ delta: { content: text } }] });
function countFsyncs(fn) {
  const real = fs.fsyncSync; let n = 0;
  fs.fsyncSync = (fd) => { n++; return real(fd); };
  try { fn(); } finally { fs.fsyncSync = real; }
  return n;
}
const diskSeqs = (dir, id) => fs.readFileSync(path.join(dir, id + '.events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).seq);

// ── 1. Batching ──
test('model text stays durable before display: sdk-chat appends model_chunk (never buffers it)', () => {
  assert.match(sdkSource, /if \(recoveryCall\) ttStore\.append\(tigerTeamId, activeTigerTeams\.get\(tigerTeamId\), \{\s*type: 'model_chunk'/);
  assert.doesNotMatch(sdkSource, /ttStore\.buffer : ttStore\.append/);
});

test('10 streamed chunks (model_chunk append + display frame each) cost one fsync per chunk (the display frames ride along), all on disk in seq order', async () => {
  const dir = tmp(); const id = 'team-b1';
  const store = new recovery.CheckpointStore(dir);
  const state = { eventSeq: 0 };
  const stream = new live.TeamStream({ store, getState: () => state, heartbeatMs: 0 }).bind(id);
  const n = countFsyncs(() => {
    for (let i = 0; i < 10; i++) {
      store.append(id, state, { type: 'model_chunk', callKey: 'c1', turn: 1, chunk: chunk('t' + i) });   // on disk before the text is shown
      stream.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 't' + i } }] }) + '\n\n');   // buffered
    }
    store.flush(id);
  });
  assert.ok(n <= 12, 'fsyncs: ' + n + ' (one per chunk, one final flush, one for the new file; before batch 2: 20+)');
  const seqs = diskSeqs(dir, id);
  assert.equal(seqs.length, 20);
  assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => i + 1));
  // each model_chunk is on disk the moment append returns
  const s2 = { eventSeq: 0 }; const id2 = 'team-b1b';
  store.append(id2, s2, { type: 'model_chunk', callKey: 'c1', turn: 1, chunk: chunk('x') });
  assert.deepEqual(diskSeqs(dir, id2), [1]);
  stream.flush();
});

test('a failed append throws (the caller shows nothing) and takes the buffered display frames with it, never out of order', () => {
  const dir = tmp(); const id = 'team-b1c';
  const store = new recovery.CheckpointStore(dir);
  const state = { eventSeq: 0 };
  store.buffer(id, state, { type: 'stream', raw: 'data: {}\n\n' });
  const real = fs.writeFileSync;
  fs.writeFileSync = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  try { assert.throws(() => store.append(id, state, { type: 'model_chunk', callKey: 'c1', turn: 1, chunk: chunk('y') })); }
  finally { fs.writeFileSync = real; }
  store.append(id, state, { type: 'model_chunk', callKey: 'c1', turn: 1, chunk: chunk('z') });
  const seqs = diskSeqs(dir, id);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'disk order is seq order');
});

test('save() flushes the id\'s pending records first: the saved eventSeq never runs ahead of the journal on disk', () => {
  const dir = tmp(); const id = 'team-b2';
  const store = new recovery.CheckpointStore(dir);
  const state = { eventSeq: 0, calls: {} };
  for (let i = 0; i < 5; i++) store.buffer(id, state, { type: 'model_chunk', callKey: 'c1', turn: 1, chunk: chunk('x') });
  assert.ok(store.pendingBytes(id) > 0);
  assert.equal(fs.existsSync(path.join(dir, id + '.events.jsonl')), false);
  store.save(id, state);
  assert.equal(store.pendingBytes(id), 0);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8'));
  assert.ok(saved.eventSeq <= Math.max(...diskSeqs(dir, id)));
  assert.equal(saved.eventSeq, 5);
});

test('the store flushes buffered records by its own timer, with no TeamStream', async () => {
  const dir = tmp(); const id = 'team-b3';
  const store = new recovery.CheckpointStore(dir, { flushMs: 30 });
  const state = { eventSeq: 0 };
  store.buffer(id, state, { type: 'model_chunk', callKey: 'c1', turn: 1, chunk: chunk('a') });
  store.buffer(id, state, { type: 'model_chunk', callKey: 'c1', turn: 1, chunk: chunk('b') });
  assert.equal(fs.existsSync(path.join(dir, id + '.events.jsonl')), false);
  await wait(150);
  assert.deepEqual(diskSeqs(dir, id), [1, 2]);
  assert.equal(store.pendingBytes(id), 0);
});

test('flush(id) clears the id\'s timer (nothing is written twice or later)', async () => {
  const dir = tmp(); const id = 'team-b4';
  const store = new recovery.CheckpointStore(dir, { flushMs: 30 });
  const state = { eventSeq: 0 };
  store.buffer(id, state, { type: 'model_chunk', callKey: 'c1', turn: 1, chunk: chunk('a') });
  assert.equal(store._timers.size, 1);
  store.flush(id);
  assert.equal(store._timers.size, 0);
  const n = countFsyncs(() => {});
  await wait(80);
  assert.deepEqual(diskSeqs(dir, id), [1]);
  assert.equal(n, 0);
});

test('8 KB of pending records flush at once', () => {
  const dir = tmp(); const id = 'team-b5';
  const store = new recovery.CheckpointStore(dir);
  const state = { eventSeq: 0 };
  store.buffer(id, state, { type: 'model_chunk', callKey: 'c1', turn: 1, chunk: chunk('small') });
  assert.equal(fs.existsSync(path.join(dir, id + '.events.jsonl')), false);
  store.buffer(id, state, { type: 'model_chunk', callKey: 'c1', turn: 1, chunk: chunk('y'.repeat(9000)) });
  assert.equal(store.pendingBytes(id), 0);
  assert.deepEqual(diskSeqs(dir, id), [1, 2]);
  assert.equal(store._timers.size, 0);
});

// ── 2 + 3. Approval cards on the page ──
function cut(from, to) {
  const a = html.indexOf(from); assert.ok(a > 0, from + ' not found');
  const b = html.indexOf(to, a); assert.ok(b > a, to + ' not found');
  return html.slice(a, b);
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function stub(tag) {
  const kids = new Map();
  const el = {
    tag, innerHTML: '', textContent: '', className: '', dataset: {}, disabled: false, removed: false, onclick: null, children: [],
    classList: { _s: new Set(), add(c) { this._s.add(c); }, contains(c) { return this._s.has(c); } },
    querySelector(s) { if (!kids.has(s)) kids.set(s, stub(s)); return kids.get(s); },
    querySelectorAll(s) { if (s === 'button') return ['.deny', '.allow'].map(x => el.querySelector(x)).filter(b => !b.removed); return []; },
    insertBefore(n) { el.children.unshift(n); },
    appendChild(n) { el.children.push(n); },
    remove() { el.removed = true; },
    isConnected: true,
  };
  return el;
}
function ctxFor() {
  const timeline = stub('timeline'); const timers = { set: 0, cleared: 0 };
  const ctx = {
    esc, agents: {}, scrollBottom() {}, fetch: async () => ({ ok: true, status: 200 }),
    Date, Map, Set, Promise, JSON, encodeURIComponent, String, Object, Number, Array,
    setInterval: () => { timers.set++; return 7; }, clearInterval: () => { timers.cleared++; },
    document: { createElement: stub, getElementById: () => timeline },
  };
  vm.createContext(ctx);
  vm.runInContext(cut('const APPROVAL_CLASS_LABELS', '    // ── Download cards') + '\nglobalThis.api = { handleApprovalEvent, resetApprovals, approvalCards, resolvedApprovals };', ctx);
  return { ctx, timeline, timers };
}
const past = () => new Date(Date.now() - 60000).toISOString();
const future = () => new Date(Date.now() + 60000).toISOString();

test('a replayed approval that had expired but was approved says Approved, with no buttons', () => {
  const { ctx } = ctxFor();
  const b = { element: { querySelector: () => stub('body') } };
  const body = b.element.querySelector('.x'); b.element = { querySelector: () => body };
  ctx.api.handleApprovalEvent({ type: 'approval_request', id: 'r1', agent: 'a', cls: 'send', summary: 's', expiresAt: past() }, b);
  const card = body.children[0];
  assert.equal(card.querySelector('.approval-note').textContent, 'Timed out: not done');
  ctx.api.handleApprovalEvent({ type: 'approval_resolved', id: 'r1', decision: 'allow', by: 'owner' }, b);
  assert.equal(card.querySelector('.approval-note').textContent, 'Approved');
  assert.equal(card.querySelectorAll('button').length, 0);
  assert.equal(body.children.length, 1);
});

test('the countdown timer ignores settled cards and stops when none are left', () => {
  const { ctx, timers } = ctxFor();
  ctx.api.handleApprovalEvent({ type: 'approval_request', id: 'p1', agent: 'a', cls: 'send', summary: 's', expiresAt: future() }, null);
  assert.equal(timers.set, 1);
  ctx.api.handleApprovalEvent({ type: 'approval_resolved', id: 'p1', decision: 'deny', by: 'owner' }, null);
  assert.equal(timers.cleared, 1);
  assert.equal(ctx.api.approvalCards.get('p1').settled, true);
});

test('after the timeline is redrawn (resetApprovals), a replayed pending request draws its card with buttons again', () => {
  const { ctx, timeline, timers } = ctxFor();
  const req = { type: 'approval_request', id: 'q1', agent: 'a', cls: 'send', summary: 's', expiresAt: future() };
  ctx.api.handleApprovalEvent(req, null);
  assert.equal(timeline.children.length, 1);
  // loadTeam clears the DOM, then calls resetApprovals
  timeline.children.length = 0;
  ctx.api.resetApprovals();
  assert.equal(ctx.api.approvalCards.size, 0); assert.equal(ctx.api.resolvedApprovals.size, 0);
  assert.equal(timers.cleared, 1);
  ctx.api.handleApprovalEvent(req, null);
  assert.equal(timeline.children.length, 1);
  assert.equal(timeline.children[0].querySelectorAll('button').length, 2);
});

test('loadTeam and loadSaved call resetApprovals where they clear the timeline', () => {
  assert.match(html, /getElementById\('timeline'\)\.innerHTML = '';\s*resetApprovals\(\);/);
  assert.match(html, /const timeline = document\.getElementById\('timeline'\);\s*resetApprovals\(\);/);
});
