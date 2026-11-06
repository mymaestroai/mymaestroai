'use strict';
// OAuth 2.0 device authorization flow (RFC 8628), as Google uses it for "TVs and Limited Input devices" clients:
// the person sees a short code and approves it at a web address on any phone or computer.
//   start()   asks for a code to show the person
//   poll()    asks whether they have approved it yet
//   refresh() trades the lasting refresh token for a new access token
// Messages thrown here never contain tokens, codes or client secrets.

const MAX_BODY = 64 * 1024;
const GRANT_DEVICE = 'urn:ietf:params:oauth:grant-type:device_code';

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function checkUrl(raw, allowInsecureLocal, code) {
  let u;
  try { u = new URL(String(raw)); } catch { throw fail(code, 'The address is not a valid web address.'); }
  if (u.protocol === 'https:') return u.toString();
  if (allowInsecureLocal && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return u.toString();
  throw fail(code, 'The address must start with https://.');
}

function isRedirectError(e) {
  const m = String((e && e.message) || '') + String((e && e.cause && e.cause.message) || '');
  return /redirect/i.test(m);
}

// Read the body in pieces and stop (cancel the stream) as soon as it passes MAX_BODY bytes.
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

// POST a form, return { status, json }. Only the parsed JSON leaves this function.
async function post(url, form, { fetch: fetchFn = globalThis.fetch, timeoutMs = 15000, allowInsecureLocal = false } = {}) {
  const target = checkUrl(url, allowInsecureLocal, 'EBADURL');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let status, text;
  try {
    const res = await fetchFn(target, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
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
  if (typeof text !== 'string' || text.length > MAX_BODY) throw fail('EBADRESPONSE', 'The sign-in service sent a reply that was too large.');
  let json;
  try { json = JSON.parse(text); } catch { throw fail('EBADRESPONSE', 'The sign-in service sent a reply that could not be read.'); }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw fail('EBADRESPONSE', 'The sign-in service sent a reply that could not be read.');
  return { status, json };
}

const KNOWN_OAUTH_ERRORS = new Set(['authorization_pending', 'slow_down', 'access_denied', 'expired_token', 'invalid_request', 'invalid_client', 'invalid_grant', 'invalid_scope', 'unauthorized_client', 'unsupported_grant_type', 'org_internal', 'admin_policy_enforced', 'disabled_client']);

function oauthError(errCode) {
  // Only codes from the OAuth vocabulary are echoed; anything else is the service's own text and stays out of messages.
  if (typeof errCode !== 'string' || !KNOWN_OAUTH_ERRORS.has(errCode)) return fail('EOAUTH', 'The sign-in was refused by the service.');
  const name = errCode;
  if (name === 'invalid_client') return fail('EOAUTH', 'The sign-in was refused (invalid_client): the client ID or secret is wrong.');
  return fail('EOAUTH', `The sign-in was refused (${name}).`);
}

async function start({ deviceUrl, clientId, scopes, fetch, timeoutMs, allowInsecureLocal, now = Date.now } = {}) {
  const { json } = await post(deviceUrl, { client_id: clientId, scope: [].concat(scopes || []).join(' ') }, { fetch, timeoutMs, allowInsecureLocal });
  if (json.error) throw oauthError(json.error);
  const deviceCode = json.device_code;
  const userCode = json.user_code;
  const url = json.verification_url || json.verification_uri;
  if (typeof deviceCode !== 'string' || !deviceCode) throw fail('EBADRESPONSE', 'The sign-in service did not return a device code.');
  if (typeof userCode !== 'string' || !/^[\x20-\x7e]{4,32}$/.test(userCode)) throw fail('EBADRESPONSE', 'The sign-in service returned a code that cannot be shown.');
  if (typeof url !== 'string') throw fail('EBADRESPONSE', 'The sign-in service did not return a web address to approve at.');
  const verificationUrl = checkUrl(url, allowInsecureLocal, 'EBADRESPONSE');
  const interval = json.interval === undefined || json.interval === null ? 5 : json.interval;
  if (!Number.isInteger(interval) || interval < 1 || interval > 60) throw fail('EBADRESPONSE', 'The sign-in service returned an unusable polling interval.');
  const exp = json.expires_in;
  if (!Number.isInteger(exp) || exp < 60 || exp > 3600) throw fail('EBADRESPONSE', 'The sign-in service returned an unusable expiry time.');
  return { deviceCode, userCode, verificationUrl, intervalSec: interval, expiresAt: now() + exp * 1000 };
}

function expiryOf(json, now) {
  const s = Number.isFinite(json.expires_in) && json.expires_in > 0 ? json.expires_in : 3600;
  return now() + s * 1000;
}

async function poll({ tokenUrl, clientId, clientSecret, deviceCode, fetch, timeoutMs, allowInsecureLocal, now = Date.now } = {}) {
  const { json } = await post(tokenUrl, { client_id: clientId, client_secret: clientSecret, device_code: deviceCode, grant_type: GRANT_DEVICE }, { fetch, timeoutMs, allowInsecureLocal });
  if (json.error) {
    switch (json.error) {
      case 'authorization_pending': return { status: 'pending' };
      case 'slow_down': return { status: 'slow_down' };
      case 'access_denied': return { status: 'denied' };
      case 'expired_token': return { status: 'expired' };
      default: throw oauthError(json.error);
    }
  }
  if (typeof json.access_token !== 'string' || !json.access_token) throw fail('EBADRESPONSE', 'The sign-in service did not return an access token.');
  if (typeof json.refresh_token !== 'string' || !json.refresh_token) throw fail('ENOREFRESH', "Google didn't return a lasting sign-in. Try again and approve the request.");
  return { status: 'ok', tokens: { refreshToken: json.refresh_token, accessToken: json.access_token, expiresAt: expiryOf(json, now), scope: typeof json.scope === 'string' ? json.scope : '' } };
}

async function refresh({ tokenUrl, clientId, clientSecret, refreshToken, fetch, timeoutMs, allowInsecureLocal, now = Date.now } = {}) {
  const { json } = await post(tokenUrl, { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }, { fetch, timeoutMs, allowInsecureLocal });
  if (json.error) {
    if (json.error === 'invalid_grant') throw fail('EREVOKED', 'The sign-in was revoked or has expired. Sign in again.');
    throw oauthError(json.error);
  }
  if (typeof json.access_token !== 'string' || !json.access_token) throw fail('EBADRESPONSE', 'The sign-in service did not return an access token.');
  const out = { accessToken: json.access_token, expiresAt: expiryOf(json, now) };
  if (typeof json.refresh_token === 'string' && json.refresh_token) out.refreshToken = json.refresh_token;
  return out;
}

module.exports = { start, poll, refresh, MAX_BODY, GRANT_DEVICE };
