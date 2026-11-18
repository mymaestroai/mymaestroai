'use strict';
// data/selfcheck.json: the last run, since-when, who was told, and a short history. Copy-write-adopt, like the other stores:
// a temp file in the same folder, fsync, rename; the copy in memory changes only after the write worked.
const fs = require('fs');
const path = require('path');

const empty = () => ({ lastRun: null, failingSince: {}, notified: [], history: [] });

function createStore({ dir, now = Date.now, log = () => {} }) {
  const file = path.join(dir, 'selfcheck.json');
  let cur = null, exists = false, unreadable = false;

  function load() {
    if (cur) return;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      if (e.code === 'ENOENT') { cur = empty(); return; }
      // Some other read error: keep what is on disk, write nothing over it.
      unreadable = true; cur = empty(); log(`[selfcheck] cannot read ${file}: ${e.message}`); return;
    }
    try {
      const o = JSON.parse(text);
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('not an object');
      cur = { ...empty(), ...o };
      if (!cur.failingSince || typeof cur.failingSince !== 'object' || Array.isArray(cur.failingSince)) cur.failingSince = {};
      if (!Array.isArray(cur.notified)) cur.notified = [];
      if (!Array.isArray(cur.history)) cur.history = [];
      exists = true;
    } catch (e) {
      const aside = `${file}.corrupt-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`;
      try { fs.renameSync(file, aside); log(`[selfcheck] ${file} was damaged (${e.message}); kept as ${path.basename(aside)}`); }
      catch (e2) { unreadable = true; log(`[selfcheck] ${file} was damaged and could not be moved aside: ${e2.message}`); }
      cur = empty();
    }
  }

  /** The stored object (a copy), or the empty shape. */
  function get() { load(); return JSON.parse(JSON.stringify(cur)); }
  function has() { load(); return exists; }

  /** Replace the stored object with { ...current, ...patch }. false when it could not be written. */
  function set(patch) {
    load();
    if (unreadable) { log('[selfcheck] not saving: the stored file could not be read, so it is left as it is'); return false; }
    const next = { ...cur, ...patch };
    const tmp = path.join(dir, `.selfcheck.json.${process.pid}.${Math.random().toString(16).slice(2, 8)}.tmp`);
    let fd = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fd = fs.openSync(tmp, 'w', 0o600);
      fs.writeSync(fd, JSON.stringify(next, null, 2));
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = null;
      fs.renameSync(tmp, file);
    } catch (e) {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
      try { fs.unlinkSync(tmp); } catch { /* it was never made */ }
      log(`[selfcheck] could not save ${file}: ${e.message}`);
      return false;
    }
    cur = next; exists = true;
    return true;
  }

  return { get, set, has, file };
}

module.exports = { createStore, empty };
