'use strict';

// lib/voice/call.js: agents "on a call". While a person is on a hands-free voice call with an agent, the hub does not
// start turns of its own for that agent (a consultation, a scheduled task, a job notice...): each one waits in the
// producer's own queue, the person hears about it and says now, later or skip.
//
// State is in memory: a hub restart ends every call. A call ends when its page says so, or when no heartbeat arrives for
// EXPIRE_MS (expiry = hang-up). Nothing here stores audio or text beyond the labels of held items.
//
// Never held: the person's own turns, comms, alerts (emergency) and the call's own turns.

const EXPIRE_MS = 60 * 1000;
const SWEEP_MS = 15 * 1000;
const MODES = ['announce', 'dnd'];
const CHOICES = ['now', 'later', 'skip'];
// What waits for the person. Each kind has a producer (registerProducer) that owns the queue and runs the item on its next check.
const HELD_KINDS = new Set(['consultation', 'schedule', 'job_notice', 'job_report', 'task', 'consult_reply']);

const cleanMode = (m) => (MODES.includes(m) ? m : 'announce');
const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/**
 * createVoiceCalls({ now?, bus?, setInterval?, clearInterval?, log? }) -> the call registry.
 * bus: { publish(type, data, opts) } (the hub events bus; default: lib/hub-events, loaded on first use).
 */
function createVoiceCalls({ now = () => Date.now(), bus = null, setInterval: setIv = setInterval, clearInterval: clearIv = clearInterval, log = () => {} } = {}) {
  const calls = new Map();       // agent -> call
  const producers = new Map();   // kind -> { kick, onSkip }
  let sweeper = null;

  const publish = (type, data) => {
    try {
      const b = bus || require('../hub-events').events;
      b.publish(type, data, { keep: false });
    } catch (e) { log(`[voice-call] could not publish ${type}: ${e && e.message}`); }
  };

  const itemView = (it) => ({ id: it.id, kind: it.kind, label: it.label, from: it.from, at: it.at, state: it.state });
  const view = (c) => ({ mode: c.mode, since: new Date(c.since).toISOString(), person: c.person, held: c.held.map(itemView) });

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

  // The call is over (hung up or expired): tell the pages and let the producers run what was waiting.
  function finish(agent, c, why) {
    calls.delete(agent);
    publish('voice_call', { agent, state: 'off', mode: c.mode, person: c.person, ...(why ? { reason: why } : {}) });
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

  const mine = (c, userId) => String(c.userId) === String(userId);
  const notYours = { error: 'not_your_call' };

  function start(agent, { userId, person, mode } = {}) {
    agent = String(agent || '');
    if (!agent) return { error: 'agent_required' };
    const prior = live(agent);
    if (prior && !mine(prior, userId)) return { ...notYours, person: prior.person };
    if (prior) {   // the same person starting again (a page reload): the call carries on
      prior.lastSeen = now(); prior.mode = cleanMode(mode || prior.mode);
      if (person) prior.person = String(person);
      return view(prior);
    }
    const t = now();
    const c = { userId: String(userId == null ? '' : userId), person: String(person || 'the owner'), mode: cleanMode(mode), since: t, lastSeen: t, held: [], allowed: new Set(), skipped: new Set() };
    calls.set(agent, c);
    startSweeper();
    publish('voice_call', { agent, state: 'on', mode: c.mode, person: c.person });
    return view(c);
  }

  function heartbeat(agent, userId) {
    const c = live(String(agent || ''));
    if (!c) return { error: 'no_call' };
    if (!mine(c, userId)) return notYours;
    c.lastSeen = now();
    return view(c);
  }

  function setMode(agent, userId, mode) {
    const c = live(String(agent || ''));
    if (!c) return { error: 'no_call' };
    if (!mine(c, userId)) return notYours;
    if (!MODES.includes(mode)) return { error: 'bad_mode' };
    c.lastSeen = now();
    if (c.mode !== mode) { c.mode = mode; publish('voice_call', { agent, state: 'on', mode: c.mode, person: c.person }); }
    return view(c);
  }

  /** end(agent, userId) -> { held } (what came in during the call), or { error } when it is not this person's call. */
  function end(agent, userId) {
    agent = String(agent || '');
    const c = live(agent);
    if (!c) return { held: [] };
    if (!mine(c, userId)) return notYours;
    const held = c.held.filter(i => i.state !== 'skipped').map(itemView);
    finish(agent, c, null);
    return { held };
  }

  const onCall = (agent) => !!live(String(agent || ''));
  /** Who is on the call with this agent, for status texts: { person, mode, since } or null. */
  function info(agent) { const c = live(String(agent || '')); return c ? { person: c.person, mode: c.mode, since: c.since } : null; }
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
    publish('voice_held', { agent, item: itemView(it), mode: c.mode, quiet: c.mode === 'dnd' });
    return true;
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

  /** decide(agent, userId, id, choice) -> { ok, state } or { error }. */
  function decide(agent, userId, id, choice) {
    agent = String(agent || '');
    const c = live(agent);
    if (!c) return { error: 'no_call' };
    if (!mine(c, userId)) return notYours;
    if (!CHOICES.includes(choice)) return { error: 'bad_choice' };
    id = String(id || '');
    const it = c.held.find(i => i.id === id && i.state !== 'done');
    if (!it) return { error: 'unknown_item' };
    c.lastSeen = now();
    if (choice === 'now') {
      it.state = 'allowed'; c.allowed.add(id);
      kickKinds([it.kind]);
    } else if (choice === 'skip') {
      c.held.splice(c.held.indexOf(it), 1); c.skipped.add(id);
      const p = producers.get(it.kind);
      if (p && typeof p.onSkip === 'function') { try { p.onSkip(agent, itemView(it)); } catch (e) { log(`[voice-call] onSkip ${it.kind}: ${e && e.message}`); } }
    }
    publish('voice_held_done', { agent, id, choice });
    return { ok: true, choice };
  }

  /** registerProducer(kind, { kick, onSkip(agent, item) }): kick runs the producer's next check; onSkip drops the item. */
  function registerProducer(kind, p = {}) { producers.set(String(kind), { kick: p.kick, onSkip: p.onSkip }); }

  /** Ends everything (tests, shutdown). */
  function reset() { calls.clear(); stopSweeper(); producers.clear(); }

  return { start, heartbeat, setMode, end, onCall, info, statusOf, holds, release, decide, registerProducer, sweep, reset, HELD_KINDS, EXPIRE_MS };
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
  statusOf: (...a) => getVoiceCalls().statusOf(...a),
  holds: (...a) => getVoiceCalls().holds(...a),
  release: (...a) => getVoiceCalls().release(...a),
  decide: (...a) => getVoiceCalls().decide(...a),
  registerProducer: (...a) => getVoiceCalls().registerProducer(...a),
};
