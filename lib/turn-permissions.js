'use strict';
// The one rule: may agent `from` start a turn of agent `to` (queued task, job report)?
// Allowed: to === from; `from` is a lead agent; both are in the same owner pool (lib/access.sameOwner);
// or (reports only) `to` is the agent that consulted `from` in this turn and may still consult `from`.
// An admin's "May consult" grant does NOT count here.
const access = require('./access');

/**
 * @param {object} p
 * @param {string} p.from @param {string} p.to @param {string|null} [p.consultedBy]
 * @param {object[]} p.agents agent records
 * @param {Set<string>} p.adminIds
 * @param {(name:string)=>({parent?:string}|null)} [p.resolveVirtual]
 * @param {(name:string, agents:object[])=>boolean} p.isLead
 * @param {(to:string, from:string)=>Promise<boolean>|boolean} [p.consultAllowed]
 * @returns {Promise<{ok:true}|{ok:false,reason:string}>}
 */
async function decideTurnStart({ from, to, consultedBy = null, agents, adminIds, resolveVirtual, isLead, consultAllowed }) {
  const list = agents || [];
  const parentOf = (name) => { const v = resolveVirtual ? resolveVirtual(name) : null; return v && v.parent ? v.parent : name; };
  const target = parentOf(to);
  if (!list.some(a => a.name === target)) return { ok: false, reason: `no agent named "${to}"` };
  if (to === from) return { ok: true };
  if (!list.some(a => a.name === parentOf(from))) return { ok: false, reason: `agent "${from}" may not start turns of "${to}": it is not a known agent` };
  if (isLead(parentOf(from), list)) return { ok: true };
  if (access.sameOwner(from, target, list, { resolveVirtual, adminIds })) return { ok: true };
  if (consultedBy && to === consultedBy && consultAllowed && await consultAllowed(to, from)) return { ok: true };
  return { ok: false, reason: `agent "${from}" may not start turns of "${to}": only its own, those of agents with the same owner, or (for a lead agent) any` };
}

module.exports = { decideTurnStart };
