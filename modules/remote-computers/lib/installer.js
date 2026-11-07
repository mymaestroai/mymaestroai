'use strict';
// The one-time installer link: short-lived tokens kept in memory only, the web receiver behind them, and the download of the
// Windows x64 helper from the MeshCentral server (as the admin account), cached on disk for a day.
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';   // no 0, o, 1, l, i
const TOKEN_LENGTH = 8;
const TOKEN_TTL_MS = 15 * 60000;
const MAX_TOKENS = 3;
const CACHE_FILE = 'installer-win64.exe';
const CACHE_TTL_MS = 24 * 3600000;
const MAX_INSTALLER_BYTES = 12 * 1024 * 1024;   // the hub sends at most 16 MB; base64 adds a third
const RATE_LIMIT = 10, RATE_WINDOW_MS = 60000;
const FILE_NAME = 'MyMaestro-RemoteAgent.exe';
const GONE = 'This link has expired. Make a new one in Data connectors -> Remote computers.\n';
const UNAVAILABLE = 'The installer is not available right now.\n';
const TEXT = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };

const text = (status, body, extra) => ({ status, headers: { ...TEXT, ...(extra || {}) }, body });

/** createTokens({ now, random }) -> { make(), consume(token) }. random(n) -> n random indexes below ALPHABET.length (tests inject it). */
function createTokens({ now = Date.now, random } = {}) {
  const pick = random || ((n) => Array.from({ length: n }, () => crypto.randomInt(ALPHABET.length)));
  const alive = new Map();   // token -> expiresAt, oldest first
  const purge = () => { const t = now(); for (const [k, exp] of alive) if (exp <= t) alive.delete(k); };
  return {
    make() {
      purge();
      let token = '';
      do { token = pick(TOKEN_LENGTH).map((i) => ALPHABET[i]).join(''); } while (alive.has(token));
      while (alive.size >= MAX_TOKENS) alive.delete(alive.keys().next().value);   // the newest replaces the oldest
      const expiresAt = now() + TOKEN_TTL_MS;
      alive.set(token, expiresAt);
      return { token, expiresAt };
    },
    /** True once for a live token; the token is spent. */
    consume(token) {
      purge();
      if (typeof token !== 'string' || !alive.has(token)) return false;
      alive.delete(token);
      return true;
    },
    size() { purge(); return alive.size; },
  };
}

// ── the download from MeshCentral ──
function request(opts, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      const chunks = []; let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n > MAX_INSTALLER_BYTES) { req.destroy(new Error('The reply was too large.')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Timed out.')));
    req.on('error', reject);
    req.end(body);
  });
}
// "xid=abc; Path=/; HttpOnly" lines -> "xid=abc; xid.sig=def" (only the two session cookies, nothing else is sent back)
function sessionCookies(setCookie) {
  const got = {};
  for (const line of Array.isArray(setCookie) ? setCookie : []) {
    const m = /^(xid|xid\.sig)=([^;]+)/.exec(String(line));
    if (m) got[m[1]] = m[2];
  }
  return got.xid && got['xid.sig'] ? `xid=${got.xid}; xid.sig=${got['xid.sig']}` : null;
}
/**
 * defaultFetcher({ port, servername, ca, user, pass, meshid }) -> Buffer. Logs in as the admin account (form post to /login,
 * the session cookie is bound to this source address) and downloads the Windows x64 helper for the device group.
 */
async function defaultFetcher({ port, servername, ca, user, pass, meshid, timeoutMs = 60000 }) {
  const base = { host: '127.0.0.1', port, ca, servername, rejectUnauthorized: true, headers: {} };
  const form = new URLSearchParams({ action: 'login', username: user, password: pass }).toString();
  const login = await request({ ...base, method: 'POST', path: '/login', headers: { host: `${servername}:${port}`, 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(form) } }, form, 20000);
  const cookie = sessionCookies(login.headers['set-cookie']);
  if (!cookie) throw new Error(`The server did not start a session (status ${login.status}).`);
  const short = String(meshid || '').replace(/^mesh\/[^/]*\//, '');
  if (!short) throw new Error('The device group is not known yet.');
  const dl = await request({ ...base, method: 'GET', path: `/meshagents?id=4&meshid=${encodeURIComponent(short)}`, headers: { host: `${servername}:${port}`, cookie } }, undefined, timeoutMs);
  if (dl.status !== 200) throw new Error(`The server answered ${dl.status} for the installer.`);
  return dl.body;
}

/**
 * createInstaller({ home, now, log, fetchInstaller, address }) -> { link(), receive(params) }.
 * fetchInstaller() -> Buffer (the exe); address() -> the tailnet name (throws a plain message when it is not set).
 */
function createInstaller({ home, now = Date.now, log = () => {}, fetchInstaller, address, tokens = createTokens({ now }) }) {
  const hits = [];
  let inflight = null;
  const limited = () => {
    const t = now();
    while (hits.length && t - hits[0] >= RATE_WINDOW_MS) hits.shift();
    if (hits.length >= RATE_LIMIT) return true;
    hits.push(t);
    return false;
  };

  function cached() {
    if (!home) return null;
    const file = path.join(home, CACHE_FILE);
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || now() - st.mtimeMs >= CACHE_TTL_MS || now() < st.mtimeMs - 60000 || st.size < 2 || st.size > MAX_INSTALLER_BYTES) return null;
      const buf = fs.readFileSync(file);
      return buf[0] === 0x4d && buf[1] === 0x5a ? buf : null;
    } catch { return null; }
  }
  function store(buf) {
    if (!home) return;
    const file = path.join(home, CACHE_FILE), tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, buf, { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, file);
      fs.utimesSync(file, new Date(now()), new Date(now()));
    } catch (e) {
      log('could not keep the installer:', String((e && e.code) || 'error').slice(0, 40));
      try { fs.unlinkSync(tmp); } catch { /* none */ }
    }
  }
  async function installer() {
    const have = cached();
    if (have) return have;
    if (!inflight) {
      inflight = (async () => {
        const buf = await fetchInstaller();
        if (!Buffer.isBuffer(buf) || buf.length < 2 || buf.length > MAX_INSTALLER_BYTES || buf[0] !== 0x4d || buf[1] !== 0x5a) throw new Error('The server did not send a program file.');
        store(buf);
        return buf;
      })();
      const done = () => { inflight = null; };
      inflight.then(done, done);
    }
    return inflight;
  }

  return {
    link() {
      const name = address();
      const { token, expiresAt } = tokens.make();
      return { url: `https://${name}/hooks/remote-computers/installer/${token}`, expiresAt: new Date(expiresAt).toISOString() };
    },
    // params: the hub's hub/receive request ({ method, path: 'installer/<token>', ... })
    async receive(params) {
      const p = String((params && params.path) || '');
      const m = /^installer\/([a-z0-9]{1,40})$/.exec(p);
      if (limited()) return text(429, 'Too many requests\n', { 'retry-after': '60' });
      if (String((params && params.method) || 'GET').toUpperCase() !== 'GET') return text(405, 'Method not allowed\n', { allow: 'GET' });
      if (!m || !tokens.consume(m[1])) return text(404, GONE);
      try {
        const buf = await installer();
        return {
          status: 200,
          headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${FILE_NAME}"`, 'cache-control': 'no-store' },
          bodyBase64: buf.toString('base64'),
        };
      } catch (e) {
        log('installer download failed:', String((e && (e.code || e.message)) || 'error').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 120));
        return text(502, UNAVAILABLE);
      }
    },
  };
}

module.exports = { createTokens, createInstaller, defaultFetcher, sessionCookies, ALPHABET, TOKEN_LENGTH, TOKEN_TTL_MS, MAX_TOKENS, CACHE_FILE, CACHE_TTL_MS, RATE_LIMIT, FILE_NAME, GONE, UNAVAILABLE };
