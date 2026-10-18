'use strict';
// Action-level approvals: when a tool call lands on "ask", the agent's path pauses here until the
// owner answers (desktop card, mobile card, push), or the request times out (deny). Approval is
// bound to the exact call (a hash of tool + arguments); "approve this kind for 1 hour" records an
// allowance keyed by (agent, class, destination) in tool-policy's allowances.
//
// Events (via onEvent -> /api/events): approval_request, approval_resolved.

const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;   // settings.approvalTimeoutMinutes overrides (per request)

// Stable serialisation: object keys sorted at EVERY depth (a key-array replacer only keeps top-level
// keys and dropped nested ones, so calls differing only in nested arguments hashed the same).
function stableStringify(v, seen = new Set()) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (seen.has(v)) return '"[circular]"';
  seen.add(v);
  let out;
  if (Array.isArray(v)) out = `[${v.map(x => stableStringify(x, seen)).join(',')}]`;
  else out = `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k], seen)}`).join(',')}}`;
  seen.delete(v);
  return out;
}
let circularSeq = 0;
function hashArgs(tool, input) {
  let s;
  try { s = stableStringify(input); } catch { s = String(input); }
  if (s.includes('"[circular]"')) s += `#${++circularSeq}`;   // circular inputs never collide with each other
  return crypto.createHash('sha256').update(`${tool}\n${s}`).digest('hex').slice(0, 16);
}

function createApprovals({ now = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS, onEvent = null, allowances = null, log = console.log } = {}) {
  // timeoutMs may be a function so the owner can change the window in Settings without a restart.
  const ttlNow = () => { const v = Number(typeof timeoutMs === 'function' ? timeoutMs() : timeoutMs); return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS; };
  const pending = new Map();   // id -> record
  const history = [];          // last N resolved, for the UI
  const HISTORY = 50;

  function emit(type, data) { if (onEvent) { try { onEvent({ type, ...data }); } catch {} } }

  function publicView(r) {
    return { id: r.id, agent: r.agent, tool: r.tool, cls: r.cls, summary: r.summary, detail: r.detail || null, role: r.role || null,
      allowKey: r.allowKey, argsHash: r.argsHash, createdAt: r.createdAt, expiresAt: r.expiresAt, origin: r.origin || null };
  }

  /**
   * request({ agent, tool, input, cls, summary, detail, allowKey, role, origin }) -> Promise<{ decision, by, remember }>
   * decision: 'allow' | 'deny'; by: 'owner' | 'timeout' | 'cancelled'
   */
  function request(spec) {
    const id = `ap_${now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const createdAt = new Date(now()).toISOString();
    const ttl = ttlNow();
    const expiresAt = new Date(now() + ttl).toISOString();
    const rec = { ...spec, id, createdAt, expiresAt, argsHash: hashArgs(spec.tool, spec.input) };
    const p = new Promise((resolve) => {
      rec.resolve = resolve;
      rec.timer = setTimeout(() => finish(id, { decision: 'deny', by: 'timeout' }), ttl);
    });
    pending.set(id, rec);
    log(`[approvals] ${rec.agent}: ${rec.cls} needs approval (${String(rec.summary || '').slice(0, 120)}) id=${id}`);
    emit('approval_request', publicView(rec));
    return { id, promise: p };
  }

  function finish(id, { decision, by, remember = null }) {
    const rec = pending.get(id);
    if (!rec) return null;
    pending.delete(id);
    clearTimeout(rec.timer);
    const out = { decision, by, remember };
    if (decision === 'allow' && remember && allowances && rec.allowKey) {
      const ttl = remember === '1h' ? 60 * 60 * 1000 : remember === 'session' ? 12 * 60 * 60 * 1000 : 0;
      if (ttl) allowances.add(rec.allowKey, ttl);
    }
    history.unshift({ ...publicView(rec), decision, by, remember, resolvedAt: new Date(now()).toISOString() });
    if (history.length > HISTORY) history.length = HISTORY;
    log(`[approvals] ${rec.agent}: ${decision} by ${by}${remember ? ` (remember ${remember})` : ''} id=${id}`);
    emit('approval_resolved', { id, agent: rec.agent, cls: rec.cls, decision, by, remember });
    rec.resolve(out);
    return out;
  }

  /** Owner answers: resolve(id, 'allow'|'deny', { remember: '1h'|'session'|null }) */
  function resolve(id, decision, { remember = null } = {}) {
    if (!['allow', 'deny'].includes(decision)) return { ok: false, error: 'decision must be allow or deny' };
    const r = finish(id, { decision, by: 'owner', remember });
    return r ? { ok: true, ...r } : { ok: false, error: 'no such pending approval (answered already or timed out)' };
  }

  /** Cancel every pending request of an agent (its turn was stopped). */
  function cancelFor(agent) {
    let n = 0;
    for (const [id, r] of pending) if (r.agent === agent) { finish(id, { decision: 'deny', by: 'cancelled' }); n++; }
    return n;
  }

  function list() { return [...pending.values()].map(publicView); }
  function recent() { return history.slice(); }
  function pendingFor(agent) { return [...pending.values()].filter(r => r.agent === agent).map(publicView); }
  function get(id) { const r = pending.get(id); return r ? publicView(r) : null; }

  return { request, resolve, cancelFor, list, recent, pendingFor, get, hashArgs, get timeoutMs() { return ttlNow(); } };
}

let shared = null;
function getApprovals(opts) { if (!shared) shared = createApprovals(opts); return shared; }

module.exports = { createApprovals, getApprovals, hashArgs, DEFAULT_TIMEOUT_MS };
