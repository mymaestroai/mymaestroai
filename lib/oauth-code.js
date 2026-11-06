'use strict';
// OAuth 2.0 authorization-code flow (with PKCE, RFC 7636) for services that send the person back to the hub:
//   authorizeUrl()  the address to send the person to
//   pkce()          a fresh code verifier and its S256 challenge
//   exchange()      trades the returned code for tokens
//   refresh()       trades the lasting refresh token for a new access token (the service may rotate the refresh token)
// Same safety rules as lib/oauth-device: https only, no redirects, a time limit, a capped reply, only known OAuth error
// codes echoed. Messages thrown here never contain tokens, codes, verifiers or client secrets.

const crypto = require('crypto');

const MAX_BODY = 64 * 1024;
const USER_AGENT = 'MyMaestroAI';

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function checkUrl(raw, allowInsecureLocal, code) {
  let u;
  try { u = new URL(String(raw)); } catch { throw fail(code, 'The address is not a valid web address.'); }
  if (u.protocol === 'https:') return u;
  if (allowInsecureLocal && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return u;
  throw fail(code, 'The address must start with https://.');
}

function isRedirectError(e) {
  const m = String((e && e.message) || '') + String((e && e.cause && e.cause.message) || '');
  return /redirect/i.test(m);
}

async function readCapped(res) {
  const tooLarge = () => fail('EBADRESPONSE', 'The sign-in service sent a reply that was too large.');
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const t = await res.text();
    if (typeof t !== 'string' || Buffer.byteLength(t) > MAX_BODY) throw tooLarge();
    return t;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) { try { await reader.cancel(); } catch { /* already closing */ } throw tooLarge(); }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function post(url, form, { fetch: fetchFn = globalThis.fetch, timeoutMs = 15000, allowInsecureLocal = false } = {}) {
  const target = checkUrl(url, allowInsecureLocal, 'EBADURL').toString();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let status, text;
  try {
    const res = await fetchFn(target, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: new URLSearchParams(form).toString(),
      signal: ac.signal,
      redirect: 'error',   // a redirect must never resend the form (it carries the client secret and codes)
    });
    status = res.status;
    text = await readCapped(res);
  } catch (e) {
    if (e && e.code === 'EBADRESPONSE') throw e;
    if (isRedirectError(e)) throw fail('EREDIRECT', 'The sign-in service tried to redirect the request, so it was stopped.');
    if (ac.signal.aborted || (e && e.name === 'AbortError')) throw fail('ETIMEDOUT', 'The sign-in service took too long to answer.');
    throw fail('ENETWORK', "Couldn't reach the sign-in service.");
  } finally {
    clearTimeout(timer);
  }
  let json;
  try { json = JSON.parse(text); } catch { throw fail('EBADRESPONSE', 'The sign-in service sent a reply that could not be read.'); }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw fail('EBADRESPONSE', 'The sign-in service sent a reply that could not be read.');
  return { status, json };
}

const KNOWN_OAUTH_ERRORS = new Set(['access_denied', 'invalid_request', 'invalid_client', 'invalid_grant', 'invalid_scope', 'unauthorized_client', 'unsupported_grant_type', 'unsupported_response_type', 'server_error', 'temporarily_unavailable', 'org_internal', 'admin_policy_enforced', 'disabled_client']);

/** The error from the service as a plain Error: only codes from the OAuth vocabulary are echoed. invalid_grant is EREVOKED. */
function oauthError(errCode) {
  if (errCode === 'invalid_grant') return fail('EREVOKED', 'The sign-in was revoked or has expired. Sign in again.');
  if (typeof errCode !== 'string' || !KNOWN_OAUTH_ERRORS.has(errCode)) return fail('EOAUTH', 'The sign-in was refused by the service.');
  if (errCode === 'invalid_client') return fail('EOAUTH', 'The sign-in was refused (invalid_client): the client ID or secret is wrong.');
  return fail('EOAUTH', `The sign-in was refused (${errCode}).`);
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A code verifier (43 unreserved characters) and its S256 challenge. */
function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}

function authorizeUrl({ authorizeUrl: base, clientId, redirectUri, scopes, state, codeChallenge, allowInsecureLocal = false } = {}) {
  const u = checkUrl(base, allowInsecureLocal, 'EBADURL');
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', String(clientId || ''));
  u.searchParams.set('redirect_uri', String(redirectUri || ''));
  u.searchParams.set('scope', [].concat(scopes || []).join(' '));
  u.searchParams.set('state', String(state || ''));
  if (codeChallenge) { u.searchParams.set('code_challenge', codeChallenge); u.searchParams.set('code_challenge_method', 'S256'); }
  return u.toString();
}

function expiryOf(json, now) {
  const s = Number.isFinite(json.expires_in) && json.expires_in > 0 ? json.expires_in : 3600;
  return now() + s * 1000;
}

function tokensOf(json, now, status) {
  if (json.error) throw oauthError(json.error);
  if (!(status >= 200 && status < 300)) throw fail('EOAUTH', `The sign-in service refused the request (${status}).`);
  if (typeof json.access_token !== 'string' || !json.access_token) throw fail('EBADRESPONSE', 'The sign-in service did not return an access token.');
  const out = { accessToken: json.access_token, expiresAt: expiryOf(json, now) };
  if (typeof json.refresh_token === 'string' && json.refresh_token) out.refreshToken = json.refresh_token;
  return out;
}

async function exchange({ tokenUrl, clientId, clientSecret, code, redirectUri, codeVerifier, fetch, timeoutMs, allowInsecureLocal, now = Date.now } = {}) {
  const form = { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret };
  if (codeVerifier) form.code_verifier = codeVerifier;
  const { status, json } = await post(tokenUrl, form, { fetch, timeoutMs, allowInsecureLocal });
  return tokensOf(json, now, status);
}

async function refresh({ tokenUrl, clientId, clientSecret, refreshToken, fetch, timeoutMs, allowInsecureLocal, now = Date.now } = {}) {
  const { status, json } = await post(tokenUrl, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }, { fetch, timeoutMs, allowInsecureLocal });
  return tokensOf(json, now, status);
}

module.exports = { authorizeUrl, pkce, exchange, refresh, MAX_BODY };
