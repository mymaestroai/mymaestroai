'use strict';
// The optional decider behind Auto model: off by default; local and Perplexity backends with fake HTTP; the fallthrough
// chain; keep-on-box agents never go hosted; the confidence floor, the agent's minimum model, shadow mode; tallies.
const { test } = require('node:test');
const assert = require('node:assert');
const { createClassifier, CATEGORIES, familyOf } = require('../lib/classifier');

function rig({ settings = {}, keys = { perplexity: 'k' }, urls = { ninfer: 'http://ninfer.test/v1' }, local = {}, pplx = {} } = {}) {
  const calls = []; const logs = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/models')) { if (local.down) throw new Error('ECONNREFUSED'); return { ok: true, json: async () => ({ data: [{ id: 'qwen3.8-27b' }, { id: 'other' }] }) }; }
    if (url.endsWith('/chat/completions')) { if (local.fail) return { ok: false, status: 500 }; return { ok: true, json: async () => ({ choices: [{ message: { content: local.reply || 'Thinking about it... the answer is hardest' } }] }) }; }
    if (url.includes('perplexity')) { if (pplx.fail) return { ok: false, status: 429 }; return { ok: true, json: async () => ({ answers: { category: { type: 'choice', choice: pplx.choice || 'reasoning', confidence: pplx.confidence == null ? 0.9 : pplx.confidence, probabilities: { reasoning: 0.9 } } } }) }; }
    throw new Error('unexpected ' + url);
  };
  const cl = createClassifier({ getSetting: (k) => settings[k], getProviderKey: (p) => keys[p] || null, getProviderUrl: (p) => urls[p] || null, fetchImpl, now: () => 1000, log: (s) => logs.push(s), keepOnBoxDefault: () => ['gp', 'counsel'] });
  return { cl, calls, logs };
}

test('off by default: builtin backend means classify() returns null and nothing is called', async () => {
  const { cl, calls } = rig();
  assert.strictEqual(cl.enabled(), false);
  assert.strictEqual(await cl.classify({ text: 'anything' }), null);
  assert.strictEqual(calls.length, 0);
  assert.deepStrictEqual(cl.config().keepOnBox, ['gp', 'counsel']);
  assert.strictEqual(cl.config().confidenceFloor, 0.6);
});

test('local backend: finds the server, uses the configured model when present, sends the definitions, reads the last category word', async () => {
  const { cl, calls } = rig({ settings: { autoClassifier: { backend: 'local', localModel: 'other' } }, local: { reply: 'Hmm, simple or code... final: code' } });
  const v = await cl.classify({ text: 'fix the test' });
  assert.deepStrictEqual([v.category, v.confidence, v.backend, v.offBox], ['code', null, 'local:ninfer/other', false]);
  const body = JSON.parse(calls[1].init.body);
  assert.strictEqual(body.model, 'other'); assert.match(body.messages[0].content, /hardest = deep ambiguity/); assert.strictEqual(body.max_tokens, 400, 'thinking on by default');
  const nt = rig({ settings: { autoClassifier: { backend: 'local', localThinking: false } }, local: { reply: '{"category":"math"}' } });
  const v2 = await nt.cl.classify({ text: 'prove it' });
  assert.strictEqual(v2.category, 'math');
  const b2 = JSON.parse(nt.calls[1].init.body); assert.strictEqual(b2.response_format.type, 'json_schema'); assert.deepStrictEqual(b2.chat_template_kwargs, { enable_thinking: false });
});

test('perplexity backend: decisions request shape and calibrated confidence; images short-circuit to vision', async () => {
  const { cl, calls } = rig({ settings: { autoClassifier: { backend: 'perplexity' } }, pplx: { choice: 'hardest', confidence: 0.81 } });
  const v = await cl.classify({ text: 'Deploy at 3x' });
  assert.deepStrictEqual([v.category, v.confidence, v.backend, v.offBox], ['hardest', 0.81, 'perplexity:pplx-decider-v1.1-27b', true]);
  const body = JSON.parse(calls[0].init.body);
  assert.strictEqual(body.model, 'pplx-decider-v1.1-27b'); assert.ok(body.state.includes('Deploy at 3x')); assert.deepStrictEqual(Object.keys(body.questions.category.criteria), CATEGORIES);
  assert.strictEqual(calls[0].init.headers.authorization, 'Bearer k');
  assert.deepStrictEqual(await cl.classify({ text: 'look', hasImages: true }), { category: 'vision', confidence: 1, backend: 'images', ms: 0 });
});

test('chain: local+perplexity falls through when local is down; keep-on-box agents never go hosted; all failing -> null', async () => {
  const a = rig({ settings: { autoClassifier: { backend: 'local+perplexity' } }, local: { down: true }, pplx: { choice: 'simple' } });
  const v = await a.cl.classify({ text: 'hi there friend', agent: { name: 'trader' } });
  assert.strictEqual(v.backend, 'perplexity:pplx-decider-v1.1-27b'); assert.strictEqual(a.cl.stats().errors.local, 1);
  const b = rig({ settings: { autoClassifier: { backend: 'local+perplexity' } }, local: { down: true } });
  assert.strictEqual(await b.cl.classify({ text: 'how is Sam', agent: { name: 'gp' } }), null, 'doc stays on the box, so with local down there is no verdict');
  assert.ok(b.logs.some(l => /keep on box/.test(l)));
  assert.ok(!b.calls.some(c => c.url.includes('perplexity')));
  const c = rig({ settings: { autoClassifier: { backend: 'perplexity' } }, keys: {} });
  assert.strictEqual(await c.cl.classify({ text: 'x y z' }), null, 'no key -> null -> builtin chain');
});

test('guard: confidence floor keeps the agent\'s model; minModel lifts; shadow applies nothing; tallies and agreement', () => {
  const { cl } = rig({ settings: { autoClassifier: { backend: 'perplexity', confidenceFloor: 0.7 } } });
  const low = cl.guard({ model: 'claude-sdk/claude-sonnet-5-5', category: 'simple', confidence: 0.5, backend: 'p', ms: 1 }, { name: 'a', minModel: null }, { fallbackModel: 'claude-sdk/claude-opus-5-5', builtinCategory: 'simple' });
  assert.deepStrictEqual([low.applied, low.model, low.shadow], [false, 'claude-sdk/claude-opus-5-5', false]); assert.match(low.reason, /below the floor/);
  const lifted = cl.guard({ model: 'claude-sdk/claude-sonnet-5-5', category: 'simple', confidence: 0.95, backend: 'p', ms: 1 }, { name: 'trader', minModel: 'claude-sdk/claude-opus-5-5' }, { builtinCategory: 'reasoning' });
  assert.deepStrictEqual([lifted.applied, lifted.model], [true, 'claude-sdk/claude-opus-5-5']); assert.match(lifted.reason, /minimum/);
  const fine = cl.guard({ model: 'claude-sdk/claude-fable-5-1', category: 'hardest', confidence: 0.9, backend: 'p', ms: 1 }, { name: 'trader', minModel: 'claude-sdk/claude-opus-5-5' }, {});
  assert.deepStrictEqual([fine.applied, fine.model], [true, 'claude-sdk/claude-fable-5-1']);
  const nullConf = cl.guard({ model: 'claude-sdk/claude-opus-5-5', category: 'reasoning', confidence: null, backend: 'local', ms: 1 }, {}, {});
  assert.strictEqual(nullConf.applied, true, 'no confidence (local) means no floor');
  const s = cl.stats(); assert.strictEqual(s.turns, 4); assert.strictEqual(s.floored, 1); assert.strictEqual(s.lifted, 1); assert.strictEqual(s.agree, 1); assert.strictEqual(s.disagree, 1);
  const sh = rig({ settings: { autoClassifier: { backend: 'local', shadow: true } } });
  const g = sh.cl.guard({ model: 'claude-sdk/claude-sonnet-5-5', category: 'simple', confidence: null, backend: 'local', ms: 1 }, {}, {});
  assert.deepStrictEqual([g.shadow, g.applied, g.model], [true, false, 'claude-sdk/claude-sonnet-5-5']); assert.strictEqual(sh.cl.stats().shadow, 1);
  cl.resetStats(); assert.strictEqual(cl.stats().turns, 0);
});

test('familyOf and probeAll', async () => {
  assert.deepStrictEqual(['claude-sdk/claude-fable-5-1[1m]', 'claude-sdk/claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sdk/claude-haiku-5-5', 'gpt-5.6', 'default'].map(familyOf), ['fable', 'opus', 'sonnet', 'haiku', null, 'opus']);
  const { cl } = rig({ settings: { autoClassifier: { backend: 'local+perplexity' } }, local: { reply: 'code' }, pplx: { choice: 'code', confidence: 0.99 } });
  const p = await cl.probeAll({ text: 'fix it' });
  assert.strictEqual(p.local.category, 'code'); assert.strictEqual(p.perplexity.category, 'code');
  const onbox = await cl.probeAll({ text: 'fix it', agent: { name: 'gp' } });
  assert.deepStrictEqual(onbox.perplexity, { skipped: 'keep on box' });
});

test('local backend: when the thinking run never names a category, one retry with thinking off and constrained output answers', async () => {
  let n = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/models')) return { ok: true, json: async () => ({ data: [{ id: 'q' }] }) };
    n++;
    return { ok: true, json: async () => ({ choices: [{ message: { content: n === 1 ? 'Let me think about the weekly limit and what redesign means...' : '{"category":"reasoning"}' } }] }) };
  };
  const cl = createClassifier({ getSetting: (k) => ({ autoClassifier: { backend: 'local' } })[k], getProviderUrl: () => 'http://x.test/v1', fetchImpl, log: () => {} });
  const v = await cl.classify({ text: 'redesign how agents pick models' });
  assert.strictEqual(v.category, 'reasoning'); assert.strictEqual(n, 2, 'exactly one retry');
});

test('shadowAll(): true only when a real backend is chosen AND shadow is on (shadow week watches every agent)', () => {
  assert.equal(rig().cl.shadowAll(), false, 'builtin, no shadow');
  assert.equal(rig({ settings: { autoClassifier: { backend: 'builtin', shadow: true } } }).cl.shadowAll(), false, 'builtin with shadow means nothing to shadow');
  assert.equal(rig({ settings: { autoClassifier: { backend: 'local', shadow: false } } }).cl.shadowAll(), false, 'live mode is not shadow');
  assert.equal(rig({ settings: { autoClassifier: { backend: 'local+perplexity', shadow: true } } }).cl.shadowAll(), true);
});

test('guard() keeps the recent verdicts (newest first) with agent, both categories, would-pick and what ran; reset clears them', () => {
  const { cl } = rig({ settings: { autoClassifier: { backend: 'local', shadow: true } } });
  cl.guard({ model: 'claude-sdk/claude-sonnet-5-5', category: 'simple', confidence: null, backend: 'local:ninfer/qwen', ms: 480 }, { name: 'maestro' }, { fallbackModel: 'claude-sdk/claude-fable-5-1', builtinCategory: 'code' });
  cl.guard({ model: 'claude-sdk/claude-opus-5-5', category: 'reasoning', confidence: 0.9, backend: 'perplexity:x', ms: 220 }, { name: 'trader' }, { fallbackModel: 'claude-sdk/claude-opus-5-5', builtinCategory: 'reasoning' });
  const r = cl.stats().recent;
  assert.equal(r.length, 2);
  assert.equal(r[0].agent, 'trader');
  assert.deepEqual([r[1].agent, r[1].category, r[1].builtinCategory, r[1].wouldPick, r[1].ran, r[1].shadow, r[1].applied, r[1].ms], ['maestro', 'simple', 'code', 'claude-sdk/claude-sonnet-5-5', 'claude-sdk/claude-fable-5-1', true, false, 480]);
  cl.resetStats();
  assert.equal(cl.stats().recent.length, 0);
});
