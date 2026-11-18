'use strict';
// Speed and price per agent (lib/tier): the setting, what each route gets, the Standard fallback, the member cap, the longer
// allowance for Economy, Codex Fast, and the ledger. Nothing live: lib/ runs from a throwaway install (test/helpers/isolated-install.js),
// the network is a fake fetch, the agents file is temporary.
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('service-tier-');
const L = (p) => require(path.join(ISO.lib, p));
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// OpenRouter's catalogue says which models take a reasoning level (lib/effort routeOf): a fixed one here.
require.cache[path.join(ISO.lib, 'openrouter.js')] = { id: 'x', filename: 'x', loaded: true, exports: { getOpenRouter: () => ({ info: (n) => ({ reasoning: !/plain/.test(n) }) }) } };
const tier = L('tier');

const OPENAI = 'openai/gpt-5.6', GEMINI = 'google/gemini-2.5-pro', ROUTER = 'openrouter/acme/model-one', CODEX = 'codex-cli/gpt-5.6-codex';
const NONE = ['claude-sdk/claude-opus-5-5', 'anthropic/claude-sonnet-5-5', 'ninfer/qwen3.8-27b', 'lmstudio/some-model', 'local/qwen3.8-27b'];
// The tier goes by provider, not by the reasoning-effort rules: non-reasoning OpenAI and OpenRouter models can ask for it too.
const BY_PROVIDER = ['openai/gpt-4.1', 'openrouter/acme/plain-model', 'google/gemini-flash-latest'];

test('normalize: three tiers, anything else is standard', () => {
  assert.deepStrictEqual(tier.TIERS, ['standard', 'fast', 'economy']);
  assert.strictEqual(tier.normalize('FAST'), 'fast');
  assert.strictEqual(tier.normalize(' economy '), 'economy');
  for (const v of [undefined, null, '', 'turbo', 7, {}, 'priority', 'flex']) assert.strictEqual(tier.normalize(v), 'standard', String(v));
});

test('tiersFor: API routes get all three, Codex fast only, everything else standard only', () => {
  for (const m of [OPENAI, GEMINI, ROUTER]) assert.deepStrictEqual(tier.tiersFor(m), ['standard', 'fast', 'economy'], m);
  assert.deepStrictEqual(tier.tiersFor(CODEX), ['standard', 'fast']);
  for (const m of BY_PROVIDER) assert.deepStrictEqual(tier.tiersFor(m), ['standard', 'fast', 'economy'], m);
  for (const m of NONE.concat([undefined, '', 'unknown'])) assert.deepStrictEqual(tier.tiersFor(m), ['standard'], String(m));
});

test('forModel: priority / flex for the API routes, Codex config for Codex fast, null otherwise', () => {
  for (const m of [OPENAI, GEMINI, ROUTER]) {
    assert.deepStrictEqual(tier.forModel(m, 'fast'), { field: 'service_tier', value: 'priority' }, m);
    assert.deepStrictEqual(tier.forModel(m, 'economy'), { field: 'service_tier', value: 'flex' }, m);
    assert.strictEqual(tier.forModel(m, 'standard'), null);
    assert.strictEqual(tier.forModel(m, undefined), null);
  }
  assert.deepStrictEqual(tier.forModel(CODEX, 'fast'), { codexConfig: 'fast' });
  assert.strictEqual(tier.forModel(CODEX, 'economy'), null, 'a saved tier the route lacks is ignored, not an error');
  for (const m of NONE) { assert.strictEqual(tier.forModel(m, 'fast'), null, m); assert.strictEqual(tier.forModel(m, 'economy'), null, m); }
  assert.strictEqual(tier.forModel('nonsense', 'fast'), null);
});

test('labels: the words, with the Codex Fast wording for Codex', () => {
  const l = tier.labelsFor(OPENAI);
  assert.strictEqual(l.standard, 'Standard');
  assert.strictEqual(l.fast, 'Fast: quicker answers, about twice the price');
  assert.strictEqual(l.economy, 'Economy: half price, can take minutes; best for scheduled and background work');
  assert.strictEqual(tier.labelsFor(CODEX).fast, 'Fast: uses 2 to 2.5 times as much of the ChatGPT plan');
  assert.strictEqual(tier.labelsFor(CODEX).standard, 'Standard');
  assert.strictEqual(tier.labelsFor('claude-sdk/x').fast, l.fast);
});

test('priceFactor: the reported tier beats the requested one; none reported follows the requested one', () => {
  for (const r of ['priority', 'fast']) assert.strictEqual(tier.priceFactor('openai', r, 'economy'), 2.0, r);
  assert.strictEqual(tier.priceFactor('openai', 'flex', 'fast'), 0.5);
  for (const r of ['default', 'standard', 'auto']) assert.strictEqual(tier.priceFactor('openai', r, 'fast'), 1.0, r + ' (asked Fast, ran on Standard)');
  assert.strictEqual(tier.priceFactor('google', undefined, 'fast'), 2.0);
  assert.strictEqual(tier.priceFactor('google', null, 'economy'), 0.5);
  assert.strictEqual(tier.priceFactor('google', '', 'standard'), 1.0);
  assert.strictEqual(tier.priceFactor('google'), 1.0);
});

test('ledgerTier / bookCall: the tier on the row, the factor on the cost', () => {
  assert.strictEqual(tier.ledgerTier('priority', 'standard'), 'fast');
  assert.strictEqual(tier.ledgerTier('flex', 'fast'), 'economy');
  assert.strictEqual(tier.ledgerTier('default', 'fast'), null, 'the provider ran it on Standard');
  assert.strictEqual(tier.ledgerTier(undefined, 'economy'), 'economy');
  assert.strictEqual(tier.ledgerTier(undefined, 'standard'), null);
  assert.deepStrictEqual(tier.bookCall(1.5, 'openai', 'flex', 'fast'), { factor: 0.5, cost: 0.75, tier: 'economy' });
  assert.deepStrictEqual(tier.bookCall(1, 'openai', undefined, 'fast'), { factor: 2, cost: 2, tier: 'fast' });
  assert.deepStrictEqual(tier.bookCall(null, 'openai', 'priority'), { factor: 2, cost: null, tier: 'fast' });
});

test('tierFallback: only a refusal because of the tier, before output, once', () => {
  const f = tier.tierFallback;
  assert.strictEqual(f({ tier: 'economy', status: 429, message: 'Provider 429: Resource unavailable for flex processing' }), true);
  assert.strictEqual(f({ tier: 'economy', status: 429, message: 'Provider 429: capacity exceeded' }), true);
  assert.strictEqual(f({ tier: 'fast', status: 400, message: "Provider 400: service_tier 'priority' is not supported for this model" }), true);
  assert.strictEqual(f({ tier: 'economy', status: 400, message: 'Invalid value for service_tier' }), true);
  assert.strictEqual(f({ tier: 'fast', status: 403, message: 'Priority is not allowed for this project tier' }), true);
  assert.strictEqual(f({ tier: 'fast', status: 404, message: 'flex is not available' }), true);
  assert.strictEqual(f({ tier: 'fast', status: 403, message: 'Gemini priority tier is not allowed for this account tier' }), true);
  assert.strictEqual(f({ tier: 'standard', status: 429, message: 'Rate limit reached for requests' }), false, 'an ordinary rate limit on Standard');
  assert.strictEqual(f({ tier: 'fast', status: 429, message: 'Rate limit reached for gpt-5.6 in organization' }), false, 'an ordinary rate limit on Fast stays with the normal retries');
  assert.strictEqual(f({ tier: 'economy', status: 429, message: 'capacity', sawOutput: true }), false, 'after output');
  assert.strictEqual(f({ tier: 'economy', status: 429, message: 'capacity', already: true }), false, 'second time');
  assert.strictEqual(f({ tier: 'economy', status: 500, message: 'flex capacity' }), false);
  assert.strictEqual(f({ tier: 'economy', status: 400, message: 'messages: array too short' }), false);
  assert.strictEqual(f({}), false);
  assert.strictEqual(tier.fallbackNotice('economy'), "This answer ran on Standard because Economy wasn't available.");
  assert.strictEqual(tier.fallbackNotice('fast'), "This answer ran on Standard because Fast wasn't available.");
});

// ── the agent setting ──
test('agents: tier is accepted (validated), standard removes it, a bad value is refused, the order of allowedFields keeps its tail', async () => {
  const src = read('lib/agents.js');
  const m = src.match(/const allowedFields = \[([^\]]*)\]/);
  assert.ok(m, 'allowedFields found');
  const list = m[1].split(',').map((x) => x.trim().replace(/'/g, ''));
  assert.strictEqual(list[list.indexOf('effort') + 1], 'tier', 'right after effort');
  assert.deepStrictEqual(list.slice(-3), ['voice', 'callDisplay', 'voiceDefaults'], 'the tail stays');
  assert.match(src, /tier: require\('\.\/tier'\)\.normalize\(a\.tier\)/, 'normalized on read');
  const agents = L('agents');
  const file = path.join(ISO.inst, 'data', 'agents.json');
  fs.writeFileSync(file, JSON.stringify([{ name: 'tester', model: OPENAI, display: 'Tester', category: 'specialist' }]));
  const disk = () => JSON.parse(fs.readFileSync(file, 'utf8')).find((a) => a.name === 'tester');
  assert.strictEqual((await agents.getAgents(true)).find((a) => a.name === 'tester').tier, 'standard', 'unset reads as standard');
  assert.deepStrictEqual(await agents.updateAgentField('tester', { tier: 'economy' }), { success: true });
  assert.strictEqual(disk().tier, 'economy');
  assert.strictEqual((await agents.getAgents(true)).find((a) => a.name === 'tester').tier, 'economy');
  const bad = await agents.updateAgentField('tester', { tier: 'turbo' });
  assert.strictEqual(bad.success, false);
  assert.strictEqual(disk().tier, 'economy', 'unchanged by a refused value');
  assert.deepStrictEqual(await agents.updateAgentField('tester', { tier: 'fast' }), { success: true });
  assert.strictEqual(disk().tier, 'fast');
  assert.deepStrictEqual(await agents.updateAgentField('tester', { tier: 'standard' }), { success: true });
  assert.ok(!('tier' in disk()), 'standard removes the field');
});

test('members cannot change the tier: not in MEMBER_EDITABLE; the list API and the page carry the options', () => {
  const server = read('server.js');
  const m = server.match(/const MEMBER_EDITABLE = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m);
  assert.ok(!/tier/.test(m[1]), 'tier is not member-editable');
  assert.match(server, /tierOptions: require\('\.\/lib\/tier'\)\.tiersFor\(a\.model\), tierLabels: require\('\.\/lib\/tier'\)\.labelsFor\(a\.model\)/);
  const page = read('agent-settings.html');
  assert.match(page, /<select id="tier-mode" onchange="saveTier\(\)"/);
  assert.match(page, /JSON\.stringify\(\{ tier: v \}\)/);
  assert.match(page, /\['saveTier', 'tier-status', byId\('tier-mode'\)\]/);
  assert.match(page, /SAVES_ON_CHANGE = new Set\([^)]*'saveTier'/);
  assert.match(page, /opts\.length > 1/, 'hidden when only Standard is offered');
  assert.match(page, /opts\.includes\(agent\?\.tier\) \? agent\.tier : 'standard'/, 'an unsupported saved tier shows as Standard');
  for (const f of ['lib/ui-simple.js', 'simple.html']) { try { assert.ok(!/tier-mode|saveTier|service_tier/.test(read(f)), f + ' has no tier'); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
});

// ── the gateway ──
test('applyTier: service_tier for openai / google / openrouter fast and economy; nothing for standard or other routes', () => {
  const gw = L('gateway-client');
  const t = (model, tr, provider) => { const body = {}; const info = gw.applyTier(body, model, tr, provider); return { body, info }; };
  assert.deepStrictEqual(t(OPENAI, 'fast', 'openai').body, { service_tier: 'priority' });
  assert.deepStrictEqual(t(OPENAI, 'economy', 'openai').body, { service_tier: 'flex' });
  assert.deepStrictEqual(t(GEMINI, 'fast', 'google').body, { service_tier: 'priority' });
  assert.deepStrictEqual(t(GEMINI, 'economy', 'google').body, { service_tier: 'flex' });
  assert.deepStrictEqual(t(ROUTER, 'economy', 'openrouter').body, { service_tier: 'flex' });
  assert.deepStrictEqual(t(ROUTER, 'fast', 'openrouter').body, { service_tier: 'priority' });
  assert.deepStrictEqual(t(OPENAI, 'economy', 'openai').info, { requested: 'economy', value: 'flex', flex: true });
  assert.strictEqual(t(OPENAI, 'fast', 'openai').info.flex, false);
  for (const [m, p] of [[OPENAI, 'openai'], [GEMINI, 'google'], [ROUTER, 'openrouter']]) { assert.deepStrictEqual(t(m, 'standard', p).body, {}); assert.deepStrictEqual(t(m, undefined, p).body, {}); }
  for (const m of NONE) assert.deepStrictEqual(t(m, 'fast', m.split('/')[0]).body, {}, m);
  assert.deepStrictEqual(t(OPENAI, 'fast', 'gateway').body, {}, 'the hub gateway provider is not a tier route');
  assert.deepStrictEqual(t(CODEX, 'fast', 'codex-cli').body, {}, 'Codex has its own config, not a request field');
});

test('the Responses translation keeps service_tier and the answer keeps the tier the provider used', () => {
  const rs = L('openai-responses');
  assert.strictEqual(rs.toResponsesBody({ model: 'gpt-6', messages: [{ role: 'user', content: 'hi' }], service_tier: 'flex' }).service_tier, 'flex');
  assert.ok(!('service_tier' in rs.toResponsesBody({ model: 'gpt-6', messages: [{ role: 'user', content: 'hi' }] })));
  assert.strictEqual(rs.fromResponsesJSON({ id: 'r', output: [], service_tier: 'priority', usage: { input_tokens: 1, output_tokens: 1 } }).service_tier, 'priority');
});

test('the Responses stream wrapper puts the reported tier on the usage chunk', async () => {
  const rs = L('openai-responses');
  const enc = new TextEncoder();
  const ev = [
    { type: 'response.created', response: { id: 'r1', model: 'gpt-6' } },
    { type: 'response.output_text.delta', delta: 'Hi' },
    { type: 'response.completed', response: { id: 'r1', status: 'completed', service_tier: 'flex', output: [], usage: { input_tokens: 10, output_tokens: 5 } } },
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const up = new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(ev)); c.close(); } }));
  const text = await rs.wrapResponsesStream(up, 'gpt-6').text();
  const chunks = text.split('\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]').map((l) => JSON.parse(l.slice(6)));
  const u = chunks.find((c) => c.usage);
  assert.ok(u, 'a usage chunk');
  assert.strictEqual(u.service_tier, 'flex');
  assert.strictEqual(u.usage.prompt_tokens, 10);
});

function fakeFetch(plan) {
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const step = plan[Math.min(calls.length - 1, plan.length - 1)];
    return new Response(step.text || '{"ok":true}', { status: step.status || 200 });
  };
  return { calls, restore: () => { global.fetch = orig; } };
}
const logQuiet = (fn) => async () => { const e = console.error, w = console.warn, l = console.log; console.error = console.warn = console.log = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; console.log = l; } };

test('sendTiered: a flex capacity refusal is sent once more without service_tier, once, with no rate-limit retries', logQuiet(async () => {
  const gw = L('gateway-client');
  const f = fakeFetch([{ status: 429, text: '{"error":{"message":"Resource unavailable: flex capacity"}}' }, { status: 200 }]);
  try {
    const r = await gw.sendTiered({ url: 'http://x.invalid/v1/chat/completions', headers: {}, body: { model: 'gpt-5.6', service_tier: 'flex' }, wireFor: (b) => b,
      tierInfo: { requested: 'economy', value: 'flex', flex: true }, model: OPENAI, signal: undefined, retryOpts: {}, agent: 'sample' });
    assert.strictEqual(r.fallback, 'economy');
    assert.strictEqual(f.calls.length, 2, 'one flex request, one Standard request, nothing in between');
    assert.strictEqual(f.calls[0].service_tier, 'flex');
    assert.ok(!('service_tier' in f.calls[1]));
  } finally { f.restore(); }
}));

test('sendTiered: a 400 naming the tier falls back; an ordinary error is thrown; Standard never falls back', logQuiet(async () => {
  const gw = L('gateway-client');
  const info = { requested: 'fast', value: 'priority', flex: false };
  let f = fakeFetch([{ status: 400, text: "service_tier 'priority' is not supported for this model" }, { status: 200 }]);
  try {
    const r = await gw.sendTiered({ url: 'http://x.invalid/c', headers: {}, body: { service_tier: 'priority' }, wireFor: (b) => b, tierInfo: info, model: GEMINI, retryOpts: {}, agent: 'sample' });
    assert.strictEqual(r.fallback, 'fast'); assert.strictEqual(f.calls.length, 2);
  } finally { f.restore(); }
  f = fakeFetch([{ status: 400, text: 'messages: array too short' }]);
  try {
    await assert.rejects(gw.sendTiered({ url: 'http://x.invalid/c', headers: {}, body: { service_tier: 'priority' }, wireFor: (b) => b, tierInfo: info, model: GEMINI, retryOpts: {}, agent: 'sample' }), /Provider 400/);
    assert.strictEqual(f.calls.length, 1);
  } finally { f.restore(); }
  // refused on the Standard retry too: the error is thrown, never a third request
  gw.tierRefused.clear();
  f = fakeFetch([{ status: 403, text: 'priority not allowed for this tier' }, { status: 403, text: 'priority not allowed for this tier' }]);
  try {
    await assert.rejects(gw.sendTiered({ url: 'http://x.invalid/c', headers: {}, body: { service_tier: 'priority' }, wireFor: (b) => b, tierInfo: info, model: GEMINI, retryOpts: { noRetries: true }, agent: 'sample' }), /Provider 403/);
    assert.strictEqual(f.calls.length, 2);
  } finally { f.restore(); }
  f = fakeFetch([{ status: 200 }]);
  try {
    const r = await gw.sendTiered({ url: 'http://x.invalid/c', headers: {}, body: {}, wireFor: (b) => b, tierInfo: null, model: OPENAI, retryOpts: {}, agent: 'sample' });
    assert.strictEqual(r.fallback, null); assert.strictEqual(f.calls.length, 1);
  } finally { f.restore(); }
}));

test('sendTiered: a model that refused a tier outright is asked on Standard directly next time; a capacity refusal is not remembered', logQuiet(async () => {
  const gw = L('gateway-client');
  gw.tierRefused.clear();
  const info = { requested: 'fast', value: 'priority', flex: false };
  const send = () => gw.sendTiered({ url: 'http://x.invalid/c', headers: {}, body: { service_tier: 'priority' }, wireFor: (b) => b, tierInfo: info, model: ROUTER, retryOpts: {}, agent: 'sample' });
  let f = fakeFetch([{ status: 400, text: "service_tier 'priority' is not supported for this model" }, { status: 200 }]);
  try { assert.strictEqual((await send()).fallback, 'fast'); assert.strictEqual(f.calls.length, 2); } finally { f.restore(); }
  f = fakeFetch([{ status: 200 }]);
  try {
    const r = await send();
    assert.strictEqual(r.fallback, 'fast', 'still reported, so the reply says it ran on Standard and the ledger books Standard');
    assert.strictEqual(f.calls.length, 1, 'no refused request first');
    assert.ok(!('service_tier' in f.calls[0]));
  } finally { f.restore(); }
  // an expired entry is forgotten
  for (const k of gw.tierRefused.keys()) gw.tierRefused.set(k, Date.now() - 1);
  f = fakeFetch([{ status: 200 }]);
  try { assert.strictEqual((await send()).fallback, null); assert.strictEqual(f.calls[0].service_tier, 'priority'); } finally { f.restore(); }
  // capacity (429) is passing: the next request asks for flex again
  gw.tierRefused.clear();
  const flex = { requested: 'economy', value: 'flex', flex: true };
  const sendFlex = () => gw.sendTiered({ url: 'http://x.invalid/c', headers: {}, body: { service_tier: 'flex' }, wireFor: (b) => b, tierInfo: flex, model: OPENAI, retryOpts: {}, agent: 'sample' });
  f = fakeFetch([{ status: 429, text: 'Resource unavailable for flex processing' }, { status: 200 }]);
  try { assert.strictEqual((await sendFlex()).fallback, 'economy'); } finally { f.restore(); }
  assert.strictEqual(gw.tierRefused.size, 0);
  f = fakeFetch([{ status: 200 }]);
  try { assert.strictEqual((await sendFlex()).fallback, null); assert.strictEqual(f.calls[0].service_tier, 'flex'); } finally { f.restore(); }
}));

test('tierFallback: a bare "priority" or "flex" in an unrelated error does not fall back', () => {
  const f = tier.tierFallback;
  assert.strictEqual(f({ tier: 'fast', status: 400, message: "Invalid schema for function 'task': properties.priority must have a type" }), false);
  assert.strictEqual(f({ tier: 'economy', status: 404, message: 'The model flexcoder-2 does not exist' }), false);
  assert.strictEqual(f({ tier: 'fast', status: 400, message: 'Unsupported parameter: service_tier' }), true);
});

test('codexTierFallback: Codex Fast refused before output falls back once; other errors and no Fast do not', () => {
  const f = tier.codexTierFallback;
  assert.strictEqual(f({ sent: 'fast', sawOutput: false, message: "unknown variant `fast` for service_tier", already: false }), true);
  assert.strictEqual(f({ sent: 'fast', message: 'Fast mode is not available on your plan' }), true);
  assert.strictEqual(f({ sent: 'fast', message: 'priority processing is not available' }), true);
  assert.strictEqual(f({ sent: null, message: 'service_tier unsupported' }), false, 'nothing was sent');
  assert.strictEqual(f({ sent: 'fast', sawOutput: true, message: 'service_tier unsupported' }), false);
  assert.strictEqual(f({ sent: 'fast', already: true, message: 'service_tier unsupported' }), false);
  assert.strictEqual(f({ sent: 'fast', message: "You've hit your usage limit" }), false);
  assert.strictEqual(f({ sent: 'fast', message: 'stream disconnected before completion' }), false);
});

test('flex gets the 16-minute allowance, only flex; the other timings are untouched', () => {
  const gw = L('gateway-client');
  assert.strictEqual(gw.FLEX_WAIT_MS, 16 * 60 * 1000);
  const src = read('lib/gateway-client.js');
  assert.match(src, /const flexSent = !!\(tierInfo && tierInfo\.flex && !fallback\);/);
  assert.match(src, /if \(flexSent\) tagHidden\(response, '__hubStallMs', FLEX_WAIT_MS\);/);
  assert.match(src, /if \(flexSent\) tagHidden\(wrapped, '__hubStallMs', FLEX_WAIT_MS\);/, 'also on the Responses stream');
  assert.match(src, /extra\.flex \? httpAgent\.longWaitOption\(FLEX_WAIT_MS\) : httpAgent\.dispatcherOption\(\)/, 'the wait for the first byte, flex only');
  assert.match(src, /flex: tierInfo\.flex/, 'only flex requests ask for it');
  assert.match(src, /const STREAM_STALL_MS = \(\(\) => \{[^}]*120_000/, 'Standard and Fast idle allowance unchanged');
  assert.match(src, /\(opts\.tierSent && await isTierCapacity429\(response\)\)/, 'a tier capacity 429 skips the rate-limit retries');
  // parseSSEStream is the only idle watchdog on the gateway tool loop and it honours the response's allowance
  assert.match(src, /Number\.isFinite\(response\.__hubStallMs\) \? response\.__hubStallMs : STREAM_STALL_MS/);
  const ha = read('lib/http-agent.js');
  assert.match(ha, /const ms = Math\.max\(HEADERS_TIMEOUT_MS, Number\(headersTimeoutMs\) \|\| 0\);/);
  assert.match(ha, /function dispatcherOption\(\) \{\n  if \(!installed\) init\(\);\n  return available && agent \? \{ dispatcher: agent \} : \{\};/, 'the normal pool is untouched');
});

test('parseSSEStream: a flex response is not cut at the Standard idle allowance', async () => {
  const gw = L('gateway-client');
  const mk = () => new Response(new ReadableStream({ start(c) { setTimeout(() => { try { c.close(); } catch {} }, 150); } }));   // silent, then ends
  const std = mk();
  const st = {};
  const t0 = Date.now();
  // Standard: the default allowance applies (state.stallMs reports it)
  const it = gw.parseSSEStream(Object.defineProperty(std, '__hubStallMs', { value: 30, enumerable: false }), st);
  await it.next();
  assert.strictEqual(st.stalled, true); assert.strictEqual(st.stallMs, 30);
  assert.ok(Date.now() - t0 < 5000);
  const flex = Object.defineProperty(mk(), '__hubStallMs', { value: gw.FLEX_WAIT_MS, enumerable: false });
  const st2 = {};
  const it2 = gw.parseSSEStream(flex, st2);
  await it2.next();   // runs to the end of the silent stream: the 16 minute allowance did not cut it
  assert.strictEqual(st2.stalled, false, 'not cut');
  assert.strictEqual(st2.eof, true);
  assert.strictEqual(st2.stallMs, 16 * 60 * 1000);
});

// ── who may use it ──
test('member cap: Standard for a member turn or a member agent origin, computed once for both paths', () => {
  const chat = read('lib/sdk-chat.js');
  assert.match(chat, /const memberTurn = !!\(trustedUserId && !trustedAdmin\);/);
  assert.match(chat, /const memberOrigin = originFromMemberAgent\(\[turnOrigin && turnOrigin\.from, turnOrigin && turnOrigin\.by, turnOrigin && turnOrigin\.agent, consulted_by, turnOrigin && turnOrigin\.kind !== 'user' \? agent : null\], /);
  assert.match(chat, /const turnTier = \(memberTurn \|\| memberOrigin\) \? 'standard' : await agentTier\(agent\);/);
  const iCap = chat.indexOf("const turnTier = (memberTurn || memberOrigin)");
  assert.ok(iCap > 0 && iCap < chat.indexOf('if (codexCli.isCodexCliModel(agentModel)) {\n    // The gateway cannot call a subscription model'), 'computed before the routing branches');
  assert.match(chat, /await streamViaCodex\(agent, finalMessage, imagePaths, res, \{[^]*?memberTurn,[^]*?memberOrigin,\n      tier: turnTier,/, 'the Codex path gets it');
  assert.match(chat, /await streamViaGateway\(agent, finalMessage, imagePaths, res, \{[^]*?effort: turnEffortAsked,\n      tier: turnTier,/, 'the gateway path gets it');
  assert.match(chat, /effort: turnEffort, tier: tierNow \}/, 'the tool loop passes it to chatCompletionStream');
  assert.match(chat, /let codexServiceTier = \(options\.memberTurn \|\| options\.memberOrigin\) \? null :/, 'Codex defends in depth');
  assert.match(chat, /let tierNow = options\.tier \? tierLib\.normalize\(options\.tier\) : 'standard'/, 'a call with no tier (tiger-team and other internal calls) is Standard');
  assert.ok(!/simpleTurn[^\n]*tier|tier[^\n]*simpleTurn/.test(chat), 'Simple turns keep the agent tier (only members are capped)');
});

test('the fallback notice is the first line of the reply and stops asking for the tier for the rest of the turn', () => {
  const chat = read('lib/sdk-chat.js');
  assert.match(chat, /if \(gatewayResponse\.__hubTierFallback\) \{\n\s+tierNow = 'standard';/);
  assert.match(chat, /tierLib\.fallbackNotice\(gatewayResponse\.__hubTierFallback\) \+ '\\n\\n'/);
  assert.ok(chat.indexOf('tierLib.fallbackNotice(') < chat.indexOf('for await (const chunk of parseSSEStream(gatewayResponse, streamState))'), 'before any reply text of that call');
});

// ── Codex ──
test('Codex: buildArgs adds -c service_tier="fast" only for fast; threadParams adds config.service_tier', () => {
  const cx = L('codex-cli/index');
  const base = { model: 'gpt-5.6-codex', cwd: '/tmp/x', sandbox: 'read-only' };
  const has = (args) => args.some((a, i) => a === '-c' && args[i + 1] === 'service_tier="fast"');
  assert.strictEqual(has(cx.buildArgs({ ...base, serviceTier: 'fast' })), true);
  assert.strictEqual(has(cx.buildArgs({ ...base })), false);
  assert.strictEqual(has(cx.buildArgs({ ...base, serviceTier: null })), false);
  assert.strictEqual(has(cx.buildArgs({ ...base, serviceTier: 'economy' })), false, 'economy is not a Codex tier');
  const as = L('codex-cli/app-server');
  assert.strictEqual(as.threadParams({ ...base, serviceTier: 'fast' }).config.service_tier, 'fast');
  assert.strictEqual(as.threadParams({ ...base, serviceTier: 'fast', effort: 'high' }).config.model_reasoning_effort, 'high', 'the other config survives');
  assert.ok(!as.threadParams({ ...base }).config || !('service_tier' in as.threadParams({ ...base }).config));
  const chat = read('lib/sdk-chat.js');
  assert.strictEqual((chat.match(/serviceTier: codexServiceTier/g) || []).length, 2, 'the app-server thread and the exec fallback');
  // Codex refused Fast: one retry without it on both transports, before the resume retry; the reply says so
  assert.strictEqual((chat.match(/tierFellBack = startTierFallback\(/g) || []).length, 2);
  assert.match(chat, /const startTierFallback = \(why\) => \{\n\s+codexServiceTier = null;[\s\S]{0,200}emitCodexText\(tierLib\.fallbackNotice\('fast'\)/);
  const exec = chat.indexOf('result = await runOnce();   // runOnce builds its arguments now, so it asks without Fast');
  const resume = chat.indexOf('A stored thread that no longer resumes (deleted, other machine): start fresh once.', chat.indexOf('let result = await runOnce();'));
  assert.ok(exec > 0 && resume > exec, 'the Fast retry comes before the resume retry');
  assert.match(chat, /ok: true, tier: codexServiceTier \? 'fast' : null \}\); \} catch \{\}/, 'the ledger row records Fast');
});

// ── the ledger ──
test('ledger: the reported tier scales the estimated cost and is stored on the row; a reported cost is booked as is', () => {
  const { createLedger } = L('ledger');
  const Database = require('better-sqlite3');
  const file = path.join(ISO.root, 'tier-ledger.db');
  const l = createLedger({ file });
  const rec = (extra) => l.record({ agent: 'sample', model: 'openai/gpt-5.6', inputTokens: 1000000, outputTokens: 0, ...extra });
  const base = rec({}).cost;
  assert.ok(base > 0);
  const fast = tier.bookCall(null, 'openai', 'priority', 'standard');
  const eco = tier.bookCall(null, 'openai', 'flex', 'fast');
  assert.strictEqual(rec({ priceFactor: fast.factor, tier: fast.tier }).cost, base * 2);
  assert.strictEqual(rec({ priceFactor: eco.factor, tier: eco.tier }).cost, base * 0.5);
  assert.strictEqual(rec({ costUsd: 0.75, priceFactor: 2, tier: 'fast' }).cost, 0.75, 'a cost the provider reported already reflects the tier');
  const db = new Database(file, { readonly: true });
  const rows = db.prepare('SELECT cost_usd, tier FROM turns ORDER BY id').all();
  db.close();
  assert.deepStrictEqual(rows.map((r) => r.tier), [null, 'fast', 'economy', 'fast']);
  assert.strictEqual(rows[1].cost_usd, base * 2);
  const chat = read('lib/sdk-chat.js');
  assert.match(chat, /priceFactor: turnUsage\.base > 0 \? turnUsage\.scaled \/ turnUsage\.base : turnUsage\.lastFactor, tier: turnUsage\.tier/);
  assert.match(chat, /chunk\.service_tier/, 'the reported tier is read from the stream');
});

test('bookUsage: a call is priced for the tier the provider reported', () => {
  const u = { prompt_tokens: 1000000, completion_tokens: 0, total_tokens: 1000000 };
  const std = tier.bookUsage('openai/gpt-5.6', u, 'default', 'standard');
  assert.ok(std.base > 0); assert.strictEqual(std.factor, 1); assert.strictEqual(std.tier, null);
  const fast = tier.bookUsage('openai/gpt-5.6', u, 'priority', 'fast');
  assert.strictEqual(fast.scaled, std.base * 2); assert.strictEqual(fast.tier, 'fast');
  const eco = tier.bookUsage('openai/gpt-5.6', u, undefined, 'economy');
  assert.strictEqual(eco.scaled, std.base * 0.5); assert.strictEqual(eco.tier, 'economy');
  assert.strictEqual(tier.bookUsage('nobody/unknown-model', u, 'flex', 'economy').base, null, 'no price: no estimate, the factor still reported');
});
