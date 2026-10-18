'use strict';
// classifier.js — the optional "decider" behind Auto model: which kind of work is this prompt, so the right
// model handles it. OFF by default (backend "builtin" keeps today's chain untouched). Owner settings in
// settings.autoClassifier:
//   backend         builtin | local | perplexity | local+perplexity      (default builtin)
//   localProvider   ninfer | lmstudio | ollama | auto (first reachable)  (default auto)
//   localModel      model id on that server (default: the server's first/only model)
//   localThinking   true: let the local model think briefly (~0.5 s, accurate); false: ~0.15 s, weaker  (default true)
//   confidenceFloor 0..1: below it the agent's own model is used (default 0.6)
//   shadow          true: log the verdict, change nothing (default false)
//   keepOnBox       agent names whose prompts never go to a hosted classifier (default: none listed; agents whose
//                   folder grants include a team folder such as medical/ or legal/ are always kept on the box)
// Per agent: minModel (never route below this family), fallbackModel/allowed lists as before.
// Every backend that is unreachable or unconfigured falls through to the next and finally to builtin; a turn
// never fails because of the classifier. Verdicts are tallied (stats()) so a shadow week can be judged.

const CATEGORIES = ['simple', 'code', 'math', 'vision', 'reasoning', 'hardest'];
const DEFINITIONS = {
  simple: 'quick lookups, yes/no, reformatting, short factual answers, trivial arithmetic',
  code: 'writing, debugging or reviewing code, scripts, queries, config',
  math: 'non-trivial math, logic puzzles, proofs',
  vision: 'analyzing an image',
  reasoning: 'architecture, strategy, design, analysis, planning; the default for substantive work',
  hardest: 'deep ambiguity, high-stakes or irreversible decisions (real money, trading, production systems, deployments), novel problems with no clear approach',
};
const DEFAULTS = { backend: 'builtin', localProvider: 'auto', localModel: '', localThinking: true, confidenceFloor: 0.6, shadow: false, keepOnBox: null };
const FAMILY_RANK = { haiku: 1, sonnet: 2, opus: 3, fable: 4 };
const LOCAL_PROVIDERS = ['local', 'ninfer', 'lmstudio', 'ollama'];

function familyOf(modelId) {
  const id = String(modelId || '').replace(/^[a-z-]+\//, '').replace(/\[1m\]$/i, '').replace(/^claude-/, '').toLowerCase();
  if (id === 'default' || /^opus/.test(id)) return 'opus';
  if (/^(fable|mythos)/.test(id)) return 'fable';
  if (/^sonnet/.test(id)) return 'sonnet';
  if (/^haiku/.test(id)) return 'haiku';
  return null;
}
function definitionsText() { return CATEGORIES.map(c => `${c} = ${DEFINITIONS[c]}`).join('\n'); }
function pickCategory(text) { const t = String(text || '').toLowerCase(); return CATEGORIES.find(c => new RegExp(`\\b${c}\\b`).test(t)) || null; }

/** An agent with a sensitive team folder (medical/, legal/) in its own folder grants never goes to a hosted classifier. */
function sensitiveAgent(agent) { try { return !!require('./tool-policy').teamFolderOf(agent); } catch { return false; } }

function createClassifier({ getSetting = () => undefined, getProviderKey = () => null, getProviderUrl = () => null, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), log = console.log, keepOnBoxDefault = () => [] } = {}) {
  const stats = { since: new Date(now()).toISOString(), turns: 0, byBackend: {}, byCategory: {}, shadow: 0, floored: 0, lifted: 0, errors: {}, agree: 0, disagree: 0 };
  const RECENT_MAX = 100;
  const recent = [];   // the last verdicts, newest first: what the Settings page shows as "recent verdicts"

  function config() {
    const s = getSetting('autoClassifier') || {};
    const c = { ...DEFAULTS, ...s };
    if (!['builtin', 'local', 'perplexity', 'local+perplexity'].includes(c.backend)) c.backend = 'builtin';
    const f = Number(c.confidenceFloor); c.confidenceFloor = Number.isFinite(f) && f >= 0 && f <= 1 ? f : DEFAULTS.confidenceFloor;
    c.keepOnBox = Array.isArray(s.keepOnBox) ? s.keepOnBox.map(String) : keepOnBoxDefault();
    return c;
  }
  const enabled = () => config().backend !== 'builtin';
  // Shadow mode watches EVERY turn of every agent (not only agents with Auto model on), so the tally fills up
  // before anyone switches Auto model on. The dispatcher calls shadowAll() to decide whether to run a verdict
  // for an agent that is not on Auto model; such a verdict is logged and tallied and never applied.
  const shadowAll = () => { const c = config(); return c.backend !== 'builtin' && !!c.shadow; };

  // ── backends ──
  async function localServer(c) {
    const order = c.localProvider && c.localProvider !== 'auto' ? [c.localProvider] : LOCAL_PROVIDERS;
    for (const p of order) {
      const url = getProviderUrl(p); if (!url) continue;
      try {
        const r = await fetchImpl(`${String(url).replace(/\/+$/, '')}/models`, { signal: AbortSignal.timeout(2000) });
        if (!r.ok) continue;
        const data = await r.json();
        const ids = (data.data || []).map(m => m.id);
        if (!ids.length) continue;
        const model = c.localModel && ids.includes(c.localModel) ? c.localModel : ids[0];
        return { provider: p, url: String(url).replace(/\/+$/, ''), model };
      } catch { /* next */ }
    }
    return null;
  }
  async function classifyLocal(text, c) {
    const srv = await localServer(c);
    if (!srv) throw new Error('no local model server reachable');
    const t0 = now();
    const user = `Which category fits this prompt best?\n${definitionsText()}\n\nPrompt: "${text}"\n${c.localThinking ? 'Think briefly, then answer with the category word only.' : 'Answer with the category word only.'}`;
    const body = c.localThinking
      ? { model: srv.model, max_tokens: 400, messages: [{ role: 'user', content: user }] }
      : { model: srv.model, max_tokens: 10, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: 'user', content: user }],
          response_format: { type: 'json_schema', json_schema: { name: 'r', schema: { type: 'object', properties: { category: { type: 'string', enum: CATEGORIES } }, required: ['category'], additionalProperties: false } } } };
    const r = await fetchImpl(`${srv.url}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${srv.provider}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`${srv.provider} ${r.status}`);
    const j = await r.json();
    const content = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
    // the answer is the LAST category word in the visible text (thinking may mention several)
    const words = content.toLowerCase().replace(/<think>[\s\S]*?<\/think>/g, '').match(/\b(simple|code|math|vision|reasoning|hardest)\b/g);
    let category = words ? words[words.length - 1] : null;
    if (!category && c.localThinking) {
      // The model spent its whole budget thinking and never answered (seen once in sixteen): ask again with thinking
      // off and the answer constrained to the six words, which always returns one.
      const r2 = await fetchImpl(`${srv.url}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${srv.provider}` }, signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ model: srv.model, max_tokens: 10, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: 'user', content: user.replace(/Think briefly, then answer/, 'Answer') }],
          response_format: { type: 'json_schema', json_schema: { name: 'r', schema: { type: 'object', properties: { category: { type: 'string', enum: CATEGORIES } }, required: ['category'], additionalProperties: false } } } }) });
      if (r2.ok) { const j2 = await r2.json(); const c2 = String((j2.choices && j2.choices[0] && j2.choices[0].message && j2.choices[0].message.content) || ''); category = pickCategory(c2); }
    }
    if (!category) throw new Error(`${srv.provider} gave no category: ${content.slice(0, 80)}`);
    return { category, confidence: null, backend: `local:${srv.provider}/${srv.model}`, ms: now() - t0 };
  }
  async function classifyPerplexity(text, c) {
    const key = getProviderKey('perplexity');
    if (!key) throw new Error('no Perplexity key');
    const t0 = now();
    const criteria = {}; for (const k of CATEGORIES) criteria[k] = DEFINITIONS[k];
    const r = await fetchImpl('https://api.perplexity.ai/v1/decisions', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'pplx-decider-v1.1-27b', state: `A user sent this prompt to an AI assistant:\n\n${text}`, questions: { category: { type: 'choice', instructions: 'Which kind of model should handle this prompt?', criteria } } }), signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`perplexity ${r.status}`);
    const j = await r.json();
    const a = j.answers && j.answers.category;
    if (!a || !CATEGORIES.includes(a.choice)) throw new Error('perplexity gave no category');
    return { category: a.choice, confidence: typeof a.confidence === 'number' ? a.confidence : null, probabilities: a.probabilities || null, backend: 'perplexity:pplx-decider-v1.1-27b', ms: now() - t0 };
  }

  /**
   * classify({ text, hasImages, agent }) -> { category, confidence, backend, ms, offBox } or null when the configured
   * backends all failed (the caller then uses its builtin chain). Hosted backends are skipped for keep-on-box agents.
   */
  async function classify({ text, hasImages = false, agent = null } = {}) {
    const c = config();
    if (c.backend === 'builtin') return null;
    if (hasImages) return { category: 'vision', confidence: 1, backend: 'images', ms: 0 };
    const t = String(text || '').slice(0, 4000).trim();
    if (!t) return null;
    const name = agent && agent.name ? String(agent.name) : null;
    const onBox = !!(name && c.keepOnBox.includes(name)) || sensitiveAgent(agent);
    const order = c.backend === 'local' ? ['local'] : c.backend === 'perplexity' ? ['perplexity'] : ['local', 'perplexity'];
    for (const b of order) {
      if (b === 'perplexity' && onBox) { log(`[classifier] ${name}: hosted classifier skipped (keep on box)`); continue; }
      try {
        const r = b === 'local' ? await classifyLocal(t, c) : await classifyPerplexity(t, c);
        return { ...r, offBox: b === 'perplexity' };
      } catch (e) {
        stats.errors[b] = (stats.errors[b] || 0) + 1;
        log(`[classifier] ${b} failed (${e.message}); ${order.indexOf(b) < order.length - 1 ? 'trying the next backend' : 'using the builtin chain'}`);
      }
    }
    return null;
  }

  /**
   * guard({ model, category, confidence, backend }, agent, routes) -> { model, category, confidence, backend, shadow, applied, reason }
   * Floor: a confidence below confidenceFloor keeps the agent's own model. minModel: never route below the agent's
   * minimum family. Shadow: nothing is applied; the verdict is logged and tallied.
   */
  function guard(verdict, agent = null, { fallbackModel = null, builtinCategory = null } = {}) {
    const c = config();
    const out = { ...verdict, applied: true, reason: null, shadow: !!c.shadow };
    stats.turns++; stats.byBackend[verdict.backend] = (stats.byBackend[verdict.backend] || 0) + 1; stats.byCategory[verdict.category] = (stats.byCategory[verdict.category] || 0) + 1;
    if (builtinCategory) { if (builtinCategory === verdict.category) stats.agree++; else stats.disagree++; }
    if (verdict.confidence != null && verdict.confidence < c.confidenceFloor) { out.applied = false; out.reason = `confidence ${verdict.confidence.toFixed(2)} below the floor ${c.confidenceFloor}`; stats.floored++; }
    const min = agent && agent.minModel ? String(agent.minModel) : null;
    if (out.applied && min && out.model) {
      const have = FAMILY_RANK[familyOf(out.model)] || 0, need = FAMILY_RANK[familyOf(min)] || 0;
      if (need && have && have < need) { out.model = min; out.reason = `lifted to the agent's minimum ${min}`; stats.lifted++; }
    }
    if (c.shadow) { out.applied = false; stats.shadow++; }
    const wouldPick = out.model;
    if (!out.applied && !out.shadow) out.model = fallbackModel || null;
    recent.unshift({ ts: new Date(now()).toISOString(), agent: agent && agent.name ? agent.name : null, category: out.category, builtinCategory: builtinCategory || null, backend: out.backend, confidence: out.confidence == null ? null : out.confidence, ms: out.ms == null ? null : out.ms, wouldPick, ran: out.applied ? out.model : (fallbackModel || null), applied: out.applied, shadow: out.shadow, reason: out.reason });
    if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
    return out;
  }

  function statsSnapshot() { return { ...stats, recent: recent.slice(), config: config() }; }
  function resetStats() { for (const k of ['turns', 'shadow', 'floored', 'lifted', 'agree', 'disagree']) stats[k] = 0; stats.byBackend = {}; stats.byCategory = {}; stats.errors = {}; stats.since = new Date(now()).toISOString(); recent.length = 0; }
  async function probeAll({ text, agent = null } = {}) {
    // every backend side by side, for the Settings page's "try it" box; keep-on-box is honoured
    const out = {}; const c = config();
    const name = agent && agent.name ? String(agent.name) : null; const onBox = !!(name && c.keepOnBox.includes(name)) || sensitiveAgent(agent);
    try { out.local = await classifyLocal(String(text || '').slice(0, 4000), c); } catch (e) { out.local = { error: e.message }; }
    if (onBox) out.perplexity = { skipped: 'keep on box' }; else { try { out.perplexity = await classifyPerplexity(String(text || '').slice(0, 4000), c); } catch (e) { out.perplexity = { error: e.message }; } }
    return out;
  }

  return { CATEGORIES, DEFINITIONS, config, enabled, shadowAll, classify, guard, familyOf, stats: statsSnapshot, resetStats, probeAll, localServer };
}

let shared = null;
function getClassifier() {
  if (shared) return shared;
  const settings = require('./settings');
  shared = createClassifier({
    getSetting: (k, d) => { try { return typeof settings.getSetting === 'function' ? settings.getSetting(k, d) : d; } catch { return d; } },
    getProviderKey: (p) => { try { return settings.getProviderKey(p); } catch { return null; } },
    getProviderUrl: (p) => { try { return settings.getProviderUrl(p); } catch { return null; } },
    keepOnBoxDefault: () => [],
  });
  return shared;
}

module.exports = { createClassifier, getClassifier, CATEGORIES, DEFINITIONS, DEFAULTS, FAMILY_RANK, familyOf };
