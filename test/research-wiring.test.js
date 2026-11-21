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
  assert.match(SRC, /const personKey = turnOrigin\.kind === 'user' \? \(trustedUserId \? String\(trustedUserId\)\.slice\(0, 64\) : \(trustedAccounts === false \? 'owner' : null\)\) : null;/);
  assert.match(SRC, /wake: \(agent, message\) => wakeAgent\(agent, message, null, \{ kind: 'research_report', from: 'hub' \}\)/);
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
