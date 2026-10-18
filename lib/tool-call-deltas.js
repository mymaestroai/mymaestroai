'use strict';

/**
 * tool-call-deltas.js — fold streamed `delta.tool_calls` fragments into whole tool calls.
 *
 * OpenAI streams each call in fragments that share an `index`. Gemini's OpenAI-compatible
 * endpoint sends every call whole and with NO `index` at all, so keying on `index` alone
 * merged parallel calls into one: last name wins, arguments become `{...}{...}` (invalid
 * JSON). The turn then came back empty, or the next request failed with HTTP 400
 * "Request contains an invalid argument". Verified live 2026-09-21, Pro and Flash.
 *
 * Rule: a numeric `index` is the key. Without one, a new `id` starts a new call and a
 * fragment with no `id` continues the most recent call.
 */

function entryFor(map, tc) {
  if (Number.isInteger(tc.index)) {
    if (!map.has(tc.index)) map.set(tc.index, { id: '', name: '', arguments: '' });
    return map.get(tc.index);
  }
  if (tc.id) {
    for (const e of map.values()) if (e.id === tc.id) return e;
  } else if (map.size) {
    return [...map.values()].pop();
  }
  const entry = { id: '', name: '', arguments: '' };
  map.set(`noindex:${map.size}`, entry);
  return entry;
}

/** Fold one `delta.tool_calls[]` item into the map (insertion order = call order). Returns the entry. */
function accumulateToolCallDelta(map, tc) {
  const entry = entryFor(map, tc);
  if (tc.id) entry.id = tc.id;
  if (tc.function?.name) entry.name = tc.function.name;
  if (tc.function?.arguments) entry.arguments += tc.function.arguments;
  // Provider-specific data that MUST be echoed back with the call. Gemini 3.x puts its
  // thought_signature here and rejects the next request (400) if it is missing.
  if (tc.extra_content) entry.extra_content = { ...(entry.extra_content || {}), ...tc.extra_content };
  return entry;
}

module.exports = { accumulateToolCallDelta };
