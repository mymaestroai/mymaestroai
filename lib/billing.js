'use strict';
/**
 * Who pays for a model, decided by its id prefix, so every picker, badge and notice can say it the same way:
 *   claude-sdk/…                      subscription  the Claude Code client on this machine's Claude sign-in (Max/Pro)
 *   codex-cli/…, codex/…              subscription  the Codex client on the ChatGPT subscription
 *   anthropic/…                       api           the Anthropic API key (prepaid credits / monthly invoice)
 *   openai/…, google/…, perplexity/…  api           that provider's API key
 *   lmstudio/ ollama/ omlx/ ninfer/   local         this machine, free
 * The Anthropic API key is never passed to the Claude Code client, so a claude-sdk/ agent cannot drift onto the API
 * bill by accident (lib/sdk-chat strips it from the client's environment).
 */
const KINDS = {
  subscription: { label: 'subscription', long: 'billed to a subscription (Claude Max/Pro sign-in or ChatGPT), not per token' },
  api: { label: 'API credits', long: 'billed per token to the provider API key (prepaid credits or invoice)' },
  local: { label: 'local', long: 'runs on this machine, free' },
  unknown: { label: 'unknown', long: 'billing path unknown' },
};

const VENDORS = { 'claude-sdk': 'Anthropic', anthropic: 'Anthropic', 'codex-cli': 'OpenAI', codex: 'OpenAI', openai: 'OpenAI', google: 'Google', perplexity: 'Perplexity', lmstudio: 'Local', ollama: 'Local', omlx: 'Local', ninfer: 'Local', local: 'Local' };
const VENDOR_ORDER = ['Anthropic', 'OpenAI', 'Google', 'Perplexity', 'Local'];
const ROUTES = { subscription: 'Subscription', api: 'API', local: 'Local', unknown: '?' };

/**
 * billingOf(model) -> { kind, via, label, long, vendor, route, name, display }
 *   vendor  the company the model belongs to (Anthropic, OpenAI, Google, Perplexity, Local, or the provider id)
 *   route   how it is paid: 'Subscription' | 'API' | 'Local'
 *   display what a picker shows: "gpt-6-astra · API", "claude-fable-5-1 · Subscription (Claude sign-in)"
 *   short   the header's compact form: "claude-fable-5-1 · Subscription"
 */
function billingOf(model) {
  const m = String(model || '');
  const p = m.includes('/') ? m.split('/')[0].toLowerCase() : '';
  const name = m.includes('/') ? m.slice(m.indexOf('/') + 1) : m;
  let kind = 'unknown', via = p || '';
  if (p === 'claude-sdk') { kind = 'subscription'; via = 'Claude sign-in'; }
  else if (p === 'codex-cli' || p === 'codex') { kind = 'subscription'; via = 'ChatGPT'; }
  else if (['anthropic', 'openai', 'google', 'perplexity'].includes(p)) { kind = 'api'; via = `${p} API key`; }
  else if (['lmstudio', 'ollama', 'omlx', 'ninfer', 'local'].includes(p)) { kind = 'local'; via = p === 'local' ? 'hub proxy' : p; }
  const vendor = VENDORS[p] || (p ? p.charAt(0).toUpperCase() + p.slice(1) : 'Other');
  const route = ROUTES[kind];
  const routeShown = kind === 'subscription' ? `${route} (${via})` : kind === 'local' ? `Local (${p === 'local' ? 'hub proxy' : p})` : route;
  const routeShort = kind === 'api' ? 'API $' : route;
  return { kind, via, label: KINDS[kind].label, long: KINDS[kind].long, vendor, route, name, display: `${name} · ${routeShown}`, short: `${name} · ${routeShort}` };
}

/** Group label for a picker: "claude-sdk · subscription (Claude sign-in)". */
function groupLabel(provider) {
  const b = billingOf(`${provider}/x`);
  return `${provider} · ${b.label}${b.kind === 'subscription' ? ` (${b.via})` : ''}`;
}

/** Environment for the Claude Code client: never the Anthropic API key, so the subscription sign-in is what it uses. */
function clientEnvWithoutApiKey(env) {
  const out = { ...env };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete out[k];
  return out;
}

/** Sort key for vendor groups: the known vendors in a fixed order, others after, alphabetically. */
function vendorRank(vendor) { const i = VENDOR_ORDER.indexOf(vendor); return i < 0 ? VENDOR_ORDER.length : i; }

module.exports = { billingOf, groupLabel, clientEnvWithoutApiKey, vendorRank, KINDS, VENDORS, VENDOR_ORDER, ROUTES };
