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
 *   planBadgeWindows(weekly, family, levels) -> null | { lead, second, cls }: the badge always leads with the all-models
 *       window (the family window alone when there is none); the open agent's family window is second only when its
 *       percent is higher, or it is really used up (planUsedUp: rejected, or 100% without extra usage) / on extra usage while the
 *       plan is not; cls is the worse of the two.
 *   planUsedUp(w)              the raw window is used up: rejected, or at 100% or more without extra usage (no rounding).
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
function planBadgeWindows(weekly, family, levels) {
  const rank = (c) => (c === 'refused' ? 3 : c === 'hot' ? 2 : c === 'warn' ? 1 : 0);
  const read = (weekly || []).filter(w => w && w.utilization != null);
  const all = read.find(w => w.family == null) || null;
  const fam = family ? read.find(w => w.family === family) || null : null;
  if (!all && !fam) return null;
  if (!all || !fam) { const w = all || fam; return { lead: w, second: null, cls: planState(w, levels).cls }; }
  const a = planState(all, levels), f = planState(fam, levels);
  const bad = (w) => (planUsedUp(w) ? 2 : planState(w, levels).extra ? 1 : 0);
  const second = f.pct > a.pct || bad(fam) > bad(all) ? fam : null;
  return { lead: all, second, cls: rank(f.cls) > rank(a.cls) ? f.cls : a.cls };
}
function planUsedUp(w) { return !!w.rejected || (Number(w.utilization) >= 100 && !w.extraUsage); }
// ── plan state helpers (end) ──

module.exports = { planState, planPctText, planBadgeWindows, planUsedUp };
