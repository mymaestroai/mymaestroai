'use strict';

// lib/comms/routes.js: the /api/comms/* HTTP surface. getCommsService() is a
// lazy process-wide singleton, so this file seeds it with test-safe DI options
// (tmp dataDir, a fake Telegram Bot API server) via a file-level `before` hook,
// before routes.handle() ever runs — handle() itself always calls the zero-arg
// getter internally.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const { getCommsService } = require('../lib/comms/service');
const routes = require('../lib/comms/routes');

const FAKE_TOKEN = 'FAKE:not-a-real-token';
const BAD_TOKEN = 'FAKE:bad-token';
const AGENTS = [{ name: 'maestro' }, { name: 'cos' }, { name: 'helper' }];

let dataDir;
let apiServer;
let apiBase;
let svc;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-routes-'));
  apiServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const m = req.url.match(/^\/bot([^/]+)\/(\w+)/);
      const token = m && m[1];
      const method = m && m[2];
      let payload = {};
      try { payload = body ? JSON.parse(body) : {}; } catch { /* ignore */ }
      const ok = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })); };
      const fail = (desc) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, description: desc })); };
      if (method === 'getMe') return token === BAD_TOKEN ? fail('Unauthorized') : ok({ id: 1, username: 'fakebot', is_bot: true });
      if (method === 'getUpdates') return ok([]);
      if (method === 'sendMessage') return ok({ message_id: 1, chat: { id: payload.chat_id }, text: payload.text });
      if (method === 'sendChatAction') return ok(true);
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, description: 'not found' }));
    });
  });
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  apiBase = `http://127.0.0.1:${apiServer.address().port}`;
  svc = getCommsService({ dataDir, apiBase, fetchImpl: global.fetch, now: () => 1700000000000, leadAgent: 'maestro' });
});

after(() => {
  if (svc) svc.stop();
  apiServer.closeAllConnections();
  apiServer.close();
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function jsonResponse(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const deps = { readBody, jsonResponse, getAgents: async () => AGENTS };

function mkReq(method, url, bodyObj) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {};
  if (bodyObj !== undefined) {
    setImmediate(() => {
      req.emit('data', Buffer.from(JSON.stringify(bodyObj)));
      req.emit('end');
    });
  } else {
    setImmediate(() => req.emit('end'));
  }
  return req;
}

function mkRes() {
  return {
    statusCode: undefined,
    headers: undefined,
    body: undefined,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    end(body) { this.body = body; },
  };
}

async function call(pathname, method, url, bodyObj) {
  const req = mkReq(method, url, bodyObj);
  const res = mkRes();
  await routes.handle(pathname, req, res, deps);
  return res;
}

// ── status ───────────────────────────────────────────────────────────────

test('GET /api/comms/status returns 200 and never leaks a raw token', async () => {
  const res = await call('/api/comms/status', 'GET', '/api/comms/status');
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.channels.telegram.tokenSet, false);
  assert.ok(!('token' in body.channels.telegram));
  assert.ok(!res.body.includes(FAKE_TOKEN));
});

// ── token ────────────────────────────────────────────────────────────────

test('POST /api/comms/telegram/token validates against the fake Bot API and sets the token', async () => {
  const res = await call('/api/comms/telegram/token', 'POST', '/api/comms/telegram/token', { token: FAKE_TOKEN });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.body), { ok: true, botUsername: 'fakebot' });
});

test('GET /api/comms/status reflects tokenSet:true and botUsername after a good token, still no raw token', async () => {
  const res = await call('/api/comms/status', 'GET', '/api/comms/status');
  const body = JSON.parse(res.body);
  assert.strictEqual(body.channels.telegram.tokenSet, true);
  assert.strictEqual(body.channels.telegram.botUsername, 'fakebot');
  assert.ok(!res.body.includes(FAKE_TOKEN));
});

test('POST /api/comms/telegram/token returns 400 and leaves the prior token in place when validation fails', async () => {
  const res = await call('/api/comms/telegram/token', 'POST', '/api/comms/telegram/token', { token: BAD_TOKEN });
  assert.strictEqual(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.match(body.error, /Could not validate token/);

  const status = await call('/api/comms/status', 'GET', '/api/comms/status');
  const statusBody = JSON.parse(status.body);
  assert.strictEqual(statusBody.channels.telegram.tokenSet, true);
  assert.strictEqual(statusBody.channels.telegram.botUsername, 'fakebot');
});

// ── config ───────────────────────────────────────────────────────────────

test('POST /api/comms/telegram/config applies a valid patch', async () => {
  const res = await call('/api/comms/telegram/config', 'POST', '/api/comms/telegram/config', {
    agents: ['maestro', 'cos'],
    defaultAgent: 'maestro',
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepStrictEqual(body.agents, ['maestro', 'cos']);
  assert.strictEqual(body.defaultAgent, 'maestro');
});

test('POST /api/comms/telegram/config returns 400 for an unknown agent name', async () => {
  const res = await call('/api/comms/telegram/config', 'POST', '/api/comms/telegram/config', {
    agents: ['nonexistent-agent'],
    defaultAgent: 'nonexistent-agent',
  });
  assert.strictEqual(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.match(body.error, /unknown agent/);
});

test('POST /api/comms/telegram/config enables the channel', async () => {
  const res = await call('/api/comms/telegram/config', 'POST', '/api/comms/telegram/config', { enabled: true });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.enabled, true);
});

// ── senders ──────────────────────────────────────────────────────────────

test('POST /api/comms/telegram/senders adds a sender', async () => {
  const res = await call('/api/comms/telegram/senders', 'POST', '/api/comms/telegram/senders', {
    add: { id: '100', name: 'owner', role: 'owner' },
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(body.senders.some((s) => s.id === '100'));
  assert.ok(body.recipients.some((r) => r.id === '100'));
});

test('POST /api/comms/telegram/senders with neither add nor remove returns 400', async () => {
  const res = await call('/api/comms/telegram/senders', 'POST', '/api/comms/telegram/senders', {});
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(JSON.parse(res.body), { error: 'expected { add } or { remove }' });
});

// ── test-send ────────────────────────────────────────────────────────────

test('POST /api/comms/telegram/test sends to an allow-listed recipient', async () => {
  const res = await call('/api/comms/telegram/test', 'POST', '/api/comms/telegram/test', { to: '100', text: 'hi there' });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.ok, true);
});

test('POST /api/comms/telegram/test returns 400 when the recipient is not allow-listed', async () => {
  const res = await call('/api/comms/telegram/test', 'POST', '/api/comms/telegram/test', { to: 'nobody', text: 'hi' });
  assert.strictEqual(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.match(body.error, /not an allow-listed recipient/);
});

test('POST /api/comms/telegram/senders removes a sender', async () => {
  const res = await call('/api/comms/telegram/senders', 'POST', '/api/comms/telegram/senders', { remove: '100' });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(!body.senders.some((s) => s.id === '100'));
});

// ── audit ────────────────────────────────────────────────────────────────

test('GET /api/comms/audit returns recorded rows and respects limit', async () => {
  const res = await call('/api/comms/audit', 'GET', '/api/comms/audit?limit=1');
  assert.strictEqual(res.statusCode, 200);
  const rows = JSON.parse(res.body);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length <= 1);
  if (rows.length) {
    assert.strictEqual(rows[rows.length - 1].dir, 'out');
  }
});

test('GET /api/comms/audit.csv returns a CSV attachment, not JSON', async () => {
  const res = await call('/api/comms/audit.csv', 'GET', '/api/comms/audit.csv');
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['Content-Type'], 'text/csv');
  assert.strictEqual(res.headers['Content-Disposition'], 'attachment; filename="comms-audit.csv"');
  assert.match(res.body, /^ts,channel,dir,chatId,senderId,senderName,agent,chars,note/);
});

// ── fallthrough ──────────────────────────────────────────────────────────

test('unknown comms path returns 404', async () => {
  const res = await call('/api/comms/nope', 'GET', '/api/comms/nope');
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(JSON.parse(res.body), { error: 'not found' });
});

test('an unexpected throw from the service returns 500 with the error message', async () => {
  const orig = svc.getAudit;
  svc.getAudit = () => { throw new Error('boom'); };
  try {
    const res = await call('/api/comms/audit', 'GET', '/api/comms/audit');
    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(JSON.parse(res.body), { error: 'boom' });
  } finally {
    svc.getAudit = orig;
  }
});
