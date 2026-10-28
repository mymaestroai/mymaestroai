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

function createAuth({ dataDir = DATA_DIR, now = Date.now, log = console.log } = {}) {
  const usersFile = path.join(dataDir, 'users.json');
  const dbFile = path.join(dataDir, 'auth.db');
  let store = null;
  let db = null;

  function load() {
    if (store) return store;
    try { store = JSON.parse(fs.readFileSync(usersFile, 'utf8')); } catch { store = { version: 1, users: [], invites: [] }; }
    if (!Array.isArray(store.users)) store.users = [];
    if (!Array.isArray(store.invites)) store.invites = [];
    return store;
  }
  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${usersFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, usersFile);
    try { fs.chmodSync(usersFile, 0o600); } catch {}
  }
  function getDb() {
    if (db) return db;
    const Database = require('better-sqlite3');
    fs.mkdirSync(dataDir, { recursive: true });
    db = new Database(dbFile);
    try { fs.chmodSync(dbFile, 0o600); } catch {}
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT, last_seen TEXT, expires_at TEXT, ua TEXT, ip TEXT, totp_ok INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS trusted (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT, expires_at TEXT, ua TEXT);
      CREATE TABLE IF NOT EXISTS attempts (login TEXT, ts INTEGER, ok INTEGER);
      CREATE INDEX IF NOT EXISTS attempts_login ON attempts(login, ts);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, user_id TEXT, action TEXT, detail TEXT, ip TEXT);
      CREATE TABLE IF NOT EXISTS tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, scopes TEXT NOT NULL, agents TEXT, loopback_only INTEGER DEFAULT 1, created_at TEXT, created_by TEXT, expires_at TEXT, last_used TEXT, revoked_at TEXT);
    `);
    return db;
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
    return { id: u.id, timeZone: u.timeZone || null, timeZonePinned: !!u.timeZonePinned, login: u.login, name: u.name, role: u.role, disabled: !!u.disabled, totpEnabled: !!(u.totp && u.totp.enabled), grants: u.grants || {}, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null };
  }
  function listUsers() { return load().users.map(publicUser); }
  function getUser(id) { return load().users.find(u => u.id === id) || null; }
  function findByLogin(login) { const l = normLogin(login); return load().users.find(u => u.login === l) || null; }
  function hasUsers() { return load().users.length > 0; }
  function admins() { return load().users.filter(u => u.role === 'admin' && !u.disabled); }

  function createUser({ login, name, role = 'member', password = null }) {
    login = normLogin(login);
    if (!login || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login)) return { ok: false, error: 'login must be an email address' };
    if (!['admin', 'member'].includes(role)) return { ok: false, error: 'role must be admin or member' };
    if (findByLogin(login)) return { ok: false, error: 'a user with that login exists' };
    if (password !== null) { const e = passwordPolicy(password); if (e) return { ok: false, error: e }; }
    const u = { id: newId(), login, name: String(name || login.split('@')[0]).trim().slice(0, 80), role, passwordHash: password !== null ? hashPassword(password) : null,
      totp: null, recovery: [], disabled: false, grants: {}, createdAt: nowIso(), lastLoginAt: null, totpLastCounter: -1 };
    load().users.push(u); save();
    audit(u.id, 'user.create', `${login} ${role}`);
    return { ok: true, user: publicUser(u) };
  }
  function updateUser(id, patch, { by = null } = {}) {
    const u = getUser(id);
    if (!u) return { ok: false, error: 'no such user' };
    if (patch.name !== undefined) u.name = String(patch.name || '').trim().slice(0, 80) || u.name;
    if (patch.role !== undefined) {
      if (!['admin', 'member'].includes(patch.role)) return { ok: false, error: 'bad role' };
      if (u.role === 'admin' && patch.role !== 'admin' && admins().filter(a => a.id !== u.id).length === 0) return { ok: false, error: 'cannot demote the last admin' };
      u.role = patch.role;
    }
    if (patch.disabled !== undefined) {
      if (patch.disabled && u.role === 'admin' && admins().filter(a => a.id !== u.id).length === 0) return { ok: false, error: 'cannot disable the last admin' };
      u.disabled = !!patch.disabled;
      if (u.disabled) revokeSessions(u.id);
    }
    if (patch.grants !== undefined && patch.grants && typeof patch.grants === 'object') {
      const before = JSON.stringify(u.grants || {});
      u.grants = { ...patch.grants };
      if (JSON.stringify(u.grants) !== before) audit(by || id, 'user.grants', `${u.login} ${JSON.stringify(u.grants)}`.slice(0, 400));
    }
    save();
    audit(by || id, 'user.update', `${u.login} ${Object.keys(patch).join(',')}`);
    return { ok: true, user: publicUser(u) };
  }
  // A person's time zone (lib/timezone): what their agents use for "now" and for every time they show. Reports from
  // their browser (auto) follow the device they use, unless they pinned a zone in the Security dialog. Saved only on a
  // change, and only an explicit choice is audited (pages report their zone again and again while in use).
  function setTimeZone(id, tz, { auto = false, pinned = false } = {}) {
    const u = getUser(id);
    if (!u) return { ok: false, error: 'no such user' };
    const tzLib = require('./timezone');
    if (tz != null && !tzLib.isZone(tz)) return { ok: false, error: 'unknown time zone' };
    if (auto) {
      if (!tz || u.timeZonePinned || u.timeZone === tz) return { ok: true, changed: false, user: publicUser(u) };
      u.timeZone = tz; save();
      return { ok: true, changed: true, user: publicUser(u) };
    }
    if (pinned && !tz) return { ok: false, error: 'pick a time zone to pin' };
    const before = `${u.timeZone || ''}|${!!u.timeZonePinned}`;
    if (pinned) { u.timeZone = tz; u.timeZonePinned = true; } else { u.timeZonePinned = false; if (tz) u.timeZone = tz; }
    const changed = `${u.timeZone || ''}|${!!u.timeZonePinned}` !== before;
    if (changed) { save(); audit(id, 'user.timezone', `${u.login} ${u.timeZone || '-'} ${u.timeZonePinned ? 'pinned' : 'follows the device'}`); }
    return { ok: true, changed, user: publicUser(u) };
  }
  function deleteUser(id, { by = null } = {}) {
    const s = load();
    const u = s.users.find(x => x.id === id);
    if (!u) return { ok: false, error: 'no such user' };
    if (u.role === 'admin' && admins().filter(a => a.id !== u.id).length === 0) return { ok: false, error: 'cannot delete the last admin' };
    s.users = s.users.filter(x => x.id !== id); save();
    revokeSessions(id);
    audit(by, 'user.delete', u.login);
    return { ok: true };
  }
  function setPassword(id, password, { by = null } = {}) {
    const u = getUser(id);
    if (!u) return { ok: false, error: 'no such user' };
    const e = passwordPolicy(password); if (e) return { ok: false, error: e };
    u.passwordHash = hashPassword(password); save();
    if (by !== id) revokeSessions(id);
    audit(by || id, 'password.set', u.login);
    return { ok: true };
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
    u.lastLoginAt = nowIso(); save();
    audit(u.id, 'login.ok', l, ip);
    return { ok: true, user: u, needsTotp: !!(u.totp && u.totp.enabled) };
  }

  // ── Sessions ──
  function createSession(user, { req = null, totpOk = false } = {}) {
    const token = b64url(crypto.randomBytes(32));
    const id = sha256(token);
    const t = now();
    getDb().prepare('INSERT INTO sessions (id, user_id, created_at, last_seen, expires_at, ua, ip, totp_ok) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, user.id, new Date(t).toISOString(), new Date(t).toISOString(), new Date(t + SESSION_TTL_MS).toISOString(), req ? String(req.headers['user-agent'] || '').slice(0, 200) : null, req ? clientIp(req) : null, totpOk ? 1 : 0);
    return { token, id, cookie: cookieHeader(SESSION_COOKIE, token, { req, maxAgeMs: SESSION_TTL_MS }) };
  }
  function getSession(token) {
    if (!token) return null;
    const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(sha256(token));
    if (!row) return null;
    if (Date.parse(row.expires_at) < now()) { getDb().prepare('DELETE FROM sessions WHERE id = ?').run(row.id); return null; }
    return row;
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
    u.totpPending = encrypt(secret); save();
    return { ok: true, secret, uri: otpauthUri(secret, u.login) };
  }
  function totpConfirm(id, code) {
    const u = getUser(id);
    if (!u || !u.totpPending) return { ok: false, error: 'no enrolment in progress' };
    const secret = decrypt(u.totpPending);
    const counter = totpVerify(secret, code, { now: now() });
    if (counter === null) return { ok: false, error: 'That code did not match. Check the clock on your phone and try the next code.' };
    const codes = Array.from({ length: 10 }, () => `${crypto.randomBytes(2).toString('hex')}-${crypto.randomBytes(2).toString('hex')}`);
    u.totp = { secretEnc: encrypt(secret), enabled: true, enrolledAt: nowIso() };
    u.totpLastCounter = counter;
    u.recovery = codes.map(c => sha256(c.toLowerCase()));
    delete u.totpPending; save();
    audit(id, 'totp.enabled', u.login);
    return { ok: true, recoveryCodes: codes };
  }
  function totpDisable(id, { by = null } = {}) {
    const u = getUser(id);
    if (!u) return { ok: false, error: 'no such user' };
    u.totp = null; u.recovery = []; delete u.totpPending; save();
    audit(by || id, 'totp.disabled', u.login);
    return { ok: true };
  }
  /** Verify a 6-digit code or a recovery code for a user. */
  function totpCheck(id, code) {
    const u = getUser(id);
    if (!u || !u.totp || !u.totp.enabled) return { ok: false, error: 'two-factor is not enabled' };
    const c = String(code || '').trim().toLowerCase();
    if (/^[0-9a-f]{4}-[0-9a-f]{4}$/.test(c)) {
      const h = sha256(c);
      const i = (u.recovery || []).indexOf(h);
      if (i < 0) { audit(id, 'totp.fail', 'recovery'); return { ok: false, error: 'Wrong code' }; }
      u.recovery.splice(i, 1); save();
      audit(id, 'totp.recovery', `${u.recovery.length} left`);
      return { ok: true, recovery: true, remaining: u.recovery.length };
    }
    const counter = totpVerify(decrypt(u.totp.secretEnc), c, { now: now(), lastCounter: u.totpLastCounter ?? -1 });
    if (counter === null) { audit(id, 'totp.fail', ''); return { ok: false, error: 'Wrong code' }; }
    u.totpLastCounter = counter; save();
    return { ok: true };
  }

  // ── Invites ──
  function createInvite({ login, name, role = 'member', by = null }) {
    login = normLogin(login);
    if (!login || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login)) return { ok: false, error: 'login must be an email address' };
    if (findByLogin(login)) return { ok: false, error: 'a user with that login exists' };
    const token = b64url(crypto.randomBytes(24));
    const s = load();
    s.invites = s.invites.filter(i => i.login !== login && Date.parse(i.expiresAt) > now());
    s.invites.push({ id: sha256(token), login, name: String(name || '').trim().slice(0, 80), role: ['admin', 'member'].includes(role) ? role : 'member', createdBy: by, createdAt: nowIso(), expiresAt: new Date(now() + INVITE_TTL_MS).toISOString() });
    save();
    audit(by, 'invite.create', `${login} ${role}`);
    return { ok: true, token, login, expiresAt: s.invites[s.invites.length - 1].expiresAt };
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
    s.invites = s.invites.filter(x => x !== i); save();
    audit(r.user.id, 'invite.accept', i.login);
    return { ok: true, user: publicUser(getUser(r.user.id)) };   // never the raw record (password hash, TOTP secret)
  }
  function listInvites() { return load().invites.filter(i => Date.parse(i.expiresAt) > now()).map(i => ({ login: i.login, name: i.name, role: i.role, createdAt: i.createdAt, expiresAt: i.expiresAt })); }
  function revokeInvite(login) { const s = load(); const n = s.invites.length; s.invites = s.invites.filter(i => i.login !== normLogin(login)); save(); return { ok: true, removed: n - s.invites.length }; }

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
    listUsers, getUser, findByLogin, hasUsers, admins, createUser, updateUser, setTimeZone, deleteUser, setPassword, publicUser,
    // login + sessions
    login, createSession, getSession, destroySession, revokeSessions, listSessions, markTotpOk, trustDevice, isTrusted,
    // totp
    totpBegin, totpConfirm, totpDisable, totpCheck,
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
  createAuth, getAuth,
  hashPassword, verifyPassword, passwordPolicy,
  base32Encode, base32Decode, hotp, totpCode, totpVerify, otpauthUri,
  parseCookies, cookieHeader, isSecureRequest,
  SESSION_COOKIE, TRUST_COOKIE, SERVICE_HEADER, SERVICE_TOKEN,
};
