'use strict';

/**
 * model-discovery.js — Automated model discovery across all providers.
 *
 * Runs on startup + every 6 hours. Probes each provider for available models
 * and caches results to data/discovered-models.json. For providers without
 * listing endpoints (Anthropic/Claude SDK), probes candidate model names
 * with minimal test requests.
 */

const fs = require('fs');
const path = require('path');
const { loadSdk, cliOptions } = require('./sdk-loader');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'discovered-models.json');
const DISCOVERY_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
let _discoveryTimer = null;
let _discovering = false;
let _inflight = null;   // the promise of the run in progress, shared with every caller that arrives meanwhile

// Candidate Anthropic model patterns to probe.
// Add new families/versions here — they'll be auto-tested.
const ANTHROPIC_CANDIDATES = [
  // Current generation (Claude 5.x — no minor suffix)
  'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5',
  'claude-fable-5',
  // Previous generation (Claude 4.x — major-minor format)
  'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5',
  'claude-sonnet-4-6', 'claude-sonnet-4-5',
  'claude-haiku-4-5', 'claude-haiku-3-5',
  // Future-proofing
  'claude-fable-6', 'claude-fable-7',
  'claude-opus-5-1', 'claude-opus-6',
  'claude-sonnet-5-1', 'claude-sonnet-6',
  'claude-haiku-5-1', 'claude-haiku-6',
];

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch {}
  return null;
}

function saveCache(data) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[model-discovery] Failed to save cache:', e.message);
  }
  // Lazy require: gateway-client lazily requires this module too.
  try { require('./gateway-client').invalidateModelsCache(); } catch { /* not loaded */ }
}

function getProviderConfig() {
  const settings = require('./settings');
  return {
    anthropicKey: settings.getProviderKey('anthropic'),
    openaiKey: settings.getProviderKey('openai'),
    geminiKey: settings.getProviderKey('google'),
    perplexityKey: settings.getProviderKey('perplexity'),
    openrouterKey: settings.getProviderKey('openrouter'),
    lmStudioUrl: settings.getProviderUrl('lmstudio'),
    ollamaUrl: settings.getProviderUrl('ollama'),
    omlxUrl: settings.getProviderUrl('omlx'),
    ninferUrl: settings.getProviderUrl('ninfer'),
    localUrl: settings.getProviderUrl('local'),
  };
}

// ── Provider discovery functions ────────────────────────────────────────

async function discoverOpenAICompat(name, baseUrl, opts = {}) {
  const { apiKey, filter, timeout = 3000 } = opts;
  const models = [];
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const resp = await fetch(`${baseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(timeout),
    });
    if (resp.ok) {
      const data = await resp.json();
      for (const m of (data.data || [])) {
        if (filter && !filter(m.id)) continue;
        models.push(m.id);
      }
    }
  } catch {}
  return models;
}

async function discoverGemini(apiKey) {
  const models = [];
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (resp.ok) {
      const data = await resp.json();
      for (const m of (data.models || [])) {
        if (m.supportedGenerationMethods?.includes('generateContent')) {
          const id = m.name.replace('models/', '');
          if (/gemini/i.test(id)) models.push(id);
        }
      }
    }
  } catch {}
  return models;
}

async function discoverPerplexity(apiKey) {
  const models = [];
  try {
    const resp = await fetch('https://api.perplexity.ai/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const data = await resp.json();
      for (const m of (data.data || data.models || [])) {
        const id = typeof m === 'string' ? m : m.id;
        if (id) models.push(id);
      }
    }
  } catch {}
  // Fallback: always include known models
  if (models.length === 0) {
    models.push('sonar-pro', 'sonar');
  }
  return models;
}

async function probeAnthropicModel(modelId, apiKey) {
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(10000),
    });
    // 200 = works, 529 = overloaded (but exists), 400 with "model" = doesn't exist
    if (resp.ok) return true;
    if (resp.status === 529) return true;
    const body = await resp.json().catch(() => ({}));
    if (body.error?.type === 'not_found_error') return false;
    if (body.error?.message?.includes('not found')) return false;
    // Rate limit, auth error, etc. — model likely exists but we can't test
    if (resp.status === 429 || resp.status === 401) return true;
    return false;
  } catch {
    return false;
  }
}

async function probeSdkModel(modelId) {
  try {
    const sdk = await loadSdk();
    const q = sdk.query({
      prompt: 'Reply: OK',
      options: {
        model: modelId,
        maxTurns: 1,
        permissionMode: 'acceptEdits',
        tools: [],
        ...cliOptions(),
      },
    });
    for await (const msg of q) {
      // Only the final result is trustworthy. The SDK emits assistant
      // messages even for nonexistent models, and the result subtype can be
      // 'success' while is_error=true. Check is_error and the result text.
      if (msg.type === 'result') {
        if (msg.is_error) return false;
        const text = msg.result || msg.text || '';
        if (/issue with the selected model|may not exist|not have access/i.test(text)) return false;
        return true;
      }
    }
    return false; // stream ended with no result — treat as unavailable
  } catch (e) {
    const msg = e.message || '';
    // Model doesn't exist
    if (/not found|invalid model|unknown model/i.test(msg)) return false;
    // Auth issues — don't assume model exists
    if (/auth|unauthorized|forbidden|credential|token|login|funding/i.test(msg)) {
      console.log(`[model-discovery]   ⚠ SDK auth issue: ${msg.slice(0, 80)}`);
      return false;
    }
    // Rate limit — model probably exists
    if (/rate.?limit|429/i.test(msg)) return true;
    // Unknown error — log it and assume false to be safe
    console.log(`[model-discovery]   ⚠ SDK probe error for ${modelId}: ${msg.slice(0, 80)}`);
    return false;
  }
}

// Credential detection lives in lib/claude-auth.js — see the note there on
// why this must not be a bare check for the Linux credentials file.
const { getOauthToken, hasSdkCredentials: sdkMightBeAvailable } = require('./claude-auth');

/**
 * Ask the SDK what models it supports — the authoritative, sustainable source.
 * Returns [{ id, displayName, description }]. The ids are SDK aliases
 * ("default", "sonnet", "haiku", ...) that always resolve to the current
 * version of each family, so this never goes stale when new models ship.
 * Full model IDs (e.g. "claude-opus-4-8") also remain valid in agent configs.
 */
async function fetchSdkSupportedModels() {
  let q = null;
  try {
    const sdk = await loadSdk();
    // Open a control-channel-only query: the prompt generator never yields,
    // so no turn is consumed — we just ask the SDK for its model list.
    q = sdk.query({
      prompt: (async function* () { await new Promise(r => setTimeout(r, 30000)); })(),
      options: { maxTurns: 1, permissionMode: 'acceptEdits', tools: [], ...cliOptions() },
    });
    const models = await q.supportedModels();
    return models.map(m => ({
      id: m.value,
      displayName: m.displayName || m.value,
      description: m.description || '',
    }));
  } catch (e) {
    console.log(`[model-discovery] SDK supportedModels failed: ${e.message?.slice(0, 100)}`);
    return [];
  } finally {
    try { q?.close(); } catch {}
  }
}

/**
 * THE authoritative model list: Anthropic's GET /v1/models endpoint.
 *
 * Works with the Claude Code OAuth token — no API key required. This returns
 * every model the account can actually use, by its real ID. Nothing is
 * hardcoded or guessed, so new releases appear automatically the moment
 * Anthropic ships them.
 */
async function fetchModelsFromApi(token) {
  if (!token) return [];
  const models = [];
  let afterId = null;
  try {
    // Paginate — the endpoint caps at 1000 per page.
    for (let page = 0; page < 10; page++) {
      const url = new URL('https://api.anthropic.com/v1/models');
      url.searchParams.set('limit', '1000');
      if (afterId) url.searchParams.set('after_id', afterId);

      const resp = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) {
        console.log(`[model-discovery] /v1/models returned HTTP ${resp.status}`);
        return models;
      }
      const data = await resp.json();
      for (const m of (data.data || [])) {
        models.push({
          id: m.id,
          displayName: m.display_name || m.id.replace(/^claude-/, ''),
          description: 'Listed by Anthropic /v1/models',
        });
      }
      if (!data.has_more) break;
      afterId = data.last_id;
    }
  } catch (e) {
    console.log(`[model-discovery] /v1/models failed: ${e.message?.slice(0, 100)}`);
  }
  return models;
}

/** Model IDs of claude-sdk agents currently configured in agents.json. */
function getConfiguredSdkModels() {
  try {
    const agents = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'agents.json'), 'utf8'));
    return [...new Set(
      agents.map(a => a.model || '')
        .filter(m => m.startsWith('claude-sdk/'))
        .map(m => m.replace('claude-sdk/', ''))
    )];
  } catch {
    return [];
  }
}

/** Run promise-returning tasks with bounded concurrency. */
async function withConcurrency(items, limit, fn) {
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }));
  return results;
}

/**
 * Full SDK discovery — query, never guess.
 *
 * 1. GET /v1/models (via the OAuth token) is THE authoritative source: every
 *    real model ID the account can use. New releases show up automatically.
 * 2. supportedModels() adds the SDK's convenience aliases (default/sonnet/
 *    haiku) that always track the newest version of each family.
 * 3. Name-probing is a LAST RESORT, used only if the endpoint is unreachable
 *    (offline, token expired). It relies on a hardcoded guess list and is the
 *    reason models have been missed before — never the primary path.
 */
async function discoverSdkModels() {
  const aliases = await fetchSdkSupportedModels();

  // Primary: the real model list, straight from Anthropic.
  const token = getOauthToken();
  const listed = await fetchModelsFromApi(token);

  if (listed.length > 0) {
    console.log(`[model-discovery] /v1/models returned ${listed.length} models (authoritative)`);
    // Aliases first (they're the "always latest" picks), then real IDs.
    const seen = new Set(aliases.map(a => a.id));
    return [...aliases, ...listed.filter(m => !seen.has(m.id))];
  }

  // ── Fallback only: endpoint unreachable, probe the guess list ──
  if (aliases.length === 0) return []; // SDK not working either — bail
  console.log('[model-discovery] /v1/models unavailable — falling back to name probing');

  const extras = new Set(ANTHROPIC_CANDIDATES);
  for (const m of getConfiguredSdkModels()) {
    if (!aliases.some(a => a.id === m)) extras.add(m);
  }

  const list = [...extras];
  const outcomes = await withConcurrency(list, 4, async (m) => ({ m, ok: await probeSdkModel(m) }));
  const validated = outcomes.filter(o => o.ok).map(o => ({
    id: o.m,
    displayName: o.m.replace(/^claude-/, ''),
    description: 'Validated via SDK probe (fallback)',
  }));
  for (const o of outcomes) {
    console.log(`[model-discovery]   ${o.ok ? '✓' : '✗'} ${o.m}`);
  }

  return [...aliases, ...validated];
}

async function discoverAnthropic(apiKey) {
  if (!apiKey) return []; // SDK path handles the no-API-key case separately

  // Authoritative: ask Anthropic for the list rather than guessing names.
  try {
    const resp = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) {
      const data = await resp.json();
      const ids = (data.data || []).map(m => m.id);
      console.log(`[model-discovery] Anthropic /v1/models: ${ids.length} models`);
      return ids;
    }
    console.log(`[model-discovery] Anthropic /v1/models HTTP ${resp.status} — falling back to probing`);
  } catch (e) {
    console.log(`[model-discovery] Anthropic /v1/models failed: ${e.message?.slice(0, 80)} — falling back to probing`);
  }

  // Fallback only: endpoint unreachable, probe the guess list.
  const models = [];
  for (const candidate of ANTHROPIC_CANDIDATES) {
    if (await probeAnthropicModel(candidate, apiKey)) models.push(candidate);
  }
  return models;
}

// ── Main discovery runner ───────────────────────────────────────────────

function runDiscovery() {   // not `async`: callers must get the very same promise, not a fresh wrapper
  // A second caller while a run is in flight joins that run instead of getting the OLD cache back: a
  // page that asked for models during startup discovery used to be handed the stale or missing list.
  if (_inflight) {
    console.log('[model-discovery] Already running, joining the run in progress');
    return _inflight;
  }
  _inflight = _runDiscovery().finally(() => { _inflight = null; });
  return _inflight;
}
/** True while a discovery run is in progress (reported by /api/models so pages can say "rebuilding"). */
function isDiscovering() { return !!_inflight; }
async function _runDiscovery() {
  _discovering = true;
  console.log('[model-discovery] Starting model discovery across all providers...');
  const startTime = Date.now();

  const config = getProviderConfig();
  const result = {
    anthropic: [],
    'claude-sdk': [],
    'codex-cli': [],
    openai: [],
    google: [],
    perplexity: [],
    openrouter: [],
    lmstudio: [],
    ollama: [],
    omlx: [],
    ninfer: [],
    local: [],
    discoveredAt: new Date().toISOString(),
    durationMs: 0,
  };

  // Run independent providers in parallel
  const [lmstudio, ollama, omlx, openai, gemini, perplexity, ninfer, local] = await Promise.all([
    discoverOpenAICompat('lmstudio', config.lmStudioUrl, { apiKey: 'lm-studio' }),
    discoverOpenAICompat('ollama', config.ollamaUrl, { apiKey: 'ollama' }),
    discoverOpenAICompat('omlx', config.omlxUrl, { apiKey: 'omlx' }),
    config.openaiKey
      ? discoverOpenAICompat('openai', 'https://api.openai.com/v1', {
          apiKey: config.openaiKey,
          filter: id => /^(gpt-[345]|gpt-[345]\.|gpt-4o|o[134])/i.test(id) &&
            !/audio|realtime|transcribe|tts|instruct|codex|image|search-api|whisper|translate/i.test(id),
          timeout: 5000,
        })
      : Promise.resolve([]),
    config.geminiKey
      ? discoverGemini(config.geminiKey)
      : Promise.resolve([]),
    config.perplexityKey
      ? discoverPerplexity(config.perplexityKey)
      : Promise.resolve([]),
    discoverOpenAICompat('ninfer', config.ninferUrl, { apiKey: 'ninfer' }),
    discoverOpenAICompat('local', config.localUrl, { apiKey: 'local' }),
  ]);

  result.lmstudio = lmstudio;
  result.ollama = ollama;
  result.omlx = omlx;
  result.ninfer = ninfer;
  result.local = local;
  result.openai = openai;
  result.google = gemini;
  result.perplexity = perplexity;

  // Codex prefix removed — it was a duplicate of OpenAI models using the same endpoint/key

  // OpenRouter: only the models the owner offers (or the default offer) from its public catalogue, and only with a key.
  if (config.openrouterKey) {
    try {
      const or = require('./openrouter').getOpenRouter();
      await or.refresh();
      result.openrouter = or.chosen();
    } catch (e) { console.log(`[model-discovery] OpenRouter skipped: ${e.message}`); }
  }

  // Anthropic API probing (only when an API key is configured)
  result.anthropic = await discoverAnthropic(config.anthropicKey);

  // Claude SDK: ask the SDK directly for its supported models (authoritative)
  if (sdkMightBeAvailable()) {
    const sdkModels = await discoverSdkModels();
    result['claude-sdk'] = sdkModels.map(m => m.id);
    result['claude-sdk-info'] = sdkModels; // display names + descriptions for the UI
    console.log(`[model-discovery] SDK reports ${sdkModels.length} models: ${sdkModels.map(m => m.id).join(', ')}`);
  }

  // Codex CLI: OpenAI models on the owner's ChatGPT subscription (only when the CLI is installed and logged in)
  try {
    const codexModels = await require('./codex-cli').discoverModels();
    result['codex-cli'] = codexModels.map(m => m.id);
    result['codex-cli-info'] = codexModels;
    if (codexModels.length) console.log(`[model-discovery] Codex CLI (subscription) reports ${codexModels.length} models: ${codexModels.map(m => m.id).join(', ')}`);
  } catch (e) {
    console.log(`[model-discovery] Codex CLI discovery skipped: ${e.message}`);
  }

  result.durationMs = Date.now() - startTime;

  const totalCount = Object.entries(result)
    .filter(([k, v]) => Array.isArray(v) && !k.endsWith('-info'))
    .reduce((sum, [, arr]) => sum + arr.length, 0);

  console.log(`[model-discovery] Complete: ${totalCount} models found in ${result.durationMs}ms`);
  console.log(`[model-discovery]   claude-sdk: ${(result['claude-sdk'] || []).length}, codex-cli: ${result['codex-cli'].length}, anthropic: ${result.anthropic.length}, openai: ${result.openai.length}, google: ${result.google.length}, perplexity: ${result.perplexity.length}, openrouter: ${(result.openrouter || []).length}, lmstudio: ${result.lmstudio.length}, ollama: ${result.ollama.length}, omlx: ${result.omlx.length}, ninfer: ${(result.ninfer || []).length}`);

  saveCache(result);
  _discovering = false;
  return result;
}

/**
 * Get the flat list of all discovered models (prefixed with provider).
 * Falls back to cache, then to empty array.
 */
function getDiscoveredModels() {
  const cache = loadCache();
  if (!cache) return [];

  const models = [];
  for (const m of (cache.anthropic || [])) models.push(`anthropic/${m}`);
  for (const m of (cache['claude-sdk'] || [])) models.push(`claude-sdk/${m}`);
  for (const m of (cache['codex-cli'] || [])) models.push(`codex-cli/${m}`);
  for (const m of (cache.openai || [])) models.push(`openai/${m}`);
  for (const m of (cache.google || [])) models.push(`google/${m}`);
  for (const m of (cache.perplexity || [])) models.push(`perplexity/${m}`);
  for (const m of (cache.openrouter || [])) models.push(`openrouter/${m}`);
  for (const m of (cache.lmstudio || [])) models.push(`lmstudio/${m}`);
  for (const m of (cache.ollama || [])) models.push(`ollama/${m}`);
  for (const m of (cache.omlx || [])) models.push(`omlx/${m}`);
  for (const m of (cache.ninfer || [])) models.push(`ninfer/${m}`);
  for (const m of (cache.local || [])) models.push(`local/${m}`);
  return models;
}

/**
 * Start periodic discovery. Call once at server startup.
 */
function startDiscovery() {
  // Run immediately (async, non-blocking)
  runDiscovery().catch(e => console.error('[model-discovery] Initial run failed:', e.message));

  // Schedule periodic runs
  _discoveryTimer = setInterval(() => {
    runDiscovery().catch(e => console.error('[model-discovery] Periodic run failed:', e.message));
  }, DISCOVERY_INTERVAL);

  console.log('[model-discovery] Scheduled every 6 hours');
}

function stopDiscovery() {
  if (_discoveryTimer) {
    clearInterval(_discoveryTimer);
    _discoveryTimer = null;
  }
}

module.exports = {
  runDiscovery,
  isDiscovering,
  getDiscoveredModels,
  startDiscovery,
  stopDiscovery,
  loadCache,
  ANTHROPIC_CANDIDATES,
};
