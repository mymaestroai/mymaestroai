'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const st = require('../lib/scheduled-tasks');

const NY = 'America/New_York';
const T0 = Date.parse('2026-09-29T18:00:00Z');   // Tue 2:00 PM EDT
const local = (ms) => st.fmtLocal(ms, NY);

function mk(o = {}) {
  const dataDir = o.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
  const clock = { t: o.now || T0 };
  const woken = [];
  const busy = new Set();
  const inst = new st.ScheduledTasks({
    dataDir, now: () => clock.t, log: () => {}, retryMs: 1000, pollMs: 60000,
    agentExists: async (n) => ['trader', 'maestro', 'worker', 'agent-lead'].includes(n),
    isAgentActive: (a) => busy.has(a),
    isPrivileged: o.isPrivileged, leadNames: o.leadNames,
    notify: o.notify || (async (agent, message, onReply, meta) => { woken.push({ agent, message, meta }); if (onReply) onReply(`done: ${agent}`); }),
  });
  return { inst, clock, woken, busy, dataDir };
}

// ── parsing ─────────────────────────────────────────────────────────────
test('parseWhen: one-off forms resolve to the right instant (Eastern by default)', () => {
  const at = (w) => st.parseWhen(w, T0).at;
  assert.strictEqual(at('in 90 minutes'), T0 + 90 * 60000);
  assert.strictEqual(at('in 2 days'), T0 + 2 * 86400000);
  assert.strictEqual(new Date(at('tomorrow at 9am ET')).toISOString(), '2026-09-30T13:00:00.000Z');
  assert.strictEqual(new Date(at('2026-10-01 14:00')).toISOString(), '2026-10-01T18:00:00.000Z');
  assert.strictEqual(new Date(at('2026-10-01T09:00:00Z')).toISOString(), '2026-10-01T09:00:00.000Z');
  assert.strictEqual(new Date(at('today at 11pm pt')).toISOString(), '2026-09-30T06:00:00.000Z');
  assert.strictEqual(new Date(at('friday at 4:30 PM')).toISOString(), '2026-10-02T20:30:00.000Z');
  // The same weekday later today is today; earlier today is next week.
  assert.strictEqual(new Date(at('tuesday at 5pm')).toISOString(), '2026-09-29T21:00:00.000Z');
  assert.strictEqual(new Date(at('tuesday at 9am')).toISOString(), '2026-10-06T13:00:00.000Z');
});

test('parseWhen: recurring forms become cron in the right zone', () => {
  const c = (w) => { const r = st.parseWhen(w, T0); assert.strictEqual(r.type, 'recurring', w); return r.cron; };
  assert.strictEqual(c('every day at 8:15 PM ET'), '15 20 * * *');
  assert.strictEqual(c('daily at 7am'), '0 7 * * *');
  assert.strictEqual(c('weekdays at 9:00 AM'), '0 9 * * 1-5');
  assert.strictEqual(c('every monday at 10am'), '0 10 * * 1');
  assert.strictEqual(c('wednesdays at noon'), '0 12 * * 3');
  assert.strictEqual(c('every 4 hours'), '0 */4 * * *');
  assert.strictEqual(c('15 20 * * *'), '15 20 * * *');
  assert.strictEqual(st.parseWhen('every day at 8am pt', T0).tz, 'America/Los_Angeles');
});

test('parseWhen: a bare time is refused as ambiguous; junk is refused with examples', () => {
  assert.throws(() => st.parseWhen('3pm', T0), /ambiguous/);
  assert.throws(() => st.parseWhen('8:15 PM ET', T0), /ambiguous/);
  assert.throws(() => st.parseWhen('whenever you feel like it', T0), /cannot read the schedule.*One-off/);
  assert.throws(() => st.parseWhen('', T0), /empty/);
  assert.throws(() => st.parseWhen('61 * * * *', T0), /out of range/);
});

test('checkSchedule: past one-offs, far horizons and too-frequent recurrences are refused', () => {
  const chk = (w) => st.checkSchedule(st.parseWhen(w, T0), T0);
  assert.throws(() => chk('2026-09-29 09:00'), /already passed/);
  assert.throws(() => chk('in 400 days'), /at most 366 days/);
  assert.throws(() => chk('every 5 minutes'), /at most every 15 minutes/);
  assert.throws(() => chk('*/10 * * * *'), /at most every 15 minutes/);
  assert.throws(() => chk('0,5 9 * * *'), /at most every 15 minutes/);
  assert.throws(() => chk('0 0 30 2 *'), /never runs/);
  assert.ok(chk('every 15 minutes'));
});

test('nextCronRun: DST-correct in America/New_York', () => {
  // EDT -> EST on 2026-11-01. 8:15 PM ET is 00:15Z before and 01:15Z after.
  const before = st.nextCronRun('15 20 * * *', Date.parse('2026-10-31T12:00:00Z'), NY);
  const after = st.nextCronRun('15 20 * * *', Date.parse('2026-11-01T12:00:00Z'), NY);
  assert.strictEqual(new Date(before).toISOString(), '2026-11-01T00:15:00.000Z');
  assert.strictEqual(new Date(after).toISOString(), '2026-11-02T01:15:00.000Z');
  // 2:30 AM does not exist on 2027-03-14 (spring forward): skipped to the next day.
  const gap = st.nextCronRun('30 2 * * *', Date.parse('2027-03-14T05:00:00Z'), NY);
  assert.strictEqual(new Date(gap).toISOString(), '2027-03-15T06:30:00.000Z');
  // Standard cron: dom and dow both restricted = either matches.
  const either = st.nextCronRun('0 9 1 * 1', T0, NY);   // Oct 1 is a Thursday -> matches by dom
  assert.strictEqual(new Date(either).toISOString(), '2026-10-01T13:00:00.000Z');
});

// ── permissions and caps ────────────────────────────────────────────────
test('agents schedule only for themselves; maestro and the owner for anyone', async () => {
  const { inst } = mk();
  await assert.rejects(inst.create({ requester: 'trader', agent: 'worker', when: 'in 1 hour', prompt: 'x' }), /only schedule tasks for yourself/);
  const a = await inst.create({ requester: 'trader', when: 'in 1 hour', prompt: 'check the funding rate' });
  assert.strictEqual(a.agent, 'trader'); assert.strictEqual(a.createdBy, 'trader');
  const b = await inst.create({ requester: 'maestro', agent: 'trader', when: 'in 2 hours', prompt: 'follow up' });
  assert.strictEqual(b.createdBy, 'maestro');
  const c = await inst.create({ requester: st.OWNER, agent: 'worker', when: 'in 2 hours', prompt: 'y' });
  assert.strictEqual(c.createdBy, 'owner');
  await assert.rejects(inst.create({ requester: 'maestro', agent: 'nobody', when: 'in 1 hour', prompt: 'x' }), /no agent named/);
  await assert.rejects(inst.create({ requester: st.OWNER, when: 'in 1 hour', prompt: 'x' }), /agent is required/);
});

test('cancel: creator or owner; maestro not for owner tasks; target agent not for tasks others set', async () => {
  const { inst } = mk();
  const own = await inst.create({ requester: st.OWNER, agent: 'trader', when: 'in 1 hour', prompt: 'x' });
  const mae = await inst.create({ requester: 'maestro', agent: 'trader', when: 'in 1 hour', prompt: 'x' });
  const self = await inst.create({ requester: 'trader', when: 'in 1 hour', prompt: 'x' });
  assert.throws(() => inst.action(own.id, 'maestro', 'cancel'), /only the owner/);
  assert.throws(() => inst.action(mae.id, 'trader', 'cancel'), /only "maestro"/);
  assert.throws(() => inst.action(self.id, 'worker', 'cancel'), /no scheduled task/);   // not even visible
  assert.strictEqual(inst.action(self.id, 'trader', 'cancel').status, 'cancelled');
  assert.strictEqual(inst.action(mae.id, 'maestro', 'cancel').status, 'cancelled');
  assert.strictEqual(inst.action(own.id, st.OWNER, 'cancel').status, 'cancelled');
});

test('isPrivileged: a lead not named maestro schedules for and manages others; a worker cannot', async () => {
  const leads = ['agent-lead'];
  const { inst } = mk({ isPrivileged: (a) => a === 'maestro' || leads.includes(a), leadNames: () => leads });
  const t = await inst.create({ requester: 'agent-lead', agent: 'trader', when: 'in 1 hour', prompt: 'x' });
  assert.strictEqual(t.createdBy, 'agent-lead');
  await assert.rejects(inst.create({ requester: 'worker', agent: 'trader', when: 'in 1 hour', prompt: 'x' }),
    /only schedule tasks for yourself \("worker"\); ask the lead agent \(agent-lead\) or the owner/);
  const self = await inst.create({ requester: 'trader', when: 'in 1 hour', prompt: 'x' });
  assert.strictEqual(inst.list('agent-lead').length, 2);                      // sees tasks it did not set
  assert.strictEqual(inst.action(self.id, 'agent-lead', 'cancel').status, 'cancelled');
  // Legacy: maestro stays privileged even when it is not the primary agent.
  assert.strictEqual((await inst.create({ requester: 'maestro', agent: 'worker', when: 'in 1 hour', prompt: 'y' })).createdBy, 'maestro');
});

test('isPrivileged defaults to maestro only (no injection)', async () => {
  const { inst } = mk();
  await assert.rejects(inst.create({ requester: 'agent-lead', agent: 'trader', when: 'in 1 hour', prompt: 'x' }),
    /ask the lead agent \(maestro\) or the owner/);
  assert.strictEqual((await inst.create({ requester: 'maestro', agent: 'trader', when: 'in 1 hour', prompt: 'x' })).createdBy, 'maestro');
  assert.match(st.TOOL_SPECS.find(s => s.name === 'schedule_task').params.agent.description, /lead agent \(marked Lead in its settings\)/);
});

test('visibility: an agent lists tasks that wake it or that it created', async () => {
  const { inst } = mk();
  await inst.create({ requester: 'trader', when: 'in 1 hour', prompt: 'a' });
  await inst.create({ requester: 'maestro', agent: 'worker', when: 'in 1 hour', prompt: 'b' });
  assert.deepStrictEqual(inst.list('trader').map(t => t.prompt), ['a']);
  assert.deepStrictEqual(inst.list('worker').map(t => t.prompt), ['b']);
  assert.strictEqual(inst.list('maestro').length, 2);
  assert.strictEqual(inst.list(st.OWNER).length, 2);
});

test('cap: at most MAX_TASKS_PER_AGENT live tasks per agent; cancelled ones do not count', async () => {
  const { inst } = mk();
  const ids = [];
  for (let i = 0; i < st.MAX_TASKS_PER_AGENT; i++) ids.push((await inst.create({ requester: 'trader', when: `in ${i + 1} hours`, prompt: `t${i}` })).id);
  await assert.rejects(inst.create({ requester: 'trader', when: 'in 30 hours', prompt: 'one too many' }), /limit 25/);
  inst.action(ids[0], 'trader', 'cancel');
  assert.ok(await inst.create({ requester: 'trader', when: 'in 30 hours', prompt: 'fits now' }));
});

// ── firing ──────────────────────────────────────────────────────────────
test('one-off fires once when due, labelled as scheduled (not the owner), reply captured', async () => {
  const { inst, clock, woken } = mk();
  const t = await inst.create({ requester: 'maestro', agent: 'trader', when: 'in 10 minutes', prompt: 'Follow up on the HYPE pair.', label: 'HYPE follow-up' });
  await inst.tick(); assert.strictEqual(woken.length, 0);
  clock.t += 10 * 60000; await inst.tick();
  assert.strictEqual(woken.length, 1);
  const w = woken[0];
  assert.strictEqual(w.agent, 'trader');
  assert.match(w.message, /^\[Scheduled task — started by the hub scheduler, NOT a message typed by the owner\] "HYPE follow-up"/);
  assert.match(w.message, /set by agent "maestro"/);
  assert.match(w.message, /Follow up on the HYPE pair\./);
  assert.doesNotMatch(w.message, /LATE/);
  assert.deepStrictEqual(w.meta, { kind: 'schedule', from: 'HYPE follow-up', taskId: t.id });
  const v = inst.list(st.OWNER)[0];
  assert.strictEqual(v.status, 'done'); assert.strictEqual(v.runCount, 1);
  assert.strictEqual(v.lastRun.status, 'replied'); assert.strictEqual(v.lastRun.replyPreview, 'done: trader');
  clock.t += 3600000; await inst.tick();
  assert.strictEqual(woken.length, 1, 'never fires twice');
});

test('recurring advances to the next run; delivery waits while the agent is busy, then fires marked late', async () => {
  const { inst, clock, woken, busy } = mk();
  const t = await inst.create({ requester: 'trader', when: 'every day at 8:15 PM ET', prompt: 'daily review' });
  assert.strictEqual(t.nextRunLocal, local(Date.parse('2026-09-30T00:15:00Z')));
  clock.t = Date.parse('2026-09-30T00:15:05Z');
  busy.add('trader');
  await inst.tick();
  assert.strictEqual(woken.length, 0, 'waits while busy (no silent skip)');
  const v = inst.list('trader')[0];
  assert.strictEqual(v.queued, true);
  assert.strictEqual(v.nextRunAt, '2026-10-01T00:15:00.000Z', 'already advanced to tomorrow');
  clock.t += 10 * 60000; busy.delete('trader');
  await inst.tick();
  assert.strictEqual(woken.length, 1);
  assert.match(woken[0].message, /LATE: fired 10 min late: trader was busy/);
  assert.match(woken[0].message, /You scheduled this yourself/);
  assert.match(woken[0].message, /Recurring \(every day at 8:15 PM ET\); next run Wed, Sep 30, 2026, 8:15 PM EDT/);
  assert.strictEqual(inst.list('trader')[0].status, 'active');
});

test('restart: store persists; runs missed while the hub was down fire ONCE, marked late', async () => {
  const a = mk();
  await a.inst.create({ requester: 'trader', when: 'every 4 hours', prompt: 'recurring check' });
  await a.inst.create({ requester: 'trader', when: 'in 1 hour', prompt: 'one-off check' });
  a.inst.stop();
  // Hub down for 13 hours: the 4-hourly task missed three runs.
  const b = mk({ dataDir: a.dataDir, now: T0 + 13 * 3600000 });
  b.inst.start(); b.inst.stop(); b.inst._stopped = false;
  await b.inst.tick();
  assert.strictEqual(b.woken.length, 2, 'one wake per task, not one per missed run');
  for (const w of b.woken) assert.match(w.message, /LATE: fired \d+ min late: the hub was not running at that time/);
  const rec = b.inst.list('trader').find(t => t.type === 'recurring');
  assert.ok(Date.parse(rec.nextRunAt) > T0 + 13 * 3600000, 'next run is in the future');
  assert.strictEqual(b.inst.list('trader').find(t => t.type === 'once').status, 'done');
});

test('a delivery still pending at shutdown is delivered after restart', async () => {
  const a = mk();
  await a.inst.create({ requester: 'trader', when: 'in 1 hour', prompt: 'x' });
  a.busy.add('trader'); a.clock.t += 3600000; await a.inst.tick();
  assert.strictEqual(a.inst.pending.length, 1);
  a.inst.stop();
  const b = mk({ dataDir: a.dataDir, now: a.clock.t + 5 * 60000 });
  assert.strictEqual(b.inst.pending.length, 1);
  await b.inst.tick();
  assert.strictEqual(b.woken.length, 1);
  assert.match(b.woken[0].message, /the hub restarted before it was delivered/);
});

test('notify failures retry, then the one-off is marked failed', async () => {
  let calls = 0;
  const { inst, clock } = mk({ notify: async () => { calls++; throw new Error('hub refused'); } });
  const t = await inst.create({ requester: 'trader', when: 'in 1 minute', prompt: 'x' });
  for (let i = 0; i < 12; i++) { clock.t += 61000; await inst.tick(); }
  assert.strictEqual(calls, 10);
  const v = inst.list('trader', { includeDone: true }).find(x => x.id === t.id);
  assert.strictEqual(v.status, 'failed'); assert.match(v.note, /hub refused/);
  assert.strictEqual(v.lastRun.status, 'failed');
});

test('pause / resume / run_now / update / delete', async () => {
  const { inst, clock, woken } = mk();
  const t = await inst.create({ requester: st.OWNER, agent: 'trader', when: 'every day at 9am', prompt: 'x' });
  inst.action(t.id, st.OWNER, 'pause');
  clock.t = Date.parse('2026-09-30T13:00:30Z'); await inst.tick();
  assert.strictEqual(woken.length, 0, 'paused tasks do not fire');
  const r = inst.action(t.id, st.OWNER, 'resume');
  assert.strictEqual(r.nextRunAt, '2026-10-01T13:00:00.000Z', 'resume does not replay missed runs');
  inst.action(t.id, st.OWNER, 'run_now'); await inst.tick();
  assert.strictEqual(woken.length, 1); assert.match(woken[0].message, /set by the owner/);
  const u = await inst.update(t.id, st.OWNER, { when: 'weekdays at 10am', label: 'renamed' });
  assert.strictEqual(u.label, 'renamed'); assert.strictEqual(u.when, 'weekdays at 10am');
  await assert.rejects(inst.update(t.id, 'trader', { label: 'mine' }), /only the owner/);
  assert.deepStrictEqual(inst.action(t.id, st.OWNER, 'delete'), { id: t.id, deleted: true });
  assert.strictEqual(inst.list(st.OWNER).length, 0);
});

test('tool specs: schedule_task defaults to self and reports errors as text', async () => {
  const { inst } = mk();
  const spec = st.TOOL_SPECS.find(s => s.name === 'schedule_task');
  const ok = JSON.parse(await st.runTool(inst, spec, 'trader', { when: 'in 1 hour', prompt: 'p' }, { consultedBy: 'maestro' }));
  assert.strictEqual(ok.agent, 'trader'); assert.strictEqual(ok.consultedBy, 'maestro');
  const bad = await st.runTool(inst, spec, 'trader', { when: '3pm', prompt: 'p' });
  assert.match(bad, /^\[schedule_task error\] "3pm" is ambiguous/);
  const cancel = st.TOOL_SPECS.find(s => s.name === 'cancel_scheduled_task');
  assert.match(await st.runTool(inst, cancel, 'trader', { id: ok.id }), /"status": "cancelled"/);
  assert.match(st.policyText(), /schedule_task/);
});

// ── TASKS.md ET fix (lib/scheduler.js) ──────────────────────────────────
test('TASKS.md: "8:15 PM ET" runs at 20:15 America/New_York (no +4 h shift)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'scheduler.js'), 'utf8');
  assert.doesNotMatch(src, /hour = \(hour \+ 4\) % 24/);
  assert.match(src, /cron\.schedule\(trigger\.expression,[\s\S]{0,300}\{ timezone: trigger\.timezone \}/);
  // classifyTrigger without loading sdk-chat: evaluate the two pure functions from the source.
  const start = src.indexOf('function classifyTrigger');
  const end = src.indexOf('// ── Calendar Polling');
  const { classifyTrigger } = new Function(src.slice(start, end) + '\nreturn { classifyTrigger };')();
  assert.deepStrictEqual(classifyTrigger('8:15 PM ET'), { type: 'cron', expression: '15 20 * * *', timezone: NY });
  assert.deepStrictEqual(classifyTrigger('9:00 AM ET monday'), { type: 'cron', expression: '0 9 * * 1', timezone: NY });
  assert.strictEqual(classifyTrigger('meeting recap at 5:00 PM').timezone, undefined, '"et" inside a word is not Eastern');
  assert.strictEqual(classifyTrigger('meeting recap at 5:00 PM').expression, '0 17 * * *');
});

// ── visible in the agent's chat, also after a reload ────────────────────
test('TASKS.md prompts are saved with a "not typed by the owner" header and run time', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'scheduler.js'), 'utf8');
  const a = src.indexOf('function tasksMdMessage'); const b = src.indexOf('async function executeAgentTask');
  const tasksMdMessage = new Function(src.slice(a, b) + '\nreturn tasksMdMessage;')();
  const m = tasksMdMessage('daily-scout-review', 'Review the scouts.', new Date('2026-09-30T00:15:00Z'));
  assert.match(m, /^\[Scheduled task — started by the hub scheduler from TASKS\.md, NOT a message typed by the owner\] "daily-scout-review", run Tue, Sep 29, 2026, 8:15 PM EDT\.\n\nTask:\nReview the scouts\.$/);
  assert.match(src, /const message = tasksMdMessage\(taskId, prompt\);[\s\S]{0,400}message,\n\s*origin: \{ kind: 'schedule', from: taskId \}/);
});

test('hub-started turns keep their origin in the conversation log; the reloaded chat shows it with the time', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  const a = src.indexOf('function logOriginOf'); const b = src.indexOf('function loadConversationLog');
  const logOriginOf = new Function(src.slice(a, b) + '\nreturn logOriginOf;')();
  assert.deepStrictEqual(logOriginOf({ kind: 'schedule', from: 'HYPE follow-up', taskId: 'st_1', jobId: null, extra: { big: 1 } }),
    { kind: 'schedule', from: 'HYPE follow-up', taskId: 'st_1' });
  assert.match(src, /const logOrigin = \(origin && typeof origin === 'object' && origin\.kind\) \? \{ origin: logOriginOf\(origin\) \} : undefined;\n\s*appendConversationLog\(agent, 'user', message, false, \(tiger_team \|\| logOrigin\)/);
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(app, /if \(msg\.role === 'user' && msg\.origin\?\.kind\) appendSystemNotice\(chatId, `⚡ \$\{hubOriginLabel\(msg\.origin\)\} — \$\{hubTurnTime\(msg\.ts\)\}`\);/);
  assert.match(app, /appendSystemNotice\(chat\.id, `⚡ \$\{hubOriginLabel\(ev\.origin\)\} — \$\{hubTurnTime\(\)\}`\);/);
});
