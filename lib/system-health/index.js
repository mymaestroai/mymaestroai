'use strict';
// The nightly system health check: disk, inodes, memory, databases, backups, sign-ins, restarts, logs, clock and local
// models. Part A (probes.js) measures; this file judges, remembers (one JSON state file) and tells (push notices, once per problem).
const fs = require('fs');
const path = require('path');
const { createScheduler } = require('../selfcheck/schedule');

const DEFAULTS = Object.freeze({
  enabled: true, afterStart: true, checkAt: '03:15',
  diskWarnPct: 15, diskWarnGB: 20, diskCritPct: 5, diskCritGB: 5, fullInDays: 14,
  inodeWarnPct: 10, inodeCritPct: 3, backupWarnHours: 36, backupCritHours: 72,
  notify: 'critical', warnNights: 3,
});
const NOTIFY_MODES = ['critical', 'warnings', 'off'];
const GB = 1024 ** 3, MB = 1024 ** 2, KB = 1024;
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const START_DELAY_MS = 60 * 1000;
const FULL_GAP_MS = 30 * MIN;
const SAMPLE_EVERY_MS = 5 * MIN, SAMPLE_WINDOW_MS = 30 * MIN, SAMPLES_NEEDED = 5;
const KEEP_DAYS = 30, GROWTH_DAYS = 7;
const LEVEL_RANK = { critical: 0, warn: 1, unknown: 2, info: 3, ok: 4 };

const tz = () => require('../timezone');
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function fmtBytes(b) {
  if (!isNum(b)) return 'unknown';
  const a = Math.abs(b);
  if (a >= GB) return `${(b / GB).toFixed(1)} GB`;
  if (a >= MB) return `${Math.round(b / MB)} MB`;
  if (a >= KB) return `${Math.round(b / KB)} KB`;
  return `${Math.round(b)} B`;
}

/** Settings: refuses what it does not know; returns the merged full object. */
function validateSettings(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'settings must be an object' };
  for (const k of Object.keys(obj)) if (!(k in DEFAULTS)) return { ok: false, error: `unknown setting "${k}"` };
  const v = { ...DEFAULTS, ...obj };
  if (typeof v.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
  if (typeof v.afterStart !== 'boolean') return { ok: false, error: 'afterStart must be true or false' };
  if (typeof v.checkAt !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.checkAt)) return { ok: false, error: 'checkAt must be a time like 03:15' };
  const range = (k, lo, hi, what) => (isNum(v[k]) && v[k] >= lo && v[k] <= hi ? null : { ok: false, error: `${k} must be a number from ${lo} to ${hi}${what ? ` (${what})` : ''}` });
  const bad = range('diskWarnPct', 0, 100, 'percent') || range('diskCritPct', 0, 100, 'percent') || range('diskWarnGB', 0, 100000, 'GB') || range('diskCritGB', 0, 100000, 'GB')
    || range('inodeWarnPct', 0, 100, 'percent') || range('inodeCritPct', 0, 100, 'percent')
    || range('backupWarnHours', 1, 1000) || range('backupCritHours', 1, 1000) || range('fullInDays', 1, 365) || range('warnNights', 1, 30);
  if (bad) return bad;
  if (!Number.isInteger(v.warnNights)) return { ok: false, error: 'warnNights must be a whole number from 1 to 30' };
  if (v.diskCritPct > v.diskWarnPct) return { ok: false, error: 'diskCritPct must not be more than diskWarnPct' };
  if (v.diskCritGB > v.diskWarnGB) return { ok: false, error: 'diskCritGB must not be more than diskWarnGB' };
  if (v.inodeCritPct > v.inodeWarnPct) return { ok: false, error: 'inodeCritPct must not be more than inodeWarnPct' };
  if (v.backupCritHours < v.backupWarnHours) return { ok: false, error: 'backupCritHours must not be less than backupWarnHours' };
  if (!NOTIFY_MODES.includes(v.notify)) return { ok: false, error: `notify must be one of: ${NOTIFY_MODES.join(', ')}` };
  const out = {}; for (const k of Object.keys(DEFAULTS)) out[k] = v[k];
  return { ok: true, value: out };
}

const emptyState = () => ({ lastRun: null, lastFullRun: null, items: [], readings: { disk: {}, db: {} }, starts: [], notices: {}, lastNightlyDate: null });

function createSystemHealth(deps = {}) {
  const d = {
    probes: {}, stateFile: null, settings: () => undefined, now: () => Date.now(), zone: () => 'America/New_York',
    paths: () => ({ disk: [], bigFolders: [], databases: [], logs: [] }),
    backupState: () => null, signIns: async () => [], localModels: async () => ({ installed: false, answers: null }),
    notify: async () => ({}), log: () => {}, limitMs: 120000,
    nodeSecurity: () => null, platform: process.platform,
    ...deps,
  };
  const log = (m) => { try { d.log(m); } catch { /* logging never stops a run */ } };
  const iso = (ms) => new Date(ms).toISOString();
  const zone = () => { try { return d.zone() || 'UTC'; } catch { return 'UTC'; } };
  const today = (ms = d.now()) => tz().localDate(zone(), ms);

  // ── Settings ──
  const warned = new Set();
  function settings() {
    let raw; try { raw = d.settings(); } catch { raw = undefined; }
    const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const known = {};
    for (const k of Object.keys(obj)) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) known[k] = obj[k];
      else if (!warned.has(k)) { warned.add(k); log(`[health] settings: unknown setting "${k}" ignored`); }
    }
    const v = validateSettings(known);
    if (v.ok) return v.value;
    const out = { ...DEFAULTS };
    for (const k of Object.keys(known)) {
      const one = validateSettings({ [k]: known[k] });
      if (one.ok) out[k] = one.value[k];
      else { const m = `${one.error}; the default is used for ${k}`; if (!warned.has(m)) { warned.add(m); log(`[health] settings: ${m}`); } }
    }
    // a combination that does not hold (crit above warn) falls back to the defaults for the pair
    return validateSettings(out).ok ? out : { ...DEFAULTS };
  }

  // ── State file ──
  let state = null;
  function load() {
    if (state) return state;
    const file = d.stateFile;
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      if (e.code !== 'ENOENT') { aside(file, e.message); }
      state = emptyState(); return state;
    }
    try {
      const o = JSON.parse(text);
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('not an object');
      state = { ...emptyState(), ...o };
      if (!Array.isArray(state.items)) state.items = [];
      if (!Array.isArray(state.starts)) state.starts = [];
      if (!state.notices || typeof state.notices !== 'object' || Array.isArray(state.notices)) state.notices = {};
      if (!state.readings || typeof state.readings !== 'object' || Array.isArray(state.readings)) state.readings = {};
      if (!state.readings.disk || typeof state.readings.disk !== 'object') state.readings.disk = {};
      if (!state.readings.db || typeof state.readings.db !== 'object') state.readings.db = {};
    } catch (e) { aside(file, e.message); state = emptyState(); }
    return state;
  }
  function aside(file, why) {
    try { fs.copyFileSync(file, `${file}.bad`); log(`[health] ${file} could not be read (${why}); a copy was kept as ${path.basename(file)}.bad and the check starts fresh`); }
    catch (e) { log(`[health] ${file} could not be read (${why}) and could not be copied aside: ${e.message}`); }
  }
  function save() {
    const file = d.stateFile; if (!file) return false;
    const dir = path.dirname(file);
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(16).slice(2, 8)}.tmp`);
    let fd = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fd = fs.openSync(tmp, 'w', 0o600);
      fs.writeSync(fd, JSON.stringify(load(), null, 2));
      fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } }
      try { fs.unlinkSync(tmp); } catch { /* never made */ }
      log(`[health] could not save ${file}: ${e.message}`);
      return false;
    }
  }

  // ── Probe wrapper: its own overall time limit; never throws ──
  function guard(fn, ms = d.limitMs) {
    return new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: `ran out of time (${Math.round(ms / 1000)} s)` }); } }, ms);
      const fin = (r) => { if (done) return; done = true; clearTimeout(t); resolve(r); };
      try { Promise.resolve(fn()).then((value) => fin({ ok: true, value }), (e) => fin({ ok: false, error: (e && e.message) || String(e) })); }
      catch (e) { fin({ ok: false, error: (e && e.message) || String(e) }); }
    });
  }

  const mk = (check, id, level, title, detail = '', fix = '') => ({ id, check, level, title, detail, fix, since: null });
  const unknownItem = (check, id, what, why) => mk(check, id, 'unknown', `${what} couldn't be checked`, why ? `The check failed: ${why}.` : '', 'It will be tried again at the next check. If this keeps happening, restart your Maestro.');
  const getPaths = () => {
    let p; try { p = d.paths() || {}; } catch (e) { log(`[health] paths failed: ${e.message}`); p = {}; }
    return { disk: p.disk || [], bigFolders: p.bigFolders || [], databases: p.databases || [], logs: p.logs || [] };
  };

  // ── Daily readings: { date, <field> } per key, one per local date, 30 days ──
  function addReading(map, key, field, value, nowMs) {
    const date = today(nowMs), cutoff = tz().addDays(date, -KEEP_DAYS);
    const list = (Array.isArray(map[key]) ? map[key] : []).filter(r => r && r.date && r.date >= cutoff && r.date !== date);
    list.push({ date, [field]: value });
    list.sort((a, b) => (a.date < b.date ? -1 : 1));
    map[key] = list;
    return list;
  }
  /** The oldest reading within the last 7 days and the days to today; null when under 2 days apart. */
  function oldestWithin(list, field, nowMs) {
    const date = today(nowMs), from = tz().addDays(date, -GROWTH_DAYS);
    const first = list.find(r => r.date >= from && isNum(r[field]));
    if (!first) return null;
    const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${first.date}T00:00:00Z`)) / DAY);
    return days >= 2 ? { first, days } : null;
  }

  // ── Memory samples (in memory only) ──
  let samples = [];
  const isHeavy = (m) => {
    if (!m) return false;
    // swap half used counts only while memory is also short: idle pages swapped out on a roomy machine (and macOS's
    // small dynamic swap) are no sign of trouble
    const avail = isNum(m.totalBytes) && m.totalBytes > 0 && isNum(m.availableBytes) ? m.availableBytes / m.totalBytes : null;
    const swap = isNum(m.swapTotalBytes) && m.swapTotalBytes > 0 && isNum(m.swapUsedBytes) && m.swapUsedBytes >= 0.5 * m.swapTotalBytes && avail !== null && avail < 0.25;
    const low = avail !== null && avail < 0.1;
    return !!(swap || low);
  };
  async function sampleMemory() {
    const r = await guard(() => d.probes.memory());
    const at = d.now();
    if (r.ok && r.value) samples.push({ at, m: r.value });
    samples = samples.filter(s => at - s.at <= SAMPLE_WINDOW_MS);
    return r.ok;
  }

  // ── The checks ──
  function diskItems(res, set, full, nowMs, st) {
    const items = [], problems = [];
    for (const fs_ of (res && res.filesystems) || []) {
      const labels = fs_.labels || [], key = fs_.key || labels.slice().sort().join('+');
      const where = labels.length ? `Folders on it: ${labels.join(', ')}.` : '';
      if (!(isNum(fs_.totalBytes) && fs_.totalBytes > 0 && isNum(fs_.availBytes) && isNum(fs_.availPct))) {   // a size it doesn't report is never read as "full"
        items.push(unknownItem('disk', `health-disk-${key}`, `Disk space for ${labels.join(', ') || 'a folder'}`, 'the disk didn\'t report its size'));
        continue;
      }
      const list = addReading(st.readings.disk, key, 'availBytes', fs_.availBytes, nowMs);
      const crit = fs_.availPct < set.diskCritPct || fs_.availBytes < set.diskCritGB * GB;
      const warn = fs_.availPct < set.diskWarnPct || fs_.availBytes < set.diskWarnGB * GB;
      let level = crit ? 'critical' : warn ? 'warn' : 'ok';
      let growth = '';
      const g = oldestWithin(list, 'availBytes', nowMs);
      if (g) {
        const rate = (g.first.availBytes - fs_.availBytes) / g.days;
        if (rate > 0) {
          const daysLeft = fs_.availBytes / rate;
          if (daysLeft < set.fullInDays) {
            growth = `At the last ${GROWTH_DAYS} days' rate, full in about ${Math.max(1, Math.round(daysLeft))} days.`;
            if (level === 'ok') level = 'warn';
          }
        }
      }
      const free = `${fmtBytes(fs_.availBytes)} free (${Math.round(fs_.availPct)}%)`;
      const title = level === 'critical' ? `Disk almost full: ${free}` : level === 'warn' ? `Disk getting full: ${free}` : `Disk has room: ${free}`;
      const it = mk('disk', `health-disk-${key}`, level, title, [where, growth].filter(Boolean).join(' '),
        level === 'ok' ? '' : `Clear space on ${labels.join(', ') || 'this disk'}: delete old files, logs or workspaces you don't need, or move them to another disk.`);
      items.push(it);
      if (level !== 'ok') problems.push(it);
      const inFree = fs_.inodesFreePct;
      if (isNum(inFree)) {
        const ic = inFree < set.inodeCritPct, iw = inFree < set.inodeWarnPct;
        const lv = ic ? 'critical' : iw ? 'warn' : 'ok';
        items.push(mk('inodes', `health-inodes-${key}`, lv,
          lv === 'ok' ? `File slots are fine: ${Math.round(inFree)}% free` : `Disk is almost out of file slots: ${Math.round(inFree)}% free`,
          where, lv === 'ok' ? '' : `Delete lots of small files you don't need (old caches, logs, workspaces) on ${labels.join(', ') || 'this disk'}.`));
      } else if (st.notices[`health-inodes-${key}`]) {
        // a known problem whose numbers didn't come this time is not "fixed"
        items.push(unknownItem('inodes', `health-inodes-${key}`, `File slots on ${labels.join(', ') || 'this disk'}`, 'the disk didn\'t report its file slots'));
      }
    }
    for (const e of (res && res.errors) || []) items.push(unknownItem('disk', `health-disk-error-${e.label}`, `Disk space for ${e.label}`, e.error));
    return { items, problems };
  }

  // ── Operating-system updates ──
  const OS_FIX = {
    apt: 'Run sudo apt upgrade, then restart when convenient.',
    dnf: 'Run sudo dnf upgrade --security, then restart when convenient.',
    zypper: 'Run sudo zypper patch -g security, then restart when convenient.',
    softwareupdate: 'Open System Settings → General → Software Update.',
  };
  const OS_WAIT_DAYS = 7, LISTS_OLD_DAYS = 7;
  const days = (ms) => Math.floor(ms / DAY);
  /** A warning that has waited more than 7 days becomes critical (the notice remembers when it began). */
  function escalate(it, nowMs, st) {
    const n = st.notices[it.id], since = n && Date.parse(n.since);
    if (it.level === 'warn' && Number.isFinite(since) && nowMs - since > OS_WAIT_DAYS * DAY) {
      it.level = 'critical';
      it.title = `${it.title} (waiting ${plural(days(nowMs - since), 'day')})`;
    }
    return it;
  }
  async function osChecks({ nowMs, st, items, attempted, resolvable }) {
    for (const c of ['os-updates', 'os-lists', 'os-restart']) attempted.add(c);
    const what = 'Operating-system updates';
    const r = await guard(() => d.probes.osUpdates({ timeoutMs: Math.max(1000, d.limitMs - 10000) }));
    const o = r.ok && r.value && typeof r.value === 'object' ? r.value : null;
    if (!o || !o.kind) { items.push(unknownItem('os-updates', 'health-os-updates', what, o ? o.error || 'no package manager it recognises' : (r.ok ? 'no answer' : r.error))); return; }
    resolvable.add('os-updates');
    const listAge = isNum(o.listsRefreshedAt) ? nowMs - o.listsRefreshedAt : null;
    const fix = OS_FIX[o.kind] || '';
    const detail = listAge !== null ? `Update lists last refreshed ${plural(Math.max(0, days(listAge)), 'day')} ago.` : '';
    if (!isNum(o.security)) items.push(unknownItem('os-updates', 'health-os-updates', what, o.error || 'no answer'));
    else if (isNum(o.critical) && o.critical > 0) items.push(escalate(mk('os-updates', 'health-os-updates', 'critical', `${o.critical} critical security ${o.critical === 1 ? 'update is' : 'updates are'} waiting`, detail, fix), nowMs, st));
    // macOS marks updates "recommended", not "security": named as such, and they stay a warning however long they wait
    else if (o.security > 0 && o.kind === 'softwareupdate') items.push(mk('os-updates', 'health-os-updates', 'warn', `${o.security} recommended ${o.security === 1 ? 'update is' : 'updates are'} waiting`, detail, fix));
    else if (o.security > 0) items.push(escalate(mk('os-updates', 'health-os-updates', 'warn', `${o.security} security ${o.security === 1 ? 'update is' : 'updates are'} waiting`, detail, fix), nowMs, st));
    else items.push(mk('os-updates', 'health-os-updates', 'ok', `No security updates waiting${isNum(o.pending) && o.pending > 0 ? `; ${plural(o.pending, 'other update')}` : ''}`, detail));
    if (listAge !== null) {
      resolvable.add('os-lists');
      if (listAge > LISTS_OLD_DAYS * DAY) items.push(mk('os-lists', 'health-os-lists', 'warn', `The list of available updates is ${plural(days(listAge), 'day')} old`, '', 'Run sudo apt update (or turn on automatic updates), so new security fixes are seen.'));
    }
    if (o.restartRequired === true || o.restartRequired === false) {
      resolvable.add('os-restart');
      if (o.restartRequired) {
        const pk = Array.isArray(o.restartPkgs) ? o.restartPkgs.slice(0, 10) : [];
        items.push(mk('os-restart', 'health-os-restart', 'warn', 'A restart is needed to finish installing updates', pk.length ? `Updated: ${pk.join(', ')}.` : '', 'Restart the computer when convenient; your Maestro comes back by itself if it runs as a service.'));
      } else items.push(mk('os-restart', 'health-os-restart', 'ok', 'No restart needed for updates'));
    }
  }
  function nodeCheck({ nowMs, st, items, attempted, resolvable }) {
    attempted.add('node');
    let ns = null; try { ns = d.nodeSecurity(); } catch (e) { log(`[health] nodeSecurity failed: ${e && e.message}`); }
    if (!ns || typeof ns !== 'object') return;
    resolvable.add('node');
    if (!ns.behind) { items.push(mk('node', 'health-node', 'ok', `Node.js ${ns.version} has the current security fixes`)); return; }
    const detail = [ns.date ? `published ${ns.date}` : '', ns.rated ? `rated ${ns.rated}` : '', ns.floor ? `fixed in ${ns.floor}` : ''].filter(Boolean).join(', ');
    const lv = /critical/i.test(String(ns.rated || '')) ? 'critical' : 'warn';
    items.push(escalate(mk('node', 'health-node', lv, `Node.js ${ns.version} is missing security fixes`, detail ? `${detail[0].toUpperCase()}${detail.slice(1)}.` : '', ns.how || ''), nowMs, st));
  }

  async function runChecks({ full, trigger, nowMs, set, st }) {
    const items = [];            // new items of the checks measured this run
    const attempted = new Set(); // checks this run replaces
    const resolvable = new Set(); // checks that were measured: an absent item means it is gone
    const P = getPaths();
    const add = (check, list) => { attempted.add(check); for (const i of list) items.push(i); };

    // disk + inodes
    attempted.add('disk'); attempted.add('inodes');
    const dr = await guard(() => d.probes.disk(P.disk));
    if (!dr.ok) { items.push(unknownItem('disk', 'health-disk', 'Disk space', dr.error)); }
    else {
      const { items: di, problems } = diskItems(dr.value, set, full, nowMs, st);
      for (const i of di) items.push(i);
      if (!((dr.value && dr.value.errors) || []).length) { resolvable.add('disk'); resolvable.add('inodes'); }
      if (full && problems.length) {
        const fr = await guard(() => d.probes.folderSizes(P.bigFolders));
        if (fr.ok && Array.isArray(fr.value)) {
          const top = fr.value.filter(f => f && isNum(f.bytes)).sort((a, b) => b.bytes - a.bytes).slice(0, 5);
          if (top.length) for (const p of problems) p.detail = [p.detail, `Largest: ${top.map(f => `${f.label} ${fmtBytes(f.bytes)}`).join(', ')}.`].filter(Boolean).join(' ');
        } else if (!fr.ok) log(`[health] folder sizes failed: ${fr.error}`);
      }
    }

    // memory
    attempted.add('memory');
    const mr = await guard(() => d.probes.memory());
    if (!mr.ok || !mr.value) items.push(unknownItem('memory', 'health-memory', 'Memory', mr.ok ? 'no answer' : mr.error));
    else {
      resolvable.add('memory');
      const m = mr.value;
      const recent = samples.filter(s => nowMs - s.at <= SAMPLE_WINDOW_MS);
      const sustained = recent.length >= SAMPLES_NEEDED && recent.every(s => isHeavy(s.m));
      const nums = `${fmtBytes(m.availableBytes)} of ${fmtBytes(m.totalBytes)} free${isNum(m.swapTotalBytes) && m.swapTotalBytes > 0 ? `; swap ${fmtBytes(m.swapUsedBytes)} of ${fmtBytes(m.swapTotalBytes)} used` : ''}.`;
      items.push(sustained
        ? mk('memory', 'health-memory', 'warn', 'Memory has been tight for the last 30 minutes', nums, 'Close programs you don\'t need, or restart your Maestro. If it keeps happening, add memory.')
        : mk('memory', 'health-memory', 'ok', 'Memory is fine', nums));
    }

    // sign-ins
    attempted.add('signin');
    const sr = await guard(() => d.signIns());
    if (!sr.ok || !Array.isArray(sr.value)) items.push(unknownItem('signin', 'health-signin', 'Sign-ins', sr.ok ? 'no answer' : sr.error));
    else {
      resolvable.add('signin');
      for (const s of sr.value) {
        if (!s || !(s.agents > 0)) continue;
        const id = `health-signin-${s.id}`;
        if (s.signedIn === false) items.push(mk('signin', id, 'critical', `${s.name} is not signed in: ${plural(s.agents, 'agent')} can't answer`, '', `Open Settings and sign in to ${s.name} again.`));
        else if (s.signedIn === null || s.signedIn === undefined) items.push(unknownItem('signin', id, `The ${s.name} sign-in`, 'no answer'));
        else items.push(mk('signin', id, 'ok', `${s.name} is signed in`, ''));
      }
    }

    if (!full) return { items, attempted, resolvable };

    // operating-system updates and the Node.js security watch (full runs only; on macOS the slow softwareupdate waits for a full run that isn't the start run)
    if (typeof d.probes.osUpdates === 'function' && !(d.platform === 'darwin' && trigger === 'start')) await osChecks({ nowMs, st, items, attempted, resolvable });
    nodeCheck({ nowMs, st, items, attempted, resolvable });

    // databases
    attempted.add('db'); resolvable.add('db');
    for (const entry of P.databases) {
      // { file, name } (name = its path inside data/, so two files with one name in different folders stay apart), or a path
      const file = entry && typeof entry === 'object' ? entry.file : entry;
      const base = entry && typeof entry === 'object' && entry.name ? String(entry.name) : path.basename(String(file)), id = `health-db-${base}`;
      const r = await guard(() => d.probes.dbCheck(file));
      if (!r.ok || !r.value) { items.push(unknownItem('db', id, `The ${base} database`, r.ok ? 'no answer' : r.error)); continue; }
      const v = r.value;
      if (v.ok === false) items.push(mk('db', id, 'critical', `A database is damaged: ${base}`, String(v.result || '').slice(0, 300), 'Restore it from a backup: Settings → Backups. Don\'t delete it.'));
      else if (v.ok === null || v.ok === undefined) items.push(unknownItem('db', id, `The ${base} database`, v.result));
      else {
        let detail = isNum(v.bytes) ? `Size ${fmtBytes(v.bytes)}.` : '';
        if (isNum(v.bytes)) {
          const list = addReading(st.readings.db, base, 'bytes', v.bytes, nowMs);
          const g = oldestWithin(list, 'bytes', nowMs);
          if (g) detail += ` ${v.bytes >= g.first.bytes ? 'Grew' : 'Shrank'} ${fmtBytes(Math.abs(v.bytes - g.first.bytes))} in the last ${g.days} days.`;
        }
        items.push(mk('db', id, 'ok', `Database is fine: ${base}`, detail));
      }
    }

    // backups
    attempted.add('backups'); resolvable.add('backups');
    let bs = null; try { bs = d.backupState(); } catch (e) { log(`[health] backupState failed: ${e.message}`); }
    if (bs) {
      if (bs.enabled === false) items.push(mk('backups', 'health-backups', 'info', 'Nightly backups are off', '', 'Turn them on in Settings → Backups.'));
      else {
        // with no backup yet, the wait counts from when backups were set up (as the backup page's own check does), so a
        // fresh setup isn't an alarm before its first night
        const last = bs.lastOkAt ? Date.parse(bs.lastOkAt) : NaN, setUp = bs.setUpAt ? Date.parse(bs.setUpAt) : NaN;
        const from = Number.isFinite(last) ? last : setUp;
        const ageH = Number.isFinite(from) ? Math.max(0, nowMs - from) / HOUR : Infinity;
        const fix = 'Open Settings → Backups and run a backup now. If it fails, read the reason there.';
        const what = Number.isFinite(last) ? `The last backup was ${Math.floor(ageH)} hours ago` : Number.isFinite(setUp) ? `No backup has finished in the ${Math.floor(ageH)} hours since backups were set up` : 'No backup has finished yet';
        const lv = ageH >= set.backupCritHours ? 'critical' : ageH >= set.backupWarnHours ? 'warn' : 'ok';
        items.push(mk('backups', 'health-backups', lv, lv === 'ok' ? `Backups are working: ${what.toLowerCase()}` : what, lv === 'ok' ? '' : `Backups should finish at least every ${set.backupWarnHours} hours.`, lv === 'ok' ? '' : fix));
      }
    }

    // restarts
    attempted.add('restarts'); resolvable.add('restarts');
    const n24 = st.starts.filter(t => isNum(t) && nowMs - t <= DAY).length;
    const rl = n24 >= 20 ? 'critical' : n24 >= 6 ? 'warn' : 'ok';
    items.push(mk('restarts', 'health-restarts', rl, `Your Maestro restarted ${plural(n24, 'time')} in the last 24 hours`, rl === 'ok' ? '' : 'Something keeps stopping it.', rl === 'ok' ? '' : 'Look at the log for the reason it stops, or ask for help.'));

    // logs
    attempted.add('logs');
    const lr = await guard(() => d.probes.fileSizes(P.logs));
    if (!lr.ok || !Array.isArray(lr.value)) items.push(unknownItem('logs', 'health-logs', 'The log files', lr.ok ? 'no answer' : lr.error));
    else {
      resolvable.add('logs');
      const files = lr.value.filter(f => f && isNum(f.bytes));
      const unreadable = lr.value.filter(f => f && !isNum(f.bytes) && !f.missing);   // a missing log is fine; one it couldn't read says nothing
      const total = files.reduce((a, f) => a + f.bytes, 0);
      const big = files.filter(f => f.bytes > GB).sort((a, b) => b.bytes - a.bytes);
      if (big.length) items.push(mk('logs', 'health-logs', 'warn', `A log file is very large: ${path.basename(big[0].path)} ${fmtBytes(big[0].bytes)}`, `All logs together: ${fmtBytes(total)}.${big.length > 1 ? ` ${big.length} files are over 1 GB.` : ''}`, 'Delete or archive the old log file, then restart your Maestro.'));
      else if (unreadable.length && st.notices['health-logs']) items.push(unknownItem('logs', 'health-logs', 'The log files', `${unreadable.map(f => path.basename(f.path)).join(', ')} couldn't be read`));
      else {
        const top = files.slice().sort((a, b) => b.bytes - a.bytes)[0];
        items.push(mk('logs', 'health-logs', 'ok', `Logs are a normal size: ${fmtBytes(total)} together`, top ? `Largest: ${path.basename(top.path)} ${fmtBytes(top.bytes)}.` : ''));
      }
    }

    // clock
    attempted.add('clock');
    const cr = await guard(() => d.probes.clock());
    if (!cr.ok || !cr.value) items.push(unknownItem('clock', 'health-clock', 'The clock', cr.ok ? 'no answer' : cr.error));
    else {
      resolvable.add('clock');
      if (cr.value.synced === false) items.push(mk('clock', 'health-clock', 'warn', 'This computer\'s clock isn\'t synced', 'A wrong clock breaks schedules and sign-ins.', 'Turn on automatic time in the computer\'s date and time settings.'));
      else if (cr.value.synced === true) items.push(mk('clock', 'health-clock', 'ok', 'The clock is synced'));
      else if (st.notices['health-clock']) items.push(unknownItem('clock', 'health-clock', 'The clock', 'it didn\'t say whether it is synced'));   // not "fixed" without an answer
      else items.push(mk('clock', 'health-clock', 'info', 'This computer doesn\'t report clock sync'));
    }

    // local models
    attempted.add('local-models');
    const lm = await guard(() => d.localModels());
    if (!lm.ok || !lm.value) items.push(unknownItem('local-models', 'health-local-models', 'The local models', lm.ok ? 'no answer' : lm.error));
    else {
      resolvable.add('local-models');
      if (lm.value.installed) {
        if (lm.value.answers === false) items.push(mk('local-models', 'health-local-models', 'warn', 'Your local models aren\'t answering', 'They are installed but don\'t reply.', 'Start the local model program, or restart your Maestro.'));
        else if (lm.value.answers === null || lm.value.answers === undefined) items.push(unknownItem('local-models', 'health-local-models', 'The local models', 'no answer'));
        else items.push(mk('local-models', 'health-local-models', 'ok', 'Local models are answering'));
      }
    }
    return { items, attempted, resolvable };
  }

  // ── Notices ──
  async function send(payload, urgency) {
    try { await d.notify(payload, { urgency }); return true; }
    catch (e) { log(`[health] notice "${payload.title}" not delivered: ${(e && e.message) || e}; it will be tried again at the next check`); return false; }
  }

  async function judge(items, resolvable, { nightly, nowMs, set, st }) {
    const date = today(nowMs);
    const seen = new Set();
    for (const it of items) {
      seen.add(it.id);
      let n = st.notices[it.id];
      if (it.level === 'warn' || it.level === 'critical') {
        if (!n) n = st.notices[it.id] = { level: it.level, since: iso(nowMs), nights: 0, notifiedLevel: null, notifiedAt: null, title: it.title, check: it.check, lastNightDate: null };
        n.level = it.level; n.title = it.title; n.check = it.check;
        it.since = n.since;
        if (nightly && n.lastNightDate !== date) { n.nights = (n.nights || 0) + 1; n.lastNightDate = date; }
        if (it.level === 'critical') {
          if (set.notify !== 'off' && n.notifiedLevel !== 'critical') {
            if (await send({ title: `Health: ${it.title}`, body: `${it.detail}\n${it.fix}`, url: '/?health=1', tag: `health-${it.id}` }, 'high')) { n.notifiedLevel = 'critical'; n.notifiedAt = iso(d.now()); }
          }
        } else if (set.notify === 'warnings' && n.nights >= set.warnNights && !n.notifiedLevel) {
          if (await send({ title: `Health: ${it.title}`, body: `${it.detail}\n${it.fix}`, url: '/?health=1', tag: `health-${it.id}` }, 'normal')) { n.notifiedLevel = 'warn'; n.notifiedAt = iso(d.now()); }
        }
      } else if (it.level === 'ok' || it.level === 'info') {
        if (n) await resolve(it.id, n, set, st);
      } else if (n) it.since = n.since;   // unknown: nothing changes
    }
    for (const [id, n] of Object.entries(st.notices)) {
      if (seen.has(id)) continue;
      if (resolvable.has(n.check)) await resolve(id, n, set, st);
    }
  }
  async function resolve(id, n, set, st) {
    if (n.notifiedLevel && set.notify !== 'off') {
      const ok = await send({ title: 'Health: fixed', body: `Back to normal: ${n.title}.`, url: '/?health=1', tag: `health-${id}` }, 'normal');
      if (!ok) return;   // kept: the next run tells again
    }
    delete st.notices[id];
  }

  // ── A run ──
  let running = null;
  async function doRun(trigger, full) {
    const set = settings(), st = load(), startedAt = d.now();
    const r = await runChecks({ full, trigger, nowMs: startedAt, set, st });
    const carried = (st.items || []).filter(i => i && !r.attempted.has(i.check));
    const items = [...carried, ...r.items];
    await judge(items, r.resolvable, { nightly: trigger === 'nightly', nowMs: startedAt, set, st });
    items.sort((a, b) => (LEVEL_RANK[a.level] - LEVEL_RANK[b.level]) || (a.id < b.id ? -1 : 1));
    const lastRun = { startedAt: iso(startedAt), finishedAt: iso(d.now()), trigger, full: !!full };
    st.items = items; st.lastRun = lastRun; if (full) st.lastFullRun = lastRun;
    save();
  }
  function run({ trigger = 'manual', full = true } = {}) {
    if (running) return running;
    if (!settings().enabled) return Promise.resolve(view());
    running = doRun(trigger, full !== false)
      .catch((e) => { log(`[health] run failed: ${(e && e.stack) || e}`); })
      .then(() => { running = null; return view(); });
    return running;
  }
  const isRunning = () => !!running;

  // ── What people see ──
  function view() {
    const st = load();
    const items = (st.items || []).map(i => {
      const n = st.notices[i.id];
      return { id: i.id, check: i.check, level: i.level, title: i.title, detail: i.detail || '', fix: i.fix || '', since: i.since || null, notified: !!(n && n.notifiedLevel) };
    });
    return {
      settings: settings(), running: isRunning(), lastRun: st.lastRun || null, items,
      critical: items.filter(i => i.level === 'critical').length, warnings: items.filter(i => i.level === 'warn').length,
    };
  }
  const problems = () => (load().items || []).filter(i => i.level === 'warn' || i.level === 'critical');
  const readinessItems = () => problems().filter(i => !i.id.startsWith('health-signin-')).map(i => ({ id: i.id, level: i.level, title: i.title, detail: i.detail || '', fix: i.fix || '' }));
  const briefItems = () => problems().map(i => ({ id: i.id, level: i.level, title: i.title, detail: i.detail || '', fix: i.fix || '', since: i.since || null }));
  const bannerItems = () => problems().filter(i => i.level === 'critical' && !i.id.startsWith('health-signin-')).map(i => ({ id: i.id, level: i.level, title: i.title, detail: i.detail || '', fix: i.fix || '', since: i.since || null }));

  // ── Scheduling ──
  let startTimer = null, sampleTimer = null;
  const sched = createScheduler({
    now: () => d.now(), zone, settings,
    getStored: () => { const s = load(); return { lastRun: s.lastFullRun, lastNightlyDate: s.lastNightlyDate }; },
    setStored: (p) => { const s = load(); if ('lastNightlyDate' in p) s.lastNightlyDate = p.lastNightlyDate; save(); },
    isRunning, run: (a) => run({ trigger: a.trigger, full: true }), log, label: 'health', slotField: 'checkAt',
  });

  function stop() {
    if (startTimer) { clearTimeout(startTimer); startTimer = null; }
    if (sampleTimer) { clearInterval(sampleTimer); sampleTimer = null; }
    sched.stop();
  }
  function start() {
    stop();
    const st = load(), nowMs = d.now();
    st.starts = [...st.starts.filter(t => isNum(t) && nowMs - t <= 7 * DAY), nowMs];
    save();
    const set = settings();
    // the nightly schedule and the memory samples are always armed: each looks at "enabled" when it fires, so checks
    // turned on later in Settings run that night without a restart
    sched.schedule();
    sampleTimer = setInterval(() => { if (settings().enabled) sampleMemory().catch(() => {}); }, SAMPLE_EVERY_MS);
    if (sampleTimer.unref) sampleTimer.unref();
    if (!set.enabled) return;
    if (set.afterStart) {
      startTimer = setTimeout(() => {
        startTimer = null;
        const last = load().lastFullRun, t = last ? Date.parse(last.startedAt) : NaN;
        const full = !(t > 0) || d.now() - t >= FULL_GAP_MS;
        Promise.resolve(run({ trigger: 'start', full })).catch(e => log(`[health] start run failed: ${e && e.message}`));
      }, START_DELAY_MS);
      if (startTimer.unref) startTimer.unref();
    }
  }

  return { run, isRunning, settings, view, readinessItems, briefItems, bannerItems, start, stop, sampleMemory };
}

module.exports = { createSystemHealth, validateSettings, DEFAULTS };
