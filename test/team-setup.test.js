'use strict';
// Set up teams and Undo team setup, server side (lib/team-setup, lib/team-plan setup turns, lib/sdk-chat startTeamSetup, the routes'
// decisions). Plain tests inject every dependency; the turn tests run in a throwaway install (nothing under the real data/ is touched).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('team-setup-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const TP = L('team-plan');
const TS = L('team-setup');
const T = L('ui-teams');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'team-setup-'));
const roster = () => [
  { name: 'lead', display: 'Atlas Lead', category: 'primary', lead: true, model: 'm-top' },
  { name: 'studio', display: 'Studio', category: 'primary', model: 'm-top' },
  { name: 'press', display: 'Press', category: 'primary', model: 'm-top' },
  { name: 'writer', display: 'Writer', category: 'worker', model: 'm-cheap' },
  { name: 'editor', display: 'Editor', category: 'worker', model: 'm-cheap' },
  { name: 'critic', display: 'Critic', category: 'specialist', model: 'm-top' },
  { name: 'sam', display: 'Sam', category: 'primary', owner: 'u-member', model: 'm-strong' },
  { name: 'samhelp', display: 'Sam Help', category: 'worker', owner: 'u-member', model: 'm-strong' },
];
const identities = (list) => (names) => new Map(names.map(n => { const r = list.find(x => x && x.name === n); return [n, r ? `name:${r.name}` : null]; }));

/** A team-plan service and a team-setup service over one fake agents list. */
function make(o = {}) {
  const dir = tmp(), list = o.roster || roster(), writes = [], events = [];
  const adm = new Set(['u-admin']);
  const plan = TP.createTeamPlan({
    agents: () => list, adminIds: adm, isVirtual: (n) => /^tw-/.test(n), identitiesOf: identities(list),
    availableModels: async () => ['m-top'], resolveModel: (m) => ({ model: m }), validName: (n) => /^[a-z][a-z0-9_]*$/.test(n),
    updateField: async (name, fields) => {
      const a = list.find(x => x.name === name);
      if (!a) return { success: false, error: 'Agent not found' };
      if (o.refuse && o.refuse(name, fields)) return { success: false, error: 'refused by the rules' };
      writes.push([name, fields.reportsTo || null]);
      if (fields.reportsTo) a.reportsTo = fields.reportsTo; else delete a.reportsTo;
      return { success: true };
    },
    notifyTeam() {}, published() {}, push: { notify() {} }, auditFile: path.join(dir, 'log.jsonl'), now: () => 0,
  });
  let n = 0;
  const svc = TS.createTeamSetup({
    setupsFile: path.join(dir, 'team-setups.json'), offerFile: path.join(dir, 'team-setup.json'), agents: () => list,
    applyLines: (by, items, ended) => plan.applyPasses(by, items, ended), publish: (t, p) => events.push([t, p]), now: () => 1700000000000 + (n++) * 1000,
  });
  return { dir, list, plan, svc, writes, events, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }), reload: () => TS.createTeamSetup({
    setupsFile: path.join(dir, 'team-setups.json'), offerFile: path.join(dir, 'team-setup.json'), agents: () => list, publish() {}, now: () => 1 }) };
}
const boss = (m, n) => (m.list.find(x => x.name === n) || {}).reportsTo;

// ── recorded setups and Undo ──
test('record keeps the lines of one Do it (from and to) and publishes team_setup_recorded; no line, no setup', (t) => {
  const m = make(); t.after(m.cleanup);
  assert.equal(m.svc.record('studio', [], 'u-admin'), null);
  assert.equal(m.svc.record('studio', [{ agent: 'writer', from: null, to: '' }], 'u-admin'), null, 'a line with no boss is not a recorded line');
  const id = m.svc.record('studio', [{ agent: 'writer', from: null, to: 'studio' }, { agent: 'editor', from: 'press', to: 'studio' }], 'u-admin', { lead: 'lead' });
  assert.match(id, /^ts_/);
  const file = JSON.parse(fs.readFileSync(path.join(m.dir, 'team-setups.json'), 'utf8'));
  assert.deepEqual(Object.keys(file), ['setups']);
  assert.deepEqual(Object.keys(file.setups[0]), ['id', 'at', 'by', 'main', 'lines']);
  assert.deepEqual(file.setups[0].lines, [{ agent: 'writer', from: null, to: 'studio' }, { agent: 'editor', from: 'press', to: 'studio' }]);
  assert.equal(file.setups[0].by, 'u-admin');
  assert.equal(file.setups[0].main, 'studio');
  assert.deepEqual(m.events, [['team_setup_recorded', { id, main: 'studio', count: 2, lead: 'lead' }]]);
  assert.deepEqual(m.svc.list(), [{ id, at: file.setups[0].at, main: 'studio', count: 2 }]);
  assert.equal(fs.statSync(path.join(m.dir, 'team-setups.json')).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(m.dir).filter(f => f.endsWith('.tmp')), [], 'written atomically: no temp file is left');
});

test('undo puts back exactly the lines of that setup (from, or no boss) and leaves the other setup and every other line alone', async (t) => {
  const m = make(); t.after(m.cleanup);
  m.list.find(x => x.name === 'editor').reportsTo = 'press';       // had a boss before the setup
  m.list.find(x => x.name === 'critic').reportsTo = 'press';       // set by hand, never part of a setup
  m.list.find(x => x.name === 'writer').reportsTo = 'studio';
  m.list.find(x => x.name === 'editor').reportsTo = 'studio';
  const a = m.svc.record('studio', [{ agent: 'writer', from: null, to: 'studio' }, { agent: 'editor', from: 'press', to: 'studio' }], 'u-admin');
  m.list.find(x => x.name === 'samhelp').reportsTo = 'sam';
  const b = m.svc.record('sam', [{ agent: 'samhelp', from: null, to: 'sam' }], 'u-admin');
  const r = await m.svc.undo(a, 'u-admin');
  assert.deepEqual(r, { removed: 2, keptChanged: [], failed: [] });
  assert.equal(boss(m, 'writer'), undefined, 'no boss before: no boss again');
  assert.equal(boss(m, 'editor'), 'press', 'the boss it had before');
  assert.equal(boss(m, 'critic'), 'press', 'a line set by hand stays');
  assert.equal(boss(m, 'samhelp'), 'sam', 'the other setup stays');
  assert.deepEqual(m.svc.list().map(s => s.id), [b], 'the undone setup is gone from the list');
  assert.equal(await m.svc.undo(a, 'u-admin'), null, 'undoing it twice finds nothing');
});

test('a line changed by hand since the setup is kept and reported; the rest of the setup is still undone', async (t) => {
  const m = make(); t.after(m.cleanup);
  m.list.find(x => x.name === 'writer').reportsTo = 'press';   // was set to studio by the setup, then moved by hand
  m.list.find(x => x.name === 'editor').reportsTo = 'studio';
  const id = m.svc.record('studio', [{ agent: 'writer', from: null, to: 'studio' }, { agent: 'editor', from: null, to: 'studio' }, { agent: 'critic', from: null, to: 'studio' }], 'u-admin');
  const r = await m.svc.undo(id, 'u-admin');
  assert.equal(r.removed, 1);
  assert.deepEqual(r.keptChanged, [{ agent: 'writer', to: 'studio', now: 'press' }, { agent: 'critic', to: 'studio', now: null }]);
  assert.equal(boss(m, 'writer'), 'press', 'left alone');
  assert.equal(boss(m, 'editor'), undefined);
  assert.deepEqual(m.writes, [['editor', null]], 'only the one line was written');
  assert.deepEqual(m.svc.list(), [], 'a kept line is not ours any more: the setup is closed');
});

test('a line the rules refuse stays in its setup so Undo can be tried again; the failure is reported', async (t) => {
  let refuse = true;
  const m = make({ refuse: (name) => refuse && name === 'writer' }); t.after(m.cleanup);
  m.list.find(x => x.name === 'writer').reportsTo = 'studio';
  m.list.find(x => x.name === 'editor').reportsTo = 'studio';
  const id = m.svc.record('studio', [{ agent: 'writer', from: null, to: 'studio' }, { agent: 'editor', from: null, to: 'studio' }], 'u-admin');
  const r = await m.svc.undo(id, 'u-admin');
  assert.equal(r.removed, 1);
  assert.deepEqual(r.failed, [{ agent: 'writer', error: 'refused by the rules' }]);
  assert.deepEqual(m.svc.list(), [{ id, at: m.svc.list()[0].at, main: 'studio', count: 1 }]);
  refuse = false;
  assert.equal((await m.svc.undo(id, 'u-admin')).removed, 1);
  assert.deepEqual(m.svc.list(), []);
});

test('undo never cascades: a leader is undone only after the agents under it', async (t) => {
  const m = make(); t.after(m.cleanup);
  m.list.find(x => x.name === 'writer').reportsTo = 'studio';
  m.list.find(x => x.name === 'editor').reportsTo = 'writer';
  const id = m.svc.record('studio', [{ agent: 'writer', from: null, to: 'studio' }, { agent: 'editor', from: null, to: 'writer' }], 'u-admin');
  // the real rules: an agent with a boss that is not a main agent or a leader is a broken line, so clearing writer first would cascade
  const real = m.plan;
  const r = await real.applyPasses('u-admin', [{ agent: 'writer', reports_to: null }, { agent: 'editor', reports_to: null }], () => false);
  assert.equal(r.done.length, 2);
  m.list.find(x => x.name === 'writer').reportsTo = 'studio'; m.list.find(x => x.name === 'editor').reportsTo = 'writer';
  const out = await m.svc.undo(id, 'u-admin');
  assert.equal(out.removed, 2);
  assert.equal(boss(m, 'writer'), undefined); assert.equal(boss(m, 'editor'), undefined);
});

test('undoAll takes back every setup and empties the record', async (t) => {
  const m = make(); t.after(m.cleanup);
  m.list.find(x => x.name === 'writer').reportsTo = 'studio';
  m.list.find(x => x.name === 'editor').reportsTo = 'press';
  m.svc.record('studio', [{ agent: 'writer', from: null, to: 'studio' }], 'u-admin');
  m.svc.record('press', [{ agent: 'editor', from: null, to: 'press' }], 'u-admin');
  const r = await m.svc.undoAll('u-admin');
  assert.deepEqual(r, { removed: 2, keptChanged: [], failed: [] });
  assert.equal(boss(m, 'writer'), undefined); assert.equal(boss(m, 'editor'), undefined);
  assert.deepEqual(m.svc.list(), []);
  assert.deepEqual(await m.svc.undoAll('u-admin'), { removed: 0, keptChanged: [], failed: [] });
});

// ── the one-time offer ──
test('offerState: pending only with no answer, a main agent and no reporting line anywhere; a stored answer wins', (t) => {
  const m = make(); t.after(m.cleanup);
  const lines = (l) => l.map(x => (x.name === 'writer' ? { ...x, reportsTo: 'studio' } : x));
  assert.equal(m.svc.offerState(roster()), 'pending');
  assert.equal(m.svc.offerState(lines(roster())), null, 'a line exists: nothing to offer');
  assert.equal(m.svc.offerState(roster().filter(x => x.category !== 'primary' && !x.lead)), null, 'no main agent');
  assert.equal(m.svc.offerState([]), null);
  assert.equal(m.svc.answerOffer('not_now', 'u-admin').offer, 'not_now');
  assert.equal(m.svc.offerState(roster()), 'not_now');
  assert.equal(m.svc.offerState(lines(roster())), 'not_now', 'the stored answer stands even when lines appear');
});

test('answerOffer: show, not_now and never; the first answer wins; written atomically; no timeout; survives a restart', (t) => {
  const m = make(); t.after(m.cleanup);
  assert.deepEqual(m.svc.answerOffer('bogus', 'u-admin'), { offer: null, first: false, error: 'choice must be show, not_now or never' });
  assert.equal(fs.existsSync(path.join(m.dir, 'team-setup.json')), false, 'an unknown choice stores nothing');
  assert.deepEqual(m.svc.answerOffer('never', 'u-admin'), { offer: 'never', first: true });
  assert.deepEqual(m.svc.answerOffer('show', 'u-other'), { offer: 'never', first: false }, 'a later answer returns the stored state');
  const f = JSON.parse(fs.readFileSync(path.join(m.dir, 'team-setup.json'), 'utf8'));
  assert.deepEqual(Object.keys(f), ['offer', 'by', 'at']);
  assert.equal(f.offer, 'never'); assert.equal(f.by, 'u-admin');
  assert.deepEqual(fs.readdirSync(m.dir).filter(x => x.endsWith('.tmp')), []);
  assert.equal(m.reload().offerState(roster()), 'never', "Don't ask again holds across a restart");
  const m2 = make(); t.after(m2.cleanup);
  assert.equal(m2.svc.answerOffer('show', 'u-admin').offer, 'accepted');
  assert.equal(m2.reload().offerState(roster()), 'accepted');
  assert.equal(/setTimeout|setInterval|expires/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'team-setup.js'), 'utf8')), false, 'no timer, no expiry');
});

// ── the routes' decisions ──
function routeDeps(m, over = {}) {
  const started = [];
  const d = {
    adminSession: true, svc: m.svc, agents: m.list, body: {}, userId: 'u-admin',
    ownerLeadNames: () => ['lead'], defaultLeadAgent: () => 'lead', running: () => false, halted: () => false, isBusy: () => false,
    makeMessage: async () => 'the message', start: async (a) => { started.push(a); return { ok: true, lead: a.lead, turnId: 't1' }, { ok: true, lead: a.lead, turnId: 't1' }; },
    ...over,
  };
  return { d, started };
}
test('every route needs an admin\'s own browser session (403 otherwise) and changes nothing without it', async (t) => {
  const m = make(); t.after(m.cleanup);
  for (const action of ['get', 'offer', 'start', 'undo']) {
    const { d, started } = routeDeps(m, { adminSession: false, body: { choice: 'show', all: true } });
    const r = await TS.routeTeamSetup(action, d);
    assert.equal(r.status, 403, action);
    assert.equal(started.length, 0);
  }
  assert.equal(fs.existsSync(path.join(m.dir, 'team-setup.json')), false);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /pathname\)\s*&&\s*\(req\.method === 'POST'/, 'the route is wired in server.js');
  const block = server.slice(server.indexOf("/api\\/team-setup"), server.indexOf('// PATCH /api/agents/:name'));
  assert.match(block, /adminSession: req\.hubIdentKind === 'user' && !req\.hubPendingTotp && !req\.hubToken && !req\.hubService && access\.isAdmin\(req\.hubUser\)/, 'the same gate as build-team');
});

test('GET /api/team-setup: the offer state, the lead by display name, the recorded setups, whether any team exists', async (t) => {
  const m = make(); t.after(m.cleanup);
  let r = await TS.routeTeamSetup('get', routeDeps(m).d);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { offer: 'pending', lead: { name: 'lead', display: 'Atlas Lead' }, setups: [], anyTeam: false });
  m.list.find(x => x.name === 'writer').reportsTo = 'studio';
  const id = m.svc.record('studio', [{ agent: 'writer', from: null, to: 'studio' }], 'u-admin');
  r = await TS.routeTeamSetup('get', routeDeps(m).d);
  assert.deepEqual(r.body, { offer: null, lead: { name: 'lead', display: 'Atlas Lead' }, setups: [{ id, at: m.svc.list()[0].at, main: 'studio', count: 1 }], anyTeam: true });
  r = await TS.routeTeamSetup('get', routeDeps(m, { ownerLeadNames: () => [] }).d);
  assert.equal(r.body.lead, null);
});

test('POST /api/team-setup/offer: show starts the turn and returns { offer, lead, turnId }; not_now and never start nothing; the first answer stands', async (t) => {
  const m = make(); t.after(m.cleanup);
  const a = routeDeps(m, { body: { choice: 'show' } });
  const r = await TS.routeTeamSetup('offer', a.d);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { offer: 'accepted', lead: { name: 'lead', display: 'Atlas Lead' }, turnId: 't1' });
  assert.equal(a.started.length, 1);
  assert.equal(a.started[0].lead, 'lead'); assert.equal(a.started[0].display, 'Atlas Lead'); assert.equal(a.started[0].message, 'the message'); assert.equal(a.started[0].userId, 'u-admin');
  // answered already (on another device): the stored state, nothing starts
  const b = routeDeps(m, { body: { choice: 'show' } });
  assert.deepEqual((await TS.routeTeamSetup('offer', b.d)).body, { offer: 'accepted' });
  assert.equal(b.started.length, 0);
  const m2 = make(); t.after(m2.cleanup);
  const c = routeDeps(m2, { body: { choice: 'not_now' } });
  assert.deepEqual((await TS.routeTeamSetup('offer', c.d)).body, { offer: 'not_now' });
  assert.equal(c.started.length, 0);
  assert.deepEqual((await TS.routeTeamSetup('offer', routeDeps(m2, { body: { choice: 'never' } }).d)).body, { offer: 'not_now' }, 'first answer wins');
  assert.equal((await TS.routeTeamSetup('offer', routeDeps(m2, { body: { choice: 'x' } }).d)).status, 400);
  assert.equal((await TS.routeTeamSetup('offer', routeDeps(m2, { body: {} }).d)).status, 400);
});

test('show with the lead busy, halted or a run going is refused and the card is not lost; the Teams tab button answers a waiting card', async (t) => {
  const m = make(); t.after(m.cleanup);
  for (const [over, status] of [[{ isBusy: () => true }, 409], [{ halted: () => true }, 503], [{ running: () => true }, 409], [{ ownerLeadNames: () => [] }, 409]]) {
    const r = await TS.routeTeamSetup('offer', routeDeps(m, { body: { choice: 'show' }, ...over }).d);
    assert.equal(r.status, status);
    assert.equal(m.svc.offerState(m.list), 'pending', 'no answer was stored');
  }
  const r = await TS.routeTeamSetup('start', routeDeps(m).d);
  assert.equal(r.status, 202);
  assert.deepEqual(r.body, { ok: true, lead: { name: 'lead', display: 'Atlas Lead' }, turnId: 't1' });
  assert.equal(m.svc.offerState(m.list), 'accepted');
  assert.equal((await TS.routeTeamSetup('start', routeDeps(m, { running: () => true }).d)).status, 409, '409 while one runs');
  assert.deepEqual((await TS.routeTeamSetup('start', routeDeps(m, { running: () => true }).d)).body, { error: 'already setting up teams' });
  const err = Object.assign(new Error('already setting up teams'), { status: 409 });
  assert.equal((await TS.routeTeamSetup('start', routeDeps(m, { start: async () => { throw err; } }).d)).status, 409);
});

test('POST /api/team-setup/undo: { id } or { all: true } -> { removed, keptChanged, failed }; 400 and 404 otherwise', async (t) => {
  const m = make(); t.after(m.cleanup);
  m.list.find(x => x.name === 'writer').reportsTo = 'studio';
  const id = m.svc.record('studio', [{ agent: 'writer', from: null, to: 'studio' }], 'u-admin');
  assert.equal((await TS.routeTeamSetup('undo', routeDeps(m, { body: {} }).d)).status, 400);
  assert.equal((await TS.routeTeamSetup('undo', routeDeps(m, { body: { id: 'nope' } }).d)).status, 404);
  const r = await TS.routeTeamSetup('undo', routeDeps(m, { body: { id } }).d);
  assert.deepEqual([r.status, r.body], [200, { removed: 1, keptChanged: [], failed: [] }]);
  m.list.find(x => x.name === 'editor').reportsTo = 'press';
  m.svc.record('press', [{ agent: 'editor', from: null, to: 'press' }], 'u-admin');
  const all = await TS.routeTeamSetup('undo', routeDeps(m, { body: { all: true } }).d);
  assert.deepEqual([all.status, all.body], [200, { removed: 1, keptChanged: [], failed: [] }]);
});

// ── the lead's message ──
test('setupMessage: the instruction, facts for every admin main agent, a member\'s agents as counts only, within the facts limit', () => {
  const list = roster().concat([{ name: 'tw-1', category: 'worker' }]);
  const handOffs = Array.from({ length: 6 }, () => ({ caller: 'studio', target: 'writer', createdAt: Date.now() - 86400000 }));
  const msg = TS.setupMessage({ agentsList: list, adminIds: new Set(['u-admin']), handOffs, consultsOf: () => ({}), starterNames: new Set(), tierOf: () => 'top' });
  assert.ok(msg.startsWith('Follow TEAM-PLAYBOOK.md (Set up teams). For each main agent, propose its team from the facts with team_plan (one call per team, lines only)'));
  assert.match(msg, /members' agents as counts only/);
  assert.ok(msg.length <= TP.FACTS_MAX + TS.SETUP_HEAD.length, `fits: ${msg.length}`);
  const f = JSON.parse(msg.match(/```json\n([\s\S]*)\n```$/)[1]);
  assert.deepEqual(f.mains.map(x => x.name), ['lead', 'studio', 'press']);
  assert.equal(f.members_agents.count, 2); assert.equal(f.members_agents.mains, 1);
  assert.equal(JSON.stringify(f).includes('samhelp'), false, 'a member\'s agent is never named');
  assert.equal(JSON.stringify(f).includes('"sam"'), false);
  const studio = f.mains.find(x => x.name === 'studio');
  assert.equal(studio.working_history.find(r => r.name === 'writer').from_main.hand_offs, 6);
  assert.equal(studio.working_history.find(r => r.name === 'writer').suggestion, 'member');
});
test('setupMessage keeps a large install within the facts limit by trimming each main agent\'s rows', () => {
  const list = [{ name: 'lead', category: 'primary', lead: true, model: 'm' }];
  const handOffs = [];
  for (let i = 0; i < 25; i++) {
    list.push({ name: `main${i}`, display: `Main ${i}`, category: 'primary', model: 'm' });
    for (let j = 0; j < 8; j++) { list.push({ name: `w${i}_${j}`, category: 'worker', blurb: 'x' }); for (let k = 0; k < 5; k++) handOffs.push({ caller: `main${i}`, target: `w${i}_${j}`, createdAt: Date.now() - 1000 }); }
  }
  const msg = TS.setupMessage({ agentsList: list, adminIds: new Set(), handOffs, consultsOf: () => ({}), starterNames: new Set() });
  assert.ok(msg.length <= TP.FACTS_MAX + TS.SETUP_HEAD.length, `fits: ${msg.length}`);
  const f = JSON.parse(msg.match(/```json\n([\s\S]*)\n```$/)[1]);
  assert.ok(f.mains.length >= 20, 'every main agent is still there');
});

// ── team_plan in a set-up turn ──
const LINES = (extra = {}) => ({ for: 'studio', summary: 'Writer and Editor are Studio\'s team', lines: [{ agent: 'writer', reports_to: 'studio', why: '14 hand-offs from Studio, 93% of its work' }, { agent: 'editor', reports_to: 'studio', why: 'same team folder' }], ...extra });
function setupCtx(m, over = {}) {
  const state = { approveAll: false };
  const asked = [];
  const answers = over.answers || [];
  return { asked, state, ctx: {
    lead: 'lead', turnOf: () => 't1', stillAllowed: () => true, forUser: 'u-admin',
    setup: over.noSetup ? null : { state, record: (main, lines, by, meta) => m.svc.record(main, lines, by, meta) },
    ask: async (a) => { asked.push(a); return answers.shift() || { choice: 'Not now', checked: [] }; },
  } };
}

test('a set-up turn takes lines only: new agents, model changes, specialists and practice notes are refused with a clear message, no card', async (t) => {
  const m = make(); t.after(m.cleanup);
  const s = setupCtx(m);
  const bad = [
    { new_agents: [{ name: 'helper', role: 'worker', reports_to: 'studio', tier: 'top', model: 'm-top' }] },
    { model_changes: [{ agent: 'writer', model: 'm-top' }] },
    { specialists: [{ agent: 'critic' }] },
    { practice: 'be brief' },
  ];
  for (const x of bad) {
    const r = await m.plan.runPlan(LINES(x), s.ctx);
    assert.match(r, /^The plan was not shown\. Set up teams records reporting lines only/);
  }
  assert.equal(s.asked.length, 0);
  assert.deepEqual(m.writes, []);
  // empty lists are fine
  const ok = setupCtx(m, { answers: [{ choice: 'Not now', checked: [] }] });
  assert.equal(await m.plan.runPlan(LINES({ new_agents: [], model_changes: [], specialists: [] }), ok.ctx), TP.NOT_NOW);
  assert.equal(ok.asked.length, 1);
});

test('"for" must be a main agent of an admin; no line for a main agent, a clearing line, or a member\'s agents', async (t) => {
  const m = make(); t.after(m.cleanup);
  const s = setupCtx(m);
  const run = (p) => m.plan.runPlan(p, s.ctx);
  assert.match(await run(LINES({ for: 'writer' })), /not a main agent/);
  assert.match(await run(LINES({ for: 'ghost' })), /no agent named "ghost"/);
  assert.match(await run(LINES({ for: 'sam', lines: [{ agent: 'samhelp', reports_to: 'sam' }] })), /belongs to a member/);
  assert.match(await run(LINES({ lines: [{ agent: 'press', reports_to: 'studio' }] })), /main agents? (do not|report)/);
  assert.match(await run(LINES({ lines: [{ agent: 'writer', reports_to: null }] })), /does not clear lines/);
  assert.match(await run(LINES({ lines: [{ agent: 'samhelp', reports_to: 'studio' }] })), /member|belongs|cannot|may not|not/i);
  assert.equal(s.asked.length, 0);
  assert.deepEqual(m.writes, []);
});

test('the card of one team: header Team setup, four options, every line ticked; Do it writes the lines and records one setup with from and to', async (t) => {
  const m = make(); t.after(m.cleanup);
  m.list.find(x => x.name === 'editor').reportsTo = 'press';
  const s = setupCtx(m, { answers: [{ choice: 'Do it', checked: ['l1', 'l2'] }] });
  const r = await m.plan.runPlan(LINES(), s.ctx);
  assert.equal(s.asked.length, 1);
  assert.equal(s.asked[0].header, 'Team setup');
  assert.deepEqual(s.asked[0].options, ['Do it', 'Approve all remaining teams', 'Change something', 'Not now']);
  assert.deepEqual(s.asked[0].checklist.map(c => c.id), ['l1', 'l2']);
  assert.equal(s.asked[0].adminOnly, true);
  assert.equal(s.asked[0].allow_skip, false);
  assert.deepEqual(m.writes, [['writer', 'studio'], ['editor', 'studio']]);
  const [setup] = m.svc._readSetups();
  assert.deepEqual(setup.lines, [{ agent: 'writer', from: null, to: 'studio' }, { agent: 'editor', from: 'press', to: 'studio' }]);
  assert.equal(setup.main, 'studio'); assert.equal(setup.by, 'u-admin');
  assert.match(r, new RegExp(`Recorded as team setup ${setup.id}`));
  assert.deepEqual(m.events.map(e => [e[0], e[1].id, e[1].main, e[1].count, e[1].lead]), [['team_setup_recorded', setup.id, 'studio', 2, 'lead']]);
  assert.equal(s.state.approveAll, false);
});

test('only the ticked lines are written and recorded; Not now and Change something record nothing; Change something is for this team only', async (t) => {
  const m = make(); t.after(m.cleanup);
  let s = setupCtx(m, { answers: [{ choice: 'Do it', checked: ['l2'] }] });
  await m.plan.runPlan(LINES(), s.ctx);
  assert.deepEqual(m.writes, [['editor', 'studio']]);
  assert.deepEqual(m.svc._readSetups()[0].lines.map(l => l.agent), ['editor']);
  const before = m.svc.list().length;
  s = setupCtx(m, { answers: [{ choice: 'Change something', checked: [] }] });
  const c = await m.plan.runPlan(LINES({ lines: [{ agent: 'critic', reports_to: 'studio' }] }), s.ctx);
  assert.match(c, /changes to this team only/);
  s = setupCtx(m, { answers: [{ choice: 'Not now', checked: [] }] });
  assert.equal(await m.plan.runPlan(LINES({ lines: [{ agent: 'critic', reports_to: 'studio' }] }), s.ctx), TP.NOT_NOW);
  s = setupCtx(m, { answers: [{ choice: 'Do it', checked: [] }] });
  assert.equal(await m.plan.runPlan(LINES({ lines: [{ agent: 'critic', reports_to: 'studio' }] }), s.ctx), TP.NOT_NOW, 'Do it with nothing ticked');
  assert.equal(boss(m, 'critic'), undefined);
  assert.equal(m.svc.list().length, before);
});

test('Approve all remaining teams applies this card, then later team_plan calls of the same turn apply with no card; each is validated and its own recorded setup', async (t) => {
  const m = make(); t.after(m.cleanup);
  const s = setupCtx(m, { answers: [{ choice: 'Approve all remaining teams', checked: ['l1', 'l2'] }] });
  const first = await m.plan.runPlan(LINES(), s.ctx);
  assert.equal(s.asked.length, 1);
  assert.equal(s.state.approveAll, true);
  assert.match(first, /Approve all remaining teams: from now on team_plan applies each remaining team at once, without a card/);
  assert.equal(boss(m, 'writer'), 'studio');
  const second = await m.plan.runPlan({ for: 'press', summary: 'Critic works with Press', lines: [{ agent: 'critic', reports_to: 'press', why: '9 consults from Press' }] }, s.ctx);
  assert.equal(s.asked.length, 1, 'no second card');
  assert.equal(boss(m, 'critic'), 'press');
  assert.match(second, /Applied without a card/);
  assert.equal(m.svc.list().length, 2, 'each team is its own recorded setup');
  assert.deepEqual(m.svc.list().map(x => x.main), ['studio', 'press']);
  assert.equal(m.events.length, 2);
  // still validated: a refused line is never applied or recorded
  const bad = await m.plan.runPlan({ for: 'press', summary: 'x', lines: [{ agent: 'ghost', reports_to: 'press' }] }, s.ctx);
  assert.match(bad, /^The plan was not shown/);
  assert.equal(m.svc.list().length, 2);
  // and it is this turn only: a new turn's state asks again
  const fresh = setupCtx(m, { answers: [{ choice: 'Not now', checked: [] }] });
  await m.plan.runPlan({ for: 'press', summary: 'x', lines: [{ agent: 'writer', reports_to: 'press' }] }, fresh.ctx);
  assert.equal(fresh.asked.length, 1);
  assert.equal(boss(m, 'writer'), 'studio', 'not moved: the card was declined');
});

test('Approve all with nothing ticked is Not now and does not switch the turn to automatic', async (t) => {
  const m = make(); t.after(m.cleanup);
  const s = setupCtx(m, { answers: [{ choice: 'Approve all remaining teams', checked: [] }] });
  assert.equal(await m.plan.runPlan(LINES(), s.ctx), TP.NOT_NOW);
  assert.equal(s.state.approveAll, false);
});

test('without a set-up turn nothing changes: Build Team keeps its three options and its header, and records no setup', async (t) => {
  const m = make(); t.after(m.cleanup);
  const s = setupCtx(m, { noSetup: true, answers: [{ choice: 'Do it', checked: ['l1'] }] });
  await m.plan.runPlan(LINES(), s.ctx);
  assert.deepEqual(s.asked[0].options, ['Do it', 'Change something', 'Not now']);
  assert.equal(s.asked[0].header, 'Team plan');
  assert.deepEqual(m.svc.list(), []);
  assert.equal(boss(m, 'writer'), 'studio');
  const r = await m.plan.runPlan(LINES({ model_changes: [] , specialists: [{ agent: 'critic', why: 'reviews' }] }), setupCtx(m, { noSetup: true }).ctx);
  assert.doesNotMatch(String(r), /lines only/);
});

// ── the turn (lib/sdk-chat) ──
const sdkChat = L('sdk-chat');
const hubEvents = L('hub-events');
const access = L('access');
const { turnRegistry, setTestStreamer } = sdkChat.__turn;
const { pendingQuestions } = sdkChat.__askUser;
const SDK_TP = sdkChat.__teamPlan;
const AGENTS_FILE = path.join(ISO.data, 'agents.json');
fs.writeFileSync(AGENTS_FILE, JSON.stringify([
  { name: 'zz_lead', display: 'Beacon Lead', category: 'primary', lead: true, model: 'claude-sdk/claude-opus-5-5' },
  { name: 'zz_studio', display: 'Studio', category: 'primary', model: 'claude-sdk/claude-opus-5-5' },
  { name: 'zz_press', display: 'Press', category: 'primary', model: 'claude-sdk/claude-opus-5-5' },
  { name: 'zz_writer', display: 'Writer', category: 'worker', model: 'claude-sdk/claude-sonnet-5-5' },
  { name: 'zz_editor', display: 'Editor', category: 'worker', model: 'claude-sdk/claude-sonnet-5-5' },
]));
require(path.join(ISO.lib, 'agents')).getAgentsSync(true);
fs.mkdirSync(path.join(ISO.data, 'conversations'), { recursive: true });
after(() => { setTestStreamer(null); });
const tick = () => new Promise(r => setImmediate(r));
function fakeSink() { return { writableEnded: false, destroyed: false, writeHead() {}, write() {}, end() { this.writableEnded = true; }, on() {}, once() {}, setHeader() {}, flushHeaders() {} }; }
const lastQuestion = () => { const ids = [...pendingQuestions.keys()]; return ids[ids.length - 1]; };

test('the lead\'s offer is pending in its status entry (admins only) until answered; the other agents carry nothing', () => {
  const st = sdkChat.getAgentStatuses();
  assert.equal(st.zz_lead.offerPending, true);
  assert.equal(st.zz_studio.offerPending, undefined);
  const forMember = access.statusForViewer({ id: 'u-m', role: 'member', agents: ['zz_lead'] }, st, { agents: [{ name: 'zz_lead' }] });
  assert.equal(forMember.zz_lead === undefined || forMember.zz_lead.offerPending === undefined, true, 'a member never gets it');
  assert.equal(access.redactCaller({ busy: false, offerPending: true }, () => true).offerPending, undefined);
  assert.equal(access.statusForViewer({ id: 'a', role: 'admin' }, st, { agents: [] }).zz_lead.offerPending, true);
});

test('Set up teams starts the lead\'s turn like Build Team (owner turn, origin team_setup, status, activity), one run at a time, cleared at the end', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const during = {};
  setTestStreamer(async ({ agent, res, message }) => {
    res.writeHead(200, {});
    during.owner = SDK_TP.ownerTurnAgents.has(agent);
    during.offered = SDK_TP.connectorAccessOffered(agent, 0);
    during.message = message;
    await gate;
    res.write('data: [DONE]\n\n'); res.end();
  });
  const started = await sdkChat.startTeamSetup({ display: 'Beacon Lead', lead: 'zz_lead', message: 'Follow TEAM-PLAYBOOK.md (Set up teams)', userId: 'u-admin' });
  assert.equal(started.ok, true); assert.equal(started.lead, 'zz_lead'); assert.equal(typeof started.turnId, 'string');
  const track = turnRegistry.get('zz_lead');
  assert.deepEqual(track.origin, { kind: 'team_setup', label: 'Setting up teams' });
  assert.equal(track.personKey, 'owner');
  assert.equal(track.teamSetupTrusted, true);
  assert.equal(track.buildTeamTrusted, false);
  assert.deepEqual(track.setupState, { approveAll: false });
  assert.equal(during.owner, true); assert.equal(during.offered, true);
  const st = sdkChat.getAgentStatuses();
  assert.equal(st.zz_lead.settingUpTeams, true);
  assert.equal(st.zz_lead.activity, 'setting up teams');
  assert.equal(st.zz_studio.settingUpTeams, undefined);
  assert.equal(sdkChat.teamSetupRuns.get('run'), started.turnId);
  await assert.rejects(sdkChat.startTeamSetup({ display: 'x', lead: 'zz_lead', message: 'again' }), (e) => e.status === 409 && /already setting up teams/.test(e.message));
  release();
  for (let i = 0; i < 50 && turnRegistry.get('zz_lead'); i++) await tick();
  assert.equal(sdkChat.teamSetupRuns.size, 0, 'the run is cleared at turn end');
  assert.equal(SDK_TP.ownerTurnAgents.has('zz_lead'), false);
  assert.equal(sdkChat.getAgentStatuses().zz_lead.settingUpTeams, undefined);
});

test('a team_setup origin is trusted only from the route\'s admin context; the activity word, the status field and the main chat view', async () => {
  const marks = [];
  setTestStreamer(async ({ agent, res }) => { marks.push(SDK_TP.ownerTurnAgents.has(agent)); res.write('data: [DONE]\n\n'); res.end(); });
  const body = () => ({ agent: 'zz_lead', message: 'x', origin: { kind: 'team_setup' }, owner_turn: true });
  await sdkChat.handleChatStream(body(), fakeSink(), { admin: true });
  await sdkChat.handleChatStream(body(), fakeSink(), { teamSetup: true });
  await sdkChat.handleChatStream(body(), fakeSink(), undefined);
  await sdkChat.handleChatStream({ ...body(), origin: { kind: 'task', from: 'hub' } }, fakeSink(), { admin: true, teamSetup: true });
  await sdkChat.handleChatStream({ ...body(), owner_turn: false }, fakeSink(), { admin: true, teamSetup: true });
  assert.deepEqual(marks, [false, false, false, false, false]);
  await sdkChat.handleChatStream(body(), fakeSink(), { admin: true, teamSetup: true });
  assert.equal(marks.at(-1), true);
  assert.equal(hubEvents.activityOf({ kind: 'team_setup' }), 'setting up teams');
  assert.deepEqual(sdkChat.statusExtras('zz_lead', { turn: { teamSetupTrusted: true, origin: { kind: 'team_setup' } } }), { settingUpTeams: true });
  assert.deepEqual(sdkChat.statusExtras('zz_lead', { turn: { origin: { kind: 'team_setup' } } }), {}, 'an untrusted origin is not reported');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.equal((server.match(/teamSetup: true/g) || []).length, 0, 'only lib/sdk-chat sets the trusted flag');
  const { filterMainView } = L('chat-history');
  const user = { role: 'user', origin: { kind: 'team_setup' }, content: 'Follow TEAM-PLAYBOOK.md (Set up teams)' };
  const asst = { role: 'assistant', content: 'Here is the proposal' };
  assert.deepEqual(filterMainView([user, asst]), [true, true], 'the person pressed it, so the turn stays in the main view like Build Team');
});

test('in a running set-up turn: team_set is refused, team_plan takes lines only, Approve all applies the later team without a card, each Do it is recorded and published', async () => {
  const events = [];
  const un = hubEvents.events.subscribe ? null : null; void un;
  let release; const gate = new Promise(r => { release = r; });
  const out = {};
  setTestStreamer(async ({ agent, res }) => {
    res.writeHead(200, {});
    const live = { on() {}, write() {}, writableEnded: false };
    out.set = await SDK_TP.runTeamSet(agent, live, { lines: [{ agent: 'zz_writer', reports_to: 'zz_studio' }] }, 0, null);
    out.refused = await SDK_TP.runTeamPlan(agent, live, { for: 'zz_studio', summary: 's', new_agents: [{ name: 'helper', role: 'worker', reports_to: 'zz_studio', tier: 'top', model: 'x' }] }, 0, null);
    const p1 = SDK_TP.runTeamPlan(agent, live, { for: 'zz_studio', summary: 'Writer is Studio\'s', lines: [{ agent: 'zz_writer', reports_to: 'zz_studio', why: '14 hand-offs' }] }, 0, null);
    await tick(); await tick();
    const id1 = lastQuestion();
    out.card = pendingQuestions.get(id1) && hubEvents.events.questionFor(agent);
    sdkChat.handleAskResponse({ request_id: id1, agent, answers: { 0: 'Approve all remaining teams' }, checked: ['l1'] }, { isAdmin: true, personKey: 'owner' });
    out.first = await p1;
    out.second = await SDK_TP.runTeamPlan(agent, live, { for: 'zz_press', summary: 'Editor is Press\'s', lines: [{ agent: 'zz_editor', reports_to: 'zz_press', why: '9 hand-offs' }] }, 0, null);
    out.pendingAfter = pendingQuestions.size;
    await gate;
    res.write('data: [DONE]\n\n'); res.end();
  });
  const seen = [];
  const publish = hubEvents.events.publish;
  const orig = publish;
  hubEvents.events.publish = (type, payload) => { if (type === 'team_setup_recorded') seen.push(payload); return orig.call(hubEvents.events, type, payload); };
  try {
    await sdkChat.startTeamSetup({ display: 'Beacon Lead', lead: 'zz_lead', message: 'go', userId: 'u-admin' });
    for (let i = 0; i < 100 && out.second === undefined; i++) await tick();
    assert.match(out.set, /uses team_plan only/);
    assert.match(out.refused, /Set up teams records reporting lines only/);
    assert.deepEqual(out.card.questions[0].options.map(o => o.label), ['Do it', 'Approve all remaining teams', 'Change something', 'Not now']);
    assert.equal(out.card.questions[0].header, 'Team setup');
    assert.match(out.first, /Recorded as team setup ts_/);
    assert.match(out.second, /Applied without a card/);
    assert.equal(out.pendingAfter, 0, 'no card for the second team');
    const agents = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
    assert.equal(agents.find(a => a.name === 'zz_writer').reportsTo, 'zz_studio');
    assert.equal(agents.find(a => a.name === 'zz_editor').reportsTo, 'zz_press');
    const setups = JSON.parse(fs.readFileSync(path.join(ISO.data, 'team-setups.json'), 'utf8')).setups;
    assert.deepEqual(setups.map(s => [s.main, s.lines.map(l => [l.agent, l.from, l.to])]), [['zz_studio', [['zz_writer', null, 'zz_studio']]], ['zz_press', [['zz_editor', null, 'zz_press']]]]);
    assert.deepEqual(seen.map(e => [e.main, e.count, e.lead]), [['zz_studio', 1, 'zz_lead'], ['zz_press', 1, 'zz_lead']]);
    assert.equal(sdkChat.getAgentStatuses().zz_lead.offerPending, undefined, 'a team exists: the offer is no longer pending');
  } finally { hubEvents.events.publish = orig; release(); }
  for (let i = 0; i < 50 && turnRegistry.get('zz_lead'); i++) await tick();
  // outside a set-up turn the same tool call is Build Team's: not refused for lines only
  assert.equal(sdkChat.teamSetupRuns.size, 0);
});

test('the playbook has the Set up teams section and the update list holds the new hash with only the shipped one before it', () => {
  const dir = path.join(__dirname, '..', 'templates');
  const pb = fs.readFileSync(path.join(dir, 'workspaces', 'maestro', 'TEAM-PLAYBOOK.md'), 'utf8');
  assert.match(pb, /# Set up teams: one pass over the whole install/);
  for (const s of ['lines only', 'One boss each', 'already works', 'Not used in 30 days', 'Shared specialists', 'Too little history', 'counts only', 'Approve all remaining teams', 'Do not use team_set']) assert.ok(pb.includes(s), s);
  assert.equal(/claude-|gpt-|gemini-/.test(pb.split('# Set up teams')[1]), false, 'tiers, never model ids');
  assert.equal(/Maestro/.test(pb.split('# Set up teams')[1]), false, 'the lead is not named');
  const upd = JSON.parse(fs.readFileSync(path.join(dir, 'workspace-updates.json'), 'utf8'))['maestro/TEAM-PLAYBOOK.md'];
  assert.equal(upd.current, require('crypto').createHash('sha256').update(pb).digest('hex'));
  assert.deepEqual(upd.previous, ['758602a0772948e76162f5c4ed102e5f13dd3918200cb9ac27707be69534fed3']);
});
