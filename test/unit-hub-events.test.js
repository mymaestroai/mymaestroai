'use strict';
// Behavioural unit tests for lib/hub-events.js, covering the gaps left by the other hub-events tests:
// per-client filtering (member vs admin vs the hub itself), visibleAgent on the snapshot, the
// status_snapshot shape and the halt / pacing / approvals providers, ring and backpressure limits,
// clipping, activityOf / normalizeOrigin, onPublish, recent, clientCount.
const { test } = require('node:test');
const assert = require('node:assert');
const { createHubEvents, activityOf, normalizeOrigin, events: shared } = require('../lib/hub-events');

function fakeRes() {
  const r = { chunks: [], headers: null, destroyed: false, writableLength: 0, handlers: {} };
  r.writeHead = (code, h) => { r.status = code; r.headers = h; };
  r.write = (s) => { r.chunks.push(s); return true; };
  r.on = (ev, fn) => { r.handlers[ev] = fn; };
  r.destroy = () => { r.destroyed = true; };
  r.close = () => r.handlers.close && r.handlers.close();
  return r;
}
/** Parse the SSE frames a fake res received into [{event, data}]. */
function frames(res) {
  return res.chunks.filter(c => c.startsWith('event: ') || c.startsWith('id: ')).map(c => {
    const ev = /event: (\S+)/.exec(c)[1]; const data = JSON.parse(/data: (.*)\n/.exec(c)[1]);
    return { event: ev, data };
  });
}
const T0 = Date.parse('2026-03-01T12:00:00Z');
const make = () => { const clock = { t: T0 }; return { hub: createHubEvents({ now: () => clock.t }), clock }; };
const memberOpts = (own) => ({ isAdmin: false, visibleAgent: (n) => own.includes(n), filter: (ev) => own.includes(ev.agent) });
const adminOpts = { isAdmin: true, visibleAgent: () => true, filter: () => true };

test('activityOf and normalizeOrigin', () => {
  assert.strictEqual(activityOf({ kind: 'user' }), 'replying to you');
  assert.strictEqual(activityOf({ kind: 'consultation', from: 'maestro' }), 'consulted by maestro');
  assert.strictEqual(activityOf({ kind: 'consultation' }), 'consulted by another agent');
  assert.strictEqual(activityOf({ kind: 'schedule', label: 'Daily review' }), 'scheduled task: Daily review');
  assert.strictEqual(activityOf({ kind: 'schedule', from: 'st-1' }), 'scheduled task: st-1');
  assert.strictEqual(activityOf({ kind: 'schedule' }), 'scheduled task');
  assert.strictEqual(activityOf({ kind: 'job_report' }), 'job report');
  assert.strictEqual(activityOf({ kind: 'job_notice' }), 'job finished');
  assert.strictEqual(activityOf({ kind: 'alert' }), 'alert');
  assert.strictEqual(activityOf({ kind: 'task' }), 'working');
  assert.strictEqual(activityOf(undefined), 'working');
  assert.deepStrictEqual(normalizeOrigin(undefined), { kind: 'user' });
  assert.deepStrictEqual(normalizeOrigin({ from: 'x' }), { kind: 'user' }, 'no kind: treated as the user');
  assert.deepStrictEqual(normalizeOrigin('consultation'), { kind: 'user' });
  assert.deepStrictEqual(normalizeOrigin({ kind: 'schedule', from: 'st-2', taskId: 'st-2' }), { kind: 'schedule', from: 'st-2', taskId: 'st-2', label: 'st-2' }, 'schedule gains a label; extra ids kept');
  const o = { kind: 'consultation', from: 'a' };
  assert.notStrictEqual(normalizeOrigin(o), o, 'copied, not aliased');
});

test('per-client filter: a member sees only events about their own agents, admins and the hub itself see everything', () => {
  const { hub } = make();
  const member = fakeRes(), admin = fakeRes(), self = fakeRes();
  hub.subscribe({ headers: {} }, member, memberOpts(['ann_doc']));
  hub.subscribe({ headers: {} }, admin, adminOpts);
  hub.subscribe({ headers: {} }, self);
  assert.strictEqual(hub.clientCount(), 3);
  hub.publish('turn_start', { agent: 'ann_doc', turnId: 't1' });
  hub.publish('turn_start', { agent: 'maestro', turnId: 't2' });
  hub.publish('approval', { id: 'ap_1' });                 // hub-wide: no agent field
  hub.publish('halt', { halted: true });
  const seen = (r) => frames(r).filter(f => !['hello', 'status_snapshot'].includes(f.event)).map(f => `${f.event}:${f.data.agent || '-'}`);
  assert.deepStrictEqual(seen(member), ['turn_start:ann_doc'], 'member: own agent only, no hub-wide events');
  assert.deepStrictEqual(seen(admin), ['turn_start:ann_doc', 'turn_start:maestro', 'approval:-', 'halt:-']);
  assert.deepStrictEqual(seen(self), seen(admin), 'the hub\'s own subscriber (no opts) gets everything');
  const noFilter = fakeRes();
  hub.subscribe({ headers: {} }, noFilter, { isAdmin: false });
  hub.publish('turn_end', { agent: 'maestro' }); hub.publish('pacing', { paced: [] });
  assert.deepStrictEqual(seen(noFilter), ['turn_end:maestro'], 'opts without a filter: agent events pass, hub-wide ones still need isAdmin');
  member.close();
  assert.strictEqual(hub.clientCount(), 3, 'close removes the client');
  assert.strictEqual(member.headers['Content-Type'], 'text/event-stream');
  assert.strictEqual(member.headers['Cache-Control'], 'no-store');
});

test('replay on reconnect honours the member filter; a fresh client gets hello only', () => {
  const { hub } = make();
  hub.publish('turn_start', { agent: 'ann_doc', turnId: 'a' });   // id 1
  hub.publish('turn_start', { agent: 'maestro', turnId: 'b' });   // id 2
  hub.publish('hub_halted', { reason: 'x' });                      // id 3 (no agent)
  hub.publish('turn_end', { agent: 'ann_doc', turnId: 'a' });      // id 4
  const member = fakeRes();
  hub.subscribe({ headers: { 'last-event-id': '1' } }, member, memberOpts(['ann_doc']));
  const f = frames(member);
  assert.deepStrictEqual(f.map(x => x.event), ['hub_halted', 'turn_end', 'hello', 'status_snapshot'], 'missed events first (agent-less ones are replayed to everyone), then hello');
  assert.deepStrictEqual({ ...f[2].data, boot: undefined }, { lastId: 4, replayed: true, boot: undefined }); assert.ok(typeof f[2].data.boot === 'string' && f[2].data.boot, 'hello carries the boot id');
  assert.strictEqual(member.chunks[0].split('\n')[0], 'id: 3', 'frames carry the event id');
  const freshRes = fakeRes();
  hub.subscribe({ headers: {} }, freshRes, adminOpts);
  assert.deepStrictEqual(frames(freshRes).map(x => x.event), ['hello', 'status_snapshot']);
  assert.deepStrictEqual({ ...frames(freshRes)[0].data, boot: undefined }, { lastId: 4, replayed: false, boot: undefined });
  const bogus = fakeRes();
  hub.subscribe({ headers: { 'last-event-id': 'abc' } }, bogus, adminOpts);
  assert.deepStrictEqual(frames(bogus).map(x => x.event), ['hello', 'status_snapshot'], 'unparsable Last-Event-ID = fresh');
});

test('status_snapshot: shape, visibleAgent filter, approvals hidden from members, providers and their fallbacks', () => {
  const { hub, clock } = make();
  const plain = fakeRes();
  hub.subscribe({ headers: {} }, plain, adminOpts);
  assert.deepStrictEqual(frames(plain)[1].data, { type: 'status_snapshot', ts: '2026-03-01T12:00:00.000Z', halted: false, haltedAt: null, haltReason: null, pacing: { paced: [] }, approvals: [], agents: {} }, 'no providers: empty but complete');
  hub.setStatusProvider(() => ({ ann_doc: { busy: true, activity: 'replying to you' }, maestro: { busy: false }, bob_x: { busy: true } }));
  hub.setHaltProvider(() => ({ halted: true, at: '2026-03-01T11:00:00Z', reason: 'maintenance' }));
  hub.setPacingProvider(() => ({ providers: { openai: 'serial' }, paced: ['openai'] }));
  hub.setApprovalsProvider(() => [{ id: 'ap_1', agent: 'maestro' }]);
  clock.t += 1000;
  const admin = fakeRes(), member = fakeRes();
  hub.subscribe({ headers: {} }, admin, adminOpts);
  hub.subscribe({ headers: {} }, member, memberOpts(['ann_doc']));
  const a = frames(admin)[1].data, m = frames(member)[1].data;
  assert.strictEqual(a.ts, '2026-03-01T12:00:01.000Z');
  assert.deepStrictEqual({ halted: a.halted, haltedAt: a.haltedAt, haltReason: a.haltReason }, { halted: true, haltedAt: '2026-03-01T11:00:00Z', haltReason: 'maintenance' });
  assert.deepStrictEqual(a.pacing, { paced: ['openai'] }, 'only the paced list is published, not the provider table');
  assert.deepStrictEqual(a.approvals, [{ id: 'ap_1', agent: 'maestro' }]);
  assert.deepStrictEqual(Object.keys(a.agents), ['ann_doc', 'maestro', 'bob_x']);
  assert.deepStrictEqual(Object.keys(m.agents), ['ann_doc'], 'member snapshot filtered by visibleAgent');
  assert.deepStrictEqual(m.approvals, [], 'members never see approval cards');
  assert.strictEqual(m.halted, true, 'halt state is hub-wide and shown to members too');
  assert.deepStrictEqual(hub.pacingState(), { providers: { openai: 'serial' }, paced: ['openai'] });
  assert.deepStrictEqual(hub.approvalsState(), [{ id: 'ap_1', agent: 'maestro' }]);
  assert.deepStrictEqual(hub.haltState(), { halted: true, at: '2026-03-01T11:00:00Z', reason: 'maintenance' });
  hub.setStatusProvider(() => { throw new Error('boom'); });
  hub.setHaltProvider(() => { throw new Error('boom'); });
  hub.setPacingProvider(() => { throw new Error('boom'); });
  hub.setApprovalsProvider(() => null);
  assert.deepStrictEqual([hub.statusSnapshot(), hub.haltState(), hub.pacingState(), hub.approvalsState()], [{}, { halted: false }, { providers: {}, paced: [] }, []], 'throwing or empty providers fall back');
  const after = fakeRes();
  hub.subscribe({ headers: {} }, after, adminOpts);
  assert.deepStrictEqual(frames(after)[1].data.agents, {}, 'a broken status provider does not break subscribe');
  const snap = frames(after)[1].data;
  assert.ok(!hub.recent().some(e => e.type === 'status_snapshot') && snap.halted === false, 'snapshot is not stored in the ring');
});

test('publish: ids, timestamps, ring cap of 300, recent(afterId), onPublish with unsubscribe, listener errors contained', () => {
  const { hub, clock } = make();
  const got = [];
  const off = hub.onPublish(ev => got.push(ev.id));
  hub.onPublish(() => { throw new Error('listener bug'); });
  const ev = hub.publish('note', { agent: 'x', text: 'hi' });
  assert.deepStrictEqual(ev, { agent: 'x', text: 'hi', seq: 1, id: 1, ts: '2026-03-01T12:00:00.000Z', type: 'note' });
  clock.t += 5000;
  assert.strictEqual(hub.publish('note', {}).ts, '2026-03-01T12:00:05.000Z');
  assert.deepStrictEqual(got, [1, 2]);
  off();
  for (let i = 0; i < 320; i++) hub.publish('tick', { i });
  assert.deepStrictEqual(got, [1, 2], 'unsubscribed');
  const all = hub.recent();
  assert.strictEqual(all.length, 300, 'ring keeps the last 300');
  assert.strictEqual(all[0].id, 23); assert.strictEqual(all[299].id, 322);
  assert.deepStrictEqual(hub.recent(320).map(e => e.id), [321, 322]);
  assert.deepStrictEqual(hub.recent(999), []);
});

test('backpressure: a client with more than 2 MB queued is destroyed and dropped; a throwing write drops it', () => {
  const { hub } = make();
  const slow = fakeRes(), broken = fakeRes(), fine = fakeRes();
  hub.subscribe({ headers: {} }, slow); hub.subscribe({ headers: {} }, broken); hub.subscribe({ headers: {} }, fine);
  slow.writableLength = 2 * 1024 * 1024 + 1;
  broken.write = () => { throw new Error('EPIPE'); };
  hub.publish('turn_start', { agent: 'a' });
  assert.ok(slow.destroyed, 'slow client destroyed');
  assert.ok(!fine.destroyed && frames(fine).some(f => f.event === 'turn_start'));
  assert.strictEqual(hub.clientCount(), 1, 'slow and broken clients removed');
});

test('tapTurn: given turnId, message and error clipping, observeClosed feeds a detached turn, finish is idempotent', async () => {
  const { hub } = make();
  const res = { write: (c) => c };
  const big = 'm'.repeat(13000);
  const t = hub.tapTurn(res, { agent: 'maestro', origin: { kind: 'schedule', from: 'st-1' }, message: big, turnId: 'turn-xyz', startedAt: '2026-01-01T00:00:00Z' });
  assert.strictEqual(t.turnId, 'turn-xyz');
  assert.deepStrictEqual(t.origin, { kind: 'schedule', from: 'st-1', label: 'st-1' });
  const start = hub.recent()[0];
  assert.strictEqual(start.startedAt, '2026-01-01T00:00:00Z');
  assert.strictEqual(start.activity, 'scheduled task: st-1');
  assert.strictEqual(start.message.length, 12000 + '\n…[truncated]'.length, 'message clipped to 12000 chars');
  assert.ok(start.message.endsWith('…[truncated]'));
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.write('data: not json\n\n');
  res.write(Buffer.from('binary'));
  res.observeClosed({ choices: [{ delta: { content: 'lo' } }] });   // the browser went away; chunks still counted
  res.observeClosed(null);
  assert.strictEqual(t.text, 'Hello');
  t.finish(false, 'e'.repeat(600));
  t.finish(true);
  const types = hub.recent().map(e => e.type);
  assert.deepStrictEqual(types, ['turn_start', 'turn_end'], 'finish before the 300 ms flush: no delta; second finish ignored');
  const end = hub.recent()[1];
  assert.deepStrictEqual({ ok: end.ok, reply: end.reply, agent: end.agent, turnId: end.turnId }, { ok: false, reply: 'Hello', agent: 'maestro', turnId: 'turn-xyz' });
  assert.strictEqual(end.error.length, 500 + '\n…[truncated]'.length, 'error clipped to 500 chars');
  assert.ok(!('observeClosed' in res), 'observer removed after finish');
  const t2 = hub.tapTurn(res, { agent: 'w', origin: null });
  assert.match(t2.turnId, /^w-3-[0-9a-z]+$/, 'generated turnId: agent, next event id, time');
  assert.deepStrictEqual(t2.origin, { kind: 'user' });
  t2.finish();
  assert.strictEqual(hub.recent()[3].error, null);
});

test('publish keeps the caller\'s own id in the payload but the wire id / replay use the sequence; type and ts cannot be overridden', () => {
  // approvals.js emits approval_request/approval_resolved with id:'ap_…' and agent-requests.js with id:'ar_…'.
  const { hub } = make();
  const ev = hub.publish('approval_resolved', { id: 'ap_42', agent: 'maestro', ts: 'bogus', type: 'other' });
  assert.strictEqual(ev.id, 'ap_42', 'the approval id stays in the payload (the cards key on it)');
  assert.strictEqual(ev.seq, 1, 'sequence number carried separately');
  assert.strictEqual(ev.type, 'approval_resolved', 'event type is the published type');
  assert.notStrictEqual(ev.ts, 'bogus');
  assert.deepStrictEqual(hub.recent(0).map(e => e.seq), [1], 'replayable by sequence');
  const n = hub.publish('x', {});
  assert.strictEqual(n.seq, 2); assert.strictEqual(n.id, 2, 'no caller id -> id is the sequence');
  // A reconnecting client sends Last-Event-ID = seq and gets exactly the later events.
  const w = []; const res = { writeHead() {}, write(s) { w.push(s); return true; }, on() {}, destroy() {}, writableLength: 0 };
  hub.subscribe({ headers: { 'last-event-id': '1' } }, res, null);
  const replayed = w.filter(s => s.startsWith('id: ')).map(s => s.split('\n')[0]);
  assert.deepStrictEqual(replayed, ['id: 2']);
});

test('the module exports a shared instance that is a working hub', () => {
  assert.strictEqual(typeof shared.publish, 'function');
  assert.strictEqual(shared.clientCount(), 0);
});
