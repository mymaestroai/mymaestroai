'use strict';
// MCP stdio server (newline-delimited JSON-RPC) for the Google Drive backup copies. Only the hub calls these tools.

const { createDrive } = require('./drive');

const TOOLS = [
  { name: 'backup_put', description: 'Upload a backup file to the My Maestro AI Backups folder.',
    inputSchema: { type: 'object', properties: { file: { type: 'string' }, name: { type: 'string' } }, required: ['file', 'name'] } },
  { name: 'backup_list', description: 'List the backup copies in Google Drive.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'backup_delete', description: 'Permanently delete the backup copies with this name.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'backup_get', description: 'Download a backup copy to a local file.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, out: { type: 'string' } }, required: ['name', 'out'] } },
];

const need = (args, key) => {
  if (typeof args[key] !== 'string' || !args[key]) throw new Error(`"${key}" is required.`);
  return args[key];
};

async function callTool(drive, name, args) {
  args = args && typeof args === 'object' ? args : {};
  switch (name) {
    case 'backup_put': return drive.put(need(args, 'file'), need(args, 'name'));
    case 'backup_list': return { files: (await drive.list()).map((f) => ({ name: f.name, size: f.size, created: f.createdTime })) };
    case 'backup_delete': return { deleted: (await drive.remove(need(args, 'name'))) > 0 };
    case 'backup_get': return drive.get(need(args, 'name'), need(args, 'out'));
    default: throw new Error(`Unknown tool: ${String(name).slice(0, 60)}`);
  }
}

// One JSON-RPC message in -> the reply object, or null for notifications.
async function handle(msg, drive) {
  if (!msg || typeof msg !== 'object') return null;
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (id === undefined || id === null) return null;   // notifications get no reply
  switch (method) {
    case 'initialize':
      return reply({ protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'google-drive', version: '1.0.0' } });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = params && params.name;
      if (!TOOLS.some((t) => t.name === name)) return error(-32602, 'Unknown tool.');
      try {
        const out = await callTool(drive, name, params.arguments);
        return reply({ content: [{ type: 'text', text: JSON.stringify(out) }] });
      } catch (e) {
        return reply({ isError: true, content: [{ type: 'text', text: String((e && e.message) || 'Something went wrong.') }] });
      }
    }
    default: return error(-32601, 'Method not found.');
  }
}

function main() {
  const drive = createDrive({ clientId: process.env.CLIENT_ID, clientSecret: process.env.CLIENT_SECRET, refreshToken: process.env.REFRESH_TOKEN });
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      handle(msg, drive).then((r) => { if (r) process.stdout.write(JSON.stringify(r) + '\n'); });
    }
  });
}

if (require.main === module) main();

module.exports = { handle, TOOLS };
