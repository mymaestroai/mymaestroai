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
// packages are missing (they restart only on success).
const STAGE_DIR = path.join(REPO_DIR, '.update-staging');
const NATIVE_MODULE = 'better-sqlite3';   // built after the scriptless install, as install/install.sh does

/** The npm next to the Node running the hub (the installer's Node ships one), else npm on PATH. HUB_NPM overrides. */
function npmCommand() {
  if (process.env.HUB_NPM) return process.env.HUB_NPM;
  const local = path.join(path.dirname(process.execPath), 'npm');
  return fs.existsSync(local) ? local : 'npm';
}

/** npm's environment: the hub's Node first on PATH, and none of the hub's keys or tokens. */
function npmEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k)) env[k] = v;
  env.PATH = path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '');
  return env;
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

/** Did the update change the packages? Compared with where the code stood, so a channel switch counts too. */
async function packagesChanged(fromHead, fallback) {
  try { return (await git(['diff', '--name-only', fromHead, 'HEAD', '--', 'package.json', 'package-lock.json'])).length > 0; }
  catch { return fallback; }
}

async function installPackages() {
  const live = path.join(REPO_DIR, 'node_modules');
  const fresh = path.join(STAGE_DIR, 'node_modules');
  const old = path.join(STAGE_DIR, 'node_modules.old');
  try {
    await fs.promises.rm(STAGE_DIR, { recursive: true, force: true });
    fs.mkdirSync(STAGE_DIR, { recursive: true });
    fs.copyFileSync(path.join(REPO_DIR, 'package.json'), path.join(STAGE_DIR, 'package.json'));
    // Without a lockfile `npm ci` stops with its own clear message.
    if (fs.existsSync(path.join(REPO_DIR, 'package-lock.json'))) fs.copyFileSync(path.join(REPO_DIR, 'package-lock.json'), path.join(STAGE_DIR, 'package-lock.json'));
    const npm = npmCommand();
    await runQuiet(npm, ['ci', '--omit=dev', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund', '--loglevel=error'], STAGE_DIR, 600000);
    const deps = Object.keys(JSON.parse(fs.readFileSync(path.join(STAGE_DIR, 'package.json'), 'utf8')).dependencies || {});
    if (deps.includes(NATIVE_MODULE)) {
      await runQuiet(npm, ['rebuild', NATIVE_MODULE, '--loglevel=error'], STAGE_DIR, 600000);
      await runQuiet(process.execPath, ['-e', `new (require(${JSON.stringify(path.join(fresh, NATIVE_MODULE))}))(':memory:').close()`], STAGE_DIR, 60000);
    }
    const missing = deps.filter(d => !fs.existsSync(path.join(fresh, d, 'package.json')));
    if (missing.length) throw new Error(`missing after the install: ${missing.join(', ')}`);
    // The working folder moves aside first and comes straight back if the new one cannot take its place.
    const hadLive = fs.existsSync(live);
    if (hadLive) fs.renameSync(live, old);
    try { fs.renameSync(fresh, live); }
    catch (e) { if (hadLive) fs.renameSync(old, live); throw new Error(`could not move the new packages into place (${e.message})`); }
  } finally {
    // The side folder goes (with the old packages, after a swap), but never while it holds the only copy.
    if (fs.existsSync(live)) await fs.promises.rm(STAGE_DIR, { recursive: true, force: true }).catch(() => {});
  }
}

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

// One update at a time: a second click while one runs would race it in git and in the side folder.
let updating = false;
function oneAtATime(fn) {
  return async (...args) => {
    if (updating) return { success: false, error: 'An update is already running. Wait for it to finish.' };
    updating = true;
    try { return await fn(...args); } finally { updating = false; }
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
  // Asked for another channel: switch branches first, then update that branch like any other.
  if (channel) {
    const sw = await switchChannel(channel);
    if (!sw.ok) return { success: false, error: sw.error };
    if (sw.switched) steps.push(`Switched from ${sw.from} to the ${channelById(channel).label.toLowerCase()} channel (${sw.branch})`);
  }
  const status = await getSyncStatus();
  if (!status.ok) return { success: false, error: status.error };
  if (status.upToDate) {
    if (steps.length) return finishUpdate({ ...status, commits: [], files: [] }, steps, prev);   // switched; that branch was already current with GitHub
    return { success: false, error: 'Already up to date.' };
  }
  if (status.blockers.length > 0) {
    if (steps.length) return finishUpdate({ ...status, commits: [], files: [] }, steps.concat([`Not fast-forwarded: ${status.blockers.join('; ')}`]), prev);
    return { success: false, error: `Cannot update: ${status.blockers.join('; ')}.`, status };
  }

  // Fast-forward only. If this fails the histories diverged and a merge
  // would need a human.
  try {
    await git(['merge', '--ff-only', `origin/${status.branch}`], 30000);
    steps.push(`Updated to ${status.commits.length} new commit${status.commits.length > 1 ? 's' : ''}`);
  } catch (e) {
    return { success: false, error: `Merge failed: ${e.message}` };
  }

  return finishUpdate(status, steps, prev);
}

/**
 * After the code moved: install the packages when this update changed them, mark the model list stale, report.
 * prev is where the code stood before; when the install fails the code goes back there and the update reports
 * failure, so nothing restarts into code whose packages are missing.
 */
async function finishUpdate(status, steps, prev = null) {
  let installed = false;
  if (prev ? await packagesChanged(prev.head, !!status.needsInstall) : status.needsInstall) {
    try {
      await installPackages();
      installed = true;
      steps.push('Installed the updated packages');
    } catch (e) {
      const was = prev ? prev.head.slice(0, 7) : null;
      const back = prev ? await rollBack(prev) : { ok: false, error: 'where the code stood before is unknown' };
      if (back.ok) {
        return { success: false, rolledBack: true, head: was, steps,
          error: `Update stopped: the updated packages could not be installed (${e.message}). Nothing changed: the hub stays on ${was}, with its packages untouched. Try again later; running "npm ci --omit=dev" in ${REPO_DIR} shows the full error.` };
      }
      return { success: false, rolledBack: false, steps,
        error: `The code was updated, but its packages could not be installed (${e.message}) and putting the code back failed too (${back.error}). Don't restart the hub yet: first run "npm ci --omit=dev --ignore-scripts" and then "npm rebuild ${NATIVE_MODULE}" in ${REPO_DIR}.` };
    }
  }
  const head = await git(['rev-parse', '--short', 'HEAD']);

  // Mark the model cache stale rather than deleting it. Deleting it left the hub with NO list between the
  // update and the end of the next discovery, and a page opened in that window got a short, probed list
  // that was then cached for five minutes (a tester and the owner both saw "only a few Claude models"). Kept and
  // flagged, the old list serves until startup discovery overwrites it in place; /api/models reports stale.
  try {
    const cacheFile = path.join(REPO_DIR, 'data', 'discovered-models.json');
    if (fs.existsSync(cacheFile)) {
      const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      cache.stale = true; cache.staleSince = new Date().toISOString(); cache.staleReason = `updated to ${head}`;
      fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
      steps.push('Model list marked stale — it is kept until discovery refreshes it after restart');
    }
  } catch (e) { steps.push(`Could not mark the model list stale: ${e.message}`); }

  return {
    success: true,
    head,
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
  const steps = [];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const backupBranch = `backup/before-rewrite-${stamp}`;
  await git(['branch', backupBranch, 'HEAD']);
  steps.push(`Old position kept as branch ${backupBranch}${status.localOnlyCount ? ` (including ${status.localOnlyCount} commit(s) not on GitHub)` : ''}`);

  // Files tracked now that the new history drops: keep the ones it ignores (per-install files).
  const dropped = (await git(['diff', '--name-only', '--diff-filter=D', 'HEAD', upstream])).split('\n').filter(Boolean);
  const keepDir = path.join(REPO_DIR, 'data', 'backups', `update-${stamp}`);
  const kept = [];
  for (const f of dropped) {
    const src = path.join(REPO_DIR, f);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
    const dst = path.join(keepDir, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    kept.push(f);
  }
  if (kept.length) steps.push(`Copied ${kept.length} file(s) the new history no longer tracks to data/backups/update-${stamp}`);
  // A failed package install comes back here, with the set-aside files as they were.
  const prev = { ...(await position()), restore: kept.map(f => ({ file: path.join(REPO_DIR, f), from: path.join(keepDir, f) })) };

  try {
    await git(['reset', '--hard', upstream], 30000);
    steps.push(`Moved to GitHub's rewritten history (${status.commits.length} commits)`);
  } catch (e) {
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

  return finishUpdate(status, steps, prev);
}

module.exports = {
  getSyncStatus, getChannels, switchChannel, channelOf, CHANNELS,
  runUpdate: oneAtATime(runUpdate), runForceUpdate: oneAtATime(runForceUpdate), runRewriteUpdate: oneAtATime(runRewriteUpdate),
};
