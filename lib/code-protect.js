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

// The hub home's own folders (lib/hub-home BACKUP_FOLDERS): when the hub home IS the install folder, these are not program files.
const HOME_FOLDERS = ['share', 'users', 'medical', 'legal', 'call-recordings'];

// Programs whose mere presence in a command we could not read means it might write (see mightWrite).
const MIGHT_WRITE = ['tee', 'cp', 'mv', 'rm', 'rmdir', 'mkdir', 'touch', 'ln', 'install', 'truncate', 'dd', 'sed', 'perl', 'git', 'rsync', 'tar',
  'unzip', 'patch', 'chmod', 'chown', 'python', 'python3', 'node', 'npm', 'npx', 'sh', 'bash', 'zsh', 'find', 'xargs', 'unlink', 'curl', 'wget',
  'ruby', 'awk', 'gawk', 'ed', 'shred'];
const MIGHT_WRITE_RE = new RegExp(`(?<![\\w.-])(?:${MIGHT_WRITE.join('|')})(?![\\w-])`);

/** For a command that could not be read: could it write at all? A redirection to a file (`>` not followed by `&`), or one of
 *  the programs above as a word. A command that only reads is not refused by this feature. */
function mightWrite(command) {
  const text = String(command || '');
  return />(?!&)/.test(text) || MIGHT_WRITE_RE.test(text);
}

/** Paths a shell command writes, by program (not what it reads): redirections; tee/touch/mkdir/rm/rmdir/truncate operands;
 *  the destination of cp/install; every operand of mv; link names of ln; the files of sed -i / perl -i; dd of=. */
// A command it can't read throws (not caught here): lib/tool-policy then refuses it only when it might write (mightWrite).
function shellWriteTargets(command, cwd) {
  const { scanCommand, segmentWords, commandIndexes, dequote } = require('./shell-scan');
  const text = String(command || '');
  const out = new Set();
  const scan = scanCommand(text);
  const segs = scan.segments && scan.segments.length ? scan.segments : text.split(/[\n;&|]+/);
  const base = path.resolve(cwd || '/');
  const put = (p) => {
    if (!p || typeof p !== 'string' || /^[-&]/.test(p)) return;
    out.add(path.resolve(base, p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p));
  };
  for (const seg of segs) {
    const words = segmentWords(seg);
    const skip = new Set();   // indexes of redirection words and their targets: not operands
    for (let i = 0; i < words.length; i++) {
      const m = /^(?:\d*|&)(>>?\|?)(.*)$/.exec(words[i]);
      if (m) { skip.add(i); if (m[2]) put(m[2]); else if (words[i + 1] !== undefined) { put(words[i + 1]); skip.add(i + 1); } continue; }
      if (/^\d*<[^<]*$/.test(words[i]) && !/^\d*<</.test(words[i])) { skip.add(i); if (/^\d*<$/.test(words[i])) skip.add(i + 1); continue; }
      // here-documents and here-strings (<<EOF, <<-EOF, <<<word): their word is not an operand
      if (/^\d*<<</.test(words[i]) || /^\d*<<-?/.test(words[i])) { skip.add(i); if (/^\d*<<(?:<|-)?$/.test(words[i])) skip.add(i + 1); }
    }
    // The program that really runs: shell-scan's commandIndexes knows each wrapper's options (sudo -u USER, timeout 5,
    // xargs -n 1, nice -n 5, env A=b ...): the last index is the program the wrappers run.
    const idx = commandIndexes(words);
    if (!idx.length) continue;
    const cmd = idx[idx.length - 1];
    // `command -v NAME` / `command -V NAME` look a name up; they run nothing
    if (idx.some((k) => path.basename(dequote(words[k])) === 'command' && /^-[vV]$/.test(dequote(words[k + 1] || '')))) continue;
    const prog = path.basename(words[cmd]);
    const args = [];
    for (let i = cmd + 1; i < words.length; i++) if (!skip.has(i)) args.push(words[i]);

    // Split args into options and operands. `valueOpts`: options that take the next word as their value.
    // Returns { ops, vals } (vals: option name -> value, last wins).
    const parse = (valueOpts) => {
      const ops = [], vals = {};
      let done = false;
      for (let i = 0; i < args.length; i++) {
        const w = args[i];
        if (done || w === '-' || !w.startsWith('-')) { ops.push(w); continue; }
        if (w === '--') { done = true; continue; }
        if (w.startsWith('--')) {
          const eq = w.indexOf('=');
          if (eq > 0) { vals[w.slice(0, eq)] = w.slice(eq + 1); continue; }
          if (valueOpts.includes(w)) { vals[w] = args[i + 1]; i++; }
          else vals[w] = true;
          continue;
        }
        for (let k = 1; k < w.length; k++) {   // a cluster of short options
          const c = '-' + w[k];
          if (valueOpts.includes(c)) { const rest = w.slice(k + 1); if (rest) vals[c] = rest; else { vals[c] = args[i + 1]; i++; } break; }
          vals[c] = true;
        }
      }
      return { ops, vals };
    };
    const str = (v) => (typeof v === 'string' ? v : null);

    if (['tee', 'touch', 'mkdir', 'rm', 'rmdir', 'unlink', 'truncate'].includes(prog)) {
      // each program's own options that take a value (rm -r / rm -d are flags: their next word is a path to delete)
      const valueOpts = {
        tee: [], rm: [], rmdir: [], unlink: [],
        touch: ['-d', '--date', '-t', '-r', '--reference'],
        mkdir: ['-m', '--mode', '--context'],
        truncate: ['-s', '--size', '-r', '--reference'],
      }[prog];
      const { ops } = parse(valueOpts);
      ops.forEach(put);
    } else if (prog === 'cp' || prog === 'install' || prog === 'mv' || prog === 'ln') {
      const { ops, vals } = parse(['-t', '--target-directory', '-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group']);
      if (prog === 'install' && (vals['-d'] || vals['--directory'])) { ops.forEach(put); continue; }
      // the destination and the sources: with -t DIR every operand is a source; else the last operand is the destination
      const t = str(vals['-t']) || str(vals['--target-directory']);
      let dest = t, srcs = ops;
      if (!t) {
        if (ops.length >= 2) { dest = ops[ops.length - 1]; srcs = ops.slice(0, -1); }
        else if (prog === 'ln' && ops.length === 1) { dest = '.'; srcs = ops; }   // ln TARGET: a link named after it, here
        else { dest = null; srcs = ops; }
      }
      if (dest) {
        put(dest);
        // into a folder the file lands as DEST/<name of the source> (data/ is exempt, but two files in it are not)
        for (const s of srcs) put(path.join(path.resolve(base, dest), path.basename(s)));
      }
      // mv removes its sources; a hard link (ln without -s, cp -l/--link) makes a second name for the very same file,
      // so changing it through the new name changes the source too: the sources count as written then
      const symbolic = vals['-s'] || vals['--symbolic'];
      const hardLink = (prog === 'ln' && !symbolic) || (prog === 'cp' && (vals['-l'] || vals['--link']));
      if (prog === 'mv' || hardLink) srcs.forEach(put);
    } else if (prog === 'dd') {
      for (const w of args) if (/^of=/.test(w)) put(w.slice(3));
    } else if (prog === 'sed' || prog === 'perl') {
      // options that carry a value, in a cluster too: the rest of the cluster, else the next word
      let inPlace = false, haveCode = false;
      const ops = [];
      let done = false;
      for (let i = 0; i < args.length; i++) {
        const w = args[i];
        if (done || w === '-' || !w.startsWith('-')) { ops.push(w); continue; }
        if (w === '--') { done = true; continue; }
        if (w.startsWith('--')) {
          const name = w.split('=')[0];
          if (name === '--in-place') inPlace = true;
          else if (['--expression', '--file'].includes(name)) { haveCode = true; if (!w.includes('=')) i++; }
          else if (['--line-length'].includes(name) && !w.includes('=')) i++;
          continue;
        }
        for (let k = 1; k < w.length; k++) {
          const c = w[k];
          if (c === 'i') { inPlace = true; break; }   // the rest of the cluster is the backup suffix
          // perl -C takes only an attached value (-CSD); a bare -C takes none
          const takes = prog === 'sed' ? ['e', 'f', 'l'].includes(c) : ['e', 'E', 'I', 'M', 'm', 'x'].includes(c);
          if (c === 'e' || c === 'E' || (prog === 'sed' && c === 'f')) haveCode = true;
          if (takes) { if (k + 1 >= w.length && !(prog === 'perl' && ['M', 'm', 'x'].includes(c))) i++; break; }
        }
      }
      if (inPlace) (haveCode ? ops : ops.slice(1)).forEach(put);   // without -e/-f the first operand is the script
    }
  }
  return [...out];
}

function createCodeProtect({
  stateOf = (id) => require('./behaviour-changes').stateOf(id),
  hubRoot = path.resolve(__dirname, '..'),
  hubHome = null,
  // The hub home's own folders: when the home IS the install folder these (and only these) are not program files.
  homeFolders = null,
} = {}) {
  const root = path.resolve(hubRoot);
  let rootReal = root; try { rootReal = fs.realpathSync(root); } catch { /* not there (tests): the path as given */ }
  const home = hubHome ? path.resolve(hubHome) : null;
  let homeReal = home; if (home) { try { homeReal = fs.realpathSync(home); } catch { /* not there: as given */ } }
  // lib/hub-home BACKUP_FOLDERS (FOLDERS + RECORDINGS), written out here: loading lib/hub-home works out the hub home, which
  // can read data/agents.json. test/code-protect-scope.test.js checks the two lists stay the same.
  const ownFolders = homeFolders || HOME_FOLDERS;
  const homeOwn = () => ownFolders;
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

  function protectedUnder(abs, base, homeX) {
    if (!under(abs, base)) return false;
    for (const f of PROTECTED_DATA) if (under(abs, path.join(base, 'data', f))) return true;
    for (const keep of ['data', 'workspaces', 'node_modules']) if (under(abs, path.join(base, keep))) return false;
    if (homeX && under(homeX, base)) {
      if (fold(homeX) !== fold(base)) { if (under(abs, homeX)) return false; }
      else for (const f of homeOwn()) if (under(abs, path.join(homeX, f))) return false;
    }
    return true;
  }
  /** The path in its real form: the real path of the deepest existing ancestor, joined with the rest (a file not made yet). */
  function realOf(p) {
    const given = path.resolve(p);
    try { return fs.realpathSync(given); } catch { /* not there, or unreadable: try the ancestors */ }
    const rest = [];
    let cur = given;
    for (let i = 0; i < 512; i++) {
      const up = path.dirname(cur);
      if (up === cur) return given;
      rest.unshift(path.basename(cur));
      cur = up;
      try { return path.join(fs.realpathSync(cur), ...rest); } catch { /* keep walking up */ }
    }
    return given;
  }
  function isProtectedPath(p) {
    if (typeof p !== 'string' || !p.trim()) return false;
    const abs = path.resolve(p);
    // The install's data/ is decided by name, never looked at on disk: it is exempt, except the files that decide this
    // protection (PROTECTED_DATA). (Its files are the hub's own; nothing here needs their real paths.)
    for (const b of new Set([root, rootReal])) {
      if (under(abs, path.join(b, 'data'))) return PROTECTED_DATA.some((f) => under(abs, path.join(b, 'data', f)));
    }
    const real = realOf(p);
    if (protectedUnder(real, rootReal, homeReal)) return true;
    // the form as given too (a layout that isn't on disk); a path that is its own real form was judged above
    return real !== abs && protectedUnder(abs, root, home);
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
    const bases = new Set([path.resolve(cwd || root)]);
    for (const m of text.matchAll(/(?:^|[;&|\n(]\s*)(?:cd|pushd)\s+("[^"]*"|'[^']*'|[^\s;&|)]+)/g)) bases.add(expand(m[1].replace(/^["']|["']$/g, ''), cwd));
    for (const b of bases) if (shellWriteTargets(text, b).some(isProtectedPath)) return true;
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

module.exports = { HOME_FOLDERS, shellWriteTargets, mightWrite, createCodeProtect, getCodeProtect, REFUSAL, ID, GIT_CHANGING };
