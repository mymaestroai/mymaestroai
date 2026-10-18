'use strict';

/**
 * temporal-workers.js — ephemeral workers on ANY model this install can reach.
 *
 * An agent that needs several workers in parallel calls `spawn_workers` and,
 * for each job, PICKS THE MODEL (Claude, OpenAI, Gemini, Perplexity, a local
 * model...). The hub creates a short-lived "virtual agent" per job: a unique
 * id, the chosen model, a lean generic worker prompt, a tool scope. It runs as
 * an ordinary ephemeral chat turn, so it goes down whichever path suits the
 * model — `claude-sdk/*` gets the full Claude Code harness, everything else the
 * hub's own tool loop — and it leaves nothing behind (no agents.json entry, no
 * conversation log, no resumable session).
 *
 * This is the vendor-neutral replacement for the SDK's built-in sub-agent tool:
 * the same capability when the caller picks Claude, plus every other model.
 *
 * This module is pure bookkeeping + policy. The actual turn is run by a
 * `runOne(job)` function injected by lib/sdk-chat.js, which keeps this file
 * unit-testable without a live model.
 */

const crypto = require('crypto');

const MAX_WORKERS_PER_CALL = 8;
const TOOL_SCOPES = ['read', 'full', 'none'];
// Read-only unless the caller asks for more. A trusted single-user install can set
// HUB_WORKER_DEFAULT_SCOPE=full in .env to give workers write/run access by default.
const DEFAULT_SCOPE = TOOL_SCOPES.includes(process.env.HUB_WORKER_DEFAULT_SCOPE) ? process.env.HUB_WORKER_DEFAULT_SCOPE : 'read';

// Simultaneous workers per provider. Hosted APIs take several; a local server is
// one GPU, where "parallel" workers would just be slower serial ones.
const PROVIDER_LIMITS = { 'claude-sdk': 4, anthropic: 4, openai: 4, codex: 4, 'codex-cli': 2, google: 4, perplexity: 3, lmstudio: 1, ollama: 1, omlx: 1, ninfer: 2, local: 2, default: 2 };

// ── Virtual agent registry ───────────────────────────────────────────────

const virtualAgents = new Map();   // id -> { id, model, parent, toolScope, label, createdAt }
let seq = 0;

function createVirtual({ parent, model, toolScope = DEFAULT_SCOPE, label = '' }) {
  const id = `tw-${String(parent || 'agent').replace(/[^a-z0-9]/gi, '').slice(0, 16).toLowerCase()}-${++seq}-${crypto.randomBytes(2).toString('hex')}`;
  const v = { id, model, parent: parent || null, toolScope, label: label || '', createdAt: Date.now() };
  virtualAgents.set(id, v);
  return v;
}
function getVirtual(id) { return virtualAgents.get(id) || null; }
function isVirtual(id) { return virtualAgents.has(id); }
function releaseVirtual(id) { return virtualAgents.delete(id); }
function listVirtual() { return [...virtualAgents.values()]; }

/** System context for a worker: replaces the personality files a real agent would load. */
function workerContext(v) {
  const scope = v.toolScope === 'full' ? 'You may read, write and run commands as the task requires.'
    : v.toolScope === 'none' ? 'You have no tools. Work from the brief alone.'
    : 'You are READ-ONLY: you may read, search and fetch, but must not modify files or run state-changing commands.';
  return `# Temporary worker
You are a temporary worker inside My Maestro AI, created by the agent "${v.parent || 'unknown'}" for ONE task${v.label ? ` ("${v.label}")` : ''}. You have no personality, no memory of earlier conversations, and you will not exist after this task.

Rules:
- The brief you receive is everything you know. Do exactly that task; do not widen it.
- ${scope}
- You cannot delegate: do not try to consult other agents or spawn workers.
- Be accurate over fast. If something in the brief is impossible or a path does not exist, say so plainly instead of guessing.
- Your reply is returned verbatim to the calling agent, not shown to a person. Lead with the result, in the shape the brief asked for. Include exact file paths, commands and evidence the caller needs to verify your work. No pleasantries, no offers of further help.`;
}

// ── Models: provider, curated catalog, resolution ────────────────────────

function providerOf(model) {
  const m = String(model || '');
  const i = m.indexOf('/');
  return i > 0 ? m.slice(0, i) : 'anthropic';
}

/** Honest one-line capability note per model id. */
function noteFor(model, sdkInfo) {
  const m = String(model).toLowerCase(); const p = providerOf(m);
  if (p === 'claude-sdk') {
    const id = m.slice('claude-sdk/'.length);
    const info = (sdkInfo || []).find(x => String(x.id).toLowerCase() === id);
    const base = 'full Claude Code harness (best for multi-file coding and long tool chains)';
    if (/haiku/.test(id)) return `fast and cheap; ${base}`;
    if (/opus|fable|mythos/.test(id)) return `deepest reasoning; ${base}`;
    if (/sonnet/.test(id)) return `strong general worker; ${base}`;
    return (info && info.description ? info.description + '; ' : '') + base;
  }
  if (p === 'codex-cli') return 'OpenAI model on the owner\'s ChatGPT subscription via the Codex CLI: own shell + file tools and hub tools; tool_scope "full" needed for a working shell on this host';
  if (p === 'codex') return 'OpenAI Codex via Responses API: TEXT-ONLY, no tools; code reasoning or review from a second vendor';
  if (p === 'perplexity') return 'live web research with citations; no file tools';
  if (p === 'google') return /flash/.test(m) ? 'Gemini Flash: fast, cheap, long context; hub tool loop' : 'Gemini Pro: strong reasoning, very long context, second-vendor view; hub tool loop';
  if (p === 'openai') return /^openai\/o\d/.test(m) ? 'OpenAI reasoning model: slow, careful; hub tool loop' : /mini|nano/.test(m) ? 'OpenAI small model: fast and cheap; hub tool loop' : 'OpenAI flagship: second-vendor view; hub tool loop';
  if (p === 'local') return 'LOCAL model via the hub\'s own proxy: private, free; a different local model costs one engine swap';
  if (p === 'ninfer') return 'LOCAL model on the 5090 (NInfer): private, free, fast, two at a time; tool use varies by model';
  if (p === 'lmstudio' || p === 'ollama' || p === 'omlx') return 'LOCAL model: private, free, slower, one at a time; tool use varies by model';
  return 'hub tool loop';
}

// Dated snapshots, previews and non-chat variants are noise in a shortlist.
const NOISE = /(\d{4}-\d{2}-\d{2}|-\d{4}$|preview|exp(erimental)?\b|chat-latest|audio|realtime|tts|transcribe|image|embedding|search|instruct|vision|omni|robotics|computer-use|customtools|\[1m\]|^claude-sdk\/(default|opus|sonnet|haiku|fable)(\[|$))/i;

// A useful shortlist offers one good option per TIER, not four versions of the same thing.
function tierOf(provider, id) {
  const m = String(id).toLowerCase();
  if (provider === 'google') return /flash-lite/.test(m) ? 'flash-lite' : /flash/.test(m) ? 'flash' : /pro/.test(m) ? 'pro' : 'other';
  if (provider === 'openai') return /-pro$/.test(m) ? 'pro' : /nano/.test(m) ? 'nano' : /mini/.test(m) ? 'small' : /^openai\/o\d/.test(m) ? 'reasoning' : 'flagship';
  return 'any';
}
const TIER_ORDER = { google: ['pro', 'flash', 'flash-lite'], openai: ['flagship', 'small', 'reasoning'] };

function versionKey(id) {
  // pull every number out so "gpt-5.4" > "gpt-5" > "gpt-4.1"; longer/newer sorts first
  const nums = (String(id).match(/\d+(\.\d+)?/g) || []).map(Number);
  return nums.concat([0, 0, 0]).slice(0, 3);
}
function newestFirst(a, b) {
  // "-latest" aliases never go stale, so they beat any pinned version in their tier
  const la = /-latest$/i.test(a), lb = /-latest$/i.test(b);
  if (la !== lb) return la ? -1 : 1;
  const ka = versionKey(a), kb = versionKey(b);
  for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
  return a.length - b.length;
}

/**
 * Shortlist of models worth showing an agent. The agent may still name ANY
 * available model; this is only what fits in a tool description.
 * @param {string[]} available  full ids, e.g. "openai/gpt-5.4"
 */
function curateCatalog(available, sdkInfo, perProvider = 4) {
  const byProvider = new Map();
  for (const id of available || []) {
    const p = providerOf(id);
    if (!byProvider.has(p)) byProvider.set(p, []);
    byProvider.get(p).push(id);
  }
  const order = ['claude-sdk', 'anthropic', 'openai', 'codex-cli', 'codex', 'google', 'perplexity', 'local', 'ninfer', 'lmstudio', 'ollama', 'omlx'];
  const providers = [...byProvider.keys()].sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99);
  const out = [];
  for (const p of providers) {
    const all = byProvider.get(p);
    const local = p === 'lmstudio' || p === 'ollama' || p === 'omlx' || p === 'ninfer' || p === 'local';
    let pick = local ? all.slice() : all.filter(id => !NOISE.test(id));
    if (pick.length === 0) pick = all.slice();
    if (!local) pick.sort(newestFirst);
    if (p === 'claude-sdk') {
      // one per family, newest of each
      const fam = new Map();
      for (const id of pick) { const f = (id.match(/(fable|mythos|opus|sonnet|haiku)/i) || [,'other'])[1].toLowerCase(); if (!fam.has(f)) fam.set(f, id); }
      pick = [...fam.values()];
    }
    if (TIER_ORDER[p]) {
      const chosen = [];
      for (const tier of TIER_ORDER[p]) { const best = pick.find(id => tierOf(p, id) === tier); if (best) chosen.push(best); }
      for (const id of pick) { if (chosen.length >= perProvider) break; if (!chosen.includes(id) && TIER_ORDER[p].includes(tierOf(p, id))) chosen.push(id); }
      pick = chosen;
    }
    for (const id of pick.slice(0, local ? 6 : perProvider)) out.push({ id, provider: p, note: noteFor(id, sdkInfo) });
  }
  return out;
}

function describeCatalog(catalog, totalAvailable) {
  if (!catalog.length) return 'No models are reachable right now.';
  const lines = catalog.map(c => `- ${c.id} — ${c.note}`).join('\n');
  const more = totalAvailable > catalog.length ? `\n(${totalAvailable} models are reachable in total; any exact id from the hub's model list is accepted.)` : '';
  return lines + more;
}

/**
 * @returns {{model:string}|{error:string}}
 */
function resolveModel(requested, available, fallbackModel) {
  const avail = available || [];
  const want = String(requested || '').trim();
  if (!want) {
    if (fallbackModel) return { model: fallbackModel, defaulted: true };
    return { error: 'no model given and the calling agent has no model to default to' };
  }
  if (avail.includes(want)) return { model: want };
  const lower = want.toLowerCase();
  const ci = avail.filter(a => a.toLowerCase() === lower);
  if (ci.length === 1) return { model: ci[0] };
  // bare id without provider prefix, if unambiguous
  const suffix = avail.filter(a => a.toLowerCase().endsWith('/' + lower));
  if (suffix.length === 1) return { model: suffix[0] };
  if (suffix.length > 1) return { error: `"${want}" is ambiguous: ${suffix.slice(0, 5).join(', ')}. Use the full id.` };
  const near = avail.filter(a => a.toLowerCase().includes(lower.replace(/^.*\//, ''))).slice(0, 5);
  return { error: `model "${want}" is not reachable on this install.${near.length ? ' Did you mean: ' + near.join(', ') + '?' : ''}` };
}

// ── Tool scope ───────────────────────────────────────────────────────────

const NO_NESTING = ['consult_agent', 'spawn_workers', 'create_agent', 'start_tiger_team', 'create_task',
                    'write_memory', 'append_memory', 'write_session_notes', 'write_shared_memory'];
const WRITE_TOOLS = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'auth_http_request'];

/** Tool names to exclude on the hub's own (gateway) tool loop. */
function gatewayExcludesFor(scope) {
  if (scope === 'none') return ['*'];
  return scope === 'full' ? [...NO_NESTING] : [...NO_NESTING, ...WRITE_TOOLS];
}
/** Tool names to disallow on the Claude SDK path. Sub-agent tool is always blocked: workers do not nest. */
function sdkDisallowedFor(scope) {
  const base = ['Agent', 'Task'];
  if (scope === 'none') return [...base, 'Bash', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];
  return scope === 'full' ? base : [...base, 'Bash', 'Write', 'Edit', 'NotebookEdit'];
}

// ── Jobs ─────────────────────────────────────────────────────────────────

/**
 * Validate and normalise the tool input.
 * @returns {{jobs:Array}|{error:string}}
 */
function normalizeJobs(workers, { available, callerModel, maxWorkers = MAX_WORKERS_PER_CALL } = {}) {
  if (!Array.isArray(workers) || workers.length === 0) return { error: 'workers must be a non-empty array of { task, model?, tools?, label? }' };
  if (workers.length > maxWorkers) return { error: `too many workers: ${workers.length} requested, limit is ${maxWorkers} per call. Split the work or batch it.` };
  const jobs = []; const problems = [];
  workers.forEach((w, i) => {
    const n = i + 1;
    const task = String((w && w.task) || '').trim();
    if (task.length < 10) { problems.push(`worker ${n}: task is missing or too short to be a self-contained brief`); return; }
    const scope = String((w && w.tools) || DEFAULT_SCOPE).trim().toLowerCase();
    if (!TOOL_SCOPES.includes(scope)) { problems.push(`worker ${n}: tools must be one of ${TOOL_SCOPES.join(', ')}`); return; }
    const r = resolveModel(w && w.model, available, callerModel);
    if (r.error) { problems.push(`worker ${n}: ${r.error}`); return; }
    const p = providerOf(r.model);
    let toolScope = scope, downgraded = null;
    if ((p === 'codex' || p === 'perplexity') && scope !== 'none') { toolScope = 'none'; downgraded = `${r.model} cannot use tools; running text-only`; }
    jobs.push({ index: n, task, model: r.model, provider: p, toolScope, label: String((w && w.label) || '').trim().slice(0, 60) || `worker ${n}`, defaulted: !!r.defaulted, note: downgraded });
  });
  if (problems.length) return { error: 'Nothing was run. Fix these and call again:\n- ' + problems.join('\n- ') };
  return { jobs };
}

// ── Concurrency ──────────────────────────────────────────────────────────

class ProviderLimiter {
  constructor(limits = PROVIDER_LIMITS) { this.limits = limits; this.active = new Map(); this.waiting = new Map(); }
  limitFor(p) { return this.limits[p] || this.limits.default || 2; }
  async run(provider, fn) {
    while ((this.active.get(provider) || 0) >= this.limitFor(provider)) {
      await new Promise(r => { if (!this.waiting.has(provider)) this.waiting.set(provider, []); this.waiting.get(provider).push(r); });
    }
    this.active.set(provider, (this.active.get(provider) || 0) + 1);
    try { return await fn(); }
    finally {
      this.active.set(provider, this.active.get(provider) - 1);
      const q = this.waiting.get(provider); if (q && q.length) q.shift()();
    }
  }
}
const sharedLimiter = new ProviderLimiter();

/**
 * Run all jobs in parallel (subject to per-provider caps). Never throws: a failed
 * worker becomes a failed result so the others still report.
 * @param {(job, virtual) => Promise<string>} runOne
 */
async function runWorkers(jobs, { parent, runOne, limiter = null, onStart, onDone } = {}) {
  // The limiter is the shared provider pacing (lib/provider-pacing): per-provider caps, serial after a
  // transient failure, retry with backoff, ramp back up. Resolved lazily so the instance sdk-chat
  // created (with its event hook) is the one used. ProviderLimiter remains for tests/offline use.
  const lim = limiter || require('./provider-pacing').getPacing();
  const failText = (e) => {
    const pc = e && e.pacing;
    if (!pc) return `FAILED: ${e && e.message ? e.message : e}`;
    return `${pc.transient ? '[TRANSIENT FAILURE]' : '[FAILED]'} ${pc.kind}${pc.attempts ? ` after ${pc.attempts} attempt(s)` : ''}: ${e.message}${pc.transient ? ' (provider switched to one-at-a-time for a cooling-off period; try again in a few minutes or use another provider)' : ''}`;
  };
  return Promise.all(jobs.map(async (job) => {
    // One attempt = one temporary worker. The pacing layer may call this again after a transient failure.
    const attempt = async () => {
      const v = createVirtual({ parent, model: job.model, toolScope: job.toolScope, label: job.label });
      const t0 = Date.now();
      try {
        if (onStart) onStart(job, v);
        const text = await runOne(job, v);
        const r = { ...job, id: v.id, ok: true, text: String(text || '').trim() || '(empty reply)', secs: (Date.now() - t0) / 1000 };
        if (onDone) onDone(r, v); return r;
      } catch (e) {
        const r = { ...job, id: v.id, ok: false, error: e, text: failText(e), secs: (Date.now() - t0) / 1000 };
        if (onDone) onDone(r, v); return r;
      } finally {
        releaseVirtual(v.id);
      }
    };
    try {
      const r = await lim.run(job.provider, attempt, { label: job.label, classifyResult: (r) => (r && r.ok) ? 'ok' : (r && r.error) || 'error' });
      if (r && r.error) delete r.error;
      return r;
    } catch (e) {
      return { ...job, id: `tw-${job.index || 0}`, ok: false, text: failText(e), secs: 0 };
    }
  }));
}

function formatResults(results) {
  const ok = results.filter(r => r.ok).length;
  const head = `${results.length} temporary worker(s) finished: ${ok} succeeded, ${results.length - ok} failed. Verify results before relying on them.`;
  const body = results.map(r =>
    `\n\n===== ${r.label} | ${r.model}${r.defaulted ? ' (defaulted to your model)' : ''} | tools: ${r.toolScope} | ${r.ok ? 'ok' : 'FAILED'} | ${r.secs.toFixed(1)}s =====` +
    (r.note ? `\n[note: ${r.note}]` : '') + `\n${r.text}`).join('');
  return head + body;
}

function toolDescription(catalogText) {
  return `Create temporary workers and run them IN PARALLEL, each on a model YOU choose. Use this when you need several hands at once, or a specific model for a job, and no named platform agent's personality or memory is needed. Each worker is ephemeral: it knows only the brief you give it, cannot delegate further, and disappears when done. All results return together.

Pick the model per worker to suit the job (mix freely in one call). If you omit "model", the worker uses your own model.
Models reachable right now:
${catalogText}

Per worker: "task" = a complete self-contained brief (goal, exact paths, constraints, and the shape of the answer you want); "tools" = "read" (default: read/search/fetch only), "full" (may write files and run commands), or "none"; "label" = short name shown to the user. Limit ${MAX_WORKERS_PER_CALL} workers per call. Give parallel workers non-overlapping files if they write.`;
}

module.exports = {
  MAX_WORKERS_PER_CALL, TOOL_SCOPES, DEFAULT_SCOPE, PROVIDER_LIMITS,
  createVirtual, getVirtual, isVirtual, releaseVirtual, listVirtual, workerContext,
  providerOf, noteFor, curateCatalog, describeCatalog, resolveModel,
  gatewayExcludesFor, sdkDisallowedFor, normalizeJobs, ProviderLimiter, runWorkers, formatResults, toolDescription,
};
