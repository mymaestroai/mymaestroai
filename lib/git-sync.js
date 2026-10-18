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
  // Asked for another channel: switch branches first, then update that branch like any other.
  if (channel) {
    const sw = await switchChannel(channel);
    if (!sw.ok) return { success: false, error: sw.error };
    if (sw.switched) steps.push(`Switched from ${sw.from} to the ${channelById(channel).label.toLowerCase()} channel (${sw.branch})`);
  }
  const status = await getSyncStatus();
  if (!status.ok) return { success: false, error: status.error };
  if (status.upToDate) {
    if (steps.length) return finishUpdate({ ...status, commits: [], files: [] }, steps);   // switched; that branch was already current with GitHub
    return { success: false, error: 'Already up to date.' };
  }
  if (status.blockers.length > 0) {
    if (steps.length) return finishUpdate({ ...status, commits: [], files: [] }, steps.concat([`Not fast-forwarded: ${status.blockers.join('; ')}`]));
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

  return finishUpdate(status, steps);
}

/** After the code moved: npm install when dependencies changed, mark the model list stale, report. */
async function finishUpdate(status, steps) {
  const head = await git(['rev-parse', '--short', 'HEAD']);

  // Dependencies, only when they actually changed.
  let installed = false;
  if (status.needsInstall) {
    try {
      await new Promise((resolve, reject) => {
        execFile('npm', ['install', '--no-audit', '--no-fund'],
          { cwd: REPO_DIR, env: GIT_ENV, timeout: 300000, maxBuffer: 8 * 1024 * 1024 },
          (err, stdout, stderr) => err ? reject(new Error((stderr || err.message).slice(0, 300))) : resolve(stdout));
      });
      installed = true;
      steps.push('Installed updated dependencies');
    } catch (e) {
      // Don't fail the whole update — the code is already in place.
      steps.push(`Dependency install failed: ${e.message} — run "npm install" manually`);
    }
  }

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

  return finishUpdate(status, steps);
}

module.exports = { getSyncStatus, runUpdate, runForceUpdate, runRewriteUpdate, getChannels, switchChannel, channelOf, CHANNELS };
