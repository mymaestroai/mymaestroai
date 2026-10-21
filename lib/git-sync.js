'use strict';

/**
 * git-sync.js — "Update from GitHub" support for the UI button.
 *
 * Pull-only by design. There is deliberately no push here: publishing is a
 * judgment call (what to include, what the message says) and a one-click
 * push is how private agent data and credentials end up in a public repo.
 *
 * The update refuses rather than forces. A hard reset would be simpler, but
 * this runs on development machines too, where it would silently destroy
 * uncommitted work. If the tree isn't clean we report why and stop.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');

const REPO_DIR = path.join(__dirname, '..');

// Never let git block on a credential prompt — it would hang the request.
// GIT_ASKPASS used to be `echo`, which answered GitHub's credential request with the prompt
// text itself: a guaranteed and misleading "Authentication failed". Leave it empty so git
// uses the credentials the clone was made with (credential helper or SSH key) or fails honestly.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new' };

function git(args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: REPO_DIR, env: GIT_ENV, timeout, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message || '').trim();
          return reject(new Error(msg.slice(0, 400) || `git ${args[0]} failed`));
        }
        // trimEnd, not trim: `status --porcelain` encodes state in the first
        // two columns, so a leading space is significant. Trimming the front
        // would eat it on the first line and shift that filename by a char.
        resolve(stdout.trimEnd());
      });
  });
}

/** Current branch name, or null on a detached HEAD. */
async function currentBranch() {
  const b = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  return b === 'HEAD' ? null : b;
}

/** Where the code stands before an update moves it: a failed package install puts it back here. */
async function position() {
  return { head: await git(['rev-parse', 'HEAD']), branch: await currentBranch() };
}

// ── Packages ─────────────────────────────────────────────────────────
// An update that changes package.json or package-lock.json installs the packages the way install/install.sh does:
// `npm ci --omit=dev --ignore-scripts` (exactly the lockfile, no install scripts, the lockfile never rewritten), then
// a rebuild of the one native module. It runs in a side folder with the npm that ships with the hub's own Node, and
// the new folder replaces node_modules only once every dependency is there and the native module loads. If anything
// fails, the update puts the code back and reports failure, so the pages never restart the hub into code whose
// packages are missing (they restart only on success). Since the packages are prepared before the code moves, a hub
// stopped during a slow install keeps its old code and packages; what remains is the code move itself (one git
// command) and the two renames of the swap.
const STAGE_DIR = path.join(REPO_DIR, '.update-staging');
const NATIVE_MODULE = 'better-sqlite3';   // built after the scriptless install, as install/install.sh does

/** The npm next to the Node running the hub (the installer's Node ships one), else npm on PATH. HUB_NPM overrides. */
function npmCommand() {
  if (process.env.HUB_NPM) return process.env.HUB_NPM;
  const local = path.join(path.dirname(process.execPath), 'npm');
  return fs.existsSync(local) ? local : 'npm';
}

// npm's environment is an allow-list: what npm, its cache, proxies, certificates and a native build need. Not the
// hub's keys and tokens, and not the desktop session (SSH agent, keyring bus, display). The one install script that
// runs (the native module's) still runs as this user and could read its files; this only keeps secrets out of its env.
const NPM_ENV_KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_\w+|TERM|TZ|TMPDIR|TMP|TEMP|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|SSL_CERT_(FILE|DIR)|NODE_EXTRA_CA_CERTS|CC|CXX|PYTHON|MAKE|XDG_(CACHE|CONFIG)_HOME|npm_config_\w+|NPM_CONFIG_\w+)$/;
function npmEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (NPM_ENV_KEEP.test(k) && !/auth|token|password|secret/i.test(k)) env[k] = v;
  env.PATH = path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '');
  return env;
}

/** Exists, even as a dangling symlink (existsSync follows links and would say no). */
function present(p) { try { fs.lstatSync(p); return true; } catch { return false; } }

/** Dependencies of package.json that node_modules lacks (a damaged install). */
function missingPackages() {
  let deps = [];
  try { deps = Object.keys(JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8')).dependencies || {}); } catch { return []; }
  return deps.filter(d => !fs.existsSync(path.join(REPO_DIR, 'node_modules', d, 'package.json')));
}

/** The reason in npm's (or node's) error output, without the boilerplate: "E404: 404 Not Found - GET …". */
function failureText(stderr, fallback) {
  const lines = String(stderr || '').split('\n')
    .map(l => l.replace(/^npm (?:error|ERR!)\s?/, '').replace(/^(?:nospc|network|notarget)\s+/, '').trim())
    .filter(l => l && !/^(A complete log of this run|Run "npm help|Usage:|syscall |errno |path |dest |at |\^)/.test(l));
  const code = (lines.find(l => /^code [A-Z0-9_]+$/.test(l)) || '').slice(5);
  const thrown = lines.findIndex(l => /^(?:[A-Z]\w*)?Error\b/.test(l));
  const body = (thrown >= 0 ? lines.slice(thrown, thrown + 3) : lines.filter(l => l !== `code ${code}`).slice(0, 2)).join(' ');
  return ((code && !body.includes(code) ? `${code}: ` : '') + body).slice(0, 300) || fallback;
}

function runQuiet(cmd, args, cwd, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, env: npmEnv(), timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.killed) return reject(new Error(`${path.basename(cmd)} ${args[0]} took longer than ${Math.round(timeout / 60000)} minutes`));
      reject(new Error(failureText(stderr, err.message.slice(0, 300))));
    });
  });
}

const LIVE_MODULES = path.join(REPO_DIR, 'node_modules');
const OLD_MODULES = path.join(STAGE_DIR, 'node_modules.old');

/** node_modules is in place; if a swap stopped between its two renames, the old copy is moved back first. */
function packagesInPlace() {
  if (!present(LIVE_MODULES) && present(OLD_MODULES)) { try { fs.renameSync(OLD_MODULES, LIVE_MODULES); } catch { /* reported by the caller */ } }
  return present(LIVE_MODULES);
}

/** Remove the side folder, unless it holds the only copy of the working packages (a swap killed half-way). */
async function clearStage() {
  if (!present(LIVE_MODULES) && present(OLD_MODULES)) throw new Error(`the working packages are in ${OLD_MODULES}: move them back to ${LIVE_MODULES}`);
  await fs.promises.rm(STAGE_DIR, { recursive: true, force: true });
}

/** Install these package files in the side folder: exactly the lockfile, no scripts, then the native module, then checks. */
async function stagePackages(pkgText, lockText) {
  packagesInPlace();   // an earlier update killed mid-swap left the working packages in the side folder
  await clearStage();
  fs.mkdirSync(STAGE_DIR, { recursive: true });
  const fresh = path.join(STAGE_DIR, 'node_modules');
  try {
    fs.writeFileSync(path.join(STAGE_DIR, 'package.json'), pkgText);
    if (lockText !== null) fs.writeFileSync(path.join(STAGE_DIR, 'package-lock.json'), lockText);   // without one, `npm ci` says so itself
    const npm = npmCommand();
    await runQuiet(npm, ['ci', '--omit=dev', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund', '--loglevel=error'], STAGE_DIR, 600000);
    const deps = Object.keys(JSON.parse(pkgText).dependencies || {});
    if (deps.includes(NATIVE_MODULE)) {
      await runQuiet(npm, ['rebuild', NATIVE_MODULE, '--loglevel=error'], STAGE_DIR, 600000);
      await runQuiet(process.execPath, ['-e', `new (require(${JSON.stringify(path.join(fresh, NATIVE_MODULE))}))(':memory:').close()`], STAGE_DIR, 60000);
    }
    const missing = deps.filter(d => !fs.existsSync(path.join(fresh, d, 'package.json')));
    if (missing.length) throw new Error(`missing after the install: ${missing.join(', ')}`);
  } catch (e) {
    await clearStage().catch(() => {});
    throw e;
  }
}

/** Put the staged packages in place of node_modules: the working folder moves aside first and comes back on failure. */
async function swapStaged() {
  const hadLive = present(LIVE_MODULES);
  if (hadLive) fs.renameSync(LIVE_MODULES, OLD_MODULES);
  try { fs.renameSync(path.join(STAGE_DIR, 'node_modules'), LIVE_MODULES); }
  catch (e) {
    if (hadLive) fs.renameSync(OLD_MODULES, LIVE_MODULES);
    await clearStage().catch(() => {});
    throw new Error(`could not move the new packages into place (${e.message})`);
  }
  await clearStage().catch(() => {});   // the old packages go with it
}

/**
 * Before any code moves: when commit `target` brings different package files (or node_modules lacks a dependency),
 * install its packages in the side folder, so a hub stopped during a slow install still has matching code and
 * packages. Returns { target, staged, changed, missing }; throws (with e.what) when the install fails.
 */
async function preparePackages(target) {
  packagesInPlace();   // before judging what is missing: a killed swap may have left them in the side folder
  let changed;
  try { changed = (await git(['diff', '--name-only', 'HEAD', target, '--', 'package.json', 'package-lock.json'])).length > 0; } catch { changed = true; }
  const missing = changed ? [] : missingPackages();
  if (!changed && !missing.length) return { target, staged: false, changed, missing };
  let pkg = null, lock = null;
  try { pkg = await git(['show', `${target}:package.json`]); }
  catch (e) { throw Object.assign(new Error(`package.json of ${target.slice(0, 7)}: ${e.message.slice(0, 160)}`), { what: "the new version's packages could not be read" }); }
  try { lock = await git(['show', `${target}:package-lock.json`]); } catch { lock = null; }
  try { await stagePackages(`${pkg}\n`, lock === null ? null : `${lock}\n`); }
  catch (e) { e.what = e.what || (changed ? 'the updated packages could not be installed' : 'the missing packages could not be reinstalled'); throw e; }
  return { target, staged: true, changed, missing };
}

/** preparePackages, or the result that stops the update with nothing changed. */
async function prepareOrStop(target, prev) {
  try { return { prepared: await preparePackages(target) }; }
  catch (e) {
    const was = prev ? prev.head.slice(0, 7) : null;
    return { stop: { success: false, rolledBack: false, head: was || undefined,
      error: `Update stopped before changing anything: ${e.what || 'the updated packages could not be installed'} (${e.message}). The hub stays on ${was || 'its current version'}, with its packages as they were. Try again later.` } };
  }
}

const installedStep = (p) => p.changed ? 'Installed the updated packages' : `Reinstalled missing packages (${p.missing.slice(0, 3).join(', ')}${p.missing.length > 3 ? ', …' : ''})`;

/** Put the code back where it stood (branch and commit) and restore files the update had set aside. */
async function rollBack(prev) {
  try {
    if (prev.branch && (await currentBranch()) !== prev.branch) await git(['checkout', '-q', '-f', prev.branch], 60000);
    await git(['reset', '-q', '--hard', prev.head], 30000);
    for (const r of prev.restore || []) { fs.mkdirSync(path.dirname(r.file), { recursive: true }); fs.copyFileSync(r.from, r.file); }
    if ((await git(['rev-parse', 'HEAD'])) !== prev.head) return { ok: false, error: 'the code did not return to the earlier commit' };
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message.slice(0, 200) }; }
}

// One update at a time, across processes: the pages (the hub) and `mymaestro update` (the CLI) share this lock, so
// neither races the other in git or in the side folder. An existing lock is never removed automatically: a lock left
// by an update that was killed (rare; a normal update releases it before any restart) is removed by hand. Every
// automatic "this lock is stale" rule had a race (pid reuse, clock jumps, half-written files), so there is none.
// Released only by its owner. (Design from the challenge round.)
const LOCK_FILE = path.join(REPO_DIR, '.update.lock');
function takeLock() {
  const token = crypto.randomBytes(24).toString('hex');
  let fd;
  try { fd = fs.openSync(LOCK_FILE, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') return null; throw e; }
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: Date.now() })); return token; }
  finally { fs.closeSync(fd); }   // a failed write leaves a lock that blocks, never one that is guessed away
}
function releaseLock(token) {
  try { if (JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')).token === token) fs.unlinkSync(LOCK_FILE); }
  catch (e) { if (e.code !== 'ENOENT') console.error(`[git-sync] the update lock needs a look: ${LOCK_FILE}`); }
}
function oneAtATime(fn) {
  return async (...args) => {
    const token = takeLock();
    if (!token) return { success: false, error: `Another update is running, or one was interrupted and left its lock behind (${LOCK_FILE}). If no update is running, delete that file, then try again.` };
    try { return await fn(...args); } finally { releaseLock(token); }
  };
}

// ── Channels ─────────────────────────────────────────────────────────
// Two update channels, each a branch on GitHub: "stable" (main: promoted code, what a fresh install gets) and
// "experimental" (dev: the latest work, promoted to stable after a quiet period). The Update dialog asks which one
// every time it opens; switching is a checkout of the other branch followed by the usual fast-forward. Local work is
// never lost: the branch you leave keeps its commits.
const CHANNELS = [
  { id: 'stable', branch: process.env.HUB_STABLE_BRANCH || 'main', label: 'Stable', blurb: 'promoted code, what other installs run' },
  { id: 'experimental', branch: process.env.HUB_EXPERIMENTAL_BRANCH || 'dev', label: 'Experimental', blurb: 'the latest work, ahead of stable' },
];
function channelOf(branch) { const c = CHANNELS.find(x => x.branch === branch); return c ? c.id : null; }
function channelById(id) { return CHANNELS.find(x => x.id === id) || null; }

/**
 * What each channel offers from where this install stands: whether GitHub has the branch, how many commits it would
 * add (origin/<branch> not in HEAD) and how many of the current commits it leaves behind (HEAD not in origin/<branch>).
 * Fetches each channel branch; a branch missing on GitHub is reported, not fatal.
 */
async function getChannels() {
  const branch = await currentBranch();
  const out = { current: channelOf(branch), branch, channels: [] };
  for (const c of CHANNELS) {
    const entry = { id: c.id, label: c.label, blurb: c.blurb, branch: c.branch, available: false, adds: 0, drops: 0, current: c.branch === branch };
    try {
      await git(['fetch', 'origin', c.branch], 45000);
      await git(['rev-parse', '--verify', `origin/${c.branch}`]);
      entry.available = true;
      const counts = await git(['rev-list', '--left-right', '--count', `origin/${c.branch}...HEAD`]);
      const [addsStr, dropsStr] = counts.split(/\s+/);
      entry.adds = parseInt(addsStr, 10) || 0;
      entry.drops = parseInt(dropsStr, 10) || 0;
    } catch (e) { entry.error = /couldn't find remote ref|does not exist|unknown revision|Needed a single revision/i.test(e.message) ? 'not on GitHub' : e.message.slice(0, 160); }
    out.channels.push(entry);
  }
  return out;
}

/**
 * Where switching to channel `id` would leave the code, without moving it: the branch's GitHub copy, or the local
 * branch when it has commits GitHub lacks (no fast-forward). { ok, final: sha | null (already on it), error }.
 */
async function planSwitch(id) {
  const target = channelById(id);
  if (!target) return { ok: false, error: `Unknown channel "${id}". Choose stable or experimental.` };
  if ((await currentBranch()) === target.branch) return { ok: true, final: null };
  const dirty = (await git(['status', '--porcelain', '--untracked-files=no'])).split('\n').filter(Boolean);
  if (dirty.length) return { ok: false, error: `Cannot switch channel: ${dirty.length} uncommitted change${dirty.length > 1 ? 's' : ''} to tracked files. Commit or discard them first.` };
  let remote;
  try { await git(['fetch', 'origin', target.branch], 45000); remote = await git(['rev-parse', '--verify', `origin/${target.branch}`]); }
  catch { return { ok: false, error: `The ${target.label.toLowerCase()} channel (branch ${target.branch}) is not on GitHub.` }; }
  let local = null;
  try { local = await git(['rev-parse', '--verify', `refs/heads/${target.branch}`]); } catch { return { ok: true, final: remote, local: null, remote }; }
  try { await git(['merge-base', '--is-ancestor', local, remote]); return { ok: true, final: remote, local, remote }; }
  catch { return { ok: true, final: local, local, remote, diverged: true }; }
}

/** Check out channel `id` at exactly the planned commit (no second fetch, so GitHub moving on in between changes nothing). */
async function checkoutPlanned(id, plan) {
  const target = channelById(id);
  const from = await currentBranch();
  await git(['checkout', '-q', '-B', target.branch, plan.final], 60000);   // the planned commit is the branch itself or a fast-forward of it
  try { await git(['branch', '-q', `--set-upstream-to=origin/${target.branch}`, target.branch]); } catch { /* tracking is a convenience */ }
  return { from, branch: target.branch };
}

/**
 * Switch this install to another channel's branch. Refused while tracked files have uncommitted changes (they would
 * follow or block the checkout). The branch is created from GitHub's copy when this install never had it.
 */
async function switchChannel(id) {
  const target = channelById(id);
  if (!target) return { ok: false, error: `Unknown channel "${id}". Choose stable or experimental.` };
  const branch = await currentBranch();
  if (branch === target.branch) return { ok: true, switched: false, branch };
  const porcelain = await git(['status', '--porcelain', '--untracked-files=no']);
  const dirty = porcelain.split('\n').filter(Boolean);
  if (dirty.length) return { ok: false, error: `Cannot switch channel: ${dirty.length} uncommitted change${dirty.length > 1 ? 's' : ''} to tracked files. Commit or discard them first.` };
  try { await git(['fetch', 'origin', target.branch], 45000); await git(['rev-parse', '--verify', `origin/${target.branch}`]); }
  catch { return { ok: false, error: `The ${target.label.toLowerCase()} channel (branch ${target.branch}) is not on GitHub.` }; }
  let hasLocal = true;
  try { await git(['rev-parse', '--verify', `refs/heads/${target.branch}`]); } catch { hasLocal = false; }
  try {
    if (hasLocal) await git(['checkout', '-q', target.branch], 60000);
    else await git(['checkout', '-q', '-b', target.branch, '--track', `origin/${target.branch}`], 60000);
  } catch (e) { return { ok: false, error: `Could not switch to ${target.label.toLowerCase()}: ${e.message}` }; }
  return { ok: true, switched: true, from: branch, branch: target.branch };
}

/**
 * Fetch and report what an update would do. Read-only — safe to call anytime.
 */
async function getSyncStatus() {
  // Confirm this is a git repo with a remote before anything else.
  try {
    await git(['rev-parse', '--git-dir']);
  } catch {
    return { ok: false, error: 'This install was not made with `git clone`, so it cannot update itself. Re-install with: git clone https://github.com/mymaestroai/mymaestroai.git  then copy your .env, data/ and workspaces/ folders across. See README "Updating".' };
  }

  let remotes;
  try {
    remotes = await git(['remote']);
  } catch (e) {
    return { ok: false, error: `Could not read git remotes: ${e.message}` };
  }
  if (!remotes.split('\n').filter(Boolean).includes('origin')) {
    return { ok: false, error: 'No "origin" remote configured.' };
  }

  const branch = await currentBranch();
  if (!branch) {
    return { ok: false, error: 'HEAD is detached — checkout a branch first.' };
  }

  try {
    await git(['fetch', 'origin', branch], 45000);
  } catch (e) {
    if (/couldn't find remote ref/i.test(e.message)) {
      return { ok: false, error: `origin/${branch} does not exist on the remote.` };
    }
    if (/Authentication failed|could not read Username|terminal prompts disabled|Permission denied \(publickey\)|Repository not found|HTTP 40[134]|access denied/i.test(e.message)) {
      return { ok: false, error: 'GitHub refused access. The hub runs in the background, so it can only use credentials git has SAVED: run `git fetch` once in a terminal in this folder and sign in (use a personal access token as the password), with a credential helper enabled (`git config --global credential.helper store`, or osxkeychain on macOS).' };
    }
    return { ok: false, error: `Fetch failed: ${e.message}` };
  }

  const upstream = `origin/${branch}`;

  // Does the remote branch exist?
  try {
    await git(['rev-parse', '--verify', upstream]);
  } catch {
    return { ok: false, error: `${upstream} does not exist on the remote.` };
  }

  // Uncommitted changes to tracked files.
  const porcelain = await git(['status', '--porcelain', '--untracked-files=no']);
  const dirty = porcelain.split('\n').filter(Boolean).map(l => {
    // "XY <path>" — X/Y are index/worktree state, either may be a space.
    const m = l.match(/^(..) (.*)$/);
    return m ? { status: m[1].trim(), file: m[2] } : { status: '?', file: l.trim() };
  });

  // How far apart are we?
  const counts = await git(['rev-list', '--left-right', '--count', `${upstream}...HEAD`]);
  const [behindStr, aheadStr] = counts.split(/\s+/);
  const behind = parseInt(behindStr, 10) || 0;
  const ahead = parseInt(aheadStr, 10) || 0;

  let commits = [];
  let files = [];
  if (behind > 0) {
    const log = await git(['log', '--oneline', '--no-decorate', `HEAD..${upstream}`]);
    commits = log.split('\n').filter(Boolean);
    const diff = await git(['diff', '--name-only', `HEAD..${upstream}`]);
    files = diff.split('\n').filter(Boolean);
  }

  // Local commits GitHub does not have: either real local work, or the same commits under new ids because
  // the GitHub history was rewritten (e.g. to scrub personal details). A rewrite keeps each commit's author
  // and committer timestamps, so a local commit whose timestamp pair exists among the incoming commits is a
  // rewritten copy, not local work.
  // A rewrite can also drop a commit outright (a scrub that empties it), so a few unmatched commits next to
  // matched ones are listed for the user to confirm; they stay on the backup branch. With no match at all
  // this is ordinary local work and stays blocked.
  const rewrite = ahead > 0 && behind > 0 ? await rewriteCheck(upstream) : null;
  const rewritten = !!(rewrite && rewrite.matched > 0);
  // On a rewrite, edits to files the new history no longer tracks (per-install files the hub writes, such as
  // agent-groups.json) do not block: the move copies them aside and keeps this install's version.
  const droppedUpstream = rewritten
    ? new Set((await git(['diff', '--name-only', '--diff-filter=D', 'HEAD', upstream])).split('\n').filter(Boolean)) : new Set();
  const blocking = dirty.filter(d => !droppedUpstream.has(d.file));

  // Blockers — reasons we will refuse to update.
  const blockers = [];
  if (blocking.length > 0) {
    blockers.push(`${blocking.length} uncommitted change${blocking.length > 1 ? 's' : ''} to tracked files`);
  }
  if (ahead > 0 && !rewritten) {
    blockers.push(`${ahead} local commit${ahead > 1 ? 's' : ''} not pushed — update would not fast-forward`);
  }

  // Dirty tracked files can be discarded (they're application code, not user
  // data). Local unpushed commits are a harder problem — don't offer to nuke those.
  const onlyDirty = dirty.length > 0 && ahead === 0;

  let channels = null;
  try { channels = await getChannels(); } catch { channels = null; }

  return {
    ok: true,
    branch,
    channel: channelOf(branch),
    channels,
    behind,
    ahead,
    dirty,
    commits,
    files,
    blockers,
    upToDate: behind === 0,
    canUpdate: behind > 0 && blockers.length === 0 && ahead === 0,
    canForce: behind > 0 && onlyDirty,
    // GitHub's history was rewritten and every local-only commit has its rewritten copy upstream:
    // the update resets to GitHub (old position kept as a backup branch). Real local work is listed instead.
    rewritten,
    canRewriteUpdate: behind > 0 && rewritten && blocking.length === 0,
    localOnly: rewrite ? rewrite.unmatched.slice(0, 50) : [],
    localOnlyCount: rewrite ? rewrite.unmatched.length : 0,
    needsInstall: files.includes('package.json') || files.includes('package-lock.json'),
  };
}

/**
 * Apply the update. Re-checks status first so a stale UI can't force a
 * pull that is no longer safe.
 */
async function runUpdate({ channel = null } = {}) {
  const steps = [];
  let prev = null;
  try { prev = await position(); } catch { /* not a checkout: getSyncStatus below says so */ }
  // Asked for another channel: work out where the switch lands, get that commit's packages ready, then switch and
  // fast-forward to it. Nothing moves until the packages are ready.
  if (channel) {
    const plan = await planSwitch(channel);
    if (!plan.ok) return { success: false, error: plan.error };
    if (plan.final) {
      const prep = await prepareOrStop(plan.final, prev);
      if (prep.stop) return prep.stop;
      let sw;
      try { sw = await checkoutPlanned(channel, plan); }
      catch (e) { await clearStage().catch(() => {}); return { success: false, error: `Could not switch to ${channelById(channel).label.toLowerCase()}: ${e.message}` }; }
      steps.push(`Switched from ${sw.from} to the ${channelById(channel).label.toLowerCase()} channel (${sw.branch})`);
      if (plan.local && plan.final !== plan.local) {
        const n = parseInt(await git(['rev-list', '--count', `${plan.local}..${plan.final}`]), 10) || 0;
        steps.push(`Updated to ${n} new commit${n === 1 ? '' : 's'}`);
      }
      if (plan.diverged) steps.push(`Not fast-forwarded: this install's ${sw.branch} branch has commits that are not on GitHub`);
      return finishUpdate({ commits: [], files: [] }, steps, prev, prep.prepared);
    }
  }
  const status = await getSyncStatus();
  if (!status.ok) return { success: false, error: status.error };
  if (status.upToDate) return { success: false, error: 'Already up to date.' };
  if (status.blockers.length > 0) return { success: false, error: `Cannot update: ${status.blockers.join('; ')}.`, status };

  // Fast-forward only, to the commit whose packages were prepared. If this fails the histories diverged and a
  // merge would need a human.
  const target = await git(['rev-parse', `origin/${status.branch}`]);
  const prep = await prepareOrStop(target, prev);
  if (prep.stop) return prep.stop;
  try {
    await git(['merge', '--ff-only', target], 30000);
    steps.push(`Updated to ${status.commits.length} new commit${status.commits.length > 1 ? 's' : ''}`);
  } catch (e) {
    await clearStage().catch(() => {});
    return { success: false, error: `Merge failed: ${e.message}` };
  }

  return finishUpdate(status, steps, prev, prep.prepared);
}

/**
 * After the code moved: put in the packages prepared for exactly this commit (or, if the code landed elsewhere,
 * install them now), mark the model list stale, report. prev is where the code stood before; if the packages cannot
 * be put in, the code goes back there and the update reports failure, so nothing restarts into mismatched code.
 */
async function finishUpdate(status, steps, prev, prepared) {
  let installed = false;
  const head = await git(['rev-parse', 'HEAD']);
  if (head !== prepared.target) {
    // The code is not where its packages were prepared for: never install after the move. Go back and stop.
    await clearStage().catch(() => {});
    const back = prev ? await rollBack(prev) : { ok: false, error: 'where the code stood before is unknown' };
    return { success: false, rolledBack: back.ok, steps,
      error: back.ok
        ? `Update stopped: the code moved to ${head.slice(0, 7)} instead of ${prepared.target.slice(0, 7)}, the commit its packages were prepared for. Nothing changed: the hub stays on ${prev.head.slice(0, 7)}. Try again.`
        : `Update stopped: the code moved to ${head.slice(0, 7)} instead of ${prepared.target.slice(0, 7)}, and putting it back failed (${back.error}). Don't restart the hub yet: run "npm ci --omit=dev --ignore-scripts" and then "npm rebuild ${NATIVE_MODULE}" in ${REPO_DIR}.` };
  }
  if (prepared.staged) {
    const changed = prepared.changed;
    try {
      await swapStaged();
      installed = true;
      steps.push(installedStep(prepared));
    } catch (e) {
      const was = prev ? prev.head.slice(0, 7) : null;
      const back = prev ? await rollBack(prev) : { ok: false, error: 'where the code stood before is unknown' };
      const pkgs = packagesInPlace();
      const reason = `Update stopped: the ${changed ? 'updated packages could not be installed' : 'missing packages could not be reinstalled'} (${e.message}).`;
      const scriptless = `run "npm ci --omit=dev --ignore-scripts" and then "npm rebuild ${NATIVE_MODULE}" in ${REPO_DIR}`;
      let error;
      if (back.ok && pkgs) error = `${reason} Nothing changed: the hub stays on ${was}, with its packages as they were. Try again later.`;
      else if (back.ok) error = `${reason} The code is back on ${was}, but its packages could not be put back: before restarting the hub, move ${OLD_MODULES} back to ${LIVE_MODULES}.`;
      else if (pkgs) error = `${reason} Putting the code back failed too (${back.error}), so the code is new and the packages are old. Don't restart the hub yet: first ${scriptless}.`;
      else error = `${reason} Putting the code back failed too (${back.error}), and the packages are in ${OLD_MODULES}. Don't restart the hub yet: move that folder back to ${LIVE_MODULES}, then ${scriptless}.`;
      return { success: false, rolledBack: back.ok, packagesInPlace: pkgs, head: back.ok ? was : undefined, steps, error };
    }
  }
  const short = head.slice(0, 7);

  // Mark the model cache stale rather than deleting it. Deleting it left the hub with NO list between the
  // update and the end of the next discovery, and a page opened in that window got a short, probed list
  // that was then cached for five minutes (a tester and the owner both saw "only a few Claude models"). Kept and
  // flagged, the old list serves until startup discovery overwrites it in place; /api/models reports stale.
  try {
    const cacheFile = path.join(REPO_DIR, 'data', 'discovered-models.json');
    if (fs.existsSync(cacheFile)) {
      const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      cache.stale = true; cache.staleSince = new Date().toISOString(); cache.staleReason = `updated to ${short}`;
      fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
      steps.push('Model list marked stale — it is kept until discovery refreshes it after restart');
    }
  } catch (e) { steps.push(`Could not mark the model list stale: ${e.message}`); }

  return {
    success: true,
    head: short,
    installed,
    steps,
    commits: status.commits,
    files: status.files,
  };
}

/**
 * Discard local changes to tracked files, then update. Only offered when
 * the sole blocker is dirty tracked files (not unpushed local commits).
 * Safe because all user data lives in gitignored paths.
 */
async function runForceUpdate() {
  const status = await getSyncStatus();
  if (!status.ok) return { success: false, error: status.error };
  if (status.upToDate) return { success: false, error: 'Already up to date.' };
  if (status.ahead > 0) {
    return { success: false, error: 'You have local commits — discard won\'t help. Resolve manually.' };
  }

  if (status.dirty.length > 0) {
    await git(['checkout', '--', '.']);
  }

  return runUpdate();
}

/**
 * Local-only commits (HEAD not in upstream) with no rewritten copy among the upstream-only commits.
 * A rewritten copy has the same author and committer timestamps AND either the same subject or at least one
 * changed path in common (a scrub may reword the message or drop files, rarely both); two unrelated commits
 * made in the same second on both sides do not match.
 */
async function rewriteCheck(upstream) {
  const parse = out => out.split('\0').map(b => b.trim()).filter(Boolean).map(b => {
    const [head, ...files] = b.split('\n');
    const m = head.match(/^(\d+) (\d+) (\S+) ?(.*)$/);
    return m ? { key: `${m[1]} ${m[2]}`, subject: m[4], files: new Set(files.filter(Boolean)), line: `${m[3]} ${m[4]}` } : null;
  }).filter(Boolean);
  const args = range => ['log', '--format=%x00%at %ct %h %s', '--name-only', range];
  const local = parse(await git(args(`${upstream}..HEAD`)));
  const byKey = new Map();
  for (const c of parse(await git(args(`HEAD..${upstream}`)))) {
    if (!byKey.has(c.key)) byKey.set(c.key, []);
    byKey.get(c.key).push(c);
  }
  const isCopy = c => (byKey.get(c.key) || []).some(u =>
    u.subject === c.subject || [...c.files].some(f => u.files.has(f)) || (c.files.size === 0 && u.files.size === 0));
  const unmatched = local.filter(c => !isCopy(c)).map(c => c.line);
  return { unmatched, matched: local.length - unmatched.length };
}

/**
 * GitHub's history was rewritten: move to it. Only when every local-only commit has its rewritten copy
 * upstream and no tracked file is modified (re-checked here). The old position is kept as a branch
 * (backup/before-rewrite-<time>), and files the new history no longer tracks but now ignores (per-install
 * files such as agent-groups.json) are copied aside first and put back, so the install keeps them.
 * data/ and workspaces/ are untracked and never touched.
 */
async function runRewriteUpdate({ confirmLocalOnly = 0 } = {}) {
  const status = await getSyncStatus();
  if (!status.ok) return { success: false, error: status.error };
  if (status.upToDate) return { success: false, error: 'Already up to date.' };
  if (!status.canRewriteUpdate) {
    return { success: false, error: `Cannot update: ${status.blockers.join('; ') || 'not a rewritten history'}.`, status };
  }
  // Commits with no copy on GitHub need the user's say-so, for exactly the number they were shown.
  if (status.localOnlyCount > 0 && Number(confirmLocalOnly) !== status.localOnlyCount) {
    return { success: false, error: `Cannot update: ${status.localOnlyCount} local commit(s) are not on GitHub in any form (${status.localOnly.slice(0, 5).join('; ')}). Confirm to keep them on a backup branch and move on.`, status };
  }
  const upstream = `origin/${status.branch}`;
  const target = await git(['rev-parse', upstream]);
  const prep = await prepareOrStop(target, await position());   // the packages first: nothing moves until they are ready
  if (prep.stop) return prep.stop;
  const steps = [];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const backupBranch = `backup/before-rewrite-${stamp}`;
  try { await git(['branch', backupBranch, 'HEAD']); }
  catch (e) { await clearStage().catch(() => {}); return { success: false, error: `Could not keep the old position as a branch: ${e.message}. Nothing was changed.` }; }
  steps.push(`Old position kept as branch ${backupBranch}${status.localOnlyCount ? ` (including ${status.localOnlyCount} commit(s) not on GitHub)` : ''}`);

  // Files tracked now that the new history drops: keep the ones it ignores (per-install files).
  const keepDir = path.join(REPO_DIR, 'data', 'backups', `update-${stamp}`);
  const kept = [];
  try {
    const dropped = (await git(['diff', '--name-only', '--diff-filter=D', 'HEAD', target])).split('\n').filter(Boolean);
    for (const f of dropped) {
      const src = path.join(REPO_DIR, f);
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
      const dst = path.join(keepDir, f);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      kept.push(f);
    }
  } catch (e) {
    await clearStage().catch(() => {});
    return { success: false, error: `Could not set this install's files aside: ${e.message}. Nothing else was changed; the old position is branch ${backupBranch}.` };
  }
  if (kept.length) steps.push(`Copied ${kept.length} file(s) the new history no longer tracks to data/backups/update-${stamp}`);
  // A failed swap comes back here, with the set-aside files as they were.
  const prev = { ...(await position()), restore: kept.map(f => ({ file: path.join(REPO_DIR, f), from: path.join(keepDir, f) })) };

  try {
    await git(['reset', '--hard', target], 30000);
    steps.push(`Moved to GitHub's rewritten history (${status.commits.length} commits)`);
  } catch (e) {
    await clearStage().catch(() => {});
    return { success: false, error: `Reset failed: ${e.message}. Nothing else was changed; the old position is branch ${backupBranch}.` };
  }

  const restored = [];
  for (const f of kept) {
    try {
      await git(['check-ignore', '-q', f]);            // exits 0 only when ignored
      const dst = path.join(REPO_DIR, f);
      if (!fs.existsSync(dst)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(path.join(keepDir, f), dst); restored.push(f); }
    } catch { /* not ignored: the file was removed from the code on purpose; the copy stays in the backup */ }
  }
  if (restored.length) steps.push(`Kept this install's copy of ${restored.join(', ')}`);

  return finishUpdate(status, steps, prev, prep.prepared);
}

module.exports = {
  getSyncStatus, getChannels, switchChannel, channelOf, CHANNELS,
  runUpdate: oneAtATime(runUpdate), runForceUpdate: oneAtATime(runForceUpdate), runRewriteUpdate: oneAtATime(runRewriteUpdate),
};
