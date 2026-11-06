'use strict';
// Ring module: everything kept on disk.
//
//  * Private state files in the module's data home: written to a temporary file, flushed, renamed over the old file
//    (mode 0600, folders 0700), so a power cut leaves the old file or the new one, never half of one.
//  * The media folder (the notice agent's Files folder): the agent can rename or swap anything in there at any moment,
//    so a folder is opened one plain step at a time (O_DIRECTORY | O_NOFOLLOW) and everything inside is reached through
//    that open descriptor (/proc/self/fd/<n>/<name>), never through its path again. Nothing there is ever followed
//    through a link. Linux only.
//
// createStore({ dataHome, mediaDir, now, log, freeBytes? }) returns:
//   dataHome, mediaDir                          the two folders
//   readJson(name, dflt) / writeJson(name, obj) JSON file inside dataHome (atomic, 0600)
//   readText(name) / writeText(name, text)      text file inside dataHome (atomic, 0600; readText gives null if missing)
//   state() / saveState()                       { seen, lastNotice, suppressed, inbox, outbox, recent, keyEnc }
//   keyEncoding() / setKeyEncoding(enc)         preferred reading of the HMAC key ('utf8' by default)
//   acceptEvent(requestId, entry)               'ok' | 'duplicate' | 'full' (saved; rolled back and thrown if the save fails)
//   inboxList() / inboxRemove(id)               entries (those older than 6 h dropped first) / drop one and save
//   coalescing.get(key) / .set(key, { last, suppressed }) / .clear(key)   same-kind notice window state (saved)
//   outbox.list() / .push(item) / .remove(item) / .prune()                notices the hub has not taken yet (6 h)
//   recent.add(files) / recent.keep()           files named in notices of the last 7 h (Set of relative paths)
//   account() / saveAccount(rec) / claimedAccount() / linkedAccount()     the one linked account (account.json)
//   setNeedsRelink(reason) / clearRelink()      relink flag on the account
//   savePending(id, pair, emailMasked) / pending() / takePending(id) / dropExpiredPending()   tokens waiting for the link
//   devices.get() / devices.save(map)           device cache (devices.json)
//   unsaved.get() / .set(token) / .clear()      a renewed refresh token the hub has not confirmed saving (unsaved.json)
//   linkArm.get() / .arm({ minutes, replace }) / .wrong() / .matches(code) / .clear(id)   the one-time link code
//   workDir, workFile(ext)                      private area where big files are made before being placed
//   freeBytes(dir)                              free space (Infinity when unknown)
//   mediaPut({ parts, names, buf|file, mode, reserve, removeSource }) -> { name, parts }   write a new file in the media folder
//   mediaList(parts, { max, nameRe }) -> [{ name, isFile, size, mtimeMs }]   entries of a media folder, links not followed
//   mediaDirs(parts, { max, re })               folder names (day folders)
//   mediaRemove(parts, name) -> bool            remove a regular file (never a link or folder)
//   mediaRemoveDir(parts) -> bool               remove a folder that is empty
//   mediaSweepTemp(parts, maxAgeMs)             remove leftover hidden temp files
//   openFolder(parts, create, from) / inFolder(parts, create, fn) / listFolder(fd, max, what) / at(fd, name)   pinned-descriptor primitives
//   rateOk(name, max, windowMs) / bucketCount() sliding-window limiter (least recently used keys fall out first)
// Also exported: createStore, writePrivate, writeJsonPrivate, readJson, writeAll, clean, shortId, safeEqualStr,
//   normCode, hashCode, createBuckets, constants (INBOX_MAX, INBOX_KEEP_MS, NOTICE_KEEP_MS, SEEN_KEEP_MS, RECENT_KEEP_MS,
//   PENDING_TOKEN_KEEP_MS, LINK_MAX_TRIES, FREE_SPACE_RESERVE, BUCKET_MAX, CODE_ALPHABET).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SEEN_KEEP_MS = 72 * 3600 * 1000;
const SEEN_MAX = 10000;
const PENDING_TOKEN_KEEP_MS = 3600 * 1000;
const NOTICE_KEEP_MS = 6 * 3600 * 1000;
const RECENT_KEEP_MS = 7 * 3600 * 1000;
const INBOX_MAX = 500;
const INBOX_KEEP_MS = 6 * 3600 * 1000;
const LINK_MAX_TRIES = 5;
const FREE_SPACE_RESERVE = 2 * 1024 * 1024 * 1024;
const BUCKET_MAX = 5000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const TEMP_PREFIX = '.tmp-';
const O_DIR = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;

const clean = (s, max = 80) => { let t = ''; try { t = String(s == null ? '' : s); } catch { /* {"toString": null} can't be turned into text */ } return t.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); };
const shortId = (s) => (s ? `…${String(s).slice(-6)}` : '-');
function safeEqualStr(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const normCode = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashCode = (salt, code) => crypto.createHash('sha256').update(`${salt}:${normCode(code)}`).digest('hex');

function readJson(file, dflt) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; } }
function writeAll(fd, buf) {   // every byte, or an error: never a truncated file
  for (let off = 0; off < buf.length;) {
    const n = fs.writeSync(fd, buf, off, buf.length - off);
    if (n <= 0) throw Object.assign(new Error('short write'), { code: 'EIO' });
    off += n;
  }
}
// Written to a temporary file, flushed to disk, renamed, then the folder flushed.
function writePrivate(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const buf = Buffer.from(text);
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { writeAll(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.unlinkSync(tmp); } catch { /* already gone */ } throw e; }
  const d = fs.openSync(dir, 'r');
  try { fs.fsyncSync(d); } catch (e) { if (!['EINVAL', 'ENOTSUP'].includes(e.code)) throw e; } finally { fs.closeSync(d); }
}
const writeJsonPrivate = (file, obj) => writePrivate(file, JSON.stringify(obj, null, 2) + '\n');

function createBuckets(now = Date.now) {
  const buckets = new Map();
  function rateOk(name, max, windowMs) {
    const t = now();
    const b = (buckets.get(name) || []).filter((x) => t - x < windowMs);
    const okay = b.length < max;
    if (okay) b.push(t);
    buckets.delete(name);
    buckets.set(name, b);
    while (buckets.size > BUCKET_MAX) buckets.delete(buckets.keys().next().value);
    return okay;
  }
  return { rateOk, bucketCount: () => buckets.size };
}

function createStore({ dataHome, mediaDir, now = Date.now, log = () => {}, freeBytes: freeBytesFn } = {}) {
  if (!dataHome) throw new Error('createStore needs dataHome');
  const file = (name) => path.join(dataHome, name);
  const readJ = (name, d) => readJson(file(name), d);
  const writeJ = (name, obj) => writeJsonPrivate(file(name), obj);
  const readText = (name) => { try { return fs.readFileSync(file(name), 'utf8'); } catch { return null; } };
  const writeText = (name, text) => writePrivate(file(name), text);
  const buckets = createBuckets(now);
  const quiet = new Map();
  const logEvery = (key, ms, ...a) => { const t = quiet.get(key) || 0; if (now() - t > ms) { quiet.set(key, now()); log(...a); } };

  // ── state ────────────────────────────────────────────────────────────────────────────────────────────────────
  let STATE = null;
  function state() {
    if (!STATE) {
      const s = readJ('state.json', {});
      STATE = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
      for (const k of ['seen', 'lastNotice', 'suppressed']) if (!STATE[k] || typeof STATE[k] !== 'object' || Array.isArray(STATE[k])) STATE[k] = {};
      for (const k of ['inbox', 'outbox', 'recent']) if (!Array.isArray(STATE[k])) STATE[k] = [];
    }
    return STATE;
  }
  function saveState() {
    const st = state();
    const t = now();
    for (const [k, v] of Object.entries(st.seen)) if (t - v > SEEN_KEEP_MS) delete st.seen[k];
    const ids = Object.keys(st.seen);
    if (ids.length > SEEN_MAX) ids.sort((a, b) => st.seen[a] - st.seen[b]).slice(0, ids.length - SEEN_MAX).forEach((k) => delete st.seen[k]);
    st.recent = st.recent.filter((r) => t - r.at <= RECENT_KEEP_MS);
    writeJ('state.json', st);
  }
  const keyEncoding = () => { const e = state().keyEnc; return ['utf8', 'base64', 'hex'].includes(e) ? e : 'utf8'; };
  function setKeyEncoding(enc) {
    if (!['utf8', 'base64', 'hex'].includes(enc) || keyEncoding() === enc) return;
    state().keyEnc = enc;
    saveState();
    log(`Ring's signatures match the HMAC key read as ${enc}; remembered`);
  }
  function acceptEvent(requestId, entry) {
    const st = state();
    if (requestId && st.seen[requestId]) return 'duplicate';
    if (st.inbox.length >= INBOX_MAX) return 'full';
    st.inbox.push(entry);
    if (requestId) st.seen[requestId] = now();
    try { saveState(); } catch (e) { st.inbox.pop(); if (requestId) delete st.seen[requestId]; throw e; }
    return 'ok';
  }
  function inboxList() {
    const st = state();
    const old = st.inbox.filter((e) => now() - e.at > INBOX_KEEP_MS);
    if (old.length) { st.inbox = st.inbox.filter((e) => now() - e.at <= INBOX_KEEP_MS); saveState(); log(`dropped ${old.length} event(s) older than 6 h`); }
    return st.inbox.slice();
  }
  function inboxRemove(id) { const st = state(); st.inbox = st.inbox.filter((e) => e.id !== id); saveState(); }
  const coalescing = {
    get: (key) => ({ last: state().lastNotice[key] || 0, suppressed: state().suppressed[key] || 0 }),
    set(key, v) {
      const st = state();
      if (v.last) st.lastNotice[key] = v.last;
      if (v.suppressed) st.suppressed[key] = v.suppressed; else delete st.suppressed[key];
      saveState();
    },
    clear(key) { const st = state(); delete st.lastNotice[key]; delete st.suppressed[key]; saveState(); },
  };
  const outbox = {
    list: () => state().outbox.slice(),
    push(item) { state().outbox.push({ at: now(), tries: 0, ...item }); saveState(); },
    remove(item) { const st = state(); st.outbox = st.outbox.filter((x) => x !== item); saveState(); },
    prune() {   // a notice the hub has not taken for 6 h is dropped
      const st = state();
      const keep = st.outbox.filter((x) => now() - x.at <= NOTICE_KEEP_MS);
      const dropped = st.outbox.length - keep.length;
      if (dropped) { st.outbox = keep; saveState(); log(`dropped ${dropped} notice(s) the hub did not take within 6 h`); }
      return dropped;
    },
  };
  const recent = {
    add(files) { const st = state(); for (const f of files || []) if (typeof f === 'string' && f) st.recent.push({ file: f, at: now() }); saveState(); },
    keep() { const t = now(); return new Set(state().recent.filter((r) => t - r.at <= RECENT_KEEP_MS).map((r) => r.file)); },
  };

  // ── account, pending links, devices, unsaved token ───────────────────────────────────────────────────────────
  const accountFile = () => { const j = readJ('account.json', {}); const o = j && typeof j === 'object' && !Array.isArray(j) ? j : {}; if (!o.pending || typeof o.pending !== 'object') o.pending = {}; return o; };
  const account = () => { const a = accountFile().account; return a && typeof a === 'object' && a.account_id ? a : null; };
  function saveAccount(rec) { const f = accountFile(); f.account = rec; writeJ('account.json', f); }
  const claimedAccount = () => { const a = account(); return a && !a.needs_relink ? a.account_id : null; };   // linked and signed in
  const linkedAccount = () => { const a = account(); return a ? a.account_id : null; };   // linked, whether or not its sign-in works
  function setNeedsRelink(reason) { const a = account(); if (!a) return; a.needs_relink = true; a.relink_reason = clean(reason, 200); saveAccount(a); }
  function clearRelink() { const a = account(); if (!a || (!a.needs_relink && !a.relink_reason)) return; a.needs_relink = false; delete a.relink_reason; saveAccount(a); }
  function savePending(id, pair, emailMasked) {
    const f = accountFile();
    f.pending[id] = { ...pair, email_masked: emailMasked || null, obtained_at: pair.obtained_at || now() };
    writeJ('account.json', f);
  }
  const pending = () => accountFile().pending;
  function takePending(id) { const f = accountFile(); const p = f.pending[id] || null; if (p) { delete f.pending[id]; writeJ('account.json', f); } return p; }
  function dropExpiredPending() {
    const f = accountFile();
    let changed = false;
    for (const [id, p] of Object.entries(f.pending)) if (!p || now() - p.obtained_at > PENDING_TOKEN_KEEP_MS) { delete f.pending[id]; changed = true; }
    if (changed) writeJ('account.json', f);
    return changed;
  }
  const devices = { get: () => readJ('devices.json', {}), save: (obj) => writeJ('devices.json', obj) };
  const unsaved = {
    get() { const u = readJ('unsaved.json', null); return u && typeof u.refresh_token === 'string' && u.refresh_token ? u.refresh_token : null; },
    set(token) { writeJ('unsaved.json', { refresh_token: token, at: now() }); },
    clear() { try { fs.unlinkSync(file('unsaved.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; } },
  };

  // ── the one-time link code ───────────────────────────────────────────────────────────────────────────────────
  const armFile = () => file('link-arm.json');
  const linkArm = {
    get() { const a = readJson(armFile(), null); return a && a.expiresAt > now() && (a.tries || 0) < LINK_MAX_TRIES ? a : null; },
    arm({ minutes, replace } = {}) {
      const mins = Math.min(Math.max(Number(minutes) || 30, 5), 120);
      let code = '';
      for (let i = 0; i < 8; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      const salt = crypto.randomBytes(16).toString('hex');
      const rec = { id: crypto.randomUUID(), salt, codeHash: hashCode(salt, code), expiresAt: now() + mins * 60000, tries: 0, replace: !!replace };
      writeJsonPrivate(armFile(), rec);
      return { id: rec.id, minutes: mins, replace: rec.replace, code: `${code.slice(0, 4)}-${code.slice(4)}`, expires_at: new Date(rec.expiresAt).toISOString() };
    },
    matches(code, arm = linkArm.get()) { return !!arm && safeEqualStr(hashCode(arm.salt, code), arm.codeHash); },
    // A wrong code: counts a try; the fifth deletes the record. Returns { tries, closed }.
    wrong() {
      const arm = linkArm.get();
      if (!arm) return { tries: 0, closed: true };
      arm.tries = (arm.tries || 0) + 1;
      if (arm.tries >= LINK_MAX_TRIES) { try { fs.unlinkSync(armFile()); } catch { /* gone */ } log('link page closed after too many wrong codes'); return { tries: arm.tries, closed: true }; }
      writeJsonPrivate(armFile(), arm);
      return { tries: arm.tries, closed: false };
    },
    clear(id) {   // only the code that was used, never one armed meanwhile
      const a = readJson(armFile(), null);
      if (a && (id === undefined || a.id === id)) { try { fs.unlinkSync(armFile()); } catch { /* gone */ } }
    },
  };

  // ── private work area ────────────────────────────────────────────────────────────────────────────────────────
  const workDir = file('work');
  function workFile(ext) {
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    return path.join(workDir, `${now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`);
  }
  const freeBytes = (dir) => {
    if (freeBytesFn) return freeBytesFn(dir);
    try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; }
  };

  // ── the media folder, through pinned descriptors ─────────────────────────────────────────────────────────────
  const at = (fd, name) => `/proc/self/fd/${fd}/${name}`;
  function checkParts(parts) {
    if (!Array.isArray(parts) || parts.some((p) => typeof p !== 'string' || !p || p === '.' || p === '..' || p.includes('/') || p.includes('\0'))) {
      throw Object.assign(new Error('a folder outside the Files folder'), { code: 'bad folder' });
    }
  }
  // The root is the folder the hub checked at start; it is checked to still be a plain folder on every run.
  function openRoot() {
    if (!mediaDir) throw Object.assign(new Error('no media folder'), { code: 'no media folder' });
    const st = fs.lstatSync(mediaDir);
    if (!st.isDirectory()) throw Object.assign(new Error('the Files folder is not a plain folder'), { code: 'not a plain folder' });
    return fs.openSync(mediaDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  }
  // Opens mediaDir/parts, or <open folder from>/parts, one plain folder at a time (made if missing when create is set).
  function openFolder(parts, create, from) {
    checkParts(parts);
    let fd = from === undefined ? openRoot() : fs.openSync(`/proc/self/fd/${from}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      for (const part of parts) {
        if (create) { try { fs.mkdirSync(at(fd, part), 0o775); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
        let next;
        try { next = fs.openSync(at(fd, part), O_DIR); } catch (e) {
          if (e.code === 'ELOOP' || e.code === 'ENOTDIR') throw Object.assign(new Error(`${part} in the Files folder is not a plain folder`), { code: 'not a plain folder' });
          throw e;
        }
        fs.closeSync(fd);
        fd = next;
      }
      return fd;
    } catch (e) { fs.closeSync(fd); throw e; }
  }
  function inFolder(parts, create, fn) { const fd = openFolder(parts, create); try { return fn(fd); } finally { fs.closeSync(fd); } }
  // Names in an open folder, read a few at a time and never more than max entries: a folder flooded with names can't stall us.
  function listFolder(fd, max, what) {
    const names = [];
    let full = false;
    const dir = fs.opendirSync(`/proc/self/fd/${fd}`, { bufferSize: 64 });
    try {
      for (let n = 0, e; (e = dir.readSync()) !== null; n++) {
        if (n >= max) { full = true; break; }
        names.push(e.name);
      }
    } finally { dir.closeSync(); }
    if (full) logEvery(`full:${what}`, 3600000, `the ${what} folder holds more than ${max} entries: only the first ${max} are looked at`);
    return names;
  }
  const hiddenName = () => `${TEMP_PREFIX}${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  function copyInto(fd, src) {
    const sfd = fs.openSync(src, 'r');
    try {
      const chunk = Buffer.allocUnsafe(1024 * 1024);
      for (let n; (n = fs.readSync(sfd, chunk, 0, chunk.length, null)) > 0;) writeAll(fd, chunk.subarray(0, n));
    } finally { fs.closeSync(sfd); }
  }
  // Writes a new file into mediaDir/parts under the first free name in names. The bytes go to a hidden temp name in the
  // final folder first (so a half-written file never has its real name, and no link crosses filesystems), then take the
  // real name without replacing anything: a link (or a name planted by someone else) at that name is never followed or
  // overwritten. buf = bytes, or file = a finished file elsewhere that is copied in (and removed with removeSource).
  function mediaPut({ parts, names, buf, file: srcFile, mode = 0o664, reserve = FREE_SPACE_RESERVE, removeSource = false, useLink = true }) {
    const size = buf ? buf.length : fs.statSync(srcFile).size;
    if (reserve && freeBytes(mediaDir) < reserve + size) throw Object.assign(new Error('the disk is nearly full'), { code: 'disk nearly full' });
    return inFolder(parts, true, (dfd) => {
      const tmp = hiddenName();
      let fd;
      try {
        fd = fs.openSync(at(dfd, tmp), 'wx', 0o600);
        try { if (buf) writeAll(fd, buf); else copyInto(fd, srcFile); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        for (const name of names) {
          let placed = false;
          if (useLink) {
            try { fs.linkSync(at(dfd, tmp), at(dfd, name)); fs.unlinkSync(at(dfd, tmp)); placed = true; } catch (e) {
              if (e.code === 'EEXIST') continue;
              if (!['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK'].includes(e.code)) throw e;
            }
          }
          if (!placed && !claimByPlaceholder(dfd, tmp, name)) continue;
          if (removeSource && srcFile) { try { fs.unlinkSync(srcFile); } catch { /* left for the work-area cleanup */ } }
          return { name, parts: parts.slice() };
        }
        throw new Error('too many files with the same name');
      } catch (e) { try { fs.unlinkSync(at(dfd, tmp)); } catch { /* already gone */ } throw e; }
    });
  }
  // For a folder that can't hard-link: reserve the name with an exclusive create, then rename the finished file over it.
  function claimByPlaceholder(dfd, tmp, name) {
    let ph;
    try { ph = fs.openSync(at(dfd, name), 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
    fs.closeSync(ph);
    try { fs.renameSync(at(dfd, tmp), at(dfd, name)); } catch (e) { try { fs.unlinkSync(at(dfd, name)); } catch { /* gone */ } throw e; }
    return true;
  }
  function mediaList(parts, { max = 20000, nameRe } = {}) {
    let fd;
    try { fd = openFolder(parts, false); } catch { return []; }
    try {
      const out = [];
      for (const name of listFolder(fd, max, parts.join('/'))) {
        if (nameRe && !nameRe.test(name)) continue;
        let st;
        try { st = fs.lstatSync(at(fd, name)); } catch { continue; }
        out.push({ name, isFile: st.isFile(), size: st.size, mtimeMs: st.mtimeMs });
      }
      return out;
    } finally { fs.closeSync(fd); }
  }
  function mediaDirs(parts, { max = 2000, re = /^\d{4}-\d{2}-\d{2}$/ } = {}) {
    let fd;
    try { fd = openFolder(parts, false); } catch { return []; }
    try { return listFolder(fd, max, parts.join('/')).filter((d) => re.test(d)).sort(); } catch { return []; } finally { fs.closeSync(fd); }
  }
  function mediaRemove(parts, name) {
    if (typeof name !== 'string' || !name || name.includes('/') || name === '..' || name === '.') return false;
    let fd;
    try { fd = openFolder(parts, false); } catch { return false; }
    try {
      if (!fs.lstatSync(at(fd, name)).isFile()) return false;
      fs.unlinkSync(at(fd, name));
      return true;
    } catch { return false; } finally { fs.closeSync(fd); }
  }
  function mediaRemoveDir(parts) {
    if (!parts.length) return false;
    let fd;
    try { fd = openFolder(parts.slice(0, -1), false); } catch { return false; }
    try { fs.rmdirSync(at(fd, parts[parts.length - 1])); return true; } catch { return false; } finally { fs.closeSync(fd); }
  }
  function mediaSweepTemp(parts, maxAgeMs = 3600000) {
    let n = 0;
    for (const e of mediaList(parts, { nameRe: /^\.tmp-/ })) if (e.isFile && now() - e.mtimeMs > maxAgeMs && mediaRemove(parts, e.name)) n++;
    return n;
  }

  return {
    dataHome, mediaDir,
    readJson: readJ, writeJson: writeJ, readText, writeText,
    state, saveState, keyEncoding, setKeyEncoding, acceptEvent, inboxList, inboxRemove, coalescing, outbox, recent,
    account, saveAccount, claimedAccount, linkedAccount, setNeedsRelink, clearRelink,
    savePending, pending, takePending, dropExpiredPending, devices, unsaved, linkArm,
    workDir, workFile, freeBytes,
    mediaPut, mediaList, mediaDirs, mediaRemove, mediaRemoveDir, mediaSweepTemp,
    openFolder, inFolder, listFolder, at,
    rateOk: buckets.rateOk, bucketCount: buckets.bucketCount,
  };
}

module.exports = {
  createStore, writePrivate, writeJsonPrivate, readJson, writeAll, clean, shortId, safeEqualStr, normCode, hashCode, createBuckets,
  INBOX_MAX, INBOX_KEEP_MS, NOTICE_KEEP_MS, SEEN_KEEP_MS, RECENT_KEEP_MS, PENDING_TOKEN_KEEP_MS, LINK_MAX_TRIES, FREE_SPACE_RESERVE, BUCKET_MAX, CODE_ALPHABET,
};
