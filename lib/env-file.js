'use strict';
// The hub's startup file (.env, in the install folder): which of its settings the Settings page may show and change.
//
//   ENV_WRITABLE   the allow-list: the only keys write() will touch (each is validated by validate())
//   ENV_READONLY   shown with their value and where to change them; the page never writes them
//   ENV_DANGER     protections (sign-in, who may reach the install, wallet, safety rules): shown read-only, secrets as set / not set
//   validate(key, raw)   { ok, value } | { ok: false, error }: the per-key rule ('' is always fine: it removes the line)
//   read({ file })       rows [{ key, value, set, secret, writable, readonly, danger, running, pending, help }]; a secret has value null
//   write(key, value, { file })   { ok, key, before, after, changed } | { ok: false, error }
//
// A value changed here is read once, at start: the row says what the running hub uses (`running`, taken from process.env the first
// time this file is loaded, which server.js does right after it reads .env) and whether the file now says something else (`pending`).
// write() changes ONE line and keeps every other byte of the file: comments, blank lines, line endings (LF or CRLF), an
// "export " prefix, quoting of the other lines and the file's permissions. The new file is written beside the old one (mode kept,
// 0600 for a new file) and renamed over it. Keys that look like secrets, and anything not in ENV_WRITABLE, are refused; the values of
// other lines are never read into a message or a log line.
const fs = require('fs');
const path = require('path');
const hubSecrets = require('./hub-secrets');
const { isSecretName } = hubSecrets;

const ENV_WRITABLE = [
  'HUB_TZ', 'HUB_WORKER_DEFAULT_SCOPE', 'HUB_SECURITY_CHECK_HOURS', 'HUB_UPDATE_CHECK_HOURS', 'HUB_UPDATE_CHECK_FIRST_SECONDS',
  'HUB_COMMS_DISABLED', 'HUB_MEMORY_HEALTH', 'HUB_SELFCHECK', 'HUB_CONSULT_BUSY_WAIT_MS', 'HUB_DELIVERY_COOLDOWN_MS',
  'HUB_PUSH_SUBJECT', 'HUB_CODEX_TRANSPORT', 'MM_VOICE_NO_AUTO_INSTALL', 'HUB_SDK_AUTO_COMPACT_WINDOW',
];
const ENV_READONLY = [
  'PORT', 'HUB_HOME', 'CLAUDE_SDK_PATH', 'CLAUDE_CLI_PATH', 'CODEX_CLI_PATH', 'LLM_GATEWAY_URL', 'GATEWAY_PROMPT_CACHE',
  'GATEWAY_MAX_CONNECTIONS', 'GATEWAY_KEEPALIVE', 'GATEWAY_NETWATCH', 'HUB_STABLE_BRANCH',
];
// The environment half of the 16 protected options (the other five are settings.json keys: toolPolicy, teamTemplates, walletAgents,
// walletOwner, receiverAliases).
const ENV_DANGER = [
  'HUB_BIND_HOST', 'HUB_ALLOWED_HOSTS', 'HUB_TAILNET_USERS', 'HUB_AUTH_USERNAME', 'HUB_AUTH_PASSWORD', 'HUB_REQUIRE_LOGIN',
  'HUB_AGENT_PERMISSION_MODE', 'HUB_KEEP_ENV_KEYS', 'HUB_WALLET_OWNER', 'HUB_CODEX_APPROVALS', 'HUB_CODEX_SANDBOX',
];
const KNOWN = [...ENV_WRITABLE, ...ENV_READONLY, ...ENV_DANGER];
const DEFAULT_FILE = path.join(__dirname, '..', '.env');

// What the running hub started with (process.env, captured once; a secret is only ever "set" or not).
// A row hides its value when the name looks like a secret, except these: a sign-in name, a yes/no and a public address are shown.
const SHOWN_DESPITE_NAME = new Set(['HUB_AUTH_USERNAME', 'HUB_KEEP_ENV_KEYS', 'HUB_WALLET_OWNER']);
const isSecretRow = (key) => isSecretName(key) && !SHOWN_DESPITE_NAME.has(key);
// (lib/hub-secrets keeps the .env values of secret-looking names out of process.env: get() reads both)
const RUNNING = {};
for (const k of KNOWN) { const v = hubSecrets.get(k); RUNNING[k] = isSecretRow(k) ? (v ? '(set)' : undefined) : v; }

// ── The rule for each writable key ────────────────────────────────────────────────────────────────────
const int = (lo, hi, unit) => (s) => (/^\d{1,9}$/.test(s) && Number(s) >= lo && Number(s) <= hi ? { value: String(Number(s)) } : { error: `must be a whole number from ${lo} to ${hi}${unit ? ' ' + unit : ''}` });
const oneOf = (list) => (s) => (list.includes(s) ? { value: s } : { error: `must be ${list.map((x) => `"${x}"`).join(' or ')}` });
const RULES = {
  HUB_TZ: (s) => {
    if (s.length > 64 || !/^[A-Za-z0-9_+\-\/]+$/.test(s)) return { error: 'must be a time zone name such as America/New_York or UTC' };
    try { new Intl.DateTimeFormat('en-US', { timeZone: s }); } catch { return { error: `"${s}" is not a time zone this computer knows` }; }
    return { value: s };
  },
  HUB_WORKER_DEFAULT_SCOPE: oneOf(['read', 'full', 'none']),
  HUB_SECURITY_CHECK_HOURS: int(1, 8760, 'hours'),
  HUB_UPDATE_CHECK_HOURS: int(1, 8760, 'hours'),
  HUB_UPDATE_CHECK_FIRST_SECONDS: int(1, 86400, 'seconds'),
  HUB_COMMS_DISABLED: oneOf(['1']),
  HUB_MEMORY_HEALTH: oneOf(['off']),
  HUB_SELFCHECK: oneOf(['off']),
  HUB_CONSULT_BUSY_WAIT_MS: int(1000, 600000, 'milliseconds'),
  HUB_DELIVERY_COOLDOWN_MS: int(1000, 3600000, 'milliseconds'),
  HUB_PUSH_SUBJECT: (s) => (s.length <= 200 && (/^mailto:[^\s@:\/]+@[^\s@:\/]+\.[^\s@:\/]+$/.test(s) || /^https:\/\/[^\s\/]+(\/\S*)?$/.test(s)) ? { value: s } : { error: 'must be a mailto: address or an https:// address' }),
  HUB_CODEX_TRANSPORT: oneOf(['exec', 'app-server']),
  MM_VOICE_NO_AUTO_INSTALL: oneOf(['1']),
  HUB_SDK_AUTO_COMPACT_WINDOW: int(10000, 2000000, 'tokens'),
};
const HELP = {
  HUB_COMMS_DISABLED: 'Set to 1 to switch the messaging channels off. Leave it empty for the default (on).',
  HUB_MEMORY_HEALTH: 'Set to off to stop the memory health check. Leave it empty for the default (on).',
  HUB_SELFCHECK: 'Set to off to stop the self-check. Leave it empty for the default (on).',
  MM_VOICE_NO_AUTO_INSTALL: 'Set to 1 to stop voice from installing its parts by itself. Leave it empty for the default (it installs).',
};

const isWritable = (key) => ENV_WRITABLE.includes(key);
const isKnown = (key) => KNOWN.includes(key);

/** { ok: true, value } (value '' means "remove the line") or { ok: false, error }. Never throws. */
function validate(key, raw) {
  if (typeof key !== 'string' || !isWritable(key)) return { ok: false, error: `${String(key).slice(0, 60)} is not a setting that can be changed here` };
  if (raw === undefined || raw === null) return { ok: true, value: '' };
  if (typeof raw === 'number') { if (!Number.isFinite(raw)) return { ok: false, error: `${key}: must be a whole number` }; raw = String(raw); }
  if (typeof raw !== 'string') return { ok: false, error: `${key}: the value must be text` };
  const s = raw.trim();
  if (s === '') return { ok: true, value: '' };
  if (/[\x00-\x1f\x7f\s"'`\\$#]/.test(s)) return { ok: false, error: `${key}: the value cannot hold spaces, quotes, backslashes, $ or #` };
  const r = RULES[key](s);
  return r.error ? { ok: false, error: `${key}: ${r.error}` } : { ok: true, value: r.value };
}

// ── Reading and writing one file ──────────────────────────────────────────────────────────────────────
// A line is  [export ]KEY=value  at the start of the line, as lib/hub-secrets loadEnvFile reads it (the value is what follows the "=", trimmed).
const LINE = /^(export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; } }
/** The value the hub would load for each key in this text (the last line of a key wins, as loadEnvFile does). */
function valuesOf(text) {
  const out = new Map();
  if (!text) return out;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const m = LINE.exec(line);
    if (m) out.set(m[2], m[3].trim());
  }
  return out;
}

/** Rows for the page. A secret's value is null and `set` says whether it has one; nothing here ever returns a secret. */
function read({ file = DEFAULT_FILE } = {}) {
  let text = null, readError = null;
  try { text = readText(file); } catch (e) { readError = e && e.code ? e.code : 'unreadable'; }
  const vals = valuesOf(text);
  const rows = [];
  for (const key of KNOWN) {
    const secret = isSecretRow(key);
    const fileValue = vals.has(key) ? vals.get(key) : null;
    const runningValue = RUNNING[key] === undefined ? null : RUNNING[key];
    const row = { key, secret, writable: isWritable(key), readonly: ENV_READONLY.includes(key), danger: ENV_DANGER.includes(key) };
    if (secret) {
      row.value = null;
      row.set = (fileValue !== null && fileValue !== '') || runningValue !== null;
      row.running = null;
      row.pending = false;
    } else {
      row.value = fileValue === null || fileValue === '' ? null : fileValue;
      row.set = row.value !== null;
      row.running = runningValue === '' ? null : runningValue;
      row.pending = (row.value === null ? null : row.value) !== (row.running === null ? null : row.running);
    }
    if (HELP[key]) row.help = HELP[key];
    rows.push(row);
  }
  return readError ? { rows, error: `The startup file could not be read (${readError}).` } : { rows };
}

/** Changes one line of the startup file. key must be in ENV_WRITABLE and the value valid; '' removes the key's line(s). */
function write(key, value, { file = DEFAULT_FILE } = {}) {
  if (typeof key !== 'string' || isSecretName(key)) return { ok: false, error: 'That one holds a secret, so it is never changed here.' };
  const v = validate(key, value);
  if (!v.ok) return v;
  let target = file, text;
  try { target = fs.realpathSync(file); } catch { target = file; }
  try { text = readText(target); } catch (e) { return { ok: false, error: `The startup file could not be read (${(e && e.code) || 'unreadable'}).` }; }
  const before = valuesOf(text).has(key) ? valuesOf(text).get(key) : null;
  const beforeValue = before === '' ? null : before;
  const wanted = v.value === '' ? null : v.value;
  if (beforeValue === wanted && (wanted !== null || before === null)) return { ok: true, key, before: beforeValue, after: wanted, changed: false };

  const src = text === null ? '' : text;
  const crlf = /\r\n/.test(src) && !/(^|[^\r])\n/.test(src);   // every line break is CRLF: new lines use it
  const eol = crlf ? '\r\n' : '\n';
  const parts = src.split('\n');   // the pieces keep their own "\r"; the last piece is what follows the final line break ('' when the file ends with one)
  let last = -1;
  for (let i = 0; i < parts.length; i++) { const p = parts[i].endsWith('\r') ? parts[i].slice(0, -1) : parts[i]; const m = LINE.exec(p); if (m && m[2] === key) last = i; }
  let out;
  if (wanted === null) {
    out = parts.filter((p) => { const q = p.endsWith('\r') ? p.slice(0, -1) : p; const m = LINE.exec(q); return !(m && m[2] === key); });
  } else if (last >= 0) {
    out = parts.slice();
    const had = parts[last].endsWith('\r');
    const m = LINE.exec(had ? parts[last].slice(0, -1) : parts[last]);
    out[last] = `${m[1] || ''}${key}=${wanted}${had ? '\r' : ''}`;
  } else {
    out = parts.slice();
    // append after the last line: an unterminated last line first gets its line break
    if (out.length && out[out.length - 1] === '') out.pop(); else if (out.length && src !== '') out[out.length - 1] += eol === '\r\n' ? '\r' : '';
    out.push(`${key}=${wanted}${crlf ? '\r' : ''}`, '');
  }
  const data = out.join('\n');

  // temp file beside the original (same folder, so the rename stays on one volume), same mode, then rename over it
  let mode = 0o600;
  try { mode = fs.statSync(target).mode & 0o7777; } catch { /* a new file stays private */ }
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}-${Date.now().toString(36)}`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeSync(fd, data);
    try { fs.fchmodSync(fd, mode); } catch { /* a filesystem without modes */ }
    try { fs.fsyncSync(fd); } catch { /* best effort */ }
    fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, target);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return { ok: false, error: `The startup file could not be written (${(e && e.code) || 'error'}). Nothing was changed.` };
  }
  return { ok: true, key, before: beforeValue, after: wanted, changed: true };
}

module.exports = { ENV_WRITABLE, ENV_READONLY, ENV_DANGER, KNOWN, validate, read, write, isWritable, isKnown, valuesOf, DEFAULT_FILE };
