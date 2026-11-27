'use strict';
// Behaviour changes (templates/behaviour-changes.json): changes to how agents behave. A NEW install gets each one on; an
// install that already has agents gets each one off and "pending" until the owner decides on the /changes page. The only
// writer besides the start-up code is decide(), called from the admin-only route and from lib/behaviour-switch (the lead's
// behaviour_change tool, offered only in a turn a signed-in admin typed, for entries with leadMay true, after the
// owner's yes). State: data/behaviour-reviews.json { entries: { <id>: { state, by, at, user?, agent?, snoozedUntil?, snoozedBy?,
// noticeSeenAt?, recommend?, recommendWhy?, recommendAt? } } }. Every decision is journaled (store "behaviour") so it can be restored.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MANIFEST_FILE = path.join(ROOT, 'templates', 'behaviour-changes.json');
const STATE_FILE = path.join(ROOT, 'data', 'behaviour-reviews.json');
const AGENTS_FILE_DEFAULT = path.join(ROOT, 'data', 'agents.json');
const ID_RE = /^[a-z][a-z0-9-]{1,40}$/;
const STATES = ['on', 'off', 'pending'];
const CACHE_MS = 2000;
// The hub's own bookkeeping: survives a decision or any other write (the lead's recommendation and the owner's "seen" too).
// snoozedUntil / snoozedBy are NOT kept: a decision ends a snooze.
const KEPT_FIELDS = ['reviewAt', 'reviewTask', 'proposalsTask', 'recommend', 'recommendWhy', 'recommendAt', 'noticeSeenAt'];
const SNOOZE_MS = 7 * 24 * 3600 * 1000;
const WHY_MAX = 200;

const journal = () => require('./settings-journal');
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

/** Each entry carries v, a counter raised by every write that changes it (any writer: a decision, a snooze, Undo, a notice seen, a
 *  recommendation, Restore). The card's rev is the phrase plus v (revOf), so on -> off -> on never matches an older "on". The objects
 *  passed in get their v set, so a caller holding `next` can read the value that was written. */
function stampVersions(entries, file) {
  const prev = readState(file);
  const old = prev.unreadable ? {} : prev.entries;
  const bare = (e) => { const { v, ...rest } = e; return JSON.stringify(rest); };
  for (const [id, e] of Object.entries(entries)) {
    if (!e || typeof e !== 'object') continue;
    const b = Object.prototype.hasOwnProperty.call(old, id) ? old[id] : undefined;
    const bv = b && Number.isSafeInteger(b.v) && b.v > 0 ? b.v : 0;
    if (b && bare(b) === bare(e)) { if (bv) e.v = bv; else delete e.v; }
    else e.v = bv + 1;
  }
}
function writeState(entries, file = STATE_FILE) {
  stampVersions(entries, file);
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

/** quiet: true in the manifest marks a cheap, safe feature; it counts only together with leadMay true (spending and security are never quiet). */
function isQuiet(e) { return !!e && e.quiet === true && e.leadMay === true; }

/** At start-up: an install that already has agents gets each entry it doesn't have as 'pending' (by 'update'). */
function migrate({ agentsFile = AGENTS_FILE_DEFAULT, stateFile = STATE_FILE, manifestFile = MANIFEST_FILE } = {}) {
  const st = readState(stateFile);
  if (st.unreadable) return { unreadable: true };
  if (st.missing && !fs.existsSync(agentsFile)) return { added: [] };   // a fresh install: seedNew writes the file
  // Review r2 (GPT-6): a new install is known only from the seeding of the agents list (seedNew; the release bundle ships
  // none). An install that has an agents list and no state file is an existing one, accounts or not (a single-password
  // install has no accounts).
  const entries = { ...st.entries };
  const at = new Date().toISOString();
  const added = [];
  const quiet = [];
  for (const e of manifest(manifestFile)) {
    if (entries[e.id]) continue;
    // A cheap, safe feature (quiet: true, and the lead may switch it) arrives on, with one notice on the card; anything else waits.
    if (isQuiet(e)) { entries[e.id] = { state: 'on', by: 'quiet-update', at }; quiet.push(e.id); continue; }
    entries[e.id] = { state: 'pending', by: 'update', at };
    added.push(e.id);
  }
  if (added.length || quiet.length || st.missing) writeState(entries, stateFile);
  return { added, quiet };
}

// ── The journal (lib/settings-journal, store "behaviour", key behaviour.<id>) ──
// A decision is written down as a short phrase the Restore code reads back: "on", "off", "pending", "snoozed until <ISO>",
// optionally ", seen <ISO>" after on/off. The person who pressed is the journal's actor.
function viewOf(e) {
  if (!e) return 'pending';
  if (e.state === 'pending' && e.snoozedUntil) return `snoozed until ${e.snoozedUntil}`;
  return e.noticeSeenAt && e.state !== 'pending' ? `${e.state}, seen ${e.noticeSeenAt}` : e.state;
}
function parseView(text) {
  const m = /^(on|off|pending)(?:, seen (\S+))?$/.exec(String(text)) || null;
  if (m) return { state: m[1], ...(m[2] ? { noticeSeenAt: m[2] } : {}) };
  const n = /^snoozed until (\S+)$/.exec(String(text));
  return n ? { state: 'pending', snoozedUntil: n[1] } : null;
}
function journaled(id, stateFile, before, after, write) {
  const v1 = viewOf(before), v2 = viewOf(after);
  return journal().journaledWrite(stateFile, v1 === v2 ? [] : [{ key: `behaviour.${id}`, before: v1, after: v2 }], write, 'behaviour');
}
function keptOf(before) {
  const kept = {};   // the hub's own bookkeeping survives a decision (the review that was scheduled, the weekly task to cancel later, the recommendation)
  for (const k of KEPT_FIELDS) if (before[k] !== undefined) kept[k] = before[k];
  return kept;
}
/** Runs fn after everything queued before it; one at a time (the file is read, changed and written inside fn). */
function locked(fn) {
  const run = lock.then(fn);
  lock = run.then(() => {}, () => {});
  return run;
}
/** expectRev: the revision (revOf) the page drew its row from; inside the lock a different one means another device answered or snoozed first. */
function staleRev(entry, expectRev) {
  if (expectRev !== undefined && revOf(entry) !== expectRev) throw new Error('already decided');
}
/** The card's revision of an entry: its journal phrase plus its write counter v ("on #3"); unique per write, readable in logs. */
function revOf(e) {
  return `${viewOf(e)} #${e && Number.isSafeInteger(e.v) && e.v > 0 ? e.v : 0}`;
}
const UNREADABLE = 'the behaviour changes file could not be read, so it is not overwritten';

/** An entry the lead may not switch (leadMay not true: it spends money or touches security) is the install's OWNER's to decide, restore
 *  or snooze; an entry the lead may switch keeps the rule of any admin's own browser session. Returns the refusal text, or null when allowed. */
const OWNER_ONLY_TEXT = 'Only the owner of this Maestro can switch this one.';
function ownerRefusal(id, { isOwner, manifestFile = MANIFEST_FILE } = {}) {
  const e = manifest(manifestFile).find((x) => x.id === id);
  return e && e.leadMay === true ? null : (isOwner === true ? null : OWNER_ONLY_TEXT);
}

/** The owner's decision. Throws 'no such change' for an unknown id and when the state can't be read (never overwritten). A decision ends a snooze. */
async function decide(id, decision, { user, agent, expect, expectRev, stateFile = STATE_FILE, manifestFile = MANIFEST_FILE } = {}) {
  if (decision !== 'on' && decision !== 'off') throw new Error('decision must be on or off');
  if (!manifest(manifestFile).some((e) => e.id === id)) throw new Error('no such change');
  return locked(() => {
    const st = readState(stateFile);
    if (st.unreadable) throw new Error(UNREADABLE);
    // by 'lead': the lead switched it at the owner's request in their own message (agent names the lead)
    const entry = { state: decision, by: agent ? 'lead' : 'owner', at: new Date().toISOString() };
    if (user !== undefined && user !== null) entry.user = String(user);
    if (agent) entry.agent = String(agent);
    if (expect !== undefined && (st.entries[id] ? st.entries[id].state : 'pending') !== expect) throw new Error('already decided');   // the page drew this row from another state (a second device answered first)
    staleRev(st.entries[id], expectRev);
    const before = st.entries[id] || {};
    const next = { ...entry, ...keptOf(before) };
    journaled(id, stateFile, st.entries[id], next, () => writeState({ ...st.entries, [id]: next }, stateFile));
    stateCache.delete(stateFile);
    return { ...entry, id, rev: revOf(next) };
  });
}

/** "Ask me in a week": a pending entry stays pending and is hidden from the card until snoozedUntil (now + 7 days; hub-wide). */
async function snooze(id, { user, expect, expectRev, now = Date.now(), stateFile = STATE_FILE, manifestFile = MANIFEST_FILE } = {}) {
  if (!manifest(manifestFile).some((e) => e.id === id)) throw new Error('no such change');
  return locked(() => {
    const st = readState(stateFile);
    if (st.unreadable) throw new Error(UNREADABLE);
    const before = st.entries[id];
    if (before && before.state !== 'pending') throw new Error('already decided');
    if (expect !== undefined && expect !== 'pending') throw new Error('already decided');
    staleRev(before, expectRev);
    const at = new Date(Number(now instanceof Date ? now.getTime() : now)).toISOString();
    const next = { ...(before || { state: 'pending', by: 'update', at }), state: 'pending', snoozedUntil: new Date(Date.parse(at) + SNOOZE_MS).toISOString() };
    if (user !== undefined && user !== null) next.snoozedBy = String(user); else delete next.snoozedBy;
    journaled(id, stateFile, before, next, () => writeState({ ...st.entries, [id]: next }, stateFile));
    stateCache.delete(stateFile);
    return { ...next, id };
  });
}

/** Undo from the card: puts an entry the owner decided or snoozed back to 'pending' (by 'owner'); the hub's kept fields and the
 *  recommendation stay. expectRev (required) is the row's revOf revision the page got back from its press; another device having changed
 *  it since, or an entry that is pending and not snoozed, is 'already decided'. */
async function reopen(id, { user, expectRev, stateFile = STATE_FILE, manifestFile = MANIFEST_FILE } = {}) {
  if (!manifest(manifestFile).some((e) => e.id === id)) throw new Error('no such change');
  if (typeof expectRev !== 'string' || !expectRev) throw new Error('rev needed');
  return locked(() => {
    const st = readState(stateFile);
    if (st.unreadable) throw new Error(UNREADABLE);
    const before = st.entries[id];
    staleRev(before, expectRev);
    if (!before || (before.state === 'pending' && !before.snoozedUntil)) throw new Error('already decided');
    const next = { state: 'pending', by: 'owner', at: new Date().toISOString(), ...keptOf(before) };
    journaled(id, stateFile, before, next, () => writeState({ ...st.entries, [id]: next }, stateFile));
    stateCache.delete(stateFile);
    return { ...next, id };
  });
}

/** The owner saw the notice of a quiet change: records noticeSeenAt (the state stays). Refused for an entry still waiting. */
async function markSeen(id, { user, expect, expectRev, now = Date.now(), stateFile = STATE_FILE, manifestFile = MANIFEST_FILE } = {}) {
  if (!manifest(manifestFile).some((e) => e.id === id)) throw new Error('no such change');
  return locked(() => {
    const st = readState(stateFile);
    if (st.unreadable) throw new Error(UNREADABLE);
    const before = st.entries[id];
    if (expect !== undefined && (before ? before.state : 'pending') !== expect) throw new Error('already decided');
    staleRev(before, expectRev);
    if (!before || before.state === 'pending') throw new Error('not decided yet');
    if (before.noticeSeenAt) return { ...before, id };   // already acknowledged
    const next = { ...before, noticeSeenAt: new Date(Number(now instanceof Date ? now.getTime() : now)).toISOString() };
    journaled(id, stateFile, before, next, () => writeState({ ...st.entries, [id]: next }, stateFile));
    stateCache.delete(stateFile);
    return { ...next, id };
  });
}

/** The lead's advice for a pending entry (recommend 'on' | 'off', one sentence of at most 200 characters). Never changes the state. */
async function recommend(id, decision, why, { now = Date.now(), taskId, stateFile = STATE_FILE, manifestFile = MANIFEST_FILE } = {}) {
  if (decision !== 'on' && decision !== 'off') throw new Error('The recommendation must be on or off.');
  const text = typeof why === 'string' ? why.replace(/\s+/g, ' ').trim() : '';
  if (!text) throw new Error('Give the reason in one sentence.');
  if (text.length > WHY_MAX) throw new Error(`Keep the reason to one sentence of at most ${WHY_MAX} characters.`);
  if (!manifest(manifestFile).some((e) => e.id === id)) throw new Error('no such change');
  return locked(() => {
    const st = readState(stateFile);
    if (st.unreadable) throw new Error(UNREADABLE);
    const before = st.entries[id];
    if (!before || before.state !== 'pending') throw new Error('already decided');
    if (taskId !== undefined && before.reviewTask !== taskId) throw new Error('not from this review');   // only the review the hub scheduled for this entry
    const next = { ...before, recommend: decision, recommendWhy: text, recommendAt: new Date(Number(now instanceof Date ? now.getTime() : now)).toISOString() };
    writeState({ ...st.entries, [id]: next }, stateFile);   // advice, not a decision: not journaled
    return { id, recommend: decision, recommendWhy: text };
  });
}

/** Restore (lib/settings-journal): puts a journaled value back. Synchronous like the file write inside the lock above (nothing else
 *  can run between its read and its write); journals the restore again. Returns { ok } or { ok: false, error }. */
function restoreView(id, text, { stateFile = STATE_FILE, manifestFile = MANIFEST_FILE, user } = {}) {
  const want = parseView(text);
  if (!want) return { ok: false, error: 'There was no value before, so there is nothing to put back.' };
  const st = readState(stateFile);
  if (st.unreadable) return { ok: false, error: UNREADABLE };
  const before = st.entries[id];
  if (!before && !manifest(manifestFile).some((e) => e.id === id)) return { ok: false, error: 'That change no longer exists.' };
  const base = { ...(before || {}) };
  delete base.snoozedUntil; delete base.snoozedBy; delete base.noticeSeenAt;
  const next = { ...base, state: want.state, by: want.state === 'pending' ? 'update' : 'owner', at: new Date().toISOString() };
  // a quiet entry's notice put back to unseen: it stays the quiet update it was, so the card shows the notice again
  if (before && before.by === 'quiet-update' && want.state === 'on' && !want.noticeSeenAt) next.by = 'quiet-update';
  if (want.state !== 'pending') { delete next.agent; if (user !== undefined && user !== null) next.user = String(user); }
  else { delete next.user; delete next.agent; }
  if (want.snoozedUntil) { next.snoozedUntil = want.snoozedUntil; if (user !== undefined && user !== null) next.snoozedBy = String(user); }
  if (want.noticeSeenAt) next.noticeSeenAt = want.noticeSeenAt;
  journaled(id, stateFile, before, next, () => writeState({ ...st.entries, [id]: next }, stateFile));
  stateCache.delete(stateFile);
  return { ok: true };
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
    return { ...e, state: s ? s.state : 'pending', ...(s && s.by ? { by: s.by } : {}), ...(s && s.at ? { at: s.at } : {}), ...(s && s.agent ? { agent: s.agent } : {}),
      ...(s && s.snoozedUntil ? { snoozedUntil: s.snoozedUntil } : {}), ...(s && s.noticeSeenAt ? { noticeSeenAt: s.noticeSeenAt } : {}),
      ...(s && s.recommend ? { recommend: s.recommend, ...(s.recommendWhy ? { recommendWhy: s.recommendWhy } : {}) } : {}) };
  });
  return st.unreadable ? out.map((e) => ({ ...e, unreadable: true })) : out;
}

module.exports = { MANIFEST_FILE, STATE_FILE, SNOOZE_MS, manifest, readState, stateOf, isOn, isQuiet, seedNew, migrate, decide, snooze, reopen, markSeen, recommend, restoreView, ownerRefusal, OWNER_ONLY_TEXT, viewOf, revOf, parseView, list, markReviewed, setEntryField };
