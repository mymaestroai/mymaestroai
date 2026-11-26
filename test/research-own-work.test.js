'use strict';
// Deep research for an agent's own work never waits on the person (change 'research-own-work'): the offer's "for" and "reason",
// the quick grant the hub gives without a card, the card's wait and the quick run after no answer, the daily caps, stop and
// make-it-thorough, the report's first line, the status fields, the routes' access, the settings and the tool's shape.
// The deep_research handler runs against stand-ins (the real lib/research, lib/research-prefs and its run store); no network,
// no real model, no real client.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { makeIsolatedInstall } = require('./helpers/isolated-install');

const ISO = makeIsolatedInstall('research-own-work-');
const research = require(path.join(ISO.inst, 'lib', 'research.js'));
const prefsLib = require(path.join(ISO.inst, 'lib', 'research-prefs.js'));
const thoroughLib = require(path.join(ISO.inst, 'lib', 'research-thorough.js'));
const REAL = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(REAL, 'lib', 'sdk-chat.js'), 'utf8');
const SERVER = fs.readFileSync(path.join(REAL, 'server.js'), 'utf8');
const tick = () => new Promise((r) => setImmediate(r));
async function until(fn, n = 300) { for (let i = 0; i < n; i++) { if (fn()) return; await tick(); } throw new Error('condition not reached'); }
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'row-'));

const SUBS = ['one', 'two'];
const CAP_TEXT = 'The daily limit for research started by agents is reached; go on without it and say so in your report.';
const GRANT = /^Go ahead at the quick level: plan 2 to 8 sub-questions that together answer it, then call deep_research with action "start", the same question, sub_questions and level "quick"\. It runs in the background and its report comes back to you here; carry on with your work meanwhile\.$/;

// ── the handler on stand-ins ──
function load({ ons = ['deep-research', 'research-own-work'], settings = {}, agents = [], askAnswer = 'Yes', model = 'claude-sdk/claude-test-big', startOk = true, pushBreaks = '', modelFn = null, realAsk = null, runnerExtra = null } = {}) {
  const a = SRC.indexOf('// ── Deep research (lib/research');
  const b = SRC.indexOf('// behaviour_change: offered by the same rule');
  assert.ok(a > 0 && b > a, 'the deep research block is there');
  let t = 10_000_000;
  let clock = new Date(2026, 10, 25, 12, 0, 0).getTime();
  const dir = tmpDir();
  const prefs = prefsLib.createResearchPrefs({ file: path.join(dir, 'research-prefs.json'), now: () => t });
  const store = research.createRunStore({ file: path.join(dir, 'research-runs.json'), now: () => clock });
  const asked = [];
  const started = [];
  const pushes = [];
  const turnRegistry = new Map();
  const live = { ...settings };
  const mods = {
    './behaviour-changes': { isOn: (id) => ons.includes(id) },
    './settings': { getSetting: (k) => live[k] },
    './agents': { getAgentsSync: () => agents },
    './tool-policy': require(path.join(ISO.inst, 'lib', 'tool-policy.js')),
    './research-thorough': thoroughLib,
    './push': { getPush: () => {
      if (pushBreaks === 'getPush') throw new Error('push is down');
      return {
        notify: (p, o) => { if (pushBreaks === 'notify') throw new Error('boom'); if (pushBreaks === 'rejects') return Promise.reject(new Error('rejected')); pushes.push({ via: 'notify', p, o }); return Promise.resolve({ sent: 1 }); },
        notifyUsers: (p, ids, o) => { pushes.push({ via: 'notifyUsers', p, ids, o }); return Promise.resolve({ sent: 1 }); },
      };
    } },
  };
  const ctx = vm.createContext({
    require: (m) => { if (!(m in mods)) throw new Error('unexpected require ' + m); return mods[m]; },
    temporalWorkers: { isVirtual: () => false, noteFor: () => '' },
    handOffOfTurn: () => null,
    hubAuthMod: { getAuth: () => ({ hasUsers: () => true, admins: () => [{ id: 'u_owner', createdAt: '2026-01-01' }] }) },
    adminIdSet: () => new Set(['u_owner']),
    path, fs, console, Promise,
    researchLib: research,
    researchPrefsLib: { getResearchPrefs: () => prefs, CHOICES: prefsLib.CHOICES, LEVELS: prefsLib.LEVELS },
    turnRegistry,
    getAgentModel: modelFn || (async () => model),
    // 'TIMEOUT' stands for the wait's own timer ending the card (the real runAskUser then calls opts.onTimeout); a typed NO_ANSWER does not
    runAskUser: realAsk ? async (agent, res, card, opts) => { asked.push({ card, opts }); return realAsk(agent, res, card, opts); } : async (agent, res, card, opts) => {
      asked.push({ card, opts });
      const v = typeof askAnswer === 'function' ? askAnswer() : askAnswer;
      if (v === 'TIMEOUT') { if (opts && typeof opts.onTimeout === 'function') opts.onTimeout(); return 'NO_ANSWER'; }
      return v;
    },
    runSpawnWorkers: async () => 'x', wakeAgent: async () => {}, refreshWorkerCatalog: async () => ({ available: [] }), memberWorkerModels: () => null,
  });
  vm.runInContext(SRC.slice(a, b) + `
this.run = runDeepResearch; this.guidance = researchGuidanceFor; this.setRunner = (r) => { _researchRunner = r; }; this.statusFor = researchStatusFor; this.capsToday = researchCapsToday;
this.waitSeconds = researchOfferWaitSeconds; this.agentCaps = researchAgentCaps; this.onProgress = researchOnProgress; this.view = researchRunView; this.stopRun = researchStop; this.upgradeRun = researchUpgrade; this.runAgent = researchRunAgent;`, ctx);
  let n = 0;
  ctx.setRunner({
    start: (x) => { if (!startOk) return { ok: false, error: 'engine said no' }; started.push(x); n += 1; return { ok: true, id: 'dr-0000000' + n }; },
    recover() {},
    isCurrentAgent: () => true,
    agentStartsToday: () => store.agentStartsToday(),
    countAgentStart: (g) => store.countAgentStart(g),
    uncountAgentStart: (g, d) => store.uncountAgentStart(g, d),
    ...(runnerExtra || {}),
  });
  const liveRes = { on() {}, writableEnded: false };
  const turn = (agent, over = {}) => { const tr = { origin: { kind: 'user' }, personKey: 'u_sam', ...over }; turnRegistry.set(agent, tr); return tr; };
  const hubTurn = (agent) => turn(agent, { origin: { kind: 'schedule' }, personKey: null });
  const call = (agent, args) => ctx.run(agent, liveRes, args);
  return { ctx, prefs, store, file: path.join(dir, 'research-runs.json'), asked, started, pushes, turn, hubTurn, call, settings: live, setAnswer: (v) => { askAnswer = v; }, nextDay: () => { clock += 24 * 3600 * 1000; } };
}
const ownWork = (L, over = {}) => L.call('sam-agent', { action: 'offer', question: 'Which judge is best?', for: 'own_work', reason: 'My report needs a current comparison.', ...over });
const startQ = (L, over = {}) => L.call('sam-agent', { action: 'start', question: 'Which judge is best?', sub_questions: SUBS, ...over });

// ── own work: never a card ──
test('own_work: never asks the person, in a typed turn and in a hub-started turn; the grant is quick and says carry on', async () => {
  const L = load();
  L.turn('sam-agent');
  assert.match(await ownWork(L), GRANT);
  L.hubTurn('sam-agent');
  assert.match(await ownWork(L), GRANT);
  assert.equal(L.asked.length, 0, 'no card in either turn');
});

test('own_work: a hub-started turn can offer, then start; the run is the agent\'s (startedBy agent, with the reason), counted, and the owner is told by push', async () => {
  const L = load();
  L.hubTurn('sam-agent');
  assert.match(await ownWork(L), GRANT);
  assert.match(await startQ(L), /^Started \(id dr-00000001\)\. The research runs in the background; its report will come back to you here/);
  assert.equal(L.started.length, 1);
  const s = L.started[0];
  assert.equal(s.startedBy, 'agent');
  assert.equal(s.level, 'quick');
  assert.equal(s.reason, 'My report needs a current comparison.');
  assert.equal(s.waitSeconds, null);
  const caps = L.ctx.capsToday();
  assert.equal(caps.today.install, 1);
  assert.equal(caps.today.agents['sam-agent'], 1);
  // the household agent's owner devices: admins' devices, kind other, the agent named; the question in one line
  assert.equal(L.pushes.length, 1);
  assert.equal(L.pushes[0].via, 'notify');
  assert.equal(L.pushes[0].p.title, 'Sam-agent started quick research');
  assert.equal(L.pushes[0].p.body, 'Which judge is best?');
  assert.deepEqual(JSON.parse(JSON.stringify(L.pushes[0].o)), { adminsOnly: true, kind: 'other', agent: 'sam-agent' });
  // the approval was used once
  assert.match(await startQ(L), /^Ask first/);
});

test('push on an auto start: a member\'s agent notifies that member\'s devices only; a push that throws never stops the run', async () => {
  const L = load({ agents: [{ name: 'sam-agent', display: 'Sammy', owner: 'u_member' }] });
  L.hubTurn('sam-agent');
  await ownWork(L);
  assert.match(await startQ(L), /^Started/);
  assert.equal(L.pushes[0].via, 'notifyUsers');
  assert.deepEqual(JSON.parse(JSON.stringify(L.pushes[0].ids)), ['u_member']);
  assert.equal(L.pushes[0].p.title, 'Sammy started quick research');
  assert.equal(L.started[0].agentLabel, 'Sammy');
  for (const how of ['getPush', 'notify', 'rejects']) {
    const T = load({ pushBreaks: how });
    T.hubTurn('sam-agent');
    await ownWork(T);
    assert.match(await startQ(T), /^Started/, 'a push that ' + how + ' does not stop the run');
    assert.equal(T.started.length, 1);
    assert.equal(T.ctx.capsToday().today.install, 1);
    await tick();
  }
});

test('a person offer in a hub-started turn (pref ask) behaves like own_work: no card, a quick grant, startedBy agent, the reason says so', async () => {
  const L = load();
  L.hubTurn('sam-agent');
  assert.match(await L.call('sam-agent', { action: 'offer', question: 'Q?' }), GRANT);
  assert.equal(L.asked.length, 0);
  assert.match(await L.call('sam-agent', { action: 'start', question: 'Q?', sub_questions: SUBS }), /^Started/);
  assert.equal(L.started[0].startedBy, 'agent');
  assert.equal(L.started[0].reason, 'asked in a turn the person did not start: no reason given');
  L.hubTurn('sam-agent');
  await L.call('sam-agent', { action: 'offer', question: 'Q2?', reason: 'The nightly digest needs it.' });
  await L.call('sam-agent', { action: 'start', question: 'Q2?', sub_questions: SUBS });
  assert.equal(L.started[1].reason, 'asked in a turn the person did not start: The nightly digest needs it.');
  // the person's stored choice still decides: always runs as always did (not counted, startedBy person); never gives the never text
  const A = load();
  A.prefs.setChoice('u_owner', 'always');
  A.hubTurn('sam-agent');
  assert.match(await A.call('sam-agent', { action: 'offer', question: 'Q?' }), /they chose always/);
  const N = load();
  N.prefs.setChoice('u_owner', 'never');
  N.hubTurn('sam-agent');
  assert.match(await N.call('sam-agent', { action: 'offer', question: 'Q?' }), /chose never to be asked/);
});

test('own_work needs a reason of 1 to 300 characters', async () => {
  const L = load();
  L.turn('sam-agent');
  for (const reason of [undefined, '', '   ', 'x'.repeat(301), 5]) {
    assert.equal(await ownWork(L, { reason }), 'Give a one-sentence reason: why your work needs this research.', String(reason).slice(0, 10));
  }
  assert.match(await ownWork(L, { reason: 'x'.repeat(300) }), GRANT);
  assert.equal(L.asked.length, 0);
});

test('pref never: own_work gets the off text, no card, no run', async () => {
  const L = load();
  L.prefs.setChoice('u_sam', 'never');
  L.turn('sam-agent');
  assert.equal(await ownWork(L), research.RESEARCH_OFF);
  assert.equal(L.asked.length, 0);
  assert.match(await startQ(L), /^Ask first/);
  assert.equal(L.started.length, 0);
  // a hub-started turn: the agent's person (here the install's owner) counts
  const H = load();
  H.prefs.setChoice('u_owner', 'never');
  H.hubTurn('sam-agent');
  assert.equal(await ownWork(H), research.RESEARCH_OFF);
  assert.equal(H.ctx.capsToday().today.install, 0);
});

test('a thorough start after an auto grant is refused (own work, no answer and a hub turn), even when the person chose always + thorough', async () => {
  const REFUSED = 'Thorough runs only on the person\'s own choice; start with level "quick".';
  const L = load();
  L.turn('sam-agent');
  await ownWork(L);
  assert.equal(await startQ(L, { level: 'thorough' }), REFUSED);
  assert.equal(L.started.length, 0);
  assert.match(await startQ(L, { level: 'quick' }), /^Started/, 'the grant still stands for quick');
  const A = load();
  A.prefs.setChoice('u_sam', 'always'); A.prefs.setAlwaysLevel('u_sam', 'thorough');
  A.turn('sam-agent');
  await ownWork(A);
  assert.equal(await startQ(A, { level: 'thorough' }), REFUSED);
  const N = load({ askAnswer: 'TIMEOUT' });
  N.turn('sam-agent');
  await N.call('sam-agent', { action: 'offer', question: 'Which judge is best?' });
  assert.equal(await startQ(N, { level: 'thorough' }), REFUSED);
});

// ── a person's offer: the wait, then a quick run ──
test('person offer, no answer within the wait: the no-answer text, then a quick start (startedBy no-answer, counted); the card asks within the setting', async () => {
  const L = load({ askAnswer: 'TIMEOUT' });
  L.turn('sam-agent');
  const out = await L.call('sam-agent', { action: 'offer', question: 'Which judge is best?' });
  assert.equal(out, 'No answer came within 2 minutes: start a quick run. Plan 2 to 8 sub-questions that together answer it, then call deep_research with action "start", the same question, sub_questions and level "quick". Tell the person in one line that a quick run has started because nobody answered, then carry on.');
  assert.equal(L.asked.length, 1);
  assert.equal(L.asked[0].opts.timeoutMs, 120000);
  assert.match(await startQ(L), /^Started \(id dr-00000001\)\. The research runs in the background; its report will come to this chat/);
  assert.equal(L.started[0].startedBy, 'no-answer');
  assert.equal(L.started[0].waitSeconds, 120);
  assert.equal(L.started[0].level, 'quick');
  assert.equal(L.ctx.capsToday().today.install, 1);
  assert.equal(L.pushes.length, 1);
});

test('the card says who asks and the question in one line (up to 140 characters); the header and options are as before', async () => {
  const L = load({ askAnswer: 'No' });
  L.turn('sam-agent');
  const long = 'Which judge is best?\n' + 'x'.repeat(300);
  await L.call('sam-agent', { action: 'offer', question: long });
  const c = L.asked[0].card;
  assert.equal(c.header, 'Deep research');
  assert.match(c.question, /^Sam-agent asks: research this\? “Which judge is best\? x+…” This looks like a research question\. Research it\? Quick takes a few minutes;/);
  assert.ok(!c.question.split('”')[0].includes('\n'), 'one line');
  assert.equal(c.question.split('“')[1].split('”')[0].length, 140);
  assert.match(c.question, /Claude sign-in plan allowance/);
  assert.deepEqual(c.options, ['Yes, quick', 'Yes, thorough', 'No', 'Always yes', 'Never']);
});

test('wait 0: no card at all, the quick run at once', async () => {
  const L = load({ settings: { researchOfferWaitSeconds: 0 } });
  L.turn('sam-agent');
  const out = await L.call('sam-agent', { action: 'offer', question: 'Which judge is best?' });
  assert.equal(L.asked.length, 0);
  // a wait of 0 asks nobody, so it never says "nobody answered" (the report and the notice say the same)
  assert.match(out, /^Research questions start at the quick level without asking here \(the wait for an answer is set to 0\): start a quick run\./);
  assert.doesNotMatch(out, /No answer came/);
  const R = require('../lib/research');
  const msg = R.reportMessage({ id: 'dr-0', question: 'Q?', report: 'The report.', level: 'quick', startedBy: 'no-answer', waitSeconds: 0 });
  assert.match(msg, /Report:\nThis was done as a quick run without asking, because the wait for an answer is set to 0 in Settings\./);
  assert.doesNotMatch(msg, /within 0 seconds/);
  assert.match(await startQ(L), /^Started/);
  assert.equal(L.started[0].startedBy, 'no-answer');
  // with the change off: still no card, and the old no-answer text
  const O = load({ ons: ['deep-research'], settings: { researchOfferWaitSeconds: 0 } });
  O.turn('sam-agent');
  assert.equal(await O.call('sam-agent', { action: 'offer', question: 'Q?' }), research.WAIT_ZERO_OFF);
  assert.equal(O.asked.length, 0);
});

test('a typed non-answer, a Skip and an explicit No never start a run', async () => {
  const T = load({ askAnswer: 'maybe later' });
  T.turn('sam-agent');
  assert.match(await T.call('sam-agent', { action: 'offer', question: 'Q?' }), /^The person typed "maybe later" instead of choosing\. That is not a yes/);
  assert.match(await T.call('sam-agent', { action: 'start', question: 'Q?', sub_questions: SUBS }), /^Ask first/);
  const S = load({ askAnswer: 'SKIPPED' });
  S.turn('sam-agent');
  assert.equal(await S.call('sam-agent', { action: 'offer', question: 'Q?' }), 'No answer came. Answer normally, and offer a deep research run in one line at the end.');
  assert.match(await S.call('sam-agent', { action: 'start', question: 'Q?', sub_questions: SUBS }), /^Ask first/);
  const N = load({ askAnswer: 'No' });
  N.turn('sam-agent');
  assert.equal(await N.call('sam-agent', { action: 'offer', question: 'Q?' }), 'The person said no to deep research this time. Answer normally now.');
  assert.match(await N.call('sam-agent', { action: 'start', question: 'Q?', sub_questions: SUBS }), /^Ask first/);
  assert.equal(T.started.length + S.started.length + N.started.length, 0);
  assert.equal(N.ctx.capsToday().today.install, 0);
});

test('Yes (quick, thorough or always): a run the person approved is not counted and is startedBy person', async () => {
  const L = load({ askAnswer: 'Yes, quick' });
  L.turn('sam-agent');
  await L.call('sam-agent', { action: 'offer', question: 'Q?' });
  assert.match(await L.call('sam-agent', { action: 'start', question: 'Q?', sub_questions: SUBS }), /^Started/);
  L.setAnswer('Yes, thorough');
  L.turn('sam-agent');
  await L.call('sam-agent', { action: 'offer', question: 'Q2?' });
  assert.match(await L.call('sam-agent', { action: 'start', question: 'Q2?', sub_questions: SUBS, level: 'thorough' }), /^Started/);
  L.prefs.setChoice('u_sam', 'always');
  L.turn('sam-agent');
  assert.match(await L.call('sam-agent', { action: 'start', question: 'Q3?', sub_questions: SUBS }), /^Started/);
  assert.deepEqual(L.started.map((x) => [x.startedBy, x.level]), [['person', 'quick'], ['person', 'thorough'], ['person', 'quick']]);
  assert.equal(L.started[0].reason, '');
  assert.equal(L.started[0].personKey, 'u_sam');
  assert.deepEqual(JSON.parse(JSON.stringify(L.ctx.capsToday().today)), { install: 0, agents: {} });
  assert.equal(L.pushes.length, 0, 'no notice for a run the person chose');
});

// ── caps ──
test('caps: per agent and for the install, 0 = unlimited, the over-cap text (at offer and again at start); defaults 3 and 10', async () => {
  const L = load();
  assert.deepEqual(JSON.parse(JSON.stringify(L.ctx.agentCaps())), { perAgent: 3, install: 10 });
  L.settings.researchAgentCaps = { perAgent: 2, install: 3 };
  for (let i = 0; i < 2; i++) {
    L.hubTurn('sam-agent');
    assert.match(await ownWork(L, { question: 'Q' + i }), GRANT);
    assert.match(await L.call('sam-agent', { action: 'start', question: 'Q' + i, sub_questions: SUBS }), /^Started/);
  }
  L.hubTurn('sam-agent');
  assert.equal(await ownWork(L, { question: 'Q3' }), CAP_TEXT, 'per agent: the third is over');
  assert.match(await L.call('sam-agent', { action: 'start', question: 'Q3', sub_questions: SUBS }), /^Ask first/, 'and no grant was given');
  // another agent is under its own cap until the install's is reached
  L.hubTurn('ann-agent');
  assert.match(await L.call('ann-agent', { action: 'offer', question: 'A', for: 'own_work', reason: 'r' }), GRANT);
  assert.match(await L.call('ann-agent', { action: 'start', question: 'A', sub_questions: SUBS }), /^Started/);
  L.hubTurn('bob-agent');
  assert.equal(await L.call('bob-agent', { action: 'offer', question: 'B', for: 'own_work', reason: 'r' }), CAP_TEXT, 'the install is at 3');
  assert.deepEqual(JSON.parse(JSON.stringify(L.ctx.capsToday())), { caps: { perAgent: 2, install: 3 }, today: { install: 3, agents: { 'sam-agent': 2, 'ann-agent': 1 } } });
  // a person's no-answer run is counted and capped the same way
  const N = load({ askAnswer: 'TIMEOUT', settings: { researchAgentCaps: { perAgent: 1, install: 5 } } });
  N.turn('sam-agent');
  await N.call('sam-agent', { action: 'offer', question: 'Q?' });
  await N.call('sam-agent', { action: 'start', question: 'Q?', sub_questions: SUBS });
  N.turn('sam-agent');
  assert.equal(await N.call('sam-agent', { action: 'offer', question: 'Q again?' }), CAP_TEXT);
  // 0 = unlimited, for either limit
  const U = load({ settings: { researchAgentCaps: { perAgent: 0, install: 0 } } });
  for (let i = 0; i < 12; i++) {
    U.hubTurn('sam-agent');
    assert.match(await ownWork(U, { question: 'Q' + i }), GRANT);
    assert.match(await U.call('sam-agent', { action: 'start', question: 'Q' + i, sub_questions: SUBS }), /^Started/);
  }
  assert.equal(U.ctx.capsToday().today.install, 12);
});

test('caps: checked again at start; a cap reached between the offer and the start refuses it, and the count is per calendar day (yesterday is forgotten)', async () => {
  const L = load({ settings: { researchAgentCaps: { perAgent: 1, install: 10 } } });
  L.hubTurn('sam-agent');
  assert.match(await ownWork(L), GRANT);
  L.store.countAgentStart('sam-agent');   // another turn of the same agent started one meanwhile
  assert.equal(await startQ(L), CAP_TEXT);
  assert.equal(L.started.length, 0);
  L.nextDay();
  L.hubTurn('sam-agent');
  assert.match(await ownWork(L), GRANT, 'a new day, a new count');
  assert.equal(L.ctx.capsToday().today.install, 0);
});

test('the run store: the count keeps today and yesterday only, beside the runs, and a runs save keeps it', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'research-runs.json');
  let now = new Date(2026, 10, 25, 23, 0, 0).getTime();
  const s = research.createRunStore({ file, now: () => now });
  assert.deepEqual(s.load(), []);
  s.save([{ id: 'dr-1', agent: 'a', subQuestions: ['x', 'y'] }]);
  assert.deepEqual(s.agentStartsToday(), { date: '2026-11-25', install: 0, agents: {} });
  s.countAgentStart('a'); s.countAgentStart('a'); s.countAgentStart('b');
  s.save([{ id: 'dr-1', agent: 'a', subQuestions: ['x', 'y'] }, { id: 'dr-2', agent: 'b', subQuestions: ['x', 'y'] }]);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.runs.length, 2, 'the runs');
  assert.deepEqual(saved.agentStarts, { '2026-11-25': { install: 3, agents: { a: 2, b: 1 } } });
  now = new Date(2026, 10, 26, 1, 0, 0).getTime();   // after midnight: yesterday is still kept, today starts at 0
  assert.deepEqual(s.agentStartsToday(), { date: '2026-11-26', install: 0, agents: {} });
  s.countAgentStart('a');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).agentStarts).sort(), ['2026-11-25', '2026-11-26']);
  now = new Date(2026, 10, 28, 1, 0, 0).getTime();   // two days on: both old days dropped
  s.countAgentStart('c');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).agentStarts, { '2026-11-28': { install: 1, agents: { c: 1 } } });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).runs.length, 2, 'the runs survive a count');
  // a second store on the same file (a restart) sees the count
  assert.equal(research.createRunStore({ file, now: () => now }).agentStartsToday().install, 1);
});

// ── the change is off ──
test('research-own-work off: own_work gets the off text; a person offer with no answer gets the old text; a hub turn the old no-one-to-ask text; the wait still applies', async () => {
  const L = load({ ons: ['deep-research'], askAnswer: 'TIMEOUT', settings: { researchOfferWaitSeconds: 45 } });
  L.turn('sam-agent');
  assert.equal(await ownWork(L), research.OWN_WORK_OFF);
  assert.equal(L.asked.length, 0);
  assert.equal(await L.call('sam-agent', { action: 'offer', question: 'Q?' }), 'No answer came. Answer normally, and offer a deep research run in one line at the end.');
  assert.equal(L.asked[0].opts.timeoutMs, 45000, 'the card\'s wait setting still applies');
  assert.match(await L.call('sam-agent', { action: 'start', question: 'Q?', sub_questions: SUBS }), /^Ask first/);
  L.hubTurn('sam-agent');
  assert.match(await L.call('sam-agent', { action: 'offer', question: 'Q?' }), /^No one can be asked right now/);
  assert.equal(L.started.length, 0);
  assert.equal(L.ctx.capsToday().today.install, 0);
});

test('the card\'s wait is the setting (default 120 s, 30 s, 1 minute, 10 minutes); every other card keeps 10 minutes', async () => {
  for (const [secs, ms, phrase] of [[undefined, 120000, '2 minutes'], [30, 30000, '30 seconds'], [60, 60000, '1 minute'], [600, 600000, '10 minutes'], ['junk', 120000, '2 minutes'], [601, 120000, '2 minutes']]) {
    const L = load({ askAnswer: 'TIMEOUT', settings: secs === undefined ? {} : { researchOfferWaitSeconds: secs } });
    L.turn('sam-agent');
    const out = await L.call('sam-agent', { action: 'offer', question: 'Q?' });
    assert.equal(L.asked[0].opts.timeoutMs, ms, String(secs));
    assert.ok(out.startsWith(`No answer came within ${phrase}: start a quick run.`), out.slice(0, 60));
  }
  assert.equal(research.waitPhrase(90), '90 seconds');
  assert.equal(research.waitPhrase(1), '1 second');
  assert.equal(research.waitPhrase(180), '3 minutes');
  // other cards: the default of runAskUser is still ten minutes; only the research card passes its own
  assert.match(SRC, /const ASK_USER_TIMEOUT_MS = 10 \* 60 \* 1000;/);
  assert.match(SRC, /async function runAskUser\(agentName, sseRes, args, \{ consultationDepth = 0, signal = null, timeoutMs = ASK_USER_TIMEOUT_MS,/);
  assert.equal((SRC.match(/timeoutMs: waitSeconds \* 1000/g) || []).length, 1, 'only the research card sets a wait');
});

// ── stop and make it thorough (the runner) ──
const hang = (record) => (agent, workers, signal) => new Promise((_, rej) => { if (record) record.push(workers.map((w) => w.label)); signal.addEventListener('abort', () => rej(new Error('stopped')), { once: true }); });
function makeRunner(over = {}) {
  const wakes = [];
  const spawns = [];
  const runner = research.createResearchRunner({
    spawn: hang(spawns),
    wake: async (agent, message) => { wakes.push({ agent, message }); },
    pickHelperModel: async () => 'claude-sdk/claude-test-fast', ownModelOf: async () => 'claude-sdk/claude-test-big', keptOnBox: () => false,
    sleep: async () => {}, log: () => {},
    thoroughSettings: () => ({ engine: 'pipeline', maxSources: 12, readersAtOnce: 2, reviewRounds: 2, timeLimitMinutes: 60, pdf: false, readerModel: 'own' }),
    pickReviewer: async () => ({ model: 'x/y', label: 'another', crossVendor: true }), pickReaderModel: async () => 'claude-sdk/claude-test-big',
    ...over,
  });
  return { runner, wakes, spawns };
}
const startAuto = (runner, over = {}) => runner.start({ agent: 'sam-agent', question: 'Which judge is best?', subQuestions: SUBS, level: 'quick', startedBy: 'agent', reason: 'My report needs it.', costLine: 'Uses your plan allowance: several times a normal answer.', agentLabel: 'Sam', ...over });

test('stop: the run ends, nothing partial is delivered, the agent is woken once with the stopped text, status shows it stopped and not active', async () => {
  const { runner, wakes } = makeRunner();
  const r = startAuto(runner);
  assert.equal(r.ok, true);
  await tick();
  const out = runner.stop(r.id, { by: 'u_sam' });
  assert.equal(out.ok, true);
  assert.equal(out.run.state, 'stopped');
  const got = runner.get(r.id);
  assert.equal(got.state, 'stopped');
  assert.equal(got.stoppedBy, 'u_sam');
  assert.ok(got.endedAt);
  await until(() => wakes.length >= 1);
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(wakes.length, 1, 'once: no report, no second message');
  assert.equal(wakes[0].agent, 'sam-agent');
  assert.equal(wakes[0].message, `[Deep research stopped] "Which judge is best?" (${r.id}): the person stopped this run. Do not start it again unless they ask; carry on without it.`);
  assert.equal(runner.get(r.id).state, 'stopped', 'the aborted run did not turn into a failed or delivered one');
  assert.equal(runner.list().filter((x) => x.state === 'running' || x.state === 'delivering').length, 0);
  // the agent can start again (the one-active rule is freed at once)
  assert.equal(startAuto(runner, { question: 'Another?' }).ok, true);
  // not twice, not for an unknown id
  assert.equal(runner.stop(r.id).status, 409);
  assert.equal(runner.stop('dr-ffffffff').status, 404);
});

test('stop: a run whose report is already being delivered is not stopped', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const { runner } = makeRunner({ spawn: async (a, w) => (w[0].label === 'Research summary' ? 'REPORT' : 'FINDINGS'), wake: async () => { await gate; } });
  const r = startAuto(runner);
  await until(() => runner.get(r.id).state === 'delivering');
  const s = runner.stop(r.id);
  assert.equal(s.ok, false);
  assert.equal(s.status, 409);
  release();
  await until(() => runner.get(r.id).state === 'delivered');
});

test('upgrade: the quick run ends, a thorough run starts on the same question and sub-questions (startedBy upgrade), the agent is told the new id', async () => {
  const { runner, wakes } = makeRunner();
  const r = startAuto(runner, { reason: 'My report needs it.' });
  await tick();
  const up = runner.upgrade(r.id, { by: 'u_sam' });
  assert.equal(up.ok, true);
  assert.match(up.newId, /^dr-[0-9a-f]{8}$/);
  assert.notEqual(up.newId, r.id);
  const old = runner.get(r.id);
  assert.equal(old.state, 'stopped');
  assert.equal(old.upgradedTo, up.newId);
  const neu = runner.get(up.newId);
  assert.equal(neu.level, 'thorough');
  assert.equal(neu.startedBy, 'upgrade');
  assert.equal(neu.state, 'running');
  assert.equal(neu.question, 'Which judge is best?');
  assert.deepEqual(neu.subQuestions, SUBS);
  assert.equal(neu.agent, 'sam-agent');
  assert.equal(runner.list().filter((x) => x.agent === 'sam-agent' && (x.state === 'running' || x.state === 'delivering')).length, 1, 'never two active runs of one agent');
  await until(() => wakes.length >= 1);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].message, `[Deep research made thorough] "Which judge is best?" (${r.id}): the person chose a thorough run instead (new id ${up.newId}); its report will come here.`);
  // the new run is already the person's choice: it cannot be upgraded again, and its report keeps the usual open handling
  assert.equal(runner.upgrade(up.newId).status, 409);
  const finished = research.reportMessage({ id: up.newId, question: 'Q?', report: 'R', level: 'thorough', startedBy: 'upgrade' });
  assert.ok(finished.includes('call for_owner once with requested: true') && !finished.includes('Report:\nNobody') && !finished.includes('for its own work'));
});

test('upgrade: refused for a run the person approved (and for a run that is not running); a thorough run that cannot start leaves the quick run running', async () => {
  const { runner, wakes } = makeRunner();
  const p = runner.start({ agent: 'sam-agent', question: 'Q?', subQuestions: SUBS, level: 'quick', startedBy: 'person' });
  await tick();
  const refused = runner.upgrade(p.id);
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 409);
  assert.equal(runner.get(p.id).state, 'running');
  assert.equal(runner.stop(p.id).ok, true, 'a person-approved run can still be stopped');
  // a thorough run that cannot start: the stamp of the agent cannot be confirmed the second time
  let broken = false; let looks = 0;
  const M = makeRunner({ stampOf: () => { if (broken) looks += 1; if (broken && looks >= 2) throw new Error('lookup failed'); return 'stamp-1'; } });
  const r = startAuto(M.runner);
  await tick();
  broken = true;   // the upgrade's own check of the agent passes (its 1st lookup), the thorough run's stamp lookup fails (its 2nd): the quick run is untouched
  const bad = M.runner.upgrade(r.id);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /^A thorough run could not start: Could not confirm which agent/);
  assert.equal(M.runner.get(r.id).state, 'running', 'the quick run keeps running');
  assert.equal(M.runner.list().length, 1);
  await tick();
  assert.equal(M.wakes.length, 0, 'the agent is told nothing');
  // maxRunning: the old run's own slot is not counted against the new one
  const X = makeRunner({ maxRunning: 1 });
  const q = startAuto(X.runner);
  await tick();
  assert.equal(X.runner.upgrade(q.id).ok, true);
  await until(() => X.wakes.length >= 1);
  assert.equal(wakes.length, 1, 'the first runner only woke its agent for the stop of the person-approved run');
});

// ── the report's first line ──
test('reportMessage: the first line of the report names the wait (no answer) or says the agent started it (own work); person and upgrade as today', () => {
  const base = { id: 'dr-00112233', question: 'Q?', report: '**Verdict** yes', level: 'quick' };
  const na = research.reportMessage({ ...base, startedBy: 'no-answer', waitSeconds: 120 });
  assert.ok(na.includes('\n\nReport:\nNobody answered the question about research within 2 minutes, so this was done as a quick run. Ask for a thorough run if you want every figure checked against its source.\n\n**Verdict** yes'));
  assert.ok(na.includes('Begin your reply with that line, word for word.'));
  assert.ok(na.includes('call for_owner once with requested: true and the reason "Deep research report ready"'), 'still for the person');
  assert.ok(research.reportMessage({ ...base, startedBy: 'no-answer', waitSeconds: 30 }).includes('within 30 seconds, so'));
  assert.ok(research.reportMessage({ ...base, startedBy: 'no-answer', waitSeconds: 60 }).includes('within 1 minute, so'));
  const ag = research.reportMessage({ ...base, startedBy: 'agent', reason: 'My report needs a current comparison.', agentLabel: 'Sam' });
  assert.ok(ag.includes('\n\nReport:\nSam started this quick research run for its own work: My report needs a current comparison.\n\n**Verdict** yes'));
  assert.ok(ag.includes('You started this run for your own work: use the result in that work. Do not call for_owner for this report.'));
  assert.ok(!ag.includes('call for_owner once') && !ag.includes('Present its report to the person'));
  for (const startedBy of ['person', 'upgrade', undefined]) {
    const m = research.reportMessage({ ...base, startedBy });
    assert.ok(m.includes("This is the research run's result, not a message from the person.\n\nReport:\n**Verdict** yes"), String(startedBy));
  }
  // failed and interrupted reports carry no such line
  assert.ok(!research.reportMessage({ ...base, report: undefined, failed: 'x', startedBy: 'no-answer', waitSeconds: 120 }).includes('Nobody answered'));
});

test('runner end to end: a no-answer run and an agent run deliver their first line; the wake carries it', async () => {
  const wakes = [];
  const { runner } = makeRunner({ spawn: async (a, w) => (w[0].label === 'Research summary' ? 'THE REPORT' : 'FINDINGS'), wake: async (agent, message) => { wakes.push(message); } });
  const a = runner.start({ agent: 'sam-agent', question: 'Q?', subQuestions: SUBS, startedBy: 'no-answer', waitSeconds: 120 });
  await until(() => runner.get(a.id).state === 'delivered');
  assert.ok(wakes[0].includes('Report:\nNobody answered the question about research within 2 minutes'));
  const b = runner.start({ agent: 'sam-agent', question: 'Q2?', subQuestions: SUBS, startedBy: 'agent', reason: 'For the digest.', agentLabel: 'Sam' });
  await until(() => runner.get(b.id).state === 'delivered');
  assert.ok(wakes[1].includes('Report:\nSam started this quick research run for its own work: For the digest.'));
  assert.equal(runner.get(b.id).startedBy, 'agent');
  assert.equal(runner.get(b.id).reason, 'For the digest.');
  assert.equal(runner.start({ agent: 'sam-agent', question: 'Q3?', subQuestions: SUBS, startedBy: 'nobody' }).ok, false);
});

// ── status and events ──
test('status and the research_progress event carry startedBy, reason, waitSeconds, costLine, active and upgradable', () => {
  const published = [];
  const L = load();
  L.ctx.hubEvents = { events: { publish: (t, p) => published.push({ t, p }) } };
  const mk = (over) => ({ id: 'dr-1', agent: 'sam-agent', level: 'quick', state: 'running', stage: '', stageLabel: '', stageDone: 0, stageTotal: 0, startedAt: 1, seq: 2, startedBy: 'agent', reason: 'Why.', waitSeconds: null, costLine: 'Cost.', ...over });
  const runs = [mk(), mk({ id: 'dr-2', startedBy: 'no-answer', waitSeconds: 120 }), mk({ id: 'dr-3', startedBy: 'person' }), mk({ id: 'dr-4', level: 'thorough', startedBy: 'upgrade' }), mk({ id: 'dr-5', state: 'delivering' }), mk({ id: 'dr-6', state: 'stopped' })];
  L.ctx.setRunner({ list: () => runs, start() {}, recover() {}, isCurrentAgent: () => true });
  const st = JSON.parse(JSON.stringify(L.ctx.statusFor('sam-agent')));
  assert.deepEqual(st.map((x) => x.id), ['dr-1', 'dr-2', 'dr-3', 'dr-4', 'dr-5']);
  assert.deepEqual(st.map((x) => x.upgradable), [true, true, false, false, false], 'only a running quick run by an agent or no answer');
  assert.deepEqual(st.map((x) => x.active), [true, true, true, true, true]);
  assert.deepEqual(st[0], { id: 'dr-1', level: 'quick', stage: '', label: '', done: 0, total: 0, startedAt: 1, seq: 2, question: '', startedBy: 'agent', reason: 'Why.', waitSeconds: null, costLine: 'Cost.', active: true, upgradable: true });
  assert.equal(st[1].waitSeconds, 120);
  L.ctx.onProgress(runs[5]);
  const ev = JSON.parse(JSON.stringify(published[0].p));
  assert.equal(published[0].t, 'research_progress');
  assert.equal(ev.state, 'stopped');
  assert.equal(ev.active, false);
  assert.equal(ev.upgradable, false);
  assert.equal(ev.startedBy, 'agent');
  // the costline a run is started with: the quick sentence for the agent's model
  assert.ok(true);
});

test('start gives the run its cost line (the quick sentence for the agent\'s model), the person and the agent\'s display name', async () => {
  const L = load({ agents: [{ name: 'sam-agent', display: 'Sammy' }] });
  L.hubTurn('sam-agent');
  await ownWork(L);
  await startQ(L);
  assert.equal(L.started[0].costLine, research.costLine('claude-sdk/claude-test-big'));
  assert.match(L.started[0].costLine, /plan allowance/);
  assert.equal(L.started[0].agentLabel, 'Sammy');
  assert.ok(L.started[0].personKey === 'u_owner', 'the agent\'s person');
});

// ── routes and access ──
function routeHarness({ user, agentOf = { 'dr-aaaaaaaa': 'sam-agent' }, stopOut, upgradeOut, bodyRaw, canAccess = true, hubService = false }) {
  const a = SERVER.indexOf("if ((pathname === '/api/research/stop' || pathname === '/api/research/upgrade') && req.method === 'POST') {");
  const b = SERVER.indexOf('// ── Session/History Routes');
  assert.ok(a > 0 && b > a, 'the routes are there');
  const calls = [];
  const sdk = {
    researchRunAgent: (id) => agentOf[id] || null,
    researchStop: (id, by) => { calls.push(['stop', id, by]); return stopOut || { ok: true, run: { id, state: 'stopped' } }; },
    researchUpgrade: (id, by) => { calls.push(['upgrade', id, by]); return upgradeOut || { ok: true, run: { id: 'dr-bbbbbbbb' }, newId: 'dr-bbbbbbbb' }; },
    researchCapsToday: () => ({ caps: { perAgent: 3, install: 10 }, today: { install: 1, agents: { 'sam-agent': 1 } } }),
  };
  const accessMod = require(path.join(ISO.inst, 'lib', 'access.js'));
  const access = { ...accessMod, canAccessAgent: (u, name) => (typeof canAccess === 'function' ? canAccess(u, name) : canAccess) };
  return (pathname, method, body) => {
    let out = null;
    const ctx = vm.createContext({
      pathname, req: { method, hubUser: user, hubService, hubPendingTotp: false }, res: {}, access, calls,
      require: (m) => { assert.equal(m, './lib/sdk-chat'); return sdk; },
      readBody: async () => (bodyRaw !== undefined ? bodyRaw : JSON.stringify(body)),
      getAgents: async () => [{ name: 'sam-agent', owner: 'u_ann' }], temporalWorkersLib: { getVirtual: () => null },
      jsonResponse: (res, code, obj) => { out = { code, obj }; return out; },
      JSON, Promise, console,
    });
    const src = '(async () => {\n' + SERVER.slice(a, b) + '\nreturn "fallthrough";\n})()';
    return vm.runInContext(src, ctx).then((r) => ({ out, r, calls }));
  };
}

test('routes: stop and upgrade answer ok / run / newId; the person must be allowed to use the run\'s agent (404, the same as an unknown run), the run must exist (404), the id must look like one (400)', async () => {
  const member = { id: 'u_ann', role: 'member' };
  const call = routeHarness({ user: member });
  const s = await call('/api/research/stop', 'POST', { id: 'dr-aaaaaaaa' });
  assert.equal(s.out.code, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(s.out.obj)), { ok: true, run: { id: 'dr-aaaaaaaa', state: 'stopped' } });
  assert.deepEqual(s.calls[0], ['stop', 'dr-aaaaaaaa', 'u_ann']);
  const u = await call('/api/research/upgrade', 'POST', { id: 'dr-aaaaaaaa' });
  assert.equal(u.out.code, 200);
  assert.equal(u.out.obj.newId, 'dr-bbbbbbbb');
  assert.equal(u.out.obj.ok, true);
  assert.equal((await call('/api/research/stop', 'POST', { id: 'dr-cccccccc' })).out.code, 404);
  assert.equal((await call('/api/research/stop', 'POST', { id: 'nonsense' })).out.code, 400);
  assert.equal((await call('/api/research/stop', 'POST', {})).out.code, 400);
  assert.equal((await routeHarness({ user: member, bodyRaw: '{bad' })('/api/research/stop', 'POST')).out.code, 400);
  // a member who may not use the agent
  const denied = routeHarness({ user: { id: 'u_other', role: 'member' }, canAccess: (u, name) => u.id === 'u_ann' });
  const d = await denied('/api/research/stop', 'POST', { id: 'dr-aaaaaaaa' });
  assert.equal(d.out.code, 404);
  assert.deepEqual(JSON.parse(JSON.stringify(d.out.obj)), { error: 'No such research run.' });
  assert.deepEqual(JSON.parse(JSON.stringify((await call('/api/research/stop', 'POST', { id: 'dr-cccccccc' })).out.obj)), { error: 'No such research run.' }, 'the same answer as for a run that does not exist');
  assert.equal(d.calls.length, 0, 'nothing was stopped');
  assert.equal((await denied('/api/research/upgrade', 'POST', { id: 'dr-aaaaaaaa' })).out.code, 404);
  // an admin passes without the member check
  const admin = routeHarness({ user: { id: 'u_root', role: 'admin' }, canAccess: false });
  assert.equal((await admin('/api/research/stop', 'POST', { id: 'dr-aaaaaaaa' })).out.code, 200);
  // the runner's refusals keep their status
  assert.equal((await routeHarness({ user: member, stopOut: { ok: false, status: 409, error: 'This run is not under way any more.' } })('/api/research/stop', 'POST', { id: 'dr-aaaaaaaa' })).out.code, 409);
  assert.equal((await routeHarness({ user: member, upgradeOut: { ok: false, status: 409, error: 'x' } })('/api/research/upgrade', 'POST', { id: 'dr-aaaaaaaa' })).out.obj.error, 'x');
  // a GET is not these routes
  assert.equal((await call('/api/research/stop', 'GET')).r, 'fallthrough');
});

test('routes: the classes (stop and upgrade are for any signed-in person, caps are admin only) and the caps answer', async () => {
  const access = require(path.join(ISO.inst, 'lib', 'access.js'));
  assert.equal(access.classifyRoute('/api/research/stop', 'POST').kind, 'session');
  assert.equal(access.classifyRoute('/api/research/upgrade', 'POST').kind, 'session');
  assert.equal(access.classifyRoute('/api/research/status', 'GET').kind, 'session');
  assert.equal(access.classifyRoute('/api/research/caps', 'GET').kind, 'admin');
  const a = SERVER.indexOf("if (pathname === '/api/research/caps' && req.method === 'GET') {");
  const b = SERVER.indexOf('// ── Session/History Routes');
  let out = null;
  const ctx = vm.createContext({ pathname: '/api/research/caps', req: { method: 'GET' }, res: {}, jsonResponse: (r, c, o) => { out = { c, o }; }, require: () => ({ researchCapsToday: () => ({ caps: { perAgent: 3, install: 10 }, today: { install: 4, agents: { x: 4 } } }) }) });
  vm.runInContext('(() => {' + SERVER.slice(a, b) + '})()', ctx);
  assert.equal(out.c, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(out.o)), { caps: { perAgent: 3, install: 10 }, today: { install: 4, agents: { x: 4 } } });
  // the route is behind the signed-in gate: the access class is checked before the handler by the server
  assert.ok(SERVER.indexOf("pathname === '/api/research/caps'") > SERVER.indexOf("pathname === '/api/research/status'"));
});

// ── settings ──
function patchHarness(patch, stored = {}) {
  const a = SERVER.indexOf('// Deep research, how long a question waits for the person');
  const b = SERVER.indexOf('// Thorough deep research caps (admin)');
  assert.ok(a > 0 && b > a, 'the settings cleaning is there');
  let out = null;
  const ctx = vm.createContext({ patch, hubSettings: { getSetting: (k) => stored[k] }, jsonResponse: (r, c, o) => { out = { c, o }; return 'ret'; }, res: {}, Number, Array, Object, Number });
  const ret = vm.runInContext('(() => {' + SERVER.slice(a, b) + '\nreturn "ok";})()', ctx);
  return { ret, out, patch: JSON.parse(JSON.stringify(ctx.patch)) };
}

test('settings: researchOfferWaitSeconds is a whole number 0..600; researchAgentCaps takes perAgent 0..100 and install 0..1000, merged onto the stored value; anything else is refused', () => {
  assert.equal(patchHarness({ researchOfferWaitSeconds: 0 }).patch.researchOfferWaitSeconds, 0);
  assert.equal(patchHarness({ researchOfferWaitSeconds: 600 }).patch.researchOfferWaitSeconds, 600);
  assert.equal(patchHarness({ researchOfferWaitSeconds: '45' }).patch.researchOfferWaitSeconds, 45);
  for (const bad of [-1, 601, 1.5, 'x', null, true, [], {}, '']) {
    const r = patchHarness({ researchOfferWaitSeconds: bad });
    assert.equal(r.out && r.out.c, 400, JSON.stringify(bad));
    assert.match(r.out.o.error, /^researchOfferWaitSeconds must be a whole number of seconds from 0 to 600$/);
  }
  assert.deepEqual(patchHarness({ researchAgentCaps: { perAgent: 5, install: 20 } }).patch.researchAgentCaps, { perAgent: 5, install: 20 });
  assert.deepEqual(patchHarness({ researchAgentCaps: { install: 0 } }, { researchAgentCaps: { perAgent: 7, install: 10 } }).patch.researchAgentCaps, { perAgent: 7, install: 0 }, 'merged');
  assert.deepEqual(patchHarness({ researchAgentCaps: { perAgent: '100', install: '1000' } }).patch.researchAgentCaps, { perAgent: 100, install: 1000 });
  for (const bad of [{ perAgent: 101 }, { perAgent: -1 }, { install: 1001 }, { install: 2.5 }, { install: 'many' }, { other: 1 }, null, [], 'x', 5]) {
    const r = patchHarness({ researchAgentCaps: bad });
    assert.equal(r.out && r.out.c, 400, JSON.stringify(bad));
  }
  // untouched keys: nothing happens
  assert.deepEqual(patchHarness({ other: 1 }).patch, { other: 1 });
});

test('settings: the helpers read the values with their defaults (120 s; 3 per agent, 10 for the install) and ignore bad stored values', () => {
  const d = load();
  assert.equal(d.ctx.waitSeconds(), 120);
  assert.deepEqual(JSON.parse(JSON.stringify(d.ctx.agentCaps())), { perAgent: 3, install: 10 });
  const s = load({ settings: { researchOfferWaitSeconds: 0, researchAgentCaps: { perAgent: 0, install: 50 } } });
  assert.equal(s.ctx.waitSeconds(), 0);
  assert.deepEqual(JSON.parse(JSON.stringify(s.ctx.agentCaps())), { perAgent: 0, install: 50 });
  const j = load({ settings: { researchOfferWaitSeconds: 9999, researchAgentCaps: { perAgent: 'x', install: -5 } } });
  assert.equal(j.ctx.waitSeconds(), 120);
  assert.deepEqual(JSON.parse(JSON.stringify(j.ctx.agentCaps())), { perAgent: 3, install: 10 });
  const part = load({ settings: { researchAgentCaps: { install: 4 } } });
  assert.deepEqual(JSON.parse(JSON.stringify(part.ctx.agentCaps())), { perAgent: 3, install: 4 });
});

// ── the tool's shape and the guidance ──
test('the tool: for / reason on the tool and in the hub MCP zod shape together with level and recommend; the description says own work never waits', () => {
  const p = research.TOOL.parameters.properties;
  assert.deepEqual(p.for.enum, ['person', 'own_work']);
  assert.equal(p.reason.type, 'string');
  assert.match(p.for.description, /own_work/);
  assert.match(research.TOOL.description, /for "own_work" and a one-sentence reason: it never waits for the person and runs at the quick level/);
  assert.match(research.TOOL.description, /"person" is not named|a question the person asked/);
  const i = SRC.indexOf('...(deepResearchOffered(agentName, consultationDepth, tigerTeam) ? [sdk.tool(researchLib.TOOL.name');
  assert.ok(i > 0);
  const shape = SRC.slice(i, SRC.indexOf('extras(researchLib.TOOL.name, true)', i));
  for (const k of ['action', 'question', 'sub_questions', 'choice', 'level', 'recommend', 'for', 'reason']) assert.match(shape, new RegExp('\\n\\s+' + k + ': z\\.'), k);
  assert.match(shape, /for: z\.enum\(\['person', 'own_work'\]\)/);
  assert.match(shape, /level: z\.enum\(\['quick', 'thorough'\]\)/);
  assert.match(shape, /recommend: z\.enum\(\['quick', 'thorough'\]\)/);
  // no model ids or agent names of this install in the shipped words
  for (const text of [research.TOOL.description, p.for.description, p.reason.description, research.OWN_WORK_OFF, research.autoQuickText('agent'), research.autoQuickText('no-answer', 120)]) assert.doesNotMatch(text, /claude-|gpt-|gemini-|openai\/|maestro-/i);
});

test('the guidance tells an agent how to ask for research for its own work', () => {
  const g = load().ctx.guidance('sam-agent', 0);
  assert.match(g, /If you need research for work you are doing \(not a question the person asked\), call deep_research with action "offer", for "own_work" and a one-sentence reason; it never waits for the person; then start at the quick level as told\./);
  assert.match(g, /action "set"/);
});

test('the wording of the grant, the off texts and the cap are exactly the plan\'s words', () => {
  // with the change off, or the person's Never: carry on without research, say so, and (change off) name the switch once in words
  // the agent can pass on, without asking for it every time
  assert.equal(research.OWN_WORK_OFF, 'Research for an agent\'s own work is not switched on here: carry on without it and say so in your report. If the missing research matters, mention once that the owner can switch on "Agents may start quick research for their own work" on the Changes page.');
  assert.equal(research.RESEARCH_OFF, 'Deep research is switched off for the person you work for (they chose Never): do the work without it and say so in your report.');
  const entry = JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'templates', 'behaviour-changes.json'), 'utf8')).changes.find((c) => c.id === 'research-own-work');
  assert.ok(research.OWN_WORK_OFF.includes(`"${entry.title.split(',')[0]}`), 'the off text names the entry the owner sees on the Changes page');
  assert.equal(research.AGENT_CAP_REACHED, CAP_TEXT);
  assert.ok(!/words more in agents/.test(entry.costs), 'the guidance is sent whether the entry is on or off: the costs do not name it');
  assert.equal(research.OWN_WORK_NEEDS_REASON, 'Give a one-sentence reason: why your work needs this research.');
  assert.match(research.autoQuickText('agent'), GRANT);
});


// ══ review round 1 ══
const realAskUser = () => require(path.join(ISO.inst, 'lib', 'sdk-chat.js')).__askUser.runAskUser;
const writableRes = () => ({ on() {}, write() { return true; }, writableEnded: false });

// S1: only the wait's own timer counts as "nobody answered"
test('S1: a typed answer NO_ANSWER is a typed answer: no quick run, the "no answer came" text, nothing counted', async () => {
  const L = load({ askAnswer: 'NO_ANSWER' });
  L.turn('sam-agent');
  const out = await L.call('sam-agent', { action: 'offer', question: 'Which judge is best?' });
  assert.equal(out, 'No answer came. Answer normally, and offer a deep research run in one line at the end.');
  assert.match(await startQ(L), /^Ask first/);
  assert.equal(L.started.length, 0);
  assert.equal(L.ctx.capsToday().today.install, 0);
});

test('S1: a real short timeout through the REAL runAskUser starts the quick run; a stopped turn and typed text do not', async () => {
  const ask = realAskUser();
  const L = load({ settings: { researchOfferWaitSeconds: 1 }, realAsk: (agent, res, card, opts) => ask(agent, writableRes(), card, opts) });
  L.turn('sam-agent');
  const out = await L.call('sam-agent', { action: 'offer', question: 'Which judge is best?' });
  assert.match(out, /^No answer came within 1 second: start a quick run\./);
  assert.match(await startQ(L), /^Started/);
  assert.equal(L.started[0].startedBy, 'no-answer');
  // the real function: onTimeout runs for the timer only
  let n = 0;
  const q = { question: 'Q?', options: ['A'] };
  assert.equal(await ask('sam-agent', writableRes(), q, { timeoutMs: 5, onTimeout: () => { n += 1; } }), 'NO_ANSWER');
  assert.equal(n, 1, 'the timer');
  const ac = new AbortController();
  const p = ask('sam-agent', writableRes(), q, { timeoutMs: 60000, signal: ac.signal, onTimeout: () => { n += 1; } });
  ac.abort();
  assert.equal(await p, 'NO_ANSWER');
  assert.equal(n, 1, 'a stopped turn is not a timeout');
});

// S2: check, count and start in one synchronous step
test('S2: install cap 1, two agents start together while the model lookup is slow: one run starts and the count is 1', async () => {
  let later = 0;
  const L = load({ settings: { researchAgentCaps: { perAgent: 5, install: 1 } }, modelFn: async () => { await tick(); later += 1; return 'claude-sdk/claude-test-big'; } });
  for (const ag of ['sam-agent', 'ann-agent']) { L.hubTurn(ag); assert.match(await L.call(ag, { action: 'offer', question: 'Q ' + ag, for: 'own_work', reason: 'r' }), GRANT); }
  const outs = await Promise.all(['sam-agent', 'ann-agent'].map((ag) => L.call(ag, { action: 'start', question: 'Q ' + ag, sub_questions: SUBS })));
  assert.ok(later >= 2, 'the model lookups really were awaited');
  assert.equal(L.started.length, 1);
  assert.equal(outs.filter((o) => o === CAP_TEXT).length, 1);
  assert.equal(L.ctx.capsToday().today.install, 1);
});

test('S2: a count that cannot be recorded refuses the start (plain text, nothing started); a start that fails gives the count back', async () => {
  const COUNT_TEXT = 'Could not record today\'s count of research started by agents, so this run was not started; go on without it and say so in your report.';
  const B = load({ runnerExtra: { countAgentStart: () => { throw new Error('disk full'); } } });
  B.hubTurn('sam-agent'); await ownWork(B);
  assert.equal(await startQ(B), COUNT_TEXT);
  assert.equal(B.started.length, 0);
  const undone = [];
  const F = load({ startOk: false, runnerExtra: { uncountAgentStart: (g, d) => { undone.push([g, d]); return F.store.uncountAgentStart(g, d); } } });
  F.hubTurn('sam-agent'); await ownWork(F);
  assert.equal(await startQ(F), 'engine said no');
  assert.deepEqual(undone, [['sam-agent', '2026-11-25']]);
  assert.equal(F.ctx.capsToday().today.install, 0);
});

test('S2: uncountAgentStart takes back that day\'s counts and never goes below 0', () => {
  const s = research.createRunStore({ file: path.join(tmpDir(), 'r.json'), now: () => new Date(2026, 10, 25, 12).getTime() });
  s.countAgentStart('a'); s.countAgentStart('b');
  s.uncountAgentStart('a', '2026-11-25');
  assert.deepEqual(s.agentStartsToday(), { date: '2026-11-25', install: 1, agents: { b: 1 } });
  s.uncountAgentStart('a', '2026-11-25'); s.uncountAgentStart('b', '2026-11-25'); s.uncountAgentStart('b', '2026-11-25');
  assert.deepEqual(s.agentStartsToday(), { date: '2026-11-25', install: 0, agents: {} });
});

// S3: an unreadable runs file is not an empty count
test('S3: a malformed runs file: counting and reading the count throw, an auto start is refused, save keeps the earlier count', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'r.json');
  const now = () => new Date(2026, 10, 25, 12).getTime();
  const s = research.createRunStore({ file, now });
  assert.deepEqual(s.load(), [], 'a missing file is empty');
  assert.equal(s.agentStartsToday().install, 0);
  s.countAgentStart('a'); s.countAgentStart('a');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => s.countAgentStart('a'));
  assert.throws(() => s.agentStartsToday());
  assert.throws(() => s.uncountAgentStart('a', '2026-11-25'));
  s.save([{ id: 'dr-1', agent: 'a', subQuestions: ['x', 'y'] }]);   // the next save after the failed read
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).agentStarts, { '2026-11-25': { install: 2, agents: { a: 2 } } }, 'the earlier count is kept, not reset');
  assert.equal(s.agentStartsToday().install, 2);
  // an unreadable path that is not "missing" is no empty file either
  const d2 = path.join(tmpDir(), 'dir.json'); fs.mkdirSync(d2);
  assert.throws(() => research.createRunStore({ file: d2, now }).agentStartsToday());
  // the handler: an agent's start is refused and nothing starts
  const L = load();
  L.hubTurn('sam-agent'); await ownWork(L);
  fs.writeFileSync(L.file, '[1,2');
  assert.match(await startQ(L), /^Could not record today's count of research started by agents/);
  assert.equal(L.started.length, 0);
  L.hubTurn('sam-agent');
  assert.match(await ownWork(L), /^Could not record today's count/, 'and no grant is given');
});

// R2 (review round 2): a file already damaged at start-up never resets the day's count
const COUNT_FAILED_RE = /^Could not record today's count of research started by agents/;
const copiesOf = (file) => fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(path.basename(file) + '.unreadable-')).sort();
const COPY_RE = /^r\.json\.unreadable-\d{8}-\d{6}-[0-9a-f]{4}$/;

test('R2: a runs file damaged at start-up: a uniquely named copy holds the damaged text, the new file is valid, today\'s count is unknown (refused) and tomorrow counts again', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'r.json');
  let clock = new Date(2026, 10, 25, 12).getTime();
  fs.writeFileSync(file, '{ "runs": [ damaged');
  const s = research.createRunStore({ file, now: () => clock });
  assert.deepEqual(s.load(), [], 'the damaged file loads as no runs');
  s.save([{ id: 'dr-1', agent: 'a', subQuestions: ['x', 'y'] }]);
  const copies = copiesOf(file);
  assert.equal(copies.length, 1);
  assert.match(copies[0], COPY_RE);
  assert.equal(fs.readFileSync(path.join(dir, copies[0]), 'utf8'), '{ "runs": [ damaged', 'the damaged file is kept as it was');
  assert.equal(fs.existsSync(`${file}.unreadable`), false, 'the old fixed name is not used');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.agentStarts, { '2026-11-25': { install: 0, agents: {}, unknown: true } });
  assert.equal(saved.runs.length, 1);
  assert.throws(() => s.agentStartsToday(), /today's count was lost/);
  assert.throws(() => s.countAgentStart('a'), /today's count was lost/);
  s.uncountAgentStart('a', '2026-11-25');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).agentStarts['2026-11-25'].unknown, true, 'uncount leaves it unknown');
  s.save([]);   // later saves keep it unknown and make no second copy
  assert.equal(copiesOf(file).length, 1);
  assert.throws(() => s.agentStartsToday());
  // the next day is a fresh entry
  clock += 24 * 3600 * 1000;
  assert.deepEqual(s.agentStartsToday(), { date: '2026-11-26', install: 0, agents: {} });
  assert.equal(s.countAgentStart('a').install, 1);
  // the handler: an agent-started run is refused with the count text, a person's run still starts
  // (the hub starts with the file already damaged: a store that has never read a good count)
  let fresh = null;
  const L = load({ runnerExtra: { agentStartsToday: () => (fresh || L.store).agentStartsToday(), countAgentStart: (g) => (fresh || L.store).countAgentStart(g), uncountAgentStart: (g, d) => (fresh || L.store).uncountAgentStart(g, d) } });
  L.hubTurn('sam-agent'); await ownWork(L);
  fs.writeFileSync(L.file, '{ damaged');
  fresh = research.createRunStore({ file: L.file, now: () => new Date(2026, 10, 25, 12).getTime() });
  fresh.save([]);   // the first save after the damage: today becomes unknown
  assert.match(await startQ(L), COUNT_FAILED_RE);
  assert.equal(L.started.length, 0);
  L.turn('sam-agent');
  L.prefs.setChoice('u_sam', 'always');
  assert.match(await startQ(L), /^Started/, 'a person\'s own run still works');
});

test('R2: two incidents make two copies; a copy that cannot be made leaves the damaged file as it is and save throws', () => {
  const now = () => new Date(2026, 10, 25, 12).getTime();
  const dir = tmpDir();
  const file = path.join(dir, 'r.json');
  fs.writeFileSync(file, 'first damage');
  research.createRunStore({ file, now }).save([]);
  fs.writeFileSync(file, 'second damage');
  research.createRunStore({ file, now }).save([]);   // a fresh process, damaged again (same second)
  const copies = copiesOf(file);
  assert.equal(copies.length, 2, 'never overwritten, never merged');
  assert.deepEqual(copies.map((c) => fs.readFileSync(path.join(dir, c), 'utf8')).sort(), ['first damage', 'second damage']);
  // the copy cannot be made: the directory is read-only (or the copy is injected to fail)
  const d2 = tmpDir();
  const f2 = path.join(d2, 'r.json');
  fs.writeFileSync(f2, 'damaged and kept');
  const s2 = research.createRunStore({ file: f2, now });
  const real = fs.copyFileSync;
  fs.copyFileSync = () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; };
  try { assert.throws(() => s2.save([{ id: 'dr-1', agent: 'a', subQuestions: ['x', 'y'] }]), /EACCES/); } finally { fs.copyFileSync = real; }
  assert.equal(fs.readFileSync(f2, 'utf8'), 'damaged and kept', 'nothing written over it');
  assert.deepEqual(fs.readdirSync(d2), ['r.json']);
  // a later save, with copying working again, goes through
  s2.save([]);
  assert.equal(copiesOf(f2).length, 1);
});

// R1 (review round 2): a run belongs to the agent that started it, not to whoever has its name now
test('R1: a replaced agent (the stamp for the name changed): stop answers 404 and the run keeps running; isCurrentAgent says no', async () => {
  let stamp = 'stamp-1';
  const { runner, wakes } = makeRunner({ stampOf: () => stamp });
  const r = startAuto(runner);
  await tick();
  assert.equal(runner.isCurrentAgent(r.id), true);
  assert.equal(runner.isCurrentAgent(runner.get(r.id)), true);
  assert.equal(runner.isCurrentAgent('dr-ffffffff'), false);
  stamp = 'stamp-2';
  assert.equal(runner.isCurrentAgent(r.id), false);
  assert.equal(runner.isCurrentAgent(runner.get(r.id)), false);
  const out = runner.stop(r.id, { by: 'u_new' });
  assert.deepEqual(out, { ok: false, status: 404, error: 'No such research run.' });
  assert.equal(runner.get(r.id).state, 'running');
  assert.equal(runner.get(r.id).stoppedBy, undefined);
  await tick();
  assert.equal(wakes.length, 0, 'the new agent is not told');
});

test('R1: the handler side: status lists nothing, researchRunAgent is null, no progress event is published, for a run of a replaced agent', async () => {
  let stamp = 'stamp-1';
  const { runner } = makeRunner({ stampOf: () => stamp });
  const r = startAuto(runner, { question: 'A private question?' });
  await tick();
  const L = load();
  const published = [];
  L.ctx.hubEvents = { events: { publish: (t, p) => published.push({ t, p }) } };
  L.ctx.setRunner(runner);
  assert.equal(L.ctx.statusFor('sam-agent').length, 1, 'the same agent sees its run');
  assert.equal(L.ctx.runAgent(r.id), 'sam-agent');
  L.ctx.onProgress(runner.get(r.id));
  assert.equal(published.length, 1);
  stamp = 'stamp-2';
  assert.deepEqual(JSON.parse(JSON.stringify(L.ctx.statusFor('sam-agent'))), []);
  assert.equal(L.ctx.runAgent(r.id), null);
  L.ctx.onProgress(runner.get(r.id));
  assert.equal(published.length, 1, 'nothing published for it');
  const st = L.ctx.stopRun(r.id, 'u_new');
  assert.equal(st.ok, false);
  assert.equal(st.status, 404);
  assert.equal(runner.get(r.id).state, 'running');
});

// R3 (review round 2): nothing stale starts a paid run after the model lookup
const CHANGED_TEXT = 'The turn or its research choice changed while this run was being set up, so no run was started.';

test('R3a: the turn\'s signal aborts while the model lookup is slow: no run, nothing counted', async () => {
  const M = load();
  M.hubTurn('sam-agent');
  assert.match(await ownWork(M), GRANT);
  // the lookup for the start waits on a gate
  let open; const gate2 = new Promise((res) => { open = res; });
  M.ctx.getAgentModel = async () => { await gate2; return 'claude-sdk/claude-test-big'; };
  const ac = new AbortController();
  const p = M.ctx.run('sam-agent', { on() {}, writableEnded: false }, { action: 'start', question: 'Which judge is best?', sub_questions: SUBS }, { signal: ac.signal });
  await tick(); ac.abort(); open();
  assert.equal(await p, CHANGED_TEXT);
  assert.equal(M.started.length, 0);
  assert.equal(M.ctx.capsToday().today.install, 0, 'nothing counted');
});

test('R3b: a newer offer supersedes the approval during the lookup: no run, and the newer approval is not cleared', async () => {
  const L = load();
  const tr = L.hubTurn('sam-agent');
  await ownWork(L);
  assert.ok(tr.researchApproved);
  let open; const gate = new Promise((res) => { open = res; });
  L.ctx.getAgentModel = async () => { await gate; return 'claude-sdk/claude-test-big'; };
  const p = startQ(L);
  await tick();
  L.ctx.getAgentModel = async () => 'claude-sdk/claude-test-big';
  assert.match(await ownWork(L, { question: 'A newer question?' }), GRANT);   // supersedes: new approval, new generation
  const newer = tr.researchApproved;
  assert.equal(newer.question, 'A newer question?');
  open();
  assert.equal(await p, CHANGED_TEXT);
  assert.equal(L.started.length, 0);
  assert.equal(L.ctx.capsToday().today.install, 0);
  assert.equal(tr.researchApproved, newer, 'the newer approval stands');
});

test('R3c: the person\'s choice changes from always to ask during the lookup: no run', async () => {
  const L = load();
  L.prefs.setChoice('u_owner', 'always');
  L.hubTurn('sam-agent');
  let open; const gate = new Promise((res) => { open = res; });
  L.ctx.getAgentModel = async () => { await gate; return 'claude-sdk/claude-test-big'; };
  const p = startQ(L);
  await tick();
  L.prefs.setChoice('u_owner', 'ask');
  open();
  assert.equal(await p, CHANGED_TEXT);
  assert.equal(L.started.length, 0);
  // and with the choice kept, the same start goes through
  const K = load();
  K.prefs.setChoice('u_owner', 'always');
  K.hubTurn('sam-agent');
  assert.match(await startQ(K), /^Started/);
});

// S4: Always yes in a turn the person did not type
test('S4: Always (thorough) in a scheduled turn starts a thorough run, uncounted, startedBy always, with the notice and push', async () => {
  const L = load();
  L.prefs.setChoice('u_owner', 'always'); L.prefs.setAlwaysLevel('u_owner', 'thorough');
  L.hubTurn('sam-agent');
  assert.match(await L.call('sam-agent', { action: 'offer', question: 'Which judge is best?' }), /thorough deep research run/);
  assert.match(await startQ(L, { level: 'thorough' }), /^Started/);
  assert.equal(L.started[0].level, 'thorough');
  assert.equal(L.started[0].startedBy, 'always');
  assert.deepEqual(JSON.parse(JSON.stringify(L.ctx.capsToday().today)), { install: 0, agents: {} }, 'not counted');
  assert.equal(L.pushes.length, 1);
  assert.equal(L.pushes[0].p.title, 'Sam-agent started thorough research under your Always yes');
  // quick Always: the same, and without an offer first
  const Q = load();
  Q.prefs.setChoice('u_owner', 'always');
  Q.hubTurn('sam-agent');
  assert.match(await startQ(Q), /^Started/);
  assert.equal(Q.started[0].startedBy, 'always');
  assert.equal(Q.pushes.length, 1);
  // in a turn the person typed it stays the person's own run
  const T = load();
  T.prefs.setChoice('u_sam', 'always');
  T.turn('sam-agent');
  assert.match(await startQ(T), /^Started/);
  assert.equal(T.started[0].startedBy, 'person');
  assert.equal(T.pushes.length, 0);
});

test('S4: a run started under Always can be stopped (state stopped, the agent told) and made thorough while quick', async () => {
  const { runner, wakes } = makeRunner();
  const r = startAuto(runner, { startedBy: 'always', reason: '' });
  assert.equal(r.ok, true);
  await tick();
  assert.equal(runner.get(r.id).startedBy, 'always');
  const st = runner.stop(r.id, { by: 'u_owner' });
  assert.equal(st.ok, true);
  assert.equal(runner.get(r.id).state, 'stopped');
  await until(() => wakes.length >= 1);
  assert.match(wakes[0].message, /^\[Deep research stopped\]/);
  const M = makeRunner();
  const q = startAuto(M.runner, { startedBy: 'always', reason: '' });
  await tick();
  const up = M.runner.upgrade(q.id);
  assert.equal(up.ok, true, 'an Always quick run can be made thorough');
  assert.equal(M.runner.get(up.newId).level, 'thorough');
});

test('S4: "ask" in a scheduled turn still follows the own work path (quick, counted, startedBy agent)', async () => {
  const L = load();
  L.prefs.setChoice('u_owner', 'ask');
  L.hubTurn('sam-agent');
  assert.match(await L.call('sam-agent', { action: 'offer', question: 'Which judge is best?' }), GRANT);
  assert.match(await startQ(L), /^Started/);
  assert.equal(L.started[0].startedBy, 'agent');
  assert.equal(L.started[0].level, 'quick');
  assert.equal(L.ctx.capsToday().today.install, 1);
});

// S5: upgrade only for the agent the run was for
test('S5: upgrade is refused (409) when the agent was replaced; nothing changes', async () => {
  let stamp = 'stamp-1';
  const { runner, wakes } = makeRunner({ stampOf: () => stamp });
  const r = startAuto(runner);
  await tick();
  stamp = 'stamp-2';   // the agent was deleted and a new one took the name
  const up = runner.upgrade(r.id);
  assert.equal(up.ok, false);
  assert.equal(up.status, 409);
  assert.equal(up.error, 'The agent this run was for is no longer here, so it can\'t be made thorough.');
  assert.equal(runner.get(r.id).state, 'running');
  assert.equal(runner.list().length, 1, 'no thorough run was started');
  await tick();
  assert.equal(wakes.length, 0);
});

// S6: routes
test('S6: stop and upgrade need a signed-in person: a service call is refused with 403, and the by is the person\'s id', async () => {
  const svc = routeHarness({ user: null, hubService: true });
  for (const p of ['/api/research/stop', '/api/research/upgrade']) {
    const o = await svc(p, 'POST', { id: 'dr-aaaaaaaa' });
    assert.equal(o.out.code, 403);
    assert.deepEqual(JSON.parse(JSON.stringify(o.out.obj)), { error: 'Sign in first.' });
    assert.equal(o.calls.length, 0);
  }
  const nobody = await routeHarness({ user: null })('/api/research/stop', 'POST', { id: 'dr-aaaaaaaa' });
  assert.equal(nobody.out.code, 403);
});

test('S6: the caps route says so when the count cannot be read (no zeros)', async () => {
  const a = SERVER.indexOf("if (pathname === '/api/research/caps' && req.method === 'GET') {");
  const b = SERVER.indexOf('// ── Session/History Routes');
  let out = null;
  const sdk = { researchCapsToday: () => { throw new Error('unreadable'); }, researchAgentCaps: () => ({ perAgent: 2, install: 7 }) };
  const ctx = vm.createContext({ pathname: '/api/research/caps', req: { method: 'GET' }, res: {}, jsonResponse: (r, c, o) => { out = { c, o }; }, require: () => sdk });
  vm.runInContext('(() => {' + SERVER.slice(a, b) + '})()', ctx);
  assert.equal(out.c, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(out.o)), { caps: { perAgent: 2, install: 7 }, today: null, error: 'Could not read today\'s count.' });
  // and the real function throws on a malformed file instead of returning zeros
  const L = load();
  L.hubTurn('sam-agent'); await ownWork(L); await startQ(L);
  fs.writeFileSync(L.file, 'garbage');
  assert.throws(() => L.ctx.capsToday());
});

// S7: wait 0 while the switch is off
test('S7: wait 0 with the switch off shows no card and returns the new text; with the switch on it still starts a quick run at once', async () => {
  assert.equal(research.WAIT_ZERO_OFF, 'The question card is set not to wait here (0 seconds), and research started without a yes is not switched on, so nobody was asked: answer normally, and end with a one-line offer of deep research.');
  const O = load({ ons: ['deep-research'], settings: { researchOfferWaitSeconds: 0 } });
  O.turn('sam-agent');
  assert.equal(await O.call('sam-agent', { action: 'offer', question: 'Q?' }), research.WAIT_ZERO_OFF);
  assert.equal(O.asked.length, 0);
  assert.match(await startQ(O, { question: 'Q?' }), /^Ask first/);
  const N = load({ settings: { researchOfferWaitSeconds: 0 } });
  N.turn('sam-agent');
  assert.match(await N.call('sam-agent', { action: 'offer', question: 'Q?' }), /^Research questions start at the quick level without asking here/);
  assert.match(await startQ(N, { question: 'Q?' }), /^Started/);
  assert.equal(N.started[0].startedBy, 'no-answer');
  // with the switch off and a real wait, a timeout still gets the old text
  const W = load({ ons: ['deep-research'], askAnswer: 'TIMEOUT', settings: { researchOfferWaitSeconds: 45 } });
  W.turn('sam-agent');
  assert.equal(await W.call('sam-agent', { action: 'offer', question: 'Q?' }), 'No answer came. Answer normally, and offer a deep research run in one line at the end.');
});

// S9: stopped runs and upgradable
test('S9: a stopped run is sent once with state stopped and active false; upgradable follows the interface (always included)', async () => {
  const published = [];
  const L = load();
  L.ctx.hubEvents = { events: { publish: (t, p) => published.push({ t, p: JSON.parse(JSON.stringify(p)) }) } };
  const { runner } = makeRunner({ onProgress: (run) => L.ctx.onProgress(run) });
  L.ctx.setRunner(runner);
  const r = startAuto(runner, { startedBy: 'always', reason: '' });
  await tick();
  assert.equal(published.find((e) => e.p.id === r.id).p.upgradable, true, 'a quick Always run is upgradable');
  assert.equal(published.find((e) => e.p.id === r.id).p.startedBy, 'always');
  assert.equal(runner.stop(r.id).ok, true);
  const stopped = published.filter((e) => e.p.id === r.id && e.p.state === 'stopped');
  assert.equal(stopped.length, 1, 'sent once');
  assert.equal(stopped[0].p.active, false);
  assert.equal(stopped[0].p.upgradable, false);
  assert.deepEqual(L.ctx.statusFor('sam-agent').map((x) => x.id), [], 'a stopped run is not in the status list');
  const T = makeRunner({ onProgress: (run) => L.ctx.onProgress(run) });
  L.ctx.setRunner(T.runner);
  const th = startAuto(T.runner, { level: 'thorough', startedBy: 'always', reason: '' });
  await tick();
  assert.equal(published.filter((e) => e.p.id === th.id)[0].p.upgradable, false, 'a thorough run is not');
});
