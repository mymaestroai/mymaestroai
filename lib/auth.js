'use strict';
// Accounts, sessions and two-factor for the hub.
//
//   users      data/users.json (0600): id, login (email, lower-case), name, role admin|member, password hash
//              (scrypt), TOTP (secret encrypted with data/.auth-key, AES-256-GCM), recovery codes (hashed),
//              disabled flag, grants (phase 3), timestamps.
//   sessions   data/auth.db (SQLite): session rows keyed by the SHA-256 of the cookie token, sliding 30-day
//              expiry, a "TOTP verified" flag (a session that still owes a code may only call the TOTP
//              routes), trusted devices (30 days, skip the code), login attempts (rate limit), audit log.
//   invites    one-time links an admin creates; accepting one sets the password (and enrols TOTP for admins).
//   service    a per-process random token for the hub's own loopback calls (consults, jobs, bridge); such
//              requests act as the hub, not as a user.
//
// No external dependencies: scrypt, HMAC, AES-GCM and randomness come from node:crypto.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.HUB_AUTH_DIR || path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const KEY_FILE = path.join(DATA_DIR, '.auth-key');
const DB_FILE = path.join(DATA_DIR, 'auth.db');

const SESSION_COOKIE = 'hub_sid';
const TRUST_COOKIE = 'hub_trust';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const TRUST_TTL_MS = 30 * 24 * 3600 * 1000;
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_FAILURES = 10;              // per login per window
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const SERVICE_HEADER = 'x-hub-service';
const SERVICE_TOKEN = crypto.randomBytes(32).toString('hex');

// ── Small helpers ────────────────────────────────────────────────────

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const nowIso = () => new Date().toISOString();

// API tokens (for scripts and other programs that are not a signed-in person): what each scope may call.
// The route lists live in lib/access.js (TOKEN_ROUTES); this is the human-readable side shown on the Users page.
const TOKEN_SCOPES = {
  chat: 'start a turn for one of the token\'s agents (POST /api/chat, /api/chat/stream)',
  interject: 'interject into or stop a running turn of one of the token\'s agents (POST /api/chat/interject, /api/chat/stop)',
  status: 'read hub and agent status (GET /api/health, /api/hub/status, /api/agents/status, /api/agents/<name>/turn)',
  'wallet-executor': 'call the scoped wallet executor (POST /api/wallet/execute, GET /api/wallet/executor); the executor\'s own token still applies',
  'openai-api': 'the OpenAI-compatible endpoints (/v1/models, /v1/chat/completions)',
};
const TOKEN_PREFIX = 'hub_';
const newId = () => `u_${crypto.randomBytes(6).toString('hex')}`;
function normLogin(s) { return String(s || '').trim().toLowerCase(); }

function parseCookies(req) {
  const out = {};
  const h = req && req.headers && req.headers.cookie;
  if (!h) return out;
  for (const part of String(h).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    // A malformed percent-escape in a cookie must not throw: this runs for every request, before any route
    // error handling, and an exception here used to take the whole process down (review F07).
    let v = part.slice(i + 1).trim();
    try { v = decodeURIComponent(v); } catch { /* keep the raw value; it will simply match no session */ }
    out[part.slice(0, i).trim()] = v;
  }
  return out;
}

function isSecureRequest(req) {
  const xf = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  if (xf) return xf.split(',')[0].trim() === 'https';
  return !!(req.socket && req.socket.encrypted);
}

function cookieHeader(name, value, { req, maxAgeMs, httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  if (req && isSecureRequest(req)) parts.push('Secure');
  if (maxAgeMs !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`);
  return parts.join('; ');
}

// ── Passwords (scrypt) ───────────────────────────────────────────────

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32 };
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, saltB64, hashB64] = String(stored || '').split('$');
    if (alg !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const got = crypto.scryptSync(String(password), salt, expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  } catch { return false; }
}
function passwordPolicy(password) {
  const s = String(password || '');
  if (s.length < 12) return 'Password must be at least 12 characters';
  if (s.length > 200) return 'Password is too long';
  return null;
}

// ── TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ───────────────────────────

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function hotp(secret, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}
function totpCode(secretB32, { now = Date.now(), step = 30, digits = 6 } = {}) {
  return hotp(base32Decode(secretB32), Math.floor(now / 1000 / step), digits);
}
/** -> matching counter or null; window ±1 step; lastCounter prevents replay of the same code. */
function totpVerify(secretB32, code, { now = Date.now(), step = 30, window = 1, lastCounter = -1 } = {}) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const key = base32Decode(secretB32);
  const cur = Math.floor(now / 1000 / step);
  for (let d = -window; d <= window; d++) {
    const counter = cur + d;
    if (counter <= lastCounter) continue;
    const expect = hotp(key, counter);
    if (expect.length === c.length && crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(c))) return counter;
  }
  return null;
}
function otpauthUri(secretB32, login, issuer = 'My Maestro AI') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(login)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ── Secret encryption at rest ────────────────────────────────────────

let authKey = null;
function getAuthKey() {
  if (authKey) return authKey;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(KEY_FILE)) authKey = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
  else { authKey = crypto.randomBytes(32); fs.writeFileSync(KEY_FILE, authKey.toString('hex'), { mode: 0o600 }); }
  return authKey;
}
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', getAuthKey(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return `${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}
function decrypt(blob) {
  const [ivB, tagB, encB] = String(blob || '').split('.');
  const d = crypto.createDecipheriv('aes-256-gcm', getAuthKey(), Buffer.from(ivB, 'base64'));
  d.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([d.update(Buffer.from(encB, 'base64')), d.final()]).toString('utf8');
}

// ── Users store ──────────────────────────────────────────────────────

// Module permissions are kept by agent name (lib/modules). Before an account's standing changes (role, disabled, deleted) what its agents were
// given as an admin's agents (a module level, starting without asking) is cleared, so it cannot come back with the account.
// Throws when it could not be cleared: the change is then not made.
function ownedAgentNames(userId) {
  return (require('./agents').getAgentsSync(true) || []).filter(a => a && a.name && a.owner && String(a.owner) === String(userId)).map(a => a.name);
}
const forgetModulePermissions = (names) => require('./modules').forgetAgentPermissions(names);

const TOTP_MAX_FAILS = 5;
const TOTP_LOCK_MS = 60000;

/** When this process runs as root, the new users.json keeps the owner of the one it replaces (or of the data folder when there is none yet),
 *  so `sudo mymaestro reset-password` does not leave a root-owned file the hub cannot read. Returns { uid, gid } when it changed the owner of
 *  the open file fd, else null. getuid / fchown / stat / fstat can be injected (tests). As root, a chown that fails (or does not take) THROWS:
 *  nothing is saved rather than a root-owned file the hub cannot read. */
function keepFileOwner(fd, { dataDir, usersFile, getuid = process.getuid ? process.getuid.bind(process) : null, fchown = fs.fchownSync, stat = fs.statSync, fstat = fs.fstatSync } = {}) {
  if (typeof getuid !== 'function' || getuid() !== 0) return null;
  let st = null;
  try { st = stat(usersFile); } catch { try { st = stat(dataDir); } catch { return null; } }
  const kept = () => new Error(`the file's owner could not be kept (user ${st.uid}, group ${st.gid}), so nothing was saved. Run this as the user that runs your Maestro.`);
  let before = null;
  try { before = fstat(fd); } catch { /* checked below */ }
  if (before && before.uid === st.uid && before.gid === st.gid) return { uid: st.uid, gid: st.gid };   // already right: no chown (filesystems that refuse it)
  try { fchown(fd, st.uid, st.gid); } catch { throw kept(); }
  let now;
  try { now = fstat(fd); } catch { throw kept(); }
  if (now.uid !== st.uid || now.gid !== st.gid) throw kept();
  return { uid: st.uid, gid: st.gid };
}

// Every session is bound to the password it was made with; an account without one is bound to a fixed marker (setting a password
// then ends those sessions like any change).
const credDigest = (hash) => crypto.createHash('sha256').update(hash ? String(hash) : 'no password set').digest('hex').slice(0, 32);

function createAuth({ dataDir = DATA_DIR, now = Date.now, log = console.log, forgetPermissions = forgetModulePermissions, onTotpLock = null, lookForNewMembers = null,
  getuid = process.getuid ? process.getuid.bind(process) : null, fchown = fs.fchownSync, fstat = fs.fstatSync, unlinkFile = fs.unlinkSync } = {}) {
  let totpLockNotifier = typeof onTotpLock === 'function' ? onTotpLock : () => {};
  const usersFile = path.join(dataDir, 'users.json');
  const dbFile = path.join(dataDir, 'auth.db');
  let store = null;
  let stamp = null;          // the stamp of users.json that `store` was read from (null: the file was missing)
  let badStamp = null;       // the stamp of an unreadable users.json already reported
  let db = null;

  // The running hub and the `mymaestro` command are two processes on one users.json. The file is re-read when it changed
  // (its stamp differs from the copy in memory), and every write goes through mutate(), which never overwrites a newer file.
  function fileStamp() {
    try { const s = fs.statSync(usersFile); return `${s.mtimeMs}:${s.size}:${s.ino}`; } catch { return null; }
  }
  const EMPTY = () => ({ version: 1, users: [], invites: [] });
  const normalise = (d) => {
    if (!d || typeof d !== 'object' || Array.isArray(d)) d = EMPTY();
    if (!Array.isArray(d.users)) d.users = [];
    if (!Array.isArray(d.invites)) d.invites = [];
    return d;
  };
  // The stamp moves ONLY after a successful read (or our own write). A file that cannot be read, or that vanished while a copy read from a
  // file is in memory, keeps that copy and the old stamp: the next save then does not believe it holds the newest file (see mutate).
  function load() {
    const st = fileStamp();   // taken BEFORE the read: a file replaced meanwhile makes the stamp older than the content, which only costs a re-read
    if (store && st === stamp) return store;
    if (st === null) {
      if (store && stamp !== null) {   // vanished: keep what was read from it
        if (badStamp !== 'gone') { badStamp = 'gone'; log('[auth] users.json is gone; keeping the copy in memory'); }
        return store;
      }
      store = EMPTY(); stamp = null; return store;
    }
    let fresh = null;
    try { fresh = JSON.parse(fs.readFileSync(usersFile, 'utf8')); } catch (e) {
      if (!store) store = EMPTY();   // nothing in memory yet: today's empty default (the stamp is left alone)
      else if (badStamp !== st) { badStamp = st; log(`[auth] users.json could not be read (${e.message}); keeping the copy in memory`); }
      return store;
    }
    store = normalise(fresh);
    stamp = st; badStamp = null;
    return store;
  }
  const cantRead = (why) => new Error(`users.json can't be read, so nothing was saved (${why}). Its owner or permissions changed, for example after running mymaestro with sudo.`);
  // Reads users.json from disk now, for a change. Throws (cantRead) when it cannot be read; a file that never existed is the empty default.
  function readForChange() {
    const st = fileStamp();
    let text;
    try { text = fs.readFileSync(usersFile, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') {
        if (stamp !== null) throw cantRead('the file is gone');
        return { data: EMPTY(), st: null };
      }
      throw cantRead(e.message);
    }
    let data;
    try { data = JSON.parse(text); } catch (e) { throw cantRead(`it is not valid JSON: ${e.message}`); }
    return { data: normalise(data), st };
  }

  // A lock across processes (the running hub, `mymaestro`, a second copy): users.json.lock, made with 'wx'. Stale after 10 s.
  const lockFile = path.join(dataDir, 'users.json.lock');
  const LOCK_WAIT_MS = 3000, LOCK_STALE_MS = 10000, TMP_STALE_MS = 60000;
  const sleepSlot = new Int32Array(new SharedArrayBuffer(4));
  const sleep = (ms) => { try { Atomics.wait(sleepSlot, 0, 0, ms); } catch { const end = Date.now() + ms; while (Date.now() < end) { /* wait */ } } };
  let staleLogged = false, loginWriteLogged = false;
  function acquireLock() {
    const deadline = Date.now() + LOCK_WAIT_MS;
    const mine = `${process.pid} ${Date.now()} ${crypto.randomBytes(6).toString('hex')}`;
    for (;;) {
      try {
        const fd = fs.openSync(lockFile, 'wx', 0o600);
        try { fs.writeSync(fd, mine); } finally { fs.closeSync(fd); }
        return () => { try { if (fs.readFileSync(lockFile, 'utf8') === mine) fs.unlinkSync(lockFile); } catch { /* already gone */ } };
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      if (Date.now() >= deadline) throw new Error('users.json is busy; nothing was saved. Try again.');
      let age;
      try { age = Date.now() - fs.statSync(lockFile).mtimeMs; } catch { continue; }   // released just now: try again (the deadline is checked above)
      if (age > LOCK_STALE_MS) {
        try { unlinkFile(lockFile); } catch (e) {
          if (e.code !== 'ENOENT') throw new Error(`users.json.lock is stale but could not be removed (${lockFile}: ${e.message}); nothing was saved.`);   // someone else taking it over is ENOENT
        }
        if (!staleLogged) { staleLogged = true; log('[auth] users.json.lock was left behind by a process that stopped; taken over'); }
        continue;
      }
      sleep(10);
    }
  }
  function removeStaleTemps() {
    let names = [];
    try { names = fs.readdirSync(dataDir); } catch { return; }
    for (const n of names) {
      if (!/^\.users\..*\.tmp$/.test(n)) continue;
      const p = path.join(dataDir, n);
      try { if (Date.now() - fs.statSync(p).mtimeMs > TMP_STALE_MS) fs.unlinkSync(p); } catch { /* gone */ }
    }
  }

  // The one write path. fn(store, abort) changes the fresh store synchronously and returns a value; call abort(value) BEFORE changing
  // anything to answer without writing. Slow work and side effects (hashing, encrypting, audit, sessions) stay outside fn: fn may run again.
  // Under the lock the file is always read again from disk (never trusted from memory), fn runs on that copy, and the result replaces the
  // file. When users.json cannot be read, nothing is written.
  class Abort { constructor(value) { this.value = value; } }
  const abort = (value) => { throw new Abort(value); };
  function mutate(fn) {
    if (stamp !== null && !fs.existsSync(usersFile)) throw cantRead('the file is gone');   // before anything is created in a vanished folder
    fs.mkdirSync(dataDir, { recursive: true });
    const release = acquireLock();
    try {
      removeStaleTemps();
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = readForChange();   // throws when it cannot be read: nothing is written, and reads keep serving the copy in memory
        const s = cur.data, loaded = cur.st;
        store = s; stamp = loaded; badStamp = null;
        let result;
        try { result = fn(s, abort); }
        catch (e) { if (e instanceof Abort) return e.value; store = null; throw e; }
        const tmp = path.join(dataDir, `.users.${crypto.randomBytes(8).toString('hex')}.tmp`);
        let newStamp;
        try {
          const fd = fs.openSync(tmp, 'wx', 0o600);
          try {
            keepFileOwner(fd, { dataDir, usersFile, getuid, fchown, fstat });
            fs.writeSync(fd, JSON.stringify(s, null, 2)); fs.fsyncSync(fd);
          } finally { fs.closeSync(fd); }
          if (fileStamp() !== loaded) { fs.unlinkSync(tmp); store = null; continue; }   // changed by a writer that does not take the lock: start over from the new file
          const t = fs.statSync(tmp);   // a rename keeps inode, size and mtime: this is the stamp of users.json after it
          newStamp = `${t.mtimeMs}:${t.size}:${t.ino}`;
          fs.renameSync(tmp, usersFile);
        } catch (e) { try { fs.unlinkSync(tmp); } catch {} store = null; throw e; }
        stamp = newStamp;
        try { fs.chmodSync(usersFile, 0o600); } catch {}
        return result;
      }
      store = null;
      throw new Error('users.json keeps changing under this change; nothing was saved. Try again.');
    } finally { release(); }
  }
  function getDb() {
    if (db) return db;
    const Database = require('better-sqlite3');
    fs.mkdirSync(dataDir, { recursive: true });
    const d = new Database(dbFile);   // kept as `db` only once it is ready: a failed migration is tried again on the next call
    try { openDb(d); } catch (e) { try { d.close(); } catch {} throw e; }
    db = d;
    return db;
  }
  function openDb(db) {
    try { fs.chmodSync(dbFile, 0o600); } catch {}
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT, last_seen TEXT, expires_at TEXT, ua TEXT, ip TEXT, totp_ok INTEGER DEFAULT 0, cred TEXT);
      CREATE TABLE IF NOT EXISTS trusted (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT, expires_at TEXT, ua TEXT);
      CREATE TABLE IF NOT EXISTS attempts (login TEXT, ts INTEGER, ok INTEGER);
      CREATE INDEX IF NOT EXISTS attempts_login ON attempts(login, ts);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, user_id TEXT, action TEXT, detail TEXT, ip TEXT);
      CREATE TABLE IF NOT EXISTS totp_lock (user_id TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, scopes TEXT NOT NULL, agents TEXT, loopback_only INTEGER DEFAULT 1, created_at TEXT, created_by TEXT, expires_at TEXT, last_used TEXT, revoked_at TEXT);
    `);
    // Sessions made before sessions were bound to the password have no cred column. Add it in one write transaction (the hub and
    // a mymaestro command may open an old database at the same moment), then bind those rows to the password their account has
    // now, so a reset that is cut short before its revoke still ends them. setPassword binds that account's rows again before
    // it writes (bindUnbound), so a binding skipped here (users.json unreadable at open) never meets a new password.
    try { db.transaction(() => { if (!db.prepare('PRAGMA table_info(sessions)').all().some(c => c.name === 'cred')) db.exec('ALTER TABLE sessions ADD COLUMN cred TEXT'); }).immediate(); }
    catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; }
    try { bindUnbound(db, readForChange().data.users, null); } catch { /* users.json unreadable now: bound at the next open or before a password change */ }
  }
  // Binds session rows without cred (made before sessions were bound) to the password their account has in `accounts` (a fresh read).
  function bindUnbound(d, accounts, onlyUser) {
    const unbound = onlyUser ? d.prepare('SELECT DISTINCT user_id FROM sessions WHERE cred IS NULL AND user_id = ?').all(onlyUser)
      : d.prepare('SELECT DISTINCT user_id FROM sessions WHERE cred IS NULL').all();
    if (!unbound.length) return;
    const bind = d.prepare('UPDATE sessions SET cred = ? WHERE cred IS NULL AND user_id = ?');
    d.transaction(() => { for (const r of unbound) { const a = accounts.find(x => x.id === r.user_id); if (a) bind.run(credDigest(a.passwordHash), r.user_id); } })();
  }
  function audit(userId, action, detail = '', ip = null) {
    try { getDb().prepare('INSERT INTO audit (ts, user_id, action, detail, ip) VALUES (?,?,?,?,?)').run(nowIso(), userId || null, action, String(detail || '').slice(0, 500), ip || null); } catch {}
    log(`[auth] ${action}${userId ? ` user=${userId}` : ''}${detail ? ` ${String(detail).slice(0, 120)}` : ''}`);
  }

  // ── API tokens ──
  // A token stands in for a login in programs (cron bots, dashboards, API clients). The secret "hub_<id>_<random>"
  // is shown once; only its SHA-256 is stored. A token names its scopes (TOKEN_SCOPES) and, for chat/interject, the
  // agents it may address. By default it is accepted from this machine only (a request that came through a proxy
  // such as Tailscale Serve carries forwarding headers and does not count as local).
  function publicToken(t) {
    return { id: t.id, name: t.name, scopes: JSON.parse(t.scopes || '[]'), agents: t.agents ? JSON.parse(t.agents) : null, loopbackOnly: !!t.loopback_only,
      createdAt: t.created_at, createdBy: t.created_by, expiresAt: t.expires_at, lastUsed: t.last_used, revokedAt: t.revoked_at };
  }
  function createToken({ name, scopes, agents = null, loopbackOnly = true, expiresDays = null, by = null } = {}) {
    const n = String(name || '').trim();
    if (!/^[\w .-]{1,60}$/.test(n)) throw new Error('name: 1-60 letters, digits, spaces, dots or dashes');
    const sc = [...new Set((Array.isArray(scopes) ? scopes : String(scopes || '').split(',')).map(s => String(s).trim()).filter(Boolean))];
    if (!sc.length) throw new Error('at least one scope');
    for (const s of sc) if (!TOKEN_SCOPES[s]) throw new Error(`unknown scope "${s}" (${Object.keys(TOKEN_SCOPES).join(', ')})`);
    let ag = null;
    if (agents != null && agents !== '') {
      ag = [...new Set((Array.isArray(agents) ? agents : String(agents).split(',')).map(s => String(s).trim().toLowerCase()).filter(Boolean))];
      if (!ag.every(a => /^[a-z][a-z0-9_-]*$/.test(a))) throw new Error('agents: agent names, comma separated');
    }
    if ((sc.includes('chat') || sc.includes('interject')) && !(ag && ag.length)) throw new Error('the chat and interject scopes need an agents list');
    const days = expiresDays == null || expiresDays === '' ? null : Number(expiresDays);
    if (days != null && !(days > 0 && days <= 3650)) throw new Error('expiresDays: 1 to 3650');
    const id = crypto.randomBytes(6).toString('hex');
    const secret = `${TOKEN_PREFIX}${id}_${crypto.randomBytes(32).toString('base64url')}`;
    const expiresAt = days ? new Date(now() + days * 86400000).toISOString() : null;
    getDb().prepare('INSERT INTO tokens (id, name, hash, scopes, agents, loopback_only, created_at, created_by, expires_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, n, sha256(secret), JSON.stringify(sc), ag ? JSON.stringify(ag) : null, loopbackOnly ? 1 : 0, new Date(now()).toISOString(), by || null, expiresAt);
    audit(by, 'token.create', `${id} "${n}" scopes=${sc.join('+')} agents=${ag ? ag.join('+') : 'none'} loopbackOnly=${!!loopbackOnly}${expiresAt ? ` expires=${expiresAt}` : ''}`);
    return { token: secret, record: publicToken(getDb().prepare('SELECT * FROM tokens WHERE id = ?').get(id)) };
  }
  function listTokens() { return getDb().prepare('SELECT * FROM tokens ORDER BY created_at DESC').all().map(publicToken); }
  function getToken(id) { const t = getDb().prepare('SELECT * FROM tokens WHERE id = ?').get(String(id)); return t ? publicToken(t) : null; }
  function revokeToken(id, { by = null } = {}) {
    const r = getDb().prepare('UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(new Date(now()).toISOString(), String(id));
    if (!r.changes) throw new Error('no such active token');
    audit(by, 'token.revoke', String(id));
    return getToken(id);
  }
  /** A request that reached the hub directly from this machine (not through a proxy that forwards for someone else). */
  function isLocalRequest(req) {
    return isLoopback(req) && !req.headers['x-forwarded-for'] && !req.headers['tailscale-user-login'];
  }
  /** tokenFromRequest(req) -> null (no bearer) | { ok: true, token } | { ok: false, reason }. */
  function tokenFromRequest(req) {
    const h = String(req.headers.authorization || '');
    if (!/^Bearer\s+/i.test(h)) return null;
    const secret = h.replace(/^Bearer\s+/i, '').trim();
    if (!secret.startsWith(TOKEN_PREFIX)) return { ok: false, reason: 'not a hub token' };
    const digest = sha256(secret);
    const row = getDb().prepare('SELECT * FROM tokens WHERE hash = ?').get(digest);
    if (!row || !crypto.timingSafeEqual(Buffer.from(row.hash), Buffer.from(digest))) return { ok: false, reason: 'unknown token' };
    if (row.revoked_at) return { ok: false, reason: 'token revoked' };
    if (row.expires_at && Date.parse(row.expires_at) <= now()) return { ok: false, reason: 'token expired' };
    if (row.loopback_only && !isLocalRequest(req)) return { ok: false, reason: 'this token works from the hub machine only' };
    if (!row.last_used || now() - Date.parse(row.last_used) > 60000) { try { getDb().prepare('UPDATE tokens SET last_used = ? WHERE id = ?').run(new Date(now()).toISOString(), row.id); } catch {} }
    return { ok: true, token: publicToken(row) };
  }

  function publicUser(u) {
    if (!u) return null;
    return { id: u.id, timeZone: u.timeZone || null, timeZonePinned: !!u.timeZonePinned, uiMode: u.uiMode || null, theme: u.theme || null, login: u.login, name: u.name, role: u.role, disabled: !!u.disabled, totpEnabled: !!(u.totp && u.totp.enabled), grants: u.grants || {}, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null };
  }
  function listUsers() { return load().users.map(publicUser); }
  function getUser(id) { return load().users.find(u => u.id === id) || null; }
  function findByLogin(login) { const l = normLogin(login); return load().users.find(u => u.login === l) || null; }
  function hasUsers() { return load().users.length > 0; }
  function admins() { return load().users.filter(u => u.role === 'admin' && !u.disabled); }
  /** The owner of this Maestro: the earliest-created active admin. isOwner(user) is true only for that person. */
  function ownerUser() {
    const list = admins().slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    return list[0] || null;
  }
  function isOwner(user) {
    // A hub without accounts (legacy password or open): the signed-in person is the owner; with accounts only the earliest admin.
    if (!hasUsers()) return !!user;
    const o = ownerUser(); return !!(o && user && user.id !== undefined && String(user.id) === String(o.id)); }

  /** The look a new member starts with: the admin setting lookDefaultForNewMembers (a registry id), else Engineering. */
  function newMemberLook() {
    const { byId } = require('./ui-looks');
    try {
      const v = typeof lookForNewMembers === 'function' ? lookForNewMembers() : require('./settings').getSetting('lookDefaultForNewMembers', 'engineering');
      return byId(v) ? v : 'engineering';
    } catch { return 'engineering'; }
  }
  function createUser({ login, name, role = 'member', password = null }) {
    login = normLogin(login);
    if (!login || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login)) return { ok: false, error: 'login must be an email address' };
    if (!['admin', 'member'].includes(role)) return { ok: false, error: 'role must be admin or member' };
    if (findByLogin(login)) return { ok: false, error: 'a user with that login exists' };
    if (password !== null) { const e = passwordPolicy(password); if (e) return { ok: false, error: e }; }
    const u = { id: newId(), login, name: String(name || login.split('@')[0]).trim().slice(0, 80), role, passwordHash: password !== null ? hashPassword(password) : null,
      totp: null, recovery: [], disabled: false, grants: {}, createdAt: nowIso(), lastLoginAt: null, totpLastCounter: -1 };
    if (role === 'member') u.look = newMemberLook();   // existing accounts have none and keep following the device
    const dup = mutate((s, stop) => {
      if (s.users.some(x => x.login === login)) stop({ ok: false, error: 'a user with that login exists' });   // created by someone else meanwhile
      s.users.push(u);
      return null;
    });
    if (dup) return dup;
    audit(u.id, 'user.create', `${login} ${role}`);
    return { ok: true, user: publicUser(u) };
  }
  function updateUser(id, patch, { by = null } = {}) {
    const u = getUser(id);
    if (!u) return { ok: false, error: 'no such user' };
    const standingChanges = (patch.role !== undefined && patch.role !== u.role) || (patch.disabled !== undefined && !!patch.disabled !== !!u.disabled);
    if (patch.role !== undefined) {
      if (!['admin', 'member'].includes(patch.role)) return { ok: false, error: 'bad role' };
      if (u.role === 'admin' && patch.role !== 'admin' && admins().filter(a => a.id !== u.id).length === 0) return { ok: false, error: 'cannot demote the last admin' };
    }
    if (patch.disabled !== undefined) {
      if (patch.disabled && (patch.role !== undefined ? patch.role : u.role) === 'admin' && admins().filter(a => a.id !== u.id).length === 0) return { ok: false, error: 'cannot disable the last admin' };
    }
    if (standingChanges) {
      try { const names = ownedAgentNames(u.id); if (names.length) forgetPermissions(names); }
      catch (e) { return { ok: false, error: `Could not clear what this account's agents were given in modules (${e.message}). Nothing was changed.` }; }
    }
    // The change itself, on the freshest file: the checks above are made again there, since another process may have changed accounts meanwhile.
    const r = mutate((s, stop) => {
      const cur = s.users.find(x => x.id === id);
      if (!cur) stop({ ok: false, error: 'no such user' });
      const others = () => s.users.filter(a => a.role === 'admin' && !a.disabled && a.id !== cur.id).length;
      if (patch.role !== undefined && cur.role === 'admin' && patch.role !== 'admin' && others() === 0) stop({ ok: false, error: 'cannot demote the last admin' });
      if (patch.disabled && (patch.role !== undefined ? patch.role : cur.role) === 'admin' && others() === 0) stop({ ok: false, error: 'cannot disable the last admin' });
      if (patch.name !== undefined) cur.name = String(patch.name || '').trim().slice(0, 80) || cur.name;
      if (patch.role !== undefined) cur.role = patch.role;
      if (patch.disabled !== undefined) cur.disabled = !!patch.disabled;
      let grantsChanged = false;
      if (patch.grants !== undefined && patch.grants && typeof patch.grants === 'object') {
        const before = JSON.stringify(cur.grants || {});
        cur.grants = { ...patch.grants };
        grantsChanged = JSON.stringify(cur.grants) !== before;
      }
      return { ok: true, user: publicUser(cur), login: cur.login, grants: cur.grants, grantsChanged, disabled: !!cur.disabled };
    });
    if (!r.ok) return r;
    if (patch.disabled !== undefined && r.disabled) revokeSessions(id);
    if (r.grantsChanged) audit(by || id, 'user.grants', `${r.login} ${JSON.stringify(r.grants)}`.slice(0, 400));
    audit(by || id, 'user.update', `${r.login} ${Object.keys(patch).join(',')}`);
    return { ok: true, user: r.user };
  }
  // A person's time zone (lib/timezone): what their agents use for "now" and for every time they show. Reports from
  // their browser (auto) follow the device they use, unless they pinned a zone in their Profile. Saved only on a
  // change, and only an explicit choice is audited (pages report their zone again and again while in use).
  function setTimeZone(id, tz, { auto = false, pinned = false } = {}) {
    const u = getUser(id);
    if (!u) return { ok: false, error: 'no such user' };
    const tzLib = require('./timezone');
    if (tz != null && !tzLib.isZone(tz)) return { ok: false, error: 'unknown time zone' };
    if (auto) {
      if (!tz || u.timeZonePinned || u.timeZone === tz) return { ok: true, changed: false, user: publicUser(u) };
      return mutate((s, stop) => {
        const cur = s.users.find(x => x.id === id);
        if (!cur) stop({ ok: false, error: 'no such user' });
        if (cur.timeZonePinned || cur.timeZone === tz) stop({ ok: true, changed: false, user: publicUser(cur) });
        cur.timeZone = tz;
        return { ok: true, changed: true, user: publicUser(cur) };
      });
    }
    if (pinned && !tz) return { ok: false, error: 'pick a time zone to pin' };
    const r = mutate((s, stop) => {
      const cur = s.users.find(x => x.id === id);
      if (!cur) stop({ ok: false, error: 'no such user' });
      const before = `${cur.timeZone || ''}|${!!cur.timeZonePinned}`;
      const nextZone = pinned ? tz : (tz || cur.timeZone);
      const nextPinned = !!pinned;
      if (`${nextZone || ''}|${nextPinned}` === before) {
        // nothing changes in the values; the old code still set an explicit `false` flag in memory, which was never saved on its own
        stop({ ok: true, changed: false, user: publicUser(cur) });
      }
      cur.timeZone = nextZone; cur.timeZonePinned = nextPinned;
      return { ok: true, changed: true, user: publicUser(cur), login: cur.login, zone: cur.timeZone, pinned: cur.timeZonePinned };
    });
    if (r.ok && r.changed) audit(id, 'user.timezone', `${r.login} ${r.zone || '-'} ${r.pinned ? 'pinned' : 'follows the device'}`);
    return r;
  }
  // A person's look: 'simple' | 'advanced' page, 'light' | 'dark' | 'auto' theme. Unset = the default by role (server.js /api/me).
  const UI_MODES = ['simple', 'advanced'], THEMES = ['light', 'dark', 'auto'];
  function setPrefs(id, prefs = {}) {
    const u = getUser(id);
    if (!u) return { ok: false, error: 'no such user' };
    const p = prefs && typeof prefs === 'object' ? prefs : {};
    if (p.uiMode === undefined && p.theme === undefined) return { ok: false, error: 'Send a uiMode (simple or advanced) or a theme (light, dark or auto).' };
    if (p.uiMode !== undefined && !UI_MODES.includes(p.uiMode)) return { ok: false, error: 'uiMode must be simple or advanced.' };
    if (p.theme !== undefined && !THEMES.includes(p.theme)) return { ok: false, error: 'theme must be light, dark or auto.' };
    return mutate((s, stop) => {
      const cur = s.users.find(x => x.id === id);
      if (!cur) stop({ ok: false, error: 'no such user' });
      if (p.uiMode !== undefined) cur.uiMode = p.uiMode;
      if (p.theme !== undefined) cur.theme = p.theme;
      return { ok: true, user: publicUser(cur) };
    });
  }
  function deleteUser(id, { by = null } = {}) {
    const u = load().users.find(x => x.id === id);
    if (!u) return { ok: false, error: 'no such user' };
    if (u.role === 'admin' && admins().filter(a => a.id !== u.id).length === 0) return { ok: false, error: 'cannot delete the last admin' };
    try { const names = ownedAgentNames(u.id); if (names.length) forgetPermissions(names); }
    catch (e) { return { ok: false, error: `Could not clear what this account's agents were given in modules (${e.message}). Nothing was deleted.` }; }
    const r = mutate((s, stop) => {
      const cur = s.users.find(x => x.id === id);
      if (!cur) stop({ ok: false, error: 'no such user' });
      if (cur.role === 'admin' && s.users.filter(a => a.role === 'admin' && !a.disabled && a.id !== cur.id).length === 0) stop({ ok: false, error: 'cannot delete the last admin' });
      s.users = s.users.filter(x => x.id !== id);
      return { ok: true, login: cur.login };
    });
    if (!r.ok) return r;
    revokeSessions(id);
    audit(by, 'user.delete', r.login);
    return { ok: true };
  }
  function setPassword(id, password, { by = null } = {}) {
    const u = getUser(id);
    if (!u) return { ok: false, error: 'no such user' };
    const e = passwordPolicy(password); if (e) return { ok: false, error: e };
    const passwordHash = hashPassword(password);   // slow: outside the write
    // Before the new hash is written: every session of this account is bound to the password it has now (read from the file; if it
    // cannot be read this throws and nothing is saved), so a change cut short before the revoke below still ends them.
    bindUnbound(getDb(), readForChange().data.users, id);
    const r = mutate((s, stop) => {
      const cur = s.users.find(x => x.id === id);
      if (!cur) stop({ ok: false, error: 'no such user' });
      cur.passwordHash = passwordHash;
      return { ok: true, login: cur.login };
    });
    if (!r.ok) return r;
    // Sessions are bound to the password they were made with (cred), so any not yet revoked stop working by themselves.
    // Someone changing their own password stays signed in: their sessions take the new digest.
    if (by !== id) revokeSessions(id);
    else getDb().prepare('UPDATE sessions SET cred = ? WHERE user_id = ?').run(credDigest(passwordHash), id);
    audit(by || id, 'password.set', r.login);
    return { ok: true };
  }
  /** Forget the failed sign-in attempts of one login (and nothing else), e.g. after a forgotten password was reset. */
  function clearFailures(loginName) {
    getDb().prepare('DELETE FROM attempts WHERE login = ? AND ok = 0').run(normLogin(loginName));
  }

  // ── Login / rate limit ──
  function failures(login) {
    const since = now() - FAILURE_WINDOW_MS;
    return getDb().prepare('SELECT COUNT(*) AS n FROM attempts WHERE login = ? AND ok = 0 AND ts > ?').get(normLogin(login), since).n;
  }
  function recordAttempt(login, ok) {
    getDb().prepare('INSERT INTO attempts (login, ts, ok) VALUES (?,?,?)').run(normLogin(login), now(), ok ? 1 : 0);
    if (Math.random() < 0.05) getDb().prepare('DELETE FROM attempts WHERE ts < ?').run(now() - 24 * 3600 * 1000);
  }
  /** -> { ok, user, needsTotp, error, locked } */
  function login(loginName, password, { ip = null } = {}) {
    const l = normLogin(loginName);
    if (failures(l) >= MAX_FAILURES) { audit(null, 'login.locked', l, ip); return { ok: false, locked: true, error: 'Too many failed attempts. Try again in 15 minutes.' }; }
    const u = findByLogin(l);
    const good = !!(u && !u.disabled && u.passwordHash && verifyPassword(password, u.passwordHash));
    recordAttempt(l, good);
    if (!good) { audit(u ? u.id : null, 'login.fail', l, ip); return { ok: false, error: 'Wrong login or password' }; }
    getDb().prepare('DELETE FROM attempts WHERE login = ? AND ok = 0').run(l);   // a good sign-in resets the failure count
    const when = nowIso();
    let cur;
    try {
      cur = mutate((s, stop) => {
        const x = s.users.find(y => y.id === u.id);
        // deleted, turned off, or its password changed (a reset) since the one just checked: no sign-in from the old password
        if (!x || x.disabled || x.passwordHash !== u.passwordHash) stop(null);
        x.lastLoginAt = when;
        return x;
      });
      loginWriteLogged = false;
    } catch (e) {
      // users.json cannot be saved right now (unreadable, busy): people can still sign in while it is being fixed
      if (!loginWriteLogged) { loginWriteLogged = true; log(`[auth] sign-in went through but its time was not saved: ${e.message}`); }
      cur = u;
    }
    if (!cur) return { ok: false, error: 'Wrong login or password' };   // the account was deleted, turned off or reset a moment ago
    audit(cur.id, 'login.ok', l, ip);
    return { ok: true, user: cur, needsTotp: !!(cur.totp && cur.totp.enabled) };
  }

  // ── Sessions ──
  function createSession(user, { req = null, totpOk = false } = {}) {
    // The account may have changed since the password was checked (deleted, turned off, a new password): then no session starts.
    // Read from disk now: no session starts while users.json cannot be read.
    let fresh;
    try { fresh = readForChange().data; } catch { throw new Error('the account changed; sign in again'); }
    const now0 = fresh.users.find(x => x.id === user.id);
    if (!now0 || now0.disabled || (user.passwordHash && now0.passwordHash !== user.passwordHash)) throw new Error('the account changed; sign in again');
    const token = b64url(crypto.randomBytes(32));
    const id = sha256(token);
    const t = now();
    getDb().prepare('INSERT INTO sessions (id, user_id, created_at, last_seen, expires_at, ua, ip, totp_ok, cred) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, user.id, new Date(t).toISOString(), new Date(t).toISOString(), new Date(t + SESSION_TTL_MS).toISOString(), req ? String(req.headers['user-agent'] || '').slice(0, 200) : null, req ? clientIp(req) : null, totpOk ? 1 : 0, credDigest(now0.passwordHash));
    return { token, id, cookie: cookieHeader(SESSION_COOKIE, token, { req, maxAgeMs: SESSION_TTL_MS }) };
  }
  function getSession(token) {
    if (!token) return null;
    const d = getDb();
    const row = d.prepare('SELECT * FROM sessions WHERE id = ?').get(sha256(token));
    if (!row) return null;
    if (Date.parse(row.expires_at) < now()) { d.prepare('DELETE FROM sessions WHERE id = ?').run(row.id); return null; }
    if (row.cred === null || row.cred === undefined) return row;   // made before sessions were bound and never bound since: as before
    // A bound row is judged only on accounts that are verifiably users.json as it is now: the copy in memory when its stamp is the
    // file's, otherwise a fresh read. Every unverified state (the file missing or unreadable, a cold start without it) refuses the
    // request and keeps the row, so a session is never ended on a copy that may be stale or empty.
    let users = null;
    if (stamp !== null) { const s = load(); if (stamp !== null && fileStamp() === stamp) users = s.users; }
    if (!users) {
      let snapshot;
      try { snapshot = readForChange(); } catch { return null; }
      if (snapshot.st === null || fileStamp() !== snapshot.st) return null;
      users = snapshot.data.users;
    }
    const account = users.find(u => u.id === row.user_id);
    if (account && credDigest(account.passwordHash) === row.cred) return row;
    // A password change by the person themselves may have rebound this row since the SELECT: delete only the digest we judged.
    d.prepare('DELETE FROM sessions WHERE id = ? AND cred = ?').run(row.id, row.cred);
    return null;
  }
  function touchSession(id) {
    const t = now();
    getDb().prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?').run(new Date(t).toISOString(), new Date(t + SESSION_TTL_MS).toISOString(), id);
  }
  function markTotpOk(sessionId) { getDb().prepare('UPDATE sessions SET totp_ok = 1 WHERE id = ?').run(sessionId); }
  function destroySession(token) { if (token) getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sha256(token)); }
  function revokeSessions(userId) { getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId); getDb().prepare('DELETE FROM trusted WHERE user_id = ?').run(userId); }
  function listSessions(userId) { return getDb().prepare('SELECT id, created_at, last_seen, ua, ip, totp_ok FROM sessions WHERE user_id = ? ORDER BY last_seen DESC').all(userId); }

  // ── Trusted devices (skip TOTP for 30 days) ──
  function trustDevice(user, req) {
    const token = b64url(crypto.randomBytes(32));
    const t = now();
    getDb().prepare('INSERT INTO trusted (id, user_id, created_at, expires_at, ua) VALUES (?,?,?,?,?)').run(sha256(token), user.id, new Date(t).toISOString(), new Date(t + TRUST_TTL_MS).toISOString(), req ? String(req.headers['user-agent'] || '').slice(0, 200) : null);
    return { token, cookie: cookieHeader(TRUST_COOKIE, token, { req, maxAgeMs: TRUST_TTL_MS }) };
  }
  function isTrusted(user, token) {
    if (!token) return false;
    const row = getDb().prepare('SELECT * FROM trusted WHERE id = ? AND user_id = ?').get(sha256(token), user.id);
    if (!row) return false;
    if (Date.parse(row.expires_at) < now()) { getDb().prepare('DELETE FROM trusted WHERE id = ?').run(row.id); return false; }
    return true;
  }

  // ── TOTP enrolment / verification ──
  function totpBegin(id) {
    const u = getUser(id);
    if (!u) return { ok: false, error: 'no such user' };
    const secret = base32Encode(crypto.randomBytes(20));
    const pending = encrypt(secret);
    const r = mutate((s, stop) => {
      const cur = s.users.find(x => x.id === id);
      if (!cur) stop({ ok: false, error: 'no such user' });
      cur.totpPending = pending;
      return { ok: true, login: cur.login };
    });
    if (!r.ok) return r;
    return { ok: true, secret, uri: otpauthUri(secret, r.login) };
  }
  function totpConfirm(id, code) {
    const u = getUser(id);
    if (!u || !u.totpPending) return { ok: false, error: 'no enrolment in progress' };
    const secret = decrypt(u.totpPending);
    const counter = totpVerify(secret, code, { now: now() });
    if (counter === null) return { ok: false, error: 'That code did not match. Check the clock on your phone and try the next code.' };
    const codes = Array.from({ length: 10 }, () => `${crypto.randomBytes(2).toString('hex')}-${crypto.randomBytes(2).toString('hex')}`);
    const totp = { secretEnc: encrypt(secret), enabled: true, enrolledAt: nowIso() };
    const recovery = codes.map(c => sha256(c.toLowerCase()));
    const pending = u.totpPending;
    const r = mutate((s, stop) => {
      const cur = s.users.find(x => x.id === id);
      if (!cur || cur.totpPending !== pending) stop({ ok: false, error: 'no enrolment in progress' });
      cur.totp = totp;
      cur.totpLastCounter = counter;
      cur.recovery = recovery;
      delete cur.totpPending;
      return { ok: true, login: cur.login };
    });
    if (!r.ok) return r;
    getDb().prepare('DELETE FROM totp_lock WHERE user_id = ?').run(id);   // a new secret starts with no lock and no count
    audit(id, 'totp.enabled', r.login);
    return { ok: true, recoveryCodes: codes };
  }
  function totpDisable(id, { by = null } = {}) {
    const u = getUser(id);
    if (!u) return { ok: false, error: 'no such user' };
    const r = mutate((s, stop) => {
      const cur = s.users.find(x => x.id === id);
      if (!cur) stop({ ok: false, error: 'no such user' });
      cur.totp = null; cur.recovery = []; delete cur.totpPending;
      return { ok: true, login: cur.login };
    });
    if (!r.ok) return r;
    getDb().prepare('DELETE FROM totp_lock WHERE user_id = ?').run(id);
    audit(by || id, 'totp.disabled', r.login);
    return { ok: true };
  }
  function setTotpLockNotifier(fn) { totpLockNotifier = typeof fn === 'function' ? fn : () => {}; }
  const TOTP_LOCK_MSG = 'Too many wrong codes. Try again in a minute.';
  // Counts one wrong second-factor code; on the TOTP_MAX_FAILS-th it locks the account and answers with the lock response.
  function totpFailed(id, u, detail, ownAnswer) {
    audit(id, 'totp.fail', detail);
    const d = getDb();
    d.prepare('INSERT OR IGNORE INTO totp_lock (user_id, fails, locked_until) VALUES (?, 0, 0)').run(id);
    d.prepare('UPDATE totp_lock SET fails = fails + 1 WHERE user_id = ?').run(id);
    const row = d.prepare('SELECT fails FROM totp_lock WHERE user_id = ?').get(id);
    if (row && row.fails >= TOTP_MAX_FAILS) {
      const lockedUntil = now() + TOTP_LOCK_MS;
      d.prepare('UPDATE totp_lock SET fails = 0, locked_until = ? WHERE user_id = ?').run(lockedUntil, id);
      audit(id, 'totp.locked', `${TOTP_MAX_FAILS} wrong codes; ${TOTP_LOCK_MS / 1000} s`);
      try { totpLockNotifier({ user: publicUser(u), lockedUntil }); } catch {}
      return { ok: false, locked: true, error: TOTP_LOCK_MSG, retryAfterMs: TOTP_LOCK_MS };
    }
    return ownAnswer;
  }
  /** Verify a 6-digit code or a recovery code for a user. After TOTP_MAX_FAILS wrong codes every attempt is refused for TOTP_LOCK_MS. */
  function totpCheck(id, code) {
    const u = getUser(id);
    if (!u || !u.totp || !u.totp.enabled) return { ok: false, error: 'two-factor is not enabled' };
    const d = getDb();
    const lock = d.prepare('SELECT locked_until FROM totp_lock WHERE user_id = ?').get(id);
    if (lock && lock.locked_until) {
      if (lock.locked_until > now()) return { ok: false, locked: true, error: TOTP_LOCK_MSG, retryAfterMs: lock.locked_until - now() };
      d.prepare('UPDATE totp_lock SET fails = 0, locked_until = 0 WHERE user_id = ?').run(id);
    }
    const c = String(code || '').trim().toLowerCase();
    if (/^[0-9a-f]{4}-[0-9a-f]{4}$/.test(c)) {
      const h = sha256(c);
      const i = (u.recovery || []).indexOf(h);
      if (i < 0) return totpFailed(id, u, 'recovery', { ok: false, error: 'Wrong code' });
      // A recovery code is spent in the freshest file: a second sign-in using the same code at the same moment must not both pass.
      const left = mutate((s, stop) => {
        const cur = s.users.find(x => x.id === id);
        const j = cur ? (cur.recovery || []).indexOf(h) : -1;
        if (j < 0) stop(-1);
        cur.recovery.splice(j, 1);
        return cur.recovery.length;
      });
      if (left < 0) return totpFailed(id, u, 'recovery', { ok: false, error: 'Wrong code' });
      d.prepare('DELETE FROM totp_lock WHERE user_id = ?').run(id);
      audit(id, 'totp.recovery', `${left} left`);
      return { ok: true, recovery: true, remaining: left };
    }
    const counter = totpVerify(decrypt(u.totp.secretEnc), c, { now: now(), lastCounter: u.totpLastCounter ?? -1 });
    if (counter === null) return totpFailed(id, u, '', { ok: false, error: 'Wrong code' });
    const used = mutate((s, stop) => {
      const cur = s.users.find(x => x.id === id);
      if (!cur || (cur.totpLastCounter ?? -1) >= counter) stop(false);   // the same code was used meanwhile
      cur.totpLastCounter = counter;
      return true;
    });
    if (!used) return totpFailed(id, u, '', { ok: false, error: 'Wrong code' });
    d.prepare('DELETE FROM totp_lock WHERE user_id = ?').run(id);
    return { ok: true };
  }

  // ── Invites ──
  function createInvite({ login, name, role = 'member', by = null }) {
    login = normLogin(login);
    if (!login || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login)) return { ok: false, error: 'login must be an email address' };
    if (findByLogin(login)) return { ok: false, error: 'a user with that login exists' };
    const token = b64url(crypto.randomBytes(24));
    const invite = { id: sha256(token), login, name: String(name || '').trim().slice(0, 80), role: ['admin', 'member'].includes(role) ? role : 'member', createdBy: by, createdAt: nowIso(), expiresAt: new Date(now() + INVITE_TTL_MS).toISOString() };
    const dup = mutate((s, stop) => {
      if (s.users.some(x => x.login === login)) stop({ ok: false, error: 'a user with that login exists' });
      s.invites = s.invites.filter(i => i.login !== login && Date.parse(i.expiresAt) > now());
      s.invites.push(invite);
      return null;
    });
    if (dup) return dup;
    audit(by, 'invite.create', `${login} ${role}`);
    return { ok: true, token, login, expiresAt: invite.expiresAt };
  }
  function getInvite(token) {
    const i = load().invites.find(x => x.id === sha256(token || ''));
    if (!i || Date.parse(i.expiresAt) < now()) return null;
    return { login: i.login, name: i.name, role: i.role, expiresAt: i.expiresAt };
  }
  function acceptInvite(token, { password, name }) {
    const s = load();
    const i = s.invites.find(x => x.id === sha256(token || ''));
    if (!i || Date.parse(i.expiresAt) < now()) return { ok: false, error: 'This invite link is invalid or has expired' };
    const r = createUser({ login: i.login, name: name || i.name, role: i.role, password });
    if (!r.ok) return r;
    mutate((st) => { st.invites = st.invites.filter(x => x.id !== i.id); return null; });
    audit(r.user.id, 'invite.accept', i.login);
    return { ok: true, user: publicUser(getUser(r.user.id)) };   // never the raw record (password hash, TOTP secret)
  }
  function listInvites() { return load().invites.filter(i => Date.parse(i.expiresAt) > now()).map(i => ({ login: i.login, name: i.name, role: i.role, createdAt: i.createdAt, expiresAt: i.expiresAt })); }
  function revokeInvite(login) {
    const l = normLogin(login);
    return mutate((s) => { const n = s.invites.length; s.invites = s.invites.filter(i => i.login !== l); return { ok: true, removed: n - s.invites.length }; });
  }

  // ── Request identification ──
  function clientIp(req) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return xf || (req.socket && req.socket.remoteAddress) || null;
  }
  function isLoopback(req) {
    const a = req.socket && req.socket.remoteAddress;
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  }
  /**
   * identify(req) -> { kind: 'service' } | { kind: 'token', token, user } | { kind: 'bad-token', reason }
   *                 | { kind: 'user', user, session, pendingTotp } | { kind: 'legacy', user } | null
   * legacy = HUB_AUTH_USERNAME/PASSWORD basic auth (acts as an admin named "legacy") for older integrations.
   */
  function identify(req, { legacyCheck = null } = {}) {
    const svc = req.headers[SERVICE_HEADER];
    if (svc && isLoopback(req) && svc.length === SERVICE_TOKEN.length && crypto.timingSafeEqual(Buffer.from(svc), Buffer.from(SERVICE_TOKEN))) return { kind: 'service' };
    // A program's API token. A bad bearer never falls through to cookies: the caller meant to use the token.
    const bearer = tokenFromRequest(req);
    if (bearer) return bearer.ok ? { kind: 'token', token: bearer.token, user: { id: `token:${bearer.token.id}`, login: bearer.token.name, name: bearer.token.name, role: 'token' } } : { kind: 'bad-token', reason: bearer.reason };
    const cookies = parseCookies(req);
    const sess = getSession(cookies[SESSION_COOKIE]);
    if (sess) {
      const u = getUser(sess.user_id);
      if (u && !u.disabled) {
        touchSession(sess.id);
        return { kind: 'user', user: u, session: sess, pendingTotp: !!(u.totp && u.totp.enabled) && !sess.totp_ok };
      }
    }
    if (legacyCheck && legacyCheck(req)) return { kind: 'legacy', user: { id: 'legacy', login: 'legacy', name: 'Legacy', role: 'admin' } };
    return null;
  }

  return {
    // users
    listUsers, getUser, findByLogin, hasUsers, admins, isOwner, createUser, updateUser, setTimeZone, setPrefs, deleteUser, setPassword, clearFailures, publicUser,
    // login + sessions
    login, createSession, getSession, destroySession, revokeSessions, listSessions, markTotpOk, trustDevice, isTrusted,
    // totp
    totpBegin, totpConfirm, totpDisable, totpCheck, setTotpLockNotifier,
    // invites
    createInvite, getInvite, acceptInvite, listInvites, revokeInvite,
    // request
    identify, parseCookies, clientIp, isLoopback, isLocalRequest, cookieHeader, audit,
    // API tokens
    createToken, listTokens, getToken, revokeToken, tokenFromRequest, TOKEN_SCOPES,
    auditRecent: (n = 100) => { try { return getDb().prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(n); } catch { return []; } },
    SESSION_COOKIE, TRUST_COOKIE, SERVICE_HEADER, SERVICE_TOKEN, usersFile, dbFile,
  };
}

let shared = null;
function getAuth(opts) { if (!shared) shared = createAuth(opts); return shared; }

module.exports = { TOKEN_SCOPES, 
  createAuth, getAuth, getAuthKey, TOTP_MAX_FAILS, TOTP_LOCK_MS, keepFileOwner,
  hashPassword, verifyPassword, passwordPolicy,
  base32Encode, base32Decode, hotp, totpCode, totpVerify, otpauthUri,
  parseCookies, cookieHeader, isSecureRequest,
  SESSION_COOKIE, TRUST_COOKIE, SERVICE_HEADER, SERVICE_TOKEN,
};
