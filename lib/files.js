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
const HUB_HOME = path.resolve(HUB_ROOT, '..');

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

function createFiles({ hubHome = HUB_HOME, fsImpl = fs, getUser = () => null, isAdminUser = (u) => !!u && u.role === 'admin', maxUploadBytes = () => DEFAULT_MAX_UPLOAD } = {}) {
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

  return { rootFor, rootForAgent, resolveAgent, resolveOwner, resolve, list, stat, uploadTarget, saveStream, remove, mkdir, rename, mimeOf, cleanName, maxUploadBytes };
}

let shared = null;
function getFiles(opts) { if (!shared) shared = createFiles(opts); return shared; }

module.exports = { createFiles, getFiles, mimeOf, cleanName, DEFAULT_MAX_UPLOAD, HUB_HOME };
