'use strict';

/**
 * Hub-tool bridge for codex-cli agents.
 *
 * Claude SDK agents get the hub tools (memory, consult_agent, spawn_workers,
 * jobs, wallet/comms where allowed) as an in-process MCP server. Codex runs
 * as a separate process, so it gets them through a small stdio MCP server
 * (./mcp-bridge.js) that forwards tools/list and tools/call to this module
 * over loopback HTTP.
 *
 * Each turn registers its own tool set under a fresh 256-bit token. The
 * token and the hub URL are written to a 0600 file whose path is the only
 * thing handed to Codex (as an env var of the MCP child), and both are
 * removed when the turn ends. A token resolves only to the tools built for
 * that agent, with the same gating as the SDK path (wallet tools only for
 * wallet agents at depth 0, nothing for delegation inside temporal workers),
 * so the route needs no hub login of its own and grants nothing beyond what
 * the running turn already has.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isConcurrencySafe, createOrderedGate } = require('../tool-concurrency');

const HUB_DIR = path.resolve(__dirname, '..', '..');
const BRIDGE_DIR = path.join(HUB_DIR, 'data', 'codex-bridge');
const ROUTE = '/api/codex-bridge/rpc';
const TOKEN_HEADER = 'x-codex-bridge-token';
const MAX_BODY = 4 * 1024 * 1024;

const sessions = new Map(); // token -> { agentName, tools: Map(name -> {description, shape, handler}), file }

/** A stand-in for the Claude SDK's tool()/createSdkMcpServer() that just collects the definitions. */
const collectingSdk = {
  tool: (name, description, shape, handler, opts) => ({ name, description, shape, handler, opts }),
  createSdkMcpServer: (cfg) => ({ tools: cfg.tools || [] }),
};

function tokenEq(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/**
 * @param {string} agentName
 * @param {Array<{name, description, shape, handler}>} tools
 * @param {{url: string, dir?: string}} opts
 * @returns {{token, file, release()}}
 */
function register(agentName, tools, { url, dir = BRIDGE_DIR, beforeCall = null } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const byName = new Map();
  for (const t of tools || []) if (t && t.name && typeof t.handler === 'function') byName.set(t.name, t);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${crypto.randomBytes(8).toString('hex')}.json`);
  fs.writeFileSync(file, JSON.stringify({ url: url + ROUTE, token }), { mode: 0o600 });
  const entry = { agentName, tools: byName, file, gate: createOrderedGate(), beforeCall };
  sessions.set(token, entry);
  return {
    token,
    file,
    release() {
      sessions.delete(token);
      try { fs.unlinkSync(file); } catch {}
    },
  };
}

function lookup(token) {
  for (const [t, entry] of sessions) if (tokenEq(t, token)) return entry;
  return null;
}

function jsonSchemaOf(shape) {
  const { z } = require('zod');
  try {
    const schema = z.toJSONSchema(z.object(shape || {}));
    delete schema.$schema;
    return schema;
  } catch {
    return { type: 'object', properties: {} };
  }
}

function listTools(entry) {
  return [...entry.tools.values()].map(t => ({
    name: t.name,
    description: t.description || '',
    inputSchema: jsonSchemaOf(t.shape),
    ...(isConcurrencySafe(t.name) ? { annotations: { readOnlyHint: true } } : {}),
  }));
}

function callTool(entry, name, args) {
  const gate = entry.gate || (entry.gate = createOrderedGate());
  return gate.run(name, () => callToolNow(entry, name, args));
}

async function callToolNow(entry, name, args) {
  const t = entry.tools.get(name);
  if (!t) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  const { z } = require('zod');
  const parsed = z.object(t.shape || {}).safeParse(args || {});
  if (!parsed.success) {
    const msg = parsed.error.issues.map(i => `${i.path.join('.') || '(args)'}: ${i.message}`).join('; ');
    return { content: [{ type: 'text', text: `Invalid arguments for ${name}: ${msg}` }], isError: true };
  }
  try {
    // Per-agent tool policy for hub tools called from Codex (the Codex shell is covered by approval requests).
    if (entry.beforeCall) {
      const v = await entry.beforeCall(name, parsed.data);
      if (v && v.allowed === false) return { content: [{ type: 'text', text: v.text || `Denied by policy: ${name}` }], isError: true };
    }
    const out = await t.handler(parsed.data);
    if (out && Array.isArray(out.content)) return out;
    return { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function reply(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

/** POST /api/codex-bridge/rpc  body {method:'list'} | {method:'call', name, arguments} */
async function handle(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { error: 'POST only' });
  const addr = req.socket?.remoteAddress || '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) return reply(res, 403, { error: 'loopback only' });
  const entry = lookup(req.headers[TOKEN_HEADER]);
  if (!entry) return reply(res, 401, { error: 'unknown or expired bridge token' });
  let body;
  try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { return reply(res, 400, { error: `bad request: ${e.message}` }); }
  if (body.method === 'list') return reply(res, 200, { tools: listTools(entry) });
  if (body.method === 'call') return reply(res, 200, await callTool(entry, String(body.name || ''), body.arguments));
  return reply(res, 400, { error: 'method must be list or call' });
}

module.exports = { ROUTE, TOKEN_HEADER, BRIDGE_DIR, collectingSdk, register, handle, listTools, callTool, _sessions: sessions };
