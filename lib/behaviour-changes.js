'use strict';
// Behaviour changes (templates/behaviour-changes.json): changes to how agents behave. A NEW install gets each one on; an
// install that already has agents gets each one off and "pending" until the owner decides on the /changes page. Nothing
// here is reachable by an agent or a tool: the only writer besides the start-up code is decide(), called from the
// admin-only route. State: data/behaviour-reviews.json { entries: { <id>: { state, by, at, user? } } }.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MANIFEST_FILE = path.join(ROOT, 'templates', 'behaviour-changes.json');
const STATE_FILE = path.join(ROOT, 'data', 'behaviour-reviews.json');
const AGENTS_FILE_DEFAULT = path.join(ROOT, 'data', 'agents.json');
const ID_RE = /^[a-z][a-z0-9-]{1,40}$/;
const STATES = ['on', 'off', 'pending'];
const CACHE_MS = 2000;
const KEPT_FIELDS = ['reviewAt', 'reviewTask', 'proposalsTask'];

let lock = Promise.resolve();
const manifestCache = new Map();   // file -> { mtimeMs, entries }
const stateCache = new Map();      // file -> { at, state }

/** The manifest entries with a valid id (cached by the file's mtime); [] when the file can't be read. */
function manifest(file = MANIFEST_FILE) {
  try {
    const st = fs.statSync(file);
    const hit = manifestCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.entries;
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = (doc && Array.isArray(doc.changes) ? doc.changes : []).filter((e) => e && typeof e.id === 'string' && ID_RE.test(e.id));
    manifestCache.set(file, { mtimeMs: st.mtimeMs, entries });
    return entries;
  } catch { return []; }
}

/** { entries } | { entries: {}, missing: true } | { entries: {}, unreadable: true } */
function readState(file = STATE_FILE) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { return e && e.code === 'ENOENT' ? { entries: {}, missing: true } : { entries: {}, unreadable: true }; }
  try {
    const doc = JSON.parse(raw);
    const ok = doc && typeof doc === 'object' && !Array.isArray(doc) && doc.entries && typeof doc.entries === 'object' && !Array.isArray(doc.entries)
      && Object.values(doc.entries).every((v) => v && typeof v === 'object' && !Array.isArray(v) && STATES.includes(v.state));
    return ok ? { entries: doc.entries } : { entries: {}, unreadable: true };
  } catch { return { entries: {}, unreadable: true }; }
}

function defaultHasUsers() { return require('./auth').getAuth().hasUsers(); }

function writeState(entries, file = STATE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ entries }, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
  stateCache.delete(file);
}

/** 'on' | 'off' | 'pending' | 'missing' (no state file, or no entry) | 'unreadable'. Read cached for 2 seconds. */
function stateOf(id, { stateFile = STATE_FILE } = {}) {
  try {
    const now = Date.now();
    let hit = stateCache.get(stateFile);
    if (!hit || now - hit.at >= CACHE_MS) {
      hit = { at: now, state: readState(stateFile) };
      stateCache.set(stateFile, hit);
    }
    if (hit.state.unreadable) return 'unreadable';
    if (hit.state.missing) return 'missing';
    const e = hit.state.entries[id];
    return e ? e.state : 'missing';
  } catch { return 'unreadable'; }
}
/** True only when the state is readable and the entry is 'on'. A change that ADDS a behaviour uses this (anything else:
 *  the behaviour is absent). A change that LIMITS something (member-worker-models) must use stateOf and keep the limit
 *  when the state can't be read, so a broken file never lifts a limit the owner turned on. */
function isOn(id, opts) { return stateOf(id, opts) === 'on'; }

/** A fresh install: every manifest entry on, by 'new-install'. Never overwrites an existing state file. */
function seedNew({ stateFile = STATE_FILE, manifestFile = MANIFEST_FILE } = {}) {
  if (fs.existsSync(stateFile)) return { seeded: false };
  const at = new Date().toISOString();
  const entries = {};
  for (const e of manifest(manifestFile)) entries[e.id] = { state: 'on', by: 'new-install', at };
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ entries }, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    // link, not rename: a file that appeared meanwhile is never replaced.
    try { fs.linkSync(tmp, stateFile); } catch (e) { if (!(e && e.code === 'EEXIST')) throw e; }
  } finally { try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ } }
  stateCache.delete(stateFile);
  return { seeded: true };
}

/** At start-up: an install that already has agents gets each entry it doesn't have as 'pending' (by 'update'). */
function migrate({ agentsFile = AGENTS_FILE_DEFAULT, stateFile = STATE_FILE, manifestFile = MANIFEST_FILE, hasUsers = defaultHasUsers } = {}) {
  const st = readState(stateFile);
  if (st.unreadable) return { unreadable: true };
  if (st.missing && !fs.existsSync(agentsFile)) return { added: [] };   // a fresh install: seedNew writes the file
  // No state yet and no account yet: a new install whose agents.json came with it (the release bundle ships one).
  let users = true;
  try { users = !!hasUsers(); } catch { users = true; }
  if (st.missing && !users) { seedNew({ stateFile, manifestFile }); return { added: [], seeded: true }; }
  const entries = { ...st.entries };
  const at = new Date().toISOString();
  const added = [];
  for (const e of manifest(manifestFile)) {
    if (entries[e.id]) continue;
    entries[e.id] = { state: 'pending', by: 'update', at };
    added.push(e.id);
  }
  if (added.length || st.missing) writeState(entries, stateFile);
  return { added };
}

/** The owner's decision. Throws 'no such change' for an unknown id and when the state can't be read (never overwritten). */
async function decide(id, decision, { user, stateFile = STATE_FILE, manifestFile = MANIFEST_FILE } = {}) {
  if (decision !== 'on' && decision !== 'off') throw new Error('decision must be on or off');
  if (!manifest(manifestFile).some((e) => e.id === id)) throw new Error('no such change');
  const run = lock.then(() => {
    const st = readState(stateFile);
    if (st.unreadable) throw new Error('the behaviour changes file could not be read, so it is not overwritten');
    const entry = { state: decision, by: 'owner', at: new Date().toISOString() };
    if (user !== undefined && user !== null) entry.user = String(user);
    const before = st.entries[id] || {};
    const kept = {};   // the hub's own bookkeeping survives a decision (the review that was scheduled, the weekly task to cancel later)
    for (const k of KEPT_FIELDS) if (before[k] !== undefined) kept[k] = before[k];
    writeState({ ...st.entries, [id]: { ...entry, ...kept } }, stateFile);
    stateCache.delete(stateFile);
    return { ...entry, id };
  });
  lock = run.then(() => {}, () => {});
  return run;
}

/** Record that the lead's review of these entries was scheduled (reviewAt, reviewTask); every other field stays. Refuses an unreadable state. */
async function markReviewed(ids, taskId, { stateFile = STATE_FILE } = {}) {
  const run = lock.then(() => {
    const st = readState(stateFile);
    if (st.unreadable) throw new Error('the behaviour changes file could not be read, so it is not overwritten');
    const entries = { ...st.entries };
    const at = new Date().toISOString();
    const marked = [];
    for (const id of ids || []) {
      if (!entries[id]) continue;
      entries[id] = { ...entries[id], reviewAt: at, reviewTask: String(taskId) };
      marked.push(id);
    }
    if (marked.length) writeState(entries, stateFile);
    return marked;
  });
  lock = run.then(() => {}, () => {});
  return run;
}

/** Set (or, with null, clear) one bookkeeping field of an entry (reviewAt, reviewTask or proposalsTask). Locked; keeps every other field; refuses an unreadable state. */
async function setEntryField(id, field, value, { stateFile = STATE_FILE } = {}) {
  if (!KEPT_FIELDS.includes(field)) throw new Error('not a field the hub keeps');
  const run = lock.then(() => {
    const st = readState(stateFile);
    if (st.unreadable) throw new Error('the behaviour changes file could not be read, so it is not overwritten');
    if (!st.entries[id]) return false;
    const e = { ...st.entries[id] };
    if (value === null || value === undefined) delete e[field]; else e[field] = value;
    writeState({ ...st.entries, [id]: e }, stateFile);
    return true;
  });
  lock = run.then(() => {}, () => {});
  return run;
}

/** The manifest entries each with state ('pending' when absent), by, at; each also `unreadable: true` when the state file can't be read. */
function list({ stateFile = STATE_FILE, manifestFile = MANIFEST_FILE } = {}) {
  const st = readState(stateFile);
  const out = manifest(manifestFile).map((e) => {
    const s = st.entries[e.id];
    return { ...e, state: s ? s.state : 'pending', ...(s && s.by ? { by: s.by } : {}), ...(s && s.at ? { at: s.at } : {}) };
  });
  return st.unreadable ? out.map((e) => ({ ...e, unreadable: true })) : out;
}

module.exports = { MANIFEST_FILE, STATE_FILE, manifest, readState, stateOf, isOn, seedNew, migrate, decide, list, markReviewed, setEntryField };
