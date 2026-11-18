'use strict';
/**
 * Where My Maestro AI installs and finds Codex (the ChatGPT client): one place for `mymaestro connect chatgpt`, the
 * installer's check after it replaces its own Node.js, readiness and `mymaestro doctor`.
 *
 * Codex goes into ~/.npm-global (npm --prefix), outside the Node.js folder the installer owns (~/.mymaestroai/node):
 * the installer replaces that whole folder when it updates Node.js, and anything installed with that Node's own npm
 * (`npm i -g`) went with it. Nothing here reads or writes ~/.codex (Codex's own sign-in).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveBinary, withNode } = require('./index');

const FIX_COMMAND = 'mymaestro connect chatgpt';

function homeOf(env = process.env) { return env.HOME || os.homedir(); }
/** The prefix Codex is installed into (its program is <prefix>/bin/codex). */
function codexPrefix(env = process.env) { return path.join(homeOf(env), '.npm-global'); }

/** Does this install use Codex: an agent on a codex-cli/ model, a codex link left in binDirs (even a broken one), or a
 *  ChatGPT sign-in folder (its presence checked, never read)? */
function codexNeeded({ env = process.env, dataDir = null, binDirs = [] } = {}) {
  if (dataDir) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'agents.json'), 'utf8'));
      const list = Array.isArray(raw) ? raw : Object.values(raw || {});
      if (list.some(a => a && /^codex-cli\//.test(String(a.model || '')))) return true;
    } catch { /* no agents file yet */ }
  }
  for (const dir of binDirs) { if (!dir) continue; try { fs.lstatSync(path.join(dir, 'codex')); return true; } catch { /* none */ } }
  try { return fs.statSync(path.join(homeOf(env), '.codex')).isDirectory(); } catch { return false; }
}

/** The npm to install with: this install's own (beside its Node), else the one on PATH. */
function npmFor(execPath = process.execPath) {
  const own = path.join(path.dirname(execPath), 'npm');
  return fs.existsSync(own) ? own : 'npm';
}

/**
 * Install Codex into codexPrefix() with npm --ignore-scripts (no install scripts run), then find it.
 * -> { ok, bin, status }
 */
function installCodex({ env = process.env, npm = npmFor(), stdio = 'inherit', spawn = spawnSync } = {}) {
  const runEnv = withNode(env);
  const r = spawn(npm, ['install', '-g', '--prefix', codexPrefix(env), '@openai/codex', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { stdio, env: runEnv });
  const bin = r && r.status === 0 ? resolveBinary(runEnv) : null;
  return { ok: !!bin, bin, status: r ? r.status : null };
}

/**
 * Links named `codex` in binDirs that no longer lead anywhere (they pointed into a replaced Node.js folder) are pointed
 * at the codex in codexPrefix(), when it is there. A link that still works, or a file that is no link, is left alone.
 * -> the links repointed
 */
function repairLinks({ env = process.env, binDirs = [] } = {}) {
  const target = path.join(codexPrefix(env), 'bin', 'codex');
  if (!fs.existsSync(target)) return [];
  const fixed = [];
  for (const dir of binDirs) {
    if (!dir) continue;
    const link = path.join(dir, 'codex');
    let st;
    try { st = fs.lstatSync(link); } catch { continue; }
    if (!st.isSymbolicLink() || fs.existsSync(link)) continue;   // a working link or a real file: not ours to change
    try {
      const tmp = `${link}.mm-new`;
      try { fs.unlinkSync(tmp); } catch { /* none */ }
      fs.symlinkSync(target, tmp);
      fs.renameSync(tmp, link);
      fixed.push(link);
    } catch { /* leave it; the check reports Codex as missing */ }
  }
  return fixed;
}

/**
 * The check after an install or update: does Codex resolve where this install needs it? With repair, a dangling link is
 * repointed and a missing Codex is installed into codexPrefix().
 * -> { needed, bin, relinked: [], installed: bool, fix: string|null }
 */
function checkCodex({ env = process.env, dataDir = null, binDirs = [], repair = false, install = installCodex } = {}) {
  const needed = codexNeeded({ env, dataDir, binDirs });
  const relinked = repair ? repairLinks({ env, binDirs }) : [];
  let bin = resolveBinary(withNode(env));
  let installed = false;
  if (needed && !bin && repair) {
    const r = install({ env });
    installed = !!(r && r.ok);
    bin = installed ? r.bin : null;
    if (installed) relinked.push(...repairLinks({ env, binDirs }));
  }
  return { needed, bin, relinked, installed, fix: needed && !bin ? FIX_COMMAND : null };
}

module.exports = { FIX_COMMAND, codexPrefix, codexNeeded, npmFor, installCodex, repairLinks, checkCodex };
