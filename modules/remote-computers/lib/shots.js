'use strict';
// A private copy of each screenshot for troubleshooting: <home>/screens/<computer>/<yyyy-mm-dd>/<hhmmss>-<4 hex>.jpg. Agents get the picture inline and
// never this path. Folders are made one level at a time (0700) and opened without following links (the same care as the ring module's store),
// the file is made new (0600, never over something), and each computer keeps its newest 200 pictures.
//
// Two ways to work "relative to an open folder, never through a link":
//  - Linux: through /proc/self/fd/<fd>/<name> (the open folder itself decides where the name goes).
//  - Mac and anything else (portable): by path, with the same guarantees checked at every step: each part is lstat'ed (no link, a folder),
//    opened with O_NOFOLLOW where the system has it, the open folder must be the very folder lstat saw (device and inode), the real path of
//    the part must be inside the store root (no link anywhere above it redirects it), and the check is made again just before each use.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const KEEP = 200;
const MAX_LIST = 4000;
const SCREENS = 'screens';
const C = fs.constants;
const NOFOLLOW = C.O_NOFOLLOW || 0, DIRECTORY = C.O_DIRECTORY || 0;
const O_DIR = C.O_RDONLY | DIRECTORY | NOFOLLOW;
const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;
const SHOT_FILE = /^\d{6}-[0-9a-f]{4}\.jpg$/;
const pad = (n, w = 2) => String(n).padStart(w, '0');

// A folder name for a computer: the first 12 characters of its short id, with anything that is not a plain name character replaced.
const folderOf = (id) => String(id || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 12);

// portable: true uses the path-based way (the default off Linux; tests force it on Linux).
function createShotStore({ home, keep = KEEP, now = Date.now, log = () => {}, portable = process.platform !== 'linux' } = {}) {
  const notPlain = () => Object.assign(new Error('the folder for pictures is not a plain folder'), { code: 'ENOTPLAIN' });
  const open = new Map();   // portable only: an open folder's descriptor -> its path
  let realHome = null, plainHome = null;

  const inside = (fd) => {
    const p = open.get(fd);
    if (!p) throw notPlain();
    return p;
  };
  // portable: the open folder is still the folder at its path, and no link above it leads elsewhere.
  function verify(fd) {
    const p = inside(fd);
    const before = fs.lstatSync(p);
    if (before.isSymbolicLink() || !before.isDirectory()) throw notPlain();
    const st = fs.fstatSync(fd);
    if (st.dev !== before.dev || st.ino !== before.ino) throw notPlain();
    const expected = path.join(realHome, path.relative(plainHome, p));
    if (fs.realpathSync(p) !== expected) throw notPlain();
    return p;
  }
  const at = (fd, name) => (portable ? path.join(verify(fd), name) : `/proc/self/fd/${fd}/${name}`);
  const close = (fd) => { try { fs.closeSync(fd); } finally { open.delete(fd); } };

  // The data folder is opened without following a link, then <home>/screens is made (0700) and opened the same way.
  function openRoot() {
    if (!home) throw Object.assign(new Error('There is no folder to keep pictures in.'), { code: 'ENOHOME' });
    const dir = path.resolve(home);
    const before = fs.lstatSync(dir);
    if (before.isSymbolicLink() || !before.isDirectory()) throw notPlain();
    const fd = fs.openSync(dir, O_DIR);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isDirectory() || st.dev !== before.dev || st.ino !== before.ino) throw notPlain();
      if (portable) { plainHome = dir; realHome = fs.realpathSync(dir); open.set(fd, dir); }
      const root = step(fd, SCREENS, true);
      return root;
    } finally { close(fd); }
  }
  // Opens <from>/part, made when missing (0700), refusing a link.
  function step(from, part, create) {
    if (!part || part === '.' || part === '..' || /[\/\0]/.test(part)) throw notPlain();
    let made = false;
    if (create) { try { fs.mkdirSync(at(from, part), 0o700); made = true; } catch (e) { if (e.code !== 'EEXIST') throw e; } }
    let fd;
    try { fd = fs.openSync(at(from, part), O_DIR); } catch (e) {
      if (e.code === 'ELOOP' || e.code === 'ENOTDIR') throw notPlain();
      throw e;
    }
    if (portable) {
      open.set(fd, path.join(inside(from), part));
      try { verify(fd); } catch (e) { close(fd); throw e; }   // a link in its place, or a folder swapped after lstat: refused
    }
    if (made) { try { fs.fchmodSync(fd, 0o700); } catch { /* the mode asked for at mkdir stays */ } }
    return fd;
  }
  function names(fd) {
    const out = [];
    const d = fs.opendirSync(portable ? verify(fd) : `/proc/self/fd/${fd}`, { bufferSize: 64 });
    try { for (let e; (e = d.readSync()) !== null;) { if (out.length >= MAX_LIST) break; out.push(e.name); } } finally { d.closeSync(); }
    return out;
  }

  function prune(compFd) {
    const files = [];
    for (const day of names(compFd)) {
      if (!DATE_DIR.test(day)) continue;
      let dfd;
      try { dfd = step(compFd, day, false); } catch { continue; }
      try { for (const n of names(dfd)) if (SHOT_FILE.test(n)) files.push([day, n]); } finally { close(dfd); }
    }
    if (files.length <= keep) return 0;
    files.sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1));
    let removed = 0;
    const touched = new Set();
    for (const [day, n] of files.slice(0, files.length - keep)) {
      let dfd;
      try { dfd = step(compFd, day, false); } catch { continue; }
      try {
        if (fs.lstatSync(at(dfd, n)).isFile()) { fs.unlinkSync(at(dfd, n)); removed++; touched.add(day); }
      } catch { /* already gone */ } finally { close(dfd); }
    }
    for (const day of touched) { try { fs.rmdirSync(at(compFd, day)); } catch { /* not empty */ } }
    return removed;
  }

  // save(computerId, jpegBuffer) -> { path, takenAt }. The path is for the log and the owner only; it is never given to an agent.
  function save(computerId, jpeg) {
    const comp = folderOf(computerId);
    if (!comp) throw notPlain();
    const t = new Date(now());
    const day = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
    const file = `${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}-${crypto.randomBytes(2).toString('hex')}.jpg`;
    const root = openRoot();
    let cfd = -1, dfd = -1;
    try {
      cfd = step(root, comp, true);
      dfd = step(cfd, day, true);
      const ffd = fs.openSync(at(dfd, file), C.O_WRONLY | C.O_CREAT | C.O_EXCL | NOFOLLOW, 0o600);
      try { for (let off = 0; off < jpeg.length;) off += fs.writeSync(ffd, jpeg, off, jpeg.length - off); fs.fchmodSync(ffd, 0o600); } finally { fs.closeSync(ffd); }
      try { prune(cfd); } catch (e) { log('could not tidy old pictures:', String(e && e.code || 'error')); }
    } finally {
      for (const f of [dfd, cfd, root]) if (f >= 0) { try { close(f); } catch { /* closed */ } }
    }
    return { path: path.join(path.resolve(home), SCREENS, comp, day, file), takenAt: t.toISOString() };
  }

  return { save, prune: (computerId) => { const root = openRoot(); let c = -1; try { c = step(root, folderOf(computerId), false); return prune(c); } finally { if (c >= 0) close(c); close(root); } } };
}

module.exports = { createShotStore, folderOf, KEEP, SCREENS };
