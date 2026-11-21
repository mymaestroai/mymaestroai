'use strict';
/**
 * Which model each starter agent gets. Pure: no file, network or settings access. The caller passes the model ids this
 * install can reach and the lead agent's model; the answer is the four starter roles (challenger, scout, builder,
 * researcher), each with the model, its vendor, how it is paid and a plain note when something is not ideal.
 *
 * Workers (scout, builder, researcher) stay on the ways this install already pays: the lead's own subscription or local
 * route first, other subscriptions next, local models after that, and an API key only when nothing else is reachable.
 * The challenger is the strongest model from another vendor, whatever the route, so the second opinion is a real one.
 */
const { billingOf } = require('./billing');
const { versionScore } = require('./welcome');

const LOCAL_PREFIXES = ['local', 'lmstudio', 'ollama', 'omlx', 'ninfer'];
// Not chat models with tools. Matched on the model name only. "instruct" is excluded only for OpenAI's API, where it
// names old completion models; local and other models called "...-instruct" are ordinary chat models.
const NOT_USABLE_RE = /(embed|audio|realtime|transcribe|tts|image|search|moderation|whisper|dall-e)/i;
const SAME_VENDOR_NOTE = 'Same vendor as the lead: a second opinion, not an outside view. Connect another provider to give it one.';
const LOCAL_CHALLENGER_NOTE = 'Runs on the same local model as the lead: a second opinion from the same model, not an outside view.';
const NO_CHEAPER_NOTE = 'No model of the usual tier is known on the ways this install pays, so it uses the closest one there is.';
const NONE_NOTE = 'No model below the top tier is reachable on the ways this install pays, so this agent is not created. Add it later with a model of your choice.';
const NO_FAST_NOTE = 'No fast model found; it uses a mid-tier one.';
const PER_USE_NOTE = 'Billed per use through an API key.';

function prefixOf(id) {
  const m = String(id || '');
  return m.includes('/') ? m.split('/')[0].toLowerCase() : '';
}

/** The segments of an id: provider prefix, the vendor segment (openrouter only) and the model name. */
function parts(id) {
  const m = String(id || '');
  const prefix = prefixOf(m);
  const rest = m.includes('/') ? m.slice(m.indexOf('/') + 1) : m;
  if (prefix === 'openrouter') {
    const i = rest.indexOf('/');
    return i < 0 ? { prefix, vendorSeg: '', name: rest } : { prefix, vendorSeg: rest.slice(0, i).toLowerCase(), name: rest.slice(i + 1) };
  }
  return { prefix, vendorSeg: '', name: rest };
}

const SEGMENT_VENDORS = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google' };

/** The company behind a model id: Anthropic, OpenAI, Google, Local, or the vendor/prefix as written. */
function vendorOf(id) {
  const { prefix, vendorSeg } = parts(id);
  if (prefix === 'claude-sdk' || prefix === 'anthropic') return 'Anthropic';
  if (prefix === 'codex-cli' || prefix === 'openai') return 'OpenAI';
  if (prefix === 'google') return 'Google';
  if (LOCAL_PREFIXES.includes(prefix)) return 'Local';
  if (prefix === 'openrouter') return SEGMENT_VENDORS[vendorSeg] || vendorSeg || 'openrouter';
  return prefix || 'Other';
}

/** False for ids the starter pick must never use: text-only codex/, perplexity/, and non-chat model kinds. */
function usable(id) {
  const m = String(id || '');
  if (!m) return false;
  const prefix = prefixOf(m);
  if (prefix === 'codex' || prefix === 'perplexity') return false;
  if (prefix === 'openrouter' && !parts(m).vendorSeg) return false;   // openrouter/auto and the like: no fixed model
  const name = parts(m).name;
  if (NOT_USABLE_RE.test(name)) return false;
  if ((prefix === 'openai' || (prefix === 'openrouter' && parts(m).vendorSeg === 'openai')) && /instruct/i.test(name)) return false;
  return true;
}

/** 'fast' | 'mid' | 'top' | 'local' | null (unknown), from the model name. */
function tierOf(id) {
  const vendor = vendorOf(id);
  const name = parts(id).name.toLowerCase();
  if (vendor === 'Local') return 'local';
  if (vendor === 'Anthropic') {
    if (/haiku/.test(name)) return 'fast';
    if (/sonnet/.test(name)) return 'mid';
    if (/(opus|fable|mythos)/.test(name)) return 'top';
    return null;
  }
  if (vendor === 'OpenAI') {
    if (/(nano|mini)/.test(name)) return 'fast';
    if (/-pro(-\d{4}-\d{2}-\d{2})?$/.test(name) || /^o[134](-|$)/.test(name)) return 'top';
    if (/^gpt-\d/.test(name)) return 'mid';
    return null;
  }
  if (vendor === 'Google') {
    if (/flash-lite/.test(name)) return 'fast';
    if (/flash/.test(name)) return 'mid';
    if (/pro/.test(name)) return 'top';
    return null;
  }
  return /(mini|flash|lite|small|haiku|nano)/.test(name) ? 'fast' : null;
}

/** Newer is higher (the version in the name; dates and snapshot stamps are ignored). */
function score(id) {
  return versionScore(parts(id).name.toLowerCase());
}

// For the challenger: an unknown tier (most models outside the big three vendors) ranks above a known fast one.
const TIER_STRENGTH = { top: 3, mid: 2, unknown: 1.5, fast: 1, local: 0 };
const strength = (id) => { const t = tierOf(id); return TIER_STRENGTH[t == null ? 'unknown' : t]; };
const byScoreThenId = (a, b) => (score(b) - score(a)) || (a < b ? -1 : a > b ? 1 : 0);

function roleOf(model, note) {
  const b = billingOf(model);
  return { model, vendor: vendorOf(model), route: b.route, perUse: b.kind === 'api', tier: tierOf(model), note: note || null };
}

function pickTeam({ available, lead } = {}) {
  const leadId = String(lead || '');
  const leadOk = usable(leadId);
  const seen = new Set();
  const reach = [];
  for (const id of [...(Array.isArray(available) ? available : []), leadId]) {
    const s = String(id || '');
    if (!s || seen.has(s) || !usable(s)) continue;   // the lead too: a text-only or non-chat lead model is never a pick
    seen.add(s); reach.push(s);
  }
  reach.sort();
  const kindOf = (id) => billingOf(id).kind;
  const leadKind = leadOk ? kindOf(leadId) : 'unknown';
  const leadVendor = leadOk ? vendorOf(leadId) : '';
  const leadPrefix = leadOk ? prefixOf(leadId) : '';
  const none = (note) => ({ model: null, vendor: null, route: null, perUse: false, tier: null, note });
  const finish = (team) => {
    team.notes = [...new Set(['challenger', 'scout', 'builder', 'researcher'].map((k) => team[k].note).filter(Boolean))];
    return team;
  };

  if (!reach.length) {
    const n = 'No model this agent can use is reachable yet. Connect a provider, then add it.';
    return finish({ challenger: none(n), scout: none(n), builder: none(n), researcher: none(n) });
  }

  // Local only: every reachable model runs on this machine. All four use the lead's model (one engine, no swaps); a lead
  // that is not a usable local model gives way to the newest local one.
  if (reach.every((id) => kindOf(id) === 'local')) {
    const m = reach.includes(leadId) ? leadId : reach.slice().sort(byScoreThenId)[0];
    return finish({ challenger: roleOf(m, LOCAL_CHALLENGER_NOTE), scout: roleOf(m), builder: roleOf(m), researcher: roleOf(m) });
  }

  const anyFree = reach.some((id) => ['subscription', 'local'].includes(kindOf(id)));
  const rankOf = (id) => {
    const kind = kindOf(id);
    if (kind === 'subscription') return leadPrefix === prefixOf(id) && ['subscription', 'local'].includes(leadKind) ? 1 : 2;
    if (kind === 'local') return leadPrefix === prefixOf(id) && leadKind === 'local' ? 1 : 3;
    if (kind === 'api') return anyFree ? 0 : 4;   // 0 = not allowed for a worker
    return 0;
  };
  const ranked = reach.map((id) => ({ id, rank: rankOf(id) })).filter((x) => x.rank > 0);

  // The newest model of the tiers asked for, in the best rank that has one: the lead's vendor first within a rank, and
  // the lead's own model first among local ones (no engine swap). A local model fits any worker tier; never a top tier.
  const pick = (tiers) => {
    for (const rank of [1, 2, 3, 4]) {
      let c = ranked.filter((x) => x.rank === rank && tiers.includes(tierOf(x.id) == null ? 'unknown' : tierOf(x.id))).map((x) => x.id);
      if (!c.length) continue;
      if (c.includes(leadId) && tierOf(leadId) === 'local') return leadId;
      const own = c.filter((id) => vendorOf(id) === leadVendor);
      if (own.length) c = own;
      return c.sort(byScoreThenId)[0];
    }
    return null;
  };
  const worker = (first, then) => {
    const a = pick([first, 'local']);
    if (a) return roleOf(a);
    const b = pick([then, 'unknown']);
    if (b) return roleOf(b, first === 'fast' && tierOf(b) === 'mid' ? NO_FAST_NOTE : NO_CHEAPER_NOTE);
    return none(NONE_NOTE);
  };
  const scout = worker('fast', 'mid');
  const builder = worker('mid', 'fast');
  const researcher = { ...builder };

  // Challenger: another vendor's model (not local, a fixed model), subscription before a per-use key, then the strongest
  // tier, then the newest; otherwise the lead's own vendor in the same order.
  const sub = (id) => (kindOf(id) === 'subscription' ? 1 : 0);
  let pool = reach.filter((id) => vendorOf(id) !== leadVendor && kindOf(id) !== 'local' && kindOf(id) !== 'unknown');
  let challengerNote = null;
  let challengerModel;
  if (pool.length) {
    challengerModel = pool.sort((a, b) => (sub(b) - sub(a)) || (strength(b) - strength(a)) || byScoreThenId(a, b))[0];
  } else {
    pool = reach.filter((id) => vendorOf(id) === leadVendor);
    if (!pool.length) pool = reach.slice();
    const own = (id) => (prefixOf(id) === leadPrefix ? 1 : 0);
    challengerModel = pool.sort((a, b) => (sub(b) - sub(a)) || (strength(b) - strength(a)) || (own(b) - own(a)) || byScoreThenId(a, b))[0];
    challengerNote = SAME_VENDOR_NOTE;
  }
  if (kindOf(challengerModel) === 'api') challengerNote = challengerNote ? `${challengerNote} ${PER_USE_NOTE}` : PER_USE_NOTE;

  return finish({ challenger: roleOf(challengerModel, challengerNote), scout, builder, researcher });
}

/** One line per role for logs and tests: "scout: claude-sdk/claude-haiku-5-5 (Subscription)". */
function explain(team) {
  return ['challenger', 'scout', 'builder', 'researcher'].filter((k) => team && team[k]).map((k) => {
    const r = team[k];
    if (!r.model) return `${k}: none`;
    return `${k}: ${r.model} (${r.route}${r.perUse ? ', billed per use' : ''})`;
  });
}

module.exports = { vendorOf, usable, tierOf, score, pickTeam, explain };
