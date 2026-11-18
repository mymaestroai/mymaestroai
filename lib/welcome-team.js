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

/** Provider prefixes of the ways the Welcome page reports as connected (lib/welcome providerSummary). */
const LOCAL_PREFIXES = ['local', 'lmstudio', 'ollama', 'omlx', 'ninfer'];
function connectedPrefixes(summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const out = [];
  if (s.claude) out.push('claude-sdk');
  if (s.chatgpt) out.push('codex-cli');
  for (const p of ['anthropic', 'openai', 'google', 'openrouter']) if (s[p]) out.push(p);
  if (s.local) out.push(...LOCAL_PREFIXES);
  return out;
}

const realDeps = () => ({
  getAgents: (fresh) => require('./agents').getAgents(fresh),
  getAvailableModels: () => require('./agents').getAvailableModels(),
  providerSummary: () => require('./welcome').getWelcome().providerSummary(),
  team: require('./starter-team'),
});

/** The union of the hub's own model list (a failure counts as empty) and the models the page reports, the latter only
 *  for providers this hub has connected (a model of a provider it can't reach is never assigned). The preview and the
 *  create both use this, with the same page list, so the team shown is the team made. */
async function availableModels(extra, deps = realDeps()) {
  let own = [];
  try { const r = await deps.getAvailableModels(); if (Array.isArray(r)) own = r.filter((m) => typeof m === 'string'); } catch { own = []; }
  let prefixes = [];
  try { prefixes = connectedPrefixes(deps.providerSummary ? deps.providerSummary() : {}); } catch { prefixes = []; }
  const reported = validModels(extra).filter((m) => prefixes.includes(m.split('/')[0]));
  return [...new Set([...own, ...reported])];
}

/** The lead's model: for a preview (GET) the model the page is about to choose, when it is shaped like a model id; for a
 *  create always the lead agent's own model as stored (the page sets it just before), never one the request names. */
async function leadModel(requested, deps) {
  if (typeof requested === 'string' && requested.length <= 200 && MODEL_ID.test(requested)) return requested;
  const agents = await deps.getAgents();
  const lead = agents.find((a) => a && a.name === 'maestro') || agents[0] || null;
  return lead ? lead.model : undefined;
}

/** GET /api/welcome/team?lead=<model id>, or POST /api/welcome/team/plan { lead, models } (the page: with the models its
 *  provider check reported, the same list it sends with the create). */
async function plan({ lead, models } = {}, deps = realDeps()) {
  const agents = await deps.getAgents(true);
  const ledger = deps.team.readLedger();
  const available = await availableModels(models, deps);
  const entries = deps.team.planTeam({ agents, available, lead: await leadModel(lead, deps), ledger });
  return { status: 200, body: { ok: true, plan: entries, ...(ledger.skippedAt ? { skippedAt: ledger.skippedAt } : {}) } };
}

/** The one log line per create: created challenger (codex-cli/...), scout (...); skipped builder: name taken */
function logLine(r) {
  const made = (r.created || []).map((e) => `${e.name} (${e.model})`);
  const left = (r.skipped || []).filter((e) => e.reason !== 'created before').map((e) => `${e.name}: ${e.reason}`);
  return `[team] created ${made.length ? made.join(', ') : 'nothing'}${left.length ? `; skipped ${left.join(', ')}` : ''}`;
}

/** The roles and models the page showed as "to create": [{ role, model }], or null when the body has none. */
function expected(list) {
  if (!Array.isArray(list) || list.length > 10) return null;
  const out = [];
  for (const x of list) if (x && typeof x.role === 'string' && typeof x.model === 'string') out.push({ role: x.role, model: x.model });
  return out;
}

/** POST /api/welcome/team  { models?, expect? }. With `expect` (what the page showed), nothing is created when the plan
 *  now differs: 409 with the new plan, which the page shows for a new look. */
async function create(body, deps = realDeps(), log = (l) => console.log(l)) {
  const b = body && typeof body === 'object' ? body : {};
  const available = await availableModels(b.models, deps);
  const r = await deps.team.createTeam({ available, lead: await leadModel(null, deps), expect: expected(b.expect) });
  if (r.changed) return { status: 409, body: { ok: false, changed: true, plan: r.plan, error: 'The team changed since it was shown' } };
  try { log(logLine(r)); } catch { /* logging never fails the request */ }
  return { status: 200, body: { ok: true, created: r.created, skipped: r.skipped } };
}

/** POST /api/welcome/team/skip */
async function skip(deps = realDeps()) {
  try { await deps.team.markSkipped(); }
  catch (e) { return { status: 409, body: { ok: false, error: e && e.message ? e.message : String(e) } }; }
  return { status: 200, body: { ok: true } };
}

module.exports = { validModels, connectedPrefixes, availableModels, plan, create, skip, logLine };
