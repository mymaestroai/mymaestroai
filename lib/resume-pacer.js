'use strict';
// resume-pacer.js: after Resume, the items Resume released (held scheduled tasks, job notices waiting to be delivered,
// queued consults) go out ONE AT A TIME, at least 30 s apart, measured from the last ACTUAL dispatch of a released item.
// The pacer knows the released items BY ID. Only those are paced; a wake that was not released is never delayed by it,
// and never uses a slot. State (the ids and lastDispatchAt) is saved in data/resume-pacer.json, so a restart keeps it.
//
//   add(ids)             Resume released these items: they join the paced set (the window is open while the set is not empty).
//   wait(id)             -> ms this item must still wait (0: it may go now, or it is not paced). Changes nothing.
//   take(id)             -> 0: go now; if the item is paced the dispatch is recorded NOW and the id leaves the set.
//                        > 0: wait this many ms and ask again. A slot is used only here, at the real dispatch.
//   has(id)              Is this item in the paced set?
//   drop(id)             The item is gone (dropped, expired, cancelled): it leaves the set; no slot is used.
//   prune(prefix, live)  Every paced id that starts with prefix and is not in `live` (a Set/array of ids that still exist) is dropped.
//                        Owners call it with what they still hold, so every way an item can disappear (and a restart) is covered.
// There is no timeout: the window lasts exactly while released items remain.
const fs = require('fs');
const path = require('path');

const GAP_MS = 30000;
const DEFAULT_FILE = process.env.HUB_RESUME_PACER_FILE || path.join(__dirname, '..', 'data', 'resume-pacer.json');

function createResumePacer({ file = DEFAULT_FILE, now = Date.now, gapMs = GAP_MS } = {}) {
  let st = null;   // { ids: Set, lastDispatchAt }
  function load() {
    if (st) return st;
    st = { ids: new Set(), lastDispatchAt: 0 };
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(j.ids)) for (const id of j.ids) if (typeof id === 'string' && id) st.ids.add(id);
      if (Number.isFinite(j.lastDispatchAt)) st.lastDispatchAt = j.lastDispatchAt;
    } catch { /* none yet */ }
    return st;
  }
  function save() {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify({ ids: [...st.ids], lastDispatchAt: st.lastDispatchAt }), { mode: 0o600 }); fs.renameSync(tmp, file); }
    catch (e) { console.error('[resume-pacer] could not save:', e.message); }
  }
  function isOpen() { return load().ids.size > 0; }
  function add(ids) {
    const s = load(); let n = 0;
    for (const id of [].concat(ids || [])) if (typeof id === 'string' && id && !s.ids.has(id)) { s.ids.add(id); n++; }
    if (n) save();
  }
  function wait(id) {
    const s = load();
    if (!s.ids.has(id)) return 0;
    return Math.max(0, s.lastDispatchAt + gapMs - now());
  }
  function take(id) {
    const s = load();
    if (!s.ids.has(id)) return 0;
    const w = Math.max(0, s.lastDispatchAt + gapMs - now());
    if (w > 0) return w;
    s.lastDispatchAt = now();
    s.ids.delete(id);
    save();
    return 0;
  }
  function has(id) { return load().ids.has(id); }
  function drop(id) { const s = load(); if (s.ids.delete(id)) save(); }
  function prune(prefix, live) {
    const s = load();
    const keep = live instanceof Set ? live : new Set(live || []);
    let n = 0;
    for (const id of [...s.ids]) if (id.startsWith(prefix) && !keep.has(id)) { s.ids.delete(id); n++; }
    if (n) save();
  }
  function status() { const s = load(); return { open: s.ids.size > 0, pending: s.ids.size, ids: [...s.ids], lastDispatchAt: s.lastDispatchAt || null }; }
  return { add, wait, take, has, drop, prune, isOpen, status, gapMs, file };
}

const byFile = new Map();
/** One pacer per file, so every module that names the same file shares one state. */
function getResumePacer(file = DEFAULT_FILE, now = Date.now) {
  if (!byFile.has(file)) byFile.set(file, createResumePacer({ file, now }));
  return byFile.get(file);
}

module.exports = { createResumePacer, getResumePacer, GAP_MS };
