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

function load({ on = true, virtual = false, handOff = null, agents = [], hasUsers = true, admins = [{ id: 'u_owner', createdAt: '2026-01-01' }], reminderDays, askAnswer = 'Yes', model = 'claude-sdk/claude-test-big' } = {}) {
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
    './settings': { getSetting: (k) => (k === 'researchReminderDays' ? reminderDays : undefined) },
    './agents': { getAgentsSync: () => agents },
  };
  const ctx = vm.createContext({
    require: (m) => { if (!(m in mods)) throw new Error('unexpected require ' + m); return mods[m]; },
    temporalWorkers: { isVirtual: () => virtual, noteFor: () => '' },
    handOffOfTurn: () => handOff,
    hubAuthMod: { getAuth: () => ({ hasUsers: () => hasUsers, admins: () => admins }) },
    path, fs, console, Promise,
    researchLib: research,
    researchPrefsLib: { getResearchPrefs: () => prefs, CHOICES: prefsLib.CHOICES },
    turnRegistry,
    getAgentModel: async () => model,
    runAskUser: async (agent, res, card) => { asked.push(card); return askAnswer; },
    runSpawnWorkers: async () => 'x', wakeAgent: async () => {}, refreshWorkerCatalog: async () => ({ available: [] }), memberWorkerModels: () => null,
  });
  vm.runInContext(SRC.slice(a, b) + `
this.offered = deepResearchOffered; this.run = runDeepResearch; this.guidance = researchGuidanceFor; this.personOf = researchPersonOf; this.remindMs = researchReminderMs;
this.setRunner = (r) => { _researchRunner = r; };`, ctx);
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
  assert.deepEqual(L.asked[0].options, ['Yes', 'No', 'Always yes', 'Never']);
  assert.match(L.asked[0].question, /Claude sign-in plan allowance/);
  assert.match(out, /^The person wants a deep research run \(and from now on without being asked\)/);
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
  assert.deepEqual(JSON.parse(JSON.stringify(L.started)), [{ agent: 'sam-agent', question: 'Q?', subQuestions: subs }]);
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
  assert.match(SRC, /const personKey = turnOrigin\.kind === 'user' \? \(trustedAccounts === false \? 'owner' : \(trustedUserId \? String\(trustedUserId\)\.slice\(0, 64\) : null\)\) : null;/);   // review r2: no accounts (also the older single password) -> 'owner'
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
  assert.match(SRC, /spawn: \(agent, workers, signal\) => runSpawnWorkers\(agent, workers, null, signal \|\| null, null, \{ detached: true, raw: true \}\)/);
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
  assert.match(await a, /wants a deep research run/);
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
