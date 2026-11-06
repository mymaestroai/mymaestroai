'use strict';
// A small Oura API v2 client. Fetch and clock are injectable so tests need no network. Messages thrown here never
// contain tokens or the client secret. Oura refresh tokens are single use: every refresh returns a new one, which is
// used from then on and handed to onRotate so the hub can save it.

const API = 'https://api.ouraring.com';
const TOKEN_URL = 'https://api.ouraring.com/oauth/token';
const USER_AGENT = 'MyMaestroAI-Oura/1.0';
const MAX_BODY = 4 * 1024 * 1024;
const MAX_TOKEN_BODY = 64 * 1024;
const MAX_PAGES = 10;
const TIMEOUT_MS = 15000;
const EXPIRED = 'The Oura sign-in has expired or was removed. Sign in again in Data connectors.';
const TOO_LARGE = 'Oura sent a reply that was too large.';

function fail(message) { return new Error(message); }

function checkUrl(raw, allowInsecureLocal) {
  let u;
  try { u = new URL(String(raw)); } catch { throw fail('The Oura address is not valid.'); }
  if (u.protocol === 'https:') return u;
  if (allowInsecureLocal && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return u;
  throw fail('The Oura address must start with https://.');
}

// Read the body in pieces and stop as soon as it passes `max` bytes.
async function readCapped(res, max) {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const t = await res.text();
    if (typeof t !== 'string' || Buffer.byteLength(t) > max) throw fail(TOO_LARGE);
    return t;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { try { await reader.cancel(); } catch { /* closing */ } throw fail(TOO_LARGE); }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// One request with a timeout, no redirects and a capped body. Returns { status, text }.
async function request(url, opts, { fetch, timeoutMs, max }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal, redirect: 'error' });
    return { status: res.status, text: await readCapped(res, max) };
  } catch (e) {
    if (e && e.message === TOO_LARGE) throw e;
    const why = `${(e && e.message) || ''} ${(e && e.cause && e.cause.message) || ''}`;
    if (ac.signal.aborted || (e && e.name === 'AbortError')) throw fail('Oura took too long to answer.');
    if (/redirect/i.test(why)) throw fail('Oura tried to redirect the request, so it was stopped.');
    throw fail("Couldn't reach Oura.");
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text) {
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch { /* fall through */ }
  throw fail('Oura sent a reply that could not be read.');
}

function createOura({ clientId, clientSecret, refreshToken, fetch = globalThis.fetch, now = Date.now, onRotate,
  baseUrl = API, tokenUrl = TOKEN_URL, timeoutMs = TIMEOUT_MS, allowInsecureLocal = false } = {}) {
  let cached = null;      // { token, expiresAt }
  let pending = null;
  let refreshTok = refreshToken;
  const base = checkUrl(baseUrl, allowInsecureLocal);
  const tokenTarget = checkUrl(tokenUrl, allowInsecureLocal).toString();

  async function refreshNow() {
    if (!clientId || !clientSecret) throw fail('The Oura client ID and secret are not set.');
    if (!refreshTok) throw fail('Not signed in to Oura yet. Sign in first in Data connectors.');
    const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshTok, client_id: clientId, client_secret: clientSecret });
    const { status, text } = await request(tokenTarget, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: form.toString(),
    }, { fetch, timeoutMs, max: MAX_TOKEN_BODY });
    let json = null;
    try { json = JSON.parse(text); } catch { /* handled below */ }
    const code = json && typeof json.error === 'string' ? json.error : '';
    if (code === 'invalid_grant') throw fail(EXPIRED);
    if (code === 'invalid_client') throw fail('Oura refused the client ID or secret (invalid_client). Check them in Data connectors.');
    if (status < 200 || status >= 300 || code) throw fail(`Oura refused the sign-in (${status}). Sign in again in Data connectors.`);
    if (!json || typeof json !== 'object' || typeof json.access_token !== 'string' || !json.access_token) throw fail('Oura did not return an access token.');
    const secs = Number.isFinite(json.expires_in) && json.expires_in > 0 ? json.expires_in : 86400;
    cached = { token: json.access_token, expiresAt: now() + secs * 1000 };
    if (typeof json.refresh_token === 'string' && json.refresh_token) {
      refreshTok = json.refresh_token;
      if (typeof onRotate === 'function') onRotate(json.refresh_token);
    }
    return cached.token;
  }

  async function token() {
    if (cached && now() < cached.expiresAt - 60 * 1000) return cached.token;
    if (!pending) pending = refreshNow().finally(() => { pending = null; });
    return pending;
  }

  function httpError(status) {
    if (status === 429) return fail("Oura's limit of 5,000 requests in 5 minutes was reached. Try again in a few minutes.");
    if (status === 401) return fail('Oura refused the request: the sign-in may have expired. Sign in again in Data connectors.');
    if (status === 403) return fail('Oura refused the request: the sign-in may have expired, this permission may not have been approved, or this data may need an Oura Membership.');
    if (status === 404) return fail('Oura could not find that data.');
    return fail(`Oura answered ${status}.`);
  }

  async function page(url, retry = true) {
    const tok = await token();
    const r = await request(url, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${tok}`, 'User-Agent': USER_AGENT } }, { fetch, timeoutMs, max: MAX_BODY });
    if (r.status === 401 && retry) { cached = null; return page(url, false); }
    if (r.status < 200 || r.status >= 300) throw httpError(r.status);
    return parseJson(r.text);
  }

  // GET base + path with query params; follows next_token for up to MAX_PAGES pages. Returns the combined data list.
  async function get(path, params = {}) {
    if (typeof path !== 'string' || !/^\/v2\/[A-Za-z0-9_/]+$/.test(path)) throw fail('That Oura path is not allowed.');
    const data = [];
    let next = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const u = new URL(path, base);
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
      if (next) u.searchParams.set('next_token', next);
      const body = await page(u.toString());
      if (Array.isArray(body.data)) data.push(...body.data);
      next = typeof body.next_token === 'string' && body.next_token ? body.next_token : null;
      if (!next) break;
    }
    return data;
  }

  return { token, get };
}

module.exports = { createOura, USER_AGENT, EXPIRED, MAX_PAGES };
