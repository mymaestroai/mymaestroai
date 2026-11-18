'use strict';
/**
 * Reasoning effort: one per-agent setting (agent.effort), translated for every route the hub uses.
 *   'default' (or unset) = send nothing: the model / client keeps its own default.
 *   'low' | 'medium' | 'high' | 'xhigh' | 'max' = how hard the model thinks before answering.
 * Levels a provider does not have are mapped to the nearest one it has: Claude (client and API) takes all five;
 * OpenAI depends on the model (OpenAI reasoning guide, 2026-11): the GPT-5.6 and GPT-6 families take low..max,
 * gpt-5.5-pro only medium..xhigh, other reasoning models low..xhigh; Codex models take the levels their own
 * catalog lists (`codex debug models`, setCodexLevels), with the same family rule until the catalog is read.
 * A level above a model's top goes down to the top; one below its lowest goes up to the lowest (never refused).
 * Gemini takes low..high; older non-reasoning OpenAI models reject the field, so they get nothing.
 * Local servers (NInfer, LM Studio, Ollama, oMLX) get nothing. Codex's "ultra" (parallel sub-agents) is not a
 * hub level and is never sent.
 */

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const LABELS = { default: 'Default', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

function normalize(v) { const s = String(v || '').toLowerCase().trim(); return LEVELS.includes(s) ? s : 'default'; }

const cap = (level, allowed) => {
  if (allowed.includes(level)) return level;
  const i = LEVELS.indexOf(level);
  for (let j = i; j >= 0; j--) if (allowed.includes(LEVELS[j])) return LEVELS[j];
  return null;
};
// Down to the nearest level the model has; below its lowest level, up to that lowest one (e.g. gpt-5.5-pro: low -> medium).
const fit = (level, allowed) => {
  const c = cap(level, allowed);
  if (c) return c;
  for (const l of LEVELS) if (allowed.includes(l)) return l;
  return null;
};

// Codex model slug -> the hub levels its catalog lists (filled by lib/model-discovery from `codex debug models`).
const codexLevels = new Map();
function setCodexLevels(models) {
  for (const m of Array.isArray(models) ? models : []) {
    if (!m || !m.id || !Array.isArray(m.levels)) continue;
    const ls = LEVELS.filter((l) => m.levels.includes(l));
    if (ls.length) codexLevels.set(String(m.id).toLowerCase(), ls); else codexLevels.delete(String(m.id).toLowerCase());
  }
}

// OpenAI levels by model family (API, and Codex before its catalog has been read).
function openaiLevels(name) {
  if (/^gpt-5\.5-pro/.test(name)) return ['medium', 'high', 'xhigh'];
  if (/^(gpt-5\.6|gpt-6)/.test(name)) return ['low', 'medium', 'high', 'xhigh', 'max'];
  return ['low', 'medium', 'high', 'xhigh'];
}

/** Which route a model id takes, for effort purposes. */
function routeOf(model) {
  const m = String(model || '');
  const p = m.includes('/') ? m.split('/')[0] : '';
  const name = (m.includes('/') ? m.slice(m.indexOf('/') + 1) : m).toLowerCase();
  if (p === 'claude-sdk') return { route: 'claude-client', name };
  if (p === 'codex-cli') return { route: 'codex-client', name };
  if (p === 'anthropic') return { route: 'anthropic-api', name };
  if (p === 'openai') return { route: /^(gpt-5|gpt-6|o[1-9])/.test(name) ? 'openai-api' : 'none', name };
  if (p === 'google') return { route: /gemini-(2\.5|[3-9])|gemini-(pro|flash)(-lite)?-latest/.test(name) ? 'gemini-api' : 'none', name };
  if (p === 'openrouter') {   // OpenRouter's catalogue says which models take a reasoning level
    let reasons = false;
    try { const m = require('./openrouter').getOpenRouter().info(name); reasons = !!(m && m.reasoning); } catch { /* no catalogue */ }
    return { route: reasons ? 'openrouter-api' : 'none', name };
  }
  return { route: 'none', name };
}

/** Does choosing an effort level change anything for this model? (the pickers hide themselves when not) */
function supported(model) { return routeOf(model).route !== 'none'; }

/**
 * forModel(model, level) -> the provider's value, or null (send nothing).
 *   claude-client: Agent SDK query option `effort`
 *   codex-client:  Codex config `model_reasoning_effort`
 *   anthropic-api: Messages API `output_config.effort`
 *   openai-api:    `reasoning_effort` (chat) / `reasoning.effort` (Responses)
 *   gemini-api:    `reasoning_effort` (OpenAI-compatible endpoint)
 *   openrouter-api: `reasoning: { effort }` (lib/openrouter converts it), low..high
 */
function forModel(model, level) {
  const l = normalize(level);
  if (l === 'default') return null;
  const { route, name } = routeOf(model);
  if (route === 'claude-client' || route === 'anthropic-api') return l;
  if (route === 'openai-api') return fit(l, openaiLevels(name));
  if (route === 'codex-client') return fit(l, codexLevels.get(name) || openaiLevels(name));
  if (route === 'gemini-api' || route === 'openrouter-api') return cap(l, ['low', 'medium', 'high']);
  return null;
}

/** The one level a person may ask for on a single turn (the Simple page's reasoning picker). Anything else -> null. */
const TURN_LEVELS = ['low', 'medium', 'high', 'max'];
function requestedLevel(v) { const s = typeof v === 'string' ? v.toLowerCase().trim() : ''; return TURN_LEVELS.includes(s) ? s : null; }

/**
 * forTurn(model, requested, agentLevel) -> the provider value for THIS turn. A valid request replaces the agent's
 * stored level only when the model takes a level at all (else it is ignored); the result is still capped by
 * forModel, so nobody can ask for more than the model supports. Never writes the agent's setting.
 */
function forTurn(model, requested, agentLevel) {
  const r = requestedLevel(requested);
  return forModel(model, r && supported(model) ? r : agentLevel);
}

module.exports = { TURN_LEVELS, requestedLevel, forTurn, LEVELS, LABELS, normalize, routeOf, supported, forModel, setCodexLevels };
