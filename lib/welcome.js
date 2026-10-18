'use strict';

/**
 * welcome.js — first-run setup (the /welcome page) and the one-time setup code that guards it.
 *
 * Until the first admin account exists, creating it needs the setup code the installer prints (data/setup-token, or
 * HUB_SETUP_TOKEN for scripted installs), so no other program on the machine can claim the hub. The Welcome page
 * then connects one way for agents to think (a Claude subscription, an API key, or a local model), proves it with a
 * real request, and gives the lead agent that model. Everything here is reusable by `mymaestro` (scripts/hub-cli.js).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HUB_DIR = path.join(__dirname, '..');
const PRODUCT = 'My Maestro AI';

// The three API providers the Welcome page offers (Perplexity and ChatGPT-through-Codex are added later in Settings:
// neither is a good first brain for a lead agent). Each lists its models, which proves the key without spending.
const API_PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude API)', keyUrl: 'https://console.anthropic.com/settings/keys',
    list: (key) => ({ url: 'https://api.anthropic.com/v1/models?limit=100', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }),
    chat: (id) => /^claude-/.test(id),
    rank: (id) => versionScore(id) * 10 + (/sonnet/.test(id) ? 30 : /opus/.test(id) ? 20 : /fable/.test(id) ? 10 : 0),   // newest first; Sonnet is the everyday default
  },
  openai: {
    label: 'OpenAI (GPT API)', keyUrl: 'https://platform.openai.com/api-keys',
    list: (key) => ({ url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${key}` } }),
    chat: (id) => /^(gpt-\d|o\d)/.test(id) && !/(audio|realtime|transcribe|tts|image|search|embed|codex|instruct)/.test(id),
    rank: (id) => versionScore(id) * 10 + (/^gpt-/.test(id) ? 20 : 0) - (/(mini|nano)/.test(id) ? 100 : 0) - (/\d{4}-\d{2}-\d{2}/.test(id) ? 50 : 0),
  },
  google: {
    label: 'Google (Gemini API)', keyUrl: 'https://aistudio.google.com/apikey',
    list: (key) => ({ url: 'https://generativelanguage.googleapis.com/v1beta/openai/models', headers: { Authorization: `Bearer ${key}` } }),
    chat: (id) => /^gemini-/.test(id) && !/(embed|image|tts|audio|live|vision)/.test(id),
    rank: (id) => versionScore(id) * 10 + (/pro/.test(id) ? 30 : /flash/.test(id) ? 15 : 20) - (/(lite|preview|exp)/.test(id) ? 50 : 0),   // newest generation first
  },
};

// Local engines the Welcome page looks for, in order. The hub's own proxy (Local models page) comes first.
const LOCAL_ENGINES = [
  { provider: 'local', label: 'Local models (the hub\'s own proxy)' },
  { provider: 'lmstudio', label: 'LM Studio' },
  { provider: 'ollama', label: 'Ollama' },
  { provider: 'omlx', label: 'oMLX' },
  { provider: 'ninfer', label: 'NInfer' },
];
const LOCAL_ENV = ['LM_STUDIO_URL', 'OLLAMA_URL', 'OMLX_URL', 'NINFER_URL', 'LOCAL_MODELS_URL'];

/** A rough "newer is bigger" score from the version in a model id (gpt-6 > gpt-5.5 > gpt-5; claude-opus-5-5 > -5).
 *  Only short numbers count: dates, snapshot suffixes (-0613) and preview stamps (-10-2025) are ignored. */
function versionScore(id) {
  // One pass per kind, full dates first: "gpt-5-2025-08-07" must not lose its "5" to the month-year rule.
  const s = String(id).replace(/-?\d{4}-\d{2}-\d{2}/g, '').replace(/\d{8}/g, '').replace(/-\d{1,2}-\d{4}\b/g, '').replace(/-\d{4}\b/g, '');
  const nums = (s.match(/(?<![\d.])\d{1,2}(\.\d{1,2})?(?![\d])/g) || []).slice(0, 2);
  let score = 0, scale = 10;
  for (const n of nums) { score += parseFloat(n) * scale; scale /= 10; }
  return Math.min(score, 99);
}

function createWelcome(deps = {}) {
  const dataDir = deps.dataDir || path.join(HUB_DIR, 'data');
  const env = deps.env || process.env;
  const settings = () => deps.settings || require('./settings');
  const claudeAuth = () => deps.claudeAuth || require('./claude-auth');
  const doFetch = deps.fetch || ((...a) => fetch(...a));
  const tokenFile = path.join(dataDir, 'setup-token');

  // ── The one-time setup code ──
  function readToken() {
    if (env.HUB_SETUP_TOKEN) return String(env.HUB_SETUP_TOKEN).trim();
    try { return fs.readFileSync(tokenFile, 'utf8').trim(); } catch { return ''; }
  }
  /** The code that must accompany the first-admin request; created once (0600) and kept until that admin exists. */
  function ensureSetupToken() {
    const existing = readToken();
    if (existing) return existing;
    const t = crypto.randomBytes(24).toString('base64url');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tokenFile, t + '\n', { mode: 0o600 });
    try { fs.chmodSync(tokenFile, 0o600); } catch { /* filesystem without modes */ }
    return t;
  }
  function checkSetupToken(given) {
    const t = readToken();
    if (!t || !given) return false;
    const a = Buffer.from(String(given).trim());
    const b = Buffer.from(t);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  function clearSetupToken() { try { fs.unlinkSync(tokenFile); } catch { /* already gone */ } }

  // ── Progress: started when the first account is made on the Welcome page, finished at Maestro's first answer (or
  // when the owner skips). While it is unfinished, "/" sends the administrator back to /welcome, which picks the step
  // from what is already done: a closed tab, or one Claude's sign-in page replaced, resumes where it stopped.
  const progressFile = path.join(dataDir, 'welcome.json');
  function progress() {
    try { return JSON.parse(fs.readFileSync(progressFile, 'utf8')) || {}; } catch { return {}; }
  }
  function saveProgress(p) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(progressFile, JSON.stringify(p, null, 2) + '\n', { mode: 0o600 });
  }
  function markStarted() {
    const p = progress();
    if (!p.startedAt) saveProgress({ ...p, startedAt: new Date().toISOString() });
  }
  function markFinished(how = 'done') {
    const p = progress();
    if (!p.finishedAt) saveProgress({ ...p, finishedAt: new Date().toISOString(), how: how === 'skip' ? 'skip' : 'done' });
  }
  function unfinished() { const p = progress(); return !!p.startedAt && !p.finishedAt; }

  // ── Is there a way for agents to think? ──
  function localConfigured() {
    let s = {};
    try { s = settings().get() || {}; } catch { /* no settings yet */ }
    if (['lmstudio', 'ollama', 'omlx', 'ninfer'].some(p => s.providers && s.providers[p] && s.providers[p].url)) return true;
    if (LOCAL_ENV.some(k => env[k])) return true;
    try { if (JSON.parse(fs.readFileSync(path.join(dataDir, 'local-models.json'), 'utf8')).enabled) return true; } catch { /* not set up */ }
    return !!(s.welcome && s.welcome.provider);
  }
  function hasProvider() {
    let key = false, claude = false;
    try { key = settings().hasAnyApiKey(); } catch { /* settings unreadable */ }
    try { claude = claudeAuth().hasSdkCredentials(); } catch { /* not installed */ }
    return key || claude || localConfigured();
  }
  function providerSummary() {
    const out = {};
    for (const p of Object.keys(API_PROVIDERS)) { try { out[p] = !!settings().getProviderKey(p); } catch { out[p] = false; } }
    try { out.claude = claudeAuth().hasSdkCredentials(); } catch { out.claude = false; }
    out.local = localConfigured();
    return out;
  }

  async function getJson(url, headers = {}, timeoutMs = 12000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await doFetch(url, { headers, signal: ctrl.signal });
      let body = null; try { body = await r.json(); } catch { /* not JSON */ }
      return { status: r.status, body };
    } finally { clearTimeout(timer); }
  }

  /** Save an API key, then prove it by listing the provider's models (no tokens spent). */
  async function connectApiKey(provider, apiKey) {
    const p = API_PROVIDERS[provider];
    if (!p) return { ok: false, error: 'Choose Anthropic, OpenAI or Google.' };
    const key = String(apiKey || '').replace(/\s+/g, '');
    if (key.length < 16) return { ok: false, error: 'That does not look like a complete key. Copy the whole key and paste it again.' };
    let r;
    try { const req = p.list(key); r = await getJson(req.url, req.headers); }
    catch (e) { return { ok: false, error: `Could not reach ${p.label}. Check this computer's internet connection.`, detail: e.message }; }
    if (r.status === 401 || r.status === 403) return { ok: false, error: `${p.label} refused this key. Check that you copied all of it, and that the key is active.`, detail: `HTTP ${r.status}` };
    if (r.status !== 200) return { ok: false, error: `${p.label} answered with an error (HTTP ${r.status}). Try again in a minute.`, detail: JSON.stringify(r.body || {}).slice(0, 300) };
    const ids = ((r.body && r.body.data) || []).map(m => String(m.id || '').replace(/^models\//, '')).filter(Boolean);
    const models = ids.filter(p.chat).sort((a, b) => p.rank(b) - p.rank(a));
    if (!models.length) return { ok: false, error: `The key works, but ${p.label} lists no chat models for it. Check the account's plan or region.` };
    settings().updateSettings({ providers: { [provider]: { apiKey: key } } });
    remember(provider);
    return { ok: true, provider, label: p.label, models: models.slice(0, 40).map(id => `${provider}/${id}`), suggested: `${provider}/${models[0]}` };
  }

  /** Prove the Claude subscription sign-in with one tiny request through the same client the agents use. */
  async function checkClaude({ timeoutMs = 90000 } = {}) {
    let sdk, cliOptions;
    try { const loader = deps.sdkLoader || require('./sdk-loader'); sdk = await loader.loadSdk(); cliOptions = loader.cliOptions; }
    catch (e) { return { ok: false, state: 'missing', error: 'The Claude client library is missing from this install. Run: mymaestro doctor', detail: e.message }; }
    // The subscription, not an API key: strip any key from the client's environment (lib/billing).
    let clientEnv;
    try { clientEnv = (deps.clientEnv || require('./billing').clientEnvWithoutApiKey)(env); }
    catch (e) { return { ok: false, state: 'error', error: 'Could not prepare the Claude client.', detail: e.message }; }
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      const q = sdk.query({ prompt: 'Reply with exactly: OK', options: { model: 'haiku', maxTurns: 1, permissionMode: 'acceptEdits', tools: [], env: clientEnv, abortController, ...(cliOptions ? cliOptions() : {}) } });
      for await (const msg of q) {
        if (msg.type !== 'result') continue;
        const text = String(msg.result || '');
        if (!msg.is_error) { remember('claude'); return { ok: true, state: 'ready', model: 'claude-sdk/default' }; }
        return classifyClaude(text);
      }
      return { ok: false, state: 'unknown', error: 'Claude did not answer. Try again in a minute.' };
    } catch (e) {
      if (abortController.signal.aborted) return { ok: false, state: 'timeout', error: 'Claude took too long to answer. Check the internet connection and try again.' };
      return classifyClaude(e.message || String(e));
    } finally { clearTimeout(timer); }
  }
  function classifyClaude(text) {
    const t = String(text);
    if (/log ?in|sign ?in|not logged|invalid api key|authenticat|credential|oauth|\/login/i.test(t)) return { ok: false, state: 'signed-out', error: 'Claude is not signed in on this computer yet. Follow the steps above, then press Check again.', detail: t.slice(0, 300) };
    if (/usage limit|rate limit|limit reached|quota|credit balance/i.test(t)) return { ok: false, state: 'limit', error: 'Claude answered, but your plan\'s usage limit is reached right now. It will work once the limit resets.', detail: t.slice(0, 300) };
    if (/ENOENT|not found|spawn/i.test(t)) return { ok: false, state: 'missing', error: 'The Claude client could not start. Install Claude Code with the command above, then press Check again.', detail: t.slice(0, 300) };
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|fetch failed/i.test(t)) return { ok: false, state: 'network', error: 'Could not reach Claude. Check this computer\'s internet connection.', detail: t.slice(0, 300) };
    return { ok: false, state: 'error', error: 'Claude answered with an error.', detail: t.slice(0, 300) };
  }

  /** Look for local engines with at least one model loaded or listed. */
  async function findLocal() {
    const found = [];
    for (const e of LOCAL_ENGINES) {
      let url = '';
      try { url = settings().getProviderUrl(e.provider); } catch { /* unknown */ }
      if (!url) continue;
      try {
        const r = await getJson(`${url.replace(/\/+$/, '')}/models`, {}, 2500);
        const ids = ((r.body && r.body.data) || []).map(m => String(m.id || '')).filter(Boolean);
        if (r.status === 200 && ids.length) found.push({ provider: e.provider, label: e.label, url, models: ids.slice(0, 30).map(id => `${e.provider}/${id}`) });
      } catch { /* not running */ }
    }
    return found;
  }
  /** Use a local engine: record its address so the hub counts it as configured. */
  function connectLocal(provider, url) {
    if (!LOCAL_ENGINES.some(e => e.provider === provider)) return { ok: false, error: 'Unknown local engine.' };
    if (provider !== 'local' && url) settings().updateSettings({ providers: { [provider]: { url } } });
    remember(provider);
    return { ok: true };
  }

  function remember(provider) {
    try { settings().updateSettings({ welcome: { provider, at: new Date().toISOString() } }); } catch { /* best effort */ }
  }

  return { PRODUCT, API_PROVIDERS, LOCAL_ENGINES, ensureSetupToken, checkSetupToken, clearSetupToken, readToken, tokenFile, progress, markStarted, markFinished, unfinished, progressFile, hasProvider, providerSummary, localConfigured, connectApiKey, checkClaude, classifyClaude, findLocal, connectLocal, versionScore };
}

let _instance = null;
function getWelcome() { if (!_instance) _instance = createWelcome(); return _instance; }

module.exports = { createWelcome, getWelcome, versionScore, PRODUCT };
