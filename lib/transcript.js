'use strict';
// Transcript archive: every turn of every agent, in full, in the hub's own database (data/transcript.db),
// with a full-text index. What the provider's session file holds (the Claude client's transcript, the
// Codex thread) is a copy the hub cannot control; this is the record the hub owns, so an agent's history
// survives a provider change, a session reset or a compaction, and the agent can search it at will.
//
// Rows (entries): user text, assistant text, tool_use (name + input), tool_result (output), system notes.
// Captured by tapping the SSE stream of a turn (every path: Claude SDK, gateway, Codex emit the same
// chunks), so nothing in sdk-chat's three paths has to know about this module beyond one tap call.
// Importers backfill the hub's own chat logs and the Claude client's session files.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = process.env.HUB_TRANSCRIPT_FILE || path.join(__dirname, '..', 'data', 'transcript.db');
const MAX_TEXT = 64 * 1024;          // per row; tool outputs beyond this keep the head and tail
const KINDS = ['user', 'assistant', 'tool_use', 'tool_result', 'system'];

function clipText(s, max = MAX_TEXT) {
  s = String(s ?? '');
  if (s.length <= max) return s;
  const half = Math.floor(max / 2) - 20;
  return `${s.slice(0, half)}\n…[${s.length - 2 * half} chars omitted]…\n${s.slice(-half)}`;
}
function hashOf(kind, text) { return crypto.createHash('sha1').update(`${kind}\n${text}`).digest('hex').slice(0, 20); }

/** FTS5 match string from free text: each word quoted (no operator surprises), prefix match on the last. */
function ftsQuery(q) {
  const words = String(q || '').replace(/["']/g, ' ').split(/\s+/).filter(w => w.length > 1).slice(0, 12);
  if (!words.length) return null;
  return words.map((w, i) => `"${w}"${i === words.length - 1 && w.length >= 3 ? '*' : ''}`).join(' ');
}

function createTranscript({ file = DB_FILE, now = Date.now, log = console.log } = {}) {
  let db = null;
  function open() {
    if (db !== null) return db;
    try {
      const Database = require('better-sqlite3');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      db = new Database(file);
      try { fs.chmodSync(file, 0o600); } catch {}
      db.pragma('journal_mode = WAL');
      db.exec(`CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, day TEXT NOT NULL, agent TEXT NOT NULL, owner TEXT,
        turn_id TEXT, origin TEXT, kind TEXT NOT NULL, tool TEXT, text TEXT NOT NULL, meta TEXT, hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS entries_agent_ts ON entries(agent, ts);
      CREATE UNIQUE INDEX IF NOT EXISTS entries_dedupe ON entries(agent, day, hash);
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(text, content='entries', content_rowid='id', tokenize='unicode61');
      CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN INSERT INTO entries_fts(rowid, text) VALUES (new.id, new.text); END;
      CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN INSERT INTO entries_fts(entries_fts, rowid, text) VALUES ('delete', old.id, old.text); END;`);
    } catch (e) { console.error('[transcript] disabled:', e.message); db = false; }
    return db;
  }

  /** record({ agent, kind, text, tool, turnId, origin, owner, meta, ts }) -> id | null (duplicate or disabled) */
  function record(r) {
    const d = open(); if (!d) return null;
    const text = clipText(r.text);
    if (!text.trim()) return null;
    const kind = KINDS.includes(r.kind) ? r.kind : 'system';
    const ts = r.ts ? new Date(r.ts).toISOString() : new Date(now()).toISOString();
    try {
      const info = d.prepare(`INSERT OR IGNORE INTO entries (ts, day, agent, owner, turn_id, origin, kind, tool, text, meta, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(ts, ts.slice(0, 10), String(r.agent), r.owner ? String(r.owner) : null, r.turnId || null, r.origin || null, kind, r.tool || null, text,
          r.meta ? JSON.stringify(r.meta).slice(0, 4000) : null, hashOf(kind, text));
      return info.changes ? Number(info.lastInsertRowid) : null;
    } catch (e) { console.error('[transcript] record failed:', e.message); return null; }
  }

  /**
   * tap(res, { agent, turnId, origin, owner }) -> { finish(ok, error) }
   * Wraps res.write (and the detached-turn hook res.observeClosed) to collect the assistant text and
   * every tool_use / tool_result event of the turn. Text is written as one assistant row at finish.
   */
  function tap(res, { agent, turnId = null, origin = null, owner = null } = {}) {
    let text = '';
    let finished = false;
    const seen = (chunk) => {
      try {
        const c = chunk && chunk.choices && chunk.choices[0];
        const delta = c && c.delta && c.delta.content;
        if (typeof delta === 'string' && delta) text += delta;
        const ev = chunk && chunk.gateway;
        if (ev && typeof ev === 'object') {
          if (ev.type === 'tool_use' || ev.type === 'tool_start') {
            const input = ev.input == null ? '' : (typeof ev.input === 'string' ? ev.input : JSON.stringify(ev.input));
            if (ev.type === 'tool_use') record({ agent, kind: 'tool_use', tool: ev.tool || 'tool', text: `${ev.tool || 'tool'} ${input}`.trim(), turnId, origin, owner, meta: { tool_call_id: ev.tool_call_id || null } });
          } else if (ev.type === 'tool_result') {
            record({ agent, kind: 'tool_result', tool: ev.tool || null, text: typeof ev.output === 'string' ? ev.output : JSON.stringify(ev.output ?? ''), turnId, origin, owner, meta: { tool_call_id: ev.tool_call_id || null } });
          } else if (ev.type === 'interjection_received' && ev.message) {
            record({ agent, kind: 'user', text: String(ev.message), turnId, origin: 'interjection', owner });
          }
        }
      } catch {}
    };
    const origWrite = res.write;
    res.write = (chunk, ...rest) => {
      if (typeof chunk === 'string' && chunk.startsWith('data: ')) {
        const json = chunk.slice(6).trim();
        if (json && json !== '[DONE]') { try { seen(JSON.parse(json)); } catch {} }
      }
      return origWrite.call(res, chunk, ...rest);
    };
    const prevObserve = res.observeClosed;
    res.observeClosed = (data) => { seen(data); if (typeof prevObserve === 'function') { try { prevObserve(data); } catch {} } };
    return {
      finish(ok = true, error = null) {
        if (finished) return; finished = true;
        res.write = origWrite;
        if (prevObserve) res.observeClosed = prevObserve; else delete res.observeClosed;
        if (text.trim()) record({ agent, kind: 'assistant', text, turnId, origin, owner, meta: ok ? undefined : { error: String(error || 'failed').slice(0, 300) } });
      },
      get text() { return text; },
    };
  }

  /**
   * search(agents, query, { from, to, kinds, limit }) -> [{ id, ts, agent, kind, tool, snippet, text }]
   * agents: one name or a list the caller is allowed to read. Newest-first among the best matches.
   */
  function search(agents, query, { from = null, to = null, kinds = null, limit = 20 } = {}) {
    const d = open(); if (!d) return [];
    const list = (Array.isArray(agents) ? agents : [agents]).map(String).filter(Boolean);
    if (!list.length) return [];
    const q = ftsQuery(query);
    const lim = Math.max(1, Math.min(100, Number(limit) || 20));
    const where = [`e.agent IN (${list.map(() => '?').join(',')})`];
    const params = [...list];
    if (from) { where.push('e.ts >= ?'); params.push(new Date(from).toISOString()); }
    if (to) { where.push('e.ts <= ?'); params.push(new Date(to).toISOString()); }
    if (Array.isArray(kinds) && kinds.length) { where.push(`e.kind IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds); }
    try {
      if (!q) {
        return d.prepare(`SELECT e.id, e.ts, e.agent, e.kind, e.tool, e.text FROM entries e WHERE ${where.join(' AND ')} ORDER BY e.ts DESC LIMIT ?`).all(...params, lim)
          .map(r => ({ ...r, snippet: r.text.slice(0, 300), text: clipText(r.text, 4000) }));
      }
      return d.prepare(`SELECT e.id, e.ts, e.agent, e.kind, e.tool, e.text, snippet(entries_fts, 0, '[', ']', ' … ', 28) AS snippet, bm25(entries_fts) AS rank
        FROM entries_fts JOIN entries e ON e.id = entries_fts.rowid WHERE entries_fts MATCH ? AND ${where.join(' AND ')} ORDER BY rank LIMIT ?`).all(q, ...params, lim)
        .map(r => ({ id: r.id, ts: r.ts, agent: r.agent, kind: r.kind, tool: r.tool, snippet: r.snippet, text: clipText(r.text, 4000) }))
        .sort((a, b) => (a.ts < b.ts ? 1 : -1));
    } catch (e) { console.error('[transcript] search failed:', e.message); return []; }
  }

  /** context(id, { before, after, agents }) -> the rows around one hit, oldest first (same agent). */
  function context(id, { before = 4, after = 4, agents = null } = {}) {
    const d = open(); if (!d) return [];
    const row = d.prepare('SELECT * FROM entries WHERE id = ?').get(Number(id));
    if (!row) return [];
    if (Array.isArray(agents) && !agents.map(String).includes(row.agent)) return [];
    const b = d.prepare('SELECT id, ts, agent, kind, tool, text FROM entries WHERE agent = ? AND id < ? ORDER BY id DESC LIMIT ?').all(row.agent, row.id, Math.min(50, before)).reverse();
    const a = d.prepare('SELECT id, ts, agent, kind, tool, text FROM entries WHERE agent = ? AND id > ? ORDER BY id ASC LIMIT ?').all(row.agent, row.id, Math.min(50, after));
    return [...b, { id: row.id, ts: row.ts, agent: row.agent, kind: row.kind, tool: row.tool, text: row.text, hit: true }, ...a].map(r => ({ ...r, text: clipText(r.text, 6000) }));
  }

  function stats(agent) {
    const d = open(); if (!d) return null;
    const r = d.prepare('SELECT COUNT(*) n, MIN(ts) first, MAX(ts) last, SUM(LENGTH(text)) bytes FROM entries WHERE agent = ?').get(String(agent));
    const byKind = Object.fromEntries(d.prepare('SELECT kind, COUNT(*) n FROM entries WHERE agent = ? GROUP BY kind').all(String(agent)).map(x => [x.kind, x.n]));
    return { agent, entries: r.n, first: r.first, last: r.last, bytes: r.bytes || 0, byKind };
  }

  // ── Importers (backfill) ──
  /** The hub's own chat log (data/conversations/<agent>.jsonl: {ts, role, content}). */
  function importConversation(agent, jsonlPath, { owner = null } = {}) {
    let n = 0;
    let lines = []; try { lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean); } catch { return 0; }
    for (const l of lines) {
      let e; try { e = JSON.parse(l); } catch { continue; }
      const kind = e.role === 'assistant' ? 'assistant' : e.role === 'user' ? 'user' : 'system';
      const text = typeof e.content === 'string' ? e.content : JSON.stringify(e.content ?? '');
      if (record({ agent, kind, text, ts: e.ts || e.timestamp || null, owner, origin: e.origin ? String(e.origin.kind || e.origin) : null, meta: { source: 'conversation' } })) n++;
    }
    return n;
  }

  /** The Claude client's session file (~/.claude/projects/<dir>/<session>.jsonl): assistant text + tool_use, user text + tool_result. */
  function importClaudeSession(agent, jsonlPath, { owner = null } = {}) {
    let n = 0;
    let fd; try { fd = fs.readFileSync(jsonlPath, 'utf8'); } catch { return 0; }
    for (const l of fd.split('\n')) {
      if (!l) continue;
      let e; try { e = JSON.parse(l); } catch { continue; }
      if (e.type !== 'assistant' && e.type !== 'user') continue;
      const m = e.message || {};
      const blocks = Array.isArray(m.content) ? m.content : (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : []);
      const ts = e.timestamp || null;
      const meta = { source: 'claude-session', ...(e.isSidechain ? { sidechain: true } : {}) };
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && b.text && b.text.trim()) {
          if (record({ agent, kind: e.type === 'assistant' ? 'assistant' : 'user', text: b.text, ts, owner, meta })) n++;
        } else if (b.type === 'tool_use') {
          const input = typeof b.input === 'string' ? b.input : JSON.stringify(b.input || {});
          if (record({ agent, kind: 'tool_use', tool: b.name || 'tool', text: `${b.name || 'tool'} ${input}`, ts, owner, meta: { ...meta, tool_call_id: b.id || null } })) n++;
        } else if (b.type === 'tool_result') {
          const c = b.content;
          const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (x && x.type === 'text') ? x.text : (x && x.type === 'image') ? '[image]' : JSON.stringify(x)).join('\n') : JSON.stringify(c ?? '');
          if (record({ agent, kind: 'tool_result', text, ts, owner, meta: { ...meta, tool_call_id: b.tool_use_id || null, is_error: !!b.is_error } })) n++;
        }
      }
    }
    return n;
  }

  function close() { if (db) { try { db.close(); } catch {} db = null; } }

  return { record, tap, search, context, stats, importConversation, importClaudeSession, close, file, ftsQuery, clipText };
}

let shared = null;
function getTranscript(opts) { if (!shared) shared = createTranscript(opts); return shared; }

module.exports = { createTranscript, getTranscript, ftsQuery, clipText, KINDS, DB_FILE };
