'use strict';
/**
 * backup/apply.js — restoring, step two: the swap, done at start-up before anything reads .env or opens a database.
 *
 *   confirm({ root, id, ... })   a prepared restore (restore.js) becomes a journal of moves (<install>/.restore/journal.json);
 *                                the caller then restarts the hub
 *   applyAtBoot(env)             first thing in server.js: carries out a waiting journal, or finishes / rolls back one a
 *                                crash interrupted; counts starts of a restored setup and rolls it back after two failed
 *                                starts; prunes what is no longer needed. It throws only when it could neither finish nor
 *                                roll back: the caller must then stop instead of starting on a half-swapped install.
 *   markHealthy(env)             the restored setup started fine: the 7-day undo clock starts (last-restore.json)
 *   confirmUndo(env)             puts the previous setup back (a journal of the reverse moves), at the next start
 *
 * Every step is written to the journal before the next one, and recovery decides from what is actually on disk. Copies set
 * aside sit beside what they replace, on the same disk (<install>/.restore/aside-<id>, <hub home>/.restore-aside-<id>,
 * <home>/.mymaestro-restore-aside-<id>), so setting aside and rolling back are always renames. Only placing a file from the
 * staging folder can cross disks: it is then copied beside its destination, flushed, renamed into place, and only then
 * removed from staging. Just before the first move, today's accounts are merged into what comes back (accounts.js), so a
 * password changed or a token revoked after the restore was prepared still holds. Nothing is deleted until the undo window
 * has passed.
 *
 * Loaded before .env: no requires that read settings or the environment when loaded (hub-home, restore are loaded lazily).
 */
const fs = require('fs');
const path = require('path');
const { restoreDirs } = require('./dirs');
const accounts = require('./accounts');

const UNDO_DAYS = 7;
const MAX_FAILED_STARTS = 2;
const STALE_MS = 24 * 3600 * 1000;   // a checked backup nobody confirmed, and uploads, are removed after a day
const err = (msg, code = 'EAPPLY') => Object.assign(new Error(msg), { code });
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function writeDurable(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  syncDir(path.dirname(file));
}
const NO_DIR_SYNC = new Set(['EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM', 'ENOSYS', 'EBADF']);   // systems that can't flush a folder; real errors stop
function syncDir(dir) { let fd; try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch (e) { if (!NO_DIR_SYNC.has(e.code)) throw e; } finally { if (fd != null) try { fs.closeSync(fd); } catch {} } }
function syncTree(p) {
  const st = fs.lstatSync(p);
  if (st.isDirectory()) { for (const n of fs.readdirSync(p)) syncTree(path.join(p, n)); syncDir(p); }
  else if (st.isFile()) { const fd = fs.openSync(p, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
}
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

// A rename. Across disks (only possible when placing from staging): onCopy() first, so a crash can tell a finished copy
// from a stray file; then a copy beside the destination, flushed, renamed into place; then the source is removed.
function move(from, to, { io = fs, onCopy = null } = {}) {
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  try { io.renameSync(from, to); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    // only placing from staging may cross disks (journaled); setting aside and rolling back must stay renames
    if (!onCopy) throw err(`The disks changed since the restore was confirmed: ${from} can't be moved to ${to} by a rename.`, 'EDISK');
    onCopy();
    const tmp = `${to}.restore-part`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(from, tmp, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    syncTree(tmp);
    fs.renameSync(tmp, to);   // beside the destination: the same disk
    syncDir(path.dirname(to));
    fs.rmSync(from, { recursive: true, force: true });
  }
  syncDir(path.dirname(to));
  syncDir(path.dirname(from));
}

// The moves for a prepared restore: every root of the backup replaces its live counterpart; live home folders the
// backup doesn't have are set aside too (a restore replaces everything, and undo brings them back).
function planMoves(prep, { root, hubHome, home, platform }) {
  const { FOLDERS } = require('../hub-home');
  const { finalPath } = require('./restore');
  const dirs = restoreDirs(root);
  const asides = { root: path.join(dirs.base, `aside-${prep.id}`), home: path.join(hubHome, `.restore-aside-${prep.id}`), ext: path.join(home, `.mymaestro-restore-aside-${prep.id}`) };
  const S = (...p) => path.join(dirs.staged, ...p);
  const moves = [];
  const add = (staged, live, where, rel) => moves.push({ staged, live, aside: path.join(asides[where], rel), asideDone: false, placed: false });
  for (const top of ['data', 'workspaces']) if (exists(S(top))) add(S(top), path.join(root, top), 'root', top);
  if (exists(S('env', '.env'))) add(S('env', '.env'), path.join(root, '.env'), 'root', 'env/.env');
  for (const f of FOLDERS) {
    if (exists(S('home', f))) add(S('home', f), path.join(hubHome, f), 'home', f);
    else if (exists(path.join(hubHome, f))) add(null, path.join(hubHome, f), 'home', f);
  }
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`, p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, r);
      else { const live = finalPath(r, { root, hubHome, home, platform }); if (live) add(p, live, 'ext', r.replace(/^external\//, '')); }
    }
  };
  if (exists(S('external'))) walk(S('external'), 'external');
  return { aside: asides.root, asides: Object.values(asides), moves };
}

// Setting aside and rolling back must be renames: each set-aside copy on the same disk as what it replaces, and no live path
// that is itself a mount point (a different disk can't be renamed away). Checked before anything moves.
function devOf(p) { for (let q = p; ; q = path.dirname(q)) { try { return fs.statSync(q).dev; } catch { if (path.dirname(q) === q) return null; } } }
function sameDisk(moves) {
  for (const m of moves) {
    if (exists(m.live)) { const st = fs.lstatSync(m.live); if (st.isDirectory() && st.dev !== devOf(path.dirname(m.live))) throw err(`${m.live} is a separate disk (a mount point), so a restore can't set it aside safely. Restore onto an install where it is an ordinary folder.`, 'EDISK'); }
    const liveDev = exists(m.live) ? fs.lstatSync(m.live).dev : devOf(path.dirname(m.live));
    if (liveDev !== devOf(m.aside)) throw err(`${m.live} is on a different disk than its set-aside folder (${path.dirname(m.aside)}), so a restore can't be undone safely there.`, 'EDISK');
  }
}
function confirm({ root, hubHome, home, platform = process.platform, id }) {
  const dirs = restoreDirs(root);
  const prep = readJson(dirs.prepared);
  if (!prep || prep.id !== id) throw err('That restore is no longer prepared here. Open and check the backup again.', 'ESTALE');
  if (!exists(dirs.staged)) throw err('The checked copy of the backup is gone. Open and check it again.', 'ESTALE');
  if (exists(dirs.journal)) throw err('A restore is already waiting for a restart.', 'EBUSY');
  const env = { root, hubHome: hubHome || prep.env.hubHome, home: home || prep.env.home, platform };
  const { aside, asides, moves } = planMoves(prep, env);
  sameDisk(moves);
  writeDurable(dirs.journal, { v: 2, kind: 'restore', id: prep.id, createdAt: new Date().toISOString(), state: 'pending', starts: 0, aside, asides, moves, backup: prep.backup, report: prep.report, mode: prep.mode, env });
  fs.rmSync(dirs.prepared, { force: true });   // each check is confirmed once; after a roll-back, open and check again
  return { id: prep.id, moves: moves.length };
}

// Today's accounts into what comes back, against the final state (the hub isn't running now). For a restore over an
// existing install, and for an undo (the previous setup keeps today's passwords, two-factor, sessions and revocations).
function mergeToday(j) {
  if (!(j.kind === 'undo' || (j.kind === 'restore' && j.mode === 'existing'))) return;
  const liveData = path.join(j.env.root, 'data');
  const m = j.moves.find(x => x.live === liveData && x.staged);
  if (!m || !exists(m.staged) || !exists(liveData)) return;
  const report = { ...(j.report || {}), accounts: { kept: [], disabled: [], added: [] }, tokens: { revoked: 0, added: 0 } };
  accounts.mergeAccounts({ live: liveData, staged: m.staged, mode: 'existing', report });
  j.report = report;
  const lset = readJson(path.join(liveData, 'settings.json')), sfile = path.join(m.staged, 'settings.json');
  const sset = readJson(sfile);
  if (sset && lset) { if (lset.backup) sset.backup = lset.backup; else delete sset.backup; writeDurable(sfile, sset); }
  // this computer's record of the backups it made, and its nightly state, are about this computer, not the backup:
  // without them its nightly backups would never be tidied, and the warnings would start from nothing
  for (const f of ['backups.json', 'backup-schedule.json']) {
    const live = readJson(path.join(liveData, f)), dst = path.join(m.staged, f);
    if (live) writeDurable(dst, live); else fs.rmSync(dst, { force: true });
  }
}

// Carry out (or finish) the moves; idempotent, judged from the disk and the journal.
function runMoves(j, file, io) {
  for (const m of j.moves) {
    if (!m.asideDone) {
      if (m.hadLive === undefined) { m.hadLive = exists(m.live) || exists(m.aside); writeDurable(file, j); }
      if (exists(m.live) && !exists(m.aside)) move(m.live, m.aside, { io });
      else if (exists(m.live) && exists(m.aside)) throw err(`Both ${m.live} and its set-aside copy exist.`);
      m.asideDone = true; writeDurable(file, j);
    }
    if (!m.placed) {
      if (m.staged) {
        const s = exists(m.staged), l = exists(m.live);
        if (s && l) {
          if (!m.copying) throw err(`Something appeared at ${m.live} during the restore.`);
          fs.rmSync(m.staged, { recursive: true, force: true });   // a copy across disks was renamed into place: finish it
        } else if (s) move(m.staged, m.live, { io, onCopy: () => { m.copying = true; writeDurable(file, j); } });
        else if (!l) throw err(`The checked copy for ${m.live} is missing.`);
      }
      m.placed = true; writeDurable(file, j);
    }
  }
}

// Put everything back as it was before the moves (a failed swap, two failed starts, an interrupted undo). Journaled step
// by step; resumed at the next start if interrupted. What was at a live path in place of the original is kept aside.
function rollBack(j, file, io, now = Date.now) {
  if (j.state !== 'rolling-back') { j.state = 'rolling-back'; j.rollbackStartedAt = new Date(now()).toISOString(); writeDurable(file, j); }
  for (const m of j.moves.slice().reverse()) {
    if (!m.rbOut) {
      // the live path holds the restored copy if the original is set aside, or if there was none and the copy was placed
      const restoredAtLive = exists(m.live) && (exists(m.aside) || (m.staged && m.asideDone && !m.hadLive && (m.placed || m.copying || !exists(m.staged))));
      if (restoredAtLive) move(m.live, `${m.aside}.failed`, { io });
      m.rbOut = true; writeDurable(file, j);
    }
    if (!m.rbBack) {
      if (exists(m.aside) && !exists(m.live)) move(m.aside, m.live, { io });
      try { fs.rmSync(`${m.live}.restore-part`, { recursive: true, force: true }); } catch { /* best effort: cleanup takes it later */ }   // a copy across disks that never finished
      m.rbBack = true; writeDurable(file, j);
    }
  }
  j.state = 'rolled-back'; j.rolledBackAt = new Date(now()).toISOString();
  writeDurable(file, j);
  fs.renameSync(file, path.join(path.dirname(file), `rolled-back-${j.id}.json`));
  syncDir(path.dirname(file));
}

function applyAtBoot({ root, log = () => {}, io = fs, now = Date.now } = {}) {
  const dirs = restoreDirs(root);
  const j = readJson(dirs.journal);
  const tidy = () => { try { prune(root, now, { boot: true, log }); } catch (e) { log(`[restore] cleanup skipped: ${e.message}`); } };   // never stops a start
  if (!j) { tidy(); return { state: 'none' }; }
  // a power cut between writing a final state and filing the journal away: finish filing it
  if (j.state === 'healthy') { fs.renameSync(dirs.journal, path.join(dirs.base, 'last-restore.json')); syncDir(dirs.base); tidy(); return { state: 'none' }; }
  if (j.state === 'rolled-back') { fs.renameSync(dirs.journal, path.join(dirs.base, `rolled-back-${j.id}.json`)); syncDir(dirs.base); tidy(); return { state: 'rolled-back', error: 'an earlier roll-back was being filed' }; }
  if (j.state === 'rolling-back') {
    log(`[restore] finishing an interrupted roll-back of the ${j.kind}`);
    rollBack(j, dirs.journal, io, now);
    return { state: 'rolled-back', error: 'an earlier attempt was interrupted' };
  }
  if (j.state === 'pending' || j.state === 'applying') {
    try {
      if (j.state === 'pending') { sameDisk(j.moves); mergeToday(j); j.state = 'applying'; writeDurable(dirs.journal, j); }   // the disks again, at the start itself
      runMoves(j, dirs.journal, io);
    } catch (e) {
      log(`[restore] could not finish the ${j.kind}: ${e.message}; putting everything back`);
      rollBack(j, dirs.journal, io, now);   // throws if even that fails: the caller stops
      return { state: 'rolled-back', error: e.message };
    }
    j.state = 'applied'; j.appliedAt = new Date(now()).toISOString(); j.starts = 1;
    writeDurable(dirs.journal, j);
    if (j.kind === 'restore') {
      fs.rmSync(dirs.staged, { recursive: true, force: true });
      fs.rmSync(dirs.prepared, { force: true });
      fs.rmSync(dirs.uploads, { recursive: true, force: true });
    }
    log(`[restore] ${j.kind === 'undo' ? 'the previous setup is back' : `restored the backup from ${j.backup && j.backup.created}`}; starting it`);
    return { state: 'applied', kind: j.kind, journal: j };
  }
  if (j.state === 'applied') {   // a start of the restored setup that never reported healthy
    j.starts = (j.starts || 0) + 1;
    if (j.starts > MAX_FAILED_STARTS) {
      log(`[restore] the ${j.kind === 'undo' ? 'undone' : 'restored'} setup failed to start ${j.starts - 1} times; putting the previous setup back`);
      rollBack(j, dirs.journal, io, now);
      return { state: 'rolled-back', error: 'failed to start' };
    }
    writeDurable(dirs.journal, j);
    return { state: 'applied', kind: j.kind, journal: j };
  }
  throw err(`The restore journal is in an unknown state (${j.state}).`);
}

// Set-aside copies of earlier restores still inside their 7 days (a second restore replaces last-restore.json).
const ledgerFile = (dirs) => path.join(dirs.base, 'asides.json');
function remember(dirs, rec, until) {
  const all = (readJson(ledgerFile(dirs)) || { entries: [] }).entries.filter(e => e && e.id !== rec.id);
  all.push({ id: rec.id, aside: rec.aside, asides: rec.asides || [rec.aside], until: new Date(until).toISOString() });
  writeDurable(ledgerFile(dirs), { entries: all });
}
function markHealthy({ root, now = Date.now } = {}) {
  const dirs = restoreDirs(root);
  const j = readJson(dirs.journal);
  if (!j || j.state !== 'applied') return false;
  const prev = readJson(path.join(dirs.base, 'last-restore.json'));
  // an undo of prev owns prev's copies; anything else that came before goes on the record with its own 7 days
  try { if (prev && prev.healthyAt && prev.id !== j.of) remember(dirs, prev, Date.parse(prev.healthyAt) + UNDO_DAYS * 86400000); } catch { /* best effort: never blocks a healthy start */ }
  j.state = 'healthy'; j.healthyAt = new Date(now()).toISOString();
  writeDurable(dirs.journal, j);
  fs.renameSync(dirs.journal, path.join(dirs.base, 'last-restore.json'));
  syncDir(dirs.base);
  return true;
}

function lastRestore({ root, now = Date.now } = {}) {
  const j = readJson(path.join(restoreDirs(root).base, 'last-restore.json'));
  if (!j || j.state !== 'healthy') return null;
  const until = Date.parse(j.healthyAt) + UNDO_DAYS * 86400000;
  const whole = (j.moves || []).every(m => !m.hadLive || exists(m.aside));
  return { ...j, undoUntil: new Date(until).toISOString(), canUndo: j.kind === 'restore' && now() < until && exists(j.aside) && whole };
}

function confirmUndo({ root, now = Date.now } = {}) {
  const dirs = restoreDirs(root);
  const last = lastRestore({ root, now });
  if (!last || !last.canUndo) throw err('There is no restore to undo, or its 7 days have passed.', 'ENOUNDO');
  if (exists(dirs.journal)) throw err('A restore is already waiting for a restart.', 'EBUSY');
  // each copy comes back from beside its place; what is there now goes beside it (same disk: renames only)
  const moves = last.moves.filter(m => exists(m.aside) || exists(m.live)).map(m => ({ staged: exists(m.aside) ? m.aside : null, live: m.live, aside: `${m.aside}.undone`, asideDone: false, placed: false }));
  sameDisk(moves);
  writeDurable(dirs.journal, { v: 2, kind: 'undo', id: `${last.id}-undo`, of: last.id, createdAt: new Date(now()).toISOString(), state: 'pending', starts: 0, aside: last.aside, asides: last.asides || [last.aside], moves, env: last.env });
  return { moves: moves.length };
}

// Remove what is no longer needed: a checked backup nobody confirmed and uploads (after a day); set-aside copies and
// roll-back leftovers (after the undo window). Nothing at all while a restore or undo waits for a start (its copies are in
// use). A checked backup is judged by the age of its own files, so one being checked right now is never touched. Each item
// is removed on its own: one that can't be removed doesn't stop the rest. At a start (boot), staging without a prepared
// record is a leftover of a stopped process and goes at once.
function prune(root, now = Date.now, { boot = false, log = () => {} } = {}) {
  const dirs = restoreDirs(root);
  if (exists(dirs.journal)) return;
  const age = (p) => { try { return now() - fs.statSync(p).mtimeMs; } catch { return 0; } };
  const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); return true; } catch (e) { log(`[restore] couldn't remove ${p}: ${e.message}`); return false; } };
  if (exists(dirs.staged)) {
    const orphan = !exists(dirs.prepared) && (boot || age(dirs.staged) > STALE_MS);
    if (orphan || (exists(dirs.prepared) && age(dirs.prepared) > STALE_MS)) { rm(dirs.staged); rm(dirs.prepared); }
  } else if (exists(dirs.prepared) && age(dirs.prepared) > STALE_MS) rm(dirs.prepared);
  try { for (const n of fs.readdirSync(dirs.uploads)) if (age(path.join(dirs.uploads, n)) > STALE_MS) rm(path.join(dirs.uploads, n)); } catch { /* none */ }
  const drop = (rec) => {   // true only when everything the record names is gone
    let ok = true;
    for (const d of new Set([...(rec.asides || []), rec.aside].filter(Boolean))) if (!rm(d)) ok = false;
    for (const m of rec.moves || []) if (!rm(`${m.live}.restore-part`)) ok = false;
    return ok;
  };
  const last = readJson(path.join(dirs.base, 'last-restore.json'));
  if (last && last.state === 'healthy' && now() >= Date.parse(last.healthyAt) + UNDO_DAYS * 86400000) drop(last);
  const led = readJson(ledgerFile(dirs));
  if (led && Array.isArray(led.entries)) {
    const keep = [];
    for (const e of led.entries) if (e && (now() < Date.parse(e.until) || !drop(e))) keep.push(e);   // kept until really removed
    if (keep.length !== led.entries.length) { try { writeDurable(ledgerFile(dirs), { entries: keep }); } catch (e) { log(`[restore] couldn't update the record of set-aside copies: ${e.message}`); } }
  }
  let names = []; try { names = fs.readdirSync(dirs.base); } catch { return; }
  for (const n of names) {
    const p = path.join(dirs.base, n);
    if (!/^rolled-back-.+\.json$/.test(n)) continue;
    const rec = readJson(p);
    if (!rec || now() < Date.parse(rec.rolledBackAt || 0) + UNDO_DAYS * 86400000) continue;
    let ok = true;
    for (const m of rec.moves || []) for (const f of [`${m.aside}.failed`, `${m.aside}.undone.failed`, `${m.live}.restore-part`]) if (!rm(f)) ok = false;
    if (!ok || (rec.moves || []).some(m => exists(m.aside) || exists(`${m.aside}.undone`))) continue;   // retried later; an original still set aside stays
    if (drop(rec)) rm(p);
  }
}

module.exports = { confirm, applyAtBoot, markHealthy, lastRestore, confirmUndo, prune, planMoves, UNDO_DAYS, MAX_FAILED_STARTS };
