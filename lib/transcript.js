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
//
// One database per agent (data/transcripts/<agent>.db): an agent's search touches only its own history, a file
// stays small enough to back up whole, and deleting, renaming or exporting an agent is one file. Row ids are unique
// within an agent's file (every caller looks a row up through its agent). An install that still has the combined
// file of earlier versions (data/transcript.db) has it split once, when the hub starts (migrate()); the old file is
// kept as transcript.db.pre-split. Until then every agent's rows stay in the combined file, as before.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = process.env.HUB_TRANSCRIPT_FILE || path.join(__dirname, '..', 'data', 'transcript.db');
const DB_DIR = process.env.HUB_TRANSCRIPT_DIR || DB_FILE.replace(/\.db$/, 's');
const MAX_TEXT = 64 * 1024;          // per row; tool outputs beyond this keep the head and tail
const KINDS = ['user', 'assistant', 'tool_use', 'tool_result', 'system'];
const SCHEMA = `CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, day TEXT NOT NULL, agent TEXT NOT NULL, owner TEXT,
        turn_id TEXT, origin TEXT, kind TEXT NOT NULL, tool TEXT, text TEXT NOT NULL, meta TEXT, hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS entries_agent_ts ON entries(agent, ts);
      CREATE UNIQUE INDEX IF NOT EXISTS entries_dedupe ON entries(agent, day, hash);
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(text, content='entries', content_rowid='id', tokenize='unicode61');
      CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN INSERT INTO entries_fts(rowid, text) VALUES (new.id, new.text); END;
      CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN INSERT INTO entries_fts(entries_fts, rowid, text) VALUES ('delete', old.id, old.text); END;`;
const COLUMNS = 'id, ts, day, agent, owner, turn_id, origin, kind, tool, text, meta, hash';

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;   // device names a Windows disk refuses as file names
/**
 * An agent's file name: the name itself when it is plain lowercase (case-blind file systems) and not a reserved
 * device name, else ~ and its hex (a long one shortened, with a hash of the whole name so two never share a file).
 */
function safeName(agent) {
  const s = String(agent);
  if (/^[a-z0-9_-]{1,64}$/.test(s) && !WIN_RESERVED.test(s)) return s;
  const hex = Buffer.from(s, 'utf8').toString('hex');
  return hex.length <= 120 ? `~${hex}` : `~${hex.slice(0, 80)}-${crypto.createHash('sha1').update(s).digest('hex').slice(0, 16)}`;
}
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/**
 * Split the combined archive of earlier versions (file) into one database per agent (dir), keeping every row's id.
 * Runs when the combined file exists, and not while another process has a transaction open on it (the checkpoint);
 * it is renamed to <file>.pre-split (dated if an earlier one is there) once every agent's rows are in their file.
 * A row already in the agent's file under the same id with the same content (an earlier attempt), or the same text
 * that day, is not copied twice. A row whose id another row took (an older version ran after an earlier split and
 * numbered from 1 again) is kept under a new number: never dropped. A file that isn't a readable archive makes it fail.
 * -> { split: false [, busy] } | { split: true, agents, rows, renumbered, ms }; throws when it can't be done
 */
function splitCombined({ file = DB_FILE, dir = DB_DIR, log = console.log } = {}) {
  if (!fs.existsSync(file)) return { split: false };
  const Database = require('better-sqlite3');
  const t0 = Date.now();
  // A file that isn't a readable archive stays where it is and the split fails: setting it aside would make the
  // history it holds look like none (an agent's name could then be taken as free). An admin decides what to do.
  const src = new Database(file, { fileMustExist: true });
  try { src.prepare('SELECT COUNT(*) AS n FROM entries').get(); } catch (e) { try { src.close(); } catch {} throw e; }
  let agents = 0, rows = 0, renumbered = 0;
  try {
    // A transaction another process has open makes the checkpoint busy (an idle connection doesn't: the port the
    // server holds is what keeps an older hub away).
    const cp = src.pragma('wal_checkpoint(TRUNCATE)');
    if (cp && cp[0] && cp[0].busy) {
      log('[transcript] the combined archive is in use by another process: it stays as it is, and a later start splits it');
      return { split: false, busy: true };
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const maxId = Number(src.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM entries').get().m) || 0;
    for (const { agent, n } of src.prepare('SELECT agent, COUNT(*) AS n FROM entries GROUP BY agent').all()) {
      const f = path.join(dir, `${safeName(agent)}.db`);
      const d = new Database(f);
      try {
        try { fs.chmodSync(f, 0o600); } catch {}
        d.pragma('journal_mode = WAL');
        d.exec(SCHEMA);
        // New rows in this file number above every combined id, even if this split stops before the copy below:
        // a later attempt can then never meet one of its own ids already taken.
        d.prepare("INSERT INTO sqlite_sequence (name, seq) SELECT 'entries', ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'entries')").run(maxId);
        d.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'entries'").run(maxId);
        const ins = d.prepare(`INSERT OR IGNORE INTO entries (${COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
        const insNew = d.prepare('INSERT OR IGNORE INTO entries (ts, day, agent, owner, turn_id, origin, kind, tool, text, meta, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
        // already here: the same text that day (the archive's own rule for one row, also after an earlier attempt)
        const same = d.prepare('SELECT 1 FROM entries WHERE day = ? AND hash = ? LIMIT 1');
        let missing = 0, moved = 0;
        d.transaction(() => {
          for (const r of src.prepare(`SELECT ${COLUMNS} FROM entries WHERE agent = ? ORDER BY id`).iterate(agent)) {
            if (ins.run(r.id, r.ts, r.day, r.agent, r.owner, r.turn_id, r.origin, r.kind, r.tool, r.text, r.meta, r.hash).changes) continue;
            if (same.get(r.day, r.hash)) continue;
            if (insNew.run(r.ts, r.day, r.agent, r.owner, r.turn_id, r.origin, r.kind, r.tool, r.text, r.meta, r.hash).changes) moved++; else missing++;
          }
        })();
        if (missing) throw new Error(`${agent}: ${missing} of ${n} rows could not be copied`);
        renumbered += moved;
      } finally { d.close(); }
      agents++; rows += n;
    }
  } finally { src.close(); }
  const kept = fs.existsSync(`${file}.pre-split`) ? `${file}.pre-split-${stamp()}` : `${file}.pre-split`;   // an earlier copy is never replaced
  for (const ext of ['', '-wal', '-shm']) { try { fs.renameSync(file + ext, kept + ext); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  const ms = Date.now() - t0;
  log(`[transcript] split the combined archive into ${agents} per-agent files (${rows} rows${renumbered ? `, ${renumbered} kept under a new number because their id was taken` : ''}, ${ms} ms); the old file is kept as ${path.basename(kept)}`);
  return { split: true, agents, rows, renumbered, ms };
}

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

function createTranscript({ file = DB_FILE, dir = null, now = Date.now, log = console.log, maxOpen = 32 } = {}) {
  if (!dir) { const p = path.parse(file); dir = file === DB_FILE ? DB_DIR : path.join(p.dir, `${p.name}s`); }
  const handles = new Map();   // agent -> open database, least recently used first
  // While the combined file of earlier versions exists (before the split, or when a split could not finish), every
  // agent's rows stay in it, as they always were: an archive is never half in one file and half in another. The
  // per-agent files are used only once the split has moved it aside.
  let combined = null, lastCombinedError = 0;
  const combinedMode = () => fs.existsSync(file);
  function openCombined() {
    if (combined) return combined;
    let d = null;
    try {
      d = new (require('better-sqlite3'))(file, { fileMustExist: true });
      d.pragma('journal_mode = WAL');
      d.exec(SCHEMA);
      return (combined = d);
    } catch (e) {
      if (d) { try { d.close(); } catch {} }
      if (Date.now() - lastCombinedError > 60000) { lastCombinedError = Date.now(); console.error(`[transcript] could not open the combined archive (nothing is recorded or found until it can be): ${e.message}`); }
      return false;
    }
  }
  const fileFor = (agent) => path.join(dir, `${safeName(agent)}.db`);
  /**
   * The agent's database. create:false never makes a file: null when it doesn't exist (ENOENT). On any other
   * failure (no permission, a damaged file) the result is false: "could not be opened", which callers must not
   * take for "nothing there".
   */
  function open(agent, { create = true } = {}) {
    if (combinedMode()) return openCombined();
    if (combined) { try { combined.close(); } catch {} combined = null; }   // the split moved it aside
    const key = String(agent);
    if (handles.has(key)) { const d = handles.get(key); handles.delete(key); handles.set(key, d); return d; }
    const f = fileFor(key);
    let exists = true;
    try { fs.statSync(f); } catch (e) { if (e.code !== 'ENOENT') { console.error(`[transcript] ${key}: ${e.message}`); return false; } exists = false; }
    if (!exists && !create) return null;
    let d = null;
    try {
      const Database = require('better-sqlite3');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      d = new Database(f);
      try { fs.chmodSync(f, 0o600); } catch {}
      d.pragma('journal_mode = WAL');
      d.exec(SCHEMA);
      handles.set(key, d);
      while (handles.size > maxOpen) {
        const [oldest, od] = handles.entries().next().value;
        handles.delete(oldest);
        try { od.close(); } catch {}
      }
      return d;
    } catch (e) {
      if (d) { try { d.close(); } catch {} }   // opened but not set up: never left open outside the LRU
      console.error(`[transcript] ${key}: could not open its archive: ${e.message}`);
      return false;
    }
  }

  /**
   * record({ agent, kind, text, tool, turnId, origin, owner, meta, ts, dedupeKey }) -> id | null (duplicate or disabled)
   * The same text on the same day is kept once (so importers can run again). dedupeKey separates rows whose text
   * may repeat for good reason: two workers running the same command each keep their step.
   */
  function record(r) {
    const d = open(r.agent); if (!d) return null;
    const text = clipText(r.text);
    if (!text.trim()) return null;
    const kind = KINDS.includes(r.kind) ? r.kind : 'system';
    const ts = r.ts ? new Date(r.ts).toISOString() : new Date(now()).toISOString();
    try {
      const info = d.prepare(`INSERT OR IGNORE INTO entries (ts, day, agent, owner, turn_id, origin, kind, tool, text, meta, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(ts, ts.slice(0, 10), String(r.agent), r.owner ? String(r.owner) : null, r.turnId || null, r.origin || null, kind, r.tool || null, text,
          r.meta ? JSON.stringify(r.meta).slice(0, 4000) : null, hashOf(kind, r.dedupeKey ? `${text}\n${r.dedupeKey}` : text));
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
    // A tool's whole output, handed over by the turn (res.archiveToolOutput) just before it sends the short copy the
    // pages show: the archive keeps the whole one (to MAX_TEXT, head and tail), the pages keep the short one.
    const fullOutputs = new Map();   // tool_call_id -> { text, meta }
    const prevArchive = res.archiveToolOutput;
    // meta: what the text alone doesn't say ({ is_error, interrupted }), kept with the row. Never throws: it runs
    // inside a route's tool loop.
    res.archiveToolOutput = (id, output, meta = null) => {
      try {
        if (id == null || id === '' || output == null) return;
        if (fullOutputs.size >= 200) fullOutputs.clear();   // ids whose event never came: never more than a few
        fullOutputs.set(String(id), { text: clipText(typeof output === 'string' ? output : JSON.stringify(output)), meta: meta && typeof meta === 'object' ? meta : null });
      } catch {}
    };
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
            const id = ev.tool_call_id != null && ev.tool_call_id !== '' ? String(ev.tool_call_id) : null;
            const whole = id !== null && fullOutputs.has(id) ? fullOutputs.get(id) : undefined;
            if (id !== null) fullOutputs.delete(id);
            const out = whole !== undefined ? whole.text : ev.output;
            const meta = { tool_call_id: ev.tool_call_id || null, ...((whole && whole.meta) || {}) };
            // a worker's answer handed over this way (a Claude sub-agent's result) keeps its own row, even when another
            // worker answered with the same words
            record({ agent, kind: 'tool_result', tool: meta.worker_event === 'answer' ? 'worker_answer' : (ev.tool || null), text: typeof out === 'string' ? out : JSON.stringify(out ?? ''), turnId, origin, owner, meta,
              ...(meta.worker_id != null ? { dedupeKey: `${meta.worker_id}:${id || ''}:${meta.worker_event || 'result'}` } : {}) });
          } else if (ev.type === 'interjection_received' && ev.message) {
            record({ agent, kind: 'user', text: String(ev.message), turnId, origin: 'interjection', owner });
          } else if (typeof ev.type === 'string' && ev.type.startsWith('worker_') && ev.worker_id != null) {
            recordWorker(ev);
          }
        }
      } catch {}
    };
    // A worker's run (a temporary worker, an agent consulted, a sub-agent), kept in the caller's archive so it can
    // be opened again later: its instructions, each step, its answer and how it ended, tagged with its worker_id.
    // Its own turn is ephemeral and keeps nothing.
    const workers = new Map();   // worker_id -> { started, description, text, subAgent, uses, results }
    let orphanSeq = 0;           // steps of a worker whose start this turn never saw
    const WORKER_TEXT_MAX = 256 * 1024;
    const workerRow = (wid, r, key) => record({ agent, turnId, origin, owner, ...r, meta: { worker_id: wid, ...(r.meta || {}) }, dedupeKey: `${wid}:${key}` });
    const finishWorker = (wid, outcome, error) => {
      const w = workers.get(wid);
      workers.delete(wid);
      // A Claude sub-agent that finished answers through the caller's tool result (tagged in the hand-over); its streamed
      // text is kept only when it ended some other way. An answer from a run that did not finish is marked partial.
      if (w && w.text.trim() && !(w.subAgent && outcome === 'done')) {
        workerRow(wid, { kind: 'tool_result', tool: 'worker_answer', text: w.text, meta: { worker_event: 'answer', outcome, ...(outcome !== 'done' ? { partial: true } : {}) } }, 'answer');
      }
      const label = (w && w.description) || 'Worker';
      const word = { done: 'finished', failed: 'failed', stopped: 'stopped', unfinished: 'did not finish' }[outcome] || outcome;
      workerRow(wid, { kind: 'system', tool: 'worker', text: `${label}: ${word}${error ? `\n${error}` : ''}`, meta: { worker_event: 'finished', outcome, ...(w ? { duration_ms: Math.max(0, now() - w.started) } : {}) } }, 'finished');
    };
    function recordWorker(ev) {
      const wid = String(ev.worker_id);
      if (ev.type === 'worker_started') {
        const description = String(ev.description || 'Worker');
        workers.set(wid, { started: now(), description, text: '', subAgent: ev.agent_type === 'sdk-agent', uses: 0, results: 0 });
        workerRow(wid, { kind: 'system', tool: 'worker', text: [description, typeof ev.prompt === 'string' ? ev.prompt : ''].filter(Boolean).join('\n\n'),
          meta: { worker_event: 'started', ...(ev.agent_type ? { agent_type: String(ev.agent_type) } : {}), ...(ev.model ? { model: String(ev.model) } : {}) } }, 'started');
      } else if (ev.type === 'worker_tool_use') {
        const w = workers.get(wid);
        const step = ev.tool_call_id || `use-${w ? ++w.uses : ++orphanSeq}`;   // without a call id: numbered, never merged
        const input = ev.input == null ? '' : (typeof ev.input === 'string' ? ev.input : JSON.stringify(ev.input));
        workerRow(wid, { kind: 'tool_use', tool: ev.tool || 'tool', text: `${ev.tool || 'tool'} ${input}`.trim(), meta: { tool_call_id: ev.tool_call_id || null } }, `${step}:use`);
      } else if (ev.type === 'worker_tool_result') {
        const w = workers.get(wid);
        const step = ev.tool_call_id || `result-${w ? ++w.results : ++orphanSeq}`;   // numbered on its own: results may come out of order
        workerRow(wid, { kind: 'tool_result', tool: ev.tool || null, text: typeof ev.output === 'string' ? ev.output : JSON.stringify(ev.output ?? ''), meta: { tool_call_id: ev.tool_call_id || null } }, `${step}:result`);
      } else if (ev.type === 'worker_text_delta' && typeof ev.text === 'string') {
        const w = workers.get(wid);
        if (w) { w.text += ev.text; if (w.text.length > WORKER_TEXT_MAX) w.text = clipText(w.text, WORKER_TEXT_MAX / 2); }
      } else if (ev.type === 'worker_completed') {
        finishWorker(wid, 'done', null);
      } else if (ev.type === 'worker_failed') {
        finishWorker(wid, ev.cancelled ? 'stopped' : 'failed', ev.cancelled ? null : (ev.error ? String(ev.error).slice(0, 300) : null));
      }
    }
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
        if (prevArchive) res.archiveToolOutput = prevArchive; else delete res.archiveToolOutput;
        fullOutputs.clear();
        for (const wid of [...workers.keys()]) { try { finishWorker(wid, 'unfinished', null); } catch {} }   // still running when the turn ended
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
    const list = [...new Set((Array.isArray(agents) ? agents : [agents]).map(String).filter(Boolean))];
    if (!list.length) return [];
    const q = ftsQuery(query);
    const lim = Math.max(1, Math.min(100, Number(limit) || 20));
    const where = ['e.agent = ?'];
    const params = [];
    if (from) { where.push('e.ts >= ?'); params.push(new Date(from).toISOString()); }
    if (to) { where.push('e.ts <= ?'); params.push(new Date(to).toISOString()); }
    if (Array.isArray(kinds) && kinds.length) { where.push(`e.kind IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds); }
    const out = [];
    for (const agent of list) {   // each agent's own file: its search never reads another agent's history
      const d = open(agent, { create: false }); if (!d) continue;
      try {
        if (!q) {
          out.push(...d.prepare(`SELECT e.id, e.ts, e.agent, e.kind, e.tool, e.text FROM entries e WHERE ${where.join(' AND ')} ORDER BY e.ts DESC LIMIT ?`).all(agent, ...params, lim)
            .map(r => ({ ...r, snippet: r.text.slice(0, 300), text: clipText(r.text, 4000) })));
          continue;
        }
        out.push(...d.prepare(`SELECT e.id, e.ts, e.agent, e.kind, e.tool, e.text, snippet(entries_fts, 0, '[', ']', ' … ', 28) AS snippet, bm25(entries_fts) AS rank
          FROM entries_fts JOIN entries e ON e.id = entries_fts.rowid WHERE entries_fts MATCH ? AND ${where.join(' AND ')} ORDER BY rank LIMIT ?`).all(q, agent, ...params, lim)
          .map(r => ({ id: r.id, ts: r.ts, agent: r.agent, kind: r.kind, tool: r.tool, snippet: r.snippet, text: clipText(r.text, 4000) })));
      } catch (e) { console.error(`[transcript] ${agent}: search failed: ${e.message}`); }
    }
    // the best matches of each agent, newest first (ranks from different files can't be compared)
    return out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.id - a.id)).slice(0, lim);
  }

  /**
   * context(id, { before, after, agents }) -> the rows around one hit, oldest first. Row ids are unique within an
   * agent's file, so the agent is required: the id is looked up in each listed agent's file, first match wins.
   */
  function context(id, { before = 4, after = 4, agents = null } = {}) {
    const list = Array.isArray(agents) ? [...new Set(agents.map(String).filter(Boolean))] : [];
    for (const agent of list) {
      const d = open(agent, { create: false }); if (!d) continue;
      try {
        const row = d.prepare('SELECT * FROM entries WHERE id = ? AND agent = ?').get(Number(id), agent);
        if (!row) continue;
        const b = d.prepare('SELECT id, ts, agent, kind, tool, text FROM entries WHERE agent = ? AND id < ? ORDER BY id DESC LIMIT ?').all(row.agent, row.id, Math.min(50, before)).reverse();
        const a = d.prepare('SELECT id, ts, agent, kind, tool, text FROM entries WHERE agent = ? AND id > ? ORDER BY id ASC LIMIT ?').all(row.agent, row.id, Math.min(50, after));
        return [...b, { id: row.id, ts: row.ts, agent: row.agent, kind: row.kind, tool: row.tool, text: row.text, hit: true }, ...a].map(r => ({ ...r, text: clipText(r.text, 6000) }));
      } catch (e) { console.error(`[transcript] ${agent}: context failed: ${e.message}`); }
    }
    return [];
  }

  /** stats(agent) -> counts, or null when the agent's archive exists but could not be opened (never "nothing there"). */
  function stats(agent) {
    const d = open(agent, { create: false });
    if (d === false) return null;
    if (!d) return { agent, entries: 0, first: null, last: null, bytes: 0, byKind: {} };
    try {
      const r = d.prepare('SELECT COUNT(*) n, MIN(ts) first, MAX(ts) last, SUM(LENGTH(text)) bytes FROM entries WHERE agent = ?').get(String(agent));
      const byKind = Object.fromEntries(d.prepare('SELECT kind, COUNT(*) n FROM entries WHERE agent = ? GROUP BY kind').all(String(agent)).map(x => [x.kind, x.n]));
      return { agent, entries: r.n, first: r.first, last: r.last, bytes: r.bytes || 0, byKind };
    } catch (e) { console.error(`[transcript] ${agent}: stats failed: ${e.message}`); return null; }
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

  function close() {
    for (const d of handles.values()) { try { d.close(); } catch {} }
    handles.clear();
    if (combined) { try { combined.close(); } catch {} combined = null; }
  }

  /** Split the combined archive of earlier versions into per-agent files (the hub calls this once, at start). */
  function migrate() {
    close();
    try { return splitCombined({ file, dir, log }); }
    catch (e) { console.error(`[transcript] could not split the combined archive (it stays in use as it is; the next start tries again, and if the file is damaged an admin needs to look at ${path.basename(file)}): ${e.message}`); return { split: false, error: e.message }; }
  }

  return { record, tap, search, context, stats, importConversation, importClaudeSession, close, migrate, file, dir, fileFor, ftsQuery, clipText };
}

let shared = null;
function getTranscript(opts) { if (!shared) shared = createTranscript(opts); return shared; }

module.exports = { createTranscript, getTranscript, splitCombined, safeName, ftsQuery, clipText, KINDS, DB_FILE, DB_DIR };
