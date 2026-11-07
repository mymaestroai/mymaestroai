'use strict';
// Screenshots in the Files folder: <media>/<computer>/<yyyy-mm-dd>/<hhmmss>-<4 hex>.jpg. Folders are made one level at a time and opened
// without following links (the same care as the ring module's store), the file is made new (never over something), and each computer keeps
// its newest 500 pictures.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const KEEP = 500;
const MAX_LIST = 4000;
const O_DIR = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;
const SHOT_FILE = /^\d{6}-[0-9a-f]{4}\.jpg$/;
const at = (fd, name) => `/proc/self/fd/${fd}/${name}`;
const pad = (n, w = 2) => String(n).padStart(w, '0');

// A folder name for a computer: the first 12 characters of its short id, with anything that is not a plain name character replaced.
const folderOf = (id) => String(id || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 12);

function createShotStore({ mediaDir, keep = KEEP, now = Date.now, log = () => {} } = {}) {
  const notPlain = () => Object.assign(new Error('the Files folder is not a plain folder'), { code: 'ENOTPLAIN' });

  function openRoot() {
    if (!mediaDir) throw Object.assign(new Error('There is no Files folder to save pictures in.'), { code: 'ENOMEDIA' });
    const dir = path.resolve(mediaDir);
    const before = fs.lstatSync(dir);
    if (before.isSymbolicLink() || !before.isDirectory()) throw notPlain();
    const fd = fs.openSync(dir, O_DIR);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isDirectory() || st.dev !== before.dev || st.ino !== before.ino) throw notPlain();
    } catch (e) { fs.closeSync(fd); throw e; }
    return fd;
  }
  // Opens <from or the root>/part, made when missing (0775), refusing a link.
  function step(from, part, create) {
    if (!part || part === '.' || part === '..' || /[\/\0]/.test(part)) throw notPlain();
    if (create) { try { fs.mkdirSync(at(from, part), 0o775); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
    try { return fs.openSync(at(from, part), O_DIR); } catch (e) {
      if (e.code === 'ELOOP' || e.code === 'ENOTDIR') throw notPlain();
      throw e;
    }
  }
  function names(fd) {
    const out = [];
    const d = fs.opendirSync(`/proc/self/fd/${fd}`, { bufferSize: 64 });
    try { for (let e; (e = d.readSync()) !== null;) { if (out.length >= MAX_LIST) break; out.push(e.name); } } finally { d.closeSync(); }
    return out;
  }

  function prune(compFd) {
    const files = [];
    for (const day of names(compFd)) {
      if (!DATE_DIR.test(day)) continue;
      let dfd;
      try { dfd = step(compFd, day, false); } catch { continue; }
      try { for (const n of names(dfd)) if (SHOT_FILE.test(n)) files.push([day, n]); } finally { fs.closeSync(dfd); }
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
      } catch { /* already gone */ } finally { fs.closeSync(dfd); }
    }
    for (const day of touched) { try { fs.rmdirSync(at(compFd, day)); } catch { /* not empty */ } }
    return removed;
  }

  // save(computerId, jpegBuffer) -> { path, takenAt }
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
      const ffd = fs.openSync(at(dfd, file), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
      try { for (let off = 0; off < jpeg.length;) off += fs.writeSync(ffd, jpeg, off, jpeg.length - off); fs.fchmodSync(ffd, 0o644); } finally { fs.closeSync(ffd); }
      try { prune(cfd); } catch (e) { log('could not tidy old pictures:', String(e && e.code || 'error')); }
    } finally {
      for (const f of [dfd, cfd, root]) if (f >= 0) { try { fs.closeSync(f); } catch { /* closed */ } }
    }
    return { path: path.join(path.resolve(mediaDir), comp, day, file), takenAt: t.toISOString() };
  }

  return { save, prune: (computerId) => { const root = openRoot(); let c = -1; try { c = step(root, folderOf(computerId), false); return prune(c); } finally { if (c >= 0) fs.closeSync(c); fs.closeSync(root); } } };
}

module.exports = { createShotStore, folderOf, KEEP };
