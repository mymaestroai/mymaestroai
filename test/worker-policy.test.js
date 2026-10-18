'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const wp = require('../lib/worker-policy');

const AGENTS = [
  { name: 'maestro', model: 'claude-sdk/claude-fable-5-1', category: 'primary' },
  { name: 'worker', model: 'claude-sdk/claude-sonnet-5', category: 'worker' },
  { name: 'haiku', model: 'claude-sdk/claude-haiku-4-5-20251001', category: 'worker' },
  { name: 'gemini', model: 'google/gemini-pro-latest', category: 'worker' },
  { name: 'open', model: 'codex/gpt-5', category: 'worker' },
  { name: 'qwen36', model: 'lmstudio/qwen/qwen3.6-27b', category: 'worker' },
  { name: 'crazyhugo', model: 'lmstudio/x', category: 'experimental' },
];

describe('worker policy: mode', () => {
  it('defaults to fallback for missing or junk values', () => {
    for (const v of [undefined, null, '', 'nonsense', 42]) assert.strictEqual(wp.normalizeMode(v), 'fallback');
    assert.strictEqual(wp.DEFAULT_MODE, 'fallback');
  });
  it('accepts the three modes case-insensitively', () => {
    assert.strictEqual(wp.normalizeMode('ALLOW'), 'allow');
    assert.strictEqual(wp.normalizeMode(' off '), 'off');
    assert.strictEqual(wp.normalizeMode('fallback'), 'fallback');
  });
});

describe('worker policy: roster', () => {
  it('lists only worker-category agents, never the caller, with busy state', () => {
    const r = wp.buildRoster(AGENTS, { selfName: 'worker', isActive: n => n === 'haiku' });
    assert.deepStrictEqual(r.map(w => w.name), ['haiku', 'gemini', 'open', 'qwen36']);
    assert.strictEqual(r.find(w => w.name === 'haiku').busy, true);
    assert.strictEqual(r.find(w => w.name === 'gemini').busy, false);
  });
  it('gives each model family a distinct, honest capability hint', () => {
    assert.match(wp.strengthsFor('claude-sdk/claude-haiku-4-5-20251001'), /fast and cheap/);
    assert.match(wp.strengthsFor('claude-sdk/claude-sonnet-5'), /general worker/);
    assert.match(wp.strengthsFor('claude-sdk/claude-opus-4-6'), /deepest reasoning/);
    assert.match(wp.strengthsFor('codex/gpt-5'), /no tools/);
    assert.match(wp.strengthsFor('google/gemini-pro-latest'), /Gemini/);
    assert.match(wp.strengthsFor('lmstudio/qwen/qwen3.6-27b'), /local model/);
    assert.match(wp.strengthsFor(''), /not configured/);
  });
  it('tolerates an empty roster', () => {
    assert.match(wp.policyText('fallback', []), /no agents are tagged/);
  });
});

describe('worker policy: effects per mode', () => {
  const roster = wp.buildRoster(AGENTS, { selfName: 'maestro' });

  it('allow = old behaviour: no prompt text, no blocked tools, historical description', () => {
    assert.strictEqual(wp.policyText('allow', roster), '');
    assert.deepStrictEqual(wp.disallowedToolsFor('allow'), []);
    assert.match(wp.consultDescription('allow'), /^Ask another named Hub agent a question/);
  });

  it('fallback = platform first, SDK tool still available but must be justified', () => {
    const t = wp.policyText('fallback', roster);
    assert.match(t, /DELEGATION POLICY/);
    assert.match(t, /`haiku`/); assert.match(t, /`qwen36`/);
    assert.match(t, /FALLBACK, not the default/);
    assert.match(t, /say so in one line and give the reason/);
    assert.doesNotMatch(t, /DISABLED/);
    assert.deepStrictEqual(wp.disallowedToolsFor('fallback'), []);
    assert.match(wp.consultDescription('fallback'), /PRIMARY way to hand off work/);
  });

  it('off = SDK sub-agent tool removed under both of its names', () => {
    assert.deepStrictEqual(wp.disallowedToolsFor('off').sort(), ['Agent', 'Task']);
    const t = wp.policyText('off', roster);
    assert.match(t, /DISABLED on this hub/);
    assert.doesNotMatch(t, /FALLBACK, not the default/);
  });

  it('marks busy workers in the prompt', () => {
    const r = wp.buildRoster(AGENTS, { selfName: 'maestro', isActive: n => n === 'worker' });
    assert.match(wp.policyText('fallback', r), /`worker`.*busy right now/);
  });
});

describe('worker policy: busy consult', () => {
  it('names free workers instead of returning an empty answer', () => {
    const r = wp.buildRoster(AGENTS, { selfName: 'maestro', isActive: n => n === 'worker' });
    const m = wp.busyMessage('worker', r);
    assert.match(m, /^\[AGENT BUSY\] "worker"/);
    assert.match(m, /Nothing was run/);
    assert.match(m, /`haiku`/);
    assert.doesNotMatch(m, /`worker` \(/, 'must not suggest the busy agent itself');
  });
  it('says so plainly when nobody is free', () => {
    const r = wp.buildRoster(AGENTS, { selfName: 'maestro', isActive: () => true });
    assert.match(wp.busyMessage('worker', r), /No other platform worker is free/);
  });
});
