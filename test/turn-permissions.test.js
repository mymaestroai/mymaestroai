'use strict';
// Who may start another agent's turn (queued tasks, job reports) and who is named on every hub-started turn.
// Nothing here opens the real data folder: task-queue gets a temp database through configureTaskQueue, jobs a temp data dir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
// lib/ modules load from a throwaway install, so they never read the real data folder (settings, agents).
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('turn-perm-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const { decideTurnStart } = L('turn-permissions.js');
const { isLeadAgent } = L('agents.js');
const { JobRunner, TOOL_SPECS } = L('jobs.js');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'turn-perm-')));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ── The rule ────────────────────────────────────────────────────────────────
const ADMINS = new Set(['admin-1']);
const AGENTS = [
  { name: 'lead-a', category: 'primary', lead: true, owner: 'admin-1' },
  { name: 'peer-a', category: 'specialist', owner: 'admin-1' },
  { name: 'infra-bot', category: 'specialist' },                       // unowned infrastructure agent: admin side
  { name: 'member-bot', category: 'primary', owner: 'user-m1' },
  { name: 'sam-helper', category: 'specialist', owner: 'user-m1' },
  { name: 'other-bot', category: 'specialist', owner: 'user-m2' },
];
const VIRTUAL = { 'worker-of-member': { parent: 'member-bot' }, 'worker-of-lead': { parent: 'lead-a' } };
const rule = (from, to, extra = {}) => decideTurnStart({
  from, to, agents: AGENTS, adminIds: ADMINS, resolveVirtual: (n) => VIRTUAL[n] || null,
  isLead: (n, list) => isLeadAgent(n, list), consultAllowed: async () => false, ...extra,
});

test('rule: own turn, lead to any, same pool', async () => {
  assert.deepStrictEqual(await rule('member-bot', 'member-bot'), { ok: true });
  assert.deepStrictEqual(await rule('lead-a', 'other-bot'), { ok: true }, 'a lead agent may start any turn');
  assert.deepStrictEqual(await rule('lead-a', 'member-bot'), { ok: true });
  assert.deepStrictEqual(await rule('peer-a', 'lead-a'), { ok: true }, 'admin side to admin side');
  assert.deepStrictEqual(await rule('peer-a', 'infra-bot'), { ok: true });
  assert.deepStrictEqual(await rule('infra-bot', 'peer-a'), { ok: true }, 'unowned infrastructure counts as admin side');
  assert.deepStrictEqual(await rule('member-bot', 'sam-helper'), { ok: true }, 'same member');
});

test('rule: a member\'s agent cannot start admin-side or another member\'s turns', async () => {
  for (const [from, to] of [['member-bot', 'lead-a'], ['member-bot', 'peer-a'], ['member-bot', 'infra-bot'], ['member-bot', 'other-bot'], ['other-bot', 'sam-helper'], ['peer-a', 'member-bot']]) {
    const r = await rule(from, to);
    assert.strictEqual(r.ok, false, `${from} -> ${to}`);
    assert.strictEqual(r.reason, `agent "${from}" may not start turns of "${to}": only its own, those of agents with the same owner, or (for a lead agent) any`);
  }
});

test('rule: an unknown target or unknown caller is refused', async () => {
  assert.deepStrictEqual(await rule('lead-a', 'ghost-bot'), { ok: false, reason: 'no agent named "ghost-bot"' });
  assert.strictEqual((await rule('ghost-bot', 'peer-a')).ok, false);
});

test('rule: an admin "May consult" grant does not allow it', async () => {
  // consultAllowed(to, from) would be true for a granted pair, but without the consulted-by clause the grant is irrelevant.
  const r = await rule('member-bot', 'peer-a', { consultAllowed: async () => true });
  assert.strictEqual(r.ok, false);
  const r2 = await rule('member-bot', 'peer-a', { consultedBy: null, consultAllowed: async () => true });
  assert.strictEqual(r2.ok, false);
});

test('rule: temporary workers follow their parent', async () => {
  assert.deepStrictEqual(await rule('worker-of-member', 'sam-helper'), { ok: true });
  assert.strictEqual((await rule('worker-of-member', 'peer-a')).ok, false);
  assert.deepStrictEqual(await rule('worker-of-lead', 'other-bot'), { ok: true }, 'a lead\'s worker has the lead\'s reach');
  assert.deepStrictEqual(await rule('peer-a', 'worker-of-lead'), { ok: true }, 'target resolves to its parent');
  assert.strictEqual((await rule('other-bot', 'worker-of-member')).ok, false);
});

test('rule: consultedBy clause: only the consulter, and only while it may still consult', async () => {
  const seen = [];
  const allow = async (to, from) => { seen.push([to, from]); return true; };
  const deny = async () => false;
  assert.deepStrictEqual(await rule('member-bot', 'peer-a', { consultedBy: 'peer-a', consultAllowed: allow }), { ok: true });
  assert.deepStrictEqual(seen, [['peer-a', 'member-bot']], 'asks consultAllowed(to, from)');
  assert.strictEqual((await rule('member-bot', 'peer-a', { consultedBy: 'peer-a', consultAllowed: deny })).ok, false, 'consult right withdrawn');
  assert.strictEqual((await rule('member-bot', 'lead-a', { consultedBy: 'peer-a', consultAllowed: allow })).ok, false, 'not the consulter');
  assert.strictEqual((await rule('member-bot', 'peer-a', { consultedBy: null, consultAllowed: allow })).ok, false);
});

test('sdk-chat wires the rule: exported, built on turn-permissions with the same helpers consultAllowed uses', () => {
  const src = read('lib/sdk-chat.js');   // sdk-chat cannot load in isolation; the rule itself is tested above
  assert.match(src, /async function mayStartTurnFor\(from, to, \{ consultedBy = null \} = \{\}\) \{\s*return turnPermissions\.decideTurnStart\(\{[^}]*resolveVirtual: resolveVirtualAgent,[^}]*isLead: isLeadAgent,\s*consultAllowed,/s);
  assert.match(src, /^\s*mayStartTurnFor,$/m);
  assert.match(src, /mayReport: \(from, to, o\) => mayStartTurnFor\(from, to, o\),/);
  assert.match(src, /name === 'list_tasks' \|\| name === 'cancel_task'[\s\S]{0,400}def\.handler\(args, \{ agentName, privileged \}\)/);
});

// ── create_task / list_tasks / cancel_task as the tool handlers run them ─────────────────────────────
test('tools: create_task refuses (error text, no throw) and allows per the rule; list/cancel are scoped', async () => {
  const tq = L('task-queue.js');
  const started = [];
  tq.configureTaskQueue({
    dbPath: path.join(TMP, 'tools-queue.db'),
    mayStart: (from, to) => decideTurnStart({ from, to, agents: AGENTS, adminIds: ADMINS, resolveVirtual: () => null, isLead: isLeadAgent, consultAllowed: async () => false }),
    startTurn: async (a, m, o) => { started.push({ a, m, o }); return { done: Promise.resolve('') }; },
    isAgentActive: () => false,
  });
  const { BUILTIN_TOOLS } = L('provider-tools.js');
  const origLog = console.log; console.log = () => {};
  try {
    const create = (agentName, target) => BUILTIN_TOOLS.create_task.handler({ target_agent: target, trigger_type: 'delay', trigger_value: '30', action_prompt: 'queued work' }, { agentName });
    const refused = JSON.parse(await create('member-bot', 'peer-a'));
    assert.strictEqual(refused.error, 'agent "member-bot" may not start turns of "peer-a": only its own, those of agents with the same owner, or (for a lead agent) any');
    assert.ok(!('id' in refused));
    assert.strictEqual(JSON.parse(await create('member-bot', 'ghost-bot')).error, 'no agent named "ghost-bot"');
    const own = JSON.parse(await create('member-bot', 'sam-helper')); assert.strictEqual(own.status, 'pending');
    const lead = JSON.parse(await create('lead-a', 'other-bot')); assert.strictEqual(lead.status, 'pending');
    const adm = JSON.parse(await create('peer-a', 'infra-bot')); assert.strictEqual(adm.status, 'pending');

    const list = async (agentName, privileged) => { const t = await BUILTIN_TOOLS.list_tasks.handler({}, { agentName, privileged }); return t === 'No tasks found.' ? [] : JSON.parse(t); };
    assert.deepStrictEqual((await list('member-bot', false)).map(t => t.id), [own.id], 'a member agent sees only its own');
    assert.deepStrictEqual((await list('sam-helper', false)).map(t => t.id), [own.id], 'the target sees it too');
    assert.deepStrictEqual(await list('other-bot', false).then(r => r.map(t => t.id)), [lead.id]);
    assert.deepStrictEqual((await list('lead-a', true)).map(t => t.id).sort(), [own.id, lead.id, adm.id].sort(), 'privileged sees all');
    assert.deepStrictEqual(await list(undefined, false), [], 'no caller identity: nothing');
    assert.strictEqual(await BUILTIN_TOOLS.cancel_task.handler({ task_id: adm.id }, { agentName: 'member-bot', privileged: false }), `Task #${adm.id} not found or not pending.`);
    assert.strictEqual(tq.listTasks({ status: 'cancelled' }).length, 0);
    assert.strictEqual(await BUILTIN_TOOLS.cancel_task.handler({ task_id: adm.id }, { agentName: 'lead-a', privileged: true }), `Task #${adm.id} cancelled.`);
    assert.strictEqual(await BUILTIN_TOOLS.cancel_task.handler({ task_id: own.id }, { agentName: 'member-bot', privileged: false }), `Task #${own.id} cancelled.`);
  } finally { console.log = origLog; tq.stopTaskQueue(); }
});

// ── report_to ───────────────────────────────────────────────────────────────
const policy = (from, to, o = {}) => decideTurnStart({ from, to, consultedBy: o.consultedBy || null, agents: AGENTS, adminIds: ADMINS, resolveVirtual: () => null, isLead: isLeadAgent, consultAllowed: o.consultAllowed || (async () => true) });
function jobRig(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(TMP, 'j'));
  const state = { notes: [], logs: [] };
  const runner = new JobRunner({
    dataDir, spawnMode: 'setsid', pollMs: 50, retryMs: 20, log: (...a) => state.logs.push(a.join(' ')), defaultCwd: async () => dataDir,
    notify: async (agent, message, onReply, meta) => { state.notes.push({ agent, message, meta }); },
    isAgentActive: () => false, agentExists: async (a) => AGENTS.some(x => x.name === a), ...extra,
  });
  return { runner, state, dataDir };
}
const reportOf = (r, o) => r.runner.run({ owner: 'member-bot', name: 'j1', command: 'true', reportTo: 'peer-a', ...o });

test('report_to: a member\'s agent reporting to an admin-side agent is refused when the job starts', async () => {
  const r = jobRig({ mayReport: (f, t, o) => policy(f, t, o) });
  await assert.rejects(reportOf(r), (e) => e.message.startsWith('report_to: ') && /may not start turns of "peer-a"/.test(e.message));
  assert.strictEqual(r.runner.jobs.size, 0, 'no job was started');
});

test('report_to: the consulter passes (and is recorded), a lead passes, the same pool passes, a withdrawn consult right refuses', async () => {
  const r = jobRig({ mayReport: (f, t, o) => policy(f, t, o) });
  const viaConsult = await r.runner.run({ owner: 'member-bot', name: 'c1', command: 'true', reportTo: 'peer-a', consultedBy: 'peer-a' });
  assert.strictEqual(r.runner.jobs.get(viaConsult.id).reportViaConsult, true);
  const lead = await r.runner.run({ owner: 'lead-a', name: 'l1', command: 'true', reportTo: 'other-bot' });
  assert.strictEqual(r.runner.jobs.get(lead.id).reportViaConsult, false);
  const same = await r.runner.run({ owner: 'member-bot', name: 's1', command: 'true', reportTo: 'sam-helper' });
  assert.strictEqual(r.runner.jobs.get(same.id).reportTo, 'sam-helper');
  const r2 = jobRig({ mayReport: (f, t, o) => policy(f, t, { ...o, consultAllowed: async () => false }) });
  await assert.rejects(r2.runner.run({ owner: 'member-bot', name: 'c2', command: 'true', reportTo: 'peer-a', consultedBy: 'peer-a' }), /^Error: report_to: /);
  // runTool hands the consulter through to run()
  const spec = TOOL_SPECS.find(s => s.name === 'run_job');
  const seen = [];
  const fakeRunner = { run: async (a) => { seen.push(a); return {}; } };
  await spec.run(fakeRunner, 'member-bot', { name: 'x', command: 'true' }, { consultedBy: 'peer-a' });
  assert.strictEqual(seen[0].consultedBy, 'peer-a'); assert.strictEqual(seen[0].reportTo, 'peer-a');
});

test('report_to: a pending report whose rule changes before delivery is dropped with a note; the owner\'s result notice still arrives', async () => {
  let allow = true;
  const calls = [];
  const r = jobRig({ mayReport: async (f, t, o) => { calls.push([f, t, o.consultedBy]); return allow ? { ok: true } : { ok: false, reason: 'the owner changed' }; } });
  const job = await r.runner.run({ owner: 'member-bot', name: 'j2', command: 'true', reportTo: 'sam-helper' });
  const j = r.runner.jobs.get(job.id);
  j.status = 'finished'; j.exitCode = 0; j.endedAt = new Date().toISOString();
  r.runner.pending.length = 0;
  r.runner.pending.push({ kind: 'result', jobId: j.id, agent: 'member-bot', message: 'result text', attempts: 0, notBefore: 0 });
  r.runner.pending.push({ kind: 'report', jobId: j.id, agent: 'sam-helper', message: 'report text', attempts: 0, notBefore: 0 });
  allow = false;
  await r.runner._deliver();
  assert.deepStrictEqual(r.state.notes.map(n => n.agent), ['member-bot'], 'only the result notice was delivered');
  assert.deepStrictEqual(r.runner.pending, [], 'the refused report left the pending list');
  assert.strictEqual(j.note, 'Report to sam-helper not delivered: the owner changed');
  assert.ok(r.state.logs.some(l => /dropped/.test(l) && /the owner changed/.test(l)));
  assert.deepStrictEqual(calls.at(-1), ['member-bot', 'sam-helper', null]);
  const saved = JSON.parse(fs.readFileSync(path.join(r.dataDir, 'jobs', 'index.json'), 'utf8'));
  assert.deepStrictEqual(saved.pending, [], 'saved');
  assert.match(saved.jobs[0].note, /not delivered/);
});

test('report_to: a throwing check counts as refused; an old job without reportViaConsult is checked as not-consulted', async () => {
  const seen = [];
  const r = jobRig({ mayReport: async (f, t, o) => { seen.push(o.consultedBy); if (seen.length === 2) throw new Error('boom'); return { ok: true }; } });
  const job = await r.runner.run({ owner: 'member-bot', name: 'j3', command: 'true', reportTo: 'sam-helper' });   // call 1 (start)
  const j = r.runner.jobs.get(job.id); delete j.reportViaConsult;
  r.runner.pending.length = 0;
  r.runner.pending.push({ kind: 'report', jobId: j.id, agent: 'sam-helper', message: 'rep', attempts: 0, notBefore: 0 });
  await r.runner._deliver();                                                                                      // call 2 (throws)
  assert.strictEqual(r.state.notes.length, 0);
  assert.deepStrictEqual(r.runner.pending, []);
  assert.match(j.note, /Report to sam-helper not delivered: .*boom/);
  assert.strictEqual(seen[1], null);
});

test('report_to: an allowed report is delivered and the consulter flag reaches the check', async () => {
  const seen = [];
  const r = jobRig({ mayReport: async (f, t, o) => { seen.push(o.consultedBy); return { ok: true }; } });
  const job = await r.runner.run({ owner: 'member-bot', name: 'j4', command: 'true', reportTo: 'peer-a', consultedBy: 'peer-a' });
  const j = r.runner.jobs.get(job.id);
  r.runner.pending.length = 0;
  r.runner.pending.push({ kind: 'report', jobId: j.id, agent: 'peer-a', message: 'rep', attempts: 0, notBefore: 0 });
  await r.runner._deliver();
  assert.deepStrictEqual(r.state.notes.map(n => n.agent), ['peer-a']);
  assert.strictEqual(seen.at(-1), 'peer-a');
});

test('report_to: a pending report whose job record is missing is refused and dropped, never delivered', async () => {
  let checks = 0;
  const r = jobRig({ mayReport: async () => { checks++; return { ok: true }; } });
  r.runner.pending.length = 0;
  r.runner.pending.push({ kind: 'report', jobId: 'nope', agent: 'peer-a', message: 'x', attempts: 0, notBefore: 0 });
  await r.runner._deliver();
  assert.strictEqual(r.state.notes.length, 0, 'notify was never called');
  assert.deepStrictEqual(r.runner.pending, [], 'the report left the pending list');
  assert.strictEqual(checks, 0, 'no owner to check against');
  assert.ok(r.state.logs.some(l => /dropped/.test(l) && /the job record is missing/.test(l)));
});

// ── Labels: who started a hub turn ──────────────────────────────────────────
function extractFn(src, header) {
  const at = src.indexOf(header); assert.ok(at >= 0, `${header} not found`);
  let i = src.indexOf('{', at), depth = 0, inTpl = 0;
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (c === '`') inTpl = inTpl ? 0 : 1;
    if (inTpl) continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(at, k + 1);
  }
  throw new Error('unbalanced');
}
const pageFns = {
  'app.js hubOriginLabel': new Function(`${extractFn(read('app.js'), 'function hubOriginLabel(origin)')}; return hubOriginLabel;`)(),
  'mobile.js originLabel': new Function(`${extractFn(read('mobile.js'), 'function originLabel(origin)')}; return originLabel;`)(),
};
for (const [name, label] of Object.entries(pageFns)) {
  test(`labels (${name}): schedule, task, alert, job notice, and the old shapes`, () => {
    // the owner's scheduler identity is '@owner' (lib/scheduled-tasks); a plain 'owner' is an agent of that name
    assert.strictEqual(label({ kind: 'schedule', by: '@owner', from: 'Morning check' }), 'scheduled task set by you: Morning check');
    assert.strictEqual(label({ kind: 'schedule', by: 'owner', from: 'Morning check' }), 'scheduled task set by owner: Morning check');
    assert.strictEqual(label({ kind: 'hand_off', from: 'lead' }), 'task from lead');   // the owner's wording (11-20): a hand-off reads "task" on screen
    assert.strictEqual(label({ kind: 'schedule', by: 'peer-a', from: 'Nightly' }), 'scheduled task set by peer-a: Nightly');
    assert.strictEqual(label({ kind: 'schedule', by: 'TASKS.md', from: 'cleanup' }), 'scheduled task set by TASKS.md: cleanup');
    assert.strictEqual(label({ kind: 'schedule', by: 'peer-a' }), 'scheduled task set by peer-a');
    assert.strictEqual(label({ kind: 'schedule', from: 'Nightly' }), 'scheduled task: Nightly', 'old origin without by');
    assert.strictEqual(label({ kind: 'schedule' }), 'scheduled task');
    assert.strictEqual(label({ kind: 'task', from: 'member-bot', label: 'queued task', taskId: '4' }), 'queued task from member-bot');
    assert.strictEqual(label({ kind: 'task', from: 'hub', label: 'condense memory' }), 'hub: condense memory');
    assert.strictEqual(label({ kind: 'task', label: 'condense memory' }), 'hub: condense memory');
    assert.strictEqual(label({ kind: 'task', from: 'hub' }), 'hub turn');
    assert.strictEqual(label({ kind: 'alert', from: 'disk monitor' }), 'alert from disk monitor');
    assert.strictEqual(label({ kind: 'alert' }), 'alert from a monitor');
    assert.strictEqual(label({ kind: 'job_notice', jobName: 'backup' }), 'your job finished: backup');
    assert.strictEqual(label({ kind: 'job_notice' }), 'your job finished');
    assert.strictEqual(label({ kind: 'job_report', from: 'sam-helper', jobName: 'x' }), 'job report from sam-helper (x)');
    assert.strictEqual(label({ kind: 'consultation', from: 'peer-a' }), 'consulted by peer-a');
    assert.strictEqual(label({ kind: 'comms' }), 'message from a messaging channel');
    assert.strictEqual(label({ kind: 'user' }), 'replying to you');
    assert.strictEqual(label(null), 'hub turn');
  });
}

test('pages show the label as text, never as HTML', () => {
  assert.match(read('app.js'), /function appendSystemNotice\(chatId, text, variant\) \{[\s\S]*?\} else \{\s*div\.textContent = text;/);
  assert.match(read('mobile.js'), /function addNote\(text\) \{[\s\S]*?d\.textContent = text;/);
  assert.match(read('mobile.js'), /act-origin">\$\{esc\(originLabel\(a\.origin\)\)\}/);
});

// ── Origin fields reach the log, the page and the hub's event stream ────────────
test('logOriginOf keeps by and label; wakeAgent passes them; schedule sources set by (source pins: sdk-chat cannot load in isolation)', () => {
  const sdk = read('lib/sdk-chat.js');
  const fn = extractFn(sdk, 'function logOriginOf(origin)');
  const logOriginOf = new Function(`${fn}; return logOriginOf;`)();
  assert.deepStrictEqual(logOriginOf({ kind: 'task', from: 'member-bot', by: 'peer-a', label: 'queued task', taskId: '7', jobId: 'zz', junk: 5 }), { kind: 'task', from: 'member-bot', by: 'peer-a', label: 'queued task', taskId: '7' });
  assert.strictEqual(logOriginOf({ kind: 'schedule', by: 'x'.repeat(300) }).by.length, 200);
  assert.deepStrictEqual(logOriginOf({ kind: 'schedule', from: 'Nightly' }), { kind: 'schedule', from: 'Nightly' }, 'old origins unchanged');
  const wake = extractFn(sdk, 'function wakeAgent(agentName, message, onReply, meta = null)');
  assert.match(wake, /\.\.\.\(meta\?\.by \? \{ by: meta\.by \} : \{\}\), \.\.\.\(meta\?\.label \? \{ label: meta\.label \} : \{\}\)/);
  // member origin (test/member-origin.test.js): scheduled and queued tasks made in a member's turn also carry member
  assert.match(read('lib/scheduled-tasks.js'), /\{ kind: 'schedule', from: t\.label, taskId: t\.id, by: t\.createdBy, \.\.\.\(t\.member === true \? \{ member: true \} : \{\}\), \.\.\.\(t\.handOff \? \{ handOff: t\.handOff \} : \{\}\) \}/);
  assert.match(read('lib/scheduler.js'), /origin: \{ kind: 'schedule', from: taskId, by: 'TASKS\.md' \}/);
  assert.match(read('lib/task-queue.js'), /origin: \{ kind: 'task', from: task\.creator_agent, label: `queued task from \$\{task\.creator_agent\}`, taskId: String\(task\.id\), \.\.\.\(Number\(task\.member\) === 1 \? \{ member: true \} : \{\}\) \}/);
});
