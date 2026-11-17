'use strict';
// Environments for child processes an agent controls (its Bash, its client CLI, its jobs, skill servers).
// Built from an allow-list so hub secrets (provider keys, GITHUB_TOKEN, HUB_* values, SSH/GPG agent sockets and
// anything else from the hub's .env) never reach them. The lead agent keeps the full environment.

const BASE_KEEP = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_*', 'TERM', 'TZ', 'COLUMNS', 'LINES', 'PORT'];

const HOST_KEEP = [
  'TMPDIR', 'TMP', 'TEMP', 'XDG_*', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'LANGUAGE', 'COLORTERM',
  'NO_COLOR', 'FORCE_COLOR', 'EDITOR', 'VISUAL', 'PAGER',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO',
  'npm_config_*', 'NVM_DIR', 'NVM_BIN',
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE',
  'HOMEPATH', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'PUBLIC',
  'ALLUSERSPROFILE', '__CF_USER_TEXT_ENCODING',
];

const CLIENT_KEEP = {
  claude: ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN'],
  codex: ['CODEX_HOME'],
};

// The Docker endpoint a boxed agent's job wrapper needs on the host (`docker exec`); never forwarded into the container.
const DOCKER_KEEP = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY'];

// userinfo in a URL authority (scheme://user:pass@host): such a value is a credential even under a harmless name.
const URL_CREDS_RE = /[a-z][a-z0-9+.-]*:\/\/[^\/\s@]*@/i;

const SECRET_RE = /(KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH)/i;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ENV_MAX = 32;

/** Does `name` match one of `patterns` ('FOO' exact, 'FOO_*' prefix)? Wildcards never let a secret-looking name through. */
function matcher(patterns, { windows = process.platform === 'win32' } = {}) {
  const norm = (s) => (windows ? String(s).toLowerCase() : String(s));
  const exact = new Set(), prefixes = [];
  for (const p of patterns) {
    if (p.endsWith('*')) prefixes.push(norm(p.slice(0, -1)));
    else exact.add(norm(p));
  }
  return (name) => {
    const n = norm(name);
    if (exact.has(n)) return true;
    if (SECRET_RE.test(name)) return false;
    return prefixes.some(pre => n.startsWith(pre));
  };
}

function cleanEnvKeep(raw) {
  if (raw === null || raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'envKeep must be a list of environment variable names' };
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, error: 'envKeep holds names only' };
    const name = item.trim();
    if (!ENV_NAME_RE.test(name)) return { ok: false, error: `"${name.slice(0, 40)}" is not a valid environment variable name (letters, digits and _, not starting with a digit, up to 64 characters)` };
    if (!out.includes(name)) out.push(name);
  }
  if (out.length > ENV_MAX) return { ok: false, error: `envKeep may list at most ${ENV_MAX} names` };
  return { ok: true, value: out };
}

function envKeepOf(agent) {
  try {
    const r = cleanEnvKeep(agent && agent.envKeep);
    return r.ok ? r.value : [];
  } catch { return []; }
}

/** A new plain object: only the names of `base` on the allow-lists (or listed exactly in `keep`), then `set` on top. */
function buildChildEnv(base, { keep = [], set = {}, platform = process.platform } = {}) {
  const windows = platform === 'win32';
  const allowed = matcher([...BASE_KEEP, ...HOST_KEEP], { windows });
  const extra = new Set((Array.isArray(keep) ? keep : []).map(k => (windows ? String(k).toLowerCase() : String(k))));
  const out = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (v === undefined) continue;
    if (extra.has(windows ? k.toLowerCase() : k)) { out[k] = v; continue; }
    if (allowed(k) && !(typeof v === 'string' && URL_CREDS_RE.test(v))) out[k] = v;
  }
  for (const [k, v] of Object.entries(set || {})) if (v !== undefined) out[k] = v;
  return out;
}

function envForAgent(agent, { base = process.env, client = null, set = {}, agents = null, isLead = null } = {}) {
  let lead = false;
  try { lead = typeof isLead === 'function' ? !!isLead(agent, agents) : !!(agent && agent.lead === true); } catch { lead = false; }
  if (lead) return { ...base, ...set };
  return buildChildEnv(base, { keep: [...(CLIENT_KEEP[client] || []), ...envKeepOf(agent)], set });
}

/** isLead function for envForAgent: the hub's own lead rule (flagged leads, or the legacy default). False on any error. */
function leadCheck() {
  return (agent) => {
    try {
      const ag = require('./agents');
      // Only admin-owned (or ownerless) flagged leads keep the full environment.
      return !!(agent && agent.name && ag.ownerLeadNames(ag.getAgentsSync()).includes(agent.name));
    } catch { return false; }
  };
}

module.exports = { DOCKER_KEEP, URL_CREDS_RE, BASE_KEEP, HOST_KEEP, CLIENT_KEEP, SECRET_RE, ENV_NAME_RE, ENV_MAX, matcher, cleanEnvKeep, envKeepOf, buildChildEnv, envForAgent, leadCheck };
