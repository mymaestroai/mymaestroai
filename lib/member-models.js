'use strict';
/**
 * member-models.js — the one rule for which models a member may use: the admin's list, settings.memberModels.
 *
 * Used by POST /api/agents/<name>/model (a member moving their own agent to another model) and by spawn_workers (the
 * models a member-owned agent's temporary workers may run on: its own model plus the same list). Empty or unset means a
 * member may choose none: their agents keep the model an admin gave them, and their temporary workers run on that model.
 */

function list(getSetting = (k) => require('./settings').getSetting(k)) {
  let v = null;
  try { v = getSetting('memberModels'); } catch { v = null; }
  return Array.isArray(v) ? v.filter((m) => typeof m === 'string' && m) : [];
}

/** True when a member may move one of their agents to `model`. */
function memberMayUse(model, getSetting) {
  return list(getSetting).includes(String(model || ''));
}

/** The models a member-owned agent's temporary workers may run on: its own model, then the admin's list. */
function workerModels(ownModel, getSetting) {
  const out = [];
  if (typeof ownModel === 'string' && ownModel) out.push(ownModel);
  for (const m of list(getSetting)) if (!out.includes(m)) out.push(m);
  return out;
}

module.exports = { list, memberMayUse, workerModels };
