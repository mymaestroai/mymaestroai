'use strict';

/**
 * model-quirks.js — Central per-model capability + quirk registry
 *
 * Single source of truth for:
 *   - max output token caps (Bedrock/Vertex/OpenAI reject over-limit requests)
 *   - unsupported request params (temperature, max_tokens, top_p ...)
 *   - param renames (max_tokens -> max_completion_tokens for o-series)
 *   - tool-schema strictness tier
 *   - API family (chat completions vs responses-only)
 *
 * Rules are matched by regex against the model id, first match wins.
 * Add new models HERE, not scattered through sdk-chat.js / gateway-client.js.
 */

// Order matters — most specific patterns first.
// All `out` values are GATEWAY-VERIFIED maximums (probed 2026-08-06).
// Every model gets its real ceiling — no artificial "safety margins".
const RULES = [
  // ── NInfer (local, RTX 5090): Qwen3.8 with thinking. The server applies the model's own sampler
  // defaults (temperature 1.0, top_p 0.95, top_k 20 in thinking mode) unless the request overrides,
  // so send none. Output ceiling = the server's --default-max-tokens (131072); thinking counts in it.
  // ── Local models via the hub's proxy (lib/local-models): llama.cpp / NInfer / custom; sampler left to the engine.
  { re: /^local\//i, out: 131072, schema: 'openai', reasoning: true },
  { re: /^ninfer\//i, out: 131072, schema: 'openai', drop: ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty'], reasoning: true },

  // ── OpenAI Responses-API-only (400 on /v1/chat/completions) ──────────
  // Both reject explicit temperature/top_p (reasoning models).  Verified direct 2026-09-08.
  { re: /codex/i,                    api: 'responses', out: 128000, schema: 'openai', drop: ['temperature', 'top_p'], reasoning: true },
  { re: /^(o3|gpt-5(\.\d+)?)-pro$/i, api: 'responses', out: 128000, schema: 'openai', drop: ['temperature', 'top_p'], reasoning: true },

  // ── OpenAI reasoning models (o-series) ───────────────────────────────
  // Reject temperature/top_p; use max_completion_tokens instead of max_tokens.
  // Gateway-verified: o4-mini accepts 100000, rejects 200000.
  { re: /^o[0-9]/i, out: 100000, schema: 'openai', reasoning: true,
    drop: ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty'],
    rename: { max_tokens: 'max_completion_tokens' },
    parallelTools: false },

  // ── OpenAI GPT ───────────────────────────────────────────────────────
  // gpt-5-chat: needs max_completion_tokens (not max_tokens). Gateway-verified 128000.
  { re: /gpt-5-chat/i, out: 128000, schema: 'openai', drop: ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty'], rename: { max_tokens: 'max_completion_tokens' }, reasoning: true },
  // gpt-5.5 / gpt-5.6-* only accept the default temperature (1).  Any explicit
  // value — including 0 — returns 400 "Unsupported value: 'temperature'".
  // Verified live 2026-08-05 for luna / terra / sol / 5.5.  gpt-5 (plain) is fine.
  // Gateway-verified: 128000 OK, 200000 rejected.
  // gpt-6 / gpt-daybreak / chat-latest: same reasoning-model contract as
  // gpt-5.5+ (only default temperature).  Verified live on api.openai.com 2026-09-08.
  // Also rejects max_tokens on gateway - must use max_completion_tokens.
  // Verified 2026-09-17: gateway returns 400 "Unsupported parameter: 'max_tokens'".
  // api:'responses' -> gateway-client routes these to /v1/responses.  OpenAI
  // rejects function tools + reasoning_effort on /v1/chat/completions for
  // gateway-example, and LiteLLM injects reasoning_effort regardless of what we
  // send (omitting it, 'none', 'minimal', 'low' all 400 - verified live 2026-09-17).
  // /v1/responses with tools returns 200 + tool_calls, streaming too.
  { re: /^(gpt-6|gpt-daybreak|chat-latest)/i, api: 'responses', out: 128000, schema: 'openai', drop: ['temperature', 'top_p'], rename: { max_tokens: 'max_completion_tokens' }, reasoning: true },
  // gpt-5.6 (sol, luna, ...): OpenAI rejects function tools on /v1/chat/completions even when no
  // reasoning_effort is sent; /v1/responses accepts them. gpt-5.5, gpt-5.4-mini and o3 are fine on
  // chat/completions. Verified live on api.openai.com 2026-09-21.
  { re: /gpt-5\.6/i, api: 'responses', out: 128000, schema: 'openai', drop: ['temperature', 'top_p'], reasoning: true },
  { re: /gpt-5\.[56]/i, out: 128000, schema: 'openai', drop: ['temperature', 'top_p'], reasoning: true },
  { re: /gpt-5/i,      out: 128000, schema: 'openai', reasoning: true },
  // gpt-4o: hard limit 16384. Gateway-verified: 32768 rejected.
  { re: /gpt-4/i,      out: 16384,  schema: 'openai' },
  { re: /gpt/i,        out: 128000, schema: 'openai' },

  // ── Anthropic ────────────────────────────────────────────────────────
  // Gateway-verified 2026-08-06: opus-5, fable-5, sonnet-5 all accept 128000.
  // haiku-4-5 routes through Vertex which caps at 64000 (65536 rejected).
  // minOut: sonnet-5 burns internal reasoning tokens before emitting any text —
  // a small max_tokens returns finish_reason=length with content=null.
  { re: /opus/i,    out: 128000, schema: 'anthropic' },
  { re: /fable/i,   out: 128000, schema: 'anthropic' },
  { re: /sonnet-5/i, out: 128000, schema: 'anthropic', minOut: 512, reasoning: true },
  { re: /sonnet/i,  out: 128000, schema: 'anthropic' },
  { re: /haiku/i,   out: 64000,  schema: 'anthropic' },

  // ── Google ───────────────────────────────────────────────────────────
  // Vertex is the strictest on JSON Schema — flatten aggressively.
  // Gateway-verified: 65536 OK, 128000 rejected for both flash and pro.
  // Gemini 3.x flash spends ~120 reasoning tokens before its first text token.
  { re: /gemini-3\.\d+-flash/i, out: 65536, schema: 'vertex', minOut: 512, reasoning: true },
  { re: /gemini/i,              out: 65536, schema: 'vertex', minOut: 512, reasoning: true },

  // ── xAI ──────────────────────────────────────────────────────────────
  // Gateway-verified: 500000 accepted.  Using 131072 as practical max.
  { re: /grok/i, out: 131072, schema: 'openai', reasoning: true },

  // ── Others ───────────────────────────────────────────────────────────
  { re: /mythos/i,    out: 128000, schema: 'anthropic' },
  // Kimi k2.5: gateway-verified 260000 OK, 262144 rejected.
  { re: /kimi/i,      out: 260000, schema: 'openai', reasoning: true },
  { re: /deepseek/i,  out: 32000,  schema: 'openai', reasoning: true },
  { re: /glm/i,       out: 32000,  schema: 'openai', reasoning: true },
  { re: /qwen/i,      out: 32000,  schema: 'openai' },
  { re: /nemotron/i,  out: 32000,  schema: 'openai' },
  { re: /llama/i,     out: 32000,  schema: 'openai' },
];

const DEFAULT = { out: 32000, schema: 'openai', api: 'chat' };

const _cache = new Map();

function quirks(model) {
  // Hub-side namespace for direct-key models (lib/cyber-models.js) - the
  // rules are keyed on the upstream id.
  const m = String(model || '').replace(/^cyber\//, '');
  if (_cache.has(m)) return _cache.get(m);
  const hit = RULES.find(r => r.re.test(m));
  const q = {
    model: m,
    api: (hit && hit.api) || DEFAULT.api,
    maxOutput: (hit && hit.out) || DEFAULT.out,
    minOutput: (hit && hit.minOut) || 0,
    schema: (hit && hit.schema) || DEFAULT.schema,
    drop: (hit && hit.drop) || [],
    rename: (hit && hit.rename) || null,
    set: (hit && hit.set) || null,
    parallelTools: hit && hit.parallelTools === false ? false : true,
    // Hidden reasoning tokens are billed against max_tokens on these models.
    reasoning: !!(hit && hit.reasoning),
    // false when the model only accepts its default temperature (the param
    // is dropped from the request, so a configured value is decorative).
    acceptsTemperature: !((hit && hit.drop) || []).includes('temperature'),
    matched: !!hit,
  };
  _cache.set(m, q);
  return q;
}

/** Clamp a requested output-token count to the model's real ceiling. */
function capOutputTokens(model, requested) {
  const cap = quirks(model).maxOutput;
  if (!requested || requested > cap) return cap;
  return requested;
}

/**
 * Raise a too-small max_tokens to the model's reasoning floor.
 * Reasoning models (sonnet-5, gemini-3.x) consume internal reasoning tokens
 * BEFORE emitting any text.  Asking for max_tokens=8 returns
 * finish_reason=length with content=null — a silent empty response.
 */
function floorOutputTokens(model, requested) {
  const q = quirks(model);
  if (!q.minOutput || !requested) return requested;
  if (requested >= q.minOutput) return requested;
  return Math.min(q.minOutput, q.maxOutput);
}

/**
 * Per-turn output budget for an agentic tool loop.
 * Reasoning models spend hidden reasoning tokens out of the same budget as
 * their visible output - a 4096 cap that is fine for Claude leaves an
 * o-series / gpt-5.x model with a few hundred tokens for its tool call and
 * truncates the JSON mid-argument.  Give them headroom; cap everyone at the
 * model's real ceiling.
 */
const TURN_BUDGET_PLAIN = 4096;
const TURN_BUDGET_REASONING = 16384;
function turnOutputTokens(model) {
  const q = quirks(model);
  const want = q.reasoning ? TURN_BUDGET_REASONING : TURN_BUDGET_PLAIN;
  return Math.max(Math.min(want, q.maxOutput), q.minOutput || 0);
}

/** Does an explicit `temperature` do anything for this model? */
function acceptsTemperature(model) {
  return quirks(model).acceptsTemperature;
}

/** Can this model be reached over /v1/chat/completions? */
function supportsChatCompletions(model) {
  return quirks(model).api === 'chat';
}

/** Does this model handle multiple tool_calls in one turn? */
function supportsParallelTools(model) {
  return quirks(model).parallelTools;
}

/**
 * Mutate an outgoing request body to satisfy model-specific constraints.
 * Drops unsupported params, applies renames, clamps max_tokens.
 * Returns { body, changes: [...] } — changes are logged once per model.
 */
const _loggedChanges = new Set();

// Direct api.openai.com (no LiteLLM in front to translate) rejects `max_tokens`
// for every gpt-5.x / gpt-6 / o-series model ("use max_completion_tokens").
// The gateway path tolerates either, so this is safe to apply whenever the
// request is going direct.  Pass { direct: true } for that.
const DIRECT_OPENAI_NEEDS_MCT = /^(gpt-5|gpt-6|gpt-daybreak|chat-latest|o[0-9])/i;

function applyQuirks(body, opts = {}) {
  const q = quirks(body.model);
  const changes = [];

  if (opts.direct && DIRECT_OPENAI_NEEDS_MCT.test(q.model) && body.max_tokens !== undefined) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
    changes.push('max_tokens→max_completion_tokens (direct openai)');
  }

  for (const key of q.drop) {
    if (body[key] !== undefined) {
      delete body[key];
      changes.push(`dropped ${key}`);
    }
  }

  if (q.rename) {
    for (const [from, to] of Object.entries(q.rename)) {
      if (body[from] !== undefined) {
        body[to] = body[from];
        delete body[from];
        changes.push(`${from}→${to}`);
      }
    }
  }

  if (q.set) {
    for (const [key, val] of Object.entries(q.set)) {
      if (body[key] !== val) {
        body[key] = val;
        changes.push(`set ${key}=${JSON.stringify(val)}`);
      }
    }
  }

  const tokKey = body.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens';
  if (body[tokKey] !== undefined && body[tokKey] > q.maxOutput) {
    changes.push(`${tokKey} ${body[tokKey]}→${q.maxOutput}`);
    body[tokKey] = q.maxOutput;
  }
  // Reasoning floor — a too-small budget is spent entirely on internal
  // reasoning tokens and returns finish_reason=length with content=null.
  if (body[tokKey] !== undefined && q.minOutput && body[tokKey] < q.minOutput) {
    const raised = Math.min(q.minOutput, q.maxOutput);
    changes.push(`${tokKey} ${body[tokKey]}→${raised} (reasoning floor)`);
    body[tokKey] = raised;
  }

  if (changes.length) {
    const sig = `${body.model}:${changes.join(',')}`;
    if (!_loggedChanges.has(sig)) {
      _loggedChanges.add(sig);
      console.log(`[quirks] ${body.model}: ${changes.join(', ')}`);
    }
  }

  return { body, changes };
}

/**
 * Known-good substitute when a model returns an unusable response
 * (e.g. HTTP 200 with finish_reason=content_filter and zero output).
 * Keep the substitute in the same capability tier where possible.
 */
const FALLBACKS = [
  [/fable/i,            'claude-opus-5'],
  [/opus/i,             'claude-sonnet-5'],
  [/sonnet/i,           'claude-fable-5-1'],
  [/haiku/i,            'claude-sonnet-5'],
  [/^gpt|^o3|^o4/i,     'claude-sonnet-5'],
  [/gemini/i,           'claude-sonnet-5'],
  [/grok|kimi|glm/i,    'claude-sonnet-5'],
];

function fallbackModelFor(model) {
  const m = String(model || '');
  for (const [re, fb] of FALLBACKS) {
    if (re.test(m)) return fb;
  }
  return 'claude-sonnet-5';
}

/** Registry introspection for diagnostics / UI. */
function listRules() {
  return RULES.map(r => ({
    pattern: r.re.source,
    maxOutput: r.out,
    minOut: r.minOut || 0,
    schema: r.schema,
    api: r.api || 'chat',
    drop: r.drop || [],
    rename: r.rename || null,
    reasoning: !!r.reasoning,
  }));
}

module.exports = {
  quirks,
  capOutputTokens,
  supportsChatCompletions,
  supportsParallelTools,
  floorOutputTokens,
  turnOutputTokens,
  acceptsTemperature,
  applyQuirks,
  fallbackModelFor,
  listRules,
};
