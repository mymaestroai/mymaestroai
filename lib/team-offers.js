'use strict';
// Later model offers for the starter team: when the models this install can reach change (a new provider, a subscription
// where there was an API key), a starter agent the hub itself placed (teamModelBy 'hub') may have a better pick now. The
// lead's brief (lib/hub-map) mentions it once; the owner changes the model on the agent's settings page. Nothing here
// ever changes a model. computeOffers and pendingOffers are pure; the ledger is written by starter-team.recordOffers.
const { billingOf } = require('./billing');

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TIER_COST = { top: 3, mid: 2, fast: 1, local: 0 };   // unknown (null) is not in the table: never cheaper

const perUse = (model) => billingOf(model).kind === 'api';
// The reasons an offer gives: the only texts that reach the lead's prompt from the ledger (anything else reads as the last).
const WHY = ['from a different vendor', 'on a subscription instead of billed per use', 'a cheaper model of the same kind', 'a better fit now'];
const MODEL_ID = /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9._:\/\[\]-]{1,200}$/;   // only ids of this shape are written into a prompt
/** True when `model` was offered for the role before (the current offer or any earlier one). */
function offeredBefore(rec, model) {
  if (!rec || typeof rec !== 'object') return false;
  if (rec.model === model) return true;
  return Array.isArray(rec.seen) && rec.seen.includes(model);
}

function cheaper(next, current) {
  const t = require('./model-tiers');
  const a = TIER_COST[t.tierOf(next)], b = TIER_COST[t.tierOf(current)];
  return a !== undefined && b !== undefined && a < b;
}

/** [{ role, name, display, from, to, why }] for the starter agents a better model can now be offered for. */
function computeOffers({ agents, available, lead, ledger } = {}) {
  const { pickTeam, vendorOf } = require('./model-tiers');
  const { ROLES } = require('./starter-team');
  const roles = (ledger && ledger.roles) || {};
  const offered = (ledger && ledger.offers) || {};
  const list = Array.isArray(agents) ? agents : [];
  const picks = pickTeam({ available, lead });
  const out = [];
  for (const r of ROLES) {
    const had = roles[r.role];
    if (!had || had.status !== 'created') continue;
    const agent = list.find((a) => a && a.name === had.name);
    if (!agent || agent.teamModelBy !== 'hub') continue;
    const to = picks[r.role] && picks[r.role].model;
    const from = agent.model;
    if (!to || to === from) continue;
    if (offeredBefore(offered[r.role], to)) continue;
    let why = null;
    if (r.teamRole === 'challenger') {
      const leadVendor = vendorOf(lead);
      if (lead && vendorOf(to) !== leadVendor && vendorOf(from) === leadVendor) why = 'from a different vendor';
      else if (perUse(from) && !perUse(to)) why = 'on a subscription instead of billed per use';
    } else if (perUse(from) && !perUse(to)) why = 'on a subscription instead of billed per use';
    else if (cheaper(to, from)) why = 'a cheaper model of the same kind';
    if (why) out.push({ role: r.role, name: had.name, display: r.display, from, to, why });
  }
  return out;
}

/** The offers recorded less than 7 days ago whose agent is still on the hub's pick and not on the offered model, and whose
 *  offered model is still reachable and still the pick now (`available`, `lead`): an offer whose provider went away is not
 *  shown (it stays recorded, so reconnecting does not offer it again). */
function pendingOffers(ledger, agents, now = new Date(), { available = null, lead = null } = {}) {
  const { ROLES } = require('./starter-team');
  const offers = (ledger && ledger.offers) || {};
  const roles = (ledger && ledger.roles) || {};
  const list = Array.isArray(agents) ? agents : [];
  const t = (now instanceof Date ? now : new Date(now)).getTime();
  const out = [];
  for (const r of ROLES) {
    const o = offers[r.role], had = roles[r.role];
    if (!o || typeof o.model !== 'string' || !had) continue;
    const since = Date.parse(o.since);
    if (!Number.isFinite(since) || t - since >= WINDOW_MS || t < since) continue;
    const agent = list.find((a) => a && a.name === had.name);
    if (!agent || agent.teamModelBy !== 'hub' || agent.model === o.model) continue;
    if (!MODEL_ID.test(o.model) || !MODEL_ID.test(String(agent.model || ''))) continue;
    if (Array.isArray(available)) {
      if (!available.includes(o.model)) continue;
      const pick = require('./model-tiers').pickTeam({ available, lead })[r.role];
      if (!pick || pick.model !== o.model) continue;
    }
    out.push({ role: r.role, name: had.name, display: r.display, from: agent.model, to: o.model, why: WHY.includes(o.why) ? o.why : 'a better fit now' });
  }
  return out;
}

module.exports = { computeOffers, pendingOffers, offeredBefore, WINDOW_MS, WHY };
