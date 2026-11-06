'use strict';
// Linking a Ring account: the token exchange the camera service calls, the link page a person opens from the Ring app, and the done page.
//
// Three receivers share one flow. 'token' (a POST from the camera service) trades the one-time code for tokens and keeps them as pending for an hour.
// 'link' (the person's browser) shows a form, and on submit checks the nonce and time (bound to the pending account), then the armed one-time code,
// confirms the link with the camera service and stores the account. 'done' is a static page. Every page is plain HTML without scripts and carries its own
// strict content-security-policy. The form posts to a RELATIVE address ('link'), so it works under /hooks/<id>/ and under an alias; the hub sandboxes
// the page, so the post arrives with Origin 'null' and nothing here depends on Origin.
//
// createLink(ctx) returns:
//   handle(request)                   -> Promise<{status, headers, body}>   the 'token', 'link' and 'done' receivers
//   armLink({ minutes, replace })     -> { code, expiresAt, minutes, replace }   opens the link page; the code is returned once, only its salted hash is kept
//   linkState()                       -> { armed, expiresAt, tries } | { armed: false }   (no code in it)
//
// ctx = { env, settings, store, api, media, faces, notify, log, now } as the other ring files provide it:
//   settings()                        -> { account_email, ... }   (an object is accepted too)
//   store.linkArm.get() / .arm({ minutes, replace }) / .matches(code, arm) / .wrong() / .clear(id)   the one-time code (link-arm.json)
//   store.keyEncoding() / store.linkedAccount()
//   store.pending()                   -> { <accountId>: { access_token, obtained_at, email_masked, ... } }
//   store.savePending(accountId, pair, emailMasked) / store.takePending(accountId)
//   api.credentials()                 -> { client_id, client_secret, hmac_key } | null
//   api.keyCandidates()               -> [{ enc, key: Buffer }]   api.rememberKeyEncoding(enc)
//   api.exchangeCode(code, { timeoutMs }) -> token pair { access_token, refresh_token, expires_at, obtained_at, scope }
//   api.userMe(accessToken, { timeoutMs }) -> { id, email }
//   api.ringFetch(url, { method, headers, body, timeoutMs }) -> Promise<Response>;  api.API -> base address
//   api.withLock(id, fn)              -> Promise
//   api.adoptPair(accountId, pair, meta) -> Promise<bool>   saves the account record, makes the confirmed pair current and hands its refresh token to the hub (true = the hub confirmed)
//   api.refreshDevicesOnce()          -> Promise
//   log(...args), now() -> ms
//
// Export list: createLink, computeNonce, matchNonce, freshness, maskEmail, normCode, validNonce, validTime, esc, clean, shortId, safeEqualStr,
//   and the limits MAX_FORM_BODY, LINK_WINDOW_S, CLOCK_SKEW_S, LINK_MAX_TRIES, PENDING_TOKEN_KEEP_MS, RATE_PER_MIN, RING_CALL_MS, DEADLINE_MS, PAGE_CSP.

const crypto = require('node:crypto');

const MAX_FORM_BODY = 8 * 1024;
const LINK_WINDOW_S = 600;
const CLOCK_SKEW_S = 60;
const LINK_MAX_TRIES = 5;
const PENDING_TOKEN_KEEP_MS = 3600000;
const RATE_PER_MIN = 10;
const BUCKET_MAX = 5000;
const RING_CALL_MS = 10000;
const DEADLINE_MS = 24000;
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const DEFAULT_API = 'https://api.amazonvision.com';

const clean = (s, max = 80) => { let t = ''; try { t = String(s == null ? '' : s); } catch { /* {"toString": null} can't be turned into text */ } return t.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); };
const shortId = (s) => (s ? `…${String(s).slice(-6)}` : '-');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function safeEqualStr(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function maskEmail(e) {
  const m = String(e || '').match(/^([^@\s]+)@([^@\s]+)$/);
  if (!m) return null;
  const u = m[1];
  return `${u[0]}***${u.length > 1 ? u[u.length - 1] : ''}@${clean(m[2], 60)}`;
}
const validNonce = (n) => typeof n === 'string' && /^[A-Za-z0-9_-]{20,120}$/.test(n);
const validTime = (t) => typeof t === 'string' && /^\d{10,16}$/.test(t);
const timeMs = (t) => { const n = Number(t); return n < 1e11 ? n * 1000 : n; };   // Ring sends milliseconds; seconds tolerated
function freshness(t, nowMs = Date.now()) {
  const delta = (nowMs - timeMs(t)) / 1000;
  if (delta > LINK_WINDOW_S) return 'This link request has expired. Start again from the Ring app.';
  if (delta < -CLOCK_SKEW_S) return 'This link request has a time in the future. Start again from the Ring app.';
  return null;
}
function computeNonce(time, accountId, key) {
  return crypto.createHmac('sha256', key).update(`${time}:${accountId}`, 'utf8').digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// The nonce is signed over "<time>:<account id>" with the shared key: only a genuine redirect for tokens we hold matches.
function matchNonce(candidates, pending, time, nonce, nowMs = Date.now()) {
  for (const { enc, key } of candidates || []) {
    for (const [id, p] of Object.entries(pending || {})) {
      if (!p || nowMs - p.obtained_at > PENDING_TOKEN_KEEP_MS) continue;
      if (safeEqualStr(computeNonce(time, id, key), nonce)) return { id, enc, pair: p };
    }
  }
  return null;
}
const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function html(status, title, bodyHtml) {
  const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1rem;color:#222}h1{font-size:1.4rem}input{font-size:1.1rem;padding:.4rem;width:100%;box-sizing:border-box;margin:.4rem 0 1rem}button{font-size:1rem;padding:.5rem 1.2rem}.err{color:#a00}</style></head><body><h1>${esc(title)}</h1>${bodyHtml}</body></html>`;
  return { status, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_CSP, 'cache-control': 'no-store' }, body: doc };
}
const plain = (status, text, type = 'text/plain; charset=utf-8') => ({ status, headers: { 'content-type': type, 'cache-control': 'no-store' }, body: text });

const TITLE = 'Connect Ring';
const NOT_IN_PROGRESS = '<p>This page opens from the Ring app while you connect the camera connector. No Ring connection is in progress for this address: start again from the Ring app.</p>';
const CLOSED = '<p>Connecting is closed right now. Ask your administrator to open it from the connector setup, then start again from the Ring app.</p>';

function createLink(ctx) {
  const { store, api } = ctx;
  const log = (...a) => { try { (ctx.log || (() => {}))(...a); } catch { /* logging never breaks a request */ } };
  const now = () => (ctx.now ? ctx.now() : Date.now());
  const settings = () => { try { return (typeof ctx.settings === 'function' ? ctx.settings() : ctx.settings) || {}; } catch { return {}; } };
  const base = () => api.API || DEFAULT_API;

  const quiet = new Map();
  function logEvery(key, ms, ...a) { const t = quiet.get(key) || 0; if (!t || now() - t > ms) { quiet.set(key, now() || 1); log(...a); } }

  const buckets = new Map();
  function rateOk(name, max, windowMs) {   // least-recently-used keys fall out first: memory and time per call stay bounded
    const t = now();
    const b = (buckets.get(name) || []).filter((x) => t - x < windowMs);
    const okay = b.length < max;
    if (okay) b.push(t);
    buckets.delete(name);
    buckets.set(name, b);
    while (buckets.size > BUCKET_MAX) buckets.delete(buckets.keys().next().value);
    return okay;
  }

  function bodyOf(req, max) {
    let raw;
    try { raw = Buffer.from(String(req.body || ''), 'base64'); } catch { return null; }
    return raw.length > max ? null : raw;
  }

  // ── the armed one-time code ──
  const linkArm = () => store.linkArm.get();
  function armLink(opts = {}) {
    const a = store.linkArm.arm({ minutes: Math.floor(Number(opts.minutes)) || 30, replace: !!opts.replace });
    log(`link page open for ${a.minutes} minutes${a.replace ? ' (may replace the linked Ring account)' : ''}`);
    return { code: a.code, expiresAt: Date.parse(a.expires_at), minutes: a.minutes, replace: a.replace };
  }
  function linkState() {
    const a = linkArm();
    return a ? { armed: true, expiresAt: a.expiresAt, tries: a.tries || 0, replace: !!a.replace } : { armed: false };
  }

  // ── the token exchange (called by the camera service) ──
  async function receiveToken(req) {
    const ip = clean(req.ip || '?', 64);
    if (!rateOk(`any:${ip}`, 60, 60000)) return plain(429, 'Too many requests\n');
    const raw = bodyOf(req, MAX_FORM_BODY);
    if (raw === null) return plain(413, 'Too large\n');
    const c = api.credentials();
    if (!c) { log('token exchange refused: no credentials yet'); return plain(503, 'Not ready\n'); }
    const form = new URLSearchParams(raw.toString('utf8'));
    const code = form.get('code') || '';
    if (!code || code.length > 2048 || !/^[\x21-\x7e]+$/.test(code) || !safeEqualStr(form.get('client_id') || '', c.client_id)) {
      logEvery('tokbad', 60000, 'token exchange refused: no code or a different client id');
      return plain(400, 'Bad request\n');
    }
    // Only requests with the right client id count here, per source: junk from one place can't starve the camera service's call.
    if (!rateOk(`token:${ip}`, RATE_PER_MIN, 60000)) return plain(429, 'Too many requests\n');
    try {
      const pair = await api.exchangeCode(code, { timeoutMs: RING_CALL_MS });
      const me = await api.userMe(pair.access_token, { timeoutMs: RING_CALL_MS });
      store.savePending(me.id, pair, maskEmail(me.email));   // fresh tokens for a linked account too: keep the newest
      log('token exchange done: tokens for Ring account', shortId(me.id), 'wait for the link page');
      return plain(200, '{"ok":true}\n', 'application/json');
    } catch (e) {
      log('token exchange failed:', clean(e && e.message, 80));
      return plain(502, 'Exchange failed\n');
    }
  }

  // ── the link page ──
  function linkCheck(req, nonce, time) {
    const ip = clean(req.ip || '?', 64);
    if (!rateOk(`any:${ip}`, 60, 60000)) return { status: 429, html: '<p class="err">Too many requests. Wait a minute.</p>' };
    if (!validNonce(nonce) || !validTime(time)) return { status: 400, html: NOT_IN_PROGRESS };
    const stale = freshness(time, now());
    if (stale) return { status: 400, html: `<p class="err">${esc(stale)}</p>` };
    const c = api.credentials();
    const m = c && matchNonce(api.keyCandidates(), store.pending(), time, nonce, now());
    if (!m) return { status: 400, html: NOT_IN_PROGRESS };
    if (!linkArm()) return { status: 403, html: CLOSED };
    return { c, m };
  }
  function linkPage(req) {
    const q = new URLSearchParams(String(req.query || ''));
    const nonce = q.get('nonce') || '', time = q.get('time') || '';
    const k = linkCheck(req, nonce, time);
    if (k.status) return html(k.status, TITLE, k.html);
    const who = k.m.pair.email_masked ? `the Ring account <b>${esc(k.m.pair.email_masked)}</b>` : 'your Ring account';
    return html(200, TITLE, `<p>This connects ${who} to the camera connector. If that is not your Ring account, close this page.</p><p>Sign in with the one-time code shown in the connector setup.</p>
<form method="post" action="link" autocomplete="off"><input type="hidden" name="nonce" value="${esc(nonce)}"><input type="hidden" name="time" value="${esc(time)}">
<label for="code">One-time code</label><input id="code" name="code" required maxlength="20" autofocus><button type="submit">Sign in and connect</button></form>`);
  }
  async function linkSubmit(req) {
    const raw = bodyOf(req, MAX_FORM_BODY);
    if (raw === null) return plain(413, 'Too large\n');
    const form = new URLSearchParams(raw.toString('utf8'));
    const nonce = form.get('nonce') || '', time = form.get('time') || '';
    const k = linkCheck(req, nonce, time);   // a code is only ever checked for a genuine Ring redirect
    if (k.status) return html(k.status, TITLE, k.html);
    return api.withLock('link:global', () => claimLink(form, nonce, k.c, k.m));   // one claim at a time: two can't both pass the checks
  }
  async function claimLink(form, nonce, c, m) {
    const started = now();
    const arm = linkArm();
    if (!arm) return html(403, TITLE, CLOSED);
    const identifier = maskEmail(settings().account_email);
    if (!identifier) return html(409, TITLE, '<p class="err">The connector has no account email in its settings yet. Ask your administrator to add it, then start again from the Ring app.</p>');
    if (!rateOk('code', 20, 60000)) return html(429, TITLE, '<p class="err">Too many tries. Wait a minute.</p>');
    if (!store.linkArm.matches(form.get('code'), arm)) {
      const w = store.linkArm.wrong();   // the fifth wrong code deletes the armed record
      if (w.closed) return html(403, TITLE, '<p class="err">Too many wrong codes. Connecting is closed; ask your administrator for a new code.</p>');
      log('link page: wrong code', `(try ${w.tries})`);
      return html(401, TITLE, '<p class="err">That code is not right. Check it and try again.</p>');
    }
    const current = store.linkedAccount();
    if (current && current !== m.id && !arm.replace) {
      log('link refused: a different Ring account', shortId(m.id), 'would replace the linked', shortId(current));
      return html(409, TITLE, '<p class="err">The camera connector is already connected to a different Ring account. Ask your administrator to allow replacing it, then start again from the Ring app.</p>');
    }
    if (m.enc !== store.keyEncoding()) { try { api.rememberKeyEncoding(m.enc); } catch (e) { log('could not remember the key encoding:', e.code || e.message); } }
    const { email_masked: emailMasked, ...pair } = m.pair;
    let adopt;
    try {
      const hdr = { Authorization: `Bearer ${pair.access_token}`, 'Content-Type': 'application/json' };
      const url = `${base()}/v1/accounts/me/app-integrations`;
      const p1 = await api.ringFetch(url, { method: 'POST', headers: hdr, body: JSON.stringify({ account_identifier: identifier, nonce }), timeoutMs: RING_CALL_MS });
      await p1.arrayBuffer().catch(() => {});
      if (!p1.ok) throw new Error(`confirming the link answered ${p1.status}`);
      const p2 = await api.ringFetch(url, { method: 'PATCH', headers: hdr, body: JSON.stringify({ status: 'completed' }), timeoutMs: RING_CALL_MS });
      await p2.arrayBuffer().catch(() => {});
      if (!p2.ok) throw new Error(`completing the link answered ${p2.status}`);
      // The confirmed pair becomes the sign-in: the account record is saved at once, the refresh token goes to the hub.
      adopt = Promise.resolve().then(() => api.adoptPair(m.id, pair, { account_identifier: identifier, ring_email_masked: emailMasked || null }));
    } catch (e) {
      log('link failed:', clean(e && e.message, 80));
      return html(502, TITLE, '<p class="err">Ring did not accept the connection. Start again from the Ring app, or ask your administrator.</p>');
    }
    // If the hub is slow the page does not wait for it: the api part keeps the pair in memory and retries.
    const left = Math.max(1000, DEADLINE_MS - (now() - started));
    let timer;
    const saved = await Promise.race([adopt.catch((e) => { log('link: could not adopt the sign-in:', clean(e && e.message, 60)); return false; }), new Promise((res) => { timer = setTimeout(() => res(false), left); })]);
    clearTimeout(timer);
    if (store.linkedAccount() !== m.id) return html(502, TITLE, '<p class="err">The connection could not be saved. Start again from the Ring app, or ask your administrator.</p>');
    if (!saved) log('link: the new refresh token is not saved yet; it is kept in memory and retried');
    const mine = store.pending()[m.id];
    if (mine && mine.access_token === pair.access_token) store.takePending(m.id);   // keep a newer exchange
    store.linkArm.clear(arm.id);   // never a code armed meanwhile
    log('Ring account', shortId(m.id), 'linked; the link page is closed again');
    Promise.resolve().then(() => api.refreshDevicesOnce()).catch((e) => log('device list failed:', clean(e && e.message, 60)));
    return html(200, 'Ring is connected', '<p>The camera connector will now get your camera events. You can close this page.</p>');
  }

  async function handle(request) {
    const req = request || {};
    const method = String(req.method || '').toUpperCase();
    const p = String(req.path || '');
    try {
      if (p === 'token') return method === 'POST' ? await receiveToken(req) : plain(404, 'Not found\n');
      if (p === 'link') {
        if (method === 'GET' || method === 'HEAD') return linkPage(req);
        if (method === 'POST') return await linkSubmit(req);
        return plain(404, 'Not found\n');
      }
      if (p === 'done') return method === 'GET' || method === 'HEAD' ? html(200, 'Connect Ring', '<p>This step is finished. You can close this page and go back to the connector setup.</p>') : plain(404, 'Not found\n');
    } catch (e) {
      log('link request failed:', clean(e && e.message, 80));
      return plain(500, 'Error\n');
    }
    return plain(404, 'Not found\n');
  }

  return { handle, armLink, linkState };
}

module.exports = {
  createLink, computeNonce, matchNonce, freshness, maskEmail, normCode, validNonce, validTime, esc, clean, shortId, safeEqualStr,
  MAX_FORM_BODY, LINK_WINDOW_S, CLOCK_SKEW_S, LINK_MAX_TRIES, PENDING_TOKEN_KEEP_MS, RATE_PER_MIN, RING_CALL_MS, DEADLINE_MS, PAGE_CSP,
};
