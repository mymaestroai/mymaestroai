'use strict';
/**
 * Updating Codex (the ChatGPT client) that the hub installed itself, with a way back: the current package is copied
 * aside first, the new one is installed, checked, and if it fails the old one is put back. Never throws.
 */
const fs = require('fs');
const path = require('path');
const { spawn: spawnChild, execFile } = require('child_process');
const { resolveBinary, withNode, discoverModels } = require('./index');
const { codexPrefix, codexInstallArgs, npmFor, INSTALL_TIMEOUT_MS, clearStalePrefixLink, ensurePrefixLink } = require('./setup');

/** installCodex's install, without blocking the hub: the same npm arguments (--ignore-scripts, --before), run as a child
 *  process the hub waits for. -> Promise<{ ok, bin, status }> */
function installCodexAsync({ env = process.env, before = null, npm = npmFor(), timeoutMs = INSTALL_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const runEnv = withNode(env);
    let done = false;
    const finish = (status) => { if (done) return; done = true; clearTimeout(timer); const bin = status === 0 ? resolveBinary(runEnv) : null; resolve({ ok: !!bin, bin, status }); };
    let child;
    try { child = spawnChild(npm, codexInstallArgs(env, before), { env: runEnv, stdio: 'ignore' }); }
    catch { return resolve({ ok: false, bin: null, status: null }); }
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } finish(null); }, timeoutMs);
    if (timer.unref) timer.unref();
    child.on('error', () => finish(null));
    child.on('exit', (code) => finish(code));
  });
}

const SCOPE = (env) => path.join(codexPrefix(env), 'lib', 'node_modules', '@openai');
const pkgDir = (env) => path.join(SCOPE(env), 'codex');
const keepDir = (env) => path.join(SCOPE(env), '.codex-previous');

/** The installed Codex version (from its package.json under codexPrefix), or null. */
function installedCodexVersion({ env = process.env, fsImpl = fs } = {}) {
  try {
    const v = JSON.parse(fsImpl.readFileSync(path.join(pkgDir(env), 'package.json'), 'utf8')).version;
    return typeof v === 'string' && v ? v : null;
  } catch { return null; }
}

/** Default self-check: `codex --version` works and the model list has at least one model. -> boolean */
async function defaultSelfCheck({ env = process.env } = {}) {
  const runEnv = withNode(env);
  const bin = resolveBinary(runEnv);
  if (!bin) return false;
  const out = await new Promise((resolve) => {   // not spawnSync: the hub keeps answering while Codex starts
    try { execFile(bin, ['--version'], { env: runEnv, encoding: 'utf8', timeout: 30000 }, (err, stdout) => resolve(err ? null : String(stdout || ''))); }
    catch { resolve(null); }
  });
  if (!out || !/[0-9]+\.[0-9]+/.test(out)) return false;
  const models = await discoverModels({ bin, env: runEnv });
  return Array.isArray(models) && models.length > 0;
}

const reasonOf = (e) => String((e && e.message) || e || 'unknown error').split('\n')[0].slice(0, 200);

/**
 * -> { ok, from, to, rolledBack, error }
 */
async function updateCodex({ env = process.env, before = null, install = installCodexAsync, selfCheck = defaultSelfCheck, fsImpl = fs, log = () => {} } = {}) {
  // The package is large (it carries Codex's own binaries): copied and removed without blocking the hub where fs allows.
  // (an injected fs, in tests, is used through its sync calls as given)
  const cp = (a, b, o) => (fsImpl === fs ? fs.promises.cp(a, b, o) : fsImpl.cpSync(a, b, o));
  const rm = (p, o) => (fsImpl === fs ? fs.promises.rm(p, o) : fsImpl.rmSync(p, o));
  let from = null;
  let to = null;
  try {
    from = installedCodexVersion({ env, fsImpl });
    if (!from) return { ok: false, from: null, to: null, rolledBack: false, error: 'Codex is not installed here.' };

    const pkg = pkgDir(env);
    const keep = keepDir(env);
    try {
      await rm(keep, { recursive: true, force: true });
      await cp(pkg, keep, { recursive: true, verbatimSymlinks: true });
    } catch (e) {
      log(`Codex update: could not copy the current package: ${reasonOf(e)}`);
      try { fsImpl.rmSync(keep, { recursive: true, force: true }); } catch { /* nothing to clean */ }
      return { ok: false, from, to: null, rolledBack: false, error: "Couldn't keep a copy of the current Codex, so nothing changed." };
    }

    let failed = false;
    try {
      clearStalePrefixLink(env);
      const r = await install({ env, before, stdio: 'pipe' });
      if (!r || r.ok === false) failed = true;
      to = installedCodexVersion({ env, fsImpl });
      if (!failed && !to) failed = true;
      if (!failed) failed = !(await selfCheck({ env }));
    } catch (e) {
      log(`Codex update: ${reasonOf(e)}`);
      failed = true;
      if (!to) { try { to = installedCodexVersion({ env, fsImpl }); } catch { /* none */ } }
    }
    if (!failed) return { ok: true, from, to, rolledBack: false, error: null };

    // Put the previous package back.
    const label = to && to !== from ? `The new Codex ${to}` : 'The new Codex';
    try {
      await rm(pkg, { recursive: true, force: true });
      fsImpl.renameSync(keep, pkg);
      ensurePrefixLink(env);
    } catch (e) {
      log(`Codex update: putting ${from} back failed: ${reasonOf(e)}`);
      return { ok: false, from, to, rolledBack: false, error: `${label} failed its check, and putting ${from} back failed: ${reasonOf(e)}` };
    }
    let works = false;
    try { works = !!(await selfCheck({ env })); } catch { works = false; }
    return {
      ok: false, from, to, rolledBack: works,
      error: works ? `${label} failed its check, so ${from} was put back.` : `${label} failed its check, and ${from} was put back but does not work either.`,
    };
  } catch (e) {
    return { ok: false, from, to, rolledBack: false, error: `Codex update failed: ${reasonOf(e)}` };
  }
}

module.exports = { installedCodexVersion, updateCodex, defaultSelfCheck, installCodexAsync };
