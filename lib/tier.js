'use strict';
/**
 * Speed and price tier: one per-agent setting (agent.tier), translated for the routes that have one.
 *   'standard' (or unset) = send nothing: the provider's normal speed and price.
 *   'fast'    = quicker answers at about twice the price (OpenAI / Gemini / OpenRouter `service_tier: "priority"`;
 *               Codex config `service_tier = "fast"`, which uses 2 to 2.5 times as much of the ChatGPT plan).
 *   'economy' = about half the price, can take minutes (`service_tier: "flex"`); API routes only.
 * Routes come from lib/effort routeOf. Claude client, Anthropic API, local servers and everything else get nothing:
 * Anthropic's `speed: "fast"` is beta-only and model-limited with unconfirmed pricing, so it is left out on purpose.
 * A saved tier the agent's current model does not support is ignored (null), never an error.
 * Pure: no data access.
 */

const TIERS = ['standard', 'fast', 'economy'];

function normalize(v) { const s = String(v || '').toLowerCase().trim(); return TIERS.includes(s) ? s : 'standard'; }

const API_ROUTES = new Set(['openai-api', 'gemini-api', 'openrouter-api']);

// By provider, not by the reasoning-effort rules: a tier is about speed and price, so every model of these providers
// can ask for one (a model that does not take the tier it asked for falls back to Standard once, with a notice).
function routeName(model) {
  const m = String(model || '');
  const p = m.includes('/') ? m.split('/')[0] : '';
  if (p === 'openai') return 'openai-api';
  if (p === 'google') return 'gemini-api';
  if (p === 'openrouter') return 'openrouter-api';
  if (p === 'codex-cli') return 'codex-client';
  return 'none';
}

/** The tiers the model's route supports (the pickers offer these). */
function tiersFor(model) {
  const route = routeName(model);
  if (API_ROUTES.has(route)) return ['standard', 'fast', 'economy'];
  if (route === 'codex-client') return ['standard', 'fast'];
  return ['standard'];
}

const LABELS = {
  standard: 'Standard',
  fast: 'Fast: quicker answers, about twice the price',
  economy: 'Economy: half price, can take minutes; best for scheduled and background work',
};
const CODEX_LABELS = { ...LABELS, fast: 'Fast: uses 2 to 2.5 times as much of the ChatGPT plan' };

/** The label set for the model's picker. */
function labelsFor(model) { return routeName(model) === 'codex-client' ? { ...CODEX_LABELS } : { ...LABELS }; }

/**
 * forModel(model, tier) -> what to send, or null (nothing).
 *   API routes: { field: 'service_tier', value: 'priority' | 'flex' }
 *   Codex fast: { codexConfig: 'fast' }
 */
function forModel(model, tier) {
  const t = normalize(tier);
  if (t === 'standard') return null;
  if (!tiersFor(model).includes(t)) return null;
  if (routeName(model) === 'codex-client') return { codexConfig: 'fast' };
  return { field: 'service_tier', value: t === 'fast' ? 'priority' : 'flex' };
}

/** Is this request sent as flex (Economy)? Flex answers can take minutes, so they get longer idle and header allowances. */
function isFlex(v) { return !!v && v.field === 'service_tier' && v.value === 'flex'; }

/**
 * Price multiplier by the tier the provider REPORTED (it can differ from the one asked for); with none reported, by the
 * tier asked for. priceFactor(provider, reportedTier, requestedTier). The provider argument is for callers; every
 * provider the hub supports prices a tier the same way.
 */
function priceFactor(provider, reportedTier, requestedTier) {
  const r = String(reportedTier || '').toLowerCase().trim();
  if (r) {
    if (r === 'priority' || r === 'fast') return 2.0;
    if (r === 'flex') return 0.5;
    return 1.0;   // default / standard / auto / scale / anything else
  }
  const q = normalize(requestedTier);
  return q === 'fast' ? 2.0 : q === 'economy' ? 0.5 : 1.0;
}

/** The tier to write on a ledger row: the reported one, else the requested one; null for standard. */
function ledgerTier(reportedTier, requestedTier) {
  const r = String(reportedTier || '').toLowerCase().trim();
  if (r) {
    if (r === 'priority' || r === 'fast') return 'fast';
    if (r === 'flex') return 'economy';
    return null;
  }
  const q = normalize(requestedTier);
  return q === 'standard' ? null : q;
}

/**
 * One model call's booking: the estimated base cost times the factor of the tier the provider reported (else the
 * requested one). `tier` is what the ledger row records (null for Standard). A cost the provider itself reported
 * (OpenRouter usage.cost) is not passed through here: it already reflects the tier.
 */
function bookCall(baseCost, provider, reportedTier, requestedTier) {
  const factor = priceFactor(provider, reportedTier, requestedTier);
  return { factor, cost: baseCost == null ? null : Number(baseCost) * factor, tier: ledgerTier(reportedTier, requestedTier) };
}

/**
 * One model call's usage (OpenAI shape) priced for the tier it ran on: { base, scaled, factor, tier }. base = the price-table
 * estimate (null when the model has no price), scaled = base * factor. The turn adds these up and the ledger gets the ratio.
 */
function bookUsage(model, usage, reportedTier, requestedTier) {
  const u = usage || {};
  const inT = Number(u.prompt_tokens) || 0;
  let outT = Number(u.completion_tokens) || 0;
  if (Number(u.total_tokens) > inT + outT) outT = Number(u.total_tokens) - inT;   // Gemini leaves thinking tokens out of completion_tokens
  const cr = Number(u.cache_read_input_tokens) || Number(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
  const cw = Number(u.cache_creation_input_tokens) || 0;
  let base = null;
  try { base = require('./ledger').estimateCost(model, Math.max(0, inT - cr - cw), outT, { cacheRead: cr, cacheWrite: cw }); } catch { base = null; }
  const b = bookCall(base, String(model || '').split('/')[0], reportedTier, requestedTier);
  return { base, scaled: base == null ? null : b.cost, factor: b.factor, tier: b.tier };
}

const FALLBACK_CAPACITY_RE = /resource.{0,20}unavailable|capacity|flex/i;
// Gemini sheds flex with 503 { status: "UNAVAILABLE", message: "This model is currently experiencing high demand..." }
// (seen on a real Economy call while Standard answered on the same model seconds earlier).
const FLEX_SHED_RE = /\bUNAVAILABLE\b|high\s+demand|overloaded|capacity/i;
// A bare "priority" or "flex" anywhere in an error body (a tool parameter, a model id) is not enough: the word must come
// with an explicit refusal ("flex is not available", "does not support the requested tier") or the service_tier
// parameter must be named. A bare "not" or "allowed" is no refusal: "'priority' is not valid" and "priority is allowed
// only for objects" are schema errors.
const REFUSAL = String.raw`(?:(?:not|isn't|aren't|wasn't)\s+(?:(?:currently|yet|presently)\s+)?(?:supported|available|allowed|permitted|enabled)|unsupported|unavailable|(?:does\s+not|do\s+not|doesn't|don't)\s+(?:currently\s+)?support|cannot\s+be\s+used)`;
// The tier word and the refusal within 60 characters, in either order, across line breaks.
const near = (terms) => String.raw`(?:${terms})[\s\S]{0,60}?\b${REFUSAL}\b|\b${REFUSAL}\b[\s\S]{0,60}?(?:${terms})`;
const FALLBACK_TIER_RE = new RegExp(String.raw`service[_ ]?tier|${near(String.raw`\b(?:flex|priority|tier)\b`)}`, 'i');
// Codex reports no HTTP status, only the error text: a refusal that names the service tier, fast mode or priority.
const CODEX_TIER_REFUSED_RE = new RegExp(String.raw`${near(String.raw`service[_ ]?tier|fast[ _-]?mode|\bpriority\b`)}|(?:unknown\s+variant|invalid\s+value|unknown\s+(?:config|key|field))[\s\S]{0,300}?service[_ ]?tier`, 'i');

/**
 * Should a request refused for its tier be sent once more on Standard? Only before any output, only once, and only for
 * the refusals a tier causes: 429 whose message says resource unavailable / capacity / flex, or 400/403/404 whose
 * message names service_tier, or flex / priority / tier together with a refusal; for Economy (flex) only, also 503
 * unavailable / high demand / overloaded (a provider shedding flex load). `tier` is the REQUESTED agent tier
 * (standard never falls back; a 503 on Fast stays the ordinary server error).
 */
function tierFallback({ tier, status, message, sawOutput, already } = {}) {
  if (normalize(tier) === 'standard' || sawOutput || already) return false;
  const msg = String(message || '');
  const s = Number(status);
  if (s === 429) return FALLBACK_CAPACITY_RE.test(msg);
  if (s === 503) return normalize(tier) === 'economy' && FLEX_SHED_RE.test(msg);
  if (s === 400 || s === 403 || s === 404) return FALLBACK_TIER_RE.test(msg);
  return false;
}

/** Codex Fast refused (`sent` is the config value that went out, null when none): once more without it. */
function codexTierFallback({ sent, sawOutput, message, already } = {}) {
  return !!sent && !sawOutput && !already && CODEX_TIER_REFUSED_RE.test(String(message || ''));
}

/** The line that starts a reply that ran on Standard instead. */
function fallbackNotice(tier) {
  return `This answer ran on Standard because ${normalize(tier) === 'economy' ? 'Economy' : 'Fast'} wasn't available.`;
}

module.exports = { TIERS, LABELS, CODEX_LABELS, normalize, tiersFor, labelsFor, forModel, isFlex, priceFactor, ledgerTier, bookCall, bookUsage, tierFallback, codexTierFallback, fallbackNotice };
