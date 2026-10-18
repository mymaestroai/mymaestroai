'use strict';

/**
 * http-agent.js — Keep-alive connection pool for LLM Gateway traffic (P0)
 *
 * WHY: lib/gateway-client.js used bare global fetch with no dispatcher.
 * Measured 2026-08-05: every gateway request opened a BRAND NEW TCP
 * connection (4 requests -> 4 connections, isSessionReused=false every
 * time).  Cost per request before the model saw a single token:
 *     DNS ~8ms + TCP ~1100ms + TLSv1.2 handshake ~3745ms  =  5-7s
 * Agents chain 8-11 sequential gateway round trips per user turn, so that
 * is ~35s of pure handshake on a typical turn.
 *
 * WHAT: a bounded undici Agent with keep-alive, applied PER REQUEST via the
 * `dispatcher` fetch option — deliberately NOT setGlobalDispatcher, so MCP
 * skills and other HTTP clients in the process keep their existing behavior.
 * Blast radius = gateway calls only.
 *
 * ALSO (P1): per-request connection telemetry.  Each request carries an
 * x-hub-req-id header; a diagnostics_channel subscriber reads that header
 * off the wire and attributes the socket to the request, so we can report
 * new-vs-reused, ALPN and TLS version from PRODUCTION traffic instead of a
 * bench.
 *
 * ALSO (2026-08-31): network-change detection.  A keep-alive socket is
 * pinned to the interface it was opened on.  When the machine switches VPN
 * (GlobalProtect <-> Cloudflare WARP), sockets bound to the torn-down utun
 * stay in the pool for up to keepAliveTimeout (60s) and are handed to the
 * next request, which fails with a bare "fetch failed".  Measured on this
 * host: 173 connections opened / 110 connection errors = 63.6%.
 *
 * The fix is `recycle()` - ROTATE the agent, do not destroy it.  destroy()
 * aborts in-flight requests and would kill a live agent turn mid-stream.
 * Rotation installs a fresh Agent for all NEW requests and lets the old one
 * drain gracefully via close(), with a hard destroy() backstop.
 *
 * Kill switch:  GATEWAY_KEEPALIVE=0   (falls back to bare global fetch)
 * Watcher off:  GATEWAY_NETWATCH=0
 */

const dc = require('diagnostics_channel');
const os = require('os');
const { execFile } = require('child_process');

// ── Config ──────────────────────────────────────────────────────────────

const ENABLED = process.env.GATEWAY_KEEPALIVE !== '0';
const MAX_CONNECTIONS = int(process.env.GATEWAY_MAX_CONNECTIONS, 16);
const KEEPALIVE_TIMEOUT_MS = int(process.env.GATEWAY_KEEPALIVE_MS, 60000);
const KEEPALIVE_MAX_MS = int(process.env.GATEWAY_KEEPALIVE_MAX_MS, 300000);
// Streaming turns can legitimately run for minutes — never let the pool
// time out a body that is still producing tokens.
const BODY_TIMEOUT_MS = int(process.env.GATEWAY_BODY_TIMEOUT_MS, 0);      // 0 = disabled
const HEADERS_TIMEOUT_MS = int(process.env.GATEWAY_HEADERS_TIMEOUT_MS, 600000);
const CONNECT_TIMEOUT_MS = int(process.env.GATEWAY_CONNECT_TIMEOUT_MS, 20000);

// Network-change watcher
const NETWATCH_ENABLED = process.env.GATEWAY_NETWATCH !== '0';
const NETWATCH_INTERVAL_MS = int(process.env.GATEWAY_NETWATCH_MS, 5000);
// Grace period before the old pool is force-destroyed, so in-flight
// streaming turns on a still-valid socket get a chance to finish.
const DRAIN_GRACE_MS = int(process.env.GATEWAY_DRAIN_GRACE_MS, 90000);

function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

// ── State ───────────────────────────────────────────────────────────────

let agent = null;
let installed = false;
let available = false;

const socketIds = new WeakMap();   // socket -> integer id
let nextSocketId = 1;

// reqId -> { socketId, reused, alpn, tls, remote }
const pending = new Map();
const PENDING_MAX = 500;

// FIFO pairing for beforeConnect -> connected, to time handshakes.
// BOUNDED and self-healing: a stale head (older than the connect timeout)
// can never have a matching `connected` event, so it is discarded rather
// than paired with an unrelated later connect.
const connectStarts = [];
let lastConnectMs = null;
let consecutiveConnectErrors = 0;
const RECYCLE_ON_CONNECT_ERRORS = int(process.env.GATEWAY_RECYCLE_ERR_THRESHOLD, 3);
const RECYCLE_MIN_INTERVAL_MS = int(process.env.GATEWAY_RECYCLE_MIN_MS, 15000);

function takeConnectStart() {
  const deadline = Date.now() - (CONNECT_TIMEOUT_MS + 5000);
  while (connectStarts.length && connectStarts[0] < deadline) connectStarts.shift();
  const started = connectStarts.shift();
  if (started === undefined) return null;
  const ms = Date.now() - started;
  // Sanity clamp - anything past the connect timeout is a mispairing.
  return ms >= 0 && ms <= CONNECT_TIMEOUT_MS + 5000 ? ms : null;
}

// Reactive safety net: if the watcher misses a route change (or the tunnel
// dies without an interface-level change), a burst of connect failures is
// itself evidence the pool is pointed at something dead.
function onConnectError() {
  consecutiveConnectErrors++;
  if (consecutiveConnectErrors < RECYCLE_ON_CONNECT_ERRORS) return;
  if (Date.now() - lastRecycleAt < RECYCLE_MIN_INTERVAL_MS) return;
  consecutiveConnectErrors = 0;
  recycle(`${RECYCLE_ON_CONNECT_ERRORS} consecutive connect errors`);
}

const counters = {
  requests: 0,
  connectionsOpened: 0,
  connectionErrors: 0,
  reusedHits: 0,
  newHits: 0,
  disconnects: 0,
  recycles: 0,
};

// Network-change state
let netWatchTimer = null;
let lastFingerprint = null;
let lastRecycleAt = 0;
let lastRecycleReason = null;
const draining = new Set();   // old Agents still being closed

// ── Init ────────────────────────────────────────────────────────────────

function init() {
  if (installed) return { enabled: available };
  installed = true;

  if (!ENABLED) {
    console.log('[http-agent] keep-alive DISABLED via GATEWAY_KEEPALIVE=0 — using bare global fetch');
    return { enabled: false };
  }

  let Agent;
  try {
    ({ Agent } = require('undici'));
  } catch (e) {
    console.warn('[http-agent] undici unavailable, falling back to bare fetch:', e.message);
    return { enabled: false };
  }

  AgentCtor = Agent;

  try {
    agent = makeAgent();
    available = true;
    subscribe();
    console.log(`[http-agent] keep-alive pool active (connections=${MAX_CONNECTIONS}, keepAlive=${KEEPALIVE_TIMEOUT_MS}ms)`);
    startNetWatch();
  } catch (e) {
    console.warn('[http-agent] failed to create Agent, falling back to bare fetch:', e.message);
    agent = null;
    available = false;
  }

  return { enabled: available };
}

let AgentCtor = null;

function makeAgent() {
  return new AgentCtor({
    connections: MAX_CONNECTIONS,
    keepAliveTimeout: KEEPALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: KEEPALIVE_MAX_MS,
    headersTimeout: HEADERS_TIMEOUT_MS,
    bodyTimeout: BODY_TIMEOUT_MS,
    connect: { timeout: CONNECT_TIMEOUT_MS },
    // pipelining 1 = one in-flight request per socket, but the socket is
    // kept warm and reused.  Do NOT raise this - head-of-line blocking on
    // long streaming responses would make things worse, not better.
    pipelining: 1,
  });
}

// ── Network-change detection & pool rotation ────────────────────────────

/**
 * Fingerprint of everything that can invalidate a pooled socket:
 *   - which interface owns the default route, and via which gateway
 *   - the set of up, non-internal interfaces and their addresses
 * A VPN connect/disconnect changes both.  Read cheaply from os + `route`.
 */
async function fingerprint() {
  const ifaces = [];
  const all = os.networkInterfaces();
  for (const name of Object.keys(all).sort()) {
    for (const a of all[name] || []) {
      if (a.internal) continue;
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      ifaces.push(`${name}=${a.address}`);
    }
  }
  const def = await defaultRoute();
  return `${def}|${ifaces.join(',')}`;
}

function defaultRoute() {
  return new Promise((resolve) => {
    try {
      // Linux: `ip route show default` ("default via <gw> dev <iface> ..."); macOS/BSD: `route -n get default`.
      const linux = process.platform === 'linux';
      const [cmd, args] = linux ? ['ip', ['route', 'show', 'default']] : ['route', ['-n', 'get', 'default']];
      execFile(cmd, args, { timeout: 4000 }, (err, stdout) => {
        if (err || !stdout) return resolve('route:?');
        const text = linux ? stdout.trim().split('\n')[0] : stdout;   // first default route = the preferred one
        const iface = (text.match(linux ? /\bdev\s+(\S+)/ : /interface:\s*(\S+)/) || [])[1] || '?';
        const gw = (text.match(linux ? /\bvia\s+(\S+)/ : /gateway:\s*(\S+)/) || [])[1] || '?';
        resolve(`route:${iface}/${gw}`);
      });
    } catch (_) { resolve('route:?'); }
  });
}

/**
 * Rotate the pool.  Deliberately NOT agent.destroy() - that aborts every
 * in-flight request and would kill a streaming agent turn mid-sentence.
 * Instead: swap in a fresh Agent for all new requests, then close() the old
 * one (waits for in-flight to finish), with a destroy() backstop after
 * DRAIN_GRACE_MS in case a stream is wedged on a dead socket.
 */
function recycle(reason) {
  if (!available || !agent) return false;
  const old = agent;
  try {
    agent = makeAgent();
  } catch (e) {
    console.warn(`[http-agent] recycle failed to build new Agent (${e.message}) - keeping existing pool`);
    return false;
  }

  counters.recycles++;
  lastRecycleAt = Date.now();
  lastRecycleReason = reason;
  console.log(`[http-agent] pool RECYCLED (${reason}) - new requests use a fresh connection pool, old pool draining`);

  draining.add(old);
  let settled = false;
  const backstop = setTimeout(() => {
    if (settled) return;
    settled = true;
    console.log('[http-agent] old pool did not drain in time - destroying');
    Promise.resolve(old.destroy()).catch(() => {}).finally(() => draining.delete(old));
  }, DRAIN_GRACE_MS);
  if (backstop.unref) backstop.unref();

  Promise.resolve(old.close())
    .catch(() => { try { return old.destroy(); } catch (_) { /* ignore */ } })
    .finally(() => {
      if (settled) return;
      settled = true;
      clearTimeout(backstop);
      draining.delete(old);
    });

  return true;
}

function startNetWatch() {
  if (!NETWATCH_ENABLED || netWatchTimer) return;
  fingerprint().then((fp) => { lastFingerprint = fp; }).catch(() => {});

  netWatchTimer = setInterval(() => {
    fingerprint().then((fp) => {
      if (lastFingerprint === null) { lastFingerprint = fp; return; }
      if (fp === lastFingerprint) return;
      const prev = lastFingerprint;
      lastFingerprint = fp;
      console.log(`[http-agent] network change detected\n    was: ${prev}\n    now: ${fp}`);
      recycle('network change');
    }).catch(() => {});
  }, NETWATCH_INTERVAL_MS);
  if (netWatchTimer.unref) netWatchTimer.unref();
  console.log(`[http-agent] network watcher active (every ${NETWATCH_INTERVAL_MS}ms) - pool rotates on VPN/route change`);
}

function stopNetWatch() {
  if (netWatchTimer) { clearInterval(netWatchTimer); netWatchTimer = null; }
}

// ── diagnostics_channel instrumentation ─────────────────────────────────

function sub(name, fn) {
  try {
    dc.subscribe(name, (msg) => { try { fn(msg); } catch (_) { /* never break a turn */ } });
  } catch (_) { /* channel not present on this node version */ }
}

function subscribe() {
  sub('undici:client:beforeConnect', () => {
    connectStarts.push(Date.now());
    if (connectStarts.length > MAX_CONNECTIONS * 2) connectStarts.shift();
  });

  sub('undici:client:connected', (msg) => {
    counters.connectionsOpened++;
    lastConnectMs = takeConnectStart();
    const socket = msg && msg.socket;
    if (socket && !socketIds.has(socket)) socketIds.set(socket, nextSocketId++);
    consecutiveConnectErrors = 0;
  });

  // A failed connect never produces a `connected` event, so its
  // beforeConnect timestamp would sit in the queue forever and skew every
  // later pairing (this is the source of the absurd 131,163,659ms
  // connect_ms values in telemetry).  Drop one entry per failure.
  sub('undici:client:connectError', () => {
    counters.connectionErrors++;
    takeConnectStart();
    onConnectError();
  });
  sub('undici:client:connectionError', () => {
    counters.connectionErrors++;
    onConnectError();
  });

  // Fires as headers hit the wire — the only place we can see BOTH our
  // correlation header and the socket that carried it.
  sub('undici:client:sendHeaders', (msg) => {
    const socket = msg && msg.socket;
    if (!socket) return;
    const reqId = extractReqId(msg.headers);
    if (!reqId) return;

    let id = socketIds.get(socket);
    let isNew = false;
    if (id === undefined) {
      id = nextSocketId++;
      socketIds.set(socket, id);
      isNew = true;
    }

    // A socket we have already carried a request on = genuine reuse.
    const seen = socketReqCount.get(socket) || 0;
    socketReqCount.set(socket, seen + 1);
    const reused = seen > 0 && !isNew;

    if (reused) counters.reusedHits++; else counters.newHits++;

    if (pending.size > PENDING_MAX) pending.clear();
    pending.set(reqId, {
      socketId: id,
      reused,
      alpn: safe(() => socket.alpnProtocol) || null,
      tls: safe(() => (typeof socket.getProtocol === 'function' ? socket.getProtocol() : null)),
      sessionReused: safe(() => (typeof socket.isSessionReused === 'function' ? socket.isSessionReused() : null)),
      connectMs: reused ? 0 : lastConnectMs,
      at: Date.now(),
    });
  });

  sub('undici:client:disconnected', () => { counters.disconnects++; });
}

const socketReqCount = new WeakMap();

function safe(fn) { try { return fn(); } catch (_) { return null; } }

function extractReqId(headers) {
  if (!headers) return null;
  // HTTP/1.1: headers is a raw string blob.  h2: array or object.
  if (typeof headers === 'string') {
    const m = /x-hub-req-id:\s*([A-Za-z0-9_-]+)/i.exec(headers);
    return m ? m[1] : null;
  }
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length - 1; i++) {
      if (String(headers[i]).toLowerCase() === 'x-hub-req-id') return String(headers[i + 1]);
    }
    return null;
  }
  if (typeof headers === 'object') {
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'x-hub-req-id') return String(headers[k]);
    }
  }
  return null;
}

// ── Public API ──────────────────────────────────────────────────────────

let reqSeq = 0;
function newRequestId() {
  reqSeq = (reqSeq + 1) % 1000000;
  return `h${Date.now().toString(36)}${reqSeq.toString(36)}`;
}

/** Fetch options to merge in: dispatcher (if enabled) — caller adds the header. */
function dispatcherOption() {
  if (!installed) init();
  return available && agent ? { dispatcher: agent } : {};
}

/** Pull (and clear) the connection info recorded for a request id. */
function takeConnInfo(reqId) {
  if (!reqId) return null;
  const info = pending.get(reqId);
  if (info) pending.delete(reqId);
  // Opportunistic prune of anything stranded (request never reached the wire)
  if (pending.size > 100) {
    const cutoff = Date.now() - 120000;
    for (const [k, v] of pending) if (v.at < cutoff) pending.delete(k);
  }
  return info || null;
}

function noteRequest() { counters.requests++; }

function stats() {
  return {
    enabled: available,
    config: {
      connections: MAX_CONNECTIONS,
      keepAliveTimeoutMs: KEEPALIVE_TIMEOUT_MS,
      keepAliveMaxMs: KEEPALIVE_MAX_MS,
    },
    ...counters,
    reusePct: counters.reusedHits + counters.newHits
      ? +(100 * counters.reusedHits / (counters.reusedHits + counters.newHits)).toFixed(1)
      : null,
    pendingTracked: pending.size,
    netWatch: {
      enabled: NETWATCH_ENABLED && !!netWatchTimer,
      intervalMs: NETWATCH_INTERVAL_MS,
      fingerprint: lastFingerprint,
      lastRecycleAt: lastRecycleAt || null,
      lastRecycleReason,
      draining: draining.size,
    },
  };
}

async function close() {
  stopNetWatch();
  try { if (agent) await agent.close(); } catch (_) { /* ignore */ }
  for (const old of draining) { try { await old.destroy(); } catch (_) { /* ignore */ } }
  draining.clear();
}

module.exports = {
  init,
  dispatcherOption,
  newRequestId,
  takeConnInfo,
  noteRequest,
  stats,
  close,
  // network-change handling (also used by scripts/net/gateway-diag.js)
  recycle,
  fingerprint,
  startNetWatch,
  stopNetWatch,
  get enabled() { return available; },
};
