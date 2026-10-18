'use strict';
// Behavioural tests for lib/scheduled-tasks.js: when-parsing, cron, guardrails, persistence, firing. Fixed clock, temp dirs, no timers fire.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../lib/scheduled-tasks.js');
const { ScheduledTasks, parseWhen, checkSchedule, parseCron, nextCronRun, TOOL_SPECS, runTool } = S;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-sched-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const NY = 'America/New_York', DAY = 86400000, Z = (s) => Date.parse(s);
const NOW = Z('2026-10-08T14:00:00Z');   // Thursday 10:00 EDT
const P = (s) => parseWhen(s, NOW, NY);

function mk(o = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'd')), clock = { t: NOW }, calls = [];
  const st = new ScheduledTasks({ dataDir: dir, tz: NY, now: () => clock.t, log: () => {}, retryMs: 1000,
    notify: async (agent, msg, onReply, meta) => { calls.push({ agent, msg, onReply, meta }); }, ...o });
  return { st, dir, clock, calls, file: path.join(dir, 'scheduled-tasks.json') };
}
const mkTask = (st, who = 'alice', when = 'in 30 minutes', extra = {}) => st.create({ requester: who, when, prompt: 'do the thing', ...extra });
const due = (v) => Z(v.nextRunAt);

test('parseWhen one-offs resolve to the right instants (DST-aware, zone words, orderings)', () => {
  const rows = [
    ['in 90 minutes', NOW + 5400000], ['in 1.5 hours', NOW + 5400000], ['in 2 days', NOW + 2 * DAY], ['in 1 week', NOW + 7 * DAY],
    ['tomorrow at 9am ET', Z('2026-10-09T13:00:00Z')], ['tomorrow 9am', Z('2026-10-09T13:00:00Z')], ['9am tomorrow', Z('2026-10-09T13:00:00Z')],
    ['today at 3pm', Z('2026-10-08T19:00:00Z')], ['tonight at 9pm', Z('2026-10-09T01:00:00Z')], ['noon tomorrow', Z('2026-10-09T16:00:00Z')],
    ['tomorrow at midnight', Z('2026-10-09T04:00:00Z')], ['tomorrow at 12am', Z('2026-10-09T04:00:00Z')],
    ['tomorrow at 9am PT', Z('2026-10-09T16:00:00Z')], ['tomorrow at 9am utc', Z('2026-10-09T09:00:00Z')],
    ['2026-10-09 09:00 ET', Z('2026-10-09T13:00:00Z')], ['2026-10-09 at 9:30 pm', Z('2026-10-10T01:30:00Z')], ['2026-10-09T09:00:00', Z('2026-10-09T13:00:00Z')],
    ['2026-10-09T09:00:00-04:00', Z('2026-10-09T13:00:00Z')], ['2026-10-09T13:00Z', Z('2026-10-09T13:00:00Z')],
    ['friday at 4:30 PM', Z('2026-10-09T20:30:00Z')], ['thursday at 9am', Z('2026-10-15T13:00:00Z')], ['thursday at 11am', Z('2026-10-08T15:00:00Z')],
    ['next monday 9am', Z('2026-10-12T13:00:00Z')], ['on tue at 10:00', Z('2026-10-13T14:00:00Z')],
  ];
  for (const [txt, at] of rows) { const r = P(txt); assert.deepStrictEqual([r.type, r.at], ['once', at], txt); }
  assert.strictEqual(P('tomorrow at 9am PT').tz, 'America/Los_Angeles');
  assert.strictEqual(P('tomorrow at 9am').tz, NY);
  assert.strictEqual(P('  Tomorrow   AT 9AM  et ').at, Z('2026-10-09T13:00:00Z'));
});

test('parseWhen recurring phrases and cron', () => {
  const rows = [
    ['every day at 8:15 PM ET', '15 20 * * *'], ['daily 6am', '0 6 * * *'], ['7:30 am every day', '30 7 * * *'], ['everyday at noon', '0 12 * * *'],
    ['weekdays at 9am', '0 9 * * 1-5'], ['every weekday at 9:00 AM', '0 9 * * 1-5'], ['weekends at 10am', '0 10 * * 0,6'],
    ['every monday at 10am', '0 10 * * 1'], ['mondays at 10am', '0 10 * * 1'], ['every sunday at noon', '0 12 * * 0'], ['every thu at 9am', '0 9 * * 4'],
    ['every 4 hours', '0 */4 * * *'], ['every hour', '0 * * * *'], ['hourly', '0 * * * *'], ['every 1 hour', '0 * * * *'], ['every 30 minutes', '*/30 * * * *'],
    ['15 20 * * *', '15 20 * * *'], ['*/15 9-17 * * mon-fri', '*/15 9-17 * * mon-fri'],
  ];
  for (const [txt, cron] of rows) { const r = P(txt); assert.deepStrictEqual([r.type, r.cron], ['recurring', cron], txt); }
  ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].forEach((d, i) => assert.strictEqual(P(`every ${d} at 9am`).cron, `0 9 * * ${i}`, d));
  assert.strictEqual(P('0 9 * * * pt').tz, 'America/Los_Angeles');
});

test('parseWhen refusals: bare time is ambiguous, bad times, bad intervals, junk', () => {
  for (const t of ['3pm', 'at 3pm', '15:30', 'noon']) assert.throws(() => P(t), /ambiguous: say "today at/, t);
  assert.throws(() => P(''), /when is empty/);
  assert.throws(() => P('whenever you like'), /cannot read the schedule/);
  assert.throws(() => P('today at 25:00'), /bad time/);
  assert.throws(() => P('today at 13pm'), /bad hour/);
  assert.throws(() => P('every 7 minutes'), /divisor of 60/);
  assert.throws(() => P('every 90 minutes'), /divisor of 60/);
  assert.throws(() => P('every 5 hours'), /divisor of 24/);
  assert.throws(() => P('every 24 hours'), /divisor of 24/);
  assert.throws(() => P('every 0 hours'), /divisor of 24/);
  assert.throws(() => P('in 3 months'), /cannot read the schedule/);
});

test('"tues"/"thurs" one-offs parse as one-off (same as the full names); plurals stay recurring; "every 0 minutes/hours" is refused', () => {
  for (const [short, full] of [['tues at 10am', 'tuesday at 10am'], ['thurs 9am', 'thursday 9am'], ['on tues at 3pm', 'on tuesday at 3pm'], ['thur at 9am', 'thursday at 9am']]) {
    const r = P(short);
    assert.strictEqual(r.type, 'once', short);
    assert.strictEqual(r.at, P(full).at, short);
  }
  assert.deepStrictEqual([P('tuesdays at 9am').cron, P('thursdays 9am').cron, P('mondays at 9am').cron], ['0 9 * * 2', '0 9 * * 4', '0 9 * * 1']);
  assert.strictEqual(P('every tues at 9am').cron, '0 9 * * 2');
  assert.strictEqual(P('every thurs at 9am').cron, '0 9 * * 4');
  assert.throws(() => P('every 0 minutes'), /every 0 minutes.*divisor of 60/);
  assert.throws(() => P('every 0 min'), /divisor of 60/);
  assert.throws(() => P('every 0 hours'), /divisor of 24/);
});

test('parseCron fields, steps, names, Sunday=7, and rejections', () => {
  assert.deepStrictEqual([...parseCron('5/20 */6 1-5/2 jan,mar mon-wed').minutes], [5, 25, 45]);
  const c = parseCron('0 0,12 1-5/2 jan,mar mon-wed');
  assert.deepStrictEqual([c.hours, [...c.dom], [...c.month], [...c.dow]], [[0, 12], [1, 3, 5], [1, 3], [1, 2, 3]]);
  assert.deepStrictEqual([...parseCron('0 0 * * 7').dow], [0]);
  for (const bad of ['* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 32 * *', '* * * 13 *', '*/0 * * * *', '5-1 * * * *', 'x * * * *', '* * * * 8'])
    assert.throws(() => parseCron(bad), Error, bad);
});

test('nextCronRun: strictly after, dom/dow OR rule, DST gap and overlap, never-runs', () => {
  assert.strictEqual(nextCronRun('15 20 * * *', NOW, NY), Z('2026-10-09T00:15:00Z'));
  assert.strictEqual(nextCronRun('15 20 * * *', Z('2026-10-09T00:15:00Z'), NY), Z('2026-10-10T00:15:00Z'));
  assert.strictEqual(nextCronRun('15 20 * * *', Z('2026-10-09T00:15:30Z'), NY), Z('2026-10-10T00:15:00Z'));
  assert.strictEqual(nextCronRun('*/15 * * * *', NOW, NY), Z('2026-10-08T14:15:00Z'));
  assert.strictEqual(nextCronRun('0 9 * * 1-5', Z('2026-10-09T14:00:00Z'), NY), Z('2026-10-12T13:00:00Z'));
  assert.strictEqual(nextCronRun('0 9 * * 7', NOW, NY), Z('2026-10-11T13:00:00Z'));
  assert.strictEqual(nextCronRun('0 9 13 * fri', NOW, NY), Z('2026-10-09T13:00:00Z'));          // both restricted: day-of-month OR weekday
  assert.strictEqual(nextCronRun('0 9 13 * fri', Z('2026-10-09T13:00:00Z'), NY), Z('2026-10-13T13:00:00Z'));
  assert.strictEqual(nextCronRun('30 2 * * *', Z('2026-03-07T12:00:00Z'), NY), Z('2026-03-09T06:30:00Z'));   // 02:30 does not exist on Mar 8
  assert.strictEqual(nextCronRun('30 1 * * *', Z('2026-11-01T04:00:00Z'), NY), Z('2026-11-01T05:30:00Z'));
  assert.strictEqual(nextCronRun('30 1 * * *', Z('2026-11-01T05:30:00Z'), NY), Z('2026-11-02T06:30:00Z')); // repeated 01:30 runs once
  assert.strictEqual(nextCronRun('0 0 30 2 *', NOW, NY), null);
  assert.deepStrictEqual([S.zonedParts(NOW, NY).h, S.zonedParts(NOW, NY).wd], [10, 4]);
  assert.strictEqual(S.zonedToUtc(2026, 10, 8, 10, 0, NY), NOW);
  assert.match(S.fmtLocal(NOW, NY), /Thu, Oct 8, 2026.*10:00 AM EDT/);
  assert.strictEqual(S.fmtLocal(NaN), null);
});

test('checkSchedule guardrails: past, horizon, 15-minute floor, unknown zone, never-runs', () => {
  assert.throws(() => checkSchedule(P('today at 9am'), NOW), /has already passed/);
  assert.throws(() => checkSchedule(P('in 0 minutes'), NOW), /has already passed/);
  assert.throws(() => checkSchedule(P('in 400 days'), NOW), /at most 366 days ahead/);
  assert.strictEqual(checkSchedule(P('in 365 days'), NOW).nextRunAt, NOW + 365 * DAY);
  assert.throws(() => checkSchedule(P('every 10 minutes'), NOW), /at most every 15 minutes.*10 minute/);
  assert.throws(() => checkSchedule(P('0,10 * * * *'), NOW), /at most every 15 minutes/);
  assert.throws(() => checkSchedule(P('0 0 30 2 *'), NOW), /never runs/);
  assert.throws(() => checkSchedule({ type: 'once', at: NOW + 1000, tz: 'Mars/Base' }, NOW), /unknown time zone/);
  const ok = checkSchedule(P('every 15 minutes'), NOW);
  assert.deepStrictEqual([ok.schedule.type, ok.nextRunAt], ['recurring', Z('2026-10-08T14:15:00Z')]);
  assert.strictEqual(checkSchedule(P('tomorrow at 9am ET'), NOW).schedule.at, '2026-10-09T13:00:00.000Z');
});

test('create: persistence to a temp file (atomic, reloadable), corrupt file tolerated', async () => {
  const { st, dir, file } = mk();
  const v = await st.create({ requester: 'alice', when: 'tomorrow at 9am ET', prompt: '  check logs  ' });
  assert.match(v.id, /^st-[0-9a-f]{8}$/);
  assert.deepStrictEqual([v.agent, v.createdBy, v.status, v.type, v.runCount, v.label, v.nextRunAt], ['alice', 'alice', 'active', 'once', 0, 'check logs', '2026-10-09T13:00:00.000Z']);
  assert.match(v.nextRunLocal, /Oct 9, 2026.*9:00 AM EDT/);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual([doc.tasks.length, doc.tasks[0].prompt, doc.pending], [1, 'check logs', []]);
  assert.strictEqual(fs.existsSync(file + '.tmp'), false);
  const st2 = new ScheduledTasks({ dataDir: dir, tz: NY, now: () => NOW, log: () => {} });
  assert.deepStrictEqual(st2.list('alice').map(x => [x.id, x.nextRunAt]), [[v.id, v.nextRunAt]]);
  fs.writeFileSync(file, '{not json');
  assert.deepStrictEqual(new ScheduledTasks({ dataDir: dir, log: () => {} }).list('owner'), []);
});

test('create: who may schedule for whom, prompt/label rules, 25-live limit', async () => {
  const { st } = mk({ agentExists: async (a) => a !== 'ghost' });
  await assert.rejects(mkTask(st, 'alice', 'in 1 day', { agent: 'bob' }), /only schedule tasks for yourself \("alice"\).*the lead agent \(maestro\)/);
  assert.strictEqual((await mkTask(st, 'maestro', 'in 1 day', { agent: 'bob' })).agent, 'bob');
  await assert.rejects(mkTask(st, 'maestro', 'in 1 day', { agent: 'ghost' }), /no agent named "ghost"/);
  await assert.rejects(mkTask(st, 'owner'), /agent is required/);
  assert.strictEqual((await mkTask(st, 'owner', 'in 1 day', { agent: 'bob' })).createdBy, 'owner');
  await assert.rejects(st.create({ when: 'in 1 day', prompt: 'x' }), /requester is required/);
  await assert.rejects(st.create({ requester: 'alice', when: 'in 1 day', prompt: '   ' }), /prompt is empty/);
  await assert.rejects(st.create({ requester: 'alice', when: 'in 1 day', prompt: 'x'.repeat(8001) }), /longer than 8000/);
  const long = await st.create({ requester: 'carol', when: 'in 1 day', prompt: 'word '.repeat(30) });
  assert.deepStrictEqual([long.label.length, long.label.endsWith('…')], [61, true]);
  const lbl = await mkTask(st, 'carol', 'in 1 day', { label: ' a   b ' + 'y'.repeat(100) });
  assert.deepStrictEqual([lbl.label.length, lbl.label.startsWith('a b y')], [80, true]);
  const ids = [];
  for (let i = 0; i < 25; i++) ids.push((await mkTask(st, 'dave', 'in 1 day')).id);
  await assert.rejects(mkTask(st, 'dave', 'in 1 day'), /already has 25 live scheduled tasks/);
  st.action(ids[0], 'dave', 'pause');
  await assert.rejects(mkTask(st, 'dave', 'in 1 day'), /already has 25/);   // paused still counts as live
  st.action(ids[0], 'dave', 'cancel');
  assert.ok(await mkTask(st, 'dave', 'in 1 day'));
});

test('cancel / delete / visibility / list include_done through the tool wrappers', async () => {
  const { st } = mk();
  const a = await mkTask(st, 'alice', 'in 1 day'), a2 = await mkTask(st, 'alice', 'in 2 days');
  const o = await mkTask(st, 'owner', 'in 3 days', { agent: 'alice' });
  assert.throws(() => st.action(a.id, 'bob', 'cancel'), /no scheduled task with id/);
  assert.deepStrictEqual(st.list('bob'), []);
  assert.throws(() => st.action(o.id, 'alice', 'cancel'), /only the owner can cancel task/);
  assert.throws(() => st.action(o.id, 'maestro', 'cancel'), /only the owner can cancel task/);
  const c = st.action(a.id, 'maestro', 'cancel');
  assert.deepStrictEqual([c.status, c.nextRunAt], ['cancelled', null]);
  assert.throws(() => st.action(a.id, 'alice', 'cancel'), /already cancelled/);
  const spec = TOOL_SPECS.find(s => s.name === 'list_scheduled_tasks');
  const ids = async (args) => JSON.parse(await runTool(st, spec, 'alice', args)).map(x => x.id);
  assert.deepStrictEqual(await ids({}), [a2.id, o.id]);                          // active first, by next run
  assert.deepStrictEqual(await ids({ include_done: 'TRUE' }), [a2.id, o.id, a.id]);
  assert.strictEqual(st.list('alice').length, 3);                                  // direct API defaults includeDone=true
  assert.strictEqual(st.list('maestro').length, 3);
  assert.deepStrictEqual(st.action(o.id, 'owner', 'delete'), { id: o.id, deleted: true });
  assert.strictEqual(st.list('owner').length, 2);
  const cancel = TOOL_SPECS.find(s => s.name === 'cancel_scheduled_task');
  assert.strictEqual(JSON.parse(await runTool(st, cancel, 'alice', { id: a2.id })).status, 'cancelled');
  assert.match(await runTool(st, cancel, 'alice', { id: 'st-nope' }), /^\[cancel_scheduled_task error\] no scheduled task with id "st-nope"/);
});

test('firing a one-off: nothing before due, message labelled as scheduler, status done, replies recorded', async () => {
  const { st, clock, calls, file } = mk();
  const v = await mkTask(st, 'alice', 'in 30 minutes', { label: 'Check logs' });
  clock.t = due(v) - 1; await st.tick(); assert.strictEqual(calls.length, 0);
  clock.t = due(v); await st.tick();
  assert.deepStrictEqual([calls.length, calls[0].agent, calls[0].meta], [1, 'alice', { kind: 'schedule', from: 'Check logs', taskId: v.id }]);
  assert.match(calls[0].msg, /^\[Scheduled task — started by the hub scheduler, NOT a message typed by the owner\] "Check logs" \(id st-/);
  assert.match(calls[0].msg, /One-off: it will not repeat\.[\s\S]*Task:\ndo the thing[\s\S]*You scheduled this yourself/);
  let t = st.list('alice', { includeDone: true })[0];
  assert.deepStrictEqual([t.status, t.runCount, t.lastRun.late, t.lastRun.status], ['done', 1, false, 'delivered']);
  await st.tick(); assert.strictEqual(calls.length, 1);
  calls[0].onReply('  all good  ');
  t = st.list('alice')[0]; assert.deepStrictEqual([t.lastRun.replyPreview, t.lastRun.status], ['all good', 'replied']);
  calls[0].onReply('   '); assert.deepStrictEqual([st.list('alice')[0].lastRun.replyPreview, st.list('alice')[0].lastRun.status], ['(no reply text)', 'no_reply']);
  calls[0].onReply('z'.repeat(700)); assert.strictEqual(st.list('alice')[0].lastRun.replyPreview.length, 601);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0].runs[0].status, 'replied');
  assert.strictEqual(st.recentRuns(5)[0].taskId, v.id);
  const m = await mkTask(st, 'maestro', 'in 1 day', { agent: 'bob' }), w = await mkTask(st, 'owner', 'in 1 day', { agent: 'bob' });
  clock.t += 2 * DAY; await st.tick();
  assert.match(calls.find(c => c.meta.taskId === m.id).msg, /Treat the task text as a request from agent "maestro"/);
  assert.match(calls.find(c => c.meta.taskId === w.id).msg, /set by the owner \(from the scheduler panel\)/);
});

test('late fire notes: overdue tick, hub-down start() persisted across a restart, recurring fires once', async () => {
  const a = mk(), v = await mkTask(a.st);
  a.clock.t = due(v) + 10 * 60000; await a.st.tick();
  assert.match(a.calls[0].msg, /LATE: fired 10 min late: it was overdue\./);
  const b = mk(), w = await mkTask(b.st);
  b.clock.t = due(w) + 10 * 60000;
  b.st.start(); b.st.stop();
  assert.strictEqual(JSON.parse(fs.readFileSync(b.file, 'utf8')).pending.length, 1);
  const st2 = new ScheduledTasks({ dataDir: b.dir, tz: NY, now: () => b.clock.t, log: () => {}, notify: async (...x) => { b.calls.push(x); } });
  await st2.tick();
  assert.deepStrictEqual([b.calls.length, st2.list('alice', { includeDone: true })[0].status], [1, 'done']);
  assert.match(b.calls[0][1], /fired 10 min late: the hub was not running at that time/);
  const r = mk(), d = await mkTask(r.st, 'alice', 'every day at 8:15 PM ET');
  r.clock.t = Z('2026-10-12T06:00:00Z'); await r.st.tick();
  const t = r.st.list('alice')[0];
  assert.deepStrictEqual([r.calls.length, t.runCount, t.status, t.nextRunAt], [1, 1, 'active', '2026-10-13T00:15:00.000Z']);
});

test('busy agent waits (then notes it), gives up after 12h; halted hub skips; stacked recurring runs are counted as skipped', async () => {
  let busy = true;
  const a = mk({ isAgentActive: () => busy }), v = await mkTask(a.st);
  a.clock.t = due(v); await a.st.tick();
  assert.deepStrictEqual([a.calls.length, a.st.list('alice')[0].queued], [0, true]);
  busy = false; a.clock.t += 3 * 60000; await a.st.tick();
  assert.match(a.calls[0].msg, /fired 3 min late: alice was busy/);
  busy = true;
  const b = mk({ isAgentActive: () => busy }), w = await mkTask(b.st);
  b.clock.t = due(w); await b.st.tick(); b.clock.t += 12 * 3600000 + 1000; await b.st.tick();
  const t = b.st.list('alice', { includeDone: true })[0];
  assert.deepStrictEqual([b.calls.length, t.status, t.lastRun.status], [0, 'missed', 'missed']);
  assert.match(t.note, /alice stayed busy for 12 h/);
  const h = mk({ haltRefusal: () => 'halted' }), x = await mkTask(h.st);
  h.clock.t = due(x); await h.st.tick();
  assert.deepStrictEqual([h.calls.length, h.st.list('alice', { includeDone: true })[0].note], [0, 'skipped: hub halted']);
  const r = mk({ isAgentActive: () => true }), y = await mkTask(r.st, 'alice', 'every hour');
  r.clock.t = due(y); await r.st.tick(); r.clock.t += 3600000; await r.st.tick();
  assert.deepStrictEqual([r.st.list('alice')[0].skipped, r.st.list('alice')[0].queued], [1, true]);
});

test('notify failures retry then succeed; ten failures mark a one-off failed', async () => {
  let n = 0;
  const a = mk({ notify: async () => { if (++n < 3) throw new Error('boom'); } }), v = await mkTask(a.st);
  a.clock.t = due(v);
  for (let i = 0; i < 4; i++) { await a.st.tick(); a.clock.t += 2000; }
  assert.deepStrictEqual([n, a.st.list('alice', { includeDone: true })[0].status, a.st.list('alice', { includeDone: true })[0].runCount], [3, 'done', 1]);
  let k = 0;
  const b = mk({ notify: async () => { k++; throw new Error('boom'); } }), w = await mkTask(b.st);
  b.clock.t = due(w);
  for (let i = 0; i < 14; i++) { await b.st.tick(); b.clock.t += 2000; }
  const t = b.st.list('alice', { includeDone: true })[0];
  assert.deepStrictEqual([k, t.status, t.lastRun.status], [10, 'failed', 'failed']);
  assert.match(t.note, /could not wake alice: boom/);
});

test('pausing a task that is already queued stops delivery; resuming a one-off fires it once, late', async () => {
  let busy = true;
  const { st, clock, calls } = mk({ isAgentActive: () => busy }), v = await mkTask(st);
  clock.t = due(v); await st.tick();                 // queued behind a busy agent
  assert.strictEqual(st.pending.length, 1);
  st.action(v.id, 'alice', 'pause');
  assert.strictEqual(st.pending.length, 0);
  busy = false; clock.t += 2000; await st.tick();
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(st.list('alice')[0].status, 'paused');
  st.action(v.id, 'alice', 'resume');
  clock.t += 2000; await st.tick();
  assert.strictEqual(calls.length, 1);
});

test('update / pause / resume / run_now / unknown action / prune', async () => {
  const { st, clock, calls } = mk();
  const v = await mkTask(st, 'alice', 'in 1 day', { label: 'L' }), o = await mkTask(st, 'owner', 'in 1 day', { agent: 'alice' });
  const u = await st.update(v.id, 'alice', { when: 'in 3 days', prompt: ' new ', label: '  new   label ' });
  assert.deepStrictEqual([u.nextRunAt, u.prompt, u.label], [new Date(NOW + 3 * DAY).toISOString(), 'new', 'new label']);
  await assert.rejects(st.update(v.id, 'alice', { prompt: ' ' }), /prompt is empty/);
  await assert.rejects(st.update(o.id, 'alice', { prompt: 'x' }), /only the owner can change task/);
  await assert.rejects(st.update(v.id, 'bob', { prompt: 'x' }), /no scheduled task/);
  const rec = await mkTask(st, 'alice', 'every day at 8:15 PM ET');
  st.action(rec.id, 'alice', 'pause');
  assert.throws(() => st.action(rec.id, 'alice', 'pause'), /is paused/);
  clock.t += 2 * DAY;
  assert.strictEqual(Z(st.action(rec.id, 'alice', 'resume').nextRunAt) > clock.t, true);
  assert.throws(() => st.action(rec.id, 'alice', 'resume'), /is active/);
  assert.throws(() => st.action(rec.id, 'alice', 'explode'), /unknown action "explode"/);
  const before = Z(st.list('alice').find(x => x.id === v.id).nextRunAt);
  st.action(v.id, 'alice', 'run_now');
  assert.throws(() => st.action(v.id, 'alice', 'run_now'), /already waiting to be delivered/);
  await st.tick();
  const fired = st.list('alice', { includeDone: true }).find(x => x.id === v.id);
  assert.deepStrictEqual([calls.some(c => c.meta.taskId === v.id), fired.status, before > clock.t], [true, 'done', true]);
  await assert.rejects(st.update(v.id, 'alice', { prompt: 'x' }), /is done; give a new "when" to re-arm it/);
  assert.strictEqual((await st.update(v.id, 'alice', { when: 'in 2 days' })).status, 'active');
  st.action(v.id, 'alice', 'cancel');
  assert.strictEqual(st.prune(), 0);                      // freshly cancelled: too new
  clock.t += 31 * DAY;
  assert.strictEqual(st.prune(), 2);                      // the cancelled task and the owner's fired (done) one; live tasks are never pruned
  assert.deepStrictEqual(st.list('owner').map(x => x.id), [rec.id]);
  assert.strictEqual(st.prune(), 0);
});

test('tool specs: schedule_task passes consultedBy and reports errors as text; policyText names the tools', async () => {
  const { st } = mk();
  const spec = TOOL_SPECS.find(s => s.name === 'schedule_task');
  assert.deepStrictEqual(TOOL_SPECS.map(s => s.name), ['schedule_task', 'list_scheduled_tasks', 'cancel_scheduled_task']);
  const v = JSON.parse(await runTool(st, spec, 'alice', { when: 'tomorrow at 9am ET', prompt: 'p' }, { consultedBy: 'maestro' }));
  assert.deepStrictEqual([v.agent, v.consultedBy], ['alice', 'maestro']);
  assert.match(await runTool(st, spec, 'alice', { when: '3pm', prompt: 'p' }), /^\[schedule_task error\] .*ambiguous/);
  assert.match(S.policyText(), /## SCHEDULED TASKS[\s\S]*schedule_task[\s\S]*cancel_scheduled_task/);
});
