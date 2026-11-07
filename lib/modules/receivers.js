'use strict';
// Public receivers: a module that declares manifest.receiver gets /hooks/<id>/<sub> (and, if the owner set
// receiverAliases by hand in data/settings.json, /<alias>/<sub>). These paths are reachable without a hub sign-in, so
// every request is checked here and handed to the module's own process as JSON-RPC "hub/receive". This file never
// reads cookies, sessions or tokens, never sets cookies, and never forwards Cookie or Authorization.

const { validateHeaderValue } = require('http');

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const SUB_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const ALIAS_RE = /^\/[a-z][a-z0-9-]{0,30}\/$/;
const RESERVED = new Set(['api', 'v1', 'hooks', 'oauth', 'icons', 'vendor', 'static', 'mobile', 'login', 'logout', 'welcome', 'help', 'users', 'modules', 'health', 'setup', 'setup-admin', 'agent-settings', 'tiger-team', 'local-models', 'files', 'share']);
const METHODS = new Set(['GET', 'HEAD', 'POST']);
const DEFAULT_MAX_BODY = 1048576;
const MAX_QUERY = 4096;
const MAX_HEADER_VALUE = 4096;
const MAX_REPLY_BODY = 1048576;
const MAX_REPLY_HEADER = 2048;
const MAX_BINARY_BODY = 16 * 1024 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const TYPE_RE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;
const BINARY_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream']);
const DISPOSITION_RE = /^attachment; filename="[A-Za-z0-9._-]{1,100}"$/;
const WINDOW_MS = 60000;
const LIMIT = 120;
const LIMIT_ALL = 600;   // per module across every address: a proxy header can be forged to look like many senders
const MAX_KEYS = 5000;
const MAX_INFLIGHT = 20;   // per module, requests being handled at once
const BODY_TIMEOUT_MS = 15000;
const HUB_CSP = 'sandbox allow-forms';   // the hub's own policy: a module reply can add to it, never remove it
const PRINTABLE_RE = /^[\x20-\x7e]*$/;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]{2,45}(?:%[0-9a-zA-Z]+)?)$/;

function createReceivers({ manifestOf, connectorFor, request, getSetting, now = Date.now, log = () => {}, bodyTimeoutMs = BODY_TIMEOUT_MS }) {
  const hits = new Map();   // "<id>|<ip>" -> [timestamps]
  const inflight = new Map();   // id -> requests being handled

  function match(pathname) {
    const p = String(pathname || '');
    let m = /^\/hooks\/([^/]+)\/([^/]+)$/.exec(p);
    if (m) return ID_RE.test(m[1]) && SUB_RE.test(m[2]) ? { id: m[1], sub: m[2] } : null;
    let aliases = null;
    try { aliases = getSetting('receiverAliases'); } catch { aliases = null; }
    if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) return null;
    m = /^(\/[^/]+\/)([^/]+)$/.exec(p);
    if (!m) return null;
    const key = m[1];
    if (!Object.prototype.hasOwnProperty.call(aliases, key) || !ALIAS_RE.test(key) || RESERVED.has(key.slice(1, -1))) return null;
    const id = aliases[key];
    if (typeof id !== 'string' || !ID_RE.test(id) || !SUB_RE.test(m[2])) return null;
    return { id, sub: m[2] };
  }

  function clientIp(req) {
    const peer = String((req.socket && req.socket.remoteAddress) || '');
    if (!LOOPBACK.has(peer)) return peer;
    for (const name of ['cf-connecting-ip', 'x-forwarded-for']) {
      const v = req.headers[name];
      if (v === undefined) continue;
      const first = String(Array.isArray(v) ? v[0] : v).split(',')[0].trim();
      if (first && IP_RE.test(first)) return first;
    }
    return peer;
  }

  function over(key, limit, t) {
    const list = (hits.get(key) || []).filter((x) => t - x < WINDOW_MS);
    hits.delete(key); hits.set(key, list);   // newest last
    return list.length >= limit;
  }
  function limited(id, ip) {
    const t = now();
    const one = `${id}|${ip}`, all = `${id}|*`;
    if (over(all, LIMIT_ALL, t) || over(one, LIMIT, t)) return true;
    hits.get(all).push(t); hits.get(one).push(t);
    while (hits.size > MAX_KEYS) hits.delete(hits.keys().next().value);
    return false;
  }

  function send(res, status, body, headers = {}) {
    if (res.headersSent) { try { res.end(); } catch { /* gone */ } return; }
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store', ...headers, 'Content-Security-Policy': HUB_CSP });
    res.end(body);
  }

  // Resolves { bytes } or { fail: 'big' | 'timeout' | 'aborted' | 'mismatch' }.
  function readBody(req, cap) {
    return new Promise((resolve) => {
      const chunks = []; let n = 0; let done = false;
      const timer = setTimeout(() => finish({ fail: 'timeout' }), bodyTimeoutMs);
      const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
      const cl = req.headers['content-length'];
      req.on('data', (c) => {
        if (done) return;
        n += c.length;
        if (n > cap) { finish({ fail: 'big' }); return; }
        chunks.push(c);
      });
      req.on('end', () => finish(cl !== undefined && /^\d+$/.test(String(cl)) && Number(cl) !== n ? { fail: 'mismatch' } : { bytes: Buffer.concat(chunks) }));
      req.on('error', () => finish({ fail: 'aborted' }));
      req.on('close', () => finish({ fail: 'aborted' }));
    });
  }

  // A reply carrying bodyBase64: the bytes go out as given, with a narrow set of headers. Returns a reply,
  // { refuse: <plain message> } (logged, answered 502) or null.
  function cleanBinaryReply(result) {
    if (result.body !== undefined || result.bodyEncoding !== undefined) return { refuse: 'reply has both body and bodyBase64' };
    const b64 = result.bodyBase64;
    if (typeof b64 !== 'string') return null;
    if (b64.length > Math.ceil(MAX_BINARY_BODY / 3) * 4) return { refuse: 'binary reply too large' };
    if (b64.length % 4 !== 0 || !BASE64_RE.test(b64)) return { refuse: 'bodyBase64 is not valid base64' };
    const body = Buffer.from(b64, 'base64');
    if (body.length > MAX_BINARY_BODY) return { refuse: 'binary reply too large' };
    const headers = {};
    for (const [k, v] of Object.entries(result.headers || {})) {
      const name = k.toLowerCase();
      if (typeof v !== 'string' || v.length > MAX_REPLY_HEADER || !PRINTABLE_RE.test(v)) continue;
      try { validateHeaderValue(name, v); } catch { continue; }
      if (name === 'content-type') { const t = v.trim().toLowerCase(); if (TYPE_RE.test(t) && BINARY_TYPES.has(t)) headers[name] = t; }   // any other type is sent as plain bytes
      else if (name === 'content-disposition') { if (DISPOSITION_RE.test(v)) headers[name] = v; }   // anything else is dropped
      else if (name === 'cache-control') { if (v.trim().toLowerCase() === 'no-store') headers[name] = 'no-store'; }
      else if (name === 'retry-after') headers[name] = v;   // a module's own Content-Security-Policy is ignored here: the hub's sandbox policy alone applies
      else if (name === 'location' && ((v.startsWith('/') && !v.startsWith('//')) || v.startsWith('https://'))) headers[name] = v;
    }
    if (!headers['content-type']) headers['content-type'] = 'application/octet-stream';
    // Plain bytes are always a download, never shown in the page: the module's file name when it is a safe one.
    if (headers['content-type'] === 'application/octet-stream' && !headers['content-disposition']) headers['content-disposition'] = 'attachment; filename="download.bin"';
    headers['content-length'] = String(body.length);
    return { status: result.status, headers, body };
  }

  function cleanReply(result) {
    if (!result || typeof result !== 'object') return null;
    const { status } = result;
    if (!Number.isInteger(status) || status < 200 || status > 599) return null;
    if (result.headers !== undefined && (result.headers === null || typeof result.headers !== 'object' || Array.isArray(result.headers))) return null;
    if (result.bodyBase64 !== undefined) return cleanBinaryReply(result);
    if (result.body !== undefined && typeof result.body !== 'string') return null;
    const enc = result.bodyEncoding === undefined ? 'utf8' : result.bodyEncoding;
    if (enc !== 'utf8' && enc !== 'base64') return null;
    const raw = result.body || '';
    const body = enc === 'base64' ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf8');
    if (body.length > MAX_REPLY_BODY) return null;
    const headers = {};
    for (const [k, v] of Object.entries(result.headers || {})) {
      const name = k.toLowerCase();
      if (typeof v !== 'string' || v.length > MAX_REPLY_HEADER || !PRINTABLE_RE.test(v)) continue;
      try { validateHeaderValue(name, v); } catch { continue; }
      if (name === 'content-type' || name === 'cache-control' || name === 'content-security-policy' || name === 'retry-after') headers[name] = v;
      else if (name === 'location' && ((v.startsWith('/') && !v.startsWith('//')) || v.startsWith('https://'))) headers[name] = v;
    }
    return { status, headers, body };
  }

  async function handle(req, res, hit) {
    const started = now();
    const method = String(req.method || '').toUpperCase();
    let status = 0;
    const out = (code, body, headers) => { send(res, code, body, headers); status = code; };
    let counted = null, countedIp = null;
    try {
      const { id, sub } = hit;
      const manifest = manifestOf(id);
      const c = connectorFor(id);
      if (!(manifest && manifest.receiver && Array.isArray(manifest.receiver.paths) && manifest.receiver.paths.includes(sub) && c && c.enabled)) return out(404, 'Not found');
      if (!METHODS.has(method)) return out(405, 'Method not allowed', { Allow: 'GET, HEAD, POST' });
      const host = String(req.headers.host || '').toLowerCase();
      if (req.headers.origin !== undefined) {
        const o = String(req.headers.origin);
        if (!host || (o !== `https://${host}` && o !== `http://${host}` && o !== 'null')) return out(403, 'Forbidden');
      }
      const ip = clientIp(req);
      if (limited(id, ip)) return out(429, 'Too many requests', { 'Retry-After': '60' });

      const ipKey = `${id}|${ip}`;
      if ((inflight.get(id) || 0) >= MAX_INFLIGHT || (inflight.get(ipKey) || 0) >= 4) return out(503, 'Try again later', { 'Retry-After': '5' });
      inflight.set(id, (inflight.get(id) || 0) + 1); inflight.set(ipKey, (inflight.get(ipKey) || 0) + 1); counted = id; countedIp = ipKey;

      const rawUrl = String(req.url || '');
      const qi = rawUrl.indexOf('?');
      const query = qi >= 0 ? rawUrl.slice(qi + 1) : '';
      if (query.length > MAX_QUERY) return out(414, 'URI too long');

      let bytes = Buffer.alloc(0);
      if (method === 'POST') {
        const cap = Number(manifest.receiver.maxBody) > 0 ? Number(manifest.receiver.maxBody) : DEFAULT_MAX_BODY;
        const got = await readBody(req, cap);
        if (got.fail) {
          const kill = () => { try { req.socket && req.socket.destroy && setImmediate(() => req.socket.destroy()); } catch { /* gone */ } };
          if (got.fail === 'big') { out(413, 'Payload too large', { Connection: 'close' }); kill(); }
          else if (got.fail === 'timeout') { out(408, 'Request timeout', { Connection: 'close' }); kill(); }
          else if (got.fail === 'mismatch') out(400, 'Bad request');
          else { try { res.end(); } catch { /* gone */ } }
          return;
        }
        bytes = got.bytes;
      }

      const headers = {};
      const want = ['content-type', 'user-agent', 'accept', ...(Array.isArray(manifest.receiver.headers) ? manifest.receiver.headers.map((h) => String(h).toLowerCase()) : [])];
      for (const name of want) {
        if (name === 'cookie' || name === 'authorization') continue;
        const v = req.headers[name];
        if (v === undefined) continue;
        headers[name] = String(Array.isArray(v) ? v[0] : v).slice(0, MAX_HEADER_VALUE);
      }
      const params = { method, path: sub, query, headers, body: method === 'POST' ? bytes.toString('base64') : '', ip, at: new Date(now()).toISOString() };

      let result;
      try { result = await request(id, 'hub/receive', params, { timeoutMs: (Number(manifest.receiver.timeoutSec) || 10) * 1000 }); }
      catch (e) {
        if (e && e.code === 'ENOTAVAILABLE') return out(404, 'Not found');
        if (e && e.code === 'EBACKOFF') return out(503, 'Try again later', { 'Retry-After': '10' });
        if (e && /timed out/i.test(String(e.message))) return out(503, 'Try again later', { 'Retry-After': '10' });
        return out(502, 'Bad gateway');
      }
      const reply = cleanReply(result);
      if (reply && reply.refuse) { log(`[hooks] ${id} ${method} ${sub} refused: ${reply.refuse}`); return out(502, `Bad gateway: ${reply.refuse}`); }
      if (!reply) return out(502, 'Bad gateway');
      const h = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'cache-control': 'no-store', ...reply.headers };
      // A page the module serves without its own policy may not run scripts or load anything from elsewhere.
      if (/text\/html/i.test(h['content-type'] || '') && !h['content-security-policy']) h['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
      h['content-security-policy'] = [h['content-security-policy'], HUB_CSP].filter(Boolean);
      if (res.headersSent) { try { res.end(); } catch { /* gone */ } return; }
      res.writeHead(reply.status, h);
      status = reply.status;
      res.end(method === 'HEAD' ? undefined : reply.body);
    } catch {
      if (!res.headersSent) {
        try { out(502, 'Bad gateway'); } catch { try { res.destroy && res.destroy(); } catch { /* gone */ } }
      } else {
        try { res.end(); } catch { /* gone */ }
        try { res.destroy && res.destroy(); } catch { /* gone */ }
      }
    } finally {
      for (const key of [counted, countedIp]) if (key) { const k = (inflight.get(key) || 1) - 1; if (k > 0) inflight.set(key, k); else inflight.delete(key); }
      log(`[hooks] ${hit.id} ${method} ${hit.sub} -> ${status} ${now() - started}ms`);
    }
  }

  return { match, handle };
}

module.exports = { createReceivers, RESERVED };
