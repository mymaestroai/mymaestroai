'use strict';
// plan-usage.js — the Claude subscription's usage windows (5-hour, 7-day, per-model weekly such as "Fable"),
// read through the Claude client; WARNINGS as a weekly window passes the owner's levels (default 75% and 90%), so
// the owner chooses each agent's model; and an optional automatic fallback, OFF unless the owner turns it on: when a
// model family's weekly window is at the threshold (default 90%) or the plan has refused it, agents on that family
// run their turns on the substitute model until the window resets. Per turn, never persisted: the agent's configured
// model stays, and the moment the window resets the next turn is back on it.
//
// Sources: (1) a poll of the client's structured /usage data every POLL_MS (experimental SDK method; failures are
// logged and the last good answer kept); (2) rate_limit_event messages the client streams during turns, which
// also carry a "rejected" the instant a limit bites. Owner policy in settings.planWarn { at: [levels] } and
// settings.planFallback { enabled, at, map }; per agent, `fallbackModel` ("none" opts out, a model id overrides the
// family map). A warning is announced once per level per window (data/plan-warnings.json): hub event plan_warning,
// a push to admins' devices, and one line in each affected agent's next reply.

const fs = require('fs');
const path = require('path');

const POLL_MS = 10 * 60 * 1000;
const EVENTS_KEEP = 30;
const DEFAULT_POLICY = { enabled: false, at: 90, map: { fable: 'claude-sdk/claude-opus-5-5', opus: 'claude-sdk/claude-sonnet-5-5', sonnet: 'claude-sdk/claude-haiku-5-5' } };
const DEFAULT_WARN = { at: [75, 90] };
// The weekly windows that are warned about besides the per-model ones; the 5-hour window resets within hours.
const WARN_WINDOWS = { seven_day: null, seven_day_opus: 'opus', seven_day_sonnet: 'sonnet' };
const FAMILY_LABEL = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };

/** settings.planWarn as stored: { at: up to five whole levels 1-100, ascending }. [] turns the warnings off. */
function cleanWarn(v) {
  const raw = v && typeof v === 'object' && !Array.isArray(v) ? v.at : v;
  const list = (Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(/[,\s]+/)).filter(x => x !== '').map(Number)
    .filter(n => Number.isFinite(n) && n >= 1 && n <= 100).map(n => Math.round(n));
  return { at: [...new Set(list)].sort((a, b) => a - b).slice(0, 5) };
}
/** A planFallback patch merged onto the stored policy: enabled, a threshold 1-100, substitutes that are Claude-client models. */
function cleanPolicy(patch, prev) {
  const p = prev && typeof prev === 'object' ? { ...prev } : {};
  if (!patch || typeof patch !== 'object') return p;
  if (patch.enabled !== undefined) p.enabled = !!patch.enabled;
  if (patch.at !== undefined) { const at = Number(patch.at); if (Number.isFinite(at) && at > 0 && at <= 100) p.at = Math.round(at); }
  if (patch.map && typeof patch.map === 'object') {
    const m = {};
    for (const [k, v] of Object.entries(patch.map)) if (FAMILY_LABEL[k] && /^claude-sdk\/[\w.[\]-]+$/.test(String(v))) m[k] = String(v);
    p.map = { ...(p.map && typeof p.map === 'object' ? p.map : {}), ...m };
  }
  return p;
}
/** A window's reset time as "Wed 8:00 PM" (local time of this machine), rounded to the minute. */
function whenText(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return 'the window resets';
  return new Date(Math.round(t / 60000) * 60000).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}
// Reset times arrive with sub-second noise; keys use the hour, so one window is one key from poll to poll.
function resetKey(iso) { const t = Date.parse(iso || ''); return Number.isFinite(t) ? new Date(Math.round(t / 3600000) * 3600000).toISOString() : ''; }
function warningLine(w, autoSwitch) {
  const pct = Math.round(Number(w.utilization) || 0);
  const what = w.family ? `${w.label} has used ${pct}% of this week's allowance` : `Your Claude plan has used ${pct}% of this week's allowance`;
  const then = autoSwitch ? '' : ' You can pick another model for this agent in the chat header.';
  return `_⚠️ ${what} (resets ${whenText(w.resetsAt)}).${then}_\n\n`;
}
function warningPush(ev) {
  const n = ev.agents.length; const who = `${n} agent${n === 1 ? '' : 's'}`;
  const title = ev.family ? `Claude plan: ${ev.label} at ${ev.utilization}% of this week` : `Claude plan: ${ev.utilization}% of this week's allowance`;
  const body = `Resets ${whenText(ev.resetsAt)}. ${ev.family ? `${who} run on ${ev.label}.` : `${who} run on Claude.`} ${ev.autoSwitch ? 'They switch to the substitute model automatically at the limit.' : 'Choose their models in Settings → Claude plan, or in each chat header.'}`;
  return { title, body, url: '/mobile', tag: `plan-${ev.window}` };
}

/** 'fable' | 'opus' | 'sonnet' | 'haiku' | null for a claude-sdk model id or picker alias. */
function familyOf(modelId) {
  const id = String(modelId || '').replace(/^claude-sdk\//, '').replace(/\[1m\]$/i, '').replace(/^claude-/, '').toLowerCase();
  if (!id) return null;
  if (id === 'default') return 'opus';
  if (/^(fable|mythos)/.test(id)) return 'fable';
  if (/^opus/.test(id)) return 'opus';
  if (/^sonnet/.test(id)) return 'sonnet';
  if (/^haiku/.test(id)) return 'haiku';
  return null;
}
function isSdkModel(modelId) { return /^claude-sdk\//.test(String(modelId || '')); }

function createPlanUsage({ getSetting = () => undefined, now = () => Date.now(), fetchUsage = null, publish = () => {}, log = console.log,
  stateFile = null, listAgents = () => [], notify = () => {} } = {}) {
  const state = { fetchedAt: null, subscription: null, available: null, windows: {}, models: {}, events: [], error: null, fallbacks: {} };
  let timer = null; let refreshing = null;
  let warned = null;            // "<window>|<reset hour>|<level>" (and "refused:<family>|<reset hour>") -> ISO time announced
  const told = new Set();       // "<agent>|<window>|<reset hour>|<level>": the chat line was shown (in memory)

  function warnPolicy() { const w = getSetting('planWarn'); return w === undefined || w === null ? { at: DEFAULT_WARN.at.slice() } : cleanWarn(w); }
  function loadWarned() {
    if (warned) return warned;
    warned = {};
    if (stateFile) { try { const j = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (j && j.warned && typeof j.warned === 'object') warned = j.warned; } catch {} }
    return warned;
  }
  function saveWarned() {
    const w = loadWarned();
    for (const k of Object.keys(w)) { const r = Date.parse(k.split('|')[1] || ''); if (Number.isFinite(r) && r <= now()) delete w[k]; }   // windows that have reset
    if (!stateFile) return;
    try { const tmp = `${stateFile}.tmp`; fs.writeFileSync(tmp, JSON.stringify({ warned: w }, null, 2), { mode: 0o600 }); fs.renameSync(tmp, stateFile); }
    catch (e) { log(`[plan-usage] could not save the warning state: ${e.message}`); }
  }
  /** The weekly windows the plan reports: { key, label, family (null = every Claude model), utilization, resetsAt, rejected }. */
  function weeklyWindows() {
    const out = [];
    for (const [fam, m] of Object.entries(state.models)) {
      if (fresh(m) && m.utilization != null) out.push({ key: `model:${fam}`, label: m.display_name || FAMILY_LABEL[fam] || fam, family: fam, utilization: Number(m.utilization), resetsAt: m.resets_at || null, rejected: !!m.rejected });
    }
    for (const [k, fam] of Object.entries(WARN_WINDOWS)) {
      const w = state.windows[k];
      if (!fresh(w) || w.utilization == null) continue;
      if (fam && fresh(state.models[fam])) continue;   // the per-model bucket already speaks for that family
      out.push({ key: k, label: fam ? FAMILY_LABEL[fam] : 'All models', family: fam, utilization: Number(w.utilization), resetsAt: w.resets_at || null, rejected: !!w.rejected });
    }
    return out;
  }
  function agentsOn(family) {
    let list = [];
    try { list = listAgents() || []; } catch {}
    return list.filter(a => a && a.name && isSdkModel(a.model) && (family == null || familyOf(a.model) === family)).map(a => a.name);
  }
  /** After every reading: a weekly window past a warning level is announced once per level and window (the highest level reached, when several are passed at once). */
  function checkWarnings() {
    const levels = warnPolicy().at;
    if (!levels.length) return [];
    const w = loadWarned(); const fired = [];
    for (const win of weeklyWindows()) {
      const reached = levels.filter(l => win.utilization >= l);
      if (!reached.length) continue;
      const top = reached[reached.length - 1];
      const keyOf = (l) => `${win.key}|${resetKey(win.resetsAt)}|${l}`;
      if (w[keyOf(top)]) continue;
      for (const l of reached) if (!w[keyOf(l)]) w[keyOf(l)] = new Date(now()).toISOString();
      const ev = { window: win.key, label: win.label, family: win.family, utilization: Math.round(win.utilization), level: top, resetsAt: win.resetsAt, agents: agentsOn(win.family), autoSwitch: policy().enabled };
      fired.push(ev);
      log(`[plan-usage] warning: ${win.label} at ${ev.utilization}% of its weekly window (level ${top}%), ${ev.agents.length} agent(s) on it`);
      try { publish('plan_warning', ev); } catch {}
      try { notify({ ...warningPush(ev), ts: now() }); } catch {}
    }
    if (fired.length) saveWarned();
    return fired;
  }
  /** The warning line for one agent's turn: the window that governs its model, once per agent, level and window. */
  function warningFor(modelId, agentName) {
    if (!isSdkModel(modelId)) return null;
    const levels = warnPolicy().at;
    if (!levels.length) return null;
    const fam = familyOf(modelId);
    let best = null;
    for (const win of weeklyWindows()) {
      if (win.family != null && win.family !== fam) continue;
      const reached = levels.filter(l => win.utilization >= l);
      if (!reached.length) continue;
      if (!best || win.utilization > best.utilization) best = { ...win, level: reached[reached.length - 1] };
    }
    if (!best) return null;
    const key = `${agentName}|${best.key}|${resetKey(best.resetsAt)}|${best.level}`;
    if (told.has(key)) return null;
    if (told.size > 5000) told.clear();
    told.add(key);
    return { window: best.key, label: best.label, family: best.family, utilization: Math.round(best.utilization), level: best.level, resetsAt: best.resetsAt, line: warningLine(best, policy().enabled) };
  }

  function policy() {
    const p = getSetting('planFallback') || {};
    const at = Number(p.at); const map = { ...DEFAULT_POLICY.map, ...((p.map && typeof p.map === 'object') ? p.map : {}) };
    return { enabled: p.enabled === undefined ? DEFAULT_POLICY.enabled : !!p.enabled, at: Number.isFinite(at) && at > 0 && at <= 100 ? at : DEFAULT_POLICY.at, map };
  }
  const fresh = (w) => !!w && !(w.resets_at && Date.parse(w.resets_at) <= now());
  /** The window that governs a family: its per-model weekly bucket if the plan reports one, else the classic per-family one. */
  function windowFor(family) {
    if (!family) return null;
    const m = state.models[family];
    if (fresh(m)) return { ...m, kind: 'model' };
    const classic = family === 'opus' ? state.windows.seven_day_opus : family === 'sonnet' ? state.windows.seven_day_sonnet : null;
    return fresh(classic) ? { ...classic, kind: 'family' } : null;
  }
  /** fallbackFor(modelId, agentRecord) -> { model, from, family, utilization, resetsAt, reason } or null. */
  function fallbackFor(modelId, agent = {}) {
    const pol = policy();
    if (!pol.enabled || !isSdkModel(modelId)) return null;
    if (agent && String(agent.fallbackModel || '').toLowerCase() === 'none') return null;
    const family = familyOf(modelId);
    if (!family) return null;
    const w = windowFor(family);
    if (!w || (w.utilization == null && !w.rejected)) return null;
    const hit = w.rejected || Number(w.utilization) >= pol.at;
    if (!hit) return null;
    let target = (agent && agent.fallbackModel) || pol.map[family] || null;
    if (!target || familyOf(target) === family) return null;
    // the substitute may itself be at its limit: step once more down the map
    const tw = windowFor(familyOf(target));
    if (tw && (tw.rejected || Number(tw.utilization) >= pol.at)) { const next = pol.map[familyOf(target)]; if (next && familyOf(next) !== familyOf(target) && familyOf(next) !== family) target = next; }
    return { model: target, from: modelId, family, utilization: w.utilization == null ? 100 : Number(w.utilization), resetsAt: w.resets_at || null, reason: w.rejected ? 'the plan refused this model' : `${Math.round(Number(w.utilization))}% of its weekly window` };
  }
  /** Called when a fallback was applied to a turn: remembered for the status API and broadcast once per agent per window. */
  function announce(agentName, fb) {
    const key = `${agentName}|${fb.family}|${fb.resetsAt || ''}`;
    const first = !state.fallbacks[key];
    state.fallbacks[key] = { agent: agentName, ...fb, at: new Date(now()).toISOString(), turns: (state.fallbacks[key] ? state.fallbacks[key].turns : 0) + 1 };
    if (first) { try { publish('model_fallback', { agent: agentName, from: fb.from, to: fb.model, family: fb.family, utilization: fb.utilization, resetsAt: fb.resetsAt, reason: fb.reason }); } catch {} }
    return first;
  }
  /** A rate_limit_event from a turn: keeps the windows current between polls; a rejection marks the family at 100% at once. */
  function noteEvent(info, modelId = null, agentName = null) {
    if (!info || typeof info !== 'object') return;
    const ts = new Date(now()).toISOString();
    const resets = info.resetsAt ? new Date(Number(info.resetsAt) * (Number(info.resetsAt) < 1e12 ? 1000 : 1)).toISOString() : null;
    // The client reports utilization here as a fraction (0.76 for 76%, seen 2026-10-21), while the usage answer
    // that refresh() reads gives a percentage. Stored as a fraction, a 76% week read "Plan 1%" after every turn
    // until the next poll. A value above 1 is taken as a percentage already, in case the client changes.
    const raw = info.utilization;
    const u = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;   // booleans, strings, negatives: no reading
    const rec = { ts, agent: agentName, model: modelId, status: info.status, type: info.rateLimitType || null, utilization: u == null ? null : (u <= 1 ? Math.round(u * 1000) / 10 : u), resetsAt: resets };
    state.events.push(rec); if (state.events.length > EVENTS_KEEP) state.events.splice(0, state.events.length - EVENTS_KEEP);
    const t = info.rateLimitType;
    if (['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'].includes(t) && (rec.utilization != null || info.status === 'rejected')) {
      state.windows[t] = { utilization: info.status === 'rejected' ? 100 : rec.utilization, resets_at: resets || (state.windows[t] && state.windows[t].resets_at) || null, rejected: info.status === 'rejected' };
    }
    if (info.status === 'rejected' && modelId) {
      const fam = familyOf(modelId);
      if (fam) state.models[fam] = { utilization: 100, resets_at: resets || (state.models[fam] && state.models[fam].resets_at) || null, rejected: true, display_name: state.models[fam] && state.models[fam].display_name || fam };
      const autoSwitch = policy().enabled;
      try { publish('plan_limit', { agent: agentName, model: modelId, family: fam, type: t || null, resetsAt: resets, autoSwitch }); } catch {}
      // One push per family and window, however many turns run into the refusal.
      const w = loadWarned(); const rk = `refused:${fam || t || 'plan'}|${resetKey(resets || (fam && state.models[fam] && state.models[fam].resets_at))}`;
      if (!w[rk]) {
        w[rk] = ts; saveWarned();
        const label = FAMILY_LABEL[fam] || 'this model';
        try { notify({ title: `Claude plan stopped ${label}`, body: `Until ${whenText(resets)}. ${autoSwitch ? `Agents on ${label} switch to the substitute model.` : `Agents on ${label} need another model: choose them in Settings → Claude plan, or in each chat header.`}`, url: '/mobile', tag: `plan-refused-${fam || 'plan'}`, ts: now() }); } catch {}
      }
      refresh().catch(() => {});
    } else if (rec.utilization != null) {
      checkWarnings();
    }
  }
  /** Pull the plan's windows through the client. One in flight at a time. */
  function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      if (!fetchUsage) return snapshot();
      try {
        const u = await fetchUsage();
        state.fetchedAt = new Date(now()).toISOString(); state.error = null;
        state.subscription = u.subscription_type || null; state.available = !!u.rate_limits_available;
        const r = u.rate_limits || {};
        for (const k of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps']) if (r[k]) state.windows[k] = { utilization: r[k].utilization, resets_at: r[k].resets_at || null, rejected: false };
        if (Array.isArray(r.model_scoped)) {
          state.models = {};
          for (const m of r.model_scoped) { const fam = familyOf(String(m.display_name || '').toLowerCase()) || String(m.display_name || '').toLowerCase(); state.models[fam] = { utilization: m.utilization, resets_at: m.resets_at || null, rejected: false, display_name: m.display_name }; }
        }
        if (r.extra_usage) state.extraUsage = { enabled: !!r.extra_usage.is_enabled, utilization: r.extra_usage.utilization, usedCredits: r.extra_usage.used_credits, monthlyLimit: r.extra_usage.monthly_limit };
        log(`[plan-usage] ${state.subscription || '?'}: ${describe()}`);
        checkWarnings();
      } catch (e) { state.error = `${new Date(now()).toISOString()} ${e.message}`; log(`[plan-usage] refresh failed: ${e.message}`); }
      return snapshot();
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  function describe() {
    const parts = [];
    for (const [k, w] of Object.entries(state.windows)) if (w && w.utilization != null) parts.push(`${k} ${Math.round(w.utilization)}%`);
    for (const [k, m] of Object.entries(state.models)) if (m && m.utilization != null) parts.push(`${k} ${Math.round(m.utilization)}%${m.rejected ? ' (refused)' : ''}`);
    return parts.join(', ') || 'no windows reported';
  }
  function snapshot() {
    return { fetchedAt: state.fetchedAt, subscription: state.subscription, available: state.available, error: state.error, windows: { ...state.windows }, models: { ...state.models }, extraUsage: state.extraUsage || null,
      policy: policy(), warn: warnPolicy(), weekly: weeklyWindows(), warned: Object.keys(loadWarned()),
      fallbacks: Object.values(state.fallbacks).filter(f => !f.resetsAt || Date.parse(f.resetsAt) > now()), events: state.events.slice(-10) };
  }
  function start() {
    if (timer) return;
    setTimeout(() => refresh().catch(() => {}), 5000).unref?.();
    timer = setInterval(() => refresh().catch(() => {}), POLL_MS); timer.unref?.();
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  /** test hook */
  function _setState(patch) { Object.assign(state, patch); }

  return { familyOf, windowFor, fallbackFor, announce, noteEvent, refresh, snapshot, start, stop, policy, describe, _setState, DEFAULT_POLICY,
    warnPolicy, weeklyWindows, checkWarnings, warningFor };
}

/** The hub's instance: usage read through the Claude client (lib/sdk-loader), events on the hub stream. */
let shared = null;
function getPlanUsage() {
  if (shared) return shared;
  const fetchUsage = async () => {
    const { loadSdk, cliOptions } = require('./sdk-loader');
    const sdk = await loadSdk();
    let q = null;
    try {
      q = sdk.query({ prompt: (async function* () { await new Promise(r => setTimeout(r, 60000)); })(), options: { maxTurns: 1, permissionMode: 'acceptEdits', tools: [], ...cliOptions() } });
      const fn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET || q.usage;
      if (typeof fn !== 'function') throw new Error('this Claude client has no usage request');
      return await fn.call(q, { skipBehaviors: true });
    } finally { try { q && q.close(); } catch {} }
  };
  shared = createPlanUsage({
    getSetting: (k, d) => { try { return require('./settings').getSetting(k, d); } catch { return d; } },
    fetchUsage,
    publish: (type, data) => { try { require('./hub-events').events.publish(type, data); } catch {} },
    stateFile: path.join(__dirname, '..', 'data', 'plan-warnings.json'),
    listAgents: () => { try { return require('./agents').getAgentsSync(); } catch { return []; } },
    // The plan is the owner's: warnings go to admins' devices (and to devices registered before accounts were recorded).
    notify: (payload) => { try { require('./push').getPush().notify(payload, { urgency: 'high', adminsOnly: true }); } catch {} },
  });
  return shared;
}

module.exports = { createPlanUsage, getPlanUsage, familyOf, cleanWarn, cleanPolicy, whenText, DEFAULT_POLICY, DEFAULT_WARN, POLL_MS };
