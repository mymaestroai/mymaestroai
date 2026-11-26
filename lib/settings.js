'use strict';

/**
 * settings.js — Single source of truth for all Hub configuration.
 *
 * Provider keys and URLs live here, not scattered across process.env reads.
 * Precedence: settings.json > process.env > built-in defaults.
 *
 * The file is data/settings.json (gitignored). Changes via updateSettings()
 * take effect immediately — no restart needed for key/URL changes.
 */

const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '..', 'data', 'settings.json');

const PROVIDER_DEFAULTS = {
  anthropic: { url: 'https://api.anthropic.com' },
  openai:    { url: 'https://api.openai.com/v1' },
  google:    { url: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  perplexity:{ url: 'https://api.perplexity.ai' },
  // OpenRouter: one key for hundreds of models from many vendors (lib/openrouter: catalogue, offer, privacy).
  openrouter:{ url: 'https://openrouter.ai/api/v1' },
  // ElevenLabs: speech only (lib/voice/cloud). A key, no chat models; the key is saved in Settings -> providers like the others.
  elevenlabs:{ url: 'https://api.elevenlabs.io/v1' },
  lmstudio:  { url: 'http://localhost:1234/v1' },
  ollama:    { url: 'http://localhost:11434/v1' },
  // oMLX — MLX inference server for Apple Silicon. Harmless on non-Macs:
  // discovery simply fails to connect and the provider stays empty.
  omlx:      { url: 'http://localhost:8000/v1' },
  // NInfer — single-GPU CUDA engine (RTX 5090, NVFP4), OpenAI-compatible. Empty when not running.
  ninfer:    { url: 'http://127.0.0.1:8080/v1' },
  // Local models — the hub's own llama-swap proxy (lib/local-models): one scheduler for every local engine.
  local:     { url: 'http://127.0.0.1:18080/v1' },
};

// .env secrets live in lib/hub-secrets, not process.env. Some tests copy this file alone into a temp folder, so fall back
// to process.env when the sibling module is not there.
function secretEnv(name) {
  try { return require('./hub-secrets').get(name); } catch { return process.env[name]; }
}
function envViewSafe() {
  try { return require('./hub-secrets').envView(); } catch { return process.env; }
}

const ENV_KEY_MAP = {
  anthropic:  'ANTHROPIC_API_KEY',
  openai:     'OPENAI_API_KEY',
  google:     'GEMINI_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
};

const ENV_URL_MAP = {
  lmstudio: 'LM_STUDIO_URL',
  ollama:   'OLLAMA_URL',
  omlx:     'OMLX_URL',
  ninfer:   'NINFER_URL',
  local:    'LOCAL_MODELS_URL',
};

let _settings = null;
// mtime of the file as last read or written. The owner edits data/settings.json by hand for settings the UI
// does not offer (walletAgents, walletOwner, teamTemplates); without this check the running hub kept its
// startup copy and its next save wrote that copy back over the hand edit.
// The stamp (mtimeMs:size:ino) of the file as last read or written by this process. A write by this process leaves the stamp
// it made, so a different stamp on the next read means someone else wrote the file (lib/settings-journal journals that as "outside").
let _stamp = null;
let _last = null;   // a copy of the last state the hub loaded or saved: the "before" of the next change
function fileStamp() { try { const s = fs.statSync(SETTINGS_FILE); return `${s.mtimeMs}:${s.size}:${s.ino}`; } catch { return null; } }
const copy = (o) => JSON.parse(JSON.stringify(o));

// The journal is a sibling module; a few tests copy this file alone into a temp folder, and there it is simply absent.
function journalLib() {
  try { return require('./settings-journal'); } catch (e) { if (e && e.code === 'MODULE_NOT_FOUND' && /settings-journal/.test(String(e.message))) return null; throw e; }
}
function normalise(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) o = {};
  if (!o.providers || typeof o.providers !== 'object') o.providers = {};
  return o;
}

function load() {
  const st = fileStamp();   // taken before the read: a file replaced meanwhile only costs a re-read
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (e) {
    // A half-written or broken file while the owner edits it: keep what we have rather than wiping it.
    if (_settings && fs.existsSync(SETTINGS_FILE)) {
      _stamp = st;
      console.warn('[settings] data/settings.json is not valid JSON, keeping the loaded settings:', e.message);
      const j = journalLib(); if (j) j.noteOutsideInvalid('data/settings.json');
      return _settings;
    }
    _settings = {};
    parsed = null;
  }
  const prev = _last;
  _settings = normalise(parsed === null ? _settings : parsed);
  _stamp = st;
  _last = copy(_settings);
  // The file changed under the running hub and this process did not write it: journal what changed (never throws).
  if (prev && parsed !== null) {
    const j = journalLib();
    if (j && !j.isMarked('settings', st)) j.noteOutside('settings', 'data/settings.json', j.diff(prev, _last, '', 3));
  }
  return _settings;
}

// Journals the change (old copy -> new state) BEFORE writing; when the journal cannot be written nothing is written and the
// in-memory state goes back, so the caller sees a plain error. The write is temp file + rename (never a half file), mode 0600.
function save() {
  const j = journalLib();
  const prev = _last || {};
  if (j) {
    try { j.recordChange('settings', j.diff(prev, _settings, '', 3)); }
    catch (e) {
      for (const k of Object.keys(_settings)) delete _settings[k];
      Object.assign(_settings, copy(prev));
      throw new Error(`Nothing was changed: the change journal could not be written (${e.message}).`);
    }
  }
  const dir = path.dirname(SETTINGS_FILE);
  const tmp = path.join(dir, `.settings.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Provider keys live in here: owner-only on disk (review F44/H07).
    fs.writeFileSync(tmp, JSON.stringify(_settings, null, 2), { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* filesystem without modes */ }
    const t = fs.statSync(tmp);   // a rename keeps inode, size and mtime: this is the stamp of settings.json after it
    fs.renameSync(tmp, SETTINGS_FILE);
    _stamp = `${t.mtimeMs}:${t.size}:${t.ino}`;
    _last = copy(_settings);
    if (j) j.afterWrite('settings', _stamp);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* not made */ }
    console.error('[settings] Save error:', e.message);
  }
}

function get() {
  if (!_settings) load();
  else {
    const st = fileStamp();
    if (st !== null && st !== _stamp) {
      const before = _stamp;
      load();
      if (_stamp !== before) { console.log('[settings] data/settings.json changed on disk; reloaded'); applyGlobals(); }
    }
  }
  return _settings;
}

// A value by its dotted path ("voice.enabled"); undefined when it is not there.
function getPath(key) {
  let v = get();
  for (const part of String(key).split('.')) { if (v && typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, part)) v = v[part]; else return undefined; }
  return v;
}
// Sets (or, with remove, deletes) one value by its dotted path and saves through the journal. Used by Restore.
function setPath(key, value, { remove = false } = {}) {
  const s = get();
  const parts = String(key).split('.');
  if (parts.some((p) => BAD_KEYS.includes(p))) throw new Error('bad settings key');
  let o = s;
  for (const p of parts.slice(0, -1)) { if (!o[p] || typeof o[p] !== 'object' || Array.isArray(o[p])) o[p] = {}; o = o[p]; }
  const last = parts[parts.length - 1];
  if (remove) delete o[last]; else o[last] = value;
  save();
  applyGlobals();
}

// ── Provider Accessors ────────────────────────────────────────────────────

function getProviderKey(provider) {
  const s = get();
  const fromSettings = s.providers?.[provider]?.apiKey;
  if (fromSettings) return fromSettings;
  const envVar = ENV_KEY_MAP[provider];
  if (envVar) return secretEnv(envVar) || '';
  return '';
}

function getProviderUrl(provider) {
  if (provider === 'local') { try { return require('./local-models').getLocalModels().baseUrl(); } catch {} }   // port lives in data/local-models.json
  const s = get();
  const fromSettings = s.providers?.[provider]?.url;
  if (fromSettings) return fromSettings;
  const envVar = ENV_URL_MAP[provider];
  if (envVar && process.env[envVar]) return process.env[envVar];
  return PROVIDER_DEFAULTS[provider]?.url || '';
}

function hasAnyApiKey() {
  return !!(getProviderKey('anthropic') || getProviderKey('openai') ||
            getProviderKey('google') || getProviderKey('perplexity') || getProviderKey('openrouter'));
}

// Where a provider's key comes from: 'settings' (saved here), 'environment' (.env or the process environment), or ''.
function keySource(provider) {
  const s = get();
  if (s.providers?.[provider]?.apiKey) return 'settings';
  const envVar = ENV_KEY_MAP[provider];
  return envVar && secretEnv(envVar) ? 'environment' : '';
}

// ── Keys still in .env ────────────────────────────────────────────────────
// Keys belong in one place: this file (data/settings.json, owner-only), where the Welcome page and Settings save
// them. Older installs typed some into .env, so at startup the hub moves every provider or web-search key it finds in
// the .env FILE into settings: it saves the key here first and checks that it reached the disk, keeps a copy of the
// old .env (.env.bak-<time>, owner-only), then turns each moved line into a comment. Keys the environment provides
// from elsewhere (a service file, Docker) are left alone. HUB_KEEP_ENV_KEYS=1 keeps keys in .env.
const SEARCH_ENV_KEY_MAP = { brave: 'BRAVE_SEARCH_API_KEY', serper: 'SERPER_API_KEY', tavily: 'TAVILY_API_KEY' };   // the names lib/web-search.js reads

function readDisk() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return null; }
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function adoptEnvFileKeys({ envFile, env = null, now = new Date() } = {}) {
  if (!env) env = envViewSafe();   // HUB_KEEP_ENV_KEYS is held in the secret store (its name contains KEY)
  const out = { moved: [], duplicates: [], unused: [], backup: null, kept: false, error: null };
  if (!envFile) return out;
  let text;
  try { text = fs.readFileSync(envFile, 'utf8'); } catch { return out; }
  const byVar = {};
  for (const [id, name] of Object.entries(ENV_KEY_MAP)) byVar[name] = { kind: 'provider', id };
  for (const [id, name] of Object.entries(SEARCH_ENV_KEY_MAP)) byVar[name] = { kind: 'search', id };
  const lines = text.split('\n');
  const found = {};   // var name -> { kind, id, raw (as server.js loaded it), value (saved), lines: [] }; the last line wins
  lines.forEach((line, i) => {
    const m = line.match(/^([A-Z_]+)=(.*)$/);   // the same rule server.js uses to load .env (export and CRLF lines never load)
    if (!m || !byVar[m[1]]) return;
    const raw = m[2].trim();
    // A key written as OPENAI_API_KEY="sk-…" reached the hub with its quotes; Settings keeps the key itself.
    const value = raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw[raw.length - 1] === raw[0] ? raw.slice(1, -1).trim() : raw;
    const f = found[m[1]] || (found[m[1]] = { ...byVar[m[1]], raw: '', value: '', lines: [] });
    f.lines.push(i);
    f.raw = raw;
    f.value = value;
  });
  const names = Object.keys(found).filter(n => found[n].value);
  if (!names.length) return out;
  if (/^(1|true|yes|on)$/i.test(String(env.HUB_KEEP_ENV_KEYS || '').trim())) { out.kept = true; return out; }

  const s = get();
  const providers = {};
  let webSearch = null;
  for (const name of names) {
    const f = found[name];
    const current = f.kind === 'provider' ? s.providers?.[f.id]?.apiKey : s.webSearch?.keys?.[f.id];
    if (!current) {
      out.moved.push(name);
      if (f.kind === 'provider') providers[f.id] = { apiKey: f.value };
      else {
        webSearch = webSearch || { ...(s.webSearch || {}), keys: { ...((s.webSearch && s.webSearch.keys) || {}) } };
        webSearch.keys[f.id] = f.value;
      }
    } else if (current === f.value) out.duplicates.push(name);
    else out.unused.push(name);
  }
  if (out.moved.length) {
    const patch = {};
    if (Object.keys(providers).length) patch.providers = providers;
    if (webSearch) patch.webSearch = webSearch;
    const jl = journalLib();
    if (jl) jl.withActor({ kind: 'hub', why: 'start-up' }, () => updateSettings(patch)); else updateSettings(patch);
    const d = readDisk();
    const saved = (name) => {
      const f = found[name];
      return !!d && (f.kind === 'provider' ? d.providers?.[f.id]?.apiKey : d.webSearch?.keys?.[f.id]) === f.value;
    };
    const lost = out.moved.filter(n => !saved(n));
    if (lost.length) {
      out.error = `${lost.join(', ')} could not be saved in data/settings.json, so .env was left as it was`;
      return out;
    }
  }

  // Keep a copy of the old .env, then rewrite it with each handled line turned into a comment.
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  let backup = `${envFile}.bak-${stamp(now)}`;
  for (let n = 2; fs.existsSync(backup); n++) backup = `${envFile}.bak-${stamp(now)}-${n}`;
  try {
    fs.writeFileSync(backup, text, { mode: 0o600, flag: 'wx' });
    const where = (f) => (f.kind === 'provider' ? 'Settings → AI models → LLM Providers' : 'Settings → Tools and data → Web search');
    for (const name of names) {
      const f = found[name];
      const note = out.unused.includes(name)
        ? `# ${name} removed from here on ${day}: Settings has a different key for this, and that is the one in use. The old line is in ${path.basename(backup)}.`
        : `# ${name} is kept in Settings (data/settings.json) since ${day}; change it in ${where(f)}.`;
      f.lines.forEach((i, k) => { lines[i] = k === f.lines.length - 1 ? note : `# (an earlier ${name} line was here)`; });
    }
    const tmp = `${envFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, lines.join('\n'), { mode: 0o600 });   // .env still holds other secrets: owner-only, whatever it was before
    fs.renameSync(tmp, envFile);
  } catch (e) {
    out.error = `.env could not be rewritten (${e.message}); the keys are in Settings and win over .env`;
    return out;
  }
  out.backup = backup;
  // The running hub loaded these from .env at startup: drop them so programs it starts do not inherit them.
  for (const name of names) if (env[name] === found[name].raw || env[name] === found[name].value) delete env[name];
  return out;
}

// ── General Settings ──────────────────────────────────────────────────────

function getSetting(key, defaultValue) {
  const s = get();
  return s[key] !== undefined ? s[key] : defaultValue;
}

// ── Update ────────────────────────────────────────────────────────────────

// Keys that would reach into an object's prototype instead of setting a value (a JSON body can carry "__proto__").
const BAD_KEYS = ['__proto__', 'constructor', 'prototype'];
function cleanPatch(patch, depth = 0) {
  if (!patch || typeof patch !== 'object') return depth ? patch : {};
  for (const k of BAD_KEYS) if (Object.prototype.hasOwnProperty.call(patch, k)) delete patch[k];
  if (depth < 32) for (const v of Object.values(patch)) if (v && typeof v === 'object') cleanPatch(v, depth + 1);   // at every depth
  return patch;
}
function updateSettings(patch) {
  const s = get();
  patch = cleanPatch(patch);

  if (patch.providers) {
    if (!s.providers) s.providers = {};
    for (const [provider, conf] of Object.entries(patch.providers)) {
      if (conf === null) { delete s.providers[provider]; continue; }   // null clears that provider's saved key/url
      if (typeof conf !== 'object') continue;
      if (!s.providers[provider]) s.providers[provider] = {};
      if (conf.apiKey !== undefined) s.providers[provider].apiKey = conf.apiKey;
      if (conf.url !== undefined) s.providers[provider].url = conf.url;
    }
    delete patch.providers;
  }

  Object.assign(s, patch);
  save();

  applyGlobals();
}

// ── Globals (legacy bridge) ───────────────────────────────────────────────
// Some modules still read global.__cavemanMode etc. Keep them in sync.

function applyGlobals() {
  const s = get();
  global.__cavemanMode = !!s.cavemanMode;
  global.__prescanToolsEnabled = !!s.prescanTools;
  global.__confirmToolsEnabled = !!s.confirmTools;
  global.__lazyToolsEnabled = s.lazyTools !== false;
  global.__maxCompletionTokens = s.maxCompletionTokens || 32000;
  global.__maxContextMessages = s.maxContextMessages || 40;
}

// ── Sanitized view for the UI (masks keys) ────────────────────────────────

function getForUI() {
  const s = get();
  const result = { ...s, providers: {} };
  // Sidebar sections that are off until switched on (Settings): always present, false by default.
  result.sidebarTigerTeam = s.sidebarTigerTeam === true;
  result.sidebarGuide = s.sidebarGuide === true;
  result.sidebarTeams = s.sidebarTeams !== false;   // the Teams tab: on unless an admin switches it off

  for (const provider of Object.keys(PROVIDER_DEFAULTS)) {
    const key = getProviderKey(provider);
    const url = getProviderUrl(provider);
    result.providers[provider] = {
      hasKey: !!key,
      keyHint: key ? maskKey(key) : '',
      keySource: key ? keySource(provider) : '',
      url,
      defaultUrl: PROVIDER_DEFAULTS[provider]?.url || '',
    };
  }
  // Web search backend keys (settings.webSearch.keys) are secrets too: the UI sees hints only.
  if (s.webSearch && s.webSearch.keys && typeof s.webSearch.keys === 'object') {
    const keys = {};
    for (const [k, v] of Object.entries(s.webSearch.keys)) keys[k] = v ? maskKey(String(v)) : '';
    result.webSearch = { ...s.webSearch, keys };
  }

  return result;
}

function maskKey(key) {
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

// ── Init ──────────────────────────────────────────────────────────────────

load();
applyGlobals();

const s = get();
const keyStatus = Object.keys(ENV_KEY_MAP).map(p =>
  `${p}=${getProviderKey(p) ? 'yes' : 'no'}`
).join(', ');
console.log(`[settings] Provider keys: ${keyStatus}`);

module.exports = { cleanPatch,
  get,
  getSetting,
  getProviderKey,
  getProviderUrl,
  hasAnyApiKey,
  keySource,
  adoptEnvFileKeys,
  getForUI,
  updateSettings,
  getPath,
  setPath,
  PROVIDER_DEFAULTS,
  ENV_KEY_MAP,
  SEARCH_ENV_KEY_MAP,
};
