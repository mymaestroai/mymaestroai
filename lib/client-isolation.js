'use strict';
/**
 * Client isolation: the options every Claude client the hub starts must carry (security R2).
 *
 * The client runs on the host with the owner's sign-in. What it may load is decided here, by the class of the agent
 * it serves:
 *   - boxed (the agent is in a sandbox): no settings sources, no MCP servers but the hub's, built-ins by allow-list;
 *   - member-reachable (a member owns it or it is shared) or internal (model probe, usage, welcome): no settings sources;
 *   - an admin-side host agent no member can reach: the account's own (user) settings and skills only, and no hooks
 *     from any settings file (the hub's callback gate still runs).
 * For every class: only the MCP servers the hub passes, and the claude.ai account connectors off.
 */

const access = require('./access');

// The only client built-ins a boxed agent's client may hold: they touch neither the host's shell, files nor network.
// An allow-list: no current or future built-in (shell, files, web, sub-agent, Skill, Cron, Workflow) gets through.
const BOXED_CLIENT_BUILTINS = ['ToolSearch'];

function isolationFor({ boxed = false, memberReachable = false, internal = false } = {}) {
  const iso = {
    strictMcpConfig: true,
    settings: { disableClaudeAiConnectors: true },
    env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
  };
  if (boxed || memberReachable || internal) iso.settingSources = [];
  else { iso.settingSources = ['user']; iso.managedSettings = { allowManagedHooksOnly: true }; }
  if (boxed) iso.tools = [...BOXED_CLIENT_BUILTINS];
  return iso;
}

/** mergeInto(queryOptions, iso) -> new options: iso applied, existing settings and env keys kept. */
function mergeInto(queryOptions, iso) {
  const o = queryOptions || {};
  const i = iso || isolationFor({ internal: true });
  const out = { ...o, ...i };
  out.settings = { ...(o.settings || {}), ...(i.settings || {}) };
  // The SDK runs the client with options.env INSTEAD of process.env: a call site that passed no env used process.env, so
  // start from it there, or the client would start without PATH and HOME (and so without the sign-in).
  out.env = { ...(o.env || process.env), ...(i.env || {}) };
  if (o.managedSettings || i.managedSettings) out.managedSettings = { ...(o.managedSettings || {}), ...(i.managedSettings || {}) };
  return out;
}

/** An agent a member can reach: owned by a non-admin, or shared with anyone. */
function isMemberReachable(agent, adminIds) {
  const admins = adminIds instanceof Set ? adminIds : new Set((adminIds || []).map(String));
  const owner = access.ownerOf(agent);
  if (owner && !admins.has(owner)) return true;
  return access.sharedWith(agent).length > 0;
}

/**
 * isolationForAgent(agent, { adminIds, sandboxed, parent }) -> isolationFor() for a stored agent record. A temporary
 * worker passes its parent's record as `agent`, so it takes its parent's class.
 */
function isolationForAgent(agent, { adminIds, sandboxed = false } = {}) {
  return isolationFor({ boxed: !!sandboxed, memberReachable: isMemberReachable(agent, adminIds) });
}

module.exports = { isolationFor, mergeInto, isMemberReachable, isolationForAgent, BOXED_CLIENT_BUILTINS };
