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

const CRED_FILE = (env = process.env) => path.join(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || '', '.claude'), '.credentials.json');
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

function readFileToken(env) {
  try {
    const p = CRED_FILE(env);
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
function currentClientToken(env) {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return env.CLAUDE_CODE_OAUTH_TOKEN;
  // A custom configuration may have a different keychain item. Only use an
  // unambiguously associated credential for catalog discovery.
  return readFileToken(env) || (process.platform === 'darwin' && !env.CLAUDE_CONFIG_DIR ? readKeychainToken() : null);
}

function getOauthToken(env) {
  if (env) return currentClientToken(env);
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
const SIGN_IN_FAILURE_RE = /please run \/login|invalid api key|not logged in|log ?in again|oauth token (has )?expired|authentication[_ ]error|token (has )?expired|credentials? (are |is )?(missing|invalid|expired)|unauthori[sz]ed|failed to authenticate|reached its time limit|cannot be renewed|could not be refreshed|claude auth login|setup-token|login expired|authentication required|sign in again/i;
/** Only the Claude client's own sentences about being signed out (no generic words like "unauthorized" or "invalid API key",
 *  which other providers and MCP servers use too). */
const CLAUDE_SIGNIN_RE = /failed to authenticate|please run \/login|claude auth login|oauth session expired|could not be refreshed|login reached its time limit|this login reached its time limit|login expired|not logged in · please run|authentication required · sign in again|your claude\.ai login expired|oauth token (has )?expired|authentication[_ ]error/i;
const SIGN_IN_HELP = '\n\n⚠ **Claude is signed out on the computer that runs your Maestro**, so your agents on Claude can\'t answer. An admin can sign in again: on that computer, open a terminal and type `mymaestro connect claude`, then follow the steps. After that, send your message again. No restart is needed.';
/** True when a Claude turn failed because the client is signed out: the SDK marked the message 'authentication_failed', or its text says so in the client's own words. */
function isSignInFailure(text, sdkError) {
  return sdkError === 'authentication_failed' || CLAUDE_SIGNIN_RE.test(String(text || ''));
}
function signInFixText(text) {
  if (!isSignInFailure(text)) return '';
  return SIGN_IN_HELP;
}
/** The client's sentence made safe to keep and show: no link, no e-mail address, no long token; whitespace collapsed; max 300. */
function sanitizeSignInDetail(raw) {
  return String(raw == null ? '' : raw)
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\S+@\S+\.\S+/g, '')
    .replace(/[A-Za-z0-9_\-.=]{24,}/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, 300);
}
/** Forget the cached token (right after a new sign-in). */
function clearTokenCache() { _tokenCache = null; _tokenCacheTime = 0; }

/** Signed in: the token the Claude client uses exists (the sign-in file, or the macOS Keychain). Having the `claude`
 *  program, or the desktop app's folder, is not enough (hasSdkCredentials counts those too). */
function hasSignIn() { return !!getOauthToken(); }

module.exports = { getOauthToken, hasSdkCredentials, hasSignIn, credentialSource, signInFixText, SIGN_IN_FAILURE_RE, CLAUDE_SIGNIN_RE, SIGN_IN_HELP, isSignInFailure, sanitizeSignInDetail, clearTokenCache };
