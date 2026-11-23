'use strict';
/**
 * code-protect.js — "Protect your Maestro's own code" (behaviour change 'protect-own-code', templates/behaviour-changes.json).
 * The setting IS that entry's state. While it is on, lib/tool-policy refuses every write whose target is in the install
 * folder (except data/, workspaces/, node_modules/ and the hub home when it sits inside the folder), and git commands that
 * change the working tree there, for every role, the lead too.
 *
 *   state()            -> { on, why: 'on' | 'off' | 'last-known' | 'unreadable' }
 *   isProtectedPath(p) -> boolean
 *   gitChangesTree(command, cwd) -> boolean (best-effort text matching, like the rest of the policy's command reading)
 *   readinessItems()   -> items for the Setup checklist while protection is on only because the file can't be read
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ID = 'protect-own-code';
const REFUSAL = "My Maestro's own code is protected on this install; describe the change to the owner instead.";
const STATE_PATH_TEXT = 'data/behaviour-reviews.json';

// git subcommands that change the working tree (or the index/HEAD, which the next checkout turns into file changes)
const GIT_CHANGING = new Set(['checkout', 'switch', 'restore', 'reset', 'apply', 'am', 'merge', 'pull', 'rebase', 'cherry-pick', 'revert', 'clean', 'rm', 'mv',
  'read-tree', 'checkout-index', 'worktree', 'sparse-checkout']);
// Files in data/ that decide this protection or record put-aside changes: protected too, though data/ is not.
const PROTECTED_DATA = ['behaviour-reviews.json', 'put-aside.json'];
// macOS and Windows compare file names without regard to case
const CASE_FOLD = process.platform === 'darwin' || process.platform === 'win32';
const STASH_CHANGING = new Set(['pop', 'apply', 'drop', 'push', 'save', 'clear', 'branch']);
// git options that take a separate value (so the word after them is not the subcommand)
const GIT_OPTS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env']);

function createCodeProtect({
  stateOf = (id) => require('./behaviour-changes').stateOf(id),
  hubRoot = path.resolve(__dirname, '..'),
  hubHome = null,
} = {}) {
  const root = path.resolve(hubRoot);
  let rootReal = root; try { rootReal = fs.realpathSync(root); } catch { /* not there (tests): the path as given */ }
  const home = hubHome ? path.resolve(hubHome) : null;
  let lastKnown = null;   // true | false: the last state this process read successfully
  let unreadableNow = false;

  const fold = (p) => (CASE_FOLD ? p.toLowerCase() : p);
  const under = (p, dir) => { const rel = path.relative(fold(dir), fold(p)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

  function state() {
    let s;
    try { s = stateOf(ID); } catch { s = 'unreadable'; }
    if (s === 'on' || s === 'off' || s === 'pending') {
      lastKnown = s === 'on';
      unreadableNow = false;
      return { on: lastKnown, why: lastKnown ? 'on' : 'off' };
    }
    unreadableNow = true;
    if (lastKnown !== null) return { on: lastKnown, why: 'last-known' };
    return { on: true, why: 'unreadable' };
  }

  function protectedUnder(abs, base) {
    if (!under(abs, base)) return false;
    for (const f of PROTECTED_DATA) if (under(abs, path.join(base, 'data', f))) return true;
    for (const keep of ['data', 'workspaces', 'node_modules']) if (under(abs, path.join(base, keep))) return false;
    if (home && under(home, base) && fold(home) !== fold(base) && under(abs, home)) return false;
    return true;
  }
  function isProtectedPath(p) {
    if (typeof p !== 'string' || !p.trim()) return false;
    const abs = path.resolve(p);
    return protectedUnder(abs, root) || (rootReal !== root && protectedUnder(abs, rootReal));
  }

  /** The working tree git uses when run in dir: the nearest folder at or above it that holds .git (null: none). */
  function repoTopOf(dir) {
    let p = path.resolve(dir);
    try { p = fs.realpathSync(p); } catch { /* a folder that doesn't exist yet: walk up from the path as given */ }
    for (let i = 0; i < 512; i++) {
      if (fs.existsSync(path.join(p, '.git'))) return p;
      const up = path.dirname(p);
      if (up === p) return null;
      p = up;
    }
    return null;
  }
  /** git run in dir works on the install's code: the repository that owns dir is the install's (a workspace without a
   *  repository of its own walks up to it), or one nested inside the protected part. */
  function gitTreeProtected(dir) {
    const top = repoTopOf(dir);
    if (top === null) return false;
    if (fold(top) === fold(root) || fold(top) === fold(rootReal)) return true;
    return isProtectedPath(top);
  }

  function expand(p, cwd) {
    let s = String(p || '');
    if (s === '~' || s.startsWith('~/')) s = path.join(os.homedir(), s.slice(1));
    return path.resolve(cwd || root, s);
  }

  /** True when the command runs a git command that changes the working tree in the protected part of the install. */
  function gitChangesTree(command, cwd) {
    const text = String(command || '');
    if (!/\bgit\b/.test(text)) return false;
    const { scanCommand, segmentWords } = require('./shell-scan');
    let segs;
    try { const scan = scanCommand(text); segs = scan.segments && scan.segments.length ? scan.segments : text.split(/[\n;&|]+/); } catch { segs = text.split(/[\n;&|]+/); }
    let cur = path.resolve(cwd || root);
    for (const seg of segs) {
      let words; try { words = segmentWords(seg); } catch { words = String(seg).trim().split(/\s+/); }
      let i = words.findIndex((w) => !/^\w+=/.test(w));
      if (i < 0) continue;
      // GIT_WORK_TREE=<dir> / GIT_DIR=<dir> in front of the command (or after env) point git at another folder
      const gitEnv = (w) => /^GIT_(?:WORK_TREE|DIR)=(.*)$/.exec(w);
      const envDirs = words.slice(0, i).map(gitEnv).filter(Boolean).map((m) => expand(m[1].replace(/^["']|["']$/g, ''), cur));
      while (['sudo', 'env', 'command', 'exec', 'time', 'nohup'].includes(path.basename(words[i] || '')) && i + 1 < words.length) {
        i++;
        while (i < words.length && (/^\w+=/.test(words[i]) || /^-/.test(words[i]))) {
          const m = gitEnv(words[i]);
          if (m) envDirs.push(expand(m[1].replace(/^["']|["']$/g, ''), cur));
          i++;
        }
      }
      const prog = path.basename(words[i] || '');
      if (prog === 'cd' || prog === 'pushd') { if (words[i + 1] && !/^-/.test(words[i + 1])) cur = expand(words[i + 1], cur); continue; }
      if (prog !== 'git') continue;
      let dir = cur;
      let alias = false;
      let j = i + 1;
      for (; j < words.length; j++) {
        const w = words[j];
        if (w === '-C') { if (words[j + 1]) dir = expand(words[j + 1], dir); j++; continue; }
        if (/^-C./.test(w)) { dir = expand(w.slice(2), dir); continue; }   // -C<path>, attached
        const gd = /^--git-dir=(.*)$/.exec(w);
        if (gd) { envDirs.push(expand(gd[1], dir)); continue; }
        if (w === '--git-dir') { if (words[j + 1]) envDirs.push(expand(words[j + 1], dir)); j++; continue; }
        if (w === '-c' && /^alias\./i.test(words[j + 1] || '')) { alias = true; j++; continue; }   // an alias could be anything
        const wt = /^--work-tree=(.*)$/.exec(w);
        if (wt) { dir = expand(wt[1], dir); continue; }
        if (w === '--work-tree') { if (words[j + 1]) dir = expand(words[j + 1], dir); j++; continue; }
        if (GIT_OPTS_WITH_VALUE.has(w)) { j++; continue; }
        if (/^-/.test(w)) continue;
        break;
      }
      const sub = words[j];
      if (!sub) continue;
      const rest = words.slice(j + 1);
      let changes = alias || GIT_CHANGING.has(sub);
      if (sub === 'stash') { const a = rest.find((w) => !/^-/.test(w)); changes = !a || STASH_CHANGING.has(a); }
      if (sub === 'commit') changes = rest.some((w) => w === '--all' || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(w));
      if (changes && (gitTreeProtected(dir) || isProtectedPath(dir) || envDirs.some((d) => isProtectedPath(d) || gitTreeProtected(d)))) return true;
    }
    return false;
  }

  /** True when a shell command writes somewhere protected: every write target selfcheck/verify finds (also after a cd), or a git change. */
  // An error here is not caught: lib/tool-policy refuses a call it couldn't read while protection is on.
  function commandWritesProtected(command, cwd) {
    const text = String(command || '');
    // updating the install moves its code (and puts changes aside): the person does that, not an agent
    // and so are setting a password and turning off two-factor: the person does that at the terminal, never an agent. A guard on top,
    // not the boundary: a shell running as the hub's user can still reach the account file other ways.
    // and so is `connect` (signing the Claude client in): an admin does that, never an agent
    if (/(?:^|[\s;&|(/"'`])(?:mymaestro|hub-cli(?:\.js)?)["'`]?\s+["'`]?(?:update|reset-password|reset-2fa|connect)\b/.test(text)) return true;
    const { shellWritePaths } = require('./selfcheck/verify');
    const bases = new Set([path.resolve(cwd || root)]);
    for (const m of text.matchAll(/(?:^|[;&|\n(]\s*)(?:cd|pushd)\s+("[^"]*"|'[^']*'|[^\s;&|)]+)/g)) bases.add(expand(m[1].replace(/^["']|["']$/g, ''), cwd));
    for (const b of bases) if (shellWritePaths(text, b).some(isProtectedPath)) return true;
    return gitChangesTree(text, cwd);
  }

  function readinessItems() {
    state();
    if (!unreadableNow || lastKnown !== null) return [];
    return [{
      id: 'code-protection-unreadable', level: 'warn',
      title: "Code protection is on because the Changes file can't be read",
      detail: `Code protection is on because the Changes file can't be read: ${STATE_PATH_TEXT}.`,
      fix: 'Open the Changes page and decide again, or restore the file from a backup.',
      action: { label: 'Open Changes', href: '/changes' },
    }];
  }

  return { state, isProtectedPath, gitChangesTree, gitTreeProtected, commandWritesProtected, readinessItems, REFUSAL };
}

let shared = null;
function getCodeProtect() {
  if (!shared) shared = createCodeProtect({ hubRoot: path.resolve(__dirname, '..'), hubHome: require('./hub-home').HUB_HOME });
  return shared;
}

module.exports = { createCodeProtect, getCodeProtect, REFUSAL, ID, GIT_CHANGING };
