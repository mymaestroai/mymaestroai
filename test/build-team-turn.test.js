'use strict';
// Build Team, the turn side (lib/sdk-chat, lib/hub-events): the plan card's checklist and the checked passthrough, the owner turn
// and its single run, the running state in the statuses, and the two tools' registration. lib/ comes from a throwaway install.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('build-team-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const AGENTS_FILE = path.join(ISO.data, 'agents.json');
fs.writeFileSync(AGENTS_FILE, JSON.stringify([
  { name: 'zz_lead', display: 'Lead', category: 'primary', lead: true, model: 'claude-sdk/claude-opus-5-5' },
  { name: 'zz_studio', display: 'Studio', category: 'primary', model: 'claude-sdk/claude-opus-5-5' },
  { name: 'zz_builder', display: 'Builder', category: 'worker', model: 'claude-sdk/claude-sonnet-5-5' },
  { name: 'zz_other', display: 'Other', category: 'primary', model: 'claude-sdk/claude-opus-5-5' },
]));
const sdkChat = L('sdk-chat');
const hubEvents = L('hub-events');
const { runAskUser, buildHubMcpServer, pendingQuestions } = sdkChat.__askUser;
const { turnRegistry, setTestStreamer } = sdkChat.__turn;
const TP = sdkChat.__teamPlan;
L('agents').getAgentsSync(true);
fs.mkdirSync(path.join(ISO.data, 'conversations'), { recursive: true });
after(() => { setTestStreamer(null); });

const AGENT = 'zz_lead';
function fakeRes() {
  const events = [];
  return { events, writableEnded: false, destroyed: false, on() {}, write(s) { if (s.startsWith('data: ')) { try { events.push(JSON.parse(s.slice(6))); } catch {} } return true; } };
}
const cards = (res) => res.events.map(e => e.gateway).filter(g => g && g.type === 'ask_user_question');
const tick = () => new Promise(r => setImmediate(r));
const CHECKLIST = [{ id: 'a', label: 'Create Helper', detail: 'bulk work' }, { id: 'b', label: 'Builder reports to Studio', detail: '' }];
const OPTIONS = ['Do it', 'Change something', 'Not now'];
const sdkStub = { tool: (name, description, shape, handler, opts) => ({ name, description, shape, handler, opts }), createSdkMcpServer: (cfg) => cfg };

// ── the card ──
test('a hub-built checklist reaches questions[0].checklist; the card has no Skip; the answer is {choice, checked}', async () => {
  const res = fakeRes();
  const p = runAskUser(AGENT, res, { question: 'Team?', options: OPTIONS, header: 'Team plan', checklist: CHECKLIST, allow_skip: true, adminOnly: true });
  await tick();
  const [card] = cards(res);
  assert.deepEqual(card.questions[0].checklist, CHECKLIST);
  assert.deepEqual(card.questions[0].options.map(o => o.label), OPTIONS, 'no Skip on a checklist card, even when allow_skip is asked for');
  const reply = sdkChat.handleAskResponse({ request_id: card.request_id, agent: AGENT, answers: { 0: 'Do it' }, checked: ['b'] }, { isAdmin: true });
  assert.deepEqual(reply, { success: true });
  assert.deepEqual(await p, { choice: 'Do it', checked: ['b'] });
});

test('the checklist stays on the hub event too (a page without the chat stream shows the same card)', async () => {
  const seen = [];
  const off = hubEvents.events.subscribe ? null : null;
  const res = fakeRes();
  const p = runAskUser(AGENT, res, { question: 'Team?', options: OPTIONS, checklist: CHECKLIST });
  await tick();
  const q = hubEvents.events.questionFor(AGENT);
  assert.deepEqual(q.questions[0].checklist, CHECKLIST);
  const id = cards(res)[0].request_id;
  sdkChat.handleAskResponse({ request_id: id, answers: { 0: 'Not now' }, checked: [] }, {});
  assert.deepEqual(await p, { choice: 'Not now', checked: [] });
  assert.equal(hubEvents.events.questionFor(AGENT), null);
  void seen; void off;
});

test('only the checklist\'s own ids stay ticked; a typed answer on a checklist card is no answer', async () => {
  const res = fakeRes();
  let p = runAskUser(AGENT, res, { question: 'Team?', options: OPTIONS, checklist: CHECKLIST });
  await tick();
  sdkChat.handleAskResponse({ request_id: cards(res)[0].request_id, answers: { 0: 'Do it' }, checked: ['a', 'zzz'] }, {});
  assert.deepEqual(await p, { choice: 'Do it', checked: ['a'] });
  const res2 = fakeRes();
  p = runAskUser(AGENT, res2, { question: 'Team?', options: OPTIONS, checklist: CHECKLIST });
  await tick();
  sdkChat.handleAskResponse({ request_id: cards(res2)[0].request_id, answers: { 0: 'Do it, but also delete everything' }, checked: ['a', 'b'] }, {});
  assert.deepEqual(await p, { choice: 'NO_ANSWER', checked: ['a', 'b'] });
  // a card with no checklist works exactly as before: a plain string, checked ignored
  const res3 = fakeRes();
  const plainP = runAskUser(AGENT, res3, { question: 'Which color?', options: ['Green', 'Blue'] });
  await tick();
  const [plainCard] = cards(res3);
  assert.equal(plainCard.questions[0].checklist, undefined);
  assert.deepEqual(plainCard.questions[0].options.map(o => o.label), ['Green', 'Blue', 'Skip']);
  sdkChat.handleAskResponse({ request_id: plainCard.request_id, answers: { 0: 'Blue' }, checked: ['a'] }, {});
  assert.equal(await plainP, 'Blue');
});

test('an agent\'s own ask_user input never makes a checklist (nor adminOnly / forUser): the SDK tool and the gateway path both strip it', async () => {
  const res = fakeRes();
  const server = await buildHubMcpServer(AGENT, res, sdkStub, {});
  const tool = server.tools.find(t => t.name === 'ask_user');
  const p = tool.handler({ question: 'Which?', options: ['x', 'y'], checklist: CHECKLIST, adminOnly: true, forUser: 'u1' });
  await tick();
  const [card] = cards(res);
  assert.equal(card.questions[0].checklist, undefined);
  assert.equal(pendingQuestions.get(card.request_id).adminOnly, false);
  assert.equal(pendingQuestions.get(card.request_id).forUser, null);
  assert.equal(pendingQuestions.get(card.request_id).checklistIds, null);
  sdkChat.handleAskResponse({ request_id: card.request_id, answers: { 0: 'x' }, checked: ['a'] }, {});
  assert.equal((await p).content[0].text, 'x');
  assert.deepEqual(TP.agentAskArgs({ question: 'q', checklist: [1], adminOnly: true, forUser: 'u', header: 'h' }), { question: 'q', header: 'h' });
  // the gateway tool list uses the same strip (source pin: the handler is not the raw args)
  const src = fs.readFileSync(path.join(ISO.lib, 'sdk-chat.js'), 'utf8');
  assert.match(src, /handler: \(args\) => runAskUser\(agentName, sseRes, agentAskArgs\(args\), \{ consultationDepth, signal \}\)/);
});

test('handleAskResponse passes checked on only as an array of at most 60 strings of at most 40 characters', () => {
  const got = [];
  const put = (id) => { pendingQuestions.set(id, { resolve: (a, c) => got.push([a, c]), reject() {}, adminOnly: false, forUser: null }); };
  const send = (checked) => { put('r'); const r = sdkChat.handleAskResponse({ request_id: 'r', answers: { 0: 'Do it' }, ...(checked === undefined ? {} : { checked }) }, {}); pendingQuestions.delete('r'); return r; };
  assert.deepEqual(send(['a', 'b']), { success: true });
  assert.deepEqual(got.pop(), [{ 0: 'Do it' }, ['a', 'b']]);
  send(new Array(60).fill('x'.repeat(40)));
  assert.equal(got.pop()[1].length, 60, '60 strings of 40 characters are fine');
  send(new Array(61).fill('x'));
  assert.equal(got.pop()[1], undefined, '61 entries: ignored');
  send(['x'.repeat(41)]);
  assert.equal(got.pop()[1], undefined, 'a string over 40 characters: ignored');
  send(['ok', 5]);
  assert.equal(got.pop()[1], undefined, 'a non-string: ignored');
  send('a,b'); assert.equal(got.pop()[1], undefined, 'not an array: ignored');
  send({ 0: 'a' }); assert.equal(got.pop()[1], undefined);
  send(null); assert.equal(got.pop()[1], undefined);
  send(undefined); assert.equal(got.pop()[1], undefined);
  send([]); assert.deepEqual(got.pop()[1], [], 'an empty list is a list');
  // the answer is still accepted (the rest of the card's rules are unchanged)
  assert.deepEqual(sdkChat.handleAskResponse({ request_id: 'none', answers: { 0: 'x' } }, {}), { success: false, error: 'No pending question' });
});

test('a plan card is answered only by the admin who started the turn (forUser) and only by an admin (adminOnly)', async () => {
  const res = fakeRes();
  const p = runAskUser(AGENT, res, { question: 'Team?', options: OPTIONS, checklist: CHECKLIST, adminOnly: true, forUser: 'u-admin' });
  await tick();
  const id = cards(res)[0].request_id;
  assert.deepEqual(sdkChat.handleAskResponse({ request_id: id, answers: { 0: 'Do it' }, checked: ['a'] }, { isAdmin: false, personKey: 'u-admin' }), { success: false, error: 'No pending question' });
  assert.deepEqual(sdkChat.handleAskResponse({ request_id: id, answers: { 0: 'Do it' }, checked: ['a'] }, { isAdmin: true, personKey: 'u-other-admin' }), { success: false, error: 'No pending question' });
  assert.deepEqual(sdkChat.handleAskResponse({ request_id: id, answers: { 0: 'Do it' }, checked: ['a'] }, { isAdmin: true, personKey: 'u-admin' }), { success: true });
  assert.deepEqual(await p, { choice: 'Do it', checked: ['a'] });
});

// ── the owner turn, the single run, the running state ──
function fakeSink() { return { writableEnded: false, destroyed: false, writeHead() {}, write() {}, end() { this.writableEnded = true; }, on() {}, once() {}, setHeader() {}, flushHeaders() {} }; }

test('Build Team starts the lead\'s turn as an owner turn with origin build_team; a second start is refused; the state clears at turn end', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const during = {};
  setTestStreamer(async ({ agent, res, message }) => {
    res.writeHead(200, {});   // the hub's stream does this when the turn is admitted: it is what tells startHubTurn the turn started
    during.owner = TP.ownerTurnAgents.has(agent);
    during.offered = TP.connectorAccessOffered(agent, 0);
    during.message = message;
    during.track = turnRegistry.get(agent);
    during.statuses = sdkChat.getAgentStatuses();
    await gate;
    res.write('data: [DONE]\n\n'); res.end();
  });
  const started = await sdkChat.startBuildTeam({ primary: 'zz_studio', display: 'Studio', lead: 'zz_lead', message: 'Follow TEAM-PLAYBOOK.md', userId: 'u-admin' });
  assert.equal(started.ok, true);
  assert.equal(started.lead, 'zz_lead');
  assert.equal(typeof started.turnId, 'string');
  const track = turnRegistry.get('zz_lead');
  assert.equal(track.turnId, started.turnId);
  assert.deepEqual(track.origin, { kind: 'build_team', for: 'zz_studio', label: 'Building a team for Studio' });
  assert.equal(track.personKey, 'owner', 'the card is for the admin who started the turn (this throwaway install has no accounts, so the person is "owner")');
  assert.equal(during.owner, true, 'an owner turn');
  assert.equal(during.offered, true, 'so the lead is offered the owner tools');
  assert.equal(during.message, 'Follow TEAM-PLAYBOOK.md');
  // the running state
  const st = sdkChat.getAgentStatuses();
  assert.equal(st.zz_lead.buildingTeamFor, 'zz_studio');
  assert.equal(st.zz_lead.activity, 'building a team');
  assert.equal(st.zz_lead.busy, true);
  assert.equal(st.zz_studio.buildingTeamFor, undefined, 'only the lead\'s entry carries it');
  assert.equal(sdkChat.buildTeamRuns.get('zz_studio'), started.turnId);
  // a second start for the same agent is refused, whoever the lead is
  await assert.rejects(sdkChat.startBuildTeam({ primary: 'zz_studio', display: 'Studio', lead: 'zz_lead', message: 'again' }), (e) => e.status === 409 && /already building a team for Studio/.test(e.message));
  // the lead is busy: another main agent's build is refused by the hub's own busy rule, and leaves no run behind
  await assert.rejects(sdkChat.startBuildTeam({ primary: 'zz_other', display: 'Other', lead: 'zz_lead', message: 'x' }), (e) => e.status === 409);
  assert.equal(sdkChat.buildTeamRuns.has('zz_other'), false);
  release();
  for (let i = 0; i < 50 && turnRegistry.get('zz_lead'); i++) await tick();
  assert.equal(TP.ownerTurnAgents.has('zz_lead'), false, 'the owner mark ends with the turn');
  assert.equal(sdkChat.buildTeamRuns.has('zz_studio'), false, 'the run is cleared at turn end');
  assert.equal(turnRegistry.has('zz_lead'), false);
  assert.equal(sdkChat.getAgentStatuses().zz_lead.buildingTeamFor, undefined);
  // and a new build can start again
  setTestStreamer(async ({ res }) => { res.writeHead(200, {}); res.write('data: [DONE]\n\n'); res.end(); });
  const again = await sdkChat.startBuildTeam({ primary: 'zz_studio', display: 'Studio', lead: 'zz_lead', message: 'second time' });
  assert.equal(again.ok, true);
  for (let i = 0; i < 50 && (turnRegistry.get('zz_lead') || sdkChat.buildTeamRuns.has('zz_studio')); i++) await tick();
});

test('a build_team origin is an owner turn only from the route\'s trusted admin context; no other path can forge it', async () => {
  const marks = [];
  setTestStreamer(async ({ agent, res }) => { marks.push(TP.ownerTurnAgents.has(agent)); res.write('data: [DONE]\n\n'); res.end(); });
  const body = () => ({ agent: 'zz_lead', message: 'x', origin: { kind: 'build_team', for: 'zz_studio' }, owner_turn: true });
  await sdkChat.handleChatStream(body(), fakeSink(), { admin: true });                                  // an admin, but not the route
  await sdkChat.handleChatStream(body(), fakeSink(), { buildTeam: true });                              // the flag without an admin
  await sdkChat.handleChatStream(body(), fakeSink(), undefined);                                         // no context at all
  await sdkChat.handleChatStream({ ...body(), origin: { kind: 'task', from: 'hub' } }, fakeSink(), { admin: true, buildTeam: true });   // another origin kind
  await sdkChat.handleChatStream({ ...body(), owner_turn: false }, fakeSink(), { admin: true, buildTeam: true });                         // not marked an owner turn
  assert.deepEqual(marks, [false, false, false, false, false]);
  await sdkChat.handleChatStream(body(), fakeSink(), { admin: true, buildTeam: true });
  assert.deepEqual(marks.at(-1), true);
  // the ordinary typed message is still an owner turn, and a plain admin context adds nothing
  await sdkChat.handleChatStream({ agent: 'zz_lead', message: 'hello', owner_turn: true }, fakeSink(), { admin: true });
  assert.equal(marks.at(-1), true);
  // server.js strips origin and owner_turn from anything but the hub's own service, and sets owner_turn itself
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /const HUB_ONLY_CHAT_FIELDS = \['image_files', 'consulted_by', 'origin', 'owner_turn'\]/);
  assert.equal((server.match(/buildTeam: true/g) || []).length, 0, 'only lib/sdk-chat sets the trusted flag');
});

test('the activity word and the status field for a Build Team turn', () => {
  assert.equal(hubEvents.activityOf({ kind: 'build_team', for: 'zz_studio' }), 'building a team');
  assert.equal(hubEvents.activityOf({ kind: 'consultation', from: 'x' }), 'consulted by x');
  assert.deepEqual(sdkChat.statusExtras('zz_lead', { turn: { buildTeamTrusted: true, origin: { kind: 'build_team', for: 'zz_studio' } } }), { buildingTeamFor: 'zz_studio' });
  assert.deepEqual(sdkChat.statusExtras('zz_lead', { turn: { buildTeamTrusted: true, origin: { kind: 'build_team' } } }), {}, 'no named agent, no field');
  assert.deepEqual(sdkChat.statusExtras('zz_lead', { turn: { origin: { kind: 'consultation', from: 'zz_other' } } }), { consultedBy: 'zz_other' });
  // the turn's start event carries it too, for pages that update from events
  const evs = [];
  const unsub = hubEvents.events.addListener ? hubEvents.events.addListener((e) => evs.push(e)) : null;
  if (unsub !== null) {
    hubEvents.events.tapTurn(fakeSink(), { agent: 'zz_lead', origin: { kind: 'build_team', for: 'zz_studio', label: 'Building a team for Studio' }, message: 'm', turnId: 't-x', startedAt: new Date().toISOString() });
    const start = evs.find(e => e.type === 'turn_start' && e.turnId === 't-x');
    assert.equal(start && start.activity, 'building a team');
    assert.equal(start && start.buildingTeamFor, 'zz_studio');
    if (typeof unsub === 'function') unsub();
  }
});

// ── the tools' registration ──
const toolNames = async (agent, depth = 0) => (await buildHubMcpServer(agent, fakeRes(), sdkStub, { consultationDepth: depth })).tools.map(t => t.name);

test('team_plan and team_set are offered exactly like model_offer: the lead, in an owner turn, at depth 0', async () => {
  TP.ownerTurnAgents.add('zz_lead');
  try {
    const names = await toolNames('zz_lead');
    for (const n of ['model_offer', 'team_plan', 'team_set']) assert.ok(names.includes(n), n);
    const schema = (await buildHubMcpServer('zz_lead', fakeRes(), sdkStub, {})).tools.find(t => t.name === 'team_set').shape;
    assert.ok(schema.lines);
    const n1 = await toolNames('zz_lead', 1);
    for (const n of ['team_plan', 'team_set']) assert.ok(!n1.includes(n), `${n} not at consultation depth`);
    const other = await toolNames('zz_other');
    for (const n of ['team_plan', 'team_set']) assert.ok(!other.includes(n), `${n} not for a non-lead`);
    TP.ownerTurnAgents.add('zz_other');
    for (const n of ['team_plan', 'team_set']) assert.ok(!(await toolNames('zz_other')).includes(n), `${n} not for a non-lead in an owner turn`);
  } finally { TP.ownerTurnAgents.delete('zz_lead'); TP.ownerTurnAgents.delete('zz_other'); }
  const off = await toolNames('zz_lead');
  for (const n of ['model_offer', 'team_plan', 'team_set']) assert.ok(!off.includes(n), `${n} not outside an owner turn`);
  // both paths register them (gateway loop and Claude client)
  const src = fs.readFileSync(path.join(ISO.lib, 'sdk-chat.js'), 'utf8');
  assert.match(src, /name: teamPlanLib\.PLAN_TOOL\.name[^\n]*runTeamPlan\(agentName, sseRes, args, consultationDepth, signal\)/);
  assert.match(src, /name: teamPlanLib\.SET_TOOL\.name[^\n]*runTeamSet\(agentName, sseRes, args, consultationDepth, signal\)/);
  assert.match(src, /sdk\.tool\(teamPlanLib\.PLAN_TOOL\.name/);
  assert.match(src, /sdk\.tool\(teamPlanLib\.SET_TOOL\.name/);
});

test('the tools refuse outside an owner turn and after the turn ended (re-checked at call time)', async () => {
  assert.equal(await TP.runTeamPlan('zz_lead', fakeRes(), { for: 'zz_studio', summary: 's' }, 0, null), 'This can only be done in a turn the owner started.');
  assert.equal(await TP.runTeamSet('zz_lead', fakeRes(), { lines: [{ agent: 'zz_builder', reports_to: 'zz_studio' }] }, 0, null), 'This can only be done in a turn the owner started.');
  // the owner mark goes while the person is answering: nothing is applied
  TP.ownerTurnAgents.add('zz_lead');
  turnRegistry.set('zz_lead', { turnId: 'zz-t1', origin: { kind: 'build_team', for: 'zz_studio' }, personKey: 'owner', abortController: new AbortController(), startedAt: new Date().toISOString() });
  try {
    const res = fakeRes();
    const p = TP.runTeamPlan('zz_lead', res, { for: 'zz_studio', summary: 'Builder helps', lines: [{ agent: 'zz_builder', reports_to: 'zz_studio' }] }, 0, null);
    await tick(); await tick();
    const [card] = cards(res);
    assert.deepEqual(card.questions[0].checklist.map(c => c.id), ['l1']);
    TP.ownerTurnAgents.delete('zz_lead');
    sdkChat.handleAskResponse({ request_id: card.request_id, agent: 'zz_lead', answers: { 0: 'Do it' }, checked: ['l1'] }, { isAdmin: true, personKey: 'owner' });
    assert.match(await p, /turn ended/);
    const rec = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')).find(a => a.name === 'zz_builder');
    assert.equal(rec.reportsTo, undefined);
  } finally { TP.ownerTurnAgents.delete('zz_lead'); turnRegistry.delete('zz_lead'); }
});

test('end to end on the real rules: Do it applies the ticked line through updateAgentField, logs it, and team_set uses the approved plan', async () => {
  TP.ownerTurnAgents.add('zz_lead');
  turnRegistry.set('zz_lead', { turnId: 'zz-t2', origin: { kind: 'build_team', for: 'zz_studio' }, personKey: 'owner', abortController: new AbortController(), startedAt: new Date().toISOString() });
  try {
    const res = fakeRes();
    const p = TP.runTeamPlan('zz_lead', res, { for: 'zz_studio', summary: 'Builder helps', lines: [{ agent: 'zz_builder', reports_to: 'zz_studio', why: 'long work' }], specialists: [{ agent: 'zz_other', why: 'reviews' }] }, 0, null);
    await tick(); await tick();
    const [card] = cards(res);
    assert.equal(card.questions[0].header, 'Team plan');
    assert.deepEqual(card.questions[0].checklist.map(c => c.id), ['l1', 's1']);
    sdkChat.handleAskResponse({ request_id: card.request_id, agent: 'zz_lead', answers: { 0: 'Do it' }, checked: ['l1', 's1'] }, { isAdmin: true, personKey: 'owner' });
    const out = await p;
    assert.match(out, /Applied now:\n- zz_builder now reports to zz_studio/);
    assert.equal(JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')).find(a => a.name === 'zz_builder').reportsTo, 'zz_studio');
    const logFile = path.join(ISO.data, 'team-changes-log.jsonl');
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(lines.map(l => [l.by, l.action, l.agent, l.from, l.to]), [['zz_lead', 'reports_to', 'zz_builder', null, 'zz_studio']]);
    assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
    // team_set: the approved line (same agent, same boss) is set again without a question; clearing it is NOT approved, so it asks
    const same = await TP.runTeamSet('zz_lead', fakeRes(), { lines: [{ agent: 'zz_builder', reports_to: 'zz_studio' }] }, 0, null);
    assert.match(same, /1 approved in the plan, 0 asked/);
    const res2 = fakeRes();
    const q = TP.runTeamSet('zz_lead', res2, { lines: [{ agent: 'zz_builder', reports_to: null }] }, 0, null);
    await tick(); await tick();
    const [ask] = cards(res2);
    assert.deepEqual(ask.questions[0].options.map(o => o.label), ['Set them', 'Leave as is', 'Skip'].slice(0, 2).concat(ask.questions[0].options.length === 3 ? ['Skip'] : []));
    sdkChat.handleAskResponse({ request_id: ask.request_id, agent: 'zz_lead', answers: { 0: 'Leave as is' } }, { isAdmin: true, personKey: 'owner' });
    assert.match(await q, /zz_builder: left as is/);
    assert.equal(JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')).find(a => a.name === 'zz_builder').reportsTo, 'zz_studio');
  } finally { TP.ownerTurnAgents.delete('zz_lead'); turnRegistry.delete('zz_lead'); TP.getTeamPlanSvc().drop('zz_lead'); }
});

test('the approved plan is dropped when its turn ends (next to the owner mark)', async () => {
  const src = fs.readFileSync(path.join(ISO.lib, 'sdk-chat.js'), 'utf8');
  assert.match(src, /if \(ownerTurn\) ownerTurnAgents\.delete\(agent\);\n[^\n]*memberMarked[^\n]*\n\s*if \(ownerTurn\) \{ try \{ getTeamPlanSvc\(\)\.drop\(agent\); \}/);   // after the member mark's line (member-origin.test pins those two together)
  const svc = TP.getTeamPlanSvc();
  svc._approved.set('zz_lead', { lead: 'zz_lead', turnId: 'zz-t9', primary: 'zz_studio', items: [] });
  setTestStreamer(async ({ res }) => { res.write('data: [DONE]\n\n'); res.end(); });
  await sdkChat.handleChatStream({ agent: 'zz_lead', message: 'hello', owner_turn: true }, fakeSink(), { admin: true });
  assert.equal(svc._approved.has('zz_lead'), false, 'gone with the turn');
});

test('team_plan gets the clicked agent, and only a trusted Build Team turn holds the run and the status', () => {
  const src = fs.readFileSync(path.join(ISO.lib, 'sdk-chat.js'), 'utf8');
  assert.match(src, /forPrimary: \(\(\) => \{ const t = turnRegistry\.get\(agentName\); return t && t\.buildTeamTrusted === true/);
  assert.match(src, /return await getTeamPlanSvc\(\)\.runPlan\(args, \{ \.\.\.teamPlanCtx\(/);
  assert.match(src, /if \(turnOrigin && turnOrigin\.kind === 'build_team' && trustedBuildTeam && typeof turnOrigin\.for === 'string'\) buildTeamRuns\.delete\(turnOrigin\.for\);/);
  assert.match(src, /o\.kind === 'build_team' && turn\.buildTeamTrusted === true/);
  assert.match(src, /buildTeamTrusted: turnOrigin\.kind === 'build_team' && trustedBuildTeam === true/);
  assert.deepEqual(sdkChat.statusExtras('zz_lead', { turn: { origin: { kind: 'build_team', for: 'zz_studio' } } }), {}, 'an untrusted origin is not reported');
});
