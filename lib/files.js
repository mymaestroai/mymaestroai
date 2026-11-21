'use strict';
// Files area: one folder per owner that both the person (upload / download in the hub pages, or a network share)
// and their agents (plain filesystem reads and writes) can reach.
//   admin's own files   ~/agent-hub/share                 (the existing inbox/outbox share; every agent's root)
//   member's files      ~/agent-hub/users/<id>/files      (inside the member tree the tool policy allows)
// A member only ever reaches their own folder; an admin may open any owner's folder (owner switcher).
// Paths from the pages are relative to that root; anything that resolves outside it (.., symlinks) is refused.

const fs = require('fs');
const path = require('path');

const HUB_ROOT = path.resolve(__dirname, '..');
const { HUB_HOME } = require('./hub-home');   // share/, users/, medical/, legal/: see lib/hub-home

const DEFAULT_MAX_UPLOAD = 512 * 1024 * 1024;   // 512 MB per file unless settings.filesMaxUploadMb says otherwise

const MIME = {
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.json': 'application/json',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.xml': 'application/xml', '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.zip': 'application/zip', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
function mimeOf(name) { return MIME[path.extname(String(name)).toLowerCase()] || 'application/octet-stream'; }

/** A safe file or folder name: no path separators, no leading dot (hidden files never show in the panel), nothing control, at most 200 chars. */
function cleanName(name) {
  let n = String(name || '').replace(/[\\/\0]/g, '').replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!n || n.startsWith('.')) return null;
  if (n.length > 200) n = n.slice(0, 200);
  return n;
}

// ── Easier downloads: kinds, URLs, the zip format ──
const KINDS = {
  image: 'png jpg jpeg gif webp bmp ico svg avif heic', pdf: 'pdf', audio: 'mp3 m4a wav ogg oga flac aac opus', video: 'mp4 mov webm mkv avi m4v',
  archive: 'zip gz tgz tar 7z rar bz2 xz', text: 'txt md csv tsv json log yml yaml ini toml html htm xml js mjs css py sh sql rtf',
};
const KIND_OF_EXT = {};
for (const [k, exts] of Object.entries(KINDS)) for (const e of exts.split(' ')) KIND_OF_EXT[e] = k;
/** 'image' | 'pdf' | 'audio' | 'video' | 'archive' | 'text' | 'other', from the file name. */
function kindOf(name) { return KIND_OF_EXT[path.extname(String(name)).slice(1).toLowerCase()] || 'other'; }
/** Active types (they would run as the hub's own origin when shown inline) are always attachments, like the download route. */
function isActiveName(name) { return /\.(html?|xhtml|svg|xml|js|mjs)$/i.test(String(name)); }
/** The exact URL of the existing download route: agent= when the file is in an agent's folder, else owner=. */
function downloadUrl({ agent = null, owner = null, path: rel = '' } = {}, { inline = false } = {}) {
  const who = agent ? `agent=${encodeURIComponent(agent)}` : `owner=${encodeURIComponent(owner || 'mine')}`;
  return `/api/files/download?${who}&path=${encodeURIComponent(rel)}${inline ? '&inline=1' : ''}`;
}
const ZIP_ALREADY_COMPRESSED = new Set(['.zip', '.gz', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp3', '.mp4', '.m4a', '.mov', '.pdf']);
const RECENT_MAX_ENTRIES = 20000, RECENT_MAX_DEPTH = 8, LEDGER_MAX = 2000, ZIP_WALK_MAX_ENTRIES = 20000, ZIP_MAX_BYTES_CAP = 3900 * 1048576, ZIP_MAX_FILES_CAP = 65535;

// CRC-32 (same results as zlib.crc32, which older Node versions lack): crc32Js(buf, previous) -> unsigned 32-bit.
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32Js(buf, prev = 0) {
  let c = (~prev) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (~c) >>> 0;
}
const crc32Of = (buf, prev) => (typeof require('zlib').crc32 === 'function' ? require('zlib').crc32(buf, prev) : crc32Js(buf, prev));

const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])$/i;   // incl. the superscript forms Windows also reserves
/**
 * One zip path segment that extracts safely on Windows and macOS: "\", ":", "*", "?", quotes, "<", ">", "|" and control characters become "_";
 * trailing dots and spaces become "_" ("x.txt " -> "x.txt_", "dir." -> "dir_"); a Windows reserved name (CON, PRN, AUX, NUL, COM1-9, LPT1-9, with or
 * without an extension) gets a "_" prefix; an empty, "." or ".." segment becomes "_".
 */
function sanitizeSegment(seg) {
  seg = String(seg);
  if (seg === '' || seg === '.' || seg === '..') return '_';
  let s = seg.replace(/[\\:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/, (m) => '_'.repeat(m.length));
  if (WINDOWS_RESERVED.test(s.split('.')[0].replace(/[ .]+$/, ''))) s = `_${s}`;   // Windows ignores spaces before the extension: "CON .txt" is CON
  return s;
}

/** "512 B", "1.2 KB", "9.4 MB", "2 GB" (a trailing .0 is dropped). */
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB']; let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1).replace(/\.0$/, '')} ${units[i]}`;
}
/** The zip limits from the settings (filesZipMaxMb default 2048, never above 3900 so no ZIP64 is needed; filesZipMaxFiles default 2000). */
function zipLimits(maxMb, maxFiles) {
  const mb = Number(maxMb) > 0 ? Number(maxMb) : 2048;
  const nf = Number(maxFiles) > 0 ? Math.floor(Number(maxFiles)) : 2000;
  return { maxBytes: Math.max(1, Math.min(ZIP_MAX_BYTES_CAP, Math.floor(mb * 1048576))), maxFiles: Math.max(1, Math.min(ZIP_MAX_FILES_CAP, nf)) };
}
function dosDateTime(d) {
  const y = Math.min(2107, Math.max(1980, d.getFullYear()));
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

function createFiles({ hubHome = HUB_HOME, fsImpl = fs, getUser = () => null, isAdminUser = (u) => !!u && u.role === 'admin', maxUploadBytes = () => DEFAULT_MAX_UPLOAD, dataDir = null } = {}) {
  /** Where an owner's files live. ownerId null / 'mine' for an admin = the shared admin folder. */
  function rootFor(ownerId) {
    if (!ownerId || ownerId === 'mine' || ownerId === 'infra') return path.join(hubHome, 'share');
    const u = getUser(String(ownerId));
    if (u && isAdminUser(u)) return path.join(hubHome, 'share');
    return path.join(hubHome, 'users', String(ownerId), 'files');
  }

  /**
   * rootForAgent(agentRecord, { memberOwned }) -> the folder the Files panel shows for one agent.
   *   member-owned agent     users/<owner>/files            (one folder per member, shared by that member's team)
   *   medical team (GP...)  ~/agent-hub/medical            (its existing inbox/ and patients/ live here)
   *   legal team (Counsel..) ~/agent-hub/legal
   *   any other agent        ~/agent-hub/share/<agent>      (its own folder on the share)
   */
  function rootForAgent(agent, { memberOwned = false } = {}) {
    if (!agent || !agent.name) return path.join(hubHome, 'share');
    const name = String(agent.name);
    if (agent.owner && memberOwned) return path.join(hubHome, 'users', String(agent.owner), 'files');
    let tp = null; try { tp = require('./tool-policy'); } catch {}
    const team = tp && tp.teamFolderOf ? tp.teamFolderOf(agent) : null;   // the agent's own folder grant, not its name
    if (team) return path.join(hubHome, team);
    return path.join(hubHome, 'share', name.replace(/[^a-zA-Z0-9_.-]/g, '_'));
  }
  /** resolveAgent(user, agentRecord, { memberOwned }) -> { ownerId, agent, root, label } */
  function resolveAgent(user, agent, { memberOwned = false } = {}) {
    if (!user || !agent) return null;
    const root = rootForAgent(agent, { memberOwned });
    const display = agent.display || agent.name;
    return { ownerId: agent.owner ? String(agent.owner) : 'mine', agent: agent.name, root, label: `Files of ${display}` };
  }

  /**
   * resolveOwner(user, requestedOwner) -> { ownerId, root, label } | null (not allowed).
   * Members always get their own folder; admins may name any owner ('mine' = the admin share).
   */
  function resolveOwner(user, requested) {
    if (!user) return null;
    let ownerId = user.id;
    if (isAdminUser(user)) {
      ownerId = (!requested || requested === 'mine' || requested === 'infra') ? 'mine' : String(requested);
      if (ownerId !== 'mine' && !getUser(ownerId)) return null;
    }
    const root = rootFor(ownerId);
    const u = ownerId === 'mine' ? null : getUser(ownerId);
    const label = ownerId === 'mine' ? 'Hub share (your files)' : (ownerId === user.id ? 'Your files' : `Files of ${u && (u.name || u.login) || ownerId}`);
    return { ownerId, root, label };
  }

  /** resolve(root, rel) -> absolute path inside root, or null if it escapes (.. or a symlink pointing out). */
  function resolve(root, rel) {
    const r = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (r.split('/').some(seg => seg === '..')) return null;
    const abs = path.resolve(root, r);
    const rootAbs = path.resolve(root);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
    // Symlink check on the deepest existing ancestor: nothing inside the root may point outside it.
    let probe = abs;
    while (!fsImpl.existsSync(probe) && probe !== rootAbs) probe = path.dirname(probe);
    try {
      const real = fsImpl.realpathSync(probe);
      const realRoot = fsImpl.realpathSync(rootAbs);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    } catch { return null; }
    return abs;
  }
  function relOf(root, abs) { return path.relative(path.resolve(root), abs).split(path.sep).join('/'); }

  function ensureRoot(root) { fsImpl.mkdirSync(root, { recursive: true, mode: 0o700 }); }

  function entryOf(dir, name) {
    try {
      const st = fsImpl.statSync(path.join(dir, name));
      return { name, type: st.isDirectory() ? 'dir' : 'file', size: st.isDirectory() ? 0 : st.size, mtime: st.mtime.toISOString() };
    } catch { return null; }
  }

  function list(root, rel = '') {
    ensureRoot(root);
    const abs = resolve(root, rel);
    if (!abs) return { ok: false, code: 400, error: 'bad path' };
    let st; try { st = fsImpl.statSync(abs); } catch { return { ok: false, code: 404, error: 'not found' }; }
    if (!st.isDirectory()) return { ok: false, code: 400, error: 'not a folder' };
    const names = fsImpl.readdirSync(abs).filter(n => !n.startsWith('.'));
    const entries = names.map(n => entryOf(abs, n)).filter(Boolean)
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : (a.type === 'dir' ? -1 : 1)));
    return { ok: true, path: relOf(root, abs), absPath: abs, entries };
  }

  function stat(root, rel) {
    const abs = resolve(root, rel);
    if (!abs) return { ok: false, code: 400, error: 'bad path' };
    try { const st = fsImpl.statSync(abs); return { ok: true, abs, st, isDir: st.isDirectory() }; } catch { return { ok: false, code: 404, error: 'not found' }; }
  }

  /** Where an upload lands: the target file path for (dir rel, filename), refusing an existing file unless overwrite. */
  function uploadTarget(root, dirRel, name, { overwrite = false } = {}) {
    ensureRoot(root);
    const clean = cleanName(name);
    if (!clean) return { ok: false, code: 400, error: 'bad file name' };
    const dir = resolve(root, dirRel);
    if (!dir) return { ok: false, code: 400, error: 'bad path' };
    try { fsImpl.mkdirSync(dir, { recursive: true }); } catch {}
    const abs = path.join(dir, clean);
    if (!resolve(root, relOf(root, abs))) return { ok: false, code: 400, error: 'bad path' };
    if (!overwrite && fsImpl.existsSync(abs)) return { ok: false, code: 409, error: 'a file with that name exists' };
    return { ok: true, abs, rel: relOf(root, abs), name: clean };
  }

  /**
   * saveStream(target, stream, { maxBytes }) -> Promise<{ ok, entry, path, absPath } | { ok:false, code, error }>
   * Writes to a temp name beside the target and renames on success, so a half upload never shows up.
   */
  function saveStream(target, stream, { maxBytes = maxUploadBytes() } = {}) {
    return new Promise((resolveP) => {
      const tmp = `${target.abs}.part-${process.pid}-${Date.now()}`;
      const out = fsImpl.createWriteStream(tmp, { mode: 0o600 });
      let size = 0, done = false;
      // The write stream opens its file asynchronously, so the temp file is removed only once it has closed.
      const fail = (code, error) => {
        if (done) return; done = true;
        out.once('close', () => { try { fsImpl.unlinkSync(tmp); } catch {} resolveP({ ok: false, code, error }); });
        try { out.destroy(); } catch { try { fsImpl.unlinkSync(tmp); } catch {} resolveP({ ok: false, code, error }); }
      };
      stream.on('data', (chunk) => { size += chunk.length; if (size > maxBytes) { fail(413, `file is larger than ${Math.round(maxBytes / 1048576)} MB`); try { stream.destroy(); } catch {} } });
      stream.on('error', (e) => fail(500, e.message));
      out.on('error', (e) => fail(500, e.message));
      out.on('finish', () => {
        if (done) return; done = true;
        try { fsImpl.renameSync(tmp, target.abs); } catch (e) { try { fsImpl.unlinkSync(tmp); } catch {} return resolveP({ ok: false, code: 500, error: e.message }); }
        recordUpload(target.abs);
        resolveP({ ok: true, entry: entryOf(path.dirname(target.abs), target.name), path: target.rel, absPath: target.abs });
      });
      stream.pipe(out);
    });
  }

  function remove(root, rel) {
    const s = stat(root, rel);
    if (!s.ok) return s;
    if (s.abs === path.resolve(root)) return { ok: false, code: 400, error: 'cannot delete the root folder' };
    try { fsImpl.rmSync(s.abs, { recursive: true, force: true }); } catch (e) { return { ok: false, code: 500, error: e.message }; }
    return { ok: true };
  }

  function mkdir(root, dirRel, name) {
    ensureRoot(root);
    const clean = cleanName(name);
    if (!clean) return { ok: false, code: 400, error: 'bad folder name' };
    const dir = resolve(root, dirRel);
    if (!dir) return { ok: false, code: 400, error: 'bad path' };
    const abs = path.join(dir, clean);
    if (fsImpl.existsSync(abs)) return { ok: false, code: 409, error: 'something with that name exists' };
    try { fsImpl.mkdirSync(abs, { recursive: true }); } catch (e) { return { ok: false, code: 500, error: e.message }; }
    return { ok: true, path: relOf(root, abs), absPath: abs };
  }

  function rename(root, rel, newName) {
    const s = stat(root, rel);
    if (!s.ok) return s;
    if (s.abs === path.resolve(root)) return { ok: false, code: 400, error: 'cannot rename the root folder' };
    const clean = cleanName(newName);
    if (!clean) return { ok: false, code: 400, error: 'bad name' };
    const abs = path.join(path.dirname(s.abs), clean);
    if (fsImpl.existsSync(abs)) return { ok: false, code: 409, error: 'something with that name exists' };
    try { fsImpl.renameSync(s.abs, abs); } catch (e) { return { ok: false, code: 500, error: e.message }; }
    return { ok: true, path: relOf(root, abs), absPath: abs };
  }

  // ── Upload ledger: <dataDir>/files-uploads.json, [{ abs, size, mtimeMs }], newest last, at most LEDGER_MAX, read lazily, written atomically ──
  // A file counts as an upload only while its size and mtime still match the entry: an agent that rewrites it makes it "from agents" again.
  let ledger = null;
  const ledgerFile = dataDir ? path.join(dataDir, 'files-uploads.json') : null;
  function loadLedger() {
    if (ledger) return ledger;
    ledger = [];
    if (ledgerFile) {
      try {
        const j = JSON.parse(fsImpl.readFileSync(ledgerFile, 'utf8'));
        if (Array.isArray(j)) ledger = j.filter(e => e && typeof e.abs === 'string' && Number.isFinite(e.size) && Number.isFinite(e.mtimeMs)).slice(-LEDGER_MAX);
      } catch { /* none yet, or unreadable: start empty */ }
    }
    return ledger;
  }
  function recordUpload(abs) {
    let st; try { st = fsImpl.statSync(abs); } catch { return; }
    const l = loadLedger().filter(e => e.abs !== abs);
    l.push({ abs, size: st.size, mtimeMs: st.mtimeMs });
    ledger = l.slice(-LEDGER_MAX);
    if (!ledgerFile) return;
    try {
      fsImpl.mkdirSync(dataDir, { recursive: true });
      const tmp = `${ledgerFile}.tmp-${process.pid}`;
      fsImpl.writeFileSync(tmp, JSON.stringify(ledger), { mode: 0o600 });
      fsImpl.renameSync(tmp, ledgerFile);
    } catch { /* the ledger is a hint for "recent"; a failed write never fails the upload */ }
  }
  /** True while the file at abs is the very file the person uploaded (same size and mtime). */
  function isUploaded(abs, st) {
    return loadLedger().some(e => e.abs === abs && e.size === st.size && e.mtimeMs === st.mtimeMs);
  }

  // ── Absolute paths an agent wrote in a reply ──
  /** resolveAbs(root, abs) -> { abs, rel } when the absolute path lies inside root (through resolve(): no "..", no symlink out), else null. */
  function resolveAbs(root, abs) {
    if (typeof abs !== 'string' || !abs || abs.length > 4096 || abs.includes('\0') || !path.isAbsolute(abs)) return null;
    if (abs.replace(/\\/g, '/').split('/').some(seg => seg === '..')) return null;
    const rootAbs = path.resolve(root), a = path.resolve(abs);
    if (a === rootAbs || !a.startsWith(rootAbs + path.sep)) return null;
    const rel = relOf(rootAbs, a);
    const ok = resolve(root, rel);
    return ok ? { abs: ok, rel } : null;
  }
  /** fileInfo(root, rel, { agent, owner }) -> the /api/files/resolve result for a regular file inside root, or null (missing, a folder, outside). */
  function fileInfo(root, rel, { agent = null, owner = null } = {}) {
    const abs = resolve(root, rel);
    if (!abs || abs === path.resolve(root)) return null;
    let st;
    try {
      const ls = fsImpl.lstatSync(abs);
      if (ls.isSymbolicLink()) {   // a final symlink must point inside the root (resolve says so too; this narrows the window)
        const real = fsImpl.realpathSync(abs), realRoot = fsImpl.realpathSync(path.resolve(root));
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
      }
      st = fsImpl.statSync(abs);
    } catch { return null; }
    if (!st.isFile()) return null;
    if (resolve(root, rel) !== abs) return null;   // the same answer again after the stat
    const name = path.basename(abs), clean = relOf(root, abs);
    const where = { agent: agent || null, owner: agent ? null : (owner || 'mine'), path: clean };
    return { ok: true, name, size: st.size, mtime: st.mtime.toISOString(), mime: mimeOf(name), kind: kindOf(name), isDir: false, ...where,
      download: downloadUrl(where), inline: isActiveName(name) ? null : downloadUrl(where, { inline: true }) };
  }

  const isInside = (real, realRoot) => real === realRoot || real.startsWith(realRoot + path.sep);

  /**
   * findByName(root, name, { maxDepth, maxEntries }) -> rel | null. The path (below root) of the ONE regular file called name (exact,
   * case-sensitive). null when there is none, two or more, or the walk was cut short (an incomplete walk cannot prove the match is unique).
   */
  // index (optional): a nameIndex() of the same root, so one request that asks for several names walks the folder once.
  function findByName(root, name, { maxDepth = 6, maxEntries = 5000, index = null } = {}) {
    if (typeof name !== 'string' || name.length < 3 || name.length > 255 || name.startsWith('.') || name.startsWith(' ') || name.endsWith(' ')
      || /[\/\\\x00-\x1f\x7f]/.test(name) || name.includes('..')) return null;
    const idx = index || nameIndex(root, { maxDepth, maxEntries });
    if (!idx.complete) return null;
    const hits = idx.byName.get(name) || [];
    return hits.length === 1 ? hits[0] : null;
  }
  /** nameIndex(root, { maxDepth, maxEntries }) -> { complete, byName: Map(name -> [rel, ...]) } of the regular files under root (walkTree rules). */
  function nameIndex(root, { maxDepth = 6, maxEntries = 5000 } = {}) {
    const byName = new Map();
    const w = walkTree(path.resolve(root), '', { maxDepth, maxEntries, onFile: (f) => { const l = byName.get(f.name); if (l) l.push(f.rel); else byName.set(f.name, [f.rel]); } });
    return { complete: !(w.truncated || w.tooDeep || w.unreadable), byName };   // a skipped folder could hide a second file of the same name
  }

  /**
   * walkTree(root, rel, { maxDepth, maxEntries, onFile, onDir, onUnreadable }) -> { truncated, tooDeep, unreadable }
   * The one walker behind recent() and zipPlan(). Dot-files and dot-folders are skipped, symlinks and other non-regular entries are
   * never reported, names are visited in sorted order. Every folder is bound to what was checked:
   *   Linux: the folder is opened (O_DIRECTORY | O_NOFOLLOW), its fstat dev/ino must equal the lstat taken when it was listed (the top: the
   *   lstat of its real path), /proc/self/fd/<fd> must point inside the real root, and it is listed and its children lstat'ed through
   *   /proc/self/fd/<fd>/..., so a folder swapped for a symlink afterwards is never followed. Every fd is closed (try/finally).
   *   Elsewhere: the folder's real path must be inside the real root and its stat dev/ino equal the listed lstat, before and after the listing.
   * A folder failing any check (swapped, vanished, a symlink now, no permission) is never listed: onUnreadable(relPath). So is a child whose
   * lstat fails other than ENOENT. onFile({ abs (logical: top + names), rel (names below the top), name, st, readPath (bound to the open folder) }).
   */
  function walkTree(root, rel, { maxDepth = 64, maxEntries = Infinity, onFile, onDir, onUnreadable } = {}) {
    const out = { truncated: false, tooDeep: false, unreadable: 0 };
    const bad = (r) => { out.unreadable++; if (onUnreadable) onUnreadable(r); };
    const top = resolve(root, rel);
    let realRoot, realTop, topSt;
    try {
      if (!top) throw new Error('outside');
      realRoot = fsImpl.realpathSync(path.resolve(root));
      realTop = fsImpl.realpathSync(top);
      if (!isInside(realTop, realRoot)) throw new Error('outside');
      topSt = fsImpl.lstatSync(realTop);
      if (!topSt.isDirectory()) throw new Error('not a folder');
    } catch { bad(''); return out; }
    const viaProc = process.platform === 'linux' && fsImpl.existsSync('/proc/self/fd');
    const sameId = (a, b) => a.dev === b.dev && a.ino === b.ino;
    const flags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0);
    /** { names, base, close } for a checked folder, or null. */
    const openDir = (p, expect) => {
      if (viaProc) {
        let fd = null;
        try {
          fd = fsImpl.openSync(p, flags);
          const base = `/proc/self/fd/${fd}`;
          if (!sameId(fsImpl.fstatSync(fd), expect)) throw new Error('swapped');
          if (!isInside(fsImpl.readlinkSync(base), realRoot)) throw new Error('outside');
          const names = fsImpl.readdirSync(base);
          return { names, base, close: () => { try { fsImpl.closeSync(fd); } catch { /* already closed */ } } };
        } catch { if (fd != null) { try { fsImpl.closeSync(fd); } catch { /* nothing to close */ } } return null; }
      }
      const check = () => { const real = fsImpl.realpathSync(p); return isInside(real, realRoot) && sameId(fsImpl.statSync(p), expect); };
      try {
        if (!check()) return null;
        const names = fsImpl.readdirSync(p);
        if (!check()) return null;
        return { names, base: p, close: () => {} };
      } catch { return null; }
    };
    let visited = 0;
    const walk = (p, expect, prefix, depth) => {
      const d = openDir(p, expect);
      if (!d) { bad(prefix.replace(/\/$/, '')); return; }
      try {
        const names = d.names.slice().sort();
        for (const n of names) {
          if (out.truncated) return;
          if (n.startsWith('.')) continue;
          if (visited >= maxEntries) { out.truncated = true; return; }
          visited++;
          const child = path.join(d.base, n);
          let s; try { s = fsImpl.lstatSync(child); } catch (e) { if (!e || e.code !== 'ENOENT') bad(`${prefix}${n}`); continue; }
          if (!viaProc && (s.isDirectory() || s.isFile())) {
            // No /proc: bind the child to what was lstat'ed. Its real path must be inside the real root and stat(real) must be the same
            // dev/ino as the lstat; a swap before the lstat lands outside, a swap after the realpath changes what stat(real) sees.
            let ok = false;
            try { const real = fsImpl.realpathSync(child); ok = isInside(real, realRoot) && sameId(fsImpl.statSync(real), s); } catch { ok = false; }
            if (!ok) { bad(`${prefix}${n}`); continue; }
          }
          if (s.isDirectory()) {
            if (depth >= maxDepth) { out.tooDeep = true; continue; }
            if (onDir) onDir({ abs: path.join(top, prefix, n), rel: `${prefix}${n}` });
            walk(child, s, `${prefix}${n}/`, depth + 1);
          } else if (s.isFile() && onFile) onFile({ abs: path.join(top, prefix, n), rel: `${prefix}${n}`, name: n, st: s, readPath: child });
        }
      } finally { d.close(); }
    };
    walk(realTop, topSt, '', 0);
    return out;
  }

  /**
   * recent(root, { limit, isUpload, maxEntries, maxDepth }) -> { truncated, files } the newest regular files under root, newest first.
   * lstat walk: dot-files and dot-folders skipped, symlinks never followed, files the person uploaded left out.
   */
  function recent(root, { limit = 10, isUpload = isUploaded, maxEntries = RECENT_MAX_ENTRIES, maxDepth = RECENT_MAX_DEPTH } = {}) {
    limit = Math.max(1, Math.min(30, Math.floor(Number(limit)) || 10));
    const rootAbs = path.resolve(root), found = [];
    // Unreadable folders are simply skipped (a list, not an archive).
    const { truncated } = walkTree(rootAbs, '', { maxDepth, maxEntries,
      onFile: (f) => { if (!isUpload(f.abs, f.st)) found.push({ abs: f.abs, name: f.name, size: f.st.size, mtimeMs: f.st.mtimeMs }); } });
    found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
    const rows = found.slice(0, limit).map(f => {
      const rel = relOf(rootAbs, f.abs), dir = path.posix.dirname(rel);
      return { name: f.name, path: rel, folder: dir === '.' ? '' : dir, size: f.size, mtime: new Date(f.mtimeMs).toISOString(), kind: kindOf(f.name) };
    });
    return { truncated, files: rows };
  }

  // ── Folder as a .zip ──
  /**
   * zipPlan(root, rel, { maxFiles, maxBytes }) -> { ok:true, name, files:[{abs,name,size}], count, bytes, maxFiles, maxBytes, tooBig, error? }
   *   | { ok:false, code, error }. lstat walk: regular files only; symlinks, dot-files, dot-folders, sockets and devices are left out.
   *   Only the first maxFiles files are kept in the list (the counts are complete), so a huge folder never fills memory.
   */
  function zipPlan(root, rel = '', { maxFiles = 2000, maxBytes = 2048 * 1048576 } = {}) {
    const abs = resolve(root, rel);
    if (!abs) return { ok: false, code: 400, error: 'bad path' };
    let st; try { st = fsImpl.statSync(abs); } catch { return { ok: false, code: 404, error: 'not found' }; }
    if (!st.isDirectory()) return { ok: false, code: 400, error: 'that is a file' };
    const list = []; let count = 0, bytes = 0, incomplete = false, badRel = null;
    const noteBad = (r) => { incomplete = true; if (badRel === null) badRel = r; };
    // Names per parent folder: sanitised parent path -> Map(lowercase segment -> { original, isDir }). Files and folders share one namespace and
    // compare ignoring case (Windows and macOS), so no two entries can land on one name and no file name is also a parent folder.
    const taken = new Map(), dirName = new Map([['', '']]);
    // One key per name as Windows and macOS see it: case-insensitive and Unicode-normalised (macOS treats NFC and NFD spellings as one file).
    const foldKey = (n) => n.normalize('NFC').toLowerCase();
    const nameFor = (parentRel, original, isDir) => {
      const parent = dirName.has(parentRel) ? dirName.get(parentRel) : '';
      let m = taken.get(parent); if (!m) { m = new Map(); taken.set(parent, m); }
      const base = sanitizeSegment(original);
      let stem = base, ext = '';
      if (!isDir) { ext = path.posix.extname(base); stem = base.slice(0, base.length - ext.length); }
      let cand = base;
      for (let i = 2; ; i++) {
        const hit = m.get(foldKey(cand));
        if (!hit || (hit.original === original && hit.isDir === isDir)) break;
        cand = `${stem} (${i})${ext}`;
      }
      m.set(foldKey(cand), { original, isDir });
      return parent ? `${parent}/${cand}` : cand;
    };
    const splitRel = (r) => { const i = r.lastIndexOf('/'); return i < 0 ? ['', r] : [r.slice(0, i), r.slice(i + 1)]; };
    const walked = walkTree(root, rel, { maxDepth: 64, maxEntries: ZIP_WALK_MAX_ENTRIES, onUnreadable: noteBad,
      onDir: (d) => {
        const [parentRel, seg] = splitRel(d.rel);
        const full = nameFor(parentRel, seg, true);
        dirName.set(d.rel, full);
        if (Buffer.byteLength(full) > 65535) noteBad(d.rel);   // never a silent skip
      },
      onFile: (f) => {
        const [parentRel] = splitRel(f.rel);
        const name = nameFor(parentRel, f.name, false);
        if (Buffer.byteLength(name) > 65535) { noteBad(f.rel); return; }
        // A file this process cannot read would leave a hole in the zip: refuse the whole zip (gone since the listing: just skipped).
        try { fsImpl.accessSync(f.readPath, fs.constants.R_OK); } catch (e) { if (!e || e.code !== 'ENOENT') noteBad(f.rel); return; }
        count++; bytes += f.st.size;
        if (list.length < maxFiles) list.push({ abs: f.abs, name, size: f.st.size });
      } });
    const partial = walked.truncated || walked.tooDeep;
    const plan = { ok: true, name: path.resolve(root) === abs ? 'files' : (path.basename(abs) || 'files'), files: list, count, bytes, maxFiles, maxBytes,
      tooBig: count > maxFiles || bytes > maxBytes || partial || incomplete };
    // The route refuses on tooBig, so an incomplete plan sets it too: never a zip with files silently missing.
    if (incomplete) { plan.incomplete = true; plan.error = `Some files in this folder can't be read (for example ${badRel || plan.name}), so it can't be downloaded as one zip.`; }
    // A walk cut short (too many entries, or folders nested too deep) is refused rather than zipped with files silently missing.
    else if (partial) plan.error = 'This folder has too many items or folders nested too deep to download as one zip. Download its folders one at a time.';
    else if (plan.tooBig) plan.error = `This folder is too big to download as one zip: ${count.toLocaleString('en-US')} files and ${fmtBytes(bytes)} (the limit is ${maxFiles.toLocaleString('en-US')} files and ${fmtBytes(maxBytes)}). Download its folders one at a time.`;
    return plan;
  }

  /**
   * streamZip(root, plan, res, { maxBytes }) -> Promise<{ ok, entries } | { ok:false, aborted? }>
   * Writes headers and a zip (data descriptors, UTF-8 names, deflate) as the files are read; nothing is buffered beyond a chunk.
   * Each file is re-checked just before it is read; a client that disconnects stops it at once; more bytes read than maxBytes cut the stream.
   */
  /** True when the open file descriptor fd is inside root (Linux: /proc/self/fd); elsewhere true (the checks before the open stand). */
  function openedInside(root, fd) {
    if (process.platform !== 'linux') return true;
    try {
      const real = fsImpl.readlinkSync(`/proc/self/fd/${fd}`);
      const realRoot = fsImpl.realpathSync(path.resolve(root));
      return real.startsWith(realRoot + path.sep);
    } catch { return false; }
  }

  async function streamZip(root, plan, res, { maxBytes = plan.maxBytes || Infinity } = {}) {
    const { pipeline } = require('stream/promises');
    const { Transform, Writable } = require('stream');
    const zlib = require('zlib');
    const ac = new AbortController();
    let closed = false;
    res.on('error', () => {});
    res.once('close', () => { closed = true; ac.abort(); });
    if (!res.headersSent) {
      res.writeHead(200, { 'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(plan.name || 'files').replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}.zip`,
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    }
    let offset = 0;
    const put = (buf) => new Promise((done) => {
      if (closed || res.destroyed) return done(false);
      offset += buf.length;
      if (res.write(buf)) return done(true);
      const fin = () => { res.off('drain', fin); res.off('close', fin); done(!closed); };
      res.once('drain', fin); res.once('close', fin);
    });
    const entries = []; let total = 0;
    // O_NONBLOCK: a file swapped for a FIFO since the scan must never block the event loop in open().
    const flagsOpen = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
    const GONE = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);   // vanished or swapped since the scan: skipped
    /** The opened file { fd, st } when it is still the regular file inside the root, null when it vanished or was swapped; throws on any other failure. */
    const reopen = (f) => {
      let fd = null;
      try {
        let ls;
        try { ls = fsImpl.lstatSync(f.abs); } catch (e) { if (e && GONE.has(e.code)) return null; throw e; }
        if (!ls.isFile()) return null;
        // Not resolve(): it reads a "\" in a Linux file name as a separator. The real-path checks below cover symlinks; this one the plain path.
        if (!path.resolve(f.abs).startsWith(path.resolve(root) + path.sep)) return null;
        try { fd = fsImpl.openSync(f.abs, flagsOpen); } catch (e) { if (e && GONE.has(e.code)) return null; throw e; }
        const st = fsImpl.fstatSync(fd);
        if (!st.isFile()) { fsImpl.closeSync(fd); fd = null; return null; }
        // Where the file really is, on every platform: the opened file must be the one the real path names, inside the real root.
        let real; try { real = fsImpl.realpathSync(f.abs); } catch (e) { if (e && GONE.has(e.code)) { fsImpl.closeSync(fd); fd = null; return null; } throw e; }
        const realRoot = fsImpl.realpathSync(path.resolve(root)), rs = fsImpl.statSync(real);
        if (!isInside(real, realRoot) || rs.dev !== st.dev || rs.ino !== st.ino) { fsImpl.closeSync(fd); fd = null; return null; }
        // O_NOFOLLOW guards only the last name: on Linux, check where the opened file really is, so a parent folder swapped
        // for a symlink after the check above can never lead outside the root.
        if (!openedInside(root, fd)) { fsImpl.closeSync(fd); fd = null; return null; }
        const ok = { fd, st }; fd = null; return ok;
      } finally { if (fd != null) { try { fsImpl.closeSync(fd); } catch { /* already closed */ } } }
    };
    for (const f of plan.files) {
      if (closed) return { ok: false, aborted: true };
      // Re-check just before reading: still a regular file inside the root (not swapped for a symlink since the pre-scan).
      let opened;
      try { opened = reopen(f); }
      catch (e) {   // EACCES, EIO...: never hand out a complete-looking zip that misses this file
        if (!closed) { try { res.destroy(); } catch {} }
        return { ok: false, aborted: closed, error: e && e.message };
      }
      if (!opened) continue;
      const { fd, st } = opened;
      const nameBuf = Buffer.from(f.name, 'utf8');
      const { time, date } = dosDateTime(st.mtime);
      const level = ZIP_ALREADY_COMPRESSED.has(path.extname(f.name).toLowerCase()) ? 1 : 6;
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0808, 6); lh.writeUInt16LE(8, 8);
      lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt16LE(nameBuf.length, 26);
      const headerOffset = offset;
      if (!(await put(Buffer.concat([lh, nameBuf])))) { try { fsImpl.closeSync(fd); } catch {} return { ok: false, aborted: true }; }
      let crc = 0, usize = 0, csize = 0;
      const counter = new Transform({ transform(chunk, _e, cb) {
        usize += chunk.length; total += chunk.length;
        if (total > maxBytes) return cb(new Error('over the zip size limit'));
        crc = crc32Of(chunk, crc); cb(null, chunk);
      } });
      const sink = new Writable({ write(chunk, _e, cb) { csize += chunk.length; put(chunk).then(ok => cb(ok ? null : new Error('client gone'))); } });
      try {
        await pipeline(fsImpl.createReadStream(null, { fd }), counter, zlib.createDeflateRaw({ level }), sink, { signal: ac.signal });
      } catch (e) {
        if (!closed) { try { res.destroy(); } catch {} }   // a read error or a file that grew past the limit: no complete zip
        return { ok: false, aborted: closed, error: e && e.message };
      }
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc >>> 0, 4); dd.writeUInt32LE(csize, 8); dd.writeUInt32LE(usize, 12);
      if (!(await put(dd))) return { ok: false, aborted: true };
      entries.push({ nameBuf, time, date, crc: crc >>> 0, csize, usize, headerOffset });
    }
    const cdStart = offset; const parts = [];
    for (const e of entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0808, 8); c.writeUInt16LE(8, 10);
      c.writeUInt16LE(e.time, 12); c.writeUInt16LE(e.date, 14); c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.csize, 20); c.writeUInt32LE(e.usize, 24);
      c.writeUInt16LE(e.nameBuf.length, 28); c.writeUInt32LE(e.headerOffset, 42);
      parts.push(c, e.nameBuf);
    }
    const cd = Buffer.concat(parts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(cdStart, 16);
    if (!(await put(Buffer.concat([cd, end])))) return { ok: false, aborted: true };
    res.end();
    return { ok: true, entries: entries.length };
  }

  return { rootFor, rootForAgent, resolveAgent, resolveOwner, resolve, list, stat, uploadTarget, saveStream, remove, mkdir, rename, mimeOf, cleanName, maxUploadBytes,
    resolveAbs, fileInfo, findByName, nameIndex, recent, zipPlan, streamZip, isUploaded, recordUpload };
}

let shared = null;
function getFiles(opts) { if (!shared) shared = createFiles(opts); return shared; }

module.exports = { createFiles, getFiles, mimeOf, cleanName, kindOf, isActiveName, downloadUrl, fmtBytes, zipLimits, sanitizeSegment, crc32Js, ZIP_WALK_MAX_ENTRIES, DEFAULT_MAX_UPLOAD, HUB_HOME };
