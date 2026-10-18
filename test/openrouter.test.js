'use strict';
// OpenRouter as a provider (lib/openrouter + the places that name providers): the catalogue and the default offer,
// what a request adds (cost, privacy, reasoning, output limit, Claude cache breakpoints), the free key check, the
// Settings box, the pickers, the Welcome page.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOpenRouter, cleanOpenRouterSettings, ATTRIBUTION } = require('../lib/openrouter');
const { billingOf } = require('../lib/billing');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const T = (id, created, extra = {}) => ({
  id, name: id, created, context_length: 200000,
  pricing: { prompt: '0.000002', completion: '0.00001', input_cache_read: '0.0000002' },
  supported_parameters: ['tools', 'tool_choice', 'max_tokens', ...(extra.reasoning ? ['reasoning', 'include_reasoning'] : [])],
  architecture: { input_modalities: extra.images ? ['text', 'image'] : ['text'] },
  top_provider: { max_completion_tokens: extra.maxOut || 64000 },
  ...(extra.noTools ? { supported_parameters: ['max_tokens'] } : {}),
});
const CATALOG = [
  T('x-ai/grok-4.7', 300, { reasoning: true, images: true }), T('x-ai/grok-4.6', 200),
  T('deepseek/deepseek-v4.1', 310, { reasoning: true }), T('deepseek/deepseek-v4.1:free', 320),
  T('moonshotai/kimi-k3', 330), T('moonshotai/kimi-k3:batch', 340),
  T('qwen/qwen3.8-max', 250), T('qwen/qwen3.8-max-1017', 260), T('mistralai/mistral-large-3', 240, { maxOut: 8000 }),
  T('anthropic/claude-sonnet-5.5', 400, { reasoning: true, images: true }), T('anthropic/claude-haiku-5.5', 410),
  T('openai/gpt-6', 420, { reasoning: true }), T('google/gemini-4-argon', 430, { images: true }),
  T('meta-llama/llama-5-405b', 100, { noTools: true }),
];

function mk({ keys = {}, openrouter = {}, fetchImpl } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'or-'));
  const calls = [];
  const settings = { get: () => ({ openrouter }), getProviderKey: (p) => keys[p] || '' };
  const f = fetchImpl || (async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ data: CATALOG }) }; });
  const or = createOpenRouter({ file: path.join(dir, 'openrouter-models.json'), fetchImpl: f, settings: () => settings, log: () => {} });
  return { or, calls, dir, settings };
}

test('the catalogue: fetched once (12 h cache), kept small, batch-only variants left out', async () => {
  const { or, calls, dir } = mk();
  await or.refresh();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://openrouter.ai/api/v1/models');
  assert.deepStrictEqual(Object.keys(calls[0].init.headers), ['HTTP-Referer', 'X-Title'], 'attribution only, no key needed');
  await or.refresh();
  assert.strictEqual(calls.length, 1, 'cached');
  await or.refresh({ force: true });
  assert.strictEqual(calls.length, 2);
  assert.ok(!or.catalog().some(m => m.id.includes(':batch')));
  const g = or.info('openrouter/x-ai/grok-4.7');
  assert.deepStrictEqual([g.context, g.maxOut, g.tools, g.reasoning, g.images, g.prompt], [200000, 64000, true, true, true, 0.000002]);
  assert.strictEqual(or.info('x-ai/grok-4.7').id, 'x-ai/grok-4.7', 'with or without the prefix');
  assert.strictEqual(or.info('meta-llama/llama-5-405b').tools, false);
  assert.ok(fs.existsSync(path.join(dir, 'openrouter-models.json')));
  assert.strictEqual((fs.statSync(path.join(dir, 'openrouter-models.json')).mode & 0o777).toString(8), '600');
});

test('the default offer: the newest tool-capable model of each vendor the hub has no key for; no :free or other variants', async () => {
  const withKeys = mk({ keys: { anthropic: 'k', openai: 'k', google: 'k' } });
  await withKeys.or.refresh();
  assert.deepStrictEqual(withKeys.or.chosen(), ['x-ai/grok-4.7', 'deepseek/deepseek-v4.1', 'moonshotai/kimi-k3', 'qwen/qwen3.8-max', 'mistralai/mistral-large-3'], 'Claude, GPT and Gemini come from their own keys; the alias, not the newer dated snapshot');
  const noKeys = mk();
  await noKeys.or.refresh();
  const picks = noKeys.or.chosen();
  assert.ok(picks.includes('anthropic/claude-haiku-5.5') && picks.includes('openai/gpt-6') && picks.includes('google/gemini-4-argon'), 'without those keys they come through OpenRouter');
  assert.ok(!picks.includes('meta-llama/llama-5-405b'), 'no tool use: not offered');
  const own = mk({ openrouter: { models: ['x-ai/grok-4.6', 'gone/model'] } });
  await own.or.refresh();
  assert.deepStrictEqual(own.or.chosen(), ['x-ai/grok-4.6'], 'the owner\'s choice, minus models that left the catalogue');
  const v = own.or.view();
  assert.strictEqual(v.custom, true);
  assert.strictEqual(v.privacy, true, 'privacy on by default');
});

test('a request: the cost comes back, only providers that keep nothing, reasoning in OpenRouter\'s form, the model\'s output limit', async () => {
  const { or } = mk();
  await or.refresh();
  const body = or.requestExtras({ model: 'mistralai/mistral-large-3', messages: [{ role: 'user', content: 'hi' }], max_tokens: 32000, reasoning_effort: 'high' }, 'mistralai/mistral-large-3');
  assert.deepStrictEqual(body.usage, { include: true });
  assert.deepStrictEqual(body.provider, { data_collection: 'deny' });
  assert.deepStrictEqual(body.reasoning, { effort: 'high' });
  assert.ok(!('reasoning_effort' in body));
  assert.strictEqual(body.max_tokens, 8000, 'clamped to what the model can write');
  assert.strictEqual(typeof body.messages[0].content, 'string', 'no cache markers for non-Claude models (they cache by themselves)');
  const off = mk({ openrouter: { privacy: false } });
  await off.or.refresh();
  assert.ok(!('provider' in off.or.requestExtras({ model: 'x', messages: [] }, 'x-ai/grok-4.7')), 'privacy off: any provider');
});

test('Claude through OpenRouter gets cache breakpoints on the system message and the latest user message (2 of 4)', async () => {
  const { or } = mk();
  await or.refresh();
  const msgs = [{ role: 'system', content: 'SOUL' }, { role: 'user', content: 'first' }, { role: 'assistant', content: 'ok', tool_calls: [{ id: 't1' }] }, { role: 'tool', tool_call_id: 't1', content: 'result' }];
  const b = or.requestExtras({ model: 'anthropic/claude-sonnet-5.5', messages: msgs }, 'anthropic/claude-sonnet-5.5');
  assert.deepStrictEqual(b.messages[0].content, [{ type: 'text', text: 'SOUL', cache_control: { type: 'ephemeral' } }]);
  assert.deepStrictEqual(b.messages[1].content, [{ type: 'text', text: 'first', cache_control: { type: 'ephemeral' } }], 'the latest user message (tool rounds follow it)');
  assert.strictEqual(b.messages[3].content, 'result', 'tool results untouched');
  const parts = or.requestExtras({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'x' } }] }] }, 'anthropic/claude-haiku-5.5', { cacheTtl: '1h' });
  assert.deepStrictEqual(parts.messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' }, 'the last text part, with the hub\'s TTL');
  const none = or.requestExtras({ messages: [{ role: 'system', content: 'S' }] }, 'anthropic/claude-haiku-5.5', { cache: false });
  assert.strictEqual(none.messages[0].content, 'S', 'prompt caching switched off in Settings');
});

test('the key check is free (account details) and says plainly what is wrong', async () => {
  const ok = mk({ fetchImpl: async (url, init) => ({ ok: true, status: 200, json: async () => ({ data: { label: 'hub', limit: 20, usage: 1.5, limit_remaining: 18.5, is_free_tier: false } }), _u: url, _h: init.headers }) });
  const r = await ok.or.checkKey('sk-or-v1-abc');
  assert.deepStrictEqual([r.ok, r.label, r.remaining, r.freeTier], [true, 'hub', 18.5, false]);
  let seen = null;
  const spy = mk({ fetchImpl: async (url, init) => { seen = { url, auth: init.headers.Authorization }; return { ok: false, status: 401, json: async () => ({}) }; } });
  const bad = await spy.or.checkKey('sk-or-v1-wrong');
  assert.deepStrictEqual([seen.url, seen.auth], ['https://openrouter.ai/api/v1/key', 'Bearer sk-or-v1-wrong']);
  assert.match(bad.error, /refused this key/);
  const down = mk({ fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
  assert.match((await down.or.checkKey('k')).error, /Could not reach OpenRouter/);
  assert.match((await down.or.checkKey('')).error, /No OpenRouter key/);
});

test('settings.openrouter is cleaned: model ids (vendor/model), null = the default offer, privacy as a boolean', () => {
  assert.deepStrictEqual(cleanOpenRouterSettings({ models: ['x-ai/grok-4.7', 'x-ai/grok-4.7', 'bad id', '<script>/x', 'deepseek/deepseek-v4.1:free'], privacy: 0 }), { models: ['x-ai/grok-4.7', 'deepseek/deepseek-v4.1:free'], privacy: false });
  assert.deepStrictEqual(cleanOpenRouterSettings({ models: null }), { models: null });
  assert.deepStrictEqual(cleanOpenRouterSettings('junk'), {});
});

test('labels: an OpenRouter model is billed per use (API), shown under OpenRouter, named vendor/model', () => {
  const b = billingOf('openrouter/x-ai/grok-4.7');
  assert.deepStrictEqual([b.kind, b.vendor, b.route, b.name, b.short], ['api', 'OpenRouter', 'API', 'x-ai/grok-4.7', 'x-ai/grok-4.7 · API $']);
  assert.ok(ATTRIBUTION['X-Title'] === 'My Maestro AI' && /^https:\/\/www\.mymaestroai\.ai/.test(ATTRIBUTION['HTTP-Referer']), 'the product, nothing about this machine');
});

test('the Welcome page: OpenRouter is a fourth way in; the key is proved for free and the lead agent gets Claude Sonnet', async () => {
  const { createWelcome } = require('../lib/welcome');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'or-w-'));
  const saved = {};
  const settings = { get: () => ({}), updateSettings: (p) => Object.assign(saved, p), hasAnyApiKey: () => false, getProviderKey: () => '' };
  const { or } = mk({ keys: { anthropic: 'k', openai: 'k', google: 'k' } });
  const w = createWelcome({ dataDir: dir, env: {}, settings, claudeAuth: { hasSdkCredentials: () => false }, openrouter: { ...or, checkKey: async () => ({ ok: true, remaining: 10 }) } });
  const r = await w.connectApiKey('openrouter', 'test-openrouter-key-not-real');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.suggested, 'openrouter/anthropic/claude-sonnet-5.5');
  assert.ok(r.models.includes('openrouter/x-ai/grok-4.7'));
  assert.strictEqual(saved.providers.openrouter.apiKey, 'test-openrouter-key-not-real', 'saved only after the check');
  const w2 = createWelcome({ dataDir: dir, env: {}, settings, claudeAuth: { hasSdkCredentials: () => false }, openrouter: { ...or, checkKey: async () => ({ ok: false, status: 401, error: 'OpenRouter refused this key. Check that you copied all of it and that it is not disabled.' }) } });
  const bad = await w2.connectApiKey('openrouter', 'sk-or-v1-wrongwrongwrong');
  assert.strictEqual(bad.ok, false); assert.match(bad.error, /refused this key/);
  assert.ok(read('welcome.html').includes('<option value="openrouter">OpenRouter (many vendors, one key)</option>'));
});

test('wiring: settings, discovery, requests, effort, ledger, context window, workers, hub brief, routes, pages', () => {
  const s = read('lib/settings.js');
  assert.ok(s.includes("openrouter:{ url: 'https://openrouter.ai/api/v1' },") && s.includes("openrouter: 'OPENROUTER_API_KEY',") && s.includes("getProviderKey('openrouter'));"));
  const d = read('lib/model-discovery.js');
  assert.ok(d.includes('result.openrouter = or.chosen();') && d.includes('models.push(`openrouter/${m}`)'));
  const g = read('lib/gateway-client.js');
  assert.ok((g.match(/if \(provider === 'openrouter'\) openRouterExtras\(body, modelId\);/g) || []).length === 2, 'stream and non-stream');
  assert.ok(g.includes("...(provider === 'openrouter' ? require('./openrouter').ATTRIBUTION : {}),"));
  assert.ok(g.includes("if (provider === 'openrouter') { try { const m = require('./openrouter').getOpenRouter().info(model); if (m) return !!m.images; }"));
  assert.ok(read('lib/effort.js').includes("return { route: reasons ? 'openrouter-api' : 'none', name };"));
  assert.ok(read('lib/ledger.js').includes("if (/^openrouter\\//i.test(String(model || ''))) { try { return require('./openrouter').getOpenRouter().pricePerMillion(model); }"));
  assert.ok(read('lib/sdk-chat.js').includes('if (callUsage.cost != null && Number.isFinite(Number(callUsage.cost))) { turnUsage.cost += Number(callUsage.cost); turnUsage.costSeen = true; }') && read('lib/sdk-chat.js').includes('...(turnUsage.costSeen ? { costUsd: turnUsage.cost } : {})'), 'the reported cost is booked');
  assert.ok(read('lib/context-budget.js').includes("if (m && m.context) return { window: m.context, source: 'openrouter' };"));
  assert.ok(read('lib/temporal-workers.js').includes("if (p === 'openrouter') return"));
  assert.ok(read('lib/hub-map.js').includes("'perplexity', 'openrouter'].filter(p =>"));
  const srv = read('server.js');
  assert.ok(srv.includes("if (pathname === '/api/openrouter' && req.method === 'GET') {") && srv.includes("if (pathname === '/api/openrouter' && req.method === 'POST') {"));
  assert.ok(srv.includes("if (provider === 'openrouter') {   // the free key check"));
  assert.ok(srv.includes("if (patch && patch.openrouter !== undefined) patch.openrouter = require('./lib/openrouter').cleanOpenRouterSettings(patch.openrouter);"));
  const app = read('app.js');
  assert.ok(app.includes("{ id: 'openrouter', label: 'OpenRouter', hasKey: true, hasUrl: false },"));
  assert.ok(app.includes("openrouter: 'OpenRouter'") && app.includes("const VENDOR_ORDER = ['Anthropic', 'OpenAI', 'Google', 'Perplexity', 'OpenRouter', 'Local'];"));
  assert.ok(app.includes('<div class="st-section" id="st-or-section"><h4>OpenRouter</h4>') && app.includes('function renderOpenRouterBox()') && app.includes("postOpenRouter({ models: null }"));
  assert.ok(read('mobile.js').includes("const MP_VENDOR_ORDER = ['Anthropic', 'OpenAI', 'Google', 'Perplexity', 'OpenRouter', 'Local'];"));
  assert.ok(read('agent-settings.html').includes("'Perplexity · API $', 'OpenRouter · API $', 'Local'];"));
});
