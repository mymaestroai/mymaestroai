'use strict';
// Behavioural unit tests for lib/model-discovery.js. The module hard-codes <hub>/data/discovered-models.json and
// <hub>/data/agents.json, so lib/ is copied into a temp hub and the copy is required. sdk-loader, claude-auth, settings and
// gateway-client are stubbed at the copy's paths; global.fetch is replaced by a URL-routed fake (restored in after()).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const REAL_ROOT = path.join(__dirname, '..');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-model-discovery-'));
const HUB = path.join(ROOT, 'hub');
fs.cpSync(path.join(REAL_ROOT, 'lib'), path.join(HUB, 'lib'), { recursive: true });
fs.copyFileSync(path.join(REAL_ROOT, 'package.json'), path.join(HUB, 'package.json'));
fs.symlinkSync(path.join(REAL_ROOT, 'node_modules'), path.join(HUB, 'node_modules'));
const DATA = path.join(HUB, 'data');
const CACHE = path.join(DATA, 'discovered-models.json');
const stub = (name, exports) => { const m = new Module(path.join(HUB, 'lib', name)); m.filename = m.id; m.loaded = true; m.exports = exports; require.cache[m.id] = m; };

const st = { keys: {}, token: '', sdkCreds: false, aliases: [], probeOk: () => false, invalidated: 0, routes: {}, fetches: [], codex: [] };
// lib/codex-cli/index.js shells out to the real `codex` binary (login status + `debug models`); stubbed so no subprocess runs.
stub(path.join('codex-cli', 'index.js'), { discoverModels: async () => { if (st.codex instanceof Error) throw st.codex; return st.codex; } });
stub('settings.js', { getProviderKey: (p) => st.keys[p] || '', getProviderUrl: (p) => `http://${p}.test/v1` });
stub('claude-auth.js', { getOauthToken: () => st.token, hasSdkCredentials: () => st.sdkCreds, credentialSource: () => 'test' });
stub('gateway-client.js', { invalidateModelsCache: () => { st.invalidated++; } });
stub('sdk-loader.js', { cliOptions: () => ({ cli: 'opts' }), loadSdk: async () => ({ query: ({ options }) => ({
  supportedModels: async () => st.aliases,
  close() {},
  async *[Symbol.asyncIterator]() { yield { type: 'assistant' }; yield { type: 'result', is_error: !st.probeOk(options.model), result: 'OK' }; },
}) }) });

const realFetch = global.fetch, realLog = console.log, realErr = console.error;
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
test.before(() => {
  console.log = () => {}; console.error = () => {};
  global.fetch = async (url, init = {}) => {                        // st.routes: substring -> body | status number | function(url, init)
    const u = String(url); st.fetches.push({ url: u, init });
    for (const [k, v] of Object.entries(st.routes)) if (u.includes(k)) return typeof v === 'function' ? v(u, init) : typeof v === 'number' ? json(v, { error: 'x' }) : json(200, v);
    throw new Error(`ECONNREFUSED ${u}`);
  };
});
test.after(() => { global.fetch = realFetch; console.log = realLog; console.error = realErr; fs.rmSync(ROOT, { recursive: true, force: true }); });
test.beforeEach(() => { Object.assign(st, { keys: {}, token: '', sdkCreds: false, aliases: [], probeOk: () => false, routes: {}, codex: [] }); st.fetches.length = 0; fs.rmSync(CACHE, { force: true }); });
const md = require(path.join(HUB, 'lib', 'model-discovery.js'));
const urls = () => st.fetches.map(f => f.url);
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)); } };

test('loadCache / getDiscoveredModels: missing or corrupt cache -> null / []', () => {
  assert.strictEqual(md.loadCache(), null);
  assert.deepStrictEqual(md.getDiscoveredModels(), []);
  fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(CACHE, '{oops');
  assert.strictEqual(md.loadCache(), null);
  assert.deepStrictEqual(md.getDiscoveredModels(), []);
});

test('everything offline and no keys: empty result, cache written, models cache invalidated, no cloud fetches', async () => {
  const r = await md.runDiscovery();
  for (const k of ['anthropic', 'claude-sdk', 'codex-cli', 'openai', 'google', 'perplexity', 'lmstudio', 'ollama', 'omlx', 'ninfer', 'local']) assert.deepStrictEqual(r[k], [], k);
  assert.match(r.discoveredAt, /^\d{4}-\d\d-\d\dT/); assert.ok(r.durationMs >= 0);
  assert.deepStrictEqual(urls().sort(), ['http://lmstudio.test/v1/models', 'http://local.test/v1/models', 'http://ninfer.test/v1/models', 'http://ollama.test/v1/models', 'http://omlx.test/v1/models'], 'only local providers probed');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(CACHE, 'utf8')), r);
  assert.strictEqual(st.invalidated, 1);
  assert.deepStrictEqual(md.getDiscoveredModels(), []);
});

test('OpenAI-compatible list shapes: LM Studio/ollama/omlx take every id, OpenAI is filtered to chat models', async () => {
  st.keys = { openai: 'sk-o' };
  st.routes['lmstudio.test'] = { data: [{ id: 'qwen3-8b' }, { id: 'text-embedding-nomic' }] };
  st.routes['ollama.test'] = { data: [{ id: 'llama3:8b' }] };
  st.routes['omlx.test'] = { object: 'list' };
  st.routes['api.openai.com/v1/models'] = (u, init) => { assert.strictEqual(init.headers.Authorization, 'Bearer sk-o'); return json(200, { data: [
    { id: 'gpt-5' }, { id: 'gpt-5.6-sol' }, { id: 'gpt-4o' }, { id: 'o3' }, { id: 'o4-mini' }, { id: 'gpt-4o-audio-preview' }, { id: 'gpt-4o-realtime' },
    { id: 'gpt-5-codex' }, { id: 'gpt-image-1' }, { id: 'whisper-1' }, { id: 'text-embedding-3-small' }, { id: 'dall-e-3' }, { id: 'gpt-3.5-turbo-instruct' }] }); };
  const r = await md.runDiscovery();
  assert.deepStrictEqual(r.lmstudio, ['qwen3-8b', 'text-embedding-nomic']);
  assert.deepStrictEqual(r.ollama, ['llama3:8b']);
  assert.deepStrictEqual(r.omlx, []);
  assert.deepStrictEqual(r.openai, ['gpt-5', 'gpt-5.6-sol', 'gpt-4o', 'o3', 'o4-mini']);
  assert.strictEqual(st.fetches.find(f => f.url.includes('lmstudio')).init.headers.Authorization, 'Bearer lm-studio');
  assert.deepStrictEqual(md.getDiscoveredModels(), ['openai/gpt-5', 'openai/gpt-5.6-sol', 'openai/gpt-4o', 'openai/o3', 'openai/o4-mini',
    'lmstudio/qwen3-8b', 'lmstudio/text-embedding-nomic', 'ollama/llama3:8b']);
});

test('Google and Perplexity shapes: generateContent-capable gemini models only; perplexity falls back to sonar list', async () => {
  st.keys = { google: 'g-key', perplexity: 'p-key' };
  st.routes['generativelanguage.googleapis.com'] = (u) => { assert.ok(u.endsWith('?key=g-key')); return json(200, { models: [
    { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/aqa', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.1-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] }] }); };
  st.routes['api.perplexity.ai'] = 404;
  let r = await md.runDiscovery();
  assert.deepStrictEqual(r.google, ['gemini-2.5-pro', 'gemini-3.1-flash']);
  assert.deepStrictEqual(r.perplexity, ['sonar-pro', 'sonar'], 'fallback when the listing fails');
  st.routes['api.perplexity.ai'] = { models: ['sonar-reasoning', { id: 'sonar-deep' }, {}] };
  r = await md.runDiscovery();
  assert.deepStrictEqual(r.perplexity, ['sonar-reasoning', 'sonar-deep']);
  assert.deepStrictEqual(md.getDiscoveredModels().filter(m => /google|perplexity/.test(m)), ['google/gemini-2.5-pro', 'google/gemini-3.1-flash', 'perplexity/sonar-reasoning', 'perplexity/sonar-deep']);
});

test('Anthropic API key: /v1/models list is authoritative; on HTTP failure every candidate is probed via /v1/messages', async () => {
  st.keys = { anthropic: 'sk-ant' };
  st.routes['api.anthropic.com/v1/models'] = (u, init) => { assert.strictEqual(init.headers['x-api-key'], 'sk-ant'); return json(200, { data: [{ id: 'claude-opus-5' }, { id: 'claude-haiku-4-5' }] }); };
  let r = await md.runDiscovery();
  assert.deepStrictEqual(r.anthropic, ['claude-opus-5', 'claude-haiku-4-5']);
  assert.strictEqual(urls().filter(u => u.includes('/v1/messages')).length, 0);
  st.routes['api.anthropic.com/v1/models'] = 500;
  st.routes['api.anthropic.com/v1/messages'] = (u, init) => {
    const m = JSON.parse(init.body).model;
    assert.strictEqual(JSON.parse(init.body).max_tokens, 1);
    if (m === 'claude-opus-5') return json(200, {});
    if (m === 'claude-sonnet-5') return json(529, { error: { type: 'overloaded_error' } });
    if (m === 'claude-haiku-5') return json(429, { error: { type: 'rate_limit_error' } });
    if (m === 'claude-fable-5') return json(400, { error: { type: 'invalid_request_error', message: 'model: claude-fable-5 not found' } });
    return json(404, { error: { type: 'not_found_error' } });
  };
  r = await md.runDiscovery();
  assert.deepStrictEqual(r.anthropic, ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5'], '200, 529 and 429 count as existing');
  assert.strictEqual(urls().filter(u => u.includes('/v1/messages')).length, md.ANTHROPIC_CANDIDATES.length);
});

test('Claude SDK: aliases from supportedModels + paginated OAuth /v1/models, deduplicated, with -info records', async () => {
  st.sdkCreds = true; st.token = 'oauth-tok';
  st.aliases = [{ value: 'default', displayName: 'Default', description: 'latest' }, { value: 'claude-opus-5' }];
  st.routes['api.anthropic.com/v1/models'] = (u, init) => {
    assert.strictEqual(init.headers.Authorization, 'Bearer oauth-tok'); assert.strictEqual(init.headers['anthropic-beta'], 'oauth-2025-04-20');
    const q = new URL(u).searchParams; assert.strictEqual(q.get('limit'), '1000');
    return q.get('after_id') ? json(200, { data: [{ id: 'claude-haiku-4-5' }], has_more: false })
                             : json(200, { data: [{ id: 'claude-opus-5', display_name: 'Claude Opus 5' }, { id: 'claude-sonnet-5' }], has_more: true, last_id: 'claude-sonnet-5' });
  };
  const r = await md.runDiscovery();
  assert.deepStrictEqual(r['claude-sdk'], ['default', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
  assert.deepStrictEqual(r['claude-sdk-info'], [
    { id: 'default', displayName: 'Default', description: 'latest' }, { id: 'claude-opus-5', displayName: 'claude-opus-5', description: '' },
    { id: 'claude-sonnet-5', displayName: 'sonnet-5', description: 'Listed by Anthropic /v1/models' },
    { id: 'claude-haiku-4-5', displayName: 'haiku-4-5', description: 'Listed by Anthropic /v1/models' }]);
  assert.strictEqual(urls().filter(u => u.includes('after_id=claude-sonnet-5')).length, 1);
  assert.deepStrictEqual(r.anthropic, [], 'no API key -> no anthropic/ entries');
  assert.ok(md.getDiscoveredModels().includes('claude-sdk/default'));
});

test('Codex CLI: ids from discoverModels become codex-cli/<id>, -info kept; a throwing discoverModels is non-fatal', async () => {
  st.codex = [{ id: 'gpt-6-astra', display: 'GPT-6 Astra', description: '', contextWindow: 400000 }, { id: 'gpt-5.6-sol' }];
  let r = await md.runDiscovery();
  assert.deepStrictEqual(r['codex-cli'], ['gpt-6-astra', 'gpt-5.6-sol']);
  assert.deepStrictEqual(r['codex-cli-info'], st.codex);
  assert.deepStrictEqual(md.getDiscoveredModels(), ['codex-cli/gpt-6-astra', 'codex-cli/gpt-5.6-sol']);
  st.codex = new Error('codex binary missing');
  r = await md.runDiscovery();
  assert.deepStrictEqual(r['codex-cli'], []);
  assert.match(r.discoveredAt, /T/, 'run still completes');
});

test('Claude SDK fallback: /v1/models down -> probe candidates plus models configured in agents.json; no aliases -> []', async () => {
  st.sdkCreds = true; st.token = 'oauth-tok';
  st.aliases = [{ value: 'sonnet' }];
  st.routes['api.anthropic.com/v1/models'] = 503;
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'agents.json'), JSON.stringify([{ name: 'a', model: 'claude-sdk/claude-custom-9' }, { name: 'b', model: 'openai/gpt-5' }, { name: 'c', model: 'claude-sdk/sonnet' }, { name: 'd' }]));
  const probed = []; st.probeOk = (m) => { probed.push(m); return m === 'claude-opus-5' || m === 'claude-custom-9'; };
  let r = await md.runDiscovery();
  assert.deepStrictEqual(r['claude-sdk'], ['sonnet', 'claude-opus-5', 'claude-custom-9']);
  assert.strictEqual(r['claude-sdk-info'][2].description, 'Validated via SDK probe (fallback)');
  assert.deepStrictEqual([...new Set(probed)].sort(), [...md.ANTHROPIC_CANDIDATES, 'claude-custom-9'].sort(), 'configured model probed, alias not re-probed');
  st.aliases = [];
  r = await md.runDiscovery();
  assert.deepStrictEqual(r['claude-sdk'], [], 'SDK itself unusable -> bail without probing');
  st.sdkCreds = false; st.aliases = [{ value: 'sonnet' }];
  r = await md.runDiscovery();
  assert.deepStrictEqual(r['claude-sdk'], [], 'no credentials -> SDK path skipped entirely');
  assert.strictEqual('claude-sdk-info' in r, false);
});

test('runDiscovery re-entrancy: a second call while one runs JOINS that run (same fresh result, one probe), never the stale cache', async () => {
  fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify({ lmstudio: ['cached-one'] }));
  let release; st.routes['lmstudio.test'] = () => new Promise(r => { release = () => r(json(200, { data: [{ id: 'fresh' }] })); });
  const first = md.runDiscovery();
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(md.isDiscovering(), true);
  const second = md.runDiscovery();
  assert.strictEqual(second, first, 'the very same promise');
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepStrictEqual(a.lmstudio, ['fresh']);
  assert.strictEqual(b, a);
  assert.strictEqual(md.isDiscovering(), false);
  assert.strictEqual(urls().filter(u => u.includes('lmstudio')).length, 1, 'one probe for both callers');
});

test('startDiscovery runs immediately and schedules a 6 h interval; stopDiscovery clears it', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const runs = () => urls().filter(u => u.includes('lmstudio')).length;
  const base = st.invalidated;
  md.startDiscovery();
  await until(() => st.invalidated === base + 1);                   // first run finished (cache written + invalidated)
  assert.strictEqual(runs(), 1);
  t.mock.timers.tick(6 * 60 * 60 * 1000);
  await until(() => st.invalidated === base + 2);
  assert.strictEqual(runs(), 2);
  md.stopDiscovery();
  t.mock.timers.tick(6 * 60 * 60 * 1000);
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(runs(), 2, 'no run after stopDiscovery');
  assert.strictEqual(st.invalidated, base + 2);
});
