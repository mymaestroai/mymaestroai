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

const ENV_KEY_MAP = {
  anthropic:  'ANTHROPIC_API_KEY',
  openai:     'OPENAI_API_KEY',
  google:     'GEMINI_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
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
let _mtimeMs = null;
function fileMtime() { try { return fs.statSync(SETTINGS_FILE).mtimeMs; } catch { return null; } }

function load() {
  try {
    _settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    _mtimeMs = fileMtime();
  } catch (e) {
    // A half-written or broken file while the owner edits it: keep what we have rather than wiping it.
    if (_settings && fs.existsSync(SETTINGS_FILE)) { _mtimeMs = fileMtime(); console.warn('[settings] data/settings.json is not valid JSON, keeping the loaded settings:', e.message); return _settings; }
    _settings = {};
  }
  if (!_settings || typeof _settings !== 'object' || Array.isArray(_settings)) _settings = {};
  if (!_settings.providers || typeof _settings.providers !== 'object') _settings.providers = {};
  return _settings;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    // Provider keys live in here: owner-only on disk (review F44/H07).
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(_settings, null, 2), { mode: 0o600 });
    try { fs.chmodSync(SETTINGS_FILE, 0o600); } catch { /* filesystem without modes */ }
    _mtimeMs = fileMtime();
  } catch (e) {
    console.error('[settings] Save error:', e.message);
  }
}

function get() {
  if (!_settings) load();
  else {
    const m = fileMtime();
    if (m !== null && m !== _mtimeMs) {
      const before = _mtimeMs;
      load();
      if (_mtimeMs !== before) { console.log('[settings] data/settings.json changed on disk; reloaded'); applyGlobals(); }
    }
  }
  return _settings;
}

// ── Provider Accessors ────────────────────────────────────────────────────

function getProviderKey(provider) {
  const s = get();
  const fromSettings = s.providers?.[provider]?.apiKey;
  if (fromSettings) return fromSettings;
  const envVar = ENV_KEY_MAP[provider];
  if (envVar) return process.env[envVar] || '';
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
  return envVar && process.env[envVar] ? 'environment' : '';
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

function adoptEnvFileKeys({ envFile, env = process.env, now = new Date() } = {}) {
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
    updateSettings(patch);
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

function updateSettings(patch) {
  const s = get();

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

module.exports = {
  get,
  getSetting,
  getProviderKey,
  getProviderUrl,
  hasAnyApiKey,
  keySource,
  adoptEnvFileKeys,
  getForUI,
  updateSettings,
  PROVIDER_DEFAULTS,
  ENV_KEY_MAP,
  SEARCH_ENV_KEY_MAP,
};
