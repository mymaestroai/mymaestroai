'use strict';
// The suite's guard: no test process may touch this install's own data/ folder (in the live install that is the owner's real
// accounts, memory, transcripts and settings). scripts/run-tests.js loads this file into every process of a run through
// NODE_OPTIONS=--require, so test files and anything they start with Node (scripts, servers, workers) are covered.
//
// What is checked: every path-taking call of fs (sync, callback and promise forms, streams, watch), and better-sqlite3 opening
// a database file (the constructor) or writing a backup. Each path is judged by its real path too, so a link into data/ from
// anywhere, or a data/ that is itself a link, counts. Removing, renaming or copying a folder that holds data/ counts as
// touching data/. Not covered: processes that are not Node (git, sqlite3), children started with an environment that drops
// NODE_OPTIONS, and files SQL itself opens on an already open database (ATTACH, VACUUM INTO).
//
// A refused call throws EACCES at the call site (promise forms reject), prints one `data-guard:` line per path on stderr and
// makes the process exit non-zero. When MM_DATA_GUARD_REPORT names a file (run-tests.js sets one per run), each refusal is
// also appended there, and the runner fails the run on any line in it, so a refusal in a child whose exit code a test
// ignored still fails the run. Allowed exceptions are the ALLOW list below, each with its reason. Tests build a throwaway
// install instead (test/helpers/isolated-install.js).
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// The install this file belongs to. MM_DATA_GUARD_ROOT adds one more install to protect (the guard's own tests use a fake
// one); it never replaces this one.
const ROOT = path.resolve(__dirname, '..', '..');

// { file, path, access, reason }: file = the test file (relative to the install, '*' = any), path = the entry under data/
// (exact, or a prefix ending in '/'), access = 'read' (look and read only) or 'any'. Judged on the entry's real path.
const ALLOW = [
  { file: '*', path: 'agents.example.json', access: 'read', reason: 'tracked in git: the example agents list shipped with the code, not install data (isolated-install.js copies it)' },
];

const MARK = Symbol('data-guard');   // this copy's own mark, so a second copy of the guard (another install's) still wraps
const realpath = fs.realpathSync.native;
const appendRaw = fs.appendFileSync;
function canonical(p) {
  // The real path of the nearest existing ancestor, plus the rest.
  let cur = p; const tail = [];
  for (let i = 0; i < 256; i++) {
    try { return path.join(realpath(cur), ...tail.reverse()); } catch { /* not there yet */ }
    const up = path.dirname(cur);
    if (up === cur) break;
    tail.push(path.basename(cur)); cur = up;
  }
  return p;
}
// Every name a protected data/ folder goes by: <install>/data as written, under the install's real path, and its own real
// path when data/ is a link.
const PROTECTED = [...new Set([ROOT, ...(process.env.MM_DATA_GUARD_ROOT ? [path.resolve(process.env.MM_DATA_GUARD_ROOT)] : [])]
  .flatMap(root => [path.join(root, 'data'), path.join(canonical(root), 'data'), canonical(path.join(root, 'data'))]))];
const DATA = path.join(ROOT, 'data');

const TEST_FILE = process.env.MM_DATA_GUARD_TEST
  || (process.env.NODE_TEST_CONTEXT && process.argv[1] ? path.relative(ROOT, path.resolve(process.argv[1])).split(path.sep).join('/') : '');
if (TEST_FILE) process.env.MM_DATA_GUARD_TEST = TEST_FILE;   // children started by a test report under its name

const refused = new Map();

function toPath(p) {
  if (typeof p === 'string') return p;
  if (Buffer.isBuffer(p)) return p.toString();
  if (p instanceof URL) { try { return require('node:url').fileURLToPath(p); } catch { return null; } }
  return null;   // a file descriptor or nothing: not a path
}

const entryIn = (q) => {
  for (const d of PROTECTED) if (q === d || q.startsWith(d + path.sep)) return path.relative(d, q).split(path.sep).join('/');
  return null;
};
const holdsData = (q) => PROTECTED.some(d => d.startsWith(q.endsWith(path.sep) ? q : q + path.sep));

const allowed = (entry, access) => ALLOW.some(a => (a.file === '*' || a.file === TEST_FILE) && (a.access === 'any' || a.access === access)
  && (a.path === entry || (a.path.endsWith('/') && (entry + '/').startsWith(a.path))));

// -> null when p may be used, else the refused entry ('' = data/ itself, a/b.json, or '*' = a folder holding data/).
// A path already inside data/ as written is refused without a look at the disk. Otherwise its real path decides (an allowed
// entry is allowed only when its real path is allowed too). follow = false for calls that act on a link itself (unlink, rm,
// rename, lstat, readlink, lchown ...): only the folders on the way are resolved, so removing a link that points into data/
// is fine and removing data/ through a linked folder is not.
function refusedEntry(p, access, tree, follow) {
  const s = toPath(p);
  if (s === null || s === '' || s.startsWith('\0')) return null;
  const abs = path.resolve(s);
  const lex = entryIn(abs);
  if (lex !== null && !allowed(lex, access)) return lex;
  if (tree && holdsData(abs)) return '*';
  const real = follow || abs === path.parse(abs).root ? canonical(abs) : path.join(canonical(path.dirname(abs)), path.basename(abs));
  if (real === abs) return null;
  const rl = entryIn(real);
  if (rl !== null) return allowed(rl, access) ? null : rl;
  if (tree && holdsData(real)) return '*';
  return null;
}

function check(p, access, how, tree = false, follow = true) {
  const entry = refusedEntry(p, access, tree, follow);
  if (entry === null) return;
  const rel = entry === '*' ? `${path.resolve(toPath(p))} (a folder holding data/)` : `data/${entry}`;
  if (!refused.has(rel)) {
    refused.set(rel, how);
    const who = TEST_FILE || process.argv[1] || 'a process';
    try { process.stderr.write(`data-guard: ${who} ${access === 'read' ? 'read' : 'wrote'} ${rel} (${how}); tests must use a throwaway install (test/helpers/isolated-install.js)\n`); } catch { /* stderr gone */ }
    if (process.env.MM_DATA_GUARD_REPORT) {
      try { appendRaw(process.env.MM_DATA_GUARD_REPORT, JSON.stringify({ test: who, path: rel, how, access, pid: process.pid }) + '\n'); } catch { /* the exit code still fails it */ }
    }
  }
  process.exitCode = 1;
  const e = new Error(`data-guard: a test may not touch ${rel}`);
  e.code = 'EACCES';
  throw e;
}

function openAccess(flags) {
  if (flags === undefined || flags === null) return 'read';
  if (typeof flags === 'number') return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) ? 'write' : 'read';
  return /^r$|^rs$|^sr$/.test(String(flags)) ? 'read' : 'write';
}

const READS = ['access', 'exists', 'readFile', 'readlink', 'realpath', 'stat', 'lstat', 'statfs', 'opendir', 'watch', 'watchFile', 'unwatchFile', 'createReadStream', 'glob'];
const WRITES = ['appendFile', 'chmod', 'chown', 'lchmod', 'lchown', 'lutimes', 'mkdir', 'mkdtemp', 'truncate', 'unlink', 'utimes', 'writeFile', 'createWriteStream'];
const TREES = ['rm', 'rmdir'];   // a whole folder goes: a folder holding data/ counts
const NO_FOLLOW = new Set(['unlink', 'rm', 'rmdir', 'rename', 'lstat', 'readlink', 'lchown', 'lchmod', 'lutimes']);
// -> [[path, access, tree, follow]] for one call
function judge(name, args) {
  const f = !NO_FOLLOW.has(name);
  if (name === 'open') return [[args[0], openAccess(args[1]), false, f]];
  if (name === 'readdir') return [[args[0], 'read', !!(args[1] && typeof args[1] === 'object' && args[1].recursive), f]];
  if (name === 'rename') return [[args[0], 'write', true, f], [args[1], 'write', true, f]];
  if (name === 'cp') return [[args[0], 'read', true, f], [args[1], 'write', true, f]];
  if (name === 'copyFile') return [[args[0], 'read', false, f], [args[1], 'write', false, f]];
  if (name === 'link') return [[args[0], 'read', false, f], [args[1], 'write', false, false]];
  if (name === 'symlink') return [[args[1], 'write', false, false]];   // the target is only text (relative to the link's folder); using the link is checked
  if (TREES.includes(name)) return [[args[0], 'write', true, f]];
  if (READS.includes(name)) return [[args[0], 'read', false, f]];
  if (WRITES.includes(name)) return [[args[0], 'write', false, f]];
  return [];
}

function wrap(obj, key, name, label, promise = false) {
  const orig = obj[key];
  if (typeof orig !== 'function' || orig[MARK]) return;
  const wrapped = function (...args) {
    try { for (const [p, access, tree, follow] of judge(name, args)) check(p, access, label, tree, follow); }
    catch (e) { if (promise) return Promise.reject(e); throw e; }
    return orig.apply(this, args);
  };
  Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(orig));
  Object.defineProperty(wrapped, MARK, { value: true });
  try { obj[key] = wrapped; } catch { /* read-only on this Node: left as it is */ }
}

const NO_SYNC = new Set(['createReadStream', 'createWriteStream', 'watch', 'watchFile', 'unwatchFile', 'exists']);   // existsSync: below
for (const n of ['open', 'readdir', 'rename', 'cp', 'copyFile', 'link', 'symlink', ...TREES, ...READS, ...WRITES]) {
  if (!NO_SYNC.has(n)) wrap(fs, n + 'Sync', n, `fs.${n}Sync`);
  wrap(fs, n, n, `fs.${n}`);
  if (fs.promises && typeof fs.promises[n] === 'function') wrap(fs.promises, n, n, `fs.promises.${n}`, true);
}
// existsSync answers false for a refused path instead of throwing (it never throws), and still counts as a refusal.
{
  const orig = fs.existsSync;
  if (!orig[MARK]) {
    const guarded = function existsSync(p) {
      try { check(p, 'read', 'fs.existsSync'); } catch { return false; }
      return orig.call(this, p);
    };
    Object.defineProperty(guarded, MARK, { value: true });
    fs.existsSync = guarded;
  }
}

// better-sqlite3 opens its file in native code, past fs: its constructor (and backup()) are checked as it is loaded.
const sqliteGuarded = new WeakMap();   // one guarded constructor per loaded copy, so every require gets the same one
function sqliteOpen(args) {
  const file = args[0];
  if (typeof file === 'string' && file !== ':memory:' && file !== '') check(file, args[1] && args[1].readonly ? 'read' : 'write', 'better-sqlite3');
}
function guardSqlite(Database) {
  if (sqliteGuarded.has(Database)) return sqliteGuarded.get(Database);
  const backup = Database.prototype && Database.prototype.backup;
  if (typeof backup === 'function' && !backup[MARK]) {
    const guardedBackup = function (destination, ...rest) {
      try { check(destination, 'write', 'better-sqlite3 backup'); } catch (e) { return Promise.reject(e); }
      return backup.call(this, destination, ...rest);
    };
    Object.defineProperty(guardedBackup, MARK, { value: true });
    Database.prototype.backup = guardedBackup;
  }
  const proxy = new Proxy(Database, {
    construct(target, args, newTarget) { sqliteOpen(args); return Reflect.construct(target, args, newTarget === proxy ? target : newTarget); },
    apply(target, self, args) { sqliteOpen(args); return Reflect.apply(target, self, args); },
  });
  sqliteGuarded.set(Database, proxy);
  sqliteGuarded.set(proxy, proxy);
  return proxy;
}
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const out = origLoad.apply(this, arguments);
  if (typeof out === 'function' && /(?:^|[\\/])better-sqlite3(?:[\\/]|$)/.test(String(request)) && out.prototype && typeof out.prototype.prepare === 'function') return guardSqlite(out);
  return out;
};

// A refusal the test caught still fails the process.
process.on('exit', (code) => { if (refused.size && !code) process.exitCode = 1; });

module.exports = { ROOT, DATA, PROTECTED, ALLOW, refused };
