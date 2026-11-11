'use strict';
// Tiny MCP stdio server: answers initialize, tools/list and hub/receive; on a 'ping' call it sends the hub
// hub/notify and hub/other requests and finishes the call with what the guard answered.
let buf = '', callId = null; const got = {};
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'guarddemo', version: '1' } } });
    else if (m.method === 'tools/list') out({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }] } });
    else if (m.method === 'hub/receive') out({ jsonrpc: '2.0', id: m.id, result: { status: 200, body: 'ok' } });
    else if (m.method === 'tools/call') {
      callId = m.id;
      out({ jsonrpc: '2.0', id: 'hub-1', method: 'hub/notify', params: { text: 'hi' } });
      out({ jsonrpc: '2.0', id: 'hub-2', method: 'hub/other' });
    } else if (m.method === undefined && m.id != null) {
      got[m.id] = m.result || m.error;
      if (got['hub-2']) out({ jsonrpc: '2.0', id: callId, result: { content: [{ type: 'text', text: JSON.stringify(got) }] } });
    }
  }
});
