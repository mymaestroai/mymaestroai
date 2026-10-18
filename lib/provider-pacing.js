'use strict';
// Provider pacing: parallel delegation is great until a provider starts failing under the burst.
//
// One module paces every path that fans work out (consult_agent, spawn_workers, stand-ins):
//   - classify():   turns an outcome (thrown error, typed turn_error event, or short error text) into
//                   { kind: ok|rate_limit|overloaded|crash|timeout|error, transient, retryAfterMs }.
//   - run():        runs a unit of work under the provider's current concurrency limit. A transient
//                   failure trips the provider to serial (limit 1) for a cooldown, then retries the
//                   work with backoff; after the retries the caller gets a typed, labelled failure.
//   - ramp:         once the cooldown has passed, every N consecutive successes raise the limit one
//                   step (1 -> 2 -> 4 -> cap). Any new transient failure trips it again.
//   - status():     per-provider picture for /api/hub/status, the status_snapshot and the UI chips.
//   - fault():      test hook: the next N runs for a provider fail synthetically (prove it live).
//
// Nothing here knows about agents or HTTP: the caller maps an agent/model to a provider key
// (temporal-workers.providerOf) and decides what "work" is.

const DEFAULT_CAPS = {
  'claude-sdk': 6, anthropic: 4, openai: 4, codex: 2, 'codex-cli': 2, google: 4, perplexity: 3,
  lmstudio: 1, ollama: 1, default: 2,
};
const RAMP_STEPS = [1, 2, 4];          // then the provider's full cap
const RAMP_SUCCESSES = 2;              // consecutive successes per step up
const COOLDOWN_MS = 2 * 60 * 1000;     // serial for this long after a trip (or the retry-after, if longer)
const RETRY_DELAYS_MS = [10 * 1000, 30 * 1000];
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const MAX_RETRY_AFTER_MS = 15 * 60 * 1000;

// 'down' (connection refused / unreachable) paces the provider like the others but is never retried in-call.
const TRANSIENT = new Set(['rate_limit', 'overloaded', 'timeout', 'down']);

const PATTERNS = [
  // Order matters: the first match wins.
  { kind: 'down', re: /\bECONNREFUSED\b|\bEHOSTUNREACH\b|\bENETUNREACH\b|\bENOTFOUND\b|connection refused|getaddrinfo/i },
  { kind: 'rate_limit', re: /\b429\b|rate[ _-]?limit|too many requests|hit your (usage )?limit|usage limit|out of extra usage|quota exceeded|resource.?exhausted|resets? (at|in) /i },
  // Gateway text after its own retries is "Provider <status>: <body>"; LM Studio answers 500 while a model loads or is busy.
  { kind: 'overloaded', re: /\b529\b|\b503\b|\b502\b|\b500\b|\b504\b|overloaded|over capacity|service unavailable|temporarily unavailable|bad gateway|gateway timeout|internal server error|model (is )?(not )?load/i },
  { kind: 'timeout', re: /\bETIMEDOUT\b|\btimed? ?out\b|\bECONNRESET\b|socket hang up|\bEPIPE\b|network error|fetch failed|\bECONNREFUSED\b/i },
  { kind: 'crash', re: /process stopped unexpectedly|exited with code|killed|\bENOENT\b|\bENOMEM\b|spawn .* failed|Codex stopped|Codex turn failed|session_interrupted/i },
];

function parseRetryAfter(text) {
  const s = String(text || '');
  let m = s.match(/retry[- ]after[:\s]+(\d+)(?:\s*(ms|s|sec|seconds?|m|min|minutes?))?/i);
  if (m) {
    const n = Number(m[1]);
    const unit = (m[2] || 's').toLowerCase();
    const ms = unit === 'ms' ? n : unit.startsWith('m') && unit !== 'ms' ? n * 60 * 1000 : n * 1000;
    return Math.min(ms, MAX_RETRY_AFTER_MS);
  }
  m = s.match(/resets? in (\d+)\s*(m|min|minutes?|h|hours?|s|seconds?)/i);
  if (m) {
    const n = Number(m[1]);
    const u = m[2].toLowerCase();
    const ms = u.startsWith('h') ? n * 3600 * 1000 : u.startsWith('m') ? n * 60 * 1000 : n * 1000;
    return Math.min(ms, MAX_RETRY_AFTER_MS);
  }
  return null;
}

/** Error text with the cause chain (fetch's "fetch failed" hides ECONNREFUSED in err.cause). */
function describeError(err) {
  if (!(err instanceof Error)) return String(err == null ? '' : err);
  const parts = [];
  const add = (v) => { const t = String(v || '').trim(); if (t && !parts.includes(t)) parts.push(t); };
  const seen = new Set();
  const walk = (cur, depth) => {
    if (!cur || depth > 6 || seen.has(cur)) return;
    seen.add(cur);
    add(cur.message);
    add(cur.code || cur.errno);
    if (Array.isArray(cur.errors)) for (const e of cur.errors) walk(e, depth + 1);
    walk(cur.cause, depth + 1);
  };
  walk(err, 0);
  return parts.join(' <- ');
}

/**
 * classify(outcome) -> { kind, transient, retryAfterMs, message }
 * outcome: an Error (optionally carrying .pacing = {kind, retryAfterMs}), a typed event {kind, message, retryAfterMs},
 * or a string. Plain strings are only classified when they are SHORT (an error line, not an essay that
 * happens to mention rate limits).
 */
function classify(outcome, { maxTextLen = 600 } = {}) {
  if (outcome == null) return { kind: 'ok', transient: false, retryAfterMs: null, message: '' };
  if (typeof outcome === 'object' && outcome.pacing && outcome.pacing.kind) {
    const k = outcome.pacing.kind;
    return { kind: k, transient: TRANSIENT.has(k), retryAfterMs: outcome.pacing.retryAfterMs || null, message: String(outcome.message || outcome.pacing.message || k), ...(outcome.pacing.help ? { help: String(outcome.pacing.help) } : {}) };
  }
  if (typeof outcome === 'object' && !(outcome instanceof Error) && outcome.kind) {
    const k = outcome.kind;
    return { kind: k, transient: TRANSIENT.has(k), retryAfterMs: outcome.retryAfterMs || parseRetryAfter(outcome.message), message: String(outcome.message || k) };
  }
  const isError = outcome instanceof Error;
  const text = isError ? describeError(outcome) : String(outcome);
  if (!isError && text.length > maxTextLen) return { kind: 'ok', transient: false, retryAfterMs: null, message: '' };
  for (const p of PATTERNS) {
    if (p.re.test(text)) return { kind: p.kind, transient: TRANSIENT.has(p.kind), retryAfterMs: parseRetryAfter(text), message: text.slice(0, 300) };
  }
  if (isError) return { kind: 'error', transient: false, retryAfterMs: null, message: text.slice(0, 300) };
  return { kind: 'ok', transient: false, retryAfterMs: null, message: '' };
}

class PacingError extends Error {
  constructor(message, pacing) { super(message); this.name = 'PacingError'; this.pacing = pacing; }
}

function createPacing({
  caps = DEFAULT_CAPS, now = Date.now, sleep = (ms) => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); }),
  cooldownMs = COOLDOWN_MS, retryDelaysMs = RETRY_DELAYS_MS, rampSuccesses = RAMP_SUCCESSES, onEvent = null, log = console.log,
} = {}) {
  const providers = new Map();   // key -> state
  const faults = new Map();      // key -> remaining synthetic failures

  function capFor(p) { return caps[p] || caps.default || 2; }

  function state(p) {
    let s = providers.get(p);
    if (!s) {
      s = { provider: p, cap: capFor(p), limit: capFor(p), active: 0, waiting: [], mode: 'normal', reason: null, since: null, until: null,
            streak: 0, failures: [], lastFailure: null, retries: 0, successes: 0 };
      providers.set(p, s);
    }
    return s;
  }

  function emit(type, data) {
    if (!onEvent) return;
    try { onEvent({ type, ...data }); } catch {}
  }

  function pruneFailures(s) {
    const cutoff = now() - FAILURE_WINDOW_MS;
    while (s.failures.length && s.failures[0].at < cutoff) s.failures.shift();
  }

  function trip(s, cls, label) {
    const t = now();
    const hold = Math.max(cooldownMs, cls.retryAfterMs || 0);
    s.failures.push({ at: t, kind: cls.kind, label: label || null, message: cls.message });
    pruneFailures(s);
    s.lastFailure = { at: new Date(t).toISOString(), kind: cls.kind, label: label || null, message: cls.message };
    const was = s.mode;
    s.mode = 'paced';
    s.reason = cls.kind;
    s.since = s.since && was !== 'normal' ? s.since : new Date(t).toISOString();
    s.until = new Date(t + hold).toISOString();
    s.limit = 1;
    s.streak = 0;
    log(`[pacing] ${s.provider}: ${cls.kind}${label ? ` on ${label}` : ''} -> serial for ${Math.round(hold / 1000)}s (${cls.message.slice(0, 120)})`);
    emit('provider_paced', { provider: s.provider, reason: cls.kind, limit: s.limit, cap: s.cap, until: s.until, since: s.since, message: cls.message.slice(0, 200), label: label || null });
  }

  function success(s) {
    s.successes++;
    if (s.mode === 'normal') return;
    if (s.until && now() < Date.parse(s.until)) return;   // still cooling down: stay serial
    s.streak++;
    if (s.streak < rampSuccesses) return;
    s.streak = 0;
    const next = RAMP_STEPS.find(v => v > s.limit);
    const target = next && next < s.cap ? next : s.cap;
    s.limit = target;
    if (s.limit >= s.cap) {
      s.mode = 'normal'; s.reason = null; s.since = null; s.until = null;
      log(`[pacing] ${s.provider}: recovered, limit back to ${s.cap}`);
      emit('provider_recovered', { provider: s.provider, limit: s.limit, cap: s.cap });
    } else {
      s.mode = 'ramping';
      log(`[pacing] ${s.provider}: ramping, limit ${s.limit}/${s.cap}`);
      emit('provider_ramp', { provider: s.provider, limit: s.limit, cap: s.cap });
    }
    wake(s);
  }

  function wake(s) {
    while (s.waiting.length && s.active < s.limit) { s.waiting.shift()(); }
  }

  async function acquire(s) {
    while (s.active >= s.limit) await new Promise(r => s.waiting.push(r));
    s.active++;
  }
  function release(s) {
    s.active = Math.max(0, s.active - 1);
    wake(s);
  }

  /**
   * run(provider, fn, { label, retry = true, classifyResult })
   * fn() must resolve with the work's result or reject. A resolved result is classified with
   * `classifyResult(result)` when given (so a caller can recognise a typed failure it chose to resolve).
   * Transient failures trip the provider and are retried; the final failure is thrown as PacingError
   * with .pacing = { kind, transient, attempts, provider }.
   */
  async function run(provider, fn, { label = null, retry = true, classifyResult = null } = {}) {
    const p = provider || 'default';
    const s = state(p);
    const maxAttempts = retry ? retryDelaysMs.length + 1 : 1;
    let attempt = 0;
    let last = null;
    await acquire(s);
    try {
      while (attempt < maxAttempts) {
        attempt++;
        let outcome;
        try {
          const left = faults.get(p) || 0;
          if (left > 0) {
            faults.set(p, left - 1);
            throw new PacingError(`[pacing fault] synthetic rate limit for ${p} (${left - 1} left)`, { kind: 'rate_limit', retryAfterMs: null });
          }
          const result = await fn({ attempt, provider: p });
          const cls = classifyResult ? classify(classifyResult(result)) : { kind: 'ok', transient: false };
          if (cls.kind === 'ok') { success(s); return result; }
          outcome = cls;
        } catch (e) {
          if (e && e.pacing && e.pacing.final) throw e;   // already a final typed failure from a nested run
          outcome = classify(e);
          if (outcome.kind === 'ok') outcome = { kind: 'error', transient: false, retryAfterMs: null, message: String(e && e.message || e) };
        }
        last = outcome;
        if (outcome.kind === 'down') {
          // The provider is not there at all: no point waiting 10 s and 30 s to ask again.
          // Pace it (serial until it answers) and fail now with a typed reason.
          trip(s, outcome, label);
          throw new PacingError(outcome.message || outcome.kind, { ...outcome, final: true, attempts: attempt, provider: p });
        }
        if (!outcome.transient) {
          if (outcome.kind !== 'ok') { s.failures.push({ at: now(), kind: outcome.kind, label, message: outcome.message }); pruneFailures(s); s.lastFailure = { at: new Date(now()).toISOString(), kind: outcome.kind, label, message: outcome.message }; }
          throw new PacingError(outcome.message || outcome.kind, { ...outcome, final: true, attempts: attempt, provider: p });
        }
        trip(s, outcome, label);
        if (attempt >= maxAttempts) break;
        const delay = Math.max(retryDelaysMs[attempt - 1] || 0, outcome.retryAfterMs || 0);
        s.retries++;
        log(`[pacing] ${s.provider}: retry ${attempt}/${maxAttempts - 1}${label ? ` for ${label}` : ''} in ${Math.round(delay / 1000)}s`);
        emit('provider_retry', { provider: p, label, attempt, delayMs: delay, reason: outcome.kind });
        await sleep(delay);
      }
      throw new PacingError(last.message || last.kind, { ...last, final: true, attempts: attempt, provider: p });
    } finally {
      release(s);
    }
  }

  /** Human text for the coordinator when a run finally fails. */
  function failureText(err, target) {
    const pc = err && err.pacing;
    if (!pc) return `Consultation with ${target} failed: ${err && err.message ? err.message : err}`;
    const what = { rate_limit: 'rate limit', overloaded: 'provider overloaded', timeout: 'network timeout', crash: 'agent process crashed', down: 'provider unreachable' }[pc.kind] || pc.kind;
    if (pc.kind === 'down') {
      return `[PROVIDER DOWN] "${target}" could not be reached: provider ${pc.provider} refused the connection (${(pc.message || '').slice(0, 160)}). ` +
        `Nothing was retried. The provider is not running or not reachable from this machine (for a local one such as LM Studio, start it and load the model). Use an agent on another provider or report what you have; the hub will try this provider again when next asked.`;
    }
    if (pc.transient) {
      return `[TRANSIENT FAILURE] "${target}" could not be run: ${what} on provider ${pc.provider} after ${pc.attempts} attempt${pc.attempts === 1 ? '' : 's'} (${(pc.message || '').slice(0, 160)}). ` +
        `The hub has switched that provider to one-at-a-time for a cooling-off period and will ramp back up as calls succeed. Try again in a few minutes, use an agent on a different provider, or report what you have.`;
    }
    const partial = err.partialText && String(err.partialText).trim() ? `\n\nPartial output before the failure:\n${String(err.partialText).trim().slice(0, 1500)}` : '';
    // A provider refusal explained in plain words (lib/error-help) says what to do; pass that on, not the raw text.
    if (pc.help) return `[FAILED] "${target}" could not complete. ${String(pc.help).slice(0, 900)} This does not look transient; do not retry blindly.${partial}`;
    return `[FAILED] "${target}" could not complete: ${what} (${(pc.message || '').slice(0, 200)}). This does not look transient; do not retry blindly.${partial}`;
  }

  function status() {
    const out = {};
    for (const s of providers.values()) {
      pruneFailures(s);
      const coolingMs = s.until ? Math.max(0, Date.parse(s.until) - now()) : 0;
      out[s.provider] = {
        cap: s.cap, limit: s.limit, active: s.active, queued: s.waiting.length, mode: s.mode, reason: s.reason,
        since: s.since, until: s.until, coolingMs, failures10m: s.failures.length, retries: s.retries, successes: s.successes, lastFailure: s.lastFailure,
      };
    }
    const paced = Object.entries(out).filter(([, v]) => v.mode !== 'normal').map(([provider, v]) => ({ provider, limit: v.limit, cap: v.cap, reason: v.reason, until: v.until, coolingMs: v.coolingMs, mode: v.mode }));
    return { providers: out, paced };
  }

  /** Test hook: the next `count` runs for `provider` fail with a synthetic rate limit. */
  function fault(provider, count = 1) { faults.set(provider, Math.max(0, Number(count) || 0)); return { provider, pending: faults.get(provider) }; }

  /** Owner override: reset a provider to full parallel at once. */
  function reset(provider) {
    if (provider) { const s = state(provider); s.limit = s.cap; s.mode = 'normal'; s.reason = null; s.since = null; s.until = null; s.streak = 0; wake(s); emit('provider_recovered', { provider, limit: s.limit, cap: s.cap, manual: true }); }
    else for (const p of providers.keys()) reset(p);
    return status();
  }

  return { run, classify, status, fault, reset, failureText, capFor, PacingError };
}

let shared = null;
function getPacing(opts) { if (!shared) shared = createPacing(opts); return shared; }

module.exports = { createPacing, getPacing, classify, describeError, parseRetryAfter, PacingError, DEFAULT_CAPS, RAMP_STEPS, COOLDOWN_MS, RETRY_DELAYS_MS, TRANSIENT };
