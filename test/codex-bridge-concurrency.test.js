'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const bridge = require('../lib/codex-cli/bridge');
const codexCli = require('../lib/codex-cli');
const appServer = require('../lib/codex-cli/app-server');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function recorder() {
  const rec = { live: 0, peak: 0, log: [] };
  const handler = (label, ms) => async () => {
    rec.log.push('+' + label); rec.live++; rec.peak = Math.max(rec.peak, rec.live);
    await sleep(ms);
    rec.live--; rec.log.push('-' + label);
    return { content: [{ type: 'text', text: label }] };
  };
  return { rec, handler };
}

function session(tools) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
  const reg = bridge.register('zz_bridge', tools, { url: 'http://127.0.0.1:1', dir });
  return { entry: bridge._sessions.get(reg.token), reg, dir };
}

test('tools/list marks exactly the concurrency-safe tools readOnlyHint', () => {
  const { handler } = recorder();
  const names = ['consult_agent', 'read_memory', 'write_memory', 'ask_user'];
  const { entry, reg, dir } = session(names.map(n => ({ name: n, description: n, shape: {}, handler: handler(n, 1) })));
  const listed = Object.fromEntries(bridge.listTools(entry).map(t => [t.name, t]));
  assert.deepStrictEqual(listed.consult_agent.annotations, { readOnlyHint: true });
  assert.deepStrictEqual(listed.read_memory.annotations, { readOnlyHint: true });
  assert.strictEqual(listed.write_memory.annotations, undefined);
  assert.strictEqual(listed.ask_user.annotations, undefined);
  reg.release(); fs.rmSync(dir, { recursive: true, force: true });
});

test('concurrent tools/call: safe tools overlap, unsafe tools run one at a time', async () => {
  const { rec, handler } = recorder();
  const { entry, reg, dir } = session([
    { name: 'consult_agent', description: '', shape: {}, handler: handler('s', 60) },
    { name: 'write_memory', description: '', shape: {}, handler: handler('w', 60) },
  ]);
  const t0 = Date.now();
  await Promise.all([bridge.callTool(entry, 'consult_agent', {}), bridge.callTool(entry, 'consult_agent', {})]);
  assert.strictEqual(rec.peak, 2);
  assert.ok(Date.now() - t0 < 110, 'two safe calls took about one');
  rec.peak = 0; rec.log.length = 0;
  await Promise.all([bridge.callTool(entry, 'write_memory', {}), bridge.callTool(entry, 'write_memory', {})]);
  assert.strictEqual(rec.peak, 1);
  assert.deepStrictEqual(rec.log, ['+w', '-w', '+w', '-w']);
  reg.release(); fs.rmSync(dir, { recursive: true, force: true });
});

test('Codex is told to call the hub server in parallel on both launch paths', () => {
  const args = codexCli.buildArgs({ bridge: { file: '/tmp/x' }, nodePath: 'node' });
  assert.ok(args.includes('mcp_servers.agent-hub.supports_parallel_tool_calls=true'));
  const p = appServer.threadParams({ bridge: { file: '/tmp/x' }, nodePath: 'node' });
  assert.strictEqual(p.config.mcp_servers['agent-hub'].supports_parallel_tool_calls, true);
});

test('the stdio MCP bridge keeps safe calls concurrent and unsafe calls ordered end to end', async () => {
  const seen = { live: 0, peak: 0, log: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      const { name } = JSON.parse(body);
      seen.log.push('+' + name); seen.live++; seen.peak = Math.max(seen.peak, seen.live);
      await sleep(60);
      seen.live--; seen.log.push('-' + name);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: name }] }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bridge-test-'));
  const file = path.join(dir, 'b.json');
  fs.writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/rpc`, token: 't' }));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'lib', 'codex-cli', 'mcp-bridge.js')], { env: { ...process.env, HUB_CODEX_BRIDGE_FILE: file } });
  const replies = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) { const m = JSON.parse(line); replies.set(m.id, m); } }
  });
  const send = (id, name) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } }) + '\n');
  const until = async (n) => { for (let i = 0; i < 100 && replies.size < n; i++) await sleep(25); };
  try {
    send(1, 'consult_agent'); send(2, 'consult_agent');
    await until(2);
    assert.strictEqual(replies.size, 2);
    assert.strictEqual(seen.peak, 2, 'two safe calls overlapped');
    seen.peak = 0; seen.log.length = 0;
    send(3, 'write_memory'); send(4, 'write_memory'); send(5, 'consult_agent');
    await until(5);
    assert.strictEqual(replies.size, 5);
    assert.deepStrictEqual(seen.log, ['+write_memory', '-write_memory', '+write_memory', '-write_memory', '+consult_agent', '-consult_agent']);
  } finally {
    child.kill();
    await new Promise(r => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
