#!/usr/bin/env node
'use strict';
// Stub backup server: keeps files in $FAKEBACKUP_HOME/store. backup_put honours args.delayMs to imitate a slow upload.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const store = path.join(process.env.FAKEBACKUP_HOME || process.env.HOME, 'store');
fs.mkdirSync(store, { recursive: true });
const names = ['peek', 'usage', 'backup_put', 'backup_list', 'backup_delete', 'backup_get'];
const tools = names.map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }));
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const ok = (id, o) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(o) }] } });
const bad = (id, text) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } });
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const safe = (n) => typeof n === 'string' && /^[\w.-]+$/.test(n) && n !== '.' && n !== '..';
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fakebackup', version: '0' } } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools } });
  if (m.method === 'tools/call') {
    const { name, arguments: a = {} } = m.params || {};
    try {
      if (name === 'usage') return ok(m.id, { bytes: fs.readdirSync(store).reduce((n, f) => n + fs.statSync(path.join(store, f)).size, 0) });
      if (name === 'peek') return ok(m.id, { files: fs.readdirSync(store).length });
      if (name === 'backup_put') {
        if (!safe(a.name)) return bad(m.id, 'That backup name is not allowed.');
        let data; try { data = fs.readFileSync(a.file); } catch { return bad(m.id, 'Cannot read the file to upload.'); }
        return setTimeout(() => { fs.writeFileSync(path.join(store, a.name), data); ok(m.id, { name: a.name, size: data.length, md5: md5(data) }); }, Number(a.delayMs) || 0);
      }
      if (name === 'backup_list') return ok(m.id, { files: fs.readdirSync(store).sort().map(n => { const s = fs.statSync(path.join(store, n)); return { name: n, size: s.size, created: s.birthtime.toISOString() }; }), argKeys: Object.keys(a), hubEnv: process.env.MYMAESTRO_HUB_SECRET !== undefined });
      if (name === 'backup_delete') {
        if (!safe(a.name) || !fs.existsSync(path.join(store, a.name))) return bad(m.id, 'No such backup.');
        fs.unlinkSync(path.join(store, a.name)); return ok(m.id, { deleted: a.name });
      }
      if (name === 'backup_get') {
        if (!safe(a.name) || !fs.existsSync(path.join(store, a.name))) return bad(m.id, 'No such backup.');
        const data = fs.readFileSync(path.join(store, a.name)); fs.writeFileSync(a.out, data);
        return ok(m.id, { size: data.length, md5: md5(data) });
      }
      return bad(m.id, 'unknown tool');
    } catch (e) { return bad(m.id, e.message); }
  }
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown' } });
});
