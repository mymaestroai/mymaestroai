'use strict';
/**
 * backup/schedule.js — nightly backups, which automatic backups to keep, and the warnings when backups stop.
 *
 *   normalize(s)                    the schedule with its defaults: every night at 03:30, keep 7 nightly + 4 weekly
 *   validate(input)                 a schedule from a request, or an error in plain words
 *   runTimeFor(date, at, tz)        the moment "at" (HH:MM) happens on a local date in zone tz
 *   dueDate(sched, now, tz, last, notBefore)  the local date whose nightly backup should start now, or null: once a day,
 *                                   at or after the set time (a computer that slept through it catches up the same day),
 *                                   and never for a time that had already passed when backups were set up or the time
 *                                   was changed (notBefore), so saving never starts a backup
 *   nextRun(sched, now, tz, last, notBefore)  when the next nightly backup is due
 *   toKeep(records, opts)           the names of the nightly backups to keep in one place: the newest keepNightly, plus
 *                                   the first backup of each of the keepWeekly most recent weeks that have one. Counted,
 *                                   not dated, so a computer that was off for a month loses nothing by time passing.
 *   createScheduler(opts)           a ticker (once a minute): starts the nightly backup (waiting up to 30 minutes for
 *                                   working agents; a night that is due survives a restart), then applies the keep
 *                                   rules; warns the admins (a phone notification, retried until delivered, and the
 *                                   setup checklist) when a backup fails or none was made for 3 days
 *   current()                       the scheduler the server runs (the setup checklist reads it)
 * The hub's zone is the first admin's (lib/timezone.js hubZone), so 03:30 is the owner's night, not the server's.
 */
const fs = require('fs');
const path = require('path');
const tzm = require('../timezone');

const AT = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULTS = Object.freeze({ enabled: true, at: '03:30', keepNightly: 7, keepWeekly: 4 });
const DAY = 86400000;
const err = (msg, code = 'EBADSCHEDULE') => Object.assign(new Error(msg), { code });
const intIn = (v, lo, hi, dflt) => (Number.isInteger(v) && v >= lo && v <= hi ? v : dflt);

function normalize(s) {
  const o = s && typeof s === 'object' ? s : {};
  return {
    enabled: o.enabled !== false,
    at: AT.test(String(o.at || '')) ? o.at : DEFAULTS.at,
    keepNightly: intIn(o.keepNightly, 1, 60, DEFAULTS.keepNightly),
    keepWeekly: intIn(o.keepWeekly, 0, 52, DEFAULTS.keepWeekly),
  };
}

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw err('Expected the nightly backup settings.');
  if (typeof input.enabled !== 'boolean') throw err('Say whether nightly backups are on.');
  if (!AT.test(String(input.at || ''))) throw err('Choose a time like 03:30.');
  if (!Number.isInteger(input.keepNightly) || input.keepNightly < 1 || input.keepNightly > 60) throw err('Keep between 1 and 60 nightly backups.');
  if (!Number.isInteger(input.keepWeekly) || input.keepWeekly < 0 || input.keepWeekly > 52) throw err('Keep between 0 and 52 weekly backups.');
  return { enabled: input.enabled, at: input.at, keepNightly: input.keepNightly, keepWeekly: input.keepWeekly };
}

function runTimeFor(date, at, tz) {
  const [y, mo, d] = String(date).split('-').map(Number);
  const [h, mi] = String(at).split(':').map(Number);
  return tzm.zonedToUtcMs(y, mo, d, h, mi, 0, tz);
}

function dueDate(sched, nowMs, tz, lastDate, notBefore = -Infinity) {
  const today = tzm.localDate(tz, nowMs);
  if (lastDate && lastDate >= today) return null;
  const t = runTimeFor(today, sched.at, tz);
  return nowMs >= t && t > notBefore ? today : null;
}

function nextRun(sched, nowMs, tz, lastDate, notBefore = -Infinity) {
  const today = tzm.localDate(tz, nowMs);
  const t = runTimeFor(today, sched.at, tz);
  if ((!lastDate || lastDate < today) && t > notBefore) return Math.max(t, nowMs);
  return runTimeFor(tzm.addDays(today, 1), sched.at, tz);
}

// The Monday that starts the local week of a moment.
function weekOf(ms, tz) {
  const d = tzm.localDate(tz, ms);
  const [y, m, dd] = d.split('-').map(Number);
  return tzm.addDays(d, -((new Date(Date.UTC(y, m - 1, dd)).getUTCDay() + 6) % 7));
}

function toKeep(records, { keepNightly = DEFAULTS.keepNightly, keepWeekly = DEFAULTS.keepWeekly, tz = 'UTC' } = {}) {
  const keep = new Set();
  const dated = [];
  for (const r of records) { if (Number.isFinite(Date.parse(r.created))) dated.push(r); else keep.add(r.name); }   // what can't be dated is kept
  dated.sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
  for (const r of dated.slice(0, Math.max(1, keepNightly))) keep.add(r.name);
  // newest first, so each week's entry ends as its oldest backup; a Map keeps the weeks in order of recency
  const weeks = new Map();
  for (const r of dated) weeks.set(weekOf(Date.parse(r.created), tz), r);
  for (const r of [...weeks.values()].slice(0, keepWeekly)) keep.add(r.name);
  return keep;
}

let active = null;
function current() { return active; }

/**
 * opts: service (backup/service.js), root, zone() -> IANA zone, now(), notify(payload) (a phone notification to the
 * admins; resolves to { sent, failed }), log(msg), waitMaxMs (working agents), staleMs (no backup), retryMs (a
 * warning that wasn't delivered), tickMs, firstTickMs.
 * State (data/backup-schedule.json, this computer's): lastDate (the night last tried), notBefore, pendingDate and
 * waitingSince (a night that is due, kept across a restart), lastOkAt, lastError, alerted (warnings delivered).
 */
function createScheduler({ service, root, zone = () => 'UTC', now = Date.now, notify = async () => {}, log = () => {},
  waitMaxMs = 30 * 60000, staleMs = 3 * DAY, retryMs = 15 * 60000, tickMs = 60000, firstTickMs = 120000 } = {}) {
  const file = path.join(root, 'data', 'backup-schedule.json');
  let busy = false, revision = 0, timers = [];
  const retryAt = {};
  // What couldn't be written (a full disk is a likely reason a backup fails) is kept in memory, so a night is still
  // tried once and a warning delivered once, and the checklist still knows.
  let unsaved = {};
  const load = () => {
    let j = {};
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); if (!j || typeof j !== 'object' || Array.isArray(j)) j = {}; } catch { j = {}; }
    return { ...j, ...unsaved };
  };
  const patch = (p) => {
    const s = { ...load(), ...p };
    const tmp = `${file}.tmp-${process.pid}`;
    try { fs.writeFileSync(tmp, JSON.stringify(s, null, 1), { mode: 0o600 }); fs.renameSync(tmp, file); unsaved = {}; }
    catch (e) { unsaved = s; try { fs.rmSync(tmp, { force: true }); } catch {} log(`[backup] couldn't save the nightly backup state: ${e.message}`); }
    return s;
  };
  const iso = (ms) => new Date(ms).toISOString();
  // the newest backup this computer made (any kind), or the last nightly that worked
  const lastOk = (st, s) => Math.max(Date.parse(st.last && st.last.created) || 0, Date.parse(s.lastOkAt) || 0) || null;
  const stopped = (st) => !st.key.configured || st.needsPassword || !!(st.recovery && !st.recovery.resumedAt);
  // runs whose time had passed before this moment don't count: the first look after setup, or a change of time
  const notBeforeOf = (s, nowMs) => (s.notBefore ? Date.parse(s.notBefore) : s.lastDate ? -Infinity : nowMs);
  // a night claimed earlier (agents were working, or the hub restarted) stays due until tried: today's or yesterday's
  const claimed = (s, today) => (s.pendingDate && (s.pendingDate === today || s.pendingDate === tzm.addDays(today, -1)) && !(s.lastDate && s.lastDate >= s.pendingDate) ? s.pendingDate : null);
  const copyErrorsOf = (st) => ((st.last && st.last.places) || []).filter(p => p && p.error).map(p => ({ dir: p.dir, error: String(p.error).slice(0, 200) }));

  // A phone notification; delivered = it resolved and didn't fail on every device. Not delivered: tried again later.
  async function deliver(key, nowMs, payload) {
    let ok = false;
    try { const r = await notify({ url: '/?backups=1', ...payload }); ok = !(r && r.sent === 0 && r.failed > 0); }
    catch (e) { log(`[backup] notification failed: ${e.message}`); }
    if (ok) delete retryAt[key]; else retryAt[key] = nowMs + retryMs;
    return ok;
  }
  const mayTry = (key, nowMs) => !(retryAt[key] > nowMs);

  // Warnings: a failed night (once it is delivered), and no backup for 3 days (once per stretch). Not while backups are
  // stopped on purpose or paused after a restore. The details stay on the admin page, not on a lock screen.
  async function announce(nowMs, tz) {
    const st = service.status(), sc = normalize(st.schedule), s = load(), al = s.alerted || {};
    if (!st.key.configured || (st.recovery && !st.recovery.resumedAt)) return;
    // restored with the recovery key: no backup until a new password is chosen (once per stretch)
    if (st.needsPassword) {
      if (!al.paused && mayTry('paused', nowMs) && await deliver('paused', nowMs, { title: 'Backups are paused', body: 'Choose a new backup password in Settings → Backups.', tag: 'backup-paused' })) patch({ alerted: { ...(load().alerted || {}), paused: true } });
      return;
    }
    if (al.paused) patch({ alerted: { ...(load().alerted || {}), paused: false } });
    if (s.lastError && s.lastError.date && al.fail !== s.lastError.date && mayTry('fail', nowMs)) {
      if (await deliver('fail', nowMs, { title: 'The nightly backup failed', body: 'Open Settings → Backups for the details.', tag: 'backup-failed' })) patch({ alerted: { ...(load().alerted || {}), fail: s.lastError.date } });
    }
    if (!sc.enabled) return;
    const last = lastOk(st, s);
    const since = last || Date.parse(st.key.createdAt) || nowMs;
    if (nowMs - since <= staleMs) return;
    const mark = last ? iso(last) : 'never';
    if (al.stale === mark || !mayTry('stale', nowMs)) return;
    const days = Math.floor((nowMs - since) / DAY);
    const sent = await deliver('stale', nowMs, { title: last ? `No backup for ${days} days` : 'No backup has been made yet', body: last ? `The last backup was made ${tzm.stamp(last, tz)}. Open Settings → Backups.` : 'Backups are set up, but none has been made. Open Settings → Backups.', tag: 'backup-stale' });
    if (sent) patch({ alerted: { ...(load().alerted || {}), stale: mark } });
  }

  async function nightly(nowMs, tz, rev, st, sc, s) {
    const today = tzm.localDate(tz, nowMs);
    const date = claimed(s, today) || dueDate(sc, nowMs, tz, s.lastDate, notBeforeOf(s, nowMs));
    if (!date) { if (s.pendingDate || s.waitingSince) patch({ pendingDate: null, waitingSince: null }); return; }
    if (s.pendingDate !== date) s = patch({ pendingDate: date, waitingSince: null });   // claimed: a restart picks it up
    if (st.running) return;                      // a backup or a password change is running: look again in a minute
    const since = Date.parse(s.waitingSince) || null;
    const force = !!since && nowMs - since >= waitMaxMs;
    if (rev !== revision) return;                // the schedule changed while this tick waited
    let r;
    try { r = await service.backupNow({ now: force, reason: 'nightly' }); }
    catch (e) {
      if (e && e.code === 'EBUSY') return;
      const message = String((e && e.message) || e).slice(0, 300);
      patch({ lastDate: date, pendingDate: null, waitingSince: null, lastError: { at: iso(nowMs), date, message } });
      log(`[backup] the nightly backup failed: ${message}`);
      return;
    }
    if (r && r.waiting) {
      if (!since) { patch({ waitingSince: iso(nowMs) }); log(`[backup] the nightly backup waits for ${(r.working || []).join(', ')} (up to ${Math.round(waitMaxMs / 60000)} minutes)`); }
      return;
    }
    const name = r && r.backup && r.backup.name ? r.backup.name : null;
    if (!name) {   // not a backup this can stand on: a failed night, and nothing deleted
      patch({ lastDate: date, pendingDate: null, waitingSince: null, lastError: { at: iso(nowMs), date, message: 'The backup finished without a file name.' } });
      return;
    }
    patch({ lastDate: date, pendingDate: null, waitingSince: null, lastOkAt: iso(now()), lastError: null, lastName: name });
    if (rev !== revision) return;                // new keep counts while it ran: the next night uses them
    const cur = normalize(service.status().schedule);
    try {
      const k = await service.applyRetention({ keepNightly: cur.keepNightly, keepWeekly: cur.keepWeekly, tz, justMade: name });
      if (k && k.deleted && k.deleted.length) log(`[backup] removed ${k.deleted.length} older nightly backup${k.deleted.length === 1 ? '' : 's'}`);
      // a skipped pass is shown on the page and in the checklist (a disk filling up quietly is worse than a warning);
      // cleared only by a pass that ran (one skipped because something else was busy says nothing new)
      if (k && k.why) patch({ keepSkipped: { at: iso(now()), why: k.why } });
      else if (k && !k.skipped) patch({ keepSkipped: null });
      if (k && k.why) log(`[backup] older nightly backups kept: ${k.why}`);
    } catch (e) { patch({ keepSkipped: { at: iso(now()), why: e.message } }); log(`[backup] keeping the right backups failed: ${e.message}`); }
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const nowMs = now(), tz = zone(), rev = revision;
      const st = service.status();
      const sc = normalize(st.schedule);
      let s = load();
      if (!st.key.configured) return;
      // the first look after setup (or after an install moves): the next set time starts the count, not a backup right away
      if (!s.lastDate && !s.notBefore) s = patch({ notBefore: iso(nowMs) });
      // paused (a new password, a restore): the night that was due stays claimed; turned off: it is dropped
      if (sc.enabled && !stopped(st)) await nightly(nowMs, tz, rev, st, sc, s);
      else if (!sc.enabled && (s.pendingDate || s.waitingSince)) patch({ pendingDate: null, waitingSince: null });
      await announce(now(), tz);
    } catch (e) { log(`[backup] nightly: ${e.message}`); }
    finally { busy = false; }
  }

  function info(st = service.status(), nowMs = now()) {
    const sc = normalize(st.schedule), s = load(), tz = zone();
    const on = sc.enabled && !stopped(st), nb = notBeforeOf(s, nowMs), today = tzm.localDate(tz, nowMs);
    return {
      tz, nextRun: on ? iso(nextRun(sc, nowMs, tz, s.lastDate, nb)) : null, due: on && !!(claimed(s, today) || dueDate(sc, nowMs, tz, s.lastDate, nb)),
      waitingSince: on && s.waitingSince ? s.waitingSince : null, paused: !!(st.recovery && !st.recovery.resumedAt),
      lastOkAt: s.lastOkAt || null, lastError: s.lastError || null, copyErrors: copyErrorsOf(st), keepSkipped: s.keepSkipped || null,
    };
  }

  // A new time or a schedule turned on: a time already past today waits for tomorrow, a later one still runs today; so
  // saving never starts a backup. A tick already under way doesn't act on the old schedule.
  function rescheduled(nowMs = now()) {
    revision++;
    patch({ notBefore: iso(nowMs), pendingDate: null, waitingSince: null });
  }

  function readinessItems(nowMs = now()) {
    const st = service.status(), sc = normalize(st.schedule), s = load(), tz = zone();
    const open = { label: 'Open Backups', href: '/?backups=1' };
    if (!st.key.configured) return [{ id: 'backups', level: 'warn', title: 'Backups aren\'t set up', detail: 'Nothing here is backed up by My Maestro yet: if this disk fails or the install is deleted, the agents, their memories, sign-ins and files are lost.', fix: 'Settings → Backups: choose a backup password. A backup is then made every night.', action: open }];
    if (st.needsPassword) return [{ id: 'backups', level: 'warn', title: 'Backups are paused', detail: 'This setup was restored with the recovery key, so no backup is made until a new backup password is chosen.', fix: 'Settings → Backups: Choose a password.', action: open }];
    const items = [], last = lastOk(st, s), copies = copyErrorsOf(st);
    if (s.lastError && Date.parse(s.lastError.at) > (last || 0)) items.push({ id: 'backups-failed', level: 'warn', title: 'The last nightly backup failed', detail: s.lastError.message, fix: 'Settings → Backups: Back up now tries again.', action: open });
    if (sc.enabled && nowMs - (last || Date.parse(st.key.createdAt) || nowMs) > staleMs) items.push({ id: 'backups-stale', level: 'warn', title: last ? `No backup for ${Math.floor((nowMs - last) / DAY)} days` : 'No backup has been made yet', detail: last ? `The last backup was made ${tzm.stamp(last, tz)}.` : 'Backups are set up, but none has been made.', fix: 'Settings → Backups: Back up now, and check that the computer is on at the nightly time.', action: open });
    if (s.keepSkipped) items.push({ id: 'backups-keep', level: 'warn', title: 'Older nightly backups aren\'t being removed', detail: s.keepSkipped.why, fix: /clock/.test(s.keepSkipped.why) ? 'Check the computer\'s date and time; the backups folder fills up until this is fixed.' : 'Settings → Backups: fix the problem shown there; the tidying runs again after the next nightly backup.', action: open });
    if (copies.length) items.push({ id: 'backups-copies', level: 'warn', title: 'The last backup wasn\'t copied to every backup folder', detail: copies.map(c => `${c.dir}: ${c.error}`).join('; '), fix: 'Plug in or reconnect the folder; the next backup copies again.', action: open });
    if (!sc.enabled) items.push({ id: 'backups', level: 'info', title: 'Nightly backups are off', detail: last ? `The last backup was made ${tzm.stamp(last, tz)}.` : 'No backup has been made yet.', fix: 'Settings → Backups: When → Change… turns them on.', action: open });
    if (!items.length) items.push({ id: 'backups', level: 'ok', title: 'Backups', detail: `${last ? `Last backup ${tzm.stamp(last, tz)}` : 'No backup yet'}; next ${tzm.stamp(nextRun(sc, nowMs, tz, s.lastDate, notBeforeOf(s, nowMs)), tz)}.` });
    return items;
  }

  const api = {
    tick, info, rescheduled, readinessItems, state: load,
    start() {
      api.stop();
      timers = [setTimeout(() => { tick(); }, firstTickMs), setInterval(() => { tick(); }, tickMs)];
      for (const t of timers) if (t.unref) t.unref();
      active = api;
      return api;
    },
    stop() { for (const t of timers) { clearTimeout(t); clearInterval(t); } timers = []; if (active === api) active = null; },
  };
  return api;
}

module.exports = { DEFAULTS, normalize, validate, runTimeFor, dueDate, nextRun, weekOf, toKeep, createScheduler, current };
