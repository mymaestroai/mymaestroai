'use strict';
// Elastic context for models the hub assembles the prompt for itself (gateway: OpenAI, Gemini, LM Studio,
// ollama...). The hub learns the model's real window, then fills it by priority: the agent's own files
// first (identity, Records), then the most recent turns verbatim, then recall hits, with room left for
// the reply. As Records grow the recent window shrinks; the working brief (lib/compaction) covers the gap.
// A small local model never drowns: whatever does not fit falls off the far end, oldest first, and is
// one recall away.

const http = require('http');
const https = require('https');

const LOCAL_RE = /^(lmstudio|ollama|omlx|ninfer|local)\//i;
const CHARS_PER_TOKEN = 3.6;    // conservative for English + markdown; small-model tokenizers are close

// Known windows by model id prefix (provider stripped). Unknown cloud: 128K; unknown local: 32K.
const KNOWN = [
  ['gpt-6', 400000], ['gpt-5.6', 400000], ['gpt-5.4', 400000], ['gpt-5', 400000], ['o3', 200000],
  ['gemini-pro', 1000000], ['gemini-2.5-pro', 1000000], ['gemini-2.5-flash', 1000000], ['gemini-flash', 1000000],
  ['sonar', 128000],
  ['qwen3.6-27b', 128000], ['qwen3', 32768], ['qwen', 32768], ['llama', 128000], ['mistral', 32768], ['gemma', 32768], ['phi', 16384], ['deepseek', 65536],
];
const DEFAULT_CLOUD = 128000;
const DEFAULT_LOCAL = 32768;

function estimateTokens(text) { return Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN); }
function tokensToChars(tokens) { return Math.floor((Number(tokens) || 0) * CHARS_PER_TOKEN); }
function isLocal(model) { return LOCAL_RE.test(String(model || '')); }

function knownWindow(model) {
  const m = String(model || '').toLowerCase().replace(/^[a-z-]+\//, '').replace(/^.*\//, '');   // strip provider and org (qwen/qwen3.6-27b)
  for (const [prefix, w] of KNOWN) if (m.startsWith(prefix)) return w;
  return isLocal(model) ? DEFAULT_LOCAL : DEFAULT_CLOUD;
}

// ── LM Studio: the loaded model's real context length (api/v0/models), cached ──
const probeCache = new Map();   // url -> { at, models: Map(id -> ctx) }
function probeLmStudio(baseUrl, { timeoutMs = 2500, now = Date.now, fetchImpl = null } = {}) {
  const root = String(baseUrl || 'http://localhost:1234/v1').replace(/\/v1\/?$/, '');
  const cached = probeCache.get(root);
  if (cached && now() - cached.at < 5 * 60 * 1000) return Promise.resolve(cached.models);
  const get = fetchImpl || ((url) => new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => { let s = ''; res.on('data', c => { s += c; }); res.on('end', () => resolve(s)); });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
  }));
  return get(`${root}/api/v0/models`).then((body) => {
    const j = typeof body === 'string' ? JSON.parse(body) : body;
    const models = new Map();
    for (const m of (j && j.data) || []) { const ctx = Number(m.loaded_context_length) || Number(m.max_context_length) || 0; if (m.id && ctx) models.set(String(m.id), ctx); }
    probeCache.set(root, { at: now(), models });
    return models;
  }).catch(() => { probeCache.set(root, { at: now(), models: new Map() }); return new Map(); });
}

/**
 * windowForAgent(agentRecord, model, { lmStudioUrl }) -> Promise<{ window, source }>
 *   agents.json contextWindow (tokens) > LM Studio's loaded context > known table > default.
 */
// OpenAI-compatible servers that report a window per model in /v1/models (NInfer: max_model_len), cached.
function probeOpenAIModels(baseUrl, { timeoutMs = 2500, now = Date.now, fetchImpl = null } = {}) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  if (!root) return Promise.resolve(new Map());
  const key = `oa:${root}`;
  const cached = probeCache.get(key);
  if (cached && now() - cached.at < 5 * 60 * 1000) return Promise.resolve(cached.models);
  const get = fetchImpl || ((url) => new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => { let s = ''; res.on('data', c => { s += c; }); res.on('end', () => resolve(s)); });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
  }));
  return get(`${root}/models`).then((body) => {
    const j = typeof body === 'string' ? JSON.parse(body) : body;
    const models = new Map();
    for (const m of (j && j.data) || []) { const ctx = Number(m.max_model_len) || Number(m.context_length) || Number(m.max_context_length) || 0; if (m.id && ctx) models.set(String(m.id), ctx); }
    probeCache.set(key, { at: now(), models });
    return models;
  }).catch(() => { probeCache.set(key, { at: now(), models: new Map() }); return new Map(); });
}

async function windowForAgent(agent, model, { lmStudioUrl = null, ninferUrl = null, probe = probeLmStudio, probeModels = probeOpenAIModels } = {}) {
  const explicit = Number(agent && agent.contextWindow);
  if (explicit >= 2048) return { window: Math.round(explicit), source: 'agent' };
  if (/^local\//i.test(String(model || ''))) {   // the hub's own proxy: the registry knows each model's window
    try { const ctx = require('./local-models').getLocalModels().contextFor(model); if (ctx) return { window: ctx, source: 'local-models' }; } catch {}
  }
  if (/^openrouter\//i.test(String(model || ''))) {   // OpenRouter's catalogue knows each model's window
    try { const m = require('./openrouter').getOpenRouter().info(model); if (m && m.context) return { window: m.context, source: 'openrouter' }; } catch {}
  }
  if (/^ninfer\//i.test(String(model || '')) && ninferUrl) {
    try {
      const models = await probeModels(ninferUrl);
      const id = String(model).replace(/^ninfer\//i, '');
      const ctx = models.get(id);
      if (ctx) return { window: ctx, source: 'ninfer' };
    } catch {}
  }
  if (/^lmstudio\//i.test(String(model || ''))) {
    try {
      const models = await probe(lmStudioUrl);
      const id = String(model).replace(/^lmstudio\//i, '');
      const ctx = models.get(id) || [...models.entries()].find(([k]) => id.endsWith(k) || k.endsWith(id))?.[1];
      if (ctx) return { window: ctx, source: 'lmstudio' };
    } catch {}
  }
  return { window: knownWindow(model), source: 'table' };
}

/**
 * plan(window, { recordsCapBytes }) -> budgets in tokens/chars for one prompt.
 *   reply reserve 12% (2K..32K), records up to 30%, recent turns up to 45%, recall hits up to 8%.
 */
function plan(window, { recordsCapBytes = 256 * 1024 } = {}) {
  const w = Math.max(4096, Number(window) || DEFAULT_LOCAL);
  const reply = Math.min(32000, Math.max(2000, Math.round(w * 0.12)));
  const recordsTokens = Math.round(w * 0.30);
  return {
    window: w,
    replyTokens: reply,
    recordsBytes: Math.min(recordsCapBytes, tokensToChars(recordsTokens)),
    recentTokens: Math.round(w * 0.45),
    hitsChars: tokensToChars(Math.round(w * 0.08)),
  };
}

function messageTokens(m) {
  if (!m) return 0;
  const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
  const t = m.tool_calls ? JSON.stringify(m.tool_calls) : '';
  return estimateTokens(c) + estimateTokens(t) + 4;
}

/**
 * fitMessages(messages, tokenBudget, { sinceTs, keepLast }) -> the newest messages that fit, oldest first,
 * never starting on an orphaned tool result or a tool call without its results. Messages older than
 * sinceTs (the agent's last compression) are dropped first: the working brief covers them.
 */
function fitMessages(messages, tokenBudget, { sinceTs = null, keepLast = 1 } = {}) {
  let list = Array.isArray(messages) ? messages.slice() : [];
  if (sinceTs) { const s = new Date(sinceTs).getTime(); const kept = list.filter((m, i) => i >= list.length - keepLast || !m.ts || new Date(m.ts).getTime() >= s); list = kept; }
  let used = 0; let start = list.length;
  for (let i = list.length - 1; i >= 0; i--) {
    const t = messageTokens(list[i]);
    if (used + t > tokenBudget && i < list.length - keepLast) break;
    used += t; start = i;
  }
  let out = list.slice(start);
  while (out.length > 1 && out[0].role === 'tool') out = out.slice(1);
  if (out.length > 1 && out[0].role === 'assistant' && out[0].tool_calls && out[0].tool_calls.length && !(out[1] && out[1].role === 'tool')) out = out.slice(1);
  return { messages: out, tokens: out.reduce((a, m) => a + messageTokens(m), 0), dropped: list.length - out.length };
}

/** Slice archive rows (oldest first) into chunks of at most chunkChars characters of "[time] Who: text" lines. */
function chunkRows(rows, chunkChars) {
  const chunks = []; let cur = []; let len = 0;
  for (const r of rows || []) {
    const line = `[${String(r.ts || '').replace('T', ' ').slice(0, 16)}] ${r.kind === 'user' ? 'Owner' : r.kind === 'assistant' ? 'You' : r.kind}: ${String(r.text || '').trim()}`;
    const l = line.length + 1;
    if (len + l > chunkChars && cur.length) { chunks.push(cur.join('\n')); cur = []; len = 0; }
    if (l > chunkChars) { if (cur.length) { chunks.push(cur.join('\n')); cur = []; len = 0; } chunks.push(line.slice(0, chunkChars)); continue; }
    cur.push(line); len += l;
  }
  if (cur.length) chunks.push(cur.join('\n'));
  return chunks;
}

module.exports = { estimateTokens, tokensToChars, isLocal, knownWindow, probeLmStudio, probeOpenAIModels, windowForAgent, plan, fitMessages, messageTokens, chunkRows, CHARS_PER_TOKEN, DEFAULT_CLOUD, DEFAULT_LOCAL, KNOWN };
