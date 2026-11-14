'use strict';
/**
 * chat-history.js — paged, filtered chat history for GET /api/history/<agent>?view=&limit=&before=
 *
 * The chat log file keeps only the last ~200-300 lines; the transcript archive keeps every turn. A page is built from
 * the chat log first (newest end), then, once the log is used up, from the archive's user/assistant text rows.
 * view 'all' shows everything; view 'main' leaves out the turns the hub started itself (consultations, scheduled
 * tasks, job notices ...) unless the agent marked the reply for the owner (for_owner).
 *
 * Cursors (opaque to the pages): `log:<ts>` = the page ends before the chat-log entries at or after that time (a time,
 * not a position: the log is trimmed from its old end while a person pages); `arc:<id>` = it ends before archive row
 * id; `arc:top` = the first archive page (rows older than the chat log's oldest entry). Archive rows from before the
 * chat was last cleared (a `chat_cleared` mark) are never shown: Clear starts the chat again.
 */
const { autoInfoOf } = require('./ui-auto-turns');

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;
const SCAN_MAX = 4000;       // archive rows looked at per request (the pages ask again for an empty page with a next)
const BATCH = 500;           // archive rows per read
// No dedupe at the seam: the two stores share no message id, and words plus time cannot tell one message saved twice from
// two messages with the same words (review r3). Archive rows are only those older than the log's oldest entry, so a
// message shows twice only when its archive row was saved before its chat-log line (rare); dropping one could hide a real one.

/**
 * The cursor as { kind: 'log', ts, rank } | { kind: 'arc', id } | { kind: 'arc', id: null } (arc:top), or null.
 * `log:<ts>` or `log:<ts>~<rank>`: the page ends before the entry that is the rank-th (0-based) of the entries saved
 * at exactly that time, so entries sharing a millisecond are neither skipped nor repeated at a page cut.
 */
function parseCursor(c) {
  const s = String(c == null ? '' : c);
  let m = /^log:(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)(?:~(\d{1,6}))?$/.exec(s);
  if (m && Number.isFinite(Date.parse(m[1]))) return { kind: 'log', ts: m[1], rank: m[2] ? Number(m[2]) : 0 };
  if (s === 'arc:top') return { kind: 'arc', id: null };
  m = /^arc:(\d{1,15})$/.exec(s);
  if (m) return { kind: 'arc', id: Number(m[1]) };
  return null;
}

/**
 * filterMainView(entries, { leadHidden }) -> boolean[] (true = shown in the main view), oldest-first entries.
 * A user entry with autoInfoOf != null starts a hub-started turn. The assistant entries after it belong to it (and
 * so do further hub user entries before its first assistant entry: autoGroupHistory groups them the same way) until
 * the next entry that is the person's own, a question/answer (ask) entry, or the next hub user entry after an
 * assistant entry. A turn with an assistant entry marked for_owner is shown whole; otherwise it is left out.
 * leadHidden: the list starts in the middle of a hidden hub turn (its prompt lies before the list: the chat log was
 * trimmed between them), so assistant entries before the first user entry belong to that hidden turn.
 */
function filterMainView(entries, { leadHidden = false } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const keep = list.map(() => true);
  let turn = leadHidden ? { idx: [], sawAsst: true, forOwner: false } : null;   // { idx: [...], sawAsst, forOwner }
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

const ms = (ts) => { const t = Date.parse(ts); return Number.isFinite(t) ? t : NaN; };
const minTs = (a, b) => (!a ? b : !b ? a : (ms(a) <= ms(b) ? a : b));

/**
 * historyPage({ logEntries, archive, view, before, limit, inProgressMark }) -> { history, next }
 *   logEntries      the whole chat log, oldest first
 *   archive         { rowsBefore({ beforeId, beforeTs, afterTs, kinds, limit }) -> rows newest first,
 *                     forOwnerTurns(turnIds) -> Set, lastMarkTs(tool) -> ts | null }
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
  const cur = before === null || before === undefined || before === '' ? { kind: 'log', ts: null } : parseCursor(before);
  if (!cur) throw new Error('bad_cursor');
  const arc = archiveOf(archive);

  const fromLog = [];
  let edgeTs = log.length ? log[0].ts : null;   // the archive continues with rows older than this
  if (cur.kind === 'log') {
    // the entries older than the cursor's time (all of them for the newest page)
    let end = log.length;
    if (cur.ts) {
      end = 0;
      while (end < log.length && !(ms(log[end] && log[end].ts) >= ms(cur.ts))) end++;
      // entries saved in the same millisecond as the cursor: the first `rank` of them belong to this (older) page
      let r = 0;
      while (r < cur.rank && end < log.length && log[end] && log[end].ts === cur.ts) { end++; r++; }
    }
    const keep = main ? filterMainView(log, { leadHidden: leadIsHidden(arc, log) }) : null;
    let k = end;   // the chat-log index the next page ends before
    for (let i = end - 1; i >= 0 && fromLog.length < lim; i--) {
      k = i;
      if (!keep || keep[i]) fromLog.unshift(log[i]);
    }
    if (fromLog.length >= lim && k > 0 && log[k] && log[k].ts) {
      let rank = 0;
      while (k - rank - 1 >= 0 && log[k - rank - 1] && log[k - rank - 1].ts === log[k].ts) rank++;
      return { history: fromLog, next: rank ? `log:${log[k].ts}~${rank}` : `log:${log[k].ts}` };
    }
    // a cursor older than the log's oldest entry (the log was trimmed since): the archive goes on from the cursor
    if (cur.ts && end === 0) edgeTs = minTs(edgeTs, cur.ts);
  }

  // The chat log is used up (or the cursor is already in the archive): continue with the archive's rows.
  const page = lim - fromLog.length > 0
    ? archivePage({ log, arc, main, beforeId: cur.kind === 'arc' ? cur.id : null, edgeTs, limit: lim - fromLog.length })
    : { entries: [], next: arc.has(null, edgeTs) ? 'arc:top' : null };
  return { history: [...page.entries, ...fromLog], next: page.next };
}

/**
 * The archive with the chat's last clear applied (rows from before it never show). A read that fails gives no rows;
 * if the clear mark itself cannot be read, the archive is not read at all (a cleared chat must never come back).
 */
function archiveOf(archive) {
  const a = archive || {};
  let cleared = null, blocked = false;
  try { cleared = typeof a.lastMarkTs === 'function' ? a.lastMarkTs('chat_cleared') : null; } catch { blocked = true; }
  const rows = (o) => { if (blocked) return []; try { return (typeof a.rowsBefore === 'function' && a.rowsBefore({ ...o, afterTs: cleared })) || []; } catch { return []; } };
  return {
    rows,
    has: (beforeId, edgeTs) => rows({ beforeId, beforeTs: beforeId == null ? edgeTs : null, limit: 1 }).length > 0,
    owned: (ids) => { if (!ids.length || typeof a.forOwnerTurns !== 'function') return new Set(); try { return new Set(a.forOwnerTurns(ids)); } catch { return new Set(); } },
  };
}

/** True when the chat log starts with replies whose prompt (trimmed away) started an unmarked hub turn. */
function leadIsHidden(arc, log) {
  if (!log.length || !(log[0] && log[0].role === 'assistant')) return false;
  const prompt = arc.rows({ beforeTs: log[0].ts, kinds: ['user'], limit: 1 })[0];
  if (!prompt || autoInfoOf(entryOfRow(prompt)) === null) return false;
  return !(prompt.turn_id && arc.owned([prompt.turn_id]).has(prompt.turn_id));
}

/** One page from the archive: { entries (oldest first), next }. Reads at most SCAN_MAX rows. */
function archivePage({ log, arc, main, beforeId, edgeTs, limit }) {
  const got = [];            // { entry, id }, oldest first
  let cursorId = beforeId;   // the next request ends before this archive row id (null = still at the chat log's edge)
  let scanned = 0, exhausted = false;
  const read = (bId, n) => {   // rows newest first; the first read is bounded by the edge time, later ones by id
    const rows = arc.rows({ beforeId: bId, beforeTs: bId == null ? edgeTs : null, limit: n });
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
    const owned = arc.owned([...new Set(batch.filter(r => r.turn_id).map(r => r.turn_id))]);
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
  const next = arc.has(cursorId, edgeTs) ? (cursorId == null ? 'arc:top' : `arc:${cursorId}`) : null;
  return { entries: got.map(g => g.entry), next };
}

module.exports = { filterMainView, historyPage, parseCursor, entryOfRow };
