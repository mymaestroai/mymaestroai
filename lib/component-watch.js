'use strict';
/**
 * The component watch: notices new releases of the software My Maestro relies on. Codex (the ChatGPT client) is updated
 * by itself (a release a day old, Codex idle, with a way back); the Claude client and the local engines are only reported.
 * State: data/component-watch.json (mode 600, written atomically).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'data', 'component-watch.json');
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const FIRST_DELAY_MS = 10 * 60 * 1000;
const MAX_RETRIES = 6;
const VERSION_RE = /^[vb]?[0-9][0-9A-Za-z.+-]{0,40}$/;   // 'b' is llama.cpp's tag prefix

const URLS = {
  codex: 'https://registry.npmjs.org/@openai%2fcodex',
  claude: 'https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk',
  'llama-swap': 'https://api.github.com/repos/mostlygeek/llama-swap/releases/latest',
  'llama.cpp': 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest',
};
const NAMES = {
  codex: 'Codex (the ChatGPT client)',
  claude: 'Claude client',
  'llama-swap': 'llama-swap',
  'llama.cpp': "llama.cpp (the hub's build)",
};
const ORDER = ['codex', 'claude', 'llama-swap', 'llama.cpp'];

const validVersion = (v) => (typeof v === 'string' && VERSION_RE.test(v) ? v : null);

/** Numeric compare per dot-separated part; a leading v or b (tags) is ignored. -> negative, 0 or positive (NaN-safe: bad = 0) */
function compareVersions(a, b) {
  const parts = (s) => String(s == null ? '' : s).replace(/^[^0-9]*/, '').split('.').map(p => { const n = parseInt(p, 10); return Number.isFinite(n) ? n : 0; });
  const pa = parts(a); const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** From an npm registry document: { latest, cooled } (newest stable, newest stable published >= 24 h before now). */
function pickNpm(doc, nowMs) {
  const time = doc && typeof doc === 'object' && doc.time && typeof doc.time === 'object' ? doc.time : null;
  if (!time) return null;
  let latest = null; let cooled = null;
  for (const [v, iso] of Object.entries(time)) {
    if (!validVersion(v) || v.includes('-') || !/^[0-9]/.test(v)) continue;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) continue;
    if (!latest || compareVersions(v, latest) > 0) latest = v;
    if (t <= nowMs - DAY_MS && (!cooled || compareVersions(v, cooled) > 0)) cooled = v;
  }
  return latest ? { latest, cooled } : null;
}

const MAX_BODY = 30 * 1024 * 1024;   // the npm document of a busy package is large; anything beyond this is not read

function defaultFetchJson(url, fetchImpl = (typeof fetch === 'function' ? fetch : null)) {
  return (async () => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15000);
      try {
        const r = await fetchImpl(url, { signal: ctl.signal, headers: { 'User-Agent': 'MyMaestroAI-component-watch', Accept: 'application/json' } });
        if (!r || !r.ok) return null;
        const len = Number(r.headers && typeof r.headers.get === 'function' ? r.headers.get('content-length') : NaN);
        if (Number.isFinite(len) && len > MAX_BODY) return null;
        const text = await r.text();
        if (typeof text !== 'string' || text.length > MAX_BODY) return null;
        return JSON.parse(text);
      } finally { clearTimeout(timer); }
    } catch { return null; }
  })();
}

/** Is the Codex that runs here the one this hub installed (inside its own prefix)? */
function defaultCodexManaged() {
  try {
    const { resolveBinary, withNode } = require('./codex-cli');
    const { codexPrefix } = require('./codex-cli/setup');
    const bin = resolveBinary(withNode(process.env));
    if (!bin) return false;
    const prefix = path.resolve(codexPrefix(process.env));
    return path.resolve(bin).startsWith(prefix + path.sep);
  } catch { return false; }
}

const NOT_MANAGED = 'This Codex is not the one your Maestro installed; update it the way it was installed.';

function defaultClaudeInstalled() {
  try {
    let p;
    try { p = require.resolve('@anthropic-ai/claude-agent-sdk/package.json', { paths: [ROOT] }); } catch { p = path.join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'); }
    const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
    return typeof v === 'string' ? v : null;
  } catch { return null; }
}

function createComponentWatch(deps = {}) {
  const d = deps;
  const guard = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const stateFile = d.stateFile || STATE_FILE;
  const fetchJson = d.fetchJson || defaultFetchJson;
  const now = d.now || (() => Date.now());
  const log = d.log || (() => {});
  const setTimer = d.setTimer || ((fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; });
  const clearTimer = d.clearTimer || ((t) => clearTimeout(t));
  const setting = () => guard(() => (d.setting ? d.setting() : require('./settings').getSetting('componentUpdates', {})) || {}, {});
  const codexInstalled = () => guard(() => (d.codexInstalled ? d.codexInstalled() : require('./codex-cli/update').installedCodexVersion()), null);
  const codexInUse = () => guard(() => (d.codexInUse ? !!d.codexInUse() : false), false);
  const codexManaged = () => guard(() => (d.codexManaged ? !!d.codexManaged() : defaultCodexManaged()), false);
  const recoverFn = (o) => (d.recoverCodex ? d.recoverCodex(o) : require('./codex-cli/update').recoverCodex(o));
  const updateLockActive = () => guard(() => !!require('./codex-cli/update-lock').active(), false);
  const claudeInstalled = () => guard(() => (d.claudeInstalled ? d.claudeInstalled() : defaultClaudeInstalled()), null);
  const claudeOffered = () => guard(() => (d.claudeOffered ? d.claudeOffered() : null), null);
  const updateCodexFn = (o) => (d.updateCodex ? d.updateCodex(o) : require('./codex-cli/update').updateCodex(o));
  const discover = async () => {
    try {
      if (d.discover) return await d.discover();
      const md = require('./model-discovery');
      await md.runDiscovery({ again: true });
      return md.getDiscoveredModels();
    } catch (e) { log(`discovery failed: ${e && e.message}`); return null; }
  };
  const codexModels = () => guard(() => {
    const list = d.codexModels ? d.codexModels() : (require('./model-discovery').getDiscoveredModels()['codex-cli'] || []);
    return (Array.isArray(list) ? list : []).map(m => (m && typeof m === 'object' ? m.id : m)).filter(x => typeof x === 'string');
  }, []);
  const localStatus = async () => {
    try {
      if (d.localStatus) return await d.localStatus();
      const st = await require('./local-models').getLocalModels().status();
      // The hub's own llama.cpp build reports its build number ("version: 6123 (abc)"), which the releases tag as b6123.
      const srv = st && (st.detect || st).llamaServer;
      if (srv && srv.path && srv.source === 'hub build' && !srv.version) {
        srv.version = await new Promise((resolve) => {
          try {
            require('child_process').execFile(srv.path, ['--version'], { encoding: 'utf8', timeout: 10000 }, (err, stdout, stderr) => {
              const m = /version:\s*(\d+)/.exec(`${stdout || ''}\n${stderr || ''}`);
              resolve(m ? `b${m[1]}` : null);
            });
          } catch { resolve(null); }
        });
      }
      return st;
    } catch { return null; }
  };

  let state = null;          // { components: { id: {...} }, retries }
  let unreadable = false;
  let running = null;
  let updating = false;
  let retryTimer = null;
  let firstTimer = null;
  let dailyTimer = null;

  function load() {
    if (state) return state;
    state = { components: {}, retries: 0 };
    let raw = null;
    try { raw = fs.readFileSync(stateFile, 'utf8'); } catch { return state; }
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object' && j.components && typeof j.components === 'object') {
        const comps = {};
        for (const [k, v] of Object.entries(j.components)) if (v && typeof v === 'object' && !Array.isArray(v)) comps[k] = v;   // only plain objects
        state = { components: comps, retries: Number(j.retries) || 0 };
      } else unreadable = true;
    } catch { unreadable = true; }
    return state;
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      if (unreadable) {
        try { fs.copyFileSync(stateFile, `${stateFile}.bad`); } catch { /* keep going */ }
        unreadable = false;
      }
      const tmp = `${stateFile}.tmp-${process.pid}`;
      const fd = fs.openSync(tmp, 'w', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(state, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, stateFile);
    } catch (e) { log(`could not save the state: ${e && e.message}`); }
  }
  const rec = (id) => { const s = load(); return (s.components[id] = s.components[id] || {}); };

  async function fetchLatest(id) {
    const doc = await (async () => { try { return await fetchJson(URLS[id]); } catch { return null; } })();
    if (!doc) return null;
    if (id === 'codex' || id === 'claude') return pickNpm(doc, now());
    const tag = validVersion(doc && doc.tag_name);
    return tag ? { latest: tag, cooled: null } : null;
  }

  async function refreshOne(id, installed) {
    const c = rec(id);
    c.installed = installed;
    c.checkedAt = now();
    const got = await fetchLatest(id);
    if (got) {
      c.latest = got.latest;
      c.cooled = got.cooled;
    }
    return c;
  }

  const codexMode = () => { const m = String(setting().codex || 'auto'); return m === 'notify' || m === 'off' ? m : 'auto'; };
  const newerCooled = (c) => !!(c && c.installed && c.cooled && compareVersions(c.cooled, c.installed) > 0);

  async function runUpdate() {
    const c = rec('codex');
    const beforeModels = codexModels();
    const from = c.installed;
    let r;
    try { r = await updateCodexFn({ before: new Date(now() - DAY_MS) }); } catch (e) { r = { ok: false, error: `Codex update failed: ${(e && e.message) || e}` }; }
    r = r || { ok: false, error: 'Codex update failed.' };
    await discover();
    const afterModels = codexModels();
    const unlocks = afterModels.filter(m => !beforeModels.includes(m));
    c.installed = codexInstalled() || c.installed;
    c.waiting = null;
    c.lastUpdate = { at: now(), from: r.from || from || null, to: r.to || null, ok: !!r.ok, rolledBack: !!r.rolledBack, error: r.error || null, unlocks: r.ok ? unlocks : [] };
    // Only a release that was installed and then failed is not tried again; a copy, npm or network failure is not the
    // release's fault, so the next check tries again.
    if (!r.ok && r.to && r.from && r.to !== r.from) c.failedFor = c.cooled || null; else c.failedFor = null;
    return r;
  }

  function scheduleRetry() {
    const s = load();
    if (retryTimer || s.retries >= MAX_RETRIES) return;
    s.retries += 1;
    retryTimer = setTimer(() => { retryTimer = null; check({ reason: 'retry' }).catch(() => {}); }, HOUR_MS);
    if (retryTimer && retryTimer.unref) retryTimer.unref();
  }

  async function doCheck({ reason, allowUpdate }) {
    const s = load();
    if (reason === 'daily') s.retries = 0;   // a long busy spell must not end the hourly retries for good
    // Codex
    const mode = codexMode();
    const cv = mode === 'off' ? null : codexInstalled();
    if (mode === 'off' || !cv) { delete s.components.codex; }
    else {
      const c = await refreshOne('codex', cv);
      c.managed = codexManaged();
      if (mode === 'auto' && c.managed && allowUpdate && newerCooled(c) && !updating) {
        if (c.failedFor === c.cooled) { /* this release already failed its check: not tried again by itself */ }
        else if (codexInUse()) { c.waiting = 'Codex is in use'; scheduleRetry(); }
        else {
          updating = true;
          try { await runUpdate(); } finally { updating = false; }
          s.retries = 0;
        }
      } else if (!newerCooled(c)) { c.waiting = null; s.retries = 0; }
      if (c.waiting && !codexInUse() && !newerCooled(c)) c.waiting = null;
    }
    // Claude client
    const clv = claudeInstalled();
    if (!clv) delete s.components.claude;
    else {
      const c = await refreshOne('claude', clv);
      // the Claude client a pending My Maestro update would bring (lib/claude-offered; may answer with a promise)
      let off = null; try { off = await claudeOffered(); } catch { off = null; }
      c.offered = validVersion(off) || null;
    }
    // Local engines
    const st = await localStatus();
    const det = st && (st.detect || st);
    const swap = det && det.llamaSwap;
    if (swap && swap.path) {
      const c = await refreshOne('llama-swap', validVersion(swap.version) || null);
      c.pinned = validVersion(swap.pinned) || null;
    } else delete s.components['llama-swap'];
    const srv = det && det.llamaServer;
    if (srv && srv.path && srv.source === 'hub build') {
      await refreshOne('llama.cpp', validVersion(srv.version || srv.build) || null);
    } else delete s.components['llama.cpp'];
    s.lastCheck = { at: now(), reason };
    save();
    return items();
  }

  function check({ reason = 'daily', allowUpdate = true } = {}) {
    if (running) return running;
    running = doCheck({ reason, allowUpdate }).catch((e) => { log(`check failed: ${e && e.message}`); return items(); }).finally(() => { running = null; });
    return running;
  }

  /** A refusal that is known at once, from the last check's stored data (no network). -> { ok: true } | { ok: false, error } */
  function canUpdateCodexNow() {
    if (codexMode() === 'off') return { ok: false, error: 'Codex updates are switched off in Settings.' };
    if (updating || running || updateLockActive()) return { ok: false, error: 'A check or an update is already running. Try again in a minute.' };
    const cv = codexInstalled();
    if (!cv) return { ok: false, error: 'Codex is not installed here.' };
    if (!codexManaged()) return { ok: false, error: NOT_MANAGED };
    const stored = load().components.codex;
    if (!newerCooled({ installed: cv, cooled: stored && stored.cooled })) return { ok: false, error: 'There is no newer Codex release that is a day old yet.' };
    if (codexInUse()) return { ok: false, error: 'Codex is in use right now. Try again when it is idle.' };
    return { ok: true };
  }

  async function updateCodexNow() {
    const mode = codexMode();
    if (mode === 'off') return { ok: false, error: 'Codex updates are switched off in Settings.' };
    if (updating || running) return { ok: false, error: 'A check or an update is already running. Try again in a minute.' };
    const cv = codexInstalled();
    if (!cv) return { ok: false, error: 'Codex is not installed here.' };
    if (!codexManaged()) return { ok: false, error: NOT_MANAGED };
    updating = true;
    // a refusal after the start is also written to lastUpdate, so the page that waits for the outcome sees it
    const refuse = (c, error) => { c.lastUpdate = { at: now(), from: cv, to: null, ok: false, rolledBack: false, error, unlocks: [] }; save(); return { ok: false, error }; };
    try {
      const c = await refreshOne('codex', cv);
      if (!newerCooled(c)) return refuse(c, 'There is no newer Codex release that is a day old yet.');
      if (codexInUse()) { c.waiting = 'Codex is in use'; return refuse(c, 'Codex is in use right now. Try again when it is idle.'); }
      const r = await runUpdate();
      save();
      return r;
    } catch (e) {
      const error = `Codex update failed: ${(e && e.message) || e}`;
      try { return refuse(rec('codex'), error); } catch { return { ok: false, error }; }
    } finally { updating = false; }
  }

  function items() {
    const s = load();
    const mode = codexMode();
    const out = [];
    for (const id of ORDER) {
      const c = s.components[id];
      if (!c) continue;
      if (id === 'codex' && mode === 'off') continue;
      const installed = validVersion(c.installed) || null;
      const latest = validVersion(c.latest) || null;
      const behind = !!(installed && latest && compareVersions(latest, installed) > 0);
      let how; let action = 'notify';
      if (id === 'codex') {
        action = mode === 'notify' || c.managed === false ? 'notify' : 'auto';
        how = c.managed === false ? NOT_MANAGED
          : action === 'auto' ? 'Your Maestro updates it by itself once a release is a day old and Codex is idle.' : 'Update it in Settings → Status (Update Codex now).';
      } else if (id === 'claude') {
        const off = validVersion(c.offered);
        how = off && installed && compareVersions(off, installed) > 0
          ? `The pending My Maestro update brings Claude client ${off}: install it with Update in Settings → Status.`
          : 'It arrives with My Maestro updates; the current update does not include it yet.';
      } else if (id === 'llama-swap') {
        how = `My Maestro pins llama-swap ${validVersion(c.pinned) || 'a tested version'} (checked by its sha256) and moves to newer releases in its own updates.`;
      } else {
        how = 'Rebuild data/local-models/llama.cpp from the newest release (git pull, then cmake --build build --config Release), then restart local models.';
      }
      out.push({ id, name: NAMES[id], installed, latest, behind, action, how, waiting: c.waiting || null, lastUpdate: c.lastUpdate || null });
    }
    return out;
  }

  function start() {
    stop();
    // One recovery before the first check: an update that was stopped half way never leaves the install without Codex.
    (async () => {
      try {
        const r = await recoverFn({});
        if (r && r.recovered) log('Codex was put back from the kept copy after an interrupted update.');
        else if (r && r.error) log(`Codex recovery check failed: ${r.error}`);
      } catch (e) { log(`Codex recovery check failed: ${(e && e.message) || e}`); }
    })();
    firstTimer = setTimer(() => {
      firstTimer = null;
      check({ reason: 'start' }).catch(() => {});
      dailyTimer = setTimer(function tick() {
        check({ reason: 'daily' }).catch(() => {});
        dailyTimer = setTimer(tick, DAY_MS);
        if (dailyTimer && dailyTimer.unref) dailyTimer.unref();
      }, DAY_MS);
      if (dailyTimer && dailyTimer.unref) dailyTimer.unref();
    }, FIRST_DELAY_MS);
    if (firstTimer && firstTimer.unref) firstTimer.unref();
  }
  function stop() {
    for (const t of [firstTimer, dailyTimer, retryTimer]) if (t) { try { clearTimer(t); } catch { /* none */ } }
    firstTimer = dailyTimer = retryTimer = null;
  }

  return { check, updateCodexNow, canUpdateCodexNow, items, start, stop };
}

let singleton = null;
function getComponentWatch() {
  if (!singleton) singleton = createComponentWatch({ log: (m) => console.log(`[component-watch] ${m}`) });
  return singleton;
}

module.exports = { createComponentWatch, getComponentWatch, compareVersions, pickNpm, defaultFetchJson, STATE_FILE, URLS };
