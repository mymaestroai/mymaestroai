'use strict';
// The gate: who may do what on which computer. Look is free; act and drive need the agent's level to allow it AND the owner's yes for a session.
// The hub already decides which agents may call the connector at all, so an agent not listed here simply gets look.

const RANK = { look: 0, act: 1, drive: 2 };
// What one approval covers: 'act-user' < 'act-system' < 'drive' in the order they are asked. A system run covers a user run, drive (mouse and keyboard in the
// user's session) covers a user run too, and nothing else: a user-run or drive approval does NOT cover a system run, so the owner is asked again.
const COVERS = { 'act-user': ['act-user'], 'act-system': ['act-user', 'act-system'], drive: ['act-user', 'drive'] };
const scopeOf = (need, as) => (need === 'act' ? (as === 'user' ? 'act-user' : 'act-system') : need === 'drive' ? 'drive' : need in COVERS ? need : null);
const covered = (scopes, want) => [...scopes].some((s) => COVERS[s].includes(want));
const DENY_COOLDOWN_MS = 2 * 60000;
const APPROVE_MINUTES = 4;   // the owner's time to answer; a module call is cut off at 300 s

class GateError extends Error {
  constructor(message, code) { super(message); this.name = 'GateError'; this.code = code; }
}

const text = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * createGate({ levels, sessionMinutes, approve, toast, now, log })
 *   levels: ["agent:level", ...] from the settings; approve({ call, title, detail, minutes }) -> 'allow' | 'deny' | 'timeout'
 *   (call: the hub's id of the tool call that needs the yes; the hub knows the agent from it, so no agent is sent);
 *   toast(computerId, title, message) -> void (a failure is logged, never fatal).
 */
function createGate({ levels = [], sessionMinutes = 30, approve, toast = async () => {}, now = Date.now, log = () => {} } = {}) {
  const table = new Map();   // agent -> level (when an agent is listed twice the lower level counts)
  for (const entry of Array.isArray(levels) ? levels : []) {
    const m = /^([^:\s]{1,64}):(look|act|drive)$/.exec(String(entry).trim());
    if (!m) continue;
    const had = table.get(m[1]);
    if (had === undefined || RANK[m[2]] < RANK[had]) table.set(m[1], m[2]);
  }
  const sessions = new Map();   // 'agent|computer id' -> { agent, computer: {id, name}, scopes: Set of act-user / act-system / drive, expiresAt }
  const denied = new Map();     // key -> time until which the owner is not asked again
  const pending = new Map();    // key -> { level, promise }

  const levelOf = (agent) => table.get(agent) || 'look';
  const live = (s) => s && s.expiresAt > now();

  // What the owner is told the agent will be able to do.
  function can(scope) {
    if (scope === 'drive') return 'use the mouse and keyboard';
    return scope === 'act-user' ? 'run commands as the signed-in user' : 'run commands as the system account (full control)';
  }
  function ask(agent, scope, computer, call) {
    const name = `${text(computer.name, 60) || 'this computer'} (${text(computer.id, 6)})`;
    const who = text(agent, 40);
    const title = `${who} wants to use ${name}`.slice(0, 80);
    const detail = `For ${sessionMinutes} minutes ${who} may ${can(scope)} on ${name}. Every action is logged. Say no if you did not expect this.`;
    return Promise.resolve().then(() => approve({ call, title, detail, minutes: APPROVE_MINUTES })).then((d) => {
      if (d === 'allow' || d === 'deny' || d === 'timeout') return d;
      throw new GateError('The owner could not be asked right now. Try again in a moment.', 'EAPPROVE');
    }, (e) => {
      if (e instanceof GateError) throw e;
      log('approval request failed:', text(e && (e.code || e.message), 80));
      throw new GateError('The owner could not be asked right now. Try again in a moment.', 'EAPPROVE');
    });
  }

  // opts.call: the hub's id of this tool call, needed whenever the owner has to be asked. opts.as: 'system' (default) or 'user', for the act wording.
  async function require(agent, need, computer, opts) {
    const who = typeof agent === 'string' ? agent.trim() : '';
    const call = opts && typeof opts.call === 'string' ? opts.call.trim() : '';
    const as = opts && opts.as === 'user' ? 'user' : 'system';
    if (!who) throw new GateError('The hub did not say which agent is calling, so nothing is allowed.', 'EIDENT');
    if (!(need in RANK)) throw new Error('unknown level');
    if (need === 'look') return;
    if (!computer || typeof computer.id !== 'string' || !computer.id) throw new Error('a computer is needed');
    const have = levelOf(who);
    if (RANK[have] < RANK[need]) {
      throw new GateError(`${who} may only ${have === 'look' ? 'look (see pictures and facts)' : 'look and run commands'} on remote computers, and this needs ${need}. The owner can raise it in Data connectors -> Remote computers -> Settings.`, 'ELEVEL');
    }
    const want = scopeOf(need, as);
    const key = `${who}|${computer.id}`;
    for (;;) {
      const s = sessions.get(key);
      if (live(s) && covered(s.scopes, want)) return;
      if (s && !live(s)) sessions.delete(key);
      const cool = denied.get(key);
      if (cool && cool > now()) throw new GateError('The owner said no a moment ago. Do not ask again for a couple of minutes.', 'EDENIED');
      if (cool) denied.delete(key);
      const p = pending.get(key);
      if (p) {
        // One question at a time per agent and computer. A question that covers this need is shared; a smaller one is waited out, then asked again.
        if (covered([p.scope], want)) { await p.promise; return; }
        await p.promise.catch(() => {});
        continue;
      }
      if (!call) throw new GateError('The hub did not say which call this is, so the owner cannot be asked and nothing is allowed.', 'EIDENT');
      const entry = { scope: want, promise: null };
      entry.promise = (async () => {
        try {
          const d = await ask(who, want, computer, call);
          if (d === 'deny') { denied.set(key, now() + DENY_COOLDOWN_MS); throw new GateError('The owner said no.', 'EDENIED'); }
          if (d === 'timeout') throw new GateError('The owner did not answer in time.', 'ETIMEOUT');
          const prior = sessions.get(key);   // an approval adds to what a live session already covers
          const scopes = new Set(live(prior) ? prior.scopes : []);
          scopes.add(want);
          sessions.set(key, { agent: who, computer: { id: computer.id, name: text(computer.name, 80) }, scopes, expiresAt: now() + sessionMinutes * 60000 });
          try {
            await toast(computer.id, 'My Maestro', `${text(who, 40)} is using this computer for the next ${sessionMinutes} minutes.`);
          } catch (e) { log('toast failed:', text(e && (e.code || e.message), 80)); }
        } finally { pending.delete(key); }
      })();
      pending.set(key, entry);
      await entry.promise;
      return;
    }
  }

  function list() {
    const out = [];
    for (const [key, s] of sessions) {
      if (!live(s)) { sessions.delete(key); continue; }
      out.push({ agent: s.agent, computer: { ...s.computer }, level: s.scopes.has('drive') ? 'drive' : 'act', expiresAt: s.expiresAt });
    }
    return out;
  }
  function end(agent, computerId) { return sessions.delete(`${agent}|${computerId}`); }
  // True while the agent's approved session for this computer is live and covers the level; the last check before a command is sent.
  function stillValid(agent, computerId, need, as) {
    const who = typeof agent === 'string' ? agent.trim() : '';
    if (!who || !(need in RANK)) return false;
    if (need === 'look') return true;
    const s = sessions.get(`${who}|${computerId}`);
    if (!live(s)) { if (s) sessions.delete(`${who}|${computerId}`); return false; }
    return covered(s.scopes, scopeOf(need, as === 'user' ? 'user' : 'system')) && RANK[levelOf(who)] >= RANK[need];
  }

  return { require, levelOf, sessions: list, end, stillValid };
}

module.exports = { createGate, GateError, RANK, DENY_COOLDOWN_MS };
