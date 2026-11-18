'use strict';
// The "Set up your team" card for installs that existed before the starter team: what GET /api/team/card and
// POST /api/team/card/answer do, kept here so they run (and are tested) without the server. The routes in server.js only
// pass the request in; lib/access classifies /api/team/... as admin. Each function returns { status, body }.
// Creating from the card uses POST /api/welcome/team with `expect` (lib/welcome-team); nothing here creates an agent.

const realDeps = () => ({
  getAgents: (fresh) => require('./agents').getAgents(fresh),
  getAvailableModels: () => require('./agents').getAvailableModels(),
  team: require('./starter-team'),
  welcomeUnfinished: () => require('./welcome').getWelcome().unfinished(),
});

/** GET /api/team/card?again=1 -> { ok, show, plan, reason }. `again`: the person asked to see it again (/?team=setup). */
async function cardState({ again = false } = {}, deps = realDeps()) {
  const agents = await deps.getAgents(true);
  const ledger = deps.team.readLedger();
  // The same lead lookup and model list as the Welcome team (lib/welcome-team); no model list from a page.
  const list = Array.isArray(agents) ? agents : [];
  const leadAgent = list.find((a) => a && a.name === 'maestro') || list[0] || null;
  const available = await require('./welcome-team').availableModels(undefined, deps);
  const plan = deps.team.planTeam({ agents: list, available, lead: leadAgent ? leadAgent.model : undefined, ledger });
  const no = (reason) => ({ status: 200, body: { ok: true, show: false, plan, reason } });
  if (ledger.unreadable) return no('unreadable');
  if (!again && Object.keys(ledger.roles || {}).length) return no('set up');
  if (!again && (ledger.cardAnsweredAt || ledger.skippedAt)) return no('answered');
  let unfinished = false;
  try { unfinished = !!deps.welcomeUnfinished(); } catch { unfinished = false; }
  if (unfinished) return no('welcome');
  if (!plan.some((e) => e.action === 'create')) return no('nothing to create');
  return { status: 200, body: { ok: true, show: true, plan, reason: null } };
}

/** POST /api/team/card/answer { answer: 'later' } -> records cardAnsweredAt. */
async function answerCard({ answer } = {}, deps = realDeps()) {
  if (answer !== 'later') return { status: 400, body: { ok: false, error: 'answer must be "later"' } };
  try { await deps.team.markCardAnswered(); }
  catch (e) { return { status: 409, body: { ok: false, error: e && e.message ? e.message : String(e) } }; }
  return { status: 200, body: { ok: true } };
}

module.exports = { cardState, answerCard };
