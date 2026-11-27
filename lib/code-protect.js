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
  // any > except a descriptor copy or close (>&1, 2>&1, >&-): >&FILE writes FILE
  return />(?!&(?:\d|-))/.test(text) || MIGHT_WRITE_RE.test(text);
}

// Programs that only read (no option of theirs writes a file or runs another program): a command made only of these, named
// bare (a path such as ./ls could be anything), with no redirection to a file. (uniq, xxd, file and less are not: each can
// write; less -o keeps a log.)
const READ_ONLY = new Set(['ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'stat', 'du', 'df', 'wc',
  'test', '[', '[[', 'echo', 'printf', 'pwd', 'which', 'type', 'whereis', 'realpath', 'readlink', 'basename', 'dirname', 'cut',
  'tr', 'diff', 'cmp', 'md5sum', 'sha1sum', 'sha256sum', 'date', 'id', 'whoami', 'hostname', 'uname', 'true', 'false', 'jq', 'nl', 'od',
  'hexdump', 'strings', 'cd', 'ps', 'printenv', 'seq', 'expr', 'column']);

/** For a command that could not be read: does it certainly only read? No sign of a write (mightWrite) and every part of it
 *  (split at ; & | and line breaks) starts with a program known to only read. Anything else may write: refused. */
function onlyReads(command) {
  // 2>/dev/null, &>/dev/null: output thrown away, no file written
  const text = String(command || '').replace(/(?:\d*|&)>>?[ \t]*\/dev\/null(?![^\s;&|)])/g, ' ');
  if (!text.trim() || mightWrite(text)) return false;
  if (/\$\(|`|<\(|>\(/.test(text)) return false;   // a command or process substitution runs something else
  if (/\(\s*\)/.test(text)) return false;   // a function defined here could take a read-only program's name
  // 2>&1, >&2: a descriptor copied, no file (and its & is not a command separator)
  for (const part of text.replace(/\d*>&(?:\d+|-)/g, ' ').split(/[;&|\n]+/)) {
    const words = part.trim().replace(/^[({!\s]+/, '').split(/\s+/);
    if (!words.length || !words[0]) continue;
    // PATH=… ls (or any assignment in front) can make the bare name another program: not certainly a read
    if (/^\w+=/.test(words[0])) return false;
    const prog = words[0].replace(/^["']|["']$/g, '');
    if (prog.includes('/') || !READ_ONLY.has(prog)) return false;   // named bare: ./ls or /tmp/x/cat could be anything
  }
  return true;
}

/** A redirection glued to a word (`echo x>lib/a.js`, `cat<in>out`) is its own word to the shell: the raw words split at
 *  each unquoted < or >, the operator and its target kept together (`x`, `>lib/a.js`). A word that is only a descriptor
 *  prefix (`2`, `&`, `{fd}`) stays joined to its operator (`2>&1`, `{fd}<>f`). Quotes and backslashes are respected. */
function splitRedirections(raw) {
  const out = [];
  for (const w of raw) {
    let cur = '';
    let q = '';
    let depth = 0;   // inside $( ), $(( )), ${ }, <( ), >( ): one word, never split (its own > belongs to it)
    let tick = false;   // inside `…`
    for (let i = 0; i < w.length; i++) {
      const c = w[i];
      if (q) { cur += c; if (c === q) q = ''; else if (c === '\\' && q === '"' && i + 1 < w.length) cur += w[++i]; continue; }
      if (c === '\\' && i + 1 < w.length) { cur += c + w[++i]; continue; }
      if (c === "'" || c === '"') { q = c; cur += c; continue; }
      if (c === '`') { tick = !tick; cur += c; continue; }
      if (tick) { cur += c; continue; }
      if (depth) {
        if (c === '(' || c === '{') depth++;
        else if (c === ')' || c === '}') depth--;
        cur += c;
        continue;
      }
      if (c === '$' && (w[i + 1] === '(' || w[i + 1] === '{')) { cur += c + w[++i]; depth = 1; continue; }
      if ((c === '<' || c === '>') && cur && !/^(?:\d+|&|\{\w+\})$/.test(cur) && !/^(?:\d*|&|\{\w+\})(?:<|>)[<>&|-]*$/.test(cur)) {
        out.push(cur);
        cur = '';
      }
      if ((c === '<' || c === '>') && w[i + 1] === '(') { cur += c + w[++i]; depth = 1; continue; }   // <( … ), >( … )
      cur += c;
    }
    if (cur) out.push(cur);
  }
  return out;
}

/** Paths a shell command writes, by program (not what it reads): redirections; tee/touch/mkdir/rm/rmdir/truncate operands;
 *  the destination of cp/install; every operand of mv; link names of ln; the files of sed -i / perl -i; dd of=. */
// A command it can't read throws (not caught here): lib/tool-policy then lets it through only when it certainly only reads (onlyReads).
function shellWriteTargets(command, cwd) {
  const { scanCommand, rawWords, commandIndexes, dequote } = require('./shell-scan');
  const text = String(command || '');
  const out = new Set();
  const scan = scanCommand(text);
  const segs = scan.segments && scan.segments.length ? scan.segments : text.split(/[\n;&|]+/);
  const base = path.resolve(cwd || '/');
  // A target keeps its text form (base + '/' + path, not resolved): isProtectedPath follows symlinks and `..` the way the
  // kernel does, which a lexical resolve here would undo (`link/../x` is not `x` beside the link).
  const put = (p) => {
    if (!p || typeof p !== 'string' || /^-/.test(p)) return;
    // ~/… joined as text (path.join would fold a `..` that may follow a symlink)
    const q = p === '~' ? os.homedir() : p.startsWith('~/') ? os.homedir() + p.slice(1) : p;
    // doubled and trailing slashes and `.` tidied (none of them can cross a symlink); `..` left for isProtectedPath
    // (on Windows a leading // starts a network path and is kept)
    out.add((path.isAbsolute(q) ? q : `${base}/${q}`).replace(path.sep === '\\' ? /(?!^)\/{2,}/g : /\/{2,}/g, '/').replace(/\/\.(?=\/|$)/g, '').replace(/(.)\/$/, '$1') || '/');
  };
  for (const seg of segs) {
    // Raw words keep their quotes (a quoted '>' is text, not a redirection; "a b" stays one word, $(…) one word); the
    // words used as operands are dequoted.
    const raw = splitRedirections(rawWords(seg));
    const words = raw.map((w) => dequote(w));
    const skip = new Set();   // indexes of redirection words and their targets: not operands
    for (let i = 0; i < raw.length; i++) {
      // N>FILE, >>FILE, >|FILE, &>FILE, {fd}>FILE; and >&FILE / >& FILE (bash's &> by another name). >&N and >&- copy or
      // close a descriptor: no file.
      const m = /^(?:\d*|&|\{\w+\})(>>?\|?)(.*)$/.exec(raw[i]);
      if (m) {
        skip.add(i);
        let t = m[2];
        if (t.startsWith('&')) {
          t = t.slice(1);
          if (/^(?:\d+|-)$/.test(t)) continue;
          if (!t) { if (words[i + 1] !== undefined && !/^(?:\d+|-)$/.test(words[i + 1])) { put(words[i + 1]); } skip.add(i + 1); continue; }
        }
        if (t) put(dequote(t)); else if (words[i + 1] !== undefined) { put(words[i + 1]); skip.add(i + 1); }
        continue;
      }
      // <>FILE opens it for reading and writing (and makes it when it isn't there)
      const rw = /^(?:\d*|\{\w+\})<>(.*)$/.exec(raw[i]);
      if (rw) { skip.add(i); if (rw[1]) put(dequote(rw[1])); else if (words[i + 1] !== undefined) { put(words[i + 1]); skip.add(i + 1); } continue; }
      if (/^\d*<[^<]*$/.test(raw[i]) && !/^\d*<</.test(raw[i])) { skip.add(i); if (/^\d*<$/.test(raw[i])) skip.add(i + 1); continue; }
      // here-documents and here-strings (<<EOF, <<-EOF, <<<word): their word is not an operand
      if (/^\d*<<</.test(raw[i]) || /^\d*<<-?/.test(raw[i])) { skip.add(i); if (/^\d*<<(?:<|-)?$/.test(raw[i])) skip.add(i + 1); }
    }
    // The program that really runs: shell-scan's commandIndexes knows each wrapper's options (sudo -u USER, timeout 5,
    // xargs -n 1, nice -n 5, env A=b ...): the last index is the program the wrappers run.
    const idx = commandIndexes(raw);
    if (!idx.length) continue;
    const cmd = idx[idx.length - 1];
    // `command -v NAME` / `command -V NAME` look a name up; they run nothing
    if (idx.some((k) => path.basename(words[k]) === 'command' && /^-[vV]$/.test(words[k + 1] || ''))) continue;
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
        for (const s of srcs) put(`${dest}/${path.basename(s)}`);   // as text, like every target (see put)
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
  /** The path in its real form, worked out as the kernel does: component by component, each symlink followed as it is met
   *  (also one whose target doesn't exist yet), and `..` applied to the real folder reached so far (never to the text: in
   *  `link/../x` the `..` leaves the link's target, not the folder holding the link). Past the first component that doesn't
   *  exist, the rest is taken as written (nothing beyond it can be a link). */
  function realOf(p, hops = 0) {
    const s0 = String(p);
    const s = path.isAbsolute(s0) ? s0 : `${process.cwd()}/${s0}`;   // joined as text: a `..` in it is resolved below, not here
    const top = path.parse(s).root || path.parse(path.resolve('/')).root;
    // a backslash separates only on Windows; elsewhere it is an ordinary character of a file name
    const parts = s.slice(path.parse(s).root.length).split(path.sep === '\\' ? /[\\/]+/ : /\/+/).filter((x) => x && x !== '.');
    let cur = top;
    for (let i = 0; i < parts.length; i++) {
      const c = parts[i];
      if (c === '..') { cur = path.dirname(cur); continue; }
      const next = path.join(cur, c);
      let st;
      try { st = fs.lstatSync(next); } catch (e) {
        // not there: the rest as written. Any other failure (EMFILE, EACCES, EIO) leaves the real form unknown: thrown, and
        // isProtectedPath refuses the write.
        if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return path.resolve(next, ...parts.slice(i + 1));
        throw e;
      }
      if (st.isSymbolicLink()) {
        if (hops >= 40) return next;   // a loop of links: the kernel refuses the open (ELOOP); judged where it stands
        const target = fs.readlinkSync(next);   // a failure here is thrown too: unknown, refused
        const rest = parts.slice(i + 1).join('/');
        return realOf((path.isAbsolute(target) ? target : `${cur}/${target}`) + (rest ? `/${rest}` : ''), hops + 1);
      }
      cur = next;
    }
    return cur;
  }
  function isProtectedPath(p) {
    if (typeof p !== 'string' || !p.trim()) return false;
    const abs = path.resolve(p);
    // The files in data/ that decide this protection are refused by name at once. Every other path, data/ included, is
    // judged in its real form below: a symlink in an exempt folder (data/, a workspace) can't carry a write into the code.
    for (const b of new Set([root, rootReal])) {
      if (PROTECTED_DATA.some((f) => under(abs, path.join(b, 'data', f)))) return true;
    }
    let real;
    try { real = realOf(p); } catch { return true; }   // its real form can't be worked out: refused, never guessed
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

module.exports = { HOME_FOLDERS, shellWriteTargets, mightWrite, onlyReads, createCodeProtect, getCodeProtect, REFUSAL, ID, GIT_CHANGING };
