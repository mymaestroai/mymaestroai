'use strict';
// HTTP side of share links (design: share-links rev 2); the store and the pages are in lib/share-links.js.
//   POST /api/share-links              { owner? | agent?, path, hours, oneTime }  -> { id, path: '/s/<token>', expiresAt, oneTime, name, size }
//   GET  /api/share-links              -> { links, settings }
//   POST /api/share-links/<id>/revoke  -> { ok: true }
//   GET  /s/<token>                    the link page (the creator, signed in, only)
//   POST /s/<token>                    the download
// Creating, listing and revoking are for a person on a full browser session only (no API token, no service call, no legacy
// sign-in, no session still owing its two-factor code). Opening a link is for its creator only, with the creator's read
// access to the folder checked again on every request. Every refusal of a /s/ request is the same 404 page.

const fs = require('fs');
const path = require('path');
const SL = require('./share-links');

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'Cache-Control': 'no-store',
  // same-origin, not no-referrer: the Download button is a form POST (a navigation), and under no-referrer the browser sends
  // "Origin: null", which the hub's origin guard refuses. same-origin still sends nothing to any other site.
  'Referrer-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
};
const HOURS_CHOICES = [1, 24, 168];
const MAX_BODY = 16 * 1024;

function readJson(req) {
  return new Promise((resolve) => {
    const finish = (text) => { try { const j = JSON.parse(text || '{}'); resolve(j && typeof j === 'object' && !Array.isArray(j) ? j : null); } catch { resolve(null); } };
    if (req._bodyText !== undefined) return finish(req._bodyText);
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { resolve(null); try { req.destroy(); } catch { /* gone */ } } else chunks.push(c); });
    req.on('end', () => { const t = Buffer.concat(chunks).toString(); req._bodyText = t; finish(t); });
    req.on('error', () => resolve(null));
  });
}

function createShareLinkRoutes({ store, getFiles, getAgents, access, hubAuth, settings = () => ({}), push = null, log = () => {}, now = Date.now, limiter = null, fsImpl = fs, openChecked = SL.openChecked, readBody = readJson }) {
  const lim = limiter || SL.createLimiter({ now });
  const cfg = () => SL.cleanSettings(settings());
  const socketAddr = (req) => (req.socket && req.socket.remoteAddress) || '-';
  const iso = (ms) => new Date(ms).toISOString();

  function json(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
    return true;
  }
  function pageOut(res, code, html) {
    res.writeHead(code, PAGE_HEADERS);
    res.end(html);
    return true;
  }
  const gone = (res, code = 404) => pageOut(res, code, SL.renderGone());

  /** The person on a full browser session, or null. */
  function sessionUser(req) {
    return req.hubIdentKind === 'user' && !req.hubPendingTotp && !req.hubToken && !req.hubService && req.hubUser ? req.hubUser : null;
  }

  /**
   * The folder a person reads through the Files routes: for an agent's folder (allowed agent, same member-owned rule as
   * /api/files), else the owner's folder. -> { ownerId, agent, root } | null
   */
  async function resolveFolder(user, { agent, owner }) {
    const files = getFiles();
    if (agent) {
      const agents = await getAgents();
      const rec = agents.find(a => a.name === String(agent));
      if (!rec) return null;
      if (!access.isAdmin(user) && !access.canAccessAgent(user, rec.name, { agents })) return null;
      const memberOwned = !!(rec.owner && !hubAuth.listUsers().some(u => u.id === String(rec.owner) && u.role === 'admin'));
      return files.resolveAgent(user, rec, { memberOwned }) || null;
    }
    return files.resolveOwner(user, owner) || null;
  }

  // ── create ──
  async function create(req, res) {
    const user = sessionUser(req);
    if (!user) return json(res, 403, { error: 'Share links can only be made from a signed-in browser.' });
    const conf = cfg();
    if (!conf.enabled) return json(res, 403, { error: 'Share links are switched off.' });
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: 'invalid JSON' });
    const rel = typeof body.path === 'string' ? body.path : '';
    if (!rel.replace(/[\\/]/g, '')) return json(res, 400, { error: 'path required' });
    const hours = body.hours === undefined ? conf.defaultHours : body.hours;
    if (!Number.isInteger(hours) || hours < 1 || hours > conf.maxHours) return json(res, 400, { error: `hours must be a whole number from 1 to ${conf.maxHours}` });
    const oneTime = body.oneTime === true;

    const agentName = typeof body.agent === 'string' && body.agent ? body.agent : null;
    if (agentName) {
      const agents = await getAgents();
      if (!agents.some(a => a.name === agentName)) return json(res, 404, { error: 'no such agent' });
    }
    const own = await resolveFolder(user, { agent: agentName, owner: typeof body.owner === 'string' ? body.owner : undefined });
    if (!own) return json(res, 403, { error: agentName ? 'no_access_to_agent' : 'no such owner' });

    const files = getFiles();
    const s = files.stat(own.root, rel);
    if (!s.ok) return json(res, s.code || 400, { error: s.error });
    if (s.isDir) return json(res, 400, { error: 'A folder cannot be shared. Choose a file.' });
    const root = path.resolve(own.root);
    const relClean = path.relative(root, s.abs).split(path.sep).join('/');
    const name = path.basename(s.abs);
    if (!relClean || relClean.split('/').some(seg => seg.startsWith('.'))) return json(res, 400, { error: 'Hidden files cannot be shared.' });
    let ls;
    try { ls = fsImpl.lstatSync(s.abs); } catch { return json(res, 404, { error: 'not found' }); }
    if (ls.isSymbolicLink() || !ls.isFile()) return json(res, 400, { error: 'Only a regular file can be shared.' });

    if (!lim.hit(`create:${user.id}`, { limit: 30, windowMs: 3600 * 1000 })) return json(res, 429, { error: 'Too many share links created. Try again later.' });
    let made;
    try {
      made = store.create({ creator: user.id, ownerId: own.ownerId, agent: own.agent || null, root, rel: relClean, name, size: ls.size, dev: ls.dev, ino: ls.ino, mtimeMs: ls.mtimeMs, hours, oneTime, maxHours: conf.maxHours });
    } catch (e) {
      if (e && e.code === 'ELIMIT') return json(res, 429, { error: 'Too many live share links. Revoke some first.' });
      if (e && e.code === 'EBADARG') return json(res, 400, { error: e.message });
      log(`[share-links] create failed: ${e && e.message}`);
      return json(res, 500, { error: 'could not create the link' });
    }
    const { token, record } = made;
    try { hubAuth.audit(user.id, 'share.create', `link ${record.id} folder ${own.agent || own.ownerId} file ${name} hours ${hours} oneTime ${oneTime}`, socketAddr(req)); } catch { /* audit is best effort */ }
    notifyCreated(user, own, name, hours);
    return json(res, 200, { id: record.id, path: `/s/${token}`, expiresAt: iso(record.expiresAt), oneTime: record.oneTime, name, size: record.size });
  }

  function notifyCreated(user, own, name, hours) {
    try {
      const ids = new Set(hubAuth.listUsers().filter(u => u.role === 'admin' && !u.disabled).map(u => String(u.id)));
      const owner = own.ownerId && own.ownerId !== 'mine' ? hubAuth.getUser(String(own.ownerId)) : null;
      if (owner && owner.role !== 'admin' && !owner.disabled && owner.id !== user.id) ids.add(String(owner.id));
      const p = push && (typeof push === 'function' ? push() : push);
      if (!p || !ids.size) return;
      const r = p.notifyUsers({ title: 'Share link created', body: `${user.name || user.login || 'Someone'} created a share link for ${name}, valid for ${hours} hours.`, url: '/', tag: 'share-link-created' }, [...ids], { kind: 'security' });
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (e) { log(`[share-links] notice failed: ${e && e.message}`); }
  }

  // ── list / revoke ──
  function list(req, res) {
    const user = sessionUser(req);
    if (!user) return json(res, 403, { error: 'Share links can only be made from a signed-in browser.' });
    const admin = access.isAdmin(user);
    const conf = cfg();
    const links = store.liveList().filter(r => admin || r.creator === user.id).map(r => {
      const c = hubAuth.getUser(r.creator);
      return { id: r.id, name: r.name, size: r.size, createdAt: iso(r.createdAt), expiresAt: iso(r.expiresAt), oneTime: r.oneTime, downloads: r.downloads,
        creator: { id: r.creator, name: c ? (c.name || c.login || r.creator) : r.creator }, mine: r.creator === user.id };
    }).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return json(res, 200, { links, settings: { ...conf, choices: HOURS_CHOICES.filter(h => h <= conf.maxHours) } });
  }

  function revoke(req, res, id) {
    const user = sessionUser(req);
    if (!user) return json(res, 403, { error: 'Share links can only be made from a signed-in browser.' });
    const rec = store.liveList().find(r => r.id === id);
    if (!rec || (rec.creator !== user.id && !access.isAdmin(user))) return json(res, 404, { error: 'not found' });
    store.revoke(id);
    try { hubAuth.audit(user.id, 'share.revoke', `link ${id} creator ${rec.creator}`, socketAddr(req)); } catch { /* best effort */ }
    return json(res, 200, { ok: true });
  }

  // ── the link itself ──
  async function open(req, res, token) {
    const user = sessionUser(req);
    if (!user) return gone(res);
    const ip = socketAddr(req);
    const key = `${user.id}|${ip}`;
    if (lim.isBlocked(`bad:${key}`)) return gone(res);
    if (!lim.hit(`req:${key}`, { limit: 30, windowMs: 60 * 1000 })) { res.setHeader && res.setHeader('Retry-After', '60'); return gone(res, 429); }
    // 20 unknown or dead tokens in 10 minutes block this person for 10 minutes (the 20th hit is the one over a limit of 19).
    const bad = () => {
      if (!lim.hit(`badcount:${key}`, { limit: 19, windowMs: 10 * 60 * 1000 })) {
        lim.block(`bad:${key}`, 10 * 60 * 1000);
        try { hubAuth.audit(user.id, 'share.refused', 'too many links that do not work; blocked for 10 minutes', ip); } catch { /* best effort */ }
      }
      return gone(res);
    };

    const rec = store.findLive(token);
    if (!rec) return bad();
    if (rec.creator !== user.id) return bad();
    const creator = hubAuth.getUser(rec.creator);
    if (!creator || creator.disabled) return gone(res);
    if (!cfg().enabled) return gone(res);
    let own = null;
    try { own = await resolveFolder(creator, { agent: rec.agent, owner: rec.ownerId }); } catch { own = null; }
    if (!own || path.resolve(own.root) !== rec.root) return gone(res);
    const opened = openChecked(rec);
    if (!opened) return gone(res);

    if (req.method !== 'POST') {
      try { fsImpl.closeSync(opened.fd); } catch { /* closed */ }
      return pageOut(res, 200, SL.renderPage({ name: rec.name, size: rec.size, expiresAt: rec.expiresAt, oneTime: rec.oneTime, timeZone: creator.timeZone || null }));
    }
    // Used up BEFORE the first byte: two parallel downloads of a one-time link cannot both pass.
    if (!store.markDownload(rec.id)) { try { fsImpl.closeSync(opened.fd); } catch { /* closed */ } return gone(res); }
    try { hubAuth.audit(user.id, 'share.download', `link ${rec.id}`, ip); } catch { /* best effort */ }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream', 'Content-Length': opened.st.size, 'Content-Disposition': SL.contentDisposition(rec.name),
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
    });
    if (opened.st.size === 0) { try { fsImpl.closeSync(opened.fd); } catch { /* closed */ } res.end(); return true; }
    const stream = fsImpl.createReadStream(null, { fd: opened.fd, start: 0, end: opened.st.size - 1, autoClose: true });
    stream.on('error', () => { try { res.destroy(); } catch { /* gone */ } });
    res.on('close', () => { try { stream.destroy(); } catch { /* gone */ } });
    stream.pipe(res);
    return true;
  }

  /** handle(req, res, pathname) -> Promise<boolean>: true when this module answered. Wrong-length tokens and other /s/ paths are not ours. */
  async function handle(req, res, pathname) {
    const p = String(pathname || '');
    const method = String(req.method || 'GET').toUpperCase();
    if (p === '/api/share-links') {
      if (method === 'POST') return create(req, res);
      if (method === 'GET') return list(req, res);
      return json(res, 405, { error: 'method_not_allowed' });
    }
    let m = p.match(/^\/api\/share-links\/([0-9a-f]{16})\/revoke$/);
    if (m) return method === 'POST' ? revoke(req, res, m[1]) : json(res, 405, { error: 'method_not_allowed' });
    m = p.match(/^\/s\/([A-Za-z0-9_-]{43})$/);
    if (m) {
      if (method !== 'GET' && method !== 'POST') return gone(res, 405);
      return open(req, res, m[1]);
    }
    return false;
  }

  return { handle };
}

module.exports = { createShareLinkRoutes, PAGE_HEADERS };
