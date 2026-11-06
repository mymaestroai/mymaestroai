'use strict';
// Public receivers: a module that declares manifest.receiver gets /hooks/<id>/<sub> (and, if the owner set
// receiverAliases by hand in data/settings.json, /<alias>/<sub>). These paths are reachable without a hub sign-in, so
// every request is checked here and handed to the module's own process as JSON-RPC "hub/receive". This file never
// reads cookies, sessions or tokens, never sets cookies, and never forwards Cookie or Authorization.

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
const WINDOW_MS = 60000;
const LIMIT = 120;
const LIMIT_ALL = 600;   // per module across every address: a proxy header can be forged to look like many senders
const MAX_KEYS = 5000;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]{2,45}(?:%[0-9a-zA-Z]+)?)$/;

function createReceivers({ manifestOf, connectorFor, request, getSetting, now = Date.now, log = () => {} }) {
  const hits = new Map();   // "<id>|<ip>" -> [timestamps]

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
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  }

  function readBody(req, cap) {
    return new Promise((resolve) => {
      const chunks = []; let n = 0; let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      req.on('data', (c) => {
        if (done) return;
        n += c.length;
        if (n > cap) { finish(null); return; }
        chunks.push(c);
      });
      req.on('end', () => finish(Buffer.concat(chunks)));
      req.on('error', () => finish(null));
      req.on('close', () => finish(Buffer.concat(chunks)));
    });
  }

  function cleanReply(result) {
    if (!result || typeof result !== 'object') return null;
    const { status } = result;
    if (!Number.isInteger(status) || status < 200 || status > 599) return null;
    if (result.headers !== undefined && (result.headers === null || typeof result.headers !== 'object' || Array.isArray(result.headers))) return null;
    if (result.body !== undefined && typeof result.body !== 'string') return null;
    const enc = result.bodyEncoding === undefined ? 'utf8' : result.bodyEncoding;
    if (enc !== 'utf8' && enc !== 'base64') return null;
    const raw = result.body || '';
    const body = enc === 'base64' ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf8');
    if (body.length > MAX_REPLY_BODY) return null;
    const headers = {};
    for (const [k, v] of Object.entries(result.headers || {})) {
      const name = k.toLowerCase();
      if (typeof v !== 'string' || v.length > MAX_REPLY_HEADER || /[\r\n]/.test(v)) continue;
      if (name === 'content-type' || name === 'cache-control' || name === 'content-security-policy' || name === 'retry-after') headers[name] = v;
      else if (name === 'location' && ((v.startsWith('/') && !v.startsWith('//')) || v.startsWith('https://'))) headers[name] = v;
    }
    return { status, headers, body };
  }

  async function handle(req, res, hit) {
    const started = now();
    const method = String(req.method || '').toUpperCase();
    let status = 0;
    const out = (code, body, headers) => { status = code; send(res, code, body, headers); };
    try {
      const { id, sub } = hit;
      const manifest = manifestOf(id);
      const c = connectorFor(id);
      if (!(manifest && manifest.receiver && Array.isArray(manifest.receiver.paths) && manifest.receiver.paths.includes(sub) && c && c.enabled)) return out(404, 'Not found');
      if (!METHODS.has(method)) return out(405, 'Method not allowed', { Allow: 'GET, HEAD, POST' });
      const host = String(req.headers.host || '').toLowerCase();
      if (req.headers.origin !== undefined) {
        const o = String(req.headers.origin);
        if (!host || (o !== `https://${host}` && o !== `http://${host}`)) return out(403, 'Forbidden');
      }
      if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return out(403, 'Forbidden');
      const ip = clientIp(req);
      if (limited(id, ip)) return out(429, 'Too many requests', { 'Retry-After': '60' });

      const rawUrl = String(req.url || '');
      const qi = rawUrl.indexOf('?');
      const query = qi >= 0 ? rawUrl.slice(qi + 1) : '';
      if (query.length > MAX_QUERY) return out(414, 'URI too long');

      let bytes = Buffer.alloc(0);
      if (method === 'POST') {
        const cap = Number(manifest.receiver.maxBody) > 0 ? Number(manifest.receiver.maxBody) : DEFAULT_MAX_BODY;
        const got = await readBody(req, cap);
        if (got === null) {
          out(413, 'Payload too large', { Connection: 'close' });
          try { req.socket && req.socket.destroy && setImmediate(() => req.socket.destroy()); } catch { /* gone */ }
          return;
        }
        bytes = got;
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
      try { result = await request(id, 'hub/receive', params, { timeoutMs: 10000 }); }
      catch (e) {
        if (e && e.code === 'ENOTAVAILABLE') return out(404, 'Not found');
        if (e && /timed out/i.test(String(e.message))) return out(503, 'Try again later', { 'Retry-After': '10' });
        return out(502, 'Bad gateway');
      }
      const reply = cleanReply(result);
      if (!reply) return out(502, 'Bad gateway');
      const h = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'cache-control': 'no-store', ...reply.headers };
      // A page the module serves without its own policy may not run scripts or load anything from elsewhere.
      if (/text\/html/i.test(h['content-type'] || '') && !h['content-security-policy']) h['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
      status = reply.status;
      if (res.headersSent) { try { res.end(); } catch { /* gone */ } return; }
      res.writeHead(reply.status, h);
      res.end(method === 'HEAD' ? undefined : reply.body);
    } catch {
      if (!status) out(502, 'Bad gateway');
    } finally {
      log(`[hooks] ${hit.id} ${method} ${hit.sub} -> ${status} ${now() - started}ms`);
    }
  }

  return { match, handle };
}

module.exports = { createReceivers, RESERVED };
