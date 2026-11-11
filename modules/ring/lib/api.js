'use strict';
// Ring module: everything that talks to Ring's servers.
//
//  * The OAuth token exchange (authorization_code) and refresh (refresh_token), 10 s per call.
//  * The sign-in itself. Ring ROTATES the refresh token: every renewal retires the old one. So a renewed refresh token is
//    first written to the private unsaved file, then handed to the hub ('hub/refresh_token'), and only when the hub says
//    it saved it is the unsaved file removed. Until then the new token is the one used (the old one is never spent
//    again); at start the unsaved one is preferred over the REFRESH_TOKEN secret and its hand-over is retried.
//  * Ring API calls with the bearer token (one forced refresh and retry on a 401), the device list, device status,
//    image and video downloads (pre-signed public https addresses only, no bearer token sent to them) and event history.
//
// createApi(ctx) takes ctx = { env, settings, store, log, now, fetch, hubRequest } and returns:
//   API                                       -> the Ring API base address in use (a test can redirect it)
//   start()                                   -> Promise: load the stored sign-in, retry an unconfirmed hand-over to the hub
//   credentials()                             -> { client_id, client_secret, hmac_key } | null (from CLIENT_ID, CLIENT_SECRET, HMAC_KEY)
//   keyCandidates()                           -> [{ enc, key: Buffer }] the HMAC key in every reading, the remembered one first
//   rememberKeyEncoding(enc)                  -> remember which reading of the HMAC key Ring's signatures match
//   hardwareId()                              -> string, the persistent id sent as the Hardware_Id header
//   ringFetch(url, { method, headers, body, timeoutMs, deadline }) -> Response (never follows redirects)
//   oauthToken(params, { timeoutMs })         -> token JSON; throws an Error with .status and .code
//   exchangeCode(code, { timeoutMs })         -> token pair { access_token, refresh_token, expires_at, obtained_at, scope }
//   userMe(accessToken, { timeoutMs })        -> { id, email } of the Ring account that owns the token
//   bearerCall(accessToken, method, p, body, { timeoutMs }) -> Response, for a token that is not (yet) the stored sign-in
//   adoptPair(accountId, pair, meta)          -> Promise<bool>: make a confirmed link the sign-in; true when the hub confirmed saving it
//   accessTokenFor()                          -> Promise<string>; throws 'no linked Ring account' / 'the Ring connection needs relinking'
//   refreshAccount(force)                     -> Promise<bool>
//   persistRenewal()                          -> Promise<bool>: hand an unconfirmed refresh token to the hub again
//   api(method, p, body, { timeoutMs })       -> Response with the stored sign-in (one forced refresh and retry on a 401)
//   refreshDevices() / refreshDevicesOnce()   -> Promise: fetch the device list into the store
//   deviceStatus(deviceId)                    -> { online, reported_at } (reported_at in ms)
//   imageDownload(deviceId, body)             -> { buf, png, mediaTs, origin } | { why, stop, retryAfter }
//   clipDownload(deviceId, start, seconds)    -> { file, mediaTs, lengthMs, partial } | { error }  (file is in the store's work area)
//   eventHistory(deviceId, since, types)      -> [{ type, start, end }]
//   withLock(key, fn)                         -> run fn after earlier work under the same key
//   warning()                                 -> text when a renewed refresh token is not yet confirmed saved, else null
//   unsavedToken()                            -> bool
//   needsRelink()                             -> { linked, needs_relink, reason }
//   onNeedsRelink(fn)                         -> fn(reason) is called when Ring rejects the stored sign-in
// Also exported: createApi, privateHost, mediaAddress, isImage, readLimited, keyCandidates, tokenPair, retryAfterSeconds,
//   withTimeout, USER_AGENT, API_BASE, OAUTH_URL and the size/time constants.

const fs = require('node:fs');
const crypto = require('node:crypto');
const dns = require('node:dns');
const net = require('node:net');

const USER_AGENT = 'MyMaestroAI-Ring/1.0';   // the one place the User-Agent is set
const API_BASE = 'https://api.amazonvision.com';
const OAUTH_URL = 'https://oauth.ring.com/oauth/token';
const MAX_IMAGE = 15 * 1024 * 1024;
const MAX_CLIP = 300 * 1024 * 1024;
const FREE_SPACE_RESERVE = 2 * 1024 * 1024 * 1024;
const OAUTH_TIMEOUT_MS = 10000;
const RING_TIMEOUT_MS = 15000;
const HUB_TIMEOUT_MS = 10000;
const REFRESH_WHEN_LEFT_MS = 30 * 60 * 1000;   // upkeep renews under 30 minutes left
const FORCE_WHEN_LEFT_MS = 5 * 60 * 1000;      // a call renews under 5 minutes left
const FORCE_MIN_AGE_MS = 30000;                // a forced renewal skips a sign-in younger than this
const RETRY_AFTER_MAX_S = 30;
const MAX_PAGES = 10;
const MAX_HISTORY = 200;
const CLIP_HOPS = 3;
const REDIRECTS = [301, 302, 303, 307, 308];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s, max = 80) => { let t = ''; try { t = String(s == null ? '' : s); } catch { /* {"toString": null} can't be turned into text */ } return t.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); };
const shortId = (s) => (s ? `…${String(s).slice(-6)}` : '-');
function withTimeout(p, ms, what = 'the request') {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} timed out`)), ms); });
  return Promise.race([Promise.resolve(p), t]).finally(() => clearTimeout(timer));
}
function writeAll(fd, buf) {
  for (let off = 0; off < buf.length;) {
    const n = fs.writeSync(fd, buf, off, buf.length - off);
    if (n <= 0) throw Object.assign(new Error('short write'), { code: 'EIO' });
    off += n;
  }
}

async function readLimited(res, max) {   // the body up to max bytes: by the announced length and by what really arrives
  const len = Number(res.headers.get('content-length') || 0);
  if (len > max) return null;
  const chunks = [];
  let n = 0;
  for await (const c of res.body) { n += c.length; if (n > max) return null; chunks.push(Buffer.from(c)); }
  return Buffer.concat(chunks);
}
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isImage = (b) => !!b && b.length > 8 && ((b[0] === 0xff && b[1] === 0xd8) || b.subarray(0, 8).equals(PNG_MAGIC));
function privateHost(host) {
  const bracketed = /^\[.*\]$/.test(String(host));
  const h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  if (!h || h === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h)) return true;
  if (!bracketed && !h.includes(':') && (!h.includes('.') || h.endsWith('.'))) return true;   // 'nas', 'localhost.': single-label or rooted names
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (h.includes(':')) return !/^[23][0-9a-f]{3}:/.test(h) || /^2001:(0|db8):|^2002:/.test(h);   // only global unicast (2000::/3) passes; documentation, 6to4 and everything else is refused
  return /^\d+$/.test(h) || /^0x/i.test(h);   // integer or hex forms of an IPv4 address
}
// Every address a name resolves to must be public. NOTE: the connection itself is not pinned to the addresses checked
// here (a name could answer differently at connect time); pinning the connection to the checked address is a follow-up.
const privateAddress = (addr) => privateHost(addr) || addr === '0.0.0.0' || /^::ffff:/i.test(addr);
async function resolvesPublic(host, lookup) {
  const h = String(host).replace(/^\[|\]$/g, '');
  if (net.isIP(h)) return !privateAddress(h);
  try {
    const list = await lookup(h, { all: true });
    return Array.isArray(list) && list.length > 0 && list.every((x) => x && typeof x.address === 'string' && !privateAddress(x.address));
  } catch { return false; }
}
// A pre-signed address must be public https (plain-http loopback only when the tests allow it).
function mediaAddress(loc, base = API_BASE, allowHttpLoopback = false) {
  let u;
  try { u = new URL(loc, base); } catch { return null; }
  const testLoopback = allowHttpLoopback && u.protocol === 'http:' && u.hostname === '127.0.0.1';
  return testLoopback || (u.protocol === 'https:' && !privateHost(u.hostname)) ? u : null;
}
const retryAfterSeconds = (res) => Math.min(Number(res.headers.get('retry-after')) || 5, RETRY_AFTER_MAX_S);
// Ring's samples use the HMAC key as UTF-8 text. If its signatures match a base64- or hex-decoded key instead, that
// reading is remembered, so a wrong guess can't block linking or reject webhooks.
function keyCandidates(c, pref = 'utf8') {
  const out = [];
  for (const enc of [pref, ...['utf8', 'base64', 'hex'].filter((x) => x !== pref)]) {
    try {
      if (enc === 'utf8') out.push({ enc, key: Buffer.from(c.hmac_key, 'utf8') });
      else if (enc === 'base64' && /^[A-Za-z0-9+/_-]+={0,2}$/.test(c.hmac_key)) { const k = Buffer.from(c.hmac_key.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); if (k.length >= 16) out.push({ enc, key: k }); }
      else if (enc === 'hex' && /^([0-9a-fA-F]{2}){16,}$/.test(c.hmac_key)) out.push({ enc, key: Buffer.from(c.hmac_key, 'hex') });
    } catch { /* this reading does not apply */ }
  }
  return out;
}
const tokenPair = (t, now = Date.now()) => ({ access_token: t.access_token, refresh_token: t.refresh_token, expires_at: now + (Number(t.expires_in) || 14400) * 1000, obtained_at: now, scope: t.scope || null });
const accessOf = (pair) => ({ access_token: pair.access_token, expires_at: pair.expires_at, obtained_at: pair.obtained_at, scope: pair.scope || null });

function createApi(ctx) {
  const { env = {}, store, hubRequest } = ctx;
  const log = ctx.log || (() => {});
  const now = ctx.now || Date.now;
  const doFetch = ctx.fetch || fetch;
  const lookup = ctx.lookup || dns.promises.lookup;   // injectable so tests need no network
  const testing = env.RING_TEST === '1';   // the endpoints can only be redirected, and plain-http media allowed, in tests
  const API = (testing && env.RING_API_BASE) || API_BASE;
  const OAUTH = (testing && env.RING_OAUTH_URL) || OAUTH_URL;
  const ALLOW_HTTP_MEDIA = testing && env.RING_ALLOW_HTTP_MEDIA === '1';
  const quiet = new Map();
  const logEvery = (key, ms, ...a) => { const t = quiet.get(key) || 0; if (now() - t > ms) { quiet.set(key, now()); log(...a); } };

  // ── per-key work queue: one token change at a time ─────────────────────────────────────────────────────────
  const locks = new Map();
  function withLock(id, fn) {
    const next = (locks.get(id) || Promise.resolve()).then(() => fn());
    locks.set(id, next.catch(() => {}));
    return next;
  }

  // ── credentials, hardware id ──────────────────────────────────────────────────────────────────────────────
  function credentials() {
    const c = { client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, hmac_key: env.HMAC_KEY };
    return c.client_id && c.client_secret && c.hmac_key ? c : null;
  }
  const keyCands = () => { const c = credentials(); return c ? keyCandidates(c, store.keyEncoding()) : []; };
  const rememberKeyEncoding = (enc) => store.setKeyEncoding(enc);
  let HW = null;
  function hardwareId() {
    if (HW) return HW;
    const v = (store.readText('hardware-id') || '').trim();
    if (v) return (HW = v);
    HW = crypto.randomUUID();
    store.writeText('hardware-id', HW + '\n');
    return HW;
  }

  // ── Ring HTTP ──────────────────────────────────────────────────────────────────────────────────────────────
  function ringFetch(url, opts = {}) {
    const headers = { 'User-Agent': USER_AGENT, Hardware_Id: hardwareId(), ...(opts.headers || {}) };
    let ms = opts.timeoutMs || RING_TIMEOUT_MS;
    if (opts.deadline) ms = Math.max(1, Math.min(ms, opts.deadline - now()));
    return doFetch(url, { method: opts.method || 'GET', headers, body: opts.body, redirect: 'manual', signal: AbortSignal.timeout(ms) });
  }
  async function oauthToken(params, opts = {}) {
    const c = credentials();
    if (!c) throw new Error('no credentials');
    const body = new URLSearchParams({ ...params, client_id: c.client_id, client_secret: c.client_secret }).toString();
    const r = await ringFetch(OAUTH, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, timeoutMs: opts.timeoutMs || OAUTH_TIMEOUT_MS, deadline: opts.deadline });
    const text = await r.text().catch(() => '');
    let j = null;
    try { j = JSON.parse(text); } catch { /* not JSON */ }
    if (!r.ok || !j || !j.access_token || !j.refresh_token) {
      const e = new Error(`the token endpoint answered ${r.status}${j && j.error ? ` (${clean(j.error, 40)})` : ''}`);
      e.status = r.status; e.code = j && typeof j.error === 'string' ? j.error : null;
      throw e;
    }
    return j;
  }
  async function exchangeCode(code, opts = {}) { return tokenPair(await oauthToken({ grant_type: 'authorization_code', code }, opts), now()); }
  const bearerCall = (accessToken, method, p, body, opts = {}) => ringFetch(API + p, {
    method, timeoutMs: opts.timeoutMs, deadline: opts.deadline,
    headers: { Authorization: `Bearer ${accessToken}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  async function userMe(accessToken, opts = {}) {
    const me = await bearerCall(accessToken, 'GET', '/v1/users/me', undefined, opts);
    const mj = await me.json().catch(() => null);
    const id = mj && mj.data && typeof mj.data.id === 'string' ? clean(mj.data.id, 200) : null;
    if (!me.ok || !id) throw new Error(`users/me answered ${me.status}`);
    return { id, email: mj.data.attributes && mj.data.attributes.email };
  }

  // ── the sign-in: access token in the account record, refresh token with the hub ─────────────────────────────
  // cur = { refresh, access, unsaved, writing }: refresh is the refresh token to spend next; unsaved = the hub has not
  // confirmed saving it yet (it is then also in the private unsaved file).
  let cur = null;
  let relinkHook = null;
  function load() {
    if (cur) return cur;
    const u = store.unsaved.get();   // unreadable state throws ESTATE here: never a silent fall back to REFRESH_TOKEN
    const a = store.account();
    cur = { refresh: u || env.REFRESH_TOKEN || null, access: a && a.access ? a.access : null, unsaved: !!u, writing: null, acct: a, writeFailed: false };
    return cur;
  }
  // The account record; if account.json turns unreadable later, what was last read stays in use (renewal carries on).
  function acct() {
    try { const a = store.account(); if (cur) cur.acct = a; return a; } catch (e) { if (e.code === 'ESTATE' && cur) return cur.acct; throw e; }
  }
  function persistRenewal() {
    load();
    if (!cur.unsaved) return Promise.resolve(true);
    if (cur.writeFailed) {   // the renewed token could not be written privately: try again at every upkeep
      try { store.unsaved.set(cur.refresh); cur.writeFailed = false; } catch (e) { logEvery('unsavedwrite', 60000, 'could not write the unsaved sign-in file yet:', e.code || e.message); }
    }
    if (cur.writing) return cur.writing;
    const token = cur.refresh;
    cur.writing = (async () => {
      try {
        const r = await withTimeout(hubRequest('hub/refresh_token', { value: token }), HUB_TIMEOUT_MS, 'the hub');
        if (!r || r.ok !== true) { logEvery('unsaved', 60000, 'the hub did not confirm saving the renewed Ring sign-in yet; it stays in use and is retried'); return false; }
        if (cur.refresh === token) {
          cur.unsaved = false;
          cur.writeFailed = false;
          try { store.unsaved.clear(); } catch (e) { log('could not remove the unsaved sign-in file:', e.code || e.message); }
        }
        return true;
      } catch (e) {
        logEvery('unsaved', 60000, 'could not hand the renewed Ring sign-in to the hub yet:', clean(e.code || e.message, 60));
        return false;
      } finally { cur.writing = null; }
    })();
    return cur.writing;
  }
  async function start() {
    try { load(); } catch (e) { if (e.code === 'ESTATE') return; throw e; }
    if (cur.unsaved) await persistRenewal();
  }
  // Ring has retired the old refresh token: remember the new one on disk first, then give it to the hub.
  async function keepNewRefresh(pair, accountRec) {
    load();
    cur.refresh = pair.refresh_token;
    cur.access = accessOf(pair);
    cur.unsaved = true;
    cur.writeFailed = false;
    try { store.unsaved.set(pair.refresh_token); } catch (e) { cur.writeFailed = true; log('could not write the unsaved sign-in file:', e.code || e.message); }
    try { if (accountRec) store.saveAccount({ ...accountRec, access: cur.access }); } catch (e) { log('could not save the renewed access token:', e.code || e.message); }
    return persistRenewal();
  }
  // A confirmed link becomes the sign-in. Returns whether the hub confirmed saving the refresh token.
  function adoptPair(accountId, pair, meta = {}) {
    return withLock('acct', async () => {
      const old = store.account() || {};
      const rec = { ...(old.account_id === accountId ? old : {}), ...meta, account_id: accountId, claimed_at: now(), needs_relink: false };
      delete rec.relink_reason;
      return keepNewRefresh(pair, rec);
    });
  }
  // A refresh result is applied only if the refresh token it started from is still the current one: a relink in between wins.
  function refreshAccount(force) {
    return withLock('acct', async () => {
      try { load(); } catch (e) { if (e.code === 'ESTATE') return false; throw e; }
      if (cur.unsaved) await persistRenewal();   // an unconfirmed hand-over does not stop renewing: the newest (unsaved) token is the one spent
      const a = acct();
      if (!a || a.needs_relink || !cur.refresh) return false;
      const acc = cur.access || a.access;
      const t0 = now();
      if (acc && !force && acc.expires_at - t0 > REFRESH_WHEN_LEFT_MS) return true;
      if (acc && force && t0 - acc.obtained_at < FORCE_MIN_AGE_MS) return true;   // just renewed by someone else
      const used = cur.refresh;
      let t;
      try { t = await oauthToken({ grant_type: 'refresh_token', refresh_token: used }); } catch (e) {
        log('token refresh failed for Ring account', shortId(a.account_id) + ':', e.message);
        if (e.code === 'invalid_grant' && cur.refresh === used) {   // only a rejected refresh token means relinking; other errors are retried
          const reason = 'Ring rejected the stored sign-in (invalid_grant)';
          try { store.setNeedsRelink(reason); } catch (err) { log('could not record the relink flag:', err.code || err.message); }
          if (relinkHook) { try { relinkHook(reason); } catch { /* the hook must not break the refresh */ } }
        }
        return false;
      }
      if (cur.refresh !== used) { log('a refresh result was dropped: the sign-in changed meanwhile'); return false; }
      await keepNewRefresh(tokenPair(t, now()), a);   // each refresh returns a new refresh token and retires the old one
      log('access token refreshed for Ring account', shortId(a.account_id));
      return true;
    });
  }
  async function accessTokenFor() {
    load();
    if (cur.unsaved) await persistRenewal();
    let a = acct();
    if (!a) throw new Error('no linked Ring account');
    if (a.needs_relink) throw new Error('the Ring connection needs relinking');
    const acc = cur.access || a.access;
    if (!acc || acc.expires_at - now() < FORCE_WHEN_LEFT_MS) await refreshAccount(true);
    a = acct();
    if (!a || a.needs_relink) throw new Error('the Ring connection needs relinking');
    const fresh = cur.access || a.access;
    if (!fresh || !fresh.access_token) throw new Error('the Ring connection needs relinking');
    return fresh.access_token;
  }
  async function api(method, p, body, opts = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await bearerCall(await accessTokenFor(), method, p, body, opts);
      if (r.status === 401 && attempt === 0) { await r.arrayBuffer().catch(() => {}); await refreshAccount(true); continue; }
      return r;
    }
    throw new Error('unreachable');
  }

  // ── devices ───────────────────────────────────────────────────────────────────────────────────────────────
  async function refreshDevices() {
    if (!store.claimedAccount()) return;
    const out = {};
    let p = '/v1/devices?include=status,capabilities';
    for (let page = 0; p && page < MAX_PAGES; page++) {
      const r = await api('GET', p);
      if (!r.ok) { log('device list failed: Ring answered', r.status); await r.arrayBuffer().catch(() => {}); return; }
      const j = await r.json().catch(() => null);
      for (const d of (j && Array.isArray(j.data) ? j.data : [])) {
        if (d && typeof d.id === 'string') out[clean(d.id, 200)] = { name: clean(d.attributes && d.attributes.name) || null, type: clean(d.type, 40) || null };
      }
      const next = j && j.links && typeof j.links.next === 'string' ? j.links.next : null;
      p = next && /^\/v1\/devices\?/.test(next) ? next : null;
    }
    store.devices.save({ fetchedAt: new Date(now()).toISOString(), devices: out });
    log('device list:', Object.keys(out).length, 'devices');
  }
  let refreshing = null;   // events that change the device list share one refresh instead of starting one each
  function refreshDevicesOnce() { return refreshing || (refreshing = refreshDevices().finally(() => { refreshing = null; })); }
  async function deviceStatus(deviceId) {
    let online = null, reported = null;
    try {
      const r = await api('GET', `/v1/devices/${encodeURIComponent(deviceId)}/status`);
      const j = r.ok ? await r.json().catch(() => null) : (await r.arrayBuffer().catch(() => {}), null);
      const a = j && j.data && j.data.attributes;
      if (a) { online = typeof a.online === 'boolean' ? a.online : null; reported = Date.parse(a.reported_at) || null; }
    } catch { /* unknown stays null */ }
    return { online, reported_at: reported };
  }

  // A media address, checked by name and, before every fetch (each redirect hop), by what the name resolves to.
  async function publicMediaAddress(loc) {
    const u = mediaAddress(loc, API, ALLOW_HTTP_MEDIA);
    if (!u || u.protocol === 'http:') return u;   // plain http only ever passes for the test loopback
    return (await resolvesPublic(u.hostname, lookup)) ? u : null;
  }

  // ── images ────────────────────────────────────────────────────────────────────────────────────────────────
  // Ring's image download is two steps: POST → 303 with a short-lived pre-signed address → GET that address (no bearer
  // token: it must not leave Ring's API; no further redirects). Right after an event the image may not exist yet.
  // One image request: { buf, png, mediaTs, origin } or { why, stop, retryAfter } (stop = trying again soon won't help).
  async function imageDownload(deviceId, body) {
    let r;
    try { r = await api('POST', `/v1/devices/${encodeURIComponent(deviceId)}/media/image/download`, body); } catch (e) { return { why: e.message, stop: /needs relinking|no linked Ring account/.test(e.message) }; }
    const meta = (res) => ({ mediaTs: Number(res.headers.get('x-media-timestamp')) || null, origin: clean(res.headers.get('x-media-origin') || '', 20) || null });
    if (REDIRECTS.includes(r.status)) {
      const loc = r.headers.get('location');
      await r.arrayBuffer().catch(() => {});
      const u = await publicMediaAddress(loc);
      if (!u) return { why: 'Ring gave a download address that is not a public https address' };
      let g;
      try { g = await doFetch(u, { redirect: 'manual', signal: AbortSignal.timeout(20000) }); } catch (e) { return { why: `the download failed (${clean(e.message, 60)})` }; }
      if (!g.ok) { await g.arrayBuffer().catch(() => {}); return { why: `the download answered ${g.status}` }; }
      const buf = await readLimited(g, MAX_IMAGE).catch(() => null);
      if (!isImage(buf)) return { why: 'the download was not an image' };
      return { buf, png: buf[0] === 0x89, ...meta(g) };
    }
    if (r.status === 200) {
      const buf = await readLimited(r, MAX_IMAGE).catch(() => null);
      return isImage(buf) ? { buf, png: buf[0] === 0x89, ...meta(r) } : { why: 'Ring answered without an image' };
    }
    const text = await r.text().catch(() => '');
    if (r.status === 503 && /offline/i.test(text)) return { why: 'the camera is offline', stop: true };
    if (r.status === 429) return { why: 'Ring answered 429', retryAfter: retryAfterSeconds(r) };
    return { why: `Ring answered ${r.status}`, stop: [400, 403, 404].includes(r.status) };
  }

  // ── a recorded clip: POST → 303 to a pre-signed address → MP4 (200, or 206 when only part of it exists) ─────
  async function clipDownload(deviceId, start, seconds) {
    let r;
    try { r = await api('POST', `/v1/devices/${encodeURIComponent(deviceId)}/media/video/download`, { timestamp: start, duration: seconds * 1000, video_options: { codec: 'avc' } }); } catch (e) { return { error: e.message }; }
    for (let hop = 0; REDIRECTS.includes(r.status); hop++) {
      const loc = r.headers.get('location');
      await r.arrayBuffer().catch(() => {});
      if (hop >= CLIP_HOPS) return { error: 'Ring redirected too many times' };
      const u = await publicMediaAddress(loc);
      if (!u) return { error: 'Ring gave a download address that is not a public https address' };
      try { r = await doFetch(u, { redirect: 'manual', signal: AbortSignal.timeout(180000) }); } catch (e) { return { error: `the download failed (${clean(e.message, 60)})` }; }
    }
    if (r.status !== 200 && r.status !== 206) {
      const text = await r.text().catch(() => '');
      if (r.status === 404 || r.status === 416) return { error: 'Ring has no recording from that camera at that time (Ring records around events: find one with a history request)' };
      if (r.status === 503 && /offline/i.test(text)) return { error: 'the camera is offline' };
      return { error: `Ring answered ${r.status}` };
    }
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX_CLIP) { await r.body.cancel().catch(() => {}); return { error: 'the clip is too large' }; }
    const out = store.workFile('mp4');   // makes the private work folder
    if (store.freeBytes(store.workDir) < FREE_SPACE_RESERVE + (len || 50 * 1024 * 1024)) { await r.body.cancel().catch(() => {}); return { error: 'the disk is nearly full' }; }
    const fd = fs.openSync(out, 'wx', 0o600);
    let n = 0;
    try {
      for await (const c of r.body) { n += c.length; if (n > MAX_CLIP) throw new Error('the clip is too large'); writeAll(fd, Buffer.from(c)); }
    } catch (e) { fs.closeSync(fd); try { fs.unlinkSync(out); } catch { /* gone */ } return { error: clean(e.message, 80) }; }
    fs.closeSync(fd);
    const head = Buffer.alloc(8);
    const hfd = fs.openSync(out, 'r');
    try { fs.readSync(hfd, head, 0, 8, 0); } finally { fs.closeSync(hfd); }
    if (head.subarray(4, 8).toString('latin1') !== 'ftyp') { try { fs.unlinkSync(out); } catch { /* gone */ } return { error: 'Ring answered without a video' }; }
    return { file: out, mediaTs: Number(r.headers.get('x-media-timestamp')) || start, lengthMs: Number(r.headers.get('x-media-length')) || null, partial: r.status === 206 };
  }

  // ── event history ─────────────────────────────────────────────────────────────────────────────────────────
  async function eventHistory(deviceId, since, types) {
    const out = [];
    const wanted = new Set(types.map((t) => t.split('.')[0]));   // Ring also returns kinds not asked for (live views)
    const base = `/v1/history/devices/${encodeURIComponent(deviceId)}/events`;
    let p = `${base}?event_types=${encodeURIComponent(types.join(','))}`;
    for (let page = 0; p && page < MAX_PAGES && out.length < MAX_HISTORY; page++) {
      const r = await api('GET', p);
      if (!r.ok) { await r.arrayBuffer().catch(() => {}); if (!out.length && page === 0) throw new Error(`Ring answered ${r.status}`); break; }
      const j = await r.json().catch(() => null);
      const items = j && Array.isArray(j.data) ? j.data : [];
      let newer = 0;
      for (const e of items) {
        const a = (e && e.attributes) || {};
        const start = Number(a.start), end = Number(a.end);
        if (!Number.isFinite(start) || start < since) continue;
        newer++;
        const type = clean(a.event_type, 30) || 'event';
        if (wanted.has(type.split('.')[0])) out.push({ type, start, end: Number.isFinite(end) ? end : null });
      }
      const next = j && j.links && typeof j.links.next === 'string' ? j.links.next : null;
      p = null;
      if (next && newer) { try { const u = new URL(next, API); if (u.origin === new URL(API).origin && u.pathname === base) p = u.pathname + u.search; } catch { /* a link we don't follow */ } }
    }
    return out;
  }

  const STATE_WARNING = 'Ring\'s saved sign-in cannot be read; renewal and linking are paused until it is fixed';
  const SAVE_WARNING = 'Ring renewed the sign-in but the hub has not confirmed saving it yet; it is kept privately and retried';
  return {
    API, start, credentials, keyCandidates: keyCands, rememberKeyEncoding, hardwareId, ringFetch, oauthToken, exchangeCode, userMe, bearerCall,
    adoptPair, accessTokenFor, refreshAccount, persistRenewal, api, refreshDevices, refreshDevicesOnce, deviceStatus,
    imageDownload, clipDownload, eventHistory, withLock,
    warning: () => { try { load(); } catch { return STATE_WARNING; } return cur.unsaved ? (cur.writeFailed ? SAVE_WARNING + '; the private copy could not be written either' : SAVE_WARNING) : null; },
    unsavedToken: () => { try { load(); } catch { return false; } return cur.unsaved; },
    unsavedWriteFailed: () => !!(cur && cur.unsaved && cur.writeFailed),   // health result: unsaved_write_failed
    needsRelink() { let a; try { a = acct(); } catch { a = cur ? cur.acct : null; } return { linked: !!a, needs_relink: !!(a && a.needs_relink), reason: a && a.relink_reason ? a.relink_reason : null }; },
    onNeedsRelink(fn) { relinkHook = typeof fn === 'function' ? fn : null; },
  };
}

module.exports = {
  createApi, privateHost, mediaAddress, isImage, readLimited, keyCandidates, tokenPair, retryAfterSeconds, withTimeout, sleep,
  USER_AGENT, API_BASE, OAUTH_URL, MAX_IMAGE, MAX_CLIP, FREE_SPACE_RESERVE, OAUTH_TIMEOUT_MS, RING_TIMEOUT_MS, HUB_TIMEOUT_MS,
  REFRESH_WHEN_LEFT_MS, FORCE_WHEN_LEFT_MS, FORCE_MIN_AGE_MS, RETRY_AFTER_MAX_S, MAX_PAGES, MAX_HISTORY, CLIP_HOPS,
};
