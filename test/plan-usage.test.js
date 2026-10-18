'use strict';
// Plan usage: warnings (levels, once per level and window, persisted, the chat line, pushes), the defaults (warn,
// never switch by itself), and the optional automatic fallback: the family map, the threshold, per-agent opt-out and
// override, expiry of a window, the one-step cascade, rejected events, polling with a fake client, announce-once.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPlanUsage, familyOf, cleanWarn, cleanPolicy, DEFAULT_POLICY, DEFAULT_WARN } = require('../lib/plan-usage');

const T0 = Date.parse('2026-10-12T12:00:00Z');
const later = '2026-10-14T23:59:59Z';
const AUTO = { planFallback: { enabled: true } };   // the automatic switch is off unless the owner turns it on
const AGENTS = [{ name: 'doc', model: 'claude-sdk/claude-fable-5-1' }, { name: 'writer', model: 'claude-sdk/claude-fable-5-1[1m]' }, { name: 'maestro', model: 'claude-sdk/claude-opus-5-5' }, { name: 'gemini', model: 'google/gemini-4-argon' }];
function rig({ settings = AUTO, usage = null, stateFile = null, agents = AGENTS } = {}) {
  const published = []; const pushed = [];
  const pu = createPlanUsage({ getSetting: (k) => settings[k], now: () => T0, fetchUsage: usage ? async () => usage : null, publish: (t, d) => published.push({ t, d }), log: () => {},
    stateFile, listAgents: () => agents, notify: (p) => pushed.push(p) });
  return { pu, published, pushed };
}

test('familyOf: ids, aliases, provider prefix and the [1m] suffix', () => {
  assert.deepStrictEqual(['claude-sdk/claude-fable-5-1[1m]', 'claude-fable-5', 'fable', 'claude-mythos-5-1', 'default', 'opus', 'claude-opus-5-5', 'claude-sdk/claude-sonnet-5-5', 'sonnet', 'claude-haiku-5-5', 'haiku', 'gpt-5.6', ''].map(familyOf),
    ['fable', 'fable', 'fable', 'fable', 'opus', 'opus', 'opus', 'sonnet', 'sonnet', 'haiku', 'haiku', null, null]);
});

test('fallbackFor: below the threshold nothing happens; at it the family map applies; expired windows are ignored', () => {
  const { pu } = rig();
  pu._setState({ models: { fable: { utilization: 89, resets_at: later } } });
  assert.strictEqual(pu.fallbackFor('claude-sdk/claude-fable-5-1[1m]', {}), null);
  pu._setState({ models: { fable: { utilization: 90, resets_at: later } } });
  const fb = pu.fallbackFor('claude-sdk/claude-fable-5-1[1m]', {});
  assert.deepStrictEqual([fb.model, fb.from, fb.family, fb.utilization, fb.resetsAt], ['claude-sdk/claude-opus-5-5', 'claude-sdk/claude-fable-5-1[1m]', 'fable', 90, later]);
  assert.match(fb.reason, /90% of its weekly window/);
  pu._setState({ models: { fable: { utilization: 100, resets_at: '2026-10-12T11:00:00Z' } } });   // already reset
  assert.strictEqual(pu.fallbackFor('claude-sdk/claude-fable-5-1', {}), null);
  assert.strictEqual(pu.fallbackFor('openai/gpt-5.6', {}), null, 'plan limits are a claude-sdk thing');
});

test('per-agent: "none" opts out, a model id overrides the map; the owner can change threshold and map in settings', () => {
  const { pu } = rig({ settings: { planFallback: { enabled: true, at: 80, map: { fable: 'claude-sdk/claude-sonnet-5-5' } } } });
  pu._setState({ models: { fable: { utilization: 85, resets_at: later } } });
  assert.strictEqual(pu.fallbackFor('claude-sdk/claude-fable-5-1', { fallbackModel: 'none' }), null);
  assert.strictEqual(pu.fallbackFor('claude-sdk/claude-fable-5-1', { fallbackModel: 'claude-sdk/claude-opus-5' }).model, 'claude-sdk/claude-opus-5');
  assert.strictEqual(pu.fallbackFor('claude-sdk/claude-fable-5-1', {}).model, 'claude-sdk/claude-sonnet-5-5', 'owner map');
  assert.deepStrictEqual(pu.policy().map.opus, DEFAULT_POLICY.map.opus, 'unmentioned families keep the defaults');
  const off = rig({ settings: { planFallback: { enabled: false } } });
  off.pu._setState({ models: { fable: { utilization: 100, resets_at: later } } });
  assert.strictEqual(off.pu.fallbackFor('claude-sdk/claude-fable-5-1', {}), null);
});

test('cascade: Fable at the limit and Opus at the limit too -> Sonnet; the classic per-family windows count for opus and sonnet', () => {
  const { pu } = rig();
  pu._setState({ models: { fable: { utilization: 100, resets_at: later } }, windows: { seven_day_opus: { utilization: 95, resets_at: later } } });
  assert.strictEqual(pu.fallbackFor('claude-sdk/claude-fable-5-1', {}).model, 'claude-sdk/claude-sonnet-5-5');
  assert.strictEqual(pu.fallbackFor('claude-sdk/claude-opus-5-5', {}).model, 'claude-sdk/claude-sonnet-5-5');
  assert.strictEqual(pu.fallbackFor('claude-sdk/claude-sonnet-5-5', {}), null, 'sonnet is fine');
});

test('noteEvent: a rejection marks the family at 100% at once and publishes plan_limit; an allowed_warning updates the window', () => {
  const { pu, published } = rig();
  pu.noteEvent({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 88, resetsAt: Math.floor(Date.parse(later) / 1000) }, 'claude-fable-5-1', 'maestro');
  assert.deepStrictEqual(pu.snapshot().windows.seven_day, { utilization: 88, resets_at: later.replace('Z', '.000Z'), rejected: false });
  pu.noteEvent({ status: 'rejected', rateLimitType: 'seven_day_overage_included', resetsAt: Math.floor(Date.parse(later) / 1000) }, 'claude-fable-5-1', 'gp');
  const fb = pu.fallbackFor('claude-sdk/claude-fable-5-1[1m]', {});
  assert.strictEqual(fb.model, 'claude-sdk/claude-opus-5-5'); assert.match(fb.reason, /refused/);
  assert.ok(published.some(p => p.t === 'plan_limit' && p.d.agent === 'gp' && p.d.family === 'fable'));
  assert.strictEqual(pu.snapshot().events.length, 2);
});

test('refresh: reads the client\'s usage answer (per-model "Fable" bucket, classic windows, extra usage); announce broadcasts once per agent and window', async () => {
  const usage = { subscription_type: 'max', rate_limits_available: true, rate_limits: { five_hour: { utilization: 1, resets_at: later }, seven_day: { utilization: 53, resets_at: later }, model_scoped: [{ display_name: 'Fable', utilization: 100, resets_at: later }], extra_usage: { is_enabled: false, monthly_limit: 5000, used_credits: 0, utilization: 0 } } };
  const { pu, published } = rig({ usage });
  const s = await pu.refresh();
  assert.strictEqual(s.subscription, 'max'); assert.strictEqual(s.models.fable.utilization, 100); assert.strictEqual(s.windows.seven_day.utilization, 53); assert.strictEqual(s.extraUsage.enabled, false);
  assert.match(pu.describe(), /seven_day 53%.*fable 100%/);
  const fb = pu.fallbackFor('claude-sdk/claude-fable-5-1[1m]', { name: 'maestro' });
  assert.strictEqual(fb.model, 'claude-sdk/claude-opus-5-5');
  assert.strictEqual(pu.announce('maestro', fb), true); assert.strictEqual(pu.announce('maestro', fb), false, 'second turn: no new broadcast');
  assert.strictEqual(published.filter(p => p.t === 'model_fallback').length, 1);
  assert.strictEqual(pu.snapshot().fallbacks[0].turns, 2);
  const failing = createPlanUsage({ fetchUsage: async () => { throw new Error('endpoint rate limited'); }, now: () => T0, log: () => {} });
  const f = await failing.refresh(); assert.match(f.error, /endpoint rate limited/);
});

test('defaults: a fresh install warns at 75% and 90% and never switches a model by itself', () => {
  const { pu } = rig({ settings: {} });
  assert.strictEqual(DEFAULT_POLICY.enabled, false);
  assert.deepStrictEqual(pu.warnPolicy(), { at: [75, 90] }); assert.deepStrictEqual(DEFAULT_WARN.at, [75, 90]);
  pu._setState({ models: { fable: { utilization: 100, resets_at: later } } });
  assert.strictEqual(pu.fallbackFor('claude-sdk/claude-fable-5-1', {}), null, 'no automatic switch');
  assert.strictEqual(pu.policy().enabled, false);
});

test('warnings: once per level and window, the highest level when several are passed, persisted, again in a new window', () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-warn-')), 'plan-warnings.json');
  const { pu, published, pushed } = rig({ settings: {}, stateFile });
  pu._setState({ models: { fable: { utilization: 70, resets_at: later, display_name: 'Fable' } } });
  assert.deepStrictEqual(pu.checkWarnings(), [], 'below the first level');
  pu._setState({ models: { fable: { utilization: 80, resets_at: later, display_name: 'Fable' } } });
  const [w75] = pu.checkWarnings();
  assert.deepStrictEqual([w75.window, w75.label, w75.family, w75.utilization, w75.level, w75.agents, w75.autoSwitch], ['model:fable', 'Fable', 'fable', 80, 75, ['doc', 'writer'], false]);
  assert.deepStrictEqual(pu.checkWarnings(), [], 'same level, same window: nothing new');
  pu._setState({ models: { fable: { utilization: 92, resets_at: '2026-10-14T23:59:59.692944+00:00', display_name: 'Fable' } } });
  const [w90] = pu.checkWarnings();
  assert.strictEqual(w90.level, 90, 'sub-second noise in the reset time is still the same window');
  assert.strictEqual(published.filter(p => p.t === 'plan_warning').length, 2);
  assert.strictEqual(pushed.length, 2); assert.match(pushed[1].title, /Claude plan: Fable at 92% of this week/); assert.match(pushed[1].body, /2 agents run on Fable\. Choose their models/);
  assert.strictEqual((fs.statSync(stateFile).mode & 0o777).toString(8), '600');
  const again = rig({ settings: {}, stateFile });   // a hub restart: the same window is not announced twice
  again.pu._setState({ models: { fable: { utilization: 92, resets_at: later, display_name: 'Fable' } } });
  assert.deepStrictEqual(again.pu.checkWarnings(), []);
  again.pu._setState({ models: { fable: { utilization: 95, resets_at: '2026-10-21T23:59:59Z', display_name: 'Fable' } } });   // next week
  const next = again.pu.checkWarnings();
  assert.deepStrictEqual(next.map(w => w.level), [90], 'jumping past both levels: one warning, at the highest');
  again.pu._setState({ models: {}, windows: { seven_day: { utilization: 76, resets_at: later } } });
  const [all] = again.pu.checkWarnings();
  assert.deepStrictEqual([all.window, all.label, all.family, all.agents], ['seven_day', 'All models', null, ['doc', 'writer', 'maestro']], 'the all-models window concerns every Claude agent');
  const off = rig({ settings: { planWarn: { at: [] } } });
  off.pu._setState({ models: { fable: { utilization: 99, resets_at: later } } });
  assert.deepStrictEqual(off.pu.checkWarnings(), [], 'levels [] = no warnings');
});

test('warningFor: one chat line per agent and level, for the window that governs its model', () => {
  const { pu } = rig({ settings: {} });
  pu._setState({ models: { fable: { utilization: 91, resets_at: later, display_name: 'Fable' } }, windows: { seven_day: { utilization: 52, resets_at: later } } });
  const w = pu.warningFor('claude-sdk/claude-fable-5-1', 'doc');
  assert.strictEqual(w.level, 90);
  assert.match(w.line, /^_⚠️ Fable has used 91% of this week's allowance \(resets .+\)\. You can pick another model for this agent in the chat header\._\n\n$/);
  assert.strictEqual(pu.warningFor('claude-sdk/claude-fable-5-1', 'doc'), null, 'once per agent');
  assert.ok(pu.warningFor('claude-sdk/claude-fable-5-1[1m]', 'writer'), 'each agent gets its own line');
  assert.strictEqual(pu.warningFor('claude-sdk/claude-opus-5-5', 'maestro'), null, 'Opus is not past a level');
  assert.strictEqual(pu.warningFor('google/gemini-4-argon', 'gemini'), null, 'not a Claude-plan model');
  const auto = rig();
  auto.pu._setState({ models: { fable: { utilization: 80, resets_at: later, display_name: 'Fable' } } });
  assert.doesNotMatch(auto.pu.warningFor('claude-sdk/claude-fable-5-1', 'doc').line, /pick another model/, 'with the automatic switch on the hub handles it');
});

test('a refusal: plan_limit says whether anything switches, and the push goes out once per family and window', () => {
  const { pu, published, pushed } = rig({ settings: {} });
  const ev = { status: 'rejected', rateLimitType: 'seven_day_overage_included', resetsAt: Math.floor(Date.parse(later) / 1000) };
  pu.noteEvent(ev, 'claude-fable-5-1', 'doc'); pu.noteEvent(ev, 'claude-fable-5-1', 'writer');
  assert.deepStrictEqual(published.filter(p => p.t === 'plan_limit').map(p => p.d.autoSwitch), [false, false]);
  assert.strictEqual(pushed.length, 1); assert.match(pushed[0].title, /Claude plan stopped Fable/); assert.match(pushed[0].body, /need another model/);
  assert.strictEqual(pu.fallbackFor('claude-sdk/claude-fable-5-1', {}), null, 'and nothing switches by itself');
});

test('cleanWarn / cleanPolicy: what the Settings box may store', () => {
  assert.deepStrictEqual(cleanWarn('90, 75 75 200 x 0'), { at: [75, 90] });
  assert.deepStrictEqual(cleanWarn({ at: [95.4, 50] }), { at: [50, 95] });
  assert.deepStrictEqual(cleanWarn([]), { at: [] });
  assert.deepStrictEqual(cleanPolicy({ enabled: 1, at: 95, map: { fable: 'claude-sdk/claude-opus-5-5', opus: 'rm -rf /', gpt: 'claude-sdk/x' } }, { at: 90, map: { sonnet: 'claude-sdk/claude-haiku-5-5' } }),
    { at: 95, enabled: true, map: { sonnet: 'claude-sdk/claude-haiku-5-5', fable: 'claude-sdk/claude-opus-5-5' } });
  assert.deepStrictEqual(cleanPolicy({ enabled: false }, { at: 80 }), { at: 80, enabled: false }, 'the stored threshold survives a toggle');
});
