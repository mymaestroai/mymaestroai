'use strict';
/**
 * root-grants.js — the operator's hand-given, time-limited permission for ONE agent to run commands as root.
 *
 * Root is otherwise the lead agent's alone (lib/tool-policy decide()). When the owner wants another agent to run
 * sudo for a while (a review that needs `sshd -T`, a repair job), an admin grants it here from the agent's settings
 * page or the Settings page: a grant names the agent, who gave it, why, and when it ends (default one hour). The
 * policy gate asks `active(agent)` on every root command; an expired grant is gone the moment it expires. Grants
 * never apply to member-owned agents or to agents whose shell runs inside a container (there is no sudo in the box).
 * Every grant and revocation is written to the same audit trail as the root commands themselves
 * (data/root-commands.jsonl, kinds "grant" / "revoke") and to the hub's audit table by the caller.
 *
 * Only an admin session may create or revoke a grant (server.js refuses the hub's own service identity, so no agent
 * can grant itself root through a loopback call). Data: data/root-grants.json, owner-only.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HUB_ROOT } = require('./tool-policy');

const DEFAULT_MINUTES = 60;
const MAX_MINUTES = 24 * 60;
const AGENT_RE = /^[a-z][a-z0-9_-]*$/;

function createRootGrants({ file = path.join(HUB_ROOT, 'data', 'root-grants.json'), auditFile = path.join(HUB_ROOT, 'data', 'root-commands.jsonl'), now = Date.now, log = console.log } = {}) {
  let grants = [];
  function load() {
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); grants = Array.isArray(j.grants) ? j.grants : []; } catch { grants = []; }
  }
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ grants }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  function audit(entry) {
    try { fs.mkdirSync(path.dirname(auditFile), { recursive: true }); fs.appendFileSync(auditFile, JSON.stringify(entry) + '\n', { mode: 0o600 }); } catch (e) { log(`[root-grants] audit write failed: ${e.message}`); }
  }
  function prune() {
    const t = now();
    const before = grants.length;
    grants = grants.filter(g => Date.parse(g.until) > t);
    if (grants.length !== before) save();
  }
  load(); prune();

  /** grant(agent, { minutes, by, note }) -> the grant. Replaces any existing grant for that agent. */
  function grant(agent, { minutes = DEFAULT_MINUTES, by = null, note = '' } = {}) {
    const name = String(agent || '').trim();
    if (!AGENT_RE.test(name)) throw new Error('agent name required');
    const m = Number(minutes);
    if (!Number.isFinite(m) || m < 1 || m > MAX_MINUTES) throw new Error(`minutes must be 1-${MAX_MINUTES}`);
    prune();
    const at = new Date(now()).toISOString();
    const g = { id: crypto.randomBytes(6).toString('hex'), agent: name, by: by ? String(by) : null, note: String(note || '').slice(0, 200), at, until: new Date(now() + m * 60 * 1000).toISOString(), minutes: m };
    grants = grants.filter(x => x.agent !== name).concat([g]);
    save();
    audit({ ts: at, kind: 'grant', id: g.id, agent: name, by: g.by, minutes: m, until: g.until, note: g.note });
    log(`[root-grants] ${name}: root granted for ${m} min by ${g.by || 'an admin'} (until ${g.until})${g.note ? ` — ${g.note}` : ''}`);
    return { ...g };
  }

  /** revoke(agent, { by }) -> true when a grant was removed. */
  function revoke(agent, { by = null } = {}) {
    const name = String(agent || '').trim();
    prune();
    const g = grants.find(x => x.agent === name);
    if (!g) return false;
    grants = grants.filter(x => x.agent !== name);
    save();
    audit({ ts: new Date(now()).toISOString(), kind: 'revoke', id: g.id, agent: name, by: by ? String(by) : null });
    log(`[root-grants] ${name}: root grant revoked by ${by || 'an admin'}`);
    return true;
  }

  /** active(agent) -> the live grant or null. */
  function active(agent) {
    prune();
    const g = grants.find(x => x.agent === String(agent || ''));
    return g ? { ...g } : null;
  }

  function list() { prune(); return grants.map(g => ({ ...g })); }

  return { grant, revoke, active, list, DEFAULT_MINUTES, MAX_MINUTES, file };
}

let _shared = null;
function getRootGrants(opts) { if (!_shared) _shared = createRootGrants(opts); return _shared; }

module.exports = { createRootGrants, getRootGrants, DEFAULT_MINUTES, MAX_MINUTES };
