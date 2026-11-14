'use strict';
/**
 * backup/recordings-merge.js — call recordings across a restore or an undo. They are a lifelong family record, so a swap
 * never loses a session: the folder that is placed live holds every session of the incoming side plus every session that
 * exists live but not there ("session" = <agent>/<sessionId>/, matched by relative path; on a collision the copy live today
 * wins whenever its manifest opens with today's key: sessions only grow, so the backup's copy is an older snapshot. Today's is placed and the
 * incoming one is moved to <displaced>/<agent>/<sessionId>, the restore's set-aside area, never inside the placed folder; the
 * incoming copy is used only when today's manifest can't be opened; the live copy also stays in the set-aside folder).
 *
 * Every file is sealed with a key derived from data/.auth-key and bound to its relative path (lib/recordings/crypt). When
 * the incoming side's key differs from today's, each carried-over file is opened with today's key and sealed with the
 * incoming one. A file that does not open is copied unchanged and named in the report. Links are never followed: they are
 * skipped and named. Nothing live is modified: the sessions are copied into the staged folder, each through a temporary
 * name and one rename, so a crash and a second run neither duplicate nor half-copy.
 *
 * No requires that read settings or the environment: apply.js loads this before .env is read.
 */
const fs = require('fs');
const path = require('path');
const { deriveKey, seal, open } = require('../recordings/crypt');
const { keyOf } = require('./accounts');

const MARKER = '.mymaestro-recordings';
const MARKER_TEXT = 'My Maestro call recordings (encrypted). Do not edit by hand.\n';
const TMP = '.merge-';

const lstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
const names = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };
const derive = (installKey) => { try { return installKey ? deriveKey(installKey) : null; } catch { return null; } };

/** How many sessions (<agent>/<sessionId>/ folders, links not followed) a call-recordings folder holds. */
function countSessions(dir) {
  let n = 0;
  for (const a of names(dir)) {
    const s = lstat(path.join(dir, a));
    if (!s || !s.isDirectory()) continue;
    for (const x of names(path.join(dir, a))) { const t = lstat(path.join(dir, a, x)); if (t && t.isDirectory() && !x.startsWith(TMP)) n++; }
  }
  return n;
}

/** The number of entries in a session folder's manifest, opened with its key; null when it can't be opened. */
function entryCount(dir, key, rel) {
  if (!key) return null;
  try {
    const m = JSON.parse(open(key, fs.readFileSync(path.join(dir, 'manifest.json.enc')), `${rel}/manifest.json.enc`).toString('utf8'));
    return m && Array.isArray(m.entries) ? m.entries.length : null;
  } catch { return null; }
}
/** The files in a session folder (the fallback count when a manifest can't be opened). */
function fileCount(dir) { return names(dir).filter((n) => { const s = lstat(path.join(dir, n)); return s && s.isFile(); }).length; }

function writeFile(file, data, mtime) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.chmodSync(file, 0o600);
  if (mtime) { try { fs.utimesSync(file, mtime, mtime); } catch { /* best effort */ } }
}

/**
 * mergeRecordings({ live, staged, liveInstallKey, stagedInstallKey }) — live: today's call-recordings folder; staged: the
 * folder about to be placed (created when missing); the keys are the two data/.auth-key values (Buffers, or null when
 * unreadable). Returns { carried, resealedSessions, resealedFiles, unopened: [paths], links: [paths] }.
 */
function mergeRecordings({ live, staged, displaced, liveInstallKey, stagedInstallKey }) {
  const out = { carried: 0, replacedByLive: 0, resealedSessions: 0, resealedFiles: 0, unopened: [], links: [], repairedFiles: [], stillBroken: [] };
  const top = lstat(live);
  if (!top) return out;
  fs.mkdirSync(staged, { recursive: true, mode: 0o700 });
  fs.chmodSync(staged, 0o700);
  if (top.isSymbolicLink()) { out.links.push('call-recordings'); return out; }
  if (!top.isDirectory()) return out;

  const lkey = derive(liveInstallKey), skey = derive(stagedInstallKey);
  const same = !!(lkey && skey && lkey.equals(skey));
  const unreadable = !same && !(lkey && skey);

  const copyTree = (src, dst, rel, stat) => {
    fs.mkdirSync(dst, { mode: 0o700 });
    fs.chmodSync(dst, 0o700);
    for (const n of names(src)) {
      const p = path.join(src, n), r = `${rel}/${n}`, st = lstat(p);
      if (!st) continue;
      if (st.isSymbolicLink()) { out.links.push(r); continue; }
      if (st.isDirectory()) { copyTree(p, path.join(dst, n), r, stat); continue; }
      if (!st.isFile()) continue;
      let data = fs.readFileSync(p);
      if (!same) {
        if (unreadable) out.unopened.push(r);
        else {
          try { data = seal(skey, open(lkey, data, r), r); stat.files++; } catch { out.unopened.push(r); }
        }
      }
      writeFile(path.join(dst, n), data, st.mtime);
    }
  };

  // On a collision today's copy is placed (tmp). Each segment its manifest names is checked in today's copy (sp): the file exists,
  // opens with today's key and has the manifest's sha256. One that fails is replaced by the incoming copy's file (inc, sealed
  // with the incoming key) when that has the same name, opens, and has the same sha256 — re-sealed to the placed key. Else it is listed.
  const FILE_RE = /^\d{4,}-(person|agent)\.flac$/;
  const repairFiles = (sp, inc, tmp, sealRel) => {
    let m;
    try { m = JSON.parse(open(lkey, fs.readFileSync(path.join(sp, 'manifest.json.enc')), `${sealRel}/manifest.json.enc`).toString('utf8')); } catch { return; }
    if (!m || !Array.isArray(m.entries)) return;
    const sha = (b) => require('crypto').createHash('sha256').update(b).digest('hex');
    for (const e of m.entries) {
      if (!e || e.kind !== 'segment' || typeof e.file !== 'string' || !FILE_RE.test(e.file) || typeof e.sha256 !== 'string') continue;
      const r = `${sealRel}/${e.file}.enc`;
      let good = false;
      try { good = sha(open(lkey, fs.readFileSync(path.join(sp, `${e.file}.enc`)), r)) === e.sha256; } catch { /* missing or does not open */ }
      if (good) continue;
      let fixed = false;
      try {
        if (skey) {
          const plain = open(skey, fs.readFileSync(path.join(inc, `${e.file}.enc`)), r);
          if (sha(plain) === e.sha256) {
            const dst = path.join(tmp, `${e.file}.enc`);
            const part = `${dst}.repair`;
            writeFile(part, seal(skey, plain, r));
            fs.renameSync(part, dst);
            fixed = true;
          }
        }
      } catch { /* the backup has no usable copy either */ }
      if (fixed) {
        out.repairedFiles.push(r);
        const i = out.unopened.indexOf(r); if (i >= 0) out.unopened.splice(i, 1);
      } else out.stillBroken.push(r);
    }
  };

  for (const a of names(live)) {
    const ap = path.join(live, a), as = lstat(ap);
    if (!as) continue;
    if (as.isSymbolicLink()) { out.links.push(a); continue; }
    if (!as.isDirectory()) continue;
    const sa = path.join(staged, a);
    for (const stale of names(sa)) if (stale.startsWith(TMP)) fs.rmSync(path.join(sa, stale), { recursive: true, force: true });   // a crashed earlier run
    for (const sid of names(ap)) {
      if (sid.startsWith(TMP)) continue;
      const sp = path.join(ap, sid), ss = lstat(sp);
      if (!ss) continue;
      if (ss.isSymbolicLink()) { out.links.push(`${a}/${sid}`); continue; }
      if (!ss.isDirectory()) continue;
      const target = path.join(sa, sid);
      const sealRel = `${a}/${sid}`;
      const collides = !!lstat(target);
      let displacedTo = null;
      if (collides) {
        // On both sides: the copy live today wins whenever its manifest opens with today's key (a session only grows, so the backup's
        // copy is an older snapshot of it). The incoming copy is used only when today's manifest can't be opened.
        const ts = lstat(target);
        if (!ts || !ts.isDirectory()) continue;
        if (entryCount(sp, lkey, sealRel) === null) continue;
        if (!displaced) continue;
        displacedTo = path.join(displaced, a, sid);
        if (lstat(displacedTo)) continue;   // an earlier run already put today's copy in place and set the incoming one aside
      }
      fs.mkdirSync(sa, { recursive: true, mode: 0o700 });
      fs.chmodSync(sa, 0o700);
      const tmp = path.join(sa, `${TMP}${sid}`);
      const stat = { files: 0 };
      copyTree(sp, tmp, sealRel, stat);
      if (collides) repairFiles(sp, target, tmp, sealRel);
      if (collides) {
        // The displaced copy never goes inside the placed folder: it is kept in the restore's set-aside area.
        fs.mkdirSync(path.dirname(displacedTo), { recursive: true, mode: 0o700 });
        fs.renameSync(target, displacedTo);
        out.replacedByLive++;
      }
      fs.renameSync(tmp, target);
      if (!collides) out.carried++;
      if (stat.files) { out.resealedSessions++; out.resealedFiles += stat.files; }
    }
  }
  const sm = path.join(staged, MARKER);
  if (!lstat(sm)) {
    let text = null;
    try { text = fs.readFileSync(path.join(live, MARKER)); } catch { /* none */ }
    if (text || out.carried) writeFile(sm, text || Buffer.from(MARKER_TEXT));
  }
  return out;
}

/** The two install keys for a swap: today's, and the one that comes with the incoming data folder (today's when data stays). */
function keysFor(liveDataDir, incomingDataDir) {
  const live = keyOf(liveDataDir);
  return { liveInstallKey: live, stagedInstallKey: incomingDataDir ? keyOf(incomingDataDir) : live };
}

module.exports = { mergeRecordings, countSessions, keysFor, MARKER };
