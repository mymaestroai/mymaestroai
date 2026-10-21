'use strict';
// Update check: once a day, and soon after the hub starts, the hub asks GitHub whether this install's channel
// (stable = main, experimental = dev) has something new, and tells the admins: a card on the desktop, a card and a
// menu line on the phone, and one push notification per new version. It never installs anything by itself:
// "Update now" on the card runs the same update as the Update dialog; "Later" hides the card for a day, for that
// admin and that version (a newer version shows again at once). Each admin device gets one push per version: a
// device that missed it, or one registered later, is tried again at the next check.
//
// On by default. settings.updateCheck { enabled (default true), hours (default 24) }. HUB_UPDATE_CHECK_HOURS
// overrides the interval (0 turns the schedule off), HUB_UPDATE_CHECK_FIRST_SECONDS the delay before the first check.
// State: data/update-check.json (mode 600). The look at GitHub itself is git-sync's peekUpdate (read-only).

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'data', 'update-check.json');
const DEFAULT_HOURS = 24;
const FIRST_DELAY_S = 90;
const LATER_MS = 24 * 3600 * 1000;
const HEAD_CACHE_MS = 10 * 1000;

function numberFrom(v) { return v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null; }

function createUpdateCheck({
  stateFile = STATE_FILE,
  peek, headNow, updateRunning = () => false,
  notifyEach = async () => ({ results: [] }),
  settings = () => ({}),
  env = process.env,
  now = () => Date.now(),
  log = (m) => console.log(`[update-check] ${m}`),
} = {}) {
  let state = null;
  let running = null;   // the check in flight, so overlapping callers share it
  let timers = [];
  let headCache = { at: 0, value: null };

  function load() {
    if (state) return state;
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = {}; }
    if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};
    if (!state.later || typeof state.later !== 'object') state.later = {};
    return state;
  }
  function save() {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  }

  function config() {
    const s = settings() || {};
    const envHours = numberFrom(env.HUB_UPDATE_CHECK_HOURS);
    const setHours = numberFrom(s.hours);
    return { enabled: s.enabled !== false, hours: envHours !== null ? envHours : setHours !== null && setHours > 0 ? setHours : DEFAULT_HOURS };
  }

  async function head() {
    if (now() - headCache.at < HEAD_CACHE_MS) return headCache.value;
    let v = null;
    try { v = await headNow(); } catch { v = null; }
    headCache = { at: now(), value: v };
    return v;
  }

  async function announce(st) {
    const l = st.last;
    const lead = l.titles.slice(0, 2).join(' · ');
    const body = `${lead ? `${lead}${l.titles.length > 2 || l.more ? ' · and more' : ''}. ` : ''}Tap to update now or later.`;
    // Per device: the ones that already have this version are skipped; each one that gets it is recorded. Only the
    // newest version's list is kept.
    const have = new Set((st.delivered && st.delivered.remote === l.remote && Array.isArray(st.delivered.ids)) ? st.delivered.ids : []);
    let res = null;
    try { res = await notifyEach({ title: headline(l), body, url: '/mobile?update=1', tag: 'hub-update' }, { adminsOnly: true, urgency: l.security ? 'high' : 'normal', skip: (id) => have.has(id) }); }
    catch (e) { log(`notification failed: ${e.message}`); }
    const got = ((res && res.results) || []).filter(r => r && r.ok).map(r => String(r.id));
    if (got.length) { st.delivered = { remote: l.remote, ids: [...have, ...got], at: new Date(now()).toISOString() }; save(); }
  }

  async function runCheck(reason) {
    const st = load();
    if (updateRunning()) { log(`skipped (${reason}): an update is running`); return st; }
    let r;
    try { r = await peek(); } catch (e) { r = { ok: false, error: e.message }; }
    st.checkedAt = new Date(now()).toISOString();
    if (!r || !r.ok) {
      st.error = String((r && r.error) || 'The check failed.').slice(0, 300);
      save();
      log(`check failed (${reason}): ${st.error}`);
      if (r && r.moved) later60('retry');
      return st;
    }
    delete st.error;
    st.last = { at: st.checkedAt, branch: r.branch, channel: r.channel, head: r.head, remote: r.remote, behind: r.behind, ahead: r.ahead, dirty: r.dirty || 0,
      currentVersion: r.currentVersion, latestVersion: r.latestVersion, titles: Array.isArray(r.titles) ? r.titles : [], more: r.more || 0, security: !!r.security };
    headCache = { at: now(), value: r.head };
    // "Later" was for one version: a newer one (or none) clears it.
    for (const [id, l] of Object.entries(st.later)) if (!l || l.remote !== r.remote || !(l.until > now())) delete st.later[id];
    save();
    log(`checked (${reason}): ${r.branch} ${r.behind ? `${r.behind} new commit(s)${r.latestVersion ? `, version ${r.latestVersion}` : ''}` : 'up to date'}${r.ahead ? `, ${r.ahead} local commit(s)` : ''}`);
    if (config().enabled && r.behind > 0 && !updateRunning()) await announce(st);
    return st;
  }

  function check({ reason = 'manual' } = {}) {
    if (!running) running = runCheck(reason).finally(() => { running = null; });
    return running;
  }

  /** What the pages show. available: GitHub has commits this install lacks; blocked: it also has commits of its own
   *  or uncommitted changes to tracked files, so the Update dialog has to decide; snoozed: this admin pressed Later
   *  for this version less than a day ago; remote: the commit the card describes (Later names it). */
  async function status(user) {
    const st = load();
    const c = config();
    const l = st.last || null;
    const out = { enabled: c.enabled, hours: c.hours, checking: !!running, checkedAt: st.checkedAt || null, error: st.error || null,
      available: false, blocked: false, stale: false, remote: null, dirty: 0, channel: l ? l.channel : null, branch: l ? l.branch : null,
      currentVersion: l ? l.currentVersion : null, latestVersion: null, behind: 0, ahead: l ? l.ahead : 0,
      titles: [], more: 0, security: false, headline: null, snoozed: false, laterUntil: null };
    if (!l || !(l.behind > 0)) return out;
    const h = await head();
    if (h && h !== l.head) {   // the code moved since the check (an update ran): look again shortly
      out.stale = true;
      if (!running) soon('code moved', 3000);
      return out;
    }
    Object.assign(out, { available: true, blocked: l.ahead > 0 || (l.dirty || 0) > 0, remote: l.remote, dirty: l.dirty || 0, latestVersion: l.latestVersion, behind: l.behind,
      titles: l.titles, more: l.more, security: l.security, headline: headline(l) });
    const later = st.later[userKey(user)];
    if (later && later.remote === l.remote && later.until > now()) { out.snoozed = true; out.laterUntil = new Date(later.until).toISOString(); }
    return out;
  }

  /** Later, for the version the card showed (remote): a newer one found meanwhile is not hidden by it. */
  async function later(user, remote) {
    const st = load();
    if (st.last && st.last.remote && remote === st.last.remote) { st.later[userKey(user)] = { until: now() + LATER_MS, remote }; save(); }
    return status(user);
  }

  // A look outside the daily schedule (the code moved, or a check was thrown away): registered with the schedule, so
  // stop() and switching the check off cancel it, and skipped if the check is off by the time it fires.
  function soon(reason, ms) {
    const t = setTimeout(() => { timers = timers.filter(x => x !== t); const c = config(); if (c.enabled && c.hours > 0) check({ reason }).catch(() => {}); }, ms);
    if (t.unref) t.unref();
    timers.push(t);
  }
  function later60(reason) { soon(reason, 60 * 1000); }

  function stop() { for (const t of timers) { clearTimeout(t); clearInterval(t); } timers = []; }

  /** (Re)start the schedule from the current settings: a first look soon, then every `hours`. */
  function start() {
    stop();
    const c = config();
    if (!c.enabled || !(c.hours > 0)) { log(c.enabled ? 'schedule off (HUB_UPDATE_CHECK_HOURS=0)' : 'off (Settings → Updates)'); return false; }
    const firstS = numberFrom(env.HUB_UPDATE_CHECK_FIRST_SECONDS);
    const a = setTimeout(() => check({ reason: 'start' }).catch(() => {}), (firstS !== null ? firstS : FIRST_DELAY_S) * 1000);
    const b = setInterval(() => check({ reason: 'scheduled' }).catch(() => {}), c.hours * 3600 * 1000);
    if (a.unref) a.unref();
    if (b.unref) b.unref();
    timers = [a, b];
    return true;
  }

  return { check, status, later, start, stop, config, _state: () => load() };
}

/** "My Maestro AI 5.6.0 is ready" when the version moved, else "3 new changes on experimental". */
function headline(l) {
  if (l.latestVersion && l.latestVersion !== l.currentVersion) return `My Maestro AI ${l.latestVersion} is ready`;
  const label = l.channel === 'experimental' || l.channel === 'stable' ? l.channel : l.branch;
  return `${l.behind} new change${l.behind === 1 ? '' : 's'} on ${label}`;
}
function userKey(user) { return user && user.id ? String(user.id) : 'admin'; }

let singleton = null;
function getUpdateCheck() {
  if (singleton) return singleton;
  const gs = require('./git-sync');
  singleton = createUpdateCheck({
    peek: gs.peekUpdate, headNow: gs.currentHead, updateRunning: gs.updateInProgress,
    notifyEach: (payload, opts) => require('./push').getPush().notifyEach(payload, opts),
    settings: () => { try { return require('./settings').getSetting('updateCheck', {}) || {}; } catch { return {}; } },
  });
  return singleton;
}

module.exports = { createUpdateCheck, getUpdateCheck, headline, STATE_FILE, DEFAULT_HOURS, LATER_MS };
