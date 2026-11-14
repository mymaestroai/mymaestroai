'use strict';
// The suite's guard: no test process may touch this install's own data/ folder (in the live install that is the owner's real
// accounts, memory, transcripts and settings). scripts/run-tests.js loads this file into every process of a run through
// NODE_OPTIONS=--require, so test files and anything they start with Node (scripts, servers, workers) are covered.
//
// Every path-taking call of fs (sync, callback and promise forms, streams, watch) and every better-sqlite3 database opened is
// checked. A call whose path resolves under <install>/data is refused at the call site with an EACCES error, the process
// prints one line per refused path on stderr, and it exits non-zero, so the run fails even when the test caught the error.
// Allowed exceptions are the ALLOW list below, each with its reason. Tests build a throwaway install instead
// (test/helpers/isolated-install.js).
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// The install this file belongs to. MM_DATA_GUARD_ROOT adds one more install to protect (the guard's own tests use a fake
// one); it never replaces this one.
const ROOT = path.resolve(__dirname, '..', '..');

// { file, path, access, reason }: file = the test file (relative to the install, '*' = any), path = the entry under data/
// (exact, or a prefix ending in '/'), access = 'read' (look and read only) or 'any'.
const ALLOW = [
  { file: '*', path: 'agents.example.json', access: 'read', reason: 'tracked in git: the example agents list shipped with the code, not install data (isolated-install.js copies it)' },
];

const realpath = fs.realpathSync.native;
function canonical(p) {
  // The real path of the nearest existing ancestor, plus the rest: a path through a symlink into data/ still counts.
  let cur = p; const tail = [];
  for (let i = 0; i < 64; i++) {
    try { return path.join(realpath(cur), ...tail.reverse()); } catch { /* not there yet */ }
    const up = path.dirname(cur);
    if (up === cur) break;
    tail.push(path.basename(cur)); cur = up;
  }
  return p;
}
const INSTALLS = [ROOT, ...(process.env.MM_DATA_GUARD_ROOT ? [path.resolve(process.env.MM_DATA_GUARD_ROOT)] : [])]
  .map(root => ({ root, data: path.join(canonical(root), 'data'), nodeModules: path.join(root, 'node_modules') + path.sep }));
const DATA = INSTALLS[0].data;

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

// -> the entry under data/ ('' for data/ itself, 'a/b.json') when p is in a protected data/ folder, else null.
function underData(p) {
  const s = toPath(p);
  if (s === null || s === '' || s.startsWith('\0')) return null;
  const abs = path.resolve(s);
  const inData = (q) => {
    for (const i of INSTALLS) if (q === i.data || q.startsWith(i.data + path.sep)) return path.relative(i.data, q).split(path.sep).join('/');
    return null;
  };
  const direct = inData(abs);
  if (direct !== null) return direct;
  // A path through a link into data/ is caught by its real path: any path inside an install (a link there may point into
  // data/ under another name), and elsewhere any path naming a "data" folder (<tmp>/link-to-the-install/data/...). A link
  // outside the install whose own name hides data/ is not followed; isolated-install.js links only node_modules.
  if (abs.includes(`${path.sep}data`) || INSTALLS.some(i => abs.startsWith(i.root + path.sep) && !abs.startsWith(i.nodeModules))) {
    const c = canonical(abs);
    if (c !== abs) return inData(c);
  }
  return null;
}

function allowed(rel, access) {
  return ALLOW.some(a => (a.file === '*' || a.file === TEST_FILE) && (a.access === 'any' || a.access === access)
    && (a.path === rel || (a.path.endsWith('/') && (rel + '/').startsWith(a.path))));
}

function check(p, access, how) {
  const entry = underData(p);
  if (entry === null || allowed(entry, access)) return;
  const rel = entry ? `data/${entry}` : 'data/';
  if (!refused.has(rel)) {
    refused.set(rel, how);
    try { process.stderr.write(`data-guard: ${TEST_FILE || process.argv[1] || 'a process'} ${access === 'read' ? 'read' : 'wrote'} ${rel} (${how}); tests must use a throwaway install (test/helpers/isolated-install.js)\n`); } catch { /* stderr gone */ }
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

// name -> how its arguments are judged: [argument indexes that are paths, access] or a function (args) -> [[path, access], ...]
const READS = ['access', 'exists', 'readFile', 'readdir', 'readlink', 'realpath', 'stat', 'lstat', 'statfs', 'opendir', 'watch', 'watchFile', 'unwatchFile', 'createReadStream', 'glob'];
const WRITES = ['appendFile', 'chmod', 'chown', 'lchmod', 'lchown', 'lutimes', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'truncate', 'unlink', 'utimes', 'writeFile', 'createWriteStream'];
const TWO_WRITES = ['copyFile', 'cp', 'link', 'rename', 'symlink'];   // (from, to): from is read (or moved), to is written

function judge(name, args) {
  if (name === 'open') return [[args[0], openAccess(args[1])]];
  if (TWO_WRITES.includes(name)) return [[args[0], name === 'rename' ? 'write' : 'read'], [args[1], 'write']];
  if (READS.includes(name)) return [[args[0], 'read']];
  if (WRITES.includes(name)) return [[args[0], 'write']];
  return [];
}

function wrap(obj, key, name, label, promise = false) {
  const orig = obj[key];
  if (typeof orig !== 'function' || orig.__dataGuard) return;
  const wrapped = function (...args) {
    try { for (const [p, access] of judge(name, args)) check(p, access, label); }
    catch (e) { if (promise) return Promise.reject(e); throw e; }
    return orig.apply(this, args);
  };
  Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(orig));
  Object.defineProperty(wrapped, '__dataGuard', { value: true });
  try { obj[key] = wrapped; } catch { /* read-only on this Node: left as it is */ }
}

const NAMES = ['open', ...READS, ...WRITES, ...TWO_WRITES];
for (const n of NAMES) {
  if (n !== 'createReadStream' && n !== 'createWriteStream' && n !== 'watch' && n !== 'watchFile' && n !== 'unwatchFile') wrap(fs, n + 'Sync', n, `fs.${n}Sync`);
  wrap(fs, n, n, `fs.${n}`);
  if (fs.promises && typeof fs.promises[n] === 'function') wrap(fs.promises, n, n, `fs.promises.${n}`, true);
}
// existsSync answers false for a refused path instead of throwing (it never throws), and still counts as a refusal.
{
  const orig = fs.existsSync;
  const guarded = function existsSync(p) {
    try { check(p, 'read', 'fs.existsSync'); } catch { return false; }
    return orig.call(this, p);
  };
  Object.defineProperty(guarded, '__dataGuard', { value: true });
  fs.existsSync = guarded;
}

// better-sqlite3 opens its file in native code, past fs: its constructor is checked as it is loaded.
const sqliteGuarded = new WeakMap();   // one guarded constructor per loaded copy, so every require gets the same one
function sqliteOpen(args) {
  const file = args[0];
  if (typeof file === 'string' && file !== ':memory:' && file !== '') check(file, args[1] && args[1].readonly ? 'read' : 'write', 'better-sqlite3');
}
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const out = origLoad.apply(this, arguments);
  if (typeof out !== 'function' || !(request === 'better-sqlite3' || /[\\/]better-sqlite3(?:[\\/](?:lib[\\/]?(?:index(?:\.js)?)?)?)?$/.test(request))) return out;
  if (!sqliteGuarded.has(out)) {
    sqliteGuarded.set(out, new Proxy(out, {
      construct(target, args, newTarget) { sqliteOpen(args); return Reflect.construct(target, args, newTarget === guardedOf(target) ? target : newTarget); },
      apply(target, self, args) { sqliteOpen(args); return Reflect.apply(target, self, args); },
    }));
  }
  return sqliteGuarded.get(out);
};
function guardedOf(target) { return sqliteGuarded.get(target); }

// A refusal the test caught still fails the run.
process.on('exit', (code) => { if (refused.size && !code) process.exitCode = 1; });

module.exports = { ROOT, DATA, ALLOW, refused };
