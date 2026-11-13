'use strict';
// lib/faces/routes.js: the /api/faces/* HTTP surface for character packs.
//   GET|HEAD /api/faces                        -> { packs: [{ id, name, background, hasReactions }] }
//   GET|HEAD /api/faces/<id>/manifest.json     the pack's manifest
//   GET|HEAD /api/faces/<id>/<web|tracks|beak>/<file>   exactly the files the pack's manifest names
// Any signed-in user (members too). server.js classifies these as session routes (lib/access); the handler
// checks the signed-in user again so it is safe even if the gate is skipped. Only files in the pack's own
// allowlist (keyed by exact relative path) are ever opened; nothing is built from the request path. Before ANY
// answer about a file (304, 416, 200, 206) the file is opened through packs.openVerified: the pack's folders must
// still be real folders and the file must keep its size, inode, device, mtime and ctime, else the cache is dropped,
// the pack is validated again once, and only then is the file served (or 404). The open and the checks are separate
// system calls, so a swap in the instant between them can not be excluded entirely (Node has no openat()).

const fs = require('fs');
const crypto = require('crypto');
const { pipeline } = require('stream');
const packs = require('./packs');

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const CACHE_CONTROL = 'private, max-age=86400';
const CACHE_CONTROL_MANIFEST = 'private, no-cache';   // always revalidated (a cheap 304), so a changed manifest shows at once

function defaultJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function etagFor(id, f) {
  const h = crypto.createHash('sha1').update(`${id}\0${f.rel}\0${f.size}\0${f.mtimeMs}\0${f.ctimeMs}\0${f.ino}\0${f.dev}`).digest('hex').slice(0, 24);
  return `"${h}"`;
}

/** If-None-Match: a list of entity tags (weak compare), or "*". */
function noneMatch(header, etag) {
  if (!header) return false;
  const h = String(header).trim();
  if (h === '*') return true;
  const strip = (t) => t.trim().replace(/^W\//, '');
  return h.split(',').some(t => strip(t) === etag);
}

/** One byte range: "bytes=a-b", "bytes=a-", "bytes=-n". Returns { start, end } | 'invalid' (unsatisfiable) | null (ignore the header). */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;   // not a single range: ignored, the whole file is sent
  if (m[1] === '') {
    const n = Number(m[2]);
    if (!Number.isSafeInteger(n) || n <= 0) return 'invalid';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (!Number.isSafeInteger(start) || start >= size) return 'invalid';
  let end = m[2] === '' ? size - 1 : Number(m[2]);
  if (!Number.isSafeInteger(end) || end < start) return null;   // "5-3" is a malformed range: ignored
  return { start, end: Math.min(end, size - 1) };
}

function methodNotAllowed(res) {
  res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify({ error: 'method not allowed' }));
}

/** `opened` is the verified { fd, st } of f (packs.openVerified); serveFile owns the descriptor from here on. */
function serveFile(pack, f, opened, req, res, json) {
  const { fd } = opened;
  const head = req.method === 'HEAD';
  const etag = etagFor(pack.id, f);
  const base = {
    'Content-Type': f.mime,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': f.kind === 'manifest' ? CACHE_CONTROL_MANIFEST : CACHE_CONTROL,
    'Cross-Origin-Resource-Policy': 'same-origin',
    ETag: etag,
    'Accept-Ranges': 'bytes',
  };
  const h = req.headers || {};
  const closeFd = () => { try { fs.closeSync(fd); } catch { /* closed */ } };
  if (noneMatch(h['if-none-match'], etag)) { closeFd(); res.writeHead(304, { ETag: etag, 'Cache-Control': base['Cache-Control'], 'X-Content-Type-Options': 'nosniff' }); return res.end(); }

  let range = null;
  const ifRange = h['if-range'];
  if (h.range && (!ifRange || String(ifRange).trim() === etag)) range = parseRange(h.range, f.size);
  if (range === 'invalid') {
    closeFd();
    res.writeHead(416, { ...base, 'Content-Range': `bytes */${f.size}`, 'Content-Length': 0 });
    return res.end();
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : f.size - 1;
  const length = end - start + 1;
  const headers = { ...base, 'Content-Length': length };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${f.size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (head) { closeFd(); return res.end(); }
  const stream = fs.createReadStream(null, { fd, start, end, autoClose: true });
  // A client that goes away destroys the stream (and closes the file); a read error ends the response without a crash.
  res.on('close', () => { if (!stream.destroyed) stream.destroy(); });
  return new Promise((resolve) => {
    pipeline(stream, res, (err) => {
      if (err && !res.writableEnded) { try { res.destroy(); } catch { /* gone */ } }
      resolve();
    });
  });
}

/**
 * handle(pathname, req, res, deps) -> always answers.
 * deps: { jsonResponse?, home? } (home defaults to the hub home; tests pass their own).
 */
async function handle(pathname, req, res, deps = {}) {
  const json = deps.jsonResponse || defaultJson;
  const user = req.hubUser || req.user;
  if (!user || req.hubPendingTotp) return json(res, 401, { error: 'sign in first' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res);
  let home = deps.home;
  if (!home) home = require('../hub-home').HUB_HOME;

  const p = String(pathname || '').replace(/\/+$/, '');
  if (p === '/api/faces') {
    const list = packs.listPacks({ home }).map(({ id, manifest }) => ({
      id,
      name: typeof manifest.name === 'string' && manifest.name ? manifest.name : id,
      background: typeof manifest.background === 'string' ? manifest.background : null,
      hasReactions: manifest.clips.some(c => c.state === 'reaction'),
    }));
    // HEAD: same headers, no body (jsonResponse of the host handles both the same way as GET).
    if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); return res.end(); }
    return json(res, 200, { packs: list });
  }
  const m = /^\/api\/faces\/([^/]+)\/(.+)$/.exec(p);
  if (!m || /[%\\\0]/.test(m[2])) return json(res, 404, { error: 'not found' });
  let pack = packs.getPack(m[1], { home });
  let f = pack && pack.files[m[2]];
  if (!f) return json(res, 404, { error: 'not found' });
  let opened = packs.openVerified(pack, f);
  if (!opened) {
    // Something under the cached pack changed: forget it and validate from scratch, once.
    packs.clearCache();
    pack = packs.getPack(m[1], { home });
    f = pack && pack.files[m[2]];
    opened = f ? packs.openVerified(pack, f) : null;
    if (!opened) return json(res, 404, { error: 'not found' });
  }
  return serveFile(pack, f, opened, req, res, json);
}

module.exports = { handle, parseRange, noneMatch };
