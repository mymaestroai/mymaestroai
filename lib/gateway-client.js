'use strict';

/**
 * gateway-client.js — Multi-provider LLM client
 *
 * Routes LLM calls based on model prefix:
 *   anthropic/claude-sonnet-4-6  → Anthropic Messages API
 *   openai/gpt-4o               → OpenAI Chat Completions
 *   lmstudio/qwen3-coder-30b    → LM Studio (OpenAI-compatible)
 *   google/gemini-2.0-flash     → Google Gemini (OpenAI-compatible)
 *   perplexity/sonar-pro        → Perplexity
 *   ollama/mistral              → Ollama (OpenAI-compatible)
 *   omlx/qwen3-8b               → oMLX, Apple Silicon (OpenAI-compatible)
 *   claude-sonnet-4-6 (bare)    → Anthropic (default)
 *
 * Provider keys and URLs are managed by lib/settings.js (single source of truth).
 */

const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const { applyQuirks, quirks } = require('./model-quirks');
const telemetry = require('./model-telemetry');
const httpAgent = require('./http-agent');
const { cyberTransport, isCyberModel } = require('./cyber-models');
const responsesApi = require('./openai-responses');

// Keep-alive connection pool (lib/http-agent.js). Applied per request via the
// `dispatcher` fetch option, so it is shared by every provider (one pool per
// origin). Kill switch: GATEWAY_KEEPALIVE=0 falls back to bare global fetch.
httpAgent.init();

// ── Provider Configuration ──────────────────────────────────────────────

function getProviderUrl(provider) {
  if (provider === 'codex') return settings.getProviderUrl('openai');
  return settings.getProviderUrl(provider);
}

function getProviderKey(provider) {
  if (provider === 'codex') return settings.getProviderKey('openai');
  if (provider === 'lmstudio') return 'lm-studio';
  if (provider === 'ollama') return 'ollama';
  // Local servers don't authenticate, but the OpenAI-compat path always sends
  // a bearer token — give it a placeholder rather than an empty header.
  if (provider === 'omlx') return 'omlx';
  if (provider === 'ninfer') return 'ninfer';
  if (provider === 'local') return 'local';
  return settings.getProviderKey(provider);
}

// Exported so auto-model.js can read it without duplicating lookups.
const PROVIDER_URLS = new Proxy({}, { get: (_, prop) => getProviderUrl(prop) });

// Optional gateway URL — used as fallback when model cannot be mapped to a known provider
const GATEWAY_URL = process.env.LLM_GATEWAY_URL || '';

// ── Provider Resolution ─────────────────────────────────────────────────

function resolveProvider(model) {
  // Parse provider/model-id format
  const slash = model.indexOf('/');
  if (slash > 0) {
    const prefix = model.slice(0, slash).toLowerCase();
    // claude-sdk/ prefix: strip it and route to anthropic (used when SDK agents
    // are forced through gateway for tiger team / consultation tool support)
    // codex-cli/ models run only through the Codex CLI (lib/codex-cli), never an HTTP gateway
    if (prefix === 'codex-cli') {
      return { provider: 'codex-cli', modelId: model.slice(slash + 1), baseUrl: null };
    }
    if (prefix === 'claude-sdk') {
      const modelId = model.slice(slash + 1);
      return { provider: 'anthropic', modelId, baseUrl: getProviderUrl('anthropic') };
    }
    const url = getProviderUrl(prefix);
    if (url) {
      return { provider: prefix, modelId: model.slice(slash + 1), baseUrl: url };
    }
  }

  // Bare model name — infer provider from model name
  if (/^claude/i.test(model)) {
    return { provider: 'anthropic', modelId: model, baseUrl: getProviderUrl('anthropic') };
  }
  if (/^gpt|^o[134]-|^o[134]$/i.test(model)) {
    return { provider: 'openai', modelId: model, baseUrl: getProviderUrl('openai') };
  }
  if (/^gemini/i.test(model)) {
    return { provider: 'google', modelId: model, baseUrl: getProviderUrl('google') };
  }

  // Last resort: if gateway URL is set, use it; otherwise default to anthropic
  if (GATEWAY_URL) {
    return { provider: 'gateway', modelId: model, baseUrl: GATEWAY_URL };
  }
  return { provider: 'anthropic', modelId: model, baseUrl: getProviderUrl('anthropic') };
}

// ── Headers ─────────────────────────────────────────────────────────────

function getProviderHeaders(provider) {
  if (provider === 'anthropic') {
    return {
      'Content-Type': 'application/json',
      'x-api-key': getProviderKey('anthropic'),
      'anthropic-version': '2023-06-01',
    };
  }
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${getProviderKey(provider)}`,
    // OpenRouter: app attribution (the product's name and site, nothing about this machine or its owner).
    ...(provider === 'openrouter' ? require('./openrouter').ATTRIBUTION : {}),
  };
}

// Legacy gateway headers (unused in multi-provider mode)
function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${getProviderKey('openai')}`,
  };
}

// ── Per-request Transport ───────────────────────────────────────────────
// Multi-provider port of the upstream package's transportFor(). Upstream sends
// everything to one LLM gateway; here the transport is derived from
// resolveProvider(), so every provider keeps its own base URL, path, headers
// and API key exactly as before. This is the single place that decides them.
//
// `api` tells the caller which wire dialect to speak:
//   'anthropic' → Anthropic Messages API        (`${baseUrl}/v1/messages`)
//   'codex'     → codex/ provider, text-only Responses body (`${baseUrl}/responses`)
//   'responses' → chat body translated by lib/openai-responses.js. Only for
//                 OpenAI-hosted models whose quirks say api:'responses'
//                 (gpt-6 family, *-pro, *codex*) — OpenAI rejects those on
//                 /chat/completions. Never used for local servers, Google or
//                 Perplexity, whatever the model is called.
//   'chat'      → OpenAI-compatible Chat Completions
//
// Providers that run on the user's own hardware. Model quirks (token ceilings
// probed against hosted vendors) are not applied to these, and they get a
// longer stream-stall allowance (prompt processing can be silent for minutes).
const LOCAL_SERVER_PROVIDERS = new Set(['lmstudio', 'ollama', 'omlx', 'ninfer', 'local']);

function transportFor(model) {
  // lib/cyber-models.js is an inert stub in this deployment (always null).
  const cyber = cyberTransport(model);
  if (cyber) {
    return {
      provider: cyber.provider, modelId: cyber.upstreamModel, baseUrl: null,
      url: cyber.url, headers: cyber.headers,
      upstreamModel: cyber.upstreamModel, api: cyber.api || 'chat',
    };
  }

  const { provider, modelId, baseUrl } = resolveProvider(model);
  const base = { provider, modelId, baseUrl, upstreamModel: modelId };
  if (provider === 'codex-cli') {
    throw new Error(`${model} runs only through the Codex CLI on the ChatGPT subscription; it cannot be called through the gateway`);
  }

  if (provider === 'anthropic') {
    return { ...base, url: `${baseUrl}/v1/messages`, headers: getProviderHeaders('anthropic'), api: 'anthropic' };
  }
  if (provider === 'codex') {
    return { ...base, url: `${baseUrl}/responses`, headers: getProviderHeaders('codex'), api: 'codex' };
  }
  if (provider === 'gateway') {
    const api = quirks(modelId).api === 'responses' ? 'responses' : 'chat';
    return { ...base, url: `${baseUrl}/v1/${api === 'responses' ? 'responses' : 'chat/completions'}`, headers: getHeaders(), api };
  }
  if (provider === 'openai' && quirks(modelId).api === 'responses') {
    return { ...base, url: `${baseUrl}/responses`, headers: getProviderHeaders('openai'), api: 'responses' };
  }
  return { ...base, url: `${baseUrl}/chat/completions`, headers: getProviderHeaders(provider), api: 'chat' };
}

// ── Pooled fetch (keep-alive + connection telemetry) ────────────────────
// Adds the undici keep-alive dispatcher and a correlation header so the
// diagnostics_channel subscriber in http-agent.js can attribute the socket
// (new vs reused, ALPN, TLS version) back to this request.
// Returns { response, reqId }.  Callers pass reqId to connFields() afterwards.

async function gatewayFetch(url, init = {}) {
  const reqId = httpAgent.newRequestId();
  httpAgent.noteRequest();
  const headers = { ...(init.headers || {}), 'x-hub-req-id': reqId };
  const response = await fetch(url, {
    ...init,
    headers,
    ...httpAgent.dispatcherOption(),
  });
  return { response, reqId };
}

// Flatten connection info into the telemetry record shape.
function connFields(reqId) {
  const info = httpAgent.takeConnInfo(reqId);
  if (!info) return {};
  return {
    socketId: info.socketId,
    connReused: info.reused,
    alpn: info.alpn,
    tlsVersion: info.tls,
    connectMs: info.connectMs,
  };
}

// ── Tool Schema Sanitizer ───────────────────────────────────────────────

function sanitizeSchema(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeSchema);

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === '$schema') continue;
    if (key === 'additionalProperties') continue;
    if (key === '$ref') { result.type = 'string'; continue; }
    if (key === 'anyOf' || key === 'oneOf') {
      if (Array.isArray(value) && value.length > 0) {
        const first = value[0];
        if (first && typeof first === 'object') {
          Object.assign(result, sanitizeSchema(first));
        } else {
          result.type = 'string';
        }
      } else {
        result.type = 'string';
      }
      continue;
    }
    if (key === 'allOf') {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object') {
            Object.assign(result, sanitizeSchema(item));
          }
        }
      }
      continue;
    }
    result[key] = sanitizeSchema(value);
  }
  return result;
}

function sanitizeTools(tools) {
  if (!tools || tools.length === 0) return tools;
  return tools.map(tool => {
    if (!tool.function?.parameters) return tool;
    return {
      ...tool,
      function: {
        ...tool.function,
        parameters: sanitizeSchema(tool.function.parameters),
      },
    };
  });
}

// ── Retry Logic ─────────────────────────────────────────────────────────

const RATE_LIMIT_MAX_RETRIES = 5;
const NETWORK_MAX_RETRIES = 3;
const RATE_LIMIT_BASE_DELAY_MS = 5000;
const NETWORK_BASE_DELAY_MS = 2000;

// undici throws a generic `TypeError: fetch failed` and buries the real
// cause (ENETUNREACH / EHOSTUNREACH / ECONNREFUSED / cert errors) in err.cause,
// which can itself be nested (AggregateError for multi-A-record hosts).
// Without this, every VPN/routing failure logs as the useless string
// "fetch failed" and is impossible to diagnose after the fact.
function describeNetworkError(err) {
  const parts = [];
  const seen = new Set();
  let cur = err;
  for (let depth = 0; cur && depth < 6; depth++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const code = cur.code || cur.errno;
    const bits = [];
    if (cur.name && cur.name !== 'Error') bits.push(cur.name);
    if (code) bits.push(String(code));
    if (cur.message && cur.message !== 'fetch failed') bits.push(cur.message);
    if (cur.address) bits.push(`addr=${cur.address}${cur.port ? ':' + cur.port : ''}`);
    if (bits.length) parts.push(bits.join(' '));
    if (Array.isArray(cur.errors) && cur.errors.length) {
      for (const sub of cur.errors.slice(0, 4)) {
        const sc = sub && (sub.code || sub.errno);
        const sa = sub && sub.address ? ` addr=${sub.address}${sub.port ? ':' + sub.port : ''}` : '';
        if (sc || (sub && sub.message)) parts.push(`  ↳ ${sc || sub.message}${sa}`);
      }
    }
    cur = cur.cause;
  }
  return parts.length ? parts.join(' <- ') : (err && err.message) || String(err);
}

function isRetryableError(err) {
  if (!err) return false;
  const msg = `${err.message || ''} ${describeNetworkError(err)}`;
  return msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') ||
    msg.includes('socket hang up') || msg.includes('network') ||
    msg.includes('ECONNREFUSED') || msg.includes('fetch failed') ||
    msg.includes('UND_ERR');
}

function isRetryableStatus(status) {
  return status === 500 || status === 502 || status === 503 || status === 520 || status === 524;
}

function parseRetryAfter(response) {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) return seconds * 1000;
  }
  return null;
}

function getBackoffDelay(attempt) {
  const delay = RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, 60000);
}

async function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => { clearTimeout(timer); reject(new Error('Aborted during rate limit wait')); };
      if (signal.aborted) { clearTimeout(timer); reject(new Error('Aborted during rate limit wait')); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// ── Prompt Caching (Anthropic models) ──────────────────────────────────
// Ported verbatim from the upstream package, where it targets Anthropic models
// behind a LiteLLM gateway (OpenAI-format messages carrying cache_control).
// NOTE: upstream defines these helpers but never calls them, and neither does
// this file — they are NOT wired into any request path. Kept so the file
// stays aligned with upstream; wiring them into the native Anthropic path
// below would be a separate, deliberate change.
// Strategy (max 4 breakpoints allowed by Anthropic; we use up to 3):
//   1. system message  → caches tools + system prefix (stable across turns)
//   2. last message    → rolling breakpoint; caches the whole conversation
//      prefix so the next turn / next tool-loop iteration reads it back
//   3. a mid-history anchor ~20 messages back → insurance for Anthropic's
//      20-block cache-hit lookback when many messages append in one turn
// Cache TTL is 5 min (refreshed on every read) - ideal for tool loops.
// Kill switch: GATEWAY_PROMPT_CACHE=0
const PROMPT_CACHE_ENABLED = process.env.GATEWAY_PROMPT_CACHE !== '0';

function markCacheable(msg) {
  if (!msg) return false;
  if (typeof msg.content === 'string' && msg.content.length > 0) {
    msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }];
    return true;
  }
  if (Array.isArray(msg.content) && msg.content.length > 0) {
    for (let i = msg.content.length - 1; i >= 0; i--) {
      const b = msg.content[i];
      if (b && b.type === 'text' && b.text && !b.cache_control) {
        b.cache_control = { type: 'ephemeral' };
        return true;
      }
    }
  }
  return false;
}

// eslint-disable-next-line no-unused-vars
function applyPromptCaching(body) {
  if (!PROMPT_CACHE_ENABLED) return;
  if (!/claude/i.test(body.model || '')) return;   // Anthropic models only
  const msgs = body.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return;
  let used = 0;
  // 1. system prefix
  if (msgs[0].role === 'system' && markCacheable(msgs[0])) used++;
  // 2. rolling breakpoint on the last markable message
  for (let i = msgs.length - 1; i > 0 && used < 4; i--) {
    if (markCacheable(msgs[i])) { used++; break; }
  }
  // 3. mid-history anchor for lookback insurance on long histories
  if (msgs.length > 24 && used < 4) {
    for (let i = msgs.length - 21; i > 0; i--) {
      if (markCacheable(msgs[i])) { used++; break; }
    }
  }
}

// ── Surrogate Sanitizer ────────────────────────────────────────────────

function stripSurrogates(str) {
  str = str.replace(/\\u([dD][89aAbB][0-9a-fA-F]{2})\\u([dD][cCdDeEfF][0-9a-fA-F]{2})/g, (match) => match);
  str = str.replace(/\\u[dD][89aAbB][0-9a-fA-F]{2}(?!\\u[dD][cCdDeEfF][0-9a-fA-F]{2})/g, '\\uFFFD');
  str = str.replace(/(?<!\\u[dD][89aAbB][0-9a-fA-F]{2})\\u[dD][cCdDeEfF][0-9a-fA-F]{2}/g, '\\uFFFD');

  let result = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) { result += str[i] + str[i + 1]; i++; }
      else result += '\uFFFD';
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      result += '\uFFFD';
    } else {
      result += str[i];
    }
  }
  return result;
}

// ── Anthropic Messages API ──────────────────────────────────────────────
// Anthropic uses a different API format than OpenAI. We call /v1/messages
// and convert the response to OpenAI format for compatibility with the
// rest of the hub.

// The hub keeps history in OpenAI chat format. Anthropic's Messages API differs in three ways that matter for
// tool use: an assistant's tool calls are `tool_use` content blocks (not `tool_calls`), tool results are
// `tool_result` blocks inside a USER message (there is no "tool" role), and roles must alternate, so the
// results of one round (and any note or image the hub adds after them) go into a single user message with
// the tool_result blocks first. Without this the second model call of any tool-using turn failed with
// 400 "Unexpected role \"tool\"".
function convertImageBlock(block) {
  if (block && block.type === 'image_url' && block.image_url?.url) {
    const m = String(block.image_url.url).match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
    if (/^https?:\/\//.test(block.image_url.url)) return { type: 'image', source: { type: 'url', url: block.image_url.url } };
  }
  return block;
}

function toBlocks(content) {
  if (content == null) return [];
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : [];
  if (Array.isArray(content)) {
    return content.map(convertImageBlock).filter(b => b && !(b.type === 'text' && !String(b.text || '').trim()));
  }
  return [{ type: 'text', text: String(content) }];
}

function parseToolArgs(args) {
  if (args && typeof args === 'object') return args;
  if (typeof args !== 'string' || !args.trim()) return {};
  try { const v = JSON.parse(args); return v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v }; }
  catch { return { _raw: args }; }   // cut-off JSON: still a valid tool_use block, the result says what happened
}

function convertToAnthropicMessages(messages) {
  const out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) {
      // tool_result blocks must lead a user message: keep them ahead of any text/images merged in
      if (role === 'user') {
        const results = [...last.content, ...blocks].filter(b => b.type === 'tool_result');
        const rest = [...last.content, ...blocks].filter(b => b.type !== 'tool_result');
        last.content = [...results, ...rest];
      } else last.content.push(...blocks);
    } else out.push({ role, content: [...blocks] });
  };

  for (const msg of messages) {
    if (!msg || msg.role === 'system') continue;                // system is a top-level param
    if (msg.role === 'tool') {
      const body = toBlocks(msg.content).filter(b => b.type === 'text' || b.type === 'image');
      push('user', [{
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: body.length ? body : [{ type: 'text', text: '(no output)' }],
        ...(msg.is_error ? { is_error: true } : {}),
      }]);
      continue;
    }
    if (msg.role === 'assistant') {
      const blocks = toBlocks(msg.content);
      for (const tc of msg.tool_calls || []) {
        if (!tc || !tc.function) continue;
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parseToolArgs(tc.function.arguments) });
      }
      push('assistant', blocks);
      continue;
    }
    push('user', toBlocks(msg.content));
  }

  // A tool_use with no matching tool_result (turn cut off before the tool ran) is rejected by the API:
  // answer it as not run, so a resumed conversation can continue.
  for (let i = 0; i < out.length; i++) {
    if (out[i].role !== 'assistant') continue;
    const ids = out[i].content.filter(b => b.type === 'tool_use').map(b => b.id);
    if (!ids.length) continue;
    const next = out[i + 1];
    const answered = new Set(next && next.role === 'user' ? next.content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id) : []);
    const missing = ids.filter(id => !answered.has(id)).map(id => ({ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: '(tool did not run: the turn ended first)' }], is_error: true }));
    if (!missing.length) continue;
    if (next && next.role === 'user') next.content = [...missing, ...next.content];
    else out.splice(i + 1, 0, { role: 'user', content: missing });
  }
  // The API needs the conversation to start with a user message.
  if (out.length && out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(conversation continues)' }] });
  return out;
}

function anthropicResponseToOpenAI(data) {
  // Convert Anthropic Messages API response to OpenAI chat completion format
  const textBlocks = (data.content || []).filter(b => b.type === 'text');
  const toolBlocks = (data.content || []).filter(b => b.type === 'tool_use');
  const content = textBlocks.map(b => b.text).join('');

  const message = { role: 'assistant', content: content || null };
  if (toolBlocks.length > 0) {
    message.tool_calls = toolBlocks.map((b, i) => ({
      id: b.id,
      type: 'function',
      function: { name: b.name, arguments: JSON.stringify(b.input) },
    }));
  }

  return {
    choices: [{ message, finish_reason: data.stop_reason === 'tool_use' ? 'tool_calls' : 'stop' }],
    usage: anthropicUsage(data.usage),
  };
}

// Anthropic usage -> OpenAI shape. input_tokens excludes cached reads/writes, which are billed separately.
function anthropicUsage(u) {
  if (!u) return undefined;
  const cacheRead = u.cache_read_input_tokens || 0, cacheWrite = u.cache_creation_input_tokens || 0;
  return {
    prompt_tokens: (u.input_tokens || 0) + cacheRead + cacheWrite,
    completion_tokens: u.output_tokens || 0,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  };
}

// ── Prompt caching ──────────────────────────────────────────────────────
// Every model call resends the agent's system prompt, its tool definitions and the conversation. Providers
// can reuse an unchanged opening of the request at a fraction of the price:
//   - Anthropic: only when asked. Breakpoints go on the last tool (tools are sent first), the system prompt and
//     the last message, so each tool round reads everything before it and the next user turn reads the
//     previous turn. Reads cost ~10% (less on newer models), writes 125% (5 min) or 200% (1 h).
//   - OpenAI: automatic for openings over 1,024 tokens; prompt_cache_key keeps one agent's calls on the same
//     cache. Google and local servers (NInfer, LM Studio) cache repeated openings on their own.
// Settings: promptCache { enabled (default true), ttl: '5m' | '1h' }.
function promptCacheSettings() {
  let pc = {};
  try { pc = require('./settings').getSetting('promptCache', {}) || {}; } catch {}
  return { enabled: pc.enabled !== false, ttl: pc.ttl === '1h' ? '1h' : '5m' };
}

/** Put Anthropic cache breakpoints on tools, system and the last message (max 4 allowed; uses 3). */
function applyAnthropicCache(body) {
  const pc = promptCacheSettings();
  if (!pc.enabled) return body;
  const mark = pc.ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  if (Array.isArray(body.tools) && body.tools.length) {
    body.tools = body.tools.map((t, i) => i === body.tools.length - 1 ? { ...t, cache_control: mark } : t);
  }
  if (typeof body.system === 'string' && body.system) body.system = [{ type: 'text', text: body.system, cache_control: mark }];
  const last = body.messages && body.messages[body.messages.length - 1];
  if (last && Array.isArray(last.content) && last.content.length) {
    const i = last.content.length - 1;
    const blk = last.content[i];
    if (blk && ['text', 'image', 'tool_result', 'tool_use', 'document'].includes(blk.type)) {
      last.content = last.content.map((b, j) => j === i ? { ...b, cache_control: mark } : b);
    }
  }
  return body;
}

/** OpenAI: route one agent's calls to the same cache (agent name, hashed so no name leaves the box). */
function openAiCacheKey(agent) {
  if (!agent || !promptCacheSettings().enabled) return null;
  return 'hub-' + require('crypto').createHash('sha256').update(String(agent)).digest('hex').slice(0, 24);
}

/** Reasoning effort (lib/effort): Anthropic output_config.effort; OpenAI/Gemini reasoning_effort (the Responses
 *  translation turns it into reasoning.effort). Nothing for models the setting does not apply to. */
function applyEffort(body, model, level, kind) {
  if (!level) return body;
  let v = null; try { v = require('./effort').forModel(model, level); } catch {}
  if (!v) return body;
  if (kind === 'anthropic') body.output_config = { ...(body.output_config || {}), effort: v };
  else body.reasoning_effort = v;
  return body;
}

/** OpenRouter (lib/openrouter): cost in the usage chunk, the privacy routing, its reasoning form, the model's output
 *  limit, and cache breakpoints for Claude models (honouring the hub's prompt-cache setting). */
function openRouterExtras(body, modelId) {
  const pc = promptCacheSettings();
  try { require('./openrouter').getOpenRouter().requestExtras(body, modelId, { cache: pc.enabled, cacheTtl: pc.ttl }); } catch { /* catalogue unreadable: send as is */ }
  return body;
}

/** OpenAI refuses function tools together with reasoning_effort on /chat/completions (gpt-5.5, verified live
 *  2026-10-15: "Function tools with reasoning_effort are not supported ... in /v1/chat/completions"); /responses takes
 *  both. So a turn with an effort level and tools goes to /responses; everything else keeps its endpoint. */
function effortRoute(transport, provider, body) {
  if (transport.api === 'chat' && provider === 'openai' && body.reasoning_effort && Array.isArray(body.tools) && body.tools.length && /\/chat\/completions$/.test(transport.url)) {
    return { api: 'responses', url: transport.url.replace(/\/chat\/completions$/, '/responses') };
  }
  return { api: transport.api, url: transport.url };
}

function convertToolsToAnthropic(tools) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description || '',
    input_schema: t.function.parameters || { type: 'object', properties: {} },
  }));
}

// ── Anthropic Streaming SSE Adapter ─────────────────────────────────────
// Anthropic SSE events have a different format than OpenAI. We need to
// convert them on the fly to match the OpenAI streaming format that the
// rest of the hub expects.

function createAnthropicStreamAdapter(anthropicResponse) {
  // Returns a Response-like object with a body that yields OpenAI-format SSE
  let reader = null;
  let cancelled = false; // consumer went away (stop button, stall watchdog, error unwind)
  const readable = new ReadableStream({
    async start(controller) {
      reader = anthropicResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const encoder = new TextEncoder();
      // Closed-stream guard: enqueue() throws once the consumer has cancelled.
      let emitted = 0;
      const emit = (text) => {
        if (cancelled) return;
        emitted++;
        try { controller.enqueue(encoder.encode(text)); } catch (_) { cancelled = true; }
      };
      // Token usage: message_start carries the input side, message_delta the output total.
      let usage = null;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || cancelled) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]' || !data) continue;

            let event;
            try { event = JSON.parse(data); } catch { continue; }
            const before = emitted;

            // Convert Anthropic events to OpenAI delta format
            if (event.type === 'content_block_delta') {
              if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
                // The model's reasoning (summarized by Anthropic): its own field, shown in the reasoning panel, never the reply.
                emit(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: event.delta.thinking }, index: 0 }] })}\n\n`);
              } else if (event.delta?.type === 'text_delta') {
                const chunk = {
                  choices: [{ delta: { content: event.delta.text }, index: 0 }],
                };
                emit(`data: ${JSON.stringify(chunk)}\n\n`);
              } else if (event.delta?.type === 'input_json_delta') {
                // Tool call argument streaming
                const toolIdx = event.index || 0;
                const chunk = {
                  choices: [{
                    delta: {
                      tool_calls: [{ index: toolIdx, function: { arguments: event.delta.partial_json } }],
                    },
                    index: 0,
                  }],
                };
                emit(`data: ${JSON.stringify(chunk)}\n\n`);
              }
            } else if (event.type === 'content_block_start') {
              if (event.content_block?.type === 'tool_use') {
                // Start of a new tool call — emit the initial chunk with id and name
                const toolIdx = event.index || 0;
                const chunk = {
                  choices: [{
                    delta: {
                      tool_calls: [{
                        index: toolIdx,
                        id: event.content_block.id,
                        type: 'function',
                        function: {
                          name: event.content_block.name,
                          arguments: '',
                        },
                      }],
                    },
                    index: 0,
                  }],
                };
                emit(`data: ${JSON.stringify(chunk)}\n\n`);
              }
            } else if (event.type === 'message_start') {
              if (event.message?.usage) usage = { ...event.message.usage };
            } else if (event.type === 'message_delta') {
              // End of message — emit finish reason
              const reason = event.delta?.stop_reason;
              const finishReason = reason === 'tool_use' ? 'tool_calls' : reason === 'max_tokens' ? 'length' : 'stop';
              const chunk = {
                choices: [{ delta: {}, index: 0, finish_reason: finishReason }],
              };
              emit(`data: ${JSON.stringify(chunk)}\n\n`);
              if (event.usage) usage = { ...(usage || {}), ...event.usage };
              if (usage) emit(`data: ${JSON.stringify({ choices: [], usage: anthropicUsage(usage) })}\n\n`);
            } else if (event.type === 'message_stop') {
              emit('data: [DONE]\n\n');
            } else if (event.type === 'error') {
              // A failure inside an open stream (overloaded, internal error): pass the provider's own words on, so the
              // turn ends with them instead of "the model returned nothing".
              const e = event.error || {};
              emit(`data: ${JSON.stringify({ error: { type: e.type || 'api_error', message: e.message || 'Anthropic stream error', provider: 'anthropic' } })}\n\n`);
            }
            // Keep-alive for the idle watchdog in parseSSEStream. While the model thinks, Anthropic sends only a ping
            // about every 30 s and hands over the whole thinking block at the end (measured on claude-fable-5-1 at
            // effort max: 65 s of pings, then one thinking_delta). None of that is output, so it used to reach the
            // watchdog as silence, and a think longer than its 120 s was cut off as "the model returned nothing".
            // Every event that yields no output now passes an SSE comment on: the parser skips it but counts its bytes.
            if (emitted === before) emit(': keepalive\n\n');
          }
        }
      } catch (err) {
        if (!cancelled) console.error('[gateway] Anthropic stream error:', describeNetworkError(err));
      } finally {
        try { reader.releaseLock(); } catch (_) { /* already released */ }
        try { controller.close(); } catch (_) { /* already closed / cancelled */ }
      }
    },
    // KEEP-ALIVE SAFETY: when the consumer abandons the stream, cancel the
    // upstream body too so the pooled socket is freed instead of staying
    // checked out until the provider finishes generating.
    async cancel() {
      cancelled = true;
      try { if (reader) await reader.cancel(); } catch (_) { /* ignore */ }
    },
  });

  return new Response(readable, {
    status: anthropicResponse.status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

// ── OpenAI Responses API → OpenAI Chat Completions SSE Adapter ─────────
// Codex models use the Responses API (POST /v1/responses) which emits
// semantic SSE events. This adapter translates them into the chat
// completions delta format the hub already understands.

function createResponsesStreamAdapter(responsesResponse) {
  let reader = null;
  let cancelled = false; // consumer went away (stop button, stall watchdog, error unwind)
  const readable = new ReadableStream({
    async start(controller) {
      reader = responsesResponse.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = '';
      // Closed-stream guard: enqueue() throws once the consumer has cancelled.
      const emit = (text) => {
        if (cancelled) return;
        try { controller.enqueue(encoder.encode(text)); } catch (_) { cancelled = true; }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || cancelled) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]' || !data) continue;

            let event;
            try { event = JSON.parse(data); } catch { continue; }

            if (event.type === 'response.output_text.delta') {
              const chunk = {
                choices: [{ delta: { content: event.delta }, index: 0 }],
              };
              emit(`data: ${JSON.stringify(chunk)}\n\n`);
            } else if (event.type === 'response.function_call_arguments.delta') {
              const chunk = {
                choices: [{
                  delta: {
                    tool_calls: [{
                      index: event.output_index || 0,
                      function: { arguments: event.delta },
                    }],
                  },
                  index: 0,
                }],
              };
              emit(`data: ${JSON.stringify(chunk)}\n\n`);
            } else if (event.type === 'response.output_item.added') {
              if (event.item?.type === 'function_call') {
                const chunk = {
                  choices: [{
                    delta: {
                      tool_calls: [{
                        index: event.output_index || 0,
                        id: event.item.call_id || event.item.id,
                        type: 'function',
                        function: {
                          name: event.item.name,
                          arguments: '',
                        },
                      }],
                    },
                    index: 0,
                  }],
                };
                emit(`data: ${JSON.stringify(chunk)}\n\n`);
              }
            } else if (event.type === 'response.completed') {
              const chunk = {
                choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
              };
              emit(`data: ${JSON.stringify(chunk)}\n\n`);
              emit('data: [DONE]\n\n');
            } else if (event.type === 'response.failed') {
              const errMsg = event.response?.status_details?.error?.message || 'Unknown error';
              console.error('[gateway] Codex Responses API error:', errMsg);
              const chunk = {
                choices: [{ delta: { content: `\n\n${require('./error-help').text(errMsg, { provider: 'openai' })}` }, index: 0 }],
              };
              emit(`data: ${JSON.stringify(chunk)}\n\n`);
              emit('data: [DONE]\n\n');
            }
          }
        }
      } catch (err) {
        if (!cancelled) console.error('[gateway] Codex stream error:', describeNetworkError(err));
      } finally {
        try { reader.releaseLock(); } catch (_) { /* already released */ }
        try { controller.close(); } catch (_) { /* already closed / cancelled */ }
      }
    },
    // KEEP-ALIVE SAFETY: when the consumer abandons the stream, cancel the
    // upstream body too so the pooled socket is freed instead of staying
    // checked out until the provider finishes generating.
    async cancel() {
      cancelled = true;
      try { if (reader) await reader.cancel(); } catch (_) { /* ignore */ }
    },
  });

  return new Response(readable, {
    status: responsesResponse.status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

// Convert chat messages to Responses API input format
function messagesToResponsesInput(messages) {
  const parts = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        parts.push({ role: 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const text = msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        if (text) parts.push({ role: 'user', content: text });
      }
    } else if (msg.role === 'assistant') {
      parts.push({ role: 'assistant', content: typeof msg.content === 'string' ? msg.content : '' });
    }
  }
  return parts;
}

// ── Core Fetch with Retries ─────────────────────────────────────────────
// Shared by every provider path. `opts`:
//   agent     - agent name, for telemetry rows only
//   noRetries - fail fast (used by sdk-chat recovery calls, which run their
//               own retry/resume logic and must not stack ours on top)
// The returned Response carries a non-enumerable `__hubConn` (connection
// facts: socket id, reused, ALPN, TLS) for the streaming caller's telemetry.

function tagConn(target, conn) {
  try {
    Object.defineProperty(target, '__hubConn', { value: conn || {}, enumerable: false, configurable: true });
  } catch (_) { /* ignore */ }
  return target;
}

async function fetchWithRetries(url, fetchOpts, model, signal, opts = {}) {
  const maxAttempts = RATE_LIMIT_MAX_RETRIES + NETWORK_MAX_RETRIES;
  let networkRetries = 0;

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    let response, reqId;
    try {
      ({ response, reqId } = await gatewayFetch(url, { ...fetchOpts, signal }));
    } catch (fetchErr) {
      // Network-level failure (ECONNRESET, ETIMEDOUT, socket hang up, etc.)
      // A refused connection means nothing is listening (LM Studio off, wrong port): retrying
      // three times with backoff only delays the typed failure the pacing layer wants.
      const refused = /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/.test(describeNetworkError(fetchErr));
      if (refused) console.error(`[gateway] Connection refused (${model}): ${describeNetworkError(fetchErr)} — not retrying`);
      if (!refused && !opts.noRetries && isRetryableError(fetchErr) && networkRetries < NETWORK_MAX_RETRIES) {
        networkRetries++;
        const delay = NETWORK_BASE_DELAY_MS * Math.pow(2, networkRetries - 1);
        console.log(`[gateway] Network error (${model}): ${describeNetworkError(fetchErr)} — retrying in ${(delay / 1000).toFixed(1)}s (network retry ${networkRetries}/${NETWORK_MAX_RETRIES})`);
        await sleep(delay, signal);
        continue;
      }
      telemetry.recordRequest({
        model, agent: opts.agent, ok: false, status: null,
        error: fetchErr, retries: networkRetries, ...connFields(reqId),
      });
      if (!(signal && signal.aborted)) {
        console.error(`[gateway] Network FAILED (${model}) after ${networkRetries} retries: ${describeNetworkError(fetchErr)}`);
      }
      throw fetchErr;
    }

    if (!opts.noRetries && response.status === 429 && attempt < RATE_LIMIT_MAX_RETRIES) {
      connFields(reqId); // drop tracking entry for the abandoned attempt
      const retryDelay = parseRetryAfter(response) || getBackoffDelay(attempt);
      try { await response.body?.cancel(); } catch (_) { /* free the pooled socket */ }
      console.log(`[gateway] 429 rate limited (${model}) — retrying in ${(retryDelay / 1000).toFixed(1)}s (attempt ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES})`);
      await sleep(retryDelay, signal);
      continue;
    }

    if (!opts.noRetries && isRetryableStatus(response.status) && networkRetries < NETWORK_MAX_RETRIES) {
      connFields(reqId);
      networkRetries++;
      const delay = NETWORK_BASE_DELAY_MS * Math.pow(2, networkRetries - 1);
      try { await response.body?.cancel(); } catch (_) { /* free the pooled socket */ }
      console.log(`[gateway] Server error ${response.status} (${model}) — retrying in ${(delay / 1000).toFixed(1)}s (network retry ${networkRetries}/${NETWORK_MAX_RETRIES})`);
      await sleep(delay, signal);
      continue;
    }

    if (!response.ok) {
      const text = await response.text();
      console.error(`[gateway] Error ${response.status} for ${model}:`, text.slice(0, 500));
      const err = new Error(`Provider ${response.status}: ${text.slice(0, 500)}`);
      err.status = response.status;   // lib/error-help reads it to explain the error in plain words
      err.retryAfterMs = parseRetryAfter(response);
      telemetry.recordRequest({
        model, agent: opts.agent, ok: false, status: response.status,
        error: err, retries: networkRetries, ...connFields(reqId),
      });
      throw err;
    }

    return tagConn(response, connFields(reqId));
  }
}

// ── Model Quirks ────────────────────────────────────────────────────────
// lib/model-quirks.js: drop params a model rejects (temperature on o-series /
// gpt-5.5+ / codex), rename max_tokens where required, clamp to the model's
// output ceiling, raise to the reasoning floor. Applied against the UPSTREAM
// (prefix-stripped) id so the anchored regexes (^o[0-9], ^gpt-...) match.
// Skipped for local servers: the registry's ceilings were probed against
// hosted vendors and say nothing about what the user's own server allows.
function applyModelQuirks(body, transport) {
  if (LOCAL_SERVER_PROVIDERS.has(transport.provider)) return;
  applyQuirks(body, { direct: transport.provider !== 'gateway' });
}

// ── Non-Streaming Chat Completion ───────────────────────────────────────

async function chatCompletion(messages, options = {}) {
  const {
    model = 'claude-sonnet-4-6',
    max_tokens,
    temperature,
    tools,
    system,
  } = options;

  // Resolve transport BEFORE any network work. URL, headers and key all come
  // from the per-provider routing in transportFor()/resolveProvider().
  const transport = transportFor(model);
  const { provider, modelId } = transport;
  const retryOpts = { agent: options.agent };

  if (transport.api === 'anthropic') {
    // Anthropic Messages API (non-streaming)
    const anthropicMessages = convertToAnthropicMessages(messages);
    // Extract system from messages or from option
    let systemText = system || '';
    for (const msg of messages) {
      if (msg.role === 'system') {
        systemText = (systemText ? systemText + '\n\n' : '') + msg.content;
      }
    }

    const body = {
      model: modelId,
      messages: anthropicMessages,
      max_tokens: max_tokens || 8192,
      stream: false,
    };
    if (systemText) body.system = systemText;
    if (temperature !== undefined) body.temperature = temperature;
    if (tools && tools.length > 0) body.tools = convertToolsToAnthropic(sanitizeTools(tools));
    applyModelQuirks(body, transport);
    applyEffort(body, model, options.effort, 'anthropic');
    applyAnthropicCache(body);

    const safePayload = stripSurrogates(JSON.stringify(body));
    const response = await fetchWithRetries(
      transport.url,
      { method: 'POST', headers: transport.headers, body: safePayload },
      model, options.signal, retryOpts,
    );
    const data = await response.json();
    return anthropicResponseToOpenAI(data);
  }

  // Codex (OpenAI Responses API)
  if (transport.api === 'codex') {
    const input = messagesToResponsesInput(messages);
    const systemText = system || messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const body = { model: modelId, input, stream: false };
    if (systemText) body.instructions = systemText;
    if (temperature !== undefined) body.temperature = temperature;
    applyModelQuirks(body, transport);

    const safePayload = stripSurrogates(JSON.stringify(body));
    const response = await fetchWithRetries(
      transport.url,
      { method: 'POST', headers: transport.headers, body: safePayload },
      model, options.signal, retryOpts,
    );
    const data = await response.json();
    // Extract text from output array or top-level output_text
    let text = data.output_text || '';
    if (!text && Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const block of item.content) {
            if (block.type === 'output_text' && block.text) text += block.text;
          }
        }
      }
    }
    return {
      choices: [{ message: { role: 'assistant', content: text }, index: 0, finish_reason: 'stop' }],
      model: data.model,
      usage: data.usage || {},
    };
  }

  // OpenAI-compatible providers (openai, lmstudio, google, perplexity, ollama, omlx, gateway)
  const body = { model: modelId, messages: [...messages], stream: false };
  if (max_tokens) {
    if (provider === 'openai' && /^(gpt-[45]|o[134])/.test(modelId)) {
      body.max_completion_tokens = max_tokens;
    } else {
      body.max_tokens = max_tokens;
    }
  }
  if (temperature !== undefined) body.temperature = temperature;
  if (tools && tools.length > 0) body.tools = sanitizeTools(tools);
  if (system) body.messages.unshift({ role: 'system', content: system });
  applyModelQuirks(body, transport);
  if (provider === 'openai') { const k = openAiCacheKey(options.agent); if (k) body.prompt_cache_key = k; }
  applyEffort(body, model, options.effort, 'chat');
  if (provider === 'openrouter') openRouterExtras(body, modelId);
  const route = effortRoute(transport, provider, body);

  // Responses-only OpenAI models: translate the chat body on the way out and
  // the result back to chat-completion shape on the way in.
  const wireBody = route.api === 'responses' ? responsesApi.toResponsesBody(body) : body;

  const safePayload = stripSurrogates(JSON.stringify(wireBody));
  const response = await fetchWithRetries(
    route.url,
    { method: 'POST', headers: transport.headers, body: safePayload },
    model, options.signal, retryOpts,
  );
  if (route.api === 'responses') {
    return responsesApi.fromResponsesJSON(await response.json());
  }
  return response.json();
}

// ── Streaming Chat Completion ───────────────────────────────────────────

const STREAM_USAGE_PROVIDERS = new Set(['openai', 'google']);

async function chatCompletionStream(messages, options = {}) {
  const {
    model = 'claude-sonnet-4-6',
    max_tokens,
    temperature,
    tools,
    system,
  } = options;

  // Resolve transport BEFORE any network work. URL, headers and key all come
  // from the per-provider routing in transportFor()/resolveProvider().
  const transport = transportFor(model);
  const { provider, modelId } = transport;
  const retryOpts = { agent: options.agent, noRetries: !!options.noRetries };

  if (transport.api === 'anthropic') {
    // Anthropic Messages API (streaming) → adapt to OpenAI SSE format
    const anthropicMessages = convertToAnthropicMessages(messages);
    let systemText = system || '';
    for (const msg of messages) {
      if (msg.role === 'system') {
        systemText = (systemText ? systemText + '\n\n' : '') + msg.content;
      }
    }

    const body = {
      model: modelId,
      messages: anthropicMessages,
      max_tokens: max_tokens || 8192,
      stream: true,
    };
    if (systemText) body.system = systemText;
    if (temperature !== undefined) body.temperature = temperature;
    if (tools && tools.length > 0) body.tools = convertToolsToAnthropic(sanitizeTools(tools));
    applyModelQuirks(body, transport);
    applyEffort(body, model, options.effort, 'anthropic');
    applyAnthropicCache(body);

    const safePayload = stripSurrogates(JSON.stringify(body));
    const response = await fetchWithRetries(
      transport.url,
      { method: 'POST', headers: transport.headers, body: safePayload },
      model, options.signal, retryOpts,
    );
    // Wrap the Anthropic SSE stream in an adapter that emits OpenAI-format events
    return tagConn(createAnthropicStreamAdapter(response), response.__hubConn);
  }

  // Codex (OpenAI Responses API — streaming)
  if (transport.api === 'codex') {
    const input = messagesToResponsesInput(messages);
    const systemText = system || messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const body = { model: modelId, input, stream: true };
    if (systemText) body.instructions = systemText;
    if (temperature !== undefined) body.temperature = temperature;
    applyModelQuirks(body, transport);

    const safePayload = stripSurrogates(JSON.stringify(body));
    const response = await fetchWithRetries(
      transport.url,
      { method: 'POST', headers: transport.headers, body: safePayload },
      model, options.signal, retryOpts,
    );
    return tagConn(createResponsesStreamAdapter(response), response.__hubConn);
  }

  // OpenAI-compatible providers
  const body = { model: modelId, messages: [...messages], stream: true };
  // Hosted providers only send token usage on a stream when asked; the ledger needs it to price the turn.
  if (STREAM_USAGE_PROVIDERS.has(provider) && transport.api !== 'responses') body.stream_options = { include_usage: true };
  if (max_tokens) {
    if (provider === 'openai' && /^(gpt-[45]|o[134])/.test(modelId)) {
      body.max_completion_tokens = max_tokens;
    } else {
      body.max_tokens = max_tokens;
    }
  }
  if (temperature !== undefined) body.temperature = temperature;
  if (tools && tools.length > 0) body.tools = sanitizeTools(tools);
  if (system) body.messages.unshift({ role: 'system', content: system });
  applyModelQuirks(body, transport);
  if (provider === 'openai') { const k = openAiCacheKey(options.agent); if (k) body.prompt_cache_key = k; }
  applyEffort(body, model, options.effort, 'chat');
  if (provider === 'openrouter') openRouterExtras(body, modelId);
  const route = effortRoute(transport, provider, body);

  // Responses-only OpenAI models: translate the wire body.
  const wireBody = route.api === 'responses' ? responsesApi.toResponsesBody(body) : body;

  const safePayload = stripSurrogates(JSON.stringify(wireBody));
  const response = await fetchWithRetries(
    route.url,
    { method: 'POST', headers: transport.headers, body: safePayload },
    model, options.signal, retryOpts,
  );

  // Re-emit the Responses SSE as chat-completions SSE so parseSSEStream and
  // the tool loop are unchanged.
  if (route.api === 'responses') {
    return tagConn(responsesApi.wrapResponsesStream(response, transport.upstreamModel), response.__hubConn);
  }

  // Local servers can sit silent for minutes while they process a long prompt;
  // give them a longer idle allowance than hosted providers (see parseSSEStream).
  if (LOCAL_SERVER_PROVIDERS.has(provider)) {
    try {
      Object.defineProperty(response, '__hubStallMs', { value: LOCAL_STREAM_STALL_MS, enumerable: false, configurable: true });
    } catch (_) { /* ignore */ }
  }
  return response;
}

// ── SSE Stream Parser ───────────────────────────────────────────────────

// `outState` (optional) is populated so the CALLER can distinguish a stream
// that ended cleanly from one that was cut off.  This matters: an upstream
// socket that dies mid-generation produces NO exception and NO finish_reason -
// the generator just stops.  To the tool loop that is indistinguishable from
// "the model finished and had nothing more to say", so a truncated turn was
// being recorded as a SUCCESS.  See TRUNCATED-STREAM GUARD in sdk-chat.js.
//
//   outState.sawDone   - explicit `data: [DONE]` sentinel was received
//   outState.eof       - socket reached EOF (may be clean or premature)
//   outState.frames    - count of parsed SSE data frames
//   outState.bytes     - raw bytes read off the wire
//   outState.partial   - trailing bytes left in the buffer (cut mid-frame)
//   outState.stalled   - the stall watchdog below tripped
//
// STALL WATCHDOG: how long we tolerate ZERO bytes arriving mid-stream before
// declaring the connection dead.  This is an IDLE timer, not a total-duration
// cap - a 10-minute response that keeps trickling tokens never trips it.
// Without this, a socket that goes silent (provider hiccup, VPN transition,
// upstream worker death with no FIN/RST) hangs reader.read() FOREVER: no
// exception, no EOF, no finish_reason.  The agent appears frozen with zero
// output until the user aborts.  On trip we bail gracefully (st.stalled=true,
// body cancelled) so the TRUNCATED-STREAM GUARD in sdk-chat.js auto-resumes.
// 0 disables.  Local servers (LM Studio / Ollama / oMLX) get their own, longer
// limit via the response's `__hubStallMs` tag set in chatCompletionStream.
const STREAM_STALL_MS = (() => {
  const n = parseInt(process.env.GATEWAY_STREAM_STALL_MS, 10);
  return Number.isFinite(n) ? n : 120_000;
})();
const LOCAL_STREAM_STALL_MS = (() => {
  const n = parseInt(process.env.GATEWAY_LOCAL_STREAM_STALL_MS, 10);
  return Number.isFinite(n) ? n : 600_000;
})();

async function* parseSSEStream(response, outState) {
  const st = outState || {};
  st.sawDone = false; st.eof = false; st.frames = 0; st.bytes = 0; st.partial = 0;
  st.stalled = false;

  const stallMs = Number.isFinite(response.__hubStallMs) ? response.__hubStallMs : STREAM_STALL_MS;
  st.stallMs = stallMs;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let drained = false; // true only if we consumed the body to its natural end

  try {
    while (true) {
      let readResult;
      if (stallMs > 0) {
        let stallTimer;
        const stallSentinel = Symbol('stall');
        const stallPromise = new Promise((resolve) => {
          stallTimer = setTimeout(() => resolve(stallSentinel), stallMs);
        });
        try {
          readResult = await Promise.race([reader.read(), stallPromise]);
        } finally {
          clearTimeout(stallTimer);
        }
        if (readResult === stallSentinel) {
          st.stalled = true;
          console.warn(`[gateway] SSE stream stalled - no bytes for ${stallMs}ms ` +
            `(frames=${st.frames} bytes=${st.bytes}) - cancelling body`);
          break; // finally block cancels the undrained body → socket destroyed, pool safe
        }
      } else {
        readResult = await reader.read();
      }
      const { done, value } = readResult;
      if (done) { drained = true; st.eof = true; break; }

      st.bytes += value.length || 0;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') { drained = true; st.sawDone = true; return; }
          try {
            const parsed = JSON.parse(data);
            st.frames++;
            yield parsed;
          } catch { /* skip malformed chunks */ }
        }
      }
    }
    // Anything still buffered at EOF is a frame the server never finished
    // writing - a strong signal the connection was severed mid-generation.
    st.partial = buffer.trim().length;
  } finally {
    // KEEP-ALIVE SAFETY: if the consumer abandons the stream early - user hit
    // stop, res destroyed, tool loop bailed, an exception unwound - the body
    // is left undrained.  On a POOLED connection that socket stays checked
    // out and can starve the pool; with bare fetch the socket was disposable
    // so this never mattered.  releaseLock() does NOT free it.  Cancel the
    // body so undici drains or destroys the socket and returns it to the pool.
    try { reader.releaseLock(); } catch (_) { /* already released */ }
    if (!drained) {
      try { await response.body.cancel(); } catch (_) { /* already closed */ }
    }
  }
}

// ── Model Listing ───────────────────────────────────────────────────────

let _modelsCache = null;
let _modelsCacheTime = 0;
const MODEL_CACHE_TTL = 300_000; // 5 minutes

// Called when discovery writes a new cache, so a freshly added provider key
// shows its models immediately instead of after the TTL.
function invalidateModelsCache() {
  _modelsCache = null;
  _modelsCacheTime = 0;
}

async function listModels() {
  const now = Date.now();
  if (_modelsCache && (now - _modelsCacheTime) < MODEL_CACHE_TTL) {
    return _modelsCache;
  }

  // Remote providers (anthropic/openai/google/perplexity) come from the
  // discovery cache — their catalogs change rarely and probing costs money.
  // Local providers (LM Studio/Ollama) are ALWAYS probed live below: their
  // catalogs change whenever the user downloads a model, and localhost
  // queries are free. This keeps new downloads visible within 5 minutes
  // (the _modelsCache TTL) instead of the 6-hour discovery cadence.
  //
  // There is deliberately NO hardcoded model list here. A stale guess is
  // worse than a slow answer: it advertises models the user can't reach
  // (wrong provider/no key) and hides ones they can. If discovery hasn't
  // produced a cache yet, we run it now and wait.
  let allModels = [];
  let haveDiscovery = false;
  const readDiscovery = () => {
    try {
      const { getDiscoveredModels } = require('./model-discovery');
      return getDiscoveredModels().filter(m =>
        !m.startsWith('lmstudio/') && !m.startsWith('ollama/'));
    } catch { return []; }
  };

  let discovered = readDiscovery();
  if (discovered.length === 0) {
    // Cold start: no cache on disk yet. Run discovery once and wait for it
    // rather than serving a fabricated list.
    try {
      const { runDiscovery } = require('./model-discovery');
      await runDiscovery();
      discovered = readDiscovery();
    } catch (e) {
      console.error('[gateway] Discovery failed during listModels:', e.message);
    }
  }
  if (discovered.length > 0) { allModels = discovered; haveDiscovery = true; }

  try {
    const lmsResponse = await fetch(`${PROVIDER_URLS.lmstudio}/models`, {
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    if (lmsResponse.ok) {
      const data = await lmsResponse.json();
      for (const m of (data.data || [])) {
        allModels.push(`lmstudio/${m.id}`);
      }
    }
  } catch { /* LM Studio offline */ }

  try {
    const ollamaResponse = await fetch(`${PROVIDER_URLS.ollama}/models`, {
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    if (ollamaResponse.ok) {
      const data = await ollamaResponse.json();
      for (const m of (data.data || [])) {
        allModels.push(`ollama/${m.id}`);
      }
    }
  } catch { /* Ollama offline */ }

  // Remote-provider live probes only needed when discovery hasn't run yet
  if (!haveDiscovery) {
    if (getProviderKey('openai')) {
      try {
        const oaiResponse = await fetch(`${getProviderUrl('openai')}/models`, {
          headers: { 'Authorization': `Bearer ${getProviderKey('openai')}` },
          signal: AbortSignal.timeout(5000),
        });
        if (oaiResponse.ok) {
          const data = await oaiResponse.json();
          const chatModels = (data.data || [])
            .filter(m => /^(gpt-[345]|gpt-[345]\.|gpt-4o|o[134])/i.test(m.id) &&
              !/audio|realtime|transcribe|tts|instruct|codex|image|search-api|whisper|translate/i.test(m.id))
            .map(m => `openai/${m.id}`);
          allModels.push(...chatModels);
        }
      } catch { /* OpenAI unreachable */ }
    }

    if (getProviderKey('google')) {
      allModels.push('google/gemini-2.5-flash', 'google/gemini-2.5-pro');
    }
    if (getProviderKey('perplexity')) {
      allModels.push('perplexity/sonar-pro', 'perplexity/sonar');
    }
  }

  const sorted = allModels.sort();

  // Never cache an empty result — that would pin a broken list for the full
  // TTL. Return it uncached so the next call retries.
  if (sorted.length === 0) {
    console.error('[gateway] listModels found no models — not caching, will retry');
    return sorted;
  }
  // Nor a list built from the quick live probes alone (discovery had nothing yet): it is short and would
  // be served for five minutes while discovery finishes. Return it uncached; the next call gets the real list.
  if (!haveDiscovery) {
    console.warn(`[gateway] listModels served ${sorted.length} probed models without a discovery cache — not caching`);
    return sorted;
  }

  _modelsCache = sorted;
  _modelsCacheTime = now;
  return _modelsCache;
}

// ── Image Support Detection ─────────────────────────────────────────────

function supportsImages(model) {
  const { provider } = resolveProvider(model);
  // Perplexity doesn't accept image content blocks.
  // All other providers: pass images through and let the model decide.
  // LM Studio and Ollama serve many vision-capable models (Qwen3, LLaVA, etc.)
  // — blocking images here silently strips them before the model ever sees them.
  if (provider === 'perplexity') return false;
  // OpenRouter knows each model's inputs; unknown models (not in the catalogue yet) keep their images.
  if (provider === 'openrouter') { try { const m = require('./openrouter').getOpenRouter().info(model); if (m) return !!m.images; } catch { /* no catalogue */ } }
  return true;
}

// ── Exports ─────────────────────────────────────────────────────────────

module.exports = {
  chatCompletion,
  chatCompletionStream,
  parseSSEStream,
  listModels,
  invalidateModelsCache,
  resolveProvider,
  supportsImages,
  GATEWAY_URL,
  getHeaders,
  PROVIDER_URLS,
  transportFor,
  isCyberModel,
  sanitizeTools, // exported for context-size diagnostics (scripts/context-audit.js)
  convertToAnthropicMessages, createAnthropicStreamAdapter, anthropicUsage, applyAnthropicCache, openAiCacheKey, promptCacheSettings, applyEffort, effortRoute,   // exported for tests
};
