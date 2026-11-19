'use strict';
// The model offers service: which agents have a newer (or, for a challenger, a stronger) model to offer now.
// Pure reading and filtering: nothing here ever changes a model. Every dependency is injectable; a failing one gives no offers.
const { findOffers, safeId } = require('./model-offers');
const { createOffersStore } = require('./model-offers-store');

function keepOnBox() {
  try {
    const c = require('./settings').getSetting('autoClassifier', {});
    const k = c && c.keepOnBox;
    return Array.isArray(k) ? k : [];
  } catch { return []; }
}

function createModelOffers(deps = {}) {
  const d = {
    agents: async () => require('./agents').getAgents(),
    available: async () => require('./agents').availableModelsNow(),
    isLead: (name, list) => require('./agents').isLeadAgent(name, list),
    enabled: () => require('./settings').getSetting('modelOffers', true) !== false,
    store: null,
    isSensitive: (agent) => !!require('./tool-policy').teamFolderOf(agent) || keepOnBox().includes(agent.name),
    isVirtual: (name) => require('./temporal-workers').isVirtual(name),
    teamOfferNames: async (list, avail, leadModel) => {
      try {
        const st = require('./starter-team');
        return new Set(require('./team-offers').pendingOffers(st.readLedger(), list, new Date(), { available: avail, lead: leadModel }).map((o) => o.name));
      } catch { return new Set(); }
    },
    ...deps,
  };
  let defaultStore = null;
  const getStore = () => d.store || defaultStore || (defaultStore = createOffersStore());

  async function list() {
    try {
      if (!d.enabled()) return [];
      const agents = await d.agents();
      if (!Array.isArray(agents)) return [];
      let avail = [];
      try { const r = await d.available(); if (Array.isArray(r)) avail = r; } catch { avail = []; }
      let leadModel = '';
      for (const a of agents) {
        if (!a || typeof a.name !== 'string') continue;
        let is = false;
        try { is = !!(await Promise.resolve(d.isLead(a.name, agents))); } catch { is = false; }
        if (is) { leadModel = typeof a.model === 'string' ? a.model : ''; break; }
      }
      let teamNames = new Set();
      try { const s = await d.teamOfferNames(agents, avail, leadModel); if (s && typeof s.has === 'function') teamNames = s; } catch { teamNames = new Set(); }
      const safeCall = (fn, ...a) => { try { return !!fn(...a); } catch { return true; } };   // a failing check skips the agent
      const found = findOffers({
        agents,
        available: avail,
        lead: leadModel,
        declined: getStore().read().declined,
        isSensitive: (agent) => safeCall(d.isSensitive, agent),
        skip: (n) => safeCall(d.isVirtual, n) || teamNames.has(n),
        enabled: true,
      });
      return found
        .filter((o) => safeId(o.from) && safeId(o.to))
        .map((o) => ({ name: o.agent.name, display: o.agent.display || o.agent.name, from: o.from, to: o.to, kind: o.kind, why: o.why, route: o.route, cost: o.cost }));
    } catch { return []; }
  }

  async function offerFor(name) {
    try { return (await list()).find((o) => o.name === name) || null; } catch { return null; }
  }

  return {
    list,
    offerFor,
    decline: (name, model) => getStore().decline(name, model),
    forget: (name) => getStore().forget(name),
  };
}

let singleton = null;
function getModelOffers() {
  if (!singleton) singleton = createModelOffers();
  return singleton;
}

module.exports = { createModelOffers, getModelOffers };
