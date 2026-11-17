'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { hostedOutputCap, effectiveOutputTokens, LOCAL_PROMPT_MARGIN } = require('../lib/output-cap');

test('hostedOutputCap keeps the old per-model table', () => {
  assert.strictEqual(hostedOutputCap('anthropic/claude-sonnet-5-1'), 128000);
  assert.strictEqual(hostedOutputCap('some/unknown-model'), 32000);
  assert.strictEqual(hostedOutputCap('openai/gpt-x'), 100000);
  assert.strictEqual(LOCAL_PROMPT_MARGIN, 1024);
});

test('a local model with an explicit Max output tokens may use the room its window leaves', () => {
  const r = effectiveOutputTokens({ model: 'omlx/test-model', maxTokens: 65536, explicit: 65536, window: 262144, promptTokens: 20000 });
  assert.deepStrictEqual(r.maxTokens, 65536);
  assert.strictEqual(r.source, 'local-window');
  let calls = 0;
  const r2 = effectiveOutputTokens({ model: 'omlx/test-model', maxTokens: 65536, explicit: 65536, window: 262144, promptTokens: () => { calls++; return 20000; } });
  assert.strictEqual(r2.maxTokens, 65536);
  assert.strictEqual(r2.source, 'local-window');
  assert.strictEqual(calls, 1);
});

test('the prompt function is not called for hosted models or when explicit is within the cap', () => {
  const boom = () => { throw new Error('must not be called'); };
  assert.strictEqual(effectiveOutputTokens({ model: 'openai/gpt-x', maxTokens: 300000, explicit: 300000, window: 400000, promptTokens: boom }).maxTokens, 100000);
  assert.strictEqual(effectiveOutputTokens({ model: 'omlx/test-model', maxTokens: 20000, explicit: 20000, window: 262144, promptTokens: boom }).maxTokens, 20000);
  assert.strictEqual(effectiveOutputTokens({ model: 'omlx/test-model', maxTokens: 32000, explicit: 32000, window: 262144, promptTokens: boom }).maxTokens, 32000);
  assert.strictEqual(effectiveOutputTokens({ model: 'omlx/test-model', maxTokens: 32000, window: 262144, promptTokens: boom }).source, 'model');
});

test('the result is limited by the window room', () => {
  const r = effectiveOutputTokens({ model: 'omlx/test-model', maxTokens: 200000, explicit: 200000, window: 131072, promptTokens: 30000 });
  assert.strictEqual(r.maxTokens, 131072 - 30000 - 1024);
  assert.strictEqual(r.source, 'local-window');
});

test('no explicit setting keeps the old cap', () => {
  const r = effectiveOutputTokens({ model: 'omlx/test-model', maxTokens: 32000, window: 262144, promptTokens: 1000 });
  assert.strictEqual(r.maxTokens, 32000);
  assert.strictEqual(r.source, 'model');
});

test('never above the old cap when the window has no room, never below it', () => {
  const r = effectiveOutputTokens({ model: 'omlx/test-model', maxTokens: 65536, explicit: 65536, window: 32768, promptTokens: 1000 });
  assert.strictEqual(r.maxTokens, 32000);
  assert.strictEqual(r.source, 'model');
  const big = effectiveOutputTokens({ model: 'omlx/test-model', maxTokens: 65536, explicit: 65536, window: 32768, promptTokens: 900000 });
  assert.strictEqual(big.maxTokens, 32000);
  const neg = effectiveOutputTokens({ model: 'omlx/test-model', maxTokens: 65536, explicit: 65536, window: 262144, promptTokens: () => -5 });
  assert.strictEqual(neg.maxTokens, 65536);
  const nan = effectiveOutputTokens({ model: 'omlx/test-model', maxTokens: 65536, explicit: 65536, window: 262144, promptTokens: () => NaN });
  assert.strictEqual(nan.maxTokens, 65536);
});

test('hosted models keep their table', () => {
  assert.strictEqual(effectiveOutputTokens({ model: 'openai/gpt-x', maxTokens: 300000, explicit: 300000, window: 1000000, promptTokens: 0 }).maxTokens, 100000);
  assert.strictEqual(effectiveOutputTokens({ model: 'acme/cloud-model', maxTokens: 65536, explicit: 65536, window: 1000000, promptTokens: 0 }).maxTokens, 32000);
});

test('every local prefix is honoured', () => {
  for (const p of ['local', 'lmstudio', 'ollama', 'omlx', 'ninfer']) {
    const r = effectiveOutputTokens({ model: `${p}/test-model`, maxTokens: 65536, explicit: 65536, window: 262144, promptTokens: 0 });
    assert.strictEqual(r.maxTokens, 65536, p);
    assert.strictEqual(r.source, 'local-window', p);
  }
});

test('a missing or invalid window gives the old behaviour', () => {
  for (const window of [undefined, null, NaN, 0, -1, '262144', Infinity]) {
    const r = effectiveOutputTokens({ model: 'omlx/test-model', maxTokens: 65536, explicit: 65536, window, promptTokens: 0 });
    assert.strictEqual(r.maxTokens, 32000, String(window));
    assert.strictEqual(r.source, 'model');
  }
});

test('an invalid explicit value gives the old behaviour', () => {
  for (const explicit of ['', 'lots', 0, -5, 1.5e300, NaN, null, undefined]) {
    const r = effectiveOutputTokens({ model: 'omlx/test-model', maxTokens: 65536, explicit, window: 262144, promptTokens: 0 });
    assert.strictEqual(r.maxTokens, 32000, String(explicit));
  }
});

test('an explicit value saved as text counts like the number', () => {
  const r = effectiveOutputTokens({ model: 'omlx/test-model', maxTokens: '65536', explicit: '65536', window: 262144, promptTokens: 0 });
  assert.strictEqual(r.maxTokens, 65536);
  assert.strictEqual(r.source, 'local-window');
});

test('sdk-chat uses effectiveOutputTokens and logs max_tokens', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.ok(!src.includes('const MODEL_OUT_CAP'));
  assert.ok(/effectiveOutputTokens\(\{/.test(src));
  assert.ok(/calling gateway \(turn=\$\{turns\}, model=\$\{model\}, max_tokens=\$\{maxTokens\}/.test(src));
  assert.ok(src.includes("omlxUrl: (() => { try { return require('./settings').getProviderUrl('omlx')"));
});
