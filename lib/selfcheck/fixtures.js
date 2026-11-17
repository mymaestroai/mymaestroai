'use strict';
// The check folders and the files in them. Made carefully: no link anywhere on the way down, mode 0700, files written with
// O_EXCL and O_NOFOLLOW, and only names this module writes are ever deleted.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pngDigits } = require('./png');

const OWN_TOP = ['read.txt', 'code.png', 'edit.txt', 'write.txt', 'bash.txt'];
const OWN_GLOB = ['a.log', 'b.md'];
const G_RE = /^g-[0-9a-f]+\.txt$/, K_RE = /^notes-[0-9a-f]+\.txt$/;
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** The two folders of a class. */
function foldersFor(hubRoot, hubHome, cls) {
  return { install: path.join(hubRoot, 'workspaces', `selfcheck-${cls}`), home: path.join(hubHome, 'selfcheck', cls) };
}

// Walk down from an existing real folder, creating each missing level (0700) and checking every level with lstat.
// Returns null when fine, or the path that is a link (or is not a folder).
function ensureChain(base, levels) {
  let st;
  try { st = fs.lstatSync(base); } catch { return { bad: base, missing: true }; }
  if (st.isSymbolicLink() || !st.isDirectory()) return { bad: base };
  let cur = base;
  for (const lv of levels) {
    cur = path.join(cur, lv);
    let s = null;
    try { s = fs.lstatSync(cur); } catch (e) { if (e.code !== 'ENOENT') return { bad: cur }; }
    if (!s) {
      try { fs.mkdirSync(cur, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') return { bad: cur }; }
      try { s = fs.lstatSync(cur); } catch { return { bad: cur }; }
    }
    if (s.isSymbolicLink() || !s.isDirectory()) return { bad: cur };
  }
  return null;
}

function removeOwn(dir, names, patterns) {
  let present = [];
  try { present = fs.readdirSync(dir); } catch { return; }
  for (const n of present) {
    if (!names.includes(n) && !patterns.some(re => re.test(n))) continue;
    const p = path.join(dir, n);
    let st; try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isDirectory()) continue;                    // never recursive; a folder with one of our names is left alone
    try { fs.unlinkSync(p); } catch { /* the exclusive create below fails loudly if it is still there */ }
  }
}

function writeNew(file, data) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
  return sha(data);
}

function fillFolder(dir, random) {
  const R = random(12), E = random(12), G = random(12), K = random(12), W = random(12), B = random(12);
  const D = String(1000 + (parseInt(random(8), 16) % 9000));
  removeOwn(dir, OWN_TOP, []);
  removeOwn(path.join(dir, 'glob'), OWN_GLOB, [G_RE]);
  removeOwn(path.join(dir, 'grep'), [], [K_RE]);
  const hashes = {};
  const put = (rel, data) => { hashes[path.join(dir, rel)] = writeNew(path.join(dir, rel), Buffer.isBuffer(data) ? data : Buffer.from(data)); };
  put('read.txt', `selfcheck read ${R}\n`);
  put('code.png', pngDigits(D));
  put('edit.txt', `status: before-${E}\n`);
  put(path.join('glob', `g-${G}.txt`), 'x\n');
  put(path.join('glob', 'a.log'), 'x\n');
  put(path.join('glob', 'b.md'), 'x\n');
  put(path.join('grep', `notes-${K}.txt`), `line one\nselfcheck-key: ${K}\nline three\n`);
  return { R, D, E, G, K, W, B, hashes };
}

/** makeFixtures({ hubRoot, hubHome, cls, random }) -> { ok: true, folders, fixtures, hashes } | { ok: false, note }.
 *  fixtures: { install: { R, D, E, G, K, W, B }, home: { ... } }; hashes: { <file>: sha256 }. */
function makeFixtures({ hubRoot, hubHome, cls, random }) {
  const folders = foldersFor(hubRoot, hubHome, cls);
  const chains = [
    [folders.install, path.join(hubRoot, 'workspaces'), [`selfcheck-${cls}`, 'glob'], [`selfcheck-${cls}`, 'grep']],
    [folders.home, hubHome, ['selfcheck', cls, 'glob'], ['selfcheck', cls, 'grep']],
  ];
  for (const [, base, a, b] of chains) {
    for (const levels of [a, b]) {
      const bad = ensureChain(base, levels);
      if (bad) return { ok: false, note: bad.missing ? `A check folder's parent is missing, so this check was not run: ${bad.bad}` : `A check folder is a link, so this check was not run: ${bad.bad}` };
    }
  }
  try {
    const fixtures = {}, hashes = {};
    for (const f of ['install', 'home']) {
      const { hashes: h, ...rest } = fillFolder(folders[f], random);
      fixtures[f] = rest; Object.assign(hashes, h);
    }
    // The files the turn creates must not exist when it starts: a link put there would carry the Write elsewhere.
    const absent = ['install', 'home'].flatMap(f => ['write.txt', 'bash.txt'].map(n => path.join(folders[f], n)));
    return { ok: true, folders, fixtures, hashes, absent };
  } catch (e) {
    return { ok: false, note: `The check files could not be made, so this check was not run: ${e.code || e.message}` };
  }
}

/** Are the fixture files still exactly what was written (regular files, not links, same bytes), and the files the turn
 *  makes still absent (nothing, not even a link, in their place)? */
function verifyIntact(state) {
  try {
    for (const file of state.absent || []) {
      try { fs.lstatSync(file); return false; } catch (e) { if (e.code !== 'ENOENT') return false; }
    }
    for (const [file, want] of Object.entries(state.hashes)) {
      const st = fs.lstatSync(file);
      if (!st.isFile()) return false;
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let data; try { data = fs.readFileSync(fd); } finally { fs.closeSync(fd); }
      if (sha(data) !== want) return false;
    }
    return true;
  } catch { return false; }
}

module.exports = { makeFixtures, verifyIntact, foldersFor, ensureChain };
