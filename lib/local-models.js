'use strict';
/**
 * local-models.js — the hub's standard path for local models: ONE proxy (llama-swap) that starts the right inference
 * engine for the model a request names, keeps it loaded while it is in use, and stops it when another model is asked
 * for or after an idle period. Engines: llama.cpp's llama-server (GGUF files: any model llama.cpp supports, vision
 * via a projector file, speculative drafts), NInfer (.ninfer files, Qwen family, fastest on a single NVIDIA GPU), or
 * any command the owner writes that serves an OpenAI-compatible API on ${PORT}.
 *
 * Why: one GPU, many models. LM Studio and Ollama each hold their own models and know nothing about each other, so a
 * second engine finds the GPU full, and unloading after every call makes a series of queries crawl. llama-swap is the
 * single scheduler: the same model again costs nothing, a different model costs one swap, idle models are unloaded.
 *
 * State     data/local-models.json   settings + the model registry (edited on the Local models page or by the lead agent)
 * Generated data/local-models/config.yaml (what llama-swap reads; it watches the file), llama-swap.log, llama-swap.pid
 * Binaries  data/local-models/bin/llama-swap (pinned release, sha256-verified); llama-server from the hub's own build
 *           (data/local-models/llama.cpp), from PATH, from LM Studio's backends, or a path the owner gives
 * Provider  models appear as local/<id>: gateway route, free, OpenAI-compatible at http://127.0.0.1:<port>/v1
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LLAMA_SWAP_VERSION = '265';
const LLAMA_SWAP_RELEASE = `https://github.com/mostlygeek/llama-swap/releases/download/v${LLAMA_SWAP_VERSION}`;
const ENGINES = ['llama.cpp', 'ninfer', 'command'];
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

const DEFAULTS = () => ({
  enabled: false,
  port: 18080,            // llama-swap listens here (loopback only)
  startPort: 18100,       // first upstream port llama-swap hands to engines
  globalTTL: 900,         // seconds idle before a model is unloaded (0 = never)
  healthCheckTimeout: 900,// seconds to wait for an engine to come up (big models take a while)
  modelsDirs: [],         // folders the scanner looks in
  llamaServer: '',        // path override; '' = detect
  ninferServe: '',        // path override; '' = detect
  models: [],             // registry, see validateModel
});

function sha256File(p) { const h = crypto.createHash('sha256'); h.update(fs.readFileSync(p)); return h.digest('hex'); }
function yq(s) { return JSON.stringify(String(s)); }   // a JSON string is a valid double-quoted YAML scalar
function shq(s) { s = String(s); return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`; }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function which(name) { try { return execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; } }
function bytesText(n) { return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${n} B`; }

/** validateModel(m) -> normalised record or throws. */
function validateModel(m = {}) {
  const id = String(m.id || '').trim();
  if (!ID_RE.test(id)) throw new Error('id: letters, digits, dot, dash, underscore (max 64)');
  const engine = String(m.engine || 'llama.cpp');
  if (!ENGINES.includes(engine)) throw new Error(`engine: one of ${ENGINES.join(', ')}`);
  const out = {
    id, engine,
    name: String(m.name || id).trim().slice(0, 80),
    path: String(m.path || '').trim(),
    mmproj: String(m.mmproj || '').trim(),
    draft: String(m.draft || '').trim(),
    draftArgs: String(m.draftArgs || '').trim(),
    ctx: Math.max(0, parseInt(m.ctx, 10) || 0),
    ngl: m.ngl === '' || m.ngl == null ? 99 : Math.max(0, parseInt(m.ngl, 10) || 0),
    maxOutput: Math.max(0, parseInt(m.maxOutput, 10) || 0),
    ttl: m.ttl === '' || m.ttl == null ? null : Math.max(0, parseInt(m.ttl, 10) || 0),
    aliases: [...new Set((Array.isArray(m.aliases) ? m.aliases : String(m.aliases || '').split(',')).map(s => String(s).trim()).filter(Boolean))],
    extraArgs: String(m.extraArgs || '').trim(),
    cmd: String(m.cmd || '').trim(),
    env: Array.isArray(m.env) ? m.env.map(String) : String(m.env || '').split('\n').map(s => s.trim()).filter(Boolean),
    enabled: m.enabled !== false,
    notes: String(m.notes || '').slice(0, 400),
  };
  if (engine === 'command') { if (!out.cmd.includes('${PORT}')) throw new Error('cmd must contain ${PORT} (llama-swap assigns the port)'); }
  else if (!out.path) throw new Error('path: the model file');
  for (const a of out.aliases) if (!ID_RE.test(a)) throw new Error(`alias "${a}": letters, digits, dot, dash, underscore`);
  return out;
}

function createLocalModels({
  root = ROOT,
  dataDir = path.join(ROOT, 'data'),
  log = () => {},
  fetchImpl = (...a) => fetch(...a),
  platform = process.platform,
  arch = process.arch,
  home = os.homedir(),
  env = process.env,
} = {}) {
  const stateFile = path.join(dataDir, 'local-models.json');
  const dir = path.join(dataDir, 'local-models');
  const binDir = path.join(dir, 'bin');
  const configFile = path.join(dir, 'config.yaml');
  const logFile = path.join(dir, 'llama-swap.log');
  const pidFile = path.join(dir, 'llama-swap.pid');
  const llamaCppDir = path.join(dir, 'llama.cpp');

  // ── state ──
  let cache = null;
  function state() {
    if (cache) return cache;
    let s = {};
    try { s = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
    cache = { ...DEFAULTS(), ...s, models: Array.isArray(s.models) ? s.models : [] };
    return cache;
  }
  function save(s) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 }); fs.renameSync(tmp, stateFile);
    cache = s;
  }
  function update(patch = {}) {
    const s = { ...state() };
    if (patch.enabled !== undefined) s.enabled = !!patch.enabled;
    for (const k of ['port', 'startPort']) if (patch[k] !== undefined) { const v = parseInt(patch[k], 10); if (!(v >= 1024 && v <= 65535)) throw new Error(`${k}: 1024-65535`); s[k] = v; }
    for (const k of ['globalTTL', 'healthCheckTimeout']) if (patch[k] !== undefined) { const v = parseInt(patch[k], 10); if (!(v >= 0 && v <= 86400)) throw new Error(`${k}: 0-86400 seconds`); s[k] = v; }
    if (patch.modelsDirs !== undefined) s.modelsDirs = (Array.isArray(patch.modelsDirs) ? patch.modelsDirs : String(patch.modelsDirs).split('\n')).map(x => String(x).trim()).filter(Boolean).slice(0, 20);
    for (const k of ['llamaServer', 'ninferServe']) if (patch[k] !== undefined) s[k] = String(patch[k]).trim();
    save(s);
    return s;
  }
  const models = {
    list: () => state().models.slice(),
    get: (id) => state().models.find(m => m.id === id) || null,
    upsert(m) {
      const rec = validateModel(m);
      const s = { ...state(), models: state().models.slice() };
      const i = s.models.findIndex(x => x.id === rec.id);
      for (const x of s.models) if (x.id !== rec.id && (x.aliases || []).concat(x.id).some(a => a === rec.id || rec.aliases.includes(a))) throw new Error(`"${rec.id}" or one of its aliases is already used by "${x.id}"`);
      if (i >= 0) s.models[i] = rec; else s.models.push(rec);
      save(s); return rec;
    },
    remove(id) { const s = { ...state(), models: state().models.filter(x => x.id !== id) }; if (s.models.length === state().models.length) throw new Error('no such model'); save(s); },
  };

  // ── binaries ──
  function llamaSwapPath() { const p = path.join(binDir, 'llama-swap'); return fs.existsSync(p) ? p : (which('llama-swap')); }
  function llamaServerPath() {
    const s = state();
    if (s.llamaServer) return fs.existsSync(s.llamaServer) ? { path: s.llamaServer, source: 'configured' } : { path: null, source: 'configured path missing' };
    const own = path.join(llamaCppDir, 'build', 'bin', 'llama-server');
    if (fs.existsSync(own)) return { path: own, source: 'hub build' };
    const onPath = which('llama-server'); if (onPath) return { path: onPath, source: 'PATH' };
    const brew = ['/opt/homebrew/bin/llama-server', '/usr/local/bin/llama-server'].find(p => fs.existsSync(p)); if (brew) return { path: brew, source: 'Homebrew' };
    try {   // LM Studio ships llama-server binaries with its backends (needs its lib folder on the loader path; see cmdFor)
      const bk = path.join(home, '.lmstudio', 'extensions', 'backends');
      const cands = fs.readdirSync(bk).filter(d => /^llama\.cpp-/.test(d)).map(d => path.join(bk, d, 'llama-server')).filter(p => fs.existsSync(p));
      const pick = cands.find(p => /cuda/.test(p)) || cands.find(p => /metal|vulkan/.test(p)) || cands[0];
      if (pick) return { path: pick, source: 'LM Studio backend' };
    } catch {}
    return { path: null, source: 'not found' };
  }
  function ninferServePath() {
    const s = state();
    if (s.ninferServe) return fs.existsSync(s.ninferServe) ? { path: s.ninferServe, source: 'configured' } : { path: null, source: 'configured path missing' };
    const cands = [path.join(home, 'ninfer', 'build', 'apps', 'ninfer-serve'), which('ninfer-serve')].filter(Boolean);
    const p = cands.find(p => fs.existsSync(p)); return p ? { path: p, source: p.includes('/ninfer/') ? '~/ninfer build' : 'PATH' } : { path: null, source: 'not found' };
  }
  function detect() {
    const ls = llamaSwapPath();
    let version = null;
    if (ls) { try { version = spawnSync(ls, ['-version'], { encoding: 'utf8', timeout: 5000 }).stdout.trim().split('\n')[0].slice(0, 60) || null; } catch {} }
    const cuda = fs.existsSync('/usr/local/cuda/bin/nvcc') || !!which('nvcc') || fs.readdirSync('/usr/local').some(d => /^cuda-\d/.test(d)) && true;
    return { platform, arch, llamaSwap: { path: ls, version, pinned: LLAMA_SWAP_VERSION }, llamaServer: llamaServerPath(), ninferServe: ninferServePath(), cuda: !!cuda, cmake: !!which('cmake'), git: !!which('git'), brew: !!which('brew') };
  }

  // ── commands and config ──
  function cmdFor(m, det = null) {
    const d = det || detect();
    if (m.engine === 'command') return m.cmd;
    if (m.engine === 'ninfer') {
      const bin = d.ninferServe.path; if (!bin) throw new Error('ninfer-serve not found (set its path on the Local models page)');
      return [shq(bin), shq(m.path), '--host', '127.0.0.1', '--port', '${PORT}', '--model-id', shq(m.id), m.extraArgs].filter(Boolean).join(' ');
    }
    const bin = d.llamaServer.path; if (!bin) throw new Error('llama-server not found (build it from the Local models page, install llama.cpp, or set its path)');
    const parts = [shq(bin), '--host', '127.0.0.1', '--port', '${PORT}', '-m', shq(m.path), '-ngl', String(m.ngl), '--jinja', '-fa', 'on'];
    if (m.ctx > 0) parts.push('-c', String(m.ctx));
    if (m.mmproj) parts.push('--mmproj', shq(m.mmproj));
    if (m.draft) { parts.push('-md', shq(m.draft)); if (m.draftArgs) parts.push(m.draftArgs); }
    if (m.extraArgs) parts.push(m.extraArgs);
    return parts.join(' ');
  }
  function envFor(m, det) {
    const e = m.env.slice();
    if (m.engine === 'llama.cpp' && det.llamaServer.source === 'LM Studio backend') e.push(`LD_LIBRARY_PATH=${path.dirname(det.llamaServer.path)}`, `DYLD_LIBRARY_PATH=${path.dirname(det.llamaServer.path)}`);
    return e;
  }
  function renderConfig() {
    const s = state(); const det = detect();
    const lines = [
      '# Generated by My Maestro AI (lib/local-models.js) from data/local-models.json. Edit on the Local models page; hand edits are overwritten.',
      `healthCheckTimeout: ${s.healthCheckTimeout}`, `startPort: ${s.startPort}`, 'logLevel: info', `globalTTL: ${s.globalTTL}`, 'sendLoadingState: true', 'includeAliasesInList: false', 'models:',
    ];
    const problems = [];
    for (const m of s.models) {
      if (m.enabled === false) continue;
      let cmd; try { cmd = cmdFor(m, det); } catch (e) { problems.push(`${m.id}: ${e.message}`); continue; }
      lines.push(`  ${yq(m.id)}:`, `    cmd: ${yq(cmd)}`, `    proxy: "http://127.0.0.1:\${PORT}"`, `    name: ${yq(m.name || m.id)}`);
      if (m.ttl != null) lines.push(`    ttl: ${m.ttl}`);
      if (m.aliases.length) lines.push(`    aliases: [${m.aliases.map(yq).join(', ')}]`);
      if (m.engine === 'ninfer') lines.push(`    useModelName: ${yq(m.id)}`, '    checkEndpoint: /health');
      const e = envFor(m, det); if (e.length) lines.push(`    env: [${e.map(yq).join(', ')}]`);
      if (m.notes) lines.push(`    description: ${yq(m.notes)}`);
    }
    if (!s.models.some(m => m.enabled !== false)) lines.push('  {}');
    return { yaml: lines.join('\n') + '\n', problems };
  }
  function writeConfig() { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); const r = renderConfig(); fs.writeFileSync(configFile, r.yaml); return { file: configFile, ...r }; }

  // ── the proxy process (detached: it outlives hub restarts, so a loaded model survives them) ──
  function pid() { try { const n = parseInt(fs.readFileSync(pidFile, 'utf8'), 10); return n > 1 && alive(n) ? n : null; } catch { return null; } }
  function baseUrl() { return `http://127.0.0.1:${state().port}/v1`; }
  async function http(p, { method = 'GET', body, timeout = 4000 } = {}) {
    const r = await fetchImpl(`http://127.0.0.1:${state().port}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  }
  async function healthy() { try { return (await http('/health')).status === 200; } catch { return false; } }
  async function running() {
    try { const r = await http('/running'); return (r.json && (r.json.running || r.json.models)) || []; } catch { return []; }
  }
  async function unload(id = null) { return http(id ? `/api/models/unload/${encodeURIComponent(id)}` : '/api/models/unload', { method: 'POST', timeout: 30000 }); }
  async function logs(n = 200) { try { const r = await http('/logs'); return r.text.split('\n').slice(-n).join('\n'); } catch { try { return fs.readFileSync(logFile, 'utf8').split('\n').slice(-n).join('\n'); } catch { return ''; } } }

  async function start() {
    const bin = llamaSwapPath(); if (!bin) throw new Error('llama-swap is not installed (Install on the Local models page)');
    if (pid()) return { ok: true, pid: pid(), note: 'already running' };
    const cfg = writeConfig(); if (cfg.problems.length) log(`[local-models] config written with ${cfg.problems.length} problem(s): ${cfg.problems.join('; ')}`);
    fs.mkdirSync(dir, { recursive: true });
    const out = fs.openSync(logFile, 'a');
    const child = spawn(bin, ['-config', configFile, '-listen', `127.0.0.1:${state().port}`, '-watch-config'], { detached: true, stdio: ['ignore', out, out], cwd: dir, env: { ...env, HOME: home } });
    child.on('error', (e) => log(`[local-models] llama-swap failed to start: ${e.message}`));
    child.unref(); fs.closeSync(out);
    fs.writeFileSync(pidFile, String(child.pid));
    for (let i = 0; i < 40; i++) { if (await healthy()) break; await new Promise(r => setTimeout(r, 250)); }
    const ok = await healthy();
    log(`[local-models] llama-swap ${ok ? 'up' : 'started but not healthy yet'} (pid ${child.pid}, port ${state().port}, ${state().models.length} model(s))`);
    return { ok, pid: child.pid, problems: cfg.problems };
  }
  async function stop() {
    const p = pid(); if (!p) { try { fs.unlinkSync(pidFile); } catch {} return { ok: true, note: 'not running' }; }
    try { process.kill(p, 'SIGTERM'); } catch {}
    for (let i = 0; i < 60; i++) { if (!alive(p)) break; await new Promise(r => setTimeout(r, 250)); }
    if (alive(p)) { try { process.kill(p, 'SIGKILL'); } catch {} }
    try { fs.unlinkSync(pidFile); } catch {}
    log(`[local-models] llama-swap stopped (pid ${p})`);
    return { ok: true };
  }
  async function restart() { await stop(); return start(); }
  async function apply() {   // config change while running: llama-swap watches the file; a restart is only needed when the port changed
    const r = writeConfig();
    if (!pid()) return { ...r, running: false };
    return { ...r, running: true };
  }
  async function status() {
    const s = state(); const det = detect(); const p = pid(); const up = p ? await healthy() : false;
    const run = up ? await running() : [];
    let listed = []; if (up) { try { const r = await http('/v1/models'); listed = ((r.json && r.json.data) || []).map(m => m.id); } catch {} }
    return { enabled: s.enabled, port: s.port, pid: p, running: up, loaded: run, listed, baseUrl: baseUrl(), detect: det, models: s.models, modelsDirs: s.modelsDirs, globalTTL: s.globalTTL, startPort: s.startPort, healthCheckTimeout: s.healthCheckTimeout, llamaServer: s.llamaServer, ninferServe: s.ninferServe, configFile, logFile, llamaCppDir, llamaSwapVersion: LLAMA_SWAP_VERSION };
  }

  // ── install ──
  async function installLlamaSwap() {
    const osName = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null;
    const archName = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'amd64' : null;
    if (!osName || !archName) throw new Error(`no llama-swap release for ${platform}/${arch}`);
    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
    const asset = `llama-swap_${LLAMA_SWAP_VERSION}_${osName}_${archName}.tar.gz`;
    const tgz = path.join(binDir, asset);
    const get = async (u) => { const r = await fetchImpl(u, { redirect: 'follow', signal: AbortSignal.timeout(120000) }); if (!r.ok) throw new Error(`download ${u}: HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()); };
    const sums = (await get(`${LLAMA_SWAP_RELEASE}/llama-swap_${LLAMA_SWAP_VERSION}_checksums.txt`)).toString('utf8');
    const want = (sums.split('\n').find(l => l.trim().endsWith(asset)) || '').trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{64}$/.test(want)) throw new Error('checksum for the release asset not found');
    fs.writeFileSync(tgz, await get(`${LLAMA_SWAP_RELEASE}/${asset}`));
    const got = sha256File(tgz);
    if (got !== want) { fs.unlinkSync(tgz); throw new Error('checksum mismatch: download discarded'); }
    const r = spawnSync('tar', ['-xzf', tgz, '-C', binDir, 'llama-swap'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`extract failed: ${(r.stderr || '').trim()}`);
    fs.chmodSync(path.join(binDir, 'llama-swap'), 0o755); fs.unlinkSync(tgz);
    log(`[local-models] llama-swap v${LLAMA_SWAP_VERSION} installed (${osName}/${archName}, sha256 verified)`);
    return { ok: true, path: path.join(binDir, 'llama-swap'), version: LLAMA_SWAP_VERSION };
  }
  /** The shell command that builds llama.cpp's server for this machine (run by the hub's job runner; 5-15 minutes). */
  function llamaCppBuildCommand() {
    if (platform === 'darwin') return `set -e; if command -v brew >/dev/null; then brew install llama.cpp; else echo "Install Homebrew first (https://brew.sh), then run this again"; exit 1; fi; which llama-server`;
    const det = detect();
    const cudaHome = ['/usr/local/cuda'].concat((() => { try { return fs.readdirSync('/usr/local').filter(d => /^cuda-\d/.test(d)).sort().reverse().map(d => `/usr/local/${d}`); } catch { return []; } })()).find(p => fs.existsSync(path.join(p, 'bin', 'nvcc')));
    const backend = cudaHome ? `-DGGML_CUDA=ON -DCMAKE_CUDA_COMPILER=${cudaHome}/bin/nvcc` : '-DGGML_VULKAN=OFF';
    return [
      'set -e',
      cudaHome ? `export PATH=${cudaHome}/bin:$PATH` : 'true',
      `mkdir -p ${shq(dir)}`,
      `if [ -d ${shq(llamaCppDir)}/.git ]; then git -C ${shq(llamaCppDir)} pull --ff-only; else git clone --depth 1 https://github.com/ggml-org/llama.cpp ${shq(llamaCppDir)}; fi`,
      `cmake -S ${shq(llamaCppDir)} -B ${shq(llamaCppDir)}/build -DCMAKE_BUILD_TYPE=Release ${backend} -DLLAMA_CURL=OFF`,
      `cmake --build ${shq(llamaCppDir)}/build -j $(nproc) --target llama-server llama-mtmd-cli`,
      `ls -la ${shq(llamaCppDir)}/build/bin/llama-server`,
      `echo "llama.cpp built (${cudaHome ? 'CUDA' : det.cmake ? 'CPU' : 'CPU'}): ${llamaCppDir}/build/bin/llama-server"`,
    ].join('\n');
  }

  // ── scanning ──
  function scan(dirs = null) {
    const roots = (dirs || state().modelsDirs).filter(Boolean);
    const found = [];
    const walk = (d, depth) => {
      let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (depth < 5 && !e.name.startsWith('.')) walk(p, depth + 1); continue; }
        if (!e.isFile()) continue;
        const lower = e.name.toLowerCase();
        let kind = null;
        if (lower.endsWith('.gguf')) kind = /mmproj/.test(lower) ? 'mmproj' : /dflash|draft/.test(lower) ? 'draft' : /-\d{5}-of-\d{5}\.gguf$/.test(lower) && !/-00001-of-/.test(lower) ? 'shard' : 'gguf';
        else if (lower.endsWith('.ninfer')) kind = 'ninfer';
        if (!kind || kind === 'shard') continue;
        let size = 0; try { size = fs.statSync(p).size; } catch {}
        found.push({ path: p, name: e.name, kind, size, sizeText: bytesText(size), dir: d, suggestedId: e.name.replace(/\.(gguf|ninfer)$/i, '').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 64) });
      }
    };
    for (const r of roots) walk(r, 0);
    found.sort((a, b) => a.path.localeCompare(b.path));
    return found;
  }
  function defaultModelsDirs() {
    const c = [path.join(home, '.lmstudio', 'models'), path.join(home, 'ninfer-models'), path.join(home, '.cache', 'lm-studio', 'models'), path.join(home, 'models')];
    return c.filter(p => fs.existsSync(p));
  }

  // ── what the rest of the hub asks ──
  function contextFor(modelId) { const m = models.get(String(modelId).replace(/^local\//, '')) || state().models.find(x => (x.aliases || []).includes(String(modelId).replace(/^local\//, ''))); return m && m.ctx > 0 ? m.ctx : null; }
  function maxOutputFor(modelId) { const m = models.get(String(modelId).replace(/^local\//, '')); return m && m.maxOutput > 0 ? m.maxOutput : null; }
  function readinessItems() {
    const s = state(); if (!s.enabled) return [];
    const det = detect(); const items = [];
    if (!det.llamaSwap.path) items.push({ id: 'local-models-proxy', level: 'warn', title: 'Local models: llama-swap is not installed', detail: 'Local models are switched on but the proxy that runs them is missing.', fix: 'Open the Local models page and press Install llama-swap.', action: { label: 'Open Local models', href: '/local-models' } });
    else if (!pid()) items.push({ id: 'local-models-proxy', level: 'warn', title: 'Local models: the proxy is not running', detail: 'Agents on local/… models will fail until it runs.', fix: 'Open the Local models page and press Start.', action: { label: 'Open Local models', href: '/local-models' } });
    if (s.models.some(m => m.engine === 'llama.cpp' && m.enabled !== false) && !det.llamaServer.path) items.push({ id: 'local-models-llama', level: 'warn', title: 'Local models: llama-server is missing', detail: 'GGUF models are configured but no llama.cpp server binary was found.', fix: platform === 'darwin' ? 'brew install llama.cpp, or press Build llama.cpp on the Local models page.' : 'Press Build llama.cpp on the Local models page (needs git, cmake and a compiler; CUDA if present).', action: { label: 'Open Local models', href: '/local-models' } });
    if (s.models.some(m => m.engine === 'ninfer' && m.enabled !== false) && !det.ninferServe.path) items.push({ id: 'local-models-ninfer', level: 'warn', title: 'Local models: ninfer-serve is missing', detail: 'A NInfer model is configured but the engine binary was not found.', fix: 'Set the path to ninfer-serve on the Local models page.', action: { label: 'Open Local models', href: '/local-models' } });
    return items;
  }

  return { state, update, models, detect, cmdFor, renderConfig, writeConfig, start, stop, restart, apply, status, pid, healthy, running, unload, logs, installLlamaSwap, llamaCppBuildCommand, scan, defaultModelsDirs, contextFor, maxOutputFor, readinessItems, baseUrl, files: { stateFile, dir, configFile, logFile, pidFile, llamaCppDir }, LLAMA_SWAP_VERSION, ENGINES };
}

let singleton = null;
function getLocalModels() { if (!singleton) singleton = createLocalModels({ log: (...a) => console.log(...a) }); return singleton; }

module.exports = { createLocalModels, getLocalModels, validateModel, ENGINES, LLAMA_SWAP_VERSION, sha256File };
