'use strict';
/**
 * The ChatGPT plan's usage, as Codex reports it (the owner's ChatGPT subscription behind the codex-cli agents).
 *
 * Two sources: the rate-limits-updated notification (see codex-cli/app-server) during a Codex turn (sparse: it only carries what changed,
 * so it is merged into what is known) and an on-demand `account/rateLimits/read` (a full picture, replaces). A limit has
 * zero, one or two windows and the weekly one may be "primary", so windows are told apart by their length, never by slot.
 *
 * This module sends only `initialize` and `account/rateLimits/read` to Codex. Nothing here spends or changes anything on
 * the account, and accountId, credit balances and credit details are never kept.
 *
 * State is kept in data/codex-usage.json (written atomically, mode 0600, debounced). Everything is injectable for tests.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const WRITE_MS = 2000;
const PUBLISH_MS = 5000;
const READ_GAP_MS = 60 * 1000;
const READ_LIMIT_MS = 30 * 1000;
const STALE_MS = 30 * 60 * 1000;
const MAX_LIMITS = 8;
const MAX_MINUTES = 89280;                       // 62 days
const DEFAULT_LEVELS = [75, 90];
const MS_MIN = Date.UTC(2001, 0, 1);
const MS_MAX = Date.UTC(2101, 0, 1);

// ── validation ────────────────────────────────────────────────────────────

function cleanId(v) { return typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v) ? v : null; }
function cleanName(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 60).trim();
  return s || null;
}
function cleanTag(v) { return typeof v === 'string' && /^[a-z0-9_]{1,40}$/.test(v) ? v : null; }
function cleanPercent(v) { return typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : null; }
function cleanMinutes(v) { return Number.isInteger(v) && v > 0 && v <= MAX_MINUTES ? v : null; }
/** A reset time (unix seconds, or milliseconds) as an ISO string; null when it is not a date between 2001 and 2100. */
function cleanReset(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const ms = v < 1e12 ? v * 1000 : v;
  return ms >= MS_MIN && ms < MS_MAX ? new Date(ms).toISOString() : null;
}
function cleanBool(v) { return typeof v === 'boolean' ? v : null; }
function cleanCredits(v) {
  if (!v || typeof v !== 'object') return null;
  return { hasCredits: cleanBool(v.hasCredits), unlimited: cleanBool(v.unlimited) };
}
/** A window as reported: each field is its clean value, or undefined when absent or invalid. null when no window. */
function cleanWindow(w) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return null;
  const out = {};
  const p = cleanPercent(w.usedPercent); if (p !== null) out.usedPercent = p;
  const m = cleanMinutes(w.windowDurationMins); if (m !== null) out.minutes = m;
  const r = cleanReset(w.resetsAt); if (r !== null) out.resetsAt = r;
  return out;
}

function hourKey(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? new Date(Math.round(t / 3600000) * 3600000).toISOString() : '';
}

/** 'weekly' | '5-hour' | 'N-day' | 'N-hour' | 'N-minute' | 'usage' (no length known). */
function windowLabel(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'usage';
  if (minutes === 10080) return 'weekly';
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

function emptyState() { return { limits: {}, readAt: null, source: null, planType: null, resetCredits: null, error: null, warned: {} }; }

// ── the store ─────────────────────────────────────────────────────────────

function createCodexUsage({
  getSetting = () => undefined, now = () => Date.now(), stateFile = null, publish = () => {}, notify = () => {},
  listAgents = () => [], readLimits = null, updateActive = () => false, log = console.log, whenText = null,
} = {}) {
  let state = null;
  let loadLogged = false;
  let saveTimer = null;
  let lastWrite = 0;
  let pubTimer = null;
  let lastPub = 0;
  let inflight = null;
  let lastAttempt = 0;
  let lastFailed = false;

  const when = (iso) => (whenText ? whenText(iso) : require('./plan-usage').whenText(iso));
  const enabled = () => getSetting('subscriptionUsage') !== false;
  const nowIso = () => new Date(now()).toISOString();

  // ── persistence ──
  function restoreLimit(id, o) {
    if (!o || typeof o !== 'object') return null;
    const lid = cleanId(id); if (!lid) return null;
    const win = (w) => {
      const c = cleanWindow(w && typeof w === 'object' ? { usedPercent: w.usedPercent, windowDurationMins: w.minutes, resetsAt: w.resetsAt ? Date.parse(w.resetsAt) : null } : null);
      return c && c.usedPercent !== undefined ? { usedPercent: c.usedPercent, minutes: c.minutes ?? null, resetsAt: c.resetsAt ?? null } : null;
    };
    const ws = o.windows && typeof o.windows === 'object' ? o.windows : {};
    const seen = Date.parse(o.seenAt || '');
    return {
      id: lid, name: cleanName(o.name), planType: cleanTag(o.planType),
      windows: { primary: win(ws.primary), secondary: win(ws.secondary) },
      reachedType: cleanTag(o.reachedType), spendControlReached: cleanBool(o.spendControlReached), credits: cleanCredits(o.credits),
      reachedUntil: typeof o.reachedUntil === 'string' ? cleanReset(Date.parse(o.reachedUntil)) : null,
      seenAt: Number.isFinite(seen) ? new Date(seen).toISOString() : null,
    };
  }
  function load() {
    if (state) return state;
    state = emptyState();
    if (!stateFile) return state;
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (raw && typeof raw === 'object') {
        for (const [id, l] of Object.entries(raw.limits && typeof raw.limits === 'object' ? raw.limits : {})) {
          const r = restoreLimit(id, l); if (r) state.limits[r.id] = r;
        }
        const ra = Date.parse(raw.readAt || '');
        state.readAt = Number.isFinite(ra) ? new Date(ra).toISOString() : null;
        state.source = raw.source === 'read' || raw.source === 'turn' ? raw.source : null;
        state.planType = cleanTag(raw.planType);
        state.resetCredits = Number.isInteger(raw.resetCredits) && raw.resetCredits >= 0 ? raw.resetCredits : null;
        state.error = typeof raw.error === 'string' ? raw.error.slice(0, 200) : null;
        for (const [k, v] of Object.entries(raw.warned && typeof raw.warned === 'object' ? raw.warned : {})) {
          if (typeof k === 'string' && k.length <= 200 && Number.isFinite(Date.parse(v))) state.warned[k] = String(v);
        }
      }
    } catch (e) {
      if (!loadLogged) { loadLogged = true; try { log(`[codex-usage] starting empty: ${e && e.code === 'ENOENT' ? 'no saved state yet' : `saved state unreadable (${String(e && e.message).slice(0, 100)})`}`); } catch {} }
    }
    return state;
  }
  function prune() {
    const t = now();
    for (const [k, v] of Object.entries(state.warned)) { if (Date.parse(v) < t) delete state.warned[k]; }
  }
  function writeNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!state || !stateFile) return;
    lastWrite = now();
    try {
      prune();
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      try { fs.chmodSync(tmp, 0o600); } catch {}
      fs.renameSync(tmp, stateFile);
    } catch (e) { try { log(`[codex-usage] could not save: ${String(e && e.message).slice(0, 120)}`); } catch {} }
  }
  function scheduleSave() {
    if (saveTimer) return;
    const wait = Math.max(0, WRITE_MS - (now() - lastWrite));
    saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, wait);
    saveTimer.unref?.();
  }
  function flush() { if (state) writeNow(); }

  // ── publishing the snapshot to the page ──
  function publishNow() {
    lastPub = now();
    if (pubTimer) { clearTimeout(pubTimer); pubTimer = null; }
    try { publish('codex_usage', snapshot(), { keep: false }); } catch {}
  }
  function schedulePublish() {
    const since = now() - lastPub;
    if (since >= PUBLISH_MS) { publishNow(); return; }
    if (pubTimer) return;
    pubTimer = setTimeout(() => { pubTimer = null; publishNow(); }, PUBLISH_MS - since);
    pubTimer.unref?.();
  }

  // ── readings ──
  const flagsSet = (l) => l.reachedType != null || l.spendControlReached === true;
  /** Reached only while the flags are set and the window that ran out has not reset yet. */
  const isReached = (l) => {
    if (!flagsSet(l)) return false;
    if (!l.reachedUntil) return true;
    return Date.parse(l.reachedUntil) > now();
  };
  /** When a reached limit could clear: the reset of its shortest window at 100%, else of its shortest window with a reset; else null. */
  function reachedUntilOf(l) {
    const ws = ['primary', 'secondary'].map(k => l.windows[k]).filter(w => w && w.resetsAt);
    const byLen = (a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity);
    const full = ws.filter(w => w.usedPercent >= 100).sort(byLen)[0];
    const w = full || ws.sort(byLen)[0];
    return w ? w.resetsAt : null;
  }
  function applyOne(rl, source, fallbackId) {
    if (!rl || typeof rl !== 'object' || Array.isArray(rl)) return null;
    const id = rl.limitId == null ? (fallbackId == null ? 'codex' : (cleanId(fallbackId) ? fallbackId : null)) : cleanId(rl.limitId);
    if (!id) return null;
    load();
    const full = source === 'read';
    const lim = state.limits[id] || { id, name: null, planType: null, windows: { primary: null, secondary: null }, reachedType: null, spendControlReached: null, credits: null, reachedUntil: null, seenAt: null };
    const name = cleanName(rl.limitName); if (name) lim.name = name;
    const plan = cleanTag(rl.planType); if (plan) { lim.planType = plan; state.planType = plan; }
    for (const key of ['primary', 'secondary']) {
      const c = cleanWindow(rl[key]);
      if (full) {
        lim.windows[key] = c && c.usedPercent !== undefined ? { usedPercent: c.usedPercent, minutes: c.minutes ?? null, resetsAt: c.resetsAt ?? null } : null;
      } else if (c) {
        const prev = lim.windows[key];
        if (prev) lim.windows[key] = { usedPercent: c.usedPercent ?? prev.usedPercent, minutes: c.minutes ?? prev.minutes, resetsAt: c.resetsAt ?? prev.resetsAt };
        else if (c.usedPercent !== undefined) lim.windows[key] = { usedPercent: c.usedPercent, minutes: c.minutes ?? null, resetsAt: c.resetsAt ?? null };
      }
    }
    const reached = cleanTag(rl.rateLimitReachedType);
    const spend = cleanBool(rl.spendControlReached);
    const credits = cleanCredits(rl.credits);
    const setsReached = reached !== null || spend === true;
    if (full) { lim.reachedType = reached; lim.spendControlReached = spend; lim.credits = credits; if (!setsReached) lim.reachedUntil = null; }
    else {
      if (reached !== null) lim.reachedType = reached;
      if (spend !== null) lim.spendControlReached = spend;
      // An explicit null reached type with a window below 100% (and no spend control) is Codex saying the limit is over.
      const below = ['primary', 'secondary'].some(k => { const c = cleanWindow(rl[k]); return c && c.usedPercent !== undefined && c.usedPercent < 100; });
      if (Object.prototype.hasOwnProperty.call(rl, 'rateLimitReachedType') && rl.rateLimitReachedType === null && below && spend !== true) {
        lim.reachedType = null; lim.spendControlReached = null; lim.reachedUntil = null;
      }
      if (credits) lim.credits = { hasCredits: credits.hasCredits ?? lim.credits?.hasCredits ?? null, unlimited: credits.unlimited ?? lim.credits?.unlimited ?? null };
    }
    if (setsReached) lim.reachedUntil = reachedUntilOf(lim);
    else if (flagsSet(lim) && !isReached(lim)) { lim.reachedType = null; lim.spendControlReached = null; lim.reachedUntil = null; }
    lim.seenAt = nowIso();
    state.limits[id] = lim;
    state.readAt = lim.seenAt;
    state.source = source;
    const ids = Object.keys(state.limits);
    if (ids.length > MAX_LIMITS) {
      ids.sort((a, b) => Date.parse(state.limits[b].seenAt || '') - Date.parse(state.limits[a].seenAt || '') || (a === id ? -1 : 0));
      for (const drop of ids.slice(MAX_LIMITS)) delete state.limits[drop];
    }
    return id;
  }
  function after() {
    checkWarnings();
    scheduleSave();
    schedulePublish();
  }

  /** One RateLimitSnapshot. source 'turn' (a notification) merges; 'read' replaces what the snapshot covers. */
  function noteSnapshot(rateLimits, { source = 'turn' } = {}) {
    if (!enabled()) return null;
    let id = null;
    try { id = applyOne(rateLimits, source === 'read' ? 'read' : 'turn', null); } catch (e) { try { log(`[codex-usage] reading dropped: ${String(e && e.message).slice(0, 100)}`); } catch {} }
    if (id) after();
    return id;
  }

  /** A full account/rateLimits/read result. */
  function noteRead(result) {
    if (!enabled() || !result || typeof result !== 'object') return false;
    load();
    const byId = result.rateLimitsByLimitId;
    const kept = new Set();
    try {
      if (byId && typeof byId === 'object' && !Array.isArray(byId)) {
        for (const [key, snap] of Object.entries(byId)) { const id = applyOne(snap, 'read', key); if (id) kept.add(id); }
      }
      if (!kept.size) { const id = applyOne(result.rateLimits, 'read', null); if (id) kept.add(id); }
    } catch (e) { try { log(`[codex-usage] read dropped: ${String(e && e.message).slice(0, 100)}`); } catch {} }
    if (!kept.size) {
      // Nothing usable: keep what is known (and when it was read) and say so.
      state.error = 'Codex answered without usage figures.';
      scheduleSave(); schedulePublish();
      return false;
    }
    for (const id of Object.keys(state.limits)) if (!kept.has(id)) delete state.limits[id];
    const rc = result.rateLimitResetCredits && typeof result.rateLimitResetCredits === 'object' ? result.rateLimitResetCredits.availableCount : null;
    state.resetCredits = Number.isInteger(rc) && rc >= 0 ? rc : null;
    state.error = null;
    after();
    return true;
  }

  // ── display ──
  function windowsOf(limit) {
    const t = now();
    const out = [];
    for (const key of ['primary', 'secondary']) {
      const w = limit && limit.windows && limit.windows[key];
      if (!w) continue;
      const m = w.minutes ?? null;
      const resetMs = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
      out.push({
        key, minutes: m, label: windowLabel(m), usedPercent: w.usedPercent, resetsAt: w.resetsAt ?? null,
        weekly: m != null && m >= 8640 && m <= 11520, short: m != null && m <= 720,
        expired: Number.isFinite(resetMs) && resetMs < t,
      });
    }
    return out.sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity));
  }
  const limitLabel = (l) => l.name || (l.id === 'codex' ? 'ChatGPT' : l.id);
  function levels() {
    const raw = getSetting('planWarn');
    if (raw === undefined || raw === null) return DEFAULT_LEVELS.slice();
    return require('./plan-usage').cleanWarn(raw).at;
  }

  function snapshot() {
    load();
    const limits = Object.values(state.limits).map(l => {
      const reached = isReached(l);
      const lapsed = flagsSet(l) && !reached;
      return {
        id: l.id, name: l.name, label: limitLabel(l), planType: l.planType, reached, reachedType: lapsed ? null : l.reachedType,
        spendControlReached: lapsed ? null : l.spendControlReached, reachedUntil: reached ? (l.reachedUntil || null) : null,
        credits: l.credits, seenAt: l.seenAt, windows: windowsOf(l),
      };
    });
    const weekly = [];
    for (const l of limits) for (const w of l.windows) if (w.weekly && !w.expired) weekly.push({ limit: l.id, label: l.label, usedPercent: w.usedPercent, resetsAt: w.resetsAt, reached: l.reached });
    return {
      enabled: enabled(), readAt: state.readAt, source: state.source, planType: state.planType, resetCredits: state.resetCredits,
      error: state.error, reading: !!inflight, limits, weekly, warn: { at: levels() },
    };
  }

  // ── warnings ──
  function codexAgents() {
    try { return (listAgents() || []).filter(a => a && typeof a.model === 'string' && a.model.startsWith('codex-cli/')).map(a => a.name); } catch { return []; }
  }
  // The key uses the hour-rounded reset (it absorbs jitter); the marker itself lives until the real reset plus an hour.
  function markerExpiry(resetsAt) {
    const t = Date.parse(resetsAt || '');
    return Number.isFinite(t) ? new Date(t + 3600000).toISOString() : new Date(now() + 7 * 86400000).toISOString();
  }

  function checkWarnings() {
    if (!enabled()) return;
    load();
    const at = levels();
    let wrote = false;
    for (const l of Object.values(state.limits)) {
      const label = limitLabel(l);
      const ws = windowsOf(l);
      // A weekly window crossing the owner's levels.
      if (at.length) {
        for (const w of ws) {
          if (!w.weekly || w.expired) continue;
          const passed = at.filter(n => w.usedPercent >= n);
          if (!passed.length) continue;
          const top = passed[passed.length - 1];
          const keyOf = (n) => `warn|${l.id}|${hourKey(w.resetsAt)}|${n}`;
          const fresh = passed.filter(n => !state.warned[keyOf(n)]);
          if (!fresh.length) continue;
          for (const n of passed) if (!state.warned[keyOf(n)]) state.warned[keyOf(n)] = markerExpiry(w.resetsAt);
          if (!fresh.includes(top)) continue;
          const agents = codexAgents();
          const payload = { provider: 'chatgpt', window: `chatgpt:${l.id}`, label, family: null, utilization: w.usedPercent, level: top, resetsAt: w.resetsAt, agents, autoSwitch: false };
          // Not kept for replay: a reconnecting page replays agent-less events to everyone (lib/hub-events), and the
          // owner's plan is for admins; the badge, chip and Settings read it from the admin-only route instead.
          try { publish('plan_warning', payload, { keep: false }); } catch {}
          try { notify({ title: `ChatGPT plan: ${w.usedPercent}% of this week's allowance`, body: `Resets ${when(w.resetsAt)}. ${agents.length} agent(s) run on ChatGPT (Codex).`, url: '/mobile', tag: `plan-chatgpt-${l.id}`, ts: now() }); } catch {}
          wrote = true;
        }
      }
      // The plan says it is used up.
      if (isReached(l)) {
        const resetsAt = l.reachedUntil || null;
        const key = `reached|${l.id}|${hourKey(resetsAt)}`;
        if (!state.warned[key]) {
          state.warned[key] = markerExpiry(resetsAt);
          const agents = codexAgents();
          try { notify({ title: 'ChatGPT plan limit reached', body: resetsAt ? `Codex agents can't run on the ChatGPT plan until ${when(resetsAt)}.` : "Codex agents can't run on the ChatGPT plan until it resets.", url: '/mobile', tag: `plan-chatgpt-reached-${l.id}`, ts: now() }); } catch {}
          try { publish('plan_warning', { provider: 'chatgpt', window: `chatgpt:${l.id}`, label, family: null, utilization: 100, level: 100, resetsAt, agents, autoSwitch: false, reached: true }, { keep: false }); } catch {}
          wrote = true;
        }
      }
    }
    if (wrote) writeNow();
  }

  // ── on-demand read ──
  function explain(e) {
    const msg = String((e && (e.rpcMessage || e.message)) || e || '');
    if (/authentication required/i.test(msg)) return "Codex isn't signed in to ChatGPT.";
    // An older Codex without this request answers "Method not found": that is not a missing install.
    if (/method not found|unknown (variant|method)/i.test(msg)) return "This Codex version can't report the plan's usage; a newer one can.";
    if (/\bENOENT\b/.test(msg)) return "Codex isn't installed.";
    if (/no reply in|time(d)? ?out|ETIMEDOUT/i.test(msg)) return "Codex didn't answer in time.";
    return `Couldn't read the ChatGPT plan's usage: ${(msg.split('\n')[0] || 'unknown error').slice(0, 160)}`;
  }
  async function runRead() {
    try {
      const result = await (readLimits || defaultReadLimits)();
      const good = noteRead(result);
      writeNow();
      lastFailed = !good;
      if (!good) return { ok: false, error: state.error, snapshot: { ...snapshot(), reading: false } };
      return { ok: true, snapshot: { ...snapshot(), reading: false } };
    } catch (e) {
      load();
      lastFailed = true;
      state.error = explain(e);
      writeNow();
      schedulePublish();
      return { ok: false, error: state.error, snapshot: { ...snapshot(), reading: false } };
    }
  }
  function readNow() {
    try {
      if (!enabled()) return Promise.resolve({ ok: false, error: 'Subscription usage is off.' });
      if (inflight) return inflight;
      if (updateActive()) return Promise.resolve({ ok: false, error: 'Codex is updating; try again in a few minutes.' });
      if (lastAttempt && now() - lastAttempt < READ_GAP_MS) {
        if (lastFailed) return Promise.resolve({ ok: false, error: load().error, cached: true, snapshot: snapshot() });
        return Promise.resolve({ ok: true, snapshot: snapshot(), cached: true });
      }
      lastAttempt = now();
      inflight = runRead().finally(() => { inflight = null; });
      return inflight;
    } catch (e) {
      return Promise.resolve({ ok: false, error: explain(e) });
    }
  }

  // ── the lead's brief ──
  function briefLine({ claude = null } = {}) {
    if (!enabled()) return '';
    const parts = [];
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
    try {
      const w7 = claude && claude.windows && claude.windows.seven_day;
      const w5 = claude && claude.windows && claude.windows.five_hour;
      const u7 = num(w7 && w7.utilization);
      const u5 = num(w5 && w5.utilization);
      if (u7 !== null) {
        let s = `Claude plan ${u7}% of this week`;
        if (u5 !== null) s += ` (5-hour ${u5}%)`;
        if (w7.resets_at) s += `, resets ${when(w7.resets_at)}`;
        parts.push(s);
      } else if (u5 !== null) parts.push(`Claude plan 5-hour ${u5}%`);
    } catch {}
    try {
      const snap = snapshot();
      const stale = snap.readAt && now() - Date.parse(snap.readAt) > STALE_MS ? ` (last seen ${when(snap.readAt)})` : '';
      const reached = snap.limits.filter(l => l.reached);
      if (reached.length) {
        const times = reached.map(l => l.reachedUntil).filter(Boolean).sort();
        parts.push(`ChatGPT plan limit reached until ${times.length === reached.length ? when(times[times.length - 1]) : 'it resets'}${stale}`);
      } else if (snap.weekly.length) {
        const top = snap.weekly.slice().sort((a, b) => b.usedPercent - a.usedPercent)[0];
        parts.push(`ChatGPT plan ${top.usedPercent}% of this week${top.resetsAt ? `, resets ${when(top.resetsAt)}` : ''}${stale}`);
      } else {
        const live = snap.limits.flatMap(l => l.windows).filter(w => !w.expired).sort((a, b) => b.usedPercent - a.usedPercent)[0];
        if (live) parts.push(`ChatGPT plan ${live.usedPercent}% of the ${live.label} allowance${stale}`);
      }
    } catch {}
    if (!parts.length) return '';
    return `- Subscriptions: ${parts.join('; ')}. Settings → Subscriptions shows every window.`;
  }

  return { noteSnapshot, noteRead, snapshot, windowsOf, checkWarnings, readNow, briefLine, flush };
}

// ── reading through codex app-server ──────────────────────────────────────

async function defaultReadLimits() {
  const codexCli = require('./codex-cli');
  // As for a Codex turn of an agent that is not the lead: the hub's filtered environment plus Codex's own names
  // (CODEX_HOME), never an API key that would move Codex off the subscription.
  const base = { ...process.env };
  for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) delete base[k];
  const childEnv = require('./child-env');
  const env = childEnv.buildChildEnv(base, { keep: (childEnv.CLIENT_KEEP && childEnv.CLIENT_KEEP.codex) || [] });
  for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) delete env[k];
  const bin = codexCli.resolveBinary(codexCli.withNode(env));
  if (!bin) throw new Error('ENOENT codex');
  const { AppServerClient } = require('./codex-cli/app-server');
  let client = null;
  let timer = null;
  try {
    client = new AppServerClient({ bin, cwd: os.homedir(), env: codexCli.withNode(env), agentName: 'usage-read' });
    const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Codex timed out reading the plan usage'), { code: 'ETIMEDOUT' })), READ_LIMIT_MS); timer.unref?.(); });
    const work = (async () => {
      let version = '0';
      try { version = require('../package.json').version; } catch {}
      await client.initialize(version);
      return client.request('account/rateLimits/read', { excludeResetCreditDetails: true }, { timeoutMs: 20000 });
    })();
    work.catch(() => {});
    return await Promise.race([work, limit, client.whenExited().then((e) => { throw e; })]);
  } finally {
    if (timer) clearTimeout(timer);
    try { client && client.close(); } catch {}
  }
}

/** The hub's instance. */
let shared = null;
function getCodexUsage() {
  if (shared) return shared;
  shared = createCodexUsage({
    getSetting: (k, d) => { try { return require('./settings').getSetting(k, d); } catch { return d; } },
    stateFile: path.join(__dirname, '..', 'data', 'codex-usage.json'),
    publish: (type, data, opts) => { try { require('./hub-events').events.publish(type, data, opts); } catch {} },
    // The plan is the owner's: warnings go to admins' devices.
    notify: (payload) => { try { require('./push').getPush().notify(payload, { urgency: 'high', adminsOnly: true }); } catch {} },
    listAgents: () => { try { return require('./agents').getAgentsSync(); } catch { return []; } },
    updateActive: () => { try { return require('./codex-cli/update-lock').active(); } catch { return false; } },
    readLimits: defaultReadLimits,
  });
  return shared;
}

module.exports = { createCodexUsage, getCodexUsage, windowLabel, defaultReadLimits };
