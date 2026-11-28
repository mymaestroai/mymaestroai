'use strict';
// A temporary worker (spawn_workers) works for its parent agent, so it carries what the owner granted that parent: the extra
// folders (policy.roots), the per-class decisions set on the agent card (policy.overrides) and the home-network switch
// (localNetwork). Never more than the parent:
// - the worker keeps the worker role, so nothing the parent has by its role (a head's or the lead's "ask" defaults, the lead's
//   own roots) carries over; only the parent's explicit grants do;
// - money (the wallet's) and admin (the hub's own data, .env and sign-in folders) are never inherited, nor anything from a
//   wallet agent; root grants and lead are keyed on the agent's own name and record, so a worker never has them;
// - the worker carries its parent's owner, so a member's agent's workers are bound by the member's caps (lib/tool-policy policyFor).
// A parent with no grants gives exactly the bare worker record it always had.

const INHERITED_CLASSES = ['read_outside', 'web', 'write_outside', 'send', 'destroy'];
const DECISIONS = new Set(['allow', 'ask', 'deny']);

/** The policy-gate record for temporary worker `name` whose parent agent record is `parent` (or null). */
function workerRecord(name, parent, { isWalletAgent = () => false } = {}) {
  if (!parent || typeof parent !== 'object') return { name, category: 'worker' };
  const rec = { name, category: 'worker', owner: parent.owner || null, virtualOf: parent.name };
  // A worker's commands run with its parent's hands (sdk-chat handsForTurn): in the parent's box, or on this computer when the
  // parent works outside one. The gate must judge the same place, so the parent's own box setting comes along (an unset one
  // follows the default for the same owner, as the parent's does).
  if (parent.sandbox === 'off' || parent.sandbox === 'container') rec.sandbox = parent.sandbox;
  let wallet = true;
  try { wallet = !!isWalletAgent(parent.name); } catch { wallet = true; }   // unsure: inherit nothing
  if (wallet) return rec;
  const pol = parent.policy && typeof parent.policy === 'object' ? parent.policy : {};
  const roots = Array.isArray(pol.roots) ? pol.roots.filter((r) => typeof r === 'string' && r.trim()).map(String) : [];
  const overrides = {};
  const ov = pol.overrides && typeof pol.overrides === 'object' ? pol.overrides : {};
  for (const k of INHERITED_CLASSES) if (DECISIONS.has(ov[k])) overrides[k] = ov[k];
  const policy = {};
  if (roots.length) policy.roots = roots;
  if (Object.keys(overrides).length) policy.overrides = overrides;
  if (Object.keys(policy).length) rec.policy = policy;
  if (parent.localNetwork === true) rec.localNetwork = true;
  return rec;
}

module.exports = { workerRecord, INHERITED_CLASSES };
