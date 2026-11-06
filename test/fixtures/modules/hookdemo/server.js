'use strict';
// Test MCP stdio server (newline-delimited JSON-RPC): answers hub/receive web calls and sends hub/notify notices.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let n = 0;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

function receive(p) {
  const raw = Buffer.from(String(p.body || ''), 'base64');
  if (p.path === 'link') {
    if (p.method === 'POST') return { status: 200, body: 'linked' };
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<form method="post"><button>Link</button></form>' };
  }
  if (p.path === 'events' && p.method === 'POST') {
    const want = 'sha256=' + crypto.createHmac('sha256', process.env.HOOKDEMO_KEY || '').update(raw).digest('hex');
    if ((p.headers || {})['x-signature'] !== want) return { status: 401, body: 'bad signature' };
    if (raw.toString('utf8') === 'CRASH') process.exit(3);
    n += 1;
    const file = `evt-${n}.txt`;
    fs.writeFileSync(path.join(process.env.CONNECTOR_MEDIA_DIR || '.', file), raw);
    out({ jsonrpc: '2.0', id: 'hub-' + n, method: 'hub/notify', params: { text: `Event ${n} received`, files: [file] } });
    return { status: 200, body: 'ok' };
  }
  return { status: 404, body: 'not found' };
}

function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize': return reply({ protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'hookdemo', version: '1.0.0' } });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: [{ name: 'status', description: 'Reports that the module is running.', inputSchema: { type: 'object', properties: {} } }] });
    case 'tools/call': return reply({ content: [{ type: 'text', text: 'ok' }] });
    case 'hub/receive': return reply(receive(params || {}));
    default: return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found.' } };
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined || msg.id === null || msg.method === undefined) continue;   // notifications and replies from the hub
    out(handle(msg));
  }
});
