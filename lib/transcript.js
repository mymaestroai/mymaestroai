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
      CREATE INDEX IF NOT EXISTS entries_tool_ts ON entries(tool, ts);
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
  // How long real searches take, per agent (the newest SEARCH_TIMES; in memory only): lib/memory-health reads them
  // instead of running searches of its own. recall's hits on every incoming message keep them current.
  const SEARCH_TIMES = 50;
  const searchLog = new Map();
  function noteSearch(agent, ms) {
    let l = searchLog.get(agent);
    if (!l) { l = []; searchLog.set(agent, l); }
    l.push({ at: now(), ms });
    if (l.length > SEARCH_TIMES) l.shift();
  }
  const searchFails = new Map();   // agent -> times of its searches that failed (the newest SEARCH_TIMES)
  function noteSearchFailure(agent) {
    let l = searchFails.get(agent);
    if (!l) { l = []; searchFails.set(agent, l); }
    l.push(now());
    if (l.length > SEARCH_TIMES) l.shift();
  }
  /** searchTimes(agent) -> { count, maxMs, slow, verySlow, failed, lastAt } of its newest real searches of the last 7
   *  days (slow: 500 ms or longer; verySlow: 2 s or longer; count 0 when none since start). A search that failed isn't
   *  timed; failed counts those of the last 7 days. */
  function searchTimes(agent) {
    const since = now() - 7 * 86400000;
    const l = (searchLog.get(String(agent)) || []).filter(x => x.at >= since);
    const failed = (searchFails.get(String(agent)) || []).filter(at => at >= since).length;
    return { count: l.length, maxMs: l.reduce((m, x) => Math.max(m, x.ms), 0), slow: l.filter(x => x.ms >= 500).length, verySlow: l.filter(x => x.ms >= 2000).length, failed, lastAt: l.length ? l[l.length - 1].at : null };
  }

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
      const t0 = process.hrtime.bigint();
      try {
        if (!q) {
          out.push(...d.prepare(`SELECT e.id, e.ts, e.agent, e.kind, e.tool, e.text FROM entries e WHERE ${where.join(' AND ')} ORDER BY e.ts DESC LIMIT ?`).all(agent, ...params, lim)
            .map(r => ({ ...r, snippet: r.text.slice(0, 300), text: clipText(r.text, 4000) })));
          continue;
        }
        out.push(...d.prepare(`SELECT e.id, e.ts, e.agent, e.kind, e.tool, e.text, snippet(entries_fts, 0, '[', ']', ' … ', 28) AS snippet, bm25(entries_fts) AS rank
          FROM entries_fts JOIN entries e ON e.id = entries_fts.rowid WHERE entries_fts MATCH ? AND ${where.join(' AND ')} ORDER BY rank LIMIT ?`).all(q, agent, ...params, lim)
          .map(r => ({ id: r.id, ts: r.ts, agent: r.agent, kind: r.kind, tool: r.tool, snippet: r.snippet, text: clipText(r.text, 4000) })));
        noteSearch(agent, Number(process.hrtime.bigint() - t0) / 1e6);
      } catch (e) { noteSearchFailure(agent); console.error(`[transcript] ${agent}: search failed: ${e.message}`); }
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

  /**
   * health(agent, { since }) -> what lib/memory-health shows about one agent's archive, from the (agent, ts) index only
   * (no pass over the text): { agent, entries, first, last, fileBytes, recent } (recent = rows from `since` on;
   * fileBytes = its own file with the write-ahead log, null while every agent is still in the combined file), or null
   * when the archive exists but can't be read.
   */
  function health(agent, { since = null } = {}) {
    const d = open(agent, { create: false });
    if (d === false) return null;
    let fileBytes = null;
    if (!combinedMode()) {
      fileBytes = 0;
      for (const f of [fileFor(agent), `${fileFor(agent)}-wal`]) { try { fileBytes += fs.statSync(f).size; } catch {} }
    }
    if (!d) return { agent, entries: 0, first: null, last: null, fileBytes, recent: 0 };
    try {
      const r = d.prepare('SELECT COUNT(*) n, MIN(ts) first, MAX(ts) last FROM entries WHERE agent = ?').get(String(agent));
      const recent = since && r.n ? d.prepare('SELECT COUNT(*) n FROM entries WHERE agent = ? AND ts >= ?').get(String(agent), new Date(since).toISOString()).n : 0;
      return { agent, entries: r.n, first: r.first, last: r.last, fileBytes, recent };
    } catch (e) { console.error(`[transcript] ${agent}: health failed: ${e.message}`); return null; }
  }

  /**
   * tidyStep(agent, { pages, first }) -> { done } | { combined: true } | null | false: one bounded step of merging the
   * agent's search index (FTS5 'merge'); call again with first: false until done (a step that merged nothing). Each
   * step writes about `pages` pages, so the caller can pause between steps and the hub keeps answering. null: the agent
   * has no archive; false: it couldn't be opened; combined: every agent is still in the combined file of earlier versions.
   */
  function tidyStep(agent, { pages = 200, first = false } = {}) {
    if (combinedMode()) return { combined: true };   // every agent's rows share one file: not one agent's to rework
    const d = open(agent, { create: false });
    if (!d) return d;   // null: no archive; false: it couldn't be opened
    // SQLite's rule for 'merge': a negative page count on the first call only (it also merges segments of different
    // levels), positive after; the index is done when total_changes() moved by less than 2 (the statement's own
    // change count is always 1).
    const total = d.prepare('SELECT total_changes() AS n');
    const before = total.get().n;
    const n = Math.max(16, Math.round(Number(pages) || 200));
    d.prepare("INSERT INTO entries_fts(entries_fts, rank) VALUES('merge', ?)").run(first ? -n : n);
    return { done: total.get().n - before < 2 };
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

  /**
   * moveOut(agent, dest) -> { moved, rows }: a deleted agent's archive leaves for dest (its bundle, lib/agent-archive).
   * Its own file is moved, after its write-ahead log is folded in, so one rename takes everything; a file already at
   * dest is never replaced. In the combined file of earlier versions its rows are copied into dest (ids kept, so a
   * second run adds nothing twice), counted, and only then removed. Throws when the archive can't be read.
   */
  function moveOut(agent, dest) {
    const key = String(agent);
    const Database = require('better-sqlite3');
    const h = handles.get(key);
    if (h) { handles.delete(key); try { h.close(); } catch {} }
    const has = (p) => { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
    // The agent's own file: its write-ahead log folded in first (one rename then takes everything), moved to a free name.
    // A file that can't be opened stays (an admin looks at a damaged archive; the bundle waits unfinished).
    const moveFile = (f, to) => {
      if (!has(f)) return null;
      let rows;
      const d = new Database(f, { fileMustExist: true });
      try {
        rows = d.prepare('SELECT COUNT(*) AS n FROM entries').get().n;
        const cp = d.pragma('wal_checkpoint(TRUNCATE)');
        if (cp && cp[0] && cp[0].busy) throw new Error('its archive is in use by another process');
      } finally { d.close(); }   // the last connection's close removes the log
      if (has(`${f}-wal`)) throw new Error('its archive is in use by another process');
      let target = to;
      for (let i = 2; has(target); i++) target = to.replace(/(\.db)?$/, `-${i}.db`);
      fs.renameSync(f, target);
      try { fs.unlinkSync(`${f}-shm`); } catch {}
      return rows;
    };
    if (combinedMode()) {
      // A split that stopped part-way may have copied this agent's rows into its own file already; that copy goes too,
      // or a later split would hand it to a new agent of the same name.
      const staged = moveFile(fileFor(key), dest.replace(/(\.db)?$/, '-staged.db'));
      const src = openCombined();
      if (!src) throw new Error('the combined archive could not be opened');
      const n = src.prepare('SELECT COUNT(*) AS n FROM entries WHERE agent = ?').get(key).n;
      if (!n) return { moved: staged !== null, rows: 0 };
      const d = new Database(dest);
      try {
        try { fs.chmodSync(dest, 0o600); } catch {}
        d.exec(SCHEMA);
        const ins = d.prepare(`INSERT OR IGNORE INTO entries (${COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
        d.transaction(() => {
          for (const r of src.prepare(`SELECT ${COLUMNS} FROM entries WHERE agent = ? ORDER BY id`).iterate(key)) ins.run(r.id, r.ts, r.day, r.agent, r.owner, r.turn_id, r.origin, r.kind, r.tool, r.text, r.meta, r.hash);
        })();
        const have = d.prepare('SELECT COUNT(*) AS n FROM entries WHERE agent = ?').get(key).n;
        if (have < n) throw new Error(`only ${have} of ${n} rows reached ${path.basename(dest)}`);
      } finally { d.close(); }
      src.prepare('DELETE FROM entries WHERE agent = ?').run(key);
      return { moved: true, rows: n };
    }
    const rows = moveFile(fileFor(key), dest);
    return rows === null ? { moved: false, rows: 0 } : { moved: true, rows };
  }

  // ── The workers an agent called (the rows its turns kept: lib/transcript tap, recordWorker), for the worker history ──
  const metaOf = (m) => { try { const o = m ? JSON.parse(m) : null; return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
  const kindOfWorker = (t) => (t === 'temporal' || !t ? 'temporary' : t === 'sdk-agent' ? 'sub-agent' : 'agent');
  // A cursor is the last worker a page showed: its start time, its caller and its row id. The order is newest first,
  // then caller name, then row id (newest first), so pages of one agent or of many never skip or repeat a worker.
  function parseCursor(c) {
    const m = /^(\d{4}-\d\d-\d\dT[0-9:.]+Z)\|([^|]*)\|(\d+)$/.exec(String(c || ''));
    return m ? { ts: m[1], agent: m[2], id: Number(m[3]) } : null;
  }
  const cursorOf = (w) => `${w.startedAt}|${w.caller}|${w.rowId}`;
  function workerEntry(agent, start, sm, finished, answer) {
    const [head, ...rest] = String(start.text || '').split('\n\n');
    const fm = finished ? finished.m : null;
    const errorLine = finished ? String(finished.e.text || '').split('\n').slice(1).join('\n').trim() : '';
    return {
      caller: String(agent), workerId: String(sm.worker_id), rowId: start.id, description: head || 'Worker', prompt: rest.join('\n\n'),
      agentType: sm.agent_type || null, kind: kindOfWorker(sm.agent_type), model: sm.model || null,
      startedAt: start.ts, endedAt: finished ? finished.e.ts : null, durationMs: fm && Number.isFinite(fm.duration_ms) ? fm.duration_ms : null,
      outcome: fm ? (fm.outcome || null) : null, error: errorLine || null,
      answer: answer ? String(answer.e.text || '') : null, partial: !!(answer && answer.m.partial),
    };
  }
  const passes = (w, filter) => (filter === 'named' ? w.kind === 'agent' : filter === 'temporary' ? w.kind !== 'agent'
    : filter === 'failed' ? (w.outcome === 'failed' || w.outcome === 'unfinished') : true);
  /**
   * workers(agent, { before, q, filter, limit }) -> { workers, next } | null when the archive can't be opened: the
   * workers this agent called, newest first. before: the `next` of an earlier page. filter: all | named | temporary |
   * failed. q: words in a worker's brief or answer. The answer row can come after the finished row; a worker still
   * running (or whose turn never ended) has no outcome.
   */
  function workers(agent, { before = null, q = '', filter = 'all', limit = 50, scanMax = 20000 } = {}) {
    const d = open(agent, { create: false });
    if (d === false) return null;
    if (!d) return { workers: [], next: null };
    const key = String(agent);   // every query names the agent: the combined file of earlier versions holds them all
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const fq = String(q || '').trim() ? ftsQuery(q) : null;
    if (String(q || '').trim() && !fq) return { workers: [], next: null };
    const c = parseCursor(before);
    // the rows after the cursor in the order above, for this agent
    let where = `agent = ? AND tool = 'worker' AND kind = 'system'`; const args = [key];
    if (c) {
      if (key > c.agent) { where += ' AND ts <= ?'; args.push(c.ts); }
      else if (key === c.agent) { where += ' AND (ts < ? OR (ts = ? AND id < ?))'; args.push(c.ts, c.ts, c.id); }
      else { where += ' AND ts < ?'; args.push(c.ts); }
    }
    const starts = d.prepare(`SELECT id, ts, turn_id, substr(text, 1, 4000) AS text, meta FROM entries WHERE ${where} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`);
    // a worker ends within its caller's turn: its end rows are no later than a day after its start
    const ends = d.prepare(`SELECT id, ts, tool, substr(text, 1, 2000) AS text, meta FROM entries WHERE agent = ? AND tool IN ('worker', 'worker_answer') AND ts >= ? AND ts <= ? ORDER BY ts, id LIMIT 200000`);
    // words in a brief or an answer, looked up for each batch's own time window (no cap that hides older workers)
    // (the rowid bound is applied inside the index walk: a worker's rows all come at or after its start row)
    const hits = fq ? d.prepare(`SELECT e.meta AS meta FROM entries_fts JOIN entries e ON e.id = entries_fts.rowid WHERE entries_fts MATCH ? AND entries_fts.rowid >= ? AND e.agent = ? AND e.tool IN ('worker', 'worker_answer') AND e.ts >= ? AND e.ts <= ?`) : null;
    const out = []; let offset = 0, more = true, scanned = 0, lastScanned = null;
    const BATCH = Math.max(1, Math.min(500, scanMax));
    while (out.length < lim && more && scanned < scanMax) {
      const rows = starts.all(...args, BATCH, offset);
      offset += rows.length; scanned += rows.length;
      if (rows.length < BATCH) more = false;
      if (!rows.length) { more = false; break; }
      const batch = rows.map(r => ({ r, m: metaOf(r.meta) })).filter(x => x.m.worker_event === 'started' && x.m.worker_id != null);
      const oldest = rows[rows.length - 1].ts, newest = rows[0].ts;
      const until = new Date(Date.parse(newest) + 24 * 3600 * 1000).toISOString();
      let wanted = null;
      if (hits) {
        wanted = new Set();
        const firstId = rows.reduce((a, r) => Math.min(a, r.id), rows[0].id);
        for (const h of hits.iterate(fq, firstId, key, oldest, until)) { const m = metaOf(h.meta); if (m.worker_id != null) wanted.add(String(m.worker_id)); }
      }
      const found = wanted ? batch.filter(x => wanted.has(String(x.m.worker_id))) : batch;
      const slots = new Map(found.map(x => [String(x.m.worker_id), { finished: null, answer: null }]));
      if (found.length) {
        for (const e of ends.iterate(key, oldest, until)) {
          const m = metaOf(e.meta);
          const slot = m.worker_id != null ? slots.get(String(m.worker_id)) : null;
          if (!slot) continue;
          if (e.tool === 'worker' && m.worker_event === 'finished') slot.finished = { e, m };
          else if (e.tool === 'worker_answer' && !slot.answer) slot.answer = { e, m };
        }
      }
      // in the rows' own order, so a page that stops part-way knows exactly how far it has looked
      const byRow = new Map(found.map(x => [x.r.id, x]));
      for (const r of rows) {
        lastScanned = r;
        const x = byRow.get(r.id);
        if (!x) continue;
        const slot = slots.get(String(x.m.worker_id));
        const w = workerEntry(key, x.r, x.m, slot.finished, slot.answer);
        if (!passes(w, filter)) continue;
        out.push(w);
        if (out.length >= lim) break;
      }
    }
    for (const w of out) { if (w.answer && w.answer.length > 600) w.answer = w.answer.slice(0, 600); }
    // next: after the last worker shown when the page is full; after the last row looked at when the scan stopped
    // early (a page can then be short, even empty, and still have more behind it); none when nothing is left
    let next = null;
    if (out.length >= lim) next = cursorOf(out[out.length - 1]);
    else if (more && lastScanned) next = `${lastScanned.ts}|${key}|${lastScanned.id}`;
    return { workers: out, next };
  }
  /** workerRun(agent, workerId) -> { worker, rows } | null: one worker as it ran (its brief, each step, its answer, its end). */
  function workerRun(agent, workerId) {
    const d = open(agent, { create: false });
    if (!d) return null;
    const key = String(agent);
    const wid = String(workerId);
    let start = null;
    for (const r of d.prepare(`SELECT id, ts, turn_id, text, meta FROM entries WHERE agent = ? AND tool = 'worker' AND kind = 'system' AND meta LIKE '%worker_id%' ORDER BY ts DESC, id DESC`).iterate(key)) {
      const m = metaOf(r.meta);
      if (m.worker_event === 'started' && String(m.worker_id) === wid) { start = { r, m }; break; }
    }
    if (!start) return null;
    // every row of that worker is in the turn that started it, from its start, within a day of it
    const until = new Date(Date.parse(start.r.ts) + 24 * 3600 * 1000).toISOString();
    const rows = []; let finished = null, answer = null;
    for (const r of d.prepare(`SELECT id, ts, kind, tool, text, meta FROM entries WHERE agent = ? AND id >= ? AND ts <= ? AND turn_id IS ? AND meta LIKE '%worker_id%' ORDER BY id`).iterate(key, start.r.id, until, start.r.turn_id)) {
      const m = metaOf(r.meta);
      if (String(m.worker_id) !== wid) continue;
      if (r.tool === 'worker' && m.worker_event === 'finished') finished = { e: r, m };
      if (r.tool === 'worker_answer' && !answer) answer = { e: r, m };
      rows.push({ id: r.id, ts: r.ts, kind: r.kind, tool: r.tool, text: r.text, event: m.worker_event || null, toolCallId: m.tool_call_id || null, outcome: m.outcome || null, partial: !!m.partial });
    }
    return { worker: workerEntry(key, start.r, start.m, finished, answer), rows };
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

  return { record, tap, search, searchTimes, context, stats, health, tidyStep, importConversation, importClaudeSession, close, migrate, moveOut, workers, workerRun, file, dir, fileFor, ftsQuery, clipText };
}

/**
 * mergeWorkerPages(lists, limit) -> { workers, next }: several agents' worker pages (workers()) as one, newest first.
 * An agent with more to give has looked as far as its own `next` (its last worker, or the last row it scanned): the
 * page stops at the nearest of those, so nothing an agent has not looked at yet is passed over, and nothing shown
 * comes again on the next page.
 */
function mergeWorkerPages(lists, limit = 50) {
  const order = (a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : a.caller < b.caller ? -1 : a.caller > b.caller ? 1 : b.rowId - a.rowId);
  const asPoint = (c) => { const m = /^(.+)\|([^|]*)\|(\d+)$/.exec(String(c)); return m ? { startedAt: m[1], caller: m[2], rowId: Number(m[3]) } : null; };
  const all = (lists || []).filter(Boolean);
  const frontier = all.map(l => l.next && asPoint(l.next)).filter(Boolean).sort(order)[0] || null;
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const page = all.flatMap(l => l.workers || []).sort(order).filter(w => !frontier || order(w, frontier) <= 0).slice(0, lim);
  const last = page[page.length - 1];
  const point = (p) => `${p.startedAt}|${p.caller}|${p.rowId}`;
  return { workers: page, next: page.length === lim ? point(last) : frontier ? point(frontier) : null };
}

let shared = null;
function getTranscript(opts) { if (!shared) shared = createTranscript(opts); return shared; }

module.exports = { createTranscript, getTranscript, splitCombined, mergeWorkerPages, safeName, ftsQuery, clipText, KINDS, DB_FILE, DB_DIR };
