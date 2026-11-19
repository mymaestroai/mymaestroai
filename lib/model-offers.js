'use strict';
// Model offers for existing agents: a newer version of the same model, or (for a challenger) a stronger model from
// another vendor. Pure: no file, network or settings access. Nothing here ever changes a model; the caller shows the
// offers and the owner decides.
const { billingOf } = require('./billing');
const { vendorOf, usable, tierOf, score } = require('./model-tiers');

const MODEL_ID = /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9._:\/\[\]-]{1,200}$/;   // same shape as lib/team-offers.js
const STRENGTH = { top: 3, mid: 2, fast: 1 };

const safeId = (id) => typeof id === 'string' && MODEL_ID.test(id);
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const kindOf = (id) => billingOf(id).kind;
const prefixOf = (id) => String(id).split('/')[0].toLowerCase();
const strengthOf = (id) => STRENGTH[tierOf(id)] || 0;   // 0 for null and 'local'

/** The model "family": provider prefix and name with version numbers, dates and snapshot stamps removed. '' = unknown. */
function familyOf(id) {
  if (typeof id !== 'string') return '';
  const i = id.indexOf('/');
  if (i < 1) return '';
  const prefix = id.slice(0, i).toLowerCase();
  let name = id.slice(i + 1).toLowerCase();
  let suffix = '';
  const br = name.match(/\[[^\]]*\]$/);
  if (br) { suffix = br[0]; name = name.slice(0, br.index); }
  // The same removals as versionScore (lib/welcome): full dates first, then 8-digit stamps, month-year and 4-digit stamps.
  name = name.replace(/-?\d{4}-\d{2}-\d{2}/g, '').replace(/\d{8}/g, '').replace(/-\d{1,2}-\d{4}\b/g, '').replace(/-\d{4}\b/g, '');
  const tokens = name.split('-').filter((t) => t && !/^\d+(\.\d+)?$/.test(t));
  if (!tokens.length) return '';
  return `${prefix}/${tokens.join('-')}${suffix}`;
}

function costOf(from, to) {
  const a = kindOf(from), b = kindOf(to);
  if (a === 'subscription' && b === 'subscription') return prefixOf(from) === prefixOf(to) ? 'same subscription' : `on the ${billingOf(to).via} subscription`;
  if (a === 'api' && b === 'subscription') return 'on a subscription instead of billed per use';
  if (b === 'api') return 'billed per use';
  if (b === 'local') return 'runs on this machine, free';
  return '';
}

function cleanList(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  // Only ids of the safe shape: every list built from these reaches a prompt (the brief, spawn_workers) (review r1, Sonnet).
  for (const m of list) if (safeId(m) && !out.includes(m)) out.push(m);
  return out;
}

function newerFor(from, avail) {
  const fam = familyOf(from);
  const s = score(from), t = tierOf(from);
  if (!fam || !(s > 0) || t == null) return null;
  const c = avail.filter((x) => familyOf(x) === fam && usable(x) && score(x) > s && tierOf(x) === t);
  c.sort((a, b) => (score(b) - score(a)) || byId(a, b));
  return c[0] || null;
}

function strongerFor(from, avail, lead) {
  const fk = kindOf(from);
  if (fk !== 'subscription' && fk !== 'api') return null;
  const fs = strengthOf(from);
  if (!fs) return null;
  const notVendor = lead ? vendorOf(lead) : vendorOf(from);
  const c = avail.filter((x) => {
    if (!usable(x) || vendorOf(x) === notVendor) return false;
    const k = kindOf(x);
    if (k !== 'subscription' && !(fk === 'api' && k === 'api')) return false;
    return strengthOf(x) > fs;
  });
  const sub = (x) => (kindOf(x) === 'subscription' ? 1 : 0);
  c.sort((a, b) => (strengthOf(b) - strengthOf(a)) || (sub(b) - sub(a)) || (score(b) - score(a)) || byId(a, b));
  return c[0] || null;
}

function findOffers({ agents, available, lead, declined, isSensitive, skip, enabled } = {}) {
  if (enabled === false || !Array.isArray(agents)) return [];
  const avail = cleanList(available);
  const leadId = typeof lead === 'string' ? lead : '';
  const dec = declined && typeof declined === 'object' && !Array.isArray(declined) ? declined : {};
  const declinedOf = (name) => (Object.prototype.hasOwnProperty.call(dec, name) && Array.isArray(dec[name]) ? dec[name] : []);
  const sensitive = typeof isSensitive === 'function' ? isSensitive : () => false;
  const skipFn = typeof skip === 'function' ? skip : () => false;
  const out = [];
  for (const agent of agents) {
    if (!agent || typeof agent !== 'object' || typeof agent.name !== 'string' || typeof agent.model !== 'string' || !agent.name || !agent.model) continue;
    const from = agent.model;
    if (skipFn(agent.name) || agent.modelPinned === true || !usable(from)) continue;
    let to = newerFor(from, avail), kind = 'newer', why = 'a newer version of the same model';
    if (!to && agent.teamRole === 'challenger' && !sensitive(agent)) {
      to = strongerFor(from, avail, leadId);
      kind = 'stronger'; why = 'a stronger model from another vendor, for a real second opinion';
    }
    if (!to || to === from) continue;
    if (declinedOf(agent.name).includes(to)) continue;
    out.push({ agent, from, to, kind, why, route: billingOf(to).route, cost: costOf(from, to) });
  }
  return out;
}

/** [{ family, id }]: the newest usable model of every family with a known version, sorted by id. */
function newestPerFamily(available) {
  const best = new Map();
  for (const id of cleanList(available)) {
    if (!usable(id) || !(score(id) > 0)) continue;
    const fam = familyOf(id);
    if (!fam) continue;
    const cur = best.get(fam);
    if (!cur || score(id) > score(cur) || (score(id) === score(cur) && id < cur)) best.set(fam, id);
  }
  return [...best].map(([family, id]) => ({ family, id })).sort((a, b) => byId(a.id, b.id));
}

/** The strongest usable model not from `vendor`, on a subscription or an API key: tier, subscription first, newest, id. */
function strongestOtherVendor(available, vendor) {
  const sub = (x) => (kindOf(x) === 'subscription' ? 1 : 0);
  const c = cleanList(available).filter((x) => usable(x) && vendorOf(x) !== vendor && ['subscription', 'api'].includes(kindOf(x)) && strengthOf(x) > 0);
  c.sort((a, b) => (strengthOf(b) - strengthOf(a)) || (sub(b) - sub(a)) || (score(b) - score(a)) || byId(a, b));
  return c[0] || null;
}

/** [{ vendor, id, route }]: for each vendor, its strongest usable model on a subscription or an API key (known non-local tier),
 *  by tier, subscription before api, score, id; sorted by vendor name. */
function strongestPerVendor(available) {
  const sub = (x) => (kindOf(x) === 'subscription' ? 1 : 0);
  const best = new Map();
  const better = (a, b) => ((strengthOf(a) - strengthOf(b)) || (sub(a) - sub(b)) || (score(a) - score(b)) || (byId(b, a))) > 0;
  for (const id of cleanList(available)) {
    if (!usable(id) || !['subscription', 'api'].includes(kindOf(id)) || strengthOf(id) <= 0) continue;
    const v = String(vendorOf(id) || '').replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 40);   // the vendor is printed too
    if (!v) continue;
    const cur = best.get(v);
    if (!cur || better(id, cur)) best.set(v, id);
  }
  return [...best].map(([vendor, id]) => ({ vendor, id, route: billingOf(id).route })).sort((a, b) => byId(a.vendor, b.vendor));
}

module.exports = { familyOf, findOffers, newestPerFamily, strongestOtherVendor, strongestPerVendor, MODEL_ID, safeId };
