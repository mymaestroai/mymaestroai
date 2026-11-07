'use strict';
/**
 * Installs a module's tool server from npm into data/modules/<id>/pkg: the exact version the manifest names,
 * lifecycle scripts off (a package's postinstall never runs on this machine), nothing global, nothing in the
 * code tree. Removing the module removes the folder.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function pkgDir(dataDir, id) { return path.join(dataDir, id, 'pkg'); }

/** Path of the installed bin script, or null. */
function binPath(dataDir, id, npm) {
  const root = path.join(pkgDir(dataDir, id), 'node_modules', ...npm.package.split('/'));
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pj.version !== npm.version) return null;
    const rel = typeof pj.bin === 'string' ? pj.bin : pj.bin && pj.bin[npm.bin];
    if (!rel) return null;
    const p = path.join(root, rel);
    return fs.existsSync(p) ? p : null;
  } catch { return null; }
}

function nodeSatisfies(range, version = process.versions.node) {
  const m = String(range || '').match(/^>=\s*(\d+)(?:\.(\d+))?/);
  if (!m) return true;
  const [maj, min] = version.split('.').map(Number);
  const want = [Number(m[1]), Number(m[2] || 0)];
  return maj > want[0] || (maj === want[0] && min >= want[1]);
}

/**
 * install({ dataDir, id, npm, requires }) -> { ok, version, bin, log } ; throws with a readable message.
 * runNpm is injectable for tests.
 */
async function install({ dataDir, id, npm, requires = {}, runNpm = defaultRunNpm }) {
  if (requires.node && !nodeSatisfies(requires.node)) throw new Error(`This module needs Node ${requires.node}; this hub runs Node ${process.versions.node}. Update Node, then try again.`);
  const existing = binPath(dataDir, id, npm);
  if (existing) return { ok: true, version: npm.version, bin: existing, log: 'already installed' };
  const dir = pkgDir(dataDir, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `hub-module-${id}`, private: true }, null, 2));
  const log = await runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `${npm.package}@${npm.version}`], dir);
  const bin = binPath(dataDir, id, npm);
  if (!bin) throw new Error(`npm finished but ${npm.package}@${npm.version} (bin "${npm.bin}") is not there. npm said: ${String(log).slice(-400)}`);
  return { ok: true, version: npm.version, bin, log: String(log).slice(-400) };
}

// npm gets what it needs and nothing else: no provider keys or hub secrets from the hub's environment.
function npmEnv() {
  const env = { npm_config_update_notifier: 'false' };
  for (const k of ['PATH', 'HOME', 'LANG', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'APPDATA', 'USERPROFILE', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']) if (process.env[k] !== undefined) env[k] = process.env[k];
  for (const [k, v] of Object.entries(process.env)) if (/^npm_config_/i.test(k)) env[k] = v;
  return env;
}

function defaultRunNpm(args, cwd, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, timeout: opts.timeoutMs || 300000, maxBuffer: opts.maxBuffer || 8 * 1024 * 1024, env: npmEnv() },
      (err, stdout, stderr) => err ? reject(new Error(`npm ${args[0]} failed: ${String(stderr || err.message).slice(-500)}`)) : resolve(`${stdout}\n${stderr}`));
  });
}

// ── lockfile runtime: a module's own dependencies, installed from its lockfile into data/modules/<id>/runtime ──
const RUNTIME_MARK = '.runtime-installed.json';
const RUNTIME_NEEDS_INSTALL = 'Reinstall needed: open Data connectors and run Install again';
function runtimeDir(dataDir, id) { return path.join(dataDir, id, 'runtime'); }
const sha256File = (f) => require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function lockSource(moduleDir, runtime) { return path.join(path.resolve(moduleDir), runtime.lockfile, 'package-lock.json'); }

/** Is the runtime installed? With { moduleDir, runtime } it must also be the install of the lockfile the module ships now. */
function runtimeInstalled(dataDir, id, { moduleDir, runtime } = {}) {
  try {
    const dir = runtimeDir(dataDir, id);
    const mark = JSON.parse(fs.readFileSync(path.join(dir, RUNTIME_MARK), 'utf8'));
    if (!mark || typeof mark.lockSha256 !== 'string') return false;
    if (sha256File(path.join(dir, 'package-lock.json')) !== mark.lockSha256) return false;
    if (moduleDir && runtime && sha256File(lockSource(moduleDir, runtime)) !== mark.lockSha256) return false;
    // The files must be there too: node_modules, and every top-level dependency at the version the lockfile names
    // (a deleted or half-restored node_modules still carries the mark).
    if (!fs.statSync(path.join(dir, 'node_modules')).isDirectory()) return false;
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
    const pkgs = lock && lock.packages && typeof lock.packages === 'object' ? lock.packages : {};
    const deps = pkgs[''] && pkgs[''].dependencies && typeof pkgs[''].dependencies === 'object' ? Object.keys(pkgs['']['dependencies']) : [];
    const nm = path.join(dir, 'node_modules');
    for (const name of deps) {
      const root = path.resolve(nm, ...String(name).split('/'));
      if (!/^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(name) || path.relative(nm, root).startsWith('..')) return false;
      const locked = pkgs[`node_modules/${name}`] && pkgs[`node_modules/${name}`].version;
      if (typeof locked !== 'string' || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version !== locked) return false;
    }
    return true;
  } catch { return false; }
}

const installing = new Set();   // `${dataDir}|${id}` of the runtime installs that are running: one at a time per module

/**
 * installRuntime({ dataDir, id, moduleDir, runtime, requires, runNpm }) -> { ok, dir, log }. Copies the lockfile folder's package.json and
 * package-lock.json to data/modules/<id>/runtime/ and runs `npm ci --ignore-scripts --omit=dev` there; then records the installed state.
 * runNpm(args, cwd, { timeoutMs, maxBuffer }) is injectable for tests.
 */
async function installRuntime({ dataDir, id, moduleDir, runtime, requires = {}, runNpm = defaultRunNpm }) {
  const { validateRuntime, runtimeTimeoutMs } = require('./manifest');
  const problems = validateRuntime(moduleDir, runtime);
  if (problems.length) throw new Error(problems.join('; '));
  if (requires.node && !nodeSatisfies(requires.node)) throw new Error(`This module needs Node ${requires.node}; this hub runs Node ${process.versions.node}. Update Node, then try again.`);
  const lockKey = `${path.resolve(dataDir)}|${id}`;
  if (installing.has(lockKey)) throw new Error('Install is already running');
  installing.add(lockKey);
  try {
    return await installRuntimeLocked({ dataDir, id, moduleDir, runtime, runNpm, runtimeTimeoutMs });
  } finally { installing.delete(lockKey); }
}

async function installRuntimeLocked({ dataDir, id, moduleDir, runtime, runNpm, runtimeTimeoutMs }) {
  // A runtime whose files are damaged (runtimeInstalled is false) is removed and installed again, never reported as installed.
  if (runtimeInstalled(dataDir, id, { moduleDir, runtime })) return { ok: true, dir: runtimeDir(dataDir, id), log: 'already installed' };
  const src = path.join(path.resolve(moduleDir), runtime.lockfile);
  const dir = runtimeDir(dataDir, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(src, f), path.join(dir, f));
    const log = await runNpm(['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], dir, { timeoutMs: runtimeTimeoutMs(runtime), maxBuffer: 64 * 1024 * 1024 });
    fs.writeFileSync(path.join(dir, RUNTIME_MARK), JSON.stringify({ lockSha256: sha256File(path.join(dir, 'package-lock.json')), installedAt: new Date().toISOString() }), { mode: 0o600 });
    return { ok: true, dir, log: String(log).slice(-400) };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });   // no half install is left looking installed
    throw e;
  }
}

function uninstall(dataDir, id) {
  fs.rmSync(pkgDir(dataDir, id), { recursive: true, force: true });
  fs.rmSync(runtimeDir(dataDir, id), { recursive: true, force: true });
}

module.exports = { install, installRuntime, uninstall, binPath, pkgDir, runtimeDir, runtimeInstalled, nodeSatisfies, RUNTIME_MARK, RUNTIME_NEEDS_INSTALL };
