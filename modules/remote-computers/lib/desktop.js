'use strict';
// Open desktop: the sessions. One live session per computer, kept in a small private file (desktop-sessions.json in the connector's data folder) so a
// module restart (every settings save restarts it) keeps the lock. Times are epoch milliseconds. Expired entries are dropped whenever the file is read
// (an entry that ran out less than END_GRACE_MS ago stays for end(), so the hub can still close it with the reason "time"; it is never live).
const fs = require('node:fs');
const crypto = require('node:crypto');
const { writeFileAtomic } = require('./meshserver');

const MIN_MINUTES = 5, MAX_MINUTES = 120, DEFAULT_MINUTES = 30;
const END_GRACE_MS = 10 * 60000;
const SESSION_RE = /^[A-Za-z0-9_-]{43}$/;       // 32 random bytes, base64url
const TUNNEL_RE = /^[A-Za-z0-9]{6,64}$/;
const NODEID_RE = /^node\/[^\s/]*\/[^\s/]{1,200}$/;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SESSIONS = 200;

class DesktopError extends Error { constructor(message, extra) { super(message); this.name = 'DesktopError'; if (extra) Object.assign(this, { extra }); } }

const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : '');
function cleanWho(who) {
  if (!who || typeof who !== 'object' || Array.isArray(who)) throw new DesktopError('who: give the person as {"id","name"}.');
  const id = typeof who.id === 'string' ? text(who.id) : '', name = typeof who.name === 'string' ? text(who.name) : '';
  if (!id || !name || who.id.length > 100 || who.name.length > 100) throw new DesktopError('who: id and name must be text of 1 to 100 characters.');
  return { id, name };
}
const clampMinutes = (m, dflt = DEFAULT_MINUTES) => {
  const n = typeof m === 'number' && Number.isFinite(m) ? Math.round(m) : dflt;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, n));
};
const checkSession = (s) => { if (typeof s !== 'string' || !SESSION_RE.test(s)) throw new DesktopError('session: not a valid session.'); return s; };
const checkTunnel = (t) => { if (typeof t !== 'string' || !TUNNEL_RE.test(t)) throw new DesktopError('tunnelid: use 6 to 64 letters and digits.'); return t; };

/**
 * createDesktop({ file, now, randomBytes }) -> the session store. `file` may be '' (kept in memory only).
 * Records: { session, nodeid, name, who: { id, name }, start, until }.
 */
function createDesktop({ file = '', now = Date.now, randomBytes = (n) => crypto.randomBytes(n), readFile = (f) => fs.readFileSync(f, 'utf8'), log = () => {} } = {}) {
  let memory = {};
  let lastGood = {};      // the last map read or written successfully: what is used while the file cannot be read (fail closed: known locks stay)
  let warned = false;
  function readRaw() {
    if (!file) return { ...memory };
    let raw;
    try {
      const txt = readFile(file);
      if (typeof txt !== 'string' || txt.length > MAX_FILE_BYTES) throw new Error('unreadable');
      raw = JSON.parse(txt);
    } catch (e) {
      if (e && e.code === 'ENOENT') { lastGood = {}; warned = false; return {}; }   // no file: no sessions
      if (!warned) { warned = true; try { log('the desktop sessions file cannot be read; the sessions already known stay locked'); } catch { /* none */ } }
      return { ...lastGood };
    }
    warned = false;
    const out = {};
    const src = raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object' && !Array.isArray(raw.sessions) ? raw.sessions : {};
    for (const [id, r] of Object.entries(src)) {
      if (!SESSION_RE.test(id) || !r || typeof r !== 'object') continue;
      const start = Number(r.start), until = Number(r.until);
      if (typeof r.nodeid !== 'string' || !r.nodeid || typeof r.name !== 'string' || !r.who || typeof r.who.id !== 'string' || typeof r.who.name !== 'string' || !Number.isFinite(start) || !Number.isFinite(until)) continue;
      out[id] = { session: id, nodeid: r.nodeid, name: r.name, who: { id: r.who.id, name: r.who.name }, start, until };
    }
    lastGood = { ...out };
    return out;
  }
  function writeRaw(map) {
    if (!file) { memory = { ...map }; return; }
    writeFileAtomic(file, JSON.stringify({ sessions: map }, null, 2) + '\n');
    lastGood = { ...map };
  }
  // Drops what ran out more than the grace ago; the file is rewritten only when something was dropped.
  function load() {
    const map = readRaw();
    let dropped = false;
    for (const [id, r] of Object.entries(map)) if (r.until + END_GRACE_MS <= now()) { delete map[id]; dropped = true; }
    if (dropped) { try { writeRaw(map); } catch { /* the next write tries again */ } }
    return map;
  }
  const live = (r) => r.until > now();

  const list = () => Object.values(load()).filter(live).sort((a, b) => a.start - b.start);
  const get = (session) => { const r = load()[checkSession(session)]; return r && live(r) ? r : null; };
  const forNode = (nodeid) => Object.values(load()).find((r) => live(r) && r.nodeid === nodeid) || null;
  // The live session of a computer given as the agent wrote it: its name (any case), its short id or the start of it.
  const forQuery = (q) => {
    const want = typeof q === 'string' ? q.trim() : '';
    if (!want || want.length > 200) return null;
    const low = want.toLowerCase();
    return Object.values(load()).find((r) => {
      if (!live(r)) return false;
      const short = r.nodeid.split('/').pop();
      return r.name.toLowerCase() === low || short === want || (want.length >= 6 && short.startsWith(want)) || r.nodeid === want;
    }) || null;
  };

  function open({ nodeid, name, who, minutes, defaultMinutes }) {
    if (typeof nodeid !== 'string' || !NODEID_RE.test(nodeid)) throw new DesktopError('nodeid: not a valid computer id.');
    const person = cleanWho(who);
    const map = load();
    const taken = Object.values(map).find((r) => live(r) && r.nodeid === nodeid);
    if (taken) throw new DesktopError(`${taken.name} is in use by ${taken.who.name} until ${hhmm(taken.until)}.`, { busy: { who: { name: taken.who.name }, until: taken.until } });
    if (Object.values(map).filter(live).length >= MAX_SESSIONS) throw new DesktopError('Too many desktop sessions are open.');
    const start = now();
    const rec = { session: randomBytes(32).toString('base64url'), nodeid, name: text(name, 80).slice(0, 80) || nodeid, who: person, start, until: start + clampMinutes(minutes, defaultMinutes) * 60000 };
    map[rec.session] = rec;
    writeRaw(map);
    return rec;
  }
  // Ends a session now (also one that ran out a moment ago and is still in the file). Returns the record with `ended`.
  function end(session) {
    const map = load();
    const r = map[checkSession(session)];
    if (!r) throw new DesktopError('That desktop session is not open.');
    delete map[r.session];
    writeRaw(map);
    return { ...r, ended: Math.min(now(), r.until) };
  }
  // The same by computer, only while the stored record has exactly that start (a newer session opened since is never ended by an old orphan check).
  function endNode(nodeid, start) {
    const map = load();
    const r = Object.values(map).find((x) => x.nodeid === nodeid);
    if (!r || typeof start !== 'number' || r.start !== start) throw new DesktopError('That desktop session is not open.');
    return end(r.session);
  }
  return { list, get, forNode, forQuery, open, end, endNode, hhmm };
}

module.exports = { createDesktop, DesktopError, hhmm, clampMinutes, cleanWho, checkSession, checkTunnel, SESSION_RE, TUNNEL_RE, MIN_MINUTES, MAX_MINUTES, END_GRACE_MS };
