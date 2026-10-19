'use strict';
// Spend ledger: one row per turn (agent, origin, model, tokens, cost, duration, tools) in
// data/ledger.db. Claude SDK turns report their API-equivalent cost directly (on a Max subscription
// that is what the same traffic would cost on the API, not a bill); gateway and Codex turns get a
// cost from the price table when the model is known, otherwise tokens only.
//
// Caps are OFF unless configured (settings.ledger.perAgentDailyUsd / hubDailyUsd, USD per calendar
// day, local time). Over a cap, an agent's decided actions (send, write outside...) become "ask"
// for the rest of the day and the reply says so; nothing is silently stopped.

const path = require('path');
const fs = require('fs');

const DB_FILE = process.env.HUB_LEDGER_FILE || path.join(__dirname, '..', 'data', 'ledger.db');

// USD per 1M tokens [input, output]; prefix match on the model id (without provider). Checked against
// platform.claude.com/docs/en/about-claude/pricing on 2026-10-13 (a tester flagged the stale Claude rows).
// Longer prefixes first where a shorter one would otherwise catch them (opus-4-5..4-8 before opus-4).
const PRICES = [
  ['claude-fable-5-1', [10, 50]], ['claude-fable-5', [10, 50]],
  ['claude-opus-5-5', [4, 20]], ['claude-opus-5', [5, 25]],
  ['claude-opus-4-8', [5, 25]], ['claude-opus-4-7', [5, 25]], ['claude-opus-4-6', [5, 25]], ['claude-opus-4-5', [5, 25]], ['claude-opus-4', [15, 75]],
  ['claude-sonnet-5-5', [2, 10]], ['claude-sonnet-5', [3, 15]], ['claude-sonnet-4', [3, 15]],
  ['claude-haiku-5-5', [0.1, 0.5]], ['claude-haiku-4-5', [1, 5]], ['claude-haiku-3-5', [0.8, 4]],
  ['gpt-6', [5, 20]], ['gpt-5.6', [2.5, 10]], ['gpt-5.4-mini', [0.4, 1.6]], ['gpt-5', [1.25, 10]], ['o3-mini', [1.1, 4.4]], ['o3-pro', [20, 80]], ['o3', [2, 8]],
  ['gemini-pro', [1.25, 10]], ['gemini-2.5-pro', [1.25, 10]], ['gemini-2.5-flash', [0.3, 2.5]], ['gemini-flash', [0.3, 2.5]],
  ['sonar', [1, 1]],
];

function priceFor(model) {
  const m = String(model || '').toLowerCase().replace(/^[a-z-]+\//, '').replace(/\[.*$/, '');
  if (/^(lmstudio|ollama|omlx|ninfer|local)\//i.test(String(model || ''))) return [0, 0];   // local: free
  // OpenRouter reports each call's cost (booked as reported); its catalogue prices cover a call that did not.
  if (/^openrouter\//i.test(String(model || ''))) { try { return require('./openrouter').getOpenRouter().pricePerMillion(model); } catch { return null; } }
  for (const [prefix, p] of PRICES) if (m.startsWith(prefix)) return p;
  return null;
}

// Prompt caching (Anthropic): cache writes bill at 125% of the input price on every model; cache reads at 10%,
// except 2.5% on Fable 5.1 and 5% on Opus 5.5 and Sonnet 5.5 (same pricing page).
const CACHE_WRITE_FACTOR = 1.25;
function cacheReadFactor(model) {
  const m = String(model || '').toLowerCase().replace(/^[a-z-]+\//, '');
  if (m.startsWith('claude-fable-5-1')) return 0.025;
  if (m.startsWith('claude-opus-5-5') || m.startsWith('claude-sonnet-5-5')) return 0.05;
  return 0.1;
}
/** estimateCost(model, inputTokens, outputTokens, { cacheRead, cacheWrite }) -> USD | null (unknown model) */
function estimateCost(model, inputTokens, outputTokens, { cacheRead = 0, cacheWrite = 0 } = {}) {
  const p = priceFor(model);
  if (!p) return null;
  return ((Number(inputTokens) || 0) * p[0] + (Number(cacheRead) || 0) * p[0] * cacheReadFactor(model) + (Number(cacheWrite) || 0) * p[0] * CACHE_WRITE_FACTOR
    + (Number(outputTokens) || 0) * p[1]) / 1e6;
}

function localDay(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Providers billed per use whose monthly credit (for example the API credit that comes with a Claude Max plan) can
// be tracked: settings.apiCredits = { anthropic: { monthlyUsd: 200, resetDay: 1 } }. Spend is the ledger's, so it
// covers calls made through the hub only, at its estimated or reported cost.
const CREDIT_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter', 'perplexity'];

/** The monthly credit period containing `ts`, as local days: { since, until } (until = the next renewal, exclusive). */
function creditPeriod(resetDay = 1, ts = Date.now()) {
  const r = Math.min(28, Math.max(1, Math.round(Number(resetDay) || 1)));
  const d = new Date(ts);
  const start = new Date(d.getFullYear(), d.getMonth() - (d.getDate() < r ? 1 : 0), r);
  return { since: localDay(start.getTime()), until: localDay(new Date(start.getFullYear(), start.getMonth() + 1, r).getTime()) };
}
function creditPeriodStart(resetDay = 1, ts = Date.now()) { return creditPeriod(resetDay, ts).since; }

/** cleanCredit({ monthlyUsd, resetDay }) -> { monthlyUsd, resetDay } | null (no amount = no credit). Throws on bad input. */
function cleanCredit(c) {
  const raw = c && c.monthlyUsd;
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const amount = Number(String(raw).trim().replace(/^\$/, ''));
  if (!Number.isFinite(amount) || amount < 0) throw new Error('The monthly credit must be a dollar amount, or blank for none.');
  const monthlyUsd = Math.round(amount * 100) / 100;
  if (monthlyUsd === 0) return null;   // also amounts under half a cent
  const day = c.resetDay === undefined || c.resetDay === null || c.resetDay === '' ? 1 : Number(c.resetDay);
  if (!Number.isInteger(day) || day < 1 || day > 28) throw new Error('The credit renews on a day of the month from 1 to 28.');
  return { monthlyUsd, resetDay: day };
}

function createLedger({ file = DB_FILE, now = Date.now, getCaps = () => ({}), getCredits = () => ({}) } = {}) {
  let db = null;
  function open() {
    if (db) return db;
    try {
      const Database = require('better-sqlite3');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      db = new Database(file);
      try { fs.chmodSync(file, 0o600); } catch {}
      db.pragma('journal_mode = WAL');
      db.exec(`CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, day TEXT NOT NULL, agent TEXT NOT NULL, origin TEXT, model TEXT, provider TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, cost_source TEXT, duration_ms INTEGER, tools INTEGER, ok INTEGER
      ); CREATE INDEX IF NOT EXISTS turns_day_agent ON turns(day, agent);`);
    } catch (e) { console.error('[ledger] disabled:', e.message); db = false; }
    return db;
  }

  /** record({ agent, origin, model, inputTokens, outputTokens, costUsd, durationMs, tools, ok }) */
  function record(rec) {
    const d = open();
    if (!d) return null;
    const model = String(rec.model || '');
    const provider = model.includes('/') ? model.split('/')[0] : (model.startsWith('claude') ? 'claude-sdk' : 'unknown');
    let cost = rec.costUsd; let source = 'reported';
    if (cost == null) {
      // inputTokens is the whole prompt; the cached part of it (rec.cacheRead / rec.cacheWrite) is priced at the cache rates.
      const read = Number(rec.cacheRead) || 0, write = Number(rec.cacheWrite) || 0;
      const uncached = rec.inputTokens == null ? rec.inputTokens : Math.max(0, Number(rec.inputTokens) - read - write);
      cost = estimateCost(model, uncached, rec.outputTokens, { cacheRead: read, cacheWrite: write });
      source = cost == null ? 'none' : 'estimated';
    }
    try {
      d.prepare(`INSERT INTO turns (ts, day, agent, origin, model, provider, input_tokens, output_tokens, cost_usd, cost_source, duration_ms, tools, ok)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        new Date(now()).toISOString(), localDay(now()), String(rec.agent || 'unknown'), rec.origin ? String(rec.origin) : null, model || null, provider,
        rec.inputTokens == null ? null : Math.round(rec.inputTokens), rec.outputTokens == null ? null : Math.round(rec.outputTokens),
        cost == null ? null : Number(cost), source, rec.durationMs == null ? null : Math.round(rec.durationMs), rec.tools == null ? null : Math.round(rec.tools), rec.ok === false ? 0 : 1);
    } catch (e) { console.error('[ledger] record failed:', e.message); }
    return { cost, source };
  }

  function today(day = localDay(now())) {
    const d = open();
    if (!d) return { day, total: 0, agents: [], turns: 0 };
    const rows = d.prepare(`SELECT agent, COUNT(*) AS turns, SUM(COALESCE(cost_usd,0)) AS cost, SUM(COALESCE(input_tokens,0)) AS input_tokens, SUM(COALESCE(output_tokens,0)) AS output_tokens
      FROM turns WHERE day = ? GROUP BY agent ORDER BY cost DESC`).all(day);
    const total = rows.reduce((s, r) => s + (r.cost || 0), 0);
    return { day, total, turns: rows.reduce((s, r) => s + r.turns, 0), agents: rows.map(r => ({ agent: r.agent, turns: r.turns, cost: r.cost || 0, inputTokens: r.input_tokens, outputTokens: r.output_tokens })) };
  }

  function days(n = 14) {
    const d = open();
    if (!d) return [];
    return d.prepare(`SELECT day, COUNT(*) AS turns, SUM(COALESCE(cost_usd,0)) AS cost FROM turns GROUP BY day ORDER BY day DESC LIMIT ?`).all(n);
  }

  /** caps: { perAgentDailyUsd: number|null, hubDailyUsd: number|null } (null/0 = unlimited) */
  function caps() {
    const c = getCaps() || {};
    const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
    return { perAgentDailyUsd: num(c.perAgentDailyUsd), hubDailyUsd: num(c.hubDailyUsd) };
  }

  /** overCap(agent) -> { capped: bool, reason: string|null, agentSpend, hubSpend, caps } */
  function overCap(agent) {
    const c = caps();
    const t = today();
    const agentSpend = (t.agents.find(a => a.agent === agent) || {}).cost || 0;
    let reason = null;
    if (c.perAgentDailyUsd && agentSpend >= c.perAgentDailyUsd) reason = `${agent} is over its daily cap ($${agentSpend.toFixed(2)} of $${c.perAgentDailyUsd})`;
    else if (c.hubDailyUsd && t.total >= c.hubDailyUsd) reason = `the hub is over its daily cap ($${t.total.toFixed(2)} of $${c.hubDailyUsd})`;
    return { capped: !!reason, reason, agentSpend, hubSpend: t.total, caps: c };
  }

  /**
   * Monthly credits with an amount: [{ provider, monthlyUsd, resetDay, since, until, spent, turns, unpriced }] for the
   * current period. unpriced = calls with no known cost (not in spent). No ledger: nothing, rather than a reassuring $0.
   */
  function credits() {
    const d = open();
    if (!d) return [];
    const out = [];
    for (const provider of CREDIT_PROVIDERS) {
      let c = null;
      try { c = cleanCredit((getCredits() || {})[provider]); } catch { c = null; }
      if (!c) continue;
      const { since, until } = creditPeriod(c.resetDay, now());
      const row = d.prepare(`SELECT COUNT(*) AS turns, SUM(COALESCE(cost_usd,0)) AS cost, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
        FROM turns WHERE provider = ? AND day >= ? AND day < ? AND day <= ?`).get(provider, since, until, localDay(now()));   // a mis-dated future row never counts
      out.push({ provider, ...c, since, until, spent: row.cost || 0, turns: row.turns || 0, unpriced: row.unpriced || 0 });
    }
    return out;
  }

  return { record, today, days, caps, overCap, credits, estimateCost, priceFor, file };
}

let shared = null;
function getLedger(opts) { if (!shared) shared = createLedger(opts); return shared; }

module.exports = { createLedger, getLedger, estimateCost, priceFor, cacheReadFactor, localDay, PRICES, CREDIT_PROVIDERS, creditPeriod, creditPeriodStart, cleanCredit };
