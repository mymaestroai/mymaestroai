#!/usr/bin/env node
'use strict';
// A tiny JSON-RPC stdio server for tests: answers initialize, tools/list (one tool) and 'echo/back' (returns its params);
// exits with code 3 on 'die'.
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stdio-echo', version: '0' } } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'one', description: 'The only tool', inputSchema: { type: 'object', properties: {} } }] } });
  if (m.method === 'echo/back') return send({ jsonrpc: '2.0', id: m.id, result: { params: m.params === undefined ? null : m.params } });
  if (m.method === 'die') process.exit(3);
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown method' } });
});
