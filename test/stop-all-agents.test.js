'use strict';
// Stop all agents (the kill switch): it also stops deep research runs, spares jobs an admin marked "keep", holds scheduled tasks that
// come due (never dropped as missed) and runs them one at a time after Resume, shows what it did (GET /api/hub/stop-status's data),
// journals Stop and Resume, and is runnable from the lead's settings tool (OPT-0542: Stop at once, Resume always a card, admin only).
// Runs against a throwaway install copy (test/helpers/isolated-install.js): nothing under the real data/ is touched.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');

const inst = makeIsolatedInstall('stopall-', { copy: ['templates/settings-records.json'] });
const L = (m) => require(path.join(inst.lib, m));
const sdk = L('sdk-chat');
const journal = L('settings-journal');
const research = L('research');
const records = L('settings-records');
const auth = L('auth').getAuth();
const { ScheduledTasks } = L('scheduled-tasks');
const { JobRunner } = L('jobs');
const hubHalt = L('hub-halt').getHubHalt();
const S = sdk.__settingsTool;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stopall-'));
after(() => { try { sdk.resumeHub(); } catch {} fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const NY = 'America/New_York';
const T0 = Date.parse('2026-10-08T14:00:00Z');
const HOUR = 3600000;
const waitFor = async (cond, ms = 10000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25)); return cond(); };

function mkSched({ refusal = { v: null }, woken = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 's'));
  const clock = { t: T0 };
  const st = new ScheduledTasks({ dataDir: dir, tz: NY, now: () => clock.t, log: () => {}, retryMs: 1000, pollMs: 600000,
    agentExists: async () => true, isAgentActive: () => false, haltRefusal: () => refusal.v,
    notify: async (agent, message, onReply, meta) => { woken.push({ agent, message, at: clock.t, taskId: meta && meta.taskId }); } });
  return { st, clock, refusal, woken, dir };
}

// ── research runs ───────────────────────────────────────────────────────────────────────────────────
test('research: stopAll stops every run still researching (all agents) and lists them; haltHub calls it', async () => {
  const wakes = [];
  const runner = research.createResearchRunner({
    spawn: () => new Promise(() => {}),   // never finishes: the run stays "researching"
    wake: async (agent, message) => { wakes.push({ agent, message }); },
    pickHelperModel: async () => 'claude-sdk/claude-test-fast', ownModelOf: async () => 'claude-sdk/claude-test-big',
    keptOnBox: () => false, sleep: async () => {}, log: () => {},
  });
  const subs = ['one', 'two', 'three'];
  const a = runner.start({ agent: 'alpha', question: 'What is A?', subQuestions: subs });
  const b = runner.start({ agent: 'beta', question: 'What is B?', subQuestions: subs });
  assert.ok(a.ok && b.ok, JSON.stringify([a, b]));
  assert.equal(runner.listActive().length, 2);
  const out = sdk.haltHub('research test', { jobRunner: { cancelAll: () => [] }, researchRunner: runner, stopAgentTurn: () => ({ ok: true }) });
  try {
    assert.deepEqual(out.stopped.research.map((r) => r.agent).sort(), ['alpha', 'beta']);
    assert.equal(runner.listActive().length, 0, 'no run is left under way');
    assert.equal(runner.stopAll().length, 0, 'a second call finds nothing');
  } finally { sdk.resumeHub(); }
});

// ── jobs: keep ──────────────────────────────────────────────────────────────────────────────────────
test('jobs: a keep-flagged job survives the stop, the others are cancelled; keep shows in list and in the status', async () => {
  const dataDir = fs.mkdtempSync(path.join(tmp, 'j'));
  const runner = new JobRunner({ dataDir, spawnMode: 'setsid', pollMs: 100, log: () => {}, notify: async () => {}, isAgentActive: () => false, agentExists: async () => true, defaultCwd: async () => dataDir });
  runner.start();
  const pidOf = (id) => { try { return parseInt(fs.readFileSync(path.join(path.dirname(runner.status(id).log), 'pid'), 'utf8'), 10) || null; } catch { return null; } };
  const alive = (pid) => { try { process.kill(-pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  try {
    const keep = await runner.run({ owner: 'maestro', name: 'keeper', command: 'sleep 30' });
    const other = await runner.run({ owner: 'maestro', name: 'other', command: 'sleep 30' });
    assert.ok(await waitFor(() => pidOf(keep.id) && pidOf(other.id)), 'both wrote their pid');
    assert.deepEqual(runner.setKeep(keep.id, true), { id: keep.id, keep: true });
    assert.equal(runner.list(null).find((j) => j.id === keep.id).keep, true);
    assert.equal(runner.list(null).find((j) => j.id === other.id).keep, false);
    assert.throws(() => runner.setKeep('nope', true), /no job/);
    const out = sdk.haltHub('jobs test', { jobRunner: runner, researchRunner: { stopAll: () => [] }, stopAgentTurn: () => ({ ok: true }) });
    assert.deepEqual(out.cancelledJobs, [other.id]);
    assert.deepEqual(out.stopped.jobs.map((j) => [j.id, j.name]), [[other.id, 'other']]);
    assert.equal(runner.status(keep.id).status, 'running', 'the kept job keeps running');
    const view = runner.haltView();
    assert.deepEqual(view.kept.map((j) => j.id), [keep.id]);
    assert.ok(await waitFor(() => !alive(pidOf(other.id))), 'the other job exited');
    assert.ok(alive(pidOf(keep.id)), 'the kept job is still alive');
    assert.deepEqual(sdk.stopStatus({ jobRunner: runner, scheduledTasks: { heldList: () => [] }, schedulerStatus: () => ({ pausedWhileStopped: 0 }) }).kept.jobs.map((j) => j.id), [keep.id]);
    runner.setKeep(keep.id, false);
    assert.equal(runner.list(null).find((j) => j.id === keep.id).keep, false);
    sdk.resumeHub({ scheduledTasks: { release: () => 0 } });
    runner.cancelAll();
    assert.ok(await waitFor(() => !alive(pidOf(keep.id))), 'cleaned up');
  } finally { try { sdk.resumeHub({ scheduledTasks: { release: () => 0 } }); } catch {} runner.stop(); fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

// ── scheduled tasks: held, released ─────────────────────────────────────────────────────────────────
test('scheduled tasks: a task due while stopped is held (listed as waiting), not missed', async () => {
  const h = mkSched();
  const t = await h.st.create({ requester: 'alice', when: 'in 1 hour', prompt: 'do it' });
  h.clock.t = T0 + 2 * HOUR; h.refusal.v = 'hub is halted';
  await h.st.tick();
  assert.equal(h.woken.length, 0, 'nothing fired while stopped');
  const v = h.st.list('alice', { includeDone: true }).find((x) => x.id === t.id);
  assert.equal(v.status, 'held');
  assert.match(v.note, /waiting: all agents are stopped/);
  assert.deepEqual(h.st.heldList().map((x) => x.id), [t.id]);
  // held tasks survive a restart still held
  const again = new ScheduledTasks({ dataDir: h.dir, tz: NY, now: () => h.clock.t, log: () => {}, haltRefusal: () => 'halted', notify: async () => {}, agentExists: async () => true, isAgentActive: () => false });
  await again.tick();
  assert.equal(again.heldList().length, 1);
  again.stop(); h.st.stop();
});

test('scheduled tasks: Resume runs held tasks once each, oldest first, at least 30 s apart', async () => {
  const h = mkSched();
  const a = await h.st.create({ requester: 'alice', when: 'in 1 hour', prompt: 'first' });
  const b = await h.st.create({ requester: 'bob', when: 'in 2 hours', prompt: 'second' });
  const c = await h.st.create({ requester: 'carol', when: 'in 3 hours', prompt: 'third' });
  h.refusal.v = 'hub is halted'; h.clock.t = T0 + 5 * HOUR;
  await h.st.tick();
  assert.equal(h.st.heldList().length, 3);
  h.refusal.v = null;
  assert.equal(h.st.release(), 3);
  assert.equal(h.st.heldList().length, 0);
  for (let i = 0; i < 10; i++) { await h.st.tick(); h.clock.t += 10000; }
  assert.deepEqual(h.woken.map((w) => w.taskId), [a.id, b.id, c.id], 'oldest first, each once');
  for (let i = 1; i < h.woken.length; i++) assert.ok(h.woken[i].at - h.woken[i - 1].at >= 30000, `gap ${i}: ${h.woken[i].at - h.woken[i - 1].at}`);
  await h.st.tick(); h.clock.t += 60000; await h.st.tick();
  assert.equal(h.woken.length, 3, 'none runs twice');
  assert.equal(h.st.release(), 0);
  h.st.stop();
});

test('scheduled tasks: a recurring task missed five times while stopped holds one run, then continues on its normal schedule', async () => {
  const h = mkSched();
  const t = await h.st.create({ requester: 'alice', when: 'every hour', prompt: 'hourly' });
  h.refusal.v = 'hub is halted';
  for (let i = 1; i <= 5; i++) { h.clock.t = T0 + i * HOUR + 1000; await h.st.tick(); }
  assert.equal(h.woken.length, 0);
  assert.equal(h.st.heldList().length, 1, 'only one run is held');
  h.refusal.v = null;
  assert.equal(h.st.release(), 1);
  await h.st.tick();
  assert.equal(h.woken.length, 1, 'it ran once');
  const v = h.st.list('alice')[0];
  assert.ok(Date.parse(v.nextRunAt) > h.clock.t, 'the next run is in the future');
  assert.equal(v.status, 'active');
  h.clock.t = Date.parse(v.nextRunAt) + 1000; await h.st.tick();
  assert.equal(h.woken.length, 2, 'then it continues from its next normal time');
  assert.equal(t.id, h.woken[0].taskId);
  h.st.stop();
});

test('TASKS.md scheduler: reports its tasks as paused while stopped', () => {
  const sched = L('scheduler');
  sdk.haltHub('sched status', { jobRunner: { cancelAll: () => [] }, researchRunner: { stopAll: () => [] }, stopAgentTurn: () => ({ ok: true }) });
  try {
    const s = sched.getSchedulerStatus();
    assert.equal(typeof s.pausedWhileStopped, 'number');
  } finally { sdk.resumeHub({ scheduledTasks: { release: () => 0 } }); }
  assert.equal(sched.getSchedulerStatus().pausedWhileStopped, 0);
});

// ── stop-status and the journal ─────────────────────────────────────────────────────────────────────
test('stop-status: lists what was stopped, what waits and who stopped it; the counts reach the halt file; Resume clears it', () => {
  const held = [{ id: 'st-1', label: 'nightly', note: 'waiting: all agents are stopped' }];
  const out = sdk.haltHub('lists', { by: 'Owner', jobRunner: { cancelAll: () => ['job-1'], list: () => [{ id: 'job-1', name: 'build', owner: 'maestro' }] },
    researchRunner: { stopAll: () => [{ id: 'r1', agent: 'alpha' }] }, stopAgentTurn: () => ({ ok: true }) });
  const fakeJobs = { haltView: () => ({ kept: [{ id: 'job-9', name: 'keeper' }], cancelling: [{ id: 'job-1', name: 'build' }] }) };
  try {
    assert.equal(out.halted, true);
    const s = sdk.stopStatus({ jobRunner: fakeJobs, scheduledTasks: { heldList: () => held }, schedulerStatus: () => ({ pausedWhileStopped: 2 }) });
    assert.equal(s.halted, true);
    assert.equal(s.by, 'Owner');
    assert.ok(Date.parse(s.at));
    assert.deepEqual(s.stopped.jobs, [{ id: 'job-1', name: 'build', owner: 'maestro' }]);
    assert.deepEqual(s.stopped.research, [{ id: 'r1', agent: 'alpha' }]);
    assert.deepEqual(s.finishing.jobs.map((j) => j.id), ['job-1']);
    assert.deepEqual(s.waiting.scheduled, held);
    assert.equal(s.waiting.tasksMd, 2);
    assert.deepEqual(s.kept.jobs.map((j) => j.id), ['job-9']);
    const onDisk = JSON.parse(fs.readFileSync(hubHalt.file, 'utf8'));
    assert.equal(onDisk.by, 'Owner');
    assert.equal(onDisk.counts.jobs, 1);
    assert.equal(onDisk.counts.research, 1);
  } finally { sdk.resumeHub({ scheduledTasks: { release: () => 0 } }); }
  const after = sdk.stopStatus({ jobRunner: fakeJobs });
  assert.equal(after.halted, false);
  assert.deepEqual(after.stopped.jobs, []);
});

test('journal: Stop and Resume each write a line (who, when, why), never restorable; the lead is the actor from the tool', () => {
  const before = journal.list({ limit: 500 }).length;
  sdk.haltHub('because the owner said so', { actor: { kind: 'person', user: 'u-owner' }, jobRunner: { cancelAll: () => [] }, researchRunner: { stopAll: () => [] }, stopAgentTurn: () => ({ ok: true }) });
  sdk.resumeHub({ actor: { kind: 'lead', agent: 'maestro' }, reason: 'all clear', scheduledTasks: { release: () => 0 } });
  const lines = journal.list({ limit: 500 }).filter((e) => /halt/.test(e.key));
  assert.equal(journal.list({ limit: 500 }).length, before + 2);
  const stop = lines.find((e) => e.after === 'stopped'), resume = lines.find((e) => e.after === 'running');
  assert.ok(stop && resume, JSON.stringify(lines));
  assert.equal(stop.restorable, false);
  assert.equal(resume.restorable, false);
  assert.equal(stop.who.kind, 'person');
  assert.equal(stop.who.user, 'u-owner');
  assert.match(stop.why, /owner said so/);
  assert.equal(resume.who.kind, 'lead');
  assert.match(resume.why, /all clear/);
  assert.ok(stop.at && resume.at);
  // a Stop while already stopped, and a Resume while running, write nothing
  sdk.haltHub('x', { jobRunner: { cancelAll: () => [] }, researchRunner: { stopAll: () => [] }, stopAgentTurn: () => ({ ok: true }) });
  const n = journal.list({ limit: 500 }).length;
  sdk.haltHub('x again', { jobRunner: { cancelAll: () => [] }, researchRunner: { stopAll: () => [] }, stopAgentTurn: () => ({ ok: true }) });
  assert.equal(journal.list({ limit: 500 }).length, n);
  sdk.resumeHub({ scheduledTasks: { release: () => 0 } });
});

// ── the lead's settings tool (OPT-0542) ─────────────────────────────────────────────────────────────
const admin = auth.createUser({ login: 'owner@example.com', name: 'Owner', role: 'admin', password: 'owner-long-password-1' }).user;
const sam = auth.createUser({ login: 'sam@example.com', name: 'Sam', role: 'member', password: 'sam-long-password-1' }).user;
fs.writeFileSync(path.join(inst.data, 'agents.json'), JSON.stringify([{ name: 'maestro', model: 'openai/gpt-5.6', display: 'Maestro', category: 'primary', lead: true }]));
const HALT = 'OPT-0542';
let turnN = 0;
function startTurn({ personKey = admin.id, tainted = false, typed = '' } = {}) {
  const t = { turnId: `maestro-t${++turnN}`, origin: { kind: 'user' }, personKey, tainted, typed, voice: false, abortController: new AbortController() };
  S.turnRegistry.set('maestro', t);
  return t;
}
function fakeRes() {
  const chunks = [];
  return { chunks, writableEnded: false, destroyed: false, on() {}, write(s) { chunks.push(String(s)); return true; },
    events() { const out = []; for (const c of chunks) for (const line of c.split('\n')) if (line.startsWith('data: ')) { try { out.push(JSON.parse(line.slice(6))); } catch {} } return out; } };
}
function findDeep(o, pred, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 6) return null;
  if (pred(o)) return o;
  for (const v of Object.values(o)) { const r = findDeep(v, pred, depth + 1); if (r) return r; }
  return null;
}
const cardsOf = (res) => res.events().map((e) => findDeep(e, (x) => x.type === 'ask_user_question')).filter(Boolean);
const call = (res, args) => S.runChangeSetting('maestro', res, args, 0, null);
const answer = (card, text) => sdk.handleAskResponse({ request_id: card.request_id, answers: { 0: text }, agent: 'maestro' }, { isAdmin: true, personKey: admin.id });

test('lead tool: the record is findable and readable (admin) and shows its state', async () => {
  assert.ok(records.byId(HALT), 'OPT-0542 exists');
  startTurn();
  const g = JSON.parse(await call(fakeRes(), { action: 'get', setting: HALT }));
  assert.equal(g.id, HALT);
  assert.equal(g.current, 'running');
  assert.match(g.class, /Stop.*at once.*Resume.*confirm/);
  const f = JSON.parse(await call(fakeRes(), { action: 'find', setting: 'stop all agents' }));
  assert.ok(f.records.some((r) => r.id === HALT), JSON.stringify(f));
});

test('lead tool: Stop goes at once in a turn whose typed words are the command; the journal says the lead did it', async () => {
  startTurn({ typed: 'Stop all agents.' });
  const res = fakeRes();
  const out = await call(res, { action: 'set', setting: HALT, value: 'stopped', reason: 'the owner asked' });
  try {
    assert.match(out, /Stopped all agents/);
    assert.equal(hubHalt.isHalted(), true);
    assert.equal(cardsOf(res).length, 0, 'no card');
    const line = journal.list({ limit: 50 }).find((e) => /halt/.test(e.key) && e.after === 'stopped');
    assert.ok(line);
    assert.equal(line.who.kind, 'lead');
    assert.equal(line.restorable, false);
    const again = await call(fakeRes(), { action: 'set', setting: HALT, value: 'stopped', reason: 'again' });
    assert.match(again, /already stopped/i);
  } finally { sdk.resumeHub({ scheduledTasks: { release: () => 0 } }); }
});

test('lead tool: Stop in a tainted turn (or without the typed command) shows a Confirm card; Cancel changes nothing', async () => {
  startTurn({ tainted: true, typed: 'Stop all agents.' });
  const res = fakeRes();
  const p = call(res, { action: 'set', setting: HALT, value: 'stopped', reason: 'x' });
  const card = await waitFor(() => cardsOf(res)[0]).then(() => cardsOf(res)[0]);
  assert.ok(card, 'a card was shown');
  assert.equal(hubHalt.isHalted(), false, 'not stopped before the answer');
  answer(card, 'Cancel');
  assert.match(await p, /Not changed/);
  assert.equal(hubHalt.isHalted(), false);
  startTurn({ typed: 'maybe stop the agents later' });
  const res2 = fakeRes();
  const p2 = call(res2, { action: 'set', setting: HALT, value: 'stopped', reason: 'x' });
  await waitFor(() => cardsOf(res2)[0]);
  answer(cardsOf(res2)[0], 'Confirm');
  assert.match(await p2, /Stopped all agents/);
  assert.equal(hubHalt.isHalted(), true);
  sdk.resumeHub({ scheduledTasks: { release: () => 0 } });
});

test('lead tool: Resume is always a card, even in a clean turn, and its text names the held tasks and one-at-a-time', async () => {
  sdk.haltHub('for resume test', { jobRunner: { cancelAll: () => [] }, researchRunner: { stopAll: () => [] }, stopAgentTurn: () => ({ ok: true }) });
  const tasks = sdk.getScheduledTasks();
  const realHeld = tasks.heldList, realRelease = tasks.release;
  tasks.heldList = () => [{ id: 'a' }, { id: 'b' }];   // two tasks came due while stopped
  let released = 0; tasks.release = () => { released++; return 2; };
  try {
    startTurn({ typed: 'Resume all agents.' });
    const res = fakeRes();
    const p = call(res, { action: 'set', setting: HALT, value: 'running', reason: 'x' });
    await waitFor(() => cardsOf(res)[0]);
    const card = cardsOf(res)[0];
    assert.ok(card, 'Resume showed a card although the turn is clean');
    assert.equal(hubHalt.isHalted(), true, 'still stopped before the answer');
    assert.match(JSON.stringify(card), /2 scheduled tasks/);
    assert.match(JSON.stringify(card), /one at a time/);
    answer(card, 'Confirm');
    const out = await p;
    assert.match(out, /Resumed all agents/);
    assert.match(out, /2 held tasks/);
    assert.equal(hubHalt.isHalted(), false);
    assert.equal(released, 1, 'the held tasks were released once');
  } finally { tasks.heldList = realHeld; tasks.release = realRelease; sdk.resumeHub({ scheduledTasks: { release: () => 0 } }); }
});

test('lead tool: a member is refused and nothing changes', async () => {
  startTurn({ personKey: sam.id, typed: 'Stop all agents.' });
  const res = fakeRes();
  const out = await call(res, { action: 'set', setting: HALT, value: 'stopped', reason: 'x' });
  assert.match(String(out), /admin|only on its screen|Only an admin/i);
  assert.equal(hubHalt.isHalted(), false);
  assert.equal(cardsOf(res).length, 0);
});
