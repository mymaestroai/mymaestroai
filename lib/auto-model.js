// auto-model.js — Per-turn LLM autoselection.
// When an agent has autoModel enabled, a cheap classifier reads the user's
// prompt and picks the best model from a routing table for that turn only.
// Selection is NOT persisted — the agent's static `model` remains the fallback.
//
// Classifier fallback chain:
//   1. Anthropic HTTP API (haiku) — if ANTHROPIC_API_KEY is set
//   2. LM Studio local model — if reachable
//   3. Keyword-based heuristic — always works, no LLM needed

const { chatCompletion } = require('./gateway-client');
const settings = require('./settings');

const CLASSIFIER_MODEL = 'claude-haiku-4-5';

// ── Dynamic LM Studio model resolver ────────────────────────────────────
// Caches the first available LM Studio model for 60 seconds (so an LM Studio that goes
// offline stops being routed to within a minute).
// Returns a prefixed model id like "lmstudio/qwen3-8b" or null if offline.
let _lmsModel = null;
let _lmsModelTime = 0;
const LMS_CACHE_TTL = 60_000;

async function getLmStudioModel() {
  const now = Date.now();
  if (_lmsModel && (now - _lmsModelTime) < LMS_CACHE_TTL) return _lmsModel;
  try {
    const lmsUrl = settings.getProviderUrl('lmstudio');
    const resp = await fetch(`${lmsUrl}/models`, {
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) {
      const data = await resp.json();
      const first = data.data?.[0]?.id;
      if (first) {
        _lmsModel = `lmstudio/${first}`;
        _lmsModelTime = now;
        return _lmsModel;
      }
    }
  } catch {}
  _lmsModel = null;
  _lmsModelTime = now;
  return null;
}

// Gateway routes (HTTP API models). Current generation (Oct 2026); the owner can override per key in
// settings.autoModelRoutes / autoModelSdkRoutes.
const DEFAULT_ROUTES = {
  code: 'claude-sonnet-5-5',
  reasoning: 'claude-opus-5-5',
  math: 'claude-opus-5-5',
  simple: 'claude-sonnet-5-5',
  vision: 'gemini-3.1-pro-preview',
  hardest: 'claude-fable-5-1',
};

// SDK routes (Claude SDK OAuth models)
const DEFAULT_SDK_ROUTES = {
  code: 'claude-sdk/claude-sonnet-5-5',
  reasoning: 'claude-sdk/claude-opus-5-5',
  math: 'claude-sdk/claude-opus-5-5',
  simple: 'claude-sdk/claude-sonnet-5-5',
  vision: 'claude-sdk/claude-sonnet-5-5',
  hardest: 'claude-sdk/claude-fable-5-1',
};
function routesFor(sdk) {
  const base = sdk ? DEFAULT_SDK_ROUTES : DEFAULT_ROUTES;
  let ov = {};
  try { ov = (typeof settings.getSetting === 'function' && settings.getSetting(sdk ? 'autoModelSdkRoutes' : 'autoModelRoutes')) || {}; } catch { ov = {}; }
  const out = { ...base };
  for (const [k, v] of Object.entries(ov)) if (k in base && typeof v === 'string' && v.trim()) out[k] = v.trim();
  return out;
}
const ROUTES = DEFAULT_ROUTES;
const SDK_ROUTES = DEFAULT_SDK_ROUTES;

const ROUTE_KEYS = Object.keys(ROUTES);

const CLASSIFIER_SYSTEM = `You are a model router. Read the user's prompt and pick the single best category to handle it. Respond with ONLY the category word, nothing else.

Categories:
- code: writing/debugging/reviewing code, scripts, queries, config
- math: math, logic puzzles, multi-step proofs, complex calculations
- simple: quick lookups, yes/no, classification, reformatting, short factual answers
- vision: the prompt is about analyzing an image
- reasoning: architecture, strategy, design, analysis, planning, general hard thinking (DEFAULT for substantive work)
- hardest: ONLY for the most difficult problems — deep ambiguity, high-stakes decisions, novel problems with no clear approach, or where a strong model would visibly struggle. This routes to the most expensive model. Be very conservative — when unsure between "reasoning" and "hardest", ALWAYS choose "reasoning".

Output exactly one word from: code, math, simple, vision, reasoning, hardest`;

// ── Keyword-based heuristic classifier (no LLM needed) ─────────────────

const CODE_PATTERNS = /\b(code|debug|fix|function|class|import|export|const |let |var |def |return |async |await |npm|pip|git |commit|merge|PR|pull request|refactor|lint|test suite|unit test|compile|build|deploy|regex|SQL|query|schema|migration|API|endpoint|route|middleware|component|module|package|dockerfile|yaml|json|config|script)\b/i;
const MATH_PATTERNS = /\b(calculate|compute|solve|prove|equation|integral|derivative|probability|matrix|algorithm complexity|O\(n|summation|factorial|theorem|lemma|induction)\b/i;
const SIMPLE_PATTERNS = /^(what is|who is|when did|where is|how many|yes or no|true or false|define |list |name |translate )/i;

function classifyByKeywords(text, hasImages) {
  if (hasImages) return 'vision';
  if (MATH_PATTERNS.test(text)) return 'math';
  if (CODE_PATTERNS.test(text)) return 'code';
  if (SIMPLE_PATTERNS.test(text) || text.length < 60) return 'simple';
  return 'reasoning';
}

// ── LLM-based classifier with fallback chain ────────────────────────────

async function classifyPrompt(text, opts = {}) {
  const { signal } = opts;

  // Try 1: Anthropic HTTP API (haiku)
  if (settings.getProviderKey('anthropic')) {
    try {
      const resp = await chatCompletion(
        [{ role: 'user', content: text }],
        { model: CLASSIFIER_MODEL, system: CLASSIFIER_SYSTEM, max_tokens: 8, temperature: 0, signal }
      );
      const raw = (resp?.choices?.[0]?.message?.content || '').toLowerCase().trim();
      const cat = ROUTE_KEYS.find(k => raw.includes(k));
      if (cat) return cat;
    } catch (e) {
      console.log('[auto-model] HTTP classifier failed, trying LM Studio:', e.message);
    }
  }

  // Try 2: LM Studio local model
  try {
    const lmsUrl = settings.getProviderUrl('lmstudio');
    const modelsResp = await fetch(`${lmsUrl}/models`, {
      signal: AbortSignal.timeout(2000),
    });
    if (modelsResp.ok) {
      const modelsData = await modelsResp.json();
      const firstModel = modelsData.data?.[0]?.id;
      if (firstModel) {
        const lmsResp = await fetch(`${lmsUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer lm-studio' },
          body: JSON.stringify({
            model: firstModel,
            messages: [
              { role: 'system', content: CLASSIFIER_SYSTEM },
              { role: 'user', content: text },
            ],
            max_tokens: 8,
            temperature: 0,
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (lmsResp.ok) {
          const data = await lmsResp.json();
          const raw = (data.choices?.[0]?.message?.content || '').toLowerCase().trim();
          const cat = ROUTE_KEYS.find(k => raw.includes(k));
          if (cat) return cat;
        }
      }
    }
  } catch (e) {
    console.log('[auto-model] LM Studio classifier failed, using heuristic:', e.message);
  }

  // Try 3: keyword heuristic (always works)
  return null;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Classify a prompt and return the chosen model.
 * @param {string} userMessage
 * @param {object} opts - { hasImages, signal, sdk }
 *   sdk: boolean — when true, returns claude-sdk/* model names
 * @returns { model, category } or null on failure
 */
async function resolveModel(cat, routes) {
  // Deliberate: "simple" turns go to a local LM Studio model whenever one is loaded, for BOTH route
  // tables. An SDK agent (sdk:true) therefore gets a non-SDK "lmstudio/<model>" id for simple turns;
  // the caller's gateway path handles that prefix. The 60 s cache above bounds how long an LM Studio
  // that just went offline keeps being chosen.
  if (cat === 'simple') {
    const lms = await getLmStudioModel();
    if (lms) {
      console.log(`[auto-model] Routing "simple" to local LM Studio: ${lms}`);
      return lms;
    }
  }
  return routes[cat];
}

async function selectModel(userMessage, opts = {}) {
  const { hasImages = false, signal, sdk = false } = opts;
  const routes = sdk ? SDK_ROUTES : ROUTES;

  if (hasImages) {
    return { model: routes.vision, category: 'vision' };
  }

  const text = (userMessage || '').slice(0, 4000);
  if (!text.trim()) return null;

  const cat = await classifyPrompt(text, { signal });
  if (cat) return { model: await resolveModel(cat, routes), category: cat };

  // Heuristic fallback
  const heuristicCat = classifyByKeywords(text, false);
  return { model: await resolveModel(heuristicCat, routes), category: heuristicCat };
}

/**
 * Combined classifier — picks model route and tool categories in one call.
 * Falls back through the classifier chain automatically.
 */
async function selectModelAndTools(userMessage, opts = {}) {
  const { hasImages = false, signal, toolCategories = null, context = null, sdk = false, agent = null, _builtinOnly = false } = opts;
  const routes = routesFor(sdk);
  const wantTools = Array.isArray(toolCategories) && toolCategories.length > 0;

  // Images always mean the vision route (same as selectModel), no classifier call needed. The guards still apply:
  // in shadow mode the pick is logged, not applied, and an agent's minimum model is never undercut.
  if (hasImages) {
    const base = { model: routes.vision, category: 'vision', backend: 'images', applied: true, tools: wantTools ? [] : null };
    if (!_builtinOnly) {
      try {
        const classifier = require('./classifier').getClassifier();
        if (classifier.enabled()) {
          const g = classifier.guard({ model: routes.vision, category: 'vision', confidence: 1, backend: 'images', ms: 0 }, agent, { fallbackModel: agent && agent.model ? agent.model : null, builtinCategory: 'vision' });
          const who = agent && agent.name ? agent.name + ': ' : '';
          if (g.shadow) console.log(`[auto-model] SHADOW ${who}"vision" (images) would pick ${g.model}`);
          return { ...base, model: g.applied ? g.model : null, wouldPick: g.shadow ? g.model : null, shadow: g.shadow, applied: g.applied, reason: g.reason, confidence: g.confidence };
        }
      } catch {}
    }
    return base;
  }

  const text = (userMessage || '').slice(0, 4000);
  if (!text.trim()) return null;

  // The optional decider (lib/classifier; settings.autoClassifier, off by default): one constrained call to a local
  // model or Perplexity's decision model, then the guards (confidence floor, the agent's minimum model, shadow mode).
  // When it is on, the builtin chain below is only consulted for tool categories (and as the fallback if it fails).
  if (!_builtinOnly) {
    const classifier = require('./classifier').getClassifier();
    if (classifier.enabled()) {
      let verdict = null;
      try { verdict = await classifier.classify({ text, hasImages, agent }); } catch (e) { console.log('[auto-model] classifier error, builtin chain instead:', e.message); }
      if (verdict && verdict.category) {
        const builtinCat = classifyByKeywords(text, hasImages);
        const g = classifier.guard({ ...verdict, model: await resolveModel(verdict.category, routes) }, agent, { fallbackModel: agent && agent.model ? agent.model : null, builtinCategory: builtinCat });
        let tools = wantTools ? [] : null;
        if (wantTools) { try { const t = await selectModelAndTools(userMessage, { ...opts, agent: null, _builtinOnly: true }); tools = t && t.tools ? t.tools : []; } catch { tools = []; } }
        const conf = g.confidence == null ? 'n/a' : g.confidence.toFixed(2);
        const who = agent && agent.name ? agent.name + ': ' : '';
        if (g.shadow) console.log(`[auto-model] SHADOW ${who}"${g.category}" (${g.backend}, conf ${conf}, ${g.ms} ms) would pick ${g.model}${g.reason ? ` [${g.reason}]` : ''}; keyword rule says "${builtinCat}"`);
        else console.log(`[auto-model] ${who}"${g.category}" (${g.backend}, conf ${conf}, ${g.ms} ms) -> ${g.applied ? g.model : `agent's own model${g.reason ? ` (${g.reason})` : ''}`}`);
        return { model: g.applied ? g.model : null, wouldPick: g.shadow ? g.model : null, category: g.category, confidence: g.confidence, backend: g.backend, shadow: g.shadow, applied: g.applied, reason: g.reason, ms: g.ms, tools };
      }
    }
  }

  let conservatism = `Be VERY conservative; when unsure between "reasoning" and "hardest", choose "reasoning".`;
  if (context === 'challenger') {
    conservatism = `This agent is a CHALLENGER role — its job is deep critical analysis and finding gaps.
Be AGGRESSIVE about selecting "hardest" when the message involves critique, finding flaws, questioning assumptions, or identifying problems.
Use 4.8 liberally for this role.`;
  }

  const sys = `You are a router. Read the user's prompt and return a JSON object with two fields:

1. "model" — pick the single best category to handle the prompt:
   - code: writing/debugging/reviewing code, scripts, queries, config
   - math: math, logic puzzles, multi-step proofs, complex calculations
   - simple: quick lookups, yes/no, classification, reformatting, short factual answers
   - vision: the prompt is about analyzing an image
   - reasoning: architecture, strategy, design, analysis, planning, general hard thinking (DEFAULT for substantive work)
   - hardest: ONLY the most difficult problems — deep ambiguity, high-stakes, novel problems with no clear approach. Most expensive model. ${conservatism}
${wantTools ? `
2. "tools" — a JSON array of tool categories needed to answer (empty [] if none). When in doubt, INCLUDE. Available categories:
${toolCategories.map(c => `   - ${c}`).join('\n')}` : `
2. "tools" — always return [].`}

Respond with ONLY valid JSON. Example: {"model":"reasoning","tools":["slack","google_calendar"]}`;

  // Try LLM-based classification (with fallback chain)
  let cat = null;
  let tools = wantTools ? [] : null;   // when categories were offered the answer is always an array, even if the classifier fails

  // Try combined JSON classifier via HTTP API
  if (settings.getProviderKey('anthropic')) {
    try {
      const resp = await chatCompletion(
        [{ role: 'user', content: text }],
        { model: CLASSIFIER_MODEL, system: sys, max_tokens: 120, temperature: 0, signal }
      );
      const raw = (resp?.choices?.[0]?.message?.content || '').trim();
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        cat = ROUTE_KEYS.find(k => (parsed.model || '').toLowerCase().includes(k));
        if (wantTools) {
          tools = Array.isArray(parsed.tools)
            ? parsed.tools.filter(t => toolCategories.includes(t))
            : [];
        }
      }
    } catch (e) {
      console.log('[auto-model] HTTP combined classifier failed:', e.message);
    }
  }

  // Fallback: simple classification (no tool categorization)
  if (!cat) {
    cat = await classifyPrompt(text, { signal });
  }

  if (hasImages) cat = 'vision';
  if (!cat) cat = classifyByKeywords(text, hasImages);

  return { model: await resolveModel(cat, routes), category: cat, backend: 'builtin', applied: true, tools };
}

// The one-line notice at the top of an Auto model turn (same style as the plan-limit notice): what the classifier
// said, which model runs, and why when a guard changed the pick. ownModel = the agent's configured model.
function noticeFor(picked, ownModel) {
  if (!picked || !picked.category) return null;
  const short = (m) => String(m || '').split('/').pop();
  const be = picked.backend && picked.backend !== 'builtin' ? String(picked.backend).replace(/^local:/, 'local ').replace(/^perplexity:.*/, 'Perplexity decider') : 'keyword rule';
  const conf = picked.confidence != null ? `, confidence ${Number(picked.confidence).toFixed(2)}` : '';
  const ms = picked.ms != null ? `, ${picked.ms < 1000 ? `${picked.ms} ms` : `${(picked.ms / 1000).toFixed(1)} s`}` : '';
  const via = `${be}${conf}${ms}`;
  if (picked.shadow) return `_👁 Auto model (shadow): "${picked.category}" would run on ${short(picked.wouldPick)}; this turn runs on ${short(ownModel)} (${via})._\n\n`;
  if (picked.applied && picked.model) return `_🎯 Auto model: "${picked.category}" → ${short(picked.model)}${picked.reason ? ` (${picked.reason})` : ''} (${via})._\n\n`;
  return `_🎯 Auto model: "${picked.category}", ${picked.reason || 'not applied'}; this turn runs on ${short(ownModel)} (${via})._\n\n`;
}

module.exports = { selectModel, selectModelAndTools, noticeFor, ROUTES, SDK_ROUTES, DEFAULT_ROUTES, DEFAULT_SDK_ROUTES, routesFor, classifyByKeywords };
