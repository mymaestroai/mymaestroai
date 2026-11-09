'use strict';
/**
 * ui-plan-state.js — how a weekly Claude plan window looks on the pages: the chat header badge (desktop) and the chat
 * header text (phone). The pages carry byte-identical copies between the markers below; test/ui-plan-state.test.js
 * proves the copies match and tests the rules here.
 *
 *   planState(w, levels) -> { pct, extra, cls }
 *       w: a weekly entry { utilization, rejected, extraUsage, ... }; levels: the warning levels (percent), or [].
 *       extra: the window is at 100% and extra usage (pay-as-you-go) is paying. cls: 'refused' when the plan refuses
 *       (rejected, or 100% without extra usage), 'warn' while extra usage pays, else 'hot' (past every level),
 *       'warn' (past some) or ''.
 *   planPctText(w, levels)     "90%", or "100% · extra usage" while extra usage pays.
 */
// ── plan state helpers (begin) ──
function planState(w, levels) {
  const pct = Math.round(Number(w.utilization) || 0);
  const extra = !!w.extraUsage && !w.rejected;
  const passed = (levels || []).filter(l => pct >= l);
  const cls = w.rejected || (pct >= 100 && !extra) ? 'refused' : extra ? 'warn' : passed.length && passed.length === (levels || []).length ? 'hot' : passed.length ? 'warn' : '';
  return { pct, extra, cls };
}
function planPctText(w, levels) {
  const s = planState(w, levels);
  return s.extra ? `${s.pct}% · extra usage` : `${s.pct}%`;
}
// ── plan state helpers (end) ──

module.exports = { planState, planPctText };
