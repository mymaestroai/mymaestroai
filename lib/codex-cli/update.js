'use strict';
/**
 * Updating Codex (the ChatGPT client) that the hub installed itself, with a way back: the current package is copied
 * aside first, the new one is installed, checked, and if it fails the old one is put back. Never throws.
 */
const fs = require('fs');
const path = require('path');
const { spawn: spawnChild, execFile } = require('child_process');
const { resolveBinary, withNode, discoverModels, loginStatus } = require('./index');
const updateLock = require('./update-lock');
const { codexPrefix, codexInstallArgs, npmFor, INSTALL_TIMEOUT_MS, clearStalePrefixLink, ensurePrefixLink } = require('./setup');

/** installCodex's install, without blocking the hub: the same npm arguments (--ignore-scripts, --before), run as a child
 *  process the hub waits for. -> Promise<{ ok, bin, status }> */
function installCodexAsync({ env = process.env, before = null, npm = npmFor(), timeoutMs = INSTALL_TIMEOUT_MS, termGraceMs = 10000, killWaitMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const runEnv = withNode(env);
    let done = false;
    let timedOut = false;
    let timer = null; let graceTimer = null; let killTimer = null;
    const finish = (status) => {
      if (done) return; done = true;
      clearTimeout(timer); clearTimeout(graceTimer); clearTimeout(killTimer);
      const bin = status === 0 ? resolveBinary(runEnv) : null;
      resolve({ ok: !!bin, bin, status });
    };
    let child;
    try { child = spawnChild(npm, codexInstallArgs(env, before), { env: runEnv, stdio: 'ignore' }); }
    catch { return resolve({ ok: false, bin: null, status: null }); }
    // On the timeout npm is asked to stop (SIGTERM), then killed if it does not; the result comes only once it has exited
    // (or the kill went unanswered for killWaitMs), so nothing is put back while npm still writes into the package.
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      graceTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
        killTimer = setTimeout(() => finish(null), killWaitMs);
        if (killTimer.unref) killTimer.unref();
      }, termGraceMs);
      if (graceTimer.unref) graceTimer.unref();
    }, timeoutMs);
    if (timer.unref) timer.unref();
    child.on('error', () => finish(null));
    child.on('exit', (code) => finish(timedOut ? null : code));
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

/** `codex --version` -> its output, or null (not spawnSync: the hub keeps answering while Codex starts). */
function runVersion(bin, runEnv) {
  return new Promise((resolve) => {
    try { execFile(bin, ['--version'], { env: runEnv, encoding: 'utf8', timeout: 30000 }, (err, stdout) => resolve(err ? null : String(stdout || ''))); }
    catch { resolve(null); }
  });
}

/** Default self-check: `codex --version` works; then, when Codex is logged in, the model list has at least one model
 *  (a signed-out Codex passes on the version alone). run / login / models are injectable for tests. -> boolean */
async function defaultSelfCheck({ env = process.env, run = runVersion, login = loginStatus, models = discoverModels } = {}) {
  const runEnv = withNode(env);
  const bin = resolveBinary(runEnv);
  if (!bin) return false;
  const out = await run(bin, runEnv);
  if (!out || !/[0-9]+\.[0-9]+/.test(out)) return false;
  let st = null;
  try { st = await login({ bin, env: runEnv }); } catch { st = null; }
  if (!st || !st.loggedIn) return true;
  const list = await models({ bin, env: runEnv });
  return Array.isArray(list) && list.length > 0;
}

const reasonOf = (e) => String((e && e.message) || e || 'unknown error').split('\n')[0].slice(0, 200);

// While an update is under way a marker file sits beside the package: written once the kept copy is complete, removed
// only when the update ended (the new one passed, or the old one is back). A marker found later is the only sign of an
// interrupted update (review r4: a missing package, a slow `codex --version` or an uninstall are not).
const markerFile = (env) => path.join(SCOPE(env), '.codex-update-in-progress');

/** Put the kept copy back in place of the package, without a moment with no package where it can be avoided: the
 *  package is moved aside first (rename), the kept copy renamed in, the aside one removed; if the second rename fails
 *  the aside package goes back. Throws when the kept copy could not be put back. */
async function putBack(env, fsImpl, rm) {
  const pkg = pkgDir(env);
  const keep = keepDir(env);
  const aside = `${pkg}.failed-${process.pid}-${require('crypto').randomBytes(4).toString('hex')}`;
  const hadPkg = fsImpl.existsSync(pkg);
  if (hadPkg) fsImpl.renameSync(pkg, aside);
  try { fsImpl.renameSync(keep, pkg); }
  catch (e) {
    if (hadPkg) { try { if (!fsImpl.existsSync(pkg)) fsImpl.renameSync(aside, pkg); } catch { /* reported below */ } }
    throw e;
  }
  try { ensurePrefixLink(env); } catch { /* the package itself is back */ }
  if (hadPkg) { try { await rm(aside, { recursive: true, force: true }); } catch { /* removed at the next recovery */ } }
}

/** Leftover packages moved aside by an earlier put-back that was stopped before it removed them. */
async function clearAside(env, fsImpl, rm) {
  try {
    for (const n of fsImpl.readdirSync(SCOPE(env))) if (/^codex\.failed-/.test(n)) { try { await rm(path.join(SCOPE(env), n), { recursive: true, force: true }); } catch { /* next time */ } }
  } catch { /* no scope folder */ }
}

/**
 * An update stopped half way (the hub restarted or was killed during it) never leaves its new, unchecked package in place:
 * when the marker of an update in progress is there and the kept copy too, the kept copy is put back and the marker
 * removed. Without the marker nothing is touched (a working package, an uninstall, a slow start). Never throws.
 * -> { recovered, error }
 */
async function recoverCodex({ env = process.env, fsImpl = fs } = {}) {
  const rm = (p, o) => (fsImpl === fs ? fs.promises.rm(p, o) : fsImpl.rmSync(p, o));
  try {
    await clearAside(env, fsImpl, rm);
    if (!fsImpl.existsSync(markerFile(env))) return { recovered: false, error: null };
    if (!fsImpl.existsSync(keepDir(env))) { try { fsImpl.unlinkSync(markerFile(env)); } catch { /* none */ } return { recovered: false, error: null }; }
    await putBack(env, fsImpl, rm);
    try { fsImpl.unlinkSync(markerFile(env)); } catch { /* the package is back; the marker goes next time */ }
    return { recovered: true, error: null };
  } catch (e) {
    return { recovered: false, error: reasonOf(e) };
  }
}

/**
 * -> { ok, from, to, rolledBack, error }
 */
async function updateCodex(opts = {}) {
  if (!updateLock.begin()) return { ok: false, from: null, to: null, rolledBack: false, error: 'A Codex update is already running.' };
  try { return await updateCodexLocked(opts); }
  catch (e) { return { ok: false, from: null, to: null, rolledBack: false, error: `Codex update failed: ${reasonOf(e)}` }; }
  finally { updateLock.end(); }
}

async function updateCodexLocked({ env = process.env, before = null, install = installCodexAsync, selfCheck = defaultSelfCheck, fsImpl = fs, log = () => {}, recover = recoverCodex } = {}) {
  // The package is large (it carries Codex's own binaries): copied and removed without blocking the hub where fs allows.
  // (an injected fs, in tests, is used through its sync calls as given)
  const cp = (a, b, o) => (fsImpl === fs ? fs.promises.cp(a, b, o) : fsImpl.cpSync(a, b, o));
  const rm = (p, o) => (fsImpl === fs ? fs.promises.rm(p, o) : fsImpl.rmSync(p, o));
  let from = null;
  let to = null;
  try {
    // An interrupted earlier update is put right first: the broken package is never copied over the good kept one.
    const rc = await recover({ env, fsImpl });
    if (rc && rc.recovered) log('Codex update: an interrupted update was recovered first.');
    // A recovery that failed leaves the marker: the kept copy may be the only good one, so nothing goes on (review r5).
    if (fsImpl.existsSync(markerFile(env))) {
      return { ok: false, from: null, to: null, rolledBack: false, error: `An earlier Codex update could not be undone (${(rc && rc.error) || 'the old version could not be put back'}), so nothing changed. Check the folder ${SCOPE(env)}.` };
    }
    from = installedCodexVersion({ env, fsImpl });
    if (!from) return { ok: false, from: null, to: null, rolledBack: false, error: 'Codex is not installed here.' };

    const pkg = pkgDir(env);
    const keep = keepDir(env);
    try {
      await rm(keep, { recursive: true, force: true });
      await cp(pkg, keep, { recursive: true, verbatimSymlinks: true });
      // the copy is complete: from here an interruption is recovered from it (recoverCodex)
      fsImpl.writeFileSync(markerFile(env), JSON.stringify({ from, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    } catch (e) {
      log(`Codex update: could not copy the current package: ${reasonOf(e)}`);
      try { fsImpl.unlinkSync(markerFile(env)); } catch { /* not written */ }
      try { await rm(keep, { recursive: true, force: true }); } catch { /* nothing to clean */ }
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
    if (!failed) {
      // The marker must go, or the next start would put the old version back over this good one (review r5): when it
      // cannot be removed, the kept copy goes instead, so a recovery has nothing to restore.
      try { fsImpl.unlinkSync(markerFile(env)); } catch { /* checked below */ }
      if (fsImpl.existsSync(markerFile(env))) {
        try { await rm(keep, { recursive: true, force: true }); } catch (e) { log(`Codex update: neither the marker nor the kept copy could be removed: ${reasonOf(e)}`); }
      }
      return { ok: true, from, to, rolledBack: false, error: null };
    }

    // Put the previous package back (the marker stays if that fails, so the next start or update tries again).
    const label = to && to !== from ? `The new Codex ${to}` : 'The new Codex';
    try {
      await putBack(env, fsImpl, rm);
      try { fsImpl.unlinkSync(markerFile(env)); } catch { /* gone already */ }
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

module.exports = { installedCodexVersion, updateCodex, recoverCodex, defaultSelfCheck, installCodexAsync };
