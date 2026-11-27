'use strict';
// resume-pacer.js: after Resume, everything that wakes an agent (held scheduled tasks, job notices waiting to be
// delivered, the consult queue) goes out ONE AT A TIME, at least 30 s apart, measured from the last ACTUAL dispatch
// (saved in data/resume-pacer.json, so a sleep, a suspend or a restart cannot bunch them).
//
//   add(n)       Resume released n items: open the "paced until" window (it stays open until n dispatches have happened,
//                or, as a guard against a wrong count, 15 minutes after the last dispatch).
//   take(kind)   -> 0: go now (the dispatch is recorded, measured from this moment); > 0: wait this many ms and ask again.
//                While no window is open it always answers 0 and writes nothing.
const fs = require('fs');
const path = require('path');

const GAP_MS = 30000;
const WINDOW_MAX_MS = 15 * 60000;
const DEFAULT_FILE = process.env.HUB_RESUME_PACER_FILE || path.join(__dirname, '..', 'data', 'resume-pacer.json');

function createResumePacer({ file = DEFAULT_FILE, now = Date.now, gapMs = GAP_MS } = {}) {
  let st = null;   // { pending, openedAt, lastDispatchAt }
  function load() {
    if (st) return st;
    st = { pending: 0, openedAt: 0, lastDispatchAt: 0 };
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); for (const k of Object.keys(st)) if (Number.isFinite(j[k])) st[k] = j[k]; } catch { /* none yet */ }
    return st;
  }
  function save() {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(st), { mode: 0o600 }); fs.renameSync(tmp, file); }
    catch (e) { console.error('[resume-pacer] could not save:', e.message); }
  }
  function isOpen() {
    const s = load();
    if (s.pending <= 0) return false;
    return now() - Math.max(s.openedAt, s.lastDispatchAt) < WINDOW_MAX_MS;
  }
  function add(n) {
    const k = Math.max(0, Math.floor(Number(n) || 0));
    if (!k) return;
    const s = load();
    s.pending = (isOpen() ? s.pending : 0) + k;
    s.openedAt = now();
    save();
  }
  function take(kind = 'wake') {
    void kind;
    if (!isOpen()) return 0;
    const s = load();
    const wait = Math.max(0, s.lastDispatchAt + gapMs - now());
    if (wait > 0) return wait;
    s.lastDispatchAt = now();
    s.pending -= 1;
    save();
    return 0;
  }
  /** How long until the next dispatch is allowed, without taking it (for a status line). 0 when no window is open. */
  function peek() { if (!isOpen()) return 0; return Math.max(0, load().lastDispatchAt + gapMs - now()); }
  function status() { const s = load(); return { open: isOpen(), pending: Math.max(0, s.pending), lastDispatchAt: s.lastDispatchAt || null }; }
  return { add, take, peek, isOpen, status, gapMs, file };
}

const byFile = new Map();
/** One pacer per file, so every module that names the same file shares one state. */
function getResumePacer(file = DEFAULT_FILE, now = Date.now) {
  if (!byFile.has(file)) byFile.set(file, createResumePacer({ file, now }));
  return byFile.get(file);
}

module.exports = { createResumePacer, getResumePacer, GAP_MS };
