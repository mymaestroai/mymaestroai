'use strict';
// Plan usage: warnings (levels, once per level and window, persisted, the chat line, pushes), the defaults (warn,
// never switch by itself), and the optional automatic fallback: the family map, the threshold, per-agent opt-out and
// override, expiry of a window, the one-step cascade, rejected events, polling with a fake client, announce-once.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
// lib/ comes from a throwaway copy of the install (test/helpers/isolated-install.js), so nothing under the real data/ is touched.
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('plan-usage-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const { createPlanUsage, familyOf, cleanWarn, cleanPolicy, DEFAULT_POLICY, DEFAULT_WARN } = L('plan-usage');

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

test('noteEvent: the client\'s utilization is a fraction (0.76 = 76%); it is stored as a percentage, never as "1%"', () => {
  const { pu } = rig({ settings: {} });
  // The shape the Claude client streams (2026-10-21): fractions, with surpassedThreshold and unifiedWindows alongside.
  pu.noteEvent({ status: 'allowed_warning', resetsAt: Math.floor(Date.parse(later) / 1000), rateLimitType: 'seven_day', utilization: 0.76, isUsingOverage: false, surpassedThreshold: 0.75,
    unifiedWindows: { five_hour: { utilization: 0.02 }, seven_day: { utilization: 0.76 } } }, 'claude-opus-5-5', 'maestro');
  assert.strictEqual(pu.snapshot().windows.seven_day.utilization, 76);
  assert.strictEqual(pu.snapshot().events[0].utilization, 76, 'the event log shows percentages too');
  pu.noteEvent({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.023 }, 'claude-opus-5-5', 'maestro');
  assert.strictEqual(pu.snapshot().windows.five_hour.utilization, 2.3, 'one decimal kept');
  pu.noteEvent({ status: 'allowed', rateLimitType: 'seven_day', utilization: 1 }, 'claude-opus-5-5', 'maestro');
  assert.strictEqual(pu.snapshot().windows.seven_day.utilization, 100, '1.0 is a full window');
  for (const bad of ['n/a', '', ' ', true, false, -0.2, NaN, Infinity, '0.5'])
    pu.noteEvent({ status: 'allowed', rateLimitType: 'seven_day', utilization: bad }, 'claude-opus-5-5', 'maestro');
  assert.strictEqual(pu.snapshot().windows.seven_day.utilization, 100, 'booleans, strings, negatives and non-finite values change nothing');
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

// ---- extra usage (pay-as-you-go) after the weekly allowance is used up ----
const { classifyEvent, refusalReason, dateText, whenText } = L('plan-usage');
const CAPTURED = { status: 'rejected', resetsAt: 1794441600, rateLimitType: 'seven_day', overageStatus: 'allowed', overageResetsAt: 1796083200, isUsingOverage: true, overageInUse: true, unifiedWindows: { seven_day: { utilization: 1, resetsAt: 1794441600 } } };
const CAPTURED_RESET = new Date(1794441600 * 1000).toISOString();
const CAPTURED_OVERAGE_RESET = new Date(1796083200 * 1000).toISOString();
const OPUS = 'claude-sdk/claude-opus-5-5';

test('classifyEvent: extra usage paying, refused, and normal events', () => {
  assert.strictEqual(classifyEvent(CAPTURED), 'extra');
  assert.strictEqual(classifyEvent({ status: 'rejected', overageStatus: 'rejected', overageDisabledReason: 'out_of_credits', rateLimitType: 'seven_day' }), 'refused');
  assert.strictEqual(classifyEvent({ status: 'allowed', overageStatus: 'allowed_warning', isUsingOverage: true }), 'extra');
  assert.strictEqual(classifyEvent({ status: 'allowed', isUsingOverage: true }), 'extra');
  assert.strictEqual(classifyEvent({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1794441600 }), 'refused');
  assert.strictEqual(classifyEvent({ status: 'allowed_warning', utilization: 0.8 }), 'normal');
  assert.strictEqual(classifyEvent({ status: 'rejected', rateLimitType: 'overage' }), 'refused');
  assert.strictEqual(classifyEvent({ status: 'rejected', overageStatus: 'allowed', overageDisabledReason: 'org_level_disabled' }), 'refused');
  assert.strictEqual(classifyEvent(null), 'normal'); assert.strictEqual(classifyEvent('x'), 'normal');
});

test('refusalReason: plain words for why extra usage did not take over', () => {
  for (const d of ['overage_not_provisioned', 'no_limits_configured']) assert.strictEqual(refusalReason({ overageDisabledReason: d }), 'extra usage is not turned on');
  for (const d of ['out_of_credits', 'seat_tier_zero_credit_limit', 'group_zero_credit_limit', 'member_zero_credit_limit']) assert.strictEqual(refusalReason({ overageDisabledReason: d }), 'the extra-usage credit is used up');
  assert.strictEqual(refusalReason({ errorCode: 'credits_required' }), 'the extra-usage credit is used up');
  for (const d of ['org_level_disabled', 'org_level_disabled_until', 'seat_tier_level_disabled', 'member_level_disabled', 'org_service_level_disabled']) assert.strictEqual(refusalReason({ overageDisabledReason: d }), 'extra usage is turned off for this account');
  assert.strictEqual(refusalReason({ limitScope: 'group_pool' }), "the team's shared extra-usage budget is used up");
  assert.strictEqual(refusalReason({ overageStatus: 'rejected' }), 'extra usage reached its monthly limit');
  assert.strictEqual(refusalReason({ rateLimitType: 'overage' }), 'extra usage reached its monthly limit');
  assert.strictEqual(refusalReason({ status: 'rejected', rateLimitType: 'seven_day' }), '');
  assert.strictEqual(dateText(CAPTURED_OVERAGE_RESET, 'UTC'), 'Tue, Dec 1');
  assert.strictEqual(dateText('nope'), 'its reset date');
});

test('noteEvent: a "rejected" event while extra usage pays is not a refusal', () => {
  const { pu, published, pushed } = rig();
  pu.noteEvent(CAPTURED, OPUS, 'lead'); pu.noteEvent(CAPTURED, OPUS, 'lead');
  assert.strictEqual(published.filter(p => p.t === 'plan_limit').length, 0);
  assert.strictEqual(pushed.length, 0);
  const s = pu.snapshot();
  assert.strictEqual(s.windows.seven_day.utilization, 100); assert.strictEqual(s.windows.seven_day.rejected, false); assert.strictEqual(s.windows.seven_day.extraUsage, true);
  assert.strictEqual(s.models.opus.extraUsage, true); assert.strictEqual(s.models.opus.rejected, false);
  assert.ok(s.weekly.length > 0 && s.weekly.every(w => w.extraUsage === true && w.rejected === false));
  assert.strictEqual(s.weekly.find(w => w.family === 'opus').label, 'Opus', 'before any usage poll the family reads as "Opus", not its key');
  assert.strictEqual(s.overage.inUse, true);
  assert.match(pu.describe(), /extra usage/); assert.doesNotMatch(pu.describe(), /refused/);
  assert.strictEqual(published.filter(p => p.t === 'plan_extra_usage').length, 1, 'once per plan window');
  const ev = s.events[s.events.length - 1];
  assert.deepStrictEqual([ev.overageStatus, ev.overageInUse, ev.overageResetsAt], ['allowed', true, CAPTURED_OVERAGE_RESET]);
});

test('extraUsageLineFor: once per agent and plan window, and it survives a restart', () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-extra-')), 'warned.json');
  const { pu } = rig({ stateFile });
  assert.strictEqual(pu.extraUsageLineFor(OPUS, 'lead'), null, 'nothing before extra usage is seen');
  pu.noteEvent(CAPTURED, OPUS, 'lead');
  const line = pu.extraUsageLineFor(OPUS, 'lead');
  assert.strictEqual(line, `_The weekly Claude plan is used up until ${whenText(CAPTURED_RESET)}; extra usage is paying for Claude replies until then._\n\n`);
  assert.strictEqual(pu.extraUsageLineFor(OPUS, 'lead'), null);
  assert.ok(pu.extraUsageLineFor(OPUS, 'helper'));
  assert.strictEqual(pu.extraUsageLineFor('google/gemini-4-argon', 'x'), null);
  const again = rig({ stateFile });
  again.pu.noteEvent(CAPTURED, OPUS, 'lead');
  assert.strictEqual(again.pu.extraUsageLineFor(OPUS, 'lead'), null, 'persisted');
  assert.ok(again.pu.extraUsageLineFor(OPUS, 'third'));
});

test('extra usage close to its monthly limit: one push per period', () => {
  const { pu, pushed } = rig();
  const ev = { ...CAPTURED, overageStatus: 'allowed_warning' };
  pu.noteEvent(ev, OPUS, 'lead'); pu.noteEvent(ev, OPUS, 'helper');
  const warns = pushed.filter(p => p.title === 'Claude extra usage is close to its monthly limit');
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0].body, new RegExp(`It resets ${dateText(CAPTURED_OVERAGE_RESET)}\\. Raise the limit at claude\\.ai`));
  assert.strictEqual(warns[0].tag, 'plan-extra-warning');
  assert.strictEqual(pushed.filter(p => /stopped/.test(p.title)).length, 0);
});

test('a refusal with extra usage out of credit says why', () => {
  const { pu, published, pushed } = rig({ settings: {} });
  pu.noteEvent({ ...CAPTURED, overageStatus: 'rejected', isUsingOverage: false, overageInUse: false, overageDisabledReason: 'out_of_credits' }, OPUS, 'lead');
  assert.strictEqual(pu.snapshot().windows.seven_day.rejected, true);
  assert.ok(published.some(p => p.t === 'plan_limit'));
  assert.strictEqual(pushed.length, 1);
  assert.strictEqual(pushed[0].body, `Until ${whenText(CAPTURED_RESET)}. The extra-usage credit is used up; the extra-usage period resets ${dateText(CAPTURED_OVERAGE_RESET)}. Agents on Opus need another model: choose them in Settings → Claude plan, or in each chat header.`);
  assert.strictEqual(pu.snapshot().overage.inUse, false);
  assert.strictEqual(pu.snapshot().overage.disabledReason, 'out_of_credits');
});

test('an old refusal without overage fields reads exactly as before', () => {
  const { pu, published, pushed } = rig({ settings: {} });
  pu.noteEvent({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1794441600 }, OPUS, 'lead');
  assert.strictEqual(pu.snapshot().windows.seven_day.rejected, true); assert.strictEqual(pu.snapshot().models.opus.rejected, true);
  assert.ok(published.some(p => p.t === 'plan_limit'));
  assert.strictEqual(pushed[0].title, 'Claude plan stopped Opus');
  assert.strictEqual(pushed[0].body, `Until ${whenText(CAPTURED_RESET)}. Agents on Opus need another model: choose them in Settings → Claude plan, or in each chat header.`);
  assert.strictEqual(pu.snapshot().overage, null);
});

test('refresh: extra-usage flag kept for a window at 100% in the same plan window, set when extra usage has room, dropped below 100', async () => {
  const win = (u) => ({ seven_day: { utilization: u, resets_at: later } });
  const a = rig({ usage: { rate_limits_available: true, rate_limits: { seven_day: { utilization: 100, resets_at: CAPTURED_RESET } } } });
  a.pu.noteEvent(CAPTURED, OPUS, 'lead');
  await a.pu.refresh();
  assert.strictEqual(a.pu.snapshot().windows.seven_day.extraUsage, true, 'the prior event flagged the same plan window');
  const b = rig({ usage: { rate_limits_available: true, rate_limits: { ...win(100), extra_usage: { is_enabled: true, utilization: null } } } });
  await b.pu.refresh();
  assert.strictEqual(b.pu.snapshot().windows.seven_day.extraUsage, true);
  assert.match(b.pu.describe(), /seven_day 100% \(extra usage\)/);
  const c = rig({ usage: { rate_limits_available: true, rate_limits: { ...win(100), extra_usage: { is_enabled: false } } } });
  await c.pu.refresh(); assert.strictEqual(c.pu.snapshot().windows.seven_day.extraUsage, undefined);
  const d = rig({ usage: { rate_limits_available: true, rate_limits: { ...win(100), extra_usage: { is_enabled: true, utilization: 100 } } } });
  await d.pu.refresh(); assert.strictEqual(d.pu.snapshot().windows.seven_day.extraUsage, undefined);
  const e = rig({ usage: { rate_limits_available: true, rate_limits: { ...win(60), extra_usage: { is_enabled: true, utilization: 0 } } } });
  e.pu.noteEvent(CAPTURED, OPUS, 'lead'); await e.pu.refresh();
  assert.strictEqual(e.pu.snapshot().windows.seven_day.extraUsage, undefined, 'below 100 the flag goes');
});

test('sdk-chat: the rate_limit_event handler uses classifyEvent and extraUsageLineFor', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  const at = src.indexOf("msg.type === 'rate_limit_event'");
  assert.ok(at > 0);
  const block = src.slice(at, at + 3500);
  assert.match(block, /planUsage\.classifyEvent\(/); assert.match(block, /extraUsageLineFor\(/); assert.match(block, /refusalText\(/);
  assert.doesNotMatch(block, /extra usage comes back/);
});

// ---- review round 1: a fresh reading wins, a refusal stays, the family bucket is only touched by a covering window ----
const { refusalText } = L('plan-usage');
const REFUSED_OOC = { ...CAPTURED, overageStatus: 'rejected', isUsingOverage: false, overageInUse: false, overageDisabledReason: 'out_of_credits' };
const usageWith = (extra, seven = { utilization: 100, resets_at: CAPTURED_RESET }) => ({ rate_limits_available: true, rate_limits: { seven_day: seven, ...(extra === undefined ? {} : { extra_usage: extra }) } });

test('refresh: a refusal the client reported for this plan window is not turned into extra usage by a poll', async () => {
  const { pu } = rig({ usage: usageWith({ is_enabled: true, utilization: 0 }) });
  pu.noteEvent(REFUSED_OOC, OPUS, 'lead');
  await pu.refresh();
  const w = pu.snapshot().windows.seven_day;
  assert.strictEqual(w.rejected, true); assert.strictEqual(w.extraUsage, undefined);
});

test('refresh: extra usage reported unavailable drops the flag (switched off, or at its limit)', async () => {
  for (const extra of [{ is_enabled: false }, { is_enabled: true, utilization: 100 }]) {
    const { pu } = rig({ usage: usageWith(extra) });
    pu.noteEvent(CAPTURED, OPUS, 'lead');
    assert.strictEqual(pu.snapshot().models.opus.extraUsage, true);
    await pu.refresh();
    const s = pu.snapshot();
    assert.strictEqual(s.windows.seven_day.extraUsage, undefined, JSON.stringify(extra));
    assert.strictEqual(s.models.opus.extraUsage, undefined, 'the family bucket loses it too');
  }
});

test('refresh: an answer without extra_usage forgets the old reading and sets no flag from it', async () => {
  let answer = usageWith({ is_enabled: true, utilization: 10 }, { utilization: 100, resets_at: CAPTURED_RESET });
  const pu = createPlanUsage({ getSetting: () => ({}), now: () => T0, fetchUsage: async () => answer, log: () => {} });
  await pu.refresh();
  assert.strictEqual(pu.snapshot().extraUsage.enabled, true); assert.strictEqual(pu.snapshot().windows.seven_day.extraUsage, true);
  answer = usageWith(undefined, { utilization: 100, resets_at: new Date(Date.parse(CAPTURED_RESET) + 7 * 86400000).toISOString() });   // a new window
  await pu.refresh();
  assert.strictEqual(pu.snapshot().extraUsage, null);
  assert.strictEqual(pu.snapshot().windows.seven_day.extraUsage, undefined, 'no extra room is known, so no flag');
});

test('noteEvent: a five-hour extra-usage event flags the five-hour window and leaves the weekly family bucket alone', () => {
  const { pu } = rig();
  pu._setState({ models: { opus: { utilization: 30, resets_at: CAPTURED_RESET, rejected: false, display_name: 'Opus' } } });
  pu.noteEvent({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1794441600, overageStatus: 'allowed', isUsingOverage: true }, OPUS, 'lead');
  const s = pu.snapshot();
  assert.strictEqual(s.models.opus.utilization, 30); assert.strictEqual(s.models.opus.extraUsage, undefined);
  assert.deepStrictEqual([s.windows.five_hour.utilization, s.windows.five_hour.extraUsage, s.windows.five_hour.rejected], [100, true, false]);
  assert.strictEqual(pu.extraUsageLineFor(OPUS, 'lead'), null);
  // an overage-type event never writes a window or a bucket either
  pu.noteEvent({ status: 'allowed', rateLimitType: 'overage', overageStatus: 'allowed', isUsingOverage: true }, OPUS, 'lead');
  assert.strictEqual(pu.snapshot().models.opus.utilization, 30); assert.strictEqual(pu.snapshot().windows.overage, undefined);
});

test('noteEvent: a Sonnet weekly event does not touch the Opus bucket', () => {
  const { pu } = rig();
  pu.noteEvent({ ...CAPTURED, rateLimitType: 'seven_day_sonnet' }, OPUS, 'lead');
  const s = pu.snapshot();
  assert.strictEqual(s.models.opus, undefined);
  assert.strictEqual(s.windows.seven_day_sonnet.extraUsage, true);
  pu.noteEvent({ ...CAPTURED, rateLimitType: 'seven_day_opus' }, OPUS, 'lead');
  assert.strictEqual(pu.snapshot().models.opus.extraUsage, true, 'the opus window covers the opus family');
});

test('once-markers without a date: one push, a real date in the key', () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-extra-')), 'warned.json');
  const { pu, pushed, published } = rig({ stateFile });
  const ev = { status: 'allowed_warning', rateLimitType: 'seven_day', overageStatus: 'allowed_warning', isUsingOverage: true };
  pu.noteEvent(ev, OPUS, 'lead'); pu.noteEvent(ev, OPUS, 'helper');
  assert.strictEqual(pushed.filter(p => p.tag === 'plan-extra-warning').length, 1);
  assert.strictEqual(published.filter(p => p.t === 'plan_extra_usage').length, 1);
  const keys = Object.keys(JSON.parse(fs.readFileSync(stateFile, 'utf8')).warned).filter(k => /^extra-(event|warning)\|/.test(k));
  assert.strictEqual(keys.length, 2);
  for (const k of keys) assert.ok(Date.parse(k.split('|')[1]) > T0, `${k} has a real date`);
});

test('extraUsageLineFor: an agent name with a pipe gets one line and its key prunes by date', () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-extra-')), 'warned.json');
  const { pu } = rig({ stateFile });
  pu.noteEvent(CAPTURED, OPUS, 'a|b');
  assert.ok(pu.extraUsageLineFor(OPUS, 'a|b')); assert.strictEqual(pu.extraUsageLineFor(OPUS, 'a|b'), null);
  const key = Object.keys(JSON.parse(fs.readFileSync(stateFile, 'utf8')).warned).find(k => k.startsWith('extra:'));
  assert.strictEqual(key.split('|').length, 2); assert.strictEqual(key.split('|')[1], new Date(Math.round(Date.parse(CAPTURED_RESET) / 3600000) * 3600000).toISOString());
  assert.strictEqual(decodeURIComponent(key.split('|')[0].slice('extra:'.length)), 'a|b');
});

test('while extra usage pays, the "100% ... pick another model" warning stays quiet', () => {
  const { pu, pushed } = rig();
  pu.noteEvent(CAPTURED, OPUS, 'lead');
  assert.strictEqual(pu.warningFor(OPUS, 'lead'), null);
  assert.deepStrictEqual(pu.checkWarnings(), []);
  assert.strictEqual(pushed.length, 0);
});

test('refusal text: a date only for a limit that resets', () => {
  const off = refusalText({ ...REFUSED_OOC, overageDisabledReason: 'org_level_disabled', overageResetsAt: 1796083200 });
  assert.strictEqual(off, ' Extra usage is turned off for this account.');
  assert.strictEqual(refusalText({ overageDisabledReason: 'overage_not_provisioned', overageResetsAt: 1796083200 }), ' Extra usage is not turned on.');
  assert.strictEqual(refusalText(REFUSED_OOC), ` The extra-usage credit is used up; the extra-usage period resets ${dateText(CAPTURED_OVERAGE_RESET)}.`);
  assert.match(refusalText({ overageStatus: 'rejected', overageResetsAt: 1796083200 }), /monthly limit; the extra-usage period resets /);
  assert.match(refusalText({ limitScope: 'group_pool', overageResetsAt: 1796083200 }), /budget is used up; the extra-usage period resets /);
  assert.strictEqual(refusalText({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1794441600 }), '');
  assert.strictEqual(refusalText(null), '');
  const { pu, pushed } = rig({ settings: {} });
  pu.noteEvent({ ...REFUSED_OOC, overageDisabledReason: 'org_level_disabled' }, OPUS, 'lead');
  assert.doesNotMatch(pushed[0].body, /extra-usage period|comes back/);
  assert.ok(pushed[0].body.includes('Extra usage is turned off for this account. Agents on Opus'));
});

test('a refusal is lifted when extra usage is carrying requests again, and a later poll keeps it lifted', async () => {
  const usage = { subscription_type: 'max', rate_limits_available: true, rate_limits: { seven_day: { utilization: 100, resets_at: later }, extra_usage: { is_enabled: true, utilization: 10 } } };
  const { pu } = rig({ usage });
  pu.noteEvent({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: Date.parse(later) / 1000, overageStatus: 'rejected', overageDisabledReason: 'out_of_credits' }, 'claude-sdk/claude-opus-5-5', 'lead');
  assert.strictEqual(pu.snapshot().windows.seven_day.rejected, true);
  assert.strictEqual(pu.snapshot().models.opus.rejected, true);
  // credit added: a request succeeds on extra usage (an overage-type event, not the weekly window's own type)
  pu.noteEvent({ status: 'allowed', rateLimitType: 'overage', overageStatus: 'allowed', isUsingOverage: true }, 'claude-sdk/claude-opus-5-5', 'lead');
  let s = pu.snapshot();
  assert.strictEqual(s.windows.seven_day.rejected, false); assert.strictEqual(s.windows.seven_day.extraUsage, true);
  assert.strictEqual(s.models.opus.rejected, false); assert.strictEqual(s.models.opus.extraUsage, true);
  await pu.refresh();
  s = pu.snapshot();
  assert.strictEqual(s.windows.seven_day.rejected, false, 'the poll does not bring the old refusal back');
  assert.strictEqual(s.windows.seven_day.extraUsage, true);
});

test('a dateless once-marker keeps one key all week: no repeat an hour later, nor after a restart', () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-extra-')), 'warned.json');
  let t = T0 + 29 * 60000;   // xx:29
  const mk = () => { const pushed = []; const pu = createPlanUsage({ getSetting: () => undefined, now: () => t, publish: () => {}, log: () => {}, stateFile, listAgents: () => [], notify: (p) => pushed.push(p) }); return { pu, pushed }; };
  const a = mk();
  const ev = { status: 'allowed_warning', rateLimitType: 'seven_day', overageStatus: 'allowed_warning', isUsingOverage: true };
  a.pu.noteEvent(ev, OPUS, 'lead');
  t += 2 * 60000;            // xx:31, across the hour rounding
  a.pu.noteEvent(ev, OPUS, 'lead');
  t += 3 * 3600000;
  const b = mk();
  b.pu.noteEvent(ev, OPUS, 'lead');
  assert.strictEqual(a.pushed.length + b.pushed.length, 1);
});

test('a refusal with no known reset time is not kept by a poll that has none either', async () => {
  const usage = { subscription_type: 'max', rate_limits_available: true, rate_limits: { seven_day: { utilization: 100 }, extra_usage: { is_enabled: false } } };
  const { pu } = rig({ usage });
  pu.noteEvent({ status: 'rejected', rateLimitType: 'seven_day' }, 'claude-sdk/claude-opus-5-5', 'lead');
  assert.strictEqual(pu.snapshot().windows.seven_day.rejected, true);
  await pu.refresh();
  assert.strictEqual(pu.snapshot().windows.seven_day.rejected, false);
});

test('a refused 5-hour window lifts too when extra usage carries requests again, and a poll keeps it lifted', async () => {
  const reset5 = '2026-10-12T15:00:00Z';
  const usage = { subscription_type: 'max', rate_limits_available: true, rate_limits: { five_hour: { utilization: 100, resets_at: reset5 }, extra_usage: { is_enabled: true, utilization: 10 } } };
  const { pu } = rig({ usage });
  pu.noteEvent({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: Date.parse(reset5) / 1000, overageStatus: 'rejected', overageDisabledReason: 'out_of_credits' }, 'claude-sdk/claude-opus-5-5', 'lead');
  assert.strictEqual(pu.snapshot().windows.five_hour.rejected, true);
  pu.noteEvent({ status: 'allowed', rateLimitType: 'overage', overageStatus: 'allowed', isUsingOverage: true }, 'claude-sdk/claude-opus-5-5', 'lead');
  assert.strictEqual(pu.snapshot().windows.five_hour.rejected, false); assert.strictEqual(pu.snapshot().windows.five_hour.extraUsage, true);
  await pu.refresh();
  assert.strictEqual(pu.snapshot().windows.five_hour.rejected, false); assert.strictEqual(pu.snapshot().windows.five_hour.extraUsage, true);
});
