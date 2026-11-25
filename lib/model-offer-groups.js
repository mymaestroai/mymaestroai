'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { billingOf } = require('./billing');
const { safeId, familyOf } = require('./model-offers');

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ownerOf = agent => agent.owner == null ? '' : String(agent.owner);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const hash = /^[a-f0-9]{64}$/;

function sameRoute(row) {
  const before = billingOf(row.from), after = billingOf(row.to);
  return row.kind === 'newer' && safeId(row.from) && safeId(row.to) &&
    familyOf(row.from) === familyOf(row.to) && before.kind !== 'unknown' &&
    before.kind === after.kind && before.via === after.via && row.route === after.route;
}

function read(file) {
  let data;
  try { data = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { version: 1, groups: {}, done: {} };
    throw e;
  }
  const state = JSON.parse(data);
  if (state.version !== 1 || !plain(state.groups) || !plain(state.done) ||
      Object.entries(state.groups).some(([id, rows]) => !Array.isArray(rows) || digest(rows) !== id) ||
      Object.entries(state.done).some(([key, status]) => !hash.test(key) || !['switched', 'dismissed'].includes(status))) {
    throw new Error('Unreadable model offer groups');
  }
  return state;
}

function write(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + crypto.randomUUID();
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}

// Discovery returns fully qualified ids. The picker also removes non-chat models,
// but calling availableModelsNow would launch a refresh, even on a cache hit.
const subscriptions = ['claude-sdk', 'codex-cli'];

function freshCatalog(cache) {
  const age = Date.now() - Date.parse(cache?.discoveredAt);
  return age >= 0 && age < 6 * 60 * 60 * 1000;
}

function createInventory() {
  const accounts = require('./model-offer-accounts');
  let legacyCatalog, legacyAccounts;
  let snapshot = {};
  async function prepare(force = false) {
    const previous = snapshot;
    snapshot = {};
    const cache = require('./model-discovery').loadCache();
    if (!freshCatalog(cache)) return;
    if (cache.discoveredAt !== legacyCatalog) {
      legacyCatalog = cache.discoveredAt;
      legacyAccounts = {};
    }
    await Promise.all(subscriptions.map(async provider => {
      if (!cache[provider]?.length) return;
      const before = accounts.stamp(provider);
      const saved = previous[provider];
      if (!force && before && saved?.catalog === cache.discoveredAt && saved.before === before) {
        snapshot[provider] = saved;
        return;
      }
      const current = await accounts.account(provider);
      if (!current || before !== accounts.stamp(provider)) return;
      if (!cache.offerAccounts && !legacyAccounts[provider]) {
        // Older catalogs have no account digest. Bootstrap only when the
        // local sign-in has not been rewritten since discovery.
        if (!before || Number(before.split(':')[0]) > Date.parse(cache.discoveredAt) + 1) return;
        legacyAccounts[provider] = current;
      }
      if (current === (cache.offerAccounts || legacyAccounts)[provider]) {
        snapshot[provider] = { before, catalog: cache.discoveredAt };
      }
    }));
  }
  return { prepare, models: () => cachedOfferModels((provider, catalog) => {
    const entry = snapshot[provider];
    return entry?.catalog === catalog && entry.before === accounts.stamp(provider);
  }) };
}

function cachedOfferModels(subscriptionConnected = () => false) {
  const discovery = require('./model-discovery');
  const cache = discovery.loadCache();
  if (!freshCatalog(cache)) return [];
  const warm = require('./gateway-client').cachedModels();
  const settings = require('./settings');
  const routes = new Map();
  function connected(provider) {
    if (subscriptions.includes(provider)) return subscriptionConnected(provider, cache.discoveredAt);
    if (billingOf(provider + '/x').kind === 'local') return true;
    return !!settings.getProviderKey(provider);
  }
  return discovery.getDiscoveredModels(cache).filter(id => {
    if (!safeId(id) || !require('./agents').isChatModel(id) || (warm && !warm.includes(id))) return false;
    const provider = id.split('/')[0];
    if (!routes.has(provider)) routes.set(provider, connected(provider));
    return routes.get(provider) && (provider !== 'openrouter' ||
      require('./openrouter').getOpenRouter().chosen().includes(id.slice(provider.length + 1)));
  });
}

function createModelOfferGroups(deps = {}) {
  const registry = () => require('./agents');
  const file = deps.file || path.join(__dirname, '..', 'data', 'model-offer-groups.json');
  const declines = deps.store || require('./model-offers-store').createOffersStore({
    file: path.join(path.dirname(file), 'model-offers.json'),
  });
  const inventory = deps.offers || deps.inventory ? null : createInventory();
  let defaultOffers;
  const d = {
    file,
    offers: () => defaultOffers || (defaultOffers = require('./model-offers-service').createModelOffers({
      agents: () => d.records(),
      available: () => d.inventory(),
      enabled: () => d.enabled(),
      store: declines,
    })),
    inventory: inventory?.models,
    records: () => registry().readAgentsFileStrict(),
    stamp: agent => registry().stampOf(agent),
    ownerAllowed: agent => !ownerOf(agent) || require('./auth').getAuth().isOwner({ id: ownerOf(agent) }),
    enabled: () => require('./settings').getSetting('modelOffers', true) === true &&
      !require('./starter-team').readLedger().unreadable,
    setModel: (...args) => registry().setAgentModel(...args),
    ...deps,
  };

  // The running hub owns these files. Serialize discovery and answers through the same
  // singleton, including across awaits during inventory refresh and individual writes.
  let tail = Promise.resolve();
  function serialize(work) {
    const next = tail.then(work);
    tail = next.catch(() => {});
    return next;
  }

  async function scan() {
    if (d.enabled() !== true) return [];
    const offers = await d.offers().list();
    const records = new Map(d.records().map(a => [a.name, a]));
    const rows = new Map();
    for (const o of offers) {
      const a = records.get(o.name);
      if (!a || a.model !== o.from || a.modelPinned || d.ownerAllowed(a) !== true || !sameRoute(o)) continue;
      const stamp = d.stamp(a);
      if (typeof stamp !== 'string' || !stamp) continue;
      rows.set(o.name, { name: o.name, from: o.from, to: o.to, route: o.route, cost: o.cost, owner: ownerOf(a), stamp });
    }
    return [...rows.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }

  async function list() {
    try {
      const state = read(d.file), targets = new Map();
      if (d.enabled() !== true) return [];
      await inventory?.prepare();
      for (const row of await scan()) {
        if (state.done[digest(row)]) continue;
        if (!targets.has(row.to)) targets.set(row.to, []);
        targets.get(row.to).push(row);
      }
      let dirty = false;
      const groups = [];
      for (const rows of targets.values()) {
        const id = digest(rows);
        if (!state.groups[id]) { state.groups[id] = rows; dirty = true; }
        groups.push({ id, rows: rows.map(({ owner, stamp, ...row }) => row) });
      }
      if (dirty) write(d.file, state);
      return groups;
    } catch { return []; }
  }

  async function answer(id, action, { stillAllowed, isBusy } = {}) {
    const allowed = () => typeof stillAllowed === 'function' && stillAllowed() === true;
    if (!allowed()) throw new Error('Owner authorization required');
    if (!['apply', 'dismiss'].includes(action)) throw new Error('Unknown model offer action');
    const state = read(d.file);
    if (typeof id !== 'string' || !hash.test(id) || !state.groups[id]) throw new Error('Unknown model offer group');
    if (d.enabled() === true) await inventory?.prepare(true);
    const results = [];
    for (const row of state.groups[id]) {
      const key = digest(row);
      let status = state.done[key];
      if (!allowed()) throw new Error('Owner authorization required');
      if (!status) {
        try {
          const token = digest([id, key]);
          const recovered = d.records().some(a => a.name === row.name && a.modelOfferApproval === token);
          const current = recovered ? null : (await scan()).find(r => r.name === row.name);
          const check = (a, stamp) => {
            if (!allowed() || d.enabled() !== true) return 'failed';
            if (!a || stamp !== row.stamp || a.model !== row.from || a.modelPinned ||
                ownerOf(a) !== row.owner || d.ownerAllowed(a) !== true) return 'changed';
            if (d.inventory && !d.inventory().includes(row.to)) return 'changed';
            const saved = declines.read();
            if (!saved || saved.unreadable) return 'failed';
            if (saved.declined[row.name]?.includes(row.to)) return 'changed';
            if (action === 'apply') {
              const busy = isBusy(a.name);
              if (busy !== false) return busy === true ? 'busy' : 'failed';
            }
            return null;
          };
          if (recovered) status = 'switched';
          else if (!current || digest(current) !== key) status = 'changed';
          else if (action === 'dismiss') {
            const a = d.records().find(rec => rec.name === row.name);
            status = check(a, a && d.stamp(a)) || (d.offers().decline(row.name, row.to).ok === true ? 'dismissed' : 'failed');
          } else {
            const result = await d.setModel(row.name, row.to, check, token);
            status = result.success === true ? 'switched' : ['busy', 'changed'].includes(result.status) ? result.status : 'failed';
          }
        } catch { status = 'failed'; }
        if (status === 'switched' || status === 'dismissed') {
          state.done[key] = status;
          write(d.file, state);
        }
      }
      results.push({ name: row.name, status });
    }
    return { results };
  }

  return { list: () => serialize(list), answer: (...args) => serialize(() => answer(...args)) };
}

let singleton;
function getModelOfferGroups() { return singleton || (singleton = createModelOfferGroups()); }

module.exports = { createInventory, createModelOfferGroups, getModelOfferGroups, cachedOfferModels };
