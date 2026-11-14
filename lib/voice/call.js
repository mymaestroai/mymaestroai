'use strict';

// lib/voice/call.js: agents "on a call". While a person is on a hands-free voice call with an agent, the hub does not
// start turns of its own for that agent (a consultation, a scheduled task, a job notice...): each one waits in the
// producer's own queue, the person hears about it and says now, later or skip.
//
// State is in memory: a hub restart ends every call. A call ends when its page says so, or when no heartbeat arrives for
// EXPIRE_MS (expiry = hang-up). Nothing here stores audio or text beyond the labels of held items.
//
// Never held: the person's own turns, comms, alerts (emergency) and the call's own turns.

const crypto = require('crypto');

const EXPIRE_MS = 60 * 1000;
const SWEEP_MS = 15 * 1000;
const RECENT_MS = 60 * 60 * 1000;   // how long a recorded call that just ended can still receive its last pieces (the page keeps unsent ones and resends them)
const MODES = ['announce', 'dnd'];
const CHOICES = ['now', 'later', 'skip'];
// What waits for the person. Each kind has a producer (registerProducer) that owns the queue and runs the item on its next check.
const HELD_KINDS = new Set(['consultation', 'schedule', 'job_notice', 'job_report', 'task', 'consult_reply']);
// Skipping these would break a job's report chain: skip means "after the call" (kept, state 'later').
const LATER_ON_SKIP = new Set(['job_notice', 'job_report']);

const cleanMode = (m) => (MODES.includes(m) ? m : 'announce');
const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/**
 * createVoiceCalls({ now?, bus?, setInterval?, clearInterval?, log? }) -> the call registry.
 * bus: { publish(type, data, opts) } (the hub events bus; default: lib/hub-events, loaded on first use).
 */
function createVoiceCalls({ now = () => Date.now(), bus = null, setInterval: setIv = setInterval, clearInterval: clearIv = clearInterval, log = () => {} } = {}) {
  const calls = new Map();       // agent -> call
  const producers = new Map();   // kind -> { kick, onSkip }
  const finishHooks = [];        // onFinish(fn): run when a call ends for any reason (end, expiry, replacement)
  const ended = new Map();       // callId -> { agent, userId, sessionId, endedAt }: recorded calls that ended in the last RECENT_MS (INTERNAL)
  let sweeper = null;

  const publish = (type, data) => {
    try {
      const b = bus || require('../hub-events').events;
      b.publish(type, data, { keep: false });
    } catch (e) { log(`[voice-call] could not publish ${type}: ${e && e.message}`); }
  };

  // state: 'held' (waiting for the person), 'later' (the person said later: kept, not announced again), 'allowed', 'done'
  const itemView = (it) => ({ id: it.id, kind: it.kind, label: it.label, from: it.from, at: it.at, state: it.state });
  const view = (c) => ({ callId: c.callId, mode: c.mode, since: new Date(c.since).toISOString(), person: c.person, held: c.held.map(itemView) });
  const newCallId = () => 'call-' + crypto.randomBytes(8).toString('hex');
  // A request that names a call id is only for that call: a late request of an old call never touches a newer one.
  const isStale = (c, callId) => callId !== undefined && callId !== null && callId !== '' && String(callId) !== c.callId;
  const stale = { error: 'stale_call' };

  function kickKinds(kinds) {
    for (const kind of kinds) {
      const p = producers.get(kind);
      if (p && typeof p.kick === 'function') { try { Promise.resolve(p.kick()).catch(() => {}); } catch {} }
    }
  }

  function stopSweeper() { if (sweeper && !calls.size) { clearIv(sweeper); sweeper = null; } }
  function startSweeper() {
    if (sweeper) return;
    sweeper = setIv(() => sweep(), SWEEP_MS);
    if (sweeper && typeof sweeper.unref === 'function') sweeper.unref();
  }

  // A call that was being recorded is over (ended, expired or replaced): remember it for a while so a transcript arriving just after
  // hang-up can still be stored, then let the hooks finish its recording session. A hook that throws or rejects never stops the call ending.
  function runFinish(agent, c, why) {
    const t = now();
    for (const [id, e] of ended) if (t - e.at > RECENT_MS) ended.delete(id);
    const r = c.recording;
    const info = { agent, callId: c.callId, userId: c.userId, why: why || 'end', endedAt: new Date(t).toISOString(), recording: r ? { ...r } : null };
    if (r && r.sessionId) ended.set(c.callId, { agent, userId: c.userId, sessionId: r.sessionId, keepReplies: !!r.keepReplies, endedAt: info.endedAt, at: t });
    for (const fn of finishHooks.slice()) {
      try { const p = fn(info); if (p && typeof p.catch === 'function') p.catch((e) => log(`[voice-call] finish hook: ${e && e.code ? e.code : 'failed'}`)); } catch (e) { log(`[voice-call] finish hook: ${e && e.code ? e.code : 'failed'}`); }
    }
  }

  // The call is over (hung up or expired): tell the pages and let the producers run what was waiting.
  function finish(agent, c, why) {
    calls.delete(agent);
    runFinish(agent, c, why);
    publish('voice_call', { agent, callId: c.callId, state: 'off', mode: c.mode, person: c.person, ...(why ? { reason: why } : {}) });
    kickKinds(new Set(c.held.filter(i => i.state !== 'skipped').map(i => i.kind)));
    stopSweeper();
  }

  /** The live call of an agent, or null. A call whose heartbeat stopped is ended here (lazy expiry). */
  function live(agent) {
    const c = calls.get(agent);
    if (!c) return null;
    if (now() - c.lastSeen > EXPIRE_MS) { finish(agent, c, 'expired'); return null; }
    return c;
  }
  /** Ends every call whose heartbeat is older than EXPIRE_MS; returns the agents hung up. */
  function sweep() {
    const out = [];
    for (const agent of [...calls.keys()]) if (!live(agent)) out.push(agent);
    stopSweeper();
    return out;
  }

  // opts.admin: an admin may end, decide and change the mode of any call (heartbeat and start stay with the starter)
  const mine = (c, userId, opts) => !!(opts && opts.admin) || String(c.userId) === String(userId);
  const notYours = { error: 'not_your_call' };

  /**
   * start(agent, { userId, person, mode }) -> the call view (with a new callId), or { error }. The same person starting
   * again (a page reload) replaces their call: a new id, the held items carried over.
   */
  function start(agent, { userId, person, mode } = {}) {
    agent = String(agent || '');
    if (!agent) return { error: 'agent_required' };
    const prior = live(agent);
    if (prior && !mine(prior, userId)) return { ...notYours, person: prior.person };
    if (prior) runFinish(agent, prior, 'replaced');   // a reload: the earlier call's recording session is finished first
    const t = now();
    const c = { callId: newCallId(), userId: String(userId == null ? '' : userId), person: String(person || (prior && prior.person) || 'the owner'), mode: cleanMode(mode || (prior && prior.mode)), since: prior ? prior.since : t, lastSeen: t, held: prior ? prior.held : [], allowed: prior ? prior.allowed : new Set(), skipped: prior ? prior.skipped : new Set() };
    calls.set(agent, c);
    startSweeper();
    publish('voice_call', { agent, callId: c.callId, state: 'on', mode: c.mode, person: c.person });
    return view(c);
  }

  function heartbeat(agent, userId, callId) {
    const c = live(String(agent || ''));
    if (!c) return { error: 'no_call' };
    if (!mine(c, userId)) return notYours;
    if (isStale(c, callId)) return stale;
    c.lastSeen = now();
    return view(c);
  }

  function setMode(agent, userId, mode, callId, opts) {
    const c = live(String(agent || ''));
    if (!c) return { error: 'no_call' };
    if (!mine(c, userId, opts)) return notYours;
    if (isStale(c, callId)) return stale;
    if (!MODES.includes(mode)) return { error: 'bad_mode' };
    if (!(opts && opts.admin)) c.lastSeen = now();
    if (c.mode !== mode) { c.mode = mode; publish('voice_call', { agent, callId: c.callId, state: 'on', mode: c.mode, person: c.person }); }
    return view(c);
  }

  /** end(agent, userId, callId) -> { held } (what came in during the call), or { error } when it is not this person's call. */
  function end(agent, userId, callId, opts) {
    agent = String(agent || '');
    const c = live(agent);
    if (!c) return { held: [] };
    if (!mine(c, userId, opts)) return notYours;
    if (isStale(c, callId)) return stale;
    const held = c.held.filter(i => i.state !== 'skipped').map(itemView);
    finish(agent, c, null);
    return { held };
  }

  const onCall = (agent) => !!live(String(agent || ''));
  /** Who is on the call with this agent, for status texts: { person, mode, since } or null. */
  function info(agent) { const c = live(String(agent || '')); return c ? { person: c.person, mode: c.mode, since: c.since } : null; }
  /**
   * INTERNAL (not for any API response): who started the live call, as { kind, id }: 'user' (an account id), 'service' (the
   * hub's service token: its own identity, never folded into "no account") or 'none' ('' / 'owner': nobody was signed in).
   * null when there is no live call.
   */
  function caller(agent) {
    const c = live(String(agent || ''));
    if (!c) return null;
    const id = String(c.userId == null ? '' : c.userId);
    if (id === 'service') return { kind: 'service', id: null };
    if (!id || id === 'owner') return { kind: 'none', id: null };
    return { kind: 'user', id };
  }
  const statusOf = (agent) => { const c = live(String(agent || '')); return c ? view(c) : null; };

  /**
   * holds(agent, { id, kind, label, from }) -> true when the item must wait. The first sighting is recorded and announced
   * (voice_held; quiet in do-not-disturb); false when there is no call, the kind is never held, or the person said now.
   */
  function holds(agent, item = {}) {
    agent = String(agent || '');
    const c = live(agent);
    if (!c) return false;
    const kind = String(item.kind || '');
    if (!HELD_KINDS.has(kind)) return false;
    const id = String(item.id || '');
    if (!id) return false;
    if (c.allowed.has(id)) return false;
    if (c.skipped.has(id)) return true;
    const known = c.held.find(i => i.id === id);
    if (known && known.state !== 'done') return true;
    if (known) c.held.splice(c.held.indexOf(known), 1);   // an earlier run of this id finished: a new one is a new item
    const it = { id, kind, label: clip(item.label, 80), from: item.from == null ? null : String(item.from), at: new Date(now()).toISOString(), state: 'held' };
    c.held.push(it);
    publish('voice_held', { agent, callId: c.callId, item: itemView(it), mode: c.mode, quiet: c.mode === 'dnd' });
    return true;
  }

  /** A producer sends an item it had dropped after a skip again: it is a new item, announced anew. */
  function forget(agent, id) {
    const c = calls.get(String(agent || ''));
    if (!c) return false;
    return c.skipped.delete(String(id || ''));
  }

  /** The producer ran (or dropped) an item the person allowed: it no longer counts as waiting, and stays in the summary. */
  function release(agent, id) {
    const c = calls.get(String(agent || ''));
    if (!c) return false;
    id = String(id || '');
    c.allowed.delete(id);
    const it = c.held.find(i => i.id === id);
    if (it) it.state = 'done';
    return !!it;
  }

  /**
   * decide(agent, userId, id, choice, callId, opts) -> Promise<{ ok, choice } | { error }>.
   * skip: the producer's onSkip (may be async) must drop the item; when it throws or answers false the item stays held and
   * the answer is { error: 'cannot_skip' }. A kind in LATER_ON_SKIP (job notices and reports: skipping would break a job's report
   * chain) treats skip as "after the call": the item is kept (state 'later') and delivered after hang-up.
   */
  async function decide(agent, userId, id, choice, callId, opts) {
    agent = String(agent || '');
    const c = live(agent);
    if (!c) return { error: 'no_call' };
    if (!mine(c, userId, opts)) return notYours;
    if (isStale(c, callId)) return stale;
    if (!CHOICES.includes(choice)) return { error: 'bad_choice' };
    id = String(id || '');
    const it = c.held.find(i => i.id === id && i.state !== 'done');
    if (!it) return { error: 'unknown_item' };
    if (!(opts && opts.admin)) c.lastSeen = now();
    if (choice === 'skip' && LATER_ON_SKIP.has(it.kind)) choice = 'later';
    if (choice === 'now') {
      it.state = 'allowed'; c.allowed.add(id);
      kickKinds([it.kind]);
    } else if (choice === 'later') {
      if (it.state === 'held') it.state = 'later';
    } else if (choice === 'skip') {
      const p = producers.get(it.kind);
      if (p && typeof p.onSkip === 'function') {
        let ok = false;
        try { ok = (await p.onSkip(agent, itemView(it))) !== false; } catch (e) { log(`[voice-call] onSkip ${it.kind}: ${e && e.message}`); }
        if (!ok) return { error: 'cannot_skip' };
        // the call may have ended, or been replaced, while the producer worked
        if (calls.get(agent) !== c || !c.held.includes(it)) return { error: calls.get(agent) === c ? 'unknown_item' : 'stale_call' };
      }
      c.held.splice(c.held.indexOf(it), 1); c.skipped.add(id);
    }
    publish('voice_held_done', { agent, callId: c.callId, id, choice });
    return { ok: true, choice };
  }

  /** onFinish(fn): fn({ agent, callId, userId, why, endedAt, recording }) runs whenever a call ends (recording is null for an unrecorded call). */
  function onFinish(fn) { if (typeof fn === 'function' && !finishHooks.includes(fn)) finishHooks.push(fn); }

  // ── Call recordings (lib/recordings): INTERNAL, never in a view, an answer or a published event ──
  /** Attach (or merge) the recording state { sessionId, paused, keepReplies, mic } to the live call with this id. */
  function setRecording(agent, callId, rec) {
    const c = live(String(agent || ''));
    if (!c || String(callId || '') !== c.callId) return false;
    c.recording = { ...(c.recording || { paused: false }), ...rec };
    return true;
  }
  /** The live call's recording: { callId, userId, sessionId, paused, keepReplies, mic } or null (no call, or not recorded). */
  function recordingOf(agent) {
    const c = live(String(agent || ''));
    return c && c.recording ? { callId: c.callId, userId: c.userId, ...c.recording } : null;
  }
  /** A recorded call that ended (or was replaced by a newer call) less than 60 minutes ago: { agent, userId, sessionId, keepReplies, endedAt } or null. */
  function recentRecording(agent, callId) {
    const e = ended.get(String(callId || ''));
    if (!e || e.agent !== String(agent || '')) return null;
    if (now() - e.at > RECENT_MS) { ended.delete(String(callId)); return null; }
    return { agent: e.agent, userId: e.userId, sessionId: e.sessionId, keepReplies: e.keepReplies, endedAt: e.endedAt };
  }

  /** registerProducer(kind, { kick, onSkip(agent, item) }): kick runs the producer's next check; onSkip drops the item. */
  function registerProducer(kind, p = {}) { producers.set(String(kind), { kick: p.kick, onSkip: p.onSkip }); }

  /** Ends everything (tests, shutdown). */
  function reset() { calls.clear(); ended.clear(); stopSweeper(); producers.clear(); }

  return { start, heartbeat, setMode, end, onCall, info, caller, statusOf, holds, forget, release, decide, registerProducer, sweep, reset, onFinish, setRecording, recordingOf, recentRecording, HELD_KINDS, EXPIRE_MS };
}

let singleton = null;
/** The process-wide registry (the hub's real bus and clock). */
function getVoiceCalls() { return (singleton ||= createVoiceCalls({ log: (m) => console.log(m) })); }

module.exports = {
  createVoiceCalls, getVoiceCalls, HELD_KINDS, EXPIRE_MS, SWEEP_MS, MODES, CHOICES,
  start: (...a) => getVoiceCalls().start(...a),
  heartbeat: (...a) => getVoiceCalls().heartbeat(...a),
  setMode: (...a) => getVoiceCalls().setMode(...a),
  end: (...a) => getVoiceCalls().end(...a),
  onCall: (...a) => getVoiceCalls().onCall(...a),
  info: (...a) => getVoiceCalls().info(...a),
  caller: (...a) => getVoiceCalls().caller(...a),
  statusOf: (...a) => getVoiceCalls().statusOf(...a),
  holds: (...a) => getVoiceCalls().holds(...a),
  release: (...a) => getVoiceCalls().release(...a),
  forget: (...a) => getVoiceCalls().forget(...a),
  decide: (...a) => getVoiceCalls().decide(...a),
  registerProducer: (...a) => getVoiceCalls().registerProducer(...a),
  onFinish: (...a) => getVoiceCalls().onFinish(...a),
  setRecording: (...a) => getVoiceCalls().setRecording(...a),
  recordingOf: (...a) => getVoiceCalls().recordingOf(...a),
  recentRecording: (...a) => getVoiceCalls().recentRecording(...a),
};
