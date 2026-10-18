'use strict';

/**
 * context-window.js — how large an SDK agent's context window really is.
 *
 * The hub used to assume 200K for every Claude model. An agent on a 1M model
 * (`claude-...[1m]`) was told "~200K" in its system prompt and asked its owner for a
 * fresh chat at 13% usage; the error handler would also have reported any failure
 * past 170K tokens as "context window full".
 *
 * The window comes from the model id alone: 1M for `[1m]` ids, otherwise 200K. The SDK's
 * getContextUsage().maxTokens is NOT a window figure: it echoes back the auto-compact window
 * the hub itself sets (CLAUDE_CODE_AUTO_COMPACT_WINDOW). Feeding it back in used to shrink the
 * window by 20% per turn (1M -> 800K -> ... -> the SDK's 100K floor) until the hub restarted,
 * which left agents compacting in a loop ("Autocompact is thrashing").
 *
 * An agent can ask for less than the model allows with `contextBudget` (agents.json): a
 * smaller window means earlier compaction and cheaper turns; it can never exceed the model's.
 */

const DEFAULT_WINDOW = 200000;
const ONE_M_WINDOW = 1000000;
const COMPACT_RATIO = 0.8;          // compaction runs between requests; a tool-heavy turn needs headroom
const MIN_BUDGET = 125000;          // the SDK will not compact below 100K, i.e. 80% of 125K

// Models whose window is 1M by default (Anthropic docs, Oct 2026): Fable 5 / 5.1, Mythos, Opus 4.7 and later,
// Sonnet 5 and later, Haiku 5.5; and the Claude Code picker aliases that resolve to them (default = Opus 5.5,
// opus, fable, sonnet = Sonnet 5). The `[1m]` suffix still marks the 1M variant of Opus 4.6 / Sonnet 4.6.
// Everything else (Sonnet 4.5, Haiku 4.5, Opus 4.5 / 4.6, Sonnet 4.6 without the suffix) is 200K.
const ONE_M_BY_DEFAULT = /^(?:claude-sdk\/)?(?:claude-)?(?:fable-5(?:-\d+)*|mythos(?:-[\w.]+)*|opus-(?:4-[7-9]|[5-9](?:-\d+)*)|sonnet-(?:[5-9](?:-\d+)*)|haiku-5-5|default|opus|fable|sonnet)(?:-\d{8})?$/i;
function windowFor(model) {
  const id = String(model || '');
  if (/\[1m\]$/i.test(id)) return ONE_M_WINDOW;
  return ONE_M_BY_DEFAULT.test(id) ? ONE_M_WINDOW : DEFAULT_WINDOW;
}

/**
 * The window an agent actually works in: min(contextBudget, model window), never below
 * MIN_BUDGET. Blank/invalid budget = the model's full window. `note` explains any clamp.
 */
function effectiveWindow(model, budget) {
  const full = windowFor(model);
  const b = Number(budget);
  if (budget === null || budget === undefined || budget === '' || !Number.isFinite(b) || b <= 0) return { window: full, note: null };
  if (b > full) return { window: full, note: `contextBudget ${label(b)} exceeds the ${label(full)} window of "${model}"; using ${label(full)}` };
  if (b < MIN_BUDGET) return { window: MIN_BUDGET, note: `contextBudget ${label(b)} is below the ${label(MIN_BUDGET)} minimum; using ${label(MIN_BUDGET)}` };
  return { window: Math.round(b), note: null };
}

/** Token count at which the SDK should compact, for a given working window. */
function compactAt(window) {
  return Math.round((Number(window) || DEFAULT_WINDOW) * COMPACT_RATIO);
}

/**
 * Was this SDK failure the context window, or something else? The old check treated every
 * "exited with code 1" as a full context, which told the owner "Session ended" for crashes at
 * 30% usage. Only the API's own wording, or measured usage near the limit, counts.
 */
function classifyExit({ message = '', usedTokens = 0, limit = DEFAULT_WINDOW } = {}) {
  const text = String(message || '');
  if (/prompt is too long|context.{0,20}(window|length|limit)|token limit|input length/i.test(text)) return { kind: 'context', why: 'the model refused the prompt as too long' };
  if (limit && usedTokens >= limit * 0.85) return { kind: 'context', why: `usage was ${Math.round(usedTokens / limit * 100)}% of the window` };
  return { kind: 'crash', why: text.slice(0, 200) || 'unknown' };
}

/** 200000 -> "200K", 1000000 -> "1M", 128000 -> "128K" */
function label(tokens) {
  const n = Number(tokens) || DEFAULT_WINDOW;
  return n >= 1000000 && n % 100000 === 0 ? `${n / 1000000}M` : `${Math.round(n / 1000)}K`;
}

module.exports = { windowFor, effectiveWindow, compactAt, label, classifyExit, DEFAULT_WINDOW, ONE_M_WINDOW, MIN_BUDGET, COMPACT_RATIO };
