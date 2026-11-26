'use strict';

/**
 * gmail-oauth.js — separate OAuth token store for Gmail WRITE access.
 *
 * The @internal/google-workspace-mcp token (~/.cb-mcp/google-workspace-mcp.json) only
 * carries `gmail.readonly`, so it cannot mark messages read / label / archive.
 * This module runs its own loopback OAuth flow for `gmail.modify`, reusing the
 * same embedded the organization desktop-app client credentials shipped with the MCP.
 *
 * Token stored at data/gmail-token.json.  Auto-refreshes via refresh_token.
 *
 * Two ways to finish a sign-in: the automatic localhost callback (browser on this machine) and a paste-back of the
 * address the browser ended up on (a browser on any device; the localhost page fails to load there, which is expected).
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const TOKEN_PATH = path.join(__dirname, '..', '..', 'data', 'gmail-token.json');
const CALLBACK_PORT = 19877;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

let authInProgress = null;

// ── Client credentials (reuse the MCP's embedded desktop-app client) ──────
function loadClient() {
  const candidates = [
    path.join(process.env.HOME || '', '.nvm', 'versions', 'node'),
  ];
  // Try require from the globally installed MCP package first
  const globalRoots = [];
  try {
    const { execSync } = require('child_process');
    globalRoots.push(execSync('npm root -g', { encoding: 'utf8' }).trim());
  } catch { /* ignore */ }
  globalRoots.push('/usr/local/lib/node_modules', '/opt/homebrew/lib/node_modules');

  for (const root of globalRoots) {
    const p = path.join(root, '@internal', 'google-workspace-mcp', 'credentials.config.cjs');
    if (fs.existsSync(p)) {
      try {
        const { GOOGLE_CREDENTIALS_BASE64 } = require(p);
        const j = JSON.parse(Buffer.from(GOOGLE_CREDENTIALS_BASE64, 'base64').toString());
        const c = j.installed || j.web;
        if (c && c.client_id) return { client_id: c.client_id, client_secret: c.client_secret };
      } catch { /* ignore */ }
    }
  }
  // Env override
  const hs = require('../hub-secrets');
  if (hs.get('GMAIL_OAUTH_CLIENT_ID')) {
    return {
      client_id: hs.get('GMAIL_OAUTH_CLIENT_ID'),
      client_secret: hs.get('GMAIL_OAUTH_CLIENT_SECRET') || '',
    };
  }
  void candidates;
  return null;
}

function loadToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')); } catch { return null; }
}

function saveToken(t) {
  const dir = path.dirname(TOKEN_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(t, null, 2), { mode: 0o600 });
}

function postForm(hostname, urlPath, form) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(form).toString();
    const req = https.request({
      hostname, path: urlPath, method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, json: { raw: d } }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function refresh(tok, client) {
  const { status, json } = await postForm('oauth2.googleapis.com', '/token', {
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: tok.refresh_token,
    grant_type: 'refresh_token',
  });
  if (status !== 200 || !json.access_token) {
    throw new Error(`refresh failed (${status}): ${json.error_description || json.error || JSON.stringify(json).slice(0, 200)}`);
  }
  const merged = {
    ...tok,
    access_token: json.access_token,
    expiry_date: Date.now() + (json.expires_in || 3600) * 1000,
    scope: json.scope || tok.scope,
  };
  saveToken(merged);
  return merged;
}

/** Can a browser be opened on the machine itself? Linux needs a display; macOS and Windows have one. */
function canOpenBrowser(platform = process.platform, env = process.env) {
  if (platform === 'linux') return !!(env.DISPLAY || env.WAYLAND_DISPLAY);
  return true;
}

/** Try to open the link here: resolves true only when the opener ran and exited cleanly; false for no display, missing or failing opener. */
function openBrowser(url) {
  return new Promise((resolve) => {
    if (!canOpenBrowser()) return resolve(false);
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    try { execFile(cmd, [url], { timeout: 5000 }, (err) => resolve(!err)); } catch { resolve(false); }
  });
}
let openerImpl = null;   // tests only

let lastAuthUrl = null;

// ── The pending sign-in ───────────────────────────────────────────────────
// One at a time. Two ways finish it, both through finishWithCode(): the automatic localhost callback (a browser on the
// machine that runs this) and the pasted address (a browser anywhere: submitPastedAddress). A used, replaced or expired
// state is refused. Nothing here logs a code, a token or a pasted address.
const LIFETIME_MS = 10 * 60 * 1000;
const CALLBACK_PATH = '/callback';
let pending = null;   // { state, verifier, client, url, expiresAt, used, server, timer, resolve, reject }
let lastOutcome = null;   // { state: 'done'|'failed', message, at }: what the page shows after the localhost path finished by itself
let postFormImpl = postForm;
let clientOverride;   // tests only: undefined = look on disk

const WORDS = {
  noPending: 'No Gmail sign-in is waiting for that address. Start the Gmail sign-in again to get a new link.',
  empty: 'Paste the address first.',
  format: "That doesn't look like an address. Copy the whole address from the address bar of your browser, starting with http://",
  wrongPage: 'That is not the address your Maestro is waiting for. Copy the address of the page that failed to load after you approved.',
  noCode: 'That address has no sign-in code in it. Copy the whole address, all the way to the end.',
  otherSignIn: 'That address does not belong to a sign-in that is waiting. Start the Gmail sign-in again to get a new link, and use only the newest one.',
  refused: 'The sign-in was refused, so nothing was connected. Start the Gmail sign-in again to try again.',
  used: 'That sign-in was already used. Start the Gmail sign-in again to get a new link.',
  expired: 'That sign-in ran out of time (it lasts 10 minutes). Start the Gmail sign-in again to get a new link.',
  exchange: 'Google would not accept that sign-in. Start the Gmail sign-in again to get a new link.',
  replaced: 'That sign-in was replaced by a newer one.',
  busy: 'Your Maestro is busy finishing another Gmail sign-in; try again in a moment.',
  noClient: 'Gmail sign-in is not set up on the computer that runs your Maestro (the Google sign-in details are missing).',
};

/** The text handed back to whoever asked for the sign-in (an agent relays it to a person on any device). */
function pasteBackMessage(url) {
  return [
    'To connect Gmail: open this link and approve the access:',
    url,
    'The page you land on after approving will fail to load. That is expected, nothing is wrong.',
    'Copy the WHOLE address from the address bar of your browser (it starts with http://localhost:19877/callback) and send it back to me here.',
    'The link and the address are good for 10 minutes.',
  ].join('\n');
}

function fail(reason, message) { return { ok: false, reason, message }; }

// ── The pending sign-in, also on disk ─────────────────────────────────────
// A sign-in begun in one node run can be finished in a later one: one row { id, state, verifier, expires_at, used } in a small
// SQLite database (gmail-signin.db, mode 0600) next to the token. Never the code, never a token.
const DB_BUSY_MS = 500;
let dbHandle = null;   // opened lazily, once per process
function dbFilePath() { return path.join(path.dirname(TOKEN_PATH), 'gmail-signin.db'); }

function getDb() {
  if (dbHandle) return dbHandle;
  const file = dbFilePath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  try { fs.closeSync(fs.openSync(file, 'a', 0o600)); } catch { /* the open below reports a real problem */ }
  const Database = require('better-sqlite3');
  const d = new Database(file, { timeout: DB_BUSY_MS });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  try {
    d.exec('CREATE TABLE IF NOT EXISTS pending(id TEXT, state TEXT, verifier TEXT, expires_at INTEGER, used INTEGER)');
  } catch (e) { try { d.close(); } catch { /* not open */ } throw e; }
  return (dbHandle = d);
}

function isBusyError(e) { return !!(e && typeof e.code === 'string' && e.code.startsWith('SQLITE_BUSY')); }

const ROW_SQL = 'SELECT id, state, verifier, expires_at, used FROM pending LIMIT 1';
function rowOf(r) { return r ? { id: r.id, state: r.state, verifier: r.verifier, expiresAt: Number(r.expires_at), used: !!r.used } : null; }

/** The one row, or null (none, or the database cannot be read right now). */
function readPendingFile() {
  try { return rowOf(getDb().prepare(ROW_SQL).get()); } catch { return null; }
}

function filePendingOf(p) { return { id: p.id, state: p.state, verifier: p.verifier, expiresAt: p.expiresAt, used: !!p.used }; }

// Row writes: only inside withLock's transaction.
function putRow(rec) {
  const d = getDb();
  d.prepare('DELETE FROM pending').run();
  d.prepare('INSERT INTO pending(id, state, verifier, expires_at, used) VALUES (?, ?, ?, ?, ?)').run(rec.id, rec.state, rec.verifier, rec.expiresAt, rec.used ? 1 : 0);
}
function markRowUsed(id) { return getDb().prepare('UPDATE pending SET used = 1 WHERE id = ? AND used = 0').run(id).changes > 0; }
/** Delete the row; with an id only when it is that sign-in's; with onlyExpired also only when unused and past its deadline. */
function deleteRow(id, onlyExpired = false, onlyUnused = false) {
  const d = getDb();
  if (id === undefined) return d.prepare('DELETE FROM pending').run().changes > 0;
  if (onlyUnused && !onlyExpired) return d.prepare('DELETE FROM pending WHERE id = ? AND used = 0').run(id).changes > 0;
  if (onlyExpired) return d.prepare('DELETE FROM pending WHERE id = ? AND used = 0 AND expires_at <= ?').run(id, Date.now()).changes > 0;
  return d.prepare('DELETE FROM pending WHERE id = ?').run(id).changes > 0;
}

// ── One interprocess lock for every decision about the pending state ──────
// Every decision (start, claim, save, cancel, expiry) runs in one SQLite write transaction (BEGIN IMMEDIATE): the database lock
// is held by the operating system, so a process that exits or crashes releases it, and an age guess can never let two holders
// overlap. A throw inside the decision rolls it back. The Google exchange runs outside any transaction.
const BUSY = Symbol('busy');

/** Run fn (synchronous) inside the write transaction; BUSY when the database stays locked past the wait. Other errors throw. */
async function withLock(fn) {
  let d;
  try { d = getDb(); } catch (e) { if (isBusyError(e)) return BUSY; throw e; }
  try { return d.transaction(fn).immediate(); } catch (e) { if (isBusyError(e)) return BUSY; throw e; }
}

/** Remove the row under the lock, only when it still belongs to sign-in id (no id: unconditionally). */
function clearLocked(id, onlyExpired = false, onlyUnused = false) { return withLock(() => deleteRow(id, onlyExpired, onlyUnused)).catch(() => {}); }

const CLAIMED_WORDS = 'Another process is handling this Gmail sign-in. Check its result there.';

/**
 * A refused (or timed out) address for p: decide in the transaction FIRST. Returns { removed: true } when the conditional delete
 * removed p's unused row (the refusal stands), or { message } when the answer is something else: another process claimed it,
 * a newer sign-in replaced it, or the database is busy (nothing changed). Nothing is announced before this answers.
 */
async function decideEnd(p, expired) {
  let r;
  try {
    r = await withLock(() => {
      if (deleteRow(p.id, expired, true)) return 'removed';
      const f = readPendingFile();
      if (!f || f.id !== p.id) return 'replaced';
      return f.used ? 'claimed' : 'retry';   // unused and still there: the guarded delete missed (the clock moved back); nothing changed
    });
  } catch { r = BUSY; }
  if (r === 'removed') return { removed: true, reason: 'removed' };
  if (r === 'claimed') return { reason: 'claimed', message: CLAIMED_WORDS };
  if (r === 'replaced') return { reason: 'replaced', message: WORDS.replaced };
  if (r === 'retry') return { reason: 'retry', message: 'Please try again in a moment.', busy: true };
  return { reason: 'busy', message: WORDS.busy, busy: true };
}

/** Is p still the one current sign-in (in memory and in the file)? */
function isCurrent(p) {
  if (pending !== p || p.cancelled) return false;
  const f = readPendingFile();
  return !!(f && f.id === p.id);
}

/** A sign-in from another node run, read from the file (null when none is on file). */
function pendingFromFile() {
  const f = readPendingFile();
  if (!f || !f.state || !f.verifier || !f.id) return null;
  return { id: f.id, state: String(f.state), verifier: String(f.verifier), client: null, url: null, expiresAt: Number(f.expiresAt) || 0, used: !!f.used, server: null, timer: null, resolve: null, reject: null, fromFile: true };
}

function sameText(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * parsePastedAddress(text, pending, now) -> { ok: true, code } or { ok: false, reason, message }.
 * Pure. The address must be http://localhost or http://127.0.0.1 on the callback port and path, carry this sign-in's state, and
 * the sign-in must be unused and unexpired. The message never repeats any of the pasted text.
 */
function parsePastedAddress(text, pend, now = Date.now()) {
  if (!pend) return fail('nopending', WORDS.noPending);
  if (pend.used) return fail('used', WORDS.used);
  if (!(now < pend.expiresAt)) return fail('expired', WORDS.expired);
  let raw = String(text === undefined || text === null ? '' : text).trim().replace(/^["'<]+|[>"']+$/g, '').trim();
  if (!raw) return fail('empty', WORDS.empty);
  if (raw.length > 4096 || /\s/.test(raw)) return fail('format', WORDS.format);
  // An address copied without its scheme ('localhost:19877/callback?...'): add it before checking.
  if (/^(localhost|127\.0\.0\.1)(:|\/|\?|$)/i.test(raw)) raw = `http://${raw}`;
  let u;
  try { u = new URL(raw); } catch { return fail('format', WORDS.format); }
  if (u.protocol !== 'http:') return fail('scheme', WORDS.wrongPage);
  if (u.username || u.password) return fail('host', WORDS.wrongPage);
  if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return fail('host', WORDS.wrongPage);
  if (u.port !== String(CALLBACK_PORT)) return fail('port', WORDS.wrongPage);
  if (u.pathname !== CALLBACK_PATH) return fail('path', WORDS.wrongPage);
  const states = u.searchParams.getAll('state');
  if (states.length !== 1 || !states[0]) return fail('state', WORDS.otherSignIn);
  if (!sameText(states[0], pend.state)) return fail('state', WORDS.otherSignIn);
  if (u.searchParams.has('error')) return fail('refused', WORDS.refused);
  const codes = u.searchParams.getAll('code');
  if (codes.length !== 1 || !codes[0] || codes[0].length > 2048 || /[\u0000-\u001f\u007f]/.test(codes[0])) return fail('nocode', WORDS.noCode);
  return { ok: true, code: codes[0] };
}

function endPending(p) {
  if (!p) return;
  p.used = true;
  if (p.timer) { clearTimeout(p.timer); p.timer = null; }
  if (p.server) { try { p.server.close(); } catch { /* already closed */ } p.server = null; }
  if (pending === p) lastAuthUrl = null;
}

/**
 * Exchange a code for tokens, once, for the pending sign-in p. Marks it used first (single use, in the file too so another
 * node run cannot use it), whatever the outcome. After the exchange the result is kept only if p is still the current sign-in.
 */
async function finishWithCode(p, code) {
  if (!p.client) {
    p.client = clientOverride !== undefined ? clientOverride : loadClient();
    if (!p.client) return fail('noclient', WORDS.noClient);
  }
  // Claim under the lock: re-read, same id, not used, not expired, write used, THEN exchange (outside the lock). A duplicate
  // (already used) is read-only: it never empties the file, so the exchange in flight can still save its token.
  let claim;
  try {
    claim = await withLock(() => {
      const f = readPendingFile();
      if (!f || f.id !== p.id) return fail('replaced', WORDS.replaced);
      if (f.used) return fail('used', WORDS.used);
      if (!(Date.now() < Number(f.expiresAt))) { deleteRow(p.id); return fail('expired', WORDS.expired); }
      markRowUsed(p.id);
      return null;
    });
  } catch { return fail('exchange', WORDS.exchange); }
  if (claim === BUSY) return fail('busy', WORDS.busy);
  if (claim) return claim;
  p.used = true;
  endPending(p);
  const dropped = () => { if (p.reject) p.reject(new Error('replaced')); return fail('replaced', WORDS.replaced); };
  try {
    const { status, json } = await postFormImpl('oauth2.googleapis.com', '/token', {
      client_id: p.client.client_id,
      client_secret: p.client.client_secret,
      code,
      code_verifier: p.verifier,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    });
    if (!isCurrent(p)) return dropped();   // a newer sign-in or a cancel came while the exchange ran
    if (status !== 200 || !json || !json.access_token) throw new Error(`token exchange failed (${status})`);
    const tok = {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      token_type: json.token_type || 'Bearer',
      scope: json.scope,
      expiry_date: Date.now() + (json.expires_in || 3600) * 1000,
    };
    // Save in the transaction: the row still has this id -> write the token file; a throw rolls back. The row stays (used) so a
    // later paste, here or in another run, is refused as used.
    const saved = await withLock(() => {
      const f = readPendingFile();
      if (pending !== p || p.cancelled || !f || f.id !== p.id) return false;
      saveToken(tok);
      return true;
    });
    if (saved === BUSY) throw new Error('busy');
    if (!saved) return dropped();
    lastOutcome = { state: 'done', message: 'Gmail is connected.', at: Date.now() };
    authInProgress = null;   // the file keeps its used flag: a later paste, here or in another run, is refused as used
    if (p.resolve) p.resolve(tok);
    return { ok: true, tok };
  } catch (e) {
    if (!isCurrent(p)) return dropped();
    lastOutcome = { state: 'failed', message: WORDS.exchange, at: Date.now() };
    authInProgress = null;
    if (p.reject) p.reject(e);
    return fail('exchange', WORDS.exchange);
  }
}

/** The pasted address of the pending sign-in -> { ok } or { ok: false, reason, message }. A wrong paste leaves the sign-in waiting. */
async function submitPastedAddress(text) {
  let p = pending;
  const f = readPendingFile();
  if (f && f.id && (!p || p.id !== f.id)) {
    // The file names a sign-in this run does not hold (begun in an earlier run, or a newer one began elsewhere): the file wins.
    const fp = pendingFromFile();
    if (fp) {
      if (pending) endAttempt(pending);   // the old in-memory attempt ends first: listener closed, promise rejected
      p = fp; pending = fp;
    }
  } else if (p && !(f && f.id === p.id)) {
    p = null;   // emptied or removed elsewhere: nothing is waiting
  }
  const r = parsePastedAddress(text, p, Date.now());
  if (!r.ok) {
    if (r.reason === 'used') return r;   // a duplicate is read-only: it never ends or empties the sign-in in flight
    if (p && (r.reason === 'expired' || r.reason === 'refused')) {
      // Decide in the transaction first; neither an expiry nor a refusal removes a sign-in another process claimed.
      const d = await decideEnd(p, r.reason === 'expired');
      if (d.busy) return fail(d.reason, d.message);   // nothing changed (busy or retry): the sign-in keeps waiting
      endPending(p);
      authInProgress = null;
      if (d.removed) {
        lastOutcome = { state: 'failed', message: r.message, at: Date.now() };
        if (p.reject) p.reject(new Error(r.reason === 'expired' ? 'auth timed out' : 'auth refused'));
        return r;
      }
      if (p.reject) p.reject(new Error(d.message));
      return fail(d.reason, d.message);
    }
    return r;
  }
  const done = await finishWithCode(p, r.code);
  return done.ok ? { ok: true } : done;
}

/** End an in-memory attempt (not the file): close its listener, reject its promise, clear authInProgress if it was that one. */
function endAttempt(p, why = 'replaced') {
  p.cancelled = true;
  endPending(p);
  if (p.promise && authInProgress === p.promise) authInProgress = null;
  if (p.reject) p.reject(new Error(why));
}

/** Cancel the waiting sign-in. The in-memory part is immediate; the returned promise settles once the file is emptied under the lock. */
function cancelSignIn() {
  const p = pending;
  if (!p) return clearLocked();
  endAttempt(p, 'auth cancelled');
  authInProgress = null;
  return clearLocked(p.id);
}

/** What the page shows: null when nothing is waiting. */
function pendingView(now = Date.now()) {
  const p = pending;
  if (!p || p.used || !(now < p.expiresAt)) return null;
  return { url: p.url, expiresAt: p.expiresAt, secondsLeft: Math.max(0, Math.round((p.expiresAt - now) / 1000)) };
}

function lastResult() { return lastOutcome; }

function callbackHandler(p) {
  return async (req, res) => {
    let u;
    try { u = new URL(req.url, `http://127.0.0.1:${CALLBACK_PORT}`); } catch { res.writeHead(400); res.end(); return; }
    if (u.pathname !== CALLBACK_PATH) { res.writeHead(404); res.end(); return; }
    // Same checks as the pasted address, on the address this server was reached at.
    const r = parsePastedAddress(`http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}${u.search}`, p, Date.now());
    // neutral: true when the outcome is not a confirmed failure (claimed elsewhere, replaced, busy, retry)
    const page = (ok, msg, neutral = false) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end(`<html><body style="font-family:system-ui;padding:40px"><h2>${ok ? 'Gmail connected ✅' : neutral ? 'Gmail sign-in' : 'Gmail was not connected ❌'}</h2><p>${ok ? 'You can close this tab and go back to your Maestro.' : msg}</p></body></html>`);
    };
    if (!r.ok) {
      if (r.reason === 'refused' || r.reason === 'expired') {
        const d = await decideEnd(p, r.reason === 'expired');   // decide in the transaction before any outcome, rejection or page
        if (d.busy) { page(false, d.message, true); return; }
        endPending(p); authInProgress = null;
        if (d.removed) {
          lastOutcome = { state: 'failed', message: r.message, at: Date.now() };
          if (p.reject) p.reject(new Error(r.reason));
          page(false, r.message);
        } else {
          if (p.reject) p.reject(new Error(d.message));
          page(false, d.message, true);
        }
        return;
      }
      page(false, r.message);
      return;   // anything else (a stray request, another sign-in's state) leaves this sign-in waiting
    }
    const done = await finishWithCode(p, r.code);
    // the failure heading only for a confirmed failure; claimed elsewhere, replaced or busy keep the neutral heading
    page(done.ok, done.message, !done.ok && ['used', 'replaced', 'busy'].includes(done.reason));
  };
}

/** Close only this attempt's own listener, quietly (no message, no rejection). */
function closeListener(p) { if (p.server) { try { p.server.close(); } catch { /* closed */ } p.server = null; } }

function armExpiry(p, ms) {
  if (p.timer) clearTimeout(p.timer);
  p.timer = setTimeout(() => { p.timer = null; expire(p); }, ms);
  if (p.timer.unref) p.timer.unref();
}

/**
 * The deadline of attempt p. The row is removed (in the transaction) only when it still has p's id, is unused and the deadline
 * has passed; only then does p announce a timeout. When another process claimed the sign-in, or a newer one replaced it, this
 * attempt ends with a plain sentence (promise settled, listener closed) and leaves the row alone: the exchange in flight there is
 * never cancelled from here.
 */
async function expire(p) {
  if (pending !== p || p.used) { closeListener(p); return; }
  let r;
  try {
    r = await withLock(() => {
      const f = readPendingFile();
      if (!f || f.id !== p.id) return 'replaced';
      if (f.used) return 'claimedElsewhere';
      if (Date.now() < f.expiresAt) return Math.max(5, f.expiresAt - Date.now() + 5);   // a timer that fired a hair early
      deleteRow(p.id, true);
      return 'removed';
    });
  } catch { r = BUSY; }
  if (pending !== p || p.used) { closeListener(p); return; }
  if (r === 'removed') {
    endPending(p); authInProgress = null;
    lastOutcome = { state: 'failed', message: WORDS.expired, at: Date.now() };
    p.reject(new Error('auth timed out'));
  } else if (r === 'replaced' || r === 'claimedElsewhere') {
    // The other process's row is left alone; this waiting caller still gets an answer (promise settled, listener closed).
    endAttempt(p, r === 'replaced' ? WORDS.replaced : 'Another process is handling this Gmail sign-in. Check its result there.');
  } else {   // busy or early: look again shortly
    armExpiry(p, typeof r === 'number' ? r : 1000);
  }
}

/**
 * Start a sign-in (replacing any waiting one). Returns { url, expiresAt, promise }: promise settles with the tokens when the
 * sign-in finishes either way. opts: { open: try to open the link in a browser on this machine (default true),
 * listener: also listen on localhost for the automatic callback (default true; if the port is taken the pasted address still works) }.
 */
async function startSignIn(opts = {}) {
  const client = clientOverride !== undefined ? clientOverride : loadClient();
  if (!client) { const e = new Error('Google sign-in details not found'); e.userMessage = WORDS.noClient; throw e; }
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  const p = { id: crypto.randomBytes(8).toString('hex'), state, verifier, client, url: null, expiresAt: Date.now() + LIFETIME_MS, used: false, server: null, timer: null, resolve: null, reject: null };
  const promise = new Promise((resolve, reject) => { p.resolve = resolve; p.reject = reject; });
  promise.catch(() => {});   // the page reads the outcome; nobody waiting is not an error
  p.promise = promise;
  // No link without a saved sign-in: write the record (under the lock) before anything is assigned, opened or returned.
  let written;
  try { written = await withLock(() => { putRow(filePendingOf(p)); return true; }); } catch { written = false; }
  if (written === BUSY) { const e = new Error(WORDS.busy); e.userMessage = WORDS.busy; throw e; }
  if (!written) throw new Error('Could not save the Gmail sign-in. Check the data folder and try again.');
  if (pending) endAttempt(pending);   // the record on file now names the new one: the old attempt ends (listener closed, promise rejected)
  authInProgress = promise;
  pending = p;
  lastOutcome = null;
  const params = new URLSearchParams({
    client_id: client.client_id, redirect_uri: REDIRECT_URI, response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
  });
  p.url = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  lastAuthUrl = p.url;
  armExpiry(p, LIFETIME_MS);
  if (opts.listener !== false) {
    await new Promise((resolve) => {
      const server = http.createServer(callbackHandler(p));
      server.once('error', () => { try { server.close(); } catch { /* not open */ } resolve(); });   // port taken: the pasted address still works
      server.listen(CALLBACK_PORT, '127.0.0.1', () => { if (pending === p && !p.used) p.server = server; else { try { server.close(); } catch { /* done */ } } resolve(); });
    });
  }
  console.log('[gmail-oauth] Gmail sign-in started.');
  let opened = false;
  if (opts.open !== false) { try { opened = !!(await (openerImpl || openBrowser)(p.url)); } catch { opened = false; } }
  return { url: p.url, expiresAt: p.expiresAt, promise, opened };
}

/**
 * The one call for a caller that relays to a person: start a sign-in and return { mode, message, url }.
 * mode 'paste': the message says what to do (open the link, approve, copy the whole address back); finish with finishWithPastedAddress.
 * mode 'done': only when the caller passes opts.waitMs and the automatic localhost callback finished it within that time.
 * The paste-back text always returns at once by default (a browser that opened keeps its localhost listener going in the background).
 */
async function beginSignIn(opts = {}) {
  // No display: nothing could land on a listener here, so do not even start one.
  const listener = opts.listener !== undefined ? opts.listener : !!(openerImpl || canOpenBrowser());
  const s = await startSignIn({ listener, open: true });
  const paste = { mode: 'paste', message: pasteBackMessage(s.url), url: s.url, expiresAt: s.expiresAt };
  if (!s.opened) {
    // The opener failed: nobody is coming to the listener, so close it; the pasted address is the way.
    if (pending && pending.url === s.url && pending.server) { try { pending.server.close(); } catch { /* closed */ } pending.server = null; }
    return paste;
  }
  // A browser opened here: the listener keeps waiting in the background. By default the paste-back steps return at once, so the
  // agent's turn is not held for minutes; a caller that wants to wait for the automatic finish passes waitMs.
  const waitMs = Number(opts.waitMs) > 0 ? Number(opts.waitMs) : 0;
  if (!waitMs) return paste;
  let timer;
  const outcome = await Promise.race([
    s.promise.then(() => 'done', () => 'failed'),
    new Promise((resolve) => { timer = setTimeout(() => resolve('waiting'), waitMs); }),
  ]);
  clearTimeout(timer);
  if (outcome === 'done') return { mode: 'done', message: 'Gmail is connected.', url: s.url, expiresAt: s.expiresAt };
  if (outcome === 'failed') { const l = lastOutcome; return { mode: 'failed', message: (l && l.message) || WORDS.exchange, url: s.url, expiresAt: s.expiresAt }; }
  return paste;
}

function runAuthFlow(client, onUrl) {
  if (authInProgress) return authInProgress;
  return startSignIn().then((s) => { if (typeof onUrl === 'function') { try { onUrl(s.url); } catch { /* noop */ } } return s.promise; });
}

/**
 * Get a valid gmail.modify access token.  Triggers a browser auth flow on first use.
 * @param {boolean} interactive - allow launching the browser flow (default true)
 */
async function getAccessToken(interactive = true, onUrl) {
  const client = loadClient();
  if (!client) throw new Error('Google OAuth client credentials not found (install @internal/google-workspace-mcp or set GMAIL_OAUTH_CLIENT_ID).');

  let tok = loadToken();
  if (tok && tok.access_token && tok.expiry_date && Date.now() < tok.expiry_date - 60000) return tok.access_token;
  if (tok && tok.refresh_token) {
    try { return (await refresh(tok, client)).access_token; }
    catch (e) { if (!interactive) throw e; }
  }
  if (!interactive) throw new Error('No Gmail write token. Start the Gmail sign-in (beginSignIn) and finish it with the address the browser ended up on.');
  tok = await runAuthFlow(client, onUrl);
  return tok.access_token;
}

function status() {
  const tok = loadToken();
  if (!tok) return { authorized: false };
  return {
    authorized: true,
    scope: tok.scope,
    expires_in_min: tok.expiry_date ? Math.round((tok.expiry_date - Date.now()) / 60000) : null,
    has_refresh: !!tok.refresh_token,
  };
}

/** Call the Gmail REST API with auto-refresh + single retry on 401. */
async function gmailApi(method, apiPath, body) {
  const doCall = (token) => new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'gmail.googleapis.com',
      path: apiPath,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let json = null;
        try { json = d ? JSON.parse(d) : {}; } catch { json = { raw: d }; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

  let token = await getAccessToken();
  let r = await doCall(token);
  if (r.status === 401) {
    const client = loadClient();
    const tok = loadToken();
    if (tok && tok.refresh_token) {
      token = (await refresh(tok, client)).access_token;
      r = await doCall(token);
    }
  }
  return r;
}

function getAuthUrl() { return lastAuthUrl; }

module.exports = {
  getAccessToken, gmailApi, status, getAuthUrl, TOKEN_PATH, SCOPES,
  CALLBACK_PORT, CALLBACK_PATH, LIFETIME_MS, WORDS,
  parsePastedAddress, startSignIn, beginSignIn, submitPastedAddress, finishWithPastedAddress: submitPastedAddress,
  canOpenBrowser, pasteBackMessage, cancelSignIn, pendingView, lastResult,
  _test: {
    setOpener(fn) { openerImpl = fn || null; },
    setPostForm(fn) { postFormImpl = fn || postForm; },
    setClient(c) { clientOverride = c; },
    decideEnd, current() { return pending; },
    expireNow() { if (pending) pending.expiresAt = Date.now() - 1; },
    callback(req, res) { return callbackHandler(pending)(req, res); },   // drive the browser callback without a socket
    fireExpiry() { return pending ? expire(pending) : Promise.resolve(); },   // run the deadline check now, as the timer would
  },
};
