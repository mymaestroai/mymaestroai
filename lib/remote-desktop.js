'use strict';
// Open desktop (Remote computers): the hub side. A signed-in admin (or only the owner, by setting) opens a computer's live
// screen on a hub page. The hub keeps the session map, serves the viewer page and MeshCentral's own viewer scripts, and
// relays the one desktop websocket to MeshCentral on 127.0.0.1 (MeshCentral itself is never reachable from the browser).
//
//   GET  /api/remote-desktop                          the computers and who may open one
//   POST /api/remote-desktop/open  {nodeid}           -> {url, session, until}
//   POST /api/remote-desktop/<session>/end            -> {ok:true}
//   GET  /remote-desktop/<session>/                   the viewer page (boot JSON injected)
//   GET  /remote-desktop/<session>/scripts/<name>     three MeshCentral viewer scripts, proxied (CA pinned)
//   WS   /remote-desktop/<session>/meshrelay.ashx     relayed to MeshCentral after the checks
//
// Every dependency is injected (see createRemoteDesktop) so the routes are tested without a hub or a MeshCentral.

const SESSION_RE = /^[A-Za-z0-9_-]{16,64}$/;
const NODE_RE = /^[A-Za-z0-9$@/_-]{1,200}$/;
const TUNNEL_RE = /^[A-Za-z0-9]{6,64}$/;
const ADDRESS_RE = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/;
const SCRIPTS = new Set(['common-0.0.1.js', 'agent-redir-ws-0.1.1.js', 'agent-desktop-0.0.2.js']);
// SHA-256 of each viewer script as MeshCentral 1.3.1 ships it. These pins change with the MeshCentral version in modules/remote-computers/runtime:
// a script that does not match is refused (and never cached), so a changed or swapped script never reaches the browser.
const SCRIPT_SHA256 = {
  'common-0.0.1.js': '4ccd0253f97129d855ece6f68a4629bc4767fe3af33d0b61eeac73f5402db013',
  'agent-redir-ws-0.1.1.js': '54911cffc1e7da5822e772339e79017c1265fa40413cac15134b23b7305a9d54',
  'agent-desktop-0.0.2.js': '5df980270ebf68a74dca6e2a352dea6ab97cd16c6867d71a30effe2b79038d20',
};
const MAX_RELAYS = 2;     // relays per session at once (pending or active): a reconnect overlaps its predecessor
const SWEEP_MS = 15000;
const BOOT_MARK = '<script type="application/json" id="rd-boot">{}</script>';
const MAX_BODY = 8 * 1024;
const MAX_HEAD = 16 * 1024;
const MAX_SCRIPT = 4 * 1024 * 1024;
const HEAD_WAIT_MS = 15000;
const GENERIC_FAIL = 'The desktop could not be reached just now. Try again in a moment.';

function createRemoteDesktop(deps = {}) {
  const d = deps;
  const now = d.now || (() => Date.now());
  const setTimer = d.setTimer || ((fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; });
  const clearTimer = d.clearTimer || ((t) => clearTimeout(t));
  const log = d.log || (() => {});
  const audit = d.audit || (() => {});
  const enabled = d.enabled || (() => true);
  const tlsConnect = d.tlsConnect || ((o) => require('tls').connect(o));
  const httpsGet = d.httpsGet || defaultHttpsGet;
  const pins = d.scriptHashes || SCRIPT_SHA256;

  /** session id -> { nodeid, name, who: {id, name}, byOwner, start, until, sockets: Set, relays, timer } */
  const sessions = new Map();
  const scriptCache = new Map();
  let opening = 0;   // opens in flight: their module session exists before it is in `sessions`

  // ── settings ────────────────────────────────────────────────────────────
  function cfg() {
    let s = {};
    try { s = (d.settings && d.settings()) || {}; } catch { s = {}; }
    const who = s.desktop_who === 'owner' ? 'owner' : 'admins';
    let minutes = Number(s.desktop_minutes);
    if (!Number.isFinite(minutes)) minutes = 30;
    minutes = Math.min(120, Math.max(5, Math.round(minutes)));
    const address = typeof s.desktop_address === 'string' && ADDRESS_RE.test(s.desktop_address) ? s.desktop_address : '';
    return { who, minutes, address };
  }

  // ── answers ─────────────────────────────────────────────────────────────
  function json(res, code, body, extra = {}) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(body));
  }
  function text(res, code, body, extra = {}) {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(body);
  }
  function refuseSocket(socket, code, reason) {
    const msg = `HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
    try { socket.end(msg, () => { try { socket.destroy(); } catch { /* gone */ } }); } catch { try { socket.destroy(); } catch { /* gone */ } }
  }

  // ── tool calls: anything that is not an object, or has .error, is a failure ──
  async function tool(name, args) {
    let raw;
    try { raw = await d.callTool(name, args); } catch (e) { return { error: GENERIC_FAIL, thrown: true }; }
    let out = null;
    try { out = d.parse(raw); } catch { out = null; }
    if (!out || typeof out !== 'object') return { error: GENERIC_FAIL };
    if (out.error) return { ...out, error: String(out.error).slice(0, 300) };
    return out;
  }

  // ── identity ────────────────────────────────────────────────────────────
  /** -> { user } or { code, error, login }. */
  function person(req, cls) {
    let id = null;
    try { id = d.identify(req) || {}; } catch { id = {}; }
    if (id.service || id.token) return { code: 403, error: 'forbidden' };
    if (!id.user) return { code: 401, error: 'unauthorized', login: true };
    if (id.pendingTotp) return { code: 401, error: 'totp_required', login: true };
    if (!d.isAdmin(id.user)) return { code: 403, error: 'admin_only', user: id.user };
    if (cls.who === 'owner' && !d.isOwner(id.user)) return { code: 403, error: 'owner_only', user: id.user };
    return { user: id.user };
  }
  function userOf(u) { return { id: String(u.id), name: String(u.name || u.login || u.id) }; }

  // ── sessions ────────────────────────────────────────────────────────────
  function live(s) { return !!s && s.until > now(); }

  /** One log line and one audit record per session, written exactly once (the entry is removed first). */
  function record(entry, reason, endMs) {
    const line = `${entry.who.name} (${entry.who.id}) ${entry.name}: ${new Date(entry.start).toISOString()} to ${new Date(endMs).toISOString()} (${reason})`;
    try { log(`[remote-desktop] ${line}`); } catch { /* logging never breaks a session */ }
    try {
      audit({ ts: new Date(endMs).toISOString(), tool: 'desktop', cls: 'hub', decision: 'closed', note: line, nodeid: entry.nodeid, computer: entry.name, who: entry.who, start: new Date(entry.start).toISOString(), end: new Date(endMs).toISOString(), ended_by: reason });
    } catch { /* same */ }
  }

  function closeSockets(entry) {
    for (const s of Array.from(entry.sockets)) { try { s.destroy(); } catch { /* gone */ } }
    entry.sockets.clear();
  }

  async function finish(session, reason) {
    const entry = sessions.get(session);
    if (!entry) return false;
    sessions.delete(session);
    if (entry.timer) { try { clearTimer(entry.timer); } catch { /* none */ } entry.timer = null; }
    closeSockets(entry);
    record(entry, reason, now());
    await tool('desktop_end', { session, reason });   // a failure here leaves the module's own expiry to clear it
    return true;
  }

  /** Ends every session that must no longer run: module off ('disabled'), desktop_who now "owner" and the opener was not the owner,
   *  or the opener is no longer an admin ('revoked'). Never throws. */
  async function sweep() {
    try {
      const on = enabled();
      const c = cfg();
      const pending = [];
      for (const [id, s] of Array.from(sessions)) {
        let reason = null;
        if (!on) reason = 'disabled';
        else if (c.who === 'owner' && !s.byOwner) reason = 'revoked';
        else {
          let ok = false;
          try { ok = d.stillAdmin ? !!d.stillAdmin(s.who.id) : true; } catch { ok = false; }   // unknown standing: closed
          if (!ok) reason = 'revoked';
        }
        if (reason) pending.push(finish(id, reason).catch(() => {}));   // started at once: each finish closes its sockets before its first await
      }
      await Promise.all(pending);
    } catch { /* a sweep never breaks the hub */ }
  }
  const sweepMs = Number(d.sweepMs) > 0 ? Number(d.sweepMs) : SWEEP_MS;
  const repeat = d.setRepeat || ((fn, ms) => { const t = setInterval(fn, ms); if (t && t.unref) t.unref(); return t; });
  const stopRepeat = d.clearRepeat || ((t) => clearInterval(t));
  let sweepTimer = null;
  try { sweepTimer = repeat(() => { sweep(); }, sweepMs); } catch { sweepTimer = null; }
  function close() { if (sweepTimer) { try { stopRepeat(sweepTimer); } catch { /* none */ } sweepTimer = null; } }

  function pathUrl(session) { return `/remote-desktop/${session}/`; }

  // ── routes ──────────────────────────────────────────────────────────────
  function readJson(req) {
    return new Promise((resolve) => {
      if (typeof req._bodyText === 'string') { try { return resolve(JSON.parse(req._bodyText || '{}')); } catch { return resolve(null); } }
      const chunks = []; let n = 0; let done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      req.on('data', (c) => { n += c.length; if (n > MAX_BODY) return fin(null); chunks.push(c); });
      req.on('end', () => { try { fin(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { fin(null); } });
      req.on('error', () => fin(null));
    });
  }

  function routeOf(req) {
    let p = '';
    try { p = new URL(req.url || '/', 'http://x').pathname; } catch { return null; }
    if (p === '/api/remote-desktop') return { kind: 'list' };
    if (p === '/api/remote-desktop/open') return { kind: 'open' };
    let m = p.match(/^\/api\/remote-desktop\/([^/]+)\/end$/);
    if (m) return { kind: 'end', session: m[1] };
    if (p.startsWith('/api/remote-desktop/')) return { kind: 'api-other' };
    m = p.match(/^\/remote-desktop\/([^/]+)(\/.*)?$/);
    if (!m) return null;
    const tail = m[2] || '';
    if (tail === '') return { kind: 'bare', session: m[1] };
    if (tail === '/') return { kind: 'page', session: m[1] };
    let s = tail.match(/^\/scripts\/([^/]+)$/);
    if (s) return { kind: 'script', session: m[1], name: s[1] };
    if (tail === '/meshrelay.ashx') return { kind: 'relay', session: m[1] };
    return { kind: 'page-other', session: m[1] };
  }

  /** The session of this request, or null (unknown, expired and another person's all look the same). */
  function ownSession(id, user) {
    if (!SESSION_RE.test(String(id))) return null;
    const s = sessions.get(id);
    if (!s) return null;
    if (!live(s)) { finish(id, 'time').catch(() => {}); return null; }
    if (s.who.id !== String(user.id)) return null;
    return s;
  }

  async function handle(req, res) {
    const r = routeOf(req);
    if (!r) return false;
    const isPage = !r.kind.startsWith('api') && !['list', 'open', 'end'].includes(r.kind);
    const notFound = () => (isPage ? text(res, 404, 'Not found') : json(res, 404, { error: 'Not found' }));
    if (!d.tailnetOk(req)) { text(res, 403, 'Forbidden: this Tailscale user is not allowed on this hub.'); return true; }
    if (!enabled()) { notFound(); return true; }
    const method = req.method || 'GET';
    const c = cfg();

    // GET /api/remote-desktop is the one route that answers an admin who may not open (desktop_who owner): allowed:false.
    const listCls = r.kind === 'list' ? { who: 'admins' } : c;
    let p = person(req, listCls);
    // End is always safe: the opener may end their own session even when their role no longer lets them open one (still a signed-in person).
    if (p.error && r.kind === 'end' && p.code === 403 && p.user && ownSession(r.session, p.user)) p = { user: p.user };
    if (p.error) {
      if (isPage && p.login) { res.writeHead(302, { Location: `/login?next=${encodeURIComponent(req.url || '/')}`, 'Cache-Control': 'no-store' }); res.end(); return true; }
      if (isPage) { text(res, p.code, p.code === 401 ? 'Sign in first.' : 'Forbidden'); return true; }
      json(res, p.code, { error: p.error });
      return true;
    }
    const user = p.user;

    if (r.kind === 'list') { if (method !== 'GET') { notFound(); return true; } await list(req, res, user, c); return true; }
    if (r.kind === 'open') { if (method !== 'POST') { notFound(); return true; } await open(req, res, user, c); return true; }
    if (r.kind === 'end') {
      if (method !== 'POST') { notFound(); return true; }
      const s = ownSession(r.session, user);
      if (!s) { json(res, 404, { error: 'That desktop session is not open.' }); return true; }
      await finish(r.session, 'ended');
      json(res, 200, { ok: true });
      return true;
    }
    if (r.kind === 'relay') { text(res, 400, 'This address is for a websocket.'); return true; }
    if (method !== 'GET' && method !== 'HEAD') { notFound(); return true; }
    const s = ownSession(r.session, user);
    if (!s) { notFound(); return true; }
    if (r.kind === 'bare') { res.writeHead(301, { Location: pathUrl(r.session), 'Cache-Control': 'no-store' }); res.end(); return true; }
    if (r.kind === 'page') { page(res, r.session, s); return true; }
    if (r.kind === 'script') { await script(res, r.session, r.name); return true; }
    notFound();
    return true;
  }

  /** Sessions the module still holds but this hub no longer knows (the hub restarted): end them, they cannot be reached. Each is ended by
   *  computer AND its start, so a newer session opened on that computer in between is never touched. Returns the sessions still open. */
  async function endOrphans(open) {
    const known = new Set(Array.from(sessions.values()).map((s) => s.nodeid));
    let left = open;
    for (const x of opening ? [] : open.filter((o) => !known.has(o.nodeid))) {
      const ended = await tool('desktop_end', { nodeid: x.nodeid, start: x.start, reason: 'restart' });
      if (!ended.error) {
        const w = ended.who || x.who || {};
        record({ who: { id: String(w.id || ''), name: String(w.name || '') }, name: String(ended.name || x.name || ''), nodeid: x.nodeid, start: Number(ended.start || x.start) || now() }, 'restart', now());
        left = left.filter((o) => o !== x);
      }
    }
    return left;
  }

  /** Once after a hub start: ends module sessions this hub does not know (they would block agent input until the page is opened). Never throws. */
  async function reconcile() {
    try {
      if (!enabled()) return;
      const act = await tool('desktop_sessions', {});
      if (act.error || !Array.isArray(act.sessions)) return;
      await endOrphans(act.sessions.filter((x) => x && typeof x === 'object' && x.until > now()));
    } catch { /* the page's own list() does the same later */ }
  }

  async function list(req, res, user, c) {
    const allowed = !(c.who === 'owner' && !d.isOwner(user));
    if (!allowed) return json(res, 200, { allowed: false, minutes: c.minutes, computers: [] });
    const [pcs, act] = await Promise.all([tool('computers_status', {}), tool('desktop_sessions', {})]);
    if (pcs.error) return json(res, 409, { error: pcs.error });
    if (act.error) return json(res, 409, { error: act.error });
    const rows = Array.isArray(pcs) ? pcs : (Array.isArray(pcs.computers) ? pcs.computers : []);
    let open = Array.isArray(act.sessions) ? act.sessions.filter((x) => x && typeof x === 'object' && x.until > now()) : [];
    open = await endOrphans(open);
    const computers = rows.filter((x) => x && typeof x === 'object' && x.nodeid).map((x) => {
      const o = open.find((y) => y.nodeid === x.nodeid);
      let busy = null;
      if (o) {
        const mine = Array.from(sessions.entries()).find(([, s]) => s.nodeid === x.nodeid && s.who.id === String(user.id) && live(s));
        busy = { who: String((o.who && o.who.name) || ''), until: o.until, mine: !!mine };
        if (mine) busy.url = `${c.address}${pathUrl(mine[0])}`;
      }
      return { nodeid: x.nodeid, name: String(x.name || ''), online: !!x.online, busy };
    });
    json(res, 200, { allowed: true, minutes: c.minutes, computers });
  }

  async function open(req, res, user, c) {
    const b = await readJson(req);
    const nodeid = b && typeof b.nodeid === 'string' ? b.nodeid : '';
    if (!NODE_RE.test(nodeid)) return json(res, 400, { error: 'Say which computer to open.' });
    const who = userOf(user);
    for (const [id, s] of sessions) {   // the same person on the same computer gets the session they have
      if (s.nodeid === nodeid && s.who.id === who.id && live(s)) return json(res, 200, { url: `${c.address}${pathUrl(id)}`, session: id, until: s.until });
    }
    opening++;
    let out;
    try { out = await tool('desktop_open', { nodeid, who, minutes: c.minutes }); } finally { opening--; }
    if (out.error) return json(res, 409, { error: out.error, ...(out.busy ? { busy: out.busy } : {}) });
    const until = Number(out.until);
    if (typeof out.session !== 'string' || !SESSION_RE.test(out.session) || !Number.isFinite(until) || until <= now()) return json(res, 409, { error: GENERIC_FAIL });
    const entry = { nodeid: String(out.nodeid || nodeid), name: String(out.name || ''), who, byOwner: !!d.isOwner(user), relays: 0, start: Number(out.start) || now(), until, sockets: new Set(), timer: null };
    const session = out.session;
    sessions.set(session, entry);
    entry.timer = setTimer(() => { finish(session, 'time').catch(() => {}); }, Math.max(0, until - now()));
    json(res, 200, { url: `${c.address}${pathUrl(session)}`, session, until });
  }

  function page(res, session, s) {
    let html = '';
    try { html = String(d.readPage() || ''); } catch { html = ''; }
    if (!html.includes(BOOT_MARK)) return text(res, 404, 'Not found');
    const boot = JSON.stringify({ session, nodeid: s.nodeid, name: s.name, until: s.until, endUrl: `/api/remote-desktop/${session}/end` })
      .replace(/</g, '\\u003c').replace(/[\u2028]/g, '\\u2028').replace(/[\u2029]/g, '\\u2029');
    const at = html.indexOf(BOOT_MARK);
    const out = html.slice(0, at) + `<script type="application/json" id="rd-boot">${boot}</script>` + html.slice(at + BOOT_MARK.length);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(out);
  }

  async function endpoint(session) {
    const e = await tool('desktop_endpoint', { session });
    if (e.error) return null;
    const port = Number(e.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof e.servername !== 'string' || !e.servername || typeof e.ca !== 'string' || !e.ca) return null;
    return { port, servername: e.servername, ca: e.ca };
  }

  async function script(res, session, name) {
    if (!SCRIPTS.has(name)) return text(res, 404, 'Not found');
    let body = scriptCache.get(name);
    if (body === undefined) {
      const ep = await endpoint(session);
      if (!ep) return text(res, 404, 'Not found');
      let got = null;
      try { got = await httpsGet({ host: '127.0.0.1', port: ep.port, path: `/scripts/${name}`, ca: ep.ca, servername: ep.servername, headers: { Host: `${ep.servername}:${ep.port}` } }); } catch { got = null; }
      if (!got || got.status !== 200 || typeof got.body !== 'string') return text(res, 404, 'Not found');
      body = got.body;
      const sum = require('crypto').createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
      if (!pins[name] || sum !== pins[name]) {
        try { log(`[remote-desktop] viewer script ${name} from the Remote computers server does not match the pinned version; refused`); } catch { /* none */ }
        return text(res, 404, 'Not found');
      }
      scriptCache.set(name, body);
    }
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'private, max-age=300' });
    res.end(body);
  }

  // ── websocket relay ─────────────────────────────────────────────────────
  function originOk(req, c) {
    const origin = String(req.headers.origin || '').toLowerCase();
    if (!origin) return false;
    const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (fetchSite && fetchSite !== 'same-origin') return false;
    const host = String(req.headers.host || '').toLowerCase();
    if (host && (origin === `https://${host}` || origin === `http://${host}`)) return true;
    return !!c.address && origin === c.address.toLowerCase();
  }

  function upgrade(req, socket, head) {
    const r = routeOf(req);
    if (!r || r.kind !== 'relay') return false;
    try { socket.on('error', () => {}); } catch { /* none */ }
    relay(req, socket, head, r).catch(() => refuseSocket(socket, 502, 'Bad Gateway'));
    return true;
  }

  async function relay(req, socket, head, r) {
    if (!d.tailnetOk(req)) return refuseSocket(socket, 403, 'Forbidden');
    if (!enabled()) return refuseSocket(socket, 404, 'Not Found');
    const c = cfg();
    if (String(req.method || 'GET') !== 'GET') return refuseSocket(socket, 400, 'Bad Request');
    if (!originOk(req, c)) return refuseSocket(socket, 403, 'Forbidden');
    const p = person(req, c);
    if (p.error) return refuseSocket(socket, p.code, p.code === 401 ? 'Unauthorized' : 'Forbidden');
    const s = ownSession(r.session, p.user);
    if (!s) return refuseSocket(socket, 404, 'Not Found');
    const h = req.headers;
    if (!/(^|,)\s*websocket\s*(,|$)/i.test(String(h.upgrade || '')) || !/upgrade/i.test(String(h.connection || '')) || !h['sec-websocket-key'] || !h['sec-websocket-version']) return refuseSocket(socket, 400, 'Bad Request');
    let tunnelid = '';
    try { tunnelid = new URL(req.url, 'http://x').searchParams.get('id') || ''; } catch { tunnelid = ''; }
    if (!TUNNEL_RE.test(tunnelid)) return refuseSocket(socket, 400, 'Bad Request');
    // At most MAX_RELAYS per session at once (pending or active); nothing is asked of the module for a refused one.
    if ((s.relays || 0) >= MAX_RELAYS) return refuseSocket(socket, 429, 'Too Many Requests');
    s.relays = (s.relays || 0) + 1;
    let slot = true;
    const release = () => { if (slot) { slot = false; s.relays = Math.max(0, (s.relays || 1) - 1); } };
    const fail = (code, reason) => { release(); refuseSocket(socket, code, reason); };
    // Everything is checked again after every await: the person, the module, the session and its owner may have changed meanwhile.
    const still = () => {
      if (socket.destroyed || !enabled()) return false;
      const q = person(req, cfg());
      return !q.error && String(q.user.id) === s.who.id && sessions.get(r.session) === s && live(s);
    };
    try {
      const ep = await endpoint(r.session);
      if (!ep) return fail(502, 'Bad Gateway');
      if (!still()) return fail(404, 'Not Found');
      const conn = await tool('desktop_connect', { session: r.session, tunnelid });
      if (conn.error || typeof conn.query !== 'string' || !/^[\x21-\x7e]+$/.test(conn.query)) return fail(502, 'Bad Gateway');
      if (!still()) return fail(404, 'Not Found');
      return pipeRelay({ req, socket, head, r, s, ep, conn, still, release });
    } catch (e) { release(); throw e; }
  }

  function pipeRelay({ req, socket, head, r, s, ep, conn, still, release }) {
    const h = req.headers;
    const up = tlsConnect({ host: '127.0.0.1', port: ep.port, ca: ep.ca, servername: ep.servername });
    s.sockets.add(socket); s.sockets.add(up);
    let closed = false;
    let headSeen = false;
    let headTimer = null;
    const closeBoth = () => {
      if (closed) return; closed = true;
      release();
      if (headTimer) { try { clearTimer(headTimer); } catch { /* none */ } headTimer = null; }
      s.sockets.delete(socket); s.sockets.delete(up);
      try { socket.destroy(); } catch { /* gone */ }
      try { up.destroy(); } catch { /* gone */ }
    };
    const bad = () => { if (closed) return; try { socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch { /* gone */ } closeBoth(); };
    up.on('error', () => (headSeen ? closeBoth() : bad()));
    socket.on('error', closeBoth);
    socket.on('close', closeBoth);
    up.on('close', () => (headSeen ? closeBoth() : bad()));
    // Only what the contract lists is sent: never the browser's Cookie, Origin, auth or rauth.
    const lines = [`GET /meshrelay.ashx?${conn.query} HTTP/1.1`, `Host: ${ep.servername}:${ep.port}`,
      `Upgrade: ${clean(h.upgrade)}`, `Connection: ${clean(h.connection)}`, `Sec-WebSocket-Key: ${clean(h['sec-websocket-key'])}`, `Sec-WebSocket-Version: ${clean(h['sec-websocket-version'])}`];
    if (h['sec-websocket-extensions']) lines.push(`Sec-WebSocket-Extensions: ${clean(h['sec-websocket-extensions'])}`);
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    headTimer = setTimer(() => { if (!headSeen) bad(); }, HEAD_WAIT_MS);

    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) { if (buf.length > MAX_HEAD) { up.removeListener('data', onData); bad(); } return; }
      up.removeListener('data', onData);
      const headBuf = buf.subarray(0, end + 4);
      const rest = buf.subarray(end + 4);
      const status = Number((headBuf.toString('latin1').match(/^HTTP\/1\.[01] (\d{3})/) || [])[1]);
      if (status !== 101) return bad();
      headSeen = true;
      if (headTimer) { try { clearTimer(headTimer); } catch { /* none */ } headTimer = null; }
      if (!still()) return closeBoth();
      // Not MeshCentral's whole head: only what the websocket handshake needs (a Set-Cookie or any other header never reaches the browser).
      const keep = { upgrade: 'Upgrade', connection: 'Connection', 'sec-websocket-accept': 'Sec-WebSocket-Accept', 'sec-websocket-extensions': 'Sec-WebSocket-Extensions', 'sec-websocket-protocol': 'Sec-WebSocket-Protocol' };
      const out = ['HTTP/1.1 101 Switching Protocols'];
      const seen = new Set();
      for (const line of headBuf.toString('latin1').split('\r\n').slice(1)) {
        const i = line.indexOf(':');
        if (i < 1) continue;
        const k = line.slice(0, i).trim().toLowerCase();
        if (keep[k] && !seen.has(k)) { seen.add(k); out.push(`${keep[k]}: ${clean(line.slice(i + 1).trim())}`); }
      }
      socket.write(`${out.join('\r\n')}\r\n\r\n`);
      if (rest.length) socket.write(rest);
      if (head && head.length) up.write(head);
      socket.pipe(up);
      up.pipe(socket);
    };
    up.on('data', onData);
  }

  function clean(v) { return String(v === undefined ? '' : v).replace(/[\r\n]/g, ' ').slice(0, 512); }

  return { handle, upgrade, sessions, sweep, reconcile, close };
}

function defaultHttpsGet(o) {
  return new Promise((resolve, reject) => {
    const req = require('https').get({ host: o.host, port: o.port, path: o.path, ca: o.ca, servername: o.servername, headers: o.headers, timeout: 15000 }, (res) => {
      const chunks = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > MAX_SCRIPT) { req.destroy(); reject(new Error('too large')); return; } chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

module.exports = { createRemoteDesktop, SCRIPTS, SCRIPT_SHA256, ADDRESS_RE };
