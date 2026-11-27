'use strict';
// The command lockbox's settings: what values are valid, how a change is worded for the audit log and the admin notice,
// and the two admin-only routes (status, watch log). Its one dependency is lib/access (isAdminSession), which requires
// nothing, so lib/agents.js and server.js can load it at any time; lib/access must never require this file.
// The values match lib/lockbox/index.js (AGENT_VALUES, MODES, ENV_NAME_RE); test/lockbox-settings.test.js checks they stay equal.

const AGENT_VALUES = ['inherit', 'off', 'watch', 'enforce'];
const DEFAULT_VALUES = ['off', 'watch', 'enforce'];
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const ENV_MAX = 32;

/** The per-agent value, or an Error message when it is not one of inherit | off | watch | enforce. */
function cleanAgentMode(v) {
  const s = v === undefined || v === null || v === '' ? 'inherit' : v;
  if (typeof s !== 'string' || !AGENT_VALUES.includes(s)) return { ok: false, error: 'lockbox must be inherit, off, watch or enforce' };
  return { ok: true, value: s };
}

/** The hub default: off | watch | enforce (not inherit). */
function cleanDefault(v) {
  if (typeof v !== 'string' || !DEFAULT_VALUES.includes(v)) return { ok: false, error: 'lockboxDefault must be off, watch or enforce' };
  return { ok: true, value: v };
}

/** The kept environment variable names: an array (or a comma-separated string) of valid names, at most 32, no repeats. */
function cleanEnv(v) {
  if (v === undefined || v === null || v === '') return { ok: true, value: [] };
  const list = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',') : null);
  if (!list) return { ok: false, error: 'lockboxEnv must be a list of environment variable names' };
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') return { ok: false, error: 'lockboxEnv holds names only' };
    const n = raw.trim();
    if (!n) continue;
    if (!ENV_NAME_RE.test(n)) return { ok: false, error: '"' + n.slice(0, 40) + '" is not a valid environment variable name (letters, digits and _, not starting with a digit, up to 64 characters)' };
    if (!out.includes(n)) out.push(n);
  }
  if (out.length > ENV_MAX) return { ok: false, error: 'lockboxEnv may list at most ' + ENV_MAX + ' names' };
  return { ok: true, value: out };
}

/** What a stored record shows: a bad stored value reads as the default. */
function modeOf(a) { return a && AGENT_VALUES.includes(a.lockbox) ? a.lockbox : 'inherit'; }
function envOf(a) { const r = cleanEnv(a && a.lockboxEnv); return r.ok ? r.value : []; }

const plain = (m) => (m === 'inherit' ? 'hub default' : m);
const safeWho = (who) => String(who || 'unknown').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, 80) || 'unknown';

/** One line, in plain words, for the audit log and the notice. */
function describeAgentChange(agentName, from, to, who) {
  return `Command lockbox for ${agentName}: ${plain(from)} -> ${plain(to)} (by ${safeWho(who)})`;
}
function describeDefaultChange(from, to, who) {
  return `Command lockbox hub default: ${from} -> ${to} (by ${safeWho(who)})`;
}
function describeEnvChange(agentName, from, to, who) {
  const show = (l) => (l.length ? l.join(', ') : 'none');
  return `Command lockbox environment variables kept for ${agentName}: ${show(from)} -> ${show(to)} (by ${safeWho(who)})`;
}

/**
 * The lockboxDefault part of a POST /api/settings patch. Returns { ok:true, change } (change = the plain-words line, or null when
 * nothing changed; patch.lockboxDefault is set to the cleaned value), or { ok:false, status, error }. A patch without the key passes.
 */
function checkDefaultPatch(patch, req, getSetting) {
  return checkDefaultPatchFor(patch, { ownSession: isAdminSession(req), who: req && req.hubUser ? (req.hubUser.name || req.hubUser.login || req.hubUser.id) : '' }, getSetting);
}
/** The same check without a request: ctx = { ownSession: a signed-in admin's own browser session, who: the name for the notice }. */
function checkDefaultPatchFor(patch, ctx, getSetting) {
  if (!patch || typeof patch !== 'object' || !('lockboxDefault' in patch)) return { ok: true, change: null };
  if (!(ctx && ctx.ownSession)) return { ok: false, status: 403, error: 'Sign in with an admin account in your browser to change the command lockbox.' };
  const r = cleanDefault(patch.lockboxDefault);
  if (!r.ok) return { ok: false, status: 400, error: r.error };
  patch.lockboxDefault = r.value;
  const stored = getSetting('lockboxDefault');
  const before = DEFAULT_VALUES.includes(stored) ? stored : 'off';
  return { ok: true, change: before !== r.value ? describeDefaultChange(before, r.value, ctx.who) : null };
}

// ── Routes ───────────────────────────────────────────────────────────
// A signed-in admin's own browser session: not a token, not the hub's service, not a session still owing its two-factor
// code. The check lives in lib/access (the other owner-only routes use it too); re-exported here for the lockbox's own use.
const { isAdminSession } = require('../access');

/**
 * GET /api/lockbox/status and GET /api/lockbox/watch. Returns true when it handled the request.
 * deps: { jsonResponse, getAgents, getSetting, lockbox (lib/lockbox), sandboxedOf, handsOf }
 */
async function handle(pathname, req, res, deps) {
  if (pathname !== '/api/lockbox/status' && pathname !== '/api/lockbox/watch') return false;
  const { jsonResponse } = deps;
  if (req.method !== 'GET') { jsonResponse(res, 405, { error: 'method_not_allowed' }); return true; }
  if (!isAdminSession(req)) { jsonResponse(res, 403, { error: 'admin_only' }); return true; }
  const lockbox = deps.lockbox;
  if (pathname === '/api/lockbox/status') {
    const host = lockbox.probe();
    const agents = await deps.getAgents();
    const status = lockbox.statusFor({ agents, getSetting: deps.getSetting, probe: () => host, sandboxedOf: deps.sandboxedOf, handsOf: deps.handsOf });
    jsonResponse(res, 200, { ok: true, ...status, tiocsti: host ? host.tiocsti : undefined });
    return true;
  }
  const u = new URL(req.url || pathname, 'http://x');
  const agent = u.searchParams.get('agent');
  if (agent !== null && !AGENT_NAME_RE.test(agent)) { jsonResponse(res, 400, { error: 'agent must be a lower-case agent name' }); return true; }
  const rawLimit = u.searchParams.get('limit');
  let limit = 100;
  if (rawLimit !== null && rawLimit !== '') {
    const n = Number(rawLimit);
    if (!Number.isFinite(n) || n < 1) { jsonResponse(res, 400, { error: 'limit must be a number from 1 to 500' }); return true; }
    limit = Math.min(500, Math.floor(n));
  }
  jsonResponse(res, 200, { entries: lockbox.readLog({ agent: agent || undefined, limit }) });
  return true;
}

module.exports = { AGENT_VALUES, DEFAULT_VALUES, ENV_NAME_RE, AGENT_NAME_RE, ENV_MAX,
  cleanAgentMode, cleanDefault, cleanEnv, modeOf, envOf, describeAgentChange, describeDefaultChange, describeEnvChange, isAdminSession, checkDefaultPatch, checkDefaultPatchFor, handle };
