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
const NOT_USABLE_RE = /(embed|audio|realtime|transcribe|tts|image|search|moderation|whisper|dall-e|instruct)/i;
const SAME_VENDOR_NOTE = 'Same vendor as the lead: a second opinion, not an outside view. Connect another provider to give it one.';
const LOCAL_CHALLENGER_NOTE = 'Runs on the same local model as the lead: a second opinion from the same model, not an outside view.';
const NO_CHEAPER_NOTE = 'No cheaper model is known on the ways this install pays, so it uses the closest one there is.';
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
  return !NOT_USABLE_RE.test(m);
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
    if (/-pro$/.test(name) || /^o[134](-|$)/.test(name)) return 'top';
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

/** Newer is higher; a "-latest" suffix beats every numbered version of the same tier. */
function score(id) {
  const name = parts(id).name.toLowerCase();
  return versionScore(name) + (/-latest$/.test(name) ? 1000 : 0);
}

const TIER_STRENGTH = { top: 3, mid: 2, fast: 1, local: 0 };
const strength = (id) => { const t = tierOf(id); return t == null ? 0 : TIER_STRENGTH[t]; };
const byScoreThenId = (a, b) => (score(b) - score(a)) || (a < b ? -1 : a > b ? 1 : 0);

function roleOf(model, note) {
  const b = billingOf(model);
  return { model, vendor: vendorOf(model), route: b.route, perUse: b.kind === 'api', tier: tierOf(model), note: note || null };
}

function pickTeam({ available, lead } = {}) {
  const leadId = String(lead || '');
  const seen = new Set();
  const reach = [];
  for (const id of [...(Array.isArray(available) ? available : []), leadId]) {
    const s = String(id || '');
    if (!s || seen.has(s) || (s !== leadId && !usable(s))) continue;
    seen.add(s); reach.push(s);
  }
  reach.sort();
  const leadBill = billingOf(leadId);
  const leadVendor = vendorOf(leadId);
  const leadPrefix = prefixOf(leadId);
  const kindOf = (id) => billingOf(id).kind;

  // Local only: every reachable model runs on this machine. Nothing else to choose, so all roles use the lead's model.
  if (reach.length && reach.every((id) => vendorOf(id) === 'Local' && kindOf(id) === 'local')) {
    const team = {
      challenger: roleOf(leadId, LOCAL_CHALLENGER_NOTE),
      scout: roleOf(leadId), builder: roleOf(leadId), researcher: roleOf(leadId),
    };
    team.notes = [LOCAL_CHALLENGER_NOTE];
    return team;
  }

  const anyFree = reach.some((id) => ['subscription', 'local'].includes(kindOf(id)));
  const rankOf = (id) => {
    const kind = kindOf(id);
    if (kind === 'subscription') return leadPrefix === prefixOf(id) && ['subscription', 'local'].includes(leadBill.kind) ? 1 : 2;
    if (kind === 'local') return leadPrefix === prefixOf(id) && leadBill.kind === 'local' ? 1 : 3;
    if (kind === 'api') return anyFree ? 0 : 4;   // 0 = not allowed
    return 0;
  };
  const ranked = reach.map((id) => ({ id, rank: rankOf(id) })).filter((x) => x.rank > 0);

  // The newest model of a tier in the best rank that has one; a local model fits any worker tier (never top).
  const pickTier = (tier) => {
    for (const rank of [1, 2, 3, 4]) {
      let c = ranked.filter((x) => x.rank === rank && (tierOf(x.id) === tier || tierOf(x.id) === 'local')).map((x) => x.id);
      if (!c.length) continue;
      const own = c.filter((id) => vendorOf(id) === leadVendor);
      if (own.length) c = own;
      return c.sort(byScoreThenId)[0];
    }
    return null;
  };

  // No model of the tier on an allowed route: a model whose tier is unknown on the best allowed route, then the lead's
  // model; but never a per-use lead model while a subscription or local model is reachable (the strongest free one then).
  const fallback = () => {
    for (const rank of [1, 2, 3, 4]) {
      const c = ranked.filter((x) => x.rank === rank && tierOf(x.id) == null).map((x) => x.id);
      if (c.length) return c.sort(byScoreThenId)[0];
    }
    if (!(anyFree && kindOf(leadId) === 'api')) return leadId;
    return ranked.filter((x) => x.rank > 0 && x.rank < 4).map((x) => x.id).sort(byScoreThenId)[0] || leadId;
  };
  let scoutNote = null;
  let scoutModel = pickTier('fast');
  if (!scoutModel) { scoutModel = pickTier('mid'); if (scoutModel) scoutNote = NO_FAST_NOTE; }
  if (!scoutModel) { scoutModel = fallback(); scoutNote = NO_CHEAPER_NOTE; }
  let builderModel = pickTier('mid');
  let builderNote = null;
  if (!builderModel) { builderModel = fallback(); builderNote = NO_CHEAPER_NOTE; }

  // Challenger: strongest model of another vendor (not local), then the strongest of the lead's own vendor.
  const sub = (id) => (kindOf(id) === 'subscription' ? 1 : 0);
  let pool = reach.filter((id) => vendorOf(id) !== leadVendor && vendorOf(id) !== 'Local' && kindOf(id) !== 'unknown');
  let challengerNote = null;
  let challengerModel;
  if (pool.length) {
    challengerModel = pool.sort((a, b) => (strength(b) - strength(a)) || (sub(b) - sub(a)) || byScoreThenId(a, b))[0];
  } else {
    pool = reach.filter((id) => vendorOf(id) === leadVendor);
    if (!pool.length) pool = [leadId];
    const own = (id) => (prefixOf(id) === leadPrefix ? 1 : 0);
    challengerModel = pool.sort((a, b) => (strength(b) - strength(a)) || (own(b) - own(a)) || (sub(b) - sub(a)) || byScoreThenId(a, b))[0];
    challengerNote = SAME_VENDOR_NOTE;
  }
  if (kindOf(challengerModel) === 'api') challengerNote = challengerNote ? `${challengerNote} ${PER_USE_NOTE}` : PER_USE_NOTE;

  const team = {
    challenger: roleOf(challengerModel, challengerNote),
    scout: roleOf(scoutModel, scoutNote),
    builder: roleOf(builderModel, builderNote),
    researcher: roleOf(builderModel, builderNote),
  };
  team.notes = [...new Set([team.challenger, team.scout, team.builder, team.researcher].map((r) => r.note).filter(Boolean))];
  return team;
}

/** One line per role for logs and tests: "scout: claude-sdk/claude-haiku-5-5 (Subscription)". */
function explain(team) {
  return ['challenger', 'scout', 'builder', 'researcher'].filter((k) => team && team[k]).map((k) => {
    const r = team[k];
    return `${k}: ${r.model} (${r.route}${r.perUse ? ', billed per use' : ''})`;
  });
}

module.exports = { vendorOf, usable, tierOf, score, pickTeam, explain };
