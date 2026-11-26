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
 *   planBadgeView(d, family, choice, subsOn, levels) -> null | { main, extras, cls, avail, wins }: what the badge shows.
 *       d: the plan reading { weekly: [...], windows: { five_hour } }; family: the open agent's model family or null;
 *       choice: 'plan' | 'family' | 'five' | null (what the person picked); subsOn: the subscriptions switch.
 *       Kinds: 'plan' (all-models weekly window), 'family' (the agent's family weekly window), 'five' (the 5-hour window).
 *       avail: the kinds with a reading, in that order; no weekly window at all -> null. main: the chosen kind when it
 *       has a reading, else the plan (the family when there is no plan window). extras (order plan, family, five, never
 *       main): a weekly window is added when used up, on extra usage, past a warning level, or higher than
 *       main (rounded; also when main is the 5-hour window); the 5-hour window when used up, or over 50% with subscriptions on. cls: the worst class of all avail windows.
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
function planBadgeView(d, family, choice, subsOn, levels) {
  const rank = (c) => (c === 'refused' ? 3 : c === 'hot' ? 2 : c === 'warn' ? 1 : 0);
  const read = ((d && d.weekly) || []).filter(w => w && w.utilization != null);
  const f5 = d && d.windows && d.windows.five_hour;
  const wins = {
    plan: read.find(w => w.family == null) || null,
    family: family ? read.find(w => w.family === family) || null : null,
    five: f5 && f5.utilization != null ? Object.assign({}, f5, { resetsAt: f5.resetsAt || f5.resets_at }) : null,
  };
  const avail = ['plan', 'family', 'five'].filter(k => wins[k]);
  if (!wins.plan && !wins.family) return null;
  const mk = (kind) => ({ kind, w: wins[kind] });
  const mainKind = avail.includes(choice) ? choice : wins.plan ? 'plan' : 'family';
  const main = mk(mainKind);
  const mainPct = planState(main.w, levels).pct;
  const extras = avail.filter(k => k !== mainKind).filter((k) => {
    const w = wins[k], s = planState(w, levels);
    if (k === 'five') return planUsedUp(w) || s.cls !== '' || (!!subsOn && Number(w.utilization) > 50);
    return planUsedUp(w) || s.extra || s.cls !== '' || s.pct > mainPct;
  }).map(mk);
  const cls = avail.reduce((c, k) => { const x = planState(wins[k], levels).cls; return rank(x) > rank(c) ? x : c; }, '');
  return { main, extras, cls, avail, wins };
}
function planUsedUp(w) { return !!w.rejected || (Number(w.utilization) >= 100 && !w.extraUsage); }
// ── plan state helpers (end) ──

module.exports = { planState, planPctText, planBadgeView, planUsedUp };
