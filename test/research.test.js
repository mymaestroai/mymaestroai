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
const { createResearchPrefs, CHOICES, MAX_PEOPLE } = require(path.join(ISO.inst, 'lib', 'research-prefs.js'));

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
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { people: { u_sam: { choice: 'always', remindedAt: null } } });
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
  assert.equal(c.question, 'This looks like a research question. Do a deep research run (a few minutes, many sources)? ' + research.costLine('openai/test-mini'));
  assert.deepEqual(c.options, ['Yes', 'No', 'Always yes', 'Never']);
  assert.equal(c.descriptions.length, 4);
  assert.equal(c.allow_skip, true);
  assert.deepEqual(Object.keys(c).sort(), ['allow_skip', 'descriptions', 'header', 'options', 'question']);
});

test('TOOL: name, actions and required fields', () => {
  assert.equal(research.TOOL.name, 'deep_research');
  assert.deepEqual(research.TOOL.parameters.properties.action.enum, ['offer', 'start', 'set']);
  assert.deepEqual(research.TOOL.parameters.properties.choice.enum, ['ask', 'always', 'never']);
  assert.deepEqual(research.TOOL.parameters.required, ['action']);
  assert.match(research.TOOL.description, /action "set"/);
  assert.match(research.TOOL.description, /BEFORE answering/);
});

// ── decide ──
function fakeStore(throwOnSet) {
  const calls = [];
  return { calls, setChoice(k, v) { calls.push([k, v]); if (throwOnSet) throw new Error('disk full'); return v; } };
}
const askOf = (answer) => { const f = async () => { f.n++; return answer; }; f.n = 0; return f; };

test('decide: always and never never ask', async () => {
  const ask = askOf('yes');
  assert.deepEqual(await research.decide({ choice: 'always', canAsk: true, ask, store: fakeStore(), personKey: 'sam' }), { run: true, by: 'always' });
  assert.deepEqual(await research.decide({ choice: 'never', canAsk: true, ask, store: fakeStore(), personKey: 'sam' }), { run: false, by: 'never' });
  assert.deepEqual(await research.decide({ choice: 'always', canAsk: false, ask, store: fakeStore(), personKey: 'sam' }), { run: true, by: 'always' });
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
  for (const a of ['yes', ' Yes ', 'YES']) { const { d, store } = await run(a); assert.deepEqual(d, { run: true, by: 'yes' }); assert.equal(store.calls.length, 0); }
  for (const a of ['Always yes', 'always', ' yes always ']) { const { d, store } = await run(a); assert.deepEqual(d, { run: true, by: 'always-now' }); assert.deepEqual(store.calls, [['u_sam', 'always']]); }
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
  assert.deepEqual(a, { run: true, by: 'always-now', saved: false });
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
  assert.deepEqual(await research.decide({ choice: s.choiceOf('sam'), canAsk: true, ask, store: s, personKey: 'sam' }), { run: true, by: 'always' });
  assert.equal(ask.n, 0);
});

// ── offerText ──
test('offerText: every outcome', () => {
  const o = research.offerText;
  assert.match(o({ run: true, by: 'yes' }), /^The person wants a deep research run\. Plan 2 to 8 sub-questions/);
  assert.match(o({ run: true, by: 'always' }), /^The person wants a deep research run \(they chose always\)\. Plan/);
  assert.match(o({ run: true, by: 'always-now' }), /^The person wants a deep research run \(and from now on without being asked\)\. Plan/);
  for (const by of ['yes', 'always', 'always-now']) assert.match(o({ run: true, by }), /action "start", the same question and sub_questions\..*report will appear here/);
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
  const a = makeRunner({ store, now: () => t, spawn: async () => { await gate; return 'X'; } });
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

test('review r4: agentIdentity: box id, else owner; a re-made agent differs; a settings edit does not; unreadable throws', () => {
  const { agentIdentity } = require(path.join(ISO.inst, 'lib', 'agents.js'));
  const list = [
    { name: 'sam-agent', owner: 'u_sam', box: 'b1', model: 'm1' },
    { name: 'old-agent', owner: 'u_sam', model: 'm1' },
  ];
  assert.equal(agentIdentity('sam-agent', { load: () => list }), 'box:b1');
  assert.equal(agentIdentity('old-agent', { load: () => list }), 'owner:u_sam');
  assert.equal(agentIdentity('nobody', { load: () => list }), null);
  // a settings edit (the model) keeps it
  assert.equal(agentIdentity('sam-agent', { load: () => [{ ...list[0], model: 'm2', blurb: 'x' }] }), 'box:b1');
  // deleted and re-made by the same owner: a new box id
  assert.notEqual(agentIdentity('sam-agent', { load: () => [{ name: 'sam-agent', owner: 'u_sam', box: 'b2' }] }), 'box:b1');
  assert.throws(() => agentIdentity('sam-agent', { load: () => [] }), /could not be read/);
  assert.throws(() => agentIdentity('sam-agent', { load: () => null }), /could not be read/);
});
