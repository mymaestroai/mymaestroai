'use strict';
/**
 * hand-off-folder.js — makes a hand-off's job folder, writes its brief.md and reads its STATUS.md on systems without
 * /proc/self/fd (macOS and other Unix systems), as safely as lib/hand-offs.js does through /proc/self/fd on Linux.
 *
 * The job folder lives in the TARGET agent's Files folder, which that agent can change at any moment (it could swap a
 * folder for a link to somewhere else). Node has no openat()/fchdir(), so the work runs in a short-lived helper process
 * (this file, run with the same Node binary) that walks by working directory:
 *   - it starts in the Files folder (resolved by the hub; the agent can't replace the Files folder itself);
 *   - each step into a sub-folder is lstat'ed first (a real directory, never a link), entered with chdir, and the
 *     folder it is now in (stat '.') must have the same device and inode as the one lstat'ed, so a swap in between is
 *     caught;
 *   - inside the job folder only plain names are opened, relative to the working directory, with O_NOFOLLOW (and
 *     O_EXCL for brief.md, O_NONBLOCK for STATUS.md, so a named pipe never blocks): no path component is left that
 *     could be swapped.
 * The working directory belongs to the helper process alone, so nothing in the hub depends on it.
 *
 * In the hub:  run(request, { timeoutMs }) -> Promise of the helper's answer
 *   { op: 'make', base, caller, slug, brief }  -> { ok: true, name } | { ok: false, code: 'not_plain' | 'too_many' | 'error', message }
 *   { op: 'status', base, names, maxBytes }    -> { ok: true, status: { <name>: text | null } } | { ok: false, ... }
 */
const fs = require('fs');
const path = require('path');

const MAX_ANSWER = 1024 * 1024;
const MAX_NAMES = 50;

function plainName(name) {
  return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0') && name.length <= 255;
}

function notPlain() { const e = new Error('not a plain folder'); e.code = 'not_plain'; return e; }

/** Steps from the working directory into `name`: a real directory (never a link), and still the same one once inside. */
function enter(name, { create = false } = {}) {
  if (!plainName(name)) throw notPlain();
  let st;
  try { st = fs.lstatSync(name); } catch (e) {
    if (!(create && e.code === 'ENOENT')) throw e;
    try { fs.mkdirSync(name); } catch (e2) { if (e2.code !== 'EEXIST') throw e2; }
    st = fs.lstatSync(name);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw notPlain();
  process.chdir(name);
  const here = fs.statSync('.');
  if (here.dev !== st.dev || here.ino !== st.ino) throw notPlain();
  return here;
}

function enterBase(base) {
  if (typeof base !== 'string' || !path.isAbsolute(base)) throw notPlain();
  const st = fs.lstatSync(base);
  if (st.isSymbolicLink() || !st.isDirectory()) throw notPlain();
  process.chdir(base);
  const here = fs.statSync('.');
  if (here.dev !== st.dev || here.ino !== st.ino) throw notPlain();
}

function flags() {
  const c = fs.constants;
  if (c.O_NOFOLLOW === undefined || c.O_NONBLOCK === undefined) throw new Error('this system has no O_NOFOLLOW');
  return c;
}

function make({ base, caller, slug, brief }) {
  const c = flags();
  enterBase(base);
  const parent = enter('hand-offs', { create: true });
  let name = null;
  for (let i = 1; i < 100 && !name; i++) {
    const n = i === 1 ? `${caller}-${slug}` : `${caller}-${slug}-${i}`;
    if (!plainName(n)) throw notPlain();
    try { fs.mkdirSync(n); name = n; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  if (!name) { const e = new Error('too many'); e.code = 'too_many'; throw e; }
  let inside = false, created = false;
  try {
    enter(name);
    inside = true;
    const fd = fs.openSync('brief.md', c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW, 0o644);
    created = true;
    try {
      const buf = Buffer.from(String(brief), 'utf8');
      let off = 0;
      while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  } catch (e) {
    // no empty job folder left behind: removed from the hand-offs folder it was made in (rmdir removes only an empty one)
    try {
      if (inside) {
        if (created) { try { fs.unlinkSync('brief.md'); } catch {} }   // a brief this helper began but could not finish
        process.chdir('..');
      }
      const here = fs.statSync('.');
      if (here.dev === parent.dev && here.ino === parent.ino) fs.rmdirSync(name);
    } catch {}
    throw e;
  }
  return { ok: true, name };
}

function readStatus(maxBytes) {
  const c = flags();
  const fd = fs.openSync('STATUS.md', c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const buf = Buffer.alloc(Math.max(0, Math.min(st.size, maxBytes)));
    const n = buf.length ? fs.readSync(fd, buf, 0, buf.length, 0) : 0;
    return buf.subarray(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}

function status({ base, names, maxBytes }) {
  const out = {};
  const max = Math.max(0, Math.min(Number(maxBytes) || 0, 64 * 1024));
  for (const name of (Array.isArray(names) ? names : []).slice(0, MAX_NAMES)) {
    out[name] = null;
    if (!plainName(name)) continue;
    try {
      enterBase(base);   // every name from the Files folder again: no step back up through '..'
      enter('hand-offs');
      enter(name);
      out[name] = readStatus(max);
    } catch { out[name] = null; }
  }
  return { ok: true, status: out };
}

function handle(req) {
  try {
    if (req && req.op === 'make') return make(req);
    if (req && req.op === 'status') return status(req);
    return { ok: false, code: 'error', message: 'unknown request' };
  } catch (e) {
    return { ok: false, code: e && e.code === 'not_plain' ? 'not_plain' : e && e.code === 'too_many' ? 'too_many' : 'error', message: String((e && e.message) || e).slice(0, 300) };
  }
}

/** In the hub: runs one request in a helper process (same Node binary, no inherited environment). */
function run(request, { timeoutMs = 5000 } = {}) {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(process.execPath, [__filename], { env: {}, timeout: timeoutMs, maxBuffer: MAX_ANSWER, windowsHide: true }, (err, stdout) => {
        if (err) { resolve({ ok: false, code: 'error', message: `the folder helper failed: ${err.message}`.slice(0, 300) }); return; }
        try {
          const a = JSON.parse(String(stdout));
          resolve(a && typeof a === 'object' ? a : { ok: false, code: 'error', message: 'the folder helper gave no answer' });
        } catch { resolve({ ok: false, code: 'error', message: 'the folder helper gave no answer' }); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(request));
    } catch (e) { resolve({ ok: false, code: 'error', message: String((e && e.message) || e).slice(0, 300) }); }
  });
}

if (require.main === module) {
  const chunks = [];
  let size = 0;
  process.stdin.on('data', (d) => { size += d.length; if (size <= 4 * 1024 * 1024) chunks.push(d); });
  process.stdin.on('end', () => {
    let req = null;
    try { req = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
    process.stdout.write(JSON.stringify(size > 4 * 1024 * 1024 ? { ok: false, code: 'error', message: 'request too large' } : handle(req)));
  });
} else {
  module.exports = { run, plainName };
}
