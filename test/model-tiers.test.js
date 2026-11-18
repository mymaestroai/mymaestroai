'use strict';
const test = require('node:test');
const assert = require('node:assert');
const mt = require('../lib/model-tiers');
const { billingOf } = require('../lib/billing');

const SAME = 'Same vendor as the lead: a second opinion, not an outside view. Connect another provider to give it one.';
const PER_USE = 'Billed per use through an API key.';
const LOCAL_NOTE = 'Runs on the same local model as the lead: a second opinion from the same model, not an outside view.';
const NO_CHEAPER = 'No cheaper model is known on the ways this install pays, so it uses the closest one there is.';
const NO_FAST = 'No fast model found; it uses a mid-tier one.';

const CASES = [
  {
    name: '1 Claude subscription only',
    available: ['claude-sdk/claude-opus-5-5', 'claude-sdk/claude-sonnet-5-5', 'claude-sdk/claude-haiku-5-5'],
    lead: 'claude-sdk/default',
    want: { scout: 'claude-sdk/claude-haiku-5-5', builder: 'claude-sdk/claude-sonnet-5-5', researcher: 'claude-sdk/claude-sonnet-5-5', challenger: 'claude-sdk/claude-opus-5-5' },
    notes: [SAME],
  },
  {
    name: '2 ChatGPT subscription only, named tiers',
    available: ['codex-cli/gpt-6', 'codex-cli/gpt-6-mini', 'codex-cli/gpt-6-pro'],
    lead: 'codex-cli/gpt-6',
    want: { scout: 'codex-cli/gpt-6-mini', builder: 'codex-cli/gpt-6', researcher: 'codex-cli/gpt-6', challenger: 'codex-cli/gpt-6-pro' },
    notes: [SAME],
  },
  {
    name: '3 ChatGPT subscription only, unknown names',
    available: ['codex-cli/gpt-6-sol', 'codex-cli/gpt-6-luna'],
    lead: 'codex-cli/gpt-6-luna',
    want: { scout: 'codex-cli/gpt-6-luna', builder: 'codex-cli/gpt-6-luna', researcher: 'codex-cli/gpt-6-luna', challenger: 'codex-cli/gpt-6-luna' },
    notes: [SAME, NO_FAST],
  },
  {
    name: '4 Anthropic API key only',
    available: ['anthropic/claude-sonnet-5-5', 'anthropic/claude-haiku-5-5', 'anthropic/claude-opus-5-5'],
    lead: 'anthropic/claude-sonnet-5-5',
    want: { scout: 'anthropic/claude-haiku-5-5', builder: 'anthropic/claude-sonnet-5-5', researcher: 'anthropic/claude-sonnet-5-5', challenger: 'anthropic/claude-opus-5-5' },
    notes: [`${SAME} ${PER_USE}`],
    perUse: ['challenger', 'scout', 'builder', 'researcher'],
  },
  {
    name: '5 OpenAI API key only',
    available: ['openai/gpt-6', 'openai/gpt-6-mini', 'openai/gpt-6-pro'],
    lead: 'openai/gpt-6',
    want: { scout: 'openai/gpt-6-mini', builder: 'openai/gpt-6', researcher: 'openai/gpt-6', challenger: 'openai/gpt-6-pro' },
    notes: [`${SAME} ${PER_USE}`],
    perUse: ['challenger', 'scout', 'builder', 'researcher'],
  },
  {
    name: '6 Gemini API key only',
    available: ['google/gemini-4-pro', 'google/gemini-4-flash', 'google/gemini-4-flash-lite'],
    lead: 'google/gemini-4-flash',
    want: { scout: 'google/gemini-4-flash-lite', builder: 'google/gemini-4-flash', researcher: 'google/gemini-4-flash', challenger: 'google/gemini-4-pro' },
    notes: [`${SAME} ${PER_USE}`],
    perUse: ['challenger', 'scout', 'builder', 'researcher'],
  },
  {
    name: '7 OpenRouter only, lead Anthropic',
    available: ['openrouter/anthropic/claude-sonnet-5', 'openrouter/x-ai/grok-5', 'openrouter/google/gemini-4-flash'],
    lead: 'openrouter/anthropic/claude-sonnet-5',
    want: { scout: 'openrouter/anthropic/claude-sonnet-5', builder: 'openrouter/anthropic/claude-sonnet-5', researcher: 'openrouter/anthropic/claude-sonnet-5', challenger: 'openrouter/google/gemini-4-flash' },
    notes: [PER_USE, NO_FAST],
    perUse: ['challenger', 'scout', 'builder', 'researcher'],
  },
  {
    name: '8 Local only, one model',
    available: ['ollama/qwen-4'],
    lead: 'ollama/qwen-4',
    want: { scout: 'ollama/qwen-4', builder: 'ollama/qwen-4', researcher: 'ollama/qwen-4', challenger: 'ollama/qwen-4' },
    notes: [LOCAL_NOTE],
  },
  {
    name: '9 Local only, two families',
    available: ['ollama/qwen-4', 'lmstudio/llama-5-small'],
    lead: 'ollama/qwen-4',
    want: { scout: 'ollama/qwen-4', builder: 'ollama/qwen-4', researcher: 'ollama/qwen-4', challenger: 'ollama/qwen-4' },
    notes: [LOCAL_NOTE],
  },
  {
    name: '10 Claude subscription + ChatGPT subscription',
    available: ['claude-sdk/claude-opus-5-5', 'claude-sdk/claude-sonnet-5-5', 'claude-sdk/claude-haiku-5-5', 'codex-cli/gpt-6', 'codex-cli/gpt-6-mini', 'codex-cli/gpt-6-pro'],
    lead: 'claude-sdk/claude-opus-5-5',
    want: { scout: 'claude-sdk/claude-haiku-5-5', builder: 'claude-sdk/claude-sonnet-5-5', researcher: 'claude-sdk/claude-sonnet-5-5', challenger: 'codex-cli/gpt-6-pro' },
    notes: [],
  },
  {
    name: '11 Claude subscription + OpenAI API key',
    available: ['claude-sdk/claude-opus-5-5', 'claude-sdk/claude-sonnet-5-5', 'claude-sdk/claude-haiku-5-5', 'openai/gpt-6', 'openai/gpt-6-mini'],
    lead: 'claude-sdk/claude-opus-5-5',
    want: { scout: 'claude-sdk/claude-haiku-5-5', builder: 'claude-sdk/claude-sonnet-5-5', researcher: 'claude-sdk/claude-sonnet-5-5', challenger: 'openai/gpt-6' },
    notes: [PER_USE],
    perUse: ['challenger'],
  },
  {
    name: '12 Claude subscription + a local model',
    available: ['claude-sdk/claude-opus-5-5', 'claude-sdk/claude-sonnet-5-5', 'claude-sdk/claude-haiku-5-5', 'ollama/qwen-4'],
    lead: 'claude-sdk/claude-sonnet-5-5',
    want: { scout: 'claude-sdk/claude-haiku-5-5', builder: 'claude-sdk/claude-sonnet-5-5', researcher: 'claude-sdk/claude-sonnet-5-5', challenger: 'claude-sdk/claude-opus-5-5' },
    notes: [SAME],
  },
  {
    name: '13 Lead on an API key, a local model exists',
    available: ['anthropic/claude-sonnet-5-5', 'anthropic/claude-haiku-5-5', 'anthropic/claude-opus-5-5', 'ollama/qwen-4'],
    lead: 'anthropic/claude-sonnet-5-5',
    want: { scout: 'ollama/qwen-4', builder: 'ollama/qwen-4', researcher: 'ollama/qwen-4', challenger: 'anthropic/claude-opus-5-5' },
    notes: [`${SAME} ${PER_USE}`],
    perUse: ['challenger'],
  },
  {
    name: '14 Empty available, lead claude-sdk/default',
    available: [],
    lead: 'claude-sdk/default',
    want: { scout: 'claude-sdk/default', builder: 'claude-sdk/default', researcher: 'claude-sdk/default', challenger: 'claude-sdk/default' },
    notes: [SAME, NO_CHEAPER],
  },
  {
    name: '15 Noise ids are never picked',
    available: ['codex/gpt-6', 'perplexity/sonar', 'openai/text-embedding-3', 'openai/gpt-6-audio', 'claude-sdk/claude-sonnet-5-5'],
    lead: 'claude-sdk/claude-sonnet-5-5',
    want: { scout: 'claude-sdk/claude-sonnet-5-5', builder: 'claude-sdk/claude-sonnet-5-5', researcher: 'claude-sdk/claude-sonnet-5-5', challenger: 'claude-sdk/claude-sonnet-5-5' },
    notes: [SAME, NO_FAST],
  },
];

for (const c of CASES) {
  test(`pickTeam: ${c.name}`, () => {
    const team = mt.pickTeam({ available: c.available, lead: c.lead });
    for (const role of ['scout', 'builder', 'researcher', 'challenger']) assert.strictEqual(team[role].model, c.want[role], role);
    assert.deepStrictEqual([...team.notes].sort(), [...c.notes].sort());
    for (const role of ['scout', 'builder', 'researcher', 'challenger']) {
      assert.strictEqual(team[role].perUse, (c.perUse || []).includes(role), `${role} perUse`);
      assert.strictEqual(team[role].route, billingOf(c.want[role]).route);
      assert.strictEqual(team[role].vendor, mt.vendorOf(c.want[role]));
    }
    // Invariants
    const all = [...c.available, c.lead];
    const anyFree = all.some((id) => ['subscription', 'local'].includes(billingOf(id).kind));
    for (const role of ['scout', 'builder', 'researcher']) {
      assert.notStrictEqual(team[role].tier, 'top', `${role} is never top tier`);
      if (anyFree) assert.strictEqual(team[role].perUse, false, `${role} is never per-use while a free route exists`);
    }
    const otherVendor = all.filter((id) => mt.usable(id) && mt.vendorOf(id) !== mt.vendorOf(c.lead) && mt.vendorOf(id) !== 'Local');
    if (otherVendor.length) assert.notStrictEqual(team.challenger.vendor, mt.vendorOf(c.lead));
    assert.ok(mt.explain(team).length === 4);
  });
}

test('pickTeam: scout falls back to a mid-tier model with its note (unknown OpenAI names)', () => {
  const team = mt.pickTeam({ available: ['codex-cli/gpt-6-sol'], lead: 'codex-cli/gpt-6-sol' });
  assert.strictEqual(team.scout.note, NO_FAST);
  assert.strictEqual(team.scout.tier, 'mid');
  assert.strictEqual(team.builder.note, null);
});

test('pickTeam: a name that is not a known tier gives the lead model and the no-cheaper note', () => {
  const team = mt.pickTeam({ available: ['codex-cli/codex-sol'], lead: 'codex-cli/codex-sol' });
  assert.strictEqual(team.builder.model, 'codex-cli/codex-sol');
  assert.strictEqual(team.builder.note, NO_CHEAPER);
  assert.strictEqual(team.scout.note, NO_CHEAPER);
});

test('pickTeam: the newest model of a tier wins, and -latest beats a number', () => {
  const a = mt.pickTeam({ available: ['claude-sdk/claude-sonnet-4-5', 'claude-sdk/claude-sonnet-5-5'], lead: 'claude-sdk/default' });
  assert.strictEqual(a.builder.model, 'claude-sdk/claude-sonnet-5-5');
  const b = mt.pickTeam({ available: ['claude-sdk/claude-sonnet-5-5', 'claude-sdk/claude-sonnet-latest'], lead: 'claude-sdk/default' });
  assert.strictEqual(b.builder.model, 'claude-sdk/claude-sonnet-latest');
});

test('pickTeam: the lead vendor is preferred within a rank', () => {
  const team = mt.pickTeam({
    available: ['claude-sdk/claude-sonnet-5-5', 'codex-cli/gpt-7'],
    lead: 'codex-cli/gpt-6',
  });
  // rank 1 = the lead's own prefix (codex-cli) holds a mid model; Claude is rank 2
  assert.strictEqual(team.builder.model, 'codex-cli/gpt-7');
  assert.strictEqual(team.challenger.model, 'claude-sdk/claude-sonnet-5-5');
});

test('pickTeam: an API model is never a worker while a subscription model is reachable', () => {
  const team = mt.pickTeam({ available: ['openai/gpt-6-mini', 'openai/gpt-6'], lead: 'claude-sdk/default' });
  assert.strictEqual(team.scout.model, 'claude-sdk/default');
  assert.strictEqual(team.scout.perUse, false);
  assert.strictEqual(team.challenger.model, 'openai/gpt-6');
  assert.strictEqual(team.challenger.perUse, true);
});

test('pickTeam: deterministic under shuffling; duplicates are ignored', () => {
  const list = ['claude-sdk/claude-opus-5-5', 'claude-sdk/claude-sonnet-5-5', 'claude-sdk/claude-haiku-5-5', 'codex-cli/gpt-6', 'codex-cli/gpt-6-mini', 'ollama/qwen-4', 'openai/gpt-6-pro'];
  const base = mt.pickTeam({ available: list, lead: 'claude-sdk/claude-sonnet-5-5' });
  const shuffled = [list[4], list[1], list[6], list[0], list[5], list[2], list[3], list[1], list[4], list[0]];
  assert.deepStrictEqual(mt.pickTeam({ available: shuffled, lead: 'claude-sdk/claude-sonnet-5-5' }), base);
  assert.deepStrictEqual(mt.pickTeam({ available: [...list].reverse(), lead: 'claude-sdk/claude-sonnet-5-5' }), base);
});

test('explain: one line per role with the route and the per-use mark', () => {
  const team = mt.pickTeam({ available: ['claude-sdk/claude-sonnet-5-5', 'openai/gpt-6'], lead: 'claude-sdk/claude-sonnet-5-5' });
  assert.deepStrictEqual(mt.explain(team), [
    'challenger: openai/gpt-6 (API, billed per use)',
    'scout: claude-sdk/claude-sonnet-5-5 (Subscription)',
    'builder: claude-sdk/claude-sonnet-5-5 (Subscription)',
    'researcher: claude-sdk/claude-sonnet-5-5 (Subscription)',
  ]);
});

test('vendorOf: prefixes and openrouter vendor segments', () => {
  const v = mt.vendorOf;
  assert.strictEqual(v('claude-sdk/claude-haiku-5-5'), 'Anthropic');
  assert.strictEqual(v('anthropic/claude-opus-5-5'), 'Anthropic');
  assert.strictEqual(v('codex-cli/gpt-6'), 'OpenAI');
  assert.strictEqual(v('openai/gpt-6-mini'), 'OpenAI');
  assert.strictEqual(v('google/gemini-4-flash'), 'Google');
  for (const p of ['local', 'lmstudio', 'ollama', 'omlx', 'ninfer']) assert.strictEqual(v(`${p}/some-model`), 'Local');
  assert.strictEqual(v('openrouter/anthropic/claude-sonnet-5'), 'Anthropic');
  assert.strictEqual(v('openrouter/openai/gpt-6'), 'OpenAI');
  assert.strictEqual(v('openrouter/google/gemini-4-pro'), 'Google');
  assert.strictEqual(v('openrouter/x-ai/grok-5'), 'x-ai');
  assert.strictEqual(v('openrouter/meta-llama/llama-5'), 'meta-llama');
  assert.strictEqual(v('openrouter/deepseek/deepseek-v4'), 'deepseek');
  assert.strictEqual(v('mistral/mistral-large'), 'mistral');
});

test('usable: noise prefixes and non-chat model kinds are refused', () => {
  const u = mt.usable;
  assert.strictEqual(u('codex/gpt-6'), false);
  assert.strictEqual(u('perplexity/sonar'), false);
  assert.strictEqual(u('openai/text-embedding-3'), false);
  assert.strictEqual(u('openai/gpt-6-audio'), false);
  assert.strictEqual(u('openai/gpt-realtime-2'), false);
  assert.strictEqual(u('openai/whisper-2'), false);
  assert.strictEqual(u('ollama/llama-5-instruct'), false);
  assert.strictEqual(u('claude-sdk/default'), true);
  assert.strictEqual(u('codex-cli/gpt-6'), true);
});

test('tierOf: names by vendor', () => {
  const t = mt.tierOf;
  assert.strictEqual(t('claude-sdk/claude-haiku-5-5'), 'fast');
  assert.strictEqual(t('claude-sdk/claude-sonnet-5-5'), 'mid');
  assert.strictEqual(t('claude-sdk/claude-opus-5-5'), 'top');
  assert.strictEqual(t('claude-sdk/claude-fable-5-2'), 'top');
  assert.strictEqual(t('claude-sdk/default'), null);
  assert.strictEqual(t('codex-cli/gpt-6-mini'), 'fast');
  assert.strictEqual(t('openai/gpt-6-nano'), 'fast');
  assert.strictEqual(t('codex-cli/gpt-6'), 'mid');
  assert.strictEqual(t('codex-cli/gpt-6-pro'), 'top');
  assert.strictEqual(t('openai/o3'), 'top');
  assert.strictEqual(t('openai/o4-mini-high'), 'fast');
  assert.strictEqual(t('openai/o1-pro'), 'top');
  assert.strictEqual(t('openai/chatgpt-image'), null);
  assert.strictEqual(t('google/gemini-4-flash-lite'), 'fast');
  assert.strictEqual(t('google/gemini-4-flash'), 'mid');
  assert.strictEqual(t('google/gemini-4-pro'), 'top');
  assert.strictEqual(t('google/gemini-4'), null);
  assert.strictEqual(t('ollama/qwen-4'), 'local');
  assert.strictEqual(t('openrouter/anthropic/claude-sonnet-5'), 'mid');
  assert.strictEqual(t('openrouter/openai/gpt-6-mini'), 'fast');
  assert.strictEqual(t('openrouter/x-ai/grok-5'), null);
  assert.strictEqual(t('openrouter/x-ai/grok-5-mini'), 'fast');
  assert.strictEqual(t('openrouter/deepseek/deepseek-v4-small'), 'fast');
});

test('score: newer is higher and -latest beats a numbered version', () => {
  assert.ok(mt.score('codex-cli/gpt-6') > mt.score('codex-cli/gpt-5.5'));
  assert.ok(mt.score('claude-sdk/claude-opus-5-5') > mt.score('claude-sdk/claude-opus-5'));
  assert.ok(mt.score('claude-sdk/claude-sonnet-latest') > mt.score('claude-sdk/claude-sonnet-9-9'));
});

// A per-use lead with only an unknown-tier subscription model: the workers take the subscription model, never the
// lead's per-use one (owner's rule: no per-use route for a worker while a subscription or local route is connected).
test('a lead on an API key with only claude-sdk/default on a subscription: workers on the subscription', () => {
  const t = mt.pickTeam({ available: ['claude-sdk/default', 'openai/gpt-6'], lead: 'openai/gpt-6' });
  for (const r of ['scout', 'builder', 'researcher']) {
    assert.strictEqual(t[r].model, 'claude-sdk/default', r);
    assert.strictEqual(t[r].perUse, false, r);
  }
});
