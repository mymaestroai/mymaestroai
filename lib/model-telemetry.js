'use strict';

/**
 * model-telemetry.js — Per-model reliability + tool-calling metrics
 *
 * Answers: which models actually work in THIS harness?
 *   - request success / failure rate, by HTTP status and error class
 *   - time-to-first-token and total stream latency
 *   - tool calls emitted per turn, malformed-argument rate
 *   - tool execution success rate attributed to the calling model
 *
 * Writes to data/model-telemetry.db (SQLite, WAL).  All writes are
 * best-effort — telemetry must never break a chat turn.
 */

const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'model-telemetry.db');

let db = null;
let disabled = false;

function getDb() {
  if (disabled) return null;
  if (db) return db;
  try {
    const Database = require('better-sqlite3');
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT DEFAULT (datetime('now')),
        model TEXT NOT NULL,
        agent TEXT,
        ok INTEGER NOT NULL,
        status INTEGER,
        error_class TEXT,
        error_msg TEXT,
        ttft_ms INTEGER,
        total_ms INTEGER,
        tool_count INTEGER DEFAULT 0,
        malformed_args INTEGER DEFAULT 0,
        empty_response INTEGER DEFAULT 0,
        retries INTEGER DEFAULT 0,
        conn_reused INTEGER,
        socket_id INTEGER,
        alpn TEXT,
        tls_version TEXT,
        connect_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_req_model ON requests(model);
      CREATE INDEX IF NOT EXISTS idx_req_ts ON requests(ts);

      CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT DEFAULT (datetime('now')),
        model TEXT NOT NULL,
        agent TEXT,
        tool TEXT NOT NULL,
        ok INTEGER NOT NULL,
        malformed INTEGER DEFAULT 0,
        cached INTEGER DEFAULT 0,
        duration_ms INTEGER,
        error_msg TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tc_model ON tool_calls(model);
      CREATE INDEX IF NOT EXISTS idx_tc_tool ON tool_calls(tool);
      CREATE INDEX IF NOT EXISTS idx_tc_ts ON tool_calls(ts);
    `);

    // ── Migration: connection telemetry columns (P1) ──
    // CREATE TABLE IF NOT EXISTS is a no-op on an existing DB, so add the
    // new columns explicitly.  Each ALTER is independently guarded — a
    // duplicate-column error just means it already ran.
    const migrations = [
      "ALTER TABLE requests ADD COLUMN conn_reused INTEGER",
      "ALTER TABLE requests ADD COLUMN socket_id INTEGER",
      "ALTER TABLE requests ADD COLUMN alpn TEXT",
      "ALTER TABLE requests ADD COLUMN tls_version TEXT",
      "ALTER TABLE requests ADD COLUMN connect_ms INTEGER",
    ];
    for (const sql of migrations) {
      try { db.exec(sql); } catch (e) {
        if (!/duplicate column/i.test(e.message)) {
          console.error('[telemetry] migration failed:', sql, e.message);
        }
      }
    }

    return db;
  } catch (e) {
    console.error('[telemetry] disabled:', e.message);
    disabled = true;
    return null;
  }
}

function classifyError(err, status) {
  const m = String((err && err.message) || err || '');
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model_missing';
  if (status === 400) {
    if (/max_tokens|max_completion_tokens/i.test(m)) return 'bad_max_tokens';
    if (/temperature|top_p/i.test(m)) return 'bad_param';
    if (/tool|function/i.test(m)) return 'bad_tool_schema';
    if (/responses api|\/v1\/responses/i.test(m)) return 'responses_api_only';
    return 'bad_request';
  }
  if (status >= 500) return 'provider_5xx';
  if (/abort/i.test(m)) return 'aborted';
  if (/ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i.test(m)) return 'network';
  if (/content_filter/i.test(m)) return 'content_filter';
  return 'other';
}

// ── Recording ──────────────────────────────────────────────────────────

function recordRequest(rec = {}) {
  const d = getDb();
  if (!d) return;
  try {
    d.prepare(`INSERT INTO requests
      (model, agent, ok, status, error_class, error_msg, ttft_ms, total_ms,
       tool_count, malformed_args, empty_response, retries,
       conn_reused, socket_id, alpn, tls_version, connect_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      String(rec.model || 'unknown'),
      rec.agent || null,
      rec.ok ? 1 : 0,
      rec.status ?? null,
      rec.ok ? null : (rec.errorClass || classifyError(rec.error, rec.status)),
      rec.ok ? null : String((rec.error && rec.error.message) || rec.error || '').slice(0, 400) || null,
      rec.ttftMs ?? null,
      rec.totalMs ?? null,
      rec.toolCount || 0,
      rec.malformedArgs || 0,
      rec.emptyResponse ? 1 : 0,
      rec.retries || 0,
      rec.connReused === undefined || rec.connReused === null ? null : (rec.connReused ? 1 : 0),
      rec.socketId ?? null,
      rec.alpn ?? null,
      rec.tlsVersion ?? null,
      rec.connectMs ?? null
    );
  } catch (e) { /* never break a turn */ }
}

function recordToolCall(rec = {}) {
  const d = getDb();
  if (!d) return;
  try {
    d.prepare(`INSERT INTO tool_calls
      (model, agent, tool, ok, malformed, cached, duration_ms, error_msg)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      String(rec.model || 'unknown'),
      rec.agent || null,
      String(rec.tool || 'unknown'),
      rec.ok ? 1 : 0,
      rec.malformed ? 1 : 0,
      rec.cached ? 1 : 0,
      rec.durationMs ?? null,
      rec.error ? String(rec.error).slice(0, 400) : null
    );
  } catch (e) { /* never break a turn */ }
}

// ── Reporting ──────────────────────────────────────────────────────────

function modelReport(hours = 168) {
  const d = getDb();
  if (!d) return [];
  const since = `-${Math.max(1, hours)} hours`;
  const rows = d.prepare(`
    SELECT model,
           COUNT(*)                                   AS requests,
           SUM(ok)                                    AS ok,
           ROUND(100.0 * SUM(ok) / COUNT(*), 1)       AS ok_pct,
           SUM(empty_response)                        AS empty,
           SUM(malformed_args)                        AS malformed_args,
           SUM(tool_count)                            AS tool_calls,
           CAST(AVG(ttft_ms) AS INT)                  AS avg_ttft_ms,
           CAST(AVG(total_ms) AS INT)                 AS avg_total_ms
    FROM requests
    WHERE ts >= datetime('now', ?)
    GROUP BY model
    ORDER BY requests DESC
  `).all(since);

  const errs = d.prepare(`
    SELECT model, error_class, COUNT(*) AS n
    FROM requests
    WHERE ts >= datetime('now', ?) AND ok = 0
    GROUP BY model, error_class
  `).all(since);

  const tools = d.prepare(`
    SELECT model,
           COUNT(*) AS calls,
           ROUND(100.0 * SUM(ok) / COUNT(*), 1) AS tool_ok_pct,
           SUM(malformed) AS malformed
    FROM tool_calls
    WHERE ts >= datetime('now', ?)
    GROUP BY model
  `).all(since);

  const tmap = Object.fromEntries(tools.map(t => [t.model, t]));
  for (const r of rows) {
    r.errors = errs.filter(e => e.model === r.model)
                   .sort((a, b) => b.n - a.n)
                   .map(e => `${e.error_class}:${e.n}`);
    const t = tmap[r.model];
    r.tool_exec_calls = t ? t.calls : 0;
    r.tool_exec_ok_pct = t ? t.tool_ok_pct : null;
    r.tool_malformed = t ? t.malformed : 0;
  }
  return rows;
}

function toolReport(hours = 168, model = null) {
  const d = getDb();
  if (!d) return [];
  const since = `-${Math.max(1, hours)} hours`;
  const sql = `
    SELECT tool,
           ${model ? '' : 'COUNT(DISTINCT model) AS models,'}
           COUNT(*) AS calls,
           ROUND(100.0 * SUM(ok) / COUNT(*), 1) AS ok_pct,
           SUM(malformed) AS malformed,
           SUM(cached) AS cached,
           CAST(AVG(duration_ms) AS INT) AS avg_ms
    FROM tool_calls
    WHERE ts >= datetime('now', ?) ${model ? 'AND model = ?' : ''}
    GROUP BY tool
    ORDER BY calls DESC
    LIMIT 100`;
  return model ? d.prepare(sql).all(since, model) : d.prepare(sql).all(since);
}

/** Models that are failing badly enough to warrant de-prioritizing. */
function unhealthyModels(hours = 168, minRequests = 5, okThreshold = 85) {
  return modelReport(hours).filter(r => r.requests >= minRequests && r.ok_pct < okThreshold);
}

function summaryText(hours = 168) {
  const rows = modelReport(hours);
  if (!rows.length) return `No telemetry in the last ${hours}h.`;
  // Bullet list, never a markdown table (house rule).
  return rows.map(r =>
    `- **${r.model}** - ${r.requests} reqs, ${r.ok_pct}% ok, ttft ${r.avg_ttft_ms ?? '-'}ms, ` +
    `${r.tool_calls} tool calls, ${r.malformed_args} malformed, ` +
    `tool exec ${r.tool_exec_ok_pct ?? '-'}%` +
    (r.errors.length ? `, errors: ${r.errors.join(', ')}` : '')
  ).join('\n');
}

// ── Connection telemetry (P1) ──────────────────────────────────────────
// Proves whether the keep-alive pool is actually reusing sockets in
// production, and what that is worth in TTFT.

function connReport(hours = 24, model = null) {
  const d = getDb();
  if (!d) return { rows: [], overall: null };
  const since = `-${Math.max(1, hours)} hours`;
  const args = model ? [since, model] : [since];
  const where = `WHERE ts >= datetime('now', ?) AND conn_reused IS NOT NULL${model ? ' AND model = ?' : ''}`;

  const rows = d.prepare(`
    SELECT model,
           COUNT(*)                                       AS requests,
           SUM(conn_reused)                               AS reused,
           ROUND(100.0 * SUM(conn_reused) / COUNT(*), 1)  AS reuse_pct,
           CAST(AVG(CASE WHEN conn_reused = 1 THEN ttft_ms END) AS INT) AS ttft_warm_ms,
           CAST(AVG(CASE WHEN conn_reused = 0 THEN ttft_ms END) AS INT) AS ttft_cold_ms,
           CAST(AVG(CASE WHEN conn_reused = 0 THEN connect_ms END) AS INT) AS connect_ms
    FROM requests ${where}
    GROUP BY model
    ORDER BY requests DESC
  `).all(...args);

  const overall = d.prepare(`
    SELECT COUNT(*) AS requests,
           SUM(conn_reused) AS reused,
           ROUND(100.0 * SUM(conn_reused) / COUNT(*), 1) AS reuse_pct,
           COUNT(DISTINCT socket_id) AS sockets,
           CAST(AVG(CASE WHEN conn_reused = 1 THEN ttft_ms END) AS INT) AS ttft_warm_ms,
           CAST(AVG(CASE WHEN conn_reused = 0 THEN ttft_ms END) AS INT) AS ttft_cold_ms
    FROM requests ${where}
  `).get(...args);

  const proto = d.prepare(`
    SELECT alpn, tls_version, COUNT(*) AS n
    FROM requests ${where}
    GROUP BY alpn, tls_version ORDER BY n DESC
  `).all(...args);

  return { rows, overall, proto };
}

/**
 * Before/after comparison across a cutover timestamp (ISO or SQLite datetime).
 * Rows before the cutover have conn_reused NULL (pre-P0 build), so we compare
 * on TTFT and round-trip counts, which exist on both sides.
 */
function beforeAfter(cutoverISO, hours = 168, model = null) {
  const d = getDb();
  if (!d) return null;
  const since = `-${Math.max(1, hours)} hours`;
  const mClause = model ? 'AND model = ?' : '';
  const q = (cmp) => {
    const sql = `
      SELECT COUNT(*) AS requests,
             CAST(AVG(ttft_ms) AS INT) AS avg_ttft_ms,
             CAST(AVG(total_ms) AS INT) AS avg_total_ms,
             ROUND(100.0 * SUM(ok) / COUNT(*), 1) AS ok_pct,
             SUM(empty_response) AS empty
      FROM requests
      WHERE ts >= datetime('now', ?) AND ts ${cmp} datetime(?) ${mClause}`;
    const a = model ? [since, cutoverISO, model] : [since, cutoverISO];
    return d.prepare(sql).get(...a);
  };
  // Median is the honest statistic here — averages get wrecked by outliers.
  const med = (cmp) => {
    const sql = `
      SELECT ttft_ms FROM requests
      WHERE ts >= datetime('now', ?) AND ts ${cmp} datetime(?) ${mClause}
        AND ttft_ms IS NOT NULL AND ok = 1
      ORDER BY ttft_ms`;
    const a = model ? [since, cutoverISO, model] : [since, cutoverISO];
    const v = d.prepare(sql).all(...a).map(r => r.ttft_ms);
    if (!v.length) return null;
    return v[Math.floor(v.length / 2)];
  };
  return {
    cutover: cutoverISO,
    model: model || 'all',
    before: { ...q('<'), median_ttft_ms: med('<') },
    after: { ...q('>='), median_ttft_ms: med('>=') },
  };
}

function purgeOlderThan(days = 90) {
  const d = getDb();
  if (!d) return 0;
  const a = d.prepare(`DELETE FROM requests   WHERE ts < datetime('now', ?)`).run(`-${days} days`).changes;
  const b = d.prepare(`DELETE FROM tool_calls WHERE ts < datetime('now', ?)`).run(`-${days} days`).changes;
  return a + b;
}

module.exports = {
  recordRequest,
  recordToolCall,
  classifyError,
  modelReport,
  toolReport,
  unhealthyModels,
  summaryText,
  connReport,
  beforeAfter,
  purgeOlderThan,
  DB_PATH,
};
