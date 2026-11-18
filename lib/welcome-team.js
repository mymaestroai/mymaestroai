'use strict';
// The starter team on the Welcome page: what the three /api/welcome/team routes do, kept here so they run (and are tested)
// without the server. The routes in server.js only check that the caller is an admin (lib/access classifies them) and pass
// the request body in. Each function returns { status, body }.
const MODEL_ID = /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9._:\/\[\]-]+$/;

/** The model ids a request offers: an array of at most 300 strings, each at most 200 characters in the shape of a model
 *  id. Anything else is dropped, not an error. Deduplicated. */
function validModels(models) {
  if (!Array.isArray(models) || models.length > 300) return [];
  const out = [];
  for (const m of models) if (typeof m === 'string' && m.length <= 200 && MODEL_ID.test(m) && !out.includes(m)) out.push(m);
  return out;
}

const realDeps = () => ({
  getAgents: (fresh) => require('./agents').getAgents(fresh),
  getAvailableModels: () => require('./agents').getAvailableModels(),
  team: require('./starter-team'),
});

/** The union of the hub's own model list (a failure counts as empty) and the models the page reports. */
async function availableModels(extra, deps = realDeps()) {
  let own = [];
  try { const r = await deps.getAvailableModels(); if (Array.isArray(r)) own = r.filter((m) => typeof m === 'string'); } catch { own = []; }
  return [...new Set([...own, ...validModels(extra)])];
}

/** The lead's model: for a preview (GET) the model the page is about to choose, when it is shaped like a model id; for a
 *  create always the lead agent's own model as stored (the page sets it just before), never one the request names. */
async function leadModel(requested, deps) {
  if (typeof requested === 'string' && requested.length <= 200 && MODEL_ID.test(requested)) return requested;
  const agents = await deps.getAgents();
  const lead = agents.find((a) => a && a.name === 'maestro') || agents[0] || null;
  return lead ? lead.model : undefined;
}

/** GET /api/welcome/team?lead=<model id> */
async function plan({ lead } = {}, deps = realDeps()) {
  const agents = await deps.getAgents(true);
  const ledger = deps.team.readLedger();
  const available = await availableModels(null, deps);
  const entries = deps.team.planTeam({ agents, available, lead: await leadModel(lead, deps), ledger });
  return { status: 200, body: { ok: true, plan: entries, ...(ledger.skippedAt ? { skippedAt: ledger.skippedAt } : {}) } };
}

/** The one log line per create: created challenger (codex-cli/...), scout (...); skipped builder: name taken */
function logLine(r) {
  const made = (r.created || []).map((e) => `${e.name} (${e.model})`);
  const left = (r.skipped || []).filter((e) => e.reason !== 'created before').map((e) => `${e.name}: ${e.reason}`);
  return `[team] created ${made.length ? made.join(', ') : 'nothing'}${left.length ? `; skipped ${left.join(', ')}` : ''}`;
}

/** POST /api/welcome/team  { lead?, models? } */
async function create(body, deps = realDeps(), log = (l) => console.log(l)) {
  const b = body && typeof body === 'object' ? body : {};
  const available = await availableModels(b.models, deps);
  const r = await deps.team.createTeam({ available, lead: await leadModel(null, deps) });
  try { log(logLine(r)); } catch { /* logging never fails the request */ }
  return { status: 200, body: { ok: true, created: r.created, skipped: r.skipped } };
}

/** POST /api/welcome/team/skip */
async function skip(deps = realDeps()) {
  try { await deps.team.markSkipped(); }
  catch (e) { return { status: 409, body: { ok: false, error: e && e.message ? e.message : String(e) } }; }
  return { status: 200, body: { ok: true } };
}

module.exports = { validModels, availableModels, plan, create, skip, logLine };
