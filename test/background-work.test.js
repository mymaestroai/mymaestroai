'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const BW = require('../lib/background-work');
const access = require('../lib/access');

const T0 = Date.parse('2026-11-23T12:00:00Z');
const owner = { id: 'u_owner', role: 'admin' };
const sam = { id: 'u_sam', role: 'member' };

function sources(over = {}) {
  const env = {
    hoRows: [], jobRows: [], virtuals: [], taskRows: [], shown: [], published: [],
    fail: new Set(),
  };
  const guard = (k, fn) => (...a) => { if (env.fail.has(k)) throw new Error(`${k} down`); return fn(...a); };
  const mkWork = () => BW.createBackgroundWork({
    handOffs: {
      forCaller: guard('handOffs', (c) => env.hoRows.filter((r) => r.caller === c)),
      all: guard('handOffs', () => env.hoRows),
      listShown: guard('handOffs', async (c) => env.shown.filter((v) => v.caller === c).map((v) => ({ ...v }))),
    },
    jobs: { list: guard('jobs', () => env.jobRows) },
    workers: { listVirtual: guard('workers', () => env.virtuals), getVirtual: guard('workers', (id) => env.virtuals.find((v) => v.id === id) || null) },
    tasks: { list: guard('tasks', () => env.taskRows) },
    publish: (type, data) => env.published.push({ type, ...data }),
    now: () => T0,
    statusMtime: (f) => env.mtimes && env.mtimes[f] || null,
    ...over,
  });
  env.work = mkWork();
  return env;
}
const ho = (id, caller, state, extra = {}) => ({ id, caller, target: 'agent-b', state, ...extra });
const job = (id, owner_, status, extra = {}) => ({ id, name: `job ${id}`, owner: owner_, status, startedAt: '2026-11-23T11:00:00.000Z', command: 'secret --flag', cwd: '/x', ...extra });

test('countFor: hand-offs open, jobs running or cancelling, workers (nested) of the named agent', () => {
  const e = sources();
  e.hoRows = [ho('ho-1', 'agent-a', 'queued'), ho('ho-2', 'agent-a', 'running'), ho('ho-3', 'agent-a', 'waiting'), ho('ho-4', 'agent-a', 'done'), ho('ho-5', 'agent-a', 'failed'), ho('ho-6', 'agent-b', 'running')];
  e.jobRows = [job('j1', 'agent-a', 'running'), job('j2', 'agent-a', 'cancelling'), job('j3', 'agent-a', 'finished'), job('j4', 'agent-b', 'running')];
  e.virtuals = [
    { id: 'tw-1', parent: 'agent-a', model: 'm', label: 'one', createdAt: T0 },
    { id: 'tw-2', parent: 'tw-1', model: 'm', label: 'nested', createdAt: T0 },
    { id: 'tw-3', parent: 'agent-b', model: 'm', label: 'other', createdAt: T0 },
    { id: 'selfcheck-lead', parent: null, selfCheck: true },
  ];
  assert.strictEqual(e.work.countFor('agent-a'), 3 + 2 + 2);
  assert.strictEqual(e.work.countFor('agent-b'), 1 + 1 + 1);
  assert.strictEqual(e.work.countFor('nobody'), 0);
  const m = e.work.counts();
  assert.strictEqual(m.get('agent-a'), 7);
  assert.strictEqual(m.get('agent-b'), 3);
  assert.strictEqual(m.has('nobody'), false);
});

test('countFor: a hand-off RECEIVED by the agent is not counted for it', () => {
  const e = sources();
  e.hoRows = [ho('ho-1', 'agent-a', 'running', { target: 'agent-b' })];
  assert.strictEqual(e.work.countFor('agent-b'), 0);
});

test('a failing source gives an empty list for its kind, not an error', async () => {
  const e = sources();
  e.hoRows = [ho('ho-1', 'agent-a', 'running')];
  e.jobRows = [job('j1', 'agent-a', 'running')];
  e.virtuals = [{ id: 'tw-1', parent: 'agent-a', createdAt: T0 }];
  e.shown = [{ ...ho('ho-1', 'agent-a', 'running'), folder: null }];
  e.fail.add('jobs');
  assert.strictEqual(e.work.countFor('agent-a'), 2);
  e.fail.clear(); e.fail.add('handOffs');
  assert.strictEqual(e.work.countFor('agent-a'), 2);
  let v = await e.work.viewFor('agent-a', { isAdmin: true });
  assert.deepStrictEqual(v.handOffs, []);
  assert.strictEqual(v.workers.length, 1);
  e.fail.clear(); e.fail.add('workers');
  v = await e.work.viewFor('agent-a', { isAdmin: true });
  assert.deepStrictEqual(v.workers, []);
  assert.strictEqual(v.count, 2);
  e.fail.clear(); e.fail.add('tasks');
  v = await e.work.viewFor('agent-a', { isAdmin: true });
  assert.strictEqual(v.nextCheck, null);
  assert.strictEqual(v.count, 3);
});

test('viewFor: admin sees job rows (no command, no cwd); a member only the count', async () => {
  const e = sources();
  e.jobRows = [job('j1', 'agent-a', 'running'), job('j2', 'agent-a', 'finished'), job('j3', 'agent-b', 'running')];
  e.virtuals = [{ id: 'tw-1', parent: 'agent-a', model: 'sonnet', label: 'look it up', createdAt: T0 }];
  const a = await e.work.viewFor('agent-a', { isAdmin: true });
  assert.deepStrictEqual(a.jobs, [{ id: 'j1', name: 'job j1', startedAt: '2026-11-23T11:00:00.000Z', status: 'running' }]);
  assert.strictEqual(a.jobCount, 1);
  assert.strictEqual(a.count, 2);
  assert.deepStrictEqual(a.workers, [{ id: 'tw-1', label: 'look it up', model: 'sonnet', startedAt: new Date(T0).toISOString() }]);
  const m = await e.work.viewFor('agent-a', { isAdmin: false });
  assert.strictEqual(m.jobs, null);
  assert.strictEqual(m.jobCount, 1);
  assert.ok(!JSON.stringify(m).includes('job j1'));
  assert.ok(!JSON.stringify(m).includes('secret'));
  assert.ok(!JSON.stringify(a).includes('secret'));
  assert.strictEqual((await e.work.viewFor('agent-a', undefined)).jobs, null);
});

test('statusLineOf: Next heading, Running heading, first line, empty', () => {
  assert.strictEqual(BW.statusLineOf('# Status\nDone: a\n\n## Next\n- write the tests\n- then ship\n\n## Blockers\nnone'), 'write the tests');
  assert.strictEqual(BW.statusLineOf('# S\nintro\n## Running\n\nbuilding the index\n## Done\nx'), 'building the index');
  assert.strictEqual(BW.statusLineOf('# Title\n\nWorking through the list.\nMore.'), 'Working through the list.');
  assert.strictEqual(BW.statusLineOf('# Title\n## Done\nfinished'), 'finished');
  assert.strictEqual(BW.statusLineOf(''), null);
  assert.strictEqual(BW.statusLineOf(null), null);
  assert.strictEqual(BW.statusLineOf('# Only a heading'), null);
  const long = BW.statusLineOf('x'.repeat(500));
  assert.ok(long.length <= 200);
});

test('viewFor hand-offs: statusLine and changedAt; a withheld item gets null; a missing file is fine', async () => {
  const e = sources();
  e.shown = [
    { ...ho('ho-1', 'agent-a', 'running', { folder: '/f/hand-offs/one', createdAt: T0 - 5000, startedAt: T0 - 4000 }), status: '# S\n## Next\nstep two' },
    { ...ho('ho-2', 'agent-a', 'running', { folder: '/f/hand-offs/two', createdAt: T0 - 9000 }), status: null },
    { ...ho('ho-3', 'agent-a', 'running', { folder: null, withheld: 'access', createdAt: T0 - 9000 }), status: '# S\n## Next\nsecret words' },
    { ...ho('ho-4', 'agent-a', 'done', { folder: '/f/hand-offs/four', createdAt: T0 - 9000, endedAt: T0 - 1000 }), status: 'all done' },
  ];
  e.mtimes = { '/f/hand-offs/one': '2026-11-23T11:55:00.000Z' };
  // mtime lookup is by folder (the helper adds STATUS.md); the fake keys by folder
  const v = await e.work.viewFor('agent-a', { isAdmin: false, canSee: () => true });
  const by = Object.fromEntries(v.handOffs.map((h) => [h.id, h]));
  assert.strictEqual(by['ho-1'].statusLine, 'step two');
  assert.strictEqual(by['ho-1'].changedAt, '2026-11-23T11:55:00.000Z');
  assert.strictEqual(by['ho-2'].statusLine, null);
  assert.strictEqual(by['ho-2'].changedAt, new Date(T0 - 9000).toISOString());   // the record's latest timestamp
  assert.strictEqual(by['ho-3'].statusLine, null);
  assert.strictEqual(by['ho-3'].changedAt, new Date(T0 - 9000).toISOString());
  assert.strictEqual(by['ho-4'].statusLine, 'all done');
  assert.strictEqual(by['ho-4'].changedAt, new Date(T0 - 1000).toISOString());
  assert.ok(!('status' in by['ho-1']));
  assert.ok(!JSON.stringify(v).includes('secret words'));
});

test('statusMtime: a regular file in the folder only; a link or a missing file gives null', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-test-'));
  try {
    const outside = path.join(d, 'outside.md'); fs.writeFileSync(outside, 'x');
    const ok = path.join(d, 'ok'); fs.mkdirSync(ok); fs.writeFileSync(path.join(ok, 'STATUS.md'), 'hi');
    const link = path.join(d, 'link'); fs.mkdirSync(link); fs.symlinkSync(outside, path.join(link, 'STATUS.md'));
    const none = path.join(d, 'none'); fs.mkdirSync(none);
    assert.match(BW.statusMtime(ok), /^\d{4}-\d\d-\d\dT/);
    assert.strictEqual(BW.statusMtime(link), null);
    assert.strictEqual(BW.statusMtime(none), null);
    assert.strictEqual(BW.statusMtime(path.join(d, 'gone')), null);
    assert.strictEqual(BW.statusMtime(null), null);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('nextCheck: by handOff field, by id in label or prompt, never a fallback', async () => {
  const e = sources();
  e.hoRows = [ho('ho-aaaa1111', 'agent-a', 'waiting')];
  e.jobRows = [job('abcd1234', 'agent-a', 'running')];
  e.shown = [{ ...ho('ho-aaaa1111', 'agent-a', 'waiting'), folder: null }];
  const task = (id, over) => ({ id, agent: 'agent-a', status: 'active', label: 'check', prompt: 'look', nextRunAt: '2026-11-23T15:00:00.000Z', ...over });
  // a recurring task with no id: never counts
  e.taskRows = [task('t0', { nextRunAt: '2026-11-23T12:30:00.000Z' })];
  assert.strictEqual((await e.work.viewFor('agent-a', { isAdmin: true })).nextCheck, null);
  // by handOff field; the earliest of several
  e.taskRows = [task('t1', { handOff: 'ho-aaaa1111', nextRunAt: '2026-11-23T16:00:00.000Z' }), task('t2', { handOff: 'ho-aaaa1111', nextRunAt: '2026-11-23T14:00:00.000Z' }), task('t0', { nextRunAt: '2026-11-23T12:30:00.000Z' })];
  assert.deepStrictEqual((await e.work.viewFor('agent-a', { isAdmin: true })).nextCheck, { at: '2026-11-23T14:00:00.000Z', taskId: 't2' });
  // by an id in the label or prompt (whole word), for a hand-off or a job
  e.taskRows = [task('t3', { label: 'poll ho-aaaa1111' }), task('t4', { prompt: 'is job abcd1234 done?', nextRunAt: '2026-11-23T13:00:00.000Z' })];
  assert.deepStrictEqual((await e.work.viewFor('agent-a', { isAdmin: true })).nextCheck, { at: '2026-11-23T13:00:00.000Z', taskId: 't4' });
  // a longer id that merely contains it is not the id
  e.taskRows = [task('t5', { prompt: 'job abcd12345 and xho-aaaa1111' })];
  assert.strictEqual((await e.work.viewFor('agent-a', { isAdmin: true })).nextCheck, null);
  // another agent's task, a paused task, a task of a closed item
  e.taskRows = [task('t6', { agent: 'agent-b', handOff: 'ho-aaaa1111' }), task('t7', { status: 'paused', handOff: 'ho-aaaa1111' }), task('t8', { handOff: 'ho-zzzz9999' })];
  assert.strictEqual((await e.work.viewFor('agent-a', { isAdmin: true })).nextCheck, null);
});

test('route: the working-on path is classified as the agent itself (agent route from the path)', () => {
  const r = access.classifyRoute('/api/agents/sam-agent/working-on', 'GET');
  assert.strictEqual(r.kind, 'agent');
  assert.strictEqual(r.from, 'path');
  assert.strictEqual(r.agent, 'sam-agent');
  assert.deepStrictEqual(access.classifyRoute('/api/agents/sam-agent/working-on', 'GET'), access.classifyRoute('/api/agents/sam-agent/workers', 'GET'));
});

test('route: access as for the agent: admin any, member own or shared only; a member gets no job names', async () => {
  const agents = [{ name: 'owner-agent', owner: 'u_owner' }, { name: 'sam-agent', owner: 'u_sam' }, { name: 'lead', owner: 'u_owner', sharedWith: ['u_sam'] }];
  const mayOpen = (user, name) => access.isAdmin(user) || access.canAccessAgent(user, name, { agents });
  assert.ok(mayOpen(owner, 'owner-agent') && mayOpen(owner, 'sam-agent'));
  assert.ok(mayOpen(sam, 'sam-agent') && mayOpen(sam, 'lead'));
  assert.ok(!mayOpen(sam, 'owner-agent'));

  const e = sources();
  e.jobRows = [job('j1', 'sam-agent', 'running', { name: 'private build' })];
  const names = agents.map((a) => a.name);
  const asAdmin = await BW.workingOnResponse('sam-agent', { agentNames: names, viewer: { isAdmin: access.isAdmin(owner) }, work: e.work });
  assert.strictEqual(asAdmin.status, 200);
  assert.strictEqual(asAdmin.body.ok, true);
  assert.strictEqual(asAdmin.body.agent, 'sam-agent');
  assert.strictEqual(asAdmin.body.jobs[0].name, 'private build');
  const asMember = await BW.workingOnResponse('sam-agent', { agentNames: names, viewer: { isAdmin: access.isAdmin(sam) }, work: e.work });
  assert.strictEqual(asMember.status, 200);
  assert.strictEqual(asMember.body.jobs, null);
  assert.strictEqual(asMember.body.jobCount, 1);
  assert.ok(!JSON.stringify(asMember.body).includes('private build'));
  const unknown = await BW.workingOnResponse('ghost', { agentNames: names, viewer: { isAdmin: true }, work: e.work });
  assert.strictEqual(unknown.status, 404);
});

test('server.js wires the route with the trusted session for isAdmin', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /\/api\\\/agents\\\/\(\[\^\/\]\+\)\\\/working-on\$/);
  assert.match(src, /const woAdmin = !!req\.hubService \|\| access\.isAdmin\(req\.hubUser\);/);
  assert.match(src, /workingOnResponse\(name, \{[^\n]*viewer: \{ isAdmin: woAdmin, canSee: \(n\) => woAdmin \|\| access\.canAccessAgent\(req\.hubUser, n,/);
  assert.doesNotMatch(src, /working-on[^\n]*(req\.query|searchParams)[^\n]*isAdmin/);
});

test('event: published once per change, not on an unchanged recheck', () => {
  const e = sources();
  e.work.recheckAll();
  assert.deepStrictEqual(e.published, []);                       // nothing running: nothing published
  e.hoRows = [ho('ho-1', 'agent-a', 'running')];
  assert.strictEqual(e.work.recheck('agent-a'), true);
  assert.deepStrictEqual(e.published, [{ type: 'background', agent: 'agent-a', count: 1 }]);
  assert.strictEqual(e.work.recheck('agent-a'), false);          // unchanged
  e.work.recheckAll();
  assert.strictEqual(e.published.length, 1);
  e.jobRows = [job('j1', 'agent-a', 'running')];
  e.work.recheckAll();
  assert.deepStrictEqual(e.published.at(-1), { type: 'background', agent: 'agent-a', count: 2 });
  e.hoRows = []; e.jobRows = [];
  e.work.recheckAll();
  assert.deepStrictEqual(e.published.at(-1), { type: 'background', agent: 'agent-a', count: 0 });
  e.work.recheckAll();
  assert.strictEqual(e.published.length, 3);
});

test('event: the 15 s timer rechecks agents that had work (safety net)', () => {
  let tick = null; let cleared = false;
  const e = sources({ setTimer: (fn, ms) => { assert.strictEqual(ms, 15000); tick = fn; return { unref() {} }; }, clearTimer: () => { cleared = true; } });
  e.hoRows = [ho('ho-1', 'agent-a', 'running')];
  e.work.start();
  e.work.start();
  tick();
  assert.deepStrictEqual(e.published, [{ type: 'background', agent: 'agent-a', count: 1 }]);
  e.hoRows = [];                                                  // ended without any hook firing
  tick();
  assert.deepStrictEqual(e.published.at(-1), { type: 'background', agent: 'agent-a', count: 0 });
  e.work.stop();
  assert.ok(cleared);
});

test('event: an event carries agent, so the per-viewer filter applies (hub-events)', () => {
  const { createHubEvents } = require('../lib/hub-events');
  assert.strictEqual(typeof createHubEvents, 'function');
  const ev = createHubEvents ? createHubEvents() : null;
  const got = { member: [], admin: [] };
  const mkRes = (into) => ({ writeHead() {}, write(t) { into.push(t); return true; }, on() {}, writableLength: 0, destroy() {} });
  const visible = (n) => n === 'sam-agent';
  ev.subscribe({ url: '/', headers: {} }, mkRes(got.member), { isAdmin: false, visibleAgent: visible, filter: (x) => visible(x.agent) });
  ev.subscribe({ url: '/', headers: {} }, mkRes(got.admin), { isAdmin: true, visibleAgent: () => true, filter: () => true });
  ev.publish('background', { agent: 'owner-agent', count: 1 }, { keep: false });
  ev.publish('background', { agent: 'sam-agent', count: 2 }, { keep: false });
  const bg = (arr) => arr.filter((t) => t.includes('event: background')).length;
  assert.strictEqual(bg(got.member), 1);
  assert.strictEqual(bg(got.admin), 2);
});

test('status entries: background only when > 0, never on a worker entry', () => {
  // Source-level: loading lib/sdk-chat and calling getAgentStatuses would touch the hub's data/ folder (the data guard refuses it).
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(src, /background\.get\(name\) > 0\) out\[name\]\.background = background\.get\(name\)/);
  assert.match(src, /!out\[name\]\.worker && !\/\^tw-\/\.test\(name\)/);
  assert.match(src, /try \{ background = require\('\.\/background-work'\)\.getBackgroundWork\(\)\.counts\(\); \} catch \{\}/, 'a failing count never breaks the status feed');
});

// ── review r1 ──
test('r1: a member never reads the words of a target they may not see; an admin and a member with access do', async () => {
  const e = sources();
  e.hoRows = [ho('ho-1', 'agent-a', 'running', { target: 'private-t' })];
  e.shown = [{ ...ho('ho-1', 'agent-a', 'running', { target: 'private-t', folder: '/f/private-t/hand-offs/one', createdAt: T0 - 5000, topic: 'T' }), status: '## Next\nsecret words' }];
  e.mtimes = { '/f/private-t/hand-offs/one': '2026-11-23T11:55:00.000Z' };
  const row = async (viewer) => (await e.work.viewFor('agent-a', viewer)).handOffs[0];
  const denied = await row({ isAdmin: false, canSee: (n) => n !== 'private-t' });
  assert.strictEqual(denied.statusLine, null);
  assert.strictEqual(denied.changedAt, new Date(T0 - 5000).toISOString(), 'never the STATUS.md mtime');
  assert.ok(!('folder' in denied));
  assert.strictEqual(denied.target, 'private-t');
  assert.strictEqual(denied.topic, 'T');
  assert.strictEqual(denied.state, 'running');
  assert.ok(!JSON.stringify(denied).includes('secret words') && !JSON.stringify(denied).includes('hand-offs/one'));
  const noRule = await row({ isAdmin: false });
  assert.strictEqual(noRule.statusLine, null);
  for (const viewer of [{ isAdmin: true }, { isAdmin: false, canSee: () => true }]) {
    const r = await row(viewer);
    assert.strictEqual(r.statusLine, 'secret words');
    assert.strictEqual(r.changedAt, '2026-11-23T11:55:00.000Z');
    assert.strictEqual(r.folder, '/f/private-t/hand-offs/one');
  }
  // through the response helper the route uses
  const out = await BW.workingOnResponse('agent-a', { agentNames: ['agent-a'], viewer: { isAdmin: false, canSee: () => false }, work: e.work });
  assert.strictEqual(out.body.handOffs[0].statusLine, null);
  assert.ok(!('folder' in out.body.handOffs[0]));
});

test('r1: counts() is cached for 1 s; recheckAll computes fresh and refreshes the cache', () => {
  let t = T0, reads = 0;
  const e = sources({ now: () => t });
  e.hoRows = [ho('ho-1', 'agent-a', 'running')];
  const base = BW.createBackgroundWork({
    handOffs: { forCaller: (c) => e.hoRows.filter((r) => r.caller === c), all: () => { reads++; return e.hoRows; }, listShown: async () => [] },
    jobs: { list: () => [] }, workers: { listVirtual: () => [], getVirtual: () => null }, tasks: { list: () => [] },
    publish: (type, data) => e.published.push({ type, ...data }), now: () => t,
  });
  base.counts(); base.counts();
  assert.strictEqual(reads, 1, 'two reads within 1 s compute once');
  e.hoRows = [ho('ho-1', 'agent-a', 'running'), ho('ho-2', 'agent-a', 'running')];
  assert.strictEqual(base.counts().get('agent-a'), 1, 'still the cached answer');
  t += 1001;
  assert.strictEqual(base.counts().get('agent-a'), 2);
  assert.strictEqual(reads, 2);
  base.recheckAll();                                            // publishes count 2 (reads fresh)
  assert.strictEqual(reads, 3);
  assert.deepStrictEqual(e.published.at(-1), { type: 'background', agent: 'agent-a', count: 2 });
  e.hoRows = [];
  base.recheckAll();                                            // always fresh, even inside the window
  assert.strictEqual(reads, 4);
  assert.strictEqual(base.counts().has('agent-a'), false, 'the cache was refreshed by recheckAll');
  assert.strictEqual(reads, 4);
  assert.deepStrictEqual(e.published.at(-1), { type: 'background', agent: 'agent-a', count: 0 });
});

test('r1: a burst of recheckSoon calls runs recheckAll once, and a change is published', async () => {
  let reads = 0;
  const e = sources();
  e.hoRows = [ho('ho-1', 'agent-a', 'running')];
  const w = BW.createBackgroundWork({
    handOffs: { forCaller: (c) => e.hoRows.filter((r) => r.caller === c), all: () => { reads++; return e.hoRows; }, listShown: async () => [] },
    jobs: { list: () => [] }, workers: { listVirtual: () => [], getVirtual: () => null }, tasks: { list: () => [] },
    publish: (type, data) => e.published.push({ type, ...data }), now: () => T0,
  });
  for (let i = 0; i < 5; i++) w.recheckSoon();
  assert.strictEqual(reads, 0, 'nothing runs synchronously');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(reads, 1);
  assert.deepStrictEqual(e.published, [{ type: 'background', agent: 'agent-a', count: 1 }]);
  w.recheckSoon();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(reads, 2, 'a later call schedules again');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(src, /function backgroundRecheck\(\) \{ try \{ require\('\.\/background-work'\)\.getBackgroundWork\(\)\.recheckSoon\(\)/);
  assert.match(src, /temporalWorkers\.setChangeHook\(\(\) => backgroundRecheck\(\)\)/);
});
