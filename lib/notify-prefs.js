'use strict';
// Per-person notification settings, per agent, for four kinds of notice:
//   questions  an agent needs your answer or approval (ask_user, approvals, for_owner marked asks)
//   requested  something you asked to be told about (Notify me, for_owner marked requested)
//   other      everything else (reports, hub notices)
//   security   access and data-safety notices (two-factor, passkeys, wallet, backups, grants, hub halted); the default row only
// Each is "on" | "off" | "away" (away = only while the person has no page of the hub in view).
// Resolution for (user, agent, kind): agents[agent][kind] ?? default[kind] ?? "on". Nothing set = "on" = the old behaviour.
// The file holds only these settings and updatedAt. Presence (which pages are in view) lives in memory and is never saved.

const fs = require('fs');
const path = require('path');

const MODES = ['on', 'off', 'away'];
const KINDS = ['questions', 'requested', 'other', 'security'];
const AGENT_KINDS = ['questions', 'requested', 'other'];   // security is set for all agents at once
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const MAX_AGENTS = 500;
const MAX_PAGES = 20;
const AWAY_MS = 150000;

function bad(message) { const e = new Error(message); e.code = 'bad_request'; return e; }
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function id64(v, what) { if (typeof v !== 'string' || v.length < 1 || v.length > 64) throw bad(`${what} must be a string of 1 to 64 characters`); return v; }
function cleanAgent(v) { id64(v, 'agent'); if (!AGENT_RE.test(v)) throw bad('agent name has characters that are not allowed'); return v; }
function cleanMode(v) { if (!MODES.includes(v)) throw bad('mode must be on, off or away'); return v; }
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

// patch: { questions?, requested?, other?, security?: mode|null }; nullOk: whether null (remove the kind) is allowed;
// forAgent: an agent's own settings, where security is not allowed
function cleanPatch(patch, nullOk, forAgent = false) {
  if (!isObj(patch)) throw bad('settings must be an object');
  const out = {};
  for (const k of Object.keys(patch)) {
    if (forAgent && k === 'security') throw bad('security is set for all agents at once');
    if (!KINDS.includes(k)) throw bad('kind must be questions, requested, other or security');
    const v = patch[k];
    if (v === null) { if (!nullOk) throw bad('mode must be on, off or away'); out[k] = null; } else out[k] = cleanMode(v);
  }
  return out;
}

// write: (file, object) => void; replaces the atomic writer (tests only, to make a write fail).
function createNotifyPrefs({ file, now = Date.now, awayMs = AWAY_MS, write = null } = {}) {
  if (typeof file !== 'string' || !file) throw new Error('createNotifyPrefs needs a file');
  let data = null;                      // userId -> { default, agents, updatedAt }; replaced whole after a successful write, never edited in place
  let unreadable = false;               // the last read failed for a reason other than a missing or corrupt file
  const presence = new Map();           // userId -> Map(pageId -> { visible, at })

  function writePrivate(f, obj) {
    const dir = path.dirname(f);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, f);
  }

  // Keep only what this module writes; anything else in a hand-edited file is dropped.
  function sanitize(raw) {
    const out = {};
    if (!isObj(raw)) return out;
    for (const uid of Object.keys(raw)) {
      const u = raw[uid];
      if (!isObj(u) || typeof uid !== 'string' || !uid || uid.length > 64) continue;
      const rec = { default: {}, agents: {} };
      if (isObj(u.default)) for (const k of KINDS) if (MODES.includes(u.default[k])) rec.default[k] = u.default[k];
      if (isObj(u.agents)) {
        for (const a of Object.keys(u.agents)) {
          if (!AGENT_RE.test(a) || a.length > 64 || !isObj(u.agents[a])) continue;
          const e = {};
          for (const k of AGENT_KINDS) if (MODES.includes(u.agents[a][k])) e[k] = u.agents[a][k];
          if (Object.keys(e).length && Object.keys(rec.agents).length < MAX_AGENTS) rec.agents[a] = e;
        }
      }
      if (typeof u.updatedAt === 'string') rec.updatedAt = u.updatedAt;
      out[uid] = rec;
    }
    return out;
  }

  // Missing file: empty, cached. Corrupt JSON: the bad file is kept beside it as <file>.corrupt-<time>, then empty, cached.
  // Any other read error (EACCES, EIO...): not cached; reads answer as empty for now and writes refuse (see current()).
  function load() {
    if (data) return data;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      if (e && e.code === 'ENOENT') { unreadable = false; return (data = {}); }
      unreadable = true;
      return {};
    }
    unreadable = false;
    try { data = sanitize(JSON.parse(text)); }
    catch {
      try { const c = `${file}.corrupt-${now()}`; fs.copyFileSync(file, c); fs.chmodSync(c, 0o600); } catch {}
      data = {};
    }
    return data;
  }
  // The stored map for a change: throws (no code, so a route answers 500) when the file could not be read, so a
  // transient read error never lets one change overwrite everyone's settings.
  function current() {
    const all = load();
    if (unreadable) throw new Error('notification settings could not be read; nothing was changed');
    return all;
  }
  // Apply fn(record) to a copy of the person's record inside a copy of the map, write the copy, then adopt it.
  // A failed write leaves the cache as it was and the error propagates.
  function commit(userId, fn) {
    const next = structuredClone(current());
    if (!next[userId]) next[userId] = { default: {}, agents: {} };
    const was = current()[userId];
    fn(next[userId]);
    // The settings journal (store "prefs", keys prefs.<person>.notify.default.<kind> and prefs.<person>.notify.agents.<agent>.<kind>):
    // written BEFORE the file, and a change it cannot record is refused. A default is its effective mode ("on" when none is stored).
    const changes = [];
    for (const k of KINDS) {
      const b = (was && was.default[k]) || 'on', a = next[userId].default[k] || 'on';
      if (b !== a) changes.push({ key: `prefs.${userId}.notify.default.${k}`, before: b, after: a });
    }
    for (const ag of new Set([...Object.keys((was && was.agents) || {}), ...Object.keys(next[userId].agents)])) {
      for (const k of AGENT_KINDS) {
        const b = was && was.agents[ag] ? was.agents[ag][k] : undefined, a = next[userId].agents[ag] ? next[userId].agents[ag][k] : undefined;
        if (b !== a) changes.push({ key: `prefs.${userId}.notify.agents.${ag}.${k}`, before: b, after: a });
      }
    }
    next[userId].updatedAt = new Date(now()).toISOString();
    // Two phases: a pending entry before the file, a commit after it; a failed write marks the entry failed and the error propagates.
    require('./settings-journal').journaledWrite(file, changes, () => (write || writePrivate)(file, next));
    data = next;
  }
  const entry = (userId) => load()[userId];
  function view(userId) {
    const e = entry(userId);
    const agents = {};
    if (e) for (const a of Object.keys(e.agents)) agents[a] = { ...e.agents[a] };
    const def = {};
    for (const k of KINDS) def[k] = (e && e.default[k]) || 'on';
    return { default: def, agents };
  }

  function get(userId) { id64(userId, 'user id'); return view(userId); }

  function setDefault(userId, patch) {
    id64(userId, 'user id');
    const p = cleanPatch(patch, false);
    commit(userId, (e) => { for (const k of Object.keys(p)) e.default[k] = p[k]; });
    return view(userId);
  }

  function setAgent(userId, agent, prefs) {
    id64(userId, 'user id'); cleanAgent(agent);
    if (prefs !== null && !isObj(prefs)) throw bad('settings must be an object or null');
    const p = prefs === null ? null : cleanPatch(prefs, true, true);
    commit(userId, (e) => {
      if (p === null) delete e.agents[agent];
      else {
        if (!hasOwn(e.agents, agent) && Object.keys(e.agents).length >= MAX_AGENTS && Object.values(p).some(v => v !== null)) throw bad(`at most ${MAX_AGENTS} agents can have their own settings`);
        const cur = { ...(e.agents[agent] || {}) };
        for (const k of Object.keys(p)) { if (p[k] === null) delete cur[k]; else cur[k] = p[k]; }
        if (Object.keys(cur).length) e.agents[agent] = cur; else delete e.agents[agent];
      }
    });
    return view(userId);
  }

  function mode(userId, agent, kind) {
    if (!KINDS.includes(kind)) return 'on';
    const e = typeof userId === 'string' ? entry(userId) : null;
    if (!e) return 'on';
    const a = agent && kind !== 'security' && hasOwn(e.agents, agent) ? e.agents[agent][kind] : undefined;
    return a ?? e.default[kind] ?? 'on';
  }

  function touch(userId, page, visible) {
    id64(userId, 'user id'); id64(page, 'page id');
    if (typeof visible !== 'boolean') throw bad('visible must be true or false');
    let pages = presence.get(userId);
    if (!pages) presence.set(userId, (pages = new Map()));
    pages.delete(page);                  // re-insert so Map order is oldest-touched first
    pages.set(page, { visible, at: now() });
    while (pages.size > MAX_PAGES) pages.delete(pages.keys().next().value);
  }

  function isAway(userId) {
    const pages = presence.get(userId);
    if (!pages) return true;
    const t = now();
    for (const p of pages.values()) if (p.visible === true && t - p.at <= awayMs) return false;
    return true;
  }

  return { get, setDefault, setAgent, mode, touch, isAway, MODES, KINDS };
}

let singleton = null;
function getNotifyPrefs() {
  if (!singleton) singleton = createNotifyPrefs({ file: path.join(__dirname, '..', 'data', 'push', 'prefs.json') });
  return singleton;
}

module.exports = { createNotifyPrefs, getNotifyPrefs, MODES, KINDS };
