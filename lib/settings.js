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
            getProviderKey('google') || getProviderKey('perplexity'));
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
  getForUI,
  updateSettings,
  PROVIDER_DEFAULTS,
};
