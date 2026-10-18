'use strict';
// Behavioural tests for lib/model-quirks.js: every rule with a triggering and a non-triggering model id.
const test = require('node:test');
const assert = require('node:assert');
const Q = require('../lib/model-quirks.js');

const q = Q.quirks;
const quiet = (fn) => { const l = console.log; console.log = () => {}; try { return fn(); } finally { console.log = l; } };
const apply = (body, o) => quiet(() => Q.applyQuirks(body, o));

test('codex and *-pro models are Responses-API-only and reject temperature/top_p', () => {
  for (const m of ['gpt-5-codex', 'gpt-5.1-codex-max', 'o3-pro', 'gpt-5-pro', 'gpt-5.2-pro']) {
    assert.strictEqual(q(m).api, 'responses', m);
    assert.deepStrictEqual(q(m).drop, ['temperature', 'top_p'], m);
    assert.strictEqual(q(m).maxOutput, 128000, m);
    assert.strictEqual(Q.supportsChatCompletions(m), false, m);
  }
  for (const m of ['gpt-5-mini', 'o3-mini', 'gpt-5.2', 'gpt-4o']) assert.notStrictEqual(q(m).api, 'responses', m);
});

test('o-series: 100k cap, drops sampling params, renames max_tokens, no parallel tools', () => {
  for (const m of ['o1', 'o3', 'o4-mini', 'o3-mini']) {
    const r = q(m);
    assert.deepStrictEqual([r.maxOutput, r.reasoning, r.parallelTools, r.rename], [100000, true, false, { max_tokens: 'max_completion_tokens' }], m);
    assert.deepStrictEqual(r.drop, ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty'], m);
  }
  for (const m of ['omega', 'gpt-4o', 'gpt-5']) assert.notStrictEqual(q(m).maxOutput, 100000, m);
  assert.strictEqual(q('omega').matched, false);   // needs a digit after the leading "o"
});

test('gpt-5-chat vs plain gpt-5 vs gpt-5.5 / gpt-5.6 temperature handling', () => {
  assert.ok(!q('gpt-5-chat').drop.includes('max_tokens'));
  assert.deepStrictEqual(q('gpt-5-chat').rename, { max_tokens: 'max_completion_tokens' });
  assert.strictEqual(q('gpt-5-chat').acceptsTemperature, false);
  assert.strictEqual(q('gpt-5').acceptsTemperature, true);        // plain gpt-5 keeps temperature
  assert.strictEqual(q('gpt-5.4-mini').acceptsTemperature, true);
  assert.strictEqual(q('gpt-5.5').acceptsTemperature, false);
  assert.strictEqual(q('gpt-5.5').api, 'chat');                   // 5.5 is fine on chat/completions
  assert.strictEqual(q('gpt-5.6-sol').api, 'responses');          // 5.6 needs /v1/responses for tools
  assert.strictEqual(q('gpt-5.6-sol').rename, null);
  assert.strictEqual(Q.acceptsTemperature('gpt-5.5'), false);
  assert.strictEqual(Q.acceptsTemperature('claude-opus-5'), true);
});

test('gpt-6 / gpt-daybreak / chat-latest: responses API + max_tokens rename; prefix-anchored', () => {
  for (const m of ['gpt-6-sol', 'gpt-daybreak', 'chat-latest']) {
    assert.strictEqual(q(m).api, 'responses', m);
    assert.deepStrictEqual(q(m).rename, { max_tokens: 'max_completion_tokens' }, m);
  }
  assert.strictEqual(q('my-gpt-6').rename, null);   // anchored with ^: falls through to the generic /gpt/ rule
});

test('gpt-4 family is capped at 16384 and generic gpt at 128000', () => {
  assert.strictEqual(q('gpt-4o').maxOutput, 16384);
  assert.strictEqual(q('gpt-4.1').maxOutput, 16384);
  assert.strictEqual(q('gpt-3.5-turbo').maxOutput, 128000);
  assert.strictEqual(q('gpt-4o').reasoning, false);
});

test('Anthropic, Google, xAI and other vendors: ceiling, schema tier, floor', () => {
  const table = [
    ['claude-opus-5', 128000, 'anthropic', 0], ['claude-fable-5-1', 128000, 'anthropic', 0], ['claude-sonnet-4', 128000, 'anthropic', 0],
    ['claude-sonnet-5', 128000, 'anthropic', 512], ['claude-haiku-4-5-20251001', 64000, 'anthropic', 0],
    ['gemini-3.1-flash', 65536, 'vertex', 512], ['gemini-2.5-pro', 65536, 'vertex', 512],
    ['grok-4', 131072, 'openai', 0], ['mythos-1', 128000, 'anthropic', 0], ['kimi-k2.5', 260000, 'openai', 0],
    ['deepseek-v3', 32000, 'openai', 0], ['glm-5', 32000, 'openai', 0], ['qwen3-32b', 32000, 'openai', 0],
    ['nemotron-70b', 32000, 'openai', 0], ['llama-3.3', 32000, 'openai', 0],
  ];
  for (const [m, out, schema, min] of table) {
    const r = q(m);
    assert.deepStrictEqual([r.maxOutput, r.schema, r.minOutput, r.matched], [out, schema, min, true], m);
  }
  assert.strictEqual(q('claude-sonnet-5').reasoning, true);
  assert.strictEqual(q('claude-sonnet-4').reasoning, false);
});

test('unknown / empty / nullish ids get the default; cyber/ prefix is stripped before matching', () => {
  for (const m of ['mystery-model', '', null, undefined]) {
    const r = q(m);
    assert.deepStrictEqual([r.matched, r.api, r.maxOutput, r.schema, r.parallelTools, r.drop], [false, 'chat', 32000, 'openai', true, []], String(m));
  }
  assert.strictEqual(q('cyber/gpt-5.5').model, 'gpt-5.5');
  assert.strictEqual(q('cyber/gpt-5.5').acceptsTemperature, false);
  assert.strictEqual(q('cyber/claude-opus-5').schema, 'anthropic');
  assert.strictEqual(q('gpt-5.5'), q('gpt-5.5'));   // cached
});

test('capOutputTokens clamps to the ceiling; missing/zero request means "the ceiling"', () => {
  assert.strictEqual(Q.capOutputTokens('claude-haiku-4-5', 100000), 64000);
  assert.strictEqual(Q.capOutputTokens('claude-haiku-4-5', 1000), 1000);
  assert.strictEqual(Q.capOutputTokens('claude-haiku-4-5'), 64000);
  assert.strictEqual(Q.capOutputTokens('claude-haiku-4-5', 0), 64000);
});

test('floorOutputTokens raises tiny budgets only on floor models', () => {
  assert.strictEqual(Q.floorOutputTokens('claude-sonnet-5', 8), 512);
  assert.strictEqual(Q.floorOutputTokens('claude-sonnet-5', 512), 512);
  assert.strictEqual(Q.floorOutputTokens('claude-sonnet-5', 4000), 4000);
  assert.strictEqual(Q.floorOutputTokens('gemini-3.1-flash', 100), 512);
  assert.strictEqual(Q.floorOutputTokens('claude-opus-5', 8), 8);
  assert.strictEqual(Q.floorOutputTokens('claude-sonnet-5', 0), 0);
  assert.strictEqual(Q.floorOutputTokens('claude-sonnet-5', undefined), undefined);
});

test('turnOutputTokens: 4096 for plain, 16384 for reasoning, never above the ceiling or below the floor', () => {
  assert.strictEqual(Q.turnOutputTokens('claude-opus-5'), 4096);
  assert.strictEqual(Q.turnOutputTokens('gpt-4o'), 4096);
  assert.strictEqual(Q.turnOutputTokens('o3'), 16384);
  assert.strictEqual(Q.turnOutputTokens('claude-sonnet-5'), 16384);
  assert.strictEqual(Q.turnOutputTokens('gpt-5'), 16384);
  assert.strictEqual(Q.turnOutputTokens('unknown-thing'), 4096);
});

test('parallel tool support: only the o-series opts out', () => {
  assert.strictEqual(Q.supportsParallelTools('o3'), false);
  assert.strictEqual(Q.supportsParallelTools('gpt-5'), true);
  assert.strictEqual(Q.supportsParallelTools('claude-opus-5'), true);
  assert.strictEqual(Q.supportsChatCompletions('gpt-5.5'), true);
  assert.strictEqual(Q.supportsChatCompletions('gpt-6-sol'), false);
});

test('applyQuirks: o-series drops sampling params, renames and records every change', () => {
  const { body, changes } = apply({ model: 'o3', max_tokens: 4000, temperature: 0.2, top_p: 1, messages: [] });
  assert.deepStrictEqual(body, { model: 'o3', max_completion_tokens: 4000, messages: [] });
  assert.deepStrictEqual(changes, ['dropped temperature', 'dropped top_p', 'max_tokens→max_completion_tokens']);
});

test('applyQuirks: clamps over-ceiling budgets, raises sub-floor ones, leaves other models alone', () => {
  assert.deepStrictEqual(apply({ model: 'claude-haiku-4-5', max_tokens: 99999 }).body.max_tokens, 64000);
  const r = apply({ model: 'claude-sonnet-5', max_tokens: 8 });
  assert.strictEqual(r.body.max_tokens, 512);
  assert.deepStrictEqual(r.changes, ['max_tokens 8→512 (reasoning floor)']);
  const same = apply({ model: 'claude-opus-5', max_tokens: 1000, temperature: 0.3 });
  assert.deepStrictEqual([same.body.max_tokens, same.body.temperature, same.changes], [1000, 0.3, []]);
  assert.strictEqual(apply({ model: 'o3', max_completion_tokens: 500000 }).body.max_completion_tokens, 100000);
  assert.deepStrictEqual(apply({ model: 'gpt-5.5', temperature: 0 }).changes, ['dropped temperature']);
});

test('applyQuirks direct: gpt-5/6/o-series get max_completion_tokens; others keep max_tokens', () => {
  const g5 = apply({ model: 'gpt-5.5', max_tokens: 1000 }, { direct: true });
  assert.deepStrictEqual([g5.body.max_completion_tokens, 'max_tokens' in g5.body], [1000, false]);
  assert.match(g5.changes[0], /direct openai/);
  assert.strictEqual(apply({ model: 'gpt-4o', max_tokens: 1000 }, { direct: true }).body.max_tokens, 1000);
  assert.strictEqual(apply({ model: 'claude-opus-5', max_tokens: 1000 }, { direct: true }).body.max_tokens, 1000);
  assert.strictEqual(apply({ model: 'gpt-5.5' }, { direct: true }).changes.length, 0);
});

test('gpt-5-chat renames max_tokens to max_completion_tokens (gateway and direct) instead of dropping it', () => {
  const { body, changes } = apply({ model: 'gpt-5-chat', max_tokens: 4000, temperature: 0.5 });
  assert.strictEqual(body.max_tokens, undefined);
  assert.strictEqual(body.max_completion_tokens, 4000);
  assert.strictEqual(body.temperature, undefined);
  assert.deepStrictEqual(changes, ['dropped temperature', 'max_tokens→max_completion_tokens']);
  const d = apply({ model: 'gpt-5-chat', max_tokens: 4000 }, { direct: true });
  assert.strictEqual(d.body.max_completion_tokens, 4000);
  assert.strictEqual(d.body.max_tokens, undefined);
});

test('direct mode strips the "cyber/" namespace before testing, so cyber/gpt-5.5 is renamed too', () => {
  const d = apply({ model: 'cyber/gpt-5.5', max_tokens: 1000 }, { direct: true });
  assert.strictEqual(d.body.max_tokens, undefined);
  assert.strictEqual(d.body.max_completion_tokens, 1000);
  assert.strictEqual(apply({ model: 'cyber/o3', max_tokens: 1000 }, { direct: true }).body.max_completion_tokens, 1000);
  assert.strictEqual(apply({ model: 'cyber/gpt-6-sol', max_tokens: 1000 }, { direct: true }).body.max_completion_tokens, 1000);
  assert.strictEqual(apply({ model: 'gpt-5.5', max_tokens: 1000 }, { direct: true }).body.max_completion_tokens, 1000);
  assert.strictEqual(apply({ model: 'cyber/gpt-4o', max_tokens: 1000 }, { direct: true }).body.max_tokens, 1000);
  assert.strictEqual(apply({ model: 'cyber/gpt-5.5', max_tokens: 1000 }).body.max_tokens, 1000);
});

test('fallbackModelFor maps each family to a substitute and defaults to claude-sonnet-5', () => {
  const f = Q.fallbackModelFor;
  assert.strictEqual(f('claude-fable-5-1'), 'claude-opus-5');
  assert.strictEqual(f('claude-opus-5'), 'claude-sonnet-5');
  assert.strictEqual(f('claude-sonnet-5'), 'claude-fable-5-1');
  assert.strictEqual(f('claude-haiku-4-5'), 'claude-sonnet-5');
  for (const m of ['gpt-5.5', 'o3', 'o4-mini', 'gemini-pro', 'grok-4', 'kimi-k2', 'glm-5']) assert.strictEqual(f(m), 'claude-sonnet-5', m);
  for (const m of ['qwen3', '', null, undefined]) assert.strictEqual(f(m), 'claude-sonnet-5', String(m));
});

test('fallbacks never ping-pong: a fallback never points back at the model it replaced, and never maps to itself', () => {
  const f = Q.fallbackModelFor;
  const ms = ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'gpt-5.5', 'o3', 'gemini-pro', 'grok-4', 'kimi-k2', 'glm-5', 'qwen3'];
  for (const m of ms) {
    const fb = f(m);
    assert.notStrictEqual(fb, m, `${m} maps to itself`);
    assert.notStrictEqual(f(fb), m, `${m} <-> ${fb} ping-pong`);
  }
});

test('listRules mirrors the rule table, including minOut', () => {
  const rules = Q.listRules();
  assert.strictEqual(rules.length, 27);
  const codex = rules.find(r => r.pattern === 'codex');
  assert.deepStrictEqual(codex, { pattern: 'codex', maxOutput: 128000, minOut: 0, schema: 'openai', api: 'responses', drop: ['temperature', 'top_p'], rename: null, reasoning: true });
  const opus = rules.find(r => r.pattern === 'opus');
  assert.deepStrictEqual([opus.api, opus.drop, opus.reasoning], ['chat', [], false]);
  assert.strictEqual(rules.find(r => r.pattern === 'sonnet-5').minOut, 512);
  assert.strictEqual(rules.find(r => r.pattern === 'gemini').minOut, 512);
  assert.ok(rules.every(r => Number.isInteger(r.minOut)));
});
