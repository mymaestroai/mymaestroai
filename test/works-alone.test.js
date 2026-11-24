'use strict';
// Works alone: the lead concludes a main agent needs no team (team_plan no_team), the hub records it (lib/team-setup, data/team-alone.json),
// the routes, and the pages' source wiring. Every dependency is injected; nothing under the real data/ is read or written.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('works-alone-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const TP = L('team-plan');
const TS = L('team-setup');
const ROOT = path.join(__dirname, '..');
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const roster = () => [
  { name: 'lead', display: 'Atlas Lead', category: 'primary', lead: true, box: 'b-lead' },
  { name: 'studio', display: 'Studio', category: 'primary', box: 'b-studio' },
  { name: 'press', display: 'Press', category: 'primary', box: 'b-press' },
  { name: 'writer', display: 'Writer', category: 'worker', box: 'b-writer' },
  { name: 'sam', display: 'Sam', category: 'primary', owner: 'u-member', box: 'b-sam' },
];
const idOf = (list) => (names) => new Map(names.map(n => { const r = list.find(x => x && x.name === n); return [n, r ? (r.box ? `box:${r.box}` : `name:${r.name}`) : null]; }));

function make(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'works-alone-'));
  const list = o.roster || roster(), events = [];
  let n = 0;
  const svc = TS.createTeamSetup({
    setupsFile: path.join(dir, 'team-setups.json'), offerFile: path.join(dir, 'team-setup.json'), aloneFile: path.join(dir, 'team-alone.json'),
    agents: () => list, identitiesOf: idOf(list), publish: (t, p) => events.push([t, p]), now: () => 1700000000000 + (n++) * 1000, adminIds: new Set(['u-admin']),
  });
  const plan = TP.createTeamPlan({
    agents: () => list, adminIds: new Set(['u-admin']), isVirtual: () => false, identitiesOf: idOf(list),
    availableModels: async () => ['m-top'], resolveModel: (m) => ({ model: m }), validName: (x) => /^[a-z][a-z0-9_]*$/.test(x),
    updateField: async () => ({ success: true }), notifyTeam() {}, published() {}, push: { notify() {} }, auditFile: path.join(dir, 'log.jsonl'), now: () => 0,
    recordAlone: (name, o2) => svc.aloneSet(name, o2),
  });
  return { dir, list, svc, plan, events, file: path.join(dir, 'team-alone.json'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const asked = () => { const a = []; return { a, ask: async (x) => { a.push(x); return { choice: 'Not now', checked: [] }; } }; };
const buildCtx = (m, forPrimary = 'studio', over = {}) => ({ lead: 'lead', turnOf: () => 't1', stillAllowed: () => true, forUser: 'u-admin', forPrimary, ask: asked().ask, ...over });
const setupCtx = (m, over = {}) => ({ lead: 'lead', turnOf: () => 't1', stillAllowed: () => true, forUser: 'u-admin', setup: { state: { approveAll: false }, record: async () => null }, ask: asked().ask, ...over });
const NO = (o = {}) => ({ for: 'studio', no_team: true, summary: 'Its work is short and personal, so temporary workers are enough.', ...o });
const stored = (m) => JSON.parse(fs.readFileSync(m.file, 'utf8')).alone;

// ── the tool ──
test('no_team in a Build Team turn: stored with the stable id, the person and the reason; no card; the reply says Recorded', async (t) => {
  const m = make(); t.after(m.cleanup);
  const a = asked();
  const r = await m.plan.runPlan(NO(), buildCtx(m, 'studio', { ask: a.ask }));
  assert.equal(r, 'Recorded: Studio works alone. Say why in your reply.');
  assert.equal(a.a.length, 0, 'no card');
  const e = stored(m).studio;
  assert.equal(e.id, 'box:b-studio');
  assert.equal(e.by, 'u-admin');
  assert.equal(e.reason, 'Its work is short and personal, so temporary workers are enough.');
  assert.match(e.at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(Object.keys(m.svc.aloneList(m.list)), ['studio']);
  assert.ok(m.events.some(([ty, p]) => ty === TS.EVENT && p.alone === 'studio'), 'a hub event so open pages repaint');
});
test('no_team: the summary is the one-sentence reason (cut to 200 characters like every summary)', async (t) => {
  const m = make(); t.after(m.cleanup);
  await m.plan.runPlan(NO({ summary: 'A'.repeat(50) + ' ' + 'word '.repeat(80) }), buildCtx(m));
  assert.ok(stored(m).studio.reason.length <= 200);
});
test('no_team asked again replaces the entry', async (t) => {
  const m = make(); t.after(m.cleanup);
  await m.plan.runPlan(NO({ summary: 'First reason.' }), buildCtx(m));
  await m.plan.runPlan(NO({ summary: 'Second reason.' }), buildCtx(m));
  assert.equal(stored(m).studio.reason, 'Second reason.');
  assert.equal(Object.keys(stored(m)).length, 1);
});
test('no_team is refused with lines, new agents, model changes, specialists or practice notes; nothing is stored', async (t) => {
  const m = make(); t.after(m.cleanup);
  for (const extra of [{ lines: [{ agent: 'writer', reports_to: 'studio' }] }, { new_agents: [{ name: 'x' }] }, { model_changes: [{ agent: 'writer', model: 'm-top' }] }, { specialists: [{ agent: 'press' }] }, { practice_notes: [{ agent: 'studio', text: 'a habit' }] }]) {
    const r = await m.plan.runPlan(NO(extra), buildCtx(m));
    assert.match(r, /^The plan was not shown\. no_team: send only/, Object.keys(extra)[0]);
  }
  assert.equal(fs.existsSync(m.file), false);
  // empty lists are fine
  assert.match(await m.plan.runPlan(NO({ lines: [], new_agents: [] }), buildCtx(m)), /^Recorded: Studio works alone/);
});
test('no_team is refused for a member\'s agent, for an agent that already has a team, and without a reason', async (t) => {
  const m = make(); t.after(m.cleanup);
  assert.match(await m.plan.runPlan(NO({ for: 'sam' }), buildCtx(m, 'sam')), /belongs to a member/);
  m.list.find(x => x.name === 'writer').reportsTo = 'studio';
  assert.match(await m.plan.runPlan(NO(), buildCtx(m)), /already has a team/);
  m.list.find(x => x.name === 'writer').reportsTo = undefined;
  assert.match(await m.plan.runPlan(NO({ summary: '' }), buildCtx(m)), /summary/);
  assert.match(await m.plan.runPlan(NO({ for: 'writer' }), buildCtx(m, 'writer')), /not a main agent/);
  assert.equal(fs.existsSync(m.file), false);
});
test('no_team is refused in an Optimize turn, in an untrusted turn, and for another agent than the Build Team turn\'s', async (t) => {
  const m = make(); t.after(m.cleanup);
  m.list.find(x => x.name === 'writer').reportsTo = 'press';   // a team to review
  assert.match(await m.plan.runPlan(NO({ for: 'press' }), buildCtx(m, 'press', { header: TP.REVIEW_HEADER || 'Team review' })), /not available in an Optimize team review/);
  assert.match(await m.plan.runPlan(NO(), buildCtx(m, null)), /only available in a Build Team turn/);
  assert.match(await m.plan.runPlan(NO({ for: 'press' }), buildCtx(m, 'studio')), /is for studio/);
  assert.equal(fs.existsSync(m.file), false);
});
test('no_team in a Set up teams turn: any admin-owned main agent named, one call each; a member\'s agent is refused', async (t) => {
  const m = make(); t.after(m.cleanup);
  assert.match(await m.plan.runPlan(NO({ for: 'studio' }), setupCtx(m)), /^Recorded: Studio works alone/);
  assert.match(await m.plan.runPlan(NO({ for: 'press' }), setupCtx(m)), /^Recorded: Press works alone/);
  assert.match(await m.plan.runPlan(NO({ for: 'sam' }), setupCtx(m)), /belongs to a member/);
  assert.deepEqual(Object.keys(stored(m)).sort(), ['press', 'studio']);
  // other fields are still refused there
  assert.match(await m.plan.runPlan(NO({ lines: [{ agent: 'writer', reports_to: 'studio' }] }), setupCtx(m)), /lines only|not shown/);
});
test('the tool carries no_team in its schema, in the zod schema of the hub tool, in the playbook and in the Set up teams message', () => {
  assert.equal(TP.PLAN_TOOL.parameters.properties.no_team.type, 'boolean');
  assert.match(src('lib/sdk-chat.js'), /no_team: z\.boolean\(\)\.optional\(\)/);
  assert.match(TS.SETUP_HEAD, /no_team: true/);
  const pb = src('templates/workspaces/maestro/TEAM-PLAYBOOK.md');
  assert.ok(pb.includes('When no team is needed, call team_plan with `no_team: true` and the one-sentence reason as `summary`'));
  assert.ok(pb.slice(pb.indexOf('# Set up teams')).includes('`no_team: true`'));
});

// ── the record ──
test('aloneList: an entry is dropped when the agent is gone, when a different agent took the name, and when a team exists; the next write prunes it', async (t) => {
  const m = make(); t.after(m.cleanup);
  await m.svc.aloneSet('studio', { by: 'u1', reason: 'r' }); await m.svc.aloneSet('press', { by: 'u1', reason: 'r' });
  assert.deepEqual(Object.keys(m.svc.aloneList(m.list)).sort(), ['press', 'studio']);
  m.list.find(x => x.name === 'press').box = 'b-other';        // deleted and made again under the same name
  assert.deepEqual(Object.keys(m.svc.aloneList(m.list)), ['studio']);
  m.list.find(x => x.name === 'writer').reportsTo = 'studio';   // a team was built
  assert.deepEqual(Object.keys(m.svc.aloneList(m.list)), []);
  m.list.splice(m.list.findIndex(x => x.name === 'studio'), 1);
  await m.svc.alonePrune();
  assert.deepEqual(stored(m), {}, 'pruned');
  // the team is gone again later: the cleared entry does not come back
  m.list.push({ name: 'studio', display: 'Studio', category: 'primary', box: 'b-studio' });
  assert.deepEqual(Object.keys(m.svc.aloneList(m.list)), []);
});
test('a team built under the agent clears the entry for good (pruned on the write), so removing the team later does not bring it back', async (t) => {
  const m = make(); t.after(m.cleanup);
  await m.svc.aloneSet('studio', { by: 'u1', reason: 'r' });
  const w = m.list.find(x => x.name === 'writer'); w.reportsTo = 'studio';
  await m.svc.alonePrune();
  delete w.reportsTo;
  assert.deepEqual(Object.keys(m.svc.aloneList(m.list)), []);
});
test('aloneRenamed moves the entry to the new name (keyed by name: the simpler correct choice), and an agent from before box ids takes its new id', async (t) => {
  const old = [{ name: 'studio', display: 'Studio', category: 'primary' }];   // no box id: identity is its name
  const m = make({ roster: old }); t.after(m.cleanup);
  await m.svc.aloneSet('studio', { by: 'u1', reason: 'r' });
  assert.equal(stored(m).studio.id, 'name:studio');
  old[0].name = 'atelier'; old[0].box = 'b-new';                   // what a rename does
  assert.deepEqual(Object.keys(m.svc.aloneList(old)), [], 'before the move it does not count under the new name');
  assert.equal(stored(m).studio.reason, 'r', 'and reading does not drop it: a rename in flight');
  await m.svc.aloneRenamed('studio', 'atelier');
  assert.deepEqual(Object.keys(m.svc.aloneList(old)), ['atelier']);
  assert.equal(stored(m).atelier.id, 'box:b-new');
  assert.equal(stored(m).studio, undefined);
  assert.match(src('lib/agents.js'), /getTeamSetup\(\)\.aloneRenamed\(oldName, newName\)/, 'agents.js renameAgent calls it');
  assert.match(src('lib/agents.js'), /getTeamSetup\(\)\.alonePrune\(\)/, 'a reporting-line change prunes');
  assert.ok((src('lib/agents.js').match(/getTeamSetup\(\)\.alonePrune\(\)/g) || []).length >= 2, 'and so does a delete');
});
test('an unreadable record is never replaced: reads give nothing, writes refuse, the file stays as it was', async (t) => {
  const m = make(); t.after(m.cleanup);
  fs.writeFileSync(m.file, '{ not json');
  assert.deepEqual(m.svc.aloneList(m.list), {});
  const r = await m.svc.aloneSet('studio', { by: 'u1', reason: 'r' });
  assert.match(r.error, /could not be read/);
  assert.equal((await m.svc.aloneClear('studio')).error.length > 0, true);
  assert.equal(fs.readFileSync(m.file, 'utf8'), '{ not json');
  fs.writeFileSync(m.file, JSON.stringify({ alone: [] }));
  assert.match((await m.svc.aloneSet('studio', { by: 'u1', reason: 'r' })).error, /could not be read/);
  assert.match(await m.plan.runPlan(NO(), buildCtx(m)), /^Nothing was recorded/);
});
test('writes are atomic and private: temp file renamed in, mode 0600, no temp left behind', async (t) => {
  const m = make(); t.after(m.cleanup);
  await Promise.all([m.svc.aloneSet('studio', { by: 'u1', reason: 'a' }), m.svc.aloneSet('press', { by: 'u1', reason: 'b' })]);
  assert.deepEqual(Object.keys(stored(m)).sort(), ['press', 'studio'], 'serialized: neither write lost the other');
  assert.equal(fs.statSync(m.file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(m.dir).filter(f => /\.tmp$/.test(f)), []);
});
test('aloneSet only takes a main agent that has no team', async (t) => {
  const m = make(); t.after(m.cleanup);
  assert.match((await m.svc.aloneSet('writer', { reason: 'r' })).error, /not a main agent/);
  assert.match((await m.svc.aloneSet('nobody', { reason: 'r' })).error, /no such agent/);
  m.list.find(x => x.name === 'writer').reportsTo = 'studio';
  assert.match((await m.svc.aloneSet('studio', { reason: 'r' })).error, /already has a team/);
});

// ── the routes ──
const routeDeps = (m, over = {}) => ({ adminSession: true, svc: m.svc, agents: m.list, adminIds: new Set(['u-admin']), body: {}, userId: 'u-admin', ...over });
test('GET /api/team-setup also carries alone: { name: { at, reason } } (the pages\' one load); an agent with a team is not in it', async (t) => {
  const m = make(); t.after(m.cleanup);
  await m.svc.aloneSet('studio', { by: 'u-admin', reason: 'Short tasks.' });
  const r = await TS.routeTeamSetup('get', { ...routeDeps(m), ownerLeadNames: () => ['lead'], defaultLeadAgent: () => 'lead' });
  assert.deepEqual(r.body.alone, { studio: { at: stored(m).studio.at, reason: 'Short tasks.' } });
  assert.equal(JSON.stringify(r.body.alone).includes('box:'), false, 'no stable id leaves the hub');
});
test('GET/POST/DELETE /api/team-alone by hand, for an admin\'s own browser session', async (t) => {
  const m = make(); t.after(m.cleanup);
  let r = await TS.routeTeamAlone('get', routeDeps(m));
  assert.deepEqual(r, { status: 200, body: { alone: {} } });
  r = await TS.routeTeamAlone('set', routeDeps(m, { body: { agent: 'studio', reason: 'Works fine alone.' } }));
  assert.equal(r.status, 200);
  assert.equal(stored(m).studio.by, 'u-admin');
  assert.equal(stored(m).studio.id, 'box:b-studio');
  assert.deepEqual(Object.keys(r.body.alone), ['studio']);
  r = await TS.routeTeamAlone('get', routeDeps(m));
  assert.equal(r.body.alone.studio.reason, 'Works fine alone.');
  assert.equal((await TS.routeTeamAlone('set', routeDeps(m, { body: { agent: 'nobody', reason: 'x' } }))).status, 404);
  assert.equal((await TS.routeTeamAlone('set', routeDeps(m, { body: { agent: 'sam', reason: 'x' } }))).status, 403, 'a member\'s agent');
  assert.equal((await TS.routeTeamAlone('set', routeDeps(m, { body: { agent: 'press', reason: '' } }))).status, 400);
  assert.equal((await TS.routeTeamAlone('set', routeDeps(m, { body: { agent: 'writer', reason: 'x' } }))).status, 409, 'not a main agent');
  r = await TS.routeTeamAlone('clear', routeDeps(m, { agent: 'studio' }));
  assert.equal(r.status, 200);
  assert.deepEqual(stored(m), {});
  assert.equal((await TS.routeTeamAlone('clear', routeDeps(m, { agent: 'studio' }))).status, 404);
});
test('the routes refuse a member, a token and a service with 403 and never show or change an entry', async (t) => {
  const m = make(); t.after(m.cleanup);
  await m.svc.aloneSet('studio', { by: 'u-admin', reason: 'r' });
  for (const action of ['get', 'set', 'clear']) {
    const r = await TS.routeTeamAlone(action, routeDeps(m, { adminSession: false, agent: 'studio', body: { agent: 'press', reason: 'x' } }));
    assert.equal(r.status, 403, action);
    assert.equal(JSON.stringify(r.body).includes('studio'), false);
  }
  assert.deepEqual(Object.keys(stored(m)), ['studio']);
  const server = src('server.js');
  const block = server.slice(server.indexOf('// Works alone (lib/team-setup)'), server.indexOf('// POST /api/agents/:name/optimize-team'));
  assert.match(block, /adminSession: req\.hubIdentKind === 'user' && !req\.hubPendingTotp && !req\.hubToken && !req\.hubService && access\.isAdmin\(req\.hubUser\)/, 'the same gate as /api/team-setup');
  assert.match(block, /req\.method === 'DELETE'/);
});
