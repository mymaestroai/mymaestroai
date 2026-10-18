'use strict';
/**
 * Provider errors in plain words. When a model's provider refuses or fails a request, the reply used to end with the
 * raw text ("[Error: Provider 404: {"error":{...}}]"), which says nothing about what to do. explain() reads the status
 * and the provider's own message and returns what happened and what to do; text() turns that into the lines the chat
 * shows. The provider's message stays on a last "Details" line, so nothing is lost for whoever has to dig further.
 *
 *   explain(err, { model }) -> { kind, title, what, fix, detail, status }
 *     err:   an Error ("Provider <status>: <body>" from lib/gateway-client, or a network error) or a message string
 *     model: the agent's model id ("openrouter/nvidia/nemotron-3.5-super-vl:free"), or { provider } when unknown
 *   text(err, opts) -> markdown: "⚠️ **<title>** <what>\n\n**What to do:** <fix>\n\nDetails: <detail>"
 */

const PROVIDER_NAMES = {
  openrouter: 'OpenRouter', openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', perplexity: 'Perplexity',
  local: 'The local model server', lmstudio: 'LM Studio', ollama: 'Ollama', omlx: 'oMLX', ninfer: 'NInfer', codex: 'OpenAI',
};
const LOCAL = new Set(['local', 'lmstudio', 'ollama', 'omlx', 'ninfer']);
const BILLING = {
  openrouter: 'openrouter.ai/settings/credits',
  openai: 'platform.openai.com/settings/organization/billing',
  anthropic: 'console.anthropic.com/settings/billing',
  google: 'aistudio.google.com (Billing)',
  perplexity: 'perplexity.ai/settings/api',
};
const NEW_SESSION = 'Start a new session (New Session above the chat on the desktop; ⋮ → Clear chat / new session on the phone)';

/** Strip what could turn into markdown or markup inside a line we did not write. */
const plain = (s) => String(s == null ? '' : s).replace(/[*_`[\]<>|#]/g, ' ').replace(/\s+/g, ' ').trim();

/** The provider's own message out of an error body: OpenAI, OpenRouter, Anthropic, Google and plain-text shapes. */
function providerMessage(body) {
  const s = String(body || '').trim();
  const pick = (o) => {
    if (!o) return '';
    if (typeof o === 'string') return o;
    if (o.error) { const m = pick(o.error); if (m) return m; }
    let m = typeof o.message === 'string' ? o.message : (typeof o.detail === 'string' ? o.detail : '');
    // OpenRouter wraps the upstream provider's refusal: "Provider returned error" + metadata.raw (the real reason).
    if (/^provider returned error$/i.test(m) && o.metadata && o.metadata.raw) {
      const raw = String(o.metadata.raw);
      let inner = ''; try { inner = pick(JSON.parse(raw)); } catch { inner = raw; }
      if (inner) m = `${m}: ${inner}`;
    }
    return m;
  };
  try { const j = JSON.parse(s); const m = pick(Array.isArray(j) ? j[0] : j); if (m) return m; } catch { /* not JSON */ }
  return s;
}

function catalogueInfo(id) {
  try { return require('./openrouter').getOpenRouter().info(id); } catch { return null; }
}

const money = (x) => { const v = Number((x * 1e6).toPrecision(12)); return v === 0 ? '0' : v < 0.1 ? v.toFixed(3) : v < 10 ? v.toFixed(2) : v.toFixed(0); };   // toPrecision: 1e-7 * 1e6 is 0.0999…
const tokens = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : `${Math.round(n / 1000)}K`;

function context(err, opts = {}) {
  const raw = err instanceof Error ? String(err.message || '') : String(err == null ? '' : err);
  const causes = err instanceof Error ? (() => { try { return require('./provider-pacing').describeError(err); } catch { return raw; } })() : raw;
  const model = String(opts.model || '');
  const provider = String(opts.provider || (model.includes('/') ? model.split('/')[0] : '') || '');
  const id = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  const m = raw.match(/^Provider (\d{3}):\s*([\s\S]*)$/);
  const status = Number((err && err.status) || (m && m[1]) || 0) || null;
  const msg = m ? providerMessage(m[2]) : raw;
  let name = id ? id.split('/').pop() : 'The model';
  let info = null; let sibling = null; let siblingPrice = '';
  if (provider === 'openrouter' && id) {
    info = catalogueInfo(id);
    if (info && info.name) name = String(info.name).replace(/^[^:]{1,40}:\s*/, '');
    if (/:free$/.test(id)) {
      const paid = catalogueInfo(id.replace(/:free$/, ''));
      if (paid) { sibling = paid.id; if (paid.prompt != null && paid.completion != null) siblingPrice = `$${money(paid.prompt)} / $${money(paid.completion)}`; }
    }
  }
  return {
    raw, causes, msg, status, provider, id, info, sibling, siblingPrice,
    name: plain(name) || 'The model',
    provName: PROVIDER_NAMES[provider] || (provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : 'The provider'),
    free: /:free$/.test(id),
    hay: `${msg}\n${causes}`,
  };
}

// First match wins. Each case: test(ctx) and a builder returning { what, fix }.
const CASES = [
  { kind: 'privacy', test: (c) => /data policy/i.test(c.hay), build: (c) => ({
    what: c.free
      ? 'This free version only runs on servers that may train on your prompts, and the hub\'s privacy setting blocks those.'
      : 'None of this model\'s servers meets the hub\'s privacy setting: they may store or train on your prompts.',
    fix: c.sibling
      ? `Switch to the paid version, \`${c.sibling}\`, in the model picker (🔎 More OpenRouter models…)${c.siblingPrice ? `; it costs ${c.siblingPrice} per million tokens` : ''}. Turning privacy off in Settings → OpenRouter would also work, but the free server could then train on what this agent sends.`
      : 'Pick another model. Or turn privacy off in Settings → OpenRouter, which allows servers that may store or train on what this agent sends.',
  }) },
  { kind: 'no_tools', test: (c) => /support tool use|does not support tools|tools? (use )?(is|are) not supported|function calling is not (enabled|supported)|no endpoints found that support/i.test(c.hay), build: (c) => ({
    what: 'This model can\'t use tools, and agents here need them to read files, run commands and search.',
    fix: c.provider === 'openrouter' ? 'Pick a model marked 🛠 in the OpenRouter list (🔎 More OpenRouter models… in the model picker).' : 'Pick a model that supports tool calling.',
  }) },
  { kind: 'key_limit', test: (c) => c.provider === 'openrouter' && /key.{0,40}limit|limit.{0,40}\bkey\b/i.test(c.hay), build: () => ({
    what: 'This OpenRouter key has reached the spending limit set on it.',
    fix: 'Raise the key\'s limit at openrouter.ai/settings/keys (or add credit at openrouter.ai/settings/credits), then send again.',
  }) },
  { kind: 'credit', test: (c) => c.status === 402 || /insufficient.{0,12}(credit|funds|balance|quota)|credit balance is too low|exceeded your current quota|payment required|out of credits?|billing/i.test(c.hay), build: (c) => ({
    what: `The ${c.provName} account is out of credit.`,
    fix: `${BILLING[c.provider] ? `Add credit at ${BILLING[c.provider]}, then send again` : 'Add credit with the provider, then send again'}. Or pick a model from another provider for now.`,
  }) },
  { kind: 'auth', test: (c) => c.status === 401 || /invalid.{0,10}api.?key|incorrect api key|api key not valid|unauthori[sz]ed|authentication|no auth credentials/i.test(c.hay), build: (c) => ({
    what: `${c.provName} refused the API key.`,
    fix: `Paste a new key in Settings → LLM Providers → ${c.provName}, press Test, then Save.`,
  }) },
  { kind: 'moderation', test: (c) => /moderation|flagged/i.test(c.hay), build: (c) => ({
    what: `${c.provName}'s moderation blocked this message.`,
    fix: 'Rephrase it, or pick another model.',
  }) },
  { kind: 'verification', test: (c) => /organi[sz]ation (must be|is not|needs to be) verified|verify (your )?organi[sz]ation/i.test(c.hay), build: (c) => ({
    what: `${c.provName} only lets verified organizations use this model.`,
    fix: 'Verify your organization at platform.openai.com/settings/organization/general, or pick another model.',
  }) },
  { kind: 'context', test: (c) => /context.{0,20}(length|window|limit)|maximum context|too many tokens|prompt is too long|input is too long|exceeds? the (context|maximum)|context_length_exceeded|reduce the length/i.test(c.hay), build: (c) => {
    const said = c.hay.match(/(?:maximum context length|context (?:length|window)|limit) (?:is|of) ([\d,]{4,}) tokens/i);
    const limit = c.info && c.info.context ? c.info.context : said ? Number(said[1].replace(/,/g, '')) : 0;
    return {
      what: `This conversation is too long for ${c.name}${limit ? ` (it reads up to ${tokens(limit)} tokens)` : ''}.`,
      fix: `${NEW_SESSION}, or pick a model with a bigger context window.`,
    };
  } },
  { kind: 'forbidden', test: (c) => c.status === 403, build: (c) => ({
    what: `${c.provName} doesn't let this key use this model.`,
    fix: `Pick another model, or check the key's permissions with ${c.provName}.`,
  }) },
  { kind: 'rate_limit', test: (c) => c.status === 429 || /rate[ _-]?limit|too many requests|resource.?exhausted/i.test(c.hay), build: (c) => {
    const secs = c.raw.match(/retry[- ]after[:\s]+(\d+)/i);
    return c.free ? {
      what: 'Free versions only allow a few requests a minute and a small daily allowance, and that is used up for now.',
      fix: c.sibling ? `Wait a minute and send again, or switch to the paid version, \`${c.sibling}\`, in the model picker.` : 'Wait a minute and send again, or pick another model.',
    } : {
      what: `${c.provName} is limiting how fast this key can send requests.`,
      fix: `Wait ${secs ? `about ${secs[1]} seconds` : 'a minute'} and send again, or pick a model from another provider for now.`,
    };
  } },
  { kind: 'not_found', test: (c) => c.status === 404 || /model_not_found|model .{0,60}(does not exist|not found)|no endpoints found|not a valid model/i.test(c.hay), build: (c) => ({
    what: `${c.provName} doesn't offer ${c.id ? `\`${c.id.replace(/`/g, '')}\`` : 'this model'} right now: it may have been retired or renamed.`,
    fix: 'Pick another model in the model picker.',
  }) },
  { kind: 'local_down', test: (c) => LOCAL.has(c.provider) && /ECONNREFUSED|connection refused|fetch failed|ENOTFOUND|EHOSTUNREACH/i.test(c.hay), build: (c) => ({
    what: `${c.provider === 'local' ? 'The local model server' : c.provName} isn't running, so the model can't answer.`,
    fix: c.provider === 'local' ? 'Open the Local models page (Settings → Local models), start it, then send again.' : `Start ${c.provName}, then send again.`,
  }) },
  { kind: 'overloaded', test: (c) => (c.status && c.status >= 500) || /\b529\b|overloaded|over capacity|service unavailable|temporarily unavailable|bad gateway|internal server error/i.test(c.hay), build: (c) => ({
    what: `${c.provName}'s servers are busy or having trouble right now.`,
    fix: 'Send again in a minute, or switch to another model for now. Anything already written above is kept.',
  }) },
  { kind: 'network', test: (c) => /ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|socket hang up|fetch failed|network|UND_ERR/i.test(c.hay), build: (c) => ({
    what: `The hub couldn't reach ${c.provName}.`,
    fix: 'Check this computer\'s internet connection, then send again. Anything already written above is kept.',
  }) },
  { kind: 'timeout', test: (c) => /ETIMEDOUT|timed? ?out|timeout/i.test(c.hay), build: (c) => ({
    what: `${c.provName} took too long to answer.`,
    fix: 'Send again. If it keeps happening, pick a faster model. Anything already written above is kept.',
  }) },
];

function explain(err, opts = {}) {
  const c = context(err, opts);
  const hit = CASES.find(k => { try { return k.test(c); } catch { return false; } });
  const body = hit ? hit.build(c) : {
    what: `${c.provName} returned an error${c.status ? ` (HTTP ${c.status})` : ''}.`,
    fix: 'Send again. If it keeps happening, pick another model.',
  };
  // The provider's own message; for a connection failure, the cause chain ("fetch failed · connect ECONNREFUSED …").
  const said = c.status ? (c.msg || c.raw) : [...new Set(String(c.causes || c.raw).split(' <- '))].join(' · ');
  const who = c.provider === 'local' ? 'Local models' : c.provName;
  const detail = plain(`${who}${c.status ? ` ${c.status}` : ''}: ${said}`).slice(0, 240);
  return { kind: hit ? hit.kind : 'error', status: c.status, title: `${c.name} couldn't reply.`, what: body.what, fix: body.fix, detail };
}

/** The explanation as the chat shows it (markdown). */
function format(e) { return `⚠️ **${e.title}** ${e.what}\n\n**What to do:** ${e.fix}\n\nDetails: ${e.detail}`; }
/** One line, for notes another agent reads (a consultation that failed). */
function oneLine(e) { return `${e.title} ${e.what} What to do: ${e.fix} (${e.detail})`; }
function text(err, opts = {}) { return format(explain(err, opts)); }
/** The name a person knows a model by: OpenRouter's catalogue name, else the id without its route. */
function nameOf(model) { return context('', { model }).name; }

module.exports = { explain, text, format, oneLine, nameOf, providerMessage };
