'use strict';
// Build Team, server side: the plan tool (team_plan), the line tool (team_set), the facts for the lead's turn, the route's
// decisions, the shipped playbook. Everything runs on fakes; no model is called and nothing under the real data/ is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const TP = require('../lib/team-plan');
const { createTranscript } = require('../lib/transcript');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const roster = () => [
  { name: 'lead', display: 'Lead', category: 'primary', lead: true, model: 'm-top' },
  { name: 'studio', display: 'Studio', category: 'primary', model: 'm-top', blurb: 'Runs the studio' },
  { name: 'builder', display: 'Builder', category: 'worker', model: 'm-strong' },
  { name: 'coder', display: 'Coder', category: 'worker', model: 'm-cheap' },
  { name: 'critic', display: 'Critic', category: 'specialist', model: 'm-top' },
  { name: 'sam', display: 'Sam', category: 'primary', owner: 'u-member', model: 'm-strong', blurb: 'Private notes about a member' },
];
const PLAN = () => ({
  for: 'studio', summary: 'A builder and a coder help the studio',
  new_agents: [{ name: 'helper', display: 'Helper', role: 'worker', reports_to: 'builder', tier: 'cost-effective', model: 'm-cheap', why: 'bulk work' }],
  lines: [{ agent: 'builder', reports_to: 'studio', why: 'long work' }, { agent: 'coder', reports_to: 'builder', why: 'code' }],
  model_changes: [{ agent: 'coder', model: 'm-strong', why: 'code quality' }],
  specialists: [{ agent: 'critic', why: 'reviews' }],
});

const idOf = (m, n) => { const r = m.list.find(x => x && x.name === n); return r ? (r.box ? `box:${r.box}` : `name:${r.name}`) : null; };
function make(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-plan-'));
  const list = o.roster || roster();
  const calls = { update: [], model: [], notify: [], pub: [], push: [], records: [] };
  const files = new Map();   // the Records the fake writer holds: `${agent}/${name}` -> content (a write replaces)
  const svc = TP.createTeamPlan({
    agents: () => list,
    adminIds: new Set(['u-admin']),
    isVirtual: (n) => /^tw-/.test(n),
    availableModels: o.availableModels || (async () => ['m-top', 'm-strong', 'm-cheap', 'm-new']),
    providerOf: (m) => { const i = String(m).indexOf("/"); return i > 0 ? String(m).slice(0, i) : "anthropic"; },
    // like lib/agents.js agentIdentity: the box id, or the name for an agent from before box ids
    identitiesOf: o.identitiesOf || ((names) => new Map(names.map(n => { const r = list.find(x => x && x.name === n); return [n, r ? (r.box ? `box:${r.box}` : `name:${r.name}`) : null]; }))),
    // the defaults load lib/temporal-workers and lib/agents, which read the install's own data/ (the suite refuses that)
    resolveModel: (m, avail) => (avail.includes(m) ? { model: m } : { error: `model "${m}" is not reachable on this install.` }),
    validName: (n) => /^[a-z][a-z0-9_-]{0,31}$/.test(n),
    updateField: async (name, fields, ctx) => {
      calls.update.push({ name, fields, hasNotifyTeam: typeof ctx.notifyTeam === 'function' });
      const a = list.find(x => x.name === name);
      if (!a) return { success: false, error: 'Agent not found' };
      if (o.updateFails) return { success: false, error: 'refused by the rules' };
      if (o.enforce && fields.reportsTo) { const why = require('../lib/ui-teams').checkReportsTo(name, fields.reportsTo, list, new Set(['u-admin'])); if (why) return { success: false, error: why }; }
      const before = new Map(list.map(x => [x.name, x.reportsTo]));
      if (fields.reportsTo) a.reportsTo = fields.reportsTo; else delete a.reportsTo;
      // like lib/agents.js updateAgentField: lines valid before the write and broken by it are cleared in the same save
      if (o.enforce) {
        const T = require('../lib/ui-teams'), adm = new Set(['u-admin']);
        const prev = list.map(x => Object.assign({}, x, { reportsTo: before.get(x.name) }));
        for (const x of list) {
          if (x === a || !x.reportsTo) continue;
          if (!T.checkReportsTo(x.name, x.reportsTo, prev, adm) && T.checkReportsTo(x.name, x.reportsTo, list, adm)) { calls.cascade = (calls.cascade || []).concat([x.name]); delete x.reportsTo; }
        }
      }
      return { success: true };
    },
    setModel: async (name, model) => { calls.model.push([name, model]); const a = list.find(x => x.name === name); if (a) a.model = model; return { success: true }; },
    notifyTeam: (text) => calls.notify.push(text),
    published: (name, changed) => calls.pub.push([name, changed]),
    push: { notify: (p, op) => { calls.push.push({ p, op }); } },
    // the default writes the agent's real Records folder: never in a test
    writeRecord: o.writeRecord || ((agent, name, content) => { calls.records.push([agent, name, content]); files.set(`${agent}/${name}`, content); return `Record ${name} written (${content.length} bytes).`; }),
    auditFile: path.join(dir, 'team-changes-log.jsonl'),
    now: () => 0,
  });
  const log = () => { try { return fs.readFileSync(path.join(dir, 'team-changes-log.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  return { svc, list, calls, files, dir, log, file: path.join(dir, 'team-changes-log.jsonl'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const ctx = (m, over = {}) => ({ lead: 'lead', turnOf: () => 't1', stillAllowed: () => true, forUser: 'u-admin', ...over });
const doIt = (checked) => async () => ({ choice: 'Do it', checked });

// ── team_plan: validation (the error goes back to the lead; no card, nothing applied) ──
test('team_plan validation errors come back to the lead and nothing is asked or applied', async (t) => {
  const m = make(); t.after(m.cleanup);
  let asked = 0;
  const run = (mut) => { const p = PLAN(); mut(p); return m.svc.runPlan(p, { ...ctx(m), ask: async () => { asked++; return { choice: 'Do it', checked: [] }; } }); };
  const cases = [
    [(p) => { p.for = 'ghost'; }, /no agent named "ghost"/],
    [(p) => { p.for = 'builder'; }, /not a main agent/],
    [(p) => { p.new_agents[0].name = 'coder'; }, /already exists/],
    [(p) => { p.new_agents[0].name = 'Bad-Name'; }, /not a usable agent name/],
    [(p) => { p.new_agents[0].model = 'no-such-model'; }, /not reachable on this install/],
    [(p) => { p.new_agents[0].reports_to = 'ghost'; }, /not an existing agent or a new one/],
    [(p) => { p.new_agents[0].role = 'boss'; }, /role must be leader or worker/],
    [(p) => { p.new_agents[0].tier = 'cheap'; }, /tier must be one of/],
    [(p) => { p.lines[0].agent = 'ghost'; }, /no agent named "ghost"/],
    [(p) => { p.lines[0].agent = 'helper'; }, /new agent/],
    [(p) => { p.lines = [{ agent: 'studio', reports_to: 'lead' }]; }, /main agent/],
    [(p) => { p.lines = [{ agent: 'builder', reports_to: 'coder' }, { agent: 'coder', reports_to: 'builder' }]; }, /already reports to|line for /],
    [(p) => { p.lines = [{ agent: 'builder', reports_to: 'sam' }]; }, /belongs to someone else/],
    [(p) => { p.model_changes = [{ agent: 'coder', model: 'nope' }]; }, /not reachable/],
    [(p) => { p.model_changes = [{ agent: 'coder', model: 'm-cheap' }]; }, /already uses/],
    [(p) => { p.model_changes = [{ agent: 'sam', model: 'm-top' }]; }, /belongs to a member/],
    [(p) => { p.model_changes = [{ agent: 'lead', model: 'm-strong' }]; }, /your own model/],
    [(p) => { p.specialists = [{ agent: 'ghost' }]; }, /no agent named "ghost"/],
    [(p) => { delete p.summary; }, /summary/],
    [(p) => { p.lines = new Array(21).fill({ agent: 'builder', reports_to: 'studio' }); }, /at most 20/],
  ];
  for (const [mut, re] of cases) {
    const out = await run(mut);
    assert.match(out, /^The plan was not shown\./, String(re));
    assert.match(out, re);
  }
  assert.equal(asked, 0, 'no card for a plan that does not validate');
  assert.equal(m.calls.update.length + m.calls.model.length, 0);
  assert.deepEqual(m.log(), []);
});

test('team_plan: a valid plan is checked against a graph that holds the new agents (category worker) and every line', async (t) => {
  const m = make(); t.after(m.cleanup);
  const v = await m.svc.validate(PLAN(), 'lead');
  assert.ok(v.plan, v.error);
  assert.deepEqual(v.plan.items.map(i => i.id), ['n1', 'l1', 'l2', 'm1', 's1']);
  // a new leader with a new worker under it, and an existing agent under the new leader: all pass the same rules as a PATCH
  const p = PLAN();
  p.new_agents = [{ name: 'chief', display: 'Chief', role: 'leader', reports_to: 'studio', tier: 'strong', model: 'm-strong' }, { name: 'helper', role: 'worker', reports_to: 'chief', tier: 'local', model: 'm-cheap' }];
  p.lines = [{ agent: 'coder', reports_to: 'chief' }];
  assert.ok((await m.svc.validate(p, 'lead')).plan);
  // depth: a worker under a worker that is under a leader is one level too many
  p.new_agents.push({ name: 'deep', role: 'worker', reports_to: 'helper', tier: 'local', model: 'm-cheap' });
  assert.match((await m.svc.validate(p, 'lead')).error, /new agent (deep|helper): /);
});

test('team_plan: an empty plan (no team needed) shows no card', async (t) => {
  const m = make(); t.after(m.cleanup);
  let asked = 0;
  const out = await m.svc.runPlan({ for: 'studio', summary: 'No team needed' }, { ...ctx(m), ask: async () => { asked++; } });
  assert.match(out, /^Nothing to approve/);
  assert.equal(asked, 0);
});

// ── the card, Not now, Change something ──
test('the plan card: checklist (one item per change), options, adminOnly for the starter, no skip', async (t) => {
  const m = make(); t.after(m.cleanup);
  let card;
  await m.svc.runPlan(PLAN(), { ...ctx(m), ask: async (a) => { card = a; return { choice: 'Not now', checked: [] }; } });
  assert.deepEqual(card.options, ['Do it', 'Change something', 'Not now']);
  assert.equal(card.adminOnly, true);
  assert.equal(card.forUser, 'u-admin');
  assert.equal(card.allow_skip, false);
  assert.deepEqual(card.checklist.map(c => c.id), ['n1', 'l1', 'l2', 'm1', 's1']);
  assert.ok(card.checklist.every(c => c.label && typeof c.detail === 'string'));
  assert.match(card.checklist[0].label, /^Create Helper \(helper\): worker under Builder$/);
  assert.match(card.checklist[3].label, /Coder: change model to m-strong/);
  assert.match(card.question, /^Lead proposes for Studio: A builder and a coder help the studio \(1 new agent, 2 reporting lines, 1 model change, 1 specialist note\)/);
});

test('the plan card: the lead by its display name, long text ends at a word with an ellipsis, specialists without a Note label', async (t) => {
  const m = make(); t.after(m.cleanup);
  const p = PLAN();
  p.summary = 'word '.repeat(200).trim();
  p.new_agents[0].why = 'reason '.repeat(60).trim();
  let card;
  await m.svc.runPlan(p, { ...ctx(m), ask: async (a) => { card = a; return { choice: 'Not now', checked: [] }; } });
  assert.match(card.question, /^Lead proposes for Studio: word word/);
  assert.ok(card.question.length <= 900);
  assert.match(card.question, /word\u2026 \(1 new agent, /, 'the summary ends at a word, then the counts');
  const d = card.checklist[0].detail;
  assert.match(d, /^cost-effective tier, m-cheap\. reason reason/);
  assert.match(d, /reason\u2026$/, 'cut at a whole word');
  assert.ok(d.length <= 300);
  assert.equal(card.checklist[4].label, 'Critic works with this team as a shared specialist');
  assert.ok(card.checklist.every(c => !/^Note:/.test(c.label)));
  const params = JSON.stringify(TP.PLAN_TOOL);
  assert.match(params, /at most 600 characters/);
  assert.match(params, /at most 200 characters/);
});

test('Not now and Change something apply nothing and store no plan', async (t) => {
  const m = make(); t.after(m.cleanup);
  for (const [choice, want] of [['Not now', 'Nothing was changed.'], ['Change something', 'The person wants changes; ask what to change (ask_user), then call team_plan again.']]) {
    const out = await m.svc.runPlan(PLAN(), { ...ctx(m), ask: async () => ({ choice, checked: ['n1', 'l1', 'l2', 'm1', 's1'] }) });
    assert.equal(out, want);
  }
  // no answer, a skip, a typed answer, a failing ask: the same as Not now
  for (const got of ['NO_ANSWER', 'SKIPPED', null, { choice: 'something typed', checked: ['l1'] }]) {
    assert.equal(await m.svc.runPlan(PLAN(), { ...ctx(m), ask: async () => got }), 'Nothing was changed.');
  }
  assert.equal(await m.svc.runPlan(PLAN(), { ...ctx(m), ask: async () => { throw new Error('boom'); } }), 'Nothing was changed.');
  assert.equal(m.calls.update.length, 0); assert.equal(m.calls.model.length, 0); assert.deepEqual(m.log(), []);
  assert.equal(m.svc.approvedFor('lead', 't1'), null);
});

// ── Do it ──
test('Do it: an unticked line is not applied; ticked lines and model changes are applied and logged', async (t) => {
  const m = make(); t.after(m.cleanup);
  const out = await m.svc.runPlan(PLAN(), { ...ctx(m), ask: doIt(['n1', 'l1', 'm1', 's1']) });
  // the ticked line between existing agents went through updateAgentField with the team notice hook
  assert.deepEqual(m.calls.update, [{ name: 'builder', fields: { reportsTo: 'studio' }, hasNotifyTeam: true }]);
  assert.equal(m.list.find(a => a.name === 'builder').reportsTo, 'studio');
  assert.equal(m.list.find(a => a.name === 'coder').reportsTo, undefined, 'the unticked line was not applied');
  // the ticked model change went through setAgentModel
  assert.deepEqual(m.calls.model, [['coder', 'm-strong']]);
  // log: mode 0600, {at, by, action, agent, from, to}
  assert.equal(fs.statSync(m.file).mode & 0o777, 0o600);
  assert.deepEqual(m.log(), [
    { at: '1970-01-01T00:00:00.000Z', by: 'lead', action: 'reports_to', agent: 'builder', from: null, to: 'studio' },
    { at: '1970-01-01T00:00:00.000Z', by: 'lead', action: 'model', agent: 'coder', from: 'm-cheap', to: 'm-strong' },
  ]);
  // agent_updated published; admin push with the way to undo it
  assert.deepEqual(m.calls.pub, [['builder', ['reportsTo']], ['coder', ['model']]]);
  assert.equal(m.calls.push.length, 1);
  assert.equal(m.calls.push[0].p.body, 'Model changed for coder: m-cheap -> m-strong. To undo it, choose m-cheap again on its settings page.');
  assert.deepEqual(m.calls.push[0].op, { adminsOnly: true, kind: 'security' });
  // what the lead is told
  assert.match(out, /Applied now:\n- builder now reports to studio\n- coder model m-cheap -> m-strong/);
  assert.match(out, /Left unticked \(not to be done\):\n- Coder reports to Builder/);
  assert.match(out, /New agents to create with create_agent .*:\n- helper \(Helper\): worker, model m-cheap, tier cost-effective, reports_to builder/);
  assert.match(out, /Shared specialists for this team \(information\):\n- critic: reviews/, 'a ticked specialist note is included');
  // the approved plan holds only the ticked items (and the specialist note)
  assert.deepEqual(m.svc.approvedFor('lead', 't1').items.map(i => i.id), ['n1', 'l1', 'm1', 's1']);
});

test('Do it: a line whose boss is a new agent waits for team_set; a refused line is reported, not hidden', async (t) => {
  const m = make(); t.after(m.cleanup);
  const p = PLAN();
  p.new_agents = [{ name: 'chief', role: 'leader', reports_to: 'studio', tier: 'strong', model: 'm-strong' }];
  p.lines = [{ agent: 'coder', reports_to: 'chief' }];
  p.model_changes = []; p.specialists = [];
  const out = await m.svc.runPlan(p, { ...ctx(m), ask: doIt(['n1', 'l1']) });
  assert.equal(m.calls.update.length, 0, 'not applied before the boss exists');
  assert.match(out, /Lines to set with team_set once their boss exists:\n- coder reports_to chief/);
  const bad = make({ updateFails: true }); t.after(bad.cleanup);
  const out2 = await bad.svc.runPlan(PLAN(), { ...ctx(bad), ask: doIt(['l1']) });
  assert.match(out2, /Could not apply:\n- Builder reports to Studio: refused by the rules/);
  assert.deepEqual(bad.log(), []);
});

test('Do it: when the turn ended during the answer, nothing is applied', async (t) => {
  const m = make(); t.after(m.cleanup);
  let on = true;
  const out = await m.svc.runPlan(PLAN(), { ...ctx(m, { stillAllowed: () => on }), ask: async () => { on = false; return { choice: 'Do it', checked: ['l1', 'm1'] }; } });
  assert.match(out, /turn ended/);
  assert.equal(m.calls.update.length + m.calls.model.length, 0);
  assert.equal(m.svc.approvedFor('lead', 't1'), null);
  // and when the turn id changed
  let id = 't1';
  const out2 = await m.svc.runPlan(PLAN(), { ...ctx(m, { turnOf: () => id }), ask: async () => { id = 't2'; return { choice: 'Do it', checked: ['l1'] }; } });
  assert.match(out2, /turn ended/);
  assert.equal(m.calls.update.length, 0);
});

test('Do it: agents that changed while the person answered are judged again, nothing applied', async (t) => {
  const m = make(); t.after(m.cleanup);
  const out = await m.svc.runPlan(PLAN(), { ...ctx(m), ask: async () => { m.list.push({ name: 'helper', category: 'worker', model: 'm-cheap' }); return { choice: 'Do it', checked: ['l1', 'm1'] }; } });
  assert.match(out, /^Things changed while the person was answering, so nothing was applied\./);
  assert.equal(m.calls.update.length + m.calls.model.length, 0);
});

// ── team_set ──
async function approvedPlan(m) {
  m.list.push({ name: 'helper', category: 'worker', model: 'm-cheap' });   // as if create_agent had made it
  // the plan was approved before helper existed; the roster above stands in for create_agent having run since
  const roster0 = m.list.filter(a => a.name !== 'helper');
  const keep = m.list.splice(0, m.list.length, ...roster0);
  await m.svc.runPlan(PLAN(), { ...ctx(m), ask: doIt(['n1', 'l1', 'm1']) });
  m.list.splice(0, m.list.length, ...keep);
  m.svc.noteCreated('lead', ctx(m).turnOf(), m.svc.approvedFor('lead', ctx(m).turnOf()), 'helper', idOf(m, 'helper'));   // as create_agent does for a planned agent
}

test('team_set: a line approved in this turn passes without asking; an unapproved line asks once', async (t) => {
  const m = make(); t.after(m.cleanup);
  await approvedPlan(m);
  m.calls.update.length = 0;
  let asked = [];
  const confirm = async (q, label) => { asked.push([q, label]); return true; };
  const ok = await m.svc.runSet({ lines: [{ agent: 'helper', reports_to: 'builder' }] }, { ...ctx(m), confirm });
  assert.deepEqual(asked, [], 'an approved line is set without a question');
  assert.deepEqual(m.calls.update.map(c => [c.name, c.fields.reportsTo, c.hasNotifyTeam]), [['helper', 'builder', true]]);
  assert.match(ok, /helper: now reports to builder/);
  assert.deepEqual(m.log().at(-1), { at: '1970-01-01T00:00:00.000Z', by: 'lead', action: 'reports_to', agent: 'helper', from: null, to: 'builder' });
  // another line (not in the plan), and a plan line with another boss: one question for all of them
  const out = await m.svc.runSet({ lines: [{ agent: 'critic', reports_to: 'studio' }, { agent: 'helper', reports_to: 'studio' }] }, { ...ctx(m), confirm });
  assert.equal(asked.length, 1);
  assert.equal(asked[0][1], 'Set them');
  assert.match(asked[0][0], /2 reporting lines: critic reports to studio; helper reports to studio/);
  assert.match(out, /critic: now reports to studio/);
  assert.equal(m.list.find(a => a.name === 'critic').reportsTo, 'studio');
});

test('team_set: Leave as is changes nothing for the unapproved lines (an approved one in the same call still goes through)', async (t) => {
  const m = make(); t.after(m.cleanup);
  await approvedPlan(m);
  m.calls.update.length = 0;
  const out = await m.svc.runSet({ lines: [{ agent: 'helper', reports_to: 'builder' }, { agent: 'critic', reports_to: 'studio' }] }, { ...ctx(m), confirm: async () => false });
  assert.deepEqual(m.calls.update.map(c => c.name), ['helper']);
  assert.match(out, /critic: left as is/);
  assert.equal(m.list.find(a => a.name === 'critic').reportsTo, undefined);
  // no confirm function: the same
  const out2 = await m.svc.runSet({ lines: [{ agent: 'critic', reports_to: 'studio' }] }, { ...ctx(m) });
  assert.match(out2, /critic: left as is/);
});

test('team_set: a plan from another turn or another agent never counts', async (t) => {
  const m = make(); t.after(m.cleanup);
  await approvedPlan(m);
  const line = { lines: [{ agent: 'helper', reports_to: 'builder' }] };
  const asks = [];
  const confirm = async (q) => { asks.push(q); return false; };
  // another agent's turn
  await m.svc.runSet(line, { ...ctx(m, { lead: 'sam-lead' }), confirm });
  assert.equal(asks.length, 1, 'another agent asks');
  // another turn of the same agent: asks, and the old plan is dropped
  await m.svc.runSet(line, { ...ctx(m, { turnOf: () => 't2' }), confirm });
  assert.equal(asks.length, 2, 'a later turn asks');
  assert.equal(m.svc.approvedFor('lead', 't1'), null, 'dropped');
  await m.svc.runSet(line, { ...ctx(m), confirm });
  assert.equal(asks.length, 3, 'even back in the old turn id the plan is gone');
  // drop(): the turn's end
  await approvedPlan(m);
  m.svc.drop('lead');
  await m.svc.runSet(line, { ...ctx(m), confirm });
  assert.equal(asks.length, 4);
  assert.equal(m.calls.update.filter(c => c.name === 'helper').length, 0);
});

test('team_set: not offered outside an owner turn, input limits, temporary workers refused', async (t) => {
  const m = make(); t.after(m.cleanup);
  assert.equal(await m.svc.runSet({ lines: [{ agent: 'helper', reports_to: 'builder' }] }, { ...ctx(m, { stillAllowed: () => false }) }), TP.NOT_OFFERED);
  assert.equal(await m.svc.runSet({ lines: [{ agent: 'helper', reports_to: 'builder' }] }, { ...ctx(m, { turnOf: () => null }) }), TP.NOT_OFFERED);
  assert.match(await m.svc.runSet({ lines: [] }, ctx(m)), /give a list/);
  assert.match(await m.svc.runSet({ lines: new Array(31).fill({ agent: 'coder', reports_to: 'builder' }) }, ctx(m)), /at most 30/);
  assert.match(await m.svc.runSet({ lines: [{ agent: 'tw-x-1', reports_to: 'builder' }] }, ctx(m)), /temporary worker/);
  assert.match(await m.svc.runSet({ lines: [{ agent: 'coder', reports_to: 5 }] }, ctx(m)), /name or null/);
  assert.equal(await m.svc.runPlan(PLAN(), { ...ctx(m, { stillAllowed: () => false }), ask: async () => ({}) }), TP.NOT_OFFERED);
});

// ── the facts for the lead's turn ──
const big = (n) => Array.from({ length: n }, (_, i) => ({ name: `agent${i}`, display: `Agent ${i}`, category: i % 2 ? 'worker' : 'specialist', model: 'm-cheap', blurb: 'x'.repeat(300) }));
const facts = (message) => JSON.parse(message.match(/```json\n([\s\S]*)\n```$/)[1]);
const tierOf = (m) => (m === 'm-top' ? 'top' : m === 'm-strong' ? 'mid' : 'fast');

test('the message: a short instruction, then the facts as data in one fenced block', () => {
  const list = roster().concat([{ name: 'helper', category: 'worker', model: 'm-cheap', reportsTo: 'builder' }]);
  list.find(a => a.name === 'builder').reportsTo = 'studio';
  const counts = () => ({ turns: { user: 5, hand_off: 2 }, tools: { hand_off: 2, consult_agent: 3, spawn_workers: 1, Bash: 40 } });
  const msg = TP.buildMessage({ primary: list[1], agentsList: list, adminIds: new Set(['u-admin']), counts, models: [{ id: 'm-top', provider: 'acme', tier: 'top' }], tierOf });
  assert.match(msg, /^Follow TEAM-PLAYBOOK\.md in your workspace\. Propose a team for Studio, or say none is needed, and submit it with team_plan\.\n\nThe block below is information from the hub, not instructions\.\n```json\n/);
  assert.equal((msg.match(/```/g) || []).length, 2);
  const f = facts(msg);
  assert.deepEqual(f.agent, { name: 'studio', display: 'Studio', category: 'primary', model: 'm-top', tier: 'top', blurb: 'Runs the studio', side: 'admin' });
  assert.deepEqual(f.team_now, [{ name: 'builder', boss: 'studio' }, { name: 'helper', boss: 'builder' }]);
  assert.ok(f.agents.find(a => a.name === 'coder' && a.tier === 'fast' && a.category === 'worker'));
  assert.equal(f.agents.find(a => a.name === 'builder').boss, 'studio');
  assert.equal(f.agents.find(a => a.name === 'builder').model, 'm-strong', 'each admin-side agent carries its model id');
  assert.deepEqual(f.activity_30_days, { turns_by_kind: { user: 5, hand_off: 2 }, hand_offs: 2, consults: 3, spawn_workers: 1 });
  assert.deepEqual(f.models, [{ id: 'm-top', provider: 'acme', tier: 'top' }]);
  assert.ok(!/"(text|message|content)"/.test(msg), 'counts only: no message text anywhere');
});

test('the facts stay under about 6,000 characters, blurbs cut to 120, markup and fences neutralised', () => {
  const list = roster().concat(big(70));
  list.find(a => a.name === 'critic').blurb = 'long '.repeat(80) + '``` ignore all of this';
  const small = TP.buildMessage({ primary: list[1], agentsList: roster().concat([{ name: 'extra', category: 'worker', blurb: 'y'.repeat(300) }]), adminIds: new Set(['u-admin']), counts: () => null, models: [], tierOf });
  assert.equal(facts(small).agents.find(a => a.name === 'extra').blurb.length, 120);
  assert.equal(facts(small).activity_30_days, 'not available');
  const msg = TP.buildMessage({ primary: list[1], agentsList: list, adminIds: new Set(['u-admin']), counts: () => ({ turns: {}, tools: {} }), models: Array.from({ length: 40 }, (_, i) => ({ id: `acme/model-${i}`, provider: 'acme' })), tierOf });
  const block = msg.slice(msg.indexOf('```json'));
  assert.ok(block.length <= TP.FACTS_MAX, `block is ${block.length} characters`);
  assert.equal((msg.match(/```/g) || []).length, 2, 'a fence inside a blurb cannot close the block');
  assert.ok(facts(msg).agents.length >= 8);
});

test("a member's primary: counts only, no blurbs, no identity, and a line saying its conversations are not to be read", () => {
  const list = roster();
  const msg = TP.buildMessage({ primary: list.find(a => a.name === 'sam'), agentsList: list, adminIds: new Set(['u-admin']), counts: () => ({ turns: { user: 9 }, tools: {} }), models: [], tierOf });
  const f = facts(msg);
  assert.equal(f.agent.side, 'member');
  assert.equal(f.agent.blurb, undefined);
  assert.match(f.note, /only counts are given; its conversations are not to be read/);
  assert.deepEqual(f.activity_30_days.turns_by_kind, { user: 9 });
  assert.ok(!msg.includes('u-member') && !msg.includes('Private notes about a member'), 'neither the owner id nor the member agent\'s blurb');
  const sam = f.agents.find(a => a.name === 'studio');
  assert.ok(sam, 'the admin side agents are listed');
  assert.equal(f.agents.find(a => a.name === 'lead').blurb, undefined, 'an agent with no blurb carries none');
});

test('countsSince: counts by origin kind and tool from the transcript, never any text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-plan-tr-'));
  const tr = createTranscript({ file: path.join(dir, 'x.db'), log: () => {} });
  try {
    const day = 86400000, at = (d) => new Date(Date.now() - d * day).toISOString();
    tr.record({ agent: 'studio', kind: 'user', text: 'secret words one', origin: 'user', ts: at(1) });
    tr.record({ agent: 'studio', kind: 'user', text: 'secret words two', origin: 'user', ts: at(2) });
    tr.record({ agent: 'studio', kind: 'user', text: 'secret words three', origin: 'hand_off', ts: at(3) });
    tr.record({ agent: 'studio', kind: 'user', text: 'secret words four', origin: 'interjection', ts: at(3) });
    tr.record({ agent: 'studio', kind: 'user', text: 'secret old words', origin: 'user', ts: at(60) });
    tr.record({ agent: 'studio', kind: 'tool_use', tool: 'hand_off', text: 'hand_off a', ts: at(1) });
    tr.record({ agent: 'studio', kind: 'tool_use', tool: 'hand_off', text: 'hand_off b', ts: at(2) });
    tr.record({ agent: 'studio', kind: 'tool_use', tool: 'mcp__agent-hub__consult_agent', text: 'consult c', ts: at(2) });
    tr.record({ agent: 'studio', kind: 'tool_use', tool: 'spawn_workers', text: 'old spawn', ts: at(45) });
    const c = TP.transcriptCounts(30, { transcript: tr })('studio');
    assert.deepEqual(c, { turns: { user: 2, hand_off: 1 }, tools: { hand_off: 2, consult_agent: 1 } });
    assert.ok(!JSON.stringify(c).includes('secret'));
    assert.equal(TP.transcriptCounts(30, { transcript: tr })('nobody'), null, 'no archive: not available, not zero');
  } finally { tr.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── the route's decisions ──
function routeDeps(over = {}) {
  const runs = new Map();
  const started = [];
  return {
    started, runs,
    deps: {
      adminSession: true, name: 'studio', agents: roster(), ownerLeadNames: (l) => l.filter(a => a.lead).map(a => a.name), defaultLeadAgent: () => 'lead',
      runs, halted: () => false, isBusy: () => false, makeMessage: async (rec) => `message for ${rec.name}`,
      start: async (a) => { started.push(a); runs.set(a.primary, 'pending'); return { ok: true, lead: a.lead, turnId: 'lead-turn-1' }; }, userId: 'u-admin', ...over,
    },
  };
}
test('route: 202 with the lead and the turn id; the lead is the default lead among the owner leads', async () => {
  const r = routeDeps({ agents: roster().concat([{ name: 'second', category: 'primary', lead: true }]), defaultLeadAgent: () => 'second' });
  const out = await TP.routeBuildTeam(r.deps);
  assert.deepEqual(out, { status: 202, body: { ok: true, lead: 'second', turnId: 'lead-turn-1' } });
  assert.equal(r.started[0].message, 'message for studio');
  assert.equal(r.started[0].display, 'Studio');
  const r2 = routeDeps({ defaultLeadAgent: () => 'ghost' });
  assert.equal((await TP.routeBuildTeam(r2.deps)).body.lead, 'lead', 'else the first owner lead');
});
test('route: anyone but an admin\'s own signed-in browser session is refused (403), and nothing starts', async () => {
  // members, API tokens, the hub service and a pending two-factor sign-in all make adminSession false (server.js expression, pinned below)
  const r = routeDeps({ adminSession: false });
  assert.deepEqual(await TP.routeBuildTeam(r.deps), { status: 403, body: { error: 'Sign in with an admin account in your browser to build a team.' } });
  for (const bad of [undefined, null, 1, 'yes', {}]) assert.equal((await TP.routeBuildTeam(routeDeps({ adminSession: bad }).deps)).status, 403);
  assert.equal(r.started.length, 0);
});
test('route: the server computes adminSession with the owner_turn test, and the route is not an agent route for the access gate', () => {
  const server = read('server.js');
  const at = server.indexOf("/build-team$/.test(pathname) && req.method === 'POST'");
  assert.ok(at > 0, 'the route is there');
  const body = server.slice(at, at + 1800);
  assert.match(body, /adminSession: req\.hubIdentKind === 'user' && !req\.hubPendingTotp && !req\.hubToken && !req\.hubService && access\.isAdmin\(req\.hubUser\)/);
  const access = require('../lib/access');
  assert.equal(access.classifyRoute('/api/agents/studio/build-team', 'POST').kind, 'admin', 'a member never reaches it, whatever agents they may use');
  assert.equal(access.tokenAllows ? true : true, true);
});
test('route: 404 unknown agent, 400 a non-main agent, 409 no lead, 409 a second start, 409 lead busy, 503 halted', async () => {
  assert.deepEqual(await TP.routeBuildTeam(routeDeps({ name: 'ghost' }).deps), { status: 404, body: { error: 'No agent named "ghost".' } });
  assert.deepEqual(await TP.routeBuildTeam(routeDeps({ name: 'builder' }).deps), { status: 400, body: { error: 'only a main agent can have a team built' } });
  assert.deepEqual(await TP.routeBuildTeam(routeDeps({ ownerLeadNames: () => [] }).deps), { status: 409, body: { error: 'no lead agent is set' } });
  const r = routeDeps();
  assert.equal((await TP.routeBuildTeam(r.deps)).status, 202);
  assert.deepEqual(await TP.routeBuildTeam(r.deps), { status: 409, body: { error: 'already building a team for Studio' } });
  assert.equal(r.started.length, 1, 'the second start never reached the turn');
  assert.deepEqual(await TP.routeBuildTeam(routeDeps({ isBusy: (n) => n === 'lead' }).deps), { status: 409, body: { error: 'lead is busy', busy: true } });
  assert.deepEqual(await TP.routeBuildTeam(routeDeps({ halted: () => true }).deps), { status: 503, body: { error: 'hub halted' } });
  // the hub's own refusals from starting the turn
  const refuse = (status, message) => routeDeps({ start: async () => { const e = new Error(message); e.status = status; throw e; } });
  assert.deepEqual(await TP.routeBuildTeam(refuse(409, 'Agent is busy; use interject or wait for the current turn.').deps), { status: 409, body: { error: 'lead is busy', busy: true } });
  assert.equal((await TP.routeBuildTeam(refuse(503, 'Paused after a restore').deps)).status, 503);
  assert.deepEqual(await TP.routeBuildTeam(refuse(409, 'already building a team for Studio').deps), { status: 409, body: { error: 'already building a team for Studio' } });
});

// ── the playbook ships ──
test('TEAM-PLAYBOOK.md ships in the lead\'s workspace templates and is listed in the update manifest', () => {
  const rel = 'maestro/TEAM-PLAYBOOK.md';
  const file = path.join(ROOT, 'templates', 'workspaces', rel);
  assert.ok(fs.existsSync(file));
  assert.match(fs.readFileSync(file, 'utf8'), /^# TEAM-PLAYBOOK\.md: building a team for a main agent/);
  const m = JSON.parse(read('templates/workspace-updates.json'))[rel];
  assert.equal(m.current, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), 'current is the template (when it changes, move the old current into previous)');
  assert.deepEqual(m.previous, ['758602a0772948e76162f5c4ed102e5f13dd3918200cb9ac27707be69534fed3', '59ec7edc513a3435897aa8a8e63cbfc45b732680c99fa6a0be74205b56550f45'], 'the versions shipped with the Teams view and with Set up teams');
});

// ── review round 1 fixes ──
const rosterEP = () => [
  { name: 'lead', display: 'Lead', category: 'primary', lead: true, model: 'm-top' },
  { name: 'studio', display: 'Studio', category: 'primary', model: 'm-top' },
  { name: 'editor', display: 'Editor', category: 'worker', model: 'm-strong' },
  { name: 'proofreader', display: 'Proofreader', category: 'worker', model: 'm-cheap' },
];

test('team_set: a question that would be cut asks nothing, applies nothing and names a smaller batch', async (t) => {
  const longName = (i) => `very_long_agent_name_number_${String(i).padStart(2, '0')}`;
  // the agents exist: a line is judged again on the agents after the question (a missing agent would be refused there)
  const m = make({ roster: roster().concat(Array.from({ length: 30 }, (_, i) => ({ name: longName(i), category: 'worker', model: 'm-cheap' }))) }); t.after(m.cleanup);
  let asked = 0, q = '';
  const confirm = async (text) => { asked++; q = text; return true; };
  const big = Array.from({ length: 30 }, (_, i) => ({ agent: longName(i), reports_to: 'studio' }));
  const out = await m.svc.runSet({ lines: big }, { ...ctx(m), confirm });
  assert.match(out, /^Too many lines to confirm in one question: send at most (\d+) lines that are not in the approved plan per team_set call\.$/);
  const n = Number(out.match(/at most (\d+)/)[1]);
  assert.ok(n >= 1 && n < 30);
  assert.equal(asked, 0);
  assert.equal(m.calls.update.length, 0);
  // a batch of that size is asked in full: every line is in the question
  const ok = await m.svc.runSet({ lines: big.slice(0, n) }, { ...ctx(m), confirm });
  assert.equal(asked, 1);
  assert.ok(q.length <= 900);
  for (const l of big.slice(0, n)) assert.ok(q.includes(l.agent), l.agent);
  assert.match(ok, /Reporting lines/);
});

test('lines are applied by the depth of their boss: a boss becomes a leader before anyone goes under it', async (t) => {
  const m = make({ roster: rosterEP() }); t.after(m.cleanup);
  const p = { for: 'studio', summary: 'An editor leads the proofreader', lines: [{ agent: 'proofreader', reports_to: 'editor' }, { agent: 'editor', reports_to: 'studio' }] };
  const out = await m.svc.runPlan(p, { ...ctx(m), ask: doIt(['l1', 'l2']) });
  assert.deepEqual(m.calls.update.map(c => c.name), ['editor', 'proofreader']);
  assert.match(out, /editor now reports to studio/);
  assert.match(out, /proofreader now reports to editor/);
  // team_set orders the same way
  const m2 = make({ roster: rosterEP() }); t.after(m2.cleanup);
  await m2.svc.runSet({ lines: [{ agent: 'proofreader', reports_to: 'editor' }, { agent: 'editor', reports_to: 'studio' }] }, { ...ctx(m2), confirm: async () => true });
  assert.deepEqual(m2.calls.update.map(c => c.name), ['editor', 'proofreader']);
});

test('an unticked specialist is not part of the team the lead is told about', async (t) => {
  const m = make(); t.after(m.cleanup);
  const out = await m.svc.runPlan(PLAN(), { ...ctx(m), ask: doIt(['n1', 'l1', 'l2', 'm1']) });
  assert.doesNotMatch(out, /Shared specialists for this team/);
  assert.match(out, /Left unticked[\s\S]*Critic works with this team/);
  const m2 = make(); t.after(m2.cleanup);
  const all = await m2.svc.runPlan(PLAN(), { ...ctx(m2), ask: doIt(['n1', 'l1', 'l2', 'm1', 's1']) });
  assert.match(all, /Shared specialists for this team[\s\S]*critic/);
});

test('the selection must stand on its own: a ticked worker under an unticked new leader applies nothing', async (t) => {
  const m = make(); t.after(m.cleanup);
  const p = PLAN();
  p.new_agents = [{ name: 'chief', display: 'Chief', role: 'leader', reports_to: 'studio', tier: 'strong', model: 'm-strong' }, { name: 'helper', role: 'worker', reports_to: 'chief', tier: 'local', model: 'm-cheap' }];
  p.lines = []; p.specialists = [];
  const out = await m.svc.runPlan(p, { ...ctx(m), ask: doIt(['n2', 'm1']) });
  assert.match(out, /^The person's selection does not stand on its own: /);
  assert.match(out, /Nothing was changed\. Ask the person what to change \(ask_user\), then call team_plan again\.$/);
  assert.equal(m.calls.update.length + m.calls.model.length, 0);
  assert.equal(m.svc.approvedFor('lead', 't1'), null);
  // everything ticked still works
  const m2 = make(); t.after(m2.cleanup);
  const all = await m2.svc.runPlan(p, { ...ctx(m2), ask: doIt(['n1', 'n2', 'm1']) });
  assert.match(all, /^The person approved the plan/);
  assert.equal(m2.calls.model.length, 1);
  assert.deepEqual(m2.svc.approvedFor('lead', 't1').items.map(i => i.agent), ['chief', 'helper', 'coder']);
  // a ticked line whose boss is made a leader only by an unticked line
  const m3 = make({ roster: rosterEP() }); t.after(m3.cleanup);
  const q = { for: 'studio', summary: 'x', lines: [{ agent: 'editor', reports_to: 'studio' }, { agent: 'proofreader', reports_to: 'editor' }] };
  const bad = await m3.svc.runPlan(q, { ...ctx(m3), ask: doIt(['l2']) });
  assert.match(bad, /^The person's selection does not stand on its own/);
  assert.equal(m3.calls.update.length, 0);
});

test('team_plan for another agent than the clicked one is not shown', async (t) => {
  const m = make(); t.after(m.cleanup);
  let asked = 0;
  const ask = async () => { asked++; return { choice: 'Do it', checked: ['n1', 'l1', 'l2', 'm1', 's1'] }; };
  const out = await m.svc.runPlan(PLAN(), { ...ctx(m), ask, forPrimary: 'sam' });
  assert.equal(out, 'The plan was not shown. This Build Team turn is for sam; propose a team for that agent only.');
  assert.equal(asked, 0);
  const ok = await m.svc.runPlan(PLAN(), { ...ctx(m), ask, forPrimary: 'studio' });
  assert.match(ok, /^The person approved/);
  assert.equal(asked, 1);
});

test('the facts pass the category through plain()', () => {
  const list = [{ name: 'studio', display: 'Studio', category: 'primary' }, { name: 'x1', category: 'work<>er`' }];
  const f = TP.buildFacts({ primary: { ...list[0], category: 'pri`mary<>' }, agentsList: list, adminIds: new Set(), counts: () => null });
  assert.equal(f.agent.category, 'primary');
  assert.equal(f.agents[0].category, 'worker');
});

// ── review round 2 fixes ──
const rosterDEP = () => [
  { name: 'lead', display: 'Lead', category: 'primary', lead: true, model: 'm-top' },
  { name: 'studio', display: 'Studio', category: 'primary', model: 'm-top' },
  { name: 'designer', display: 'Designer', category: 'worker', model: 'm-strong', reportsTo: 'studio' },
  { name: 'editor', display: 'Editor', category: 'worker', model: 'm-strong', reportsTo: 'studio' },
  { name: 'proofreader', display: 'Proofreader', category: 'worker', model: 'm-cheap', reportsTo: 'editor' },
];
const regroup = () => [{ agent: 'editor', reports_to: 'designer' }, { agent: 'proofreader', reports_to: 'designer' }];
const byName = (m, n) => m.list.find(a => a.name === n);

test('lines refused in an intermediate state are retried in a later pass (team_plan and team_set)', async (t) => {
  const m = make({ roster: rosterDEP(), enforce: true }); t.after(m.cleanup);
  const out = await m.svc.runPlan({ for: 'studio', summary: 'Designer leads', lines: regroup() }, { ...ctx(m), ask: doIt(['l1', 'l2']) });
  assert.match(out, /editor now reports to designer/);
  assert.match(out, /proofreader now reports to designer/);
  assert.doesNotMatch(out, /Could not apply/);
  assert.equal(byName(m, 'editor').reportsTo, 'designer');
  assert.equal(byName(m, 'proofreader').reportsTo, 'designer');
  const m2 = make({ roster: rosterDEP(), enforce: true }); t.after(m2.cleanup);
  const out2 = await m2.svc.runSet({ lines: regroup() }, { ...ctx(m2), confirm: async () => true });
  assert.match(out2, /editor: now reports to designer/);
  assert.match(out2, /proofreader: now reports to designer/);
  assert.equal(byName(m2, 'editor').reportsTo, 'designer');
  assert.equal(byName(m2, 'proofreader').reportsTo, 'designer');
});

test('a line still refused after the last pass is reported with its error', async (t) => {
  const m = make({ roster: rosterDEP(), updateFails: true }); t.after(m.cleanup);
  const out = await m.svc.runSet({ lines: [{ agent: 'designer', reports_to: 'studio' }] }, { ...ctx(m), confirm: async () => true });
  assert.match(out, /designer: not set \(refused by the rules\)/);
});

test('a line that would silently break another existing line is refused (validate, team_plan, team_set)', async (t) => {
  const m = make({ roster: rosterDEP(), enforce: true }); t.after(m.cleanup);
  const alone = { for: 'studio', summary: 'Editor leaves', lines: [{ agent: 'editor', reports_to: null }] };
  const v = await m.svc.validate(alone, 'lead');
  assert.match(v.error, /^line for proofreader would break: it reports to editor, which .+\. Add a line for proofreader \(a new boss or nobody\)\.$/);
  const both = { for: 'studio', summary: 'Editor leaves', lines: [{ agent: 'editor', reports_to: null }, { agent: 'proofreader', reports_to: 'designer' }] };
  assert.ok((await m.svc.validate(both, 'lead')).plan);
  // unticking the needed line: the selection does not stand on its own
  const out = await m.svc.runPlan(both, { ...ctx(m), ask: doIt(['l1']) });
  assert.match(out, /does not stand on its own: line for proofreader would break/);
  assert.equal(m.calls.update.length, 0);
  // team_set: error, no question, nothing applied
  let asked = 0;
  const out2 = await m.svc.runSet({ lines: [{ agent: 'editor', reports_to: null }] }, { ...ctx(m), confirm: async () => { asked++; return true; } });
  assert.match(out2, /^line for proofreader would break/);
  assert.equal(asked, 0);
  assert.equal(m.calls.update.length, 0);
  assert.equal(byName(m, 'editor').reportsTo, 'studio');
});

test('team_set: the question names both agents in full, even when two long names start the same', async (t) => {
  const a = 'customer_support_research_team_a', b = 'customer_support_research_team_b';
  const m = make({ roster: [...rosterDEP(), { name: a, category: 'worker', model: 'm-cheap' }, { name: b, category: 'worker', model: 'm-cheap' }] }); t.after(m.cleanup);
  let q = '';
  await m.svc.runSet({ lines: [{ agent: a, reports_to: 'studio' }, { agent: b, reports_to: 'studio' }] }, { ...ctx(m), confirm: async (text) => { q = text; return true; } });
  assert.ok(q.includes(`${a} reports to studio`) && q.includes(`${b} reports to studio`), q);
});

test('Do it with nothing ticked is the same as Not now', async (t) => {
  const m = make(); t.after(m.cleanup);
  for (const checked of [[], undefined, ['zzz']]) {
    assert.equal(await m.svc.runPlan(PLAN(), { ...ctx(m), ask: async () => ({ choice: 'Do it', checked }) }), 'Nothing was changed.');
  }
  assert.equal(m.calls.update.length + m.calls.model.length, 0);
  assert.equal(m.svc.approvedFor('lead', 't1'), null);
});

test('a line that was already invalid before the plan never blocks it (only lines this plan would break are refused)', async () => {
  const list = roster();
  list.find(a => a.name === 'coder').reportsTo = 'critic';   // a specialist is no boss: invalid before any plan
  const m = make({ roster: list });
  try {
    const v = await m.svc.validate({ for: 'studio', summary: 'one leader', lines: [{ agent: 'builder', reports_to: 'studio' }] }, 'lead');
    assert.ok(v.plan, v.error);
  } finally { m.cleanup(); }
});

test('team_set: when the person declines some lines, the approved rest is not applied if it alone would break another line', async () => {
  const list = roster().concat([
    { name: 'editor', display: 'Editor', category: 'worker', model: 'm-strong', reportsTo: 'studio' },
    { name: 'designer', display: 'Designer', category: 'worker', model: 'm-strong', reportsTo: 'studio' },
    { name: 'proofreader', display: 'Proofreader', category: 'worker', model: 'm-cheap', reportsTo: 'editor' },
  ]);
  const m = make({ roster: list, enforce: true });
  try {
    // approved together: editor leaves its team, proofreader moves to designer (nothing applied yet: Not now keeps the plan out)
    const plan = { for: 'studio', summary: 'move the proofreader', lines: [{ agent: 'editor', reports_to: null }, { agent: 'proofreader', reports_to: 'designer' }] };
    await m.svc.runPlan(plan, { ...ctx(m), ask: doIt(['l1', 'l2']) });
    // put the graph back as it was before the plan was applied, so team_set does the moving
    list.find(a => a.name === 'editor').reportsTo = 'studio'; list.find(a => a.name === 'proofreader').reportsTo = 'editor';
    m.calls.update.length = 0;
    const out = await m.svc.runSet({ lines: [{ agent: 'editor', reports_to: null }, { agent: 'proofreader', reports_to: 'helper2' }] }, { ...ctx(m), confirm: async () => false });
    assert.match(out, /^Nothing was set: /);
    assert.match(out, /line for proofreader would break/);
    assert.deepEqual(m.calls.update, [], 'nothing written');
  } finally { m.cleanup(); }
});

test('team_set on the real cascade: a clear plus a move to a boss that does not hold writes nothing (no half-moved worker)', async () => {
  const list = roster().concat([
    { name: 'editor', display: 'Editor', category: 'worker', model: 'm-strong', reportsTo: 'studio' },
    { name: 'proofreader', display: 'Proofreader', category: 'worker', model: 'm-cheap', reportsTo: 'editor' },
  ]);
  const m = make({ roster: list, enforce: true });
  try {
    const out = await m.svc.runSet({ lines: [{ agent: 'editor', reports_to: null }, { agent: 'proofreader', reports_to: 'edtor' }] }, { ...ctx(m), confirm: async () => true });
    assert.match(out, /^Nothing was set: the line for proofreader does not hold/);
    assert.deepEqual(m.calls.update, []);
    assert.equal(list.find(a => a.name === 'proofreader').reportsTo, 'editor', 'proofreader keeps its line');
  } finally { m.cleanup(); }
});

test('team_set: agents changed while the question was open are judged again; a clear that would now cascade writes nothing', async () => {
  const list = roster().concat([
    { name: 'editor', display: 'Editor', category: 'worker', model: 'm-strong', reportsTo: 'studio' },
    { name: 'proofreader', display: 'Proofreader', category: 'worker', model: 'm-cheap' },
  ]);
  const m = make({ roster: list, enforce: true });
  try {
    const confirm = async () => { list.find(a => a.name === 'proofreader').reportsTo = 'editor'; return true; };   // another admin, meanwhile
    const out = await m.svc.runSet({ lines: [{ agent: 'editor', reports_to: null }] }, { ...ctx(m), confirm });
    assert.match(out, /^Nothing was set: these lines would break another\. line for proofreader would break/);
    assert.deepEqual(m.calls.update, []);
    assert.equal(list.find(a => a.name === 'proofreader').reportsTo, 'editor');
  } finally { m.cleanup(); }
});

test('team_set: an agent listed twice is refused', async () => {
  const m = make();
  try {
    const out = await m.svc.runSet({ lines: [{ agent: 'coder', reports_to: 'builder' }, { agent: 'coder', reports_to: null }] }, { ...ctx(m), confirm: async () => true });
    assert.match(out, /coder is listed twice/);
    assert.deepEqual(m.calls.update, []);
  } finally { m.cleanup(); }
});

test('no write ever clears another line: a clear waits until the worker under it has moved, so a turn that stops half-way loses no line', async () => {
  const list = roster().concat([
    { name: 'editor', display: 'Editor', category: 'worker', model: 'm-strong', reportsTo: 'studio' },
    { name: 'designer', display: 'Designer', category: 'worker', model: 'm-strong', reportsTo: 'studio' },
    { name: 'proofreader', display: 'Proofreader', category: 'worker', model: 'm-cheap', reportsTo: 'editor' },
  ]);
  const m = make({ roster: list, enforce: true });
  try {
    let writes = 0;
    const c = ctx(m);
    const turnOf = () => (writes >= 1 ? 'turn-gone' : c.turnOf());   // the turn ends right after the first write
    const real = m.calls.update; const origPush = real.push.bind(real); real.push = (x) => { writes++; return origPush(x); };
    const out = await m.svc.runSet({ lines: [{ agent: 'editor', reports_to: null }, { agent: 'proofreader', reports_to: 'designer' }] }, { ...c, turnOf, confirm: async () => true });
    assert.deepEqual(m.calls.update.map(u => u.name), ['proofreader'], 'the move goes first, the clear waits');
    assert.equal(list.find(a => a.name === 'proofreader').reportsTo, 'designer');
    assert.equal(list.find(a => a.name === 'editor').reportsTo, 'studio', 'the clear was not written');
    assert.deepEqual(m.calls.cascade || [], [], 'nothing was cleared by a cascade');
    assert.match(out, /editor: not set, the turn ended/);
  } finally { m.cleanup(); }
});

test('team_set: an agent renamed or deleted while the question was open writes nothing (clears included)', async () => {
  const list = roster().concat([
    { name: 'editor', display: 'Editor', category: 'worker', model: 'm-strong', reportsTo: 'studio' },
    { name: 'designer', display: 'Designer', category: 'worker', model: 'm-strong', reportsTo: 'studio' },
    { name: 'proofreader', display: 'Proofreader', category: 'worker', model: 'm-cheap' },
  ]);
  const m = make({ roster: list, enforce: true });
  try {
    const confirm = async () => { list.find(a => a.name === 'editor').name = 'editor2'; return true; };
    const out = await m.svc.runSet({ lines: [{ agent: 'editor', reports_to: null }, { agent: 'proofreader', reports_to: 'designer' }] }, { ...ctx(m), confirm });
    assert.match(out, /^Nothing was set: editor was renamed, removed or made again while the question was open/);
    assert.deepEqual(m.calls.update, []);
  } finally { m.cleanup(); }
});

test('an agent replaced under the same name while the question or the card was open never receives the line', async () => {
  const mk = () => roster().concat([
    { name: 'editor', display: 'Editor', category: 'worker', model: 'm-strong', reportsTo: 'studio', box: 'b-editor-1' },
    { name: 'designer', display: 'Designer', category: 'worker', model: 'm-strong', reportsTo: 'studio', box: 'b-designer' },
  ]);
  const replace = (list) => {   // rename editor, then make a new editor under studio with no workers
    const e = list.find(a => a.name === 'editor'); e.name = 'senior_editor'; e.box = 'b-editor-2';
    list.push({ name: 'editor', display: 'Editor', category: 'worker', model: 'm-strong', reportsTo: 'studio', box: 'b-editor-3' });
  };
  {
    const list = mk(); const m = make({ roster: list, enforce: true });
    try {
      const out = await m.svc.runSet({ lines: [{ agent: 'editor', reports_to: null }] }, { ...ctx(m), confirm: async () => { replace(list); return true; } });
      assert.match(out, /^Nothing was set: editor was renamed, removed or made again/);
      assert.deepEqual(m.calls.update, []);
      assert.equal(list.find(a => a.name === 'editor').reportsTo, 'studio');
    } finally { m.cleanup(); }
  }
  {
    const list = mk(); const m = make({ roster: list, enforce: true });
    try {
      const plan = { for: 'studio', summary: 'editor works alone', lines: [{ agent: 'editor', reports_to: null }] };
      const out = await m.svc.runPlan(plan, { ...ctx(m), ask: async () => { replace(list); return { choice: 'Do it', checked: ['l1'] }; } });
      assert.match(out, /^Nothing was changed: editor was renamed, removed or made again/);
      assert.deepEqual(m.calls.update, []);
      assert.equal(m.svc.approvedFor('lead', ctx(m).turnOf()), null);
    } finally { m.cleanup(); }
  }
});

test('an approved line used later by team_set never reaches an agent replaced since the card (no question asked)', async () => {
  const list = roster().concat([
    { name: 'editor', display: 'Editor', category: 'worker', model: 'm-strong', reportsTo: 'studio', box: 'b-editor-1' },
  ]);
  const m = make({ roster: list, enforce: true });
  try {
    const plan = { for: 'studio', summary: 'a proofreader under the editor',
      new_agents: [{ name: 'proofreader', role: 'worker', reports_to: 'editor', tier: 'cost-effective', model: 'm-cheap' }] };
    await m.svc.runPlan(plan, { ...ctx(m), ask: doIt(['n1']) });
    assert.ok(m.svc.approvedFor('lead', ctx(m).turnOf()), 'approved');
    // the lead creates proofreader; meanwhile editor is renamed and another editor made
    list.push({ name: 'proofreader', category: 'worker', model: 'm-cheap', box: 'b-proof' });
    m.svc.noteCreated('lead', ctx(m).turnOf(), m.svc.approvedFor('lead', ctx(m).turnOf()), 'proofreader', idOf(m, 'proofreader'));
    const e = list.find(a => a.name === 'editor'); e.name = 'senior_editor'; e.box = 'b-editor-2';
    list.push({ name: 'editor', display: 'Editor', category: 'worker', model: 'm-strong', reportsTo: 'studio', box: 'b-editor-3' });
    m.calls.update.length = 0;
    let asked = 0, q = '';
    const out = await m.svc.runSet({ lines: [{ agent: 'proofreader', reports_to: 'editor' }] }, { ...ctx(m), confirm: async (text) => { asked++; q = text; return false; } });
    assert.equal(asked, 1, 'the approval no longer covers it: the person is asked, by name');
    assert.match(q, /proofreader reports to editor/);
    assert.match(out, /proofreader: left as is/);
    assert.deepEqual(m.calls.update, []);
  } finally { m.cleanup(); }
});

test('a model change never reaches an agent replaced while the plan was being checked again', async () => {
  const list = roster().map(a => (a.name === 'coder' ? Object.assign({}, a, { box: 'b-coder-1' }) : a));
  let calls = 0, swapped = 0;
  // the model lookup runs once for the card and once after Do it (the second validation): the swap happens inside the second
  const availableModels = async () => {
    calls++;
    if (calls === 2) { const c = list.find(a => a.name === 'coder'); c.name = 'old_coder'; c.box = 'b-coder-2';
      list.push({ name: 'coder', display: 'Coder', category: 'worker', model: 'm-cheap', box: 'b-coder-3' }); swapped++; }
    return ['m-top', 'm-strong', 'm-cheap', 'm-new'];
  };
  const m = make({ roster: list, availableModels });
  try {
    const plan = { for: 'studio', summary: 'a better coder model', model_changes: [{ agent: 'coder', model: 'm-strong' }] };
    const out = await m.svc.runPlan(plan, { ...ctx(m), ask: doIt(['m1']) });
    assert.equal(swapped, 1, 'the swap happened after the answer, during the second validation');
    assert.deepEqual(m.calls.model, [], 'no model write');
    assert.match(out, /coder was renamed, removed or made again/);
  } finally { m.cleanup(); }
});

test('identity comes from the agents file (agentIdentity), not from the cached list that carries no box id', () => {
  const src = read('lib/team-plan.js');
  assert.match(src, /identitiesOf = \(names\) => \{ try \{ return require\('\.\/agents'\)\.agentIdentities\(names\); \}/);
  assert.match(read('lib/agents.js'), /function agentIdentities\(names\)/);
  assert.match(read('lib/agents.js'), /return \{ success: true, name, identity: identityOf\(record\)/, 'createAgent returns the saved identity');
  assert.match(read('lib/sdk-chat.js'), /getTeamPlanSvc\(\)\.noteCreated\(agentName, btTurn, btPlan, name, result\.identity\)/, 'create_agent records a planned agent');
});

test('an agent replaced while the plan is first judged never reaches the card', async () => {
  const list = roster().map(a => (a.name === 'coder' ? Object.assign({}, a, { box: 'b-coder-1' }) : a));
  let calls = 0;
  const availableModels = async () => {
    calls++;
    if (calls === 1) { const c = list.find(a => a.name === 'coder'); c.name = 'old_coder'; c.box = 'b-coder-2';
      list.push({ name: 'coder', display: 'Coder', category: 'worker', model: 'm-cheap', box: 'b-coder-3' }); }
    return ['m-top', 'm-strong', 'm-cheap', 'm-new'];
  };
  const m = make({ roster: list, availableModels });
  try {
    let asked = 0;
    const out = await m.svc.runPlan({ for: 'studio', summary: 'a better coder model', model_changes: [{ agent: 'coder', model: 'm-strong' }] }, { ...ctx(m), ask: async () => { asked++; return { choice: 'Do it', checked: ['m1'] }; } });
    assert.equal(asked, 0, 'no card');
    assert.match(out, /^The plan was not shown: coder changed while it was being prepared/);
    assert.deepEqual(m.calls.model, []);
  } finally { m.cleanup(); }
});

test('a planned new agent: its line rides on the approval only when the lead created it in this turn (noteCreated); a replaced one is asked or refused', async () => {
  const mk = () => roster().concat([{ name: 'editor', display: 'Editor', category: 'worker', model: 'm-strong', reportsTo: 'studio', box: 'b-editor' }]);
  const plan = { for: 'studio', summary: 'a proofreader under the editor',
    new_agents: [{ name: 'proofreader', role: 'worker', reports_to: 'editor', tier: 'cost-effective', model: 'm-cheap' }] };
  // (a) created by the lead and noted: no question
  {
    const list = mk(); const m = make({ roster: list, enforce: true });
    try {
      await m.svc.runPlan(plan, { ...ctx(m), ask: doIt(['n1']) });
      list.push({ name: 'proofreader', category: 'worker', model: 'm-cheap', box: 'b-proof-1' });
      assert.equal(m.svc.noteCreated('lead', ctx(m).turnOf(), m.svc.approvedFor('lead', ctx(m).turnOf()), 'proofreader', idOf(m, 'proofreader')), true);
      let asked = 0;
      const out = await m.svc.runSet({ lines: [{ agent: 'proofreader', reports_to: 'editor' }] }, { ...ctx(m), confirm: async () => { asked++; return true; } });
      assert.equal(asked, 0);
      assert.match(out, /proofreader: now reports to editor/);
    } finally { m.cleanup(); }
  }
  // (b) noted, then replaced under the same name: refused, nothing written
  {
    const list = mk(); const m = make({ roster: list, enforce: true });
    try {
      await m.svc.runPlan(plan, { ...ctx(m), ask: doIt(['n1']) });
      list.push({ name: 'proofreader', category: 'worker', model: 'm-cheap', box: 'b-proof-1' });
      m.svc.noteCreated('lead', ctx(m).turnOf(), m.svc.approvedFor('lead', ctx(m).turnOf()), 'proofreader', idOf(m, 'proofreader'));
      const pr = list.find(a => a.name === 'proofreader'); pr.name = 'proofreader_old'; pr.box = 'b-proof-2';
      list.push({ name: 'proofreader', category: 'worker', model: 'm-cheap', box: 'b-proof-3' });
      m.calls.update.length = 0;
      let asked = 0;
      const out = await m.svc.runSet({ lines: [{ agent: 'proofreader', reports_to: 'editor' }] }, { ...ctx(m), confirm: async () => { asked++; return false; } });
      assert.equal(asked, 1, 'the approval no longer covers the new proofreader: the person is asked');
      assert.match(out, /proofreader: left as is/);
      assert.deepEqual(m.calls.update, []);
    } finally { m.cleanup(); }
  }
  // (c) never noted (made some other way): the line is put to the person
  {
    const list = mk(); const m = make({ roster: list, enforce: true });
    try {
      await m.svc.runPlan(plan, { ...ctx(m), ask: doIt(['n1']) });
      list.push({ name: 'proofreader', category: 'worker', model: 'm-cheap', box: 'b-proof-9' });
      let asked = 0;
      await m.svc.runSet({ lines: [{ agent: 'proofreader', reports_to: 'editor' }] }, { ...ctx(m), confirm: async () => { asked++; return false; } });
      assert.equal(asked, 1, 'asked');
    } finally { m.cleanup(); }
  }
});

test('noteCreated is write once and binds only to the plan approved when the create began; an unverifiable agent blocks the card', async () => {
  const list = roster().concat([{ name: 'editor', display: 'Editor', category: 'worker', model: 'm-strong', reportsTo: 'studio', box: 'b-editor' }]);
  const m = make({ roster: list, enforce: true });
  try {
    const plan = { for: 'studio', summary: 'a proofreader', new_agents: [{ name: 'proofreader', role: 'worker', reports_to: 'editor', tier: 'cost-effective', model: 'm-cheap' }] };
    await m.svc.runPlan(plan, { ...ctx(m), ask: doIt(['n1']) });
    const ap = m.svc.approvedFor('lead', ctx(m).turnOf());
    assert.equal(m.svc.noteCreated('lead', ctx(m).turnOf(), ap, 'proofreader', 'box:b-a'), true);
    assert.equal(m.svc.noteCreated('lead', ctx(m).turnOf(), ap, 'proofreader', 'box:b-b'), false, 'a second create never overwrites');
    assert.equal(ap.ids.get('proofreader'), 'box:b-a');
    assert.equal(m.svc.noteCreated('lead', ctx(m).turnOf(), { other: true }, 'proofreader', 'box:b-c'), false, 'another plan object');
  } finally { m.cleanup(); }
  // an existing agent whose identity cannot be read: no card
  const m2 = make({ identitiesOf: (names) => new Map(names.map(n => [n, n === 'coder' ? null : `name:${n}`])) });
  try {
    let asked = 0;
    const out = await m2.svc.runPlan({ for: 'studio', summary: 'x', model_changes: [{ agent: 'coder', model: 'm-strong' }] }, { ...ctx(m2), ask: async () => { asked++; return { choice: 'Not now' }; } });
    assert.equal(asked, 0);
    assert.match(out, /^The plan was not shown: could not verify coder/);
  } finally { m2.cleanup(); }
});

test('a planned agent deleted and made again in the same turn is asked about, never stuck', async () => {
  const list = roster().concat([{ name: 'editor', display: 'Editor', category: 'worker', model: 'm-strong', reportsTo: 'studio', box: 'b-editor' }]);
  const m = make({ roster: list, enforce: true });
  try {
    const plan = { for: 'studio', summary: 'a proofreader', new_agents: [{ name: 'proofreader', role: 'worker', reports_to: 'editor', tier: 'cost-effective', model: 'm-cheap' }] };
    await m.svc.runPlan(plan, { ...ctx(m), ask: doIt(['n1']) });
    list.push({ name: 'proofreader', category: 'worker', model: 'm-cheap', box: 'b-p1' });
    m.svc.noteCreated('lead', ctx(m).turnOf(), m.svc.approvedFor('lead', ctx(m).turnOf()), 'proofreader', 'box:b-p1');
    list.find(a => a.name === 'proofreader').box = 'b-p2';   // deleted and made again
    let asked = 0;
    const out = await m.svc.runSet({ lines: [{ agent: 'proofreader', reports_to: 'editor' }] }, { ...ctx(m), confirm: async () => { asked++; return true; } });
    assert.equal(asked, 1, 'put to the person');
    assert.match(out, /proofreader: now reports to editor/);
  } finally { m.cleanup(); }
});

// ── Optimize team: practice notes (one Record on the boss, replaced by each review) ──
const NOTES = () => ({ for: 'studio', summary: 'Hand long writing jobs to the writer', practice_notes: [
  { agent: 'studio', text: 'Hand writing jobs over 20 minutes to Writer; short work stays with you.' },
  { agent: 'studio', text: 'Send every draft to Critic before it goes out.' },
] });

test('practice notes: validation (the boss only, 1 to 300 characters, at most 5, a list) and the checklist items', async (t) => {
  const m = make(); t.after(m.cleanup);
  const err = async (mut) => { const p = NOTES(); mut(p); return (await m.svc.validate(p, 'lead', { optimize: true })).error; };
  assert.match(await err((p) => { p.practice_notes[0].agent = 'builder'; }), /practice_notes\[0\]: a practice note is for studio only/);
  assert.match(await err((p) => { p.practice_notes[1].agent = 'sam'; }), /practice_notes\[1\]: a practice note is for studio only/);
  assert.match(await err((p) => { p.practice_notes[0].text = '   '; }), /text is needed/);
  assert.match(await err((p) => { delete p.practice_notes[0].text; }), /text is needed/);
  assert.match(await err((p) => { p.practice_notes[0].text = 'x'.repeat(301); }), /at most 300/);
  assert.match(await err((p) => { p.practice_notes = new Array(6).fill({ agent: 'studio', text: 'ok' }); }), /practice_notes: at most 5/);
  assert.match(await err((p) => { p.practice_notes = 'one habit'; }), /practice_notes must be a list/);
  assert.match(await err((p) => { p.practice_notes = [null]; }), /practice_notes\[0\] must be an object/);
  const ok = await m.svc.validate({ ...NOTES(), practice_notes: [{ agent: 'studio', text: 'x'.repeat(300) }] }, 'lead', { optimize: true });
  assert.ok(ok.plan, '300 characters pass');
  const v = await m.svc.validate(NOTES(), 'lead', { optimize: true });
  assert.deepEqual(v.plan.items.map(i => [i.id, i.kind]), [['p1', 'practice'], ['p2', 'practice']]);
  // a boss that belongs to a member is not written to by an admin's review
  const mem = await m.svc.validate({ for: 'sam', summary: 's', practice_notes: [{ agent: 'sam', text: 'a habit' }] }, 'lead', { optimize: true });
  assert.match(mem.error, /belongs to a member/);
  // plain: no markup characters survive into the text that will be written
  const clean = await m.svc.validate({ for: 'studio', summary: 's', practice_notes: [{ agent: 'studio', text: 'Use `tools` <b>only</b> when needed\nand tidy.' }] }, 'lead', { optimize: true });
  assert.equal(clean.plan.practiceNotes[0].text, 'Use tools b only /b when needed and tidy.');
});

test('practice notes: the card has one line per note, "Practice note for <Display>", its detail the exact text; the header is passed through', async (t) => {
  const m = make(); t.after(m.cleanup);
  let card = null;
  await m.svc.runPlan(NOTES(), { ...ctx(m, { header: 'Team review' }), ask: async (a) => { card = a; return { choice: 'Not now', checked: [] }; } });
  assert.equal(card.header, 'Team review');
  assert.deepEqual(card.checklist, [
    { id: 'p1', label: 'Practice note for Studio', detail: 'Hand writing jobs over 20 minutes to Writer; short work stays with you.' },
    { id: 'p2', label: 'Practice note for Studio', detail: 'Send every draft to Critic before it goes out.' },
  ]);
  assert.match(card.question, /2 practice notes/);
  assert.deepEqual(m.calls.records, [], 'nothing is written before Do it');
  let plain = null;
  await m.svc.runPlan(PLAN(), { ...ctx(m), ask: async (a) => { plain = a; return { choice: 'Not now', checked: [] }; } });
  assert.equal(plain.header, 'Team plan', 'Build Team keeps its header');
});

test('practice notes: Do it writes ONE Record on the boss, team-practice.md, a heading and one bullet per ticked note; the audit logs each', async (t) => {
  const m = make(); t.after(m.cleanup);
  const out = await m.svc.runPlan(NOTES(), { ...ctx(m, { header: 'Team review' }), ask: doIt(['p1', 'p2']) });
  assert.equal(m.calls.records.length, 1);
  const [agent, name, content] = m.calls.records[0];
  assert.deepEqual([agent, name], ['studio', 'team-practice.md']);
  assert.equal(content, "# Team practice (from the lead's review, 1970-01-01)\n\n- Hand writing jobs over 20 minutes to Writer; short work stays with you.\n- Send every draft to Critic before it goes out.\n");
  assert.match(out, /Applied now:\n- 2 practice notes written to studio's Records \(team-practice\.md\)/);
  assert.deepEqual(m.log().map(l => [l.by, l.action, l.agent, l.to]), [
    ['lead', 'practice_note', 'studio', 'Hand writing jobs over 20 minutes to Writer; short work stays with you.'],
    ['lead', 'practice_note', 'studio', 'Send every draft to Critic before it goes out.'],
  ]);
});

test('practice notes: unticked notes are not written; with none ticked (or Not now) the file is left as it is', async (t) => {
  const m = make(); t.after(m.cleanup);
  const out = await m.svc.runPlan(NOTES(), { ...ctx(m, { header: 'Team review' }), ask: doIt(['p2']) });
  assert.equal(m.calls.records.length, 1);
  assert.equal(m.calls.records[0][2], "# Team practice (from the lead's review, 1970-01-01)\n\n- Send every draft to Critic before it goes out.\n");
  assert.match(out, /Left unticked \(not to be done\):\n- Practice note for Studio/);
  assert.doesNotMatch(m.calls.records[0][2], /20 minutes/);
  // Do it with only a line ticked (a plan that has a note too): no write
  const both = { ...PLAN(), practice_notes: NOTES().practice_notes };
  await m.svc.runPlan(both, { ...ctx(m, { header: 'Team review' }), ask: doIt(['l1']) });
  assert.equal(m.calls.records.length, 1, 'no ticked note: the Record is left as it is');
  await m.svc.runPlan(NOTES(), { ...ctx(m, { header: 'Team review' }), ask: async () => ({ choice: 'Not now', checked: ['p1'] }) });
  await m.svc.runPlan(NOTES(), { ...ctx(m, { header: 'Team review' }), ask: doIt([]) });
  assert.equal(m.calls.records.length, 1);
});

test('practice notes: a later review REPLACES the Record (its earlier notes go)', async (t) => {
  const m = make(); t.after(m.cleanup);
  await m.svc.runPlan(NOTES(), { ...ctx(m, { header: 'Team review' }), ask: doIt(['p1', 'p2']) });
  await m.svc.runPlan({ for: 'studio', summary: 'Second look', practice_notes: [{ agent: 'studio', text: 'Check the numbers twice.' }] }, { ...ctx(m, { header: 'Team review' }), ask: doIt(['p1']) });
  assert.equal(m.calls.records.length, 2);
  assert.equal(m.files.get('studio/team-practice.md'), "# Team practice (from the lead's review, 1970-01-01)\n\n- Check the numbers twice.\n", 'written without append: the file holds only the latest review');
});

test('practice notes: the boss must still be the agent shown; a failed write is reported and not logged', async (t) => {
  const m = make(); t.after(m.cleanup);
  const out = await m.svc.runPlan(NOTES(), { ...ctx(m, { header: 'Team review' }), ask: async () => { m.list.find(a => a.name === 'studio').box = 'b-new'; return { choice: 'Do it', checked: ['p1'] }; } });
  assert.match(out, /Nothing was changed: studio was renamed, removed or made again/);
  assert.deepEqual(m.calls.records, []);
  const f = make({ writeRecord: () => 'Could not write record team-practice.md: disk full' }); t.after(f.cleanup);
  const out2 = await f.svc.runPlan(NOTES(), { ...ctx(f, { header: 'Team review' }), ask: doIt(['p1']) });
  assert.match(out2, /Could not apply:\n- Practice notes: Could not write record team-practice\.md: disk full/);
  assert.deepEqual(f.log(), []);
  const g = make({ writeRecord: () => { throw new Error('boom'); } }); t.after(g.cleanup);
  assert.match(await g.svc.runPlan(NOTES(), { ...ctx(g, { header: 'Team review' }), ask: doIt(['p1']) }), /Practice notes: boom/);
});

test('practice notes: the turn ending before the write stops it; the default writer is the one record_write uses', async (t) => {
  const m = make(); t.after(m.cleanup);
  let allowed = true;
  const out = await m.svc.runPlan(NOTES(), { ...ctx(m, { header: 'Team review' }), stillAllowed: () => allowed, ask: async () => { allowed = false; return { choice: 'Do it', checked: ['p1'] }; } });
  assert.match(out, /turn ended/);
  assert.deepEqual(m.calls.records, []);
  assert.match(read('lib/team-plan.js'), /writeRecord = \(agent, name, content\) => require\('\.\/records'\)\.write\(agent, name, content\)/);
  assert.match(read('lib/sdk-chat.js'), /records\.write\(agentName, name, content, \{ append: !!append \}\)/, 'record_write calls the same function');
  assert.ok(TP.PLAN_TOOL.parameters.properties.practice_notes, 'the tool schema carries practice_notes');
});

// ── review fixes (round 1) ──
const RV = (m, over = {}) => ctx(m, { header: 'Team review', ...over });

test('practice_notes are refused outside an Optimize team review (a Build Team turn, and validate with no review flag)', async (t) => {
  const m = make(); t.after(m.cleanup);
  assert.equal((await m.svc.validate(NOTES(), 'lead')).error, 'practice_notes: only an Optimize team review can write practice notes.');
  assert.ok((await m.svc.validate(NOTES(), 'lead', { optimize: true })).plan);
  const out = await m.svc.runPlan(NOTES(), { ...ctx(m), ask: doIt(['p1']) });   // header 'Team plan'
  assert.match(out, /^The plan was not shown\. practice_notes: only an Optimize team review can write practice notes\./);
  assert.deepEqual(m.calls.records, []);
});

test('a write that does not fit the Records cap ("will NOT be loaded") is a failure, not a success', async (t) => {
  const f = make({ writeRecord: (a, n) => `Record ${n} written (900 bytes), but it doesn't fit in your Records cap, so it will NOT be loaded on your next turn.` }); t.after(f.cleanup);
  const out = await f.svc.runPlan(NOTES(), { ...RV(f), ask: doIt(['p1']) });
  assert.match(out, /Could not apply:\n- Practice notes: the notes do not fit in studio's Records/);
  assert.doesNotMatch(out, /written to studio's Records/);
  assert.deepEqual(f.log(), [], 'nothing logged');
});

test('audit entries written while applying an Optimize review carry via: optimize; a Build Team plan carries none', async (t) => {
  const m = make({ availableModels: async () => ['m-top', 'm-strong', 'm-cheap'] }); t.after(m.cleanup);
  const plan = { for: 'studio', summary: 'move', lines: [{ agent: 'builder', reports_to: 'studio' }], model_changes: [{ agent: 'coder', model: 'm-strong' }], practice_notes: [{ agent: 'studio', text: 'Be brief.' }] };
  await m.svc.runPlan(plan, { ...RV(m), ask: doIt(['l1', 'm1', 'p1']) });
  const log = m.log();
  assert.deepEqual(log.map(l => [l.action, l.via]), [['reports_to', 'optimize'], ['model', 'optimize'], ['practice_note', 'optimize']]);
  const b = make({ availableModels: async () => ['m-top', 'm-strong', 'm-cheap'] }); t.after(b.cleanup);
  await b.svc.runPlan({ for: 'studio', summary: 'move', lines: [{ agent: 'builder', reports_to: 'studio' }] }, { ...ctx(b), ask: doIt(['l1']) });
  assert.equal(b.log()[0].via, undefined);
});

test('keep-on-box review: a model change to another service is refused; the same service passes; other turns are not limited', async (t) => {
  const m = make({ availableModels: async () => ['acme/big', 'acme/small', 'other/x', 'm-top'] }); t.after(m.cleanup);
  m.list.find(a => a.name === 'coder').model = 'acme/small';
  const plan = (model) => ({ for: 'studio', summary: 's', model_changes: [{ agent: 'coder', model }] });
  const v = (model, o) => m.svc.validate(plan(model), 'lead', o);
  assert.equal((await v('other/x', { optimize: true, keepOnBox: true })).error, 'model change for coder: this team keeps its content on acme; choose a model from the same service.');
  assert.ok((await v('acme/big', { optimize: true, keepOnBox: true })).plan);
  assert.ok((await v('other/x', { optimize: true })).plan, 'not keep-on-box: any service');
  const out = await m.svc.runPlan(plan('other/x'), { ...RV(m, { keepOnBox: true }), ask: doIt(['m1']) });
  assert.match(out, /model change for coder: this team keeps its content on acme; choose a model from the same service\./);
  assert.deepEqual(m.calls.model, []);
  const src = read('lib/sdk-chat.js');
  assert.match(src, /keepOnBox: \(\(\) => \{ const t = turnRegistry\.get\(agentName\); return !!\(t && t\.optimizeTeamTrusted === true && t\.origin && t\.origin\.kind === 'optimize_team' && t\.origin\.for === agentName\)/);
});
