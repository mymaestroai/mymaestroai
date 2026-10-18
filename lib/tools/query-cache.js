// query-cache.js - Shared cross-agent cache for expensive read-only query tools.
// Same tool + same args within TTL returns the cached result instantly instead of
// re-running the query.  Persists to disk so it survives server restarts.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'query-cache.json');
const INDEX_FILE = path.join(__dirname, '..', '..', 'data', 'query-cache-index.json');
const BLOB_DIR = path.join(__dirname, '..', '..', 'data', 'query-cache', 'blobs');
const DEFAULT_TTL_MS = 30 * 60 * 1000;   // 30 minutes
const LONG_TTL_MS = 4 * 60 * 60 * 1000;  // 4 hours for expensive sources (long investigations)
const MAX_ENTRIES = 500;
const INLINE_RESULT_BYTES = 400 * 1024;  // results above this spill to a blob file on disk

// Expensive sources get the long TTL - investigations run for hours.
const LONG_TTL_PATTERNS = [
  /execute_query/i,
];

function ttlFor(toolName) {
  return LONG_TTL_PATTERNS.some(p => p.test(toolName || '')) ? LONG_TTL_MS : DEFAULT_TTL_MS;
}

function isExpired(entry, now = Date.now()) {
  return now - entry.ts > (entry.ttlMs || ttlFor(entry.tool));
}

// Tools whose results are worth caching: expensive, read-only, deterministic-ish.
const CACHEABLE_PATTERNS = [
  /execute_query/i,
  /describe_object/i,
  /list_objects/i,
  /query_nvd_cves|query_osv/i,
];

// Never cache these even if they match above (mutations / session-dependent)
const NEVER_CACHE = [
  /create|update|delete|insert|write|send|post|add_comment/i,
];

let cache = new Map();   // key -> { result, ts, tool, argsSummary, hits }
let dirty = false;

// ── Load / persist ──────────────────────────────────────────────────────

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const now = Date.now();
    for (const [k, v] of Object.entries(raw)) {
      if (!isExpired(v, now)) cache.set(k, v);
    }
  } catch (_e) { /* no cache file yet */ }
  // Sweep orphaned blob files (expired entries)
  try {
    for (const f of fs.readdirSync(BLOB_DIR)) {
      const key = f.replace(/\.txt$/, '');
      if (!cache.has(key)) fs.unlinkSync(path.join(BLOB_DIR, f));
    }
  } catch (_e) { /* no blob dir yet */ }
}

function flush() {
  if (!dirty) return;
  dirty = false;
  try {
    const obj = Object.fromEntries(cache.entries());
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj), { mode: 0o600 });
    writeIndex();
  } catch (e) {
    console.error('[query-cache] flush failed:', e.message);
  }
}

// Human/agent-readable pointer file listing every live cache entry.
// Agents consult this (via the search_query_cache tool) BEFORE running queries.
function writeIndex() {
  try {
    const now = Date.now();
    const entries = [...cache.entries()].map(([k, v]) => ({
      key: k,
      tool: v.tool,
      args: v.argsSummary,
      ageMinutes: Math.round((now - v.ts) / 60000),
      sizeBytes: v.blobFile ? (v.blobBytes || 0) : (v.result || '').length,
      hits: v.hits || 0,
      spilled: !!v.blobFile,
      ttlMinutes: (v.ttlMs || ttlFor(v.tool)) / 60000,
    })).sort((a, b) => a.ageMinutes - b.ageMinutes);
    fs.writeFileSync(INDEX_FILE, JSON.stringify({ updated: new Date().toISOString(), defaultTtlMinutes: DEFAULT_TTL_MS / 60000, longTtlMinutes: LONG_TTL_MS / 60000, entries }, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error('[query-cache] index write failed:', e.message);
  }
}

setInterval(flush, 60 * 1000).unref();
load();

// Flush on shutdown so the last <60s of writes aren't lost.  server.js signal
// handlers call process.exit(), which fires 'exit' - flush() is sync-safe.
process.on('exit', () => { try { flush(); } catch (_e) { /* best effort */ } });

// ── Core API ────────────────────────────────────────────────────────────

// Normalize SQL so trivially-reformatted queries hit the same cache key:
// collapse whitespace, strip comments, lowercase, drop trailing semicolon.
// String literals may be case-folded too - acceptable: worst case is a rare
// false hit on queries differing ONLY by literal case, and SQL comparisons
// against these sources are mostly case-insensitive anyway.
function normalizeSql(sql) {
  return String(sql)
    .replace(/--[^\n]*/g, ' ')          // line comments
    .replace(/\/\*[\s\S]*?\*\//g, ' ')  // block comments
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;$/, '')
    .toLowerCase();
}

const SQL_ARG_KEYS = new Set(['query', 'sql', 'statement']);

function normalizeArgs(argsJson) {
  // Sort keys so {a:1,b:2} and {b:2,a:1} hash identically; normalize SQL args.
  try {
    const parsed = JSON.parse(argsJson || '{}');
    const sorted = {};
    for (const k of Object.keys(parsed).sort()) {
      sorted[k] = (SQL_ARG_KEYS.has(k) && typeof parsed[k] === 'string')
        ? normalizeSql(parsed[k])
        : parsed[k];
    }
    return JSON.stringify(sorted);
  } catch {
    return argsJson || '';
  }
}

function keyFor(toolName, argsJson) {
  const norm = normalizeArgs(argsJson);
  return crypto.createHash('sha256').update(toolName + '\u0000' + norm).digest('hex');
}

function isCacheable(toolName, argsJson) {
  if (!toolName) return false;
  if (NEVER_CACHE.some(p => p.test(toolName))) return false;
  if (!CACHEABLE_PATTERNS.some(p => p.test(toolName))) return false;
  // Don't cache queries with explicit "no cache" hint or mutating SQL
  try {
    const args = JSON.parse(argsJson || '{}');
    const sql = (args.query || args.sql || '').toString();
    if (/^\s*(insert|update|delete|merge|create|drop|alter|grant|revoke)\b/i.test(sql)) return false;
  } catch { /* ignore */ }
  return true;
}

/**
 * Look up a cached result.  Returns { result, ageMs, hits } or null.
 */
function readEntryResult(entry) {
  if (entry.blobFile) {
    try {
      return fs.readFileSync(path.join(BLOB_DIR, entry.blobFile), 'utf8');
    } catch (e) {
      return null;   // blob lost - treat as miss
    }
  }
  return entry.result;
}

// Preview a large result: cut on a line boundary, report N-of-M lines.
function makePreview(result, entry, blobPath) {
  const totalLines = (result.match(/\n/g) || []).length + 1;
  let cut = result.slice(0, 4000);
  const lastNl = cut.lastIndexOf('\n');
  if (lastNl > 0 && cut.length === 4000) cut = cut.slice(0, lastNl);   // drop partial final line
  const shownLines = (cut.match(/\n/g) || []).length + 1;
  return cut +
    `\n\n[showing ${shownLines} of ${totalLines} lines - full result is ${(entry.blobBytes / 1024).toFixed(0)}KB, stored at ${blobPath} - use Read/Bash (grep, head, jq) on that file to extract what you need instead of re-running the query]`;
}

function get(toolName, argsJson) {
  if (!isCacheable(toolName, argsJson)) return null;
  const k = keyFor(toolName, argsJson);
  const entry = cache.get(k);
  if (!entry) return null;
  const ageMs = Date.now() - entry.ts;
  if (isExpired(entry)) {
    deleteEntry(k);
    return null;
  }
  const result = readEntryResult(entry);
  if (result == null) { deleteEntry(k); return null; }
  entry.hits = (entry.hits || 0) + 1;
  dirty = true;
  // For spilled results, return a summary + file pointer instead of the full blob
  // (re-injecting multi-MB results into context defeats the purpose).
  if (entry.blobFile) {
    const blobPath = path.join(BLOB_DIR, entry.blobFile);
    return {
      result: makePreview(result, entry, blobPath),
      ageMs, hits: entry.hits, spilled: true, blobPath,
    };
  }
  return { result, ageMs, hits: entry.hits };
}

function deleteEntry(k) {
  const entry = cache.get(k);
  if (entry && entry.blobFile) {
    try { fs.unlinkSync(path.join(BLOB_DIR, entry.blobFile)); } catch (_e) { /* ok */ }
  }
  cache.delete(k);
  dirty = true;
}

/**
 * Store a successful result.  Skips errors and oversized payloads.
 */
function put(toolName, argsJson, result) {
  if (!isCacheable(toolName, argsJson)) return;
  if (typeof result !== 'string') return;
  // Never cache errors or empty results
  if (!result.trim()) return;
  if (/^error|error executing|sql compilation error|does not exist or not authorized|timed out|denied by user/i.test(result.trim())) return;

  const k = keyFor(toolName, argsJson);
  const entry = {
    ts: Date.now(),
    tool: toolName,
    argsSummary: normalizeArgs(argsJson).slice(0, 400),
    hits: 0,
    ttlMs: ttlFor(toolName),
  };

  if (result.length > INLINE_RESULT_BYTES) {
    // Spill large results to a blob file; cache holds summary + pointer
    try {
      fs.mkdirSync(BLOB_DIR, { recursive: true, mode: 0o700 });
      const blobFile = k + '.txt';
      fs.writeFileSync(path.join(BLOB_DIR, blobFile), result, { mode: 0o600 });
      entry.blobFile = blobFile;
      entry.blobBytes = result.length;
    } catch (e) {
      console.error('[query-cache] blob spill failed:', e.message);
      return;   // couldn't spill - don't cache
    }
  } else {
    entry.result = result;
  }
  cache.set(k, entry);

  // Evict oldest when over capacity
  if (cache.size > MAX_ENTRIES) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < cache.size - MAX_ENTRIES; i++) deleteEntry(oldest[i][0]);
  }
  dirty = true;
}

/** Clear the whole cache (or entries matching a tool-name substring). */
function clear(toolFilter) {
  for (const [k, v] of [...cache.entries()]) {
    if (!toolFilter || v.tool.includes(toolFilter)) deleteEntry(k);
  }
  dirty = true;
  flush();
}

/**
 * Search live cache entries by keyword (matches tool name + args).
 * Returns matching entries with age, size, and how to retrieve the result.
 */
function search(query, limit = 20) {
  const now = Date.now();
  const terms = (query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const [k, v] of cache.entries()) {
    if (isExpired(v, now)) { deleteEntry(k); continue; }
    const haystack = (v.tool + ' ' + (v.argsSummary || '')).toLowerCase();
    if (terms.length && !terms.every(t => haystack.includes(t))) continue;
    out.push({
      key: k,
      tool: v.tool,
      args: v.argsSummary,
      ageMinutes: Math.round((now - v.ts) / 60000),
      sizeBytes: v.blobFile ? (v.blobBytes || 0) : (v.result || '').length,
      spilled: !!v.blobFile,
      blobPath: v.blobFile ? path.join(BLOB_DIR, v.blobFile) : null,
      hits: v.hits || 0,
    });
  }
  out.sort((a, b) => a.ageMinutes - b.ageMinutes);
  return out.slice(0, limit);
}

/** Fetch a cached result by its key (from search results). */
function getByKey(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (isExpired(entry)) { deleteEntry(key); return null; }
  const result = readEntryResult(entry);
  if (result == null) { deleteEntry(key); return null; }
  entry.hits = (entry.hits || 0) + 1;
  dirty = true;
  if (entry.blobFile) {
    const blobPath = path.join(BLOB_DIR, entry.blobFile);
    return { result: makePreview(result, entry, blobPath), tool: entry.tool, ageMs: Date.now() - entry.ts, spilled: true, blobPath };
  }
  return { result, tool: entry.tool, ageMs: Date.now() - entry.ts };
}

function stats() {
  let totalHits = 0;
  for (const v of cache.values()) totalHits += v.hits || 0;
  return { entries: cache.size, totalHits, ttlMinutes: DEFAULT_TTL_MS / 60000 };
}

module.exports = { get, put, clear, stats, isCacheable, flush, search, getByKey, INDEX_FILE, BLOB_DIR };
