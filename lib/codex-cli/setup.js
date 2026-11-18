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

/** The installer's own Node.js folders (a link into one of them was left by an npm -g there): the default, plus any given. */
function nodeDirsOf(env = process.env, extra = []) {
  return [...new Set([path.join(homeOf(env), '.mymaestroai', 'node'), ...extra.filter(Boolean)].map(d => path.resolve(d)))];
}
/** Where a symlink points, as an absolute path (resolved against its folder; the target need not exist). */
function linkTarget(link) {
  try { return path.resolve(path.dirname(link), fs.readlinkSync(link)); } catch { return null; }
}
const under = (p, dir) => p === dir || p.startsWith(dir + path.sep);

/**
 * Does this install use Codex, and should a missing Codex be put back by itself?
 * - agent: an agent on a codex-cli/ model;
 * - link: a `codex` link in binDirs that points into the installer's Node.js folder (left by an npm -g there);
 * - signIn: a ~/.codex folder (its presence checked, never read): reported, but not on its own a reason to install,
 *   since other Codex programs (the desktop app, an editor extension) make one too.
 * -> { needed, autoInstall, agent, link, signIn }
 */
function codexUse({ env = process.env, dataDir = null, binDirs = [], nodeDirs = [] } = {}) {
  let agent = false;
  if (dataDir) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'agents.json'), 'utf8'));
      const list = Array.isArray(raw) ? raw : Object.values(raw || {});
      agent = list.some(a => a && /^codex-cli\//.test(String(a.model || '')));
    } catch { /* no agents file yet */ }
  }
  const dirs = nodeDirsOf(env, nodeDirs);
  const link = binDirs.some((d) => { if (!d) return false; const t = linkTarget(path.join(d, 'codex')); return !!t && dirs.some(n => under(t, n)); });
  let signIn = false;
  try { signIn = fs.statSync(path.join(homeOf(env), '.codex')).isDirectory(); } catch { /* none */ }
  return { needed: agent || link || signIn, autoInstall: agent || link, agent, link, signIn };
}
/** Does this install use Codex (codexUse().needed)? */
function codexNeeded(opts = {}) { return codexUse(opts).needed; }

/** The npm to install with: this install's own (beside its Node), else the one on PATH. */
function npmFor(execPath = process.execPath) {
  const own = path.join(path.dirname(execPath), 'npm');
  return fs.existsSync(own) ? own : 'npm';
}

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * Install Codex into codexPrefix() with npm --ignore-scripts (no install scripts run), then find it. before (a Date):
 * take only a release published before then (npm --before), for installs nobody is watching.
 * -> { ok, bin, status }
 */
function installCodex({ env = process.env, npm = npmFor(), stdio = 'inherit', spawn = spawnSync, before = null, timeoutMs = INSTALL_TIMEOUT_MS } = {}) {
  const runEnv = withNode(env);
  const args = ['install', '-g', '--prefix', codexPrefix(env), '@openai/codex', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'];
  if (before instanceof Date && !Number.isNaN(before.getTime())) args.push(`--before=${before.toISOString()}`);
  const r = spawn(npm, args, { stdio, env: runEnv, timeout: timeoutMs });
  const bin = r && r.status === 0 ? resolveBinary(runEnv) : null;
  return { ok: !!bin, bin, status: r ? r.status : null };
}

/**
 * Links named `codex` in binDirs that no longer lead anywhere AND point into the installer's Node.js folder (an npm -g
 * there, replaced by an update) are pointed at the codex in codexPrefix(), when it is there. Any other link (the
 * user's own, a working one) and any file are left alone. The new link is made under a fresh name (created only if
 * nothing is there) and renamed over the old one; nothing else is ever removed.
 * -> the links repointed
 */
function repairLinks({ env = process.env, binDirs = [], nodeDirs = [] } = {}) {
  const target = path.join(codexPrefix(env), 'bin', 'codex');
  if (!fs.existsSync(target)) return [];
  const dirs = nodeDirsOf(env, nodeDirs);
  const fixed = [];
  for (const dir of binDirs) {
    if (!dir) continue;
    const link = path.join(dir, 'codex');
    let st;
    try { st = fs.lstatSync(link); } catch { continue; }
    if (!st.isSymbolicLink() || fs.existsSync(link)) continue;   // a working link or a real file: not ours to change
    const old = linkTarget(link);
    if (!old || !dirs.some(n => under(old, n))) continue;       // not one left by the installer's Node.js: the user's
    const tmp = `${link}.mm-${process.pid}-${require('crypto').randomBytes(4).toString('hex')}`;
    try {
      fs.symlinkSync(target, tmp);          // fails if anything has that name: then nothing is touched
      fs.renameSync(tmp, link);
      fixed.push(link);
    } catch { try { if (fs.lstatSync(tmp).isSymbolicLink() && fs.readlinkSync(tmp) === target) fs.unlinkSync(tmp); } catch { /* none */ } }
  }
  return fixed;
}

/**
 * npm's own link ~/.npm-global/bin/codex left dangling (its package gone): it would make a reinstall fail (EEXIST).
 * Only a symlink that points into ~/.npm-global/lib/node_modules is cleared.
 */
function clearStalePrefixLink(env = process.env) {
  const link = path.join(codexPrefix(env), 'bin', 'codex');
  try {
    if (!fs.lstatSync(link).isSymbolicLink() || fs.existsSync(link)) return false;
    const t = linkTarget(link);
    if (!t || !under(t, path.join(codexPrefix(env), 'lib', 'node_modules'))) return false;
    fs.unlinkSync(link);
    return true;
  } catch { return false; }
}

/**
 * The codex package is in ~/.npm-global but nothing is at bin/codex (an installer run stopped just before linking it):
 * link it as npm does (bin/codex -> ../lib/node_modules/@openai/codex/<its bin entry>). Never replaces anything there.
 */
function ensurePrefixLink(env = process.env) {
  const pre = codexPrefix(env);
  const pkg = path.join(pre, 'lib', 'node_modules', '@openai', 'codex', 'package.json');
  const link = path.join(pre, 'bin', 'codex');
  try { fs.lstatSync(link); return false; } catch { /* nothing there */ }
  let rel = 'bin/codex.js';
  try {
    const b = JSON.parse(fs.readFileSync(pkg, 'utf8')).bin;
    const v = typeof b === 'string' ? b : (b && b.codex);
    if (typeof v === 'string' && v) rel = v;
  } catch { return false; }   // no package: nothing to link
  if (path.isAbsolute(rel) || rel.includes('..')) return false;
  try { if (!fs.statSync(path.join(path.dirname(pkg), rel)).isFile()) return false; } catch { return false; }
  try { fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(path.join('..', 'lib', 'node_modules', '@openai', 'codex', rel), link); return true; } catch { return false; }
}

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * The check after an install or update: does Codex resolve where this install needs it? With repair, a link left by the
 * installer's Node.js is repointed, and a missing Codex is reinstalled into codexPrefix() when an agent uses it or such
 * a link shows it was in use (a ~/.codex folder alone is only reported). An automatic reinstall takes a release at
 * least a day old.
 * -> { needed, inUse, bin, relinked: [], installed: bool, fix: string|null }
 */
function checkCodex({ env = process.env, dataDir = null, binDirs = [], nodeDirs = [], repair = false, install = installCodex, now = Date.now() } = {}) {
  const use = codexUse({ env, dataDir, binDirs, nodeDirs });
  if (repair) ensurePrefixLink(env);
  const relinked = repair ? repairLinks({ env, binDirs, nodeDirs }) : [];
  let bin = resolveBinary(withNode(env));
  let installed = false;
  if (use.autoInstall && !bin && repair) {
    clearStalePrefixLink(env);
    const r = install({ env, before: new Date(now - DAY_MS) });
    installed = !!(r && r.ok);
    bin = installed ? r.bin : null;
    if (installed) relinked.push(...repairLinks({ env, binDirs, nodeDirs }));
  }
  // inUse: an agent or a link left behind (not just a sign-in folder another Codex program made)
  return { needed: use.needed, inUse: use.autoInstall, bin, relinked, installed, fix: use.needed && !bin ? FIX_COMMAND : null };
}

module.exports = { FIX_COMMAND, codexPrefix, codexUse, codexNeeded, npmFor, installCodex, repairLinks, clearStalePrefixLink, ensurePrefixLink, checkCodex };
