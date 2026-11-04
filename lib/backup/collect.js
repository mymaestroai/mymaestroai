'use strict';
/**
 * backup/collect.js — what goes into a backup, copied into a snapshot folder first, so the archive is made from files
 * that no longer change.
 *
 * Archive layout (the same on every computer; a restore maps it onto the new install):
 *   data/…         the hub's records (accounts, settings, agents' list, chats, memory, schedules, connections, wallet)
 *   workspaces/…   every agent's folder
 *   env/.env       the install's .env
 *   home/<folder>  the hub's home folders: share, users, medical, legal (next to the install or inside it)
 *   external/…     the AI sign-ins (Linux Claude, Codex) and each agent's current Claude/Codex conversation
 *
 * The hub's own records are copied in one synchronous pass: JSON files and conversation logs read whole, SQLite
 * databases serialized from a read-only connection. Node runs one piece of JavaScript at a time, so nothing in the hub
 * writes to them meanwhile. Everything else (agents' folders, files, sign-ins) is copied afterwards; each file's size
 * and change time are compared before and after its copy, and a file that changed is copied again, up to three times.
 * Files that never held still are listed (the backup then says it was taken while things were changing).
 *
 *   sources(env)                        the roots to copy
 *   snapshot(env, snapDir, opts)        → { entries, linksOutside, unsettled, bytes, files }
 * env: { root, hubHome, home, platform }
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { FOLDERS } = require('../hub-home');

const DATA_LEAVE_OUT = [
  /^\.backup-paused\.json$/,   // agents' boxes a backup paused (this computer only)
  /^local-models\/(llama\.cpp|bin|models)(\/|$)/, /^local-models\/[^/]+\.(log|pid)$/,
  /-(wal|shm|journal)$/, /\.sock$/,
  /^setup-token$/, /^hardware-state\.json$/, /^model-sizes\.json$/,   // a new computer makes its own
  /^backups\.json$/, /^backup-schedule\.json$/, /^recovery-mode\.json$/,   // about this computer's backups and restores
  /^jobs\/[^/]+\/out\.log$/,                                            // background jobs' output logs
];
const ANY_LEAVE_OUT = [/(^|\/)\._[^/]*$/, /(^|\/)\.DS_Store$/, /(^|\/)\.restore(-new|-aside|-staging)?(\/|$)/, /(^|\/)\.snapshot-[^/]*(\/|$)/];
const DATA_ASYNC = /^uploads(\/|$)/;   // bulky and append-only: copied in the second pass
const SQLITE = Buffer.from('SQLite format 3\0');
const encodeClaudeProject = (dir) => dir.replace(/[^a-zA-Z0-9]/g, '-');

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function claudeDir(home) { return process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'); }

function sources({ root, hubHome, home, platform }) {
  const out = [
    { arch: 'data', abs: path.join(root, 'data'), leaveOut: DATA_LEAVE_OUT, hub: true },
    { arch: 'workspaces', abs: path.join(root, 'workspaces') },
    { arch: 'env/.env', abs: path.join(root, '.env'), file: true },
  ];
  for (const f of FOLDERS) out.push({ arch: `home/${f}`, abs: path.join(hubHome, f) });
  const cdir = claudeDir(home);
  if (platform !== 'darwin') out.push({ arch: 'external/claude/.credentials.json', abs: path.join(cdir, '.credentials.json'), file: true, secret: true });
  const sessions = readJson(path.join(root, 'data', 'agent-sessions.json')) || {};
  const proj = path.join(cdir, 'projects', encodeClaudeProject(root));
  for (const v of Object.values(sessions)) {
    const sid = v && v.sessionId;
    if (typeof sid === 'string' && /^[0-9a-f-]{36}$/.test(sid)) out.push({ arch: `external/claude/projects/${sid}.jsonl`, abs: path.join(proj, `${sid}.jsonl`), file: true });
  }
  const codex = path.join(home, '.codex');
  out.push({ arch: 'external/codex/auth.json', abs: path.join(codex, 'auth.json'), file: true, secret: true });
  out.push({ arch: 'external/codex/config.toml', abs: path.join(codex, 'config.toml'), file: true });
  const threads = new Set(Object.values(readJson(path.join(root, 'data', 'codex-sessions.json')) || {}).map(v => v && v.threadId).filter(t => typeof t === 'string' && /^[0-9a-f-]{36}$/.test(t)));
  if (threads.size) for (const f of findCodexRollouts(path.join(codex, 'sessions'), threads)) out.push({ arch: `external/codex/sessions/${path.relative(path.join(codex, 'sessions'), f).split(path.sep).join('/')}`, abs: f, file: true });
  return out;
}
function findCodexRollouts(dir, threads) {
  const found = [];
  const walk = (d, depth) => {
    let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile()) { const m = /-([0-9a-f-]{36})\.jsonl$/.exec(e.name); if (m && threads.has(m[1])) found.push(p); }
    }
  };
  walk(dir, 0);
  return found;
}

function leftOut(src, rel) {
  const arch = rel ? `${src.arch}/${rel}` : src.arch;
  if (ANY_LEAVE_OUT.some(re => re.test(arch))) return true;
  return !!(rel && src.leaveOut && src.leaveOut.some(re => re.test(rel)));
}
function isSqlite(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); const b = Buffer.alloc(16); return fs.readSync(fd, b, 0, 16, 0) === 16 && b.equals(SQLITE); }
  catch { return false; } finally { if (fd != null) fs.closeSync(fd); }
}
function serializeDb(file) {
  const Database = require('better-sqlite3');
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { return db.serialize(); } finally { db.close(); }
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function snapshot(env, snapDir, { retries = 3, onFile, _afterCopy, procOk = process.platform === 'linux' } = {}) {
  const roots = sources(env);
  const entries = [], linksOutside = [], unsettled = [], skipped = [];   // skipped: { path, why }, named in the manifest
  let bytes = 0;
  fs.mkdirSync(snapDir, { recursive: true, mode: 0o700 });
  const dest = (arch) => path.join(snapDir, ...arch.split('/'));
  const dirRoots = roots.filter(r => !r.file);
  // An absolute path inside one of the copied folders, as an archive path.
  const toArch = (abs) => {
    let best = null;
    for (const r of dirRoots) if (abs === r.abs || abs.startsWith(r.abs + path.sep)) if (!best || r.abs.length > best.abs.length) best = r;
    return best ? (abs === best.abs ? best.arch : `${best.arch}/${path.relative(best.abs, abs).split(path.sep).join('/')}`) : null;
  };
  const addDir = (arch, st) => { fs.mkdirSync(dest(arch), { recursive: true, mode: 0o700 }); entries.push({ path: arch, type: 'dir', mode: st.mode & 0o777, mtime: st.mtimeMs }); };
  const addLink = (arch, abs) => {
    const target = fs.readlinkSync(abs);
    const real = path.resolve(path.dirname(abs), target);
    const archTarget = toArch(real);
    if (archTarget && !leftOutPath(archTarget)) entries.push({ path: arch, type: 'link', target: archTarget, linkname: path.posix.relative(path.posix.dirname(arch), archTarget) || '.' });
    else linksOutside.push({ path: arch, target });
  };
  const leftOutPath = (archPath) => {
    for (const r of roots) if (archPath === r.arch || archPath.startsWith(r.arch + '/')) return leftOut(r, archPath === r.arch ? '' : archPath.slice(r.arch.length + 1));
    return true;
  };
  const record = (arch, buf, st) => {
    fs.mkdirSync(path.dirname(dest(arch)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(dest(arch), buf, { mode: 0o600 });
    entries.push({ path: arch, type: 'file', size: buf.length, sha256: sha(buf), mode: st.mode & 0o777, mtime: st.mtimeMs });
    bytes += buf.length;
    if (onFile) onFile(arch);
  };

  // Pass 1, synchronous: the hub's own records. Nothing else in this process runs until it returns.
  const later = [];
  for (const src of roots.filter(r => r.hub)) {
    const walk = (abs, rel) => {
      let st; try { st = fs.lstatSync(abs); } catch { return; }
      if (leftOut(src, rel)) return;
      const arch = rel ? `${src.arch}/${rel}` : src.arch;
      if (st.isSymbolicLink()) return addLink(arch, abs);
      if (st.isDirectory()) { addDir(arch, st); for (const n of fs.readdirSync(abs).sort()) walk(path.join(abs, n), rel ? `${rel}/${n}` : n); return; }
      if (!st.isFile()) return;
      if (rel && DATA_ASYNC.test(rel)) { later.push({ src, abs, arch }); return; }
      record(arch, isSqlite(abs) ? serializeDb(abs) : readSettled(abs, arch), st);
    };
    walk(src.abs, '');
  }

  // A JSON record read while the hub may be writing it (a backup from the terminal): read again until it parses.
  function readSettled(abs, arch) {
    let buf = fs.readFileSync(abs);
    if (!/\.json$/.test(abs)) return buf;
    for (let i = 0; i < 5; i++) {
      try { JSON.parse(buf.toString('utf8')); return buf; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); buf = fs.readFileSync(abs); }
    }
    unsettled.push(arch);
    return buf;
  }
  // Pass 2: everything else, each file checked for changes while it was copied. Folders agents can write (workspaces,
  // shared folders) could swap a file or folder for a link to anything on this computer between our look and our read:
  // a file is opened without following a link, must be the same file we looked at, and must really be inside its root.
  const realRoot = new Map();
  const insideRoot = async (src, p) => {
    if (src.file) return true;   // a sign-in file the hub names itself
    if (!realRoot.has(src.abs)) realRoot.set(src.abs, await fsp.realpath(src.abs).catch(() => null));
    const r = realRoot.get(src.abs);
    return !!r && (p === r || p.startsWith(r + path.sep));
  };
  async function copyFile(abs, arch, src = {}) {
    if (src.hub && isSqlite(abs)) { const st = fs.statSync(abs); record(arch, serializeDb(abs), st); return; }   // the hub's own databases only
    for (let attempt = 0; ; attempt++) {
      let before;
      try { before = await fsp.lstat(abs); } catch (e) { if (e.code === 'ENOENT') { skipped.push({ path: arch, why: 'removed while the backup ran' }); return; } throw e; }
      if (!before.isFile()) { if (!before.isSymbolicLink() && !before.isDirectory()) skipped.push({ path: arch, why: 'not a plain file any more' }); return; }
      if (!(await insideRoot(src, await fsp.realpath(abs).catch(() => '')))) { skipped.push({ path: arch, why: 'leads outside its folder' }); return; }
      let fh;
      try { fh = await fsp.open(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0)); }
      catch (e) { skipped.push({ path: arch, why: e.code === 'ENOENT' ? 'removed while the backup ran' : 'could not be read' }); return; }
      const out = dest(arch);
      const h = crypto.createHash('sha256');
      let size = 0;
      try {
        const st = await fh.stat();
        if (!st.isFile() || st.ino !== before.ino || st.dev !== before.dev) {   // replaced while we looked (an ordinary save does that): look again
          if (attempt < retries) continue;
          skipped.push({ path: arch, why: 'kept changing' }); return;
        }
        // where /proc works, the opened file must really be inside its root; elsewhere the boxed agents are held still instead (create.js)
        if (procOk && !src.file) { const via = await fsp.realpath(`/proc/self/fd/${fh.fd}`).catch(() => ''); if (!(await insideRoot(src, via))) { skipped.push({ path: arch, why: 'leads outside its folder' }); return; } }
        await fsp.mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
        await new Promise((resolve, reject) => {
          const r = fh.createReadStream({ start: 0, autoClose: false }), w = fs.createWriteStream(out, { mode: 0o600 });
          r.on('data', (c) => { h.update(c); size += c.length; });
          r.on('error', reject); w.on('error', reject); w.on('finish', resolve);
          r.pipe(w);
        });
      } finally { await fh.close().catch(() => {}); }
      if (_afterCopy) await _afterCopy(arch, abs);   // tests: a file that changes while it is copied
      const after = await fsp.lstat(abs);
      const settled = after.size === before.size && after.mtimeMs === before.mtimeMs && after.size === size;
      if (settled || attempt >= retries) {
        if (!settled) unsettled.push(arch);
        entries.push({ path: arch, type: 'file', size, sha256: h.digest('hex'), mode: after.mode & 0o777, mtime: after.mtimeMs });
        bytes += size;
        if (onFile) onFile(arch);
        return;
      }
    }
  }
  for (const { src, abs, arch } of later) await copyFile(abs, arch, src);
  for (const src of roots.filter(r => !r.hub)) {
    const walk = async (abs, rel) => {
      let st; try { st = await fsp.lstat(abs); } catch { return; }
      if (leftOut(src, rel)) return;
      const arch = rel ? `${src.arch}/${rel}` : src.arch;
      if (st.isSymbolicLink()) { if (src.file) { try { st = await fsp.stat(abs); } catch { return; } if (st.isFile()) await copyFile(fs.realpathSync(abs), arch, src); return; } return addLink(arch, abs); }
      if (st.isDirectory() && !src.file) {
        // the folder must still be the folder we looked at (not swapped for a link) before and after listing it
        const real = await fsp.realpath(abs).catch(() => '');
        if (!(await insideRoot(src, real))) return;
        const names = (await fsp.readdir(abs)).sort();
        if ((await fsp.realpath(abs).catch(() => '')) !== real) return;
        addDir(arch, st);
        for (const n of names) await walk(path.join(abs, n), rel ? `${rel}/${n}` : n);
        return;
      }
      if (st.isFile()) await copyFile(abs, arch, src);
    };
    await walk(src.abs, '');
  }
  // Parent folders the archive needs (external/…, env/) without entries of their own
  const have = new Set(entries.filter(e => e.type === 'dir').map(e => e.path));
  for (const e of entries.slice()) {
    const parts = e.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (!have.has(d)) { have.add(d); entries.push({ path: d, type: 'dir', mode: 0o700, mtime: 0 }); }
    }
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, linksOutside, unsettled, skipped, bytes, files: entries.filter(e => e.type === 'file').length };
}

module.exports = { sources, snapshot, encodeClaudeProject, claudeDir, DATA_LEAVE_OUT };
