'use strict';
// Real spend: the money the app shows counts every turn a plan does not pay for and that did not run locally (API keys,
// cloud voice, codex/ on the OpenAI key, unknown routes). Plan turns (claude-sdk, codex-cli) keep their API-equivalent
// value as planValue; local turns count in turns only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLedger } = require('../lib/ledger');
const billing = require('../lib/billing');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function mk(caps = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-real-')); dirs.push(dir);
  const clock = { t: new Date(2026, 10, 20, 12, 0).getTime() };
  const c = { v: caps };
  const l = createLedger({ file: path.join(dir, 'ledger.db'), now: () => clock.t, getCaps: () => c.v });
  return { l, clock, c };
}
const CODEX = 1.5;   // codex-cli/gpt-6: 100k in at $5 + 50k out at $20 per million
function mix(l) {
  l.record({ agent: 'maestro', model: 'claude-sdk/claude-opus-5-5', costUsd: 400 });
  l.record({ agent: 'coder', model: 'codex-cli/gpt-6', inputTokens: 100000, outputTokens: 50000 });
  l.record({ agent: 'maestro', model: 'anthropic/claude-sonnet-5-5', costUsd: 1.2 });
  l.record({ agent: 'scout', model: 'openrouter/x/y', costUsd: 0.04 });
  l.record({ agent: 'scout', model: 'lmstudio/q', inputTokens: 10, outputTokens: 10 });
}

test('billing: one list of pay-per-use and subscription prefixes, and billingOf agrees with it', () => {
  assert.deepStrictEqual(billing.API_PREFIXES, ['anthropic', 'openai', 'google', 'perplexity', 'openrouter']);
  assert.deepStrictEqual(billing.SUBSCRIPTION_PREFIXES, ['claude-sdk', 'codex-cli', 'codex']);
  for (const p of billing.API_PREFIXES) assert.strictEqual(billing.billingOf(`${p}/m`).kind, 'api', p);
  for (const p of billing.SUBSCRIPTION_PREFIXES) assert.strictEqual(billing.billingOf(`${p}/m`).kind, 'subscription', p);
  assert.strictEqual(billing.billingOf('lmstudio/q').kind, 'local');
  assert.strictEqual(billing.billingOf('mystery').kind, 'unknown');
  assert.deepStrictEqual(billing.PLAN_PREFIXES, ['claude-sdk', 'codex-cli'], 'codex/ runs on the OpenAI key: not a plan turn');
  for (const p of billing.LOCAL_PREFIXES) assert.strictEqual(billing.billingOf(`${p}/m`).kind, 'local', p);
});

test('today(): total is pay-per-use only; plan turns carry planValue; local counts in turns only', () => {
  const { l } = mk();
  mix(l);
  const t = l.today();
  near(t.total, 1.24);
  assert.deepStrictEqual([t.turns, t.paidTurns, t.planTurns], [5, 2, 2]);
  near(t.planValue, 400 + CODEX);
  assert.deepStrictEqual(t.agents.map(a => a.agent), ['maestro', 'scout', 'coder'], 'ordered by paid cost, then turns');
  const [m, s, c] = t.agents;
  assert.deepStrictEqual([m.turns, m.paidTurns, m.planTurns], [2, 1, 1]);
  near(m.cost, 1.2); near(m.planValue, 400);
  assert.deepStrictEqual([s.turns, s.paidTurns, s.planTurns], [2, 1, 0]);
  near(s.cost, 0.04); assert.strictEqual(s.planValue, 0);
  assert.deepStrictEqual([c.turns, c.paidTurns, c.planTurns, c.cost], [1, 0, 1, 0]);
  near(c.planValue, CODEX);
  assert.deepStrictEqual([c.inputTokens, c.outputTokens], [100000, 50000]);
});

test('today(): only subscription turns means no spend at all; empty day has the full shape', () => {
  const { l } = mk();
  l.record({ agent: 'maestro', model: 'claude-sdk/claude-opus-5-5', costUsd: 50 });
  l.record({ agent: 'maestro', model: 'lmstudio/q', costUsd: 0 });
  const t = l.today();
  assert.deepStrictEqual([t.total, t.paidTurns, t.planTurns, t.turns, t.planValue, t.unpriced], [0, 0, 1, 2, 50, 0]);
  assert.deepStrictEqual(l.today('2020-01-01'), { day: '2020-01-01', total: 0, turns: 0, paidTurns: 0, unpriced: 0, planTurns: 0, planValue: 0, agents: [] });
});

test('days(): the same split per day, newest first', () => {
  const { l, clock } = mk();
  mix(l);
  clock.t += 86400000;
  l.record({ agent: 'maestro', model: 'claude-sdk/claude-opus-5-5', costUsd: 7 });
  const d = l.days();
  assert.deepStrictEqual(d.map(x => x.day), ['2026-11-21', '2026-11-20']);
  assert.deepStrictEqual([d[0].turns, d[0].cost, d[0].planValue], [1, 0, 7]);
  assert.strictEqual(d[1].turns, 5);
  near(d[1].cost, 1.24); near(d[1].planValue, 400 + CODEX);
});

test('caps: hub cap counts pay-per-use only; the reason says so', () => {
  const { l } = mk({ hubDailyUsd: 5 });
  mix(l);
  let o = l.overCap('maestro');
  assert.strictEqual(o.capped, false, '400 of plan value never trips a $5 cap');
  near(o.hubSpend, 1.24);
  l.record({ agent: 'scout', model: 'openai/gpt-5', costUsd: 6 });
  o = l.overCap('maestro');
  assert.strictEqual(o.capped, true);
  assert.match(o.reason, /^the hub is over its daily pay-per-use cap \(\$7\.24 of \$5\)$/);
});

test('caps: per-agent cap counts that agent\'s pay-per-use only', () => {
  const { l } = mk({ perAgentDailyUsd: 5 });
  mix(l);
  let o = l.overCap('maestro');
  assert.strictEqual(o.capped, false, 'maestro has 400 of plan value but $1.20 paid');
  near(o.agentSpend, 1.2);
  assert.strictEqual(l.overCap('coder').capped, false);
  l.record({ agent: 'maestro', model: 'anthropic/claude-sonnet-5-5', costUsd: 5 });
  o = l.overCap('maestro');
  assert.strictEqual(o.capped, true);
  assert.match(o.reason, /^maestro is over its daily pay-per-use cap \(\$6\.20 of \$5\)$/);
});

test('credits() still counts per API provider only', () => {
  const { l } = mk();
  mix(l);
  assert.deepStrictEqual(l.credits(), [], 'no credit configured');
});

test('desktop source: the chip hides below half a cent and never prints planValue; Settings explains plan use is not billed', () => {
  const app = read('app.js'), html = read('index.html');
  const fn = app.slice(app.indexOf('function paintSpendToday()'), app.indexOf('// Monthly API credits'));
  assert.ok(fn.length > 100);
  assert.match(fn, /const show = !!t && typeof t\.paidTurns === 'number' && \(t\.total \|\| 0\) >= 0\.005/, 'an older hub answer (no paidTurns) never shows');
  assert.ok(!/planValue|planTurns/.test(fn), 'plan figures never reach the sidebar chip');
  assert.ok(fn.includes('`spent today ${usd(t.total)}`'));
  assert.ok(fn.includes('Pay-per-use spend today (API keys)') && fn.includes('Use of your Claude and ChatGPT plans is not counted here'));
  const set = app.slice(app.indexOf('async function paintSpendSettings'), app.indexOf('async function paintSpendSettings') + 2500);
  assert.ok(set.includes('No pay-per-use spend today'));
  assert.ok(set.includes('so it is not billed'));
  assert.ok(set.includes('Spent today ${amount}'));
  assert.ok(set.includes("'Restart your Maestro to see pay-per-use spend.'"), 'an older hub answer gets a restart line, not a figure');
  assert.ok(set.includes("'less than $0.01'") && set.includes('with no known price'), 'sub-cent and unpriced calls are said, not hidden');
  assert.ok(set.includes('pay-per-use caps:'));
  assert.ok(app.includes('Daily pay-per-use cap per agent ($)') && app.includes('Daily pay-per-use cap, whole hub ($)'));
  assert.ok(app.includes('Caps count pay-per-use spend only (API keys), never plan use.'));
  const tag = html.match(/<span id="spend-today"[^>]*>/)[0];
  assert.ok(!/API-equivalent/.test(tag));
  assert.ok(tag.includes('title="Pay-per-use spend today (API keys); click for caps"'));
});

test('metered providers outside the API list count as spend and against caps: cloud voice, codex/ on the OpenAI key, unknown routes', () => {
  const { l, c } = mk({ hubDailyUsd: 0.05 });
  l.record({ agent: 'voice', model: 'elevenlabs/eleven_flash_v2_5', costUsd: 0.06 });
  let t = l.today();
  near(t.total, 0.06); assert.strictEqual(t.paidTurns, 1);
  assert.strictEqual(l.overCap('voice').capped, true, 'an ElevenLabs-only day trips the hub cap');
  assert.match(l.overCap('voice').reason, /pay-per-use cap/);
  c.v = { perAgentDailyUsd: 0.25 };
  l.record({ agent: 'worker', model: 'codex/gpt-5.5', costUsd: 0.3 });
  assert.strictEqual(l.overCap('worker').capped, true, 'codex/ goes through the OpenAI API key: real spend');
  l.record({ agent: 'gw', model: 'mystery', costUsd: 0.5 });
  t = l.today();
  near(t.total, 0.86); assert.strictEqual(t.paidTurns, 3, 'an unknown route is shown as money, never hidden');
  near(l.days(1)[0].cost, 0.86);
});

test('unpriced pay-per-use calls are counted apart, so the page can say the total is incomplete', () => {
  const { l } = mk();
  l.record({ agent: 'a', model: 'openai/brand-new-model', inputTokens: 10, outputTokens: 10 });   // no price known
  l.record({ agent: 'a', model: 'anthropic/claude-sonnet-5-5', costUsd: 0.004 });
  l.record({ agent: 'a', model: 'claude-sdk/claude-opus-5-5' });                                  // plan, no cost: not unpriced spend
  const t = l.today();
  assert.deepStrictEqual([t.paidTurns, t.unpriced, t.planTurns], [2, 1, 1]);
  near(t.total, 0.004);
  assert.strictEqual(t.agents[0].unpriced, 1);
});

test('the gateway books a bare model name under the provider it is sent to', () => {
  const src = read('lib/sdk-chat.js');
  assert.match(src, /chatCompletion, supportsImages, resolveProvider \} = require\('\.\/gateway-client'\)/);
  assert.ok(src.includes("!model.includes('/') ? (() => { try { return `${resolveProvider(model).provider}/${model}`; }"));
  // gateway-client reads settings when it loads: load it from a throwaway install (test/helpers/isolated-install.js).
  const ISO = require('./helpers/isolated-install').makeIsolatedInstall('real-spend-gw-');
  dirs.push(ISO.root);
  const { resolveProvider } = require(path.join(ISO.inst, 'lib', 'gateway-client.js'));
  assert.deepStrictEqual(['claude-opus-5-5', 'gpt-6', 'gemini-pro'].map(m => resolveProvider(m).provider), ['anthropic', 'openai', 'google']);
});
