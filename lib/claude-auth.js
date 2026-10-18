'use strict';

/**
 * claude-auth.js — Single source of truth for Claude Code SDK credentials.
 *
 * Where the OAuth token lives depends on the platform:
 *   Linux/WSL : ~/.claude/.credentials.json
 *   macOS     : the login Keychain, item "Claude Code-credentials"
 *
 * This used to be reimplemented in three places, each checking a different
 * subset. The Linux-only variants worked fine on Linux and silently reported
 * "no credentials" on macOS, so Mac installs showed every Claude model as
 * unavailable. Everything that needs to know about SDK auth calls in here.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CRED_FILE = () => path.join(process.env.HOME || '', '.claude', '.credentials.json');
const MAC_APP_DIR = () => path.join(process.env.HOME || '', 'Library', 'Application Support', 'Claude');

// Reading the Keychain shells out, so cache it briefly. Discovery and the
// health endpoint both ask within the same request cycle.
let _tokenCache = null;
let _tokenCacheTime = 0;
const TOKEN_TTL = 60_000;

function readKeychainToken() {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execSync('security find-generic-password -s "Claude Code-credentials" -w',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return JSON.parse(out)?.claudeAiOauth?.accessToken || null;
  } catch {
    // Non-interactive processes can be denied by the Keychain ACL. Not fatal:
    // the SDK has its own access, so only token-based calls are affected.
    return null;
  }
}

function readFileToken() {
  try {
    const p = CRED_FILE();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'))?.claudeAiOauth?.accessToken || null;
  } catch {
    return null;
  }
}

/**
 * The OAuth access token, or null. Used to call Anthropic HTTP endpoints
 * (notably GET /v1/models) without an API key.
 */
function getOauthToken() {
  const now = Date.now();
  if (_tokenCache && (now - _tokenCacheTime) < TOKEN_TTL) return _tokenCache;

  const token = readFileToken() || readKeychainToken();
  if (token) {
    _tokenCache = token;
    _tokenCacheTime = now;
  }
  return token;
}

/**
 * Whether this machine can talk to Claude via the SDK.
 *
 * Deliberately broader than getOauthToken(): the SDK authenticates itself and
 * can work even when we cannot read the token directly (macOS may refuse
 * Keychain reads from a background process). Reporting "no credentials" in
 * that case would wrongly grey out every Claude model.
 */
function hasSdkCredentials() {
  if (fs.existsSync(CRED_FILE())) return true;
  if (getOauthToken()) return true;
  if (fs.existsSync(MAC_APP_DIR())) return true;
  try {
    execSync('which claude', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** For diagnostics: which source produced the token. */
function credentialSource() {
  if (readFileToken()) return `file (${CRED_FILE()})`;
  if (readKeychainToken()) return 'macOS Keychain';
  if (fs.existsSync(MAC_APP_DIR())) return 'Claude app directory (token not readable)';
  try {
    const p = execSync('which claude', { encoding: 'utf8', timeout: 5000 }).trim();
    return `claude CLI at ${p} (token not readable)`;
  } catch {
    return 'none';
  }
}

/**
 * When a Claude turn failed because the client on this computer is not signed in, or its sign-in expired, the fix in
 * plain words for the chat; '' for any other failure.
 */
const SIGN_IN_FAILURE_RE = /please run \/login|invalid api key|not logged in|log ?in again|oauth token (has )?expired|authentication[_ ]error|token (has )?expired|credentials? (are |is )?(missing|invalid|expired)|unauthori[sz]ed/i;
function signInFixText(text) {
  if (!SIGN_IN_FAILURE_RE.test(String(text || ''))) return '';
  return '\n\n⚠️ **Claude isn\'t signed in on this computer, or the sign-in has expired.** To fix it: open a terminal on the computer running My Maestro AI, type `claude` and press Enter, sign in, then type `/exit`. Then send your message again. No restart is needed.';
}

/** Signed in: the token the Claude client uses exists (the sign-in file, or the macOS Keychain). Having the `claude`
 *  program, or the desktop app's folder, is not enough (hasSdkCredentials counts those too). */
function hasSignIn() { return !!getOauthToken(); }

module.exports = { getOauthToken, hasSdkCredentials, hasSignIn, credentialSource, signInFixText, SIGN_IN_FAILURE_RE };
