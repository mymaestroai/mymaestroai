'use strict';
/**
 * chat-history.js — paged, filtered chat history for GET /api/history/<agent>?view=&limit=&before=
 *
 * The chat log file keeps only the last ~200-300 lines; the transcript archive keeps every turn. A page is built from
 * the chat log first (newest end), then, once the log is used up, from the archive's user/assistant text rows.
 * view 'all' shows everything; view 'main' leaves out the turns the hub started itself (consultations, scheduled
 * tasks, job notices ...) unless the agent marked the reply for the owner (for_owner).
 *
 * Cursors (opaque to the pages): `log:<i>` = the page ends before chat-log index i; `arc:<id>` = it ends before
 * archive row id; `arc:top` = the first archive page (rows older than the chat log's oldest entry).
 */
const { autoInfoOf } = require('./ui-auto-turns');

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;
const SCAN_MAX = 20000;      // archive rows looked at per request
const BATCH = 500;           // archive rows per read
const SEAM_ENTRIES = 30;     // the oldest chat-log entries an archive row is compared with (the same message kept twice)

/** The cursor as { kind: 'log', i } | { kind: 'arc', id } | { kind: 'arc', id: null } (arc:top), or null when it is not one. */
function parseCursor(c) {
  const s = String(c == null ? '' : c);
  let m = /^log:(\d{1,9})$/.exec(s);
  if (m) return { kind: 'log', i: Number(m[1]) };
  if (s === 'arc:top') return { kind: 'arc', id: null };
  m = /^arc:(\d{1,15})$/.exec(s);
  if (m) return { kind: 'arc', id: Number(m[1]) };
  return null;
}

/**
 * filterMainView(entries) -> boolean[] (true = shown in the main view), oldest-first entries.
 * A user entry with autoInfoOf != null starts a hub-started turn. The assistant entries after it belong to it (and
 * so do further hub user entries before its first assistant entry: autoGroupHistory groups them the same way) until
 * the next entry that is the person's own, a question/answer (ask) entry, or the next hub user entry after an
 * assistant entry. A turn with an assistant entry marked for_owner is shown whole; otherwise it is left out.
 */
function filterMainView(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const keep = list.map(() => true);
  let turn = null;   // { idx: [...], sawAsst, forOwner }
  const close = () => { if (turn && !turn.forOwner) for (const i of turn.idx) keep[i] = false; turn = null; };
  list.forEach((e, i) => {
    if (!e || e.ask === true) { close(); return; }                   // questions and their answers always stay
    if (e.role === 'user') {
      if (autoInfoOf(e) === null) { close(); return; }               // the person's own message ends any hidden turn
      if (!turn || turn.sawAsst) { close(); turn = { idx: [], sawAsst: false, forOwner: false }; }
      turn.idx.push(i);
    } else if (e.role === 'assistant' && turn) {
      turn.idx.push(i);
      turn.sawAsst = true;
      if (e.for_owner === true) turn.forOwner = true;
    }
  });
  close();
  return keep;
}

/** An archive row as a chat-log-shaped entry. */
function entryOfRow(r) {
  const o = r.origin;
  const e = { ts: r.ts, role: r.kind, content: r.text, origin: o && o !== 'user' && o !== 'interjection' ? { kind: o } : undefined, archived: true };
  if (e.origin === undefined) delete e.origin;
  return e;
}

/**
 * historyPage({ logEntries, archive, view, before, limit, inProgressMark }) -> { history, next }
 *   logEntries      the whole chat log, oldest first
 *   archive         { rowsBefore({ beforeId, beforeTs, limit }) -> rows newest first, forOwnerTurns(turnIds) -> Set }
 *   view            'main' (default) | 'all'
 *   before          a cursor from an earlier page, or null for the newest page
 *   limit           entries wanted in the view, 1..200 (default 40)
 *   inProgressMark  optional fn(logEntries): flags the running turn's entry (hub-events markInProgress)
 * A page can hold fewer than `limit` entries while `next` is set (the archive scan is bounded); `next` is null only
 * when nothing older exists. Throws Error('bad_cursor') for a cursor that is not ours.
 */
function historyPage({ logEntries, archive, view = 'main', before = null, limit = DEFAULT_LIMIT, inProgressMark = null } = {}) {
  const log = Array.isArray(logEntries) ? logEntries : [];
  if (typeof inProgressMark === 'function') { try { inProgressMark(log); } catch {} }
  const lim = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(limit)) || DEFAULT_LIMIT));
  const main = view !== 'all';
  const cur = before === null || before === undefined || before === '' ? { kind: 'log', i: log.length } : parseCursor(before);
  if (!cur) throw new Error('bad_cursor');

  const fromLog = [];
  if (cur.kind === 'log') {
    const end = Math.min(cur.i, log.length);
    const keep = main ? filterMainView(log) : null;
    let k = end;   // the chat-log index the next page ends before
    for (let i = end - 1; i >= 0 && fromLog.length < lim; i--) {
      k = i;
      if (!keep || keep[i]) fromLog.unshift(log[i]);
    }
    if (fromLog.length >= lim && k > 0) return { history: fromLog, next: `log:${k}` };
  }

  // The chat log is used up (or the cursor is already in the archive): continue with the archive's rows.
  const arc = lim - fromLog.length > 0
    ? archivePage({ log, archive, main, beforeId: cur.kind === 'arc' ? cur.id : null, limit: lim - fromLog.length })
    : { entries: [], next: probe(archive, log, null) ? 'arc:top' : null };
  return { history: [...arc.entries, ...fromLog], next: arc.next };
}

const oldestTs = (log) => (log.length && log[0] && log[0].ts) || null;
/** True when the archive has a row older than the chat log's oldest entry (beforeId null) or older than beforeId. */
function probe(archive, log, beforeId) {
  try { return archive.rowsBefore({ beforeId, beforeTs: beforeId == null ? oldestTs(log) : null, limit: 1 }).length > 0; } catch { return false; }
}

/** One page from the archive: { entries (oldest first), next }. Reads at most SCAN_MAX rows. */
function archivePage({ log, archive, main, beforeId, limit }) {
  const seam = new Set(log.slice(0, SEAM_ENTRIES).filter(e => e && typeof e.content === 'string').map(e => `${e.role}\n${e.content.trim()}`));
  const got = [];            // { entry, id }, oldest first
  let cursorId = beforeId;   // the next request ends before this archive row id (null = still at the chat log's edge)
  let scanned = 0, exhausted = false;
  const read = (bId, n) => {   // rows newest first; the first read is bounded by the chat log's oldest ts, later ones by id
    let rows = [];
    try { rows = archive.rowsBefore({ beforeId: bId, beforeTs: bId == null ? oldestTs(log) : null, limit: n }) || []; } catch { rows = []; }
    scanned += rows.length;
    if (rows.length < n) exhausted = true;
    return rows;
  };

  while (got.length < limit && scanned < SCAN_MAX && !exhausted) {
    const rows = read(cursorId, BATCH);
    if (!rows.length) break;
    let batch = rows.reverse();   // oldest first
    // a turn is never judged without its start: extend backward until the batch starts at a user row (or the scan bound)
    while (main && !exhausted && batch[0].kind !== 'user' && scanned < SCAN_MAX) {
      const more = read(batch[0].id, BATCH);
      if (!more.length) break;
      batch = more.reverse().concat(batch);
    }
    const owned = ownerTurns(archive, batch);
    const entries = batch.map(r => {
      const e = entryOfRow(r);
      if (r.kind === 'assistant' && r.turn_id && owned.has(r.turn_id)) e.for_owner = true;
      return e;
    });
    const flags = main ? filterMainView(entries) : null;
    const kept = [];
    batch.forEach((r, i) => {
      // a turn marked for the owner stays whole even when a page cut separates its two halves
      if (flags && !flags[i] && !(r.turn_id && owned.has(r.turn_id))) return;
      if (seam.has(`${r.kind}\n${String(r.text).trim()}`)) return;   // the same message is still in the chat log
      kept.push({ entry: entries[i], id: r.id });
    });
    const need = limit - got.length;
    if (kept.length > need) {
      const taken = kept.slice(kept.length - need);
      got.unshift(...taken);
      cursorId = taken[0].id;
      break;
    }
    got.unshift(...kept);
    cursorId = batch[0].id;
  }
  // next is null only when nothing older exists
  const next = probe(archive, log, cursorId) ? (cursorId == null ? 'arc:top' : `arc:${cursorId}`) : null;
  return { entries: got.map(g => g.entry), next };
}

function ownerTurns(archive, rows) {
  const ids = [...new Set(rows.filter(r => r.turn_id).map(r => r.turn_id))];
  if (!ids.length || typeof archive.forOwnerTurns !== 'function') return new Set();
  try { return new Set(archive.forOwnerTurns(ids)); } catch { return new Set(); }
}

module.exports = { filterMainView, historyPage, parseCursor, entryOfRow };
