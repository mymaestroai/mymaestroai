'use strict';
/**
 * OpenRouter (openrouter.ai): one API key for hundreds of models from many vendors, spoken in the OpenAI
 * chat-completions dialect, so it runs on the gateway path like OpenAI and Gemini (same tools, memory, policy).
 * Model ids are `openrouter/<vendor>/<model>`; the hub splits a model id at its first slash, so the provider is
 * `openrouter` and OpenRouter receives `<vendor>/<model>`.
 *
 * This module keeps:
 *  - the catalogue: GET https://openrouter.ai/api/v1/models (public, no key), cached in data/openrouter-models.json
 *    for 12 hours, reduced to what the hub uses per model (window, prices, tools, reasoning, images, max output);
 *  - which models the pickers offer: settings.openrouter.models (ids without the prefix), or, until the owner
 *    chooses, the newest tool-capable model of each vendor the hub cannot reach with a key of its own;
 *  - the privacy default: settings.openrouter.privacy !== false sends provider.data_collection 'deny' (OpenRouter
 *    then only uses providers that do not store or train on prompts);
 *  - the key check: GET /api/v1/key (account details, free: never spends).
 * Batch-only variants (`:batch`) are left out: they do not answer a chat.
 */
const fs = require('fs');
const path = require('path');

const BASE = 'https://openrouter.ai/api/v1';
const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'openrouter-models.json');
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
// Sent with every request: OpenRouter's app attribution (the product, never this machine or its owner).
const ATTRIBUTION = { 'HTTP-Referer': 'https://www.mymaestroai.ai', 'X-Title': 'My Maestro AI' };
// Vendors offered by default (their newest tool-capable model each). Anthropic, OpenAI and Google are added only
// when the hub has no key of its own for them; with a key their direct API is cheaper and has the hub's cache rules.
const DEFAULT_VENDORS = ['x-ai', 'deepseek', 'moonshotai', 'qwen', 'mistralai', 'z-ai', 'meta-llama', 'minimax'];
const DIRECT_VENDORS = { anthropic: 'anthropic', openai: 'openai', google: 'google' };   // vendor -> hub provider

function createOpenRouter({
  file = DEFAULT_FILE,
  fetchImpl = (...a) => fetch(...a),
  now = Date.now,
  settings = () => require('./settings'),
  log = (...a) => console.log('[openrouter]', ...a),
} = {}) {
  let mem = null;

  function compact(m) {
    const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
    const arch = m.architecture || {};
    const price = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
    return {
      id: String(m.id),
      name: String(m.name || m.id),
      created: Number(m.created) || 0,
      context: Number(m.context_length) || Number(m.top_provider && m.top_provider.context_length) || null,
      maxOut: Number(m.top_provider && m.top_provider.max_completion_tokens) || null,
      prompt: price(m.pricing && m.pricing.prompt),               // USD per token
      completion: price(m.pricing && m.pricing.completion),
      cacheRead: price(m.pricing && m.pricing.input_cache_read),
      tools: params.includes('tools'),
      reasoning: params.includes('reasoning') || params.includes('include_reasoning'),
      images: Array.isArray(arch.input_modalities) && arch.input_modalities.includes('image'),
    };
  }

  function read() {
    if (mem) return mem;
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && Array.isArray(j.models)) mem = j; } catch { /* none yet */ }
    return mem || { fetchedAt: null, models: [] };
  }
  function write(models) {
    mem = { fetchedAt: new Date(now()).toISOString(), models };
    try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify(mem), { mode: 0o600 }); } catch (e) { log(`could not save the catalogue: ${e.message}`); }
    return mem;
  }

  /** Fetch the catalogue when it is missing or older than 12 hours (force: always). Never throws. */
  async function refresh({ force = false } = {}) {
    const cur = read();
    if (!force && cur.fetchedAt && now() - Date.parse(cur.fetchedAt) < MAX_AGE_MS && cur.models.length) return cur;
    try {
      const r = await fetchImpl(`${BASE}/models`, { headers: { ...ATTRIBUTION }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) { log(`catalogue: HTTP ${r.status}`); return cur; }
      const j = await r.json();
      const models = ((j && j.data) || []).filter(m => m && m.id && !String(m.id).includes(':batch')).map(compact);
      log(`catalogue: ${models.length} models (${models.filter(m => m.tools).length} with tool calling)`);
      return write(models);
    } catch (e) { log(`catalogue fetch failed: ${e.message}`); return cur; }
  }

  const catalog = () => read().models;
  const strip = (id) => String(id || '').replace(/^openrouter\//i, '');
  /** info('openrouter/x-ai/grok-4.7' or 'x-ai/grok-4.7') -> the catalogue record, or null. */
  function info(id) { const k = strip(id); return catalog().find(m => m.id === k) || null; }

  function cfg() { let s = {}; try { s = settings().get().openrouter || {}; } catch { /* no settings */ } return s; }
  const hasKey = () => { try { return !!settings().getProviderKey('openrouter'); } catch { return false; } };

  /** The default offer: the newest tool-capable chat model of each vendor in the list (no `:free` or other variants). */
  function defaultPicks(list = catalog()) {
    let haveDirect = {};
    try { const s = settings(); haveDirect = Object.fromEntries(Object.values(DIRECT_VENDORS).map(p => [p, !!s.getProviderKey(p)])); } catch { /* none */ }
    const vendors = [...DEFAULT_VENDORS, ...Object.keys(DIRECT_VENDORS).filter(v => !haveDirect[DIRECT_VENDORS[v]])];
    const picks = [];
    const dated = (id) => /-\d{4}$|-\d{6,8}$|-\d{4}-\d{2}-\d{2}$/.test(id);   // a snapshot (…-1017, …-20261017) when an alias exists
    for (const v of vendors) {
      const all = list.filter(m => m.tools && m.id.startsWith(`${v}/`) && !m.id.includes(':'));
      const plain = all.filter(m => !dated(m.id));
      const best = (plain.length ? plain : all).sort((a, b) => b.created - a.created)[0];
      if (best) picks.push(best.id);
    }
    return picks;
  }

  /** The ids the pickers offer (without the openrouter/ prefix): the owner's choice, or the default offer. */
  function chosen() {
    const c = cfg();
    const list = catalog();
    if (Array.isArray(c.models)) { const known = new Set(list.map(m => m.id)); return c.models.filter(id => !list.length || known.has(id)); }
    return defaultPicks(list);
  }

  const privacyOn = () => cfg().privacy !== false;

  /**
   * Free key check: GET /api/v1/key returns the key's label and credit limit without spending anything.
   * -> { ok, label, limit, usage, remaining, freeTier } | { ok: false, status, error }
   */
  async function checkKey(key) {
    const k = String(key || '').trim();
    if (!k) return { ok: false, error: 'No OpenRouter key.' };
    try {
      const r = await fetchImpl(`${BASE}/key`, { headers: { Authorization: `Bearer ${k}`, ...ATTRIBUTION }, signal: AbortSignal.timeout(10000) });
      if (r.status === 401 || r.status === 403) return { ok: false, status: r.status, error: 'OpenRouter refused this key. Check that you copied all of it and that it is not disabled.' };
      if (!r.ok) return { ok: false, status: r.status, error: `OpenRouter answered with an error (HTTP ${r.status}). Try again in a minute.` };
      const d = ((await r.json()) || {}).data || {};
      return { ok: true, label: d.label || null, limit: d.limit ?? null, usage: d.usage ?? null, remaining: d.limit_remaining ?? null, freeTier: !!d.is_free_tier };
    } catch (e) { return { ok: false, error: 'Could not reach OpenRouter. Check this computer\'s internet connection.', detail: e.message }; }
  }

  /**
   * What an OpenRouter chat request adds (gateway-client, OpenAI-compatible path), applied after the effort level:
   *  - usage.include: the call's cost comes back in the last usage chunk (the ledger books it as reported);
   *  - provider.data_collection 'deny' unless the owner turned privacy off;
   *  - reasoning effort in OpenRouter's form ({ reasoning: { effort } } instead of reasoning_effort);
   *  - max_tokens kept within the model's own output limit;
   *  - Claude models: cache breakpoints (OpenRouter passes cache_control through; without them every call pays the
   *    full input price): the system message (tools and system are cached together) and the latest user message.
   */
  function requestExtras(body, modelId, { cache = true, cacheTtl = '5m' } = {}) {
    body.usage = { include: true };
    if (privacyOn()) body.provider = { ...(body.provider || {}), data_collection: 'deny' };
    if (body.reasoning_effort) { body.reasoning = { ...(body.reasoning || {}), effort: body.reasoning_effort }; delete body.reasoning_effort; }
    const m = info(modelId);
    if (m && m.maxOut && Number(body.max_tokens) > m.maxOut) body.max_tokens = m.maxOut;
    if (cache && /^anthropic\//i.test(strip(modelId)) && Array.isArray(body.messages)) {
      const mark = cacheTtl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
      const marked = (content) => {
        if (typeof content === 'string') return content ? [{ type: 'text', text: content, cache_control: mark }] : content;
        if (!Array.isArray(content) || !content.length) return content;
        let i = -1;
        for (let j = content.length - 1; j >= 0; j--) if (content[j] && content[j].type === 'text') { i = j; break; }
        return i < 0 ? content : content.map((p, j) => (j === i ? { ...p, cache_control: mark } : p));
      };
      const sys = body.messages.findIndex(x => x && x.role === 'system');
      if (sys >= 0) body.messages[sys] = { ...body.messages[sys], content: marked(body.messages[sys].content) };
      for (let j = body.messages.length - 1; j >= 0; j--) {
        if (body.messages[j] && body.messages[j].role === 'user') { body.messages[j] = { ...body.messages[j], content: marked(body.messages[j].content) }; break; }
      }
    }
    return body;
  }

  /** Price per million tokens [input, output] for the ledger's estimate when a call reported no cost. */
  function pricePerMillion(id) {
    const m = info(id);
    if (!m || m.prompt == null || m.completion == null) return null;
    return [m.prompt * 1e6, m.completion * 1e6];
  }

  /** For the Settings box: the catalogue (tool-capable models first), the current offer and the switches. */
  function view() {
    const list = catalog();
    const offer = chosen();
    return {
      hasKey: hasKey(),
      fetchedAt: read().fetchedAt,
      privacy: privacyOn(),
      custom: Array.isArray(cfg().models),
      chosen: offer,
      defaults: defaultPicks(list),
      models: list.map(m => ({ id: m.id, name: m.name, created: m.created, context: m.context, prompt: m.prompt, completion: m.completion, tools: m.tools, reasoning: m.reasoning, images: m.images })),
    };
  }

  return { BASE, ATTRIBUTION, refresh, catalog, info, chosen, defaultPicks, privacyOn, checkKey, requestExtras, pricePerMillion, view, compact, _reset: () => { mem = null; } };
}

let instance = null;
function getOpenRouter() { return instance || (instance = createOpenRouter()); }

/** settings.openrouter as the Settings box writes it: { models: [ids] | null (= the default offer), privacy }. */
function cleanOpenRouterSettings(v) {
  const out = {};
  if (v && typeof v === 'object') {
    // A leading ~ is OpenRouter's "latest" alias (~x-ai/grok-latest follows the vendor's newest model).
    if (Array.isArray(v.models)) out.models = [...new Set(v.models.map(String).filter(id => /^~?[\w.\-]+\/[\w.\-:]+$/.test(id) && id.length <= 120))].slice(0, 200);
    else if (v.models === null) out.models = null;
    if (v.privacy !== undefined) out.privacy = ![false, 0, null, '', 'false', 'off', '0'].includes(v.privacy);   // off only when clearly off
  }
  return out;
}

module.exports = { createOpenRouter, getOpenRouter, cleanOpenRouterSettings, ATTRIBUTION, DEFAULT_VENDORS };
