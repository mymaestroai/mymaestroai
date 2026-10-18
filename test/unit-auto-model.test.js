'use strict';
// Behavioural unit tests for lib/auto-model.js. The classifier backends are stubbed: gateway-client.chatCompletion and
// settings via require.cache, LM Studio via a fake global.fetch. No network, no files.
const test = require('node:test');
const assert = require('node:assert');

const state = { anthropicKey: '', classify: null, calls: [], fetches: [], lms: null };
const stub = (rel, exports) => { const id = require.resolve(rel); require.cache[id] = { id, filename: id, loaded: true, exports }; };
stub('../lib/gateway-client', { chatCompletion: async (messages, opts) => {
  state.calls.push({ messages, opts });
  if (state.classify instanceof Error) throw state.classify;
  return { choices: [{ message: { content: typeof state.classify === 'function' ? state.classify(opts) : state.classify } }] };
} });
stub('../lib/settings', { getProviderKey: (p) => (p === 'anthropic' ? state.anthropicKey : ''), getProviderUrl: () => 'http://lms.test/v1' });
const am = require('../lib/auto-model');
const { ROUTES, SDK_ROUTES } = am;

const realFetch = global.fetch;
const realLog = console.log;
test.before(() => {
  console.log = () => {};
  global.fetch = async (url, init = {}) => {   // state.lms: null = offline, { models, reply }
    state.fetches.push({ url: String(url), init });
    if (!state.lms) throw new Error('ECONNREFUSED');
    if (String(url).endsWith('/models')) return { ok: true, json: async () => ({ data: state.lms.models.map(id => ({ id })) }) };
    if (String(url).endsWith('/chat/completions')) return { ok: true, json: async () => ({ choices: [{ message: { content: state.lms.reply } }] }) };
    return { ok: false, json: async () => ({}) };
  };
});
test.after(() => { global.fetch = realFetch; console.log = realLog; });
test.beforeEach(() => { state.anthropicKey = ''; state.classify = null; state.calls.length = 0; state.fetches.length = 0; state.lms = null; });

test('route tables: every category has a gateway and an SDK model', () => {
  assert.deepStrictEqual(Object.keys(ROUTES), ['code', 'reasoning', 'math', 'simple', 'vision', 'hardest']);
  assert.deepStrictEqual(Object.keys(SDK_ROUTES), Object.keys(ROUTES));
  assert.ok(Object.values(SDK_ROUTES).every(m => m.startsWith('claude-sdk/')));
});

test('no key, LM Studio offline: keyword heuristic decides (math > code > simple > reasoning)', async () => {
  const cat = async (msg) => (await am.selectModel(msg)).category;
  assert.strictEqual(await cat('Please solve this equation for x and also fix the code'), 'math');
  assert.strictEqual(await cat('Can you refactor this function so the unit test passes, it is a long message indeed'), 'code');
  assert.strictEqual(await cat('what is the capital of France'), 'simple');
  assert.strictEqual(await cat('short note'), 'simple');
  assert.strictEqual(await cat('Design a relocation strategy for moving our warehouse to a new region over the next two quarters, considering risk.'), 'reasoning');
  const r = await am.selectModel('Design a strategy for the team to improve morale across three offices during the next year.');
  assert.strictEqual(r.model, ROUTES.reasoning);
  assert.strictEqual(state.calls.length, 0, 'no HTTP classifier call without a key');
  assert.ok(state.fetches.every(f => f.url === 'http://lms.test/v1/models'), 'only LM Studio /models was probed');
});

test('selectModel: hasImages short-circuits to the vision route; empty text returns null', async () => {
  assert.deepStrictEqual(await am.selectModel('', { hasImages: true }), { model: ROUTES.vision, category: 'vision' });
  assert.deepStrictEqual(await am.selectModel('x', { hasImages: true, sdk: true }), { model: SDK_ROUTES.vision, category: 'vision' });
  assert.strictEqual(await am.selectModel('   '), null);
  assert.strictEqual(await am.selectModel(undefined), null);
  assert.strictEqual(state.calls.length, 0);
});

test('selectModelAndTools: hasImages returns the vision route like selectModel (even with empty text) and skips the classifier', async () => {
  state.anthropicKey = 'sk-test'; state.classify = '{"model":"code","tools":["slack"]}'; state.lms = { models: ['qwen3-8b'], reply: 'code' };
  assert.deepStrictEqual(await am.selectModelAndTools('', { hasImages: true }), { model: ROUTES.vision, category: 'vision', backend: 'images', applied: true, tools: null });
  assert.deepStrictEqual(await am.selectModelAndTools('', { hasImages: true, toolCategories: ['slack'] }), { model: ROUTES.vision, category: 'vision', backend: 'images', applied: true, tools: [] });
  const r = await am.selectModelAndTools('see', { hasImages: true, sdk: true });
  assert.deepStrictEqual(r, { model: SDK_ROUTES.vision, category: 'vision', backend: 'images', applied: true, tools: null });
  assert.strictEqual(state.calls.length, 0, 'no classifier call for image turns');
  assert.strictEqual(state.fetches.length, 0, 'LM Studio not probed for image turns');
});

test('HTTP classifier (Anthropic key): one-word answer maps to a route; text clipped to 4000 chars; signal forwarded', async () => {
  state.anthropicKey = 'sk-test'; state.classify = ' Code\n';
  const ac = new AbortController();
  const r = await am.selectModel('x'.repeat(5000), { signal: ac.signal, sdk: true });
  assert.deepStrictEqual(r, { model: SDK_ROUTES.code, category: 'code' });
  assert.strictEqual(state.calls.length, 1);
  assert.strictEqual(state.calls[0].messages[0].content.length, 4000);
  assert.strictEqual(state.calls[0].opts.model, 'claude-haiku-4-5');
  assert.strictEqual(state.calls[0].opts.max_tokens, 8);
  assert.strictEqual(state.calls[0].opts.signal, ac.signal);
  assert.strictEqual(state.fetches.length, 0, 'LM Studio not consulted when HTTP classifier answers');
});

test('HTTP classifier failure or junk answer falls through to LM Studio, then heuristic', async () => {
  state.anthropicKey = 'sk-test'; state.classify = new Error('429');
  state.lms = { models: ['qwen3-8b'], reply: 'MATH' };
  let r = await am.selectModel('tell me a story about a lighthouse keeper who finds a letter in a bottle one night');
  assert.deepStrictEqual(r, { model: ROUTES.math, category: 'math' });
  const post = state.fetches.find(f => f.url.endsWith('/chat/completions'));
  const body = JSON.parse(post.init.body);
  assert.strictEqual(body.model, 'qwen3-8b');
  assert.strictEqual(body.messages[1].role, 'user');
  assert.strictEqual(post.init.headers.Authorization, 'Bearer lm-studio');
  state.classify = 'banana'; state.lms = { models: ['qwen3-8b'], reply: 'no idea' };
  r = await am.selectModel('Write a sonnet about autumn leaves falling gently onto a quiet river at dusk, please');
  assert.strictEqual(r.category, 'reasoning', 'both LLM classifiers junk -> heuristic');
  state.lms = { models: [], reply: 'code' };
  r = await am.selectModel('what is love');
  assert.strictEqual(r.category, 'simple', 'LM Studio with no loaded model -> heuristic');
});

test('selectModelAndTools: JSON classifier picks model and filters tools to the offered categories', async () => {
  state.anthropicKey = 'sk-test';
  state.classify = (opts) => { assert.match(opts.system, /- slack\n   - email/); return 'Sure: {"model":"Reasoning","tools":["slack","bogus","email"]}'; };
  const r = await am.selectModelAndTools('Plan the quarter', { toolCategories: ['slack', 'email'] });
  assert.deepStrictEqual(r, { model: ROUTES.reasoning, category: 'reasoning', backend: 'builtin', applied: true, tools: ['slack', 'email'] });
  assert.strictEqual(state.calls[0].opts.max_tokens, 120);
  state.classify = '{"model":"code","tools":"none"}';
  assert.deepStrictEqual((await am.selectModelAndTools('x', { toolCategories: ['slack'] })).tools, [], 'non-array tools -> []');
  state.classify = (opts) => { assert.match(opts.system, /always return \[\]/); return '{"model":"hardest","tools":[]}'; };
  const h = await am.selectModelAndTools('x', { sdk: true });
  assert.strictEqual(h.model, SDK_ROUTES.hardest); assert.strictEqual(h.tools, null, 'no categories offered -> tools stays null');
  state.classify = (opts) => { assert.match(opts.system, /CHALLENGER role/); return '{"model":"hardest"}'; };
  assert.strictEqual((await am.selectModelAndTools('critique this', { context: 'challenger' })).category, 'hardest');
});

test('classifier JSON failure with tool categories offered gives tools: [] (never null); category still falls back', async () => {
  state.anthropicKey = 'sk-test';
  state.classify = 'reasoning';                                   // valid word but no JSON object
  let r = await am.selectModelAndTools('Plan the quarter for us', { toolCategories: ['slack'] });
  assert.deepStrictEqual(r.tools, []);
  assert.strictEqual(r.category, 'reasoning', 'fell back to the one-word classifier');
  state.classify = '{"model":"code","tools":[';                 // truncated JSON -> JSON.parse throws
  r = await am.selectModelAndTools('Plan the quarter for us', { toolCategories: ['slack'] });
  assert.deepStrictEqual(r.tools, []);
  state.classify = new Error('boom');
  r = await am.selectModelAndTools('Plan the quarter for us', { toolCategories: ['slack'] });
  assert.deepStrictEqual(r.tools, []);
  assert.strictEqual(r.category, 'simple', 'heuristic category (short text) when every classifier fails');
  assert.strictEqual((await am.selectModelAndTools('Plan the quarter for us')).tools, null, 'no categories offered -> null');
});

test('documented: "simple" goes to lmstudio/<model> for both route tables when LM Studio is up; the reachability cache expires within 60 s (runs last)', async (t) => {
  state.lms = { models: ['qwen3-8b', 'other'], reply: 'simple' };
  const r = await am.selectModel('what is 2+2', { sdk: true });
  assert.deepStrictEqual(r, { model: 'lmstudio/qwen3-8b', category: 'simple' });
  const r2 = await am.selectModelAndTools('what is 2+2', { sdk: true });
  assert.strictEqual(r2.model, 'lmstudio/qwen3-8b');
  state.lms = { models: ['qwen3-8b', 'other'], reply: 'code' };
  assert.strictEqual((await am.selectModel('refactor this function and fix the code please now')).model, ROUTES.code, 'only simple is redirected');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  state.lms = null;                                                // LM Studio goes offline
  assert.strictEqual((await am.selectModel('what is 2+2')).model, 'lmstudio/qwen3-8b', 'still cached right away');
  t.mock.timers.tick(61_000);
  const r3 = await am.selectModel('what is 2+2');
  assert.strictEqual(r3.model, ROUTES.simple, 'after 60 s the offline LM Studio is re-probed and no longer routed to');
  assert.strictEqual((await am.selectModel('what is 2+2', { sdk: true })).model, SDK_ROUTES.simple);
});

test('noticeFor(): one line naming the verdict, the model that runs, and why', () => {
  const { noticeFor } = require('../lib/auto-model');
  assert.equal(noticeFor(null, 'x'), null);
  const shadow = noticeFor({ category: 'simple', shadow: true, applied: false, wouldPick: 'claude-sdk/claude-sonnet-5-5', backend: 'local:ninfer/qwen3.8-27b', ms: 1181 }, 'claude-sdk/claude-fable-5-1');
  assert.match(shadow, /shadow/); assert.match(shadow, /"simple" would run on claude-sonnet-5-5/); assert.match(shadow, /runs on claude-fable-5-1/); assert.match(shadow, /local ninfer\/qwen3.8-27b, 1\.2 s/);
  const live = noticeFor({ category: 'code', applied: true, model: 'claude-sdk/claude-sonnet-5-5', backend: 'perplexity:pplx-decider-v1.1-27b', confidence: 0.93, ms: 220 }, 'claude-sdk/claude-fable-5-1');
  assert.match(live, /"code" → claude-sonnet-5-5 \(Perplexity decider, confidence 0\.93, 220 ms\)/);
  const lifted = noticeFor({ category: 'simple', applied: true, model: 'claude-sdk/claude-opus-5-5', reason: "lifted to the agent's minimum claude-sdk/claude-opus-5-5", backend: 'builtin' }, 'claude-sdk/claude-opus-5-5');
  assert.match(lifted, /claude-opus-5-5 \(lifted to the agent's minimum/); assert.match(lifted, /keyword rule/);
  const floored = noticeFor({ category: 'math', applied: false, model: null, reason: 'confidence 0.40 below the floor 0.6', backend: 'perplexity:x', confidence: 0.4, ms: 200 }, 'claude-sdk/claude-fable-5-1');
  assert.match(floored, /"math", confidence 0\.40 below the floor 0\.6; this turn runs on claude-fable-5-1/);
});

test('images: the vision route goes through the classifier guards too (shadow logs, never applies; minModel is honoured)', async () => {
  const cl = require('../lib/classifier');
  const settings = require('../lib/settings');
  const orig = settings.getSetting;
  settings.getSetting = (k, d) => (k === 'autoClassifier' ? { backend: 'local', shadow: true } : orig.call(settings, k, d));
  try {
    delete require.cache[require.resolve('../lib/classifier')];
    const r = await am.selectModelAndTools('look at this', { hasImages: true, sdk: true, agent: { name: 'maestro', model: 'claude-sdk/claude-fable-5-1' } });
    assert.equal(r.model, null, 'shadow: nothing applied');
    assert.equal(r.shadow, true); assert.equal(r.category, 'vision'); assert.equal(r.wouldPick, SDK_ROUTES.vision);
  } finally { settings.getSetting = orig; delete require.cache[require.resolve('../lib/classifier')]; }
  const plain = await am.selectModelAndTools('look', { hasImages: true, sdk: true });
  assert.equal(plain.model, SDK_ROUTES.vision, 'builtin: applied as before');
});
