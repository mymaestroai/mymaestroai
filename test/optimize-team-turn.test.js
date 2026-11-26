'use strict';
// Optimize team, the turn side (lib/sdk-chat, lib/hub-events, lib/chat-history): the owner turn and its single run, the trusted
// context, the plan's forPrimary and card header, the status field, a keep-on-box boss reviewing itself, and the main chat view.
// lib/ comes from a throwaway install (the same helper as test/build-team-turn.test.js); nothing under the real data/ is touched.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('optimize-team-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const AGENTS_FILE = path.join(ISO.data, 'agents.json');
fs.writeFileSync(AGENTS_FILE, JSON.stringify([
  { name: 'zz_lead', display: 'Lead', category: 'primary', lead: true, model: 'claude-sdk/claude-opus-5-5' },
  { name: 'zz_studio', display: 'Studio', category: 'primary', model: 'claude-sdk/claude-opus-5-5' },
  { name: 'zz_writer', display: 'Writer', category: 'worker', model: 'claude-sdk/claude-sonnet-5-5', reportsTo: 'zz_studio' },
  { name: 'zz_other', display: 'Other', category: 'primary', model: 'claude-sdk/claude-opus-5-5' },
]));
const sdkChat = L('sdk-chat');
const hubEvents = L('hub-events');
const review = L('team-review');
const { buildHubMcpServer } = sdkChat.__askUser;
const { turnRegistry, setTestStreamer } = sdkChat.__turn;
const TP = sdkChat.__teamPlan;
L('agents').getAgentsSync(true);
fs.mkdirSync(path.join(ISO.data, 'conversations'), { recursive: true });
after(() => { setTestStreamer(null); });

function fakeRes() {
  const events = [];
  return { events, writableEnded: false, destroyed: false, on() {}, write(s) { if (s.startsWith('data: ')) { try { events.push(JSON.parse(s.slice(6))); } catch {} } return true; } };
}
function fakeSink() { return { writableEnded: false, destroyed: false, writeHead() {}, write() {}, end() { this.writableEnded = true; }, on() {}, once() {}, setHeader() {}, flushHeaders() {} }; }
const cards = (res) => res.events.map(e => e.gateway).filter(g => g && g.type === 'ask_user_question');
const tick = () => new Promise(r => setImmediate(r));
const sdkStub = { tool: (name, description, shape, handler, opts) => ({ name, description, shape, handler, opts }), createSdkMcpServer: (cfg) => cfg };
const toolNames = async (agent, depth = 0) => (await buildHubMcpServer(agent, fakeRes(), sdkStub, { consultationDepth: depth })).tools.map(t => t.name);
const settle = async (agent, key) => { for (let i = 0; i < 60 && (turnRegistry.get(agent) || (key && sdkChat.optimizeTeamRuns.has(key))); i++) await tick(); };

test('Optimize team starts the reviewer\'s turn as an owner turn with origin optimize_team; one run per main agent; the state clears at turn end', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const during = {};
  setTestStreamer(async ({ agent, res, message }) => {
    res.writeHead(200, {});
    during.owner = TP.ownerTurnAgents.has(agent);
    during.offered = TP.connectorAccessOffered(agent, 0);
    during.message = message;
    during.track = turnRegistry.get(agent);
    await gate;
    res.write('data: [DONE]\n\n'); res.end();
  });
  const started = await sdkChat.startOptimizeTeam({ primary: 'zz_studio', display: 'Studio', reviewer: 'zz_lead', message: 'Follow TEAM-PLAYBOOK.md (Optimize team).', userId: 'u-admin' });
  assert.deepEqual([started.ok, started.reviewer, typeof started.turnId], [true, 'zz_lead', 'string']);
  const track = turnRegistry.get('zz_lead');
  assert.equal(track.turnId, started.turnId);
  assert.deepEqual(track.origin, { kind: 'optimize_team', for: 'zz_studio', label: 'Reviewing the team of Studio' });
  assert.equal(track.personKey, 'owner', 'the card is for the admin who pressed it (no accounts on this install: "owner")');
  assert.equal(track.optimizeTeamTrusted, true);
  assert.equal(track.buildTeamTrusted, false);
  assert.equal(during.owner, true);
  assert.equal(during.offered, true, 'the lead is offered the owner tools');
  const st = sdkChat.getAgentStatuses();
  assert.equal(st.zz_lead.reviewingTeamFor, 'zz_studio');
  assert.equal(st.zz_lead.buildingTeamFor, undefined);
  assert.equal(st.zz_lead.activity, 'reviewing a team');
  assert.equal(st.zz_lead.busy, true);
  assert.equal(st.zz_studio.reviewingTeamFor, undefined, 'only the reviewer\'s entry carries it');
  assert.equal(sdkChat.optimizeTeamRuns.get('zz_studio'), started.turnId);
  assert.equal(sdkChat.buildTeamRuns.has('zz_studio'), false, 'a separate run map from Build Team');
  await assert.rejects(sdkChat.startOptimizeTeam({ primary: 'zz_studio', display: 'Studio', reviewer: 'zz_lead', message: 'again' }), (e) => e.status === 409 && /already reviewing the team of Studio/.test(e.message));
  await assert.rejects(sdkChat.startOptimizeTeam({ primary: 'zz_other', display: 'Other', reviewer: 'zz_lead', message: 'x' }), (e) => e.status === 409);
  assert.equal(sdkChat.optimizeTeamRuns.has('zz_other'), false, 'a refused start leaves no run behind');
  release();
  await settle('zz_lead', 'zz_studio');
  assert.equal(TP.ownerTurnAgents.has('zz_lead'), false);
  assert.equal(sdkChat.optimizeTeamRuns.has('zz_studio'), false, 'the run is cleared at turn end');
  assert.equal(sdkChat.getAgentStatuses().zz_lead.reviewingTeamFor, undefined);
  setTestStreamer(async ({ res }) => { res.writeHead(200, {}); res.write('data: [DONE]\n\n'); res.end(); });
  assert.equal((await sdkChat.startOptimizeTeam({ primary: 'zz_studio', display: 'Studio', reviewer: 'zz_lead', message: 'second time' })).ok, true);
  await settle('zz_lead', 'zz_studio');
});

test('a keep-on-box boss reviews its own team: the turn runs on the boss, which is offered team_plan and team_set and nothing else of the lead\'s tools', async () => {
  const during = {};
  let release; const gate = new Promise(r => { release = r; });
  setTestStreamer(async ({ agent, res }) => {
    res.writeHead(200, {});
    during.agent = agent;
    during.owner = TP.ownerTurnAgents.has(agent);
    try {
      during.names = await toolNames(agent);
      during.namesDepth1 = await toolNames(agent, 1);
      during.lead = await toolNames('zz_lead');
    } catch (e) { during.error = e && e.stack; during.lead = []; }
    await gate;
    res.write('data: [DONE]\n\n'); res.end();
  });
  const started = await sdkChat.startOptimizeTeam({ primary: 'zz_studio', display: 'Studio', reviewer: 'zz_studio', message: "This is Studio's own review of its team." });
  assert.equal(started.reviewer, 'zz_studio');
  for (let i = 0; i < 100 && !during.lead; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(during.error, undefined);
  assert.equal(during.agent, 'zz_studio');
  assert.equal(during.owner, true);
  for (const n of ['team_plan', 'team_set']) assert.ok(during.names.includes(n), `${n} offered to the boss in its own review`);
  for (const n of ['connector_access', 'model_offer']) assert.ok(!during.names.includes(n), `${n} is not part of the review`);
  for (const n of ['team_plan', 'team_set']) assert.ok(!during.namesDepth1.includes(n), `${n} not at consultation depth`);
  for (const n of ['team_plan', 'team_set']) assert.ok(!during.lead.includes(n), `${n} not offered to another agent`);
  assert.equal(sdkChat.getAgentStatuses().zz_studio.reviewingTeamFor, 'zz_studio');
  release();
  await settle('zz_studio', 'zz_studio');
  // outside the review the boss has no such tools
  assert.ok(!(await toolNames('zz_studio')).includes('team_plan'));
  // another agent's review turn does not offer them to a different non-lead
  turnRegistry.set('zz_other', { turnId: 'x1', origin: { kind: 'optimize_team', for: 'zz_studio' }, optimizeTeamTrusted: true, personKey: 'owner', abortController: new AbortController(), startedAt: new Date().toISOString() });
  TP.ownerTurnAgents.add('zz_other');
  try { assert.ok(!(await toolNames('zz_other')).includes('team_plan'), 'the boss named in the origin is the only one'); }
  finally { TP.ownerTurnAgents.delete('zz_other'); turnRegistry.delete('zz_other'); }
});

test('an optimize_team origin is an owner turn only from the trusted context; no other path can forge it', async () => {
  const marks = [];
  setTestStreamer(async ({ agent, res }) => { marks.push(TP.ownerTurnAgents.has(agent)); res.write('data: [DONE]\n\n'); res.end(); });
  const body = () => ({ agent: 'zz_lead', message: 'x', origin: { kind: 'optimize_team', for: 'zz_studio' }, owner_turn: true });
  await sdkChat.handleChatStream(body(), fakeSink(), { admin: true });                                    // an admin, but not the route
  await sdkChat.handleChatStream(body(), fakeSink(), { optimizeTeam: true });                             // the flag without an admin
  await sdkChat.handleChatStream(body(), fakeSink(), undefined);
  await sdkChat.handleChatStream(body(), fakeSink(), { admin: true, buildTeam: true });                   // Build Team's flag does not carry over
  await sdkChat.handleChatStream({ ...body(), origin: { kind: 'build_team', for: 'zz_studio' } }, fakeSink(), { admin: true, optimizeTeam: true });   // nor does this one the other way
  await sdkChat.handleChatStream({ ...body(), origin: { kind: 'task', from: 'hub' } }, fakeSink(), { admin: true, optimizeTeam: true });
  await sdkChat.handleChatStream({ ...body(), owner_turn: false }, fakeSink(), { admin: true, optimizeTeam: true });
  await sdkChat.handleChatStream({ ...body(), consulted_by: 'zz_other' }, fakeSink(), { admin: true, optimizeTeam: true });
  assert.deepEqual(marks, new Array(8).fill(false));
  await sdkChat.handleChatStream(body(), fakeSink(), { admin: true, optimizeTeam: true });
  assert.equal(marks.at(-1), true);
  // the track of a turn with the context but not the trusted origin carries no mark
  let track = null;
  setTestStreamer(async ({ agent, res }) => { track = turnRegistry.get(agent); res.write('data: [DONE]\n\n'); res.end(); });
  await sdkChat.handleChatStream({ ...body(), origin: { kind: 'task', from: 'hub' }, owner_turn: false }, fakeSink(), { admin: true, optimizeTeam: true });
  assert.equal(track.optimizeTeamTrusted, undefined);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.equal((server.match(/optimizeTeam: true/g) || []).length, 0, 'only lib/sdk-chat sets the trusted flag');
});

test('team_plan in an optimize turn: only the reviewed boss may be named, and the card reads "Team review"', async () => {
  TP.ownerTurnAgents.add('zz_lead');
  turnRegistry.set('zz_lead', { turnId: 'zz-o1', origin: { kind: 'optimize_team', for: 'zz_studio' }, optimizeTeamTrusted: true, personKey: 'owner', abortController: new AbortController(), startedAt: new Date().toISOString() });
  try {
    const wrong = await TP.runTeamPlan('zz_lead', fakeRes(), { for: 'zz_other', summary: 's', model_changes: [{ agent: 'zz_writer', model: 'claude-sdk/claude-opus-5-5' }] }, 0, null);
    assert.match(wrong, /This review turn is for zz_studio; propose changes for that agent only/);
    const res = fakeRes();
    const p = TP.runTeamPlan('zz_lead', res, { for: 'zz_studio', summary: 'Hand long jobs over', practice_notes: [{ agent: 'zz_studio', text: 'Hand long writing jobs to Writer.' }] }, 0, null);
    await tick(); await tick();
    const [card] = cards(res);
    assert.equal(card.questions[0].header, 'Team review');
    assert.deepEqual(card.questions[0].checklist, [{ id: 'p1', label: 'Practice note for Studio', detail: 'Hand long writing jobs to Writer.' }]);
    sdkChat.handleAskResponse({ request_id: card.request_id, agent: 'zz_lead', answers: { 0: 'Not now' }, checked: [] }, { isAdmin: true, personKey: 'owner' });
    assert.match(await p, /Nothing was changed/);
  } finally { TP.ownerTurnAgents.delete('zz_lead'); turnRegistry.delete('zz_lead'); TP.getTeamPlanSvc().drop('zz_lead'); }
});

test('Do it in an optimize turn writes team-practice.md on the boss (the install\'s own Records writer, in the throwaway install) and a later review replaces it', async () => {
  TP.ownerTurnAgents.add('zz_lead');
  const review1 = async (turnId, notes, checked) => {
    turnRegistry.set('zz_lead', { turnId, origin: { kind: 'optimize_team', for: 'zz_studio' }, optimizeTeamTrusted: true, personKey: 'owner', abortController: new AbortController(), startedAt: new Date().toISOString() });
    const res = fakeRes();
    const p = TP.runTeamPlan('zz_lead', res, { for: 'zz_studio', summary: 'review', practice_notes: notes }, 0, null);
    await tick(); await tick();
    sdkChat.handleAskResponse({ request_id: cards(res)[0].request_id, agent: 'zz_lead', answers: { 0: 'Do it' }, checked }, { isAdmin: true, personKey: 'owner' });
    return p;
  };
  try {
    const file = path.join(L('records').folderFor('zz_studio'), 'team-practice.md');
    assert.ok(file.startsWith(ISO.inst + path.sep), 'inside the throwaway install');
    const out = await review1('zz-o2', [{ agent: 'zz_studio', text: 'Keep short work yourself.' }, { agent: 'zz_studio', text: 'Send drafts to Critic.' }], ['p1', 'p2']);
    assert.match(out, /2 practice notes written to zz_studio's Records/);
    const first = fs.readFileSync(file, 'utf8');
    assert.match(first, /^# Team practice \(from the lead's review, \d{4}-\d{2}-\d{2}\)\n\n- Keep short work yourself\.\n- Send drafts to Critic\.\n$/);
    await review1('zz-o3', [{ agent: 'zz_studio', text: 'Check numbers twice.' }], ['p1']);
    const second = fs.readFileSync(file, 'utf8');
    assert.match(second, /- Check numbers twice\.\n$/);
    assert.doesNotMatch(second, /Keep short work|Send drafts/);
    const logLines = fs.readFileSync(path.join(ISO.data, 'team-changes-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.action === 'practice_note');
    assert.deepEqual(logLines.map(l => [l.by, l.agent]), [['zz_lead', 'zz_studio'], ['zz_lead', 'zz_studio'], ['zz_lead', 'zz_studio']]);
  } finally { TP.ownerTurnAgents.delete('zz_lead'); turnRegistry.delete('zz_lead'); TP.getTeamPlanSvc().drop('zz_lead'); }
});

test('the activity word, the status field and the turn-start event for an optimize turn', () => {
  assert.equal(hubEvents.activityOf({ kind: 'optimize_team', for: 'zz_studio' }), 'reviewing a team');
  assert.equal(hubEvents.activityOf({ kind: 'build_team', for: 'zz_studio' }), 'building a team', 'Build Team is unchanged');
  assert.deepEqual(sdkChat.statusExtras('zz_lead', { turn: { optimizeTeamTrusted: true, origin: { kind: 'optimize_team', for: 'zz_studio' } } }), { reviewingTeamFor: 'zz_studio' });
  assert.deepEqual(sdkChat.statusExtras('zz_lead', { turn: { optimizeTeamTrusted: true, origin: { kind: 'optimize_team' } } }), {}, 'no named agent, no field');
  assert.deepEqual(sdkChat.statusExtras('zz_lead', { turn: { origin: { kind: 'optimize_team', for: 'zz_studio' } } }), {}, 'an untrusted origin is not reported');
  assert.deepEqual(sdkChat.statusExtras('zz_lead', { turn: { buildTeamTrusted: true, origin: { kind: 'optimize_team', for: 'zz_studio' } } }), {}, 'Build Team\'s mark does not report a review');
  const evs = [];
  const unsub = hubEvents.events.addListener ? hubEvents.events.addListener((e) => evs.push(e)) : null;
  if (unsub !== null) {
    hubEvents.events.tapTurn(fakeSink(), { agent: 'zz_lead', origin: { kind: 'optimize_team', for: 'zz_studio', label: 'Reviewing the team of Studio' }, message: 'm', turnId: 't-opt', startedAt: new Date().toISOString() });
    const start = evs.find(e => e.type === 'turn_start' && e.turnId === 't-opt');
    assert.equal(start && start.activity, 'reviewing a team');
    assert.equal(start && start.reviewingTeamFor, 'zz_studio');
    assert.equal(start && start.buildingTeamFor, undefined);
    if (typeof unsub === 'function') unsub();
  }
});

test('the main chat view keeps an optimize_team turn exactly as a build_team turn (filterMainView, history page, leadIsHidden)', () => {
  const { filterMainView, historyPage } = L('chat-history');
  const T = (n) => new Date(Date.UTC(2026, 10, 23, 12, 0, n)).toISOString();
  const turn = (kind) => [
    { ts: T(1), role: 'user', content: 'Follow TEAM-PLAYBOOK.md (Optimize team).', origin: { kind, for: 'zz_studio' } },
    { ts: T(2), role: 'assistant', content: 'The team works; no change is needed.' },
  ];
  assert.deepEqual(filterMainView(turn('optimize_team')), [true, true]);
  assert.deepEqual(filterMainView(turn('build_team')), [true, true]);
  assert.deepEqual(filterMainView(turn('task')), [false, false]);
  assert.equal(historyPage({ logEntries: turn('optimize_team'), archive: null, view: 'main' }).history.length, 2);
  // it starts its own turn: an earlier hidden prompt with no reply stays hidden, and one that stops before replying lends nothing
  assert.deepEqual(filterMainView([{ role: 'user', content: 's', origin: { kind: 'schedule' } }, { role: 'user', content: 'o', origin: { kind: 'optimize_team' } }, { role: 'assistant', content: 'a' }]), [false, true, true]);
  assert.deepEqual(filterMainView([{ role: 'user', content: 'o', origin: { kind: 'optimize_team' } }, { role: 'user', content: 'h', origin: { kind: 'schedule' } }, { role: 'assistant', content: 'a' }]), [true, false, false]);
  // a trimmed chat log that starts mid-turn: the archive's prompt row for an optimize turn does not hide its reply
  const arc = (origin) => ({ rows: () => [{ ts: T(1), kind: 'user', text: 'Follow TEAM-PLAYBOOK.md (Optimize team).', origin, turn_id: 'tt' }], owned: () => new Set() });
  const { leadIsHidden } = L('chat-history');
  if (typeof leadIsHidden === 'function') {
    assert.equal(leadIsHidden(arc('optimize_team'), [{ role: 'assistant', ts: T(2), content: 'x' }]), false);
    assert.equal(leadIsHidden(arc('task'), [{ role: 'assistant', ts: T(2), content: 'x' }]), true);
  }
  const src = fs.readFileSync(path.join(ISO.lib, 'chat-history.js'), 'utf8');
  assert.match(src, /e\.origin\.kind === 'build_team' \|\| e\.origin\.kind === 'team_setup' \|\| e\.origin\.kind === 'optimize_team'/);
  assert.match(src, /prompt\.origin === 'build_team' \|\| prompt\.origin === 'team_setup' \|\| prompt\.origin === 'optimize_team'/);
});

test('the trusted-turn wiring sits beside Build Team\'s in lib/sdk-chat (source pins)', () => {
  const src = fs.readFileSync(path.join(ISO.lib, 'sdk-chat.js'), 'utf8');
  assert.match(src, /const trustedOptimizeTeam = trustedAdmin && ctx\.optimizeTeam === true;/);
  assert.match(src, /if \(turnOrigin\.kind === 'optimize_team' && trustedOptimizeTeam\) \{\n\s*turnTrack\.personKey = [^\n]*\n\s*turnTrack\.optimizeTeamTrusted = true;/);
  assert.match(src, /origin\.kind === 'optimize_team' && trustedOptimizeTeam\)\);/);
  assert.match(src, /if \(turnOrigin && turnOrigin\.kind === 'optimize_team' && trustedOptimizeTeam && typeof turnOrigin\.for === 'string'\) optimizeTeamRuns\.delete\(turnOrigin\.for\);/);
  assert.match(src, /o\.kind === 'optimize_team' && turn\.optimizeTeamTrusted === true[^\n]*\{ reviewingTeamFor: o\.for \}/);
  assert.match(src, /t\.optimizeTeamTrusted === true && t\.origin && t\.origin\.kind === 'optimize_team'/);
  // the Build Team lines the earlier tests pin are still there, untouched
  assert.match(src, /if \(turnOrigin && turnOrigin\.kind === 'build_team' && trustedBuildTeam && typeof turnOrigin\.for === 'string'\) buildTeamRuns\.delete\(turnOrigin\.for\);/);
  assert.match(src, /buildTeamTrusted: turnOrigin\.kind === 'build_team' && trustedBuildTeam === true/);
  // the keep-on-box classifier the route uses is the strict one the research code uses
  assert.equal(typeof sdkChat.researchKeptOnBox, 'function');
  assert.equal(sdkChat.researchKeptOnBox({ name: 'zz_studio' }) === true || sdkChat.researchKeptOnBox({ name: 'zz_studio' }) === false, true);
  assert.equal(sdkChat.researchKeptOnBox(null), true, 'an agent that cannot be found counts as kept');
  assert.equal(typeof review.routeOptimizeTeam, 'function');
});

test('the review turn\'s message comes from the facts: the lead gets the plain instruction, a keep-on-box boss the "own review" line', () => {
  const list = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
  const boss = list.find(a => a.name === 'zz_studio');
  const mk = (keepOnBox) => review.reviewMessage(review.reviewFacts({ boss, agentsList: list, adminIds: new Set(), transcript: {}, handOffs: () => [], telemetryRows: [], models: [], tierOf: () => null, now: Date.now(), keepOnBox }));
  assert.match(mk(false), /^Follow TEAM-PLAYBOOK\.md \(Optimize team\)\. Review Studio and its team/);
  assert.match(mk(true), /^This is Studio's own review of its team\. Follow TEAM-PLAYBOOK\.md/);
  const facts = JSON.parse(mk(false).split('```json\n')[1].replace(/\n```$/, ''));
  assert.deepEqual(facts.team.map(m => [m.name, m.role]), [['zz_studio', 'main'], ['zz_writer', 'worker']]);
  assert.equal(facts.low_history, true, 'no archive: too little to judge from');
});
