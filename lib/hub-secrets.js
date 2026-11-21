'use strict';
/**
 * Secret values from the hub's .env file are kept here, in memory, and never placed in process.env: every child process
 * the hub starts (agents' clients, jobs, helpers that copy process.env) would otherwise carry them in its start
 * environment, readable through /proc/<pid>/environ by any process of the same user.
 * Values that were already in the launch environment are left where they are (out of scope here).
 */
const fs = require('fs');
const { SECRET_RE } = require('./child-env');

const NOT_SECRET = new Set(['HUB_AUTH_DIR', 'SSH_AUTH_SOCK', 'XAUTHORITY', 'GPG_AGENT_INFO']);   // matched by the pattern, but not secrets
const store = new Map();

function isSecretName(name) {
  const n = String(name || '');
  if (NOT_SECRET.has(n)) return false;
  return SECRET_RE.test(n) || n.startsWith('HUB_WALLET_');
}

/** Read a .env file the way server.js always did. Secret names go to the private store, the rest into env. */
function loadEnvFile(file, { env = process.env } = {}) {
  const out = { loaded: [], secret: [] };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (!m) continue;
    const name = m[1], value = m[2].trim();
    if (isSecretName(name)) {
      // .env wins over a launch-time value of the same name, as it always did (get() reads the store first). The launch-time
      // value itself is left in the process environment: this module only keeps .env values out of it.
      store.set(name, value);
      if (!out.secret.includes(name)) out.secret.push(name);
    } else {
      env[name] = value;
      if (!out.loaded.includes(name)) out.loaded.push(name);
    }
  }
  return out;
}

function get(name) {
  if (store.has(name)) return store.get(name);
  return process.env[name];
}
function has(name) { return store.has(name); }
function names() { return [...store.keys()]; }

/** A NEW object with the process environment and the stored secrets, for code that takes an env object to read from.
 *  Never pass this to a child process: that would put the secrets back into its start environment. */
function envView() { return { ...process.env, ...Object.fromEntries(store) }; }

function _resetForTests() { store.clear(); }

module.exports = { isSecretName, loadEnvFile, get, has, names, envView, _resetForTests };
