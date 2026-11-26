'use strict';
// Deep research wiring (lib/sdk-chat.js): the deep_research tool's handler run against stand-ins (the real lib/research and
// lib/research-prefs), the person a turn is for, the reminder for Never, the start gate, where the tool and the guidance are
// offered, the policy class, the route and the start-up hook.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { makeIsolatedInstall } = require('./helpers/isolated-install');

const ISO = makeIsolatedInstall('research-wiring-');
const research = require(path.join(ISO.inst, 'lib', 'research.js'));
const prefsLib = require(path.join(ISO.inst, 'lib', 'research-prefs.js'));
const REAL = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(REAL, 'lib', 'sdk-chat.js'), 'utf8');
const WEEK = 7 * 24 * 3600 * 1000;

function load({ on = true, virtual = false, handOff = null, agents = [], hasUsers = true, admins = [{ id: 'u_owner', createdAt: '2026-01-01' }], reminderDays, askAnswer = 'Yes', model = 'claude-sdk/claude-test-big', extraMods = {}, globals = {}, settings = {} } = {}) {
  const a = SRC.indexOf('// ── Deep research (lib/research');
  const b = SRC.indexOf('// behaviour_change: offered by the same rule');
  assert.ok(a > 0 && b > a, 'the deep research block is there');
  let t = 10_000_000;
  const prefsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rw-')), 'research-prefs.json');
  const prefs = prefsLib.createResearchPrefs({ file: prefsFile, now: () => t });
  const asked = [];
  const started = [];
  const turnRegistry = new Map();
  const mods = {
    './behaviour-changes': { isOn: (id) => id === 'deep-research' && on },
    './settings': { getSetting: (k) => (k === 'researchReminderDays' ? reminderDays : settings[k]) },
    './agents': { getAgentsSync: () => agents },
    './tool-policy': require(path.join(ISO.inst, 'lib', 'tool-policy.js')),
    './research-thorough': require(path.join(ISO.inst, 'lib', 'research-thorough.js')),
    ...extraMods,
  };
  const ctx = vm.createContext({
    require: (m) => { if (!(m in mods)) throw new Error('unexpected require ' + m); return mods[m]; },
    temporalWorkers: { isVirtual: () => virtual, noteFor: () => '' },
    handOffOfTurn: () => handOff,
    hubAuthMod: { getAuth: () => ({ hasUsers: () => hasUsers, admins: () => admins }) },
    path, fs, console, Promise,
    researchLib: research,
    researchPrefsLib: { getResearchPrefs: () => prefs, CHOICES: prefsLib.CHOICES, LEVELS: prefsLib.LEVELS },
    turnRegistry,
    getAgentModel: async () => model,
    runAskUser: async (agent, res, card) => { asked.push(card); return askAnswer; },
    runSpawnWorkers: async () => 'x', wakeAgent: async () => {}, refreshWorkerCatalog: async () => ({ available: [] }), memberWorkerModels: () => null,
    ...globals,
  });
  vm.runInContext(SRC.slice(a, b) + `
this.offered = deepResearchOffered; this.run = runDeepResearch; this.guidance = researchGuidanceFor; this.personOf = researchPersonOf; this.remindMs = researchReminderMs;
this.setRunner = (r) => { _researchRunner = r; }; this.keptOnBox = researchKeptOnBox; this.reviewer = researchReviewer; this.helperModel = researchHelperModel; this.settingsNow = researchThoroughSettings; this.writeDoc = researchWriteDocument; this.onProgress = researchOnProgress; this.statusFor = researchStatusFor; `, ctx);
  ctx.setRunner({ start: (x) => { started.push(x); return { ok: true, id: 'dr-00000001' }; }, recover() {} });
  const live = { on() {}, writableEnded: false };
  const turn = (agent, over = {}) => { const tr = { origin: { kind: 'user' }, personKey: 'u_sam', ...over }; turnRegistry.set(agent, tr); return tr; };
  return { ctx, prefs, prefsFile, asked, started, turn, live, advance: (ms) => { t += ms; } };
}

test('offered only while the change is on, at depth 0, never to a temporary worker, a tiger team or a hand-off turn', () => {
  assert.equal(load().ctx.offered('sam-agent', 0), true);
  assert.equal(load({ on: false }).ctx.offered('sam-agent', 0), false);
  assert.equal(load().ctx.offered('sam-agent', 1), false);
  assert.equal(load().ctx.offered('sam-agent', 0, true), false);
  assert.equal(load({ virtual: true }).ctx.offered('tw-1', 0), false);
  assert.equal(load({ handOff: 'ho-12345678' }).ctx.offered('sam-agent', 0), false);
  assert.match(load().ctx.guidance('sam-agent', 0), /## RESEARCH QUESTIONS[\s\S]*deep_research with action "offer" BEFORE answering[\s\S]*action "set"/);
  assert.equal(load({ on: false }).ctx.guidance('sam-agent', 0), '');
  assert.equal(load().ctx.guidance('sam-agent', 1), '');
});

test('the tool refuses when not offered (a stale call after the change was switched off)', async () => {
  const L = load({ on: false });
  L.turn('sam-agent');
  assert.equal(await L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q?' }), 'Deep research is not available here.');
});

test('offer: the person who typed the turn is asked with the card; Always yes is stored for that person', async () => {
  const L = load({ askAnswer: 'Always yes' });
  L.turn('sam-agent');
  const out = await L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Which judge is best?' });
  assert.equal(L.asked.length, 1);
  assert.deepEqual(L.asked[0].options, ['Yes, quick', 'Yes, thorough', 'No', 'Always yes', 'Never']);
  assert.match(L.asked[0].question, /Claude sign-in plan allowance/);
  assert.match(out, /^The person wants a quick deep research run \(and from now on without being asked\)/);
  assert.equal(L.prefs.choiceOf('u_sam'), 'always');
  // the next research question runs without a card
  L.turn('sam-agent');
  assert.match(await L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Another?' }), /they chose always/);
  assert.equal(L.asked.length, 1);
});

test('offer on a hub-started turn: no card; the stored choice, else answer normally with a one-line offer', async () => {
  const L = load({ agents: [{ name: 'member-agent', owner: 'u_member' }] });
  L.turn('sam-agent', { origin: { kind: 'schedule' }, personKey: null });
  assert.match(await L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q?' }), /No one can be asked right now/);
  assert.equal(L.asked.length, 0);
  // the agent's person: a member's agent -> the member; another agent -> the earliest admin
  assert.equal(L.ctx.personOf('member-agent', { personKey: null }), 'u_member');
  assert.equal(L.ctx.personOf('sam-agent', { personKey: null }), 'u_owner');
  assert.equal(load({ hasUsers: false }).ctx.personOf('sam-agent', null), 'owner');
  L.prefs.setChoice('u_owner', 'always');
  assert.match(await L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q?' }), /they chose always/);
});

test('Never: one reminder line the first time it is due, none within the interval, again after it; 0 days never reminds', async () => {
  const L = load();
  L.prefs.setChoice('u_sam', 'never');
  L.turn('sam-agent');
  // choosing Never counts as being told: within the first week, plain never
  assert.doesNotMatch(await L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q1?' }), /turn deep research back on/);
  L.advance(WEEK);
  const first = await L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q2?' });
  assert.ok(first.endsWith(research.REMIND_LINE), 'the line, once');
  assert.equal(L.asked.length, 0, 'no card');
  const next = await L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q3?' });
  assert.doesNotMatch(next, /turn deep research back on/, 'not again within the interval');
  L.advance(WEEK);
  assert.ok((await L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q4?' })).endsWith(research.REMIND_LINE), 'again after it');
  // the interval is the setting; 0 = never remind
  assert.equal(load({ reminderDays: 14 }).ctx.remindMs(), 2 * WEEK);
  assert.equal(load({ reminderDays: 'junk' }).ctx.remindMs(), WEEK);
  const Z = load({ reminderDays: 0 });
  Z.prefs.setChoice('u_sam', 'never');
  Z.turn('sam-agent');
  Z.advance(10 * WEEK);
  assert.doesNotMatch(await Z.ctx.run('sam-agent', Z.live, { action: 'offer', question: 'Q?' }), /turn deep research back on/);
});

test('"turn deep research back on": set flips the choice of the person who typed the turn, and only theirs', async () => {
  const L = load();
  L.prefs.setChoice('u_sam', 'never');
  L.turn('sam-agent');
  assert.match(await L.ctx.run('sam-agent', L.live, { action: 'set', choice: 'ask' }), /back on/);
  assert.equal(L.prefs.choiceOf('u_sam'), 'ask');
  // a hub-started turn, or a turn without a signed-in person, changes nothing
  L.prefs.setChoice('u_owner', 'never');
  L.turn('sam-agent', { origin: { kind: 'job_notice' }, personKey: null });
  assert.match(await L.ctx.run('sam-agent', L.live, { action: 'set', choice: 'ask' }), /only the person can change it/);
  L.turn('sam-agent', { origin: { kind: 'user' }, personKey: null });
  assert.match(await L.ctx.run('sam-agent', L.live, { action: 'set', choice: 'ask' }), /only the person can change it/);
  assert.equal(L.prefs.choiceOf('u_owner'), 'never');
  assert.match(await L.ctx.run('sam-agent', L.live, { action: 'set', choice: 'maybe' }), /ask, always or never/);
});

test('start: only after a yes in this turn (or a stored always); the approval is used once', async () => {
  const L = load({ askAnswer: 'Yes' });
  L.turn('sam-agent');
  const subs = ['a', 'b'];
  assert.match(await L.ctx.run('sam-agent', L.live, { action: 'start', question: 'Q?', sub_questions: subs }), /^Ask first/);
  assert.equal(L.started.length, 0);
  await L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q?' });
  assert.match(await L.ctx.run('sam-agent', L.live, { action: 'start', question: 'Q?', sub_questions: subs }), /^Started \(id dr-00000001\)/);
  assert.deepEqual(JSON.parse(JSON.stringify(L.started)), [{ agent: 'sam-agent', question: 'Q?', subQuestions: subs, level: 'quick' }]);
  assert.match(await L.ctx.run('sam-agent', L.live, { action: 'start', question: 'Q?', sub_questions: subs }), /^Ask first/, 'once');
  // No: no start
  const N = load({ askAnswer: 'No' });
  N.turn('sam-agent');
  await N.ctx.run('sam-agent', N.live, { action: 'offer', question: 'Q?' });
  assert.match(await N.ctx.run('sam-agent', N.live, { action: 'start', question: 'Q?', sub_questions: subs }), /^Ask first/);
  // a stored always starts without an offer in this turn
  const A = load();
  A.prefs.setChoice('u_sam', 'always');
  A.turn('sam-agent');
  assert.match(await A.ctx.run('sam-agent', A.live, { action: 'start', question: 'Q?', sub_questions: subs }), /^Started/);
  // a finished or gone stream: no card
  const D = load();
  D.turn('sam-agent');
  assert.match(await D.ctx.run('sam-agent', { on() {}, writableEnded: true }, { action: 'offer', question: 'Q?' }), /No one can be asked/);
  assert.equal(D.asked.length, 0);
});

test('the tool is on both tool lists, the guidance on every route, the person on the turn, the start-up hook, the route and the policy class', () => {
  assert.match(SRC, /\.\.\.\(deepResearchOffered\(agentName, consultationDepth, tigerTeam\) \? \[\{\n\s+name: researchLib\.TOOL\.name/);
  assert.match(SRC, /\.\.\.\(deepResearchOffered\(agentName, consultationDepth, tigerTeam\) \? \[sdk\.tool\(researchLib\.TOOL\.name/);
  assert.equal((SRC.match(/\+ researchGuidanceFor\(agentName, /g) || []).length, 3, 'gateway, Claude and Codex instructions');
  // changed: the condition now also admits a trusted Set up teams turn (team_setup && trustedTeamSetup), the same trust as Build Team; the rest of the line is unchanged.
  assert.match(SRC, /const personKey = \(turnOrigin\.kind === 'user' \|\| \(turnOrigin\.kind === 'build_team' && trustedBuildTeam\) \|\| \(turnOrigin\.kind === 'team_setup' && trustedTeamSetup\)\) \? \(trustedAccounts === false \? 'owner' : \(trustedUserId \? String\(trustedUserId\)\.slice\(0, 64\) : null\)\) : null;/);   // review r2: no accounts (also the older single password) -> 'owner'. Build Team (the route's trusted admin context) names the admin who pressed it, so its plan card is theirs.
  assert.match(SRC, /\{ kind: 'research_report', from: 'hub' \}\)/);   // the report turn's origin (delivery itself: the review r2 test)
  const server = fs.readFileSync(path.join(REAL, 'server.js'), 'utf8');
  assert.match(server, /require\('\.\/lib\/sdk-chat'\)\.startResearch\(\)/);
  assert.match(server, /pathname === '\/api\/research-pref'/);
  assert.match(server, /patch\.researchReminderDays/);
  const access = require(path.join(ISO.inst, 'lib', 'access.js'));
  assert.equal(access.classifyRoute('/api/research-pref', 'GET').kind, 'session');
  const tp = require(path.join(ISO.inst, 'lib', 'tool-policy.js'));
  const cls = (input) => tp.classifyTool({ tool: 'mcp__hub__deep_research', input, agentName: 'sam-agent', policy: {} }).cls;
  assert.equal(cls({ action: 'offer', question: 'Q?' }), 'write_inside');
  assert.equal(cls({ action: 'set', choice: 'ask' }), 'write_inside');
  assert.equal(cls({ action: 'start', question: 'Q?' }), 'delegate');
});

// ── review r1: approvals, the person of a typed turn, the card's answerer, the reminder on hub turns ──
test('review r1: "No thanks" or any typed text never approves a start; a later offer ends an earlier yes; the question must match', async () => {
  const subs = ['a', 'b'];
  const T = load({ askAnswer: 'No thanks' });
  T.turn('sam-agent');
  assert.match(await T.ctx.run('sam-agent', T.live, { action: 'offer', question: 'Q?' }), /not a yes/);
  assert.match(await T.ctx.run('sam-agent', T.live, { action: 'start', question: 'Q?', sub_questions: subs }), /^Ask first/);
  // a yes, then a second offer answered No: the earlier yes no longer counts
  const L = load({ askAnswer: 'Yes' });
  L.turn('sam-agent');
  await L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q1?' });
  assert.match(await L.ctx.run('sam-agent', L.live, { action: 'start', question: 'Other question?', sub_questions: subs }), /^Ask first/, 'another question');
  L.ctx.runAskUser = async () => 'No';   // the same question offered again, answered No
  await L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q1?' });
  assert.match(await L.ctx.run('sam-agent', L.live, { action: 'start', question: 'Q1?', sub_questions: subs }), /^Ask first/, 'the later No ended the yes');
  L.ctx.runAskUser = async () => 'Yes';
  await L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q1?' });
  await L.ctx.run('sam-agent', L.live, { action: 'set', choice: 'ask' });
  assert.match(await L.ctx.run('sam-agent', L.live, { action: 'start', question: 'Q1?', sub_questions: subs }), /^Ask first/, 'set ended the approval');
});

test('review r1: a typed turn without a trusted person never falls back to the owner: no card, no stored choice used or changed', async () => {
  const L = load();
  L.prefs.setChoice('u_owner', 'always');
  L.turn('sam-agent', { origin: { kind: 'user' }, personKey: null });
  const out = await L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q?' });
  assert.match(out, /No one can be asked/);
  assert.equal(L.asked.length, 0);
  assert.match(await L.ctx.run('sam-agent', L.live, { action: 'start', question: 'Q?', sub_questions: ['a', 'b'] }), /^Ask first/, "the owner's always is not borrowed");
  assert.equal(L.prefs.choiceOf('u_owner'), 'always');
});

test('review r1: the card is bound to the person it asks; only their answer counts', async () => {
  const L = load();
  L.turn('sam-agent');
  await L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q?' });
  assert.equal(L.asked[0].forUser, 'u_sam');
  const SRC2 = fs.readFileSync(path.join(REAL, 'lib', 'sdk-chat.js'), 'utf8');
  const a = SRC2.indexOf('function handleAskResponse('), b = SRC2.indexOf('\n}\n', a);
  const ctx = vm.createContext({ pendingQuestions: new Map(), questionAgents: new Map() });
  vm.runInContext(SRC2.slice(a, b + 2) + '\nthis.h = handleAskResponse;', ctx);
  let got = null;
  ctx.pendingQuestions.set('q1', { resolve: (x) => { got = x; }, adminOnly: false, forUser: 'u_sam' });
  ctx.questionAgents.set('q1', 'sam-agent');
  assert.equal(ctx.h({ request_id: 'q1', answers: 'Always yes', agent: 'sam-agent' }, { personKey: 'u_other' }).success, false);
  assert.equal(got, null);
  assert.equal(ctx.h({ request_id: 'q1', answers: 'Always yes', agent: 'sam-agent' }, { personKey: 'u_sam' }).success, true);
  assert.equal(got, 'Always yes');
  const server = fs.readFileSync(path.join(REAL, 'server.js'), 'utf8');
  assert.match(server, /handleAskResponse\(body, \{ isAdmin: access\.isAdmin\(req\.hubUser\), personKey \}\)/);
});

test('review r1: no reminder spent on a turn the hub started; the run is detached from later turns and reads raw outcomes', async () => {
  const L = load();
  L.prefs.setChoice('u_owner', 'never');
  L.advance(WEEK);
  L.turn('sam-agent', { origin: { kind: 'schedule' }, personKey: null });
  assert.doesNotMatch(await L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q?' }), /turn deep research back on/);
  assert.equal(L.prefs.remindDue('u_owner', WEEK), true, 'still due for when they are reading');
  // review r5 added the admit check to the same call
  assert.match(SRC, /spawn: \(agent, workers, signal, opts = \{\}\) => runSpawnWorkers\(agent, workers, null, signal \|\| null, null, \{ detached: true, raw: true, admit:/);
  assert.match(SRC, /const parentTurn = opts\.detached \? null :/);
  assert.match(SRC, /const callerTurn = \(opts\.queuedRun \|\| opts\.detached\) \? null :/);
  assert.match(SRC, /if \(raw\) return results\.map\(r => \(\{ label: r\.label, ok: r\.ok === true && !isStoppedResult\(r\.text\), text: String\(r\.text \|\| ''\) \}\)\);/);
});

// ── review r2: one card at a time, a newer call wins, a failed start keeps the approval, legacy installs, delivery ──
test('review r2: a second offer while a card waits is refused; a set made meanwhile wins over the older card', async () => {
  const L = load();
  L.turn('sam-agent');
  let answerFirst;
  L.ctx.runAskUser = () => new Promise((r) => { answerFirst = r; });
  const first = L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q1?' });
  await new Promise((r) => setImmediate(r));
  assert.match(await L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q2?' }), /already waiting for the person's answer/);
  // the person changes their choice by words while the card is still open
  assert.match(await L.ctx.run('sam-agent', L.live, { action: 'set', choice: 'never' }), /off/);
  answerFirst('Always yes');
  await first;
  assert.equal(L.prefs.choiceOf('u_sam'), 'never', 'the older card does not overwrite the newer choice');
  assert.match(await L.ctx.run('sam-agent', L.live, { action: 'start', question: 'Q1?', sub_questions: ['a', 'b'] }), /^Ask first/, 'and approves nothing');
});

test('review r2: a start that the runner refuses keeps the approval so the agent can correct it', async () => {
  const L = load({ askAnswer: 'Yes' });
  L.turn('sam-agent');
  await L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q?' });
  let calls = 0;
  L.ctx.setRunner({ start: () => (++calls === 1 ? { ok: false, error: 'Give 2 to 8 different sub-questions that together answer the question.' } : { ok: true, id: 'dr-00000002' }), recover() {} });
  assert.match(await L.ctx.run('sam-agent', L.live, { action: 'start', question: 'Q?', sub_questions: ['only one'] }), /2 to 8/);
  assert.match(await L.ctx.run('sam-agent', L.live, { action: 'start', question: 'Q?', sub_questions: ['a', 'b'] }), /^Started \(id dr-00000002\)/);
  assert.match(await L.ctx.run('sam-agent', L.live, { action: 'start', question: 'Q?', sub_questions: ['a', 'b'] }), /^Ask first/, 'used once it started');
});

test('review r2: delivery counts only when the report turn ended with a reply; the deadline stops started workers', () => {
  assert.match(SRC, /wakeAgent\(agent, message, \(text\) => \(String\(text \|\| ''\)\.trim\(\) \? resolve\(\) : reject\(new Error\('the report turn ended without a reply'\)\)\), \{ kind: 'research_report', from: 'hub' \}\)/);
  assert.match(SRC, /if \(detached && signal\) signal\.addEventListener\('abort', stopStarted, \{ once: true \}\);/);
  assert.match(SRC, /const stopStarted = \(\) => \{ for \(const id of startedIds\) \{ try \{ cancelWorker\(id, \{ admin: true \}\); \}/);
  assert.match(SRC, /if \(detached\) \{ startedIds\.add\(v\.id\); if \(signal && signal\.aborted\) stopStarted\(\); \}/);
});

// ── review r3: two offers at once, a superseded card says so ──
test('review r3: two offers started together open exactly one card; the second is refused at once', async () => {
  const L = load();
  L.turn('sam-agent');
  let opened = 0, answer;
  L.ctx.runAskUser = () => { opened++; return new Promise((r) => { answer = r; }); };
  const a = L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q1?' });
  const b = L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q2?' });   // same tick, before any model lookup
  assert.match(await b, /already waiting/);
  for (let i = 0; i < 5 && !answer; i++) await new Promise((r) => setImmediate(r));
  assert.equal(opened, 1);
  answer('Yes');
  assert.match(await a, /wants a quick deep research run/);
});

test('review r3: a card overtaken by a newer call says its answer counts for nothing', async () => {
  const L = load();
  L.turn('sam-agent');
  let answer;
  L.ctx.runAskUser = () => new Promise((r) => { answer = r; });
  const a = L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q1?' });
  for (let i = 0; i < 5 && !answer; i++) await new Promise((r) => setImmediate(r));
  await L.ctx.run('sam-agent', L.live, { action: 'set', choice: 'ask' });
  answer('Always yes');
  assert.match(await a, /changed their deep research choice while this question was open/);
  assert.equal(L.prefs.choiceOf('u_sam'), 'ask');
});

test('review r4: the hub stamps a run with agentIdentityStrict (the raw record\'s box id), not the listed agents', () => {
  assert.match(SRC, /stampOf: \(agent\) => require\('\.\/agents'\)\.agentIdentityStrict\(agent\)/);
  assert.doesNotMatch(SRC, /stampOf:[^\n]*getAgentsSync/);
});

test('review r5: the launcher asks admit right before each worker is dispatched, and the research wiring passes it', () => {
  assert.match(SRC, /runOne: \(job, v\) => \{\n\s+if \(typeof admit === 'function' && !admit\(\)\) throw new Error\(/);
  assert.match(SRC, /spawn: \(agent, workers, signal, opts = \{\}\) => runSpawnWorkers\([^\n]*admit: \(opts && opts\.admit\) \|\| null/);
});

// ── levels: quick and thorough ──
const SUBS2 = ['a', 'b'];
const startReq = (L, over = {}) => L.ctx.run('sam-agent', L.live, { action: 'start', question: 'Q?', sub_questions: SUBS2, ...over });

test('levels: a thorough start after a quick approval is refused; a quick start (also by default) goes through', async () => {
  const L = load({ askAnswer: 'Yes, quick' });
  L.turn('sam-agent');
  const offer = await L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q?' });
  assert.match(offer, /quick deep research run/);
  assert.equal(L.prefs.choiceOf('u_sam'), 'ask');
  assert.equal(await startReq(L, { level: 'thorough' }), 'The person chose Quick; start with level "quick", or offer again so they can choose Thorough.');
  assert.equal(L.started.length, 0);
  assert.match(await startReq(L), /^Started/, 'no level given: the approved level');
  assert.equal(L.started[0].level, 'quick');
  L.turn('sam-agent');
  await L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q?' });
  assert.match(await startReq(L, { level: 'quick' }), /^Started/);
});

test('levels: a thorough start after a thorough approval; a quick start after it is refused (exact match)', async () => {
  const L = load({ askAnswer: 'Yes, thorough' });
  L.turn('sam-agent');
  assert.match(await L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q?' }), /thorough deep research run.*level "thorough".*up to an hour/);
  assert.match(await startReq(L, { level: 'quick' }), /^The person chose Thorough; start with level "thorough"/);
  assert.equal(L.started.length, 0);
  assert.match(await startReq(L, { level: 'thorough' }), /^Started/);
  assert.equal(L.started[0].level, 'thorough');
  // the approval was used once
  assert.match(await startReq(L, { level: 'thorough' }), /^Ask first/);
  // an unknown level is refused
  const M = load({ askAnswer: 'Yes, thorough' });
  M.turn('sam-agent');
  await M.ctx.run('sam-agent', M.live, { action: 'offer', question: 'Q?' });
  assert.match(await startReq(M, { level: 'deep' }), /level must be quick or thorough/);
  assert.equal(M.started.length, 0);
});

test('levels: always + thorough starts thorough (and quick) without a card; always + quick refuses thorough', async () => {
  const T = load();
  T.prefs.setChoice('u_sam', 'always'); T.prefs.setAlwaysLevel('u_sam', 'thorough');
  T.turn('sam-agent');
  assert.match(await T.ctx.run('sam-agent', T.live, { action: 'offer', question: 'Q?' }), /they chose always.*level "thorough"/);
  assert.equal(T.asked.length, 0);
  T.turn('sam-agent');
  assert.match(await startReq(T, { level: 'thorough' }), /^Started/);
  T.turn('sam-agent');
  assert.match(await startReq(T, { level: 'quick' }), /^Started/);
  assert.deepEqual(T.started.map(x => x.level), ['thorough', 'quick']);
  T.turn('sam-agent');
  assert.match(await startReq(T), /^Started/, 'no level: the approved level (quick) is allowed');
  const Q = load();
  Q.prefs.setChoice('u_sam', 'always');
  Q.turn('sam-agent');
  const r = await startReq(Q, { level: 'thorough' });
  assert.match(r, /Always yes runs Quick/);
  assert.equal(Q.started.length, 0);
  assert.match(await startReq(Q, { level: 'quick' }), /^Started/);
});

test('levels: a stored thorough level does not make a plain Yes thorough; the card carries recommend and alwaysLevel', async () => {
  const L = load({ askAnswer: 'Yes' });
  L.prefs.setAlwaysLevel('u_sam', 'thorough');
  L.turn('sam-agent');
  await L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q?', recommend: 'thorough' });
  assert.ok(L.asked[0].descriptions[1].endsWith(' Recommended.'));
  assert.ok(L.asked[0].descriptions[3].endsWith('(now: Thorough).'));
  assert.match(await startReq(L, { level: 'thorough' }), /^The person chose Quick/);
  L.turn('sam-agent');
  await L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q?', recommend: 'nonsense' });
  assert.ok(!L.asked[1].descriptions.join(' ').includes('Recommended'));
  // the recommendation never changes the decision: a No stays a No
  const N = load({ askAnswer: 'No' });
  N.turn('sam-agent');
  assert.match(await N.ctx.run('sam-agent', N.live, { action: 'offer', question: 'Q?', recommend: 'thorough' }), /said no/);
});

test('levels: "Always yes" on the card stores always and runs at the stored level', async () => {
  const L = load({ askAnswer: 'Always yes' });
  L.prefs.setAlwaysLevel('u_sam', 'thorough');
  L.turn('sam-agent');
  assert.match(await L.ctx.run('sam-agent', L.live, { action: 'offer', question: 'Q?' }), /thorough deep research run \(and from now on/);
  assert.equal(L.prefs.choiceOf('u_sam'), 'always');
  assert.match(await startReq(L, { level: 'thorough' }), /^Started/);
});

test('levels: a tool call with always_level changes nothing, on any turn; only the person changes it (Settings, the phone sheet)', async () => {
  const L = load();
  L.prefs.setAlwaysLevel('u_sam', 'quick');
  const refusal = 'Only the person can choose which level Always yes runs, in Settings (or the phone\'s Deep research sheet). Tell them where.';
  L.turn('sam-agent');
  assert.equal(await L.ctx.run('sam-agent', L.live, { action: 'set', always_level: 'thorough' }), refusal);
  assert.equal(L.prefs.alwaysLevelOf('u_sam'), 'quick', 'a typed turn cannot change it either');
  assert.equal(await L.ctx.run('sam-agent', L.live, { action: 'set', choice: 'always', always_level: 'thorough' }), refusal);
  assert.equal(L.prefs.alwaysLevelOf('u_sam'), 'quick');
  assert.equal(L.prefs.choiceOf('u_sam'), 'ask', 'the whole call is refused');
  L.turn('sam-agent', { origin: { kind: 'job_notice' }, personKey: null });
  assert.equal(await L.ctx.run('sam-agent', L.live, { action: 'set', always_level: 'thorough' }), refusal);
  assert.equal(L.prefs.alwaysLevelOf('u_sam'), 'quick');
  assert.equal(L.prefs.alwaysLevelOf('u_owner'), 'quick');
  // the choice itself is still the person's to set by typing
  L.turn('sam-agent');
  assert.match(await L.ctx.run('sam-agent', L.live, { action: 'set', choice: 'always' }), /without asking/);
  assert.equal(L.prefs.choiceOf('u_sam'), 'always');
});

test('levels: the guidance mentions the recommendation; the route has GET alwaysLevel and POST alwaysLevel', () => {
  assert.match(load().ctx.guidance('sam-agent', 0), /you may recommend quick or thorough; the person chooses\. Start the level they chose\./);
  const server = fs.readFileSync(path.join(REAL, 'server.js'), 'utf8');
  assert.match(server, /alwaysLevel: prefs\.alwaysLevelOf\(key\)/);
  assert.match(server, /prefs\.setAlwaysLevel\(key, body\.alwaysLevel\)/);
});

// ── Thorough runs: the level a start takes, the runner's deps, the document, the progress contract ──
test('start: no level and no approval, but the person\'s choice is always -> their Always yes level (thorough), else quick', async () => {
  const L = load();
  L.prefs.setChoice('u_sam', 'always');
  L.prefs.setAlwaysLevel('u_sam', 'thorough');
  L.turn('sam-agent');
  assert.match(await startReq(L), /^Started/);
  assert.equal(L.started[0].level, 'thorough');
  L.prefs.setAlwaysLevel('u_sam', 'quick');
  L.turn('sam-agent');
  assert.match(await startReq(L), /^Started/);
  assert.equal(L.started[1].level, 'quick');
  // an approval still wins over the stored level
  const L2 = load({ askAnswer: 'Yes, quick' });
  L2.prefs.setAlwaysLevel('u_sam', 'thorough');
  L2.turn('sam-agent');
  await L2.ctx.run('sam-agent', L2.live, { action: 'offer', question: 'Q?' });
  assert.match(await startReq(L2), /^Started/);
  assert.equal(L2.started[0].level, 'quick');
  // no choice and no approval: still refused
  const L3 = load();
  L3.turn('sam-agent');
  assert.match(await startReq(L3), /^Ask first/);
});

test('the runner is wired for Thorough runs: page fetch (no private addresses), settings, reviewer, reader model, document, progress', () => {
  assert.match(SRC, /fetchPage: \(url, opts = \{\}\) => require\('\.\/web-fetch'\)\.getWebFetch\(\)\.fetchPage\(url, \{ allowPrivate: false, maxLength: opts\.maxLength, offset: opts\.offset, maxBytes: opts\.maxBytes \}\)/);
  assert.match(SRC, /thoroughSettings: researchThoroughSettings,/);
  assert.match(SRC, /pickReviewer: researchReviewer,/);
  assert.match(SRC, /writeDocument: researchWriteDocument,/);
  assert.match(SRC, /onProgress: researchOnProgress,/);
  assert.match(SRC, /pickHelperModel: researchHelperModel,/);
  assert.match(SRC, /settingsFrom\(raw\)/);
  assert.match(SRC, /getSetting\('researchThorough'\)/);
  assert.match(SRC, /sameVendor: researchKeptOnBox\(agent\)/);
  assert.match(SRC, /teamFolderOf\(rec\)/);
  assert.match(SRC, /keptOnBox: researchKeptOnBox,/);
  assert.match(SRC, /hubEvents\.events\.publish\('research_progress', \{ agent: run\.agent, id: run\.id, level: run\.level, stage: run\.stage \|\| '', label: run\.stageLabel \|\| '', done: run\.stageDone \|\| 0, total: run\.stageTotal \|\| 0, state: run\.state, startedAt: run\.startedAt, seq: run\.seq \|\| 0 \}\)/);
  assert.match(SRC, /module\.exports = \{\n  researchStatusFor,/);
});

test('researchStatusFor: only the agent\'s active runs, in the contract shape; research_progress is published and never throws', () => {
  const published = [];
  const L = load({ globals: { hubEvents: { events: { publish: (t, p) => published.push({ t, p }) } } } });
  const mk = (over) => ({ id: 'dr-1', agent: 'sam-agent', level: 'thorough', state: 'running', stage: 'read', stageLabel: 'reading sources in full (1 of 3)', stageDone: 1, stageTotal: 3, startedAt: 111, ...over });
  const runs = [mk(), mk({ id: 'dr-2', state: 'delivering', stage: 'document', stageLabel: 'writing the document', stageDone: 1, stageTotal: 1 }), mk({ id: 'dr-3', state: 'delivered' }), mk({ id: 'dr-4', state: 'failed' }), mk({ id: 'dr-5', agent: 'other-agent' })];
  L.ctx.setRunner({ list: () => runs, start() {}, recover() {} });
  const st = JSON.parse(JSON.stringify(L.ctx.statusFor('sam-agent')));
  assert.deepEqual(st.map((x) => x.id), ['dr-1', 'dr-2']);
  assert.deepEqual(st[0], { id: 'dr-1', level: 'thorough', stage: 'read', label: 'reading sources in full (1 of 3)', done: 1, total: 3, startedAt: 111, seq: 0 });
  assert.equal(L.ctx.statusFor('nobody').length, 0);
  L.ctx.onProgress(runs[0]);
  assert.deepEqual(JSON.parse(JSON.stringify(published)), [{ t: 'research_progress', p: { agent: 'sam-agent', id: 'dr-1', level: 'thorough', stage: 'read', label: 'reading sources in full (1 of 3)', done: 1, total: 3, state: 'running', startedAt: 111, seq: 0 } }]);
  const broken = load({ globals: { hubEvents: { events: { publish: () => { throw new Error('bus down'); } } } } });
  broken.ctx.onProgress(runs[0]);
  const noBus = load();
  noBus.ctx.onProgress(runs[0]);
  // a runner that cannot be read gives an empty list, never a throw
  L.ctx.setRunner({ list: () => { throw new Error('x'); }, start() {}, recover() {} });
  assert.equal(L.ctx.statusFor('sam-agent').length, 0);
});

test('pickReviewer and the helper model wiring: an agent kept on its own service stays on its own model', async () => {
  const own = 'claude-sdk/claude-test-big';
  const catalogue = { available: ['claude-sdk/claude-test-fast', 'openai/test-mini', 'google/test-g'], sdkInfo: [] };
  const settings = { autoClassifier: { keepOnBox: ['ward-agent'] } };
  const agents = [{ name: 'sam-agent' }, { name: 'ward-agent' }];
  const L = load({ agents, settings, globals: { refreshWorkerCatalog: async () => catalogue, temporalWorkers: { isVirtual: () => false, noteFor: () => 'fast and cheap' } } });
  assert.equal(L.ctx.keptOnBox('sam-agent'), false);
  assert.equal(L.ctx.keptOnBox('ward-agent'), true);
  assert.equal(L.ctx.keptOnBox('ghost-agent'), true, 'a lookup that finds nothing counts as kept: content never leaves on a guess');
  const free = await L.ctx.reviewer('sam-agent');
  assert.equal(free.crossVendor, true);
  assert.match(free.label, /^a model from another vendor \((OpenAI|Google)\)$/);
  const kept = await L.ctx.reviewer('ward-agent');
  assert.deepEqual(JSON.parse(JSON.stringify(kept)), { model: own, label: 'the same service as the agent (its content stays there)', crossVendor: false });
  // helpers: a kept agent gets its own model, not even another model of its own vendor (another route is another service)
  assert.equal(await L.ctx.helperModel('ward-agent'), own);
  assert.equal(await L.ctx.helperModel('sam-agent'), 'claude-sdk/claude-test-fast');
  // a member's agent: only the models the member may use
  const L3 = load({ agents, settings, globals: { refreshWorkerCatalog: async () => catalogue, memberWorkerModels: () => [own, 'google/test-g'] } });
  assert.equal((await L3.ctx.reviewer('sam-agent')).model, 'google/test-g');
});

test('strict keptOnBox: a team folder, the keep list, a missing agent, a throwing settings read or a throwing policy lookup all count as kept', () => {
  const rec = (name, over = {}) => ({ name, ...over });
  const L = load({ agents: [rec('a'), rec('b')], settings: { autoClassifier: { keepOnBox: ['b'] } } });
  assert.equal(L.ctx.keptOnBox(rec('a')), false);
  assert.equal(L.ctx.keptOnBox(rec('b')), true);
  assert.equal(L.ctx.keptOnBox(null), true);
  assert.equal(L.ctx.keptOnBox('nobody'), true);
  // a team-folder agent (medical/legal), whatever the list says
  const tp = require(path.join(ISO.inst, 'lib', 'tool-policy.js'));
  const team = rec('t', { policy: { roots: [path.join(tp.HUB_HOME, tp.TEAM_FOLDERS[0])] } });
  assert.equal(load({ agents: [team] }).ctx.keptOnBox(team), true);
  // the classifier setting cannot be read: kept (the old shared helper said "not kept" here)
  const thrower = load({ agents: [rec('a')], extraMods: { './settings': { getSetting: () => { throw new Error('settings broken'); } } } });
  assert.equal(thrower.ctx.keptOnBox(rec('a')), true);
  const noPolicy = load({ agents: [rec('a')], extraMods: { './tool-policy': { teamFolderOf: () => { throw new Error('x'); } } } });
  assert.equal(noPolicy.ctx.keptOnBox(rec('a')), true);
  // the runner is given this strict check, not voice/cloud's
  assert.doesNotMatch(SRC.slice(SRC.indexOf('function researchKeptOnBox'), SRC.indexOf('function researchKeptOnBox') + 900), /voice\/cloud/);
});

test('thorough settings are read from researchThorough and checked; the document goes to <Files>/research with -2, -3 for a used name', async () => {
  const L = load({ settings: { researchThorough: { maxSources: '5', readersAtOnce: 99, pdf: 'false', readerModel: 'helper' } } });
  assert.deepEqual(JSON.parse(JSON.stringify(L.ctx.settingsNow())), { maxSources: 5, readersAtOnce: 4, reviewRounds: 2, timeLimitMinutes: 60, pdf: false, readerModel: 'helper', engine: 'lead', leadSteps: 60, leadWallMinutes: 360, leadReaderCalls: 100, leadReviewRounds: 10, leadTopicSearches: 3, leadSourcesPerSub: 2, leadTopNewPerSub: 2, leadPdfMaxMB: 32, leadReaderTextMax: 120000, leadReaderTopTextMax: 400000, leadModel: 'auto', leadReaderModel: 'auto', leadReaderTopModel: 'auto' });
  assert.equal(load().ctx.settingsNow().timeLimitMinutes, 60);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-files-'));
  const thorough = require(path.join(ISO.inst, 'lib', 'research-thorough.js'));
  const pdfCalls = [];
  const T = { ...thorough, findPdfRenderer: () => '/fake/chrome', renderPdf: async (o) => { pdfCalls.push(o); fs.writeFileSync(o.pdfPath, 'PDF'); return { ok: true, error: '' }; } };
  const W = load({ settings: { researchThorough: { pdf: true } }, extraMods: { './research-thorough': T, os }, globals: { filesRootFor: async () => root, process } });
  const doc = { markdown: '# Title\n\nBody', html: '<html>Body</html>' };
  const a = await W.ctx.writeDoc('sam-agent', 'deep-research-2026-11-21-q', doc);
  assert.equal(a.md, path.join(root, 'research', 'deep-research-2026-11-21-q.md'));
  assert.equal(a.html, path.join(root, 'research', 'deep-research-2026-11-21-q.html'));
  assert.equal(a.pdf, path.join(root, 'research', 'deep-research-2026-11-21-q.pdf'));
  assert.equal(fs.readFileSync(a.md, 'utf8'), '# Title\n\nBody');
  assert.equal(pdfCalls[0].binary, '/fake/chrome');
  const b = await W.ctx.writeDoc('sam-agent', 'deep-research-2026-11-21-q', doc);
  assert.equal(path.basename(b.md), 'deep-research-2026-11-21-q-2.md');
  const c = await W.ctx.writeDoc('sam-agent', 'deep-research-2026-11-21-q', doc);
  assert.equal(path.basename(c.html), 'deep-research-2026-11-21-q-3.html');
  assert.equal(fs.readFileSync(a.md, 'utf8'), '# Title\n\nBody', 'the first file is never overwritten');
  // no Chrome: Markdown and HTML only, with the reason
  const N = load({ settings: { researchThorough: { pdf: true } }, extraMods: { './research-thorough': { ...thorough, findPdfRenderer: () => null }, os }, globals: { filesRootFor: async () => root, process } });
  const n = await N.ctx.writeDoc('sam-agent', 'deep-research-2026-11-21-nochrome', doc);
  assert.equal(n.pdf, '');
  assert.equal(n.pdfError, 'no Chrome or Chromium on this computer; the document is in Markdown and HTML');
  assert.ok(fs.existsSync(n.md) && fs.existsSync(n.html));
  // a renderer that fails: the reason is kept
  const F = load({ settings: { researchThorough: { pdf: true } }, extraMods: { './research-thorough': { ...thorough, findPdfRenderer: () => '/fake/chrome', renderPdf: async () => ({ ok: false, error: 'the PDF renderer failed: boom' }) }, os }, globals: { filesRootFor: async () => root, process } });
  const f = await F.ctx.writeDoc('sam-agent', 'deep-research-2026-11-21-fail', doc);
  assert.equal(f.pdf, '');
  assert.equal(f.pdfError, 'the PDF renderer failed: boom');
  // pdf off in Settings: no renderer asked
  const O = load({ settings: { researchThorough: { pdf: false } }, extraMods: { './research-thorough': { ...thorough, findPdfRenderer: () => { throw new Error('must not be asked'); } }, os }, globals: { filesRootFor: async () => root, process } });
  const o = await O.ctx.writeDoc('sam-agent', 'deep-research-2026-11-21-off', doc);
  assert.equal(o.pdf, '');
  assert.match(o.pdfError, /switched off/);
});
