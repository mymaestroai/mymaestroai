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
  if (process.env.GMAIL_OAUTH_CLIENT_ID) {
    return {
      client_id: process.env.GMAIL_OAUTH_CLIENT_ID,
      client_secret: process.env.GMAIL_OAUTH_CLIENT_SECRET || '',
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

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start' : 'xdg-open';
  execFile(cmd, [url], () => {});
}

let lastAuthUrl = null;

function runAuthFlow(client, onUrl) {
  if (authInProgress) return authInProgress;
  authInProgress = new Promise((resolve, reject) => {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');

    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${CALLBACK_PORT}`);
      if (!u.pathname.startsWith('/callback')) { res.writeHead(404); res.end(); return; }
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      const gotState = u.searchParams.get('state');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body style="font-family:system-ui;padding:40px">
        <h2>${code ? 'Gmail write access granted ✅' : 'Authorization failed ❌'}</h2>
        <p>${code ? 'You can close this tab and return to My Maestro AI.' : (err || 'no code returned')}</p>
      </body></html>`);
      server.close();
      if (!code) { authInProgress = null; return reject(new Error(err || 'no auth code')); }
      if (gotState !== state) { authInProgress = null; return reject(new Error('state mismatch')); }
      try {
        const { status, json } = await postForm('oauth2.googleapis.com', '/token', {
          client_id: client.client_id,
          client_secret: client.client_secret,
          code,
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: REDIRECT_URI,
        });
        if (status !== 200 || !json.access_token) {
          throw new Error(`token exchange failed (${status}): ${json.error_description || json.error || ''}`);
        }
        const tok = {
          access_token: json.access_token,
          refresh_token: json.refresh_token,
          token_type: json.token_type || 'Bearer',
          scope: json.scope,
          expiry_date: Date.now() + (json.expires_in || 3600) * 1000,
        };
        saveToken(tok);
        authInProgress = null;
        resolve(tok);
      } catch (e) { authInProgress = null; reject(e); }
    });

    server.on('error', (e) => { authInProgress = null; reject(e); });
    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      const params = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
      lastAuthUrl = authUrl;
      if (typeof onUrl === 'function') { try { onUrl(authUrl); } catch { /* noop */ } }
      console.log('[gmail-oauth] Open this URL to grant gmail.modify:\n' + authUrl);
      openBrowser(authUrl);
    });

    setTimeout(() => {
      try { server.close(); } catch { /* noop */ }
      if (authInProgress) { authInProgress = null; reject(new Error('auth timed out after 15m')); }
    }, 900000);
  });
  return authInProgress;
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
  if (!interactive) throw new Error('No Gmail write token.  Run gmail_auth first.');
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

module.exports = { getAccessToken, gmailApi, status, getAuthUrl, TOKEN_PATH, SCOPES };
