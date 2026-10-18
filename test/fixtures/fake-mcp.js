#!/usr/bin/env node
'use strict';
// A tiny stdio MCP server for tests: two tools; echoes the env it was started with so tests can check hygiene.
// Logs one line to stderr containing the secret, to test redaction.
const readline = require('readline');
const SECRET = process.env.FAKE_TOKEN || '';
process.stderr.write(`fake-mcp starting with token ${SECRET}\n`);
const tools = [
  { name: 'get_record', description: 'Read one record', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, annotations: { readOnlyHint: true } },
  { name: 'send_message', description: 'Send a message', inputSchema: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } } } },
  { name: 'env', description: 'Show the environment keys', inputSchema: { type: 'object', properties: {} } },
];
if (process.env.FAKE_COLLIDE === '1') tools.push({ name: 'get.record', description: 'Collides with get_record once sanitised', inputSchema: { type: 'object', properties: {} } });
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '0' } } });
  if (m.method === 'notifications/initialized') return;
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools } });
  if (m.method === 'tools/call') {
    const { name, arguments: args } = m.params || {};
    let text;
    if (name === 'env') text = JSON.stringify({ keys: Object.keys(process.env).sort(), token: SECRET, id: process.env.CONNECTOR_ID || null, home: process.env.CONNECTOR_DATA_HOME || null });
    else if (name === 'get_record') text = `record ${args && args.id} via ${SECRET ? 'token' : 'no token'}`;
    else if (name === 'send_message') text = `sent to ${args && args.to}`;
    else return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `no tool ${name}` } });
    return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text }] } });
  }
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown method' } });
});
