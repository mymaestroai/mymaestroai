'use strict';
/**
 * Reasoning effort: one per-agent setting (agent.effort), translated for every route the hub uses.
 *   'default' (or unset) = send nothing: the model / client keeps its own default.
 *   'low' | 'medium' | 'high' | 'xhigh' | 'max' = how hard the model thinks before answering.
 * Levels a provider does not have are mapped to the nearest one it has (checked against the live APIs
 * 2026-10-15): Claude (client and API) takes all five; OpenAI reasoning models take low..xhigh (no max);
 * Gemini takes low..high; older non-reasoning OpenAI models reject the field, so they get nothing.
 * Local servers (NInfer, LM Studio, Ollama, oMLX) and text-only Codex get nothing.
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
 */
function forModel(model, level) {
  const l = normalize(level);
  if (l === 'default') return null;
  const { route } = routeOf(model);
  if (route === 'claude-client' || route === 'anthropic-api') return l;
  if (route === 'openai-api' || route === 'codex-client') return cap(l, ['low', 'medium', 'high', 'xhigh']);
  if (route === 'gemini-api') return cap(l, ['low', 'medium', 'high']);
  return null;
}

module.exports = { LEVELS, LABELS, normalize, routeOf, supported, forModel };
