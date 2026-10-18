'use strict';

/**
 * sdk-interject.js — operator interjections for Claude SDK agents.
 *
 * Gateway agents get interjections injected at the top of the hub's own tool
 * loop. SDK agents run the SDK's loop, which the hub cannot reach into, so
 * instead we keep the SDK's streaming-input prompt OPEN for the whole turn and
 * push interjections into it as extra user messages.
 *
 * Measured SDK behaviour (claude-agent-sdk 0.3.270, default message priority):
 *   • arrives while tool calls remain  → absorbed into the running turn at the
 *                                         next tool boundary (one `result`)
 *   • arrives during the final answer  → the SDK finishes, then runs an
 *                                         immediate follow-up turn (second `result`)
 *   • priority:'next' was observed to DROP the message, and priority:'now'
 *     cuts the running turn — so we deliberately leave priority unset.
 *
 * With the CLI flag `--replay-user-messages` the SDK echoes every user message
 * back (isReplay:true, same uuid) at the moment it actually consumes it. We
 * use those acks — not timers — to decide when the input stream may close:
 * after a `result`, close iff every message we yielded has been acked and
 * nothing new is queued. A safety timer covers an ack that never comes.
 *
 * Anything that still was not provably delivered (arrived too late, turn
 * aborted, ack never came) is stashed on disk and prepended to the agent's
 * NEXT turn, so an interjection is never silently dropped.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PENDING_FILE = path.join(__dirname, '..', 'data', 'pending-interjections.json');
const SDK_EXTRA_ARGS = { 'replay-user-messages': null };
const ACK_SAFETY_MS = 20000;

// Framed as live steering so the model weighs it as a current instruction from
// the operator, not as background context it may ignore.
const INTERJECTION_PREFIX = '[OPERATOR INTERJECTION - the operator sent this just now, while you are working. It is a new instruction from the user: act on it, then continue your task unless it tells you otherwise]: ';
// Hub-composed emergency alert (POST /api/chat/alert). The text is fixed by the hub,
// never supplied by the caller; it must be handled before the agent's current work.
const EMERGENCY_PREFIX = '[EMERGENCY INTERJECTION - an automated alert delivered by the hub while you are working. Handle it before anything else, then resume your task]: ';

function prefixFor(ij) { return ij && ij.priority === 'emergency' ? EMERGENCY_PREFIX : INTERJECTION_PREFIX; }
function isEmergency(ij) { return !!(ij && ij.priority === 'emergency'); }
/** Stable ordering: emergency items first, everything else in arrival order. */
function emergencyFirst(items) {
  return items.filter(isEmergency).concat(items.filter(i => !isEmergency(i)));
}

class SdkInterjectionChannel {
  /**
   * @param {object} o
   * @param {() => Array<{message:string, ts:string}>} o.drain  take + clear queued interjections
   * @param {() => number} o.peek  how many interjections are queued (without taking them)
   * @param {number} [o.ackSafetyMs]
   * @param {() => string} [o.uuid]
   */
  constructor({ drain, peek, ackSafetyMs = ACK_SAFETY_MS, uuid = () => crypto.randomUUID() }) {
    this._drain = drain;
    this._peek = peek;
    this._uuid = uuid;
    this._ackSafetyMs = ackSafetyMs;
    this._closed = false;
    this._wake = null;
    this._safety = null;
    this._sent = new Map();          // uuid -> { message, ts } for interjections; null for the initial message
    this._acked = new Set();
    this._buffer = [];               // drained from the queue but not yet yielded to the SDK
    this.results = 0;
  }

  get closed() { return this._closed; }

  _userMessage(content) {
    const uuid = this._uuid();
    return { uuid, msg: { type: 'user', uuid, parent_tool_use_id: null, message: { role: 'user', content } } };
  }

  /** Async generator to hand to sdk.query({ prompt }). `initialContent` is a string or content-block array. */
  async *stream(initialContent) {
    const first = this._userMessage(initialContent);
    this._sent.set(first.uuid, null);
    yield first.msg;

    while (!this._closed) {
      // Drained items live in _buffer until they are actually yielded, so that
      // nothing is lost if the SDK stops reading part-way through a batch.
      this._buffer.push(...this._drain());
      if (this._buffer.length > 0) {
        this._buffer = emergencyFirst(this._buffer);
        while (this._buffer.length > 0 && !this._closed) {
          const ij = this._buffer.shift();
          const m = this._userMessage(prefixFor(ij) + ij.message);
          this._sent.set(m.uuid, ij);
          yield m.msg;
        }
        continue;                       // re-check the queue before sleeping
      }
      await new Promise(resolve => { this._wake = resolve; });
      this._wake = null;
    }
  }

  /** Call when a new interjection has been queued for this agent. */
  notify() { if (this._wake) this._wake(); }

  /**
   * Call for every SDK message with isReplay:true.
   * @returns the interjection record if this ack is for an interjection (first ack only), else null.
   */
  ack(uuid) {
    if (!this._sent.has(uuid) || this._acked.has(uuid)) return null;
    this._acked.add(uuid);
    if (this._allAcked()) this._clearSafety();
    return this._sent.get(uuid);        // null for the initial message
  }

  _allAcked() { for (const u of this._sent.keys()) if (!this._acked.has(u)) return false; return true; }
  _clearSafety() { if (this._safety) { clearTimeout(this._safety); this._safety = null; } }

  /**
   * Call on every SDK `result` message.
   * @returns {boolean} true if the input stream was closed (the run is over).
   */
  onResult() {
    this.results++;
    if (this._peek() > 0 || this._buffer.length > 0) {   // something queued but not yet yielded: the generator owns yielding
      this.notify();
      return false;
    }
    if (this._allAcked()) { this.close(); return true; }
    // A yielded message has not been consumed yet: the SDK will run a follow-up
    // turn for it. Hold the stream open, but not forever.
    this._clearSafety();
    this._safety = setTimeout(() => this.close(), this._ackSafetyMs);
    if (this._safety.unref) this._safety.unref();
    return false;
  }

  close() {
    this._closed = true;
    this._clearSafety();
    this.notify();
  }

  /** Interjections that were delivered and acknowledged. */
  delivered() { return [...this._sent].filter(([u, ij]) => ij && this._acked.has(u)).map(([, ij]) => ij); }

  /** Interjections handed to the SDK but never acknowledged, plus any drained but never yielded. */
  undelivered() {
    const un = [...this._sent].filter(([u, ij]) => ij && !this._acked.has(u)).map(([, ij]) => ij);
    return un.concat(this._buffer);
  }
}

// ── Next-turn fallback store ─────────────────────────────────────────────

function _readPending(file) {
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return d && typeof d === 'object' ? d : {}; }
  catch { return {}; }
}

function stashUndelivered(agentName, items, file = PENDING_FILE) {
  if (!items || items.length === 0) return 0;
  const all = _readPending(file);
  all[agentName] = (all[agentName] || []).concat(items.map(i => {
    const rec = { message: i.message, ts: i.ts };
    if (i.priority) rec.priority = i.priority;
    if (i.id) rec.id = i.id;
    return rec;
  }));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return all[agentName].length;
}

/** Read-only view of what is stashed for an agent (used for alert de-duplication). */
function peekUndelivered(agentName, file = PENDING_FILE) {
  const all = _readPending(file);
  return (all[agentName] || []).slice();
}

function takeUndelivered(agentName, file = PENDING_FILE) {
  const all = _readPending(file);
  const items = all[agentName] || [];
  if (items.length === 0) return [];
  delete all[agentName];
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return items;
}

/** Text to put in front of the agent's next prompt for interjections that missed their turn. */
function formatCarried(items) {
  if (!items || items.length === 0) return '';
  const ordered = emergencyFirst(items);
  const lines = ordered.map(i => `- ${isEmergency(i) ? '[EMERGENCY] ' : ''}(${i.ts || 'time unknown'}) ${i.message}`).join('\n');
  const anyEmergency = ordered.some(isEmergency);
  return `[OPERATOR INTERJECTION${items.length > 1 ? 'S' : ''} sent during your previous turn that could not be delivered at the time${anyEmergency ? ' - items marked [EMERGENCY] come first and must be handled before anything else' : ''}]:\n${lines}\n\n[Current message]:\n`;
}

module.exports = {
  SdkInterjectionChannel, stashUndelivered, takeUndelivered, peekUndelivered, formatCarried,
  prefixFor, isEmergency, emergencyFirst,
  SDK_EXTRA_ARGS, INTERJECTION_PREFIX, EMERGENCY_PREFIX, PENDING_FILE,
};
