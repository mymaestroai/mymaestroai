'use strict';
// The runner runs Thorough with the lead engine (part C). Stand-ins only: no network, temp folders.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const research = require('../lib/research');
const T = require('../lib/research-thorough');
const L = require('../lib/research-lead');

const BIG = 'claude-sdk/claude-test-big';
const FAST = 'claude-sdk/claude-test-fast';
const SUBS = ['one', 'two', 'three'];
const URL_A = 'https://example.org/a';
const TEXT_A = 'Owner survey. Table 6 shows the new method is preferred 56.4% against 43.6%.';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lead-runner-'));
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await sleepMs(5); } throw new Error('condition not reached'); }

const MODELS = { lead: BIG, reader: FAST, readerTop: BIG, reviewers: [{ model: 'claude-sdk/claude-test-rev', label: 'Reviewer One' }], paths: { lead: 'the agent\'s own service' } };
const DRAFT = 'The new method is preferred in 56.4% of comparisons [S1].';
const act = (...a) => JSON.stringify({ actions: a });
const GOOD_LEAD = [
  act({ type: 'open', url: URL_A, title: 'Survey A' }),
  act({ type: 'read', parts: ['S1'], brief: 'main result', level: 'normal' }),
  act({ type: 'write_draft', markdown: DRAFT }),
  act({ type: 'finish', summary: 'The new method is preferred.', open_points: [] }),
];

/** A runner with scripted lead steps. over.lead: replies by step (string | function | Error); over.settings: thoroughSettings. */
function make(over = {}) {
  const calls = [];       // every spawn call: { label, model, tools }
  const progress = [];
  const written = [];
  const wakes = [];
  const root = over.root || tmp();
  let saved = over.saved || [];
  const spawn = async (agent, workers) => {
    calls.push(...workers.map((w) => ({ label: w.label, model: w.model, tools: w.tools })));
    return workers.map((w) => {
      let text = 'x';
      const m = /^Lead step (\d+)/.exec(w.label);
      if (/^Research \d+$/.test(w.label)) text = `Finding for ${w.label}. Method A scored 56.4%.\nSOURCES READ:\n- ${URL_A}`;
      else if (w.label === 'First pass summary') text = over.firstPass === undefined ? `## Verdict\nMethod A wins.` : over.firstPass;
      else if (m) {
        const step = Number(m[1]);
        let r = (over.lead || GOOD_LEAD)[step - 1];
        if (typeof r === 'function') r = r(w.task);
        if (r instanceof Error) throw r;
        if (r === undefined) throw new Error(`no scripted reply for step ${step}`);
        text = r;
      } else if (/^Read N/.test(w.label)) text = 'Note: Table 6 gives 56.4% (raters, 1,450 comparisons).';
      else if (/^Review R/.test(w.label)) text = '```json\n{"verdict":"ACCEPT","findings":[]}\n```';
      else if (over.pipeline && w.label === 'Choose sources') text = 'no json';
      return { label: w.label, ok: true, text };
    });
  };
  const deps = {
    spawn, wake: async (agent, message) => { wakes.push({ agent, message }); },
    pickHelperModel: async () => FAST, ownModelOf: async () => BIG, keptOnBox: () => false,
    sleep: async () => {}, log: () => {},
    store: { load: () => saved, save: (r) => { saved = JSON.parse(JSON.stringify(r)); } },
    fetchPage: async (url) => ({ markdown: `${TEXT_A} ${url}`, truncated: false, via: 'plain', title: 'T' }),
    search: async () => [{ title: 'Survey A', url: URL_A, snippet: 's' }],
    leadModels: async () => (over.models || MODELS),
    leadPlaybook: () => 'PLAYBOOK',
    leadDir: (id) => path.join(root, id),
    thoroughSettings: () => T.settingsFrom(over.settings || {}),
    writeDocument: async (agent, base, doc) => { written.push({ agent, base, doc }); if (over.writeFails) throw new Error('disk full'); return { md: `/files/research/${base}.md`, html: `/files/research/${base}.html`, pdf: '', pdfError: 'no Chrome' }; },
    onProgress: (r) => { progress.push({ stage: r.stage, label: r.stageLabel, done: r.stageDone, total: r.stageTotal, state: r.state }); },
    ...(over.deps || {}),
  };
  const runner = research.createResearchRunner(deps);
  return { runner, calls, progress, written, wakes, root, saved: () => saved };
}
const startThorough = (m) => m.runner.start({ agent: 'a1', question: 'Which method is best?', subQuestions: SUBS, level: 'thorough' });
const delivered = async (m, id) => { await until(() => m.runner.get(id).state === 'delivered'); return m.wakes[m.wakes.length - 1].message; };

test('lead is the default engine: no fixed stage runs; the document and the report are complete', async () => {
  const m = make();
  const r = startThorough(m);
  const msg = await delivered(m, r.id);
  const labels = m.calls.map((c) => c.label);
  assert.deepStrictEqual(labels.filter((l) => !/^Research \d$/.test(l)), ['First pass summary', 'Lead step 1', 'Lead step 2', 'Read N1', 'Lead step 3', 'Lead step 4']);
  for (const fixed of ['Choose sources', 'Reader 1', 'Research report', 'Reviewer', 'Revision']) assert.ok(!labels.includes(fixed), fixed);
  const stages = m.progress.map((p) => p.stage).filter((s, i, a) => s && s !== a[i - 1]);
  assert.deepStrictEqual(stages, ['quick', 'summary', 'lead']);
  for (const s of ['select', 'fetch', 'read', 'claims', 'challenge']) assert.ok(!stages.includes(s), s);
  assert.ok(m.calls.filter((c) => /^Lead step/.test(c.label)).every((c) => c.model === BIG && c.tools === 'none'));
  assert.strictEqual(m.calls.find((c) => c.label === 'Read N1').model, FAST);
  // the document: the lead's markdown plus the quick pass appendix
  assert.strictEqual(m.written.length, 1);
  assert.match(m.written[0].base, /^deep-research-\d{4}-\d{2}-\d{2}-which-method-is-best$/);
  const md = m.written[0].doc.markdown;
  assert.match(md, /56\.4% of comparisons/);
  assert.ok(md.endsWith('\n\n## What the quick pass said\n\n## Verdict\nMethod A wins.'));
  assert.match(m.written[0].doc.html, /<html/);
  assert.match(m.written[0].doc.html, /What the quick pass said/);
  // the report
  assert.match(msg, /The new method is preferred\./);
  assert.match(msg, /Sources opened: 1\. Reader calls: 1 \(top-tier: 0\)\. Review rounds: 0\. Lead steps: 4\. Time: \d+ minutes\. Estimated tokens: about [\d,]+ \(an estimate from the characters sent and received\)\./);
  assert.match(msg, /Which model did what: lead claude-sdk\/claude-test-big \(the agent's own service\), readers claude-sdk\/claude-test-fast, top-tier reader claude-sdk\/claude-test-big, reviewers Reviewer One\./);
  assert.match(msg, /Full document:\n`\/files\/research\/deep-research-.*\.md`/);
  assert.match(msg, /No PDF: no Chrome/);
  assert.ok(!/stopped at a ceiling/.test(msg));
  const run = m.runner.get(r.id);
  assert.ok(run.leadDir.endsWith(r.id));
  assert.deepStrictEqual(run.leadPaths, MODELS.paths);
  assert.strictEqual(run.leadCounts.steps, 4);
  assert.match(run.prose, /What the quick pass said/);
});

test('an empty first pass adds no appendix; a document failure goes to Not done', async () => {
  const m = make({ firstPass: ' ', writeFails: true });
  // an empty first pass makes the stage fail (no reply), which is a missing entry; the run goes on
  const r = startThorough(m);
  const msg = await delivered(m, r.id);
  assert.ok(!m.written.length || !/quick pass said/.test(m.written[0].doc.markdown));
  assert.match(msg, /Not done:\n- first-pass summary/);
  assert.match(msg, /- document \(disk full\)/);
});

test("engine 'pipeline' keeps today's stages", async () => {
  const m = make({ settings: { engine: 'pipeline' }, pipeline: true });
  const r = startThorough(m);
  await delivered(m, r.id);
  const labels = m.calls.map((c) => c.label);
  assert.ok(labels.includes('Choose sources'));
  assert.ok(!labels.some((l) => /^Lead step/.test(l)));
  const stages = m.progress.map((p) => p.stage);
  assert.ok(stages.includes('select') && !stages.includes('lead'));
  assert.ok(!m.runner.get(r.id).leadDir);
});

test('progress: stage lead with the counts label', async () => {
  const m = make();
  const r = startThorough(m);
  await delivered(m, r.id);
  const lead = m.progress.filter((p) => p.stage === 'lead');
  assert.strictEqual(lead[0].label, 'lead: starting');
  assert.strictEqual(lead[0].total, 60);
  assert.ok(lead.some((p) => p.label === 'Lead step 3 · 1 sources opened · 1 reads · review round 0' && p.done === 2));
});

test('a ceiling (leadSteps 5) ends with the ceiling line in the report', async () => {
  const note = (i) => act({ type: 'notebook', append: `Open: question ${i}` });
  const lead = [note(1), note(2), note(3), note(4), note(5), act({ type: 'write_draft', markdown: 'Partial draft.' })];
  const m = make({ settings: { leadSteps: 5 }, lead });
  const r = startThorough(m);
  const msg = await delivered(m, r.id);
  assert.match(msg, /This run stopped at a ceiling: steps\./);
  assert.match(msg, /- Open: question 5/);
  assert.match(msg, /Lead steps: 6\./);
  assert.strictEqual(m.runner.get(r.id).leadCeiling, 'steps');
  assert.match(m.written[0].doc.markdown, /This report stopped at a ceiling: steps\./);
});

test('review off (leadReviewRounds 0): the lead is told and gets no reviewers', async () => {
  const prompts = [];
  const lead = [(t) => { prompts.push(t); return act({ type: 'write_draft', markdown: 'D [S1]' }); }, act({ type: 'review' }), act({ type: 'finish', summary: 'ok' })];
  const m = make({ settings: { leadReviewRounds: 0 }, lead });
  const r = startThorough(m);
  const msg = await delivered(m, r.id);
  assert.match(prompts[0], /REVIEW IS OFF/);
  assert.match(msg, /Review rounds: 0\./);
  assert.match(msg, /reviewers none\./);
  assert.ok(!m.calls.some((c) => /^Review R/.test(c.label)));
});

test("the lead's spawn fails on step 2: delivered with 'The run stopped:' and the draft", async () => {
  const lead = [act({ type: 'write_draft', markdown: 'Early draft [S1].' }), new Error('refused')];
  const m = make({ lead });
  const r = startThorough(m);
  const msg = await delivered(m, r.id);
  assert.match(msg, /^\[Deep research finished\]/);
  assert.match(msg, /The run stopped: refused\./);
  assert.match(msg, /Early draft/);
  assert.match(msg, /This report stopped early: refused\./);
  assert.match(m.written[0].doc.markdown, /What the quick pass said/);
  assert.match(msg, /Full document:/);
});

test('the lead fails before any draft: the notes are delivered', async () => {
  const lead = [act({ type: 'open', url: URL_A }), act({ type: 'read', parts: ['S1'], brief: 'b' }), new Error('refused')];
  const m = make({ lead });
  const r = startThorough(m);
  const msg = await delivered(m, r.id);
  assert.match(msg, /The run stopped: refused\./);
  assert.match(msg, /Table 6 gives 56\.4%/);
});

test('recover(): a saved running lead run is delivered with the salvage and "the hub restarted during the run"', async () => {
  const root = tmp();
  const dir = path.join(root, 'dr-aaaa0001');
  fs.mkdirSync(path.join(dir, 'drafts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'drafts', 'v1.md'), 'Saved draft before the restart [S1].');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ draftVersion: 1, sources: [], notes: [], found: [] }));
  const saved = [{ id: 'dr-aaaa0001', agent: 'a1', question: 'Which method is best?', subQuestions: SUBS, level: 'thorough', state: 'running', startedAt: Date.now() - 1000, leadDir: dir, firstPass: 'Quick one.', stagesDone: [], missing: [] }];
  const m = make({ root, saved });
  m.runner.recover();
  await until(() => m.wakes.length === 1);
  const msg = m.wakes[0].message;
  assert.match(msg, /The run stopped: the hub restarted during the run\./);
  assert.match(msg, /Saved draft before the restart/);
  assert.match(m.written[0].doc.markdown, /Quick one\./);
  await until(() => m.runner.get('dr-aaaa0001').state === 'delivered');
});

test('keptOnBox: a model of another vendor fails closed; all on the own vendor runs', async () => {
  const bad = make({ deps: { keptOnBox: () => true }, models: { ...MODELS, reviewers: [{ model: 'openai/test-reviewer', label: 'Other' }] } });
  const r1 = startThorough(bad);
  const msg1 = await delivered(bad, r1.id);
  assert.match(msg1, /the research models must stay on the agent's own service/);
  assert.ok(!bad.calls.some((c) => /^Lead step/.test(c.label)));
  const good = make({ deps: { keptOnBox: () => true } });
  const r2 = startThorough(good);
  const msg2 = await delivered(good, r2.id);
  assert.match(msg2, /Which model did what/);
  assert.ok(good.calls.some((c) => c.label === 'Lead step 4'));
  // kept is strict: a lookup that throws counts as kept
  const thrown = make({ deps: { keptOnBox: () => { throw new Error('x'); } }, models: { ...MODELS, lead: 'openai/x' } });
  const r3 = startThorough(thrown);
  assert.match(await delivered(thrown, r3.id), /must stay on the agent's own service/);
});

test('no leadModels dep: the run fails with a plain error', async () => {
  const m = make({ deps: { leadModels: null } });
  const r = startThorough(m);
  const msg = await delivered(m, r.id);
  assert.match(msg, /no model chooser/);
});

test('settingsFrom: lead defaults, bounds, model strings and engine values', () => {
  const d = T.settingsFrom({});
  assert.deepStrictEqual([d.engine, d.leadSteps, d.leadWallMinutes, d.leadReaderCalls, d.leadReviewRounds, d.leadReaderTextMax, d.leadReaderTopTextMax, d.leadModel, d.leadReaderModel, d.leadReaderTopModel],
    ['lead', 60, 360, 40, 10, 120000, 400000, 'auto', 'auto', 'auto']);
  assert.strictEqual(T.settingsFrom({ engine: 'pipeline' }).engine, 'pipeline');
  assert.strictEqual(T.settingsFrom({ engine: 'other' }).engine, 'lead');
  const bounds = [['leadSteps', 5, 300, 60], ['leadWallMinutes', 10, 1440, 360], ['leadReaderCalls', 1, 400, 40], ['leadReviewRounds', 0, 50, 10], ['leadReaderTextMax', 20000, 2000000, 120000], ['leadReaderTopTextMax', 20000, 2000000, 400000]];
  for (const [k, lo, hi, dflt] of bounds) {
    assert.strictEqual(T.settingsFrom({ [k]: lo })[k], lo, k);
    assert.strictEqual(T.settingsFrom({ [k]: hi })[k], hi, k);
    assert.strictEqual(T.settingsFrom({ [k]: String(hi) })[k], hi, k);
    assert.strictEqual(T.settingsFrom({ [k]: lo - 1 })[k], dflt, k);
    assert.strictEqual(T.settingsFrom({ [k]: hi + 1 })[k], dflt, k);
    assert.strictEqual(T.settingsFrom({ [k]: 'x' })[k], dflt, k);
  }
  assert.strictEqual(T.settingsFrom({ leadModel: 'claude-sdk/claude-test-big' }).leadModel, 'claude-sdk/claude-test-big');
  assert.strictEqual(T.settingsFrom({ leadReaderModel: 'openrouter/x-ai/grok-4:free@v1[2]' }).leadReaderModel, 'openrouter/x-ai/grok-4:free@v1[2]');
  for (const bad of ['has space', 'semi;colon', 'x'.repeat(121), '', 5, null, 'a\nb', 'quo"te']) assert.strictEqual(T.settingsFrom({ leadModel: bad }).leadModel, 'auto', String(bad));
  assert.strictEqual(T.settingsFrom({ leadReaderTopModel: 'x'.repeat(120) }).leadReaderTopModel, 'x'.repeat(120));
  // the old keys are unchanged
  assert.deepStrictEqual([d.maxSources, d.readersAtOnce, d.reviewRounds, d.timeLimitMinutes, d.pdf, d.readerModel], [12, 4, 2, 60, true, 'own']);
});

test('the execute deadline: a lead run uses leadWallMinutes + 20, the others keep their limits', () => {
  assert.strictEqual(research.thoroughLimitMinutes({ engine: 'lead', leadWallMinutes: 30, timeLimitMinutes: 60 }), 50);
  assert.strictEqual(research.thoroughLimitMinutes({ leadWallMinutes: 360 }), 380);
  assert.strictEqual(research.thoroughLimitMinutes(null), 380);
  assert.strictEqual(research.thoroughLimitMinutes({ engine: 'pipeline', leadWallMinutes: 30, timeLimitMinutes: 45 }), 45);
  assert.strictEqual(research.thoroughLimitMinutes({ engine: 'pipeline' }), 60);
});

test('the deadline timer of a lead run is leadWallMinutes + 20 minutes', async () => {
  const real = global.setTimeout;
  const delays = [];
  global.setTimeout = (fn, ms, ...a) => { if (ms >= 60000) { delays.push(ms); return { unref() {} }; } return real(fn, ms, ...a); };
  try {
    const m = make({ settings: { leadWallMinutes: 30 } });
    const r = startThorough(m);
    await delivered(m, r.id);
  } finally { global.setTimeout = real; }
  assert.ok(delays.includes(50 * 60000), JSON.stringify(delays));
});

test('leadReport: plain lines, ceiling, tokens, models, files, Not done', () => {
  const t = research.leadReport({ summary: 'S.', ceiling: 'time', openPoints: ['a', 'b'], counts: { opens: 3, readerCalls: 5, topReads: 2, reviewRounds: 1, steps: 9, promptChars: 40000, replyChars: 10000 }, files: { md: '/f/x.md', pdf: '/f/x.pdf' }, paths: { lead: 'P' }, models: MODELS, elapsedMinutes: 12.4, missing: ['document (disk full)'] });
  assert.match(t, /^S\.\n/);
  assert.match(t, /This run stopped at a ceiling: time\.\nLeft open:\n- a\n- b/);
  assert.match(t, /Sources opened: 3\. Reader calls: 5 \(top-tier: 2\)\. Review rounds: 1\. Lead steps: 9\. Time: 12 minutes\. Estimated tokens: about 13,000 /);
  assert.match(t, /Full document:\n`\/f\/x\.md`\nPDF:\n`\/f\/x\.pdf`/);
  assert.match(t, /Not done:\n- document \(disk full\)/);
  const plain = research.leadReport({ summary: 'S', counts: {}, files: {}, models: MODELS });
  assert.ok(!/ceiling|Not done/.test(plain));
});

test('salvageLead: final as is; a draft with the early ending; notes; a missing folder', () => {
  const mk = (state, files = {}) => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'drafts')); fs.mkdirSync(path.join(dir, 'notes'));
    if (state) fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
    return dir;
  };
  const args = (dir) => ({ dir, question: 'Which method?', preparedDate: '2026-11-22', reason: 'it stopped', firstPass: 'Quick.' });
  const fin = L.salvageLead(args(mk({ final: { markdown: '# Done', summary: 'S', openPoints: ['p'], ceiling: '' } })));
  assert.deepStrictEqual(fin, { markdown: '# Done', summary: 'S', openPoints: ['p'] });
  const dr = L.salvageLead(args(mk({ draftVersion: 1, sources: [], notes: [] }, { 'drafts/v1.md': 'Draft text.', 'notebook.md': '## Step 1\nOpen: the sample\n' })));
  assert.strictEqual(dr.summary, 'This report stopped early: it stopped.');
  assert.deepStrictEqual(dr.openPoints, ['Open: the sample']);
  assert.match(dr.markdown, /Draft text\./);
  const nt = L.salvageLead(args(mk({ notes: [{ n: 1, nid: 'N1', sources: ['S1'] }], sources: [{ n: 1, url: URL_A, title: 'Survey A' }] }, { 'notes/N1.md': 'Note body.' })));
  assert.match(nt.markdown, /## Survey A\n\nNote body\./);
  assert.match(nt.markdown, /stopped early: it stopped/);
  const none = L.salvageLead(args(path.join(os.tmpdir(), 'no-such-folder-xyz')));
  assert.match(none.markdown, /stopped early: it stopped/);
  assert.deepStrictEqual(none.openPoints, []);
  assert.doesNotThrow(() => L.salvageLead());
  // a broken state file does not throw either
  assert.match(L.salvageLead(args(mk(null, { 'state.json': '{broken' }))).markdown, /No notes were written/);
});

test('leadReport lists open points on a normal finish; the Thorough card text fits the 160-character card limit with "Recommended."', () => {
  const R = require('../lib/research');
  const t = R.leadReport({ summary: 'S.', ceiling: '', openPoints: ['one thing left'], counts: {}, files: {}, models: { lead: 'x/y', reviewers: [] } });
  assert.ok(t.includes('Open points:\n- one thing left'));
  const c = R.cardFor('claude-sdk/claude-sonnet-5-5', { recommend: 'thorough' });
  for (const d of c.descriptions) assert.ok(d.length <= 160, `${d.length}: ${d}`);
});
