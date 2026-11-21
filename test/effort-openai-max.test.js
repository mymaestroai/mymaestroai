'use strict';
// OpenAI and Codex: the hub's "Max" (Advanced) / "Deepest" (Simple) reaches the model's own `max` where the model has
// it; gpt-5.5 and gpt-5.5-pro stop at xhigh; gpt-5.5-pro takes nothing below medium (Low and Quick go up to medium);
// Codex models follow the levels their own catalog lists. "ultra" is sent only where that catalog lists it.
const { test } = require('node:test');
const assert = require('node:assert');

function fresh() { delete require.cache[require.resolve('../lib/effort.js')]; return require('../lib/effort.js'); }

test('API: the GPT-5.6 and GPT-6 families get max; gpt-5.5 stays at xhigh', () => {
  const e = fresh();
  for (const m of ['openai/gpt-5.6-sol', 'openai/gpt-5.6-terra', 'openai/gpt-5.6-luna', 'openai/gpt-6-sol', 'openai/gpt-6.2-astra', 'openai/gpt-6.1-terra']) {
    assert.strictEqual(e.forModel(m, 'max'), 'max', m);
    assert.strictEqual(e.forModel(m, 'xhigh'), 'xhigh', m);
    assert.strictEqual(e.forModel(m, 'low'), 'low', m);
  }
  assert.strictEqual(e.forModel('openai/gpt-5.5', 'max'), 'xhigh');
  assert.strictEqual(e.forModel('openai/gpt-5.5', 'low'), 'low');
  assert.strictEqual(e.forModel('openai/o3', 'max'), 'xhigh');
});

test('API: gpt-5.5-pro takes medium..xhigh: max -> xhigh, low -> medium (never refused)', () => {
  const e = fresh();
  assert.strictEqual(e.forModel('openai/gpt-5.5-pro', 'max'), 'xhigh');
  assert.strictEqual(e.forModel('openai/gpt-5.5-pro', 'xhigh'), 'xhigh');
  assert.strictEqual(e.forModel('openai/gpt-5.5-pro', 'high'), 'high');
  assert.strictEqual(e.forModel('openai/gpt-5.5-pro', 'medium'), 'medium');
  assert.strictEqual(e.forModel('openai/gpt-5.5-pro', 'low'), 'medium');
  assert.strictEqual(e.forTurn('openai/gpt-5.5-pro', 'low', 'default'), 'medium', 'Simple Quick');
  assert.strictEqual(e.forModel('openai/gpt-5.5-pro', 'default'), null, 'no level chosen: nothing sent');
});

test('Simple: Quick, Balanced, Thorough, Deepest per model', () => {
  const e = fresh();
  const row = (m) => ['low', 'medium', 'high', 'max'].map((l) => e.forTurn(m, l, 'default'));
  assert.deepStrictEqual(row('openai/gpt-5.6-sol'), ['low', 'medium', 'high', 'max']);
  assert.deepStrictEqual(row('openai/gpt-5.5'), ['low', 'medium', 'high', 'xhigh']);
  assert.deepStrictEqual(row('openai/gpt-5.5-pro'), ['medium', 'medium', 'high', 'xhigh']);
  assert.deepStrictEqual(row('codex-cli/gpt-6-luna'), ['low', 'medium', 'high', 'max']);
});

test('Codex: before the catalog is read, the family rule; after, the levels the catalog lists', () => {
  const e = fresh();
  assert.strictEqual(e.forModel('codex-cli/gpt-6-astra', 'max'), 'max');
  assert.strictEqual(e.forModel('codex-cli/gpt-5.5', 'max'), 'xhigh');
  e.setCodexLevels([
    { id: 'gpt-6-astra', levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    { id: 'gpt-5.5-codex', levels: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'gpt-old', levels: ['medium', 'high'] },
    { id: 'gpt-weird', levels: ['ultra', 'persistent'] },
    { id: 'no-levels' },
  ]);
  assert.strictEqual(e.forModel('codex-cli/gpt-6-astra', 'max'), 'max', 'the catalog lists max');
  assert.strictEqual(e.forModel('codex-cli/gpt-5.5-codex', 'max'), 'xhigh');
  assert.strictEqual(e.forModel('codex-cli/gpt-old', 'max'), 'high');
  assert.strictEqual(e.forModel('codex-cli/gpt-old', 'low'), 'medium', 'below the lowest: up to it');
  assert.strictEqual(e.forModel('codex-cli/gpt-weird', 'max'), null, 'listed, but with no hub level: nothing is sent');
  assert.strictEqual(e.forModel('codex-cli/no-levels', 'max'), 'xhigh', 'no list: the family rule');
});

test('a new catalog replaces the old one: removed models and levels are gone; levels are read case-blind', () => {
  const e = fresh();
  e.setCodexLevels([{ id: 'gpt-6-astra', levels: ['low', 'max'] }, { id: 'gpt-old', levels: ['medium'] }]);
  assert.strictEqual(e.forModel('codex-cli/gpt-old', 'max'), 'medium');
  e.setCodexLevels([{ id: 'gpt-6-astra', levels: ['LOW', 'High'] }]);
  assert.strictEqual(e.forModel('codex-cli/gpt-6-astra', 'max'), 'high', 'max no longer listed: the new list rules');
  assert.strictEqual(e.forModel('codex-cli/gpt-old', 'max'), 'xhigh', 'gone from the catalog: the family rule');
  e.setCodexLevels([{ id: 'gpt-6-astra' }]);
  assert.strictEqual(e.forModel('codex-cli/gpt-6-astra', 'max'), 'max', 'no level data: the family rule');
  e.setCodexLevels(null);
  assert.strictEqual(e.forModel('codex-cli/gpt-6-astra', 'max'), 'max', 'not a list: nothing changes');
});

test('family rules have version boundaries: gpt-60 or gpt-5.60 are not GPT-6 / GPT-5.6, gpt-5.5-proto is not gpt-5.5-pro', () => {
  const e = fresh();
  assert.strictEqual(e.forModel('openai/gpt-6', 'max'), 'max');
  assert.strictEqual(e.forModel('openai/gpt-6.2-sol', 'max'), 'max');
  assert.strictEqual(e.forModel('openai/gpt-60-test', 'max'), 'xhigh');
  assert.strictEqual(e.forModel('openai/gpt-5.60', 'max'), 'xhigh');
  assert.strictEqual(e.forModel('openai/gpt-5.5-pro-2026-10-01', 'low'), 'medium');
  assert.strictEqual(e.forModel('openai/gpt-5.5-proto', 'low'), 'low');
});

test('none and minimal are never sent; ultra only where the catalog lists it (see effort-ultra.test.js)', () => {
  const e = fresh();
  e.setCodexLevels([{ id: 'gpt-6-astra', levels: ['none', 'minimal', 'low', 'max', 'ultra'] }]);
  for (const l of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'none', 'minimal']) {
    const v = e.forModel('codex-cli/gpt-6-astra', l);
    assert.ok(v === null || ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(v), l + ' -> ' + v);
  }
  assert.strictEqual(e.forModel('codex-cli/gpt-6-astra', 'ultra'), 'ultra', 'listed by the catalog: sent');
  assert.strictEqual(e.forModel('codex-cli/gpt-6-astra', 'none'), null, 'not a hub level: nothing');
});

test('Claude and Gemini are unchanged', () => {
  const e = fresh();
  assert.strictEqual(e.forModel('claude-sdk/claude-opus-5-5', 'max'), 'max');
  assert.strictEqual(e.forModel('anthropic/claude-sonnet-5-5', 'low'), 'low');
  assert.strictEqual(e.forModel('google/gemini-flash-latest', 'max'), 'high');
});

test('the Codex catalog reader keeps each model\'s levels; discovery and the cached list hand them to lib/effort', () => {
  const fs = require('fs'); const path = require('path');
  const idx = fs.readFileSync(path.join(__dirname, '..', 'lib', 'codex-cli', 'index.js'), 'utf8');
  assert.match(idx, /levels: Array\.isArray\(m\.supported_reasoning_levels\) \? m\.supported_reasoning_levels\.map\(/);
  const md = fs.readFileSync(path.join(__dirname, '..', 'lib', 'model-discovery.js'), 'utf8');
  assert.match(md, /require\('\.\/effort'\)\.setCodexLevels\(codexModels\)/);
  assert.match(md, /require\('\.\/effort'\)\.setCodexLevels\(cache\['codex-cli-info'\]\)/);
});
