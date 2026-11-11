'use strict';
// A small client for MeshCentral's control channel (wss://.../control.ashx). The message shapes are those of workspaces/maestro/connectors/d/mesh-api.md.
const crypto = require('node:crypto');

const MAX_PAYLOAD = 16 * 1024 * 1024;
const MAX_STRING = 12 * 1024 * 1024;
const READY_MS = 20000;
const PING_MS = 20000, PONG_MS = 10000;   // keepalive: a ping every 20 s, the socket is dropped when no pong comes within 10 s

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const oneLine = (s, n = 200) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);

class MeshError extends Error {
  constructor(message, code) { super(message); this.name = 'MeshError'; if (code) this.code = code; }
}

/**
 * matchReply(action, req, frame) -> null (the frame is not the reply to this request) or
 *   { ok: true, reply: frame } or { ok: false, error: <text>, reply: frame }.
 * action: the request's action (or its `kind`); req: the frame that was sent (with responseid, and tag / nodeid / reply / name where used).
 */
function matchReply(action, req, frame) {
  if (!frame || typeof frame !== 'object' || !req) return null;
  const rid = req.responseid;
  const text = (v, dflt) => oneLine(typeof v === 'string' && v ? v : dflt);
  switch (action) {
    case 'runcommands':
      // reply:true -> the output arrives as {action:'msg', type:'runcommands', responseid, result:<output>}; an error is {action:'runcommands', responseid, result}.
      if (req.reply === true) {
        if (frame.action === 'msg' && frame.type === 'runcommands' && frame.responseid === rid) return { ok: true, reply: frame };
        if (frame.action === 'runcommands' && frame.responseid === rid) return { ok: false, error: text(frame.result, 'The command was refused.'), reply: frame };
        return null;
      }
      if (frame.action !== 'runcommands' || frame.responseid !== rid) return null;
      return frame.result === 'OK' ? { ok: true, reply: frame } : { ok: false, error: text(frame.result, 'The command was refused.'), reply: frame };
    case 'getsysinfo':   // no responseid in the answer; the tag is echoed
      if (frame.action !== 'getsysinfo' || frame.tag !== req.tag) return null;
      return frame.noinfo || typeof frame.result === 'string' ? { ok: false, error: text(frame.result, 'No information.'), reply: frame } : { ok: true, reply: frame };
    case 'addmeshuser':   // result is a message list, not 'ok': success is success > 0
      if (frame.action !== 'addmeshuser' || frame.responseid !== rid) return null;
      return Number(frame.success) > 0 ? { ok: true, reply: frame } : { ok: false, error: text(frame.result, 'The user was not added.'), reply: frame };
    case 'createLoginToken':   // the success reply has no responseid (matched by name); an error carries it
      if (frame.action !== 'createLoginToken') return null;
      if (frame.responseid === rid && typeof frame.result === 'string') return { ok: false, error: text(frame.result, 'Refused.'), reply: frame };
      if (frame.responseid === undefined && frame.name === req.name && typeof frame.tokenUser === 'string') return { ok: true, reply: frame };
      return null;
    default:   // action + responseid; a text result other than ok/OK is an error
      if (frame.action !== action || frame.responseid !== rid) return null;
      if (typeof frame.result === 'string' && frame.result.toLowerCase() !== 'ok') return { ok: false, error: text(frame.result, 'Refused.'), reply: frame };
      return { ok: true, reply: frame };
  }
}

function createMeshClient({ url, ca, servername, user, pass, WebSocket, timeoutMs = 30000, readyMs = READY_MS, pingMs = PING_MS, pongMs = PONG_MS, log = () => {} } = {}) {
  if (!url || !user || !pass || typeof WebSocket !== 'function') throw new Error('createMeshClient needs url, user, pass and WebSocket');
  let ws = null, readyP = null;
  const pending = new Map();   // id -> { req, action, sock, sent, resolve, reject, timer }
  const retired = new WeakSet();   // sockets that are given up: nothing they say is believed any more

  // Fails the requests that were sent on one socket (or all of them). Each gets its own error, marked sent: true because the request already went out.
  function failSock(sock, err) {
    for (const [id, p] of pending) {
      if (sock && p.sock !== sock) continue;
      clearTimeout(p.timer); pending.delete(id);
      p.reject(Object.assign(new MeshError(err.message, err.code), { sent: p.sent === true }));
    }
  }
  // A socket that went silent: closed hard, its requests failed, its late frames ignored.
  function retire(sock, err) {
    retired.add(sock);
    if (ws === sock) { ws = null; readyP = null; }
    try { if (typeof sock.terminate === 'function') sock.terminate(); else sock.close(); } catch { /* closed */ }
    failSock(sock, err);
  }

  function onFrame(frame) {
    for (const [id, p] of pending) {
      const m = matchReply(p.action, p.req, frame);
      if (!m) continue;
      pending.delete(id); clearTimeout(p.timer);
      if (m.ok) {
        const big = typeof frame.result === 'string' && frame.result.length > MAX_STRING;
        if (big) p.reject(Object.assign(new MeshError('The reply is too large.', 'ETOOBIG'), { sent: true })); else p.resolve(m.reply);
      } else p.reject(Object.assign(new MeshError(m.error, 'EMESH'), { sent: true }));
      return;
    }
  }

  function connect() {
    if (readyP) return readyP;
    const sock = new WebSocket(url, {
      headers: { 'x-meshauth': `${b64(user)},${b64(pass)}` },
      ca, servername, rejectUnauthorized: true, maxPayload: MAX_PAYLOAD,
    });
    ws = sock;
    let settled = false, timer = null;
    const p = new Promise((resolve, reject) => {
      const settle = (err) => { if (settled) return; settled = true; clearTimeout(timer); if (err) reject(err); else resolve(); };
      timer = setTimeout(() => {
        const e = new MeshError(`The server did not log in within ${Math.round(readyMs / 1000)} seconds.`, 'ETIMEDOUT');
        e.login = true;   // nothing was sent: not a command that got no answer
        settle(e);
        try { sock.terminate ? sock.terminate() : sock.close(); } catch { /* closed */ }
      }, readyMs);
      sock.on('message', (data, isBinary) => {
        if (isBinary === true || retired.has(sock)) return;
        let text;
        try { text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8'); } catch { return; }
        if (text.length > MAX_PAYLOAD) return;
        let frame;
        try { frame = JSON.parse(text); } catch { return; }
        if (!frame || typeof frame !== 'object') return;
        if (frame.action === 'userinfo') { if (!settled) startKeepalive(sock); settle(null); return; }
        if (frame.action === 'close') {
          if (!settled) settle(new MeshError(`The server refused the login (${oneLine(frame.cause || 'closed', 60)}${frame.msg ? `: ${oneLine(frame.msg, 100)}` : ''}).`, 'EAUTH'));
          return;
        }
        if (settled) onFrame(frame);
      });
      sock.on('error', (e) => { settle(new MeshError(`Could not reach the server (${oneLine((e && (e.code || e.message)) || 'error', 100)}).`, (e && e.code) || 'ECONN')); });
      sock.on('close', () => {
        settle(new MeshError('The connection closed before the login finished.', 'ECLOSED'));
        if (ws === sock) { ws = null; readyP = null; }
        failSock(sock, new MeshError('The connection to the server closed.', 'ECLOSED'));   // only this socket's requests: a late close of an older one must not fail the new one's
      });
    });
    readyP = p;
    p.catch(() => { if (readyP === p) readyP = null; if (ws === sock) { ws = null; try { sock.terminate ? sock.terminate() : sock.close(); } catch { /* closed */ } } });
    return p;
  }

  // ws ping/pong: a socket that stops answering (a sleeping network, a dead peer) is dropped, so its requests fail at once and the next one reconnects.
  function startKeepalive(sock) {
    if (typeof sock.ping !== 'function') return;
    let pongTimer = null;
    const ping = setInterval(() => {
      if (retired.has(sock) || ws !== sock) { clearInterval(ping); clearTimeout(pongTimer); return; }
      if (pongTimer) return;
      try { sock.ping(); } catch { retire(sock, new MeshError('The connection to the server closed.', 'ECLOSED')); return; }
      pongTimer = setTimeout(() => { pongTimer = null; log('the server did not answer a ping; dropping the connection'); retire(sock, new MeshError('The server stopped answering.', 'ECLOSED')); }, pongMs);
      if (pongTimer.unref) pongTimer.unref();
    }, pingMs);
    if (ping.unref) ping.unref();
    if (typeof sock.on === 'function') {
      sock.on('pong', () => { clearTimeout(pongTimer); pongTimer = null; });
      sock.on('close', () => { clearInterval(ping); clearTimeout(pongTimer); pongTimer = null; });
    }
  }

  const ready = () => connect();

  // err.sent tells the caller whether the request had already gone out when it failed: false (before sock.send, nothing reached the server) or true (after it).
  async function send(action, fields, opts) {
    try { await connect(); } catch (e) { if (e && typeof e === 'object') e.sent = false; throw e; }
    const sock = ws;
    if (!sock) throw Object.assign(new MeshError('The connection to the server closed.', 'ECLOSED'), { sent: false });
    const responseid = crypto.randomUUID();
    const req = { ...fields, action, responseid };
    if (action === 'getsysinfo' && req.tag === undefined) req.tag = crypto.randomUUID();
    if (action === 'runcommands' && req.reply === undefined) req.reply = true;
    const kind = (opts && opts.kind) || action;
    let ms = (opts && opts.timeoutMs) || timeoutMs;
    // The caller's last check, run here: after the connection is ready and with nothing awaited before sock.send. It throws to stop the send (nothing
    // was sent: err.sent is false) and may return a smaller wait in ms (the time the call has left).
    if (opts && typeof opts.beforeSend === 'function') {
      try {
        const left = opts.beforeSend();
        if (typeof left === 'number' && Number.isFinite(left) && left > 0) ms = Math.min(ms, left);
      } catch (e) {
        throw e && typeof e === 'object' ? Object.assign(e, { sent: false }) : Object.assign(new MeshError('The request was not sent.', 'ECANCEL'), { sent: false });
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(responseid);
        reject(Object.assign(new MeshError(`${action} timed out after ${Math.round(ms / 1000)} s.`, 'ETIMEDOUT'), { sent: true, waitMs: ms }));   // waitMs: the wait that really applied (after the caller's deadline clamp)
      }, ms);
      const entry = { req, action: kind, sock, sent: false, resolve, reject, timer };
      pending.set(responseid, entry);
      try { sock.send(JSON.stringify(req)); entry.sent = true; } catch (e) { clearTimeout(timer); pending.delete(responseid); reject(Object.assign(new MeshError(`Could not send (${oneLine(e && e.message, 80)}).`, 'ECLOSED'), { sent: false })); }
    });
  }

  // request(action, fields, { timeoutMs, kind }) -> the reply frame; rejects with MeshError (code ETIMEDOUT / ECLOSED / EAUTH / EMESH / ETOOBIG)
  // and err.sent (true when the request had already been sent).
  function request(action, fields = {}, opts = {}) {
    if (typeof action !== 'string' || !action) return Promise.reject(new MeshError('An action is needed.', 'EBADARG'));
    return send(action, fields, opts);
  }

  function close() {
    const sock = ws;
    ws = null; readyP = null;
    if (sock) retired.add(sock);
    failSock(null, new MeshError('The connection was closed.', 'ECLOSED'));
    if (sock) { try { sock.close(); } catch { /* closed */ } }
  }

  return { ready, request, close, isOpen: () => !!ws };
}

module.exports = { createMeshClient, matchReply, b64, MeshError, MAX_PAYLOAD, MAX_STRING };
