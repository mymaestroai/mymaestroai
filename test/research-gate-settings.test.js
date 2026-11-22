'use strict';
// r4 B2: the discovery-gate settings reach the lead, and the search freshness option reaches the search function.
// Stand-ins only: no network. runLead is wrapped to record its arguments and stop the run there.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const research = require('../lib/research');
const T = require('../lib/research-thorough');
const Lead = require('../lib/research-lead');

const BIG = 'claude-sdk/claude-test-big';
const FAST = 'claude-sdk/claude-test-fast';
const MODELS = { lead: BIG, reader: FAST, readerTop: BIG, reviewers: [{ model: 'claude-sdk/claude-test-rev', label: 'Reviewer One' }], paths: { lead: 'the agent\'s own service' } };
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await sleepMs(5); } throw new Error('condition not reached'); }

/** Starts a Thorough run whose lead engine is replaced by a recorder; returns what runLead was called with. */
async function captureRunLead(settings, depsOver = {}) {
  const real = Lead.runLead;
  let captured = null;
  Lead.runLead = async (args) => { captured = args; throw new Error('stop here'); };
  const worker = [];
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-settings-'));
    let saved = [];
    const runner = research.createResearchRunner({
      spawn: async (agent, workers) => workers.map((w) => { worker.push(w); return { label: w.label, ok: true, text: w.label === 'Lead search' ? (depsOver.searchReply || '{"results":[]}') : 'x' }; }),
      wake: async () => {}, pickHelperModel: async () => FAST, ownModelOf: async () => BIG, keptOnBox: () => false, sleep: async () => {}, log: () => {},
      store: { load: () => saved, save: (r) => { saved = JSON.parse(JSON.stringify(r)); } },
      fetchPage: async () => ({ markdown: 'text', truncated: false, via: 'plain', title: 'T' }),
      search: async () => [{ title: 'A', url: 'https://example.org/a', snippet: 's' }],
      leadModels: async () => MODELS, leadPlaybook: () => 'PLAYBOOK', leadDir: (id) => path.join(root, id),
      thoroughSettings: () => T.settingsFrom(settings), writeDocument: async () => ({ md: '/x.md', html: '/x.html', pdf: '', pdfError: 'no' }),
      onProgress: () => {}, ...depsOver.deps,
    });
    runner.start({ agent: 'a1', question: 'Which method is best?', subQuestions: ['one', 'two'], level: 'thorough' });
    await until(() => captured);
    return { captured, worker };
  } finally { Lead.runLead = real; }
}

test('r4-B2 the runner passes the two gate settings to runLead (defaults, saved values, 0 kept)', async () => {
  const d = await captureRunLead({});
  assert.strictEqual(d.captured.settings.topicSearchesMin, 3);
  assert.strictEqual(d.captured.settings.sourcesPerSubMin, 2);
  const s = await captureRunLead({ leadTopicSearches: 5, leadSourcesPerSub: 4 });
  assert.strictEqual(s.captured.settings.topicSearchesMin, 5);
  assert.strictEqual(s.captured.settings.sourcesPerSubMin, 4);
  const z = await captureRunLead({ leadTopicSearches: 0, leadSourcesPerSub: 0 });
  assert.strictEqual(z.captured.settings.topicSearchesMin, 0);
  assert.strictEqual(z.captured.settings.sourcesPerSubMin, 0);
});

test('r4-B2 the lead search passes the freshness option to the hub search; without it the call has no freshness', async () => {
  const calls = [];
  const search = async (...a) => { calls.push(a); return [{ title: 'A', url: 'https://example.org/a', snippet: 's' }]; };
  const { captured } = await captureRunLead({}, { deps: { search } });
  const r1 = await captured.deps.search('recent work', null, { freshness: 'year' });
  assert.strictEqual(r1.via, 'hub search');
  assert.strictEqual(calls[0][0], 'recent work');
  assert.deepStrictEqual(calls[0][1], { freshness: 'year' });
  await captured.deps.search('anything', null);
  assert.strictEqual(calls[1][0], 'anything');
  assert.strictEqual(calls[1][1].freshness, undefined);
});

test('r4-B2 the search worker fallback says "from the last year only" when freshness is year, and not otherwise', async () => {
  const reply = '{"results":[{"title":"W","url":"https://w.example/1","snippet":"s"}]}';
  const { captured, worker } = await captureRunLead({}, { searchReply: reply, deps: { search: async () => [] } });
  const r = await captured.deps.search('some topic', null, { freshness: 'year' });
  assert.strictEqual(r.via, 'search worker');
  const task = worker.filter((w) => w.label === 'Lead search').pop().task;
  assert.match(task, /Search the web for: some topic \(from the last year only\)\./);
  await captured.deps.search('other topic', null);
  const task2 = worker.filter((w) => w.label === 'Lead search').pop().task;
  assert.ok(task2.includes('Search the web for: other topic.') && !/last year/.test(task2), task2);
});

test('r4-B2 researchLeadSearch (lib/sdk-chat.js) hands freshness to the hub web search when given, and only then', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  const a = src.indexOf('async function researchLeadSearch(');
  const b = src.indexOf('/** The model that challenges a Thorough report');
  assert.ok(a > 0 && b > a);
  const got = [];
  const ctx = vm.createContext({ require: (m) => { if (m !== './web-search') throw new Error('unexpected ' + m); return { getWebSearch: () => ({ search: async (q, o) => { got.push([q, o]); return { results: [{ title: 't', url: 'https://x.example/1', snippet: 's', extra: 1 }] }; } }) }; }, String, Array });
  vm.runInContext(src.slice(a, b) + '\nthis.fn = researchLeadSearch;', ctx);
  const out = await ctx.fn('topic words', { freshness: 'year' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), [{ title: 't', url: 'https://x.example/1', snippet: 's' }]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(got[0])), ['topic words', { maxResults: 10, freshness: 'year' }]);
  await ctx.fn('topic words');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(got[1])), ['topic words', { maxResults: 10 }]);
  await ctx.fn('topic words', {});
  assert.deepStrictEqual(JSON.parse(JSON.stringify(got[2])), ['topic words', { maxResults: 10 }]);
});
