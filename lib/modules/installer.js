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

function defaultRunNpm(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, timeout: 300000, maxBuffer: 8 * 1024 * 1024, env: npmEnv() },
      (err, stdout, stderr) => err ? reject(new Error(`npm install failed: ${String(stderr || err.message).slice(-500)}`)) : resolve(`${stdout}\n${stderr}`));
  });
}

function uninstall(dataDir, id) { fs.rmSync(pkgDir(dataDir, id), { recursive: true, force: true }); }

module.exports = { install, uninstall, binPath, pkgDir, nodeSatisfies };
