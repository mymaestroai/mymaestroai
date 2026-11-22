'use strict';
// Deep research: the prefs store, the decision, the card, the briefs, the report message and the background runner.
// No network, no real workers: spawn, wake and sleep are fakes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');

const ISO = makeIsolatedInstall('research-');
const research = require(path.join(ISO.inst, 'lib', 'research.js'));
const { createResearchPrefs, CHOICES, LEVELS, MAX_PEOPLE } = require(path.join(ISO.inst, 'lib', 'research-prefs.js'));

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-')), 'research-prefs.json');
const BIG = 'claude-sdk/claude-test-big';
const FAST = 'claude-sdk/claude-test-fast';
const tick = () => new Promise((r) => setImmediate(r));
async function until(fn, n = 200) { for (let i = 0; i < n; i++) { if (fn()) return; await tick(); } throw new Error('condition not reached'); }

// ── prefs ──
test('prefs: default ask, set and get, another person unaffected', () => {
  const s = createResearchPrefs({ file: tmpFile() });
  assert.deepEqual(CHOICES, ['ask', 'always', 'never']);
  assert.equal(s.choiceOf('sam'), 'ask');
  assert.equal(s.setChoice('sam', 'always'), 'always');
  assert.equal(s.choiceOf('sam'), 'always');
  assert.equal(s.choiceOf('owner'), 'ask');
  assert.equal(s.setChoice('sam', 'ask'), 'ask');
  assert.equal(s.choiceOf('sam'), 'ask');
  assert.equal(s.choiceOf(undefined), 'ask');
  assert.equal(s.choiceOf(5), 'ask');
});

test('prefs: bad key or choice is bad_request and changes nothing', () => {
  const s = createResearchPrefs({ file: tmpFile() });
  for (const k of ['', 'x'.repeat(65), 5, null, undefined, {}]) assert.throws(() => s.setChoice(k, 'always'), (e) => e.code === 'bad_request', String(k));
  for (const v of ['yes', '', 'ALWAYS', 1, null, undefined]) assert.throws(() => s.setChoice('sam', v), (e) => e.code === 'bad_request', String(v));
  assert.equal(s.choiceOf('sam'), 'ask');
  assert.equal(s.setChoice('x'.repeat(64), 'never'), 'never');
});

test('prefs: a corrupt or odd file reads as ask; a write over it works', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{not json');
  const s = createResearchPrefs({ file: f });
  assert.equal(s.choiceOf('sam'), 'ask');
  assert.equal(s.setChoice('sam', 'never'), 'never');
  assert.equal(createResearchPrefs({ file: f }).choiceOf('sam'), 'never');
  const g = tmpFile();
  fs.writeFileSync(g, JSON.stringify({ people: { a: { choice: 'maybe' }, b: 5, c: { choice: 'always' } } }));
  const t = createResearchPrefs({ file: g });
  assert.equal(t.choiceOf('a'), 'ask');
  assert.equal(t.choiceOf('b'), 'ask');
  assert.equal(t.choiceOf('c'), 'always');
  assert.equal(createResearchPrefs({ file: path.join(os.tmpdir(), 'no-such-dir-research', 'x.json') }).choiceOf('sam'), 'ask');
  assert.throws(() => createResearchPrefs({}), /needs a file/);
});

test('prefs: file is 0600, shape is { people: { key: { choice } } }, persists across instances', () => {
  const f = tmpFile();
  const a = createResearchPrefs({ file: f });
  a.setChoice('u_sam', 'always');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { people: { u_sam: { choice: 'always', remindedAt: null, alwaysLevel: 'quick' } } });
  assert.equal(createResearchPrefs({ file: f }).choiceOf('u_sam'), 'always');
  a.setChoice('u_sam', 'never');
  assert.equal(createResearchPrefs({ file: f }).choiceOf('u_sam'), 'never');
});

test('prefs: the cap on people holds; an existing person can still change', () => {
  const f = tmpFile();
  const people = {};
  for (let i = 0; i < MAX_PEOPLE; i++) people[`p${i}`] = { choice: 'always' };
  fs.writeFileSync(f, JSON.stringify({ people }));
  const s = createResearchPrefs({ file: f });
  assert.equal(s.choiceOf('p999'), 'always');
  assert.throws(() => s.setChoice('newcomer', 'always'), (e) => e.code === 'bad_request');
  assert.equal(s.choiceOf('newcomer'), 'ask');
  assert.equal(s.setChoice('p5', 'never'), 'never');
});

// ── costLine and cardFor ──
test('costLine: by kind', () => {
  assert.equal(research.costLine(BIG), 'Uses your Claude sign-in plan allowance: several times a normal answer.');
  assert.equal(research.costLine('codex-cli/test-x'), 'Uses your ChatGPT plan allowance: several times a normal answer.');
  assert.equal(research.costLine('openai/test-mini'), 'Pay-per-use: costs several times a normal answer (many searches and pages read).');
  assert.equal(research.costLine('local/test-model'), "Runs on this computer's own model: no cost, but slower.");
  assert.equal(research.costLine('mystery/thing'), 'Costs several times a normal answer.');
  assert.equal(research.costLine(undefined), 'Costs several times a normal answer.');
});

test('cardFor: the ask_user arguments', () => {
  const c = research.cardFor('openai/test-mini');
  assert.equal(c.header, 'Deep research');
  assert.equal(c.question, 'This looks like a research question. Research it? Quick takes a few minutes; Thorough takes up to an hour. Pay-per-use: Quick costs several times a normal answer; Thorough costs much more (it reads whole papers and pages and has them checked).');
  assert.deepEqual(c.options, ['Yes, quick', 'Yes, thorough', 'No', 'Always yes', 'Never']);
  assert.deepEqual(c.descriptions, [
    'A few minutes: many searches, the results summarised. You can keep talking meanwhile.',
    'Up to an hour: also reads the key sources in full and checks every figure against them.',
    'Answer now from what I know and a quick search.',
    'Research questions like this without asking, at the level set in Settings (now: Quick).',
    'Never ask; always answer normally. You can change this in Settings.',
  ]);
  assert.equal(c.allow_skip, true);
  assert.deepEqual(Object.keys(c).sort(), ['allow_skip', 'descriptions', 'header', 'options', 'question']);
});

test('cardFor: the cost sentence per billing kind', () => {
  const q = (m) => research.cardFor(m).question.replace('This looks like a research question. Research it? Quick takes a few minutes; Thorough takes up to an hour. ', '');
  assert.equal(q(BIG), 'Both use your Claude sign-in plan allowance; Thorough uses several times more than Quick.');
  assert.equal(q('codex-cli/test-x'), 'Both use your ChatGPT plan allowance; Thorough uses several times more than Quick.');
  assert.equal(q('local/test-model'), "Both run on this computer's own model: no cost, but Thorough can take well over an hour.");
  assert.equal(q('mystery/thing'), 'Thorough costs several times more than Quick.');
});

test('cardFor: Recommended marks only the level named; the always wording follows alwaysLevel', () => {
  const m = 'openai/test-mini';
  const quick = research.cardFor(m, { recommend: 'quick' }).descriptions;
  assert.ok(quick[0].endsWith(' Recommended.') && !quick[1].includes('Recommended'));
  const th = research.cardFor(m, { recommend: 'thorough' }).descriptions;
  assert.ok(th[1].endsWith(' Recommended.') && !th[0].includes('Recommended'));
  for (const r of ['both', '', undefined, null, 5]) assert.ok(!research.cardFor(m, { recommend: r }).descriptions.join(' ').includes('Recommended'), String(r));
  assert.ok(research.cardFor(m, { alwaysLevel: 'thorough' }).descriptions[3].endsWith('(now: Thorough).'));
  assert.ok(research.cardFor(m, { alwaysLevel: 'quick' }).descriptions[3].endsWith('(now: Quick).'));
  assert.ok(research.cardFor(m, { alwaysLevel: 'junk' }).descriptions[3].endsWith('(now: Quick).'));
});

test('TOOL: name, actions and required fields', () => {
  assert.equal(research.TOOL.name, 'deep_research');
  assert.deepEqual(research.TOOL.parameters.properties.action.enum, ['offer', 'start', 'set']);
  assert.deepEqual(research.TOOL.parameters.properties.choice.enum, ['ask', 'always', 'never']);
  assert.deepEqual(research.TOOL.parameters.required, ['action']);
  assert.match(research.TOOL.description, /action "set"/);
  assert.match(research.TOOL.description, /BEFORE answering/);
  assert.deepEqual(research.TOOL.parameters.properties.level.enum, ['quick', 'thorough']);
  assert.deepEqual(research.TOOL.parameters.properties.recommend.enum, ['quick', 'thorough']);
  assert.equal(research.TOOL.parameters.properties.always_level, undefined, 'the tool cannot change the Always yes level');
  assert.doesNotMatch(research.TOOL.description, /always_level/);
  assert.match(research.TOOL.description, /Never start thorough unless the person chose it/);
});

// ── decide ──
function fakeStore(throwOnSet) {
  const calls = [];
  return { calls, setChoice(k, v) { calls.push([k, v]); if (throwOnSet) throw new Error('disk full'); return v; } };
}
const askOf = (answer) => { const f = async () => { f.n++; return answer; }; f.n = 0; return f; };

test('decide: always and never never ask', async () => {
  const ask = askOf('yes');
  assert.deepEqual(await research.decide({ choice: 'always', canAsk: true, ask, store: fakeStore(), personKey: 'sam' }), { run: true, by: 'always', level: 'quick' });
  assert.deepEqual(await research.decide({ choice: 'never', canAsk: true, ask, store: fakeStore(), personKey: 'sam' }), { run: false, by: 'never' });
  assert.deepEqual(await research.decide({ choice: 'always', canAsk: false, ask, store: fakeStore(), personKey: 'sam' }), { run: true, by: 'always', level: 'quick' });
  assert.equal((await research.decide({ choice: 'always', alwaysLevel: 'thorough', canAsk: false, ask, store: fakeStore(), personKey: 'sam' })).level, 'thorough');
  assert.equal((await research.decide({ choice: 'always', alwaysLevel: 'junk', canAsk: false, ask, store: fakeStore(), personKey: 'sam' })).level, 'quick');
  assert.equal(ask.n, 0);
});

test('decide: nobody to ask', async () => {
  const ask = askOf('yes');
  assert.deepEqual(await research.decide({ choice: 'ask', canAsk: false, ask, store: fakeStore(), personKey: 'sam' }), { run: false, by: 'no-one-to-ask' });
  assert.deepEqual(await research.decide({ choice: 'weird', canAsk: false, ask, store: fakeStore(), personKey: 'sam' }), { run: false, by: 'no-one-to-ask' });
  assert.equal(ask.n, 0);
});

test('decide: every answer', async () => {
  const run = async (answer, store = fakeStore()) => ({ d: await research.decide({ choice: 'ask', canAsk: true, ask: askOf(answer), store, personKey: 'u_sam' }), store });
  for (const a of ['yes', ' Yes ', 'YES']) { const { d, store } = await run(a); assert.deepEqual(d, { run: true, by: 'yes', level: 'quick' }); assert.equal(store.calls.length, 0); }
  for (const a of ['Yes, quick', ' YES, QUICK ']) { const { d, store } = await run(a); assert.deepEqual(d, { run: true, by: 'yes', level: 'quick' }); assert.equal(store.calls.length, 0); }
  for (const a of ['Yes, thorough', ' yes, THOROUGH ']) { const { d, store } = await run(a); assert.deepEqual(d, { run: true, by: 'yes', level: 'thorough' }); assert.equal(store.calls.length, 0); }
  { const d = await research.decide({ choice: 'ask', alwaysLevel: 'thorough', canAsk: true, ask: askOf('Always yes'), store: fakeStore(), personKey: 'u_sam' }); assert.deepEqual(d, { run: true, by: 'always-now', level: 'thorough' }); }
  assert.deepEqual(await research.decide({ choice: 'ask', canAsk: true, ask: askOf('yes, deep'), store: fakeStore(), personKey: 'u_sam' }), { run: false, by: 'typed', text: 'yes, deep' });
  for (const a of ['Always yes', 'always', ' yes always ']) { const { d, store } = await run(a); assert.deepEqual(d, { run: true, by: 'always-now', level: 'quick' }); assert.deepEqual(store.calls, [['u_sam', 'always']]); }
  for (const a of ['Never', 'no always', 'NEVER ASK']) { const { d, store } = await run(a); assert.deepEqual(d, { run: false, by: 'never-now' }); assert.deepEqual(store.calls, [['u_sam', 'never']]); }
  for (const a of ['No', ' no ']) { const { d, store } = await run(a); assert.deepEqual(d, { run: false, by: 'no' }); assert.equal(store.calls.length, 0); }
  for (const a of ['SKIPPED', 'NO_ANSWER', '', '   ', undefined, null]) { const { d } = await run(a); assert.deepEqual(d, { run: false, by: 'no-answer' }, String(a)); }
  const typed = await run('  do the first part only ');
  assert.deepEqual(typed.d, { run: false, by: 'typed', text: 'do the first part only' });
  const long = await run('z'.repeat(500));
  assert.equal(long.d.text.length, 300);
});

test('decide: a failing store keeps the decision and says saved: false', async () => {
  const a = await research.decide({ choice: 'ask', canAsk: true, ask: askOf('Always yes'), store: fakeStore(true), personKey: 'sam' });
  assert.deepEqual(a, { run: true, by: 'always-now', level: 'quick', saved: false });
  const n = await research.decide({ choice: 'ask', canAsk: true, ask: askOf('Never'), store: fakeStore(true), personKey: 'sam' });
  assert.deepEqual(n, { run: false, by: 'never-now', saved: false });
});

test('decide: ask throwing or rejecting is no answer', async () => {
  const store = fakeStore();
  assert.deepEqual(await research.decide({ choice: 'ask', canAsk: true, ask: () => { throw new Error('boom'); }, store, personKey: 'sam' }), { run: false, by: 'no-answer' });
  assert.deepEqual(await research.decide({ choice: 'ask', canAsk: true, ask: async () => { throw new Error('boom'); }, store, personKey: 'sam' }), { run: false, by: 'no-answer' });
  assert.equal(store.calls.length, 0);
});

test('decide: works with the real prefs store end to end', async () => {
  const s = createResearchPrefs({ file: tmpFile() });
  await research.decide({ choice: s.choiceOf('sam'), canAsk: true, ask: askOf('Always yes'), store: s, personKey: 'sam' });
  assert.equal(s.choiceOf('sam'), 'always');
  const ask = askOf('no');
  assert.deepEqual(await research.decide({ choice: s.choiceOf('sam'), canAsk: true, ask, store: s, personKey: 'sam' }), { run: true, by: 'always', level: 'quick' });
  assert.equal(ask.n, 0);
});

// ── offerText ──
test('offerText: every outcome', () => {
  const o = research.offerText;
  assert.match(o({ run: true, by: 'yes' }), /^The person wants a quick deep research run\. Plan 2 to 8 sub-questions/);
  assert.match(o({ run: true, by: 'always' }), /^The person wants a quick deep research run \(they chose always\)\. Plan/);
  assert.match(o({ run: true, by: 'always-now' }), /^The person wants a quick deep research run \(and from now on without being asked\)\. Plan/);
  for (const by of ['yes', 'always', 'always-now']) assert.match(o({ run: true, by }), /action "start", the same question, sub_questions and level "quick"\. It runs in the background \(a few minutes\): tell.*report will appear here/);
  const th = o({ run: true, by: 'yes', level: 'thorough' });
  assert.match(th, /^The person wants a thorough deep research run\./);
  assert.match(th, /sub_questions and level "thorough"\. It runs in the background \(up to an hour\)/);
  assert.match(o({ run: true, by: 'always', level: 'thorough' }), /thorough deep research run \(they chose always\)/);
  // review r1: a choice that could not be saved is said plainly
  assert.match(o({ run: true, by: 'always-now', saved: false }), /could not be saved, so they may be asked again/);
  assert.doesNotMatch(o({ run: true, by: 'always-now', saved: false }), /from now on without being asked/);
  assert.match(o({ run: false, by: 'never-now', saved: false }), /could not be saved/);
  assert.match(o({ run: false, by: 'never' }), /chose never to be asked.*Do not offer research\.$/);
  assert.match(o({ run: false, by: 'never-now' }), /will not be asked again\. Answer normally now\.$/);
  assert.equal(o({ run: false, by: 'no' }), 'The person said no to deep research this time. Answer normally now.');
  assert.match(o({ run: false, by: 'no-one-to-ask' }), /No one can be asked right now.*offering a deep research run/);
  assert.match(o({ run: false, by: 'no-answer' }), /^No answer came\./);
  // review r1: typed text is never a yes; the agent may offer again so the person can choose Yes
  assert.equal(o({ run: false, by: 'typed', text: 'no thanks' }), 'The person typed "no thanks" instead of choosing. That is not a yes: answer normally now. If their words ask for research, call deep_research with action "offer" again so they can choose Yes.');
  assert.doesNotMatch(o({ run: false, by: 'typed', text: 'x' }), /action "start"/);
});

// ── chooseHelperModel ──
test('chooseHelperModel: same kind and prefix wins, then same kind, order kept', () => {
  const notes = {
    'claude-sdk/claude-test-fast': 'Fast and cheap',
    'openai/test-mini': 'a small model',
    'openai/test-mini-2': 'fast, cheap',
    'openai/test-big': 'slow and careful',
    'anthropic/test-lite': 'fast and cheap',
    'local/test-model': 'fast and cheap',
  };
  const noteOf = (m) => notes[m] || '';
  const allowed = Object.keys(notes);
  assert.equal(research.chooseHelperModel({ ownModel: BIG, allowed, noteOf }), FAST);
  assert.equal(research.chooseHelperModel({ ownModel: 'openai/test-big', allowed, noteOf }), 'openai/test-mini');
  assert.equal(research.chooseHelperModel({ ownModel: 'openai/test-big', allowed: ['anthropic/test-lite', 'openai/test-mini-2'], noteOf }), 'openai/test-mini-2');
  assert.equal(research.chooseHelperModel({ ownModel: 'openai/test-big', allowed: ['anthropic/test-lite', 'openai/test-mini'], noteOf }), 'openai/test-mini');
  assert.equal(research.chooseHelperModel({ ownModel: 'google/test-big', allowed: ['anthropic/test-lite', 'openai/test-mini'], noteOf }), 'anthropic/test-lite');
});

test('chooseHelperModel: local is never picked for a non-local model; own model when no candidate', () => {
  const noteOf = () => 'fast and cheap';
  assert.equal(research.chooseHelperModel({ ownModel: BIG, allowed: ['local/test-model'], noteOf }), BIG);
  assert.equal(research.chooseHelperModel({ ownModel: 'openai/test-big', allowed: ['local/test-model', BIG], noteOf }), 'openai/test-big');
  assert.equal(research.chooseHelperModel({ ownModel: 'local/test-big', allowed: [BIG, 'local/test-model'], noteOf }), 'local/test-model');
  assert.equal(research.chooseHelperModel({ ownModel: BIG, allowed: [], noteOf }), BIG);
  assert.equal(research.chooseHelperModel({ ownModel: BIG, allowed: undefined, noteOf }), BIG);
  assert.equal(research.chooseHelperModel({ ownModel: BIG, allowed: [FAST], noteOf: () => 'big and slow' }), BIG);
});

test('chooseHelperModel: noteOf throwing counts as no note', () => {
  const noteOf = (m) => { if (m === 'claude-sdk/claude-test-a') throw new Error('no note'); return 'fast and cheap'; };
  assert.equal(research.chooseHelperModel({ ownModel: BIG, allowed: ['claude-sdk/claude-test-a', FAST], noteOf }), FAST);
  assert.equal(research.chooseHelperModel({ ownModel: BIG, allowed: ['claude-sdk/claude-test-a'], noteOf }), BIG);
});

// ── briefs ──
test('helperBrief: the question, the sub-question and the working instructions', () => {
  const b = research.helperBrief('Which method is best?', 'What do the trials say?');
  assert.match(b, /Which method is best\?/);
  assert.match(b, /What do the trials say\?/);
  assert.match(b, /Search widely: several different searches with different wordings\./);
  assert.match(b, /Open and read the actual sources/);
  assert.match(b, /Note where sources disagree\. Say what you could not find\./);
  assert.match(b, /SOURCES READ/);
  assert.match(b, /At most about 700 words\.$/);
});

test('synthesisBrief: numbered sub-questions, findings, report order, and the 60000 cut', () => {
  const b = research.synthesisBrief('Q?', ['first', 'second'], 'FINDINGS TEXT');
  assert.match(b, /Q\?/);
  assert.match(b, /1\. first\n2\. second/);
  assert.match(b, /Findings from the helpers:\nFINDINGS TEXT/);
  for (const part of ['**Verdict**', '**Evidence**', '**Where sources disagree**', '**Confidence**', '**Sources**', 'Cross-check the claims']) assert.ok(b.includes(part), part);
  assert.ok(!b.includes('[cut]'));
  const exact = research.synthesisBrief('Q?', ['a', 'b'], 'x'.repeat(60000));
  assert.ok(!exact.includes('[cut]'));
  const big = research.synthesisBrief('Q?', ['a', 'b'], 'x'.repeat(60001));
  assert.ok(big.includes('x'.repeat(60000) + '\n[cut]'));
  assert.ok(!big.includes('x'.repeat(60001)));
});

// ── reportMessage ──
test('reportMessage: finished and failed', () => {
  const ok = research.reportMessage({ id: 'dr-00112233', question: 'Q?', report: '**Verdict** yes' });
  assert.ok(ok.startsWith('[Deep research finished] "Q?" (id dr-00112233).\n\nThe research run finished. Present its report'));
  assert.ok(ok.includes("This is the research run's result, not a message from the person.\n\nReport:\n**Verdict** yes"));
  const bad = research.reportMessage({ id: 'dr-00112233', question: 'Q?', failed: 'the workers refused' });
  assert.ok(bad.startsWith('[Deep research failed] "Q?" (id dr-00112233): the workers refused.\n\nTell the person in one or two lines'));
  assert.ok(!bad.includes('Report:'));
  const cut = research.reportMessage({ id: 'dr-1', question: 'q'.repeat(300), report: 'r' });
  assert.ok(cut.includes(`"${'q'.repeat(200)}"`) && !cut.includes('q'.repeat(201)));
});

// ── the runner ──
function makeRunner(over = {}) {
  const spawns = [];
  const wakes = [];
  const sleeps = [];
  const deps = {
    spawn: async (agent, workers) => {
      spawns.push({ agent, workers });
      return workers.length === 1 && workers[0].label === 'Research summary' ? 'THE REPORT' : 'FINDINGS: ' + workers.map((w) => w.label).join(',');
    },
    wake: async (agent, message) => { wakes.push({ agent, message }); },
    pickHelperModel: async () => FAST,
    ownModelOf: async () => BIG,
    keptOnBox: () => false,
    sleep: async (ms) => { sleeps.push(ms); },
    log: () => {},
    ...over,
  };
  return { runner: research.createResearchRunner(deps), spawns, wakes, sleeps };
}
const SUBS = ['one', 'two', 'three'];

test('runner: validation errors', () => {
  const { runner } = makeRunner();
  const bad = (a) => { const r = runner.start({ agent: 'sam-agent', ...a }); assert.equal(r.ok, false); assert.equal(typeof r.error, 'string'); return r; };
  bad({ question: '', subQuestions: SUBS });
  bad({ question: '   ', subQuestions: SUBS });
  bad({ question: 5, subQuestions: SUBS });
  bad({ question: 'q'.repeat(2001), subQuestions: SUBS });
  bad({ question: 'Q?', subQuestions: 'one' });
  bad({ question: 'Q?', subQuestions: ['only one'] });
  bad({ question: 'Q?', subQuestions: ['dup', ' dup ', '', '  '] });
  bad({ question: 'Q?', subQuestions: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] });
  bad({ question: 'Q?', subQuestions: ['a', 'x'.repeat(501)] });
  assert.equal(runner.list().length, 0);
  assert.equal(runner.start({ agent: 'sam-agent', question: 'q'.repeat(2000), subQuestions: ['a', 'x'.repeat(500)] }).ok, true);
});

test('runner: sub-questions are trimmed, emptied and de-duplicated', async () => {
  const { runner, spawns } = makeRunner();
  const r = runner.start({ agent: 'a1', question: '  Q?  ', subQuestions: [' one ', 'one', '', 'two', 5] });
  assert.equal(r.ok, true);
  assert.match(r.id, /^dr-[0-9a-f]{8}$/);
  assert.equal(runner.get(r.id).question, 'Q?');
  assert.deepEqual(runner.get(r.id).subQuestions, ['one', 'two']);
  await until(() => runner.get(r.id).state === 'delivered');
  assert.equal(spawns[0].workers.length, 2);
});

test('runner: one run per agent, and maxRunning in total, freed when finished', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { runner } = makeRunner({ spawn: async (a, w) => { await gate; return w[0].label === 'Research summary' ? 'REPORT' : 'F'; } });
  const first = runner.start({ agent: 'a1', question: 'Q?', subQuestions: SUBS });
  assert.equal(first.ok, true);
  const again = runner.start({ agent: 'a1', question: 'Q2?', subQuestions: SUBS });
  assert.deepEqual(again, { ok: false, error: 'A research run for this question is already under way for you; its report will come here.' });
  assert.equal(runner.start({ agent: 'a2', question: 'Q?', subQuestions: SUBS }).ok, true);
  assert.equal(runner.start({ agent: 'a3', question: 'Q?', subQuestions: SUBS }).ok, true);
  assert.deepEqual(runner.start({ agent: 'a4', question: 'Q?', subQuestions: SUBS }), { ok: false, error: 'Too many research runs are under way right now; try again in a few minutes.' });
  release();
  await until(() => runner.list().every((r) => r.state === 'delivered'));
  assert.equal(runner.start({ agent: 'a1', question: 'Q3?', subQuestions: SUBS }).ok, true);
  assert.equal(runner.start({ agent: 'a4', question: 'Q?', subQuestions: SUBS }).ok, true);
});

test('runner: maxRunning is configurable', () => {
  const { runner } = makeRunner({ maxRunning: 1, spawn: () => new Promise(() => {}) });
  assert.equal(runner.start({ agent: 'a1', question: 'Q?', subQuestions: SUBS }).ok, true);
  assert.match(runner.start({ agent: 'a2', question: 'Q?', subQuestions: SUBS }).error, /Too many/);
});

test('runner: start is not awaited; nothing runs before the next tick', async () => {
  const { runner, spawns } = makeRunner();
  const r = runner.start({ agent: 'a1', question: 'Q?', subQuestions: SUBS });
  assert.equal(spawns.length, 0);
  assert.equal(runner.get(r.id).state, 'running');
  await until(() => runner.get(r.id).state === 'delivered');
});

test('runner: the two spawn calls and the delivered report', async () => {
  const { runner, spawns, wakes } = makeRunner();
  const r = runner.start({ agent: 'a1', question: 'Which is best?', subQuestions: SUBS });
  await until(() => runner.get(r.id).state === 'delivered');
  assert.equal(spawns.length, 2);
  assert.equal(spawns[0].agent, 'a1');
  assert.equal(spawns[0].workers.length, 3);
  spawns[0].workers.forEach((w, i) => {
    assert.equal(w.model, FAST);
    assert.equal(w.tools, 'read');
    assert.equal(w.label, `Research ${i + 1}`);
    assert.equal(w.task, research.helperBrief('Which is best?', SUBS[i]));
  });
  assert.equal(spawns[1].workers.length, 1);
  const sw = spawns[1].workers[0];
  assert.equal(sw.model, BIG);
  assert.equal(sw.tools, 'read');
  assert.equal(sw.label, 'Research summary');
  assert.equal(sw.task, research.synthesisBrief('Which is best?', SUBS, 'FINDINGS: Research 1,Research 2,Research 3'));
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].agent, 'a1');
  assert.equal(wakes[0].message, research.reportMessage({ id: r.id, question: 'Which is best?', report: 'THE REPORT' }));
});

test('runner: delivery retries until the wake succeeds', async () => {
  let n = 0;
  const { runner, wakes, sleeps } = makeRunner({ retryMs: 1234, wake: async (agent, message) => { n++; if (n < 4) throw new Error('agent is busy'); wakes.push(message); } });
  const r = runner.start({ agent: 'a1', question: 'Q?', subQuestions: SUBS });
  await until(() => runner.get(r.id).state === 'delivered');
  assert.equal(n, 4);
  assert.deepEqual(sleeps, [1234, 1234, 1234]);
  assert.equal(runner.get(r.id).error, null);
});

test('runner: gives up after maxWakeTries and logs it; the run stops counting as running', async () => {
  const logs = [];
  let n = 0;
  const { runner, sleeps } = makeRunner({ maxWakeTries: 5, log: (m) => logs.push(m), wake: async () => { n++; throw new Error(`refused ${n}`); } });
  const r = runner.start({ agent: 'a1', question: 'Q?', subQuestions: SUBS });
  await until(() => runner.get(r.id).state === 'failed');
  assert.equal(n, 5);
  assert.equal(sleeps.length, 4);
  const run = runner.get(r.id);
  assert.equal(run.error, 'the report could not be delivered: refused 5');
  assert.equal(typeof run.endedAt, 'number');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /could not be delivered/);
  assert.equal(runner.start({ agent: 'a1', question: 'Q2?', subQuestions: SUBS }).ok, true);
});

test('runner: a spawn refusal gives a failed report that is still delivered', async () => {
  const refusal = '[spawn_workers] not allowed: ' + 'x'.repeat(400);
  const { runner, wakes, spawns } = makeRunner({ spawn: async () => refusal });
  const r = runner.start({ agent: 'a1', question: 'Q?', subQuestions: SUBS });
  await until(() => runner.get(r.id).state === 'delivered');
  assert.equal(spawns.length, 0);
  assert.equal(wakes.length, 1);
  assert.ok(wakes[0].message.startsWith(`[Deep research failed] "Q?" (id ${r.id}): [spawn_workers] not allowed: `));
  assert.ok(wakes[0].message.includes(`${refusal.slice(0, 300)}.`));
  assert.ok(!wakes[0].message.includes(refusal.slice(0, 301)));
});

test('runner: a refusal on the summary step, a throw, and an empty report all give a failed report', async () => {
  const cases = [
    { name: 'refusal at summary', spawn: async (a, w) => (w[0].label === 'Research summary' ? '[spawn_workers] busy' : 'F'), reason: '[spawn_workers] busy' },
    { name: 'throw', spawn: async () => { throw new Error('worker crashed'); }, reason: 'worker crashed' },
    { name: 'empty', spawn: async (a, w) => (w[0].label === 'Research summary' ? '   ' : 'F'), reason: 'no report' },
  ];
  for (const c of cases) {
    const { runner, wakes } = makeRunner({ spawn: c.spawn });
    const r = runner.start({ agent: 'a1', question: 'Q?', subQuestions: SUBS });
    await until(() => runner.get(r.id).state === 'delivered');
    assert.equal(wakes.length, 1, c.name);
    assert.ok(wakes[0].message.startsWith('[Deep research failed]'), c.name);
    assert.ok(wakes[0].message.includes(c.reason), c.name);
  }
});

test('runner: a throw from pickHelperModel or ownModelOf gives a failed report', async () => {
  for (const over of [{ pickHelperModel: async () => { throw new Error('no helper'); } }, { ownModelOf: async () => { throw new Error('no own'); } }]) {
    const { runner, wakes, spawns } = makeRunner(over);
    const r = runner.start({ agent: 'a1', question: 'Q?', subQuestions: SUBS });
    await until(() => runner.get(r.id).state === 'delivered');
    assert.equal(spawns.length, 0);
    assert.ok(wakes[0].message.startsWith('[Deep research failed]'));
  }
});

test('runner: state transitions and times', async () => {
  let t = 1000;
  let releaseWake;
  const wakeGate = new Promise((r) => { releaseWake = r; });
  const { runner } = makeRunner({ now: () => (t += 10), wake: async () => { await wakeGate; } });
  const r = runner.start({ agent: 'a1', question: 'Q?', subQuestions: SUBS });
  const first = runner.get(r.id);
  assert.equal(first.state, 'running');
  assert.ok(first.startedAt > 1000);
  assert.equal(first.endedAt, null);
  assert.equal(first.error, null);
  assert.equal(first.agent, 'a1');
  await until(() => runner.get(r.id).state === 'delivering');
  assert.equal(runner.start({ agent: 'a1', question: 'Q2?', subQuestions: SUBS }).ok, false, 'still counts while delivering');
  releaseWake();
  await until(() => runner.get(r.id).state === 'delivered');
  assert.ok(runner.get(r.id).endedAt > first.startedAt);
});

test('runner: list and get return copies; get of an unknown id is null', async () => {
  const { runner } = makeRunner();
  const r = runner.start({ agent: 'a1', question: 'Q?', subQuestions: SUBS });
  await until(() => runner.get(r.id).state === 'delivered');
  const g = runner.get(r.id);
  g.state = 'tampered';
  g.subQuestions.push('extra');
  assert.equal(runner.get(r.id).state, 'delivered');
  assert.equal(runner.get(r.id).subQuestions.length, 3);
  const l = runner.list();
  assert.equal(l.length, 1);
  l[0].state = 'tampered';
  l.pop();
  assert.equal(runner.list().length, 1);
  assert.equal(runner.list()[0].state, 'delivered');
  assert.equal(runner.get('dr-nope'), null);
});

// ── Never: a reminder now and then that it is off (owner, 11-21) ──
const WEEK = 7 * 24 * 3600 * 1000;

test('prefs: choosing never counts as being told; a reminder is due once per interval; 0 never reminds', () => {
  let t = 1_000_000;
  const f = tmpFile();
  const s = createResearchPrefs({ file: f, now: () => t });
  assert.equal(s.remindDue('u_sam', WEEK), false, 'not never: no reminder');
  s.setChoice('u_sam', 'never');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).people.u_sam.remindedAt, t);
  assert.equal(s.remindDue('u_sam', WEEK), false, 'just chose never');
  t += WEEK;
  assert.equal(s.remindDue('u_sam', WEEK), true, 'a week later');
  assert.equal(s.remindDue('u_sam', 0), false, '0 = never remind');
  assert.equal(s.markReminded('u_sam'), true);
  assert.equal(s.remindDue('u_sam', WEEK), false, 'reminded just now');
  t += WEEK - 1;
  assert.equal(s.remindDue('u_sam', WEEK), false, 'within the interval');
  t += 1;
  assert.equal(s.remindDue('u_sam', WEEK), true, 'again after it');
  // choosing never again keeps the reminder clock; leaving never clears it
  s.setChoice('u_sam', 'never');
  assert.equal(s.remindDue('u_sam', WEEK), true);
  s.setChoice('u_sam', 'ask');
  assert.equal(s.markReminded('u_sam'), false, 'only while never');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).people.u_sam.remindedAt, null);
  assert.equal(createResearchPrefs({ file: f }).choiceOf('u_sam'), 'ask');
});

test('decide: never with a reminder due gives the one line and marks it; not due gives plain never', async () => {
  const marked = [];
  const store = { setChoice() {}, markReminded: (k) => marked.push(k) };
  const ask = askOf('Yes');
  assert.deepEqual(await research.decide({ choice: 'never', canAsk: true, ask, store, personKey: 'u_sam', remindDue: true }), { run: false, by: 'never-remind' });
  assert.deepEqual(marked, ['u_sam']);
  assert.deepEqual(await research.decide({ choice: 'never', canAsk: true, ask, store, personKey: 'u_sam', remindDue: false }), { run: false, by: 'never' });
  assert.equal(ask.n, 0, 'never asks');
  const throwing = { markReminded() { throw new Error('disk'); } };
  assert.deepEqual(await research.decide({ choice: 'never', canAsk: false, store: throwing, personKey: 'u_sam', remindDue: true }), { run: false, by: 'never-remind' });
  const text = research.offerText({ by: 'never-remind' });
  assert.ok(text.endsWith(research.REMIND_LINE));
  assert.match(research.REMIND_LINE, /turn deep research back on/);
  assert.doesNotMatch(research.offerText({ by: 'never' }), /turn deep research back on/);
});

test('setText: each choice, a bad one, and a refusal', () => {
  assert.match(research.setText('ask'), /back on/);
  assert.match(research.setText('always'), /without asking/);
  assert.match(research.setText('never'), /off/);
  assert.match(research.setText('maybe'), /ask, always or never/);
  assert.match(research.setText('ask', false), /only the person can change it/);
});

test('runner: runs are saved; one under way at a restart is reported as cut short; old finished ones are pruned', async () => {
  let saved = [];
  const store = { load: () => saved, save: (r) => { saved = JSON.parse(JSON.stringify(r)); } };
  let t = 5_000_000;
  let release;
  const gate = new Promise((r) => { release = r; });
  // the first runner stays still (it would save its stages over the second runner's, which share this store)
  const a = makeRunner({ store, now: () => t, pickHelperModel: async () => { await gate; return FAST; }, spawn: async () => 'X' });
  const r = a.runner.start({ agent: 'a1', question: 'Q?', subQuestions: SUBS });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].state, 'running');
  // the hub restarts while it runs
  const b = makeRunner({ store, now: () => t });
  assert.equal(b.runner.get(r.id).state, 'running');
  b.runner.recover();
  await until(() => b.runner.get(r.id).state === 'delivered');
  assert.equal(b.wakes.length, 1);
  assert.ok(b.wakes[0].message.startsWith('[Deep research failed]'));
  assert.match(b.wakes[0].message, /restarted while it ran/);
  assert.equal(saved.find((x) => x.id === r.id).state, 'delivered');
  b.runner.recover();
  assert.equal(b.wakes.length, 1, 'recover reports once');
  // a day later, a new start prunes the finished run
  t += 24 * 3600 * 1000 + 1;
  const r2 = b.runner.start({ agent: 'a2', question: 'Q2?', subQuestions: SUBS });
  assert.equal(b.runner.get(r.id), null);
  assert.ok(b.runner.get(r2.id));
  release();
  // a store that can't be read or written never stops a run
  const c = makeRunner({ store: { load() { throw new Error('bad'); }, save() { throw new Error('full'); } } });
  const r3 = c.runner.start({ agent: 'a3', question: 'Q?', subQuestions: SUBS });
  await until(() => c.runner.get(r3.id).state === 'delivered');
});

// ── review r1: worker outcomes, the deadline, the saved report ──
const res = (label, ok, text) => ({ label, ok, text });

test('review r1: each worker outcome counts: failed helpers are left out, all failed or a failed summary is a failed report', async () => {
  // some helpers failed: the findings name the missing parts; the wrapper never reaches the report
  let seen = null;
  const a = makeRunner({ spawn: async (agent, w) => {
    if (w[0].label === 'Research summary') { seen = w[0].task; return [res('Research summary', true, '**Verdict** X')]; }
    return [res('Research 1', true, 'found A'), res('Research 2', false, 'FAILED: rate limit'), res('Research 3', true, 'found C')];
  } });
  let r = a.runner.start({ agent: 'a1', question: 'Q?', subQuestions: SUBS });
  await until(() => a.runner.get(r.id).state === 'delivered');
  assert.match(seen, /### Research 1\nfound A[\s\S]*### Research 3\nfound C[\s\S]*1 of 3 helpers did not finish/);
  assert.doesNotMatch(seen, /rate limit/);
  assert.ok(a.wakes[0].message.startsWith('[Deep research finished]'));
  assert.ok(a.wakes[0].message.endsWith('Report:\n**Verdict** X'));
  // every helper failed: no summary, a failed report
  let bCalls = 0;
  const b = makeRunner({ spawn: async (agent, w) => { bCalls++; return w.map((x) => res(x.label, false, 'FAILED: no web tool')); } });
  r = b.runner.start({ agent: 'a1', question: 'Q?', subQuestions: SUBS });
  await until(() => b.runner.get(r.id).state === 'delivered');
  assert.equal(bCalls, 1, 'no summary without findings');
  assert.match(b.wakes[0].message, /^\[Deep research failed\].*none of the helpers finished: FAILED: no web tool/);
  // the summary worker failed (or was stopped): a failed report, never "finished"
  const c = makeRunner({ spawn: async (agent, w) => (w[0].label === 'Research summary' ? [res('Research summary', false, 'FAILED: provider down')] : [res('Research 1', true, 'A'), res('Research 2', true, 'B')]) });
  r = c.runner.start({ agent: 'a1', question: 'Q?', subQuestions: ['x', 'y'] });
  await until(() => c.runner.get(r.id).state === 'delivered');
  assert.match(c.wakes[0].message, /^\[Deep research failed\].*the summary did not finish: FAILED: provider down/);
  assert.doesNotMatch(c.wakes[0].message, /Deep research report ready/);
});

test('review r1: a run that takes longer than the deadline is ended and reported; the workers get an abort signal', async () => {
  let signal = null;
  const a = makeRunner({ deadlineMs: 20, spawn: async (agent, w, s) => { signal = s; return new Promise(() => {}); } });
  const r = a.runner.start({ agent: 'a1', question: 'Q?', subQuestions: SUBS });
  for (let i = 0; i < 200 && a.runner.get(r.id).state !== 'delivered'; i++) await new Promise((ok) => setTimeout(ok, 5));
  assert.match(a.wakes[0].message, /^\[Deep research failed\].*took longer than 0 minutes/);
  assert.equal(signal.aborted, true);
  // a new run for that agent can start again
  assert.equal(a.runner.start({ agent: 'a1', question: 'Q2?', subQuestions: SUBS }).ok, true);
});

test('review r1: the finished report is saved before delivery; a restart resumes it; after every try it is kept, not dropped', async () => {
  let saved = [];
  const store = { load: () => saved, save: (x) => { saved = JSON.parse(JSON.stringify(x)); } };
  let release;
  const gate = new Promise((r) => { release = r; });
  const a = makeRunner({ store, wake: async () => { await gate; throw new Error('busy'); } });
  const r = a.runner.start({ agent: 'a1', question: 'Q?', subQuestions: SUBS });
  await until(() => saved.some((x) => x.id === r.id && x.state === 'delivering'));
  assert.match(saved.find((x) => x.id === r.id).message, /^\[Deep research finished\][\s\S]*THE REPORT$/);
  // the hub restarts while the agent is busy: the saved report is delivered, not "cut short"
  const b = makeRunner({ store });
  b.runner.recover();
  await until(() => b.runner.get(r.id).state === 'delivered');
  assert.match(b.wakes[0].message, /^\[Deep research finished\][\s\S]*THE REPORT$/);
  assert.equal(saved.find((x) => x.id === r.id).message, null, 'delivered: the copy is dropped');
  release();
  // fast tries then slow tries; given up, the report stays in the saved runs
  let saved2 = [];
  const store2 = { load: () => saved2, save: (x) => { saved2 = JSON.parse(JSON.stringify(x)); } };
  const c = makeRunner({ store: store2, maxWakeTries: 2, slowTries: 2, retryMs: 5, slowRetryMs: 7, wake: async () => { throw new Error('busy'); } });
  const r2 = c.runner.start({ agent: 'a1', question: 'Q?', subQuestions: SUBS });
  await until(() => c.runner.get(r2.id).state === 'failed');
  assert.deepEqual(c.sleeps, [5, 7, 7]);
  assert.match(saved2.find((x) => x.id === r2.id).message, /THE REPORT$/);
});

// ── review r2: nothing sent after the deadline, placeholders, redelivery after a restart, a gone agent ──
test('review r2: a model lookup that ends after the deadline sends no work at all', async () => {
  let releasePick;
  let spawnCalls = 0;
  const a = makeRunner({ deadlineMs: 20, pickHelperModel: () => new Promise((r) => { releasePick = r; }), spawn: async () => { spawnCalls++; return [res('x', true, 'y')]; } });
  const r = a.runner.start({ agent: 'a1', question: 'Q?', subQuestions: SUBS });
  for (let i = 0; i < 200 && a.runner.get(r.id).state !== 'delivered'; i++) await new Promise((ok) => setTimeout(ok, 5));
  assert.match(a.wakes[0].message, /took longer than/);
  releasePick('claude-sdk/claude-test-fast');
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(spawnCalls, 0, 'no helper or summary dispatched after the deadline');
});

test('review r2: an empty, missing or stopped reply is not a result', async () => {
  const a = makeRunner({ spawn: async (agent, w) => (w[0].label === 'Research summary' ? [res('Research summary', true, '(empty reply)')] : [res('Research 1', true, '(no response)'), res('Research 2', true, 'real finding')]) });
  const r = a.runner.start({ agent: 'a1', question: 'Q?', subQuestions: ['x', 'y'] });
  await until(() => a.runner.get(r.id).state === 'delivered');
  assert.match(a.wakes[0].message, /^\[Deep research failed\].*the summary did not finish/);
});

test('review r2: a report whose delivery was given up is tried again after a restart; a gone agent is not retried for a day', async () => {
  let saved = [];
  const store = { load: () => saved, save: (x) => { saved = JSON.parse(JSON.stringify(x)); } };
  const a = makeRunner({ store, maxWakeTries: 2, retryMs: 1, wake: async () => { throw new Error('busy'); } });
  const r = a.runner.start({ agent: 'a1', question: 'Q?', subQuestions: SUBS });
  await until(() => a.runner.get(r.id).state === 'failed');
  const b = makeRunner({ store });
  b.runner.recover();
  await until(() => b.runner.get(r.id).state === 'delivered');
  assert.match(b.wakes[0].message, /THE REPORT$/);
  // the agent no longer exists: one try, then given up
  let tries = 0;
  const c = makeRunner({ maxWakeTries: 5, slowTries: 5, retryMs: 1, slowRetryMs: 1, wake: async () => { tries++; throw new Error('hub refused the wake-up turn (404)'); } });
  const r2 = c.runner.start({ agent: 'gone', question: 'Q?', subQuestions: SUBS });
  await until(() => c.runner.get(r2.id).state === 'failed');
  assert.equal(tries, 1);
});

// ── review r3: the report goes only to the agent that started the run ──
test('review r3: a report is never delivered to another agent given the same name; a model 404 is not "the agent is gone"', async () => {
  let who = 'owner:u_sam';
  let saved = [];
  const store = { load: () => saved, save: (x) => { saved = JSON.parse(JSON.stringify(x)); } };
  let release;
  const gate = new Promise((r) => { release = r; });
  const a = makeRunner({ store, stampOf: () => who, wake: async () => { await gate; throw new Error('busy'); } });
  const r = a.runner.start({ agent: 'helper-agent', question: 'Q?', subQuestions: SUBS });
  await until(() => saved.some((x) => x.id === r.id && x.state === 'delivering'));
  assert.equal(saved.find((x) => x.id === r.id).stamp, 'owner:u_sam');
  // the agent is deleted and its name given to another person's agent; the hub restarts
  who = 'owner:u_other';
  const b = makeRunner({ store, stampOf: () => who });
  b.runner.recover();
  await until(() => b.runner.get(r.id).state === 'failed');
  assert.equal(b.wakes.length, 0, 'not delivered to the new agent');
  assert.equal(b.runner.get(r.id).message, null, 'and the report is dropped');
  assert.match(b.runner.get(r.id).error, /gone or was replaced/);
  release();
  // an error that merely mentions 404 (a model call) keeps trying
  let tries = 0;
  const c = makeRunner({ maxWakeTries: 3, retryMs: 1, wake: async () => { tries++; if (tries < 3) throw new Error('upstream model returned 404'); } });
  const r2 = c.runner.start({ agent: 'a1', question: 'Q?', subQuestions: SUBS });
  await until(() => c.runner.get(r2.id).state === 'delivered');
  assert.equal(tries, 3);
});

// ── review r4: identity checked before each dispatch; a failed lookup is not "gone" ──
test('review r4: a run is not started when the agent can\'t be confirmed or does not exist', () => {
  const a = makeRunner({ stampOf: () => { throw new Error('unreadable'); } });
  const r = a.runner.start({ agent: 'sam-agent', question: 'Q?', subQuestions: SUBS });
  assert.equal(r.ok, false);
  assert.match(r.error, /Could not confirm which agent/);
  const b = makeRunner({ stampOf: () => null });
  const r2 = b.runner.start({ agent: 'sam-agent', question: 'Q?', subQuestions: SUBS });
  assert.equal(r2.ok, false);
  assert.equal(a.runner.list().length + b.runner.list().length, 0, 'nothing saved, nothing spawned');
  assert.equal(a.spawns.length + b.spawns.length, 0);
});

test('review r4: an agent replaced while the helpers work gets no summary worker and no report', async () => {
  let who = 'box:aaa';
  let release;
  const gate = new Promise((r) => { release = r; });
  const a = makeRunner({
    stampOf: () => who,
    spawn: async (agent, workers) => {
      a.spawns.push({ agent, workers });
      if (workers[0].label === 'Research summary') return 'THE REPORT';
      await gate;
      return 'FINDINGS';
    },
  });
  const r = a.runner.start({ agent: 'sam-agent', question: 'Q?', subQuestions: SUBS });
  await until(() => a.spawns.length === 1);
  who = 'box:bbb';   // deleted and re-made under the same name (same owner): a new box id
  release();
  await until(() => a.runner.get(r.id).state === 'failed');
  assert.equal(a.spawns.length, 1, 'no summary worker started');
  assert.equal(a.wakes.length, 0, 'nothing delivered to the new agent');
  assert.match(a.runner.get(r.id).error, /gone or was replaced/);
});

test('review r4: a lookup that fails at delivery keeps the report and delivers it to the same agent later', async () => {
  let fail = 2;
  let saved = [];
  const store = { load: () => saved, save: (x) => { saved = JSON.parse(JSON.stringify(x)); } };
  let deliveryStarted = false;
  const a = makeRunner({
    store, maxWakeTries: 5, retryMs: 1,
    stampOf: () => { if (deliveryStarted && fail > 0) { fail--; throw new Error('unreadable'); } return 'box:aaa'; },
    spawn: async (agent, workers) => { if (workers[0].label === 'Research summary') { deliveryStarted = true; return 'THE REPORT'; } return 'FINDINGS'; },
  });
  const r = a.runner.start({ agent: 'sam-agent', question: 'Q?', subQuestions: SUBS });
  await until(() => a.runner.get(r.id).state === 'delivered');
  assert.equal(fail, 0, 'the failed lookups happened');
  assert.equal(a.wakes.length, 1);
  assert.match(a.wakes[0].message, /THE REPORT/);
});

test('review r4: agentIdentityStrict: box id, else name (identityOf); a re-made agent differs; a settings edit does not; unreadable throws', () => {
  const { agentIdentityStrict } = require(path.join(ISO.inst, 'lib', 'agents.js'));
  const list = [
    { name: 'sam-agent', owner: 'u_sam', box: 'b1', model: 'm1' },
    { name: 'old-agent', owner: 'u_sam', model: 'm1' },
  ];
  assert.equal(agentIdentityStrict('sam-agent', { load: () => list }), 'box:b1');
  assert.equal(agentIdentityStrict('old-agent', { load: () => list }), 'name:old-agent');
  assert.equal(agentIdentityStrict('nobody', { load: () => list }), null);
  // a settings edit (the model) keeps it
  assert.equal(agentIdentityStrict('sam-agent', { load: () => [{ ...list[0], model: 'm2', blurb: 'x' }] }), 'box:b1');
  // deleted and re-made by the same owner: a new box id
  assert.notEqual(agentIdentityStrict('sam-agent', { load: () => [{ name: 'sam-agent', owner: 'u_sam', box: 'b2' }] }), 'box:b1');
  assert.throws(() => agentIdentityStrict('sam-agent', { load: () => [] }), /could not be read/);
  assert.throws(() => agentIdentityStrict('sam-agent', { load: () => null }), /could not be read/);
});

// ── review r5: a strict read for the identity, seeded agents with box ids, and a check as each worker starts ──
test('review r5: the runner hands the launcher an admit check that turns false once the agent is replaced', async () => {
  let who = 'box:aaa';
  const seen = [];
  const a = makeRunner({
    stampOf: () => who,
    spawn: async (agent, workers, signal, opts) => {
      seen.push(opts && opts.admit);
      if (workers[0].label === 'Research summary') {
        who = 'box:bbb';   // replaced after the runner's own check, while the launcher is still getting ready
        return opts.admit() ? 'THE REPORT' : [{ label: 'Research summary', ok: false, text: 'not started' }];
      }
      assert.equal(opts.admit(), true, 'the same agent is admitted');
      return 'FINDINGS';
    },
  });
  const r = a.runner.start({ agent: 'sam-agent', question: 'Q?', subQuestions: SUBS });
  await until(() => a.runner.get(r.id).state === 'failed');
  assert.equal(seen.length, 2);
  assert.ok(seen.every((f) => typeof f === 'function'), 'both dispatches carry admit');
  assert.equal(a.wakes.length, 0, 'nothing delivered to the new agent');
});

test('review r5: agentIdentityStrict reads agents.json itself: never the last good copy or the .bak, never a seed', () => {
  const agents = require(path.join(ISO.inst, 'lib', 'agents.js'));
  const f = path.join(ISO.inst, 'data', 'agents.json');
  fs.writeFileSync(f, JSON.stringify([{ name: 'sam-agent', owner: 'u_sam', box: 'b1' }]));
  assert.equal(agents.agentIdentityStrict('sam-agent'), 'box:b1');
  assert.equal(agents.agentIdentityStrict('nobody'), null);
  // unreadable now, with an older .bak that does not list the agent: "can't tell", never "gone"
  fs.writeFileSync(f + '.bak', JSON.stringify([{ name: 'other-agent', owner: 'u_sam', box: 'b9' }]));
  fs.writeFileSync(f, '{not json');
  assert.throws(() => agents.agentIdentityStrict('sam-agent'));
  // missing: "can't tell", and nothing is seeded
  fs.unlinkSync(f);
  assert.throws(() => agents.agentIdentityStrict('sam-agent'));
  assert.equal(fs.existsSync(f), false, 'no seed written');
  fs.unlinkSync(f + '.bak');
});

test('review r5: a first-run seed gives every seeded agent a box id of its own', () => {
  const iso2 = makeIsolatedInstall('research-seed-');
  const agents2 = require(path.join(iso2.inst, 'lib', 'agents.js'));
  agents2.getAgentsSync(true);
  const f = path.join(iso2.inst, 'data', 'agents.json');
  const first = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(first.length > 0);
  assert.ok(first.every((a) => typeof a.box === 'string' && /^[0-9a-f]{12}$/.test(a.box)), 'each has a box id');
  assert.equal(new Set(first.map((a) => a.box)).size, first.length, 'all different');
  // seeded again after a lost list: new box ids, so a saved report can't match the earlier agent
  fs.unlinkSync(f);
  agents2.getAgentsSync(true);
  const again = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const a of again) {
    const before = first.find((b) => b.name === a.name);
    if (before) assert.notEqual(a.box, before.box);
  }
});

// ── levels ──
test('setText: no always_level variant any more; the refusal names Settings and the phone sheet', () => {
  assert.match(research.ALWAYS_LEVEL_REFUSED, /^Only the person can choose which level Always yes runs, in Settings \(or the phone's Deep research sheet\)\. Tell them where\.$/);
  assert.doesNotMatch(research.setText(null, true, 'thorough'), /^Done: Always yes now runs/);
  assert.match(research.setText('always'), /^Done: research questions now get a deep research run/);
});

test('prefs: alwaysLevel defaults to quick, also for an old file without it', () => {
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify({ people: { u_sam: { choice: 'always', remindedAt: null } } }));
  const s = createResearchPrefs({ file: f });
  assert.deepEqual(LEVELS, ['quick', 'thorough']);
  assert.equal(s.alwaysLevelOf('u_sam'), 'quick');
  assert.equal(s.alwaysLevelOf('nobody'), 'quick');
  assert.equal(s.alwaysLevelOf(undefined), 'quick');
});

test('prefs: setAlwaysLevel validates, persists, and keeps the choice and the reminder clock', () => {
  const f = tmpFile();
  let t = 1000;
  const s = createResearchPrefs({ file: f, now: () => t });
  for (const k of ['', 5, null, 'x'.repeat(65)]) assert.throws(() => s.setAlwaysLevel(k, 'thorough'), (e) => e.code === 'bad_request');
  for (const v of ['both', '', 'Thorough', null, undefined, 1]) assert.throws(() => s.setAlwaysLevel('u_sam', v), (e) => e.code === 'bad_request', String(v));
  assert.equal(s.choiceOf('u_sam'), 'ask');
  s.setChoice('u_sam', 'never');   // remindedAt = 1000
  t = 5000;
  assert.equal(s.setAlwaysLevel('u_sam', 'thorough'), 'thorough');
  assert.equal(s.choiceOf('u_sam'), 'never');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).people.u_sam.remindedAt, 1000);
  assert.equal(createResearchPrefs({ file: f }).alwaysLevelOf('u_sam'), 'thorough');
  // a person with nothing stored yet keeps the default choice
  assert.equal(s.setAlwaysLevel('u_new', 'thorough'), 'thorough');
  assert.equal(s.choiceOf('u_new'), 'ask');
});

test('prefs: setChoice and markReminded keep an existing alwaysLevel', () => {
  const s = createResearchPrefs({ file: tmpFile() });
  s.setAlwaysLevel('u_sam', 'thorough');
  s.setChoice('u_sam', 'always');
  assert.equal(s.alwaysLevelOf('u_sam'), 'thorough');
  s.setChoice('u_sam', 'never');
  assert.equal(s.alwaysLevelOf('u_sam'), 'thorough');
  assert.equal(s.markReminded('u_sam'), true);
  assert.equal(s.alwaysLevelOf('u_sam'), 'thorough');
  s.setChoice('u_sam', 'ask');
  assert.equal(s.alwaysLevelOf('u_sam'), 'thorough');
});

test('runner: start() takes level quick (default) or thorough, refuses anything else, and stores run.level', async () => {
  const { runner } = makeRunner();
  const a = runner.start({ agent: 'a1', question: 'Q?', subQuestions: SUBS });
  assert.equal(a.ok, true);
  assert.equal(runner.get(a.id).level, 'quick');
  const b = runner.start({ agent: 'a2', question: 'Q?', subQuestions: SUBS, level: 'thorough' });
  assert.equal(b.ok, true);
  assert.equal(runner.get(b.id).level, 'thorough');
  for (const level of ['deep', 'Thorough', '', null, 5]) {
    const r = runner.start({ agent: 'a3', question: 'Q?', subQuestions: SUBS, level });
    assert.equal(r.ok, false, String(level));
    assert.equal(typeof r.error, 'string');
  }
  assert.equal(runner.list().length, 2);
});

// ── vendorOf, chooseHelperModel sameVendor, chooseReviewer ──
test('vendorOf: the company behind a model id', () => {
  const table = {
    'claude-sdk/claude-test-big': 'Anthropic', 'anthropic/test-a': 'Anthropic',
    'codex-cli/test-b': 'OpenAI', 'codex/test-b': 'OpenAI', 'openai/test-b': 'OpenAI',
    'google/test-c': 'Google', 'perplexity/test-d': 'Perplexity',
    'openrouter/x-ai/test-e': 'xAI', 'openrouter/deepseek/test-f': 'DeepSeek', 'openrouter/meta-llama/test-g': 'Meta', 'openrouter/z-ai/test-h': 'Z.ai', 'openrouter/acme/test-i': 'acme',
    'local/test-j': 'local', 'lmstudio/test-k': 'local', 'ollama/test-l': 'local', 'omlx/test-m': 'local', 'ninfer/test-n': 'local',
    'weirdhost/test-o': 'weirdhost',
  };
  for (const [m, v] of Object.entries(table)) assert.equal(research.vendorOf(m), v, m);
});

test('chooseHelperModel sameVendor: only models of the agent\'s own vendor; nothing fits -> the agent\'s own model', () => {
  const noteOf = () => 'fast and cheap';
  const allowed = ['openai/test-mini', 'google/test-lite', 'claude-sdk/claude-test-fast'];
  assert.equal(research.chooseHelperModel({ ownModel: 'openai/test-big', allowed, noteOf }), 'openai/test-mini');
  assert.equal(research.chooseHelperModel({ ownModel: 'anthropic/test-big', allowed: ['openai/test-mini', 'anthropic/test-lite'], noteOf, sameVendor: true }), 'anthropic/test-lite');
  assert.equal(research.chooseHelperModel({ ownModel: 'anthropic/test-big', allowed: ['openai/test-mini'], noteOf }), 'openai/test-mini', 'not required: as today');
  assert.equal(research.chooseHelperModel({ ownModel: 'anthropic/test-big', allowed: ['openai/test-mini', 'google/test-lite'], noteOf, sameVendor: true }), 'anthropic/test-big');
  // the same vendor across two prefixes (claude-sdk and anthropic)
  assert.equal(research.chooseHelperModel({ ownModel: BIG, allowed: ['openai/test-mini', 'claude-sdk/claude-test-fast'], noteOf, sameVendor: true }), 'claude-sdk/claude-test-fast');
});

test('chooseReviewer: kept on box -> own; another vendor with the same billing kind first; none -> own', () => {
  const own = 'claude-sdk/claude-test-big';   // subscription
  const kept = research.chooseReviewer({ ownModel: own, allowed: ['openai/test-x'], keptOnBox: true });
  assert.deepEqual(kept, { model: own, label: 'the same service as the agent (its content stays there)', crossVendor: false });
  // an API model comes first in the list, but the subscription model has the same billing kind as the agent's
  const r = research.chooseReviewer({ ownModel: own, allowed: [own, 'openai/test-api', 'codex-cli/test-sub', 'google/test-g'] });
  assert.equal(r.model, 'codex-cli/test-sub');
  assert.equal(r.label, 'a model from another vendor (OpenAI)');
  assert.equal(r.crossVendor, true);
  // no model of the same kind: any other vendor, never a local one
  const r2 = research.chooseReviewer({ ownModel: own, allowed: [own, 'lmstudio/test-l', 'google/test-g'] });
  assert.equal(r2.model, 'google/test-g');
  assert.equal(r2.label, 'a model from another vendor (Google)');
  assert.ok(!/google\/test-g/.test(r2.label), 'never a model id in the label');
  const none = research.chooseReviewer({ ownModel: own, allowed: [own, 'anthropic/test-other', 'ollama/test-l'] });
  assert.deepEqual(none, { model: own, label: 'the same service as the agent (no other vendor is available here)', crossVendor: false });
  assert.equal(research.chooseReviewer({ ownModel: own, allowed: [] }).model, own);
});

// ── the Thorough runner ──
const SRC_A = 'https://example.org/paper-a';
const SRC_B = 'https://example.org/paper-b';
const SRC_C = 'https://example.org/paper-c';
const BODY_MARK = 'SOURCE-BODY-MARKER';
const claimsBlock = (arr) => '```claims\n' + JSON.stringify(arr) + '\n```';
const REPORT = (extra = '') => '## Verdict\nMethod A wins.\n\n## Evidence\n- Method A scored 56.4% on the test (Paper A, ' + SRC_A + ', 2025).\n\n## Where sources disagree\nNone.\n\n## Confidence\nMedium: one benchmark.\n\n## Corrections to the first pass\nNone\n\n' + extra
  + claimsBlock([{ id: 'c1', claim: 'Method A scored 56.4% on the test', source_url: SRC_A, figures: ['56.4'], measured_result: '56.4%', judged_by: 'humans', evidence_strength: 'strong', inference: false }]);
const verdicts = (v) => '```json\n' + JSON.stringify([{ id: 'c1', verdict: v, reason: 'because' }]) + '\n```';
async function untilMs(fn, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 5)); } throw new Error('condition not reached'); }
const hang = (label) => (w, n, signal) => new Promise((_, rej) => { signal.addEventListener('abort', () => rej(new Error('stopped')), { once: true }); });

// Until lib/research-thorough exports checkReport / challengeSummary, the runner tests run on a stand-in built from the older functions.
const T_REAL = require(path.join(ISO.inst, 'lib', 'research-thorough.js'));
const LEGACY = {
  checkReport: ({ prose, claims, fetched }) => { const res = T_REAL.checkClaims(claims, fetched); return { prose: T_REAL.markProse(prose, T_REAL.verifiedFigures(res)).prose, claims: T_REAL.applyCheck(claims, res), totals: res.totals, notChecked: [], marks: [] }; },
  challengeSummary: (v) => {
    const counts = { supported: 0, partly: 0, not_supported: 0, cannot_check: 0 };
    for (const r of (v && v.results) || []) if (r.verdict in counts) counts[r.verdict]++;
    return { decisive: counts.supported + counts.partly + counts.not_supported, counts, uncheckedIds: [], doubtedIds: ((v && v.results) || []).filter((r) => r.verdict === 'not_supported' || r.verdict === 'partly').map((r) => r.id) };
  },
};
// claimKey / markUnverified come from the engine (lib/research-thorough); stand-ins until it has them
const STUBS = {
  ...(typeof T_REAL.claimKey === 'function' ? {} : { claimKey: (c) => String((c && c.claim) || '').toLowerCase().replace(/\s+/g, ' ').trim() + '|' + String((c && c.source_url) || '') }),
  ...(typeof T_REAL.markUnverified === 'function' ? {} : { markUnverified: (t) => String(t).replace(/\d+(?:\.\d+)?%?/g, (m) => m + ' [no source to check]') }),
};
const ENGINE = { ...(typeof T_REAL.checkReport === 'function' && typeof T_REAL.challengeSummary === 'function' ? {} : LEGACY), ...STUBS };

function makeThorough(over = {}) {
  const calls = [];       // every spawn call: { labels, model, tasks }
  const progress = [];
  const written = [];
  const saves = [];
  const script = over.script || {};   // label (without its number) -> (workers, count, signal) => results | undefined
  const counts = {};
  const spawn = async (agent, workers, signal) => {
    calls.push({ labels: workers.map((w) => w.label), model: workers[0].model, tasks: workers.map((w) => w.task), tools: workers.map((w) => w.tools), models: workers.map((w) => w.model), searchBoth: workers.map((w) => w.searchBoth === true) });
    const key = workers[0].label.replace(/ \d+$/, '');
    counts[key] = (counts[key] || 0) + 1;
    const f = script[key];
    if (f) { const r = await f(workers, counts[key], signal); if (r !== undefined) return r; }
    return workers.map((w) => {
      let text;
      if (/^Research \d+$/.test(w.label)) text = `Finding for ${w.label}. Method A scored 56.4%.\nSOURCES READ:\n- ${SRC_A}\n- ${SRC_B}\n- ${SRC_C}`;
      else if (w.label === 'Choose sources') text = '```json\n' + JSON.stringify([{ url: SRC_A, title: 'Paper A' }, { url: SRC_B, title: 'Paper B' }, { url: SRC_C, title: 'Paper C' }]) + '\n```';
      else if (/^Reader \d+$/.test(w.label)) text = `Notes for ${w.label}: Table 2 gives 56.4% (humans, 200 raters).`;
      else if (w.label === 'Research report') text = REPORT();
      else if (w.label === 'Reviewer') text = verdicts('supported');
      else if (w.label === 'Revision') text = REPORT('');
      else if (w.label === 'Research summary') text = 'QUICK SUMMARY';
      else text = 'x';
      return { label: w.label, ok: true, text };
    });
  };
  const fetchPage = over.fetchPage || (async (url) => ({ markdown: `${BODY_MARK} ${url} Method A scored 56.4% on the test with 200 raters.`, truncated: false, via: 'plain', title: 'T' }));
  const store = { load: () => [], save: (r) => { saves.push(JSON.stringify(r)); } };
  const m = makeRunner({
    store, spawn, fetchPage, engine: ENGINE,
    thoroughSettings: () => ({ maxSources: 12, readersAtOnce: 2, reviewRounds: 2, timeLimitMinutes: 60, pdf: true, readerModel: 'own' }),
    pickReviewer: async () => ({ model: 'openai/test-reviewer', label: 'a model from another vendor (OpenAI)', crossVendor: true }),
    pickReaderModel: async () => 'claude-sdk/claude-test-reader',
    writeDocument: async (agent, base, doc) => { written.push({ agent, base, doc }); return { md: `/files/research/${base}.md`, html: `/files/research/${base}.html`, pdf: '', pdfError: 'no Chrome or Chromium on this computer; the document is in Markdown and HTML' }; },
    onProgress: (r) => { progress.push({ stage: r.stage, label: r.stageLabel, done: r.stageDone, total: r.stageTotal, state: r.state }); },
    ...over.deps,
  });
  return { ...m, calls, progress, written, saves };
}
const startThorough = (m, subs = SUBS) => m.runner.start({ agent: 'a1', question: 'Which method is best?', subQuestions: subs, level: 'thorough' });

test('thorough runner: the stages in order with the right models, progress in order, document, one wake', async () => {
  const m = makeThorough();
  const r = startThorough(m);
  await until(() => m.runner.get(r.id).state === 'delivered');
  assert.deepEqual(m.calls.map((c) => c.labels[0]), ['Research 1', 'Choose sources', 'Reader 1', 'Research report', 'Reviewer']);
  assert.equal(m.calls[0].labels.length, 3);
  assert.equal(m.calls[0].model, FAST, 'helpers: the helper model');
  assert.equal(m.calls[1].model, BIG, 'selection: the agent\'s own model');
  // 3 sources -> 2 groups of at most 2; readersAtOnce 2 -> both groups in one spawn call
  assert.deepEqual(m.calls[2].labels, ['Reader 1', 'Reader 2']);
  assert.equal(m.calls[2].model, 'claude-sdk/claude-test-reader');
  assert.equal(m.calls[3].model, BIG);
  assert.equal(m.calls[4].model, 'openai/test-reviewer');
  assert.match(m.calls[2].tasks[0], /careful reader/);
  // the stages the progress line saw, in order, without going back
  const seen = m.progress.map((p) => p.stage).filter((s, i, a) => s && s !== a[i - 1]);
  assert.deepEqual(seen, ['quick', 'select', 'fetch', 'read', 'synthesis', 'check', 'challenge', 'document']);
  assert.equal(m.progress[0].state, 'running');
  assert.equal(m.progress[m.progress.length - 1].state, 'delivered');
  assert.ok(m.progress.some((p) => p.stage === 'read' && p.done === 2 && p.total === 2));
  assert.match(m.progress.find((p) => p.stage === 'read' && p.done === 0).label, /reading sources in full \(0 of 2\)/);
  // the document
  assert.equal(m.written.length, 1);
  assert.match(m.written[0].base, /^deep-research-\d{4}-\d{2}-\d{2}-which-method-is-best$/);
  assert.match(m.written[0].doc.markdown, /## Traceability/);
  // the message
  assert.equal(m.wakes.length, 1);
  const msg = m.wakes[0].message;
  assert.ok(msg.startsWith('[Deep research finished]'));
  assert.match(msg, /the figure-check line, which reviewer was used, and the document path/);
  // r8: the claim figure and the figure in the report text are both counted, both found as written in the fetched text
  assert.match(msg, /In the source \(checked by code against the fetched text\): 2 found as written; 0 not found as written \(marked "not found in source"\); 0 from sources that could not be opened \(marked "source not opened"\); 0 with no source to check\./);
  assert.match(msg, /Challenged by: a model from another vendor \(OpenAI\) \(1 round\)/);
  assert.match(msg, /Full document: \/files\/research\/deep-research-.*\.md/);
  assert.doesNotMatch(msg.split('Report:\n')[1], /Not finished/);
  const run = m.runner.get(r.id);
  assert.equal(run.rounds, 1);
  assert.equal(run.reviewer, 'a model from another vendor (OpenAI)');
  assert.deepEqual(run.missing, []);
  assert.equal(run.checkTotals.found, 1);
  assert.equal(run.sources.length, 3);
  assert.deepEqual(Object.keys(run.sources[0]).sort(), ['chars', 'error', 'ok', 'title', 'url', 'via']);
  assert.equal(run.claims[0].check, '1 of 1 found as written');
});

test('thorough runner: readers go in batches of readersAtOnce groups, one spawn call per batch', async () => {
  const m = makeThorough({ deps: { thoroughSettings: () => ({ maxSources: 12, readersAtOnce: 1, reviewRounds: 0, timeLimitMinutes: 60, pdf: false, readerModel: 'own' }) } });
  const r = startThorough(m);
  await until(() => m.runner.get(r.id).state === 'delivered');
  const reads = m.calls.filter((c) => /^Reader/.test(c.labels[0]));
  assert.deepEqual(reads.map((c) => c.labels), [['Reader 1'], ['Reader 2']]);
  assert.ok(!m.calls.some((c) => c.labels[0] === 'Reviewer'), 'reviewRounds 0: no reviewer');
  assert.match(m.wakes[0].message, /Challenged by: no one/);
});

test('thorough runner: a claim the reviewer does not support is revised, the figures are checked again, a second round confirms', async () => {
  let reviews = 0;
  const m = makeThorough({ script: { Reviewer: () => { reviews++; return [{ label: 'Reviewer', ok: true, text: verdicts(reviews === 1 ? 'not_supported' : 'supported') }]; } } });
  const r = startThorough(m);
  await until(() => m.runner.get(r.id).state === 'delivered');
  assert.deepEqual(m.calls.map((c) => c.labels[0]).slice(3), ['Research report', 'Reviewer', 'Revision', 'Reviewer']);
  assert.equal(m.calls[5].model, BIG, 'the revision: the agent\'s own model');
  assert.equal(m.calls[6].model, 'openai/test-reviewer');
  assert.match(m.calls[5].tasks[0], /\[not_supported\]/);
  assert.equal(m.runner.get(r.id).rounds, 2);
  assert.match(m.wakes[0].message, /\(2 rounds\)/);
});

test('thorough runner: a revision that cannot be read keeps the previous report and says what stayed in doubt', async () => {
  const m = makeThorough({ script: { Reviewer: () => [{ label: 'Reviewer', ok: true, text: verdicts('partly') }], Revision: () => [{ label: 'Revision', ok: true, text: 'no block here' }] } });
  const r = startThorough(m);
  await until(() => m.runner.get(r.id).state === 'delivered');
  const run = m.runner.get(r.id);
  assert.ok(run.missing.some((x) => /report could not be revised/.test(x)));
  assert.match(m.written[0].doc.markdown, /Not settled by the review/);
  assert.match(m.wakes[0].message, /Missing: .*could not be revised/);
});

test('thorough runner: a failing stage goes into missing and the run still delivers (select, fetch, read, document)', async () => {
  const m = makeThorough({
    // the chooser fails AND the helpers named no source: nothing to fall back on
    script: { 'Choose sources': () => { throw new Error('the workers refused'); }, Research: (workers) => workers.map((w) => ({ label: w.label, ok: true, text: `Finding for ${w.label}, no links given.` })) },
    deps: { writeDocument: async () => { throw new Error('disk full'); } },
  });
  const r = startThorough(m);
  await until(() => m.runner.get(r.id).state === 'delivered');
  const run = m.runner.get(r.id);
  assert.ok(run.missing.some((x) => /^select \(.*refused/.test(x)), JSON.stringify(run.missing));
  assert.ok(run.missing.some((x) => /^document \(disk full\)/.test(x)));
  assert.ok(!m.calls.some((c) => /^Reader/.test(c.labels[0])), 'no sources: no readers');
  assert.ok(m.calls.some((c) => c.labels[0] === 'Research report'), 'synthesis from the first pass');
  assert.match(m.wakes[0].message, /Missing: select/);
  assert.match(m.wakes[0].message, /No PDF: /);
  // fetch failing for every source and every reader failing
  const m2 = makeThorough({ fetchPage: async () => { throw new Error('blocked'); }, script: { Reader: () => [{ label: 'Reader 1', ok: false, text: 'it failed' }, { label: 'Reader 2', ok: false, text: 'it failed' }] } });
  const r2 = startThorough(m2);
  await until(() => m2.runner.get(r2.id).state === 'delivered');
  const miss = m2.runner.get(r2.id).missing;
  assert.ok(miss.some((x) => /^fetch \(no source could be opened/.test(x)));
  assert.ok(miss.some((x) => /^read \(no reader finished\)/.test(x)));
  assert.ok(m2.calls.some((c) => c.labels[0] === 'Research report'));
  assert.ok(!m2.calls.some((c) => c.labels[0] === 'Reviewer'), 'no source opened: nothing to check against');
  assert.ok(miss.some((x) => /^challenge \(no source was opened/.test(x)));
});

test('thorough runner: a report without a claims block is asked for once more, then delivered without the table', async () => {
  const m = makeThorough({ script: { 'Research report': () => [{ label: 'Research report', ok: true, text: '## Verdict\nMethod A wins, no claims block.' }] } });
  const r = startThorough(m);
  await until(() => m.runner.get(r.id).state === 'delivered');
  const reports = m.calls.filter((c) => c.labels[0] === 'Research report');
  assert.equal(reports.length, 2);
  assert.match(reports[1].tasks[0], /Your reply had no valid claims block; reply again in the same format\.$/);
  assert.doesNotMatch(reports[0].tasks[0], /Your reply had no valid claims block/);
  const run = m.runner.get(r.id);
  assert.ok(run.missing.includes('traceability table (the report had no valid claims list)'));
  assert.deepEqual(run.claims, []);
  assert.match(m.wakes[0].message, /Method A wins/);
  assert.match(m.wakes[0].message, /Missing: traceability table/);
  assert.ok(m.written.length === 1, 'the document is still written');
});

test('thorough runner: the synthesis failing twice falls back to the first-pass summary as the report', async () => {
  const m = makeThorough({ script: { 'Research report': () => [{ label: 'Research report', ok: false, text: 'boom' }] } });
  const r = startThorough(m);
  await until(() => m.runner.get(r.id).state === 'delivered');
  assert.equal(m.calls.filter((c) => c.labels[0] === 'Research report').length, 2);
  assert.ok(m.calls.some((c) => c.labels[0] === 'Research summary'));
  assert.match(m.wakes[0].message, /QUICK SUMMARY/);
  assert.ok(m.runner.get(r.id).missing.some((x) => /^synthesis \(/.test(x)));
});

test('thorough runner: the deadline in the middle of reading delivers a partial report starting "Not finished:"', async () => {
  const m = makeThorough({
    deps: { thoroughSettings: () => ({ maxSources: 12, readersAtOnce: 2, reviewRounds: 2, timeLimitMinutes: 0.01, pdf: true, readerModel: 'own' }) },
    script: { Reader: hang() },
  });
  const r = startThorough(m);
  await untilMs(() => m.runner.get(r.id).state === 'delivered');
  assert.equal(m.wakes.length, 1);
  const msg = m.wakes[0].message;
  assert.ok(msg.startsWith('[Deep research finished]'));
  const report = msg.split('Report:\n')[1];
  assert.match(report.split('\n')[0], /^Not finished: reading sources in full, writing the report, checking figures, checking the report, writing the document \(the time limit of 0\.01 minutes was reached\)\.$/);
  assert.match(report, /First-pass findings/);
  assert.match(report, /Finding for Research 1/);
  assert.doesNotMatch(msg, /\[Deep research failed\]/);
  // no later stage ran after the deadline
  await tick(); await tick();
  assert.ok(!m.calls.some((c) => c.labels[0] === 'Research report'));
  assert.equal(m.runner.get(r.id).state, 'delivered');
});

test('thorough runner: a deadline after the report was written delivers the saved report, not the findings', async () => {
  const m = makeThorough({
    deps: { thoroughSettings: () => ({ maxSources: 12, readersAtOnce: 2, reviewRounds: 2, timeLimitMinutes: 0.01, pdf: true, readerModel: 'own' }) },
    script: { Reviewer: hang() },
  });
  const r = startThorough(m);
  await untilMs(() => m.runner.get(r.id).state === 'delivered');
  const report = m.wakes[0].message.split('Report:\n')[1];
  assert.match(report.split('\n')[0], /^Not finished: checking the report, writing the document \(the time limit/);
  assert.match(report, /Method A wins/);
  assert.match(report, /In the source \(checked by code against the fetched text\): 2 found as written; 0 not found as written/);
});

test('thorough runner: recover() delivers "[Deep research interrupted]" with the saved prose, else the reader notes, else the findings', async () => {
  const base = { agent: 'a1', stamp: null, question: 'Q?', subQuestions: SUBS, level: 'thorough', state: 'running', startedAt: 1, endedAt: null, error: null, stage: 'read', missing: ['select (x)'], stagesDone: ['quick', 'select'] };
  const mk = (extra, id) => ({ ...base, id, ...extra });
  const runs = [
    mk({ prose: '## Verdict\nSaved verdict.', claims: [] }, 'dr-00000001'),
    mk({ readerNotes: ['Notes: Table 2 gives 12.5.'], findings: ['F1'] }, 'dr-00000002'),
    mk({ findings: ['### Research 1\nSaved finding.'] }, 'dr-00000003'),
    { ...base, id: 'dr-00000004', level: 'quick', subQuestions: SUBS },
  ];
  let saved = JSON.parse(JSON.stringify(runs));
  const store = { load: () => saved, save: (r) => { saved = JSON.parse(JSON.stringify(r)); } };
  const m = makeRunner({ store, maxRunning: 10 });
  m.runner.recover();
  await until(() => m.wakes.length === 4);
  const by = (id) => m.wakes.map((w) => w.message).find((x) => x.includes(`(id ${id})`));
  assert.ok(by('dr-00000001').startsWith('[Deep research interrupted]'));
  assert.match(by('dr-00000001'), /Saved verdict\./);
  assert.match(by('dr-00000001'), /Not done: fetching the source texts, reading sources in full, writing the report/);
  assert.match(by('dr-00000001'), /Missing: select \(x\)/);
  assert.ok(by('dr-00000002').startsWith('[Deep research interrupted]'));
  assert.match(by('dr-00000002'), /Table 2 gives 12\.5/);
  assert.match(by('dr-00000003'), /Saved finding\./);
  assert.ok(by('dr-00000004').startsWith('[Deep research failed]'), 'quick runs keep the cut short message');
  assert.match(by('dr-00000004'), /restarted while it ran/);
});

test('quick runner: unchanged result; it reports the stages quick (helpers done of total) and writing', async () => {
  const progress = [];
  const { runner, wakes, spawns } = makeRunner({ onProgress: (r) => progress.push({ stage: r.stage, done: r.stageDone, total: r.stageTotal, label: r.stageLabel, state: r.state }) });
  const r = runner.start({ agent: 'a1', question: 'Q?', subQuestions: SUBS });
  await until(() => runner.get(r.id).state === 'delivered');
  assert.equal(spawns.length, 2);
  assert.ok(wakes[0].message.endsWith('Report:\nTHE REPORT'));
  assert.match(wakes[0].message, /Present its report to the person now/);
  const seen = progress.map((p) => p.stage).filter((s, i, a) => s && s !== a[i - 1]);
  assert.deepEqual(seen, ['quick', 'writing']);
  assert.ok(progress.some((p) => p.stage === 'quick' && p.done === 0 && p.total === 3));
  assert.ok(progress.some((p) => p.stage === 'quick' && p.done === 3 && p.total === 3 && /3 of 3 helpers/.test(p.label)));
  assert.equal(progress[progress.length - 1].state, 'delivered');
  const run = runner.get(r.id);
  assert.equal(run.stage, 'writing');
  assert.equal(run.stageTotal, 1);
  assert.equal(run.findings.length, 1, 'the stand-in gives one reply');
  assert.equal(runner.list()[0].level, 'quick');
});

test('runner: a progress callback that throws never stops a run; a failed run reports state failed', async () => {
  const m = makeRunner({ onProgress: () => { throw new Error('ui is down'); } });
  const r = m.runner.start({ agent: 'a1', question: 'Q?', subQuestions: SUBS });
  await until(() => m.runner.get(r.id).state === 'delivered');
  assert.equal(m.wakes.length, 1);
  const seen = [];
  const bad = makeRunner({ spawn: async () => '[spawn_workers] refused', onProgress: (x) => seen.push(x.state), maxWakeTries: 1, wake: async () => { throw new Error('nobody home'); } });
  const r2 = bad.runner.start({ agent: 'a1', question: 'Q?', subQuestions: SUBS });
  await until(() => bad.runner.get(r2.id).state === 'failed');
  assert.equal(seen[seen.length - 1], 'failed');
});

test('thorough runner: nothing saved contains a source text; the identity check covers every new spawn', async () => {
  const m = makeThorough();
  const r = startThorough(m);
  await until(() => m.runner.get(r.id).state === 'delivered');
  assert.ok(m.saves.length > 8, 'saved after each stage');
  for (const s of m.saves) assert.ok(!s.includes(BODY_MARK), 'no source text in the saved runs');
  assert.ok(!JSON.stringify(m.runner.get(r.id)).includes(BODY_MARK));
  // admit is passed with every spawn
  const seenAdmit = [];
  const m2 = makeThorough({ deps: { spawn: async (a, w, sig, opts) => { seenAdmit.push(typeof (opts && opts.admit)); return w.map((x) => ({ label: x.label, ok: true, text: 'x' })); } } });
  const r2 = startThorough(m2);
  await until(() => m2.runner.get(r2.id).state === 'delivered');
  assert.ok(seenAdmit.length >= 2 && seenAdmit.every((t) => t === 'function'));
});

test('thorough runner: an agent replaced during the run gets nothing from the new stages', async () => {
  let who = 'stamp-1';
  const m = makeThorough({ deps: { stampOf: () => who } });
  const r = startThorough(m);
  who = 'stamp-2';
  await until(() => m.runner.get(r.id).state === 'failed');
  assert.equal(m.calls.length, 0, 'not a single worker was started');
  assert.equal(m.wakes.length, 0);
});

test('reportMessage: thorough says what to present; interrupted says what was saved', () => {
  const t = research.reportMessage({ id: 'dr-1', question: 'Q?', report: 'R', level: 'thorough' });
  assert.match(t, /the figure-check line, which reviewer was used, and the document path\. Keep every link and keep the document path\./);
  const q = research.reportMessage({ id: 'dr-1', question: 'Q?', report: 'R' });
  assert.doesNotMatch(q, /figure-check/);
  const i = research.reportMessage({ id: 'dr-1', question: 'Q?', report: 'SAVED', interrupted: true });
  assert.ok(i.startsWith('[Deep research interrupted] "Q?" (id dr-1).'));
  assert.ok(i.endsWith('Saved so far:\nSAVED'));
});

// ── helpers and readers search with the hub's search too (setting researchHelperSearch = both) ──
test('runner: helpers and readers carry searchBoth only when helperSearchBoth() is true; never the summary, the choice, the reviewer or the report', async () => {
  const collect = async (both) => {
    const jobs = [];
    const m = makeThorough({ deps: {
      helperSearchBoth: both === undefined ? undefined : () => both,
      spawn: async (agent, workers) => {
        for (const w of workers) jobs.push(w);
        return workers.map((w) => ({ label: w.label, ok: true, text: (/^Research \d+$/.test(w.label) ? `Finding.\nSOURCES READ:\n- ${SRC_A}\n- ${SRC_B}` : w.label === 'Choose sources' ? '```json\n' + JSON.stringify([{ url: SRC_A, title: 'A' }, { url: SRC_B, title: 'B' }]) + '\n```' : w.label === 'Reviewer' ? verdicts('supported') : w.label === 'Research report' ? REPORT() : 'Notes: 56.4%.') }));
      },
    } });
    const r = startThorough(m);
    await until(() => m.runner.get(r.id).state === 'delivered');
    return jobs;
  };
  const on = await collect(true);
  const marked = on.filter((j) => j.searchBoth === true).map((j) => j.label);
  assert.ok(marked.includes('Research 1') && marked.includes('Reader 1'));
  assert.deepEqual(on.filter((j) => j.searchBoth !== undefined && !/^(Research \d+|Reader \d+)$/.test(j.label)), [], 'only helpers and readers');
  assert.ok(on.some((j) => j.label === 'Choose sources') && on.some((j) => j.label === 'Reviewer'));
  for (const off of [false, undefined]) {
    const j = await collect(off);
    assert.ok(j.length >= 4);
    assert.ok(j.every((x) => !('searchBoth' in x)), 'no job is marked when the setting is not both');
  }
  // a quick run: the helpers are marked, the summary is not
  const jobs = [];
  const q = makeRunner({ helperSearchBoth: () => true, spawn: async (agent, workers) => { jobs.push(...workers); return workers.length === 1 && workers[0].label === 'Research summary' ? 'THE REPORT' : 'FINDINGS'; } });
  q.runner.start({ agent: 'a1', question: 'Q?', subQuestions: SUBS });
  await until(() => q.wakes.length === 1);
  assert.deepEqual(jobs.filter((j) => j.searchBoth).map((j) => j.label), ['Research 1', 'Research 2', 'Research 3']);
  assert.ok(!jobs.find((j) => j.label === 'Research summary').searchBoth);
});

// ── review r2-B: figure check everywhere, challenge credit, select fallback, least privilege, kept content, local reviewer ──
const doneRun = async (m, subs) => { const r = startThorough(m, subs); await until(() => ['delivered', 'failed'].includes(m.runner.get(r.id).state)); return m.runner.get(r.id); };
const spyEngine = () => {
  const seen = { check: [], chat: [] };
  const real = T_REAL;
  const engine = {
    checkReport: (a) => { seen.check.push({ ...a, claims: [...(a.claims || [])] }); return real.checkReport ? real.checkReport(a) : LEGACY.checkReport(a); },
    chatReport: (a) => { seen.chat.push(a); return real.chatReport(a); },
  };
  return { engine, seen };
};

test('r2 1: checkReport runs on every report, with counts; a revision checks again with the round; a report with no claims block is checked with claims []', async () => {
  const { engine, seen } = spyEngine();
  let reviews = 0;
  const m = makeThorough({ deps: { engine: { ...ENGINE, ...engine } }, script: { Reviewer: () => { reviews++; return [{ label: 'Reviewer', ok: true, text: verdicts(reviews === 1 ? 'not_supported' : 'supported') }]; } } });
  await doneRun(m);
  assert.ok(seen.check.length >= 2);
  assert.deepEqual(seen.check[0].counts, { sourcesSelected: 3, sourcesOpened: 3, claims: 1, rounds: 0 });
  assert.equal(seen.check[seen.check.length - 1].counts.rounds, 1, 'the check after the revision knows a round happened');
  // no claims block at all: the quick summary of the first pass stands in; every figure goes through the check with no claims
  const s2 = spyEngine();
  const m2 = makeThorough({ deps: { engine: { ...ENGINE, ...s2.engine } }, script: { 'Research report': () => [{ label: 'Research report', ok: false, text: '(no response)' }], 'Research summary': () => [{ label: 'Research summary', ok: true, text: 'Summary: Method A scored 56.4% on the test.' }] } });
  const run2 = await doneRun(m2);
  assert.equal(run2.state, 'delivered');
  const last = s2.seen.check[s2.seen.check.length - 1];
  assert.deepEqual(last.claims, []);
  assert.match(last.prose, /56\.4/);
  assert.ok(run2.missing.some((x) => /^synthesis/.test(x)));
  assert.match(m2.wakes[0].message, /Method A scored 56\.4%/);
});

test('r2 1 / r3 4: a run cut short by a restart is not checked against nothing: figures marked unverified, interruptedBeforeCheck', async () => {
  const { engine, seen } = spyEngine();
  const base = { id: 'dr-cut1', agent: 'a1', stamp: null, question: 'Q?', subQuestions: ['a', 'b'], level: 'thorough', state: 'running', stage: 'check', stageLabel: '', stageDone: 0, stageTotal: 0, startedAt: 1, endedAt: null, error: null, stagesDone: ['quick', 'select', 'fetch', 'read', 'synthesis'], missing: [], findings: ['f'], prose: 'Method A scored 56.4% on the test.', claims: [] };
  const b = makeRunner({ store: { load: () => [{ ...base }], save() {} }, engine: { ...ENGINE, ...engine } });
  b.runner.recover();
  await until(() => b.wakes.length === 1);
  // r3 4: after a restart there are no source texts: nothing is checked against nothing; r8: the check did not run, so the figures say "not checked"
  assert.equal(seen.check.length, 0, 'no check against an empty source list');
  assert.equal(seen.chat[0].interrupted, true);
  assert.equal(seen.chat[0].interruptedBeforeCheck, true);
  assert.match(seen.chat[0].prose, /56\.4% \[not checked\]/);
  assert.doesNotMatch(b.wakes[0].message, /unopened|not opened/i);
  // saved after its check (checked: true): not checked a second time, the doubted ids and review counts survive the restart
  const { engine: e2, seen: s2 } = spyEngine();
  const done = { ...base, id: 'dr-cut2', checked: true, rounds: 1, reviewer: 'X', doubtedIds: ['c1'], review: { label: 'X', rounds: 1, counts: { supported: 1, partly: 1, not_supported: 0, cannot_check: 0 }, uncheckedIds: [], failed: '' }, claims: [{ id: 'c1', claim: 'Method A scored 56.4% on the test', source_url: SRC_A, figures: ['56.4'] }] };
  const c = makeRunner({ store: { load: () => [done], save() {} }, engine: { ...ENGINE, ...e2 } });
  c.runner.recover();
  await until(() => c.wakes.length === 1);
  assert.equal(s2.check.length, 0);
  assert.deepEqual(s2.chat[0].doubtedIds, ['c1']);
  assert.equal(s2.chat[0].review.counts.partly, 1);
});

test('r2 2: a round with no decisive verdict is not credited, goes into missing, and stops the challenge', async () => {
  const cannot = '```json\n' + JSON.stringify([{ id: 'c1', verdict: 'cannot_check', reason: 'no excerpt' }]) + '\n```';
  const m = makeThorough({ script: { Reviewer: () => [{ label: 'Reviewer', ok: true, text: cannot }] } });
  const run = await doneRun(m);
  assert.equal(run.rounds, 0, 'not credited');
  assert.equal(m.calls.filter((c) => c.labels[0] === 'Reviewer').length, 1, 'the challenge stopped');
  assert.ok(!m.calls.some((c) => c.labels[0] === 'Revision'));
  assert.ok(run.missing.includes('challenge: the reviewer gave no usable verdicts'), JSON.stringify(run.missing));
  assert.ok(!run.stagesDone.includes('challenge'));
  assert.match(m.wakes[0].message, /Not challenged: the reviewer gave no usable verdicts/);
  assert.doesNotMatch(m.wakes[0].message, /Challenged by/);
});

test('r2 2: a revision that fails keeps the doubted ids; they and the review counts reach the report and the saved run', async () => {
  const { engine, seen } = spyEngine();
  const m = makeThorough({
    deps: { engine: { ...ENGINE, ...engine } },
    script: { Reviewer: () => [{ label: 'Reviewer', ok: true, text: verdicts('partly') }], Revision: () => [{ label: 'Revision', ok: true, text: 'no claims block here' }] },
  });
  const run = await doneRun(m);
  const rep = seen.chat[seen.chat.length - 1];
  assert.deepEqual(rep.doubtedIds, ['c1']);
  assert.equal(rep.review.rounds, 1);
  assert.equal(rep.review.counts.partly, 1);
  assert.deepEqual(rep.review.uncheckedIds, []);
  assert.deepEqual(run.doubtedIds, ['c1'], 'persisted for a restart');
  assert.equal(run.review.counts.partly, 1);
  assert.ok(m.saves.some((x) => /"doubtedIds":\["c1"\]/.test(x)));
  assert.match(m.wakes[0].message, /doubted/i);
});

test('r2 3: a source choice that fails or is unusable falls back to the sources the helpers listed; only nothing at all is missing', async () => {
  for (const choose of [() => { throw new Error('refused'); }, () => [{ label: 'Choose sources', ok: true, text: 'I cannot choose.' }]]) {
    const m = makeThorough({ script: { 'Choose sources': choose } });
    const run = await doneRun(m);
    assert.ok(!run.missing.some((x) => /^select/.test(x)), JSON.stringify(run.missing));
    assert.ok(run.stagesDone.includes('select'));
    assert.ok(m.calls.some((c) => /^Reader/.test(c.labels[0])), 'the fallback sources were read');
    assert.equal(run.sources.length, 3);
  }
});

test("r2 4: select, synthesis, revision and the quick-summary fallback get tools 'none'; helpers, readers and the reviewer keep 'read'", async () => {
  let reviews = 0;
  const m = makeThorough({ script: {
    Reviewer: () => { reviews++; return [{ label: 'Reviewer', ok: true, text: verdicts(reviews === 1 ? 'not_supported' : 'supported') }]; },
  } });
  await doneRun(m);
  const toolsOf = (label) => m.calls.filter((c) => c.labels[0].startsWith(label)).flatMap((c) => c.tools);
  assert.deepEqual([...new Set(toolsOf('Choose sources'))], ['none']);
  assert.deepEqual([...new Set(toolsOf('Research report'))], ['none']);
  assert.deepEqual([...new Set(toolsOf('Revision'))], ['none']);
  for (const l of ['Research 1', 'Reader', 'Reviewer']) assert.deepEqual([...new Set(toolsOf(l))], ['read'], l);
  const f = makeThorough({ script: { 'Research report': () => [{ label: 'Research report', ok: false, text: '(no response)' }] } });
  await doneRun(f);
  assert.deepEqual([...new Set(f.calls.filter((c) => c.labels[0] === 'Research summary').flatMap((c) => c.tools))], ['none'], 'the fallback summary');
  // and the worker launcher accepts it
  const tw = require(path.join(ISO.inst, 'lib', 'temporal-workers.js'));
  const norm = tw.normalizeJobs([{ task: 'a task long enough to count', model: BIG, tools: 'none', label: 'x' }], { available: [BIG], callerModel: BIG });
  assert.equal(norm.error, undefined);
  assert.equal(norm.jobs[0].toolScope, 'none');
});

test('r2 5: an agent whose content must stay on its service: every worker uses its own model, no searchBoth, an unknown lookup counts as kept', async () => {
  for (const keptOnBox of [() => true, () => { throw new Error('lookup failed'); }, () => undefined]) {
    const m = makeThorough({ deps: { keptOnBox, helperSearchBoth: () => true } });
    await doneRun(m);
    assert.ok(m.calls.length >= 5);
    for (const c of m.calls) {
      assert.deepEqual([...new Set(c.models)], [BIG], c.labels.join(','));
      assert.ok(c.searchBoth.every((x) => x === false), 'no second search for ' + c.labels.join(','));
    }
  }
  // an agent that may send content out: the helper, reader and reviewer models are used, and searchBoth marks helpers and readers
  const open = makeThorough({ deps: { keptOnBox: () => false, helperSearchBoth: () => true } });
  await doneRun(open);
  assert.equal(open.calls[0].model, FAST);
  assert.deepEqual(open.calls[0].searchBoth, [true, true, true]);
  assert.equal(open.calls.find((c) => c.labels[0] === 'Reviewer').model, 'openai/test-reviewer');
  assert.ok(open.calls.find((c) => c.labels[0] === 'Reviewer').searchBoth.every((x) => !x));
});

test('r2 6: chooseReviewer for an agent on a local model: a local reviewer, never a cloud one', () => {
  const own = 'lmstudio/qwen-own';
  const cloud = ['claude-sdk/claude-test-big', 'openai/gpt-x'];
  assert.deepEqual(research.chooseReviewer({ ownModel: own, allowed: [...cloud, 'ollama/llama-other'] }), { model: 'ollama/llama-other', label: 'a model on this computer (its content stays here)', crossVendor: false });
  const none = research.chooseReviewer({ ownModel: own, allowed: cloud });
  assert.equal(none.model, own);
  assert.equal(none.crossVendor, false);
  assert.equal(research.chooseReviewer({ ownModel: own, allowed: [] }).model, own);
  // a cloud agent is unchanged
  assert.equal(research.chooseReviewer({ ownModel: 'claude-sdk/claude-test-big', allowed: cloud }).crossVendor, true);
});

test('r2 10: the runner owns the data-leak rule: a kept agent ignores a helper, reader or reviewer model the lookups chose', async () => {
  const m = makeThorough({ deps: { keptOnBox: () => true, pickHelperModel: async () => 'openrouter/openai/x', pickReaderModel: async () => 'openrouter/openai/y', pickReviewer: async () => ({ model: 'google/z', label: 'g', crossVendor: true }) } });
  await doneRun(m);
  assert.ok(m.calls.every((c) => c.models.every((x) => x === BIG)));
});

// ── review r3-B: verdicts follow a claim's content, a later failed round, a failing check, restart, leak, local own model ──
const C2 = { id: 'c2', claim: 'Method A reached 56.4% on the benchmark', source_url: SRC_A, figures: ['56.4'], measured_result: '56.4%', judged_by: 'humans', evidence_strength: 'strong', inference: false };
const REPORT_C2 = () => REPORT('').replace(/```claims[\s\S]*$/, '') + claimsBlock([C2]);
const verdictsOf = (id, v) => '```json\n' + JSON.stringify([{ id, verdict: v, reason: 'because' }]) + '\n```';
const one = (label, text, ok = true) => [{ label, ok, text }];
const rounds = (n) => ({ thoroughSettings: () => ({ maxSources: 12, readersAtOnce: 2, reviewRounds: n, timeLimitMinutes: 60, pdf: true, readerModel: 'own' }) });

test('r3 1: a doubted claim restated under a new id and wording is not reviewed after one round: unreviewed, never key evidence, never doubted by id', async () => {
  const { engine, seen } = spyEngine();
  const m = makeThorough({ deps: { engine: { ...ENGINE, ...engine }, ...rounds(1) }, script: { Reviewer: () => one('Reviewer', verdictsOf('c1', 'not_supported')), Revision: () => one('Revision', REPORT_C2()) } });
  const run = await doneRun(m);
  assert.equal(run.rounds, 1);
  const rep = seen.chat[seen.chat.length - 1];
  assert.deepEqual(rep.unreviewedIds, ['c2']);
  assert.deepEqual(rep.doubtedIds, [], 'c1 is gone; c2 is a different claim, not a renumbered c1');
  assert.deepEqual(run.unreviewedIds, ['c2'], 'persisted');
  assert.equal(m.calls.filter((c) => c.labels[0] === 'Reviewer').length, 1);
  // persisted by key only, never by text
  assert.equal(typeof run.reviewedKeys, 'object');
  assert.ok(!/Method A/.test(JSON.stringify({ r: run.reviewedKeys, d: run.doubtedKeys })));
});

test('r3 1: with two rounds the second round reviews the restated claim', async () => {
  const { engine, seen } = spyEngine();
  let n = 0;
  const m = makeThorough({ deps: { engine: { ...ENGINE, ...engine }, ...rounds(2) }, script: {
    Reviewer: () => { n++; return one('Reviewer', n === 1 ? verdictsOf('c1', 'not_supported') : verdictsOf('c2', 'supported')); },
    Revision: () => one('Revision', REPORT_C2()),
  } });
  const run = await doneRun(m);
  assert.equal(run.rounds, 2);
  const reviewerCalls = m.calls.filter((c) => c.labels[0] === 'Reviewer');
  assert.equal(reviewerCalls.length, 2);
  assert.match(reviewerCalls[1].tasks[0], /reached 56\.4% on the benchmark/, 'the second round was shown the new claim');
  const rep = seen.chat[seen.chat.length - 1];
  assert.deepEqual(rep.unreviewedIds, []);
  assert.deepEqual(rep.doubtedIds, []);
});

test('r3 1: a doubted claim that a revise renumbers keeps its doubt (by key, not id)', async () => {
  const { engine, seen } = spyEngine();
  const same = { id: 'c7', claim: 'Method A scored 56.4% on the test', source_url: SRC_A, figures: ['56.4'], measured_result: '56.4%', judged_by: 'humans', evidence_strength: 'strong', inference: false };
  const m = makeThorough({ deps: { engine: { ...ENGINE, ...engine }, ...rounds(1) }, script: { Reviewer: () => one('Reviewer', verdicts('partly')), Revision: () => one('Revision', REPORT('').replace(/```claims[\s\S]*$/, '') + claimsBlock([same])) } });
  await doneRun(m);
  const rep = seen.chat[seen.chat.length - 1];
  assert.deepEqual(rep.doubtedIds, ['c7']);
  assert.deepEqual(rep.unreviewedIds, []);
});

test('r3 2: a later round that fails keeps the credited rounds; never "Not challenged"', async () => {
  let n = 0;
  const m = makeThorough({ deps: rounds(2), script: { Reviewer: () => { n++; return n === 1 ? one('Reviewer', verdicts('not_supported')) : one('Reviewer', '(no response)', false); } } });
  const run = await doneRun(m);
  assert.equal(run.rounds, 1);
  assert.equal(run.review.lastRoundFailed, true);
  assert.equal(run.review.counts.not_supported, 1);
  assert.doesNotMatch(m.wakes[0].message, /Not challenged/);
  assert.match(m.wakes[0].message, /Challenged by/);
});

test('r3 3: a checkReport that throws: figures marked unverified, notChecked, missing says so', async () => {
  const { engine, seen } = spyEngine();
  const boom = { ...engine, checkReport: () => { throw new Error('boom'); } };
  const m = makeThorough({ deps: { engine: { ...ENGINE, ...boom }, ...rounds(0) } });
  const run = await doneRun(m);
  assert.equal(run.state, 'delivered');
  assert.ok(run.missing.includes('checking figures (error)'), JSON.stringify(run.missing));
  const rep = seen.chat[seen.chat.length - 1];
  assert.equal(rep.notChecked, true);
  assert.match(rep.prose, /56\.4% \[not checked\]/); // r8: the check failed (did not run), so every figure is "not checked"
  assert.match(m.wakes[0].message, /Figures not checked/);
});

test('r3 5: the in-memory source texts never outlive the run: after a deadline during the fetch, and after a normal end', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = makeThorough({ fetchPage: async (url) => { await gate; return { markdown: 'text ' + url, truncated: false, via: 'plain', title: 'T' }; }, deps: { thoroughSettings: () => ({ maxSources: 12, readersAtOnce: 2, reviewRounds: 1, timeLimitMinutes: 0.01, pdf: true, readerModel: 'own' }) } });
  const r = startThorough(slow);
  await untilMs(() => slow.wakes.length === 1);
  release();
  await new Promise((x) => setTimeout(x, 60));
  assert.equal(slow.runner.hasTexts(r.id), false);
  const ok = makeThorough();
  const run = await doneRun(ok);
  assert.equal(ok.runner.hasTexts(run.id), false);
});

test('r3 6: the "Not settled by the review" section has its figures marked', async () => {
  const m = makeThorough({ deps: rounds(1), script: { Reviewer: () => one('Reviewer', verdicts('not_supported')), Revision: () => one('Revision', 'no claims block here') } });
  await doneRun(m);
  const md = m.written[0].doc.markdown;
  assert.match(md, /Not settled by the review/);
  assert.match(md, /Not settled by the review[\s\S]*56\.4% \[not checked\]/); // r8: the check did not run on a section added after it: "not checked"
});

test('r3 7: an own model on this computer: helpers, readers and the reviewer stay local (only a local pick, else the own model)', async () => {
  const own = 'lmstudio/qwen-own';
  const cloud = { ownModelOf: async () => own, pickHelperModel: async () => FAST, pickReaderModel: async () => 'claude-sdk/claude-test-reader', pickReviewer: async () => ({ model: 'openai/test-reviewer', label: 'x', crossVendor: true }) };
  const a = makeThorough({ deps: { ...cloud, ...rounds(1) } });
  await doneRun(a);
  assert.ok(a.calls.length >= 5);
  assert.ok(a.calls.every((c) => c.models.every((x) => x === own)), JSON.stringify(a.calls.map((c) => c.models)));
  const local = { ...cloud, pickHelperModel: async () => 'ollama/small', pickReaderModel: async () => 'ollama/reader', pickReviewer: async () => ({ model: 'ollama/rev', label: 'x', crossVendor: false }) };
  const b = makeThorough({ deps: { ...local, ...rounds(1) } });
  await doneRun(b);
  assert.deepEqual([...new Set(b.calls[0].models)], ['ollama/small']);
  assert.deepEqual([...new Set(b.calls.find((c) => /^Reader/.test(c.labels[0])).models)], ['ollama/reader']);
  assert.equal(b.calls.find((c) => c.labels[0] === 'Reviewer').model, 'ollama/rev');
  // chooseHelperModel: only local candidates for a local own model
  const note = () => 'fast and cheap';
  assert.equal(research.chooseHelperModel({ ownModel: own, allowed: [FAST, 'ollama/small'], noteOf: note }), 'ollama/small');
  assert.equal(research.chooseHelperModel({ ownModel: own, allowed: [FAST], noteOf: note }), own);
});

// ── review r4: unreviewed by key after an interrupted run, a failed check says so, the reviewer label follows the model used ──
test('r4 4: round 1 credited, a revise rewrites c2, round 2 cut by the deadline: the partial report lists c2 as changed after the last review, not key evidence', async () => {
  const m = makeThorough({
    deps: { thoroughSettings: () => ({ maxSources: 12, readersAtOnce: 2, reviewRounds: 2, timeLimitMinutes: 0.02, pdf: true, readerModel: 'own' }) },
    script: { Reviewer: (w, n, signal) => (n === 1 ? one('Reviewer', verdictsOf('c1', 'not_supported')) : hang()(w, n, signal)), Revision: () => one('Revision', REPORT_C2()) },
  });
  const r = startThorough(m);
  await untilMs(() => m.runner.get(r.id).state === 'delivered');
  const run = m.runner.get(r.id);
  assert.equal(run.rounds, 1);
  assert.ok(Array.isArray(run.sentKeys) && run.sentKeys.length === 1, 'the keys a reviewer saw are saved');
  const report = m.wakes[0].message.split('Report:\n')[1];
  assert.match(report.split('\n')[0], /^Not finished:/);
  assert.match(report, /Changed after the last review \(not reviewed\): c2\./);
  assert.doesNotMatch(report, /Key evidence\n- Method A reached/);
  assert.deepEqual(run.unreviewedIds, ['c2'], 'saved right after the revise');
});

test('r4 4: a saved run with sentKeys: unreviewed comes from keys, so a renumbered reviewed claim stays reviewed', async () => {
  const T2 = require(path.join(ISO.inst, 'lib', 'research-thorough.js'));
  const seen = { ...C2, id: 'c9' };
  const rewritten = { ...C2, id: 'c3', measured_result: 'decreased' };
  const base = { agent: 'a1', stamp: null, question: 'Q?', subQuestions: SUBS, level: 'thorough', state: 'running', startedAt: 1, endedAt: null, error: null, stage: 'challenge', missing: [], stagesDone: ['quick', 'select', 'fetch', 'read', 'synthesis', 'check'], id: 'dr-00000009', prose: '## Verdict\nA.', claims: [seen, rewritten], checked: true, checkTotals: { claims: 2, figures: 2, found: 2, notFound: 0, notOpened: 0 }, notChecked: false, rounds: 1, reviewer: 'x', review: { label: 'x', rounds: 1, counts: { supported: 1, partly: 0, not_supported: 0, cannot_check: 0 } }, unreviewedIds: [], sentKeys: [T2.claimKey(C2)] };
  let saved = [JSON.parse(JSON.stringify(base))];
  const store = { load: () => saved, save: (x) => { saved = JSON.parse(JSON.stringify(x)); } };
  const m = makeRunner({ store, maxRunning: 10, engine: ENGINE });
  m.runner.recover();
  await until(() => m.wakes.length === 1);
  assert.match(m.wakes[0].message, /Changed after the last review \(not reviewed\): c3\./);
  assert.doesNotMatch(m.wakes[0].message, /not reviewed\): [^\n]*c9/);
});

test('r4 8: a figure check that throws: chatReport gets checkError and the figures line says the check failed', async () => {
  const { engine, seen } = spyEngine();
  const boom = { ...engine, checkReport: () => { throw new Error('boom'); } };
  const m = makeThorough({ deps: { engine: { ...ENGINE, ...boom }, ...rounds(0) } });
  const run = await doneRun(m);
  const rep = seen.chat[seen.chat.length - 1];
  assert.equal(rep.checkError, true);
  assert.equal(run.checkError, true, 'saved');
  assert.match(m.wakes[0].message, /Figures not checked \(the check failed\); every figure is marked not checked\./);
  assert.doesNotMatch(m.wakes[0].message, /no list of claims/);
});

test('r4 9: when a local own model replaces the reviewer pick, the label and crossVendor follow the model actually used', async () => {
  const own = 'lmstudio/qwen-own';
  const { engine, seen } = spyEngine();
  const cloud = { ownModelOf: async () => own, pickHelperModel: async () => FAST, pickReaderModel: async () => 'claude-sdk/claude-test-reader', pickReviewer: async () => ({ model: 'openai/test-reviewer', label: 'a model from another vendor (OpenAI)', crossVendor: true }) };
  const m = makeThorough({ deps: { engine: { ...ENGINE, ...engine }, ...cloud, ...rounds(1) } });
  await doneRun(m);
  assert.equal(m.calls.find((c) => c.labels[0] === 'Reviewer').model, own);
  assert.match(m.wakes[0].message, /Challenged by: a model on this computer \(its content stays here\) \(1 round\)/);
  assert.doesNotMatch(m.wakes[0].message, /another vendor/);
  const rep = seen.chat[seen.chat.length - 1];
  assert.equal(rep.reviewer, 'a model on this computer (its content stays here)');
});

// ── r8: the figure check runs on the text the hub fetched, never on text a model returned ──
test('r8 1: a figure that only a reader wrote down (not in the fetched text) is not found as written', async () => {
  const claims = [{ id: 'c1', claim: 'Method A scored 777.7% on the test', source_url: SRC_A, figures: ['777.7%'], measured_result: '777.7%', judged_by: 'humans', evidence_strength: 'strong', inference: false }];
  const report = '## Verdict\nMethod A wins.\n\n## Evidence\n- Method A scored 777.7% on the test (Paper A, ' + SRC_A + ', 2025).\n\n## Where sources disagree\nNone.\n\n## Confidence\nMedium.\n\n## Corrections to the first pass\nNone\n\n' + claimsBlock(claims);
  const m = makeThorough({
    deps: rounds(0),
    script: {
      // the reader's notes state 777.7%; the page the hub fetched (makeThorough's fetchPage) says 56.4%
      Reader: (workers) => workers.map((w) => ({ label: w.label, ok: true, text: `Notes for ${w.label}: Table 2 gives 777.7% (humans, 200 raters).` })),
      'Research report': () => one('Research report', report),
    },
  });
  const run = await doneRun(m);
  assert.equal(run.state, 'delivered');
  // the reader did write the figure, and the report brief carried it to the writer ...
  assert.ok(m.calls.some((c) => c.labels[0] === 'Research report' && c.tasks[0].includes('777.7%')), 'the reader notes reach the report writer');
  // ... but the check only looks at the fetched text: not found as written, in the claim and in the text
  assert.equal(run.claims[0].check_status, 'not_found_as_written');
  assert.equal(run.claims[0].check, '0 of 1 found as written');
  assert.match(run.prose, /777\.7% \[not found in source\]/);
  assert.equal(run.claims[0].measured_result, '777.7% [not found in source]');
  assert.ok(run.checkTotals.notFound >= 1 && run.checkTotals.found === 0, JSON.stringify(run.checkTotals));
  const md = m.written[0].doc.markdown;
  assert.match(md, /## Figures not found as written/);
  assert.match(md, /\| 777\.7% \| \[Paper A\]/);
  assert.match(m.wakes[0].message, /0 found as written; 2 not found as written/);
  // the figure the fetched page does have is found as written (the fetched text says "56.4%")
  const ok = makeThorough({ deps: rounds(0) });
  const run2 = await doneRun(ok);
  assert.equal(run2.claims[0].check_status, 'found_as_written');
});

test('r8 2: a saved run keeps reading: old statuses and totals map to the new labels', async () => {
  const { engine, seen } = spyEngine();
  const old = { id: 'dr-old1', agent: 'a1', stamp: null, question: 'Q?', subQuestions: ['a', 'b'], level: 'thorough', state: 'running', stage: 'challenge', stageLabel: '', stageDone: 0, stageTotal: 0, startedAt: 1, endedAt: null, error: null, stagesDone: ['quick', 'select', 'fetch', 'read', 'synthesis', 'check'], missing: [], findings: ['f'], checked: true, rounds: 0,
    prose: 'Method A scored 56.4% [unverified] on the test.', claims: [{ id: 'c1', claim: 'Method A won', source_url: SRC_A, figures: ['56.4'], check: '1 of 1 figure found', check_status: 'verified' }, { id: 'c2', claim: 'Method B lost', source_url: SRC_B, figures: ['9.9'], check: '0 of 1 found; not found: 9.9', check_status: 'unverified' }],
    checkTotals: { claims: 2, figures: 2, found: 1, notFound: 1, notOpened: 0, proseFigures: 1, proseVerified: 0, proseUnverified: 1 } };
  const b = makeRunner({ store: { load: () => [{ ...old }], save() {} }, engine: { ...ENGINE, ...engine } });
  b.runner.recover();
  await until(() => b.wakes.length === 1);
  const msg = b.wakes[0].message;
  // the text is shown as saved; the saved statuses still decide what is key evidence; the totals read in the new wording
  assert.match(msg, /Method A scored 56\.4% \[unverified\] on the test\./);
  // r9b: key evidence needs both marks; a saved run has no meaning for its figures, so nothing is key evidence
  assert.match(msg, /Key evidence\n- No claim has all its figures confirmed by both checks/);
  assert.doesNotMatch(msg, /Key evidence[\s\S]*Method B lost[\s\S]*Doubted/);
  assert.match(msg, /In the source \(checked by code against the fetched text\): 1 found as written; 1 not found as written \(marked "not found in source"\); 0 from sources that could not be opened \(marked "source not opened"\); 1 with no source to check\./);
  assert.equal(E_SAVED('found'), 'found_as_written');
  assert.equal(E_SAVED('not_found'), 'not_found_as_written');
  assert.equal(E_SAVED('common_not_near'), 'not_found_as_written');
  assert.equal(E_SAVED('source_not_opened'), 'source_not_opened');
});
const E_SAVED = (s) => T_REAL.savedStatus(s);

// ── r9b: the second mark in a full run ──
const FIG_QUOTE = 'Method A scored 56.4% on the test';
const reviewerReply = (verdict, figures) => [{ label: 'Reviewer', ok: true, text: '```json\n' + JSON.stringify([{ id: 'c1', verdict, reason: 'because', ...(figures ? { figures } : {}) }]) + '\n```' }];

test('r9b runner: figure verdicts are validated by code, saved as meaningKeys, and both lines reach the report', async () => {
  const m = makeThorough({ script: { Reviewer: () => reviewerReply('supported', [{ fid: 'c1.f1', meaning: 'matches', quote: FIG_QUOTE }]) } });
  const r = startThorough(m);
  await until(() => m.runner.get(r.id).state === 'delivered');
  // the brief showed the figure with its passage, and the reply shape
  const brief = m.calls.find((c) => c.labels[0] === 'Reviewer').tasks[0];
  assert.match(brief, /Figures to compare \(each with the passage the hub cut from the source around it\):\n  \[c1\.f1\] the report writes: 56\.4% \| passage: "/);
  // the saved run has the key with the validated answer
  const run = m.runner.get(r.id);
  const keys = Object.entries(run.meaningKeys || {});
  assert.equal(keys.length, 1);
  assert.match(keys[0][0], /^[0-9a-f]{64}$/);
  assert.deepEqual(keys[0][1], { meaning: 'matches', quote: FIG_QUOTE });
  assert.ok(m.saves.some((s) => s.includes('"meaningKeys"')), 'saved with the run');
  assert.equal(run.claims[0].figure_checks[0].meaning, 'matches');
  // the delivered report: both lines, the scope sentence, key evidence needs both marks
  const msg = m.wakes[0].message;
  assert.match(msg, /In the source \(checked by code against the fetched text\): 2 found as written;/);
  assert.match(msg, /Means the same \(checked by the reviewer against the passage around each figure\): 2 matches; 0 differs \(marked "source says otherwise"\); 0 not checked\. Confirmed by both: 2 of 2 figures\./);
  assert.match(msg, /a figure is confirmed only when both agree\./);
  assert.match(msg, /Key evidence\n- Method A scored 56\.4% on the test \[https:\/\/example\.org\/paper-a\] \(figures confirmed by both checks\)/);
  // the document: both columns
  assert.match(m.written[0].doc.markdown, /\| In the source \| Means the same \|/);
  assert.match(m.written[0].doc.markdown, /\| 1 of 1 found as written \| 1 matches \|/);
});

test('r9b runner: answers that fail the code validation leave the figures "not checked"; the round still counts', async () => {
  const bad = [
    { fid: 'c1.f1', meaning: 'matches', quote: 'Method A scored 99.9% on the test' }, // not in the passage
    { fid: 'c1.f9', meaning: 'matches', quote: FIG_QUOTE },                            // never presented
  ];
  const m = makeThorough({ script: { Reviewer: () => reviewerReply('supported', bad) } });
  const r = startThorough(m);
  await until(() => m.runner.get(r.id).state === 'delivered');
  const run = m.runner.get(r.id);
  assert.equal(run.rounds, 1);
  assert.deepEqual(run.meaningKeys || {}, {});
  const msg = m.wakes[0].message;
  assert.match(msg, /: 0 matches; 0 differs \(marked "source says otherwise"\); 2 not checked\. Confirmed by both: 0 of 2 figures\./);
  assert.match(msg, /Key evidence\n- No claim has all its figures confirmed by both checks/);
  assert.doesNotMatch(msg, /\[source says otherwise\]/);
});

test('r9b runner: a round with no usable claim verdicts credits no figure answers', async () => {
  const m = makeThorough({ script: { Reviewer: () => reviewerReply('cannot_check', [{ fid: 'c1.f1', meaning: 'matches', quote: FIG_QUOTE }]) } });
  const r = startThorough(m);
  await until(() => m.runner.get(r.id).state === 'delivered');
  const run = m.runner.get(r.id);
  assert.equal(run.rounds, 0);
  assert.deepEqual(run.meaningKeys || {}, {});
  assert.ok(run.claims.every((c) => c.figure_checks.every((f) => f.meaning === 'not checked')));
  const msg = m.wakes[0].message;
  assert.match(msg, /Not challenged: the reviewer gave no usable verdicts\./);
  assert.match(msg, /: 0 matches; 0 differs[^\n]*; 2 not checked\. Confirmed by both: 0 of 2 figures\./);
});

test('r9b runner: no review (reviewRounds 0) or a reviewer that fails: every figure "not checked", nothing reads matches', async () => {
  const off = makeThorough({ deps: { thoroughSettings: () => ({ maxSources: 12, readersAtOnce: 2, reviewRounds: 0, timeLimitMinutes: 60, pdf: true, readerModel: 'own' }) } });
  const r0 = startThorough(off);
  await until(() => off.runner.get(r0.id).state === 'delivered');
  assert.equal(off.calls.filter((c) => c.labels[0] === 'Reviewer').length, 0);
  assert.match(off.wakes[0].message, /: 0 matches; 0 differs[^\n]*; 2 not checked\. Confirmed by both: 0 of 2 figures\./);
  assert.match(off.written[0].doc.markdown, /No figure's meaning was compared: the review did not run\./);
  const fail = makeThorough({ script: { Reviewer: () => { throw new Error('reviewer down'); } } });
  const r1 = startThorough(fail);
  await until(() => fail.runner.get(r1.id).state === 'delivered');
  assert.match(fail.wakes[0].message, /: 0 matches; 0 differs[^\n]*; 2 not checked\./);
  assert.doesNotMatch(fail.wakes[0].message, /[1-9]\d* matches/);
  assert.ok(fail.runner.get(r1.id).claims.every((c) => c.figure_checks.every((f) => f.meaning === 'not checked')));
});

test('r9b runner: a differs answer is marked, told to the reviser, and a revised claim is "not checked" again', async () => {
  let reviewerCalls = 0;
  const reworded = () => REPORT('').replace('"claim":"Method A scored 56.4% on the test"', '"claim":"Method A scored 56.4% on the benchmark test"');
  const m = makeThorough({ script: {
    Reviewer: () => { reviewerCalls++; return reviewerCalls === 1 ? reviewerReply('partly', [{ fid: 'c1.f1', meaning: 'differs', quote: FIG_QUOTE }]) : reviewerReply('supported'); },
    Revision: () => [{ label: 'Revision', ok: true, text: reworded() }],
  } });
  const r = startThorough(m);
  await until(() => m.runner.get(r.id).state === 'delivered');
  const revise = m.calls.find((c) => c.labels[0] === 'Revision').tasks[0];
  assert.ok(revise.includes('Figures whose passage says something different'));
  assert.ok(revise.includes(`- c1: "56.4%" | the source's passage says: "${FIG_QUOTE}"`));
  assert.equal(reviewerCalls, 2);
  const run = m.runner.get(r.id);
  // the reviewer's first answer stays stored; the revised claim has a new key, so its meaning is not checked
  assert.equal(Object.keys(run.meaningKeys).length, 1);
  assert.ok(run.claims.every((c) => c.figure_checks.every((f) => f.meaning === 'not checked')));
  const msg = m.wakes[0].message;
  assert.match(msg, /: 0 matches; 0 differs[^\n]*; 2 not checked\./);
  assert.doesNotMatch(msg, /\[source says otherwise\]/);
});

test('r9b runner: the meaning marks are saved with the claims and the report text as soon as a round is credited', async () => {
  const m = makeThorough({
    script: { Reviewer: () => reviewerReply('supported', [{ fid: 'c1.f1', meaning: 'differs', quote: FIG_QUOTE }]) },
    deps: { writeDocument: () => new Promise(() => {}) }, // the run stays in the document stage
  });
  const r = startThorough(m);
  await untilMs(() => m.runner.get(r.id).stage === 'document');
  const run = m.runner.get(r.id);
  assert.equal(Object.keys(run.meaningKeys).length, 1);
  assert.equal(run.claims[0].figure_checks[0].meaning, 'differs');
  assert.match(run.prose, /56\.4% \[source says otherwise\]/);
  assert.equal(run.checkTotals.meaningDiffers, 1);
});
