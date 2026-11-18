'use strict';
// Later model offers for the starter team: when the models this install can reach change (a new provider, a subscription
// where there was an API key), a starter agent the hub itself placed (teamModelBy 'hub') may have a better pick now. The
// lead's brief (lib/hub-map) mentions it once; the owner changes the model on the agent's settings page. Nothing here
// ever changes a model. computeOffers and pendingOffers are pure; the ledger is written by starter-team.recordOffers.
const { billingOf } = require('./billing');

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TIER_COST = { top: 3, mid: 2, fast: 1, local: 0 };   // unknown (null) is not in the table: never cheaper

const perUse = (model) => billingOf(model).kind === 'api';

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
    if (offered[r.role] && offered[r.role].model === to) continue;
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

/** The offers recorded less than 7 days ago whose agent is still on the hub's pick and not on the offered model. */
function pendingOffers(ledger, agents, now = new Date()) {
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
    out.push({ role: r.role, name: had.name, display: r.display, from: agent.model, to: o.model, why: typeof o.why === 'string' && o.why ? o.why : 'a better fit now' });
  }
  return out;
}

module.exports = { computeOffers, pendingOffers, WINDOW_MS };
