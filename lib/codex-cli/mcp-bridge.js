#!/usr/bin/env node
'use strict';

/**
 * Stdio MCP server that Codex launches for a codex-cli hub agent. It exposes
 * the agent's hub tools by forwarding tools/list and tools/call to the hub
 * (see ./bridge.js). The only input is HUB_CODEX_BRIDGE_FILE: a per-turn 0600
 * file holding the hub URL and the turn's bridge token.
 */

const fs = require('fs');
const http = require('http');
const readline = require('readline');
const { createOrderedGate } = require('../tool-concurrency');

const PROTOCOL_VERSION = '2024-11-05';

// Codex is told it may call this server's tools in parallel; unsafe tools still run alone, in arrival order.
const gate = createOrderedGate();

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function logErr(...a) { process.stderr.write('[codex-hub-mcp] ' + a.join(' ') + '\n'); }

function readBridge() {
  const file = process.env.HUB_CODEX_BRIDGE_FILE;
  if (!file) throw new Error('HUB_CODEX_BRIDGE_FILE is not set');
  const { url, token } = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!url || !token) throw new Error('bridge file is incomplete');
  return { url, token };
}

function rpc(body) {
  return new Promise((resolve, reject) => {
    let bridge;
    try { bridge = readBridge(); } catch (e) { reject(new Error(`Hub bridge unavailable (${e.message}); the turn may have ended.`)); return; }
    const u = new URL(bridge.url);
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'x-codex-bridge-token': bridge.token },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { reject(new Error(`Hub bridge returned HTTP ${res.statusCode}`)); return; }
        if (res.statusCode !== 200) reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
        else resolve(parsed);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function onMessage(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notifications (initialized, cancelled) need no reply
  try {
    switch (method) {
      case 'initialize':
        return send({ jsonrpc: '2.0', id, result: {
          protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-hub', version: '1.0.0' },
          instructions: 'My Maestro AI tools: memory, shared memory, agent consultation, temporary workers and detached jobs.',
        } });
      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} });
      case 'tools/list': {
        const { tools } = await rpc({ method: 'list' });
        return send({ jsonrpc: '2.0', id, result: { tools } });
      }
      case 'tools/call': {
        const result = await gate.run(params?.name, () => rpc({ method: 'call', name: params?.name, arguments: params?.arguments || {} }));
        return send({ jsonrpc: '2.0', id, result });
      }
      default:
        return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e) {
    if (method === 'tools/call') {
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } });
    }
    logErr(method, e.message);
    return send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch { return; }
  onMessage(msg);
});
rl.on('close', () => process.exit(0));
