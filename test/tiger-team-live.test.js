'use strict';
// lib/tiger-team-live: a run's own event stream (journal + pages that attach, drop and replay), frame tags,
// the team folder path, the busy wait and the tools that cannot change anything.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const live = require('../lib/tiger-team-live');
const recovery = require('../lib/tiger-team-recovery');

function page() {
  const res = new EventEmitter(); res.writes = [];
  res.write = s => { res.writes.push(s); return true; };
  res.end = () => { res.writableEnded = true; res.emit('close'); };
  return res;
}
const data = frames => frames.filter(f => /^(id: \d+\n)?data: \{/.test(f)).map(f => JSON.parse(f.replace(/^id: \d+\n/, '').slice(6)));

test('tagFrame names the dispatch; the innermost tag wins; other frames pass unchanged', () => {
  const t = { call: 'k', agent: 'gemini', role: 'participant' };
  assert.deepEqual(JSON.parse(live.tagFrame('data: {"choices":[]}\n\n', t).slice(6)), { choices: [], tt_call: 'k', tt_agent: 'gemini', tt_role: 'participant' });
  const inner = 'data: {"tt_call":"inner","x":1}\n\n';
  assert.equal(live.tagFrame(inner, t), inner);
  for (const f of [': heartbeat\n\n', 'data: [DONE]\n\n', 'data: not json\n\n', 'data: [1,2]\n\n', 'event: x\n\n']) assert.equal(live.tagFrame(f, t), f);
});

test('a TeamStream numbers, journals and fans out frames; pages attach, drop and replay without loss or repeats', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-live-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new recovery.CheckpointStore(dir);
  const state = { id: 'team-1', status: 'running' };
  const s = new live.TeamStream({ store, getState: id => id === 'team-1' ? state : null, heartbeatMs: 0 });
  const a = page();
  s.attach(a);
  s.write('data: {"gateway":{"type":"before_bind"}}\n\n');   // before the run names its team: sent, not journaled
  s.bind('team-1');
  assert.equal(live.get('team-1'), s);
  s.write('data: {"gateway":{"type":"tt_started"}}\n\n');
  s.write(': heartbeat\n\n');
  s.write('data: {"choices":[{"delta":{"content":"one"}}]}\n\n');
  // Model chunks journaled by the run itself share the sequence: the stream's numbers skip them.
  store.append('team-1', state, { type: 'model_chunk', chunk: {} });
  s.write('data: {"choices":[{"delta":{"content":"two"}}]}\n\n');
  const seen = data(a.writes);
  assert.equal(seen[0].gateway.type, 'before_bind'); assert.equal(seen[0].tt_seq, undefined);
  assert.deepEqual(seen.slice(1).map(e => e.tt_seq), [1, 2, 4]);
  assert.ok(seen.slice(1).every(e => typeof e.tt_at === 'string'));
  assert.equal(a.writes.includes(': heartbeat\n\n'), true);
  assert.equal(state.hasStream, true);
  // A page that dropped after seq 1 attaches (its new events held), replays exactly what it missed up to where the
  // journal ended when it attached, then gets the held events and follows live.
  a.destroyed = true; a.emit('close');
  const b = page();
  assert.equal(s.attach(b, { hold: true }), true);
  const until = state.eventSeq;
  s.write('data: {"gateway":{"type":"during_replay"}}\n\n');   // arrives while b replays: held, not lost
  assert.equal(await live.replay(store, 'team-1', b, 1, until), 2);
  assert.deepEqual(data(b.writes).map(e => e.tt_seq), [2, 4]);
  s.release(b);
  s.write('data: {"gateway":{"type":"tt_complete"}}\n\n');
  assert.deepEqual(data(b.writes).map(e => e.tt_seq), [2, 4, 5, 6]);
  assert.equal(a.writes.some(w => w.includes('tt_complete')), false, 'nothing reaches a page that left');
  assert.equal(s.viewerCount, 1);
  s.end();
  assert.equal(b.writableEnded, true); assert.equal(b.writes.at(-1), 'data: [DONE]\n\n');
  assert.equal(live.get('team-1'), null);
  assert.equal(s.attach(page()), false, 'an ended run takes no new pages');
  // A whole replay from the start draws the same frames in the same order.
  const c = page(); await live.replay(store, 'team-1', c, 0);
  assert.deepEqual(data(c.writes).map(e => e.tt_seq), [1, 2, 4, 5, 6]);
});

test('a page still replaying when the run ends gets its held events, then the end', () => {
  const state = { id: 'team-3' };
  const s = new live.TeamStream({ store: { append: (id, st) => ({ seq: (st.eventSeq = (st.eventSeq || 0) + 1) }) }, getState: () => state, heartbeatMs: 0 }).bind('team-3');
  const p = page(); s.attach(p, { hold: true });
  s.write('data: {"gateway":{"type":"tt_complete"}}\n\n');
  s.end();
  assert.equal(p.writableEnded, undefined, 'not closed while it replays');
  s.release(p);
  assert.equal(data(p.writes)[0].gateway.type, 'tt_complete');
  assert.equal(p.writes.at(-1), 'data: [DONE]\n\n'); assert.equal(p.writableEnded, true);
});

test('a page that falls behind is dropped (it reconnects from its last event); the others keep going', () => {
  const state = { id: 'team-4' }, logs = [];
  const s = new live.TeamStream({ store: { append: (id, st) => ({ seq: (st.eventSeq = (st.eventSeq || 0) + 1) }) }, getState: () => state, heartbeatMs: 0, log: m => logs.push(m) }).bind('team-4');
  const slow = page(), fast = page();
  slow.writableLength = 9 * 1024 * 1024; slow.destroy = () => { slow.destroyed = true; };
  s.attach(slow); s.attach(fast);
  s.write('data: {"x":1}\n\n');
  assert.equal(slow.destroyed, true); assert.equal(slow.writes.length, 0);
  assert.equal(data(fast.writes).length, 1); assert.equal(s.viewerCount, 1);
  assert.match(logs[0], /fell behind/);
  s.end();
});

test('a stream whose journal fails keeps sending (the work journal fails closed elsewhere)', () => {
  const logs = [];
  const state = { id: 'team-2' };
  const s = new live.TeamStream({ store: { append() { throw new Error('disk full'); } }, getState: () => state, log: m => logs.push(m), heartbeatMs: 0 }).bind('team-2');
  const a = page(); s.attach(a);
  s.write('data: {"x":1}\n\n'); s.write('data: {"x":2}\n\n');
  assert.equal(data(a.writes).length, 2);
  assert.equal(data(a.writes)[0].tt_seq, undefined, 'unjournaled frames carry no number');
  assert.equal(logs.length, 1);
  s.end();
});

test('the team folder lives under share/common, the one folder every admin-side agent can open', () => {
  const p = live.teamFolderFor('tiger-team-1-abc');
  assert.equal(p, path.join(path.resolve(__dirname, '..', '..'), 'share', 'common', 'tiger-teams', 'tiger-team-1-abc'));
});

test('tools that cannot change anything', () => {
  for (const n of ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'read_tiger_team_archive', 'recall', 'list_agents']) assert.equal(live.changesNothing(n), true, n);
  for (const n of ['Bash', 'Write', 'Edit', 'write_memory', 'consult_agent', 'record_write', 'schedule_task', 'Readx', '']) assert.equal(live.changesNothing(n), false, n);
});

test('waitUntilFree: free at once, free later, never free, and stopped while waiting', async () => {
  const sleep = (ms, signal) => recovery.sleep(ms, signal);
  assert.equal(await live.waitUntilFree(() => false, { sleep }), true);
  let busy = 3, waited = 0;
  assert.equal(await live.waitUntilFree(() => busy-- > 0, { sleep, stepMs: 1, onWait: () => waited++ }), true);
  assert.equal(waited, 1, 'the wait is announced once');
  assert.equal(await live.waitUntilFree(() => true, { sleep, stepMs: 1, maxMs: 15 }), false);
  const ac = new AbortController(); setTimeout(() => ac.abort(), 10);
  await assert.rejects(live.waitUntilFree(() => true, { sleep, stepMs: 2, signal: ac.signal }), { name: 'AbortError' });
});
