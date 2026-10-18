#!/usr/bin/env node
'use strict';
const readline = require('readline');
const tools = ['get_price', 'place_order', 'whoami', 'delete_everything', 'brand_new_tool'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }));
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fakebank', version: '0' } } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools } });
  if (m.method === 'tools/call') {
    const { name, arguments: a } = m.params || {};
    let text;
    if (name === 'whoami') text = JSON.stringify({ token: process.env.FAKEBANK_TOKEN || null, home: process.env.FAKEBANK_HOME || null, mode: process.env.FAKEBANK_MODE || null, homeEnv: process.env.HOME });
    else if (name === 'get_price') text = JSON.stringify({ price: 100 });
    else if (name === 'place_order' && a && a.fail) return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'exchange rejected the order' }], isError: true } });
    else if (name === 'place_order') text = JSON.stringify({ placed: a, pid: process.pid });
    else text = 'ran ' + name;
    return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text }] } });
  }
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown' } });
});
