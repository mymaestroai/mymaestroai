'use strict';
// Share links for one file in a Files folder (design: share-links rev 2).
// A link opens ONLY for the person who made it, signed in; this module holds the store, the file check, the
// download header and the two small HTML pages. The routes are in lib/share-links-routes.js.
//
// Store: data/share-links.json (mode 0600, written through a temp file and a rename). The token (32 random bytes,
// base64url, 43 characters) is returned by create() and is never stored or logged: only sha256(token) is kept.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const ID_RE = /^[0-9a-f]{16}$/;
const HARD_MAX_HOURS = 168;
const DEFAULT_HOURS = 24;
const PER_CREATOR = 50;
const PER_HUB = 500;
const HOUR = 3600 * 1000;
const KEEP_ENDED_MS = 24 * HOUR;
const DAY = 24 * HOUR;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** cleanSettings(patch, current) -> { enabled, defaultHours, maxHours }: integers >= 1, maxHours never above 168, defaultHours never above maxHours. */
function cleanSettings(patch, current) {
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const c = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const int = (v, fallback) => { const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v; return Number.isInteger(n) && n >= 1 ? n : fallback; };
  const enabled = p.enabled !== undefined ? p.enabled !== false : c.enabled !== false;
  const maxHours = Math.min(HARD_MAX_HOURS, int(p.maxHours, int(c.maxHours, HARD_MAX_HOURS)));
  const defaultHours = Math.min(maxHours, int(p.defaultHours, int(c.defaultHours, DEFAULT_HOURS)));
  return { enabled, defaultHours, maxHours };
}

function publicOf(r) { const { hash, ...rest } = r; return { ...rest }; }

/**
 * createStore({ file, now, randomBytes, fs, log })
 * Records: { id, hash, creator, ownerId, agent|null, root, rel, name, size, dev, ino, mtimeMs, createdAt, expiresAt, oneTime, downloads, usedAt|null, revokedAt|null }
 * (times are epoch milliseconds). Everything handed out by the store is a copy WITHOUT the hash.
 */
function createStore({ file, now = Date.now, randomBytes = crypto.randomBytes, fsImpl = fs, log = () => {} } = {}) {
  if (!file) throw new Error('share-links store needs a file');
  let records = [];
  let timer = null;

  function load() {
    let text;
    try { text = fsImpl.readFileSync(file, 'utf8'); } catch (e) {
      if (e && e.code !== 'ENOENT') {
        // set aside, so a later save cannot silently overwrite a file that was only unreadable for now
        log(`[share-links] could not read ${path.basename(file)}: ${e.message}; starting empty`);
        try { fsImpl.renameSync(file, `${file}.unreadable-${now()}`); } catch { /* keep going */ }
      }
      records = []; return;
    }
    try {
      const j = JSON.parse(text);
      const list = Array.isArray(j) ? j : (j && Array.isArray(j.links) ? j.links : null);
      if (!list) throw new Error('not a list of links');
      records = list.filter(r => r && typeof r === 'object' && ID_RE.test(String(r.id)) && /^[0-9a-f]{64}$/.test(String(r.hash)));
    } catch (e) {
      log(`[share-links] ${path.basename(file)} is damaged (${e.message}); starting empty`);
      try { fsImpl.renameSync(file, `${file}.damaged-${now()}`); } catch { /* keep going */ }
      records = [];
    }
  }

  function save() {
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fsImpl.writeFileSync(tmp, JSON.stringify({ links: records }), { mode: 0o600 });
      fsImpl.renameSync(tmp, file);
    } catch (e) {
      try { fsImpl.unlinkSync(tmp); } catch { /* none */ }
      log(`[share-links] could not save: ${e.message}`);
      throw e;
    }
  }

  const endedAt = (r) => Math.min(r.expiresAt, r.revokedAt != null ? r.revokedAt : Infinity, r.usedAt != null ? r.usedAt : Infinity);
  const isLive = (r) => r.revokedAt == null && !(r.oneTime && r.usedAt != null) && r.expiresAt > now();

  /** Drop links that ended more than 24 hours ago. Returns how many. */
  function prune() {
    const t = now();
    const keep = records.filter(r => t - endedAt(r) <= KEEP_ENDED_MS);
    const n = records.length - keep.length;
    if (n) { records = keep; try { save(); } catch { /* logged */ } }
    return n;
  }

  /** create({ creator, ownerId, agent, root, rel, name, size, dev, ino, mtimeMs, hours, oneTime, maxHours }) -> { token, record } */
  function create(o = {}) {
    const maxHours = Math.min(HARD_MAX_HOURS, Number.isInteger(o.maxHours) && o.maxHours >= 1 ? o.maxHours : HARD_MAX_HOURS);
    const hours = o.hours;
    if (!Number.isInteger(hours) || hours < 1 || hours > maxHours) { const e = new Error(`hours must be a whole number from 1 to ${maxHours}`); e.code = 'EBADARG'; throw e; }
    for (const k of ['creator', 'root', 'rel', 'name']) if (typeof o[k] !== 'string' || !o[k]) { const e = new Error(`${k} required`); e.code = 'EBADARG'; throw e; }
    const live = records.filter(isLive);
    if (live.length >= PER_HUB || live.filter(r => r.creator === o.creator).length >= PER_CREATOR) {
      const e = new Error('too many live share links'); e.code = 'ELIMIT'; throw e;
    }
    const token = randomBytes(32).toString('base64url');
    let id; do { id = randomBytes(8).toString('hex'); } while (records.some(r => r.id === id));
    const t = now();
    const record = {
      id, hash: sha256(token), creator: o.creator, ownerId: o.ownerId == null ? null : String(o.ownerId), agent: o.agent || null,
      root: o.root, rel: o.rel, name: o.name, size: o.size, dev: o.dev, ino: o.ino, mtimeMs: o.mtimeMs,
      createdAt: t, expiresAt: t + hours * HOUR, oneTime: !!o.oneTime, downloads: 0, usedAt: null, revokedAt: null,
    };
    records.push(record);
    try { save(); } catch (e) { records.pop(); throw e; }
    return { token, record: publicOf(record) };
  }

  /** findLive(token) -> the record (no hash) or null: unknown, expired, revoked and used-up all look the same. */
  function findLive(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const h = sha256(token);
    const r = records.find(x => x.hash === h);
    return r && isLive(r) ? publicOf(r) : null;
  }

  /** markDownload(id) -> true when this download may go ahead. A one-time link is used up here, before any byte is sent. */
  function markDownload(id) {
    const r = records.find(x => x.id === id);
    if (!r || !isLive(r)) return false;
    const before = { downloads: r.downloads, usedAt: r.usedAt };
    r.downloads += 1;
    if (r.oneTime) r.usedAt = now();   // the stored flag decides; a caller's { oneTime } can never make a normal link one-time or the reverse
    // If the save fails the use could be forgotten after a restart: undo it and refuse this download.
    try { save(); } catch { r.downloads = before.downloads; r.usedAt = before.usedAt; return false; }
    return true;
  }

  /** revoke(id) -> true if a live link was revoked and saved; false when none was live or the save failed (nothing changed). */
  function revoke(id) {
    const r = records.find(x => x.id === id);
    if (!r || !isLive(r)) return false;
    r.revokedAt = now();
    try { save(); } catch { r.revokedAt = null; return false; }
    return true;
  }

  const list = () => records.map(publicOf);
  const liveList = () => records.filter(isLive).map(publicOf);
  const get = (id) => { const r = records.find(x => x.id === id); return r ? publicOf(r) : null; };

  /** A daily prune that never keeps the process alive. */
  function startPruneTimer(setIntervalImpl = setInterval) {
    if (timer) return timer;
    timer = setIntervalImpl(() => { try { prune(); } catch (e) { log(`[share-links] prune failed: ${e.message}`); } }, DAY);
    if (timer && timer.unref) timer.unref();
    return timer;
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  load();
  prune();
  return { create, findLive, markDownload, revoke, list, liveList, get, prune, startPruneTimer, stop, isLive };
}

/**
 * openChecked(record) -> { fd, st } | null. Opens the file without following a final symlink, looks at the SAME descriptor
 * (a regular file with the dev, inode, size and modification time recorded at creation) and requires the real path to be
 * inside the real root. Anything else closes the descriptor and answers null.
 */
function openChecked(record, fsImpl = fs) {
  if (!record || typeof record.root !== 'string' || typeof record.rel !== 'string') return null;
  const file = path.resolve(record.root, record.rel);
  const c = fsImpl.constants;
  let fd = null;
  try {
    // O_NONBLOCK: opening a FIFO swapped in for the file must not hang the hub; the isFile check then refuses it.
    fd = fsImpl.openSync(file, c.O_RDONLY | c.O_NOFOLLOW | (c.O_NONBLOCK || 0));
    const st = fsImpl.fstatSync(fd);
    if (!st.isFile() || st.dev !== record.dev || st.ino !== record.ino || st.size !== record.size || st.mtimeMs !== record.mtimeMs) throw new Error('changed');
    const realFile = fsImpl.realpathSync(file);
    const realRoot = fsImpl.realpathSync(record.root);
    const rel = path.relative(realRoot, realFile);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('outside');
    return { fd, st };
  } catch {
    if (fd !== null) { try { fsImpl.closeSync(fd); } catch { /* closed */ } }
    return null;
  }
}

/** Content-Disposition for a download: an ASCII fallback with no quote, backslash, semicolon, CR or LF, and the real name percent-encoded. */
function contentDisposition(name) {
  const raw = String(name || '');
  let ascii = raw.replace(/["\\;\r\n]/g, '').replace(/[^\x20-\x7e]/g, '_').trim();
  if (!ascii) ascii = 'download';
  const star = encodeURIComponent(raw).replace(/['()*!]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function humanSize(n) {
  const b = Number(n) || 0;
  if (b < 1000) return `${b} bytes`;
  if (b < 1e6) return `${(b / 1e3).toFixed(1)} KB`;
  if (b < 1e9) return `${(b / 1e6).toFixed(1)} MB`;
  return `${(b / 1e9).toFixed(2)} GB`;
}

const PAGE_STYLE = 'body{font-family:system-ui,sans-serif;background:#f4f4f6;color:#1c1c20;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}'
  + 'main{background:#fff;border-radius:12px;padding:28px 32px;max-width:420px;width:calc(100% - 48px);box-shadow:0 2px 12px rgba(0,0,0,.12)}'
  + 'h1{font-size:18px;margin:0 0 12px;word-break:break-all}p{margin:6px 0;color:#555;font-size:14px}'
  + 'button{margin-top:18px;width:100%;padding:12px;font-size:16px;border:0;border-radius:8px;background:#2f6fed;color:#fff;cursor:pointer}';

function shell(title, inner) {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="same-origin"><title>${esc(title)}</title><style>${PAGE_STYLE}</style></head><body><main>${inner}</main></body></html>\n`;
}

/** renderPage({ name, size, expiresAt, oneTime, timeZone }) -> the link page. expiresAt: epoch ms or an ISO string; timeZone: the person's own (IANA), UTC when absent or unknown. */
function renderPage({ name, size, expiresAt, oneTime, timeZone } = {}) {
  const d = new Date(expiresAt);
  const iso = Number.isNaN(d.getTime()) ? '' : d.toISOString();
  let shown = iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : '';
  if (iso && typeof timeZone === 'string' && timeZone) {
    // explicit fields: dateStyle/timeStyle cannot be combined with timeZoneName
    try { shown = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d); } catch { /* unknown zone: UTC */ }
  }
  return shell('Download', `<h1>${esc(name)}</h1><p>${esc(humanSize(size))}</p>`
    + `<p>Link expires <time datetime="${esc(iso)}">${esc(shown)}</time></p>`
    + (oneTime ? '<p>One download</p>' : '')
    + '<form method="post"><button type="submit">Download</button></form>');
}

function renderGone() { return shell('Link', '<h1>This link no longer works.</h1>'); }

/** A small sliding-window counter. hit(key, { limit, windowMs }) -> true while the key has made at most `limit` hits in the window. */
function createLimiter({ now = Date.now } = {}) {
  const hits = new Map();
  const blocks = new Map();
  function sweep(t) {
    for (const [k, v] of hits) if (!v.length || t - v[v.length - 1] > v.windowMs) hits.delete(k);
    for (const [k, until] of blocks) if (until <= t) blocks.delete(k);
  }
  function hit(key, { limit, windowMs }) {
    const t = now();
    if (hits.size > 5000) sweep(t);
    const arr = hits.get(key) || [];
    arr.windowMs = windowMs;
    while (arr.length && t - arr[0] >= windowMs) arr.shift();
    arr.push(t);
    hits.set(key, arr);
    return arr.length <= limit;
  }
  function block(key, ms) { blocks.set(key, now() + ms); }
  function isBlocked(key) { const u = blocks.get(key); if (u === undefined) return false; if (u <= now()) { blocks.delete(key); return false; } return true; }
  return { hit, block, isBlocked };
}

module.exports = { createStore, cleanSettings, openChecked, contentDisposition, renderPage, renderGone, createLimiter, humanSize, sha256, TOKEN_RE, ID_RE, HARD_MAX_HOURS, DEFAULT_HOURS, PER_CREATOR, PER_HUB };
