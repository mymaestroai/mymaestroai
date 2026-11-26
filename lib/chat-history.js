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
      // Build Team: the person pressed it, so the turn is theirs to see; it starts its own turn, so an earlier hidden prompt
      // still waiting for a reply stays hidden.
      // and the next prompt after it starts another (a Build Team turn that stopped before replying lends nothing).
      const bt = !!(e.origin && (e.origin.kind === 'build_team' || e.origin.kind === 'team_setup' || e.origin.kind === 'optimize_team'));   // the person pressed it (Optimize team and Set up teams too)
      if (!turn || turn.sawAsst || turn.buildTeam || bt) { close(); turn = { idx: [], sawAsst: false, forOwner: bt, buildTeam: bt }; }
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
  if (r.turn_id && e.origin) e.turn_id = r.turn_id;   // only a hub-started user row names a run (an owner row or a reply needs no id)
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

  const fromLog = [];   // { entry, hidden? }, oldest first; hidden ones become summary lines (main view)
  let keptN = 0;
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
    // a run's `rank`: how many hub-started prompts saved at exactly its time come earlier in the WHOLE chat log (not only on this page)
    const ranks = [];
    if (keep) {
      const seen = new Map();
      log.forEach((e, i) => {
        ranks[i] = seen.get(e && e.ts) || 0;
        if (!keep[i] && e && e.role === 'user' && autoInfoOf(e) !== null) seen.set(e.ts, (seen.get(e.ts) || 0) + 1);
      });
    }
    let k = end;   // the chat-log index the next page ends before
    for (let i = end - 1; i >= 0 && keptN < lim; i--) {
      k = i;
      if (!keep || keep[i]) { fromLog.unshift({ entry: log[i] }); keptN++; }
      else fromLog.unshift({ entry: log[i], hidden: true, rank: ranks[i] });   // a hub-started entry: it only shows as part of a summary line
    }
    if (keptN >= lim && k > 0 && log[k] && log[k].ts) {
      let rank = 0;
      while (k - rank - 1 >= 0 && log[k - rank - 1] && log[k - rank - 1].ts === log[k].ts) rank++;
      return { history: withRuns(fromLog), next: rank ? `log:${log[k].ts}~${rank}` : `log:${log[k].ts}` };
    }
    // a cursor older than the log's oldest entry (the log was trimmed since): the archive goes on from the cursor
    if (cur.ts && end === 0) edgeTs = minTs(edgeTs, cur.ts);
  }

  // The chat log is used up (or the cursor is already in the archive): continue with the archive's rows.
  const page = lim - keptN > 0
    ? archivePage({ log, arc, main, beforeId: cur.kind === 'arc' ? cur.id : null, edgeTs, limit: lim - keptN })
    : { entries: [], next: arc.has(null, edgeTs) ? 'arc:top' : null };
  return { history: withRuns([...page.entries, ...fromLog]), next: page.next };
}

/**
 * The archive with the chat's last clear applied (rows from before it never show). A read that fails gives no rows;
 * if the clear mark itself cannot be read, the archive is not read at all (a cleared chat must never come back).
 */
function archiveOf(archive) {
  const a = archive || {};
  let cleared = null, blocked = false;
  try { cleared = typeof a.lastMarkTs === 'function' ? a.lastMarkTs('chat_cleared') : null; } catch { blocked = true; }
  const rows = (o) => { if (blocked) return []; try { return (typeof a.rowsBefore === 'function' && a.rowsBefore({ ...o, afterTs: o.afterTs && cleared ? (ms(o.afterTs) >= ms(cleared) ? o.afterTs : cleared) : (o.afterTs || cleared) })) || []; } catch { return []; } };
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
  if (!prompt || autoInfoOf(entryOfRow(prompt)) === null || prompt.origin === 'build_team' || prompt.origin === 'team_setup' || prompt.origin === 'optimize_team') return false;
  return !(prompt.turn_id && arc.owned([prompt.turn_id]).has(prompt.turn_id));
}

/** One page from the archive: { entries (oldest first), next }. Reads at most SCAN_MAX rows. */
function archivePage({ log, arc, main, beforeId, edgeTs, limit }) {
  const got = [];            // { entry, id, hidden }, oldest first
  let gotKept = 0;           // how many of them are shown (the limit counts those)
  let cursorId = beforeId;   // the next request ends before this archive row id (null = still at the chat log's edge)
  let scanned = 0, exhausted = false;
  const read = (bId, n) => {   // rows newest first; the first read is bounded by the edge time, later ones by id
    const rows = arc.rows({ beforeId: bId, beforeTs: bId == null ? edgeTs : null, limit: n });
    scanned += rows.length;
    if (rows.length < n) exhausted = true;
    return rows;
  };

  while (gotKept < limit && scanned < SCAN_MAX && !exhausted) {
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
    const kept = [];   // every row of the batch; hidden ones are marked (they only show as a summary line)
    // A run's rank counts the hidden prompts at the same time earlier in the BATCH. An equal-millisecond pair split across two
    // archive batches is out of scope (rows are saved a turn apart; the log, where pairs happen, counts the whole log).
    const seenAt = new Map();
    batch.forEach((r, i) => {
      // a turn marked for the owner stays whole even when a page cut separates its two halves
      const hidden = !!(flags && !flags[i] && !(r.turn_id && owned.has(r.turn_id)));
      kept.push({ entry: entries[i], id: r.id, hidden, rank: seenAt.get(r.ts) || 0 });
      if (hidden && r.kind === 'user' && autoInfoOf(entries[i]) !== null) seenAt.set(r.ts, (seenAt.get(r.ts) || 0) + 1);
    });
    const need = limit - gotKept;
    const shown = kept.filter(g => !g.hidden).length;
    if (shown > need) {
      // take the newest `need` shown rows (and the hidden ones between and after them), not the hidden ones older than the first
      let seen = 0, from = kept.length;
      while (from > 0 && seen < need) { from--; if (!kept[from].hidden) seen++; }
      const taken = kept.slice(from);
      got.unshift(...taken);
      cursorId = taken[0].id;
      break;
    }
    got.unshift(...kept);
    gotKept += shown;
    cursorId = batch[0].id;
  }
  // next is null only when nothing older exists
  const next = arc.has(cursorId, edgeTs) ? (cursorId == null ? 'arc:top' : `arc:${cursorId}`) : null;
  return { entries: got.map(g => ({ entry: g.entry, hidden: g.hidden, rank: g.rank })), next };
}

// ── summary lines for the hub-started turns the main view leaves out ──
/** The summary kind of a hidden user entry: consultation | hand_off | schedule | job_notice | other, and the agent it came from. */
function runKindOf(entry) {
  const info = autoInfoOf(entry);
  if (!info) return null;
  const ok = entry.origin && typeof entry.origin === 'object' ? entry.origin.kind : '';
  const text = typeof entry.content === 'string' ? entry.content.trimStart() : '';
  let kind = 'other';
  if (info.kind === 'consultation') kind = 'consultation';
  else if (info.kind === 'schedule') kind = 'schedule';
  else if (ok === 'hand_off' || ok === 'hand_off_report') kind = 'hand_off';
  else if (ok === 'job_notice' || ok === 'job_report' || (!ok && (text.startsWith('[Job finished]') || text.startsWith('[Job ended]')))) kind = 'job_notice';
  // an archive row keeps only the kind of its origin: the name then comes from the prompt's own marker text
  const named = info.from || (autoInfoOf({ ...entry, origin: undefined }) || {}).from;
  const from = (kind === 'consultation' || kind === 'hand_off') && named ? String(named) : null;
  return { kind, from };
}

/**
 * items: [{ entry, hidden? }] oldest first -> entries, every run of consecutive hidden items replaced by ONE
 * { role: 'hidden_run', ts, last_ts, turns, kinds: [{ kind, from, n }], content: '' } (a run with no hub-started
 * prompt in it, only the left-over replies of one, gets no line).
 */
function withRuns(items) {
  const out = [];
  let run = null;
  const seenAt = new Map();   // ts -> hidden prompts at exactly that time so far (a run's `rank`)
  const flush = () => { if (run && run.turns > 0) out.push(run); run = null; };
  for (const it of items) {
    if (!it.hidden) { flush(); out.push(it.entry); continue; }
    const e = it.entry || {};
    if (!run) run = { role: 'hidden_run', ts: e.ts, last_ts: e.ts, turns: 0, kinds: [], rank: Number.isInteger(it.rank) ? it.rank : (seenAt.get(e.ts) || 0), content: '' };
    run.last_ts = e.ts;
    const k = e.role === 'user' ? runKindOf(e) : null;
    if (k) {
      if (run.turns === 0 && typeof e.turn_id === 'string' && TURN_RE.test(e.turn_id)) run.turn = e.turn_id;   // the run is named by its first prompt's turn id (absent for an old entry)
      seenAt.set(e.ts, (seenAt.get(e.ts) || 0) + 1);
      run.turns++;
      const g = run.kinds.find(x => x.kind === k.kind && x.from === k.from);
      if (g) g.n++; else run.kinds.push({ kind: k.kind, from: k.from, n: 1 });
    }
  }
  flush();
  return out;
}

const RUN_CAP = 200;
const TURN_RE = /^[A-Za-z0-9_-]{1,100}$/;
/**
 * runPage({ logEntries, archive, from, to, rank, turn, inProgressMark }) -> { history, more, partial?, incomplete? }
 * ONE run: the contiguous block of hub-started entries that starts at the run's first hub-started prompt and goes on until
 * the first entry the main view shows (the visible separator) or a hub-started prompt later than `to`. The first prompt
 * is the one with turn id `turn` when given (rank ignored), else the first hub-started prompt saved at or after `from`,
 * skipping `rank` prompts saved at exactly `from`. Entries are as the all view returns them (chat log, and for times older
 * than the log the archive with Clear applied), oldest first, whole turns only, at most RUN_CAP entries.
 * The archive is read backward from `to` until any row read is a user row older than `from`, then forward after `to` in
 * order until the next user row, the first reply the main view shows, the log or RUN_CAP rows. A read that gives up at
 * SCAN_MAX before it is complete answers { history: [], more: false, incomplete: true }.
 * Throws Error('bad_range') when from/to are not times (or from is after to), Error('bad_turn') for a turn id that is not
 * letters, digits, - and _ (at most 100).
 */
function runPage({ logEntries, archive, from, to, rank = 0, turn = null, inProgressMark = null } = {}) {
  const f = ms(from);
  let t = ms(to);
  if (typeof from !== 'string' || typeof to !== 'string' || !Number.isFinite(f) || !Number.isFinite(t)) throw new Error('bad_range');
  const byTurn = turn !== null && turn !== undefined;
  if (byTurn && !(typeof turn === 'string' && TURN_RE.test(turn))) throw new Error('bad_turn');
  // A live line sends the hub's times, but a range that still runs backward is no error when the run is named by its turn:
  // the turn's own prompt time stands for `to` (it only bounds the archive read then).
  if (f > t) { if (!byTurn) throw new Error('bad_range'); t = f; }
  const skip = Math.max(0, Math.min(1000000, Math.floor(Number(rank)) || 0));
  const log = Array.isArray(logEntries) ? logEntries : [];
  if (typeof inProgressMark === 'function') { try { inProgressMark(log); } catch {} }
  const arc = archiveOf(archive);
  const edgeTs = log.length ? log[0].ts : null;
  let list = log;
  let leadHidden = leadIsHidden(arc, log);
  let protectedIdx = null;   // archive rows of a for_owner turn: never hidden
  if (!log.length || f < ms(edgeTs)) {
    const upper = new Date(t + 1).toISOString();   // rows older than this are at or before `to`
    const after = new Date(t).toISOString();       // rows newer than this come after `to`
    const joined = !log.length ? false : ms(edgeTs) <= t + 1;   // the log edge is within reach of `to`: the archive and the log join
    const bound = joined ? edgeTs : upper;
    // the archive part: newest first from the run, until ANY row read is a user row older than `from` (the boundary before the run's first prompt)
    let rows = [], scanned = 0, exhausted = false, cursor = null, reached = false;
    const read = () => { const r = arc.rows({ beforeId: cursor, beforeTs: cursor == null ? bound : null, limit: BATCH }); scanned += r.length; if (r.length < BATCH) exhausted = true; if (r.length) cursor = r[r.length - 1].id; return r; };
    while (!exhausted && scanned < SCAN_MAX) {
      const r = read();
      rows = rows.concat(r);
      if (byTurn) {   // the turn's own user row and a user row older than it: the boundary before the run's first prompt
        const at = rows.findIndex(x => x.kind === 'user' && x.turn_id === turn);
        if (at >= 0 && rows.slice(at + 1).some(x => x.kind === 'user')) { reached = true; break; }
      }
      if (r.some(x => x.kind === 'user' && ms(x.ts) < f)) { reached = true; break; }
    }
    if (!reached && !exhausted) return { history: [], more: false, incomplete: true };
    rows.reverse();
    // after `to`: a plain chronological walk (oldest first) until the next user row, the first reply the main view shows,
    // the log, or RUN_CAP rows; SCAN_MAX rows without any of those is incomplete
    let forward = [], joinLog = joined || !log.length;
    if (!joined) {
      const fr = [];
      let lastId = null, seen = 0, stop = false, toEdge = false;
      while (!stop && !toEdge) {
        const r = arc.rows({ afterId: lastId, afterTs: after, beforeTs: edgeTs, oldestFirst: true, limit: BATCH });
        seen += r.length;
        const owned = arc.owned([...new Set(r.filter(x => x.turn_id).map(x => x.turn_id))]);
        for (const x of r) {
          fr.push(x);
          // by turn id the run goes on through later hub-started prompts (only a person's own prompt, a reply for the owner or the cap ends it)
          const ends = x.kind === 'user' && !(byTurn && autoInfoOf(entryOfRow(x)) !== null);
          if (ends || (x.turn_id && owned.has(x.turn_id)) || fr.length >= RUN_CAP) { stop = true; break; }
        }
        if (stop) break;
        if (r.length) lastId = r[r.length - 1].id;
        if (r.length < BATCH) toEdge = true;
        else if (seen >= SCAN_MAX) return { history: [], more: false, incomplete: true };
      }
      forward = fr;
      joinLog = toEdge;   // the walk reached the log: no gap before it
    }
    const all = rows.concat(forward);
    const owned = arc.owned([...new Set(all.filter(r => r.turn_id).map(r => r.turn_id))]);
    const arcEntries = all.map(r => { const e = entryOfRow(r); if (r.kind === 'assistant' && r.turn_id && owned.has(r.turn_id)) e.for_owner = true; return e; });
    list = joinLog ? [...arcEntries, ...log] : arcEntries;
    leadHidden = arcEntries.length ? false : leadHidden;
    protectedIdx = new Set(); all.forEach((r, i) => { if (r.turn_id && owned.has(r.turn_id)) protectedIdx.add(i); });
  }
  const keep = filterMainView(list, { leadHidden });
  const isHidden = (i) => !keep[i] && !(protectedIdx && protectedIdx.has(i));
  const isPrompt = (e) => !!e && e.role === 'user' && autoInfoOf(e) !== null;
  // the run's first prompt: the hub-started prompt with turn id `turn`, else the first one at or after `from`, after `rank` of those saved at exactly `from`
  let start = -1, skipped = 0;
  for (let i = 0; i < list.length; i++) {
    if (!isHidden(i) || !isPrompt(list[i])) continue;
    if (byTurn) { if (list[i].turn_id === turn) { start = i; break; } continue; }
    if (ms(list[i].ts) < f) continue;
    if (ms(list[i].ts) === f && skipped < skip) { skipped++; continue; }
    start = i; break;
  }
  const out = [];
  let more = false, partial = false;
  if (start >= 0) {
    for (let i = start; i < list.length; i++) {
      const e = list[i];
      if (!isHidden(i)) break;                                  // the visible separator
      if (!byTurn && isPrompt(e) && ms(e.ts) > t) break;        // the next run's prompt (a run named by its turn id ends only at a shown entry)
      if (out.length >= RUN_CAP) {
        more = true;
        if (!isPrompt(e)) {                                      // whole turns only: a turn whose replies are cut off is left out
          let last = out.length - 1;
          while (last > 0 && !isPrompt(out[last])) last--;
          if (last > 0) out.length = last;
          else partial = true;                                   // the first turn alone is over the cap: it comes back cut
        }
        break;
      }
      out.push(e);
    }
  }
  // an archive row keeps only the kind of its origin: a prompt without a sender gets the one its own marker text names (a copy; the log entry is not touched)
  const named = out.map((e) => {
    if (!isPrompt(e) || !e.origin || typeof e.origin !== 'object' || e.origin.from) return e;
    const k = runKindOf(e);
    return k && k.from ? { ...e, origin: { ...e.origin, from: k.from } } : e;
  });
  return partial ? { history: named, more, partial: true } : { history: named, more };
}

module.exports = { filterMainView, historyPage, runPage, parseCursor, entryOfRow };
