'use strict';
// The lead reviews behaviour changes that wait for the owner, and looks at how the install is used once a week (lib/behaviour-review.js),
// through scheduled tasks the hub creates (lib/scheduled-tasks '@hub'). A throwaway install and temp folders: nothing under the real data/
// is read or written; the lead and the scheduler are injected.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeIsolatedInstall, REAL } = require('./helpers/isolated-install');

const ISO = makeIsolatedInstall('behaviour-review-', { copy: ['templates/behaviour-changes.json'] });
const L = (p) => require(path.join(ISO.inst, 'lib', p));
const bc = L('behaviour-changes');
const review = L('behaviour-review');
const sched = L('scheduled-tasks');
const MANIFEST = path.join(REAL, 'templates', 'behaviour-changes.json');   // read only

const temps = [];
const tempDir = () => { const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'behaviour-review-t-')); temps.push(d); return d; };
after(() => { for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

const ent = (state, extra = {}) => ({ state, by: 'update', at: '2026-01-01T00:00:00.000Z', ...extra });
function mk(entries, { leads = () => ['maestro'], setting = 'weekly' } = {}) {
  const d = tempDir();
  const stateFile = path.join(d, 'state.json');
  if (entries !== null) fs.writeFileSync(stateFile, typeof entries === 'string' ? entries : JSON.stringify({ entries }));
  const inst = new sched.ScheduledTasks({ dataDir: path.join(d, 'sched'), tz: 'America/New_York', log: () => {}, notify: async () => {} });
  const deps = { stateFile, manifestFile: MANIFEST, scheduler: inst, leads, agents: [{ name: 'maestro', category: 'primary', model: 'anthropic/x', lead: true }, { name: 'kim_helper', category: 'primary', model: 'openai/y', owner: 'u-member' }], adminIds: ['u-admin'], users: [{ role: 'admin' }, { role: 'member' }], memberModels: ['openai/y'], providers: { anthropic: true, openai: false }, usage: 'sam: 3 requests', getSetting: (k, d2) => (k === 'workerProposals' ? setting : d2) };
  return { d, stateFile, inst, deps, state: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')).entries, live: () => inst.list('@hub', { includeDone: false }) };
}

test('scheduleReview: one task for the lead with the right prompt, and every pending entry is marked (other fields kept)', async () => {
  const t = mk({ 'team-guidance': ent('pending'), 'worker-proposals': ent('pending'), 'starter-team': ent('on', { by: 'owner' }), 'ask-lead-for-workers': ent('off', { by: 'owner' }) });
  const r = await review.scheduleReview(t.deps);
  assert.strictEqual(r.lead, 'maestro');
  assert.deepStrictEqual(r.ids, ['team-guidance', 'worker-proposals']);
  const tasks = t.live();
  assert.strictEqual(tasks.length, 1);
  const task = tasks[0];
  assert.strictEqual(task.id, r.taskId);
  assert.strictEqual(task.agent, 'maestro');
  assert.strictEqual(task.createdBy, '@hub');
  assert.strictEqual(task.label, 'Changes to how agents behave: review');
  assert.ok(Date.parse(task.nextRunAt) - Date.now() < 3 * 60000 && Date.parse(task.nextRunAt) > Date.now(), 'in about 2 minutes');
  const p = task.prompt;
  assert.ok(p.length < 24000);
  assert.match(p, /brought 2 changes to how agents behave/);
  assert.match(p, /switched OFF on this install until its owner decides/);
  assert.match(p, /You cannot switch any of them on yourself and must not claim you did/);
  assert.match(p, /Call for_owner once for this reply/);
  assert.match(p, /\[Decide\]\(\/changes#<id>\)/);
  assert.match(p, /\(id: team-guidance\)/); assert.match(p, /\(id: worker-proposals\)/);
  assert.doesNotMatch(p, /\(id: starter-team\)/); assert.doesNotMatch(p, /\(id: ask-lead-for-workers\)/);
  // Review r1 (GPT-6 B4): a review never invites a proposal while worker-proposals waits; it says to skip decided ones.
  assert.doesNotMatch(p, /If team_usage shows a clear case for a new worker now/);
  assert.match(p, /If your hub brief this turn no longer lists a change as waiting, the owner has already decided it: skip that one\./);
  for (const e of bc.manifest(MANIFEST).filter((x) => r.ids.includes(x.id))) {
    for (const k of ['title', 'changes', 'benefits', 'costs', 'check', 'on', 'off']) assert.ok(p.includes(e[k]), `${e.id}.${k} is in the prompt in full`);
  }
  assert.match(p, /maestro: primary, model anthropic\/x, owned by a member: no/);
  assert.match(p, /kim_helper: primary, model openai\/y, owned by a member: yes/);
  assert.match(p, /1 admin\(s\), 1 member\(s\)/); assert.match(p, /openai\/y/); assert.match(p, /Providers connected: anthropic\./); assert.match(p, /sam: 3 requests/);
  // the message the lead gets names the hub, not the owner
  const msg = t.inst.message(t.inst.tasks.get(task.id), { dueAt: task.nextRunAt }, { late: false });
  assert.match(msg, /set by the hub \(a change to how agents behave is waiting for review\)/);
  assert.match(msg, /the owner has not said anything yet/);
  const s = t.state();
  for (const id of ['team-guidance', 'worker-proposals']) {
    assert.strictEqual(s[id].state, 'pending'); assert.strictEqual(s[id].by, 'update');
    assert.strictEqual(s[id].reviewTask, r.taskId); assert.ok(Date.parse(s[id].reviewAt) > 0);
  }
  assert.ok(!('reviewAt' in s['starter-team']) && !('reviewAt' in s['ask-lead-for-workers']));
});

test('scheduleReview: a second call (a restart before the turn ran) adds no task; a later new entry gets its own', async () => {
  const t = mk({ 'team-guidance': ent('pending') });
  const first = await review.scheduleReview(t.deps);
  assert.ok(first.taskId);
  assert.deepStrictEqual(await review.scheduleReview(t.deps), { none: 'nothing to review' });
  assert.strictEqual(t.live().length, 1);
  // two calls at once still make one
  const t2 = mk({ 'team-guidance': ent('pending') });
  await Promise.all([review.scheduleReview(t2.deps), review.scheduleReview(t2.deps)]);
  assert.strictEqual(t2.live().length, 1);
  // an update brings another change: it is reviewed by a task of its own
  const doc = JSON.parse(fs.readFileSync(t.stateFile, 'utf8')); doc.entries['starter-team'] = ent('pending');
  fs.writeFileSync(t.stateFile, JSON.stringify(doc));
  const next = await review.scheduleReview(t.deps);
  assert.deepStrictEqual(next.ids, ['starter-team']);
  assert.strictEqual(t.live().length, 2);
  assert.doesNotMatch(t.live().find((x) => x.id === next.taskId).prompt, /\(id: team-guidance\)/);
});

test('scheduleReview: a task made before a crash (entries not yet marked) is reused, not doubled', async () => {
  const t = mk({ 'team-guidance': ent('pending') });
  const made = await t.inst.create({ requester: '@hub', agent: 'maestro', when: 'in 2 minutes', label: review.REVIEW_LABEL, prompt: review.reviewPrompt({ entries: bc.manifest(MANIFEST).filter((e) => e.id === 'team-guidance'), facts: '' }) });
  const r = await review.scheduleReview(t.deps);
  assert.strictEqual(r.taskId, made.id);
  assert.strictEqual(t.live().length, 1);
  assert.strictEqual(t.state()['team-guidance'].reviewTask, made.id);
});

test('scheduleReview: no lead, nothing pending, a missing or unreadable state: no task, nothing written', async () => {
  const noLead = mk({ 'team-guidance': ent('pending') }, { leads: () => [] });
  assert.deepStrictEqual(await review.scheduleReview(noLead.deps), { none: 'no lead agent' });
  assert.strictEqual(noLead.live().length, 0);
  assert.ok(!('reviewAt' in noLead.state()['team-guidance']));
  const none = mk({ 'team-guidance': ent('on', { by: 'owner' }) });
  assert.strictEqual((await review.scheduleReview(none.deps)).none, 'nothing to review');
  assert.strictEqual((await review.scheduleReview(mk(null).deps)).none, 'nothing to review');
  for (const bad of ['{not json', '{"entries":{"a":{"state":"maybe"}}}']) {
    const t = mk(bad);
    assert.strictEqual((await review.scheduleReview(t.deps)).none, 'nothing to review');
    assert.strictEqual(t.live().length, 0);
    assert.strictEqual(fs.readFileSync(t.stateFile, 'utf8'), bad, 'an unreadable state is never overwritten');
  }
  await assert.rejects(bc.markReviewed(['team-guidance'], 'st-1', { stateFile: mk('{bad').stateFile }), /not overwritten/);
});

test('the real lead lookup: the first admin-side lead; a member\'s flagged agent is not one', () => {
  const agents = [{ name: 'kim_lead', lead: true, owner: 'u-member' }, { name: 'maestro', lead: true }];
  assert.strictEqual(review.leadName({ agents, adminIds: ['u-admin'] }), 'maestro');
  assert.strictEqual(review.leadName({ agents: [{ name: 'kim_lead', lead: true, owner: 'u-member' }], adminIds: ['u-admin'] }), null);
  assert.strictEqual(review.leadName({ agents: [{ name: 'a', category: 'worker' }], adminIds: [] }), null);
});

// Seven entries' full text passed 8,000 characters: the hub's own tasks may hold 24,000 (scheduled-tasks HUB_MAX_PROMPT).
test('reviewPrompt: under 24000 characters with huge facts, entry text is never cut; the instructions say the lead cannot switch them', () => {
  const entries = bc.manifest(MANIFEST);   // all five
  const agentLines = Array.from({ length: 400 }, (_, i) => `- agent_${i}: worker, model provider/some-long-model-name-${i}, owned by a member: no`);
  const facts = { agentLines, head: ['People: 1 admin(s), 3 member(s).', `Models members may choose for their agents: ${'m'.repeat(300)}.`], count: 400, usage: 'u'.repeat(3000) };
  const p = review.reviewPrompt({ entries, facts });
  assert.ok(p.length <= 24000, String(p.length));
  for (const e of entries) for (const k of ['title', 'changes', 'benefits', 'costs', 'check', 'on', 'off']) assert.ok(p.includes(e[k]), `${e.id}.${k}`);
  assert.match(p, /and \d+ more/);
  assert.match(p, /You cannot switch any of them on yourself/);
  for (const e of entries) assert.ok(p.includes(`(id: ${e.id})`));
  assert.match(p, /\[Decide\]\(\/changes#<id>\)/);
  // a plain string of facts is cut to fit too
  assert.ok(review.reviewPrompt({ entries, facts: 'x'.repeat(40000) }).length <= 24000);
  // one entry, no worker-proposals line
  const one = review.reviewPrompt({ entries: entries.slice(0, 1), facts: '' });
  assert.match(one, /brought 1 change to how agents behave/);
  assert.doesNotMatch(one, /clear case for a new worker/);
});

test('syncProposalsTask: one weekly task while on and weekly; cancelled when turned off or set off; never two', async () => {
  const t = mk({ 'worker-proposals': ent('on', { by: 'owner' }) });
  const a = await review.syncProposalsTask(t.deps);
  assert.strictEqual(a.action, 'created');
  let tasks = t.live();
  assert.strictEqual(tasks.length, 1);
  assert.strictEqual(tasks[0].label, 'Weekly team review');
  assert.strictEqual(tasks[0].agent, 'maestro'); assert.strictEqual(tasks[0].createdBy, '@hub');
  assert.strictEqual(tasks[0].schedule.includes('every monday at 9am'), true);
  assert.strictEqual(tasks[0].type, 'recurring');
  assert.match(tasks[0].prompt, /call team_usage/); assert.match(tasks[0].prompt, /never uses recall on a member's agent/); assert.match(tasks[0].prompt, /end the turn without for_owner/);
  assert.strictEqual(t.state()['worker-proposals'].proposalsTask, tasks[0].id);
  assert.match(t.inst.message(t.inst.tasks.get(tasks[0].id), { dueAt: tasks[0].nextRunAt }, { late: false }), /set by the hub \(the weekly team review\)/);
  // again, and twice at once: still one
  assert.strictEqual((await review.syncProposalsTask(t.deps)).action, 'kept');
  await Promise.all([review.syncProposalsTask(t.deps), review.syncProposalsTask(t.deps)]);
  assert.strictEqual(t.live().length, 1);
  // the setting goes off: cancelled and cleared
  const off = { ...t.deps, getSetting: () => 'off' };
  assert.strictEqual((await review.syncProposalsTask(off)).action, 'cancelled');
  assert.strictEqual(t.live().length, 0);
  assert.ok(!('proposalsTask' in t.state()['worker-proposals']));
  assert.strictEqual(t.state()['worker-proposals'].state, 'on', 'the decision itself is untouched');
  // weekly again: a fresh one
  assert.strictEqual((await review.syncProposalsTask(t.deps)).action, 'created');
  assert.strictEqual(t.live().length, 1);
  // the owner turns the change off (bookkeeping survives the decision, so the task can be found and cancelled)
  await bc.decide('worker-proposals', 'off', { stateFile: t.stateFile });
  assert.ok(t.state()['worker-proposals'].proposalsTask, 'decide keeps proposalsTask');
  assert.strictEqual((await review.syncProposalsTask(t.deps)).action, 'cancelled');
  assert.strictEqual(t.live().length, 0);
  assert.strictEqual((await review.syncProposalsTask(t.deps)).action, 'none');
});

test('syncProposalsTask: pending or off changes and a missing lead make no task; an unreadable state is left alone', async () => {
  for (const state of ['pending', 'off']) {
    const t = mk({ 'worker-proposals': ent(state) });
    assert.strictEqual((await review.syncProposalsTask(t.deps)).action, 'none');
    assert.strictEqual(t.live().length, 0);
  }
  const noLead = mk({ 'worker-proposals': ent('on', { by: 'owner' }) }, { leads: () => [] });
  assert.strictEqual((await review.syncProposalsTask(noLead.deps)).action, 'none');
  assert.strictEqual(noLead.live().length, 0);
  const bad = mk('{nope');
  assert.strictEqual((await review.syncProposalsTask(bad.deps)).action, 'skipped');
  assert.strictEqual(fs.readFileSync(bad.stateFile, 'utf8'), '{nope');
});

test('markReviewed and decide: bookkeeping fields are kept, an owner decision still wins', async () => {
  const t = mk({ a1: ent('pending', { user: 'u1' }), b2: ent('pending') });
  await bc.markReviewed(['a1', 'zz'], 'st-9', { stateFile: t.stateFile });
  const s = t.state();
  assert.strictEqual(s.a1.user, 'u1'); assert.strictEqual(s.a1.reviewTask, 'st-9'); assert.ok(!('reviewTask' in s.b2));
  assert.ok(!('zz' in s), 'an unknown id is not invented');
  // a decision records the owner and keeps the review marks
  await bc.decide('a1', 'on', { user: 'u2', stateFile: t.stateFile, manifestFile: MANIFEST }).catch((e) => assert.match(e.message, /no such change/));   // 'a1' is not in the shipped manifest: refused, nothing written
  assert.strictEqual(t.state().a1.state, 'pending');
  const real = mk({ 'team-guidance': ent('pending') });
  await bc.markReviewed(['team-guidance'], 'st-5', { stateFile: real.stateFile });
  await bc.decide('team-guidance', 'on', { user: 'u2', stateFile: real.stateFile, manifestFile: MANIFEST });
  const e = real.state()['team-guidance'];
  assert.strictEqual(e.state, 'on'); assert.strictEqual(e.by, 'owner'); assert.strictEqual(e.user, 'u2'); assert.strictEqual(e.reviewTask, 'st-5');
});

test('the hub only asks: nothing in the review code can switch a change on', () => {
  const src = fs.readFileSync(path.join(REAL, 'lib', 'behaviour-review.js'), 'utf8');
  assert.doesNotMatch(src, /\.decide\(/);
  assert.doesNotMatch(src, /state: 'on'/);
});

test('server wiring: the review runs after the scheduler starts; the decision and the cadence route re-sync the weekly task', () => {
  const server = fs.readFileSync(path.join(REAL, 'server.js'), 'utf8');
  const a = server.indexOf('getScheduledTasks().start()');
  const b = server.indexOf('review.scheduleReview({ scheduler: getScheduledTasks() })');
  assert.ok(a > 0 && b > a, 'after the scheduler');
  assert.match(server, /\[behaviour\] review scheduled for \$\{r\.lead\} \(\$\{r\.taskId\}\): \$\{r\.ids\.join\(', '\)\}/);
  assert.match(server, /if \(m\[1\] === 'worker-proposals'\) \{\n\s+try \{ await require\('\.\/lib\/behaviour-review'\)\.syncProposalsTask\(\)/);
  assert.match(server, /pathname === '\/api\/behaviour-changes\/worker-proposals\/cadence' && req\.method === 'POST'[\s\S]{0,700}updateSettings\(\{ workerProposals: b\.cadence \}\)[\s\S]{0,200}syncProposalsTask\(\)/);
  const page = fs.readFileSync(path.join(REAL, 'changes.html'), 'utf8');
  assert.match(page, /How often the lead looks:/);
  assert.match(page, /\/api\/behaviour-changes\/worker-proposals\/cadence/);
  assert.match(page, /c\.id === 'worker-proposals' && c\.state === 'on'/);
  assert.doesNotMatch(page, /innerHTML/);
});
