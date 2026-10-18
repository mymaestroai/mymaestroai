// ── Claude Agent SDK loader ─────────────────────────────────────────────
// The hub should always run the newest @anthropic-ai/claude-agent-sdk that is
// installed on this machine, regardless of which copy happens to sit in the
// hub's own node_modules. Several copies can coexist:
//
//   • hub-local     ./node_modules/@anthropic-ai/claude-agent-sdk
//   • npm global    $(npm root -g)/@anthropic-ai/claude-agent-sdk
//   • sdk bridge    ./workspace/tools/claude-sdk-bridge/node_modules/...
//   • explicit      $CLAUDE_SDK_PATH  (directory containing package.json)
//
// We read each candidate's package.json, pick the highest semver, and import
// that copy directly by file URL. CLAUDE_SDK_PATH, if set and valid, always
// wins so an operator can pin a specific build for testing.
//
// Every place in the hub that previously did
//     await import('@anthropic-ai/claude-agent-sdk')
// should call loadSdk() instead so the whole process agrees on one copy.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { pathToFileURL } = require('url');

const PKG = '@anthropic-ai/claude-agent-sdk';
const CLI_PKG = '@anthropic-ai/claude-code';
const HUB_DIR = path.resolve(__dirname, '..');

let sdkModule = null;      // cached ESM namespace
let resolved = null;       // cached resolution result
let resolvedCli;           // cached CLI resolution (undefined = not yet, null = none)

// Minimal semver compare — avoids depending on the transitive `semver` pkg.
// Handles "0.3.270", "1.0.0-beta.2" (pre-release sorts below release).
function compareVersions(a, b) {
  const pa = String(a).split('-'), pb = String(b).split('-');
  const na = pa[0].split('.').map(n => parseInt(n, 10) || 0);
  const nb = pb[0].split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] || 0) - (nb[i] || 0);
    if (d !== 0) return d;
  }
  if (pa[1] && !pb[1]) return -1;
  if (!pa[1] && pb[1]) return 1;
  if (pa[1] && pb[1]) return pa[1].localeCompare(pb[1]);
  return 0;
}

function readVersion(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (pkg.name !== PKG || !pkg.version) return null;
    const entry = path.join(dir, pkg.main || 'sdk.mjs');
    if (!fs.existsSync(entry)) return null;
    return { version: pkg.version, entry };
  } catch {
    return null;
  }
}

function globalNpmRoot() {
  // Cheap paths first: env prefix, then ~/.npmrc prefix, then ask npm.
  const prefix = process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX;
  if (prefix) return path.join(prefix, 'lib', 'node_modules');
  try {
    const rc = fs.readFileSync(path.join(process.env.HOME || '', '.npmrc'), 'utf8');
    const m = rc.match(/^\s*prefix\s*=\s*(.+?)\s*$/m);
    if (m) return path.join(m[1].replace(/^~/, process.env.HOME || ''), 'lib', 'node_modules');
  } catch { /* no ~/.npmrc */ }
  try {
    return execSync('npm root -g', { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function candidateDirs() {
  const dirs = [];
  const add = (source, dir) => { if (dir) dirs.push({ source, dir: path.resolve(dir) }); };

  add('CLAUDE_SDK_PATH', process.env.CLAUDE_SDK_PATH);
  add('hub-local', path.join(HUB_DIR, 'node_modules', PKG));
  add('sdk-bridge', path.join(HUB_DIR, 'workspace', 'tools', 'claude-sdk-bridge', 'node_modules', PKG));
  const g = globalNpmRoot();
  if (g) add('npm-global', path.join(g, PKG));
  return dirs;
}

/**
 * Resolve which SDK copy to use. Pure/sync; safe to call from tests.
 * @returns {{version:string, entry:string, source:string, candidates:Array}}
 */
function resolveSdk({ force = false } = {}) {
  if (resolved && !force) return resolved;

  const seen = new Set();
  const candidates = [];
  for (const { source, dir } of candidateDirs()) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const info = readVersion(dir);
    if (info) candidates.push({ source, dir, ...info });
  }

  if (candidates.length === 0) {
    throw new Error(`[sdk] ${PKG} is not installed anywhere on this machine — run "npm install" in ${HUB_DIR}`);
  }

  // Explicit override wins outright; otherwise the hub's own installed copy (package-lock pinned, installed by
  // the hub's own Update). Only when that is missing (a release tarball without node_modules) does the newest copy
  // found elsewhere on the machine serve. Before this the newest copy always won, so an `npm install -g` by any
  // process with a shell replaced the code the hub runs its agents through (review F24).
  const pinned = candidates.find(c => c.source === 'CLAUDE_SDK_PATH');
  const local = candidates.find(c => c.source === 'hub-local');
  const best = pinned || local || candidates.slice().sort((a, b) => compareVersions(b.version, a.version))[0];

  resolved = { ...best, candidates };
  return resolved;
}

/**
 * Import the chosen SDK once and cache the module namespace.
 * Drop-in replacement for `await import('@anthropic-ai/claude-agent-sdk')`.
 */
async function loadSdk() {
  if (sdkModule) return sdkModule;
  const r = resolveSdk();
  const others = r.candidates
    .filter(c => c.dir !== r.dir)
    .map(c => `${c.source} ${c.version}`)
    .join(', ');
  console.log(
    `[sdk] Using ${PKG} ${r.version} (${r.source}: ${r.dir})` +
    (others ? ` — other copies ignored: ${others}` : '')
  );
  sdkModule = await import(pathToFileURL(r.entry).href);
  return sdkModule;
}

// ── Claude client binary ────────────────────────────────────────────────
// The agent SDK is only a protocol wrapper: it spawns a Claude Code client
// and talks to it. By default it spawns the client embedded in its own
// package, which is why updating the terminal `claude` did nothing for the
// hub — and why the API refused newer models with
//   "Claude Code 2.1.270 does not support this model; 2.1.280 or newer is
//    required. Run 'claude update'".
//
// So we point the SDK at the globally installed @anthropic-ai/claude-code
// binary via query()'s `pathToClaudeCodeExecutable`. One client on the box,
// and `claude update` updates the hub too. If no global install exists
// (third-party installs from the release tarball), we resolve to null and
// the SDK keeps using its embedded copy — nothing breaks.

const CLI_BIN = path.join('bin', 'claude.exe');

// Package versions pair up: agent-sdk 0.3.N ships client 2.1.N. Used only to
// refuse an EXTERNAL client that is older than the embedded one, so a stale
// global install can't silently downgrade the hub.
function impliedClientVersion(sdkVersion) {
  const m = /^0\.3\.(\d+)$/.exec(String(sdkVersion || ''));
  return m ? `2.1.${m[1]}` : null;
}

function cliInfo(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (pkg.name !== CLI_PKG) return null;
    const rel = (pkg.bin && (typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.claude)) || CLI_BIN;
    const bin = path.join(dir, rel);
    if (!fs.existsSync(bin)) return null;
    return { bin, version: pkg.version || null };
  } catch {
    return null;
  }
}

function cliCandidates() {
  const out = [];
  const add = (source, dir) => { if (dir) out.push({ source, dir: path.resolve(dir) }); };

  // An explicit pin may point at the package dir or straight at the binary.
  const pin = process.env.CLAUDE_CLI_PATH;
  if (pin) {
    const p = path.resolve(pin);
    add('CLAUDE_CLI_PATH', fs.existsSync(path.join(p, 'package.json')) ? p : path.dirname(path.dirname(p)));
  }
  const g = globalNpmRoot();
  if (g) add('npm-global', path.join(g, CLI_PKG));
  add('hub-local', path.join(HUB_DIR, 'node_modules', CLI_PKG));
  return out;
}

/**
 * Resolve the external Claude client binary, or null to let the SDK use its
 * own embedded copy. Sync; safe to call from tests.
 * @returns {{bin:string, version:string|null, source:string}|null}
 */
function resolveCli({ force = false } = {}) {
  if (resolvedCli !== undefined && !force) return resolvedCli;

  // An explicit pin bypasses the version guard entirely.
  let pinned = null, best = null;
  const seen = new Set();
  for (const { source, dir } of cliCandidates()) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const info = cliInfo(dir);
    if (!info) continue;
    const cand = { ...info, source, dir };
    if (source === 'CLAUDE_CLI_PATH') { pinned = cand; break; }
    if (!best || compareVersions(cand.version, best.version) > 0) best = cand;
  }

  let chosen = pinned || best;
  if (chosen && !pinned) {
    let embedded = null;
    try { embedded = impliedClientVersion(resolveSdk().version); } catch { /* no sdk yet */ }
    if (embedded && chosen.version && compareVersions(chosen.version, embedded) < 0) {
      console.log(
        `[sdk] Ignoring ${CLI_PKG} ${chosen.version} (${chosen.source}) — older than the ` +
        `client embedded in the SDK (${embedded}). Run "claude update" to unify them.`
      );
      chosen = null;
    }
  }

  if (chosen) {
    console.log(`[sdk] Using Claude client ${chosen.version || '(unknown version)'} (${chosen.source}: ${chosen.bin})`);
  } else {
    console.log('[sdk] No external Claude client found — using the one embedded in the SDK');
  }

  resolvedCli = chosen || null;
  return resolvedCli;
}

/**
 * query() options that pin the client binary. Spread into every options
 * object the hub passes to sdk.query():  { ...opts, ...cliOptions() }
 */
function cliOptions() {
  const cli = resolveCli();
  return cli ? { pathToClaudeCodeExecutable: cli.bin } : {};
}

module.exports = { loadSdk, resolveSdk, resolveCli, cliOptions, compareVersions, PKG, CLI_PKG };
