'use strict';
/**
 * A running Tiger Team, decoupled from the page that started it (2026-10-21).
 *
 * Until now the team's events went straight into the HTTP response of the browser tab that launched it, and closing
 * or reloading that tab stopped the team eight seconds later. Now a run writes to a TeamStream:
 *   - every event is journaled (type 'stream' in the team's events.jsonl) with its sequence number (tt_seq) and time
 *     (tt_at), then sent to every page attached to the team;
 *   - a page that drops, reloads or opens later replays from the journal (GET /api/tiger-team/stream?since=<seq>) and
 *     then follows live; closing every page never stops a team (Stop does).
 * Members run in parallel, so each nested event also names the dispatch it belongs to (tagFrame: tt_call, tt_agent,
 * tt_role); the page draws one card per dispatch instead of pouring everything into the newest card.
 *
 * Also here: the team folder (share/common/tiger-teams/<id>/, which every admin-side agent can open, boxed or not),
 * the busy wait for a member that is mid-turn elsewhere, and which tools cannot change anything.
 */
const fs = require('fs');
const path = require('path');

const HUB_HOME = path.resolve(__dirname, '..', '..');
const HEARTBEAT_MS = 15000;
const streams = new Map();   // team id -> the TeamStream of its current run

/** Add tags to one SSE frame ("data: {...}\n\n"); comments, [DONE] and frames that are not JSON objects pass unchanged. */
function editFrame(frame, edit) {
  const s = String(frame);
  if (!s.startsWith('data: ')) return s;
  const body = s.slice(6).trim();
  if (!body || body === '[DONE]' || body[0] !== '{') return s;
  let obj;
  try { obj = JSON.parse(body); } catch { return s; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return s;
  return edit(obj) === false ? s : `data: ${JSON.stringify(obj)}\n\n`;
}

/** Name the dispatch an event came from. The innermost call wins: a member's frames pass through the coordinator's call untouched. */
function tagFrame(frame, { call, agent, role }) {
  return editFrame(frame, (obj) => {
    if (obj.tt_call) return false;
    obj.tt_call = call; obj.tt_agent = agent; obj.tt_role = role;
    return true;
  });
}

class TeamStream {
  /**
   * opts.store: the CheckpointStore (append, events); opts.getState(id): the team's live state (its eventSeq numbers
   * the journal). bind(id) names the team once the run has created it; frames before that are only sent, not journaled.
   */
  constructor({ store, getState, log = console.log, heartbeatMs = HEARTBEAT_MS } = {}) {
    this.store = store; this.getState = getState; this.log = log;
    this.id = null; this.viewers = new Set(); this.ended = false; this.isTeamStream = true;
    // A run never sees its stream as closed: the team keeps working with no page attached.
    this.writableEnded = false; this.destroyed = false;
    this._journalFailed = false;
    this._beat = heartbeatMs ? setInterval(() => this._send(': heartbeat\n\n'), heartbeatMs) : null;
    if (this._beat && this._beat.unref) this._beat.unref();
  }

  writeHead() {}

  bind(id) {
    if (this.id === id) return this;
    if (this.id && streams.get(this.id) === this) streams.delete(this.id);
    this.id = id;
    if (id) streams.set(id, this);
    return this;
  }

  write(raw) {
    let frame = String(raw);
    const state = this.id ? this.getState(this.id) : null;
    if (state && this.store && frame.startsWith('data: ') && frame.trim() !== 'data: [DONE]') {
      // Number and time the event, then journal exactly what the pages get (synchronous: nothing can append in between).
      const seq = (state.eventSeq || 0) + 1, at = new Date().toISOString();
      const tagged = editFrame(frame, (obj) => { obj.tt_seq = seq; obj.tt_at = at; return true; });
      if (tagged !== frame) {
        try {
          this.store.append(this.id, state, { type: 'stream', raw: tagged });
          state.hasStream = true;
          frame = tagged;
        } catch (e) {
          // The display journal is a convenience (the work itself is journaled separately and fails closed): keep going.
          if (!this._journalFailed) { this._journalFailed = true; this.log(`[tiger-team] ${this.id}: stream journal failed (${e.message}); a page that reconnects may miss events`); }
        }
      }
    }
    this._send(frame);
    return true;
  }

  _send(frame) {
    for (const v of [...this.viewers]) {
      if (v.destroyed || v.writableEnded) { this.viewers.delete(v); continue; }
      try { v.write(frame); } catch { this.viewers.delete(v); }
    }
  }

  /** Attach one page's response. Returns false once the run is over (the caller ends the response itself). */
  attach(res) {
    if (this.ended || !res) return false;
    this.viewers.add(res);
    if (typeof res.on === 'function') res.on('close', () => this.viewers.delete(res));
    return true;
  }

  get viewerCount() { return [...this.viewers].filter(v => !v.destroyed && !v.writableEnded).length; }

  /** The run is over: close every page's stream and forget the team. */
  end() {
    if (this.ended) return;
    this.ended = true;
    if (this._beat) clearInterval(this._beat);
    for (const v of this.viewers) {
      try { if (!v.destroyed && !v.writableEnded) { v.write('data: [DONE]\n\n'); v.end(); } } catch {}
    }
    this.viewers.clear();
    if (this.id && streams.get(this.id) === this) streams.delete(this.id);
  }
}

/** The live stream of a running team, or null. */
function get(id) { const s = streams.get(id); return s && !s.ended ? s : null; }

/**
 * Write the journaled frames of team `id` with tt_seq > since to res (synchronously, so a live attach right after
 * cannot lose or repeat a frame). Returns how many were written.
 */
function replay(store, id, res, since = 0) {
  let n = 0;
  for (const ev of store.events(id)) {
    if (ev.type !== 'stream' || !(ev.seq > since) || typeof ev.raw !== 'string') continue;
    res.write(ev.raw); n++;
  }
  return n;
}

/** The team folder: one per team, under share/common so every admin-side member can open it, sandboxed or not. */
function teamFolderFor(id) { return path.join(HUB_HOME, 'share', 'common', 'tiger-teams', String(id)); }

/** Create the team folder (and share/common when missing). Returns its path, or null when it cannot be made. */
function ensureTeamFolder(id, log = console.warn) {
  const dir = teamFolderFor(id);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o775 }); return dir; }
  catch (e) { log(`[tiger-team] could not create the team folder ${dir}: ${e.message}`); return null; }
}

// Tools that cannot change anything: when one of them throws, the team simply gets the error back (no uncertain outcome).
const CHANGES_NOTHING = /^(Read|Glob|Grep|WebSearch|WebFetch|read_tiger_team_archive|read_memory|read_session_notes|read_shared_memory|search_shared_memory|list_agents|recall|recall_context|record_list)$/;
function changesNothing(toolName) { return CHANGES_NOTHING.test(String(toolName || '')); }

const BUSY_WAIT_MS = 10 * 60 * 1000;
/**
 * Wait until isActive() is false: one turn per agent at a time, so a member that is mid-turn elsewhere (a chat, a job,
 * another dispatch of this team) is waited for. onWait(seconds) is called once, when the wait starts. Resolves true
 * when the member is free, false after maxMs; rejects when the signal aborts.
 */
async function waitUntilFree(isActive, { signal, sleep, onWait = () => {}, maxMs = BUSY_WAIT_MS, stepMs = 2000, now = Date.now } = {}) {
  if (!isActive()) return true;
  const start = now();
  onWait(Math.round(maxMs / 1000));
  while (isActive()) {
    if (now() - start >= maxMs) return false;
    await sleep(stepMs, signal);
  }
  return true;
}

module.exports = { TeamStream, get, replay, tagFrame, editFrame, teamFolderFor, ensureTeamFolder, changesNothing, waitUntilFree, BUSY_WAIT_MS, _streams: streams };
